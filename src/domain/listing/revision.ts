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
 * **`P1` Slice D (issue #145) adds the pending state's two exits** — approval and
 * rejection of an *existing* pending revision — and nothing else. The administrator
 * create-and-approve operation (`FR-ADM-10b`), the revision content-edit workflow, and
 * every `OP-*` operation and screen that will later drive these rules (`OP-10`, `OP-6`,
 * `S7`, `S6`, journey `A6`) remain future surface work and are not implemented here.
 *
 * No storage decision is made here: no version number, table, foreign key, timestamp,
 * pointer, copy, or immutable-history shape. That is `DDM-8`, whose design decision
 * `Accepted` `ADR-017` has **discharged**; implementing the selected physical revision
 * representation is not part of this slice.
 */

import { isInstant, type Instant } from "./instant";
import { withListingContent, type ListingContent, type Listing } from "./listing";
import { listingIdEquals, type ListingId } from "./listing-id";
import { resolvePublicationState } from "./publication";
import { err, ok, type DomainError, type Result } from "./result";
import { isListingStatus } from "./status";
import { resolveListingTimestamps } from "./timestamps";
import { validateBeforeApproval } from "./validation";

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
  /**
   * `P1` Slice D — the revision's own **write-once rejection anchor** (`ADR-017` Q-1/Q-2,
   * issue #137), recorded when the proposal is rejected.
   *
   * Optional on the type because it applies only while the revision is *rejected*, in the
   * same fail-closed shape the listing's own anchor uses (`timestamps.ts`). It is
   * **separate from any last-updated notion**, administrator-visible, never public, and
   * used **only** to anchor retention eligibility (`FR-AUD-06`, `NFR-PRIV-05`). This
   * module computes no eligibility, schedules no purge and states no retention period.
   */
  readonly rejectedAt?: Instant;
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

/**
 * `P1` Slice D — the result of a successful approval (issue #145).
 *
 * **The listing and the collection travel together, and that is the point.** `ADR-017`
 * Q-3 requires applying the approved proposal's content and removing that proposal to be
 * **one atomic unit** (`NFR-DATA-03`, `DI-3`). At this pure layer the unit is expressed by
 * the *type*: there is no return shape in which the content was applied and the proposal
 * was not, or the reverse, because a single successful value carries both. Every refusal
 * happens **before** any successful value is produced, and the inputs are never mutated,
 * so a failed approval leaves the caller holding exactly what it passed in.
 *
 * **This is domain atomicity, not store atomicity.** Whether the two writes commit
 * together in a store is a persistence concern (`BI-7`, `C9`, `DDM-8`) and belongs to a
 * later slice at the level it is enforced (`IP-5`).
 */
export interface RevisionResolution {
  readonly listing: Listing;
  readonly revisions: readonly ListingRevision[];
}

function isReadableObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * Whether a proposed-content value can be **read** at all — not whether it is valid.
 *
 * The obligations stay in `validation.ts` and are not restated here (`FR-VAL-05`,
 * `VR-S3`): this asks only whether each attribute is of a kind the rules can inspect, so
 * that a rehydrated record carrying a number where a name belongs produces a governed
 * failure instead of throwing inside a rule that reasonably expects a string. No format,
 * length, pattern or safety policy is expressed, and no attribute is required here.
 */
function isReadableContent(candidate: unknown): boolean {
  if (!isReadableObject(candidate)) {
    return false;
  }

  const plainFields = [
    "name",
    "category",
    "description",
    "locality",
    "country",
    "administrativeArea",
  ] as const;

  for (const field of plainFields) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== "string") {
      return false;
    }
  }

  for (const field of ["postalCode", "phone", "email", "website"] as const) {
    const designatable = candidate[field];

    if (designatable === undefined) {
      continue;
    }

    if (!isReadableObject(designatable)) {
      return false;
    }

    if (
      designatable.value !== undefined &&
      typeof designatable.value !== "string"
    ) {
      return false;
    }

    if (
      designatable.designatedPublic !== undefined &&
      typeof designatable.designatedPublic !== "boolean"
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Whether one entry of the collection is a usable revision.
 *
 * Shape only — state *values* are governed by `isRevisionState`, identity by
 * `listingIdEquals`, moments by `isInstant`. Nothing below is read before the value
 * containing it has been proven readable, which is what keeps a malformed entry a
 * governed value rather than a thrown error (`ADR-002` `O-11`).
 */
function isReadableRevision(candidate: unknown): candidate is ListingRevision {
  if (!isReadableObject(candidate)) {
    return false;
  }

  if (!isReadableObject(candidate.listingId)) {
    return false;
  }

  if (!isRevisionState(candidate.state)) {
    return false;
  }

  if (!isReadableContent(candidate.proposedContent)) {
    return false;
  }

  return candidate.rejectedAt === undefined || isInstant(candidate.rejectedAt);
}

/**
 * Whether the listing handed to a Slice D operation can be read at all, and reports the
 * exact reason when it cannot.
 *
 * **This hardens the two new Slice D entry points, and only those.** It is not a claim
 * about any other domain operation: Slices A–C are untouched by this round, and each of
 * them still reads the listing it is given the way it always has.
 *
 * **It states no product rule.** Every field is judged for *readability* — and where the
 * chain already owns a judgement, that judgement is delegated rather than restated, so the
 * distinctions survive: an out-of-set status stays `UNKNOWN_LISTING_STATUS` (`DI-1`); a
 * well-formed listing that is merely not *approved* stays `LISTING_NOT_APPROVED`; malformed
 * moments keep Slice C's timestamp codes; a missing or unusable publication state keeps
 * Slice B's fail-closed codes (`FR-MOD-01`). Blank or policy-invalid *content* is not a
 * shape defect at all and is never reported here — `validation.ts` owns that outcome.
 *
 * The order matters: a value is proven readable before anything inside it is read.
 */
function resolveReadableListing(listing: Listing): Result<Listing, DomainError> {
  if (!isReadableObject(listing)) {
    return err({ code: "INVALID_LISTING", offered: listing });
  }

  if (!isReadableObject(listing.id)) {
    return err({ code: "INVALID_LISTING", offered: listing.id });
  }

  if (!isListingStatus(listing.status)) {
    return err({ code: "UNKNOWN_LISTING_STATUS", offered: listing.status });
  }

  if (!isReadableContent(listing.content)) {
    return err({ code: "INVALID_LISTING", offered: listing.content });
  }

  // Slice C's own validator, reached only once the listing is known to be an object —
  // it reports `LISTING_TIMESTAMPS_MISSING`, `INVALID_LISTING_TIMESTAMPS`,
  // `INVALID_INSTANT`, the order violations and the anchor-applicability rules unchanged.
  const timestamps = resolveListingTimestamps(listing);

  if (!timestamps.ok) {
    return timestamps;
  }

  if (listing.status !== "approved") {
    return err({ code: "LISTING_NOT_APPROVED", status: listing.status });
  }

  // Slice B's fail-closed publication rule. An approved listing carries its publication
  // state explicitly, and this operation will carry that state into its own result, so a
  // state that could not be relied on is refused here rather than propagated.
  const publication = resolvePublicationState(listing);

  if (!publication.ok) {
    return publication;
  }

  return ok(listing);
}

/**
 * Finds the listing's **sole pending revision**, or reports why there is not exactly one.
 *
 * **There is no target argument, and that is the correction this design turns on.** A
 * revision reconstructed from persistence, from a request, or from another process is the
 * same logical proposal even though it is a different JavaScript object, so object
 * reference cannot stand in for domain identity — and `E7` carries no logical identifier
 * to use instead, because this increment introduces none: inventing one here, or using a
 * position, would be a data decision Slice D is not authorised to make. What the chain
 * *does* supply is `DI-11`: an approved listing has **at most one** pending revision at a
 * time. That rule names the proposal without identifying it, so resolution operates on the
 * sole pending revision of the supplied listing and nothing else.
 *
 * **Order is read, never trusted.** The index returned says where the proposal sits so
 * that every other entry keeps its position and value; it is never what selects it. Two
 * pending revisions are refused rather than disambiguated by position.
 *
 * The outcomes are kept apart deliberately: an unusable listing, an unusable collection,
 * an unusable entry, a well-formed collection with nothing pending for this listing, one
 * pending revision belonging to a *different* listing, more than one pending revision, and
 * a pending proposal already carrying a rejection anchor are different facts about the
 * input, and each is reported as itself.
 */
function resolveSolePendingRevision(
  listing: Listing,
  revisions: readonly ListingRevision[],
): Result<number, DomainError> {
  const readable = resolveReadableListing(listing);

  if (!readable.ok) {
    return readable;
  }

  if (!Array.isArray(revisions)) {
    return err({ code: "INVALID_REVISION_COLLECTION", offered: revisions });
  }

  for (const entry of revisions) {
    if (!isReadableRevision(entry)) {
      return err({ code: "INVALID_REVISION", offered: entry });
    }
  }

  const pending = revisions
    .map((revision, position) => ({ revision, position }))
    .filter(({ revision }) => revision.state === "pending");

  const mine = pending.filter(({ revision }) =>
    listingIdEquals(revision.listingId, listing.id),
  );

  if (mine.length > 1) {
    return err({ code: "MULTIPLE_PENDING_REVISIONS", count: mine.length });
  }

  const only = mine[0];

  if (only === undefined) {
    // A pending proposal exists, but it belongs to another listing — a distinguishable
    // fact, and reported as itself rather than folded into "nothing to resolve".
    if (pending.length > 0) {
      return err({ code: "REVISION_LISTING_MISMATCH" });
    }

    return err({ code: "PENDING_REVISION_NOT_FOUND" });
  }

  // A *pending* proposal carrying a rejection anchor is a state no governed operation can
  // produce — the anchor is written **by** the rejection, in the same change that leaves
  // the proposal *rejected* (`ADR-017` Q-1/Q-2). Both exits refuse it here, before
  // anything is validated, advanced, applied, removed or replaced, so the anchor is never
  // rewritten and never quietly discarded along with a removed proposal.
  if (only.revision.rejectedAt !== undefined) {
    return err({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
  }

  return ok(only.position);
}

/**
 * Approves the listing's sole pending revision: its content becomes the listing's
 * effective public version, and the approved proposal is removed — as one unit
 * (`FR-ADM-10`, `ADR-017` Q-3).
 *
 * **The proposal is named by `DI-11`, not by a supplied target** — see
 * `resolveSolePendingRevision`. A cloned or rehydrated collection therefore resolves
 * exactly as the original does.
 *
 * **What it reuses rather than restates.** The before-approval obligations are
 * `validateBeforeApproval` exactly as a public submission and an administrator's
 * completion meet them (`FR-VAL-04`, `FR-VAL-05`, `VR-6`) — there is no privileged
 * bypass and no second rule set. The content application, the strictly-later instant and
 * the preservation of identity, status, `submittedAt`, any rejection anchor and the
 * publication state are `withListingContent` (`DI-6`, `DI-8`, `FR-AUD-03`), which Slice B
 * already fixed to leave an unpublished listing unpublished (`FR-MOD-01`, `FR-MOD-06`).
 *
 * **Removal is of the approved proposal only.** Rejected revisions and every other
 * retained record stay exactly where they are, governed by their own rules (`FR-AUD-06`);
 * nothing here purges, expires or discards them, and `DI-11` is served because the
 * pending slot is freed rather than because history was trimmed.
 *
 * **The listing's status does not change** — it was *approved* and it stays *approved*
 * (`DI-1`, `FR-AUD-01`). No fourth status and no new publication value exists.
 *
 * Pure: it reads no clock, mutates neither the listing nor the collection, and reports
 * every governed failure as a value.
 */
export function approvePendingRevision(
  listing: Listing,
  revisions: readonly ListingRevision[],
  at: Instant,
): Result<RevisionResolution, DomainError> {
  const located = resolveSolePendingRevision(listing, revisions);

  if (!located.ok) {
    return located;
  }

  const target = revisions[located.value] as ListingRevision;
  const validated = validateBeforeApproval(target.proposedContent);

  if (!validated.ok) {
    return err({ code: "REVISION_CONTENT_INVALID", violations: validated.error });
  }

  // The instant is validated here, by the operation that owns the timestamps: a malformed
  // one, and one that does not advance `lastUpdatedAt`, are both refused before any
  // successful value exists (`NFR-DATA-05`).
  const applied = withListingContent(listing, target.proposedContent, at);

  if (!applied.ok) {
    return applied;
  }

  return ok({
    listing: applied.value,
    revisions: revisions.filter((_, position) => position !== located.value),
  });
}

/**
 * Rejects the listing's sole pending revision, recording its write-once rejection anchor.
 *
 * The proposal is named by `DI-11` exactly as it is for approval, and every other entry
 * keeps its position and its value — only the resolved proposal is replaced by its
 * rejected form.
 *
 * **The listing is not an input to the outcome.** `FR-ADM-10` says the approved listing is
 * left unchanged when a revision is rejected, so this returns the revision collection
 * alone: there is no updated listing to return, and no path here through which one could
 * be written. No listing timestamp moves — rejecting a proposal is neither a content
 * change nor a status change of the listing (`DI-6`, `NFR-DATA-05`).
 *
 * **Write-once is enforced by refusal, not by a repair** — the same shape Slice C used for
 * the listing's own anchor. A proposal that already carries one cannot acquire another —
 * `resolveSolePendingRevision` refuses it for **both** exits, so approval cannot make such
 * an anchor disappear by removing the proposal either — and a revision that is no longer
 * *pending* cannot be resolved a second time, so there is no operation here with which to
 * attack the anchor.
 *
 * The rejected proposal **stays in the collection**: it is retained under `FR-AUD-06`
 * until purged, and this module neither computes that eligibility nor performs the purge.
 *
 * Pure: it reads no clock and mutates nothing it was given.
 */
export function rejectPendingRevision(
  listing: Listing,
  revisions: readonly ListingRevision[],
  at: Instant,
): Result<readonly ListingRevision[], DomainError> {
  const located = resolveSolePendingRevision(listing, revisions);

  if (!located.ok) {
    return located;
  }

  const target = revisions[located.value] as ListingRevision;

  if (!isInstant(at)) {
    return err({ code: "INVALID_INSTANT", offered: at });
  }

  const rejected: ListingRevision = { ...target, state: "rejected", rejectedAt: at };

  return ok(
    revisions.map((revision, position) =>
      position === located.value ? rejected : revision,
    ),
  );
}
