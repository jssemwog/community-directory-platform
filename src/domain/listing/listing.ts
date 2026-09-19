/**
 * `P1` Slice A — the listing record (`E1`) as a logical type.
 *
 * The field set comes from the `DG-1` answers and from nowhere else
 * (`docs/12` *Phase 1*): `OQ-6` (the location inventory and its obligations), `OQ-7`
 * (the public/withheld designations) and `OQ-8`/`OQ-8b` (the obligation set). Every
 * attribute below traces to an approved `FR-DATA-*` requirement listed against it in
 * `docs/08` *Listing entity* and *Field classification*.
 *
 * Deliberately absent, because Slice A does not own them:
 * - **Review data** (`E4`) — seam `S-7`, open.
 *
 * **Administrative timestamps** (`FR-AUD-02/03`, `DI-6`) were absent in Slice A because
 * `DI-6` belonged to a later slice. That slice is `P1` Slice C (issue #141), so they are
 * added below — submitted-at, last-updated-at, and the write-once rejection timestamp
 * `ADR-017` Q-1/Q-2 anchors retention on. Their rules live in `timestamps.ts`.
 *
 * **Publication state** (`OQ-11`) was absent in Slice A because its representation was
 * `DDM-9`, unresolved. `DDM-9` is discharged by `Accepted` `ADR-017` (2026-09-17), so
 * `P1` Slice B adds it below as the separate product concept it is (issue #139).
 *
 * This is a **logical** model (`docs/08` **P6**): meanings and obligations, never column
 * types, keys, indexes, nullability, or storage shape.
 */

import type { Instant } from "./instant";
import type { ListingId } from "./listing-id";
import type { PublicationState } from "./publication";
import { err, ok, type DomainError, type Result } from "./result";
import type { ListingStatus } from "./status";
import {
  advancedTimestamps,
  resolveListingTimestamps,
  timestampsOnSubmission,
  type ListingTimestamps,
} from "./timestamps";

/**
 * A value the business may designate for public display.
 *
 * `OQ-7` decides the **obligation** — postal code is public only where provided *and*
 * designated for public display, and a contact method is public only where the business
 * designated it public (`FR-DATA-11c`). How that designation is *represented* is
 * `DDM-6`, which remains unresolved; this type expresses the logical designation only.
 *
 * `designatedPublic` is optional so that the `S-2` fail-closed default is expressible:
 * an attribute whose designation is undecided is **not public**.
 */
export interface DesignatableValue {
  readonly value: string;
  readonly designatedPublic?: boolean;
}

/** The listing content governed by the `DG-1` answers. */
export interface ListingContent {
  /** `FR-DATA-01` — required at initial submission. */
  readonly name: string;
  /** `FR-DATA-02` — required at initial submission. Set membership is `DI-9`, a later slice. */
  readonly category: string;
  /** `FR-DATA-03` — required at initial submission. */
  readonly description: string;
  /** `FR-DATA-04` (`OQ-6`) — required at initial submission. */
  readonly locality: string;
  /** `FR-DATA-06` (`OQ-6`) — required at initial submission, on every record. */
  readonly country: string;
  /** `FR-DATA-05` (`OQ-6`) — optional; public where provided. */
  readonly administrativeArea?: string;
  /** `FR-DATA-06b` (`OQ-6`) — optional; public only where provided and designated public. */
  readonly postalCode?: DesignatableValue;
  /** `FR-DATA-07` — individually optional; public only where designated public. */
  readonly phone?: DesignatableValue;
  /** `FR-DATA-07` — individually optional; public only where designated public. */
  readonly email?: DesignatableValue;
  /** `FR-DATA-07` — individually optional; public only where designated public. */
  readonly website?: DesignatableValue;
}

/**
 * One listing record: one durable identity, exactly one status at all times (`DI-1`),
 * and its content. A submission **is** a listing whose status is *pending* — there is no
 * separate submission concept (`ADR-006` decision 1; `docs/08` *Listing-submission entity*).
 */
export interface Listing {
  readonly id: ListingId;
  readonly status: ListingStatus;
  readonly content: ListingContent;
  /**
   * `P1` Slice B — publication state (`OQ-11`), a **separate product concept** from
   * status and never a fourth status value.
   *
   * Optional on the type because it **applies only while *approved*** (`docs/08`
   * *Status model → Publication state*): a *pending* or *rejected* listing has none,
   * and one carrying a state is refused. Optional is not a default: an approved listing
   * whose state is missing is refused rather than treated as publicly available
   * (`resolvePublicationState`, `FR-MOD-01`).
   */
  readonly publication?: PublicationState;
  /**
   * `P1` Slice C — the administrative moments (`DI-6`, issue #141).
   *
   * Required on every listing, because every listing was submitted at some moment and
   * `FR-AUD-02` admits no record without one. They are **system-set only** and **never
   * public** (`FR-DATA-09`, `NFR-DATA-04`, `NFR-PRIV-01`): no public path supplies them,
   * and the public projection carries none of them.
   */
  readonly timestamps: ListingTimestamps;
}

/**
 * Creates the listing one initial submission produces (`docs/08` *Data lifecycle* step 1).
 *
 * The record arrives **pending** — a submission *is* a listing whose status is *pending*
 * (`ADR-006` decision 1) — with `submittedAt` and `lastUpdatedAt` both equal to the
 * supplied instant (ruling 1), **no** rejection timestamp, and **no** publication state,
 * which applies only while *approved*.
 *
 * **What this deliberately does not do.** It applies **no content validation**. `VR-S1`
 * lives in `validation.ts` and is unchanged; composing the two into the submission
 * operation is the operation's own slice, not this one, and doing it here would decide
 * behaviour issue #141 does not authorise. The only governed failure this function can
 * report is a malformed instant.
 *
 * Pure: it reads no clock and mutates nothing.
 */
export function submitListing(
  id: ListingId,
  content: ListingContent,
  at: Instant,
): Result<Listing, DomainError> {
  const timestamps = timestampsOnSubmission(at);
  const validated = resolveListingTimestamps({ id, status: "pending", content, timestamps });

  if (!validated.ok) {
    return validated;
  }

  return ok({ id, status: "pending", content, timestamps: validated.value });
}

/**
 * Replaces a listing's content, leaving its identity, status and publication state
 * untouched.
 *
 * This is the content-edit operation `DI-8` is stated over: a record survives an edit
 * without becoming a different record. It is pure — the input listing is not mutated.
 *
 * **Publication state is preserved deliberately** (`P1` Slice B): a content change is
 * not a publication act, so an unpublished listing stays unpublished when its content is
 * replaced — including when that content came from an approved revision (`docs/08` *The
 * unpublish and republish lifecycle*; `FR-MOD-01`). Only an explicit republish makes a
 * listing public again.
 *
 * **`P1` Slice C — a content change is a change** (`FR-AUD-03`, `DI-6`). It therefore
 * requires a supplied instant **strictly later** than the current `lastUpdatedAt`, and it
 * records it. An equal or earlier instant is refused and nothing is written, which is why
 * this reports a `Result` rather than a listing: replacing content without moving the
 * timestamp would violate `NFR-DATA-05`, so the operation can no longer always succeed.
 * `submittedAt` and any `rejectedAt` are carried through unchanged — a content edit is
 * neither a submission nor a rejection.
 */
export function withListingContent(
  listing: Listing,
  content: ListingContent,
  at: Instant,
): Result<Listing, DomainError> {
  const current = resolveListingTimestamps(listing);

  if (!current.ok) {
    return current;
  }

  const advanced = advancedTimestamps(current.value, at, false);

  if (!advanced.ok) {
    return advanced;
  }

  return ok({ ...listing, content, timestamps: advanced.value });
}
