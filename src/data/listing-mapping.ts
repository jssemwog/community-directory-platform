/**
 * The `C9` mapping boundary for listings (issue #177).
 *
 * `ADR-022` decision 9 puts the conversion here and nowhere else: *"**The infrastructure adapter
 * owns the conversion** — the `C9` boundary, not the domain."* `ADR-001`/`ADR-002` `O-9` point
 * dependencies strictly inward, so this module imports the domain and the domain knows nothing of
 * it.
 *
 * ## Two directions, two different jobs
 *
 * **Serialization is mechanical.** The aggregate was already built and validated by the domain,
 * so there is nothing to decide: each field becomes its column. Nothing is trimmed, normalized,
 * defaulted or coerced — `VR-S3` leaves format expression undecided, and a persistence layer that
 * "tidied" a value would be inventing a rule nobody governed.
 *
 * **Hydration is adversarial.** A row is not a trusted object. It can be written by a console, a
 * later migration, a restore, or a bug, and the type declarations in `listing-table.ts` are erased
 * at runtime. So every closed value set is re-checked with the domain's own guard — `isListingStatus`,
 * `isCategoryKey`, `isPublicationValue`, `instantOf` — and every governed applicability rule is
 * re-checked against the row. A row that fails **fails explicitly**; it is never repaired, never
 * partially hydrated, and never silently reported as missing.
 *
 * ## No `Date`, in either direction
 *
 * `ADR-022` carries the domain's instants as epoch milliseconds, and the parser installed on the
 * pool delivers them that way. Writing one back needs a `timestamptz`, which a bound number cannot
 * be — so the value is bound as a `bigint` and converted **by PostgreSQL** with exact integer
 * interval arithmetic. `new Date(...)` appears nowhere in this file, which keeps the host time
 * zone, the locale and `Date`'s narrower range out of the write path entirely.
 */

import { sql, type Expression, type Insertable } from "kysely";

import { isCategoryKey, type CategoryKey } from "../domain/listing/category";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf, type ListingId } from "../domain/listing/listing-id";
import type { DesignatableValue, Listing, ListingContent } from "../domain/listing/listing";
import { isPublicationValue, type PublicationState } from "../domain/listing/publication";
import { err, ok, type Result } from "../domain/listing/result";
import { isListingStatus, type ListingStatus } from "../domain/listing/status";
import type { ListingTimestamps } from "../domain/listing/timestamps";
import type { ListingRow, ListingTable } from "./listing-table";

/**
 * The row shape an insert of a listing supplies.
 *
 * Kysely's own `Insertable` is used rather than a hand-written mapping, so the optionality of a
 * database-defaulted column is derived from `listing-table.ts` instead of restated here.
 */
export type ListingInsert = Insertable<ListingTable>;

/**
 * Why a stored row could not become a domain listing.
 *
 * Each case names the **column** at fault and nothing else. The offending value is deliberately
 * omitted: these failures are surfaced to callers and logs, and a stored value is listing content
 * this layer has no business re-publishing in an error string.
 */
export type ListingHydrationFailure =
  /** `status` is not one of the three governed values (`DI-1`). */
  | { readonly code: "UNKNOWN_LISTING_STATUS"; readonly column: "status" }
  /** `category` is not one of the 16 approved machine keys (`DI-9`, `ADR-021`). */
  | { readonly code: "UNAPPROVED_CATEGORY"; readonly column: "category" }
  /** `publication_state` is non-null but not a governed publication value (`OQ-11`). */
  | { readonly code: "UNKNOWN_PUBLICATION_STATE"; readonly column: "publication_state" }
  /** Publication state is present on a non-approved row, or absent on an approved one. */
  | {
      readonly code: "PUBLICATION_STATE_NOT_APPLICABLE";
      readonly column: "publication_state";
    }
  /** `unpublish_reason` is present without an unpublished state, or missing with one. */
  | { readonly code: "UNPUBLISH_REASON_NOT_APPLICABLE"; readonly column: "unpublish_reason" }
  /** A rejection anchor is present on a non-rejected row, or absent on a rejected one. */
  | { readonly code: "REJECTION_TIMESTAMP_NOT_APPLICABLE"; readonly column: "rejected_at" }
  /** A governed instant is not a safe-integer millisecond count (`ADR-022`). */
  | {
      readonly code: "UNUSABLE_INSTANT";
      readonly column: "submitted_at" | "last_updated_at" | "rejected_at";
    };

/**
 * A `timestamptz` carrying exactly this epoch-millisecond instant.
 *
 * `to_timestamp(0)` is the epoch as `timestamptz`; an `interval` stores whole microseconds as a
 * 64-bit integer, so `bigint * interval '1 millisecond'` is **exact** — no floating-point second
 * count, and therefore no rounding to argue about. Negative values (pre-epoch instants, which
 * `ADR-022` admits) work identically.
 *
 * The millisecond count is a **bound parameter**, never interpolated text.
 */
function timestamptzFromEpochMilliseconds(epochMilliseconds: number): Expression<number> {
  return sql<number>`to_timestamp(0) + (${epochMilliseconds}::bigint * interval '1 millisecond')`;
}

/** The epoch-millisecond carrier of an `Instant`, read through its own accessor shape. */
function epochMillisecondsOf(instant: Instant): number {
  return (instant as unknown as { readonly epochMilliseconds: number }).epochMilliseconds;
}

/** The identifier's wrapped value, as `ADR-017` `PS-1` stores it: an opaque UUID string. */
function identifierTextOf(id: ListingId): string {
  const supplied = (id as unknown as { readonly supplied: unknown }).supplied;
  return typeof supplied === "string" ? supplied : String(supplied);
}

/**
 * The columns one `DesignatableValue` occupies.
 *
 * `ADR-017` `PS-2` keeps the designation **beside** the value on the same row, and its default is
 * **not public**. An absent value therefore writes SQL `null` **and** `false`: there is nothing to
 * designate, and the fail-closed default is the honest flag for it.
 */
function designationColumnsOf(
  value: DesignatableValue | undefined,
): { readonly value: string | null; readonly designatedPublic: boolean } {
  if (value === undefined) {
    return { value: null, designatedPublic: false };
  }

  return { value: value.value, designatedPublic: value.designatedPublic === true };
}

/**
 * Turn a newly submitted listing into the row that records it.
 *
 * **Pure.** The listing is read, never written: `ADR-019`'s identifier is used **exactly as
 * supplied** (no generation here, and no database default exists to fall back on), and both
 * governed instants come from the application's own clock reading, never from the database's
 * (`ADR-019`/`ADR-022`: *"the **application supplies every instant**"*).
 *
 * The initial-state applicability rules are not re-decided here, they are simply recorded: a
 * *pending* listing has **no** publication state, **no** unpublish reason and **no** rejection
 * anchor, which is also what the store's own `CHECK`s require.
 */
export function serializeSubmittedListing(listing: Listing): ListingInsert {
  const { content, timestamps } = listing;
  const postalCode = designationColumnsOf(content.postalCode);
  const phone = designationColumnsOf(content.phone);
  const email = designationColumnsOf(content.email);
  const website = designationColumnsOf(content.website);

  return {
    id: identifierTextOf(listing.id),
    status: listing.status,
    name: content.name,
    category: content.category,
    description: content.description,
    locality: content.locality,
    country: content.country,
    administrative_area: content.administrativeArea ?? null,
    postal_code: postalCode.value,
    postal_code_designated_public: postalCode.designatedPublic,
    phone: phone.value,
    phone_designated_public: phone.designatedPublic,
    email: email.value,
    email_designated_public: email.designatedPublic,
    website: website.value,
    website_designated_public: website.designatedPublic,
    publication_state: listing.publication?.value ?? null,
    unpublish_reason:
      listing.publication !== undefined && listing.publication.value === "unpublished"
        ? listing.publication.reason
        : null,
    submitted_at: timestamptzFromEpochMilliseconds(epochMillisecondsOf(timestamps.submittedAt)),
    last_updated_at: timestamptzFromEpochMilliseconds(
      epochMillisecondsOf(timestamps.lastUpdatedAt),
    ),
    rejected_at:
      timestamps.rejectedAt === undefined
        ? null
        : timestamptzFromEpochMilliseconds(epochMillisecondsOf(timestamps.rejectedAt)),
  };
}

/**
 * One optional value and its designation, reconstructed.
 *
 * **The flag alone is not a value.** No `CHECK` ties `*_designated_public` to a non-null column,
 * and the flag is `not null default false`, so the store can hold `postal_code IS NULL` with
 * `postal_code_designated_public = true`. There is nothing to designate in that row, so the field
 * hydrates as **absent** and the stray flag is dropped — which is issue #177's stated rule, and
 * the only reading that cannot leak a designation for a value that does not exist.
 */
function designatableValueFrom(
  value: string | null,
  designatedPublic: boolean,
): DesignatableValue | undefined {
  return value === null ? undefined : { value, designatedPublic };
}

/** A governed instant, or a failure naming its column. */
function instantFrom(
  epochMilliseconds: number,
  column: "submitted_at" | "last_updated_at" | "rejected_at",
): Result<Instant, ListingHydrationFailure> {
  const instant = instantOf(epochMilliseconds);

  return instant.ok ? ok(instant.value) : err({ code: "UNUSABLE_INSTANT", column } as const);
}

/**
 * Rebuild the publication state, enforcing the applicability rule rather than assuming it.
 *
 * `docs/08` and `ADR-017` `PS-7`/`PS-8` make publication state apply **only while approved**, and
 * `listing_publication_state_check` enforces it in the store. A row that disagrees is a row this
 * aggregate cannot represent — an approved listing with no state must **not** be hydrated as
 * publicly available, and a pending one carrying a state must not have it quietly dropped.
 */
function publicationFrom(
  row: ListingRow,
  status: ListingStatus,
): Result<PublicationState | undefined, ListingHydrationFailure> {
  if (row.publication_state === null) {
    // Approved rows must carry one; anything else must not.
    return status === "approved"
      ? err({ code: "PUBLICATION_STATE_NOT_APPLICABLE", column: "publication_state" } as const)
      : ok(undefined);
  }

  if (status !== "approved") {
    return err({
      code: "PUBLICATION_STATE_NOT_APPLICABLE",
      column: "publication_state",
    } as const);
  }

  if (!isPublicationValue(row.publication_state)) {
    return err({
      code: "UNKNOWN_PUBLICATION_STATE",
      column: "publication_state",
    } as const);
  }

  if (row.publication_state === "unpublished") {
    if (row.unpublish_reason === null) {
      return err({
        code: "UNPUBLISH_REASON_NOT_APPLICABLE",
        column: "unpublish_reason",
      } as const);
    }

    return ok({ value: "unpublished", reason: row.unpublish_reason });
  }

  if (row.unpublish_reason !== null) {
    // A reason on a publicly available listing is a contradiction, not a spare field.
    return err({
      code: "UNPUBLISH_REASON_NOT_APPLICABLE",
      column: "unpublish_reason",
    } as const);
  }

  return ok({ value: "publicly_available" });
}

/**
 * Rebuild the administrative timestamps, enforcing the rejection anchor's applicability.
 *
 * `ADR-017` `PS-9` makes the rejection timestamp present **iff** the record is *rejected*, which
 * `listing_rejected_at_check` enforces in the store.
 */
function timestampsFrom(
  row: ListingRow,
  status: ListingStatus,
): Result<ListingTimestamps, ListingHydrationFailure> {
  const submittedAt = instantFrom(row.submitted_at, "submitted_at");

  if (!submittedAt.ok) {
    return submittedAt;
  }

  const lastUpdatedAt = instantFrom(row.last_updated_at, "last_updated_at");

  if (!lastUpdatedAt.ok) {
    return lastUpdatedAt;
  }

  if (row.rejected_at === null) {
    if (status === "rejected") {
      return err({
        code: "REJECTION_TIMESTAMP_NOT_APPLICABLE",
        column: "rejected_at",
      } as const);
    }

    return ok({ submittedAt: submittedAt.value, lastUpdatedAt: lastUpdatedAt.value });
  }

  if (status !== "rejected") {
    return err({
      code: "REJECTION_TIMESTAMP_NOT_APPLICABLE",
      column: "rejected_at",
    } as const);
  }

  const rejectedAt = instantFrom(row.rejected_at, "rejected_at");

  if (!rejectedAt.ok) {
    return rejectedAt;
  }

  return ok({
    submittedAt: submittedAt.value,
    lastUpdatedAt: lastUpdatedAt.value,
    rejectedAt: rejectedAt.value,
  });
}

/** The content half of the aggregate. Only `category` is a closed set needing a guard. */
function contentFrom(row: ListingRow): Result<ListingContent, ListingHydrationFailure> {
  if (!isCategoryKey(row.category)) {
    return err({ code: "UNAPPROVED_CATEGORY", column: "category" } as const);
  }

  const category: CategoryKey = row.category;

  const content: ListingContent = {
    name: row.name,
    category,
    description: row.description,
    locality: row.locality,
    country: row.country,
    ...(row.administrative_area === null
      ? {}
      : { administrativeArea: row.administrative_area }),
    ...withOptional(
      "postalCode",
      designatableValueFrom(row.postal_code, row.postal_code_designated_public),
    ),
    ...withOptional("phone", designatableValueFrom(row.phone, row.phone_designated_public)),
    ...withOptional("email", designatableValueFrom(row.email, row.email_designated_public)),
    ...withOptional(
      "website",
      designatableValueFrom(row.website, row.website_designated_public),
    ),
  };

  return ok(content);
}

/**
 * Spread an optional field **only when it has a value**.
 *
 * `undefined` and absent are different things here: `docs/08`'s optional attributes are *absent*
 * when not provided, and an explicit `postalCode: undefined` key would survive serialization,
 * comparison and `Object.keys` as though the field existed.
 */
function withOptional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Rebuild one listing from one row.
 *
 * **Pure and read-only.** The row is not mutated, nothing is written, no identifier or instant is
 * generated, and no submission behaviour re-runs: `submitListing` is the domain's creation path
 * and this is not it. No revision is loaded, and no revision identity type is invented
 * (`DDM-2`'s remains open).
 */
export function hydrateListing(row: ListingRow): Result<Listing, ListingHydrationFailure> {
  if (!isListingStatus(row.status)) {
    return err({ code: "UNKNOWN_LISTING_STATUS", column: "status" } as const);
  }

  const status: ListingStatus = row.status;

  const content = contentFrom(row);

  if (!content.ok) {
    return content;
  }

  const publication = publicationFrom(row, status);

  if (!publication.ok) {
    return publication;
  }

  const timestamps = timestampsFrom(row, status);

  if (!timestamps.ok) {
    return timestamps;
  }

  return ok({
    id: listingIdOf(row.id),
    status,
    content: content.value,
    ...withOptional("publication", publication.value),
    timestamps: timestamps.value,
  });
}
