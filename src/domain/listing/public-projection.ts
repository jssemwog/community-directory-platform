/**
 * `P1` Slice A — the public/withheld boundary as a logical projection (`S-2`, `DI-5`).
 *
 * **Record level (`DI-5`, `FR-VIS-02`).** A record is publicly projectable **if and only
 * if its status is *approved***. Nothing else has a public projection.
 *
 * **Field level (`OQ-7`, Decided 2026-07-31 — `docs/08` *Field classification*).** Given
 * an approved record, the public field set is exactly: business name, category,
 * description, locality, country; administrative area **where provided**; postal code
 * **where provided and designated for public display**; and each of phone, email and
 * website **where the business designated that method public** (`FR-DATA-11c`).
 * Everything else — status, identity, the administrative timestamps, review data,
 * publication state and its reason, and pending-revision content — is
 * administrator-visible or audit-only and never appears here (`NFR-PRIV-01/03`).
 *
 * **`DI-10`.** Only the listing's effective public version is projected. A pending
 * revision's content is never read by this function, under any argument.
 *
 * **`S-2` fail-closed.** A value whose public designation is undecided is **not public**.
 *
 * This is a domain-level projection only. It is not an API payload, a serializer, a
 * query, a search scope, or a UI concern; the enforcement mechanism for the boundary is
 * `DDM-6`, unresolved. Publication state (`OQ-11`) is a further, separate condition on
 * public availability whose representation is `DDM-9`, unresolved — Slice A neither
 * models nor applies it.
 */

import type { DesignatableValue, Listing, ListingContent } from "./listing";
import type { ListingRevision } from "./revision";
import { err, ok, type DomainError, type Result } from "./result";

/** The exact `OQ-7` public field set. No key outside this list may ever be projected. */
export const PUBLIC_PROJECTION_FIELDS = [
  "name",
  "category",
  "description",
  "locality",
  "country",
  "administrativeArea",
  "postalCode",
  "phone",
  "email",
  "website",
] as const;

export type PublicProjectionField = (typeof PUBLIC_PROJECTION_FIELDS)[number];

/**
 * The public view of one approved listing. Conditionally public attributes are **absent**
 * — not blank, not null — when they are not provided or not designated public.
 */
export interface PublicListingProjection {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly locality: string;
  readonly country: string;
  readonly administrativeArea?: string;
  readonly postalCode?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly website?: string;
}

/** `S-2` fail-closed: public only where the designation is explicitly public. */
function publicValueOf(designatable: DesignatableValue | undefined): string | undefined {
  return designatable !== undefined && designatable.designatedPublic === true
    ? designatable.value
    : undefined;
}

function projectContent(content: ListingContent): PublicListingProjection {
  const projection: {
    -readonly [K in keyof PublicListingProjection]: PublicListingProjection[K];
  } = {
    name: content.name,
    category: content.category,
    description: content.description,
    locality: content.locality,
    country: content.country,
  };

  if (content.administrativeArea !== undefined) {
    projection.administrativeArea = content.administrativeArea;
  }

  const postalCode = publicValueOf(content.postalCode);
  if (postalCode !== undefined) {
    projection.postalCode = postalCode;
  }

  const phone = publicValueOf(content.phone);
  if (phone !== undefined) {
    projection.phone = phone;
  }

  const email = publicValueOf(content.email);
  if (email !== undefined) {
    projection.email = email;
  }

  const website = publicValueOf(content.website);
  if (website !== undefined) {
    projection.website = website;
  }

  return projection;
}

/**
 * Projects an approved listing's effective public version, or reports that the record has
 * no public projection at all.
 *
 * The `revisions` argument exists so that `DI-10` is demonstrable rather than merely
 * asserted: a listing's pending revisions may be supplied, and no value derived from any
 * of them can appear in the result.
 */
export function projectListingPublicly(
  listing: Listing,
  _revisions: readonly ListingRevision[] = [],
): Result<PublicListingProjection, DomainError> {
  if (listing.status !== "approved") {
    return err({ code: "LISTING_NOT_APPROVED", status: listing.status });
  }

  return ok(projectContent(listing.content));
}
