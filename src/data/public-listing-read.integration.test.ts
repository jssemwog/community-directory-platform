/**
 * Attacking tests for the public read path (`OP-1` browse, `OP-2` detail; issue #244), against a
 * real PostgreSQL server.
 *
 * Listings reach their states through the real operations wherever they exist — submission
 * (`insertSubmittedListing`), approval (`OP-7`), rejection (`OP-8`) and pending-revision creation
 * (`OP-6`). Unpublishing (`OP-9`) is not implemented, so that state is written directly as a store
 * state, not as a claim about any operation.
 *
 * **This suite does not prove `BI-4`.** It shows that the non-public cases return the identical
 * outcome *value*; equivalence of timing, count and every other observable is a separate issue
 * (`docs/12` *Phase 2*).
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing, ListingContent } from "../domain/listing/listing";
import {
  createListingPersistence,
  startupOptionsFor,
  type ListingPersistence,
} from "./connection";
import { persistListingApproval } from "./listing-approval";
import { rejectPendingListing } from "./listing-rejection";
import { insertSubmittedListing } from "./listing-repository";
import type { ListingDatabase } from "./listing-table";
import {
  findPubliclyAvailableListing,
  listPubliclyAvailableListings,
  type PublicListing,
} from "./public-listing-read";
import { createPendingRevision } from "./revision-repository";
import { timestamptzFromEpochMilliseconds } from "./row-mapping";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";

const VERIFIED_DATABASE = "public_read_verification";
const HOSTILE_DATABASE = "public_read_hostile";

const cluster = useEmbeddedPostgres({
  slug: "public-read",
  databases: [VERIFIED_DATABASE, HOSTILE_DATABASE],
  migrate: [VERIFIED_DATABASE, HOSTILE_DATABASE],
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

/** Private values that must never appear in any public output. */
const PRIVATE_PHONE = "+353 21 999 0000";
const PRIVATE_WEBSITE = "https://private.example.ie";
const UNPUBLISH_REASON = "probe unpublish reason";
const REVISION_NAME = "Revision-only name";

/** The inverse designations, for the private postal code and email case. */
const PRIVATE_POSTAL_CODE = "T12 PRIV";
const PRIVATE_EMAIL = "owner-private@example.ie";
const PUBLIC_PHONE = "+353 21 555 0101";
const PUBLIC_WEBSITE = "https://quay-florist.example.ie";

/** Mixed designations: postal code and email public, phone and website private. */
const CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: PRIVATE_PHONE, designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: PRIVATE_WEBSITE },
};

/** Exactly the `OQ-7` projection of `CONTENT`. */
const PROJECTED = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: "P17 AB12",
  email: "hello@example.ie",
};

let persistence: ListingPersistence;
let hostile: ListingPersistence;

function textOf(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

async function submit(db: Kysely<ListingDatabase> = persistence.db, content = CONTENT): Promise<Listing> {
  const listing: Listing = {
    id: listingIdOf(randomUUID()),
    status: "pending",
    content,
    timestamps: { submittedAt: instant(T0), lastUpdatedAt: instant(T0) },
  };

  expect((await insertSubmittedListing(db, listing)).ok).toBe(true);

  return listing;
}

/** Submit, then approve through the real `OP-7` persistence. */
async function submitAndApprove(
  db: Kysely<ListingDatabase> = persistence.db,
  content: ListingContent = CONTENT,
): Promise<Listing> {
  const listing = await submit(db, content);
  const approved = await persistListingApproval(db, {
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

  await sql`update listing set publication_state = 'unpublished', unpublish_reason = ${UNPUBLISH_REASON}, last_updated_at = ${at} where id = ${textOf(listing)}::uuid`.execute(
    persistence.db,
  );

  return listing;
}

/** Approved, then carrying a pending revision created through the real `OP-6` persistence. */
async function approvedWithPendingRevision(): Promise<Listing> {
  const listing = await submitAndApprove();
  const created = await createPendingRevision(persistence.db, {
    revisionId: randomUUID(),
    revision: {
      listingId: listing.id,
      state: "pending",
      proposedContent: { ...CONTENT, name: REVISION_NAME },
      baseListingLastUpdatedAt: instant(T1),
    },
  });

  expect(created.ok, JSON.stringify(created)).toBe(true);

  return listing;
}

function expectListings(result: Awaited<ReturnType<typeof listPubliclyAvailableListings>>) {
  if (!result.ok) {
    throw new Error(`expected listings, got ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

/* ------------------------------------------------------------------------------------------- */
/* Statement capture — footprint evidence, labelled as such                                       */
/* ------------------------------------------------------------------------------------------- */

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const pg = createRequire(import.meta.url)("pg") as {
  readonly Pool: new (config: Record<string, unknown>) => { end(): Promise<void> };
};

const captured: CapturedStatement[] = [];
let capturingDb: Kysely<ListingDatabase>;

beforeAll(async () => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
  });
  hostile = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(HOSTILE_DATABASE), max: 1 },
  });

  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(VERIFIED_DATABASE),
    max: 1,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: "public_read_capture" }),
  });

  capturingDb = new Kysely<ListingDatabase>({
    dialect: new PostgresDialect({ pool: pool as never }),
    log: (event) => {
      if (event.level === "query") {
        captured.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });

  cluster.closeBeforeShutdown("capturing persistence", () => capturingDb.destroy());
  cluster.closeBeforeShutdown("verified persistence", () => persistence.shutdown());
  cluster.closeBeforeShutdown("hostile persistence", () => hostile.shutdown());

  // A row the domain cannot represent must be storable, so the read path's classification of
  // it can be proved end to end.
  await sql`alter table listing drop constraint listing_category_check`.execute(hostile.db);
}, CLUSTER_TIMEOUT_MS);

beforeEach(async () => {
  await sql`delete from listing_revision`.execute(persistence.db);
  await sql`delete from listing`.execute(persistence.db);
  await sql`delete from listing`.execute(hostile.db);
  captured.length = 0;
});

/* ------------------------------------------------------------------------------------------- */
/* OP-1 — browse                                                                                  */
/* ------------------------------------------------------------------------------------------- */

describe("OP-1 browse (FR-VIS-01, FR-VIS-02, BI-1, BI-6, DI-5, DI-10)", () => {
  it("returns an empty list for an empty directory", async () => {
    expect(expectListings(await listPubliclyAvailableListings(persistence.db))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("returns only approved, publicly available listings: never pending, rejected or unpublished", async () => {
    const visible = await submitAndApprove();
    const withRevision = await approvedWithPendingRevision();

    await submit();
    await submitAndReject();
    await approvedThenUnpublished();

    const listings = expectListings(await listPubliclyAvailableListings(persistence.db));

    expect(listings.map((entry) => entry.id).sort()).toEqual([textOf(visible), textOf(withRevision)].sort());
  }, TEST_TIMEOUT_MS);

  it("returns exactly the OQ-7 projection: designated-public values only, no administrative field", async () => {
    await submitAndApprove();
    await approvedThenUnpublished();
    await submitAndReject();

    const listings = expectListings(await listPubliclyAvailableListings(persistence.db));

    expect(listings).toHaveLength(1);

    const [entry] = listings as [PublicListing];

    expect(Object.keys(entry).sort()).toEqual(["id", "listing"]);
    expect(entry.listing).toEqual(PROJECTED);

    const serialized = JSON.stringify(listings);

    for (const forbidden of [
      PRIVATE_PHONE,
      PRIVATE_WEBSITE,
      UNPUBLISH_REASON,
      "pending",
      "approved",
      "rejected",
      "publicly_available",
      "unpublished",
      String(T0),
      String(T1),
      String(T2),
      "status",
      "publication",
      "submittedAt",
      "lastUpdatedAt",
      "rejectedAt",
      "designatedPublic",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  }, TEST_TIMEOUT_MS);

  it("withholds a private postal code and a private email from list and detail, while showing public phone and website", async () => {
    // The inverse of `CONTENT`: postal code designated private, email with no designation
    // (private by default), phone and website designated public.
    const content: ListingContent = {
      name: "Quay Florist",
      category: "retail-shopping",
      description: "Cut flowers and plants.",
      locality: "Cobh",
      country: "IE",
      postalCode: { value: PRIVATE_POSTAL_CODE, designatedPublic: false },
      phone: { value: PUBLIC_PHONE, designatedPublic: true },
      email: { value: PRIVATE_EMAIL },
      website: { value: PUBLIC_WEBSITE, designatedPublic: true },
    };
    const listing = await submitAndApprove(persistence.db, content);
    const expected = {
      name: "Quay Florist",
      category: "retail-shopping",
      description: "Cut flowers and plants.",
      locality: "Cobh",
      country: "IE",
      phone: PUBLIC_PHONE,
      website: PUBLIC_WEBSITE,
    };

    const listed = expectListings(await listPubliclyAvailableListings(persistence.db));
    const found = await findPubliclyAvailableListing(persistence.db, textOf(listing));

    expect(listed).toEqual([{ id: textOf(listing), listing: expected }]);
    expect(found).toEqual({ ok: true, value: { id: textOf(listing), listing: expected } });

    for (const serialized of [JSON.stringify(listed), JSON.stringify(found)]) {
      expect(serialized).toContain(PUBLIC_PHONE);
      expect(serialized).toContain(PUBLIC_WEBSITE);

      for (const forbidden of [
        PRIVATE_POSTAL_CODE,
        PRIVATE_EMAIL,
        "postalCode",
        "email",
        "designatedPublic",
        "designated_public",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  }, TEST_TIMEOUT_MS);

  it("shows an approved listing's approved content, never its pending revision (DI-10)", async () => {
    const listing = await approvedWithPendingRevision();
    const listings = expectListings(await listPubliclyAvailableListings(persistence.db));

    expect(listings).toEqual([{ id: textOf(listing), listing: PROJECTED }]);
    expect(JSON.stringify(listings)).not.toContain(REVISION_NAME);
  }, TEST_TIMEOUT_MS);

  it("returns a consistent order across reads (FR-VIS-03), without asserting any product order (OQ-3)", async () => {
    for (let i = 0; i < 5; i += 1) {
      await submitAndApprove();
    }

    const first = expectListings(await listPubliclyAvailableListings(persistence.db));
    const second = expectListings(await listPubliclyAvailableListings(persistence.db));

    expect(first).toHaveLength(5);
    expect(second).toEqual(first);
  }, TEST_TIMEOUT_MS);

  it("reports an unreadable matching row as a failure, never as an empty or shortened list", async () => {
    const listing = await submitAndApprove(hostile.db);

    await sql`update listing set category = 'nonsense' where id = ${textOf(listing)}::uuid`.execute(hostile.db);

    const result = await listPubliclyAvailableListings(hostile.db);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("STORED_LISTING_UNREADABLE");
  }, TEST_TIMEOUT_MS);

  it("reports a system error as a failure, never as an empty list", async () => {
    // A database that cannot be reached: the same server address on a port nothing listens on.
    const unreachable = new URL(cluster.connectionStringFor(VERIFIED_DATABASE));

    unreachable.port = "1";

    const down = createListingPersistence({
      pool: { connectionString: unreachable.toString(), max: 1 },
    });

    try {
      for (const result of [
        await listPubliclyAvailableListings(down.db),
        await findPubliclyAvailableListing(down.db, randomUUID()),
      ]) {
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error.code).toBe("STORAGE_FAILURE");
      }
    } finally {
      await down.shutdown();
    }
  }, TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* OP-2 — one listing                                                                             */
/* ------------------------------------------------------------------------------------------- */

const UNAVAILABLE = { ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } };

describe("OP-2 detail (FR-VIS-05, FR-VIS-08, NFR-SEC-02, BI-1, BI-6, DI-5)", () => {
  it("returns an approved, publicly available listing in the public projection, matching the list entry", async () => {
    const listing = await submitAndApprove();
    const result = await findPubliclyAvailableListing(persistence.db, textOf(listing));

    expect(result).toEqual({ ok: true, value: { id: textOf(listing), listing: PROJECTED } });
    expect(expectListings(await listPubliclyAvailableListings(persistence.db))).toEqual([
      result.ok && result.value,
    ]);
  }, TEST_TIMEOUT_MS);

  it("returns the identical unavailable outcome for absent, pending, rejected and unpublished listings", async () => {
    const pending = await submit();
    const rejected = await submitAndReject();
    const unpublished = await approvedThenUnpublished();

    for (const identity of [randomUUID(), textOf(pending), textOf(rejected), textOf(unpublished)]) {
      const result = await findPubliclyAvailableListing(persistence.db, identity);

      expect(result).toEqual(UNAVAILABLE);
      expect(Object.keys(result.ok === false ? result.error : {})).toEqual(["code"]);
    }
  }, TEST_TIMEOUT_MS);

  it("shows the approved content of a listing with a pending revision, never the revision's (DI-10)", async () => {
    const listing = await approvedWithPendingRevision();

    expect(await findPubliclyAvailableListing(persistence.db, textOf(listing))).toEqual({
      ok: true,
      value: { id: textOf(listing), listing: PROJECTED },
    });
  }, TEST_TIMEOUT_MS);

  it("treats a malformed identity as unavailable, sending no statement", async () => {
    for (const identity of ["not-a-uuid", "", "  ", "00000000-0000-0000-0000", 42, null, undefined, {}]) {
      captured.length = 0;

      expect(await findPubliclyAvailableListing(capturingDb, identity)).toEqual(UNAVAILABLE);
      expect(captured).toEqual([]);
    }
  }, TEST_TIMEOUT_MS);

  it("reports an unreadable matching row as a failure, never as unavailable", async () => {
    const listing = await submitAndApprove(hostile.db);

    await sql`update listing set category = 'nonsense' where id = ${textOf(listing)}::uuid`.execute(hostile.db);

    const result = await findPubliclyAvailableListing(hostile.db, textOf(listing));

    expect(result.ok === false && result.error.code).toBe("STORED_LISTING_UNREADABLE");
  }, TEST_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------- */
/* Footprint — the statements PostgreSQL received (footprint, not behaviour)                      */
/* ------------------------------------------------------------------------------------------- */

describe("the read footprint (DI-5, DI-10, no write)", () => {
  it("each read is one SELECT on listing, filtered to approved and publicly available, touching no revision", async () => {
    const listing = await submitAndApprove();

    captured.length = 0;
    expectListings(await listPubliclyAvailableListings(capturingDb));
    expect((await findPubliclyAvailableListing(capturingDb, textOf(listing))).ok).toBe(true);

    expect(captured).toHaveLength(2);

    for (const statement of captured) {
      expect(statement.sql).toMatch(/^\s*select\b/i);
      expect(statement.sql).toMatch(/from\s+"listing"/i);
      expect(statement.sql).toMatch(/"status"\s*=\s*\$\d+/i);
      expect(statement.sql).toMatch(/"publication_state"\s*=\s*\$\d+/i);
      expect(statement.sql).not.toMatch(/listing_revision/i);
      expect(statement.parameters).toContain("approved");
      expect(statement.parameters).toContain("publicly_available");
    }
  }, TEST_TIMEOUT_MS);
});
