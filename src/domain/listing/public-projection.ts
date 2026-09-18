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
 * **`OQ-11` publication state (`P1` Slice B, issue #139).** An approved listing is
 * publicly projectable **only while it is publicly available**: an unpublished one is
 * withheld from every public read path (`FR-ADM-12`), and an approved listing whose
 * publication state is missing or malformed is withheld too — fail-closed, because
 * publication is never implicit (`FR-MOD-01`).
 *
 * **One unavailable outcome, for every unavailable reason (`FR-VIS-08`, `BI-4`).** A
 * listing that is absent, *pending*, *rejected*, or approved-but-unpublished yields the
 * **same** result, disclosing nothing about which case occurred, whether the listing
 * exists administratively, or that it was unpublished, by whom, when, or why
 * (`NFR-PRIV-03`). Slice A reported the record-level refusal with the offending status
 * attached; that shape disclosed the very difference `BI-4` forbids, and Slice B
 * replaces it. **The rule Slice A proved is unchanged** — a record that is not approved
 * still has no public projection.
 *
 * This is a domain-level projection only. It is not an API payload, a serializer, a
 * query, a search scope, or a UI concern. The **physical** mechanism for the boundary is
 * `DDM-6`, discharged by `Accepted` `ADR-017` (2026-09-17) as PS-2 — designations beside
 * the values, one public read projection — and the projection's **form** (a database view
 * or a `C9` query module) is deferred there to the public read path, not decided by this
 * logical layer. It defines no HTTP status code, route, or cache behaviour, and it adds
 * **no identifier field**: how public listing identity is transported is not decided here
 * (`docs/09` `OP-2` is `P2` work).
 */

import type { DesignatableValue, Listing, ListingContent } from "./listing";
import { isPubliclyAvailable } from "./publication";
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
 * Projects a publicly available listing's effective public version, or reports that the
 * listing is not available through any public read path.
 *
 * `listing` accepts `undefined` so that the **absent** case is expressible here and
 * proven to be indistinguishable from the others: a caller that found no record reports
 * unavailability through this same function rather than inventing its own outcome.
 *
 * The `revisions` argument exists so that `DI-10` is demonstrable rather than merely
 * asserted: a listing's pending revisions may be supplied, and no value derived from any
 * of them can appear in the result.
 */
export function projectListingPublicly(
  listing: Listing | undefined,
  _revisions: readonly ListingRevision[] = [],
): Result<PublicListingProjection, DomainError> {
  if (listing === undefined) {
    return err({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
  }

  if (listing.status !== "approved") {
    return err({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
  }

  if (!isPubliclyAvailable(listing)) {
    return err({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
  }

  return ok(projectContent(listing.content));
}
