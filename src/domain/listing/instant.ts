/**
 * `P1` Slice C — the logical instant (issue #141).
 *
 * **Why a type of its own.** `DI-6` is stated over *moments*: `submitted at` is written
 * once, `last updated at` changes on every content or status change, and a rejection
 * timestamp — where one exists — is written once (`NFR-DATA-05`, `FR-AUD-06`). The
 * Product Owner rulings for this slice add a **strict chronological order**: every
 * successful content change and every permitted status transition requires an instant
 * **strictly later** than the current `last updated at`. An order is not expressible over
 * a bare value unless the domain owns the comparison, so the comparison lives here.
 *
 * **Time is supplied, never read** (ruling 11). Nothing in this module — or anywhere in
 * `src/domain/` — calls `Date.now()`, constructs a `Date`, reads a timer, or consults any
 * other ambient source. Every operation that needs a moment receives it as an argument.
 * That is what keeps the domain pure and deterministic (`DI-2`, `ADR-002` `O-11`) and
 * what makes `DI-6` assertable in-process without a fake clock. **Sourcing** the instant
 * — system clock, database clock, request time, time zone — is excluded from this slice.
 *
 * **What the carrier is, and what choosing it does not decide.** An instant wraps a
 * **finite integer count of milliseconds from the epoch**. That carrier is chosen because
 * it is a **suitable dependency-free carrier**: it is totally ordered and exactly
 * comparable within the safe-integer range, and this slice may add no dependency. It is
 * not claimed to be the only such carrier — it is the one selected here. Two consequences
 * are deliberate:
 *
 * - **It is not `Date`.** A `Date` is mutable — a holder of one can advance it in place —
 *   and a timestamp the domain has written must not be alterable through the reference it
 *   handed out. `Date` also carries formatting and time-zone behaviour this slice has no
 *   business owning.
 * - **It is not a storage or transport decision.** No column type, precision, nullability,
 *   time-zone handling, serialization or wire format is selected or implied here. The
 *   physical design is `ADR-017`'s, which selects a timestamp datum on the listing
 *   structure and leaves its type to that layer; a store is free to hold these moments as
 *   anything that round-trips the same ordering. This module is the **logical** layer
 *   (`docs/08` **P6**), and it decides meanings and comparison only.
 *
 * **Freezing, scoped accurately.** `instantOf` **freezes the values it creates**, so an
 * instant this module produced cannot be edited through a reference to it. That guarantee
 * covers only those values: a **structurally rehydrated** instant — one that arrived as a
 * plain object and was accepted by `isInstant` — **may not be frozen**, and this module
 * neither freezes nor re-wraps it. Freezing is therefore a local convenience, not the
 * mechanism that makes `DI-6` hold.
 *
 * **Write-once behaviour is enforced by the governed write paths** (`ADR-017` PS-9): the
 * operations that write a timestamp refuse to overwrite one, and no timestamp-editing
 * operation exists to be attacked. That is what `DI-6` rests on.
 */

import { err, ok, type DomainError, type Result } from "./result";

declare const instantBrand: unique symbol;

/**
 * One moment on the timeline, comparable.
 *
 * The brand is a **compile-time** guard: it stops an arbitrary number, string or `Date`
 * being passed where an instant is required. It is not a runtime mark, and it is **not** a
 * claim that every value of this type was produced by `instantOf` — `isInstant` accepts a
 * structurally valid moment deliberately, so that a rehydrated record can be validated
 * without re-wrapping every field. Such a value compares correctly and may not be frozen.
 */
export interface Instant {
  readonly [instantBrand]: true;
}

interface InstantCarrier {
  readonly epochMilliseconds: number;
}

function carrierOf(instant: Instant): InstantCarrier {
  return instant as unknown as InstantCarrier;
}

/**
 * Whether a value is a well-formed instant produced by this module.
 *
 * Structural rather than nominal, because an instant arrives from outside the type system
 * on any real path: a listing read back from anywhere may carry anything at all in the
 * field the type says is an instant, and the `DI-6` checks must refuse it as a governed
 * value rather than throw on it (`ADR-002` `O-11`).
 */
export function isInstant(candidate: unknown): candidate is Instant {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return false;
  }

  const offered = (candidate as { readonly epochMilliseconds?: unknown })
    .epochMilliseconds;

  return typeof offered === "number" && Number.isSafeInteger(offered);
}

/**
 * Accepts a caller-supplied moment, or reports why it is not one.
 *
 * Refused: anything that is not a number; `NaN`; both infinities; a fractional value; and
 * any magnitude outside the exactly-representable integer range, where comparison would
 * silently stop distinguishing neighbouring moments. Each is refused as a value —
 * `instantOf` throws nothing.
 *
 * No range, era, minimum or maximum beyond exact representability is imposed: no approved
 * decision states one, and inventing a calendar bound here would be deciding policy this
 * slice does not own.
 */
export function instantOf(epochMilliseconds: unknown): Result<Instant, DomainError> {
  if (typeof epochMilliseconds !== "number" || !Number.isSafeInteger(epochMilliseconds)) {
    return err({ code: "INVALID_INSTANT", offered: epochMilliseconds });
  }

  const carrier: InstantCarrier = Object.freeze({ epochMilliseconds });
  return ok(carrier as unknown as Instant);
}

/** Two instants are the same moment when they denote the same point on the timeline. */
export function instantEquals(a: Instant, b: Instant): boolean {
  return carrierOf(a).epochMilliseconds === carrierOf(b).epochMilliseconds;
}

/**
 * Whether `candidate` is **strictly** later than `reference`.
 *
 * Strict is the ruling (ruling 3): an equal instant is **not** later, and an equal
 * instant is exactly the case a coarse clock produces when two changes land in the same
 * tick. `instantIsAfter(x, x)` is `false` by construction, which is what makes criterion 9
 * assertable rather than aspirational.
 */
export function instantIsAfter(candidate: Instant, reference: Instant): boolean {
  return carrierOf(candidate).epochMilliseconds > carrierOf(reference).epochMilliseconds;
}
