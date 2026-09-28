# `data/` — the innermost layer

Holds **`C9`** (Listing Repository) — **the single data-access path**
(`ADR-002` `O-1`). It depends on nothing else in `src/`.

**This directory is empty, and that is load-bearing.**

Seven states are kept apart below, because collapsing them is how a decision
turns into an implementation nobody authorized:

- **Discharged** — the governing question is answered by an `Accepted` ADR.
  It is the register's own term, and it is **not** a synonym for implemented.
- **Selected** — a named choice exists within a discharged decision.
- **Installed** — the package is present as a dependency.
- **Configured** — settings exist for it. **Nothing here is configured.**
- **Provisioned** — an external resource exists. **Nothing is provisioned.**
- **Implemented** — code exists. **No code exists here.**
- **Deferred / still open** — recorded as unanswered, by ruling or by an open
  question.

## What is decided, and what each decision did not do

`ADR-003` decided the engine — **PostgreSQL, under a managed operating
posture**. `ADR-013` (`Accepted` 2026-09-03, issue #103) **discharged
`DDM-1`**'s named managed service and vendor: **DigitalOcean Managed
PostgreSQL**. **Still outstanding, and not discharged by naming the
provider:** `ADR-010`'s provider-capability validation, to be re-verified
against current official documentation **before** provisioning, its
independent off-provider recoverable copy and its restore rehearsals — and
**no provisioning has occurred**: no account, no cluster, and no region, tier,
sizing or PostgreSQL version selected.

`ADR-014` (`Accepted` 2026-09-11, issue #117) selected **Kysely** as the `C9`
PostgreSQL data-access approach.

`ADR-016` (`Accepted` 2026-09-15, issue #125) selected **`pg` (node-postgres)
through Kysely core `PostgresDialect`** as the runtime PostgreSQL
driver/client and Kysely dialect. The driver/client and the dialect that
`ADR-014` and `ADR-015` left unselected are therefore **selected**, and
`ADR-016` governs their use.

**Both packages are now installed as runtime dependencies** — `kysely`
**0.29.6** and `pg` **8.23.0** (issue #129, PR #130). Installation was its own
authorized work unit, and it **added dependencies only**. It is not
configuration, not provisioning, and **not authority to write persistence
code**. **The application pool configuration and any external pooler remain
unselected.**

`ADR-015` (`Accepted` 2026-09-14, issue #121) **discharged `DDM-10`**, the
migration and schema-evolution tooling: **Kysely's built-in `Migrator`**.

`ADR-018` (`Accepted` 2026-09-28, issue #155; published as `Proposed`
2026-09-27, issue #153, PR #154) **settles the five policy items `ADR-015`
left outstanding**. The **selected policy**, which later migration work must
obey:

- **Contents.** The decision, the migration infrastructure and the first
  schema migration are **three separately authorized units, in that order**.
- **Authoring format.** A **governed hybrid** inside Kysely's `up`/`down`
  shape: **raw PostgreSQL DDL through the `sql` tag is the default**, and the
  schema builder is permitted **only** where it states the intended PostgreSQL
  operation more clearly without weakening or obscuring its semantics. The two
  forms must **not** become competing schema sources of truth, and ordinary
  application queries are **not** the default format.
- **Invocation.** A **repository-owned programmatic entry point** using core
  `Migrator` and `FileMigrationProvider`. **`kysely-ctl` is not selected and
  not installed**, and remains only a later, separately governed alternative.
- **Execution.** **Explicit local developer invocation** is the first
  authorized shape. **CI migration validation remains outstanding**, and
  **production execution, deployment integration, credentials and authority
  remain outstanding**. Migrations must **never** execute implicitly during
  **application startup**, **Next.js module loading**, **server
  initialization** or **ordinary request handling**, and the migration entry
  point must be separately invoked and **must not be imported by the
  application server**.
- **Rollback.** **Forward-only corrective migrations** are the default
  recovery path. A `down` migration may be written **only** where reversal is
  genuinely safe, complete and honest, and must never imply that lost or
  transformed data can be restored. **Destructive or irreversible migrations
  require separate explicit authorization and a documented safeguard and
  recovery assessment against existing `ADR-010` obligations** — that
  assessment *reads* `ADR-010`, and **no backup, disaster-recovery,
  independent-copy or restore-rehearsal policy is created, extended or
  reinterpreted**.

**Still outstanding, and not settled by accepting the policy:** `DDM-2`'s
**identity generation locus** (application or database default), which
**remains undecided** and is only a **prerequisite** for the first schema
migration; **CI migration validation**; and **production execution**,
deployment integration, credentials and authority.

**Policy is selected; implementation is absent.** **No migration exists**, and
**no migration infrastructure, migrations directory, migration file, runner,
script, Kysely or migration configuration, schema, CI workflow, production
workflow, provisioning or persistence implementation exists or is authorized
by that acceptance.** Migration infrastructure is a **separately authorized
future issue**, and the first schema migration is another, later one. This
file records the policy and the absence; it recommends nothing and decides
nothing.

## The physical data-design items

`ADR-017` (`Accepted` 2026-09-17, issue #137) **discharged `DDM-2`, `DDM-6`,
`DDM-8` and `DDM-9`**, each with named outstanding items, and **authorized no
implementation**:

- **`DDM-2`** identity strategy — opaque random UUID v4. *Outstanding:* the
  identity generation locus (application or database default).
- **`DDM-6`** physical separation of non-public attributes and per-contact
  public-display designations. *Outstanding:* the public projection form (a
  view or a single `C9` query module), replacement-value semantics, and
  restriction-only enforcement on the write paths.
- **`DDM-8`** revision storage and the representation of the effective public
  version. *Outstanding:* stale-edit detection and resolution policy (and any
  version token), the isolation level for revision transactions, and
  replacement-value semantics.
- **`DDM-9`** soft-delete versus hard-delete, publication state, and purge.

These remain **open**, and none may be resolved by code placed here:

- **`DDM-3`** category representation — `OQ-5`.
- **`DDM-4`** indexing and text-search strategy — `OQ-4`, `NOQ-4`.
- **`DDM-5`** normalization of location — open; physical.
- **`DDM-7`** audit-entry storage — `OQ-14`, and meaningful only if `E5` is
  known to exist.

`OQ-5` and `OQ-4` **shape** this work rather than blocking a phase; that is
their recorded classification, and it is not softened or hardened here.

## What does not exist, and what is not authorized

**No schema, migration, connection configuration, pool configuration,
repository or persistence implementation exists in this repository.** A
placeholder repository or a stub client would encode assumptions about every
outstanding item above — issue #95 therefore added none, and the application
remains **datastore-independent at runtime**.

**Neither an `Accepted` ADR nor an installed dependency is implementation
authority.** Each of the above was recorded precisely so that the work it
enables can be scoped, reviewed and authorized as its own unit. Persistence
code, a schema, a migration, or any connection or pool configuration requires
a **separately authorized future issue**.

## The two standing obligations

Two obligations bind whatever eventually lands here:

- **All PostgreSQL access is server-side** (`O-1`). `C9` owns transactions, so
  a create, edit, or moderation action completes fully or has no effect
  (`NFR-DATA-03`).
- **Browser-direct datastore access is prohibited** (`O-2`). No client holds a
  datastore credential and no public route reaches the store
  (`NFR-SEC-08`; `docs/07` `R-10`).

**Still empty.**
