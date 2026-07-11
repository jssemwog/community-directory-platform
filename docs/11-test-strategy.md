# Community Directory Platform — MVP Test Strategy

## Purpose and scope

This document defines **how the MVP will be verified** — what must be proven true before
the Community Directory Platform is put in front of a community, how that proof is
organised, what a person must judge rather than a machine, and what **cannot honestly be
tested yet** because the decision it depends on has not been made.

**What this document is.** A *strategy*: the categories of verification, the properties
that must hold, the levels at which each is best proven, the split between human judgment
and automation, and the criteria by which a release is judged ready. It is written so that
acceptance criteria, test cases, an automation plan, and a release checklist can each be
derived from it.

**What this document is not.** It selects no testing framework, browser-automation tool,
test runner, assertion library, mocking library, CI system, cloud service, or hosting
provider. It contains no test code, test cases, scripts, fixtures, mocks, schemas, or API
specifications. It defines **no coverage percentage**, **no formal test pyramid**, and no
tool-specific automation architecture — for reasons given under *Testing principles*.

**The distinction that governs the document.** A *strategy* says "the public read path
must be proven incapable of returning a non-approved record, and that proof must attempt
every route by which it could." A *test case* says "given a pending listing with identity
X, requesting it returns the not-available outcome." The first is a commitment about what
must be true; the second is one instance of demonstrating it. This document produces the
first, and makes the second possible.

**The hazard specific to this document, and it is the sharpest one yet.**

> **A test is a stronger commitment than a schema, a contract, or a screen.**

A data model can *suggest* an answer. An API contract can *imply* one. A test **enforces**
one — it asserts what the system must do and fails the build when reality disagrees. An
assertion that the required fields are *name, category, description and city* does not
merely hint at an answer to `OQ-8`; it **installs** that answer in the build pipeline,
where it will be defended by every future engineer who sees the test go red.

So the discipline of `docs/08`, `docs/09` and `docs/10` — leave the seams open — becomes
*stricter* here, not looser. Every unresolved question is recorded in an explicit
**cannot-test-yet register**, and **no test is committed that would decide one.**

**The mini lab's verification approach is not inherited.** The prototype was checked by a
human looking at rows in a database console. That is not a test strategy; it is the
*absence* of one, and its absence must not arrive by default (`docs/07` R-10, `docs/08`
R-2, `docs/09` R-A2, `docs/10` R-U5).

---

## Source documents

- [`docs/01-vision.md`](./01-vision.md) — **trust over volume.** The property this whole
  strategy exists to protect.
- [`docs/02-stakeholders.md`](./02-stakeholders.md) — visitors, listers, administrators,
  maintainers.
- [`docs/03-mvp-scope.md`](./03-mvp-scope.md) — the approved capability set; anything
  outside it is out of test scope too.
- [`docs/04-user-journeys.md`](./04-user-journeys.md) — **V1–V7, L1–L4, A1–A7**.
- [`docs/05-functional-requirements.md`](./05-functional-requirements.md) — the testable
  behaviors, and `OQ-1`–`OQ-15`.
- [`docs/06-non-functional-requirements.md`](./06-non-functional-requirements.md) — the
  qualities, and `NOQ-1`–`NOQ-9`.
- [`docs/07-system-architecture.md`](./07-system-architecture.md) — the trust boundaries.
- [`docs/08-data-model.md`](./08-data-model.md) — invariants `DI-1`–`DI-9`, rules
  `VR-1`–`VR-7`, slots `VR-S1`–`VR-S6`, seams `S-1`–`S-11`.
- [`docs/09-api-design.md`](./09-api-design.md) — operations `OP-1`–`OP-11`, principles
  `P1`–`P7`, rules `AA-*`, `AP-*`, `AV-*`.
- [`docs/10-ui-design.md`](./10-ui-design.md) — screens `S1`–`S7`, rules `UP-*`, `UV-*`,
  `UA-*`, and the state matrix.

---

## Testing principles

**T1 — Test the properties, not just the features.**
"A visitor can browse approved listings" is a feature, and confirming it proves almost
nothing about trust. "**No route exists by which a visitor reaches a non-approved
record**" is a property, and it is the reason the product deserves to exist. Properties are
tested by *attempting to violate them*, from every direction — not by confirming the happy
path works.

**T2 — Boundary protection is the product, not a later security pass.**
The moderation boundary is not a feature that could be deferred; it is the thing that makes
a directory trustworthy (`docs/01`). Verification of it is therefore **central and
first-class**, tested at every level, and not a "security testing" phase bolted on before
release.

**T3 — Negative space is first-class.**
Empty, loading, error, validation and confirmation states are where an MVP is actually
judged (`docs/10` **U3**). A suite that tests only success paths will pass on a product
that tells visitors a thriving business does not exist.

**T4 — A test must never decide an open question.**
Where a behavior depends on an unresolved decision, the strategy records it as
**cannot-test-yet** and stops. It does not "assume the obvious answer for now" — because a
test written on an assumption is that assumption, enforced, in CI.

**T5 — Prefer the level at which a property is *actually* guaranteed.**
A boundary enforced on the server is not proven by a UI test — the UI could hide a control
while the server still permits the action (`docs/10` **U2**). Test each property where it
is *enforced*, then test that the surface above it behaves consistently.

**T6 — Automate what is objective; have a human judge what is not.**
Whether a pending record can be retrieved is a fact, and a machine should check it on every
change. Whether an error message is *understandable*, whether a screen-reader announcement
is *coherent*, whether microcopy misleads — these are judgments, and pretending an assertion
covers them is how products ship with technically-correct, humanly-useless states.

**T7 — No coverage percentage, no pyramid, no tool architecture.**
Coverage measures lines executed, not properties preserved: a suite can reach ninety percent
while never once attempting to fetch a pending record. A number would become the goal, and
the goal would be met without the product being safe. This strategy commits to **named
properties that must be proven**, which is both stricter and harder to fake.

---

## Test strategy overview

**Verification is organised around three questions**, in descending order of what a failure
would cost:

| | Question | If it fails |
|---|---|---|
| **1. Boundaries** | Can anything reach the public that should not, or can anyone act who should not? | **Trust is destroyed.** A leaked pending submission or an unauthorised approval is unrecoverable reputationally. |
| **2. Behavior** | Does each approved journey work — including its failures, its emptiness, and its errors? | The product is unusable, or quietly lies to people. |
| **3. Qualities** | Is it accessible, usable on a phone, and honest about its states? | The product excludes people it exists to serve. |

**Boundaries are tested first and hardest**, and the reason is asymmetry: a broken feature
is a bug someone reports and you fix; a leaked pending record cannot be un-leaked, and a
community's trust cannot be restored by a patch release.

---

## Boundary invariants to protect

**These are the properties the product exists to guarantee.** Each is stated as something
that must be *proven impossible*, because that is how a property is tested — by trying to
break it, not by confirming it holds in the easy case.

| ID | Invariant | Must be proven impossible | Source |
|---|---|---|---|
| `BI-1` | **Approved-only public visibility.** | Reaching a pending, rejected, or (if it exists) removed record through **any** public route: browse, search, filter, direct reference by identity, a count, a hint, an ordering artefact, or an error message. | `FR-VIS-02`, `DI-5`, `docs/09` **P2** |
| `BI-2` | **The public write path cannot produce an approved record.** | Submitting a listing that arrives in any status other than *pending*; supplying status, timestamps, or any administrative field and having it accepted. | `FR-AUD-04`, `DI-4`, `docs/09` **P3**, `AV-8` |
| `BI-3` | **Search scope never exceeds publication scope.** | Obtaining a match against a field that the detail view would not show — i.e. using search as an oracle to confirm a withheld value. | `docs/09` **P5**, `docs/10` `UP-5` |
| `BI-4` | **No public output discloses a non-approved record's existence.** | Distinguishing *never existed* from *pending* from *rejected* from *removed*, by any observable difference — message text, timing, count, or response shape. | `NFR-SEC-02`, `docs/09` `AP-6`, `docs/10` `UP-4` |
| `BI-5` | **No administrative capability without an authorized identity.** | Performing any administrative action — view queue, view record, edit, approve, reject — unauthenticated, or learning anything from being refused. | `NFR-SEC-01/02`, `docs/09` `AA-1`–`AA-5` |
| `BI-6` | **Administrative data never appears publicly.** | Observing status, submitted-at, last-updated, review attribution, or a moderation note through any public surface. | `FR-DATA-11`, `NFR-PRIV-01/03`, `docs/10` `UP-2` |
| `BI-7` | **Publication is atomic, and never partial.** | Observing a record that is approved but incompletely written, or content updated without status, or any state between. | `NFR-DATA-03`, `DI-3` |
| `BI-8` | **Every record has exactly one valid status, changed only by a permitted transition.** | Producing a record with no status, two statuses, an undefined status, or one reached by a transition the lifecycle does not permit. | `NFR-DATA-01/02`, `DI-1`, `DI-2` |
| `BI-9` | **The UI is not the boundary.** | Performing a forbidden action by bypassing the interface — because a hidden control is a courtesy, not a protection. | `docs/07`, `docs/09` `AA-5`, `docs/10` **U2** |

**`BI-9` deserves its own sentence, because it dictates *how* the others are tested.** If
every boundary test drives the user interface, then the suite proves only that *the UI does
not offer* the forbidden action. It proves nothing about whether the system *permits* it.
Boundary invariants must be exercised **at the level where they are enforced** (**T5**) —
against the operation, not the screen — and the UI is then tested separately for behaving
consistently with them.

**`BI-4` is the hardest to test and the easiest to skip**, because its failure is an
*absence* that must be verified. It requires an **equivalence test**: the four cases —
never existed, pending, rejected, removed — must produce outcomes that are
**indistinguishable to an unauthorised observer**. A suite that checks "requesting a pending
listing returns not-available" has *not* tested `BI-4`; it has tested one case. The property
is that the four cases *cannot be told apart*.

---

## Test levels

Named by what they exercise, **not** by any tool or framework, and not arranged into a
prescribed pyramid (**T7**).

| Level | What it exercises | Best for |
|---|---|---|
| **Unit** | One rule or one decision in isolation. | Validation rules; status-transition legality; projection logic — *which fields leave the system for whom*. |
| **Integration** | A component together with its store and its neighbours. | Data integrity (`DI-1`–`DI-9`); atomicity; timestamp semantics. |
| **Operation** | One logical API operation, end to end, exercised directly. | **The boundary invariants.** This is where `BI-1`–`BI-8` are genuinely proven, because it is where they are enforced. |
| **Journey** | A complete user journey through the interface. | V1–V7, L1–L4, A1–A7 — including their failure and empty paths. |
| **Human** | A person using the product, with judgment. | Accessibility experience, microcopy honesty, moderation usability. |

**The operation level carries the weight of this strategy**, and that is a deliberate
departure from the reflex of testing everything through the UI. The invariants live at the
operation boundary; that is where they must be attacked.

---

## Functional testing

**Organised by surface, mirroring `docs/09`'s three surfaces** — because the surfaces are
the security model, and grouping tests by them keeps the boundary visible.

**Public read surface.** Browsing returns approved listings and only those. Criteria
combine (`FR-SRCH-06`) and clear independently (`FR-SRCH-07`). An empty keyword browses
rather than errors (`FR-SRCH-03`). Detail returns one approved listing. Fields with no
value are omitted or clearly indicated, not rendered as blanks (`FR-VIS-05`). Ordering is
consistent (`FR-VIS-03`).

**Submission surface.** A valid submission is recorded as **pending** and is **not
public** (`FR-SUB-*`, `BI-2`). An invalid one is rejected with **field-level** errors and
**preserved input** (`FR-VAL-02/03`). A failed submission leaves **nothing** behind — no
partial record, and no public one (`VR-7`, `FR-SUB-06`). The confirmation states the
*resulting state*, not that something happened (`FR-CONF-01`).

**Administrative surface.** The queue shows pending submissions. A record can be reviewed
in full. Editing changes content and **never** status. Approval publishes; rejection does
not. Both confirm their **outcome** (`FR-CONF-02/03/04`). Administrator edits are validated
by the **same rules** as public submissions — **no privileged bypass** (`FR-VAL-04`,
`VR-6`).

**That last one is a quiet regression waiting to happen, and it deserves a dedicated
test.** Administrative tooling is built second and trusted more; the natural mistake is a
laxer save path for administrators. The property is exact: **an administrator must not be
able to save a record that a lister could not have submitted.**

---

## Non-functional testing

| Quality | Verifiable now | Blocked |
|---|---|---|
| **Security / authorization** | Yes — `BI-5`, `BI-9`. Fully testable. | Credential/session strength: **`NOQ-9`**. |
| **Privacy / data exposure** | Yes — `BI-1`, `BI-4`, `BI-6`. Fully testable **as properties**. | *Which fields* are public: **`OQ-7`**. |
| **Data integrity** | Yes — `BI-7`, `BI-8`, `DI-1`–`DI-9`. The most mechanically testable area in the product. | — |
| **Accessibility** | **Behaviors** yes — keyboard operability, announcement, non-colour status. | **Conformance level and contrast ratio: `NOQ-5`.** No level may be asserted. |
| **Responsive behavior** | Yes — core flows usable at phone size; admin at tablet/desktop. | Device/browser matrix: **`NOQ-6`**. |
| **Usability** | Partly — states are distinguishable and confirmations state outcomes. | *Understandability* is a human judgment (**T6**). |
| **Performance** | **No.** | **`NOQ-1`, `NOQ-4`.** |
| **Availability** | **No.** | **`NOQ-2`.** |
| **Backup / recovery** | **No.** | **`NOQ-3`.** |

**Performance, availability and recovery cannot be tested, and saying so is the honest
finding rather than a gap in this document.** A performance test asserts that something is
fast *enough*; "enough" is `NOQ-1`, and it does not exist. A recovery test asserts data
loss within a tolerance; the tolerance is `NOQ-3`, and it does not exist. **Writing such a
test today would mean inventing the target it measures against** — and an invented target,
once encoded in a passing test, will be cited later as though someone approved it.

What *can* be done now, and should be: **establish that these are measurable** — that the
system can be observed, that a backup can be taken and restored at all. Measurement without
a threshold is legitimate; assertion without a threshold is not.

---

## User-journey testing

**Every approved journey is exercised end to end — including its unhappy paths**, which is
where most of the value is.

| Journey | What must be proven | Notes |
|---|---|---|
| V1 Browse | Approved listings appear; nothing else does. | `BI-1` |
| V2 Search | Keyword narrows results within the approved set. | Scope bounded by `BI-3` |
| V3 / V4 Filter | Category and location narrow results; combine with keyword; clear independently. | Control shape is **open** — `OQ-5`, `OQ-6` |
| V5 Detail | One approved listing opens; **return restores the previous result set**. | `FR-VIS-07` — a requirement, not a nicety |
| **V6 No results** | The no-results state is **distinguishable** from an empty directory and from an error, and offers a way to adjust criteria. | **First-class. Not an edge case.** |
| V7 Inaccurate info | The listing is viewable. **No reporting path is tested** — it does not exist. | **`OQ-1`** |
| L1 Open form | The form is reachable and states that submissions are reviewed. | |
| L2 Submit | Valid submission → pending, not public. | `BI-2` |
| **L3 Correct errors** | Field-level errors; **valid input preserved**; correction succeeds. | **First-class.** |
| L4 Confirmation | States pending **and not yet public**. | `NFR-USA-06` |
| A1 Queue | Pending submissions visible to an authorized administrator; **empty queue is a success state**. | |
| A2 Review | Full record visible, any status. | |
| A3 / A6 Edit | Content changes; status does not; same validation as public. | |
| A4 Approve | Record becomes public **atomically**; confirmation states the outcome. | `BI-7` |
| A5 Reject | Record does not become public; confirmation states the outcome. | |
| A7 Problem content | Handled with **existing** actions — reject, edit. | **No duplicate control tested — `OQ-12`** |

---

## API behavior testing

**This is where the boundary invariants are actually proven** (**T5**), because this is
where they are enforced.

**Per operation** (`OP-1`–`OP-11`): who may call it, what it accepts, what it returns,
what it validates, what it refuses, and what it does on failure.

**The tests that matter most, and would be missed by a suite built around happy paths:**

- **`OP-1` cannot be made to return a non-approved record** — not by a status parameter, not
  by an unknown parameter, not by a malformed one, not by an injected filter expression.
  This is `BI-1` and `docs/09` **P1** ("an operation is a permission, not a query").
- **`OP-2` returns an *indistinguishable* outcome** for never-existed, pending, rejected and
  removed. **A four-way equivalence test.** This is `BI-4`, and it is the single most
  skippable test in the product.
- **`OP-3` refuses administrative fields** rather than ignoring them (`AV-8`) — the request
  is *malformed*, not merely over-specified.
- **`OP-4`–`OP-8` are unreachable unauthenticated**, and the refusal discloses nothing
  (`BI-5`).
- **Administrative idempotency:** approving an already-approved record is a **no-op
  returning current state** — not a second transition, not an error, not a second
  last-updated bump (`docs/09`, `DI-1`/`DI-2`).

**Not tested:** `OP-9` (remove/unpublish) and `OP-10` (approve-a-revision) — **they are
conditional and do not exist** (`OQ-11`, `OQ-10`). Writing a test for either would be
writing the decision.

---

## UI behavior testing

**Tested for consistency with the boundaries — never as a substitute for them** (**T5**,
`BI-9`).

| Screen | What must be proven |
|---|---|
| **S1 Directory** | Approved listings only; criteria combine and clear individually; **three distinct states** — results, no-results, empty directory — plus loading and error. |
| **S2 Detail** | Public projection only; **the not-available message does not distinguish** pending, rejected, removed or nonexistent (`BI-4`); return restores the prior result set. |
| **S3 Form** | Field-level validation; input preserved; **no administrative control exists**; submitting is disabled while in progress. |
| **S4 Confirmation** | States **pending** and **not yet public**; offers no "view your submission" path — **there is none, and there cannot be one** (`DI-5`). |
| **S5 Queue** | Requires authentication; **empty queue reads as success**, not as an error. |
| **S6 Record detail** | Status unmistakable and **not conveyed by colour alone**; moderation note visibly administrative-only. |
| **S7 Edit** | Same validation as the public form; **no approve/reject control present**. |

**A UI test that proves a control is absent has proven nothing about the boundary.** It has
proven the UI is consistent with it. Both are needed; only one is sufficient, and it is not
this one.

---

## Data-model and data-integrity testing

**The most mechanically testable area in the product, and the cheapest to get right.**

| Property | Test |
|---|---|
| `DI-1` | Every record has **exactly one** status at all times — never none, never two, never an undefined value. |
| `DI-2` | Status changes **only** along a permitted transition, and **only** through a defined administrator action. Attempt the forbidden ones and prove they fail. |
| `DI-3` | Every create, edit and moderation action is **all-or-nothing** — and, more strongly, **never partially public**. |
| `DI-4` | Administrative fields are unsettable by a public actor, under any input. |
| `DI-5` | No non-approved record is reachable through any public path. *(= `BI-1`.)* |
| `DI-6` | `submitted at` is **written once and never changes**. `last updated at` changes on **every content *or status*** change. |
| `DI-7` | Stored data reflects the last successful action; no silent loss. |
| `DI-8` | A record's identity is **stable** across every content edit and status change. |
| `DI-9` | A category value always references a member of the predefined set — never free text. |

**`DI-6` hides a test almost everyone forgets.** `NFR-DATA-05` says `last updated at`
changes when content **or status** changes. Therefore **approving a listing must bump the
timestamp even though no content changed.** An implementation that only touches the
timestamp on content edits will pass every obvious test and still violate the requirement.

**`DI-3` is stronger than "atomic".** "Never partially public" constrains write *ordering*,
not merely torn writes: there must be no instant at which a record is *approved* but its
content is incompletely written. A test must therefore look for a *visible intermediate
state*, not only for a corrupted final one.

---

## Security and authorization testing

**Central, not a later phase** (**T2**).

- **`BI-5` — no administrative capability without an authorized identity.** Every
  administrative operation attempted unauthenticated, and refused. Not "the link is hidden"
  — **the operation refuses** (`BI-9`).
- **`BI-9` — the UI is not the boundary.** Forbidden actions attempted *bypassing the
  interface*. If the suite only drives the UI, this property is untested.
- **Denial discloses nothing** (`NFR-SEC-02`) — not whether a record exists, not why access
  failed, not whether an identity was recognised.
- **Input is validated and constrained** so malformed or malicious input cannot corrupt
  stored data (`NFR-SEC-05`, `VR-4`).
- **Every administrative state change is attributable** to exactly one identity
  (`NFR-SEC-01`).
- **Credentials never appear** in storage or logs (`NFR-SEC-08`).

**Not tested — because they are undecided:** anti-spam behavior (**`OQ-9`**), rate limiting
(**`OQ-9`**, `NOQ-4`), and credential/session strength (**`NOQ-9`**). The *absence* of a
safeguard cannot be asserted as correct either — it is simply undecided, and the register
below says so.

---

## Privacy and data-exposure testing

- **`BI-6`** — administrative fields never appear on a public surface: status, submitted-at,
  last-updated, review attribution, moderation note.
- **`BI-4`** — no public output discloses a non-approved record's existence. **Test every
  channel**, not just the listing body: **counts**, **hints or suggestions**, **error
  messages**, **result ordering**, and **response differences**. The leak, when it comes,
  will come from a helpful string.
- **`BI-3`** — the search may not match against a field the detail view withholds. This is
  the **oracle test**: attempt to confirm a withheld value by searching for it.
- **Moderation notes are never public** (`NFR-PRIV-03`).
- **Non-public data is not reachable through a restored backup** (`NFR-BACK-04`) — a
  *measurable* property, though its targets are open.

**What cannot be tested as a field list: `OQ-7`.** The property "only the approved public
field set is exposed" is testable **as a rule** — the response contains no field outside the
approved set. It is **not** testable as an enumeration, because the set does not exist yet.
**A test asserting `[name, category, description, city]` would answer `OQ-7`.** The strategy
commits to the rule and defers the list.

---

## Accessibility testing

**Behaviors are testable now; conformance is not** (`NOQ-5`).

**Testable now** (`NFR-ACC-01..03`, `docs/10` `UA-1`–`UA-6`, `UV-3`/`UV-4`):

- Every core flow **fully operable by keyboard** — browse, search, filter, detail, submit,
  correct errors, administrator review.
- Semantic structure and text alternatives sufficient for assistive technology.
- Status, confirmation and error information **not conveyed by colour alone**, and
  **announced**.
- Validation errors **programmatically associated** with their inputs.
- Touch targets adequately sized and spaced.

**Not assertable: a conformance level or a contrast ratio.** `NOQ-5` leaves the standard and
level open. **An automated accessibility gate that claims a level nobody approved is a false
commitment** — and a false one is worse than an absent one, because it will be cited later
as though it were decided.

**Automation is necessary and nowhere near sufficient here** (**T6**). Automated checks
catch missing labels and contrast failures against *some* threshold. They cannot tell you
whether a screen-reader user can *understand* a validation error, whether the announcement
order is coherent, or whether the keyboard path through the moderation queue is *sane*.
**Those require a person, and preferably one who uses assistive technology.** Treating an
automated pass as an accessibility pass is the most common way products fail exactly the
users `docs/01` promises to include.

---

## Responsive-behavior testing

- **Visitor and lister core flows** usable at phone size: readable text, reachable controls,
  **no horizontal scrolling** for primary content (`NFR-RESP-01`).
- **No core action becomes unreachable** at any smaller size (`NFR-RESP-02`).
- **Administrator flow** usable at **tablet and desktop**. **Phone is not required**
  (`NFR-RESP-04`) — a genuine scoping relief that should be taken.
- Touch targets comfortably operable (`NFR-RESP-03`).

**Not testable: the support matrix.** `NOQ-6` leaves the browsers, devices and assistive
technologies open. Tests can prove behavior **at representative sizes**; they cannot prove
conformance to a matrix that does not exist.

---

## Error, empty-state, loading-state, validation-state, and confirmation-message testing

**The negative space. `docs/10` argued this is where an MVP is judged; this strategy treats
it as first-class** (**T3**).

**Empty states — three, and they must be mutually distinguishable** (`NFR-USA-03`):

| State | Must be proven |
|---|---|
| **Empty directory** | Says the directory has no listings yet — **not** that a search failed. |
| **No results** | Says *the criteria* excluded everything, **shows what was applied**, and offers a way to adjust or clear it (`FR-SRCH-07/08`). |
| **Empty queue** | Reads as **success** — nothing awaits review. |

**Why they must be tested as a set, not individually.** The failure is not that one is
missing; the failure is that **two are the same string**. A visitor shown "No listings
found" on an empty directory retries fruitlessly; one shown "The directory is empty" when a
filter excluded everything leaves believing the platform is worthless. **The test is that
the three are distinguishable** — which no test of any one of them can establish.

**Error states:**

- **A system error must never render as an empty result set.** This is the highest-severity
  usability failure available to this product: it tells a visitor a business is *not in the
  community* when the truth is the platform is broken — a false statement about the
  community, from the platform whose first principle is trust.
- A failed save records **nothing**, and preserves the entered data for retry
  (`FR-ERR-05/06`).
- Errors **leak nothing**: no internal identifiers, no diagnostics, no record content, no
  hint that a non-approved record exists (`BI-4`).
- **The not-available message stays uninformative** (`BI-4`). This string must be treated as
  **security-relevant text** and should be **regression-protected**, because every instinct
  of good UX writing pushes toward making it more helpful.

**Loading states — and note the pattern:**

| Loading state | Must not resemble |
|---|---|
| Directory loading | No-results |
| Detail loading | Not-available |
| Queue loading | Empty queue |
| Submitting | Idle (the control must be disabled) |
| Saving | Idle |

**Every loading state shadows a negative state it must not be confused with.** That is not
a coincidence — it is the failure mode, and it is what the tests must target. Loading must
also be **announced**, not merely animated: to a screen-reader user, a silent transition is
indistinguishable from nothing happening (`NFR-ACC-03`).

**Validation states** (`UV-1`–`UV-7`): field-level; input preserved; not colour-dependent;
announced; programmatically associated with the input; identical rules for administrators.

**Confirmation messages** (`FR-CONF-01..04`, `NFR-USA-05`): each states the **resulting
state**, not that an action occurred. **"Saved" is a failing result.** The tests assert
that a submission confirmation says *pending and not yet public*, that approval says *now
publicly visible*, and that rejection says *will not be published*.

---

## Moderation-workflow testing

**The core loop, and the reason the product is trustworthy.**

- A submission arrives **pending** and is **not public** (`BI-2`).
- An administrator sees it; **no one else can** (`BI-1`, `BI-5`).
- Approve → **public, atomically** (`BI-7`). Reject → **not public**. Edit → **content only,
  status unchanged**.
- Each action **confirms its outcome** and is **attributable** to one identity.
- **Idempotent:** a repeated approve is a no-op, not a second transition.
- **The full sequence:** submit → edit → approve → edit again. The record's **identity is
  stable throughout** (`DI-8`), and its timestamps behave correctly at each step (`DI-6`).

**Decision-dependent and therefore NOT tested:** remove/unpublish (**`OQ-11`**), secondary
review of edits to approved listings (**`OQ-10`**), duplicate marking (**`OQ-12`**),
rejected-submission retention and purge (**`OQ-13`**), audit emission (**`OQ-14`**), and
lister notification (**`OQ-2`**). Each would be a test of a behavior nobody has approved.

---

## Regression testing

**What must never break, and must be guarded on every change.**

- **All nine boundary invariants** (`BI-1`–`BI-9`). These are the regression suite's
  backbone; if any becomes hard to run, that is a defect in the suite, not a reason to skip.
- **The three empty states remain distinguishable.**
- **The not-available message remains uninformative** — protected explicitly, because it is
  the string most likely to be "improved" by someone acting in good faith.
- **Administrator validation parity** (`FR-VAL-04`) — the laxer-admin-path regression.
- **Timestamp semantics**, including the approve-bumps-last-updated case (`DI-6`).
- **Confirmations state outcomes, not occurrences.**

**A regression test for microcopy is unusual, and here it is essential.** Two strings carry
security and trust properties — the not-available message and the submission confirmation —
and both are exactly the sort of text a well-meaning editor improves. They should be
protected as behavior, not left to review discipline.

---

## Exploratory testing

**Structured human curiosity, aimed at the places assertions do not reach.** Time-boxed,
charter-based, and recorded — not "click around".

Suggested charters:

- **Attack the boundary.** Try to see a pending record. Try every route: identity guessing,
  search terms drawn from a known pending submission, ordering artefacts, counts, error
  differences, timing. *An attacker does not use the happy path.*
- **Be an honest submitter having a bad day.** Slow connection, double-click, back button,
  refresh mid-submit, autofill, paste unusual characters. **Does a duplicate appear?**
  (`AQ-1`.)
- **Be a screen-reader user completing the whole submission journey**, including making and
  correcting an error.
- **Be a first-time visitor on a phone** who searches for a business that is not listed. Do
  you understand what happened, and what to do next?
- **Be an administrator with a queue of near-duplicates** and no duplicate tooling
  (`OQ-12`). Where does the workflow hurt?

**Exploratory findings are inputs to the strategy**, not just defect reports — a boundary
route nobody anticipated becomes a permanent regression test.

---

## Manual review areas

**What a person must judge, because a machine cannot** (**T6**).

| Area | Why a human |
|---|---|
| **Microcopy honesty** | Whether the confirmation *actually* leaves a submitter understanding their listing is not public. An assertion can check the words are present; only a person can tell whether they land. |
| **The not-available message** | Whether it reveals anything by implication. This is a **security review of a string**, and it needs judgment, not a matcher. |
| **Empty-state comprehension** | Whether a real person can tell the three states apart and knows what to do next (`NFR-USA-03`). |
| **Assistive-technology experience** | Whether the announcement order is coherent and errors are *understandable* — ideally reviewed by someone who uses assistive technology daily. |
| **Moderation usability** | Whether an administrator can work a realistic queue without mistakes. **The manual-review assumption (A-1) is load-bearing for the whole operating model**; if moderation is painful, the model fails quietly. |
| **Validation generosity** | Whether format rules wrongly reject legitimate international phone numbers or unconventional addresses — which would exclude exactly the small organisations `docs/01` exists to include. |
| **Accessibility judgment** | Everything automation cannot see. |

---

## Automation candidates

**What should be checked on every change, because it is objective and its failure is
costly.**

| Priority | Area | Why |
|---|---|---|
| **Highest** | **`BI-1`–`BI-9`, the boundary invariants** | Objective, catastrophic if broken, and cheap to check continuously. **These are the non-negotiable core of any automated suite.** |
| **Highest** | **Data integrity `DI-1`–`DI-9`** | Purely mechanical; no judgment required. |
| **High** | **Status lifecycle and transition legality** | Attempts at forbidden transitions must fail. |
| **High** | **Validation behavior** — field-level, input preserved, admin parity | Regression-prone. |
| **High** | **The four-way equivalence of `OP-2`'s negative outcome** (`BI-4`) | Easy to break, invisible when broken. |
| **Medium** | **Journey happy paths and their failure paths** | Broad, valuable, more brittle. |
| **Medium** | **Empty/loading/error state distinctness** | The *presence* of distinct states is checkable; their *comprehensibility* is not. |
| **Medium** | **Keyboard operability of core flows** | Objectively checkable. |
| **Supporting** | **Automated accessibility checks** | Necessary, **not sufficient** — and must **not** assert a conformance level (`NOQ-5`). |

**No automation tool, runner, or framework is selected.** What must be *checked* is the
strategy; *how* is a later decision.

---

## Test data strategy

**Principles, not fixtures.**

- **Test data must cover every status** — pending, approved, rejected — because a suite
  containing only approved records **cannot test `BI-1` at all.** It would pass on a system
  with no boundary whatsoever. *This is the single most important sentence in this section.*
- **Include the empty world.** An empty directory and an empty queue are real states with
  real requirements; a suite that always has data never tests them.
- **Include the unusual but legitimate** — long names, non-Latin characters, international
  phone shapes, organisations with minimal contact details. These are the community members
  most at risk of being excluded by over-strict validation.
- **Never use real personal data** in testing (`NFR-PRIV-04`). Submissions contain contact
  details of real people; test data must be synthetic.
- **Test data must not encode an unresolved decision.** A fixture with a `country` field
  quietly asserts `OQ-6`; one marking four fields required asserts `OQ-8`. **Fixtures decide
  questions just as surely as tests do.**

---

## Traceability strategy

**Every test traces upward; every requirement traces downward.** The value is bidirectional:
forward traceability finds untested requirements, and backward traceability finds tests that
serve no requirement — which are either scope creep or a decision someone made without
authority.

| From | To | Purpose |
|---|---|---|
| Test → **journey** (V/L/A) | Proves the journey is exercised — *including its unhappy paths*. |
| Test → **functional requirement** (`FR-*`) | Proves the behavior is verified. |
| Test → **non-functional requirement** (`NFR-*`) | Proves the quality is verified, **or is recorded as blocked**. |
| Test → **API operation** (`OP-*`) | Proves the contract holds. |
| Test → **UI screen** (`S1`–`S7`) | Proves the surface is consistent with the boundary. |
| Test → **data rule** (`DI-*`, `VR-*`) | Proves the invariant holds. |
| Test → **boundary invariant** (`BI-*`) | **The most important trace.** Each `BI` must have tests that *attempt to violate it*. |
| **Seam** (`S-1`–`S-11`) → **cannot-test-yet** | Proves nothing was quietly decided. |

**The seam trace is unusual and is the point.** It is a register of what is **deliberately
unverified**, so that "we have no test for that" is visibly a *decision* rather than an
oversight.

---

## Defect triage

**Severity is judged by what a failure costs, and the ordering is not the conventional
one.**

| Severity | Definition | Examples |
|---|---|---|
| **Critical — boundary** | A boundary invariant is violated. | A pending record is publicly reachable. An unauthenticated actor approves a listing. Search reveals a withheld field. **Ships nothing. Blocks release unconditionally.** |
| **High — trust** | The product **misleads** a user about the state of the world. | A system error renders as an empty list. A confirmation implies a listing is public when it is pending. |
| **High — exclusion** | A core flow is **unusable** for some users. | A core flow unreachable by keyboard. A form unusable on a phone. |
| **Medium — behavior** | An approved behavior is wrong, without misleading or excluding. | Filters do not combine. Return does not restore the result set. |
| **Low — polish** | Cosmetic; no requirement violated. | |

**The unusual placement is deliberate: "the error state looks like an empty list" is
High-trust, not Low-cosmetic.** It is not a display bug — it is the product making a **false
statement about the community** it serves, which is a direct assault on the vision's first
principle. Triage that treats it as cosmetic will let it ship.

**A boundary defect is never negotiated down**, and never traded for a release date. That
is the whole point of naming them separately.

---

## Release-readiness criteria

**Categories of readiness are defined here. The *depth* required is not, and cannot be.**

**Category 1 — Unconditional gates. Non-negotiable, and not tradeable against a date.**

- **All nine boundary invariants (`BI-1`–`BI-9`) are proven**, by tests that *attempt to
  violate them* and fail to.
- **All data integrity invariants (`DI-1`–`DI-9`) hold.**
- **No Critical-boundary defect is open.** Not deferred, not accepted, not documented as a
  known issue — **closed**.
- **Every approved journey (V1–V7, L1–L4, A1–A7) is exercised, including its failure and
  empty paths.**
- **The three empty states are distinguishable**, and a system error does not render as an
  empty list.
- **Confirmations state resulting states**, and the not-available message reveals nothing.
- **Core flows are keyboard-operable**, and public flows are usable at phone size.

**Category 2 — Judgment gates. A person must sign off; a suite cannot.**

- Microcopy reviewed for honesty — with the **not-available message reviewed as
  security-relevant text**.
- Assistive-technology experience reviewed by a human.
- Moderation workflow tried against a realistic queue.
- Validation checked for wrongly excluding legitimate community members.

**Category 3 — Blocked. Cannot be a gate, because the target does not exist.**

- **Performance** — `NOQ-1`, `NOQ-4`.
- **Availability** — `NOQ-2`.
- **Backup and recovery** — `NOQ-3`.
- **Accessibility conformance level** — `NOQ-5`.
- **Browser/device support matrix** — `NOQ-6`.

**These are not optional; they are *unmeasurable*.** They must not be silently dropped, and
they must not be faked by inventing a threshold. Each is a **release risk that has to be
accepted explicitly, by a person, in writing** — or resolved before launch.

### Open question — **testing depth**

> **What testing depth is required before the first public release?**

**This document deliberately does not answer it.** It defines *what* must be proven and
*which categories* gate a release. It does not decide **how exhaustively** — how many
journey variations, how much automation exists on day one versus grows after, whether
Category 2 judgment gates are a formal sign-off or a walkthrough, or how much exploratory
time is enough.

**Why it is left open, rather than guessed:** depth is a cost-and-risk trade-off owned by
the team and the stakeholders, and it interacts with questions nobody has answered —
**expected load (`NOQ-4`) is unknown, so nobody knows how much rides on the first
release.** A depth chosen here would be a guess presented as a requirement.

**What is *not* negotiable regardless of the depth chosen:** the Category 1 gates. Depth
determines *how much more* is done — never whether the boundary invariants are proven.

---

## Cannot-test-yet register

**Deliberately unverified, because the decision has not been made.** This register exists so
that an absent test reads as a **decision**, not an oversight — and so that no test quietly
becomes the decision (**T4**).

| Question | Cannot be tested as a commitment | Testable *as a rule* today? |
|---|---|---|
| **`OQ-1`** report-inaccuracy path | Any reporting behavior — **the path does not exist**. | — |
| **`OQ-2`** lister notification/reference | Any outcome notification, or any lister-facing retrieval. | Yes — that **no** such unauthenticated retrieval exists (`DI-5`). |
| **`OQ-3`** default ordering | A specific order. | Yes — that ordering is **consistent** (`FR-VIS-03`). |
| **`OQ-4`** searchable fields | *Which* fields match a keyword. | **Yes — `BI-3`: search scope never exceeds publication scope.** The relationship is testable; the scope is not. |
| **`OQ-5`** category model | Single vs. multiple selection; who curates. | Yes — a category is always from the predefined set (`DI-9`). |
| **`OQ-6`** location granularity | Whether `state/region` or `country` exist or are required. | — |
| **`OQ-7`** public vs. private fields | **An enumeration of public fields.** | **Yes — as a rule:** no field outside the approved public set is ever exposed. |
| **`OQ-8` / `OQ-8b`** required fields; contact minimum | *Which* fields are required; whether a contact minimum exists. | Yes — that validation **is** field-level, and preserves input, whatever it enforces. |
| **`OQ-9`** anti-spam | Any safeguard behavior — **and its absence cannot be asserted as correct either.** | Yes — that any safeguard must not break keyboard/assistive operability. |
| **`OQ-10`** edit-after-approval | Secondary review, revisions, `OP-10`. | — |
| **`OQ-11`** remove/unpublish | **Any removal behavior — `OP-9` does not exist.** | — |
| **`OQ-12`** duplicate handling | Duplicate detection or marking. | — |
| **`OQ-13`** rejected retention / purge | Any retention period or purge behavior. | — |
| **`OQ-14`** audit logging | **Any audit emission.** *(Note the asymmetry: history not captured cannot be reconstructed later.)* | — |
| **`NOQ-1` / `NOQ-4`** performance / load | **Any performance threshold.** | Only that performance is **measurable**. |
| **`NOQ-2`** availability | Any availability target. | — |
| **`NOQ-3`** backup / recovery | Any recovery point or time objective. | Only that a backup can be taken and restored **at all**. |
| **`NOQ-5`** accessibility standard | **Any conformance level or contrast ratio.** | Yes — the accessibility **behaviors** (`UA-1`–`UA-6`). |
| **`NOQ-6`** browser/device matrix | Conformance to a support matrix. | Yes — behavior at representative sizes. |
| **`NOQ-7`** log retention / sensitive data | What logs may retain. | Yes — that **credentials never appear** in logs (`NFR-SEC-08`). |
| **Testing depth** | How exhaustive verification must be before release. | — |

**The pattern in the right-hand column is the most useful thing in this document.** Many
questions block a *specific* assertion while leaving a *general* one perfectly testable.
`OQ-7` blocks "the response contains name, category, description, city" — but it does **not**
block "the response contains no field outside the approved public set." **The rule is
testable; the list is not.** Writing the strategy against rules rather than lists is what
lets verification start before every product question is answered.

---

## Out-of-scope testing for MVP

Not tested, because the capability is **not in the MVP** (`docs/03`). Listed so their
absence reads as a decision.

| Not tested | Reason |
|---|---|
| Business-owner accounts, sign-in, listing claiming | Out of scope. |
| Reviews, ratings, user-generated-content moderation | Out of scope. |
| Analytics, advertising, payments, events, social features | Out of scope. |
| Native mobile applications | Out of scope. |
| Third-party or partner API consumption | The MVP has one first-party client (`docs/09`). |
| API versioning / cross-version compatibility | No version scheme is adopted (`docs/09` `AQ-5`). |
| Load, stress, soak, capacity testing | **Blocked, not excluded** — `NOQ-1`, `NOQ-4`. |
| Disaster-recovery drills | **Blocked, not excluded** — `NOQ-3`. |
| Penetration testing / formal security audit | Not an MVP commitment. The boundary invariants are tested regardless — they are not a substitute for an audit, and an audit is not a substitute for them. |

**The distinction between *excluded* and *blocked* matters.** An excluded area will not be
tested because the feature does not exist. A blocked area **should** be tested and cannot
be, because its target is undecided. Conflating them is how a missing performance *target*
quietly becomes a missing performance *test*, permanently.

---

## Open questions

**None is resolved here.** Each is listed with its **testing consequence**.

| ID | Question | Testing consequence |
|---|---|---|
| `OQ-1` | Visitor report-inaccuracy path? | No reporting tests. V7 is view-only. |
| `OQ-2` | Lister notification or reference? | No notification tests; the **absence** of unauthenticated retrieval **is** tested. |
| `OQ-3` | Default ordering? | Consistency testable; the specific order is not. |
| `OQ-4` | Searchable fields and matching mode? | `BI-3` testable; the scope is not. |
| `OQ-5` | Category model? | Set membership testable; cardinality is not. |
| `OQ-6` | Location granularity? | No location-field obligations tested. |
| `OQ-7` | Public vs. private fields? | **The rule is testable; the enumeration is not.** |
| `OQ-8` / `OQ-8b` | Required fields; contact minimum? | Validation *behavior* testable; the *rules* are not. |
| `OQ-9` | Anti-spam? | Untestable either way — the absence of a safeguard cannot be asserted correct. The accessibility constraint on any future safeguard **is** recorded. |
| `OQ-10` | Edit-after-approval? | No revision tests. |
| `OQ-11` | Remove/unpublish? | **No removal tests. `OP-9` does not exist.** |
| `OQ-12` | Duplicate handling? | No duplicate tests; an exploratory charter records the pain. |
| `OQ-13` | Rejected retention / purge? | No retention or purge tests. |
| `OQ-14` | Audit logging? | **No audit tests — and the omission is irreversible for every action taken meanwhile.** |
| `NOQ-1`, `NOQ-4` | Performance thresholds; expected load? | **No threshold can be asserted.** |
| `NOQ-2` | Availability target? | No availability target asserted. |
| `NOQ-3` | Backup / recovery targets? | No recovery objective asserted; only that backup and restore work **at all**. |
| `NOQ-5` | Accessibility standard / contrast? | **No conformance level asserted.** Behaviors tested. |
| `NOQ-6` | Browser/device/support matrix? | No support claim. |
| `NOQ-7` | Log retention; sensitive-data definition? | Credential exclusion testable; retention is not. |
| `AQ-1` (`docs/09`) | Duplicate-submission behavior? | **An exploratory charter exists**; no assertion, because the behavior is undefined. |
| **New** | **What testing depth is required before first public release?** | **Determines the size of the suite. Not answered here.** |

---

## Future testing considerations

Recorded for continuity, **not committed**.

| Future capability | Testing impact |
|---|---|
| Business-owner accounts | A **third trust level**. Every boundary invariant must be re-examined against it — the largest future increase in test surface. |
| Listing claiming | A verification lifecycle with its own abuse surface. |
| Reviews and ratings | A **second moderation lifecycle**, roughly doubling the `BI-1`-style obligations. |
| Paid promotion | Tests would have to protect **result neutrality** — a genuinely hard property to assert. |
| A second client (native app, partner) | Makes the API contract **external**; forces versioning and contract testing (`AQ-5`). |
| Report-inaccuracy path (`OQ-1`) | A **second unauthenticated write path**, inheriting every abuse and boundary concern of the first. |
| Growth in listing volume | Makes `NOQ-4` answerable — and performance testing finally possible. |

---

## Risks of over- and under-designing testing

**R-T1 — Coverage as a goal.** A percentage measures lines executed, not properties
preserved. A suite can reach ninety percent while never once attempting to fetch a pending
record. **Mitigation:** **T7** — named properties, which are harder to fake and impossible
to game by touching more lines.

**R-T2 — Testing the UI instead of the boundary.** If every boundary test drives the
interface, the suite proves only that the UI does not *offer* the forbidden action, never
that the system *forbids* it (`BI-9`). **This is the most likely way a suite looks thorough
and protects nothing.** **Mitigation:** **T5**, and the operation-level focus.

**R-T3 — Turning an open question into a test.** The dominant risk, and worse here than in
any prior document: a test does not merely *record* an assumption, it **enforces** it, in
CI, where it will be defended by every future engineer who sees it go red. A fixture with
four required fields decides `OQ-8`; an assertion enumerating response fields decides
`OQ-7`. **Mitigation:** **T4** and the cannot-test-yet register.

**R-T4 — Writing test cases instead of a strategy.** Cases depend on decisions not yet made.
**Mitigation:** properties and categories only.

**R-T5 — Under-testing the negative space.** Empty, loading, error, validation and
confirmation states are where an MVP is actually judged, and are the first thing cut under
pressure. **Mitigation:** **T3** — they are first-class here, not an appendix.

**R-T6 — Treating boundary protection as "security testing, later".** It is not a phase; it
is the product (**T2**). A directory that *might* leak a pending submission is not a
directory with a bug — it is not a trustworthy directory, which means it is not this
product.

**R-T7 — Inheriting the mini lab's approach.** It was verified by a person looking at rows
in a database console. That is the *absence* of a strategy, and an absence arrives by
default unless refused.

**R-T8 — Faking a blocked target.** Inventing a performance threshold, or asserting an
accessibility conformance level nobody approved. **A passing test that measures an invented
target is worse than no test**, because it will later be cited as evidence that someone
decided. **Mitigation:** Category 3 — blocked, explicit, and accepted in writing.

---

## Summary

Verification is organised around three questions, in descending order of what a failure
costs: **can anything reach the public that should not** (boundaries), **does every journey
work, including its failures** (behavior), and **is it usable by everyone it is for**
(qualities).

The heart of the strategy is **nine boundary invariants** (`BI-1`–`BI-9`), each stated as
something that must be proven **impossible**. They are tested by *attempting to violate
them*, at the level where they are **enforced** — the operation, not the screen. Two are the
ones most likely to be skipped: **`BI-4`**, which needs a **four-way equivalence** test
proving that *never existed*, *pending*, *rejected* and *removed* are indistinguishable to an
unauthorised observer; and **`BI-9`**, which is untestable *by definition* if every test
drives the user interface.

The negative space is first-class. The **three empty states must be mutually
distinguishable**, and **a system error must never render as an empty list** — which would
have the platform tell a visitor that a thriving local business does not exist. That is
triaged as a **trust** defect, not a cosmetic one, because it is a false statement about the
community made by the product whose first principle is trust.

**No test may decide an open question**, and this is the discipline that matters most here:
a test is a **stronger** commitment than a schema, a contract, or a screen, because it
*enforces* its assumption in the build. The **cannot-test-yet register** records every
deliberately unverified area — and its most useful finding is that most open questions block
a *specific assertion* while leaving a *general rule* perfectly testable. `OQ-7` blocks
"the response contains name, category, description, city"; it does **not** block "the
response contains **no field outside the approved public set**." **Testing against rules
rather than lists is what lets verification begin before every product question is
answered.**

Release readiness has three categories: **unconditional gates** (the invariants — never
traded for a date), **judgment gates** (a person signs off; a suite cannot), and **blocked**
(performance, availability, recovery, accessibility conformance, support matrix — all
*unmeasurable* until their targets exist, and to be accepted as explicit written risk rather
than quietly dropped).

**How deep verification must go before first release is left open, deliberately** — depth is
a cost-and-risk judgment nobody can make while expected load is still unknown. What depth
never governs is the Category 1 gates.
