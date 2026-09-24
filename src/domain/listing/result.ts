/**
 * `P1` Slice A — domain result and error representation.
 *
 * Technology-neutral and persistence-neutral: no HTTP status code, no framework
 * response type, no store error mapping, no logging or telemetry decision. Governed
 * behavior that cannot proceed is reported as a value, never as a thrown exception
 * and never as a silent mutation, so that every governed failure is deterministic
 * and assertable in-process (`ADR-002` `O-11`).
 *
 * The one type imported here is `ValidationViolation`, and it is imported **as a type**:
 * the violations a content rule produces are carried by a governed error rather than
 * restated in a second vocabulary. Nothing is imported at runtime, so the module keeps no
 * dependency on the validation rules themselves.
 */

import type { ValidationViolation } from "./validation";

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * The governed failures the domain can report. Each corresponds to a rule stated in
 * the approved chain; no code exists here for a rule the domain does not implement.
 *
 * `P1` Slice B adds the publication-state failures (`OQ-11`, issue #139).
 * `P1` Slice C adds the timestamp failures (`DI-6`, issue #141).
 * `P1` Slice D adds the revision-resolution failures (`FR-ADM-10`, issue #145).
 * `P1` Slice E adds the retention-eligibility failures (`FR-AUD-06`, issue #149).
 */
export type DomainError =
  /** `DI-2` — the ordered status pair is outside the `NFR-DATA-02` permitted set. */
  | {
      readonly code: "FORBIDDEN_STATUS_TRANSITION";
      readonly from: string;
      readonly to: string;
    }
  /** `DI-1` — a value outside the `FR-AUD-01` three-value set was offered as a status. */
  | { readonly code: "UNKNOWN_LISTING_STATUS"; readonly offered: unknown }
  /** `FR-VIS-02`, `DI-5` — a record whose status is not *approved* has no public projection. */
  | { readonly code: "LISTING_NOT_APPROVED"; readonly status: string }
  /** `FR-ADM-10` — a revision proposal belongs to exactly one listing. */
  | { readonly code: "REVISION_LISTING_MISMATCH" }
  /** `FR-ADM-10` — only a proposal in the *pending* revision state can enter the pending state. */
  | { readonly code: "REVISION_NOT_PENDING"; readonly state: string }
  /**
   * `FR-AUD-06`, `OQ-13` — retention eligibility was asked of a listing that is not
   * *rejected*, and therefore has no retention period running.
   *
   * Refused rather than answered `false`. "Not eligible" is a true statement about a
   * rejected record still inside its 90 days, and a false one about a record that was
   * never rejected at all; collapsing the two would tell a caller that a *pending* or
   * *approved* listing is merely waiting out a period it does not have. Distinct from
   * `LISTING_NOT_APPROVED`, which reports the opposite applicability gap on the approved
   * chain, and from `REJECTION_TIMESTAMP_NOT_APPLICABLE`, which is about an anchor a
   * non-rejected record must not carry rather than about a question it cannot be asked.
   */
  | { readonly code: "LISTING_NOT_REJECTED"; readonly status: string }
  /**
   * `FR-AUD-06`, `OQ-13` — retention eligibility was asked of a revision that is not
   * *rejected*.
   *
   * The revision counterpart of `LISTING_NOT_REJECTED`, kept apart from it because the two
   * record types are separately validated and a caller must know which one it handed over.
   * Distinct from `REVISION_NOT_PENDING` (the admission rule's opposite applicability gap)
   * and from `INVALID_REVISION` (a *state* outside the governed set is a shape defect,
   * whereas a well-formed *pending* or *approved* revision is a lifecycle fact).
   */
  | { readonly code: "REVISION_NOT_REJECTED"; readonly state: string }
  /** `DI-11` — an approved listing has no more than one pending revision at a time. */
  | { readonly code: "PENDING_REVISION_ALREADY_EXISTS" }
  /**
   * `FR-ADM-10` — the supplied listing has **no** pending revision to resolve, in a
   * collection that is itself well formed.
   *
   * This is the lifecycle outcome: there is nothing to approve or reject. It is
   * deliberately **not** used for a malformed collection or a malformed entry, which are
   * shape defects with their own codes below — a caller that cannot tell "nothing to do"
   * from "you handed me something unusable" cannot report either one honestly.
   */
  | { readonly code: "PENDING_REVISION_NOT_FOUND" }
  /**
   * `DI-11` — the collection holds **more than one** pending revision for the listing.
   *
   * The state is invalid, and resolution refuses it rather than choosing one: selecting
   * by position would make collection order into business identity, and selecting at all
   * would resolve a proposal nobody named. Distinct from
   * `PENDING_REVISION_ALREADY_EXISTS`, which refuses the *admission* of a second pending
   * revision; this one reports that an invalid state has already been reached.
   */
  | { readonly code: "MULTIPLE_PENDING_REVISIONS"; readonly count: number }
  /**
   * The listing offered to a `P1` Slice D resolution operation is not a usable listing:
   * `null`, an array, a primitive, or an object whose identity or content cannot be read.
   * `offered` carries the offending value — the listing itself for a container defect, or
   * the member at fault.
   *
   * Deliberately narrow, and deliberately **not** a catch-all. A listing whose *status* is
   * outside the governed set is `UNKNOWN_LISTING_STATUS`; a well-formed listing that is
   * simply not *approved* is `LISTING_NOT_APPROVED`; malformed timestamps and publication
   * state keep the exact codes Slices B and C already defined for them. This code names
   * only the shape defects those codes do not reach, so that no property of a listing is
   * read before the value containing it has been proven readable (`ADR-002` `O-11`).
   */
  | { readonly code: "INVALID_LISTING"; readonly offered: unknown }
  /**
   * The revision collection is not a collection: `null`, `undefined`, a primitive, or any
   * other value that cannot hold revisions. Refused as a **container** defect before any
   * element is read, exactly as `INVALID_LISTING_TIMESTAMPS` is for the timestamp bundle.
   */
  | { readonly code: "INVALID_REVISION_COLLECTION"; readonly offered: unknown }
  /**
   * One **entry** of the collection is not a usable revision: not an object, or carrying a
   * malformed `listingId`, `state`, `proposedContent` or `rejectedAt`.
   *
   * Distinct from `INVALID_REVISION_COLLECTION` (the container is unusable) and from
   * `REVISION_NOT_PENDING` (a well-formed proposal in a state that cannot be resolved).
   * It exists so that no property is read before its containing value has been proven
   * readable — a malformed entry is a governed value, never a thrown error
   * (`ADR-002` `O-11`). The offending entry is carried for the administrator-facing
   * caller; it never reaches a public surface.
   */
  | { readonly code: "INVALID_REVISION"; readonly offered: unknown }
  /**
   * `FR-VAL-04`/`FR-VAL-05`, `VR-6` — the proposed content does not satisfy the
   * before-approval obligations, so the revision may not become the effective public
   * version. The field-level violations are carried through unchanged from
   * `validateBeforeApproval`; no rule is restated or re-expressed here.
   *
   * Distinct from every other code in this union: it is the only one that reports a
   * **content** obligation rather than a lifecycle, identity, timestamp or publication
   * defect, and it is the only one that carries field-level detail for `FR-VAL-02`.
   */
  | {
      readonly code: "REVISION_CONTENT_INVALID";
      readonly violations: readonly ValidationViolation[];
    }
  /**
   * `FR-VIS-08`, `BI-4` — the listing is not available through any public read path.
   *
   * **This is the single unavailable outcome**, and it carries **nothing**: no identity,
   * status, publication value, unpublish reason, administrative timestamp or revision
   * content. A listing that is absent, *pending*, *rejected*, or approved-but-unpublished
   * is therefore indistinguishable to an unauthorised observer — which is the whole
   * point, since `BI-4`'s failure mode is an observable difference (`NFR-PRIV-03`).
   */
  | { readonly code: "LISTING_NOT_PUBLICLY_AVAILABLE" }
  /** `docs/08` *Publication state* — publication state does not apply outside *approved*. */
  | { readonly code: "PUBLICATION_STATE_NOT_APPLICABLE"; readonly status: string }
  /** `FR-MOD-01` — an approved listing's publication state is explicit, never implied. */
  | { readonly code: "PUBLICATION_STATE_MISSING" }
  /**
   * The publication state offered is not a usable one: either it is not an object at all
   * (`null`, an array, a primitive), or its value lies outside the two-value set. The
   * offending input is carried for the administrator-facing caller; it never reaches a
   * public surface, which reports only `LISTING_NOT_PUBLICLY_AVAILABLE`.
   */
  | { readonly code: "UNKNOWN_PUBLICATION_VALUE"; readonly offered: unknown }
  /** `FR-ADM-12` — an unpublish reason exists only while the listing is *unpublished*. */
  | { readonly code: "PUBLICATION_REASON_NOT_APPLICABLE" }
  /** `FR-ADM-12` — unpublishing requires a recorded current reason. */
  | { readonly code: "UNPUBLISH_REASON_MISSING" }
  /** `docs/08` *Publication state* — the operation is off the drawn edges. */
  | {
      readonly code: "PUBLICATION_TRANSITION_FORBIDDEN";
      readonly from: string;
      readonly to: string;
    }
  /**
   * `DI-6` — **one individual moment** is not a moment: not a number, `NaN`, infinite,
   * fractional, outside exact integer range, or not an instant-shaped object. This code
   * is about a single `submittedAt`, `lastUpdatedAt` or `rejectedAt` value — never about
   * the bundle that holds them, which has its own code below.
   *
   * The offending input is carried for the administrator-facing caller; it never reaches
   * a public surface, which reports only `LISTING_NOT_PUBLICLY_AVAILABLE`.
   */
  | { readonly code: "INVALID_INSTANT"; readonly offered: unknown }
  /**
   * `DI-6` — a listing carries **no** timestamp bundle at all, and none may be implied
   * for it. Distinct from a bundle that is present but unusable (below): absent and
   * malformed are different defects and are reported differently.
   */
  | { readonly code: "LISTING_TIMESTAMPS_MISSING" }
  /**
   * `DI-6` — the timestamp **bundle** is present but is not a usable timestamp-state
   * object: `null`, an array, a primitive, or any other value that cannot carry the three
   * moments. The individual moments are not reached, so no `INVALID_INSTANT` is produced
   * for this case; the offending container is carried instead.
   */
  | { readonly code: "INVALID_LISTING_TIMESTAMPS"; readonly offered: unknown }
  /**
   * `NFR-DATA-05` — the proposed moment does not advance `lastUpdatedAt` (ruling 3). An
   * equal instant fails here as surely as an earlier one.
   */
  | { readonly code: "INSTANT_NOT_STRICTLY_LATER" }
  /** `DI-6` — the recorded moments are not in the order the rulings can produce. */
  | {
      readonly code: "TIMESTAMP_ORDER_VIOLATION";
      readonly field: "submittedAt" | "rejectedAt";
    }
  /** `ADR-017` Q-1/Q-2 — a rejection timestamp exists only while the listing is *rejected*. */
  | {
      readonly code: "REJECTION_TIMESTAMP_NOT_APPLICABLE";
      readonly status: string;
    }
  /**
   * `ADR-017` Q-1/Q-2 — a *rejected* record without its retention anchor is refused.
   *
   * Raised for a rejected listing by the timestamp rules (`P1` Slice C), and for a rejected
   * revision by the retention query (`P1` Slice E): the anchor is the same concept on both
   * covered record types, measured the same way, so one code reports its absence on either.
   */
  | { readonly code: "REJECTION_TIMESTAMP_MISSING" }
  /** `DI-6` — the rejection timestamp is write-once; a second one is never written. */
  | { readonly code: "REJECTION_TIMESTAMP_ALREADY_SET" };
