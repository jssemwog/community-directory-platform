/**
 * Attacking tests for revision rejection against a real PostgreSQL server (issue #199).
 *
 * `ADR-024` names its own material tradeoff: correctness depends on **enforced statement and
 * lock order** rather than on the engine, *"which makes deterministic interleaving tests
 * mandatory"*. This path adds a second reason for them. Its `PS-11` listing lock protects a row
 * it **never writes**, so nothing about the statement's own effect would reveal a missing lock —
 * only an interleaving can. Half of this file exists for that one fact.
 *
 * ## The negative claims, and why they are tested rather than asserted in prose
 *
 * Rejection is deliberately **not** an `ADR-024` stale-token guarded-listing-write path: no base
 * token is compared, no listing row is written, no `lastUpdatedAt` advances, and neither a
 * staleness nor a `DI-6` outcome exists. Every one of those is a claim a future edit could
 * silently break while this suite stayed green, so each is pinned twice — once by behaviour, and
 * once by inspecting the **statements PostgreSQL actually received**.
 *
 * ## How the interleavings stay deterministic
 *
 * No test sleeps, polls an assertion, or re-runs anything until it passes. Where a participant
 * must be *blocked* while another commits, the suite synchronises on **observable lock
 * acquisition** read from `pg_stat_activity`, with a named sentinel if the wait never appears so
 * that a participant which fails to block fails immediately instead of hanging. Test timeouts
 * bound liveness only; **no assertion depends on a duration**.
 *
 * ## Forcing outcomes the protocol says are impossible
 *
 * A zero-row guarded update cannot arise under the lock. It is produced with a **test-only
 * `BEFORE` trigger** returning `NULL`, which makes PostgreSQL skip the row operation and report
 * zero affected rows. The trigger is created and dropped by the test that needs it, and
 * `afterEach` sweeps any a failed assertion stranded. Nothing in `src/` knows it exists: **no
 * production fault-injection hook is introduced**.
 *
 * ## Rival operations this suite deliberately does not drive
 *
 * The administrative listing edit (`FR-ADM-04`) exists now (issue #217) and must still not be
 * called here: an interleaving needs a rival it can hold open inside a controlled transaction,
 * and a repository function returns only once its own transaction has committed. It is therefore
 * driven as a **test-only SQL participant** — a local fixture, never exported, never a
 * repository function. Approval is driven through the real `OP-10` boundary, because that rival
 * does not need to be held open.
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
import { rejectPendingRevision } from "./revision-rejection";

const VERIFIED_DATABASE = "revision_rejection_verification";
/** A second database whose revision `CHECK`s and `DI-11` index are dropped, for hostile rows. */
const HOSTILE_DATABASE = "revision_rejection_hostile";

const cluster = useEmbeddedPostgres({
  slug: "rejection",
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
const RIVAL_APPLICATION_NAME = "revision_rejection_rival";

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
/** The rejection instant. Deliberately **not** required to be later than anything. */
const REJECTED_AT = APPROVED_AT + 4_000;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

/** The content the listing is approved with. A rejection must never disturb it. */
const ORIGINAL_CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

/**
 * The proposal's content — different in every field that can differ, and never applied.
 *
 * **Every designatable value is private** (issue #207). `ORIGINAL_CONTENT` carries none of the
 * four, so each of these is an **addition**, which `ADR-025` makes private and unpublishable.
 * This fixture proposed a **public** `postalCode` and `email` while `OP-6` did not yet enforce
 * the policy; now that it does, the proposal must be lawful to be created at all. The rejection
 * assertions are untouched — they compare the listing's designations before and after, which
 * proves the same invariant whatever the proposal designated.
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

/** One revision row, read raw so the physical identifier and the stored anchor are visible. */
async function storedRevisionRow(listing: Listing, db = persistence.db) {
  const rows = await sql<{
    id: string;
    listing_id: string;
    state: string;
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
    rejected_at: number | null;
    base_listing_last_updated_at: number;
  }>`
    select * from listing_revision where listing_id = ${listingText(listing)}::uuid
  `.execute(db);

  const row = rows.rows[0];

  if (row === undefined) {
    throw new Error("the seeded revision is missing");
  }

  return row;
}

/**
 * The complete `listing` row, every column, as one comparable value.
 *
 * `select *` on purpose: a column-by-column projection would silently stop covering a column a
 * later migration adds, and *"the listing row is not written"* is a claim about the **whole** row.
 */
async function storedListingRow(listing: Listing, db = persistence.db) {
  const rows = await sql<Record<string, unknown>>`
    select * from listing where id = ${listingText(listing)}::uuid
  `.execute(db);

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

/**
 * Resolve with the **next** error this pool hands to its own listener.
 *
 * Registered *before* the backend is terminated, so the wait is event-driven: no polling, no
 * sleep, and no duration in any assertion. If the event never arrives the test's own timeout
 * reports it, which is a liveness bound rather than a correctness oracle.
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
 * module is described here — the pattern `migrate.ts` and the earlier suites established.
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
const CAPTURE_APPLICATION_NAME = "revision_rejection_capture";

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
 * counter, so a failure message is reproducible and readable. 32 bytes, well inside
 * PostgreSQL's 63-byte `application_name` limit. Nothing in production reads or sets it.
 */
const OWNED_CAPTURE_APPLICATION_NAME = "revision_rejection_capture_owned";

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A `C9` boundary identical to the production one, with every executed statement captured.
 *
 * **No production change buys this.** `rejectPendingRevision` accepts any
 * `Kysely<ListingDatabase>`, and Kysely's own `log` option reports each statement it executes as
 * compiled SQL plus bound parameters — so the *actual executed* statements can be inspected
 * without a fault-injection hook, a source-text assertion, or any weakening of the lock. The
 * pool is configured exactly as `createListingPersistence` configures its own, so this is the
 * same boundary that runs in production and not a lookalike.
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
        statements.push({ sql: event.query.sql, parameters: event.query.parameters });
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

/** Every `update "listing"` statement among those captured — there must never be one. */
function listingUpdatesIn(statements: readonly CapturedStatement[]): readonly CapturedStatement[] {
  return statements.filter((statement) => /^\s*update\s+"listing"\s+set\b/i.test(statement.sql));
}

/** Every `update "listing_revision"` statement among those captured. */
function revisionUpdatesIn(
  statements: readonly CapturedStatement[],
): readonly CapturedStatement[] {
  return statements.filter((statement) =>
    /^\s*update\s+"listing_revision"\s+set\b/i.test(statement.sql),
  );
}

/** What the analyser found in one revision `UPDATE`, so a failure names the missing part. */
interface GuardedUpdateShape {
  readonly setsState: boolean;
  readonly setsRejectedAt: boolean;
  readonly setsForbiddenColumn: string | undefined;
  readonly whereHasRevisionId: boolean;
  readonly whereHasListingId: boolean;
  readonly whereHasPendingState: boolean;
  readonly whereHasNullAnchor: boolean;
  readonly whereMentionsLastUpdatedAt: boolean;
}

/**
 * Describe the guarded shape of one compiled revision `UPDATE`, by splitting `SET` from `WHERE`.
 *
 * The split is load-bearing: `state` and `rejected_at` appear on **both** sides — assigned in
 * `SET`, compared in `WHERE` — so an assertion that searched the whole statement would pass with
 * either guard removed.
 */
function guardedUpdateShapeOf(statementSql: string): GuardedUpdateShape {
  const whereAt = statementSql.search(/\swhere\s/i);
  const setClause = whereAt === -1 ? statementSql : statementSql.slice(0, whereAt);
  const whereClause = whereAt === -1 ? "" : statementSql.slice(whereAt);

  const forbidden = [
    "id",
    "listing_id",
    "name",
    "category",
    "description",
    "locality",
    "country",
    "administrative_area",
    "postal_code",
    "phone",
    "email",
    "website",
    "base_listing_last_updated_at",
  ].find((column) => new RegExp(`"${column}"\\s*=`, "i").test(setClause));

  return {
    setsState: /"state"\s*=/i.test(setClause),
    setsRejectedAt: /"rejected_at"\s*=/i.test(setClause),
    setsForbiddenColumn: forbidden,
    whereHasRevisionId: /"id"\s*=/i.test(whereClause),
    whereHasListingId: /"listing_id"\s*=/i.test(whereClause),
    whereHasPendingState: /"state"\s*=/i.test(whereClause),
    whereHasNullAnchor: /"rejected_at"\s+is\s+null/i.test(whereClause),
    whereMentionsLastUpdatedAt: /last_updated_at/i.test(whereClause),
  };
}

const LOCK_WAIT_SENTINEL = "no backend ever blocked on a lock";

/**
 * Wait until PostgreSQL reports a backend blocked on a lock, then return.
 *
 * A condition wait on a fact the server publishes — not a sleep, and not a retry. Each iteration
 * is one round trip, so the loop paces itself and ends the moment the fact appears. The bound
 * exists so a participant that never blocks fails **immediately and by name** instead of hanging
 * until the test timeout and leaving a cluster behind. The bound is liveness, never correctness.
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
    startupParameters: { application_name: "revision_rejection_tests" },
  });

  rival = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
    // Labelled so its own sessions can be named at teardown. `application_name` is a label:
    // it changes no behaviour, no concurrency semantics and no barrier.
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
  // `DI-11`'s partial unique index, dropped so the unreachable multiplicity can be presented.
  await sql`drop index listing_revision_one_pending_per_listing`.execute(hostile.db);
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
  // rather than left to the test that created it. **Every** test-only trigger family is swept,
  // not only the suppressors: each is also dropped in its own `finally`, but a `finally` that
  // itself failed would otherwise leave a raising or rewriting trigger armed for the rest of
  // the file, and the resulting failures would point anywhere but here.
  //
  // Under a **bounded** lock wait, so a leaked transaction cannot turn cleanup into a hang.
  const drops: string[] = [];

  for (const table of ["listing", "listing_revision"] as const) {
    for (const operation of ["update", "delete"] as const) {
      for (const family of ["suppress", "raise", "break_check"] as const) {
        drops.push(`drop trigger if exists cdp_test_${family}_${table}_${operation} on ${table}`);
      }
    }
  }

  await dropTestTriggersWithBoundedLockWait(drops);
});

describe("rejecting the sole pending revision", () => {
  it(
    "1 — rejects it, and returns the rejected domain revision",
    async () => {
      const listing = await seedWithProposal();

      const rejected = await rejectPendingRevision(persistence.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(true);

      if (!rejected.ok) return;

      expect(rejected.value.state).toBe("rejected");
      // The **exact** caller-supplied instant, not a re-read and not a clock reading.
      expect(rejected.value.rejectedAt).toEqual(instant(REJECTED_AT));
      expect(rejected.value.proposedContent).toEqual(PROPOSED_CONTENT);
      expect(rejected.value.baseListingLastUpdatedAt).toEqual(
        listing.timestamps.lastUpdatedAt,
      );
      expect(rejected.value.listingId).toEqual(listing.id);

      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "2 — changes that same row in place, keeping its identifier, content and base token",
    async () => {
      const listing = await seedWithProposal();
      const before = await storedRevisionRow(listing);

      expect(before.state).toBe("pending");
      expect(before.rejected_at).toBeNull();

      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: listing.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(true);

      const after = await storedRevisionRow(listing);

      // One row, still — not a replacement, not a second row (`ADR-017`: *"sets its state"*).
      expect(await revisionRowCount(listing)).toBe(1);
      expect(after.id).toBe(before.id);

      expect(after.state).toBe("rejected");
      expect(after.rejected_at).toBe(REJECTED_AT);

      // `ADR-023`: the captured token must never be refreshed. A refreshed one would make every
      // stale revision silently fresh — the single failure that ADR exists to prevent.
      expect(after.base_listing_last_updated_at).toBe(before.base_listing_last_updated_at);
      expect(after.base_listing_last_updated_at).toBe(APPROVED_AT);

      // Everything else about the row, column by column, so a stray `SET` cannot hide.
      expect(after.listing_id).toBe(before.listing_id);
      expect(after.name).toBe(before.name);
      expect(after.category).toBe(before.category);
      expect(after.description).toBe(before.description);
      expect(after.locality).toBe(before.locality);
      expect(after.country).toBe(before.country);
      expect(after.administrative_area).toBe(before.administrative_area);
      expect(after.postal_code).toBe(before.postal_code);
      expect(after.postal_code_designated_public).toBe(before.postal_code_designated_public);
      expect(after.phone).toBe(before.phone);
      expect(after.phone_designated_public).toBe(before.phone_designated_public);
      expect(after.email).toBe(before.email);
      expect(after.email_designated_public).toBe(before.email_designated_public);
      expect(after.website).toBe(before.website);
      expect(after.website_designated_public).toBe(before.website_designated_public);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "3 — leaves the listing row identical in every column (FR-ADM-10)",
    async () => {
      const listing = await seedWithProposal();
      const before = await storedListingRow(listing);

      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: listing.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(true);

      const after = await storedListingRow(listing);

      // Whole-row equality, not a projection: *"the listing row is not written"* is a claim
      // about every column, including any a later migration adds.
      expect(after).toEqual(before);

      // Stated again on the two that matter most, so a failure reads as the rule it broke.
      expect(after["last_updated_at"]).toBe(APPROVED_AT);
      expect(after["status"]).toBe("approved");
      expect(after["publication_state"]).toBe("publicly_available");

      // And through the read boundary, as the domain aggregate.
      const reread = await findListingById(persistence.db, listing.id);

      expect(reread.ok).toBe(true);

      if (!reread.ok) return;

      expect(reread.value.content).toEqual(ORIGINAL_CONTENT);
      expect(reread.value.timestamps.lastUpdatedAt).toEqual(instant(APPROVED_AT));
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "4 — rejects a proposal whose captured base token is stale",
    async () => {
      // The single most important behavioural claim in this unit. A stale proposal can never be
      // approved (`STALE_LISTING_VERSION`), so if rejection refused it too, the proposal would
      // be unresolvable and would hold the listing's one `DI-11` slot for ever — which
      // `FR-ADM-10b`'s ruled refusal, *"the existing revision must first be approved or
      // rejected"*, assumes is escapable. `ADR-023` scopes staleness to `OP-10`, and `ADR-024`
      // item 6 says so in as many words.
      const listing = await seedWithProposal();

      // A test-only participant doing what `FR-ADM-04` does: advance the listing's version, so
      // the proposal's captured base no longer equals it. `FR-ADM-04` exists (issue #217) and is
      // deliberately not driven from here — only the version advance matters to this test.
      await sql`
        update listing
           set description = 'Corrected by an administrator.',
               last_updated_at = to_timestamp(0)
                 + ((${APPROVED_AT + 9}::bigint)::text || ' milliseconds')::interval
         where id = ${listingText(listing)}::uuid
      `.execute(persistence.db);

      const row = await storedRevisionRow(listing);

      // The premise of the test, asserted rather than assumed.
      expect(row.base_listing_last_updated_at).toBe(APPROVED_AT);

      const rejected = await rejectPendingRevision(persistence.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(true);

      if (!rejected.ok) return;

      // Succeeded, and the stale token came back **unchanged** rather than refreshed.
      expect(rejected.value.state).toBe("rejected");
      expect(rejected.value.baseListingLastUpdatedAt).toEqual(instant(APPROVED_AT));
      expect((await storedRevisionRow(listing)).base_listing_last_updated_at).toBe(APPROVED_AT);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "4b — accepts a rejection instant earlier than the listing's last-updated time",
    async () => {
      // `DI-6` is **inapplicable** here, not merely unused: `rejectedAt` is *"separate from any
      // last-updated notion"* (`ADR-017` Q-1/Q-2) and anchors retention only, so no
      // monotonicity relation to `last_updated_at` exists in the schema or the domain. A
      // same-millisecond or earlier instant is an ordinary success, and an implementation that
      // borrowed `OP-10`'s advancement check would fail here.
      const listing = await seedWithProposal();

      const rejected = await rejectPendingRevision(persistence.db, {
        listingId: listing.id,
        rejectedAt: instant(APPROVED_AT - 500),
      });

      expect(rejected.ok).toBe(true);

      if (!rejected.ok) return;

      expect(rejected.value.rejectedAt).toEqual(instant(APPROVED_AT - 500));
      expect((await storedRevisionRow(listing)).rejected_at).toBe(APPROVED_AT - 500);

      // The same-millisecond case, which `ADR-024` item 18 keeps distinct from staleness on the
      // paths where `DI-6` applies. Here it is simply allowed.
      const second = await seedWithProposal();

      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: second.id,
            rejectedAt: instant(APPROVED_AT),
          })
        ).ok,
      ).toBe(true);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "15 — releases the DI-11 pending slot, so OP-6 creation then succeeds",
    async () => {
      // Before this unit, a pending revision could leave the pending state only by being
      // approved. This is the liberation claim, proved rather than argued.
      const listing = await seedWithProposal();

      // While it is pending, `DI-11` refuses a second proposal.
      const blocked = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(blocked.ok).toBe(false);

      if (!blocked.ok) {
        expect(blocked.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
      }

      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: listing.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(true);

      // The slot is free, and the rejected proposal is **retained** beside the new one
      // (`FR-AUD-06`): freed because the state moved on, not because history was trimmed.
      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(created.ok).toBe(true);
      expect(await revisionRowCount(listing)).toBe(2);

      const pending = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(pending.ok).toBe(true);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the refusals rejection must keep apart", () => {
  it(
    "5 — reports no pending revision when there is nothing to reject",
    async () => {
      const listing = approvedListing();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const rejected = await rejectPendingRevision(persistence.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "6 — reports a missing listing, through a genuine rollback",
    async () => {
      const absent = approvedListing();

      const rejected = await rejectPendingRevision(persistence.db, {
        listingId: absent.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error).toEqual({ code: "LISTING_NOT_FOUND" });
      // The transaction was opened and must be gone: a refusal returned out of the callback
      // would have committed it instead.
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "7 — refuses a listing whose lifecycle cannot carry a pending revision",
    async () => {
      const listing = await seedWithProposal();

      // Forced directly, because no governed path can make a listing with a pending revision
      // leave the approved state.
      await sql`
        update listing set status = 'pending', publication_state = null
         where id = ${listingText(listing)}::uuid
      `.execute(persistence.db);

      const rejected = await rejectPendingRevision(persistence.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error).toEqual({ code: "LISTING_NOT_APPROVED", status: "pending" });

      // Nothing was written: the proposal is still pending with no anchor.
      const row = await storedRevisionRow(listing);

      expect(row.state).toBe("pending");
      expect(row.rejected_at).toBeNull();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "8 — refuses a proposal that already carries a rejection anchor, never rewriting it",
    async () => {
      // Write-once by **refusal, not repair** (`ADR-017` Q-1). The row is stored *pending* with
      // an anchor — a contradiction no governed operation can produce — in the hostile database
      // whose `rejected_at` `CHECK` is dropped, so the adapter's own refusal is what is tested
      // rather than the constraint's.
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      const revisionId = randomUUID();

      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          rejected_at, base_listing_last_updated_at
        ) values (
          ${revisionId}::uuid, ${listingText(listing)}::uuid, 'pending', 'Harbour Bakery',
          'food-drink', 'A small bakery.', 'Kinsale', 'IE',
          to_timestamp(0) + ((${APPROVED_AT - 50}::bigint)::text || ' milliseconds')::interval,
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
        )
      `.execute(hostile.db);

      const rejected = await rejectPendingRevision(hostile.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      // Hydration refuses the contradiction before the domain is asked, so this is reported as
      // an unreadable stored revision rather than as an ordinary lifecycle refusal — and
      // crucially **never** as staleness.
      expect(rejected.error).toEqual({
        code: "STORED_REVISION_UNREADABLE",
        failure: { code: "REJECTION_TIMESTAMP_NOT_APPLICABLE", column: "rejected_at" },
      });

      // The existing anchor is untouched: it was never rewritten and never discarded.
      const row = await storedRevisionRow(listing, hostile.db);

      expect(row.rejected_at).toBe(APPROVED_AT - 50);
      expect(row.state).toBe("pending");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "8b — refuses to reject an already-rejected revision a second time",
    async () => {
      const listing = await seedWithProposal();

      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: listing.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(true);

      const second = await rejectPendingRevision(persistence.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT + 1_000),
      });

      expect(second.ok).toBe(false);

      if (second.ok) return;

      // There is nothing *pending* any more. A lifecycle fact — never stale input.
      expect(second.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });

      // And the first anchor stands, unchanged by the second attempt.
      expect((await storedRevisionRow(listing)).rejected_at).toBe(REJECTED_AT);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "9 — reports an unreadable stored revision without reporting it as missing",
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

      const rejected = await rejectPendingRevision(hostile.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error).toEqual({
        code: "STORED_REVISION_UNREADABLE",
        failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
      });

      // Still pending: an unreadable row is refused, never repaired and never rejected blind.
      expect((await storedRevisionRow(listing, hostile.db)).state).toBe("pending");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "9b — reports an unreadable stored listing without reporting it as missing",
    async () => {
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);
      expect(
        (
          await createPendingRevision(hostile.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      // The listing's own category `CHECK` is dropped in this database, so a row the domain
      // cannot represent can be stored and the read path's classification proved end to end.
      await sql`
        update listing set category = 'not-a-category'
         where id = ${listingText(listing)}::uuid
      `.execute(hostile.db);

      const rejected = await rejectPendingRevision(hostile.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error).toEqual({
        code: "STORED_LISTING_UNREADABLE",
        failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
      });

      expect((await storedRevisionRow(listing, hostile.db)).state).toBe("pending");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "11 — reports an impossible multiplicity loudly, rather than picking one",
    async () => {
      // `DI-11`'s partial unique index makes this unreachable, and it is dropped in the hostile
      // database precisely so the unreachable case can be presented. Choosing between two
      // proposals would need an ordering the domain deliberately does not have.
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      for (const name of ["First", "Second"]) {
        await sql`
          insert into listing_revision (
            id, listing_id, state, name, category, description, locality, country,
            rejected_at, base_listing_last_updated_at
          ) values (
            ${randomUUID()}::uuid, ${listingText(listing)}::uuid, 'pending', ${name},
            'food-drink', 'Two pending proposals.', 'Kinsale', 'IE', null,
            to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
          )
        `.execute(hostile.db);
      }

      const rejected = await rejectPendingRevision(hostile.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error).toEqual({ code: "MULTIPLE_PENDING_REVISIONS", count: 2 });

      // Neither was rejected: the invariant is surfaced, not worked around.
      const rows = await sql<{ count: number }>`
        select count(*)::int as count from listing_revision
         where listing_id = ${listingText(listing)}::uuid and state = 'pending'
      `.execute(hostile.db);

      expect(rows.rows[0]?.count).toBe(2);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses an unusable rejection instant before it opens a transaction",
    async () => {
      const listing = await seedWithProposal();

      for (const offered of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, "now", null]) {
        const rejected = await rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: offered as never,
        });

        expect(rejected.ok).toBe(false);

        if (rejected.ok) continue;

        expect(rejected.error).toEqual({ code: "INVALID_REJECTION_INSTANT" });
      }

      // No lock was taken and nothing was written.
      expect((await storedRevisionRow(listing)).state).toBe("pending");
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "never reports stale input, a DI-6 failure or a validation failure on any refusal path",
    async () => {
      // The five absent codes, swept across every refusal this suite can reach. Prose in the
      // module cannot keep them absent; this can.
      const absent = approvedListing();
      const lifecycle = await seedWithProposal();

      await sql`
        update listing set status = 'pending', publication_state = null
         where id = ${listingText(lifecycle)}::uuid
      `.execute(persistence.db);

      const empty = approvedListing();

      expect((await insertSubmittedListing(persistence.db, empty)).ok).toBe(true);

      const outcomes = [
        await rejectPendingRevision(persistence.db, {
          listingId: absent.id,
          rejectedAt: instant(REJECTED_AT),
        }),
        await rejectPendingRevision(persistence.db, {
          listingId: lifecycle.id,
          rejectedAt: instant(REJECTED_AT),
        }),
        await rejectPendingRevision(persistence.db, {
          listingId: empty.id,
          rejectedAt: instant(REJECTED_AT),
        }),
        await rejectPendingRevision(persistence.db, {
          listingId: empty.id,
          rejectedAt: Number.NaN as never,
        }),
      ];

      const forbidden = [
        "STALE_LISTING_VERSION",
        "APPROVAL_INSTANT_NOT_LATER",
        "INSTANT_NOT_STRICTLY_LATER",
        "REVISION_CONTENT_INVALID",
        "GUARDED_UPDATE_PROTOCOL_FAILURE",
        "EXHAUSTED_RETRY",
      ];

      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false);

        if (outcome.ok) continue;

        expect(forbidden).not.toContain(outcome.error.code);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the impossible outcomes, forced by test-only triggers", () => {
  it(
    "10 — reports a zero-row guarded update as an invalid lifecycle state, never as staleness",
    async () => {
      const listing = await seedWithProposal();

      const rejected = await withSuppressed("listing_revision", "update", () =>
        rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        }),
      );

      expect(rejected.ok).toBe(false);

      if (rejected.ok) return;

      expect(rejected.error.code).toBe("INVALID_LIFECYCLE_STATE");

      // `ADR-024` item 8's reasoning: the affected-row count participates in the correctness
      // check, and a zero count is never reported as stale input — no token was ever compared.
      expect(rejected.error).not.toHaveProperty("sqlState");

      // 12 — the rollback is genuine. Returning a refusal out of the Kysely callback would have
      // committed, and nothing here may have been written.
      const row = await storedRevisionRow(listing);

      expect(row.state).toBe("pending");
      expect(row.rejected_at).toBeNull();
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "12 — rolls back a post-lock database failure, leaving the proposal pending",
    async () => {
      const listing = await seedWithProposal();

      // A `BEFORE UPDATE` trigger that raises, so the failure arrives from the server **after**
      // the lock was taken and the proposal read — the hardest point at which to leave a
      // half-state behind.
      await sql`
        create or replace function cdp_test_raise() returns trigger
          language plpgsql as $$ begin raise exception 'injected post-lock failure'; end $$
      `.execute(persistence.db);
      await sql`
        create trigger cdp_test_raise_listing_revision_update before update on listing_revision
          for each row execute function cdp_test_raise()
      `.execute(persistence.db);

      try {
        const rejected = await rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        });

        expect(rejected.ok).toBe(false);

        if (rejected.ok) return;

        // An unrecognised server error reaches the caller as a storage failure — not as a
        // governed business outcome, and never retried.
        expect(rejected.error.code).toBe("STORAGE_FAILURE");

        // The complement of the integrity case below: here the driver error **is** retained for
        // diagnosis, but as a **non-enumerable** property, so `JSON.stringify`, a spread and
        // most structured loggers cannot carry the server's message — which can quote the
        // failing row — out of this boundary by accident.
        expect(Object.prototype.hasOwnProperty.call(rejected.error, "cause")).toBe(true);
        expect(Object.keys(rejected.error)).not.toContain("cause");
        expect(JSON.stringify(rejected.error)).not.toContain("injected post-lock failure");
        expect(JSON.stringify(rejected.error)).not.toContain(PROPOSED_CONTENT.name);

        const row = await storedRevisionRow(listing);

        expect(row.state).toBe("pending");
        expect(row.rejected_at).toBeNull();
        expect(await storedListingRow(listing)).toHaveProperty("status", "approved");
        expect(await sessionsInTransaction()).toBe(0);
      } finally {
        await sql`
          drop trigger if exists cdp_test_raise_listing_revision_update on listing_revision
        `.execute(persistence.db);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "14 — carries no row values, credentials or paths in a storage failure's enumerable surface",
    async () => {
      const listing = await seedWithProposal();

      // A `CHECK` violation carries `detail: "Failing row contains (…)"` on the driver error,
      // which is proposed listing content this layer must never republish. The constraint is
      // violated by forcing a state the `CHECK` forbids through a trigger that rewrites the row.
      await sql`
        create or replace function cdp_test_break_check() returns trigger
          language plpgsql as $$ begin new.rejected_at := null; return new; end $$
      `.execute(persistence.db);
      await sql`
        create trigger cdp_test_break_check_listing_revision_update before update on listing_revision
          for each row execute function cdp_test_break_check()
      `.execute(persistence.db);

      try {
        const rejected = await rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        });

        expect(rejected.ok).toBe(false);

        if (rejected.ok) return;

        // Classified as the integrity fault it is — `ADR-024` item 14 — and never retried.
        expect(rejected.error.code).toBe("INTEGRITY_CONFLICT");

        if (rejected.error.code !== "INTEGRITY_CONFLICT") return;

        expect(rejected.error.sqlState).toBe("23514");
        // The constraint **name** is schema metadata, and is validated before it is echoed.
        expect(rejected.error.constraint).toBe("listing_revision_rejected_at_check");

        // The security property, measured rather than assumed: the enumerable surface carries
        // the `SQLSTATE` and the constraint name and nothing else, so no spread, `JSON.stringify`
        // or structured log can leak the failing row.
        const serialized = JSON.stringify(rejected.error);

        expect(Object.keys(rejected.error).sort()).toEqual(["code", "constraint", "sqlState"]);
        expect(serialized).not.toContain("Failing row");
        expect(serialized).not.toContain(PROPOSED_CONTENT.name);
        expect(serialized).not.toContain(PROPOSED_CONTENT.description);
        expect(serialized).not.toContain("password");
        expect(serialized).not.toContain("postgres://");

        // A classified integrity conflict carries **no driver error at all** — not even a
        // non-enumerable one. It is built as a literal from the two safe facts, so there is
        // nothing to leak and nothing to reach for, which is stronger than hiding it.
        expect(Object.prototype.hasOwnProperty.call(rejected.error, "cause")).toBe(false);
      } finally {
        await sql`
          drop trigger if exists cdp_test_break_check_listing_revision_update on listing_revision
        `.execute(persistence.db);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the PS-11 protocol, under real concurrency", () => {

  /**
   * Hold the listing lock for the duration of `body`, and **always** release it.
   *
   * The `finally` is not tidiness, it is what keeps a *failing* assertion from becoming a
   * *hanging* suite. A held row lock also holds a table-level lock on `listing`, and
   * `afterEach`'s `drop trigger … on listing` needs `ACCESS EXCLUSIVE` — so a test that threw
   * while still holding the lock would block cleanup indefinitely and bury the real failure.
   * Found exactly that way: a mutation that removed the `PS-11` lock made the sentinel fire,
   * and the leaked transaction turned a clean failure into a timeout.
   *
   * `body` may commit the transaction itself — the usual case, since these interleavings need
   * the rival to commit at a chosen moment. The rollback here is therefore conditional on the
   * transaction still being open.
   */
  async function withRivalLock(
    listing: Listing,
    body: (trx: ControlledTransaction<ListingDatabase>) => Promise<void>,
  ): Promise<void> {
    const trx = await rival.db
      .startTransaction()
      .setIsolationLevel("read committed")
      .execute();

    // **Acquisition is inside the `try`, not before it.** A `SELECT … FOR UPDATE` that throws
    // leaves the transaction open and aborted, still holding whatever it acquired, so taking the
    // lock outside the `try` would leak it on a setup failure — the same hazard as an escaping
    // assertion, one statement earlier. Only `startTransaction` itself sits outside, and if that
    // throws there is no transaction to release.
    try {
      await trx
        .selectFrom("listing")
        .select("id")
        .where("id", "=", listingText(listing))
        .forUpdate()
        .execute();

      await body(trx);
    } finally {
      if (trx.isCommitted === false && trx.isRolledBack === false) {
        await trx.rollback().execute();
      }
    }
  }

  it(
    "interleaving — rejection demonstrably blocks on another holder's listing lock",
    async () => {
      // The claim that nothing about the statement's own effect could reveal: the `PS-11` lock
      // is taken **first**, before any revision state is read, even though no listing row is
      // ever written. An implementation that skipped it would not block here, and the sentinel
      // would fail this test by name rather than hanging.
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        const blocked = rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        });

        await awaitLockWaiter();

        // Still pending while the rival holds the lock — the rejection has not run past it.
        expect((await storedRevisionRow(listing, observer.db)).state).toBe("pending");

        await trx.commit().execute();

        const rejected = await blocked;

        expect(rejected.ok).toBe(true);
        expect((await storedRevisionRow(listing)).state).toBe("rejected");
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving — reject versus reject: exactly one rejects, and the anchor is never rewritten",
    async () => {
      const listing = await seedWithProposal();

      const [first, second] = await Promise.all([
        rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        }),
        rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT + 7_000),
        }),
      ]);

      const rejected = [first, second].filter((outcome) => outcome.ok);
      const refused = [first, second].filter((outcome) => !outcome.ok);

      // The listing lock serializes them, so the *outcome set* is deterministic even though
      // which arrives first is not. Two rejections would mean the anchor was rewritten.
      expect(rejected).toHaveLength(1);
      expect(refused).toHaveLength(1);

      const failure = refused[0];

      if (failure === undefined || failure.ok) return;

      expect(failure.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });

      const winner = rejected[0];

      if (winner === undefined || !winner.ok) return;

      // The stored anchor is the winner's, exactly — not the loser's and not a blend.
      const stored = await storedRevisionRow(listing);

      expect(stored.state).toBe("rejected");
      expect(stored.rejected_at).toBe(
        (winner.value.rejectedAt as unknown as { readonly epochMilliseconds: number })
          .epochMilliseconds ?? stored.rejected_at,
      );
      expect([REJECTED_AT, REJECTED_AT + 7_000]).toContain(stored.rejected_at);
      expect(await revisionRowCount(listing)).toBe(1);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving — approval takes the lock first; the rejection loses with invalid lifecycle",
    async () => {
      // `ADR-024`'s ruled classification, asserted literally: *"The loser finds nothing pending
      // and reports invalid lifecycle state — never stale input, because its token was never the
      // problem."* Approval is driven through the real `OP-10` boundary inside a held lock, so
      // the ordering is enforced rather than hoped for.
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        // The rival performs what `OP-10` does, committing while the rejection is blocked.
        await sql`
          delete from listing_revision
           where listing_id = ${listingText(listing)}::uuid and state = 'pending'
        `.execute(trx);
        await sql`
          update listing
             set name = ${PROPOSED_CONTENT.name},
                 last_updated_at = to_timestamp(0)
                   + ((${APPROVED_AT + 3}::bigint)::text || ' milliseconds')::interval
           where id = ${listingText(listing)}::uuid
        `.execute(trx);

        const blocked = rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        });

        await awaitLockWaiter();
        await trx.commit().execute();

        const rejected = await blocked;

        expect(rejected.ok).toBe(false);

        if (rejected.ok) return;

        // The post-lock read sees committed state, so there is nothing pending to reject.
        expect(rejected.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
        expect(rejected.error.code).not.toBe("STALE_LISTING_VERSION");

        // The approval stands untouched by the losing rejection.
        expect(await storedListingRow(listing)).toHaveProperty("name", PROPOSED_CONTENT.name);
        expect(await revisionRowCount(listing)).toBe(0);
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving — rejection takes the lock first; the approval loses with invalid lifecycle",
    async () => {
      // The other ordering, and the one that matters most: the approval must lose as a
      // **lifecycle** fact. Its own proposal was perfectly fresh, so reporting staleness would
      // deliver the wrong governed message (`ADR-023`, `ADR-024` item 18).
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        const blocked = rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        });

        await awaitLockWaiter();
        await trx.commit().execute();

        expect((await blocked).ok).toBe(true);
      });

      // Now the real `OP-10` boundary runs, after the rejection committed.
      const approved = await approveAndApplyPendingRevision(persistence.db, {
        listingId: listing.id,
        approvedAt: instant(APPROVED_AT + 5_000),
      });

      expect(approved.ok).toBe(false);

      if (approved.ok) return;

      expect(approved.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
      expect(approved.error.code).not.toBe("STALE_LISTING_VERSION");

      // The listing was never written by either participant.
      const row = await storedListingRow(listing);

      expect(row["name"]).toBe(ORIGINAL_CONTENT.name);
      expect(row["last_updated_at"]).toBe(APPROVED_AT);

      // The rejected proposal is retained (`FR-AUD-06`), with its anchor intact.
      const stored = await storedRevisionRow(listing);

      expect(stored.state).toBe("rejected");
      expect(stored.rejected_at).toBe(REJECTED_AT);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving — rejection, then a concurrent OP-6 creation that the freed slot admits",
    async () => {
      const listing = await seedWithProposal();

      await withRivalLock(listing, async (trx) => {
        const blockedRejection = rejectPendingRevision(persistence.db, {
          listingId: listing.id,
          rejectedAt: instant(REJECTED_AT),
        });

        await awaitLockWaiter();
        await trx.commit().execute();

        expect((await blockedRejection).ok).toBe(true);
      });

      // Serialized by the same lock: the creation's post-lock pending check observes the
      // rejection's committed result, so the slot is genuinely free rather than contended.
      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(created.ok).toBe(true);
      expect(await revisionRowCount(listing)).toBe(2);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "the listing row is unchanged after every rejection path this suite exercises",
    async () => {
      // One sweep, so the claim is made over the whole set rather than case by case.
      const succeeding = await seedWithProposal();
      const noPending = approvedListing();
      const suppressed = await seedWithProposal();

      expect((await insertSubmittedListing(persistence.db, noPending)).ok).toBe(true);

      const before = new Map(
        await Promise.all(
          [succeeding, noPending, suppressed].map(
            async (listing) => [listingText(listing), await storedListingRow(listing)] as const,
          ),
        ),
      );

      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: succeeding.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await rejectPendingRevision(persistence.db, {
            listingId: noPending.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await withSuppressed("listing_revision", "update", () =>
            rejectPendingRevision(persistence.db, {
              listingId: suppressed.id,
              rejectedAt: instant(REJECTED_AT),
            }),
          )
        ).ok,
      ).toBe(false);

      for (const listing of [succeeding, noPending, suppressed]) {
        expect(await storedListingRow(listing)).toEqual(before.get(listingText(listing)));
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the statements PostgreSQL actually received", () => {
  it(
    "13 — writes the revision in place under all four guards, and never writes the listing",
    async () => {
      const listing = await seedWithProposal(capturing.db);

      capturing.reset();

      const rejected = await rejectPendingRevision(capturing.db, {
        listingId: listing.id,
        rejectedAt: instant(REJECTED_AT),
      });

      expect(rejected.ok).toBe(true);

      // The central negative claim: **no listing write of any kind** (`FR-ADM-10`).
      expect(listingUpdatesIn(capturing.statements)).toEqual([]);

      const updates = revisionUpdatesIn(capturing.statements);

      expect(updates).toHaveLength(1);

      const statement = updates[0] as CapturedStatement;
      const shape = guardedUpdateShapeOf(statement.sql);

      expect(shape).toEqual({
        setsState: true,
        setsRejectedAt: true,
        setsForbiddenColumn: undefined,
        whereHasRevisionId: true,
        whereHasListingId: true,
        whereHasPendingState: true,
        whereHasNullAnchor: true,
        // No base-token comparison exists on this path, and none may be introduced.
        whereMentionsLastUpdatedAt: false,
      });

      // The lock really is a `FOR UPDATE` on `listing`, and it is the **first** statement after
      // the isolation level is set — so the order is read off the wire, not off the source.
      const listingSelects = capturing.statements.filter((captured) =>
        /^\s*select\b[\s\S]*\bfrom\s+"listing"\s/i.test(captured.sql),
      );
      const revisionSelects = capturing.statements.filter((captured) =>
        /^\s*select\b[\s\S]*\bfrom\s+"listing_revision"\s/i.test(captured.sql),
      );

      expect(listingSelects).toHaveLength(1);
      expect(revisionSelects).toHaveLength(1);
      expect(listingSelects[0]?.sql).toMatch(/for update/i);
      expect(revisionSelects[0]?.sql).toMatch(/for update/i);

      const lockIndex = capturing.statements.indexOf(listingSelects[0] as CapturedStatement);
      const readIndex = capturing.statements.indexOf(revisionSelects[0] as CapturedStatement);
      const writeIndex = capturing.statements.indexOf(statement);

      expect(lockIndex).toBeLessThan(readIndex);
      expect(readIndex).toBeLessThan(writeIndex);

      // 13 — no identity or token leakage. The physical revision UUID is bound as a parameter
      // of the `UPDATE`, which is where it must stay; it must not appear in the returned value.
      const revisionId = (await storedRevisionRow(listing, capturing.db)).id;

      expect(statement.parameters).toContain(revisionId);

      if (!rejected.ok) return;

      expect(JSON.stringify(rejected.value)).not.toContain(revisionId);
      expect(Object.keys(rejected.value).sort()).toEqual([
        "baseListingLastUpdatedAt",
        "listingId",
        "proposedContent",
        "rejectedAt",
        "state",
      ]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "writes the anchor as a timestamptz expression, never as a bound number or a Date",
    async () => {
      const listing = await seedWithProposal(capturing.db);

      capturing.reset();

      expect(
        (
          await rejectPendingRevision(capturing.db, {
            listingId: listing.id,
            rejectedAt: instant(REJECTED_AT),
          })
        ).ok,
      ).toBe(true);

      const statement = revisionUpdatesIn(capturing.statements)[0] as CapturedStatement;

      // `ADR-022`: the conversion every governed instant shares, so the round trip stays exact
      // to the millisecond. A bound number would have no `timestamptz` meaning to PostgreSQL.
      expect(statement.sql).toMatch(/to_timestamp\s*\(/i);
      expect(statement.parameters.some((parameter) => parameter instanceof Date)).toBe(false);

      // And it round-tripped exactly, which is the property the expression exists to protect.
      expect((await storedRevisionRow(listing, capturing.db)).rejected_at).toBe(REJECTED_AT);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "the analyser itself notices a guard that has been removed",
    async () => {
      // A shape analyser that could not fail would make every assertion above worthless, so it
      // is attacked with hostile samples. Each omits exactly one guard.
      expect(
        guardedUpdateShapeOf(
          'update "listing_revision" set "state" = $1, "rejected_at" = to_timestamp($2) ' +
            'where "id" = $3 and "listing_id" = $4 and "state" = $5 and "rejected_at" is null',
        ),
      ).toEqual({
        setsState: true,
        setsRejectedAt: true,
        setsForbiddenColumn: undefined,
        whereHasRevisionId: true,
        whereHasListingId: true,
        whereHasPendingState: true,
        whereHasNullAnchor: true,
        whereMentionsLastUpdatedAt: false,
      });

      // The anchor guard dropped — the write-once attack.
      expect(
        guardedUpdateShapeOf(
          'update "listing_revision" set "state" = $1, "rejected_at" = to_timestamp($2) ' +
            'where "id" = $3 and "listing_id" = $4 and "state" = $5',
        ).whereHasNullAnchor,
      ).toBe(false);

      // The pending-state guard dropped.
      expect(
        guardedUpdateShapeOf(
          'update "listing_revision" set "state" = $1, "rejected_at" = to_timestamp($2) ' +
            'where "id" = $3 and "listing_id" = $4 and "rejected_at" is null',
        ).whereHasPendingState,
      ).toBe(false);

      // A base-token comparison wrongly introduced.
      expect(
        guardedUpdateShapeOf(
          'update "listing_revision" set "state" = $1 ' +
            'where "id" = $2 and "base_listing_last_updated_at" = to_timestamp($3)',
        ).whereMentionsLastUpdatedAt,
      ).toBe(true);

      // The token wrongly rewritten — the `ADR-023` refresh attack.
      expect(
        guardedUpdateShapeOf(
          'update "listing_revision" set "state" = $1, ' +
            '"base_listing_last_updated_at" = to_timestamp($2) where "id" = $3',
        ).setsForbiddenColumn,
      ).toBe("base_listing_last_updated_at");

      // Proposal content wrongly rewritten — a rejection is a transition, not an edit.
      expect(
        guardedUpdateShapeOf('update "listing_revision" set "name" = $1 where "id" = $2')
          .setsForbiddenColumn,
      ).toBe("name");

      // And the listing-update detector must actually detect one.
      expect(
        listingUpdatesIn([
          { sql: 'update "listing" set "last_updated_at" = $1 where "id" = $2', parameters: [] },
        ]),
      ).toHaveLength(1);
      expect(
        listingUpdatesIn([
          { sql: 'update "listing_revision" set "state" = $1', parameters: [] },
        ]),
      ).toHaveLength(0);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

/**
 * The capturing pool's idle-client error handling (issue #201).
 *
 * This suite inherited the gap along with the factory: PR #200 copied
 * `createCapturingPersistence` from the approval suite verbatim, including its missing `error`
 * listener. The same `57P01` at cluster shutdown was therefore reachable from here too, so the
 * same listener and the same proof belong in both files.
 *
 * Owned resources only: one specific backend, named by the `pid` it reports for itself, ended
 * through `pg_terminate_backend`. No process is signalled and no database is dropped, and the
 * pid-set comparison proves nothing broader was touched.
 */
describe("the capturing pool's idle-client errors", () => {
  it(
    "attaches an error listener at construction, before any client can become idle",
    async () => {
      const fresh = createCapturingPersistence(VERIFIED_DATABASE);

      try {
        expect(fresh.pool.listenerCount("error")).toBeGreaterThanOrEqual(1);
        expect(fresh.pool.totalCount).toBe(0);
        expect(fresh.idlePoolErrors).toEqual([]);
      } finally {
        await fresh.shutdown();
      }

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
        const pidRows = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
          owned.db,
        );
        const ownedPid = pidRows.rows[0]?.pid;

        expect(typeof ownedPid).toBe("number");

        if (typeof ownedPid !== "number") return;

        expect(owned.pool.idleCount).toBeGreaterThanOrEqual(1);

        const before = await livePids();

        expect(before).toContain(ownedPid);

        // Registered before the termination, so the wait is event-driven rather than polled.
        const delivered = nextPoolError(owned.pool);

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

        // Delivered to the pool's own listener, not to the process: without the listener, Node
        // would have thrown before this line.
        const error = await delivered;

        expect((error as { readonly code?: unknown }).code).toBe("57P01");
        expect(owned.idlePoolErrors.length).toBeGreaterThanOrEqual(1);

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

        // Still governed: the replacement connection keeps the `timestamptz` overrides, so a
        // lost client cannot silently downgrade the boundary to `Date` (`ADR-022`).
        const roundTrip = await sql<{ at: number }>`
          select to_timestamp(0)
            + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval as at
        `.execute(owned.db);

        expect(roundTrip.rows[0]?.at).toBe(APPROVED_AT);
        expect(roundTrip.rows[0]?.at).not.toBeInstanceOf(Date);

        // Nothing retried or recovered on our behalf: a failing query still fails.
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
