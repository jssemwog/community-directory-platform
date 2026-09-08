/**
 * `P1` Slice A — the listing revision (`E7`) and the pending-revision constraint.
 *
 * `OQ-10` (Decided 2026-08-02) committed `E7`: a proposed change to an **already-approved**
 * listing, held apart from the effective public version while it awaits review, never
 * publicly visible (`DI-10`), and adding **no listing status** — a listing carrying a
 * pending revision is still *approved* (`FR-ADM-10`, `DI-1`).
 *
 * **`DI-11` is a concurrency rule, not a history rule.** The listing-to-revision
 * relationship is one-to-many and stays one-to-many; what is constrained is how many
 * revisions may be **pending** at once. It must never be enforced by restricting the
 * relationship (`docs/08` *Data integrity rules*; `ADR-006` decision 5, and its recorded
 * risk). The functions below therefore operate over a listing's revision collection and
 * leave its history untouched.
 *
 * **What this module does not claim.** The rule implemented here is the Slice A
 * **domain** rule, evaluated over a supplied revision collection. It is not, and must not
 * be read as, cross-process or store-level concurrency enforcement: that is a persistence
 * concern (`BI-7`/`DI-3` atomicity, `DDM-8` revision storage) and belongs to a later
 * slice at the level it is enforced (`IP-5`).
 *
 * No storage decision is made here: no version number, table, foreign key, timestamp,
 * pointer, copy, or immutable-history shape. That is `DDM-8`, unresolved.
 */

import type { ListingContent, Listing } from "./listing";
import { listingIdEquals, type ListingId } from "./listing-id";
import { err, ok, type DomainError, type Result } from "./result";

/**
 * The revision states of `docs/08` *The revision lifecycle*. This is the revision's own
 * state, carried by the proposal and never by the listing (`ADR-006` — the three
 * orthogonal dimensions are never collapsed).
 */
export const REVISION_STATES = ["pending", "approved", "rejected"] as const;

export type RevisionState = (typeof REVISION_STATES)[number];

export function isRevisionState(candidate: unknown): candidate is RevisionState {
  return (REVISION_STATES as readonly unknown[]).includes(candidate);
}

/** `E7` — a proposed change to one approved listing. */
export interface ListingRevision {
  /** The listing this proposal belongs to. Identity is the association (`DI-8`). */
  readonly listingId: ListingId;
  readonly state: RevisionState;
  /** Held apart from the effective public version, and never publicly reachable (`DI-10`). */
  readonly proposedContent: ListingContent;
}

/** The revisions of a listing that are currently in the pending state. */
export function pendingRevisionsOf(
  listing: Listing,
  revisions: readonly ListingRevision[],
): readonly ListingRevision[] {
  return revisions.filter(
    (revision) =>
      revision.state === "pending" && listingIdEquals(revision.listingId, listing.id),
  );
}

/**
 * Admits a proposal into the pending state, or reports why it may not enter.
 *
 * Pure: it returns the resulting revision collection and mutates nothing. Rejection of a
 * second pending revision is `DI-11`; the rest are the conditions `FR-ADM-10` states for
 * a revision to exist at all.
 */
export function admitPendingRevision(
  listing: Listing,
  revisions: readonly ListingRevision[],
  proposed: ListingRevision,
): Result<readonly ListingRevision[], DomainError> {
  if (!listingIdEquals(proposed.listingId, listing.id)) {
    return err({ code: "REVISION_LISTING_MISMATCH" });
  }

  if (proposed.state !== "pending") {
    return err({ code: "REVISION_NOT_PENDING", state: proposed.state });
  }

  if (listing.status !== "approved") {
    return err({ code: "LISTING_NOT_APPROVED", status: listing.status });
  }

  if (pendingRevisionsOf(listing, revisions).length > 0) {
    return err({ code: "PENDING_REVISION_ALREADY_EXISTS" });
  }

  return ok([...revisions, proposed]);
}
