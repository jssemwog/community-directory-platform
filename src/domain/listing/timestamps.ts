/**
 * `P1` Slice C — the administrative timestamps of one listing (`DI-6`, issue #141).
 *
 * **The three moments, and the rules that are decided for them.**
 *
 * - **`submittedAt`** — the moment the record was submitted. Written **once**, never
 *   changes (`FR-AUD-02`, `NFR-DATA-05`; ruling 2).
 * - **`lastUpdatedAt`** — the moment the record's content or status last changed. It
 *   changes on **every** content change **and every** status change, including the
 *   approval that changes no content at all (`FR-AUD-03`, `NFR-DATA-05`; `docs/08`
 *   *"approving a listing changes its last-updated timestamp even though no content
 *   changed"*).
 * - **`rejectedAt`** — the **write-once rejection timestamp** of `ADR-017` Q-1/Q-2
 *   (issue #137): recorded when the listing becomes *rejected*, **separate from
 *   last-updated**, and used **only** to anchor retention eligibility (`FR-AUD-06`,
 *   `NFR-PRIV-05`). It is **not** review-action metadata (`S-7`) and **not** an audit
 *   record (`OQ-14`/`NOQ-8`) — this module computes no eligibility, schedules no purge
 *   and states no retention period.
 *
 * **Strict chronological order** (rulings 3–5). Every successful content change and every
 * permitted status transition requires a supplied instant **strictly later** than the
 * current `lastUpdatedAt`; an equal or earlier one is refused, and the refusal leaves the
 * record untouched. `NFR-DATA-05` says last-updated *changes* on every such change, and
 * an equal instant would not change it — a coarse clock would silently produce a record
 * whose history says two changes happened at one indistinguishable moment. The ruling
 * closes that by requiring the caller to supply an instant that actually advances.
 *
 * **Applicability** (ruling 7). `rejectedAt` is present **if and only if** the status is
 * *rejected*. A *pending* or *approved* listing carrying one is refused, and a *rejected*
 * listing missing one is refused. This is the same fail-closed shape `publication.ts`
 * uses for publication state, and for the same reason: a record that does not satisfy its
 * own applicability rule is not quietly repaired.
 *
 * **Publication is orthogonal** (ruling 8). A publication-state change is neither a
 * content change nor a status change (`OQ-11`, `ADR-006` — the three dimensions are never
 * collapsed), so unpublishing and republishing move **no** timestamp.
 *
 * **Nothing here decides storage.** No column, type, precision, nullability, index or
 * constraint; `ADR-017` owns the physical design and this is the logical layer.
 */

import { instantIsAfter, isInstant, type Instant } from "./instant";
import type { Listing } from "./listing";
import type { ListingStatus } from "./status";
import { err, ok, type DomainError, type Result } from "./result";

/**
 * The administrative moments carried by one listing.
 *
 * `rejectedAt` is optional on the type because it applies only while *rejected*. Optional
 * is not a default: a rejected listing without one is refused rather than treated as
 * never having been rejected (`resolveListingTimestamps`).
 */
export interface ListingTimestamps {
  readonly submittedAt: Instant;
  readonly lastUpdatedAt: Instant;
  readonly rejectedAt?: Instant;
}

/**
 * The timestamps an initial submission produces (ruling 1).
 *
 * Both moments are the **same** supplied instant — the record was submitted then, and
 * that submission is the last thing that happened to it — and there is **no**
 * `rejectedAt`, because the record is *pending*.
 */
export function timestampsOnSubmission(at: Instant): ListingTimestamps {
  return { submittedAt: at, lastUpdatedAt: at };
}

/**
 * Validates the bundle **as a container of moments**, independently of any listing.
 *
 * Separated from the applicability rules below because it is what the write paths need
 * before they may compare anything: a caller-supplied bundle must be proven usable before
 * its `lastUpdatedAt` is read, or the comparison would dereference whatever was passed.
 * Status is deliberately not a parameter — this function judges the moments, not their
 * applicability, and knows nothing about *rejected*.
 *
 * The value arrives as `unknown` because it may come from an unsafe cast, a rehydrated
 * record, or a direct call from outside this module. `null`, an array and a primitive are
 * each refused as a **container** defect (`INVALID_LISTING_TIMESTAMPS`) before any field
 * is read; a field that is present but is not a moment is refused as an **instant**
 * defect (`INVALID_INSTANT`). Nothing is thrown on any input.
 */
function validateMoments(candidate: unknown): Result<ListingTimestamps, DomainError> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return err({ code: "INVALID_LISTING_TIMESTAMPS", offered: candidate });
  }

  const timestamps = candidate as ListingTimestamps;

  if (!isInstant(timestamps.submittedAt)) {
    return err({ code: "INVALID_INSTANT", offered: timestamps.submittedAt });
  }

  if (!isInstant(timestamps.lastUpdatedAt)) {
    return err({ code: "INVALID_INSTANT", offered: timestamps.lastUpdatedAt });
  }

  if (timestamps.rejectedAt !== undefined && !isInstant(timestamps.rejectedAt)) {
    return err({ code: "INVALID_INSTANT", offered: timestamps.rejectedAt });
  }

  return ok(timestamps);
}

function validateShape(
  candidate: unknown,
  status: ListingStatus,
): Result<ListingTimestamps, DomainError> {
  const validated = validateMoments(candidate);

  if (!validated.ok) {
    return validated;
  }

  const timestamps = validated.value;

  // Entailed by rulings 1 and 3 rather than separately ruled: the two moments start
  // equal, and every later write moves `lastUpdatedAt` strictly forward and never moves
  // `submittedAt` at all. A record where submission postdates its last update was
  // therefore never produced by these operations.
  if (instantIsAfter(timestamps.submittedAt, timestamps.lastUpdatedAt)) {
    return err({ code: "TIMESTAMP_ORDER_VIOLATION", field: "submittedAt" });
  }

  const rejectedAt = timestamps.rejectedAt;

  // Entailed by rulings 1, 3, 6 and 7, and checked here for the same reason as the two
  // comparisons around it: a record **rejected before it was submitted** could not have
  // been produced by these operations. Ruling 6 writes `rejectedAt` equal to the
  // `lastUpdatedAt` of the rejecting change, which rulings 1 and 3 have already carried
  // to or past `submittedAt`, and ruling 7 never lets it move again. This validates that
  // entailed state; it states **no** new product policy, forbids no action, and says
  // nothing about when or by whom a listing may be rejected.
  //
  // It is evaluated **before** applicability, so it judges the moments of any record
  // carrying an anchor rather than only a *rejected* one.
  if (rejectedAt !== undefined && instantIsAfter(timestamps.submittedAt, rejectedAt)) {
    return err({ code: "TIMESTAMP_ORDER_VIOLATION", field: "rejectedAt" });
  }

  if (status !== "rejected") {
    if (rejectedAt !== undefined) {
      return err({ code: "REJECTION_TIMESTAMP_NOT_APPLICABLE", status });
    }

    return ok(timestamps);
  }

  if (rejectedAt === undefined) {
    return err({ code: "REJECTION_TIMESTAMP_MISSING" });
  }

  // Entailed in the same way: `rejectedAt` is written equal to `lastUpdatedAt` at the
  // rejection and never rewritten, while `lastUpdatedAt` only moves forward.
  if (instantIsAfter(rejectedAt, timestamps.lastUpdatedAt)) {
    return err({ code: "TIMESTAMP_ORDER_VIOLATION", field: "rejectedAt" });
  }

  return ok(timestamps);
}

/**
 * Reads a listing's timestamps, or reports why they may not be relied on.
 *
 * Every write path goes through here before it writes, so a record that is malformed for
 * a timestamp reason is refused rather than advanced — and refusing it leaves it exactly
 * as it was (`DI-3`).
 *
 * The timestamps arrive from outside the type system on any real read path, so the value
 * is checked as a shape before any field of it is read: `null`, an array and a primitive
 * are each refused as governed values rather than allowed to throw on property access.
 */
export function resolveListingTimestamps(
  listing: Listing,
): Result<ListingTimestamps, DomainError> {
  const timestamps = listing.timestamps as unknown;

  if (timestamps === undefined) {
    return err({ code: "LISTING_TIMESTAMPS_MISSING" });
  }

  return validateShape(timestamps, listing.status);
}

/**
 * The timestamps that result from one governed change, or the reason there are none.
 *
 * `becomingRejected` is supplied by the caller that knows it — the status transition —
 * rather than inferred here, because the rejection moment is written in the **same**
 * change that makes the record *rejected* (ruling 6), and only that caller can say so.
 *
 * **Write-once is enforced by refusal, not by a repair.** A record that already carries a
 * `rejectedAt` cannot acquire another: this function refuses to write over one that
 * exists, and every path out of *rejected* is forbidden by `NFR-DATA-02`. No
 * timestamp-editing operation is introduced here, so there is nothing to attack with one.
 *
 * **Both arguments are validated before anything is compared.** This is an exported
 * boundary, so it cannot assume its `current` came from a successful
 * `resolveListingTimestamps`: a caller reaching it directly — through an unsafe cast, a
 * rehydrated record, or simply by importing it — may offer any value at all. `current` is
 * therefore proven to be a usable container of moments **before** its `lastUpdatedAt` is
 * read, because reading it first is precisely how a malformed value would turn a governed
 * failure into a thrown one (`ADR-002` `O-11`). It judges moments only; **applicability
 * stays with the caller**, which is the one that knows the status.
 *
 * `undefined` supplied directly as `current` is an unusable container and therefore
 * reports `INVALID_LISTING_TIMESTAMPS`, whereas an absent timestamp bundle discovered on a
 * listing by `resolveListingTimestamps` reports `LISTING_TIMESTAMPS_MISSING` — because
 * only that function has a listing in scope to be missing one.
 */
export function advancedTimestamps(
  current: ListingTimestamps,
  at: Instant,
  becomingRejected: boolean,
): Result<ListingTimestamps, DomainError> {
  const validated = validateMoments(current);

  if (!validated.ok) {
    return validated;
  }

  const moments = validated.value;

  if (!isInstant(at)) {
    return err({ code: "INVALID_INSTANT", offered: at });
  }

  if (!instantIsAfter(at, moments.lastUpdatedAt)) {
    return err({ code: "INSTANT_NOT_STRICTLY_LATER" });
  }

  if (!becomingRejected) {
    return ok({ ...moments, lastUpdatedAt: at });
  }

  if (moments.rejectedAt !== undefined) {
    return err({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
  }

  return ok({ ...moments, lastUpdatedAt: at, rejectedAt: at });
}
