/**
 * Fixtures for the `BI-4` timing pilot (issue #246; timing Scope Gate revision 4 §3.3; harness gate
 * revision 5 §2, §8).
 *
 * Every stored row has identical content. Pending rows are created with `insertSubmittedListing`;
 * rejected rows are inserted, then rejected with `OP-8`; unpublished rows are approved with
 * `OP-7`, then unpublished by a direct store update, because `OP-9` is not implemented; the
 * background population is approved and left publicly available. Every stored state is verified
 * before measurement and again afterwards, outside the measured path, and never-existed and
 * delay-control identities are verified absent.
 *
 * Storage preparation runs on the disposable database only: `VACUUM (ANALYZE) listing`, then
 * autovacuum off for `listing` (`H-D13`), then a read-through of the table and its primary-key
 * index. No migration changes.
 */

import { sql, type Kysely } from "kysely";

import { instantOf, type Instant } from "../../src/domain/listing/instant";
import type { Listing, ListingContent } from "../../src/domain/listing/listing";
import { listingIdOf } from "../../src/domain/listing/listing-id";
import { persistListingApproval } from "../../src/data/listing-approval";
import { rejectPendingListing } from "../../src/data/listing-rejection";
import { insertSubmittedListing } from "../../src/data/listing-repository";
import type { ListingDatabase } from "../../src/data/listing-table";
import { timestamptzFromEpochMilliseconds } from "../../src/data/row-mapping";
import type { ItemClass, Plan } from "./schedule";

const T0 = 1_767_323_045_123;
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;

/** One content value for every stored row. */
export const FIXTURE_CONTENT: ListingContent = {
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

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) throw new Error("fixture instant is invalid");
  return result.value;
}

/** The stored state each class must have. `undefined` means the identity must be absent. */
type StoredState = { readonly status: string; readonly publication_state: string | null };

const STORED: Readonly<Partial<Record<ItemClass | "background", StoredState>>> = {
  PE: { status: "pending", publication_state: null },
  RJ: { status: "rejected", publication_state: null },
  UP: { status: "approved", publication_state: "unpublished" },
  background: { status: "approved", publication_state: "publicly_available" },
};

const ABSENT: readonly ItemClass[] = ["NE", "NCA", "NCB", "DL", "CMP"];

async function submit(db: Kysely<ListingDatabase>, key: string): Promise<Listing> {
  const listing: Listing = {
    id: listingIdOf(key),
    status: "pending",
    content: FIXTURE_CONTENT,
    timestamps: { submittedAt: instant(T0), lastUpdatedAt: instant(T0) },
  };
  const inserted = await insertSubmittedListing(db, listing);
  if (!inserted.ok) throw new Error(`fixture insert failed: ${JSON.stringify(inserted.error)}`);
  return listing;
}

async function approve(db: Kysely<ListingDatabase>, listing: Listing): Promise<void> {
  const approved = await persistListingApproval(db, { listingId: listing.id, viewedLastUpdatedAt: instant(T0), approvedAt: instant(T1) });
  if (!approved.ok) throw new Error(`fixture approval failed: ${JSON.stringify(approved.error)}`);
}

/** Load every stored row the plan needs. Runs before warm-up; never during measurement. */
export async function loadFixtures(db: Kysely<ListingDatabase>, plan: Plan): Promise<void> {
  for (const identity of plan.identities) {
    if (identity.cls === "PE") {
      await submit(db, identity.key);
    } else if (identity.cls === "RJ") {
      const listing = await submit(db, identity.key);
      const rejected = await rejectPendingListing(db, { listingId: listing.id, rejectedAt: instant(T1) });
      if (!rejected.ok) throw new Error(`fixture rejection failed: ${JSON.stringify(rejected.error)}`);
    } else if (identity.cls === "UP") {
      const listing = await submit(db, identity.key);
      await approve(db, listing);
      await sql`update listing set publication_state = 'unpublished', unpublish_reason = 'timing fixture', last_updated_at = ${timestamptzFromEpochMilliseconds(T2)} where id = ${identity.key}::uuid`.execute(db);
    }
  }

  for (const key of plan.background) {
    await approve(db, await submit(db, key));
  }
}

/** Every stored-state problem. An empty list means every identity is exactly as planned. */
export async function verifyStoredStates(db: Kysely<ListingDatabase>, plan: Plan): Promise<readonly string[]> {
  const { rows } = await sql<{ id: string; status: string; publication_state: string | null }>`select id::text as id, status, publication_state from listing`.execute(db);
  const stored = new Map(rows.map((row) => [row.id, row]));
  const problems: string[] = [];
  const expectations: { key: string; cls: ItemClass | "background" }[] = [
    ...plan.identities.filter((identity) => identity.target !== "calibration" && identity.cls !== "MF").map((identity) => ({ key: identity.key, cls: identity.cls })),
    ...plan.background.map((key) => ({ key, cls: "background" as const })),
  ];

  for (const { key, cls } of expectations) {
    const row = stored.get(key);
    const expected = STORED[cls];

    if (ABSENT.includes(cls as ItemClass)) {
      if (row !== undefined) problems.push(`${cls} identity ${key} must be absent but is stored`);
    } else if (expected !== undefined) {
      if (row === undefined) problems.push(`${cls} identity ${key} is missing`);
      else if (row.status !== expected.status || row.publication_state !== expected.publication_state) {
        problems.push(`${cls} identity ${key} is stored as ${row.status}/${String(row.publication_state)}`);
      }
    }
  }

  const expectedRows = expectations.filter(({ cls }) => STORED[cls] !== undefined).length;
  if (rows.length !== expectedRows) problems.push(`listing holds ${rows.length} rows; the plan expects ${expectedRows}`);

  return problems;
}

/** `VACUUM (ANALYZE)`, autovacuum off on this disposable table (`H-D13`), then a read-through. */
export async function prepareStorage(db: Kysely<ListingDatabase>): Promise<void> {
  await sql`vacuum (analyze) listing`.execute(db);
  await sql`alter table listing set (autovacuum_enabled = false)`.execute(db);
  await sql`select count(*) from listing`.execute(db);
  await sql`select id from listing order by id`.execute(db);
}

/** Table and index sizes for the manifest. */
export async function storageSizes(db: Kysely<ListingDatabase>): Promise<{ readonly tableBytes: number; readonly indexBytes: number; readonly rows: number }> {
  const { rows } = await sql<{ table_bytes: string; index_bytes: string; rows: string }>`select pg_relation_size('listing')::text as table_bytes, pg_indexes_size('listing')::text as index_bytes, (select count(*) from listing)::text as rows`.execute(db);
  const row = rows[0] as { table_bytes: string; index_bytes: string; rows: string };
  return { tableBytes: Number(row.table_bytes), indexBytes: Number(row.index_bytes), rows: Number(row.rows) };
}
