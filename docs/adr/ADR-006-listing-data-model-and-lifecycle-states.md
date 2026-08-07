# `ADR-006` — Adopt a listing-centric logical model with three orthogonal lifecycle-state dimensions, and defer every physical representation

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Date** | 2026-08-07 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*) |
| **Decision gate** | `DG-1` — **data design**, **Resolved 2026-08-04**. All six hard blockers Decided |
| **Related open questions** | **Depends on** (all Decided): `OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13`. **Must NOT answer:** `OQ-4`, `OQ-5` (`DG-1` shaping inputs, Unresolved) · `OQ-9`, `OQ-14`/`NOQ-8`, `NOQ-9`, `NOQ-5`, `NOQ-6` (`DG-3`) · `NOQ-7` (`DG-4`) · `OQ-12` (Deferred) · the technology stack and `NOQ-1`/`NOQ-4` (`DG-2`) · `DDM-1`–`DDM-10` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **What this ADR does, in one sentence.** It **ratifies the logical listing model and its
> lifecycle states** that `docs/08-data-model.md` derived from the approved requirements and
> that `DG-1` settled the product questions for — so the model is decided **once, in writing,
> with its rejected alternatives argued** (`IR-6`), and is not re-made silently during
> implementation (`IR-1`).

**This ADR decides a logical model, and only a logical model.** It selects no language,
framework, data-store product, hosting platform, runtime model, schema, table, column, key,
type, index, or constraint, and it names no field. Those are `DG-2` (`ADR-002`, `ADR-003`,
`ADR-005`, `ADR-010`) and the deferred data decisions `DDM-1`–`DDM-10`. See *Explicit
deferrals* and *Open questions this decision must NOT answer* — those sections are not
boilerplate here; together they are half the point of writing this ADR at all.

**Accepted, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is
*"Decided and **in force**. Work may rely on it."* The architecture owner accepted this
decision on 2026-08-07. Downstream architecture and technology work may now rely on it —
but **an ADR records a decision; it does not open a gate.** `DG-2` remains Unresolved, and
`P0b` and `P1`–`P5` remain blocked by it.

---

## Context

**The product questions this model rests on are answered; the model itself has never been
recorded as a decision.** That gap is what this ADR closes.

**`DG-1` is Resolved** (2026-08-04). All six hard blockers `docs/07` `DD-1` names as
*"must be answered before data design starts"* are **Decided**: `OQ-6` and `OQ-7`
(2026-07-31), `OQ-10` (2026-08-02), `OQ-8`/`OQ-8b` (2026-08-03), `OQ-11` and `OQ-13`
(2026-08-04). Each settled a **product** question and each deliberately selected **no
representation**. `docs/08-data-model.md` has, in step with those answers, **derived** a
logical model — the single-entity conclusion, the three-value status set, entity `E7`, the
publication-state concept, the retention and purge obligations, and invariants `DI-1`–`DI-11`.

**What was still missing is a decision of record.** A derivation in a chain document is a
conclusion; it is not a decision that has been argued, had its alternatives rejected in
writing, and been ratified. `IR-6` exists because *an argued rejection that is not written
down gets silently re-made*, and `IR-1` names gate-bypass under delivery pressure as *the most
likely failure of this plan, by a wide margin*. `ADR-001` is the precedent: `docs/07`
**recommended** Option A, and `ADR-001` **ratified** it so it could not be drifted away from.
This ADR stands in exactly that relation to `docs/08`.

**The forces that make this decision necessary, and that it must not disturb:**

- **A hard moderation boundary** — *nothing is public until an administrator approves it*
  (`docs/03`, `FR-VIS-02`, `BI-1`), enforced where the client cannot reach it (`ADR-001`).
- **Exactly three listing statuses** — `FR-AUD-01` fixes *pending*, *approved*, *rejected*;
  `NFR-DATA-01`/`DI-1` require exactly one at all times; `NFR-DATA-02`/`DI-2` restrict change
  to defined administrator actions along permitted transitions.
- **Three product decisions that each declined to add a fourth status.** `OQ-10` introduced a
  **separate entity** (`E7`) rather than a listing state; `OQ-11` introduced **publication
  state as a separate product concept** rather than a fourth status or a new transition edge;
  `OQ-13` made purge **an end state reached by the passage of a retention period**, not an
  administrator-invoked status change.
- **Stable identity** — `DI-8` and **P2**: a record's identity survives every content edit and
  status change, because an administrator may correct a listing's name (`FR-ADM-04`) and the
  record must not thereby become a different record.
- **Atomicity** — `NFR-DATA-03`/`DI-3`: every action completes fully or not at all, and in
  particular is **never partially public**.
- **Privacy as a property of the model, not of a filter** — `DI-5` is stated over **paths**,
  not queries, because *"we never write a query that returns pending records" is a coding
  convention, and conventions are broken by the next person in a hurry* (`docs/08`).
- **`DG-2` is Unresolved.** The technology-stack hard blocker is open. `docs/07` `DD-3` is
  explicit that a store **cannot be responsibly chosen against an unknown recovery point
  objective** — and, by the same logic, the store should be chosen against a **known model**.
  This ADR is what gives `ADR-003` a shape to judge store capability against.

**This ADR sits at the requirements → architecture boundary.** The product-policy work is
complete for the data domain; technology selection is downstream and remains behind `DG-2`.

## Decision drivers

Taken from the approved chain; **no new quality requirement is introduced**.

- **Lifecycle correctness** — `DI-1`, `DI-2`, `BI-8`; `FR-AUD-01`, `NFR-DATA-01/02`.
- **Durable listing identity** — `DI-8`, **P2**; `NFR-DATA-06`.
- **Separation of concerns** — the three surfaces are the security model (`docs/09`,
  `docs/11`, `ADR-001`).
- **Preservation of approved-version behaviour** — `OQ-10`, `DI-10`, `FR-ADM-10`.
- **Revision correctness** — `DI-10`, `DI-11`, `FR-ADM-10`, `FR-ADM-10b`.
- **Publication independence** — `OQ-11`, `FR-ADM-12`, `FR-MOD-01`, `FR-VIS-08`.
- **Rejected-record lifecycle** — `OQ-13`, `FR-AUD-06`, `NFR-PRIV-05`, `NFR-BACK-04`.
- **Privacy** — `NFR-PRIV-01`–`NFR-PRIV-05`; `DI-5`, `BI-4`, `BI-6`.
- **Traceability** — `IP-4`, `IP-9`; `docs/traceability-matrix.md`.
- **Testability** — `docs/11`; every invariant proven by an attacking test (`IP-5`, `IP-6`).
- **Evolvability** — `NFR-MAINT-*`; the model has absorbed three product decisions without a
  structural rewrite, and that property is worth keeping.
- **Technology neutrality** — `docs/13` header; `DG-2` is open and this document does not
  touch it.

## Decision

**We adopt a listing-centric logical model in which one durable listing concept carries the
record through its whole life, and in which three orthogonal state dimensions — listing
status, publication state, and revision state — are kept permanently separate; and we defer
every physical representation of that model.**

Concretely, and technology-neutrally:

1. **A listing has one durable identity, and submission, approval, and rejection are states of
   that one concept, not separate concepts.** A submission **is** a listing record whose
   status is *pending*; approval is a **status transition on one record**, never a copy or a
   migration. Identity is stable for the record's entire life and independent of its content
   (`DI-8`, **P2**).

2. **Listing status is exactly the three values `FR-AUD-01` fixes, with `NFR-DATA-02`'s
   permitted transitions, and *rejected* is terminal.** Exactly one status at all times
   (`DI-1`); change only through a defined administrator action along a permitted edge
   (`DI-2`); no transition out of *rejected* exists, and none is added.

3. **The model has three orthogonal state dimensions — listing status, publication state
   (over approved records only), and revision state — and they are never collapsed.** Each
   answers a different question about a listing. Combining either of the other two with
   listing status would force a fourth status value, which `OQ-10`, `OQ-11`, and `OQ-13`
   each declined to introduce; combining publication state with revision state would
   destroy the independence the unpublished-revision cases require.

4. **A listing has exactly one *effective public version* at all times, and it is the only
   thing any public read path returns.** A pending revision is never it; approval makes the
   revision's information become it, atomically; rejection leaves it untouched; and the
   listing's identity is unaffected throughout.

5. **Proposed changes to an approved listing are a distinct logical concept (`E7`), never
   publicly reachable, one-to-many from the listing, with at most one in the pending state.**
   The cardinality expresses history; `DI-11` expresses concurrency. They are different rules,
   and the concurrency rule is **never** enforced by restricting the relationship.

6. **Public visibility is a derived projection, expressed so that no public path can request
   anything else.** Visibility is derived from listing status, publication state, and the
   field classification `OQ-7` settled — a property of the read model (`ADR-001`), not a
   filter someone remembered to apply. The default for any attribute added later is **not
   public** (`S-2`).

7. **Retention, purge-eligibility, and purge are lifecycle obligations stated as rules and
   derived conditions; purge-eligibility is derived, not stored.** A retained rejected record
   is one within its retention period; purge-eligibility is the condition of that period
   having elapsed, and it *permits purging and changes nothing else*; purge is a **system
   obligation with properties** — all-or-nothing, idempotent, never altering an approved
   listing or any current approved version — rather than an operation with a mechanism.

**These seven statements are the decision.** They are numbered for readability within this
document and are **not repository identifiers**; nothing outside this ADR references them by
number, and no new identifier is created by this decision.

**Each is stated as a rule over states, never as a shape in storage.** That is deliberate and
load-bearing: it is what allows `DDM-8` and `DDM-9` to remain genuinely open (see *Explicit
deferrals*).

## Conceptual architecture

Logical concepts and their relationships. **This is not a physical model**: it names no table,
column, key, type, index, constraint, or field, and shows no flag, timestamp, job, or queue.

```
    LISTING  ── classified by ──────>  CATEGORY            (E2; cardinality and curation: S-3, open)
    LISTING  ── has, over its life ─>  REVISION PROPOSAL   (E7; at most one pending at a time)
    LISTING  ── reviewed through ───>  REVIEW DATA         (E4; shape is seam S-7, open)
REVIEW DATA  ── attributable to ───>  ADMINISTRATOR       (E3; identity held outside this model)
    LISTING  ── conditional ────────>  AUDIT ENTRY         (E5; seam S-8 — not built; OQ-14/NOQ-8)
    LISTING  ── conditional ────────>  SAFEGUARD DATA      (E6; seam S-9 — not built; OQ-9)

    Three orthogonal dimensions over a LISTING:
      listing status      : pending | approved | rejected      (exactly one, always)
      publication state   : applies only while approved         (publicly available | unpublished)
      revision state      : carried by REVISION PROPOSAL, not by the listing
```

- **Durable business identity** belongs to the **listing** — one identity per proposed or
  present directory entry, stable for life, content-independent.
- **Submission relationship**: none, by derivation. A submission is the listing at status
  *pending*; there is no separate submission concept.
- **Revision / proposal relationship**: one-to-many from the listing, constrained to at most
  one *pending* proposal at a time. A proposal is never publicly reachable.
- **Current approved version**: owned by the **listing**, as its *effective public version*.
- **Moderation / lifecycle state**: current status belongs to the listing (and a proposal
  carries its own outcome); **historical** moderation state belongs to seams `S-7`/`S-8`,
  which remain open.
- **Publication state**: a second condition over the listing, applicable only while its status
  is *approved*. It does not apply to pending or rejected records.
- **Retention / purge lifecycle**: applies to rejected records — rejected initial submissions
  and rejected revision proposals alike — under one uniform rule, ending in the MVP's one
  approved end state.

## Alternatives considered

Each was evaluated against the MVP's approved requirements, not in the abstract. Two of the
three model families were **already rejected by `docs/08-data-model.md` on the requirements**;
this ADR records those rejections so they are not silently re-made (`IR-6`), and does not
re-run the analysis.

**Submission/version-centric model** — submission and revision proposals as the central
lifecycle concepts, with the public listing as the currently approved outcome.
**Rejected.** `docs/08`, *Listing-submission entity*, inheriting `docs/07`, *Data-storage
responsibilities*. If submission and listing are separate concepts then **approval becomes a
copy**, and a copy introduces three defects the single-concept model does not have:

- **A window of inconsistency** — between writing the listing and removing the submission the
  record exists twice or not at all, which directly threatens `NFR-DATA-03`.
- **A second definition of "public"** — publicity would be encoded both in *which concept you
  are* and in *what status you hold*, two sources of truth, violating **P1**.
- **Broken identity across the lifecycle** — an approved listing would have a different
  identity from the submission it came from, making audit, retention, and moderation history
  harder than necessary, violating **P2** and `DI-8`.

**Full reification** — listing, submission, revision, publication state, and moderation
outcome each modelled as separately named concepts with explicit relationships.
**Rejected as a whole; its viable parts are already adopted.** The parts that earn their keep
are in the selected model already: `E7` exists as a distinct concept precisely because the
public must keep seeing the approved version while a proposal is reviewed, and `E4` is a live
candidate at seam `S-7`. The remainder is **over-modelling** (`docs/08` `R-4`) — reified
publication-state and moderation-outcome concepts answer to **no approved requirement**, and
reifying publication state comes within one step of choosing its representation, which would
pre-empt **`DDM-9`**.

**A fourth listing status** — for example an *unpublished* or a *retained* state.
**Rejected.** It was considered and refused three separate times by the product owner.
`OQ-10` modelled a pending revision as a distinct concept rather than a listing state.
`OQ-11` settled unpublishing as **publication state**, leaving `FR-AUD-01` unchanged and
adding no transition edge, so `NFR-DATA-02` is preserved rather than extended. `OQ-13` made
purge an end state reached by **the passage of time** — which as a status value would change a
record's status with **no administrator action**, violating `DI-2`.

**Do nothing — leave the model as a derivation in `docs/08` and proceed.**
**Rejected.** `IR-6`: a conclusion that was never ratified gets re-made by the next person who
has not read it. `IR-1` names gate-bypass under delivery pressure as the plan's most likely
failure. `docs/08` `R-1` is concrete about the form it would take here — with `OQ-11` and
`OQ-13` now Decided, the next unwritten representation choice **decides `DDM-9` and pre-empts
this ADR** without anyone noticing they decided anything.

## Lifecycle consequences

How the model accommodates each settled scenario. **No implementation mechanism is selected in
any of them.**

- **New pending submission.** A listing comes into existence at status *pending*. Publication
  state does not apply; no proposal exists. It is not public, and its existence is not
  disclosed (`DI-5`, `BI-4`).
- **Initial approval.** Status transitions *pending → approved* and the record becomes publicly
  visible **in the same committed write** (`DI-3` — never partially public). Publication state
  becomes applicable and is *publicly available*. Approval is permitted only where every
  before-approval obligation holds, including at least one usable contact method (`VR-S2`,
  `FR-DATA-08`, `FR-ADM-06`).
- **Initial rejection.** Status transitions *pending → rejected*, which is **terminal**. The
  retention lifecycle begins at the rejection. Nothing becomes public.
- **Unpublishing an approved listing.** Publication state changes to *unpublished*; **listing
  status is unchanged** — the listing is still *approved*, and `DI-1` holds. A current reason
  and an explicit confirmation are required. The listing leaves **every** public read path, and
  a previously shared link yields the same generic unavailable result as a listing that never
  existed (`FR-VIS-08`, `BI-4`).
- **Republication.** Publication state returns to *publicly available* by an **explicit**
  administrator action, exposing the listing's **current approved version at the time of
  republication** — not necessarily the version that was public when it was unpublished.
  Publication is never implicit (`FR-MOD-01`).
- **Proposing a revision.** A revision proposal enters the pending state. **Listing status and
  publication state are both unchanged.** The public continues to see the unchanged effective
  public version; the proposal is reachable through no public path (`DI-10`); and no second
  proposal may enter the pending state (`DI-11`).
- **Approving a revision.** The proposal's information becomes the **effective public
  version**, atomically. Listing status is unchanged — *approved → approved*, content only —
  and listing identity is unchanged (`DI-8`). `DI-11` is released.
- **Rejecting a revision.** The proposal becomes terminal and its retention lifecycle begins.
  The **approved listing is entirely unchanged and remains public exactly as it was**
  (`FR-ADM-10`). `DI-11` is released.
- **Revising a listing that is unpublished.** A proposal enters the pending state while
  publication state stays *unpublished* and listing status stays *approved*. The public sees
  nothing, because the listing was already excluded. **This case is coherent only because the
  three dimensions are independent.**
- **Approving a revision while the listing remains unpublished.** The current approved version
  is updated; the listing **stays unpublished** and is **not** republished. A later explicit
  republish exposes the then-current approved version. Rejecting a proposal in this state
  likewise leaves the listing unpublished — a rejection is not a publication act either.
- **A rejected record reaching the end of its retention period.** It becomes **purge-eligible**.
  Eligibility **permits purging and changes nothing else**: no status changes, administrative
  visibility is unchanged, and no dimension moves. This holds identically for a rejected initial
  submission and a rejected revision proposal.
- **The purge obligation becoming applicable.** The retained rejected record ends. Purge is a
  **system obligation**, not an administrator action; **all-or-nothing** (`DI-3`);
  **idempotent**; and it **never alters an approved listing or any current approved version**.
  Audit events are not necessarily purged with it — **no linkage rule is imposed**
  (`OQ-14`/`NOQ-8`, retention `NOQ-7`). The obligation applies to the live product, and a
  restoration must not silently return a purged record to live use (`NFR-BACK-04`).

## Findings

Recorded because they are true and consequential — **not decided here**.

**The rejection-event finding (seam `S-7`).** The approved rejected-record lifecycle is
measured **from the rejection** (`OQ-13`, `FR-AUD-06`). The architecture must therefore be
**able to preserve or determine the rejection event** well enough to apply that rule; a model
in which that event is not knowable cannot enforce the approved policy. `docs/08` records the
tension directly: of the two viable shapes at seam `S-7`, shape (a) — review data held as
attributes on the listing — is **lossy**, since *"the moment a second action occurs, the first
is gone"*, and therefore *"cannot answer retrospectively"* when a record was rejected.
`docs/08` already instructs that **`S-7` be resolved together with `S-8`**.

**What this finding does not do.** It **does not resolve `S-7`**, which remains open. It
**does not decide, begin, or reprioritise `OQ-14`, `NOQ-8`, or `NOQ-7`**, and it opens no
`DG-3` work — those remain the product owner's, behind a gate that is not open. It selects
**no timestamp, no field, no audit-event representation, no storage structure, and no
mechanism** for making the rejection event knowable. Naming a dependency is not answering it.

**A remaining product-policy gap outside this ADR.** `OQ-13` **explicitly excluded**
unpublished approved listings from its retention and purge policy, and `docs/08` records that
whether such a listing is ever subject to one *"remains an open product question, assigned to
no existing open question."* This ADR **neither resolves nor narrows it**, creates no
identifier for it, and invents no retention rule. It records only that the gap exists and lies
outside this decision. Its absence from the model is accurate, not an omission.

## Explicit deferrals

**Everything about *how* this model is expressed is deferred.** Stated at length because the
chief risk of this ADR is deciding one of these in a sentence that felt like explanation
(`docs/08` `R-1`, `R-3`).

**`DDM-8` — physical revision-storage representation, and how the effective public version is
carried.** **Not decided here, and not this ADR's to decide.** This ADR fixes the *logical*
requirements any later `DDM-8` representation must satisfy: exactly one effective public
version at all times; a proposal that is never that version; approval making it so atomically;
rejection leaving it untouched; identity surviving the cycle. Whether that is carried by a row
update, a version record, a pointer, a copy, immutable history, or otherwise is **`DDM-8`, and
it remains open**. The distinction is the point: *logical revision identity* is this ADR's and
was committed by `OQ-10`; *physical revision storage* is `DDM-8`'s.

**`DDM-9` — physical lifecycle and removal representation.** **Not decided here, and not this
ADR's to decide.** This ADR defines what *unpublished*, *retained rejected*, *purge-eligible*,
and *purged* **mean** as conditions over settled rules. It selects **no** representation for
any of them, and in particular selects **no** deletion semantics. Whether a purge is physical
destruction or logical marking is **precisely what `DDM-9` still owns**, and both `OQ-11` and
`OQ-13` deliberately left it there.

**Also not decided here:** `DDM-1` the store product · `DDM-2` identity strategy — this ADR
requires only that identity be stable and content-independent · `DDM-3` category
representation · `DDM-4` indexing and text-search strategy · `DDM-5` location normalisation ·
`DDM-6` physical separation of non-public attributes and the representation of per-contact
display designations · `DDM-7` audit-entry storage · `DDM-10` migration and schema-evolution
tooling.

**No technology of any kind is selected:** no programming language, application framework,
data store or database product, hosting platform, runtime, deployment platform, continuous
integration system, test tooling, or backup technology. Those are `DG-2` and `DG-3`
(`ADR-002`–`ADR-005`, `ADR-010`, `ADR-012`), and **`DG-2` is Unresolved**.

**No physical model of any kind is selected:** no schema, table, column, key, data type,
index, or constraint; **no field name**; no publication flag; no deletion marker; no retention
timestamp; no fourth listing status value; no choice between hard and soft deletion; and no
purge mechanism, scheduler, job, or queue. **None of these is implied by example either** —
where this ADR names a space of candidates, it names it to show what remains open.

**No transport or interface decision is made:** no API route, method, status code, or payload
structure (`docs/09`), and no user-interface widget or implementation (`docs/10`).

**Open product questions this ADR carries rather than answers:** `OQ-4` (searchable attribute
set and matching mode) and `OQ-5` (category model — cardinality and curation) are `DG-1`
**shaping inputs** and remain **Unresolved**. They are carried as stated assumptions; a model
built without considering them would be retrofitted rather than configured, and this ADR
records that cost rather than resolving it. `OQ-9`, `OQ-14`/`NOQ-8`, `NOQ-9`, `NOQ-5`,
`NOQ-6`, and `NOQ-7` sit behind `DG-3` and `DG-4` and are untouched.

**Seams left open:** `S-3`, `S-4`, `S-7`, `S-8`, `S-9`, `S-10`.

## Consequences

**Positive:**

- **One definition of "public"** (**P1**). Publicity is a consequence of status, publication
  state, and field classification — never of which concept a record happens to be.
- **No approval window.** Approval is a status transition inside one all-or-nothing write,
  so there is no moment in which a record exists twice or not at all (`NFR-DATA-03`, `DI-3`).
- **Identity survives everything** (`DI-8`) — edits, approval, revision approval, unpublishing,
  republication. Moderation history and retention rules have a stable thing to refer to.
- **`DI-5` is defensible as a property of the read model**, not a filter, which is what makes
  `BI-1`, `BI-4`, and `BI-6` provable rather than merely intended.
- **The dimension pattern is now a stated principle**, not three coincidences. The next
  product question has a precedent for being answered without a fourth status value.
- **The hard cases are coherent without special-casing** — in particular, revising and
  approving a revision on a listing that is unpublished.
- **`DG-2` gains a shape to select against.** `ADR-003` can judge store capability against a
  written model rather than an assumed one, which is what `docs/07` `DD-3` asks for.
- **Full traceability.** Every concept in the model answers to an approved requirement; none
  was added because it seemed likely to be needed.

**Negative:**

- **The model's safety depends on discipline about the three dimensions.** Collapsing any two
  would be individually defensible and collectively fatal — this is the failure mode to review
  for, and it will not announce itself.
- **Approved-content history is not modelled** beyond revision proposals and the unresolved
  seam `S-7`. *"What did this listing say last March"* is not answerable by design. No approved
  requirement asks for it; the limitation is recorded rather than hidden.
- **Several concerns are concentrated on one concept.** That is the price of a single
  definition of "public", and it means the listing is the thing most reviewers must understand.
- **The rejection-event finding is a real constraint on a decision not yet taken.** `S-7`
  cannot be chosen freely; one of its two shapes cannot support the approved retention rule.
- **Stating rules without representations is harder to read** than drawing a model. It is also
  the only way to keep `DDM-8` and `DDM-9` genuinely open.

**Deferred:** every representation question named in *Explicit deferrals* — most consequentially
`DDM-8` and `DDM-9`, both of which remain unresolved and neither of which this decision
narrows beyond the logical requirements stated above.

**Downstream implications for `DG-2`:** now that this ADR is **Accepted**, the technology
decision knows the aggregate boundary and the atomicity unit a store must support; the concept
count and relationship shape the MVP requires; that the read model must be arranged so the
public path cannot express a non-approved request; that three orthogonal dimensions must be
representable without collapsing; that retention and an idempotent, all-or-nothing purge
obligation must be expressible; and that **no permanent-deletion capability exists in the
MVP**. Hosting, runtime, continuous integration, and test tooling remain independent of it.
**`DG-2` may now rely on this decision — but acceptance decides nothing that `DG-2` owns.**
`DG-2` remains **Unresolved**, held by its technology-stack hard blocker, and **`P0b` and
`P1`–`P5` remain blocked by it.**

**Reversibility:** **expensive, and deliberately so.** Reversing the single-concept conclusion
after `P1` would mean re-deriving identity across the lifecycle and re-proving `DI-1`–`DI-11`;
reversing the dimension separation would require a fourth status value and so would reopen
`FR-AUD-01` and `NFR-DATA-02`, which are approved requirements. Both are decisions to change
by **superseding ADR**, never by editing this one (`docs/adr/README.md`). Reversal is cheapest
now, at zero data volume, which is precisely why the chain insisted on deciding before `P1`.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`PA-1` — the directory is small at first release.** Carried, not resolved; `NOQ-1` and `NOQ-4` are Unresolved. | The model itself does not change — it asserts no threshold. But `DDM-4` (indexing and search strategy) and the `DG-2` store choice would be revisited first (`DD-12`). |
| **The `DG-1` answers are stable.** Six product decisions, all Decided, none marked provisional. | Any reopened answer reopens this ADR. A change would arrive as a superseding ADR, not an edit — and, before `P1`, at zero data volume. |
| **`OQ-4` and `OQ-5` land within the seams already named for them** (`S-4`/`DDM-4`, `S-3`/`DDM-3`). | If either lands outside its seam — for example if categories become curated structures rather than a set — the model is **retrofitted, not merely configured**. `docs/08` states this cost explicitly, and it is carried consciously. |
| **The rejection event will be knowable** once `S-7` is resolved, whichever shape is chosen. | If `S-7` resolves to the lossy shape without provision for it, the approved 90-day rule becomes unenforceable and the policy — not the model — would have to be revisited. See *Findings*. |
| **No approved requirement will need approved-content history.** | Adding it later means introducing history into a live model. Nothing in `docs/03`–`docs/06` asks for it today. |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **Two dimensions get collapsed during implementation** — most likely publication state folded into listing status. | A fourth status value appears, breaking `FR-AUD-01`, `NFR-DATA-02`, and `DI-1` at once, and reopening a decision the product owner took deliberately. | The decision states the separation as a principle rather than three cases; `DI-1` and `DI-2` are proven by attacking tests in `P1` (`IP-5`, `IP-6`). |
| **A representation gets chosen while explaining the model** — a deletion marker, a publication flag, a retention timestamp, or a fourth status value. | **`DDM-9` is decided by accident** and this ADR is pre-empted, exactly as `docs/08` `R-1` predicts. | *Explicit deferrals* names each one; the ADR states rules and derived conditions only, never shapes. Reviewers should treat any such noun in a pull request as a decision until proven otherwise. |
| **`DI-11` is enforced by restricting the relationship to one proposal.** | Revision history is destroyed while enforcing a concurrency rule — a silent, permanent data-shape loss. | The decision states that the cardinality expresses history and `DI-11` expresses concurrency, and that they are different rules. `docs/08` carries the same warning. |
| **A proposal becomes reachable through a public path.** | `DI-10` breached and, with it, `BI-1`/`BI-4` — a trust failure rather than a correctness failure. | `DI-10` is stated over **paths**, not queries, and the public read model is required to be unable to express the request at all (`ADR-001`). |
| **Purge is implemented as an ordinary deletion, or as an administrator action.** | The system obligation becomes a manual step that will not be run, or acquires deletion semantics `DDM-9` never chose. | The decision states purge as an obligation with properties — system-driven, all-or-nothing, idempotent, non-altering — and `docs/09` records that it is deliberately not an operation. |
| **The `S-7` shape is chosen without the retention rule in mind.** | The approved 90-day lifecycle becomes unenforceable, and the history needed was never recorded — irrecoverably. | Recorded as a finding here; `docs/08` already instructs that `S-7` be resolved with `S-8`. The response is to carry the constraint into that decision, **not** to pre-empt it. |
| **Acceptance is mistaken for a gate opening.** | Work behind `DG-2` or `DG-3` starts because "the architecture is decided" — the gate-bypass `IR-1` names. | `docs/adr/README.md`: *"An ADR records a decision. It does not open a gate."* Stated again in the header and in *Consequences*: `DG-2` remains Unresolved, and `P0b` and `P1`–`P5` remain blocked. |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OQ-4`** — searchable attribute set and matching mode | The model names no searchable attribute set and asserts no matching behaviour. It commits only that search scope never exceeds publication scope (`BI-3`), which holds whatever `OQ-4` decides. Seam `S-4` and `DDM-4` stay open. |
| **`OQ-5`** — category model, cardinality and curation | The model requires only that a category value always references a member of the predefined set (`DI-9`). It fixes no cardinality and no curation model. Seam `S-3` and `DDM-3` stay open. |
| **`OQ-9`** — anti-spam behaviour | `E6` remains conditional and unbuilt; seam `S-9` is untouched. The model neither requires nor forbids safeguard data. |
| **`OQ-14` + `NOQ-8`** — audit logging, and what it must retain | `E5` remains conditional and unbuilt; seams `S-7` and `S-8` stay open. The rejection-event finding names a dependency and answers nothing; no linkage is imposed between purging a rejected record and purging audit events. |
| **`NOQ-7`** — operational-log retention | Untouched; a `DG-4` question about logs, not about listing data. |
| **`OQ-12`** — duplicate resolution | Deferred; seam `S-10` stays open. The model adds no duplicate structure. |
| **Whether unpublished approved listings ever acquire retention or purge** | `OQ-13` excluded them and assigned the question to nothing. This ADR records the gap in *Findings* and neither resolves it nor invents a rule. |
| **`DDM-8`** — physical revision-storage representation | The decision states logical requirements over the effective public version and names candidate shapes only to show what remains open. It selects none. |
| **`DDM-9`** — physical lifecycle and removal representation | The decision states what the lifecycle conditions **mean**; purge-eligibility is stated as **derived**, and purge as an obligation with properties. No representation and no deletion semantics are chosen. |
| **`DDM-1`–`DDM-7`, `DDM-10`** | None is named as a requirement of the model; each is listed in *Explicit deferrals* with its identifier. |
| **`DG-2` — the technology stack** | No language, framework, store, hosting platform, runtime, pipeline, tooling, or backup technology appears anywhere in this document. `NOQ-1` and `NOQ-4` remain carried as `PA-1`. |
| **`NOQ-9`, `NOQ-5`, `NOQ-6`** — `DG-3` | Untouched. Authentication mechanism, accessibility conformance, and the support matrix are outside a data-model decision. |

**The pattern that makes this possible: state the rule; defer the shape.** Every commitment
above is decidable and testable today; every representation it might have implied belongs to
someone else and waits.

## Traceability

| | |
|---|---|
| **Requirements** | `FR-AUD-01`, `FR-AUD-02`, `FR-AUD-03`, `FR-AUD-06`; `FR-ADM-04`, `FR-ADM-06`, `FR-ADM-07`, `FR-ADM-10`, `FR-ADM-10b`, `FR-ADM-12`; `FR-MOD-01`, `FR-MOD-06`; `FR-VIS-02`, `FR-VIS-08`; `FR-DATA-01`–`FR-DATA-11c`; `FR-SUB-02`, `FR-SUB-05`; `FR-VAL-01`, `FR-VAL-03`–`FR-VAL-05`; `NFR-DATA-01`–`NFR-DATA-06`; `NFR-PRIV-01`–`NFR-PRIV-05`; `NFR-BACK-04`; `NFR-SEC-01` |
| **Journeys** | `V7`; `L*` submission and revision paths; `A5`, `A6`, `A7` |
| **Components** | `C4` (public projection), `C6` (moderation lifecycle), `C8` (administrative boundary), `C9` (data access) — `docs/07` |
| **Invariants** | `DI-1`–`DI-11`; `BI-1`, `BI-3`, `BI-4`, `BI-6`, `BI-7`, `BI-8` |
| **Deferred decisions** | `DD-1` — discharged **logically** by this ADR; its physical half remains `DDM-1`–`DDM-10`, and in particular `DDM-8` and `DDM-9` |
| **Seams** | `S-1`, `S-2`, `S-5`, `S-6`, `S-11` — resolved, and preserved unchanged by this decision. `S-3`, `S-4`, `S-7`, `S-8`, `S-9`, `S-10` — **open**, and untouched |
| **Product decisions consumed** | `OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13` — all Decided; recorded in `docs/13-decision-log.md` |
| **Documents amended** | `docs/adr/README.md`, `docs/07-system-architecture.md`, `docs/08-data-model.md`, `docs/13-decision-log.md`, `docs/traceability-matrix.md` — amended in the same pull request (`IP-9`) |
| **Issue / pull request** | Issue **#61**. The pull-request number is supplied on merge (`CONTRIBUTING.md`) |
