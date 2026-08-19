# Traceability matrix

> **Requirement (`docs/05`, `docs/06`) → journey (`docs/04`) → operation (`docs/09`) /
> screen (`docs/10`) / entity (`docs/08`) → issue → branch → pull request → test
> (`docs/11`) → merge.**

This matrix makes the chain above **legible in both directions** and keeps it honest as work
is added. It is established under issue #31 (`P0a`) and **seeded only from the approved,
merged chain** `docs/01`–`docs/13` and `ADR-001`. No application work has started, so the
downstream columns (issue, pull request, test) are **deliberately empty** — and that emptiness
is itself the record: it shows exactly how much of the chain is not yet built.

**This document is a derivation with no independent authority.** It **adds no requirement and
removes none.** Where it appears to conflict with the chain (`docs/01`–`docs/13`), **the chain
wins and this matrix is wrong.** A matrix cell that names a field, a default, an ordering, a
retention period, or a test that does not exist has **silently answered a question the product
owner was never asked** — that is a defect in this document, not a fact about the system
(`IR-1`, reviewer responsibility #2). Where the chain left a **seam**, the cell records the
**seam**, not a guess.

**It is technology-neutral.** No language, framework, data store, hosting platform, test
runner, CI system, or authentication mechanism appears here, and none may be added. That
choice is `DG-2`, and `DG-2` is open.

---

## The update obligation

**This matrix is maintained as part of `P0a` and updated in the pull request that changes it —
never reconstructed at release, when it would be archaeology** (`docs/12`, *Traceability
expectations*; `IP-9`). A pull request that adds an issue, a test, an ADR, or a merged change
without updating the row it touches has broken the chain, and the reviewer's job is to catch
it (`IR-5`, `IR-9`). See *Maintenance* at the foot of this document.

---

## How to read it

The matrix has **four views**, each answering a different question, plus **supporting
registers** the four views point into.

| View | Answers | Direction |
|---|---|---|
| **1 — Forward** | "Given this requirement, where is it built and proven?" | requirement → downstream |
| **2 — Backward** | "Given this change, what requirement or decision justified it?" | change → requirement |
| **3 — Invariants** | "Which test attacks this boundary or integrity rule?" | invariant → test |
| **4 — Open questions** | "Which gate holds this question, and what does it block?" | question → gate → work |

### Status vocabulary

The distinctions below are load-bearing. **Conflating *excluded* with *blocked* is how a
missing decision quietly becomes a missing feature, permanently** (`docs/12`, *Deferred
implementation areas*).

| Status | Meaning |
|---|---|
| **Committed** | Approved and in the MVP. Will reach at least one issue. |
| **Blocked** | *Would* be built, but a product decision is unmade. Named with the gate/question that holds it. **Not** the same as excluded. |
| **Conditional** | Built **only if** an open question resolves a particular way; its absence is then recorded as a decision (`IP-7`). |
| **Deferred** | Consciously **not** built for the MVP and **not** needed for it. Not waiting on anyone. |
| **Excluded** | Out of scope by `docs/03` — not deferred, *excluded*. |
| **Pending** | The downstream artifact (issue, PR, test) does **not exist yet**. An empty cell is honest; a filled aspirational one is a lie the release will rest on. |

### The gate classification is preserved, not softened

Every open question in View 4 is marked **hard blocker** or **shaping input** — the
distinction from `docs/12`/`docs/13`, carried here unchanged:

- **Hard blocker** — the work is *impossible to do honestly* without the answer. Proceeding
  means guessing, and the guess silently becomes the answer. Work does not start.
- **Shaping input** — the work is *possible but under-informed*. It is **considered and
  consciously carried as a stated assumption**, not resolved by default, and revisited the
  moment it is answered. **A shaping input is not permission to proceed casually.**

### Why the downstream columns are empty

`P0a` (process foundation) is the only work done; `P0b` and everything after are blocked by
`DG-2` (technology) and `DG-1` (data design). **No entity, field, operation, screen, or test
exists yet.** Every "Issue · PR · Test" cell below therefore reads *pending*. When application
work begins, the issue that builds a row fills that row's downstream cell **in the same pull
request**.

---

## View 1 — Forward traceability

### 1a. Functional requirements → journeys, surface, and the questions they wait on

Grouped by requirement family; **every `FR-*` identifier is named** so nothing is silently
dropped. Priorities and decision dependencies are taken from `docs/05`. Phase is **derived**
from the journey/surface each family serves (`docs/12` phase table) and carries no authority of
its own.

| FR family (all IDs) | Journeys (`docs/04`) | Surface · phase (derived) | Blocked / shaping question | Status | Issue · PR · Test |
|---|---|---|---|---|---|
| **FR-VIS-01…10** (visitor browse/view) | V1, V5, V6, V7 | Public read · **P2** | `OQ-3` (ordering); ~~`OQ-7`~~ **Decided** (public fields), ~~`OQ-11`~~ **Decided** (`FR-VIS-08` trigger — *not currently publicly available, for any reason*; **generic** result, unpublished listings included) | **Public read path now serves the approved public projection** (`FR-DATA-11`/`11b`/`11c`, `docs/08` *Field classification*); **VIS-10 Deferred** (`OQ-1`); rest Committed | pending |
| **FR-SUB-01…09** (listing submission) | L1–L4 | Public write · **P3** | `OQ-9` (anti-spam); ~~`OQ-8`/`OQ-8b`~~ **Decided** (submission obligations) | **Submission obligations Committed** (`OQ-8`): `FR-SUB-02` presents the required-at-initial-submission set — name, category, description, locality, country — distinctly from the five optional fields; `FR-SUB-05` accepts a submission omitting **all** optional fields, **including every contact method**. **SUB-08 Deferred** (`OQ-2`); **SUB-09 Blocked** (`OQ-9`); rest Committed | pending |
| **FR-ADM-01…13** (administrator actions, incl. `FR-ADM-10b`) | A1–A7 | Administrative · **P4** | `OQ-12` (duplicates); ~~`OQ-10`~~, ~~`OQ-8`/`OQ-8b`~~, ~~`OQ-11`~~ **Decided** (`FR-ADM-12` — unpublish **and** republish Committed, **raised to Must**) | **Administrator completion Committed** (`OQ-8` — settles **C-7**): `FR-ADM-04` — an administrator may complete missing optional information and correct submitted information during moderation before approval, **validated identically to a public submission; never a bypass**. `FR-ADM-06` — approval permitted only where every before-approval obligation holds, **including the contact minimum**. **Revision lifecycle Committed** (`OQ-10`): `FR-ADM-10` **Must** — pending revision, approved listing stays public, approval makes the revision the effective public version, rejection leaves it unchanged; `FR-ADM-10b` **Must** — safeguarded atomic administrator operation. **ADM-12/13 Blocked/Conditional**; rest Committed | pending |
| **FR-SRCH-01…09** (search & filter) | V2, V3, V4, V6 | Public read · **P2** | `OQ-4` (search scope), `OQ-5` (category model); ~~`OQ-6`~~ **Decided** (location granularity) | **SRCH-02/09 Blocked** (`OQ-4`,`OQ-5`); rest Committed | pending |
| **FR-DATA-01…11** (listing data, incl. `FR-DATA-06b/06c`, `FR-DATA-11b/11c`) | Data; V3–V5 | Data · **P1** | `OQ-5`; ~~`OQ-6`~~, ~~`OQ-7`~~, ~~`OQ-8b`~~ **Decided** | **Location fields Committed** (`OQ-6`): `FR-DATA-04` locality **required**, `FR-DATA-06` country **required**, `FR-DATA-05` administrative area **optional**, `FR-DATA-06b` postal code **optional**, `FR-DATA-06c` street address **not collected**. **Public projection Committed** (`OQ-7`): `FR-DATA-11`, `FR-DATA-11b` classification, `FR-DATA-11c` business-designated contact visibility. **Contact minimum Committed** (`OQ-8b`): **`FR-DATA-08` now `Must`** — at least one **usable** phone, email, or website **before approval**, never at initial submission; location is not contact; **no offline-business exemption**. `FR-DATA-07` unchanged — each contact field stays individually optional. Rest Committed | pending |
| **FR-VAL-01…06** (validation) | L2, L3, A3, A6 | Public write / admin · **P3** | ~~`OQ-8`/`OQ-8b`~~ **Decided** (rule set) | **Rule set Committed** (`OQ-8`/`OQ-8b`): **`FR-VAL-05` now `Must`, rewritten** — required at initial submission, required when supplied, required before approval; **permissive, international-friendly, technology-neutral** formats with no pattern, library, widget, schema type, or constraint prescribed. `FR-VAL-01` applies the submission-stage rules; `FR-VAL-03` preserves supplied-but-invalid values (never silently dropped); **`FR-VAL-04` preserved as the bridge to revisions** (`VR-6`). Behavior Committed as before | pending |
| **FR-MOD-01…08** (moderation) | A4, A5, A7; boundaries | Administrative · **P4** | `OQ-15` (escalation); ~~`OQ-11`~~ **Decided** | **MOD-06 Committed** (`OQ-11` — abuse-in-public resolved by unpublishing; **raised to Must**), **MOD-08 Deferred** (`OQ-15`); rest Committed | pending |
| **FR-AUTH-01…04** (access control) | Cross-cutting; A1–A7 | Boundary · **P1/P4** | mechanism deferred (`DD-4`, `NOQ-9`) | Committed (boundary); mechanism → `ADR-004` | pending |
| **FR-ERR-01…06** (error/empty states) | V1, V6, L1–L3, A1 | Cross-surface · **P2–P4** | — | Committed | pending |
| **FR-CONF-01…04** (confirmations) | L4, A4, A5, A6 | Public write / admin · **P3/P4** | — | Committed | pending |
| **FR-ACC-01…05** (accessibility/responsive) | All core flows | Cross-cutting · **P2 onward** | `NOQ-5` (conformance *claim* only) | Committed (behaviors); **claim Blocked** (`NOQ-5`) | pending |
| **FR-AUD-01…06** (status & auditability) | Data; A4, A5, A6 | Data / admin · **P1/P4** | `OQ-14`+`NOQ-8` (audit log); ~~`OQ-13`~~ **Decided** (rejected retention) | **AUD-05 Conditional** (`OQ-14`/`NOQ-8`); **AUD-06 Committed and raised to Must** (`OQ-13` — retain 90 days from rejection, then purge as a system obligation); rest Committed | pending |

**Deferred and blocked functional requirements, named explicitly** (so their absence reads as
a decision, per acceptance criterion): `FR-VIS-10` (deferred — `OQ-1`), `FR-SUB-08` (deferred —
`OQ-2`), `FR-SUB-09` (blocked — `OQ-9`), `FR-ADM-13` (blocked — `OQ-12`), `FR-SRCH-02` (shaped — `OQ-4`), `FR-SRCH-09` (blocked
— `OQ-5`), `FR-MOD-08` (deferred — `OQ-15`), `FR-AUD-05` (conditional — `OQ-14`/
`NOQ-8`). *(`FR-ADM-12`, `FR-MOD-06`, and `FR-VIS-08` left this
list on 2026-08-04: `OQ-11` is **Decided** and all three are now **Committed** and **Must**.
`FR-AUD-06` left it the same day: `OQ-13` is **Decided**, and it is **Committed** and
**Must**, as is `NFR-PRIV-05`.)*

### 1b. Non-functional requirements → where they land, and what they wait on

Every `NFR-*` identifier is named. "Where it lands" is from `docs/06`–`docs/08`; the shaping/
blocking question is from `docs/06`'s own NFR→NOQ mapping.

| NFR family (all IDs) | Where it lands | Blocked / shaping question | Status | Issue · PR · Test |
|---|---|---|---|---|
| **NFR-PERF-01…06** | `DD-12`; measurement | `NOQ-1`, `NOQ-4` (shaping) | **Blocked** — no threshold asserted (`docs/11` Cat. 3) | pending |
| **NFR-REL-01…06** | `DD-8`; error states | `NOQ-2` — **Decided** | REL-03/04/06 Committed; **target Decided** (`NOQ-2`, 2026-07-30): 99% over a rolling monthly window, announced maintenance excluded, public read path prioritised over admin | pending |
| **NFR-SEC-01…08** | `C8`, `C7`; `BI-5` | `OQ-9` (SEC-06), `NOQ-9` (SEC-07) | Committed; SEC-06 **Blocked** (`OQ-9`), SEC-07 **Blocked** (`NOQ-9`) | pending |
| **NFR-PRIV-01…05** | `S-2` (**resolved**), `DI-5`; `BI-6` | ~~`OQ-13`~~ **Decided** (PRIV-05); ~~`OQ-7`~~ **Decided** (PRIV-01/02) | Committed (rule); **field set Committed** (`OQ-7` — `docs/08` *Field classification*); **retention Committed and PRIV-05 raised to Must** (`OQ-13` — 90 days from rejection, documented purpose) | pending |
| **NFR-ACC-01…05** | Core-flow UI | `NOQ-5` (ACC-04/05) | Committed (behaviors); **level Blocked** (`NOQ-5`) | pending |
| **NFR-USA-01…06** | UI messaging | — | Committed | pending |
| **NFR-RESP-01…04** | Responsive layout | `NOQ-6` (RESP-03) | Committed (behavior); **matrix Blocked** (`NOQ-6`) | pending |
| **NFR-MAINT-01…05** | Codebase, tests, config | `DG-2` (tooling) | Committed; test tooling → `DG-2` | pending |
| **NFR-OBS-01…06** | `C12`; `DD-13` | `NOQ-7` (OBS-06), `OQ-14`/`NOQ-8` (OBS-05) | Committed; OBS-05 **Conditional**, OBS-06 retention **Blocked** (`NOQ-7`) — exclusion rule **not** deferred | pending |
| **NFR-DATA-01…06** | `DI-1`–`DI-7` | — | Committed | pending |
| **NFR-BACK-01…06** | `DD-9`; store capability | `NOQ-3` — **Decided** | Committed; **RPO/RTO Decided** (`NOQ-3`, 2026-07-30): daily backups, RPO ≤ 24 h, RTO 1 business day, ~~≥ weekly off-provider copy~~ off-provider copy **no more than 24 h behind the live data** (`NFR-BACK-06`, **amended R1, 2026-08-18** — the 24 h RPO covers provider loss), equal confidentiality for all copies | pending |
| **NFR-SCALE-01…04** | `PA-1`; `DD-12` | `NOQ-1`, `NOQ-4` (shaping) | **Blocked/shaped** — carries `PA-1` ("small") | pending |
| **NFR-COMP-01…04** | Supported matrix | `NOQ-6` | Committed (behavior); **matrix Blocked** (`NOQ-6`) | pending |
| **NFR-OPS-01…05** | Operational procedures | — (carries `PA-1`–`PA-3`) | Committed | pending |

### 1c. Journeys, operations, and screens — the middle of the chain

Seeded catalogs the forward views point through. All downstream **pending**.

**Journeys (`docs/04`).** Visitor: **V1** browse · **V2** search · **V3** filter by category ·
**V4** filter by location · **V5** view details · **V6** no-results · **V7** inaccurate content.
Lister: **L1** open form · **L2** submit · **L3** correct errors · **L4** confirmation. Admin:
**A1** view queue · **A2** review · **A3** edit · **A4** approve · **A5** reject · **A6** update
existing · **A7** handle problematic content.

| Operation (`docs/09`) | Serves | Phase | Screen (`docs/10`) | Test |
|---|---|---|---|---|
| `OP-1` retrieve approved listings | V1, V2 | P2 | `S1` Directory | pending |
| `OP-2` retrieve one approved listing | V5 | P2 | `S2` Listing detail | pending |
| `OP-3` submit a listing request | L1–L3 | P3 | `S3` Request form | pending |
| `OP-4` retrieve pending queue | A1 | P4 | `S5` Pending queue | pending |
| `OP-5` retrieve one record for review | A2 | P4 | `S6` Record detail | pending |
| `OP-6` edit a record's content | A3 | P4 | `S7` Record edit | pending |
| `OP-7` approve a pending submission | A4 | P4 | `S6` | pending |
| `OP-8` reject a pending submission | A5 | P4 | `S6` | pending |
| `OP-9` unpublish/republish *(committed — `S-5` resolved for `OQ-11`)* | A6, A7 | P4 | `S6` | pending |
| `OP-10` approve a pending revision *(committed — `S-5` resolved for `OQ-10`)* | A6 | P4 | `S7` | pending |
| `OP-11` retrieve the category set | V3, L1 | P2 | `S1`, `S3` | pending |
| `S4` Submission confirmation | L4 | P3 | (screen) | pending |

---

## View 2 — Backward traceability

**Every issue and every merged pull request names the requirement — or the decision — it
serves. Nothing is silently added; that is how out-of-scope features actually get built, not
by decision but by drift** (`IR-5`).

Seeded with the **`P0a` process foundation**, which is real and merged. This work serves
`docs/12` process requirements (`PA-5`, the working agreements, `IP-*`), **not** a functional
requirement — process work has no `FR-*`, and recording it here as serving the plan is the
honest backward link. **The issue number and the pull-request number are not the same number**
(`CONTRIBUTING.md`, *Commits*); both are shown.

| Issue | Branch | PR | Serves (justification) | Landed on `main` |
|---|---|---|---|---|
| #25 working agreements | `docs/…` | #33 | `PA-5`, review workflow (`docs/12`) | `bceac13` |
| #30 decision log | `docs/…` | #34 | `DG-1`–`DG-4` visibility (`IR-1`) | `19f24d6` |
| #28 ADR directory & template | `docs/…` | #35 | ADR foundation (`docs/07`) | `370dddb` |
| #29 `ADR-001` (Option A) | `docs/…` | #36 | Ratify architecture shape (`PA-4`, `IR-6`) | `f05bac2` |
| #26 issue template | `docs/26-…` | #37 | `IP-4` enforcement | `3fc81a7` |
| #27 pull-request template | `docs/27-…` | #38 | `IP-9`, DoD, review focus | `c2883bf` |
| **#31 traceability matrix** | `docs/31-traceability-matrix` | *pending* | `docs/12` *Traceability expectations*, `IR-5` | *pending* |
| #32 branch protection | *pending* | *pending* | `PA-5` (owned by issue #32, **not here**) | *pending* |

**Application (`P1`+) issues will be appended to this view as they are opened** — each naming
the `FR-*`/`NFR-*`/journey it serves, so the backward direction holds from the first line of
application code. Until `DG-1` and `DG-2` open, there are none to add.

---

## View 3 — Invariants and the tests that attack them

**Every `BI-*` and `DI-*` names the test that attacks it. An invariant with no attacking test
is an invariant with no evidence.** The test column is **pending** for all — no test exists
yet, and an empty cell here is honest (`DG-4` must not be pre-answered with an aspirational
test). The standard, when the cell is filled, is *"we tried to break it and could not"* —
proven **at the level where the invariant is enforced** (the operation, not the UI — `BI-9`,
`IP-5`), not merely "the test passes."

### Boundary invariants (`docs/11`)

| ID | Invariant | Source requirement | Enforced at · phase | Attacking test |
|---|---|---|---|---|
| `BI-1` | Approved-only public visibility | `FR-VIS-02`, `DI-5` | `C4` public projection · **P2** | pending |
| `BI-2` | Public write cannot produce an approved record | `FR-AUD-04`, `DI-4` | `OP-3` · **P3** | pending |
| `BI-3` | Search scope never exceeds publication scope | `FR-SRCH-*` (scope) | `C4` · **P2** | pending |
| `BI-4` | No public output discloses a non-approved record's existence | `NFR-SEC-02` | Public surface · **P2** — **its own issue** (equivalence test) | pending |
| `BI-5` | No administrative capability without an authorized identity | `NFR-SEC-01/02` | `C8` · **P4 (first)** | pending |
| `BI-6` | Administrative data never appears publicly | `FR-DATA-11`, `FR-DATA-11b`, `NFR-PRIV-01/03` | Public projection (field set Decided — `OQ-7`) · **P2/P4** | pending |
| `BI-7` | Publication is atomic, never partial | `NFR-DATA-03`, `DI-3` | `C6` · **P1** | pending |
| `BI-8` | Exactly one valid status, changed only by permitted transition | `NFR-DATA-01/02`, `DI-1/2` | Status model · **P1** | pending |
| `BI-9` | The UI is not the boundary | `docs/07` | All operations · **all phases** | pending |

> **`BI-4` is the hardest to test and the easiest to skip** — its failure is an *absence*.
> It requires an **equivalence test** proving *never existed*, *pending*, *rejected*, and
> *removed* are indistinguishable to an unauthorised observer (message, count, shape, timing).
> It is **its own issue**, always, and warrants a second reviewer (`IR-4`).

### Data-integrity invariants (`docs/08`)

| ID | Rule | Source | Phase | Test |
|---|---|---|---|---|
| `DI-1` | Exactly one status at all times | `NFR-DATA-01`, `FR-AUD-01` | P1 | pending |
| `DI-2` | Status changes only via permitted transition | `NFR-DATA-02` | P1 | pending |
| `DI-3` | Every action completes fully or not at all (never partially public) | `NFR-DATA-03` | P1 | pending |
| `DI-4` | Administrative attributes settable only by system/admin | `FR-AUD-04`, `NFR-DATA-04` | P1 | pending |
| `DI-5` | No non-approved record reachable through any public path | `FR-VIS-02`, `NFR-PRIV-03` | P1/P2 | pending |
| `DI-6` | `submitted at` write-once; `last updated at` on every change | `FR-AUD-02/03`, `NFR-DATA-05` | P1 | pending |
| `DI-7` | Stored data reflects last successful action; no silent loss | `NFR-DATA-06` | P1 | pending |
| `DI-8` | Identity stable for the record's whole life | `docs/08` (`DDM-2` physical) | P1 | pending |
| `DI-9` | Category value always a member of the predefined set | `FR-DATA-10`, `FR-DATA-02` | P1 | pending |

---

## View 4 — Open questions → gate → work

**Every open question is traceable to the gate that holds it and the work it blocks.** Seeded
from `docs/13-decision-log.md`, which is the live register; this view mirrors it and **answers
nothing**. Classification is carried unchanged — a hard blocker is not softened to unblock
work, and a shaping input is not overstated into a block.

| Question | Gate | Class | Blocks / shapes | Status | Lands in |
|---|---|---|---|---|---|
| `OQ-6` location fields & granularity | `DG-1` | **Hard blocker** | All of `P1` (backfill risk) | **Decided (2026-07-31)** — locality **required**, country **required** (multi-country from launch), administrative area **optional**, postal code **optional** (international text), street address **not collected** | `S-6` (**resolved**), `ADR-006`; `docs/13` `DG-1`; `docs/03`, `docs/05` `FR-DATA-04/05/06/06b/06c`, `docs/08` `E1` |
| `OQ-7` public vs private field projection | `DG-1` | **Hard blocker** | `P1`, `P2` — the public projection | **Decided (2026-07-31)** — public: name, category, description, locality, country, administrative area where provided, postal code where provided and designated public, and business-designated public contact methods; all other fields administrator-visible or audit-only | `S-2` (**resolved**), `ADR-006`; `docs/13` `DG-1`; `docs/03`, `docs/05` `FR-DATA-11/11b/11c`, `docs/06` `NFR-PRIV-01/02`, `docs/08` *Field classification* |
| `OQ-8` / `OQ-8b` required fields; contact minimum | `DG-1` | **Hard blocker** | `P3` validation *rules* | **Decided (2026-08-03)** — **required at initial submission:** name, category, description, locality, country; **optional at initial submission:** administrative area, postal code, phone, email, website. **Before approval:** at least one **usable** contact method (phone, email, or website) — **locality and address never count**, and there is **no offline-business exemption**. "Usable" = non-blank, passes the permissive checks, retained as proposed — **structural, not verified as owned or reachable**. Formats are **permissive, international-friendly, technology-neutral**; no pattern, library, widget, schema type, or constraint prescribed. A supplied-but-invalid optional value **fails visibly and is preserved**, never silently dropped. An administrator may **complete and correct** during moderation **without bypassing validation** (settles **C-7**); the contact minimum settles **C-6**. Revisions follow the same rules; **failed validation leaves the approved listing unchanged**. **No field added; `OQ-7` projection unchanged** | `S-1` (**resolved**), `VR-S1`/`VR-S2`/`VR-S3` (**filled**), `ADR-006` (**still Blocked**); `docs/13` `DG-1`; `docs/03`, `docs/05` `FR-SUB-02/05`, `FR-ADM-04/06`, `FR-DATA-07/08`, `FR-VAL-01/03/04/05`, `docs/06` `NFR-PRIV-04`, `docs/08` `VR-S1`–`VR-S3`, `docs/10` `UV-5`/`UV-8` |
| `OQ-10` edit-after-approval | `DG-1` | **Hard blocker** | `P1` (`E7`), `OP-10` | **Decided (2026-08-02)** — an approved listing stays publicly visible at its last approved version; a proposed change is a **pending revision** that is never public (`DI-10`); approval makes it the effective public version; rejection leaves the approved listing unchanged; **at most one pending revision per listing** (`DI-11`), history unrestricted; an authorized administrator may create and approve a revision in **one atomic authorized operation** with all safeguards enforced (`FR-ADM-10b`). **No listing status added**; storage mechanism remains `DDM-8` | `S-5` (**resolved for `OQ-10`**; open for `OQ-11`), `ADR-006` (**still Blocked**); `docs/13` `DG-1`; `docs/05` `FR-ADM-10`/`FR-ADM-10b`, `docs/08` `E7`/`DI-10`/`DI-11`, `docs/09` `OP-6`/`OP-10`, `docs/10` `S7` |
| ~~`OQ-11`~~ removal / unpublish | `DG-1` | **Hard blocker** | `P1` publication model, `OP-9` | **Decided (2026-08-04)** — an authorized administrator may **unpublish** an approved listing and **republish** it; unpublishing is **reversible**, requires a **current reason** and **explicit confirmation**, and excludes the listing from **every** public read path, a direct link returning the **generic** unavailable result; the listing stays **administratively visible**; a **pending revision stays pending** and approving it while unpublished **does not republish**; republishing exposes the **current** approved version; **permanent deletion excluded from the MVP**; **public removal requests out of scope**; **`FR-AUD-01` unchanged** — publication state is a **separate product concept**, **no fourth status**, no new status transition; representation deferred to `ADR-006`/`DDM-9` | `S-5` — **resolved**; `ADR-006` — **no longer blocked by this** |
| ~~`OQ-13`~~ rejected-record retention and purge | `DG-1` | **Hard blocker** | `P1` (`S-11`), purge obligation | **Decided (2026-08-04)** — rejected **initial submissions** and rejected **approved-listing revisions**, one uniform rule: retained **90 days from rejection**, **administrator-visible only** (including the current rejection reason), never public and no submitter view, **terminal** (not editable, not re-approvable — `NFR-DATA-02` gains no transition), then **purge-eligible** (visibility unchanged until purged) and **purged as a committed system obligation** — all-or-nothing, idempotent, never altering an approved listing. Rejected revisions stay non-public, leave the approved listing unchanged, and do not breach `DI-11`. **Excluded:** unpublished approved listings, the resubmission workflow, category-specific retention. Backups: live-product purge, pre-purge copies may persist under `NFR-BACK-04`, restoration must not silently reactivate. Audit events remain `OQ-14`/`NOQ-8`. **`FR-AUD-06` and `NFR-PRIV-05` raised to Must; no new identifier created**; representation remains `ADR-006`/`DDM-8`/`DDM-9` | `S-11` — **resolved**; `ADR-006` — **unblocked** |
| `OQ-4` searchable fields & matching mode | `DG-1` | *Shaping input* | Search *scope* (`BI-3` built regardless) | Unresolved | `S-4`, `ADR-007` |
| `OQ-5` category model — cardinality, curation | `DG-1` | *Shaping input* | `S-3` representation (membership enforced regardless) | Unresolved | `S-3` |
| `NOQ-2` availability target | `DG-2` | **Hard blocker** | Store & hosting selection | **Decided (2026-07-30)** | `ADR-003`, `ADR-010` |
| `NOQ-3` backup / RPO / RTO | `DG-2` | **Hard blocker** | Store selection (capability) | **Decided (2026-07-30)** | `ADR-003`, `ADR-010` |
| Technology stack | `DG-2` | **Hard blocker** | `P0b` and everything after | Unresolved | `ADR-002`–`ADR-005` |
| `NOQ-1` performance thresholds | `DG-2` | *Shaping input* | Informs tech selection; carried as `PA-1` | Unresolved | — |
| `NOQ-4` expected first-release load | `DG-2` | *Shaping input* | As `NOQ-1`; first to revisit if `PA-1` wrong | Unresolved | — |
| `OQ-9` anti-spam behavior | `DG-3` | **Hard blocker** | `P3` `C11` mechanism (seam built) | Unresolved | `S-9`, `ADR-008` |
| `OQ-14` + `NOQ-8` audit logging (one decision) | `DG-3` | **Hard blocker** | `P4` (`C10`, `E5`) — **irreversible if late** | Unresolved | `S-7`, `S-8`, `ADR-009` |
| `NOQ-9` admin credential & session strength | `DG-3` | **Hard blocker** | `P4` auth boundary | Unresolved | `ADR-004` |
| `NOQ-5` accessibility standard & level | `DG-3` | *Shaping input* **— answer early** | Conformance *claim* only (behaviors built regardless) | Unresolved | `ADR-011` |
| `NOQ-6` browser / device / AT matrix | `DG-3` | *Shaping input* | Support *claim* only | Unresolved | `ADR-011` |
| `NOQ-7` operational-log retention | `DG-4` | Release gate | Retention only (exclusion rule **not** deferred) | Unresolved | `DD-13` |
| Testing depth | `DG-4` | Release gate | Size of suite (Cat. 1 holds regardless) | Unresolved | — |
| Category 3 acceptance | `DG-4` | Release gate | The release decision | Unresolved | `docs/11` Cat. 3 |
| `OQ-1` visitor report-inaccuracy path | — | **Deferred** | Nothing (`V7` view-only) | Deferred | — |
| `OQ-2` lister outcome notification | — | **Deferred** | Nothing in MVP (`DD-16`) | Deferred | — |
| `OQ-3` default ordering | — | **Deferred** | Nothing (built *consistent*) | Deferred | — |
| `OQ-12` duplicate resolution | — | **Deferred** | Nothing structural | Deferred | `S-10` |
| `OQ-15` abuse escalation | — | **Deferred** | A human process | Deferred | — |
| `AQ-1` duplicate-submission behavior | — | **Deferred** | Undefined — exploratory charter | Deferred | — |
| `AQ-5` API versioning | — | **Deferred** | No scheme; one client | Deferred | — |

---

## Supporting registers

### Decision gates (`docs/13`)

| Gate | Subject | Status | Blocks |
|---|---|---|---|
| `DG-0` | Process | **Open** | Nothing — `P0a` proceeds |
| `DG-1` | Data design | Unresolved | All of `P1`; transitively `P2`–`P4` |
| `DG-2` | Technology | Unresolved | `P0b` scaffold and all of `P1` |
| `DG-3` | Build-time | Unresolved | `P3`, `P4`; verifiability of `P2` |
| `DG-4` | Release | Unresolved | The release decision, not the build |

**Every gate is owned by a role, not yet a person** (`docs/13`) — assigning a person to each
gate is the first maintenance action the decision log requires.

### ADR register (`docs/07`, `docs/adr/`)

| ADR | Decision | Status | Blocked by |
|---|---|---|---|
| `ADR-001` | Modular monolith; reject microservices & browser-direct | **Accepted** (issue #29) | — |
| `ADR-002` | Language & framework | Pending | `DG-2` (`DD-2`) |
| `ADR-003` | Data-store product | **Ready to write** — owner ruling 2026-08-19 (issue #75); **not drafted, not `Proposed`, not `Accepted`, not begun** | **Nothing** — ~~`NOQ-2`, `NOQ-3`~~ both **Decided** (`DD-3`); `NOQ-3` amended by **R1**. Recovery-capability filter supplied by Accepted [`ADR-010`](adr/ADR-010-backup-recovery-availability-posture.md). **No store, provider, or technology stack selected; `DG-2` remains Unresolved** |
| `ADR-004` | Administrator authentication mechanism | Pending | `NOQ-9` (`DD-4`) |
| `ADR-005` | Hosting platform & runtime model | Pending | `DG-2` (`DD-5`) |
| [`ADR-006`](adr/ADR-006-listing-data-model-and-lifecycle-states.md) | Listing data model & lifecycle states | **Accepted** — 2026-08-07 (issue #61) | **Nothing** — ~~`OQ-6/7/8/8b/10/11/13`~~ all **Decided**, `DG-1` **Resolved** (`DD-1`). **In force**; work may rely on it. Discharges `DD-1` **logically only**; `DDM-8` and `DDM-9` remain **unresolved** |
| `ADR-007` | Search approach | Pending | `OQ-4` (`DD-14`) |
| `ADR-008` | Anti-spam approach | Pending | `OQ-9` (`DD-6`) |
| `ADR-009` | Audit-logging approach | Pending | `OQ-14`/`NOQ-8` (`DD-7`) |
| [`ADR-010`](adr/ADR-010-backup-recovery-availability-posture.md) | Backup, recovery & availability posture | **Accepted** — 2026-08-19 (issue #69) | **Nothing** — ~~`NOQ-2`, `NOQ-3`~~ both **Decided**; `NOQ-3` amended by **R1**. **In force**; discharges `DD-8`, `DD-9`. Store and mechanism remain `ADR-003` |
| `ADR-011` | Accessibility standard, level & supported matrix | Pending | `NOQ-5`, `NOQ-6` |
| `ADR-012` | Testing strategy | Pending | — (`NFR-MAINT-03`, `R-6`) |

### Architecture components (`docs/07`)

| Component | Responsibility | Serves | Phase |
|---|---|---|---|
| `C1` Public Directory Interface | Public read UI | `FR-VIS-*`, `FR-SRCH-*` | P2 |
| `C2` Submission Interface | Public write UI | `FR-SUB-*` | P3 |
| `C3` Administrative Interface | Admin UI | `FR-ADM-*` | P4 |
| `C4` Directory Query Service | Public projection | `BI-1/3/4/6` | P2 |
| `C5` Submission Service | Accept submissions | `FR-SUB-*`, `BI-2` | P3 |
| `C6` Moderation Service | Lifecycle transitions | `FR-MOD-*`, `BI-7/8` | P4 |
| `C7` Validation Rules | Field/format validation | `FR-VAL-*` | P3 |
| `C8` Identity & Access | Auth boundary | `FR-AUTH-02`, `BI-5` | P4 |
| `C9` Listing Repository | Persistence | `E1`, `DI-*` | P1 |
| `C10` Audit Recorder *(conditional — `OQ-14`/`NOQ-8`)* | Audit emission | `FR-AUD-05` | P4 |
| `C11` Abuse Safeguard *(conditional — `OQ-9`)* | Anti-spam | `FR-SUB-09` | P3 |
| `C12` Observability & Operations | Logs, health | `NFR-OBS-*` | P0b/P5 |

### Entities (`docs/08`)

| Entity | Status | Seam |
|---|---|---|
| `E1` Listing record | **Required** | — |
| `E2` Category | **Required** | `S-3` (representation) |
| `E3` Administrator | **Required; stored elsewhere** | — |
| `E4` Review action | **Seam** | `S-7` |
| `E5` Audit entry | **Conditional** | `S-8` (`OQ-14`/`NOQ-8`) |
| `E6` Submission-safeguard data | **Conditional** | `S-9` (`OQ-9`) |
| `E7` Listing revision | **Required** — committed by `OQ-10` | `S-5` (**resolved for `OQ-10`**) |

### Data-model seams (`docs/08`)

~~`S-1` submission obligations (`OQ-8/8b`)~~ **resolved — `OQ-8`/`OQ-8b` Decided** (`VR-S1`, `VR-S2`, `VR-S3` filled; obligations and validation posture fixed, **no field added and no constraint mechanism selected**) · ~~`S-2` public/private field designation (`OQ-7`)~~ **resolved — `OQ-7` Decided** ·
`S-3` category cardinality/curation (`OQ-5`) · `S-4` searchable attributes & matching (`OQ-4`) ·
~~`S-5` edit-after-approval / removal~~ — **fully resolved:** ~~`OQ-10`~~ **Decided** (`E7` committed, revision lifecycle defined, no fourth listing status) **and** ~~`OQ-11`~~ **Decided** (unpublish/republish committed as **publication state**, again **no fourth listing status**; `R-11`/`R-12` pending-revision interaction recorded) · ~~`S-6` location attributes (`OQ-6`)~~ **resolved — `OQ-6` Decided** ·
`S-7` review-data shape (`OQ-14` dependency) · `S-8` audit entries (`OQ-14`, `NOQ-8`) ·
`S-9` anti-spam data (`OQ-9`) · `S-10` duplicate representation (`OQ-12`) ·
~~`S-11` rejected retention & purge~~ — **resolved:** ~~`OQ-13`~~ **Decided** (90 days from rejection for both covered record types, then purge as a system obligation; representation still `DDM-9` — unresolved; `ADR-006` (Accepted) settles the logical lifecycle only). **A cell that fills a seam with a guessed field
has answered `DG-1` by the back door.**

### Deferred vs excluded (`docs/12`, `docs/03`)

- **Conditional / blocked (would be built, decision unmade):** `E5`, `E6`, audit
  emission, anti-spam mechanism, retention structures. Recorded against their questions above.
- **Committed by `OQ-10`:** `E7` listing revision, `OP-10` approve a pending revision, and the
  `S7` two-version view. **The revision *storage* mechanism remains `DDM-8` — open.**
- **Committed by `OQ-11`:** `OP-9` unpublish/republish, and the `S6` unpublish and republish
  capabilities with their required reason and explicit confirmation. **The *representation* of
  publication state remains `DDM-9` — open** (`ADR-006`, Accepted, settles the logical concept
  and selects no representation), and the control's form is undrawn.
- **Deferred (not built, not needed):** outcome notification (`OQ-2`, `DD-16`), report-
  inaccuracy path (`OQ-1`), API versioning (`AQ-5`), redundancy/caching/dedicated search index.
- **Excluded by `docs/03` (not deferred):** business-owner accounts, listing claiming, reviews,
  ratings, analytics, advertising, payments, events, social features, native apps, third-party
  API consumption. **These will not be built because they are not in the MVP** — not because a
  decision is pending.

### Implementation phases (`docs/12`)

| Phase | Delivers | Gate | Status |
|---|---|---|---|
| `P0a` | Working agreements, ADR foundation, `ADR-001`, decision log, **this matrix** | `DG-0` | **In progress** (only #31, #32 remain) |
| `P0b` | Scaffold, CI, deployment | `DG-2` | Blocked |
| `P1` | Entities, status machine, integrity invariants | `DG-1`, `DG-2` | Blocked |
| `P2` | Public browsing, the public projection | `P1`; `DG-1` | Blocked |
| `P3` | Listing submission workflow | `P1`; `DG-1`, `DG-3` | Blocked |
| `P4` | Administrative review workflow | `P1`; `DG-3` | Blocked |
| `P5` | Testing, hardening, release preparation | `P2`–`P4`; `DG-4` | Blocked |

---

## Maintenance

**The matrix is worthless the moment it goes stale, and stale is the default state of a
document nobody is obliged to touch.** Keep it true by updating it **in the pull request that
changes what it records** — never afterward (`IP-9`, `IR-9`).

1. **A new issue** → add a row to **View 2** naming the `FR-*`/`NFR-*`/journey it serves
   (backward link), and fill the **Issue** cell of the **View 1** row(s) it builds (forward
   link). An issue with no requirement reference does not merge (`IP-4`).
2. **A pull request** → record its number and the merged commit in **View 2**. Remember the
   **issue number and PR number differ**.
3. **A test that attacks an invariant** → fill the **Test** cell in **View 3** — only when the
   test genuinely exists, and only when it attacks the invariant **at the level it is enforced**
   (`BI-9`, `IP-5`). An aspirational test cell is a lie the release decision will rest on.
4. **An ADR merged** → update the **ADR register** status, and the rows whose decision it
   settles.
5. **An open question answered** → the answer lands in the **owning document** (`docs/03`–
   `docs/11`) and the **decision log** (`docs/13`); update **View 4** status, and unblock the
   requirement/seam rows the answer releases. **Do not record the answer here** — this matrix
   points at the decision, it does not hold it.
6. **A seam built out** → update `docs/08` and the entity/seam registers with the pull request
   that builds it (`IP-7`: a seam is an option, not an obligation).
7. **Never fill a cell with a guess.** A row that names a field, a default, an ordering, a
   retention period, or a status value has made a product decision. **Stop, and take the
   question to its owner** (`IR-1`, reviewer responsibility #2).

**The two directions are the whole point.** *Forward*: every approved requirement reaches an
issue, or is recorded here as deferred/blocked — nothing silently dropped. *Backward*: every
issue and merged pull request names what it serves — nothing silently added, which is how
out-of-scope features actually get built: not by decision, but by drift.

---

## Source

| Document | What this matrix takes from it |
|---|---|
| `docs/03-mvp-scope.md` | Excluded vs. in-scope; the scope fence. |
| `docs/04-user-journeys.md` | `V1`–`V7`, `L1`–`L4`, `A1`–`A7`. |
| `docs/05` / `docs/06` | `FR-*` / `NFR-*`, priorities, and their decision dependencies. |
| `docs/07-system-architecture.md` | Components `C1`–`C12`, deferred decisions `DD-1`–`DD-16`, ADRs. |
| `docs/08-data-model.md` | Entities `E1`–`E7`, integrity invariants `DI-1`–`DI-11`, seams `S-1`–`S-11`. |
| `docs/09-api-design.md` | Operations `OP-1`–`OP-11`. |
| `docs/10-ui-design.md` | Screens `S1`–`S7`. |
| `docs/11-test-strategy.md` | Boundary invariants `BI-1`–`BI-9`; what counts as evidence. |
| `docs/12-implementation-plan.md` | Phases, workstreams, the traceability obligation, `IP-*`, `IR-*`. |
| `docs/13-decision-log.md` | The gates, classifications, and open-question status (View 4). |
| `docs/adr/ADR-001-…` | The one accepted decision. |

**This matrix is a derivation. Where it conflicts with the chain, the chain wins and this
matrix is wrong.**
