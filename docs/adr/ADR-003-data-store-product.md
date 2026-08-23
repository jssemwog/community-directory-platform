# `ADR-003` — Adopt PostgreSQL under a managed operating posture as the MVP data store, and defer the named provider

| Field | Value |
|---|---|
| **Status** | `Proposed` |
| **Date** | `2026-08-23` |
| **Decision owner** | Joe S. — product owner |
| **Decision gate** | `DG-2` — technology. **Unresolved.** This ADR contributes to the technology-decision work; it does not close the gate |
| **Related open questions** | **Depends on:** ~~`NOQ-2`~~ **Decided** 2026-07-30 · ~~`NOQ-3`~~ **Decided** 2026-07-30, amended by ruling **R1** 2026-08-18. **Carried as shaping inputs, not blockers:** `NOQ-1`, `NOQ-4` (`PA-1`). **Must NOT answer:** `OQ-4`, `OQ-5`, `OQ-14`, `NOQ-9`, and `DDM-2`–`DDM-10` — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **`Proposed` means not in force.** Per `docs/adr/README.md`, a `Proposed` ADR is *"drafted and
> under review. The decision is **not yet in force**; nothing may depend on it."* `DD-3` is not
> discharged, `DDM-1` is not discharged, `DG-2` is not resolved, and **no implementation is
> authorized** by this document.

---

## Context

**The store is the last of `DD-3`'s named preconditions to come due, and it is now the only one
outstanding.** `docs/07-system-architecture.md` `DD-3` defers the data-store *product* while
fixing its required *storage properties*, and states that a store **cannot be responsibly chosen
against an unknown recovery point objective**. Both questions that held it are answered:

- **`NOQ-2` — Decided 2026-07-30.** 99% availability over a rolling monthly window, excluding
  announced maintenance; the public read path takes priority over administrative tools
  (`NFR-REL-01`, `NFR-REL-02`, `NFR-REL-05`).
- **`NOQ-3` — Decided 2026-07-30, amended by ruling `R1` 2026-08-18.** Daily backups; a recovery
  point objective of up to 24 hours; a recovery time objective of one business day; a restore
  tested before launch and at least quarterly; at least one independent copy off the primary
  provider, no more than 24 hours behind the committed state of the live data; equivalent
  confidentiality and access control for every copy (`NFR-BACK-01`–`NFR-BACK-06`).

**Two accepted ADRs supply the shape this decision is judged against.**

- **`ADR-006` (Accepted 2026-08-07) — the domain model.** One durable listing identity carries a
  record through its whole life; a submission **is** a listing whose status is *pending*, and
  approval is a status transition on one record, never a copy or a migration (`DI-8`, **P2**).
  Listing status is exactly the three values `FR-AUD-01` fixes, with exactly one held at all
  times (`DI-1`) and change only along `NFR-DATA-02`'s permitted transitions. Three state
  dimensions — listing status, publication state, and revision state — are kept permanently
  separate, and three prior product decisions each declined to add a fourth status. At most one
  pending revision exists per listing (`DI-11`), and a pending revision is never publicly
  visible (`DI-10`). Every action completes fully or not at all, and in particular is never
  partially public (`DI-3`, `NFR-DATA-03`).
- **`ADR-010` (Accepted 2026-08-19) — the recovery and availability posture.** It accepts a
  **single-instance** availability posture at the 99% target, and it requires **a recovery
  capability finer than the ordinary scheduled-backup interval**, whose purpose is recovery from
  accidental deletion, operator error, and corruption. The 24-hour recovery point objective is
  the **maximum tolerated loss, not the required granularity of the mechanism**. `ADR-010`
  retains the **stronger reading** of hard requirement 5 and states that `ADR-003` **must screen
  candidate stores for that finer capability**. It selects no mechanism, and it is recorded as
  *feeding* this ADR.

**The hard requirements this decision answers to** — `docs/07` *Hard requirements*, where a
candidate failing any one is out:

- **Hard requirement 3** — transactional writes with an **enforceable** status constraint
  (`NFR-DATA-01`, `NFR-DATA-03`).
- **Hard requirement 4** — **no client-held data-store credential and no public route to the
  store** (`NFR-SEC-08`), recorded as a **disqualifier** in `ADR-001` (`R-10`).
- **Hard requirement 5** — a store with **point-in-time restorable, confidentiality-preserving
  backups** (`NFR-BACK-01`–`NFR-BACK-05`), as `ADR-010` reads it.

**And the storage properties `docs/07` requires of any eventual product:** transactional
all-or-nothing writes; an enforceable constraint that status is one of a fixed set; efficient
filtered queries on status, category, location, and keyword at the expected corpus size;
point-in-time restorable backups carrying the same confidentiality as live data; and no public
network route. `docs/07` records that **a relational store satisfies all five naturally**, and
that this is *"a strong indication — but the product remains deferred."*

**Operational simplicity is the scarcest resource.** `docs/07` weights *operational simplicity
for one maintainer* and *security posture out of the box* **Highest**, testability **High**, and
cost, portability, and low lock-in **Medium**. Raw performance ceiling and elastic scalability
are weighted **Low**, and elastic scalability is explicitly *not* a tiebreaker.

**Provider independence is a live concern, not a slogan.** Principle 7 and the Medium-weighted
portability criterion both point at avoiding a proprietary capability nothing here is big enough
to need.

**`OQ-4` is a shaping uncertainty, not a blocker.** The keyword-search field scope and matching
mode are undecided (`FR-SRCH-02`), and the indexing and text-search strategy is deferred
(`DDM-4`). No repository document lists `OQ-4` among the blockers on store selection:
`docs/12-implementation-plan.md` names `NOQ-2` and `NOQ-3` as the hard blockers specific to
store selection — both Decided — while the technology stack as a whole remains `DG-2`'s third
hard blocker, Unresolved. What the MVP requires today is keyword search over approved listings
(`FR-SRCH-01`), category filtering (`FR-SRCH-04`), location filtering (`FR-SRCH-05`), and their
combination (`FR-SRCH-06`).

**`NOQ-1` and `NOQ-4` remain open and are carried, not resolved.** `docs/12` files both as
shaping inputs that inform technology selection without blocking it, carried as the stated
assumption `PA-1` — *the directory is small at first release*.

**This decision was commissioned, compared, and ruled on under issue #81**, whose governance
comments record the boundary ruling, the provider-deferral ruling, and the selection ruling.

## Decision

**We will adopt PostgreSQL as the MVP data-store technology, and we will operate it under a
managed posture.**

Concretely, and no further:

1. **The data-store technology is PostgreSQL.**
2. **The operating posture is managed** — the database service is operated by a provider rather
   than installed, patched, and operated by the maintainer.
3. **The named provider is deliberately deferred.** No vendor or service is selected here, and
   none may be inferred from this document. That decision requires a separate, explicit
   product-owner ruling.
4. **No physical schema is decided.** No table, column, key, type, or constraint is named.
5. **No index is decided.** No indexing or text-search strategy is selected.

**These are one decision, not several.** The technology and the posture are taken together
because the weighted criteria do not rank PostgreSQL the same way under both postures: a
self-managed posture would fail the Highest-weighted operational-simplicity criterion that a
managed posture satisfies. Recording the technology without the posture would preserve the
answer and discard the reason.

## Rationale

1. **Natural fit with the fixed relational domain model.** `ADR-006` fixes a listing-centric
   model with strict invariants and three orthogonal state dimensions; `docs/07` records that a
   relational store satisfies its five required storage properties naturally and that its
   constraint and transaction guarantees map directly onto the moderation lifecycle.
2. **Transactions and integrity constraints without working around the store.** Hard requirement
   3 asks for an *enforceable* status constraint — enforced by the store, not by convention.
   `DI-5` is stated over paths rather than queries precisely because *"we never write a query
   that returns pending records" is a coding convention, and conventions are broken by the next
   person in a hurry.* A store whose constraints are declarative moves that guarantee out of
   reach of a hurried change.
3. **Native continuous-archiving and point-in-time recovery materially align with the `ADR-010`
   filter.** PostgreSQL's write-ahead-log archiving model supports recovery to a chosen point
   rather than to the boundary of a backup interval — which is the capability `ADR-010` requires
   and the failure classes it names (accidental deletion, operator error, corruption) call for.
4. **External recovery components are allowed in principle, but were not required to qualify.**
   The product owner ruled that nothing prohibits an external recovery or replication layer, and
   that the selection nonetheless favours a store whose core recovery capability aligns with
   `ADR-010` naturally rather than one that needs additional machinery merely to become
   eligible.
5. **A managed posture reduces operational burden** against the Highest-weighted criterion, with
   one maintainer whose attention is the project's scarcest resource (`NFR-OPS-01`,
   `NFR-OPS-04`, `D-6`).
6. **PostgreSQL remains portable across multiple management and provider options.** The engine
   is open source and its dump and wire formats are not proprietary to any vendor, so the
   managed posture does not by itself create technology lock-in.
7. **Deferring the named provider avoids introducing provider lock-in prematurely**, and keeps
   the provider decision available to be judged on its own evidence.
8. **`OQ-4` uncertainty does not presently invalidate the selection.** PostgreSQL spans the
   plausible outcome space for keyword matching without a separate search service, so no
   realistic answer to `OQ-4` would reopen this decision.

**One reason that did not decide this, and must not be read into it.** `docs/07` lists *"it was
used in the prototype"* among the **explicit anti-criteria — reasons that must not decide**
(`C-5`), and `docs/01-vision.md` records that the frozen prototype **informs but does not
constrain** the production architecture. This selection rests on the criteria above.
**Prototype familiarity is not architectural evidence.**

## Alternatives considered

The candidates below are the governed shortlist carried into detailed comparison under issue
#81. Earlier-excluded categories are recorded in that issue's history and are **not** reopened
here.

| Alternative | Why it was rejected |
|---|---|
| **SQLite, embedded, with an external durability and replication layer** | **Rejected as conditional, not as incapable.** SQLite satisfies hard requirements 3, 4, and 6 — and answers hard requirement 4 more strongly than any alternative, since an embedded engine has no network route at all. It offers the best in-process testability against `NFR-MAINT-03`, the lowest cost, the highest portability, and a single-instance shape that matches `ADR-010`'s accepted posture rather than fighting it. **It is fully capable of supporting this application in general**, and nothing here says otherwise. It was rejected on **one** ground: its native backup facilities produce whole-database snapshots, so meeting `ADR-010`'s finer-than-interval recovery capability requires introducing an **external replication layer** whose configuration, monitoring, and rehearsal the project would own, and whose failure mode is silent. The owner ruled that where an otherwise strong candidate satisfies a core recovery requirement natively, a candidate needing added machinery merely to qualify is not preferred. A secondary cost: it would require persistent disk, constraining `ADR-005`, which `DD-5` currently leaves open. |
| **PostgreSQL, self-managed** | Rejected on the **Highest**-weighted criterion. It delivers the same engine capabilities but places patching, tuning, write-ahead-log archive hygiene, monitoring, and the whole recovery apparatus on a single maintainer, against `NFR-OPS-01`/`NFR-OPS-04` and `D-6`. It remains the fallback worth re-arguing if a managed posture proves unobtainable at acceptable cost — and in that case the comparison against SQLite would have to be re-run, not assumed. |

## Recovery boundary — what this ADR does and does not settle

**PostgreSQL's technology capabilities support the recovery model `ADR-010` requires.** That is
the finding this decision rests on, and it is a statement about the **technology**.

**`ADR-010` is not discharged by this ADR.** The eventual **named managed provider** must
expose, permit, and be configured for capabilities sufficient to satisfy the actual operational
requirements — the finer-than-interval recovery capability, the at-least-daily backup, the
24-hour recovery point objective across every in-scope scenario including provider loss, the
one-business-day recovery time objective, the independent off-provider copy no more than 24
hours behind committed live data, and safe restore rehearsal before launch and at least
quarterly. **Technology capability does not prove provider capability.** This is recorded as a
**downstream dependency** of the deferred provider decision.

**This ADR therefore does not claim any of the following**, and no reader may infer them:

- that a backup implementation has been selected;
- that a recovery mechanism has been implemented or fully specified;
- that any named provider has been validated against `ADR-010`;
- that `ADR-010`'s implementation is complete.

If the eventual provider evaluation finds no candidate that satisfies both the capability filter
and the project's other hard requirements, `ADR-010` states the correct response: that is a
finding to bring back to `ADR-010` — *"the filter, not the store, would be what needs
re-deciding"* — and **not** a reason to quietly relax the filter.

## Browser-direct access boundary

**Selecting a managed PostgreSQL posture does not authorize browser-direct access to the data
store, and must never be read as doing so.**

`docs/07` rejected the browser-direct shape **on the requirements**, and `ADR-001` records that
rejection so it cannot be silently re-made. Hard requirement 4 — *no client-held data-store
credential, and no public route to the store* — stands as a **disqualifier**, and `R-10` names
the exact failure this decision could invite: *a managed database product is selected
(legitimate, and compatible with the accepted architecture) and browser-direct access quietly
arrives with it.*

`docs/07` states the distinction this ADR must preserve: **"managed" is a hosting decision;
"browser-direct" is an architecture decision, and conflating the two is the single most likely
way for the rejected shape to reappear by accident.** All access to the store continues to pass
through the server-enforced application boundary that `ADR-001` accepts. Non-public data must
remain unreachable by any public path (`NFR-PRIV-03`, `DI-5`).

## Schema and indexing boundary

Per the product owner's Option A boundary ruling:

- **Schema and indexing considerations informed candidate evaluation** — they are evidence about
  whether a candidate can satisfy the requirements.
- **This ADR does not decide any physical schema representation.**
- **This ADR does not decide any index.**
- **`DDM-2`–`DDM-10` remain separately governed** and open, except where existing repository
  authority already resolves them.

`docs/adr/README.md` warns that *a document that names a field has made a data decision*. This
ADR names none.

## `DG-2` boundary

Stating only what is undisputed:

- **`ADR-003` is `Proposed`.** It is not in force.
- **`DG-2` remains Unresolved**, and the `P0b` scaffold and all of `P1` remain blocked by it.
- **This ADR contributes to the technology-decision work**; other technology decisions remain
  outstanding, including the application language and framework (`ADR-002`) and the hosting
  platform and runtime model (`ADR-005`).
- **The repository carries more than one reading of `DG-2`'s exact remaining scope and closure
  semantics.** That ambiguity is **recorded, not resolved**, and this ADR does not settle it,
  adopt either reading, or invent a third.
- **Exact `DG-2` closure accounting will be addressed separately**, after the necessary
  technology ADRs reach the appropriate governed state.

## Consequences

**Positive:**

- The domain model `ADR-006` fixes is expressible directly, with the lifecycle invariants
  `DI-1`, `DI-2`, `DI-10`, and `DI-11` enforceable declaratively by the store rather than by
  application convention.
- Mature transaction and integrity behaviour satisfies hard requirement 3 and `NFR-DATA-01`,
  `NFR-DATA-03`, and `NFR-DATA-06` without the architecture working around the store.
- Recovery capabilities align with `ADR-010`'s filter natively, so eligibility does not depend on
  a component the project must add and keep alive.
- The engine remains portable across management and provider options, keeping the deferred
  provider decision genuinely open.
- A managed posture converts the Highest-weighted operational-simplicity criterion from a
  liability into a strength.
- Search requirements are met for every plausible `OQ-4` outcome without a separate search
  service, so `DDM-4` can be settled later on its own evidence.

**Negative:**

- It requires a **running service process** rather than SQLite's embedded simplicity — a
  connection surface, a lifecycle, and an upgrade cadence that an embedded engine does not have.
- The managed posture **introduces a future provider decision** that must be taken and governed.
- **Provider capability against `ADR-010` remains to be validated**, and this ADR cannot validate
  it.
- It is **more engine than the corpus requires** at `PA-1` scale — capability accepted
  deliberately in exchange for native recovery and enforcement.
- A managed posture implies a **cost floor** that an embedded engine does not, against a
  Medium-weighted cost criterion asking for near-zero to modest.
- **Schema and indexing remain unresolved** (`DDM-2`–`DDM-10`), so the physical model is still
  entirely ahead.
- **Implementation remains blocked** while `DG-2` remains Unresolved. This ADR unblocks nothing.
- Managed operation introduces surfaces the project does not control — maintenance windows,
  connection limits, and provider incidents — against a 99% target it must still meet.

**Reversibility:** moderate, and asymmetric. Changing the **posture** later — managed to
self-managed or the reverse — is an operational migration that does not touch the domain model.
Changing the **technology** later is a schema-and-data migration, made materially cheaper by
`ADR-006` fixing the logical model independently of any product, and by no schema being decided
here. `docs/adr/README.md` requires that a changed decision be recorded by a **new ADR that
supersedes this one**, never by editing this file into agreement.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`PA-1`** — the directory is small at first release (`A-5`, `A-6`; `NOQ-1` and `NOQ-4` open) | Performance and capacity assumptions are revisited first (`DD-12`). PostgreSQL has ample headroom, so this ADR is unlikely to be the decision that must change — but the assumption is load-bearing across the chain and is carried, not resolved |
| **A managed posture is obtainable at acceptable cost** while satisfying `ADR-010`'s capability filter | The posture half of this decision fails. The comparison would return to self-managed PostgreSQL versus SQLite with an external layer — a re-argument, not a quiet substitution |
| **The eventual provider exposes and permits the required recovery capability** | The provider decision fails its `ADR-010` check, not this ADR. Either another provider is chosen, or the finding returns to `ADR-010` per its own instruction |
| **`OQ-4` does not require a dedicated search engine** | `DDM-4` and `ADR-007` absorb the change; this ADR does not reopen. `ADR-007` already requires *measured* justification for a dedicated index |
| **The server-enforced boundary of `ADR-001` continues to hold** | Hard requirement 4 is breached and the rejected browser-direct shape has returned — the `R-10` failure this ADR restates explicitly |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **`R-10` — the rejected shape returns through the back door.** A managed store is selected legitimately, and browser-direct access arrives with it | Reintroduces every disqualifying property `docs/07` rejected on the requirements | This ADR restates hard requirement 4 as a standing **disqualifier** and records the *"managed is hosting, browser-direct is architecture"* distinction in its own section. The provider decision must be checked against it |
| **A provider name leaks in and becomes the decision by habit** | The deferred provider decision is made by drift rather than by ruling | This ADR names no provider. The deferral is stated in the Decision itself, not only in prose |
| **Provider capability is assumed from technology capability** | `ADR-010` is treated as discharged when it is not | Recorded as an explicit **downstream dependency** in *Recovery boundary*; this ADR states plainly that it does not validate any provider |
| **`Proposed` is treated as `Accepted`** | Work depends on a decision not in force — the `IR-1` gate-bypass failure | Status is stated in the header table, in a callout, and in the `DG-2` section. `DD-3` and `DDM-1` are deliberately **not** discharged by this draft |
| **Managed operation costs more than "modest"** | A Medium-weighted criterion is breached after the fact | The posture is reversible to self-managed without touching the domain model; the assumption is recorded above as falsifiable |
| **Schema decisions creep in during implementation** and settle `DDM-*` silently | Questions the product owner was never asked get answered in code | *Open questions this decision must NOT answer* names them; `IP-9` requires a new ADR whenever implementation forces a decision the chain did not make |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **The named provider** (deferred by owner ruling, 2026-08-23) | The Decision selects a **technology** and a **posture** only. No vendor or service is named anywhere in this document, and none may be inferred |
| **`OQ-4`** — keyword-search field scope and matching mode (`FR-SRCH-02`) | No search scope, matching mode, or text-search configuration is chosen. The candidate was assessed as spanning the plausible outcome space; that is evidence, not a decision |
| **`DDM-1`** — beyond the engine | The engine is selected; **the service and the vendor are not**, and `DDM-1` is not discharged by this ADR |
| **`DDM-2`** — identity strategy | No identity representation is named. The logical requirement remains only that identity be stable and content-independent (`DI-8`) |
| **`DDM-3`** — category representation (`OQ-5` open) | No representation of the category set is chosen |
| **`DDM-4`** — indexing and text-search strategy | No index and no text-search strategy is selected. `ADR-007` still owns the search approach, and still requires *measured* justification for a dedicated index |
| **`DDM-5`** — location normalization | No representation of locality, administrative area, country, or postal code is chosen |
| **`DDM-6`** — physical separation of non-public attributes | No representation of the `S-2` boundary or of per-contact public-display designations is chosen |
| **`DDM-7`** — audit-entry storage (`OQ-14` open) | No audit storage location or shape is chosen. Whether `E5` exists at all is not this decision's to settle |
| **`DDM-8`** — revision storage and the effective public version | No revision representation is chosen. `DI-10` and `DI-11` are stated as invariants the store must be able to enforce, not as a physical design |
| **`DDM-9`** — soft versus hard delete, publication state, and purge representation | No representation is chosen. `OQ-11` and `OQ-13` are settled product questions; their physical form is not |
| **`DDM-10`** — migration and schema-evolution tooling | No tooling is selected. It is outside a product decision entirely |
| **`ADR-002`** — application language and framework | No language, framework, ORM, or data-access library is named or implied |
| **`ADR-005`** — hosting platform and runtime model | The **store's** operating posture is decided; the **application's** hosting platform and runtime model are not, and the rejected function-per-capability decomposition is not reopened |
| **`ADR-004` / `NOQ-9`** — administrator authentication mechanism | No authentication mechanism, credential policy, or identity store is chosen. `DD-4` remains open |
| **`ADR-012`** — testing strategy and tooling | No test tooling is selected. Testability was assessed as evidence against hard requirement 6 only |
| **The backup mechanism** (`DD-9`, `ADR-010`) | `ADR-010` states that the mechanism is not selected, and this ADR selects none. Native capability is cited as **evidence of eligibility**, not as an implementation choice |
| **`DG-2` closure scope** | Only undisputed facts are stated: `DG-2` is Unresolved and other technology decisions remain. The repository's ambiguity about exact closure accounting is recorded and left for separate resolution |
| **`NOQ-1`, `NOQ-4`** — performance thresholds and expected load | No threshold or load figure is asserted or invented. Both are carried as `PA-1` |

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-DATA-01`–`NFR-DATA-06`; `NFR-REL-04`; `NFR-SEC-08`; `NFR-PRIV-03`; `NFR-BACK-01`–`NFR-BACK-06`; `NFR-OPS-01`, `NFR-OPS-04`; `NFR-MAINT-03`; `NFR-SCALE-03`; `FR-SRCH-01`, `FR-SRCH-04`, `FR-SRCH-05`, `FR-SRCH-06`; `FR-AUD-01`; `FR-ADM-10b` |
| **Journeys** | `V2`–`V4`, `V6` (browse, search, filter over approved listings); `L2` (submission); `A4`, `A5` (moderation) |
| **Components** | `C6` — the only component that writes lifecycle status; the read/write path separation `docs/07` describes |
| **Invariants** | Must not breach: `BI-1`, `BI-4`, `BI-6`, `BI-8`; `DI-1`, `DI-2`, `DI-3`, `DI-5`, `DI-8`, `DI-10`, `DI-11` |
| **Decisions** | `DD-3` (**not discharged** — this ADR is `Proposed`); `DDM-1` (**not discharged**); `DG-2` (**Unresolved**); hard requirements 3, 4, 5; `NOQ-2`, `NOQ-3`/`R1` |
| **Related ADRs** | `ADR-001` (Accepted — the boundary and `R-10`); `ADR-006` (Accepted — the model judged against); `ADR-010` (Accepted — the recovery-capability filter, *feeds* this ADR); `ADR-002`, `ADR-005`, `ADR-007`, `ADR-012` (open, and not decided here) |
| **Documents amended** | `docs/adr/README.md`, `docs/07-system-architecture.md`, `docs/12-implementation-plan.md`, `docs/traceability-matrix.md`, `docs/08-data-model.md` — **lifecycle status only.** `DD-3` and `DDM-1` are **not** marked discharged, because a `Proposed` ADR is not in force |
| **Issue / pull request** | Issue #81 — `architecture: decide MVP data-store product in ADR-003`. Pull request #82 — `docs: propose ADR-003 PostgreSQL datastore decision` |
