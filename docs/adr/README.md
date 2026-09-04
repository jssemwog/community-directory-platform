# Architecture decision records

This directory holds the project's **architecture decision records** (ADRs) — the place a
decision lands, so that it is made **once**, **argued in writing**, and **not silently re-made
later**.

`docs/07-system-architecture.md` names the ADRs this project needs. Until now, **nothing held
them.** This directory is that place.

**It holds eight decisions in force.** `ADR-001`, `ADR-002`, `ADR-003`, `ADR-005`, `ADR-006`,
`ADR-010`, `ADR-013` and — since 2026-09-04 — `ADR-012` are all **Accepted**; every remaining
ADR is **Blocked** on a question
the product owner has not been asked. See *The register*.

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

**Every ADR named by `docs/07-system-architecture.md`, and every later ADR the chain did not
anticipate** (`ADR-013` onward). The blocked ones are listed **so that
their absence is visible** — a decision nobody can see is not being waited for, it is being
forgotten.

| ADR | Decision | Gate | Blocked by | Status |
|---|---|---|---|---|
| **`ADR-001`** | Adopt a modular monolith with a server-enforced public/administrative boundary; **reject microservices and browser-direct data access** — and record **why the mini lab shape was rejected on the requirements** (`R-10`) | `DG-0` | **Nothing** | **Accepted** — 2026-07-24 (issue #29). *The only decision taken so far.* |
| **[`ADR-002`](ADR-002-application-language-and-framework.md)** | Application language and framework | **`DG-2`** | **Nothing.** ~~The technology decision~~ — **no open question is named**; hard requirements 1, 2, 6 and `DD-2` are stated **inputs**, and `NOQ-1`/`NOQ-4` are **shaping inputs** that do not block (carried as `PA-1`). **Fed by `ADR-003`** (Accepted), which fixes the store the stack must integrate with | **Accepted** — 2026-08-25 (issue #85). *In force; work may rely on it.* The decision is **TypeScript + Next.js**, the product owner's selection from the governed candidate comparison. **It discharges `DD-2`.** The compensating obligations **O-1**–**O-12** are binding. ~~**`ADR-005` remains open; `DG-2` remains Unresolved**~~ — **`ADR-005` is `Accepted` and `DG-2` is `Resolved`** (2026-08-27, issue #93); this ADR itself opened no gate — and no ORM/data-access technology, hosting provider, authentication mechanism, test tooling, CI, named PostgreSQL provider, schema, or separable frontend technology is selected. |
| **[`ADR-003`](ADR-003-data-store-product.md)** | **Data-store product** | **`DG-2`** | **Nothing.** ~~**`NOQ-2`** (availability) · **`NOQ-3`** (backup / RPO / RTO)~~ both **Decided** — 2026-07-30, `NOQ-3` amended by ruling **R1** 2026-08-18 — `DD-3`. **Fed by `ADR-010`** (Accepted), which supplies the recovery-capability filter `DD-3` required | **Accepted** — 2026-08-23 (issue #81). *In force; work may rely on it.* The decision is **PostgreSQL under a managed operating posture**. It **discharges `DD-3`**. **The named provider is deferred**, so `DDM-1` is **not fully discharged**; no schema or index is decided; `ADR-010`'s provider-capability validation remains outstanding; and ~~**`DG-2` remains Unresolved**~~ **`DG-2` is `Resolved`** (2026-08-27, issue #93) — this ADR itself opened no gate. |
| **`ADR-004`** | Administrator authentication mechanism | **`DG-3`** | **`NOQ-9`** — `DD-4`. *The boundary is settled; the mechanism is not* | **Blocked** |
| **[`ADR-005`](ADR-005-hosting-platform-and-runtime-model.md)** | Hosting platform and runtime model | **`DG-2`** | **Nothing.** ~~The technology decision~~ — **no open question is named**; `DD-5` is a stated **input** (`docs/07` records that **both** runtime shapes satisfy the architecture), `NOQ-2` is **Decided** 2026-07-30, and `NOQ-1`/`NOQ-4` are **shaping inputs** that do not block (carried as `PA-1`). **Fed by `ADR-010`** (Accepted — the availability and recovery posture it must host), **`ADR-003`** (Accepted — the managed PostgreSQL it must reach) and **`ADR-002`** (Accepted — whose Node.js runtime requirement is a framework *consequence*, not an `ADR-005` decision). **It must not reopen the rejected decomposition of Option D** (`docs/07`) | **Accepted** — 2026-08-27 (issue #91). *In force; work may rely on it.* Published as `Proposed` 2026-08-26 (issue #89, PR #90). The decision is **Render, with the Next.js modular monolith deployed as a long-running Node.js web service**, the product owner's selection from the governed candidate comparison. **It discharges `DD-5`.** The compensating obligations **O-1**–**O-9** are binding. ~~**`DG-2` remains Unresolved**~~ **`DG-2` is `Resolved`** (2026-08-27, issue #93) — this acceptance completed its final substantive decision but **opened no gate**, so the separate governed `Resolved` synchronization it required was performed under issue #93 — and no named PostgreSQL provider, ORM/data-access technology, authentication mechanism, test tooling, CI, container technology, observability product, or Render service tier is selected. |
| **[`ADR-006`](ADR-006-listing-data-model-and-lifecycle-states.md)** | **Listing data model and lifecycle states** | **`DG-1`** — **Resolved 2026-08-04** | **Nothing.** `OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, and `OQ-13` are all **Decided** — `DD-1` | **Accepted** — 2026-08-07 (issue #61). *In force; work may rely on it.* |
| **`ADR-007`** | Search approach | **`DG-1`** | **`OQ-4`** — `DD-14`. *A dedicated index requires **measured** justification* | **Blocked** |
| **`ADR-008`** | Anti-spam approach | **`DG-3`** | **`OQ-9`** — `DD-6`. *Must be weighed against `NFR-ACC-01/02`* | **Blocked** |
| **`ADR-009`** | Audit-logging approach | **`DG-3`** | **`OQ-14`** — and `NOQ-8`, **taken as one decision** (`DD-7`). **Irreversible if answered late** (`IR-7`) | **Blocked** |
| **[`ADR-010`](ADR-010-backup-recovery-availability-posture.md)** | Backup, recovery, and availability posture | **`DG-2`** | **Nothing.** ~~**`NOQ-2`, `NOQ-3`**~~ both **Decided** — 2026-07-30, `NOQ-3` amended by ruling **R1** 2026-08-18 — `DD-8`, `DD-9`. **Feeds `ADR-003`** | **Accepted** — 2026-08-19 (issue #69). *In force; work may rely on it.* It discharges `DD-8` and `DD-9`; the **mechanism** and the store remain open (`ADR-003`, `DD-3`, `DD-5`). |
| **`ADR-011`** | Accessibility standard, level, and supported matrix | **`DG-3`** | **`NOQ-5`, `NOQ-6`** — `DD-10`, `DD-11` | **Blocked** |
| **[`ADR-012`](ADR-012-test-tooling.md)** | Testing strategy — with the administrative boundary as its highest-value target. **This ADR decides the test-tooling portion only** | ~~**`DG-2`** (tooling)~~ · **`DG-4`** (depth). **Historical planning classification only** — **`DG-2` is `Resolved`** (2026-08-27, issue #93) and **`ADR-012` is not one of its constituents**, so the tooling portion carries **no live gate**. **`DG-4`** remains the unresolved gate over testing **depth** | **Nothing.** `docs/07` names **no blocking question of its own**; the **test tooling follows `ADR-002`**, which is **`Accepted`** and in force, so ~~it cannot be written in full until `ADR-002` lands~~ — **`ADR-002` landed 2026-08-25 (issue #85) and the test-tooling portion became independently writable**. Testing **depth** remains **`DG-4`** and is **not** drafted | **Accepted** — 2026-09-04 (issue #107). *In force; work may rely on it.* Published as `Proposed` 2026-09-03 (issue #105, PR #106). The decision is **Vitest as the primary implementation-level test runner, beginning with `P1` Slice A**. **Only the test-tooling portion is decided**, and it is decided **prospectively, to enable implementation**; testing **depth**, coverage policy and every release-readiness threshold remain **`DG-4`**. **`DG-2` was already `Resolved` 2026-08-27 (issue #93) before this ADR existed** — this ADR is **not** a `DG-2` constituent, does **not** reopen `DG-2`, and does **not** complete it. **Acceptance is not installation**: no package version, installation, script, configuration, coverage provider, DOM environment, component, browser, accessibility or database-test tooling is selected; **`P1` Slice A is not authorized** and remains a separate later work unit; and no persistence technology, `DDM-*` or provisioning decision is made |
| **[`ADR-013`](ADR-013-managed-postgresql-provider.md)** | **Named managed PostgreSQL provider** — the service and vendor `ADR-003` deferred (`DDM-1`) | **`DG-2`** — **Resolved** 2026-08-27 (issue #93) | **Nothing.** `ADR-003` (Accepted) fixed the engine and the managed posture and **deferred the named provider**, requiring *"a separate, explicit product-owner ruling"*; `ADR-010` (Accepted) supplies the capability filter. **Not named by `docs/07`** — a decision the chain did not anticipate, taking `ADR-013` under *Numbering and filenames* | **Accepted** — 2026-09-03 (issue #103). *In force; work may rely on it.* Published as `Proposed` 2026-09-01 (issue #101, PR #102). The decision is **DigitalOcean Managed PostgreSQL**, the product owner's selection from the governed candidate comparison. **It discharges `DDM-1` only as to the named managed service and vendor** — `DDM-2`–`DDM-10` are untouched. **Acceptance opens no gate**: `DG-2` was already `Resolved` (2026-08-27, issue #93) and this ADR is not a constituent of it. **`ADR-010` is not discharged**: its **independent off-provider copy**, its **restore rehearsals** and its **provider-capability validation** all remain **outstanding**, and naming a provider satisfies none of them. **Render remains the application host only**; and no region, tier, sizing, PostgreSQL version, provisioning, ORM, driver, pooler, migration, schema, index, authentication, secret, backup-mechanism or connectivity decision is made — **implementation remains unauthorized** |

> **Note the ordering, and why it is not an accident.** `ADR-001` is writable immediately.
> **`ADR-003` and `ADR-006` — the two most consequential and the hardest to reverse — were both
> held behind open product questions.** `docs/07` deferred them rather than guessing, and this
> directory did the same. **`ADR-003`'s prerequisite questions are now answered and it is
> `Accepted`** — in force since 2026-08-23; the named provider remains **deferred**, and
> ~~`DG-2` remains **Unresolved**~~ **`DG-2` is `Resolved`** (2026-08-27, issue #93).

**Five of twelve still cannot be written** — ~~six~~, until `ADR-012` was drafted as
`Proposed` on 2026-09-03. That is not a backlog to work around; it is the
measure of what ~~`DG-1`, `DG-2`, and~~ **`DG-3`** is holding — `DG-1` and `DG-2` are both
**`Resolved`**. Four of the five (`ADR-004`, `ADR-008`, `ADR-009`, `ADR-011`) wait on **`DG-3`**;
`ADR-007` sits under the `Resolved` `DG-1` and waits instead on **`OQ-4`**, an **Unresolved shaping
input**. See `docs/13-decision-log.md`.

**`DG-2`'s closure scope — owner ruling, 2026-08-26 (issue #87).** **`ADR-005` was the final
remaining substantive `DG-2` constituent, and it is now `Accepted`** — 2026-08-27 (issue #91).
`ADR-002`, `ADR-003` and `ADR-010` are `Accepted` and their `DG-2` work is complete; `NOQ-2` and
`NOQ-3` are **Decided**. **`ADR-004` is `DG-3`**, **`ADR-012` does not block `DG-2`** (its
**depth** half is `DG-4`), **CI is `P0b` work this gate's closure unblocks**, and **`DDM-1`'s
deferred named managed provider does not block closure**. **`DG-2`'s substantive decisions are
therefore complete — and ~~`DG-2` is still `Unresolved`~~ `DG-2` is `Resolved`, 2026-08-27
(issue #93).** As always here, **an ADR records a decision; it does not open a gate**: the gate
proceeded to `Resolved` only through the **separate governed synchronization** it required.
**`P0b` is now eligible and `P1` is gate-clear**; `P3`, `P4` and `P2`'s *verifiability* remain
blocked by **`DG-3`**, and the release decision remains **`DG-4`**.

**`ADR-006` is now `Accepted`, and the distinction matters.** It began blocked on six
`DG-1` questions; all six are now answered — `OQ-6` and `OQ-7` (2026-07-31), `OQ-10`
(2026-08-02), `OQ-8`/`OQ-8b` (2026-08-03), and `OQ-11` and `OQ-13` (2026-08-04). `DG-1` is
**Resolved**, the gate that held this ADR opened, the ADR was drafted, reviewed, and
**accepted by the architecture owner on 2026-08-07**. It is therefore **in force**, and work
may rely on it. **Acceptance opens no gate:** ~~`DG-2` remains Unresolved, and `P0b` and
`P1`–`P5` remain blocked by it~~ — `DG-2` was later `Resolved` on 2026-08-27 (issue #93) by
its own governed synchronization, not by any ADR's acceptance.

**What `ADR-006` decides, and what it deliberately does not.** Every one of those six product
decisions *narrowed* `ADR-006` without filling it: each settled a **product** question and
selected **no representation**. `ADR-006` accordingly decides the **logical model and its
lifecycle states** — and **does not resolve `DDM-8` or `DDM-9`**. **`DDM-8` remains
responsible for the physical revision-storage representation and for how the effective public
version is carried; `DDM-9` remains responsible for the physical lifecycle and removal
representation — publication state, retention, purge, and any deletion semantics.** Both
remain **unresolved**. `ADR-006` states the *logical requirements* their later representations
must satisfy, and **now that it is Accepted those decisions must conform to it**.

---

## Reference

| Document | What it holds |
|---|---|
| `docs/07-system-architecture.md` | **The ADRs, and what each must decide.** `DD-1`–`DD-16`. |
| `docs/12-implementation-plan.md` | The phases and gates; `IP-9`, `IR-1`, `IR-6`. |
| `docs/13-decision-log.md` | **The live register of the questions blocking these ADRs.** |
| `CONTRIBUTING.md` | The working agreements — *the ADR merges first*. |
