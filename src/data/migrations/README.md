# `data/migrations/` — the migration folder

The repository-owned migration location that `../migrate.ts` hands to Kysely's
`FileMigrationProvider` (`ADR-018`, `Accepted` 2026-09-28, issue #155).

~~**This directory contains no migration, and that is the point.** Issue #157
delivered the mechanism only. **No schema exists**, no table, column,
constraint, index, type or default is defined anywhere in this repository, no
database is provisioned, and `C9` persistence is not implemented.~~

**It now contains the first schema migration** —
`001-create-listing-and-revision-tables.ts` (issue #171) — which creates the
`listing` and `listing_revision` structures, their primary keys, the
`listing_revision.listing_id` foreign key, eight `CHECK` constraints and the
partial unique index enforcing `DI-11`. **It implements already accepted
decisions and creates no new policy.**

**What still does not exist:** **no database is provisioned**, **no PostgreSQL
version is selected**, **no migration has been executed against any shared,
hosted, staging or production database**, and **`C9` persistence is not
implemented** — no repository and no query module. ~~and **no `pg` timestamp
parser** (`ADR-022` requires one, explicitly and tested, before persistence
implementation is complete)~~ — **the `ADR-022` timestamp parser now exists**
(`../timestamp-parser.ts`, issue #173), though **no pool passes it yet**, since
a future `C9` connection must opt in explicitly. **Merging the migration is not
deploying it.**

## Adding a migration is separate, later, authorized work

The **first schema migration requires its own issue and branch**. Its
prerequisite — **`DDM-2`'s identity-generation locus** — **is now decided**:
`ADR-019` (`Accepted` 2026-10-07, issue #159) selects **application-generated
identity**.

**What that obliges a migration placed here to do.** Declare the listing and
revision identity columns as `uuid`, **primary key**, **not null**, and
**with no generation default** — no `DEFAULT gen_random_uuid()`, no sequence,
no identity column, no trigger acting as a default. The omission is
**deliberate and governed**, and the migration should say so, because an
author who adds the default back silently adopts the alternative `ADR-019`
rejected. The **format** remains `ADR-017` `PS-1`: opaque random UUID v4.

**Location attributes are free text** (`ADR-020`, `Accepted` 2026-10-07,
issue #161). Declare `locality`, `administrativeArea`, `country` and
`postalCode` as free text, honouring `OQ-6`'s presence rules — locality and
country **not null**, administrative area and postal code nullable — with
**no reference table, no foreign key, no country-code constraint and no seed
data**. **Do not invent a `varchar(n)` length:** no exact numeric limit is
governed anywhere (`VR-S3` leaves every safety/length boundary to
`DD-1`/`DD-2`), and PostgreSQL `text` needs none — choosing a number here
would settle a decision nobody has made. A governed bound may be added later,
additively, once it is decided.

~~**The first schema migration is still blocked — and the gate has moved, not
cleared.**~~ **The category gate is now cleared.** ~~`DDM-3`/`OQ-5` — category
representation, cardinality and curation — **remains unresolved**~~. **`OQ-5` is
Decided** (Product Owner ruling 2026-10-07, issue #163): a listing carries **exactly
one required** category from a **predefined, finite, platform-owned, flat**
vocabulary, curated by the Product Owner as **repository-owned configuration changed
through deployment**. That was a **product** answer only. ~~Two things must still
happen before a migration here can be written honestly, in this order: the initial
category values require a separate Product Owner approval, and `DDM-3` must then
select the physical representation.~~ **Both are now done:** the **initial category
values were approved on 2026-10-08** (Product Owner ruling, issue #165) — **16
categories**, recorded in `docs/05` *The approved MVP category vocabulary* — and
**`DDM-3` selected the physical representation on 2026-10-09**: `ADR-021`,
`Accepted` (issue #167).

**What that obliges a migration placed here to do.** Declare the category as **one
mandatory, non-null `text` column** holding a **stable, repository-owned textual
machine key**, and restrict it with a **`CHECK` constraint over the complete approved
key set**, authored as **raw PostgreSQL DDL through Kysely's `sql` tag**. **Do not
store the display label** — the approved labels are **display text, not
identifiers**, and storing one would make a later rename a data rewrite. **Do not
invent a `varchar(n)`**, for the same reason as the location attributes: no numeric
limit is governed anywhere. **Declare no category table, foreign key, join table,
PostgreSQL enum, reference-data rows or seed data** — the approved values enter the
database as the **constraint's own predicate**, not as rows — and **declare no
display order**, which stays in documentation and future configuration. **The
authoritative 16-key mapping is in `ADR-021` alone; take the keys from there and
invent none.** The omission of a reference table and of seed data is **deliberate and
governed**, and the migration should say so, for the same reason `ADR-019`'s missing
UUID default must be stated: an author who adds either back silently adopts an
alternative `ADR-021` rejected.

**Timestamps are `timestamptz(3)`** (`ADR-022`, `Accepted` 2026-10-09, issue #169).
Declare every governed instant as **`timestamptz(3)`** — **millisecond
precision, absolute instant**. On the listing structure that is
**`submittedAt`** and **`lastUpdatedAt`**, both **`not null`**, and
**`rejectedAt`**, **nullable**; on the revision structure it is the revision's
own **`rejectedAt`**, **nullable**. The **presence-if-and-only-if-*rejected***
rule for both rejection timestamps is `ADR-017` `PS-9`'s and is **unchanged**.
**Declare no other timestamp**: the revision structure carries **no**
`submittedAt` and **no** `lastUpdatedAt` (`revision.ts` declares none), purge
eligibility is **derived** (`PS-10`), unpublishing and republishing move no
timestamp, and no audit timestamp exists because `E5` is still `OQ-14`.

**Do not omit the `(3)`, and do not omit `NOT NULL`.** Bare `timestamptz`
would let the store hold sub-millisecond detail the domain cannot represent,
breaking the exact epoch-millisecond round trip `ADR-022` requires; and the
type implies nothing about nullability, so a required datum needs its
`not null` stated. **Do not use `timestamp without time zone`, `date`,
`bigint` or text** — each is rejected by `ADR-022`, and the first of them
would make a later correction reinterpret every stored row rather than change
a type.

**Narrowing the constraint is not an ordinary forward step.** Removing a key that
listings still reference requires an **explicit reassignment/backfill decision
first** — a constraint cannot validate while forbidden values remain, and that
failure is the signal to seek the decision, never to widen the predicate back.
**Rollback stays honest** (`ADR-018`): widening is cleanly reversible only while no
row uses the new key.

## The rules a file placed here must follow

- **Filename: `NNN-kebab-case-summary.ts`** — a zero-padded three-digit
  ordinal, then a short description. The `Migrator` orders migrations by
  ascending name and enforces that order against already-applied migrations, so
  the ordinal is the ordering, and an applied name must never be renamed.
- **Shape:** export `up`, and export `down` **only** where reversal is
  genuinely safe, complete and honest. Forward-only corrective migrations are
  the default recovery path, and a `down` must never imply that lost or
  transformed data can be restored.
- **Authoring format:** **raw PostgreSQL DDL through Kysely's `sql` tag is the
  default.** The schema builder is permitted **only** where it states the
  intended PostgreSQL operation more clearly without weakening or obscuring its
  semantics. The two forms must never become competing schema sources of truth,
  and ordinary application queries are not the default format.
- **Destructive or irreversible work** requires **separate explicit
  authorization** and a documented safeguard and recovery assessment against
  the existing `ADR-010` obligations. That assessment reads `ADR-010`; it
  creates, extends and reinterprets nothing in it.
- **Only migrations belong here.** `FileMigrationProvider` treats every `.ts`,
  `.js`, `.mjs`, `.cjs`, `.mts` and `.cts` file in this directory as a
  migration, so tests, helpers and shared code live beside `../migrate.ts`
  instead. This README is ignored, because `.md` is not a migration extension.

~~**Still empty.**~~ **One migration: `001-create-listing-and-revision-tables.ts`.**

Its attacking tests live beside `../migrate.ts`, in
`../first-schema-migration.test.ts`, for the reason stated just above — a test
placed in this directory would be collected as a migration. They run
**unconditionally** against a real PostgreSQL server started from the
`embedded-postgres` development dependency authorized on issue #171, on an
ephemeral port with a disposable data directory. That server is a **test-harness
detail with no production-version authority**.
