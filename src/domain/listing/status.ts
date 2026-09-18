/**
 * `P1` Slice A — the listing status set and its permitted lifecycle transitions.
 *
 * **The status set** is exactly the three values `FR-AUD-01` fixes — *pending*,
 * *approved*, *rejected* — and a record holds exactly one of them at all times
 * (`NFR-DATA-01`, `DI-1`). No fourth value exists: `OQ-10` introduced a separate entity
 * (`E7`), `OQ-11` introduced publication state as a separate product concept, and
 * `OQ-13` made purge an end state reached by the passage of time — each declining to add
 * a status (`ADR-006` *Alternatives considered*).
 *
 * **The permitted transitions** are enumerated by `NFR-DATA-02` and by nothing else:
 * *"submitted → pending; pending → approved or rejected; pending → pending on an
 * administrator content edit; and approved → approved when a pending revision is
 * approved"*. `submitted → pending` is record creation, not an ordered status pair, so it
 * is not in the matrix below. *Rejected* is **terminal** — `NFR-DATA-02`'s permitted
 * lifecycle contains **no transition out of *rejected***, and `OQ-13` added none
 * (`FR-ADM-07`; `ADR-006` decision 2). Every ordered pair not listed here is forbidden.
 *
 * No transition is inferred from a conventional state machine; the matrix is the
 * repository's enumeration, transcribed.
 */

import type { Listing } from "./listing";
import { publicationOnApproval, resolvePublicationState } from "./publication";
import { err, ok, type DomainError, type Result } from "./result";

/** `FR-AUD-01` — the complete status set. Nothing may be added to it. */
export const LISTING_STATUSES = ["pending", "approved", "rejected"] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Runtime guard: rejects any value outside the `FR-AUD-01` set (`DI-1`). */
export function isListingStatus(candidate: unknown): candidate is ListingStatus {
  return (LISTING_STATUSES as readonly unknown[]).includes(candidate);
}

/** The `NFR-DATA-02` permitted ordered pairs, verbatim. */
export const PERMITTED_STATUS_TRANSITIONS: readonly (readonly [
  ListingStatus,
  ListingStatus,
])[] = [
  ["pending", "approved"],
  ["pending", "rejected"],
  ["pending", "pending"],
  ["approved", "approved"],
] as const;

export function isPermittedStatusTransition(
  from: ListingStatus,
  to: ListingStatus,
): boolean {
  return PERMITTED_STATUS_TRANSITIONS.some(
    ([permittedFrom, permittedTo]) => permittedFrom === from && permittedTo === to,
  );
}

/**
 * Applies a status transition, or reports a governed failure.
 *
 * Pure and deterministic (`DI-2`): the input listing is never mutated, nothing is
 * thrown, a forbidden ordered pair yields a `DomainError`, and identity and content are
 * carried through unchanged (`DI-8`).
 *
 * The self-transitions the matrix permits are **content-only** edges: they preserve the
 * status, which is precisely what `FR-ADM-05` (editing a pending submission) and
 * `ADR-006` (*"approved → approved, content only"* on revision approval) describe. This
 * function **carries no content change and performs no side effect of any kind**. It
 * changes the status and, since `P1` Slice B, the publication state that the status
 * governs — initializing it on approval and preserving it across the content-only
 * approved edge, exactly as set out below. It changes nothing else.
 *
 * **Publication state follows the status, because `docs/08` draws it that way** (`P1`
 * Slice B, issue #139), and the three cases are kept apart deliberately:
 *
 * - **Initial approval (`pending -> approved`)** explicitly initializes *publicly
 *   available* — the diagram's `[*] -> publicly available : approval (FR-ADM-06)` edge.
 *   An approval therefore never yields an approved listing with no publication state.
 * - **The content-only `approved -> approved` edge preserves the existing state**, so
 *   approving a revision on an unpublished listing leaves it unpublished (`FR-MOD-01`).
 *   It preserves only a **valid** state: a missing or malformed one is **refused**, never
 *   repaired by initializing it — repairing it would publish a listing no administrator
 *   published, which is exactly the implicit publication `FR-MOD-01` forbids. This edge
 *   is not an approval and does not carry approval's initialization.
 * - **Leaving *approved*** carries no publication state, because the concept does not
 *   apply outside *approved*.
 */
export function transitionListingStatus(
  listing: Listing,
  to: ListingStatus,
): Result<Listing, DomainError> {
  if (!isListingStatus(to)) {
    return err({ code: "UNKNOWN_LISTING_STATUS", offered: to });
  }

  if (!isPermittedStatusTransition(listing.status, to)) {
    return err({
      code: "FORBIDDEN_STATUS_TRANSITION",
      from: listing.status,
      to,
    });
  }

  if (to !== "approved") {
    return ok({ id: listing.id, status: to, content: listing.content });
  }

  if (listing.status !== "approved") {
    return ok({
      id: listing.id,
      status: to,
      content: listing.content,
      publication: publicationOnApproval(),
    });
  }

  const current = resolvePublicationState(listing);

  if (!current.ok) {
    return current;
  }

  return ok({
    id: listing.id,
    status: to,
    content: listing.content,
    publication: current.value,
  });
}
