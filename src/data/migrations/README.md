# `data/migrations/` — the migration folder

The repository-owned migration location that `../migrate.ts` hands to Kysely's
`FileMigrationProvider` (`ADR-018`, `Accepted` 2026-09-28, issue #155).

**This directory contains no migration, and that is the point.** Issue #157
delivered the mechanism only. **No schema exists**, no table, column,
constraint, index, type or default is defined anywhere in this repository, no
database is provisioned, and `C9` persistence is not implemented.

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

**The first schema migration is still blocked — and the gate has moved, not
cleared.** ~~`DDM-3`/`OQ-5` — category representation, cardinality and curation
— **remains unresolved**~~. **`OQ-5` is Decided** (Product Owner ruling
2026-10-07, issue #163): a listing carries **exactly one required** category from
a **predefined, finite, platform-owned, flat** vocabulary, curated by the Product
Owner as **repository-owned configuration changed through deployment**. That is a
**product** answer only. Two things must still happen before a migration here can
be written honestly, **in this order**: the **initial category values** require a
**separate Product Owner approval**, and **`DDM-3`** must then select the
**physical representation** — text column versus reference table, foreign-key
structure, stable identifiers versus display labels, constraints, and the
configuration/seed-data mechanism. **Do not pre-empt either:** declare no
category column, type, enumeration, reference table, foreign key, constraint or
seed data, and **do not infer a representation from the product ruling**.

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

**Still empty.**
