/**
 * `BI-4` — the four-way equivalence of the public read path's negative outcome (issue #246),
 * against a real PostgreSQL server.
 *
 * The property is not "each non-public case returns not-available" (#244 already shows that); it
 * is that **never existed, pending, rejected and unpublished cannot be told apart** by an
 * unauthorised observer. Each equivalence test below compares the four cases with one another, per
 * channel tested: outcome value and shape, count, ordering, and the statements the database receives.
 *
 * Listings reach their states through the real operations where they exist — submission, approval
 * (`OP-7`) and rejection (`OP-8`). Unpublishing (`OP-9`) is not implemented, so that state is
 * written directly as a store state, not as a claim about any operation.
 *
 * ## What this suite does not prove
 *
 * **Execution or timing.** Identical SQL text and an identical plan shape show only that the
 * application sends the same statement and the planner chooses the same plan; they do **not** show
 * that the cases execute identically, and they are not a measurement of response time. The plan
 * is a primary-key index scan with status and publication state applied as a *filter after* the
 * lookup, and the "does not execute identically" test below records the consequence: a present
 * non-public row is fetched and removed by the filter, while a never-existed key finds no row at
 * all. That is different executor work, a known possible source of a timing difference (as are
 * buffer caching and visibility checks), and nothing here measures whether it is observable.
 * Timing equivalence is **unproven**: a timing claim needs its own measured method and threshold,
 * which this suite does not decide.
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
  query(text: string, values: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
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

/** The one statement `OP-2` sends for `identity`, captured through the logging pool. */
async function capturedStatementFor(identity: string): Promise<CapturedStatement> {
  captured.length = 0;
  await findPubliclyAvailableListing(capturingDb, identity);

  expect(captured).toHaveLength(1);

  return captured[0];
}

/** `statement`'s parameters with the captured identity replaced by `identity`. */
function parametersFor(statement: CapturedStatement, capturedIdentity: string, identity: string): unknown[] {
  return statement.parameters.map((parameter) => (parameter === capturedIdentity ? identity : parameter));
}

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

  it("sends each case the same single statement, differing only in the supplied identity (footprint, not timing)", async () => {
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

  it("chooses the same plan shape for each case (planner evidence, not execution or timing)", async () => {
    const cases = await fourCases();
    const statement = await capturedStatementFor(cases[0][1]);
    const plans = [];

    for (const [, identity] of cases) {
      const { rows } = await capturePool.query(
        `explain (format json, costs false) ${statement.sql}`,
        parametersFor(statement, cases[0][1], identity),
      );

      plans.push(JSON.stringify(rows[0]).split(identity).join("<identity>"));
    }

    for (const plan of plans.slice(1)) {
      expect(plan).toBe(plans[0]);
    }

    // The plan the header describes: a primary-key lookup, with status and publication state
    // applied as a filter after it.
    expect(JSON.parse(plans[0])).toMatchObject({
      "QUERY PLAN": [
        {
          Plan: {
            "Node Type": "Index Scan",
            "Index Name": "listing_pkey",
            Filter: expect.stringMatching(/status.*publication_state/),
          },
        },
      ],
    });
  }, TEST_TIMEOUT_MS);

  it("does not execute identically: a present non-public row is fetched and filtered out, an absent key is not (no timing claim)", async () => {
    const cases = await fourCases();
    const statement = await capturedStatementFor(cases[0][1]);
    const removedByFilter: Record<string, unknown> = {};

    for (const [name, identity] of cases) {
      const { rows } = await capturePool.query(
        `explain (analyze, costs false, timing false, summary false, format json) ${statement.sql}`,
        parametersFor(statement, cases[0][1], identity),
      );
      const [{ Plan: plan }] = rows[0]["QUERY PLAN"] as ReadonlyArray<{ Plan: Record<string, unknown> }>;

      expect(plan["Actual Rows"]).toBe(0);
      removedByFilter[name] = plan["Rows Removed by Filter"];
    }

    // Recorded, not endorsed: this is why the identical statement and plan above are not evidence
    // of identical execution or timing. Whether the difference is observable is not measured here.
    expect(removedByFilter).toEqual({ "never existed": 0, pending: 1, rejected: 1, unpublished: 1 });
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
