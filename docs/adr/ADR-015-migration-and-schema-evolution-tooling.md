# `ADR-015` — Select migration and schema-evolution tooling for PostgreSQL (`DDM-10`)

| Field | Value |
|---|---|
| **Status** | **`Accepted`** |
| **Date** | 2026-09-14 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-09-14.** |
| **Decision gate** | *none* — `DG-2` is **`Resolved`** (2026-08-27, issue #93) and this ADR is **not** one of its constituents; `DG-1` is **`Resolved`** (2026-08-04) |
| **Related open questions** | **Depends on:** nothing unresolved. `ADR-002`, `ADR-003`, `ADR-005`, `ADR-006`, `ADR-010`, `ADR-012`, `ADR-013` and `ADR-014` are all **Accepted** and supply every constraint this decision must satisfy. **Must NOT answer:** **`DDM-2`–`DDM-9`** (physical data design), the **PostgreSQL driver/client**, the **Kysely dialect**, the **connection pooler**, migration **execution environment and timing**, **rollback policy**, `OQ-4`, `OQ-5`, `OQ-14`/`NOQ-8`, `NOQ-9`, `DG-3`, `DG-4` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **`Accepted`, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is
> *"Decided and **in force**. Work may rely on it."* The product owner ruled on **2026-09-14** that
> **Kysely Migrator is selected as the migration and schema-evolution tooling approach for
> `DDM-10`**, following this document's `Proposed`-stage publication of **2026-09-13** (issue
> **#119**, merged by PR **#120** on 2026-09-14) and the separate governed acceptance step recorded
> on issue **#121**. **`DDM-10` is resolved by this `Accepted` ADR.**
>
> **Acceptance is not installation and not implementation authorization.** Kysely is not
> installed, and Kysely `Migrator` is not installed; no migration exists, no schema exists, and no
> persistence code exists. Acceptance selects **no** PostgreSQL runtime driver/client, **no** Kysely
> dialect, **no** application pool and **no** external pooler; resolves **no** `DDM-2`–`DDM-9`; and
> authorizes **no** dependency installation, migration, provisioning, CI database infrastructure or
> other implementation — each remains a separate later work unit requiring its own owner
> authorization.

---

## Context

**`DDM-10` is the next separately governed persistence decision after `ADR-014`** — not the last:
the PostgreSQL driver/client, the Kysely dialect, the pooler, `DDM-2` through `DDM-9` and other
downstream persistence decisions all remain unresolved. `docs/08-data-model.md` records it in one line — *"Migration and
schema-evolution tooling … Out of scope for a logical model entirely"* — with **no blocker
listed**. It has been carried, untouched, through `ADR-002`, `ADR-003`, `ADR-005`, `ADR-012`,
`ADR-013` and `ADR-014`, each of which restated owner ruling **`R-A`** and expressly declined to
take it.

**`ADR-014` named this work unit and deliberately did not create it.** Its *Why this ADR is narrow
by construction* section records the owner-approved governance split:

> *"The data-access approach has no `DDM-*` identifier at all — it lives under ruling `R-A`.
> Migration and schema-evolution tooling **does** have one: `DDM-10`. The two have materially
> different alternatives, different evaluation criteria, and in some branches change independently
> of each other. The product owner approved a split on that basis: this ADR decides the access
> approach only, and a separately governed work unit decides `DDM-10` afterwards."*

**Why it can no longer be deferred.** `ADR-014` classified direct `pg` as making `DDM-10`
*"mandatory and un-deferrable: without some chosen tool or hand-written runner, no schema can be
created at all."* The same is true one step removed of the selected approach: Kysely describes a
schema it does not create. `docs/12`'s `P1` still owes atomic publication (`BI-7`, `DI-3`,
`NFR-DATA-03`), timestamp and integrity rules (`DI-6`, `DI-7`), the server-enforced public/private
boundary, revision storage, retention and purge, publication state, and `C9` itself; `P1`'s exit
criterion `RC-1` requires `DI-1`–`DI-11` proven; and `P2`–`P4` each list `P1` as a dependency.
None of that can begin without a mechanism for bringing a schema into existence.

**And deferring once more decides it badly.** `ADR-014` rejected further deferral in terms that
apply here unchanged: *"the next deferral would be resolved by whoever writes the first persistence
pull request, which is `IR-1` exactly."* A migration mechanism adopted inside an implementation
pull request would be the failure `docs/adr/README.md` names — *"An ADR must not answer an open
question implicitly"* — and Definition of Done #6 forbids it outright.

**Requirements this decision answers to.** `NFR-DATA-01`, `NFR-DATA-02`, `NFR-DATA-03`,
`NFR-DATA-06`; `NFR-MAINT-03`; `NFR-REL-04`. It **proves** none of them: it selects the mechanism
whose later use must be able to serve them.

## Decision question

**By what tooling and mechanism will the PostgreSQL physical schema be created and evolved over
time?**

`DDM-10` is resolved when a migration / schema-evolution tool — or an explicitly named "no tool"
posture — is selected, sufficient that a later work unit could author and apply migrations without
making a further governance decision about *how*.

**It is not resolved by, and does not resolve, what the schema contains.** `DDM-2`–`DDM-9` decide
**what** the physical schema is. `DDM-10` decides **by what tooling and mechanism** that schema is
created and evolved. This document holds that line throughout and contains **no schema example, no
SQL, and no table, column, key, constraint or index of any kind** — deliberately, because an
illustrative example is the most likely way a physical decision would be smuggled in.

## Accepted architecture taken as fixed input

Reconstructed from `Accepted` ADR text and repository configuration. **None of these is reopened.**

| Input | Source | Implication for this decision | What it does **not** decide |
|---|---|---|---|
| **PostgreSQL**, managed operating posture | `ADR-003` (Accepted) | Candidates must target PostgreSQL | Nothing physical |
| **DigitalOcean Managed PostgreSQL**, named | `ADR-013` (Accepted) | `ADR-014` records that **the superuser role is not available**; a candidate requiring superuser is disqualified. All candidates speak the standard wire protocol | Region, tier, sizing, version, provisioning, credentials |
| **Kysely** as `C9`'s data-access approach | `ADR-014` (Accepted) | SQL remains the source of truth; the hand-written interface *describes* a schema rather than defining it. A candidate that introduces a **second** schema source of truth is in tension with this | The driver, the dialect, the pooler — all expressly deferred |
| **Node `>=22.12.0`**; ESM (`module: esnext`, `moduleResolution: bundler`) | `package.json`, `tsconfig.json` | Candidates must support this floor and module posture | Any version of anything new |
| **npm** as repository tooling | repository | A candidate distributed outside npm carries an extra acquisition and pinning burden | Nothing |
| **Modular monolith**, dependencies strictly inward | `ADR-001`; `ADR-002` `O-9` | Migration tooling sits outside `src/domain/`; the boundary is satisfied trivially by every candidate | Nothing |
| **Render**, long-running Node service, single instance | `ADR-005` (Accepted) | Recorded as the hosting posture. **Where and when migrations run is not decided here** | Execution environment and timing — separately governed |
| **Vitest**; CI exists, **no database CI infrastructure selected** | `ADR-012` (Accepted); PR #98 / #100 | Future CI use is a *nice-to-have* compatibility consideration only, because there is no database service to be compatible with yet | Test infrastructure, coverage, `DG-4` |
| **`DDM-2`–`DDM-9` unresolved** | `docs/08` | The tool must be selectable **without** resolving them, and must not encode them | Every physical data question |

### `ADR-010` imposes no constraint on this candidate set

**Stated explicitly, because it is the most plausible place to invent a requirement.**
`ADR-010-backup-recovery-availability-posture.md` contains **no** migration requirement of any
kind. `ADR-014` records the point directly: `ADR-010` requires the **outcome** — correct restored
business state — and *"does not require any particular query, migration or inspection
capability."*

Therefore this ADR does **not** claim that `ADR-010` requires transactional migrations, down
migrations, migration inspectability, schema-rebuild tooling, or any particular runner. *Analysis,
not an `ADR-010` requirement:* a migration history that is legible and replayable is likely to make
a rebuild easier to reason about. That is weighed as **operational convenience**, and no candidate
is disqualified by it.

## Relationship to `ADR-014` — what "leaves open" does and does not mean

`ADR-014` classified Kysely as **`LEAVES OPEN`** with respect to `DDM-10`. That classification is
`Accepted` text and is preserved here **exactly as written**, not strengthened:

- **Kysely is already selected for runtime data access** in `C9`. That decision is in force.
- **Its migration facilities are optional, and selecting Kysely did not select its `Migrator`.**
  `ADR-014`'s own evidence row records the `Migrator` as *"built-in optional"* and *"freely
  replaceable"*, and its CLI as *"explicitly not part of the core."*
- **An independent migration tool remains architecturally permitted.** `ADR-014`: *"an entirely
  external, plain-SQL migration regime composes cleanly, and migration tooling can be changed later
  without touching runtime data access."*
- **A raw-SQL migration posture remains possible** for the same reason.
- **Schema-first ORM migration tooling remains technically possible**, but because Kysely produces
  no schema artifact, such a tool would introduce a schema declaration alongside the SQL and the
  hand-written describing interface — a **duplicate-schema-source coupling**. `ADR-014` classified
  Prisma and Drizzle as **narrowing** `DDM-10`, never as foreclosing it, and that distinction is
  preserved below.

**What `LEAVES OPEN` does not mean:** it does not mean every candidate is equally suitable, and it
does not mean Kysely's `Migrator` is favoured by the accepted decision. `ADR-014` selected a
runtime access approach and nothing more. The comparison below is therefore conducted on its own
evidence.

## Current external facts

**Verification date: 2026-09-13.** These are **externally verified current facts recorded as
decision-time evidence**. They are **not repository decisions and not normative**, and versions are
**evidence, not implementation pins** — no version is selected by this ADR. Sources are listed in
*Mutable-fact verification*. `ADR-014`'s 2026-09-09 research was **not** relied on for any mutable
fact; every figure below was re-verified independently on the date above.

### Category A — Kysely's own migration facilities

| Fact | Value (verified 2026-09-13) |
|---|---|
| Package | `kysely` **0.29.5**; MIT; `engines.node >=22.0.0`; **zero runtime dependencies**; `"type": "module"` |
| Migration facility | Part of the core package — a dedicated `migration` export exists alongside the main entry |
| Ordering | Executed in **alpha-numeric order of migration names**; the documentation recommends an ISO-8601 date prefix. Order against already-executed migrations is **enforced by default**; an `allowUnorderedMigrations` option relaxes it |
| Locking / concurrency | **A database-level lock**; parallel calls are *"executed serially"*, so calls from multiple instances run the migrations **only once**. Locks release if the process crashes or the connection fails |
| Transactions | Migrations run in a transaction by default where the dialect supports transactional DDL, with an option to disable. **See the revalidation note below** |
| Authoring format | A migration file exports `up` and `down` functions taking a Kysely instance. **Either** the schema builder **or** raw SQL via the `sql` tag **or** ordinary queries may be used |
| Down migrations | The documentation presents them as standard practice and does not state that they are required |
| CLI | **Not part of core.** `kysely-ctl` **0.21.0**; MIT; `engines.node >=22`; ESM; peer `kysely >=0.18.1 <0.30.0` |
| Driver | Supplied by whichever Kysely **dialect** is later chosen — **not bundled, and not pinned to any one client** |
| Maintenance | `kysely` last published **2026-08-10**; 187 releases; a `0.30.0-beta` line exists |

### Category B — Node/PostgreSQL-specific migration tooling

| Fact | `node-pg-migrate` | `postgres-migrations` |
|---|---|---|
| Version / licence | **9.0.0**; MIT | **5.3.0**; MIT |
| Node engines | `>=20.11.0` | `>10.17.0` |
| Module posture | `"type": "module"` | **CommonJS** |
| Driver relationship | **`pg` is a required, non-optional peer dependency** (`>=4.3.0 <9.0.0`) | **`pg` is a hard runtime dependency** (`^8.6.0`) |
| Other dependencies | `glob`, `jiti`, `yargs` | `pg`, `sql-template-strings` |
| Ordering | Timestamp-prefixed filenames; **order checked before execution by default** (`--check-order`) | Not re-verified — see below |
| Transactions | **All pending migrations in a single transaction by default**; `--no-single-transaction` disables | Not re-verified |
| Locking | **Advisory lock**; `--no-lock` disables; `--advisory-lock-mode` is `fail` (default) or `wait` | Not re-verified |
| History table | The tool maintains its own migration-history bookkeeping table; refuses to proceed on a schema mismatch rather than replaying | Not re-verified |
| Authoring format | JavaScript, TypeScript, **or SQL** | SQL files |
| Maintenance | Last published **2026-09-05**; 218 releases; a `10.0.0-alpha` line exists | **Last published 2021-07-20; registry metadata last modified 2022-05-13** — approximately five years without a release |

`postgres-migrations` is **not carried forward as a finalist**, solely on the maintenance evidence
above together with its CommonJS posture against this repository's ESM configuration. This is a
currency judgement, not a quality judgement, and it is recorded so it is not silently re-made.

### Category C — standalone tooling independent of Kysely and of Node

| Tool | Runtime | Licensing posture (verified 2026-09-13) |
|---|---|---|
| **Flyway** (Redgate) | JVM-based, with distributions aimed at non-JVM users | Community is the open-source edition; **Teams** and **Enterprise** are paid supersets, licensed per user |
| **Liquibase** | JVM | **From version 5.0, Liquibase Community is licensed under the Functional Source License (FSL-1.1-ALv2)** — source-available, converting to Apache-2.0 on a delay — rather than an OSI-approved licence at time of publication. Liquibase Secure is the commercial edition |
| **Atlas** (Ariga) | Standalone Go binary | Free **Starter** tier; paid **Pro** and **Enterprise**. **The exact open-source licence of the community edition could not be confirmed from the pages retrieved** and is marked as requiring verification. Terms of use restrict building competing products |
| **Sqitch** | Perl | Not separately verified — carried as a category representative only |

**These are recorded as category evidence, not as finalists.** The principal consideration is
common to all four and is an operational one: each introduces a **second language runtime** (JVM,
Go binary, or Perl) into a repository whose entire toolchain is Node and npm, maintained by one
person. That is a higher operational, runtime and tooling burden and a poorer fit for this
single-maintainer posture — **an evaluation factor, not a hard architectural bar**; the repository
establishes no prohibition. All four remain technically viable; see *Alternatives considered*.

### Category E — ORM-owned migration tooling

`Prisma Migrate` and `drizzle-kit` were compared in full by `ADR-014` as parts of their respective
access approaches, **both of which the owner rejected**. Their migration generators read the same
schema declaration that defines runtime access. Under the accepted Kysely architecture there is no
such declaration, so adopting either would require **introducing one**, creating a second schema
source of truth alongside the SQL and the hand-written describing interface.

**No version facts are re-verified for this category**, because it is not carried forward as a
finalist and stale figures would be worse than none.

### Facts requiring revalidation before any implementation

- **Kysely's default transaction behaviour and any `transactionMode` option.** The per-migration
  transaction option reported for the `0.30` line was obtained from a secondary summary, **not** from
  primary documentation, and `0.30` is currently a **beta** line. **Treat as unverified.**
- **`kysely-ctl`'s peer range** (`<0.30.0`) against whatever `kysely` line is current at
  implementation time.
- **`node-pg-migrate`'s `10.0.0` line**, currently in alpha.
- **Atlas's community-edition licence**, unconfirmed above.
- **`postgres-migrations`' maintenance status**, should it resume releases.

## Evaluation criteria

Classified per the commissioning analysis recorded in issue #119. **No preference is promoted to a
requirement**, and where the repository establishes nothing, that is stated rather than filled.

**REQUIRED**

| Criterion | Basis |
|---|---|
| PostgreSQL compatibility | `ADR-003`, `ADR-013` |
| Compatibility with the accepted Kysely architecture — **no duplicate schema source of truth** | `ADR-014` |
| Node `>=22.12.0` and repository module posture, where applicable | `package.json`, `tsconfig.json` |
| Operates **without** the PostgreSQL superuser role | `ADR-013` provider facts, as recorded in `ADR-014` |
| A credible migration **ordering / versioning** mechanism | Inherent — an unordered migration regime is not schema evolution |
| Reliable **forward** migration capability | Inherent |

**IMPORTANT** — genuinely important, and genuinely not mandatory: reproducibility; **SQL
transparency** (`ADR-014` labels inspectability *"an analytical convenience, never a mandate"*);
transactional migration support; dependency footprint; operational simplicity; learning complexity
for a single maintainer (`PA-1`); maintainability (`NFR-MAINT-03`); runtime coupling
(`ADR-002` `O-9`); **schema-drift risk** — `ADR-014` names drift between the hand-written
describing interface and the actual schema as *"this decision's principal risk"*; future
portability and lock-in.

**NICE TO HAVE** — compatibility with future CI use; fit with a future Render deployment workflow.
Both are weak criteria today precisely because **no database CI infrastructure and no deployment
migration workflow exist or are selected**.

**NOT PROMOTED TO REQUIRED, ON PURPOSE** — rollback / down-migration support; development migration
workflow; deployment migration workflow; `ADR-010` recovery characteristics. Candidates are
compared on these where evidence exists, but **no repository document establishes any of them as a
requirement**, and this ADR does not manufacture one.

### Repository gaps, stated as gaps

- **No rollback / down-migration policy exists** anywhere in the repository.
- **No development-time migration workflow** is established.
- **No deployment-time migration workflow** is established.

These are **left open**. They are not filled by this ADR, and a candidate's *capability* in these
areas is treated as capability, never as policy.

## Detailed comparison — the two finalists

Two candidates survive the REQUIRED criteria with substantive evidence behind them: **Kysely's
built-in `Migrator`** (category A) and **`node-pg-migrate`** (category B). A third posture — **raw
SQL with a hand-written runner** (category D) — is analysed alongside them because it is the
baseline against which added dependency is judged.

### Architecture and Kysely fit

**Kysely `Migrator`.** Part of the package the accepted approach selects; no additional
migration-specific dependency is required beyond Kysely itself (which is architecturally selected
but not yet installed). Migrations run through a Kysely instance, so they compose with the same
transaction control `ADR-014` selected. **The coupling is real and runs the other way too:**
migrations authored through the schema builder are expressed in Kysely's idiom, so replacing Kysely
later would mean the migration history is written in a library that is no longer used. That history
still *ran*, and the database it produced survives — but it becomes an artifact of a departed
dependency.

**`node-pg-migrate`.** Fully independent of Kysely. Migration history and runtime access share
nothing, so replacing either leaves the other untouched — the strongest portability position of the
three. The cost is a genuinely separate tool with its own configuration, CLI and mental model.

**Raw SQL + hand-written runner.** Maximum independence, zero third-party migration dependency, and
SQL that is portable by construction. The cost is that **ordering enforcement, the applied-history
table, advisory locking and failure semantics all become hand-written code** — precisely the burden
`ADR-014` counted against direct `pg` when it noted that approach *"pushes the greatest volume of
bespoke infrastructure into `C9`, including a hand-built migration runner."*

### Schema source of truth

**All three are equal here, and all three are correct.** None requires a schema declaration; under
each, SQL or SQL-shaped statements remain the source of truth and Kysely's hand-written interface
continues to *describe* rather than define. **None of the three introduces a duplicate schema
source of truth.** This REQUIRED criterion therefore eliminates category E and no one else.

### Driver coupling — a governance difference

**This is a governance and implementation-convenience distinction rather than an architectural
foreclosure.**

- **Kysely `Migrator`** obtains its connection from whichever **dialect** is later chosen. `ADR-014`
  established that the dialect — and therefore the driver — is *"an implementation-time deferred
  choice"*, citing the officially supported core PostgreSQL dialect **and** an
  organisation-maintained Postgres.js dialect. Selecting the `Migrator` **preserves that deferral
  intact**: whichever dialect the owner later selects, the migration mechanism follows it. It too
  will require a dialect and driver at implementation time.
- **`node-pg-migrate`** declares **`pg` as a required, non-optional peer dependency** of the
  migration tool. That does **not** select `pg` as the runtime Kysely driver — the runtime
  driver/client remains deferred, and running migrations on `pg` while `C9` runs on another client
  is a technically possible two-client configuration. The distinguishing cost is that it constrains
  **one migration-side client choice earlier**, creating governance and implementation-convenience
  pressure toward `pg` at runtime — a risk of the `IR-1` shape this repository has repeatedly paid
  to avoid, not an architectural foreclosure.

**Recorded as a coupling consequence and an evaluation factor, not as a selection.** This ADR
selects **no** driver, and specifically neither `pg` nor Postgres.js.

### Ordering and versioning

Both finalists establish ordering credibly and by different means. Kysely orders
**alpha-numerically by migration name**, recommends an ISO-8601 prefix, and **enforces by default**
that new migrations do not violate the order already executed. `node-pg-migrate` uses
timestamp-prefixed filenames and **checks order before execution by default**. A hand-written runner
would have to implement ordering and its enforcement from scratch — the most likely place a
bespoke runner goes wrong quietly.

**No repository-wide numbering convention is established by this ADR.** Whatever naming the
selected candidate necessarily implies is a consequence of that selection; nothing further is
imposed.

### Transactions and concurrency

Both finalists provide database-level protection against concurrent execution — Kysely through a
**database-level lock** that serialises parallel calls, `node-pg-migrate` through an **advisory
lock** with configurable contention behaviour. Both run migrations transactionally by default, with
an option to disable. A hand-written runner provides neither until someone writes both, and the
failure mode of getting either wrong is silent and severe.

**Note the limit of this finding.** Concurrency protection is a **capability** of each tool. It
does not decide, and this ADR does not decide, **where or when** migrations are executed — that
remains separately governed.

### Dependency footprint and operational complexity

| | Kysely `Migrator` | `node-pg-migrate` | Raw SQL + runner |
|---|---|---|---|
| New runtime dependencies | **No additional migration-specific package** beyond Kysely, which `ADR-014` selects architecturally but which is not yet installed; installation is not authorized here | `node-pg-migrate` + its three dependencies, **plus a required `pg` peer** | None |
| New concepts for one maintainer | Fewest — the same library already being learned | A separate tool, CLI and configuration | Fewest to learn, **most to build and maintain** |
| Bespoke code to maintain | Migration files; a small invocation | Migration files; configuration | Migration files **plus the runner, ordering, locking and history table** |
| CLI | Optional and non-core (`kysely-ctl`), or invoked programmatically | Included | Hand-built |

### Maintenance and currency

`kysely` published **2026-08-10**; `node-pg-migrate` published **2026-09-05**. **Both are
actively maintained**, and neither raises the currency concern that removes `postgres-migrations`
from consideration. Both carry a pre-stable line in flight (`kysely` `0.30.0-beta`,
`node-pg-migrate` `10.0.0-alpha`), which is **evidence of active development, not a defect**, and
in both cases the version line is an implementation-time matter to be re-verified then.

### Schema-drift implications

**No candidate fixes the drift risk `ADR-014` identified**, and none should be credited with doing
so. Under all three, the hand-written describing interface must be kept in step with the schema by
hand. A migration history that is legible and replayable helps a human verify that correspondence;
it does not enforce it. **No mechanism for detecting drift is selected here** — that would be a
separate decision.

## Decision

**Kysely Migrator is selected as the migration and schema-evolution tooling approach for
`DDM-10`.** The product owner ruled on **2026-09-14**. That ruling is recorded here as
**authoritative**, and `DDM-10` is resolved by this `Accepted` ADR through the selection of Kysely's
built-in `Migrator`. **It selects the mechanism and nothing else** — see *This ADR selects nothing
else*.

**The owner's reasons, as ruled:**

1. Kysely is already the accepted `C9` PostgreSQL data-access approach under `ADR-014`.
2. Kysely `Migrator` requires no additional migration-specific package beyond Kysely itself.
3. It provides migration ordering, migration-history tracking and locking without requiring a
   hand-built migration runner.
4. It avoids introducing earlier migration-side `pg` coupling before the separately deferred runtime
   PostgreSQL driver/client decision.
5. The owner accepts the trade-off that migration-history tooling becomes coupled to Kysely.
   `node-pg-migrate` offers stronger independence and portability, but for the MVP operational
   simplicity, fewer moving parts and avoiding earlier migration-side driver coupling are weighted
   more highly.

**The analytical case recorded at the `Proposed` stage**, on which the owner ruled, rests on two
grounds that hold independently of one another:

1. **It keeps the deferred driver decision free of earlier migration-side pressure.** `ADR-014`
   deliberately left the driver/client and dialect unselected as *"an implementation-time deferred
   choice"* with real, officially supported alternatives. The `Migrator` takes its connection from
   whatever dialect is later chosen, so it constrains no client choice ahead of that decision —
   though it too will need a dialect and driver at implementation time. `node-pg-migrate` requires
   `pg` for the migration tool; that does not select the runtime driver, and a two-client
   configuration remains possible, but it constrains one migration-side client choice earlier and
   creates governance and implementation-convenience pressure toward `pg`. **This ground is about
   governance risk, not architectural foreclosure.**
2. **No additional migration-specific dependency is required beyond Kysely itself.** Kysely is
   architecturally selected but not yet installed, and this ADR does not authorize installing it;
   dependency installation remains separately authorized implementation work. The facility is part
   of a package whose zero-runtime-dependency footprint `ADR-014` weighed explicitly for a
   single-maintainer MVP. Against the raw-SQL baseline it supplies ordering enforcement, a
   database-level lock and applied-history tracking that would otherwise be hand-written — the
   bespoke-infrastructure cost `ADR-014` counted against direct `pg`.

**Schema source of truth — a requirement met, not an advantage.** Under the `Migrator`, migrations
may use raw SQL, the schema builder, or ordinary queries; no schema declaration is introduced; the
REQUIRED no-duplicate-source criterion is satisfied. `node-pg-migrate` and the raw-SQL baseline
satisfy it equally, so it does not discriminate among the finalists.

**The cost is real and is not minimised.** The migration history becomes **coupled to Kysely**,
which `node-pg-migrate` would avoid entirely. If the access approach is ever replaced, migrations
authored through the schema builder are written in a departed library's idiom. **`node-pg-migrate`
is genuinely better on portability**, and an owner who weighs independence of the migration history
above avoiding earlier migration-side `pg` coupling could reasonably have selected it — that argument is sound and is
preserved here so it survives the ruling (`IR-6`). Two secondary costs: the CLI is non-core, so
either `kysely-ctl` is adopted as a narrower later choice or the `Migrator` is invoked
programmatically; and `kysely-ctl`'s current peer range excludes the `0.30` line.

**Robustness.** The decision rests on **verified** facts — package metadata, official
migration documentation, and `ADR-014`'s accepted text. Its weakest supporting element is the
precise transaction-mode behaviour flagged for revalidation, which affects *how* transactions are
configured, **not** whether the decision holds. **The owner could reasonably have ruled otherwise**,
and the strongest counter-argument — migration-history portability — is stated above rather than
buried.

### What the decision settles and does not settle

**It settles**: the migration and schema-evolution **mechanism**; the ordering model inseparable
from it (alpha-numeric by migration name, order-enforced by default); and the availability of that
tool's locking and transaction facilities.

**It leaves open** — and these must not be read as settled by this acceptance:

- the **authoring format**, since the `Migrator` permits raw SQL, the schema builder and ordinary
  queries. **This ADR does not choose among them**, and imposes no rule that migrations must take
  any one form;
- whether `kysely-ctl` is adopted, or the `Migrator` invoked programmatically;
- **rollback / down-migration policy** — the facility supports down functions; **whether the project
  requires, writes or ever runs them is unresolved and is not decided here**;
- **migration execution environment and timing** — startup, deployment, CI, workstation or a
  dedicated job are all *capabilities*, and **none is selected**;
- everything in *This ADR selects nothing else*.

## Alternatives considered

Classified precisely. **Nothing here is called impossible that is merely a poor fit.**

| Alternative | Classification and why it is not selected |
|---|---|
| **`node-pg-migrate`** (category B) | **Valid, actively maintained, and a legitimate choice — not selected, on driver coupling.** Published 2026-09-05, ESM, TypeScript/JS/SQL authoring, order checking on by default, advisory locking with configurable contention, single-transaction default, and a documented refusal to replay across a schema mismatch. It is **better than the selected approach on portability**, which is a real advantage, not a consolation. It is not selected because its **required non-optional `pg` peer dependency** constrains one migration-side client choice earlier and creates governance and implementation-convenience pressure toward `pg` — without selecting the runtime driver, which stays deferred, and without foreclosing a two-client configuration — and because it adds a tool and a dependency tree where the selected approach adds no migration-specific package beyond Kysely itself. **An owner weighing migration-history independence above avoiding earlier migration-side `pg` coupling and pressure could have selected it.** |
| **`postgres-migrations`** (category B) | **Valid but stale.** Last published 2021-07-20 with registry metadata unchanged since 2022-05-13 — roughly five years — and CommonJS against this repository's ESM posture. Not recommended on **currency**, not on design. |
| **Raw SQL with a hand-written runner** (category D) | **Valid, and the most portable option of all — not recommended on build-and-maintain cost.** It would require hand-writing ordering enforcement, the applied-history table, advisory locking and failure semantics, each a silent-failure surface, for a single maintainer. `ADR-014` already counted a hand-built migration runner as a cost against direct `pg`. **Note carefully:** rejecting a hand-written *runner* does not reject *raw SQL as an authoring format* — that remains available under the selected mechanism and is expressly not decided here. |
| **Flyway** (category C) | **Valid but a poor fit at higher cost.** Mature and PostgreSQL-capable; introduces a **JVM-oriented toolchain** into an all-Node, single-maintainer repository, and its Teams/Enterprise capabilities are per-user paid supersets of the open-source Community edition. Rejected on **runtime and operational footprint**, not capability. |
| **Liquibase** (category C) | **Valid but a poor fit, with a licensing consideration.** Same JVM footprint argument. Additionally, **from version 5.0 Liquibase Community is licensed under FSL-1.1-ALv2** — source-available with delayed Apache-2.0 conversion — a materially different posture from the MIT and Apache-2.0 licences elsewhere in this stack, and worth the owner's deliberate attention rather than a silent adoption. |
| **Atlas** (category C) | **Valid but a poor fit, and partly unverified.** A standalone Go binary is a second runtime to install and pin; a free Starter tier exists with paid Pro and Enterprise tiers above it, and **the community edition's exact licence could not be confirmed** and is flagged for verification. Rejected on **footprint and unresolved licensing evidence**. |
| **Sqitch** (category C) | **Valid but a poor fit.** A Perl toolchain, for the same footprint reason. Carried as a category representative; no further evidence gathered, because the footprint burden weighs against the category as an evaluation factor. |
| **Prisma Migrate / `drizzle-kit`** (category E) | **Technically possible, but a poor fit under the accepted architecture — and explicitly not impossible.** `ADR-014` classified both as **narrowing** `DDM-10`, never foreclosing it, and recorded that externally managed and plain-SQL migration workflows are documented and supported by Prisma. The objection is specific: each generates migrations from a **schema declaration**, and the accepted Kysely architecture has none — so adopting either means **introducing a second schema source of truth**, failing a REQUIRED criterion. That is a poor fit, not an impossibility. |
| **Deferring `DDM-10` again** | **Rejected.** `P1` cannot proceed and `RC-1` cannot be met without a mechanism for creating a schema. The next deferral would be resolved by whoever writes the first persistence pull request — `IR-1` exactly, and the same ground on which `ADR-014` rejected further deferral. |

## Consequences

Stated for the **accepted decision** (2026-09-14).

**Positive:**

- A mechanism exists for bringing a schema into being, unblocking the later `C9` and `P1` work.
- **No additional migration-specific dependency** is required beyond Kysely itself (not yet
  installed; installation is not authorized by this ADR).
- Ordering enforcement, database-level locking and applied-history tracking come from a maintained
  library rather than from bespoke code.
- **The runtime driver/client and dialect decisions stay deferred** without earlier migration-side
  `pg` coupling. (`node-pg-migrate` would add that coupling and pressure toward reusing `pg`, but
  would not select the runtime driver, and a two-client configuration would remain possible; the
  `Migrator` too will need a dialect and driver when implemented.)
- SQL remains available as an authoring format, so the schema source of truth is unchanged.

**Negative:**

- **The migration history becomes coupled to Kysely.** This is the decision's principal cost,
  and `node-pg-migrate` would not incur it.
- The CLI is non-core; either an additional optional package or programmatic invocation is needed,
  and the optional package's current peer range excludes the `0.30` line.
- `kysely` is **pre-1.0 by version number**, with the maintenance attention that implies.
- **Schema drift is not solved** — the describing interface must still be kept in step by hand.

**Reversibility: moderate to good.** Because migrations may be authored as raw SQL and the
resulting database is standard PostgreSQL, replacing the mechanism later means re-pointing a runner
at an existing schema and carrying forward an applied-history record — the database survives
untouched. Reversibility is **best** where migrations are authored as SQL and **weakest** where they
lean on the schema builder; since this ADR **does not decide the authoring format**, the position on
that spectrum is determined later, deliberately.

**Decisions left open — none of these is settled by accepting this ADR:**

| Deferred matter | State |
|---|---|
| PostgreSQL driver / client | **Unresolved and unselected** — neither `pg` nor Postgres.js nor any other |
| Kysely dialect / adapter | **Unresolved and unselected** |
| Application connection pool; external pooler | **Unresolved and unselected** |
| `DDM-2`–`DDM-9` | **All unresolved** |
| Migration contents; any table, column, key, constraint, index | **Unresolved; none appears in this document** |
| Migration authoring format | **Open** — the selected facility permits several; none is chosen |
| Migration execution environment and timing | **Unresolved** — startup, deployment, CI, workstation and dedicated-job postures are all unselected |
| Rollback / down-migration **policy** | **Unresolved** — capability is not policy |
| PostgreSQL version; DigitalOcean region, tier, sizing; provisioning | **Unresolved; no provisioning authorized** |
| Credentials, secrets, environment variables | **Unresolved** |
| CI database infrastructure; database-test mechanism | **Unresolved** |
| Coverage, testing depth, `DG-4` | **Unresolved and untouched** |

## Assumptions

| Assumption | If it is wrong |
|---|---|
| The directory is small at first release (`PA-1`), and migration volume is modest | Migration tooling ergonomics matter more; a dedicated tool's workflow features gain weight and `node-pg-migrate`'s argument strengthens |
| One maintainer, for whom added dependencies and second toolchains are a real cost | With a larger team, a migration tool independent of the access library becomes relatively more valuable |
| Kysely remains the accepted access approach | If `ADR-014` were ever superseded, the coupling cost above is realised and this ADR should be revisited with it |
| SQL remains an available authoring format under the selected mechanism | The portability argument in *Reversibility* weakens substantially |
| `C9` remains the sole data-access path | Unchanged from `ADR-014`; its reversibility bound applies here too |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **Acceptance is read as implementation authorization** | A package is installed, a driver chosen, or a schema created on this document's strength | The header callout. Acceptance puts a **mechanism decision** in force and **nothing more**; installation, driver/dialect/pooler selection, schema, migrations, provisioning and CI each remain separate later work units |
| **The describing interface drifts from the actual schema** | Type safety becomes a false assurance — `ADR-014`'s named principal risk | Inherited, not solved. **No drift-detection mechanism is selected here**; that is a later, separate decision |
| **A tool's requirements settle the deferred driver question** | `ADR-014`'s deliberate deferral is decided by momentum — `IR-1` | Driver coupling is analysed above as an explicit criterion. **No driver or dialect is selected by this ADR** |
| **A duplicate schema source of truth is introduced** | Two artifacts describe one schema and diverge | Made a REQUIRED criterion; category E is not recommended precisely on this ground |
| **Migrations are applied out of order** | Silent, severe schema corruption | Both finalists enforce ordering by default; a hand-written runner is not recommended partly for this reason. **No naming convention is imposed beyond what the selected candidate implies** |
| **Concurrent migration execution** | Duplicate or interleaved application | Both finalists provide database-level or advisory locking. **Where migrations run remains unselected**, so this is recorded as a capability |
| **Tool abandonment** | Maintenance falls to this project | Currency was verified on 2026-09-13 and is flagged for revalidation. `postgres-migrations` is excluded on exactly this evidence |
| **Coupling of migration history to the access library** | Replacing Kysely later leaves migrations in a departed idiom | Stated as the decision's principal cost, not minimised; raw SQL authoring remains available, and the format is deliberately **not** decided here |
| **Mutable facts treated as pins** | A beta or alpha line installed on this document's authority | Every version figure is dated, non-normative evidence; *Facts requiring revalidation* names what must be re-checked |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **PostgreSQL driver / client** | Driver coupling is analysed as an **evaluation criterion**; no client is selected, and the decision is made partly *because* it avoids earlier migration-side `pg` coupling and pressure, while the future driver decision remains to be made |
| **Kysely dialect / adapter** | Named as the deferred mechanism by which a connection is later obtained; none chosen |
| **Connection pool; external pooler** | Not discussed as a selection; no pool, size, configuration or pooler appears |
| **`DDM-2`** — identity strategy | No identifier carrier, UUID, sequence or natural key appears |
| **`DDM-3`** — category representation | Untouched; blocked upstream by `OQ-5` |
| **`DDM-4`** — indexing and text-search strategy | No index or search implementation appears; blocked upstream by `OQ-4` |
| **`DDM-5`** — location normalisation | Untouched |
| **`DDM-6`** — physical separation of non-public attributes | Untouched; the `S-2` obligation is unchanged and its mechanism unselected |
| **`DDM-7`** — audit-entry storage | Untouched; blocked upstream by `OQ-14`/`NOQ-8` |
| **`DDM-8`** — revision storage | Untouched; no table, pointer, copy or history shape appears |
| **`DDM-9`** — publication state, retention and purge | Untouched; no status value, flag, timestamp or structure appears |
| **Migration contents** | **This document contains no SQL and no schema example of any kind**, deliberately |
| **Migration authoring format** | Recorded as **partially inseparable** from the candidate and left open where the candidate leaves it open; no rule is imposed that migrations must take any one form |
| **Rollback / down-migration policy** | Tool **capability** is compared; **policy** is recorded as a repository gap and left unresolved |
| **Migration execution environment and timing** | Startup, deployment, CI, workstation and dedicated-job postures are treated as **capabilities**; none is selected |
| **CI database infrastructure** | None selected; future CI compatibility is a *nice-to-have* criterion only |
| **`DDM-1`'s operational remainder** | No provisioning, account, cluster, region, tier, sizing or PostgreSQL version |
| **`ADR-010`'s outstanding obligations** | Provider-capability validation, the independent off-provider copy and the restore rehearsals remain **outstanding and undischarged**; and `ADR-010` is expressly recorded as imposing no constraint on this candidate set |
| `DG-3`, `DG-4` | No authentication, credential, session, coverage, testing-depth or release-readiness decision |

## This ADR selects nothing else

**Accepted**, this ADR selects **no** PostgreSQL driver or client — **neither
`pg` / node-postgres, nor Postgres.js, nor any other**; **no** Kysely dialect or adapter; **no**
application connection pool, pool size, pool configuration, connection string, connection method or
TLS configuration; **no** external pooler, PgBouncer configuration or hosted pooling. It selects
**no** physical schema, table, table name, column, column type, primary-key representation, foreign
key, constraint, index, unique constraint, timestamp column, nullability or database-enforced
invariant implementation; **no** identity, UUID or sequence strategy, category representation,
location normalisation, revision-table shape, publication-state representation, audit storage or
delete/purge representation (`DDM-2`–`DDM-9`); and **no migration content and no SQL of any kind**.

It selects **no** migration execution environment and **no** execution timing — **not** at
application startup, **not** during Render deployment, **not** from CI, **not** from a workstation,
and **not** from a dedicated deployment job. It establishes **no** rollback or down-migration
policy. It selects **no** PostgreSQL version; **no** DigitalOcean region, tier, plan, sizing,
account, billing or cluster, and **authorizes no provisioning**; **no** credential, secret, secret
name or environment variable; **no** Render configuration or database-connectivity implementation;
**no** backup mechanism, independent-copy destination, tooling or schedule; **no** database or
integration-test infrastructure, container technology, Docker image or CI database service; **no**
coverage provider, coverage threshold or testing-depth policy (`DG-4`); **no** authentication
mechanism; **no** search implementation; and **no** package version — **nothing is installed**, no
`package.json` or `package-lock.json` change is made, and **no file under `src/` is created or
modified**.

`DDM-2`–`DDM-9` remain **unresolved**. **`DDM-10` is resolved by this `Accepted` ADR through the
selection of Kysely `Migrator`** — and by nothing more. `DG-2` remains **`Resolved`** (2026-08-27, issue #93) and is not reopened. `DG-4`
remains **`Unresolved`**. **No accepted ADR is amended, reopened or superseded** — `ADR-014` in
particular is relied upon, not modified. No physical schema, index, migration or infrastructure
resource exists, and **no persistence implementation exists**.

## Mutable-fact verification

**Verification date: 2026-09-13.** External facts above were verified against authoritative current
sources on that date and are **decision-time evidence, explicitly non-normative**. They must be
**re-verified before any implementation**, per the discipline `ADR-012`, `ADR-013` and `ADR-014`
established. **`ADR-014`'s 2026-09-09 external research was not relied upon for any mutable fact
here**; `ADR-014` is relied upon only for accepted architectural interpretation.

Three classes of statement are kept distinct: **repository decision facts** (cited to their ADR or
document), **externally verified current facts** (in *Current external facts*), and **analysis and
inference** (the comparison, the criteria weighting and the recommendation). No inference is
presented as an official product guarantee, and no service-level commitment is asserted for any
product or vendor. Where a fact could not be confirmed it is **marked as requiring verification
rather than asserted** — see *Facts requiring revalidation before any implementation*.

Sources consulted:

- npm registry package metadata — `kysely`, `kysely-ctl`, `node-pg-migrate`, `postgres-migrations`,
  including version, licence, `engines`, module type, dependency and peer-dependency fields and
  publication history.
- Kysely official documentation — the migrations guide.
- `node-pg-migrate` official documentation — the getting-started and CLI references.
- Redgate Flyway official product documentation and the Flyway editions page.
- Liquibase official licensing and editions material.
- Atlas official pricing and licensing pages.

## Owner-decision status and lifecycle

**Status: `Accepted`. In force since 2026-09-14.**

**Owner acceptance has occurred.** The product owner ruled on **2026-09-14** that **Kysely Migrator
is selected as the migration and schema-evolution tooling approach for `DDM-10`**, through the
separate governed acceptance work unit recorded on **issue #121**, following this document's
`Proposed`-stage publication and the mandatory detailed owner review of it. The owner could have
selected any candidate compared here; the rejection rationale is preserved in full so that the
argument survives the ruling (`IR-6`).

| | |
|---|---|
| **Proposal** | Published as `Proposed` **2026-09-13** — issue **#119** (`architecture: decide migration and schema-evolution tooling for PostgreSQL (DDM-10)`); pull request **#120** (`docs: propose ADR-015 Kysely Migrator for PostgreSQL migrations`), merged 2026-09-14 |
| **Owner decision** | **Kysely Migrator**, ruled **2026-09-14** |
| **ADR status** | **`Accepted`** — in force; authoritative for `DDM-10` |
| **Acceptance issue** | **#121** — `architecture: accept ADR-015 Kysely Migrator for PostgreSQL migrations` |
| **Acceptance pull request** | **#122** — `docs: accept ADR-015 Kysely Migrator for PostgreSQL migrations` |

**The two-stage lifecycle applied**, per the `ADR-005` (issue #89 / PR #90, then issue #91 / PR
#92), `ADR-013` (#101 / #102, then #103 / #104), `ADR-012` (#105 / #106, then #107 / #108) and
`ADR-014` (#115 / #116, then #117 / #118) precedent.

**What acceptance put in force, and what it did not.** Acceptance puts the **migration and
schema-evolution mechanism decision** in force and **nothing more**. It **installs nothing** — not
Kysely and not Kysely `Migrator` — and authorizes **no** dependency installation, **no** migration,
**no** schema, **no** persistence implementation, **no** driver/client, dialect, pool or pooler
selection, **no** provisioning and **no** CI database infrastructure; each remains a separate later
work unit requiring its own owner authorization.

## Traceability

| | |
|---|---|
| **Deferred decision** | **`DDM-10`** (`docs/08-data-model.md`) — **resolved by this `Accepted` ADR** (2026-09-14, issue #121) through the selection of Kysely `Migrator`. `DDM-2`–`DDM-9` remain unresolved |
| **Requirements** | `NFR-DATA-01`, `NFR-DATA-02`, `NFR-DATA-03`, `NFR-DATA-06`; `NFR-MAINT-03`; `NFR-REL-04` — as constraints the later implementation must satisfy, **none proven here** |
| **Journeys** | `V1`–`V7`, `L1`–`L4`, `A3`–`A7` — served transitively through `C9`; none implemented here |
| **Components** | **`C9`** — Listing Repository (`docs/07`; `ADR-002` `O-1`). `C4`–`C8` are unaffected |
| **Invariants** | `DI-1`–`DI-11`, `BI-7`, `BI-8` — this decision breaches none and **proves none** |
| **Fed by** | `ADR-002` (ruling `R-A`), `ADR-003`, `ADR-005`, `ADR-006`, `ADR-010`, `ADR-012`, `ADR-013`, **`ADR-014`** — all `Accepted`, none amended |
| **Documents amended** | **At the earlier `Proposed` stage (issue #119, PR #120):** this file (new), `docs/adr/README.md` (register row) and `docs/traceability-matrix.md` (register row) — the `Proposed`-stage surface established by `ADR-013` (PR #102) and followed by `ADR-014` (PR #116). **At acceptance (issue #121), by owner ruling on the acceptance file surface:** this file, `docs/adr/README.md` (the `ADR-015` register row and the derived decisions-in-force count, recalculated from nine to ten), `docs/traceability-matrix.md` (the `ADR-015` row), `docs/08-data-model.md` (the `DDM-10` row only), `docs/13-decision-log.md` (only wording acceptance makes false) and `src/data/README.md` (a minimal, documentation-only correction). **`docs/07`, `docs/11`, `docs/12`, `CONTRIBUTING.md` and every earlier `Accepted` ADR are deliberately untouched**, and historical `ADR-013` / `ADR-014` register and traceability rows are preserved as ADR-scoped records. **No gate is marked `Resolved`** |
| **Issue / pull request** | **Proposed:** issue **#119**; pull request **#120**, merged 2026-09-14. **Accepted:** issue **#121** — `architecture: accept ADR-015 Kysely Migrator for PostgreSQL migrations`; acceptance pull request **#122** |
