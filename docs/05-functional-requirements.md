# Community Directory Platform — MVP Functional Requirements

## Purpose and scope

This document defines the **functional requirements** for the MVP of the
Community Directory Platform: the specific, testable behaviors the system must
provide. It derives those behaviors from the approved MVP scope and user
journeys, so that later work — acceptance criteria, backlog items, testing, and
architecture — has a stable, unambiguous reference.

It builds on and is consistent with:

- [`docs/01-vision.md`](./01-vision.md) — product vision.
- [`docs/02-stakeholders.md`](./02-stakeholders.md) — stakeholders and needs.
- [`docs/03-mvp-scope.md`](./03-mvp-scope.md) — approved MVP scope.
- [`docs/04-user-journeys.md`](./04-user-journeys.md) — MVP user journeys.

**What this document is.** A catalog of *what the system shall do* within the
approved MVP, written in technology-neutral language. Each requirement is
traceable back to a source journey or an in-scope MVP capability.

**What this document is not.** It does **not** select frameworks, databases,
APIs, cloud platforms, or implementation patterns — those are architecture
decisions deferred to later work. It does **not** introduce any capability
outside the approved MVP scope (no business-owner accounts, self-service
claiming, reviews, ratings, analytics, payments, advertising, events, social
features, or native mobile apps). It does **not** resolve the open questions
carried from the MVP scope and user-journeys documents; where a behavior depends
on an unresolved question, the requirement is marked accordingly and the
question is preserved, not silently decided. The **Community Directory Mini Lab**
is treated only as a learning reference and does not constrain these
requirements.

**Functional vs. non-functional.** This document specifies *functional*
requirements — observable behavior in response to actors and inputs.
Accessibility and responsive behavior are included here **only** as the
functional obligations the MVP scope names as in-scope core-flow behaviors
(e.g. keyboard operability, non-color-only messaging, usability across device
sizes). Broader **non-functional** requirements — performance targets, security
hardening, availability, capacity, observability, backup, and quantitative
quality metrics — are **out of scope for this document** and are noted where
relevant so they are not lost.

---

## Requirement-writing conventions

**Identifier groups.** Each requirement has a unique identifier of the form
`FR-<GROUP>-<NN>`:

| Prefix | Group |
|---|---|
| `FR-VIS` | Visitor requirements |
| `FR-SUB` | Listing-submission requirements |
| `FR-ADM` | Administrator requirements |
| `FR-SRCH` | Search and filtering requirements |
| `FR-DATA` | Listing-data requirements |
| `FR-VAL` | Validation requirements |
| `FR-MOD` | Moderation requirements |
| `FR-AUTH` | Authorization and access-control requirements |
| `FR-ERR` | Error and empty-state requirements |
| `FR-ACC` | Accessibility and responsive-behavior requirements |
| `FR-AUD` | Auditability and record-status requirements |

**Requirement statement.** Every requirement is written as a single
"**The system shall…**" statement that is clear, testable, and
technology-neutral.

**Attributes.** Each requirement records:

- **Actor** — the primary actor the behavior serves (Visitor, Lister,
  Administrator, or System where the behavior is internal).
- **Source** — the originating user journey (V/L/A codes from
  [`docs/04-user-journeys.md`](./04-user-journeys.md)) and/or in-scope MVP
  capability from [`docs/03-mvp-scope.md`](./03-mvp-scope.md).
- **Priority** — see the scale below.
- **Notes** — clarifications, dependencies, and links to open questions
  (`OQ-n`, listed under *Open questions*).

**Priority scale.** The approved priority values are:

- **Must** — required for the MVP to meet its purpose; the release is incomplete
  without it.
- **Should** — valuable and expected for a good first release, but not yet
  approved and not essential to the core loop; the release can function if it is
  deferred.
- **Deferred** — outside the current MVP; recorded so the behavior is not lost,
  but explicitly not committed for this release.

**Decision-pending behavior.** Some requirements describe behavior that is
blocked by an unresolved product decision. These are never left as a special
priority; instead they take **Should** (when the behavior is valuable but not
yet approved) or **Deferred** (when it falls outside the current MVP), and their
**Notes** carry a `Decision pending: OQ-<number>` marker pointing to the open
question that must be resolved before the behavior is committed. No requirement
silently resolves an open question — where the decision is *which* of several
behaviors applies, the statement stays neutral and defers the choice.

**Confirmation group (FR-CONF).** Confirmation and status-message requirements
were separated from the error/empty-state group (`FR-ERR`) into their own
`FR-CONF` group for clearer traceability: success confirmations (submission and
administrator actions) and failure/empty-state messaging are distinct behaviors
that map to different journeys, so giving them separate identifiers keeps the
traceability matrix unambiguous. `FR-ERR` covers error and empty-state behavior;
`FR-CONF` covers positive confirmation of a completed action and its resulting
state.

**Reading the "shall".** A requirement describes required behavior. Where the
*details* of that behavior depend on an unresolved product decision, the
requirement states what is already committed and defers the undecided part to an
open question rather than inventing an answer.

---

## Visitor requirements

Source journeys: V1–V7. Related capabilities: public browsing, listing details.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-VIS-01 | The system shall allow any visitor to browse the directory of approved listings without requiring an account or authentication. | Visitor | V1; Public browsing | Must | Low-friction discovery is a core vision principle. |
| FR-VIS-02 | The system shall display only listings whose status is *approved* to visitors. | Visitor | V1, V5; Pending by default | Must | No pending or rejected record is ever visible publicly. See FR-AUTH, FR-MOD. |
| FR-VIS-03 | The system shall present the set of approved listings in a consistent, defined order. | Visitor | V1 | Should | Exact default ordering (alphabetical, newest, etc.) is undecided — **OQ-3**. |
| FR-VIS-04 | The system shall allow a visitor to open a single approved listing and view its full public details. | Visitor | V5; Listing details | Must | Public fields per FR-DATA and **OQ-7**. |
| FR-VIS-05 | The system shall display, for an opened listing, each public field that holds a value and omit or clearly indicate fields that hold no value. | Visitor | V5; Listing details | Should | Prevents empty/misleading detail views. |
| FR-VIS-06 | The system shall show a distinct empty-state message when no approved listings exist yet, worded differently from a no-results state and from an error state. | Visitor | V1, V6; empty states | Must | See FR-ERR-01..03. |
| FR-VIS-07 | The system shall enable a visitor to move from a listing's details back to the previous list or result set. | Visitor | V5 | Should | Supports the return/re-select alternate path. |
| FR-VIS-08 | The system shall show a clear "listing not available" message, rather than stale content, when a visitor opens a listing that is no longer approved or available. | Visitor | V5 (exception) | Should | Covers a listing removed/unpublished between selection and view; interacts with **OQ-11**. |
| FR-VIS-09 | The system shall not provide visitors any means to publish, edit, or delete listings. | Visitor | V7; protection against unauthorized changes | Must | Visitors are read-only. See FR-AUTH-01. |
| FR-VIS-10 | The system shall provide visitors a means to report a listing that appears inaccurate or outdated. | Visitor | V7 | Deferred | Feedback channel is not part of the approved MVP; the read-only guarantee is covered by FR-VIS-09. Decision pending: OQ-1. |

---

## Listing-submission requirements

Source journeys: L1–L4. Related capabilities: public listing-request form,
pending by default.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-SUB-01 | The system shall provide a publicly reachable listing-request form that any member of the public can access without an account. | Lister | L1; Public request form | Must | No lister accounts exist in the MVP. |
| FR-SUB-02 | The system shall present, on the request form, input for the listing fields a submitter may provide. | Lister | L1, L2; listing data | Must | Field set per FR-DATA; required set per **OQ-8**. |
| FR-SUB-03 | The system shall accept a completed submission, validate it (see FR-VAL), and, on success, record it as a new listing with status *pending*. | Lister | L2; pending by default | Must | Status lifecycle per FR-AUD-01. |
| FR-SUB-04 | The system shall ensure a newly submitted listing is not publicly visible until an administrator approves it. | Lister / System | L2, L4; pending by default | Must | Core moderation guarantee; see FR-MOD-01. |
| FR-SUB-05 | The system shall allow a submission to be completed using only the required fields, accepting omission of optional fields. | Lister | L2 (alternate) | Must | Required vs. optional per FR-DATA and **OQ-8**. |
| FR-SUB-06 | The system shall not create any publicly visible listing when a submission fails validation or cannot be saved. | Lister / System | L2 (exception), L3 | Must | No partial/public record on failure. See FR-ERR-05. |
| FR-SUB-07 | The system shall display a clear confirmation, after a successful submission, stating that the request was received and is pending review and not yet public. | Lister | L4; confirmation messages | Must | Sets the "not immediate" expectation. See FR-CONF via FR-AUD/FR-ERR. |
| FR-SUB-08 | The system shall give a lister a reference to, or notification of, the outcome (approval or rejection) of their submission. | Lister | L4 | Deferred | No lister accounts in the MVP; any reference or notification is not yet approved. Decision pending: OQ-2. |
| FR-SUB-09 | The system shall apply an anti-spam or abuse safeguard to submissions received through the public form. | System | L2 | Should | Valuable for an unauthenticated form but not yet approved. Decision pending: OQ-9. |

---

## Administrator requirements

Source journeys: A1–A7. Related capabilities: administrator review, approval,
rejection, editing.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-ADM-01 | The system shall allow an authorized administrator to view the queue of pending submissions. | Administrator | A1; admin review | Must | Access restricted per FR-AUTH. |
| FR-ADM-02 | The system shall show a distinct empty-state when no pending submissions exist. | Administrator | A1; empty states | Should | Distinct from public empty states. See FR-ERR-03. |
| FR-ADM-03 | The system shall allow an administrator to open a submission and view its full submitted details. | Administrator | A2; admin review | Must | Basis for the review decision. |
| FR-ADM-04 | The system shall allow an administrator to edit the fields of a submission before an approve or reject decision, validating the edited content. | Administrator | A3; admin editing | Must | Validation per FR-VAL-04. |
| FR-ADM-05 | The system shall keep a submission's status unchanged when it is edited, until an explicit approve or reject action is taken. | Administrator / System | A3 | Must | Editing ≠ approving. |
| FR-ADM-06 | The system shall allow an administrator to approve a pending submission, setting its status to *approved* and making it publicly visible. | Administrator | A4; admin approval | Must | Becomes reachable by FR-VIS-01..05. |
| FR-ADM-07 | The system shall allow an administrator to reject a submission, marking it *rejected* so that it never becomes public. | Administrator | A5; admin rejection | Must | Retention of rejected records is **OQ-13**. |
| FR-ADM-08 | The system shall allow an administrator to record a reason when rejecting a submission. | Administrator | A5 (alternate) | Should | Optional supporting detail; supports auditability (FR-AUD). |
| FR-ADM-09 | The system shall allow an administrator to open an already-approved listing and edit its content to keep it accurate, validating the changes. | Administrator | A6; admin editing | Must | Corrects stale/inaccurate content (from V7). |
| FR-ADM-10 | The system shall apply a defined publication rule to an administrator's edit of an already-approved listing — either publishing the change immediately or requiring secondary review before it becomes public. | Administrator / System | A6 | Should | Which rule applies is not yet approved; the requirement does not select one. Decision pending: OQ-10. |
| FR-ADM-11 | The system shall provide administrator actions for handling problematic content — editing to fix, or rejecting — for duplicate, incomplete, misleading, or abusive submissions. | Administrator | A7; moderation | Must | See FR-MOD-04..06. |
| FR-ADM-12 | The system shall allow an administrator to unpublish or remove an already-approved listing. | Administrator | A6, A7 | Should | Removal/unpublish is decision-dependent, not yet approved for the MVP; interacts with FR-VIS-08 and FR-MOD-06. Decision pending: OQ-11. |
| FR-ADM-13 | The system shall provide an administrator a defined mechanism for resolving duplicate or near-duplicate submissions, such as declining the duplicate in favor of the existing listing. | Administrator | A7 | Should | Resolution mechanism not yet approved; the requirement does not invent one. Decision pending: OQ-12. |

---

## Search and filtering requirements

Source journeys: V2, V3, V4, V6. Related capabilities: keyword search, category
filtering, location filtering.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-SRCH-01 | The system shall allow a visitor to search approved listings by a text keyword and return matching approved listings. | Visitor | V2; keyword search | Must | Only approved listings are searchable. |
| FR-SRCH-02 | The system shall apply a defined keyword-search scope (which listing fields are searched) and a defined matching mode (exact, partial, or fuzzy). | System | V2 | Should | The specific fields and matching mode are not yet approved; the requirement does not select them. Decision pending: OQ-4. |
| FR-SRCH-03 | The system shall treat an empty or whitespace-only keyword as a request to browse all approved listings (or prompt for input) rather than as a failed search. | Visitor | V2 (exception) | Should | Prevents spurious no-results. |
| FR-SRCH-04 | The system shall allow a visitor to filter approved listings by a predefined category. | Visitor | V3; category filtering | Must | Category set per FR-DATA; curation is **OQ-5**. |
| FR-SRCH-05 | The system shall allow a visitor to filter approved listings by a location value. | Visitor | V4; location filtering | Must | Granularity (city vs. region/country) is **OQ-6**. |
| FR-SRCH-06 | The system shall allow a visitor to combine keyword, category, and location criteria, returning approved listings that satisfy all applied criteria. | Visitor | V2–V4 | Should | Combined narrowing per journeys' alternate paths. |
| FR-SRCH-07 | The system shall allow a visitor to clear or reset any applied search or filter criterion and return to browsing all approved listings. | Visitor | V3, V4, V6 | Should | Supports recovery from no-results. |
| FR-SRCH-08 | The system shall show a distinct no-results message when a search or filter matches zero approved listings, and offer a way to adjust or clear the criteria. | Visitor | V6; empty states | Must | Distinct from empty directory and errors. See FR-ERR-02. |
| FR-SRCH-09 | The system shall allow a visitor to select more than one category at once when filtering. | Visitor | V3 | Should | The MVP baseline (FR-SRCH-04) is a single predefined category; multi-select is not yet approved. Decision pending: OQ-5. |

---

## Listing-data requirements

Source: MVP scope *Data required for a listing*; journeys V5, L2. Defines the
information a listing record holds — **not** any storage technology or schema.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-DATA-01 | The system shall represent each listing with a business or organization name. | System | Scope: data | Must | Required core identity. |
| FR-DATA-02 | The system shall represent each listing with a single category drawn from a predefined set. | System | Scope: data; V3 | Must | Enables category filtering. Curation/source is **OQ-5**. |
| FR-DATA-03 | The system shall represent each listing with a description. | System | Scope: data | Must | Required short descriptive text. |
| FR-DATA-04 | The system shall represent each listing with a city. | System | Scope: data; V4 | Must | Supports location filtering at city level. |
| FR-DATA-05 | The system shall support an optional state or region value on a listing. | System | Scope: data | Should | Optional; useful where cities are ambiguous. |
| FR-DATA-06 | The system shall support a country value on a listing. | System | Scope: data | Should | Country is undecided and is **not** mandatory while multi-country scope is open. Decision pending: OQ-6. |
| FR-DATA-07 | The system shall support optional contact methods on a listing: phone, email, and website. | System | Scope: data | Should | Each individually optional at the field level. |
| FR-DATA-08 | The system shall require at least one contact method (phone, email, or website) on every listing. | System | Scope: data | Should | Contact-minimum enforcement is not yet approved; not enforced by default. Decision pending: OQ-8b. |
| FR-DATA-09 | The system shall maintain administrative fields on each listing — status, submission date, and last-updated date — that are set by the system or administrators and are never entered or edited by the public. | System | Scope: data | Must | See FR-AUD; never public content (FR-DATA-11). |
| FR-DATA-10 | The system shall record the predefined category set as a defined, finite list available for both submission and filtering. | System | V3; scope | Must | Who curates and whether admins manage it is **OQ-5**. |
| FR-DATA-11 | The system shall expose only intended public fields to visitors and shall never present administrative fields (status, dates) or withheld contact details as public content. | System | V5; cross-cutting privacy | Must | Exact public/withheld field set is **OQ-7**. |

---

## Validation requirements

Source journeys: L2, L3, A3, A6. Applies to public submissions and
administrator edits.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-VAL-01 | The system shall validate a listing submission before recording it, rejecting a submission that does not satisfy the required-field and format rules. | System | L2, L3 | Must | Exact rules per **OQ-8**; presence of validation is committed. |
| FR-VAL-02 | The system shall identify validation problems at the level of the specific field(s) affected and present a clear message describing what to fix for each. | Lister | L3 | Must | Field-level, specific, recoverable. |
| FR-VAL-03 | The system shall preserve already-entered valid input when validation fails, so the submitter can correct only the problem fields and resubmit. | Lister | L3 | Must | No data loss on error. |
| FR-VAL-04 | The system shall validate administrator edits to a submission or an approved listing using the same field and format rules applied to submissions. | Administrator | A3, A6 | Must | Parallels FR-VAL-01 for admins. |
| FR-VAL-05 | The system shall enforce the approved set of required fields, contact-method minimum, and field-format checks on submissions and edits. | System | L3 | Should | The obligation to validate is Must (FR-VAL-01, FR-VAL-04); the exact rule set is not yet approved. Decision pending: OQ-8. |
| FR-VAL-06 | The system shall make validation errors perceivable by means other than color alone. | Lister | L3; accessibility | Must | Cross-links FR-ACC-04. |

---

## Moderation requirements

Source journeys: A1–A7; MVP *Content and moderation boundaries*.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-MOD-01 | The system shall ensure that no listing becomes publicly visible until an administrator has approved it. | System | Moderation-first; L2, A4 | Must | Upholds "trust over volume". |
| FR-MOD-02 | The system shall permit only administrators to approve, edit, reject, or otherwise change the public visibility of listings. | System | Boundaries; A1–A7 | Must | Sole-moderator guarantee. See FR-AUTH-02. |
| FR-MOD-03 | The system shall restrict the public to *requesting* listings only, with no ability to publish, edit, or delete listing content. | System | Boundaries; V9 | Must | Mirrors FR-VIS-09. |
| FR-MOD-04 | The system shall allow an administrator to classify and act on a problematic submission as duplicate, incomplete, misleading, or abusive using the available edit and reject actions. | Administrator | A7 | Must | Actions bounded by MVP capabilities. |
| FR-MOD-05 | The system shall ensure abusive or disallowed content in a submission cannot become public. | System | A7 (exception) | Must | Enforced via pending-first + reject. |
| FR-MOD-06 | The system shall provide an administrator corrective actions — such as unpublishing or removing — for already-public content found to be problematic. | Administrator | A7 (exception) | Should | Depends on the removal/unpublish decision and is not yet approved; abuse-in-public handling is flagged, not resolved. Decision pending: OQ-11. |
| FR-MOD-07 | The system shall moderate listing records only and shall not host user-generated content such as reviews, comments, or events. | System | Boundaries | Must | Out-of-scope guardrail. |
| FR-MOD-08 | The system shall provide an escalation path for abuse handling beyond a single administrator. | Administrator | A7 | Should | Escalation is not yet approved for the MVP. Decision pending: OQ-15. |

---

## Authorization and access-control requirements

Source: cross-cutting *Unauthorized access*; MVP *protection against
unauthorized public changes*. *How* administrators authenticate is deferred to
architecture; these requirements are functional only.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-AUTH-01 | The system shall permit unauthenticated visitors and listers to perform only public actions: browsing, searching, filtering, viewing approved listings, and submitting a listing request. | System | Cross-cutting; boundaries | Must | Defines the public capability boundary. |
| FR-AUTH-02 | The system shall restrict all administrator actions — viewing pending submissions, reviewing, editing, approving, and rejecting — to authorized administrators. | System | A1–A7; boundaries | Must | Authentication mechanism deferred to architecture. |
| FR-AUTH-03 | The system shall deny any attempt by a non-administrator to reach administrator functions or to change public content, without exposing protected content. | System | Cross-cutting (unauthorized access) | Must | Denial must not leak data. |
| FR-AUTH-04 | The system shall not provide business-owner accounts, self-service listing claiming, or any public role beyond visitor and lister in the MVP. | System | Scope: out of scope | Must | Explicit exclusion guardrail. |

---

## Error and empty-state requirements

Source journeys: V1, V6, L1, L2, A1; cross-cutting *Error handling*,
*Empty states*.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-ERR-01 | The system shall present a distinct "no listings yet" empty state when the directory contains no approved listings. | Visitor | V1; empty states | Must | Distinct from FR-ERR-02/03. |
| FR-ERR-02 | The system shall present a distinct "no matches for your search" state when a search or filter returns zero results. | Visitor | V6; empty states | Must | Distinct wording from empty directory. |
| FR-ERR-03 | The system shall present a distinct "no pending submissions" empty state in the administrator review area when the queue is empty. | Administrator | A1; empty states | Should | Admin-side empty state. |
| FR-ERR-04 | The system shall show a clear error message, distinct from empty and no-results states, when the directory or the request form is temporarily unavailable. | Visitor / Lister | V1, L1 (exception) | Must | Three states never conflated. |
| FR-ERR-05 | The system shall present a clear error and invite a safe retry when a submission or an administrator action cannot be saved, without creating partial or public content. | Lister / Administrator | L2, A4, A5 (exception) | Must | No partial-write side effects. |
| FR-ERR-06 | The system shall preserve the actor's entered data, where applicable, when an unexpected save error occurs, so the action can be retried without re-entry. | Lister / Administrator | L2, L3 | Should | Complements FR-VAL-03. |

---

## Confirmation and status-message requirements

Source journeys: L4, A4, A5, A6; cross-cutting *Clear confirmation messages*.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-CONF-01 | The system shall display an unambiguous confirmation after a successful listing submission, stating the pending, not-yet-public outcome. | Lister | L4; confirmations | Must | Same behavior as FR-SUB-07, stated as a message obligation. |
| FR-CONF-02 | The system shall display an unambiguous confirmation of the resulting state after an administrator approves a submission. | Administrator | A4; confirmations | Must | e.g. "approved and now public". |
| FR-CONF-03 | The system shall display an unambiguous confirmation of the resulting state after an administrator rejects a submission. | Administrator | A5; confirmations | Must | e.g. "rejected; not public". |
| FR-CONF-04 | The system shall display an unambiguous confirmation of the resulting state after an administrator edits and saves a submission or approved listing. | Administrator | A6; confirmations | Should | Confirms the update took effect. |

> **Note.** `FR-CONF` is the confirmation/status-message group. It is not one of
> the suggested identifier prefixes in the issue but is introduced here to keep
> confirmation behavior addressable; it is fully cross-referenced in the
> traceability matrix.

---

## Accessibility and responsive-behavior requirements

Source: cross-cutting *Accessibility*, *Mobile responsiveness*; MVP *basic
accessibility* and *responsive design*. These are the **functional** obligations
the MVP names as in-scope; broader accessibility conformance targets are
non-functional and deferred.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-ACC-01 | The system shall make the core flows — browse, search, filter, view details, submit, correct errors, and administrator review — operable by keyboard. | All | Cross-cutting (accessibility) | Must | Keyboard operability for core flows. |
| FR-ACC-02 | The system shall present core-flow content and controls in a form usable with assistive technologies, using sensible semantic structure. | All | Cross-cutting; scope: basic accessibility | Must | Semantics for core flows. |
| FR-ACC-03 | The system shall render core flows usably across common phone, tablet, and desktop sizes. | All | Cross-cutting (responsiveness); scope | Must | Responsive core flows. |
| FR-ACC-04 | The system shall convey status, confirmation, and error information by means that do not rely on color alone. | All | Cross-cutting; L3 | Must | Perceivable messaging. Links FR-VAL-06. |
| FR-ACC-05 | The system shall provide readable text contrast for the content and controls of core flows. | All | Scope: basic accessibility | Should | "Basic" contrast for core flows. |

---

## Auditability and record-status requirements

Source journeys: L2, A3–A6; MVP *Data required for a listing*; stakeholder
interest in audit trails. Records the status lifecycle and flags audit questions
without over-committing.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-AUD-01 | The system shall maintain a status for every listing record with the values *pending*, *approved*, and *rejected*, and shall change status only through defined administrator actions. | System | Scope: data; A4, A5 | Must | Lifecycle: submitted→pending; approve→approved; reject→rejected. |
| FR-AUD-02 | The system shall record the submission date of each listing at the time it is submitted. | System | Scope: data | Must | Administrative field (FR-DATA-09). |
| FR-AUD-03 | The system shall record the last-updated date of each listing whenever its content or status changes. | System | Scope: data | Must | Administrative field (FR-DATA-09). |
| FR-AUD-04 | The system shall keep record status and administrative dates as administrator/system-managed data that is never editable by the public. | System | Scope: data; boundaries | Must | Integrity of the status lifecycle. |
| FR-AUD-05 | The system shall record administrator edits and moderation actions in an audit log. | System | A3; stakeholder interest | Should | Audit logging is a stakeholder interest, **not** a mandatory MVP requirement. Decision pending: OQ-14. |
| FR-AUD-06 | The system shall retain rejected submissions for audit purposes rather than discarding them. | System | A5 | Should | Retention vs. discard is not yet approved. Decision pending: OQ-13. |

---

## Traceability matrix

**Part A — In-scope MVP capability → functional requirements.** Every in-scope
capability from [`docs/03-mvp-scope.md`](./03-mvp-scope.md) maps to at least one
requirement.

| In-scope MVP capability | Requirements |
|---|---|
| Public browsing of approved listings | FR-VIS-01, FR-VIS-02, FR-VIS-06 |
| Keyword search | FR-SRCH-01, FR-SRCH-02, FR-SRCH-03 |
| Basic category filtering | FR-SRCH-04, FR-SRCH-09, FR-DATA-02, FR-DATA-10 |
| Basic location filtering | FR-SRCH-05, FR-DATA-04, FR-DATA-05, FR-DATA-06 |
| Listing details | FR-VIS-04, FR-VIS-05, FR-DATA-11 |
| Public listing-request form | FR-SUB-01, FR-SUB-02, FR-SUB-03 |
| Pending by default | FR-SUB-04, FR-MOD-01, FR-AUD-01 |
| Administrator review | FR-ADM-01, FR-ADM-03, FR-ERR-03 |
| Administrator approval | FR-ADM-06, FR-CONF-02 |
| Administrator rejection | FR-ADM-07, FR-ADM-08, FR-CONF-03 |
| Administrator editing | FR-ADM-04, FR-ADM-09, FR-VAL-04, FR-CONF-04 |
| Protection against unauthorized public changes | FR-VIS-09, FR-AUTH-01, FR-AUTH-02, FR-AUTH-03, FR-MOD-02, FR-MOD-03 |
| Responsive design | FR-ACC-03 |
| Basic accessibility | FR-ACC-01, FR-ACC-02, FR-ACC-04, FR-ACC-05 |

**Part B — User journey → functional requirements.** Every journey from
[`docs/04-user-journeys.md`](./04-user-journeys.md) maps to one or more
requirements.

| Journey | Requirements |
|---|---|
| V1 Browse approved listings | FR-VIS-01, FR-VIS-02, FR-VIS-03, FR-VIS-06, FR-ERR-01, FR-ERR-04 |
| V2 Search by keyword | FR-SRCH-01, FR-SRCH-02, FR-SRCH-03 |
| V3 Filter by category | FR-SRCH-04, FR-SRCH-07, FR-SRCH-09, FR-DATA-02 |
| V4 Filter by location | FR-SRCH-05, FR-SRCH-07, FR-DATA-04, FR-DATA-06 |
| V5 View listing details | FR-VIS-04, FR-VIS-05, FR-VIS-07, FR-VIS-08, FR-DATA-11 |
| V6 No-results search | FR-SRCH-08, FR-ERR-02, FR-SRCH-07 |
| V7 Encounter inaccurate/outdated info | FR-VIS-10, FR-ADM-09, FR-MOD-06 |
| L1 Open request form | FR-SUB-01, FR-SUB-02, FR-ERR-04 |
| L2 Submit request | FR-SUB-03, FR-SUB-04, FR-SUB-05, FR-SUB-06, FR-VAL-01, FR-SUB-09 |
| L3 Correct validation errors | FR-VAL-02, FR-VAL-03, FR-VAL-06, FR-ERR-06 |
| L4 Pending confirmation | FR-SUB-07, FR-SUB-08, FR-CONF-01 |
| A1 View pending submissions | FR-ADM-01, FR-ADM-02, FR-ERR-03, FR-AUTH-02 |
| A2 Review a submission | FR-ADM-03 |
| A3 Edit submitted information | FR-ADM-04, FR-ADM-05, FR-VAL-04, FR-AUD-05 |
| A4 Approve a submission | FR-ADM-06, FR-CONF-02, FR-ERR-05, FR-AUD-01 |
| A5 Reject a submission | FR-ADM-07, FR-ADM-08, FR-CONF-03, FR-AUD-06 |
| A6 Review/update existing listing | FR-ADM-09, FR-ADM-10, FR-ADM-12, FR-VAL-04, FR-CONF-04 |
| A7 Handle duplicate/abusive content | FR-ADM-11, FR-ADM-13, FR-MOD-04, FR-MOD-05, FR-MOD-06, FR-MOD-08 |
| Cross-cutting: accessibility | FR-ACC-01..05 |
| Cross-cutting: responsiveness | FR-ACC-03 |
| Cross-cutting: privacy | FR-DATA-11, FR-VIS-05 |
| Cross-cutting: validation | FR-VAL-01..06 |
| Cross-cutting: error handling | FR-ERR-04, FR-ERR-05, FR-ERR-06 |
| Cross-cutting: moderation | FR-MOD-01..08 |
| Cross-cutting: unauthorized access | FR-AUTH-01..04 |
| Cross-cutting: empty states | FR-ERR-01, FR-ERR-02, FR-ERR-03 |
| Cross-cutting: confirmations | FR-CONF-01..04 |

---

## Assumptions

These assumptions are inherited from the approved documents and underpin the
requirements above. They are recorded, not newly decided.

- **A-1.** The moderated public directory loop delivers the primary value; no
  accounts or self-service are required for a first useful release
  (`03-mvp-scope.md`).
- **A-2.** Submission volume is low enough that manual administrator review is
  practical (`01-vision.md`, `03-mvp-scope.md`).
- **A-3.** A small, predefined set of categories is sufficient for launch.
- **A-4.** Initial geographic scope is limited enough that simple location
  fields (e.g. city) support useful filtering.
- **A-5.** A small number of trusted administrators operate the platform.
- **A-6.** Administrators are authorized before performing any administrator
  action; *how* they authenticate is an architecture decision, not specified
  here.
- **A-7.** "Core flows" for accessibility/responsiveness are: browse, search,
  filter, view details, submit, correct errors, and administrator review.

---

## Open questions

Carried forward from [`docs/03-mvp-scope.md`](./03-mvp-scope.md) and
[`docs/04-user-journeys.md`](./04-user-journeys.md). **None is resolved here.**
Decision-pending requirements above (marked `Decision pending: OQ-<number>` in
their notes, priced **Should** or **Deferred**) reference these identifiers; each
must be decided in later product work before its dependent requirement is
committed.

| ID | Question | Affected requirements | Source |
|---|---|---|---|
| OQ-1 | Does the MVP provide any visitor "report a problem"/feedback path, and if not, how do inaccuracies reach administrators? | FR-VIS-10 | Journeys OQ-1; V7 |
| OQ-2 | With no lister accounts, does a lister receive any reference or outcome notification (approval/rejection)? | FR-SUB-08 | Journeys OQ-2; L4, A5 |
| OQ-3 | What is the default ordering of listings (alphabetical, newest, etc.)? | FR-VIS-03 | Journeys OQ-3; V1 |
| OQ-4 | Which fields are searched, and is matching exact, partial, or fuzzy? | FR-SRCH-02 | Journeys OQ-4; V2 |
| OQ-5 | Single vs. multiple category selection; who curates the category set and can admins manage it? | FR-SRCH-09, FR-DATA-02, FR-DATA-10 | Journeys OQ-5; Scope OQ-4; V3 |
| OQ-6 | Location granularity — city only, or also state/region and country (and is launch multi-country)? | FR-SRCH-05, FR-DATA-05, FR-DATA-06 | Journeys OQ-6; Scope OQ-1, OQ-2; V4 |
| OQ-7 | Which listing/contact fields are ever shown publicly vs. withheld? | FR-VIS-04, FR-DATA-11 | Journeys OQ-7; V5, privacy |
| OQ-8 | Which fields are required at submission (and format checks)? | FR-SUB-02, FR-SUB-05, FR-VAL-01, FR-VAL-05 | Journeys OQ-8; L2, L3 |
| OQ-8b | Is at least one contact method enforced per listing? | FR-DATA-08, FR-VAL-05 | Scope OQ-3; Journeys OQ-8 |
| OQ-9 | Is there any anti-spam safeguard for the unauthenticated submission form? | FR-SUB-09 | Journeys OQ-9; L2 |
| OQ-10 | Does an edit to an approved listing publish immediately or need secondary review? | FR-ADM-10 | Journeys OQ-10; Scope OQ-10; A6 |
| OQ-11 | Can administrators unpublish or remove an approved (public) listing in the MVP? | FR-ADM-12, FR-VIS-08, FR-MOD-06 | Journeys OQ-11; Scope OQ-5; A6, A7 |
| OQ-12 | How are duplicate/near-duplicate submissions resolved during review? | FR-ADM-13, FR-MOD-04 | Journeys OQ-12; Scope OQ-8; A7 |
| OQ-13 | Are rejected submissions retained (for audit) or discarded? | FR-ADM-07, FR-AUD-06 | Journeys OQ-13; Scope OQ-6; A5 |
| OQ-14 | Are administrator edits/actions recorded in an audit log? | FR-AUD-05 | Journeys OQ-14; A3; stakeholders |
| OQ-15 | Does abuse handling need any escalation path beyond a single administrator? | FR-MOD-08 | Journeys OQ-15; A7 |

---

## Out-of-scope behavior

The following are explicitly **not** functional requirements of the MVP. They
are listed so that no requirement above is read as implying them, consistent
with [`docs/03-mvp-scope.md`](./03-mvp-scope.md).

- **Business-owner accounts** and any authenticated non-administrator role.
- **Self-service listing claiming** by owners.
- **Reviews and ratings** of listings.
- **Listing analytics** for owners or others.
- **Paid advertising or sponsored placement**, and any ranking influenced by
  payment.
- **Community event management.**
- **Transactions, bookings, or payments.**
- **Social-network features** (following, messaging, user profiles, comments).
- **Native mobile applications.**
- **Advanced integrations** (external data sources, third-party APIs) and
  richer categorization or geographic browsing beyond the MVP filters.
- **Non-functional specifications** — performance, availability, capacity,
  security hardening, observability, backups, and quantitative success metrics
  — are out of scope for *this* document and belong to non-functional
  requirements and architecture work.
- **Implementation choices** — frameworks, databases, APIs, hosting/cloud
  platforms, authentication mechanisms, and data schemas — are deferred to
  architecture work.
- **Any open-question behavior** must not be treated as an implemented feature
  until the corresponding question is resolved.
