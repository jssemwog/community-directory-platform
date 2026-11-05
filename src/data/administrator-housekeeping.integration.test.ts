/**
 * Attacking tests for housekeeping's storage (Unit HK Scope Gate, revision 4, issue #274, §6.1
 * HK-1 to HK-10): `removeExpiredAuthenticationRows`, against a real PostgreSQL from
 * `embedded-postgres`, in one disposable cluster, with an injected clock.
 *
 * - **Statement observer:** the operation's pool records every statement it sends (its `adr028:`
 *   label, or its first word), the error a labelled statement failed with, and can make one
 *   labelled statement throw **after** the server executed it (a lost acknowledgement, HK-10(b)).
 * - **Fixtures are schema-valid:** each row is inserted with migration `003`'s constraints enforced,
 *   so a lifetime or activity combination the schema refuses can never be tested by mistake.
 * - **Isolation:** housekeeping deletes globally, so every test starts with the three cleaned
 *   tables and the abuse-control tables empty; counts are then exact.
 * - **No timing claim** is made anywhere (#246 / `BI-4` pending).
 */

import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as auth from "./administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "./administrator-authentication-table";
import { startupOptionsFor } from "./connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import { HashLimiter } from "../domain/administrator-auth/hash-limiter";
import { generateRecoveryCodes, type GeneratedRecoveryCode } from "../domain/administrator-auth/recovery-code";
import { reenrolmentCompletion, reenrolmentStart, recoveryStep, type RecoveryDependencies } from "../domain/administrator-auth/recovery";
import { sealTotpSecret } from "../domain/administrator-auth/secret-box";
import { passwordStep, totpStep, totpVerifierFor, type SignInDependencies } from "../domain/administrator-auth/sign-in";
import { generateToken, tokenDigest } from "../domain/administrator-auth/token";
import { generateTotpSecret, totpCodeAt } from "../domain/administrator-auth/totp";
import { DEFAULT_FACTORIES, resetAdministratorRuntimeForTests } from "../interface/admin/authentication-runtime";
import { codeEntry, FAILURE_LOCATION, type EntryOptions } from "../interface/admin/entry-points";
import { LOCAL_ADMIN_ORIGIN, LOCAL_ADMIN_THROTTLE_KEY, LOCAL_ADMIN_TOTP_KEY_V1 } from "../interface/admin/local-gate";
import { recoveryCodeEntry } from "../interface/admin/recovery-entry-points";
import { LOCAL_DEMO_DATABASE_URL } from "../interface/public/local-demo-persistence";

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

const pg = createRequire(import.meta.url)("pg") as {
  Pool: new (config: Record<string, unknown>) => PgPool;
  DatabaseError: abstract new (...args: never[]) => Error;
};

const DATABASE = "admin_housekeeping";
const cluster = useEmbeddedPostgres({ slug: "admin-housekeeping", databases: [DATABASE], migrate: [DATABASE] });

const OPERATION_APPLICATION = "hk_operation";
const BOUND_MS = 10_000;
const PASSWORD = "a synthetic local password for housekeeping tests";
const SOURCE = "local-loopback";
const ORIGIN = "https://127.0.0.1:3000";
const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);
const DUMMY_HASH = "scrypt$ln=17,r=8,p=1$ZHVtbXktc2FsdA$ZHVtbXkta2V5";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const PENDING = "housekeeping-pending-challenges";
const CONSUMED = "housekeeping-consumed-challenges";
const SESSIONS = "housekeeping-sessions";

/** Stub hashes stand in for scrypt: each maps to the plaintext it verifies. */
const PLAINTEXT = new Map<string, string>();
const hashFor = (password: string) => {
  const hash = `scrypt$ln=17,r=8,p=1$${randomBytes(12).toString("base64")}$${randomBytes(12).toString("base64")}`;
  PLAINTEXT.set(hash, password);
  return hash;
};

let current = Date.UTC(2026, 10, 5, 12, 0, 0);
const clock: auth.Clock = () => current;

interface Hooks {
  /** Every statement sent: its `adr028:` label, or its lower-cased first word. */
  readonly log: string[];
  /** The error each labelled statement failed with. */
  readonly errors: Map<string, unknown>;
  /** Whether the same connection answered `select 1` after a labelled statement failed. */
  readonly usableAfter: Map<string, boolean>;
  /** One labelled statement that executes, then throws as if its acknowledgement were lost. */
  lostAcknowledgement: string | undefined;
  /** One labelled statement whose result loses its `command`, so Kysely reports no row count. */
  withoutCount: string | undefined;
}

const hooks: Hooks = { log: [], errors: new Map(), usableAfter: new Map(), lostAcknowledgement: undefined, withoutCount: undefined };
const broken = new WeakSet<PgClient>();
let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;
let rivals: PgPool;
let environment: Record<string, string>;
const entryLines: string[] = [];

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

beforeAll(async () => {
  const pool = createPool(OPERATION_APPLICATION, 4);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          const label = labelOf(text);
          hooks.log.push(label ?? text.trim().split(/\s+/)[0]!.toLowerCase());

          let result: PgResult;
          try {
            result = await client.query(text, values);
          } catch (cause) {
            const code = (cause as { code?: string }).code;
            if (code === undefined || code.startsWith("57P") || code.startsWith("08")) {
              broken.add(client);
            }
            if (label !== undefined) {
              hooks.errors.set(label, cause);
              hooks.usableAfter.set(label, broken.has(client) ? false : await client.query("select 1").then(() => true, () => false));
            }
            throw cause;
          }

          if (label !== undefined && hooks.lostAcknowledgement === label) {
            hooks.lostAcknowledgement = undefined;
            throw new Error("acknowledgement lost (injected after the statement executed)");
          }

          if (label !== undefined && hooks.withoutCount === label) {
            return { ...result, command: undefined };
          }

          return result;
        },
        release: (destroy?: boolean | Error) => client.release(broken.has(client) ? true : destroy),
      };
    },
    end: () => pool.end(),
  };
  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
  observer = createPool("hk_observer", 4);
  rivals = createPool("hk_rival", 4);
  environment = {
    NODE_ENV: "development",
    [LOCAL_DEMO_DATABASE_URL]: cluster.connectionStringFor(DATABASE),
    [LOCAL_ADMIN_ORIGIN]: ORIGIN,
    [LOCAL_ADMIN_TOTP_KEY_V1]: TOTP_KEY.toString("base64url"),
    [LOCAL_ADMIN_THROTTLE_KEY]: THROTTLE_KEY.toString("base64url"),
  };
  await resetAdministratorRuntimeForTests();
  cluster.closeBeforeShutdown("housekeeping operations", () => db.destroy());
  cluster.closeBeforeShutdown("housekeeping observer", () => observer.end());
  cluster.closeBeforeShutdown("housekeeping rivals", () => rivals.end());
  cluster.closeBeforeShutdown("housekeeping runtime", () => resetAdministratorRuntimeForTests());
}, CLUSTER_TIMEOUT_MS);

beforeEach(async () => {
  hooks.errors.clear();
  hooks.usableAfter.clear();
  hooks.lostAcknowledgement = undefined;
  hooks.withoutCount = undefined;
  entryLines.length = 0;
  for (const table of ["administrator_session", "administrator_pending_challenge", "administrator_consumed_challenge", "authentication_throttle", "authentication_source_window"]) {
    await observer.query(`delete from ${table}`);
  }
});

afterAll(async () => {
  await observer.query("drop trigger if exists hk_test_abort on administrator_consumed_challenge");
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
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish within ${BOUND_MS} ms`)), BOUND_MS)),
  ]);
}

const housekeep = (at: number = current) => within(auth.removeExpiredAuthenticationRows(db, () => at), "housekeeping");

const signIn = (): SignInDependencies => ({
  db,
  clock,
  limiter: new HashLimiter(),
  passwords: { verify: async (password: string, storedHash: string) => PLAINTEXT.get(storedHash) === password },
  dummyPasswordHash: DUMMY_HASH,
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

/** A provisioned, confirmed account with ten codes (RA-5), through the real storage operations. */
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
  current += MINUTE;
  return { id, username, secret, codes };
}

const iso = (epochMilliseconds: number) => new Date(epochMilliseconds).toISOString();

/** A pending challenge created at `createdAt`; its expiry is fixed by the lifetime check. */
async function insertPending(account: Account, createdAt: number, invalidated = false): Promise<string> {
  const { token, digest } = generateToken();
  await observer.query(
    "insert into administrator_pending_challenge (token_digest, administrator_id, created_at, expires_at, invalidated) values ($1, $2, $3::timestamptz, $3::timestamptz + interval '5 minutes', $4)",
    [digest, account.id, iso(createdAt), invalidated],
  );
  return token;
}

/** A consumed-challenge record with the original expiry `expiresAt` (no lifetime constraint). */
async function insertConsumed(account: Account, expiresAt: number): Promise<string> {
  const { token, digest } = generateToken();
  await observer.query("insert into administrator_consumed_challenge (token_digest, administrator_id, expires_at) values ($1, $2, $3::timestamptz)", [digest, account.id, iso(expiresAt)]);
  return token;
}

/** A session created at `createdAt`; its absolute expiry is fixed by the lifetime check. */
async function insertSession(account: Account, kind: "administrator" | "recovery", createdAt: number, lastActivityAt: number): Promise<{ readonly id: string; readonly token: string }> {
  const { token, digest } = generateToken();
  const id = randomUUID();
  await observer.query(
    `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
     values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz + interval '${kind === "administrator" ? "12 hours" : "15 minutes"}')`,
    [digest, id, account.id, kind, iso(createdAt), iso(lastActivityAt)],
  );
  return { id, token };
}

const digestOf = (token: string) => tokenDigest(token) as Buffer;
const exists = async (table: string, column: string, value: unknown) =>
  Number((await observer.query(`select count(*)::int as n from ${table} where ${column} = $1`, [value])).rows[0]?.n) === 1;
const pendingExists = (token: string) => exists("administrator_pending_challenge", "token_digest", digestOf(token));
const consumedExists = (token: string) => exists("administrator_consumed_challenge", "token_digest", digestOf(token));
const sessionExists = (id: string) => exists("administrator_session", "id", id);

async function snapshot(tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    out[table] = (await observer.query(`select row_to_json(t)::text as r from ${table} t`)).rows.map((row) => row.r as string).sort();
  }
  return out;
}

const ABUSE_CONTROL = ["authentication_throttle", "authentication_source_window"] as const;
const UNTOUCHED = ["administrator", "administrator_totp_factor", "administrator_recovery_code", ...ABUSE_CONTROL] as const;

const deleted = (count: number) => ({ status: "deleted", count }) as const;

/** Wait until the operation's backend is waiting on a lock, and return its pid. */
async function waitingBackend(): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < BOUND_MS) {
    const found = await observer.query(
      "select pid from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock' and query like $2",
      [OPERATION_APPLICATION, `%adr028:${CONSUMED}%`],
    );
    const pid = found.rows[0]?.pid;
    if (typeof pid === "number") {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the housekeeping statement never waited on the lock");
}

/* ------------------------------------------------------------------------------------------- */
/* HK-1: boundaries, schema-valid fixtures, equality means expired                              */
/* ------------------------------------------------------------------------------------------- */

describe("HK-1: boundaries (equality means expired)", () => {
  it("pending challenges: expires_at = T − 1 ms and = T are deleted; T + 1 ms is kept", async () => {
    const account = await seed();
    const T = current;
    const before = await insertPending(account, T - 5 * MINUTE - 1);
    const equal = await insertPending(account, T - 5 * MINUTE);
    const after = await insertPending(account, T - 5 * MINUTE + 1);

    expect((await housekeep(T)).pendingChallenges).toEqual(deleted(2));
    expect([await pendingExists(before), await pendingExists(equal), await pendingExists(after)]).toEqual([false, false, true]);
  });

  it("consumed records: expires_at = T − 1 ms and = T are deleted; T + 1 ms is kept", async () => {
    const account = await seed();
    const T = current;
    const before = await insertConsumed(account, T - 1);
    const equal = await insertConsumed(account, T);
    const after = await insertConsumed(account, T + 1);

    expect((await housekeep(T)).consumedChallenges).toEqual(deleted(2));
    expect([await consumedExists(before), await consumedExists(equal), await consumedExists(after)]).toEqual([false, false, true]);
  });

  it("administrator sessions: the absolute and the idle boundary, each tested independently", async () => {
    const account = await seed();
    const T = current;
    // Absolute only: absolute_expires_at = T, with activity inside the idle limit.
    const absolute = await insertSession(account, "administrator", T - 12 * HOUR, T - MINUTE);
    const absoluteTwin = await insertSession(account, "administrator", T - 12 * HOUR + 1, T - MINUTE);
    // Idle only: absolute expiry 11 hours away, last activity exactly 30 minutes ago.
    const idle = await insertSession(account, "administrator", T - HOUR, T - 30 * MINUTE);
    const idleTwin = await insertSession(account, "administrator", T - HOUR, T - 30 * MINUTE + 1);

    expect((await housekeep(T)).sessions).toEqual(deleted(2));
    expect([await sessionExists(absolute.id), await sessionExists(absoluteTwin.id), await sessionExists(idle.id), await sessionExists(idleTwin.id)]).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it("recovery sessions: the absolute boundary decides, because the 15-minute lifetime dominates the idle limit", async () => {
    const account = await seed();
    const T = current;
    const absolute = await insertSession(account, "recovery", T - 15 * MINUTE, T - 15 * MINUTE);
    const twin = await insertSession(account, "recovery", T - 15 * MINUTE + 1, T - 15 * MINUTE + 1);

    expect((await housekeep(T)).sessions).toEqual(deleted(1));
    expect([await sessionExists(absolute.id), await sessionExists(twin.id)]).toEqual([false, true]);

    // A live recovery session can never be idle-dead: last_activity_at >= created_at > T − 15 min.
    const impossible = insertSession(account, "recovery", T - 10 * MINUTE, T - 30 * MINUTE);
    await expect(impossible).rejects.toMatchObject({ code: "23514", constraint: "administrator_session_activity_check" });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* HK-2: reader outcomes, kept versus deleted                                                    */
/* ------------------------------------------------------------------------------------------- */

describe("HK-2: kept rows classify EXPIRED_CHALLENGE, deleted rows UNKNOWN_CHALLENGE; the caller sees the same refusal", () => {
  const submit = (token: string, account: Account) =>
    Promise.all([
      totpStep(signIn(), { challengeToken: token, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE }),
      recoveryStep(recovery(), { challengeToken: token, code: account.codes[0]!.code, sourceAddress: SOURCE }),
    ]);

  for (const kind of ["pending challenge", "consumed record"] as const) {
    it(`an expired ${kind}: both steps, before and after housekeeping, with counters and source windows unchanged`, async () => {
      const account = await seed();
      const token = kind === "pending challenge" ? await insertPending(account, current - 5 * MINUTE) : await insertConsumed(account, current);
      const abuse = await snapshot(ABUSE_CONTROL);

      // Sequential: the two steps lock the same administrator.
      const keptTotp = await totpStep(signIn(), { challengeToken: token, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE });
      const keptRecovery = await recoveryStep(recovery(), { challengeToken: token, code: account.codes[0]!.code, sourceAddress: SOURCE });
      expect([keptTotp, keptRecovery]).toEqual([
        { code: "REFUSED", reason: "EXPIRED_CHALLENGE" },
        { code: "REFUSED", reason: "EXPIRED_CHALLENGE" },
      ]);
      expect(await snapshot(ABUSE_CONTROL), "the rolled-back lock phase left nothing").toEqual(abuse);

      await housekeep();
      expect(kind === "pending challenge" ? await pendingExists(token) : await consumedExists(token)).toBe(false);

      expect(await submit(token, account)).toEqual([
        { code: "REFUSED", reason: "UNKNOWN_CHALLENGE" },
        { code: "REFUSED", reason: "UNKNOWN_CHALLENGE" },
      ]);
      expect(await snapshot(ABUSE_CONTROL)).toEqual(abuse);
    });
  }

  it("through the real entry points: the same 303, Location, Set-Cookie and logged outcome before and after", async () => {
    const options = (): EntryOptions => ({ environment, factories: DEFAULT_FACTORIES, log: (line) => entryLines.push(line) });
    const post = (path: string, body: string, token: string) =>
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          Host: "127.0.0.1:3000",
          Origin: ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-admin-challenge=${token}`,
        },
        body,
      });
    const facing = async (response: Response) => {
      await response.body?.cancel();
      return { status: response.status, location: response.headers.get("location"), cookies: response.headers.getSetCookie() };
    };
    const loggedOutcomes = () => entryLines.splice(0).map((line) => {
      const { at: _at, ...rest } = JSON.parse(line) as Record<string, string>;
      return rest;
    });
    const account = await seed();
    const entries = [
      ["code", (token: string) => codeEntry(post("/admin/sign-in/code/verify", new URLSearchParams({ code: "000000" }).toString(), token), options())],
      ["recovery-code", (token: string) => recoveryCodeEntry(post("/admin/sign-in/recovery/verify", new URLSearchParams({ code: account.codes[0]!.code }).toString(), token), options())],
    ] as const;

    for (const kind of ["pending challenge", "consumed record"] as const) {
      for (const [name, entry] of entries) {
        // The runtime uses the real clock, so these rows are expired in wall-clock time.
        const now = Date.now();
        const token = kind === "pending challenge" ? await insertPending(account, now - 6 * MINUTE) : await insertConsumed(account, now - MINUTE);
        const abuse = await snapshot(ABUSE_CONTROL);

        const kept = await facing(await entry(token));
        const keptLog = loggedOutcomes();
        await within(auth.removeExpiredAuthenticationRows(db, Date.now), "housekeeping");
        const gone = await facing(await entry(token));
        const goneLog = loggedOutcomes();

        expect(kept, `${kind}, ${name}`).toEqual({ status: 303, location: FAILURE_LOCATION, cookies: kept.cookies });
        expect(gone, `${kind}, ${name}`).toEqual(kept);
        expect(kept.cookies.some((cookie) => cookie.startsWith("__Host-admin-challenge=;")), "the challenge cookie is cleared").toBe(true);
        expect(goneLog, `${kind}, ${name}`).toEqual(keptLog);
        expect(keptLog.map((line) => line.outcome)).toEqual(["REFUSED"]);
        expect(JSON.stringify([keptLog, goneLog])).not.toMatch(/EXPIRED_CHALLENGE|UNKNOWN_CHALLENGE/);
        expect(await snapshot(ABUSE_CONTROL)).toEqual(abuse);
      }
    }
  });

  it("a dead session: SESSION_REFUSED before and after housekeeping, with no write before deletion", async () => {
    const account = await seed();
    const dead = await insertSession(account, "administrator", current - HOUR, current - 30 * MINUTE);
    const before = await snapshot(["administrator_session"]);

    expect(ok(await auth.checkSession(db, { tokenDigest: digestOf(dead.token) }, clock))).toEqual({ code: "SESSION_REFUSED" });
    expect(await snapshot(["administrator_session"]), "the refused check wrote nothing").toEqual(before);
    await housekeep();
    expect(await sessionExists(dead.id)).toBe(false);
    expect(ok(await auth.checkSession(db, { tokenDigest: digestOf(dead.token) }, clock))).toEqual({ code: "SESSION_REFUSED" });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* HK-3 to HK-9                                                                                 */
/* ------------------------------------------------------------------------------------------- */

describe("HK-3: a replay within the lifetime is still counted", () => {
  it("keeps the unexpired consumed record, and the replay counts against the TOTP counter and the source", async () => {
    const account = await seed();
    const outcome = await passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE });
    if (outcome.code !== "CHALLENGE_ISSUED") {
      throw new Error(`password step gave ${outcome.code}`);
    }
    const token = outcome.challengeToken;
    expect((await totpStep(signIn(), { challengeToken: token, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE })).code).toBe("SESSION_ISSUED");

    current += MINUTE;
    await housekeep();
    expect(await consumedExists(token), "a consumed record within its lifetime is kept").toBe(true);

    const replay = await totpStep(signIn(), { challengeToken: token, code: totpCodeAt(account.secret, current), sourceAddress: SOURCE });
    expect(replay).toMatchObject({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY" });
    expect(Number((await observer.query("select consecutive_failures as n from authentication_throttle where scope = 'totp'")).rows[0]?.n)).toBe(1);
    expect(Number((await observer.query("select coalesce(sum(cardinality(recent_failures)), 0)::int as n from authentication_source_window")).rows[0]?.n)).toBe(1);
  });
});

describe("HK-4: SKIP LOCKED skips row-locked rows, held until housekeeping returns", () => {
  it("returns without waiting, keeps the three locked rows, and a later run deletes them", async () => {
    const account = await seed();
    const T = current;
    const lockedPending = await insertPending(account, T - 10 * MINUTE);
    const freePending = await insertPending(account, T - 10 * MINUTE);
    const lockedConsumed = await insertConsumed(account, T - MINUTE);
    const freeConsumed = await insertConsumed(account, T - MINUTE);
    const lockedSession = await insertSession(account, "administrator", T - 13 * HOUR, T - 13 * HOUR);
    const freeSession = await insertSession(account, "administrator", T - 13 * HOUR, T - 13 * HOUR);

    const rival = await rivals.connect();
    try {
      await rival.query("begin");
      await rival.query("select 1 from administrator_pending_challenge where token_digest = $1 for update", [digestOf(lockedPending)]);
      await rival.query("select 1 from administrator_consumed_challenge where token_digest = $1 for update", [digestOf(lockedConsumed)]);
      await rival.query("select 1 from administrator_session where id = $1 for update", [lockedSession.id]);

      const report = await housekeep(T);

      // The rival still holds its locks here.
      expect(report).toEqual({ completed: true, pendingChallenges: deleted(1), consumedChallenges: deleted(1), sessions: deleted(1) });
      const stillThere = await rival.query(
        `select (select count(*) from administrator_pending_challenge where token_digest = $1)::int
              + (select count(*) from administrator_consumed_challenge where token_digest = $2)::int
              + (select count(*) from administrator_session where id = $3)::int as n`,
        [digestOf(lockedPending), digestOf(lockedConsumed), lockedSession.id],
      );
      expect(Number(stillThere.rows[0]?.n), "the rival still sees its three locked rows").toBe(3);
      expect([await pendingExists(freePending), await consumedExists(freeConsumed), await sessionExists(freeSession.id)]).toEqual([false, false, false]);

      await rival.query("commit");
    } finally {
      rival.release();
    }

    expect(await housekeep(T)).toEqual({ completed: true, pendingChallenges: deleted(1), consumedChallenges: deleted(1), sessions: deleted(1) });
  });
});

describe("HK-5 to HK-8: what housekeeping never touches", () => {
  it("HK-5: administrator, factor, code, throttle and source-window rows are byte-equal, including zero-failure and stale rows", async () => {
    const account = await seed();
    await observer.query("insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at) values ('password', $1, 0, null, $2::timestamptz)", [
      randomBytes(32),
      iso(current - 2 * HOUR),
    ]);
    await observer.query("insert into authentication_source_window (source_digest, recent_failures) values ($1, array[$2::timestamptz]), ($3, '{}')", [
      randomBytes(32),
      iso(current - 3 * HOUR),
      randomBytes(32),
    ]);
    await insertPending(account, current - HOUR);
    await insertSession(account, "recovery", current - HOUR, current - HOUR);
    const before = await snapshot(UNTOUCHED);

    expect((await housekeep()).completed).toBe(true);
    expect(await snapshot(UNTOUCHED)).toEqual(before);
  });

  it("HK-6: an invalidated pending challenge inside its lifetime is kept", async () => {
    const account = await seed();
    const live = await insertPending(account, current - MINUTE, true);

    expect((await housekeep()).pendingChallenges).toEqual(deleted(0));
    expect(await pendingExists(live)).toBe(true);
  });

  it("HK-7: a factor whose origin names a deleted recovery session is unchanged and still cannot complete", async () => {
    const account = await seed();
    const challengeOutcome = await passwordStep(signIn(), { username: account.username, password: PASSWORD, sourceAddress: SOURCE });
    if (challengeOutcome.code !== "CHALLENGE_ISSUED") {
      throw new Error(`password step gave ${challengeOutcome.code}`);
    }
    const issued = await recoveryStep(recovery(), { challengeToken: challengeOutcome.challengeToken, code: account.codes[0]!.code, sourceAddress: SOURCE });
    if (issued.code !== "RECOVERY_SESSION_ISSUED") {
      throw new Error(`recovery step gave ${issued.code}`);
    }
    const started = await reenrolmentStart(recovery(), { recoverySessionToken: issued.recoverySessionToken });
    if (started.code !== "REENROLMENT_STARTED") {
      throw new Error(`recovery start gave ${started.code}`);
    }
    const factorBefore = await snapshot(["administrator_totp_factor"]);

    current += 15 * MINUTE;
    expect((await housekeep()).sessions).toEqual(deleted(1));
    expect(await snapshot(["administrator_totp_factor"])).toEqual(factorBefore);

    const completion = await reenrolmentCompletion(recovery(), { recoverySessionToken: issued.recoverySessionToken, factorId: started.factorId, code: totpCodeAt(started.secret, current) });
    expect(completion).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(await snapshot(["administrator_totp_factor"])).toEqual(factorBefore);
  });

  it("HK-8: a disabled account's expired rows are deleted and disabled_at is byte-equal", async () => {
    const account = await seed();
    expect(ok(await auth.disableAccount(db, { administratorId: account.id }, clock))).toMatchObject({ code: "DISABLED" });
    const disabledAt = (await observer.query("select disabled_at::text as d from administrator where id = $1", [account.id])).rows[0]?.d;
    const pending = await insertPending(account, current - HOUR);
    const session = await insertSession(account, "administrator", current - 13 * HOUR, current - 13 * HOUR);

    expect(await housekeep()).toMatchObject({ completed: true, pendingChallenges: deleted(1), sessions: deleted(1) });
    expect([await pendingExists(pending), await sessionExists(session.id)]).toEqual([false, false]);
    expect((await observer.query("select disabled_at::text as d from administrator where id = $1", [account.id])).rows[0]?.d).toBe(disabledAt);
  });
});

describe("HK-9: statements", () => {
  it("sends exactly the three labelled statements in order after one clock read, with no BEGIN; a rerun deletes nothing", async () => {
    const account = await seed();
    await insertPending(account, current - HOUR);
    let reads = 0;
    const mark = hooks.log.length;

    const report = await within(auth.removeExpiredAuthenticationRows(db, () => (reads++, current)), "housekeeping");

    expect(report.completed).toBe(true);
    expect(reads).toBe(1);
    expect(hooks.log.slice(mark)).toEqual([PENDING, CONSUMED, SESSIONS]);
    expect(await housekeep()).toEqual({ completed: true, pendingChallenges: deleted(0), consumedChallenges: deleted(0), sessions: deleted(0) });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* HK-10: failures, and a rerun after each                                                      */
/* ------------------------------------------------------------------------------------------- */

interface Seeded {
  readonly pending: string;
  readonly consumed: string;
  readonly session: { readonly id: string; readonly token: string };
}

async function seedAll(account: Account): Promise<Seeded> {
  return {
    pending: await insertPending(account, current - HOUR),
    consumed: await insertConsumed(account, current - MINUTE),
    session: await insertSession(account, "administrator", current - 13 * HOUR, current - 13 * HOUR),
  };
}

const presence = async (rows: Seeded) => [await pendingExists(rows.pending), await consumedExists(rows.consumed), await sessionExists(rows.session.id)];

/** Hold an EXCLUSIVE table lock on the consumed table, act on the waiting H2, then release it. */
async function againstWaitingH2(act: (pid: number) => Promise<unknown>): Promise<auth.HousekeepingReport> {
  const rival = await rivals.connect();
  try {
    await rival.query("begin");
    await rival.query("lock table administrator_consumed_challenge in exclusive mode");
    const running = housekeep();
    await act(await waitingBackend());
    return await running;
  } finally {
    await rival.query("rollback");
    rival.release();
  }
}

interface FailureCase {
  readonly name: string;
  /** Run housekeeping with the fault in place; the fault is removed before this returns. */
  readonly inject: () => Promise<auth.HousekeepingReport>;
  readonly report: auth.HousekeepingReport;
  /** Which seeded rows (pending, consumed, session) survive the failed run. */
  readonly survivors: readonly boolean[];
  /** The exact acknowledged counts of the rerun against the same, unreseeded fixtures. */
  readonly rerun: readonly [number, number, number];
}

const FAILURES: readonly FailureCase[] = [
  {
    name: "(a) confirmed abort",
    inject: async () => {
      await observer.query("create or replace function hk_test_abort() returns trigger language plpgsql as $$ begin raise exception 'housekeeping test abort'; end $$");
      await observer.query("create trigger hk_test_abort before delete on administrator_consumed_challenge for each row execute function hk_test_abort()");
      try {
        return await housekeep();
      } finally {
        await observer.query("drop trigger hk_test_abort on administrator_consumed_challenge");
      }
    },
    report: { completed: false, pendingChallenges: deleted(1), consumedChallenges: { status: "rolled-back" }, sessions: { status: "not-run" } },
    survivors: [false, true, true],
    rerun: [0, 1, 1],
  },
  {
    name: "(b) lost acknowledgement after commit",
    inject: async () => {
      hooks.lostAcknowledgement = CONSUMED;
      try {
        return await housekeep();
      } finally {
        hooks.lostAcknowledgement = undefined;
      }
    },
    report: { completed: false, pendingChallenges: deleted(1), consumedChallenges: { status: "unknown" }, sessions: { status: "not-run" } },
    // H2 committed before its acknowledgement was lost, so its row is already gone.
    survivors: [false, false, true],
    rerun: [0, 0, 1],
  },
  {
    name: "(c) cancellation on a usable connection",
    inject: () => againstWaitingH2((pid) => observer.query("select pg_cancel_backend($1)", [pid])),
    report: { completed: false, pendingChallenges: deleted(1), consumedChallenges: { status: "unknown" }, sessions: { status: "not-run" } },
    survivors: [false, true, true],
    rerun: [0, 1, 1],
  },
  {
    name: "(d) terminated connection",
    inject: () => againstWaitingH2((pid) => observer.query("select pg_terminate_backend($1)", [pid])),
    report: { completed: false, pendingChallenges: deleted(1), consumedChallenges: { status: "unknown" }, sessions: { status: "not-run" } },
    survivors: [false, true, true],
    rerun: [0, 1, 1],
  },
];

const failure = (name: string) => FAILURES.find((entry) => entry.name.startsWith(name))!;

describe("HK-10: a confirmed abort, a lost acknowledgement and two uncertain errors, kept distinct", () => {
  it("(a) confirmed abort: a trigger's RAISE gives the driver's DatabaseError, ERROR, P0001, so H2 is rolled back", async () => {
    const entry = failure("(a)");
    const rows = await seedAll(await seed());

    expect(await entry.inject()).toEqual(entry.report);
    const error = hooks.errors.get(CONSUMED);
    expect(error).toBeInstanceOf(pg.DatabaseError);
    expect(error).toMatchObject({ severity: "ERROR", code: "P0001" });
    expect(await presence(rows)).toEqual(entry.survivors);
  });

  it("(b) lost acknowledgement after commit: no server error, so H2 is unknown with no count, and its rows are gone", async () => {
    const entry = failure("(b)");
    const rows = await seedAll(await seed());

    expect(await entry.inject()).toEqual(entry.report);
    expect(hooks.errors.has(CONSUMED), "the server reported no error").toBe(false);
    expect(await presence(rows)).toEqual(entry.survivors);
  });

  it("(c) an uncertain-completion error on a usable connection: a cancellation (ERROR, 57014) is still unknown", async () => {
    const entry = failure("(c)");
    const rows = await seedAll(await seed());

    expect(await entry.inject()).toEqual(entry.report);
    const error = hooks.errors.get(CONSUMED);
    expect(error).toBeInstanceOf(pg.DatabaseError);
    expect(error).toMatchObject({ severity: "ERROR", code: "57014" });
    expect(hooks.usableAfter.get(CONSUMED), "the same connection answered select 1").toBe(true);
    // Recorded, not relied on: H2 never ran, so its row is still there.
    expect(await presence(rows)).toEqual(entry.survivors);
  });

  it("(d) a SQLSTATE on a terminated connection (FATAL, 57P01) is unknown", async () => {
    const entry = failure("(d)");
    const rows = await seedAll(await seed());

    expect(await entry.inject()).toEqual(entry.report);
    expect(hooks.errors.get(CONSUMED)).toMatchObject({ code: "57P01" });
    expect((hooks.errors.get(CONSUMED) as { severity?: string }).severity).not.toBe("ERROR");
    expect(await presence(rows)).toEqual(entry.survivors);
  });

  for (const entry of FAILURES) {
    it(`(e) after ${entry.name}: with the fault removed, a rerun on the same fixtures deletes exactly what remains`, async () => {
      const rows = await seedAll(await seed());

      expect(await entry.inject()).toEqual(entry.report);
      expect(await presence(rows), "what the failed run left").toEqual(entry.survivors);

      const mark = hooks.log.length;
      const [pending, consumed, sessions] = entry.rerun;
      expect(await housekeep()).toEqual({ completed: true, pendingChallenges: deleted(pending), consumedChallenges: deleted(consumed), sessions: deleted(sessions) });
      expect(hooks.log.slice(mark)).toEqual([PENDING, CONSUMED, SESSIONS]);
      // The rerun's counts are exactly the seeded rows the failed run did not delete.
      expect(entry.rerun).toEqual(entry.survivors.map((survived) => (survived ? 1 : 0)));
      expect(await presence(rows), "no seeded expired row remains").toEqual([false, false, false]);
    });
  }
});

describe("§3.1: a DELETE result without a row count is unknown, never zero", () => {
  /** Strip `command` from one labelled statement's result, so Kysely reports no `numAffectedRows`. */
  async function withoutCount<T>(label: string, body: () => Promise<T>): Promise<T> {
    hooks.withoutCount = label;
    try {
      return await body();
    } finally {
      hooks.withoutCount = undefined;
    }
  }

  it("a missing count on H1 is unknown (not deleted: 0), and H2 and H3 are not sent", async () => {
    const rows = await seedAll(await seed());
    const mark = hooks.log.length;

    const report = await withoutCount(PENDING, () => housekeep());

    expect(report).toEqual({ completed: false, pendingChallenges: { status: "unknown" }, consumedChallenges: { status: "not-run" }, sessions: { status: "not-run" } });
    expect(report.pendingChallenges).not.toEqual(deleted(0));
    expect(hooks.log.slice(mark), "no later DELETE was sent").toEqual([PENDING]);
    // The DELETE itself ran; only its count was withheld.
    expect(await presence(rows)).toEqual([false, true, true]);
  });

  it("a missing count is unknown even when nothing matched, while an explicitly acknowledged zero stays deleted: 0", async () => {
    await seed();
    const mark = hooks.log.length;

    expect(await withoutCount(CONSUMED, () => housekeep())).toEqual({
      completed: false,
      pendingChallenges: deleted(0),
      consumedChallenges: { status: "unknown" },
      sessions: { status: "not-run" },
    });
    expect(hooks.log.slice(mark)).toEqual([PENDING, CONSUMED]);
  });
});
