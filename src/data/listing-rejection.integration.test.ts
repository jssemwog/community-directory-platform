/**
 * Attacking tests for `rejectPendingListing` (`OP-8`, issue #234), against a real PostgreSQL
 * server.
 *
 * Each test names the requirement or invariant it attacks. The suite proves behaviour through
 * results and stored rows, and separately proves the transaction's **footprint** — the statements
 * PostgreSQL actually received — where behaviour alone cannot tell two implementations apart.
 * Footprint assertions are labelled as such; they are not behavioural evidence.
 *
 * ## How the interleavings stay deterministic and bounded
 *
 * No test sleeps, polls an assertion until it passes, or re-runs anything. A participant that
 * must block is confirmed blocked through `pg_stat_activity` and `pg_blocking_pids`, by a
 * **blocking chain** from its own uniquely named session to the rival — direct, or indirect
 * through another identified operation session. That establishes who blocks whom; **no test
 * depends on the order in which waiters acquire a lock.**
 *
 * Every wait has a deadline and a named sentinel, every observer, controller and rival statement
 * carries a server-side `statement_timeout`, and every operation, release, cancellation,
 * termination and pool destruction runs under a **safety ceiling** (`withinCeiling`). A ceiling
 * does not cancel the work it races, so each overrun is followed by **termination of precisely
 * identified owned backends** and a second bounded wait. Cancellation and termination go through
 * a dedicated **controller** pool, so a stuck observer cannot hold the connection they need. Each
 * test and hook declares a timeout budget larger than its complete bounded cleanup path (see
 * *Timeout budgets*). Ceilings are never oracles: when everything releases they never fire.
 *
 * The suite's own failure paths are exercised by the *bounded cleanup* tests at the end. Those
 * are evidence about this harness, not about `OP-8`.
 *
 * ## Fault injection
 *
 * Test-only triggers, functions and one sequence are created inside this suite's own disposable
 * databases, dropped in each test's `finally` and swept unconditionally in `afterEach`. They are
 * fixtures, not migrations, and nothing in `src/` knows they exist.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

import type { AdministrativeEdit } from "../domain/listing/administrative-edit";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing, ListingContent } from "../domain/listing/listing";
import type { Result } from "../domain/listing/result";
import {
  createListingPersistence,
  startupOptionsFor,
  type ListingPersistence,
} from "./connection";
import { applyAdministrativeEditToPendingListing } from "./listing-administrative-edit";
import { findListingById, insertSubmittedListing } from "./listing-repository";
import type { ListingDatabase } from "./listing-table";
import { rejectPendingListing, type RejectPendingListingFailure } from "./listing-rejection";
import { timestamptzFromEpochMilliseconds } from "./row-mapping";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";

const VERIFIED_DATABASE = "listing_rejection_verification";
const HOSTILE_DATABASE = "listing_rejection_hostile";

const cluster = useEmbeddedPostgres({
  slug: "listing-rejection",
  databases: [VERIFIED_DATABASE, HOSTILE_DATABASE],
  migrate: [VERIFIED_DATABASE, HOSTILE_DATABASE],
});

/* ------------------------------------------------------------------------------------------- */
/* Timeout budgets                                                                                */
/* ------------------------------------------------------------------------------------------- */

/** Server-side bound on every observer, controller and rival statement (`statement_timeout`). */
const STATEMENT_TIMEOUT_MS = 3_000;
/** One bounded step: a settlement, release, signal, acquisition or pool destruction. */
const CEILING_MS = 5_000;
/** One deadline-bounded observation (`awaitBlockedOnRival`, `awaitCondition`). */
const WAIT_BUDGET_MS = 5_000;
/** Seeding and other uncontended statements outside any bounded step. */
const SETUP_MARGIN_MS = 10_000;
/** The deliberately short first-attempt ceiling the self-checks inject. */
const INJECTED_CEILING_MS = 300;

/*
 * Per-helper worst cases. Every term is a bound the code enforces — a ceiling, a statement
 * timeout, an acquisition timeout or a deadline — never an expectation of how long work takes.
 *
 * - A deadline wait checks its deadline **before** each round trip, so its last iteration can
 *   begin just before the deadline and still run its queries in full: one statement for
 *   `awaitCondition`, two for `awaitBlockedOnRival` (the waiter, then its peers).
 * - Rival acquisition: the connection (ceiling, and the pool's own acquisition timeout), then
 *   the pid, `start transaction` and the lock, each server-bounded: C + 3S.
 * - Finishing a rival: its commit or rollback inside the body (S), and — if that fails or the
 *   body never finishes — release C + terminate C + settle C. Both can occur: S + 3C.
 * - Operation sessions after their body: settle, cancel, terminate, settle again, destroy,
 *   terminate, destroy again: 7C. With injected first attempts: 2 × injected + 5C.
 */
const CONDITION_WAIT_BOUND_MS = WAIT_BUDGET_MS + STATEMENT_TIMEOUT_MS;
const BLOCKED_WAIT_BOUND_MS = WAIT_BUDGET_MS + 2 * STATEMENT_TIMEOUT_MS;
const RIVAL_ACQUIRE_BOUND_MS = CEILING_MS + 3 * STATEMENT_TIMEOUT_MS;
const RIVAL_FINISH_BOUND_MS = STATEMENT_TIMEOUT_MS + 3 * CEILING_MS;
const SESSION_CLEANUP_BOUND_MS = 7 * CEILING_MS;
const INJECTED_SESSION_CLEANUP_BOUND_MS = 2 * INJECTED_CEILING_MS + 5 * CEILING_MS;

/**
 * Each concurrency and self-check test's worst bounded path, excluding the setup margin. The
 * comments name the nesting; uncontended seeding and row reads are in the margin.
 */
const WORST_CASE_PATHS_MS = {
  // sessions { rival { acquire; wait; finish }; completion C } then session cleanup
  "C-1":
    RIVAL_ACQUIRE_BOUND_MS + BLOCKED_WAIT_BOUND_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS +
    SESSION_CLEANUP_BOUND_MS,
  // as C-1, plus the rival's own state change (S) before the wait
  "C-2/C-3/C-4":
    RIVAL_ACQUIRE_BOUND_MS + STATEMENT_TIMEOUT_MS + BLOCKED_WAIT_BOUND_MS +
    RIVAL_FINISH_BOUND_MS + CEILING_MS + SESSION_CLEANUP_BOUND_MS,
  // two waits with peers
  "C-5":
    RIVAL_ACQUIRE_BOUND_MS + 2 * BLOCKED_WAIT_BOUND_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS +
    SESSION_CLEANUP_BOUND_MS,
  // rival { race C; checker stop C }; completion C; settle C, terminate C, settle C
  "C-8": RIVAL_ACQUIRE_BOUND_MS + 2 * CEILING_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS + 3 * CEILING_MS,
  // rival { sessions { wait; stuck wait } + injected cleanup; S check; completion C; wait;
  // finish }; stuck observer settles C
  "F-1":
    RIVAL_ACQUIRE_BOUND_MS + BLOCKED_WAIT_BOUND_MS + CONDITION_WAIT_BOUND_MS +
    INJECTED_SESSION_CLEANUP_BOUND_MS + STATEMENT_TIMEOUT_MS + CEILING_MS +
    CONDITION_WAIT_BOUND_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS,
  // sessions { S count } then injected cleanup; the gate's wait is inside the bounded destroy
  "F-2": STATEMENT_TIMEOUT_MS + INJECTED_SESSION_CLEANUP_BOUND_MS,
  // holder rival { acquire; wait } + injected release, terminate C, settle C; occupying
  // statement settles C; wait; holder shutdown C; wait
  "F-3":
    RIVAL_ACQUIRE_BOUND_MS + CONDITION_WAIT_BOUND_MS + INJECTED_CEILING_MS + 2 * CEILING_MS +
    CEILING_MS + CONDITION_WAIT_BOUND_MS + CEILING_MS + CONDITION_WAIT_BOUND_MS,
  // injected race; checker stop C; one observer statement
  "F-4": INJECTED_CEILING_MS + CEILING_MS + STATEMENT_TIMEOUT_MS,
  // occupy C; injected acquisition; wait; holder shutdown C
  "F-5": CEILING_MS + INJECTED_CEILING_MS + CONDITION_WAIT_BOUND_MS + CEILING_MS,
  // sessions { one uncontended statement } then full session cleanup; wait
  "F-6": SESSION_CLEANUP_BOUND_MS + CONDITION_WAIT_BOUND_MS,
} as const;

/** The largest worst-case path plus the setup margin. */
const CONCURRENCY_TEST_TIMEOUT_MS =
  SETUP_MARGIN_MS + Math.max(...Object.values(WORST_CASE_PATHS_MS));
/** Uncontended tests: a handful of statements, none of which can wait on a lock held by a test. */
const PLAIN_TEST_TIMEOUT_MS = 15_000;
/**
 * `afterEach`: two probe sweeps, each under a ceiling (and server-bounded by a local
 * `lock_timeout`/`statement_timeout`, so each transaction ends by itself), one server-bounded
 * count, one condition wait for owned backends to disappear, plus margin.
 */
const HOOK_TIMEOUT_MS = 2 * CEILING_MS + STATEMENT_TIMEOUT_MS + CONDITION_WAIT_BOUND_MS + 5_000;

const CEILING_SENTINEL = "a bounded test step exceeded its safety ceiling";
const LOCK_WAIT_SENTINEL = "the session under test never blocked as expected";

/* ------------------------------------------------------------------------------------------- */
/* Pools                                                                                          */
/* ------------------------------------------------------------------------------------------- */

interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface PgPool {
  readonly totalCount: number;
  connect(): Promise<PgClient>;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "connect", listener: (client: PgClient) => void): unknown;
}

interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => PgPool;
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

/** A test-owned pool: identified by a unique `application_name`, with every client listened. */
interface TestPool {
  readonly name: string;
  readonly pool: PgPool;
  readonly db: Kysely<ListingDatabase>;
  shutdown(): Promise<void>;
}

/**
 * Create a pool this suite owns.
 *
 * The configuration is the production one — the governed timestamp parser and startup options —
 * plus two things only a test harness needs. Every client gets an `error` listener, because a
 * test may terminate a backend whose connection is **checked out**, and `pg` then emits `error`
 * on that client with no listener attached by the pool or by Kysely. And observer, controller and
 * rival pools carry a server-side `statement_timeout`, so their own statements are bounded where
 * the work actually runs, and a `connectionTimeoutMillis`, so acquiring a connection is bounded
 * by the pool itself. Operation sessions carry neither: they run the operation under test.
 */
function createTestPool(options: {
  readonly name: string;
  readonly max: number;
  readonly statementTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly database?: string;
  readonly log?: (sql: string, parameters: readonly unknown[]) => void;
}): TestPool {
  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(options.database ?? VERIFIED_DATABASE),
    max: options.max,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: options.name }),
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { statement_timeout: options.statementTimeoutMs }),
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMs }),
  });

  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });

  const log = options.log;
  const db = new Kysely<ListingDatabase>({
    dialect: new PostgresDialect({ pool: pool as never }),
    ...(log === undefined
      ? {}
      : {
          log: (event) => {
            if (event.level === "query") {
              log(event.query.sql, event.query.parameters);
            }
          },
        }),
  });

  return { name: options.name, pool, db, shutdown: () => db.destroy() };
}

function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const RIVAL_APPLICATION_NAME = "listing_rejection_rival";
const OBSERVER_APPLICATION_NAME = "listing_rejection_observer";
const CONTROLLER_APPLICATION_NAME = "listing_rejection_controller";
const CAPTURE_APPLICATION_NAME = "listing_rejection_capture";
const OPERATION_PREFIX = "listing_rejection_op";
const HOLDER_PREFIX = "listing_rejection_holder";

let persistence: ListingPersistence;
let hostile: ListingPersistence;
let rival: TestPool;
let observer: TestPool;
let controller: TestPool;
let capturing: ReturnType<typeof createCapturingPersistence>;

/* ------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                       */
/* ------------------------------------------------------------------------------------------- */

const T0 = 1_767_323_045_123;
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;
const T3 = T0 + 3_000;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

const SUBMITTED_CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

const COMPLETE_CONTENT: ListingContent = {
  ...SUBMITTED_CONTENT,
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: "+353 21 123 4567", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: "https://example.ie", designatedPublic: false },
};

function pendingListing(content: ListingContent, at: number): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "pending",
    content,
    timestamps: { submittedAt: instant(at), lastUpdatedAt: instant(at) },
  };
}

function listingText(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

/** A pending listing with `submitted_at = last_updated_at = at` (default `T0`). */
async function seedPending(
  options: { content?: ListingContent; db?: Kysely<ListingDatabase>; at?: number } = {},
): Promise<Listing> {
  const listing = pendingListing(options.content ?? SUBMITTED_CONTENT, options.at ?? T0);

  expect((await insertSubmittedListing(options.db ?? persistence.db, listing)).ok).toBe(true);

  return listing;
}

/** Store-valid state changes, written directly — store states, not claims about any operation. */
async function makeApprovedPubliclyAvailable(
  listing: Listing,
  at: number,
  db: Kysely<ListingDatabase> = persistence.db,
) {
  await sql`
    update listing
       set status = 'approved', publication_state = 'publicly_available',
           last_updated_at = ${timestamptzFromEpochMilliseconds(at)}
     where id = ${listingText(listing)}::uuid
  `.execute(db);
}

async function makeApprovedUnpublished(listing: Listing, at: number, db = persistence.db) {
  await sql`
    update listing
       set status = 'approved', publication_state = 'unpublished',
           unpublish_reason = 'probe reason',
           last_updated_at = ${timestamptzFromEpochMilliseconds(at)}
     where id = ${listingText(listing)}::uuid
  `.execute(db);
}

async function makeRejected(
  listing: Listing,
  at: number,
  db: Kysely<ListingDatabase> = persistence.db,
) {
  await sql`
    update listing
       set status = 'rejected',
           rejected_at = ${timestamptzFromEpochMilliseconds(at)},
           last_updated_at = ${timestamptzFromEpochMilliseconds(at)}
     where id = ${listingText(listing)}::uuid
  `.execute(db);
}

type RejectionResult = Result<Listing, RejectPendingListingFailure>;

async function reject(
  listing: Listing,
  at: Instant,
  db: Kysely<ListingDatabase> = persistence.db,
): Promise<RejectionResult> {
  return await rejectPendingListing(db, { listingId: listing.id, rejectedAt: at });
}

function expectRefusal(result: RejectionResult): RejectPendingListingFailure {
  if (result.ok) {
    throw new Error("expected a refusal, got a listing");
  }

  return result.error;
}

function expectListing(result: RejectionResult): Listing {
  if (!result.ok) {
    throw new Error(`expected a listing, got ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

const supply = <T>(value: T) => ({ kind: "supply", value }) as const;

async function edit(
  listing: Listing,
  administrativeEdit: AdministrativeEdit,
  base: number,
  at: number,
) {
  return await applyAdministrativeEditToPendingListing(persistence.db, {
    listingId: listing.id,
    baseListingLastUpdatedAt: instant(base),
    edit: administrativeEdit,
    at: instant(at),
  });
}

async function storedRow(listing: Listing, db = persistence.db) {
  const rows = await sql<{
    id: string;
    status: string;
    name: string;
    category: string;
    description: string;
    locality: string;
    country: string;
    administrative_area: string | null;
    postal_code: string | null;
    postal_code_designated_public: boolean;
    phone: string | null;
    phone_designated_public: boolean;
    email: string | null;
    email_designated_public: boolean;
    website: string | null;
    website_designated_public: boolean;
    publication_state: string | null;
    unpublish_reason: string | null;
    submitted_at: number;
    last_updated_at: number;
    rejected_at: number | null;
  }>`select * from listing where id = ${listingText(listing)}::uuid`.execute(db);

  const row = rows.rows[0];

  if (row === undefined) {
    throw new Error("the seeded listing is missing");
  }

  return row;
}

async function sessionsInTransaction(): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from pg_stat_activity
     where datname = current_database()
       and state in ('idle in transaction', 'idle in transaction (aborted)')
  `.execute(observer.db);

  return rows.rows[0]?.count ?? 0;
}

/* ------------------------------------------------------------------------------------------- */
/* Statement capture                                                                              */
/* ------------------------------------------------------------------------------------------- */

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A `C9` boundary with the production configuration, on **one** connection, with every executed
 * statement captured — including `start transaction …` and `commit`, which Kysely logs through
 * the same hook. One connection means a split into two transactions would be visible as two.
 */
function createCapturingPersistence(database: string): {
  readonly db: Kysely<ListingDatabase>;
  readonly statements: readonly CapturedStatement[];
  reset(): void;
  shutdown(): Promise<void>;
} {
  const statements: CapturedStatement[] = [];
  const pool = createTestPool({
    name: CAPTURE_APPLICATION_NAME,
    max: 1,
    database,
    log: (text, parameters) => {
      statements.push({ sql: text, parameters });
    },
  });

  return {
    db: pool.db,
    statements,
    reset: () => {
      statements.length = 0;
    },
    shutdown: () => pool.shutdown(),
  };
}

const isTransactionStart = (s: CapturedStatement): boolean =>
  /^\s*(start transaction|begin)\b/i.test(s.sql);
const isCommit = (s: CapturedStatement): boolean => /^\s*commit\b/i.test(s.sql);
const isListingLock = (s: CapturedStatement): boolean =>
  /^\s*select\b[\s\S]*\bfrom\s+"?listing"?(\s|$)[\s\S]*\bfor update\b/i.test(s.sql);
const isStateRead = (s: CapturedStatement): boolean => /^\s*(select|update|insert|delete)\b/i.test(s.sql);
const isListingUpdate = (s: CapturedStatement): boolean =>
  /^\s*update\s+"?listing"?\s+set\b/i.test(s.sql);

interface UpdateShape {
  readonly setColumns: readonly string[];
  readonly setStatusValue: unknown;
  readonly whereIdValue: unknown;
  readonly whereStatusValue: unknown;
}

/** The `SET` columns and the bound values of the `WHERE` identity and status predicates. */
function updateShapeOf(statement: CapturedStatement): UpdateShape {
  const whereAt = statement.sql.search(/\swhere\s/i);
  const setClause = whereAt === -1 ? statement.sql : statement.sql.slice(0, whereAt);
  const whereClause = whereAt === -1 ? "" : statement.sql.slice(whereAt);

  const afterSet = setClause.replace(/^[\s\S]*?\bset\b/i, "");
  const setColumns = [...afterSet.matchAll(/"?([a-z_]+)"?\s*=/gi)].map((m) => m[1] as string);

  const parameter = (clause: string, column: string): unknown => {
    const match = new RegExp(`\\b"?${column}"?\\s*=\\s*\\$(\\d+)`, "i").exec(clause);

    return match === null ? undefined : statement.parameters[Number(match[1]) - 1];
  };

  return {
    setColumns,
    setStatusValue: parameter(afterSet, "status"),
    whereIdValue: parameter(whereClause, "id"),
    whereStatusValue: parameter(whereClause, "status"),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Bounds, signals and error collection                                                           */
/* ------------------------------------------------------------------------------------------- */

/** Race `work` against a ceiling. The ceiling does **not** cancel `work`; callers clean up. */
async function withinCeiling<T>(work: Promise<T>, label: string, ms = CEILING_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ceiling = new Promise<never>((_, rejectCeiling) => {
    timer = setTimeout(() => rejectCeiling(new Error(`${CEILING_SENTINEL}: ${label}`)), ms);
  });

  try {
    return await Promise.race([work, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

/** Settles when `work` settles, whichever way, so a later rejection is never unhandled. */
function settled(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined,
  );
}

/** Throw nothing, the only error, or all of them — the first is always the original failure. */
function throwCollected(errors: readonly unknown[]): void {
  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, "the first error is the original failure");
  }
}

/**
 * Cancel or terminate the backends of exactly the named sessions, through the **controller**.
 *
 * `includeIdle` widens termination to idle connections, for a pool whose shutdown overran.
 */
async function signalBackends(
  signal: "pg_cancel_backend" | "pg_terminate_backend",
  names: readonly string[],
  includeIdle = false,
): Promise<void> {
  await sql`
    select ${sql.raw(signal)}(pid)
      from pg_stat_activity
     where application_name = any(${names as string[]})
       and pid <> pg_backend_pid()
       and (${includeIdle} or state <> 'idle')
  `.execute(controller.db);
}

async function terminateBackend(pid: number): Promise<void> {
  await sql`select pg_terminate_backend(${pid})`.execute(controller.db);
}

/** How many backends the named sessions still hold, read through the controller. */
async function backendCount(names: readonly string[]): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count from pg_stat_activity
     where application_name = any(${names as string[]})
  `.execute(controller.db);

  return rows.rows[0]?.count ?? 0;
}

async function ownedBackendsRemaining(): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count from pg_stat_activity
     where application_name like ${`${OPERATION_PREFIX}%`}
        or application_name like ${`${HOLDER_PREFIX}%`}
  `.execute(controller.db);

  return rows.rows[0]?.count ?? 0;
}

/* ------------------------------------------------------------------------------------------- */
/* Operation sessions                                                                             */
/* ------------------------------------------------------------------------------------------- */

type Track = <T>(work: Promise<T>) => Promise<T>;
type Session = (label: string) => TestPool;

/**
 * Run `body` with one uniquely named, single-connection session per label, and **always** settle
 * and destroy them within bounds.
 *
 * Settlement is bounded; on an overrun the sessions' active backends are cancelled and then, if
 * still active, terminated — each bounded — and settlement is bounded again. Destruction is
 * bounded and always attempted — even when `beforeShutdown` fails; on an overrun **every** backend
 * of the sessions, idle ones included, is terminated and the same destruction is awaited again.
 * The body's failure is primary; cleanup failures follow, none of them swallowed.
 *
 * `ceilingMs` and `beforeShutdown` exist only for the harness self-checks below.
 */
async function withOperationSessions(
  labels: readonly string[],
  body: (session: Session, track: Track) => Promise<void>,
  options: {
    readonly ceilingMs?: number;
    readonly beforeShutdown?: (name: string) => Promise<void>;
  } = {},
): Promise<void> {
  const sessions = new Map<string, TestPool>(
    labels.map((label) => [label, createTestPool({ name: uniqueName(`${OPERATION_PREFIX}_${label}`), max: 1 })]),
  );
  const names = [...sessions.values()].map((pool) => pool.name);
  const firstAttemptMs = options.ceilingMs ?? CEILING_MS;
  const tracked: Promise<unknown>[] = [];
  const track: Track = (work) => {
    tracked.push(work);

    return work;
  };
  const session: Session = (label) => {
    const pool = sessions.get(label);

    if (pool === undefined) {
      throw new Error(`no operation session labelled ${label}`);
    }

    return pool;
  };
  const errors: unknown[] = [];

  try {
    await body(session, track);
  } catch (error) {
    errors.push(error);
  }

  const settling = Promise.allSettled(tracked);

  try {
    await withinCeiling(settling, "started operations settle", firstAttemptMs);
  } catch (overrun) {
    errors.push(overrun);

    for (const signal of ["pg_cancel_backend", "pg_terminate_backend"] as const) {
      try {
        await withinCeiling(signalBackends(signal, names), `${signal} of operation sessions`);
      } catch (signalError) {
        errors.push(signalError);
      }
    }

    try {
      await withinCeiling(settling, "operations settle after termination");
    } catch (secondOverrun) {
      errors.push(secondOverrun);
    }
  }

  // Shutdown is attempted even if the callback fails; both failures are kept, in that order.
  const destroying = Promise.allSettled(
    [...sessions.values()].map(async (pool) => {
      const failures: unknown[] = [];

      try {
        await options.beforeShutdown?.(pool.name);
      } catch (callbackError) {
        failures.push(callbackError);
      }

      try {
        await pool.shutdown();
      } catch (shutdownError) {
        failures.push(shutdownError);
      }

      throwCollected(failures);
    }),
  );
  let destroyed: PromiseSettledResult<void>[] | undefined;

  try {
    destroyed = await withinCeiling(destroying, "operation pools destroyed", firstAttemptMs);
  } catch (overrun) {
    errors.push(overrun);

    try {
      await withinCeiling(
        signalBackends("pg_terminate_backend", names, true),
        "operation session backends terminated",
      );
    } catch (signalError) {
      errors.push(signalError);
    }

    try {
      destroyed = await withinCeiling(destroying, "operation pools destroyed after termination");
    } catch (secondOverrun) {
      errors.push(secondOverrun);
    }
  }

  for (const outcome of destroyed ?? []) {
    if (outcome.status === "rejected") {
      errors.push(outcome.reason);
    }
  }

  throwCollected(errors);
}

/* ------------------------------------------------------------------------------------------- */
/* The rival lock                                                                                 */
/* ------------------------------------------------------------------------------------------- */

interface RivalTransaction {
  /** A Kysely view of the rival's own connection, inside its transaction. */
  readonly db: Kysely<ListingDatabase>;
  readonly pid: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** A Kysely instance whose every statement runs on `client`, which this suite releases itself. */
function kyselyOver(client: PgClient): Kysely<ListingDatabase> {
  const borrowed = {
    connect: async () => ({ query: client.query.bind(client), release: () => undefined }),
    end: async () => undefined,
  };

  return new Kysely<ListingDatabase>({ dialect: new PostgresDialect({ pool: borrowed as never }) });
}

/**
 * Hold the listing lock for the duration of `body` on a raw, test-owned connection, and
 * **always** release it within bounds.
 *
 * A raw client rather than a Kysely controlled transaction, because a controlled transaction
 * whose rollback fails never returns its connection to the pool, which would then never shut
 * down. Acquisition is bounded, and a connection that arrives after its deadline is discarded.
 * The pid is read before any transaction or lock exists. The release is bounded; on an overrun
 * the rival's own backend — identified by that pid — is terminated, the release is awaited
 * again, and the client is released with an error so the pool discards it. The body's failure
 * is primary.
 */
async function withRivalLock(
  listing: Listing,
  body: (rivalTransaction: RivalTransaction) => Promise<void>,
  options: {
    readonly holder?: TestPool;
    readonly ceilingMs?: number;
    readonly acquireCeilingMs?: number;
  } = {},
): Promise<void> {
  const holder = options.holder ?? rival;
  const connecting = holder.pool.connect();
  let client: PgClient;

  try {
    client = await withinCeiling(
      connecting,
      "rival connection acquired",
      options.acquireCeilingMs ?? CEILING_MS,
    );
  } catch (overrun) {
    // The acquisition keeps going after its deadline. A client that arrives later is discarded
    // the moment it does, and a later failure is absorbed; the pool's own acquisition timeout
    // bounds how long that can take.
    void connecting.then(
      (late) => late.release(new Error("arrived after the rival acquisition deadline")),
      () => undefined,
    );

    throw overrun;
  }

  const errors: unknown[] = [];
  let finished = false;
  let broken = false;
  let pid: number | undefined;

  try {
    // The pid first, before any transaction or lock exists: from here on, everything this
    // connection holds can be terminated precisely.
    pid = Number((await client.query("select pg_backend_pid() as pid")).rows[0]?.pid);
    await client.query("start transaction isolation level read committed");
    await client.query("select id from listing where id = $1::uuid for update", [listingText(listing)]);

    await body({
      db: kyselyOver(client),
      pid,
      commit: async () => {
        await client.query("commit");
        finished = true;
      },
      rollback: async () => {
        await client.query("rollback");
        finished = true;
      },
    });
  } catch (error) {
    errors.push(error);
  }

  if (!finished) {
    const releasing = client.query("rollback");

    try {
      await withinCeiling(releasing, "rival lock released", options.ceilingMs ?? CEILING_MS);
    } catch (overrun) {
      errors.push(overrun);
      broken = true;

      if (pid !== undefined) {
        try {
          await withinCeiling(terminateBackend(pid), "rival backend terminated");
        } catch (signalError) {
          errors.push(signalError);
        }
      }

      try {
        await withinCeiling(settled(releasing), "rival release settles after termination");
      } catch (secondOverrun) {
        errors.push(secondOverrun);
      }
    }
  }

  client.release(broken ? new Error("the rival connection was terminated by the harness") : undefined);

  throwCollected(errors);
}

/**
 * Wait until the named session is blocked on a lock whose blocking chain reaches the rival —
 * **directly**, or **indirectly** through one of the named peer sessions. Deadline-bounded.
 */
async function awaitBlockedOnRival(
  name: string,
  rivalPid: number,
  peers: readonly string[] = [],
): Promise<"direct" | "indirect"> {
  const deadline = Date.now() + WAIT_BUDGET_MS;

  while (Date.now() < deadline) {
    const waiting = await sql<{ pid: number; blockers: number[] }>`
      select pid, pg_blocking_pids(pid) as blockers
        from pg_stat_activity
       where application_name = ${name} and wait_event_type = 'Lock'
         and datname = current_database()
    `.execute(observer.db);

    for (const row of waiting.rows) {
      if (row.blockers.includes(rivalPid)) {
        return "direct";
      }

      if (peers.length > 0) {
        const peerRows = await sql<{ pid: number; blockers: number[] }>`
          select pid, pg_blocking_pids(pid) as blockers
            from pg_stat_activity
           where application_name = any(${peers as string[]})
             and datname = current_database()
        `.execute(observer.db);

        const indirect = peerRows.rows.some(
          (peer) => row.blockers.includes(peer.pid) && peer.blockers.includes(rivalPid),
        );

        if (indirect) {
          return "indirect";
        }
      }
    }
  }

  throw new Error(`${LOCK_WAIT_SENTINEL}: ${name}`);
}

/**
 * Race `running` against a checker that reports the named session waiting on a lock, and
 * **always** stop and await the checker — even when the race itself fails.
 */
async function raceAgainstLockWait(
  running: Promise<unknown>,
  name: string,
  probe: { checkerQueries: number; checkerSettled: boolean },
  ceilingMs = CEILING_MS,
): Promise<"returned" | "waited" | "never"> {
  let stop = false;
  const checker = (async () => {
    const deadline = Date.now() + WAIT_BUDGET_MS;

    while (!stop && Date.now() < deadline) {
      probe.checkerQueries += 1;

      const waiting = await sql<{ count: number }>`
        select count(*)::int as count from pg_stat_activity
         where application_name = ${name} and wait_event_type = 'Lock'
      `.execute(observer.db);

      if ((waiting.rows[0]?.count ?? 0) > 0) {
        return "waited" as const;
      }
    }

    return "never" as const;
  })();
  const checkerDone = checker.then(
    () => {
      probe.checkerSettled = true;
    },
    () => {
      probe.checkerSettled = true;
    },
  );
  const errors: unknown[] = [];
  let first: "returned" | "waited" | "never" | undefined;

  try {
    first = await withinCeiling(
      Promise.race([running.then(() => "returned" as const), checker]),
      "C-8 first outcome",
      ceilingMs,
    );
  } catch (error) {
    errors.push(error);
  } finally {
    stop = true;

    try {
      await withinCeiling(checkerDone, "C-8 checker stops");
    } catch (stopError) {
      errors.push(stopError);
    }
  }

  throwCollected(errors);

  return first as "returned" | "waited" | "never";
}

/* ------------------------------------------------------------------------------------------- */
/* Test-only fixtures inside the disposable databases                                             */
/* ------------------------------------------------------------------------------------------- */

const PROBE_PREFIX = "listing_rejection_probe_";
const CLEANUP_LOCK_TIMEOUT = "5s";

/** Remove every probe trigger, function and sequence, inside one server-bounded transaction. */
async function dropProbeObjects(db: Kysely<ListingDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql.raw(`set local lock_timeout = '${CLEANUP_LOCK_TIMEOUT}'`).execute(trx);
    await sql.raw(`set local statement_timeout = '${CLEANUP_LOCK_TIMEOUT}'`).execute(trx);

    const triggers = await sql<{ tgname: string; relname: string }>`
      select t.tgname, c.relname
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and t.tgname like ${`${PROBE_PREFIX}%`}
    `.execute(trx);

    for (const trigger of triggers.rows) {
      await sql.raw(`drop trigger if exists "${trigger.tgname}" on "${trigger.relname}"`).execute(trx);
    }

    const functions = await sql<{ proname: string }>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like ${`${PROBE_PREFIX}%`}
    `.execute(trx);

    for (const routine of functions.rows) {
      await sql.raw(`drop function if exists "${routine.proname}"()`).execute(trx);
    }

    const sequences = await sql<{ relname: string }>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'S' and c.relname like ${`${PROBE_PREFIX}%`}
    `.execute(trx);

    for (const sequence of sequences.rows) {
      await sql.raw(`drop sequence if exists "${sequence.relname}"`).execute(trx);
    }
  });
}

async function createProbeTrigger(
  name: string,
  timing: "before" | "after",
  functionBody: string,
  db: Kysely<ListingDatabase> = persistence.db,
): Promise<void> {
  await sql.raw(`
    create or replace function ${PROBE_PREFIX}${name}_fn() returns trigger as $$
    ${functionBody}
    $$ language plpgsql
  `).execute(db);
  await sql.raw(`
    create trigger "${PROBE_PREFIX}${name}" ${timing} update on "listing"
    for each row execute function ${PROBE_PREFIX}${name}_fn()
  `).execute(db);
}

/* ------------------------------------------------------------------------------------------- */
/* Lifecycle                                                                                      */
/* ------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
  });
  hostile = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(HOSTILE_DATABASE), max: 2 },
  });
  rival = createTestPool({
    name: RIVAL_APPLICATION_NAME,
    max: 2,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: CEILING_MS,
  });
  observer = createTestPool({
    name: OBSERVER_APPLICATION_NAME,
    max: 1,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: CEILING_MS,
  });
  controller = createTestPool({
    name: CONTROLLER_APPLICATION_NAME,
    max: 2,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: CEILING_MS,
  });
  capturing = createCapturingPersistence(VERIFIED_DATABASE);

  cluster.closeBeforeShutdown("capturing persistence", () => capturing.shutdown());
  cluster.closeBeforeShutdown("verified persistence", () => persistence.shutdown());
  cluster.closeBeforeShutdown("hostile persistence", () => hostile.shutdown());
  cluster.closeBeforeShutdown("rival pool", () => rival.shutdown());
  cluster.closeBeforeShutdown("observer pool", () => observer.shutdown());
  cluster.closeBeforeShutdown("controller pool", () => controller.shutdown());
}, CLUSTER_TIMEOUT_MS);

afterEach(async () => {
  await withinCeiling(dropProbeObjects(persistence.db), "verified probe sweep");
  await withinCeiling(dropProbeObjects(hostile.db), "hostile probe sweep");
  capturing.reset();

  expect(await sessionsInTransaction()).toBe(0);

  // A backend's row can outlive its closed socket briefly, so wait — bounded — for zero.
  await awaitCondition(async () => (await ownedBackendsRemaining()) === 0, "owned backends gone");
}, HOOK_TIMEOUT_MS);

/* ------------------------------------------------------------------------------------------- */
/* AC-11 — compile-time guards                                                                    */
/* ------------------------------------------------------------------------------------------- */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type Operation = typeof rejectPendingListing;
type Request = Parameters<Operation>[1];

type _RequestSurface = Assert<Equals<keyof Request, "listingId" | "rejectedAt">>;
type _NoToken = Assert<
  Equals<Extract<keyof Request, "baseListingLastUpdatedAt" | "token" | "version">, never>
>;
type _NoActor = Assert<Equals<Extract<keyof Request, "role" | "actor" | "override" | "note">, never>>;
type _NoRetry = Assert<Equals<Extract<keyof Request, "retries" | "attempts" | "trx" | "now">, never>>;
type _Arity = Assert<Equals<Parameters<Operation>["length"], 2>>;
type _Success = Assert<Equals<Awaited<ReturnType<Operation>>, RejectionResult>>;
type _NoDateIn = Assert<Equals<Extract<Request[keyof Request], Date>, never>>;
type _NoExhaustedRetry = Assert<
  Equals<Extract<RejectPendingListingFailure, { code: "EXHAUSTED_RETRY" }>, never>
>;
type _NoStaleCode = Assert<
  Equals<Extract<RejectPendingListingFailure, { code: "STALE_LISTING_VERSION" }>, never>
>;
type _NotLaterIsBare = Assert<
  Equals<
    Extract<RejectPendingListingFailure, { code: "REJECTION_INSTANT_NOT_LATER" }>,
    { readonly code: "REJECTION_INSTANT_NOT_LATER" }
  >
>;
type _NotPendingCarriesStatus = Assert<
  Equals<
    Extract<RejectPendingListingFailure, { code: "LISTING_NOT_PENDING" }>,
    { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  >
>;

describe("the compile-time contract (AC-11)", () => {
  it(
    "is checked by the type assertions above",
    () => {
      const guards: [
        _RequestSurface,
        _NoToken,
        _NoActor,
        _NoRetry,
        _Arity,
        _Success,
        _NoDateIn,
        _NoExhaustedRetry,
        _NoStaleCode,
        _NotLaterIsBare,
        _NotPendingCarriesStatus,
      ] = [true, true, true, true, true, true, true, true, true, true, true];

      expect(guards.every(Boolean)).toBe(true);
    },
    PLAIN_TEST_TIMEOUT_MS,
  );
});

/* ------------------------------------------------------------------------------------------- */
/* Behaviour                                                                                      */
/* ------------------------------------------------------------------------------------------- */

describe("rejecting a pending listing (FR-ADM-07, FR-AUD-01/03/06, BI-8, DI-1, DI-2, DI-6, DI-8)", () => {
  it("AC-1 — rejects it, returns the stored aggregate, and leaves every other listing untouched", async () => {
    const target = await seedPending({ content: COMPLETE_CONTENT });
    const other = await seedPending();
    const targetBefore = await storedRow(target);
    const otherBefore = await storedRow(other);

    const rejected = expectListing(await reject(target, instant(T2)));

    expect(rejected.status).toBe("rejected");
    expect(rejected.timestamps.rejectedAt).toEqual(instant(T2));
    expect(rejected.timestamps.lastUpdatedAt).toEqual(instant(T2));

    const found = await findListingById(persistence.db, target.id);

    expect(found.ok && found.value).toEqual(rejected);

    const after = await storedRow(target);

    expect(after).toEqual({
      ...targetBefore,
      status: "rejected",
      rejected_at: T2,
      last_updated_at: T2,
    });
    expect(after.publication_state).toBeNull();
    expect(after.submitted_at).toBe(T0);
    expect(await storedRow(other)).toEqual(otherBefore);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-2 — refuses every non-pending source as LISTING_NOT_PENDING, status before time (NFR-DATA-02)", async () => {
    const approvedPublic = await seedPending();
    const approvedUnpublished = await seedPending();
    const rejected = await seedPending();

    await makeApprovedPubliclyAvailable(approvedPublic, T1);
    await makeApprovedUnpublished(approvedUnpublished, T1);
    await makeRejected(rejected, T1);

    for (const [listing, status] of [
      [approvedPublic, "approved"],
      [approvedUnpublished, "approved"],
      [rejected, "rejected"],
    ] as const) {
      const before = await storedRow(listing);

      // A non-advancing usable instant (equal, then earlier) and an advancing one: status wins.
      for (const at of [T1, T0, T3]) {
        expect(expectRefusal(await reject(listing, instant(at)))).toEqual({
          code: "LISTING_NOT_PENDING",
          status,
        });
      }

      expect(await storedRow(listing)).toEqual(before);
    }
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-3 — reports an absent identifier as LISTING_NOT_FOUND and creates nothing", async () => {
    const absent = pendingListing(SUBMITTED_CONTENT, T0);

    expect(expectRefusal(await reject(absent, instant(T2)))).toEqual({ code: "LISTING_NOT_FOUND" });

    const count = await sql<{ count: number }>`
      select count(*)::int as count from listing where id = ${listingText(absent)}::uuid
    `.execute(persistence.db);

    expect(count.rows[0]?.count).toBe(0);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-4 — refuses a usable instant that does not advance last_updated_at (DI-6, NFR-DATA-05)", async () => {
    const listing = await seedPending();
    const before = await storedRow(listing);

    for (const at of [T0, T0 - 1]) {
      expect(expectRefusal(await reject(listing, instant(at)))).toEqual({
        code: "REJECTION_INSTANT_NOT_LATER",
      });
    }

    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-4 — round-trips a pre-epoch rejection instant exactly", async () => {
    const preEpoch = -86_400_000 * 400 - 123;
    const listing = await seedPending({ at: preEpoch });

    expectListing(await reject(listing, instant(preEpoch + 1)));

    const after = await storedRow(listing);

    expect(after.rejected_at).toBe(preEpoch + 1);
    expect(after.last_updated_at).toBe(preEpoch + 1);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-5 — refuses an unusable instant before any transaction, with zero statements sent", async () => {
    const listing = await seedPending();

    for (const unusable of [null, { epochMilliseconds: Number.NaN }, { epochMilliseconds: 1.5 }]) {
      capturing.reset();

      expect(
        expectRefusal(await reject(listing, unusable as unknown as Instant, capturing.db)),
      ).toEqual({ code: "INVALID_REJECTION_INSTANT" });
      expect(capturing.statements).toEqual([]);
    }
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-7 — the store refuses a rejected status without its anchor, and the reverse (PS-9)", async () => {
    const listing = await seedPending();
    const refusals: { code?: string; constraint?: string }[] = [];

    for (const statement of [
      sql`update listing set status = 'rejected' where id = ${listingText(listing)}::uuid`,
      sql`update listing set rejected_at = ${timestamptzFromEpochMilliseconds(T2)}
           where id = ${listingText(listing)}::uuid`,
    ]) {
      refusals.push(
        await statement.execute(persistence.db).then(
          () => ({}),
          (error: { code?: string; constraint?: string }) => ({
            code: error.code,
            constraint: error.constraint,
          }),
        ),
      );
    }

    expect(refusals).toEqual([
      { code: "23514", constraint: "listing_rejected_at_check" },
      { code: "23514", constraint: "listing_rejected_at_check" },
    ]);
  }, PLAIN_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* AC-8 — the statements PostgreSQL actually received (footprint, not behaviour)                  */
/* ------------------------------------------------------------------------------------------- */

describe("the transaction footprint (AC-8, ADR-026)", () => {
  it("one READ COMMITTED transaction: lock first, one guarded UPDATE, then commit", async () => {
    const listing = await seedPending();

    capturing.reset();
    expectListing(await reject(listing, instant(T2), capturing.db));

    const statements = capturing.statements;
    const starts = statements.flatMap((s, index) => (isTransactionStart(s) ? [index] : []));
    const commits = statements.flatMap((s, index) => (isCommit(s) ? [index] : []));
    const updates = statements.flatMap((s, index) => (isListingUpdate(s) ? [index] : []));
    const firstStateRead = statements.findIndex(isStateRead);

    expect(starts).toHaveLength(1);
    expect(statements[starts[0] as number]?.sql).toMatch(/isolation level read committed/i);
    expect(isListingLock(statements[firstStateRead] as CapturedStatement)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(commits).toHaveLength(1);

    const [start, lock, update, commit] = [
      starts[0] as number,
      firstStateRead,
      updates[0] as number,
      commits[0] as number,
    ];

    expect(start < lock && lock < update && update < commit).toBe(true);

    // No transaction boundary between the lock and the write.
    const between = statements.slice(lock + 1, update);

    expect(between.some((s) => isCommit(s) || isTransactionStart(s))).toBe(false);

    const shape = updateShapeOf(statements[update] as CapturedStatement);

    expect([...shape.setColumns].sort()).toEqual(["last_updated_at", "rejected_at", "status"]);
    expect(shape.setStatusValue).toBe("rejected");
    expect(shape.whereIdValue).toBe(listingText(listing));
    expect(shape.whereStatusValue).toBe("pending");

    expect(statements.some((s) => /listing_revision/i.test(s.sql))).toBe(false);
    expect(statements.filter((s) => /^\s*(update|insert|delete)\b/i.test(s.sql))).toHaveLength(1);
  }, PLAIN_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* AC-6, AC-9, AC-12, AC-13 — faults injected through test-only fixtures                          */
/* ------------------------------------------------------------------------------------------- */

describe("faults at the first and only UPDATE statement (AC-6, NFR-DATA-03, DI-3, BI-7)", () => {
  it("AC-6 — a BEFORE UPDATE trigger failure fails the only writing statement and leaves no partial state", async () => {
    const listing = await seedPending();

    await createProbeTrigger(
      "before_raise",
      "before",
      "begin raise exception 'probe' using errcode = '23514', constraint = 'probe_check'; end;",
    );

    const before = await storedRow(listing);
    const failure = expectRefusal(await reject(listing, instant(T2)));

    expect(failure).toEqual({
      code: "INTEGRITY_CONFLICT",
      sqlState: "23514",
      constraint: "probe_check",
    });
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-6/AC-12 — an AFTER UPDATE trigger failure fails the same statement; the failure exposes no row values", async () => {
    const listing = await seedPending();

    await createProbeTrigger(
      "after_raise",
      "after",
      "begin raise exception 'probe' using detail = 'row carries ' || new.name; end;",
    );

    const before = await storedRow(listing);
    const failure = expectRefusal(await reject(listing, instant(T2)));

    expect(failure.code).toBe("STORAGE_FAILURE");
    expect(failure).toMatchObject({ sqlState: "P0001" });
    expect(JSON.stringify(failure)).not.toContain(SUBMITTED_CONTENT.name);
    expect(JSON.stringify({ ...failure })).not.toContain(SUBMITTED_CONTENT.name);
    expect(Object.keys(failure)).not.toContain("cause");
    expect(Object.getOwnPropertyDescriptor(failure, "cause")?.enumerable).toBe(false);
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-9 — reports a zero-row guarded UPDATE as GUARDED_UPDATE_PROTOCOL_FAILURE, writing nothing", async () => {
    const listing = await seedPending();

    await createProbeTrigger("suppress", "before", "begin return null; end;");

    const before = await storedRow(listing);

    expect(expectRefusal(await reject(listing, instant(T2))).code).toBe(
      "GUARDED_UPDATE_PROTOCOL_FAILURE",
    );
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-9 — reports an unreadable stored listing as STORED_LISTING_UNREADABLE, never not-found", async () => {
    const listing = await seedPending({ db: hostile.db });

    try {
      await sql`alter table listing drop constraint if exists listing_status_check`.execute(hostile.db);
      await sql`update listing set status = 'nonsense' where id = ${listingText(listing)}::uuid`.execute(
        hostile.db,
      );

      expect(expectRefusal(await reject(listing, instant(T2), hostile.db)).code).toBe(
        "STORED_LISTING_UNREADABLE",
      );
    } finally {
      await sql`update listing set status = 'pending' where id = ${listingText(listing)}::uuid`.execute(
        hostile.db,
      );
    }
  }, PLAIN_TEST_TIMEOUT_MS);

  it("AC-13 — classifies a 40001 and never retries it (ADR-026 item 3)", async () => {
    const listing = await seedPending();
    const sequence = `${PROBE_PREFIX}retry_seq`;

    // `nextval` is not rolled back with the aborted transaction, so the fault fires once only:
    // a retry would succeed, and the sequence would advance twice.
    await sql.raw(`create sequence "${sequence}"`).execute(persistence.db);
    await createProbeTrigger(
      "retry_once",
      "before",
      `begin
         if nextval('"${sequence}"') = 1 then
           raise exception 'probe' using errcode = '40001';
         end if;
         return new;
       end;`,
    );

    const before = await storedRow(listing);

    expect(expectRefusal(await reject(listing, instant(T2)))).toEqual({
      code: "RETRYABLE_CONFLICT",
      sqlState: "40001",
    });
    expect(await storedRow(listing)).toEqual(before);

    const advanced = await sql<{ last_value: string; is_called: boolean }>`
      select last_value::text as last_value, is_called from ${sql.table(sequence)}
    `.execute(persistence.db);

    expect(advanced.rows[0]).toEqual({ last_value: "1", is_called: true });
  }, PLAIN_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* Concurrency — C-1 to C-8 (AC-10)                                                               */
/* ------------------------------------------------------------------------------------------- */

describe("contention on the listing row (AC-10, ADR-026)", () => {
  it("C-1 — blocks behind a lock holder, then rejects", async () => {
    await withOperationSessions(["a"], async (session, track) => {
      const operation = session("a");
      const listing = await seedPending();
      const before = await storedRow(listing);
      let running: Promise<RejectionResult> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        running = track(reject(listing, instant(T2), operation.db));

        expect(await awaitBlockedOnRival(operation.name, rivalTransaction.pid)).toBe("direct");
        expect(await storedRow(listing)).toEqual(before);

        await rivalTransaction.rollback();
      });

      expectListing(await withinCeiling(running as Promise<RejectionResult>, "C-1 completes"));

      const after = await storedRow(listing);

      expect(after).toMatchObject({ status: "rejected", rejected_at: T2, last_updated_at: T2 });
      expect(after.name).toBe(before.name);
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-2 — a change committed while it waits does not refuse it: no viewed-version token", async () => {
    await withOperationSessions(["a"], async (session, track) => {
      const operation = session("a");
      const listing = await seedPending();
      let running: Promise<RejectionResult> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        await sql`
          update listing set name = 'X', last_updated_at = ${timestamptzFromEpochMilliseconds(T1)}
           where id = ${listingText(listing)}::uuid
        `.execute(rivalTransaction.db);

        running = track(reject(listing, instant(T2), operation.db));

        await awaitBlockedOnRival(operation.name, rivalTransaction.pid);
        await rivalTransaction.commit();
      });

      const rejected = expectListing(
        await withinCeiling(running as Promise<RejectionResult>, "C-2 completes"),
      );

      expect(rejected.content.name).toBe("X");
      expect(await storedRow(listing)).toMatchObject({
        name: "X",
        status: "rejected",
        rejected_at: T2,
        last_updated_at: T2,
      });
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  for (const [label, committed] of [
    ["equal", T2],
    ["later", T3],
  ] as const) {
    it(`C-3 — a committed ${label} last_updated_at is timestamp advancement, not staleness`, async () => {
      await withOperationSessions(["a"], async (session, track) => {
        const operation = session("a");
        const listing = await seedPending();
        let running: Promise<RejectionResult> | undefined;

        await withRivalLock(listing, async (rivalTransaction) => {
          await sql`
            update listing set last_updated_at = ${timestamptzFromEpochMilliseconds(committed)}
             where id = ${listingText(listing)}::uuid
          `.execute(rivalTransaction.db);

          running = track(reject(listing, instant(T2), operation.db));

          await awaitBlockedOnRival(operation.name, rivalTransaction.pid);
          await rivalTransaction.commit();
        });

        expect(
          expectRefusal(await withinCeiling(running as Promise<RejectionResult>, "C-3 completes")),
        ).toEqual({ code: "REJECTION_INSTANT_NOT_LATER" });
        expect(await storedRow(listing)).toMatchObject({
          status: "pending",
          rejected_at: null,
          last_updated_at: committed,
        });
      });
    }, CONCURRENCY_TEST_TIMEOUT_MS);
  }

  for (const [label, commitState, status] of [
    ["approval", makeApprovedPubliclyAvailable, "approved"],
    ["rejection", makeRejected, "rejected"],
  ] as const) {
    it(`C-4 — a committed ${label} is reported as LISTING_NOT_PENDING, before the non-advancing instant`, async () => {
      await withOperationSessions(["a"], async (session, track) => {
        const operation = session("a");
        const listing = await seedPending();
        let running: Promise<RejectionResult> | undefined;
        let committedRow: Awaited<ReturnType<typeof storedRow>> | undefined;

        await withRivalLock(listing, async (rivalTransaction) => {
          await commitState(listing, T3, rivalTransaction.db);

          running = track(reject(listing, instant(T2), operation.db));

          await awaitBlockedOnRival(operation.name, rivalTransaction.pid);
          await rivalTransaction.commit();
          committedRow = await storedRow(listing);
        });

        expect(
          expectRefusal(await withinCeiling(running as Promise<RejectionResult>, "C-4 completes")),
        ).toEqual({ code: "LISTING_NOT_PENDING", status });
        expect(await storedRow(listing)).toEqual(committedRow);
      });
    }, CONCURRENCY_TEST_TIMEOUT_MS);
  }

  it("C-5 — two rejections contend: exactly one wins, whichever it is", async () => {
    await withOperationSessions(["a", "b"], async (session, track) => {
      const operationA = session("a");
      const operationB = session("b");
      const listing = await seedPending();
      let a: Promise<RejectionResult> | undefined;
      let b: Promise<RejectionResult> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        a = track(reject(listing, instant(T1), operationA.db));
        b = track(reject(listing, instant(T2), operationB.db));

        // Each must be blocked on a chain reaching the rival; direct or indirect are both valid.
        expect(["direct", "indirect"]).toContain(
          await awaitBlockedOnRival(operationA.name, rivalTransaction.pid, [operationB.name]),
        );
        expect(["direct", "indirect"]).toContain(
          await awaitBlockedOnRival(operationB.name, rivalTransaction.pid, [operationA.name]),
        );

        await rivalTransaction.rollback();
      });

      const [resultA, resultB] = await withinCeiling(
        Promise.all([a as Promise<RejectionResult>, b as Promise<RejectionResult>]),
        "C-5 completes",
      );

      const winners = [resultA, resultB].filter((r) => r.ok);
      const losers = [resultA, resultB].filter((r) => !r.ok);

      expect(winners).toHaveLength(1);
      expect(losers.map((r) => !r.ok && r.error)).toEqual([
        { code: "LISTING_NOT_PENDING", status: "rejected" },
      ]);

      const winnerAt = resultA.ok ? T1 : T2;

      expect(await storedRow(listing)).toMatchObject({
        status: "rejected",
        rejected_at: winnerAt,
        last_updated_at: winnerAt,
      });
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-6 — sequential: an administrative edit, then a rejection over the edited content", async () => {
    const listing = await seedPending();

    expect((await edit(listing, { locality: supply("Cobh") }, T0, T1)).ok).toBe(true);
    expect(expectListing(await reject(listing, instant(T2))).content.locality).toBe("Cobh");
    expect(await storedRow(listing)).toMatchObject({
      locality: "Cobh",
      status: "rejected",
      rejected_at: T2,
      last_updated_at: T2,
    });
  }, PLAIN_TEST_TIMEOUT_MS);

  it("C-7 — sequential: after a rejection, an edit is refused as not pending, whatever its token", async () => {
    const listing = await seedPending();

    expectListing(await reject(listing, instant(T1)));

    for (const base of [T0, T1]) {
      const edited = await edit(listing, { locality: supply("Cobh") }, base, T2);

      expect(edited.ok === false && edited.error).toEqual({
        code: "LISTING_NOT_PENDING",
        status: "rejected",
      });
    }

    expect(await storedRow(listing)).toMatchObject({
      locality: SUBMITTED_CONTENT.locality,
      status: "rejected",
      rejected_at: T1,
      last_updated_at: T1,
    });
  }, PLAIN_TEST_TIMEOUT_MS);

  it("C-8 — an unusable instant returns while the rival still holds the lock, sending nothing", async () => {
    const listing = await seedPending();
    const before = await storedRow(listing);
    const errors: unknown[] = [];
    let running: Promise<RejectionResult> | undefined;

    try {
      await withRivalLock(listing, async () => {
        capturing.reset();
        running = reject(listing, null as unknown as Instant, capturing.db);

        const probe = { checkerQueries: 0, checkerSettled: false };
        const first = await raceAgainstLockWait(running, CAPTURE_APPLICATION_NAME, probe);

        expect(first).toBe("returned");
        expect(probe.checkerSettled).toBe(true);
        expect(capturing.statements).toEqual([]);
      });

      expect(
        expectRefusal(await withinCeiling(running as Promise<RejectionResult>, "C-8 completes")),
      ).toEqual({ code: "INVALID_REJECTION_INSTANT" });
      expect(await storedRow(listing)).toEqual(before);
    } catch (error) {
      errors.push(error);
    } finally {
      if (running !== undefined) {
        const settling = settled(running);

        try {
          await withinCeiling(settling, "C-8 settles");
        } catch (overrun) {
          errors.push(overrun);

          try {
            await withinCeiling(
              signalBackends("pg_terminate_backend", [CAPTURE_APPLICATION_NAME]),
              "capture backend terminated",
            );
          } catch (signalError) {
            errors.push(signalError);
          }

          try {
            await withinCeiling(settling, "C-8 settles after termination");
          } catch (secondOverrun) {
            errors.push(secondOverrun);
          }
        }
      }
    }

    throwCollected(errors);
  }, CONCURRENCY_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* Bounded cleanup — harness self-checks, not OP-8 evidence                                       */
/* ------------------------------------------------------------------------------------------- */

/** The messages of `work`'s rejection — an error, or every error of an aggregate. */
async function rejectionMessages(work: Promise<unknown>): Promise<string> {
  const outcome = await work.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(outcome).toBeDefined();

  const messages =
    outcome instanceof AggregateError
      ? outcome.errors.map((error) => String((error as Error).message ?? error))
      : [String((outcome as Error).message ?? outcome)];

  return messages.join("\n");
}

/** Expect `work` to reject with an error, or an aggregate, mentioning every label. */
async function expectCleanupFailure(work: Promise<unknown>, labels: readonly string[]): Promise<string> {
  const joined = await rejectionMessages(work);

  expect(joined).toContain(CEILING_SENTINEL);

  for (const label of labels) {
    expect(joined).toContain(label);
  }

  return joined;
}

/** Wait, deadline-bounded, until `predicate` holds; a named sentinel otherwise. */
async function awaitCondition(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
  }

  throw new Error(`${LOCK_WAIT_SENTINEL}: ${label}`);
}

describe("bounded cleanup (harness self-checks, not OP-8 evidence)", () => {
  it("F-1 — a settlement overrun cancels the owned operation through the controller, even while the observer is stuck", async () => {
    const listing = await seedPending();
    let operationName = "";
    let running: Promise<RejectionResult> | undefined;
    let stuck: Promise<void> | undefined;

    await withRivalLock(listing, async (rivalTransaction) => {
      await expectCleanupFailure(
        withOperationSessions(
          ["a"],
          async (session, track) => {
            const operation = session("a");

            operationName = operation.name;
            running = track(reject(listing, instant(T2), operation.db));

            await awaitBlockedOnRival(operation.name, rivalTransaction.pid);

            // Occupy the observer's only connection behind the rival's lock.
            stuck = settled(
              sql`select id from listing where id = ${listingText(listing)}::uuid for update`.execute(
                observer.db,
              ),
            );

            await awaitCondition(async () => {
              const rows = await sql<{ count: number }>`
                select count(*)::int as count from pg_stat_activity
                 where application_name = ${OBSERVER_APPLICATION_NAME} and wait_event_type = 'Lock'
              `.execute(controller.db);

              return (rows.rows[0]?.count ?? 0) > 0;
            }, "the observer is stuck behind the rival");
          },
          { ceilingMs: 300 },
        ),
        ["started operations settle"],
      );

      // The cancellation went through the controller while the observer was still stuck.
      const stillStuck = await sql<{ count: number }>`
        select count(*)::int as count from pg_stat_activity
         where application_name = ${OBSERVER_APPLICATION_NAME} and wait_event_type = 'Lock'
      `.execute(controller.db);

      expect(stillStuck.rows[0]?.count).toBe(1);

      const outcome = await withinCeiling(running as Promise<RejectionResult>, "cancelled operation");

      expect(outcome.ok).toBe(false);
      await awaitCondition(async () => (await backendCount([operationName])) === 0, "operation backend gone");
      expect((await storedRow(listing)).status).toBe("pending");

      await rivalTransaction.rollback();
    });

    await withinCeiling(stuck as Promise<void>, "stuck observer settles");
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("F-2 — a pool-destruction overrun terminates the owned backends and completes destruction", async () => {
    let operationName = "";
    const gate = { opened: false };

    await expectCleanupFailure(
      withOperationSessions(
        ["a"],
        async (session) => {
          const operation = session("a");

          operationName = operation.name;
          await sql`select 1`.execute(operation.db);

          expect(await backendCount([operation.name])).toBe(1);
        },
        {
          ceilingMs: 300,
          // Hold destruction until the owned backend is gone — which only termination does.
          beforeShutdown: async (name) => {
            await awaitCondition(async () => (await backendCount([name])) === 0, "owned backend gone");
            gate.opened = true;
          },
        },
      ),
      ["operation pools destroyed"],
    );

    expect(gate.opened).toBe(true);
    expect(await backendCount([operationName])).toBe(0);
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("F-3 — a rival-release overrun terminates the rival's own backend and releases the lock", async () => {
    const listing = await seedPending();
    const holder = createTestPool({
      name: uniqueName(HOLDER_PREFIX),
      max: 1,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      connectionTimeoutMs: CEILING_MS,
    });
    let holderPid = 0;
    let sleeping: Promise<void> | undefined;

    try {
      await expectCleanupFailure(
        withRivalLock(
          listing,
          async (rivalTransaction) => {
            holderPid = rivalTransaction.pid;
            // Occupies the connection, so the release queues behind it and overruns. The server
            // must report the statement running before the body returns, or the release could be
            // sent first and never queue at all.
            sleeping = settled(sql`select pg_sleep(1.5)`.execute(rivalTransaction.db));

            await awaitCondition(async () => {
              const rows = await sql<{ count: number }>`
                select count(*)::int as count from pg_stat_activity
                 where pid = ${rivalTransaction.pid} and state = 'active'
              `.execute(controller.db);

              return (rows.rows[0]?.count ?? 0) > 0;
            }, "the occupying statement is running");
          },
          { holder, ceilingMs: 300 },
        ),
        ["rival lock released"],
      );

      await withinCeiling(sleeping as Promise<void>, "occupying statement settles");

      await awaitCondition(async () => {
        const alive = await sql<{ count: number }>`
          select count(*)::int as count from pg_stat_activity where pid = ${holderPid}
        `.execute(controller.db);

        return alive.rows[0]?.count === 0;
      }, "the terminated rival backend is gone");

      // The row lock is gone: a no-wait lock attempt succeeds immediately.
      await persistence.db.transaction().execute(async (trx) => {
        await sql`select id from listing where id = ${listingText(listing)}::uuid for update nowait`.execute(trx);
      });
    } finally {
      await withinCeiling(holder.shutdown(), "holder pool destroyed");
    }

    await awaitCondition(async () => (await backendCount([holder.name])) === 0, "holder backends gone");
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("F-4 — a failed race still stops and awaits the lock-wait checker", async () => {
    const probe = { checkerQueries: 0, checkerSettled: false };

    await expectCleanupFailure(
      raceAgainstLockWait(new Promise<never>(() => undefined), uniqueName("listing_rejection_absent"), probe, 300),
      ["C-8 first outcome"],
    );

    expect(probe.checkerSettled).toBe(true);

    const queriesAtStop = probe.checkerQueries;

    // No further checker work after it was stopped and awaited: one more bounded round trip on
    // the observer completes, and the counter has not moved.
    await sql`select 1`.execute(observer.db);

    expect(probe.checkerQueries).toBe(queriesAtStop);
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("F-5 — a rival connection arriving after its acquisition deadline is discarded, not leaked", async () => {
    const listing = await seedPending();
    const holder = createTestPool({
      name: uniqueName(HOLDER_PREFIX),
      max: 1,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      connectionTimeoutMs: CEILING_MS,
    });
    let occupier: PgClient | undefined;
    let bodyRan = false;

    try {
      // The holder's only connection is taken, so the rival's acquisition must wait.
      occupier = await withinCeiling(holder.pool.connect(), "occupying connection acquired");

      await expectCleanupFailure(
        withRivalLock(
          listing,
          async () => {
            bodyRan = true;
          },
          { holder, acquireCeilingMs: INJECTED_CEILING_MS },
        ),
        ["rival connection acquired"],
      );

      expect(bodyRan).toBe(false);

      // Releasing the occupier hands its client to the still-pending acquisition, which must
      // discard it rather than keep it.
      occupier.release();
      occupier = undefined;

      await awaitCondition(
        async () => holder.pool.totalCount === 0 && (await backendCount([holder.name])) === 0,
        "the late client was discarded and its backend is gone",
      );
    } finally {
      occupier?.release();
      await withinCeiling(holder.shutdown(), "holder pool destroyed");
    }
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("F-6 — a failing beforeShutdown callback is reported, and shutdown still happens", async () => {
    const callbackFailure = "probe: the beforeShutdown callback failed";
    let operationName = "";

    const messages = await rejectionMessages(
      withOperationSessions(
        ["a"],
        async (session) => {
          const operation = session("a");

          operationName = operation.name;
          await sql`select 1`.execute(operation.db);
        },
        {
          beforeShutdown: async () => {
            throw new Error(callbackFailure);
          },
        },
      ),
    );

    expect(messages).toContain(callbackFailure);
    // Shutdown completed inside its first bounded attempt: no overrun, no termination needed.
    expect(messages).not.toContain(CEILING_SENTINEL);

    await awaitCondition(
      async () => (await backendCount([operationName])) === 0,
      "the session backend is gone after shutdown",
    );
  }, CONCURRENCY_TEST_TIMEOUT_MS);
});
