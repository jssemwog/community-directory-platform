/**
 * Attacking tests for the `ADR-029` recovery persistence operations (issue #266 §6.3–§6.9).
 *
 * Every test runs against a real PostgreSQL server from `embedded-postgres`, in one disposable
 * cluster, with an injected clock. **No unbuilt operation is simulated as a running operation**
 * (§6.10): a disabled account or password appears only as pre-existing test state, written
 * directly by test setup, as issue #258's suite did. Rival transactions here only hold locks or
 * set up state; they never stand in for revoke, disable, reset, key replacement or housekeeping.
 *
 * Statements are observed through a test-owned pool wrapper that reads each statement's
 * `adr028:<label>`. It records statement order and clock readings, can hold one labelled
 * statement at a barrier, and can report a labelled statement as having affected another count,
 * to attack the PS-8b required counts. It never alters what the server executed.
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
import { generateRecoveryCodes, recoveryCodeDigest, type GeneratedRecoveryCode } from "../domain/administrator-auth/recovery-code";
import { sealTotpSecret } from "../domain/administrator-auth/secret-box";
import { totpVerifierFor } from "../domain/administrator-auth/sign-in";
import { generateToken, type GeneratedToken } from "../domain/administrator-auth/token";
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

const MAIN_DATABASE = "recovery_persistence";
const FAULT_DATABASE = "recovery_persistence_faults";

const cluster = useEmbeddedPostgres({
  slug: "recovery-persistence",
  databases: [MAIN_DATABASE, FAULT_DATABASE],
  migrate: [MAIN_DATABASE, FAULT_DATABASE],
});

const OPERATION_APP = "adr029_operation";
const RIVAL_APP = "adr029_rival";
const STEP_BOUND_MS = 10_000;
const STUB_HASH = "scrypt$ln=17,r=8,p=1$c3R1Yi1zYWx0LTE2Ynl0ZQ$c3R1Yi1rZXk";

const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);

/** The injected clock. Each reading is recorded, in order, with the statements. */
let current = Date.UTC(2026, 10, 3, 12, 0, 0);

interface Hooks {
  readonly log: string[];
  /** `label:rowCount`, as the server reported it, for each labelled statement that completed. */
  readonly affected: string[];
  readonly zero: Set<string>;
  readonly counts: Map<string, number>;
  readonly pauses: Map<string, { readonly gate: Promise<void>; readonly reached: () => void }>;
}

function labelOf(text: string): string | undefined {
  const start = "/* adr028:";
  return text.startsWith(start) ? text.slice(start.length, text.indexOf(" */")) : undefined;
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
  const hooks: Hooks = { log: [], affected: [], zero: new Set(), counts: new Map(), pauses: new Map() };
  const pool = createPool(database, OPERATION_APP, 12);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();

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

          if (label !== undefined) {
            hooks.affected.push(`${label}:${result.rowCount ?? 0}`);
          }

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

  const db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
  const clock: auth.Clock = () => {
    hooks.log.push("clock");
    return current;
  };

  return { db, hooks, clock };
}

let main: Operations;
/** A second set of operations on the main database, with its own hooks, for held requests. */
let alt: Operations;
let faults: Operations;
let rivals: PgPool;
let faultRivals: PgPool;

beforeAll(async () => {
  main = createOperations(MAIN_DATABASE);
  alt = createOperations(MAIN_DATABASE);
  faults = createOperations(FAULT_DATABASE);
  rivals = createPool(MAIN_DATABASE, RIVAL_APP, 12);
  faultRivals = createPool(FAULT_DATABASE, RIVAL_APP, 6);
  cluster.closeBeforeShutdown("recovery operations", () => main.db.destroy());
  cluster.closeBeforeShutdown("recovery alternate operations", () => alt.db.destroy());
  cluster.closeBeforeShutdown("recovery fault operations", () => faults.db.destroy());
  cluster.closeBeforeShutdown("recovery rivals", () => rivals.end());
  cluster.closeBeforeShutdown("recovery fault rivals", () => faultRivals.end());
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
  readonly codes: readonly GeneratedRecoveryCode[];
}

const usernameDigestOf = (username: string) => keyedDigest(THROTTLE_KEY, "password-username", username);
/** The second-factor subject: the D-7 digest of the administrator id, shared by `totp` and `recovery_code`. */
const subjectOf = (id: string) => keyedDigest(THROTTLE_KEY, "totp-administrator", id);
/** The `recovery_code` counter's subject: its own purpose, as `recovery.ts` composes it (amendment 2). */
const recoverySubjectOf = (id: string) => keyedDigest(THROTTLE_KEY, "recovery-code-administrator", id);
const freshSource = () => keyedDigest(THROTTLE_KEY, "source-address", randomUUID());
const verifierAt = (secret: Buffer, code = totpCodeAt(secret, current)) => totpVerifierFor(TOTP_KEYS, code);

/** An administrator with a pending factor started by provisioning (origin `NULL`), no codes, no session. */
async function createWithPendingFactor(ops: Operations = main): Promise<Omit<Administrator, "codes">> {
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
  return { id, username, secret, factorId };
}

/** Legitimate initial provisioning: a pending factor confirmed with ten codes (RA-5). */
async function seed(ops: Operations = main): Promise<Administrator> {
  const admin = await createWithPendingFactor(ops);
  const codes = generateRecoveryCodes();
  expect(
    expectOk(
      await auth.confirmTotpEnrolmentWithRecoveryCodes(
        ops.db,
        { administratorId: admin.id, factorId: admin.factorId, verify: verifierAt(admin.secret), codeDigests: codes.map((c) => c.digest) },
        ops.clock,
      ),
    ),
  ).toEqual({ code: "ENROLMENT_CONFIRMED" });

  // Move past the confirmed step, so the first sign-in code is not a replay of it.
  current += 60_000;
  return { ...admin, codes };
}

async function challengeFor(admin: { readonly id: string; readonly username: string }, ops: Operations = main): Promise<Buffer> {
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

interface RecoverOptions {
  readonly source?: Buffer;
  readonly session?: GeneratedToken;
  readonly ops?: Operations;
}

/** Password (already a challenge), then a recovery code as typed. */
async function recover(challenge: Buffer, code: string, options: RecoverOptions = {}) {
  const ops = options.ops ?? main;
  const session = options.session ?? generateToken();
  const outcome = await auth.completeRecoveryChallenge(
    ops.db,
    {
      challengeDigest: challenge,
      sourceDigest: options.source ?? freshSource(),
      recoveryCodeSubjectDigestFor: recoverySubjectOf,
      codeDigest: () => recoveryCodeDigest(code),
      sessionTokenDigest: session.digest,
      sessionId: randomUUID(),
    },
    ops.clock,
  );
  return { outcome, session };
}

function totp(
  challenge: Buffer,
  secret: Buffer,
  options: { readonly code?: string; readonly source?: Buffer; readonly ops?: Operations; readonly verify?: auth.TotpVerifier } = {},
) {
  const ops = options.ops ?? main;
  return auth.completeTotpChallenge(
    ops.db,
    {
      challengeDigest: challenge,
      sourceDigest: options.source ?? freshSource(),
      totpSubjectDigestFor: subjectOf,
      verify: options.verify ?? verifierAt(secret, options.code),
      sessionTokenDigest: generateToken().digest,
      sessionId: randomUUID(),
    },
    ops.clock,
  );
}

/** A recovery session for `admin`, from a new challenge and the code at `index`. */
async function recoverySession(admin: Administrator, index = 0, ops: Operations = main): Promise<GeneratedToken> {
  const { outcome, session } = await recover(await challengeFor(admin, ops), admin.codes[index]?.code ?? "", { ops });
  expect(expectOk(outcome).code).toBe("RECOVERY_SESSION_ISSUED");
  return session;
}

async function start(recovery: Buffer, ops: Operations = main) {
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const stored = await auth.startRecoveryReenrolment(
    ops.db,
    { recoveryTokenDigest: recovery, factorId, seal: (id) => sealTotpSecret(TOTP_KEY, 1, id, secret) },
    ops.clock,
  );
  return { stored, secret, factorId };
}

async function complete(recovery: Buffer, factorId: string, code: string, ops: Operations = main) {
  const codes = generateRecoveryCodes();
  const stored = await auth.completeRecoveryReenrolment(
    ops.db,
    { recoveryTokenDigest: recovery, factorId, verify: totpVerifierFor(TOTP_KEYS, code), codeDigests: codes.map((c) => c.digest) },
    ops.clock,
  );
  return { stored, codes };
}

async function regenerate(recovery: Buffer, ops: Operations = main) {
  const codes = generateRecoveryCodes();
  const stored = await auth.regenerateRecoveryCodes(ops.db, { recoveryTokenDigest: recovery, codeDigests: codes.map((c) => c.digest) }, ops.clock);
  return { stored, codes };
}

/** The whole authentication state of one administrator, plus a source's rolling record. */
async function fullState(admin: { readonly id: string; readonly username: string }, source?: Buffer, pool: PgPool = rivals) {
  const rows = async (text: string, values: readonly unknown[]) => (await pool.query(text, values)).rows;

  return {
    factor: (
      await rows(
        `select state, factor_id, encode(secret_ciphertext, 'hex') as ciphertext, encode(secret_iv, 'hex') as iv,
                encode(secret_tag, 'hex') as tag, key_version, last_accepted_step::text as step,
                origin_recovery_session_id as origin
           from administrator_totp_factor where administrator_id = $1`,
        [admin.id],
      )
    )[0],
    codes: (await rows("select encode(code_digest, 'hex') as d from administrator_recovery_code where administrator_id = $1 order by 1", [admin.id])).map((r) => r.d),
    sessions: await rows(
      `select encode(token_digest, 'hex') as d, id, kind, created_at::text as c, last_activity_at::text as a,
              absolute_expires_at::text as x
         from administrator_session where administrator_id = $1 order by 1`,
      [admin.id],
    ),
    pending: await rows(
      "select encode(token_digest, 'hex') as d, invalidated, expires_at::text as x from administrator_pending_challenge where administrator_id = $1 order by 1",
      [admin.id],
    ),
    consumed: await rows(
      "select encode(token_digest, 'hex') as d, expires_at::text as x from administrator_consumed_challenge where administrator_id = $1 order by 1",
      [admin.id],
    ),
    counters: await rows(
      `select scope, consecutive_failures, wait_until::text as w, last_failure_at::text as l
         from authentication_throttle where subject_digest = any($1) order by scope`,
      [[subjectOf(admin.id), recoverySubjectOf(admin.id), usernameDigestOf(admin.username)]],
    ),
    source:
      source === undefined
        ? null
        : ((await rows("select recent_failures::text as r from authentication_source_window where source_digest = $1", [source]))[0]?.r ?? null),
    administrator: (
      await rows(
        "select password_hash, password_disabled_at::text as p, disabled_at::text as d from administrator where id = $1",
        [admin.id],
      )
    )[0],
  };
}

type State = Awaited<ReturnType<typeof fullState>>;

const sourceFailures = (state: State) => {
  const recorded = state.source === null ? "{}" : String(state.source);
  return recorded === "{}" ? 0 : recorded.split(",").length;
};
const counterOf = (state: State, scope: string) => state.counters.find((c) => c.scope === scope)?.consecutive_failures ?? null;

/** A test-only transaction on its own connection, explicit READ COMMITTED. Holds locks or writes setup state. */
interface Rival {
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<PgResult<R>>;
  commit(): Promise<void>;
}

async function rival(pool: PgPool = rivals): Promise<Rival> {
  const client = await pool.connect();
  await client.query("begin isolation level read committed");
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

  return { query: (text, values) => client.query(text, values), commit: () => finish("commit") };
}

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
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${STEP_BOUND_MS} ms`)), STEP_BOUND_MS)),
  ]);
}

/** Pre-existing test state only (§6.10): never a running disable operation. */
async function setDisabled(id: string, column: "disabled_at" | "password_disabled_at"): Promise<void> {
  await rivals.query(`update administrator set ${column} = $2 where id = $1`, [id, new Date(current).toISOString()]);
}

async function setCounter(scope: "totp" | "recovery_code", id: string, failures: number, waitUntil: number | null = null): Promise<void> {
  await rivals.query(
    `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
     values ($1, $2, $3, $4, $5)
     on conflict (scope, subject_digest) do update set consecutive_failures = excluded.consecutive_failures,
       wait_until = excluded.wait_until, last_failure_at = excluded.last_failure_at`,
    [
      scope,
      scope === "recovery_code" ? recoverySubjectOf(id) : subjectOf(id),
      failures,
      // From the 5th failure a wait must exist (`authentication_throttle_wait_check`); default to an expired one.
      waitUntil === null ? (failures >= 5 ? new Date(current - 1).toISOString() : null) : new Date(waitUntil).toISOString(),
      new Date(current).toISOString(),
    ],
  );
}

async function presetSource(source: Buffer, failures: number): Promise<void> {
  await rivals.query(
    `insert into authentication_source_window (source_digest, recent_failures)
     values ($1, array(select $2::timestamptz - make_interval(secs => g) from generate_series(1, $3::int) g))`,
    [source, new Date(current).toISOString(), failures],
  );
}

async function deleteCodesExcept(id: string, keep: GeneratedRecoveryCode): Promise<void> {
  await rivals.query("delete from administrator_recovery_code where administrator_id = $1 and code_digest <> $2", [id, keep.digest]);
}

const occurrences = (ops: Operations, label: string) => ops.hooks.log.filter((entry) => entry === label).length;

const protocolFailure = (statement: string, expected: number, actual: number) => ({
  ok: false,
  failure: { code: "ROW_COUNT_PROTOCOL_FAILURE", statement, expected, actual },
});

/**
 * One attempt, no retry: since `since`, every labelled statement was sent once, and the last one
 * sent is the one that failed, so nothing ran after it and nothing was re-sent.
 */
function expectSingleAttempt(since: number, failed: string, ops: Operations = main): void {
  const sent = ops.hooks.log.slice(since).filter((entry) => entry !== "clock");
  expect(sent.at(-1), `${failed}: ${sent.join(", ")}`).toBe(failed);
  expect(new Set(sent).size, `${failed}: ${sent.join(", ")}`).toBe(sent.length);
}

async function withZeroed<T>(label: string, body: () => Promise<T>, ops: Operations = main): Promise<T> {
  ops.hooks.zero.add(label);
  try {
    return await body();
  } finally {
    ops.hooks.zero.delete(label);
  }
}

async function withCount<T>(label: string, count: number, body: () => Promise<T>, ops: Operations = main): Promise<T> {
  ops.hooks.counts.set(label, count);
  try {
    return await body();
  } finally {
    ops.hooks.counts.delete(label);
  }
}

/** PostgreSQL renders bytea as a backslash, `x`, then hex. */
const BACKSLASH = String.fromCharCode(92);

function expectNoCanary(value: unknown, canaries: readonly (Buffer | string)[]): void {
  const renderings = [JSON.stringify(value), inspect(value, { depth: null }), String(value)];

  for (const rendered of renderings) {
    for (const canary of canaries) {
      const forms =
        typeof canary === "string"
          ? [canary, canary.split("-").join("")]
          : [canary.toString("hex"), `${BACKSLASH}x${canary.toString("hex")}`, canary.toString("base64"), canary.toString("base64url")];
      for (const form of forms) {
        expect(rendered).not.toContain(form);
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* §6.3 The origin's value after every operation                                                */
/* ------------------------------------------------------------------------------------------- */

const originOf = async (id: string) =>
  (await rivals.query<{ origin: string | null; state: string }>(
    "select origin_recovery_session_id as origin, state from administrator_totp_factor where administrator_id = $1",
    [id],
  )).rows[0];

const sessionIdOf = async (token: GeneratedToken) =>
  (await rivals.query<{ id: string }>("select id from administrator_session where token_digest = $1", [token.digest])).rows[0]?.id;

describe("§6.3 the origin after every operation that creates, replaces, discards or activates a factor", () => {
  it("startTotpEnrolment (insert) writes NULL; RA-5 confirmation keeps NULL and activates", async () => {
    const pending = await createWithPendingFactor();
    expect(await originOf(pending.id)).toEqual({ origin: null, state: "pending_confirmation" });

    const admin = await seed();
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "active" });
  });

  it("the existing confirmTotpEnrolment on a NULL origin activates exactly as before", async () => {
    const pending = await createWithPendingFactor();
    expect(
      expectOk(await auth.confirmTotpEnrolment(main.db, { administratorId: pending.id, factorId: pending.factorId, step: totpStepAt(current) }, main.clock)),
    ).toEqual({ code: "ENROLMENT_CONFIRMED" });
    expect(await originOf(pending.id)).toEqual({ origin: null, state: "active" });
  });

  it("RA-1 discards an active factor and a pending one, nulling the origin", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "reenrolment_required" });

    // A pending factor with an origin, then a further code success, discards it too.
    expect(expectOk((await start(q.digest)).stored).code).toBe("REENROLMENT_STARTED");
    expect((await originOf(admin.id))?.origin).toBe(await sessionIdOf(q));
    await recoverySession(admin, 1);
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "reenrolment_required" });
  });

  it("recovery start writes Q.id on insert and on upsert; a second start keeps Q.id with a new factor_id", async () => {
    // Insert path: an administrator with codes but no factor row at all (setup state).
    const id = randomUUID();
    const username = `admin-${id.slice(0, 8)}`;
    expectOk(await auth.createAdministrator(main.db, { administratorId: id, username, passwordHash: STUB_HASH }, main.clock));
    const codes = generateRecoveryCodes();
    await rivals.query(
      "insert into administrator_recovery_code (administrator_id, code_digest) select $1, d from unnest($2::bytea[]) d",
      [id, codes.map((c) => c.digest)],
    );
    const { outcome, session } = await recover(await challengeFor({ id, username }), codes[0]?.code ?? "");
    expect(expectOk(outcome).code).toBe("RECOVERY_SESSION_ISSUED");
    expect(await originOf(id)).toBeUndefined();

    const first = await start(session.digest);
    expect(expectOk(first.stored).code).toBe("REENROLMENT_STARTED");
    const qId = await sessionIdOf(session);
    expect(await originOf(id)).toEqual({ origin: qId, state: "pending_confirmation" });

    // Upsert path, and a second start in the same Q.
    const second = await start(session.digest);
    expect(expectOk(second.stored).code).toBe("REENROLMENT_STARTED");
    const after = (await rivals.query("select factor_id, origin_recovery_session_id as origin from administrator_totp_factor where administrator_id = $1", [id])).rows[0];
    expect(after).toEqual({ factor_id: second.factorId, origin: qId });
    expect(second.factorId).not.toBe(first.factorId);
  });

  it("completion nulls the origin and activates; the TOTP step advance and the TOTP ceiling keep NULL", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const started = await start(q.digest);
    expect(expectOk((await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored).code).toBe("REENROLMENT_COMPLETED");
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "active" });

    current += 60_000;
    expect(expectOk(await totp(await challengeFor(admin), started.secret)).code).toBe("SESSION_ISSUED");
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "active" });

    current += 60_000;
    await setCounter("totp", admin.id, 99, current - 1);
    const wrong = await totp(await challengeFor(admin), started.secret, { code: "000000" === totpCodeAt(started.secret, current) ? "000001" : "000000" });
    expect(expectOk(wrong)).toMatchObject({ code: "FAILED", factorDisabled: true });
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "reenrolment_required" });
  });

  it("logout of Q and Q's expiry leave the origin unchanged", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    expectOk((await start(q.digest)).stored);
    const qId = await sessionIdOf(q);

    expectOk(await auth.logout(main.db, { tokenDigest: q.digest }));
    expect((await originOf(admin.id))?.origin).toBe(qId);

    const other = await seed();
    const q2 = await recoverySession(other, 0);
    expectOk((await start(q2.digest)).stored);
    const q2Id = await sessionIdOf(q2);
    current += auth.RECOVERY_SESSION_ABSOLUTE_MS + 1;
    expect((await originOf(other.id))?.origin).toBe(q2Id);
  });

  it("characterization (caller-restricted gap): startTotpEnrolment upserting over a recovery-origin row keeps the origin", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    expectOk((await start(q.digest)).stored);
    const qId = await sessionIdOf(q);

    expectOk(
      await auth.startTotpEnrolment(
        main.db,
        { administratorId: admin.id, factorId: randomUUID(), material: sealTotpSecret(TOTP_KEY, 1, admin.id, generateTotpSecret()) },
        main.clock,
      ),
    );
    expect(await originOf(admin.id)).toEqual({ origin: qId, state: "pending_confirmation" });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* §6.4 Recovery code to restricted session                                                      */
/* ------------------------------------------------------------------------------------------- */

describe("§6.4 a recovery-code success", () => {
  it("consumes one code and the challenge, keeps only a new 15-minute recovery session, and discards the factor", async () => {
    const admin = await seed();
    // A live administrator session and another pending challenge, both to be ended.
    expect(expectOk(await totp(await challengeFor(admin), admin.secret)).code).toBe("SESSION_ISSUED");
    const other = await challengeFor(admin);
    const challenge = await challengeFor(admin);
    await setCounter("recovery_code", admin.id, 2);
    const originalExpiry = (await fullState(admin)).pending.find((p) => p.d === challenge.toString("hex"))?.x;
    expect(originalExpiry).toBeDefined();

    const { outcome, session } = await recover(challenge, admin.codes[3]?.code ?? "");
    const value = expectOk(outcome);
    expect(value).toMatchObject({ code: "RECOVERY_SESSION_ISSUED", administratorId: admin.id, absoluteExpiresAt: current + 15 * 60_000 });

    const state = await fullState(admin);
    expect(state.codes).toHaveLength(9);
    expect(state.codes).not.toContain(admin.codes[3]?.digest.toString("hex"));
    expect(state.consumed.map((c) => c.d)).toContain(challenge.toString("hex"));
    // Consumed with its original expiry, not the consumption instant.
    expect(state.consumed.find((c) => c.d === challenge.toString("hex"))?.x).toBe(originalExpiry);
    expect(state.pending.find((p) => p.d === challenge.toString("hex"))).toBeUndefined();
    expect(state.pending.find((p) => p.d === other.toString("hex"))?.invalidated).toBe(true);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ d: session.digest.toString("hex"), kind: "recovery" });
    expect(counterOf(state, "recovery_code")).toBeNull();
    expect(state.factor).toEqual({
      state: "reenrolment_required", factor_id: null, ciphertext: null, iv: null, tag: null, key_version: null, step: null, origin: null,
    });

    expect(expectOk(await auth.checkSession(main.db, { tokenDigest: session.digest }, main.clock))).toMatchObject({ code: "SESSION_VALID", kind: "recovery" });
  });

  it("leaves a factor that is already reenrolment_required unchanged", async () => {
    const admin = await seed();
    await recoverySession(admin, 0);
    const before = (await fullState(admin)).factor;
    await recoverySession(admin, 1);
    expect((await fullState(admin)).factor).toEqual(before);
  });

  it("after a code success, password plus the old TOTP on a new challenge is refused FACTOR_UNAVAILABLE, uncounted", async () => {
    const admin = await seed();
    await recoverySession(admin, 0);
    const source = freshSource();
    const challenge = await challengeFor(admin);
    const before = await fullState(admin, source);

    expect(expectOk(await totp(challenge, admin.secret, { source }))).toEqual({ code: "REFUSED", reason: "FACTOR_UNAVAILABLE" });
    expect(await fullState(admin, source)).toEqual(before);
  });

  it("the ADR-004 P-5 route: with the factor reenrolment_required or pending, password plus a code opens a recovery session", async () => {
    const ceilinged = await seed();
    await setCounter("totp", ceilinged.id, 99, current - 1);
    expect(expectOk(await totp(await challengeFor(ceilinged), ceilinged.secret, { code: "999999" === totpCodeAt(ceilinged.secret, current) ? "999998" : "999999" }))).toMatchObject({ factorDisabled: true });
    await recoverySession(ceilinged, 0);

    const pending = await createWithPendingFactor();
    const codes = generateRecoveryCodes();
    await rivals.query("insert into administrator_recovery_code (administrator_id, code_digest) select $1, d from unnest($2::bytea[]) d", [pending.id, codes.map((c) => c.digest)]);
    const { outcome } = await recover(await challengeFor(pending), codes[0]?.code ?? "");
    expect(expectOk(outcome).code).toBe("RECOVERY_SESSION_ISSUED");
  });
});

describe("§6.4 refusals and accounting", () => {
  it("counts wrong, already-used and unparseable codes exactly once each, and leaves the challenge live", async () => {
    const admin = await seed();
    await recoverySession(admin, 0);
    const source = freshSource();
    const challenge = await challengeFor(admin);

    for (const [presented, expected] of [
      [generateRecoveryCodes()[0]?.code ?? "", 1],
      [admin.codes[0]?.code ?? "", 2],
      ["not-a-recovery-code", 3],
      ["", 4],
    ] as const) {
      const before = await fullState(admin, source);
      const { outcome } = await recover(challenge, presented, { source });
      expect(expectOk(outcome)).toEqual({ code: "FAILED", reason: "WRONG_CODE", consecutiveFailures: expected, codesDisabled: false });
      const after = await fullState(admin, source);
      expect(counterOf(after, "recovery_code")).toBe(expected);
      expect(sourceFailures(after)).toBe(sourceFailures(before) + 1);
      expect(after.pending.find((p) => p.d === challenge.toString("hex"))?.invalidated).toBe(false);
      expect({ ...after, counters: [], source: null }).toEqual({ ...before, counters: [], source: null });
    }
  });

  it("refuses unknown, expired, disabled (account or password) and invalidated challenges, an active wait and the source limit, uncounted", async () => {
    const cases: Array<[string, () => Promise<{ admin: Administrator; challenge: Buffer; source: Buffer }>, string]> = [
      ["unknown", async () => ({ admin: await seed(), challenge: randomBytes(32), source: freshSource() }), "UNKNOWN_CHALLENGE"],
      ["expired", async () => {
        const admin = await seed();
        const challenge = await challengeFor(admin);
        current += 5 * 60_000;
        return { admin, challenge, source: freshSource() };
      }, "EXPIRED_CHALLENGE"],
      ["account disabled", async () => {
        const admin = await seed();
        const challenge = await challengeFor(admin);
        await setDisabled(admin.id, "disabled_at");
        return { admin, challenge, source: freshSource() };
      }, "ACCOUNT_DISABLED"],
      ["password disabled", async () => {
        const admin = await seed();
        const challenge = await challengeFor(admin);
        await setDisabled(admin.id, "password_disabled_at");
        return { admin, challenge, source: freshSource() };
      }, "ACCOUNT_DISABLED"],
      ["invalidated", async () => {
        const admin = await seed();
        const challenge = await challengeFor(admin);
        await rivals.query("update administrator_pending_challenge set invalidated = true where token_digest = $1", [challenge]);
        return { admin, challenge, source: freshSource() };
      }, "INVALIDATED_CHALLENGE"],
      ["active wait", async () => {
        const admin = await seed();
        const challenge = await challengeFor(admin);
        await setCounter("recovery_code", admin.id, 5, current + 30_000);
        return { admin, challenge, source: freshSource() };
      }, "THROTTLED"],
      ["source limit", async () => {
        const admin = await seed();
        const challenge = await challengeFor(admin);
        const source = freshSource();
        await presetSource(source, 20);
        return { admin, challenge, source };
      }, "THROTTLED"],
    ];

    for (const [name, prepare, reason] of cases) {
      const { admin, challenge, source } = await prepare();
      const before = await fullState(admin, source);
      const { outcome } = await recover(challenge, admin.codes[0]?.code ?? "", { source });
      expect(expectOk(outcome), name).toEqual({ code: "REFUSED", reason });
      // Nothing counted, and the lock phase's empty counter and source rows rolled back.
      expect(await fullState(admin, source), name).toEqual(before);
    }
  });

  it("counts a consumed challenge as a replay whatever the code, within its lifetime", async () => {
    const admin = await seed();
    const challenge = await challengeFor(admin);
    expect(expectOk((await recover(challenge, admin.codes[0]?.code ?? "")).outcome).code).toBe("RECOVERY_SESSION_ISSUED");

    for (const presented of [admin.codes[1]?.code ?? "", "garbage"]) {
      expect(expectOk((await recover(challenge, presented)).outcome)).toMatchObject({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY" });
    }
    expect((await fullState(admin)).codes).toHaveLength(9);
  });

  it("waits from the 5th failure, doubling from 30 seconds and capped at one hour", async () => {
    const admin = await seed();
    const waitAfter = async (prior: number) => {
      await setCounter("recovery_code", admin.id, prior);
      const challenge = await challengeFor(admin);
      const before = current;
      const { outcome } = await recover(challenge, "wrong");
      expect(expectOk(outcome)).toMatchObject({ code: "FAILED", consecutiveFailures: prior + 1 });
      const row = (await rivals.query<{ w: number }>(
        "select (extract(epoch from wait_until) * 1000)::bigint as w from authentication_throttle where scope = 'recovery_code' and subject_digest = $1",
        [recoverySubjectOf(admin.id)],
      )).rows[0];
      return row?.w === undefined || row.w === null ? null : Number(row.w) - before;
    };

    expect(await waitAfter(3)).toBeNull();
    expect(await waitAfter(4)).toBe(30_000);
    expect(await waitAfter(5)).toBe(60_000);
    expect(await waitAfter(20)).toBe(60 * 60_000);
  });

  it("at the 100th failure deletes the remaining codes and invalidates challenges, deletes no session, keeps the counter, and spares an active factor", async () => {
    const admin = await seed();
    expect(expectOk(await totp(await challengeFor(admin), admin.secret)).code).toBe("SESSION_ISSUED");
    current += 60_000;
    const other = await challengeFor(admin);
    await setCounter("recovery_code", admin.id, 99);

    const { outcome } = await recover(await challengeFor(admin), "wrong");
    expect(expectOk(outcome)).toEqual({ code: "FAILED", reason: "WRONG_CODE", consecutiveFailures: 100, codesDisabled: true });

    const state = await fullState(admin);
    expect(state.codes).toEqual([]);
    expect(state.pending.every((p) => p.invalidated === true)).toBe(true);
    expect(state.pending.map((p) => p.d)).toContain(other.toString("hex"));
    expect(state.sessions.map((s) => s.kind)).toEqual(["administrator"]);
    expect(counterOf(state, "recovery_code")).toBe(100);
    expect(state.factor?.state).toBe("active");

    // Password plus TOTP still signs in.
    expect(expectOk(await totp(await challengeFor(admin), admin.secret)).code).toBe("SESSION_ISSUED");
  });

  it("regression (§5.1): a malformed TOTP code on a live challenge with an active factor is counted WRONG_CODE", async () => {
    const admin = await seed();
    const source = freshSource();

    for (const code of ["12345", "1234567", "12345a", ""]) {
      const outcome = await totp(await challengeFor(admin), admin.secret, { code, source });
      expect(expectOk(outcome), code).toMatchObject({ code: "FAILED", reason: "WRONG_CODE" });
    }
    const state = await fullState(admin, source);
    expect(counterOf(state, "totp")).toBe(4);
    expect(sourceFailures(state)).toBe(4);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* §6.4 Concurrency: each race twice in forced order, then concurrently                          */
/* ------------------------------------------------------------------------------------------- */

/** An order-independent description of the end state, with challenge and session digests named. */
function describeEnd(state: State, names: Record<string, Buffer>) {
  const name = (hex: unknown) => Object.entries(names).find(([, digest]) => digest.toString("hex") === hex)?.[0] ?? "other";
  return {
    sessions: state.sessions.map((s) => `${s.kind}:${name(s.d)}`).sort(),
    factor: state.factor === undefined ? null : { state: state.factor.state, origin: state.factor.origin !== null, material: state.factor.ciphertext !== null },
    codes: state.codes.length,
    pending: state.pending.map((p) => `${name(p.d)}:${p.invalidated ? "invalidated" : "live"}`).sort(),
    consumed: state.consumed.map((c) => name(c.d)).sort(),
    counters: state.counters.map((c) => `${c.scope}:${c.consecutive_failures}`).sort(),
    source: sourceFailures(state),
  };
}

type Ending = ReturnType<typeof describeEnd>;

/** An outcome's code and, if any, its reason: `CODE` or `CODE/REASON`. */
function kind(outcome: unknown): string {
  const value = outcome as { readonly code?: string; readonly reason?: string };
  return value.reason === undefined ? String(value.code) : `${value.code}/${value.reason}`;
}

const countOf = (log: readonly string[], label: string) => log.filter((entry) => entry === label).length;

interface RaceRun<S, A, B> {
  readonly setup: S;
  readonly a: A;
  readonly b: B;
  /** The labelled statements the main operations sent during the run, in order. */
  readonly log: readonly string[];
  /** `label:rowCount`, as the server reported it, for each labelled statement completed during the run. */
  readonly affected: readonly string[];
  readonly end: Ending;
}

/**
 * Runs `a` then `b`, `b` then `a`, and both concurrently, each on a fresh setup. Every step is
 * bounded by 10 s, and every outcome must be a stored success (no `40P01`, nor any other storage
 * failure). The concurrent end state must equal one of the two forced ones, **with the outcomes of
 * that order**. No waiter order is assumed.
 */
async function raceBothWays<S, A, B>(
  prepare: () => Promise<S>,
  a: (s: S) => Promise<auth.Stored<A>>,
  b: (s: S) => Promise<auth.Stored<B>>,
  end: (s: S) => Promise<Ending>,
): Promise<{ readonly ab: RaceRun<S, A, B>; readonly ba: RaceRun<S, A, B>; readonly both: RaceRun<S, A, B> }> {
  const run = async (order: "ab" | "ba" | "both"): Promise<RaceRun<S, A, B>> => {
    const setup = await prepare();
    const mark = main.hooks.log.length;
    const affectedMark = main.hooks.affected.length;
    let ra: auth.Stored<A>;
    let rb: auth.Stored<B>;

    if (order === "ab") {
      ra = await within(a(setup), "a, run first");
      rb = await within(b(setup), "b, run second");
    } else if (order === "ba") {
      rb = await within(b(setup), "b, run first");
      ra = await within(a(setup), "a, run second");
    } else {
      [ra, rb] = await within(Promise.all([a(setup), b(setup)]), "the concurrent pair");
    }

    return {
      setup,
      a: expectOk(ra),
      b: expectOk(rb),
      log: main.hooks.log.slice(mark).filter((entry) => entry !== "clock"),
      affected: main.hooks.affected.slice(affectedMark),
      end: await end(setup),
    };
  };

  const ab = await run("ab");
  const ba = await run("ba");
  const both = await run("both");
  const matching = [ab, ba].filter((forced) => JSON.stringify(forced.end) === JSON.stringify(both.end));

  expect(matching.length, "the concurrent end state equals a forced one").toBeGreaterThan(0);
  expect(matching.map((forced) => [kind(forced.a), kind(forced.b)])).toContainEqual([kind(both.a), kind(both.b)]);
  return { ab, ba, both };
}

/** The forced run whose end state the concurrent run reached (the first, if both orders agree). */
function orderOf<S, A, B>(race: { readonly ab: RaceRun<S, A, B>; readonly ba: RaceRun<S, A, B>; readonly both: RaceRun<S, A, B> }) {
  return JSON.stringify(race.both.end) === JSON.stringify(race.ab.end) ? race.ab : race.ba;
}

const codeDigestsOf = async (id: string) =>
  (await rivals.query<{ d: string }>("select encode(code_digest, 'hex') as d from administrator_recovery_code where administrator_id = $1", [id])).rows.map((r) => r.d);

describe("§6.4 concurrency", () => {
  it("C-1: one code on one challenge, five submissions: one recovery session and four counted consumed replays", async () => {
    const admin = await seed();
    const challenge = await challengeFor(admin);
    const source = freshSource();
    const code = admin.codes[0]?.code ?? "";

    const outcomes = await within(Promise.all(Array.from({ length: 5 }, () => recover(challenge, code, { source }))), "five submissions");
    const values = outcomes.map((o) => expectOk(o.outcome));
    expect(values.filter((v) => v.code === "RECOVERY_SESSION_ISSUED")).toHaveLength(1);
    expect(values.filter((v) => v.code === "FAILED" && v.reason === "CONSUMED_CHALLENGE_REPLAY")).toHaveLength(4);

    const state = await fullState(admin, source);
    expect(state.codes).toHaveLength(9);
    expect(state.sessions.map((s) => s.kind)).toEqual(["recovery"]);
    expect(counterOf(state, "recovery_code")).toBe(4);
    expect(sourceFailures(state)).toBe(4);
  });

  it("C-2: one code, two live challenges: the second is refused invalidated before its code delete, uncounted", async () => {
    const prepare = async () => {
      const admin = await seed();
      return { admin, A: await challengeFor(admin), B: await challengeFor(admin), RA: generateToken(), RB: generateToken(), source: freshSource() };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const onA = async (s: S) => (await recover(s.A, s.admin.codes[0]?.code ?? "", { session: s.RA, source: s.source })).outcome;
    const onB = async (s: S) => (await recover(s.B, s.admin.codes[0]?.code ?? "", { session: s.RB, source: s.source })).outcome;
    const end = async (s: S) => describeEnd(await fullState(s.admin, s.source), { A: s.A, B: s.B, RA: s.RA.digest, RB: s.RB.digest });

    const race = await raceBothWays(prepare, onA, onB, end);
    const { ab, ba } = race;
    expect([kind(ab.a), kind(ab.b)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect([kind(ba.b), kind(ba.a)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect(ab.end).toMatchObject({ sessions: ["recovery:RA"], consumed: ["A"], pending: ["B:invalidated"] });
    expect(ba.end).toMatchObject({ sessions: ["recovery:RB"], consumed: ["B"], pending: ["A:invalidated"] });

    for (const run of [ab, ba, race.both]) {
      // The loser is refused before its code DELETE: exactly one code DELETE is sent in the run.
      expect(countOf(run.log, "consume-recovery-code")).toBe(1);
      expect(countOf(run.log, "count-failure")).toBe(0);
      expect(run.end).toMatchObject({ codes: 9, counters: [], source: 0 });
    }
  });

  it("C-3: two different valid codes on one challenge: the loser is a consumed replay before its code delete, and its code stays", async () => {
    const prepare = async () => {
      const admin = await seed();
      return { admin, A: await challengeFor(admin), R0: generateToken(), R1: generateToken(), source: freshSource() };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const first = async (s: S) => (await recover(s.A, s.admin.codes[0]?.code ?? "", { session: s.R0, source: s.source })).outcome;
    const second = async (s: S) => (await recover(s.A, s.admin.codes[1]?.code ?? "", { session: s.R1, source: s.source })).outcome;
    const end = async (s: S) => describeEnd(await fullState(s.admin, s.source), { A: s.A, R0: s.R0.digest, R1: s.R1.digest });

    const race = await raceBothWays(prepare, first, second, end);
    const { ab, ba } = race;
    expect(kind(ab.a)).toBe("RECOVERY_SESSION_ISSUED");
    expect(ab.b).toEqual({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY", consecutiveFailures: 1, codesDisabled: false });
    expect(kind(ba.b)).toBe("RECOVERY_SESSION_ISSUED");
    expect(ba.a).toEqual({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY", consecutiveFailures: 1, codesDisabled: false });

    for (const run of [ab, ba, race.both]) {
      expect(countOf(run.log, "consume-recovery-code")).toBe(1);
      // 9 codes, a counter of 1 and exactly one new source-window instant.
      expect(run.end).toMatchObject({ codes: 9, counters: ["recovery_code:1"], source: 1, consumed: ["A"] });
      const loser = kind(run.a) === "RECOVERY_SESSION_ISSUED" ? 1 : 0;
      expect(await codeDigestsOf(run.setup.admin.id)).toContain(run.setup.admin.codes[loser]?.digest.toString("hex"));
      expect(run.end.sessions).toEqual([loser === 1 ? "recovery:R0" : "recovery:R1"]);
    }
  });

  it("C-4: a code success on A against a TOTP completion on B: one recovery session, the factor discarded, nothing counted", async () => {
    const prepare = async () => {
      const admin = await seed();
      return { admin, A: await challengeFor(admin), B: await challengeFor(admin), RA: generateToken(), source: freshSource(), verifications: { n: 0 } };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const r = async (s: S) => (await recover(s.A, s.admin.codes[0]?.code ?? "", { session: s.RA, source: s.source })).outcome;
    const t = (s: S) =>
      totp(s.B, s.admin.secret, {
        source: s.source,
        verify: (factor, now) => {
          s.verifications.n += 1;
          return verifierAt(s.admin.secret)(factor, now);
        },
      });
    const end = async (s: S) => describeEnd(await fullState(s.admin, s.source), { A: s.A, B: s.B, RA: s.RA.digest });

    const race = await raceBothWays(prepare, r, t, end);
    const { ab, ba } = race;
    // R first: B is invalidated, and T is refused before verification.
    expect([kind(ab.a), kind(ab.b)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect(ab.setup.verifications.n).toBe(0);
    expect(ab.affected).toContain("delete-sessions:0");
    expect(ab.end.pending).toEqual(["B:invalidated"]);
    // T first: S is issued, then R deletes S (one row) and discards F.
    expect([kind(ba.b), kind(ba.a)]).toEqual(["SESSION_ISSUED", "RECOVERY_SESSION_ISSUED"]);
    expect(ba.setup.verifications.n).toBe(1);
    expect(ba.affected).toContain("delete-sessions:1");
    expect(ba.end.consumed).toEqual(["A", "B"]);

    for (const run of [ab, ba, race.both]) {
      expect(run.end).toMatchObject({
        sessions: ["recovery:RA"],
        factor: { state: "reenrolment_required", origin: false, material: false },
        codes: 9,
        counters: [],
        source: 0,
      });
    }
    expect(race.both.setup.verifications.n).toBe(orderOf(race).setup.verifications.n);
  });

  it("C-5: regeneration in Q against a new sign-in with an old code: exactly one takes effect, nothing counted", async () => {
    const prepare = async () => {
      const admin = await seed();
      const q = await recoverySession(admin, 0);
      return { admin, q, B: await challengeFor(admin), R: generateToken() };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const g = async (s: S) => (await regenerate(s.q.digest)).stored;
    const r = async (s: S) => (await recover(s.B, s.admin.codes[1]?.code ?? "", { session: s.R })).outcome;
    const end = async (s: S) => describeEnd(await fullState(s.admin), { B: s.B, Q: s.q.digest, Q2: s.R.digest });

    const { ab, ba } = await raceBothWays(prepare, g, r, end);
    // Regeneration first: B is invalidated, and R is refused uncounted; Q is kept.
    expect([kind(ab.a), kind(ab.b)]).toEqual(["RECOVERY_CODES_REGENERATED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect(ab.end).toMatchObject({ codes: 10, sessions: ["recovery:Q"], pending: ["B:invalidated"], counters: [] });
    // R first: Q is deleted, Q2 issued, the factor discarded, and regeneration rolls back.
    expect([kind(ba.b), kind(ba.a)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/RECOVERY_SESSION_INVALID"]);
    expect(ba.end).toMatchObject({
      codes: 8,
      sessions: ["recovery:Q2"],
      consumed: expect.arrayContaining(["B"]),
      counters: [],
      factor: { state: "reenrolment_required", origin: false, material: false },
    });
    expect(countOf(ba.log, "insert-recovery-codes")).toBe(0);
  });

  it("C-6: a duplicate that resolved a pending challenge before waiting is classified consumed and counted, never unknown", async () => {
    const admin = await seed();
    const challenge = await challengeFor(admin);
    const held = pauseAt(alt, "lock-administrator");
    const waiting = recover(challenge, admin.codes[1]?.code ?? "", { ops: alt });
    await held.reached;

    expect(expectOk((await recover(challenge, admin.codes[0]?.code ?? "")).outcome).code).toBe("RECOVERY_SESSION_ISSUED");
    held.release();
    expect(expectOk((await within(waiting, "the held duplicate")).outcome)).toMatchObject({ code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY" });
  });

  it("C-7: with R's challenge already live, a code success against a re-enrolment start in Q, both ways and concurrently", async () => {
    const prepare = async () => {
      const admin = await seed();
      const q = await recoverySession(admin, 0);
      // R's challenge is issued, and live, before either operation runs.
      return { admin, q, A2: await challengeFor(admin), R: generateToken() };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const r = async (s: S) => (await recover(s.A2, s.admin.codes[1]?.code ?? "", { session: s.R })).outcome;
    const st = async (s: S) => (await start(s.q.digest)).stored;
    const end = async (s: S) => describeEnd(await fullState(s.admin), { A2: s.A2, Q: s.q.digest, Q2: s.R.digest });

    const { ab, ba } = await raceBothWays(prepare, r, st, end);

    // R first: R deletes Q, discards the factor and creates Q2; start refuses because Q no longer exists.
    expect([kind(ab.a), kind(ab.b)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/RECOVERY_SESSION_INVALID"]);
    expect(ab.end).toMatchObject({
      sessions: ["recovery:Q2"],
      factor: { state: "reenrolment_required", origin: false, material: false },
      codes: 8,
      // A2, and the challenge that opened Q.
      consumed: ["A2", "other"],
      counters: [],
    });
    expect(countOf(ab.log, "start-recovery-reenrolment")).toBe(0);

    // Start first: start invalidates R's challenge, and R refuses uncounted. Q survives, and the
    // pending factor keeps origin Q.
    expect([kind(ba.b), kind(ba.a)]).toEqual(["REENROLMENT_STARTED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect(ba.end).toMatchObject({
      sessions: ["recovery:Q"],
      factor: { state: "pending_confirmation", origin: true, material: true },
      codes: 9,
      pending: ["A2:invalidated"],
      // Only the challenge that opened Q.
      consumed: ["other"],
      counters: [],
      source: 0,
    });
    expect((await originOf(ba.setup.admin.id))?.origin).toBe(await sessionIdOf(ba.setup.q));
    expect(countOf(ba.log, "consume-recovery-code")).toBe(0);
    expect(countOf(ba.log, "count-failure")).toBe(0);
  });

  it("C-7 (separate sequential case): R's challenge issued after the start ends Q and discards the start's factor", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const Q2 = generateToken();
    expect(expectOk((await within(start(q.digest), "start")).stored).code).toBe("REENROLMENT_STARTED");

    // The challenge is issued only now, so the start could not invalidate it.
    const A3 = await challengeFor(admin);
    expect(expectOk((await within(recover(A3, admin.codes[1]?.code ?? "", { session: Q2 }), "R")).outcome).code).toBe("RECOVERY_SESSION_ISSUED");
    expect(describeEnd(await fullState(admin), { A3, Q: q.digest, Q2: Q2.digest })).toMatchObject({
      sessions: ["recovery:Q2"],
      factor: { state: "reenrolment_required", origin: false, material: false },
      codes: 8,
      consumed: ["A3", "other"],
      counters: [],
    });
    expect(await sessionIdOf(q)).toBeUndefined();
    expect(expectOk((await start(q.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
  });

  it("C-8: a code success against completion in Q: never both an active factor and a live recovery session", async () => {
    const prepare = async () => {
      const admin = await seed();
      const q = await recoverySession(admin, 0);
      const started = await start(q.digest);
      expectOk(started.stored);
      return { admin, q, started, A2: await challengeFor(admin), R: generateToken() };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const r = async (s: S) => (await recover(s.A2, s.admin.codes[1]?.code ?? "", { session: s.R })).outcome;
    const c = async (s: S) => (await complete(s.q.digest, s.started.factorId, totpCodeAt(s.started.secret, current))).stored;
    const end = async (s: S) => describeEnd(await fullState(s.admin), { A2: s.A2, Q: s.q.digest, Q2: s.R.digest });

    const { ab, ba } = await raceBothWays(prepare, r, c, end);
    // R first: Q2 live, the factor discarded, and completion rolls back.
    expect([kind(ab.a), kind(ab.b)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/RECOVERY_SESSION_INVALID"]);
    expect(ab.end).toMatchObject({ sessions: ["recovery:Q2"], factor: { state: "reenrolment_required", origin: false, material: false }, codes: 8 });
    expect(countOf(ab.log, "complete-reenrolment")).toBe(0);
    // Completion first: the factor active with 10 new codes, no session, and R refused `invalidated`.
    expect([kind(ba.b), kind(ba.a)]).toEqual(["REENROLMENT_COMPLETED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect(ba.end).toMatchObject({ sessions: [], factor: { state: "active", origin: false, material: true }, codes: 10, pending: ["A2:invalidated"] });
  });

  it("C-9: a code success against the 100th TOTP failure: the factor ends reenrolment_required either way", async () => {
    const prepare = async () => {
      const admin = await seed();
      await setCounter("totp", admin.id, 99, current - 1);
      return { admin, A: await challengeFor(admin), B: await challengeFor(admin), R: generateToken() };
    };
    type S = Awaited<ReturnType<typeof prepare>>;
    const wrongFor = (secret: Buffer) => (totpCodeAt(secret, current) === "000000" ? "000001" : "000000");
    const r = async (s: S) => (await recover(s.A, s.admin.codes[0]?.code ?? "", { session: s.R })).outcome;
    const t = (s: S) => totp(s.B, s.admin.secret, { code: wrongFor(s.admin.secret) });
    const end = async (s: S) => describeEnd(await fullState(s.admin), { A: s.A, B: s.B, R: s.R.digest });

    const race = await raceBothWays(prepare, r, t, end);
    const { ab, ba } = race;
    for (const run of [ab, ba, race.both]) {
      expect(run.end.factor).toEqual({ state: "reenrolment_required", origin: false, material: false });
    }
    // R first: the failure is refused `invalidated`, and the ceiling is not reached (the counter stays 99).
    expect([kind(ab.a), kind(ab.b)]).toEqual(["RECOVERY_SESSION_ISSUED", "REFUSED/INVALIDATED_CHALLENGE"]);
    expect(ab.end).toMatchObject({ sessions: ["recovery:R"], counters: ["totp:99"] });
    // Failure first: the ceiling disables the factor and invalidates A, and R is refused.
    expect(ba.b).toMatchObject({ code: "FAILED", reason: "WRONG_CODE", factorDisabled: true });
    expect(kind(ba.a)).toBe("REFUSED/INVALIDATED_CHALLENGE");
    expect(ba.end).toMatchObject({ sessions: [], counters: ["totp:100"], pending: expect.arrayContaining(["A:invalidated"]) });
  });

  it("C-10: completion or start in Q against logout of Q: logout waits on Q's row lock, then deletes 0 rows or Q", async () => {
    const affectedSince = (mark: number, label: string) =>
      main.hooks.affected.slice(mark).filter((entry) => entry.startsWith(`${label}:`));

    // Completion first, holding Q's row lock while logout waits; logout then deletes 0 rows.
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const started = await start(q.digest);
    const held = pauseAt(alt, "read-pending-factor");
    const completion = complete(q.digest, started.factorId, totpCodeAt(started.secret, current), alt);
    await held.reached;
    let mark = main.hooks.affected.length;
    const logout = auth.logout(main.db, { tokenDigest: q.digest });
    await awaitBlocked(1);
    held.release();
    expect(expectOk((await within(completion, "the completion")).stored).code).toBe("REENROLMENT_COMPLETED");
    expect(expectOk(await within(logout, "the waiting logout"))).toEqual({ code: "LOGGED_OUT" });
    expect(affectedSince(mark, "logout")).toEqual(["logout:0"]);
    expect((await fullState(admin)).factor?.state).toBe("active");

    // Start first, holding Q's row lock while logout waits; logout then deletes Q.
    const starter = await seed();
    const qs = await recoverySession(starter, 0);
    const qsId = await sessionIdOf(qs);
    const heldStart = pauseAt(alt, "start-recovery-reenrolment");
    const starting = start(qs.digest, alt);
    await heldStart.reached;
    mark = main.hooks.affected.length;
    const logoutAfterStart = auth.logout(main.db, { tokenDigest: qs.digest });
    await awaitBlocked(1);
    heldStart.release();
    expect(expectOk((await within(starting, "the start")).stored).code).toBe("REENROLMENT_STARTED");
    expect(expectOk(await within(logoutAfterStart, "the waiting logout"))).toEqual({ code: "LOGGED_OUT" });
    expect(affectedSince(mark, "logout")).toEqual(["logout:1"]);
    expect(await fullState(starter)).toMatchObject({ sessions: [], factor: { state: "pending_confirmation", origin: qsId } });

    // Both orders and concurrently, for completion and for start.
    const prepareCompletion = async () => {
      const a = await seed();
      const s = await recoverySession(a, 0);
      return { admin: a, q: s, started: await start(s.digest) };
    };
    type C = Awaited<ReturnType<typeof prepareCompletion>>;
    const completing = async (s: C) => (await complete(s.q.digest, s.started.factorId, totpCodeAt(s.started.secret, current))).stored;
    const loggingOut = (s: { readonly q: GeneratedToken }) => auth.logout(main.db, { tokenDigest: s.q.digest });
    const endOf = async (s: { readonly admin: Administrator; readonly q: GeneratedToken }) => describeEnd(await fullState(s.admin), { Q: s.q.digest });

    const withCompletion = await raceBothWays(prepareCompletion, completing, loggingOut, endOf);
    expect([kind(withCompletion.ab.a), kind(withCompletion.ab.b)]).toEqual(["REENROLMENT_COMPLETED", "LOGGED_OUT"]);
    expect(withCompletion.ab.affected).toContain("logout:0");
    expect(withCompletion.ab.end).toMatchObject({ sessions: [], factor: { state: "active", origin: false, material: true }, codes: 10 });
    expect([kind(withCompletion.ba.b), kind(withCompletion.ba.a)]).toEqual(["LOGGED_OUT", "REFUSED/RECOVERY_SESSION_INVALID"]);
    expect(withCompletion.ba.affected).toContain("logout:1");
    expect(withCompletion.ba.end).toMatchObject({ sessions: [], factor: { state: "pending_confirmation", origin: true }, codes: 9 });
    expect(withCompletion.both.affected.filter((e) => e.startsWith("logout:"))).toEqual(
      orderOf(withCompletion).affected.filter((e) => e.startsWith("logout:")),
    );

    const prepareStart = async () => {
      const a = await seed();
      return { admin: a, q: await recoverySession(a, 0) };
    };
    type T = Awaited<ReturnType<typeof prepareStart>>;
    const starting2 = async (s: T) => (await start(s.q.digest)).stored;

    const withStart = await raceBothWays(prepareStart, starting2, loggingOut, endOf);
    expect([kind(withStart.ab.a), kind(withStart.ab.b)]).toEqual(["REENROLMENT_STARTED", "LOGGED_OUT"]);
    expect(withStart.ab.affected).toContain("logout:1");
    expect(withStart.ab.end).toMatchObject({ sessions: [], factor: { state: "pending_confirmation", origin: true } });
    expect([kind(withStart.ba.b), kind(withStart.ba.a)]).toEqual(["LOGGED_OUT", "REFUSED/RECOVERY_SESSION_INVALID"]);
    expect(withStart.ba.affected).toContain("logout:1");
    expect(withStart.ba.end).toMatchObject({ sessions: [], factor: { state: "reenrolment_required", origin: false } });
  });

  it("waiting-request variants: a request that passed checkSession and then waits rolls back at its Q lock, writing nothing", async () => {
    // The interloper ends Q while the request is held: a later code success (C-7, C-8), or logout (C-10).
    for (const interloper of ["code success", "logout"] as const) {
      for (const operation of ["start", "complete", "regenerate"] as const) {
        const label = `${operation} after ${interloper}`;
        const admin = await seed();
        const q = await recoverySession(admin, 0);
        const started = operation === "complete" ? await start(q.digest) : undefined;
        expect(expectOk(await auth.checkSession(main.db, { tokenDigest: q.digest }, main.clock)).code, label).toBe("SESSION_VALID");

        const held = pauseAt(alt, "lock-administrator");
        const mark = alt.hooks.log.length;
        const waiting: Promise<auth.Stored<unknown>> =
          operation === "start"
            ? start(q.digest, alt).then((x) => x.stored)
            : operation === "complete"
              ? complete(q.digest, started?.factorId ?? "", totpCodeAt(started?.secret ?? Buffer.alloc(20), current), alt).then((x) => x.stored)
              : regenerate(q.digest, alt).then((x) => x.stored);
        await held.reached;

        if (interloper === "code success") {
          await recoverySession(admin, 1);
        } else {
          expectOk(await auth.logout(main.db, { tokenDigest: q.digest }));
        }
        const before = await fullState(admin);
        held.release();
        expect(expectOk(await within(waiting, label)), label).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
        // It rolled back at its Q lock: nothing after the lock was sent.
        const sent = alt.hooks.log.slice(mark).filter((entry) => entry !== "clock");
        expect(sent, label).toEqual(["resolve-recovery-session", "lock-administrator", "lock-recovery-session"]);
        expect(await fullState(admin), label).toEqual(before);
      }
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* §6.5 Recovery-session operations                                                              */
/* ------------------------------------------------------------------------------------------- */

describe("§6.5 recovery-session authorization", () => {
  it("refuses an expired session, an administrator-kind session, a logged-out session and a disabled account, writing nothing", async () => {
    const expired = await seed();
    const q = await recoverySession(expired, 0);
    // Activity never extends the absolute 15 minutes.
    current += 10 * 60_000;
    expectOk(await auth.checkSession(main.db, { tokenDigest: q.digest }, main.clock));
    current += 5 * 60_000;
    let before = await fullState(expired);
    expect(expectOk((await regenerate(q.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(await fullState(expired)).toEqual(before);

    const administratorKind = await seed();
    const full = generateToken();
    await rivals.query(
      `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
       values ($1, $2, $3, 'administrator', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '12 hours')`,
      [full.digest, randomUUID(), administratorKind.id, new Date(current).toISOString()],
    );
    before = await fullState(administratorKind);
    expect(expectOk((await start(full.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(await fullState(administratorKind)).toEqual(before);

    const loggedOut = await seed();
    const q3 = await recoverySession(loggedOut, 0);
    expectOk(await auth.logout(main.db, { tokenDigest: q3.digest }));
    before = await fullState(loggedOut);
    expect(expectOk((await regenerate(q3.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(await fullState(loggedOut)).toEqual(before);

    const disabled = await seed();
    const q4 = await recoverySession(disabled, 0);
    await setDisabled(disabled.id, "disabled_at");
    before = await fullState(disabled);
    expect(expectOk((await start(q4.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(await fullState(disabled)).toEqual(before);
  });

  it("acts only on the administrator its session belongs to", async () => {
    const owner = await seed();
    const bystander = await seed();
    const q = await recoverySession(owner, 0);
    const bystanderBefore = await fullState(bystander);

    expect(expectOk((await regenerate(q.digest)).stored)).toEqual({ code: "RECOVERY_CODES_REGENERATED", administratorId: owner.id });
    expect(await fullState(bystander)).toEqual(bystanderBefore);
  });

  it("token-based isolation: each token acts only on its own administrator, both ways, and cannot reach the other's factor", async () => {
    const a = await seed();
    const b = await seed();
    const qa = await recoverySession(a, 0);
    const qb = await recoverySession(b, 0);
    const otherOf = (self: Administrator) => (self === a ? b : a);

    for (const [token, self] of [[qa, a], [qb, b]] as const) {
      // No operation takes an administrator: the token alone names the one acted on.
      const otherBefore = await fullState(otherOf(self));
      expect(expectOk((await regenerate(token.digest)).stored)).toEqual({ code: "RECOVERY_CODES_REGENERATED", administratorId: self.id });
      expect(await fullState(otherOf(self))).toEqual(otherBefore);

      const started = await start(token.digest);
      expect(expectOk(started.stored)).toEqual({ code: "REENROLMENT_STARTED", administratorId: self.id, factorId: started.factorId });
      expect(await fullState(otherOf(self))).toEqual(otherBefore);
      expect((await originOf(self.id))?.origin).toBe(await sessionIdOf(token));
    }

    // Each now has a pending factor from its own session. A token presented with the other
    // administrator's factor_id is checked against its own factor only, and refused.
    for (const [token, self] of [[qa, a], [qb, b]] as const) {
      const otherFactorId = (await fullState(otherOf(self))).factor?.factor_id;
      const before = { self: await fullState(self), other: await fullState(otherOf(self)) };
      expect(expectOk((await complete(token.digest, String(otherFactorId), "000000")).stored)).toEqual({
        code: "REFUSED",
        reason: "FACTOR_NOT_PENDING",
      });
      expect(await fullState(self)).toEqual(before.self);
      expect(await fullState(otherOf(self))).toEqual(before.other);
    }
  });

  it("refuses a session that expires while the operation waits on the lock (the clock is read after the lock)", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const r = await rival();
    await r.query("select id from administrator where id = $1 for update", [admin.id]);
    const waiting = regenerate(q.digest);
    await awaitBlocked(1);
    current += auth.RECOVERY_SESSION_ABSOLUTE_MS;
    const before = await fullState(admin);
    await r.commit();
    expect(expectOk((await within(waiting, "the waiting regeneration")).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(await fullState(admin)).toEqual(before);
  });
});

describe("§6.5 start, completion and regeneration", () => {
  it("start writes a new pending factor with origin Q, deletes administrator sessions, invalidates challenges and keeps Q", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const pendingChallenge = await challengeFor(admin);
    await rivals.query(
      `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
       values ($1, $2, $3, 'administrator', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '12 hours')`,
      [randomBytes(32), randomUUID(), admin.id, new Date(current).toISOString()],
    );

    const started = await start(q.digest);
    expect(expectOk(started.stored)).toEqual({ code: "REENROLMENT_STARTED", administratorId: admin.id, factorId: started.factorId });

    const state = await fullState(admin);
    expect(state.factor).toMatchObject({ state: "pending_confirmation", factor_id: started.factorId, step: null, origin: await sessionIdOf(q) });
    expect(state.sessions.map((s) => s.kind)).toEqual(["recovery"]);
    expect(state.pending.find((p) => p.d === pendingChallenge.toString("hex"))?.invalidated).toBe(true);

    // TOTP codes from the replaced secret (and the new pending one) do not sign in.
    expect(expectOk(await totp(await challengeFor(admin), admin.secret))).toEqual({ code: "REFUSED", reason: "FACTOR_UNAVAILABLE" });
    expect(expectOk(await totp(await challengeFor(admin), started.secret))).toEqual({ code: "REFUSED", reason: "FACTOR_UNAVAILABLE" });
  });

  it("completion with the right code ends Q, activates the factor with a NULL origin, replaces the codes, and a fresh sign-in works", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const started = await start(q.digest);
    const step = totpStepAt(current);

    const completed = await complete(q.digest, started.factorId, totpCodeAt(started.secret, current));
    expect(expectOk(completed.stored)).toEqual({ code: "REENROLMENT_COMPLETED", administratorId: admin.id });

    const state = await fullState(admin);
    expect(state.sessions).toEqual([]);
    expect(state.factor).toMatchObject({ state: "active", factor_id: started.factorId, step: String(step), origin: null });
    expect(state.codes).toEqual(completed.codes.map((c) => c.digest.toString("hex")).sort());

    // Every old code now fails; the new secret signs in.
    expect(expectOk((await recover(await challengeFor(admin), admin.codes[1]?.code ?? "")).outcome)).toMatchObject({ code: "FAILED", reason: "WRONG_CODE" });
    current += 60_000;
    expect(expectOk(await totp(await challengeFor(admin), started.secret)).code).toBe("SESSION_ISSUED");
  });

  it("refuses a wrong code, a code from the replaced secret and an earlier factor_id, each writing and counting nothing", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const first = await start(q.digest);
    const second = await start(q.digest);
    const before = await fullState(admin);
    const wrong = totpCodeAt(second.secret, current) === "000000" ? "000001" : "000000";

    expect(expectOk((await complete(q.digest, second.factorId, wrong)).stored)).toEqual({ code: "REFUSED", reason: "WRONG_CODE" });
    expect(expectOk((await complete(q.digest, second.factorId, totpCodeAt(admin.secret, current))).stored)).toEqual({ code: "REFUSED", reason: "WRONG_CODE" });
    expect(expectOk((await complete(q.digest, first.factorId, totpCodeAt(first.secret, current))).stored)).toEqual({ code: "REFUSED", reason: "FACTOR_NOT_PENDING" });
    expect(await fullState(admin)).toEqual(before);
  });

  it("five concurrent completions give at most one success", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const started = await start(q.digest);
    const code = totpCodeAt(started.secret, current);

    const outcomes = await within(Promise.all(Array.from({ length: 5 }, () => complete(q.digest, started.factorId, code))), "five completions");
    expect(outcomes.filter((o) => expectOk(o.stored).code === "REENROLMENT_COMPLETED")).toHaveLength(1);
    expect((await fullState(admin)).codes).toHaveLength(10);
  });

  it("backstop: a completion whose factor names another recovery session as its origin is refused, writing nothing", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const started = await start(q.digest);
    // Not reachable through this unit's operations; set up directly.
    const otherSession = randomUUID();
    await rivals.query(
      `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
       values ($1, $2, $3, 'recovery', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '15 minutes')`,
      [randomBytes(32), otherSession, admin.id, new Date(current).toISOString()],
    );
    await rivals.query("update administrator_totp_factor set origin_recovery_session_id = $2 where administrator_id = $1", [admin.id, otherSession]);
    const before = await fullState(admin);

    expect(expectOk((await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored)).toEqual({
      code: "REFUSED",
      reason: "FACTOR_NOT_FROM_THIS_RECOVERY",
    });
    expect(await fullState(admin)).toEqual(before);
  });

  it("regeneration replaces the whole set with exactly ten new codes, and the old ones fail", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const regenerated = await regenerate(q.digest);
    expect(expectOk(regenerated.stored)).toEqual({ code: "RECOVERY_CODES_REGENERATED", administratorId: admin.id });

    const state = await fullState(admin);
    expect(state.codes).toEqual(regenerated.codes.map((c) => c.digest.toString("hex")).sort());
    expect(state.sessions.map((s) => s.kind)).toEqual(["recovery"]);
    expect(expectOk((await recover(await challengeFor(admin), admin.codes[2]?.code ?? "")).outcome)).toMatchObject({ reason: "WRONG_CODE" });
  });
});

describe("§6.5 the last code, and sessions that survive a ceiling", () => {
  async function lastCodeSession() {
    const admin = await seed();
    const keep = admin.codes[9] as GeneratedRecoveryCode;
    await deleteCodesExcept(admin.id, keep);
    const { outcome, session } = await recover(await challengeFor(admin), keep.code);
    expect(expectOk(outcome).code).toBe("RECOVERY_SESSION_ISSUED");
    expect((await fullState(admin)).codes).toEqual([]);
    return { admin, q: session };
  }

  it("(a) consuming the last code opens Q with 0 codes; regeneration through Q restores ten", async () => {
    const { admin, q } = await lastCodeSession();
    expect((await fullState(admin)).factor?.state).toBe("reenrolment_required");
    expect(expectOk((await regenerate(q.digest)).stored).code).toBe("RECOVERY_CODES_REGENERATED");
    expect((await fullState(admin)).codes).toHaveLength(10);
  });

  it("(b) completion through Q activates the new factor with ten codes", async () => {
    const { admin, q } = await lastCodeSession();
    const started = await start(q.digest);
    expect(expectOk((await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored).code).toBe("REENROLMENT_COMPLETED");
    const state = await fullState(admin);
    expect(state.factor?.state).toBe("active");
    expect(state.codes).toHaveLength(10);
  });

  it("(c) only when Q expires with neither is the operator-only state O-1 reached", async () => {
    const { admin, q } = await lastCodeSession();
    current += auth.RECOVERY_SESSION_ABSOLUTE_MS + 1;

    expect(expectOk((await regenerate(q.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    expect(expectOk(await totp(await challengeFor(admin), admin.secret))).toEqual({ code: "REFUSED", reason: "FACTOR_UNAVAILABLE" });
    expect(expectOk((await recover(await challengeFor(admin), admin.codes[0]?.code ?? "")).outcome)).toMatchObject({ code: "FAILED", reason: "WRONG_CODE" });
    const live = (await rivals.query<{ n: number }>(
      "select count(*)::int as n from administrator_session where administrator_id = $1 and kind = 'recovery' and absolute_expires_at > $2",
      [admin.id, new Date(current).toISOString()],
    )).rows[0]?.n;
    expect(live).toBe(0);
  });

  it("a live Q survives the recovery-code ceiling; regeneration restores codes but the counter stays, so one wrong code deletes them again", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    await setCounter("recovery_code", admin.id, 99);
    expect(expectOk((await recover(await challengeFor(admin), "wrong")).outcome)).toMatchObject({ codesDisabled: true });
    expect((await fullState(admin)).codes).toEqual([]);

    // Q's authorization still succeeds.
    expect(expectOk((await regenerate(q.digest)).stored).code).toBe("RECOVERY_CODES_REGENERATED");
    let state = await fullState(admin);
    expect(state.codes).toHaveLength(10);
    expect(counterOf(state, "recovery_code")).toBe(100);

    // After the wait, one wrong code deletes the new set again (RA-9).
    current += 60 * 60_000 + 1;
    expect(expectOk((await recover(await challengeFor(admin), "wrong")).outcome)).toMatchObject({ consecutiveFailures: 101, codesDisabled: true });
    state = await fullState(admin);
    expect(state.codes).toEqual([]);
  });

  it("only when Q then ends without completion, with no code remaining, is O-2 reached; completion through a surviving Q avoids it", async () => {
    const avoided = await seed();
    const q = await recoverySession(avoided, 0);
    await setCounter("recovery_code", avoided.id, 99);
    expectOk((await recover(await challengeFor(avoided), "wrong")).outcome);
    const started = await start(q.digest);
    expect(expectOk((await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored).code).toBe("REENROLMENT_COMPLETED");

    const reached = await seed();
    const q2 = await recoverySession(reached, 0);
    await setCounter("recovery_code", reached.id, 99);
    expectOk((await recover(await challengeFor(reached), "wrong")).outcome);
    current += auth.RECOVERY_SESSION_ABSOLUTE_MS + 1;
    expect(expectOk((await regenerate(q2.digest)).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    const state = await fullState(reached);
    expect(state.codes).toEqual([]);
    expect(state.factor?.state).toBe("reenrolment_required");
  });

  it("a live Q survives the password ceiling and can still complete; sign-in stays impossible", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    // Pre-existing state: the password authenticator disabled (the ceiling's effect).
    await setDisabled(admin.id, "password_disabled_at");
    const started = await start(q.digest);
    expect(expectOk((await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored).code).toBe("REENROLMENT_COMPLETED");

    const challenge = generateToken();
    expect(
      expectOk(
        await auth.issuePasswordChallenge(
          main.db,
          { administratorId: admin.id, verifiedPasswordHash: STUB_HASH, usernameDigest: usernameDigestOf(admin.username), challengeDigest: challenge.digest },
          main.clock,
        ),
      ),
    ).toEqual({ code: "VERIFICATION_OBSOLETE", reason: "PASSWORD_DISABLED" });
  });

  it("abandonment after start: the pending factor keeps origin Q, no session can complete it, and the next code success discards it", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    const started = await start(q.digest);
    const qId = await sessionIdOf(q);
    current += auth.RECOVERY_SESSION_ABSOLUTE_MS + 1;

    expect((await originOf(admin.id))?.origin).toBe(qId);
    expect(expectOk((await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored)).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });

    await recoverySession(admin, 1);
    expect(await originOf(admin.id)).toEqual({ origin: null, state: "reenrolment_required" });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* §6.6 Activation authorization and the existing functions                                     */
/* ------------------------------------------------------------------------------------------- */

describe("§6.6 activation authorization", () => {
  async function recoveryStartedThenLoggedOut() {
    const admin = await seed();
    const keep = admin.codes[9] as GeneratedRecoveryCode;
    await deleteCodesExcept(admin.id, keep);
    const { session: q } = await recover(await challengeFor(admin), keep.code);
    const started = await start(q.digest);
    expectOk(started.stored);
    expectOk(await auth.logout(main.db, { tokenDigest: q.digest }));
    const state = await fullState(admin);
    expect(state.sessions).toEqual([]);
    expect(state.codes).toEqual([]);
    return { admin, q, started };
  }

  it("logout, then provisioning confirmation of the recovery-started factor, is refused on origin without mutation", async () => {
    const { admin, started } = await recoveryStartedThenLoggedOut();
    const before = await fullState(admin);

    const outcome = await auth.confirmTotpEnrolmentWithRecoveryCodes(
      main.db,
      {
        administratorId: admin.id,
        factorId: started.factorId,
        verify: verifierAt(started.secret),
        codeDigests: generateRecoveryCodes().map((c) => c.digest),
      },
      main.clock,
    );
    expect(expectOk(outcome)).toEqual({ code: "REFUSED", reason: "FACTOR_HAS_RECOVERY_ORIGIN" });
    expect(await fullState(admin)).toEqual(before);
  });

  it("the existing confirmTotpEnrolment rolls back on the origin CHECK, with Q live and after logout, writing nothing", async () => {
    const live = await seed();
    const q = await recoverySession(live, 0);
    const started = await start(q.digest);
    const pendingChallenge = await challengeFor(live);
    let before = await fullState(live);
    expect(before.pending.find((p) => p.d === pendingChallenge.toString("hex"))?.invalidated).toBe(false);
    let mark = main.hooks.log.length;

    expect(
      await auth.confirmTotpEnrolment(main.db, { administratorId: live.id, factorId: started.factorId, step: totpStepAt(current) }, main.clock),
    ).toEqual({
      ok: false,
      failure: { code: "INTEGRITY_CONFLICT", sqlState: "23514", constraint: "administrator_totp_factor_origin_check" },
    });
    // One attempt, no retry: one transaction, whose activation UPDATE is sent once and is the last
    // statement; the pending-challenge invalidation after it is never sent.
    const attempt = (since: number) => main.hooks.log.slice(since).filter((entry) => entry !== "clock");
    expect(attempt(mark)).toEqual(["lock-administrator", "read-factor", "confirm-enrolment"]);
    // The factor (every column), the codes and the pending challenges are unchanged: the invalidation did not run.
    expect(await fullState(live)).toEqual(before);

    const { admin, started: loggedOutStart } = await recoveryStartedThenLoggedOut();
    before = await fullState(admin);
    mark = main.hooks.log.length;
    expect(
      await auth.confirmTotpEnrolment(main.db, { administratorId: admin.id, factorId: loggedOutStart.factorId, step: totpStepAt(current) }, main.clock),
    ).toMatchObject({ ok: false, failure: { code: "INTEGRITY_CONFLICT", sqlState: "23514", constraint: "administrator_totp_factor_origin_check" } });
    expect(attempt(mark)).toEqual(["lock-administrator", "read-factor", "confirm-enrolment"]);
    expect(await fullState(admin)).toEqual(before);
  });

  it("legitimate initial provisioning still works, and the existing provisioning confirmation still works with no codes", async () => {
    const admin = await seed();
    const state = await fullState(admin);
    expect(state.factor).toMatchObject({ state: "active", origin: null });
    expect(state.codes).toHaveLength(10);
    expect(expectOk(await totp(await challengeFor(admin), admin.secret)).code).toBe("SESSION_ISSUED");

    const existing = await createWithPendingFactor();
    expect(
      expectOk(await auth.confirmTotpEnrolment(main.db, { administratorId: existing.id, factorId: existing.factorId, step: totpStepAt(current) }, main.clock)),
    ).toEqual({ code: "ENROLMENT_CONFIRMED" });
    const after = await fullState(existing);
    expect(after.factor?.state).toBe("active");
    expect(after.codes).toEqual([]);
  });

  it("refuses provisioning confirmation while any session row (live or expired) or code row exists, or for a wrong code, without mutation", async () => {
    // A session row of either kind, live or expired.
    const sessionCases = [
      ["administrator", "12 hours", 0],
      ["administrator", "12 hours", 13 * 60 * 60_000],
      ["recovery", "15 minutes", 0],
      ["recovery", "15 minutes", 60 * 60_000],
    ] as const;
    for (const [sessionKind, lifetime, age] of sessionCases) {
      const label = `${sessionKind} session, ${age === 0 ? "live" : "expired"}`;
      const admin = await createWithPendingFactor();
      await rivals.query(
        `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz + $6::interval)`,
        [randomBytes(32), randomUUID(), admin.id, sessionKind, new Date(current - age).toISOString(), lifetime],
      );
      const live = (await rivals.query<{ n: number }>(
        "select count(*)::int as n from administrator_session where administrator_id = $1 and absolute_expires_at > $2",
        [admin.id, new Date(current).toISOString()],
      )).rows[0]?.n;
      expect(live, label).toBe(age === 0 ? 1 : 0);
      const before = await fullState(admin);
      const outcome = await auth.confirmTotpEnrolmentWithRecoveryCodes(
        main.db,
        { administratorId: admin.id, factorId: admin.factorId, verify: verifierAt(admin.secret), codeDigests: generateRecoveryCodes().map((c) => c.digest) },
        main.clock,
      );
      expect(expectOk(outcome), label).toEqual({ code: "REFUSED", reason: "SESSION_EXISTS" });
      expect(await fullState(admin), label).toEqual(before);
    }

    const withCode = await createWithPendingFactor();
    await rivals.query("insert into administrator_recovery_code (administrator_id, code_digest) values ($1, $2)", [withCode.id, randomBytes(32)]);
    const wrong = await createWithPendingFactor();

    for (const [admin, code, reason] of [
      [withCode, totpCodeAt(withCode.secret, current), "RECOVERY_CODES_EXIST"],
      [wrong, totpCodeAt(wrong.secret, current) === "000000" ? "000001" : "000000", "WRONG_CODE"],
    ] as const) {
      const before = await fullState(admin);
      const outcome = await auth.confirmTotpEnrolmentWithRecoveryCodes(
        main.db,
        { administratorId: admin.id, factorId: admin.factorId, verify: totpVerifierFor(TOTP_KEYS, code), codeDigests: generateRecoveryCodes().map((c) => c.digest) },
        main.clock,
      );
      expect(expectOk(outcome), reason).toEqual({ code: "REFUSED", reason });
      expect(await fullState(admin), reason).toEqual(before);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* §6.7 Required counts and rollback                                                             */
/* ------------------------------------------------------------------------------------------- */

describe("§6.7 required counts", () => {
  it("rolls each recovery-code transaction back, writing nothing, when a required statement reports the wrong count", async () => {
    for (const label of ["consume-challenge", "record-consumed-challenge", "issue-recovery-session", "lock-source-row", "lock-counter-row"]) {
      const admin = await seed();
      const source = freshSource();
      const challenge = await challengeFor(admin);
      const before = await fullState(admin, source);
      const mark = main.hooks.log.length;
      const { outcome } = await withZeroed(label, () => recover(challenge, admin.codes[0]?.code ?? "", { source }));
      expect(outcome, label).toEqual(protocolFailure(label, 1, 0));
      expectSingleAttempt(mark, label);
      expect(await fullState(admin, source), label).toEqual(before);
    }

    for (const label of ["count-failure", "count-source-failure"]) {
      const admin = await seed();
      const source = freshSource();
      const challenge = await challengeFor(admin);
      const before = await fullState(admin, source);
      const mark = main.hooks.log.length;
      const { outcome } = await withZeroed(label, () => recover(challenge, "wrong", { source }));
      expect(outcome, label).toEqual(protocolFailure(label, 1, 0));
      expectSingleAttempt(mark, label);
      expect(await fullState(admin, source), label).toEqual(before);
    }
  });

  it("rolls the consumed-replay path back on each of its two accounting statements, separately from the wrong-code path", async () => {
    for (const label of ["count-failure", "count-source-failure"]) {
      const admin = await seed();
      const source = freshSource();
      const challenge = await challengeFor(admin);
      expect(expectOk((await recover(challenge, admin.codes[0]?.code ?? "")).outcome).code).toBe("RECOVERY_SESSION_ISSUED");
      const before = await fullState(admin, source);
      const mark = main.hooks.log.length;

      const { outcome } = await withZeroed(label, () => recover(challenge, admin.codes[1]?.code ?? "", { source }));
      expect(outcome, label).toEqual(protocolFailure(label, 1, 0));
      expectSingleAttempt(mark, label);
      // The replay path: a valid unused code was presented, yet no code delete was sent.
      expect(main.hooks.log.slice(mark), label).not.toContain("consume-recovery-code");
      // Neither counter, the source window, the codes nor the session moved.
      expect(await fullState(admin, source), label).toEqual(before);
    }

    // Uninjected, the same replay is counted once on each, so the injections hit real accounting.
    const admin = await seed();
    const source = freshSource();
    const challenge = await challengeFor(admin);
    expect(expectOk((await recover(challenge, admin.codes[0]?.code ?? "")).outcome).code).toBe("RECOVERY_SESSION_ISSUED");
    expect(expectOk((await recover(challenge, admin.codes[1]?.code ?? "", { source })).outcome)).toMatchObject({
      code: "FAILED",
      reason: "CONSUMED_CHALLENGE_REPLAY",
      consecutiveFailures: 1,
    });
    expect(sourceFailures(await fullState(admin, source))).toBe(1);
  });

  it("the recovery-session lock: 0 rows refuses RECOVERY_SESSION_INVALID, 1 row continues, 2 rows is a protocol failure; each rolls back once", async () => {
    // Each operation, prepared uninjected (completion's factor is started first), then run.
    const operations: Record<string, (q: GeneratedToken) => Promise<{ readonly run: () => Promise<auth.Stored<unknown>>; readonly success: string }>> = {
      start: async (q) => ({ run: async () => (await start(q.digest)).stored, success: "REENROLMENT_STARTED" }),
      regeneration: async (q) => ({ run: async () => (await regenerate(q.digest)).stored, success: "RECOVERY_CODES_REGENERATED" }),
      completion: async (q) => {
        const started = await start(q.digest);
        return {
          run: async () => (await complete(q.digest, started.factorId, totpCodeAt(started.secret, current))).stored,
          success: "REENROLMENT_COMPLETED",
        };
      },
    };

    for (const [name, prepare] of Object.entries(operations)) {
      for (const [rows, expected] of [
        [0, { ok: true, value: { code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" } }],
        [2, protocolFailure("lock-recovery-session", 1, 2)],
      ] as const) {
        const admin = await seed();
        const q = await recoverySession(admin, 0);
        const { run } = await prepare(q);
        const before = await fullState(admin);
        const mark = main.hooks.log.length;

        expect(await withCount("lock-recovery-session", rows, run), `${name} ${rows}`).toEqual(expected);
        // One attempt, rolled back at the lock: resolve, lock the administrator, lock Q, nothing after.
        expect(main.hooks.log.slice(mark).filter((entry) => entry !== "clock"), `${name} ${rows}`).toEqual([
          "resolve-recovery-session",
          "lock-administrator",
          "lock-recovery-session",
        ]);
        expect(await fullState(admin), `${name} ${rows}`).toEqual(before);
      }

      // One row (the server's own count) continues to the operation itself.
      const admin = await seed();
      const q = await recoverySession(admin, 0);
      const { run, success } = await prepare(q);
      const mark = main.hooks.log.length;
      expect(expectOk(await run()), name).toMatchObject({ code: success });
      expect(main.hooks.affected.slice(-50), name).toContain("lock-recovery-session:1");
      expect(main.hooks.log.slice(mark).filter((entry) => entry !== "clock").length, name).toBeGreaterThan(3);
    }
  });

  it("rolls start, regeneration and completion back on every required statement, including 9 and 11 code inserts", async () => {
    const admin = await seed();
    const q = await recoverySession(admin, 0);
    let before = await fullState(admin);
    let mark = main.hooks.log.length;
    expect((await withZeroed("start-recovery-reenrolment", () => start(q.digest))).stored).toEqual(protocolFailure("start-recovery-reenrolment", 1, 0));
    expectSingleAttempt(mark, "start-recovery-reenrolment");
    expect(await fullState(admin)).toEqual(before);

    for (const injected of [0, 9, 11]) {
      before = await fullState(admin);
      mark = main.hooks.log.length;
      const { stored } = await withCount("insert-recovery-codes", injected, () => regenerate(q.digest));
      expect(stored, `regeneration ${injected}`).toEqual(protocolFailure("insert-recovery-codes", 10, injected));
      expectSingleAttempt(mark, "insert-recovery-codes");
      expect(await fullState(admin)).toEqual(before);
    }

    const started = await start(q.digest);
    for (const [label, count, expected] of [
      ["end-recovery-session", 0, 1],
      ["complete-reenrolment", 0, 1],
      ["insert-recovery-codes", 0, 10],
      ["insert-recovery-codes", 9, 10],
      ["insert-recovery-codes", 11, 10],
    ] as const) {
      before = await fullState(admin);
      mark = main.hooks.log.length;
      const { stored } = await withCount(label, count, () => complete(q.digest, started.factorId, totpCodeAt(started.secret, current)));
      expect(stored, `${label} ${count}`).toEqual(protocolFailure(label, expected, count));
      expectSingleAttempt(mark, label);
      // The complete prior factor row and code set are preserved.
      expect(await fullState(admin), `${label} ${count}`).toEqual(before);
    }
  });

  it("rolls the provisioning confirmation back on its activation and on 0, 9 or 11 code inserts", async () => {
    for (const [label, count, expected] of [
      ["confirm-enrolment-with-codes", 0, 1],
      ["insert-recovery-codes", 0, 10],
      ["insert-recovery-codes", 9, 10],
      ["insert-recovery-codes", 11, 10],
    ] as const) {
      const admin = await createWithPendingFactor();
      const before = await fullState(admin);
      const mark = main.hooks.log.length;
      const outcome = await withCount(label, count, () =>
        auth.confirmTotpEnrolmentWithRecoveryCodes(
          main.db,
          { administratorId: admin.id, factorId: admin.factorId, verify: verifierAt(admin.secret), codeDigests: generateRecoveryCodes().map((c) => c.digest) },
          main.clock,
        ),
      );
      expect(outcome, `${label} ${count}`).toEqual(protocolFailure(label, expected, count));
      expectSingleAttempt(mark, label);
      expect(await fullState(admin), `${label} ${count}`).toEqual(before);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* §6.8 Database failures                                                                        */
/* ------------------------------------------------------------------------------------------- */

/** A genuine SQLSTATE, never a Node system code. */
const GENUINE_SQLSTATE = /^[0-9A-Z]{5}$/;

async function installFaultTrigger(table: string, argument: string): Promise<void> {
  await faultRivals.query(
    `create or replace function adr029_test_fault() returns trigger language plpgsql as $$
     begin
       if tg_argv[0] = 'sleep' then
         perform pg_sleep(30);
         return new;
       end if;
       raise exception 'injected test fault' using errcode = tg_argv[0];
     end $$`,
  );
  await faultRivals.query(
    `create trigger adr029_test_fault before insert or update on ${table}
       for each row execute function adr029_test_fault('${argument}')`,
  );
}

async function removeFaultTrigger(table: string): Promise<void> {
  await faultRivals.query(`drop trigger if exists adr029_test_fault on ${table}`);
}

interface FaultCase {
  readonly name: string;
  readonly admin: Administrator | Omit<Administrator, "codes">;
  readonly source?: Buffer;
  /** The statement whose single attempt each case asserts. */
  readonly label: string;
  /** The table a fault trigger is installed on. */
  readonly table: string;
  /** A rival lock to take before the operation, for the deadlock case. */
  readonly hold: { readonly sql: string; readonly values: readonly unknown[] };
  readonly run: () => Promise<auth.Stored<unknown>>;
  /** The same operation made to violate a unique constraint genuinely. */
  readonly duplicate: () => Promise<auth.Stored<unknown>>;
  readonly duplicateConstraint: string;
  readonly secrets: readonly (Buffer | string)[];
}

async function seedFaults(): Promise<Administrator> {
  return seed(faults);
}

async function faultCases(): Promise<Record<string, () => Promise<FaultCase>>> {
  return {
    completeRecoveryChallenge: async () => {
      const admin = await seedFaults();
      const challenge = await challengeFor(admin, faults);
      const source = freshSource();
      await faultRivals.query("insert into authentication_source_window (source_digest, recent_failures) values ($1, '{}'::timestamptz(3)[])", [source]);
      const other = await seedFaults();
      const taken = generateToken();
      await faultRivals.query(
        `insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
         values ($1, $2, $3, 'administrator', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '12 hours')`,
        [taken.digest, randomUUID(), other.id, new Date(current).toISOString()],
      );
      const code = admin.codes[0]?.code ?? "";
      return {
        name: "completeRecoveryChallenge",
        admin,
        source,
        label: "issue-recovery-session",
        table: "administrator_session",
        hold: { sql: "select 1 from authentication_source_window where source_digest = $1 for update", values: [source] },
        run: async () => (await recover(challenge, code, { source, ops: faults })).outcome,
        duplicate: async () => (await recover(challenge, code, { source, ops: faults, session: taken })).outcome,
        duplicateConstraint: "administrator_session_pkey",
        secrets: [code, challenge],
      };
    },
    startRecoveryReenrolment: async () => {
      const admin = await seedFaults();
      const q = await recoverySession(admin, 0, faults);
      const other = await seedFaults();
      const secret = generateTotpSecret();
      return {
        name: "startRecoveryReenrolment",
        admin,
        label: "start-recovery-reenrolment",
        table: "administrator_totp_factor",
        hold: { sql: "select 1 from administrator_session where token_digest = $1 for update", values: [q.digest] },
        run: () =>
          auth.startRecoveryReenrolment(faults.db, { recoveryTokenDigest: q.digest, factorId: randomUUID(), seal: (id) => sealTotpSecret(TOTP_KEY, 1, id, secret) }, faults.clock),
        duplicate: () =>
          auth.startRecoveryReenrolment(faults.db, { recoveryTokenDigest: q.digest, factorId: other.factorId, seal: (id) => sealTotpSecret(TOTP_KEY, 1, id, secret) }, faults.clock),
        duplicateConstraint: "administrator_totp_factor_factor_id_key",
        secrets: [secret, q.digest],
      };
    },
    regenerateRecoveryCodes: async () => {
      const admin = await seedFaults();
      const q = await recoverySession(admin, 0, faults);
      const codes = generateRecoveryCodes();
      const duplicated = [...codes.slice(0, 9).map((c) => c.digest), codes[0]?.digest as Buffer];
      return {
        name: "regenerateRecoveryCodes",
        admin,
        label: "insert-recovery-codes",
        table: "administrator_recovery_code",
        hold: { sql: "select 1 from administrator_session where token_digest = $1 for update", values: [q.digest] },
        run: () => auth.regenerateRecoveryCodes(faults.db, { recoveryTokenDigest: q.digest, codeDigests: codes.map((c) => c.digest) }, faults.clock),
        duplicate: () => auth.regenerateRecoveryCodes(faults.db, { recoveryTokenDigest: q.digest, codeDigests: duplicated }, faults.clock),
        duplicateConstraint: "administrator_recovery_code_pkey",
        secrets: [...codes.map((c) => c.code), q.digest],
      };
    },
    completeRecoveryReenrolment: async () => {
      const admin = await seedFaults();
      const q = await recoverySession(admin, 0, faults);
      const started = await start(q.digest, faults);
      const codes = generateRecoveryCodes();
      const duplicated = [...codes.slice(0, 9).map((c) => c.digest), codes[0]?.digest as Buffer];
      const verify = () => totpVerifierFor(TOTP_KEYS, totpCodeAt(started.secret, current));
      return {
        name: "completeRecoveryReenrolment",
        admin,
        label: "insert-recovery-codes",
        table: "administrator_recovery_code",
        hold: { sql: "select 1 from administrator_session where token_digest = $1 for update", values: [q.digest] },
        run: () =>
          auth.completeRecoveryReenrolment(faults.db, { recoveryTokenDigest: q.digest, factorId: started.factorId, verify: verify(), codeDigests: codes.map((c) => c.digest) }, faults.clock),
        duplicate: () =>
          auth.completeRecoveryReenrolment(faults.db, { recoveryTokenDigest: q.digest, factorId: started.factorId, verify: verify(), codeDigests: duplicated }, faults.clock),
        duplicateConstraint: "administrator_recovery_code_pkey",
        secrets: [...codes.map((c) => c.code), started.secret],
      };
    },
    confirmTotpEnrolmentWithRecoveryCodes: async () => {
      const admin = await createWithPendingFactor(faults);
      const codes = generateRecoveryCodes();
      const duplicated = [...codes.slice(0, 9).map((c) => c.digest), codes[0]?.digest as Buffer];
      return {
        name: "confirmTotpEnrolmentWithRecoveryCodes",
        admin,
        label: "insert-recovery-codes",
        table: "administrator_recovery_code",
        hold: { sql: "select 1 from administrator_totp_factor where administrator_id = $1 for update", values: [admin.id] },
        run: () =>
          auth.confirmTotpEnrolmentWithRecoveryCodes(
            faults.db,
            { administratorId: admin.id, factorId: admin.factorId, verify: verifierAt(admin.secret), codeDigests: codes.map((c) => c.digest) },
            faults.clock,
          ),
        duplicate: () =>
          auth.confirmTotpEnrolmentWithRecoveryCodes(
            faults.db,
            { administratorId: admin.id, factorId: admin.factorId, verify: verifierAt(admin.secret), codeDigests: duplicated },
            faults.clock,
          ),
        duplicateConstraint: "administrator_recovery_code_pkey",
        secrets: [...codes.map((c) => c.code), admin.secret],
      };
    },
  };
}

const CASE_NAMES = [
  "completeRecoveryChallenge",
  "startRecoveryReenrolment",
  "regenerateRecoveryCodes",
  "completeRecoveryReenrolment",
  "confirmTotpEnrolmentWithRecoveryCodes",
] as const;

describe("§6.8 database failures, for each new transaction", () => {
  for (const name of CASE_NAMES) {
    it(`${name}: 40P01 reaches the operation itself, rolled back once, not retried, nothing written`, async () => {
      const c = await (await faultCases())[name]!();
      const r = await rival(faultRivals);
      // Makes the operation the likely victim. Not proof of victim selection: the assertion is.
      await r.query("set local deadlock_timeout = '10s'");
      await r.query(c.hold.sql, c.hold.values);
      const before = await fullState(c.admin, c.source, faultRivals);
      faults.hooks.log.length = 0;

      const operation = c.run();
      await awaitBlocked(1, faultRivals);
      const rivalLock = r.query("select id from administrator where id = $1 for update", [c.admin.id]);

      expect(await within(operation, "the deadlocked operation")).toEqual({ ok: false, failure: { code: "RETRYABLE_CONFLICT", sqlState: "40P01" } });
      expect((await within(rivalLock, "the competing lock")).rows).toHaveLength(1);
      await r.commit();

      expect(occurrences(faults, "lock-administrator")).toBe(1);
      expect(await fullState(c.admin, c.source, faultRivals)).toEqual(before);
    });

    for (const [sqlState, expected] of [
      ["40001", { code: "RETRYABLE_CONFLICT", sqlState: "40001" }],
      ["57014", { code: "STORAGE_FAILURE", sqlState: "57014" }],
    ] as const) {
      it(`${name}: an injected ${sqlState} is classified, attempted once and not retried, writing nothing`, async () => {
        const c = await (await faultCases())[name]!();
        const before = await fullState(c.admin, c.source, faultRivals);
        await installFaultTrigger(c.table, sqlState);
        faults.hooks.log.length = 0;

        try {
          const outcome = await within(c.run(), "the operation");
          expect(outcome).toEqual({ ok: false, failure: expected });
          if (!outcome.ok) {
            expectNoCanary(outcome.failure, c.secrets);
          }
        } finally {
          await removeFaultTrigger(c.table);
        }

        expect(occurrences(faults, c.label)).toBe(1);
        expect(occurrences(faults, "lock-administrator")).toBe(1);
        expect(await fullState(c.admin, c.source, faultRivals)).toEqual(before);
      });
    }

    it(`${name}: a genuine 23505 is INTEGRITY_CONFLICT, attempted once, writing nothing`, async () => {
      const c = await (await faultCases())[name]!();
      const before = await fullState(c.admin, c.source, faultRivals);
      faults.hooks.log.length = 0;

      const outcome = await c.duplicate();
      expect(outcome).toEqual({ ok: false, failure: { code: "INTEGRITY_CONFLICT", sqlState: "23505", constraint: c.duplicateConstraint } });
      if (!outcome.ok) {
        expectNoCanary(outcome.failure, c.secrets);
      }
      expect(occurrences(faults, "lock-administrator")).toBe(1);
      expect(await fullState(c.admin, c.source, faultRivals)).toEqual(before);
    });

    it(`${name}: a connection lost before COMMIT rolls back, confirmed from a separate connection`, async () => {
      const c = await (await faultCases())[name]!();
      const before = await fullState(c.admin, c.source, faultRivals);
      await installFaultTrigger(c.table, "sleep");
      faults.hooks.log.length = 0;

      try {
        const operation = c.run();
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
          expect(outcome.failure.code).toBe("STORAGE_FAILURE");
          expectNoCanary(outcome.failure, c.secrets);
          const observed = (outcome.failure as { readonly sqlState?: string }).sqlState;
          expect(observed === undefined || GENUINE_SQLSTATE.test(observed)).toBe(true);
        }
      } finally {
        await removeFaultTrigger(c.table);
      }

      expect(occurrences(faults, c.label)).toBe(1);
      expect(await fullState(c.admin, c.source, faultRivals)).toEqual(before);
    });
  }
});

/* ------------------------------------------------------------------------------------------- */
/* §6.9 Secrecy                                                                                  */
/* ------------------------------------------------------------------------------------------- */

describe("§6.9 secrecy (representative, not an exhaustive proof)", () => {
  it("never renders a code or TOTP secret in outcomes or console output, and stores codes only as digests", async () => {
    const logged: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    methods.forEach((m) => {
      console[m] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    });

    try {
      const admin = await seed();
      const canaries: (Buffer | string)[] = [admin.secret, ...admin.codes.map((c) => c.code)];
      const outcomes: unknown[] = [];
      const { outcome, session: q } = await recover(await challengeFor(admin), admin.codes[0]?.code ?? "");
      outcomes.push(outcome);
      // A wrong code in upper case: a counted failure that leaves Q live.
      const stray = generateRecoveryCodes()[0]?.code.toUpperCase() ?? "";
      canaries.push(stray);
      outcomes.push((await recover(await challengeFor(admin), stray)).outcome);
      const started = await start(q.digest);
      canaries.push(started.secret);
      outcomes.push(started.stored);
      outcomes.push((await complete(q.digest, started.factorId, "000000")).stored);
      outcomes.push((await withZeroed("issue-recovery-session", () => recover(randomBytes(32), admin.codes[2]?.code ?? ""))).outcome);
      outcomes.push((await withCount("insert-recovery-codes", 9, () => regenerate(q.digest))).stored);

      for (const value of outcomes) {
        expectNoCanary(value, canaries);
      }
      expect(logged).toEqual([]);

      // Stored only as digests and ciphertext: no row of any authentication table, for any
      // administrator, carries a code, a TOTP secret or the recovery-session token.
      canaries.push(q.token);
      const tables = [
        "administrator",
        "administrator_totp_factor",
        "administrator_pending_challenge",
        "administrator_consumed_challenge",
        "administrator_session",
        "administrator_recovery_code",
        "authentication_throttle",
        "authentication_source_window",
      ];
      const catalogued = (await rivals.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
            and (table_name like 'administrator%' or table_name like 'authentication%') order by 1`,
      )).rows.map((r) => r.table_name);
      expect(catalogued).toEqual([...tables].sort());
      for (const table of tables) {
        const dump = await rivals.query<{ t: string | null; n: number }>(
          `select json_agg(row_to_json(x))::text as t, count(*)::int as n from ${table} x`,
        );
        expect(dump.rows[0]?.n, table).toBeGreaterThan(0);
        expectNoCanary(dump.rows[0]?.t, canaries);
      }

      // The origin holds only the non-secret session id, never the token or its digest.
      expect((await originOf(admin.id))?.origin).toBe(await sessionIdOf(q));
    } finally {
      methods.forEach((m, i) => {
        console[m] = originals[i] as never;
      });
    }
  });
});
