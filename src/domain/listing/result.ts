/**
 * `P1` Slice A — domain result and error representation.
 *
 * Technology-neutral and persistence-neutral: no HTTP status code, no framework
 * response type, no store error mapping, no logging or telemetry decision. Governed
 * behavior that cannot proceed is reported as a value, never as a thrown exception
 * and never as a silent mutation, so that every governed failure is deterministic
 * and assertable in-process (`ADR-002` `O-11`).
 */

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
  /** `DI-11` — an approved listing has no more than one pending revision at a time. */
  | { readonly code: "PENDING_REVISION_ALREADY_EXISTS" }
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
    };
