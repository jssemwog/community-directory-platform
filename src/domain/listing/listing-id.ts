/**
 * `P1` Slice A — stable, content-independent listing identity (`DI-8`, `docs/08` **P2**).
 *
 * What is governed, and therefore what is here: a listing's identity is **stable for
 * the record's entire life**, **survives every content edit and status change**, and is
 * **never derived from content** (`docs/08` *Listing entity*; `ADR-006` decision 1).
 *
 * What is NOT governed, and therefore deliberately absent: the identity **strategy** —
 * UUID, ULID, sequence, natural key, database-generated identity, or anything else — is
 * `DDM-2`, which remains **unresolved** (`docs/08` *Deferred data decisions*; `ADR-006`
 * *Explicit deferrals*). This module therefore provides **no generator**: it wraps an
 * already-supplied identifier and nothing more.
 *
 * The wrapped value is typed `unknown` on purpose. Choosing `string` or `number` here
 * would pick a carrier for identity, and picking a carrier is the first half of `DDM-2`.
 * Equality is value identity over whatever was supplied, which is the only property
 * `DI-8` actually asks for.
 */

declare const listingIdBrand: unique symbol;

/** An opaque logical identity. Its carrier is deliberately not part of its type. */
export interface ListingId {
  readonly [listingIdBrand]: true;
}

interface ListingIdCarrier {
  readonly supplied: unknown;
}

/** Wraps an already-supplied identifier as a logical listing identity. Generates nothing. */
export function listingIdOf(supplied: unknown): ListingId {
  const carrier: ListingIdCarrier = { supplied };
  return carrier as unknown as ListingId;
}

/** Two identities are the same identity when the identifiers they wrap are the same value. */
export function listingIdEquals(a: ListingId, b: ListingId): boolean {
  return Object.is(
    (a as unknown as ListingIdCarrier).supplied,
    (b as unknown as ListingIdCarrier).supplied,
  );
}
