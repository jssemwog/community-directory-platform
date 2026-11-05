/**
 * Attacking tests for the operator reset's storage (Unit OR Scope Gate, revision 4, §6.1 R-1 to
 * R-10): T1 `resetAdministratorCredentials`, T2 `confirmOperatorReset` and the probe, against a
 * real PostgreSQL from `embedded-postgres`, in one disposable cluster, with an injected clock.
 *
 * - **Statement observer:** as the #270 suite, the runtime's pool records each `adr028:<label>`
 *   statement and the row count the server reported, can hold one labelled statement at a
 *   barrier, and can report a labelled statement as having affected another count (R-10).
 * - **Commit faults (R-9):** the wrapper can fail the transaction's `commit` **after** the server
 *   executed it (a lost acknowledgement), or **instead of** sending it (the server rolls back when
 *   the connection is destroyed).
 * - **Arranged state** stands in for a foreign writer (`psql`) only where the gate says so: a
 *   changed code set (R-5b), a stray origin (R-5d), counters at the ceiling (R-4) and an
 *   overwritten commit (R-9). No constraint is dropped or weakened. Disabled accounts come from
 *   the real `disableAccount`.
 * - **No timing claim** is made anywhere (#246 / `BI-4` pending).
 */

import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import * as auth from "./administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "./administrator-authentication-table";
import { startupOptionsFor } from "./connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import { HashLimiter } from "../domain/administrator-auth/hash-limiter";
import { keyedDigest } from "../domain/administrator-auth/keyed-digest";
import { generateRecoveryCodes, type GeneratedRecoveryCode } from "../domain/administrator-auth/recovery-code";
import { reenrolmentCompletion, reenrolmentStart, recoveryStep, regeneration, type RecoveryDependencies } from "../domain/administrator-auth/recovery";
import { sealTotpSecret } from "../domain/administrator-auth/secret-box";
import { passwordStep, totpStep, totpVerifierFor, type SignInDependencies } from "../domain/administrator-auth/sign-in";
import { tokenDigest } from "../domain/administrator-auth/token";
import { generateTotpSecret, totpCodeAt } from "../domain/administrator-auth/totp";

interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<PgResult>;
  release(destroy?: boolean | Error): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: readonly unknown[]): Promise<PgResult>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as { Pool: new (config: Record<string, unknown>) => PgPool };

const DATABASE = "operator_reset";
const cluster = useEmbeddedPostgres({ slug: "operator-reset", databases: [DATABASE], migrate: [DATABASE] });

const STEP_BOUND_MS = 10_000;
const PASSWORD = "a synthetic local password for reset tests";
const NEW_PASSWORD = "a different synthetic password after the reset";
const SOURCE = "local-loopback";
const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);
const DUMMY_HASH = "scrypt$ln=17,r=8,p=1$ZHVtbXktc2FsdA$ZHVtbXkta2V5";

/** Stub hashes stand in for scrypt: each maps to the plaintext it verifies. */
const PLAINTEXT = new Map<string, string>();
const hashFor = (password: string) => {
  const hash = `scrypt$ln=17,r=8,p=1$${randomBytes(12).toString("base64")}$${randomBytes(12).toString("base64")}`;
  PLAINTEXT.set(hash, password);
  return hash;
};

/** A verification of one stored hash may be held at a barrier (R-6b). */
let holdVerification: { readonly hash: string; readonly reached: () => void; readonly gate: Promise<void> } | undefined;

let current = Date.UTC(2026, 10, 5, 12, 0, 0);
const clock: auth.Clock = () => current;

interface Hooks {
  readonly log: string[];
  readonly affected: string[];
  readonly counts: Map<string, number>;
  readonly pauses: Map<string, { readonly gate: Promise<void>; readonly reached: () => void }>;
  commitFault: "after" | "before" | undefined;
}

const hooks: Hooks = { log: [], affected: [], counts: new Map(), pauses: new Map(), commitFault: undefined };
const broken = new WeakSet<PgClient>();
let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;

const labelOf = (text: string) => (text.startsWith("/* adr028:") ? text.slice(10, text.indexOf(" */")) : undefined);
const lostConnection = () => Object.assign(new Error("connection lost (injected)"), { code: "08006" });

function createPool(applicationName: string, max: number): PgPool {
  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(DATABASE),
    max,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: applicationName }),
  });
  pool.on("error", () => undefined);
  pool.on("connect", (client) => (client as PgClient).on("error", () => broken.add(client as PgClient)));
  return pool;
}

beforeAll(() => {
  const pool = createPool("or_operation", 8);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          if (/^\s*commit\s*$/i.test(text) && hooks.commitFault !== undefined) {
            const fault = hooks.commitFault;
            hooks.commitFault = undefined;
            broken.add(client);

            if (fault === "after") {
              await client.query(text, values);
            }

            throw lostConnection();
          }

          const label = labelOf(text);

          if (label !== undefined) {
            hooks.log.push(label);
            const pause = hooks.pauses.get(label);

            if (pause !== undefined) {
              hooks.pauses.delete(label);
              pause.reached();
              await pause.gate;
            }
          }

          const result = await client.query(text, values).catch((cause: unknown) => {
            const code = (cause as { code?: string }).code;
            if (code === undefined || code.startsWith("57P") || code.startsWith("08")) {
              broken.add(client);
            }
            throw cause;
          });

          if (label === undefined) {
            return result;
          }

          hooks.affected.push(`${label}:${result.rowCount ?? 0}`);
          const injected = hooks.counts.get(label);

          if (injected === undefined) {
            return result;
          }

          const first = result.rows[0];
          return { ...result, rowCount: injected, rows: first === undefined ? [] : Array.from({ length: injected }, () => first) };
        },
        release: (destroy?: boolean | Error) => client.release(broken.has(client) ? true : destroy),
      };
    },
    end: () => pool.end(),
  };
  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
  observer = createPool("or_observer", 4);
  cluster.closeBeforeShutdown("reset operations", () => db.destroy());
  cluster.closeBeforeShutdown("reset observer", () => observer.end());
}, CLUSTER_TIMEOUT_MS);

afterEach(async () => {
  hooks.counts.clear();
  hooks.pauses.clear();
  hooks.commitFault = undefined;
  holdVerification = undefined;
  await observer.query("delete from authentication_throttle");
  await observer.query("delete from authentication_source_window");
});

/* ------------------------------------------------------------------------------------------- */
/* Helpers                                                                                      */
/* ------------------------------------------------------------------------------------------- */

function ok<T>(stored: auth.Stored<T>): T {
  if (!stored.ok) {
    throw new Error(`expected success, got ${JSON.stringify(stored.failure)}`);
  }
  return stored.value;
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish within ${STEP_BOUND_MS} ms`)), STEP_BOUND_MS)),
  ]);
}

const signIn = (): SignInDependencies => ({
  db,
  clock,
  limiter: new HashLimiter(),
  passwords: {
    verify: async (password: string, storedHash: string) => {
      const held = holdVerification;
      if (held !== undefined && held.hash === storedHash) {
        holdVerification = undefined;
        held.reached();
        await held.gate;
      }
      return PLAINTEXT.get(storedHash) === password;
    },
  },
  dummyPasswordHash: DUMMY_HASH,
  throttleKey: THROTTLE_KEY,
  totpKeys: TOTP_KEYS,
});
const recovery = (): RecoveryDependencies => ({ db, clock, throttleKey: THROTTLE_KEY, totpKeys: TOTP_KEYS, currentTotpKeyVersion: 1 });

interface Account {
  readonly id: string;
  readonly username: string;
  secret: Buffer;
  codes: readonly GeneratedRecoveryCode[];
  password: string;
}

/** A provisioned, confirmed account with ten codes (RA-5). */
async function seed(): Promise<Account> {
  const id = randomUUID();
  const username = `synthetic-${randomBytes(5).toString("hex")}`;
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const codes = generateRecoveryCodes();

  ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash: hashFor(PASSWORD) }, clock));
  ok(await auth.startTotpEnrolment(db, { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, secret) }, clock));
  expect(
    ok(
      await auth.confirmTotpEnrolmentWithRecoveryCodes(
        db,
        { administratorId: id, factorId, verify: totpVerifierFor(TOTP_KEYS, totpCodeAt(secret, current)), codeDigests: codes.map((c) => c.digest) },
        clock,
      ),
    ),
  ).toEqual({ code: "ENROLMENT_CONFIRMED" });
  current += 60_000;
  return { id, username, secret, codes, password: PASSWORD };
}

interface Reset {
  readonly run: auth.ResetRun;
  readonly secret: Buffer;
  readonly codes: readonly GeneratedRecoveryCode[];
  readonly material: auth.SealedFactorMaterial;
  readonly subjects: auth.ResetThrottleSubjects;
  readonly password: string;
}

/** One reset run's handoff, as the command builds it before T1. */
function newRun(account: Account, password = NEW_PASSWORD): Reset {
  const secret = generateTotpSecret();
  const codes = generateRecoveryCodes();
  const run: auth.ResetRun = Object.freeze({
    administratorId: account.id,
    expectedPasswordHash: hashFor(password),
    factorId: randomUUID(),
    expectedCodeDigests: Object.freeze(codes.map((c) => c.digest)),
  });
  return {
    run,
    secret,
    codes,
    password,
    material: sealTotpSecret(TOTP_KEY, 1, account.id, secret),
    subjects: {
      password: keyedDigest(THROTTLE_KEY, "password-username", account.username),
      totp: keyedDigest(THROTTLE_KEY, "totp-administrator", account.id),
      recoveryCode: keyedDigest(THROTTLE_KEY, "recovery-code-administrator", account.id),
    },
  };
}

const t1 = (reset: Reset) => auth.resetAdministratorCredentials(db, { run: reset.run, material: reset.material, throttleSubjects: reset.subjects }, clock);
const t2 = (reset: Reset, code = totpCodeAt(reset.secret, current), run = reset.run) =>
  auth.confirmOperatorReset(db, { run, verify: totpVerifierFor(TOTP_KEYS, code) }, clock);
const probe = (reset: Reset, run = reset.run) => auth.probeOperatorReset(db, { run });

/** T1 then T2, and the account then uses the new credentials. */
async function resetAndConfirm(account: Account, password = NEW_PASSWORD): Promise<Reset> {
  const reset = newRun(account, password);
  expect(ok(await t1(reset))).toMatchObject({ code: "CREDENTIALS_RESET", accountDisabled: false });
  expect(ok(await t2(reset))).toEqual({ code: "RESET_CONFIRMED" });
  current += 60_000;
  account.secret = reset.secret;
  account.codes = reset.codes;
  account.password = password;
  return reset;
}

async function challenge(account: Account, password = account.password): Promise<string> {
  const outcome = await passwordStep(signIn(), { username: account.username, password, sourceAddress: SOURCE });
  if (outcome.code !== "CHALLENGE_ISSUED") {
    throw new Error(`password step gave ${outcome.code}`);
  }
  return outcome.challengeToken;
}

async function administratorSession(account: Account): Promise<string> {
  const token = await challenge(account);
  const outcome = await totpStep(signIn(), { challengeToken: token, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE });
  if (outcome.code !== "SESSION_ISSUED") {
    throw new Error(`totp step gave ${outcome.code}`);
  }
  current += 60_000;
  return outcome.sessionToken;
}

async function recoverySession(account: Account, index: number): Promise<string> {
  const outcome = await recoveryStep(recovery(), { challengeToken: await challenge(account), code: account.codes[index]?.code ?? "", sourceAddress: SOURCE });
  if (outcome.code !== "RECOVERY_SESSION_ISSUED") {
    throw new Error(`recovery step gave ${outcome.code}`);
  }
  return outcome.recoverySessionToken;
}

const digestOf = (token: string) => tokenDigest(token) as Buffer;
const sessionValid = async (token: string) => ok(await auth.checkSession(db, { tokenDigest: digestOf(token) }, clock)).code === "SESSION_VALID";

const TABLES = [
  "administrator",
  "administrator_totp_factor",
  "administrator_session",
  "administrator_pending_challenge",
  "administrator_consumed_challenge",
  "administrator_recovery_code",
  "authentication_throttle",
  "authentication_source_window",
] as const;

async function stored(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of TABLES) {
    out[table] = (await observer.query(`select row_to_json(t)::text as r from ${table} t`)).rows.map((row) => row.r as string).sort();
  }
  return out;
}

/** Every stored row of one administrator, by table. */
async function storedOf(account: Account): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of TABLES.filter((t) => t !== "authentication_throttle" && t !== "authentication_source_window")) {
    const column = table === "administrator" ? "id" : "administrator_id";
    out[table] = (await observer.query(`select row_to_json(t)::text as r from ${table} t where ${column} = $1`, [account.id])).rows.map((row) => row.r as string).sort();
  }
  return out;
}

const row = async (sql: string, values: readonly unknown[]) => (await observer.query(sql, values)).rows[0];
const adminRow = (account: Account) => row("select password_hash, password_disabled_at::text as pd, disabled_at::text as d from administrator where id = $1", [account.id]);
const factorRow = (account: Account) =>
  row("select state, factor_id, origin_recovery_session_id as origin, last_accepted_step::text as step from administrator_totp_factor where administrator_id = $1", [account.id]);
const codeDigests = async (account: Account) =>
  (await observer.query("select encode(code_digest, 'hex') as d from administrator_recovery_code where administrator_id = $1", [account.id])).rows.map((r) => r.d as string).sort();
const hexSet = (codes: readonly GeneratedRecoveryCode[]) => codes.map((c) => c.digest.toString("hex")).sort();
const sessionCount = async (account: Account) => Number((await row("select count(*)::int as n from administrator_session where administrator_id = $1", [account.id]))?.n);
const pendingFlags = async (account: Account) =>
  (await observer.query("select invalidated from administrator_pending_challenge where administrator_id = $1", [account.id])).rows.map((r) => r.invalidated as boolean);
const sent = (since: number) => hooks.log.slice(since);
const affectedOf = (since: number, label: string) => hooks.affected.slice(since).filter((e) => e.startsWith(`${label}:`)).map((e) => Number(e.split(":")[1]));

async function throttleRow(scope: string, subject: Buffer) {
  return row("select consecutive_failures from authentication_throttle where scope = $1 and subject_digest = $2", [scope, subject]);
}

/** A schema-valid counter row: from 5 failures a wait is required, here one that already passed. */
async function setCounter(scope: string, subject: Buffer, failures: number) {
  const passed = new Date(current - 1000).toISOString();
  await observer.query(
    `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
     values ($1, $2, $3, case when $3::int >= 5 then $4::timestamptz end, $4::timestamptz)
     on conflict (scope, subject_digest) do update set
       consecutive_failures = excluded.consecutive_failures, wait_until = excluded.wait_until`,
    [scope, subject, failures, passed],
  );
}

/* ------------------------------------------------------------------------------------------- */
/* R-1 to R-4: T1                                                                               */
/* ------------------------------------------------------------------------------------------- */

describe("R-1: T1 on an enabled account", () => {
  it("writes exactly the §3.4 T1 row, with required counts 1, 1 and 10, and touches nothing else", async () => {
    const account = await seed();
    const other = await seed();
    await administratorSession(account);
    await challenge(account);
    const otherBefore = await storedOf(other);
    const consumedBefore = (await stored()).administrator_consumed_challenge;
    const sourceBefore = (await stored()).authentication_source_window;
    const reset = newRun(account);

    const mark = hooks.log.length;
    const outcome = ok(await t1(reset));

    expect(outcome).toEqual({ code: "CREDENTIALS_RESET", revoked: 1, accountDisabled: false });
    expect(affectedOf(mark, "reset-password")).toEqual([1]);
    expect(affectedOf(mark, "reset-factor")).toEqual([1]);
    expect(affectedOf(mark, "insert-recovery-codes")).toEqual([10]);
    expect(await adminRow(account)).toEqual({ password_hash: reset.run.expectedPasswordHash, pd: null, d: null });
    expect(await factorRow(account)).toEqual({ state: "pending_confirmation", factor_id: reset.run.factorId, origin: null, step: null });
    expect(await codeDigests(account)).toEqual(hexSet(reset.codes));
    expect(await sessionCount(account)).toBe(0);
    expect((await pendingFlags(account)).every((flag) => flag)).toBe(true);
    expect(await storedOf(other)).toEqual(otherBefore);
    expect((await stored()).administrator_consumed_challenge).toEqual(consumedBefore);
    expect((await stored()).authentication_source_window).toEqual(sourceBefore);
  });

  it("an unknown administrator rolls back with ADMINISTRATOR_NOT_FOUND and writes nothing", async () => {
    const before = await stored();
    const ghost = { id: randomUUID(), username: "synthetic-ghost", secret: generateTotpSecret(), codes: [], password: PASSWORD };
    expect(ok(await t1(newRun(ghost)))).toEqual({ code: "ADMINISTRATOR_NOT_FOUND" });
    expect(await stored()).toEqual(before);
  });
});

describe("R-2: T1 on a disabled account (D-16)", () => {
  it("commits, leaves disabled_at byte-identical, and every route still refuses", async () => {
    const account = await seed();
    expect(ok(await auth.disableAccount(db, { administratorId: account.id }, clock))).toMatchObject({ code: "DISABLED" });
    const before = (await adminRow(account))?.d;
    expect(before).not.toBeNull();
    const reset = newRun(account);

    expect(ok(await t1(reset))).toMatchObject({ code: "CREDENTIALS_RESET", accountDisabled: true });
    expect((await adminRow(account))?.d).toBe(before);
    expect(await factorRow(account)).toMatchObject({ state: "pending_confirmation", factor_id: reset.run.factorId, origin: null });

    // The password step refuses with the new password: no challenge is issued.
    const pendingBefore = (await pendingFlags(account)).length;
    const step = await passwordStep(signIn(), { username: account.username, password: reset.password, sourceAddress: SOURCE });
    expect(step.code).not.toBe("CHALLENGE_ISSUED");
    expect((await pendingFlags(account)).length).toBe(pendingBefore);
  });
});

describe("R-2b: the T2 refusal on a disabled account", () => {
  it("is ACCOUNT_DISABLED with a correct code and an exact handoff; nothing is written; the verifier is not called", async () => {
    const account = await seed();
    ok(await auth.disableAccount(db, { administratorId: account.id }, clock));
    const reset = newRun(account);
    ok(await t1(reset));
    const before = await stored();
    let verifierCalls = 0;
    const verify = totpVerifierFor(TOTP_KEYS, totpCodeAt(reset.secret, current));

    const mark = hooks.log.length;
    const outcome = ok(
      await auth.confirmOperatorReset(
        db,
        {
          run: reset.run,
          verify: (factor, now) => {
            verifierCalls += 1;
            return verify(factor, now);
          },
        },
        clock,
      ),
    );

    expect(outcome).toEqual({ code: "REFUSED", reason: "ACCOUNT_DISABLED" });
    expect(verifierCalls).toBe(0);
    expect(sent(mark)).toEqual(["lock-administrator"]);
    expect(await stored()).toEqual(before);
  });
});

describe("R-3: the origin is written NULL", () => {
  it("over a pending factor with a recovery origin, over an absent factor row, and over reenrolment_required", async () => {
    const withOrigin = await seed();
    const q = await recoverySession(withOrigin, 0);
    expect((await reenrolmentStart(recovery(), { recoverySessionToken: q })).code).toBe("REENROLMENT_STARTED");
    expect((await factorRow(withOrigin))?.origin).not.toBeNull();
    const a = newRun(withOrigin);
    ok(await t1(a));
    expect(await factorRow(withOrigin)).toMatchObject({ state: "pending_confirmation", factor_id: a.run.factorId, origin: null });

    const bare: Account = { id: randomUUID(), username: `synthetic-${randomBytes(5).toString("hex")}`, secret: generateTotpSecret(), codes: [], password: PASSWORD };
    ok(await auth.createAdministrator(db, { administratorId: bare.id, username: bare.username, passwordHash: hashFor(PASSWORD) }, clock));
    expect(await factorRow(bare)).toBeUndefined();
    const b = newRun(bare);
    ok(await t1(b));
    expect(await factorRow(bare)).toMatchObject({ state: "pending_confirmation", factor_id: b.run.factorId, origin: null });

    const discarded = await seed();
    await recoverySession(discarded, 0);
    expect((await factorRow(discarded))?.state).toBe("reenrolment_required");
    const c = newRun(discarded);
    ok(await t1(c));
    expect(await factorRow(discarded)).toMatchObject({ state: "pending_confirmation", factor_id: c.run.factorId, origin: null });
  });
});

describe("R-4: the throttle", () => {
  it("deletes exactly the password, totp and recovery_code rows the sign-in modules wrote, and clears password_disabled_at", async () => {
    const account = await seed();
    const other = await seed();
    // Real failures write each row with the modules' own subject digests. The password failure
    // comes last: a successful password step (each challenge here) clears its own counter.
    expect((await totpStep(signIn(), { challengeToken: await challenge(account), code: "000000", sourceAddress: SOURCE })).code).toBe("FAILED");
    expect((await recoveryStep(recovery(), { challengeToken: await challenge(account), code: "0".repeat(32), sourceAddress: SOURCE })).code).toBe("FAILED");
    expect((await passwordStep(signIn(), { username: account.username, password: "a wrong synthetic password!", sourceAddress: SOURCE })).code).toBe("FAILED");
    expect((await passwordStep(signIn(), { username: other.username, password: "a wrong synthetic password!", sourceAddress: SOURCE })).code).toBe("FAILED");
    await observer.query("update administrator set password_disabled_at = $2::timestamptz where id = $1", [account.id, new Date(current - 1000).toISOString()]);
    const reset = newRun(account);

    for (const [scope, subject] of [["password", reset.subjects.password], ["totp", reset.subjects.totp], ["recovery_code", reset.subjects.recoveryCode]] as const) {
      expect(await throttleRow(scope, subject), scope).toBeDefined();
    }
    const otherSubject = keyedDigest(THROTTLE_KEY, "password-username", other.username);
    const sourceBefore = (await stored()).authentication_source_window;

    ok(await t1(reset));

    for (const [scope, subject] of [["password", reset.subjects.password], ["totp", reset.subjects.totp], ["recovery_code", reset.subjects.recoveryCode]] as const) {
      expect(await throttleRow(scope, subject), scope).toBeUndefined();
    }
    expect(await throttleRow("password", otherSubject)).toBeDefined();
    expect((await stored()).authentication_source_window).toEqual(sourceBefore);
    expect((await adminRow(account))?.pd).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------- */
/* R-5: T2                                                                                      */
/* ------------------------------------------------------------------------------------------- */

describe("R-5: T2, the success path", () => {
  it("activates exactly the run's factor at the post-lock step, inserts no code, in the stated statement order", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    const mark = hooks.log.length;

    expect(ok(await t2(reset))).toEqual({ code: "RESET_CONFIRMED" });
    expect(sent(mark)).toEqual(["lock-administrator", "read-pending-factor", "reset-code-set", "confirm-operator-reset", "invalidate-pending-challenges"]);
    expect(await factorRow(account)).toMatchObject({ state: "active", factor_id: reset.run.factorId, origin: null, step: String(Math.floor(current / 30_000)) });
    expect(await codeDigests(account)).toEqual(hexSet(reset.codes));
    expect(sent(mark)).not.toContain("insert-recovery-codes");
  });
});

/** T2 refuses with `reason`, writes nothing and, unless stated, never calls the verifier. */
async function expectRefusal(reset: Reset, reason: string, options: { run?: auth.ResetRun; verifierCalled?: boolean } = {}) {
  const before = await stored();
  let calls = 0;
  const verify = totpVerifierFor(TOTP_KEYS, totpCodeAt(reset.secret, current));
  const outcome = ok(
    await auth.confirmOperatorReset(
      db,
      {
        run: options.run ?? reset.run,
        verify: (factor, now) => {
          calls += 1;
          return verify(factor, now);
        },
      },
      clock,
    ),
  );
  expect(outcome).toEqual({ code: "REFUSED", reason });
  expect(calls > 0).toBe(options.verifierCalled ?? false);
  expect(await stored()).toEqual(before);
}

describe("R-5a: T2 rejects a provisioning factor", () => {
  it("a never-reset provisioning account: CODE_SET_CHANGED, even with its own hash, factor and a correct code", async () => {
    const id = randomUUID();
    const username = `synthetic-${randomBytes(5).toString("hex")}`;
    const hash = hashFor(PASSWORD);
    const secret = generateTotpSecret();
    const factorId = randomUUID();
    ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash: hash }, clock));
    ok(await auth.startTotpEnrolment(db, { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, secret) }, clock));
    const forged: Reset = {
      ...newRun({ id, username, secret, codes: [], password: PASSWORD }),
      secret,
    };
    const run: auth.ResetRun = { ...forged.run, expectedPasswordHash: hash, factorId };
    await expectRefusal(forged, "CODE_SET_CHANGED", { run });
    expect(await factorRow({ id } as Account)).toMatchObject({ state: "pending_confirmation", factor_id: factorId });
  });

  it("a provisioning start after this run's T1: FACTOR_NOT_FROM_THIS_RESET", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    // The RA-7 caller restriction deliberately violated, as a foreign provisioning write.
    ok(await auth.startTotpEnrolment(db, { administratorId: account.id, factorId: randomUUID(), material: sealTotpSecret(TOTP_KEY, 1, account.id, generateTotpSecret()) }, clock));
    await expectRefusal(reset, "FACTOR_NOT_FROM_THIS_RESET");
  });

  it("an RA-5-confirmed account: FACTOR_NOT_PENDING for its own factor, FACTOR_NOT_FROM_THIS_RESET for another", async () => {
    const account = await seed();
    const current_ = (await factorRow(account))!;
    const hash = (await adminRow(account))!.password_hash as string;
    const reset = newRun(account);
    const own: auth.ResetRun = { ...reset.run, expectedPasswordHash: hash, factorId: current_.factor_id as string, expectedCodeDigests: account.codes.map((c) => c.digest) };
    await expectRefusal({ ...reset, secret: account.secret }, "FACTOR_NOT_PENDING", { run: own });
    await expectRefusal(reset, "FACTOR_NOT_FROM_THIS_RESET", { run: { ...own, factorId: reset.run.factorId } });
  });
});

describe("R-5b: T2 rejects a changed code set", () => {
  const variants: readonly [string, (account: Account, reset: Reset) => Promise<auth.ResetRun | undefined>][] = [
    ["one expected digest deleted", async (account, reset) => {
      await observer.query("delete from administrator_recovery_code where administrator_id = $1 and code_digest = $2", [account.id, reset.codes[0]!.digest]);
      return undefined;
    }],
    ["one expected digest replaced by a foreign one", async (account, reset) => {
      await observer.query("update administrator_recovery_code set code_digest = $3 where administrator_id = $1 and code_digest = $2", [account.id, reset.codes[0]!.digest, randomBytes(32)]);
      return undefined;
    }],
    ["an eleventh digest added", async (account) => {
      await observer.query("insert into administrator_recovery_code (administrator_id, code_digest) values ($1, $2)", [account.id, randomBytes(32)]);
      return undefined;
    }],
    ["storage unchanged, the handoff's expected set differs in one digest", async (_account, reset) => ({
      ...reset.run,
      expectedCodeDigests: [randomBytes(32), ...reset.run.expectedCodeDigests.slice(1)],
    })],
  ];

  for (const [name, change] of variants) {
    it(`${name}: CODE_SET_CHANGED, nothing written, the factor stays pending`, async () => {
      const account = await seed();
      const reset = newRun(account);
      ok(await t1(reset));
      const run = await change(account, reset);
      await expectRefusal(reset, "CODE_SET_CHANGED", run === undefined ? {} : { run });
      expect((await factorRow(account))?.state).toBe("pending_confirmation");
    });
  }

  it("every code deleted by the real recovery-code ceiling after T1: CODE_SET_CHANGED", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    account.password = reset.password;
    await setCounter("recovery_code", reset.subjects.recoveryCode, 99);
    const failed = await recoveryStep(recovery(), { challengeToken: await challenge(account), code: "0".repeat(32), sourceAddress: SOURCE });
    expect(failed).toMatchObject({ code: "FAILED", codesDisabled: true });
    expect(await codeDigests(account)).toEqual([]);
    await expectRefusal(reset, "CODE_SET_CHANGED");
  });
});

describe("R-5c: T2 rejects a changed password", () => {
  it("a second T1 from another run: PASSWORD_CHANGED for the first run's handoff, before the factor check", async () => {
    const account = await seed();
    const first = newRun(account);
    ok(await t1(first));
    const second = newRun(account);
    ok(await t1(second));
    await expectRefusal(first, "PASSWORD_CHANGED");
    // The first run's factor arranged back, with the second run's hash still stored.
    await observer.query("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [account.id, first.run.factorId]);
    await expectRefusal(first, "PASSWORD_CHANGED");
  });
});

describe("R-5d: T2's other refusals", () => {
  it("a wrong code: WRONG_CODE, uncounted, nothing written", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    const before = await stored();
    expect(ok(await t2(reset, "000000"))).toEqual({ code: "REFUSED", reason: "WRONG_CODE" });
    expect(await stored()).toEqual(before);
  });

  it("an unreadable factor: FACTOR_UNREADABLE", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    const before = await stored();
    const outcome = ok(await auth.confirmOperatorReset(db, { run: reset.run, verify: totpVerifierFor(new Map([[1, randomBytes(32)]]), "000000") }, clock));
    expect(outcome).toEqual({ code: "REFUSED", reason: "FACTOR_UNREADABLE" });
    expect(await stored()).toEqual(before);
  });

  it("a second T2 after a committed one: FACTOR_NOT_PENDING", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    ok(await t2(reset));
    current += 30_000;
    await expectRefusal(reset, "FACTOR_NOT_PENDING");
  });

  it("a later code success discards the run's factor (RA-1): FACTOR_NOT_FROM_THIS_RESET", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    account.password = reset.password;
    account.codes = reset.codes;
    await recoverySession(account, 0);
    expect(await factorRow(account)).toMatchObject({ state: "reenrolment_required", factor_id: null });
    await expectRefusal(reset, "FACTOR_NOT_FROM_THIS_RESET");
  });

  it("a backstop non-null origin set by arranged state: FACTOR_HAS_RECOVERY_ORIGIN", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    await observer.query("update administrator_totp_factor set origin_recovery_session_id = $2 where administrator_id = $1", [account.id, randomUUID()]);
    await expectRefusal(reset, "FACTOR_HAS_RECOVERY_ORIGIN");
  });
});

/* ------------------------------------------------------------------------------------------- */
/* R-6: PS-8a after T1                                                                          */
/* ------------------------------------------------------------------------------------------- */

describe("R-6: every old credential fails after T1 (a different new password)", () => {
  it("old password, old TOTP on a pre-T1 challenge, an old code, a pre-T1 recovery session", async () => {
    const account = await seed();
    const session = await administratorSession(account);
    const preChallenge = await challenge(account);
    const q = await recoverySession(account, 0);
    const oldSecret = account.secret;
    const reset = await resetAndConfirm({ ...account }, NEW_PASSWORD);

    expect(await sessionValid(session)).toBe(false);
    expect((await passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE })).code).toBe("FAILED");
    expect(await totpStep(signIn(), { challengeToken: preChallenge, code: totpCodeAt(oldSecret, current), sourceAddress: SOURCE })).toMatchObject({ code: "REFUSED" });
    const fresh = await challenge({ ...account, password: NEW_PASSWORD });
    expect(await recoveryStep(recovery(), { challengeToken: fresh, code: account.codes[1]!.code, sourceAddress: SOURCE })).toMatchObject({ code: "FAILED", reason: "WRONG_CODE" });
    expect((await regeneration(recovery(), { recoverySessionToken: q })).code).toBe("REFUSED");
    expect(reset.password).not.toBe(PASSWORD);
  });
});

describe("R-6b: a reused password, in flight against the old hash vs a fresh attempt", () => {
  it("in flight: verified against H_old, then T1 commits, then the success transaction refuses, uncounted", async () => {
    const account = await seed();
    const oldHash = (await adminRow(account))!.password_hash as string;
    const reset = newRun(account, PASSWORD);
    let reached = () => undefined as void;
    let release = () => undefined as void;
    const atBarrier = new Promise<void>((resolve) => (reached = resolve));
    holdVerification = { hash: oldHash, reached: () => reached(), gate: new Promise<void>((resolve) => (release = resolve)) };

    const inFlight = passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE });
    await within(atBarrier, "the held verification");
    ok(await t1(reset));
    const before = await stored();
    release();

    expect((await within(inFlight, "the in-flight password step")).code).toBe("REFUSED");
    expect(await stored()).toEqual(before);
    expect((await adminRow(account))!.password_hash).not.toBe(oldHash);
  });

  it("fresh: after T1 and T2, the same plaintext reads H and issues a challenge", async () => {
    const account = await seed();
    const oldHash = (await adminRow(account))!.password_hash;
    await resetAndConfirm(account, PASSWORD);
    expect((await adminRow(account))!.password_hash).not.toBe(oldHash);
    expect(typeof (await challenge(account, PASSWORD))).toBe("string");
  });

  it("the in-flight step serialized before T1: its challenge is issued, then invalidated by T1", async () => {
    const account = await seed();
    const early = await challenge(account, PASSWORD);
    const reset = await resetAndConfirm({ ...account }, PASSWORD);
    expect(await totpStep(signIn(), { challengeToken: early, code: totpCodeAt(reset.secret, current), sourceAddress: SOURCE })).toMatchObject({ code: "REFUSED" });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* R-7: races, both serialization orders                                                        */
/* ------------------------------------------------------------------------------------------- */

interface Invariants {
  readonly activeWithLiveRecovery: boolean;
  readonly disabledCleared: boolean;
}

async function invariants(account: Account, wasDisabled: boolean): Promise<Invariants> {
  const factor = await factorRow(account);
  const liveRecovery = Number(
    (await row("select count(*)::int as n from administrator_session where administrator_id = $1 and kind = 'recovery' and absolute_expires_at > $2::timestamptz", [account.id, new Date(current).toISOString()]))?.n,
  );
  return { activeWithLiveRecovery: factor?.state === "active" && liveRecovery > 0, disabledCleared: wasDisabled && (await adminRow(account))?.d === null };
}

interface RivalState {
  readonly q?: string;
  readonly challenge?: string;
  /** The pending factor a recovery start made in Q before either operation runs. */
  readonly factorId?: string;
  readonly secret?: Buffer;
}

describe("R-7: races on the administrator lock, both orders", () => {
  const rivals: readonly [string, (account: Account, state: RivalState) => Promise<unknown>, (account: Account) => Promise<RivalState>][] = [
    ["a recovery-code success", (account, s) => recoveryStep(recovery(), { challengeToken: s.challenge!, code: account.codes[1]!.code, sourceAddress: SOURCE }), async (account) => ({ challenge: await challenge(account) })],
    ["a TOTP completion", (account, s) => totpStep(signIn(), { challengeToken: s.challenge!, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE }), async (account) => ({ challenge: await challenge(account) })],
    ["a recovery start in Q", (_a, s) => reenrolmentStart(recovery(), { recoverySessionToken: s.q! }), async (account) => ({ q: await recoverySession(account, 0) })],
    ["a regeneration in Q", (_a, s) => regeneration(recovery(), { recoverySessionToken: s.q! }), async (account) => ({ q: await recoverySession(account, 0) })],
    ["a completion in Q", (_a, s) => reenrolmentCompletion(recovery(), { recoverySessionToken: s.q!, factorId: s.factorId!, code: totpCodeAt(s.secret!, current) }), async (account) => {
      const q = await recoverySession(account, 0);
      const begun = await reenrolmentStart(recovery(), { recoverySessionToken: q });
      if (begun.code !== "REENROLMENT_STARTED") {
        throw new Error(`recovery start gave ${begun.code}`);
      }
      return { q, factorId: begun.factorId, secret: begun.secret };
    }],
    ["revokeAllSessions", (account) => auth.revokeAllSessions(db, { administratorId: account.id }), async () => ({})],
    ["another T1", (account) => t1(newRun(account)), async () => ({})],
  ];

  for (const [name, rival, prepare] of rivals) {
    for (const order of ["T1 first", "rival first"] as const) {
      it(`T1 against ${name}, ${order}: no active factor with a live recovery session; no old credential verifies; disabled_at never cleared`, async () => {
        const account = await seed();
        const state = await prepare(account);
        const reset = newRun(account);

        if (order === "T1 first") {
          ok(await within(t1(reset), "T1"));
          const answer = await within(rival(account, state), name);
          if (name === "a completion in Q") {
            // T1 deleted Q, so the original session and factor can no longer complete.
            expect(answer).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
          }
        } else {
          const answer = await within(rival(account, state), name);
          if (name === "a completion in Q") {
            expect(answer, "the completion succeeds before T1 runs").toMatchObject({ code: "REENROLMENT_COMPLETED" });
          }
          ok(await within(t1(reset), "T1"));
        }

        const disabled = (await adminRow(account))?.d !== null;
        expect(await invariants(account, disabled)).toEqual({ activeWithLiveRecovery: false, disabledCleared: false });
        expect((await passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE })).code).not.toBe("CHALLENGE_ISSUED");
      });
    }
  }

  for (const order of ["T1 first", "disable first"] as const) {
    it(`T1 against disableAccount, ${order}: disable succeeds and its disabled_at is kept exactly (D-16)`, async () => {
      const account = await seed();
      const reset = newRun(account);
      const disable = async () => {
        expect(ok(await within(auth.disableAccount(db, { administratorId: account.id }, clock), "disableAccount"))).toMatchObject({ code: "DISABLED" });
        const disabledAt = (await adminRow(account))?.d;
        expect(disabledAt, "disabled_at right after disable").not.toBeNull();
        return disabledAt;
      };

      let disabledAt: unknown;
      if (order === "T1 first") {
        ok(await within(t1(reset), "T1"));
        disabledAt = await disable();
      } else {
        disabledAt = await disable();
        ok(await within(t1(reset), "T1"));
      }

      expect((await adminRow(account))?.d, "the final disabled_at").toBe(disabledAt);
      expect(await invariants(account, true)).toEqual({ activeWithLiveRecovery: false, disabledCleared: false });
      expect((await passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE })).code).not.toBe("CHALLENGE_ISSUED");
    });
  }

  it("T2 against a recovery-code success, both orders", async () => {
    for (const order of ["T2 first", "code first"] as const) {
      const account = await seed();
      const reset = newRun(account);
      ok(await t1(reset));
      const withNew = { ...account, password: reset.password, codes: reset.codes };
      const pending = await challenge(withNew);
      const code = () => recoveryStep(recovery(), { challengeToken: pending, code: reset.codes[0]!.code, sourceAddress: SOURCE });

      if (order === "T2 first") {
        expect(ok(await t2(reset))).toEqual({ code: "RESET_CONFIRMED" });
        // T2 invalidated the challenge, so the code is refused uncounted.
        expect((await code()).code).toBe("REFUSED");
      } else {
        expect((await code()).code).toBe("RECOVERY_SESSION_ISSUED");
        expect(ok(await t2(reset))).toEqual({ code: "REFUSED", reason: "FACTOR_NOT_FROM_THIS_RESET" });
      }
      expect(await invariants(account, false), order).toEqual({ activeWithLiveRecovery: false, disabledCleared: false });
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* R-8 the probe; R-9 uncertain commits; R-10 row counts                                        */
/* ------------------------------------------------------------------------------------------- */

const PROBE_KEYS = ["accountEnabled", "codeSetMatches", "factorMatches", "factorState", "found", "originIsNull", "passwordMatches"];

describe("R-8: the probe", () => {
  it("is one SELECT, read-only, with exactly seven keys and nothing secret", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    const before = await stored();
    const mark = hooks.log.length;
    const p = ok(await probe(reset));

    expect(sent(mark)).toEqual(["probe-operator-reset"]);
    expect(await stored()).toEqual(before);
    expect(Object.keys(p).sort()).toEqual(PROBE_KEYS);
    expect(p).toEqual({ found: true, passwordMatches: true, factorMatches: true, factorState: "pending_confirmation", originIsNull: true, accountEnabled: true, codeSetMatches: true });
    const text = JSON.stringify(p);
    for (const secret of [reset.run.expectedPasswordHash, reset.run.factorId, ...reset.codes.map((c) => c.digest.toString("hex"))]) {
      expect(text).not.toContain(secret);
    }
  });

  it("drives each field independently by arranged state", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    const set = (sql: string, values: readonly unknown[]) => observer.query(sql, values);

    await set("update administrator set password_hash = $2 where id = $1", [account.id, hashFor("other")]);
    expect(ok(await probe(reset))).toMatchObject({ passwordMatches: false, factorMatches: true });
    await set("update administrator set password_hash = $2 where id = $1", [account.id, reset.run.expectedPasswordHash]);

    await set("delete from administrator_recovery_code where administrator_id = $1 and code_digest = $2", [account.id, reset.codes[0]!.digest]);
    expect(ok(await probe(reset))).toMatchObject({ passwordMatches: true, factorMatches: true, codeSetMatches: false });
    await set("insert into administrator_recovery_code (administrator_id, code_digest) values ($1, $2)", [account.id, reset.codes[0]!.digest]);

    await set("update administrator_totp_factor set origin_recovery_session_id = $2 where administrator_id = $1", [account.id, randomUUID()]);
    expect(ok(await probe(reset))).toMatchObject({ factorMatches: true, originIsNull: false });
    await set("update administrator_totp_factor set origin_recovery_session_id = null where administrator_id = $1", [account.id]);

    await set("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [account.id, randomUUID()]);
    expect(ok(await probe(reset))).toMatchObject({ passwordMatches: true, factorMatches: false, factorState: null, originIsNull: false });
    await set("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [account.id, reset.run.factorId]);

    ok(await t2(reset));
    expect(ok(await probe(reset))).toMatchObject({ factorState: "active", codeSetMatches: true });
    ok(await auth.disableAccount(db, { administratorId: account.id }, clock));
    expect(ok(await probe(reset))).toMatchObject({ accountEnabled: false });

    const ghost = newRun({ id: randomUUID(), username: "synthetic-ghost", secret: generateTotpSecret(), codes: [], password: PASSWORD });
    expect(ok(await probe(ghost))).toEqual({ found: false, passwordMatches: false, factorMatches: false, factorState: null, originIsNull: false, accountEnabled: false, codeSetMatches: false });
  });
});

describe("R-9: uncertain commits", () => {
  it("T1's COMMIT executed, its acknowledgement lost: a storage failure, and the probe shows both identifiers (U1-a)", async () => {
    const account = await seed();
    const reset = newRun(account);
    hooks.commitFault = "after";
    const outcome = await t1(reset);
    expect(outcome.ok).toBe(false);
    expect(ok(await probe(reset))).toEqual({ found: true, passwordMatches: true, factorMatches: true, factorState: "pending_confirmation", originIsNull: true, accountEnabled: true, codeSetMatches: true });
  });

  it("T2's COMMIT executed, its acknowledgement lost: the probe shows U2-a (active, enabled, the exact set)", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    hooks.commitFault = "after";
    expect((await t2(reset)).ok).toBe(false);
    expect(ok(await probe(reset))).toMatchObject({ passwordMatches: true, factorMatches: true, factorState: "active", accountEnabled: true, codeSetMatches: true });
  });

  it("a fault before COMMIT: the whole state is identical and the probe shows neither identifier", async () => {
    const account = await seed();
    const reset = newRun(account);
    const before = await stored();
    hooks.commitFault = "before";
    expect((await t1(reset)).ok).toBe(false);
    expect(await stored()).toEqual(before);
    expect(ok(await probe(reset))).toMatchObject({ found: true, passwordMatches: false, factorMatches: false });
  });

  it("a committed T1 overwritten by a foreign writer gives the same probe as a rollback (W-3 not established)", async () => {
    const rolledBack = await seed();
    const a = newRun(rolledBack);
    hooks.commitFault = "before";
    expect((await t1(a)).ok).toBe(false);
    const afterRollback = ok(await probe(a));

    const overwritten = await seed();
    const b = newRun(overwritten);
    ok(await t1(b));
    // `psql` standing in for a writer outside the launcher lock, replacing what a later reset would.
    await observer.query("update administrator set password_hash = $2 where id = $1", [overwritten.id, hashFor("foreign")]);
    await observer.query("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [overwritten.id, randomUUID()]);
    await observer.query("delete from administrator_recovery_code where administrator_id = $1", [overwritten.id]);
    await observer.query(
      "insert into administrator_recovery_code (administrator_id, code_digest) select $1, u.d from unnest($2::bytea[]) as u(d)",
      [overwritten.id, generateRecoveryCodes().map((c) => c.digest)],
    );
    expect(ok(await probe(b))).toEqual(afterRollback);
  });
});

describe("R-10: the row-count protocol", () => {
  for (const [label, expected] of [["reset-password", 1], ["reset-factor", 1], ["insert-recovery-codes", 10]] as const) {
    it(`T1: ${label} reported as another count rolls the whole transaction back`, async () => {
      const account = await seed();
      const before = await stored();
      hooks.counts.set(label, expected + 1);
      expect(await t1(newRun(account))).toEqual({ ok: false, failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement: label, expected, actual: expected + 1 } });
      expect(await stored()).toEqual(before);
    });
  }

  it("T2: confirm-operator-reset reported as 0 rolls back", async () => {
    const account = await seed();
    const reset = newRun(account);
    ok(await t1(reset));
    const before = await stored();
    hooks.counts.set("confirm-operator-reset", 0);
    expect(await t2(reset)).toEqual({ ok: false, failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement: "confirm-operator-reset", expected: 1, actual: 0 } });
    expect(await stored()).toEqual(before);
  });
});
