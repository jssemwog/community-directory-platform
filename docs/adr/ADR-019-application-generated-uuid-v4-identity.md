# `ADR-019` — Generate listing and revision UUID v4 identifiers in the application, and declare no PostgreSQL generation default (`ADR-017`'s outstanding `DDM-2` item)

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-07 (issue #159). The Product Owner's **binding ruling was given on issue #159 before this document was drafted**, and is recorded verbatim below |
| **Date** | 2026-10-07 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-07:** *Option A* — the application assigns the identifiers; `PostgreSQL` enforces type, uniqueness and not-null and declares **no** generation default; Options B and C are **rejected** |
| **Decision gate** | *none* — `DG-2` is **`Resolved`** (2026-08-27, issue #93) and this ADR is **not** one of its constituents. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision. `DDM-2` carries **no blocker** in `docs/08` |
| **Related open questions** | **Depends on:** nothing unresolved. `ADR-002`, `ADR-003`, `ADR-005`, `ADR-006`, `ADR-010`, `ADR-012`, `ADR-013`, `ADR-014`, `ADR-015`, `ADR-016`, `ADR-017` and `ADR-018` are all **`Accepted`** and supply every constraint this decision must satisfy. **Must NOT answer:** the identity **format** (already `ADR-017` `PS-1`); **public identity transport**; the **revision identity domain type**; `DDM-3`, `DDM-4`, `DDM-5`, `DDM-7`, and every remaining `DDM-6`, `DDM-8` and `DDM-9` outstanding item; `OQ-4`, `OQ-5`, `OQ-12`, `OQ-14`/`NOQ-8`, `NOQ-9`; **PostgreSQL version**, **extension policy**, **provisioning**, **region**, **tier**, **sizing**, **TLS**, **credentials**, **secrets**, application **pool configuration** and any **external pooler**; **CI migration validation**; **production migration execution**; `DG-3`, `DG-4` |
| **Supersedes** | *none* — `ADR-017` is **not** superseded. It remains `Accepted` and retains full authority over the identity **format** |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-07 (issue #159). In force; later work may rely on it.**
> **It authorizes no implementation.** No generator, no schema, no migration, no provisioning
> and no persistence code is created by this document or by its acceptance.

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

**Read this before comparing it to earlier ADRs, because the sequence genuinely differs.**

`ADR-013`, `ADR-014`, `ADR-015`, `ADR-016`, `ADR-017` and `ADR-018` each reached `Accepted`
through **two** governed units: a *decide* issue that published the ADR as **`Proposed`**, and a
**separate** acceptance issue and pull request that recorded the Product Owner's ruling and
flipped the status. `ADR-013` is the clearest instance — `Proposed` 2026-09-01 (issue #101,
PR #102), `Accepted` 2026-09-03 (issue #103) — and `ADR-018` the most recent: `Proposed`
2026-09-27 (issue #153, PR #154), `Accepted` 2026-09-28 (issue #155, PR #156).

**In every one of those cases the proposal existed in order to obtain a ruling that had not yet
been given.** That is what a `Proposed` ADR is for: the register defines the status as *"drafted
and under review; the decision is not yet in force"*.

**Issue #159 inverted that order.** It framed the decision, presented the options and
**requested** the ruling, explicitly marking its own recommendation *"advisory only, and not
binding until the Product Owner rules"*. The Product Owner then **ruled on issue #159, before
this file existed**. There is consequently nothing left to propose: a `Proposed` status would
describe a decision as pending when the accountable owner has already taken it, which would be
the less accurate record, not the more cautious one.

The mechanical shape is unchanged from `ADR-018`'s acceptance unit: the `Accepted` status is
written on a decision branch and reaches `main` through the pull request that carries it. What
is compressed is the **number of units**, not the governance — and it is compressed because the
ruling arrived first. **No gate is opened by this document**, and acceptance remains, as always,
**not implementation authority**.

## Context

**`ADR-017` (`Accepted` 2026-09-17, issue #137) discharged `DDM-2`'s identity *strategy* and
deliberately left its *locus* open.** Its `PS-1` selection reads:

> We select that listing identity and revision identity each be an opaque, randomly generated
> 128-bit UUID (version 4), assigned once at creation, never reused, never derived from content,
> and never changed.

and, in the same selection:

> **Generation locus is not decided here.** Generation in `C9` or by a database default are both
> compatible with this decision; the choice depends on the PostgreSQL version, which is
> **unselected** (`ADR-013`).

`PS-1` also **selected** that the public listing identity is the same value as the storage
primary key, and **excluded** sequences, integers, identity columns and time-ordered identifiers
(UUID v7, ULID) as the public identity: a sequence lets an observer enumerate records and infer
ordering, which `BI-4` forbids, and a time-ordered value embeds a creation timestamp that
`FR-DATA-11` and `NFR-PRIV-01` keep non-public.

**`ADR-018` (`Accepted` 2026-09-28, issue #155) named this locus as a prerequisite it does not
decide**, and issue #157 / PR #158 then built the **schema-neutral** migration infrastructure,
which contains no DDL at all.

**Why the decision is taken now.** The locus is settled by artifact the moment anyone writes
`DEFAULT gen_random_uuid()` into the first migration — or deliberately omits it. `ADR-017` makes
the same point from the other side: reversal is cheapest **before the first migration**, at zero
data volume. Deciding it now is the only moment at which the decision is free.

**Requirements and obligations this decision answers to.** `BI-4` (no count or ordering
artefact); `FR-DATA-11`, `NFR-PRIV-01` and `NFR-DATA-04` (non-public administrative data);
`DI-8` (identity stable and content-independent); `BI-7`, `DI-3` and `NFR-DATA-03` (transactional
completeness, which `C9` owns); `NFR-MAINT-03` (core behaviours covered by automated tests, and
the single-maintainer reality); `docs/09` `OP-2` (an unauthenticated visitor provides *"the
identity of one listing"*, validated in shape, including by following a previously shared direct
link).

## Repository evidence

**Separated deliberately from the general engineering considerations that follow it.** All of
this was read from the working tree, not inferred from documentation.

| Evidence | Where | What it settles |
|---|---|---|
| The identity format is already governed — opaque random UUID v4 | `ADR-017` `PS-1` (`Accepted`) | This ADR decides **only** the locus |
| `submitListing(id: ListingId, content: ListingContent, at: Instant)` — identity is the **first parameter** | `src/domain/listing/listing.ts:126` | A listing cannot be constructed without an identifier |
| `readonly id: ListingId` is **required** on `Listing` | `src/domain/listing/listing.ts:84` | Identity is not optional at any point in the domain |
| Every domain function is pure: it reads no clock, no store and no environment | `src/domain/listing/*.ts` | The domain cannot acquire an identifier for itself |
| `ListingId` wraps a value typed `unknown`; *"Choosing `string` or `number` here would pick a carrier for identity, and picking a carrier is the first half of `DDM-2`"* | `src/domain/listing/listing-id.ts` | The carrier is uncommitted, and this ADR does **not** commit it |
| `listingIdOf(supplied: unknown)` **wraps**; `listingIdEquals` compares. There is no generator | `src/domain/listing/listing-id.ts` | The value-object module is construction and equality only |
| *"generates nothing — the module offers only wrapping and comparison (`DDM-2`)"* asserts the export surface is exactly `["listingIdEquals", "listingIdOf"]` | `src/domain/listing/listing-id.test.ts:93` | A deliberate tripwire: adding a generator to that module **fails this test** |
| `randomUUID`, `uuid` and `gen_random_uuid` appear in **no** `.ts` or `.tsx` file | `src/` | No identity generator exists anywhere today |
| `crypto.randomUUID()` — a UUID v4 generator — is present in the declared runtime (`engines.node >= 22.12.0`; verified on Node 22.12.0) | `package.json`, Node standard library | Application generation needs **no new dependency** |
| Eight test files construct `listingIdOf("listing-1")`, `"listing-2"`, `"listing-3"` and assert identity equality and inequality | `listing-id`, `status`, `publication`, `public-projection`, `retention`, `revision`, `timestamps` test files | Deterministic caller-supplied identifiers are load-bearing for the existing suite |
| `ListingRevision` carries `listingId`, `state`, `proposedContent` and an optional `rejectedAt` — and **no identity of its own** | `src/domain/listing/revision.ts:59` | Revision identity exists physically (`PS-1`) but has **no domain type yet**; creating one is a later slice |
| The public projection carries **no identifier field**, because *"how public listing identity is transported is not decided here"* | `src/domain/listing/public-projection.ts:42` | Transport remains separately governed, and this ADR does not decide it |
| No schema, no `.sql` file, no `C9` repository, no query, no connection or pool configuration | `src/data/` | Nothing persists today |
| `src/data/migrations/` contains only its `README.md` | `src/data/migrations/` | No migration exists |
| No PostgreSQL version, region, tier, sizing or provisioning is selected | `ADR-013` (`Accepted`) | A database default has an unmet prerequisite; application generation has none |

## Decision

**The Product Owner's binding ruling, given on issue #159 on 2026-10-07 and recorded here
verbatim:**

> Product Owner ruling: Select Option A. The application assigns UUID v4 identifiers for new
> listings and revisions. PostgreSQL stores them as UUID primary keys with not-null and
> uniqueness enforcement, but no normal generation default. Options B and C are rejected.

**The decision, item by item. All sixteen are in force.**

1. **The application is the sole normal generator** of new listing and new revision UUID v4
   identifiers. There is exactly **one normal authority**, and it is the application.
2. **The identifier format remains governed by `ADR-017` `PS-1`** — opaque, randomly generated
   128-bit UUID version 4, assigned once at creation, never reused, never derived from content,
   never changed. **This ADR does not restate, narrow or widen that format decision**, and
   `ADR-017` is not superseded.
3. **PostgreSQL stores these identifiers using its `uuid` type.**
4. **PostgreSQL enforces primary-key uniqueness and not-null** on them.
5. **PostgreSQL declares no normal generation default for them** — no `DEFAULT
   gen_random_uuid()`, no sequence, no identity column, no trigger acting as a default.
6. **Database-generated identity is rejected** — see *Alternatives considered*.
7. **Hybrid application-or-database generation is rejected** — see *Alternatives considered*.
8. **The pure domain remains id-first** and **receives an already-generated identifier**. No
   domain function acquires, generates or defaults an identity.
9. **Generation occurs at an application orchestration boundary, before the pure domain
   submission or creation function is called.** The identifier is generated, then passed in.
10. **Generation is not added to the listing-id value-object module** (`listing-id.ts`) for
    convenience or for any other reason. That module stays construction and equality only, and
    its export-surface test stays intact.
11. **The precise application orchestration component is not named here.** Which component owns
    the call — and whether the generator is injected as a seam — is ordinary implementation
    design, settled inside its own separately authorized work unit, subject to items 8–10.
12. **The first schema migration must encode these UUID columns without a generation default**,
    and must record that the omission is deliberate and governed by this ADR.
13. **Direct database writes and any governed import path must provide identifiers explicitly.**
    There is no database-side fallback, by decision.
14. **Boundary validation and database constraints remain mandatory**, not optional: the
    identity shape is validated where it enters the application (`docs/09` `OP-2` already
    requires *"the identity is validated in shape"*), and the primary key, `uuid` type and
    not-null constraints are required regardless of locus.
15. **No PostgreSQL version and no extension policy is selected** by this decision. It is
    deliberately free of both, which is part of why it was chosen.
16. **Nothing is authorized** — not provisioning, not a schema, not a migration, not persistence,
    not public identity transport, not CI migration validation, not production migration
    execution.

### What this decision settles, and what it does not

**It settles**, as of 2026-10-07: the generation locus, the single normal authority, the
database's enforcement-without-generation role, the prohibition on a normal default, the
placement of generation relative to the pure domain, and the rejection of the database and
hybrid alternatives.

**It still leaves open:** the identifier **carrier type** in the domain (`ListingId` keeps its
`unknown` carrier); the **revision identity domain type**; **public identity transport**; the
orchestration component's own name and shape; the **PostgreSQL version** and extension policy;
**provisioning**; the **first schema migration**; **CI migration validation**; and **production
execution, deployment integration, credentials and authority**.

## Rationale

### From repository evidence

- **The executable domain already requires an identifier first.** `submitListing(id, …)` cannot
  build a `Listing` without one, `Listing.id` is required, and every domain function is pure.
  Application generation needs **no new concept and no reordering**; it is what the code already
  expects.
- **The value-object module already refuses to generate, and a test defends that.**
  `listing-id.test.ts:93` pins the export surface to `["listingIdEquals", "listingIdOf"]`. The
  decision's item 10 is therefore not a new restriction — it ratifies a boundary the repository
  already protects.
- **The declared runtime supplies a UUID v4 generator with no added dependency.**
  `crypto.randomUUID()` is in Node's standard library and `engines.node` is already `>=22.12.0`.
- **Deterministic testing is preserved.** Eight test files supply their own identifiers and keep
  working unchanged; identity never becomes ambient.
- **The format question is already closed**, so this decision could not have reopened it and does
  not.

### General engineering considerations

- **Identity known before the write simplifies a multi-row transaction.** Writing a listing and
  a related revision inside one transaction (`BI-7`, `DI-3`, `NFR-DATA-03`) needs no `RETURNING`
  round-trip to learn the parent's identifier.
- **An identifier that exists before the insert is attributable in logs and errors**, so a failed
  write can still be reported against a record identity.
- **One authority is auditable.** "Who assigned this identifier" has exactly one answer.

## Alternatives considered

Rejection rationale is preserved under `IR-6` so that it cannot be silently re-made.

### PostgreSQL-generated UUID v4 — rejected (Option B)

**Not rejected as technically impossible, and not rejected on uniqueness or security.** A
`DEFAULT gen_random_uuid()` column is a perfectly sound design; Kysely supports `returning`
fully; and such a default makes a valid identifier **unavoidable by construction**, which is a
genuine advantage this decision gives up. Database defaults **do not** inherently weaken
uniqueness, and a `gen_random_uuid()` default satisfies `PS-1`'s security properties exactly as
well as application generation does.

It is rejected for two specific reasons:

1. **It conflicts with the current domain construction order.** The domain is pure and id-first,
   so `C9` would have to `INSERT … RETURNING id` and construct the domain object afterwards —
   retiring `submitListing` as the submission entry point — or the domain would need a "not yet
   identified listing" concept it does not have and that nothing asks for.
2. **It introduces an unresolved PostgreSQL-version or extension prerequisite.**
   `gen_random_uuid()` is built into PostgreSQL from version 13 and otherwise requires the
   `pgcrypto` extension, and `ADR-013` has selected **no** PostgreSQL version and provisioned
   nothing. `PS-1` itself anticipated this, recording that the locus *"depends on the PostgreSQL
   version, which is unselected"*. A sequence or identity column is not an escape, because
   `PS-1` forbids it as the public identity. *(Version and extension behaviour is decision-time
   external evidence and must be re-verified against current official documentation before
   provisioning, following `ADR-013`'s own convention.)*

**It remains a legitimate design**, and this rejection is a sequencing-and-fit judgement rather
than a quality claim.

### Hybrid application-or-database generation — rejected (Option C)

The application may supply an identifier; the database generates one when it is absent.

**Rejected because it creates two normal authorities for the same datum**, which is precisely
what a single clear authority excludes. After the fact no invariant distinguishes an
application-assigned identifier from a database-assigned one, so "who assigned this" becomes
unanswerable in support and in audit. It also forfeits both of the properties it appears to
combine: Option A's single-place discipline and Option B's unavoidability. **No repository
requirement demands it** — `docs/01`–`docs/12` state no data-import, offline-creation,
multi-writer or distributed-creation requirement, and inventing one to justify a hybrid would be
speculative. It is recorded as rejected so that it is not re-proposed.

### Deferring the locus again — rejected

Deferral is how the decision gets made by whoever writes the first migration. `ADR-017` already
recorded that reversal is cheapest before the first migration; deferring past that point spends
the cheap window for nothing.

## Consequences

**Positive:**

- **One normal identity authority**, in one place, with one answer to "who assigned this".
- **The pure, id-first domain is preserved** unchanged — no new concept, no inverted construction
  order, no database dependency pushed into domain code.
- **No PostgreSQL extension or minimum-version prerequisite**, so the first schema migration can
  proceed without pulling provisioning or version selection forward.
- **Deterministic testing stays straightforward**: callers supply identifiers, as the existing
  suite already does, and identity never becomes ambient.
- **The schema still enforces identity without generating it** — `uuid`, primary key and
  not-null all remain required.
- **`listing-id.ts` and its export-surface tripwire are untouched**, so the boundary that kept
  `DDM-2` open is the same boundary that now keeps the ruling honest.

**Tradeoffs and obligations this decision accepts:**

- **Direct database writes must provide an identifier.** A `psql` insert that omits one fails on
  the not-null constraint rather than quietly succeeding — intended, and the cost is that no
  database-side convenience exists.
- **Any governed import path must provide, or deliberately generate, identifiers at an
  authorized application boundary.** No import path exists today, and none is authorized here.
- **Application boundary validation is required**, not optional — the identity shape is
  validated where it enters (`docs/09` `OP-2`).
- **Primary-key, `uuid` and not-null enforcement in the database are required**, and are not
  traded away by moving generation into the application.
- **The first migration must deliberately omit a UUID default**, and say that the omission is
  governed by this ADR rather than an oversight.
- **Future application orchestration must handle generator failure appropriately** — a generator
  that cannot produce a value must fail the operation rather than substitute a placeholder,
  reuse a value, or allow an unidentified record to be written.
- **Identity transport remains separately governed work**, and the public projection still
  carries no identifier field.

**Reversibility:** **good, and best exercised before the first migration.** Adding a database
default later is an additive migration; removing one is not much harder. What becomes
progressively more expensive is the **construction order** once write paths and their tests exist
around it — which is exactly why the decision is taken now, at zero migrations and zero rows.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| `crypto.randomUUID()` remains available in the declared Node runtime and remains a version 4 generator | The orchestration boundary selects another UUID v4 source; the locus decision is unaffected, and no dependency decision is pre-made here |
| A single application process is the only normal writer at this stage (`PA-1`, `NFR-MAINT-03`) | With additional writers the single-authority rule matters more, not less; the decision does not change, but boundary validation becomes the only guard worth tightening |
| No data-import or offline-creation requirement emerges in the MVP | An import path would need its own authorized boundary that generates identifiers explicitly — it would **not** reopen the hybrid, which is rejected on authority grounds rather than on convenience |
| `ADR-017`'s `PS-1` remains the identity format | A format change would be a new ADR superseding `ADR-017`; this ADR's locus decision would survive it unchanged |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| A future write path forgets to assign an identifier | The insert fails on not-null, or — worse — a code path constructs an invalid identity | Item 14's mandatory constraints and boundary validation; the domain's required `Listing.id` already makes an unidentified listing inexpressible |
| A later contributor adds a generator to `listing-id.ts` for convenience | The value-object module becomes impure and the `DDM-2` boundary is lost | Item 10 states the prohibition, and `listing-id.test.ts:93` fails the change |
| The first migration is written with a `DEFAULT gen_random_uuid()` out of habit | The rejected option is adopted by artifact | Item 12 requires the omission and its reason to be explicit in that migration's own unit |
| A generator failure is handled by substituting a placeholder or reusing a value | Identity stops being unique and content-independent, breaking `DI-8` | Recorded as an obligation in *Consequences*; the behaviour belongs to the orchestration unit and must be proven by an attacking test there |

## Open questions this decision must NOT answer

- **The identifier format** — already `ADR-017` `PS-1`. Not restated, narrowed or widened.
- **The domain carrier type** — `ListingId` keeps its deliberately `unknown` carrier.
- **The revision identity domain type** — does not exist, and is not created here.
- **Public identity transport** and URL representation.
- **PostgreSQL version, extension policy, provisioning**, region, tier, sizing, TLS, credentials,
  secrets, application pool configuration and any external pooler.
- **The first schema migration**, and any table, column, constraint or index.
- **CI migration validation**; **production migration execution**, deployment integration and
  authority.
- **`DDM-3`, `DDM-4`, `DDM-5`, `DDM-7`**, and every remaining `DDM-6`, `DDM-8` and `DDM-9`
  outstanding item.
- `OQ-4`, `OQ-5`, `OQ-12`, `OQ-14`/`NOQ-8`, `NOQ-9`.
- Any **decision-gate status** — none changes.

## Traceability

- **`DDM-2`** (`docs/08-data-model.md`) — identity strategy discharged by `ADR-017`; **the
  generation locus is discharged by this ADR**.
- **`ADR-017`** — `PS-1`, the identity format and the public-identity-equals-primary-key
  selection; **unchanged and not superseded**.
- **`ADR-018`** — migration authoring, invocation, execution and rollback policy; named this
  locus as a prerequisite it does not decide; **unchanged**.
- **`ADR-013`** — the named provider, with **no version, region, tier, sizing or provisioning
  selected**; read, not amended.
- **`ADR-014`**, **`ADR-016`** — Kysely as the `C9` access approach; `pg` through core
  `PostgresDialect`.
- **`ADR-012`** — Vitest as the implementation-level runner; selects no database or
  integration-test infrastructure.
- **`ADR-006`**, **`DI-8`** — identity stable, content-independent, surviving every edit and
  status change.
- **`BI-4`**, **`FR-DATA-11`**, **`NFR-PRIV-01`**, **`NFR-DATA-04`** — the enumeration and
  timestamp-leakage constraints `PS-1` already answered, and which bind whichever locus is
  chosen.
- **`BI-7`**, **`DI-3`**, **`NFR-DATA-03`** — transactional completeness, owned by `C9`.
- **`NFR-MAINT-03`** — core behaviours covered by automated tests.
- **`docs/09` `OP-2`** — the public operation that provides and shape-validates a listing
  identity.
- **Issue #159** — the decision issue that framed the options and carried the binding ruling.
- **Issue #157 / PR #158** — the schema-neutral migration infrastructure, which decided nothing
  about identity.

**No implementation evidence is claimed by this ADR.** No generator exists, no schema exists, no
migration exists, no database is provisioned, and `C9` persistence is not implemented. Each
remains a separately authorized later unit.
