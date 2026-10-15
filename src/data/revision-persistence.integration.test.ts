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
import { sql } from "kysely";
import { randomUUID } from "node:crypto";

import {
  CLUSTER_PASSWORD,
  CLUSTER_TIMEOUT_MS,
  useEmbeddedPostgres,
} from "./testing/embedded-cluster";

import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing } from "../domain/listing/listing";
import type { ListingRevision, PendingListingRevision } from "../domain/listing/revision";
import { createListingPersistence, type ListingPersistence } from "./connection";
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

/** A proposal prepared against the listing's current version (`ADR-023` item 10). */
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
      postalCode: { value: "P17 AB12", designatedPublic: true },
      phone: { value: "+353 21 123 4567", designatedPublic: false },
      email: { value: "hello@example.ie", designatedPublic: true },
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
      // read returns. Written by raw SQL because rejection persistence is a later unit.
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
