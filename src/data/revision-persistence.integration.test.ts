/**
 * Attacking tests for revision persistence against a real PostgreSQL server (issue #195).
 *
 * `ADR-024` names its own material tradeoff: correctness depends on **enforced statement and lock
 * order** rather than on the engine, *"which makes deterministic interleaving tests mandatory"*.
 * This file is that obligation discharged — the protocol is driven by real concurrent connections
 * against the real `001`/`002` schema, not asserted by reading the code.
 *
 * ## How the interleavings stay deterministic
 *
 * No test sleeps, polls an assertion, or re-runs anything until it passes. Where one participant
 * must be *blocked* while another commits, the suite synchronises on **observable lock
 * acquisition**: PostgreSQL publishes a backend waiting on a lock in `pg_stat_activity`, so the
 * condition is read from the server rather than guessed at with a timer. `awaitLockWaiter` waits
 * for exactly that fact and throws a named sentinel if it never appears, which turns "the
 * participant never blocked" — a real defect — into an immediate, explicit failure instead of a
 * hang. That is a condition wait on a published fact, not a retry-until-green.
 *
 * ## Why a second and third pool
 *
 * A controlled transaction pins a connection, so the rival participant needs its own pool to hold
 * a lock while the boundary under test runs on another. The observer pool exists so that reading
 * `pg_stat_activity` can never itself be the backend that is blocked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import {
  CLUSTER_PASSWORD,
  CLUSTER_TIMEOUT_MS,
  useEmbeddedPostgres,
} from "./testing/embedded-cluster";

import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { DesignatableValue, Listing, ListingContent } from "../domain/listing/listing";
import type { ListingRevision, PendingListingRevision } from "../domain/listing/revision";
import type { DesignatableField } from "../domain/listing/designation";
import {
  createListingPersistence,
  startupOptionsFor,
  type ListingPersistence,
} from "./connection";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import type { ListingDatabase } from "./listing-table";
import { insertSubmittedListing } from "./listing-repository";
import {
  createPendingRevision,
  findPendingRevisionByListing,
} from "./revision-repository";
import { serializePendingRevision } from "./revision-mapping";

const VERIFIED_DATABASE = "revision_persistence_verification";
/** A second database whose revision `CHECK`s are dropped, so hostile rows can be stored. */
const HOSTILE_DATABASE = "revision_hostile_verification";

const cluster = useEmbeddedPostgres({
  slug: "revision",
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
/** The same boundary, with every executed statement captured (#207). */
let capturing: ReturnType<typeof createCapturingPersistence>;

const APPROVED_AT = 1_767_323_045_123;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

/** An approved listing, the only kind that may carry a proposal (`FR-ADM-10`). */
function approvedListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "approved",
    content: {
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Kinsale",
      country: "IE",
    },
    publication: { value: "publicly_available" },
    timestamps: {
      submittedAt: instant(APPROVED_AT - 1_000),
      lastUpdatedAt: instant(APPROVED_AT),
    },
    ...overrides,
  };
}

/**
 * A proposal prepared against the listing's current version (`ADR-023` item 10).
 *
 * **Every designatable value is private** (issue #207). `approvedListing()` carries none of the
 * four, so each of these is an **addition** — and `ADR-025` makes an addition a replacement for
 * designation purposes, which *"defaults to private and cannot be made public"*. Before `OP-6`
 * enforced the policy this fixture proposed a **public** `postalCode` and `email`; those two
 * defaults were only ever accepted because the rule was not yet wired, and correcting them
 * makes the shared fixture describe a **lawful** proposal rather than weakening a test.
 *
 * Refusal cases override these defaults explicitly, so what each one attempts is visible in the
 * test that attempts it rather than inherited from here.
 */
function proposalFor(
  listing: Listing,
  overrides: Partial<PendingListingRevision> = {},
): PendingListingRevision {
  return {
    listingId: listing.id,
    state: "pending",
    proposedContent: {
      name: "Harbour Bakery & Cafe",
      category: "food-drink",
      description: "A small bakery, now with a cafe.",
      locality: "Kinsale",
      country: "IE",
      administrativeArea: "Co. Cork",
      postalCode: { value: "P17 AB12", designatedPublic: false },
      phone: { value: "+353 21 123 4567", designatedPublic: false },
      email: { value: "hello@example.ie", designatedPublic: false },
      website: { value: "https://example.ie", designatedPublic: false },
    },
    baseListingLastUpdatedAt: listing.timestamps.lastUpdatedAt,
    ...overrides,
  } as PendingListingRevision;
}

/** Store one listing and hand it back, so each case owns an isolated target. */
async function seed(listing: Listing = approvedListing()): Promise<Listing> {
  const stored = await insertSubmittedListing(persistence.db, listing);

  expect(stored.ok).toBe(true);

  return listing;
}

function listingText(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

async function pendingRowCount(listing: Listing): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from listing_revision
     where listing_id = ${listingText(listing)}::uuid
  `.execute(persistence.db);

  return rows.rows[0]?.count ?? 0;
}

async function storedLastUpdatedAt(listing: Listing): Promise<number> {
  const rows = await sql<{ last_updated_at: number }>`
    select last_updated_at from listing where id = ${listingText(listing)}::uuid
  `.execute(persistence.db);

  const value = rows.rows[0]?.last_updated_at;

  if (value === undefined) {
    throw new Error("the seeded listing is missing");
  }

  return value;
}

/** Sessions this database has left holding a transaction open. Must always settle at zero. */
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
 * The narrow slice of `pg` this file reaches directly, to build a **logging** boundary (#207).
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is described here — the pattern `migrate.ts`, the listing suite and
 * `revision-approval.integration.test.ts` established.
 */
interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => PgPool;
}

/** The three facts this file uses, and nothing more. */
interface PgPool {
  on(event: "error", listener: (error: Error) => void): unknown;
  listenerCount(event: string): number;
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A `C9` boundary identical to the production one, with every executed statement captured.
 *
 * **No production change buys this**, and it is the `revision-approval.integration.test.ts`
 * precedent reused rather than a new mechanism: `createPendingRevision` accepts any
 * `Kysely<ListingDatabase>`, and Kysely's own `log` option reports each statement it executes as
 * compiled SQL plus bound parameters. That is how statement *order* — which the lock makes
 * invisible to behaviour alone — is proved without a fault-injection hook, a source-text
 * assertion, or any weakening of the lock.
 *
 * The pool is configured exactly as `createListingPersistence` configures its own: the governed
 * `timestamptz` overrides so instants arrive as epoch milliseconds (`ADR-022` decision 9), and
 * the governed `DateStyle` in the startup packet. Anything less would be testing a different
 * boundary from the one that runs in production.
 */
function createCapturingPersistence(database: string): {
  readonly db: Kysely<ListingDatabase>;
  readonly statements: readonly CapturedStatement[];
  reset(): void;
  shutdown(): Promise<void>;
} {
  const statements: CapturedStatement[] = [];

  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(database),
    max: 2,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: "revision_persistence_capture" }),
  });

  // The listener issue #201 exists for, attached **immediately** after construction — before any
  // client can be checked out, become idle, or be terminated by the server. `connection.ts`
  // attaches the same one on every application pool; this pool is built directly from `pg` and
  // so would otherwise have none, and an unhandled `EventEmitter` `error` throws. Handled by
  // doing nothing, exactly as production does.
  pool.on("error", () => {});

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
    reset: () => {
      statements.length = 0;
    },
    shutdown: () => db.destroy(),
  };
}

/** Statements that write, in execution order. `OP-6` may execute exactly one, and only on success. */
function writesIn(statements: readonly CapturedStatement[]): readonly CapturedStatement[] {
  return statements.filter((statement) => /^\s*(insert|update|delete)\b/i.test(statement.sql));
}

/** The index of the first statement matching `pattern`, or `-1`. */
function indexOfStatement(
  statements: readonly CapturedStatement[],
  pattern: RegExp,
): number {
  return statements.findIndex((statement) => pattern.test(statement.sql));
}

const LISTING_LOCK = /^\s*select\b[\s\S]*\bfrom\s+"listing"[\s\S]*\bfor update\b/i;
const PENDING_READ = /\bfrom\s+"listing_revision"[\s\S]*\bfor update\b/i;
const REVISION_INSERT = /^\s*insert\s+into\s+"listing_revision"/i;

const LOCK_WAIT_SENTINEL = "no backend ever blocked on a lock";

/**
 * Wait until PostgreSQL reports a backend blocked on a lock, then return.
 *
 * **This is a condition wait on a fact the server publishes, not a sleep and not a retry.** The
 * boundary under test is expected to block on the rival's `FOR UPDATE`; until the server says a
 * backend is waiting, committing the rival would make the interleaving meaningless rather than
 * merely slow. Each iteration is one round trip, so the loop paces itself and ends the moment the
 * fact appears.
 *
 * The bound exists so that a participant which never blocks — a genuine protocol defect, for
 * instance a lock taken too late or not at all — fails **immediately and by name** instead of
 * hanging until vitest's timeout and leaving a cluster behind.
 */
async function awaitLockWaiter(attempts = 2_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await sql<{ count: number }>`
      select count(*)::int as count
        from pg_stat_activity
       where wait_event_type = 'Lock'
         and datname = current_database()
    `.execute(observer.db);

    if ((waiting.rows[0]?.count ?? 0) > 0) {
      return;
    }
  }

  throw new Error(
    `${LOCK_WAIT_SENTINEL}: the operation under test did not wait for the rival's listing lock`,
  );
}

beforeAll(async () => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 4 },
    startupParameters: { application_name: "revision_persistence_tests" },
  });

  rival = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
  });

  observer = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 1 },
  });

  hostile = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(HOSTILE_DATABASE), max: 1 },
  });

  cluster.closeBeforeShutdown("verified persistence", () => persistence.shutdown());
  cluster.closeBeforeShutdown("rival persistence", () => rival.shutdown());
  cluster.closeBeforeShutdown("observer persistence", () => observer.shutdown());
  cluster.closeBeforeShutdown("hostile persistence", () => hostile.shutdown());

  // So that a row the domain cannot represent can be *stored*, and the read path's
  // classification of it proved end to end rather than only against a hand-built object.
  await sql`alter table listing_revision drop constraint listing_revision_state_check`.execute(
    hostile.db,
  );
  await sql`alter table listing_revision drop constraint listing_revision_category_check`.execute(
    hostile.db,
  );
  await sql`alter table listing_revision drop constraint listing_revision_rejected_at_check`.execute(
    hostile.db,
  );
  // And so that a *listing* the domain cannot represent can be stored, which is the only way to
  // reach `STORED_LISTING_UNREADABLE` end to end rather than against a hand-built row (#207).
  await sql`alter table listing drop constraint listing_category_check`.execute(hostile.db);

  capturing = createCapturingPersistence(VERIFIED_DATABASE);
  cluster.closeBeforeShutdown("capturing persistence", () => capturing.shutdown());
}, CLUSTER_TIMEOUT_MS);

describe("creating a pending revision (OP-6)", () => {
  it(
    "stores the complete proposal and retrieves it unchanged",
    async () => {
      const listing = await seed();
      const proposal = proposalFor(listing);

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposal,
      });

      expect(created.ok, JSON.stringify(created)).toBe(true);

      const found = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(found.ok, JSON.stringify(found)).toBe(true);

      if (!found.ok) return;

      // Nothing governed is lost in either direction: the content, every designation pair, the
      // category and the exact captured token all survive the round trip through real columns.
      expect(found.value).toEqual(proposal);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "round-trips a proposal whose optional fields are all absent",
    async () => {
      const listing = await seed();
      const proposal = proposalFor(listing, {
        proposedContent: {
          name: "Bare Minimum",
          category: "retail-shopping",
          description: "Only the required fields.",
          locality: "Cobh",
          country: "IE",
        },
      });

      expect(
        (await createPendingRevision(persistence.db, { revisionId: randomUUID(), revision: proposal }))
          .ok,
      ).toBe(true);

      const found = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(found.ok).toBe(true);

      if (!found.ok) return;

      expect(found.value).toEqual(proposal);
      expect(Object.keys(found.value.proposedContent)).not.toContain("postalCode");
      expect(found.value.rejectedAt).toBeUndefined();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each([
    ["modern", APPROVED_AT],
    ["the epoch itself", 0],
    // 1900-01-01Z. A *far* earlier instant (1752, say) is deliberately not used: before
    // standardized offsets PostgreSQL returns a zone offset carrying **seconds**, which the
    // governed parser refuses loudly by design (issue #173). That refusal is correct
    // behaviour, not a round-trip defect, and asserting it belongs to the parser's own suite.
    ["pre-epoch", -2_208_988_800_000],
  ])(
    "stores and returns a %s base token exactly, to the millisecond",
    async (_label, epochMilliseconds) => {
      // `ADR-023` item 11's exact epoch-millisecond equality, proved by PostgreSQL's own
      // accounting rather than by the application agreeing with itself.
      const listing = await seed(
        approvedListing({
          timestamps: {
            submittedAt: instant(epochMilliseconds - 1_000),
            lastUpdatedAt: instant(epochMilliseconds),
          },
        }),
      );

      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      const found = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(found.ok).toBe(true);

      if (!found.ok) return;

      expect(found.value.baseListingLastUpdatedAt).toEqual(instant(epochMilliseconds));
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "returns instants, never a Date, because the governed parser is registered",
    async () => {
      const listing = await seed();

      await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      const found = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(found.ok).toBe(true);

      if (!found.ok) return;

      expect(found.value.baseListingLastUpdatedAt).not.toBeInstanceOf(Date);
      expect(JSON.stringify(found.value)).not.toContain("T00:00:00");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "never touches the listing: no content change, no advanced lastUpdatedAt",
    async () => {
      // `docs/09`: `OP-6` changes content, never the effective public version. Advancing the
      // listing's version would make every other proposal stale for an operation that changed
      // nothing — which is also why no token predicate is manufactured here.
      const listing = await seed();
      const before = await storedLastUpdatedAt(listing);

      await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(await storedLastUpdatedAt(listing)).toBe(before);
      expect(before).toBe(APPROVED_AT);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a missing listing, and writes nothing",
    async () => {
      const absent = approvedListing();

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(absent),
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({ code: "LISTING_NOT_FOUND" });
      expect(await pendingRowCount(absent)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each(["pending", "rejected"])(
    "refuses a listing whose lifecycle state is %s, under the lock",
    async (status) => {
      // `FR-ADM-10` admits a proposal only against an *approved* listing. Decided from the
      // locked row rather than from whatever the caller believed.
      const listing = await seed(
        approvedListing(
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
        ),
      );

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({ code: "LISTING_NOT_APPROVED", status });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses a stale proposal before any mutation, leaving nothing written",
    async () => {
      const listing = await seed();

      // The listing changed after the administrator's work began — the exact situation
      // `ADR-023` exists to detect. Applied by raw SQL because `OP-10` and `FR-ADM-04`, which
      // own listing writes, are separate units and this file must not implement them.
      await sql`
        update listing set last_updated_at = to_timestamp(0) + ((${APPROVED_AT + 1}::bigint)::text
          || ' milliseconds')::interval
         where id = ${listingText(listing)}::uuid
      `.execute(persistence.db);

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      // Stale input, and distinctly that: never a timestamp-advancement failure, which this
      // operation cannot reach, and never an integrity conflict.
      expect(created.error).toEqual({ code: "STALE_LISTING_VERSION" });
      expect(await pendingRowCount(listing)).toBe(0);
      expect(await storedLastUpdatedAt(listing)).toBe(APPROVED_AT + 1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "detects staleness by exact equality, so one millisecond is enough",
    async () => {
      const listing = await seed();

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing, {
          baseListingLastUpdatedAt: instant(APPROVED_AT - 1),
        }),
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({ code: "STALE_LISTING_VERSION" });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each([
    ["rejected", { state: "rejected" as const }],
    ["transiently approved", { state: "approved" as const }],
  ])(
    "refuses a %s proposal before opening a transaction",
    async (_label, overrides) => {
      // Only a genuinely pending revision may be persisted. `001`'s `CHECK` would also refuse
      // `approved`, but a caller error must surface as a caller error rather than as a
      // `STORAGE_FAILURE` the store happened to catch.
      const listing = await seed();
      const proposal = { ...proposalFor(listing), ...overrides } as unknown as ListingRevision;

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposal,
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({
        code: "INVALID_PENDING_REVISION",
        reason: "not-pending",
      });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses a pending proposal that already carries a rejection anchor",
    async () => {
      const listing = await seed();
      const proposal = {
        ...proposalFor(listing),
        rejectedAt: instant(APPROVED_AT),
      } as unknown as ListingRevision;

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposal,
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({
        code: "INVALID_PENDING_REVISION",
        reason: "rejection-anchor-present",
      });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses an unusable base token rather than letting NaN reach SQL",
    async () => {
      const listing = await seed();
      const proposal = {
        ...proposalFor(listing),
        baseListingLastUpdatedAt: { epochMilliseconds: 1.5 },
      } as unknown as ListingRevision;

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposal,
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({
        code: "INVALID_PENDING_REVISION",
        reason: "unusable-base-token",
      });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "distinguishes a repeated revision identifier from the DI-11 conflict",
    async () => {
      // Both are `23505`. Classifying on the `SQLSTATE` alone would report an identity
      // collision the application caused as the integrity backstop firing — a confidently
      // wrong answer — so the constraint **name** participates in the decision.
      const first = await seed();
      const second = await seed();
      const revisionId = randomUUID();

      expect(
        (await createPendingRevision(persistence.db, { revisionId, revision: proposalFor(first) }))
          .ok,
      ).toBe(true);

      // A different listing, so the post-lock `DI-11` read passes and the insert is reached.
      const repeated = await createPendingRevision(persistence.db, {
        revisionId,
        revision: proposalFor(second),
      });

      expect(repeated.ok).toBe(false);

      if (repeated.ok) return;

      expect(repeated.error.code).toBe("REVISION_ALREADY_EXISTS");
      expect(repeated.error.code).not.toBe("PENDING_UNIQUENESS_CONFLICT");
      expect(await pendingRowCount(second)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaks neither row values nor credentials in a storage diagnostic",
    async () => {
      // A `CHECK` violation is the driver error that genuinely quotes the row: PostgreSQL
      // attaches `detail: "Failing row contains (…)"`, and `pg` exposes it as an **enumerable
      // own property**, so an error passed through verbatim would publish proposed content into
      // any log line or JSON response that touched it.
      //
      // (A foreign-key violation would not do: its detail names only the key, which is why the
      // category `CHECK` is used here rather than a missing listing.)
      const listing = await seed();
      const secret = "9 Harbour Row, Kinsale";
      const proposal = proposalFor(listing, {
        proposedContent: {
          ...proposalFor(listing).proposedContent,
          administrativeArea: secret,
          category: "not-a-category" as never,
        },
      });

      let caught: unknown;

      try {
        await persistence.db
          .insertInto("listing_revision")
          .values(serializePendingRevision(randomUUID(), proposal))
          .execute();
      } catch (cause) {
        caught = cause;
      }

      // Measured, not assumed: the driver really does carry the row, and it really is
      // enumerable — which is exactly why the repository never passes the error on.
      const detail = (caught as { detail?: string }).detail ?? "";

      expect(detail).toContain(secret);
      expect(Object.keys(caught as object)).toContain("detail");

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposal,
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      // An unrecognised violation stays unexpected, and carries only schema metadata.
      expect(created.error.code).toBe("STORAGE_FAILURE");

      const serialized = JSON.stringify(created.error);

      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("Harbour");
      expect(serialized).not.toContain("not-a-category");
      expect(serialized).not.toContain(CLUSTER_PASSWORD);
      expect(serialized).not.toContain("5432");

      // The cause is retained for diagnosis but kept **non-enumerable**, so it cannot escape
      // through `JSON.stringify`, a spread, or a structured logger walking own keys.
      expect(Object.keys(created.error)).not.toContain("cause");
      expect(JSON.stringify({ ...created.error })).not.toContain(secret);
      expect((created.error as { cause?: unknown }).cause).toBeDefined();

      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses a revision whose proposed content cannot be read at all",
    async () => {
      // The general shape check behind the specific ones: the domain's own
      // `isPendingRevision` proves the complete readable revision, so a proposal carrying a
      // number where a name belongs is refused by name rather than reaching SQL and failing
      // as a `STORAGE_FAILURE` — or worse, being stringified into a column.
      const listing = await seed();
      const proposal = {
        ...proposalFor(listing),
        proposedContent: { ...proposalFor(listing).proposedContent, name: 42 },
      } as unknown as ListingRevision;

      const created = await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposal,
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({
        code: "INVALID_PENDING_REVISION",
        reason: "unreadable-revision",
      });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each([
    ["an empty identifier", "", "unusable-revision-identifier"],
    ["a non-string identifier", 7 as unknown as string, "unusable-revision-identifier"],
  ])(
    "refuses %s before opening a transaction",
    async (_label, revisionId, reason) => {
      // `ADR-019` makes the identifier application-supplied, and the `uuid` cast would
      // silently stringify a non-string — so the boundary refuses it rather than storing
      // whatever `String(…)` produced.
      const listing = await seed();

      const created = await createPendingRevision(persistence.db, {
        revisionId,
        revision: proposalFor(listing),
      });

      expect(created.ok).toBe(false);

      if (created.ok) return;

      expect(created.error).toEqual({ code: "INVALID_PENDING_REVISION", reason });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaves no transaction open and no session blocked, on success or refusal",
    async () => {
      // Every refusal inside the protocol is raised so that the transaction **rolls back**
      // rather than committing a no-op, and every path releases its connection. A session
      // left `idle in transaction` would hold the `PS-11` lock indefinitely, which is the
      // most expensive leak this boundary could produce.
      const listing = await seed();

      expect(await sessionsInTransaction()).toBe(0);

      // Refusal before the transaction, refusal inside it, and the committing path.
      await createPendingRevision(persistence.db, {
        revisionId: "",
        revision: proposalFor(listing),
      });

      expect(await sessionsInTransaction()).toBe(0);

      await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing, {
          baseListingLastUpdatedAt: instant(APPROVED_AT - 1),
        }),
      });

      expect(await sessionsInTransaction()).toBe(0);
      expect(await pendingRowCount(listing)).toBe(0);

      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      expect(await sessionsInTransaction()).toBe(0);

      // And a refusal that happens *after* the lock is taken releases it too, so the next
      // participant is not blocked.
      await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      expect(await sessionsInTransaction()).toBe(0);
      expect(await pendingRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("retrieving the sole pending revision", () => {
  it(
    "reports not found for a listing with no proposal, and for one that does not exist",
    async () => {
      const listing = await seed();

      expect(await findPendingRevisionByListing(persistence.db, listing.id)).toEqual({
        ok: false,
        error: { code: "PENDING_REVISION_NOT_FOUND" },
      });

      expect(
        await findPendingRevisionByListing(persistence.db, listingIdOf(randomUUID())),
      ).toEqual({ ok: false, error: { code: "PENDING_REVISION_NOT_FOUND" } });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "ignores another listing's proposal, and a rejected one of its own",
    async () => {
      const mine = await seed();
      const theirs = await seed();

      await createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(theirs),
      });

      // A rejected row of my own: real history, retained under `FR-AUD-06`, and not what this
      // read returns. Rejection persistence exists (issue #199), but it is not what is under
      // test here — this is a fixture for the read's contract, so the row is written by raw SQL
      // rather than through a path whose own behaviour would then be in the assertion.
      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          rejected_at, base_listing_last_updated_at
        ) values (
          ${randomUUID()}::uuid, ${listingText(mine)}::uuid, 'rejected', 'Old', 'retail-shopping',
          'Superseded.', 'Kinsale', 'IE',
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval,
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
        )
      `.execute(persistence.db);

      expect(await findPendingRevisionByListing(persistence.db, mine.id)).toEqual({
        ok: false,
        error: { code: "PENDING_REVISION_NOT_FOUND" },
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "never exposes the physical revision identifier",
    async () => {
      const listing = await seed();
      const revisionId = randomUUID();

      await createPendingRevision(persistence.db, {
        revisionId,
        revision: proposalFor(listing),
      });

      const found = await findPendingRevisionByListing(persistence.db, listing.id);

      expect(found.ok).toBe(true);

      if (!found.ok) return;

      // `DDM-2`'s revision identity domain type is open, and this slice must not surface one.
      expect(JSON.stringify(found.value)).not.toContain(revisionId);
      expect(Object.keys(found.value).sort()).toEqual([
        "baseListingLastUpdatedAt",
        "listingId",
        "proposedContent",
        "state",
      ]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each([
    [
      "an unapproved category",
      { category: "not-a-category" },
      { code: "UNAPPROVED_CATEGORY", column: "category" },
    ],
    [
      "a rejection anchor on a pending row",
      { rejected_at: APPROVED_AT },
      { code: "REJECTION_TIMESTAMP_NOT_APPLICABLE", column: "rejected_at" },
    ],
  ])(
    "reports a stored row with %s as unreadable, never as missing",
    async (_label, mutation, expected) => {
      // Stored through the database whose revision `CHECK`s were dropped, so the read path's
      // classification is proved against a row that genuinely exists on disk.
      const listing = approvedListing();
      const stored = await insertSubmittedListing(hostile.db, listing);

      expect(stored.ok).toBe(true);

      const state = "state" in mutation ? (mutation as { state: string }).state : "pending";
      const category =
        "category" in mutation ? (mutation as { category: string }).category : "food-drink";
      const rejectedAt = "rejected_at" in mutation ? APPROVED_AT : null;

      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          rejected_at, base_listing_last_updated_at
        ) values (
          ${randomUUID()}::uuid, ${listingText(listing)}::uuid, ${state}, 'Hostile', ${category},
          'Stored despite the domain.', 'Kinsale', 'IE',
          ${
            rejectedAt === null
              ? sql`null`
              : sql`to_timestamp(0) + ((${rejectedAt}::bigint)::text || ' milliseconds')::interval`
          },
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
        )
      `.execute(hostile.db);

      const found = await findPendingRevisionByListing(hostile.db, listing.id);

      expect(found.ok).toBe(false);

      if (found.ok) return;

      // A row that exists but cannot be represented is a different, louder problem than a row
      // that is absent, and it must never be reported as the latter.
      expect(found.error.code).not.toBe("PENDING_REVISION_NOT_FOUND");
      expect(found.error).toEqual({ code: "REVISION_UNREADABLE", failure: expected });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it.each(["approved", "draft"])(
    "answers not-found for a stored %s row, because the query selects pending rows only",
    async (state) => {
      // **The honest boundary of this read, recorded rather than glossed.** The statement
      // filters `state = 'pending'`, so a row in any other state is simply not selected and the
      // answer is *not found* — which is the governed answer: a listing whose only proposal is
      // rejected has no pending revision, and reporting "unreadable" would be wrong.
      //
      // The consequence is that the mapper's three state branches — `UNKNOWN_REVISION_STATE`,
      // `UNPERSISTABLE_REVISION_STATE` and `REVISION_NOT_PENDING` — are **defensive** on this
      // path rather than reachable through it. They are proved directly in
      // `revision-mapping.test.ts`, and they exist for the later unit that reads revisions
      // without a state filter (rejected history), which must not be able to reach a domain
      // value for a row the lifecycle cannot produce.
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          rejected_at, base_listing_last_updated_at
        ) values (
          ${randomUUID()}::uuid, ${listingText(listing)}::uuid, ${state}, 'Applied',
          'retail-shopping', 'Not a pending proposal.', 'Kinsale', 'IE', null,
          to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
        )
      `.execute(hostile.db);

      const found = await findPendingRevisionByListing(hostile.db, listing.id);

      expect(found).toEqual({ ok: false, error: { code: "PENDING_REVISION_NOT_FOUND" } });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "fails loudly on impossible multiplicity rather than picking one",
    async () => {
      // `DI-11`'s index makes this unreachable in the verified database. Proved here by
      // dropping the index on the hostile one, because an invariant that is never tested
      // against its own violation is an invariant nobody has checked.
      const listing = approvedListing();

      expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

      await sql`drop index listing_revision_one_pending_per_listing`.execute(hostile.db);

      for (const name of ["First", "Second"]) {
        await sql`
          insert into listing_revision (
            id, listing_id, state, name, category, description, locality, country,
            rejected_at, base_listing_last_updated_at
          ) values (
            ${randomUUID()}::uuid, ${listingText(listing)}::uuid, 'pending', ${name}, 'retail-shopping',
            'Two pending proposals.', 'Kinsale', 'IE', null,
            to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
          )
        `.execute(hostile.db);
      }

      const found = await findPendingRevisionByListing(hostile.db, listing.id);

      expect(found.ok).toBe(false);

      if (found.ok) return;

      expect(found.error).toEqual({ code: "MULTIPLE_PENDING_REVISIONS", count: 2 });

      // The rows that proved the point are removed before the index returns — a unique index
      // cannot be built over the violation it exists to prevent — so the invariant is restored
      // rather than left dropped for whatever runs next.
      await sql`
        delete from listing_revision where listing_id = ${listingText(listing)}::uuid
      `.execute(hostile.db);

      await sql`
        create unique index listing_revision_one_pending_per_listing
          on listing_revision (listing_id)
          where state = 'pending'
      `.execute(hostile.db);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the ADR-024 protocol, under real concurrency", () => {
  /**
   * Hold the listing lock and insert a pending revision **without modifying the listing row**.
   *
   * This is the precise shape of `PS-11`'s visibility requirement: a participant may create a
   * revision while only *locking* the listing, so a later participant must not infer "no conflict"
   * from having acquired the lock. The caller decides when this transaction commits.
   */
  async function rivalHoldingTheLock(listing: Listing) {
    const trx = await rival.db
      .startTransaction()
      .setIsolationLevel("read committed")
      .execute();

    await trx
      .selectFrom("listing")
      .select("id")
      .where("id", "=", listingText(listing))
      .forUpdate()
      .execute();

    await trx
      .insertInto("listing_revision")
      .values(serializePendingRevision(randomUUID(), proposalFor(listing)))
      .execute();

    return trx;
  }

  it(
    "interleaving 1 — create versus create: exactly one wins, and DI-11 refuses the other",
    async () => {
      // Both participants run the real boundary. The listing lock serializes them, so the
      // *outcome set* is deterministic even though which one arrives first is not: one insert,
      // one refusal, and no third possibility.
      const listing = await seed();

      const [first, second] = await Promise.all([
        createPendingRevision(persistence.db, {
          revisionId: randomUUID(),
          revision: proposalFor(listing),
        }),
        createPendingRevision(persistence.db, {
          revisionId: randomUUID(),
          revision: proposalFor(listing),
        }),
      ]);

      const succeeded = [first, second].filter((outcome) => outcome.ok);
      const refused = [first, second].filter((outcome) => !outcome.ok);

      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);

      const failure = refused[0];

      if (failure === undefined || failure.ok) return;

      // Refused by the protocol, under the lock — not by the index backstop.
      expect(failure.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
      expect(await pendingRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 2 — the discriminating case: a lock-only participant's revision is still seen",
    async () => {
      // `ADR-024` rejected `REPEATABLE READ` precisely here. The participant under test begins
      // its transaction and blocks on the lock **before** the rival commits, so a stable
      // snapshot would never observe the rival's revision; under `READ COMMITTED` the post-lock
      // read takes a fresh statement snapshot and does. The rival never modifies the listing
      // row, so nothing about this conflict can be inferred from lock acquisition alone.
      const listing = await seed();
      const trx = await rivalHoldingTheLock(listing);

      const blocked = createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      // Synchronised on the server's own published fact, not on a timer.
      await awaitLockWaiter();

      await trx.commit().execute();

      const outcome = await blocked;

      expect(outcome.ok).toBe(false);

      if (outcome.ok) return;

      expect(outcome.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
      expect(await pendingRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 3 — a stale token is refused even when the lock was waited for",
    async () => {
      // The rival advances the listing while holding the lock, so the participant under test
      // reads the *new* version the moment it acquires the lock. Staleness is therefore decided
      // on committed state, and is still distinct from a `DI-11` refusal.
      const listing = await seed();
      const trx = await rival.db
        .startTransaction()
        .setIsolationLevel("read committed")
        .execute();

      await trx
        .selectFrom("listing")
        .select("id")
        .where("id", "=", listingText(listing))
        .forUpdate()
        .execute();

      await sql`
        update listing set last_updated_at = to_timestamp(0) + ((${APPROVED_AT + 7}::bigint)::text
          || ' milliseconds')::interval
         where id = ${listingText(listing)}::uuid
      `.execute(trx);

      const blocked = createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      await awaitLockWaiter();
      await trx.commit().execute();

      const outcome = await blocked;

      expect(outcome.ok).toBe(false);

      if (outcome.ok) return;

      expect(outcome.error).toEqual({ code: "STALE_LISTING_VERSION" });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 4 — a listing deleted by the rival is reported missing, not stale",
    async () => {
      // The nearest honest analogue of "missing" under concurrency: the row is gone by the time
      // the lock is granted. It must be reported as missing rather than folded into staleness.
      const listing = await seed();
      const trx = await rival.db
        .startTransaction()
        .setIsolationLevel("read committed")
        .execute();

      await trx
        .selectFrom("listing")
        .select("id")
        .where("id", "=", listingText(listing))
        .forUpdate()
        .execute();

      await sql`delete from listing where id = ${listingText(listing)}::uuid`.execute(trx);

      const blocked = createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      await awaitLockWaiter();
      await trx.commit().execute();

      const outcome = await blocked;

      expect(outcome.ok).toBe(false);

      if (outcome.ok) return;

      expect(outcome.error).toEqual({ code: "LISTING_NOT_FOUND" });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 5 — the DI-11 backstop is live, and fires on its own constraint",
    async () => {
      // The index is integrity, not performance (`ADR-017`), so its liveness is asserted
      // directly against the governed database rather than inferred from the protocol never
      // reaching it. Two pending rows for one listing must be impossible at the store level.
      const listing = await seed();

      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      let caught: { code?: string; constraint?: string } = {};

      try {
        await sql`
          insert into listing_revision (
            id, listing_id, state, name, category, description, locality, country,
            rejected_at, base_listing_last_updated_at
          ) values (
            ${randomUUID()}::uuid, ${listingText(listing)}::uuid, 'pending', 'Second', 'retail-shopping',
            'Bypassing the protocol entirely.', 'Kinsale', 'IE', null,
            to_timestamp(0) + ((${APPROVED_AT}::bigint)::text || ' milliseconds')::interval
          )
        `.execute(persistence.db);
      } catch (cause) {
        caught = cause as { code?: string; constraint?: string };
      }

      expect(caught.code).toBe("23505");
      expect(caught.constraint).toBe("listing_revision_one_pending_per_listing");
      expect(await pendingRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 6 — the backstop is never the normal detector",
    async () => {
      // `ADR-024`: the `DI-11` refusal is *"decided under the lock, not by the index"*. Every
      // ordinary second proposal must therefore be refused before any insert is attempted, so
      // the index never fires on the governed path — which is what makes a `23505` on it a fault
      // to surface rather than an ordinary outcome.
      const listing = await seed();

      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const refused = await createPendingRevision(persistence.db, {
          revisionId: randomUUID(),
          revision: proposalFor(listing),
        });

        expect(refused.ok).toBe(false);

        if (refused.ok) return;

        expect(refused.error.code).toBe("PENDING_REVISION_ALREADY_EXISTS");
        expect(refused.error.code).not.toBe("PENDING_UNIQUENESS_CONFLICT");
        expect(refused.error.code).not.toBe("STORAGE_FAILURE");
      }

      expect(await pendingRowCount(listing)).toBe(1);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 7 — a listing the rival un-approves cannot accept a proposal",
    async () => {
      const listing = await seed();
      const trx = await rival.db
        .startTransaction()
        .setIsolationLevel("read committed")
        .execute();

      await trx
        .selectFrom("listing")
        .select("id")
        .where("id", "=", listingText(listing))
        .forUpdate()
        .execute();

      await sql`
        update listing
           set status = 'pending', publication_state = null, unpublish_reason = null
         where id = ${listingText(listing)}::uuid
      `.execute(trx);

      const blocked = createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalFor(listing),
      });

      await awaitLockWaiter();
      await trx.commit().execute();

      const outcome = await blocked;

      expect(outcome.ok).toBe(false);

      if (outcome.ok) return;

      expect(outcome.error).toEqual({ code: "LISTING_NOT_APPROVED", status: "pending" });
      expect(await pendingRowCount(listing)).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "holds the listing lock through commit, so a rival cannot interleave a second proposal",
    async () => {
      // The lock's duration is the protocol's load-bearing property: released early, two
      // participants could both pass their post-lock read. Proved by observing that a rival
      // which takes the same lock after a successful create sees exactly one pending row.
      const listing = await seed();

      expect(
        (
          await createPendingRevision(persistence.db, {
            revisionId: randomUUID(),
            revision: proposalFor(listing),
          })
        ).ok,
      ).toBe(true);

      const trx = await rival.db
        .startTransaction()
        .setIsolationLevel("read committed")
        .execute();

      const locked = await trx
        .selectFrom("listing")
        .select(["id", "last_updated_at"])
        .where("id", "=", listingText(listing))
        .forUpdate()
        .execute();

      const pending = await trx
        .selectFrom("listing_revision")
        .select("id")
        .where("listing_id", "=", listingText(listing))
        .where("state", "=", "pending")
        .execute();

      await trx.rollback().execute();

      expect(locked).toHaveLength(1);
      expect(locked[0]?.last_updated_at).toBe(APPROVED_AT);
      expect(pending).toHaveLength(1);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("ADR-025 enforcement under real concurrency (issue #207)", () => {
  /**
   * The one interleaving this unit adds, and the only one it needs.
   *
   * Everything else is already proved and is **relied upon rather than duplicated**: create
   * versus create and `DI-11` under the lock by *interleaving 1*; `PS-11` visibility of a
   * lock-only participant's committed revision by *interleaving 2*; the stale token after a
   * lock wait by *interleaving 3*; a missing listing by *interleaving 4*; the `DI-11` backstop
   * by *interleavings 5 and 6*; an un-approved listing by *interleaving 7*; and lock-first
   * behaviour by *"holds the listing lock through commit"*. None of them becomes weaker because
   * a designation check now runs later in the same transaction.
   *
   * What none of them can show is **which listing content the policy compared against**, because
   * before this unit no content was read at all. So: a rival takes the lock and **commits a
   * designation change without inserting any revision**, while the boundary under test is
   * already blocked on that lock. The proposal under test is lawful against the rival's
   * committed content and **unlawful against the content that existed before it** — so the
   * outcome itself discriminates, with no inspection of internals.
   */
  it(
    "compares against the content a rival committed while the operation waited for the lock",
    async () => {
      // Stored private. A proposal to publish this value would be a refused widening.
      const listing = await seed(listingWith({ phone: at("phone", false) }));

      const trx = await rival.db
        .startTransaction()
        .setIsolationLevel("read committed")
        .execute();

      await trx
        .selectFrom("listing")
        .select("id")
        .where("id", "=", listingText(listing))
        .forUpdate()
        .execute();

      // The business publishes its own phone. `last_updated_at` deliberately does **not** move:
      // this case is about designation, and advancing the token would make the proposal stale
      // and prove nothing about which content was compared.
      await sql`
        update listing
           set phone_designated_public = true
         where id = ${listingText(listing)}::uuid
      `.execute(trx);

      // The proposal keeps that value exactly, public and unchanged — lawful only against the
      // rival's committed row.
      const attempt = createPendingRevision(persistence.db, {
        revisionId: randomUUID(),
        revision: proposalWith(listing, { phone: at("phone", true) }),
      });

      // Observable lock state, read from `pg_stat_activity` through the named sentinel — not a
      // sleep, not a poll of the business outcome.
      await awaitLockWaiter();
      await trx.commit().execute();

      const created = await attempt;

      // Pre-lock content would have made this a `DESIGNATION_POLICY_REFUSED` widening of a
      // private value. It is accepted, so the comparison used the post-lock hydrated row.
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(await pendingRowCount(listing)).toBe(1);
      expect(await storedLastUpdatedAt(listing)).toBe(APPROVED_AT);
      expect(await sessionsInTransaction()).toBe(0);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the typed database still forbids what this slice did not authorize", () => {
  it("permits no revision update, and no rejected revision insert", () => {
    // The compile-time guards live in `second-schema-migration.test.ts`, where the declaration
    // is asserted against the live catalogue. This case records the runtime half of the claim:
    // nothing in this file updates a revision row or writes a rejection anchor through the
    // boundary, and the two raw-SQL writes above are deliberate hostile-row fixtures rather
    // than repository operations.
    expect(typeof createPendingRevision).toBe("function");
    expect(typeof findPendingRevisionByListing).toBe("function");
  });
});

/**
 * `ADR-025` enforcement at `OP-6` (issue #207).
 *
 * Every case here drives the **real** boundary against the **real** schema. The policy itself is
 * proved exhaustively in `src/domain/listing/designation.test.ts`; what these cases prove is the
 * *integration*: that the rule is reached, that it is handed the **locked, stored** listing
 * rather than anything the caller supplied, that a refusal happens **before** any write, and
 * that every pre-existing outcome keeps its place ahead of it.
 */

/** The four fields `ADR-025` governs, in the order the rule reports them. */
const DESIGNATABLE: readonly DesignatableField[] = ["postalCode", "phone", "email", "website"];

/** A value for each governed field, so a case can speak about one field without inventing data. */
const VALUE: Readonly<Record<DesignatableField, string>> = {
  postalCode: "P17 AB12",
  phone: "+353 21 123 4567",
  email: "hello@example.ie",
  website: "https://example.ie",
};

/** The listing's required content, so a case varies only the designatable fields. */
function baseContent(): ListingContent {
  return {
    name: "Harbour Bakery",
    category: "food-drink",
    description: "A small bakery.",
    locality: "Kinsale",
    country: "IE",
  };
}

type Designations = Partial<Record<DesignatableField, DesignatableValue>>;

/** A designatable value at the canonical carrier, with the designation a case asks for. */
function at(field: DesignatableField, designatedPublic: boolean): DesignatableValue {
  return { value: VALUE[field], designatedPublic };
}

/** An approved listing whose stored content carries exactly the designations supplied. */
function listingWith(designations: Designations): Listing {
  return approvedListing({ content: { ...baseContent(), ...designations } });
}

/** A proposal against `listing` carrying exactly the designations supplied, and nothing else. */
function proposalWith(listing: Listing, designations: Designations): PendingListingRevision {
  return proposalFor(listing, {
    proposedContent: { ...baseContent(), ...designations },
  });
}

/** Create through the production boundary, with a fresh application-supplied identifier. */
async function create(revision: PendingListingRevision) {
  return await createPendingRevision(persistence.db, {
    revisionId: randomUUID(),
    revision,
  });
}

/**
 * The listing row exactly as stored, so a refusal can be proved to have changed **nothing**.
 *
 * `select *` rather than named columns: a case that asserted only the columns it thought of
 * could not notice a write to one it did not.
 */
async function listingRow(listing: Listing): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>>`
    select * from listing where id = ${listingText(listing)}::uuid
  `.execute(persistence.db);

  const row = rows.rows[0];

  if (row === undefined) {
    throw new Error("the seeded listing is missing");
  }

  return row;
}

/** The sole stored revision row, or `undefined`. */
async function revisionRow(listing: Listing): Promise<Record<string, unknown> | undefined> {
  const rows = await sql<Record<string, unknown>>`
    select * from listing_revision where listing_id = ${listingText(listing)}::uuid
  `.execute(persistence.db);

  return rows.rows[0];
}

describe("OP-6 enforces ADR-025 when the revision is created", () => {
  describe("proposals ADR-025 permits", () => {
    it(
      "accepts a proposal in which all four designatable values are absent and unchanged",
      async () => {
        const listing = await seed(listingWith({}));

        const created = await create(proposalWith(listing, {}));

        expect(created.ok, JSON.stringify(created)).toBe(true);
        expect(await pendingRowCount(listing)).toBe(1);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "accepts exact-equal values whose designations are unchanged, public ones included",
      async () => {
        // The business's own public designation, carried forward on an unchanged value. The
        // policy permits it, and nothing here may quietly restrict it either.
        const designations: Designations = {
          postalCode: at("postalCode", true),
          phone: at("phone", false),
          email: at("email", true),
          website: at("website", false),
        };
        const listing = await seed(listingWith(designations));

        const proposal = proposalWith(listing, designations);

        expect((await create(proposal)).ok).toBe(true);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        expect(found.value.proposedContent).toEqual(proposal.proposedContent);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DESIGNATABLE)(
      "accepts restricting an exact-equal public %s to private",
      async (field) => {
        const listing = await seed(listingWith({ [field]: at(field, true) }));

        const proposal = proposalWith(listing, { [field]: at(field, false) });

        expect((await create(proposal)).ok).toBe(true);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        expect(found.value.proposedContent[field]).toEqual({
          value: VALUE[field],
          designatedPublic: false,
        });
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DESIGNATABLE)(
      "accepts an explicit removal of a public %s",
      async (field) => {
        // `ADR-017` makes the proposal a complete set, so an absent value is the caller saying
        // *remove it* — and a removal publishes nothing, so the policy always permits it.
        const listing = await seed(listingWith({ [field]: at(field, true) }));

        expect((await create(proposalWith(listing, {}))).ok).toBe(true);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        expect(Object.keys(found.value.proposedContent)).not.toContain(field);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DESIGNATABLE)(
      "accepts a private addition of %s",
      async (field) => {
        const listing = await seed(listingWith({}));

        expect((await create(proposalWith(listing, { [field]: at(field, false) }))).ok).toBe(true);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DESIGNATABLE)(
      "accepts a private replacement of %s",
      async (field) => {
        const listing = await seed(listingWith({ [field]: at(field, true) }));

        const replacement: DesignatableValue = { value: "something else", designatedPublic: false };

        expect((await create(proposalWith(listing, { [field]: replacement }))).ok).toBe(true);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        // No inheritance: the replaced value's public designation did not travel with it.
        expect(found.value.proposedContent[field]).toEqual(replacement);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "accepts several valid changes at once — a restriction, a removal, an addition and a replacement",
      async () => {
        const listing = await seed(
          listingWith({
            postalCode: at("postalCode", true),
            phone: at("phone", true),
            website: at("website", true),
          }),
        );

        const proposal = proposalWith(listing, {
          // restricted
          postalCode: at("postalCode", false),
          // removed: phone is absent
          // added
          email: at("email", false),
          // replaced
          website: { value: "https://example.ie/new", designatedPublic: false },
        });

        expect((await create(proposal)).ok).toBe(true);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        expect(found.value.proposedContent).toEqual(proposal.proposedContent);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "stores the accepted proposal exactly as supplied, with the original base token",
      async () => {
        const listing = await seed(listingWith({ email: at("email", true) }));
        const proposal = proposalWith(listing, {
          email: at("email", true),
          phone: at("phone", false),
        });

        expect((await create(proposal)).ok).toBe(true);

        const row = await revisionRow(listing);

        // The carriers are stored verbatim — nothing trimmed, folded, re-spelled or re-cased —
        // and the captured token is the caller's own, not the value just read under the lock.
        expect(row?.email).toBe(VALUE.email);
        expect(row?.email_designated_public).toBe(true);
        expect(row?.phone).toBe(VALUE.phone);
        expect(row?.phone_designated_public).toBe(false);
        expect(row?.base_listing_last_updated_at).toBe(APPROVED_AT);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        expect(found.value).toEqual(proposal);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "writes no listing row on the accepted path, and returns the existing success value",
      async () => {
        const listing = await seed(listingWith({ phone: at("phone", true) }));
        const before = await listingRow(listing);

        const created = await create(proposalWith(listing, { phone: at("phone", false) }));

        // `OP-6` changes content, never the effective public version: the success value carries
        // nothing, no identity escapes the adapter, and the listing row is bit-identical.
        expect(created).toEqual({ ok: true, value: undefined });
        expect(await listingRow(listing)).toEqual(before);
      },
      CLUSTER_TIMEOUT_MS,
    );
  });

  describe("proposals ADR-025 refuses", () => {
    it.each(DESIGNATABLE)(
      "refuses widening an unchanged private %s to public",
      async (field) => {
        const listing = await seed(listingWith({ [field]: at(field, false) }));

        const created = await create(proposalWith(listing, { [field]: at(field, true) }));

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({
          code: "DESIGNATION_POLICY_REFUSED",
          violations: [{ code: "DESIGNATION_WIDENING_REFUSED", field, change: "unchanged" }],
        });
        expect(await pendingRowCount(listing)).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DESIGNATABLE)(
      "refuses a public addition of %s",
      async (field) => {
        const listing = await seed(listingWith({}));

        const created = await create(proposalWith(listing, { [field]: at(field, true) }));

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({
          code: "DESIGNATION_POLICY_REFUSED",
          violations: [{ code: "DESIGNATION_WIDENING_REFUSED", field, change: "added" }],
        });
        expect(await pendingRowCount(listing)).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DESIGNATABLE)(
      "refuses a public replacement of %s, with no inheritance from the public original",
      async (field) => {
        const listing = await seed(listingWith({ [field]: at(field, true) }));

        const created = await create(
          proposalWith(listing, { [field]: { value: "different", designatedPublic: true } }),
        );

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({
          code: "DESIGNATION_POLICY_REFUSED",
          violations: [{ code: "DESIGNATION_WIDENING_REFUSED", field, change: "replaced" }],
        });
        expect(await pendingRowCount(listing)).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "returns every violation, in the rule's deterministic field order",
      async () => {
        const listing = await seed(
          listingWith({ postalCode: at("postalCode", false), email: at("email", true) }),
        );

        const created = await create(
          proposalWith(listing, {
            // unchanged private, widened
            postalCode: at("postalCode", true),
            // added public
            phone: at("phone", true),
            // replaced, asking to stay public
            email: { value: "other@example.ie", designatedPublic: true },
            // added public
            website: at("website", true),
          }),
        );

        expect(created.ok).toBe(false);

        if (created.ok) return;
        if (created.error.code !== "DESIGNATION_POLICY_REFUSED") {
          throw new Error(`expected a designation refusal, got ${created.error.code}`);
        }

        // Not merely "all four present": the **order** is the rule's own and is pinned here, so
        // a reordering in the adapter is a failure rather than a cosmetic difference.
        expect(created.error.violations).toEqual([
          { code: "DESIGNATION_WIDENING_REFUSED", field: "postalCode", change: "unchanged" },
          { code: "DESIGNATION_WIDENING_REFUSED", field: "phone", change: "added" },
          { code: "DESIGNATION_WIDENING_REFUSED", field: "email", change: "replaced" },
          { code: "DESIGNATION_WIDENING_REFUSED", field: "website", change: "added" },
        ]);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "refuses the whole proposal when one prohibited field accompanies otherwise valid changes",
      async () => {
        const listing = await seed(
          listingWith({ postalCode: at("postalCode", true), phone: at("phone", false) }),
        );

        const created = await create(
          proposalWith(listing, {
            // valid: restricted
            postalCode: at("postalCode", false),
            // valid: private replacement
            phone: { value: "+353 21 000 0000", designatedPublic: false },
            // the single offence
            email: at("email", true),
          }),
        );

        expect(created.ok).toBe(false);

        if (created.ok) return;

        // There is **no partial success**: the valid changes are not applied either.
        expect(created.error).toEqual({
          code: "DESIGNATION_POLICY_REFUSED",
          violations: [{ code: "DESIGNATION_WIDENING_REFUSED", field: "email", change: "added" }],
        });
        expect(await pendingRowCount(listing)).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "writes nothing at all: no revision row, no listing change, no timestamp advance, no coercion",
      async () => {
        const listing = await seed(listingWith({ website: at("website", false) }));
        const before = await listingRow(listing);

        const created = await create(proposalWith(listing, { website: at("website", true) }));

        expect(created.ok).toBe(false);
        // Not partially written, and not silently privatized and stored: there is no row.
        expect(await pendingRowCount(listing)).toBe(0);
        expect(await revisionRow(listing)).toBeUndefined();
        expect(await listingRow(listing)).toEqual(before);
        expect(await storedLastUpdatedAt(listing)).toBe(APPROVED_AT);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "keeps the refusal distinct from invalid input and from staleness",
      async () => {
        const listing = await seed(listingWith({ phone: at("phone", false) }));

        const created = await create(proposalWith(listing, { phone: at("phone", true) }));

        expect(created.ok).toBe(false);

        if (created.ok) return;

        const code: string = created.error.code;

        expect(code).toBe("DESIGNATION_POLICY_REFUSED");
        expect(code).not.toBe("INVALID_PENDING_REVISION");
        expect(code).not.toBe("STALE_LISTING_VERSION");
        // And it carries no value — only the field and what happened to it.
        expect(JSON.stringify(created.error)).not.toContain(VALUE.phone);
      },
      CLUSTER_TIMEOUT_MS,
    );
  });

  describe("no normalization, in the integrated path", () => {
    /** Carrier differences `ADR-025` refuses to treat as equality. Each is a replacement. */
    const DIFFERENCES: readonly {
      readonly label: string;
      readonly field: DesignatableField;
      readonly stored: string;
      readonly proposed: string;
    }[] = [
      { label: "whitespace", field: "postalCode", stored: "P17 AB12", proposed: "P17AB12" },
      { label: "case", field: "postalCode", stored: "P17 AB12", proposed: "p17 ab12" },
      {
        label: "phone formatting",
        field: "phone",
        stored: "+353 21 123 4567",
        proposed: "+353211234567",
      },
      {
        label: "email case",
        field: "email",
        stored: "hello@example.ie",
        proposed: "Hello@Example.ie",
      },
      {
        label: "URL spelling",
        field: "website",
        stored: "https://example.ie",
        proposed: "https://example.ie/",
      },
    ];

    it.each(DIFFERENCES)(
      "treats a $label difference as a replacement and refuses it public",
      async ({ field, stored, proposed }) => {
        const listing = await seed(
          listingWith({ [field]: { value: stored, designatedPublic: true } }),
        );

        const created = await create(
          proposalWith(listing, { [field]: { value: proposed, designatedPublic: true } }),
        );

        expect(created.ok).toBe(false);

        if (created.ok) return;

        // `"replaced"`, not `"unchanged"` — which is the whole of the no-normalization rule,
        // observed through the classification the refusal carries.
        expect(created.error).toEqual({
          code: "DESIGNATION_POLICY_REFUSED",
          violations: [{ code: "DESIGNATION_WIDENING_REFUSED", field, change: "replaced" }],
        });
      },
      CLUSTER_TIMEOUT_MS,
    );

    it.each(DIFFERENCES)(
      "persists a $label difference exactly when it is designated private",
      async ({ field, stored, proposed }) => {
        const listing = await seed(
          listingWith({ [field]: { value: stored, designatedPublic: true } }),
        );

        expect(
          (
            await create(
              proposalWith(listing, { [field]: { value: proposed, designatedPublic: false } }),
            )
          ).ok,
        ).toBe(true);

        const found = await findPendingRevisionByListing(persistence.db, listing.id);

        expect(found.ok).toBe(true);

        if (!found.ok) return;

        // Stored byte for byte as supplied: the adapter normalizes nothing on the way in either.
        expect(found.value.proposedContent[field]).toEqual({
          value: proposed,
          designatedPublic: false,
        });
      },
      CLUSTER_TIMEOUT_MS,
    );
  });

  describe("failure precedence — designation never displaces an earlier outcome", () => {
    /** A proposal that is designation-invalid, so each case below is genuinely ambiguous. */
    function widening(listing: Listing): PendingListingRevision {
      return proposalWith(listing, { email: at("email", true) });
    }

    it(
      "reports a missing listing rather than the designation refusal",
      async () => {
        const absent = listingWith({});

        const created = await create(widening(absent));

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({ code: "LISTING_NOT_FOUND" });
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "reports an ineligible lifecycle state rather than the designation refusal",
      async () => {
        const listing = await seed(
          approvedListing({
            content: baseContent(),
            status: "pending",
            publication: undefined,
          }),
        );

        const created = await create(widening(listing));

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({ code: "LISTING_NOT_APPROVED", status: "pending" });
        expect(await pendingRowCount(listing)).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "reports an existing pending revision rather than the designation refusal",
      async () => {
        const listing = await seed(listingWith({}));

        expect((await create(proposalWith(listing, {}))).ok).toBe(true);

        const created = await create(widening(listing));

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
        expect(await pendingRowCount(listing)).toBe(1);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "reports a stale base token rather than the designation refusal",
      async () => {
        // `ADR-023` requires staleness never be mislabelled. Read the other way: a proposal
        // prepared against a version that no longer exists is *stale*, whatever else is wrong
        // with it, because the comparison it would fail was made against the wrong listing.
        const listing = await seed(listingWith({}));
        const stale = proposalFor(listing, {
          proposedContent: { ...baseContent(), email: at("email", true) },
          baseListingLastUpdatedAt: instant(APPROVED_AT - 1),
        });

        const created = await create(stale);

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({ code: "STALE_LISTING_VERSION" });
        expect(await pendingRowCount(listing)).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "reports unreadable content through the existing pre-transaction validation path",
      async () => {
        const listing = await seed(listingWith({}));
        const malformed = proposalFor(listing, {
          proposedContent: { ...baseContent(), name: 42 } as unknown as ListingContent,
        });

        const created = await create(malformed);

        expect(created.ok).toBe(false);

        if (created.ok) return;

        // Refused before a transaction is even opened, and therefore before the policy could
        // have been asked about content it is not allowed to judge.
        expect(created.error).toEqual({
          code: "INVALID_PENDING_REVISION",
          reason: "unreadable-revision",
        });
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "keeps the existing storage classification when a valid proposal collides on identity",
      async () => {
        const listing = await seed(listingWith({}));
        const revisionId = randomUUID();

        expect(
          (
            await createPendingRevision(persistence.db, {
              revisionId,
              revision: proposalWith(listing, { phone: at("phone", false) }),
            })
          ).ok,
        ).toBe(true);

        const other = await seed(listingWith({}));

        // Designation-valid, so enforcement succeeds and the failure can only come from the
        // write itself — which must still be classified exactly as it was before this unit.
        const created = await createPendingRevision(persistence.db, {
          revisionId,
          revision: proposalWith(other, { phone: at("phone", false) }),
        });

        expect(created.ok).toBe(false);

        if (created.ok) return;

        expect(created.error).toEqual({ code: "REVISION_ALREADY_EXISTS" });
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "reports a stored listing the domain cannot represent, safely and as its own outcome",
      async () => {
        const listing = approvedListing({ content: baseContent() });

        expect((await insertSubmittedListing(hostile.db, listing)).ok).toBe(true);

        // A category no governed key admits — storable only because this database's `CHECK`
        // was dropped, which is how a corrupt row reaches hydration at all.
        await sql`
          update listing
             set category = 'not-a-governed-category'
           where id = ${listingText(listing)}::uuid
        `.execute(hostile.db);

        const created = await createPendingRevision(hostile.db, {
          revisionId: randomUUID(),
          revision: proposalFor(listing, { proposedContent: baseContent() }),
        });

        expect(created.ok).toBe(false);

        if (created.ok) return;

        // Its own outcome: not "missing", not a caller error, not a storage failure.
        expect(created.error).toEqual({
          code: "STORED_LISTING_UNREADABLE",
          failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
        });

        // Safe: a code and a column, and nothing of the row, the value, the SQL or the server.
        const rendered = JSON.stringify(created.error);

        expect(rendered).not.toContain("not-a-governed-category");
        expect(rendered).not.toContain(CLUSTER_PASSWORD);
        expect(rendered).not.toContain("select");

        const rows = await sql<{ count: number }>`
          select count(*)::int as count
            from listing_revision
           where listing_id = ${listingText(listing)}::uuid
        `.execute(hostile.db);

        expect(rows.rows[0]?.count).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );
  });

  describe("the statements PostgreSQL actually received", () => {
    it(
      "locks the complete listing row first, and inserts exactly once on the accepted path",
      async () => {
        const listing = await seed(listingWith({ email: at("email", true) }));

        capturing.reset();

        const created = await createPendingRevision(capturing.db, {
          revisionId: randomUUID(),
          revision: proposalWith(listing, { email: at("email", false) }),
        });

        expect(created.ok, JSON.stringify(created)).toBe(true);

        const statements = [...capturing.statements];
        const lock = indexOfStatement(statements, LISTING_LOCK);
        const pending = indexOfStatement(statements, PENDING_READ);
        const insert = indexOfStatement(statements, REVISION_INSERT);

        // The lock is the first *state* read — nothing but transaction control precedes it.
        expect(lock).toBeGreaterThanOrEqual(0);
        expect(
          statements
            .slice(0, lock)
            .every((statement) => /^\s*(begin|set|start)\b/i.test(statement.sql)),
        ).toBe(true);

        // It now reads the whole row, which is what makes the designation comparison possible.
        const locked = statements[lock] as CapturedStatement;

        expect(locked.sql).toMatch(/for update/i);
        // The whole row, not the three columns this statement used to project. `selectAll()`
        // compiles to `select *`, so the evidence is the projection itself: the designation
        // columns are in the result set, which is what the policy comparison consumes.
        expect(locked.sql).toMatch(/^\s*select\s+\*\s+from\s+"listing"/i);
        expect(locked.sql).not.toContain("last_updated_at");

        // Governed order, unmoved: lock, then the pending read, then the single write.
        expect(pending).toBeGreaterThan(lock);
        expect(insert).toBeGreaterThan(pending);
        expect(writesIn(statements)).toHaveLength(1);
        expect(writesIn(statements)[0]?.sql).toMatch(REVISION_INSERT);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "executes no write at all when the designation policy refuses, and rolls back",
      async () => {
        const listing = await seed(listingWith({ website: at("website", false) }));

        capturing.reset();

        const created = await createPendingRevision(capturing.db, {
          revisionId: randomUUID(),
          revision: proposalWith(listing, { website: at("website", true) }),
        });

        expect(created.ok).toBe(false);

        const statements = [...capturing.statements];

        // The decisive statement-level fact: the rule ran after the lock and the pending read,
        // and **nothing** was prepared or executed that writes.
        expect(indexOfStatement(statements, LISTING_LOCK)).toBeGreaterThanOrEqual(0);
        expect(indexOfStatement(statements, PENDING_READ)).toBeGreaterThan(
          indexOfStatement(statements, LISTING_LOCK),
        );
        expect(writesIn(statements)).toHaveLength(0);
        expect(indexOfStatement(statements, REVISION_INSERT)).toBe(-1);
        // And the operation ran **once**: `ADR-024` authorizes no retry, so a second attempt
        // would show here as a second lock even though the returned failure looked identical.
        expect(statements.filter((statement) => LISTING_LOCK.test(statement.sql))).toHaveLength(1);
        expect(statements.some((statement) => /^\s*commit\b/i.test(statement.sql))).toBe(false);

        // The listing is untouched, and no session is left holding a transaction open.
        expect(await pendingRowCount(listing)).toBe(0);
        expect(await storedLastUpdatedAt(listing)).toBe(APPROVED_AT);
        expect(await sessionsInTransaction()).toBe(0);
      },
      CLUSTER_TIMEOUT_MS,
    );

    it(
      "writes no listing UPDATE on either path",
      async () => {
        const listing = await seed(listingWith({ phone: at("phone", false) }));

        capturing.reset();

        await createPendingRevision(capturing.db, {
          revisionId: randomUUID(),
          revision: proposalWith(listing, { phone: at("phone", true) }),
        });
        await createPendingRevision(capturing.db, {
          revisionId: randomUUID(),
          revision: proposalWith(listing, { phone: at("phone", false) }),
        });

        expect(
          capturing.statements.filter((statement) => /^\s*update\s+"listing"/i.test(statement.sql)),
        ).toHaveLength(0);
      },
      CLUSTER_TIMEOUT_MS,
    );
  });
});
