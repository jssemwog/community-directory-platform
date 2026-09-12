# `ADR-014` — Adopt a typed SQL query-builder approach for `C9`'s PostgreSQL access, and defer the driver/client and migration tooling

| Field | Value |
|---|---|
| **Status** | **`Accepted`** |
| **Date** | 2026-09-11 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*) |
| **Decision gate** | *none* — `DG-2` is **`Resolved`** (2026-08-27, issue #93) and this ADR is **not** one of its constituents; `DG-1` is **`Resolved`** (2026-08-04) |
| **Related open questions** | **Depends on:** nothing unresolved. `ADR-002`, `ADR-003`, `ADR-005`, `ADR-006`, `ADR-010`, `ADR-012` and `ADR-013` are all **Accepted** and supply every constraint this decision must satisfy. **Must NOT answer:** **`DDM-10`** (migration and schema-evolution tooling), **`DDM-2`–`DDM-9`** (physical data design), `OQ-4`, `OQ-5`, `OQ-14`/`NOQ-8`, `NOQ-9`, `DG-3`, `DG-4` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **`Accepted`, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is
> *"Decided and **in force**. Work may rely on it."* The product owner accepted this decision on
> **2026-09-11** — **Kysely is the selected `C9` PostgreSQL data-access approach** — following the
> `Proposed`-stage publication of **2026-09-09** recorded on **issue #115** and merged by **PR
> #116**, and the separate governed acceptance step recorded on **issue #117**; the `ADR-005`
> (issue #89 / PR #90, then issue #91 / PR #92), `ADR-013` (issue #101 / PR #102, then issue #103
> / PR #104) and `ADR-012` (issue #105 / PR #106, then issue #107 / PR #108) precedent. **Later
> `C9` implementation may rely on the selected approach.** But **acceptance is not installation
> and not implementation authorization**: it installs no dependency — **Kysely is the `Accepted`
> approach decision, not an installed package** — writes no persistence code, creates no schema,
> and authorizes no implementation. **Every matter this ADR defers remains deferred**: the
> PostgreSQL driver/client and the connection pooler stay unselected, `DDM-2`–`DDM-9` stay
> unresolved, and `DDM-10` stays unresolved and separately governed.

---

## Context

**`C9` is empty, and that emptiness is load-bearing.** `src/data/README.md` records it in those
words, and records why: a placeholder repository or a stub client *"would encode assumptions"*
about every unresolved physical data decision. Consequently, **as at 2026-09-09**, **no ORM,
data-access library, driver, or pooler was selected** — the deferral being owner **ruling `R-A`**,
originated in
`ADR-002` (*"This ADR selects **no** ORM, data-access library, query builder, PostgreSQL client,
or migration tool"*) and re-asserted verbatim in `ADR-005`, `ADR-012` and `ADR-013`.

**The deferral has now reached its limit.** `ADR-012` named the successor work explicitly:
*"Persistence technology remains a **separate later work unit**, approved in principle only and
**not commissioned** by this document."* `P1` Slice A (issue #109, PR #114) delivered the
logical/domain foundation — the status model, the revision rules, the public projection, the
decided validation — as pure TypeScript, and deliberately deferred every persistence concern.
Issue #109 records `BI-7` and `DI-3` as *"a persistence concern"* belonging to a later slice.

**What is now blocked.** `docs/12`'s `P1` still owes atomic publication (`BI-7`, `DI-3`,
`NFR-DATA-03`), timestamp and remaining integrity rules (`DI-6`, `DI-7`), the public/private
boundary *enforced* server-side, revision storage, retention and purge, publication state, and
`C9` itself. `P1`'s exit criterion `RC-1` requires `DI-1`–`DI-11` proven. `P2`, `P3` and `P4`
each list `P1` as a dependency. None of it can be commissioned while `C9`'s access approach is
undecided — and deciding it inside an implementation pull request would answer the question
invisibly, the failure `docs/adr/README.md` names (*"An ADR must not answer an open question
implicitly"*) and Definition of Done #6 forbids outright.

**Why this ADR is narrow by construction.** A commissioning analysis of the unresolved
persistence decisions found that they are **not one governance unit**. The data-access approach
has no `DDM-*` identifier at all — it lives under ruling `R-A`. Migration and schema-evolution
tooling **does** have one: `DDM-10`. The two have materially different alternatives, different
evaluation criteria, and in some branches change independently of each other. The product owner
approved a split on that basis: this ADR decides the access approach only, and a separately
governed work unit decides `DDM-10` afterwards. **That second work unit is not authorized and is
not created by this document.**

**Requirements and invariants this decision answers to.** `NFR-DATA-01`, `NFR-DATA-02`,
`NFR-DATA-03`, `NFR-DATA-06`; `NFR-SEC-08`; `NFR-MAINT-03`; `NFR-REL-04`; `NFR-PRIV-01`,
`NFR-PRIV-02`; and invariants `DI-1`–`DI-11`, `BI-7`, `BI-8`. It **proves** none of them: it
selects the approach whose later implementation must be able to enforce them.

## Decision question

**What data-access approach should `C9` use to reach PostgreSQL — an ORM, a typed SQL /
query-builder approach, or the PostgreSQL driver directly?**

## Accepted constraints this decision must satisfy

Reconstructed from `Accepted` ADR text, not assumed. Each row states the constraint, its exact
implication for a persistence technology, and **what it does not decide**.

| Constraint | Source | Implication | What it does **not** decide |
|---|---|---|---|
| Modular monolith; dependencies point **strictly inward** | `ADR-001`; `ADR-002` `O-9`; `src/domain/README.md` | No persistence library may be imported by `src/domain/`; `C9` maps store representations into domain types | Which library |
| `C9` is the **single data-access path** and **owns transactions** | `ADR-002` `O-1`; `src/data/README.md` | The candidate must offer **explicit** transaction control adequate for `DI-3` / `BI-7` / `NFR-DATA-03` | The transaction API's shape |
| **Browser-direct datastore access prohibited**; all access server-side | `ADR-001`; `ADR-002` `O-2`; `NFR-SEC-08`; `docs/07` `R-10` | Rules out client-side and edge-oriented data SDK postures | Which server library |
| **TypeScript and Next.js** | `ADR-002` (Accepted) | First-class TypeScript required | Nothing about data access — *"The framework bundles no data layer, so nothing is adopted by default"* |
| Domain logic testable **in-process, without a browser and without a deployed environment** | `ADR-002` `O-11` | Slice A's purity must survive; persistence tests are a separate later layer | Test infrastructure — `ADR-012` excludes it |
| **PostgreSQL** under a **managed** operating posture | `ADR-003` (Accepted) | PostgreSQL may be assumed | Nothing physical |
| **DigitalOcean Managed PostgreSQL**, named | `ADR-013` (Accepted) | The named service may be assumed | Region, tier, sizing, version, provisioning, credentials, pooler, and every operational detail — all expressly deferred |
| **Render**, long-running **Node.js** web service, **single instance** | `ADR-005`; `ADR-010` | `ADR-005`: *"A continuously running process holds a stable, long-lived connection pool."* A serverless-specific or HTTP-proxy data adapter is the **wrong shape** here | Pool configuration, service tier |
| Node `>=22.12.0`; ESM (`module: esnext`, `moduleResolution: bundler`) | `package.json`, `tsconfig.json` | The candidate must support this runtime floor and module posture | Any version of anything new |
| Listing lifecycle: three-value status, rejection terminal, `DI-10`, `DI-11`, publication state modelled separately | `ADR-006` (Accepted) | Persistence must be **able** to express these; `ADR-006` states rules and derived conditions, **never shapes** | No representation |
| Recovery must restore correct **business state** — stable identity, valid lifecycle state, current approved version, `DI-10`/`DI-11`, publication state, purge/non-resurrection, transactional consistency | `ADR-010` (Accepted) | The restored state must be **correct**, and the recovery and rebuild obligations must be **supportable** by whatever `C9` uses. `ADR-010` requires this **outcome** | No mechanism; no backup design; **no property of the access technology** — it does not require any particular query, migration or inspection capability |
| **Vitest** as primary implementation-level runner | `ADR-012` (Accepted) | Testability is legitimate evidence | Database/integration-test infrastructure, coverage, `DG-4` |
| **`DDM-2`–`DDM-9` unresolved**; **`DDM-10` unresolved** | `docs/08` | The approach must not require resolving them as a precondition, and must not encode them | Every physical data question |

**No accepted ADR is reopened, and none already selected an access approach.** Ruling `R-A` is
not a gap in the chain — it is a deliberate, four-times-restated deferral whose successor work
unit this is.

**One inference, labelled as such and not a constraint.** *Analysis, not an `ADR-010`
requirement:* where SQL is directly inspectable, verifying that a restore returned correct
business state — and reasoning about a rebuild — is likely to be **easier**. `ADR-010` demands
the **outcome** (correct restored business state; supportable recovery and rebuild obligations)
and says **nothing** about SQL transparency, query style or migration format. Inspectability is
therefore weighed below as an **analytical convenience**, never as a mandate, and no candidate is
disqualified by it.

### The driver/client is deferred

**`ADR-014` decides the data-access approach only. The PostgreSQL driver/client is not selected
by this ADR.** Issue #115's reversibility rule governs: *"Would this still be independently
reversible without changing the selected data-access approach? If **YES** and it has meaningful
independent alternatives: leave it deferred."*

Both limbs are satisfied for the driver. Kysely's official dialect listing carries the core
`PostgresDialect` **and** an organisation-maintained Postgres.js dialect, so the driver is
selected by choosing a dialect and can be changed **without changing the access approach**. The
alternative is officially supported rather than theoretical. **`pg` and Postgres.js are therefore
both discussed below as credible drivers compatible with the approaches compared, and neither is
selected here.** The driver/client remains an **implementation-time deferred choice**, and
nothing in this ADR should be read as the governance decision *"Kysely means `pg`."* No
driver-selection work unit is created by this document.

## Options considered

Four approaches were treated as credible for this repository. Each is a real posture, not a
strawman.

- **A — ORM with a schema-declaration source of truth: Prisma.**
- **B — TypeScript-schema ORM / hybrid query builder: Drizzle ORM.**
- **C — Typed SQL query builder over the standard driver: Kysely.**
- **D — The PostgreSQL driver directly: `pg` (node-postgres).**

**Candidates excluded, with reasons.** *Postgres.js* (`postgres`) is a **driver alternative, not
an access approach**, and is therefore not a fifth option. **The driver/client is not selected by
this ADR at all** — see *The driver/client is deferred* below. *TypeORM*, *Sequelize* and
*MikroORM* were
excluded as decorator/entity-class ORMs whose class-based entity model pulls persistence
concerns toward the domain layer, working against `ADR-002` `O-9` and against Slice A's
already-merged plain-module domain — a coupling this repository has deliberately paid to avoid.
*Data-platform SDKs* reachable from the browser or edge runtime were excluded outright by
`ADR-001` and `ADR-002` `O-2`.

## Current external facts

**Verification date: 2026-09-09.** These are **externally verified current facts recorded as
decision-time evidence**, not repository decisions and **not normative**. Versions are
**evidence, not implementation pins** — no version is selected by this ADR. Sources are listed
in *Mutable-fact verification* below.

| | **A — Prisma** | **B — Drizzle ORM** | **C — Kysely** | **D — `pg`** |
|---|---|---|---|---|
| Published `latest` on npm | `prisma` **8.0.0-rc.13** — a **release candidate** | `drizzle-orm` **0.45.3**; `drizzle-kit` **0.31.10** | `kysely` **0.29.5** | `pg` **8.23.0** |
| Stable / recommended line | Unsettled in the sources: npm's `prev` tag is **7.10.0** and Prisma's docs present **8 as the current release** while **7 remains fully supported**; the roadmap describes 8 as an RC line advancing toward GA | `0.4x` stable on npm, but the official PostgreSQL getting-started currently instructs `drizzle-orm@rc` / `drizzle-kit@rc` | `0.29.x`, pre-1.0 by version number | `8.x`, long-stable |
| Licence | Apache-2.0 | Apache-2.0 | MIT | MIT |
| Declared Node support | `engines.node >=22.18.0` | no `engines` field | `engines.node >=22.0.0` | `engines.node >=16.0.0` |
| Runtime dependencies | Substantial CLI/toolchain tree | Modest; driver supplied separately | **None** | Six small `pg-*` packages |
| Schema authoring locus | Prisma schema file (or TypeScript), emitted as a typed contract by a build step | TypeScript schema objects | Hand-authored SQL; a hand-written `DB` interface *describes* the schema | Hand-authored SQL; no types |
| Generated artifacts | Yes — a build step emitting a schema contract and types | Optional codegen; schema objects are hand-written | **None** | None |
| Transactions | Yes | `db.transaction()` with `tx.rollback()`, savepoints via nesting, PostgreSQL isolation levels and access modes | `db.transaction()` with `.setIsolationLevel(...)`; the PostgreSQL driver issues `START TRANSACTION ISOLATION LEVEL` or `BEGIN` | Native — `BEGIN` / `COMMIT` / `ROLLBACK` on a checked-out client |
| Raw SQL escape hatch | Yes | Yes — the `sql` operator | Yes — the `sql` template tag, injectable into most methods | It **is** raw SQL |
| Connection model | Manages its own | A `pg` `Pool` passed in, or a connection string it manages | `PostgresDialect` over a `pg` `Pool` | `pg.Pool` |
| Migration relationship | **Integrated** — the schema declaration is the source of truth | `drizzle-kit` generates SQL from the TypeScript schema | Built-in optional `Migrator` (schema builder **or** normal queries, DB-level lock, parallel calls serialised); optional non-core `kysely-ctl`; freely replaceable | None — a migration tool must be chosen separately |

**Provider facts** (DigitalOcean official documentation, same date): Standard Edition offers
PostgreSQL v14–v18 and Advanced v16–v18; point-in-time recovery is limited to the last 7 days;
backend connections scale with plan size (for example 22 on a 1 GiB plan, up to 997 at the top
end); PgBouncer pooling is available, with 21 pools and up to 1,000 connections depending on
plan; the superuser role is not available. **All four candidates speak the standard PostgreSQL
wire protocol and are compatible with a managed PostgreSQL cluster; none requires a
provider-specific driver.** No version, region, tier, sizing or pooler is selected here.

**An honest note on version lines.** Two of the four candidates are mid-transition today:
Prisma's npm `latest` tag points at a release candidate while its documentation presents 8 as
current and 7 as still supported, and Drizzle's official PostgreSQL guide currently points at
its own `rc` line. This is recorded as **evidence about present ecosystem churn**, not as a
disqualification of either candidate, and **not** as a version selection. Whatever is selected,
the exact version line remains an implementation-time detail to be re-verified then.

## Detailed comparison

### Transaction control — `DI-3`, `BI-7`, `NFR-DATA-03`

`C9` owns transactions, and `FR-ADM-10b`'s atomic administrator revision plus `DI-3`'s
all-or-nothing purge both need real transaction boundaries. **All four candidates support
explicit transactions**, so this criterion **eliminates nobody** — but they differ in
transparency. `pg` gives literal `BEGIN`/`COMMIT`/`ROLLBACK` on a checked-out client, with the
correctness burden entirely on hand-written code. Kysely and Drizzle both wrap a callback with
rollback-on-throw and expose PostgreSQL isolation levels explicitly. Prisma provides transactions
through its own client abstraction. For a decision whose restores must be *verified* against
`ADR-010`'s business-state obligations, an approach whose emitted SQL is directly inspectable is
worth more than one whose transaction semantics must be taken on trust.

### Long-running Node service fit — `ADR-005`, `ADR-010`

`ADR-005` selected a **continuously running single instance** and recorded that such a process
*"holds a stable, long-lived connection pool"*, noting that function-oriented models make
connection management against a relational store harder. Every candidate here is a conventional
server-side library and fits that shape; on their most common configuration Kysely, Drizzle and
`pg` all pool through `pg.Pool`, though for the builder and ORM approaches that follows from the
**deferred** driver/dialect choice rather than from the access approach. The material point is a
negative one: **serverless-specific adapters, HTTP data
proxies and edge drivers are the wrong shape for this deployment**, and adopting one would
introduce a hop this architecture does not need. DigitalOcean's modest per-plan connection budget
means a single long-lived pool is the right posture — **but no pool size, pooler or connection
configuration is selected by this ADR.**

### Type safety and the domain boundary — `ADR-002` `O-9`

Slice A's domain is plain TypeScript with no persistence dependency, and must stay that way.
`C9`'s job is to map store representations into those domain types. Prisma's emitted contract and
Drizzle's TypeScript schema both produce persistence-shaped types that are genuinely useful
inside `C9` but that must be **prevented** from spreading inward — a discipline, enforceable by
review, not by the tool. Kysely's hand-written `DB` interface is the opposite trade: nothing is
generated, so nothing leaks by default, but the interface must be kept in step with the schema by
hand, and drift between them is a real and under-appreciated failure mode. `pg` offers no result
typing at all, so every row shape becomes a hand-written assertion — the weakest option against
`NFR-MAINT-03`.

### Testability — `ADR-012`, `docs/11`

Under every candidate, Slice A's pure domain tests are unaffected, and under every candidate the
data-integrity invariants remain at `docs/11`'s **integration** level (*"a component together
with its store"*), so `BI-7` and `DI-3` will eventually need a **real PostgreSQL instance**. That
is later, separately governed work: `ADR-012` selected no database or integration-test
infrastructure and `DG-4` is untouched. Where the candidates differ is **mock pressure**. A
generated-client ORM invites tests that mock the client — evidence `docs/11` `T1`/`T3` treat as
weaker than exercising the real boundary. An approach built over a plain `pg` pool makes
substituting a real database the path of least resistance, which is the evidence this repository
says it wants. **No test infrastructure, container, Docker image, CI database service or mocking
strategy is selected here.**

### Portability and coupling

Five couplings, assessed separately, because collapsing them is how "less abstraction equals more
portable" becomes an unexamined slogan:

| Coupling | Prisma | Drizzle | Kysely | `pg` |
|---|---|---|---|---|
| **A — runtime query/API** | High — a proprietary query DSL | Moderate — SQL-shaped but library-specific | Low — SQL-shaped, thin | None |
| **B — generated client** | Present — a build step in the toolchain | Optional | **None** | None |
| **C — schema definition** | High — the schema declaration is the source of truth | High — physical design authored as TypeScript objects | **Low** — SQL is the source of truth; the `DB` interface merely describes it | None |
| **D — migration format** | High — see the `DDM-10` section | Moderate to high | **Low** | None |
| **E — provider** | None material | None material | None material | None material |

**Provider coupling is essentially equal across all four**, and `ADR-013` already recorded a
provider migration as bounded: *"Application and domain code: none expected, because `C9` remains
the sole data-access path and nothing above it is provider-shaped."* **The couplings that
actually matter for this MVP are C and D** — where physical design lives, and what shape
migrations take — precisely because `DDM-2`–`DDM-9` are unresolved today and `DDM-10` is a
separately governed decision the owner has approved keeping open. And ORM usage does **not**
automatically mean unacceptable lock-in: Prisma's and Drizzle's lock-in is concentrated in schema
and migration format, not in the ability to reach standard PostgreSQL.

### MVP implementation complexity

Assessed against **this** repository — one maintainer, a small directory at first release
(`PA-1`), Vitest only, no database test infrastructure yet — and not against hypothetical scale.

| | Prisma | Drizzle | Kysely | `pg` |
|---|---|---|---|---|
| Learning burden | Highest — its own schema language, contract build step and query DSL | Moderate | Low for anyone who knows SQL | Lowest conceptually |
| Conceptual surface | Large | Moderate | Small | Smallest |
| Custom `C9` infrastructure needed | Least | Little | Moderate — mapping and the `DB` interface | **Most** — mapping, result typing, migration running, all hand-built |
| Query transparency / debugging | Lowest — SQL is emitted for you | Good | **High** — the builder mirrors SQL | Total |
| TypeScript ergonomics | Strong, via generated types | Strong, via schema inference | Strong, via the hand-written interface | **Weak** — untyped results |
| Generated artifacts to maintain | A build step | Optional | None | None |
| Dependency footprint | Largest | Modest | **Zero runtime dependencies** | Small |
| Transaction ergonomics | Good | Good | Good | Manual |
| Maintenance burden for a small MVP | Toolchain and version-line churn | Version-line churn | Keeping the `DB` interface honest | Hand-written everything |

## `DDM-10` relationship — every candidate

**Mandatory, and the reason the governance split exists.** Each candidate is classified by whether
selecting it as the **runtime** access approach forecloses, materially narrows, or leaves
genuinely open the separate `DDM-10` decision.

### A — Prisma

**`DDM-10` RELATIONSHIP: NARROWS**

Prisma Migrate is the **native and strongly integrated path**: the schema declaration is the
source of truth from which the client contract is emitted, and the project's own migration
tooling is built on that same declaration. That integration creates **meaningful coupling**, and
adopting Prisma would heavily shape the later `DDM-10` decision.

**It does not eliminate the alternatives.** Prisma's own documentation records that introspecting
an existing database *"is compatible with any migration tool and ORM which you may already be
using"*, and lists as compatible setups: projects using plain SQL `CREATE TABLE` / `ALTER TABLE`
files; projects using a third-party migration library; and projects already using another ORM. It
separately documents replacing Prisma Migrate with an external schema-management tool **while
retaining Prisma's data model and typed query capabilities**. Externally managed or plain-SQL
migrations are therefore a documented, supported configuration, at a cost in ergonomics rather
than a technical impossibility.

`DDM-10` accordingly remains **independently governable** under Prisma — heavily narrowed, not
foreclosed.

### B — Drizzle ORM

**`DDM-10` RELATIONSHIP: NARROWS**

The TypeScript schema objects that define runtime access are the same objects `drizzle-kit`
reads to generate SQL migrations, so schema declaration and migration generation are tightly
coupled — but not welded. `drizzle-kit` is a separate package, its output is plain SQL, and
hand-written SQL applied by other means is workable. `DDM-10` would survive as a real question
with a heavily favoured answer, and the honest description is **materially narrowed**, not
foreclosed.

### C — Kysely

**`DDM-10` RELATIONSHIP: LEAVES OPEN**

Runtime data access is decoupled from schema evolution. The `Migrator` is **built in but
optional**: migrations may use the schema builder or run ordinary queries, and its CLI is
explicitly not part of the core. SQL remains the source of truth, and the type interface
*describes* a schema rather than defining it — so an entirely external, plain-SQL migration
regime composes cleanly, and migration tooling can be changed later without touching runtime
data access. `DDM-10` remains a genuine, independently governable decision with real
alternatives.

### D — Direct `pg`

**`DDM-10` RELATIONSHIP: LEAVES OPEN**

No migration capability is provided or implied, so nothing is foreclosed. The mirror-image cost
is that `DDM-10` becomes **mandatory and un-deferrable**: without some chosen tool or
hand-written runner, no schema can be created at all.

### The boundary this ADR holds

**This decision does not resolve `DDM-10`.**

**Migration and schema-evolution tooling remains separately governed after this data-access
decision.**

`DDM-10` is **not** marked Decided, Accepted, Resolved or discharged by this document, and
`docs/08`'s `DDM-10` row is deliberately left unamended. **No candidate forecloses `DDM-10`**;
the classifications group as **`NARROWS`** (Prisma, Drizzle) and **`LEAVES OPEN`** (Kysely,
direct `pg`), so the axis separates SQL-first from schema-first authoring rather than isolating
any single candidate. Under **every** option — including the two that narrow it heavily — the
separately governed `DDM-10` work unit **remains required**, so that the consequence is recorded
deliberately rather than absorbed. That work unit is **not authorized and is not created here**.

## Decision

**A typed SQL query-builder approach is adopted for `C9`'s PostgreSQL access — specifically
Kysely. The PostgreSQL driver/client is deliberately NOT selected** and remains an
implementation-time deferred choice under Issue #115's reversibility rule.

**What is not being claimed.** Selecting a schema-declaration-oriented technology such as Prisma
or Drizzle **would not decide `DDM-2`–`DDM-9` today**, and this decision does not argue that it
would. Those decisions belong to the later physical-persistence work unit under their own
governance, whichever access approach is chosen, and they remain unresolved either way. The
distinction between **technology coupling** and **decision resolution** is preserved throughout:
what follows is a coupling argument, not a claim that any candidate resolves a `DDM`. Neither is
`DDM-10` openness treated as decisive on its own — **two** candidates leave it open, and the
owner's approval of the governance split is not itself a reason to prefer one of them.

The case for Kysely, on which the owner ruled, rests on four grounds that hold independently of
one another:

1. **It dominates direct `pg` on the same `DDM-10` footing.** Both leave `DDM-10` genuinely open,
   so `DDM-10` does not discriminate between them — but Kysely adds typed query construction and
   typed results where `pg` offers none, and requires materially less bespoke persistence
   infrastructure inside `C9`. **This ground alone separates the recommendation from the other
   `LEAVES OPEN` option, and it does not depend on the coupling argument at all.**
2. **Authoring locus and migration coupling** — *one* consideration, not several. Under a
   schema-declaration approach the future physical design is expressed **in the access layer's
   own idiom**, and the runtime schema declaration is the same artifact the tool's migration
   generator reads. That couples where physical design lives to how migrations are produced, and
   it is what narrows `DDM-10` for Prisma and Drizzle. Under an SQL-first approach the schema
   stays the source of truth, the type interface merely describes it, and the two remain
   separable. **This is a legitimate selection consideration about future coupling; it decides no
   `DDM` now.**
3. **Runtime fit and footprint.** MIT-licensed; `engines.node >=22.0.0` against this repository's
   `>=22.12.0` floor; TypeScript-first; **zero runtime dependencies**; no generated runtime
   client and no build step; and an ordinary server-side library in a long-running
   single-instance Node service. It also keeps `C9`'s inward dependency boundary
   (`ADR-002` `O-9`) easy to hold, since there is no generated persistence type to place at all.
4. **Adequate transaction control, transparently.** Explicit transactions with isolation levels
   support the later `DI-3` / `BI-7` / `NFR-DATA-03` work. **This is not a differentiator** — all
   four candidates satisfy it — and it is recorded as a requirement met, not as an advantage.
   *Analysis, not an `ADR-010` mandate:* the transparency of the emitted SQL is likely to make
   restore validation and debugging easier.

**Its costs are real and are not minimised.** The **hand-written `DB` interface must be kept in
step with the schema**, and **drift between them is this decision's principal risk** — the
one place where its type safety could become a false assurance. `C9` will carry more hand-written
mapping than either ORM would require. The library is **pre-1.0** by version number. And it
forgoes the schema-generated developer convenience that Prisma and Drizzle genuinely provide,
which for a single maintainer is a real loss, not a rounding error.

**Drizzle was a genuinely close alternative**, and an owner weighing schema-derived type safety
and day-to-day ergonomics above authoring-locus separation could have selected it; the evidence
supports that reading, and it is preserved here so the argument survives the ruling (`IR-6`).
**Prisma, correctly classified as narrowing rather than foreclosing `DDM-10`**, is
the most productive option compared here and was a legitimate choice at a higher coupling and
footprint cost. **Direct `pg` is rejected for implementation burden and absent result typing —
not** because of anything to do with `DDM-10`, on which it scores identically to the selected
approach.

**The product owner ruled on 2026-09-11: Kysely will be the PostgreSQL data-access approach for
`C9`.** That ruling is recorded here as **authoritative for later `C9` implementation**, and this
ADR is `Accepted` and in force. **It selects the access approach and nothing else** — see *Selects
nothing else*.

## Rejected alternatives

| Alternative | Why it was rejected |
|---|---|
| **A — Prisma** | Rejected **not** on maturity, capability or lock-in-in-the-abstract: it is the most productive option compared here and its provider coupling is no worse than any other. **It does not foreclose `DDM-10`** — externally managed and plain-SQL migration workflows are documented and supported — and **it would not require `DDM-2`–`DDM-9` to be answered in order to be selected**; those remain later, separately governed decisions under any candidate. It is rejected on the narrower grounds that its schema declaration is simultaneously the locus of the future physical design and the source its native migration tooling reads, which **narrows `DDM-10`** more than any other candidate and makes departing from Prisma Migrate a deliberate cost; together with the largest conceptual surface and dependency footprint for a single-maintainer MVP, a required contract build step, and a version line presently mid-transition (npm `latest` on a release candidate while the documentation records 7 as still supported). **None of these is a defect in Prisma**, and an owner who values its ergonomics above authoring-locus separation could reasonably select it. |
| **B — Drizzle ORM** | The closest rejection, and it would be a defensible choice. Its TypeScript schema objects are the same artifact `drizzle-kit` reads, so adopting it places the future physical design in the access layer's idiom and **materially narrows `DDM-10`** — the same classification as Prisma, at a smaller conceptual and dependency cost. Narrowing `DDM-10` is a coupling consideration, **not** a breach of the governance split, which survives under every candidate. Its official PostgreSQL guidance currently points at an `rc` line, a secondary timing consideration. Preserved here as a serious alternative, not a strawman: if the owner weighs schema-derived type safety and ergonomics above authoring-locus separation, this is the option that argument selects. |
| **D — Direct `pg`** | Rejected on **implementation burden and absent result typing**, and **not** on `DDM-10` — it leaves `DDM-10` open exactly as the recommended approach does, so that axis does not separate them — nor on portability. It provides no result typing, so every row shape becomes a hand-written assertion, working against `NFR-MAINT-03`; and it pushes the greatest volume of bespoke infrastructure into `C9`, including a hand-built migration runner. It also makes `DDM-10` mandatory and un-deferrable. Note that rejecting it as an **approach** neither selects nor rejects it as a **driver**: `pg` remains a credible driver for the recommended approach, and the driver/client is deferred. |
| **Decorator/entity-class ORMs** (TypeORM, Sequelize, MikroORM) | Excluded before detailed comparison. Their class-based entity model pulls persistence structure toward the domain, working against `ADR-002` `O-9` and against Slice A's already-merged plain-module domain. |
| **Data-platform SDKs reachable from the browser or edge runtime** | Excluded outright by `ADR-001` and `ADR-002` `O-2`: browser-direct datastore access is prohibited, and no client may hold a datastore credential (`NFR-SEC-08`, `docs/07` `R-10`). |
| **Deferring the decision again** | Rejected. `P1` cannot proceed and `RC-1` cannot be met without `C9`; the next deferral would be resolved by whoever writes the first persistence pull request, which is `IR-1` exactly. |

## Consequences

**Positive:**

- `C9` becomes commissionable, unblocking the remaining `P1` work and, transitively, `P2`–`P4`.
- The physical data design stays a separate, later, deliberately governed decision.
- `DDM-10` stays a genuine decision for its own work unit.
- Explicit transaction control is available for the later `DI-3` / `BI-7` / `NFR-DATA-03` work.
- SQL remains inspectable, which serves `ADR-010`'s restore-verification and rebuild obligations.
- No generated artifact and no persistence-shaped type exists to breach `ADR-002` `O-9`.

**Negative:**

- The schema-describing type interface must be maintained by hand and can drift from the schema.
- `C9` carries more hand-written mapping than an ORM would require.
- Generated-migration convenience is deliberately forgone.
- A pre-1.0 version number, with the maintenance attention that implies.
- Integration-level tests will still require a real PostgreSQL instance — later, separately
  governed work.

**Reversibility:** **Moderate, and better than it would be under the rejected options.** Because
SQL remains the source of truth and no schema declaration or migration format is proprietary,
replacing the access approach later means rewriting query construction inside `C9` while the
database, the migrations and the domain survive untouched. `ADR-002`'s bounded-reversibility
argument applies here in the same form: the bound holds **only** while `C9` remains the sole
data-access path and no persistence type reaches `src/domain/`. If that discipline lapses, this
reversal degrades toward the cost of rewriting the application.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| The directory is small at first release (`PA-1`) | Query-shape and indexing pressure rise; the physical design decisions (`DDM-4` especially) matter more than the access approach, and this is not the first decision to revisit |
| One maintainer, for whom conceptual surface and transparency outweigh generated-code productivity | If the team grows, generated type safety becomes relatively more valuable and Drizzle's argument strengthens |
| `C9` remains the sole data-access path and no persistence type reaches `src/domain/` | The reversibility claim above weakens substantially |
| Physical data design will be governed as its own later work unit | If physical design is instead settled inside an implementation pull request, the main benefit of this recommendation is lost |
| Standard PostgreSQL access suffices; no provider-specific driver is needed | A provider-specific requirement would reopen the driver consequence, though not the approach |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| The hand-written schema-describing interface drifts from the actual schema | Type safety becomes a false assurance — the failure mode this decision most plausibly suffers | Treat the interface as reviewed artifact, verified against the schema at the integration level; this ADR selects no mechanism |
| **Acceptance is read as implementation authorization** | `src/data/` is populated, Kysely or a driver is installed, or a schema is created on the strength of this ADR alone | The header callout: acceptance puts the **approach decision** in force and **is not installation** — no Kysely installation, no driver/client selection, no pooler selection, no dependency installation, no persistence implementation, and no schema, index, migration or provisioning authorization. Each remains a separate later work unit with its own owner authorization |
| This ADR is read as deciding `DDM-10` | The approved governance split collapses and migration tooling is adopted silently | The `DDM-10` section classifies every candidate and states twice that `DDM-10` is unresolved; `docs/08` is left unamended |
| Physical design is smuggled in with the first persistence pull request | `DDM-2`–`DDM-9` get answered by an engineer, which is `IR-1` | The recommended approach does not require a schema declaration, so the physical decisions must be taken explicitly to be taken at all |
| The recorded version facts are treated as pins | An RC or a stale version is installed on this document's authority | Versions are recorded as dated evidence and explicitly non-normative; the version line is an implementation-time decision, re-verified then |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`DDM-10`** — migration and schema-evolution tooling | Classified per candidate as a **consequence** only; not marked Decided, Accepted, Resolved or discharged; `docs/08`'s row left unamended; the successor work unit is not created |
| **`DDM-2`** — identity strategy | No identifier carrier, UUID, sequence or natural key appears |
| **`DDM-3`** — category representation | Untouched; also blocked upstream by `OQ-5` |
| **`DDM-4`** — indexing and text-search strategy | No index or search implementation appears; also blocked upstream by `OQ-4` (`ADR-007` remains `Blocked`) |
| **`DDM-5`** — location normalisation | Untouched |
| **`DDM-6`** — physical separation of non-public attributes | Untouched; the `S-2` obligation is unchanged and its mechanism unselected |
| **`DDM-7`** — audit-entry storage | Untouched; blocked upstream by `OQ-14`/`NOQ-8` (`ADR-009` remains `Blocked`) |
| **`DDM-8`** — revision storage and the effective public version | Untouched; no table, pointer, copy or history shape appears |
| **`DDM-9`** — publication state, retention and purge representation | Untouched; no status value, flag, timestamp or structure appears |
| `OQ-4`, `OQ-5` | No search scope, matching mode or category-set representation appears |
| `OQ-14` / `NOQ-8` | No audit decision; `C10` remains conditional |
| `NOQ-9`, `DG-3` | No authentication, credential or session decision |
| `DG-4` | No testing depth, coverage provider, coverage threshold or release-readiness criterion |
| `DDM-1`'s operational remainder | No provisioning, account, cluster, region, tier, sizing or PostgreSQL version |
| `ADR-010`'s outstanding obligations | Provider-capability validation, the independent off-provider recoverable copy and the restore rehearsals are cited as **criteria** and remain **outstanding and undischarged** |

## Selects nothing else

This ADR selects **no** PostgreSQL driver or client — **neither `pg` / node-postgres nor
Postgres.js nor any other**; the driver/client remains an **implementation-time deferred choice**,
and no dialect, adapter or driver-selection work unit is chosen or created. It selects **no**
physical schema, table, column, column type, primary-key
representation, foreign key, constraint, index, unique constraint, timestamp column, nullability
or database-enforced invariant implementation; **no** identity strategy, category representation,
location normalisation, revision-table shape, publication-state representation, audit storage or
delete/purge representation (`DDM-2`–`DDM-9`); **no** migration tool, migration framework,
migration format, migration file, migration content or schema-evolution strategy (`DDM-10`);
**no** SQL of any kind; **no** connection pooler, pool size, pool configuration, connection
string, connection method or TLS configuration; **no** PostgreSQL version; **no** DigitalOcean
region, tier, plan, sizing, account, billing or cluster, and **it authorizes no provisioning**;
**no** credential, secret, secret name or environment variable; **no** Render configuration or
database connectivity implementation; **no** backup mechanism, independent-copy destination,
tooling or schedule, and **no** restore automation; **no** database or integration-test
infrastructure, container technology, Docker image, CI database service or mocking strategy;
**no** coverage provider, coverage threshold or testing-depth policy (`DG-4`); **no**
authentication mechanism, credential policy or identity store; **no** search implementation;
**no** API, UI or search behaviour; and **no** package version — nothing is installed, no
`package.json` or `package-lock.json` change is made, and no file under `src/` is created or
modified.

`DDM-2`–`DDM-9` remain **unresolved**. `DDM-10` remains **unresolved**. `DG-2` remains
**`Resolved`** (2026-08-27, issue #93) and is not reopened. `DG-4` remains **`Unresolved`**.
`ADR-012` is unchanged. **No accepted ADR is amended, reopened or superseded.** No physical
schema, index, migration or infrastructure resource exists, and **no persistence implementation
exists**.

## Mutable-fact verification

**Verification date: 2026-09-09.** External facts above were verified against authoritative
current sources on that date and are **decision-time evidence, explicitly non-normative**. They
must be **re-verified before any implementation**, per the discipline `ADR-012` and `ADR-013`
established for mutable tooling and provider facts.

Three classes of statement appear in this document and are kept distinct: **repository decision
facts** (cited to their ADR or document), **externally verified current facts** (in *Current
external facts*, sourced below), and **analysis and inference** (the comparison, the `DDM-10`
classifications and the recommendation). No inference is presented as an official product
guarantee, and no service-level commitment is asserted for any product or provider.

Sources consulted:

- npm registry package metadata — `prisma`, `prisma` dist-tags, `drizzle-orm`, `drizzle-kit`,
  `kysely`, `pg`.
- Prisma official documentation — the ORM overview and the release/maturity-level reference; and
  the official Prisma roadmap post on the version-8 line.
- Drizzle ORM official documentation — transactions, and the PostgreSQL/node-postgres
  getting-started guide.
- Kysely official documentation — migrations, transaction examples, dialects, and raw SQL; and
  the Kysely project repository for the PostgreSQL dialect's transaction behaviour.
- DigitalOcean official documentation — Managed PostgreSQL limits, including supported
  PostgreSQL versions, connection limits, connection pooling and point-in-time-recovery window.

## Owner-decision status and lifecycle

**Status: `Accepted`. In force since 2026-09-11. Later `C9` implementation may rely on it.**

**Owner acceptance has occurred.** The product owner ruled on **2026-09-11** that **Kysely will be
the PostgreSQL data-access approach for `C9`**, through the separate governed acceptance work unit
recorded on **issue #117**, following this document's `Proposed`-stage publication of
**2026-09-09** (**issue #115**, **PR #116**) and the mandatory detailed owner review of it. The
owner could have selected any option compared here, including one this document rejects; the
rejection rationale is preserved so that the argument survives the ruling (`IR-6`).

**What acceptance put in force, and what it did not.** Acceptance puts the **access-approach
decision** in force and **nothing more**. It **installs Kysely nowhere** and authorizes **no**
dependency installation, **no** `C9` implementation, **no** driver/client or pooler selection,
**no** schema, index or constraint, **no** migration and **no** provisioning — each remains a
separate later work unit requiring its own owner authorization. **The separately governed `DDM-10`
work unit is required regardless, and is not created by this document.**

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-DATA-01`, `NFR-DATA-02`, `NFR-DATA-03`, `NFR-DATA-06`; `NFR-SEC-08`; `NFR-MAINT-03`; `NFR-REL-04`; `NFR-PRIV-01`, `NFR-PRIV-02`; `FR-ADM-10`, `FR-ADM-10b`, `FR-AUD-01`, `FR-AUD-06` — as constraints the later implementation must satisfy, none proven here |
| **Journeys** | `V1`–`V7`, `L1`–`L4`, `A3`–`A7` — served transitively through `C9`; none implemented here |
| **Components** | **`C9`** — Listing Repository, the single data-access path (`docs/07`; `ADR-002` `O-1`). `C4`–`C8` are unaffected and remain `P2`–`P4` work |
| **Invariants** | `DI-1`–`DI-11`, `BI-7`, `BI-8` — this decision breaches none and **proves none**; they are proven at the level they are enforced (`IP-5`), which for atomicity is the integration level in a later slice |
| **Documents amended** | **At the earlier `Proposed` stage (issue #115, PR #116):** this file, `docs/adr/README.md` (register row and the in-force summary) and `docs/traceability-matrix.md` (register row) — the `Proposed`-stage surface established by `ADR-013` (PR #102). **At acceptance (issue #117), by owner ruling on the acceptance file surface:** this file, `docs/adr/README.md` (the `ADR-014` register row and the derived decisions-in-force count, recalculated from eight to nine), `docs/traceability-matrix.md` (register row) and **`src/data/README.md`** — whose *"No ORM, data-access library, driver, or pooler is selected"* is a present-tense **repository** claim that acceptance makes partially false, corrected minimally and documentation-only, with the driver/client and pooler deferrals preserved. **`docs/07`, `docs/08`, `docs/11`, `docs/12` and `docs/13` remain deliberately untouched** at both stages, by the same owner ruling: no statement in them becomes false, and each records migration tooling and physical data design as deferred, which remains true. **`docs/08`'s `DDM-10` row is left unamended.** **No gate is marked `Resolved`** — `DG-2` was already `Resolved` (2026-08-27, issue #93) and this ADR is not a constituent of it; `DG-4` is unchanged |
| **Issue / pull request** | **Proposed:** issue **#115** — `architecture: decide the PostgreSQL data-access approach for C9`; pull request **#116** — `docs: propose ADR-014 Kysely for C9 PostgreSQL data access`, merged 2026-09-09. **Accepted:** issue **#117** — `architecture: accept ADR-014 Kysely for C9 PostgreSQL data access` |
