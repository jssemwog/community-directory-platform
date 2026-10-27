/**
 * `C9` — the public read path for `OP-1` (browse) and `OP-2` (one listing), through the existing
 * public projection (issue #244).
 *
 * ## What leaves this module
 *
 * Only `{ id, listing }` pairs, where `listing` is `projectListingPublicly`'s output — the exact
 * `OQ-7` field set, with each contact value and the postal code present only where the business
 * designated it public (`docs/08` *Field classification*). `id` is the listing's opaque UUID v4,
 * which `DDM-2` (`ADR-017` PS-1) makes the public listing identity. Status, timestamps,
 * publication state, the unpublish reason and every pending-revision value stay inside.
 *
 * ## Two filters, deliberately
 *
 * 1. The query reads **only** rows with `status = 'approved'` and
 *    `publication_state = 'publicly_available'`, so pending, rejected and unpublished rows are
 *    never read into this process at all (`DI-5`, `BI-1`).
 * 2. Each row that is read is still passed through `projectListingPublicly`, the one place where
 *    "public" is decided (`ADR-017` PS-2). A row it refuses is withheld, never shown.
 *
 * Neither path reads `listing_revision`, so a pending revision can never surface (`DI-10`).
 *
 * ## One unavailable outcome
 *
 * `OP-2` returns `LISTING_NOT_PUBLICLY_AVAILABLE`, carrying nothing, for an identity that is not
 * UUID-shaped, an absent listing, and a pending, rejected or unpublished one alike (`FR-VIS-08`,
 * `NFR-SEC-02`). **This is not the `BI-4` equivalence proof**: equivalence of timing, count and
 * every other observable is separate work (`docs/12` *Phase 2*).
 *
 * ## Order
 *
 * The list is ordered by the opaque public identity: a defined, consistent order (`FR-VIS-03`)
 * that carries no meaning. **It does not answer `OQ-3`**, and it keeps the administrative
 * `last_updated_at` from influencing public output (`docs/09` `OP-1`).
 *
 * ## Out of scope
 *
 * Search and filter criteria (`OQ-4`), pagination, `OP-11`, routes, UI, transport and caching.
 * Failures are internal classifications for the caller; mapping them to a public "system error"
 * belongs to the future interface layer.
 */

import type { Kysely } from "kysely";

import type { PublicListingProjection } from "../domain/listing/public-projection";
import { projectListingPublicly } from "../domain/listing/public-projection";
import { err, ok, type Result } from "../domain/listing/result";
import { hydrateListing, type ListingHydrationFailure } from "./listing-mapping";
import type { ListingDatabase } from "./listing-table";
import { storageFailure, type StorageFailure } from "./storage-failure";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";

/** The only status and publication state this path ever reads. */
const APPROVED_STATUS = "approved";
const PUBLICLY_AVAILABLE = "publicly_available";

/** A canonical UUID: the shape `OP-2` validates before any query (`docs/09` `OP-2`). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One publicly available listing: its public identity and its public projection. */
export interface PublicListing {
  readonly id: string;
  readonly listing: PublicListingProjection;
}

/** Why a public read could not be answered. Internal; never shown to a visitor as such. */
export type PublicListingReadFailure =
  /** A matching row could not be represented. Never reported as absent or as empty. */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /** A stored `timestamptz` the governed parser refused. */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  /** Anything else, including an unreachable database. */
  | StorageFailure;

/** The single unavailable outcome of `OP-2`. It carries nothing. */
export type PublicListingUnavailable = { readonly code: "LISTING_NOT_PUBLICLY_AVAILABLE" };

const NOT_AVAILABLE: PublicListingUnavailable = Object.freeze({
  code: "LISTING_NOT_PUBLICLY_AVAILABLE",
});

/** Classify a thrown read error without ever mistaking it for an absent or empty result. */
function readFailureOf(cause: unknown): PublicListingReadFailure {
  if (cause instanceof TimestamptzParseError) {
    return { code: "STORED_INSTANT_UNREADABLE", reason: cause.reason } as const;
  }

  return storageFailure(cause);
}

/**
 * Hydrate one matching row and project it publicly.
 *
 * `undefined` means the projection withheld it — impossible for a row the query admitted, but
 * withheld rather than shown if it ever happens.
 */
function publicListingFrom(
  row: Parameters<typeof hydrateListing>[0],
): Result<PublicListing | undefined, PublicListingReadFailure> {
  const hydrated = hydrateListing(row);

  if (!hydrated.ok) {
    return err({ code: "STORED_LISTING_UNREADABLE", failure: hydrated.error } as const);
  }

  const projected = projectListingPublicly(hydrated.value);

  return ok(projected.ok ? { id: row.id, listing: projected.value } : undefined);
}

/**
 * `OP-1` with no criteria: every approved, publicly available listing, in the public projection,
 * in a consistent order. An empty directory is an empty array; a failure is never an empty array.
 */
export async function listPubliclyAvailableListings(
  db: Kysely<ListingDatabase>,
): Promise<Result<readonly PublicListing[], PublicListingReadFailure>> {
  let rows;

  try {
    rows = await db
      .selectFrom("listing")
      .selectAll()
      .where("status", "=", APPROVED_STATUS)
      .where("publication_state", "=", PUBLICLY_AVAILABLE)
      .orderBy("id")
      .execute();
  } catch (cause) {
    return err(readFailureOf(cause));
  }

  const listings: PublicListing[] = [];

  for (const row of rows) {
    const result = publicListingFrom(row);

    if (!result.ok) {
      return result;
    }

    if (result.value !== undefined) {
      listings.push(result.value);
    }
  }

  return ok(listings);
}

/**
 * `OP-2`: one listing by its public identity, or the single unavailable outcome.
 *
 * The identity is untrusted input. Anything that is not a canonical UUID string is unavailable
 * before any query, so a malformed identity can neither reach the database nor produce an error
 * that differs from "not available".
 */
export async function findPubliclyAvailableListing(
  db: Kysely<ListingDatabase>,
  identity: unknown,
): Promise<Result<PublicListing, PublicListingUnavailable | PublicListingReadFailure>> {
  if (typeof identity !== "string" || !UUID_SHAPE.test(identity)) {
    return err(NOT_AVAILABLE);
  }

  let row;

  try {
    row = await db
      .selectFrom("listing")
      .selectAll()
      .where("id", "=", identity)
      .where("status", "=", APPROVED_STATUS)
      .where("publication_state", "=", PUBLICLY_AVAILABLE)
      .executeTakeFirst();
  } catch (cause) {
    return err(readFailureOf(cause));
  }

  if (row === undefined) {
    return err(NOT_AVAILABLE);
  }

  const result = publicListingFrom(row);

  if (!result.ok) {
    return result;
  }

  return result.value === undefined ? err(NOT_AVAILABLE) : ok(result.value);
}
