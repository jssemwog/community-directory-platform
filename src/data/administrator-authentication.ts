/**
 * `C9` administrator authentication persistence (`ADR-028`, issue #258).
 *
 * The operations the first local sign-in journey needs, and only those: the session check and
 * logout; the password step's admission reads and its failure and success transactions; the
 * TOTP challenge-to-session transaction; and provisioning **persistence** (create an
 * administrator, start and confirm TOTP enrolment), with no command around it. Recovery codes,
 * recovery sessions, revoke, disable, reset, key replacement, re-encryption and housekeeping are
 * later slices.
 *
 * Every transaction follows `ADR-028` exactly:
 *
 * - **Lock, then clock, then predicates** (PS-1 rules 2 and 4; PS-8). The administrator row is
 *   locked first, then the presented challenge rows, then the source row, then the counter row,
 *   each counter row inserted empty first if absent. `clock()` is called **once, after the last
 *   lock is granted**, and every expiry, wait and window predicate, every written instant and
 *   the verified TOTP step use that one instant.
 * - **Explicit `READ COMMITTED`, and no automatic retry.** A `40001` or `40P01` is classified
 *   `RETRYABLE_CONFLICT` and returned; nothing here retries it.
 * - **Required row counts** (PS-8b). Each required statement must affect exactly its count, or
 *   the whole transaction rolls back with `ROW_COUNT_PROTOCOL_FAILURE`. Outcomes a race can
 *   produce are decided under the lock **before** the required write, so a required statement
 *   can fail only on a genuine protocol fault.
 * - **Labelled statements.** Each statement starts with an `adr028:<label>` comment, so tests
 *   can count attempts and attack one statement at a time. The label carries no data.
 *
 * Instants cross this boundary as epoch milliseconds, written through
 * `timestamptzFromEpochMilliseconds` and read through the governed `timestamptz` parser, which
 * the pool must register (`ADR-022`).
 */

import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";

import type { AdministratorAuthenticationDatabase } from "./administrator-authentication-table";
import { timestamptzFromEpochMilliseconds } from "./row-mapping";
import { constraintOf, sqlStateOf, storageFailure, type StorageFailure } from "./storage-failure";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";

type AuthenticationDb = Kysely<AdministratorAuthenticationDatabase>;
type AuthenticationTrx = Transaction<AdministratorAuthenticationDatabase>;

/** The application clock, in epoch milliseconds. Called after each lock phase. */
export type Clock = () => number;

/** `ADR-004` P-1 and P-5, as `ADR-028` stores them. */
export const PENDING_CHALLENGE_LIFETIME_MS = 5 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
export const WAIT_FROM_FAILURE = 5;
export const AUTHENTICATOR_CEILING = 100;
export const SOURCE_FAILURE_LIMIT = 20;
export const SOURCE_WINDOW_MS = 60 * 60_000;

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const RETRYABLE_CONFLICT_STATES: readonly string[] = ["40001", "40P01"];

/** A failure of the store itself. Never an authentication outcome, and never counted. */
export type AuthenticationStorageFailure =
  /** PS-8b: a required statement affected a count other than its own. Rolled back. */
  | {
      readonly code: "ROW_COUNT_PROTOCOL_FAILURE";
      readonly statement: string;
      readonly expected: number;
      readonly actual: number;
    }
  /** An integrity class fired, such as a duplicate token digest. Rolled back, never retried. */
  | { readonly code: "INTEGRITY_CONFLICT"; readonly sqlState: string; readonly constraint?: string }
  /** `40001` or `40P01`: classified and returned, **not** retried. */
  | { readonly code: "RETRYABLE_CONFLICT"; readonly sqlState: string }
  /** A stored instant the governed parser refused. */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  /** Everything else, including a lost connection; a SQLSTATE only when the driver gave one. */
  | StorageFailure;

export type Stored<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AuthenticationStorageFailure };

class RowCountFailure extends Error {
  constructor(
    readonly statement: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`required statement ${statement} affected ${actual} rows, not ${expected}`);
    this.name = "RowCountFailure";
  }
}

/** Ends a transaction by rolling it back while reporting an ordinary outcome. */
class RollBackWith<T> extends Error {
  constructor(readonly value: T) {
    super("rolled back with an outcome");
    this.name = "RollBackWith";
  }
}

function classify(cause: unknown): AuthenticationStorageFailure {
  if (cause instanceof RowCountFailure) {
    return {
      code: "ROW_COUNT_PROTOCOL_FAILURE",
      statement: cause.statement,
      expected: cause.expected,
      actual: cause.actual,
    };
  }

  if (cause instanceof TimestamptzParseError) {
    return { code: "STORED_INSTANT_UNREADABLE", reason: cause.reason };
  }

  const sqlState = sqlStateOf(cause);

  if (
    sqlState === UNIQUE_VIOLATION ||
    sqlState === CHECK_VIOLATION ||
    sqlState === FOREIGN_KEY_VIOLATION
  ) {
    const constraint = constraintOf(cause);
    return constraint === undefined
      ? { code: "INTEGRITY_CONFLICT", sqlState }
      : { code: "INTEGRITY_CONFLICT", sqlState, constraint };
  }

  if (sqlState !== undefined && RETRYABLE_CONFLICT_STATES.includes(sqlState)) {
    return { code: "RETRYABLE_CONFLICT", sqlState };
  }

  return storageFailure(cause);
}

/** One `READ COMMITTED` transaction, attempted exactly once. */
async function transact<T>(
  db: AuthenticationDb,
  body: (trx: AuthenticationTrx) => Promise<T>,
): Promise<Stored<T>> {
  try {
    const value = await db.transaction().setIsolationLevel("read committed").execute(body);
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof RollBackWith) {
      return { ok: true, value: cause.value as T };
    }

    return { ok: false, failure: classify(cause) };
  }
}

/** A single statement outside a transaction, attempted exactly once. */
async function single<T>(body: () => Promise<T>): Promise<Stored<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (cause) {
    return { ok: false, failure: classify(cause) };
  }
}

interface Executed<R> {
  readonly rows: R[];
  readonly numAffectedRows?: bigint;
}

async function run<R>(
  executor: AuthenticationDb | AuthenticationTrx,
  label: string,
  body: RawBuilder<unknown>,
): Promise<Executed<R>> {
  const statement = sql`${sql.raw(`/* adr028:${label} */ `)}${body}`;
  return (await statement.execute(executor)) as Executed<R>;
}

function affected(result: Executed<unknown>): number {
  return result.numAffectedRows === undefined ? result.rows.length : Number(result.numAffectedRows);
}

/** PS-8b: a required statement affecting exactly `expected` rows, or a rollback. */
async function required<R>(
  executor: AuthenticationDb | AuthenticationTrx,
  label: string,
  expected: number,
  body: RawBuilder<unknown>,
): Promise<Executed<R>> {
  const result = await run<R>(executor, label, body);
  const actual = affected(result);

  if (actual !== expected) {
    throw new RowCountFailure(label, expected, actual);
  }

  return result;
}

const at = (epochMilliseconds: number) => timestamptzFromEpochMilliseconds(epochMilliseconds);

/* ------------------------------------------------------------------------------------------- */
/* Lock-phase helpers (PS-1 rule 4) and abuse-control state (PS-7)                              */
/* ------------------------------------------------------------------------------------------- */

interface AdministratorRow {
  readonly id: string;
  readonly password_hash: string;
  readonly password_disabled_at: number | null;
  readonly disabled_at: number | null;
}

/** Rank 1: the one administrator row. */
async function lockAdministrator(
  trx: AuthenticationTrx,
  administratorId: string,
): Promise<AdministratorRow | undefined> {
  const result = await run<AdministratorRow>(
    trx,
    "lock-administrator",
    sql`select id, password_hash, password_disabled_at, disabled_at
          from administrator where id = ${administratorId} for update`,
  );

  return result.rows[0];
}

/** Rank 4: the one source row, inserted empty first if absent so that it can be locked. */
async function lockSource(trx: AuthenticationTrx, sourceDigest: Buffer): Promise<void> {
  await run(
    trx,
    "ensure-source-row",
    sql`insert into authentication_source_window (source_digest, recent_failures)
        values (${sourceDigest}, '{}'::timestamptz(3)[])
        on conflict (source_digest) do nothing`,
  );
  await required(
    trx,
    "lock-source-row",
    1,
    sql`select 1 from authentication_source_window where source_digest = ${sourceDigest} for update`,
  );
}

type CounterScope = "password" | "totp";

interface CounterRow {
  readonly consecutive_failures: number;
  readonly wait_until: number | null;
}

/**
 * Rank 5: one counter row, inserted empty first if absent. An empty row's `last_failure_at` is
 * the epoch, a sentinel rather than a clock reading, because the lock phase precedes the clock
 * (PS-1 rule 2); no predicate reads it, and the first counted failure overwrites it.
 */
async function lockCounter(
  trx: AuthenticationTrx,
  scope: CounterScope,
  subjectDigest: Buffer,
): Promise<CounterRow> {
  await run(
    trx,
    "ensure-counter-row",
    sql`insert into authentication_throttle
          (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
        values (${scope}, ${subjectDigest}, 0, null, to_timestamp(0))
        on conflict (scope, subject_digest) do nothing`,
  );
  const locked = await required<CounterRow>(
    trx,
    "lock-counter-row",
    1,
    sql`select consecutive_failures, wait_until from authentication_throttle
         where scope = ${scope} and subject_digest = ${subjectDigest} for update`,
  );

  return locked.rows[0] as CounterRow;
}

function waitActive(counter: CounterRow | undefined, now: number): boolean {
  return counter?.wait_until !== null && counter?.wait_until !== undefined && counter.wait_until > now;
}

/** D-6: failures counted in the rolling hour before `now`. */
async function sourceFailuresWithinWindow(
  executor: AuthenticationDb | AuthenticationTrx,
  sourceDigest: Buffer,
  now: number,
): Promise<number> {
  const result = await run<{ readonly n: number }>(
    executor,
    "count-source-window",
    sql`select count(*)::int as n
          from authentication_source_window w
          cross join lateral unnest(w.recent_failures) as u(failed_at)
         where w.source_digest = ${sourceDigest}
           and u.failed_at > ${at(now)} - interval '1 hour'`,
  );

  return result.rows[0]?.n ?? 0;
}

/**
 * PS-8 *Failure counter*: one atomic upsert computing the wait in the same statement.
 *
 * The doubling exponent is capped at 7 before `power` is applied. `ADR-028`'s shape computes
 * `interval '30 seconds' * power(2, n - 5)` and then takes the `least` with one hour, but
 * PostgreSQL evaluates both arguments, and at large `n` the product overflows `interval` and
 * the statement fails. 30 s × 2^7 already exceeds an hour, so the cap changes no result: the
 * wait still doubles from 30 seconds and still stops at one hour (`ADR-004` P-5).
 */
async function countFailure(
  trx: AuthenticationTrx,
  scope: CounterScope,
  subjectDigest: Buffer,
  now: number,
): Promise<number> {
  const counted = await required<{ readonly consecutive_failures: number }>(
    trx,
    "count-failure",
    1,
    sql`insert into authentication_throttle as t
          (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
        values (${scope}, ${subjectDigest}, 1, null, ${at(now)})
        on conflict (scope, subject_digest) do update set
          consecutive_failures = t.consecutive_failures + 1,
          last_failure_at = ${at(now)},
          wait_until = case
            when t.consecutive_failures + 1 >= 5 then ${at(now)} + least(
              interval '30 seconds' * power(2, least(t.consecutive_failures + 1 - 5, 7)),
              interval '1 hour')
          end
        returning consecutive_failures`,
  );

  return counted.rows[0]?.consecutive_failures ?? 0;
}

/** PS-7 / D-6: append `now`, drop instants older than one hour, keep the latest 20. */
async function countSourceFailure(
  trx: AuthenticationTrx,
  sourceDigest: Buffer,
  now: number,
): Promise<void> {
  await required(
    trx,
    "count-source-failure",
    1,
    sql`insert into authentication_source_window as w (source_digest, recent_failures)
        values (${sourceDigest}, array[${at(now)}]::timestamptz(3)[])
        on conflict (source_digest) do update set recent_failures = (
          select array_agg(f order by f)
            from (select f from unnest(array_append(w.recent_failures, (${at(now)})::timestamptz(3))) as u(f)
                   where f > ${at(now)} - interval '1 hour'
                   order by f desc limit 20) as kept)`,
  );
}

/** D-14: mark the administrator's pending challenges invalidated. Cleanup. */
async function invalidatePendingChallenges(
  trx: AuthenticationTrx,
  administratorId: string,
): Promise<void> {
  await run(
    trx,
    "invalidate-pending-challenges",
    sql`update administrator_pending_challenge set invalidated = true
         where administrator_id = ${administratorId} and invalidated = false`,
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Provisioning persistence (no command; recovery-code issuance deferred to migration 004)     */
/* ------------------------------------------------------------------------------------------- */

export interface SealedFactorMaterial {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

/** Store a new administrator. The username and hash must already satisfy D-1 and D-2. */
export async function createAdministrator(
  db: AuthenticationDb,
  input: { readonly administratorId: string; readonly username: string; readonly passwordHash: string },
  clock: Clock,
): Promise<Stored<{ readonly code: "ADMINISTRATOR_CREATED" }>> {
  // A transaction although it is one statement, so a required-count failure can roll it back.
  return transact(db, async (trx) => {
    const now = clock();
    await required(
      trx,
      "create-administrator",
      1,
      sql`insert into administrator (id, username, password_hash, password_disabled_at, disabled_at, created_at)
          values (${input.administratorId}, ${input.username}, ${input.passwordHash}, null, null, ${at(now)})`,
    );
    return { code: "ADMINISTRATOR_CREATED" } as const;
  });
}

export type EnrolmentOutcome =
  | { readonly code: "ENROLMENT_STARTED" }
  | { readonly code: "ADMINISTRATOR_NOT_FOUND" }
  | { readonly code: "ACCOUNT_DISABLED" };

/** PS-8 *Re-enrolment start*, provisioning form: a new `factor_id`, pending confirmation. */
export async function startTotpEnrolment(
  db: AuthenticationDb,
  input: {
    readonly administratorId: string;
    readonly factorId: string;
    readonly material: SealedFactorMaterial;
  },
  clock: Clock,
): Promise<Stored<EnrolmentOutcome>> {
  const { administratorId, factorId, material } = input;

  return transact(db, async (trx) => {
    const administrator = await lockAdministrator(trx, administratorId);
    clock();

    if (administrator === undefined) {
      throw new RollBackWith({ code: "ADMINISTRATOR_NOT_FOUND" } as const);
    }

    if (administrator.disabled_at !== null) {
      throw new RollBackWith({ code: "ACCOUNT_DISABLED" } as const);
    }

    await required(
      trx,
      "start-enrolment",
      1,
      sql`insert into administrator_totp_factor
            (administrator_id, state, factor_id, secret_ciphertext, secret_iv, secret_tag,
             key_version, last_accepted_step)
          values (${administratorId}, 'pending_confirmation', ${factorId}, ${material.ciphertext},
                  ${material.iv}, ${material.tag}, ${material.keyVersion}, null)
          on conflict (administrator_id) do update set
            state = 'pending_confirmation', factor_id = excluded.factor_id,
            secret_ciphertext = excluded.secret_ciphertext, secret_iv = excluded.secret_iv,
            secret_tag = excluded.secret_tag, key_version = excluded.key_version,
            last_accepted_step = null`,
    );
    await invalidatePendingChallenges(trx, administratorId);
    await run(
      trx,
      "delete-administrator-sessions",
      sql`delete from administrator_session
           where administrator_id = ${administratorId} and kind = 'administrator'`,
    );

    return { code: "ENROLMENT_STARTED" } as const;
  });
}

export type ConfirmationOutcome =
  | { readonly code: "ENROLMENT_CONFIRMED" }
  | { readonly code: "ADMINISTRATOR_NOT_FOUND" }
  | { readonly code: "ACCOUNT_DISABLED" }
  /** The factor is no longer the pending one verified: replaced, confirmed or discarded. */
  | { readonly code: "FACTOR_NOT_PENDING" };

/** PS-8 *TOTP confirmation*: confirm only the factor generated in this enrolment. */
export async function confirmTotpEnrolment(
  db: AuthenticationDb,
  input: { readonly administratorId: string; readonly factorId: string; readonly step: number },
  clock: Clock,
): Promise<Stored<ConfirmationOutcome>> {
  const { administratorId, factorId, step } = input;

  return transact(db, async (trx) => {
    const administrator = await lockAdministrator(trx, administratorId);
    clock();

    if (administrator === undefined) {
      throw new RollBackWith({ code: "ADMINISTRATOR_NOT_FOUND" } as const);
    }

    if (administrator.disabled_at !== null) {
      throw new RollBackWith({ code: "ACCOUNT_DISABLED" } as const);
    }

    const pending = await run<{ readonly state: string; readonly factor_id: string | null }>(
      trx,
      "read-factor",
      sql`select state, factor_id from administrator_totp_factor
           where administrator_id = ${administratorId}`,
    );
    const factor = pending.rows[0];

    if (
      factor === undefined ||
      factor.state !== "pending_confirmation" ||
      factor.factor_id !== factorId
    ) {
      throw new RollBackWith({ code: "FACTOR_NOT_PENDING" } as const);
    }

    await required(
      trx,
      "confirm-enrolment",
      1,
      sql`update administrator_totp_factor set state = 'active', last_accepted_step = ${step}
           where administrator_id = ${administratorId} and factor_id = ${factorId}
             and state = 'pending_confirmation'`,
    );
    await invalidatePendingChallenges(trx, administratorId);

    return { code: "ENROLMENT_CONFIRMED" } as const;
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Session check and logout (PS-8)                                                             */
/* ------------------------------------------------------------------------------------------- */

export type SessionCheckOutcome =
  | { readonly code: "SESSION_VALID"; readonly administratorId: string; readonly kind: string }
  | { readonly code: "SESSION_REFUSED" };

/**
 * PS-8 *Session check*: lock the one session row, sample the clock, then one conditional
 * `UPDATE` covering idle and absolute expiry and the account's enabled state. No administrator
 * lock is taken (a PS-1 rule 4 exception), so the check never waits once it holds its row.
 * Only `kind = 'administrator'` satisfies `C8`; the caller enforces that on the returned kind.
 *
 * The `UPDATE` is **(required)** under PS-8b with its count of 1, and PS-8 makes its zero rows
 * the ordinary refusal (idle, absolute expiry or a disabled account). So 0 refuses, 1 is valid,
 * and any other count is a protocol failure that rolls the activity update back.
 */
export async function checkSession(
  db: AuthenticationDb,
  input: { readonly tokenDigest: Buffer },
  clock: Clock,
): Promise<Stored<SessionCheckOutcome>> {
  const { tokenDigest } = input;

  return transact(db, async (trx) => {
    const locked = await run(
      trx,
      "lock-session",
      sql`select 1 from administrator_session where token_digest = ${tokenDigest} for update`,
    );

    if (locked.rows.length === 0) {
      throw new RollBackWith({ code: "SESSION_REFUSED" } as const);
    }

    const now = clock();
    const checked = await run<{ readonly administrator_id: string; readonly kind: string }>(
      trx,
      "check-session",
      sql`update administrator_session s set last_activity_at = ${at(now)}
            from administrator a
           where s.token_digest = ${tokenDigest} and a.id = s.administrator_id
             and a.disabled_at is null
             and s.absolute_expires_at > ${at(now)}
             and s.last_activity_at > ${at(now)} - interval '30 minutes'
          returning s.administrator_id, s.kind`,
    );
    const count = affected(checked);

    if (count === 0) {
      throw new RollBackWith({ code: "SESSION_REFUSED" } as const);
    }

    const row = checked.rows[0];

    if (count !== 1 || row === undefined) {
      throw new RowCountFailure("check-session", 1, count);
    }

    return { code: "SESSION_VALID", administratorId: row.administrator_id, kind: row.kind } as const;
  });
}

/** PS-8 *Logout*: cleanup; every later check refuses. */
export async function logout(
  db: AuthenticationDb,
  input: { readonly tokenDigest: Buffer },
): Promise<Stored<{ readonly code: "LOGGED_OUT" }>> {
  return single(async () => {
    await run(
      db,
      "logout",
      sql`delete from administrator_session where token_digest = ${input.tokenDigest}`,
    );
    return { code: "LOGGED_OUT" } as const;
  });
}

/* ------------------------------------------------------------------------------------------- */
/* The password step (PS-8 *Password step*)                                                    */
/* ------------------------------------------------------------------------------------------- */

export interface PasswordAdmission {
  readonly sourceLimited: boolean;
  readonly waitActive: boolean;
}

/**
 * The admission reads, used twice: on arrival, and again after a hash slot is granted, each
 * with its own freshly sampled `now` (PS-1 rule 2). They are reads and take no lock; the bound
 * on what they can miss is `ADR-028` D-17's.
 */
export async function readPasswordAdmission(
  db: AuthenticationDb,
  input: { readonly sourceDigest: Buffer; readonly usernameDigest: Buffer },
  now: number,
): Promise<Stored<PasswordAdmission>> {
  return single(async () => {
    const failures = await sourceFailuresWithinWindow(db, input.sourceDigest, now);
    const counter = await run<CounterRow>(
      db,
      "read-password-counter",
      sql`select consecutive_failures, wait_until from authentication_throttle
           where scope = 'password' and subject_digest = ${input.usernameDigest}`,
    );

    return {
      sourceLimited: failures >= SOURCE_FAILURE_LIMIT,
      waitActive: waitActive(counter.rows[0], now),
    };
  });
}

export interface StoredCredential {
  readonly administratorId: string;
  readonly passwordHash: string;
}

/** The account a normalized username names, if any. A read; nothing is locked. */
export async function findCredential(
  db: AuthenticationDb,
  username: string,
): Promise<Stored<StoredCredential | undefined>> {
  return single(async () => {
    const found = await run<{ readonly id: string; readonly password_hash: string }>(
      db,
      "find-credential",
      sql`select id, password_hash from administrator where username = ${username}`,
    );
    const row = found.rows[0];

    return row === undefined ? undefined : { administratorId: row.id, passwordHash: row.password_hash };
  });
}

export interface PasswordFailureRecorded {
  readonly code: "PASSWORD_FAILURE_COUNTED";
  readonly consecutiveFailures: number;
  readonly passwordDisabled: boolean;
}

/**
 * The password step's failure transaction. A known account's row is locked first (rank 1); an
 * unknown username has no row and takes ranks 4 and 5 only. The 100th consecutive failure of a
 * known account disables its password authenticator and invalidates its pending challenges
 * (`ADR-004` P-5; D-14).
 */
export async function recordPasswordFailure(
  db: AuthenticationDb,
  input: {
    readonly administratorId: string | undefined;
    readonly usernameDigest: Buffer;
    readonly sourceDigest: Buffer;
  },
  clock: Clock,
): Promise<Stored<PasswordFailureRecorded>> {
  const { administratorId, usernameDigest, sourceDigest } = input;

  return transact(db, async (trx) => {
    const administrator =
      administratorId === undefined ? undefined : await lockAdministrator(trx, administratorId);
    await lockSource(trx, sourceDigest);
    await lockCounter(trx, "password", usernameDigest);
    const now = clock();

    const consecutiveFailures = await countFailure(trx, "password", usernameDigest, now);
    await countSourceFailure(trx, sourceDigest, now);

    let passwordDisabled = administrator?.password_disabled_at !== null && administrator !== undefined;

    if (
      administrator !== undefined &&
      administrator.password_disabled_at === null &&
      consecutiveFailures >= AUTHENTICATOR_CEILING
    ) {
      await required(
        trx,
        "password-ceiling",
        1,
        sql`update administrator set password_disabled_at = ${at(now)}
             where id = ${administrator.id} and password_disabled_at is null`,
      );
      await invalidatePendingChallenges(trx, administrator.id);
      passwordDisabled = true;
    }

    return { code: "PASSWORD_FAILURE_COUNTED", consecutiveFailures, passwordDisabled } as const;
  });
}

export type ChallengeIssueOutcome =
  | { readonly code: "CHALLENGE_ISSUED"; readonly administratorId: string; readonly expiresAt: number }
  /** PS-8a: the verified credential is no longer current, or the account cannot sign in. */
  | {
      readonly code: "VERIFICATION_OBSOLETE";
      readonly reason:
        | "ADMINISTRATOR_NOT_FOUND"
        | "ACCOUNT_DISABLED"
        | "PASSWORD_DISABLED"
        | "PASSWORD_CHANGED";
    };

/**
 * The password step's success transaction: issue a challenge **only** while the stored hash is
 * still exactly the string that was verified (PS-8a). Anything else is the generic failure,
 * uncounted (D-15). A success clears the username's password counter.
 */
export async function issuePasswordChallenge(
  db: AuthenticationDb,
  input: {
    readonly administratorId: string;
    readonly verifiedPasswordHash: string;
    readonly usernameDigest: Buffer;
    readonly challengeDigest: Buffer;
  },
  clock: Clock,
): Promise<Stored<ChallengeIssueOutcome>> {
  const { administratorId, verifiedPasswordHash, usernameDigest, challengeDigest } = input;

  return transact(db, async (trx) => {
    const administrator = await lockAdministrator(trx, administratorId);
    const now = clock();

    const reason =
      administrator === undefined
        ? "ADMINISTRATOR_NOT_FOUND"
        : administrator.disabled_at !== null
          ? "ACCOUNT_DISABLED"
          : administrator.password_disabled_at !== null
            ? "PASSWORD_DISABLED"
            : administrator.password_hash !== verifiedPasswordHash
              ? "PASSWORD_CHANGED"
              : undefined;

    if (reason !== undefined) {
      throw new RollBackWith({ code: "VERIFICATION_OBSOLETE", reason } as const);
    }

    await required(
      trx,
      "issue-challenge",
      1,
      sql`insert into administrator_pending_challenge
            (token_digest, administrator_id, created_at, expires_at, invalidated)
          values (${challengeDigest}, ${administratorId}, ${at(now)},
                  ${at(now)} + interval '5 minutes', false)`,
    );
    await run(
      trx,
      "clear-password-counter",
      sql`delete from authentication_throttle
           where scope = 'password' and subject_digest = ${usernameDigest}`,
    );

    return {
      code: "CHALLENGE_ISSUED",
      administratorId,
      expiresAt: now + PENDING_CHALLENGE_LIFETIME_MS,
    } as const;
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Challenge to full session — the TOTP step (PS-4, PS-8, PS-8a)                               */
/* ------------------------------------------------------------------------------------------- */

/** The active factor, as stored, handed to the injected verifier inside the lock. */
export interface StoredActiveFactor {
  readonly administratorId: string;
  readonly factorId: string;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

/**
 * The injected verifier (issue #258 S-6), called **inside** the locked transaction with the
 * post-lock instant, so `data/` never decrypts or validates anything itself.
 */
export type TotpVerdict =
  | { readonly kind: "match"; readonly step: number }
  | { readonly kind: "mismatch" }
  /** The material cannot be opened under any available key. Uncounted. */
  | { readonly kind: "unreadable" };

export type TotpVerifier = (factor: StoredActiveFactor, now: number) => TotpVerdict;

export type SecondFactorOutcome =
  | {
      readonly code: "SESSION_ISSUED";
      readonly administratorId: string;
      readonly sessionId: string;
      readonly absoluteExpiresAt: number;
    }
  /** Uncounted: no credential was checked, or the challenge is no longer usable (D-15). */
  | {
      readonly code: "REFUSED";
      readonly reason:
        | "UNKNOWN_CHALLENGE"
        | "EXPIRED_CHALLENGE"
        | "ACCOUNT_DISABLED"
        | "INVALIDATED_CHALLENGE"
        | "THROTTLED"
        | "FACTOR_UNAVAILABLE";
    }
  /** Counted failures. */
  | {
      readonly code: "FAILED";
      readonly reason: "CONSUMED_CHALLENGE_REPLAY" | "TOTP_REPLAY" | "WRONG_CODE";
      readonly consecutiveFailures: number;
      readonly factorDisabled: boolean;
    };

interface ChallengeRow {
  readonly administrator_id: string;
  readonly expires_at: number;
}

interface PendingRow extends ChallengeRow {
  readonly invalidated: boolean;
}

interface FactorRow {
  readonly state: string;
  readonly factor_id: string | null;
  readonly secret_ciphertext: Buffer | null;
  readonly secret_iv: Buffer | null;
  readonly secret_tag: Buffer | null;
  readonly key_version: number | null;
  readonly last_accepted_step: string | null;
}

/** Resolve the challenge's administrator before the lock, from either table. A read. */
async function resolveChallengeOwner(
  db: AuthenticationDb,
  challengeDigest: Buffer,
): Promise<string | undefined> {
  const found = await run<{ readonly administrator_id: string }>(
    db,
    "resolve-challenge",
    sql`select administrator_id from administrator_pending_challenge where token_digest = ${challengeDigest}
        union all
        select administrator_id from administrator_consumed_challenge where token_digest = ${challengeDigest}`,
  );

  return found.rows[0]?.administrator_id;
}

async function readFactor(trx: AuthenticationTrx, administratorId: string): Promise<FactorRow | undefined> {
  const found = await run<FactorRow>(
    trx,
    "read-factor",
    sql`select state, factor_id, secret_ciphertext, secret_iv, secret_tag, key_version,
               last_accepted_step::text as last_accepted_step
          from administrator_totp_factor where administrator_id = ${administratorId}`,
  );

  return found.rows[0];
}

function activeFactorOf(administratorId: string, row: FactorRow | undefined): StoredActiveFactor | undefined {
  if (
    row === undefined ||
    row.state !== "active" ||
    row.factor_id === null ||
    row.secret_ciphertext === null ||
    row.secret_iv === null ||
    row.secret_tag === null ||
    row.key_version === null
  ) {
    return undefined;
  }

  return {
    administratorId,
    factorId: row.factor_id,
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
    keyVersion: row.key_version,
  };
}

/**
 * Count one TOTP-step failure against the administrator's `totp` counter and the source, then
 * apply the D-3 ceiling: the 100th consecutive failure of an active factor makes it
 * `reenrolment_required`, discards its material and `factor_id`, and invalidates the pending
 * challenges (D-14). Runs inside the locked transaction.
 */
async function countSecondFactorFailure(
  trx: AuthenticationTrx,
  administratorId: string,
  subjectDigest: Buffer,
  sourceDigest: Buffer,
  factor: FactorRow | undefined,
  now: number,
): Promise<{ readonly consecutiveFailures: number; readonly factorDisabled: boolean }> {
  const consecutiveFailures = await countFailure(trx, "totp", subjectDigest, now);
  await countSourceFailure(trx, sourceDigest, now);

  if (consecutiveFailures >= AUTHENTICATOR_CEILING && factor?.state === "active") {
    await required(
      trx,
      "totp-ceiling",
      1,
      sql`update administrator_totp_factor set state = 'reenrolment_required', factor_id = null,
                 secret_ciphertext = null, secret_iv = null, secret_tag = null,
                 key_version = null, last_accepted_step = null
           where administrator_id = ${administratorId} and state = 'active'`,
    );
    await invalidatePendingChallenges(trx, administratorId);
    return { consecutiveFailures, factorDisabled: true };
  }

  return { consecutiveFailures, factorDisabled: false };
}

/**
 * PS-8 *Challenge to full session*.
 *
 * The owner is resolved before the lock; then, under the administrator lock, **both challenge
 * tables are looked up again**, so a consumption that committed while this request waited is
 * found as consumed and counted, never mistaken for an unknown challenge. Classification
 * follows the PS-4 order, at the post-lock instant, **before any verification or accounting**:
 * unknown, expired (whatever its table), disabled, invalidated (all uncounted), then the
 * throttle (uncounted), then consumed (a counted replay, D-15) and live.
 */
export async function completeTotpChallenge(
  db: AuthenticationDb,
  input: {
    readonly challengeDigest: Buffer;
    readonly sourceDigest: Buffer;
    readonly totpSubjectDigestFor: (administratorId: string) => Buffer;
    readonly verify: TotpVerifier;
    readonly sessionTokenDigest: Buffer;
    readonly sessionId: string;
  },
  clock: Clock,
): Promise<Stored<SecondFactorOutcome>> {
  const { challengeDigest, sourceDigest, verify, sessionTokenDigest, sessionId } = input;

  const owner = await single(() => resolveChallengeOwner(db, challengeDigest));

  if (!owner.ok) {
    return owner;
  }

  const administratorId = owner.value;

  if (administratorId === undefined) {
    // A digest never returns to either table once gone, so this miss is final.
    return { ok: true, value: { code: "REFUSED", reason: "UNKNOWN_CHALLENGE" } };
  }

  const subjectDigest = input.totpSubjectDigestFor(administratorId);
  const refuse = (reason: Extract<SecondFactorOutcome, { code: "REFUSED" }>["reason"]) =>
    new RollBackWith({ code: "REFUSED", reason } as const);

  return transact(db, async (trx): Promise<SecondFactorOutcome> => {
    const administrator = await lockAdministrator(trx, administratorId);
    const pending = await run<PendingRow>(
      trx,
      "lock-pending-challenge",
      sql`select administrator_id, expires_at, invalidated from administrator_pending_challenge
           where token_digest = ${challengeDigest} and administrator_id = ${administratorId}
           for update`,
    );
    const consumed = await run<ChallengeRow>(
      trx,
      "lock-consumed-challenge",
      sql`select administrator_id, expires_at from administrator_consumed_challenge
           where token_digest = ${challengeDigest} and administrator_id = ${administratorId}
           for update`,
    );
    await lockSource(trx, sourceDigest);
    const counter = await lockCounter(trx, "totp", subjectDigest);
    const now = clock();

    const pendingRow = pending.rows[0];
    const consumedRow = consumed.rows[0];
    const challenge: ChallengeRow | undefined = pendingRow ?? consumedRow;

    if (administrator === undefined || challenge === undefined) {
      throw refuse("UNKNOWN_CHALLENGE");
    }

    if (challenge.expires_at <= now) {
      throw refuse("EXPIRED_CHALLENGE");
    }

    if (administrator.disabled_at !== null || administrator.password_disabled_at !== null) {
      throw refuse("ACCOUNT_DISABLED");
    }

    if (pendingRow?.invalidated === true) {
      throw refuse("INVALIDATED_CHALLENGE");
    }

    if (
      waitActive(counter, now) ||
      (await sourceFailuresWithinWindow(trx, sourceDigest, now)) >= SOURCE_FAILURE_LIMIT
    ) {
      throw refuse("THROTTLED");
    }

    const factorRow = await readFactor(trx, administratorId);

    if (consumedRow !== undefined) {
      const counted = await countSecondFactorFailure(
        trx, administratorId, subjectDigest, sourceDigest, factorRow, now,
      );
      return { code: "FAILED", reason: "CONSUMED_CHALLENGE_REPLAY", ...counted };
    }

    const factor = activeFactorOf(administratorId, factorRow);

    if (factor === undefined) {
      throw refuse("FACTOR_UNAVAILABLE");
    }

    const verdict = verify(factor, now);

    if (verdict.kind === "unreadable") {
      throw refuse("FACTOR_UNAVAILABLE");
    }

    const lastAccepted = factorRow?.last_accepted_step === null || factorRow === undefined
      ? -1
      : Number(factorRow.last_accepted_step);

    if (verdict.kind === "mismatch" || verdict.step <= lastAccepted) {
      const counted = await countSecondFactorFailure(
        trx, administratorId, subjectDigest, sourceDigest, factorRow, now,
      );
      return {
        code: "FAILED",
        reason: verdict.kind === "mismatch" ? "WRONG_CODE" : "TOTP_REPLAY",
        ...counted,
      };
    }

    // Consume the challenge: ADR-004 P-7's conditional DELETE, plus the D-15 record.
    const deleted = await required<{ readonly expires_at: number }>(
      trx,
      "consume-challenge",
      1,
      sql`delete from administrator_pending_challenge
           where token_digest = ${challengeDigest} and administrator_id = ${administratorId}
             and invalidated = false and expires_at > ${at(now)}
          returning expires_at`,
    );
    const originalExpiry = deleted.rows[0]?.expires_at ?? now;
    await required(
      trx,
      "record-consumed-challenge",
      1,
      sql`insert into administrator_consumed_challenge (token_digest, administrator_id, expires_at)
          values (${challengeDigest}, ${administratorId}, ${at(originalExpiry)})`,
    );
    await required(
      trx,
      "advance-totp-step",
      1,
      sql`update administrator_totp_factor set last_accepted_step = ${verdict.step}
           where administrator_id = ${administratorId} and factor_id = ${factor.factorId}
             and state = 'active' and last_accepted_step < ${verdict.step}`,
    );
    await required(
      trx,
      "issue-session",
      1,
      sql`insert into administrator_session
            (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
          values (${sessionTokenDigest}, ${sessionId}, ${administratorId}, 'administrator',
                  ${at(now)}, ${at(now)}, ${at(now)} + interval '12 hours')`,
    );
    await run(
      trx,
      "clear-totp-counter",
      sql`delete from authentication_throttle
           where scope = 'totp' and subject_digest = ${subjectDigest}`,
    );

    return {
      code: "SESSION_ISSUED",
      administratorId,
      sessionId,
      absoluteExpiresAt: now + SESSION_ABSOLUTE_MS,
    };
  });
}
