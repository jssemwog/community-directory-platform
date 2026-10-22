/**
 * Attacking tests for `OP-10` against a real PostgreSQL server (issue #197).
 *
 * `ADR-024` names its own material tradeoff: correctness depends on **enforced statement and
 * lock order** rather than on the engine, *"which makes deterministic interleaving tests
 * mandatory"*. `OP-10` raises the stakes over `OP-6`, because it performs **two** mutations that
 * `ADR-017` Q-3 requires to stand or fall together — so the attacks below are as much about
 * rollback as about ordering.
 *
 * ## How the interleavings stay deterministic
 *
 * No test sleeps, polls an assertion, or re-runs anything until it passes. Where a participant
 * must be *blocked* while another commits, the suite synchronises on **observable lock
 * acquisition** read from `pg_stat_activity`, with a named sentinel if the wait never appears so
 * that a participant which fails to block fails immediately instead of hanging. Test timeouts
 * bound liveness only; no assertion depends on a duration.
 *
 * ## Forcing outcomes the protocol says are impossible
 *
 * Two attacks require a mutation to affect zero rows — states that cannot arise under the lock.
 * They are produced with **test-only `BEFORE` triggers** that return `NULL`, which makes
 * PostgreSQL skip the row operation and report zero affected rows. The triggers are created and
 * dropped by the test that needs them, in a `finally`, and nothing in `src/` knows they exist:
 * **no production fault-injection hook is introduced**, which was an explicit condition of this
 * unit.
 *
 * ## Operations that do not exist yet
 *
 * Revision rejection and the administrative listing edit are **not implemented** and must not be
 * created here. Where an interleaving needs one, it is driven as a **test-only SQL participant**
 * inside a controlled transaction — a local fixture, never exported, never a repository
 * function.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Kysely,
  PostgresDialect,
  sql,
  type CompiledQuery,
  type ControlledTransaction,
  type QueryResult,
} from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import {
  CLUSTER_PASSWORD,
  CLUSTER_TIMEOUT_MS,
  EXIT_POLL_INTERVAL_MS,
  EXIT_WAIT_CEILING_MS,
  useEmbeddedPostgres,
} from "./testing/embedded-cluster";

import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing, ListingContent } from "../domain/listing/listing";
import type { PendingListingRevision } from "../domain/listing/revision";
import {
  createListingPersistence,
  startupOptionsFor,
  type ListingPersistence,
} from "./connection";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import type { ListingDatabase } from "./listing-table";
import { findListingById, insertSubmittedListing } from "./listing-repository";
import { createPendingRevision, findPendingRevisionByListing } from "./revision-repository";
import { approveAndApplyPendingRevision } from "./revision-approval";

const VERIFIED_DATABASE = "revision_approval_verification";
/** A second database whose revision `CHECK`s are dropped, so hostile rows can be stored. */
const HOSTILE_DATABASE = "revision_approval_hostile";

const cluster = useEmbeddedPostgres({
  slug: "approval",
  databases: [VERIFIED_DATABASE, HOSTILE_DATABASE],
  migrate: [VERIFIED_DATABASE, HOSTILE_DATABASE],
});

/** The boundary under test. */
let persistence: ListingPersistence;
/** A rival participant, so a lock can be held while the boundary runs. */
let rival: ListingPersistence;
/** A connection that only observes, so it is never the blocked backend. */
let observer: ListingPersistence;
/** A database that will store rows the domain cannot represent. */
let hostile: ListingPersistence;
/** The same boundary, with every executed statement captured. */
let capturing: ReturnType<typeof createCapturingPersistence>;

/** The rival pool's label, so its own sessions can be counted and named at teardown. */
const RIVAL_APPLICATION_NAME = "revision_approval_rival";

/**
 * How long `pg_terminate_backend` may wait for the backend it signalled to actually exit
 * (issue #211).
 *
 * **This is a ceiling, not a delay.** `pg_terminate_backend(pid, timeout)` is PostgreSQL's
 * documented two-argument form: with a positive `timeout` in milliseconds it waits until the
 * process has terminated and returns `true`, or gives up at the ceiling and returns `false`
 * with a `WARNING`. It returns as soon as the backend is gone — measured at ~110ms against the
 * bundled PostgreSQL 17.10 — so the number below is never spent, and nothing here sleeps.
 *
 * **Why it is needed at all.** Defaulted to `0` — which is what the one-argument call this
 * replaced compiled to — the function only *sends* the signal and returns immediately. The
 * backend hands its `FATAL` to the client **before** it finishes `proc_exit`, so the pool's
 * `57P01` event can arrive while the server still reports the `pid` in `pg_stat_activity`. That
 * is client-side evidence of a server-side transition, and it failed once in CI for exactly
 * that reason. A positive timeout makes the function's own return the completion boundary.
 */
const TERMINATION_WAIT_MS = 5_000;

const APPROVED_AT = 1_767_323_045_123;
/** Strictly later than `APPROVED_AT`, as `DI-6` requires of an approval. */
const APPLIED_AT = APPROVED_AT + 1_000;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

/** The content a listing is approved with, before any revision is applied. */
const ORIGINAL_CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

/**
 * The content the proposal would apply — different in every field that can differ.
 *
 * **Every designatable value is private** (issue #207). `ORIGINAL_CONTENT` carries none of the
 * four, so each of these is an **addition**, which `ADR-025` makes private and unpublishable.
 * This fixture proposed a **public** `postalCode` and `email` while `OP-6` did not yet enforce
 * the policy; now that it does, the proposal must be lawful to be created at all. Nothing else
 * changed, and no assertion about approval behaviour was weakened.
 */
const PROPOSED_CONTENT: ListingContent = {
  name: "Harbour Bakery & Cafe",
  category: "retail-shopping",
  description: "A small bakery, now with a cafe.",
  locality: "Cobh",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: false },
  phone: { value: "+353 21 123 4567", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: false },
  website: { value: "https://example.ie", designatedPublic: false },
};

function approvedListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "approved",
    content: ORIGINAL_CONTENT,
    publication: { value: "publicly_available" },
    timestamps: {
      submittedAt: instant(APPROVED_AT - 1_000),
      lastUpdatedAt: instant(APPROVED_AT),
    },
    ...overrides,
  };
}

function proposalFor(
  listing: Listing,
  content: ListingContent = PROPOSED_CONTENT,
): PendingListingRevision {
  return {
    listingId: listing.id,
    state: "pending",
    proposedContent: content,
    baseListingLastUpdatedAt: listing.timestamps.lastUpdatedAt,
  } as PendingListingRevision;
}

function listingText(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

/** An approved listing with one pending proposal, stored through the real repositories. */
async function seedWithProposal(
  db = persistence.db,
  content: ListingContent = PROPOSED_CONTENT,
): Promise<Listing> {
  const listing = approvedListing();

  expect((await insertSubmittedListing(db, listing)).ok).toBe(true);
  expect(
    (
      await createPendingRevision(db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing, content),
      })
    ).ok,
  ).toBe(true);

  return listing;
}

async function storedListingRow(listing: Listing) {
  const rows = await sql<{
    name: string;
    category: string;
    locality: string;
    status: string;
    last_updated_at: number;
    submitted_at: number;
    publication_state: string | null;
  }>`
    select name, category, locality, status, last_updated_at, submitted_at, publication_state
      from listing where id = ${listingText(listing)}::uuid
  `.execute(persistence.db);

  const row = rows.rows[0];

  if (row === undefined) {
    throw new Error("the seeded listing is missing");
  }

  return row;
}

async function revisionRowCount(listing: Listing, db = persistence.db): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from listing_revision where listing_id = ${listingText(listing)}::uuid
  `.execute(db);

  return rows.rows[0]?.count ?? 0;
}

/** Sessions left holding a transaction open. Must always settle at zero. */
async function sessionsInTransaction(): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from pg_stat_activity
     where datname = current_database()
       and state in ('idle in transaction', 'idle in transaction (aborted)')
  `.execute(observer.db);

  return rows.rows[0]?.count ?? 0;
}

/**
 * Every live backend on this database, by `pid`. Used to prove *only* an owned one was ended.
 *
 * Split into a compiled query and a runner (issue #211) so one test can execute **this exact
 * statement** through its own tracer and so observe when it ran. There is one source of truth
 * for the SQL either way.
 */
function livePidsQuery(): CompiledQuery<{ pid: number }> {
  return sql<{ pid: number }>`
    select pid from pg_stat_activity where datname = current_database() and pid is not null
  `.compile(observer.db);
}

async function livePids(): Promise<readonly number[]> {
  const rows = await observer.db.executeQuery(livePidsQuery());

  return rows.rows.map((row) => row.pid);
}

/** Sessions belonging to one labelled pool, whatever their state. */
async function sessionsNamed(applicationName: string): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from pg_stat_activity
     where datname = current_database() and application_name = ${applicationName}
  `.execute(observer.db);

  return rows.rows[0]?.count ?? 0;
}

/**
 * Raised when the server is still reporting an owned backend at the settlement ceiling.
 *
 * Named, so an exhausted wait is unmistakable in a run log and can never be read as a slow pass.
 * It carries the pids still present and the ceiling that was reached — both safe: a backend pid is
 * an integer the server publishes, and no credential, SQL, row or session content travels with it.
 */
class BackendSettlementExhausted extends Error {
  constructor(
    readonly remaining: readonly number[],
    readonly ceilingMs: number,
  ) {
    super(
      `backends still present after ${ceilingMs}ms of settlement waiting: ${remaining.join(", ")}`,
    );
    this.name = "BackendSettlementExhausted";
  }
}

/**
 * Which of **these exact** backends the server still reports, read fresh every time.
 *
 * One autocommit statement at the connection's `READ COMMITTED` default, on an observer that holds
 * no transaction, so every observation takes its own snapshot — a wait built on a retained
 * snapshot would never see the change it is waiting for. Restricted to the owned disposable
 * database and to the captured pid set, so nothing else can satisfy or spoil it.
 */
async function livePidsAmong(pids: readonly number[]): Promise<readonly number[]> {
  if (pids.length === 0) {
    return [];
  }

  const rows = await sql<{ pid: number }>`
    select pid
      from pg_stat_activity
     where datname = current_database() and pid = any(${[...pids]}::int[])
     order by pid
  `.execute(observer.db);

  return rows.rows.map((row) => row.pid);
}

/**
 * Wait, under a hard bound, until the server stops reporting these exact backends (issue #223,
 * authorization amended 2026-10-22).
 *
 * ## Why waiting is the right boundary
 *
 * `destroy()` resolves when the pool has closed its client sockets. The server dropping each
 * backend is a **separate event** — it happens when that backend notices its peer is gone. The gap
 * between them is real and observable: Linux CI reported owned pids `2593`, `2605` and `2607` still
 * in `pg_stat_activity` immediately after the shutdown that owned them had resolved, on a
 * candidate that passed on Windows. Asserting server state from the client's completion event was
 * asserting the wrong fact, and Windows non-reproduction did not disprove the mechanism.
 *
 * ## What this is, and what it is not
 *
 * **The correctness oracle is the observed server state, never elapsed time.** The interval only
 * schedules the next fresh observation; no duration is ever waited out on the success path, and an
 * immediately absent set returns after a single observation. The constants are the repository's
 * own deterministic PostgreSQL wait pair — `EXIT_POLL_INTERVAL_MS` (100ms, the smallest interval
 * already established here) and `EXIT_WAIT_CEILING_MS` (30s) — reused from `waitForOwnedExit`,
 * which waits for an owned *postmaster* to disappear and is the closest existing analogue to
 * waiting for an owned *backend* to disappear. Reusing them keeps one authority for the numbers
 * instead of inventing a second.
 *
 * The deadline is **monotonic** (`performance.now()`), so a wall-clock adjustment cannot extend or
 * collapse it.
 *
 * It is **not** a fixed delay, **not** a grace period, **not** a retry of the shutdown, and
 * **not** a retry of the assertion: the caller still asserts absence exactly once, afterwards.
 * Exhaustion **throws** — it can never become success — and the thrower names the pids that
 * remain, which is precisely the diagnosis the old aggregate count could not give.
 */
async function awaitBackendsGone(
  pids: readonly number[],
  ceilingMs: number = EXIT_WAIT_CEILING_MS,
): Promise<void> {
  const startedAt = performance.now();
  let remaining = await livePidsAmong(pids);

  while (remaining.length > 0) {
    if (performance.now() - startedAt >= ceilingMs) {
      throw new BackendSettlementExhausted(remaining, ceilingMs);
    }

    await new Promise((settled) => setTimeout(settled, EXIT_POLL_INTERVAL_MS));
    remaining = await livePidsAmong(pids);
  }
}

/**
 * The backend pids carrying one label — the attribution a bare count cannot make (issue #223).
 *
 * Ordered, so a failure message is stable, and filtered by the owned disposable database as well
 * as the label, because database alone matches every pool in this file plus the observer.
 */
async function pidsNamed(applicationName: string): Promise<readonly number[]> {
  const rows = await sql<{ pid: number }>`
    select pid
      from pg_stat_activity
     where datname = current_database() and application_name = ${applicationName}
     order by pid
  `.execute(observer.db);

  return rows.rows.map((row) => row.pid);
}

/** Sessions of one labelled pool that are blocked waiting on a lock. */
async function blockedSessionsNamed(applicationName: string): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from pg_stat_activity
     where datname = current_database()
       and application_name = ${applicationName}
       and wait_event_type = 'Lock'
  `.execute(observer.db);

  return rows.rows[0]?.count ?? 0;
}

/**
 * Resolve with the **next** error this pool hands to its own listener.
 *
 * Registered *before* the backend is terminated, so the wait is event-driven: there is no
 * polling, no sleep and no duration in any assertion. If the event never arrives the test's own
 * timeout reports it, which is a liveness bound rather than a correctness oracle.
 */
function nextPoolError(pool: PgPool): Promise<Error> {
  return new Promise((resolve) => {
    pool.on("error", resolve);
  });
}

/**
 * The shape of a termination statement, read from the **compiled artifact** (issue #211).
 *
 * The original race is low frequency and does not reproduce reliably on a fast host, so
 * "the timeout is still there" cannot be left to a behavioural assertion that may pass either
 * way. This reads the `CompiledQuery` that is **actually executed** — its SQL text and its
 * bound parameters — so removing or zeroing the timeout fails deterministically.
 *
 * It reads the compiled statement and nothing else: no comment, no source string and no
 * identifier name reaches it, and `placeholders` is what separates the two-argument call from
 * the defaulted one-argument call it replaced.
 */
function terminationShape(compiled: CompiledQuery): {
  readonly normalized: string;
  readonly calls: number;
  readonly placeholders: number;
  readonly parameters: readonly unknown[];
} {
  const normalized = compiled.sql.replace(/\s+/g, " ").trim();

  return {
    normalized,
    calls: (normalized.match(/pg_terminate_backend/g) ?? []).length,
    placeholders: (normalized.match(/\$\d+/g) ?? []).length,
    parameters: compiled.parameters,
  };
}

/**
 * Execute compiled statements on the observer, recording when each one really started and
 * finished (issue #211).
 *
 * **Why this exists.** Two of this test's guarantees are about *execution*, not about SQL text,
 * and neither can be read off the compiled artifact: that the terminating statement runs
 * **exactly once**, and that `pg_stat_activity` is inspected **only after** that statement has
 * settled. Asserting them on a fast host is worthless — the backend usually disappears within a
 * millisecond, so an inspection started too early still finds it gone, which is precisely why
 * the original race survived twenty local runs. Recording the real execution boundaries makes
 * both properties fail deterministically instead, whatever the host's speed.
 *
 * It is a **test-only** observer: it adds no production seam, wraps no production code, and
 * changes nothing about how the statements are compiled or run. `executeQuery` is Kysely's own
 * public entry point, and each statement is still executed once, on the same connection as
 * before.
 */
function observerExecutionTrace(): {
  /** Labels in the order execution actually began and ended, e.g. `terminate:start`. */
  readonly events: readonly string[];
  run: <O>(label: string, compiled: CompiledQuery<O>) => Promise<QueryResult<O>>;
} {
  const events: string[] = [];

  return {
    events,
    run: async <O>(label: string, compiled: CompiledQuery<O>): Promise<QueryResult<O>> => {
      events.push(`${label}:start`);

      const result = await observer.db.executeQuery(compiled);

      events.push(`${label}:end`);

      return result;
    },
  };
}

/**
 * The narrow slice of `pg` this file reaches directly, to build a **logging** boundary.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is described here — the pattern `migrate.ts` and the listing suite established.
 */
interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => PgPool;
}

/**
 * The narrow slice of `pg`'s `Pool` this file touches (issue #201).
 *
 * Previously the constructor returned `unknown`, which was enough while the pool was only ever
 * handed to Kysely. Attaching an `error` listener and asserting the pool's own lifecycle both
 * need a shape, so the three facts used are declared — and **nothing more**, keeping this a
 * description of the driver rather than a second source of truth about it.
 */
interface PgPool {
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Used only to prove a listener is attached before any client can become idle. */
  listenerCount(event: string): number;
  readonly idleCount: number;
  readonly totalCount: number;
  readonly waitingCount: number;
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

/**
 * The label every capturing instance in this file has carried since it was introduced.
 *
 * It is the **suite-wide** pool's identity. It is deliberately *not* reused by the one instance
 * whose shutdown is asserted — see `OWNED_CAPTURE_APPLICATION_NAME` and issue #223.
 */
const CAPTURE_APPLICATION_NAME = "revision_approval_capture";

/**
 * A **distinct, stable** label for the single capturing pool whose shutdown this file asserts
 * (issue #223).
 *
 * ## Why a second label exists
 *
 * `sessionsNamed` identifies sessions by database plus `application_name`, and its own description
 * called that *"sessions belonging to one labelled pool"*. That premise was false: three instances
 * in this file were built by the same factory with the same hard-coded label on the same database,
 * so the predicate returned their **sum** and could attribute a session to none of them. A probe
 * measured exactly that — one pool: 1; two pools: 2, pids `[a, b]`; shutting down only the second:
 * back to 1 with its pid gone — so an assertion comparing that count against a baseline could not
 * distinguish *this pool leaked a session* from *another pool carrying the label differs from its
 * baseline*.
 *
 * **What this does not claim.** The proximate cause of the two CI failures of that assertion
 * remains **unknown**: a clean `destroy()` left no residue in 60/60 iterations, the failing test's
 * exact terminate-then-replace-then-destroy shape left none in 30/30, and the symptom has never
 * reproduced locally. Relabelling makes the question answerable, not answered — if this pool ever
 * does leak, the assertion now names the pid.
 *
 * **Stable and deterministic**: a fixed string, with no randomness, timestamp, pid, test index or
 * counter, so a failure message is reproducible and readable. 31 bytes, well inside
 * PostgreSQL's 63-byte `application_name` limit. Nothing in production reads or sets it.
 */
const OWNED_CAPTURE_APPLICATION_NAME = "revision_approval_capture_owned";

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A `C9` boundary identical to the production one, with every executed statement captured.
 *
 * **No production change buys this.** `approveAndApplyPendingRevision` accepts any
 * `Kysely<ListingDatabase>`, and Kysely's own `log` option reports each statement it executes as
 * compiled SQL plus bound parameters — so the *actual executed* `UPDATE` can be inspected
 * without a fault-injection hook, a source-text assertion, or any weakening of the lock.
 *
 * The pool is configured exactly as `createListingPersistence` configures its own: the governed
 * `timestamptz` overrides so instants arrive as epoch milliseconds (`ADR-022` decision 9), and
 * the governed `DateStyle` in the startup packet. Anything less would be testing a different
 * boundary from the one that runs in production.
 */
function createCapturingPersistence(
  database: string,
  applicationName: string = CAPTURE_APPLICATION_NAME,
): {
  readonly db: Kysely<ListingDatabase>;
  readonly statements: readonly CapturedStatement[];
  /** Exposed for issue #201's assertions only; no test may use it to drive the boundary. */
  readonly pool: PgPool;
  /** The errors the pool handed to its own listener, so a test can prove it got them. */
  readonly idlePoolErrors: readonly Error[];
  reset(): void;
  shutdown(): Promise<void>;
} {
  const statements: CapturedStatement[] = [];

  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(database),
    max: 2,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: applicationName }),
  });

  /**
   * Every error this pool delivered to its own listener, newest last (issue #201).
   *
   * Recorded **only** so a test can prove the event arrived **here** rather than at the
   * process. It changes nothing about how the pool behaves.
   */
  const idlePoolErrors: Error[] = [];

  /**
   * The listener issue #201 exists for, attached **immediately** after construction — before
   * any client can be checked out, become idle, or be terminated by the server.
   *
   * `connection.ts` attaches the same listener on every application pool and records the
   * reason: *"an idle client killed by the server raises the pool's `error` event, and an
   * unhandled `EventEmitter` `error` throws"*. `embedded-cluster.ts` does it too, *"the same
   * reason `connection.ts` handles this"*. This pool is built directly from `pg` and so had
   * neither — the one pool in this file outside both factories — which is how a `57P01` at
   * cluster shutdown became an unhandled error that failed a run in which every test passed.
   *
   * **Handled by doing nothing**, exactly as production does: there is nothing to do about a
   * lost idle connection — the pool discards the client and opens another on demand — and
   * `ADR-016` selects no observability, so a log line or a telemetry hook here would decide
   * something nobody has ruled on. Recording into an array is a **test** observation, not a
   * behaviour change.
   *
   * **It conceals nothing.** This event fires only for a client that was already idle in the
   * pool. A failing query rejects its own promise and reaches the caller unchanged, and a pool
   * that cannot connect still fails every checkout — so no operation failure is hidden and no
   * broken pool can report a query as successful. Nothing here retries, reconnects or
   * recovers.
   */
  pool.on("error", (error) => {
    idlePoolErrors.push(error);
  });

  const db = new Kysely<ListingDatabase>({
    dialect: new PostgresDialect({ pool: pool as never }),
    log: (event) => {
      if (event.level === "query") {
        statements.push({
          sql: event.query.sql,
          parameters: event.query.parameters,
        });
      }
    },
  });

  return {
    db,
    statements,
    pool,
    idlePoolErrors,
    reset: () => {
      statements.length = 0;
    },
    shutdown: () => db.destroy(),
  };
}

/** Every `update "listing"` statement among those captured. */
function listingUpdatesIn(statements: readonly CapturedStatement[]): readonly CapturedStatement[] {
  return statements.filter((statement) => /^\s*update\s+"listing"\s+set\b/i.test(statement.sql));
}

/** What the analyser below found in one `UPDATE`, so a failure names the missing part. */
interface GuardedUpdateShape {
  readonly setsLastUpdatedAt: boolean;
  readonly whereHasListingId: boolean;
  readonly whereHasLastUpdatedAt: boolean;
  readonly whereConvertsAnInstant: boolean;
  readonly setsForbiddenColumn: string | undefined;
}

/**
 * Describe the guarded shape of one compiled `UPDATE`, by splitting `SET` from `WHERE`.
 *
 * The split matters: `last_updated_at` appears on **both** sides — it is assigned in `SET` and
 * compared in `WHERE` — so an assertion that merely searched the whole statement would pass with
 * the predicate removed. This is the precise thing the missing mutation needed.
 *
 * Exported shape rather than bare booleans so a failure says *which* clause was absent, and so
 * the analyser itself can be attacked with a hostile sample below.
 */
function guardedUpdateShapeOf(statementSql: string): GuardedUpdateShape {
  const whereAt = statementSql.search(/\swhere\s/i);
  const setClause = whereAt === -1 ? statementSql : statementSql.slice(0, whereAt);
  const whereClause = whereAt === -1 ? "" : statementSql.slice(whereAt);

  const forbidden = [
    "status",
    "submitted_at",
    "rejected_at",
    "publication_state",
    "unpublish_reason",
  ].find((column) => new RegExp(`"${column}"\\s*=`, "i").test(setClause));

  return {
    setsLastUpdatedAt: /"last_updated_at"\s*=/i.test(setClause),
    whereHasListingId: /"id"\s*=/i.test(whereClause),
    whereHasLastUpdatedAt: /"last_updated_at"\s*=/i.test(whereClause),
    whereConvertsAnInstant: /to_timestamp\s*\(/i.test(whereClause),
    setsForbiddenColumn: forbidden,
  };
}

const LOCK_WAIT_SENTINEL = "no backend ever blocked on a lock";

/**
 * Wait until PostgreSQL reports a backend blocked on a lock, then return.
 *
 * A condition wait on a fact the server publishes — not a sleep, and not a retry. Each iteration
 * is one round trip, so the loop paces itself and ends the moment the fact appears. The bound
 * exists so a participant that never blocks fails **immediately and by name** instead of hanging
 * until the test timeout and leaving a cluster behind.
 */
async function awaitLockWaiter(attempts = 2_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await sql<{ count: number }>`
      select count(*)::int as count
        from pg_stat_activity
       where wait_event_type = 'Lock' and datname = current_database()
    `.execute(observer.db);

    if ((waiting.rows[0]?.count ?? 0) > 0) {
      return;
    }
  }

  throw new Error(`${LOCK_WAIT_SENTINEL}: the operation under test did not wait for the lock`);
}

/**
 * Hold the listing lock for the duration of `body`, and **always** settle and release it
 * (issue #201).
 *
 * ## Why the `finally` is not tidiness
 *
 * A held row lock also holds a table-level lock on `listing`, and this file's `afterEach`
 * runs `drop trigger … on listing`, which needs `ACCESS EXCLUSIVE`. So a test that threw
 * while still holding the lock would make cleanup block **indefinitely** and bury the real
 * failure under a timeout. Issue #199 demonstrated exactly that in the sibling rejection
 * suite: a mutation removing the `PS-11` lock made the lock-wait sentinel fire, and the
 * leaked transaction turned a clean 30-second failure into a hang. The five call sites in
 * this file previously had no `finally` at all.
 *
 * ## Why acquisition is inside the `try`
 *
 * Only `startTransaction()` sits outside it. A `SELECT … FOR UPDATE` that throws leaves the
 * transaction **open and aborted**, still holding whatever it managed to acquire, and the
 * client still checked out — so taking the lock before the `try` would leak it on a setup
 * failure, one statement earlier than the escaping-assertion case. If `startTransaction()`
 * itself throws there is no transaction to release and nothing to guard.
 *
 * ## Failure reporting
 *
 * The **body's** failure is primary and always propagates. If cleanup *also* fails, both are
 * reported through an `AggregateError` whose **first** error is the body's — the scheme
 * `embedded-cluster.ts`'s own `withEmbeddedPostgres` established, reused rather than
 * re-invented. Neither failure is ever swallowed, and a noisy release never replaces the
 * original. If only cleanup fails, that failure stands alone.
 *
 * `body` may commit the transaction itself — the usual case, since these interleavings need
 * the rival to commit at a chosen moment — so the release is conditional on the transaction
 * still being open. The helper does not return until it has settled.
 *
 * `seams` exists for this file's own failure-path tests, following the same seam convention
 * the embedded-cluster harness uses for its cleanup. Production code has no equivalent and
 * none is introduced.
 */
async function withRivalLock(
  listing: Listing,
  body: (trx: ControlledTransaction<ListingDatabase>) => Promise<void>,
  seams: { release?: (trx: ControlledTransaction<ListingDatabase>) => Promise<void> } = {},
): Promise<void> {
  const trx = await rival.db
    .startTransaction()
    .setIsolationLevel("read committed")
    .execute();

  let bodyError: unknown;
  let threw = false;

  try {
    // Inside the `try` on purpose — see the header.
    await trx
      .selectFrom("listing")
      .select("id")
      .where("id", "=", listingText(listing))
      .forUpdate()
      .execute();

    await body(trx);
  } catch (error) {
    threw = true;
    bodyError = error;
    throw error;
  } finally {
    try {
      if (trx.isCommitted === false && trx.isRolledBack === false) {
        await (seams.release ?? ((open) => open.rollback().execute().then(() => undefined)))(trx);
      }
    } catch (releaseError) {
      if (!threw) {
        throw releaseError;
      }

      throw new AggregateError(
        [bodyError, releaseError],
        "the test body failed and releasing the rival lock also failed; the first error is " +
          "the original failure",
      );
    }
  }
}

/**
 * Suppress every row operation of one kind on one table, for the duration of `body`.
 *
 * A `BEFORE … FOR EACH ROW` trigger returning `NULL` makes PostgreSQL skip the operation and
 * report **zero** affected rows — which is how a state the protocol proves impossible can be
 * presented to it anyway. **Test-only**: created here, dropped in `finally`, and unknown to
 * `src/`. `afterEach` additionally sweeps any trigger a failed assertion might have stranded.
 */
async function withSuppressed<T>(
  table: "listing" | "listing_revision",
  operation: "update" | "delete",
  body: () => Promise<T>,
): Promise<T> {
  const name = `cdp_test_suppress_${table}_${operation}`;

  await sql`
    create or replace function cdp_test_suppress() returns trigger
      language plpgsql as $$ begin return null; end $$
  `.execute(persistence.db);

  await sql.raw(
    `create trigger ${name} before ${operation} on ${table} ` +
      `for each row execute function cdp_test_suppress()`,
  ).execute(persistence.db);

  try {
    return await body();
  } finally {
    await sql.raw(`drop trigger if exists ${name} on ${table}`).execute(persistence.db);
  }
}

beforeAll(async () => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 4 },
    startupParameters: { application_name: "revision_approval_tests" },
  });

  rival = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
    // Labelled so issue #201's failure-path tests can **count** this pool's sessions rather
    // than infer them from a total. `application_name` is a label: it changes no behaviour,
    // no concurrency semantics and no barrier.
    startupParameters: { application_name: RIVAL_APPLICATION_NAME },
  });

  observer = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 1 },
  });

  hostile = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(HOSTILE_DATABASE), max: 1 },
  });

  capturing = createCapturingPersistence(VERIFIED_DATABASE);

  cluster.closeBeforeShutdown("capturing persistence", () => capturing.shutdown());
  cluster.closeBeforeShutdown("verified persistence", () => persistence.shutdown());
  // The rival pool's closer is **bounded**, because a leaked `withRivalLock` body keeps its
  // client checked out and `pool.end()` waits for checked-out clients — so an unguarded
  // `rival.shutdown()` would hang the whole file's teardown for ever instead of reporting the
  // leak. Found exactly that way: with the helper's `finally` removed, the probe below failed
  // in seconds and then `afterAll` stalled until Vitest's 300s hook timeout.
  //
  // Any rival session still inside a transaction is terminated first, from `persistence.db` —
  // which the cluster closes **after** this one, so it is still available here — and the leak
  // is then reported as a **failure** rather than absorbed. Terminating is what makes teardown
  // finish; throwing is what keeps the leak visible. Only this pool's own sessions are named,
  // by `application_name`, and each is ended by its own `pid`.
  cluster.closeBeforeShutdown("rival persistence", async () => {
    const stray = await sql<{ pid: number }>`
      select pid
        from pg_stat_activity
       where datname = current_database()
         and application_name = ${RIVAL_APPLICATION_NAME}
         and state in ('idle in transaction', 'idle in transaction (aborted)')
    `.execute(persistence.db);

    for (const row of stray.rows) {
      await sql`select pg_terminate_backend(${row.pid})`.execute(persistence.db);
    }

    if (stray.rows.length > 0) {
      // **`pool.end()` is deliberately not awaited here.** Terminating the backend ends the
      // *server* session, but it does not return a **checked-out** client to the pool: `pg`
      // waits for the borrower to release it, and a controlled transaction that was never
      // settled never does. Awaiting `shutdown()` would therefore hang this closer for ever —
      // measured, not assumed, and the reason the first attempt at this guard still stalled.
      //
      // The cluster's own shutdown closes the sockets a moment later, so nothing is left
      // running. What matters is that the leak is reported rather than waited on.
      throw new Error(
        `${stray.rows.length} rival session(s) were still inside a transaction at teardown: a ` +
          `withRivalLock body leaked its transaction instead of settling it`,
      );
    }

    await rival.shutdown();
  });
  cluster.closeBeforeShutdown("observer persistence", () => observer.shutdown());
  cluster.closeBeforeShutdown("hostile persistence", () => hostile.shutdown());

  await sql`alter table listing_revision drop constraint listing_revision_category_check`.execute(
    hostile.db,
  );
  await sql`alter table listing_revision drop constraint listing_revision_rejected_at_check`.execute(
    hostile.db,
  );
  await sql`alter table listing drop constraint listing_category_check`.execute(hostile.db);
}, CLUSTER_TIMEOUT_MS);


/**
 * The bounded lock wait every test-only `DROP TRIGGER` runs under (issue #201, requirement 8).
 *
 * `DROP TRIGGER` needs `ACCESS EXCLUSIVE` on the table, which conflicts with the table-level
 * lock any open transaction holds on `listing`. So a **leaked** rival transaction makes cleanup
 * wait for ever: the run stalls, and whatever assertion actually failed is buried under a
 * timeout instead of reported. That is the hazard this issue exists to close, and leaving
 * cleanup unbounded would leave one instance of it open one level up.
 *
 * `lock_timeout` is `SET LOCAL`, so it lasts exactly as long as this transaction and changes no
 * session or server setting. It is a **cleanup safety bound, not a correctness oracle**: when
 * the helpers release correctly it never fires, and no assertion anywhere depends on a duration.
 * When something does leak, PostgreSQL raises `55P03` immediately and cleanup fails **loudly**,
 * naming the leak instead of hiding it. Proven by mutation: removing the helper's `finally`
 * turns a hang into a named failure.
 */
const CLEANUP_LOCK_TIMEOUT = "5s";

async function dropTestTriggersWithBoundedLockWait(
  statements: readonly string[],
): Promise<void> {
  await persistence.db.transaction().execute(async (trx) => {
    await sql.raw(`set local lock_timeout = '${CLEANUP_LOCK_TIMEOUT}'`).execute(trx);

    for (const statement of statements) {
      await sql.raw(statement).execute(trx);
    }
  });
}

afterEach(async () => {
  // A stranded trigger would silently corrupt every later case, so removal is unconditional
  // rather than left to the test that created it.
  //
  // Under a **bounded** lock wait, so a leaked rival transaction cannot turn cleanup into a
  // hang (issue #201, requirement 8).
  const drops: string[] = [];

  for (const table of ["listing", "listing_revision"] as const) {
    for (const operation of ["update", "delete"] as const) {
      drops.push(`drop trigger if exists cdp_test_suppress_${table}_${operation} on ${table}`);
      drops.push(`drop trigger if exists cdp_test_noop_${table}_${operation} on ${table}`);
    }
  }

  await dropTestTriggersWithBoundedLockWait(drops);
});

describe("approving and applying the sole pending revision (OP-10)", () => {
  it(
    "applies the proposal, returns the applied listing, and removes the proposal",
    async () => {
      const listing = await seedWithProposal();

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok, JSON.stringify(applied)).toBe(true);

      if (!applied.ok) return;

      // The returned value: the proposal's content, the caller's exact instant, and everything
      // else preserved. This is the confirmation of the resulting state `FR-CONF-04` asks for.
      expect(applied.value.content).toEqual(PROPOSED_CONTENT);
      expect(applied.value.timestamps.lastUpdatedAt).toEqual(instant(APPLIED_AT));
      expect(applied.value.id).toEqual(listing.id);
      expect(applied.value.status).toBe("approved");
      expect(applied.value.timestamps.submittedAt).toEqual(listing.timestamps.submittedAt);
      expect(applied.value.publication).toEqual({ value: "publicly_available" });
      expect(applied.value.timestamps.rejectedAt).toBeUndefined();

      // The store agrees, read back through the real read path.
      const reread = await findListingById(persistence.db, listing.id);

      expect(reread.ok).toBe(true);

      if (!reread.ok) return;

      expect(reread.value).toEqual(applied.value);

      // `ADR-017` Q-3: no approved revision row persists, and `DI-11`'s slot is free again.
      expect(await revisionRowCount(listing)).toBe(0);
      expect(await findPendingRevisionByListing(persistence.db, listing.id)).toEqual({
        ok: false,
        error: { code: "PENDING_REVISION_NOT_FOUND" },
      });

      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaves identity, status, submittedAt and publication state untouched in the store",
    async () => {
      // The six columns that must stay `never` on update, checked against the row rather than
      // against the returned value, so a stray write could not hide behind a correct result.
      const listing = await seedWithProposal();
      const before = await storedListingRow(listing);

      expect(
        (
          await approveAndApplyPendingRevision(persistence.db, {
            listingId: listing.id,
            approvedAt: instant(APPLIED_AT),
          })
        ).ok,
      ).toBe(true);

      const after = await storedListingRow(listing);

      expect(after.status).toBe(before.status);
      expect(after.submitted_at).toBe(before.submitted_at);
      expect(after.publication_state).toBe(before.publication_state);

      // And the columns that must change, did.
      expect(after.name).toBe(PROPOSED_CONTENT.name);
      expect(after.category).toBe(PROPOSED_CONTENT.category);
      expect(after.locality).toBe(PROPOSED_CONTENT.locality);
      expect(after.last_updated_at).toBe(APPLIED_AT);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps an unpublished listing unpublished when it applies a revision",
    async () => {
      // `FR-MOD-01`/`FR-MOD-06`: approving a revision is not a republication. Slice B fixed
      // this in the domain, and the adapter must not undo it by rewriting publication columns.
      const listing = approvedListing({
        publication: { value: "unpublished", reason: "Temporarily closed." },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);
      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(true);

      if (!applied.ok) return;

      expect(applied.value.publication).toEqual({
        value: "unpublished",
        reason: "Temporarily closed.",
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "exposes neither the revision identifier nor the base token in its result",
    async () => {
      const listing = approvedListing();
      const revisionId = randomUUID();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);
      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId,
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(true);

      if (!applied.ok) return;

      const serialized = JSON.stringify(applied.value);

      // `DDM-2` is open; nothing here may surface a revision identity.
      expect(serialized).not.toContain(revisionId);
      expect(serialized).not.toContain("baseListingLastUpdatedAt");
      expect(Object.keys(applied.value).sort()).toEqual([
        "content",
        "id",
        "publication",
        "status",
        "timestamps",
      ]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "mutates nothing the caller owns",
    async () => {
      const listing = await seedWithProposal();
      const listingSnapshot = JSON.stringify(listing);
      const at = instant(APPLIED_AT);
      const atSnapshot = JSON.stringify(at);

      await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: at,
      });

      expect(JSON.stringify(listing)).toBe(listingSnapshot);
      expect(JSON.stringify(at)).toBe(atSnapshot);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the refusals OP-10 must keep apart", () => {
  it(
    "refuses a stale proposal arriving alone, proving locking alone is insufficient",
    async () => {
      // No concurrency at all: the listing simply moved on after the work began. `ADR-023` and
      // `ADR-024` both state that serialization or locking **cannot** detect this — only the
      // captured-token comparison can — and this is the case that proves it.
      const listing = await seedWithProposal();

      await sql`
        update listing set last_updated_at = to_timestamp(0)
          + ((${APPROVED_AT + 1}::bigint)::text || ' milliseconds')::interval
         where id = ${listingText(listing)}::uuid
      `.execute(persistence.db);

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({ code: "STALE_LISTING_VERSION" });

      // Nothing saved, nothing partially applied: the listing keeps its content and the
      // proposal is still pending.
      const row = await storedListingRow(listing);

      expect(row.name).toBe(ORIGINAL_CONTENT.name);
      expect(row.last_updated_at).toBe(APPROVED_AT + 1);
      expect(await revisionRowCount(listing)).toBe(1);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each([
    ["equal to", APPROVED_AT],
    ["earlier than", APPROVED_AT - 1],
  ])(
    "refuses an approval instant %s the listing's version as a DI-6 failure, not as stale",
    async (_label, approvedAtMs) => {
      // `ADR-023`'s carried interpretation: a same-millisecond `DI-6` failure is a **distinct
      // timestamp-advancement failure** and must not be mislabelled as stale input. The proposal
      // here is perfectly fresh — its token matches exactly — and the clock reading is what is
      // wrong.
      const listing = await seedWithProposal();

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(approvedAtMs),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({ code: "APPROVAL_INSTANT_NOT_LATER" });
      expect(applied.error.code).not.toBe("STALE_LISTING_VERSION");

      const row = await storedListingRow(listing);

      expect(row.name).toBe(ORIGINAL_CONTENT.name);
      expect(row.last_updated_at).toBe(APPROVED_AT);
      expect(await revisionRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses invalid proposed content rather than publishing it",
    async () => {
      // `docs/09` `OP-10`: approving invalid content would publish it, so the before-approval
      // obligations are re-run. A proposal with no usable contact method fails the contact
      // minimum (`FR-DATA-08`, `OQ-8b`), which applies **before approval** and not at submission
      // — so this content was legitimately storable as a proposal and must still be refused here.
      const listing = await seedWithProposal(persistence.db, {
        name: "Harbour Bakery & Cafe",
        category: "food-drink",
        description: "A small bakery, now with a cafe.",
        locality: "Kinsale",
        country: "IE",
      });

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error.code).toBe("REVISION_CONTENT_INVALID");
      expect(applied.error.code).not.toBe("STALE_LISTING_VERSION");

      const row = await storedListingRow(listing);

      expect(row.name).toBe(ORIGINAL_CONTENT.name);
      expect(await revisionRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a missing listing, and a listing with no proposal, as themselves",
    async () => {
      const absent = approvedListing();

      expect(
        await approveAndApplyPendingRevision(persistence.db, {
          listingId: absent.id,
          approvedAt: instant(APPLIED_AT),
        }),
      ).toEqual({ ok: false, error: { code: "LISTING_NOT_FOUND" } });

      const bare = approvedListing();

      expect((await insertSubmittedListing(persistence.db, bare)).ok).toBe(true);

      expect(
        await approveAndApplyPendingRevision(persistence.db, {
          listingId: bare.id,
          approvedAt: instant(APPLIED_AT),
        }),
      ).toEqual({ ok: false, error: { code: "PENDING_REVISION_NOT_FOUND" } });

      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each(["pending", "rejected"])(
    "refuses a listing whose lifecycle state is %s",
    async (status) => {
      const listing = approvedListing(
        status === "pending"
          ? { status: "pending", publication: undefined }
          : {
              status: "rejected",
              publication: undefined,
              timestamps: {
                submittedAt: instant(APPROVED_AT - 1_000),
                lastUpdatedAt: instant(APPROVED_AT),
                rejectedAt: instant(APPROVED_AT),
              },
            },
      );

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({ code: "LISTING_NOT_APPROVED", status });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses an unusable approval instant before opening a transaction",
    async () => {
      const listing = await seedWithProposal();

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: { epochMilliseconds: 1.5 } as unknown as Instant,
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({ code: "INVALID_APPROVAL_INSTANT" });
      expect(await revisionRowCount(listing)).toBe(1);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports an unreadable stored revision without reporting it as missing",
    async () => {
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          rejected_at, base_listing_last_updated_at
        ) values (
          ${randomUUID()}::uuid, ${listingText(listing)}::uuid, 'pending', 'Hostile',
          'not-a-category', 'Stored despite the domain.', 'Kinsale', 'IE', null,
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
        )
      `.execute(hostile.db);

      const applied = await approveAndApplyPendingRevision(hostile.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({
        code: "STORED_REVISION_UNREADABLE",
        failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
      });
      expect(applied.error.code).not.toBe("PENDING_REVISION_NOT_FOUND");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports an unreadable stored listing without consulting the domain",
    async () => {
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      await sql`
        update listing set category = 'not-a-category'
         where id = ${listingText(listing)}::uuid
      `.execute(hostile.db);

      const applied = await approveAndApplyPendingRevision(hostile.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({
        code: "STORED_LISTING_UNREADABLE",
        failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaks neither row values nor credentials in a storage diagnostic",
    async () => {
      // A `CHECK` violation is the driver error that quotes the row: PostgreSQL attaches
      // `detail: "Failing row contains (…)"` as an **enumerable own property**. The proposal
      // below is storable (the revision category `CHECK` is dropped on this database) but its
      // category is unapproved, so applying it violates the **listing's** own `CHECK`.
      const listing = approvedListing();
      const secret = "9 Harbour Row, Kinsale";

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          administrative_area, phone, phone_designated_public,
          rejected_at, base_listing_last_updated_at
        ) values (
          ${randomUUID()}::uuid, ${listingText(listing)}::uuid, 'pending', 'Harbour Bakery',
          'food-drink', 'A small bakery.', 'Kinsale', 'IE',
          ${secret}, '+353 21 123 4567', false, null,
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
        )
      `.execute(hostile.db);

      // Re-add the listing `CHECK` this database dropped, so the apply violates it. `NOT VALID`
      // because earlier cases deliberately stored rows this narrowed check would reject:
      // existing rows are left alone and the constraint is enforced on **new** writes, which is
      // exactly the surface under attack.
      await sql`
        alter table listing add constraint listing_category_check
          check (category in ('food-drink')) not valid
      `.execute(hostile.db);

      try {
        await sql`
          update listing_revision set category = 'retail-shopping'
           where listing_id = ${listingText(listing)}::uuid
        `.execute(hostile.db);

        const applied = await approveAndApplyPendingRevision(hostile.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        });

        expect(applied.ok).toBe(false);

        if (applied.ok) return;

        expect(applied.error.code).toBe("INTEGRITY_CONFLICT");

        const serialized = JSON.stringify(applied.error);

        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain("Harbour");
        expect(serialized).not.toContain(CLUSTER_PASSWORD);
        expect(serialized).not.toContain("5432");

        // The cause is retained for diagnosis but **non-enumerable**, so it cannot escape
        // through `JSON.stringify`, a spread or a structured logger walking own keys.
        expect(Object.keys(applied.error)).not.toContain("cause");
        expect(JSON.stringify({ ...applied.error })).not.toContain(secret);
      } finally {
        await sql`alter table listing drop constraint listing_category_check`.execute(hostile.db);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the impossible outcomes, forced by test-only triggers", () => {
  it(
    "reports a guarded update that matched no row as a loud protocol failure, not as stale",
    async () => {
      // A `BEFORE UPDATE` trigger returning `NULL` makes PostgreSQL skip the row and report
      // zero affected rows — a state `ADR-024` calls unreachable under the lock. Staleness has
      // already been ruled out by the comparison, so this must **not** be reported as stale.
      const listing = await seedWithProposal();

      const applied = await withSuppressed("listing", "update", () =>
        approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        }),
      );

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error.code).toBe("GUARDED_UPDATE_PROTOCOL_FAILURE");
      expect(applied.error.code).not.toBe("STALE_LISTING_VERSION");

      // Rolled back: nothing applied, proposal intact.
      const row = await storedListingRow(listing);

      expect(row.name).toBe(ORIGINAL_CONTENT.name);
      expect(row.last_updated_at).toBe(APPROVED_AT);
      expect(await revisionRowCount(listing)).toBe(1);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a delete that matched no row as INVALID_LIFECYCLE_STATE, and rolls the update back",
    async () => {
      // `ADR-024`'s classification is authoritative here: zero deleted rows means the revision
      // was no longer pending, which is an **invalid lifecycle state**.
      //
      // This is also the strongest statement of `ADR-017` Q-3's atomicity: the `UPDATE`
      // genuinely succeeded before the `DELETE` failed, so if the transaction did not roll back
      // the listing would now carry applied content **and** still have a pending proposal.
      const listing = await seedWithProposal();

      const applied = await withSuppressed("listing_revision", "delete", () =>
        approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        }),
      );

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error.code).toBe("INVALID_LIFECYCLE_STATE");

      // The whole transaction rolled back — the applied content is gone with it.
      const row = await storedListingRow(listing);

      expect(row.name).toBe(ORIGINAL_CONTENT.name);
      expect(row.category).toBe(ORIGINAL_CONTENT.category);
      expect(row.last_updated_at).toBe(APPROVED_AT);

      // And the proposal is still pending, so `DI-11`'s slot is still occupied.
      expect(await revisionRowCount(listing)).toBe(1);

      const stillPending = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(stillPending.ok).toBe(true);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps the trigger mechanism honest: without it, the same approval succeeds",
    async () => {
      // A fixture that silently stopped working would make the two cases above pass vacuously.
      const listing = await seedWithProposal();

      expect(
        (
          await approveAndApplyPendingRevision(persistence.db, {
            listingId: listing.id,
            approvedAt: instant(APPLIED_AT),
          })
        ).ok,
      ).toBe(true);

      expect(await revisionRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the ADR-024 protocol, under real concurrency", () => {

  it(
    "interleaving 1 — approve versus approve: exactly one applies",
    async () => {
      // The listing lock serializes them, so the *outcome set* is deterministic even though
      // which arrives first is not: one application, one "no pending revision", and no third
      // possibility. Two applications would mean a lost update.
      const listing = await seedWithProposal();

      const [first, second] = await Promise.all([
        approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        }),
        approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT + 1),
        }),
      ]);

      const applied = [first, second].filter((outcome) => outcome.ok);
      const refused = [first, second].filter((outcome) => !outcome.ok);

      expect(applied).toHaveLength(1);
      expect(refused).toHaveLength(1);

      const failure = refused[0];

      if (failure === undefined || failure.ok) return;

      expect(failure.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
      expect(await revisionRowCount(listing)).toBe(0);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 2 — approve versus a simulated rejection: the rejected proposal is not applied",
    async () => {
      // Rejection persistence does **not** exist and must not be created here, so the rival is a
      // test-only SQL participant performing what a rejection would: the proposal leaves the
      // pending state and gains its write-once anchor, while the listing is untouched.
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        await sql`
          update listing_revision
             set state = 'rejected',
                 rejected_at = to_timestamp(0)
                   + ((${APPROVED_AT + 5}::bigint)::text || ' milliseconds')::interval
           where listing_id = ${listingText(listing)}::uuid and state = 'pending'
        `.execute(trx);

        const blocked = approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        });

        await awaitLockWaiter();
        await trx.commit().execute();

        const applied = await blocked;

        expect(applied.ok).toBe(false);

        if (applied.ok) return;

        // The post-lock read sees committed state, so there is nothing pending to approve.
        expect(applied.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });

        const row = await storedListingRow(listing);

        expect(row.name).toBe(ORIGINAL_CONTENT.name);
        expect(await revisionRowCount(listing)).toBe(1);
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 3 — approve versus a simulated administrative edit: stale, not applied",
    async () => {
      // `FR-ADM-04` does not exist yet either, so the rival performs what it would: a content
      // change that advances `last_updated_at`. The approver must then refuse as **stale**,
      // because the proposal was prepared against a version that no longer exists.
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        await sql`
          update listing
             set description = 'Corrected by an administrator.',
                 last_updated_at = to_timestamp(0)
                   + ((${APPROVED_AT + 9}::bigint)::text || ' milliseconds')::interval
           where id = ${listingText(listing)}::uuid
        `.execute(trx);

        const blocked = approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        });

        await awaitLockWaiter();
        await trx.commit().execute();

        const applied = await blocked;

        expect(applied.ok).toBe(false);

        if (applied.ok) return;

        expect(applied.error).toEqual({ code: "STALE_LISTING_VERSION" });

        const row = await storedListingRow(listing);

        expect(row.last_updated_at).toBe(APPROVED_AT + 9);
        expect(row.name).toBe(ORIGINAL_CONTENT.name);
        expect(await revisionRowCount(listing)).toBe(1);
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 4 — the pending revision disappears before the lock is granted",
    async () => {
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        await sql`
          delete from listing_revision where listing_id = ${listingText(listing)}::uuid
        `.execute(trx);

        const blocked = approveAndApplyPendingRevision(persistence.db, {
          listingId: listing.id,
          approvedAt: instant(APPLIED_AT),
        });

        await awaitLockWaiter();
        await trx.commit().execute();

        const applied = await blocked;

        expect(applied.ok).toBe(false);

        if (applied.ok) return;

        expect(applied.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
        expect((await storedListingRow(listing)).name).toBe(ORIGINAL_CONTENT.name);
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 5 — a concurrent OP-6 creation after approval begins cannot double-book",
    async () => {
      // The approver holds the listing lock, so a creation attempt blocks and then decides on
      // committed state: once the proposal has been applied and removed, `DI-11`'s slot is free
      // and the new proposal is admitted — against the **new** listing version, so its own
      // token must be the applied one.
      const listing = await seedWithProposal();

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(true);

      if (!applied.ok) return;

      const next = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: {
          listingId: listing.id,
          state: "pending",
          proposedContent: ORIGINAL_CONTENT,
          baseListingLastUpdatedAt: applied.value.timestamps.lastUpdatedAt,
        } as PendingListingRevision,
      });

      expect(next.ok, JSON.stringify(next)).toBe(true);
      expect(await revisionRowCount(listing)).toBe(1);

      // And one prepared against the *old* version is stale, which is the whole point of the
      // token surviving an application.
      const staleAttempt = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(staleAttempt.ok).toBe(false);

      if (staleAttempt.ok) return;

      // `DI-11` is decided before the token, so the already-pending proposal is what refuses it.
      expect(staleAttempt.error.code).toBe("PENDING_REVISION_ALREADY_EXISTS");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 6 — a domain refusal after the locks are held rolls back genuinely",
    async () => {
      // The locks are taken, the token matches, and the domain then refuses on `DI-6`. Nothing
      // may be written, and no session may be left holding a transaction — a stranded lock here
      // would block every later approver.
      const listing = await seedWithProposal();

      expect(await sessionsInTransaction()).toBe(0);

      const applied = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPROVED_AT),
      });

      expect(applied.ok).toBe(false);

      if (applied.ok) return;

      expect(applied.error).toEqual({ code: "APPROVAL_INSTANT_NOT_LATER" });
      expect(await sessionsInTransaction()).toBe(0);

      // The lock really was released: a rival can take it immediately. The helper rolls its
      // own transaction back, so this site no longer does it by hand.
      await withRivalLock(listing, async () => {});

      expect((await storedListingRow(listing)).last_updated_at).toBe(APPROVED_AT);
      expect(await revisionRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "holds the listing lock through commit, so no rival can interleave between the two writes",
    async () => {
      // The lock's duration is the protocol's load-bearing property: released between the
      // `UPDATE` and the `DELETE`, another participant could observe a listing whose content
      // had been applied while its proposal was still pending — a state `ADR-017` Q-3 forbids.
      const listing = await seedWithProposal();

      expect(
        (
          await approveAndApplyPendingRevision(persistence.db, {
            listingId: listing.id,
            approvedAt: instant(APPLIED_AT),
          })
        ).ok,
      ).toBe(true);

      let observed: readonly { id: string }[] = [];

      await withRivalLock(listing, async (trx) => {
        observed = await trx
          .selectFrom("listing_revision")
          .select("id")
          .where("listing_id", "=", listingText(listing))
          .execute();
      });

      // Whatever a rival sees after the fact, it is never the half-applied state.
      expect(observed).toHaveLength(0);
      expect((await storedListingRow(listing)).name).toBe(PROPOSED_CONTENT.name);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the guarded UPDATE, as PostgreSQL actually received it (issue #197)", () => {
  it(
    "carries the listing identifier and the original base token in its WHERE clause",
    async () => {
      // **The predicate, proved by execution rather than by inference.** `ADR-024` requires the
      // original token *"carried in the guarded listing-write predicate"*, and under the lock
      // its removal changes no outcome — so no behavioural test can see it. What *can* be seen
      // is the statement PostgreSQL was actually given, which Kysely's own `log` reports as
      // compiled SQL plus bound parameters.
      const listing = await seedWithProposal();

      capturing.reset();

      const applied = await approveAndApplyPendingRevision(capturing.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok, JSON.stringify(applied)).toBe(true);

      const updates = listingUpdatesIn(capturing.statements);

      // Exactly one listing write: no no-op update, no second pass, nothing unrelated.
      expect(updates).toHaveLength(1);

      const update = updates[0] as CapturedStatement;
      const shape = guardedUpdateShapeOf(update.sql);

      // The `SET` clause applies the approved instant…
      expect(shape.setsLastUpdatedAt, update.sql).toBe(true);

      // …and the `WHERE` clause guards on both the identity and the token. The clause split is
      // what makes this meaningful: `last_updated_at` appears on both sides, so a search over
      // the whole statement would pass with the predicate gone.
      expect(shape.whereHasListingId, update.sql).toBe(true);
      expect(shape.whereHasLastUpdatedAt, update.sql).toBe(true);
      expect(shape.whereConvertsAnInstant, update.sql).toBe(true);

      // And it writes nothing through a column the chain keeps unwritable.
      expect(shape.setsForbiddenColumn, update.sql).toBeUndefined();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "binds the original persisted base token, not the applied instant, in the predicate",
    async () => {
      // The two instants are deliberately far apart in the fixture, so "the token" and "the new
      // value" cannot be confused: `APPROVED_AT` is what the proposal captured and what the
      // predicate must match; `APPLIED_AT` is what the `SET` clause writes. A predicate built
      // from a *refreshed* token would bind `APPLIED_AT` here and this would fail.
      const listing = await seedWithProposal();

      capturing.reset();

      expect(
        (
          await approveAndApplyPendingRevision(capturing.db, {
            listingId: listing.id,
            approvedAt: instant(APPLIED_AT),
          })
        ).ok,
      ).toBe(true);

      const update = listingUpdatesIn(capturing.statements)[0] as CapturedStatement;
      const whereAt = update.sql.search(/\swhere\s/i);
      const setParameterCount = (update.sql.slice(0, whereAt).match(/\$\d+/g) ?? []).length;

      // Both instants are bound, and the listing identifier with them.
      expect(update.parameters).toContain(APPROVED_AT);
      expect(update.parameters).toContain(APPLIED_AT);
      expect(update.parameters).toContain(listingText(listing));

      // The parameters belonging to the `WHERE` clause are the ones after the `SET` clause's,
      // and they are the identifier followed by the **original** captured token.
      expect(update.parameters.slice(setParameterCount)).toEqual([
        listingText(listing),
        APPROVED_AT,
      ]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "issues exactly one listing update and one revision delete, and nothing else that writes",
    async () => {
      const listing = await seedWithProposal();

      capturing.reset();

      expect(
        (
          await approveAndApplyPendingRevision(capturing.db, {
            listingId: listing.id,
            approvedAt: instant(APPLIED_AT),
          })
        ).ok,
      ).toBe(true);

      const written = capturing.statements.filter((statement) =>
        /^\s*(update|insert|delete)\b/i.test(statement.sql),
      );

      expect(written).toHaveLength(2);
      expect(written[0]?.sql).toMatch(/^update "listing" set/i);
      expect(written[1]?.sql).toMatch(/^delete from "listing_revision"/i);

      // The delete carries all three predicates: identity plus the two defence-in-depth checks.
      const deletion = written[1]?.sql ?? "";

      expect(deletion).toMatch(/"id"\s*=/i);
      expect(deletion).toMatch(/"listing_id"\s*=/i);
      expect(deletion).toMatch(/"state"\s*=/i);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "writes nothing at all when the proposal is stale",
    async () => {
      // The companion claim: a refusal issues no write whatsoever, so the rollback has nothing
      // to undo in the first place.
      const listing = await seedWithProposal();

      await sql`
        update listing set last_updated_at = to_timestamp(0)
          + ((${APPROVED_AT + 1}::bigint)::text || ' milliseconds')::interval
         where id = ${listingText(listing)}::uuid
      `.execute(persistence.db);

      capturing.reset();

      const applied = await approveAndApplyPendingRevision(capturing.db, {
        listingId: listing.id,
        approvedAt: instant(APPLIED_AT),
      });

      expect(applied.ok).toBe(false);

      expect(
        capturing.statements.filter((statement) =>
          /^\s*(update|insert|delete)\b/i.test(statement.sql),
        ),
      ).toEqual([]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps the analyser honest: a predicate-less statement is rejected, not tolerated",
    () => {
      // **The anti-vacuity guard.** An analyser that returned `true` for everything would make
      // the cases above pass for the wrong reason, so it is attacked with the exact statement a
      // predicate-removal mutation produces — identical to the real one except that the `WHERE`
      // clause has lost its token comparison.
      const guarded =
        'update "listing" set "name" = $1, "last_updated_at" = to_timestamp(0) + ' +
        "((($2)::bigint)::text || ' milliseconds')::interval " +
        'where "id" = $3 and "last_updated_at" = to_timestamp(0) + ' +
        "((($4)::bigint)::text || ' milliseconds')::interval";

      const hostile =
        'update "listing" set "name" = $1, "last_updated_at" = to_timestamp(0) + ' +
        "((($2)::bigint)::text || ' milliseconds')::interval " +
        'where "id" = $3';

      const guardedShape = guardedUpdateShapeOf(guarded);

      expect(guardedShape.setsLastUpdatedAt).toBe(true);
      expect(guardedShape.whereHasListingId).toBe(true);
      expect(guardedShape.whereHasLastUpdatedAt).toBe(true);
      expect(guardedShape.whereConvertsAnInstant).toBe(true);

      const hostileShape = guardedUpdateShapeOf(hostile);

      // The `SET` clause still assigns the instant — which is exactly why a whole-statement
      // search would have been fooled — but the guard is gone, and the analyser says so.
      expect(hostileShape.setsLastUpdatedAt).toBe(true);
      expect(hostileShape.whereHasListingId).toBe(true);
      expect(hostileShape.whereHasLastUpdatedAt).toBe(false);
      expect(hostileShape.whereConvertsAnInstant).toBe(false);

      // And a statement that touched a forbidden column is detected too.
      expect(
        guardedUpdateShapeOf('update "listing" set "status" = $1 where "id" = $2')
          .setsForbiddenColumn,
      ).toBe("status");
    },
  );
});

/**
 * The capturing pool's idle-client error handling (issue #201).
 *
 * This file's capturing pool is built directly from `pg` and so sits outside **both** factories
 * that handle pool errors — `connection.ts` for every application pool, and
 * `embedded-cluster.ts` for the migration runner's. Without a listener, a `57P01` raised when
 * the server terminates an idle client becomes an unhandled `EventEmitter` error: Node throws,
 * and the run fails even though every test passed. That is exactly how PR #200's CI failed, at
 * `26 passed`, `1170 passed`, `1 error`.
 *
 * These cases pin the listener's existence and prove the behaviour it buys, using **owned
 * resources only**: one specific backend, identified by its own `pid`, ended through
 * `pg_terminate_backend`. No process is signalled, no database is dropped, and nothing broader
 * than that single backend is touched — which the pid-set comparison below asserts rather than
 * assumes.
 */
describe("the capturing pool's idle-client errors", () => {
  it(
    "attaches an error listener at construction, before any client can become idle",
    async () => {
      const fresh = createCapturingPersistence(VERIFIED_DATABASE);

      try {
        // Asserted before a single query runs: no client has been checked out yet, so this is
        // genuinely "before any client can become idle" and not merely "eventually".
        expect(fresh.pool.listenerCount("error")).toBeGreaterThanOrEqual(1);
        expect(fresh.pool.totalCount).toBe(0);
        expect(fresh.idlePoolErrors).toEqual([]);
      } finally {
        await fresh.shutdown();
      }

      // The pool this file actually uses, for the same reason.
      expect(capturing.pool.listenerCount("error")).toBeGreaterThanOrEqual(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "survives the server terminating one owned idle backend, and stays governed",
    async () => {
      // The file-level `capturing` pool shares this label and is torn down by the cluster
      // helper, not here — so residue is measured as a **return to baseline**, not as zero.
      // Labelled distinctly, so the assertions after shutdown are about **this** pool and
      // not about every pool in the file that happens to share a name (issue #223).
      const owned = createCapturingPersistence(
        VERIFIED_DATABASE,
        OWNED_CAPTURE_APPLICATION_NAME,
      );
      /** Every backend this pool owns, enumerated at the latest possible point below. */
      let ownedPids: readonly number[] = [];
      /** The suite-wide pool's backends, which must be untouched by this pool's shutdown. */
      let suiteWidePids: readonly number[] = [];

      try {
        // Establish one connection and learn **its** backend pid from the backend itself.
        const pidRows = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
          owned.db,
        );
        const ownedPid = pidRows.rows[0]?.pid;

        expect(typeof ownedPid).toBe("number");

        if (typeof ownedPid !== "number") return;

        // The query is done, so that client is back in the pool and idle — the precise state
        // the production comment describes.
        expect(owned.pool.idleCount).toBeGreaterThanOrEqual(1);

        const before = await livePids();

        expect(before).toContain(ownedPid);

        // Registered **before** the termination, so the wait is event-driven rather than polled.
        const delivered = nextPoolError(owned.pool);

        // Exactly one backend, named by the pid it reported for itself. This is the only
        // termination in this suite, and it is scoped to a connection this test owns.
        // Compiled first so the statement-level proof below reads the **same artifact** the
        // server then runs — not a second compilation that could drift from it.
        const termination = sql<{ terminated: boolean }>`
          select pg_terminate_backend(${ownedPid}, ${TERMINATION_WAIT_MS}) as terminated
        `.compile(observer.db);
        const shape = terminationShape(termination);

        // One call, the two-argument form, the owned pid first and a positive ceiling second.
        // Both values are **bound parameters**, so nothing is interpolated into SQL text.
        expect(shape.calls).toBe(1);
        expect(shape.normalized).toBe("select pg_terminate_backend($1, $2) as terminated");
        expect(shape.placeholders).toBe(2);
        expect(shape.parameters).toEqual([ownedPid, TERMINATION_WAIT_MS]);
        expect(shape.parameters[1]).toBe(5_000);
        expect(TERMINATION_WAIT_MS).toBeGreaterThan(0);

        // The analyser's **positive control**: the defaulted one-argument call this replaced
        // must not satisfy the assertions above, or they would pass whatever was written. It is
        // only ever compiled — never executed — so no second backend is signalled.
        const defaulted = terminationShape(
          sql<{ terminated: boolean }>`
            select pg_terminate_backend(${ownedPid}) as terminated
          `.compile(observer.db),
        );

        expect(defaulted.placeholders).toBe(1);
        expect(defaulted.parameters).toEqual([ownedPid]);
        expect(defaulted.normalized).not.toBe(shape.normalized);

        // The listener must already be attached **before** anything is terminated: the factory
        // attaches one (issue #201) and `nextPoolError` the second. Registering either of them
        // after this point would leave the `57P01` with nowhere to go, and this reads the count
        // rather than trusting the order the lines happen to appear in.
        expect(owned.pool.listenerCount("error")).toBe(2);

        // Both statements run through one tracer, so the **order they really executed in** is
        // observable — not inferred from where the lines sit in this function.
        const trace = observerExecutionTrace();
        const ended = await trace.run("terminate", termination);

        // **Now** a completion proof rather than a send receipt: with a positive timeout the
        // function returns only once the backend has actually terminated. Every assertion
        // below therefore reads state the server has already finished changing, and the
        // `pg_stat_activity` check needs no wait of its own.
        expect(ended.rows[0]?.terminated).toBe(true);

        // The event reached the pool's own listener — not the process. If the listener were
        // absent, Node would have thrown before this line could run.
        const error = await delivered;

        expect((error as { readonly code?: unknown }).code).toBe("57P01");
        expect(owned.idlePoolErrors.length).toBeGreaterThanOrEqual(1);

        // **Only** the owned backend went. Every other session that was live before is still
        // live, which is what makes "no broad termination" a proof rather than a promise.
        const after = (await trace.run("inspect", livePidsQuery())).rows.map((row) => row.pid);

        // Deterministic ordering: the inspection cannot have begun until the terminating
        // statement had **settled**. Starting it earlier — the mutation that recreates the
        // original race class — reorders these events and fails here regardless of host speed.
        expect(trace.events).toEqual([
          "terminate:start",
          "terminate:end",
          "inspect:start",
          "inspect:end",
        ]);

        // And it was terminated **exactly once**: a second execution appends another pair.
        expect(trace.events.filter((event) => event === "terminate:start")).toHaveLength(1);

        expect(after).not.toContain(ownedPid);
        expect(before.filter((pid) => pid !== ownedPid).every((pid) => after.includes(pid))).toBe(
          true,
        );

        // The pool remains governed: it opens a replacement on demand, and that replacement is
        // configured exactly as before — the `timestamptz` overrides still deliver epoch
        // milliseconds rather than a `Date` (`ADR-022`), so a lost client cannot silently
        // downgrade the boundary.
        const roundTrip = await sql<{ at: number }>`
          select to_timestamp(0)
            + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval as at
        `.execute(owned.db);

        expect(roundTrip.rows[0]?.at).toBe(APPROVED_AT);
        expect(roundTrip.rows[0]?.at).not.toBeInstanceOf(Date);

        // Nothing was retried or recovered on our behalf: a *failing* query still fails.
        await expect(sql`select 1 / 0`.execute(owned.db)).rejects.toThrow();

        // **Enumerated here, last.** Every connection this pool will ever open already exists —
        // including the replacement client it opened after its first backend was terminated — so
        // the set is complete, and it is captured before anything shuts anything down.
        const reported = await sql<{ name: string }>`
          select current_setting('application_name') as name
        `.execute(owned.db);

        // The server agrees about the identity being asserted; the label is not merely requested.
        expect(reported.rows[0]?.name).toBe(OWNED_CAPTURE_APPLICATION_NAME);

        // The suite-wide pool opens its connections lazily, so whether it has one depends on
        // which earlier tests ran — a focused run leaves it with none. Using it here makes its
        // liveness a fact this test establishes rather than a side effect of test order, which
        // is the same class of dependency issue #223 exists to remove.
        await sql`select 1`.execute(capturing.db);

        ownedPids = await pidsNamed(OWNED_CAPTURE_APPLICATION_NAME);
        suiteWidePids = await pidsNamed(CAPTURE_APPLICATION_NAME);

        // Not vacuous: there is something to disappear. `max: 2` permits more than one, so the
        // whole set is taken rather than a single pid assumed.
        expect(ownedPids.length).toBeGreaterThanOrEqual(1);

        // The suite-wide pool is live and is a **different** set of backends, which is the
        // distinction the shared label could not make.
        expect(suiteWidePids.length).toBeGreaterThanOrEqual(1);
        expect(ownedPids.filter((pid) => suiteWidePids.includes(pid))).toEqual([]);

        // And the label predicate is necessary: identity by database alone over-matches, because
        // every pool in this file — and the observer asking the question — shares the database.
        expect((await livePids()).length).toBeGreaterThan(ownedPids.length);
      } finally {
        await owned.shutdown();
      }

      // `shutdown()` resolved, and the pool itself reports it holds nothing — asserted **here**,
      // before the settlement wait. Without this the shutdown guarantee would not be
      // load-bearing: an idle client disappears on its own once the pool's idle timeout
      // elapses, so a wait on server state alone cannot tell *shut down* from *timed out*, and
      // a mutation that skipped the shutdown entirely passed. This is a client-side fact used
      // to attribute the disappearance, never a substitute for the server-side proof below.
      expect(owned.pool.totalCount).toBe(0);

      // Shutdown has resolved, which is a **client-side** completion. The server dropping these
      // backends is a separate event, so the wait below is on the server's own report of
      // **exactly these pids**, under a hard monotonic ceiling, and it throws a named sentinel
      // rather than passing if they never go (issue #223).
      await awaitBackendsGone(ownedPids);

      // The load-bearing postcondition, asserted once on a fresh observation after settlement.
      expect(await livePidsAmong(ownedPids)).toEqual([]);

      // Nothing carrying this pool's label survives at all.
      expect(await pidsNamed(OWNED_CAPTURE_APPLICATION_NAME)).toEqual([]);

      // Separately: the suite-wide pool, which shares this file but not the label, is untouched —
      // so a healthy neighbour can never be reported as this pool's residue.
      expect(await pidsNamed(CAPTURE_APPLICATION_NAME)).toEqual(suiteWidePids);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "enumerates every backend such a pool owns, not only the first",
    async () => {
      // `max: 2` permits more than one backend, so the shutdown proof above takes a **set**
      // rather than assuming a single pid. This case makes that set observable: two connections
      // are held at once — deterministically, by nesting `connection()`, with no sleep and no
      // concurrency guesswork — so the enumeration has two pids to find (issue #223).
      const pair = createCapturingPersistence(
        VERIFIED_DATABASE,
        OWNED_CAPTURE_APPLICATION_NAME,
      );
      let held: readonly number[] = [];

      try {
        await pair.db.connection().execute(async (first) => {
          await sql`select 1`.execute(first);

          // The outer connection is checked out, so this one cannot be the same client.
          await pair.db.connection().execute(async (second) => {
            await sql`select 1`.execute(second);

            // Established, not assumed: the suite-wide pool's connections are lazy.
            await sql`select 1`.execute(capturing.db);

            held = await pidsNamed(OWNED_CAPTURE_APPLICATION_NAME);
          });
        });

        expect(held).toHaveLength(2);
        expect(new Set(held).size).toBe(2);

        // Still disjoint from the suite-wide pool, which the shared label could not tell apart.
        const suiteWide = await pidsNamed(CAPTURE_APPLICATION_NAME);

        expect(held.filter((pid) => suiteWide.includes(pid))).toEqual([]);
      } finally {
        await pair.shutdown();
      }

      // **Both** are gone, not just the first one found — awaited on the server's own report
      // under the same bound, then asserted once.
      await awaitBackendsGone(held);

      expect(await livePidsAmong(held)).toEqual([]);
      expect(await pidsNamed(OWNED_CAPTURE_APPLICATION_NAME)).toEqual([]);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  /** A short ceiling for the exhaustion cases, so a bound can be proved without a 30s test. */
  const PROBE_CEILING_MS = 1_000;

  it(
    "completes for a backend that is live when the wait is started and shut down during it",
    async () => {
      const transient = createCapturingPersistence(
        VERIFIED_DATABASE,
        OWNED_CAPTURE_APPLICATION_NAME,
      );
      const pid = (
        await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transient.db)
      ).rows[0]?.pid as number;

      // Live at the moment the wait is started.
      expect(await livePidsAmong([pid])).toEqual([pid]);

      const settling = awaitBackendsGone([pid]);

      await transient.shutdown();
      await expect(settling).resolves.toBeUndefined();
      expect(await livePidsAmong([pid])).toEqual([]);

      // **What this does and does not prove.** It proves the wait completes rather than hanging
      // when a live target is shut down while it runs. It does *not* force the wait to observe the
      // pid as present first: the first observation is asynchronous and may land after the
      // shutdown, so the loop may never iterate.
      //
      // What *is* deterministic: the exhaustion case below proves the observations are
      // **repeated** — a target that never goes keeps the loop running to its ceiling and is
      // named in the failure. It does **not** prove each observation is **fresh**: an
      // implementation that reused one snapshot would behave identically there, and a mutation
      // that did exactly that survived. Freshness rests on construction instead — one
      // autocommit statement per observation, on an observer that holds no transaction — and on
      // review, not on a test. Forcing it would need a timed stimulus, which is not authorized
      // and would be worse evidence than the structure.
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "completes immediately for an already-absent backend, with no minimum delay",
    async () => {
      const transient = createCapturingPersistence(
        VERIFIED_DATABASE,
        OWNED_CAPTURE_APPLICATION_NAME,
      );
      const pid = (
        await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transient.db)
      ).rows[0]?.pid as number;

      await transient.shutdown();
      await awaitBackendsGone([pid]);

      // Settled before the wait was even called, so the success path waits out no interval at all.
      expect(await livePidsAmong([pid])).toEqual([]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "requires every target backend to go, and names the ones that remain on exhaustion",
    async () => {
      // One backend that will go, one that will not: the suite-wide pool's own, which this file
      // keeps alive on purpose. A wait that accepted partial disappearance would pass here.
      await sql`select 1`.execute(capturing.db);

      const staying = await pidsNamed(CAPTURE_APPLICATION_NAME);
      const transient = createCapturingPersistence(
        VERIFIED_DATABASE,
        OWNED_CAPTURE_APPLICATION_NAME,
      );
      const goingPid = (
        await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transient.db)
      ).rows[0]?.pid as number;

      await transient.shutdown();
      expect(staying.length).toBeGreaterThanOrEqual(1);

      const stayingPid = staying[0] as number;
      const failure = await awaitBackendsGone([goingPid, stayingPid], PROBE_CEILING_MS).then(
        () => undefined,
        (error: unknown) => error,
      );

      // Exhaustion throws — it can never be converted into success — and reports safely.
      expect(failure).toBeInstanceOf(BackendSettlementExhausted);
      expect((failure as Error).name).toBe("BackendSettlementExhausted");
      expect((failure as BackendSettlementExhausted).remaining).toEqual([stayingPid]);
      expect((failure as BackendSettlementExhausted).ceilingMs).toBe(PROBE_CEILING_MS);
      expect((failure as Error).message).toContain(String(stayingPid));
      expect((failure as Error).message).not.toContain("password");

      // The one that did go is gone; only the live neighbour kept the wait from completing.
      expect(await livePidsAmong([goingPid])).toEqual([]);

      // And the ceiling the real callers use is finite and positive.
      expect(Number.isFinite(EXIT_WAIT_CEILING_MS)).toBe(true);
      expect(EXIT_WAIT_CEILING_MS).toBeGreaterThan(0);
      expect(EXIT_POLL_INTERVAL_MS).toBeGreaterThan(0);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

/**
 * `withRivalLock`'s failure paths (issue #201).
 *
 * The helper's whole purpose is the **unhappy** path, which no interleaving above exercises:
 * those all succeed, and a leak only appears when something throws. Each case below proves one
 * release guarantee through owned sessions and `pg_stat_activity`, with no sleep and no duration
 * in any assertion.
 */
describe("the rival-lock helper's release guarantees", () => {
  const RIVAL = RIVAL_APPLICATION_NAME;

  /** No rival transaction open, no rival session blocked. The invariant every case asserts. */
  async function rivalIsQuiet(): Promise<void> {
    expect(await sessionsInTransaction()).toBe(0);
    expect(await blockedSessionsNamed(RIVAL)).toBe(0);
  }

  /**
   * Run `withRivalLock` as a **probe**, and release whatever it failed to release.
   *
   * A probe that asserts the helper settles its transaction must survive the helper *not*
   * settling it. A never-settled controlled transaction keeps its client **checked out**, and
   * `pg`'s `pool.end()` waits for the borrower to release it — terminating the backend does not
   * hand it back. So a failing probe would otherwise stall the file's teardown for ever and bury
   * its own assertion, which is the exact hazard this issue closes.
   *
   * The captured state is read **before** any cleanup, so what is asserted is the helper's own
   * behaviour and not this function's repair. The repair is reported too: if cleanup had to step
   * in, `leakedBeyondHelper` says so.
   */
  async function probeRivalLock(
    listing: Listing,
    body: (trx: ControlledTransaction<ListingDatabase>) => Promise<void>,
    seams?: { release?: (trx: ControlledTransaction<ListingDatabase>) => Promise<void> },
  ): Promise<{
    readonly thrown: unknown;
    readonly settledOnReturn: boolean;
    readonly leakedBeyondHelper: boolean;
  }> {
    let seen: ControlledTransaction<ListingDatabase> | undefined;
    let thrown: unknown;
    let threw = false;

    try {
      await withRivalLock(
        listing,
        async (trx) => {
          seen = trx;
          await body(trx);
        },
        seams ?? {},
      );
    } catch (error) {
      threw = true;
      thrown = error;
    }

    // Read before repairing: this is the helper's behaviour, not the repair's.
    const settledOnReturn =
      seen === undefined || seen.isCommitted === true || seen.isRolledBack === true;
    const leakedBeyondHelper = !settledOnReturn;

    if (seen !== undefined && seen.isCommitted === false && seen.isRolledBack === false) {
      await seen.rollback().execute();
    }

    return { thrown: threw ? thrown : undefined, settledOnReturn, leakedBeyondHelper };
  }

  /** A listing whose identifier the `uuid` column cannot accept, so acquisition fails. */
  function unusableListing(): Listing {
    return { ...approvedListing(), id: listingIdOf("not-a-uuid") };
  }

  it(
    "settles and releases on a normal body",
    async () => {
      const listing = await seedWithProposal();

      const probe = await probeRivalLock(listing, async () => {
        // While the body runs, the lock is genuinely held.
        expect(await sessionsInTransaction()).toBe(1);
      });

      expect(probe.thrown).toBeUndefined();
      // Settled **before** the helper returned, not eventually. Read before any repair.
      expect(probe.settledOnReturn).toBe(true);
      expect(probe.leakedBeyondHelper).toBe(false);
      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "rolls back and releases when the body throws, and the body's failure is what propagates",
    async () => {
      const listing = await seedWithProposal();

      const probe = await probeRivalLock(listing, async () => {
        throw new Error("the body failed on purpose");
      });

      // The body's failure is what propagates, unchanged.
      expect((probe.thrown as Error | undefined)?.message).toBe("the body failed on purpose");
      // …and the helper itself rolled back; cleanup had nothing to repair.
      expect(probe.settledOnReturn).toBe(true);
      expect(probe.leakedBeyondHelper).toBe(false);

      await rivalIsQuiet();

      // The lock is genuinely free: a second rival takes it without blocking.
      await withRivalLock(listing, async () => {});
      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "releases the checked-out client when lock acquisition itself fails",
    async () => {
      // The `SELECT … FOR UPDATE` is rejected by the server, so the transaction is open and
      // aborted with the client still checked out — the case that leaks if acquisition sits
      // outside the `try`.
      let bodyRan = false;

      await expect(
        withRivalLock(unusableListing(), async () => {
          bodyRan = true;
        }),
      ).rejects.toThrow();

      // Setup failed before the body: it never ran, and nothing leaked.
      expect(bodyRan).toBe(false);
      await rivalIsQuiet();

      // The pool is still usable afterwards, which a leaked checkout would eventually prevent.
      const listing = await seedWithProposal();

      await withRivalLock(listing, async () => {});
      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports the body failure first and the cleanup failure too, hiding neither",
    async () => {
      const listing = await seedWithProposal();

      const thrown = await withRivalLock(
        listing,
        async () => {
          throw new Error("the body failed on purpose");
        },
        {
          release: async (open) => {
            // Settle it honestly first, so the suppressed rollback cannot leak a held lock,
            // then fail — the failure is what this case is about, not the leak.
            await open.rollback().execute();
            throw new Error("releasing the rival lock failed on purpose");
          },
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      // The scheme `embedded-cluster.ts` established: both failures, the body's first.
      expect(thrown).toBeInstanceOf(AggregateError);

      const aggregate = thrown as AggregateError;

      expect(aggregate.errors).toHaveLength(2);
      expect((aggregate.errors[0] as Error).message).toBe("the body failed on purpose");
      expect((aggregate.errors[1] as Error).message).toBe(
        "releasing the rival lock failed on purpose",
      );

      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a cleanup failure on its own when the body succeeded",
    async () => {
      const listing = await seedWithProposal();

      await expect(
        withRivalLock(listing, async () => {}, {
          release: async (open) => {
            await open.rollback().execute();
            throw new Error("releasing the rival lock failed on purpose");
          },
        }),
      ).rejects.toThrow("releasing the rival lock failed on purpose");

      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "does not return before the rival transaction has settled, even when the body commits",
    async () => {
      const listing = await seedWithProposal();

      const probe = await probeRivalLock(listing, async (trx) => {
        await trx.commit().execute();
      });

      expect(probe.thrown).toBeUndefined();
      expect(probe.settledOnReturn).toBe(true);
      expect(probe.leakedBeyondHelper).toBe(false);
      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaves trigger cleanup free to run, rather than blocked behind a held lock",
    async () => {
      // The concrete consequence of a leak: `afterEach` drops a trigger on `listing`, which
      // needs `ACCESS EXCLUSIVE` and would block for ever behind a rival's row lock. Proving
      // the DDL completes immediately after a *failed* body is proving the hang cannot recur.
      const listing = await seedWithProposal();

      const probe = await probeRivalLock(listing, async () => {
        throw new Error("the body failed on purpose");
      });

      expect((probe.thrown as Error | undefined)?.message).toBe("the body failed on purpose");
      expect(probe.leakedBeyondHelper).toBe(false);

      await sql`
        create or replace function cdp_test_noop() returns trigger
          language plpgsql as $$ begin return new; end $$
      `.execute(persistence.db);
      await sql`
        create trigger cdp_test_noop_listing_update before update on listing
          for each row execute function cdp_test_noop()
      `.execute(persistence.db);
      await sql`drop trigger cdp_test_noop_listing_update on listing`.execute(persistence.db);

      await rivalIsQuiet();
    },
    CLUSTER_TIMEOUT_MS,
  );
});
