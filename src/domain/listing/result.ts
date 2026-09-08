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
 * The governed failures Slice A can report. Each corresponds to a rule stated in
 * the approved chain; no code exists here for a rule Slice A does not implement.
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
  | { readonly code: "PENDING_REVISION_ALREADY_EXISTS" };
