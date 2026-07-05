# Community Directory Platform — MVP Non-Functional Requirements

## Purpose and scope

This document defines the **non-functional requirements (NFRs)** for the MVP of
the Community Directory Platform: the quality attributes and operational
expectations the system must satisfy, as distinct from the behaviors it must
perform. Where the functional requirements say *what the system does*, these
requirements say *how well* it must do it — how fast, how reliably, how securely,
how accessibly, and how sustainably it must operate.

It builds on and is consistent with:

- [`docs/01-vision.md`](./01-vision.md) — product vision.
- [`docs/02-stakeholders.md`](./02-stakeholders.md) — stakeholders and needs.
- [`docs/03-mvp-scope.md`](./03-mvp-scope.md) — approved MVP scope.
- [`docs/04-user-journeys.md`](./04-user-journeys.md) — MVP user journeys.
- [`docs/05-functional-requirements.md`](./05-functional-requirements.md) — MVP
  functional requirements (`FR-*` identifiers referenced throughout).

**What this document is.** A catalog of measurable, technology-neutral quality
constraints on the approved MVP, each traceable to a source document, stakeholder
need, or functional area. It is written so it can later support architecture
evaluation, testing, release-readiness review, and operational planning.

**What this document is not.** It does **not** select frameworks, databases,
hosting providers, cloud platforms, monitoring products, authentication
mechanisms, or implementation patterns — those are architecture decisions
deferred to later work. It does **not** restate functional behavior; where a
quality constraint governs a functional behavior, it *references* the `FR-*`
requirement rather than duplicating it. It does **not** introduce any capability
outside the approved MVP scope, and it does **not** invent quantitative targets
where the business has not yet decided them: such targets are preserved as open
questions rather than fabricated. The **Community Directory Mini Lab** is treated
only as a learning reference and does not constrain these requirements.

**A note on numeric targets.** The vision and MVP scope deliberately defer all
quantitative success metrics (`03-mvp-scope.md` open question #9). Consequently,
many business-specific thresholds here — committed availability percentages,
recovery-time objectives, capacity figures, and a formal accessibility
conformance level — are recorded as **decision-pending** rather than asserted.
Where a provisional figure is given, it is (a) clearly labelled provisional,
(b) justified by an established usability or engineering heuristic rather than
invented, and (c) modest and appropriate to a small first release, never a
production-scale commitment.

---

## Requirement-writing conventions

**Identifier groups.** Each requirement has a unique identifier of the form
`NFR-<GROUP>-<NN>`:

| Prefix | Quality area |
|---|---|
| `NFR-PERF` | Performance |
| `NFR-REL` | Reliability and availability |
| `NFR-SEC` | Security |
| `NFR-PRIV` | Privacy |
| `NFR-ACC` | Accessibility |
| `NFR-USA` | Usability |
| `NFR-RESP` | Responsive behavior |
| `NFR-MAINT` | Maintainability |
| `NFR-OBS` | Observability and supportability |
| `NFR-DATA` | Data integrity |
| `NFR-BACK` | Backup and recovery |
| `NFR-SCALE` | Scalability |
| `NFR-COMP` | Compatibility |
| `NFR-OPS` | Operational constraints |

**Requirement statement.** Every requirement is written as a single, clear,
**measurable** statement that is technology-neutral. "Measurable" means the
requirement states an observable condition that can be checked by a defined
verification method — either a concrete threshold, or a committed obligation
whose specific threshold is explicitly deferred to a named open question.

**Attributes.** Each requirement records:

- **Quality attribute** — the quality characteristic the requirement governs.
- **Source** — the originating document, stakeholder need, or functional area.
  Functional requirements are cited by their `FR-*` identifier from
  [`docs/05-functional-requirements.md`](./05-functional-requirements.md).
- **Priority** — see the scale below.
- **Verification** — how satisfaction is confirmed (see the vocabulary below).
- **Notes** — clarifications, dependencies, and links to open questions
  (`NOQ-n` for NFR open questions, `OQ-n` for functional open questions carried
  from the earlier documents).

**Priority scale** (the same scale used in the functional requirements):

- **Must** — required for the MVP to meet its quality goals; the release is not
  acceptable without it.
- **Should** — valuable and expected for a good first release, but not essential
  to the core loop, or dependent on a business decision not yet made.
- **Deferred** — outside the current MVP; recorded so the quality goal is not
  lost, but explicitly not committed for this release.

**Verification vocabulary.** The verification method names *how* a requirement is
checked, not the tool used to check it:

- **Measurement** — instrumented observation against a threshold under defined
  conditions (e.g. timed response under a stated load).
- **Test** — a repeatable functional or automated check with a pass/fail result.
- **Inspection** — manual review of design, code, content, or configuration.
- **Demonstration** — observing the system behave as required in a walkthrough.
- **Analysis** — reasoned evaluation of design or data against the requirement.
- **Audit** — review of retained records or logs after the fact.

**Decision-pending behavior.** A requirement whose specific target depends on an
unresolved business decision is never given an invented number. Instead it is
priced **Should** (or **Deferred**), states the committed part of the obligation,
and carries a `Decision pending: NOQ-<n>` (or `OQ-<n>`) marker in its Notes
pointing to the open question that must be resolved before the target is fixed.

**Relationship to functional requirements.** These NFRs constrain the *quality*
of behaviors defined functionally. For example, `FR-AUTH-02` requires that only
administrators can moderate; `NFR-SEC` here constrains *how strongly* that
restriction must resist bypass. The behavior is not restated; the quality bar is
added.

---

## Performance

Source: vision and stakeholder need for "fast, accurate search and browsing";
journeys V1–V6; functional search/browse requirements `FR-VIS-01`, `FR-SRCH-01`.
The committed service-level figures are business decisions (`NOQ-1`); the
provisional targets below are anchored to established human-perception thresholds
(interaction feedback under ~1 s feels responsive; results under a few seconds
keep attention) rather than invented.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-PERF-01 | The system shall meet a defined, documented response-time budget for rendering a directory page and a listing-detail view under the expected MVP load, and that budget shall be recorded so it is testable. | Performance | Vision; V1, V5; FR-VIS-01, FR-VIS-04 | Must | Measurement | The obligation to have and meet a measured budget is committed; the specific figure is **Decision pending: NOQ-1**. |
| NFR-PERF-02 | The system should return a browsed directory page or listing-detail view within 2 seconds for at least 95% of requests, measured at the application boundary under the expected low first-release load. | Performance | V1, V5 | Should | Measurement | Provisional target pending confirmation of the committed figure. **Decision pending: NOQ-1.** Justification: a few-second ceiling is a widely used responsiveness heuristic. |
| NFR-PERF-03 | The system should return keyword-search and filter results within 2 seconds for at least 95% of queries under the expected low first-release load. | Performance | V2–V4, V6; FR-SRCH-01, FR-SRCH-04, FR-SRCH-05 | Should | Measurement | Provisional; the committed search budget is **Decision pending: NOQ-1**. |
| NFR-PERF-04 | The system should acknowledge an interactive action (submitting a search, applying a filter, submitting the request form) with a perceptible response within about 1 second, showing progress when the result will take longer. | Performance / Usability | V2–V4, L2 | Should | Measurement / Demonstration | Justification: ~1 s is a common threshold for an action to feel uninterrupted. Cross-links NFR-USA-04. |
| NFR-PERF-05 | The stated performance targets shall hold at the defined expected-load level for the first release, and the load level assumed shall be recorded alongside them. | Performance | Scope assumptions A-2, A-4 | Must | Analysis / Measurement | Ties performance to a stated capacity envelope. Load figures are **Decision pending: NOQ-4**. |
| NFR-PERF-06 | Browse, search, and filter response times shall not degrade disproportionately as the number of approved listings grows across the expected first-release range. | Performance / Scalability | Scope A-2, A-4 | Should | Measurement / Analysis | Guards against approach that only works at trivially small data sizes. Range is **Decision pending: NOQ-4**. |

---

## Availability and reliability

Source: stakeholder need for "reliable infrastructure"; vision principle of a
trustworthy directory; journeys' distinction between empty, no-results, and
error states (`FR-ERR-01`, `FR-ERR-02`, `FR-ERR-04`). The public read path
(browse/search/view approved listings) is the availability-critical surface; the
administrator path is important but tolerates more downtime given a small,
scheduled operator team.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-REL-01 | The public directory (browsing, searching, filtering, and viewing approved listings) shall meet a defined, documented availability target over a stated measurement window. | Reliability | Vision; stakeholders (maintainers) | Must | Measurement | The commitment to a measured availability target is fixed; the target percentage and window are **Decision pending: NOQ-2**. |
| NFR-REL-02 | The public directory should be available at least 99% of the time over a rolling monthly window, excluding announced maintenance. | Availability | Stakeholders (maintainers) | Should | Measurement | Provisional, modest first-release target. **Decision pending: NOQ-2.** Not a production-scale ("four nines") commitment. |
| NFR-REL-03 | When the directory or the request form is temporarily unavailable, the system shall present a clear error state distinct from the empty-directory and no-results states, without exposing internal diagnostic detail to the public. | Reliability / Usability | V1, L1 exceptions; FR-ERR-04 | Must | Test / Demonstration | Quality constraint on the behavior already required by FR-ERR-04. |
| NFR-REL-04 | A failure while saving a submission or an administrator action shall leave no partial or publicly visible record, preserving a consistent state that the actor can safely retry. | Reliability / Data integrity | L2/A4/A5 exceptions; FR-SUB-06, FR-ERR-05 | Must | Test | Reinforces the no-partial-write guarantee as a reliability property. Cross-links NFR-DATA-03. |
| NFR-REL-05 | Planned maintenance that makes the public directory unavailable should occur within announced windows and should be communicated to users through a clear, non-technical message. | Availability / Usability | Stakeholders (maintainers) | Should | Inspection / Demonstration | Maintenance-window policy detail is **Decision pending: NOQ-2**. |
| NFR-REL-06 | The system should degrade gracefully when a non-essential part is impaired — for example, keeping approved listings browsable even if the submission form is temporarily unavailable — rather than failing entirely. | Reliability | V1, L1; FR-ERR-04 | Should | Demonstration / Analysis | Prioritizes the availability-critical public read path. |

---

## Security

Source: MVP "protection against unauthorized public changes"; cross-cutting
*Unauthorized access*; functional access-control requirements `FR-AUTH-01..04`,
`FR-MOD-02`. These NFRs constrain the *strength and posture* of protection; the
authentication *mechanism* is an architecture decision and is not selected here.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-SEC-01 | All administrator functions — viewing pending submissions, reviewing, editing, approving, rejecting, and any removal action — shall be protected so that they cannot be reached or invoked without an authenticated, authorized administrator identity. | Security | FR-AUTH-02, FR-MOD-02 | Must | Test | Strength constraint on the behavior FR-AUTH-02 defines. Mechanism deferred to architecture. |
| NFR-SEC-02 | An unauthenticated or unauthorized attempt to reach an administrator function shall be denied without revealing protected content, whether a target record exists, or internal system detail. | Security / Privacy | FR-AUTH-03 | Must | Test | Denial must not leak existence or data. |
| NFR-SEC-03 | The system shall enforce least privilege for public actors: visitors and listers shall be able to perform only the public actions defined in FR-AUTH-01 and shall have no path to publish, edit, or delete listing content. | Security | FR-AUTH-01, FR-VIS-09, FR-MOD-03 | Must | Test / Inspection | Confidentiality and integrity of the moderation boundary. |
| NFR-SEC-04 | Data exchanged between users and the system, and any administrator credentials, shall be protected against interception and tampering in transit. | Security | Stakeholders; privacy | Must | Inspection / Test | Stated as a protection property, technology-neutral (no protocol or cipher selected). |
| NFR-SEC-05 | The public listing-request form shall validate and constrain all submitted input so that malformed or malicious input cannot compromise the system, corrupt stored data, or be reflected unsafely to other users. | Security | L2; FR-VAL-01 | Must | Test | Complements functional validation (FR-VAL) with an injection/abuse-resistance quality bar. |
| NFR-SEC-06 | The public submission form should be protected by a safeguard that limits automated abuse (such as bulk or scripted submissions) without requiring a lister account. | Security | L2; FR-SUB-09 | Should | Test / Demonstration | Anti-abuse safeguard is valuable but not yet approved. **Decision pending: OQ-9.** |
| NFR-SEC-07 | Administrator authentication should meet a defined minimum strength for credentials and session handling appropriate to a small trusted operator team. | Security | Stakeholders; A-5, A-6 | Should | Inspection | The concrete strength/session policy is **Decision pending: NOQ-9**; the mechanism itself is deferred to architecture. |
| NFR-SEC-08 | Sensitive values (such as administrator credentials) shall never be stored or transmitted in an unprotected, human-readable form, and shall never appear in logs or error messages. | Security / Privacy | Stakeholders; observability | Must | Inspection / Audit | Cross-links NFR-OBS-04 (no sensitive data in logs). |

---

## Privacy

Source: cross-cutting *Privacy*; functional `FR-DATA-11`, `FR-VIS-05`; MVP
open question #7 (which fields are public). The MVP holds submission data that is
not all meant to be public, and administrative fields that must never be public.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-PRIV-01 | The system shall expose to visitors only the listing fields intended to be public, and shall never present administrative fields (status, submission date, last-updated date) as public content. | Privacy | FR-DATA-11, FR-DATA-09 | Must | Test / Inspection | Quality guarantee over the field-exposure behavior. Exact public/withheld set is **Decision pending: OQ-7**. |
| NFR-PRIV-02 | Contact details supplied in a submission shall be exposed publicly only to the extent intended for public display, and any contact field designated non-public shall not be visible to visitors. | Privacy | V5; cross-cutting privacy; FR-DATA-11 | Must | Test / Inspection | Depends on the public/withheld decision. **Decision pending: OQ-7.** |
| NFR-PRIV-03 | Non-public submission data (including pending and rejected submissions) shall be accessible only to authorized administrators and shall never be reachable through any public browse, search, or detail path. | Privacy / Security | FR-VIS-02, FR-AUTH-01; A5 | Must | Test | Pending/rejected records must not leak via public surfaces. |
| NFR-PRIV-04 | The system shall collect through the public form only the information needed for a listing, and shall not require personal information beyond the defined listing fields. | Privacy (data minimisation) | Scope: data; L2 | Should | Inspection | Data-minimisation principle; required-field set is **Decision pending: OQ-8**. |
| NFR-PRIV-05 | Any retention of rejected submissions or other non-public data shall be limited to a defined, documented purpose and period rather than kept indefinitely by default. | Privacy | A5; FR-AUD-06 | Should | Inspection / Audit | Retention of rejected submissions is itself undecided. **Decision pending: OQ-13.** |

---

## Accessibility

Source: MVP "basic accessibility"; cross-cutting *Accessibility*; functional
`FR-ACC-01..05`. The functional document commits keyboard operability, assistive-
technology support, non-color-only messaging, and readable contrast for core
flows. These NFRs set the *quality bar and how it is verified*. Whether to commit
to a formal published conformance standard and level is a business decision.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-ACC-01 | Every core flow (browse, search, filter, view details, submit, correct errors, administrator review) shall be fully operable using a keyboard alone, with a visible focus indicator and a logical focus order. | Accessibility | FR-ACC-01 | Must | Test / Demonstration | Measurable per-flow: each flow completable without a pointing device. |
| NFR-ACC-02 | Core-flow content and controls shall be presented with semantic structure and text alternatives sufficient for common assistive technologies to convey purpose and state. | Accessibility | FR-ACC-02 | Must | Test / Inspection | Verified with assistive-technology walkthroughs of each core flow. |
| NFR-ACC-03 | Status, confirmation, and error information shall be conveyed by means that do not rely on color alone and shall be announced to assistive technologies. | Accessibility | FR-ACC-04, FR-VAL-06 | Must | Test / Inspection | Cross-links NFR-USA-03. |
| NFR-ACC-04 | Text and essential controls in core flows shall meet a readable contrast level against their background. | Accessibility | FR-ACC-05 | Should | Inspection / Measurement | The specific contrast ratio depends on the conformance target. **Decision pending: NOQ-5.** |
| NFR-ACC-05 | The MVP should conform to a defined published accessibility standard and level for its core flows. | Accessibility | MVP: basic accessibility | Should | Inspection / Test | Which standard and level to commit to (versus "basic" only) is **Decision pending: NOQ-5**. |

---

## Usability

Source: vision "simple experience"; journeys' emphasis on clear messaging,
recoverable errors, preserved input, and distinct states; functional `FR-VAL-*`,
`FR-ERR-*`, `FR-CONF-*`. These constrain how understandable and recoverable the
experience is.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-USA-01 | A first-time visitor shall be able to browse, search, and open a listing's details without instructions or an account. | Usability | Vision; V1–V5; FR-VIS-01 | Must | Demonstration / Test | Verified by unaided task completion in usability walkthroughs. |
| NFR-USA-02 | When a submission fails validation, the system shall present clear, specific, field-level guidance on what to fix and shall preserve already-entered valid input so the submitter can correct only the affected fields. | Usability | L3; FR-VAL-02, FR-VAL-03 | Must | Test | Quality bar on the recovery behavior FR-VAL defines. |
| NFR-USA-03 | The empty-directory, no-results, and error states shall be worded so that a user can distinguish them and know what to do next. | Usability | V1, V6; FR-ERR-01..04 | Must | Inspection / Demonstration | Prevents conflation of the three states. |
| NFR-USA-04 | Interactive actions shall give clear, timely feedback about their outcome, including a visible in-progress indication when a result is not immediate. | Usability | V2–V4, L2 | Should | Demonstration | Cross-links NFR-PERF-04. |
| NFR-USA-05 | Confirmation messages for a successful submission and for administrator approve, reject, and edit actions shall unambiguously state the resulting status of the record. | Usability | L4, A4–A6; FR-CONF-01..04 | Should | Test / Demonstration | E.g. "received; pending review; not yet public". |
| NFR-USA-06 | The lister shall be clearly informed at submission that a request is pending review and not immediately public, to set correct expectations. | Usability | L4; FR-SUB-07, FR-CONF-01 | Must | Demonstration | Directly serves the "trust over volume" expectation. |

---

## Responsive behavior

Source: MVP "responsive design"; cross-cutting *Mobile responsiveness*;
functional `FR-ACC-03`. The set of supported devices/breakpoints to *test
against* is a compatibility decision (`NOQ-6`); the *quality obligation* to be
usable across sizes is committed.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-RESP-01 | All visitor and lister core flows shall be usable — with readable text and reachable controls, without horizontal scrolling for primary content — on common phone, tablet, and desktop widths. | Responsive behavior | FR-ACC-03; cross-cutting | Must | Test / Demonstration | Verified across representative small, medium, and large widths. |
| NFR-RESP-02 | Layout and controls shall adapt to the viewport so that no core action becomes unreachable or unusable at a smaller size. | Responsive behavior | FR-ACC-03 | Must | Test / Demonstration | No functionality lost on small screens. |
| NFR-RESP-03 | Interactive targets in core flows should be large enough and spaced enough to be operated comfortably by touch on a phone. | Responsive behavior / Usability | Stakeholders (visitors on mobile) | Should | Inspection / Demonstration | Concrete sizing depends on the supported-device matrix. **Decision pending: NOQ-6.** |
| NFR-RESP-04 | The administrator review flow should remain usable on at least tablet and desktop sizes. | Responsive behavior | A1–A6; A-5 | Should | Demonstration | Admin work is assumed on larger screens; phone support for admin is not committed. |

---

## Maintainability

Source: support/maintainer stakeholder need for "a maintainable, well-documented
codebase". These are technology-neutral engineering-quality obligations, kept at
a first-release level consistent with the MVP treating maintainers as a secondary
(non-design-focus) stakeholder.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-MAINT-01 | The codebase shall be organized into clearly separated, documented parts so that a new maintainer can locate and change a given behavior without understanding the entire system. | Maintainability | Stakeholders (maintainers) | Must | Inspection | Modularity and readability as a reviewable quality. |
| NFR-MAINT-02 | The system shall include documentation sufficient for a maintainer to set up, run, and modify it locally, kept consistent with the delivered code. | Maintainability | Stakeholders (maintainers) | Must | Inspection | Setup/run/change docs; verified by an unaided setup walkthrough. |
| NFR-MAINT-03 | Core behaviors (moderation lifecycle, access control, validation) shall be covered by automated tests sufficient to detect regressions before release. | Maintainability | Stakeholders; FR-MOD, FR-AUTH, FR-VAL | Should | Inspection / Test | Coverage expectation kept modest for the MVP; exact bar set during architecture. |
| NFR-MAINT-04 | Configuration values (such as the category set, location fields, and operational settings) shall be changeable without rewriting core logic. | Maintainability | Scope: data; A-3, A-4 | Should | Inspection | Supports curating categories/locations as open questions resolve. Links OQ-5, OQ-6. |
| NFR-MAINT-05 | The project shall follow a consistent, documented coding and contribution standard so that changes remain reviewable and uniform. | Maintainability | Stakeholders (maintainers) | Should | Inspection | Sustains reviewability over time. |

---

## Observability and supportability

Source: support/maintainer need for "monitoring" and "efficient tools to diagnose
issues"; stakeholder interest in audit trails (functional `FR-AUD-05`, undecided
`OQ-14`). Logging must be sufficient to diagnose without exposing sensitive data.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-OBS-01 | The system shall record operational logs of significant events — errors, failed saves, and denied access attempts — in enough detail for a maintainer to diagnose a problem after it occurs. | Observability | Stakeholders (maintainers) | Must | Inspection / Audit | Diagnosability as a measurable property (a given failure is traceable in logs). |
| NFR-OBS-02 | Operational logs and error reports shall not contain sensitive data, including administrator credentials and any non-public submission data. | Observability / Privacy | Stakeholders; privacy | Must | Inspection / Audit | Cross-links NFR-SEC-08, NFR-PRIV-03. |
| NFR-OBS-03 | The system should expose a simple, authorized means to check whether the public directory is currently healthy and reachable. | Supportability | Stakeholders (maintainers); NFR-REL-01 | Should | Demonstration | A basic health signal; specific monitoring product is not selected. |
| NFR-OBS-04 | Errors presented to end users shall be clear and non-technical, while the corresponding diagnostic detail is retained only in operational logs. | Supportability / Usability | FR-ERR-04; NFR-REL-03 | Must | Inspection / Demonstration | Separates user messaging from diagnostics. |
| NFR-OBS-05 | The system should record administrator moderation actions in an audit log sufficient to reconstruct who changed a record's status or content and when. | Observability / Auditability | Stakeholders (audit trails); FR-AUD-05 | Should | Audit | Audit logging is a stakeholder interest, not yet a committed MVP feature. **Decision pending: OQ-14.** |
| NFR-OBS-06 | Retained operational logs shall have a defined retention period and shall be stored so that their sensitive-data exclusion (NFR-OBS-02) is preserved. | Observability / Privacy | Stakeholders; privacy | Should | Inspection | Retention period and the definition of excluded sensitive data are **Decision pending: NOQ-7**. |

---

## Data integrity

Source: MVP moderation model and status lifecycle; functional `FR-AUD-01..04`,
`FR-MOD-01`. The trustworthiness of the directory depends on accurate,
tamper-resistant record status and administrative fields.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-DATA-01 | Every listing record shall have exactly one well-defined status (pending, approved, or rejected) at all times, and status shall change only through the defined administrator actions. | Data integrity | FR-AUD-01, FR-MOD-01 | Must | Test | No record may exist in an undefined or dual status. |
| NFR-DATA-02 | A record's status transitions shall follow only the permitted lifecycle (submitted → pending; pending → approved or rejected; and any approved edit or removal rule once decided), with no unauthorized or accidental transition. | Data integrity | FR-AUD-01; A4, A5, A6 | Must | Test | The approved-edit/removal rules themselves are **Decision pending: OQ-10, OQ-11**. |
| NFR-DATA-03 | A create, edit, or moderation action shall either complete fully or have no effect, never leaving a record partially written or inconsistent. | Data integrity / Reliability | FR-SUB-06, FR-ERR-05 | Must | Test | Atomicity of record changes. Cross-links NFR-REL-04. |
| NFR-DATA-04 | Administrative fields (status, submission date, last-updated date) shall be settable only by the system or an authorized administrator and shall never be modifiable through any public path. | Data integrity / Security | FR-DATA-09, FR-AUD-04 | Must | Test | Integrity of the moderation boundary. |
| NFR-DATA-05 | The submission date shall be recorded once at submission and not change, and the last-updated date shall change whenever a record's content or status changes. | Data integrity | FR-AUD-02, FR-AUD-03 | Must | Test | Accurate temporal metadata. |
| NFR-DATA-06 | Stored listing data shall accurately reflect the last successful administrator or submission action, with no silent loss or alteration of saved content. | Data integrity | FR-ADM-04, FR-ADM-09 | Must | Test / Audit | Durability of accepted writes. |

---

## Backup and recovery

Source: support/maintainer need for "backups" and a recoverable system. The
commitment to *have* backup and recovery is fixed; the specific recovery
objectives are business decisions.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-BACK-01 | Listing and submission data shall be backed up on a defined, documented schedule so that it can be restored after loss or corruption. | Backup and recovery | Stakeholders (maintainers) | Must | Inspection / Demonstration | The commitment to scheduled backups is fixed; the frequency is **Decision pending: NOQ-3**. |
| NFR-BACK-02 | The system shall have a documented, tested recovery procedure that restores the directory to a consistent, usable state from a backup. | Backup and recovery | Stakeholders (maintainers) | Must | Demonstration | Recovery must be proven, not assumed. |
| NFR-BACK-03 | Recovery shall meet defined objectives for maximum tolerable data loss (recovery point) and maximum tolerable downtime (recovery time). | Backup and recovery | Stakeholders | Should | Demonstration / Analysis | The RPO and RTO values are **Decision pending: NOQ-3**; no figure is invented here. |
| NFR-BACK-04 | Backups shall be protected so that they preserve the same confidentiality guarantees as live data, including exclusion of unauthorized access to non-public submission data. | Backup and recovery / Privacy | Privacy; NFR-PRIV-03 | Must | Inspection | Backups are a data-exposure surface too. |
| NFR-BACK-05 | The integrity of backups should be verified periodically so that a backup is known to be restorable before it is needed. | Backup and recovery | Stakeholders (maintainers) | Should | Demonstration / Audit | Guards against silent backup failure. |

---

## Scalability

Source: scope assumptions of low submission volume, manual review, and limited
initial geography (`A-2`, `A-4`, `A-5`); the issue's goal of handling "realistic
early usage growth". The MVP must not over-build for production scale, but must
not collapse at the first sign of growth.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-SCALE-01 | The system shall meet its performance and availability targets at a defined expected first-release usage level, expressed in terms such as concurrent visitors, total approved listings, and submission rate. | Scalability | A-2, A-4; NFR-PERF-05 | Must | Analysis / Measurement | The commitment to a stated capacity envelope is fixed; the numbers are **Decision pending: NOQ-4**. |
| NFR-SCALE-02 | The system should continue to function correctly, without loss of data or moderation guarantees, at usage moderately above the expected first-release level. | Scalability | A-2, A-4 | Should | Analysis | Headroom for realistic early growth. **Decision pending: NOQ-4.** |
| NFR-SCALE-03 | The design should avoid approaches whose cost or response time grows disproportionately with the number of listings within the expected range, so that early growth does not require a redesign. | Scalability | A-4; NFR-PERF-06 | Should | Analysis / Inspection | Technology-neutral guidance; no specific algorithm or store prescribed. |
| NFR-SCALE-04 | Manual administrator review is assumed to be practical only while submission volume remains low; if volume is expected to exceed that, the need for additional moderation capacity shall be raised rather than silently absorbed. | Scalability / Operational | A-2, A-5 | Should | Analysis | Ties scalability to the human moderation constraint, not just the software. |

---

## Compatibility

Source: vision "works on mobile and assistive technologies"; MVP responsive and
accessibility goals. The set of supported environments to test against is a
business/architecture decision; the obligation to define and support a stated set
is committed.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-COMP-01 | The public directory shall function correctly on a defined set of current, widely used web browsers across phone, tablet, and desktop, and that supported set shall be documented. | Compatibility | Vision; FR-ACC-03 | Must | Test | The commitment to define and support a set is fixed; the exact matrix is **Decision pending: NOQ-6**. |
| NFR-COMP-02 | Core flows shall be operable with common assistive technologies on the supported platforms. | Compatibility / Accessibility | FR-ACC-02; NFR-ACC-02 | Must | Test | Verified against the supported-AT part of the matrix. **Decision pending: NOQ-6.** |
| NFR-COMP-03 | The system should not require any browser plug-in, extension, or non-standard client capability for a visitor to use the core flows. | Compatibility | Vision (low friction) | Should | Inspection / Demonstration | Keeps public access frictionless and portable. |
| NFR-COMP-04 | The system should degrade to a usable experience on an older or less capable supported browser rather than failing to render core content. | Compatibility | Vision; accessibility | Should | Test / Demonstration | Graceful degradation within the supported matrix. |

---

## Operational constraints

Source: MVP assumptions and constraints — a small number of trusted
administrators, manual moderation, and a release "small enough to build and
operate". These bound the operating model the quality requirements assume.

| ID | Requirement | Quality attribute | Source | Priority | Verification | Notes |
|---|---|---|---|---|---|---|
| NFR-OPS-01 | The system shall be operable by a small team of trusted administrators without a dedicated full-time operations staff. | Operational | A-5; stakeholders | Must | Analysis / Demonstration | Sustainable operational workload is a stated maintainer need. |
| NFR-OPS-02 | Routine operation — reviewing submissions, approving/rejecting, and editing listings — shall not require specialized technical skill beyond using the administrator interface. | Operational / Usability | A1–A6; A-5 | Must | Demonstration | Keeps moderation accessible to non-technical operators. |
| NFR-OPS-03 | The moderation workload shall be manageable under the assumption of low submission volume; the assumption and its limits shall be recorded so they can be revisited. | Operational / Scalability | A-2; NFR-SCALE-04 | Should | Analysis | Makes the manual-review assumption explicit and revisitable. |
| NFR-OPS-04 | Deploying and operating the MVP should not depend on specialized or heavyweight infrastructure disproportionate to a small first release. | Operational | Scope: "small enough to operate" | Should | Analysis / Inspection | Technology-neutral; no platform selected. |
| NFR-OPS-05 | Operational procedures (backup, recovery, health check, and routine maintenance) shall be documented so that any authorized operator can carry them out. | Operational / Supportability | Stakeholders; NFR-BACK, NFR-OBS | Should | Inspection | Reduces reliance on a single individual. |

---

## Assumptions

These assumptions are inherited from the approved documents and underpin the
requirements above. They are recorded, not newly decided.

- **NA-1.** The moderated public directory loop delivers the primary value; the
  availability-critical surface is the public read path (browse/search/view),
  and the administrator path tolerates more downtime (`01-vision.md`,
  `03-mvp-scope.md`).
- **NA-2.** Submission volume is low enough that manual administrator review, and
  the capacity and performance envelopes assumed here, are realistic for a first
  release (`03-mvp-scope.md`; A-2).
- **NA-3.** Initial geographic scope is limited, so data volumes remain modest
  and the provisional performance/scalability targets are appropriate (A-4).
- **NA-4.** A small number of trusted administrators operate the platform, so the
  operational-workload and admin-usability constraints assume a small,
  non-adversarial operator team (A-5).
- **NA-5.** *How* administrators authenticate, and the concrete infrastructure,
  are architecture decisions; these NFRs state protection and quality properties
  the architecture must satisfy, not the mechanisms (A-6).
- **NA-6.** "Core flows" for accessibility, responsiveness, usability, and
  performance are those named in the functional requirements: browse, search,
  filter, view details, submit, correct errors, and administrator review (A-7).
- **NA-7.** All quantitative success metrics were deliberately deferred by the
  vision and MVP scope; therefore the committed numeric targets here are marked
  decision-pending rather than invented (`03-mvp-scope.md` open question #9).

---

## Open questions

New NFR-specific open questions (`NOQ-*`) are recorded below. Functional open
questions (`OQ-*`) carried from
[`docs/05-functional-requirements.md`](./05-functional-requirements.md) are
referenced where a non-functional target depends on them; **none is resolved
here.** Each decision-pending requirement above points to one of these.

| ID | Question | Affected requirements | Source |
|---|---|---|---|
| NOQ-1 | What are the committed response-time thresholds for browse, search, and detail, and at what load do they hold? | NFR-PERF-01, NFR-PERF-02, NFR-PERF-03 | Vision; Scope OQ #9 |
| NOQ-2 | What availability target and window are committed, and what are the acceptable planned-maintenance windows? | NFR-REL-01, NFR-REL-02, NFR-REL-05 | Stakeholders (maintainers) |
| NOQ-3 | What are the committed backup frequency, recovery point (max data loss), and recovery time (max downtime)? | NFR-BACK-01, NFR-BACK-03 | Stakeholders (maintainers) |
| NOQ-4 | What is the expected first-release usage level (concurrent visitors, total listings, submission rate) and the growth headroom to support? | NFR-PERF-05, NFR-PERF-06, NFR-SCALE-01, NFR-SCALE-02 | Scope A-2, A-4; OQ #9 |
| NOQ-5 | Which published accessibility standard and level (if any) is committed, and what contrast ratio follows from it? | NFR-ACC-04, NFR-ACC-05 | MVP: basic accessibility |
| NOQ-6 | Which browsers, devices, and assistive technologies form the supported compatibility matrix? | NFR-RESP-03, NFR-COMP-01, NFR-COMP-02 | Vision; FR-ACC-03 |
| NOQ-7 | What is the operational-log retention period, and what precisely counts as sensitive data to exclude from logs? | NFR-OBS-06 | Stakeholders; privacy |
| NOQ-8 | *(Reserved)* Is audit logging of administrator moderation actions committed for the MVP? Tracked jointly with the functional question. | NFR-OBS-05 | Carries FR OQ-14 |
| NOQ-9 | What minimum administrator credential and session-handling strength is required (independent of the deferred authentication mechanism)? | NFR-SEC-07 | Stakeholders; A-6 |

**Referenced functional open questions.** `OQ-7` (public vs. withheld fields —
NFR-PRIV-01, NFR-PRIV-02), `OQ-8` (required submission fields — NFR-PRIV-04),
`OQ-9` (anti-spam safeguard — NFR-SEC-06), `OQ-10`/`OQ-11` (approved-edit and
removal rules — NFR-DATA-02), `OQ-13` (rejected-submission retention —
NFR-PRIV-05), and `OQ-14` (audit logging — NFR-OBS-05) remain open in
[`docs/05-functional-requirements.md`](./05-functional-requirements.md) and are
not resolved here.

---

## Out-of-scope quality goals

The following quality goals are explicitly **not** committed for the MVP. They
are recorded so that no requirement above is read as implying them, consistent
with [`docs/03-mvp-scope.md`](./03-mvp-scope.md).

- **Production-scale performance and availability** — high-availability targets
  (e.g. "four nines"), multi-region redundancy, or automated failover.
- **High-volume scalability** — horizontal scaling, load balancing across many
  nodes, or capacity far beyond the expected early-usage level.
- **Formal security certification or compliance** — external audits,
  certifications, or a specified regulatory-compliance regime beyond the basic
  protection properties stated here.
- **Advanced privacy/consent machinery** — consent-management platforms, formal
  data-subject request workflows, or regulatory data-residency guarantees.
- **Full published-standard accessibility conformance at a fixed level** — beyond
  the "basic accessibility for core flows" the MVP commits, unless `NOQ-5` decides
  to adopt one.
- **Advanced observability** — distributed tracing, full metrics/alerting
  platforms, or performance dashboards beyond basic operational logging and a
  simple health check.
- **Disaster-recovery guarantees** — hot standby, cross-site replication, or
  aggressive recovery-time objectives beyond the basic backup-and-restore
  commitment.
- **Broad compatibility** — support for legacy or uncommon browsers outside the
  agreed matrix, or native mobile-application performance characteristics.
- **Internationalization and localization** quality (multi-language UI,
  locale-specific formatting) beyond what the single-scope MVP requires.
- **Implementation choices** — frameworks, databases, hosting/cloud platforms,
  monitoring products, and authentication mechanisms remain deferred to
  architecture work; this document states quality properties, not solutions.

---

## Traceability matrix

**Part A — Quality attribute → NFR groups and requirements.** Every quality area
named in the issue is represented.

| Quality attribute | Requirements |
|---|---|
| Performance | NFR-PERF-01..06 |
| Availability and reliability | NFR-REL-01..06 |
| Security | NFR-SEC-01..08 |
| Privacy | NFR-PRIV-01..05 |
| Accessibility | NFR-ACC-01..05 |
| Usability | NFR-USA-01..06 |
| Responsive behavior | NFR-RESP-01..04 |
| Maintainability | NFR-MAINT-01..05 |
| Observability and supportability | NFR-OBS-01..06 |
| Data integrity | NFR-DATA-01..06 |
| Backup and recovery | NFR-BACK-01..05 |
| Scalability | NFR-SCALE-01..04 |
| Compatibility | NFR-COMP-01..04 |
| Operational constraints | NFR-OPS-01..05 |

**Part B — Source (document / stakeholder need / functional area) → NFRs.** Each
requirement traces to at least one approved source.

| Source | Requirements |
|---|---|
| Vision: fast, accurate search; simple, low-friction experience | NFR-PERF-01..04, NFR-USA-01, NFR-COMP-03 |
| Vision: works on mobile and assistive technologies | NFR-ACC-01..05, NFR-RESP-01..04, NFR-COMP-01, NFR-COMP-02 |
| Stakeholders: visitors (fast, accurate, accessible, mobile) | NFR-PERF-02, NFR-PERF-03, NFR-ACC-01..04, NFR-RESP-01..03 |
| Stakeholders: administrators (protected tools, audit trails) | NFR-SEC-01, NFR-SEC-02, NFR-OBS-05, NFR-OPS-02 |
| Stakeholders: maintainers (maintainable, observable, reliable, backed-up, sustainable) | NFR-REL-01, NFR-MAINT-01..05, NFR-OBS-01..06, NFR-BACK-01..05, NFR-OPS-01..05 |
| MVP scope: protection against unauthorized public changes | NFR-SEC-01, NFR-SEC-03, NFR-DATA-04, NFR-PRIV-03 |
| MVP scope: moderation-first / status lifecycle | NFR-DATA-01..06, NFR-REL-04 |
| MVP scope: responsive design and basic accessibility | NFR-ACC-01..05, NFR-RESP-01..04, NFR-COMP-01 |
| MVP scope: small enough to build and operate | NFR-OPS-01, NFR-OPS-04, NFR-SCALE-01 |
| FR access control (FR-AUTH-01..04, FR-MOD-02) | NFR-SEC-01..03, NFR-SEC-07 |
| FR privacy/data (FR-DATA-09, FR-DATA-11) | NFR-PRIV-01..03, NFR-DATA-04 |
| FR validation/error/confirmation (FR-VAL, FR-ERR, FR-CONF) | NFR-USA-02..06, NFR-SEC-05, NFR-REL-03, NFR-OBS-04 |
| FR accessibility (FR-ACC-01..05) | NFR-ACC-01..05, NFR-RESP-01, NFR-COMP-02 |
| FR auditability/status (FR-AUD-01..06) | NFR-DATA-01..05, NFR-OBS-05 |

**Part C — Decision-pending requirements → open questions.** Every requirement
carrying a deferred target is linked to the question that must resolve it.

| Requirement | Open question |
|---|---|
| NFR-PERF-01, NFR-PERF-02, NFR-PERF-03 | NOQ-1 |
| NFR-PERF-05, NFR-PERF-06, NFR-SCALE-01, NFR-SCALE-02 | NOQ-4 |
| NFR-REL-01, NFR-REL-02, NFR-REL-05 | NOQ-2 |
| NFR-SEC-06 | OQ-9 |
| NFR-SEC-07 | NOQ-9 |
| NFR-PRIV-01, NFR-PRIV-02 | OQ-7 |
| NFR-PRIV-04 | OQ-8 |
| NFR-PRIV-05 | OQ-13 |
| NFR-ACC-04, NFR-ACC-05 | NOQ-5 |
| NFR-RESP-03, NFR-COMP-01, NFR-COMP-02 | NOQ-6 |
| NFR-OBS-05 | OQ-14 (NOQ-8) |
| NFR-OBS-06 | NOQ-7 |
| NFR-DATA-02 | OQ-10, OQ-11 |
| NFR-BACK-01, NFR-BACK-03 | NOQ-3 |

---

## Coverage review

This review confirms the document meets the acceptance criteria from the issue.

- **All required quality areas are covered.** Performance, availability and
  reliability, security, privacy, accessibility, usability, responsive behavior,
  maintainability, observability and supportability, data integrity, backup and
  recovery, scalability, compatibility, and operational constraints each have a
  dedicated section and at least one requirement (Traceability Part A).
- **The initial evaluation areas from the issue are all addressed:** reasonable
  page/search response times (NFR-PERF-01..04); reliable public access
  (NFR-REL-01, NFR-REL-06); protection of administrative functions
  (NFR-SEC-01..03); protection of non-public submission data (NFR-PRIV-03,
  NFR-SEC-02); keyboard and assistive-technology support (NFR-ACC-01..02);
  usability across phone/tablet/desktop (NFR-RESP-01..04); clear error recovery
  (NFR-USA-02..03, NFR-REL-03); maintainable, documented code (NFR-MAINT-01..05);
  sufficient logging without exposing sensitive data (NFR-OBS-01..02, NFR-OBS-06);
  accurate record-status transitions (NFR-DATA-01..02); backup and recovery
  expectations (NFR-BACK-01..05); handling realistic early growth
  (NFR-SCALE-01..04).
- **Requirements are measurable or explicitly decision-pending.** Each states a
  checkable condition; where a specific figure requires a business decision, it
  is priced Should/Deferred and linked to an open question (Traceability Part C),
  never assigned an invented number.
- **Requirements are technology-neutral.** No framework, database, hosting or
  cloud platform, monitoring product, authentication mechanism, or
  implementation pattern is selected; security, backup, and observability are
  stated as properties, not solutions.
- **Functional and non-functional requirements are distinguished.** Behaviors are
  referenced by their `FR-*` identifiers and constrained for quality, not
  restated; the *What this document is not* note makes the boundary explicit.
- **Consistency with prior documents** is maintained through the source citations
  and the shared assumptions (`NA-1..NA-7`), and no requirement introduces an
  out-of-scope capability.
- **Verification methods are identified** for every requirement, drawn from a
  defined vocabulary.
- **Open questions and assumptions are explicit** (`NOQ-*`, referenced `OQ-*`, and
  `NA-*`), and **out-of-scope quality goals are documented** so no requirement is
  over-read.
- **A traceability matrix** links requirements to quality attributes, source
  documents/stakeholder needs/functional areas, and open questions — supporting
  later architecture evaluation, testing, release-readiness review, and
  operational planning.
</content>
</invoke>
