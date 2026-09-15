# `ADR-016` — Select the runtime PostgreSQL driver/client and its Kysely dialect for `C9`

| Field | Value |
|---|---|
| **Status** | **`Accepted`** |
| **Date** | 2026-09-15 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-09-15.** |
| **Decision gate** | *none* — `DG-2` is **`Resolved`** (2026-08-27, issue #93) and this ADR is **not** one of its constituents |
| **Related open questions** | **Depends on:** nothing unresolved. `ADR-003`, `ADR-005`, `ADR-013`, `ADR-014` and `ADR-015` are all **Accepted** and supply every constraint this decision must satisfy. **Must NOT answer:** **`DDM-2`–`DDM-9`**, application **pool configuration**, the **external pooler**, **TLS policy**, **secrets**, **provisioning**, migration **execution environment and timing**, **rollback policy**, `DG-3`, `DG-4` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **`Accepted`, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is
> *"Decided and **in force**. Work may rely on it."* The Product Owner ruled on **2026-09-15**:
> *"I approve Option A: pg (node-postgres) through Kysely's core PostgresDialect for ADR-016."*
> That ruling followed this document's `Proposed`-stage publication (issue **#123**, merged by PR
> **#124** on 2026-09-15) and is placed in force by the separate governed acceptance step recorded
> on issue **#125**. **`pg` (node-postgres) through Kysely core `PostgresDialect` is the selected
> runtime PostgreSQL driver/client and Kysely dialect.**
>
> **No numbered `DDM` is resolved by this ADR.** `DDM-2`–`DDM-9` remain unresolved; `DDM-10`
> remains resolved by `ADR-015`.
>
> **Acceptance is not installation and not implementation authorization.** `pg` is not installed
> and `PostgresDialect` is not configured; no connection code exists. Acceptance selects **no**
> package version, pool configuration, external pooler, TLS policy, secrets or provisioning, and
> authorizes **no** dependency installation, persistence implementation, migration, provisioning or
> CI change — each remains a separate later work unit requiring its own owner authorization.

---

## Context

**`ADR-014` selected Kysely and deliberately did not select the driver underneath it.** Its
*The driver/client is deferred* section records: *"The driver/client remains an implementation-time
deferred choice, and nothing in this ADR should be read as the governance decision 'Kysely means
`pg`.'"* `ADR-015` then selected Kysely `Migrator` and again left the driver open. Every Kysely
query and every `Migrator` run needs a dialect, and every dialect needs a driver, so this is now
the next separately governed persistence decision.

**Why an ADR, when `ADR-014` called it "implementation-time".** The two statements are in
apparent tension, and the tension is resolved deliberately rather than silently.
`CONTRIBUTING.md` treats library and technology selection as ADR-governed, and `ADR-014` went out
of its way to stop an implicit *"Kysely means `pg`"* default. The product owner therefore ruled
(issue #123) that the choice is a **governed technology-selection decision**, recorded here so it
cannot be made inside an implementation pull request. That ruling reclassifies the *governance*
of the choice; it does not reopen or amend `ADR-014`, which is relied upon, not modified.

**No numbered `DDM` owns this decision.** `DDM-1`–`DDM-10` cover the store, physical data design
and migration tooling. The driver descends from owner ruling **`R-A`** (`ADR-002`, which deferred
every *"PostgreSQL client"*) and from `ADR-014`'s deferral. **No `DDM` number is invented.**

## Decision question

**Which PostgreSQL client library, through which Kysely dialect, will `C9` and Kysely `Migrator`
use to connect to PostgreSQL at runtime?**

**The driver/client is the primary choice; the Kysely dialect is named in this same ADR as its
inseparable consequence.** For each finalist exactly one maintained dialect exists, so selecting
the driver determines the maintained dialect path for this architecture. A different, custom or
community dialect would be a separate dependency requiring its own scrutiny.

**Resolved when:** an `Accepted` ADR names the driver package **and** the Kysely dialect it runs
through. **Not resolved by:** installing a package, a code sample, a template default, a pool size,
a connection string, or an implementation pull request that picks one.

**Selecting a driver does not settle the connection architecture.** It does not select pool
configuration, an external pooler, TLS policy, secrets, provisioning, or where and when migrations
run.

## Accepted architecture taken as fixed input

| Input | Source | Implication for this decision |
|---|---|---|
| **PostgreSQL** | `ADR-003` (Accepted) | The driver must speak the PostgreSQL wire protocol |
| **Render**, long-running Node.js web service, single instance | `ADR-005` (Accepted) | *"A continuously running process holds a stable, long-lived connection pool."* Serverless / HTTP / edge adapters are the wrong shape |
| **DigitalOcean Managed PostgreSQL** | `ADR-013` (Accepted) | Ordinary TLS PostgreSQL connectivity; **the superuser role is not available** (as recorded in `ADR-014`) |
| **Kysely** for `C9`, with explicit transaction control | `ADR-014` (Accepted) | The driver must have a maintained Kysely dialect supporting transactions |
| **Kysely `Migrator`**; `DDM-10` resolved | `ADR-015` (Accepted) | The `Migrator` operates through a Kysely instance, so the dialect must support it |
| Node **`>=22.12.0`**; ESM | `package.json`, `tsconfig.json` | The driver and dialect must support this floor and module posture |
| **Server-side access only** | `ADR-002` `O-1`, `O-2` | No browser-direct datastore access; every candidate here is server-side |

**Still open, and not decided here:** `DDM-2`–`DDM-9`; application pool configuration; the external
pooler; migration execution environment and timing; rollback policy; physical persistence
implementation.

## Candidate set

### Finalists

- **A — `pg` (node-postgres), through Kysely core `PostgresDialect`.**
- **B — Postgres.js (`postgres`), through `kysely-postgres-js`.**

### Excluded from the finalist set

A candidate-boundary analysis, **not** a permanent prohibition:

| Category | Why it is not a finalist |
|---|---|
| **Serverless / HTTP / edge PostgreSQL clients** (e.g. `@neondatabase/serverless`) | Designed for function or edge runtimes and often provider-specific. `ADR-014` recorded that such adapters are **the wrong shape** for `ADR-005`'s long-running process and add a hop this architecture does not need |
| **Provider-specific drivers** | DigitalOcean Managed PostgreSQL is ordinary PostgreSQL over TLS; `ADR-014` recorded that **no provider-specific driver is required**. DigitalOcean's management API is not the SQL client |
| **`pg-native`** | An optional native-binding build of `pg`. It adds a compiled dependency and no requirement drives it |
| **Direct driver use bypassing Kysely** | Contradicts `Accepted` `ADR-014` |
| **A custom Kysely dialect** | No requirement demands one; both finalists already have maintained dialects |

## Current external facts

**Verification date: 2026-09-14.** Sources: npm registry package metadata for `pg`, `postgres`,
`kysely-postgres-js` and `kysely`; the official Kysely, node-postgres and Postgres.js
documentation and repositories; and `ADR-014`'s dated DigitalOcean evidence. These are
**decision-time evidence, not repository decisions and not version pins**. **No version is
selected by this ADR, and every fact below must be revalidated before implementation.**

| Fact | A — `pg` + `PostgresDialect` | B — `postgres` + `kysely-postgres-js` |
|---|---|---|
| Driver package | `pg` **8.23.0**, MIT; published 2026-08-08; 249 published versions | `postgres` **3.4.9**, **Unlicense**; published 2026-04-05; 48 published versions |
| Driver dependencies | **6 direct dependencies** (1 optional: `pg-cloudflare`), not all `pg-*` packages, including the built-in pool (`pg-pool`); `pg-types` adds further packages, so the dependency tree is approximately **12–13 packages** | `postgres`: **0 dependencies**. `kysely-postgres-js`: **0 dependencies**. The path therefore needs **two top-level packages** for the driver/dialect integration |
| Driver engines / module | `node >=16`; CommonJS implementation with an **ESM entry point** (`exports` maps `import` to `./esm/index.mjs`) | `node >=12`; `"type": "module"` (ESM-native) |
| Dialect | **`PostgresDialect`, part of Kysely core** — no additional dialect package | **`kysely-postgres-js` 4.0.0**, MIT; published 2026-08-22; repository **`kysely-org/kysely-postgres-js`**; `node >=22`; peers `kysely >=0.29 <1`, `postgres ^3.4` |
| Dialect maintainer | The Kysely project (core) | Published from the Kysely organisation's `kysely-org/kysely-postgres-js` repository (separate package). Its README, after distinguishing itself from Kysely's core PostgreSQL dialect, says: *"Both of these dialects are maintained by members of the Kysely core team and are production ready."* |
| Kysely | `kysely` **0.29.5** (a `0.30.0-beta` line exists); **zero runtime dependencies**; no driver bundled | same |

## Evaluation criteria

Classified per issue #123. **No performance requirement is invented** — the repository establishes
none (`NOQ-1`, `NOQ-4` unresolved).

**REQUIRED:** maintained Kysely integration; Node `>=22.12` compatibility; explicit transactions;
Kysely `Migrator` compatibility; PostgreSQL wire-protocol connectivity; TLS capability; suitability
for the accepted long-running Node runtime; no superuser requirement.

**STRONG PREFERENCES:** first-party / organisation-maintained Kysely integration; maintenance
maturity; operational simplicity; external-pooler compatibility.

**SECONDARY:** dependency footprint; licence posture; API ergonomics; portability / reversibility.

## Detailed comparison

### REQUIRED criteria — both finalists pass

| Criterion | A — `pg` | B — Postgres.js |
|---|---|---|
| Maintained Kysely integration | Yes — core `PostgresDialect` | Yes — organisation-maintained `kysely-postgres-js` |
| Node `>=22.12` | Yes | Yes (the dialect itself declares `node >=22`) |
| Explicit transactions | Yes — `db.transaction()` over a checked-out pool client, with isolation levels | Yes — `db.transaction()` over a dedicated connection, with isolation levels |
| `Migrator` compatibility | Yes — operates through the Kysely instance | Yes — operates through the Kysely instance |
| Wire protocol over TCP | Yes | Yes |
| TLS capability | Yes — TLS options with certificate-verification controls | Yes — TLS options with certificate-verification controls |
| Long-running Node fit | Yes — conventional server-side driver with an in-process pool | Yes — conventional server-side driver with an in-process pool |
| No superuser requirement | None required | None required |

**Neither finalist fails a REQUIRED criterion.**

### Non-discriminating criteria

These are satisfied **equally** by both finalists and **do not favour either**:

- **explicit transaction support — `NON-DISCRIMINATING`**;
- TLS capability;
- Render long-running-service fit;
- DigitalOcean Managed PostgreSQL compatibility;
- PostgreSQL wire protocol;
- `Migrator` compatibility;
- no superuser requirement.

### Transactions

`ADR-014` requires explicit transaction control. With `pg`, Kysely checks a client out of the pool
and issues `BEGIN` / `START TRANSACTION ISOLATION LEVEL …`, then `COMMIT` or `ROLLBACK`. With
Postgres.js, `kysely-postgres-js` runs the transaction on a dedicated connection taken from the
driver's pool and issues the same statements. Both expose Kysely's rollback-on-throw callback and isolation levels. **No
material limitation was found for either**, so transactions are marked `NON-DISCRIMINATING` rather
than used to favour a candidate.

### Kysely `Migrator` interaction

The `Migrator` takes a Kysely instance. Whatever dialect is selected here therefore becomes the
**default** migration-side connection mechanism. It does **not** follow that migration execution
must use the identical runtime connection configuration forever: a separate Kysely instance, or
different connection settings, remain possible without violating `ADR-015`. **Where and when
migrations run, and rollback policy, remain separately governed and are not decided here.**

### Application pool — mechanism versus configuration

- **A — `pg`:** the in-process pool mechanism follows the driver as `pg.Pool`, shipped with `pg`
  through its `pg-pool` dependency; `PostgresDialect` takes a `pg`-compatible pool.
- **B — Postgres.js:** the in-process pool mechanism is built into the driver itself.

**Neither requires an additional pool package.** For either, this ADR selects **no** pool size,
idle timeout, connection timeout, retry behaviour or shutdown implementation — those remain
implementation configuration. **The external / network pooler is a separate decision and is not
resolved.**

### External-pooler compatibility — architecture-relevant facts only

- **A — `pg`** uses unnamed statements unless named prepared statements are explicitly requested.
- **B — Postgres.js** creates **prepared statements automatically by default** (its documented
  `prepare: true` option), and the option can be turned off.

**External-pooler compatibility for both finalists must be revalidated when an external pooler is
actually selected.** Compatibility depends on the pooler, its mode and the session features in use,
not only on statement defaults. Neither finalist is shown to be incompatible with external pooling,
and neither is shown to work with every pooling mode without configuration.

**Neither candidate prevents a future external pooler. External pooler selection remains
`UNSELECTED`**, and no pooler — PgBouncer or any other — is chosen here.

### TLS

Both finalists can establish TLS connections to managed PostgreSQL and expose certificate
verification controls. **This ADR selects no** certificate source, CA file, `rejectUnauthorized`
behaviour, secret storage, TLS configuration or connection-string representation — these remain
implementation and security configuration.

### Render and DigitalOcean

**Render:** a persistent Node process with ordinary TCP connections and a long-lived in-process
pool fits both finalists equally. Environment variables and graceful shutdown are configuration.

**DigitalOcean Managed PostgreSQL:** ordinary PostgreSQL runtime connectivity over TLS; both
finalists are compatible and **no provider-specific SQL driver is required**. DigitalOcean's
per-plan connection limits make pool configuration matter later; they do not discriminate between
the drivers.

### STRONG-PREFERENCE criteria

| Criterion | A — `pg` | B — Postgres.js |
|---|---|---|
| Integration ownership | **Stronger** — the dialect is part of Kysely core and moves with every Kysely release | Good — organisation-maintained, but a **separate package** with its own release line and peer range to track |
| Maintenance evidence (descriptive only) | 249 published versions; latest publication 2026-08-08 | 48 published versions; latest publication 2026-04-05 |
| Operational simplicity | **Comparable overall** — operationally viable; a modest simplicity consequence of the core-dialect integration already counted under *Integration ownership*, **not a second discriminator** | **Comparable overall** — operationally viable; driver and dialect ranges are kept aligned as part of the same separate-package topology counted above |
| External-pooler compatibility | Not established as superior — unnamed statements unless named ones are requested; revalidate when a pooler is selected | Not established as inferior — prepared statements on by default and can be turned off; revalidate when a pooler is selected |

**Release counts and dates are descriptive maintenance evidence only.** More releases, more
frequent releases or a more recent release do not by themselves show that a library is more mature
or of higher quality, so this row is not used as a discriminator.

### SECONDARY criteria

| Criterion | A — `pg` | B — Postgres.js |
|---|---|---|
| Dependency footprint | 6 direct dependencies (1 optional); approximately 12–13 packages in the tree | **Stronger** — two top-level packages (`postgres`, `kysely-postgres-js`), each with 0 dependencies |
| Licence posture | MIT, matching the rest of the stack | **Unlicense** (public-domain dedication) — permissive, but a different posture worth deliberate attention |
| API ergonomics | Kysely mediates queries; ergonomics largely equal through Kysely | Kysely mediates queries; the native tagged-template API is attractive but largely bypassed through Kysely |
| Portability / reversibility | Good, not cost-free — changing driver keeps Kysely but changes dialect wiring and may change value parsing | Good, not cost-free — same |
| Module posture | CommonJS implementation with an ESM entry point | **Slightly stronger** — ESM-native |

**Secondary factors favour Postgres.js on footprint and module posture.** They are weighed
explicitly; in this Proposal they narrowly do not outweigh the single strong-preference advantage.

## Decision

**`pg` (node-postgres) through Kysely core `PostgresDialect` is selected as the runtime PostgreSQL
driver/client and Kysely dialect that `C9` and Kysely `Migrator` use to connect to PostgreSQL.**
The Product Owner ruled on **2026-09-15**: *"I approve Option A: pg (node-postgres) through
Kysely's core PostgresDialect for ADR-016."* That ruling is recorded here as **authoritative**.
**No owner rationale beyond the approval was stated, and none is attributed.** It selects the
driver/client and dialect and nothing else — see *This ADR selects nothing else*.

### The recommendation recorded at the `Proposed` stage

Preserved as decision history. It is the Proposal's analysis, not the owner's stated rationale.

**The evidence narrowly favored A — `pg` (node-postgres) through Kysely core `PostgresDialect`**,
on one genuine discriminator:

1. **Kysely-core dialect integration.** The `pg` path uses Kysely's core `PostgresDialect`, so
   there is no separate dialect package, release line or peer-version relationship to maintain.
   The modest consequence is a somewhat simpler integration surface for a single maintainer; that
   consequence is part of this ground, not a second one.

**This recommendation does not rest on** `pg` being conventional, on Kysely examples commonly using
it, or on `ADR-014` having discussed `pg.Pool`. Those are not discriminators, and the
commissioning analysis's earlier lean was tested here rather than adopted.

**Robustness: low to moderate.** Every REQUIRED criterion is met by both finalists, and most
technical criteria do not discriminate. The narrow lean rests on a single strong-preference
advantage, while Postgres.js holds genuine secondary advantages (dependency footprint, ESM-native
module posture). This was a narrow recommendation, not a default selection; a reasonable Product
Owner could have selected Postgres.js.

### The strongest alternative — Postgres.js with `kysely-postgres-js`

Postgres.js is **valid and a legitimate choice**, and its case is real:

- its Kysely dialect is **maintained by the Kysely organisation**, not an ad-hoc community package;
- it is **ESM-native** and has **zero runtime dependencies**;
- it has a **built-in pool** and **valid transaction support** through Kysely;
- it is equally reversible, with the same not-cost-free replacement considerations.

An owner who weights a zero-dependency, ESM-native driver above Kysely-core integration **could
reasonably have selected it**. That argument is preserved here so it survives
the ruling (`IR-6`).

### What the decision settles and does not settle

**It settles** the runtime driver/client and its Kysely dialect, and with them the in-process pool
**mechanism** that ships with the driver.

**It leaves open** everything in *This ADR selects nothing else*.

## Alternatives considered

| Alternative | Classification and why it is not selected |
|---|---|
| **Postgres.js + `kysely-postgres-js`** | **Valid, organisation-maintained, and a legitimate choice — not selected; at the `Proposed` stage it was narrowly not recommended, on a single preference-level ground.** Separate dialect package with its own release line and peer range; pooler compatibility, like `pg`'s, to be revalidated when a pooler is selected. Stronger on footprint and ESM posture. See *The strongest alternative* |
| **Serverless / HTTP / edge clients** | **Poor fit, not impossible.** Wrong shape for `ADR-005`'s long-running process, often provider-specific, and they add an unneeded hop |
| **Provider-specific drivers** | **Unnecessary.** DigitalOcean Managed PostgreSQL is ordinary PostgreSQL |
| **`pg-native`** | **Unnecessary complexity.** A native build with no requirement driving it |
| **Direct driver without Kysely** | **Rejected by `Accepted` `ADR-014`**, not by this ADR |
| **Custom Kysely dialect** | **Unnecessary.** Maintained dialects exist for both finalists |
| **Deferring the driver again** | **Rejected.** No Kysely query or `Migrator` run can execute without a dialect, and further deferral would be resolved by the first persistence pull request — `IR-1` exactly |

## Consequences

Stated for the selected Option A, approved by the Product Owner on **2026-09-15** and in force
through this `Accepted` ADR.

**Positive:** a governed driver and dialect exist, so later work can install and wire them without
a further technology decision; no additional dialect package.

**Negative:** a larger dependency tree (6 direct dependencies, approximately 12–13 packages) than
the Postgres.js path's two zero-dependency packages; a CommonJS implementation behind an ESM entry
point rather than an ESM-native driver.

**Reversibility: good, but not cost-free.** Kysely reduces driver coupling, because `ADR-014` keeps
the application access approach stable, and changing driver/dialect does not require abandoning
Kysely. Replacement would still change connection setup and dialect wiring; value and type parsing
can differ between drivers, so raw-SQL behaviour and query-result handling may need review or
adaptation; and migration connectivity would need revalidation.

## Risks

| Risk | Response |
|---|---|
| **Acceptance is read as implementation authorization** | Acceptance would put a **technology-selection decision** in force and nothing more; installation and connection wiring remain separate later work |
| **The driver decision is read as settling connection configuration** | Pool configuration, the external pooler, TLS policy and secrets are expressly left open below |
| **Mutable facts treated as pins** | Every version and release fact is dated, non-normative and flagged for revalidation |
| **A pooler is later chosen that conflicts with the driver's defaults** | Recorded as compatibility evidence; pooler selection remains a separate decision |

## This ADR selects nothing else

**Acceptance is not installation.** This `Accepted` ADR selects **no** exact version of `pg`, `postgres`,
`kysely-postgres-js` or `kysely`; **no** PostgreSQL server version; **no** pool size, idle timeout,
connection timeout, retry policy or graceful-shutdown wiring; **no** TLS verification policy,
certificate source or connection-string format; **no** credentials or secrets provider; **no**
external pooler; **no** DigitalOcean cluster, tier or region, and **no provisioning**.

It selects **no** schema, table, column, key, identifier, constraint or index; **no** migration
contents, migration execution environment, migration execution timing or rollback / down policy;
**no** query conventions, repository layout or observability; **no** CI database or test database;
and **no** dependency installation, connection implementation, persistence adapter or database
integration test.

**No numbered `DDM` owns or is resolved by this ADR.** `DDM-2`–`DDM-9` remain **unresolved**.
`DDM-10` was already resolved by `ADR-015` and is unaffected. `DG-4` remains **`Unresolved`**, and
`P2` is not begun. **No accepted ADR is amended, reopened or superseded.** Nothing is installed,
no `package.json` or `package-lock.json` change is made, and no runtime or source-code
implementation under `src/` is created or modified; the only `src/` change in this acceptance is
documentation synchronization in `src/data/README.md`.

## Owner-decision status and lifecycle

**Status: `Accepted`. In force. Work may rely on it.**

| | |
|---|---|
| **Proposal recommendation** | The evidence narrowly favored A — `pg` (node-postgres) through Kysely core `PostgresDialect`; made for Product Owner consideration, with Postgres.js preserved as a viable alternative |
| **Product Owner decision** | **Option A approved 2026-09-15** — `pg` (node-postgres) through Kysely core `PostgresDialect` |
| **ADR status** | **`Accepted`** — 2026-09-15; **in force** |
| **Proposal issue** | **#123** — `architecture: decide the runtime PostgreSQL driver/client and Kysely dialect for C9` (closed) |
| **Proposal branch** | `docs/123-propose-adr-016-postgresql-driver` |
| **Proposal pull request** | **#124** — `docs: propose ADR-016 pg for C9 PostgreSQL connectivity`, merged 2026-09-15 |
| **Acceptance issue** | **#125** — `architecture: accept ADR-016 PostgreSQL runtime driver and Kysely dialect` |
| **Acceptance pull request** | Not yet created |

**The two-stage lifecycle applies**, per the `ADR-014` (#115 / #116, then #117 / #118) and `ADR-015`
(#119 / #120, then #121 / #122) precedent:

1. **Proposal stage** (issue #123, PR #124): analysed the candidates and recommended; it made
   nothing authoritative.
2. **Product Owner decision:** after the mandatory detailed review of the Proposal —
   **given 2026-09-15: Option A approved**.
3. **Acceptance stage** (issue #125): records the ruling and places `ADR-016` in force.

## Traceability

| | |
|---|---|
| **Decision** | Runtime PostgreSQL driver/client and Kysely dialect — a non-DDM technology-selection decision under ruling `R-A`, deferred by `ADR-014` |
| **Components** | **`C9`** — Listing Repository (`docs/07`; `ADR-002` `O-1`) |
| **Fed by** | `ADR-002` (ruling `R-A`), `ADR-003`, `ADR-005`, `ADR-013`, `ADR-014`, `ADR-015` — all `Accepted`, none amended |
| **Documents amended** | **At the `Proposed` stage:** this file (new), `docs/adr/README.md` (register row and the in-force summary) and `docs/traceability-matrix.md` (register row). **At acceptance:** this file; `docs/adr/README.md` (register row and the derived decisions-in-force count, **ten → eleven**); `docs/traceability-matrix.md` (register row); and only the present-tense driver/client and dialect statements that acceptance makes false in `docs/08` (`DDM-10` row), `docs/13` and `src/data/README.md`. `docs/07`, `docs/12` and earlier `Accepted` ADRs are untouched |
| **Issue / pull request** | **Proposed:** issue **#123**, PR **#124** (merged 2026-09-15). **Product Owner ruling 2026-09-15: Option A approved.** **Accepted:** issue **#125**; acceptance pull request not yet created |
