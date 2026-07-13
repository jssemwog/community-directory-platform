# Architecture decision records

This directory holds the project's **architecture decision records** (ADRs) — the place a
decision lands, so that it is made **once**, **argued in writing**, and **not silently re-made
later**.

`docs/07-system-architecture.md` names the ADRs this project needs. Until now, **nothing held
them.** This directory is that place.

**It contains no decisions yet.** `ADR-001` is written under issue #29; every other ADR is
**blocked** on a question the product owner has not been asked. See *The register*.

---

## What an ADR is

A short document recording **one decision**: what was decided, **what was rejected and why**,
what it costs, and what it assumes.

**The rejection rationale is the point, not a formality.** `IR-6` exists because *an argued
rejection that is not written down gets silently re-made.* An ADR that records only the choice
has preserved the answer and thrown away the argument — and the argument is what stops the
question being reopened by the next person who has not read it.

---

## What an ADR is not

**An ADR does not create authorization.** Writing one confers no permission to decide.

> **An ADR records a decision. It does not open a gate.**

A decision behind an unopened gate (`DG-1`–`DG-4`, `docs/13-decision-log.md`) **is not the
author's to make**, and writing it into an ADR does not make it so. An ADR authored ahead of
its gate is not diligence — **it is the gate being bypassed in a document that looks
official**, which is exactly the failure `IR-1` names as *the most likely failure of this plan,
by a wide margin*.

**If the gate is shut, the ADR waits.** Record the question in the decision log; do not answer
it here.

### An ADR must not answer an open question implicitly

The subtler failure, and the one to watch for. An ADR may **only** decide the question it is
about. It must not settle an unrelated open question **as a side effect** — by naming a field,
assuming an ordering, presuming a retention period, or implying a public/private split in the
course of explaining something else.

**A document that names a field has made a data decision.** If writing an ADR seems to *require*
answering another open question, that is the finding: **stop, and take the question to its
owner.** It is not a detail to settle in passing.

---

## When an ADR is required

Write one when a decision is:

- **Structural** — it shapes components, boundaries, or the data model;
- **Costly to reverse** — undoing it means migrating data, rewriting tests, or re-arguing it;
- **Cross-cutting** — more than one workstream must live with it; or
- **Contested** — a reasonable engineer would have chosen otherwise, and the reasoning must
  survive the argument.

**Also write one whenever implementation forces a decision the chain did not make** (`IP-9`).
It merges **in the same pull request that relies on it** — and where a pull request would mix an
ADR with the code depending on it, **the ADR merges first** (`CONTRIBUTING.md`).

**Do not write one** for a reversible, local, uncontested choice. An ADR for everything is an
ADR for nothing.

---

## Statuses

| Status | Meaning |
|---|---|
| **Blocked** | The decision **cannot be made yet** — it waits on a question the product owner has not answered. The ADR **is not drafted**; only its row in the register exists, naming **the gate and the question holding it**. *This is the status of almost everything below.* |
| **Proposed** | Drafted and under review. The decision is **not yet in force**; nothing may depend on it. |
| **Accepted** | Decided and **in force**. Work may rely on it. |
| **Rejected** | Considered and **not adopted**. The record is kept — *a rejected option that is not written down gets proposed again.* |
| **Superseded** | Was accepted; **replaced** by a later ADR. Names its successor in *Superseded by*. The file is **never deleted or edited into agreement** — the history is the value. |

**Before an ADR exists as a file**, the register carries one of three states instead:
**Ready to write** (its gate is open — go), **Blocked** (a named question holds it), or
**Not yet writable** (no question of its own blocks it, but it depends on an ADR that is
itself blocked). All three mean *no file exists yet*; they differ in **what is standing in the
way**, which is the only part worth tracking.

**Blocked is a real status, not a placeholder.** It is how an unmade decision stays **visible**
rather than becoming an assumption. A blocked ADR names its gate; it does not guess.

**Superseding, not editing.** An accepted ADR is a historical record. When the decision changes,
**write a new ADR** that supersedes it and update both rows. Editing the old one to match the
new reality destroys the only evidence of what was believed and when.

---

## Numbering and filenames

**Filename:** `ADR-NNN-kebab-case-title.md` — for example, `ADR-001-modular-monolith.md`.

- **`NNN` is zero-padded to three digits**, assigned **sequentially** and **never reused** —
  not even if an ADR is rejected or superseded. The number is a permanent handle; a reused
  number breaks every reference that ever pointed at it.
- **The number is claimed when the ADR is written**, and `ADR-001`–`ADR-012` are **already
  claimed** by `docs/07`. A new decision the chain did not anticipate takes **`ADR-013`
  onward**.
- **The ADR number is not the issue number and not the pull-request number.** They are separate
  sequences and will not line up.

---

## The register

**Every ADR named by `docs/07-system-architecture.md`.** The blocked ones are listed **so that
their absence is visible** — a decision nobody can see is not being waited for, it is being
forgotten.

| ADR | Decision | Gate | Blocked by | Status |
|---|---|---|---|---|
| **`ADR-001`** | Adopt a modular monolith with a server-enforced public/administrative boundary; **reject microservices and browser-direct data access** — and record **why the mini lab shape was rejected on the requirements** (`R-10`) | `DG-0` | **Nothing** | **Ready to write** — issue #29. *The one ADR that can be written today.* |
| **`ADR-002`** | Application language and framework | **`DG-2`** | The technology decision (hard requirements 1, 2, 6; `DD-2`) | **Blocked** |
| **`ADR-003`** | **Data-store product** | **`DG-2`** | **`NOQ-2`** (availability) · **`NOQ-3`** (backup / RPO / RTO) — `DD-3` | **Blocked** |
| **`ADR-004`** | Administrator authentication mechanism | **`DG-3`** | **`NOQ-9`** — `DD-4`. *The boundary is settled; the mechanism is not* | **Blocked** |
| **`ADR-005`** | Hosting platform and runtime model | **`DG-2`** | The technology decision — `DD-5` | **Blocked** |
| **`ADR-006`** | **Listing data model and lifecycle states** | **`DG-1`** | **`OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13`** — `DD-1` | **Blocked** |
| **`ADR-007`** | Search approach | **`DG-1`** | **`OQ-4`** — `DD-14`. *A dedicated index requires **measured** justification* | **Blocked** |
| **`ADR-008`** | Anti-spam approach | **`DG-3`** | **`OQ-9`** — `DD-6`. *Must be weighed against `NFR-ACC-01/02`* | **Blocked** |
| **`ADR-009`** | Audit-logging approach | **`DG-3`** | **`OQ-14`** — and `NOQ-8`, **taken as one decision** (`DD-7`). **Irreversible if answered late** (`IR-7`) | **Blocked** |
| **`ADR-010`** | Backup, recovery, and availability posture | **`DG-2`** | **`NOQ-2`, `NOQ-3`** — `DD-8`, `DD-9`. **Feeds `ADR-003`** | **Blocked** |
| **`ADR-011`** | Accessibility standard, level, and supported matrix | **`DG-3`** | **`NOQ-5`, `NOQ-6`** — `DD-10`, `DD-11` | **Blocked** |
| **`ADR-012`** | Testing strategy — with the administrative boundary as its highest-value target | **`DG-2`** (tooling) · **`DG-4`** (depth) | `docs/07` names **no blocking question of its own** — but the **test tooling follows `ADR-002`**, which is blocked, and testing **depth** is `DG-4`. **It cannot be written in full until `ADR-002` lands** | **Not yet writable** |

> **Note the ordering, and why it is not an accident.** `ADR-001` is writable immediately.
> **`ADR-003` and `ADR-006` — the two most consequential and the hardest to reverse — are both
> blocked on open product questions.** `docs/07` defers them rather than guessing, and this
> directory does the same.

**Eleven of twelve cannot be written today.** That is not a backlog to work around; it is the
measure of what `DG-1`, `DG-2`, and `DG-3` are holding. See `docs/13-decision-log.md`.

---

## Reference

| Document | What it holds |
|---|---|
| `docs/07-system-architecture.md` | **The ADRs, and what each must decide.** `DD-1`–`DD-16`. |
| `docs/12-implementation-plan.md` | The phases and gates; `IP-9`, `IR-1`, `IR-6`. |
| `docs/13-decision-log.md` | **The live register of the questions blocking these ADRs.** |
| `CONTRIBUTING.md` | The working agreements — *the ADR merges first*. |
