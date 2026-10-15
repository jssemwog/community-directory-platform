/**
 * The `C9` mapping boundary for listing revisions (issue #195).
 *
 * The listing mapper's two rules hold here unchanged, and for the same reasons:
 * **serialization is mechanical** — the proposal was already built and validated by the domain,
 * so nothing is trimmed, case-folded, normalized, defaulted or coerced — and **hydration is
 * adversarial**, because a row is not a trusted object. It can be written by a console, a later
 * migration, a restore or a bug, and `listing-table.ts`'s declarations are erased at runtime.
 *
 * The shared column primitives live in `row-mapping.ts`, so the revision's captured base token and
 * the listing's `last_updated_at` are converted by the **same** expression. That is what makes
 * `ADR-023` item 11's exact epoch-millisecond equality structural rather than hoped for.
 *
 * ## What this slice persists, and what it refuses to
 *
 * Only a **genuinely pending** revision. `001`'s `listing_revision_state_check` admits `pending`
 * and `rejected`; `approved` never persists because `ADR-017` Q-3 removes the proposal in the same
 * atomic unit that applies it. Rejection persistence is a separate unit, so serialization accepts
 * `PendingListingRevision` — the domain's own narrowing — and hydration **requires** the row to be
 * pending with no rejection anchor. A stored *rejected* row is not corrupt; it is simply not this
 * slice's business, and saying so is more honest than hydrating one no caller can use.
 *
 * ## The row's `id` is not mapped, and that is deliberate
 *
 * `ListingRevision` carries no identifier field, and `DDM-2`'s *"revision identity domain type"*
 * is open — `ADR-019` lists it under *Must NOT answer*. The column is therefore **read by nobody
 * here**: it is supplied on insert as an application-generated UUID (`ADR-019`), and `DI-11`
 * supplies the addressing the domain uses instead, so no identity needs to surface. Do not "fix"
 * the omission by inventing a domain type; that is a governed decision this unit must not take.
 *
 * ## No `Date`, in either direction
 *
 * `new Date(...)` appears nowhere. Instants arrive as epoch-millisecond safe integers from the
 * parser registered on the pool, and are written back through PostgreSQL's own exact integer
 * interval arithmetic.
 */

import type { Insertable } from "kysely";

import { isCategoryKey, type CategoryKey } from "../domain/listing/category";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { ListingContent } from "../domain/listing/listing";
import { err, ok, type Result } from "../domain/listing/result";
import {
  isRevisionState,
  type PendingListingRevision,
} from "../domain/listing/revision";
import {
  designatableValueFrom,
  designationColumnsOf,
  epochMillisecondsOf,
  identifierTextOf,
  timestamptzFromEpochMilliseconds,
  withOptional,
} from "./row-mapping";
import type { ListingRevisionRow, ListingRevisionTable } from "./listing-table";

/**
 * The row shape an insert of a pending revision supplies.
 *
 * Kysely's own `Insertable` is used rather than a hand-written mapping, so the optionality of a
 * database-defaulted column is derived from `listing-table.ts` instead of restated here.
 */
export type ListingRevisionInsert = Insertable<ListingRevisionTable>;

/**
 * Why a stored row could not become a pending domain revision.
 *
 * Each case names the **column** at fault and nothing else. The offending value is deliberately
 * omitted: these failures are surfaced to callers and logs, and a stored value is proposed listing
 * content this layer has no business re-publishing in an error string.
 */
export type RevisionHydrationFailure =
  /** `state` is not one of the three governed revision states. */
  | { readonly code: "UNKNOWN_REVISION_STATE"; readonly column: "state" }
  /**
   * `state` is governed but cannot be stored — `approved` is the only such value.
   *
   * `001`'s `CHECK` forbids it, so observing one is an integrity fault in the store rather than
   * an ordinary unreadable row, and it is reported as itself rather than as an unknown state.
   */
  | { readonly code: "UNPERSISTABLE_REVISION_STATE"; readonly column: "state" }
  /**
   * The row is `rejected` — a real revision, but not one this slice retrieves.
   *
   * Distinct from every corruption code: nothing is wrong with the row. Rejected-revision
   * retrieval is a later unit, and it would force `DDM-2`'s identity decision.
   */
  | { readonly code: "REVISION_NOT_PENDING"; readonly column: "state" }
  /** A pending row carries a rejection anchor, which no governed operation can produce. */
  | { readonly code: "REJECTION_TIMESTAMP_NOT_APPLICABLE"; readonly column: "rejected_at" }
  /** `category` is not one of the 16 approved machine keys (`DI-9`, `ADR-021`). */
  | { readonly code: "UNAPPROVED_CATEGORY"; readonly column: "category" }
  /** A governed instant is not a safe-integer millisecond count (`ADR-022`). */
  | {
      readonly code: "UNUSABLE_INSTANT";
      readonly column: "base_listing_last_updated_at" | "rejected_at";
    };

/**
 * Turn one pending revision into the row that records it.
 *
 * **Pure.** The revision is read, never written. The identifier is used **exactly as supplied** —
 * `ADR-019` makes the application the sole generator and declares no database default, so there is
 * nothing to fall back on and nothing is generated here. The captured base token is written
 * exactly as the caller captured it: it is never refreshed, recomputed or read from a clock, which
 * is the single failure `ADR-023` exists to prevent.
 *
 * The pending-state applicability rule is not re-decided here, it is simply recorded: a pending
 * revision has **no** rejection anchor, which is also what the store's own `CHECK` requires. The
 * type makes that structural — `rejected_at` is insertable only as SQL `null`.
 */
export function serializePendingRevision(
  revisionId: string,
  revision: PendingListingRevision,
): ListingRevisionInsert {
  const content = revision.proposedContent;
  const postalCode = designationColumnsOf(content.postalCode);
  const phone = designationColumnsOf(content.phone);
  const email = designationColumnsOf(content.email);
  const website = designationColumnsOf(content.website);

  return {
    id: revisionId,
    listing_id: identifierTextOf(revision.listingId),
    state: "pending",
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
    rejected_at: null,
    base_listing_last_updated_at: timestamptzFromEpochMilliseconds(
      epochMillisecondsOf(revision.baseListingLastUpdatedAt),
    ),
  };
}

/** A governed instant, or a failure naming its column. */
function instantFrom(
  epochMilliseconds: number,
  column: "base_listing_last_updated_at" | "rejected_at",
): Result<Instant, RevisionHydrationFailure> {
  const instant = instantOf(epochMilliseconds);

  return instant.ok ? ok(instant.value) : err({ code: "UNUSABLE_INSTANT", column } as const);
}

/** The proposed-content half of the revision. Only `category` is a closed set needing a guard. */
function proposedContentFrom(
  row: ListingRevisionRow,
): Result<ListingContent, RevisionHydrationFailure> {
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
    ...(row.administrative_area === null ? {} : { administrativeArea: row.administrative_area }),
    ...withOptional(
      "postalCode",
      designatableValueFrom(row.postal_code, row.postal_code_designated_public),
    ),
    ...withOptional("phone", designatableValueFrom(row.phone, row.phone_designated_public)),
    ...withOptional("email", designatableValueFrom(row.email, row.email_designated_public)),
    ...withOptional("website", designatableValueFrom(row.website, row.website_designated_public)),
  };

  return ok(content);
}

/**
 * Rebuild one **pending** revision from one row.
 *
 * **Pure and read-only.** The row is not mutated, nothing is written, no identifier or instant is
 * generated, and no domain operation re-runs — `admitPendingRevision` is the domain's admission
 * path and this is not it.
 *
 * The order matters: the state is judged before anything that depends on it, so a row that is not
 * this slice's business is reported as itself rather than being partially rebuilt first. A row
 * that fails **fails explicitly**; it is never repaired, never partially hydrated, and never
 * silently reported as missing.
 */
export function hydratePendingRevision(
  row: ListingRevisionRow,
): Result<PendingListingRevision, RevisionHydrationFailure> {
  if (!isRevisionState(row.state)) {
    return err({ code: "UNKNOWN_REVISION_STATE", column: "state" } as const);
  }

  if (row.state === "approved") {
    return err({ code: "UNPERSISTABLE_REVISION_STATE", column: "state" } as const);
  }

  if (row.state !== "pending") {
    return err({ code: "REVISION_NOT_PENDING", column: "state" } as const);
  }

  // A *pending* proposal carrying a rejection anchor is a state no governed operation can
  // produce — the anchor is written **by** the rejection (`ADR-017` Q-1/Q-2) — and the store's
  // own `CHECK` forbids it. Refused rather than dropped, so the contradiction cannot be hidden
  // by hydrating a revision that looks ordinary.
  if (row.rejected_at !== null) {
    return err({ code: "REJECTION_TIMESTAMP_NOT_APPLICABLE", column: "rejected_at" } as const);
  }

  const content = proposedContentFrom(row);

  if (!content.ok) {
    return content;
  }

  // `ADR-023` item 12 — the base token is mandatory and exact. The column is `NOT NULL`, so an
  // unusable value here is an unreadable carrier rather than an absence, and it is refused
  // instead of being defaulted to anything.
  const baseListingLastUpdatedAt = instantFrom(
    row.base_listing_last_updated_at,
    "base_listing_last_updated_at",
  );

  if (!baseListingLastUpdatedAt.ok) {
    return baseListingLastUpdatedAt;
  }

  // `row.id` is deliberately not read — see the module header.
  //
  // Declared as the narrow type rather than cast into it: `state` is the literal `"pending"` and
  // no rejection anchor is set, so the value **structurally satisfies** `PendingListingRevision`
  // and the compiler checks that rather than being told to assume it.
  const revision: PendingListingRevision = {
    listingId: listingIdOf(row.listing_id),
    state: "pending",
    proposedContent: content.value,
    baseListingLastUpdatedAt: baseListingLastUpdatedAt.value,
  };

  return ok(revision);
}
