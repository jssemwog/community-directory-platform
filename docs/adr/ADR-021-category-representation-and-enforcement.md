# `ADR-021` — Store the listing category as a stable repository-owned textual machine key in a PostgreSQL `text` column, enforced by a database `CHECK` constraint over the complete approved key set (`DDM-3`)

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-09 (issue #167). The Product Owner's **binding ruling was given on issue #167 before this document was drafted**, and is recorded below |
| **Date** | 2026-10-09 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-09:** *Option A′* — a stable, repository-owned textual machine key in a PostgreSQL `text` column, enforced by a `CHECK` constraint over the complete approved key set; the **16 machine keys were approved explicitly** in a second ruling on the same issue; Options A, B, C and D are **rejected** |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision. `DDM-3`'s blocker — approval of the initial category vocabulary — was **discharged on 2026-10-08** (issue #165) |
| **Related open questions** | **Depends on:** nothing unresolved. `OQ-5` is **Decided** (2026-10-07, issue #163) and supplies the category model; the **initial vocabulary is approved** (2026-10-08, issue #165) and supplies the 16 labels; `ADR-003`, `ADR-006`, `ADR-010`, `ADR-013`–`ADR-020` are all **`Accepted`** and supply every remaining constraint. **Must NOT answer:** **`OQ-4`/`S-4`/`DDM-4`** keyword-search scope, searchable fields, indexing and text search; **`FR-SRCH-09`** multi-category selection (**unapproved and deferred**); **`OQ-9`**, **`OQ-12`**, **`OQ-14`/`NOQ-8`/`DDM-7`**, **`OQ-15`**; seams **`S-4`**, **`S-7`**–**`S-10`**; `DDM-2`'s **domain carrier type**, **revision identity domain type** and **public identity transport**; **`VR-S3`**'s exact safety and length boundaries (`DD-1`/`DD-2`); `OP-11`'s **wire shape**; **PostgreSQL version**, **extension policy**, **provisioning**, region, tier, sizing, TLS, credentials, secrets, pool and pooler; **CI migration validation**; **production migration execution**; the **first schema migration**; `DG-3`, `DG-4` |
| **Supersedes** | *none* — `ADR-017` is **not** superseded. It **excluded** `DDM-3` deliberately, recording that *"category persistence requires `OQ-5`/`DDM-3` first"*, and this ADR fills that exclusion rather than revising it |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-09 (issue #167). In force; later work may rely on it.**
> **It authorizes no implementation.** No schema, migration, DDL, category configuration,
> reference data, seed data, validation code, equality test, provisioning or persistence code
> is created by this document or by its acceptance.

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

**The same sequence as `ADR-019` and `ADR-020`, and recorded for the same reason.** The
chronology, in order:

1. **`DDM-3` was previously blocked by `OQ-5`.** `docs/08`'s *Blocked on* cell read
   *"Depends on whether administrators curate the set at runtime"* — a product question that
   had to be answered before any physical representation could be chosen.
2. **`OQ-5` selected the controlled category model** — Decided 2026-10-07 (issue #163,
   PR #164): **exactly one required** category per listing, from a **predefined, finite,
   platform-owned, flat** vocabulary curated by the Product Owner as **repository-owned
   configuration changed through deployment**, with no free-text value, no `Other`, no
   proposal workflow and no administrator category-management interface. That discharged the
   dependency but left `DDM-3` blocked on a second product input: the values themselves.
3. **Issue #165 approved the 16 labels** — Product Owner ruling 2026-10-08 (PR #166):
   **exactly 16 categories**, with labels, inclusion definitions, boundary notes,
   tie-breaker rules and alphabetical display order, recorded in `docs/05` *The approved MVP
   category vocabulary*. That ruling approved **product vocabulary only**, and said so:
   *"The labels below are user-facing display text, not machine identifiers."* `DDM-3` became
   **unblocked and undecided**.
4. **Issue #167 evaluated the physical alternatives** — a Scope Gate that framed Options A,
   A′, B, C and D against repository evidence, extracted the binding invariants, walked eight
   change scenarios, and **requested** a ruling, marking its own recommendation *"advisory
   only, until explicitly selected"*. It **deliberately proposed no machine keys**, recording
   that *"no key is proposed, reserved or approved by this issue"*.
5. **The binding Option A′ selection preceded this ADR draft.** The Product Owner ruled on
   issue #167 selecting Option A′ in full. Because the issue had reserved the keys rather
   than proposing them, a **16-key mapping was then presented for separate approval and
   approved exactly as presented**, on the same issue, before this file existed.

The register defines `Proposed` as *"drafted and under review; the decision is not yet in
force"*. A proposal exists to **obtain** a ruling. Here the ruling arrived first, so there is
nothing left to propose, and a `Proposed` status would describe as pending a decision the
accountable owner has already taken.

**No gate is opened**, and **`Accepted` does not mean implemented** — it means the rule is in
force and later work may rely on it. Nothing in this document is evidence that any part of it
has been built.

## Context

**`OQ-5` fixed the category *model*, and the vocabulary ruling fixed the *values*. Neither
fixed how a category is stored, and both said so explicitly.**

`docs/08`'s `DDM-3` row recorded precisely what remained: *"text column versus reference
table, foreign-key structure, stable category identifiers versus display labels, the
configuration-file format, the seed-data and deployment-loading mechanism, database
constraints, and the shape of the category migration. None of those is chosen by `OQ-5`, by
the approved vocabulary, or by inference from either. In particular, the approved labels are
user-facing display text: whether a stable machine identifier exists apart from the label, and
what it looks like, is `DDM-3`'s to decide."*

**The decision could not be avoided, because `DDM-3` was the last open `DDM` gate standing in
front of the first schema migration — the last *blocker*, which is not the same as the last
open question about that migration's content.** `src/data/migrations/README.md` names it as
the one remaining blocker and instructs an author to *"declare no category column, type, enumeration, reference
table, foreign key, constraint or seed data, and do not infer a representation from the
product ruling or from the approved list of labels"*. A migration could not be written
honestly until this was settled.

**What deciding `DDM-3` does and does not make ready, stated precisely.** It determines the
**category** content of the first schema migration completely, and it removes the only
remaining `DDM` blocker. It does **not** mean every column, constraint and table of that
migration is decided:

- **`DDM-4`** (indexing and text-search strategy) is **unresolved** with `OQ-4`/`NOQ-4`.
  `ADR-017` selected **no index or search structure**, so the first migration is expected to
  carry none — an acknowledged exclusion rather than a blocker, and later indexing should
  arrive **additively**.
- **`ADR-017` itself still defers items that could add schema**, most concretely **stale-edit
  detection and resolution policy "and any supporting version token (for example a listing
  version or last-updated value recorded when an edit is prepared)"**, plus the isolation
  level for revision transactions and replacement-value semantics. A version token would be a
  **column**, so this question can still affect first-migration content.
- **`DDM-7`** (audit-entry storage) is unresolved and conditional on `OQ-14`/`S-8` — not
  listing-table content.
- **`DDM-2`** retains open items — domain carrier type, revision identity domain type, public
  identity transport — none of which changes the identity **columns** `ADR-019` already fixed.

**So this ADR claims the narrower thing: the category representation is fully determined, and
`DDM-3` no longer blocks.** Whether the first migration is otherwise complete is for that
separately authorized unit to establish against `ADR-017`'s remaining deferrals, and nothing
here should be read as certifying it.

**The requirements it answers to.** `FR-DATA-02` (a single category from a predefined set),
`FR-DATA-10` (the predefined set recorded as a defined, finite list available for both
submission and filtering), `FR-SRCH-04` (filtering on a predefined category),
`NFR-MAINT-04` (configuration values such as the category set changeable without rewriting
core logic). The invariants it must not breach: **`DI-9`** (a category value always references
a member of the predefined set), **`VR-2`** (never a free-text value), **`AV-7`** (validated
against the predefined set, never accepted as free text), **`VR-S5`** (exactly one category,
required), **`DI-1`**-class determinacy.

**The state of the code at the moment of this decision.** `src/domain/listing/listing.ts`
declares `category: string`; `src/domain/listing/validation.ts` enforces presence and
non-blankness only and records that *"Not decided here and therefore not implemented:
category set membership (`DI-9`, `OQ-5`, `DDM-3`)"*. **`DI-9`, `VR-2` and `AV-7` are
unimplemented.** No category configuration, reference data or seed data exists; no schema,
migration or DDL exists; no database is provisioned. The category strings in the shared test
fixtures — `"food-and-drink"` and `"retail"` — are **test data, not approved values**.

## Repository evidence

The decision rests on evidence already in the repository, not on preference.

| Evidence | Where | Bearing |
|---|---|---|
| `OQ-5`: the vocabulary is **configuration, not administrator-managed data**; no management interface is authorized | `docs/05` `OQ-5` row; `docs/08` `S-3`; `docs/10`; `docs/13` | Storing the vocabulary as database rows would model as mutable data what the ruling called configuration |
| The approved labels are **display text, not machine identifiers**; physical representation *"including whether a stable identifier exists apart from the display label"* remains `DDM-3` | `docs/05`; `docs/08` `E2`, `DDM-3` | The decision to store a key rather than a label was left open deliberately, and is taken here |
| The approved alphabetical order *"says nothing about physical storage order, sort keys, enumeration member order, configuration-file order or any index: those remain `DDM-3`"* | `docs/05` *Display order* | Display order needs no physical persistence |
| Boundary notes are *"semantic guidance for submitters and for administrator correction, not a validation rule"* | `docs/05` | Definitions and boundaries are documentation, never runtime data |
| *Professional Services* is *"the broadest approved category, and the first candidate for a later governed additive split"* | `docs/05` row 13 | A split is foreseen, so the design must make additive change cheap |
| **`ADR-017` `PS-7`** selects, for the analogous three-value listing status, *"a mandatory text datum restricted by a store check to the three existing values"*, because *"the store refuses any other value or none"*; *"a check constraint is ordinary table DDL that a migration can replace, needs no separate type object"*; and its behaviour is *"independent of the unselected server version"* | `docs/adr/ADR-017` `PS-7` | The closest in-repository precedent, and it points directly at a checked text column |
| **`ADR-017`** rejects a **status reference table** because it *"models a fixed, product-decided set as data that could appear editable, and adds a join"* (set aside on **P4**, no over-modelling), rejects a **native enumerated type**, and rejects **small integer codes** as *"opaque in the store and in every administrative query"* | `docs/adr/ADR-017` *Alternatives* | Three of this ADR's four rejections were already argued once, on the record |
| **`ADR-017`** posture: `DI-1`/`DI-9`-class and `DI-11` invariants *"would be store constraints"*; write-path enforcement is reserved for rules that compare old and new values (`PS-9`) | `docs/adr/ADR-017` | Set membership is expressible as a single-row store check, so the write-path exception does not reach it |
| **`ADR-019`**: *"boundary validation and database constraints remain mandatory"*; *"direct database writes and any governed import path must supply identifiers explicitly"*; the first migration must omit the UUID default **deliberately** | `docs/adr/ADR-019`; `src/data/migrations/README.md` | Callers other than the ordinary write path exist; and a migration is expected to record what it deliberately omits |
| **`ADR-017` `PS-1`**: opaque random UUID v4 for **listing and revision** identity, also public listing identity — the `DI-8` requirement that a *record's* identity be stable and content-independent | `docs/adr/ADR-017` `PS-1` | Scoped to **domain identities**; a category is a governed configuration value, so no UUID is owed |
| **`ADR-020`**: a location **reference table is rejected for the MVP as premature**, not invalid; future normalisation must arrive **additively**; *"a `varchar(n)` must not be chosen merely because a migration needs a type"*, because no numeric bound is governed | `docs/adr/ADR-020`; `src/data/migrations/README.md` | The same reasoning transfers: prefer the smallest governed shape, and use `text` |
| **`ADR-018`**: **raw PostgreSQL DDL through the `sql` tag is the default** authoring format; **forward-only corrective migrations**; a `down` only where reversal is *"genuinely safe, complete and honest"*; destructive work needs separate authorization plus an `ADR-010` assessment; implicit execution at startup, module load or on the request path is **prohibited** | `docs/adr/ADR-018`; `src/data/migrations/README.md` | Governs how the key set may enter the database, and forecloses any "seed on boot" mechanism |
| `status.ts` precedent: a frozen `as const` tuple, a derived type, and a runtime guard rejecting anything outside the set | `src/domain/listing/status.ts` | The established in-repository shape for a closed value set in application code |
| `OP-11` returns the set; *"what `OP-11` returns on the wire — labels alone, or labels paired with stable identifiers — is not decided here"* | `docs/09` `OP-11` | Transport stays later design; keys may remain internal |
| The category control is **single-select**, populated from `OP-11` in the approved alphabetical order | `docs/10` S1/S3 | The UI needs labels in order — not from the database |
| `NFR-MAINT-04`: configuration values such as the category set shall be changeable without rewriting core logic | `docs/06` | Favours a configured vocabulary over one embedded in schema or logic |

**Documentation and code agreed on an absence.** Nothing in `src/` knew the 16 labels, nothing
constrained `category` beyond non-blankness, and nothing persisted anything. There was no
divergence to repair — only a decision to take.

## Decision

**We will store each listing's category as a stable, repository-owned textual machine key in a
single mandatory PostgreSQL `text` column, and PostgreSQL will independently enforce the
complete approved key set through a `CHECK` constraint authored as raw DDL through Kysely's
`sql` tag.**

The decision has twenty-two parts, each binding.

### Representation

1. **One category column per listing.** Exactly one category value per listing, in one column
   — the many-to-one shape `docs/08` committed.
2. **The column is mandatory and non-null.**
3. **The column type is PostgreSQL `text`.**
4. **The stored value is a stable, repository-owned textual machine key.**
5. **The user-facing label is not stored as identity.** The label is display text, and a
   listing row carries none of it.
6. **`varchar(n)` must not be used.** No numeric length bound is governed anywhere —
   `validation.ts` implements blankness only, and `VR-S3` leaves every safety and length
   boundary to `DD-1`/`DD-2` — so choosing a number here would settle a decision nobody has
   made. PostgreSQL `text` needs none. This follows `ADR-020` exactly.

### Enforcement

7. **A database `CHECK` constraint contains the complete approved key set.** The store
   therefore **refuses any value outside it** — independently of application validation and
   of every caller, including migrations, governed import paths and administrative SQL. This
   is `ADR-017` `PS-7`'s mechanism applied to `DI-9`; `PS-7` describes its effect for the
   status datum as *"the store refuses any other value or none"*.

   **The two halves are separate, and both are required.** Under SQL's three-valued logic a
   `CHECK` whose predicate evaluates to `UNKNOWN` is **satisfied**, so a bare
   `CHECK (category IN (…))` **does not reject `NULL`** — it passes it. **The `NOT NULL` of
   decision 2 is what refuses a missing value**, and the `CHECK` is what refuses a wrong one.
   A migration must therefore declare **both**, and must not treat either as implying the
   other. (A predicate written to reject null explicitly would also work, but **`NOT NULL` is
   the selected mechanism**: it states the obligation where a reader expects it and keeps the
   `CHECK` to the single job of set membership.)

   **The keys need no escaping, and that is a property of the convention, not an accident.**
   Every approved key is lower-case ASCII letters and hyphens only — the `&` and the commas
   were dropped, not transliterated — so each appears in DDL as an ordinary
   single-quoted literal with **no embedded quote, no doubling and no escape sequence**. Had
   the approved **labels** been stored instead, literals such as `'Arts, Culture &
   Entertainment'` would have carried punctuation into the predicate for no benefit.
8. **The constraint is authored as raw PostgreSQL DDL through Kysely's `sql` tag**, which is
   `ADR-018`'s default authoring format. The schema builder is permitted only where it would
   state the operation more clearly without obscuring its semantics, and the two must never
   become competing schema sources of truth.

### Application configuration

9. **Application configuration will later map keys to labels, inclusion definitions, boundary
   notes and display order**, in repository-owned configuration — on the `status.ts` shape.
10. **The database and configuration key sets must be equality-tested.** A test must prove
    that the configured key set equals the key set the database constraint admits. **How that
    comparison obtains the constraint's set is not selected here** — reading the live
    predicate back from the catalogue and comparing against the migration's own declared set
    are both legitimate, and they differ in what they prove and in what they need to run. The
    obligation is the equality; the strategy belongs to the unit that writes the test, and
    **nothing here should be read as claiming the constraint is trivially introspectable**.

**Both are future implementation.** Neither exists, and neither is created by this ADR.

### What is not created

11. **No category table.**
12. **No foreign key.**
13. **No join table.**
14. **No PostgreSQL enum.**
15. **No category rows and no seed mechanism.** The approved values enter the database as the
    **constraint's own predicate**, not as data. There is consequently no reference-data unit,
    no installation ordering problem, no idempotence requirement and no startup-execution
    question.
16. **No runtime administrator mutation.** No screen, permission, operation or write path to
    the vocabulary exists or is authorized (`OQ-5`, `docs/10`).

### Governance of change

17. **Product Owner governance remains required for every set change** — addition, removal,
    rename or boundary change.
18. **An addition or removal requires a coordinated configuration change and a forward
    migration** updating the `CHECK` constraint. **"Coordinated" has a direction, and the two
    cases run opposite ways** — because the constraint and the application can be at
    different versions for the duration of any rollout:

    - **Adding a key: widen the database first, then deploy the application.** A widened
      `CHECK` is harmless to the older application, which simply never writes the new key. The
      unsafe order is the reverse: a **new application against an old database** would have
      its writes of the new key **rejected by the constraint**.
    - **Removing a key: deploy the application first, reassign the rows, then narrow the
      database.** The older application must have stopped offering and writing the key, and
      every row holding it must have been reassigned, before the predicate excludes it.
      Narrowing first would reject writes the still-running older application legitimately
      makes, and would fail validation against existing rows (decision 20).

    **A key-set change is therefore not atomic across the system, and must not be planned as
    though it were.** In each case the safe order is the one in which **the permissive side
    leads** — the database widens before the application uses the key, and the application
    stops using it before the database narrows. **No rename, definition or display-order
    change raises this question at all**, because the stored key and the constraint are
    untouched (decision 19).
19. **A label-only, definition-only or display-order-only change does not rewrite stored
    listing rows**, and requires no migration.
20. **Removal of a referenced key requires an explicit reassignment/backfill decision before
    the constraint is narrowed.** The constraint cannot be validated while rows hold a value
    it would forbid, and that failure must be met with a governed reassignment, never with a
    widened constraint.
21. **Rollback must remain honest under `ADR-018`.** Forward-only corrective migrations are
    the default. Widening the constraint is cleanly reversible while no row uses a new key;
    **narrowing it after rows exist is not**, and no `down` may imply that reassigned data can
    be restored. Destructive or irreversible work requires separate explicit authorization and
    an `ADR-010`-based safeguard and recovery assessment — `ADR-010` is neither extended nor
    reinterpreted.
22. **No implementation is introduced by this decision.**

### The approved key mapping

**Approved by Product Owner ruling on issue #167, 2026-10-09, exactly as presented.** This
table is the **authoritative mapping**, and it is recorded **here and nowhere else** — other
documents reference this ADR or `docs/05` rather than duplicating it. Every approved label has
exactly one key; every key has exactly one label; the order is the approved alphabetical
display order.

| # | Approved label (`docs/05`, unchanged) | Approved machine key |
|---|---|---|
| 1 | Arts, Culture & Entertainment | `arts-culture-entertainment` |
| 2 | Automotive & Transport | `automotive-transport` |
| 3 | Beauty & Personal Care | `beauty-personal-care` |
| 4 | Community & Nonprofit | `community-nonprofit` |
| 5 | Education & Childcare | `education-childcare` |
| 6 | Financial & Insurance Services | `financial-insurance-services` |
| 7 | Fitness & Recreation | `fitness-recreation` |
| 8 | Food & Drink | `food-drink` |
| 9 | Health & Medical | `health-medical` |
| 10 | Home & Trade Services | `home-trade-services` |
| 11 | Industrial & Wholesale | `industrial-wholesale` |
| 12 | Pets & Animal Services | `pets-animal-services` |
| 13 | Professional Services | `professional-services` |
| 14 | Retail & Shopping | `retail-shopping` |
| 15 | Technology & Digital Services | `technology-digital-services` |
| 16 | Travel & Accommodation | `travel-accommodation` |

**Sixteen keys, sixteen labels, one-to-one.**

### The key convention, and its limits

**The convention.** Lower-case ASCII; words hyphen-separated; the `&` conjunction and all
commas **dropped rather than transliterated** — the conjunction is **not** retained as `and`;
no abbreviation.

**The convention explains the initial choice. It does not define the keys thereafter.** The
keys are **explicitly governed identifiers**, approved once by the Product Owner and **never
recomputed or derived from labels at runtime**. This is the load-bearing distinction in the
whole decision:

> Were a key *defined as* a function of its label, renaming the label would change the key, and
> the rename would become a data rewrite across every listing row — **the precise cost this
> design exists to avoid.** A key may *initially resemble* its label; it must never be *bound
> to* it.

**No approved key may be altered, and no label may be substituted for a key.** The non-approved
test-fixture strings `"food-and-drink"` and `"retail"` are **not** approved values and are
**not** promoted by this decision; neither collides with any approved key (`food-drink` and
`retail-shopping` are the approved keys), and the fixtures must be replaced when `DI-9` is
implemented.

## Rationale

### From repository evidence

**`ADR-017` `PS-7` already decided this question's near-twin, and its reasoning transfers
directly.** For the three-value listing status it selected a mandatory text datum restricted by
a store check, on three stated grounds: the store refuses any other value or none; a check
constraint is ordinary table DDL a migration can replace, needing no separate type object; and
its behaviour is independent of the unselected server version. All three hold here. The only
material difference is that a listing status is a system value never shown as approved product
text, whereas a category label **is** approved product text — which is exactly why this ADR
stores a key where `PS-7` stored the value itself.

**`OQ-5` decided the vocabulary is configuration, not data.** Storing it as database rows would
contradict that ruling in the physical design, and `ADR-017` had already named the hazard: a
reference table *"models a fixed, product-decided set as data that could appear editable"*.
Keeping the vocabulary in configuration and the enforcement in a constraint honours the ruling
in both places.

**`docs/05` separated labels from identifiers on purpose, and foresaw change.** It called the
labels display text, reserved the identifier question to `DDM-3`, admitted later renames and
boundary changes, and named *Professional Services* as the first candidate for a split. A
design that stores the label would convert a foreseen cosmetic change into a production data
migration.

**`ADR-020` set the precedent for choosing the smallest governed shape.** It rejected a
location reference table as premature rather than invalid, insisted future normalisation arrive
additively, and forbade inventing a `varchar(n)`. This ADR follows all three.

**`ADR-018` forecloses the alternatives a reference table would need.** Implicit execution at
startup or on the request path is prohibited, so there is no "seed on boot" mechanism; and
forward-only correction is the default, which makes a row-deleting `down` honest only while
nothing references the rows. A design with no reference data avoids the whole question.

### General engineering considerations

**Set membership belongs in the store because integrity must not depend on cooperative
callers.** `DI-9` is stated as an unconditional property of the data, not of one code path.
`ADR-019` explicitly contemplates direct database writes and governed import paths. A
database-side constraint also holds across a mixed-version application rollout, where an
application-only check does not.

**A stable key introduces no new decision; an integer or UUID key would.** Both would be opaque
in the store and in every administrative query — the ground on which `ADR-017` set aside small
integer codes — and both would require a generation locus, re-opening ground `ADR-019` settled
only for listings and revisions. A textual key approved once in configuration is generated by
nothing.

**Two repository-owned copies of the key set are a bounded, testable cost.** The configuration
module and the migration's `CHECK` predicate both carry the keys. They change together, in one
reviewed pull request, only when the *set* changes — and the required equality test turns any
drift into a test failure rather than a production defect.

## Alternatives considered

**None of these is rejected as technically invalid.** Each is a design a reasonable engineer
might choose, and the rationale is preserved so it is not silently re-made (`IR-6`).

### Option A — store the approved label in a text column with a `CHECK` constraint — rejected

The listing row stores the exact approved user-facing label; a `CHECK` restricts the column to
the 16 labels; no reference table exists.

**The simplest design of all, and genuinely viable.** Its enforcement is identical to the
selected option, it needs no key artefact, and it would have satisfied every binding invariant.

**Rejected because it makes label corrections destructive.** A rename or a punctuation fix —
scenarios the vocabulary ruling expressly admits, and which change no meaning at all — becomes
a `CHECK` replacement **plus an `UPDATE` across every listing row**. That couples a product-text
decision to stored data, and makes the cheapest possible product change one of the more
expensive technical ones. It also stores approved product text, with its commas and ampersands,
as machine identity, which `docs/05` warned against in terms: *"The labels below are
user-facing display text, not machine identifiers."* The selected option differs from this one
only by the key, and buys exactly that property.

### Option B — a category reference table with a foreign key — rejected

The listing row carries a foreign key to a category reference row; category rows carry a stable
key, display label and display order; the approved values are installed by a governed migration
or reference-data mechanism.

**The strongest referential integrity of any option, and a legitimate later possibility.** A
foreign key makes an unknown category unrepresentable, and a governed `INSERT` migration is
arguably the cleanest way to add a value.

**Rejected on three grounds, the first already on the record.** First, `ADR-017` rejected
exactly this shape for the status set because it *"models a fixed, product-decided set as data
that could appear editable, and adds a join"* — and `OQ-5` decided this vocabulary is
configuration, not data, so storing it as rows contradicts the ruling in the physical design.
Second, it buys stability against label change that a stored key already provides, at the price
of a second table, a join on every read path, and a complete reference-data lifecycle —
installation ordering, idempotence, deprecation state, display-order duplication and rollback
honesty — none of which any approved requirement asks for. Third, a generated UUID identity for
category rows would be unnecessary: `ADR-017` `PS-1`'s UUID policy governs listing and revision
**domain identities** under `DI-8`, and a category is a governed configuration record, not a
domain identity. **It remains a legitimate later option** should the vocabulary ever become
genuinely administrator-managed data — which would itself require reopening `OQ-5`.

### Option C — a native PostgreSQL enum type — rejected

The listing column uses a database enum containing the approved values or keys.

**Strong enforcement and a compact schema**, with values unrepresentable outside the type.

**Rejected on removal asymmetry, rollback honesty and an unselected server version.**
PostgreSQL offers `RENAME VALUE` but **no `DROP VALUE`**: removing a value means creating a
replacement type, rewriting the column and dropping the old type — a heavyweight migration that
cannot be cleanly reversed, which collides with `ADR-018`'s requirement that a `down` be
*"genuinely safe, complete and honest"*. A wrongly added value cannot simply be removed. And
enum behaviour around adding and using values is **version-dependent**, while **no PostgreSQL
server version is selected** (`ADR-013` names the provider only) — the same ground on which
`ADR-017` preferred a checked text datum whose *"behaviour [is] independent of the unselected
server version"*. If the enum held labels, approved product text would additionally become a
database type definition, the tightest coupling of any option.

### Option D — unconstrained text with application-only validation — rejected

The column is plain `text`; only application code checks membership.

**The cheapest to write**, and it would satisfy `AV-7` at the application boundary.

**Rejected because database integrity would depend solely on cooperative callers.** `DI-9`
states an unconditional property of the data — *"A category value on a listing always references
a member of the predefined set"* — not a property of one code path. `ADR-017`'s settled posture
is that single-row set-membership rules are store checks; `ADR-019` explicitly contemplates
direct database writes and governed import paths that bypass the application. This option is
the one alternative that fails a **binding invariant** rather than losing on cost.

### Deferring `DDM-3` again — rejected

`DDM-3` was the last open `DDM` gate blocking the first schema migration, and both product
inputs were already decided. Deferring would have left the migration blocked on a question with
no remaining prerequisite, while `src/data/migrations/README.md` continued to name it as the
blocker. There was nothing left to wait for.

## Change scenarios

What each foreseeable change costs under this decision. **Product Owner approval is required
for every vocabulary change**, because the vocabulary is the Product Owner's (`OQ-5`,
`docs/05`).

| Scenario | PO approval | Configuration change | Migration | Data backfill | Validation update |
|---|---|---|---|---|---|
| **Add a category** | **Required** | Add the key, label, definition, boundary note and display position | **Yes** — a forward migration widening the `CHECK` to admit the new key | **None** — no listing can hold a key the constraint did not admit | Configuration and the equality test extend to the new key |
| **Rename a label** (meaning unchanged) | **Required** | Label text only | **None** | **None** | **None** — the key is unchanged, so neither the constraint nor any row is touched |
| **Definition / boundary change** | **Required** | Boundary note or inclusion definition only | **None** | **None** | **None** — boundary notes are semantic guidance for submitters and administrator correction, never a validation rule |
| **Split a category** (e.g. *Professional Services*) | **Required** — plus per-listing reclassification judgement | New keys, labels and boundaries; the old key retained during transition | **Yes** — widen the `CHECK` first; narrow it only once reassignment is complete | **Yes** — reassignment is an administrator judgement per listing (`A3`), **not mechanically derivable** | Follows the new key set |
| **Merge two categories** | **Required** | Remove one key | **Yes** — `UPDATE` affected rows to the surviving key, then narrow the `CHECK` | **Yes**, mechanically — one key maps to another | Follows the reduced key set |
| **Retire a referenced category** | **Required** — and an **explicit reassignment/backfill decision first** (decision 20) | Remove the key | **Yes** — reassign rows **before** narrowing the `CHECK`; the constraint cannot validate while forbidden values remain | **Yes** | Follows the reduced key set |
| **Display-order change** | **Required** — the order is a user-facing product decision | Order only | **None** | **None** | **None** — order is never stored |
| **Roll back a faulty deployment** | No | Revert the configuration change | Widening is cleanly reversible **while no row uses the new key**; **narrowing after rows exist is not**. The honest path is a **forward corrective migration** (`ADR-018`) | Depends on what was applied; any reassignment already performed is **not** restored by reverting DDL | Reverts with the configuration |

**The pattern worth naming.** The three cheapest scenarios — label rename, definition change and
reorder — are exactly the ones a stored label would have made expensive, and they cost **nothing
but configuration** here. The three expensive ones — split, merge and retire — are expensive
because **reclassifying listings is a product cost no representation can remove**. The
representation neither creates nor avoids that cost.

## Consequences

**Positive:**

- **`DDM-3` is decided, and the first schema migration's category representation is fully
  determined** — column, type, nullability, stored identity and enforcement mechanism are all
  specified, with no remaining physical ambiguity.
- **`DI-9` becomes enforceable in the store**, independently of every caller, and across a
  mixed-version application rollout.
- **Label, definition and display-order changes cost nothing but configuration** — no migration,
  no backfill, no data rewrite.
- **The smallest viable physical shape**: one column, one constraint, no table, no join, no type
  object, no reference data, no lifecycle machinery.
- **`OQ-5` is honoured in the physical design** — the vocabulary stays configuration in both the
  repository and the database.
- **Additive change stays additive**, as `ADR-020` required of future normalisation.
- **Nothing is foreclosed irreversibly**: a reference table remains available later if the
  vocabulary ever becomes genuinely administrator-managed data.

**Negative:**

- **The key set exists in two repository-owned places** — the configuration module and the
  migration's `CHECK` predicate — so a **set** change needs a coordinated configuration change
  and migration in one deployment. This is the material tradeoff, accepted deliberately: it is
  bounded, reviewed in one pull request, exercised only on set changes, and **required to be
  covered by an equality test** (decision 10).
- **Sixteen machine keys are now governed artefacts** that did not exist before, and must be
  kept stable — a small but permanent governance surface.
- **Reading a listing row no longer shows the human-readable category**; a join-free store means
  administrative queries see `professional-services`, and the label lives in configuration.
- **Adding a category requires a migration**, where a reference table would have required only
  an `INSERT`.
- **Narrowing the key set is not cleanly reversible** once listings reference a removed key, and
  `ADR-018`'s forward-only posture applies.

**Reversibility:** **Moderate.** Moving later to a reference table (Option B) would be an
additive migration plus a backfill from key to foreign key, with the keys themselves surviving
as the natural stable identifiers — the stored key is precisely what makes that path cheap.
Moving to an enum would be a type creation and column rewrite. Moving to stored labels would be
a data rewrite and is a regression this ADR argues against. **Nothing here is expensive to
reverse because nothing is built**: no schema and no rows exist, so **no backfill is owed
today**.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| The vocabulary remains **Product Owner-governed configuration changed through deployment**, with no runtime management path (`OQ-5`) | If administrators ever curate categories at runtime, the configuration-plus-constraint shape is wrong and **Option B becomes the right design** — this is the first decision to revisit, and it would require reopening `OQ-5` first |
| The vocabulary stays **small and flat** — sixteen values, no hierarchy, aliases or localized labels | A large or structured vocabulary would make a constraint predicate unwieldy and a reference table proportionately more attractive |
| **Set changes are rare; label and boundary refinements are not** | If the set itself churns, the coordinated configuration-plus-migration cost recurs often, and the duplication tradeoff is worse than judged |
| A **`CHECK` constraint over sixteen short text values** is adequate for the directory's scale (`PA-1`, the directory is small at first release) | At a scale where the predicate cost mattered, an enum or a foreign key with an index would be worth re-measuring — but `NFR-PERF` targets are nowhere near this |
| **One equality test can be written** that reads the configured key set and the constrained key set and compares them, without production credentials | If the constrained set cannot be read in a test environment, the duplication is unguarded and the tradeoff must be re-argued |
| `text` without a length bound is acceptable, because **no bound is governed** (`VR-S3`, `DD-1`/`DD-2`; `ADR-020`) | If a governed bound is later decided, it arrives additively and applies to keys as to every other text attribute |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **Configuration and constraint key sets drift** | The application admits a key the database rejects, or vice versa — a write that fails at the store, or a value no UI can display | **Decision 10 makes the equality test mandatory.** It is the single control that converts drift into a test failure, and it must land with the configuration module |
| **A later author derives keys from labels** at runtime, or regenerates them | A rename silently changes identity, and the design's central property is lost | The convention is recorded here as **explanatory, not generative**, and decision 4 fixes the keys as governed identifiers. The ADR says so in terms |
| **A migration author adds a `varchar(n)`** because a column seems to need a length | A length bound nobody governed becomes schema, pre-empting `DD-1`/`DD-2` | Decision 6 forbids it explicitly, as `ADR-020` and `src/data/migrations/README.md` already do for location |
| **A migration widens the `CHECK` to make a failing narrow succeed** | A retired category silently survives in data, and `DI-9` is breached for those rows | Decision 20 requires an explicit reassignment/backfill decision **before** narrowing, and names the failure as the signal to seek it |
| **A `down` is written that appears to restore reassigned rows** | A rollback claims to undo a reclassification it cannot | Decision 21 and `ADR-018`: forward-only correction by default; a `down` only where reversal is genuinely safe, complete and honest |
| **The non-approved fixture strings are mistaken for approved keys** | `"food-and-drink"` or `"retail"` enters configuration or a constraint | Recorded here and in `docs/05`, `docs/11` and `docs/traceability-matrix.md` as **test data, not approved values**; neither collides with an approved key, and both must be replaced when `DI-9` is implemented |
| **`Accepted` is read as implemented** | Later work assumes category enforcement exists and skips building it | The status block, decision 22 and the reconciled documents all state that `DI-9`/`VR-2`/`AV-7` remain **unimplemented** and that no schema, migration or configuration exists |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OQ-5`** — the category model, cardinality and curation | **Decided** 2026-10-07 and **not reopened**. This ADR consumes that ruling and changes no part of it |
| **The approved 16-category vocabulary** — labels, definitions, boundaries, tie-breakers, display order | **Unchanged.** `docs/05` remains authoritative; this ADR adds a key beside each label and alters no approved text |
| **`OQ-4` / `S-4` / `DDM-4`** — keyword-search scope, searchable fields, indexing and text search | No index, no search structure and no searchable-field set is declared. The `CHECK` is an integrity constraint, not an index — the distinction `ADR-017` drew for `DI-11` |
| **`FR-SRCH-09`** — multi-category selection | **Unapproved and deferred, unchanged.** One column holding one key assumes exactly one category, which is `OQ-5`'s decided shape, and no multi-select structure is created |
| **Category filtering** (`FR-SRCH-04`) | No filtering, query, predicate or read path is implemented. The decision states what is stored, not how it is queried |
| **`OP-11`'s wire shape** | Expressly left open by `docs/09`. Keys may remain internal; whether the API returns labels alone or labels paired with keys is later transport design, and both remain possible |
| **`DU-2`** — control element, typography, layout, icons | Untouched. The approved display order is a product decision held in documentation and configuration; this ADR stores none of it |
| **`DDM-2`'s remaining items** — domain carrier type, revision identity domain type, public identity transport | Untouched. No domain type is narrowed and no identifier transport is declared here |
| **`VR-S3`'s safety and length boundaries** (`DD-1`/`DD-2`) | No length limit is chosen; `text` is selected precisely because it needs none |
| **The first schema migration** | A **separately authorized later unit** under `ADR-018`. This ADR fixes its category content and creates none of it |
| **Category configuration and `DI-9`/`AV-7` validation** | A **separately authorized later unit**. Decisions 9 and 10 state what it must do; no module, type narrowing, guard or test is created |
| **PostgreSQL version, extension policy, provisioning**, region, tier, sizing, TLS, credentials, secrets, pool, pooler | None selected. The `CHECK` mechanism was preferred partly **because** its behaviour does not depend on the unselected version |
| **CI migration validation and production migration execution** | Outstanding under `ADR-018`, and not decided here |
| **`OQ-9`, `OQ-12`, `OQ-14`/`NOQ-8`, `OQ-15`; seams `S-4`, `S-7`–`S-10`; `DDM-7`** | Untouched; no structure, field, state or retention rule is named for any of them |
| **Category history, soft deletion, deprecation state** | None introduced. Decision 15 creates no rows to version, and no requirement asks for any of this |
| **Administrator category management** | **Unauthorized, unchanged.** Decision 16 creates no mutation path, screen or permission |
| **`DG-3`, `DG-4`** | Neither is opened, narrowed or pre-empted. This ADR is a constituent of neither |

## Traceability

| | |
|---|---|
| **Requirements** | `FR-DATA-02`, `FR-DATA-10`, `FR-SRCH-04`; `NFR-MAINT-04`. **Not answered:** `FR-SRCH-09` (unapproved, deferred) |
| **Journeys** | `V3` (filter by category), `L1`/`L2` (submission), `A3` (administrator correction during moderation), `S7` (post-approval change via the `OQ-10` revision path) |
| **Components** | `C9` (data layer — the column and constraint it will later own), `C6` (domain/application validation, later), `C4` (configuration), `C1`/`C2` (the single-select control, later) |
| **Invariants** | `DI-9` (set membership — made enforceable in the store, **still unimplemented in the application**), `VR-2`, `AV-7`, `VR-S5`, `E2`, seam `S-3` (resolved). **Not breached:** `DI-1`, `DI-8`, `DI-10`, `DI-11` |
| **Decisions consumed** | `OQ-5` (Decided 2026-10-07, issue #163); the approved MVP category vocabulary (2026-10-08, issue #165); `ADR-017` `PS-1`/`PS-7`, `ADR-018`, `ADR-019`, `ADR-020` — all `Accepted`, all unchanged and none superseded |
| **Documents amended** | `docs/adr/README.md` (the register), `docs/08-data-model.md` (`DDM-3`, `E2`, `VR-2`, `VR-S5`, `DI-9`, `S-3`, the `OQ-5` row, *Entity relationships*), `docs/13-decision-log.md`, `docs/traceability-matrix.md`, `docs/12-implementation-plan.md`, `src/data/README.md`, `src/data/migrations/README.md` — **amended in the same pull request** (`IP-9`) |
| **Issue / pull request** | Closes issue #167. Ruling recorded on issue #167, 2026-10-09 |
