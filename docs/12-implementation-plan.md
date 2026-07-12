# Community Directory Platform — MVP Implementation Plan

## Purpose and scope

This document defines **how the MVP will be built** — the order in which the approved
documentation chain becomes working software, what must be true before coding begins, how
work is broken into reviewable pieces, and **which work cannot honestly start yet** because
the decision it depends on has not been made.

**What this document is.** A *plan*: phases, workstreams, sequencing, decision gates, and
the working agreements (issue → branch → PR → merge) that carry the work. It is written so
that a backlog, an issue sequence, a sprint plan, and a release checklist can each be
derived from it without reopening `docs/01`–`docs/11`.

**What this document is not.** It is **not implementation**, and it is not a technology
decision. It selects no language, framework, database product, hosting platform, testing
tool, CI system, component library, CSS framework, or authentication provider. It contains
no code, schema, migration, test, fixture, script, pipeline configuration, or deployment
resource. It estimates nothing in days, and it commits to no dates.

**The distinction that governs the document.** *Planning* says "the public read path is
built before the write path, and here is why." *Execution* writes the read path. Every
section below stays on the planning side of that line — and the single most common way a
plan like this fails is by drifting across it, usually by "just noting" a field name, a
table, or a framework. **A plan that names a field has made a data decision.** This one does
not.

**The second discipline, and the more important one.** `docs/07` through `docs/11` each did
the same hard thing: they left unresolved product questions **open**, supplied the *seam*
where the answer will land, and refused to guess. A plan is where that discipline usually
dies — because a plan wants an order, and an order wants certainty, and the cheapest way to
get certainty is to quietly decide something nobody asked you to decide. **Sequencing an
open question is not the same as answering it.** This document sequences around the open
questions and makes their cost visible as *blocked work*, not as an assumption.

---

## Source documents

This plan is derived from, and must remain consistent with, the approved chain. It adds no
requirement, and removes none.

| Document | What this plan takes from it |
|---|---|
| `docs/01-vision.md` | The purpose the work serves; the low-friction principle that constrains any anti-spam mechanism. |
| `docs/02-stakeholders.md` | Who reviews and approves; the administrator's need for audit trails. |
| `docs/03-mvp-scope.md` | **The scope fence.** In-scope capabilities, out-of-scope capabilities, and the boundary any issue is tested against. |
| `docs/04-user-journeys.md` | `V1`–`V7`, `L1`–`L4`, `A1`–`A7` — the journeys each phase must make real. |
| `docs/05-functional-requirements.md` | `FR-*` — every issue traces to at least one. |
| `docs/06-non-functional-requirements.md` | `NFR-*` — and the `NOQ-*` questions that block several of them. |
| `docs/07-system-architecture.md` | Components `C1`–`C12`; the recommended shape (Option A); deferred decisions `DD-1`–`DD-16`; the ADRs to write. |
| `docs/08-data-model.md` | Entities `E1`–`E7`; integrity invariants `DI-1`–`DI-9`; **the named seams `S-1`–`S-11`**; deferred decisions `DDM-1`–`DDM-10`. |
| `docs/09-api-design.md` | Operations `OP-1`–`OP-11`; the three surfaces; `AQ-*`. |
| `docs/10-ui-design.md` | Screens `S1`–`S7`; empty, error, validation, loading, and confirmation states. |
| `docs/11-test-strategy.md` | **Boundary invariants `BI-1`–`BI-9`**; test levels; the three release-readiness categories; the cannot-test-yet register. |

> **The source of truth is the chain, not this document.** Where this plan appears to
> conflict with `docs/01`–`docs/11`, the chain wins and this plan is wrong. It is a
> *derivation*, and a derivation has no independent authority.

---

## Implementation planning principles

| ID | Principle | Why |
|---|---|---|
| `IP-1` | **Build the boundary before the feature.** The enforcement point comes first; the capability is added behind it. | `BI-1`–`BI-9` are what the product exists to guarantee. A boundary retrofitted onto working features is a boundary nobody trusts. |
| `IP-2` | **Slice vertically, not horizontally.** An issue delivers one operation or one screen end to end — with its tests — never "all the repositories" or "all the validation." | A horizontal slice is unreviewable and unverifiable; nothing works until the last one lands. |
| `IP-3` | **An open question is a *gate*, never an assumption.** Work that depends on an unanswered question does not start; it waits, visibly. | This is the entire discipline of `docs/07`–`docs/11`. A plan that "assumes for now" is the plan that answers the question by accident. |
| `IP-4` | **Every issue cites a requirement.** No `FR-*`, journey, or `NFR-*` behind it means it is not in the MVP. | The scope fence (`docs/03`) is only real if something enforces it. This is the enforcement. |
| `IP-5` | **Prove the invariant where it is enforced, not where it is displayed.** | `BI-9` — *the UI is not the boundary*. A suite that drives only the interface proves only that the interface does not *offer* the forbidden action. |
| `IP-6` | **Tests land with the code that they test, in the same pull request.** | A test that arrives "next sprint" arrives never, and a boundary proven later was unprotected in between. |
| `IP-7` | **Prefer the smallest thing that satisfies the requirement.** Seams are preserved (`docs/07`); they are not built out in advance. | `docs/07` and `docs/08` both weighed the over-design risk explicitly. A seam is an option, not an obligation. |
| `IP-8` | **The mini lab is a reference, never a template.** | `docs/07` **rejected** the mini lab's browser-direct shape *on the requirements* (`R-10`). Copying it back in during implementation would undo an argued decision without arguing it. |
| `IP-9` | **Documentation moves with the code.** A decision made during implementation lands in an ADR or an amended document — in the same pull request that relies on it. | Otherwise the chain rots, and this plan's only authority — derivation from the chain — quietly expires. |

---

## Planning assumptions

Carried forward, not invented here. Each is load-bearing; if one is false, the phase order
below is the first thing to revisit.

| ID | Assumption | Source | If it is wrong |
|---|---|---|---|
| `PA-1` | The directory is **small at first release** — a modest number of listings, low traffic. | `docs/07` `A-5`, `A-6` | Store, indexing, and search sequencing (`DD-14`) change. `NOQ-4` is how we would find out. |
| `PA-2` | **Moderation is manual**, performed by a handful of trusted administrators. | `docs/03`, `docs/07` `A-1` | The anti-spam question (`OQ-9`) escalates from *important* to *blocking*. |
| `PA-3` | The team is **small, with no dedicated operations staff**. | `docs/07` `D-6` | Phase 0 and Phase 5 both grow. |
| `PA-4` | The recommended architecture (Option A — a single, internally modular deployable with a server-enforced administrative boundary) will be **ratified as `ADR-001`**, not re-litigated during implementation. | `docs/07` | The phase structure survives — it is deliberately organised around *surfaces*, not around a deployment topology — but Phase 0 grows a second deployable. |
| `PA-5` | Work proceeds through **GitHub issues, branches, and pull requests**, one reviewer, merging to `main`. | The repository's existing practice (`docs/01`–`docs/11` were each delivered this way). | The working agreements below change; the phases do not. |

**One assumption is deliberately *not* made:** that the technology stack will be chosen in
time. It might not be. What that costs is stated plainly under *Decision gates* — because
the honest answer to "when does coding start" is **"when `DG-1` and `DG-2` clear,"** and no
amount of phase structure changes that.

---

## MVP delivery phases

Six phases, ordered by **what each one makes safe** rather than by what it makes visible.

| Phase | Name | Delivers | Gated by |
|---|---|---|---|
| **P0** | Repository and project foundation | The working agreements, the ADRs, the scaffold. | `DG-0` partially; **`DG-2` for the scaffold itself** |
| **P1** | Data foundation | Entities, the status machine, integrity invariants. | **`DG-1` and `DG-2` — hard** |
| **P2** | Public browsing foundation | `OP-1`, `OP-2`, `OP-11`; `S1`, `S2`. The **public projection**. | `P1`; `DG-1` — blocking: `OQ-7`, `OQ-6`; shaping: `OQ-4`, `OQ-5` |
| **P3** | Listing submission workflow | `OP-3`; `S3`, `S4`. The **public write path**. | `P1`; `DG-1` — blocking: `OQ-8`/`OQ-8b`; `DG-3` — blocking: `OQ-9` |
| **P4** | Administrative review workflow | `OP-4`–`OP-8`; `S5`–`S7`. The **moderation lifecycle**. | `P1`; `DG-3` — blocking: `NOQ-9`, `OQ-14` + `NOQ-8` |
| **P5** | Testing, hardening, release preparation | Regression, exploratory, accessibility, the release decision. | `P2`–`P4`; `DG-4` |

**Why this order, and not a more satisfying one.** The instinct is to build the submission
form first — it is the visible thing, and it is where a listing comes from. The instinct is
wrong, for three reasons.

1. **The public read path is where the hardest invariants live.** `BI-1` (approved-only
   visibility), `BI-3` (search scope never exceeds publication scope), `BI-4` (no
   disclosure of a non-approved record's existence), and `BI-6` (administrative data never
   appears publicly) are all properties of the **public projection** — the single control
   that `docs/07` `C4` exists to enforce and that `NFR-PRIV-01/02` depend on. Building it
   first means every later phase is added *behind* an enforcement point that already exists
   and is already proven. Building it last means every later phase spends time unprotected.
2. **The read path does not need the write path.** A record can be placed in the store
   directly for verification (`docs/11`, *test data strategy*) — so `P2` can be built and
   proven with no submission form and no moderation workflow in existence. The reverse is
   not true: a submission you cannot see approved is a submission you cannot verify.
3. **`P3` and `P4` are then genuinely independent** and can proceed in parallel by
   different people, because they touch different surfaces and share only the data
   foundation laid in `P1`.

**Phases are not sprints, and they are not strictly serial.** `P3` and `P4` overlap.
Phase 5 activities — accessibility review in particular — start *during* `P2`, because
`docs/07` and `docs/10` both make the point that accessibility is cheap early and expensive
to retrofit. What the ordering fixes is **dependency**, not calendar.

### Decision gates

**These are the plan's teeth.** A gate is a set of questions that must be answered *by the
product owner*, not by an engineer choosing a default at 4pm on a Friday. Each gate names
the work it blocks. Work behind an unopened gate **does not start**.

**Two kinds of question sit behind a gate, and conflating them overstates the block.**

- A **hard blocker** makes the work *impossible to do honestly*. Proceeding means guessing,
  and the guess silently becomes the answer.
- A **shaping input** makes the work *possible but under-informed*. It must be **considered
  and consciously carried** before the decision is made — recorded as a stated assumption,
  not resolved by default — and it is revisited the moment it is answered.

**A shaping input is not permission to proceed casually.** It is permission to proceed *with
the cost written down*. The distinction is marked in every row below.

| Gate | Questions | Blocks | Why it cannot be worked around |
|---|---|---|---|
| **`DG-0`** — process | None (no product decision required) | Nothing | The stack-neutral half of `P0` can start **today**. |
| **`DG-1`** — **data design** | **Hard blockers:** **`OQ-6`** location granularity · **`OQ-7`** public vs. private fields · **`OQ-8` / `OQ-8b`** required fields and contact minimum · **`OQ-10`** edit-after-approval · **`OQ-11`** removal/unpublish · **`OQ-13`** rejected retention.<br>**Shaping inputs:** **`OQ-4`** searchable fields and matching mode (`S-4`, `DDM-4`) · **`OQ-5`** category model — cardinality and curation (`S-3`, `DDM-3`) | **All of `P1`.** Transitively `P2`, `P3`, `P4`. | `docs/07` `DD-1` states the six hard blockers outright: they **must be answered before data design starts**. `OQ-6` retrofitted onto a populated directory means backfilling every record; `OQ-10` may add a lifecycle state and a revision entity (`S-5`); `OQ-7` is the control that `BI-6` and `NFR-PRIV-01` rest on — **until it is answered, the privacy commitment is an empty promise** (`docs/07` `R-2`).<br>**`OQ-4` and `OQ-5` shape rather than block:** each lands on a named data-model seam (`S-4`, `S-3`), so the *rule* can be built and the *representation* deferred — but a model built without considering them will be retrofitted, not merely configured. |
| **`DG-2`** — **technology** | **Hard blockers (store selection, `ADR-003`):** **`NOQ-2`** availability · **`NOQ-3`** backup / RPO / RTO.<br>**Shaping inputs (technology selection, `ADR-002`, `ADR-005`):** **`NOQ-1`** performance thresholds · **`NOQ-4`** expected first-release load | **The `P0` scaffold** and all of `P1`. | **The store cannot be chosen against `NOQ-2` / `NOQ-3`** — `docs/07` `DD-3` is explicit that a store **cannot be responsibly chosen against an unknown recovery point objective**, because the objective determines the store's required *capability*, not merely a schedule. **`NOQ-1` and `NOQ-4` do not block the choice; they inform it** (`docs/07` files both under *before technology selection*). They must be **considered and carried as a stated assumption** — `PA-1` is exactly that assumption — because everything here assumes "small," and if that is wrong, this is the first decision to revisit (`DD-12`). |
| **`DG-3`** — **build-time** | **Hard blockers:** **`OQ-9`** anti-spam · **`OQ-14` + `NOQ-8`** audit logging — *one decision, taken together* · **`NOQ-9`** administrator credential and session strength.<br>**Shaping inputs:** **`NOQ-5`** accessibility standard *(early — cheap now, expensive later)* · **`NOQ-6`** browser/device matrix | `P3` (`OQ-9`), `P4` (`NOQ-9`, `OQ-14`/`NOQ-8`), and the *verifiability* — not the building — of `P2` (`NOQ-5`, `NOQ-6`) | **`OQ-14` / `NOQ-8` is the asymmetric one.** Audit history not captured cannot be reconstructed later — every administrative action taken before a "yes" is permanently unlogged (`docs/11`). **`NOQ-5` and `NOQ-6` shape rather than block:** the accessibility *behaviors* and responsive behavior are built and tested regardless; only the **conformance claim** and the **support matrix** wait. |
| **`DG-4`** — **release** | **`NOQ-7`** log retention · **testing depth** · written acceptance of every Category 3 blocked item | The release decision, not the build. | `docs/11` Category 3: these are **unmeasurable, not optional**. Each is a risk a person accepts **in writing**, or resolves. |

> **The shortest useful summary.** `docs/07` already identified the seven questions to take
> to the product owner first — **`OQ-6`, `OQ-7`, `OQ-10`, `OQ-13`, `NOQ-3`, `OQ-9`,
> `NOQ-5`**. This plan adds only the consequence: **until `DG-1` and `DG-2` clear, the only
> implementation work that can honestly proceed is the stack-neutral half of Phase 0.**
> That is not a scheduling inconvenience to route around. It is the plan telling the truth.

---

## Workstream overview

Phases say *when*. Workstreams say *who can work in parallel without colliding*.

| ID | Workstream | Surface | Owns | Runs during |
|---|---|---|---|---|
| `W1` | **Foundation** | — | Repository, ADRs, the scaffold, the data foundation, the status machine. | `P0`, `P1` |
| `W2` | **Public** | Public read (`docs/09` surface 1) | `OP-1`, `OP-2`, `OP-11`; `S1`, `S2`. **The public projection.** | `P2` |
| `W3` | **Submission** | Public write (surface 2) | `OP-3`; `S3`, `S4`; validation behavior; the `C11` anti-spam seam. | `P3` |
| `W4` | **Administrative** | Administrative (surface 3) | `OP-4`–`OP-8`; `S5`–`S7`; authentication boundary (`C8`); moderation lifecycle (`C6`). | `P4` |
| `W5` | **Quality and release** | All | Regression, exploratory charters, accessibility review, the release checklist. | **`P2` onward — not only `P5`** |

**The workstreams are the surfaces, deliberately.** `docs/09` and `docs/11` both organise
around the three surfaces because **the surfaces are the security model**. Splitting the
team along the same lines means a reviewer of a `W2` pull request is reviewing exactly one
trust context, and a change that crosses a surface boundary is *visibly* a change that
crosses a surface boundary.

**`W5` is not a phase-5 activity.** It starts when `W2` starts. An accessibility problem
found in `P5` is a redesign; found in `P2` it is an afternoon.

---

## Phase 0: repository and project foundation

**Goal.** Everything that must exist before the first line of application code, and the
decisions that must be recorded before that line can be written.

**`P0` splits in two, and the split matters** — one half is blocked and one half is not.

### `P0a` — stack-neutral. Can start immediately; **blocked by nothing.**

| Work | Notes |
|---|---|
| Issue, branch, and pull-request working agreements | The conventions in this document, made concrete as repository templates. |
| An issue template that **requires a requirement reference** | This is how `IP-4` stops being an aspiration. |
| A pull-request template carrying the traceability and definition-of-done checklist | Below. |
| An **ADR directory and ADR template** | `docs/07` names the ADRs; nothing holds them yet. |
| **`ADR-001`** — ratify the recommended architecture | **The one ADR that can be written now** (`docs/07`). It records Option A, the rejection of microservices and browser-direct data access, and — critically — **why the mini lab shape was rejected on the requirements** (`R-10`). |
| Contribution and review expectations; branch protection on `main` | `PA-5`. |
| The **decision log** — `DG-1`–`DG-4` as tracked, assigned, visible items | A gate nobody owns is a gate that opens itself. |

### `P0b` — stack-dependent. **Blocked by `DG-2`.**

| Work | Blocked on |
|---|---|
| **`ADR-002`** language and application framework | `DG-2`; `docs/07` hard requirements 1, 2, 6 |
| **`ADR-003`** data-store product | **`NOQ-2`, `NOQ-3`** — `docs/07` `DD-3` |
| **`ADR-004`** administrator authentication mechanism | `NOQ-9` — `DD-4`. *(The boundary is settled; the mechanism is not.)* |
| **`ADR-005`** hosting platform and runtime model | `DD-5` |
| Repository scaffold, project structure along the `C1`–`C12` seams, local development setup | `ADR-002` |
| Continuous-integration pipeline; automated checks | `ADR-002`; the testing tool follows from it |
| Deployment path to a non-production environment | `ADR-003`, `ADR-005` |

**Exit criteria.** `ADR-001`–`ADR-005` merged; a scaffold that builds, runs, and executes an
empty test suite in CI; a non-production deployment reachable; the decision log live with
every gate owned and dated.

> **The plan's most uncomfortable sentence, stated once, plainly.** `P0b` cannot be
> scaffolded, and `P1` cannot be started, until the product owner answers `DG-1` and
> `DG-2`. Teams under delivery pressure will be tempted to "start on the model and adjust
> later." **Adjusting a location field later means backfilling every record** (`OQ-6`), and
> adjusting `OQ-10` later means introducing a lifecycle state and a revision entity into a
> live moderation workflow (`S-5`). The temptation is exactly what the gates exist to
> resist.

---

## Phase 1: data foundation

**Goal.** The entities, the status model, and the integrity invariants — the layer every
other phase stands on. **Hard-blocked by `DG-1` and `DG-2`.**

**Sources.** `docs/08` (entities `E1`–`E7`, integrity invariants `DI-1`–`DI-9`, seams
`S-1`–`S-11`); `docs/07` `C9`; `docs/11` (`BI-7`, `BI-8`).

| Work | Delivers | Notes |
|---|---|---|
| Core entities and their relationships | `E1`, `E2`, and the review data of `E3` | **Shape and field set come from the `DG-1` answers, and from nowhere else.** |
| **The status model and its permitted transitions** | `BI-8`, `DI-1`, `DI-2` | The heart of the phase. A record has **exactly one** status, changed **only** by a permitted transition. |
| Atomic publication | `BI-7`, `DI-3`, `NFR-DATA-03` | Publication is never partially observable. |
| Identity, timestamps, integrity rules | `DI-6`–`DI-9` | Identity is stable and content-independent (`DDM-2` stays open — that is a physical choice). |
| The **public/private field boundary as a projection**, enforced server-side | `S-2`, `DI-5` | **The mechanism (`DDM-6`) stays open**; the *obligation* does not. Whether withheld fields live on the same record or a separate structure is not decided here. |
| Category set representation | `S-3` | Follows `OQ-5`. Configuration or data — `DDM-3` decides *after* the product answer. |
| Seams left **unbuilt**, and recorded as unbuilt | `S-5`, `S-7`, `S-8`, `S-9`, `S-10`, `S-11` | Revision, audit, anti-spam, duplicate, and retention structures exist **only if** the corresponding question resolves to "yes." `IP-7`. |

**Test focus** (`docs/11`, unit and integration levels): every `DI-*` invariant; transition
legality, including **illegal transitions rejected**; atomicity; the projection — *which
fields leave the system, for whom*.

**Exit criteria.** `DI-1`–`DI-9` proven. `BI-7` and `BI-8` proven at the level they are
enforced. No entity or field exists that a `DG-1` answer did not authorise.

---

## Phase 2: public browsing foundation

**Goal.** The public read path, and with it the **public projection** — the control the
privacy commitments rest on.

**Sources.** `docs/09` `OP-1`, `OP-2`, `OP-11`; `docs/10` `S1`, `S2`; `docs/04` `V1`–`V7`;
`docs/07` `C1`, `C4`.

| Work | Delivers |
|---|---|
| `OP-11` — retrieve the category set; `OP-1` — retrieve approved listings | The browse path (`V1`, `V2`) |
| Search and filtering | `V3`, `V4` — **scope bounded by `BI-3`** |
| `OP-2` — retrieve one approved listing | `V5` |
| `S1` (directory) and `S2` (listing detail) | Including their **empty, error, and loading states** — `docs/10` |
| The **public projection**, enforced in `C4` | `BI-1`, `BI-3`, `BI-4`, `BI-6` |
| Responsive behavior; keyboard operability | `NFR-ACC-*` — **from the first screen, not retrofitted** |

**The invariant work is the phase, not a subtask of it.** `BI-4` — that no public output
discloses a non-approved record's existence — is, in `docs/11`'s words, *the hardest to test
and the easiest to skip*, because its failure is an **absence**. It demands an equivalence
test: **never existed, pending, rejected, and removed must be indistinguishable to an
unauthorised observer** — in message text, response shape, count, ordering artefact, and
timing. An issue that verifies "a pending listing returns not-available" has **not** done
this. Plan the equivalence test as its own issue, and review it as the security-relevant
work it is.

**What stays open, and how it is handled.** `OQ-3` (default ordering) — ordering must be
**consistent**; the specific order is not asserted. `OQ-4` (searchable fields) — the *rule*
(`BI-3`) is built and proven; the *scope* is configuration, and the matching mode
(`DD-14`) is not chosen here. `OQ-7` — the projection is built as a rule (*no field outside
the approved public set is ever exposed*), and the *set* comes from the `DG-1` answer.

> **This is the pattern that lets work start before every question is answered**, and it is
> `docs/11`'s best insight: **the rule is testable; the list is not.** Implement the rule.
> Configure the list.

**Exit criteria.** `V1`–`V7` exercised, including failure and empty paths. `BI-1`, `BI-3`,
`BI-4`, `BI-6`, `BI-9` proven at the **operation** level — not through the UI (`IP-5`). The
three empty states are distinguishable, and a system error does not render as an empty list.

---

## Phase 3: listing submission workflow

**Goal.** The public write path — the one unauthenticated write surface in the system.

**Sources.** `docs/09` `OP-3`; `docs/10` `S3`, `S4`; `docs/04` `L1`–`L4`; `docs/07` `C5`,
`C7`, `C11`.

| Work | Delivers |
|---|---|
| `OP-3` — submit a listing request | `L1`–`L3` |
| `S3` (request form) and `S4` (submission confirmation) | Including **validation states** and **confirmation messaging** — `docs/10` |
| Server-side validation, field-level, **preserving input on failure** | `C7`, `NFR-USE-*` |
| **The write-path boundary** | **`BI-2`** — a public submission **cannot** produce an approved record |
| The `C11` anti-spam **seam** — not a mechanism | `OQ-9` / `DG-3` |

**`BI-2` is this phase's reason to exist.** A submission must arrive as *pending*, always —
and supplying a status, a timestamp, or any administrative field must be **rejected, not
merely ignored**. `docs/09` `AV-8` and `docs/08` `DI-4` both say so. Prove it by attempting
the violation.

**What stays open.** `OQ-8` / `OQ-8b` (required fields, contact minimum) is a **`DG-1`
answer** — validation *behavior* is built here; the *rules* are configured, not invented.
`OQ-9` (anti-spam) is a **`DG-3`** decision: the seam is built; the mechanism is not chosen,
and **its absence cannot be asserted correct either** (`docs/11`). `AQ-1` (duplicate
submissions) has no defined behavior — it gets an **exploratory charter**, not an assertion.
`OQ-2` (lister notification) is **not built**: the absence of any unauthenticated retrieval
path is itself tested (`DI-5`).

**A constraint on any future anti-spam mechanism, recorded now so it is not discovered
late:** whatever `OQ-9` resolves to, it **must not break keyboard or assistive operability**
(`docs/11`, `NFR-ACC-01/02`) and must respect the vision's low-friction principle. A CAPTCHA
chosen casually can violate both.

**Exit criteria.** `L1`–`L4` exercised, including failure paths. `BI-2` proven by attempted
violation. Validation is field-level and preserves input. The confirmation states the
resulting state honestly — *pending*, not *published*.

---

## Phase 4: administrative review workflow

**Goal.** The moderation lifecycle, behind an authentication boundary.

**Sources.** `docs/09` `OP-4`–`OP-8`; `docs/10` `S5`–`S7`; `docs/04` `A1`–`A7`; `docs/07`
`C3`, `C6`, `C8`.

| Work | Delivers | Notes |
|---|---|---|
| **The authentication and authorization boundary** (`C8`) | **`BI-5`** | **First. Before any administrative capability exists.** `IP-1`. |
| `OP-4` (pending queue), `OP-5` (record detail) | `A1`, `A2` | |
| `OP-6` (edit content) | `A3` | |
| `OP-7` (approve), `OP-8` (reject) | `A4`, `A5` | The transition through `C6`, atomic (`BI-7`). |
| `S5`, `S6`, `S7` | The administrative screens, with their states | |
| `OP-9` (remove/unpublish), `OP-10` (approve a revision) | **Conditional — built only if `OQ-11` / `OQ-10` say so** | `S-5`. **`OP-9` does not exist today.** Do not build it speculatively. |
| Audit emission (`C10`) | **Conditional — `OQ-14` + `NOQ-8` / `DG-3`** | `S-7`, `S-8`, `DD-7`. Resolved as **one decision**, not two. |

**Build `BI-5` first, and prove it before the capability behind it exists.** No
administrative action — view queue, view record, edit, approve, reject — is reachable
without an authorized identity, and **nothing is learned from being refused** (`BI-4`
applies to administrative surfaces too). Every one of these must be attacked at the
**operation** level: a hidden button is a courtesy, not a protection (`BI-9`).

**`BI-6` is `W4`'s standing obligation to `W2`.** Status, submitted-at, last-updated, review
attribution, and moderation notes must never reach a public surface. This is the phase most
likely to breach it — because it is the phase where that data is finally in someone's hands.

**Exit criteria.** `A1`–`A7` exercised, including failure and empty paths. `BI-5`, `BI-6`,
`BI-8` proven at the operation level. Confirmations state resulting states. Conditional
operations are built **if and only if** their question resolved yes — and their absence is
recorded as a decision, not an omission.

---

## Phase 5: testing, hardening, and release preparation

**Goal.** The evidence on which a release decision is made — and the honest statement of
what that evidence does *not* cover.

**Sources.** `docs/11` throughout.

| Work | Notes |
|---|---|
| **Regression suite consolidated** | Every `BI-*` and `DI-*` protected on every change. |
| **Cross-surface boundary testing** | The invariants re-attacked with all three surfaces finally present — the first time this is possible. |
| **Exploratory charters** | Including the `AQ-1` duplicate-submission charter and `OQ-12` duplicate pain (`docs/11`). |
| **Accessibility review by a human** | `NOQ-5` names no standard — **the behaviors (`UA-1`–`UA-6`) are still verified**; the conformance *level* is not asserted. |
| **Microcopy review** — the not-available message reviewed as **security-relevant text** | `docs/11` Category 2. |
| **Moderation workflow tried against a realistic queue** | Category 2 — usability under load a suite cannot judge. |
| **Validation reviewed for wrongly excluding legitimate community members** | Category 2. `docs/01`'s purpose is at stake here, not just its correctness. |
| Operational readiness — logs exclude credentials (`NFR-SEC-08`, **not deferred**) | `NOQ-7` (retention) remains open — `DG-4`. |
| **Backup and restore exercised *at all*** | No RPO/RTO asserted (`NOQ-3`) — only that it works. |
| **The written acceptance of every Category 3 item** | Below. |

**Hardening does not mean adding.** It means attacking what exists. No new capability enters
in `P5`; a capability that surfaces here as "missing" is either a defect against an approved
requirement, or **it is out of scope** (`docs/03`) and it stays out.

---

## Issue and branch strategy

**One issue = one reviewable increment.** Concretely, an issue is *one of*:

- one API operation (`OP-n`) with its validation, authorization, and tests;
- one screen (`S-n`) with its empty, error, validation, and loading states;
- one boundary invariant's attack suite (`BI-n`) — **`BI-4`'s equivalence test is its own
  issue**, always;
- one entity or one integrity rule group;
- one ADR;
- one document amendment.

**An issue is too big if** it spans two surfaces, or two phases, or cannot be reviewed in
one sitting, or its title needs the word "and." **An issue is too small if** it cannot be
merged without another issue merging first — that is not an issue, it is half of one.

**Every issue states:** its requirement reference (`FR-*` / journey / `NFR-*` — `IP-4`), the
phase and workstream it belongs to, the invariants it must not break, its acceptance
criteria, and **any open question it must not answer.** That last field is unusual, and it
is the one that does the most work: it turns "don't accidentally decide `OQ-7`" from a
hope into a review checklist item.

**Branch naming follows the established convention** — `<type>/<issue-number>-<slug>`,
matching how `docs/01`–`docs/11` were delivered (`docs/23-implementation-plan`, and so on).
Types: `docs`, `feat`, `fix`, `test`, `chore`. One branch per issue, cut from `main`.

**Blocked issues carry a `blocked` label naming their gate** (`DG-1`, `DG-2`, `DG-3`). They
may be *written* early — writing them is how the gate's cost becomes visible — but they are
**not started**. A backlog of visibly blocked issues is the most persuasive argument a
product owner will ever get for answering `DG-1`.

---

## Pull-request strategy

**One pull request per issue, small enough to review properly.** A reviewer who skims is a
reviewer who approves a boundary breach.

**Every pull request carries:**

| Element | Why |
|---|---|
| The issue it closes | `IP-9`, and the traceability chain. |
| The requirement(s) it satisfies | `IP-4`. |
| **The invariants it touches**, and how they are proven | `IP-5`, `IP-6` — the review focus. |
| **Its tests, in the same pull request** | `IP-6`. Non-negotiable. |
| Documentation changes it necessitates | `IP-9`. |
| **An explicit statement if it approaches an open question** | The single most valuable line in the template. |

**Pull requests that must be split:** anything touching two surfaces; anything mixing a
refactor with a behavior change; anything mixing an ADR with the code that depends on it
(**the ADR merges first**).

---

## Review and approval workflow

**Issue → branch → pull request → review → merge → close.** Unchanged from how the
documentation chain was delivered (`PA-5`), and preserved deliberately.

**What a reviewer is responsible for, in priority order:**

1. **Does it breach an invariant?** `BI-1`–`BI-9`, `DI-1`–`DI-9`. This outranks everything
   below it, including style, structure, and taste.
2. **Does it silently answer an open question?** A field name, a default, a status value, a
   retention period, an ordering — each can quietly close a question the product owner has
   not been asked. **This is the failure mode this whole plan is built to prevent**, and the
   reviewer is the last line of defence against it.
3. **Is it in scope?** No requirement reference, no merge (`IP-4`). Out of `docs/03`, no
   merge.
4. **Is it proven where it is enforced?** Not only through the UI (`BI-9`, `IP-5`).
5. **Does the documentation still tell the truth after this merge?** (`IP-9`.)

**Approval requires one reviewer.** Boundary-invariant work (`BI-*`), the authentication
boundary, and the public projection warrant a **second pair of eyes** — not because the
first reviewer is untrusted, but because these are the changes whose failure is silent.

---

## Traceability expectations

The chain must hold in both directions, end to end:

> **Requirement (`docs/05`, `docs/06`) → journey (`docs/04`) → operation (`docs/09`) /
> screen (`docs/10`) / entity (`docs/08`) → issue → branch → pull request → test
> (`docs/11`) → merge.**

- **Forward:** every approved requirement reaches at least one issue, or is explicitly
  recorded as deferred/blocked. Nothing is silently dropped.
- **Backward:** every issue, and every merged pull request, names the requirement it serves.
  Nothing is silently added — which is how out-of-scope features actually get built: not by
  decision, but by drift.
- **Invariants:** every `BI-*` and `DI-*` names the test that attacks it. An invariant with
  no attacking test is an invariant with no evidence.
- **Open questions:** every `OQ-*` / `NOQ-*` / `AQ-*` is traceable to the gate that holds
  it and the work it blocks.

**A traceability matrix is maintained as part of `P0a`, and updated in the pull request that
changes it** — not reconstructed at release, when it would be archaeology.

---

## Definition of ready

An issue may be **started** when:

| # | Condition |
|---|---|
| 1 | It cites a requirement, journey, or `NFR` (`IP-4`). |
| 2 | It is within `docs/03` scope. |
| 3 | **Every open question it depends on is answered** — or the issue is explicitly scoped to the part that does *not* depend on one (the *rule*, not the *list*). |
| 4 | Its gate (`DG-1`–`DG-4`) is open. |
| 5 | Its acceptance criteria are stated and testable. |
| 6 | The invariants it must not break are named. |
| 7 | Its dependencies are merged. |
| 8 | It is small enough for one reviewable pull request. |

**Condition 3 is the one that will be argued about.** It is also the one that makes the
difference between a plan that preserves the chain's discipline and a plan that quietly
spends it.

---

## Definition of done

An issue is **done** when:

| # | Condition |
|---|---|
| 1 | The behavior matches the approved requirement — no more, and no less. |
| 2 | **Its tests are merged with it** (`IP-6`), at the level where the behavior is enforced (`IP-5`). |
| 3 | **Every invariant it touches is proven by an attacking test** — one that attempts the violation and fails to achieve it. |
| 4 | Empty, error, validation, loading, and confirmation states exist where `docs/10` requires them. |
| 5 | Keyboard operability holds for the flows it touches. |
| 6 | **No open question was answered by it.** Any decision made is recorded in an ADR or a document amendment in the same pull request. |
| 7 | Documentation and traceability are updated (`IP-9`). |
| 8 | It is reviewed, approved, and merged to `main`. |

**Condition 3 is the sharp one.** "The test passes" is not the standard. **"We tried to
break it and could not"** is the standard — because that is the only form of evidence a
boundary invariant accepts (`docs/11`).

---

## Release-readiness checkpoints

**Aligned with `docs/11`'s three categories, and inventing no threshold it declined to
invent.**

| Checkpoint | When | What it asserts |
|---|---|---|
| **`RC-1`** — foundation ready | End of `P1` | `DI-1`–`DI-9`, `BI-7`, `BI-8` proven. Every entity authorised by a `DG-1` answer. |
| **`RC-2`** — public path ready | End of `P2` | `V1`–`V7`. `BI-1`, `BI-3`, `BI-4`, `BI-6` proven — including **`BI-4`'s equivalence test**. Empty states distinguishable. |
| **`RC-3`** — write and moderation paths ready | End of `P3`, `P4` | `L1`–`L4`, `A1`–`A7`. `BI-2`, `BI-5` proven. Confirmations state resulting states. |
| **`RC-4`** — **release decision** | End of `P5` | Below. |

**`RC-4` is `docs/11`'s release-readiness criteria, and nothing more:**

- **Category 1 — unconditional gates.** All nine boundary invariants proven by attacking
  tests. All `DI-*` hold. **No Critical-boundary defect open** — *closed*, not deferred, not
  accepted, not documented as known. Every journey exercised including failure and empty
  paths. Empty states distinguishable, and **a system error never renders as an empty
  list**. Confirmations honest. Core flows keyboard-operable; public flows usable at phone
  size. **Not tradeable against a date.**
- **Category 2 — judgment gates.** A person signs off: microcopy honesty (the not-available
  message reviewed as security-relevant text), the assistive-technology experience, the
  moderation workflow against a realistic queue, and validation that does not wrongly
  exclude legitimate community members.
- **Category 3 — blocked.** Performance (`NOQ-1`, `NOQ-4`), availability (`NOQ-2`), backup
  and recovery targets (`NOQ-3`), accessibility conformance level (`NOQ-5`), browser/device
  matrix (`NOQ-6`). **These cannot be gates, because their targets do not exist.** Each is a
  **release risk accepted explicitly, by a person, in writing** — or resolved before launch.

> **This plan sets no coverage percentage, no performance threshold, and no testing depth.**
> `docs/11` declined to, and gave its reason: *a depth chosen here would be a guess presented
> as a requirement.* A plan that supplies the number the strategy refused to supply has not
> been more rigorous. It has been less honest.

---

## Documentation-update expectations

| Trigger | Update | When |
|---|---|---|
| A technology chosen | An **ADR** | Merged **before** the code depending on it. |
| An open question answered | The **owning document** (`docs/03`–`docs/11`), and this plan's gate table | Before the unblocked work starts. |
| A seam built out (`S-5`, `S-8`, `S-9`…) | `docs/08` | With the pull request that builds it. |
| An operation or screen changed | `docs/09` / `docs/10` | Same pull request. |
| A new invariant discovered | `docs/11` | Same pull request. |
| An implementation constraint that contradicts a document | **Stop.** Amend the document, or change the code. | **Before merging.** |

**The last row is the one that keeps the chain alive.** When implementation discovers that a
document is wrong, the correct response is *never* to build the right thing and leave the
document lying. **A stale document is worse than no document**, because it is trusted.

---

## Testing expectations during implementation

**Aligned with `docs/11`; adding nothing to it.**

- **Tests merge with their code** (`IP-6`). A boundary proven "next sprint" was unprotected
  in between.
- **Invariants are attacked at the level where they are enforced** — the **operation**
  level, not the UI (`BI-9`, `IP-5`). `docs/11` is explicit that the operation level *carries
  the weight of the strategy*, and that testing invariants through the interface proves only
  that the interface does not *offer* the violation.
- **The levels are unit, integration, operation, journey, and human.** No pyramid is
  prescribed; no coverage percentage is set (`docs/11` `T7`).
- **The `cannot-test-yet` register is honoured.** An absent test must read as a *decision*.
  Where a question blocks a specific assertion, **the general rule is still tested** — the
  rule is testable even when the list is not.
- **No test may become the decision.** A test asserting a specific public field set would
  answer `OQ-7` by the back door. This is `docs/11`'s `T4`, and it is a merge-blocking
  review item.
- **Human-judgment areas are scheduled, not hoped for** — accessibility, microcopy,
  moderation usability. They start during `P2`.

---

## Risk management during implementation

| ID | Risk | Consequence | Response |
|---|---|---|---|
| `IR-1` | **Gates are bypassed under delivery pressure** — "we'll assume and adjust." | The product decision gets made by an engineer, invisibly. `OQ-6` means backfilling every record; `OQ-10` means retrofitting a lifecycle state into a live workflow. | The `blocked` label; the decision log; reviewer responsibility #2. **The most likely failure of this plan, by a wide margin.** |
| `IR-2` | **The public projection is built as a convention, not a control.** | `BI-1`, `BI-6`, and `NFR-PRIV-01/02` become promises with nothing behind them (`docs/07` `R-2`). | Build it in `P1`/`P2` as a single enforced projection (`C4`); attack it at the operation level. |
| `IR-3` | **Invariants tested only through the UI.** | The suite proves the UI hides the violation, not that the system forbids it. | `BI-9`, `IP-5`; a merge-blocking review item. |
| `IR-4` | **`BI-4`'s equivalence test is skipped** — it is an absence, and absences are easy to not notice. | Existence of pending/rejected records leaks by message, count, shape, or timing. | Its own issue; second reviewer. |
| `IR-5` | **Scope drift** — a small, reasonable, unrequested feature. | The MVP grows; `docs/03` becomes fiction. | `IP-4`; reviewer responsibility #3. |
| `IR-6` | **The mini lab is copied back in** during implementation. | Reintroduces the browser-direct shape `docs/07` **rejected on the requirements** (`R-10`) — undoing an argued decision without argument. | `IP-8`; `ADR-001` records the rejection explicitly so it cannot be re-made by accident. |
| `IR-7` | **`OQ-14` / `NOQ-8` (audit) drifts unanswered into `P4`.** | **Irreversible.** History not captured cannot be reconstructed; every administrative action taken meanwhile is permanently unlogged. | `DG-3`. The asymmetry is the argument — take it to the product owner early. |
| `IR-8` | **Anti-spam (`OQ-9`) is answered late, then chosen hastily.** | A mechanism that breaks keyboard/assistive operability (`NFR-ACC-01/02`) or the vision's low-friction principle. Bulk submissions attack the manual-review capacity `PA-2` assumes. | `DG-3`; the accessibility constraint is recorded **now**, before the mechanism is chosen. |
| `IR-9` | **Documentation rots** during implementation. | This plan's only authority — derivation from the chain — expires silently. | `IP-9`; the documentation-update table; a review responsibility. |
| `IR-10` | **Over-building the seams** — audit, revisions, anti-spam structures built "ready" before their questions resolve. | Complexity bought against decisions that may resolve to *no*, and a structure that then prejudges them. | `IP-7`. `docs/07` and `docs/08` both weighed this explicitly; the seam is an **option**, not an obligation. |

---

## Open questions that block or shape implementation

**None is resolved here.** Each is carried forward with the work it holds.

| ID | Question | Gate | Blocks |
|---|---|---|---|
| `OQ-1` | Visitor report-inaccuracy path? | — | Nothing. Not built; `V7` is view-only. |
| `OQ-2` | Lister outcome notification / reference? | — | Nothing in MVP. A "yes" adds an outbound dependency (`DD-16`). |
| `OQ-3` | Default ordering? | — | Nothing. Ordering is built **consistent**; the order is configured. |
| `OQ-4` | Searchable fields and matching mode? | **`DG-1` — shaping input** | Search *scope*, `S-4`, `DDM-4`, `DD-14`. Blocks no phase. **`BI-3` — search scope never exceeds publication scope — is built and proven regardless.** The rule is testable; the scope is not. |
| `OQ-5` | Category model — cardinality, curation? | **`DG-1` — shaping input** | `S-3`, `DDM-3` (enumeration, reference table, or configuration). Blocks no phase. **Set membership — a category always from the predefined set — is enforced regardless.** |
| `OQ-6` | **Location granularity?** | **`DG-1`** | **All of `P1`.** Retrofitting means backfilling every record. |
| `OQ-7` | **Public versus private fields?** | **`DG-1`** | **`P1` and `P2`.** The projection is the control `NFR-PRIV-01/02` rests on. |
| `OQ-8` / `OQ-8b` | **Required submission fields; contact minimum?** | **`DG-1`** | `P3` validation *rules* (`S-1`). The *behavior* is built regardless. |
| `OQ-9` | **Anti-spam behavior?** | **`DG-3`** | The `C11` mechanism (`S-9`, `DD-6`). **Its absence cannot be asserted correct either.** |
| `OQ-10` | **Edit after approval — immediate, or secondary review?** | **`DG-1`** | `P1` (`S-5` — may add a lifecycle state and a revision entity) and `OP-10`. **The largest architectural consequence of any open question.** |
| `OQ-11` | **Removal / unpublish?** | **`DG-1`** | `P1` status model; **`OP-9` does not exist today.** |
| `OQ-12` | Duplicate resolution? | — | Nothing structural. An administrator procedure; an exploratory charter. |
| `OQ-13` | **Rejected-submission retention?** | **`DG-1`** | `P1` (`S-11`) and a purge capability. Must resolve **both** retention *and* period (`NFR-PRIV-05`). |
| `OQ-14` | **Audit logging of administrator actions?** | **`DG-3`** | `P4` (`C10`, `S-7`, `S-8`). **Irreversible if answered late** — `IR-7`. **Resolve together with `NOQ-8`.** |
| `OQ-15` | Abuse escalation? | — | A human process, not a component. |
| `NOQ-1`, `NOQ-4` | Performance thresholds; expected load? | **`DG-2` — shaping inputs** | `DD-2`, `DD-5`, `DD-12`. **They inform technology selection; they do not block it.** Carried as the stated assumption `PA-1` ("small"). **No threshold is asserted anywhere** — and none may be invented (`docs/11` Category 3). |
| `NOQ-2` | Availability target? | **`DG-2` — hard blocker** | **Store and hosting selection (`ADR-003`, `ADR-005`).** 99% and 99.9% are different deployments. |
| `NOQ-3` | **Backup / RPO / RTO?** | **`DG-2` — hard blocker** | **Store selection (`ADR-003`).** It determines the store's required *capability*, not just a schedule (`docs/07` `DD-3`). |
| `NOQ-8` | **Audit-log requirement — is audit logging an MVP obligation, and what must it retain?** | **`DG-3`** | The **non-functional half of `OQ-14`**, with which it must be resolved as one decision (`docs/07` `C10`, `DD-7`; `docs/08` `S-7`, `S-8`). `OQ-14` asks *whether administrator actions are logged*; `NOQ-8` fixes *the obligation and its content*. Answering one without the other leaves `C10` half-specified — and the omission is **equally irreversible** (`IR-7`). |
| `NOQ-5` | **Accessibility standard and level?** | **`DG-3` — shaping input** *(but answer it **early**)* | The conformance **claim** only. Blocks no phase: the accessibility **behaviors** (`UA-1`–`UA-6`) are built and tested from the first screen regardless. **Cheap now, expensive to retrofit** — the one shaping input whose *cost* behaves like a blocker. |
| `NOQ-6` | Browser / device / assistive-technology matrix? | **`DG-3` — shaping input** | The **support claim** only. Blocks no phase: responsive behavior at representative sizes is built and tested regardless. It defines what "works" *means* for testing, not whether testing can proceed. |
| `NOQ-7` | Operational-log retention? | `DG-4` | `DD-13`. **The exclusion rule (`NFR-OBS-02`) is not deferred** — credentials never appear in logs. |
| `NOQ-9` | Administrator credential and session strength? | **`DG-3`** | `ADR-004` (`DD-4`) — before the `P4` authentication boundary. |
| `AQ-1` | Duplicate-submission behavior? | — | Undefined. **An exploratory charter, not an assertion.** |
| `AQ-5` | API versioning? | — | No version scheme adopted; one first-party client. |
| **Testing depth** | How exhaustive before first release? | **`DG-4`** | The size of the suite. **Category 1 gates hold regardless of the answer.** |
| **Technology stack** | Language, framework, store, hosting, auth, CI, test tooling? | **`DG-2`** | **`P0b` and everything after it.** Only `ADR-001` (the architecture *shape*) is decidable today. |

---

## Deferred implementation areas

Deliberately **not built** in the MVP. Listed so their absence reads as a decision.

| Area | Status | Source |
|---|---|---|
| `OP-9` (remove/unpublish), `OP-10` (approve a revision) | **Conditional.** Built **only if** `OQ-11` / `OQ-10` resolve yes. | `docs/09`, `S-5` |
| Audit entity and emission (`E5`, `C10`) | **Conditional** — `OQ-14` **and `NOQ-8`**, taken together. | `docs/07` `DD-7`, `docs/08` `S-7`, `S-8` |
| Anti-spam mechanism (`C11`, `E6`) | **Seam only.** The mechanism awaits `OQ-9`. | `docs/07` `DD-6`, `S-9` |
| Revision storage (`E7`), duplicate representation, retention/purge | **Conditional** — `OQ-10`, `OQ-12`, `OQ-13`. | `S-5`, `S-10`, `S-11` |
| Outcome notification (email) | **Not built** — `OQ-2`. Adds an outbound dependency, a failure mode, and a privacy surface. | `DD-16` |
| Redundancy, horizontal scaling, caching, a dedicated search index | **Not built.** Stateless instances preserve every option at no cost today. A search index **must be justified by measurement, never by preference**. | `docs/07` `DD-8`, `DD-14` |
| API versioning | No scheme adopted. One first-party client. | `docs/09` `AQ-5` |
| Business-owner accounts, claiming, reviews, ratings, analytics, advertising, payments, events, social features, native apps, third-party API consumption | **Out of scope** — not deferred, *excluded*. | `docs/03` |

> **The distinction between *excluded* and *blocked* is preserved deliberately**, and it is
> `docs/11`'s point restated for implementation: an **excluded** area will not be built
> because it is not in the MVP; a **blocked** area *would* be built and cannot be, because
> its decision is unmade. **Conflating them is how a missing decision quietly becomes a
> missing feature, permanently.**

---

## Future implementation considerations

Recorded for continuity. **Not committed, and not planned.**

| Future capability | Implementation consequence |
|---|---|
| Business-owner accounts | **A third trust level.** Every boundary invariant must be re-examined against it — the largest future increase in surface, in both code and tests. |
| Listing claiming | A verification lifecycle with its own abuse surface. |
| Reviews and ratings | **A second moderation lifecycle** — roughly doubling the `BI-1`-style obligations. |
| A second client (native app, partner) | Makes the API contract **external**, forcing versioning and contract testing (`AQ-5`). The `docs/09` boundaries were drawn to make this survivable. |
| Report-inaccuracy path (`OQ-1`) | **A second unauthenticated write path** — inheriting every abuse and boundary concern of the first. |
| Extracting the administrative surface, or a split frontend | Possible **without unpicking the domain** — this is precisely what the `C4`–`C9` seams were preserved for (`docs/07`, Option B deferred rather than rejected). |
| Growth beyond `PA-1` | Revisit `DD-14` (search) and `DD-8` (redundancy) **against measurement** — never against preference. |

---

## Summary

**The plan in six sentences.** Ratify the architecture and set up the working agreements now
(`P0a` — nothing blocks it). Take `DG-1` and `DG-2` to the product owner immediately,
because **until they clear, no application code can honestly be written.** Then build the
data foundation and its status machine (`P1`), the public projection and read path (`P2` —
where the hardest invariants live and where they are cheapest to enforce), the public write
path (`P3`), and the moderation lifecycle behind its authentication boundary (`P4`).
Consolidate, attack, and review in `P5`, and make the release decision against `docs/11`'s
three categories — **without inventing the thresholds it deliberately declined to invent.**
Throughout, every issue cites a requirement, every invariant is proven by a test that tries
to break it, and **no pull request answers a question the product owner has not been asked.**

**What this plan is really protecting.** Not the schedule — the *chain*. Eleven documents did
the difficult work of leaving open what is genuinely undecided, supplying the seam, and
refusing to guess. Implementation is where that discipline is most expensive to keep and
most tempting to spend. **The gates, the `blocked` label, the "open question this must not
answer" field, and reviewer responsibility #2 exist for exactly one purpose: to make sure
the answers come from the people whose answers they are.**
