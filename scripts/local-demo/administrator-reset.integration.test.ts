/**
 * The operator reset command against a real PostgreSQL (Unit OR Scope Gate, revision 4, §6.3
 * C-1b, C-2 to C-5 and C-8), driven through the injectable terminal. The cluster is the governed
 * disposable test cluster; `.local-demo/` is never touched.
 *
 * - A test-owned pool wrapper records each labelled statement, and can lose the acknowledgement of
 *   the next `COMMIT` (after the server ran it) or fail it before it is sent.
 * - **Arranged probe results:** an arrangement may run just before the probe's statement, on a
 *   separate connection, standing in for another writer between the commit and the probe; or the
 *   probe itself may fail. Arrangements before T2 run while the operator "types" the code.
 * - The password hash is a stub mapped to its plaintext, so sign-in can be checked without scrypt.
 */

import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Secret } from "otpauth";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as auth from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { startupOptionsFor } from "../../src/data/connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../src/data/testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "../../src/data/timestamp-parser";
import { HashLimiter } from "../../src/domain/administrator-auth/hash-limiter";
import { generateRecoveryCodes, type GeneratedRecoveryCode } from "../../src/domain/administrator-auth/recovery-code";
import { recoveryStep } from "../../src/domain/administrator-auth/recovery";
import { sealTotpSecret } from "../../src/domain/administrator-auth/secret-box";
import { passwordStep, totpStep, totpVerifierFor, type SignInDependencies } from "../../src/domain/administrator-auth/sign-in";
import { generateTotpSecret, totpCodeAt } from "../../src/domain/administrator-auth/totp";
import type { ProvisioningTerminal } from "./administrator-provisioning";
import { CONFIRMATION_ATTEMPTS, DISABLED_RESET_WARNING, resetSyntheticAdministrator, resetWarningFor } from "./administrator-reset";

/** C-8: the storage calls are wrapped (delegating to the real ones) to record the handoff object. */
const handoffs = vi.hoisted(() => ({ t1: [] as unknown[], t2: [] as unknown[], probe: [] as unknown[] }));
vi.mock("../../src/data/administrator-authentication", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/data/administrator-authentication")>();
  return {
    ...real,
    resetAdministratorCredentials: (db: never, input: { run: unknown }, clock: never) => {
      handoffs.t1.push(input.run);
      return real.resetAdministratorCredentials(db, input as never, clock);
    },
    confirmOperatorReset: (db: never, input: { run: unknown }, clock: never) => {
      handoffs.t2.push(input.run);
      return real.confirmOperatorReset(db, input as never, clock);
    },
    probeOperatorReset: (db: never, input: { run: unknown }) => {
      handoffs.probe.push(input.run);
      return real.probeOperatorReset(db, input as never);
    },
  };
});

interface PgPool {
  connect(): Promise<{ query(text: string, values?: readonly unknown[]): Promise<unknown>; release(destroy?: boolean): void }>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as { Pool: new (config: Record<string, unknown>) => PgPool };

const DATABASE = "admin_reset";
const cluster = useEmbeddedPostgres({ slug: "admin-reset", databases: [DATABASE], migrate: [DATABASE] });

const PASSWORD = "a synthetic local password for reset command tests";
const NEW_PASSWORD = "a brand new synthetic password for the reset";
const SOURCE = "local-loopback";
const KEYS = { totpKey: randomBytes(32), throttleKey: randomBytes(32) };
const TOTP_KEYS = new Map([[1, KEYS.totpKey]]);
const DUMMY_HASH = "scrypt$ln=17,r=8,p=1$ZHVtbXktc2FsdA$ZHVtbXkta2V5";

const PLAINTEXT = new Map<string, string>();
const hashFor = async (password: string) => {
  const hash = `scrypt$ln=17,r=8,p=1$${randomBytes(12).toString("base64")}$${randomBytes(12).toString("base64")}`;
  PLAINTEXT.set(hash, password);
  return hash;
};

let current = Date.UTC(2026, 10, 5, 12, 0, 0);
const clock = () => current;
const labels: string[] = [];
let commitFault: "after" | "before" | undefined;
/** Runs on another connection just before the probe's statement; or makes the probe fail. */
let beforeProbe: (() => Promise<void>) | undefined;
let failProbe = false;
let failLabel: string | undefined;
let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;

beforeAll(() => {
  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(DATABASE),
    max: 2,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: "admin_reset_test" }),
  });
  pool.on("error", () => undefined);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      let lost = false;
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          const label = text.startsWith("/* adr028:") ? text.slice(10, text.indexOf(" */")) : undefined;
          if (label !== undefined) {
            labels.push(label);
          }
          if (label === "probe-operator-reset") {
            const arrange = beforeProbe;
            beforeProbe = undefined;
            await arrange?.();
            if (failProbe) {
              failProbe = false;
              throw new Error("the probe's connection was lost (simulated)");
            }
          }
          if (label !== undefined && label === failLabel) {
            failLabel = undefined;
            throw new Error(`${label} failed (simulated)`);
          }
          if (commitFault !== undefined && text.trim().toLowerCase() === "commit") {
            const fault = commitFault;
            commitFault = undefined;
            lost = true;
            if (fault === "after") {
              await client.query(text, values);
            }
            throw new Error(`the connection was lost ${fault === "after" ? "after" : "before"} COMMIT (simulated)`);
          }
          return client.query(text, values);
        },
        release: (destroy?: boolean) => client.release(lost ? true : destroy),
      };
    },
    end: () => pool.end(),
  };
  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
  observer = new pg.Pool({ connectionString: cluster.connectionStringFor(DATABASE), max: 2, types: createTimestamptzTypeOverrides() });
  observer.on("error", () => undefined);
  cluster.closeBeforeShutdown("reset operations", () => db.destroy());
  cluster.closeBeforeShutdown("reset observer", () => observer.end());
}, CLUSTER_TIMEOUT_MS);

function ok<T>(stored: auth.Stored<T>): T {
  if (!stored.ok) {
    throw new Error(JSON.stringify(stored.failure));
  }
  return stored.value;
}

interface Account {
  readonly id: string;
  readonly username: string;
  readonly secret: Buffer;
  readonly codes: readonly GeneratedRecoveryCode[];
}

async function seed(): Promise<Account> {
  const id = randomUUID();
  const username = `synthetic-${randomBytes(5).toString("hex")}`;
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const codes = generateRecoveryCodes();
  ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash: await hashFor(PASSWORD) }, clock));
  ok(await auth.startTotpEnrolment(db, { administratorId: id, factorId, material: sealTotpSecret(KEYS.totpKey, 1, id, secret) }, clock));
  ok(
    await auth.confirmTotpEnrolmentWithRecoveryCodes(
      db,
      { administratorId: id, factorId, verify: totpVerifierFor(TOTP_KEYS, totpCodeAt(secret, current)), codeDigests: codes.map((c) => c.digest) },
      clock,
    ),
  );
  current += 60_000;
  return { id, username, secret, codes };
}

type Answer = string | (() => Promise<string>);

interface Io extends ProvisioningTerminal {
  readonly lines: string[];
  readonly prompts: string[];
}

/** An interactive terminal. `codes` answers each "six-digit code" prompt, given the shown secret. */
function terminal(answers: readonly Answer[], secrets: readonly string[], codes: readonly ((secret: Buffer) => Answer)[] = []): Io {
  const lines: string[] = [];
  const prompts: string[] = [];
  const queue = [...answers];
  const secretQueue = [...secrets];
  const codeQueue = [...codes];
  const shownSecret = () => {
    const line = lines.find((l) => l.startsWith("  Secret (base32): "));
    return line === undefined ? Buffer.alloc(0) : Buffer.from(Secret.fromBase32(line.slice("  Secret (base32): ".length)).buffer);
  };
  const resolve = async (answer: Answer | undefined) => (typeof answer === "function" ? answer() : (answer ?? ""));
  return {
    interactive: true,
    lines,
    prompts,
    ask: async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("Current six-digit code")) {
        const next = codeQueue.shift();
        return resolve(next === undefined ? "" : next(shownSecret()));
      }
      return resolve(queue.shift());
    },
    askSecret: async (prompt) => {
      prompts.push(prompt);
      return secretQueue.shift() ?? "";
    },
    say: (line) => lines.push(line),
  };
}

const rightCode = (secret: Buffer): Answer => totpCodeAt(secret, current);
const wrongCode = (): Answer => "000000";

interface Run {
  readonly result: { readonly ok: boolean; readonly outcome: string };
  readonly io: Io;
  readonly sent: string[];
  readonly hashes: number;
  readonly generated: number;
}

async function reset(account: Account, options: { codes?: readonly ((secret: Buffer) => Answer)[]; answers?: readonly Answer[]; secrets?: readonly string[]; generate?: () => readonly GeneratedRecoveryCode[] } = {}): Promise<Run> {
  const io = terminal(options.answers ?? [account.username, account.username], options.secrets ?? [NEW_PASSWORD, NEW_PASSWORD], options.codes ?? [rightCode]);
  const mark = labels.length;
  let hashes = 0;
  let generated = 0;
  const result = await resetSyntheticAdministrator(io, {
    db,
    clock,
    keys: KEYS,
    environment: {},
    databaseUrl: "postgresql://demo:x@127.0.0.1:54329/demo",
    hash: async (password) => {
      hashes += 1;
      return hashFor(password);
    },
    codes: () => {
      generated += 1;
      return (options.generate ?? generateRecoveryCodes)();
    },
  });
  current += 60_000;
  return { result, io, sent: labels.slice(mark), hashes, generated };
}

const signIn = (): SignInDependencies => ({
  db,
  clock,
  limiter: new HashLimiter(),
  passwords: { verify: async (password, storedHash) => PLAINTEXT.get(storedHash) === password },
  dummyPasswordHash: DUMMY_HASH,
  throttleKey: KEYS.throttleKey,
  totpKeys: TOTP_KEYS,
});

/** Password then TOTP with the given secret: true when a session is issued. */
async function signsIn(account: Account, password: string, secret: Buffer): Promise<boolean> {
  const step = await passwordStep(signIn(), { username: account.username, password, sourceAddress: SOURCE });
  if (step.code !== "CHALLENGE_ISSUED") {
    return false;
  }
  const totp = await totpStep(signIn(), { challengeToken: step.challengeToken, code: totpCodeAt(secret, current), sourceAddress: SOURCE });
  current += 60_000;
  return totp.code === "SESSION_ISSUED";
}

const shownCodes = (io: Io) => io.lines.filter((l) => /^ {2}[0-9a-f]{8}-/.test(l)).map((l) => l.trim());
const shownSecretOf = (io: Io) => {
  const line = io.lines.find((l) => l.startsWith("  Secret (base32): "));
  return line === undefined ? undefined : Buffer.from(Secret.fromBase32(line.slice("  Secret (base32): ".length)).buffer);
};
const outcomeOf = (io: Io) => io.lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string>);
const factorOf = async (account: Account) =>
  (await observer.query("select state, factor_id from administrator_totp_factor where administrator_id = $1", [account.id])).rows[0] as { state: string; factor_id: string | null } | undefined;
const disabledText = async (account: Account) => (await observer.query("select disabled_at::text as d from administrator where id = $1", [account.id])).rows[0]?.d;
const storedCodeHexes = async (account: Account) =>
  (await observer.query("select encode(code_digest, 'hex') as d from administrator_recovery_code where administrator_id = $1", [account.id])).rows.map((r) => r.d as string);

/** No code of `codes` appears in any line, with or without hyphens. */
function expectNoCodeShown(io: Io, codes: readonly string[]) {
  const text = io.lines.join("\n");
  for (const code of codes) {
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.replace(/-/g, ""));
  }
}

/** The plaintext codes the run generated, captured through the `codes` seam. */
function capturing(): { readonly generate: () => readonly GeneratedRecoveryCode[]; readonly codes: () => readonly string[] } {
  let last: readonly GeneratedRecoveryCode[] = [];
  return {
    generate: () => {
      last = generateRecoveryCodes();
      return last;
    },
    codes: () => last.map((c) => c.code),
  };
}

/* ------------------------------------------------------------------------------------------- */

describe("C-1b: refusals after lookup", () => {
  it("an unknown synthetic username: exactly find-credential, then a plain answer", async () => {
    const run = await reset({ id: randomUUID(), username: "synthetic-nobody-here", secret: Buffer.alloc(0), codes: [] });
    expect(run.result).toEqual({ ok: false, outcome: "ADMINISTRATOR_NOT_FOUND" });
    expect(run.sent).toEqual(["find-credential"]);
    expect(run.io.lines).toContain("No such synthetic administrator; nothing was changed.");
  });

  it.each([
    ["a mistyped retype", { answers: ["", "synthetic-someone-else"] }, "NOT_CONFIRMED"],
    ["a password that fails the policy", { secrets: ["short", "short"] }, "PASSWORD_REFUSED"],
    ["passwords that differ", { secrets: [NEW_PASSWORD, `${NEW_PASSWORD}!`] }, "PASSWORDS_DIFFER"],
  ] as const)("%s: exactly find-credential then list-sessions; no hash, no generation, no write", async (_label, options, outcome) => {
    const account = await seed();
    const answers = "answers" in options ? [account.username, options.answers[1]] : undefined;
    const run = await reset(account, { ...(answers === undefined ? {} : { answers }), ...("secrets" in options ? { secrets: options.secrets } : {}) });
    expect(run.result).toEqual({ ok: false, outcome });
    expect(run.sent).toEqual(["find-credential", "list-sessions"]);
    expect(run.hashes).toBe(0);
    expect(run.generated).toBe(0);
    expect((await factorOf(account))?.state).toBe("active");
  });

  it("a storage failure in a lookup read says nothing was changed, truthfully", async () => {
    const account = await seed();
    failLabel = "list-sessions";
    const run = await reset(account);
    expect(run.result.ok).toBe(false);
    expect(run.io.lines).toContain("The account could not be read; nothing was changed.");
    expect(run.sent).toEqual(["find-credential", "list-sessions"]);
  });
});

describe("C-2: the happy path", () => {
  it("shows the secret, asks for the code, then shows the ten codes once; the new credentials sign in; nothing secret leaks", async () => {
    const account = await seed();
    const captured = capturing();
    const run = await reset(account, { generate: captured.generate });

    expect(run.result).toEqual({ ok: true, outcome: "CREDENTIALS_RESET_CONFIRMED" });
    const secretAt = run.io.lines.findIndex((l) => l.startsWith("  Secret (base32): "));
    const codesAt = run.io.lines.findIndex((l) => l.startsWith("Recovery codes."));
    expect(secretAt).toBeGreaterThan(-1);
    expect(codesAt).toBeGreaterThan(secretAt);
    expect(run.io.prompts.indexOf("Current six-digit code: ")).toBeGreaterThan(-1);
    expect(shownCodes(run.io)).toEqual([...captured.codes()]);
    expect(run.io.lines.join("\n")).not.toContain(NEW_PASSWORD);
    for (const hash of PLAINTEXT.keys()) {
      expect(run.io.lines.join("\n")).not.toContain(hash);
    }
    expect(run.io.lines).toContain(resetWarningFor(account.username));
    expect(await signsIn(account, NEW_PASSWORD, shownSecretOf(run.io)!)).toBe(true);
    expect(await signsIn(account, PASSWORD, account.secret)).toBe(false);
  });
});

describe("C-3: a disabled account (D-16)", () => {
  async function disabledAccount() {
    const account = await seed();
    ok(await auth.disableAccount(db, { administratorId: account.id }, clock));
    return { account, before: await disabledText(account) };
  }

  it("the warning; T1 runs; no secret, URI or code; no T2; disabled_at unchanged", async () => {
    const { account, before } = await disabledAccount();
    const captured = capturing();
    const run = await reset(account, { generate: captured.generate });

    expect(run.result).toEqual({ ok: true, outcome: "CREDENTIALS_RESET_ACCOUNT_DISABLED" });
    expect(run.io.lines).toContain(DISABLED_RESET_WARNING);
    expect(run.sent).toContain("reset-password");
    expect(run.sent).not.toContain("confirm-operator-reset");
    expect(run.io.lines.join("\n")).not.toMatch(/otpauth:\/\/|Secret \(base32\)/);
    expectNoCodeShown(run.io, captured.codes());
    expect(await disabledText(account)).toBe(before);
  });

  it("with T1's acknowledgement lost after commit (U1-b): still nothing shown, no T2, the same outcome", async () => {
    const { account, before } = await disabledAccount();
    const captured = capturing();
    commitFault = "after";
    const run = await reset(account, { generate: captured.generate });

    expect(run.result).toEqual({ ok: true, outcome: "CREDENTIALS_RESET_ACCOUNT_DISABLED" });
    expect(run.sent).toContain("probe-operator-reset");
    expect(run.sent.slice(run.sent.indexOf("probe-operator-reset"))).toEqual(["probe-operator-reset"]);
    expect(run.io.lines.join("\n")).not.toMatch(/otpauth:\/\//);
    expectNoCodeShown(run.io, captured.codes());
    expect(await disabledText(account)).toBe(before);
  });

  it("as a rerun: T1 only, with a new factor, and disabled_at still identical", async () => {
    const { account, before } = await disabledAccount();
    await reset(account);
    const first = (await factorOf(account))?.factor_id;
    const run = await reset(account);
    expect(run.result.outcome).toBe("CREDENTIALS_RESET_ACCOUNT_DISABLED");
    expect((await factorOf(account))?.factor_id).not.toBe(first);
    expect(run.sent).not.toContain("confirm-operator-reset");
    expect(await disabledText(account)).toBe(before);
  });
});

describe("C-4: wrong codes", () => {
  it(`${CONFIRMATION_ATTEMPTS} attempts against the same factor, then stop; no codes; a rerun succeeds`, async () => {
    const account = await seed();
    const captured = capturing();
    const run = await reset(account, { codes: [wrongCode, wrongCode, wrongCode, rightCode], generate: captured.generate });

    expect(run.result).toEqual({ ok: false, outcome: "NOT_CONFIRMED" });
    expect(run.sent.filter((l) => l === "confirm-operator-reset")).toHaveLength(0);
    expect(run.io.prompts.filter((p) => p.startsWith("Current six-digit code"))).toHaveLength(CONFIRMATION_ATTEMPTS);
    expect(new Set(handoffs.t2.slice(-CONFIRMATION_ATTEMPTS)).size).toBe(1);
    expectNoCodeShown(run.io, captured.codes());
    expect((await reset(account)).result.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
  });
});

describe("C-5: every §3.6 row through the command", () => {
  const deleteOneCode = (account: Account) => async () => {
    await observer.query("delete from administrator_recovery_code where ctid = (select ctid from administrator_recovery_code where administrator_id = $1 limit 1)", [account.id]);
  };

  /** One run with the given fault, arrangement and code answers; checks the common rules. */
  async function row(options: {
    fault?: "after" | "before";
    faultOnT2?: "after" | "before";
    arrange?: (account: Account) => () => Promise<void>;
    probeFails?: boolean;
    codes?: readonly ((secret: Buffer) => Answer)[];
    disabled?: boolean;
  }) {
    const account = await seed();
    const captured = capturing();
    commitFault = options.fault;
    beforeProbe = options.arrange?.(account);
    failProbe = options.probeFails ?? false;
    const codes = options.codes ?? [
      (secret: Buffer) => async () => {
        if (options.faultOnT2 !== undefined) {
          commitFault = options.faultOnT2;
          beforeProbe = options.arrange?.(account);
          failProbe = options.probeFails ?? false;
        }
        return totpCodeAt(secret, current);
      },
      rightCode,
    ];
    const run = await reset(account, { generate: captured.generate, codes });
    const text = run.io.lines.join("\n");
    expect(text, "never 'nothing was changed' after T1").not.toMatch(/nothing was changed/i);
    return { account, run, codes: captured.codes(), text };
  }

  it("U1-a: T1 committed, acknowledgement lost: continues, confirms, shows the codes", async () => {
    const { run, codes, text } = await row({ fault: "after" });
    expect(run.result.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
    expect(text).toContain("The reset was committed.");
    expect(shownCodes(run.io)).toEqual([...codes]);
  });

  for (const [name, options, outcome] of [
    ["U1-c: committed, then a code changed", { fault: "after" as const, arrange: deleteOneCode }, "RESET_STATE_CHANGED"],
    ["U1-d: committed, then the factor replaced", { fault: "after" as const, arrange: (a: Account) => async () => void (await observer.query("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [a.id, randomUUID()])) }, "RESET_STATE_CHANGED"],
    ["U1-e: not committed (fault before COMMIT): unconfirmed, never 'not committed'", { fault: "before" as const }, "RESET_UNCONFIRMED"],
    ["U1-f: committed, and the probe fails", { fault: "after" as const, probeFails: true }, "RESET_UNCONFIRMED"],
  ] as const) {
    it(`${name}: ${outcome}; no secret or URI; no T2; no code`, async () => {
      const { run, codes, text } = await row(options);
      expect(run.result).toEqual({ ok: false, outcome });
      expect(text).not.toMatch(/otpauth:\/\/|Secret \(base32\)/);
      expect(run.sent).not.toContain("confirm-operator-reset");
      expect(run.sent.filter((l) => l === "lock-administrator")).toHaveLength(1);
      expectNoCodeShown(run.io, codes);
      expect(text).not.toMatch(/not committed/i);
    });
  }

  it("U2-a: T2 committed, acknowledgement lost: the probe meets every condition and the codes are shown", async () => {
    const { run, codes, text } = await row({ faultOnT2: "after" });
    expect(run.result.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
    expect(text).toContain("Confirmed.");
    expect(shownCodes(run.io)).toEqual([...codes]);
  });

  it("U2-b: T2 not committed: 'Not confirmed', the next attempt confirms", async () => {
    const { run, codes } = await row({ faultOnT2: "before" });
    expect(run.io.lines).toContain("Not confirmed.");
    expect(run.result.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
    expect(shownCodes(run.io)).toEqual([...codes]);
  });

  for (const [name, options, outcome] of [
    ["U2-c: confirmed, then a code changed", { faultOnT2: "after" as const, arrange: deleteOneCode }, "RESET_STATE_CHANGED"],
    ["U2-d: confirmed, then the account disabled by another writer", { faultOnT2: "after" as const, arrange: (a: Account) => async () => void (await observer.query("update administrator set disabled_at = now() where id = $1", [a.id])) }, "RESET_ACCOUNT_DISABLED_DURING_RUN"],
    ["U2-e: not confirmed, and a code changed", { faultOnT2: "before" as const, arrange: deleteOneCode }, "RESET_STATE_CHANGED"],
    ["U2-f: confirmed, then the password replaced", { faultOnT2: "after" as const, arrange: (a: Account) => async () => void (await observer.query("update administrator set password_hash = $2 where id = $1", [a.id, "scrypt$foreign"])) }, "RESET_STATE_CHANGED"],
    ["U2-g: confirmed, and the probe fails", { faultOnT2: "after" as const, probeFails: true }, "RESET_UNCONFIRMED"],
  ] as const) {
    it(`${name}: ${outcome}; no code shown`, async () => {
      const { run, codes } = await row(options);
      expect(run.result).toEqual({ ok: false, outcome });
      expect(shownCodes(run.io)).toEqual([]);
      expectNoCodeShown(run.io, codes);
    });
  }

  for (const [reason, arrange, outcome] of [
    ["PASSWORD_CHANGED", (a: Account) => observer.query("update administrator set password_hash = $2 where id = $1", [a.id, "scrypt$foreign"]), "RESET_STATE_CHANGED"],
    ["FACTOR_NOT_FROM_THIS_RESET", (a: Account) => observer.query("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [a.id, randomUUID()]), "RESET_STATE_CHANGED"],
    ["CODE_SET_CHANGED", (a: Account) => observer.query("delete from administrator_recovery_code where ctid = (select ctid from administrator_recovery_code where administrator_id = $1 limit 1)", [a.id]), "RESET_STATE_CHANGED"],
    ["ACCOUNT_DISABLED", (a: Account) => observer.query("update administrator set disabled_at = now() where id = $1", [a.id]), "RESET_ACCOUNT_DISABLED_DURING_RUN"],
  ] as const) {
    it(`a T2 refusal ${reason} (arranged while the code is typed) ends the run with ${outcome} and no codes`, async () => {
      const account = await seed();
      const captured = capturing();
      const run = await reset(account, {
        generate: captured.generate,
        codes: [
          (secret) => async () => {
            await arrange(account);
            return totpCodeAt(secret, current);
          },
        ],
      });
      expect(run.result).toEqual({ ok: false, outcome });
      expectNoCodeShown(run.io, captured.codes());
    });
  }

  it("a rerun after an unconfirmed run is a fresh reset: new password entry, new factor; the interrupted secret fails", async () => {
    const { account } = await row({ fault: "after", probeFails: true });
    const interruptedFactor = (await factorOf(account))?.factor_id;
    const fresh = await reset(account, { secrets: [`${NEW_PASSWORD} again`, `${NEW_PASSWORD} again`] });

    expect(fresh.result.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
    expect(fresh.io.prompts.filter((p) => p.startsWith("New password"))).toHaveLength(2);
    expect((await factorOf(account))?.factor_id).not.toBe(interruptedFactor);
    expect(await signsIn(account, NEW_PASSWORD, account.secret)).toBe(false);
    expect(await signsIn(account, `${NEW_PASSWORD} again`, shownSecretOf(fresh.io)!)).toBe(true);
  });
});

describe("C-8: the handoff", () => {
  it("one frozen ResetRun reaches T1, every T2 attempt and the probe; never rebuilt", async () => {
    const account = await seed();
    const from = { t1: handoffs.t1.length, t2: handoffs.t2.length, probe: handoffs.probe.length };
    commitFault = "after";
    const run = await reset(account, { codes: [wrongCode, rightCode] });

    expect(run.result.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
    const seen = [...handoffs.t1.slice(from.t1), ...handoffs.t2.slice(from.t2), ...handoffs.probe.slice(from.probe)];
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("a duplicate or wrong-length generated digest refuses before T1, with no T1 statement", async () => {
    for (const generate of [
      () => {
        const codes = generateRecoveryCodes();
        return [...codes.slice(0, 9), codes[0]!];
      },
      () => generateRecoveryCodes().map((c, i) => (i === 0 ? { ...c, digest: c.digest.subarray(0, 31) } : c)),
    ]) {
      const account = await seed();
      const run = await reset(account, { generate });
      expect(run.result).toEqual({ ok: false, outcome: "GENERATION_REFUSED" });
      expect(run.sent).toEqual(["find-credential", "list-sessions"]);
    }
  });
});

describe("the recovery codes a reset shows work once, after the new password", () => {
  it("a shown code opens a recovery session", async () => {
    const account = await seed();
    const run = await reset(account);
    const [first] = shownCodes(run.io);
    const step = await passwordStep(signIn(), { username: account.username, password: NEW_PASSWORD, sourceAddress: SOURCE });
    expect(step.code).toBe("CHALLENGE_ISSUED");
    const recovered = await recoveryStep({ db, clock, throttleKey: KEYS.throttleKey, totpKeys: TOTP_KEYS, currentTotpKeyVersion: 1 }, {
      challengeToken: step.code === "CHALLENGE_ISSUED" ? step.challengeToken : "",
      code: first ?? "",
      sourceAddress: SOURCE,
    });
    expect(recovered.code).toBe("RECOVERY_SESSION_ISSUED");
    expect(await storedCodeHexes(account)).toHaveLength(9);
  });
});
