/**
 * `P1` Slice B — publication state as a separate product concept (`OQ-11`, Decided
 * 2026-08-04; issue #139).
 *
 * **Why this module exists now, and did not in Slice A.** Slice A recorded publication
 * state as deliberately absent because its representation was `DDM-9`, unresolved.
 * `DDM-9` was discharged by `Accepted` `ADR-017` (2026-09-17, issue #137), so the
 * concept can now be modelled. This module models the **logical** concept only.
 *
 * **Two values, and only while *approved*.** `docs/08` *Status model → Publication
 * state*: an **approved** listing is, independently of its status, in exactly one of two
 * publication states. *Pending* and *rejected* records are not publicly available for
 * reasons settled elsewhere, and **publication state does not apply to them**.
 *
 * **No fourth listing status.** `FR-AUD-01`'s three-value set is untouched: unpublishing
 * changes publication state, never listing status, and an unpublished listing is still
 * *approved* (`DI-1`, `docs/08` *Status model*).
 *
 * **The permitted edges are transcribed, not inferred.** `docs/08` draws exactly three:
 *
 *   `[*] → publicly available` on approval (`FR-ADM-06`)
 *   `publicly available → unpublished` on an administrator unpublish (`FR-ADM-12`)
 *   `unpublished → publicly available` on an administrator republish (`FR-ADM-12`)
 *
 * Every operation off those edges is refused, exactly as `status.ts` refuses every
 * ordered status pair `NFR-DATA-02` does not list.
 *
 * **The repeated-action rule is ruled product policy, not a local reading.** Product
 * Owner ruling of 2026-09-18 (issue #139), recorded in `docs/13` as an ungated
 * clarification and in `docs/08` *The unpublish and republish lifecycle*: **a repeated
 * unpublish or republish action is refused, and changes the listing, its publication
 * state and its current reason not at all.** A second unpublish therefore never replaces
 * the recorded current reason, and a second republish never re-publishes an already
 * public listing. The refusal is **inert with respect to the listing**: it is not a
 * partial application, and the input record is left unchanged (`DI-3`).
 * **That is a statement about listing state, not about audit.** Whether a refused action
 * is recorded anywhere is `OQ-14`/`NOQ-8` (`DG-3`), undecided — this rule neither
 * requires nor forbids such a record, and decides no audit policy.
 *
 * **What this module does not decide.** No stored field, column, type, flag, timestamp,
 * table, or any other representation (`ADR-017` selects the physical design; this is the
 * logical layer). No HTTP status code, route, payload, or cache behaviour. No screen,
 * confirmation dialog, or microcopy. No audit record of unpublishing (`OQ-14`/`NOQ-8`,
 * `DG-3`). No stale-edit policy or version token, and no "replacement" value semantics —
 * both deferred by `ADR-017`. No revision-approval API, and no public identifier.
 */

import type { Listing } from "./listing";
import { isUsableValue } from "./validation";
import { err, ok, type DomainError, type Result } from "./result";

/**
 * The two publication values of `docs/08` *Status model → Publication state*.
 *
 * This set is **separate from, and not a continuation of, the three listing statuses**
 * (`FR-AUD-01`): publication state is its own product concept, applying only while a
 * listing is *approved*. Nothing may be added to it — a third publication value would be
 * a new product state that no approved decision creates, and adding one here would be
 * deciding it. That is a distinct point from `OQ-11`'s refusal to add a **fourth listing
 * status**; the two sets are not the same set and a value in one is never a value in the
 * other.
 */
export const PUBLICATION_VALUES = ["publicly_available", "unpublished"] as const;

export type PublicationValue = (typeof PUBLICATION_VALUES)[number];

/** Runtime guard: rejects any value outside the two-value set. */
export function isPublicationValue(candidate: unknown): candidate is PublicationValue {
  return (PUBLICATION_VALUES as readonly unknown[]).includes(candidate);
}

/**
 * A listing that is available through the public read paths.
 *
 * It carries **no reason**: the unpublish reason is *current administrative state* that
 * exists only while the listing is unpublished (`docs/08` *The unpublish and republish
 * lifecycle*), never a durable record of a past unpublishing — that would be audit
 * (`OQ-14`/`NOQ-8`), which is not decided.
 */
export interface PubliclyAvailable {
  readonly value: "publicly_available";
}

/**
 * A listing withheld from **every** public read path while the record continues to exist
 * and remains administratively visible (`FR-ADM-12`).
 *
 * The reason is **mandatory** and is part of the state itself, so a state carrying no
 * reason is unrepresentable rather than merely invalid. It is administrator-visible and
 * **never public** (`NFR-PRIV-01/03`).
 */
export interface Unpublished {
  readonly value: "unpublished";
  readonly reason: string;
}

/** Exactly one of the two values, at all times, for an approved listing. */
export type PublicationState = PubliclyAvailable | Unpublished;

/**
 * The state an approval produces.
 *
 * `docs/08` draws this edge explicitly — `[*] → publicly available : approval
 * (FR-ADM-06)` — so the initial value is **decided by the chain**, not chosen here. It
 * is exposed as a function rather than a constant so that no call site can mistake it
 * for a default applied to a listing whose state is simply missing: a missing state is
 * refused (see `resolvePublicationState`), never quietly made public.
 */
export function publicationOnApproval(): PublicationState {
  return { value: "publicly_available" };
}

/**
 * Reads a listing's publication state, or reports why it has none that may be relied on.
 *
 * **Fail-closed, and deliberately.** A missing or malformed state on an approved listing
 * is an error, **never** an implied *publicly available* — `FR-MOD-01`: publication is
 * never implicit. Every caller that decides public availability goes through here.
 */
export function resolvePublicationState(
  listing: Listing,
): Result<PublicationState, DomainError> {
  if (listing.status !== "approved") {
    if (listing.publication !== undefined) {
      return err({
        code: "PUBLICATION_STATE_NOT_APPLICABLE",
        status: listing.status,
      });
    }

    return err({ code: "LISTING_NOT_APPROVED", status: listing.status });
  }

  const publication = listing.publication;

  if (publication === undefined) {
    return err({ code: "PUBLICATION_STATE_MISSING" });
  }

  // The state arrives from outside the type system on any real read path, so it is
  // validated as a shape before any field of it is read. `null`, an array and a
  // primitive are each refused as a governed value rather than allowed to throw on
  // property access: a thrown error is not a domain outcome (`ADR-002` `O-11`), and an
  // unhandled one upstream could be mistaken for anything, including availability.
  if (
    typeof publication !== "object" ||
    publication === null ||
    Array.isArray(publication)
  ) {
    return err({
      code: "UNKNOWN_PUBLICATION_VALUE",
      offered: publication as unknown,
    });
  }

  if (!isPublicationValue((publication as { readonly value?: unknown }).value)) {
    return err({
      code: "UNKNOWN_PUBLICATION_VALUE",
      offered: (publication as { readonly value: unknown }).value,
    });
  }

  if (publication.value === "publicly_available") {
    if ("reason" in publication) {
      return err({ code: "PUBLICATION_REASON_NOT_APPLICABLE" });
    }

    return ok(publication);
  }

  if (!isUsableValue(publication.reason)) {
    return err({ code: "UNPUBLISH_REASON_MISSING" });
  }

  return ok(publication);
}

/** Whether a listing is currently reachable through the public read paths. */
export function isPubliclyAvailable(listing: Listing): boolean {
  const resolved = resolvePublicationState(listing);
  return resolved.ok && resolved.value.value === "publicly_available";
}

/**
 * Unpublishes an approved, publicly available listing, recording the current reason.
 *
 * The reason is **required** (`FR-ADM-12`) and must be usable in the sense Slice A
 * already fixed for governed values — non-blank (`isUsableValue`, `VR-S3`). Reusing that
 * rule states no new format rule of any kind.
 *
 * **Explicit confirmation** (`FR-ADM-12`) is an interface obligation for `P4`'s `S6`, not
 * a domain value; it is named here so its absence reads as scope, not as an omission.
 *
 * **A listing that is already unpublished is refused** (ruling, issue #139): the recorded
 * current reason is left exactly as it stands, and no second reason replaces it.
 *
 * Pure: the input listing is not mutated. Identity, status and content are untouched —
 * unpublishing is not a status transition and not a content edit.
 */
export function unpublishListing(
  listing: Listing,
  reason: string,
): Result<Listing, DomainError> {
  const current = resolvePublicationState(listing);

  if (!current.ok) {
    return current;
  }

  if (current.value.value !== "publicly_available") {
    return err({
      code: "PUBLICATION_TRANSITION_FORBIDDEN",
      from: current.value.value,
      to: "unpublished",
    });
  }

  if (!isUsableValue(reason)) {
    return err({ code: "UNPUBLISH_REASON_MISSING" });
  }

  return ok({ ...listing, publication: { value: "unpublished", reason } });
}

/**
 * Republishes an unpublished listing as an explicit administrator action.
 *
 * It **exposes the listing's current approved content** — necessarily so, because in
 * this model a listing carries exactly one content and republishing does not touch it.
 * **No earlier content is restored here**, and this module holds none to restore
 * (`FR-ADM-12`). That is a statement about this model only: it makes no claim about what
 * any other layer retains, and decides no history-retention policy.
 *
 * The unpublish reason is **cleared**: it is current administrative state, and once the
 * listing is public again there is no current reason for it to be withheld.
 *
 * Requires **no separate review or approval workflow** (`FR-ADM-12`).
 *
 * **A listing that is already publicly available is refused** (ruling, issue #139). It is
 * not a silent success and not a no-op that reports success: the action is refused and
 * the listing is left untouched.
 */
export function republishListing(listing: Listing): Result<Listing, DomainError> {
  const current = resolvePublicationState(listing);

  if (!current.ok) {
    return current;
  }

  if (current.value.value !== "unpublished") {
    return err({
      code: "PUBLICATION_TRANSITION_FORBIDDEN",
      from: current.value.value,
      to: "publicly_available",
    });
  }

  return ok({ ...listing, publication: { value: "publicly_available" } });
}
