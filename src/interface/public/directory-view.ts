/**
 * `C1` — the view states of `S1` (directory) and `S2` (listing detail), derived from the `C9`
 * public read path (issue #248).
 *
 * This module decides **which state a screen is in** and nothing else. It is pure: it reads no
 * environment, performs no I/O and holds no credential, so it is safe to test without a server.
 *
 * ## The states, and the ones that must never be confused (`docs/10`)
 *
 * - `S1`: **results**, **empty directory** or **error**. A read failure is an error and **never**
 *   an empty list (`docs/10` *Error states*). No search or filter exists (`OQ-4`), so the
 *   *no results* state has no criteria to arise from and is not built.
 * - `S2`: **present**, **not available** or **error**. Every non-public outcome maps to the one
 *   frozen `NOT_AVAILABLE` state, whatever the read path reported, so the screen cannot
 *   distinguish never existed, pending, rejected or unpublished (`BI-4`, `UP-4`). That is
 *   equivalence of the **rendered state only**: timing is not addressed here and `BI-4` stays
 *   pending (#246).
 *
 * ## What leaves this module
 *
 * Only values already in the public projection, plus the approved category **label** looked up
 * from governed configuration. No status, timestamp, publication state, identifier detail or
 * failure classification reaches a view: an error state carries nothing.
 *
 * ## Microcopy
 *
 * The strings below are **proposed** wording, not final (`docs/10` `DU-7`). The not-available
 * message is security-relevant text and must be reviewed as such, not polished for helpfulness.
 */

import { categoryFor } from "../../domain/listing/category";
import type { Result } from "../../domain/listing/result";
import type {
  PublicListing,
  PublicListingReadFailure,
  PublicListingUnavailable,
} from "../../data/public-listing-read";

/** Proposed `S1`/`S2` microcopy (`DU-7`). The not-available message is security-relevant. */
export const DIRECTORY_COPY = Object.freeze({
  emptyDirectory: "There are no listings in the directory yet.",
  directoryError: "The directory could not be loaded right now. Please try again.",
  listingError: "This listing could not be loaded right now. Please try again.",
  notAvailable: "This listing is not available.",
  loadingDirectory: "Loading the directory…",
  loadingListing: "Loading the listing…",
});

/** One label/value pair on a listing view. Absent values are omitted, never blank (`FR-VIS-05`). */
export interface ListingField {
  readonly label: string;
  readonly value: string;
  /** Present only for a website whose scheme is `http:` or `https:`. */
  readonly href?: string;
}

/** One directory entry: enough of the public projection to recognise and open a listing. */
export interface DirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly place: string;
}

/** One listing as `S2` shows it. */
export interface ListingDetail {
  readonly name: string;
  readonly description: string;
  readonly fields: readonly ListingField[];
}

export type DirectoryState =
  | { readonly kind: "results"; readonly entries: readonly DirectoryEntry[] }
  | { readonly kind: "empty-directory" }
  | { readonly kind: "error" };

export type ListingDetailState =
  | { readonly kind: "present"; readonly listing: ListingDetail }
  | { readonly kind: "not-available" }
  | { readonly kind: "error" };

const EMPTY_DIRECTORY: DirectoryState = Object.freeze({ kind: "empty-directory" });
const DIRECTORY_ERROR: DirectoryState = Object.freeze({ kind: "error" });

/** The single not-available state, shared by every non-public outcome. */
export const NOT_AVAILABLE: ListingDetailState = Object.freeze({ kind: "not-available" });
const LISTING_ERROR: ListingDetailState = Object.freeze({ kind: "error" });

/** The approved display label, or nothing: an unknown key is withheld, never shown raw. */
function categoryLabelOf(key: string): string | undefined {
  return categoryFor(key)?.label;
}

/** A link target only for an ordinary web address; anything else is shown as text. */
function webHrefOf(value: string): string | undefined {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function placeOf(listing: PublicListing["listing"]): string {
  return [listing.locality, listing.administrativeArea, listing.country]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ");
}

/** `S1`: map `OP-1`'s result to a view state. */
export function directoryStateOf(
  result: Result<readonly PublicListing[], PublicListingReadFailure>,
): DirectoryState {
  if (!result.ok) {
    return DIRECTORY_ERROR;
  }

  if (result.value.length === 0) {
    return EMPTY_DIRECTORY;
  }

  return {
    kind: "results",
    entries: result.value.map(({ id, listing }) => {
      const category = categoryLabelOf(listing.category);

      return {
        id,
        name: listing.name,
        place: placeOf(listing),
        ...(category === undefined ? {} : { category }),
      };
    }),
  };
}

/** `S2`: map `OP-2`'s result to a view state. */
export function listingDetailStateOf(
  result: Result<PublicListing, PublicListingUnavailable | PublicListingReadFailure>,
): ListingDetailState {
  if (!result.ok) {
    return result.error.code === "LISTING_NOT_PUBLICLY_AVAILABLE" ? NOT_AVAILABLE : LISTING_ERROR;
  }

  const { listing } = result.value;
  const category = categoryLabelOf(listing.category);
  const website = listing.website;
  const candidates: ReadonlyArray<ListingField | undefined> = [
    category === undefined ? undefined : { label: "Category", value: category },
    { label: "Location", value: placeOf(listing) },
    listing.postalCode === undefined ? undefined : { label: "Postal code", value: listing.postalCode },
    listing.phone === undefined ? undefined : { label: "Phone", value: listing.phone },
    listing.email === undefined ? undefined : { label: "Email", value: listing.email },
    website === undefined
      ? undefined
      : { label: "Website", value: website, ...withHref(webHrefOf(website)) },
  ];

  return {
    kind: "present",
    listing: {
      name: listing.name,
      description: listing.description,
      fields: candidates.filter((field): field is ListingField => field !== undefined),
    },
  };
}

function withHref(href: string | undefined): { readonly href?: string } {
  return href === undefined ? {} : { href };
}
