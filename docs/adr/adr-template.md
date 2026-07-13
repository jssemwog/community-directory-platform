# `ADR-NNN` — <decision, stated as a decision>

<!--
Copy to `docs/adr/ADR-NNN-kebab-case-title.md`. Take the next unused number; never reuse one.
The title states what was DECIDED, not what was discussed:
  good — "Adopt a modular monolith with a server-enforced administrative boundary"
  bad  — "Architecture options"
Delete every comment block, and delete any section that genuinely does not apply — but say so
rather than leaving it blank. A blank section reads as an oversight; "none" reads as a finding.
-->

| Field | Value |
|---|---|
| **Status** | `Blocked` / `Proposed` / `Accepted` / `Rejected` / `Superseded` |
| **Date** | `YYYY-MM-DD` — the date the status last changed |
| **Decision owner** | The person accountable for the decision — **a name, not a role**, once one is assigned |
| **Decision gate** | `DG-0`–`DG-4`, or *none* |
| **Related open questions** | The `OQ-*` / `NOQ-*` / `AQ-*` this decision depends on — **and, separately, any it must NOT answer** |
| **Supersedes** | `ADR-NNN`, or *none* |
| **Superseded by** | `ADR-NNN`, or *none* |

<!--
STATUS AND THE GATE — read before writing anything below.

If the decision gate above is SHUT, this ADR's status is `Blocked` and YOU STOP HERE.
Fill in the table, state which question is holding it, and write nothing further.

An ADR records a decision. IT DOES NOT OPEN A GATE. Writing the decision down does not make
it yours to take — and an ADR authored ahead of its gate is the gate being bypassed in a
document that looks official.
-->

---

## Context

<!--
The forces, constraints, and requirements that make this decision necessary — the situation as
it is, not the option you favour. A reader who was not there must be able to reconstruct why
this decision could not simply be avoided.

Cite the requirements it answers to: FR-*, NFR-*, journeys, BI-*, DI-*.
State the facts. Do not argue the conclusion here; that is the next section.
-->

## Decision

<!--
What is being decided, stated plainly and in the active voice: "We will …"

One decision per ADR. If two decisions are being taken, write two ADRs — unless they are
genuinely inseparable (OQ-14 and NOQ-8 are the standing example: audit logging's WHETHER and
its WHAT cannot be resolved apart, and the plan says so). If they are inseparable, say why.
-->

## Alternatives considered

<!--
REQUIRED. This section is not optional, and "we considered nothing else" is not an answer.

For EACH alternative: what it was, and WHY IT WAS REJECTED — against the requirements, not
against taste. The rejection rationale is the load-bearing part of this document.

IR-6 exists because an argued rejection that is not written down GETS SILENTLY RE-MADE. The
mini lab is the standing example: its shape was rejected on the requirements (R-10), and
ADR-001 records that rejection precisely so it cannot be re-made by accident.

An ADR that lists alternatives without saying why each failed has preserved the answer and
thrown away the argument.
-->

| Alternative | Why it was rejected |
|---|---|
| | |

## Consequences

<!--
What becomes true, and what becomes harder. BOTH — an ADR with no negative consequences has
not been thought about.

- What this enables, simplifies, or makes safe.
- What it costs: complexity, effort, constraint, foreclosed options.
- What becomes expensive to reverse, and how expensive.
- What seams it preserves (docs/07 C4-C9), and what it forecloses.
-->

**Positive:**

**Negative:**

**Reversibility:**

## Assumptions

<!--
What must be TRUE for this decision to remain correct — each one load-bearing, each one
falsifiable. PA-1 ("the directory is small at first release") is the standing example: everything
assumes it, and if it is false, this is the first decision to revisit.

For each: what it assumes, and WHAT WOULD CHANGE IF IT IS WRONG. An assumption whose falsity
costs nothing is not worth recording; one whose falsity costs everything must be.
-->

| Assumption | If it is wrong |
|---|---|
| | |

## Risks

<!--
What could go wrong BECAUSE of this decision, and what would be done about it. Not generic
project risk — the risk this decision specifically introduces.
-->

| Risk | Consequence | Response |
|---|---|---|
| | | |

## Open questions this decision must NOT answer

<!--
THE MOST IMPORTANT SECTION IN THIS TEMPLATE, and the easiest to leave empty.

Name every open question this ADR touches but MUST NOT SETTLE — and state how it avoids
settling it. A field name, a default, an ordering, a status value, or a retention period can
each close a question the product owner has not been asked.

The pattern that makes this possible: IMPLEMENT THE RULE; CONFIGURE THE LIST. The rule is
decidable and testable now; the list is the product owner's, and it waits.

If this ADR cannot be written without answering one of these — STOP. That is the finding. Take
the question to its owner and leave this ADR blocked.
-->

| Open question | How this decision avoids answering it |
|---|---|
| | |

## Traceability

<!-- Both directions. Nothing silently dropped; nothing silently added. -->

| | |
|---|---|
| **Requirements** | `FR-*`, `NFR-*` this decision answers to |
| **Journeys** | `V*` / `L*` / `A*` |
| **Components** | `C1`–`C12` (`docs/07`) |
| **Invariants** | `BI-*`, `DI-*` this decision must not breach |
| **Documents amended** | Which chain documents this changes — **amended in the same pull request** (`IP-9`) |
| **Issue / pull request** | The issue this ADR closes, and the pull request that merged it |
