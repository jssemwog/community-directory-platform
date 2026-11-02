/**
 * Attacking tests for the `ADR-028` authentication persistence operations (issue #258).
 *
 * Every test runs against a real PostgreSQL server from `embedded-postgres`, in one disposable
 * cluster, with an injected clock. Competing changes that belong to later slices (disable,
 * revoke-all, the competing password-change effects of a reset) are **test-only transactions**
 * that follow their `ADR-028` PS-8 sequences, on their own connections (issue #258 §7, §12).
 * They are not exported and add no production operation.
 *
 * Statements are observed through a test-owned pool wrapper that reads each statement's
 * `adr028:<label>`. It records the order of statements and clock readings, can hold one labelled
 * statement at a barrier, and can report a labelled statement as having affected zero rows, or
 * another injected count, to attack the PS-8b required counts. It never alters what the server
 * executed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";

import * as auth from "./administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "./administrator-authentication-table";
import { startupOptionsFor } from "./connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import { keyedDigest } from "../domain/administrator-auth/keyed-digest";
import { sealTotpSecret } from "../domain/administrator-auth/secret-box";
import { totpVerifierFor } from "../domain/administrator-auth/sign-in";
import { generateToken } from "../domain/administrator-auth/token";
import { generateTotpSecret, totpCodeAt, totpStepAt } from "../domain/administrator-auth/totp";

type Row = Record<string, unknown>;

interface PgResult<R = Row> {
  rows: R[];
  rowCount: number | null;
}

interface PgClient {
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<PgResult<R>>;
  release(destroy?: boolean | Error): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface PgPool {
  connect(): Promise<PgClient>;
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<PgResult<R>>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as {
  Pool: new (config: Record<string, unknown>) => PgPool;
};

const MAIN_DATABASE = "auth_persistence";
const FAULT_DATABASE = "auth_persistence_faults";

const cluster = useEmbeddedPostgres({
  slug: "auth-persistence",
  databases: [MAIN_DATABASE, FAULT_DATABASE],
  migrate: [MAIN_DATABASE, FAULT_DATABASE],
});

const OPERATION_APP = "adr028_operation";
const RIVAL_APP = "adr028_rival";
const STEP_BOUND_MS = 10_000;
const STUB_HASH = "scrypt$ln=17,r=8,p=1$c3R1Yi1zYWx0LTE2Ynl0ZQ$c3R1Yi1rZXk";

const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);

/** The injected clock. Each reading is recorded, in order, with the statements. */
let current = Date.UTC(2026, 10, 1, 12, 0, 0);

interface Hooks {
  readonly log: string[];
  readonly zero: Set<string>;
  /** A count to report in place of the real one, for counts the schema makes impossible. */
  readonly counts: Map<string, number>;
  readonly pauses: Map<string, { readonly gate: Promise<void>; readonly reached: () => void }>;
}

function labelOf(text: string): string | undefined {
  const start = "/* adr028:";

  if (!text.startsWith(start)) {
    return undefined;
  }

  return text.slice(start.length, text.indexOf(" */"));
}

function silence(target: { on(event: string, listener: (...args: unknown[]) => void): void }) {
  target.on("error", () => undefined);
}

function createPool(database: string, applicationName: string, max: number): PgPool {
  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(database),
    max,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: applicationName }),
  });

  silence(pool);
  pool.on("connect", (client) => silence(client as PgClient));
  return pool;
}

interface Operations {
  readonly db: Kysely<AdministratorAuthenticationDatabase>;
  readonly hooks: Hooks;
  readonly clock: auth.Clock;
}

const watched = new WeakSet<PgClient>();
const broken = new WeakSet<PgClient>();

function createOperations(database: string): Operations {
  const hooks: Hooks = { log: [], zero: new Set(), counts: new Map(), pauses: new Map() };
  const pool = createPool(database, OPERATION_APP, 12);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();

      // A backend a test terminates must never return to the pool as if healthy. The listener
      // is attached once per client, not once per checkout.
      if (!watched.has(client)) {
        watched.add(client);
        client.on("error", () => broken.add(client));
      }

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
          if (label !== undefined && hooks.zero.has(label)) {
            return { ...result, rows: [], rowCount: 0 };
          }

          const injected = label === undefined ? undefined : hooks.counts.get(label);

          if (injected !== undefined) {
            const first = result.rows[0];
            return { ...result, rowCount: injected, rows: first === undefined ? [] : Array.from({ length: injected }, () => first) };
          }

          return result;
        },
        release: (destroy?: boolean | Error) => client.release(broken.has(client) ? true : destroy),
      };
    },
    end: () => pool.end(),
  };

  const db = new Kysely<AdministratorAuthenticationDatabase>({
    dialect: new PostgresDialect({ pool: wrapped as never }),
  });
  const clock: auth.Clock = () => {
    hooks.log.push("clock");
    return current;
  };

  return { db, hooks, clock };
}

let main: Operations;
let faults: Operations;
let rivals: PgPool;
let faultRivals: PgPool;

beforeAll(async () => {
  main = createOperations(MAIN_DATABASE);
  faults = createOperations(FAULT_DATABASE);
  rivals = createPool(MAIN_DATABASE, RIVAL_APP, 12);
  faultRivals = createPool(FAULT_DATABASE, RIVAL_APP, 6);
  cluster.closeBeforeShutdown("auth operations", () => main.db.destroy());
  cluster.closeBeforeShutdown("auth fault operations", () => faults.db.destroy());
  cluster.closeBeforeShutdown("auth rivals", () => rivals.end());
  cluster.closeBeforeShutdown("auth fault rivals", () => faultRivals.end());
}, CLUSTER_TIMEOUT_MS);

afterAll(() => undefined);

/* ------------------------------------------------------------------------------------------- */
/* Helpers                                                                                      */
/* ------------------------------------------------------------------------------------------- */

function expectOk<T>(stored: auth.Stored<T>): T {
  if (!stored.ok) {
    throw new Error(`expected success, got ${JSON.stringify(stored.failure)}`);
  }

  return stored.value;
}

interface Administrator {
  readonly id: string;
  readonly username: string;
  readonly secret: Buffer;
  readonly factorId: string;
}

const usernameDigestOf = (username: string) => keyedDigest(THROTTLE_KEY, "password-username", username);
const totpSubjectOf = (id: string) => keyedDigest(THROTTLE_KEY, "totp-administrator", id);
const freshSource = () => keyedDigest(THROTTLE_KEY, "source-address", randomUUID());

async function seedAdministrator(ops: Operations = main): Promise<Administrator> {
  const id = randomUUID();
  const username = `admin-${id.slice(0, 8)}`;
  const secret = generateTotpSecret();
  const factorId = randomUUID();

  expectOk(await auth.createAdministrator(ops.db, { administratorId: id, username, passwordHash: STUB_HASH }, ops.clock));
  expectOk(
    await auth.startTotpEnrolment(
      ops.db,
      { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, secret) },
      ops.clock,
    ),
  );
  expect(
    expectOk(await auth.confirmTotpEnrolment(ops.db, { administratorId: id, factorId, step: totpStepAt(current) }, ops.clock)),
  ).toEqual({ code: "ENROLMENT_CONFIRMED" });

  // Move past the confirmed step, so the first sign-in code is not a replay of it.
  current += 60_000;
  return { id, username, secret, factorId };
}

async function issueChallenge(admin: Administrator, ops: Operations = main): Promise<Buffer> {
  const challenge = generateToken();
  const issued = expectOk(
    await auth.issuePasswordChallenge(
      ops.db,
      {
        administratorId: admin.id,
        verifiedPasswordHash: STUB_HASH,
        usernameDigest: usernameDigestOf(admin.username),
        challengeDigest: challenge.digest,
      },
      ops.clock,
    ),
  );
  expect(issued.code).toBe("CHALLENGE_ISSUED");
  return challenge.digest;
}

interface AttemptOptions {
  readonly code?: string;
  readonly source?: Buffer;
  readonly sessionDigest?: Buffer;
  readonly ops?: Operations;
}

function attempt(admin: Administrator, challengeDigest: Buffer, options: AttemptOptions = {}) {
  const ops = options.ops ?? main;
  return auth.completeTotpChallenge(
    ops.db,
    {
      challengeDigest,
      sourceDigest: options.source ?? freshSource(),
      totpSubjectDigestFor: totpSubjectOf,
      verify: totpVerifierFor(TOTP_KEYS, options.code ?? totpCodeAt(admin.secret, current)),
      sessionTokenDigest: options.sessionDigest ?? generateToken().digest,
      sessionId: randomUUID(),
    },
    ops.clock,
  );
}

interface Snapshot {
  readonly pending: readonly Row[];
  readonly consumed: number;
  readonly sessions: number;
  readonly factor: Row | undefined;
  readonly totpFailures: number | null;
  readonly sourceFailures: number;
  /** The whole `totp` counter row, instants as text, or null when there is none. */
  readonly totpCounter: Row | null;
  /** The source's rolling record as text, or null when there is no source row. */
  readonly sourceWindow: string | null;
  readonly administrator: Row | undefined;
}

async function snapshot(admin: Administrator, source?: Buffer, pool: PgPool = rivals): Promise<Snapshot> {
  const one = async (text: string, values: readonly unknown[]) => (await pool.query(text, values)).rows;
  const pending = await one(
    "select encode(token_digest, 'hex') as digest, invalidated from administrator_pending_challenge where administrator_id = $1 order by 1",
    [admin.id],
  );
  const consumed = await one("select count(*)::int as n from administrator_consumed_challenge where administrator_id = $1", [admin.id]);
  const sessions = await one("select count(*)::int as n from administrator_session where administrator_id = $1", [admin.id]);
  const factor = await one(
    "select state, factor_id, last_accepted_step::text as step, secret_ciphertext is not null as has_material from administrator_totp_factor where administrator_id = $1",
    [admin.id],
  );
  const counter = await one(
    "select consecutive_failures from authentication_throttle where scope = 'totp' and subject_digest = $1",
    [totpSubjectOf(admin.id)],
  );
  const sourceRows =
    source === undefined
      ? [{ n: 0 }]
      : await one("select coalesce(cardinality(recent_failures), 0)::int as n from authentication_source_window where source_digest = $1", [source]);
  const totpCounter = await one(
    `select consecutive_failures, wait_until::text as wait_until, last_failure_at::text as last_failure_at
       from authentication_throttle where scope = 'totp' and subject_digest = $1`,
    [totpSubjectOf(admin.id)],
  );
  const sourceWindow =
    source === undefined
      ? []
      : await one("select recent_failures::text as instants from authentication_source_window where source_digest = $1", [source]);
  const administrator = await one(
    "select password_hash, password_disabled_at::text as password_disabled_at, disabled_at::text as disabled_at from administrator where id = $1",
    [admin.id],
  );

  return {
    pending,
    consumed: Number(consumed[0]?.n ?? 0),
    sessions: Number(sessions[0]?.n ?? 0),
    factor: factor[0],
    totpFailures: counter[0] === undefined ? null : Number(counter[0].consecutive_failures),
    sourceFailures: Number(sourceRows[0]?.n ?? 0),
    totpCounter: totpCounter[0] ?? null,
    sourceWindow: sourceWindow[0] === undefined ? null : String(sourceWindow[0].instants),
    administrator: administrator[0],
  };
}

/** A test-only transaction on its own connection, explicit READ COMMITTED (issue #258 §7). */
interface Rival {
  readonly pid: number;
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<PgResult<R>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function rival(pool: PgPool = rivals): Promise<Rival> {
  const client = await pool.connect();
  await client.query("begin isolation level read committed");
  const pid = Number((await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid);
  let open = true;
  const finish = async (statement: string) => {
    if (!open) {
      return;
    }

    open = false;

    try {
      await client.query(statement);
    } finally {
      client.release();
    }
  };

  return {
    pid,
    query: (text, values) => client.query(text, values),
    commit: () => finish("commit"),
    rollback: () => finish("rollback"),
  };
}

/** Wait until `count` operation sessions are blocked on a lock, within the step bound. */
async function awaitBlocked(count = 1, pool: PgPool = rivals): Promise<void> {
  const deadline = Date.now() + STEP_BOUND_MS;

  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
      [OPERATION_APP],
    );

    if (Number(rows[0]?.n) >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`expected ${count} operation session(s) blocked on a lock within ${STEP_BOUND_MS} ms`);
}

/** Hold the next execution of one labelled statement until released. */
function pauseAt(ops: Operations, label: string): { readonly reached: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  ops.hooks.pauses.set(label, { gate, reached });
  return { reached: reachedPromise, release: () => release() };
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${STEP_BOUND_MS} ms`)), STEP_BOUND_MS),
    ),
  ]);
}

/* Simulations of later-slice operations: test-only, following their PS-8 sequences (§7, §12). */

async function lockAdministratorAs(r: Rival, administratorId: string): Promise<void> {
  const locked = await r.query("select id from administrator where id = $1 for update", [administratorId]);
  expect(locked.rows).toHaveLength(1);
}

async function invalidateAs(r: Rival, administratorId: string): Promise<void> {
  await r.query(
    "update administrator_pending_challenge set invalidated = true where administrator_id = $1 and invalidated = false",
    [administratorId],
  );
}

/** Simulated disable: lock; set disabled_at (exactly 1 row); delete sessions; invalidate challenges. */
async function simulateDisable(r: Rival, administratorId: string): Promise<void> {
  await lockAdministratorAs(r, administratorId);
  const updated = await r.query("update administrator set disabled_at = $2 where id = $1 and disabled_at is null", [
    administratorId,
    new Date(current).toISOString(),
  ]);
  expect(updated.rowCount).toBe(1);
  await r.query("delete from administrator_session where administrator_id = $1", [administratorId]);
  await invalidateAs(r, administratorId);
}

/** Simulated revoke-all: lock; delete sessions; invalidate challenges. */
async function simulateRevokeAll(r: Rival, administratorId: string): Promise<void> {
  await lockAdministratorAs(r, administratorId);
  await r.query("delete from administrator_session where administrator_id = $1", [administratorId]);
  await invalidateAs(r, administratorId);
}

/**
 * Competing password-change effects only (§12): replace the hash under the lock, invalidate
 * challenges, delete sessions. Not the PS-8 operator reset, and not evidence of one.
 */
async function simulatePasswordChange(r: Rival, administratorId: string): Promise<void> {
  await lockAdministratorAs(r, administratorId);
  const salt = randomBytes(16).toString("base64").split("=").join("");
  const updated = await r.query("update administrator set password_hash = $2 where id = $1", [
    administratorId,
    `scrypt$ln=17,r=8,p=1$${salt}$c3R1Yi1rZXk`,
  ]);
  expect(updated.rowCount).toBe(1);
  await invalidateAs(r, administratorId);
  await r.query("delete from administrator_session where administrator_id = $1", [administratorId]);
}

/** A six-digit code guaranteed not to match within the window at the current instant. */
function wrongCode(admin: Administrator): string {
  const valid = new Set([-30_000, 0, 30_000].map((offset) => totpCodeAt(admin.secret, current + offset)));

  for (let candidate = 0; ; candidate += 1) {
    const code = String(candidate).padStart(6, "0");

    if (!valid.has(code)) {
      return code;
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* B.1 Session check                                                                            */
/* ------------------------------------------------------------------------------------------- */

async function signedIn(): Promise<{ admin: Administrator; session: Buffer }> {
  const admin = await seedAdministrator();
  const session = generateToken().digest;
  const issued = expectOk(await attempt(admin, await issueChallenge(admin), { sessionDigest: session }));
  expect(issued.code).toBe("SESSION_ISSUED");
  return { admin, session };
}

const checkSession = (session: Buffer) => auth.checkSession(main.db, { tokenDigest: session }, main.clock);

describe("B.1 session check", () => {
  it("returns the kind, and activity keeps it alive only up to the absolute 12 hours", async () => {
    const { admin, session } = await signedIn();
    const created = current;

    expect(expectOk(await checkSession(session))).toEqual({
      code: "SESSION_VALID",
      administratorId: admin.id,
      kind: "administrator",
    });

    while (current + 29 * 60_000 < created + 12 * 60 * 60_000) {
      current += 29 * 60_000;
      expect(expectOk(await checkSession(session)).code).toBe("SESSION_VALID");
    }

    current = created + 12 * 60 * 60_000 - 1;
    expect(expectOk(await checkSession(session)).code).toBe("SESSION_VALID");
    current += 1;
    expect(expectOk(await checkSession(session)).code).toBe("SESSION_REFUSED");
  });

  it("rolls its activity update back when that required statement reports any count but 0 or 1", async () => {
    const { admin, session } = await signedIn();
    const activity = async () =>
      (
        await rivals.query<{ last: string }>("select last_activity_at::text as last from administrator_session where token_digest = $1", [
          session,
        ])
      ).rows[0]?.last;
    const before = await activity();
    current += 60_000;

    main.hooks.counts.set("check-session", 2);
    try {
      expect(await checkSession(session)).toEqual({
        ok: false,
        failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement: "check-session", expected: 1, actual: 2 },
      });
    } finally {
      main.hooks.counts.delete("check-session");
    }

    // The server did run the UPDATE; the inconsistent count rolled it back.
    expect(await activity()).toBe(before);
    expect(expectOk(await checkSession(session))).toEqual({ code: "SESSION_VALID", administratorId: admin.id, kind: "administrator" });
    expect(await activity()).not.toBe(before);
  });

  it("refuses after 30 minutes idle, for a disabled account, after logout, and for an unknown token", async () => {
    const idle = await signedIn();
    current += 30 * 60_000 - 1;
    expect(expectOk(await checkSession(idle.session)).code).toBe("SESSION_VALID");
    current += 30 * 60_000;
    expect(expectOk(await checkSession(idle.session)).code).toBe("SESSION_REFUSED");

    // The enabled-state predicate alone, with the session row left in place.
    const disabled = await signedIn();
    await rivals.query("update administrator set disabled_at = $2 where id = $1", [
      disabled.admin.id,
      new Date(current).toISOString(),
    ]);
    expect(expectOk(await checkSession(disabled.session)).code).toBe("SESSION_REFUSED");

    const loggedOut = await signedIn();
    expect(expectOk(await auth.logout(main.db, { tokenDigest: loggedOut.session }))).toEqual({ code: "LOGGED_OUT" });
    expect(expectOk(await checkSession(loggedOut.session)).code).toBe("SESSION_REFUSED");

    expect(expectOk(await checkSession(generateToken().digest)).code).toBe("SESSION_REFUSED");
  });
});

/* ------------------------------------------------------------------------------------------- */
/* B.2 Duplicate protection                                                                     */
/* ------------------------------------------------------------------------------------------- */

describe("B.2 duplicate submissions on one challenge", () => {
  it("yield exactly one session; every other duplicate is a consumed-challenge replay, counted", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const source = freshSource();
    const code = totpCodeAt(admin.secret, current);

    const outcomes = (
      await Promise.all(Array.from({ length: 5 }, () => attempt(admin, challenge, { code, source })))
    ).map(expectOk);

    expect(outcomes.filter((outcome) => outcome.code === "SESSION_ISSUED")).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.code === "FAILED" && outcome.reason === "CONSUMED_CHALLENGE_REPLAY"),
    ).toHaveLength(4);

    const after = await snapshot(admin, source);
    expect(after).toMatchObject({ pending: [], consumed: 1, sessions: 1, totpFailures: 4, sourceFailures: 4 });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* B.3 Classification after the lock, B.4 replay and wrong codes                                */
/* ------------------------------------------------------------------------------------------- */

describe("B.3 classification after the lock", () => {
  it("finds a challenge consumed while the request waited as consumed and counts it, never unknown", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const r = await rival();
    await lockAdministratorAs(r, admin.id);
    main.hooks.log.length = 0;

    const waiting = attempt(admin, challenge);
    await awaitBlocked();

    // A concurrent success's consumption, exactly as PS-4 specifies it: the conditional DELETE
    // and the consumed-challenge record with the original expiry, in one transaction.
    const consumed = await r.query(
      `with d as (delete from administrator_pending_challenge where token_digest = $1
                  returning token_digest, administrator_id, expires_at)
       insert into administrator_consumed_challenge (token_digest, administrator_id, expires_at)
       select * from d`,
      [challenge],
    );
    expect(consumed.rowCount).toBe(1);
    await r.commit();

    const outcome = expectOk(await within(waiting, "the waiting attempt"));
    expect(outcome).toMatchObject({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY", consecutiveFailures: 1 });

    // It resolved the pending row before the lock, and looked in both tables again after it.
    const log = main.hooks.log;
    expect(log.indexOf("resolve-challenge")).toBeLessThan(log.indexOf("lock-administrator"));
    expect(log.indexOf("lock-pending-challenge")).toBeLessThan(log.indexOf("clock"));
    expect(log.indexOf("lock-consumed-challenge")).toBeLessThan(log.indexOf("clock"));
  });

  it("refuses unknown, expired and invalidated challenges without counting anything", async () => {
    const admin = await seedAdministrator();

    expect(expectOk(await attempt(admin, generateToken().digest))).toEqual({
      code: "REFUSED",
      reason: "UNKNOWN_CHALLENGE",
    });

    const expiring = await issueChallenge(admin);
    current += 5 * 60_000 - 1;
    expect(expectOk(await attempt(admin, expiring, { code: wrongCode(admin) })).code).toBe("FAILED");
    current += 1;
    expect(expectOk(await attempt(admin, expiring))).toEqual({ code: "REFUSED", reason: "EXPIRED_CHALLENGE" });

    const invalidated = await issueChallenge(admin);
    const r = await rival();
    await invalidateAs(r, admin.id);
    await r.commit();
    expect(expectOk(await attempt(admin, invalidated))).toEqual({ code: "REFUSED", reason: "INVALIDATED_CHALLENGE" });

    // Only the one deliberate wrong code above was counted.
    expect((await snapshot(admin)).totpFailures).toBe(1);
  });

  it("treats a consumed challenge past its original expiry as expired and uncounted", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const code = totpCodeAt(admin.secret, current);

    expect(expectOk(await attempt(admin, challenge, { code })).code).toBe("SESSION_ISSUED");
    current += 5 * 60_000;
    expect(expectOk(await attempt(admin, challenge, { code }))).toEqual({
      code: "REFUSED",
      reason: "EXPIRED_CHALLENGE",
    });
    expect((await snapshot(admin)).totpFailures).toBeNull();
  });
});

describe("B.4 TOTP replay and wrong codes", () => {
  it("counts the same code on another live challenge as an ADR-004 TOTP replay", async () => {
    const admin = await seedAdministrator();
    const code = totpCodeAt(admin.secret, current);

    expect(expectOk(await attempt(admin, await issueChallenge(admin), { code })).code).toBe("SESSION_ISSUED");
    expect(expectOk(await attempt(admin, await issueChallenge(admin), { code }))).toMatchObject({
      code: "FAILED",
      reason: "TOTP_REPLAY",
      consecutiveFailures: 1,
    });
  });

  it("leaves the challenge live after a wrong code (D-5), so the right code then succeeds", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);

    expect(expectOk(await attempt(admin, challenge, { code: wrongCode(admin) }))).toMatchObject({
      code: "FAILED",
      reason: "WRONG_CODE",
    });
    expect((await snapshot(admin)).pending).toEqual([expect.objectContaining({ invalidated: false })]);
    expect(expectOk(await attempt(admin, challenge)).code).toBe("SESSION_ISSUED");
  });
});

/* ------------------------------------------------------------------------------------------- */
/* B.5 Credential-version races, with competing changes simulated (§7, §12)                     */
/* ------------------------------------------------------------------------------------------- */

describe("B.5 credential-version races", () => {
  it("I-6: a password changed while the success transaction waits issues no challenge, uncounted", async () => {
    const admin = await seedAdministrator();
    const r = await rival();
    await simulatePasswordChange(r, admin.id);

    const challenge = generateToken().digest;
    const waiting = auth.issuePasswordChallenge(
      main.db,
      {
        administratorId: admin.id,
        verifiedPasswordHash: STUB_HASH,
        usernameDigest: usernameDigestOf(admin.username),
        challengeDigest: challenge,
      },
      main.clock,
    );
    await awaitBlocked();
    await r.commit();

    expect(expectOk(await within(waiting, "the success transaction"))).toEqual({
      code: "VERIFICATION_OBSOLETE",
      reason: "PASSWORD_CHANGED",
    });
    expect((await snapshot(admin)).pending).toEqual([]);
  });

  it("I-5: a disable committed while a TOTP step waits rolls the step back; nothing is issued or counted", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const r = await rival();
    await simulateDisable(r, admin.id);

    const waiting = attempt(admin, challenge);
    await awaitBlocked();
    await r.commit();

    expect(expectOk(await within(waiting, "the TOTP step"))).toEqual({ code: "REFUSED", reason: "ACCOUNT_DISABLED" });
    expect(await snapshot(admin)).toMatchObject({ sessions: 0, consumed: 0, totpFailures: null });
  });

  it("refuses a sign-in whose factor was replaced before it acquired the lock", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const code = totpCodeAt(admin.secret, current);
    const paused = pauseAt(main, "lock-administrator");

    const waiting = attempt(admin, challenge, { code });
    await paused.reached;

    // The in-scope re-enrolment start: a new factor_id, pending, and the challenge invalidated.
    const replacement = randomUUID();
    const started = auth.startTotpEnrolment(
      main.db,
      {
        administratorId: admin.id,
        factorId: replacement,
        material: sealTotpSecret(TOTP_KEY, 1, admin.id, generateTotpSecret()),
      },
      main.clock,
    );
    expect(expectOk(await within(started, "the factor replacement"))).toEqual({ code: "ENROLMENT_STARTED" });
    paused.release();

    expect(expectOk(await within(waiting, "the TOTP step"))).toEqual({
      code: "REFUSED",
      reason: "INVALIDATED_CHALLENGE",
    });
    expect(await snapshot(admin)).toMatchObject({ sessions: 0, totpFailures: null });
    expect((await snapshot(admin)).factor).toMatchObject({ state: "pending_confirmation", factor_id: replacement });
  });

  it("guards the step advance with the verified factor_id: a factor changed underneath rolls back", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const paused = pauseAt(main, "advance-totp-step");

    const waiting = attempt(admin, challenge);
    await paused.reached;

    // Deliberately outside the lock protocol, to attack the guard itself: the factor row is
    // relabelled after verification and before the advance.
    await rivals.query("update administrator_totp_factor set factor_id = $2 where administrator_id = $1", [
      admin.id,
      randomUUID(),
    ]);
    paused.release();

    const outcome = await within(waiting, "the TOTP step");
    expect(outcome).toEqual({
      ok: false,
      failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement: "advance-totp-step", expected: 1, actual: 0 },
    });
    expect(await snapshot(admin)).toMatchObject({ consumed: 0, sessions: 0 });
    expect((await snapshot(admin)).pending).toHaveLength(1);
  });

  it("leaves a consumed record consumed after a later invalidation, so a duplicate is still counted", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const code = totpCodeAt(admin.secret, current);

    expect(expectOk(await attempt(admin, challenge, { code })).code).toBe("SESSION_ISSUED");

    const r = await rival();
    await simulateRevokeAll(r, admin.id);
    await r.commit();

    expect(expectOk(await attempt(admin, challenge, { code }))).toMatchObject({
      code: "FAILED",
      reason: "CONSUMED_CHALLENGE_REPLAY",
    });
    expect(await snapshot(admin)).toMatchObject({ consumed: 1, sessions: 0, totpFailures: 1 });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* B.6 Required row counts (PS-8b)                                                              */
/* ------------------------------------------------------------------------------------------- */

async function withZeroed<T>(label: string, body: () => Promise<T>): Promise<T> {
  main.hooks.zero.add(label);

  try {
    return await body();
  } finally {
    main.hooks.zero.delete(label);
  }
}

const protocolFailure = (statement: string) => ({
  ok: false,
  failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement, expected: 1, actual: 0 },
});

async function setCounter(scope: "password" | "totp", subject: Buffer, failures: number): Promise<void> {
  await rivals.query(
    `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
     values ($1, $2, $3, $4, $5)
     on conflict (scope, subject_digest) do update set consecutive_failures = excluded.consecutive_failures,
       wait_until = excluded.wait_until, last_failure_at = excluded.last_failure_at`,
    [scope, subject, failures, failures >= 5 ? new Date(current - 1_000).toISOString() : null, new Date(current - 1_000).toISOString()],
  );
}

/** Every row the password-failure transaction can write, instants as text. */
async function passwordState(username: string, source: Buffer, administratorId?: string): Promise<Row> {
  const rows = async (text: string, values: readonly unknown[]) => (await rivals.query(text, values)).rows;

  return {
    counter: await rows(
      `select consecutive_failures, wait_until::text as wait_until, last_failure_at::text as last_failure_at
         from authentication_throttle where scope = 'password' and subject_digest = $1`,
      [usernameDigestOf(username)],
    ),
    source: await rows("select recent_failures::text as instants from authentication_source_window where source_digest = $1", [source]),
    administrator:
      administratorId === undefined
        ? []
        : await rows(
            "select password_hash, password_disabled_at::text as password_disabled_at, disabled_at::text as disabled_at from administrator where id = $1",
            [administratorId],
          ),
    pending:
      administratorId === undefined
        ? []
        : await rows(
            "select encode(token_digest, 'hex') as digest, invalidated from administrator_pending_challenge where administrator_id = $1 order by 1",
            [administratorId],
          ),
  };
}

async function presetSource(source: Buffer, failures: number): Promise<void> {
  await rivals.query(
    `insert into authentication_source_window (source_digest, recent_failures)
     values ($1, array(select to_timestamp($2::bigint / 1000.0) - make_interval(secs => g) from generate_series(1, $3::int) g)::timestamptz(3)[])`,
    [source, current, failures],
  );
}

describe("B.6 required row counts", () => {
  for (const label of [
    "lock-source-row",
    "lock-counter-row",
    "consume-challenge",
    "record-consumed-challenge",
    "advance-totp-step",
    "issue-session",
  ]) {
    it(`rolls the whole successful sign-in back when ${label} affects zero rows`, async () => {
      const admin = await seedAdministrator();
      const challenge = await issueChallenge(admin);
      const source = freshSource();
      const code = totpCodeAt(admin.secret, current);
      const before = await snapshot(admin, source);

      expect(await withZeroed(label, () => attempt(admin, challenge, { code, source }))).toEqual(protocolFailure(label));
      expect(await snapshot(admin, source)).toEqual(before);
      expect(expectOk(await attempt(admin, challenge, { code, source })).code).toBe("SESSION_ISSUED");
    });
  }

  for (const label of ["count-failure", "count-source-failure"]) {
    it(`rolls a counted TOTP failure back when ${label} affects zero rows`, async () => {
      const admin = await seedAdministrator();
      const challenge = await issueChallenge(admin);
      const source = freshSource();
      const before = await snapshot(admin, source);

      expect(
        await withZeroed(label, () => attempt(admin, challenge, { code: wrongCode(admin), source })),
      ).toEqual(protocolFailure(label));
      expect(await snapshot(admin, source)).toEqual(before);
    });
  }

  it("rolls the TOTP ceiling back as a whole when totp-ceiling affects zero rows", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    await setCounter("totp", totpSubjectOf(admin.id), 99);
    const before = await snapshot(admin);

    expect(await withZeroed("totp-ceiling", () => attempt(admin, challenge, { code: wrongCode(admin) }))).toEqual(
      protocolFailure("totp-ceiling"),
    );
    expect(await snapshot(admin)).toEqual(before);
  });

  it("rolls back issue-challenge, password-ceiling and the provisioning statements on zero rows", async () => {
    const admin = await seedAdministrator();
    const issue = () =>
      auth.issuePasswordChallenge(
        main.db,
        {
          administratorId: admin.id,
          verifiedPasswordHash: STUB_HASH,
          usernameDigest: usernameDigestOf(admin.username),
          challengeDigest: generateToken().digest,
        },
        main.clock,
      );
    expect(await withZeroed("issue-challenge", issue)).toEqual(protocolFailure("issue-challenge"));
    expect((await snapshot(admin)).pending).toEqual([]);

    await setCounter("password", usernameDigestOf(admin.username), 99);
    const ceilingSource = freshSource();
    await presetSource(ceilingSource, 2);
    const fail = () =>
      auth.recordPasswordFailure(
        main.db,
        { administratorId: admin.id, usernameDigest: usernameDigestOf(admin.username), sourceDigest: ceilingSource },
        main.clock,
      );
    const beforeCeiling = await passwordState(admin.username, ceilingSource, admin.id);
    expect(await withZeroed("password-ceiling", fail)).toEqual(protocolFailure("password-ceiling"));
    // The counter, the rolling record, the administrator row and its challenges are all as before.
    expect(await passwordState(admin.username, ceilingSource, admin.id)).toEqual(beforeCeiling);
    expect(beforeCeiling.counter).toEqual([expect.objectContaining({ consecutive_failures: 99 })]);

    const id = randomUUID();
    const create = () =>
      auth.createAdministrator(main.db, { administratorId: id, username: `admin-${id.slice(0, 8)}`, passwordHash: STUB_HASH }, main.clock);
    expect(await withZeroed("create-administrator", create)).toEqual(protocolFailure("create-administrator"));
    expect((await rivals.query("select 1 from administrator where id = $1", [id])).rows).toEqual([]);

    expectOk(await create());
    const factorId = randomUUID();
    const start = () =>
      auth.startTotpEnrolment(
        main.db,
        { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, generateTotpSecret()) },
        main.clock,
      );
    expect(await withZeroed("start-enrolment", start)).toEqual(protocolFailure("start-enrolment"));
    expect((await rivals.query("select 1 from administrator_totp_factor where administrator_id = $1", [id])).rows).toEqual([]);

    expectOk(await start());
    const confirm = () => auth.confirmTotpEnrolment(main.db, { administratorId: id, factorId, step: totpStepAt(current) }, main.clock);
    expect(await withZeroed("confirm-enrolment", confirm)).toEqual(protocolFailure("confirm-enrolment"));
    expect((await rivals.query<{ state: string }>("select state from administrator_totp_factor where administrator_id = $1", [id])).rows).toEqual([
      { state: "pending_confirmation" },
    ]);
  });

  // The password-failure transaction's own required statements (PS-8b "Password step, failure").
  // A known username starts from existing counter and source rows; an unknown one starts from
  // none, so the empty rows the lock phase inserts must roll back too.
  for (const label of ["lock-source-row", "lock-counter-row", "count-failure", "count-source-failure"]) {
    for (const subject of ["known", "unknown"] as const) {
      it(`rolls a ${subject}-username password failure back as a whole when ${label} affects zero rows`, async () => {
        const admin = subject === "known" ? await seedAdministrator() : undefined;
        const username = admin?.username ?? `nobody-${randomUUID().slice(0, 8)}`;
        const source = freshSource();

        if (admin !== undefined) {
          await issueChallenge(admin);
          await setCounter("password", usernameDigestOf(username), 3);
          await presetSource(source, 2);
        }

        const before = await passwordState(username, source, admin?.id);
        const outcome = await withZeroed(label, () =>
          auth.recordPasswordFailure(
            main.db,
            { administratorId: admin?.id, usernameDigest: usernameDigestOf(username), sourceDigest: source },
            main.clock,
          ),
        );

        expect(outcome).toEqual(protocolFailure(label));
        expect(await passwordState(username, source, admin?.id)).toEqual(before);
      });
    }
  }
});

/* ------------------------------------------------------------------------------------------- */
/* B.7 Clock sampling after waits, B.8 ceilings                                                 */
/* ------------------------------------------------------------------------------------------- */

describe("B.7 the clock is read after the lock phase", () => {
  it("decides expiry at the post-wait instant: a challenge that expires during the wait is refused", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const code = totpCodeAt(admin.secret, current);
    const r = await rival();
    await lockAdministratorAs(r, admin.id);
    main.hooks.log.length = 0;

    const waiting = attempt(admin, challenge, { code });
    await awaitBlocked();
    current += 5 * 60_000;
    await r.commit();

    expect(expectOk(await within(waiting, "the TOTP step"))).toEqual({ code: "REFUSED", reason: "EXPIRED_CHALLENGE" });

    // The single clock reading follows the last lock of the lock phase.
    const log = main.hooks.log;
    expect(log.filter((entry) => entry === "clock")).toHaveLength(1);
    expect(log.indexOf("clock")).toBeGreaterThan(log.indexOf("lock-counter-row"));
  });

  it("writes the post-wait instant into the session it issues", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const code = totpCodeAt(admin.secret, current);
    const session = generateToken().digest;
    const r = await rival();
    await lockAdministratorAs(r, admin.id);

    const waiting = attempt(admin, challenge, { code, sessionDigest: session });
    await awaitBlocked();
    current += 20_000;
    const afterWait = current;
    await r.commit();

    expect(expectOk(await within(waiting, "the TOTP step")).code).toBe("SESSION_ISSUED");
    const { rows } = await rivals.query<{ created_at: number; absolute_expires_at: number }>(
      "select created_at, absolute_expires_at from administrator_session where token_digest = $1",
      [session],
    );
    expect(rows[0]).toEqual({ created_at: afterWait, absolute_expires_at: afterWait + 12 * 60 * 60_000 });
  });

  it("records a password failure at the instant read after waiting on the source row", async () => {
    const source = freshSource();
    const subject = usernameDigestOf(`unknown-${randomUUID().slice(0, 8)}`);
    await rivals.query(
      "insert into authentication_source_window (source_digest, recent_failures) values ($1, '{}'::timestamptz(3)[])",
      [source],
    );
    const r = await rival();
    await r.query("select 1 from authentication_source_window where source_digest = $1 for update", [source]);

    const waiting = auth.recordPasswordFailure(main.db, { administratorId: undefined, usernameDigest: subject, sourceDigest: source }, main.clock);
    await awaitBlocked();
    current += 7_000;
    const afterWait = current;
    await r.commit();

    expect(expectOk(await within(waiting, "the failure transaction")).consecutiveFailures).toBe(1);
    const { rows } = await rivals.query<{ last_failure_at: number }>(
      "select last_failure_at from authentication_throttle where scope = 'password' and subject_digest = $1",
      [subject],
    );
    expect(rows[0]?.last_failure_at).toBe(afterWait);
  });
});

describe("B.8 ceilings at 100 consecutive failures", () => {
  it("disables the password authenticator and invalidates pending challenges", async () => {
    const admin = await seedAdministrator();
    await issueChallenge(admin);
    await setCounter("password", usernameDigestOf(admin.username), 99);

    const counted = expectOk(
      await auth.recordPasswordFailure(
        main.db,
        { administratorId: admin.id, usernameDigest: usernameDigestOf(admin.username), sourceDigest: freshSource() },
        main.clock,
      ),
    );
    expect(counted).toEqual({ code: "PASSWORD_FAILURE_COUNTED", consecutiveFailures: 100, passwordDisabled: true });
    expect((await snapshot(admin)).pending).toEqual([expect.objectContaining({ invalidated: true })]);

    const issued = expectOk(
      await auth.issuePasswordChallenge(
        main.db,
        {
          administratorId: admin.id,
          verifiedPasswordHash: STUB_HASH,
          usernameDigest: usernameDigestOf(admin.username),
          challengeDigest: generateToken().digest,
        },
        main.clock,
      ),
    );
    expect(issued).toEqual({ code: "VERIFICATION_OBSOLETE", reason: "PASSWORD_DISABLED" });
  });

  it("makes the TOTP factor reenrolment_required, discards its material and factor_id, and invalidates challenges", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    await setCounter("totp", totpSubjectOf(admin.id), 99);

    expect(expectOk(await attempt(admin, challenge, { code: wrongCode(admin) }))).toMatchObject({
      code: "FAILED",
      consecutiveFailures: 100,
      factorDisabled: true,
    });
    const after = await snapshot(admin);
    expect(after.factor).toEqual({ state: "reenrolment_required", factor_id: null, step: null, has_material: false });
    expect(after.pending).toEqual([expect.objectContaining({ invalidated: true })]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* B.9 Named lock interleavings — bounded tests of these orders only, not a proof              */
/* ------------------------------------------------------------------------------------------- */

async function awaitAppBlocked(app: string, count = 1, pool: PgPool = rivals): Promise<void> {
  const deadline = Date.now() + STEP_BOUND_MS;

  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
      [app],
    );

    if (Number(rows[0]?.n) >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`expected ${count} ${app} session(s) blocked within ${STEP_BOUND_MS} ms`);
}

async function holdSource(source: Buffer, pool: PgPool = rivals): Promise<Rival> {
  await pool.query(
    "insert into authentication_source_window (source_digest, recent_failures) values ($1, '{}'::timestamptz(3)[]) on conflict do nothing",
    [source],
  );
  const r = await rival(pool);
  await r.query("select 1 from authentication_source_window where source_digest = $1 for update", [source]);
  return r;
}

interface Waiter {
  readonly pid: number;
  readonly blockers: readonly number[];
}

/** The operation backends now waiting on a lock, with the backends `pg_blocking_pids` names. */
async function waitingOperations(): Promise<Waiter[]> {
  const { rows } = await rivals.query<{ pid: number; blockers: number[] }>(
    `select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where application_name = $1 and wait_event_type = 'Lock' order by pid`,
    [OPERATION_APP],
  );
  return rows.map((row) => ({ pid: Number(row.pid), blockers: row.blockers.map(Number).sort((a, b) => a - b) }));
}

/**
 * Whether `pid` is queued for source row `source` itself, and not for some other row its blocker
 * also holds. PostgreSQL queues a row-lock waiter on the row's tuple lock and, once it holds
 * that, on the holder's transaction; so the waiter holds or awaits a tuple lock at exactly that
 * row's page and offset, and anything it awaits is that tuple lock or a blocker's transaction.
 */
async function queuedOnSourceRow(pid: number, source: Buffer, blockers: readonly number[]): Promise<boolean> {
  const located = await rivals.query<{ ctid: string }>("select ctid::text as ctid from authentication_source_window where source_digest = $1", [
    source,
  ]);
  const [page, tuple] = (located.rows[0]?.ctid ?? "(-1,-1)").slice(1, -1).split(",").map(Number);
  const { rows } = await rivals.query<{ locktype: string; relation: string | null; page: number | null; tuple: number | null; transactionid: string | null; granted: boolean }>(
    `select locktype, relation::regclass::text as relation, page, tuple, transactionid::text as transactionid, granted
       from pg_locks where pid = $1 and locktype in ('tuple', 'transactionid')`,
    [pid],
  );
  const onRow = (lock: (typeof rows)[number]) =>
    lock.locktype === "tuple" && lock.relation === "authentication_source_window" && lock.page === page && lock.tuple === tuple;
  const blockerTransactions = new Set(
    (
      await rivals.query<{ transactionid: string }>(
        "select transactionid::text as transactionid from pg_locks where pid = any($1::int[]) and locktype = 'transactionid' and granted",
        [blockers],
      )
    ).rows.map((row) => row.transactionid),
  );
  const awaited = rows.filter((lock) => !lock.granted);

  return (
    rows.some(onRow) &&
    awaited.length > 0 &&
    awaited.every((lock) => onRow(lock) || (lock.locktype === "transactionid" && blockerTransactions.has(String(lock.transactionid))))
  );
}

async function eventually(description: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + STEP_BOUND_MS;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`${description} did not hold within ${STEP_BOUND_MS} ms`);
}

/**
 * Release `holder`'s lock on `source` and show that the two waiting operations then hold it one
 * at a time. **No acquisition order is assumed** (issue #258 §12): PostgreSQL does not promise
 * which waiter is granted a row lock first, so the test lets either win.
 *
 * 1. Before release, both operations are blocked and queued on the source row itself. Every
 *    blocker is the holder or the other operation, and at least one is blocked by the holder
 *    directly. (Which of them queues behind the other is PostgreSQL's choice: a later row-lock
 *    waiter is blocked by the earlier one's tuple lock, not by the holder.)
 * 2. The holder commits. Whichever operation acquires the row runs to `ensure-counter-row`, the
 *    statement right after its source lock, and is held there inside its transaction.
 * 3. While it holds the row, the other operation is blocked by it alone, still on the source row.
 */
async function expectSerializedOnSource(holder: Rival, source: Buffer): Promise<void> {
  const first = pauseAt(main, "ensure-counter-row");

  try {
    await awaitBlocked(2);
    const queued = await waitingOperations();
    expect(queued).toHaveLength(2);
    const pids = queued.map((waiter) => waiter.pid);

    for (const waiter of queued) {
      expect(waiter.blockers.length).toBeGreaterThan(0);
      expect(waiter.blockers.every((pid) => pid === holder.pid || (pids.includes(pid) && pid !== waiter.pid))).toBe(true);
      expect(await queuedOnSourceRow(waiter.pid, source, waiter.blockers)).toBe(true);
    }

    expect(queued.some((waiter) => waiter.blockers.includes(holder.pid))).toBe(true);

    await holder.commit();
    await within(first.reached, "the first operation to acquire the source row");

    await eventually("the second operation waiting on the first, on the source row", async () => {
      const waiting = await waitingOperations();
      const [only] = waiting;

      if (waiting.length !== 1 || only === undefined || !pids.includes(only.pid)) {
        return false;
      }

      const other = pids.find((pid) => pid !== only.pid);
      return only.blockers.length === 1 && only.blockers[0] === other && (await queuedOnSourceRow(only.pid, source, only.blockers));
    });
  } finally {
    // Never leave the operations stuck behind a failed assertion.
    first.release();
    main.hooks.pauses.delete("ensure-counter-row");
    await holder.commit();
  }
}

const failPassword = (administratorId: string | undefined, username: string, source: Buffer) =>
  auth.recordPasswordFailure(
    main.db,
    { administratorId, usernameDigest: usernameDigestOf(username), sourceDigest: source },
    main.clock,
  );

describe("B.9 named lock interleavings (bounded; they do not prove that no deadlock can occur)", () => {
  it("I-1: a TOTP step for A and a password failure for B, both waiting on source S, both complete", async () => {
    const a = await seedAdministrator();
    const b = await seedAdministrator();
    const challenge = await issueChallenge(a);
    const source = freshSource();
    const r = await holdSource(source);

    const totp = attempt(a, challenge, { code: wrongCode(a), source });
    const password = failPassword(b.id, b.username, source);
    await expectSerializedOnSource(r, source);

    const [first, second] = await within(Promise.all([totp, password]), "I-1");
    expect(expectOk(first)).toMatchObject({ code: "FAILED", reason: "WRONG_CODE" });
    expect(expectOk(second).code).toBe("PASSWORD_FAILURE_COUNTED");
    expect((await snapshot(a, source)).sourceFailures).toBe(2);
  });

  it("I-2: two TOTP steps for different administrators from one source serialize on it", async () => {
    const a = await seedAdministrator();
    const b = await seedAdministrator();
    const challenges = [await issueChallenge(a), await issueChallenge(b)] as const;
    const source = freshSource();
    const r = await holdSource(source);

    const outcomes = Promise.all([
      attempt(a, challenges[0], { code: wrongCode(a), source }),
      attempt(b, challenges[1], { code: wrongCode(b), source }),
    ]);
    // Each waits on S and on nothing of the other's administrator row.
    await expectSerializedOnSource(r, source);

    for (const outcome of await within(outcomes, "I-2")) {
      expect(expectOk(outcome)).toMatchObject({ code: "FAILED", reason: "WRONG_CODE", consecutiveFailures: 1 });
    }
    expect((await snapshot(a, source)).sourceFailures).toBe(2);
  });

  it("I-3: a session check holding its row finishes first; the simulated disable then completes", async () => {
    const { admin, session } = await signedIn();
    const paused = pauseAt(main, "check-session");

    const check = checkSession(session);
    await paused.reached;

    const r = await rival();
    await lockAdministratorAs(r, admin.id);
    const disabled = await r.query("update administrator set disabled_at = $2 where id = $1 and disabled_at is null", [
      admin.id,
      new Date(current).toISOString(),
    ]);
    expect(disabled.rowCount).toBe(1);
    const deleting = r.query("delete from administrator_session where administrator_id = $1", [admin.id]);
    await awaitAppBlocked(RIVAL_APP);

    paused.release();
    expect(expectOk(await within(check, "the session check"))).toMatchObject({ code: "SESSION_VALID" });
    expect((await within(deleting, "the simulated disable")).rowCount).toBe(1);
    await invalidateAs(r, admin.id);
    await r.commit();

    expect(expectOk(await checkSession(session)).code).toBe("SESSION_REFUSED");
  });

  it("I-4: an unknown-username failure and a known-username failure on one source both complete", async () => {
    const known = await seedAdministrator();
    const source = freshSource();
    const r = await holdSource(source);

    const unknown = failPassword(undefined, `nobody-${randomUUID().slice(0, 8)}`, source);
    const counted = failPassword(known.id, known.username, source);
    await expectSerializedOnSource(r, source);

    for (const outcome of await within(Promise.all([unknown, counted]), "I-4")) {
      expect(expectOk(outcome)).toMatchObject({ code: "PASSWORD_FAILURE_COUNTED", consecutiveFailures: 1 });
    }
    expect((await snapshot(known, source)).sourceFailures).toBe(2);
  });

  // I-5 and I-6 are in B.5: a disable while a TOTP step waits, and a password change while a
  // password success waits.
});

/* ------------------------------------------------------------------------------------------- */
/* B.10 Database failures: classified, rolled back, attempted exactly once                      */
/* ------------------------------------------------------------------------------------------- */

const SAFE_FAILURE_KEYS = ["code", "constraint", "sqlState"];

function expectSanitized(failure: unknown, secrets: readonly Buffer[]): void {
  expect(Object.keys(failure as object).every((key) => SAFE_FAILURE_KEYS.includes(key))).toBe(true);
  const text = JSON.stringify(failure);

  for (const secret of secrets) {
    expect(text).not.toContain(secret.toString("hex"));
    expect(text).not.toContain(secret.toString("base64"));
  }

  expectNoCanary(failure, secrets);
}

/**
 * None of `canaries` appears, in any common encoding, in the ways a caller might render `value`.
 * The driver error stays on a failure's non-enumerable `cause` by design; only a caller reaching
 * for it deliberately would see it, and that is outside what this checks.
 */
/** PostgreSQL renders bytea as a backslash, `x`, then hex. */
const BACKSLASH = String.fromCharCode(92);

function expectNoCanary(value: unknown, canaries: readonly Buffer[]): void {
  const renderings = [JSON.stringify(value), inspect(value, { depth: null }), JSON.stringify({ ...(value as object) }), String(value)];

  for (const rendered of renderings) {
    for (const canary of canaries) {
      for (const form of [
        canary.toString("utf8"),
        canary.toString("hex"),
        `${BACKSLASH}x${canary.toString("hex")}`,
        canary.toString("base64"),
        canary.toString("base64url"),
      ]) {
        expect(rendered).not.toContain(form);
      }
    }
  }
}

/** A genuine SQLSTATE, never a Node system code (issue #258 §12; `storage-failure.ts`). */
const GENUINE_SQLSTATE = /^[0-9A-Z]{5}$/;

const occurrences = (ops: Operations, label: string) => ops.hooks.log.filter((entry) => entry === label).length;

async function installFaultTrigger(argument: string): Promise<void> {
  await faultRivals.query(
    `create or replace function adr028_test_fault() returns trigger language plpgsql as $$
     begin
       if tg_argv[0] = 'sleep' then
         perform pg_sleep(30);
         return new;
       end if;
       raise exception 'injected test fault' using errcode = tg_argv[0];
     end $$`,
  );
  await faultRivals.query(
    `create trigger adr028_test_fault before insert on administrator_session
       for each row execute function adr028_test_fault('${argument}')`,
  );
}

async function removeFaultTrigger(): Promise<void> {
  await faultRivals.query("drop trigger if exists adr028_test_fault on administrator_session");
}

async function faultScenario(): Promise<{ admin: Administrator; challenge: Buffer; code: string; source: Buffer }> {
  const admin = await seedAdministrator(faults);
  const challenge = await issueChallenge(admin, faults);
  return { admin, challenge, code: totpCodeAt(admin.secret, current), source: freshSource() };
}

/**
 * Every row the TOTP transaction can write is exactly as `before`: the challenge (present, not
 * invalidated), consumed records, sessions, the factor's `last_accepted_step`, the `totp` counter
 * row and the source's rolling record (absent again when the lock phase had inserted it).
 */
async function expectNothingWritten(admin: Administrator, source: Buffer, before: Snapshot): Promise<void> {
  const after = await snapshot(admin, source, faultRivals);
  expect(after).toEqual(before);
  expect(after.factor?.step).toBe(before.factor?.step);
  expect(after.totpCounter).toEqual(before.totpCounter);
  expect(after.sourceWindow).toBe(before.sourceWindow);
  expect(after.pending).toEqual([expect.objectContaining({ invalidated: false })]);
}

describe("B.10 database failures", () => {
  it("returns 40P01 to the operation itself as RETRYABLE_CONFLICT, rolled back and not retried", async () => {
    const { admin, challenge, code, source } = await faultScenario();
    await faultRivals.query(
      "insert into authentication_source_window (source_digest, recent_failures) values ($1, '{}'::timestamptz(3)[])",
      [source],
    );
    const r = await rival(faultRivals);
    // Makes the operation the likely victim. Not proof of victim selection: the assertion is.
    await r.query("set local deadlock_timeout = '10s'");
    await r.query("select 1 from authentication_source_window where source_digest = $1 for update", [source]);
    const before = await snapshot(admin, source, faultRivals);
    faults.hooks.log.length = 0;

    const operation = attempt(admin, challenge, { code, source, ops: faults });
    await awaitBlocked(1, faultRivals);
    const rivalLock = r.query("select id from administrator where id = $1 for update", [admin.id]);

    const outcome = await within(operation, "the deadlocked operation");
    expect(outcome).toEqual({ ok: false, failure: { code: "RETRYABLE_CONFLICT", sqlState: "40P01" } });

    // The competing session was not the victim: its request was granted once the operation rolled back.
    expect((await within(rivalLock, "the competing lock")).rows).toHaveLength(1);
    await r.commit();

    expect(occurrences(faults, "lock-administrator")).toBe(1);
    expect(occurrences(faults, "lock-source-row")).toBe(1);
    await expectNothingWritten(admin, source, before);
  });

  for (const [sqlState, expected] of [
    ["40001", { code: "RETRYABLE_CONFLICT", sqlState: "40001" }],
    ["57014", { code: "STORAGE_FAILURE", sqlState: "57014" }],
  ] as const) {
    it(`classifies an injected ${sqlState} without retrying it, and writes nothing`, async () => {
      const { admin, challenge, code, source } = await faultScenario();
      await installFaultTrigger(sqlState);
      const before = await snapshot(admin, source, faultRivals);
      faults.hooks.log.length = 0;

      try {
        const outcome = await within(attempt(admin, challenge, { code, source, ops: faults }), "the operation");
        expect(outcome).toEqual({ ok: false, failure: expected });
        if (!outcome.ok) {
          expectSanitized(outcome.failure, [challenge, admin.secret]);
        }
      } finally {
        await removeFaultTrigger();
      }

      expect(occurrences(faults, "issue-session")).toBe(1);
      expect(occurrences(faults, "lock-administrator")).toBe(1);
      await expectNothingWritten(admin, source, before);
    });
  }

  it("classifies a duplicate token digest as INTEGRITY_CONFLICT (23505) and rolls back", async () => {
    const { admin, challenge, code, source } = await faultScenario();
    const taken = generateToken().digest;
    await faultRivals.query(
      `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
       values ($1, $2, $3, 'administrator', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '12 hours')`,
      [taken, randomUUID(), admin.id, new Date(current).toISOString()],
    );
    const before = await snapshot(admin, source, faultRivals);
    expect(before.sessions).toBe(1);
    faults.hooks.log.length = 0;

    const outcome = await attempt(admin, challenge, { code, source, sessionDigest: taken, ops: faults });
    expect(outcome).toEqual({
      ok: false,
      failure: { code: "INTEGRITY_CONFLICT", sqlState: "23505", constraint: "administrator_session_pkey" },
    });
    if (!outcome.ok) {
      expectSanitized(outcome.failure, [taken, challenge]);
    }
    expect(occurrences(faults, "issue-session")).toBe(1);
    expect(occurrences(faults, "lock-administrator")).toBe(1);

    // Only the seeded session remains; the challenge, step, counter and source are as before.
    await expectNothingWritten(admin, source, before);
  });

  it("rolls back a transaction whose connection is lost before COMMIT, with a sanitized failure", async () => {
    const { admin, challenge, code, source } = await faultScenario();
    await installFaultTrigger("sleep");
    const before = await snapshot(admin, source, faultRivals);
    faults.hooks.log.length = 0;

    try {
      const operation = attempt(admin, challenge, { code, source, ops: faults });
      const deadline = Date.now() + STEP_BOUND_MS;
      let pid: number | undefined;

      while (pid === undefined && Date.now() < deadline) {
        const { rows } = await faultRivals.query<{ pid: number }>(
          "select pid from pg_stat_activity where application_name = $1 and wait_event = 'PgSleep'",
          [OPERATION_APP],
        );
        pid = rows[0]?.pid;
        if (pid === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      expect(pid).toBeDefined();
      await faultRivals.query("select pg_terminate_backend($1)", [pid]);

      const outcome = await within(operation, "the interrupted operation");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        // A SQLSTATE is kept when the driver supplied one; none is required or fabricated (§12).
        expect(outcome.failure.code).toBe("STORAGE_FAILURE");
        expectSanitized(outcome.failure, [challenge, admin.secret]);
        const observed = (outcome.failure as { readonly sqlState?: string }).sqlState;
        // Reported, not required: which value arrives depends on whether the server's 57P01
        // notice beats the socket close. A Node system code is never labelled sqlState.
        console.info(`connection loss: sqlState ${observed === undefined ? "absent" : observed}`);
        expect(observed === undefined || GENUINE_SQLSTATE.test(observed)).toBe(true);
        expect(["ECONNRESET", "EPIPE"]).not.toContain(observed);
      }
    } finally {
      await removeFaultTrigger();
    }

    // Confirmed from a separate connection: nothing the transaction wrote is visible.
    expect(occurrences(faults, "issue-session")).toBe(1);
    await expectNothingWritten(admin, source, before);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Placeholder counter instants, and canaries in error outcomes                                 */
/* ------------------------------------------------------------------------------------------- */

/** The counter row for one subject: its count, and its instant as epoch milliseconds. */
async function counterOf(scope: "password" | "totp", subject: Buffer): Promise<Row | null> {
  const { rows } = await rivals.query(
    `select consecutive_failures, floor(extract(epoch from last_failure_at) * 1000)::bigint::text as at,
            last_failure_at = to_timestamp(0) as placeholder
       from authentication_throttle where scope = $1 and subject_digest = $2`,
    [scope, subject],
  );
  return rows[0] ?? null;
}

/** Committed counter rows still carrying the lock phase's epoch sentinel, anywhere. */
async function committedPlaceholders(): Promise<number> {
  const { rows } = await rivals.query<{ n: number }>(
    "select count(*)::int as n from authentication_throttle where last_failure_at = to_timestamp(0)",
  );
  return Number(rows[0]?.n);
}

describe("an empty counter row's epoch sentinel never survives a committed path", () => {
  it("a successful sign-in deletes the totp counter row its lock phase inserted", async () => {
    const admin = await seedAdministrator();
    expect(expectOk(await attempt(admin, await issueChallenge(admin))).code).toBe("SESSION_ISSUED");
    expect(await counterOf("totp", totpSubjectOf(admin.id))).toBeNull();
    expect(await committedPlaceholders()).toBe(0);
  });

  it("a wrong code, and a counted replay, overwrite it with the failure instant", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    expect(expectOk(await attempt(admin, challenge, { code: wrongCode(admin) })).code).toBe("FAILED");
    expect(await counterOf("totp", totpSubjectOf(admin.id))).toEqual({ consecutive_failures: 1, at: String(current), placeholder: false });

    const other = await seedAdministrator();
    const consumed = await issueChallenge(other);
    expect(expectOk(await attempt(other, consumed)).code).toBe("SESSION_ISSUED");
    current += 1_000;
    expect(expectOk(await attempt(other, consumed))).toMatchObject({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY" });
    expect(await counterOf("totp", totpSubjectOf(other.id))).toEqual({ consecutive_failures: 1, at: String(current), placeholder: false });
    expect(await committedPlaceholders()).toBe(0);
  });

  it("a password failure, for a known or an unknown username, records the failure instant", async () => {
    const admin = await seedAdministrator();
    const unknown = `nobody-${randomUUID().slice(0, 8)}`;
    expectOk(await failPassword(admin.id, admin.username, freshSource()));
    expectOk(await failPassword(undefined, unknown, freshSource()));

    for (const username of [admin.username, unknown]) {
      expect(await counterOf("password", usernameDigestOf(username))).toEqual({ consecutive_failures: 1, at: String(current), placeholder: false });
    }
    expect(await committedPlaceholders()).toBe(0);
  });

  it("a password success clears the counter, and an uncounted refusal rolls the empty row back", async () => {
    const admin = await seedAdministrator();
    expectOk(await failPassword(admin.id, admin.username, freshSource()));
    await issueChallenge(admin);
    expect(await counterOf("password", usernameDigestOf(admin.username))).toBeNull();

    const expiring = await issueChallenge(admin);
    current += auth.PENDING_CHALLENGE_LIFETIME_MS;
    expect(expectOk(await attempt(admin, expiring))).toEqual({ code: "REFUSED", reason: "EXPIRED_CHALLENGE" });
    expect(await counterOf("totp", totpSubjectOf(admin.id))).toBeNull();
    expect(await committedPlaceholders()).toBe(0);
  });
});

describe("sensitive canaries in representative error outcomes (not an exhaustive secrecy proof)", () => {
  it("never render the secret, keys, hash or token digests a failing operation handled", async () => {
    const admin = await seedAdministrator();
    const challenge = await issueChallenge(admin);
    const sessionDigest = generateToken().digest;
    const canaries = [admin.secret, TOTP_KEY, THROTTLE_KEY, challenge, sessionDigest, Buffer.from(STUB_HASH, "utf8")];
    const outcomes: unknown[] = [];

    outcomes.push(await withZeroed("issue-session", () => attempt(admin, challenge, { sessionDigest })));
    outcomes.push(await attempt(admin, challenge, { code: wrongCode(admin), sessionDigest }));
    outcomes.push(await attempt(admin, generateToken().digest, { sessionDigest }));
    outcomes.push(
      await auth.issuePasswordChallenge(
        main.db,
        {
          administratorId: admin.id,
          verifiedPasswordHash: `${STUB_HASH}x`,
          usernameDigest: usernameDigestOf(admin.username),
          challengeDigest: generateToken().digest,
        },
        main.clock,
      ),
    );
    outcomes.push(await checkSession(sessionDigest));

    expect(outcomes.map((outcome) => JSON.stringify(outcome))).toEqual([
      expect.stringContaining("ROW_COUNT_PROTOCOL_FAILURE"),
      expect.stringContaining("WRONG_CODE"),
      expect.stringContaining("UNKNOWN_CHALLENGE"),
      expect.stringContaining("PASSWORD_CHANGED"),
      expect.stringContaining("SESSION_REFUSED"),
    ]);

    for (const outcome of outcomes) {
      expectNoCanary(outcome, canaries);
    }
  });
});
