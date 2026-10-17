# `ADR-025` — Classify a designation-bearing value as replaced by exact carrier comparison, default every replacement to private, and refuse any private-to-public widening explicitly

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-17 (issue #203). The Product Owner's **binding ruling and its clarification were given on issue #203 before this document was drafted**, and are recorded below |
| **Date** | 2026-10-17 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-17:** a designation-bearing value is a **replacement only when its value differs from the listing's current persisted value**, compared **exactly**, with **no new normalization authorized or implied** — no trimming, case-folding, punctuation removal, phone-digit comparison, URL parsing, email normalization or any other inferred canonicalization, and a future normalization policy requiring **separately governed work**; **"omitted" applies only at an operation boundary that can explicitly represent "not supplied"**, and never reinterprets absence inside `OP-6`'s **complete** proposed content as a patch-style omission, so **every field position in that complete proposal participates in comparison**; **every actual replacement defaults to private** and **never inherits** the replaced value's public designation; an **unchanged** value may preserve its designation **or be restricted** public→private but **never widened** private→public; any attempted widening is **refused explicitly** — never silently coerced, ignored, normalized into success, treated as ordinary validation success, or partially applied — **before persistence mutation**, and **distinguishable from** malformed content, stale input, timestamp-advancement failure, lifecycle failure and storage failure, with the **error-code name left as an ordinary downstream implementation choice**; a future **partial** administrative-edit input **must distinguish preserve/not-supplied, explicitly-remove and supply-a-value**, and a representation collapsing any two is insufficient; the policy governs **`OP-6`, `FR-ADM-04`, `FR-ADM-10b` and any later equivalent path**, **no role may override** it, the **already-merged `OP-6` path does not currently enforce it** and that gap must be closed by separately authorized work; and the decision is to be recorded in a **new ADR**, with **`ADR-017`'s historical text left unrewritten** |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision |
| **Related open questions** | **Depends on:** nothing unresolved. Every rule it rests on is already in force — **`OQ-7`** (**Decided**; the public projection and what is never public), **`FR-DATA-11c`** and **`FR-DATA-06b`** with the **`ADR-017` Q-4 ruling** (business designates at submission, default private; administrators restrict only; new or replacement values default private without inheriting; approved-listing designation changes travel the revision workflow — issue #135), **`ADR-017` `PS-2`** (fail-closed designation default), **`ADR-017` `PS-3`–`PS-6`** (complete proposed content sets; approved rows removed on application), **`FR-VAL-04`/`FR-VAL-05`/`VR-6`** (validation parity; **no** prescribed normalization machinery), **`DI-6`/`NFR-DATA-05`** (strictly-increasing `lastUpdatedAt`), **`ADR-024`** (the `FR-ADM-04` and `OP-6` transaction protocols). **Must NOT answer:** any **normalization or canonicalization policy** for postal code, phone, email or website; the **concrete partial-edit input or transport representation** that would satisfy the three-state requirement; the **`ListingContent` shape**; the **result-code names** and domain error taxonomy; **`OP-6` enforcement**, **`FR-ADM-04` persistence** and **`FR-ADM-10b`** implementation; **authorization** (`FR-AUTH`) and the **administrator conflict message**; **`OQ-14`/`NOQ-8`/`DDM-7`/`S-8`** audit-entry storage; **`OQ-4`/`S-4`/`DDM-4`** searchable fields, indexing and text search; **`OQ-12`** duplicate resolution; **`OQ-13`** purge scheduling and execution; **`DDM-2`**'s revision-identity domain type and public identity transport; the **public projection form**; `DG-3`, `DG-4` |
| **Supersedes** | *none* — **`ADR-017` is not superseded.** It **deferred** this decision deliberately, listing *"what counts as a 'replacement' value"* and *"restriction-only designation enforcement"* in its *Deferred implementation details and dependencies* table, and this ADR **fills that deferral prospectively** rather than revising it. `ADR-021` is likewise not superseded; its record that **replacement-value semantics remained outstanding** is accurate history and stays as written |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-17 (issue #203). In force; later work may rely on it.**
> **It authorizes no implementation.** No domain operation, result code, comparison routine,
> normalization, `OP-6` enforcement, `FR-ADM-04` or `FR-ADM-10b` persistence, partial-edit
> input, schema, migration, API transport, authorization behaviour, administrator message,
> audit storage, search behaviour, deployment or production execution is created by this
> document or by its acceptance. **Nothing in `src/` changes on the strength of it.**

---

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

The register defines `Proposed` as *"drafted and under review; not yet in force"*. This document was never in that state.

1. **Issue #203 was opened as a decision issue** by the Scope Gate after PR #202, precisely because `ADR-017` had deferred the question and `ADR-021` recorded it as still outstanding. It framed three alternatives per question, marked no recommendation binding, and requested a ruling.
2. **The Product Owner ruled on issue #203 on 2026-10-17**, answering all three questions, and then **clarified the ruling on the same issue** — in the same comment, updated in place — resolving the two observations the ruling had left open.
3. **This document was drafted afterwards**, to record a decision already taken.

So `Proposed` would be false: the decision was in force before the draft existed. This follows the precedent of **`ADR-019`, `ADR-020`, `ADR-021`, `ADR-022`, `ADR-023` and `ADR-024`**, each `Accepted` directly on the same ground — the binding ruling preceded the document.

**Next-number status, confirmed independently.** `ADR-024` is the highest numbered ADR file in `docs/adr/`, the register's last listed decision, and the highest number referenced anywhere in the repository. No `ADR-025` file, branch, pull request or reference existed before this unit. `ADR-025` is therefore the next unused number, and no number is reused.

---

## Why an ADR, and not implementation notes alone

`docs/adr/README.md` requires one when a decision is structural, costly to reverse, cross-cutting or contested — **and whenever implementation forces a decision the chain did not make (`IP-9`)**. All five apply.

| Criterion | Assessment |
|---|---|
| **Structural** | It fixes how designation-bearing values are **compared** and how their designations are **derived** on every governed write path, and it imposes a **three-state requirement** on any future partial-edit boundary. It adds no component and no stored shape, but it constrains the contract of every path that proposes or applies such a value. |
| **Costly to reverse** | Reversal would change domain behaviour, persistence validation, the tests that pin it, the transport input representation, and — most consequentially — **privacy outcomes for values a business withheld**. Undoing it means re-arguing the privacy posture, not just editing code. |
| **Cross-cutting** | `OP-6` pending-revision creation, `FR-ADM-04` direct administrative editing, `FR-ADM-10b`'s atomic path, the inputs of the public projection, and the eventual administrator interface all live with it. |
| **Contested** | Genuinely. A reasonable engineer would define "replacement" by semantic equivalence rather than exact carriers, or would coerce a disallowed widening to private rather than refuse it. Both are defensible; see *Alternatives considered*. |
| **Implementation forces a decision the chain did not make (`IP-9`)** | **Exactly this case.** `ADR-017`'s deferral table states that each deferral *"names the implementation it blocks and must be resolved before that implementation"*, and names `OP-6`/`FR-ADM-04` write paths. Writing the domain operation without this decision would have settled product privacy policy inside a diff. |

**`ADR-017` is the source of the deferral and is left unrewritten.** Its historical text — the Q-4 ruling, the `PS-2` fail-closed default and the deferral table — remains authoritative for what was decided in 2026-09 and what was consciously postponed. `ADR-021`'s record that *"replacement-value semantics"* remained outstanding is likewise accurate history and stays as written. `ADR-024` already anticipated this document by listing *"replacement-value semantics and the restriction-only designation (`ADR-017` deferrals)"* among the questions it **must not** answer.

---

## Context

**What `ADR-017` decided, and what it deliberately did not.** The Q-4 ruling (issue #135) settled designation *authority and defaults*: the business chooses public or private for each supplied contact value and for a supplied postal code, **at submission**, with the **default private**; an administrator may **restrict** a value's visibility but **cannot make a business-withheld value public**, and approval alone never grants public visibility; a **new or replacement** value **defaults to private** and does **not inherit** the replaced value's designation; and a designation change to an **approved** listing travels the existing revision workflow (`FR-ADM-10`, `FR-ADM-10b`) rather than a direct edit. `ADR-017` `PS-2` makes absence fail-closed in the store, and `publicProjectionOf` publishes a value only where its designation is exactly `true`.

**Two things it listed as deferred.** `ADR-017`'s *Deferred implementation details and dependencies* table, whose preamble states that each deferral *"names the implementation it blocks and **must be resolved before that implementation**"*, contains:

| Deferred detail | Blocks |
|---|---|
| **What counts as a "replacement" value** for designation non-inheritance (Q-4) | Implementing `OP-6`/`FR-ADM-04` write paths and revision creation where a value changes |
| **Restriction-only designation enforcement** (Q-4) | The same write paths |

`ADR-021` recorded the same gap in its own summary of what `ADR-017` left open: *"**Still outstanding:** the isolation level for revision transactions and **replacement-value semantics**."* The isolation half was filled by `ADR-024` (issue #189). This half was not.

**The state of the code when this decision was taken.** Verified on `main` at `e26cd79`:

- **No domain operation enforces either Q-4 rule.** `designatedPublic` appears in exactly three non-test places: the `DesignatableValue` type, the public projection's read, and a type-readability check in `revision.ts`. `admitPendingRevision` contains no designation logic.
- **`OP-6` persistence exists and does not enforce them.** `createPendingRevision` (issue #195, merged by PR #196) performs no designation comparison; it accepts the caller's designation as given. This was **knowingly deferred**, and `docs/traceability-matrix.md` records for `OP-6` that *"designation-restriction enforcement and the `FR-ADM-10b` atomic path remain pending"*.
- **No normalization is governed for any designation-bearing field.** For postal code, phone, email and website, `FR-VAL-05` prescribes *"no regular expression, validation library, UI widget, schema type, database constraint, country-specific phone format, URL parser, or email-validation algorithm"*. The one place canonicalization was ever considered — `ADR-021`'s category keys, implemented under issue #175 — records that **nothing is normalized**.
- **`OP-6` carries a complete proposed content set, not a patch.** `ADR-017`: *"Complete set, not a difference. A complete proposed set is validated against the same rules as a submission … without reconstructing it from the listing."*
- **There is no partial administrative-edit input.** `FR-ADM-04` is unimplemented, and `ListingContent`'s designatable fields are optional, so `undefined` cannot today be distinguished from "explicitly cleared" at the domain boundary.

**What the ruling does and does not do.** It closes the policy question. It implements nothing.

---

## Decision

### A. Exact comparison; no new normalization

1. **Compare the stored and proposed carriers exactly.**
2. **Exact equality means unchanged.**
3. **Any difference means replacement.**
4. **No new normalization is authorized**, and none is implied by the phrase *"governed normalization and equality semantics"*.
5. The following are **explicitly prohibited** as part of the comparison: **trimming**, **case-folding**, **punctuation removal**, **phone-digit comparison**, **URL parsing**, **email normalization**, or **any other inferred canonicalization**.
6. A **future normalization policy would require separately governed work** and **must not be inferred** from this ADR or from the ruling it records.

This ADR states the rule explicitly rather than referring to normalization machinery that does not exist, which the clarification requires of it in terms.

### B. Complete-content semantics — all five cases

For **each** designation-bearing field in `OP-6`'s **complete** proposed content, every field position participates in comparison with the current listing:

| Current | Proposed | Classification | Designation consequence |
|---|---|---|---|
| present | **exactly equal** | **unchanged** | may be **preserved** or **restricted** public→private; **never widened** private→public |
| present | **absent** | **explicit removal** — **not** omission and **not** preservation | **no designation remains** for the removed value; the removal stays **subject to any separately governed field-requiredness rule** |
| **absent** | present | **addition, and therefore a replacement** | **defaults to private**; **cannot be made public** through `OP-6` |
| **absent** | **absent** | **unchanged** | — |
| present | present, **not exactly equal** | **replacement** | **defaults to private**; **does not inherit** the current value's public designation |

### C. Partial-edit omission

1. **Omission means preserve** — and **only** at an operation boundary that can explicitly represent *"not supplied"* or *"preserve the existing field"*.
2. Omission **preserves both the existing value and its existing designation**.
3. Omission must **not** remove the value, create a replacement, change its designation, silently privatize it, or make it public.
4. A future **partial** administrative-edit input **must distinguish three states** for every optional designation-bearing field: **preserve / not supplied**, **explicitly remove**, and **supply a value**.
5. A representation that **collapses any two of these states is insufficient** to implement `FR-ADM-04` honestly, and **must be resolved before that boundary is implemented**.
6. This **does not require changing `ListingContent`** in this documentation unit, and authorizes no implementation.

**Absence inside a complete proposal is never a patch-style omission.** Because `ADR-017` defines `OP-6`'s proposal as a complete content set rather than a difference, section B governs it and section C does not.

### D. Restriction-only behaviour

1. **Every actual replacement defaults to private.**
2. A replacement **never inherits** a public designation.
3. An **unchanged** value **may preserve** its existing designation.
4. An **unchanged public** value **may be restricted** to private.
5. A **private** value may **never be widened to public** through a governed operation.
6. A **replacement** may **never be made public** through a governed operation.
7. **No role may override** these rules.

### E. Refusal behaviour

1. An attempted designation **widening** from private to public is **refused explicitly**.
2. It is **not** silently coerced to private, **not** ignored, **not** normalized into success, **not** treated as ordinary validation success, and **not** partially applied.
3. The refusal occurs **before persistence mutation**.
4. The refusal remains **distinct from**: **malformed content**, **stale input**, **timestamp-advancement failure**, **lifecycle failure**, and **storage failure**.
5. The exact **error-code name remains an ordinary downstream implementation choice**, provided the distinction stays **explicit and testable**.
6. **A refused operation advances no timestamp and writes nothing.**

### F. Applicability

The policy governs, consistently:

1. **`OP-6`** pending-revision creation.
2. **`FR-ADM-04`** direct administrative editing.
3. **`FR-ADM-10b`**'s atomic administrative path.
4. **Any later equivalent operation** that proposes or applies replacement designation-bearing values.

**None of those paths may expose a public designation widening or publish a replacement value.** These are privacy restrictions on administrative and revision **write** paths. They authorize **no** public API for changing designations, **no** public exposure of private values, **no** automatic publication, **no** administrator override and **no** public notification.

---

## Consequences

### Advantages

- **Privacy-safe replacement behaviour.** A value the business withheld cannot become public through any governed administrative path, and a changed value starts private regardless of what the previous value allowed.
- **No accidental inheritance of a public designation.** The one mistake with the worst outcome — a new value quietly adopting the old value's publicity — is structurally impossible.
- **Exact comparison is implementable today without inventing normalization.** It needs no library, no parser and no canonical form, so it adds no machinery the chain has not governed.
- **Caller mistakes are visible rather than silently rewritten.** An administrator who attempts a widening is told, which matches `FR-VAL-03`'s *"never silently dropped"* and `FR-CONF-04`'s requirement that a confirmation state the resulting state.
- **Complete proposals and future patch inputs have explicit, different semantics**, so neither boundary inherits the other's reading by accident.

### Costs and tradeoffs

- **Exact comparison may classify formatting-only changes as replacements.** Re-typing `+353 21 123 4567` as `+353 21 1234567` is a replacement and becomes private, even though a human would call it the same number. This is the deliberate cost of refusing to invent normalization.
- **Replacements that look semantically similar still become private**, so an administrator correcting a typo in a public contact value must expect it to be withheld until the business re-designates it.
- **A partial-edit transport requires a three-state representation**, which is more work than an optional field and must be designed before `FR-ADM-04` is built.
- **The existing `OP-6` persistence needs separately authorized enforcement.** Acceptance of this ADR does not make the merged path compliant.
- **Domain, persistence, API and tests must each carry the explicit distinctions** of section E rather than folding a widening attempt into generic validation failure.
- **Future normalization would require a new governed decision**, so a later desire for forgiving comparison cannot be met inside an implementation unit.

---

## Alternatives considered

Each was a reasonable position. **None is rejected as technically invalid**, and every rationale is preserved (`IR-6`).

| Alternative | Its genuine advantage | Why it was not selected for this product |
|---|---|---|
| **Any supplied value counts as a replacement** | The strongest privacy posture available, and the simplest rule to state and test: touch a designatable field and it resets to private. No comparison with stored state is needed at all, which removes a read from the write path. | Rejected as **more destructive than the policy requires**. `FR-DATA-11c` ties non-inheritance to a *"new or replacement"* value, not to the act of supplying one; under this rule a complete proposal that merely restates every current value would privatize a listing's whole public contact set, which is a behaviour no governed requirement asks for. |
| **Only semantic or canonical differences count as a replacement** | The most forgiving to administrators, and arguably the most faithful to intent: re-typing the same phone number with different spacing is not really a change, and treating it as one surprises the operator and loses a designation the business chose. | Rejected because it **requires normalization the chain has not governed**. `FR-VAL-05` prescribes no parser, library or canonical form for any of these fields, so "semantically equal" has no definition to appeal to; inventing one here would decide a normalization policy inside a privacy ADR, and getting it wrong leaks a withheld value. It remains the right answer **if** a normalization policy is ever separately ruled. |
| **Silently coerce a public request to private** | Maximally safe and never blocks an administrator: the edit succeeds, the privacy rule still holds, and nobody has to handle a new failure. | Rejected on the **confirmation posture**. `FR-CONF-04` requires an unambiguous statement of the resulting state and `FR-VAL-03` that nothing is silently dropped; reporting success while discarding what the caller asked for confirms a state that is not the resulting state. `ADR-023` took the same view of a stale write — *"rejected outright, never automatically refreshed, merged or overwritten"*. |
| **Inherit the prior designation for replacements** | Least surprising to an administrator correcting a public value, and preserves a deliberate business choice across an edit the business did not ask for. | Rejected because it **contradicts the Q-4 ruling** in terms — *"a new or replacement contact value or postal code defaults to private and does not inherit the replaced value's designation"* — and because inheritance is exactly how a value the business never designated could become public. |
| **Treat absent values in a complete proposal as patch omission** | Would let one input shape serve both complete proposals and partial edits, avoiding a second representation and some duplicated validation. | Rejected because it **contradicts `ADR-017`'s definition of the proposal** as *"a complete set, not a difference"*, and because the collapse is unsafe in the dangerous direction: an absent field would silently preserve a public value the administrator believed they had removed. |
| **Collapse preserve and remove into one optional representation** | Simplest possible input type — one optional field per value, no sentinel, no wrapper — and it matches how `ListingContent` is already shaped. | Rejected as **insufficient to express the policy**. With two states for three meanings, either removal becomes unreachable or omission silently removes; both are privacy-relevant, and the clarification requires the boundary be designed before `FR-ADM-04` is implemented. |
| **Permit an administrator override** | There are real moderation situations — a business that asks by telephone for its number to be published — where a human judgement is more useful than a rule. | Rejected because **`FR-DATA-11c` gives the designation authority to the business**, approval alone never grants public visibility, and `ADR-017` records that *"no later-publication route is deferred or selected … adding one would be a new product decision"*. The legitimate path is for the business to designate the value, not for an administrator to override. |
| **Amend `ADR-017` instead of writing `ADR-025`** | Keeps one document authoritative for the whole physical listing design and avoids a reader having to assemble the rule from two places. | Rejected to **protect historical integrity**. `ADR-017` is the record of what was decided in 2026-09 **and of what was deliberately deferred**; rewriting its decision text would erase the deferral this ADR exists to fill, and the ruling directs that it *"remains authoritative as the source of the deferral"* while `ADR-025` resolves it prospectively. This also follows how `ADR-023` and `ADR-024` filled their own `ADR-017` deferrals. |

---

## Implementation status and non-authorization

**`ADR-025` records policy only.** Stated plainly, because acceptance is routinely mistaken for delivery:

1. **The designation policy is not currently enforced by `OP-6`.** `createPendingRevision` performs no designation comparison, and `admitPendingRevision` contains no designation logic.
2. **`FR-ADM-04` is not implemented.** No direct administrative-edit operation exists in the domain or at `C9`.
3. **`FR-ADM-10b` is not implemented.**
4. **The future partial-edit input does not exist**, and no three-state representation has been designed.
5. **No new normalization exists**, for any field.
6. **No new result code exists.**
7. **No domain, persistence, schema, migration, transport, authorization, administrator-interface, audit, search, deployment or production behaviour is authorized by this ADR.**
8. **Each implementation unit requires its own Scope, Development and Release Gates.**

---

## Sequencing

The dependency chain this decision sits in. **Steps 3 to 7 are not part of this unit and must not be combined with it.**

| # | Step | Status |
|---|---|---|
| 1 | **Product policy ruled** — issue #203 | **Done** (2026-10-17) |
| 2 | **`ADR-025` records the policy** — this unit | **This document** |
| 3 | **Pure-domain designation enforcement** | Not started; needs its own Scope Gate |
| 4 | **`OP-6` enforcement reconciliation** — closing the gap on the merged path | Not started |
| 5 | **`FR-ADM-04` persistence** | Not started; also needs the three-state input boundary designed |
| 6 | **`FR-ADM-10b` atomic path** | Not started |
| 7 | **Transport and administrator messaging** | Blocked on their own unresolved decisions — `FR-AUTH` authorization, the `ADR-023`/`ADR-024` administrator conflict message, and `OQ-14`/`NOQ-8`/`DDM-7` audit storage |

---

## Assumptions

| | If it proves false |
|---|---|
| The four designation-bearing fields remain postal code, phone, email and website (`FR-DATA-11c`, `FR-DATA-06b`) | A new designatable field inherits these rules automatically; no change to this ADR is needed unless the field has a governed canonical form |
| No normalization is governed for those fields | The comparison rule in section A would be revisited by the **separately governed** normalization decision, not by an implementation unit |
| `OP-6`'s proposal remains a complete content set (`ADR-017`) | Section B's case analysis would need re-reading against whatever replaced it, and section C's boundary requirement would apply instead |

## Risks

| Risk | Mitigation |
|---|---|
| An implementer reads *"governed normalization"* in the original ruling as licence to add trimming or case-folding | Section A prohibits each one by name, and the clarification required this ADR to say so explicitly rather than gesture at machinery that does not exist |
| A widening refusal is folded into a generic validation failure, losing the distinction | Section E lists the five failures it must stay distinct from, and requires the distinction be **explicit and testable** |
| The merged `OP-6` path is assumed compliant because this ADR is `Accepted` | The *Implementation status* section states the gap, and the ruling records that it *"does not retroactively claim enforcement exists"* |
| A partial-edit input ships with two states, making removal unreachable or omission destructive | Section C makes three states a precondition of implementing `FR-ADM-04` |

## Open questions this decision must NOT answer

Any **normalization or canonicalization policy** for postal code, phone, email or website · the **concrete partial-edit input or transport representation** satisfying the three-state requirement · the **`ListingContent` shape** · **result-code names** and the domain error taxonomy · **`OP-6` enforcement**, **`FR-ADM-04` persistence**, **`FR-ADM-10b`** implementation · **authorization** (`FR-AUTH`) and the **administrator conflict message** · **`OQ-14`/`NOQ-8`/`DDM-7`/`S-8`** audit-entry storage · **`OQ-4`/`S-4`/`DDM-4`** searchable fields, indexing and text search · **`OQ-12`** duplicate resolution · **`OQ-13`** purge scheduling and execution · **`DDM-2`**'s revision-identity domain type and public identity transport · the **public projection form** · `DG-3`, `DG-4`.

**No unrelated deferred decision is discharged by this ADR.** `ADR-017`'s remaining deferrals — the public projection form, purge scheduling, identity-generation locus, and migration naming and contents — are untouched, as are `DDM-3`'s successors and every open `OQ`.

## Traceability

| | |
|---|---|
| **Decision source** | Issue #203 — the Scope Gate that framed the alternatives and requested a ruling; the Product Owner's binding ruling of 2026-10-17 and its clarification, recorded in that issue's single comment |
| **Fills** | `ADR-017`'s deferrals *"what counts as a 'replacement' value"* and *"restriction-only designation enforcement"* (Q-4) |
| **Rests on** | `FR-DATA-11c`, `FR-DATA-06b`, `FR-ADM-04`, `FR-ADM-05`, `FR-VAL-03`, `FR-VAL-04`, `FR-VAL-05`, `VR-6`, `FR-CONF-04`, `DI-6`, `NFR-DATA-05`, `NFR-PRIV-02`, `NFR-PRIV-05`; `OQ-7` (**Decided**); `ADR-017` (Q-4, `PS-2`, `PS-3`–`PS-6`, and the deferral table), `ADR-021` (the outstanding-semantics record), `ADR-023` (the refusal posture precedent), `ADR-024` (`OP-6` and `FR-ADM-04` transaction protocols) |
| **Documents amended by this unit** | `docs/adr/README.md` (register row; decisions-in-force count nineteen → twenty), `docs/08-data-model.md` (the `DDM-6` row's outstanding list), `docs/09-api-design.md` (the `OP-6` designation paragraph, which used *"adds or replaces"* without a definition), `docs/traceability-matrix.md` (the ADR register and the `OP-6` row), `src/data/README.md` (the `DDM-6` and `DDM-8` outstanding lists) — **current-status statements only** |
| **Inspected and deliberately not amended** | **`ADR-017`** and **`ADR-021`** — historical integrity; `ADR-017` is the source of the deferral and `ADR-021`'s outstanding-semantics record is accurate history. **`ADR-019`**, **`ADR-022`**, **`ADR-023`**, **`ADR-024`** — dated records; `ADR-023`'s *"still deferred"* line and `ADR-024`'s *"must NOT answer"* list were true when accepted. **`docs/05-functional-requirements.md`** — `FR-DATA-11c` and `FR-ADM-04` state the Q-4 **rule**, which is unchanged, and make no claim about the definition being open. **`docs/13-decision-log.md`** — its only mention sits inside the **`ADR-023` decision row**, a dated statement of what was outstanding on 2026-10-12; `ADR-024`'s own documentation unit left that row untouched when it filled the isolation-level half, and this unit follows that precedent rather than editing another decision's record. **`src/domain/README.md`** and **`src/data/migrations/README.md`** — neither makes a designation or replacement claim. Migrations `001` and `002`, and every source and test file |
