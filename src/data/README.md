# `data/` — the innermost layer

Holds **`C9`** (Listing Repository) — **the single data-access path**
(`ADR-002` `O-1`). It depends on nothing else in `src/`.

**`C9` is still unimplemented, and that is load-bearing.** The only code here is
**migration infrastructure** — `migrate.ts` and the empty `migrations/` folder
it reads (issue #157). It is **schema-neutral**: a mechanism with nothing to
migrate. **No `C9` repository, query, transaction or connection-pool code
exists.**

Seven states are kept apart below, because collapsing them is how a decision
turns into an implementation nobody authorized:

- **Discharged** — the governing question is answered by an `Accepted` ADR.
  It is the register's own term, and it is **not** a synonym for implemented.
- **Selected** — a named choice exists within a discharged decision.
- **Installed** — the package is present as a dependency.
- **Configured** — settings exist for it. **Nothing is configured for the
  application.** The migration entry point builds its own dialect at
  invocation and reads its target from the environment; no committed setting,
  credential or application pool configuration exists.
- **Provisioned** — an external resource exists. **Nothing is provisioned.**
- **Implemented** — code exists. **Only the migration mechanism exists; no
  `C9` persistence code does.**
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

**Outstanding when the policy was accepted, and since settled:** `DDM-2`'s
**identity generation locus** — **decided by `ADR-019`** (`Accepted`
2026-10-07, issue #159, on a Product Owner ruling): **the application
generates** listing and revision UUID v4 identifiers, and **PostgreSQL
declares no normal generation default** while still enforcing `uuid`,
primary-key uniqueness and not-null. It was a **prerequisite** for the first
schema migration, and it is now met.

**Still outstanding, and not settled by accepting the policy:** **CI migration
validation**; and **production execution**, deployment integration,
credentials and authority.

**The policy was selected by `ADR-018` and authorized nothing.** Migration
**infrastructure** was then separately authorized and built as its own unit
(**issue #157**), and the **first schema migration is still another, later
one**. What exists now, and what still does not:

- **Exists** — `migrate.ts`, the repository-owned programmatic entry point
  (core `Migrator` over `FileMigrationProvider`, `pg` through
  `PostgresDialect`); the `migrations/` folder it reads; the `migrate:latest`
  and `migrate:down` scripts in `package.json`; and tests that exercise the
  mechanism **without any database**.
- **Does not exist** — **any migration**, **any schema**, any table, column,
  constraint, index, type or default; any CI or production migration workflow;
  any provisioning; any persistence implementation.

**A mechanism is not a schema.** `migrations/` is deliberately empty, nothing
has ever been applied anywhere, and **`kysely-ctl` is neither selected nor
installed** — no dependency was added to build this.

**Execution is explicit local developer invocation only.** The entry point is
**not imported by the application**, and `ADR-018` prohibits implicit execution
during application startup, Next.js module loading, server initialization and
ordinary request handling. **CI migration validation and production execution,
deployment integration, credentials and authority remain outstanding** —
nothing here claims otherwise. Local invocation runs TypeScript directly under
Node's type stripping, so a run prints Node's experimental-feature and
module-type warnings; they are expected, and are not suppressed.

## The physical data-design items

`ADR-017` (`Accepted` 2026-09-17, issue #137) **discharged `DDM-2`, `DDM-6`,
`DDM-8` and `DDM-9`**, each with named outstanding items, and **authorized no
implementation**:

- **`DDM-2`** identity strategy — opaque random UUID v4. ~~*Outstanding:* the
  identity generation locus (application or database default).~~ **The
  generation locus is decided by `ADR-019`** (`Accepted` 2026-10-07, issue
  #159): **the application is the sole normal generator**, generating at an
  **orchestration boundary before the pure, id-first domain function is
  called** and **never** inside `listing-id.ts`; **PostgreSQL stores `uuid`
  and enforces primary-key uniqueness and not-null, with no normal generation
  default**; the **first migration must omit that default deliberately**; and
  **direct database writes and any governed import path must supply
  identifiers explicitly**. **Database-generated and hybrid generation are
  rejected.** *Still outstanding:* the **domain carrier type**, the **revision
  identity domain type**, and **public identity transport**. **No generator
  exists, and none is authorized here.**
- **`DDM-6`** physical separation of non-public attributes and per-contact
  public-display designations. *Outstanding:* the public projection form (a
  view or a single `C9` query module), replacement-value semantics, and
  restriction-only enforcement on the write paths.
- **`DDM-8`** revision storage and the representation of the effective public
  version. *Outstanding:* stale-edit detection and resolution policy (and any
  version token), the isolation level for revision transactions, and
  replacement-value semantics.
- **`DDM-9`** soft-delete versus hard-delete, publication state, and purge.

**Timestamp physical representation is decided** (`ADR-022`, `Accepted` 2026-10-09,
issue #169), filling the *"names, exact data types"* deferral `ADR-017` left and
`ADR-015`/`ADR-018` never picked up. Every governed instant is PostgreSQL
**`timestamptz(3)`** — an **absolute instant** at **millisecond** precision:
`submittedAt` and `lastUpdatedAt` **`not null`** on the listing, `rejectedAt`
**nullable** on the listing and on the revision under `PS-9`'s
presence-**iff**-*rejected* rule, which is unchanged. The **domain carrier remains an
epoch-millisecond safe integer**, and **this directory owns the conversion**: the `C9`
boundary converts both ways with an **exact epoch-millisecond round trip**, **`Date`
never crosses into the domain** (and stays confined here if a driver adapter uses it),
parsing **honours the explicit offset** and depends on **no** host timezone, DST rule,
locale or ambient clock, and invalid, out-of-range or non-millisecond-representable
values **fail explicitly** rather than being rounded or normalised. ~~**An explicit,
repository-owned and tested `pg` timestamp parser is required before persistence
implementation is complete — the default `Date` conversion must not be relied on — and
none exists here yet.**~~ **That parser now exists** — `timestamp-parser.ts` (issue #173):
a pure `parseTimestamptz` returning a **plain epoch-millisecond safe integer**, and
`createTimestamptzTypeOverrides` returning a `pg` registry that installs it for **OID
1184 only**. It **constructs no `Date`**, converting arithmetically instead; it **mutates
no process-global `pg` registry**, so a future pool must **opt in explicitly** by passing
the value as its `types` option; and **importing it does nothing** — no connection, no
credential, no registration.

**Two things it deliberately does not do.** It **rejects BC-era text and offsets carrying
seconds** — an intentional, disclosed narrowing of PostgreSQL's full textual range, ruled
on issue #173 and acceptable because all four governed data are **system-set operational
instants**. And it **refuses sub-millisecond precision rather than rounding it**, so a later
query selecting a bare `timestamptz` expression — which carries microseconds — must
**reduce the precision explicitly in SQL**, for example by casting to `timestamptz(3)`, so
that the reduction is visible in the statement rather than invisible in the adapter.

**PostgreSQL's own cast rounds, it does not truncate** (`.1235` becomes `.124`, and `.9999`
rolls to the next second), and the governed columns round on storage for the same reason.
**No rounding-versus-truncation policy is selected here** — none is governed — and the
parser makes **no claim that the cast rejects or truncates** excess precision; its strict
refusal applies only to raw values handed directly to it. The database clock remains out of
scope as an application time source (`ADR-019`, `ADR-022`): the **application supplies every
instant**.

**`DateStyle = ISO` on the connection remains a `C9` obligation**, recorded and not
discharged here: under `DateStyle = SQL` PostgreSQL emits a timezone abbreviation with no
numeric offset, which the parser refuses loudly. **No schema, migration, DDL, pool,
credential, provisioning or persistence exists or is authorized here.**

**`DDM-3` has left this list — it is decided.** The rest remain **open**, and none may be
resolved by code placed here:

- ~~**`DDM-3`** category representation~~ — **decided, and no longer open: `Accepted`
  `ADR-021`, 2026-10-09 (issue #167)** selects a **stable, repository-owned textual machine
  key** in a **mandatory, non-null PostgreSQL `text` column**, enforced by a **`CHECK`
  constraint** over the complete approved key set, authored as **raw DDL through Kysely's
  `sql` tag**. **No `varchar(n)`** — no length bound is governed. **No category table,
  foreign key, join table, PostgreSQL enum, reference-data rows or seed mechanism**: the
  approved values enter the database as the **constraint's own predicate**, not as data.
  **Labels, inclusion definitions, boundary notes and the approved alphabetical display
  order remain governed documentation and future repository configuration**, never database
  rows, and the **authoritative 16-key mapping lives in `ADR-021` alone**. **Deciding is not
  implementing:** **no category configuration module, no equality test, no schema, no
  migration, no reference data and no seed data exists or is authorized here**, and
  **`DI-9`/`VR-2`/`AV-7` remain unimplemented**. The detail below records the product model
  the decision rests on.
- *The product model `ADR-021` rests on, recorded when `DDM-3` was still open* — ~~`OQ-5`.~~ **The product model is decided**
  (`OQ-5`, Product Owner ruling 2026-10-07, issue #163): a listing carries **exactly
  one required** category from a **predefined, finite, platform-owned** vocabulary that
  is **flat**, curated by the Product Owner as **repository-owned configuration changed
  through deployment**, with **no free-text value, no “Other”, no proposal workflow and
  no administrator category-management screen**. ~~**`DDM-3` itself remains open and
  entirely physical:**~~ **`DDM-3` was then open and entirely physical, and every item in
  this list is now selected by `ADR-021` (see above):** text column versus reference table, foreign-key structure, stable
  category identifiers versus display labels, the configuration-file format, the
  seed-data and deployment-loading mechanism, database constraints, and the shape of the
  category migration — **none of them decided, and none inferable from `OQ-5` or from the
  approved vocabulary**. ~~It is now blocked by approval of the initial category
  vocabulary, whose values require a separate Product Owner approval.~~ **That blocker is
  discharged:** the initial vocabulary was **approved on 2026-10-08** (Product Owner
  ruling, issue #165) — **16 categories**, recorded with labels, definitions, boundary
  notes, tie-breaker rules and alphabetical display order in `docs/05` *The approved MVP
  category vocabulary*. The approved labels are **user-facing display text, not machine
  identifiers**. ~~**`DDM-3` is therefore undecided but no longer blocked, and is ready for
  its own separately governed physical-design decision**; the **first schema migration
  follows `DDM-3`**.~~ **`DDM-3` was then decided on that basis — `Accepted` `ADR-021`,
  2026-10-09 (issue #167), as recorded above** — so the first schema migration's category
  content is **determined**, and that migration remains a **separately authorized later
  unit**. **`DI-9` set-membership validation, the category configuration module and the
  mandatory configuration-versus-constraint equality test all remain separately
  authorized**, and **no category configuration, reference data or seed data exists or is
  authorized here.**
- **`DDM-4`** indexing and text-search strategy — `OQ-4`, `NOQ-4`.
- **`DDM-5`** normalization of location — ~~open; physical.~~ **Selected for the
  MVP by `ADR-020`** (`Accepted` 2026-10-07, issue #161): `locality`,
  `administrativeArea`,
  `country` and `postalCode` are **free text**, subject only to `OQ-6`'s existing
  presence requirements — locality and country **required**, administrative area and
  postal code **optional**, unchanged — and **reasonable governed length constraints**.
  **No country standard, reference table, curated list, validation library, new
  formatting expression or external location service** is selected. **No exact numeric
  length limit** is selected, because none is governed: `VR-S3` leaves every
  safety/length boundary to `DD-1`/`DD-2`, so the bound is an **obligation** and its
  value a **narrow later decision**. **Future normalisation remains separately governed,
  is not prohibited, and should arrive additively**; **no backfill is owed today because
  no schema and no rows exist**. **No implementation is authorized here.**
- **`DDM-7`** audit-entry storage — `OQ-14`, and meaningful only if `E5` is
  known to exist.

~~`OQ-5` and `OQ-4` **shape** this work rather than blocking a phase~~ — both were
classified as **shaping inputs**, and **`OQ-5` is now Decided** (2026-10-07, issue #163)
while **`OQ-4` remains Unresolved**. That classification is not softened or hardened
here, and **neither deciding `OQ-5`, nor approving the category vocabulary** (2026-10-08,
issue #165), **nor accepting `ADR-021`** (2026-10-09, issue #167) **authorizes anything in
this directory** — no configuration, no reference data, no seed data, no schema and no
migration. **`ADR-021` fixes what the first schema migration must declare; it creates
none of it.**

## What does not exist, and what is not authorized

~~**No schema, no migration**, no application connection or pool configuration, and
no repository or persistence implementation exists in this repository.~~

**The first schema migration now exists** —
`migrations/001-create-listing-and-revision-tables.ts` (issue #171), creating the
`listing` and `listing_revision` structures with their keys, constraints and the
`DI-11` partial unique index. **Nothing else here changed.** There is still **no
application connection or pool configuration, and no repository or persistence
implementation**, and the application remains **datastore-independent at
runtime**: a placeholder repository or a stub client would encode assumptions
about every outstanding item above, so issue #95 added none and this unit added
none either.

**Four things are worth keeping apart**, because each was authorized separately
and only the first two exist:

| | State |
|---|---|
| **Migration infrastructure** — the runner, provider and entry point | **Exists** (issue #157) |
| **An authored schema migration** — the DDL itself | **Exists** (issue #171) |
| **The `ADR-022` timestamp boundary** — `parseTimestamptz` and its `pg` type-override value | **Exists** (issue #173). It is a **mechanism, not a wiring**: no pool passes it, so a future `C9` connection must **opt in explicitly** |
| **Local/test execution** — the migration applied against a disposable server | **Exists, in tests only.** The attacking tests in `first-schema-migration.test.ts` start a real PostgreSQL server from the `embedded-postgres` development dependency, on an ephemeral port with a disposable data directory. That server is a **test-harness detail with no production-version authority** |
| **Production provisioning and execution** | **Does not exist.** Nothing is provisioned, **no PostgreSQL version is selected**, no credential exists, and no migration has run against any shared, hosted, staging or production database. CI runs the test suite; it does **not** execute migrations |

The migration entry point is the one exception, and it is a narrow one: it
obtains its target **explicitly** from `MIGRATION_DATABASE_URL` at invocation
time, has **no default**, stores **no credential**, and is **unreachable from
the application**. It is not application connection configuration, and running
it against a target nobody has provisioned simply fails.

**Neither an `Accepted` ADR nor an installed dependency is implementation
authority.** Each of the above was recorded precisely so that the work it
enables can be scoped, reviewed and authorized as its own unit — which is how
the first schema migration arrived: `ADR-017` through `ADR-022` decided its
content, and **issue #171 authorized the unit that wrote it** — and again for the
`ADR-022` timestamp parser, which **issue #173** authorized. **Persistence
code, any connection or pool configuration, the `ADR-021` category
configuration module and every later migration each still require a separately
authorized issue of their own.**

## The two standing obligations

Two obligations bind whatever eventually lands here:

- **All PostgreSQL access is server-side** (`O-1`). `C9` owns transactions, so
  a create, edit, or moderation action completes fully or has no effect
  (`NFR-DATA-03`).
- **Browser-direct datastore access is prohibited** (`O-2`). No client holds a
  datastore credential and no public route reaches the store
  (`NFR-SEC-08`; `docs/07` `R-10`).

**Still no `C9`, and still no schema.**
