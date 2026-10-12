/**
 * `002` — the revision base-version column (issue #183).
 *
 * **This migration implements an already accepted decision and creates no new policy.**
 * It adds **exactly one column** to `listing_revision`: the listing version a pending
 * revision was prepared against.
 *
 * - **`ADR-023`** (`Accepted` 2026-10-12, issue #181) ruled the stale-edit detection and
 *   resolution policy. Four of its items reach storage:
 *   - item **9** — *"The base token is captured at revision creation and persisted with
 *     the revision."* This column is that persistence, and it did not exist before.
 *   - item **10** — the token is **`listing.lastUpdatedAt`**, so this column holds a copy
 *     of a `listing.last_updated_at` value and nothing else.
 *   - item **11** — comparison is by **exact epoch-millisecond equality**. The declared
 *     type is what makes that exactness real rather than hoped for.
 *   - item **12** — *"A missing or unequal token refuses the write."* `NOT NULL` makes a
 *     **missing** token unstorable; an **unequal** one is a write-path predicate, not a
 *     store constraint, and none is created here.
 * - **`ADR-022`** — every governed instant is **`timestamptz(3)`**: an absolute instant at
 *   millisecond precision, with an exact epoch-millisecond round trip at the `C9`
 *   boundary. This column is a governed instant and takes that type with its four
 *   siblings. **The `(3)` is not optional**: bare `timestamptz` would admit
 *   sub-millisecond detail the domain cannot represent, and the exact equality item 11
 *   requires would then be comparing values the domain never held.
 * - **`ADR-018`** — raw PostgreSQL DDL through Kysely's `sql` tag, the default authoring
 *   format. The schema builder is deliberately not used, for the reason `001` records:
 *   this statement states its own semantics, and two sources of schema truth are
 *   prohibited.
 *
 * **Why `NOT NULL` is honest here, and not merely optimistic.** Three facts, each
 * checkable rather than assumed:
 *
 * 1. **Every revision that will ever exist must carry it.** `ADR-023` item 9 is
 *    unconditional, and both persisted states need it — a *pending* revision for the
 *    `OP-10` comparison, and a *rejected* revision because its base is part of the
 *    historical record `OQ-13` retains. *Approved* never reaches storage (`ADR-017`
 *    `PS-4`/`PS-5`), so there is no state in which absence is correct.
 * 2. **No row exists to violate it.** `listing_revision` is written by nothing: every one
 *    of its columns is typed read-only in `listing-table.ts`, so an insert does not
 *    compile; `listing-repository.ts` exposes only a listing insert and a listing lookup;
 *    no database is provisioned and no migration has executed against any shared, hosted,
 *    staging or production database.
 * 3. **Nullable storage would buy nothing.** It would tolerate exactly the rows fact 1
 *    forbids, and such a row could **never be approved** — item 12 refuses a missing
 *    token — so it would be unusable by construction. It would also move presence
 *    enforcement onto cooperative callers, which is the ground `ADR-021` rejected
 *    unconstrained text on.
 *
 * Because no row exists, **no table rewrite and no backfill is performed or claimed**.
 * Adding a `NOT NULL` column without a default to an empty table is a catalogue change.
 *
 * **Deliberate omissions.** Each is an alternative a governed decision rejected, recorded
 * here for the reason `001` records its own: an author who adds one back silently adopts
 * the alternative that was refused.
 *
 * - **No default, of any kind.** The token is a value the **application captured when the
 *   administrator's work began** (`ADR-023` item 10). A default would fabricate a base
 *   version nobody observed, and a clock default would fabricate one that always equals
 *   *now* — silently defeating detection, because the comparison would pass for work
 *   prepared against anything. `ADR-022` additionally forbids consulting a clock during
 *   hydration. `001`'s *"declares no generated identity and no database clock default"*
 *   test already fails any `now()` or `current_timestamp` default on either table.
 * - **No `CHECK` constraint.** There is no closed value set to police, unlike `ADR-021`'s
 *   category keys. The two real rules are *must be present*, which is `NOT NULL`, and
 *   *must equal the listing's current value at apply time*, which is a **cross-row**
 *   condition a `CHECK` cannot express — a `CHECK` sees one row. Writing one would
 *   misrepresent a write-path predicate as a store guarantee.
 * - **No index.** This column is never a search key: the comparison is reached by the
 *   revision's primary key or by its `listing_id`, both already indexed by `001`. Indexing
 *   is **`DDM-4`**, which is unresolved with `OQ-4`, and `ADR-017` selected none — so an
 *   index here would be speculative performance, not integrity.
 * - **No trigger enforcing immutability.** The token records what the proposal was
 *   prepared against and must never be refreshed to the listing's current value, or every
 *   stale revision would silently become fresh. That immutability is a **write-path rule**
 *   (`C6`/`C9`), exactly as `ADR-017` `PS-9` places the rejection timestamps'
 *   immutability, and `001` creates no trigger for the same reason.
 * - **No column on `listing`.** `listing.last_updated_at` is already `timestamptz(3)
 *   not null` and already strictly forward-moving (`DI-6`, enforced in
 *   `advancedTimestamps`). It is the comparison's other side exactly as it stands, and it
 *   is **not touched**.
 * - **No `bigint`, no text, no `timestamp without time zone`, no `date`.** Each is
 *   rejected by `ADR-022` for this schema.
 * - **No counter and no fingerprint.** `ADR-023` item 14 rejects both for the MVP, and a
 *   counter beside `last_updated_at` would create the second concurrency authority that
 *   ruling specifically refused.
 * - **No `IF NOT EXISTS`.** The statement is unguarded on purpose. `IF NOT EXISTS` would
 *   let the migration pass silently against a database whose shape has drifted, and the
 *   `Migrator` already guarantees each migration runs once in order. No repository policy
 *   requires the guard.
 *
 * **What this migration does not do.** It adds storage and nothing else. No domain field,
 * no `ListingRevision` change, no mapper, no API field or transport, no comparison, no
 * administrator message, no `PS-11` behaviour, no isolation level, no retry policy, and no
 * revision or moderation persistence. Those are separately authorized later units.
 * **Merging a migration is not deploying it:** no database is provisioned, no PostgreSQL
 * version is selected, and no migration has been executed against any shared, hosted,
 * staging or production database.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // One column, one statement. `timestamptz(3)` and `not null` are both load-bearing and
  // both governed; the absence of a default is as deliberate as the type.
  await sql`
    alter table listing_revision
      add column base_listing_last_updated_at timestamptz(3) not null
  `.execute(db);
}

/**
 * Reversal — honest **now**, and the asymmetry is the point.
 *
 * **While no row has ever carried a value**, dropping this column destroys nothing: the
 * column is empty by construction, because `listing_revision` is written by nothing today
 * (see fact 2 above). That is what makes a `down` admissible at all under `ADR-018`, which
 * permits one **only** where reversal is *"genuinely safe, complete and honest"*.
 *
 * **Once captured tokens exist, this becomes destructive.** Each value records the listing
 * version a real proposal was prepared against — a fact that exists nowhere else and
 * cannot be recomputed from the surviving rows, because the listing has since moved on.
 * Running this `down` then would discard every revision's base and leave proposals that
 * can no longer be judged stale or fresh. **It would not be a rollback; it would be data
 * loss**, and nothing here should be read as implying the values could be restored.
 *
 * `ADR-018` therefore keeps **forward-only corrective migrations** the default recovery
 * path regardless of this function's existence, and dropping this column once revisions
 * exist would need its own authorization and an `ADR-010` safeguard and recovery
 * assessment — which this migration neither performs nor pre-authorizes.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table listing_revision
      drop column base_listing_last_updated_at
  `.execute(db);
}
