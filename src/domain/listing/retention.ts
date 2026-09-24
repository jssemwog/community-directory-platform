/**
 * `P1` Slice E — retention eligibility for rejected records (issue #149).
 *
 * **What `OQ-13` decided, and what was left to say.** A rejected initial submission and a
 * rejected approved-listing revision are retained **90 days from the rejection**, under one
 * uniform policy, and then become **purge-eligible** (`FR-AUD-06`, `NFR-PRIV-05`, `S-11`).
 * `ADR-017` Q-1/Q-2 put the anchor those 90 days are measured from on each record — the
 * **write-once rejection timestamp**, separate from last-updated, whose *only* purpose is
 * this calculation. Slice C wrote the listing's anchor and Slice D the revision's. What no
 * requirement stated was the **boundary semantics** of "90 days".
 *
 * **Product Owner ruling (issue #149).** "90 days from rejection" is a **fixed elapsed
 * duration** of exactly 90 × 24 hours — 2,160 hours, 7,776,000 seconds,
 * `RETENTION_PERIOD_MILLISECONDS` milliseconds — measured from the applicable write-once
 * rejection instant. Before that boundary a record is **not** purge-eligible; **at** the
 * exact boundary and after it, it is. This is elapsed-time arithmetic over the existing
 * epoch-millisecond `Instant` model: **no** calendar day, time zone, daylight-saving rule,
 * date format or calendar interpretation is involved, and none is introduced here. The
 * ruling clarifies the boundary of the existing `OQ-13` policy; it does not change the
 * approved 90-day period.
 *
 * **Eligibility is a query, and purge is not implemented.** `ADR-017` records
 * purge-eligibility as **derived, not stored**, and this module derives it: it returns an
 * answer and changes nothing. It writes no timestamp, moves no status, touches no
 * publication state, removes no revision, purges nothing, schedules nothing and emits no
 * audit event. Purge scheduling and execution, persistence, store-level atomicity and
 * idempotence, backup expiration and restoration, authorization, application operations and
 * audit remain **unimplemented** and outside this slice. Eligibility *permits* purging; it
 * **is not** a purge, and it changes nothing else about the record (`docs/08`, `docs/11`).
 *
 * **Time is supplied, never read.** The evaluation instant is an argument, exactly as every
 * other moment in this domain is. Nothing here calls `Date.now()`, constructs a `Date`, or
 * consults any other ambient source (`ADR-002` `O-11`, Slice C).
 */

import { isInstant, type Instant } from "./instant";
import type { Listing } from "./listing";
import { err, ok, type DomainError, type Result } from "./result";
import { isRevisionState, type ListingRevision } from "./revision";
import { isListingStatus } from "./status";
import { resolveListingTimestamps } from "./timestamps";

/**
 * The retention period, as the ruling fixes it: 90 × 24 hours in milliseconds.
 *
 * Written as the product of its units rather than as a bare literal, so the figure and the
 * ruling that produced it cannot drift apart: `90 * 24 * 60 * 60 * 1000` is 2,160 hours,
 * 7,776,000 seconds and 7,776,000,000 milliseconds, and the expression says so. It is a
 * **duration**, not a moment, so it is a plain count of milliseconds and not an `Instant`.
 */
export const RETENTION_PERIOD_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;

interface InstantCarrier {
  readonly epochMilliseconds: number;
}

function epochMillisecondsOf(instant: Instant): number {
  return (instant as unknown as InstantCarrier).epochMilliseconds;
}

function isReadableObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * Whether the retention period has elapsed between two proven instants.
 *
 * **The comparison is made without ever constructing the boundary moment.** Computing
 * `rejectedAt + RETENTION_PERIOD_MILLISECONDS` would be the obvious shape and is the wrong
 * one: an anchor near the top of the exactly-representable integer range would produce a
 * boundary outside it, and the comparison would then silently stop distinguishing
 * neighbouring moments — precisely the failure `instantOf` refuses to allow a moment to
 * have. Subtracting instead keeps the arithmetic on the quantity actually being judged.
 *
 * **And the subtraction is checked too.** Two safe integers can differ by more than the
 * safe range, so an elapsed value that is not itself exactly representable is not compared:
 * at that magnitude the difference exceeds the period by more than eleven orders of
 * magnitude, so its **sign** already settles the question exactly. The answer is therefore
 * always the true one, and no case is refused for an arithmetic reason that does not change
 * the outcome.
 */
function periodHasElapsed(evaluatedAt: Instant, rejectedAt: Instant): boolean {
  const evaluated = epochMillisecondsOf(evaluatedAt);
  const anchored = epochMillisecondsOf(rejectedAt);
  const elapsed = evaluated - anchored;

  if (!Number.isSafeInteger(elapsed)) {
    return evaluated > anchored;
  }

  return elapsed >= RETENTION_PERIOD_MILLISECONDS;
}

/**
 * Whether a **rejected listing** has reached its purge-eligibility boundary, or why the
 * question cannot be answered for the value supplied.
 *
 * `true` means the retention period has elapsed and the record **may** be purged; `false`
 * means it is still within the period. Neither answer purges, marks, schedules or alters
 * anything — the record stays administrator-visible until a purge that this slice does not
 * implement removes it (`FR-AUD-06`).
 *
 * **A listing that is not *rejected* is refused, not answered.** It has no retention period
 * running, so "not eligible" would be a false answer to a question that does not apply, and
 * a caller could not tell it apart from a record that is merely still inside its period.
 * The same reasoning keeps every other defect distinct: a value that is not a listing at
 * all, a status outside the governed set, a missing or unusable timestamp bundle, a missing
 * anchor on a rejected record, and a malformed moment are different facts, and Slice C's
 * validator already reports the last four exactly — so they are delegated, not restated.
 *
 * Pure: it reads no clock, mutates nothing it was given, and throws on no input.
 */
export function listingIsPurgeEligible(
  listing: Listing,
  evaluatedAt: Instant,
): Result<boolean, DomainError> {
  if (!isReadableObject(listing)) {
    return err({ code: "INVALID_LISTING", offered: listing });
  }

  if (!isListingStatus(listing.status)) {
    return err({ code: "UNKNOWN_LISTING_STATUS", offered: listing.status });
  }

  if (listing.status !== "rejected") {
    return err({ code: "LISTING_NOT_REJECTED", status: listing.status });
  }

  // Slice C's own validator, reached only once the listing is known to be an object and
  // known to be *rejected*. It reports `LISTING_TIMESTAMPS_MISSING`,
  // `INVALID_LISTING_TIMESTAMPS`, `INVALID_INSTANT`, the order violations and —
  // because the status is *rejected* — `REJECTION_TIMESTAMP_MISSING`, unchanged.
  const timestamps = resolveListingTimestamps(listing);

  if (!timestamps.ok) {
    return timestamps;
  }

  const rejectedAt = timestamps.value.rejectedAt;

  if (rejectedAt === undefined) {
    // Unreachable through `resolveListingTimestamps`, which refuses a *rejected* listing
    // without an anchor. Kept because the anchor is what this module measures from, and a
    // measurement must never begin on a value the type merely says is present.
    return err({ code: "REJECTION_TIMESTAMP_MISSING" });
  }

  if (!isInstant(evaluatedAt)) {
    return err({ code: "INVALID_INSTANT", offered: evaluatedAt });
  }

  return ok(periodHasElapsed(evaluatedAt, rejectedAt));
}

/**
 * Whether a **rejected listing revision** has reached its purge-eligibility boundary, or
 * why the question cannot be answered for the value supplied.
 *
 * **One uniform rule covers both record types** (`OQ-13`): the same period, measured the
 * same way, from each record's own write-once anchor. Identical anchors and identical
 * evaluation instants therefore produce identical answers here and for a listing, and no
 * category, listing status or publication state changes the period — `OQ-13` introduced no
 * category-dependent retention and none is invented here.
 *
 * The distinctions mirror the listing operation: a value that is not a revision, a *state*
 * outside the governed set (a shape defect), a well-formed revision that is not *rejected*
 * (a lifecycle fact), a rejected revision with no anchor, and a malformed anchor or
 * evaluation moment are each reported as themselves. Nothing is read before the value
 * containing it has been proven readable.
 *
 * **The proposal is named by nothing.** This takes the revision it is asked about and
 * introduces no logical revision identifier, ordering identity or positional identity, and
 * no physical representation — a reconstructed revision answers exactly as the original it
 * was rebuilt from (`ADR-017` has discharged `DDM-8`'s design decision; implementing the
 * selected representation is not part of this slice).
 *
 * Pure: it reads no clock, mutates nothing it was given, and throws on no input.
 */
export function revisionIsPurgeEligible(
  revision: ListingRevision,
  evaluatedAt: Instant,
): Result<boolean, DomainError> {
  if (!isReadableObject(revision)) {
    return err({ code: "INVALID_REVISION", offered: revision });
  }

  if (!isRevisionState(revision.state)) {
    return err({ code: "INVALID_REVISION", offered: revision.state });
  }

  if (revision.state !== "rejected") {
    return err({ code: "REVISION_NOT_REJECTED", state: revision.state });
  }

  const rejectedAt = revision.rejectedAt;

  if (rejectedAt === undefined) {
    return err({ code: "REJECTION_TIMESTAMP_MISSING" });
  }

  if (!isInstant(rejectedAt)) {
    return err({ code: "INVALID_INSTANT", offered: rejectedAt });
  }

  if (!isInstant(evaluatedAt)) {
    return err({ code: "INVALID_INSTANT", offered: evaluatedAt });
  }

  return ok(periodHasElapsed(evaluatedAt, rejectedAt));
}
