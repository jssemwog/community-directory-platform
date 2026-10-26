/**
 * `OP-7` / `FR-ADM-06` — the pure-domain approval of a **pending** listing (issue #238).
 *
 * An administrator approves a pending submission, setting its status to *approved* and making
 * it publicly available, **only where every before-approval obligation is satisfied**
 * (`FR-ADM-06`, `FR-VAL-05`). This module composes the rules that already exist into that one
 * operation; it restates none of them.
 *
 * ## Why a composition is needed at all
 *
 * `transitionListingStatus` permits the content-only `approved -> approved` edge, which `OP-10`
 * and `FR-ADM-10b` rely on. Called directly with an *approved* listing and `"approved"`, it
 * therefore **succeeds**, advancing `lastUpdatedAt` and preserving publication. An approval
 * built on the primitive alone would accept an already-approved listing as a second transition.
 * The primitive also does not apply `validateBeforeApproval`. This operation adds the lifecycle
 * guard and the before-approval validation in front of it, and leaves the primitive unchanged.
 *
 * ## The stages, first failure winning
 *
 * 1a. **Status set** — an out-of-set status is `UNKNOWN_LISTING_STATUS { offered }`, carrying the
 *     value unchanged, exactly as `listingIsPurgeEligible` and `resolveReadableListing` report it.
 *     It is **not** coerced to a string and reported as an ordinary lifecycle refusal.
 * 1b. **Lifecycle** — a governed status other than *pending* (*approved* or *rejected*) is
 *     `LISTING_NOT_PENDING { status }`.
 * 2.  **Content** — `validateBeforeApproval`, reused unchanged, every violation carried through as
 *     `LISTING_CONTENT_INVALID { violations }`.
 * 3.  **Timestamps and transition** — `transitionListingStatus(listing, "approved", at)`, called
 *     exactly once: the stored timestamps are resolved, `at` must be a usable instant strictly
 *     later than `lastUpdatedAt`, and on success publication is initialized to
 *     `publicly_available` (`docs/08`: approval initializes publicly available).
 *
 * ## An already-approved listing (Product Owner ruling U-1, Option B, issue #238)
 *
 * This is a **pending-only** domain transition. An already-approved listing, publicly available
 * or unpublished, is **refused** with `LISTING_NOT_PENDING { status: "approved" }`: nothing is
 * written and no listing is returned. `docs/09` (Idempotency of administrative operations)
 * promises that approving an already-approved record is a no-op returning its current state.
 * **That promise belongs to the future `OP-7` operation boundary, is deferred to the later `OP-7`
 * scope, and is neither implemented nor satisfied here.** This refusal is only the domain fact
 * that boundary will need.
 *
 * ## Publication state is not field visibility
 *
 * `publicly_available` is the listing-level publication state: once approved, the listing appears
 * on public read paths with its required fields and any value already designated public. It is
 * not a field-visibility rule. The content object is carried through **by reference**, so approval
 * preserves every visibility designation and grants no restricted field public visibility
 * (`ADR-017` Q-4, `ADR-025`).
 *
 * ## Limits stated rather than hidden
 *
 * - **Validation** is what `validateBeforeApproval` enforces today: the required fields, category
 *   membership and at least one usable contact method, where usable means non-blank. The format,
 *   length and safety limits `VR-S3` leaves to `DD-1`/`DD-2` are undecided and are not invented
 *   here, so the `FR-ADM-06` obligation that every supplied value be valid is enforced only to
 *   that extent.
 * - **Malformed input** follows the existing conventions only. The listing is assumed to be an
 *   object with readable content, on the terms `applyAdministrativeEdit` and `withListingContent`
 *   assume; timestamp defects are reported by the existing primitives. This is not a validator
 *   for arbitrary objects.
 * - **Inherited limitation.** A pending input that carries a `publication` value is malformed (the
 *   store forbids it). Under the current composition the pending branch of
 *   `transitionListingStatus` does not read that field, so a successful approval carries
 *   `publicly_available` regardless. That is recorded as a limitation of the present composition,
 *   not as a repair or normalization policy.
 *
 * ## What this module is not
 *
 * Pure domain: it reads no clock, performs no I/O, imports nothing from `src/data/` and mutates
 * no argument. There is **no** persistence, transaction, lock, stale or viewed-version token,
 * retry, transport, authorization, attribution, audit, moderation note or messaging here, and no
 * production consumer is wired to it. `OP-7` persistence follows a separate decision gate.
 */

import type { Instant } from "./instant";
import type { Listing } from "./listing";
import { err, type DomainError, type Result } from "./result";
import { isListingStatus, transitionListingStatus } from "./status";
import { validateBeforeApproval, type ValidationViolation } from "./validation";

/**
 * Why an approval was refused.
 *
 * A **narrow local union**, on the `AdministrativeEditFailure` precedent: the two refusals this
 * operation itself decides are named here, and `DomainError` is carried through intact for
 * everything the existing primitives report, including `UNKNOWN_LISTING_STATUS`. Nothing is added
 * to `DomainError`.
 */
export type ApprovePendingListingFailure =
  /**
   * `FR-ADM-06`, `DI-2` — a governed but non-pending status (`"approved"` or `"rejected"`).
   * An already-approved source is refused here (U-1, Option B); the `docs/09` no-op is an
   * obligation of the future `OP-7` operation boundary, not of this function.
   *
   * The established `string` shape. An out-of-set status never reaches this member: it is
   * reported earlier, unchanged, as `UNKNOWN_LISTING_STATUS`.
   */
  | { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  /**
   * `FR-ADM-06`, `FR-VAL-05`, `VR-6` — the content does not satisfy the before-approval
   * obligations; the `validateBeforeApproval` violations are carried through unchanged.
   *
   * `REVISION_CONTENT_INVALID` is deliberately not reused: it reports the same rule set on a
   * **revision proposal**, and this reports it on a **pending listing**.
   */
  | {
      readonly code: "LISTING_CONTENT_INVALID";
      readonly violations: readonly ValidationViolation[];
    }
  | DomainError;

/**
 * The timestamp failures an approval can actually report, from `resolveListingTimestamps` and
 * `advancedTimestamps` inside the transition.
 *
 * Exported as documentation of the reachable set and **pinned by test**, as
 * `TimestampAdvancementFailure` is for the administrative edit; it is not used to narrow the
 * failure union. `REJECTION_TIMESTAMP_MISSING` and `REJECTION_TIMESTAMP_ALREADY_SET` are absent:
 * the source is pending and the transition is not a rejection.
 */
export type ApprovalTimestampFailure = Extract<
  DomainError,
  {
    code:
      | "LISTING_TIMESTAMPS_MISSING"
      | "INVALID_LISTING_TIMESTAMPS"
      | "INVALID_INSTANT"
      | "TIMESTAMP_ORDER_VIOLATION"
      | "REJECTION_TIMESTAMP_NOT_APPLICABLE"
      | "INSTANT_NOT_STRICTLY_LATER";
  }
>;

/**
 * Approve one **pending** listing (`OP-7`, `FR-ADM-06`).
 *
 * On success returns a new `Listing`: status *approved*, publication `publicly_available`,
 * `lastUpdatedAt` equal to `at`, and identity, content (by reference) and `submittedAt`
 * unchanged. On failure returns the first failing stage and no listing.
 *
 * Pure and deterministic: the same inputs give the same outcome, no input is mutated, nothing
 * is thrown for the inputs the existing conventions govern, and no clock is consulted.
 */
export function approvePendingListing(
  listing: Listing,
  at: Instant,
): Result<Listing, ApprovePendingListingFailure> {
  // (1a) The status set, first, with the offending value carried unchanged: a rehydrated or cast
  // record can carry anything here, and it must not be presented as a lifecycle refusal.
  if (!isListingStatus(listing.status)) {
    return err({ code: "UNKNOWN_LISTING_STATUS", offered: listing.status });
  }

  // (1b) Lifecycle. An already-approved listing is refused, never approved a second time
  // through the permitted content-only `approved -> approved` edge (U-1, Option B).
  if (listing.status !== "pending") {
    return err({ code: "LISTING_NOT_PENDING", status: listing.status });
  }

  // (2) The before-approval obligations, reused unchanged and accumulating every violation.
  const validated = validateBeforeApproval(listing.content);

  if (!validated.ok) {
    return err({ code: "LISTING_CONTENT_INVALID", violations: validated.error });
  }

  // (3) The transition owns the timestamps and the publication state that approval initializes.
  return transitionListingStatus(listing, "approved", at);
}
