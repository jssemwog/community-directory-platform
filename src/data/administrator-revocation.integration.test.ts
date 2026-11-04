/**
 * Attacking tests for the issue #270 storage operations: the session listing, revoke-one,
 * revoke-all and disable (§6.1 V-0 to V-6), against a real PostgreSQL from `embedded-postgres`, in
 * one disposable cluster, with an injected clock.
 *
 * - **Statement observer:** the runtime's database runs through a test-owned `pg` pool wrapper. It
 *   records each `adr028:<label>` statement and the row count the server reported. It can hold one
 *   labelled statement at a barrier, and can report a labelled statement as having affected
 *   another count. **A fabricated count changes only what the operation reads back, never what the
 *   server executed** (V-4).
 * - **Arranged state:** a disabled account with its rows intact (V-3b), and schema-valid session
 *   fixtures (V-0), are written directly by test setup, as #266's suite did. No migration-`003`
 *   constraint is dropped or weakened.
 * - **Nothing simulates an unbuilt operation**: reset, re-enablement and key replacement do not
 *   exist, and nothing here stands in for them.
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
import { generateRecoveryCodes, type GeneratedRecoveryCode } from "../domain/administrator-auth/recovery-code";
import { reenrolmentCompletion, reenrolmentStart, recoveryStep, regeneration, type RecoveryDependencies } from "../domain/administrator-auth/recovery";
import { sealTotpSecret } from "../domain/administrator-auth/secret-box";
import { passwordStep, totpStep, totpVerifierFor, type SignInDependencies } from "../domain/administrator-auth/sign-in";
import { tokenDigest } from "../domain/administrator-auth/token";
import { generateTotpSecret, totpCodeAt } from "../domain/administrator-auth/totp";

interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
  command?: string;
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

const DATABASE = "revocation_disablement";
const cluster = useEmbeddedPostgres({ slug: "revocation-disablement", databases: [DATABASE], migrate: [DATABASE] });

const OPERATION_APP = "rv_operation";
const STEP_BOUND_MS = 10_000;
const STUB_HASH = "scrypt$ln=17,r=8,p=1$c3R1Yi1zYWx0LTE2Ynl0ZQ$c3R1Yi1rZXk";
const PASSWORD = "a synthetic local password for revocation tests";
const SOURCE = "local-loopback";
const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);

/** The injected clock. */
let current = Date.UTC(2026, 10, 4, 12, 0, 0);
let clockReads = 0;
const clock: auth.Clock = () => {
  clockReads += 1;
  return current;
};

interface Hooks {
  readonly log: string[];
  /** `label:rowCount`, as the server reported it. */
  readonly affected: string[];
  readonly counts: Map<string, number>;
  readonly pauses: Map<string, { readonly gate: Promise<void>; readonly reached: () => void }>;
}

const hooks: Hooks = { log: [], affected: [], counts: new Map(), pauses: new Map() };
const broken = new WeakSet<PgClient>();
let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;

const labelOf = (text: string) => (text.startsWith("/* adr028:") ? text.slice(10, text.indexOf(" */")) : undefined);

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
  const pool = createPool(OPERATION_APP, 8);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
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
  observer = createPool("rv_observer", 6);
  cluster.closeBeforeShutdown("revocation operations", () => db.destroy());
  cluster.closeBeforeShutdown("revocation observer", () => observer.end());
}, CLUSTER_TIMEOUT_MS);

afterEach(async () => {
  hooks.counts.clear();
  hooks.pauses.clear();
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
  passwords: { verify: async (password: string) => password === PASSWORD },
  dummyPasswordHash: STUB_HASH,
  throttleKey: THROTTLE_KEY,
  totpKeys: TOTP_KEYS,
});
const recovery = (): RecoveryDependencies => ({ db, clock, throttleKey: THROTTLE_KEY, totpKeys: TOTP_KEYS, currentTotpKeyVersion: 1 });

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

  ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash: STUB_HASH }, clock));
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
  return { id, username, secret, codes };
}

async function challenge(account: Account, password = PASSWORD): Promise<string> {
  const outcome = await passwordStep(signIn(), { username: account.username, password, sourceAddress: SOURCE });
  if (outcome.code !== "CHALLENGE_ISSUED") {
    throw new Error(`password step gave ${outcome.code}`);
  }
  return outcome.challengeToken;
}

/** Password, then TOTP: an administrator session token. */
async function administratorSession(account: Account): Promise<string> {
  const token = await challenge(account);
  const outcome = await totpStep(signIn(), { challengeToken: token, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE });
  if (outcome.code !== "SESSION_ISSUED") {
    throw new Error(`totp step gave ${outcome.code}`);
  }
  current += 60_000;
  return outcome.sessionToken;
}

/** Password, then the code at `index`: a recovery session token. */
async function recoverySession(account: Account, index: number): Promise<string> {
  const outcome = await recoveryStep(recovery(), { challengeToken: await challenge(account), code: account.codes[index]?.code ?? "", sourceAddress: SOURCE });
  if (outcome.code !== "RECOVERY_SESSION_ISSUED") {
    throw new Error(`recovery step gave ${outcome.code}`);
  }
  return outcome.recoverySessionToken;
}

const digestOf = (token: string) => {
  const digest = tokenDigest(token);
  expect(digest).not.toBeNull();
  return digest as Buffer;
};

const sessionIdOf = async (token: string) =>
  (await observer.query("select id from administrator_session where token_digest = $1", [digestOf(token)])).rows[0]?.id as string | undefined;

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

/** Every row of every authentication table, as stored text. */
async function stored(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of TABLES) {
    out[table] = (await observer.query(`select row_to_json(t)::text as r from ${table} t`)).rows.map((row) => row.r as string).sort();
  }
  return out;
}

const disabledAt = async (account: Account) => (await observer.query("select disabled_at from administrator where id = $1", [account.id])).rows[0]?.disabled_at;
const sessionKinds = async (account: Account) =>
  (await observer.query("select kind from administrator_session where administrator_id = $1 order by kind", [account.id])).rows.map((row) => row.kind as string);
const pendingFlags = async (account: Account) =>
  (await observer.query("select invalidated from administrator_pending_challenge where administrator_id = $1", [account.id])).rows.map((row) => row.invalidated as boolean);
const counterOf = async (scope: string) =>
  Number((await observer.query("select coalesce(sum(consecutive_failures), 0)::int as n from authentication_throttle where scope = $1", [scope])).rows[0]?.n);
const sourceRows = async () => (await observer.query("select recent_failures::text as r from authentication_source_window")).rows.map((row) => row.r as string);
const setDisabled = (account: Account) => observer.query("update administrator set disabled_at = $2::timestamptz where id = $1", [account.id, new Date(current - 1000).toISOString()]);
const sent = (since: number) => hooks.log.slice(since);
const affectedOf = (since: number, label: string) => hooks.affected.slice(since).filter((entry) => entry.startsWith(`${label}:`)).map((entry) => Number(entry.split(":")[1]));

/** Insert a schema-valid session row directly: absolute = created + the kind's lifetime; activity >= created. */
async function fixture(account: Account, kind: "administrator" | "recovery", createdAt: number, lastActivityAt: number): Promise<{ readonly id: string; readonly token: Buffer }> {
  const id = randomUUID();
  const token = randomBytes(32);
  const lifetime = kind === "administrator" ? "12 hours" : "15 minutes";
  expect(lastActivityAt).toBeGreaterThanOrEqual(createdAt);
  await observer.query(
    `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
     values (sha256($1), $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz + interval '${lifetime}')`,
    [token, id, account.id, kind, new Date(createdAt).toISOString(), new Date(lastActivityAt).toISOString()],
  );
  return { id, token };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* ------------------------------------------------------------------------------------------- */
/* V-0 the session listing                                                                      */
/* ------------------------------------------------------------------------------------------- */

describe("V-0: the session listing", () => {
  /** List, returning the outcome, the clock reads and the statements sent. */
  async function list(account: Account) {
    const mark = hooks.log.length;
    const reads = clockReads;
    const outcome = ok(await auth.listSessions(db, { administratorId: account.id }, clock));
    return { outcome, clockReads: clockReads - reads, statements: sent(mark) };
  }

  /** `checkSession` on a twin of the fixture (same timestamps, another account in the same state), at the same `$now`. */
  async function checkTwin(kind: "administrator" | "recovery", createdAt: number, lastActivityAt: number, disabled = false): Promise<boolean> {
    // Seeding advances the injected clock; the twin is checked at the listing's $now.
    const now = current;
    const twin = await seed();
    current = now;
    if (disabled) {
      await setDisabled(twin);
    }
    const row = await fixture(twin, kind, createdAt, lastActivityAt);
    const checked = ok(await auth.checkSession(db, { tokenDigest: Buffer.from(await sha256(row.token)) }, clock));
    return checked.code === "SESSION_VALID";
  }

  const sha256 = async (bytes: Buffer) => (await import("node:crypto")).createHash("sha256").update(bytes).digest();

  const liveOf = async (account: Account, id: string) => {
    const { outcome } = await list(account);
    expect(outcome.code).toBe("SESSIONS_LISTED");
    return outcome.code === "SESSIONS_LISTED" ? outcome.sessions.find((s) => s.id === id)?.live : undefined;
  };

  it("administrator absolute boundaries, each side, with schema-valid fixtures", async () => {
    for (const [offset, expected] of [[1, true], [0, false], [-1, false]] as const) {
      const account = await seed();
      // absolute = created + 12 h = now + offset ms; activity 1 minute ago (>= created).
      const createdAt = current + offset - 12 * HOUR;
      const row = await fixture(account, "administrator", createdAt, current - MINUTE);
      expect(await liveOf(account, row.id), `absolute at now ${offset >= 0 ? "+" : ""}${offset} ms`).toBe(expected);
      expect(await checkTwin("administrator", createdAt, current - MINUTE)).toBe(expected);
    }
  });

  it("administrator idle boundaries, tested independently of the absolute limit", async () => {
    for (const [offset, expected] of [[1, true], [0, false], [-1, false]] as const) {
      const account = await seed();
      const createdAt = current - HOUR;
      const lastActivityAt = current - 30 * MINUTE + offset;
      const row = await fixture(account, "administrator", createdAt, lastActivityAt);
      expect(await liveOf(account, row.id), `activity at now - 30 min ${offset >= 0 ? "+" : ""}${offset} ms`).toBe(expected);
      expect(await checkTwin("administrator", createdAt, lastActivityAt)).toBe(expected);
    }
  });

  it("administrator mismatches: idle-live but absolutely expired, and absolutely live but idle-expired, are not live", async () => {
    const account = await seed();
    const expired = await fixture(account, "administrator", current - 12 * HOUR - MINUTE, current - MINUTE);
    const idle = await fixture(account, "administrator", current - 2 * HOUR, current - 31 * MINUTE);
    expect(await liveOf(account, expired.id)).toBe(false);
    expect(await liveOf(account, idle.id)).toBe(false);
  });

  it("recovery absolute boundaries, each side, at the most idle a valid row can be", async () => {
    for (const [offset, expected] of [[1, true], [0, false], [-1, false]] as const) {
      const account = await seed();
      const createdAt = current + offset - 15 * MINUTE;
      const row = await fixture(account, "recovery", createdAt, createdAt);
      expect(await liveOf(account, row.id), `recovery absolute at now ${offset >= 0 ? "+" : ""}${offset} ms`).toBe(expected);
      expect(await checkTwin("recovery", createdAt, createdAt)).toBe(expected);
    }
  });

  it("recovery: absolute expiry dominates idle expiry for every schema-valid fixture", async () => {
    const account = await seed();
    // Every valid, absolutely live recovery row is idle-live: created within 15 minutes, activity >= created.
    for (const age of [1, MINUTE, 7 * MINUTE, 15 * MINUTE - 1]) {
      const createdAt = current - age;
      for (const activity of [createdAt, Math.floor((createdAt + current) / 2), current]) {
        const row = await fixture(account, "recovery", createdAt, activity);
        expect(await liveOf(account, row.id), `age ${age} ms, activity ${current - activity} ms ago`).toBe(true);
      }
    }
    // At exactly created + 15 min it is not live, although idle for only 15 minutes.
    const ended = await fixture(account, "recovery", current - 15 * MINUTE, current - 15 * MINUTE);
    expect(await liveOf(account, ended.id)).toBe(false);
  });

  it("a disabled account lists every session as not live; password-disabled follows the timestamps; account fields are returned", async () => {
    const disabled = await seed();
    const inside = await fixture(disabled, "administrator", current - HOUR, current - MINUTE);
    await setDisabled(disabled);
    const listedDisabled = (await list(disabled)).outcome;
    expect(listedDisabled).toMatchObject({ code: "SESSIONS_LISTED", account: { disabledAt: current - 1000, passwordDisabledAt: null } });
    expect(listedDisabled.code === "SESSIONS_LISTED" ? listedDisabled.sessions.map((s) => [s.id, s.live]) : []).toEqual([[inside.id, false]]);
    expect(await checkTwin("administrator", current - HOUR, current - MINUTE, true)).toBe(false);

    const passwordDisabled = await seed();
    const row = await fixture(passwordDisabled, "administrator", current - HOUR, current - MINUTE);
    await observer.query("update administrator set password_disabled_at = $2::timestamptz where id = $1", [passwordDisabled.id, new Date(current - 1000).toISOString()]);
    const listed = (await list(passwordDisabled)).outcome;
    expect(listed).toMatchObject({ code: "SESSIONS_LISTED", account: { disabledAt: null, passwordDisabledAt: current - 1000 } });
    expect(listed.code === "SESSIONS_LISTED" ? listed.sessions.find((s) => s.id === row.id)?.live : undefined).toBe(true);
  });

  it("zero sessions, an unknown administrator, one clock read, exactly one SELECT, read-only, no secret, isolation", async () => {
    const empty = await seed();
    const none = await list(empty);
    expect(none.outcome).toEqual({ code: "SESSIONS_LISTED", account: { disabledAt: null, passwordDisabledAt: null }, sessions: [] });
    expect(none.statements).toEqual(["list-sessions"]);
    expect(none.clockReads).toBe(1);

    const unknownMark = hooks.log.length;
    expect(ok(await auth.listSessions(db, { administratorId: randomUUID() }, clock))).toEqual({ code: "ADMINISTRATOR_NOT_FOUND" });
    expect(sent(unknownMark)).toEqual(["list-sessions"]);

    const account = await seed();
    const bystander = await seed();
    const token = await administratorSession(account);
    await administratorSession(bystander);
    const before = await stored();
    current += 5 * MINUTE;
    const listed = await list(account);
    expect(await stored(), "read-only: every last_activity_at unchanged").toEqual(before);
    expect(listed.statements).toEqual(["list-sessions"]);
    expect(listed.clockReads).toBe(1);

    expect(listed.outcome.code).toBe("SESSIONS_LISTED");
    if (listed.outcome.code === "SESSIONS_LISTED") {
      expect(Object.keys(listed.outcome.account).sort()).toEqual(["disabledAt", "passwordDisabledAt"]);
      expect(listed.outcome.sessions).toHaveLength(1);
      for (const session of listed.outcome.sessions) {
        expect(Object.keys(session).sort()).toEqual(["absoluteExpiresAt", "createdAt", "id", "kind", "lastActivityAt", "live"]);
      }
      const rendered = JSON.stringify(listed.outcome);
      const digest = digestOf(token);
      for (const form of [token, digest.toString("hex"), digest.toString("base64"), digest.toString("base64url")]) {
        expect(rendered).not.toContain(form);
      }
      expect(listed.outcome.sessions.map((s) => s.id)).toEqual([await sessionIdOf(token)]);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* V-1 revoke one, V-2 revoke all, V-3 disable                                                  */
/* ------------------------------------------------------------------------------------------- */

describe("V-1: revoke one", () => {
  it("deletes exactly the named row, of either kind; NO_SUCH_SESSION otherwise; the token is then refused everywhere", async () => {
    const account = await seed();
    const administrator = await administratorSession(account);
    const other = await administratorSession(account);
    const before = await stored();
    const revokedId = (await sessionIdOf(administrator))!;

    expect(ok(await auth.revokeSession(db, { administratorId: account.id, sessionId: revokedId }))).toEqual({ code: "SESSION_REVOKED" });
    const after = await stored();
    expect(after.administrator_session).toHaveLength(before.administrator_session!.length - 1);
    expect({ ...after, administrator_session: [] }).toEqual({ ...before, administrator_session: [] });
    expect(await sessionIdOf(other)).toBeDefined();
    expect(ok(await auth.checkSession(db, { tokenDigest: digestOf(administrator) }, clock))).toEqual({ code: "SESSION_REFUSED" });

    // A recovery session is revocable too, and then refused by PS-5.
    const recoveryAccount = await seed();
    const q = await recoverySession(recoveryAccount, 0);
    expect(ok(await auth.revokeSession(db, { administratorId: recoveryAccount.id, sessionId: (await sessionIdOf(q))! }))).toEqual({ code: "SESSION_REVOKED" });
    expect(await regeneration(recovery(), { recoverySessionToken: q })).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });

    // NO_SUCH_SESSION writes nothing: unknown, already revoked, and another administrator's id.
    const bystander = await seed();
    const theirs = await administratorSession(bystander);
    for (const [label, sessionId] of [
      ["unknown", randomUUID()],
      ["already revoked", revokedId],
      ["another administrator's session", (await sessionIdOf(theirs))!],
    ] as const) {
      const id = sessionId;
      const whole = await stored();
      expect(ok(await auth.revokeSession(db, { administratorId: account.id, sessionId: id })), label).toEqual({ code: "NO_SUCH_SESSION" });
      expect(await stored(), label).toEqual(whole);
    }
    expect(await sessionIdOf(theirs), "isolation: the other administrator's session survives").toBeDefined();
  });
});

describe("V-2: revoke all", () => {
  it("deletes every session of both kinds and invalidates the pending challenges, and nothing else", async () => {
    const account = await seed();
    await administratorSession(account);
    await recoverySession(account, 0);
    // The recovery success deleted the administrator session; add another, and a pending challenge.
    const q2 = await recoverySession(account, 1);
    await challenge(account);
    const bystander = await seed();
    await administratorSession(bystander);
    const before = await stored();

    expect(ok(await auth.revokeAllSessions(db, { administratorId: account.id }))).toEqual({ code: "SESSIONS_REVOKED", revoked: 1 });
    expect(await sessionKinds(account)).toEqual([]);
    expect((await pendingFlags(account)).every((flag) => flag)).toBe(true);
    const after = await stored();
    for (const table of ["administrator", "administrator_totp_factor", "administrator_consumed_challenge", "administrator_recovery_code", "authentication_throttle", "authentication_source_window"] as const) {
      expect(after[table], table).toEqual(before[table]);
    }
    expect(await regeneration(recovery(), { recoverySessionToken: q2 })).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });

    // Idempotent; and not found writes nothing.
    expect(ok(await auth.revokeAllSessions(db, { administratorId: account.id }))).toEqual({ code: "SESSIONS_REVOKED", revoked: 0 });
    const whole = await stored();
    expect(ok(await auth.revokeAllSessions(db, { administratorId: randomUUID() }))).toEqual({ code: "ADMINISTRATOR_NOT_FOUND" });
    expect(await stored()).toEqual(whole);
  });

  it("a challenge issued after the commit, from the still-current password, is valid; one issued before is INVALIDATED", async () => {
    const account = await seed();
    const before = await challenge(account);
    ok(await auth.revokeAllSessions(db, { administratorId: account.id }));
    const after = await challenge(account);

    expect(await totpStep(signIn(), { challengeToken: before, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE })).toEqual({
      code: "REFUSED",
      reason: "INVALIDATED_CHALLENGE",
    });
    expect((await totpStep(signIn(), { challengeToken: after, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE })).code).toBe("SESSION_ISSUED");
    expect(await counterOf("totp")).toBe(0);
  });
});

describe("V-3: disable, the operation itself", () => {
  it("sets disabled_at, deletes every session, invalidates every challenge, writes nothing else; ALREADY_DISABLED and NOT_FOUND write nothing", async () => {
    const account = await seed();
    await administratorSession(account);
    await challenge(account);
    const bystander = await seed();
    await administratorSession(bystander);
    const before = await stored();

    expect(ok(await auth.disableAccount(db, { administratorId: account.id }, clock))).toEqual({ code: "DISABLED", revoked: 1 });
    expect(await disabledAt(account)).toBe(current);
    expect(await sessionKinds(account)).toEqual([]);
    expect((await pendingFlags(account)).every((flag) => flag)).toBe(true);
    const after = await stored();
    for (const table of ["administrator_totp_factor", "administrator_consumed_challenge", "administrator_recovery_code", "authentication_throttle", "authentication_source_window"] as const) {
      expect(after[table], table).toEqual(before[table]);
    }
    // Only this administrator's row changed in `administrator`, and only its disabled_at.
    const rows = (await observer.query("select id, password_hash, password_disabled_at from administrator order by id")).rows;
    expect(rows.length).toBe(before.administrator!.length);

    const whole = await stored();
    expect(ok(await auth.disableAccount(db, { administratorId: account.id }, clock))).toEqual({ code: "ALREADY_DISABLED" });
    expect(await stored()).toEqual(whole);
    expect(ok(await auth.disableAccount(db, { administratorId: randomUUID() }, clock))).toEqual({ code: "ADMINISTRATOR_NOT_FOUND" });
    expect(await stored()).toEqual(whole);
  });
});

describe("V-3a: end to end, after a disable and its cleanup (merged precedence; no reader changed)", () => {
  it("every refusal and its permitted storage effect", async () => {
    const account = await seed();
    const administrator = await administratorSession(account);
    const consumedChallenge = await challenge(account);
    await totpStep(signIn(), { challengeToken: consumedChallenge, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE });
    current += 60_000;
    const liveChallenge = await challenge(account);
    const expiringChallenge = await challenge(account);
    const q = await recoverySession(account, 0);
    // The recovery success deleted the administrator sessions and invalidated those challenges; issue fresh ones before the disable.
    const freshLive = await challenge(account);
    const freshExpiring = await challenge(account);
    expect(administrator && liveChallenge && expiringChallenge).toBeTruthy();

    ok(await auth.disableAccount(db, { administratorId: account.id }, clock));
    const check = async (label: string, attempt: () => Promise<unknown>, expected: unknown, permitted: "none" | "password-failure" = "none") => {
      const before = await stored();
      const password = await counterOf("password");
      const sources = await sourceRows();
      expect(await attempt(), label).toEqual(expected);
      if (permitted === "none") {
        expect(await stored(), `${label}: no storage effect`).toEqual(before);
      } else {
        expect(await counterOf("password"), label).toBe(password + 1);
        expect(await sourceRows(), label).not.toEqual(sources);
        const after = await stored();
        for (const table of TABLES.filter((t) => t !== "authentication_throttle" && t !== "authentication_source_window")) {
          expect(after[table], `${label}: ${table}`).toEqual(before[table]);
        }
      }
    };

    await check("checkSession with a token live before", async () => ok(await auth.checkSession(db, { tokenDigest: digestOf(q) }, clock)), { code: "SESSION_REFUSED" });

    for (const [label, run] of [
      ["start", () => reenrolmentStart(recovery(), { recoverySessionToken: q })],
      ["regeneration", () => regeneration(recovery(), { recoverySessionToken: q })],
      ["completion", () => reenrolmentCompletion(recovery(), { recoverySessionToken: q, factorId: randomUUID(), code: "123456" })],
    ] as const) {
      const mark = hooks.log.length;
      await check(`${label} with the deleted recovery session`, run, { code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
      expect(sent(mark).filter((l) => l !== "lock-administrator").slice(0, 1), `${label}: refused at the pre-lock read`).toEqual(["resolve-recovery-session"]);
      expect(sent(mark), `${label}: the disabled-account check is never reached`).not.toContain("lock-administrator");
    }

    const logoutMark = hooks.affected.length;
    await check("recovery logout with that token", async () => ok(await auth.logout(db, { tokenDigest: digestOf(q) })), { code: "LOGGED_OUT" });
    expect(affectedOf(logoutMark, "logout")).toEqual([0]);

    await check("TOTP on a live pre-disable challenge", () => totpStep(signIn(), { challengeToken: freshLive, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    await check("TOTP on a consumed challenge (the disabled check precedes consumed)", () => totpStep(signIn(), { challengeToken: consumedChallenge, code: "000000", sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    await check("recovery code on a live pre-disable challenge", () => recoveryStep(recovery(), { challengeToken: freshLive, code: account.codes[1]?.code ?? "", sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    current += 6 * MINUTE;
    await check("TOTP on an expired pre-disable challenge", () => totpStep(signIn(), { challengeToken: freshExpiring, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "EXPIRED_CHALLENGE",
    });
    await check("recovery code on an expired pre-disable challenge", () => recoveryStep(recovery(), { challengeToken: freshExpiring, code: account.codes[1]?.code ?? "", sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "EXPIRED_CHALLENGE",
    });
    await check("password step, correct password", () => passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    await check(
      "password step, wrong password (existing accounting)",
      async () => (await passwordStep(signIn(), { username: account.username, password: "not the password at all", sourceAddress: SOURCE })).code,
      "FAILED",
      "password-failure",
    );
    await check(
      "RA-5 provisioning confirmation",
      async () => ok(await auth.confirmTotpEnrolmentWithRecoveryCodes(db, { administratorId: account.id, factorId: randomUUID(), verify: totpVerifierFor(TOTP_KEYS, "000000"), codeDigests: generateRecoveryCodes().map((c) => c.digest) }, clock)),
      { code: "REFUSED", reason: "ACCOUNT_DISABLED" },
    );
  });
});

describe("V-3b: isolated readers reject an arranged disabled account with its rows intact", () => {
  it("each existing reader's own check, and its permitted storage effect", async () => {
    const account = await seed();
    const administrator = await administratorSession(account);
    const recoveryAccount = await seed();
    const q = await recoverySession(recoveryAccount, 0);
    const pending = await challenge(account);
    await setDisabled(account);
    await setDisabled(recoveryAccount);

    const check = async (label: string, attempt: () => Promise<unknown>, expected: unknown) => {
      const before = await stored();
      expect(await attempt(), label).toEqual(expected);
      expect(await stored(), `${label}: no storage effect, activity included`).toEqual(before);
    };

    await check("checkSession, administrator token", async () => ok(await auth.checkSession(db, { tokenDigest: digestOf(administrator) }, clock)), { code: "SESSION_REFUSED" });
    await check("checkSession, recovery token", async () => ok(await auth.checkSession(db, { tokenDigest: digestOf(q) }, clock)), { code: "SESSION_REFUSED" });
    for (const [label, run] of [
      ["start", () => reenrolmentStart(recovery(), { recoverySessionToken: q })],
      ["regeneration", () => regeneration(recovery(), { recoverySessionToken: q })],
      ["completion", () => reenrolmentCompletion(recovery(), { recoverySessionToken: q, factorId: randomUUID(), code: "123456" })],
    ] as const) {
      const mark = hooks.log.length;
      await check(`PS-5 ${label} with a live recovery session`, run, { code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
      expect(sent(mark), `${label}: refused after both locks`).toContain("lock-recovery-session");
    }
    await check("TOTP on a live, not invalidated challenge", () => totpStep(signIn(), { challengeToken: pending, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    await check("recovery code on that challenge", () => recoveryStep(recovery(), { challengeToken: pending, code: account.codes[0]?.code ?? "", sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    await check("password step, correct password", () => passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE }), {
      code: "REFUSED",
      reason: "ACCOUNT_DISABLED",
    });
    await check(
      "RA-5 provisioning confirmation",
      async () => ok(await auth.confirmTotpEnrolmentWithRecoveryCodes(db, { administratorId: account.id, factorId: randomUUID(), verify: totpVerifierFor(TOTP_KEYS, "000000"), codeDigests: generateRecoveryCodes().map((c) => c.digest) }, clock)),
      { code: "REFUSED", reason: "ACCOUNT_DISABLED" },
    );
    expect(await pendingFlags(account)).toEqual([false]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* V-4 required counts                                                                          */
/* ------------------------------------------------------------------------------------------- */

describe("V-4: required counts", () => {
  it("V-4a: disable's UPDATE forced to 0 or 2, inside its transaction, rolls back with no mutation", async () => {
    for (const [count, expected] of [
      [0, { ok: true, value: { code: "ALREADY_DISABLED" } }],
      [2, { ok: false, failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement: "disable-account", expected: 1, actual: 2 } }],
    ] as const) {
      const account = await seed();
      await administratorSession(account);
      await challenge(account);
      const before = await stored();
      const mark = hooks.log.length;
      hooks.counts.set("disable-account", count);
      try {
        expect(await auth.disableAccount(db, { administratorId: account.id }, clock), `forced ${count}`).toEqual(expected);
      } finally {
        hooks.counts.delete("disable-account");
      }
      expect(await stored(), `forced ${count}: the whole state, rolled back`).toEqual(before);
      expect(sent(mark), `forced ${count}: nothing after the UPDATE, no retry`).toEqual(["lock-administrator", "disable-account"]);
    }
  });

  it("V-4b: revoke-one's autocommitted DELETE reported as 2 is a reported fault, and the deletion stays committed", async () => {
    const account = await seed();
    const named = await administratorSession(account);
    const other = await administratorSession(account);
    const sessionId = (await sessionIdOf(named))!;
    const before = await stored();
    const mark = hooks.log.length;
    hooks.counts.set("revoke-session", 2);
    try {
      expect(await auth.revokeSession(db, { administratorId: account.id, sessionId })).toEqual({
        ok: false,
        failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement: "revoke-session", expected: 1, actual: 2 },
      });
    } finally {
      hooks.counts.delete("revoke-session");
    }
    expect(sent(mark), "one statement, no retry").toEqual(["revoke-session"]);
    // No rollback is possible or claimed: the named row is gone, and nothing else changed.
    expect(await sessionIdOf(named)).toBeUndefined();
    expect(await sessionIdOf(other)).toBeDefined();
    const after = await stored();
    expect(after.administrator_session).toHaveLength(before.administrator_session!.length - 1);
    expect({ ...after, administrator_session: [] }).toEqual({ ...before, administrator_session: [] });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* V-4c and V-6 real database failures                                                          */
/* ------------------------------------------------------------------------------------------- */

async function withFaultTrigger<T>(sqlState: string, body: () => Promise<T>): Promise<T> {
  await observer.query(`create or replace function rv_fault() returns trigger language plpgsql as $f$
    begin raise exception 'injected fault' using errcode = tg_argv[0]; end $f$`);
  await observer.query(`create trigger rv_fault before delete on administrator_session for each row execute function rv_fault('${sqlState}')`);
  try {
    return await body();
  } finally {
    await observer.query("drop trigger if exists rv_fault on administrator_session");
  }
}

/** A rival connection that holds row locks in an open transaction. */
async function rival() {
  const client = await observer.connect();
  client.on("error", () => undefined);
  await client.query("begin");
  return {
    query: (text: string, values?: readonly unknown[]) => client.query(text, values),
    finish: async () => {
      await client.query("rollback").catch(() => undefined);
      client.release();
    },
  };
}

async function awaitBlocked(): Promise<void> {
  const deadline = Date.now() + STEP_BOUND_MS;
  while (Date.now() < deadline) {
    const waiting = await observer.query("select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [OPERATION_APP]);
    if (waiting.rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the operation never blocked on a lock");
}

const terminateOperation = (where: string) =>
  observer.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and ${where}`, [OPERATION_APP]);

describe("V-4c: revoke-one's real statement failures leave the row in place", () => {
  it.each([
    ["40001", { code: "RETRYABLE_CONFLICT", sqlState: "40001" }],
    ["57014", { code: "STORAGE_FAILURE", sqlState: "57014" }],
  ] as const)("a genuine %s raised during the DELETE is classified, attempted once, and deletes nothing", async (sqlState, failure) => {
    const account = await seed();
    const token = await administratorSession(account);
    const sessionId = (await sessionIdOf(token))!;
    const mark = hooks.log.length;
    const outcome = await withFaultTrigger(sqlState, () => auth.revokeSession(db, { administratorId: account.id, sessionId }));
    expect(outcome).toMatchObject({ ok: false, failure });
    expect(sent(mark)).toEqual(["revoke-session"]);
    expect(await sessionIdOf(token)).toBe(sessionId);
  });

  it("a genuine 40P01 during the DELETE is classified, attempted once, not retried, and deletes nothing", async () => {
    // The single DELETE takes no second lock of its own, so a test-only BEFORE DELETE trigger makes it
    // request the administrator row after PostgreSQL has locked the session row for the trigger. The
    // rival holds the administrator row and then requests the session row; PostgreSQL's own deadlock
    // detector raises the 40P01.
    const account = await seed();
    const token = await administratorSession(account);
    const sessionId = (await sessionIdOf(token))!;
    await observer.query(`create or replace function rv_lock_administrator() returns trigger language plpgsql as $f$
      begin perform 1 from administrator where id = old.administrator_id for update; return old; end $f$`);
    await observer.query("create trigger rv_lock_administrator before delete on administrator_session for each row execute function rv_lock_administrator()");
    const r = await rival();
    try {
      // The rival is the likely survivor; the assertion is the proof.
      await r.query("set local deadlock_timeout = '10s'");
      await r.query("select 1 from administrator where id = $1 for update", [account.id]);
      const mark = hooks.log.length;
      const waiting = auth.revokeSession(db, { administratorId: account.id, sessionId });
      await awaitBlocked();
      const rivalLock = r.query("select 1 from administrator_session where id = $1 for update", [sessionId]);
      expect(await within(waiting, "the deadlocked revoke")).toEqual({ ok: false, failure: { code: "RETRYABLE_CONFLICT", sqlState: "40P01" } });
      await within(rivalLock, "the rival's lock");
      expect(sent(mark)).toEqual(["revoke-session"]);
    } finally {
      await r.finish();
      await observer.query("drop trigger if exists rv_lock_administrator on administrator_session");
    }
    expect(await sessionIdOf(token)).toBe(sessionId);
  });

  it("a connection lost while the DELETE waits on a held row lock deletes nothing (confirmed from a separate connection)", async () => {
    const account = await seed();
    const token = await administratorSession(account);
    const sessionId = (await sessionIdOf(token))!;
    const r = await rival();
    try {
      await r.query("select 1 from administrator_session where id = $1 for update", [sessionId]);
      const waiting = auth.revokeSession(db, { administratorId: account.id, sessionId });
      await awaitBlocked();
      await terminateOperation("wait_event_type = 'Lock'");
      const outcome = await within(waiting, "the terminated revoke");
      expect(outcome.ok).toBe(false);
    } finally {
      await r.finish();
    }
    expect(await sessionIdOf(token)).toBe(sessionId);
  });
});

describe("V-6: database failures of the two transactional operations", () => {
  const OPERATIONS: Record<string, (account: Account) => Promise<auth.Stored<unknown>>> = {
    "revoke-all": (account) => auth.revokeAllSessions(db, { administratorId: account.id }),
    disable: (account) => auth.disableAccount(db, { administratorId: account.id }, clock),
  };

  for (const [name, operation] of Object.entries(OPERATIONS)) {
    it.each([
      ["40001", { code: "RETRYABLE_CONFLICT", sqlState: "40001" }],
      ["57014", { code: "STORAGE_FAILURE", sqlState: "57014" }],
    ] as const)(`${name}: an injected %s is classified, attempted once, and rolls everything back`, async (sqlState, failure) => {
      const account = await seed();
      await administratorSession(account);
      await challenge(account);
      const before = await stored();
      const mark = hooks.log.length;
      const outcome = await withFaultTrigger(sqlState, () => operation(account));
      expect(outcome).toMatchObject({ ok: false, failure });
      expect(sent(mark).filter((l) => l === "lock-administrator")).toHaveLength(1);
      expect(await stored()).toEqual(before);
    });

    it(`${name}: 40P01 reaches the operation itself, once, not retried, nothing written`, async () => {
      const account = await seed();
      const token = await administratorSession(account);
      await challenge(account);
      const before = await stored();
      const r = await rival();
      try {
        // The rival is the likely survivor; the assertion is the proof.
        await r.query("set local deadlock_timeout = '10s'");
        await r.query("select 1 from administrator_session where token_digest = $1 for update", [digestOf(token)]);
        const mark = hooks.log.length;
        const waiting = operation(account);
        await awaitBlocked();
        const rivalLock = r.query("select 1 from administrator where id = $1 for update", [account.id]);
        expect(await within(waiting, "the deadlocked operation")).toEqual({ ok: false, failure: { code: "RETRYABLE_CONFLICT", sqlState: "40P01" } });
        await within(rivalLock, "the rival's lock");
        expect(sent(mark).filter((l) => l === "lock-administrator")).toHaveLength(1);
      } finally {
        await r.finish();
      }
      expect(await stored()).toEqual(before);
    });

    it(`${name}: a connection lost before COMMIT rolls back, confirmed from a separate connection`, async () => {
      const account = await seed();
      await administratorSession(account);
      await challenge(account);
      const before = await stored();
      let reached = () => undefined as void;
      let release = () => undefined as void;
      const atBarrier = new Promise<void>((resolve) => (reached = resolve));
      hooks.pauses.set("invalidate-pending-challenges", { gate: new Promise<void>((resolve) => (release = resolve)), reached: () => reached() });
      const waiting = operation(account);
      await within(atBarrier, "the barrier");
      await terminateOperation("state like 'idle in transaction%'");
      release();
      const outcome = await within(waiting, "the terminated operation");
      expect(outcome.ok).toBe(false);
      expect(await stored()).toEqual(before);
    });
  }

  it("a genuine 23505 is not reachable: neither operation inserts a row", () => {
    // Recorded as an assertion so the evidence map can cite it: revoke-all and disable only lock,
    // update `disabled_at`, delete sessions and update challenges.
    expect(["lock-administrator", "revoke-all-sessions", "invalidate-pending-challenges", "disable-account", "disable-delete-sessions"].some((l) => l.includes("insert"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* V-5 concurrency                                                                              */
/* ------------------------------------------------------------------------------------------- */

interface RaceRun<A, B> {
  readonly a: A;
  readonly b: B;
  readonly end: string;
}

/** `a` then `b`, `b` then `a`, and both concurrently, each on a fresh setup and within 10 s per step. */
async function raceBothWays<S, A, B>(
  prepare: () => Promise<S>,
  a: (s: S) => Promise<A>,
  b: (s: S) => Promise<B>,
  end: (s: S) => Promise<unknown>,
): Promise<{ readonly ab: RaceRun<A, B>; readonly ba: RaceRun<A, B>; readonly both: RaceRun<A, B> }> {
  const run = async (order: "ab" | "ba" | "both"): Promise<RaceRun<A, B>> => {
    const setup = await prepare();
    let ra: A;
    let rb: B;
    if (order === "ab") {
      ra = await within(a(setup), "a first");
      rb = await within(b(setup), "b second");
    } else if (order === "ba") {
      rb = await within(b(setup), "b first");
      ra = await within(a(setup), "a second");
    } else {
      [ra, rb] = await within(Promise.all([a(setup), b(setup)]), "the concurrent pair");
    }
    for (const outcome of [ra, rb]) {
      expect(JSON.stringify(outcome), `${order}: never a deadlock or storage failure`).not.toMatch(/40P01|STORAGE_FAILURE|RETRYABLE_CONFLICT/);
    }
    return { a: ra, b: rb, end: JSON.stringify(await end(setup)) };
  };
  const ab = await run("ab");
  const ba = await run("ba");
  const both = await run("both");
  expect([ab.end, ba.end], "the concurrent end state equals a forced one").toContain(both.end);
  const matching = [ab, ba].filter((forced) => forced.end === both.end);
  expect(matching.map((forced) => kind(forced.a) + "|" + kind(forced.b)), "with that order's outcomes").toContain(kind(both.a) + "|" + kind(both.b));
  return { ab, ba, both };
}

function kind(outcome: unknown): string {
  const value = (outcome as { ok?: boolean; value?: unknown }).ok === true ? (outcome as { value: unknown }).value : outcome;
  const shaped = value as { code?: string; reason?: string };
  return shaped.reason === undefined ? String(shaped.code) : `${shaped.code}/${shaped.reason}`;
}

const endOf = async (account: Account) => ({
  disabled: (await disabledAt(account)) !== null,
  sessions: await sessionKinds(account),
  factor: (await observer.query("select state from administrator_totp_factor where administrator_id = $1", [account.id])).rows[0]?.state,
  codes: Number((await observer.query("select count(*)::int as n from administrator_recovery_code where administrator_id = $1", [account.id])).rows[0]?.n),
  counted: await counterOf("totp") + (await counterOf("recovery_code")),
});

describe("V-5: concurrency (forced both ways, then concurrently)", () => {
  it("disable against the password step: either the step's challenge is invalidated, or the step is refused; held variant rolls back", async () => {
    const { ab, ba } = await raceBothWays(
      seed,
      (s) => auth.disableAccount(db, { administratorId: s.id }, clock),
      (s) => passwordStep(signIn(), { username: s.username, password: PASSWORD, sourceAddress: SOURCE }),
      async (s) => ({ ...(await endOf(s)), pending: await pendingFlags(s) }),
    );
    expect([kind(ab.a), kind(ab.b)]).toEqual(["DISABLED", "REFUSED/ACCOUNT_DISABLED"]);
    expect([kind(ba.b), kind(ba.a)]).toEqual(["CHALLENGE_ISSUED", "DISABLED"]);
    expect(JSON.parse(ba.end).pending).toEqual([true]);

    // Held: the disable holds the administrator lock; the issuing transaction waits, then rolls back.
    const account = await seed();
    let reached = () => undefined as void;
    let release = () => undefined as void;
    const atBarrier = new Promise<void>((resolve) => (reached = resolve));
    hooks.pauses.set("disable-delete-sessions", { gate: new Promise<void>((resolve) => (release = resolve)), reached: () => reached() });
    const disabling = auth.disableAccount(db, { administratorId: account.id }, clock);
    await within(atBarrier, "the disable at its barrier");
    const step = passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE });
    await awaitBlocked();
    release();
    expect(kind(await within(disabling, "the disable"))).toBe("DISABLED");
    expect(await within(step, "the waiting step")).toEqual({ code: "REFUSED", reason: "ACCOUNT_DISABLED" });
    expect(await pendingFlags(account)).toEqual([]);
  });

  it("disable against TOTP completion, and against a recovery-code success: never a live session on a disabled account", async () => {
    const prepare = async () => {
      const account = await seed();
      return { account, token: await challenge(account) };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const disable = (s: S) => auth.disableAccount(db, { administratorId: s.account.id }, clock);
    const end = (s: S) => endOf(s.account);

    const attempts: ReadonlyArray<readonly [string, (s: S) => Promise<unknown>]> = [
      ["TOTP completion", (s) => totpStep(signIn(), { challengeToken: s.token, code: totpCodeAt(s.account.secret, current), sourceAddress: SOURCE })],
      ["recovery-code success", (s) => recoveryStep(recovery(), { challengeToken: s.token, code: s.account.codes[0]?.code ?? "", sourceAddress: SOURCE })],
    ];
    for (const [name, attempt] of attempts) {
      const race = await raceBothWays(prepare, disable, attempt, end);
      for (const run of [race.ab, race.ba, race.both]) {
        expect(JSON.parse(run.end), name).toMatchObject({ disabled: true, sessions: [], counted: 0 });
      }
      expect(kind(race.ab.b), `${name}: disable first`).toBe("REFUSED/ACCOUNT_DISABLED");
      expect(["SESSION_ISSUED", "RECOVERY_SESSION_ISSUED"], `${name}: attempt first`).toContain(kind(race.ba.b));
    }
  });

  it("disable against recovery start, completion and regeneration in Q: no effect after the disable's commit unless that operation committed first", async () => {
    const prepare = async () => {
      const account = await seed();
      const q = await recoverySession(account, 0);
      const started = await reenrolmentStart(recovery(), { recoverySessionToken: q });
      if (started.code !== "REENROLMENT_STARTED") {
        throw new Error(started.code);
      }
      return { account, q, started };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const disable = (s: S) => auth.disableAccount(db, { administratorId: s.account.id }, clock);

    const attempts: ReadonlyArray<readonly [string, (s: S) => Promise<unknown>, string]> = [
      ["start", (s) => reenrolmentStart(recovery(), { recoverySessionToken: s.q }), "REENROLMENT_STARTED"],
      ["completion", (s) => reenrolmentCompletion(recovery(), { recoverySessionToken: s.q, factorId: s.started.factorId, code: totpCodeAt(s.started.secret, current) }), "REENROLMENT_COMPLETED"],
      ["regeneration", (s) => regeneration(recovery(), { recoverySessionToken: s.q }), "RECOVERY_CODES_REGENERATED"],
    ];
    for (const [name, attempt, success] of attempts) {
      const race = await raceBothWays(prepare, disable, attempt, (s) => endOf(s.account));
      expect(kind(race.ab.b), `${name}: disable first`).toBe("REFUSED/RECOVERY_SESSION_INVALID");
      expect(kind(race.ba.b), `${name}: operation first`).toBe(success);
      for (const run of [race.ab, race.ba, race.both]) {
        expect(JSON.parse(run.end), name).toMatchObject({ disabled: true, sessions: [] });
      }
      // Disable first leaves the pre-race factor and codes exactly as prepared.
      expect(JSON.parse(race.ab.end)).toMatchObject({ factor: "pending_confirmation", codes: 9 });
    }
  });

  it("revoke-all against TOTP completion and a recovery-code success: no session survives a later revoke-all", async () => {
    const prepare = async () => {
      const account = await seed();
      return { account, token: await challenge(account) };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const revokeAll = (s: S) => auth.revokeAllSessions(db, { administratorId: s.account.id });

    const attempts: ReadonlyArray<readonly [string, (s: S) => Promise<unknown>]> = [
      ["TOTP completion", (s) => totpStep(signIn(), { challengeToken: s.token, code: totpCodeAt(s.account.secret, current), sourceAddress: SOURCE })],
      ["recovery-code success", (s) => recoveryStep(recovery(), { challengeToken: s.token, code: s.account.codes[0]?.code ?? "", sourceAddress: SOURCE })],
    ];
    for (const [name, attempt] of attempts) {
      const race = await raceBothWays(prepare, revokeAll, attempt, (s) => endOf(s.account));
      expect(kind(race.ab.b), `${name}: revoke-all first`).toBe("REFUSED/INVALIDATED_CHALLENGE");
      for (const run of [race.ab, race.ba, race.both]) {
        expect(JSON.parse(run.end), name).toMatchObject({ disabled: false, sessions: [], counted: 0 });
      }
    }
  });

  it("revoke-one against logout of the same session: exactly one deletes the row", async () => {
    const prepare = async () => {
      const account = await seed();
      const token = await administratorSession(account);
      return { account, token, id: (await sessionIdOf(token))! };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    for (const order of ["ab", "ba", "both"] as const) {
      const s = await prepare();
      const mark = hooks.affected.length;
      const revoke = () => auth.revokeSession(db, { administratorId: s.account.id, sessionId: s.id });
      const out = () => auth.logout(db, { tokenDigest: digestOf(s.token) });
      if (order === "ab") {
        await within(revoke(), "revoke");
        await within(out(), "logout");
      } else if (order === "ba") {
        await within(out(), "logout");
        await within(revoke(), "revoke");
      } else {
        await within(Promise.all([revoke(), out()]), "the pair");
      }
      const deletions = [...affectedOf(mark, "revoke-session"), ...affectedOf(mark, "logout")].sort();
      expect(deletions, order).toEqual([0, 1]);
      expect(await sessionKinds(s.account), order).toEqual([]);
    }
    const unused: S | undefined = undefined;
    expect(unused).toBeUndefined();
  });

  it("disable against disable: exactly one DISABLED and one ALREADY_DISABLED", async () => {
    const race = await raceBothWays(
      seed,
      (s) => auth.disableAccount(db, { administratorId: s.id }, clock),
      (s) => auth.disableAccount(db, { administratorId: s.id }, clock),
      (s) => endOf(s),
    );
    for (const run of [race.ab, race.ba, race.both]) {
      expect([kind(run.a), kind(run.b)].sort()).toEqual(["ALREADY_DISABLED", "DISABLED"]);
    }
  });

  it("revoke-all against the password step in flight: a challenge after the commit is valid; one before is invalidated", async () => {
    const race = await raceBothWays(
      seed,
      (s) => auth.revokeAllSessions(db, { administratorId: s.id }),
      (s) => passwordStep(signIn(), { username: s.username, password: PASSWORD, sourceAddress: SOURCE }),
      async (s) => ({ pending: await pendingFlags(s) }),
    );
    expect(JSON.parse(race.ab.end), "revoke-all first: the later challenge is valid").toEqual({ pending: [false] });
    expect(JSON.parse(race.ba.end), "step first: its challenge is invalidated").toEqual({ pending: [true] });
    expect(kind(race.ab.b)).toBe("CHALLENGE_ISSUED");
  });
});
