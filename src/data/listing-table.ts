/**
 * The Kysely database typing for the first `C9` persistence slice (issue #177).
 *
 * **Every name, type and nullability here is read off the immutable first migration**
 * (`001-create-listing-and-revision-tables.ts`, `ADR-018`). This file invents nothing: it is a
 * TypeScript description of a schema that already exists, and it must be corrected to match the
 * migration if the two ever disagree — never the other way round.
 *
 * ## What the column types claim, and what they deliberately do not
 *
 * A TypeScript type cannot police a database. These interfaces therefore describe the values the
 * driver **will** deliver and accept, and **nothing stronger**:
 *
 * - `status`, `category` and `publication_state` are typed **`string`**, not their governed
 *   unions. The store constrains them with `CHECK`s, but a row can still be written by a
 *   migration, a console or a future bug, so hydration validates them at runtime
 *   (`listing-mapping.ts`). Typing them as `ListingStatus` or `CategoryKey` here would be a
 *   claim this layer cannot keep and would make the runtime guards look redundant.
 * - The four governed instants select as **`number`** — epoch milliseconds — because
 *   `createTimestamptzTypeOverrides()` is registered on the pool (`ADR-022` decision 9). Without
 *   that registration they would arrive as `Date`, so the select type is a statement about the
 *   **configured** connection, and `connection.ts` is what makes it true.
 * - They insert as a **SQL expression**, never a bare number: PostgreSQL cannot cast a number to
 *   `timestamptz`, and the conversion must stay exact to the millisecond. `listing-mapping.ts`
 *   builds that expression.
 * - **Every update type is `never` — a restriction of *this unit*, not an architectural rule.**
 *   Issue #177 authorizes exactly one insert and one read (§5/§6), so an unauthorized write
 *   should not compile, and the type system is the cheapest place to say so. It is **not** a
 *   claim that listings are immutable: `OP-6`–`OP-10` moderation and revision writes are
 *   expected, and `ADR-017` `PS-9`'s write-once columns are the only genuinely permanent
 *   restriction here. The unit that implements those paths is expected to widen these types,
 *   and changing a `never` is the tripwire that makes it say so deliberately.
 * - The `*_designated_public` flags carry a database `DEFAULT false`, so their insert type admits
 *   `undefined`. Serialization still supplies every one of them explicitly — the default is the
 *   store's fail-closed backstop (`ADR-017` `PS-2`), not this layer's way of omitting a value.
 *
 * ## `listing_revision` — writable for the `OP-6` creation path only (issue #195)
 *
 * Kysely's database interface is the map of the schema, and a map missing a real table invites a
 * later unit to add it twice. The table was typed for that reason alone under issue #177, with
 * every column read-only so that no revision write could compile.
 *
 * **Issue #195 trips that tripwire deliberately, for one operation.** The columns `OP-6` writes
 * are now `Written`, so a pending revision can be inserted; every update type stays `never`, and
 * `rejected_at` is insertable **only as SQL `null`**, because this slice persists *pending*
 * revisions and nothing else. Rejection persistence must therefore widen the type again, and say
 * so deliberately — the tripwire is preserved for the next unit rather than removed.
 *
 * ### The identifier, and the blocker that was overstated
 *
 * Issue #177 recorded that the table *"cannot be honestly hydrated today, because it stores
 * `id uuid not null` while the domain's `ListingRevision` carries **no identifier field**"*. The
 * premise is right and still holds; the conclusion was too strong.
 *
 * A row's `id` that the domain has no field for is not unrepresentable **data** — it is a
 * physical identifier the domain deliberately does not model, and `DI-11` supplies the addressing
 * the domain uses instead: an approved listing has at most one *pending* revision, enforced by
 * `listing_revision_one_pending_per_listing`, so `listing_id` plus the *pending* state names
 * exactly one row without any identity of its own. Nothing governed is lost by not mapping the
 * column: the value stays in the row, and `ADR-024`'s `OP-10` re-reads it inside its own
 * transaction (`SELECT id … FOR UPDATE`, then `DELETE … WHERE id = $revisionId`), so no later
 * path depends on this slice surfacing it.
 *
 * `DDM-2`'s *"revision identity domain type"* therefore remains **open and untouched**, exactly
 * as `ADR-019` requires — the identifier crosses the `C9` boundary as an application-supplied
 * `string` parameter (`ADR-019`: the application is the sole generator, PostgreSQL declares no
 * default) and never enters the domain.
 */

import type { ColumnType, Expression, Selectable } from "kysely";

/** A column this slice reads and writes once, and never updates. */
type Written<Select, Insert = Select> = ColumnType<Select, Insert, never>;

/** A column this slice reads but must never write. */
type ReadOnlyColumn<Select> = ColumnType<Select, never, never>;

/**
 * A governed instant: epoch milliseconds out, a SQL expression in.
 *
 * `ADR-022` stores every governed instant as `timestamptz(3)`. The parser registered on the pool
 * turns the wire value into a plain safe-integer millisecond count; writing one back requires an
 * expression, because a bound number has no `timestamptz` meaning to PostgreSQL.
 */
type GovernedInstant = ColumnType<number, Expression<number>, never>;

/** The same, for a column that is null unless its governed condition holds. */
type OptionalGovernedInstant = ColumnType<number | null, Expression<number> | null, never>;

/** The `listing` table, exactly as the first migration created it. */
export interface ListingTable {
  /** `uuid not null` — `ADR-017` `PS-1`; the **application** supplies it (`ADR-019`). */
  id: Written<string>;
  /** `text not null`, `CHECK`ed against the three governed statuses. */
  status: Written<string>;
  name: Written<string>;
  /** `text not null`, `CHECK`ed against the 16 approved machine keys (`ADR-021`). */
  category: Written<string>;
  description: Written<string>;
  /** `text not null` — free text (`ADR-020`). */
  locality: Written<string>;
  /** `text not null` — free text (`ADR-020`). */
  country: Written<string>;
  /** `text` — optional (`ADR-020`); absent is SQL `null`, never `''`. */
  administrative_area: Written<string | null>;
  postal_code: Written<string | null>;
  /** `boolean not null default false` — `ADR-017` `PS-2`, fail-closed. */
  postal_code_designated_public: Written<boolean, boolean | undefined>;
  phone: Written<string | null>;
  phone_designated_public: Written<boolean, boolean | undefined>;
  email: Written<string | null>;
  email_designated_public: Written<boolean, boolean | undefined>;
  website: Written<string | null>;
  website_designated_public: Written<boolean, boolean | undefined>;
  /** `text`, non-null **iff** `status = 'approved'` (`listing_publication_state_check`). */
  publication_state: Written<string | null>;
  /** `text`, non-null **iff** `publication_state = 'unpublished'`. */
  unpublish_reason: Written<string | null>;
  /** `timestamptz(3) not null` — write-once (`DI-6`, `ADR-022`). */
  submitted_at: GovernedInstant;
  /** `timestamptz(3) not null` — strictly increasing (`NFR-DATA-05`, `ADR-022`). */
  last_updated_at: GovernedInstant;
  /** `timestamptz(3)`, non-null **iff** `status = 'rejected'` (`listing_rejected_at_check`). */
  rejected_at: OptionalGovernedInstant;
}

/**
 * The `listing_revision` table — insertable by the `OP-6` creation path, never updatable.
 *
 * See the module header for what issue #195 widened and what it deliberately did not.
 */
export interface ListingRevisionTable {
  /** `uuid not null` — `ADR-017` `PS-1`; the **application** supplies it (`ADR-019`). */
  id: Written<string>;
  /** `uuid not null`, foreign key to `listing (id)`. */
  listing_id: Written<string>;
  /** `CHECK`ed against `pending` and `rejected` only: an approved proposal's row is removed in
   * the same atomic unit that applies it (`ADR-017` Q-3), so `approved` never persists. */
  state: Written<string>;
  name: Written<string>;
  category: Written<string>;
  description: Written<string>;
  locality: Written<string>;
  country: Written<string>;
  administrative_area: Written<string | null>;
  postal_code: Written<string | null>;
  postal_code_designated_public: Written<boolean, boolean | undefined>;
  phone: Written<string | null>;
  phone_designated_public: Written<boolean, boolean | undefined>;
  email: Written<string | null>;
  email_designated_public: Written<boolean, boolean | undefined>;
  website: Written<string | null>;
  website_designated_public: Written<boolean, boolean | undefined>;
  /**
   * `timestamptz(3)`, non-null **iff** `state = 'rejected'`
   * (`listing_revision_rejected_at_check`).
   *
   * **Insertable only as SQL `null`**, which is a restriction of *this unit*: issue #195
   * persists *pending* revisions, and a pending row must carry no rejection anchor. The
   * rejection path writes one, and widening this to accept an instant expression is the
   * tripwire that makes that unit say so deliberately.
   */
  rejected_at: WritableAsNullOnly<number | null>;
  /**
   * `base_listing_last_updated_at timestamptz(3) not null` — added by
   * `migrations/002-add-revision-base-version.ts` (issue #183) for `ADR-023` item 9.
   *
   * **`number`, not `number | null`**, because the column is `NOT NULL`: every revision
   * carries a captured base, and `ADR-023` item 12 refuses a missing one. The contrast
   * with its sibling `rejected_at` above is deliberate — *that* nullability is real
   * (present **iff** *rejected*), and copying it here would declare an absence the schema
   * does not permit.
   *
   * The carrier is **epoch milliseconds**, like every other governed instant on these two
   * tables, supplied by the offset-aware `pg` parser (issue #173) rather than by the
   * default `Date` conversion `ADR-022` forbids in the domain.
   *
   * **A `GovernedInstant` since issue #195** — epoch milliseconds out, a SQL expression in,
   * exactly like the listing's own instants, so the captured token and
   * `listing.last_updated_at` round-trip through the **same** conversion. That shared
   * expression is what makes `ADR-023` item 11's exact epoch-millisecond equality
   * structural rather than hoped for. It is **never** defaulted, refreshed or recomputed.
   *
   * **This is not a second source of schema truth.** The migration states the shape; this
   * states what the type system may assume about it, and a test asserts the two agree on
   * name, carrier and non-nullability against the live catalogue.
   */
  base_listing_last_updated_at: GovernedInstant;
}

/** The schema the first migration creates, and the only tables `C9` knows about. */
export interface ListingDatabase {
  listing: ListingTable;
  listing_revision: ListingRevisionTable;
}

/** A column this slice may write, but only ever as SQL `null`. */
type WritableAsNullOnly<Select> = ColumnType<Select, null, never>;

/**
 * One `listing` row as the configured connection delivers it.
 *
 * Exported because hydration takes one and its tests must construct one. It is the **only**
 * database-row type this slice exposes: the repository's own surface speaks in domain values
 * (issue #177 §5), so no caller outside `src/data/` ever handles a row.
 */
export type ListingRow = Selectable<ListingTable>;

/**
 * One `listing_revision` row as the configured connection delivers it.
 *
 * Exported for the same reason as `ListingRow`: revision hydration takes one and its tests must
 * construct one. The repository's own surface speaks in domain values, so no caller outside
 * `src/data/` ever handles a row — and in particular the row's `id` never leaves this directory.
 */
export type ListingRevisionRow = Selectable<ListingRevisionTable>;
