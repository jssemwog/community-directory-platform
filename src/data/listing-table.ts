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
 * - **Every update type is `never`.** This slice authorizes exactly one insert and one read
 *   (issue #177 §5/§6); no update or delete path exists, and the type system is where that is
 *   cheapest to enforce.
 * - The `*_designated_public` flags carry a database `DEFAULT false`, so their insert type admits
 *   `undefined`. Serialization still supplies every one of them explicitly — the default is the
 *   store's fail-closed backstop (`ADR-017` `PS-2`), not this layer's way of omitting a value.
 *
 * ## Why `listing_revision` is typed but never touched
 *
 * Kysely's database interface is the map of the schema, and a map missing a real table invites a
 * later unit to add it twice. It is typed here for that reason **only**. **No revision operation
 * is authorized** (issue #177 §6), and none exists: the table cannot be honestly hydrated today,
 * because it stores `id uuid not null` while the domain's `ListingRevision` carries **no
 * identifier field**, and `ADR-022` records `DDM-2`'s *"revision identity domain type"* as still
 * open. Its update type is `never` for the same reason as the listing's, and its insert type is
 * `never` as well — nothing in this slice may write it.
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
 * The `listing_revision` table — **typed only**, written and read by nothing in this slice.
 *
 * Every column is read-only to the type system, so an attempt to insert or update one does not
 * compile. See the module header for why hydrating a revision is not yet honest.
 */
export interface ListingRevisionTable {
  id: ReadOnlyColumn<string>;
  listing_id: ReadOnlyColumn<string>;
  /** `CHECK`ed against `pending` and `rejected` only: an approved proposal's row is removed in
   * the same atomic unit that applies it (`ADR-017` Q-3), so `approved` never persists. */
  state: ReadOnlyColumn<string>;
  name: ReadOnlyColumn<string>;
  category: ReadOnlyColumn<string>;
  description: ReadOnlyColumn<string>;
  locality: ReadOnlyColumn<string>;
  country: ReadOnlyColumn<string>;
  administrative_area: ReadOnlyColumn<string | null>;
  postal_code: ReadOnlyColumn<string | null>;
  postal_code_designated_public: ReadOnlyColumn<boolean>;
  phone: ReadOnlyColumn<string | null>;
  phone_designated_public: ReadOnlyColumn<boolean>;
  email: ReadOnlyColumn<string | null>;
  email_designated_public: ReadOnlyColumn<boolean>;
  website: ReadOnlyColumn<string | null>;
  website_designated_public: ReadOnlyColumn<boolean>;
  rejected_at: ReadOnlyColumn<number | null>;
}

/** The schema the first migration creates, and the only tables `C9` knows about. */
export interface ListingDatabase {
  listing: ListingTable;
  listing_revision: ListingRevisionTable;
}

/**
 * One `listing` row as the configured connection delivers it.
 *
 * Exported because hydration takes one and its tests must construct one. It is the **only**
 * database-row type this slice exposes: the repository's own surface speaks in domain values
 * (issue #177 §5), so no caller outside `src/data/` ever handles a row.
 */
export type ListingRow = Selectable<ListingTable>;
