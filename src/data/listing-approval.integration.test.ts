/**
 * Attacking tests for `persistListingApproval` (`OP-7`, issue #242), under `ADR-027`, against a
 * real PostgreSQL server.
 *
 * Each test names the rule it attacks. Behaviour is proven through results and stored rows; the
 * transaction **footprint** — the statements PostgreSQL actually received — is proven separately
 * and labelled as such.
 *
 * ## The harness
 *
 * The pools, safety ceilings, rival lock, blocking-chain observation, statement capture and
 * test-only fault fixtures are copied unchanged in substance from the `OP-8` suite
 * (`listing-rejection.integration.test.ts`, issue #234), with names changed so the two suites
 * cannot see each other's sessions. No shared test helper is edited. The harness's own bounded
 * cleanup paths are attacked by that suite's F-1 to F-6 self-checks and are not repeated here.
 *
 * No test sleeps, polls an assertion until it passes, or re-runs anything. A participant that
 * must block is confirmed blocked through `pg_stat_activity` and `pg_blocking_pids`; **no test
 * depends on the order in which waiters acquire a lock.**
 *
 * The `docs/09` current-state no-op for an already-approved record belongs to the future
 * authenticated boundary (`ADR-027` R-8) and is deliberately **not** asserted here: this suite
 * proves only that persistence refuses such a source without writing.
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
import { insertSubmittedListing } from "./listing-repository";
import type { ListingDatabase } from "./listing-table";
import {
  persistListingApproval,
  type PersistListingApprovalFailure,
} from "./listing-approval";
import { rejectPendingListing } from "./listing-rejection";
import { timestamptzFromEpochMilliseconds } from "./row-mapping";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";

const VERIFIED_DATABASE = "listing_approval_verification";
const HOSTILE_DATABASE = "listing_approval_hostile";

const cluster = useEmbeddedPostgres({
  slug: "listing-approval",
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
  "C-1": RIVAL_ACQUIRE_BOUND_MS + BLOCKED_WAIT_BOUND_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS +
    SESSION_CLEANUP_BOUND_MS,
  // as C-1, plus the rival's own state change (S) before the wait
  "C-2/C-3": RIVAL_ACQUIRE_BOUND_MS + STATEMENT_TIMEOUT_MS + BLOCKED_WAIT_BOUND_MS +
    RIVAL_FINISH_BOUND_MS + CEILING_MS + SESSION_CLEANUP_BOUND_MS,
  // two waits with peers
  "C-4": RIVAL_ACQUIRE_BOUND_MS + 2 * BLOCKED_WAIT_BOUND_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS +
    SESSION_CLEANUP_BOUND_MS,
  // rival { race C; checker stop C }; completion C; settle C, terminate C, settle C
  "C-7": RIVAL_ACQUIRE_BOUND_MS + 2 * CEILING_MS + RIVAL_FINISH_BOUND_MS + CEILING_MS + 3 * CEILING_MS,
  // as C-4: two waits with a peer, plus one probe trigger before the rival
  "C-8": STATEMENT_TIMEOUT_MS + RIVAL_ACQUIRE_BOUND_MS + 2 * BLOCKED_WAIT_BOUND_MS +
    RIVAL_FINISH_BOUND_MS + 2 * CEILING_MS + SESSION_CLEANUP_BOUND_MS,
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

const RIVAL_APPLICATION_NAME = "listing_approval_rival";
const OBSERVER_APPLICATION_NAME = "listing_approval_observer";
const CONTROLLER_APPLICATION_NAME = "listing_approval_controller";
const CAPTURE_APPLICATION_NAME = "listing_approval_capture";
const OPERATION_PREFIX = "listing_approval_op";
const HOLDER_PREFIX = "listing_approval_holder";

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

type ApprovalResult = Result<Listing, PersistListingApprovalFailure>;

async function approve(
  listing: Listing,
  viewed: Instant,
  at: Instant,
  db: Kysely<ListingDatabase> = persistence.db,
): Promise<ApprovalResult> {
  return await persistListingApproval(db, {
    listingId: listing.id,
    viewedLastUpdatedAt: viewed,
    approvedAt: at,
  });
}

function expectRefusal(result: ApprovalResult): PersistListingApprovalFailure {
  if (result.ok) {
    throw new Error("expected a refusal, got a listing");
  }

  return result.error;
}

function expectListing(result: ApprovalResult): Listing {
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
    /** The lock the rival takes instead of the listing row lock (C-8 only). */
    readonly lock?: { readonly text: string; readonly values: readonly unknown[] };
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
    if (options.lock === undefined) {
      await client.query("select id from listing where id = $1::uuid for update", [
        listingText(listing),
      ]);
    } else {
      await client.query(options.lock.text, options.lock.values);
    }

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

const PROBE_PREFIX = "listing_approval_probe_";
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

/** The advisory-lock key of the C-8 gate; test-only, inside the disposable database. */
const EDIT_GATE_KEY = 242_008;

/** Content that satisfies every before-approval obligation, with mixed designations. */
const APPROVABLE = COMPLETE_CONTENT;

/** A pending listing that can be approved, `submitted_at = last_updated_at = at` (default `T0`). */
async function seedApprovable(
  options: { db?: Kysely<ListingDatabase>; at?: number } = {},
): Promise<Listing> {
  return await seedPending({ content: APPROVABLE, ...options });
}

/** The bound value of the original-token predicate in the guarded `UPDATE`. */
function tokenPredicateValueOf(statement: CapturedStatement): unknown {
  const whereAt = statement.sql.search(/\swhere\s/i);
  const whereClause = whereAt === -1 ? "" : statement.sql.slice(whereAt);
  const match = /\blast_updated_at"?\s*=\s*to_timestamp\(0\)\s*\+\s*\(\(\$(\d+)/i.exec(whereClause);

  return match === null ? undefined : statement.parameters[Number(match[1]) - 1];
}

/** The bound value written to `publication_state` by the guarded `UPDATE`. */
function publicationSetValueOf(statement: CapturedStatement): unknown {
  const match = /\bpublication_state"?\s*=\s*\$(\d+)/i.exec(statement.sql);

  return match === null ? undefined : statement.parameters[Number(match[1]) - 1];
}

/* ------------------------------------------------------------------------------------------- */
/* Compile-time contract                                                                          */
/* ------------------------------------------------------------------------------------------- */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type Operation = typeof persistListingApproval;
type Request = Parameters<Operation>[1];

type _RequestSurface = Assert<
  Equals<keyof Request, "listingId" | "viewedLastUpdatedAt" | "approvedAt">
>;
type _NoActor = Assert<Equals<Extract<keyof Request, "role" | "actor" | "override" | "note">, never>>;
type _NoRetry = Assert<Equals<Extract<keyof Request, "retries" | "attempts" | "trx" | "now">, never>>;
type _Arity = Assert<Equals<Parameters<Operation>["length"], 2>>;
type _Success = Assert<Equals<Awaited<ReturnType<Operation>>, ApprovalResult>>;
type _NoExhaustedRetry = Assert<
  Equals<Extract<PersistListingApprovalFailure, { code: "EXHAUSTED_RETRY" }>, never>
>;
type _StaleIsBare = Assert<
  Equals<
    Extract<PersistListingApprovalFailure, { code: "STALE_LISTING_VERSION" }>,
    { readonly code: "STALE_LISTING_VERSION" }
  >
>;

describe("the compile-time contract", () => {
  it("is checked by the type assertions above", () => {
    const guards: [
      _RequestSurface,
      _NoActor,
      _NoRetry,
      _Arity,
      _Success,
      _NoExhaustedRetry,
      _StaleIsBare,
    ] = [true, true, true, true, true, true, true];

    expect(guards.every(Boolean)).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Behaviour                                                                                      */
/* ------------------------------------------------------------------------------------------- */

/** The stored row without the three columns approval may change. */
function unchangedByApproval(row: Awaited<ReturnType<typeof storedRow>>) {
  const { status: _status, publication_state: _publication, last_updated_at: _updated, ...rest } = row;

  return rest;
}

describe("approving a pending listing (FR-ADM-06, BI-7, BI-8, DI-1, DI-2, DI-6, R-6, R-12)", () => {
  it("approves it: approved, publicly available, last_updated_at = at; content, designations and every other listing untouched", async () => {
    const listing = await seedApprovable();
    const other = await seedApprovable();
    const before = await storedRow(listing);
    const otherBefore = await storedRow(other);

    const approved = expectListing(await approve(listing, instant(T0), instant(T2)));

    expect(approved.status).toBe("approved");
    expect(approved.publication).toEqual({ value: "publicly_available" });
    expect(approved.content).toEqual(APPROVABLE);

    const after = await storedRow(listing);

    expect(after).toMatchObject({
      status: "approved",
      publication_state: "publicly_available",
      unpublish_reason: null,
      last_updated_at: T2,
      submitted_at: T0,
      rejected_at: null,
    });
    expect(unchangedByApproval(after)).toEqual(unchangedByApproval(before));
    expect(await storedRow(other)).toEqual(otherBefore);
  }, PLAIN_TEST_TIMEOUT_MS);
});

describe("preflight before any transaction, read or lock (PF-A)", () => {
  for (const [label, token] of [
    ["missing", undefined],
    ["null", null],
    ["malformed", { epochMilliseconds: 1.5 }],
  ] as const) {
    it(`refuses a ${label} viewed-version token as STALE_LISTING_VERSION, sending no statement`, async () => {
      const listing = await seedApprovable();
      const before = await storedRow(listing);

      capturing.reset();

      expect(
        expectRefusal(await approve(listing, token as unknown as Instant, instant(T2), capturing.db)),
      ).toEqual({ code: "STALE_LISTING_VERSION" });
      expect(capturing.statements).toEqual([]);
      expect(await storedRow(listing)).toEqual(before);
    }, PLAIN_TEST_TIMEOUT_MS);
  }

  it("refuses an unusable approval instant as INVALID_APPROVAL_INSTANT, sending no statement", async () => {
    const listing = await seedApprovable();

    capturing.reset();

    expect(
      expectRefusal(await approve(listing, instant(T0), null as unknown as Instant, capturing.db)),
    ).toEqual({ code: "INVALID_APPROVAL_INSTANT" });
    expect(capturing.statements).toEqual([]);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("checks the token before the instant: both unusable gives STALE_LISTING_VERSION", async () => {
    const listing = await seedApprovable();

    expect(
      expectRefusal(
        await approve(listing, undefined as unknown as Instant, null as unknown as Instant),
      ),
    ).toEqual({ code: "STALE_LISTING_VERSION" });
  }, PLAIN_TEST_TIMEOUT_MS);

  it("a tokenless request is stale even for an already-approved record (PF-A, R-5)", async () => {
    const listing = await seedApprovable();

    await makeApprovedPubliclyAvailable(listing, T1);

    expect(
      expectRefusal(await approve(listing, undefined as unknown as Instant, instant(T2))),
    ).toEqual({ code: "STALE_LISTING_VERSION" });
  }, PLAIN_TEST_TIMEOUT_MS);
});

describe("under the lock: missing, lifecycle, token, content, time (R-5, R-7)", () => {
  it("reports an absent identifier as LISTING_NOT_FOUND and creates nothing", async () => {
    const ghost = pendingListing(APPROVABLE, T0);

    expect(expectRefusal(await approve(ghost, instant(T0), instant(T2)))).toEqual({
      code: "LISTING_NOT_FOUND",
    });

    const rows = await sql<{ count: number }>`
      select count(*)::int as count from listing where id = ${listingText(ghost)}::uuid
    `.execute(persistence.db);

    expect(rows.rows[0]?.count).toBe(0);
  }, PLAIN_TEST_TIMEOUT_MS);

  for (const [label, makeState, status] of [
    ["approved and publicly available", makeApprovedPubliclyAvailable, "approved"],
    ["approved and unpublished", makeApprovedUnpublished, "approved"],
    ["rejected", makeRejected, "rejected"],
  ] as const) {
    it(`refuses the ${label} source as LISTING_NOT_PENDING without writing, before comparing the token`, async () => {
      const listing = await seedApprovable();

      await makeState(listing, T1);

      const before = await storedRow(listing);

      // The matching token (T1) and an unequal one (T0) both get the lifecycle refusal.
      for (const viewed of [T1, T0]) {
        expect(expectRefusal(await approve(listing, instant(viewed), instant(T2)))).toEqual({
          code: "LISTING_NOT_PENDING",
          status,
        });
      }

      expect(await storedRow(listing)).toEqual(before);
    }, PLAIN_TEST_TIMEOUT_MS);
  }

  it("refuses a usable but unequal token as STALE_LISTING_VERSION, writing nothing (R-4)", async () => {
    const listing = await seedApprovable();
    const before = await storedRow(listing);

    for (const viewed of [T1, T0 - 1]) {
      expect(expectRefusal(await approve(listing, instant(viewed), instant(T2)))).toEqual({
        code: "STALE_LISTING_VERSION",
      });
    }

    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("decides stale before content: invalid content with an unequal token is STALE_LISTING_VERSION", async () => {
    const listing = await seedPending();

    expect(expectRefusal(await approve(listing, instant(T1), instant(T2)))).toEqual({
      code: "STALE_LISTING_VERSION",
    });
  }, PLAIN_TEST_TIMEOUT_MS);

  it("carries the before-approval violations as LISTING_CONTENT_INVALID, writing nothing (FR-VAL-05)", async () => {
    const listing = await seedPending();
    const before = await storedRow(listing);

    expect(expectRefusal(await approve(listing, instant(T0), instant(T2)))).toEqual({
      code: "LISTING_CONTENT_INVALID",
      violations: [{ code: "CONTACT_METHOD_MINIMUM_UNMET", fields: ["phone", "email", "website"] }],
    });
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("reports a non-advancing instant as APPROVAL_INSTANT_NOT_LATER, never stale (DI-6)", async () => {
    const listing = await seedApprovable({ at: T1 });
    const before = await storedRow(listing);

    for (const at of [T1, T0]) {
      expect(expectRefusal(await approve(listing, instant(T1), instant(at)))).toEqual({
        code: "APPROVAL_INSTANT_NOT_LATER",
      });
    }

    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("reports an unreadable stored listing as STORED_LISTING_UNREADABLE, never not-found", async () => {
    const listing = await seedApprovable({ db: hostile.db });

    try {
      await sql`alter table listing drop constraint if exists listing_status_check`.execute(hostile.db);
      await sql`update listing set status = 'nonsense' where id = ${listingText(listing)}::uuid`.execute(
        hostile.db,
      );

      expect(expectRefusal(await approve(listing, instant(T0), instant(T2), hostile.db)).code).toBe(
        "STORED_LISTING_UNREADABLE",
      );
    } finally {
      await sql`update listing set status = 'pending' where id = ${listingText(listing)}::uuid`.execute(
        hostile.db,
      );
    }
  }, PLAIN_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* The transaction footprint (statements received — footprint, not behaviour)                    */
/* ------------------------------------------------------------------------------------------- */

describe("the transaction footprint (R-1, R-2, R-6)", () => {
  it("one READ COMMITTED transaction: lock first, one guarded UPDATE with three predicates, then commit", async () => {
    const listing = await seedApprovable();

    capturing.reset();
    expectListing(await approve(listing, instant(T0), instant(T2), capturing.db));

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
    expect(statements.slice(lock + 1, update).some((s) => isCommit(s) || isTransactionStart(s))).toBe(
      false,
    );

    const written = statements[update] as CapturedStatement;
    const shape = updateShapeOf(written);

    expect([...shape.setColumns].sort()).toEqual(["last_updated_at", "publication_state", "status"]);
    expect(shape.setStatusValue).toBe("approved");
    expect(publicationSetValueOf(written)).toBe("publicly_available");
    expect(shape.whereIdValue).toBe(listingText(listing));
    expect(shape.whereStatusValue).toBe("pending");
    expect(Number(tokenPredicateValueOf(written))).toBe(T0);

    expect(statements.some((s) => /listing_revision/i.test(s.sql))).toBe(false);
    expect(statements.filter((s) => /^\s*(update|insert|delete)\b/i.test(s.sql))).toHaveLength(1);
  }, PLAIN_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* Faults at the one writing statement, injected through test-only fixtures                      */
/* ------------------------------------------------------------------------------------------- */

describe("faults at the only UPDATE statement (NFR-DATA-03, DI-3, BI-7, R-3)", () => {
  it("a BEFORE UPDATE failure fails the only writing statement and leaves no partial state", async () => {
    const listing = await seedApprovable();

    await createProbeTrigger(
      "before_raise",
      "before",
      "begin raise exception 'probe' using errcode = '23514', constraint = 'probe_check'; end;",
    );

    const before = await storedRow(listing);

    expect(expectRefusal(await approve(listing, instant(T0), instant(T2)))).toEqual({
      code: "INTEGRITY_CONFLICT",
      sqlState: "23514",
      constraint: "probe_check",
    });
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("reports a zero-row guarded UPDATE as GUARDED_UPDATE_PROTOCOL_FAILURE, writing nothing", async () => {
    const listing = await seedApprovable();

    await createProbeTrigger("suppress", "before", "begin return null; end;");

    const before = await storedRow(listing);

    expect(expectRefusal(await approve(listing, instant(T0), instant(T2))).code).toBe(
      "GUARDED_UPDATE_PROTOCOL_FAILURE",
    );
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("classifies a 40001 and never retries it (R-3)", async () => {
    const listing = await seedApprovable();
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

    expect(expectRefusal(await approve(listing, instant(T0), instant(T2)))).toEqual({
      code: "RETRYABLE_CONFLICT",
      sqlState: "40001",
    });
    expect(await storedRow(listing)).toEqual(before);

    const advanced = await sql<{ last_value: string; is_called: boolean }>`
      select last_value::text as last_value, is_called from ${sql.table(sequence)}
    `.execute(persistence.db);

    expect(advanced.rows[0]).toEqual({ last_value: "1", is_called: true });
  }, PLAIN_TEST_TIMEOUT_MS);

  it("the store refuses a status-only approval, which is why status and publication are one statement", async () => {
    const listing = await seedApprovable();

    await expect(
      sql`update listing set status = 'approved' where id = ${listingText(listing)}::uuid`.execute(
        persistence.db,
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "listing_publication_state_check" });
  }, PLAIN_TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* Contention on the listing row (ADR-027 serialized outcomes)                                    */
/* ------------------------------------------------------------------------------------------- */

describe("contention on the listing row (R-2, R-4, R-5, ADR-027 serialized outcomes)", () => {
  it("C-1 — blocks behind a lock holder, then approves", async () => {
    await withOperationSessions(["a"], async (session, track) => {
      const operation = session("a");
      const listing = await seedApprovable();
      const before = await storedRow(listing);
      let running: Promise<ApprovalResult> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        running = track(approve(listing, instant(T0), instant(T2), operation.db));

        expect(await awaitBlockedOnRival(operation.name, rivalTransaction.pid)).toBe("direct");
        expect(await storedRow(listing)).toEqual(before);

        await rivalTransaction.rollback();
      });

      expectListing(await withinCeiling(running as Promise<ApprovalResult>, "C-1 completes"));
      expect(await storedRow(listing)).toMatchObject({
        status: "approved",
        publication_state: "publicly_available",
        last_updated_at: T2,
      });
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-2 — an edit committed while it waits makes the approval stale: unreviewed content is not published", async () => {
    await withOperationSessions(["a"], async (session, track) => {
      const operation = session("a");
      const listing = await seedApprovable();
      const editedAt = timestamptzFromEpochMilliseconds(T1);
      let running: Promise<ApprovalResult> | undefined;
      let committedRow: Awaited<ReturnType<typeof storedRow>> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        await sql`update listing set name = 'Edited', last_updated_at = ${editedAt} where id = ${listingText(listing)}::uuid`.execute(
          rivalTransaction.db,
        );

        running = track(approve(listing, instant(T0), instant(T2), operation.db));

        await awaitBlockedOnRival(operation.name, rivalTransaction.pid);
        await rivalTransaction.commit();
        committedRow = await storedRow(listing);
      });

      expect(
        expectRefusal(await withinCeiling(running as Promise<ApprovalResult>, "C-2 completes")),
      ).toEqual({ code: "STALE_LISTING_VERSION" });
      expect(await storedRow(listing)).toEqual(committedRow);
      expect(committedRow).toMatchObject({ status: "pending", name: "Edited", last_updated_at: T1 });
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-3 — a rejection committed while it waits gives LISTING_NOT_PENDING, not stale (lifecycle before token)", async () => {
    await withOperationSessions(["a"], async (session, track) => {
      const operation = session("a");
      const listing = await seedApprovable();
      let running: Promise<ApprovalResult> | undefined;
      let committedRow: Awaited<ReturnType<typeof storedRow>> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        await makeRejected(listing, T1, rivalTransaction.db);

        running = track(approve(listing, instant(T0), instant(T2), operation.db));

        await awaitBlockedOnRival(operation.name, rivalTransaction.pid);
        await rivalTransaction.commit();
        committedRow = await storedRow(listing);
      });

      expect(
        expectRefusal(await withinCeiling(running as Promise<ApprovalResult>, "C-3 completes")),
      ).toEqual({ code: "LISTING_NOT_PENDING", status: "rejected" });
      expect(await storedRow(listing)).toEqual(committedRow);
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-4 — two approvals with the same token: exactly one approves, the other is the already-approved refusal", async () => {
    await withOperationSessions(["a", "b"], async (session, track) => {
      const operationA = session("a");
      const operationB = session("b");
      const listing = await seedApprovable();
      let a: Promise<ApprovalResult> | undefined;
      let b: Promise<ApprovalResult> | undefined;

      await withRivalLock(listing, async (rivalTransaction) => {
        a = track(approve(listing, instant(T0), instant(T1), operationA.db));
        b = track(approve(listing, instant(T0), instant(T2), operationB.db));

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
        Promise.all([a as Promise<ApprovalResult>, b as Promise<ApprovalResult>]),
        "C-4 completes",
      );

      const winners = [resultA, resultB].filter((r) => r.ok);
      const losers = [resultA, resultB].filter((r) => !r.ok);

      expect(winners).toHaveLength(1);
      expect(losers.map((r) => !r.ok && r.error)).toEqual([
        { code: "LISTING_NOT_PENDING", status: "approved" },
      ]);
      expect(await storedRow(listing)).toMatchObject({
        status: "approved",
        publication_state: "publicly_available",
        last_updated_at: resultA.ok ? T1 : T2,
      });
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-5 — sequential: after an approval, OP-8 is refused as not pending and nothing changes", async () => {
    const listing = await seedApprovable();

    expectListing(await approve(listing, instant(T0), instant(T1)));

    const before = await storedRow(listing);
    const rejected = await rejectPendingListing(persistence.db, {
      listingId: listing.id,
      rejectedAt: instant(T2),
    });

    expect(rejected.ok === false && rejected.error).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "approved",
    });
    expect(await storedRow(listing)).toEqual(before);
  }, PLAIN_TEST_TIMEOUT_MS);

  it("C-6 — sequential: after an FR-ADM-04 edit, the old token is stale and the new one approves the edited content", async () => {
    const listing = await seedApprovable();

    expect((await edit(listing, { locality: supply("Cobh") }, T0, T1)).ok).toBe(true);
    expect(expectRefusal(await approve(listing, instant(T0), instant(T2)))).toEqual({
      code: "STALE_LISTING_VERSION",
    });
    expect(expectListing(await approve(listing, instant(T1), instant(T2))).content.locality).toBe(
      "Cobh",
    );
    expect(await storedRow(listing)).toMatchObject({
      locality: "Cobh",
      status: "approved",
      last_updated_at: T2,
    });
  }, PLAIN_TEST_TIMEOUT_MS);

  it("C-8 — a real FR-ADM-04 edit commits while the approval waits behind it: the approval is stale", async () => {
    await withOperationSessions(["edit", "approve"], async (session, track) => {
      const editSession = session("edit");
      const approveSession = session("approve");
      const listing = await seedApprovable();
      let editing: ReturnType<typeof applyAdministrativeEditToPendingListing> | undefined;
      let approving: Promise<ApprovalResult> | undefined;

      // A test-only gate: the edit's UPDATE waits on an advisory lock the rival holds, so the
      // real FR-ADM-04 transaction pauses **after** taking the listing row lock and **before**
      // committing. The approval then queues behind the edit, not behind the rival.
      await createProbeTrigger(
        "edit_gate",
        "before",
        `begin
           if new.locality = 'Cobh' then
             perform pg_advisory_xact_lock(${EDIT_GATE_KEY});
           end if;
           return new;
         end;`,
      );

      await withRivalLock(
        listing,
        async (rivalTransaction) => {
          editing = track(
            applyAdministrativeEditToPendingListing(editSession.db, {
              listingId: listing.id,
              baseListingLastUpdatedAt: instant(T0),
              edit: { locality: supply("Cobh") },
              at: instant(T1),
            }),
          );

          // The edit holds the row lock and waits on the rival's advisory lock.
          expect(await awaitBlockedOnRival(editSession.name, rivalTransaction.pid)).toBe("direct");

          approving = track(approve(listing, instant(T0), instant(T2), approveSession.db));

          // The approval waits on the row lock the edit holds: blocked through the edit.
          expect(
            await awaitBlockedOnRival(approveSession.name, rivalTransaction.pid, [
              editSession.name,
            ]),
          ).toBe("indirect");

          await rivalTransaction.commit();
        },
        { lock: { text: "select pg_advisory_xact_lock($1)", values: [EDIT_GATE_KEY] } },
      );

      const edited = await withinCeiling(
        editing as ReturnType<typeof applyAdministrativeEditToPendingListing>,
        "C-8 edit completes",
      );

      expect(edited.ok).toBe(true);
      const approval = await withinCeiling(
        approving as Promise<ApprovalResult>,
        "C-8 approval completes",
      );

      expect(expectRefusal(approval)).toEqual({ code: "STALE_LISTING_VERSION" });
      expect(await storedRow(listing)).toMatchObject({
        status: "pending",
        publication_state: null,
        locality: "Cobh",
        last_updated_at: T1,
      });
    });
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("C-7 — a malformed token returns while the rival still holds the lock, sending nothing (PF-A)", async () => {
    const listing = await seedApprovable();
    const before = await storedRow(listing);
    const errors: unknown[] = [];
    let running: Promise<ApprovalResult> | undefined;

    try {
      await withRivalLock(listing, async () => {
        capturing.reset();
        running = approve(listing, null as unknown as Instant, instant(T2), capturing.db);

        const probe = { checkerQueries: 0, checkerSettled: false };
        const first = await raceAgainstLockWait(running, CAPTURE_APPLICATION_NAME, probe);

        expect(first).toBe("returned");
        expect(probe.checkerSettled).toBe(true);
        expect(capturing.statements).toEqual([]);
      });

      expect(
        expectRefusal(await withinCeiling(running as Promise<ApprovalResult>, "C-7 completes")),
      ).toEqual({ code: "STALE_LISTING_VERSION" });
      expect(await storedRow(listing)).toEqual(before);
    } catch (error) {
      errors.push(error);
    } finally {
      if (running !== undefined) {
        const settling = settled(running);

        try {
          await withinCeiling(settling, "C-7 settles");
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
            await withinCeiling(settling, "C-7 settles after termination");
          } catch (secondOverrun) {
            errors.push(secondOverrun);
          }
        }
      }
    }

    throwCollected(errors);
  }, CONCURRENCY_TEST_TIMEOUT_MS);
});
