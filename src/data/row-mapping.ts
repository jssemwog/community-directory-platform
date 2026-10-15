/**
 * The column primitives both `C9` mappers share (issue #195).
 *
 * `listing-mapping.ts` established every rule here while listings were the only persisted
 * aggregate. `listing_revision` stores the **same** content column set, the same designation
 * pairs and the same `timestamptz(3)` carrier, so a revision mapper either reuses these or
 * grows a second, drifting copy of them.
 *
 * **Copying `timestamptzFromEpochMilliseconds` would have been the real hazard.** Its exactness
 * argument — why an integer-parsed interval is used instead of the obvious
 * `bigint * interval '1 millisecond'`, which PostgreSQL computes in floating point — is the kind
 * of reasoning that survives in one place and quietly rots in two. Extracting it means the
 * revision's base token and the listing's `last_updated_at` are converted by the **same**
 * expression, which is what makes `ADR-023` item 11's exact epoch-millisecond equality
 * structural rather than hoped for.
 *
 * Nothing here is new behaviour: every function is the one `listing-mapping.ts` already had,
 * moved with its reasoning intact. Both mappers now import them, and neither owns them.
 */

import { sql, type Expression } from "kysely";

import type { Instant } from "../domain/listing/instant";
import type { ListingId } from "../domain/listing/listing-id";
import type { DesignatableValue } from "../domain/listing/listing";

/**
 * A `timestamptz` carrying exactly this epoch-millisecond instant.
 *
 * `to_timestamp(0)` is the epoch as `timestamptz`, and an `interval` holds whole microseconds in a
 * 64-bit integer, so adding one is exact. **Building that interval is the part that needs care.**
 *
 * The obvious `bigint * interval '1 millisecond'` is **not** integer arithmetic: PostgreSQL
 * declares only `interval * double precision` (checked in `pg_operator` — there is no `bigint`
 * overload), so the count is silently cast to a double and the product is computed in floating
 * point. Above 2^53 microseconds — roughly year 2255 — that product is no longer exactly
 * representable, and the error can reach about a millisecond at the top of the range `instantOf`
 * admits. A sweep of 187 magnitudes across the whole governed range found no value that actually
 * stored incorrectly, because `timestamptz(3)` rounds to the millisecond and the error stayed
 * under half of one; but "it happens to round back" is not the same as exact, and this is a
 * boundary whose whole purpose is exactness.
 *
 * So the interval is built by **parsing an integer**: PostgreSQL reads `'<n> milliseconds'`
 * straight into its 64-bit microsecond field, with no float operator involved at any point. Every
 * safe-integer millisecond count fits (9.007e18 µs against an int64 limit of 9.22e18), so the
 * conversion is exact by construction rather than by luck, and a value outside `timestamptz`'s
 * own range fails loudly with `22008` instead of being quietly rounded.
 *
 * The millisecond count is a **bound parameter**; only the cast and the unit are SQL text, so
 * nothing is interpolated. Negative values (pre-epoch instants, which `ADR-022` admits) parse
 * identically.
 */
export function timestamptzFromEpochMilliseconds(epochMilliseconds: number): Expression<number> {
  return sql<number>`to_timestamp(0) + ((${epochMilliseconds}::bigint)::text || ' milliseconds')::interval`;
}

/** The epoch-millisecond carrier of an `Instant`, read through its own accessor shape. */
export function epochMillisecondsOf(instant: Instant): number {
  return (instant as unknown as { readonly epochMilliseconds: number }).epochMilliseconds;
}

/** The identifier's wrapped value, as `ADR-017` `PS-1` stores it: an opaque UUID string. */
export function identifierTextOf(id: ListingId): string {
  const supplied = (id as unknown as { readonly supplied: unknown }).supplied;
  return typeof supplied === "string" ? supplied : String(supplied);
}

/**
 * The columns one `DesignatableValue` occupies.
 *
 * `ADR-017` `PS-2` keeps the designation **beside** the value on the same row, and its default is
 * **not public**. An absent value therefore writes SQL `null` **and** `false`: there is nothing to
 * designate, and the fail-closed default is the honest flag for it.
 */
export function designationColumnsOf(
  value: DesignatableValue | undefined,
): { readonly value: string | null; readonly designatedPublic: boolean } {
  if (value === undefined) {
    return { value: null, designatedPublic: false };
  }

  return { value: value.value, designatedPublic: value.designatedPublic === true };
}

/**
 * One optional value and its designation, reconstructed.
 *
 * **The flag alone is not a value.** No `CHECK` ties `*_designated_public` to a non-null column,
 * and the flag is `not null default false`, so the store can hold `postal_code IS NULL` with
 * `postal_code_designated_public = true`. There is nothing to designate in that row, so the field
 * hydrates as **absent** and the stray flag is dropped — which is issue #177's stated rule, and
 * the only reading that cannot leak a designation for a value that does not exist.
 */
export function designatableValueFrom(
  value: string | null,
  designatedPublic: boolean,
): DesignatableValue | undefined {
  return value === null ? undefined : { value, designatedPublic };
}

/**
 * Spread an optional field **only when it has a value**.
 *
 * `undefined` and absent are different things here: `docs/08`'s optional attributes are *absent*
 * when not provided, and an explicit `postalCode: undefined` key would survive serialization,
 * comparison and `Object.keys` as though the field existed.
 */
export function withOptional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
