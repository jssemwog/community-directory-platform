/**
 * `001` — the first schema migration (issue #171).
 *
 * **This migration implements already accepted decisions and creates no new policy.**
 * Every table, column, type, constraint and omission below traces to a decision in
 * force; nothing is chosen here that was not chosen there.
 *
 * - **`ADR-017` `PS-1`** — opaque random UUID v4 for listing *and* revision identity.
 * - **`ADR-019`** — identity is **application-generated**; PostgreSQL stores `uuid`,
 *   enforces primary-key uniqueness and not-null, and **declares no generation default**.
 *   The omission below is **deliberate**: see *Deliberate omissions*.
 * - **`ADR-017` `PS-2`** — non-public attributes on the same row; a **mandatory**
 *   designation datum beside each of exactly four conditionally-public values, defaulting
 *   to *not public*; revision rows carry designations too.
 * - **`ADR-017` `PS-3`–`PS-6`** — effective content on the listing row; separate revision
 *   rows carrying a **complete** proposed content set with designations; only *pending*
 *   and *rejected* revision states persist.
 * - **`ADR-017` `PS-7`** — listing status as a mandatory text datum under a store check
 *   over the three `FR-AUD-01` values.
 * - **`ADR-017` `PS-8`** — publication state as a nullable text datum over two named
 *   values, present **if and only if** *approved*; unpublish reason present **if and only
 *   if** *unpublished*.
 * - **`ADR-017` `PS-9`** — a rejection timestamp on **each** structure, present **if and
 *   only if** *rejected*. Its **immutability** is a write-path rule (`C6`/`C9`), **not** a
 *   store trigger, and none is created here.
 * - **`ADR-017` `PS-10`** — no deletion path for approved listings; rejected rows removed
 *   explicitly, one per transaction. Hence **`ON DELETE NO ACTION`** below.
 * - **`ADR-017` `PS-11`** / **`DI-11`** — conditional uniqueness over *pending* revision
 *   rows only, which `ADR-017` calls *"an integrity constraint, **not** a performance
 *   index"*.
 * - **`ADR-020`** — the four location attributes as free text; **no `varchar(n)`**,
 *   because no length bound is governed (`VR-S3` leaves every one to `DD-1`/`DD-2`).
 * - **`ADR-021`** — category as one mandatory, non-null `text` column holding a **stable
 *   machine key**, enforced by a `CHECK` over the complete approved key set. **No category
 *   table, foreign key, enum, reference rows or seed data.** The 16 keys are
 *   authoritative in `ADR-021`; this constraint is the second governed copy that ADR
 *   accepted, and a later unit owns the equality test between them.
 * - **`ADR-022`** — every governed instant as **`timestamptz(3)`**: an absolute instant at
 *   millisecond precision. `submitted_at`/`last_updated_at` **not null**; both
 *   `rejected_at` nullable.
 * - **`ADR-018`** — raw PostgreSQL DDL through Kysely's `sql` tag, which is the default
 *   authoring format. The schema builder is deliberately not used: these statements state
 *   their own semantics, and two sources of schema truth are prohibited.
 *
 * **Null rejection comes from `NOT NULL`, never from a `CHECK` alone.** Under SQL's
 * three-valued logic a `CHECK` whose predicate evaluates to `UNKNOWN` is **satisfied**, so
 * `category IN (…)` would *pass* a null. Both declarations are therefore present on every
 * required column, and the applicability checks below use `IS DISTINCT FROM` wherever a
 * nullable column is compared, so that no predicate can evaluate to `UNKNOWN` and let a
 * forbidden combination through.
 *
 * **`timestamptz(3)` rounds; it does not reject.** A value arriving with greater
 * fractional precision is rounded to milliseconds and accepted, with no error
 * (`ADR-022`). Strict rejection of sub-millisecond input is an **adapter/input-boundary**
 * obligation, not this column's, and **no `CHECK` or trigger is created for it**.
 *
 * **Deliberate omissions — each stated so that a later author does not reinstate one by
 * accident:**
 *
 * - **No UUID generation default** — no `DEFAULT gen_random_uuid()`, no sequence, no
 *   identity column, no trigger acting as a default. Adding one silently adopts the
 *   alternative `ADR-019` rejected.
 * - **No database clock default** — no `now()`, no `CURRENT_TIMESTAMP`. The application
 *   supplies every instant (`ADR-022`; `instant.ts`: *"Time is supplied, never read"*).
 * - **No category reference table and no seed data** — the approved values enter as the
 *   constraint's own predicate, not as rows (`ADR-021`).
 * - **No search or performance index** — `DDM-4` is unresolved with `OQ-4`/`NOQ-4`, and
 *   `ADR-017` selected none. The single index below is integrity, not performance.
 * - **No audit or history structure** — `E5`'s existence is `OQ-14`, unresolved (`DDM-7`).
 * - **No projection view** — `ADR-017` deferred whether the public projection is a view or
 *   a `C9` query module.
 * - **No `submitted_at` or `last_updated_at` on the revision structure** — `revision.ts`
 *   declares neither, and its rejection anchor is *"separate from any last-updated
 *   notion"*.
 * - **No stale-edit version token** — still product policy not yet ruled.
 * - **No length or format constraint** — `VR-S3`'s bounds belong to `DD-1`/`DD-2`;
 *   application and domain validation remain separately required.
 * - **No trigger, type, extension, role or grant.** The DDL uses only long-standing core
 *   PostgreSQL features and **requires no extension**, so it depends on **no** particular
 *   server version — none is selected (`ADR-013`).
 *
 * **`down` is honest only while the schema is empty.** See the note on it below.
 */
import { sql, type Kysely } from "kysely";

/**
 * The approved category machine keys (`ADR-021`, `Accepted` 2026-10-09, issue #167).
 *
 * `ADR-021` holds the authoritative key-to-label mapping; this list is the **constraint's
 * predicate**, which is the second repository-owned copy that decision accepted. The
 * **labels are deliberately absent** — they are display text, not identity, and are never
 * stored.
 */
const APPROVED_CATEGORY_KEYS = [
  "arts-culture-entertainment",
  "automotive-transport",
  "beauty-personal-care",
  "community-nonprofit",
  "education-childcare",
  "financial-insurance-services",
  "fitness-recreation",
  "food-drink",
  "health-medical",
  "home-trade-services",
  "industrial-wholesale",
  "pets-animal-services",
  "professional-services",
  "retail-shopping",
  "technology-digital-services",
  "travel-accommodation",
] as const;

/** The three `FR-AUD-01` listing statuses, and the only ones (`ADR-017` `PS-7`). */
const LISTING_STATUS_VALUES = ["pending", "approved", "rejected"] as const;

/** The two publication values (`ADR-017` `PS-8`; `publication.ts`). */
const PUBLICATION_STATE_VALUES = ["publicly_available", "unpublished"] as const;

/**
 * The only revision states that persist (`ADR-017` `PS-5`).
 *
 * The domain's `RevisionState` also admits *approved*, but an approved proposal's row is
 * **physically removed in the applying transaction** (`PS-4`), so *approved* never reaches
 * storage and must not be admitted here.
 */
const PERSISTED_REVISION_STATES = ["pending", "rejected"] as const;

/** A `CHECK`-ready SQL list of single-quoted literals. */
const literalList = (values: readonly string[]) =>
  sql.join(values.map((value) => sql.lit(value)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table listing (
      id uuid not null,
      status text not null,
      name text not null,
      category text not null,
      description text not null,
      locality text not null,
      country text not null,
      administrative_area text,
      postal_code text,
      postal_code_designated_public boolean not null default false,
      phone text,
      phone_designated_public boolean not null default false,
      email text,
      email_designated_public boolean not null default false,
      website text,
      website_designated_public boolean not null default false,
      publication_state text,
      unpublish_reason text,
      submitted_at timestamptz(3) not null,
      last_updated_at timestamptz(3) not null,
      rejected_at timestamptz(3),

      constraint listing_pkey primary key (id),

      constraint listing_status_check
        check (status in (${literalList(LISTING_STATUS_VALUES)})),

      constraint listing_category_check
        check (category in (${literalList(APPROVED_CATEGORY_KEYS)})),

      -- The explicit \`is not null\` is load-bearing, not redundant: without it, an
      -- approved row with a null publication state would make \`publication_state in
      -- (...)\` evaluate to UNKNOWN, and a CHECK that evaluates to UNKNOWN is
      -- **satisfied** — so the forbidden combination would be accepted. Every branch
      -- below is kept determinate for that reason.
      constraint listing_publication_state_check
        check (
          case
            when status = 'approved'
              then publication_state is not null
                and publication_state in (${literalList(PUBLICATION_STATE_VALUES)})
            else publication_state is null
          end
        ),

      constraint listing_unpublish_reason_check
        check (
          case
            when publication_state is not distinct from 'unpublished'
              then unpublish_reason is not null
            else unpublish_reason is null
          end
        ),

      constraint listing_rejected_at_check
        check (
          case
            when status = 'rejected' then rejected_at is not null
            else rejected_at is null
          end
        )
    )
  `.execute(db);

  await sql`
    create table listing_revision (
      id uuid not null,
      listing_id uuid not null,
      state text not null,
      name text not null,
      category text not null,
      description text not null,
      locality text not null,
      country text not null,
      administrative_area text,
      postal_code text,
      postal_code_designated_public boolean not null default false,
      phone text,
      phone_designated_public boolean not null default false,
      email text,
      email_designated_public boolean not null default false,
      website text,
      website_designated_public boolean not null default false,
      rejected_at timestamptz(3),

      constraint listing_revision_pkey primary key (id),

      constraint listing_revision_listing_id_fkey
        foreign key (listing_id) references listing (id)
        on delete no action on update no action,

      constraint listing_revision_state_check
        check (state in (${literalList(PERSISTED_REVISION_STATES)})),

      constraint listing_revision_category_check
        check (category in (${literalList(APPROVED_CATEGORY_KEYS)})),

      constraint listing_revision_rejected_at_check
        check (
          case
            when state = 'rejected' then rejected_at is not null
            else rejected_at is null
          end
        )
    )
  `.execute(db);

  // `DI-11` — at most one *pending* revision per listing. A conditional uniqueness
  // constraint over pending rows only, which `ADR-017` records as an integrity
  // constraint and **not** a performance index. PostgreSQL expresses a conditional
  // uniqueness constraint as a partial unique index; there is no `CONSTRAINT` form of it.
  await sql`
    create unique index listing_revision_one_pending_per_listing
      on listing_revision (listing_id)
      where state = 'pending'
  `.execute(db);
}

/**
 * Reverse the creation, dropping the child structure first.
 *
 * **This `down` is complete and honest only while the schema is empty** — which is true
 * exactly once, now, because `up` adds only structure and no row has ever existed. On that
 * state it returns the database precisely to where it started, losing nothing, which is
 * the bar `ADR-018` sets for providing a `down` at all.
 *
 * **Once any listing or revision row exists, running this is destructive**: it discards
 * every one of them irrecoverably, and a passing `down` test must not be read as a
 * rollback guarantee. `ADR-018` makes **forward-only corrective migrations** the default
 * recovery path, **production `down` execution is not generally authorized**, and a
 * destructive step requires **separate explicit authorization and an `ADR-010`-based
 * safeguard and recovery assessment**.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  // The partial unique index belongs to `listing_revision` and is dropped with it.
  await sql`drop table listing_revision`.execute(db);
  await sql`drop table listing`.execute(db);
}
