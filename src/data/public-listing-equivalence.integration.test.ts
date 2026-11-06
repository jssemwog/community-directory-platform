/**
 * `BI-4` — the four-way equivalence of the public read path's negative outcome (issue #246),
 * against a real PostgreSQL server.
 *
 * The property is not "each non-public case returns not-available" (#244 already shows that); it
 * is that **never existed, pending, rejected and unpublished cannot be told apart** by an
 * unauthorised observer. Each test below compares the four cases with one another on what the read
 * path returns: `OP-2`'s outcome value and shape, and `OP-1`'s count and order. Alongside them, a
 * statement-footprint check is **structural evidence only**: it shows the application sends the
 * same statement for each case, not that the database does the same work or answers in the same
 * time.
 *
 * Listings reach their states through the real operations where they exist — submission, approval
 * (`OP-7`) and rejection (`OP-8`). Unpublishing (`OP-9`) is not implemented, so that state is
 * written directly as a store state, not as a claim about any operation.
 *
 * ## Slice 2: fixed identities and explicit baselines
 *
 * `OP-2` is also probed along two lineages, each with one fixed identity. One stored row cannot
 * be both rejected and unpublished, because rejection and approval both start from pending. Each
 * lineage first reads its identity before it has ever been inserted; that read is the
 * never-existed baseline. Every later negative read of the same identity is compared with it,
 * outcome and statements alike, with SQL and parameters unmasked. A positive control shows the
 * unpublished lineage's identity readable while it is approved and published, and it is kept out
 * of every negative comparison. `OP-1` is compared with an explicit public-only baseline: first
 * each non-public state alone, then all three together. The non-public rows are placed before,
 * between and after the public ones by `OP-1`'s sort key, `listing.id`, which is a `uuid`. Every
 * fixture's stored state is verified before it is read.
 *
 * ## What this suite does not prove
 *
 * **Execution or timing.** Identical SQL text is not evidence of identical execution or response
 * time, and no test here asserts a query plan or executor behaviour: those are implementation
 * details that a future change may legitimately alter. *Observation only, not asserted:* under the
 * conditions of #246 (embedded PostgreSQL, a handful of rows), `EXPLAIN ANALYZE` showed a
 * primary-key index scan with status and publication state applied as a filter, so a present
 * non-public row was fetched and removed by the filter while a never-existed key found no row. That
 * is a known possible source of a timing difference; whether it is observable was not measured.
 * Timing equivalence is **unresolved**: it needs its own measured method and threshold, which this
 * suite does not decide, and `BI-4` remains pending.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing, ListingContent } from "../domain/listing/listing";
import { createListingPersistence, startupOptionsFor, type ListingPersistence } from "./connection";
import { persistListingApproval } from "./listing-approval";
import { rejectPendingListing } from "./listing-rejection";
import { insertSubmittedListing } from "./listing-repository";
import type { ListingDatabase } from "./listing-table";
import { findPubliclyAvailableListing, listPubliclyAvailableListings } from "./public-listing-read";
import { timestamptzFromEpochMilliseconds } from "./row-mapping";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";

const DATABASE = "public_read_equivalence";

const cluster = useEmbeddedPostgres({
  slug: "public-equivalence",
  databases: [DATABASE],
  migrate: [DATABASE],
});

const TEST_TIMEOUT_MS = 15_000;

const T0 = 1_767_323_045_123;
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

const CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: "+353 21 999 0000", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: "https://private.example.ie" },
};

let persistence: ListingPersistence;

function textOf(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

async function submit(): Promise<Listing> {
  const listing: Listing = {
    id: listingIdOf(randomUUID()),
    status: "pending",
    content: CONTENT,
    timestamps: { submittedAt: instant(T0), lastUpdatedAt: instant(T0) },
  };

  expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

  return listing;
}

async function submitAndApprove(): Promise<Listing> {
  const listing = await submit();
  const approved = await persistListingApproval(persistence.db, {
    listingId: listing.id,
    viewedLastUpdatedAt: instant(T0),
    approvedAt: instant(T1),
  });

  expect(approved.ok, JSON.stringify(approved)).toBe(true);

  return listing;
}

async function submitAndReject(): Promise<Listing> {
  const listing = await submit();

  expect((await rejectPendingListing(persistence.db, { listingId: listing.id, rejectedAt: instant(T1) })).ok).toBe(
    true,
  );

  return listing;
}

/** Approved, then unpublished as a store state (`OP-9` is not implemented). */
async function approvedThenUnpublished(): Promise<Listing> {
  const listing = await submitAndApprove();
  const at = timestamptzFromEpochMilliseconds(T2);

  await sql`update listing set publication_state = 'unpublished', unpublish_reason = 'probe reason', last_updated_at = ${at} where id = ${textOf(listing)}::uuid`.execute(
    persistence.db,
  );

  return listing;
}

/** The four cases `BI-4` names, as identities a visitor could supply. */
async function fourCases(): Promise<ReadonlyArray<readonly [string, string]>> {
  return [
    ["never existed", randomUUID()],
    ["pending", textOf(await submit())],
    ["rejected", textOf(await submitAndReject())],
    ["unpublished", textOf(await approvedThenUnpublished())],
  ];
}

/* ------------------------------------------------------------------------------------------- */
/* Statement capture — footprint evidence, labelled as such                                       */
/* ------------------------------------------------------------------------------------------- */

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

interface CapturePool {
  on(event: "error", listener: (error: Error) => void): void;
  end(): Promise<void>;
}

const pg = createRequire(import.meta.url)("pg") as {
  readonly Pool: new (config: Record<string, unknown>) => CapturePool;
};

const captured: CapturedStatement[] = [];
let capturePool: CapturePool;
let capturingDb: Kysely<ListingDatabase>;

beforeAll(async () => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 2 },
  });

  capturePool = new pg.Pool({
    connectionString: cluster.connectionStringFor(DATABASE),
    max: 1,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: "public_equivalence_capture" }),
  });
  // An idle client terminated at cluster shutdown must not surface as an unhandled error.
  capturePool.on("error", () => {});

  capturingDb = new Kysely<ListingDatabase>({
    dialect: new PostgresDialect({ pool: capturePool as never }),
    log: (event) => {
      if (event.level === "query") {
        captured.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });

  cluster.closeBeforeShutdown("capturing persistence", () => capturingDb.destroy());
  cluster.closeBeforeShutdown("persistence", () => persistence.shutdown());
}, CLUSTER_TIMEOUT_MS);

beforeEach(async () => {
  await sql`delete from listing_revision`.execute(persistence.db);
  await sql`delete from listing`.execute(persistence.db);
  captured.length = 0;
});

/* ------------------------------------------------------------------------------------------- */
/* OP-2 — the negative outcome itself                                                            */
/* ------------------------------------------------------------------------------------------- */

describe("BI-4: OP-2's negative outcome is the same for never existed, pending, rejected and unpublished", () => {
  it("returns one value: same error reference, keys, prototype, frozenness and serialization", async () => {
    const outcomes = [];

    for (const [, identity] of await fourCases()) {
      outcomes.push(await findPubliclyAvailableListing(persistence.db, identity));
    }

    const [first, ...rest] = outcomes;

    expect(first).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });

    for (const outcome of rest) {
      expect(JSON.stringify(outcome)).toBe(JSON.stringify(first));
      expect(Object.keys(outcome)).toEqual(Object.keys(first));
      expect(Object.getPrototypeOf(outcome)).toBe(Object.getPrototypeOf(first));

      if (outcome.ok || first.ok) {
        throw new Error("expected only negative outcomes");
      }

      expect(outcome.error).toBe(first.error);
      expect(Object.isFrozen(outcome.error)).toBe(Object.isFrozen(first.error));
    }
  }, TEST_TIMEOUT_MS);

  it("sends each case the same single statement, differing only in the supplied identity (structural evidence only; not execution or timing)", async () => {
    const cases = await fourCases();
    const shapes = [];

    for (const [, identity] of cases) {
      captured.length = 0;
      await findPubliclyAvailableListing(capturingDb, identity);

      expect(captured).toHaveLength(1);

      const [statement] = captured;

      expect(statement.parameters).toContain(identity);
      shapes.push({
        sql: statement.sql,
        parameters: statement.parameters.map((parameter) => (parameter === identity ? "<identity>" : parameter)),
      });
    }

    for (const shape of shapes.slice(1)) {
      expect(shape).toEqual(shapes[0]);
    }
  }, TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* OP-1 — count and ordering                                                                     */
/* ------------------------------------------------------------------------------------------- */

describe("BI-4: OP-1's count and order do not reveal non-public rows", () => {
  it("returns the identical list, count and order before and after pending, rejected and unpublished rows exist", async () => {
    await submitAndApprove();
    await submitAndApprove();

    const before = await listPubliclyAvailableListings(persistence.db);

    expect(before.ok && before.value).toHaveLength(2);

    await fourCases();

    const after = await listPubliclyAvailableListings(persistence.db);

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  }, TEST_TIMEOUT_MS);

  it("returns the identical empty list whether the directory is empty or holds only non-public rows", async () => {
    const empty = await listPubliclyAvailableListings(persistence.db);

    await fourCases();

    const onlyNonPublic = await listPubliclyAvailableListings(persistence.db);

    expect(empty).toEqual({ ok: true, value: [] });
    expect(JSON.stringify(onlyNonPublic)).toBe(JSON.stringify(empty));
  }, TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* Slice 2 — fixed identities, verified stored states and explicit baselines                    */
/* ------------------------------------------------------------------------------------------- */

/** The stored state a fixture must be in before it is read, checked outside the read path. */
interface StoredState {
  readonly status: string;
  readonly publication_state: string | null;
  readonly unpublish_reason: string | null;
  readonly rejected: boolean;
}

const STORED_PENDING: StoredState = { status: "pending", publication_state: null, unpublish_reason: null, rejected: false };
const STORED_REJECTED: StoredState = { status: "rejected", publication_state: null, unpublish_reason: null, rejected: true };
const STORED_PUBLISHED: StoredState = {
  status: "approved",
  publication_state: "publicly_available",
  unpublish_reason: null,
  rejected: false,
};
const STORED_UNPUBLISHED: StoredState = {
  status: "approved",
  publication_state: "unpublished",
  unpublish_reason: "probe reason",
  rejected: false,
};

async function expectAbsent(id: string): Promise<void> {
  const { rows } = await sql<{ readonly n: number }>`select count(*)::int as n from listing where id = ${id}::uuid`.execute(
    persistence.db,
  );

  expect(rows, `${id} must not be stored`).toEqual([{ n: 0 }]);
}

async function expectStored(id: string, state: StoredState): Promise<void> {
  const { rows } = await sql<StoredState>`select status, publication_state, unpublish_reason, rejected_at is not null as rejected from listing where id = ${id}::uuid`.execute(
    persistence.db,
  );

  expect(rows, `${id} must be stored as ${state.status}/${String(state.publication_state)}`).toEqual([state]);
}

async function submitAs(id: string): Promise<Listing> {
  const listing: Listing = {
    id: listingIdOf(id),
    status: "pending",
    content: CONTENT,
    timestamps: { submittedAt: instant(T0), lastUpdatedAt: instant(T0) },
  };

  expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

  return listing;
}

async function approve(listing: Listing): Promise<void> {
  const approved = await persistListingApproval(persistence.db, {
    listingId: listing.id,
    viewedLastUpdatedAt: instant(T0),
    approvedAt: instant(T1),
  });

  expect(approved.ok, JSON.stringify(approved)).toBe(true);
}

async function reject(listing: Listing): Promise<void> {
  expect((await rejectPendingListing(persistence.db, { listingId: listing.id, rejectedAt: instant(T1) })).ok).toBe(
    true,
  );
}

/** Unpublished as a store state (`OP-9` is not implemented). */
async function unpublish(listing: Listing): Promise<void> {
  const at = timestamptzFromEpochMilliseconds(T2);

  await sql`update listing set publication_state = 'unpublished', unpublish_reason = 'probe reason', last_updated_at = ${at} where id = ${textOf(listing)}::uuid`.execute(
    persistence.db,
  );
}

/** Copy the captured statements, so a later read cannot change a recorded baseline. */
function capturedStatements(): readonly CapturedStatement[] {
  return captured.map(({ sql: text, parameters }) => ({ sql: text, parameters: [...parameters] }));
}

interface Op2Probe {
  readonly outcome: Awaited<ReturnType<typeof findPubliclyAvailableListing>>;
  readonly statements: readonly CapturedStatement[];
}

async function probeOp2(identity: string): Promise<Op2Probe> {
  captured.length = 0;

  const outcome = await findPubliclyAvailableListing(capturingDb, identity);

  return { outcome, statements: capturedStatements() };
}

/** Record a never-existed baseline: absent in the store, exactly one statement, unavailable. */
async function neverExistedBaseline(identity: string): Promise<Op2Probe> {
  await expectAbsent(identity);

  const baseline = await probeOp2(identity);

  expect(baseline.outcome).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
  expect(baseline.statements).toHaveLength(1);
  expect(baseline.statements[0].parameters).toContain(identity);

  return baseline;
}

/** One negative read against its own lineage's baseline: outcome and statements, unmasked. */
function expectSameAsBaseline(probe: Op2Probe, baseline: Op2Probe): void {
  expect(probe.outcome).toEqual(baseline.outcome);
  expect(JSON.stringify(probe.outcome)).toBe(JSON.stringify(baseline.outcome));
  expect(Object.keys(probe.outcome)).toEqual(Object.keys(baseline.outcome));
  expect(Object.getPrototypeOf(probe.outcome)).toBe(Object.getPrototypeOf(baseline.outcome));

  if (probe.outcome.ok || baseline.outcome.ok) {
    throw new Error("expected only negative outcomes");
  }

  expect(probe.outcome.error).toBe(baseline.outcome.error);
  expect(Object.isFrozen(probe.outcome.error)).toBe(Object.isFrozen(baseline.outcome.error));

  // Structural evidence only: the same statement was sent, not the same execution or timing.
  expect(probe.statements).toEqual(baseline.statements);
}

describe("BI-4 slice 2: OP-2 against a fixed identity's own never-existed baseline", () => {
  it("compares both never-existed baselines, then every pending, rejected and unpublished read with its own lineage's baseline, SQL and parameters unmasked (statements are structural evidence only; not execution or timing)", async () => {
    // Exclusive to this test, so no other test, and no test order, can have inserted them.
    const FIXED_REJECTED = "a1000000-0000-4000-8000-000000000001";
    const FIXED_UNPUBLISHED = "a2000000-0000-4000-8000-000000000002";

    // Both baselines are captured before either identity is inserted.
    const rejectedBaseline = await neverExistedBaseline(FIXED_REJECTED);
    const unpublishedBaseline = await neverExistedBaseline(FIXED_UNPUBLISHED);

    if (rejectedBaseline.outcome.ok || unpublishedBaseline.outcome.ok) {
      throw new Error("expected only negative outcomes");
    }

    expect(unpublishedBaseline.outcome.error).toBe(rejectedBaseline.outcome.error);

    const masked = (probe: Op2Probe, identity: string) =>
      probe.statements.map(({ sql: text, parameters }) => ({
        sql: text,
        parameters: parameters.map((parameter) => (parameter === identity ? "<identity>" : parameter)),
      }));

    expect(masked(unpublishedBaseline, FIXED_UNPUBLISHED)).toEqual(masked(rejectedBaseline, FIXED_REJECTED));

    // Lineage 1: never existed → pending → rejected.
    const rejected = await submitAs(FIXED_REJECTED);
    await expectStored(FIXED_REJECTED, STORED_PENDING);
    expectSameAsBaseline(await probeOp2(FIXED_REJECTED), rejectedBaseline);

    await reject(rejected);
    await expectStored(FIXED_REJECTED, STORED_REJECTED);
    expectSameAsBaseline(await probeOp2(FIXED_REJECTED), rejectedBaseline);

    // Lineage 2: never existed → pending → approved and published → unpublished.
    const unpublished = await submitAs(FIXED_UNPUBLISHED);
    await expectStored(FIXED_UNPUBLISHED, STORED_PENDING);
    expectSameAsBaseline(await probeOp2(FIXED_UNPUBLISHED), unpublishedBaseline);

    await approve(unpublished);
    await expectStored(FIXED_UNPUBLISHED, STORED_PUBLISHED);

    // Positive control, outside every negative comparison: the identity itself is publicly readable.
    const published = await findPubliclyAvailableListing(persistence.db, FIXED_UNPUBLISHED);

    expect(published.ok && published.value.id).toBe(FIXED_UNPUBLISHED);

    await unpublish(unpublished);
    await expectStored(FIXED_UNPUBLISHED, STORED_UNPUBLISHED);
    expectSameAsBaseline(await probeOp2(FIXED_UNPUBLISHED), unpublishedBaseline);
  }, TEST_TIMEOUT_MS);
});

/* OP-1 sorts by `listing.id`, a `uuid`, whose order is the lexical order of its lower-case text. */
const P1 = "30000000-0000-4000-8000-000000000000";
const P2 = "70000000-0000-4000-8000-000000000000";

/** For each non-public state: one row before P1, one between P1 and P2, one after P2. */
const PLACED = {
  pending: [
    "11000000-0000-4000-8000-000000000000",
    "51000000-0000-4000-8000-000000000000",
    "91000000-0000-4000-8000-000000000000",
  ],
  rejected: [
    "12000000-0000-4000-8000-000000000000",
    "52000000-0000-4000-8000-000000000000",
    "92000000-0000-4000-8000-000000000000",
  ],
  unpublished: [
    "13000000-0000-4000-8000-000000000000",
    "53000000-0000-4000-8000-000000000000",
    "93000000-0000-4000-8000-000000000000",
  ],
} as const;

type NonPublicState = keyof typeof PLACED;

const NON_PUBLIC_STATES: readonly NonPublicState[] = ["pending", "rejected", "unpublished"];

const STORED_BY_STATE: Readonly<Record<NonPublicState, StoredState>> = {
  pending: STORED_PENDING,
  rejected: STORED_REJECTED,
  unpublished: STORED_UNPUBLISHED,
};

async function insertPlaced(state: NonPublicState): Promise<void> {
  for (const id of PLACED[state]) {
    const listing = await submitAs(id);

    if (state === "rejected") {
      await reject(listing);
    } else if (state === "unpublished") {
      await approve(listing);
      await unpublish(listing);
    }
  }
}

async function expectPlacedStored(state: NonPublicState): Promise<void> {
  for (const id of PLACED[state]) {
    await expectStored(id, STORED_BY_STATE[state]);
  }
}

/** Remove every non-public fixture and verify that exactly P1 and P2 remain, published. */
async function resetToPublicOnly(): Promise<void> {
  await sql`delete from listing where id not in (${P1}::uuid, ${P2}::uuid)`.execute(persistence.db);

  const { rows } = await sql<{ readonly id: string }>`select id from listing order by id`.execute(persistence.db);

  expect(rows.map(({ id }) => id)).toEqual([P1, P2]);
  await expectStored(P1, STORED_PUBLISHED);
  await expectStored(P2, STORED_PUBLISHED);
}

interface Op1Read {
  readonly result: Awaited<ReturnType<typeof listPubliclyAvailableListings>>;
  readonly statements: readonly CapturedStatement[];
}

async function readOp1(): Promise<Op1Read> {
  captured.length = 0;

  const result = await listPubliclyAvailableListings(capturingDb);

  return { result, statements: capturedStatements() };
}

function idsOf(read: Op1Read): readonly string[] {
  return read.result.ok ? read.result.value.map(({ id }) => id) : [];
}

/** Count, order and contents, and the statement footprint (structural evidence only). */
function expectSameAsPublicOnly(read: Op1Read, baseline: Op1Read, label: string): void {
  expect(read.result.ok, label).toBe(true);
  expect(read.result.ok && read.result.value.length, `${label}: count`).toBe(
    baseline.result.ok && baseline.result.value.length,
  );
  expect(idsOf(read), `${label}: order`).toEqual([P1, P2]);
  expect(JSON.stringify(read.result), `${label}: order and contents`).toBe(JSON.stringify(baseline.result));
  expect(read.statements, `${label}: statement footprint`).toEqual(baseline.statements);
}

describe("BI-4 slice 2: OP-1 against an explicit public-only baseline", () => {
  it("places the non-public rows before, between and after the public ones by OP-1's sort key", () => {
    const all = [P1, P2, ...NON_PUBLIC_STATES.flatMap((state) => PLACED[state])];
    const sorted = [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    expect(sorted).toEqual([
      PLACED.pending[0],
      PLACED.rejected[0],
      PLACED.unpublished[0],
      P1,
      PLACED.pending[1],
      PLACED.rejected[1],
      PLACED.unpublished[1],
      P2,
      PLACED.pending[2],
      PLACED.rejected[2],
      PLACED.unpublished[2],
    ]);
  });

  it("leaves count, order, contents and statement footprint unchanged by each non-public state alone, then by all three together (footprint is structural evidence only; not execution or timing)", async () => {
    for (const id of [P1, P2]) {
      await approve(await submitAs(id));
    }

    await resetToPublicOnly();

    const baseline = await readOp1();

    expect(baseline.result.ok).toBe(true);
    expect(idsOf(baseline)).toEqual([P1, P2]);
    expect(baseline.statements).toHaveLength(1);

    for (const state of NON_PUBLIC_STATES) {
      await resetToPublicOnly();
      await insertPlaced(state);
      await expectPlacedStored(state);
      expectSameAsPublicOnly(await readOp1(), baseline, `${state} alone`);
    }

    // The combined case starts from the public-only store again, then holds all nine rows.
    await resetToPublicOnly();

    for (const state of NON_PUBLIC_STATES) {
      await insertPlaced(state);
    }

    for (const state of NON_PUBLIC_STATES) {
      await expectPlacedStored(state);
    }

    expectSameAsPublicOnly(await readOp1(), baseline, "all three together");
  }, TEST_TIMEOUT_MS);
});
