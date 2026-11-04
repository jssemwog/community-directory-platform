/**
 * The operator commands against a real PostgreSQL (issue #270 §6.2 C-3 and C-4), driven through the
 * injectable terminal. The cluster is the governed disposable test cluster; `.local-demo/` is never
 * touched. A test-owned pool wrapper records each labelled statement the command sends.
 */

import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";

import * as auth from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { startupOptionsFor } from "../../src/data/connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../src/data/testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "../../src/data/timestamp-parser";
import { HashLimiter } from "../../src/domain/administrator-auth/hash-limiter";
import { generateRecoveryCodes } from "../../src/domain/administrator-auth/recovery-code";
import { sealTotpSecret } from "../../src/domain/administrator-auth/secret-box";
import { passwordStep, totpStep, totpVerifierFor } from "../../src/domain/administrator-auth/sign-in";
import { tokenDigest } from "../../src/domain/administrator-auth/token";
import { generateTotpSecret, totpCodeAt } from "../../src/domain/administrator-auth/totp";
import { controlSyntheticAdministrator, DISABLE_WARNING, UNCONFIRMED_OUTCOME, type ControlSubcommand } from "./administrator-control";
import type { ProvisioningTerminal } from "./administrator-provisioning";

interface PgPool {
  connect(): Promise<{ query(text: string, values?: readonly unknown[]): Promise<unknown>; release(destroy?: boolean): void }>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as { Pool: new (config: Record<string, unknown>) => PgPool };

const DATABASE = "admin_control";
const cluster = useEmbeddedPostgres({ slug: "admin-control", databases: [DATABASE], migrate: [DATABASE] });

const STUB_HASH = "scrypt$ln=17,r=8,p=1$c3R1Yi1zYWx0LTE2Ynl0ZQ$c3R1Yi1rZXk";
const PASSWORD = "a synthetic local password for control tests";
const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);

let current = Date.UTC(2026, 10, 4, 12, 0, 0);
const clock = () => current;
const labels: string[] = [];
/** When set, the next COMMIT runs on the server and its acknowledgement is then lost. */
let loseNextCommitAcknowledgement = false;
let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;

beforeAll(() => {
  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(DATABASE),
    max: 2,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: "admin_control_test" }),
  });
  pool.on("error", () => undefined);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          if (text.startsWith("/* adr028:")) {
            labels.push(text.slice(10, text.indexOf(" */")));
          }
          if (loseNextCommitAcknowledgement && text.trim().toLowerCase() === "commit") {
            loseNextCommitAcknowledgement = false;
            await client.query(text, values);
            throw new Error("the connection was lost after COMMIT was sent (simulated)");
          }
          return client.query(text, values);
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
    },
    end: () => pool.end(),
  };
  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
  observer = new pg.Pool({ connectionString: cluster.connectionStringFor(DATABASE), max: 2 });
  observer.on("error", () => undefined);
  cluster.closeBeforeShutdown("control operations", () => db.destroy());
  cluster.closeBeforeShutdown("control observer", () => observer.end());
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
  readonly codes: ReturnType<typeof generateRecoveryCodes>;
}

async function seed(): Promise<Account> {
  const id = randomUUID();
  const username = `synthetic-${randomBytes(5).toString("hex")}`;
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const codes = generateRecoveryCodes();
  ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash: STUB_HASH }, clock));
  ok(await auth.startTotpEnrolment(db, { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, secret) }, clock));
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

async function session(account: Account): Promise<string> {
  const deps = {
    db,
    clock,
    limiter: new HashLimiter(),
    passwords: { verify: async (password: string) => password === PASSWORD },
    dummyPasswordHash: STUB_HASH,
    throttleKey: THROTTLE_KEY,
    totpKeys: TOTP_KEYS,
  };
  const issued = await passwordStep(deps, { username: account.username, password: PASSWORD, sourceAddress: "local-loopback" });
  if (issued.code !== "CHALLENGE_ISSUED") {
    throw new Error(issued.code);
  }
  const completed = await totpStep(deps, { challengeToken: issued.challengeToken, code: totpCodeAt(account.secret, current), sourceAddress: "local-loopback" });
  if (completed.code !== "SESSION_ISSUED") {
    throw new Error(completed.code);
  }
  current += 60_000;
  return completed.sessionToken;
}

function terminal(answers: readonly string[]): ProvisioningTerminal & { readonly lines: string[] } {
  const lines: string[] = [];
  const queue = [...answers];
  return {
    interactive: true,
    lines,
    ask: async () => queue.shift() ?? "",
    askSecret: async () => {
      throw new Error("no secret prompt expected");
    },
    say: (line) => lines.push(line),
  };
}

async function command(subcommand: ControlSubcommand, answers: readonly string[]) {
  const io = terminal(answers);
  const mark = labels.length;
  const result = await controlSyntheticAdministrator(subcommand, io, {
    db,
    clock,
    environment: {},
    databaseUrl: cluster.connectionStringFor(DATABASE),
  });
  return { result, lines: io.lines, statements: labels.slice(mark) };
}

const TABLES = [
  "administrator",
  "administrator_totp_factor",
  "administrator_session",
  "administrator_pending_challenge",
  "administrator_consumed_challenge",
  "administrator_recovery_code",
  "authentication_throttle",
  "authentication_source_window",
];
async function stored(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of TABLES) {
    out[table] = (await observer.query(`select row_to_json(t)::text as r from ${table} t`)).rows.map((row) => row.r as string).sort();
  }
  return out;
}

const sessionIds = async (account: Account) =>
  (await observer.query("select id from administrator_session where administrator_id = $1 order by id", [account.id])).rows.map((row) => row.id as string);

/** Assert that no line shows a token, a digest in any encoding, the TOTP secret or a recovery code. */
function expectNoSecret(lines: readonly string[], account: Account, tokens: readonly string[]): void {
  const text = lines.join("\n");
  for (const token of tokens) {
    const digest = tokenDigest(token) ?? Buffer.alloc(0);
    for (const form of [token, digest.toString("hex"), digest.toString("base64"), digest.toString("base64url")]) {
      expect(text).not.toContain(form);
    }
  }
  expect(text).not.toContain(account.secret.toString("hex"));
  for (const code of account.codes) {
    expect(text).not.toContain(code.code);
  }
}

const outcomeLines = (lines: readonly string[]) => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, string>);

describe("C-3: each subcommand end to end", () => {
  it("sessions: the account state once, every session's handle, two SELECTs, no secret, nothing written", async () => {
    const account = await seed();
    const tokens = [await session(account), await session(account)];
    const before = await stored();
    const { result, lines, statements } = await command("sessions", [account.username]);

    expect(result).toEqual({ ok: true, outcome: "SESSIONS_LISTED" });
    expect(statements).toEqual(["find-credential", "list-sessions"]);
    expect(await stored()).toEqual(before);
    expect(lines.filter((line) => line.startsWith("Account disabled: no. Password disabled: no."))).toHaveLength(1);
    expect(lines).toContain("Sessions (2):");
    for (const id of await sessionIds(account)) {
      expect(lines.filter((line) => line.includes(id) && line.includes("administrator") && line.includes(" live"))).toHaveLength(1);
    }
    expectNoSecret(lines, account, tokens);

    const empty = await seed();
    const none = await command("sessions", [empty.username]);
    expect(none.lines).toContain("No sessions.");
  });

  it("revoke: one session by id; an unknown id and a malformed id write nothing", async () => {
    const account = await seed();
    const tokens = [await session(account), await session(account)];
    const [first, second] = await sessionIds(account);

    const revoked = await command("revoke", [account.username, first ?? ""]);
    expect(revoked.result).toEqual({ ok: true, outcome: "SESSION_REVOKED" });
    expect(revoked.statements).toEqual(["find-credential", "list-sessions", "revoke-session"]);
    expect(await sessionIds(account)).toEqual([second]);
    expectNoSecret(revoked.lines, account, tokens);

    let before = await stored();
    expect((await command("revoke", [account.username, randomUUID()])).result).toEqual({ ok: false, outcome: "NO_SUCH_SESSION" });
    expect(await stored()).toEqual(before);

    // The id is chosen from the listing, so the listing's reads precede the refusal; nothing is written.
    before = await stored();
    const malformed = await command("revoke", [account.username, "not-a-session-id"]);
    expect(malformed.result).toEqual({ ok: false, outcome: "SESSION_ID_REFUSED" });
    expect(malformed.statements).toEqual(["find-credential", "list-sessions"]);
    expect(await stored()).toEqual(before);
  });

  it("revoke-all: every session ends, challenges are invalidated, and nothing else changes", async () => {
    const account = await seed();
    const tokens = [await session(account), await session(account)];
    const before = await stored();
    const { result, lines } = await command("revoke-all", [account.username]);

    expect(result).toEqual({ ok: true, outcome: "SESSIONS_REVOKED" });
    expect(await sessionIds(account)).toEqual([]);
    expect(lines.some((line) => line.startsWith("Revoked 2 session(s)"))).toBe(true);
    const after = await stored();
    for (const table of ["administrator", "administrator_totp_factor", "administrator_recovery_code", "authentication_throttle"]) {
      expect(after[table], table).toEqual(before[table]);
    }
    expectNoSecret(lines, account, tokens);
  });

  it("disable: the warning precedes the confirmation; it disables once, then reports ALREADY_DISABLED", async () => {
    const account = await seed();
    const tokens = [await session(account)];
    const disabled = await command("disable", [account.username, account.username.toUpperCase()]);

    expect(disabled.result).toEqual({ ok: true, outcome: "DISABLED" });
    expect(disabled.lines.indexOf(DISABLE_WARNING)).toBeGreaterThanOrEqual(0);
    expect(disabled.statements).toEqual(["find-credential", "lock-administrator", "disable-account", "disable-delete-sessions", "invalidate-pending-challenges"]);
    expect((await observer.query("select disabled_at from administrator where id = $1", [account.id])).rows[0]?.disabled_at).not.toBeNull();
    expect(await sessionIds(account)).toEqual([]);
    expectNoSecret(disabled.lines, account, tokens);

    const before = await stored();
    expect((await command("disable", [account.username, account.username])).result).toEqual({ ok: false, outcome: "ALREADY_DISABLED" });
    expect(await stored()).toEqual(before);

    const listed = await command("sessions", [account.username]);
    expect(listed.lines.some((line) => /^Account disabled: \d{4}-/.test(line))).toBe(true);
  });

  it("an unknown synthetic username is reported plainly, and nothing is written", async () => {
    const before = await stored();
    for (const subcommand of ["sessions", "revoke", "revoke-all", "disable"] as const) {
      const name = `synthetic-nobody-${randomBytes(3).toString("hex")}`;
      const { result, lines } = await command(subcommand, [name, name]);
      expect(result, subcommand).toEqual({ ok: false, outcome: "ADMINISTRATOR_NOT_FOUND" });
      expect(lines, subcommand).toContain("No such synthetic administrator; nothing was changed.");
    }
    expect(await stored()).toEqual(before);
  });
});

describe("C-3: revoke-all's and disable's storage failures never promise that nothing was changed", () => {
  const REVOKED = "find-credential, lock-administrator, revoke-all-sessions, invalidate-pending-challenges";
  const cases = [
    ["revoke-all", (account: Account) => [account.username]],
    ["disable", (account: Account) => [account.username, account.username]],
  ] as const;

  for (const [subcommand, answers] of cases) {
    it(`${subcommand}: a reported failure (a genuine 57014) gives the uncommitted-outcome message and rolls back`, async () => {
      const account = await seed();
      await session(account);
      const before = await stored();
      await observer.query(`create or replace function rc_fault() returns trigger language plpgsql as $f$
        begin raise exception 'injected fault' using errcode = '57014'; end $f$`);
      await observer.query("create trigger rc_fault before delete on administrator_session for each row execute function rc_fault()");
      let run: Awaited<ReturnType<typeof command>>;
      try {
        run = await command(subcommand, answers(account));
      } finally {
        await observer.query("drop trigger if exists rc_fault on administrator_session");
      }

      expect(run.result).toEqual({ ok: false, outcome: "STORAGE_FAILURE" });
      expect(run.lines).toContain(UNCONFIRMED_OUTCOME);
      expect(run.lines.join("\n")).not.toMatch(/nothing (was )?changed/i);
      expect(outcomeLines(run.lines).map((line) => line.outcome)).toEqual(["STORAGE_FAILURE"]);
      expect(await stored()).toEqual(before);
    });

    it(`${subcommand}: a COMMIT whose acknowledgement is lost reports failure, yet the change committed, and the message allows for it`, async () => {
      const account = await seed();
      await session(account);
      loseNextCommitAcknowledgement = true;
      const run = await command(subcommand, answers(account));
      loseNextCommitAcknowledgement = false;

      expect(run.result.ok).toBe(false);
      expect(run.lines).toContain(UNCONFIRMED_OUTCOME);
      expect(run.lines.join("\n")).not.toMatch(/nothing (was )?changed/i);
      expect(await sessionIds(account), "the server committed the revocation").toEqual([]);
      if (subcommand === "disable") {
        expect((await observer.query("select disabled_at from administrator where id = $1", [account.id])).rows[0]?.disabled_at, "the server committed the disable").not.toBeNull();
      } else {
        expect(run.statements.join(", ")).toBe(REVOKED);
      }

      const listed = await command("sessions", [account.username]);
      expect(listed.lines, "sessions shows the true state").toContain("No sessions.");
    });
  }
});

describe("C-4: outcome lines against a real database", () => {
  it("one four-field line per run, with no secret", async () => {
    const account = await seed();
    const tokens = [await session(account)];
    for (const [subcommand, answers] of [
      ["sessions", [account.username]],
      ["revoke-all", [account.username]],
    ] as const) {
      const { lines } = await command(subcommand, answers);
      const outcomes = outcomeLines(lines);
      expect(outcomes, subcommand).toHaveLength(1);
      expect(Object.keys(outcomes[0] ?? {}).sort()).toEqual(["at", "entry", "event", "outcome"]);
      expectNoSecret(lines, account, tokens);
    }
  });
});
