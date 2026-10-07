# `ADR-020` — Represent the MVP location attributes as free text, adopting no country standard, reference table, curated list, validation library or external service (`DDM-5`)

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-07 (issue #161). The Product Owner's **binding ruling was given on issue #161 before this document was drafted**, and is recorded verbatim below |
| **Date** | 2026-10-07 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-07:** *Option A* — free text for all four location attributes, subject only to `OQ-6`'s existing presence requirements and reasonable governed length constraints; Options B, C and D are **rejected for the MVP** |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision. `DDM-5`'s *Blocked on* cell in `docs/08` is **"— (open; physical)"** — nothing held it |
| **Related open questions** | **Depends on:** nothing unresolved. `OQ-6` is **Decided** (2026-07-31, issue #48) and supplies the attribute set and its obligations; `ADR-003`, `ADR-006`, `ADR-013`, `ADR-014`, `ADR-016`, `ADR-017`, `ADR-018` and `ADR-019` are all **`Accepted`** and supply every remaining constraint. **Must NOT answer:** **`OQ-5`/`DDM-3`** category representation, cardinality and curation; **`OQ-4`/`DDM-4`** searchable fields, indexing and text search; **`VR-S3`**'s exact safety and length boundaries (`DD-1`/`DD-2`); `DDM-2`'s **domain carrier type**, **revision identity domain type** and **public identity transport**; `DDM-7`, `OQ-12`, `OQ-14`/`NOQ-8`; **PostgreSQL version**, **extension policy**, **provisioning**, region, tier, sizing, TLS, credentials, secrets, pool and pooler; **CI migration validation**; **production migration execution**; the **first schema migration**; `DG-3`, `DG-4` |
| **Supersedes** | *none* — `ADR-017` is **not** superseded. It **excluded** `DDM-5` deliberately, and this ADR fills that exclusion rather than revising it |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-07 (issue #161). In force; later work may rely on it.**
> **It authorizes no implementation.** No schema, migration, DDL, seed data, validation code,
> dependency, provisioning or persistence code is created by this document or by its acceptance.

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

**The same sequence as `ADR-019`, and recorded for the same reason.** Issue #161 framed the
options, classified `DDM-5` as the next gate and **requested** a ruling, marking its own
recommendation *"advisory only, and not binding until the Product Owner rules"*. The Product
Owner then **ruled on issue #161 before this file existed**.

The register defines `Proposed` as *"drafted and under review; the decision is not yet in
force"*. A proposal exists to **obtain** a ruling. Here the ruling arrived first, so there is
nothing left to propose, and a `Proposed` status would describe as pending a decision the
accountable owner has already taken.

This follows the precedent `ADR-019` established on 2026-10-07 (issue #159, PR #160) for exactly
this chronology, and its mechanical shape is `ADR-018`'s acceptance unit: the `Accepted` status
is written on a decision branch and reaches `main` through the pull request carrying it. **No
gate is opened**, and **`Accepted` does not mean implemented** — it means the rule is in force
and later work may rely on it.

## Context

**`OQ-6` fixed *which* location attributes exist and their obligations, and deliberately fixed
nothing about how they are stored.** Decided 2026-07-31 (issue #48): **`locality` required**,
**`country` required**, **`administrativeArea` optional**, **`postalCode` optional**. `docs/08`
records what it did *not* do, in its own words — it selected

> **no** country list, format library, validation expression, storage type, or external service.

**`ADR-017` excluded `DDM-5` twice, on purpose.** In *Explicitly outside this design*:

> **Explicitly outside this design:** the representation of **category** (`DDM-3`, held by
> `OQ-5`) and of **location normalisation** (`DDM-5`). The listing and revision structures
> **will carry** category and location attributes, but **how** those are represented is not
> selected here.

and in its *Open questions this decision must NOT answer* table: *"`DDM-5` — location
normalisation | Excluded; location attributes are named only as content the structures carry."*
Its Risks table then names the failure this ADR exists to prevent:

> | **Category or location representation smuggled into the first schema** | `DDM-3` (`OQ-5`) or
> `DDM-5` decided by accident | Both explicitly excluded |

`ADR-018` repeats the exclusion for the migration policy: *"`DDM-3` category representation
(`OQ-5`), `DDM-5` location normalisation | No table, column or type is named; the proposal
authorizes no schema."*

**Why the decision is taken now.** The first schema migration must declare a listing structure
carrying required `locality` and required `country`. Free text, a reference table and a
standardised code are *structurally different* schemas, so the migration cannot be written
without this choice — and writing it without a ruling is precisely the accident `ADR-017`
flagged. `docs/13` records that retrofitting location *"means backfilling every record"*, so the
cheapest moment to choose is now, at **zero rows**.

**Requirements and obligations this decision answers to.** `FR-DATA-04` (locality),
`FR-DATA-05` (administrative area), `FR-DATA-06` (country), `FR-DATA-06b` (postal code, public
only where provided *and* designated public); `FR-VAL-01` and `VR-S1` (required at initial
submission); `VR-S3` (format and safety checks for optional values that were supplied — its
exact boundaries deferred to `DD-1`/`DD-2`); `PS-2`/`DDM-6` (a mandatory public-display
designation stored beside each conditionally public value); `PA-1` (the directory is small at
first release) and `NFR-MAINT-03` (single maintainer, core behaviours covered by tests).

## Repository evidence

**Separated deliberately from the general engineering considerations that follow.** All of it was
read from the working tree.

| Evidence | Where | What it settles |
|---|---|---|
| `OQ-6` **Decided**: locality required, country required, administrative area optional, postal code optional | `docs/08:1029`; `docs/13:143`; `docs/07:1569` | The attribute set and its obligations — **unchanged by this ADR** |
| `OQ-6` selected **no** country list, format library, validation expression, storage type or external service | `docs/08` `DDM-5` row | Adopting any of those would answer a question `OQ-6` left open |
| `DDM-5`'s *Blocked on* cell is **"— (open; physical)"** | `docs/08:1073` | **Nothing held this decision** — it was decidable as soon as it was asked |
| `DDM-3` is **held by `OQ-5`** (cardinality, curation), and *"implementing category persistence requires `OQ-5` and `DDM-3` to be resolved first"* | `docs/08:1071`; `ADR-017` | Category is a **separate, later** gate and is **not** decided here |
| The domain models location as plain strings: `locality: string`, `country: string`, `administrativeArea?: string`, `postalCode?: DesignatableValue` | `src/domain/listing/listing.ts` | A **logical** model only (`docs/08` **P6**, *Logical is not physical*); it commits no column type, which is why `ADR-017` could exclude `DDM-5` |
| `postalCode` is a `DesignatableValue` — value plus a mandatory public-display designation | `src/domain/listing/listing.ts`; `PS-2` | Whatever representation is used must keep the designation **beside** the value |
| `validation.ts` implements **blankness only**: *"no regular expression, length limit, normalization, formatting policy, or email/phone/URL semantics is introduced, and no validation library is used"* | `src/domain/listing/validation.ts:18-22` | **No exact length limit is governed anywhere today** |
| *"every safety/length boundary `VR-S3` leaves to `DD-1`/`DD-2`"*, and `DDM-5` named among what is *"not decided here and therefore not implemented"* | `src/domain/listing/validation.ts:28-30` | Exact numeric bounds are `VR-S3` → `DD-1`/`DD-2`, **not this ADR** |
| No country list, postal-code pattern, geographic lookup or validation dependency exists anywhere | `src/`, `package.json` | Nothing to preserve, and nothing adopted |
| Nothing persists: no schema, no `.sql` file, no `C9` repository, query, connection or pool configuration; `src/data/migrations/` holds only its `README.md` | `src/data/` | **Zero rows exist**, so no backfill is owed today |
| No database is provisioned; no PostgreSQL version, region, tier or sizing selected | `ADR-013` | This decision needs none of them, and selects none |
| Revision rows carry **a complete proposed content set with designations** | `ADR-017` `PS-3` | The representation applies to **both** the listing and revision structures |
| `DDM-4` is excluded: *"no index or search structure is selected; the pending-revision uniqueness constraint is integrity, not performance"* | `ADR-017` | Indexing and text search stay out, and this ADR adds none |

## Decision

**The Product Owner's binding ruling, given on issue #161 on 2026-10-07 and recorded here
verbatim:**

> Product Owner ruling: Select Option A for DDM-5. Store locality, administrativeArea, country
> and postalCode as free text, subject only to the presence requirements already established by
> OQ-6 and reasonable governed length constraints. This does not make every field mandatory or
> change any existing required/optional status. Do not adopt a country standard, reference
> table, curated list, validation library, new formatting expression or external location
> service. Options B, C and D are rejected for the MVP. Future normalization remains separately
> governed and may be introduced through an additive migration. This ruling does not authorize
> the first schema migration or implementation.

**The decision, item by item. All nineteen are in force.**

1. **The MVP location representation is free text.**
2. It applies to exactly four attributes: **`locality`**, **`administrativeArea`**, **`country`**
   and **`postalCode`**.
3. **`OQ-6` remains authoritative** for each attribute's presence and optionality: `locality`
   **required**, `country` **required**, `administrativeArea` **optional**, `postalCode`
   **optional**.
4. **This ADR does not make any optional attribute required.**
5. **This ADR does not make any required attribute optional.**
6. **No canonical country standard is selected** — no code set, no fixed-width code, no named
   international standard.
7. **No reference table and no foreign key** is selected for location normalisation.
8. **No curated location list** is selected, and no curation owner is named — because there is
   nothing to curate.
9. **No validation library and no new formatting expression** is selected. `validation.ts`'s
   existing blankness-only posture is unchanged, and `VR-S3` is neither implemented nor narrowed.
10. **No external location service** is selected — no geocoding, no postal-code lookup, no
    address verification.
11. **Options B, C and D are rejected for the MVP** — see *Alternatives considered*. None is
    rejected as technically invalid.
12. **Future normalisation remains separately governed.** This decision is an MVP representation,
    **not** a permanent preference, and it **does not prohibit** normalisation.
13. **Later normalisation should be introduced additively** when separately authorized —
    consistent with `ADR-018`'s forward-only default.
14. **No existing data requires backfill today**, because **no schema and no rows exist**.
15. **The first migration may represent these four attributes without a normalisation table, a
    standard-code dependency or seed data.**
16. **This ADR does not authorize that migration**, which remains a separately authorized later
    unit (`ADR-018`).
17. **It does not decide category representation** — `DDM-3`/`OQ-5` remains unresolved and still
    blocks category persistence.
18. **It settles no remaining `DDM-2` matter** — the domain carrier type, the revision identity
    domain type and public identity transport all remain open.
19. **It decides no indexing, text search, transport, provisioning or persistence** —
    `DDM-4`/`OQ-4`, identity transport, `ADR-013`'s provisioning items, CI migration validation
    and production execution are all untouched.

### Length constraints — an obligation, not a number

**No authoritative requirement establishes an exact length limit for any of the four
attributes.** The repository is explicit about this: `validation.ts` records that it introduces
*"no regular expression, length limit, normalization, formatting policy"* and that *"every
safety/length boundary `VR-S3` leaves to `DD-1`/`DD-2`"*. No `FR-*`, `NFR-*`, `docs/08`,
`docs/09` or `docs/10` statement names a character count.

Therefore:

- The ruling's **"reasonable governed length constraints" is recorded as an implementation
  obligation**, not as a value. Whatever bound is eventually applied must be *governed* — written
  down and reviewable — rather than improvised.
- **No numeric bound is invented here.** Selecting one would answer `VR-S3`/`DD-1`/`DD-2` by
  accident, which is the same class of error `ADR-017` guarded against for `DDM-5` itself.
- **Exact numeric bounds, if the first schema or a validation slice needs them, are a narrow
  later decision** under `VR-S3` → `DD-1`/`DD-2`. Naming that prerequisite is this ADR's
  contribution to it; deciding it is not.
- **PostgreSQL storage and application validation are distinct.** PostgreSQL's `text` type
  requires **no** declared length, so **the absence of a numeric bound does not block the first
  migration**: a free-text column can be declared today, and an application- or database-level
  bound added later additively. **A `varchar(n)` length must not be chosen merely because a
  migration needs a type** — that would convert a missing decision into a silent one.
- **The absence of numeric bounds does not reopen normalisation.** Items 6–11 stand on their own;
  length is a separate axis entirely.

## Rationale

### From repository evidence

- **It is the only option that answers no question `OQ-6` left open.** `OQ-6` selected no country
  list, format library, validation expression, storage type or external service. Options B and C
  each require adopting one, and D requires two.
- **The existing authoritative obligation is already satisfied.** `locality` and `country` are
  required and `administrativeArea`/`postalCode` optional under `OQ-6`; free text carries all
  four without altering any of it, and `VR-S1`'s presence rule is already implemented in
  `validation.ts`.
- **The domain already matches.** `locality: string` and `country: string` need no change, and
  `docs/08` **P6** keeps that logical shape free of any physical commitment.
- **No schema, no rows and no provisioned database exist**, so the normalisation that this
  decision defers costs **nothing** to defer today.
- **`ADR-017` and `ADR-018` excluded location representation precisely to prevent accidental
  selection**; filling the exclusion with an explicit, minimal ruling is what they asked for.
- **`postalCode`'s designation survives**: a free-text value keeps its mandatory designation
  beside it exactly as `PS-2` requires.

### General engineering considerations

- **Normalisation is cheapest to add and most expensive to remove.** An additive column or table
  plus a backfill is a well-understood migration; unwinding a reference table after rows exist
  is not.
- **A curated list without an owner decays.** Options B and C each imply a maintainer for the
  list, which `NFR-MAINT-03`'s single-maintainer reality makes a real cost rather than a detail.
- **Locality has no stable international standard**, so normalising it would require inventing a
  taxonomy rather than adopting one.

## Alternatives considered

Rejection rationale is preserved under `IR-6` so that it cannot be silently re-made. **None of
these is technically invalid**, and each offers something this decision gives up.

### Option B — reference table(s) with a foreign key — rejected for the MVP

**What it offers:** canonical values from the very first record; reliable grouping and filtering;
referential integrity enforced by the database rather than by convention; immunity to spelling
variants.

**Why it is premature.** It requires **adopting a list `OQ-6` deliberately did not select** and
**naming its curation owner** — a new product decision this ruling declines. It puts **seed
data inside a schema migration**, enlarging the first migration materially. It echoes the
unresolved `OQ-5`/`S-3` question — *"if administrators curate the set, the category set becomes
mutable data, not configuration"* — for locations instead of categories, and that question is
not asked, let alone answered. And **locality has no stable standard to anchor it**, so the
normalised set would be invented rather than adopted. It remains available later, additively.

### Option C — free text plus a standardised `country` code — rejected for the MVP

**What it offers:** a real middle path. `country` is required on every record and is the one
location attribute with a genuinely stable international standard, so constraining it alone
would buy canonical country values cheaply, without inventing a locality taxonomy.

**Why it is premature.** It **contains a product decision** — *which* standard — that `OQ-6`
expressly left unselected, so it cannot be adopted without making that decision. It also moves
`country` from free text to a constrained vocabulary, which pulls a membership rule into
`validation.ts` (today deliberately blankness-only) and raises a code-versus-display-name
question at the transport boundary that `DDM-2`'s transport matter has not reached. It remains
the most likely first step if normalisation is later authorized.

### Option D — external location service or validation/formatting library — rejected for the MVP

**What it offers:** real geographic verification — that a locality exists, that a postal code is
well-formed and consistent with its country — which free text cannot provide at all.

**Why it is premature.** `OQ-6` explicitly selected *"no format library, validation expression,
or external service"*. It would add a **runtime dependency** and, for a service, an **external
availability dependency** to a single-maintainer MVP (`PA-1`, `NFR-MAINT-03`), with its own
failure modes on the submission path. No requirement asks for geographic verification. It is
recorded as rejected so it is not re-proposed.

### Deferring `DDM-5` again — rejected

Deferral is how the representation gets chosen by whoever writes the first migration — the exact
accident `ADR-017` named as a risk. At zero rows the window to choose deliberately is open and
free; after the first migration it is neither.

## Consequences

**Positive:**

- **Minimal physical representation** — four text attributes per structure, nothing more.
- **No reference data and no seed-data requirement**, so the first migration stays a schema
  migration rather than a data migration.
- **No curator and no curation process** to establish or sustain.
- **No additional runtime dependency** is added.
- **No location-service availability dependency** on the submission path.
- **The first migration can remain focused** on the physical design `ADR-017` actually selected.
- **The existing domain and its tests need no change**, and `validation.ts`'s posture is
  untouched.

**Tradeoffs and obligations this decision accepts:**

- **No canonical location values.** Nothing guarantees that two records naming the same place
  spell it the same way.
- **Spelling and formatting variants are possible** from the first submission onward
  ("Springfield", "springfield", "Springfeild"; "USA", "U.S.A.", "United States").
- **Filtering and geographic browsing must tolerate non-canonical values** — a constraint on
  `FR-SRCH-*` work and on anything `docs/10` later builds, and one that `OQ-4`/`DDM-4` will have
  to design around rather than assume away.
- **The cost of future normalisation grows as records accumulate.** It is nil today and rises
  monotonically.
- **Later normalisation may require an additive structure and a backfill**, including a decision
  about what to do with values that do not map cleanly.
- **Free text does not validate geographic truth.** A submitter may enter a place that does not
  exist, and nothing here detects it.
- **A governed length bound is owed** by whatever implements storage or validation, and its exact
  value remains an open narrow decision (`VR-S3`, `DD-1`/`DD-2`).

**This is an MVP representation, not a permanent preference.** Normalisation is **not
prohibited**; it is deferred, separately governed, and expected to arrive additively if and when
it is authorized.

**Reversibility:** **good, and best exercised before rows accumulate.** Adding a normalised
structure later is an additive migration plus a backfill that is **empty today**. What grows is
the backfill, not the difficulty of the schema change.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`PA-1`** — the directory is small at first release | Variant spellings become a visible data-quality problem sooner, and normalisation moves up the queue; the decision is still reversible additively |
| A **single maintainer** does this work (`NFR-MAINT-03`) | With more contributors, a curated list's cost falls and Option B or C becomes more attractive; this is the first thing to revisit |
| No **geographic verification** requirement emerges in the MVP | Option D would need its own authorized decision, with its dependency and availability costs assessed then |
| `OQ-6` remains the authority for which location attributes exist and their obligations | A change there is a new product decision; this ADR's representation choice would survive it unchanged |
| Exact length bounds remain unselected until `VR-S3`/`DD-1`/`DD-2` is addressed | If a bound is needed sooner, it is a narrow later decision — **not** a reason to revisit free text |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| A later contributor reads "free text" as "no constraints at all" | Unbounded input reaches storage, a safety concern `VR-S3` exists to address | The *Length constraints* section records the bound as an **obligation**; `VR-S3`/`DD-1`/`DD-2` owns the value |
| The first migration selects a `varchar(n)` to satisfy the type system | `VR-S3`/`DD-1`/`DD-2` decided by artifact | Stated explicitly: `text` needs no length, and a length must not be chosen merely because a migration needs a type |
| Variant spellings accumulate before anyone notices | Locality filtering returns partial results, and normalisation gets more expensive | Recorded as an accepted tradeoff and as a consequence `OQ-4`/`DDM-4` must design around, not assume away |
| This ADR is read as prohibiting normalisation | A legitimate later improvement is treated as closed | Items 12–13 state the opposite, and Option B and C rejections are explicitly "premature", not "invalid" |
| Location representation is later confused with category representation | `OQ-5`/`DDM-3` decided by accident | Item 17, and `ADR-017`'s own risk row, keep them separate; category remains blocked by `OQ-5` |

## Open questions this decision must NOT answer

- **`OQ-5` / `DDM-3`** — category cardinality, curation and representation. **Still the next
  schema gate**, and still blocked by `OQ-5`.
- **`OQ-4` / `DDM-4`** — searchable fields, matching mode, indexing and text search.
- **`VR-S3`** safety and format boundaries, and their **exact numeric length values**
  (`DD-1`/`DD-2`).
- **`DDM-2`'s** domain carrier type, revision identity domain type and public identity transport.
- **`DDM-7`** audit-entry storage; **`OQ-12`** duplicate detection; **`OQ-14`/`NOQ-8`**.
- **PostgreSQL version, extension policy, provisioning**, region, tier, sizing, TLS, credentials,
  secrets, pool and pooler.
- **The first schema migration**, its contents and its exact column names and types.
- **CI migration validation**; **production migration execution**, deployment integration and
  authority.
- Any **decision-gate status** — none changes.

## Traceability

- **`DDM-5`** (`docs/08-data-model.md`) — location normalisation; **discharged by this ADR** as
  to the MVP representation.
- **`OQ-6`** (Decided 2026-07-31, issue #48) — the attribute set and obligations; **authoritative
  and unchanged**.
- **`ADR-017`** — the physical listing design that **excluded** `DDM-5` and named its accidental
  selection as a risk; **unchanged and not superseded**.
- **`ADR-018`** — migration authoring, invocation, execution and rollback policy, which also
  excluded location representation; **unchanged**. Its forward-only default is the path any later
  normalisation takes.
- **`ADR-019`** — application-generated UUID v4 identity; **unchanged**, and untouched by this
  decision.
- **`ADR-013`** — the named provider, with **no version, region, tier, sizing or provisioning
  selected**; read, not amended.
- **`FR-DATA-04`, `FR-DATA-05`, `FR-DATA-06`, `FR-DATA-06b`** — the four attributes.
- **`FR-VAL-01`, `VR-S1`** — required at initial submission; **`VR-S3`** — format and safety for
  supplied optional values, exact boundaries deferred to `DD-1`/`DD-2`.
- **`PS-2` / `DDM-6`** — the mandatory public-display designation stored beside `postalCode`.
- **`PA-1`, `NFR-MAINT-03`** — the small-directory and single-maintainer realities.
- **Issue #161** — the decision issue that framed the options, classified `DDM-5` as the next
  gate, and carried the binding ruling.

**No implementation evidence is claimed by this ADR.** No schema exists, no migration exists, no
seed data exists, no validation code was added, no dependency was added, no database is
provisioned, and `C9` persistence is not implemented. Each remains a separately authorized later
unit, and **`DDM-3`/`OQ-5` remains the next gate before the first schema migration.**
