# `ADR-017` — Physical listing data design: opaque random identity, effective content on the listing with separate revision records, explicit per-value public designations, a constrained publication-state representation, and physical purge of rejected records

| Field | Value |
|---|---|
| **Status** | **`Proposed`** |
| **Date** | 2026-09-16 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*) |
| **Decision gate** | *none* — `DG-1` is **Resolved** (2026-08-04) and `DG-2` is **Resolved** (2026-08-27, issue #93); this ADR is a constituent of neither |
| **Related open questions** | **Depends on** (all Decided): `OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13`; and Accepted `ADR-006`, `ADR-014`, `ADR-015`, `ADR-016`. **Must NOT answer:** `OQ-4`, `OQ-5`, `OQ-12`, `OQ-14`/`NOQ-8`, `NOQ-7`, `OQ-9`; seams `S-3`, `S-4`, `S-7`, `S-8`, `S-9`, `S-10`; **`DDM-3`**, **`DDM-4`**, **`DDM-5`**, **`DDM-7`**; `AQ-4` (`docs/09`); migration execution, timing and rollback policy; provisioning, pool, TLS, secrets and environment configuration; integration-test infrastructure; `DG-3`, `DG-4` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **Status: `Proposed` — drafted and under review. NOT in force; nothing may depend on it.**
> Per `docs/adr/README.md`, a `Proposed` ADR is *"Drafted and under review. The decision is not
> yet in force; nothing may depend on it."* Every choice below is a **proposal for Product Owner
> consideration**, and several are **conditional** on the unresolved questions in *Product Owner
> questions raised by this Proposal*. **`DDM-2`, `DDM-6`, `DDM-8` and `DDM-9` all remain
> unresolved** until, and unless, this ADR is separately `Accepted`. The count of decisions in
> force is unchanged at **eleven**.
>
> **Acceptance would not be implementation.** Even if accepted, this ADR would authorize **no**
> SQL, schema file, migration, `DB` interface, `C9` code, dependency (including `@types/pg`),
> provisioning, connection, pool, TLS, secret, environment, integration-test infrastructure or CI
> change. Each remains a separate later work unit requiring its own owner authorization.

**What is already in force, and what is only proposed here.**

| In force (Accepted — this ADR relies on it and changes none of it) | Proposed here (not in force) |
|---|---|
| The logical listing model: one durable listing concept, three orthogonal state dimensions, one effective public version, `E7`, derived purge-eligibility, purge as a system obligation (`ADR-006`) | The physical identity strategy (`DDM-2`) |
| PostgreSQL under a managed posture; DigitalOcean Managed PostgreSQL (`ADR-003`, `ADR-013`) | The physical mechanism for non-public attributes and per-value display designations (`DDM-6`) |
| Kysely as the `C9` access approach, with SQL as the source of truth (`ADR-014`) | The physical revision storage and effective-public-version carrier (`DDM-8`) |
| Kysely `Migrator` (`ADR-015`); `pg` through `PostgresDialect` (`ADR-016`) | The physical representation of publication state, deletion and retention/purge (`DDM-9`) |
| The field inventory and field classification (`OQ-6`, `OQ-7`); obligations (`OQ-8`/`OQ-8b`); lifecycle policy (`OQ-10`, `OQ-11`, `OQ-13`) | — |

---

## Context

**The logical model is decided; its physical expression is not.** `ADR-006` (Accepted
2026-08-07) ratified the listing-centric logical model and deliberately selected **no physical
representation**. `ADR-014`, `ADR-015` and `ADR-016` (all Accepted) selected Kysely, Kysely
`Migrator` and `pg` through `PostgresDialect`, and `kysely` 0.29.6 and `pg` 8.23.0 are installed
(issue #129, PR #130). **None of those decisions selects a physical data design**, and each says
so. `docs/08` *Deferred data decisions* records `DDM-2`, `DDM-6`, `DDM-8` and `DDM-9` as
**unresolved**.

**Why this cannot simply be left to the first persistence pull request.** `ADR-014` records as a
load-bearing assumption that *"physical data design will be governed as its own later work unit"*
and names as a risk that *"physical design is smuggled in with the first persistence pull
request"*, answering `DDM-2`–`DDM-9` by engineer (`IR-1`). The first schema, migration or `DB`
interface written would otherwise decide all four of these questions without anyone deciding
them (`docs/08` `R-1`). `docs/adr/README.md` requires an ADR for a decision that is
**structural** (it shapes the data model), **costly to reverse** (undoing it means migrating
data) and **cross-cutting**: the public read path `C4` → `C9`, the moderation service `C6`, and
the repository `C9` would all live with it (`docs/07`, *The two paths that carry the whole
product*). `C8` (Identity and Access) gates the privileged write path `C3` → `C8` → `C6` → `C9`
that performs revision, moderation and publication-state writes (`docs/07` `C8`); **this proposal
changes no `C8` behaviour** and is recorded against it as context only.

**Why the four are proposed together.** The four questions overlap on the same physical
structures. `DDM-8` and `DDM-9` must each represent the effective public version, publication
state and the purge of rejected revisions in one consistent shape; `DDM-6`'s designations sit
beside the content that `DDM-8` revises; and `DDM-2` supplies the identity every reference
between those structures uses. **Coordinating `DDM-8` and `DDM-9` is a design recommendation of
this ADR, not a mandatory sequencing rule of the chain** — each could in principle be proposed
separately, at the cost of deciding one against an assumed shape of the other.

**The forces, each from an approved source.** Mandatory requirements are distinguished from
design preferences throughout; a *preference* is marked as such.

| Force | Kind | Source |
|---|---|---|
| Identity is stable for life and never derived from content | **Mandatory** | `DI-8`, **P2**, `NFR-DATA-06`; `ADR-006` decision 1 |
| A public visitor supplies a listing identity to retrieve one approved listing, including through a previously shared direct link | **Mandatory** (established) | `docs/09` `OP-2` |
| Exactly one of three statuses; change only along permitted edges; *rejected* is terminal and **cannot be edited** | **Mandatory** | `DI-1`, `DI-2`, `FR-AUD-01`, `NFR-DATA-01/02`, `FR-ADM-07` |
| Every action completes fully or not at all, and is **never partially public** | **Mandatory** | `DI-3`, `BI-7`, `NFR-DATA-03` |
| No non-approved record reachable through any public path, including by direct reference to its identity; a non-approved record's existence is not disclosed by any observable difference, including count and ordering artefacts | **Mandatory** | `DI-5`, `BI-4`, `FR-VIS-02`, `FR-VIS-08`, `NFR-SEC-02` |
| Only the effective public version is public; a pending revision reaches no public path | **Mandatory** | `DI-10`, `FR-ADM-10` |
| At most one **pending** revision per listing. Revision **history** is neither restricted nor required: it *may* be retained | **Mandatory** (pending constraint); history **optional** | `DI-11`; `docs/08` *The revision lifecycle*; `ADR-006` decision 5 |
| Revisions to approved listings are created by **administrators**; no post-submission revision path exists for a business | **Mandatory** (established) | `FR-ADM-09`; `docs/09` `OP-6` |
| Every attribute carries an explicit public-or-not designation; the default is **not public**; phone, email, website and postal code are public only where designated | **Mandatory** | `S-2`, `FR-DATA-11`, `FR-DATA-11c`, `FR-DATA-06b`, `NFR-PRIV-01/02` |
| Administrative timestamps and workflow data are never public | **Mandatory** | `FR-DATA-11`, `NFR-PRIV-01/03` |
| Publication state applies only while *approved*; unpublishing needs a current reason; republication exposes the current approved version; publication is never implicit | **Mandatory** | `OQ-11`, `FR-ADM-12`, `FR-MOD-01`; `ADR-006` decision 3 |
| Rejected initial submissions and rejected revisions retained **90 days from the rejection**, then purged; purge-eligibility **derived, not stored**; purge all-or-nothing, idempotent, never alters an approved listing | **Mandatory** | `OQ-13`, `FR-AUD-06`, `NFR-PRIV-05`; `ADR-006` decision 7 |
| **No permanent-deletion capability** for listing records in the MVP | **Mandatory** | `OQ-11`; `docs/08` *Data lifecycle* step 7 |
| Purge applies to the live product; a restoration must not silently return a purged record to live use | **Mandatory** | `NFR-BACK-04`; `OQ-13` |
| Any retention of non-public data has a documented purpose and period | **Mandatory** | `NFR-PRIV-05`, `NFR-PRIV-04`, **P4** |
| SQL is the source of truth; `C9` is the sole data-access path; no persistence type reaches `src/domain/` | **Mandatory** (in force) | `ADR-014`; `ADR-002` `O-1` |
| The superuser role is not available on the named provider | **Mandatory** (in force) | `ADR-014`, `ADR-015` |
| No approved requirement asks for approved-content history | Fact, recorded as a limitation | `ADR-006` *Consequences — Negative* |
| Prefer invariants the store itself refuses to violate over invariants held by application discipline | **Preference** | `docs/08` *Privacy and security considerations* 1; `DI-5` *"stated over paths, not queries"* |
| Prefer the smaller physical surface for a single-maintainer MVP at small size | **Preference** | `PA-1`; `ADR-014` *Assumptions* |
| Prefer one identity per record over separate storage and public identifiers | **Preference** | **P1**/**P2** read in spirit; no requirement forbids a separate public reference |

## Decision

**Proposed — for Product Owner consideration. Not in force.**

**We propose a physical listing data design with four coordinated parts.** Structures below are
**conceptual**: they name structures, keys and constraints to make the proposal reviewable, and
they are **not** SQL, a schema, a migration, a column naming convention, a data type list or a
`DB` interface. Names in *italics* are descriptive labels for review, not identifiers. **Parts
marked *conditional* depend on an unresolved question and are not proposed unconditionally.**

### Physical structures versus product concepts

This design introduces **no** product entity, field, status value, transition or operation.
Every physical structure is an expression of a concept already decided:

| Proposed physical structure (conceptual) | Expresses which decided product concept | New product concept? |
|---|---|---|
| *Listing structure* — one row per listing | `E1`, the durable listing (`ADR-006` decision 1) | **No** |
| *Revision structure* — one row per revision proposal | `E7` (`OQ-10`; `ADR-006` decision 5) | **No** |
| Per-value public-display designations for postal code, phone, email, website | The designations `OQ-7`/`FR-DATA-11c`/`FR-DATA-06b` require; `S-2` | **No** — but **who captures or changes them, and when, is unresolved** (Q-4) |
| A publication-state datum and a current unpublish-reason datum on the listing | Publication state and the *current* unpublish reason (`OQ-11`; `docs/08` *Field classification*) | **No** |
| A write-once outcome timestamp on the revision structure | The **rejection moment** from which `OQ-13` measures retention, for revisions (see `DDM-9`) | **Conditional** — whether this is a `DDM-9` datum or `S-7` review data is **unresolved** (Q-1) |
| A single public read projection | The public projection (`S-2`, `DI-5`, `DI-10`; `ADR-006` decision 6) | **No** |

**Explicitly outside this design:** the representation of **category** (`DDM-3`, held by `OQ-5`)
and of **location normalisation** (`DDM-5`). The listing and revision structures will carry
category and location attributes, but **how** those are represented is not proposed here.
**Implementing category persistence requires `OQ-5` and `DDM-3` to be resolved first.** Review
data (`S-7`), audit entries (`S-8`/`E5`, `DDM-7`), safeguard data (`S-9`), duplicate structures
(`S-10`) and every index or text-search structure (`DDM-4`) are likewise outside it.

### 1. `DDM-2` — identity strategy (proposed)

**We propose that listing identity and revision identity each be an opaque, randomly generated
128-bit UUID (version 4), assigned once at creation, never reused, never derived from content,
and never changed.**

- **What is established, and what is proposed.** That a **public listing identity exists** is
  established: `docs/09` `OP-2` has an unauthenticated visitor provide *"the identity of one
  listing"*, including by following *"a previously shared direct link"*. That the public identity
  is **the same value as the storage primary key** is **not** established; it is **proposed here**,
  on the preference for one identity per record.
- **It is the primary key** of its structure and the target of every reference to it, and — on
  this proposal — also the public listing identity.
- **Random, not time-ordered — given that equivalence.** A version 7 UUID or ULID embeds its
  creation time; used as the public identity it would expose an administrative timestamp that
  `FR-DATA-11` and `NFR-PRIV-01` keep non-public.
- **Not sequential — given that equivalence.** A sequence used as the public identity lets an
  observer enumerate identities and infer the existence and ordering of records they cannot see —
  a count and ordering artefact `BI-4` forbids.
- **Generation locus is not decided here.** Generation in `C9` or by a database default are both
  compatible with this proposal; the choice depends on the PostgreSQL version, which is
  **unselected** (`ADR-013`).
- The existing domain type (`src/domain/listing/listing-id.ts`) deliberately fixes no carrier;
  this proposal would not require it to change and changes nothing in it.

### 2. `DDM-6` — non-public attributes and per-value display designations (proposed)

**We propose that non-public listing attributes be stored on the same row as the public ones,
that every value the chain makes conditionally public carry its own explicit, mandatory
designation datum whose default is *not public*, stored beside that value, and that every public
read go through one public read projection that applies those designations.**

- **Designations exist for exactly the values the chain makes conditional:** postal code, phone,
  email and website (`FR-DATA-11c`, `FR-DATA-06b`). Name, category, description, locality,
  country and administrative area are public-when-approved by classification and carry **no**
  designation; status, timestamps, publication state and the unpublish reason are never public
  and carry **no** designation. **No designation is added for any other attribute.**
- **Fail-closed by construction.** Each designation is **mandatory** (never absent) and
  **defaults to not public**. A value with no designation cannot exist.
- **Placement, not authority.** Each designation is stored **beside the value it governs** on the
  listing row. **Who captures a designation at submission, and whether anyone may change it
  afterwards and by what path, is not established and is not decided here** (Q-4): `FR-DATA-11c`
  lets *a business* designate, `docs/09` `OP-3` does not list designation among its inputs, and
  revisions are created only by administrators (`FR-ADM-09`, `docs/09` `OP-6`). *Conditional on
  Q-4:* whether a revision row carries designation data at all.
- **One public read projection.** The public read path (`C4`) reads listing content only through
  one projection that (a) admits only rows whose status is *approved* **and** whose publication
  state is *publicly available*, (b) exposes only attributes classified public, (c) exposes a
  conditionally public value only where its designation is *public*, and (d) **never reads the
  revision structure**. **Whether that projection is a database view or a single `C9` query
  module is not decided here**; either satisfies this proposal, and database-role or grant
  separation between public and administrative reads would involve credentials and connection
  configuration, which are **excluded**.

### 3. `DDM-8` — revision storage and the effective public version (proposed)

**We propose that the listing row always carry the listing's current content — for a pending
record, its submitted and administrator-completed content; for an approved record, its effective
public version — and that each revision proposal be a separate row in the revision structure,
carrying a complete proposed content set, which approval applies to the listing row in one
transaction.**

- **Who creates revisions.** An authenticated **administrator** (`FR-ADM-09`; `docs/09` `OP-6`).
  No business post-submission revision path is established, and none is assumed.
- **Revision row, conceptually:** its own identity (`DDM-2`); a mandatory reference to its
  listing; its revision state (*pending*, *approved*, *rejected*); a **complete** proposed
  content set for the editable listing content; *conditionally* its designation data (Q-4); and
  *conditionally* its outcome timestamp (Q-1).
- **Complete set, not a difference.** A complete proposed set is validated against the same rules
  as a submission (`VR-6`, `FR-VAL-04`) without reconstructing it from the listing, and approval
  is a whole-set application rather than a merge.
- **Approving a revision** is **one transaction** that validates the proposal, writes its content
  set onto the listing row, marks the revision *approved*, and updates the listing's
  last-updated time (`DI-6`). **Listing status, publication state and listing identity are not
  touched** — which is exactly `ADR-006`'s *approved → approved, content only*, and why a
  revision approved while unpublished stays unpublished (`FR-MOD-01`).
- **Rejecting a revision** is one transaction that marks it *rejected* and records its retention
  anchor (Q-1); **the listing row is not written** (`FR-ADM-10`).
- **The administrator atomic path** (`FR-ADM-10b`) is the same revision row created and approved
  inside one transaction; if any check fails the transaction rolls back and the listing row is
  unchanged (`DI-3`).
- **`DI-11` as a store constraint.** At most one revision row per listing may be in the *pending*
  state, enforced by a **conditional uniqueness constraint over pending rows only**. `DI-11`
  constrains the pending state; it does **not** require history. The relationship is kept
  one-to-many so that **optional** history is not foreclosed (`ADR-006` *Risks*). This is an
  integrity constraint, **not** a performance index; `DDM-4` is untouched.
- **What happens to an approved revision row after application is not decided** (Q-3). No
  requirement states a purpose or period for retaining it, and `NFR-PRIV-05` forbids indefinite
  retention of non-public data by default; this proposal therefore selects **neither** retention
  nor removal of approved revision rows.
- **Initial approval** writes no revision; it is a status transition on the listing row
  (`ADR-006` decision 1 — never a copy).

### 4. `DDM-9` — publication state, deletion and retention/purge (proposed)

**We propose an explicit publication-state datum on the listing row, constrained to be present
exactly when the listing is approved; no deletion capability for listing records other than the
purge of rejected ones; purge as physical removal; and purge-eligibility computed, never stored,
from a retention anchor.**

- **Listing status representation is not selected here.** The publication-state constraint below
  needs only to refer to *"status is approved"*, which `DI-1` already guarantees is a single
  well-defined condition. **Whether selecting the physical representation of listing status
  belongs within this ADR's approved scope is unresolved** (Q-5); no status type or store
  constraint for status is proposed. Which edges are permitted (`DI-2`) is enforced by `C6`/`C9`.
- **Publication state** is a two-valued datum — *publicly available* or *unpublished* — with a
  store constraint that it is **present if and only if status is *approved***, so it can neither
  exist on a pending or rejected record nor be absent from an approved one (`ADR-006` decision 3).
  It is **not** a fourth status value and **not** a boolean overloaded onto status.
- **Current unpublish reason** is a datum constrained to be present **if and only if** publication
  state is *unpublished*. Republication clears it. **It records current state only**; any history
  of unpublishing is `OQ-14`/`NOQ-8` and is **not** represented here.
- **Initial approval** sets status to *approved* and publication state to *publicly available* in
  the same transaction (`DI-3`, `BI-7`).
- **Deletion semantics.** No soft-delete marker, deletion flag or tombstone is introduced. Approved
  listings — published or unpublished — have **no** deletion path (`OQ-11`). The only removal the
  MVP performs is the purge of rejected records.
- **Retention anchor — rejected listing (conditional on Q-2).** Proposed: the listing's existing
  **last-updated** time, adding no listing datum. *Requirement wording:* a rejected record
  *"**cannot be edited and cannot later become approved**; `NFR-DATA-02`'s permitted lifecycle
  contains no transition out of *rejected*"* (`FR-ADM-07`); last-updated *"shall change whenever a
  record's content or status changes"* (`NFR-DATA-05`, `DI-6`); and *"rejecting an
  already-rejected one, is **not an error and not a second transition** … must not produce … two
  last-updated bumps"* (`docs/09`, *Idempotency of administrative operations*). *Inference, not
  requirement wording:* that together these fix last-updated at the rejection moment. No
  requirement names last-updated as the retention anchor. **`docs/09` `AQ-4`** (*"May an
  administrator reverse a decision — approve a rejected record, or re-reject?"*) remains listed as
  open; it **appears stale** against Decided `OQ-13`/`FR-ADM-07`, but it is **not formally
  reconciled**, and this ADR neither reconciles nor answers it. If reversal were ever permitted,
  this anchor would fail.
- **Retention anchor — rejected revision (conditional on Q-1).** `FR-AUD-06` measures retention
  *"from the rejection"*, and `E7` has no enumerated timestamp in `docs/08`. Proposed: a
  write-once outcome timestamp set in the rejecting transaction. **Whether that datum is a
  `DDM-9` representation or `S-7` review data (*"reviewed at"*) is unresolved**; if it is `S-7`,
  this anchor waits on `S-7`.
- The **90-day period** is the decided product value (`OQ-13`) and is **not** stored per row.
- **Purge-eligibility is derived** — anchor plus the retention period has elapsed — and is **never
  stored** (`ADR-006` decision 7). Eligibility changes nothing.
- **Purge is physical removal** of the purge-eligible rejected listing row, or of the
  purge-eligible rejected revision row, **each in its own transaction**. A rejected listing has
  no revision rows (revisions exist only for approved listings), so its purge touches no other
  listing data. Purging a revision row **never writes the listing row**. Removal of an
  already-removed row is a no-op, which makes purge **idempotent**.
- **Restoration.** Because eligibility is derived from data restored with the row, a record
  restored from a pre-purge backup is **still purge-eligible** and is removed by the next purge.
  **How purge is scheduled or run, and whether it runs as part of a restoration procedure, is not
  decided here** (`NFR-BACK-04` mechanics stay deferred).

### How the coordinated design conforms to `ADR-006`

| `ADR-006` decision (Accepted) | How the proposed design conforms |
|---|---|
| 1 — one durable listing identity; submission, approval, rejection are states of one concept | One listing row per listing for life; a random identity (`DDM-2`); approval is a status change on that row; no copy between concepts |
| 2 — exactly three statuses, permitted transitions, *rejected* terminal | No fourth value; transitions enforced in `C6`/`C9`; no transition out of *rejected*. The physical status representation is not selected (Q-5) |
| 3 — three orthogonal dimensions, never collapsed | Status and publication state are separate data on the listing row; revision state lives only on the revision row |
| 4 — exactly one effective public version | The listing row's content **is** the effective version while approved; revision rows never are |
| 5 — `E7` distinct, never public, one-to-many, at most one pending | A separate revision structure, one-to-many, a conditional uniqueness constraint over pending rows, and a public projection that never reads it |
| 6 — public visibility is a derived projection | One public read projection derived from status, publication state, classification and designations |
| 7 — retention and purge as rules; eligibility derived; purge all-or-nothing, idempotent, non-altering | Eligibility computed from an anchor (Q-1, Q-2); purge as single-row physical removal per transaction; no approved row is written |

`ADR-006` *Explicit deferrals* also named **no field names, flags, deletion markers or retention
timestamps** — because those are exactly what `DDM-8` and `DDM-9` own. This ADR proposes them
under those identifiers, and **would supersede nothing in `ADR-006` if accepted**.

## Cross-DDM consistency

| Concern | Identity (`DDM-2`) | Non-public (`DDM-6`) | Revisions (`DDM-8`) | Publication / purge (`DDM-9`) | Consistent? |
|---|---|---|---|---|---|
| **Privacy** | Opaque random identity leaks no time or count if used publicly | Mandatory designations, default not public; one projection | Proposals never read by the projection | Publication state, reason, anchors never public | Yes — every public read passes one projection over one structure |
| **Revisions** | Revision rows have their own identity and reference the listing | Designations beside their values; revision carriage conditional on Q-4 | Administrator-created; complete proposed set applied atomically | Publication state untouched by revision approval or rejection | Yes — subject to Q-3, Q-4 |
| **Publication** | — | Projection admits only *approved* + *publicly available* | Revision approval never republishes | Constrained datum present iff *approved*; reason iff *unpublished* | Yes |
| **Atomicity** | Identity fixed before first write | Designation written with its value | Apply-and-mark in one transaction | Approval sets status and publication state together; purge one row per transaction | Yes — every mandatory `DI-3` unit is one transaction |
| **Identity** | Stable, never reused | Unaffected | Revision approval never changes listing identity | Purge removes an identity permanently; it is never reused | Yes |
| **Retention / purge** | Removed identities not reused | Withheld contact data in a rejected record is purged with it | Rejected revision content purged with its row; approved revision rows undecided | Derived eligibility; anchors conditional | Conditional — Q-1, Q-2, Q-3 |

## Alternatives considered

Each alternative is classified. **Prohibited** means an accepted requirement or in-force decision
rules it out. **Viable — not proposed** means no accepted requirement rules it out, and it is set
aside on complexity, privacy surface, data minimisation or another stated preference; such an
alternative remains a legitimate choice for the Product Owner.

### `DDM-2` — identity strategy

| Alternative | Classification | Rationale |
|---|---|---|
| **Natural key** (e.g. name plus locality) | **Prohibited** | Violates `DI-8` and **P2**: `FR-ADM-04` lets an administrator correct a name, and the record must not become a different record |
| **Composite or content hash** | **Prohibited** | Derived from content; violates `DI-8` |
| **Database sequence / integer identity, used as the public identity** | **Prohibited** | Permits enumeration and discloses ordering and approximate counts of records the observer cannot see (`BI-4`, `NFR-SEC-02`) |
| **Database sequence as storage key, with a separate opaque public identifier** | **Viable — not proposed** | No requirement forbids a separate public reference. Set aside on **preference**: two identities for one record, a second uniqueness obligation, and a mapping every public path must use. **Reversal cost:** rewriting every key and reference |
| **UUID version 7 / ULID, used as the public identity** | **Prohibited** | Embeds creation time, exposing an administrative timestamp (`FR-DATA-11`, `NFR-PRIV-01`) |
| **UUID version 7 / ULID as storage key, with a separate public identifier** | **Viable — not proposed** | Better index locality, a `DDM-4` concern at a size `PA-1` says is small. Set aside on the same **preference** as above |

### `DDM-6` — non-public attributes and designations

| Alternative | Classification | Rationale |
|---|---|---|
| **Designations implicit** — absence of a value, or a convention in the read query | **Prohibited** | `S-2`: the designation must be explicit and the default *not public* |
| **Separate private structure** for withheld contact data, joined to the listing | **Viable — not proposed** | The separation is by designation, not by field, so a split structure must still carry designations or move values when a designation changes. Set aside on **complexity**: a join and a second write per revision application without a boundary the projection does not already enforce — **unless** paired with database-role separation, which requires excluded credential and connection configuration. **Remains a legitimate later option** |
| **Contact methods as child rows** (one row per method, each with a designation) | **Viable — not proposed** | More general than the fixed three-method inventory `OQ-7` settled. Set aside on **preference** against over-modelling (**P4**, `docs/08` `R-4`) and on **complexity** of whole-set revision application |
| **A separately maintained public copy** (a denormalised public structure) | **Viable — not proposed** | Can be kept consistent inside one transaction, so `NFR-DATA-03` does not prohibit it. Set aside on **preference**: a second place where *public* is decided (**P1**) and a synchronisation step in every approval, publication and revision application |

### `DDM-8` — revision storage

| Alternative | Classification | Rationale |
|---|---|---|
| **Fold revision state into listing status** | **Prohibited** | A fourth status; `FR-AUD-01`, `NFR-DATA-02`, `ADR-006` |
| **Immutable version rows with a pointer** from the listing to its effective version | **Viable — not proposed** | No requirement forbids it. Set aside on **privacy surface**: proposals share a structure with the effective version, so `DI-10` would rest on a pointer predicate in every public query. Retaining superseded approved versions would additionally require a documented purpose and period (`NFR-PRIV-05`) that no requirement supplies — the same open question as Q-3. **Reversal cost:** moderate; the natural path if history is later required |
| **Difference-only revision rows** | **Viable — not proposed** | Set aside on **complexity**: validation (`VR-6`) and approval must reconstruct the full set against a listing that may itself have changed |
| **Event-sourced history** with a derived current state | **Viable — not proposed** | Set aside on **complexity** for a single maintainer and because the derived current state adds its own freshness question to atomicity |
| **Revision content held on the listing row in additional columns** | **Viable — not proposed** | `DI-11` constrains only the pending state and does not require history, so one set of proposal columns can satisfy it. Set aside on **privacy surface**: proposal content sits on the row the public projection reads, one column away from exposure; it also forecloses **optional** history, which is permitted but not required |

### `DDM-9` — publication state, deletion, retention and purge

| Alternative | Classification | Rationale |
|---|---|---|
| **Fourth listing status (*unpublished*, *retained*)** | **Prohibited** | `OQ-10`, `OQ-11`, `OQ-13`, `ADR-006` |
| **Stored purge-eligibility flag** | **Prohibited** | `ADR-006` decision 7 requires eligibility to be **derived, not stored** |
| **Soft delete / logical marking that retains the rejected record's content** | **Prohibited** | Content kept past the 90-day period breaches `FR-AUD-06` (purge obligation) and `NFR-PRIV-05`. Separately, and as **preference** only, every read path would have to exclude marked rows |
| **Tombstone** (identity or minimal marker kept after content is removed) | **Viable — not proposed** | A tombstone visible only to administrators is **not** a public disclosure and does not by itself breach `BI-4`. Retaining it is non-public data that would need a documented purpose and period under `NFR-PRIV-05`, which no requirement supplies; it answers only *"did this exist"*, which no approved requirement asks. Set aside on **data minimisation** (`NFR-PRIV-04`, **P4**); any tombstone for audit purposes is `OQ-14` |
| **Boolean *published* flag** | **Viable — not proposed** | A nullable boolean with the same applicability constraint is equivalent. Set aside on **preference**: *not applicable* becomes a null convention rather than an explicit rule |
| **Unpublished-at timestamp as the state** | **Viable — not proposed** | Set aside on **preference**: it mixes current state with apparent history, and invites being read as an audit record (`OQ-14`) |
| **Presence of a row in a separate unpublish structure** | **Viable — not proposed** | Set aside on **complexity**: the projection's correctness would rest on an anti-join rather than a constrained datum |
| **Explicit *rejected-at* datum on the listing** | **Viable — not proposed; open under Q-2** | More explicit and independent of `AQ-4`'s reconciliation. Set aside only on **data minimisation** (**P4**), because the requirement wording in *Retention anchor — rejected listing* makes last-updated sufficient **by inference** |

## Consequences

**Positive:**

- **Several invariants gain a proposed physical mechanism.** The publication-state applicability
  rule and `DI-11` would be store constraints; `DI-3`/`BI-7` would be single transactions; and
  `DI-5`/`DI-10` would rest on one projection that never reads proposals. **Not every invariant
  is given a mechanism here:** physical enforcement of `DI-1` is deferred (Q-5), `DI-2` stays in
  `C6`/`C9`, and the retention anchors that `FR-AUD-06` purge depends on are conditional (Q-1, Q-2).
- **The public path reads one structure.** The effective public version is always the listing
  row, so a public query never selects among versions.
- **No superseded approved listing content is kept on the listing row.** Whether approved revision
  rows are kept is undecided (Q-3), so no claim is made about history retention overall.
- **Purge is simple and truthful** — removal, derived eligibility, idempotent by nature — and a
  restored pre-purge row is still eligible.
- **The hard `ADR-006` cases need no special handling**, in particular revising and approving a
  revision on an unpublished listing.
- **It fits the accepted tooling.** Nothing here requires a superuser, an extension, generated
  code or a store feature outside ordinary PostgreSQL constraints and transactions, and SQL
  remains the source of truth (`ADR-014`, `ADR-015`).

**Negative:**

- **Effective-content history is not provided.** An approved revision row records the
  **replacement** content that was proposed, not the effective content it replaced, so keeping
  approved revision rows would give **proposal history**, not complete effective-content history:
  *"what did this listing say before the last revision"* is answerable from them only where an
  earlier revision row happens to hold that content, and it does not guarantee reconstruction of
  content set at initial submission or by pending-record edits. This design adds no snapshot or other storage to close
  that gap, and whether approved revision rows are kept at all remains unresolved (Q-3).
- **Transition legality stays in application code.** The store constrains which states exist, not
  which edges were taken; `DI-2` depends on `C6`/`C9` and on attacking tests.
- **The proposed listing retention anchor rests on inference.** It holds only while rejection stays
  terminal and uneditable; `AQ-4` is not formally reconciled. The explicit alternative is recorded.
- **The single public projection is a single point of failure.** A defect in it is a privacy
  incident; it must be the most heavily attacked read in the system.
- **Purge removes the record permanently.** A future `OQ-14` "yes" that wants audit entries to
  reference purged records must not use a hard reference that blocks or cascades the purge; that
  constraint is handed to `S-8` rather than decided.
- **Random UUIDs index less compactly** than sequences — immaterial at `PA-1` size, and a `DDM-4`
  matter if it ever is not.
- **Several parts are conditional** (Q-1–Q-5). While a question is unresolved, the part that
  depends on it **cannot be implemented** — in particular no conditional choice, no indefinite
  retention of approved revision rows, and no designation-change authority may be assumed.
  **No partial acceptance is authorized by this Proposal.** Accepting less than the whole, or
  deferring a conditional part out of acceptance, would itself require an explicit Product Owner
  decision, accurately recorded.

**Reversibility:** **Expensive once data exists, cheap now.** Changing identity strategy rewrites
every key; moving from listing-row content to version rows is a data migration with a history
gap; replacing physical purge with a marking is easy forward but cannot recover purged data.
Reversal is cheapest **before the first migration**, at zero data volume — which is why this is
proposed before any schema exists. A change after acceptance would be a **superseding ADR**.

## Assumptions

| # | Assumption | If it is wrong |
|---|---|---|
| A-1 | **`PA-1` — the directory is small at first release.** | Index locality of random UUIDs and projection cost become `DDM-4` questions; the design itself does not change |
| A-2 | **A rejected listing's last-updated time is never changed after rejection.** *Requirement wording:* `FR-ADM-07` (terminal, uneditable), `NFR-DATA-02` (no transition out), `NFR-DATA-05`/`DI-6` (changes only on content or status change), `docs/09` idempotency rule (repeated rejection is a no-op with no last-updated bump). *Inference:* that these together fix it. `docs/09` `AQ-4` appears stale but is not reconciled | The retention anchor drifts; adopt the explicit *rejected-at* alternative instead (Q-2) |
| A-3 | **A write-once outcome timestamp on the revision structure is a `DDM-9` datum, not `S-7` review data.** **Not established by an authoritative document** | `S-7` must be resolved first and the revision retention anchor would come from there (Q-1) |
| A-4 | **Public listing identity equals the storage primary key.** Public identity is established (`docs/09` `OP-2`); the equivalence is a **proposal resting on preference** | Separate storage and public identifiers become the design; sequence and time-ordered storage keys become viable choices |
| A-5 | **Revisions exist only for approved listings**, so a rejected listing never has revision rows (`OQ-10`; `docs/08` `E7`; `FR-ADM-09`) | A rejected listing's purge would have to include dependent revision rows in the same transaction |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **This Proposal is read as accepted** and a schema or migration is written from it | `DDM-2`/`6`/`8`/`9` decided by implementation before the Product Owner rules (`IR-1`) | The status callout and the register both record `Proposed`, not in force; no DDM is marked resolved |
| **A conditional part is implemented as if unconditional** | Q-1–Q-5 answered by engineer — for example approved revisions kept indefinitely, or a designation-change path invented | Each conditional part is marked in place and listed under *Product Owner questions* |
| **A public read bypasses the projection** | Withheld contact data, pending records or proposals leak (`DI-5`, `DI-10`, `BI-6`) | One projection; later integration tests attack it with every non-public combination (see *Later integration evidence*) |
| **Designation default drifts to *public*** | A privacy incident that cannot be undone (`docs/08` `S-2`) | Designation mandatory with a *not public* default; tested by inserting without one |
| **Purge implemented against a hard reference from a future audit structure** | Purge blocked, or audit entries cascaded away | Recorded as a constraint for `S-8`/`OQ-14`; not decided here |
| **Category or location representation smuggled into the first schema** | `DDM-3` (`OQ-5`) or `DDM-5` decided by accident | Both explicitly excluded; category persistence waits on `OQ-5`/`DDM-3` |
| **Uniqueness over pending revisions implemented as one revision per listing** | Optional history foreclosed without a decision (`ADR-006` *Risks*) | The constraint is stated as conditional on the pending state |

## Later PostgreSQL integration evidence

**None of this is performed or authorized by this ADR.** It records what a real PostgreSQL
instance would later have to demonstrate (`docs/11` integration level), so acceptance can be
judged against testable consequences. Integration-test infrastructure remains unselected.

| Evidence | Invariant |
|---|---|
| A listing never holds a status outside the three values, or no status — at whichever level Q-5 places enforcement | `DI-1`, `BI-8` |
| Publication state on a pending or rejected row, or absent on an approved row, is refused; an unpublish reason without *unpublished* is refused | `ADR-006` decision 3 |
| Initial approval is never observable with status and publication state out of step, including by a concurrent reader | `DI-3`, `BI-7` |
| Revision approval is never observable half-applied; a failure rolls back with the listing row unchanged, including on the `FR-ADM-10b` path | `DI-3`, `DI-10`, `FR-ADM-10b` |
| Two concurrent attempts to create a pending revision for one listing leave at most one pending | `DI-11` |
| The public projection returns no pending, rejected or unpublished listing, no revision content and no withheld contact value, across every combination | `DI-5`, `DI-10`, `BI-6` |
| A row inserted without a designation is refused or defaults to *not public* | `S-2` |
| Purge removes only eligible rejected rows, never writes an approved row, and is a no-op when repeated | `FR-AUD-06`, `ADR-006` decision 7 |
| A rejected listing's last-updated time cannot change after rejection through any `C9` path, including a repeated rejection (if Q-2 keeps that anchor) | A-2, `DI-6` |
| `submitted at` cannot change after creation | `DI-6` |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OQ-5` / `DDM-3`** — category cardinality, curation, representation | No category representation is proposed; category persistence **requires `OQ-5`/`DDM-3` first** |
| **`DDM-5`** — location normalisation | Excluded; location attributes are named only as content the structures carry |
| **`OQ-4` / `DDM-4`** — searchable fields, indexing, text search | No index or search structure is proposed; the pending-revision uniqueness constraint is integrity, not performance |
| **`OQ-14` / `NOQ-8` / `DDM-7` / `S-8`** — audit logging | No audit structure, history of unpublishing, or linkage rule; the constraint on future references is recorded, not decided |
| **`S-7`** — review data shape | No reviewer, reviewed-at, action or moderation-note representation. The revision outcome timestamp is **conditional** on Q-1 |
| **`AQ-4`** (`docs/09`) — reversal of a moderation decision | Recorded as apparently stale against `OQ-13`/`FR-ADM-07` but not reconciled; neither answered nor amended here |
| **Approved-revision retention purpose and period** | Neither retention nor removal of approved revision rows is proposed (Q-3) |
| **Who captures or changes public-display designations, and when** | Designations are placed beside their values; no capture or change authority is granted (Q-4) |
| **`OQ-9` / `S-9`**, **`OQ-12` / `S-10`** | Untouched |
| **Whether unpublished approved listings acquire retention or purge** | Untouched; they have no deletion path in this design |
| **Whether a rejected record may be resubmitted** | Untouched; nothing links a new submission to a purged or rejected one |
| **`NOQ-7`** — operational-log retention | Untouched |
| **Migration contents, authoring format, execution environment and timing, rollback** | No migration is written or described; `ADR-015`'s outstanding items stay outstanding |
| **PostgreSQL version, provisioning, pool, TLS, secrets, environment** | None assumed; identity generation locus is left open precisely because the version is unselected |
| **Integration-test infrastructure, CI, `DG-4`** | Evidence is listed; no infrastructure, depth or coverage is chosen |

## Product Owner questions raised by this Proposal

All five remain **unresolved**. None blocks a coherent Proposal; each must be resolved before the
part that depends on it can be accepted or implemented. An unresolved question authorizes nothing,
and any narrowing or deferral of acceptance scope requires an explicit Product Owner decision.

| # | Question | Kind | Affected part |
|---|---|---|---|
| Q-1 | Is a write-once revision outcome timestamp a `DDM-9` retention anchor, or is it `S-7` review data that must wait for `S-7`? | Interpretation of an accepted requirement (`FR-AUD-06` *"from the rejection"*) against an open seam | `DDM-8` revision row; `DDM-9` revision retention anchor |
| Q-2 | For rejected listings, reuse last-updated as the retention anchor (proposed, by inference), or add an explicit *rejected-at* datum? | Physical implementation choice, dependent on `AQ-4` staying unreconciled-but-stale | `DDM-9` listing retention anchor |
| Q-3 | What is the purpose and period, if any, for retaining an **approved** revision row after application? | Unresolved product-policy decision (`NFR-PRIV-05`) | `DDM-8` post-approval handling |
| Q-4 | Who captures a business's public-display designation at submission, and who, if anyone, may change it afterwards and by what path? | Unresolved product-policy decision; `docs/09` `OP-3`/`OP-6` are silent | `DDM-6` authority; `DDM-8` revision carriage of designations |
| Q-5 | Does selecting the physical representation of listing status fall within this ADR's approved scope? | Scope decision; no numbered `DDM` owns it | `DDM-9` constraint enforcement of `DI-1` |

## Traceability

| | |
|---|---|
| **Requirements** | `FR-AUD-01`, `FR-AUD-02`, `FR-AUD-03`, `FR-AUD-06`; `FR-ADM-04`, `FR-ADM-06`, `FR-ADM-07`, `FR-ADM-09`, `FR-ADM-10`, `FR-ADM-10b`, `FR-ADM-12`; `FR-MOD-01`; `FR-VIS-02`, `FR-VIS-08`; `FR-DATA-06b`, `FR-DATA-11`, `FR-DATA-11b`, `FR-DATA-11c`; `FR-VAL-04`; `NFR-DATA-01`–`NFR-DATA-06`; `NFR-PRIV-01`–`NFR-PRIV-05`; `NFR-BACK-04`; `NFR-SEC-02` |
| **Journeys** | `V5`; `A5`, `A6`, `A7` |
| **Components** | `C4` (Directory Query Service — public projection), `C6` (Moderation Service), `C9` (Listing Repository) — shaped by this design. `C8` (Identity and Access) — **context only**: it gates the privileged write path that performs these writes; **no `C8` behaviour is changed** (`docs/07`) |
| **Invariants** | `DI-1`–`DI-11`; `BI-4`, `BI-6`, `BI-7`, `BI-8` |
| **Deferred decisions** | **`DDM-2`, `DDM-6`, `DDM-8`, `DDM-9` — proposed here; all remain unresolved.** `DDM-3`, `DDM-4`, `DDM-5`, `DDM-7` — excluded and untouched |
| **Seams** | `S-2`, `S-5`, `S-11` — resolved, preserved. `S-3`, `S-4`, `S-7`, `S-8`, `S-9`, `S-10` — open and untouched |
| **ADRs** | Conforms to `ADR-006`; consistent with `ADR-014`, `ADR-015`, `ADR-016`; context from `ADR-003`, `ADR-010`, `ADR-013` |
| **Documents amended** | `docs/adr/README.md`, `docs/traceability-matrix.md` — `Proposed` status only. `docs/08` and `docs/09` are **not** amended: no `DDM` changes state at `Proposed`, and `AQ-4` is not reconciled here |
| **Issue / pull request** | Issue **#131**. The pull-request number is supplied on merge (`CONTRIBUTING.md`) |
