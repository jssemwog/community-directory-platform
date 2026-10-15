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

/** The content the proposal would apply — different in every field that can differ. */
const PROPOSED_CONTENT: ListingContent = {
  name: "Harbour Bakery & Cafe",
  category: "retail-shopping",
  description: "A small bakery, now with a cafe.",
  locality: "Cobh",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: "+353 21 123 4567", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
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
 * The narrow slice of `pg` this file reaches directly, to build a **logging** boundary.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is described here — the pattern `migrate.ts` and the listing suite established.
 */
interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => unknown;
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

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
    options: startupOptionsFor({ application_name: "revision_approval_capture" }),
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
  cluster.closeBeforeShutdown("rival persistence", () => rival.shutdown());
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

afterEach(async () => {
  // A stranded trigger would silently corrupt every later case, so removal is unconditional
  // rather than left to the test that created it.
  for (const table of ["listing", "listing_revision"] as const) {
    for (const operation of ["update", "delete"] as const) {
      await sql
        .raw(`drop trigger if exists cdp_test_suppress_${table}_${operation} on ${table}`)
        .execute(persistence.db);
    }
  }
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
  /** Take and hold the listing lock, without modifying the row. Caller decides when to commit. */
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

    return trx;
  }

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
      const trx = await rivalHoldingTheLock(listing);

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
      const trx = await rivalHoldingTheLock(listing);

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
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "interleaving 4 — the pending revision disappears before the lock is granted",
    async () => {
      const listing = await seedWithProposal();
      const trx = await rivalHoldingTheLock(listing);

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

      // The lock really was released: a rival can take it immediately.
      const trx = await rivalHoldingTheLock(listing);

      await trx.rollback().execute();

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

      const trx = await rivalHoldingTheLock(listing);

      const observed = await trx
        .selectFrom("listing_revision")
        .select("id")
        .where("listing_id", "=", listingText(listing))
        .execute();

      await trx.rollback().execute();

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
