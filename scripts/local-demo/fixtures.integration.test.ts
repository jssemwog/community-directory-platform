/**
 * The local demonstration's synthetic fixtures, seeded against a real PostgreSQL server
 * (issue #248): they pass through the existing operations and land in the expected public states.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { createListingPersistence, type ListingPersistence } from "../../src/data/connection";
import { findPubliclyAvailableListing, listPubliclyAvailableListings } from "../../src/data/public-listing-read";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../src/data/testing/embedded-cluster";
import { resetAndSeedSyntheticListings, SYNTHETIC_LISTINGS } from "./fixtures";

const DATABASE = "local_demo_fixtures";

const cluster = useEmbeddedPostgres({
  slug: "local-demo-fixtures",
  databases: [DATABASE],
  migrate: [DATABASE],
});

const TEST_TIMEOUT_MS = 30_000;

let persistence: ListingPersistence;

beforeAll(() => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 2 },
  });
  cluster.closeBeforeShutdown("persistence", () => persistence.shutdown());
}, CLUSTER_TIMEOUT_MS);

function idsWith(outcome: string): string[] {
  return SYNTHETIC_LISTINGS.filter((fixture) => fixture.outcome === outcome).map((fixture) => fixture.id);
}

describe("local demo synthetic fixtures", () => {
  it("publishes exactly the approved fixtures and withholds the pending and rejected ones", async () => {
    await resetAndSeedSyntheticListings(persistence.db);

    const listed = await listPubliclyAvailableListings(persistence.db);

    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.value.map((entry) => entry.id).sort()).toEqual(idsWith("approved").sort());

    for (const id of [...idsWith("pending"), ...idsWith("rejected")]) {
      expect(await findPubliclyAvailableListing(persistence.db, id)).toEqual({
        ok: false,
        error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" },
      });
    }

    expect(idsWith("pending")).toHaveLength(1);
    expect(idsWith("rejected")).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("withholds contact values a fixture did not designate public", async () => {
    await resetAndSeedSyntheticListings(persistence.db);

    const bicycleRepair = await findPubliclyAvailableListing(persistence.db, "1c8f5d63-7a2b-4e4c-9f3a-6b2d8a4e0f12");

    expect(bicycleRepair.ok && bicycleRepair.value.listing).not.toHaveProperty("phone");
    expect(bicycleRepair.ok && bicycleRepair.value.listing.email).toBe("workshop@harbourside-bikes.example");
  }, TEST_TIMEOUT_MS);

  it("re-seeds to the same public directory, so every demo start is reproducible", async () => {
    await resetAndSeedSyntheticListings(persistence.db);
    const first = await listPubliclyAvailableListings(persistence.db);

    await resetAndSeedSyntheticListings(persistence.db);
    const second = await listPubliclyAvailableListings(persistence.db);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, TEST_TIMEOUT_MS);
});
