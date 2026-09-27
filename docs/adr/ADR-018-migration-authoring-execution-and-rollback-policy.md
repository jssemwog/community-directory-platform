# `ADR-018` — Decide the migration authoring format, invocation mechanism, execution environment and rollback policy for Kysely `Migrator` (`ADR-015`'s outstanding items)

| Field | Value |
|---|---|
| **Status** | **`Proposed`** |
| **Date** | 2026-09-27 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Has not ruled.** This document records the proposal put to the owner, not a ruling. |
| **Decision gate** | *none* — `DG-2` is **`Resolved`** (2026-08-27, issue #93) and this ADR is **not** one of its constituents. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision. |
| **Related open questions** | **Depends on:** nothing unresolved. `ADR-002`, `ADR-003`, `ADR-005`, `ADR-010`, `ADR-012`, `ADR-013`, `ADR-014`, `ADR-015`, `ADR-016` and `ADR-017` are all **`Accepted`** and supply every constraint this decision must satisfy. **Must NOT answer:** **`DDM-2`**'s identity-generation locus, **`DDM-3`**, **`DDM-4`**, **`DDM-5`**, **`DDM-7`**, and every remaining `DDM-6`, `DDM-8` and `DDM-9` outstanding item; `OQ-4`, `OQ-5`, `OQ-12`, `OQ-14`/`NOQ-8`, `NOQ-9`; **provisioning**, **PostgreSQL version**, **region**, **tier**, **sizing**, **TLS**, **credentials**, **secrets**, application **pool configuration** and any **external pooler**; **purge scheduling and execution**; `DG-3`, `DG-4` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **`Proposed`, and therefore NOT in force.** Per `docs/adr/README.md`, a `Proposed` ADR is
> *"Drafted and under review. The decision is **not yet in force**; nothing may depend on it."*
> **This document does not accept itself.** The policy below is the proposal put to the Product
> Owner under issue **#153**; it becomes an architectural decision only through the **separate
> governed acceptance step** that `ADR-005` (#89 / #90, then #91 / #92), `ADR-012`, `ADR-013`,
> `ADR-014`, `ADR-015`, `ADR-016` and `ADR-017` each passed through. **Nothing here authorizes
> installation, a file, a script, a directory, a schema, a migration or any other
> implementation.** The Product Owner direction recorded under *The proposed policy* defines
> **what is being proposed**, not what has been decided.

---

## Context

**`ADR-015` (`Accepted` 2026-09-14, issue #121) selected the migration mechanism and deliberately
left five policy items open.** It selected **Kysely's built-in `Migrator`** for `DDM-10`, together
with the ordering model inseparable from it, and recorded — in its own words — that the following
"must not be read as settled by this acceptance": the **authoring format**; whether **`kysely-ctl`**
is adopted or the `Migrator` invoked **programmatically**; **rollback / down-migration policy**;
**migration execution environment and timing**; and **migration contents**. `docs/08-data-model.md`'s
`DDM-10` row, `src/data/README.md` and `docs/traceability-matrix.md` each record those same five
items as outstanding, in the same words. **This ADR exists to close that residue as one unit.**

**`ADR-015` also recorded three repository gaps as gaps**: no rollback / down-migration policy
exists anywhere in the repository; no development-time migration workflow is established; no
deployment-time migration workflow is established. None has been filled since.

**What has changed since `ADR-015` was accepted.** `ADR-016` (`Accepted` 2026-09-15, issue #125)
selected **`pg` (node-postgres) through Kysely core `PostgresDialect`**, closing the driver and
dialect question `ADR-014` and `ADR-015` had both left open. Issue #129 / PR #130 then **installed
the governed runtime dependencies** — `kysely` **0.29.6** and `pg` **8.23.0** (`package.json`,
`package-lock.json`). `ADR-017` (`Accepted` 2026-09-17, issue #137) selected the **physical listing
data design** `PS-1`–`PS-11`, discharging `DDM-2`, `DDM-6`, `DDM-8` and `DDM-9` with named
outstanding items and **authorizing no implementation**. PR #152 (issue #151) reconciled the `C9`
boundary document with those facts.

**What has not changed.** **The repository contains no migration, no migration directory, no
schema, no runner, no Kysely configuration, no connection configuration and no persistence
implementation.** `src/data/` holds only its boundary README; no module under `src/` imports
`kysely` or `pg`; `package.json` declares no database script; `.github/workflows/ci.yml` runs
`npm ci` and `npm run build` with `contents: read`, no services and no secrets. **No database is
provisioned** — `ADR-013` authorizes no account, cluster, region, tier, sizing or PostgreSQL
version, and none exists.

**Why the decision is taken now, and why it is only a decision.** The next persistence work unit
is scoped against `src/data/README.md`, and the first thing it will need is a migration regime.
Deciding the regime **before** any file exists is the only moment at which the decision is free:
once a runner, a directory layout or a first migration exists, the policy has been made by
whoever wrote them. `ADR-017` makes the same point from the other side — reversal is cheapest
*before the first migration*, at zero data volume. Equally, **a policy decision is not
implementation**: this ADR writes down the rules and creates nothing.

**Requirements and obligations this decision answers to.** `NFR-REL-02` (99% availability over a
rolling monthly window, single-instance posture per `ADR-010`); `NFR-BACK-01`–`NFR-BACK-06` (at
least daily backups, recovery finer than the backup interval, RPO ≤ 24 hours, RTO one business
day, equivalent protection for every copy, restore rehearsed before launch and quarterly, and at
least one recoverable copy independent of the primary provider as amended by ruling `R1`);
`NFR-DATA-02` and `NFR-DATA-03` (revision integrity and transactional completeness, which `C9`
owns); `NFR-MAINT-03` (core behaviours covered by automated tests sufficient to detect
regressions); `NFR-SEC-08` and `docs/07` `R-10` (no browser-direct datastore access);
`PA-1` (the directory is small at first release) and `NFR-MAINT-03`'s single-maintainer reality.

## Decision question

**Within the `Accepted` Kysely `Migrator` mechanism, what does the project's first governed
migration unit contain; in what form are migrations authored; how is the `Migrator` invoked;
where and when do migrations run; and what is the rollback posture?**

Five questions, **one decision unit.** They are inseparable in the strict sense the template
requires: the authoring format determines what an invocation entry point must load; the
invocation mechanism determines what can be run in a given environment; the execution posture
determines whether a `down` migration is ever reachable; and the contents boundary determines
which of the four is exercised first. Deciding any one alone produces a regime whose other
halves are then settled by default — which is precisely the failure `docs/adr/README.md` names
as *an ADR answering an open question implicitly*.

## Accepted architecture taken as fixed input

| Fixed input | Source | What it fixes here |
|---|---|---|
| PostgreSQL under a managed operating posture | `ADR-003` (Accepted) | The engine every migration targets |
| DigitalOcean Managed PostgreSQL as the named provider; **provisioning authorized by nothing** | `ADR-013` (Accepted) | The eventual production target — **which does not exist yet** |
| Kysely as the `C9` data-access approach; no duplicate schema source of truth | `ADR-014` (Accepted) | Migrations may not introduce a second schema declaration |
| Kysely's built-in `Migrator`; alpha-numeric ordering by migration name, order-enforced by default; its locking and transaction facilities | `ADR-015` (Accepted) | The mechanism, and the `up`/`down` file shape |
| `pg` through Kysely core `PostgresDialect` | `ADR-016` (Accepted) | The client a migration connection would use |
| Physical listing design `PS-1`–`PS-11`, with named outstanding items and **no implementation authority** | `ADR-017` (Accepted) | What a later first schema migration would eventually express |
| Render, long-running single-instance Node service | `ADR-005` (Accepted) | The runtime a migration must **not** run inside |
| Backup, recovery and availability posture, with the independent off-provider copy and restore rehearsals **outstanding** | `ADR-010` (Accepted) | The recovery envelope rollback policy must respect and **must not restate** |
| Vitest as the primary implementation-level runner; **no database or integration-test infrastructure selected** | `ADR-012` (Accepted) | Why CI migration validation cannot be decided as an operational workflow here |
| `O-1` server-side access only; `O-2` no browser-direct datastore access | `ADR-002`, `src/data/README.md` | Unchanged, and untouched by this ADR |

## Current external facts

**Verified 2026-09-27 against primary sources, recorded as decision-time evidence.** These are
**not repository decisions, not normative and not version pins**. `ADR-015` flagged both of the
first two rows for revalidation before any implementation; this section discharges that
revalidation obligation and records the result.

| Fact | Value (verified 2026-09-27) | Primary source |
|---|---|---|
| Installed Kysely line | `kysely` **0.29.6**; MIT; `engines.node >=22.0.0`; `"type": "module"` | `node_modules/kysely/package.json` (the installed published package), cross-checked against `package.json` and `package-lock.json` |
| **Migration transaction behaviour** | The option is **`disableTransactions?: boolean`, default `false`** on both `MigrateOptions` and `MigratorProps`. **There is no `transactionMode` option in the 0.29.6 line.** With a dialect whose adapter reports `supportsTransactionalDdl`, `Migrator` opens **one connection, acquires the migration lock, and runs the whole pending batch inside a single transaction**; when transactions are disabled, or the dialect does not support transactional DDL, the batch runs on a single connection under the lock **without** a transaction | `node_modules/kysely/dist/migration/migrator.d.ts` (`MigrateOptions`, `MigratorProps`) and `node_modules/kysely/dist/migration/migrator.js` (the `runWithLock` / `db.transaction().execute(...)` path) |
| PostgreSQL transactional DDL | `PostgresAdapter.supportsTransactionalDdl` returns **`true`**, so the transactional path above is the **default** under `ADR-016`'s selected dialect | `node_modules/kysely/dist/dialect/postgres/postgres-adapter.js` |
| Migration locking | A **session-level PostgreSQL advisory lock** (`pg_advisory_lock`, lock id `3853314791062309107`) taken with `lock_timeout` set to **3,600,000 ms**, released by `pg_advisory_unlock` | `node_modules/kysely/dist/dialect/postgres/postgres-adapter.js` |
| Bookkeeping tables | `kysely_migration` and `kysely_migration_lock` by default, overridable by `migrationTableName` / `migrationLockTableName` / `migrationTableSchema` | `node_modules/kysely/dist/migration/migrator.d.ts` |
| Ordering enforcement | Ascending by migration name (`localeCompare` by default, overridable); order against already-executed migrations enforced unless **`allowUnorderedMigrations`** is set | `node_modules/kysely/dist/migration/migrator.js` (`#getState`, `#ensureMigrationsInOrder`) |
| **`kysely-ctl` peer range** | `kysely-ctl` **0.21.0**; MIT; `engines.node >=22`. **The relevant required peer range is `kysely: >=0.18.1 <0.30.0`, and the installed Kysely 0.29.6 satisfies it.** Its other three peers — `kysely-neon ^2`, `kysely-postgres-js ^2 \|\| ^3` and `kysely-prisma-postgres ^0.1` — are **dialect-specific optional peers** (`peerDependenciesMeta` marks each `optional: true`), so **none of them must be installed**, and none is needed by `ADR-016`'s `pg`-through-core-`PostgresDialect` selection. Its own runtime dependency set is **ten packages**: `c12`, `citty`, `confbox`, `consola`, `jiti`, `nypm`, `ofetch`, `pathe`, `pkg-types`, `std-env` | npm registry package metadata, read read-only via `npm view kysely-ctl version peerDependencies peerDependenciesMeta engines license` and `npm view kysely-ctl --json` (`dependencies`) |

**What the `kysely-ctl` evidence actually shows.** The installed **0.29.6** line **satisfies**
`>=0.18.1 <0.30.0` today — so the peer range is **not** a present-tense obstacle, and this ADR
does not claim it is. Two facts about that range are nevertheless load-bearing: it **excludes the
`0.30` line**, which exists as a beta, so adopting `kysely-ctl` couples the project's Kysely
upgrade path to a second package's release cadence; and the range is a **mutable fact** that must
be re-read at the moment of any future adoption, not inherited from this table.

**Facts deliberately not asserted.** No claim is made about `kysely-ctl`'s behaviour beyond its
published metadata, because it is not the proposed mechanism. No claim is made about Render's
deployment hooks, DigitalOcean's connection limits, or any provider pricing or version support —
none is needed for a policy decision, and `ADR-013` already records provider facts as decision-time
evidence requiring re-verification before provisioning.

## Decision drivers

1. **A decision must not become an implementation by being written down.** `docs/adr/README.md`:
   an ADR records a decision and **does not open a gate**. `CONTRIBUTING.md`: *the ADR merges
   first*, and an issue whose title needs the word "and" is too big.
2. **Reviewability of the actual database operation.** `ADR-014` records schema drift between the
   hand-written describing interface and the real schema as *"this decision's principal risk"*.
   What a reviewer can read is what a reviewer can catch.
3. **No duplicate schema source of truth** — a REQUIRED criterion inherited from `ADR-014`.
4. **Dependency restraint for a single maintainer** (`PA-1`, `NFR-MAINT-03`). `ADR-015` weighed
   Kysely's zero-runtime-dependency footprint explicitly.
5. **Runtime separation.** `ADR-005`'s long-running single-instance service and `NFR-REL-02`'s
   availability target both make an implicit schema change on the request path a liability.
6. **Honesty about what does not exist.** `ADR-015` set the standard: capability is not policy,
   and a workflow nobody has built is not a workflow.
7. **Recovery obligations are already owned elsewhere.** `ADR-010` holds backup, RPO, RTO, the
   independent copy and the rehearsals. A migration policy that restates them dilutes them.

## Considered options

Each dimension is compared on the requirements, not on taste. Rejection rationale is preserved
under `IR-6` so that it cannot be silently re-made.

### 1. Migration contents — what the first governed unit contains

| Option | Assessment |
|---|---|
| **A. Policy only** — this ADR decides the regime; nothing is created | **Proposed.** It is the only option that can be reviewed as a decision rather than as code, it keeps `ADR-017`'s pre-first-migration reversal window open, and it leaves every later unit free to be scoped against a written rule. Cost: the regime is unexercised until the next unit lands, so a mistake in it surfaces one issue later rather than immediately. |
| **B. Infrastructure only** — directory, runner, configuration and an empty or bootstrap migration, in the same unit as the decision | **Rejected for this unit.** It mixes an ADR with the code that depends on it, which `CONTRIBUTING.md` requires to be split with *the ADR merges first*. A bootstrap or no-op migration is also not free: it fixes the directory layout, the naming scheme and the entry point by existing, deciding by artifact what this document is meant to decide by argument. |
| **C. Infrastructure plus the first schema migration** | **Rejected for this unit.** It spans a decision, an infrastructure increment and a physical schema in one review; its title needs "and" twice; and it would require `DDM-2`'s identity-generation locus to be settled mid-flight, because a `DEFAULT gen_random_uuid()` in DDL decides that question silently. `ADR-017` explicitly leaves that locus outstanding. |

**Why the proposal separates three units.** The decision, the infrastructure and the first schema
migration each have a different failure mode — a wrong *rule*, a wrong *mechanism*, and a wrong
*schema* — and each is caught by a different kind of review. Collapsing them means the schema
review carries the policy argument, which is how policy gets approved by inattention.

### 2. Authoring format — within the `up`/`down` shape the `Migrator` makes inseparable

| Option | Assessment |
|---|---|
| **A. Kysely schema builder as the default** | **Rejected as the default.** Most idiomatic and the most pleasant to write, but it writes the migration history in Kysely's idiom — the coupling `ADR-015` accepted as its **principal cost** — and it puts a layer between the reviewer and the DDL that actually executes. It also cannot express every PostgreSQL construct a real schema needs, so a raw-SQL escape hatch would be required anyway; a default that needs an exception on its first hard case is not the default. |
| **B. Raw PostgreSQL DDL through the `sql` tag as the default** | **Proposed as the default.** The reviewer reads the statement the database will run, which is the most direct answer available to `ADR-014`'s named drift risk; PostgreSQL expressiveness is preserved in full; and the migration history stays readable if the access approach is ever replaced — a partial mitigation of the coupling cost `ADR-015` accepted and did not minimise. Cost: no compile-time help inside the SQL string, and more care needed over identifier quoting. |
| **C. Governed hybrid — raw SQL default, schema builder by narrow exception** | **Proposed.** Option B's default plus a written exception: the schema builder is permitted **only** where it expresses the intended PostgreSQL operation *more clearly* without weakening or obscuring its semantics. This is the only option that states where each form belongs, and stating it is what keeps a hybrid from decaying into two competing conventions. |
| **D. Ordinary application queries as an authoring format** | **Rejected as a default.** Available under the mechanism and occasionally necessary for a data backfill inside a migration, but as a *default* it invites application-shaped code into schema evolution and blurs which statements are structural. |

**The `up`/`down` TypeScript function shape is not a choice.** `ADR-015` records it as inseparable
from the selected mechanism: a migration module exports `up` and `down` taking a Kysely instance.
The proposal is about what goes *inside* those functions.

**The two forms must not become competing schema sources of truth.** One migration expresses one
intent in one form; the hybrid is a per-operation choice governed by the exception rule above,
never a parallel schema declaration.

### 3. Invocation mechanism

| Option | Assessment |
|---|---|
| **A. `kysely-ctl`** | **Not selected.** Ready-made commands and scaffolding, MIT, actively published, and its peer range **does** admit the installed 0.29.6 line (verified 2026-09-27). **Its three dialect peers are optional and impose no installation burden** (verified 2026-09-27), so compatibility is not the issue. It is not selected because it introduces a **separate CLI and configuration surface** for a project with one maintainer and no migrations, to reach a facility that is already **in core**; because that CLI brings **ten runtime dependencies** of its own (`c12`, `citty`, `confbox`, `consola`, `jiti`, `nypm`, `ofetch`, `pathe`, `pkg-types`, `std-env`); and because its required peer range, which **currently admits Kysely 0.29.6**, **excludes the `0.30` line**, coupling the Kysely upgrade path to a second package's cadence. **It remains a legitimate later option**, separately governed, and this rejection is a cost-and-coupling judgement, not a quality claim. |
| **B. A repository-owned programmatic entry point using core `Migrator` and `FileMigrationProvider`** | **Proposed.** Zero new dependencies; no peer-range coupling; the entry point is ordinary repository TypeScript, reviewed like any other file and type-checked by the mechanism `ADR-012` already records (`next build`); and it makes the separation in item 4 enforceable, because the project owns the only place the `Migrator` is constructed. Cost: the project writes and maintains that entry point, and any scaffolding convenience it wants. |
| **C. Defer invocation entirely** | **Rejected.** It would leave the authoring format decided with no stated way to run anything, which is the half-a-regime outcome this ADR exists to avoid. Deferring the *mechanism* is different from deferring the *environments*, which item 4 does deliberately. |

**A programmatic entry point is not the hand-written runner `ADR-015` rejected.** That rejection
was of a **bespoke migration engine** — hand-built ordering enforcement, applied-history table,
advisory locking and failure semantics, each a silent-failure surface. All four remain the core
`Migrator`'s, verified above. What the project owns is the call site.

**This ADR creates no entry point.** The file, its location, its name, its argument handling and
any `package.json` script are **later, separately authorized implementation work**.

### 4. Execution environment and timing

| Option | Assessment |
|---|---|
| **A. Implicit execution at application startup / module load / server initialization / on the request path** | **Rejected, and prohibited by the proposed policy.** Under `ADR-005`'s long-running single-instance service this would run schema changes on every restart, inside the process that must stay available to `NFR-REL-02`, at a moment nobody chose; a failure there is an outage rather than a failed command; and with Next.js module loading, an import is enough to make it happen by accident. The prohibition is cheap to state now and expensive to retrofit once persistence modules exist. |
| **B. Explicit developer invocation for local development** | **Proposed as the first authorized execution shape** — a separately invoked process, run deliberately against an intentionally selected local or personal PostgreSQL target. It is the only environment that exists today. |
| **C. CI validation** | **Recorded as outstanding, not decided.** Applying migrations against a throwaway database in CI is feasible and desirable, but today's pipeline has `contents: read`, no services and no secrets, and `ADR-012` selects **no database or integration-test infrastructure** — which is `DG-4`'s neighbourhood. Deciding a CI workflow here would claim infrastructure that does not exist. |
| **D. Deployment / release execution**, **E. A dedicated production job** | **Recorded as outstanding, not decided.** No database is provisioned, no connection configuration or secret exists, there is no deployment configuration of any kind, and `ADR-010`'s provider-capability validation must be re-verified **before** provisioning. Production execution authority and credentials belong to the provisioning and deployment units, and are named here as their prerequisite rather than pre-empted. |

**Nothing in this section describes an existing workflow.** There is no local workflow, no CI
migration validation and no production execution path today, and the proposed policy says so in
those terms.

### 5. Rollback / down-migration policy

| Option | Assessment |
|---|---|
| **A. `down` migrations mandatory and tested** | **Rejected.** `ADR-015` deliberately did **not** promote rollback support to a REQUIRED criterion, and no repository document establishes it. Worse, a mandatory `down` for a destructive change is a promise the mechanism cannot keep: a `down` that recreates a dropped column cannot return the data it held. Mandating one manufactures confidence rather than recovery. |
| **B. Forward-only correction as the default, with an honest `down` where reversal is genuinely safe, complete and honest** | **Proposed.** The standard remedy for a bad migration becomes a new, reviewed, forward migration — the same path every other change takes — while genuine reversibility is still captured where it exists. Data recovery stays where `ADR-010` already put it. Cost: no single uniform "roll back one step" story, and each `down` requires a judgement about whether it is honest. |
| **C. Prohibit `down` migrations outright** | **Rejected.** The `up`/`down` shape is inseparable from the mechanism, so a `down` exists structurally in every file; prohibiting a *correct* reversal throws away real value — an additive migration reversed at zero data cost is the cheapest fix available — for tidiness. |

**Destructive and irreversible changes.** The proposal requires **separate explicit
authorization** plus a **documented safeguard and recovery assessment against `ADR-010`'s existing
obligations**. That assessment *reads* `ADR-010`; it does not extend it. **No backup, recovery,
independent-copy or restore-rehearsal policy is created, widened or reinterpreted here**, and
`ADR-010`'s outstanding items — the independent off-provider copy and the pre-launch and quarterly
restore rehearsals — remain exactly as `ADR-010` and `ADR-013` record them.

## The proposed policy

**This is the Product Owner direction recorded under issue #153, stated as the proposal under
review. It is not in force.**

### 1. Migration-contents boundary

- **`ADR-018` is decision-only.**
- After acceptance, **migration infrastructure requires a separate issue**.
- **The first schema migration requires another, later, separate issue.**
- `ADR-018` **authorizes no migration directory, runner, configuration, script, bootstrap or
  no-op migration, and no schema migration**.
- **`DDM-2`'s identity-generation locus** — application-generated identity versus a database
  default — **must be decided before the first schema migration is authorized**, and
  **`ADR-018` does not decide it**.

### 2. Authoring-format policy

- Migrations use **Kysely's required TypeScript `up`/`down` migration-function shape**.
- The policy is a **governed hybrid**.
- **Raw PostgreSQL DDL expressed through Kysely's `sql` tag is the default**, because it exposes
  the actual database operation for review and preserves PostgreSQL expressiveness.
- **Kysely's schema builder is permitted only** where it expresses the intended PostgreSQL
  operation **more clearly without weakening or obscuring its semantics**.
- **The two forms must not become competing schema sources of truth.**
- **Ordinary application queries are not the default** migration-authoring format.

### 3. Invocation mechanism

- Select a **repository-owned programmatic entry point** using Kysely's **core `Migrator`** and
  **`FileMigrationProvider`**.
- **Do not select or install `kysely-ctl`.**
- **`kysely-ctl` remains documented as a later, separately governed alternative.**
- **This `Proposed` ADR itself creates no runner, script, configuration or dependency.**

### 4. Execution environment and timing

- The **first authorized execution shape is explicit developer invocation** against an
  **intentionally selected local or personal PostgreSQL target**.
- **CI validation remains outstanding** until separately governed test infrastructure exists.
- **Production execution, deployment integration, credentials and authority remain outstanding**,
  pending provisioning and deployment governance.
- **Migrations must never execute implicitly during:**
  - **application startup;**
  - **Next.js module loading;**
  - **server initialization;**
  - **ordinary request handling.**
- **A migration entry point must be separately invoked and must not be imported by the
  application server.**
- **No local, CI or production migration workflow currently exists, and this policy claims
  none.**

### 5. Rollback / down-migration policy

- **Forward-only corrective migrations are the default recovery path.**
- A **`down` migration may be written only where reversal is genuinely safe, complete and
  honest**.
- A **`down` migration must not imply that lost or transformed data can be restored when it
  cannot**.
- **Destructive or irreversible migrations require separate explicit authorization and a
  documented safeguard and recovery assessment against existing `ADR-010` obligations.**
- **No backup, recovery, independent-copy or restore-rehearsal policy is invented, extended or
  reinterpreted.**

### What this proposal would settle, and what it would not

**It would settle**, on acceptance: the contents boundary across three units; the authoring format
and its exception rule; the invocation mechanism; the first execution shape and the startup
prohibition; and the rollback default.

**It would still leave open:** CI migration validation; production execution, deployment
integration, credentials and authority; the entry point's own file, name and script surface;
migration naming beyond the mechanism's inseparable ascending-name ordering; whether
`disableTransactions` is ever set for a specific migration; `DDM-2`'s identity-generation locus;
and everything under *This ADR selects nothing else*.

## Implementation sequencing

**This sequence is a map, not an authorization. No step below is authorized by this document.**

1. **Propose `ADR-018`** — this document, issue #153.
2. **Review, and separately accept or reject `ADR-018`** through the governed acceptance step.
3. **If accepted**, reconcile the present-tense `DDM-10` and data-boundary status text — the
   `DDM-10` row in `docs/08-data-model.md`, the outstanding-items list in `src/data/README.md`,
   `docs/13-decision-log.md` and the register rows — **as acceptance-stage work, in its own unit**.
4. **Separately authorize migration infrastructure** — the directory, the programmatic entry
   point, and whatever script surface that unit decides.
5. **Decide `DDM-2`'s identity-generation locus** before any schema work.
6. **Separately authorize the first schema migration**, expressing `ADR-017`'s `PS-1`–`PS-11`.
7. **Separately decide or implement CI and production execution** when their test, provisioning,
   deployment and credential prerequisites exist.

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Infrastructure in this unit** (contents option B) | Mixes an ADR with the code depending on it, against `CONTRIBUTING.md`'s *the ADR merges first*; a bootstrap migration decides layout, naming and entry point by existing rather than by argument |
| **Infrastructure plus the first schema migration** (contents option C) | Three failure modes in one review; requires `DDM-2`'s undecided identity-generation locus mid-flight; forecloses `ADR-017`'s cheapest reversal window |
| **Schema builder as the default authoring format** | Writes history in Kysely's idiom — the coupling cost `ADR-015` accepted and did not minimise — and interposes a layer between reviewer and executed DDL; needs a raw-SQL exception on its first hard case anyway |
| **Ordinary application queries as the default format** | Invites application-shaped code into schema evolution and blurs which statements are structural; remains available where a migration genuinely needs a data operation |
| **`kysely-ctl` as the invocation mechanism** | Compatible with the installed Kysely 0.29.6 line, and its three dialect peers are **optional** — so **not rejected on incompatibility**. Rejected on footprint and coupling: a separate CLI and configuration surface to reach a core facility, for one maintainer with no migrations; **ten runtime dependencies** of its own; and a required peer range that admits 0.29.6 but **excludes the `0.30` line**, coupling the Kysely upgrade path to another package's cadence. **Preserved as a legitimate later, separately governed option** (`IR-6`) |
| **A hand-built migration runner** | Already rejected by `ADR-015` on build-and-maintain cost: ordering, applied history, locking and failure semantics are silent-failure surfaces. The proposal does not revisit that — it owns only the call site |
| **Deferring the invocation mechanism** | Leaves a format decided with no stated way to run it; half a regime, settled later by whoever writes the first script |
| **Implicit execution at application startup or on the request path** | Schema change on every restart inside the process `NFR-REL-02`'s availability target depends on; failure becomes an outage; under Next.js module loading, an import is enough to trigger it by accident. **Explicitly prohibited by the proposal** |
| **Deciding a CI migration-validation workflow now** | `ADR-012` selects no database or integration-test infrastructure, today's pipeline has no services or secrets, and the depth question is `DG-4`'s; deciding it here would claim infrastructure that does not exist |
| **Deciding production execution, credentials and authority now** | Nothing is provisioned, no connection configuration or secret exists, no deployment configuration exists, and `ADR-010`'s provider-capability validation must be re-verified before provisioning |
| **Mandatory, tested `down` migrations** | Not a repository requirement (`ADR-015` declined to promote it), and for a destructive change a `down` cannot return the data it dropped — it manufactures confidence instead of recovery |
| **Prohibiting `down` migrations** | The shape is inseparable from the mechanism, and a genuinely reversible additive change is the cheapest fix available; prohibition trades real value for tidiness |

## Consequences

**Positive:**

- The migration regime is written down **before** any artifact exists, so the first persistence
  unit is scoped against a rule rather than authoring one by accident.
- The **reviewable-DDL default** attacks `ADR-014`'s named drift risk at the only point where the
  schema is actually established.
- **No dependency is added**, and no peer-range coupling constrains the Kysely upgrade path.
- The **startup prohibition** closes, at zero cost, the one failure mode that would put schema
  change inside a single-instance always-on service.
- **Forward-only correction** keeps recovery where `ADR-010` owns it, and stops a `down` migration
  from masquerading as a backup.
- Three separate units each get the review their own failure mode needs.

**Negative:**

- Raw-SQL-by-default gives up compile-time help inside migration statements and asks for care over
  identifier quoting.
- A **governed hybrid needs judgement** at each operation; the exception rule is only as good as
  its application in review.
- The project **owns an entry point** it must write and maintain, and forgoes `kysely-ctl`'s
  scaffolding conveniences.
- **No uniform rollback story** — each destructive change carries its own authorization and
  assessment.
- CI and production execution stay **unresolved**, so the regime is unexercised outside a
  developer workstation until their prerequisites land.
- The migration history remains **coupled to Kysely** — `ADR-015`'s accepted principal cost, only
  partially mitigated by raw-SQL authoring.

**Reversibility:** **Good, and best exercised before the first migration.** The authoring default,
the exception rule and the rollback default are policy text and can be revised by a superseding
ADR at any time. The invocation choice is a small owned file; adopting `kysely-ctl` later remains
open. What becomes progressively more expensive is the **authoring default** once a migration
history exists in one idiom — which is exactly why it is proposed now, at zero migrations.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`PA-1`** — the directory is small at first release | Migration duration and lock-hold time become operational concerns; the batch-in-one-transaction default and the advisory-lock timeout would need revisiting, and `disableTransactions` might be needed per migration |
| A **single maintainer** does the migration work (`NFR-MAINT-03`) | With several contributors, `kysely-ctl`'s scaffolding and a stricter naming convention become more valuable; the invocation choice is the first to revisit |
| Migrations are run **deliberately by a person** at this stage | If automation lands earlier than expected, item 4's outstanding items must be decided before that automation, not alongside it |
| The `Migrator`'s verified 0.29.6 transaction and locking behaviour holds for the line in use | A future Kysely line with per-migration transaction modes would change how transactions are configured — **not** whether this policy holds; the facts table must be re-read |
| `ADR-010`'s recovery envelope remains the project's data-recovery answer | A change there would reopen the destructive-migration safeguard requirement, which deliberately points at `ADR-010` rather than restating it |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **A `Proposed` ADR is treated as in force** | Someone creates a migrations directory, a runner or a script on the strength of a draft | The header callout, the policy preamble and *This ADR selects nothing else* each state that nothing is in force and nothing is authorized; the register and traceability rows say `Proposed` |
| **The hybrid decays into two conventions** | Half the history in the builder, half in SQL, with no stated rule applied | The exception rule is narrow and written; review applies it per operation; no parallel schema declaration is permitted |
| **The startup prohibition is bypassed by an import** | A module-load side effect reintroduces implicit migration | The prohibition names startup, module load, server initialization and the request path explicitly, and requires that the entry point not be imported by the application server; the infrastructure unit is where that is enforced and reviewed |
| **A `down` migration is trusted as a recovery mechanism** | Data loss is discovered after a reversal that could not restore it | The policy states that a `down` must not imply restorability; destructive changes require explicit authorization and an `ADR-010`-based assessment |
| **CI and production execution stay outstanding indefinitely** | Migrations are only ever run from a workstation, and production schema change is improvised under pressure | Both are recorded as outstanding **with their named prerequisites** and placed in the sequencing map as steps 4 and 7 |
| **Mutable facts harden into pins** | A recorded version or peer range is treated as a repository commitment | Every external fact carries its source and the 2026-09-27 access date and is marked evidence, not a pin; re-verification is required before any adoption |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`DDM-2`'s identity-generation locus** (application vs database default) | Named as a **prerequisite for the first schema migration** and left undecided; no DDL, no default and no column is written here |
| **`DDM-3`** category representation (`OQ-5`), **`DDM-5`** location normalisation | No table, column or type is named; the proposal authorizes no schema |
| **`DDM-4`** indexing and text search (`OQ-4`, `NOQ-4`) | No index, no search structure, and no statement about either |
| **`DDM-7`** audit-entry storage (`OQ-14`/`NOQ-8`) | Untouched; no audit structure is contemplated |
| **`DDM-6`, `DDM-8`, `DDM-9`** remaining outstanding items | `ADR-017` owns them; this ADR neither resolves nor restates them |
| **`OQ-4`, `OQ-5`, `OQ-12`, `OQ-14`/`NOQ-8`, `NOQ-9`** | None is referenced as an input to any proposed rule; the rules are format, invocation, environment and rollback only |
| **`DG-3`, `DG-4`** | No build-time or release-depth question is answered; CI validation is recorded as outstanding **because** its depth question is `DG-4`'s |
| **Provisioning, PostgreSQL version, region, tier, sizing, TLS, credentials, secrets, pool, pooler** | Production execution and credentials are recorded as **outstanding**, owned by the provisioning and deployment units |
| **Purge scheduling and execution** (`ADR-017` `DDM-9` outstanding) | Not referenced; no scheduled job of any kind is proposed |
| **Backup, recovery, independent-copy and restore-rehearsal policy** | The destructive-migration safeguard **reads** `ADR-010`; it creates and widens nothing |

## This ADR selects nothing else

It creates **no** file other than itself and the two register updates; **no** migrations
directory; **no** migration; **no** runner, entry point or script; **no** Kysely or migration
configuration file; **no** dependency, and it changes **neither** `package.json` **nor**
`package-lock.json`; **no** CI, workflow or deployment change; **no** schema, table, column, key,
constraint, index, enum or extension; **no** connection or pool configuration; **no** credential
or secret; **no** provisioning; **no** integration-test infrastructure; **no** `DDM-2`–`DDM-9`
selection; **no** `OQ-*`, `NOQ-*` or gate resolution; and **no** amendment to `ADR-002`,
`ADR-003`, `ADR-005`, `ADR-010`, `ADR-012`, `ADR-013`, `ADR-014`, `ADR-015`, `ADR-016` or
`ADR-017` — **none of which is amended, reopened or superseded**.

**It leaves the present-tense status text unchanged.** The `DDM-10` row in
`docs/08-data-model.md`, the outstanding-items list in `src/data/README.md` and
`docs/13-decision-log.md` are **accurate while this ADR is `Proposed`** — the five items remain
open until acceptance — and are therefore **untouched at this stage**. Reconciling them is
acceptance-stage work.

## Owner-decision status and lifecycle

**Status: `Proposed`. Not in force. Nothing may depend on it.**

**The two-stage lifecycle applies**, per the `ADR-005` (#89 / #90, then #91 / #92), `ADR-012`,
`ADR-013`, `ADR-014`, `ADR-015`, `ADR-016` and `ADR-017` precedents: publication as `Proposed`
under one issue, then a **separate governed acceptance step** under its own issue. **This
document performs the first stage only.**

**What acceptance would require.** A Product Owner ruling on the five-item package; then, in the
acceptance unit, reconciliation of the present-tense `DDM-10` and data-boundary text, the
register row, the traceability row and `docs/13-decision-log.md` — each only where acceptance
makes a present-tense statement false. **Acceptance opens no gate and authorizes no
implementation**; migration infrastructure and the first schema migration remain separate
authorized units, in that order, with `DDM-2`'s identity-generation locus decided between them.

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-REL-02`; `NFR-BACK-01`–`NFR-BACK-06` (read, not amended); `NFR-MAINT-03`; `NFR-DATA-02`, `NFR-DATA-03`; `NFR-SEC-08` |
| **Journeys** | *none directly* — this is an infrastructure-policy decision behind `C9`; it changes no visitor, listing-owner or administrator journey |
| **Components** | **`C9`** (Listing Repository) — the sole data-access path, whose schema evolution this policy governs. `C1`–`C8`, `C10`–`C12` are unchanged |
| **Invariants** | `DI-1`, `DI-10`, `DI-11` and every other `DI-*`/`BI-*` are **untouched**; no invariant is implemented, weakened or tested here. `O-1` and `O-2` are preserved verbatim in `src/data/README.md` |
| **Deferred decisions** | **`DDM-10`** — its five outstanding items are the subject of this proposal; **`DDM-2`**'s identity-generation locus is named as a later prerequisite and left undecided; `DDM-3`, `DDM-4`, `DDM-5`, `DDM-7` remain open |
| **Fed by** | `ADR-002`, `ADR-003`, `ADR-005`, `ADR-010`, `ADR-012`, `ADR-013`, `ADR-014`, `ADR-015`, `ADR-016`, `ADR-017` — all **`Accepted`**, **none amended** |
| **Documents amended** | **At this `Proposed` stage:** this file (new), `docs/adr/README.md` (register row) and `docs/traceability-matrix.md` (register row) — the `Proposed`-stage surface established by `ADR-013` (PR #102) and followed by `ADR-014`, `ADR-015`, `ADR-016` and `ADR-017`. **`docs/08-data-model.md`, `src/data/README.md` and `docs/13-decision-log.md` are deliberately untouched** — their present-tense text stays true while this ADR is `Proposed`. **No gate is marked `Resolved`** |
| **Issue / pull request** | **Proposed:** issue **#153** — `architecture: propose ADR-018 migration policy for the ADR-015 outstanding items`. **Acceptance:** a separate later issue, not yet created |

## Mutable-fact verification

Every external fact in *Current external facts* was verified on **2026-09-27** against a primary
source — the installed published package's own files and type declarations for Kysely, and npm
registry package metadata for `kysely-ctl`. **They are decision-time evidence with an access
date, not architectural requirements and not version pins**, and each must be re-verified before
any implementation relies on it. This section discharges the two revalidation items `ADR-015`
recorded: the transaction-mode question — **resolved: the 0.29.6 line has `disableTransactions`,
default `false`, and no `transactionMode` option** — and the `kysely-ctl` peer range — **resolved:
`>=0.18.1 <0.30.0`, which the installed 0.29.6 line satisfies**.
