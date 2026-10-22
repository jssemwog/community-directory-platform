# `data/` — the innermost layer

Holds **`C9`** (Listing Repository) — **the single data-access path**
(`ADR-002` `O-1`). It depends on nothing else in `src/`.

~~**`C9` is still unimplemented, and that is load-bearing.**~~ **The first `C9`
persistence slice exists** (issue #177, 2026-10-10): a connection boundary
(`connection.ts`), the Kysely schema typing (`listing-table.ts`), the listing
mapping in both directions (`listing-mapping.ts`), and **exactly two
operations** — persist one submitted listing (`OP-3`) and retrieve one listing
by identifier (`listing-repository.ts`). Alongside it sits the **migration
infrastructure** (`migrate.ts`, issue #157), the **authored migration**
(issue #171) and the **`timestamptz` boundary parser** (issue #173).

**What `C9` still does not have.** No revision read or write; no moderation
operation; no listing update or delete; no enumeration, filtering, search,
public query or projection transport; no retention or purge; and **no
application composition** — nothing outside the tests constructs the boundary,
so the product does not yet persist anything end to end. **No credential,
environment variable, provisioning or production execution** belongs to it.

Seven states are kept apart below, because collapsing them is how a decision
turns into an implementation nobody authorized:

- **Discharged** — the governing question is answered by an `Accepted` ADR.
  It is the register's own term, and it is **not** a synonym for implemented.
- **Selected** — a named choice exists within a discharged decision.
- **Installed** — the package is present as a dependency.
- **Configured** — settings exist for it. ~~**Nothing is configured for the
  application.**~~ **Two settings are now fixed for the application, and only
  two** (issue #177): the governed `timestamptz` type overrides and
  `DateStyle = ISO`, both applied per pool by `connection.ts`. Everything else
  — connection string, credentials, pool size, timeouts, retry, TLS — is
  **supplied by the caller** and chosen by nobody here, so `ADR-016`'s
  deferrals stand. The migration entry point still builds its own dialect at
  invocation and reads its target from the environment; **no committed
  setting, credential or connection string exists** anywhere in the
  repository.
- **Provisioned** — an external resource exists. **Nothing is provisioned.**
- **Implemented** — code exists. ~~Only the migration mechanism exists; no
  `C9` persistence code does.~~ **The migration mechanism, the authored
  migration, the timestamp parser, the category configuration and the first
  persistence slice exist** (issues #157, #171, #173, #175, #177).
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
  public-display designations. ~~*Outstanding:* the public projection form (a
  view or a single `C9` query module), replacement-value semantics, and
  restriction-only enforcement on the write paths.~~ **Replacement-value
  semantics and restriction-only enforcement are decided** (`ADR-025`,
  `Accepted` 2026-10-17, issue #203): a value is a **replacement** only when it
  differs from the stored value by **exact** comparison — **no normalization is
  governed or authorized** — every actual replacement **defaults to private** and
  never inherits a public designation, an **unchanged** value may be
  **restricted** but **never widened**, and a widening attempt is **refused
  explicitly before any mutation**. ~~**Deciding it implements nothing:** no domain
  comparison, no result code and no enforcement exists, and **`OP-6` does not
  enforce it** — see *What does not exist* below.~~ **The pure-domain rule now
  exists** (issue #205): `src/domain/listing/designation.ts` compares two
  complete content sets exactly, classifies each governed field as unchanged,
  removed, added or replaced, and refuses any private→public widening as
  `DESIGNATION_WIDENING_REFUSED`, accumulated per field and kept distinct from
  `ValidationViolation`. ~~**No production write path calls it**: `OP-6` still does
  **not** enforce `ADR-025`~~ — **`OP-6` now enforces it** (issue #207):
  `createPendingRevision` reads the **complete** listing row under the existing
  `PS-11` lock, hydrates it with the governed mapper, and invokes
  `enforceDesignationPolicy` **once** against that **authoritative post-lock
  stored content** and the caller's **original** proposed content, **after** the
  lifecycle, `DI-11` and stale-token decisions and **before the insert**. A
  prohibited widening is refused as `DESIGNATION_POLICY_REFUSED`, carrying every
  offending field in the rule's deterministic order; an unreadable stored listing
  is its own `STORED_LISTING_UNREADABLE` outcome. **Nothing is normalized and
  nothing is silently privatized**, and **`OP-10` does not revalidate the policy**
  — that remains separately sequenced work. ~~`FR-ADM-04` and `FR-ADM-10b` remain
  **unimplemented** *as persistence paths*, so privacy enforcement is live on `OP-6`
  **only**~~ **both persistence paths now exist and enforce the policy —
  `FR-ADM-04` with issue #217 (PR #218) and `FR-ADM-10b` with issue #219
  (PR #220)** — `FR-ADM-04`'s **pure-domain** edit enforces the same policy since issue
  #215, ~~but no stored write reaches it~~ **and its stored write reaches it since
  issue #217**, so enforcement is now live on `OP-6` **and** `FR-ADM-04`.
  ~~`FR-ADM-10b` remains **unimplemented**.~~ **`FR-ADM-10b` landed with issue
  #219** and enforces the same policy once, against the authoritative post-lock
  stored content, before its transient revision insert — so privacy enforcement
  is now live on `OP-6`, `FR-ADM-04` **and** `FR-ADM-10b`.
  *Outstanding:* the public projection form (a view or a single `C9` query
  module).
- **`DDM-8`** revision storage and the representation of the effective public
  version. ~~*Outstanding:* the isolation level for revision transactions, and
  replacement-value semantics.~~ **Both are now decided** — the isolation level
  by `ADR-024` (`Accepted` 2026-10-14, issue #189) and **replacement-value
  semantics by `ADR-025`** (`Accepted` 2026-10-17, issue #203). **Neither
  decision implements anything** on this item. **Stale-edit detection and resolution policy —
  and its supporting token — are decided** (`ADR-023`, `Accepted` 2026-10-12,
  issue #181): see *Stale-edit detection is decided* below. **That policy is
  not a `DDM` item and carries no `DDM` number** — it is an `ADR-017`
  implementation-time deferral, noted here only because it governs the write
  paths this item's revision storage serves.
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

~~**`DateStyle = ISO` on the connection remains a `C9` obligation**, recorded and not
discharged here~~ — **that obligation is discharged** (issue #177): `connection.ts` sends
`-c datestyle=ISO` in the **startup packet** of every pooled connection, so the setting is in
force **before the first statement** rather than after a query that could itself be misread.
The reason it mattered is unchanged: under `DateStyle = SQL` PostgreSQL emits a timezone
abbreviation with no numeric offset, which the parser refuses loudly. **`pg-pool`'s `connect`
event was rejected as the mechanism** — it is emitted synchronously and the client is handed
to the acquirer without the handler being awaited, which was measured, so it is a race and not
a guarantee. **No credential, provisioning or production execution exists or is authorized
here.**

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
  rows, and the **authoritative 16-key mapping lives in `ADR-021` alone**. ~~**Deciding is not
  implementing:** no category configuration module, no equality test, no schema, no
  migration, no reference data and no seed data exists or is authorized here, and
  `DI-9`/`VR-2`/`AV-7` remain unimplemented.~~ **The configuration module, the equality test
  and the migration now exist** (issues #171 and #175). The **configuration**
  (`src/domain/listing/category.ts`) is the single application-owned executable vocabulary;
  the **immutable migration** keeps its own independent historical `CHECK` predicates; and
  `category-constraint-equality.test.ts` proves the two enforce **exactly** the same key set,
  **in both directions**, by reading `pg_get_constraintdef()` from a real server — a missing
  **or extra** key fails. The migration's own key constant stays **unexported**: it was not
  widened to make a test convenient (`ADR-018`). **Still absent:** reference data, seed data,
  row mapping, repositories, provisioning, credentials and production execution. The detail
  below records the product model the decision rests on.
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
  no rows exist** — the two schema migrations exist (issues #171 and #183), but
  `listing_revision` is written by nothing and holds no rows. **No implementation is authorized here.**
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

**Stale-edit detection is decided** (`ADR-023`, `Accepted` 2026-10-12, issue #181),
filling the deferral `ADR-017` recorded as *"product policy not yet ruled"* together
with *"any supporting version token"*. **Stale changes must be detected**; a stale
write is **rejected** — never automatically refreshed, merged or overwritten — with
**nothing saved or partially applied** and the **listing and pending revision left
unchanged**; **no role may override**, because **staleness is a concurrency-safety
rule, not an ordinary validation rule or a discretionary moderation outcome**. A
revision **is stale at `OP-10` whenever the listing's current version differs from its
captured base**, so the **base token is captured at revision creation and persisted
with the revision**. The **MVP token is `listing.lastUpdatedAt`**, captured when work
begins, its **exact epoch-millisecond value preserved**, compared by **exact
equality**, with a **missing or unequal token refusing the write**, **never exposed
publicly**, and **no dedicated counter or fingerprint** for the MVP.

**This directory is where three of those obligations land**, and none of them is
implemented. **`PS-11`'s lock is not enough on its own** — `ADR-017` says so, and
`ADR-023` carries it forward: **locking or transaction serialization alone does not
satisfy stale-input detection**, because content read into an editing screen before the
transaction begins is outside the lock. **The exact-equality comparison is sound here
only because of two rules already in force:** `ADR-022`'s **exact epoch-millisecond
round trip**, which this directory owns, and **`DI-6`'s strictly-later requirement**,
which guarantees that two accepted versions of one listing can never share a
`lastUpdatedAt`. **`lastUpdatedAt` is therefore load-bearing for concurrency while
`DI-6` is in force**, and **relaxing `DI-6` requires a separately governed
reassessment**. A **same-millisecond `DI-6` failure remains a distinct
timestamp-advancement failure** and must **not** be reported as stale input.

~~**Accepting `ADR-023` authorizes nothing here.** The **physical column name and its
nullability**, the **migration shape**, the **legacy/backfill posture**, the
**`ListingRevision` field representation**, the **API transport mechanics**, the
**`PS-11` isolation level**, the **retry policy**, the **transaction implementation**,
and **revision and moderation persistence** are all **separately reviewed downstream
steps**. **No token column, comparison logic, migration or revision write path exists
in this directory**, and `listing_revision` carries **no base-version column** today.~~

**The storage now exists, and only the storage** (issue #183). The **physical column
name, its nullability and the migration shape** were the three questions `ADR-023`
delegated, and `migrations/002-add-revision-base-version.ts` settles them:
**`listing_revision.base_listing_last_updated_at timestamptz(3) not null`**, with
**no default, no `CHECK`, no index and no trigger**. `NOT NULL` is honest because
**no revision row exists** — `listing_revision` is written by nothing here — so **no
backfill was owed**; and because every revision that will ever exist must carry the
token (`ADR-023` item 9), while a row missing it could never be approved (item 12).
`listing.last_updated_at` is **unchanged**: already `timestamptz(3) not null` and
already strictly forward-moving, it is the comparison's other side as it stands.

~~**Nothing reads or writes that column.** There is **no domain field** on
`ListingRevision`, **no mapper**, **no API transport**, **no staleness comparison**
and **no administrator message**; the **`PS-11` isolation level and retry policy
remain undecided**; and **no revision or moderation persistence exists** — no
revision read, no revision write, no moderation operation. The **token's
immutability** is a write-path rule (`ADR-017` `PS-9`'s precedent) that no write path
yet exists to enforce.~~

**The domain now carries the token, and `C9` now declares the column** (issue #187).
`ListingRevision.baseListingLastUpdatedAt` is a **mandatory `Instant`** — the same
carrier as the `listing.lastUpdatedAt` it copies, which is what makes `ADR-023` item
11's exact epoch-millisecond equality structural rather than hoped for — and
`listing-table.ts` declares `base_listing_last_updated_at: ReadOnlyColumn<number>`,
**`number` rather than `number | null`** because the column is `NOT NULL`. The
declaration is **not a second source of schema truth**: a test compares it against the
live catalogue on name, carrier and nullability.

~~**Nothing still reads or writes that column.** There is **no mapper**, **no
serializer or hydrator for revisions**, **no API transport**, **no staleness
comparison** and **no administrator message**; and **no revision or moderation
persistence exists** — no
revision read, no revision write, no moderation operation. `listing_revision` remains
**unwritable by construction**: every column is typed read-only, so an insert does not
compile.~~

**Superseded by three persistence units.** `revision-mapping.ts` serializes and hydrates
revisions and round-trips that column (issue #195); `OP-6` creation and pending retrieval
exist (issue #195, merged #196); `OP-10` approval-and-application exists, and **its**
staleness comparison with it (issue #197, merged #198); and revision **rejection** exists
(issue #199). `listing_revision` is no longer unwritable by construction: the columns `OP-6`
inserts are writable, and `state` and `rejected_at` — and **only** those two — are updatable,
for the rejection transition. Exact key-set guards fail `tsc` if either surface widens.

**Still absent:** **no API transport**, **no administrator message**, **no authorization**,
**no audit storage** (`OQ-14`/`NOQ-8`/`DDM-7`), **no rejection reason** (no column exists;
`FR-ADM-08` is unimplemented), **no rejected-revision retrieval or history read**, and **no
retention eligibility query, purge scheduling or purge execution** (`OQ-13`). **No operation
identifier is claimed for revision rejection** — `docs/09` records which operation expresses it
as a pre-existing open question, and that question is untouched.

**The `PS-11` isolation and retry policy is now decided** (`ADR-024`, `Accepted`
2026-10-14, issue #189), and **deciding it implements nothing**. The governed writes
will run at **`READ COMMITTED`**, set explicitly per transaction, under `ADR-017`'s
`PS-11` listing-row lock taken **first** and held to commit, with the **captured token
compared before any mutation** and **carried again in the guarded listing-write
predicate**; **no automatic application-level retry** is selected, and only **`40001`
and `40P01`** are classified retryable. ~~**No transaction, repository, SQL, comparison
or retry code exists**, and the four governed paths — `OP-6`, `OP-10`, `FR-ADM-04`,
`FR-ADM-10b` — remain **unimplemented**.~~

**Three `PS-11` transactions now exist**, each at `READ COMMITTED` set explicitly, each taking
the listing-row lock **first** and holding it to commit: **`OP-6`** revision creation (issue
#195), **`OP-10`** approval and application (issue #197) and **revision rejection** (issue
#199). ~~**`FR-ADM-04`** and **`FR-ADM-10b`** remain **unimplemented**.~~ **`FR-ADM-04` landed with issue #217** as a fourth `PS-11` transaction, on the
**listing** row of a pending record; ~~**`FR-ADM-10b`** remains **unimplemented**~~ **and
`FR-ADM-10b` landed with issue #219**, which is the **fifth** such transaction here and
`ADR-024`'s **fourth and last** named path — rejection is a `PS-11` transaction but not one of the
four paths that ADR enumerates, which is the whole of the difference between the two counts. ~~`FR-ADM-04`
additionally awaits a pure-domain operation that does not exist — the
`FR-DATA-11c`/`ADR-017` Q-4 designation rule that an administrator may **restrict but
never make public**, and that a new or replacement value **defaults to private**.~~
**That designation rule now exists**: `enforceDesignationPolicy` landed as a pure domain
operation with issue #206 and is enforced on `OP-6` since issue #207 — the strikethrough
records that this paragraph was written before either, not that the rule was ever absent
from `ADR-025`. ~~What `FR-ADM-04` still awaits is its **own** pure-domain
administrative-edit operation and the **three-state partial-edit input** `ADR-025`
§C.4 requires; its **no-op outcome is ruled** (ungated Product Owner policy
clarification — issue #213), and **no such type or operation exists or is
authorized**.~~ **Both landed with issue #215**: `applyAdministrativeEdit` and the
three-state `PatchField` live in `src/domain/listing/administrative-edit.ts` and
implement the issue #213 ruling. They are **pure domain** — they read no clock and reach no
store — ~~nothing in `src/data/` imports or calls them~~ **and `src/data/` now calls them since
issue #217**, ~~**no persistence path exists for `FR-ADM-04`**~~, and
~~`FR-ADM-10b` remains **unimplemented**~~ **`FR-ADM-10b` landed with issue #219, recorded
below**. **The persistence path landed with issue
#217**: `listing-administrative-edit.ts` is `ADR-024`'s **third** governed write path,
and the first that edits the **listing row of a pending record** rather than a
revision. A valid no-op **writes nothing and commits**; a material edit performs
**one** guarded `UPDATE`. No transport, authorization, messaging or audit exists.

**`FR-ADM-10b` landed with issue #219** as `ADR-024`'s **fourth and last** governed `PS-11` write path: `createAndApproveRevisionAtomically` in `src/data/revision-atomic-approval.ts` creates, validates, approves, applies and removes a **transient** pending revision inside **one** transaction (`ADR-017` Q-3) — explicit `READ COMMITTED`, the complete listing `SELECT … FOR UPDATE` first and held to commit, the post-lock locked pending read that decides the issue #137 refusal **under the lock**, exact comparison with the caller's **original** `ADR-023` token, `enforceDesignationPolicy` and the merged pure-domain `admitPendingRevision` and `approvePendingRevision` as the sole content authorities, then **one** `INSERT`, **one** guarded `UPDATE` carrying that same token and **one** `DELETE`, each with its affected-row count checked. The proposal is **complete replacement content**, never `FR-ADM-04`'s three-state patch; an **equal-content** proposal is an ordinary revision that **advances `last_updated_at`**, because the issue #213 no-op ruling governs `FR-ADM-04` only. **Revision identity stays adapter-private** — supplied under `ADR-019`, never in the domain, never returned, no `RETURNING` — so `DDM-2` remains open. **No retry is performed**, and **schema and migrations are unchanged**. **Transport, authorization, administrator confirmation and conflict messaging, and audit storage do not exist**, and rejected-history retrieval and retention/purge remain deferred.

**Only `OP-10` compares a token, and that is deliberate.** `ADR-024` items 6–8 bind the
comparison to the listing write it guards, so rejection — which *"the listing row is not
written"* (`ADR-017`, `FR-ADM-10`) — makes **no** comparison, advances **no** timestamp, and
has **no** staleness and **no** `DI-6` outcome. A **stale proposal is therefore rejectable**,
which is also its only escape: it can never be approved, so refusing to reject it would hold
the listing's single `DI-11` slot for ever. **Still no retry code exists**, and only `40001`
and `40P01` are classified — classification is not a licence to retry.

The **token's immutability** is now enforced on the write path too, not only in the domain:
`base_listing_last_updated_at` is **not updatable at all**, so no transaction can refresh it,
and the rejection suite asserts a stale token comes back unchanged. Each remaining path is a
**separately reviewed downstream step**, and **no provisioning or production execution has
occurred**.

## What does not exist, and what is not authorized

~~**No schema, no migration**, no application connection or pool configuration, and
no repository or persistence implementation exists in this repository.~~

**Two schema migrations now exist** —
`migrations/001-create-listing-and-revision-tables.ts` (issue #171), creating the
`listing` and `listing_revision` structures with their keys, constraints and the
`DI-11` partial unique index, and
`migrations/002-add-revision-base-version.ts` (issue #183), adding the single
base-version column described above. **Nothing else here changed.** There is still **no
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
| **The `ADR-022` timestamp boundary** — `parseTimestamptz` and its `pg` type-override value | **Exists** (issue #173), and is now **wired** (issue #177): ~~a mechanism, not a wiring; no pool passes it~~ — `connection.ts` passes it explicitly to every application pool it builds, per pool. `pg`'s **global** parser is still never touched, so the migration runner and any other consumer keep the driver's default `Date` behaviour |
| **The first `C9` persistence slice** — connection boundary, schema typing, listing mapping, one insert and one read by identifier | **Exists** (issue #177). It is **not an application wiring**: nothing outside the tests constructs it, and it reads no environment variable |
| **Local/test execution** — the migration applied against a disposable server | **Exists, in tests only.** The attacking tests start a real PostgreSQL server from the `embedded-postgres` development dependency, on an ephemeral port with a disposable data directory, through the shared `testing/embedded-cluster.ts` lifecycle (issue #179) — **one isolated cluster per test file**, never a shared one. Shutdown is awaited: the helper waits for the owned postmaster to exit before removing the directory, bounds the Windows transient file-handle retry, and **fails the test file** if it cannot prove the cluster is gone, so no manual cleanup is ever an accepted outcome. That server is a **test-harness detail with no production-version authority**, and `DG-4` testing depth remains Unresolved |
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
`ADR-022` timestamp parser, which **issue #173** authorized. ~~Persistence
code, any connection or pool configuration, the `ADR-021` category
configuration module and every later migration each still require a separately
authorized issue of their own.~~ **The category configuration arrived with
issue #175, and the first persistence slice with issue #177** — each as its own
authorized unit, which is the point. **Every remaining persistence operation,
the application's own composition of this boundary, and every later migration
still require a separately authorized issue of their own.**

## The two standing obligations

Two obligations bind whatever eventually lands here:

- **All PostgreSQL access is server-side** (`O-1`). `C9` owns transactions, so
  a create, edit, or moderation action completes fully or has no effect
  (`NFR-DATA-03`).
- **Browser-direct datastore access is prohibited** (`O-2`). No client holds a
  datastore credential and no public route reaches the store
  (`NFR-SEC-08`; `docs/07` `R-10`).

~~**Still no `C9`, and still no schema.**~~ **There is now a schema (issue #171) and a first
`C9` slice (issue #177).** There is still **no application wiring, no public read path, no
revision or moderation persistence, no provisioning and no production execution** — and
completing a slice is not the same as the product persisting anything.
