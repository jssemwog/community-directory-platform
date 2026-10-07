# `data/migrations/` — the migration folder

The repository-owned migration location that `../migrate.ts` hands to Kysely's
`FileMigrationProvider` (`ADR-018`, `Accepted` 2026-09-28, issue #155).

**This directory contains no migration, and that is the point.** Issue #157
delivered the mechanism only. **No schema exists**, no table, column,
constraint, index, type or default is defined anywhere in this repository, no
database is provisioned, and `C9` persistence is not implemented.

## Adding a migration is separate, later, authorized work

The **first schema migration requires its own issue and branch**, and it may
not be written until **`DDM-2`'s identity-generation locus** — application
generated identity versus a database default — **is decided**. It remains
undecided; a `DEFAULT gen_random_uuid()` in DDL would settle it silently.

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
