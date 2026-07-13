# Decision log

> **A gate nobody owns is a gate that opens itself.**
> — `docs/12-implementation-plan.md`, `P0a`

This is the **live register** of every decision the project is waiting on. It is not a
summary of `docs/12-implementation-plan.md` and does not restate its reasoning; it is the
working instrument that makes an unanswered question **visible, owned, and costed** instead
of quietly answered by an engineer at four o'clock on a Friday (`IR-1` — *the most likely
failure of this plan, by a wide margin*).

**This log records questions. It answers none of them.** A proposed answer, a default, or a
"likely" value written into a cell **is** the answer, and closes a question the product owner
was never asked. If you find yourself filling in an *Outcome*, you are either recording a
decision that has actually been taken — with its reference — or you are making one.

**It is technology-neutral.** No language, framework, data store, hosting platform,
continuous-integration system, or deployment approach appears here, and none may be added by
this document. That choice is `DG-2`, and `DG-2` is open.

---

## How to use this log

- **Every gate has an owner.** Unowned gates are the failure this log exists to prevent.
- **Update it in the pull request that changes it** (`IP-9`) — never reconstruct it later.
- **When a question is answered:** set *Status*, record the *Outcome* with its reference (an
  ADR, or an amendment to the owning document), and unblock the work it held. The answer lives
  in the owning document; this log only points at it.
- **When a question is accepted as a risk instead of answered:** that is a distinct state, and
  it requires **a named person accepting it in writing** at `DG-4`. See *Release-accepted
  risks*.

### Status values

| Status | Meaning |
|---|---|
| **Unresolved** | No answer. The work behind it is **blocked or shaped** accordingly. This is the default, and today it is the state of everything below. |
| **Decided** | Answered by the product owner. *Outcome* names the decision and its reference. The owning document is amended in the same pull request. |
| **Deferred** | Consciously **not** answered for the MVP, and **not** needed for it. Distinct from unresolved: a deferred question is not waiting on anyone. Its absence is a decision, recorded as one. |
| **Accepted risk** | Not answerable — the target does not exist — and **released anyway**, with a **person's written acceptance** (`docs/11` Category 3, `DG-4`). Not a synonym for deferred, and not a place to hide an unanswered blocker. |

### Classification

| Class | Meaning |
|---|---|
| **Hard blocker** | The work is **impossible to do honestly** without the answer. Proceeding means guessing, and **the guess silently becomes the answer.** Work does not start. |
| **Shaping input** | The work is **possible but under-informed**. It must be **considered and consciously carried as a stated assumption** — not resolved by default — and revisited the moment it is answered. **A shaping input is not permission to proceed casually.** It is permission to proceed **with the cost written down**. |

**Conflating the two overstates the block** — and understating it is worse. The classification
below is taken from the plan's gate table and must not be softened to unblock work.

### On dates

**The plan commits to no dates** (`docs/12`), and this log does not invent any. *Needed by* is
therefore expressed as **the event that forces the decision** — the work that cannot start
until it is answered. That is a harder deadline than a calendar date, and an honest one.

---

## Gate summary

| Gate | Subject | Owner | Status | Blocks | Hard blockers | Shaping inputs |
|---|---|---|---|---|---|---|
| **`DG-0`** | Process | Maintainer — *assign* | **Open** | Nothing | — | — |
| **`DG-1`** | **Data design** | Product owner — *assign* | **Unresolved** | **All of `P1`**; transitively `P2`, `P3`, `P4` | 6 | 2 |
| **`DG-2`** | **Technology** | Product owner — *assign* | **Unresolved** | The **`P0b` scaffold** and all of `P1` | 2 | 2 |
| **`DG-3`** | **Build-time** | Product owner — *assign* | **Unresolved** | `P3`, `P4`, and the *verifiability* of `P2` | 3 | 2 |
| **`DG-4`** | **Release** | Product owner — *assign* | **Unresolved** | The **release decision**, not the build | — | — |

> **`DG-0` is open. Everything else is not.**
>
> **Until `DG-1` and `DG-2` clear, the only implementation work that can honestly proceed is
> the stack-neutral half of Phase 0 (`P0a`).** That is not a scheduling inconvenience to route
> around. It is the plan telling the truth.

**Owners are recorded by role, and the role is not a name.** `docs/02-stakeholders.md` names
no individual, and this log will not invent one. **Assigning a person to each gate is the
first maintenance action this document requires** — until then, every gate below is owned in
principle and unowned in practice, which is precisely the condition `IR-1` describes.

### Take these seven to the product owner first

`docs/07` identified them, and the plan carries them forward unchanged:

**`OQ-6` · `OQ-7` · `OQ-10` · `OQ-13` · `NOQ-3` · `OQ-9` · `NOQ-5`**

They span three gates. **`NOQ-5` is on the list despite being a shaping input** — it is the one
whose *cost* behaves like a blocker.

---

## `DG-1` — data design

**Blocks all of `P1`, and transitively `P2`, `P3`, and `P4`.** `docs/07` `DD-1` states the six
hard blockers outright: they **must be answered before data design starts.**

| ID | Question | Class | Status | Needed by | Blocks or shapes | Source | Outcome |
|---|---|---|---|---|---|---|---|
| `OQ-6` | **Location granularity?** | **Hard blocker** | Unresolved | **Before `P1` starts** | **All of `P1`.** Retrofitting means **backfilling every record** | `docs/08`; `docs/07` `DD-1` | — |
| `OQ-7` | **Public versus private fields?** | **Hard blocker** | Unresolved | **Before `P1` starts** | `P1` and `P2`. The **public projection** — the control `BI-6` and `NFR-PRIV-01/02` rest on. **Until it is answered, the privacy commitment is an empty promise** (`docs/07` `R-2`) | `docs/08` `S-2`; `docs/07` `DD-1` | — |
| `OQ-8` / `OQ-8b` | **Required submission fields; contact minimum?** | **Hard blocker** | Unresolved | **Before `P1` starts** | `P3` validation **rules** (`S-1`). The validation *behavior* is built regardless | `docs/08` `S-1`; `docs/07` `DD-1` | — |
| `OQ-10` | **Edit after approval — immediate, or secondary review?** | **Hard blocker** | Unresolved | **Before `P1` starts** | `P1` (`S-5` — may add **a lifecycle state and a revision entity**) and `OP-10`. **The largest architectural consequence of any open question** | `docs/08` `S-5`; `docs/07` `DD-1` | — |
| `OQ-11` | **Removal / unpublish?** | **Hard blocker** | Unresolved | **Before `P1` starts** | `P1` status model. **`OP-9` does not exist today** — do not build it speculatively | `docs/09` `OP-9`; `docs/07` `DD-1` | — |
| `OQ-13` | **Rejected-submission retention?** | **Hard blocker** | Unresolved | **Before `P1` starts** | `P1` (`S-11`) and a purge capability. Must resolve **both retention and period** (`NFR-PRIV-05`) | `docs/08` `S-11`; `docs/07` `DD-1` | — |
| `OQ-4` | Searchable fields and matching mode? | *Shaping input* | Unresolved | Carried into `P1`; revisited at `P2` | Search **scope** (`S-4`, `DDM-4`, `DD-14`). **Blocks no phase.** `BI-3` — search scope never exceeds publication scope — **is built and proven regardless.** *The rule is testable; the scope is not* | `docs/08` `S-4` | — |
| `OQ-5` | Category model — cardinality, curation? | *Shaping input* | Unresolved | Carried into `P1` | `S-3`, `DDM-3` (enumeration, reference table, or configuration). **Blocks no phase.** Set membership — a category always from the predefined set — **is enforced regardless** | `docs/08` `S-3` | — |

**On the two shaping inputs.** Each lands on a **named data-model seam**, so the *rule* can be
built and the *representation* deferred — **but a model built without considering them will be
retrofitted, not merely configured.** Carry them consciously; do not resolve them by default.

---

## `DG-2` — technology

**Blocks the `P0b` scaffold and all of `P1`.** The **store cannot be chosen** against
`NOQ-2` / `NOQ-3`: `docs/07` `DD-3` is explicit that a store **cannot be responsibly chosen
against an unknown recovery point objective**, because the objective determines the store's
required **capability**, not merely a schedule.

| ID | Question | Class | Status | Needed by | Blocks or shapes | Source | Outcome |
|---|---|---|---|---|---|---|---|
| `NOQ-2` | **Availability target?** | **Hard blocker** | Unresolved | **Before store and hosting selection** | Store and hosting selection. *99% and 99.9% are different deployments* | `docs/06`; `docs/07` `DD-3` | — |
| `NOQ-3` | **Backup / RPO / RTO?** | **Hard blocker** | Unresolved | **Before store selection** | Store selection. Determines the store's required **capability**, not just a schedule | `docs/06`; `docs/07` `DD-3` | — |
| `NOQ-1` | Performance thresholds? | *Shaping input* | Unresolved | Carried as `PA-1` | `DD-2`, `DD-5`, `DD-12`. **Informs technology selection; does not block it.** **No threshold is asserted anywhere — and none may be invented** | `docs/06`; `docs/11` Cat. 3 | — |
| `NOQ-4` | Expected first-release load? | *Shaping input* | Unresolved | Carried as `PA-1` | As `NOQ-1`. Everything assumes **"small"** (`PA-1`); if that is wrong, **this is the first decision to revisit** (`DD-12`) | `docs/06`; `docs/07` `A-5`, `A-6` | — |
| **Technology stack** | Language, framework, store, hosting, authentication, CI, test tooling | **Hard blocker** | Unresolved | **Before `P0b` and everything after it** | **`P0b` and everything after it.** Only `ADR-001` — the architecture *shape* — is decidable today | `docs/07` | Lands as `ADR-002`–`ADR-005` (issues #28, #29) |

**The two shaping inputs are carried, not resolved.** `PA-1` — *the directory is small at first
release* — **is** that stated assumption. It is load-bearing: if it is false, store, indexing,
and search sequencing (`DD-14`) all change. Carrying it is honest; forgetting it was an
assumption is not.

---

## `DG-3` — build-time

**Blocks `P3` (`OQ-9`), `P4` (`NOQ-9`, `OQ-14`/`NOQ-8`), and the *verifiability* — not the
building — of `P2` (`NOQ-5`, `NOQ-6`).**

| ID | Question | Class | Status | Needed by | Blocks or shapes | Source | Outcome |
|---|---|---|---|---|---|---|---|
| `OQ-14` **+** `NOQ-8` | **Audit logging of administrator actions — and what must it retain?** **One decision, taken together.** | **Hard blocker** | Unresolved | **Before `P4` — and the earlier the better** | `P4` (`C10`, `S-7`, `S-8`). **`OQ-14` asks *whether*; `NOQ-8` fixes *the obligation and its content*. Answering one without the other leaves `C10` half-specified** | `docs/07` `C10`, `DD-7`; `docs/08` `S-7`, `S-8` | — |
| `OQ-9` | **Anti-spam behavior?** | **Hard blocker** | Unresolved | **Before `P3`** | The `C11` mechanism (`S-9`, `DD-6`). The **seam** is built in `P3`; the mechanism is not. **Its absence cannot be asserted correct either** | `docs/07` `C11`, `DD-6`; `docs/08` `S-9` | — |
| `NOQ-9` | **Administrator credential and session strength?** | **Hard blocker** | Unresolved | **Before the `P4` authentication boundary** | `ADR-004` (`DD-4`). *The boundary is settled; the mechanism is not* | `docs/06`; `docs/07` `DD-4` | Lands as `ADR-004` |
| `NOQ-5` | **Accessibility standard and level?** | *Shaping input* — **answer it early** | Unresolved | **Early — during `P2`, not at `P5`** | The conformance **claim** only. **Blocks no phase:** the accessibility behaviors (`UA-1`–`UA-6`) are built and tested **from the first screen regardless**. **Cheap now, expensive to retrofit** — *the one shaping input whose cost behaves like a blocker* | `docs/06` `NFR-ACC-*`; `docs/11` | — |
| `NOQ-6` | Browser / device / assistive-technology matrix? | *Shaping input* | Unresolved | Before the `P5` support claim | The **support claim** only. **Blocks no phase:** responsive behavior at representative sizes is built and tested regardless. It defines what *"works"* **means** for testing, not whether testing can proceed | `docs/06`; `docs/11` | — |

### The two asymmetries on this gate

**`OQ-14` + `NOQ-8` is irreversible** (`IR-7`). **Audit history not captured cannot be
reconstructed** — every administrative action taken before a "yes" is **permanently unlogged**.
This is not a decision that can wait for `P4` and be applied retroactively, and **the asymmetry
is the argument**: take it to the product owner early. **They are one decision, and this log
records them on one row deliberately.**

**`OQ-9` answered late gets chosen hastily** (`IR-8`). A mechanism chosen under pressure can
break keyboard or assistive operability (`NFR-ACC-01/02`) or violate the vision's low-friction
principle. **That constraint is recorded now, before the mechanism is chosen** — it is not a
new requirement, and it does not answer `OQ-9`.

---

## `DG-4` — release

**Blocks the release decision, not the build.**

| ID | Question | Class | Status | Needed by | Blocks or shapes | Source | Outcome |
|---|---|---|---|---|---|---|---|
| `NOQ-7` | Operational-log retention? | Release gate | Unresolved | Before the release decision | `DD-13`. **The exclusion rule (`NFR-OBS-02`) is *not* deferred** — credentials never appear in logs, decision or no decision | `docs/06` `NFR-OBS-*` | — |
| **Testing depth** | How exhaustive before first release? | Release gate | Unresolved | Before the release decision | The **size of the suite**. **Category 1 gates hold regardless of the answer.** **No coverage percentage may be invented** (`docs/11` `T7`) | `docs/11` | — |
| **Category 3 acceptance** | Written acceptance of every blocked release risk | Release gate | Unresolved | **At the release decision** | See *Release-accepted risks* below. Each is **accepted in writing by a person, or resolved** | `docs/11` Cat. 3 | — |

---

## Release-accepted risks (`docs/11` Category 3)

**These cannot be gates, because their targets do not exist.** They are listed here **a second
time, deliberately** — each already appears under the gate that holds it for the *build*, and
reappears here as what it becomes at the *release decision*.

**Each is a release risk accepted explicitly, by a person, in writing — or resolved before
launch.** *Unmeasurable is not the same as optional.*

| ID | Risk if unanswered at release | Build gate | Accepted by | Date accepted | Status |
|---|---|---|---|---|---|
| `NOQ-1`, `NOQ-4` | **No performance threshold is asserted** — none was ever set, and none may be invented | `DG-2` | *unaccepted* | — | Unresolved |
| `NOQ-2` | **No availability target is asserted** | `DG-2` | *unaccepted* | — | Unresolved |
| `NOQ-3` | **No backup or recovery target is asserted.** Backup and restore are **exercised at all** in `P5`; no RPO/RTO is claimed | `DG-2` | *unaccepted* | — | Unresolved |
| `NOQ-5` | **No accessibility conformance level is claimed.** The **behaviors are still verified** — only the *claim* is withheld | `DG-3` | *unaccepted* | — | Unresolved |
| `NOQ-6` | **No browser, device, or assistive-technology support matrix is claimed** | `DG-3` | *unaccepted* | — | Unresolved |

> **Accepted risk is not a parking space for an unanswered blocker.** Nothing on `DG-1` may
> arrive here. These five are here because **their targets were never set** — not because
> answering them proved inconvenient.

---

## Not gated

Recorded so their absence reads as a **decision**, not an oversight. None blocks or shapes any
phase; none is waiting on anyone.

| ID | Question | Status | Note |
|---|---|---|---|
| `OQ-1` | Visitor report-inaccuracy path? | **Deferred** | Not built. `V7` is view-only. A "yes" would add **a second unauthenticated write path** |
| `OQ-2` | Lister outcome notification / reference? | **Deferred** | Nothing in the MVP. A "yes" adds an outbound dependency (`DD-16`), a failure mode, and a privacy surface |
| `OQ-3` | Default ordering? | **Deferred** | Ordering is built **consistent**; the specific order is configured, not asserted |
| `OQ-12` | Duplicate resolution? | **Deferred** | Nothing structural — an administrator procedure, and an exploratory charter |
| `OQ-15` | Abuse escalation? | **Deferred** | A human process, not a component |
| `AQ-1` | Duplicate-submission behavior? | **Deferred** | **Undefined.** An **exploratory charter, not an assertion** |
| `AQ-5` | API versioning? | **Deferred** | No scheme adopted; one first-party client |

---

## Maintenance

**This log is worthless the moment it goes stale**, and stale is the default state of a
document nobody is obliged to touch.

1. **Assign a person to every gate.** Until then the gates are owned in principle and unowned
   in practice — the exact condition `IR-1` describes.
2. **Update it in the pull request that changes it** (`IP-9`), never afterwards.
3. **When an answer arrives:** amend the **owning document** (`docs/03`–`docs/11`), record the
   *Outcome* and its reference here, update *Status*, and **unblock the work** — removing the
   `blocked` label from the issues the gate held.
4. **When a gate opens, say so out loud.** The `blocked` backlog is the most persuasive
   argument a product owner will ever get for answering `DG-1`; an opened gate that nobody
   announces just leaves the work sitting there.

### The failure this log exists to prevent

`IR-1` — **gates bypassed under delivery pressure**: *"we'll assume and adjust."* The plan
names it **the most likely failure, by a wide margin.**

**The adjustments are not adjustments.** `OQ-6` answered late means **backfilling every
record**. `OQ-10` answered late means **retrofitting a lifecycle state into a live moderation
workflow**. `OQ-14`/`NOQ-8` answered late is **irreversible** — the history was never captured.

> **The gates, the `blocked` label, and this log exist for exactly one purpose: to make sure
> the answers come from the people whose answers they are.**

---

## Source

| Document | What this log takes from it |
|---|---|
| `docs/12-implementation-plan.md` | **The gates, the classifications, and the blocked work.** *Decision gates*, *Open questions that block or shape implementation*, `IR-1`, `IR-7`, `IR-8`. |
| `docs/07-system-architecture.md` | `DD-1`–`DD-16`; the seven questions to take to the product owner first. |
| `docs/08-data-model.md` | The seams (`S-1`–`S-11`) each `DG-1` answer lands on. |
| `docs/11-test-strategy.md` | The three release-readiness categories; Category 3. |
| `CONTRIBUTING.md` | The working agreements this log is maintained under. |

**This log is a derivation. Where it conflicts with the chain, the chain wins and this log is
wrong.**
