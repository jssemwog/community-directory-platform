# Contributing

These are the working agreements for the Community Directory Platform.

They are **derived from `docs/12-implementation-plan.md`** and add no rule it does not
contain. Where this document appears to conflict with the plan, or with the approved chain
`docs/01`–`docs/12`, **the chain wins and this document is wrong.** It is a derivation, and a
derivation has no independent authority.

**This document is technology-neutral.** It names no language, framework, database product,
hosting platform, testing tool, or continuous-integration system, and it is written to read
identically whatever the technology decision (`DG-2`) turns out to be.

---

## The workflow

**`issue → branch → pull request → review → merge → close`.**

Unchanged from how `docs/01`–`docs/12` were delivered (`PA-5`), and preserved deliberately.

**No implementation work begins without an issue.** An issue is how work acquires a
requirement reference, a phase, a named set of invariants it must not break, and a gate. Work
that starts without one has skipped every check in this document, and there is no later point
at which those checks can be honestly applied.

---

## Issues

**One issue = one reviewable increment.** Concretely, an issue is *one of*:

- one API operation (`OP-n`), with its validation, authorization, and tests;
- one screen (`S-n`), with its empty, error, validation, and loading states;
- one boundary invariant's attack suite (`BI-n`) — **`BI-4`'s equivalence test is its own
  issue**, always;
- one entity, or one integrity rule group;
- one ADR;
- one document amendment.

### Sizing and splitting

**An issue is too big if** it spans two surfaces, or two phases, or cannot be reviewed in one
sitting, or **its title needs the word "and."**

**An issue is too small if** it cannot be merged without another issue merging first — that is
not an issue, it is half of one.

### What every issue states

| Field | Why |
|---|---|
| Its **requirement reference** — `FR-*`, a journey, or `NFR-*` | `IP-4`. No reference means it is not in the MVP. |
| The **phase and workstream** it belongs to | `P0`–`P5`, `W1`–`W5`. |
| **The invariants it must not break** | `BI-*`, `DI-*`. |
| Its **acceptance criteria** | Stated, and testable. |
| **Any open question it must not answer** | The unusual one — see below. |

**That last field does the most work.** It turns "don't accidentally decide `OQ-7`" from a
hope into a review checklist item.

---

## Branches

**Naming: `<type>/<issue-number>-<slug>`.** Types: `docs`, `feat`, `fix`, `test`, `chore`.

**One branch per issue, cut from `main`.** The issue number in the branch name is the first
link in the traceability chain, and it is what makes a branch's purpose legible without
opening it.

---

## Commits

The plan prescribes no commit convention; the repository has established one, and it is
preserved here rather than invented:

- The subject describes the change and carries the same type used in the branch name —
  `docs:`, `feat:`, `fix:`, `test:`, `chore:`.
- Because pull requests are **squash-merged**, the commit that lands on `main` is the one the
  pull request produces, and its subject carries **the pull-request number**, appended on
  merge.
- **The pull-request number and the issue number are not the same number.** They are drawn
  from one sequence, and the issue is created first. Cite the issue in the pull-request body,
  where it closes the issue; let the merge supply the pull-request number in the subject.

Commit hygiene on the branch matters less than the squashed result — that is what `main`
records, and what a future reader will actually see.

---

## Pull requests

**One pull request per issue, small enough to review properly.** *A reviewer who skims is a
reviewer who approves a boundary breach.*

### What every pull request carries

| Element | Why |
|---|---|
| The **issue it closes** | `IP-9`, and the traceability chain. |
| The **requirement(s) it satisfies** | `IP-4`. |
| **The invariants it touches**, and how they are proven | `IP-5`, `IP-6` — the review focus. |
| **Its tests, in the same pull request** | `IP-6`. **Non-negotiable.** A boundary proven "next sprint" was unprotected in between. |
| **Documentation changes it necessitates** | `IP-9`. |
| **An explicit statement if it approaches an open question** | The single most valuable line in a pull request. |

### Pull requests that must be split

- Anything **touching two surfaces**.
- Anything **mixing a refactor with a behavior change**.
- Anything **mixing an ADR with the code that depends on it** — **the ADR merges first.**

### Merging

**Squash merge to `main`,** on one reviewer's approval. This is the established method; every
commit on `main` arrived this way.

---

## Review

**What a reviewer is responsible for, in priority order:**

1. **Does it breach an invariant?** `BI-1`–`BI-9`, `DI-1`–`DI-9`. **This outranks everything
   below it** — including style, structure, and taste.
2. **Does it silently answer an open question?** A field name, a default, a status value, a
   retention period, an ordering — each can quietly close a question the product owner has not
   been asked. **This is the failure mode this whole plan is built to prevent, and the reviewer
   is the last line of defence against it.**
3. **Is it in scope?** No requirement reference, no merge (`IP-4`). Outside `docs/03`, no merge.
4. **Is it proven where it is enforced?** Not only through the interface (`BI-9`, `IP-5`).
5. **Does the documentation still tell the truth after this merge?** (`IP-9`.)

**Approval requires one reviewer.** Boundary-invariant work (`BI-*`), the authentication
boundary, and the public projection warrant a **second pair of eyes** — not because the first
reviewer is untrusted, but **because these are the changes whose failure is silent.**

---

## Open questions, and the guardrail around them

The approved chain deliberately **left questions open**, supplied the seam where the answer
will land, and refused to guess. Implementation is where that discipline is most expensive to
keep and most tempting to spend.

**An open question is answered by the product owner** — never by a contributor picking a
default, and never by a reviewer letting one through. A field name, a status value, an
ordering, a retention period, or a test asserting a specific list can each close a question
nobody was asked. **A change that names a field has made a data decision.**

**Sequencing an open question is not the same as answering it.** Where a question blocks a
specific assertion, **the general rule is still built and still tested** — the rule is testable
even when the list is not. **Implement the rule; configure the list.**

**If a decision genuinely must be made to proceed, it is recorded** — in an ADR, or in an
amendment to the owning document — **in the same pull request that relies on it** (`IP-9`). A
decision made and not written down is the one that gets silently re-made later.

---

## Blocked work and decision gates

A **decision gate** (`DG-1`–`DG-4`) is a set of questions that must be answered **by the
product owner** — not by an engineer choosing a default at four o'clock on a Friday. Each gate
names the work it blocks.

**Work behind an unopened gate does not start.**

- A **blocked issue carries a `blocked` label naming its gate.**
- Blocked issues **may be written early** — writing them is how the gate's cost becomes
  visible — but they are **not started**. *A backlog of visibly blocked issues is the most
  persuasive argument a product owner will ever get for answering `DG-1`.*

**Two kinds of question sit behind a gate, and conflating them overstates the block.**

- A **hard blocker** makes the work *impossible to do honestly*. Proceeding means guessing, and
  the guess silently becomes the answer.
- A **shaping input** makes the work *possible but under-informed*. It must be **considered and
  consciously carried as a stated assumption** — not resolved by default — and revisited the
  moment it is answered. **A shaping input is not permission to proceed casually.** It is
  permission to proceed **with the cost written down.**

**The temptation this exists to resist** is *"we will assume, and adjust later."* Adjusting a
location decision later means backfilling every record; adjusting an edit-after-approval
decision later means retrofitting a lifecycle state into a live moderation workflow. **The
gates exist because those adjustments are not adjustments.**

---

## Traceability

The chain must hold **in both directions**, end to end:

> **Requirement (`docs/05`, `docs/06`) → journey (`docs/04`) → operation (`docs/09`) / screen
> (`docs/10`) / entity (`docs/08`) → issue → branch → pull request → test (`docs/11`) →
> merge.**

- **Forward:** every approved requirement reaches at least one issue, **or is explicitly
  recorded as deferred or blocked**. Nothing is silently dropped.
- **Backward:** every issue, and every merged pull request, **names the requirement it
  serves**. Nothing is silently added — *which is how out-of-scope features actually get built:
  not by decision, but by drift.*
- **Invariants:** every `BI-*` and `DI-*` **names the test that attacks it**. An invariant with
  no attacking test is an invariant with no evidence.
- **Open questions:** every open question is traceable to **the gate that holds it, and the
  work it blocks**.

The traceability matrix is **updated in the pull request that changes it** — never
reconstructed at release, when it would be archaeology.

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
difference between preserving the chain's discipline and quietly spending it.

---

## Definition of done

An issue is **done** when:

| # | Condition |
|---|---|
| 1 | The behavior matches the approved requirement — **no more, and no less**. |
| 2 | **Its tests are merged with it** (`IP-6`), at the level where the behavior is enforced (`IP-5`). |
| 3 | **Every invariant it touches is proven by an attacking test** — one that attempts the violation and fails to achieve it. |
| 4 | Empty, error, validation, loading, and confirmation states exist where `docs/10` requires them. |
| 5 | Keyboard operability holds for the flows it touches. |
| 6 | **No open question was answered by it.** Any decision made is recorded in an ADR or a document amendment **in the same pull request**. |
| 7 | Documentation and traceability are updated (`IP-9`). |
| 8 | It is reviewed, approved, and merged to `main`. |

**Condition 3 is the sharp one.** *"The test passes"* is not the standard. **"We tried to break
it and could not"** is the standard — because that is the only form of evidence a boundary
invariant accepts.

---

## What is not in scope yet

The project is in **`P0a`** — the **stack-neutral** foundation phase. It is blocked by
nothing, and it is the **only** implementation work that can honestly proceed today.

**The following remain outside `P0a`, and must not be started unless separately authorized:**

- Application scaffolding, project structure, or local development setup
- Continuous integration, or any automated check pipeline
- Deployment, hosting, or environment provisioning
- Database or data-store selection, schema, or migration
- Framework, language, or library selection
- **Any technology or stack-selection decision** (`ADR-002`–`ADR-005`)

These are **`P0b`**, and **`P0b` is blocked by `DG-2`.** `P1`, and everything after it, is
blocked by **`DG-1` and `DG-2` together.**

> **Until `DG-1` and `DG-2` clear, the only implementation work that can honestly proceed is
> the stack-neutral half of Phase 0.** That is not a scheduling inconvenience to route around.
> It is the plan telling the truth.

**The mini lab is a reference, never a template** (`IP-8`). Its shape was **rejected on the
requirements** (`docs/07`, `R-10`). Reintroducing it during implementation would undo an argued
decision without arguing it.

---

## Reference

| Document | What it holds |
|---|---|
| `docs/03-mvp-scope.md` | The scope fence. |
| `docs/05-functional-requirements.md`, `docs/06-non-functional-requirements.md` | The requirements every issue cites. |
| `docs/07-system-architecture.md` | Components, deferred decisions, the ADRs. |
| `docs/08-data-model.md` | Entities, integrity invariants, the named seams. |
| `docs/11-test-strategy.md` | The boundary invariants, and what counts as evidence. |
| `docs/12-implementation-plan.md` | **The source of these agreements** — phases, gates, workstreams, and the principles `IP-1`–`IP-9`. |
