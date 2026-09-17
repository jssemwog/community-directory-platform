# `ADR-017` — Physical listing data design: opaque random identity, effective content on the listing with separate revision records, explicit per-value public designations, a constrained publication-state representation, and physical purge of rejected records

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-09-17 (issue #137). Published as `Proposed` 2026-09-16 (issue #131) |
| **Date** | 2026-09-16 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*) |
| **Decision gate** | *none* — `DG-1` is **Resolved** (2026-08-04) and `DG-2` is **Resolved** (2026-08-27, issue #93); this ADR is a constituent of neither |
| **Related open questions** | **Depends on** (all Decided): `OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13`; and Accepted `ADR-006`, `ADR-014`, `ADR-015`, `ADR-016`. **Must NOT answer:** `OQ-4`, `OQ-5`, `OQ-12`, `OQ-14`/`NOQ-8`, `NOQ-7`, `OQ-9`; seams `S-3`, `S-4`, `S-7`, `S-8`, `S-9`, `S-10`; **`DDM-3`**, **`DDM-4`**, **`DDM-5`**, **`DDM-7`**; `AQ-4` (`docs/09`); migration execution, timing and rollback policy; provisioning, pool, TLS, secrets and environment configuration; integration-test infrastructure; `DG-3`, `DG-4` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-09-17 (issue #137). In force; later work may rely on it.**
> Published as `Proposed` 2026-09-16 (issue #131). The Product Owner approved physical
> selections **PS-1 through PS-11** and their documented deferrals on 2026-09-17 (see *Physical
> selections approved by the Product Owner*). The five questions this ADR raised while
> `Proposed` are **ruled as product policy** (see *Product Owner rulings on the questions raised
> by this ADR*); those rulings are not physical selections. **`DDM-2`, `DDM-6`, `DDM-8` and
> `DDM-9` are discharged by this `Accepted` ADR**; `DDM-3`, `DDM-4`, `DDM-5` and `DDM-7` are
> untouched. The count of decisions in force is **twelve**.
>
> **Acceptance is not implementation.** This `Accepted` ADR authorizes **no**
> SQL, schema file, migration, `DB` interface, `C9` code, dependency (including `@types/pg`),
> provisioning, connection, pool, TLS, secret, environment, integration-test infrastructure or CI
> change. Each remains a separate later work unit requiring its own owner authorization.

**What was already in force, and what this ADR selects.**

| Already in force (Accepted — this ADR relies on it and changes none of it) | Selected by this ADR |
|---|---|
| The logical listing model: one durable listing concept, three orthogonal state dimensions, one effective public version, `E7`, derived purge-eligibility, purge as a system obligation (`ADR-006`) | The physical identity strategy (`DDM-2`) |
| PostgreSQL under a managed posture; DigitalOcean Managed PostgreSQL (`ADR-003`, `ADR-013`) | The physical mechanism for non-public attributes and per-value display designations (`DDM-6`) |
| Kysely as the `C9` access approach, with SQL as the source of truth (`ADR-014`) | The physical revision storage and effective-public-version carrier (`DDM-8`) |
| Kysely `Migrator` (`ADR-015`); `pg` through `PostgresDialect` (`ADR-016`) | The physical representation of publication state, deletion and retention/purge (`DDM-9`) |
| The field inventory and field classification (`OQ-6`, `OQ-7`); obligations (`OQ-8`/`OQ-8b`); lifecycle policy (`OQ-10`, `OQ-11`, `OQ-13`) | The physical representation and enforcement of the existing three-value listing status (in scope by the Q-5 ruling; selected as PS-7) |
| **Product policy recorded in the owning documents** (ungated Product Owner clarifications, `docs/13`): approved-revision removal on application (Q-3, issue #133); designation authority and defaults (Q-4, issue #135); write-once rejection timestamps for retention eligibility only (Q-1/Q-2, issue #137); administrator atomic path refused while a revision is pending (issue #137) | — |

---

## Context

**The logical model was decided; its physical expression was not** *(context when proposed,
2026-09-16)*. `ADR-006` (Accepted
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
that performs revision, moderation and publication-state writes (`docs/07` `C8`); **this decision
changes no `C8` behaviour** and is recorded against it as context only.

**Why the four are decided together.** The four questions overlap on the same physical
structures. `DDM-8` and `DDM-9` must each represent the effective public version, publication
state and the purge of rejected revisions in one consistent shape; `DDM-6`'s designations sit
beside the content that `DDM-8` revises; and `DDM-2` supplies the identity every reference
between those structures uses. **Coordinating `DDM-8` and `DDM-9` is a design choice of
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
| At most one **pending** revision per listing. `DI-11` constrains the pending state and does not itself require or restrict history | **Mandatory** (pending constraint) | `DI-11`; `docs/08` *The revision lifecycle*; `ADR-006` decision 5 |
| Applying an approved revision's content and removing that approved proposal are **one atomic unit**; rejected revisions are retained 90 days, then purged; no retention purpose or period exists for approved proposals | **Mandatory** (Q-3 ruling) | `FR-ADM-10`, `NFR-PRIV-05`; `docs/08` *Approved-revision removal*; `docs/13` (issue #133) |
| The administrator create-and-approve operation is **refused while a revision is pending**; refusal preserves the listing and the pending revision; concurrent attempts preserve this; a failure restores the actual pre-operation state | **Mandatory** (ruling, issue #137) | `FR-ADM-10b`, `DI-3`, `DI-11`; `docs/09` `OP-6` |
| Revisions to approved listings are created by **administrators**; no post-submission revision path exists for a business | **Mandatory** (established) | `FR-ADM-09`; `docs/09` `OP-6` |
| Every attribute carries an explicit public-or-not designation; the default is **not public**; phone, email, website and postal code are public only where designated | **Mandatory** | `S-2`, `FR-DATA-11`, `FR-DATA-11c`, `FR-DATA-06b`, `NFR-PRIV-01/02` |
| The business designates each contact value and a supplied postal code **at submission**, default private; administrators may only **restrict**; new or replacement values default private without inheriting; designation changes to an approved listing follow the revision workflow | **Mandatory** (Q-4 ruling) | `FR-DATA-11c`, `FR-DATA-06b`, `FR-ADM-04`; `docs/09` `OP-3`, `OP-6`; `docs/13` (issue #135) |
| A rejected listing and a rejected revision each carry a **write-once rejection timestamp**, separate from last-updated, used **only** for retention eligibility; administrator-visible, never public; not review data or audit | **Mandatory** (Q-1/Q-2 ruling) | `FR-AUD-06`, `NFR-PRIV-05`, `DI-6`; `docs/08` *Field classification*; `docs/13` (issue #137) |
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

**Accepted 2026-09-17 — PS-1 through PS-11 approved by the Product Owner. In force.**

**We select a physical listing data design with four coordinated parts.** Structures below are
**conceptual**: they name structures, keys and constraints to make the decision reviewable, and
they are **not** SQL, a schema, a migration, a column naming convention, a data type list or a
`DB` interface. Names in *italics* are descriptive labels for review, not identifiers. **Product
policy already ruled is cited as such; every physical choice is a selection approved by the
Product Owner**, listed in *Physical selections approved by the Product Owner*.

### Physical structures versus product concepts

This design introduces **no** product entity, field, status value, transition or operation.
Every physical structure is an expression of a concept already decided:

| Selected physical structure (conceptual) | Expresses which decided product concept | New product concept? |
|---|---|---|
| *Listing structure* — one row per listing | `E1`, the durable listing (`ADR-006` decision 1) | **No** |
| *Revision structure* — one row per revision proposal | `E7` (`OQ-10`; `ADR-006` decision 5) | **No** |
| Per-value public-display designations for postal code, phone, email, website | The designations `OQ-7`/`FR-DATA-11c`/`FR-DATA-06b` require; `S-2`; capture and restriction authority per the Q-4 ruling | **No** |
| A listing-status datum on the listing | The existing three-value listing status (`FR-AUD-01`, `DI-1`); representation in scope by the Q-5 ruling | **No** |
| A publication-state datum and a current unpublish-reason datum on the listing | Publication state and the *current* unpublish reason (`OQ-11`; `docs/08` *Field classification*) | **No** |
| A revision-state datum on the revision structure | The revision lifecycle (`OQ-10`); only *pending* and *rejected* persist under the Q-3 ruling | **No** |
| A write-once rejection timestamp on the listing structure and on the revision structure | The **rejection moment** from which `OQ-13` measures retention (Q-1/Q-2 rulings; `docs/08` *Field classification*) — retention eligibility only; not `S-7` review data | **No** |
| A single public read projection | The public projection (`S-2`, `DI-5`, `DI-10`; `ADR-006` decision 6) | **No** |

**Explicitly outside this design:** the representation of **category** (`DDM-3`, held by `OQ-5`)
and of **location normalisation** (`DDM-5`). The listing and revision structures will carry
category and location attributes, but **how** those are represented is not selected here.
**Implementing category persistence requires `OQ-5` and `DDM-3` to be resolved first.** Review
data (`S-7`), audit entries (`S-8`/`E5`, `DDM-7`), safeguard data (`S-9`), duplicate structures
(`S-10`) and every index or text-search structure (`DDM-4`) are likewise outside it.

### 1. `DDM-2` — identity strategy (selected — PS-1)

**We select that listing identity and revision identity each be an opaque, randomly generated
128-bit UUID (version 4), assigned once at creation, never reused, never derived from content,
and never changed.**

- **What is established, and what is selected.** That a **public listing identity exists** is
  established: `docs/09` `OP-2` has an unauthenticated visitor provide *"the identity of one
  listing"*, including by following *"a previously shared direct link"*. That the public identity
  is **the same value as the storage primary key** is **not** established by an earlier document; it is **selected here**,
  on the preference for one identity per record.
- **It is the primary key** of its structure and the target of every reference to it, and — on
  this decision — also the public listing identity.
- **Random, not time-ordered — given that equivalence.** A version 7 UUID or ULID embeds its
  creation time; used as the public identity it would expose an administrative timestamp that
  `FR-DATA-11` and `NFR-PRIV-01` keep non-public.
- **Not sequential — given that equivalence.** A sequence used as the public identity lets an
  observer enumerate identities and infer the existence and ordering of records they cannot see —
  a count and ordering artefact `BI-4` forbids.
- **Generation locus is not decided here.** Generation in `C9` or by a database default are both
  compatible with this decision; the choice depends on the PostgreSQL version, which is
  **unselected** (`ADR-013`).
- The existing domain type (`src/domain/listing/listing-id.ts`) deliberately fixes no carrier;
  this decision does not require it to change and changes nothing in it.

### 2. `DDM-6` — non-public attributes and per-value display designations (selected — PS-2)

**We select that non-public listing attributes be stored on the same row as the public ones,
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
- **Placement selected; authority already ruled.** Each designation is stored **beside the value
  it governs** on the listing row. **Authority is product policy, not part of this physical
  decision** (Q-4 ruling; `FR-DATA-11c`, `docs/09` `OP-3`/`OP-6`): the business designates each
  supplied value at submission, default private; administrators may only restrict; a new or
  replacement value defaults to private and does not inherit. Because a designation change to an
  approved listing is part of the pending revision (`docs/09` `OP-6`), **a revision row carries
  designations** beside its proposed values (see `DDM-8`).
- **Restriction-only and non-inheritance are write-path rules.** They compare a proposed value
  and designation with the current ones, which a single-row store constraint cannot express; they
  are enforced by `C6`/`C9` and proven by attacking tests. **What counts as a "replacement" value
  is not defined here** and is a prerequisite for implementing the affected write paths (see
  *Deferred implementation details and dependencies*). **No route to make a private value public
  after submission exists**, and none is selected.
- **One public read projection.** The public read path (`C4`) reads listing content only through
  one projection that (a) admits only rows whose status is *approved* **and** whose publication
  state is *publicly available*, (b) exposes only attributes classified public, (c) exposes a
  conditionally public value only where its designation is *public*, and (d) **never reads the
  revision structure**. **Whether that projection is a database view or a single `C9` query
  module is not decided here**; either satisfies this decision, and database-role or grant
  separation between public and administrative reads would involve credentials and connection
  configuration, which are **excluded**.

### 3. `DDM-8` — revision storage and the effective public version (selected — PS-3 to PS-6, PS-11)

**We select that the listing row always carry the listing's current content — for a pending
record, its submitted and administrator-completed content; for an approved record, its effective
public version — and that each revision proposal be a separate row in the revision structure,
carrying a complete proposed content set, which approval applies to the listing row in one
transaction.**

- **Who creates revisions.** An authenticated **administrator** (`FR-ADM-09`; `docs/09` `OP-6`).
  No business post-submission revision path is established, and none is assumed.
- **Revision row, conceptually:** its own identity (`DDM-2`); a mandatory reference to its
  listing; its revision state — **only *pending* or *rejected* ever persist** (see *Persisted
  revision states*); a **complete** proposed content set for the editable listing content,
  **including the designation beside each conditionally public value** (Q-4 ruling); and a
  **write-once rejection timestamp**, present exactly when the revision is *rejected* (Q-1
  ruling).
- **Complete set, not a difference.** A complete proposed set is validated against the same rules
  as a submission (`VR-6`, `FR-VAL-04`) without reconstructing it from the listing, and approval
  is a whole-set application rather than a merge.
- **Approving a revision** is **one transaction** that, under the listing lock (PS-11), validates the proposal, writes its content
  set onto the listing row, updates the listing's last-updated time (`DI-6`), and **physically
  removes the revision row** (selected removal mechanics — see *Approved-proposal removal
  mechanics*). Application and removal are one atomic unit, as the Q-3 ruling requires; a failure
  rolls the whole transaction back, so the listing is unchanged and the revision remains pending.
  **Listing status, publication state and listing identity are not touched** — which is exactly
  `ADR-006`'s *approved → approved, content only*, and why a revision approved while unpublished
  stays unpublished (`FR-MOD-01`).
- **Rejecting a revision** is one transaction that, under the listing lock (PS-11), sets its state to *rejected* and writes its
  write-once rejection timestamp (Q-1 ruling); **the listing row is not written** (`FR-ADM-10`).
- **The administrator atomic path** (`FR-ADM-10b`) is one transaction that first
  acquires the listing lock (PS-11), then checks for a pending revision, inserts a *pending*
  revision row, validates it, applies its content to the listing row and removes the row. **The
  ruled refusal while a revision is pending** is decided by that check, made under the lock.
  Any refusal or failure rolls the transaction back to the **actual pre-operation state**: the
  approved listing and any pre-existing pending revision are unchanged, and no row created by
  the failed attempt remains (`DI-3`).
- **`DI-11` as a store constraint.** At most one revision row per listing may be in the *pending*
  state, enforced by a **conditional uniqueness constraint over pending rows only**. `DI-11`
  constrains the pending state; it does **not** require history. The relationship is kept
  one-to-many because a listing may hold a pending revision **and** rejected revisions still
  within their retention period. This is an integrity constraint, **not** a performance index;
  `DDM-4` is untouched. **It is a backstop, not the serialization mechanism:** because the
  atomic path removes its temporary row before commit, a transaction waiting on that row can
  insert its own pending row once the first commits, so uniqueness alone does not order
  revision work on a listing.
- **Per-listing serialization of revision work (selected — PS-11).** Every transaction that
  creates a revision, approves or rejects one, or performs the administrator create-and-approve
  operation **acquires an exclusive lock on the listing row before** it checks pending state or
  reads the current content it will use, and **holds that lock until commit or rollback**. All
  participating paths follow this one protocol, so revision work on one listing runs one
  transaction at a time.
  - **Visibility requirement.** Acquiring the lock does not refresh a transaction's snapshot.
    The chosen isolation and coordination mechanism must demonstrably make post-lock checks
    observe the preceding participant's committed state, or abort and restart. Conflict
    detection must not be assumed from lock acquisition alone: a participant may create a
    revision while locking — but not modifying — the listing row, so a later participant cannot
    rely on a listing-row modification conflict to reveal that work. One candidate is for each
    statement after the lock to take a fresh snapshot (a read-committed style of isolation);
    **no isolation level or retry policy is selected here.**
- **Serialization is not stale-input detection.** The lock orders transactions; it does **not**
  detect that an administrator prepared a revision, or an atomic edit, from content that has
  since changed. Content read into an editing screen before the transaction begins is outside
  the lock. How such stale input is detected or resolved is **deferred** (see *Deferred
  implementation details and dependencies*); no rejection, overwrite, merge or retry policy is
  selected here.
- **No approved revision row persists** (Q-3 ruling). No retention purpose or period is
  introduced for approved proposals, and rejected revision rows are retained under `OQ-13` and
  then purged.
- **Initial approval** writes no revision; it is a status transition on the listing row
  (`ADR-006` decision 1 — never a copy).

### 4. `DDM-9` — publication state, deletion and retention/purge (selected — PS-7 to PS-10)

**We select an explicit publication-state datum on the listing row, constrained to be present
exactly when the listing is approved; no deletion capability for listing records other than the
purge of rejected ones; purge as physical removal; and purge-eligibility computed, never stored,
from a retention anchor.**

- **Listing status representation is now in scope** (Q-5 ruling — scope authorization only).
  This ADR **selects** a mandatory status datum restricted by a store
  check to exactly the three existing values (see *Representation of the listing, publication and
  revision state data*). No status value or transition changes (`FR-AUD-01`, `NFR-DATA-02`).
  Which edges are permitted (`DI-2`) remains enforced by `C6`/`C9`.
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
- **Retention anchor — rejected listing** (Q-2 ruling: an explicit write-once rejection
  timestamp, separate from last-updated, for retention eligibility only). Selected physical
  expression: a timestamp datum on the listing row, **present if and only if status is
  *rejected***, written in the rejecting transaction. The anchor therefore no longer rests on the
  inference that last-updated stops changing after rejection. **`docs/09` `AQ-4`** still appears
  stale against Decided `OQ-13`/`FR-ADM-07`; it is **not reconciled** here, and this anchor does
  not depend on its reconciliation.
- **Retention anchor — rejected revision** (Q-1 ruling: a write-once rejection timestamp for
  retention eligibility only; **not** `S-7` review data). Selected physical expression: a
  timestamp datum on the revision row, **present if and only if the revision state is
  *rejected***, written in the rejecting transaction.
- **Write-once enforcement is selected (PS-9).** The presence rules above are single-row store
  checks; **that a written rejection timestamp never changes** compares old and new values, so it
  is enforced on the write path (`C6`/`C9`, proven by attacking tests — **selected**) rather
  than by a store trigger (see *Rejection-timestamp write-once enforcement*).
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

### Representation of the listing, publication and revision state data (selected — PS-5, PS-7, PS-8)

**Each of the three state data is justified on its own terms. Identical mechanisms are not
mandatory**; each was approved on its own rationale. The PostgreSQL
version is unselected (`ADR-013`), so no version-specific behaviour is relied on.

- **Listing status — selected: a mandatory text datum restricted by a store check to the
  three existing values.** The set is fixed by product decision (`FR-AUD-01`, `NFR-DATA-02`), so
  any change to it is a product decision followed by a migration whichever representation is
  used. A check constraint is ordinary table DDL that a migration can replace, needs no separate
  type object, and keeps the stored values readable. A native enumerated type is **viable**: it
  documents the value set at the type level, and its values can be added and renamed; removing a
  value is not supported in place and requires replacing the type, and adding a value is subject
  to transaction-block restrictions whose detail depends on the unselected server version. The
  selection rests on that migration and version-independence **preference**, not on a
  requirement.
- **Publication state — selected: a nullable text datum restricted to the two values
  *publicly available* and *unpublished*, with the store constraint that it is present if and
  only if status is *approved*.** Its distinguishing need is **applicability**, not the value set:
  "not applicable" must be an explicit, constrained absence, never a third value and never
  confused with *unpublished*. A nullable boolean with the same applicability constraint is
  equivalent in integrity and **viable**; it is set aside because *unpublished* would be encoded
  as `false`, which reads as a convention rather than a named state. A native enumerated type is
  **viable** on the same terms as for listing status.
- **Revision state — selected: a mandatory text datum restricted to *pending* and
  *rejected*, with the store constraint that the rejection timestamp is present if and only if
  the state is *rejected*.** Under the Q-3 ruling an approved revision row never persists, so
  *approved* is not a stored value (see *Persisted revision states*). An explicit state datum is
  preferred over deriving the state from the timestamp's presence, because the Q-1 ruling limits
  that timestamp to **retention eligibility only**; making it carry lifecycle meaning would extend
  its purpose. It also keeps the pending-uniqueness constraint (`DI-11`) stated over a named
  state.

### How the coordinated design conforms to `ADR-006`

| `ADR-006` decision (Accepted) | How the selected design conforms |
|---|---|
| 1 — one durable listing identity; submission, approval, rejection are states of one concept | One listing row per listing for life; a random identity (`DDM-2`); approval is a status change on that row; no copy between concepts |
| 2 — exactly three statuses, permitted transitions, *rejected* terminal | No fourth value; a store check restricts status to the three values (PS-7); transitions enforced in `C6`/`C9`; no transition out of *rejected* |
| 3 — three orthogonal dimensions, never collapsed | Status and publication state are separate data on the listing row; revision state lives only on the revision row |
| 4 — exactly one effective public version | The listing row's content **is** the effective version while approved; revision rows never are |
| 5 — `E7` distinct, never public, one-to-many, at most one pending | A separate revision structure, one-to-many, a conditional uniqueness constraint over pending rows, and a public projection that never reads it |
| 6 — public visibility is a derived projection | One public read projection derived from status, publication state, classification and designations |
| 7 — retention and purge as rules; eligibility derived; purge all-or-nothing, idempotent, non-altering | Eligibility computed from the write-once rejection timestamps (Q-1/Q-2 rulings); purge as single-row physical removal per transaction; no approved row is written |

`ADR-006` *Explicit deferrals* also named **no field names, flags, deletion markers or retention
timestamps** — because those are exactly what `DDM-8` and `DDM-9` own. This ADR selects them
under those identifiers, and **supersedes nothing in `ADR-006`**.

## Cross-DDM consistency

| Concern | Identity (`DDM-2`) | Non-public (`DDM-6`) | Revisions (`DDM-8`) | Publication / purge (`DDM-9`) | Consistent? |
|---|---|---|---|---|---|
| **Privacy** | Opaque random identity leaks no time or count if used publicly | Mandatory designations, default not public; one projection | Proposals never read by the projection | Publication state, reason, anchors never public | Yes — every public read passes one projection over one structure |
| **Revisions** | Revision rows have their own identity and reference the listing | Designations beside their values, on the listing row and on revision rows (Q-4 ruling) | Administrator-created; complete proposed set applied and the row removed atomically (Q-3 ruling); atomic path refused while a revision is pending | Publication state untouched by revision approval or rejection | Yes |
| **Publication** | — | Projection admits only *approved* + *publicly available* | Revision approval never republishes | Constrained datum present iff *approved*; reason iff *unpublished* | Yes |
| **Atomicity** | Identity fixed before first write | Designation written with its value | Apply-and-remove in one transaction | Approval sets status and publication state together; purge one row per transaction | Yes — every mandatory `DI-3` unit is one transaction |
| **Identity** | Stable, never reused | Unaffected | Revision approval never changes listing identity | Purge removes an identity permanently; it is never reused | Yes |
| **Retention / purge** | Removed identities not reused | Withheld contact data in a rejected record is purged with it | Rejected revision content purged with its row; approved revision rows removed on application | Derived eligibility from write-once rejection timestamps | Yes |

## Alternatives considered

Each alternative is classified. **Prohibited** means an accepted requirement or in-force decision
rules it out. **Viable — not selected** means no accepted requirement ruled it out, and it was set
aside on complexity, privacy surface, data minimisation or another stated preference; such an
alternative was a legitimate choice the Product Owner considered before selecting PS-1 to PS-11.

### `DDM-2` — identity strategy

| Alternative | Classification | Rationale |
|---|---|---|
| **Natural key** (e.g. name plus locality) | **Prohibited** | Violates `DI-8` and **P2**: `FR-ADM-04` lets an administrator correct a name, and the record must not become a different record |
| **Composite or content hash** | **Prohibited** | Derived from content; violates `DI-8` |
| **Database sequence / integer identity, used as the public identity** | **Prohibited** | Permits enumeration and discloses ordering and approximate counts of records the observer cannot see (`BI-4`, `NFR-SEC-02`) |
| **Database sequence as storage key, with a separate opaque public identifier** | **Viable — not selected** | No requirement forbids a separate public reference. Set aside on **preference**: two identities for one record, a second uniqueness obligation, and a mapping every public path must use. **Reversal cost:** rewriting every key and reference |
| **UUID version 7 / ULID, used as the public identity** | **Prohibited** | Embeds creation time, exposing an administrative timestamp (`FR-DATA-11`, `NFR-PRIV-01`) |
| **UUID version 7 / ULID as storage key, with a separate public identifier** | **Viable — not selected** | Better index locality, a `DDM-4` concern at a size `PA-1` says is small. Set aside on the same **preference** as above |

### `DDM-6` — non-public attributes and designations

| Alternative | Classification | Rationale |
|---|---|---|
| **Designations implicit** — absence of a value, or a convention in the read query | **Prohibited** | `S-2`: the designation must be explicit and the default *not public* |
| **Separate private structure** for withheld contact data, joined to the listing | **Viable — not selected** | The separation is by designation, not by field, so a split structure must still carry designations or move values when a designation changes. Set aside on **complexity**: a join and a second write per revision application without a boundary the projection does not already enforce — **unless** paired with database-role separation, which requires excluded credential and connection configuration. **Remains a legitimate later option** |
| **Contact methods as child rows** (one row per method, each with a designation) | **Viable — not selected** | More general than the fixed three-method inventory `OQ-7` settled. Set aside on **preference** against over-modelling (**P4**, `docs/08` `R-4`) and on **complexity** of whole-set revision application |
| **A separately maintained public copy** (a denormalised public structure) | **Viable — not selected** | Can be kept consistent inside one transaction, so `NFR-DATA-03` does not prohibit it. Set aside on **preference**: a second place where *public* is decided (**P1**) and a synchronisation step in every approval, publication and revision application |

### `DDM-8` — revision storage

| Alternative | Classification | Rationale |
|---|---|---|
| **Fold revision state into listing status** | **Prohibited** | A fourth status; `FR-AUD-01`, `NFR-DATA-02`, `ADR-006` |
| **Immutable version rows with a pointer** from the listing to its effective version | **Viable — not selected** | No requirement forbids it. Set aside on **privacy surface**: proposals share a structure with the effective version, so `DI-10` would rest on a pointer predicate in every public query. Retaining superseded approved versions would additionally require a documented purpose and period (`NFR-PRIV-05`) that no requirement supplies, and the Q-3 ruling introduces none. **Reversal cost:** moderate; the natural path if history is later required |
| **Difference-only revision rows** | **Viable — not selected** | Set aside on **complexity**: validation (`VR-6`) and approval must reconstruct the full set against a listing that may itself have changed |
| **Event-sourced history** with a derived current state | **Viable — not selected** | Set aside on **complexity** for a single maintainer and because the derived current state adds its own freshness question to atomicity |
| **Revision content held on the listing row in additional columns** | **Viable — not selected** | `DI-11` constrains only the pending state and does not require history, so one set of proposal columns can satisfy it. Set aside on **privacy surface**: proposal content sits on the row the public projection reads, one column away from exposure; it also cannot hold rejected revisions retained under `OQ-13` alongside a new pending one |

### `DDM-8` — approved-proposal removal mechanics

The Q-3 ruling fixes the **policy**: application and removal are one atomic unit. The table
compares **how** removal happens.

| Alternative | Classification | Rationale |
|---|---|---|
| **Physically remove the revision row in the same transaction that applies its content** | **Selected** | Satisfies the one-unit rule directly; nothing is retained without a purpose (`NFR-PRIV-05`); no approved row ever becomes observable after commit |
| **Mark the row *approved* and remove it later** (by purge or a follow-up job) | **Prohibited** | Application and removal would no longer be one atomic unit (Q-3 ruling), and an approved proposal would be retained without a purpose or period |
| **Soft-delete marker or move to an archive structure** | **Prohibited** | Retains approved proposal content without a documented purpose or period (`NFR-PRIV-05`, Q-3 ruling) |
| **Never store the proposal on the atomic path** — apply the submitted content directly | **Viable — not selected** | Satisfies Q-3 and, under PS-11, the refusal is still decided under the listing lock. Set aside because it gives the atomic path a different write shape from ordinary revision approval, so the two paths could not share one validate-apply-remove sequence |

### `DDM-8` — persisted revision states

| Alternative | Classification | Rationale |
|---|---|---|
| **Persist only *pending* and *rejected*** | **Selected** | Under the Q-3 ruling an approved row is removed in its approving transaction, so *approved* is never a committed state; the stored value set matches what can exist |
| **Persist *pending*, *approved* and *rejected*** | **Viable — not selected** | Harmless as a value no committed row holds, but it is a dead state that invites an approved row being kept, contrary to the Q-3 ruling |
| **Derive state from the rejection timestamp's presence** (no state datum) | **Viable — not selected** | One fewer datum, but it gives a timestamp limited to retention eligibility (Q-1 ruling) a lifecycle meaning, and states `DI-11` over the absence of a timestamp |

### `DDM-8` — per-listing serialization of revision transactions (PS-11)

| Alternative | Classification | Rationale |
|---|---|---|
| **Exclusive lock on the listing row, acquired first and held to commit, by every revision-creating, approving, rejecting and atomic transaction** | **Selected** | Uses the row every participant already writes or reads; one protocol for all paths; the pending check and content read happen after serialization; no extra structure. Correct only if every participating path follows the protocol, which attacking tests must prove |
| **Pending-uniqueness constraint alone** | **Prohibited as the serialization mechanism** | Does not order transactions when the atomic path's temporary row is removed before commit; retained only as an integrity backstop for `DI-11` |
| **Serializable isolation with retry** for the participating transactions | **Viable — not selected** | The store detects conflicting interleavings without an explicit lock, but every participant must handle serialization failures and retry, and correctness depends on all such transactions running at that level. Set aside on **complexity** of retry handling |
| **Advisory lock keyed by listing identity** | **Viable — not selected** | Serializes the same work without locking the row, but relies on every path using the same key convention outside the data itself, and is invisible to anything that writes the row directly. Set aside on the **preference** for coordination tied to the data it protects |
| **Application-level (in-process) locking** | **Prohibited** | Does not coordinate transactions across processes or instances, so it cannot guarantee serialization |

### `DDM-9` — publication state, deletion, retention and purge

| Alternative | Classification | Rationale |
|---|---|---|
| **Fourth listing status (*unpublished*, *retained*)** | **Prohibited** | `OQ-10`, `OQ-11`, `OQ-13`, `ADR-006` |
| **Stored purge-eligibility flag** | **Prohibited** | `ADR-006` decision 7 requires eligibility to be **derived, not stored** |
| **Soft delete / logical marking that retains the rejected record's content** | **Prohibited** | Content kept past the 90-day period breaches `FR-AUD-06` (purge obligation) and `NFR-PRIV-05`. Separately, and as **preference** only, every read path would have to exclude marked rows |
| **Tombstone** (identity or minimal marker kept after content is removed) | **Viable — not selected** | A tombstone visible only to administrators is **not** a public disclosure and does not by itself breach `BI-4`. Retaining it is non-public data that would need a documented purpose and period under `NFR-PRIV-05`, which no requirement supplies; it answers only *"did this exist"*, which no approved requirement asks. Set aside on **data minimisation** (`NFR-PRIV-04`, **P4**); any tombstone for audit purposes is `OQ-14` |
| **Boolean *published* flag** | **Viable — not selected** | A nullable boolean with the same applicability constraint is equivalent. Set aside on **preference**: *not applicable* becomes a null convention rather than an explicit rule |
| **Unpublished-at timestamp as the state** | **Viable — not selected** | Set aside on **preference**: it mixes current state with apparent history, and invites being read as an audit record (`OQ-14`) |
| **Presence of a row in a separate unpublish structure** | **Viable — not selected** | Set aside on **complexity**: the projection's correctness would rest on an anti-join rather than a constrained datum |
| **Explicit write-once rejection timestamp on the listing** | **Selected** — required by the Q-2 ruling | Separate from last-updated and independent of `AQ-4`'s reconciliation; present if and only if status is *rejected* |
| **Reuse last-updated as the rejected-listing retention anchor** | **Prohibited** by the Q-2 ruling | The ruling requires a timestamp separate from last-updated; the earlier proposal rested on inference |

### Listing-status representation (in scope by the Q-5 ruling)

| Alternative | Classification | Rationale |
|---|---|---|
| **Mandatory text datum with a store check over the three values** | **Selected** | Store refuses any other value or none (`DI-1`); ordinary, replaceable table DDL; no separate type object; behaviour independent of the unselected server version |
| **Native enumerated type** | **Viable — not selected** | Store refuses any other value; documents the set at the type level; values can be added and renamed, but not removed in place, and adding a value has version-dependent transaction-block restrictions. Set aside on the migration and version-independence **preference** only |
| **Reference table of statuses with a foreign key** | **Viable — not selected** | Enforces membership, but models a fixed, product-decided set as data that could appear editable, and adds a join. Set aside on **P4** (no over-modelling) |
| **Small integer codes** | **Viable — not selected** | Enforceable with a check, but opaque in the store and in every administrative query. Set aside on readability |
| **Independent boolean flags** (*is approved*, *is rejected*) | **Prohibited** | Permits zero or two states at once unless further constrained, which contradicts `DI-1`'s exactly-one rule by construction |

### Rejection-timestamp write-once enforcement

| Alternative | Classification | Rationale |
|---|---|---|
| **Presence by store check; immutability on the write path (`C6`/`C9`), proven by attacking tests** | **Selected** | Consistent with `DI-2` transition legality staying in `C6`/`C9`; no procedural code in the schema |
| **Presence by store check; immutability by a store trigger** | **Viable — not selected** | Store-enforced, matching the preference for store invariants, but adds procedural schema code to author, migrate and test. Was a legitimate choice considered before selection |

## Consequences

**Positive:**

- **Several invariants gain a selected physical mechanism.** The listing-status value set
  (`DI-1`), the publication-state applicability rule, the rejection-timestamp presence rules and
  `DI-11` would be store constraints; `DI-3`/`BI-7` would be single transactions; and
  `DI-5`/`DI-10` would rest on one projection that never reads proposals. **Not every invariant
  is given a store mechanism:** `DI-2` edge legality, rejection-timestamp immutability, and
  designation restriction-only and non-inheritance stay on the `C6`/`C9` write path.
- **The public path reads one structure.** The effective public version is always the listing
  row, so a public query never selects among versions.
- The design creates no effective-content history and no superseded-version snapshots: the
  listing row holds only the current content, and approved revision rows are removed on
  application (Q-3 ruling).
- **Purge is simple and truthful** — removal, derived eligibility, idempotent by nature — and a
  restored pre-purge row is still eligible.
- **The hard `ADR-006` cases need no special handling**, in particular revising and approving a
  revision on an unpublished listing.
- **It fits the accepted tooling.** Nothing here requires a superuser, an extension, generated
  code or a store feature outside ordinary PostgreSQL constraints and transactions, and SQL
  remains the source of truth (`ADR-014`, `ADR-015`).

**Negative:**

- **Effective-content history is not provided.** Approved revision rows are removed on
  application (Q-3 ruling), and even had they been kept they would record the **replacement**
  content that was proposed, not the effective content it replaced — **proposal history**, not
  complete effective-content history. *"What did this listing say before the last revision"* is
  not answerable from this design, which adds no snapshot or other storage to answer it.
- **Transition legality, write-once immutability and designation authority stay in application
  code.** The store constrains which states and presences exist, not which edges were taken or
  how a value changed; they depend on `C6`/`C9` and on attacking tests.
- **An extra datum per rejected record.** The Q-1/Q-2 rulings add a write-once rejection
  timestamp to each rejected listing and rejected revision. It is purged with its record.
- **The single public projection is a single point of failure.** A defect in it is a privacy
  incident; it must be the most heavily attacked read in the system.
- **Purge removes the record permanently.** A future `OQ-14` "yes" that wants audit entries to
  reference purged records must not use a hard reference that blocks or cascades the purge; that
  constraint is handed to `S-8` rather than decided.
- **Random UUIDs index less compactly** than sequences — immaterial at `PA-1` size, and a `DDM-4`
  matter if it ever is not.
- **Some implementation details are deferred** (see *Deferred implementation details and
  dependencies*). They are outside the physical selections, and each names the implementation it
  blocks. **The whole design (PS-1 through PS-11) is accepted; nothing is partially accepted.**

**Reversibility:** **Expensive once data exists, cheap now.** Changing identity strategy rewrites
every key; moving from listing-row content to version rows is a data migration with a history
gap; replacing physical purge with a marking is easy forward but cannot recover purged data.
Reversal is cheapest **before the first migration**, at zero data volume — which is why this is
decided before any schema exists. A change after acceptance would be a **superseding ADR**.

## Assumptions

| # | Assumption | If it is wrong |
|---|---|---|
| A-1 | **`PA-1` — the directory is small at first release.** | Index locality of random UUIDs and projection cost become `DDM-4` questions; the design itself does not change |
| A-2 | ~~A rejected listing's last-updated time is never changed after rejection.~~ **Retired** — the Q-2 ruling replaces this inference with an explicit write-once rejection timestamp | — |
| A-3 | ~~A write-once outcome timestamp on the revision structure is a `DDM-9` datum, not `S-7` review data.~~ **Retired** — the Q-1 ruling establishes a retention-only rejection timestamp that is not review data (`docs/08` `S-7`) | — |
| A-4 | **Public listing identity equals the storage primary key.** Public identity is established (`docs/09` `OP-2`); the equivalence is a **selection resting on preference** (PS-1) | Separate storage and public identifiers become the design; sequence and time-ordered storage keys become viable choices |
| A-5 | **Revisions exist only for approved listings**, so a rejected listing never has revision rows (`OQ-10`; `docs/08` `E7`; `FR-ADM-09`) | A rejected listing's purge would have to include dependent revision rows in the same transaction |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **Acceptance is read as implementation authority** and a schema or migration is written without its own work unit | SQL, migrations or code produced without authorization (`IR-1`) | The status callout, the register and `docs/08` all state that acceptance authorizes no implementation |
| **A deferred detail is implemented as if decided** | A replacement rule, a later-publication route, or a purge schedule invented by engineer | Each is listed under *Deferred implementation details and dependencies*, with the implementation it blocks |
| **A participating path skips the listing lock** | Revision work on one listing interleaves: an atomic operation and a new pending revision, or two atomic operations, both succeed against content the other changed | PS-11 requires one protocol for every revision-creating, approving, rejecting and atomic path; later evidence attacks each path concurrently |
| **Serialization mistaken for stale-input protection** | A revision or atomic edit prepared from content that changed before its transaction began overwrites the newer content | Recorded as a deferred policy with its affected write paths; no policy is assumed |
| **An implementation departs from an approved selection** | A representation chosen by the first migration rather than the approved one (`IR-1`) | Every selection is listed under *Physical selections approved by the Product Owner*; departing from one requires a superseding ADR |
| **A public read bypasses the projection** | Withheld contact data, pending records or proposals leak (`DI-5`, `DI-10`, `BI-6`) | One projection; later integration tests attack it with every non-public combination (see *Later integration evidence*) |
| **Designation default drifts to *public*** | A privacy incident that cannot be undone (`docs/08` `S-2`) | Designation mandatory with a *not public* default; tested by inserting without one |
| **Purge implemented against a hard reference from a future audit structure** | Purge blocked, or audit entries cascaded away | Recorded as a constraint for `S-8`/`OQ-14`; not decided here |
| **Category or location representation smuggled into the first schema** | `DDM-3` (`OQ-5`) or `DDM-5` decided by accident | Both explicitly excluded; category persistence waits on `OQ-5`/`DDM-3` |
| **Uniqueness over pending revisions implemented as one revision per listing** | A new pending revision refused while a rejected revision is still retained under `OQ-13` (`ADR-006` *Risks*) | The constraint is stated as conditional on the pending state |

## Later PostgreSQL integration evidence

**None of this is performed or authorized by this ADR.** It records what a real PostgreSQL
instance would later have to demonstrate (`docs/11` integration level), so acceptance can be
judged against testable consequences. Integration-test infrastructure remains unselected.

| Evidence | Invariant |
|---|---|
| A listing never holds a status outside the three values, or no status, under whichever representation is approved | `DI-1`, `BI-8` |
| Publication state on a pending or rejected row, or absent on an approved row, is refused; an unpublish reason without *unpublished* is refused | `ADR-006` decision 3 |
| Initial approval is never observable with status and publication state out of step, including by a concurrent reader | `DI-3`, `BI-7` |
| Revision approval is never observable half-applied: content application and revision-row removal are never observed separately, and a failure rolls back with the listing row unchanged and the revision still pending | `DI-3`, `DI-10`, `FR-ADM-10` |
| After a committed approval no approved revision row remains | Q-3 ruling, `NFR-PRIV-05` |
| The `FR-ADM-10b` operation is refused while a revision is pending, including a pending revision committed while it waited for the listing lock; any refusal or failure leaves the approved listing and the pre-existing pending revision unchanged and leaves no newly created row | `FR-ADM-10b`, `DI-3`, `DI-11` |
| Two concurrent attempts to create a pending revision for one listing leave at most one pending | `DI-11` |
| Concurrent revision work on one listing — an atomic operation with revision creation, two atomic operations, or approval with rejection — is serialized by the listing lock: each later transaction's pending check and content read observe the earlier one's committed result | PS-11, `DI-3`, `DI-11` |
| Every revision-creating, approving, rejecting and atomic path acquires the listing lock before its pending check or content read | PS-11 |
| A revision row carries a designation for each conditionally public value, and a missing designation is refused or defaults to *not public* | `S-2`, Q-4 ruling |
| The public projection returns no pending, rejected or unpublished listing, no revision content and no withheld contact value, across every combination | `DI-5`, `DI-10`, `BI-6` |
| A row inserted without a designation is refused or defaults to *not public* | `S-2` |
| Purge removes only eligible rejected rows, never writes an approved row, and is a no-op when repeated | `FR-AUD-06`, `ADR-006` decision 7 |
| A rejection timestamp is present on a listing or revision exactly when it is *rejected*, is never public, and cannot change after it is written through any `C9` path, including a repeated rejection | `DI-6`, `FR-AUD-06`, Q-1/Q-2 rulings |
| A revision state outside *pending* and *rejected* is refused, and a *rejected* state without a rejection timestamp (or the reverse) is refused | Q-1/Q-3 rulings |
| `submitted at` cannot change after creation | `DI-6` |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OQ-5` / `DDM-3`** — category cardinality, curation, representation | No category representation is selected; category persistence **requires `OQ-5`/`DDM-3` first** |
| **`DDM-5`** — location normalisation | Excluded; location attributes are named only as content the structures carry |
| **`OQ-4` / `DDM-4`** — searchable fields, indexing, text search | No index or search structure is selected; the pending-revision uniqueness constraint is integrity, not performance |
| **`OQ-14` / `NOQ-8` / `DDM-7` / `S-8`** — audit logging | No audit structure, history of unpublishing, or linkage rule; the constraint on future references is recorded, not decided |
| **`S-7`** — review data shape | No reviewer, reviewed-at, action or moderation-note representation. The rejection timestamps are retention-only and **not** review data (Q-1 ruling) |
| **`AQ-4`** (`docs/09`) — reversal of a moderation decision | Recorded as apparently stale against `OQ-13`/`FR-ADM-07` but not reconciled; neither answered nor amended here, and no selected anchor depends on it |
| **What counts as a "replacement" value** for designation non-inheritance | Not defined; listed as a prerequisite for the affected write paths |
| **Any route to make a private designation public after submission** | None exists and none is selected |
| **`OQ-9` / `S-9`**, **`OQ-12` / `S-10`** | Untouched |
| **Whether unpublished approved listings acquire retention or purge** | Untouched; they have no deletion path in this design |
| **Whether a rejected record may be resubmitted** | Untouched; nothing links a new submission to a purged or rejected one |
| **`NOQ-7`** — operational-log retention | Untouched |
| **Migration contents, authoring format, execution environment and timing, rollback** | No migration is written or described; `ADR-015`'s outstanding items stay outstanding |
| **PostgreSQL version, provisioning, pool, TLS, secrets, environment** | None assumed; identity generation locus is left open precisely because the version is unselected |
| **Integration-test infrastructure, CI, `DG-4`** | Evidence is listed; no infrastructure, depth or coverage is chosen |

## Product Owner rulings on the questions raised by this ADR

All five questions, and the administrator atomic-path eligibility question raised in review, are
now **ruled as product policy** and recorded in their owning documents as ungated Product Owner
clarifications (`docs/13`). **A ruling is not a physical selection**; the physical selections
are recorded below.

| # | Question | Ruling | Recorded in | Effect on this ADR |
|---|---|---|---|---|
| Q-1 | Is a write-once revision outcome timestamp a `DDM-9` retention anchor, or `S-7` review data? | A **write-once rejection timestamp** on a rejected revision, for **retention eligibility only**; not review-action metadata or audit | Issue #137 — `FR-AUD-06`; `docs/08` *Field classification*, `S-7` | Revision row carries the timestamp; A-3 retired |
| Q-2 | For rejected listings, reuse last-updated or add an explicit datum? | A **write-once rejection timestamp** on a rejected listing, **separate from last-updated**, for retention eligibility only | Issue #137 — `FR-AUD-06`; `docs/08` *Data retention considerations* | Listing row carries the timestamp; A-2 retired |
| Q-3 | Purpose and period for retaining an approved revision row? | **None.** Application and removal of the approved proposal are **one atomic unit**; rejected revisions keep `OQ-13`'s 90 days | Issue #133 — `docs/08` *Approved-revision removal* | Removal mechanics and persisted states selected (PS-4, PS-5) |
| Q-4 | Who captures and changes designations? | The business at submission, default private; administrators restrict only; new or replacement values default private without inheriting; changes to approved listings through the revision workflow | Issue #135 — `FR-DATA-11c`; `docs/09` `OP-3`, `OP-6` | Revision row carries designations |
| Q-5 | Is listing-status representation in scope? | **Yes — scope authorization only**; no representation selected by the ruling | Issue #137 — `docs/13` | Representation selected (PS-7) |
| — | May the administrator atomic path run while a revision is pending? | **No.** Refused; refusal preserves the listing and the pending revision; the existing revision must first be approved or rejected; concurrent attempts preserve the rule | Issue #137 — `FR-ADM-10b`; `docs/08` *The revision lifecycle*; `docs/09` `OP-6` | Atomic-path transaction shape selected (PS-6, PS-11) |

## Physical selections approved by the Product Owner

**All eleven were approved by the Product Owner on 2026-09-17 (issue #137), together with the
documented deferrals below.** The alternatives remain recorded as considered alternatives in
*Alternatives considered*.

| # | Selection | Selected design | Main alternative(s) considered |
|---|---|---|---|
| PS-1 | Identity (`DDM-2`) | Opaque random UUID v4 for listing and revision identity, also the public listing identity | Separate storage key and opaque public identifier |
| PS-2 | Designation placement (`DDM-6`) | Non-public attributes and mandatory per-value designations, default *not public*, on the same row; one public read projection | Separate private structure; contact child rows |
| PS-3 | Revision storage (`DDM-8`) | Effective content on the listing row; separate revision rows carrying a complete proposed content set **with designations** | Immutable version rows with a pointer; difference-only rows |
| PS-4 | Approved-proposal removal (`DDM-8`) | Physical removal of the revision row in the applying transaction | Not storing the proposal on the atomic path |
| PS-5 | Persisted revision states (`DDM-8`) | *Pending* and *rejected* only, as an explicit state datum | Also persisting *approved*; deriving state from the timestamp |
| PS-6 | Atomic-path transaction shape (`DDM-8`) | Under the PS-11 lock: check for a pending revision, then insert a pending row, validate, apply, remove — one transaction; pending uniqueness as backstop | Apply without storing the proposal |
| PS-7 | Listing-status representation (`DDM-9` scope by Q-5) | Mandatory text datum with a store check over the three values | Native enumerated type; reference table |
| PS-8 | Publication-state representation (`DDM-9`) | Nullable text datum over two named values, present if and only if *approved*; unpublish reason present if and only if *unpublished* | Nullable boolean; native enumerated type |
| PS-9 | Rejection timestamps (`DDM-9`) | A timestamp datum on each structure, present if and only if *rejected*; immutability on the write path | Immutability by store trigger |
| PS-10 | Deletion and purge (`DDM-9`) | No deletion path for approved listings; derived purge-eligibility; physical removal of eligible rejected rows, one per transaction | Tombstone |
| PS-11 | Per-listing serialization of revision transactions (`DDM-8`) | Exclusive listing-row lock acquired before the pending check or content read, held to commit or rollback, by every revision-creating, approving, rejecting and atomic transaction; pending uniqueness kept as backstop | Serializable isolation with retry; advisory lock by listing identity |

## Deferred implementation details and dependencies

These are **outside** the physical selections above and were approved as deferrals with them.
Deferring them does not narrow this ADR; each names the implementation it blocks and must be
resolved before that implementation.

| Deferred detail | Blocks | Why it may wait |
|---|---|---|
| **What counts as a "replacement" value** for designation non-inheritance (Q-4) | Implementing `OP-6`/`FR-ADM-04` write paths and revision creation where a value changes | The structure holds a designation beside every value under any definition; the rule is enforced on the write path |
| **Restriction-only designation enforcement** (Q-4) | The same write paths | Compares old and new values; a `C6`/`C9` rule, not a store constraint |
| **Identity generation locus** (application or database default) | First migration authoring | Depends on the unselected PostgreSQL version (`ADR-013`) |
| **Public projection form** (database view or single `C9` query module) | Public read path implementation (`C4`/`C9`) | Either satisfies PS-2 |
| **Purge scheduling, execution and restoration procedure** | Purge implementation (`NFR-BACK-04`) | Eligibility is derived; the schedule changes no stored shape |
| **Stale-edit detection and resolution policy**, and any supporting version token (for example a listing version or last-updated value recorded when an edit is prepared) | Implementing `OP-6` revision creation, `OP-10` approval and the `FR-ADM-10b` atomic path, and pending-record edits under `FR-ADM-04`; their tests | PS-11 serializes transactions but cannot see content read into an editing screen before a transaction begins. Whether stale input is rejected, overwritten, merged or retried is **product policy not yet ruled**; a version token, if any, follows that policy. **None is selected here** |
| **Isolation level for the participating transactions** | Implementing PS-11 | The chosen mechanism must demonstrably make post-lock checks observe the preceding participant's committed state, or abort and restart; conflict detection is not assumed from lock acquisition alone (see *Per-listing serialization of revision work*) |
| **Names, exact data types, migration contents and authoring format** | Every migration | `ADR-015` outstanding items; never part of this ADR |

**No later-publication route is deferred or selected:** under the Q-4 ruling none exists, and adding
one would be a new product decision.

## Traceability

| | |
|---|---|
| **Requirements** | `FR-AUD-01`, `FR-AUD-02`, `FR-AUD-03`, `FR-AUD-06`; `FR-ADM-04`, `FR-ADM-06`, `FR-ADM-07`, `FR-ADM-09`, `FR-ADM-10`, `FR-ADM-10b`, `FR-ADM-12`; `FR-MOD-01`; `FR-VIS-02`, `FR-VIS-08`; `FR-DATA-06b`, `FR-DATA-11`, `FR-DATA-11b`, `FR-DATA-11c`; `FR-VAL-04`; `NFR-DATA-01`–`NFR-DATA-06`; `NFR-PRIV-01`–`NFR-PRIV-05`; `NFR-BACK-04`; `NFR-SEC-02` |
| **Journeys** | `V5`; `A5`, `A6`, `A7` |
| **Components** | `C4` (Directory Query Service — public projection), `C6` (Moderation Service), `C9` (Listing Repository) — shaped by this design. `C8` (Identity and Access) — **context only**: it gates the privileged write path that performs these writes; **no `C8` behaviour is changed** (`docs/07`) |
| **Invariants** | `DI-1`–`DI-11`; `BI-4`, `BI-6`, `BI-7`, `BI-8` |
| **Deferred decisions** | **`DDM-2`, `DDM-6`, `DDM-8`, `DDM-9` — discharged by this `Accepted` ADR (2026-09-17, issue #137).** `DDM-3`, `DDM-4`, `DDM-5`, `DDM-7` — excluded and untouched |
| **Seams** | `S-2`, `S-5`, `S-11` — resolved, preserved. `S-3`, `S-4`, `S-7`, `S-8`, `S-9`, `S-10` — open and untouched |
| **ADRs** | Conforms to `ADR-006`; consistent with `ADR-014`, `ADR-015`, `ADR-016`; context from `ADR-003`, `ADR-010`, `ADR-013` |
| **Documents amended** | Issue #131: `docs/adr/README.md`, `docs/traceability-matrix.md` — `Proposed` status only. Issue #137 (reconciliation and acceptance): the Q-1/Q-2 and atomic-path rulings and the Q-5 scope authorization recorded in `docs/05`, `docs/06`, `docs/08`, `docs/09`, `docs/10` and `docs/13`; `Accepted` status, the register count (twelve), the `DDM-2`/`6`/`8`/`9` discharge in `docs/08`, and directly affected passages in `docs/03`, `docs/05`–`docs/13` and the matrix. `AQ-4` is not reconciled |
| **Issue / pull request** | Issue **#131** (Proposal); issue **#137** (reconciliation and acceptance — `Accepted` 2026-09-17). Pull-request numbers are supplied on merge (`CONTRIBUTING.md`) |
