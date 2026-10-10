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
| FR-VIS-04 | The system shall allow a visitor to open a single approved listing and view its full public details. | Visitor | V5; Listing details | Must | "Public details" means the **public projection** defined by FR-DATA-11, FR-DATA-11b, and FR-DATA-11c — never every stored field. Decided: OQ-7. |
| FR-VIS-05 | The system shall display, for an opened listing, each public field that holds a value and omit or clearly indicate fields that hold no value. | Visitor | V5; Listing details | Should | Prevents empty/misleading detail views. |
| FR-VIS-06 | The system shall show a distinct empty-state message when no approved listings exist yet, worded differently from a no-results state and from an error state. | Visitor | V1, V6; empty states | Must | See FR-ERR-01..03. |
| FR-VIS-07 | The system shall enable a visitor to move from a listing's details back to the previous list or result set. | Visitor | V5 | Should | Supports the return/re-select alternate path. |
| FR-VIS-08 | The system shall show a clear "listing not available" message, rather than stale content, whenever a visitor opens a listing that is not currently publicly available, for any reason. | Visitor | V5 (exception) | **Must** | Decided: OQ-11 — **trigger settled** and **raised from `Should`**. The trigger is *not currently publicly available, whatever the reason*: never existed, awaiting review, rejected, or **unpublished** (FR-ADM-12). The response shall be **the same generic result in every case**, and shall not reveal that the listing exists administratively, that it was unpublished, by whom, when, or why (NFR-PRIV-03, docs/09 public surface). Covers a listing unpublished between selection and view, and a previously shared direct link. Technology-neutral: no status code, route, or cache behavior is selected. |
| FR-VIS-09 | The system shall not provide visitors any means to publish, edit, or delete listings. | Visitor | V7; protection against unauthorized changes | Must | Visitors are read-only. See FR-AUTH-01. |
| FR-VIS-10 | The system shall provide visitors a means to report a listing that appears inaccurate or outdated. | Visitor | V7 | Deferred | Feedback channel is not part of the approved MVP; the read-only guarantee is covered by FR-VIS-09. Decision pending: OQ-1. |

---

## Listing-submission requirements

Source journeys: L1–L4. Related capabilities: public listing-request form,
pending by default.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-SUB-01 | The system shall provide a publicly reachable listing-request form that any member of the public can access without an account. | Lister | L1; Public request form | Must | No lister accounts exist in the MVP. |
| FR-SUB-02 | The system shall present, on the request form, input for the listing fields a submitter may provide, distinguishing the fields required at initial submission — business name, category, description, locality, country — from the fields optional at initial submission: administrative area, postal code, phone, email, and website. | Lister | L1, L2; listing data | Must | Field set per FR-DATA — **unchanged**; this decides obligation, not inventory. Required *at initial submission* is not the same as required *before approval* (FR-VAL-05): a submission may enter moderation with no contact method. Decided: OQ-8. |
| FR-SUB-03 | The system shall accept a completed submission, validate it (see FR-VAL), and, on success, record it as a new listing with status *pending*. | Lister | L2; pending by default | Must | Status lifecycle per FR-AUD-01. |
| FR-SUB-04 | The system shall ensure a newly submitted listing is not publicly visible until an administrator approves it. | Lister / System | L2, L4; pending by default | Must | Core moderation guarantee; see FR-MOD-01. |
| FR-SUB-05 | The system shall allow a submission to be completed using only the fields required at initial submission, accepting omission of every field optional at initial submission — including all three contact methods. | Lister | L2 (alternate) | Must | Required vs. optional per FR-DATA and FR-SUB-02. A submission carrying no phone, email, or website is **accepted into moderation** and cannot be **approved** until it carries at least one usable contact method (FR-DATA-08, FR-VAL-05). Decided: OQ-8, OQ-8b. |
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
| FR-ADM-04 | The system shall allow an administrator, during moderation and before approval, to complete missing information that was optional at initial submission and to correct information that was submitted, validating the edited content. | Administrator | A3; admin editing | Must | Decided: OQ-8, OQ-8b — this settles the previously identified **C-7** gap. Completion is how a submission that arrived without a contact method can reach the FR-DATA-08 minimum. **Administrator completion is not a validation bypass:** every value the administrator supplies or corrects passes the same rules as a public submission (FR-VAL-04, VR-6), and **all information must satisfy the applicable validation rules before approval** (FR-VAL-05). Editing does not change status (FR-ADM-05). Designations (FR-DATA-11c, ADR-017 Q-4, issue #135): a contact value or postal code the administrator completes or replaces **defaults to private**, and the administrator may restrict but never make public a business-withheld value. |
| FR-ADM-05 | The system shall keep a submission's status unchanged when it is edited, until an explicit approve or reject action is taken. | Administrator / System | A3 | Must | Editing ≠ approving. Scoped to submissions (pending records). Changes to an **approved** listing are governed by FR-ADM-10 and FR-ADM-10b, under which the listing's status likewise never changes. |
| FR-ADM-06 | The system shall allow an administrator to approve a pending submission, setting its status to *approved* and making it publicly visible, only where every before-approval obligation is satisfied. | Administrator | A4; admin approval | Must | Becomes reachable by FR-VIS-01..05. Before-approval obligations per FR-VAL-05: the required-at-submission fields present and valid, every supplied value valid, and **at least one usable contact method** (FR-DATA-08). An administrator may complete or correct information first (FR-ADM-04). Decided: OQ-8, OQ-8b. |
| FR-ADM-07 | The system shall allow an administrator to reject a submission, marking it *rejected* so that it never becomes public. | Administrator | A5; admin rejection | Must | **Rejection is terminal.** Decided: OQ-13 — a rejected record **cannot be edited and cannot later become approved**; `NFR-DATA-02`'s permitted lifecycle contains no transition out of *rejected*, and OQ-13 added none. Reconsideration means an administrator may **review** the retained record and its reason, not revive it; a further attempt requires a **fresh submission** (whose treatment remains outside OQ-13). Retention and purge of rejected records: **FR-AUD-06** (90 days from rejection), purpose limitation `NFR-PRIV-05`. |
| FR-ADM-08 | The system shall allow an administrator to record a reason when rejecting a submission. | Administrator | A5 (alternate) | Should | Optional supporting detail; supports auditability (FR-AUD). |
| FR-ADM-09 | The system shall allow an administrator to open an already-approved listing and edit its content to keep it accurate, validating the changes. | Administrator | A6; admin editing | Must | Corrects stale/inaccurate content (from V7). The change is recorded as a pending revision and published under FR-ADM-10; FR-ADM-10b governs the atomic administrator operation. |
| FR-ADM-10 | The system shall record a proposed change to an already-approved listing as a pending revision that is not publicly visible, shall keep the approved listing publicly visible at its last approved version while that revision is under review, shall make the revision's information the effective public version when the revision is approved, and shall leave the approved listing unchanged when the revision is rejected. | Administrator / System | A6 | **Must** | Decided: OQ-10. A listing has at most one pending revision at a time (DI-11); revision history is not restricted — that wording defines the scope of the one-pending-revision constraint and imposes no duty to retain approved proposals. **Approved-revision removal (ungated Product Owner policy clarification, ADR-017 Q-3, issue #133):** applying an approved revision's content to the listing and removing that approved proposal are **one atomic unit** (NFR-DATA-03, DI-3); the approved content remains on the listing; a failure rolls the whole unit back, preserving the pre-operation state. No retention purpose or period is introduced for approved proposals, and proposal history is not effective-content history. Rejected revisions keep FR-AUD-06's 90-day retention and purge; separate audit records remain OQ-14/NOQ-8. Adds no listing status — the listing remains *approved* throughout (FR-AUD-01, DI-1). Pending-revision invisibility is DI-10. Revision content is validated by FR-VAL-04 / VR-6. Technology-neutral: the persistence mechanism for the effective public version is DDM-8, selected by ADR-017 (Accepted 2026-09-17). |
| FR-ADM-10b | The system shall permit an authorized administrator to create and approve a revision within one atomic authorized operation only when all validation, authorization, and publication safeguards applicable to a separately submitted revision are successfully enforced. No revised information shall become publicly visible before those checks succeed, and failure of any required check shall leave the currently approved listing unchanged. | Administrator / System | A6 | **Must** | Decided: OQ-10. A safeguarded exception to the two-step sequence, **within** the revision lifecycle — not a bypass of it and not a direct unvalidated overwrite. Atomicity per NFR-DATA-03 / DI-3; validation parity per FR-VAL-04 / VR-6; invisibility before success per DI-10. Reconciles docs/09 OP-6 and docs/10 S7, whose general prohibition on accidental or implicit publication otherwise stands. Under the approved-revision removal clarification (ADR-017 Q-3, issue #133), the revision this operation creates is applied and removed within the **same** atomic operation; a failure restores the operation's actual pre-operation state, leaving the approved listing and any pre-existing pending revision unchanged; no proposal newly created by the failed operation remains. **Eligibility (ungated Product Owner policy clarification, ADR-017, issue #137):** the operation is **refused while the listing has a pending revision**; the refusal leaves the approved listing and the pending revision unchanged, and the existing revision must first be approved or rejected (FR-ADM-10). Concurrent attempts preserve this rule (DI-11). |
| FR-ADM-11 | The system shall provide administrator actions for handling problematic content — editing to fix, or rejecting — for duplicate, incomplete, misleading, or abusive submissions. | Administrator | A7; moderation | Must | See FR-MOD-04..06. |
| FR-ADM-12 | The system shall allow an authorized administrator to unpublish an already-approved listing, making it unavailable through every public path while the listing record continues to exist administratively, and shall allow an authorized administrator to republish an unpublished listing, exposing its current approved version at the time of republication. | Administrator | A6, A7 | **Must** | Decided: OQ-11. **Raised from `Should` by OQ-11** — the capability is now approved for the MVP. **Unpublishing is reversible** and is not destruction: the MVP provides no capability that destroys a listing record (permanent deletion is excluded — OQ-11). Unpublishing requires a **recorded current reason** and an **explicit confirmation** before it takes effect; republishing is an explicit, confirmed administrator action and requires **no separate review or approval workflow**. Republishing exposes the **current** approved version, which is not necessarily the version that was public when the listing was unpublished (FR-ADM-10, R-4). The word *remove* is not used unqualified: this requirement is the **unpublish/republish** capability only. **Adds no listing status** — the listing remains *approved* while unpublished; public availability is the separate publication-state concept (FR-AUD-01 unchanged, docs/08 *Status model*). Interacts with FR-VIS-08 and FR-MOD-06. Representation is DDM-9, selected by ADR-017 (Accepted 2026-09-17), conforming to ADR-006. A **repeated** unpublish or republish action is **refused** and changes the listing, its publication state and its current reason not at all — a second unpublish never replaces the recorded current reason (ungated Product Owner clarification, issue #139; docs/08 *The unpublish and republish lifecycle*, docs/13). This adds no capability, no status and no listing state. |
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
| FR-SRCH-04 | The system shall allow a visitor to filter approved listings by a predefined category. | Visitor | V3; category filtering | Must | Category set per FR-DATA. Curation is **~~OQ-5~~ Decided** — a platform-owned, Product Owner-curated finite flat set held as repository configuration. Filtering is on the **single canonical category**, so **no spelling tolerance is required**. **The 16 filterable values are approved** (2026-10-08, issue #165) and recorded in *The approved MVP category vocabulary*; **no filtering implementation exists**. |
| FR-SRCH-05 | The system shall allow a visitor to filter approved listings by a location value. | Visitor | V4; location filtering | Must | Granularity decided by **OQ-6**: locality and country are required, administrative area and postal code optional (FR-DATA-04, FR-DATA-05, FR-DATA-06, FR-DATA-06b). *Which* location fields a visitor may filter on remains bounded by the public projection (**OQ-7**). |
| FR-SRCH-06 | The system shall allow a visitor to combine keyword, category, and location criteria, returning approved listings that satisfy all applied criteria. | Visitor | V2–V4 | Should | Combined narrowing per journeys' alternate paths. |
| FR-SRCH-07 | The system shall allow a visitor to clear or reset any applied search or filter criterion and return to browsing all approved listings. | Visitor | V3, V4, V6 | Should | Supports recovery from no-results. |
| FR-SRCH-08 | The system shall show a distinct no-results message when a search or filter matches zero approved listings, and offer a way to adjust or clear the criteria. | Visitor | V6; empty states | Must | Distinct from empty directory and errors. See FR-ERR-02. |
| FR-SRCH-09 | The system shall allow a visitor to select more than one category at once when filtering. | Visitor | V3 | Should | The MVP baseline (FR-SRCH-04) is a single predefined category. **OQ-5 is Decided and expressly left this unapproved** (2026-10-07): multi-category selection **remains unapproved and deferred**, and no multi-select filtering is built. **Unchanged by the vocabulary approval** (2026-10-08, issue #165), which approved values only and reaffirmed this deferral. |

---

## Listing-data requirements

Source: MVP scope *Data required for a listing*; journeys V5, L2. Defines the
information a listing record holds — **not** any storage technology or schema.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-DATA-01 | The system shall represent each listing with a business or organization name. | System | Scope: data | Must | Required core identity. |
| FR-DATA-02 | The system shall represent each listing with a single category drawn from a predefined set. | System | Scope: data; V3 | Must | Enables category filtering. **~~OQ-5~~ Decided:** **exactly one required** category per listing, drawn from a **predefined, finite, platform-owned** vocabulary that is **flat**. **The 16 approved values are recorded in *The approved MVP category vocabulary* below** (Product Owner ruling 2026-10-08, issue #165). ~~Physical representation remains `DDM-3`.~~ **Physical representation is decided by `ADR-021`** (`Accepted` 2026-10-09, issue #167): a **stable, repository-owned textual machine key** in a mandatory, non-null `text` column, enforced by a **`CHECK`** constraint over the approved key set. **The approved labels are not stored.** |
| FR-DATA-03 | The system shall represent each listing with a description. | System | Scope: data | Must | Required short descriptive text. |
| FR-DATA-04 | The system shall represent each listing with a locality — the town, city, village, municipality, or comparable named place associated with the business. | System | Scope: data; V4 | Must | Required. "Locality" is the neutral underlying concept (renamed from *city*); a user-facing label may read "City, town, or locality." Decided: OQ-6. |
| FR-DATA-05 | The system shall support an optional administrative area on a listing — a state, province, region, county, district, parish, or comparable subdivision. | System | Scope: data | Must | Optional for every listing, and **not** required where no such subdivision meaningfully applies. A user-facing label may read "State, province, region, or district." Decided: OQ-6. |
| FR-DATA-06 | The system shall represent each listing with a country, drawn where practical from a standardised country list and represented consistently across listings. | System | Scope: data; V4 | Must | **Required on every listing.** The MVP supports listings from more than one country from launch and shall **not** silently default a listing to the United States. No country-list source, representation, or provider is selected here. Decided: OQ-6. |
| FR-DATA-06b | The system shall support an optional postal code on a listing, held as text that may contain letters, digits, spaces, and hyphens, and shall accept international postal-code formats. | System | Scope: data | Must | Optional for every listing and every country. The system shall **not** apply a universal United States five-digit rule. A user-facing label may read "Postal code or ZIP code." Decided: OQ-6. **Designation (ungated Product Owner policy clarification, ADR-017 Q-4, issue #135):** a supplied postal code receives the same public/private designation protection as a contact value under FR-DATA-11c — chosen by the business at submission, **default private** — but **remains location data, not contact data**, and never satisfies FR-DATA-08. |
| FR-DATA-06c | The system shall not collect a precise business street address or a residential street address on a listing in the MVP. | System | Scope: data | Must | Home-based and privacy-sensitive listings carry only locality, country, administrative area where provided, and postal code only where voluntarily provided. Postal code shall never be used to infer or expose a residential street address. Decided: OQ-6. |
| FR-DATA-07 | The system shall support optional contact methods on a listing: phone, email, and website. | System | Scope: data | **Must** | Raised from `Should` by OQ-8b: FR-DATA-08 is now `Must` and cannot hold unless all three fields exist to satisfy it. **The fields' optionality is unchanged** — each individually optional **at the field level and at initial submission** — no single one of the three is ever required. The obligation in FR-DATA-08 is a **cross-field** minimum, not a per-field requirement. |
| FR-DATA-08 | The system shall require at least one usable contact method — phone, email, or website — on every listing before that listing may be approved. | System | Scope: data | **Must** | Decided: OQ-8b. **Applies before approval, not at initial submission** — a submission with no contact method enters moderation normally (FR-SUB-05) but cannot be approved. A contact method is **usable** when it is non-blank, passes the applicable format and safety checks, and is retained as the value proposed for the listing (FR-VAL-05). **Locality, administrative area, postal code, country, and any physical-location information are not contact methods** and never satisfy this minimum. A business with no usable phone, email, or website cannot be approved under the MVP policy; **no offline-business exemption exists.** "Usable" means structurally usable — **not** verified as owned, reachable, or currently active; no confirmation email, SMS, call, ownership proof, or domain check is introduced. |
| FR-DATA-09 | The system shall maintain administrative fields on each listing — status, submission date, and last-updated date — that are set by the system or administrators and are never entered or edited by the public. | System | Scope: data | Must | See FR-AUD; never public content (FR-DATA-11). |
| FR-DATA-10 | The system shall record the predefined category set as a defined, finite list available for both submission and filtering. | System | V3; scope | Must | **~~OQ-5~~ Decided:** the **Product Owner** curates the set, which is **repository-owned configuration changed through deployment**; **no administrator category-management screen is authorized**. ~~The initial values are not approved by that ruling and require a separate Product Owner approval.~~ **The initial values are now approved** — Product Owner ruling 2026-10-08 (Joe S.), issue #165: **exactly 16 categories**, with their labels, definitions, boundary notes, tie-breaker rules and alphabetical display order recorded in ***The approved MVP category vocabulary*** below, which is the authoritative record this requirement calls for. **The list is product vocabulary only** — ~~no storage key, slug, identifier, configuration format, schema or implementation is approved, and `DDM-3` remains undecided~~ **that ruling approved no storage key, slug, identifier, configuration format, schema or implementation**. **`DDM-3` was decided separately** — `ADR-021`, `Accepted` 2026-10-09 (issue #167) — which selects a **stable machine key** in a `text` column under a **`CHECK`** constraint and records the **authoritative 16-key mapping**; **still no configuration format, schema, migration or implementation is approved**. |
| FR-DATA-11 | The system shall expose to visitors only the fields of the approved public projection — business name, category, description, locality, country, administrative area where provided, postal code only where provided and designated for public display, and each contact method the business designated public — and shall never present any other stored field as public content. | System | V5; cross-cutting privacy | Must | The public read path shall **not** expose every stored field by default. Full classification in `docs/08` *Field classification*. Decided: OQ-7. |
| FR-DATA-11b | The system shall classify every listing field it holds as **public**, **administrator-visible**, or **audit-only**, shall treat any field whose classification is undecided as not public, and shall never include administrator-visible or audit-only information in the public projection. | System | V5; cross-cutting privacy | Must | Fail-closed by default. Administrator-visible: record status, submission, update and review timestamps, reviewer identity, moderation notes, rejection reasons, approval/unpublishing history, and submitter information where another approved requirement authorises its collection. Audit-only: audit entries and security-event records. Decided: OQ-7; whether each such field is collected or retained remains OQ-13 (retention) and OQ-14/NOQ-8 (audit). **OQ-11 is Decided and adds no public field:** it requires a listing's **current publication state** and **current unpublish reason** to be administrator-visible and **never public**, leaving the public projection unchanged. OQ-8/OQ-8b are Decided and add no field — they set obligation and validation only. OQ-10 is Decided and adds no field — a revision changes the values of already-approved fields, and the public field set is unchanged. |
| FR-DATA-11c | The system shall allow a business to designate which of its supplied contact methods (phone, email, website) may be displayed publicly, and shall publish a contact method only where it was intentionally supplied as a business contact, was designated for public display, and passed moderation. | System | V5; cross-cutting privacy | Must | Contact methods remain individually optional (FR-DATA-07); this requirement adds no contact-method minimum of its own — the cross-field minimum is **FR-DATA-08**, Decided under OQ-8b and enforced before approval — and it introduces no contact form, messaging service, or social-media field. How the designation is represented is `DDM-6`, selected by `ADR-017` (Accepted 2026-09-17). Decided: OQ-7. **Designation authority and defaults (ungated Product Owner policy clarification, ADR-017 Q-4, issue #135):** the business chooses public or private for **each** contact value it supplies, and for a supplied postal code (FR-DATA-06b), **at submission**; **the default is private**. An administrator may **restrict** a value's visibility but **cannot make a business-withheld value public** — approval alone never grants public visibility. A **new or replacement** contact value or postal code **defaults to private** and does **not inherit** the replaced value's designation. A designation change to an approved listing follows the existing revision and approval workflow (FR-ADM-10, FR-ADM-10b). This adds no actor, permission or business editing route. |

### The approved MVP category vocabulary (`FR-DATA-10`)

**Approved by Product Owner ruling, 2026-10-08 (Joe S.), issue #165.** This subsection is
the **authoritative record of the category values** required by `FR-DATA-10`, and the
single source of truth for them. `docs/08` `E2`, `docs/09` `OP-11`, `docs/10`'s S1 and S3
category controls, and `docs/04` `V3` each reference this list rather than restating it.

**What the ruling approved:** the user-facing labels; their exact spelling, capitalization
and punctuation; each category's inclusion definition; each category's boundary note; the
tie-breaker rules; and the alphabetical display order. **Exactly 16 categories.**

**What the ruling did not approve, and what must not be inferred from this list:** storage
keys or slugs, UUID or numeric category identifiers, the configuration-file format,
physical database representation, any seed mechanism, schema or migration, category
validation implementation, filtering implementation, an administrator
category-management interface, provisioning, or persistence. **The labels below are
user-facing display text, not machine identifiers.** ~~Physical representation — including
whether a stable identifier exists apart from the display label — remains **`DDM-3`**,
undecided.~~ **Physical representation was decided separately, and it does not change a
single label below:** `ADR-021` (`Accepted` 2026-10-09, issue #167) answers the question
this ruling left open — **a stable, repository-owned textual machine key does exist apart
from the display label**, one per category, stored in a mandatory, non-null `text` column
under a **`CHECK`** constraint, while **the labels themselves are not stored**. The
**authoritative key-to-label mapping lives in `ADR-021`**, and the labels, definitions,
boundaries, tie-breakers and display order below **remain authoritative here and
unchanged**.

#### Approved labels, definitions and boundaries

Listed in the **approved alphabetical display order**. The *Boundary* column records where
a listing that could plausibly sit here belongs instead; it is semantic guidance for
submitters and for administrator correction, not a validation rule.

| # | Approved label | Inclusion definition | Boundary |
|---|---|---|---|
| 1 | **Arts, Culture & Entertainment** | Creative practice, cultural venues and performance; artists and makers selling their own work; venues and entertainment services. | Teaching an art form as the core offering → *Education & Childcare*. Reselling others' goods → *Retail & Shopping*. Physical recreation → *Fitness & Recreation*. |
| 2 | **Automotive & Transport** | Vehicle sale, repair, servicing and hire; driving instruction; taxi, courier, delivery, removals and freight. | Arranging trips and stays → *Travel & Accommodation*. Vehicle insurance → *Financial & Insurance Services*. Parts retail without service → *Retail & Shopping*. |
| 3 | **Beauty & Personal Care** | Hair, nails, skin, grooming and cosmetic treatment; spa and non-clinical personal treatment. | Clinically regulated treatment → *Health & Medical*. Exercise and physical training → *Fitness & Recreation*. Product retail without treatment → *Retail & Shopping*. |
| 4 | **Community & Nonprofit** | Nonprofits, charities, voluntary and mutual-aid groups, community associations, public and community resources, places of worship and faith groups, support and advocacy organizations. | Reserved for organizations whose **purpose itself** is community, representation or mutual support. An organization that principally trades is classified by its **operational sector**, not its legal form — a charity-run café is *Food & Drink*, a fee-charging school is *Education & Childcare*. |
| 5 | **Education & Childcare** | Schools and nurseries, childcare and after-school provision, tutoring, training, driving and music instruction, adult and vocational learning. | Childminding offered as domestic help → *Home & Trade Services*. Sports coaching → *Fitness & Recreation*. Corporate consultancy → *Professional Services*. |
| 6 | **Financial & Insurance Services** | Banking and credit, mortgage and insurance broking, financial advice and planning, pensions, bookkeeping and tax where the business presents itself as financial. | Legal practice → *Professional Services*. Financial software → *Technology & Digital Services*. Accountancy and bookkeeping sit **here** rather than in *Professional Services*, because submitters and visitors look for them as financial. |
| 7 | **Fitness & Recreation** | Gyms and studios, sports clubs and coaching, instructor-led exercise, leisure and outdoor-activity providers. | Clinical rehabilitation or physiotherapy → *Health & Medical*. Cosmetic treatment → *Beauty & Personal Care*. Spectator entertainment → *Arts, Culture & Entertainment*. Equipment retail → *Retail & Shopping*. |
| 8 | **Food & Drink** | Restaurants, cafés, bars and pubs, takeaways, catering, bakeries, grocers, delicatessens, breweries, farm shops and food producers selling locally. | A venue hired out where food is incidental → *Arts, Culture & Entertainment*. General stores with a food counter → *Retail & Shopping*. Nutrition and dietetic advice → *Health & Medical*. Food manufacturing or wholesale distribution → *Industrial & Wholesale*. |
| 9 | **Health & Medical** | Clinical and regulated healthcare — medical and dental practice, pharmacy, optical and hearing care, physiotherapy and clinical therapies, mental-health practice, nursing and care provision. | **Deliberately narrow**, so that the filter stays clinically meaningful. Cosmetic treatment → *Beauty & Personal Care*. Exercise provision → *Fitness & Recreation*. Animal health → *Pets & Animal Services*. Classifies the **provider** only — never a patient, condition or demographic. |
| 10 | **Home & Trade Services** | Building, renovation and repair; the trades (plumbing, electrical, roofing, joinery, decorating); gardening and landscaping; cleaning, domestic help and property maintenance; installers and fitters. | Property sale, letting and management → *Professional Services*. Materials retail without fitting → *Retail & Shopping*. IT support → *Technology & Digital Services*. Materials manufacturing or wholesale supply → *Industrial & Wholesale*. |
| 11 | **Industrial & Wholesale** | Manufacturing operations; wholesale distribution; industrial services; business-supply operations not principally serving consumers through ordinary retail. | **Not a miscellaneous catch-all**, and must never be used as one. Consumer-facing product shops → *Retail & Shopping*. Individualized consulting and knowledge work → *Professional Services*. Software and digital-product businesses → *Technology & Digital Services*. Transport operations → *Automotive & Transport*. Home repair and construction trades → *Home & Trade Services*. |
| 12 | **Pets & Animal Services** | Veterinary practice, grooming, boarding, kennels and catteries, dog walking and training, pet supplies and feed. | Human healthcare → *Health & Medical*. Livestock and commercial agricultural production → *Industrial & Wholesale* where it is a manufacturing or wholesale operation; a farm shop selling locally is *Food & Drink*. |
| 13 | **Professional Services** | Legal practice; architecture, surveying and engineering consultancy; business, marketing and HR consultancy; design and communications agencies; estate agency, letting and property management; funeral directors; other advisory and business-to-business professional practice. | Financial and insurance advice → *Financial & Insurance Services*. Software and IT → *Technology & Digital Services*. Physical work on property → *Home & Trade Services*. Manufacturing, wholesale distribution and industrial supply → *Industrial & Wholesale*. **The broadest approved category**, and the first candidate for a later governed additive split. |
| 14 | **Retail & Shopping** | Shops and physical retail of goods; online sellers of physical products; markets and stalls; secondhand, antique and charity retail; specialist and gift retail. | A **named sector category takes precedence over general retail**: food and drink → *Food & Drink*; pet supplies → *Pets & Animal Services*. Goods sold incidentally alongside a service → the service's category. Wholesale and business supply rather than consumer sale → *Industrial & Wholesale*. |
| 15 | **Technology & Digital Services** | Software development, web and app development, IT support and managed services, hosting, data and digital consultancy, and digital marketing where the offering is technical. | Device and hardware retail → *Retail & Shopping*. Non-technical business consultancy → *Professional Services*. Hardware manufacturing or wholesale distribution → *Industrial & Wholesale*. Repair of consumer devices may truthfully sit here or in *Retail & Shopping*, decided by the principal offering. |
| 16 | **Travel & Accommodation** | Hotels, guest houses, bed and breakfast, self-catering and short-stay accommodation; campsites; travel agents and tour operators; local tours and guides. | Passenger transport, taxis and vehicle hire → *Automotive & Transport*. Hospitality without accommodation → *Food & Drink*. Visitor attractions → *Arts, Culture & Entertainment*. |

**Display order.** The alphabetical order above is the **approved initial display order**,
and is a **user-facing product decision** — it governs the order in which the vocabulary is
presented in the S1 filter control and the S3 submission control (`docs/10`). It says
**nothing** about physical storage order, sort keys, enumeration member order,
configuration-file order or any index: ~~those remain `DDM-3`~~ **those were `DDM-3`'s, and
`ADR-021` (`Accepted` 2026-10-09, issue #167) settles them by storing none of them — the
approved display order is **never persisted**, and no sort key, enumeration member order or
index is created**. The exact control element,
typography and layout remain `DU-2`.

#### Approved tie-breaker rules

A listing carries **exactly one** category (`FR-DATA-02`, `docs/08` `VR-S5`), so a business
that plausibly fits more than one must resolve to a single value. These rules are approved
guidance for submitters and for administrator correction during moderation. **They are not
a validation algorithm, and they never authorize assigning more than one category.**

1. **Classify by the listing's principal customer-facing offering** — what the business
   mainly does for the people who come to it, not its legal form, its trade body, or a
   secondary activity.
2. **Prefer the category most useful to a visitor seeking that offering** — where two
   labels are both truthful, choose the one under which a visitor would look for this
   business.
3. **A named sector category takes precedence over a general one** — *Food & Drink* over
   *Retail & Shopping* for a delicatessen; *Pets & Animal Services* over *Retail &
   Shopping* for a pet shop.
4. **Sector before legal form** — a nonprofit that principally trades is classified by its
   operational sector; *Community & Nonprofit* is for organizations whose purpose itself is
   community, representation or mutual support.
5. **Use administrator correction during moderation** where the submitter's selection is
   not the closest truthful fit (`docs/08` field authority; `docs/04` `A3`). A post-approval
   correction travels the existing `OQ-10` revision path.
6. **Never assign a knowingly false category merely to avoid rejection.** The obligation is
   the *closest truthful applicable* category, not the nearest available box.
7. **Where no approved category truthfully applies, the existing refusal/rejection
   behaviour applies.** There is **no `Other`, `Miscellaneous` or `Uncategorized` value, no
   "uncategorized" state, and no category-proposal workflow** (`OQ-5`).

#### Deliberate exclusions

The ruling explicitly declined each of the following, and none may be introduced without a
new governed Product Owner decision:

- **No `Other`, `Miscellaneous` or `Uncategorized` category**, and no proposal workflow.
- **No `Health & Wellness` merge** — *Beauty & Personal Care*, *Fitness & Recreation* and
  *Health & Medical* remain **three separate categories**, which is what keeps the medical
  filter clinically meaningful.
- **No `Religious & Faith Organizations` category** — faith groups and places of worship
  are covered by *Community & Nonprofit*; a category keyed to religion would classify
  listings by a protected trait, and no requirement asks for it.
- **No `Events` category** — event *services* are classified by sector (a caterer is *Food
  & Drink*; a photographer is *Arts, Culture & Entertainment*).
- **No `Agriculture` category** — a farm shop selling locally is *Food & Drink*; a
  production or wholesale operation is *Industrial & Wholesale*.
- **No hierarchy, parent/child relationship, tags, facets, aliases, synonyms, localized
  labels or icons** (`OQ-5`; `docs/08`, `docs/10` — *do not pre-build*).

**Supersession.** The 16-category list above **supersedes the Compact 9, Balanced 15 and
Granular 22 alternatives** considered in issue #165; none carries residual standing.

**Later changes are separately governed.** Any addition, removal, rename or boundary change
requires a **separately governed Product Owner decision**, applied through a **deployment**
— the vocabulary is repository-owned configuration, there is **no runtime management path**,
and **no administrator category-management interface is authorized** (`OQ-5`).

**Implementation status.** ~~Nothing below is built.~~ **This vocabulary is now enforced in
both places** (issue #175, 2026-10-10): a **governed configuration module**
(`src/domain/listing/category.ts`) holds the 16 approved keys with their labels, inclusion
definitions and boundary notes, `src/domain/listing/validation.ts` rejects any other value as
`CATEGORY_NOT_APPROVED` at submission **and** before approval, and the first schema migration's
**`CHECK`** constraints enforce the same set in the database — proved **equal in both
directions** against a real PostgreSQL server by catalogue inspection. `ListingContent.category`
is additionally narrowed to `CategoryKey` at compile time, which is a convenience and **not** the
enforcement. The former fixture strings `"food-and-drink"` and `"retail"` were **never approved
values** and are now rejected everywhere, including by attacking tests.

**Still not built:** `OP-11` is unimplemented; no filtering or browsing exists; no reference
table, enum or seed data exists; no category UI selector exists; and **no provisioning,
credentials or production migration execution is authorized** — `C9` persistence does not
exist. Later additions, renames or removals still require a separately governed Product Owner
decision applied through a deployment.

---

## Validation requirements

Source journeys: L2, L3, A3, A6. Applies to public submissions and
administrator edits.

| ID | Requirement | Actor | Source | Priority | Notes |
|---|---|---|---|---|---|
| FR-VAL-01 | The system shall validate a listing submission before recording it, rejecting a submission that does not satisfy the rules applicable at initial submission — the required-at-submission field set, and the format and safety checks for every value actually supplied. | System | L2, L3 | Must | Rule set per FR-VAL-05. The **contact minimum (FR-DATA-08) is not applied at this step** — it is a before-approval obligation. Decided: OQ-8. |
| FR-VAL-02 | The system shall identify validation problems at the level of the specific field(s) affected and present a clear message describing what to fix for each. | Lister | L3 | Must | Field-level, specific, recoverable. |
| FR-VAL-03 | The system shall preserve already-entered input when validation fails — including a supplied value that itself failed validation — so the submitter can correct only the problem fields and resubmit. | Lister | L3 | Must | No data loss on error. **An optional value that was supplied but is invalid is never silently dropped or ignored**: the failure is visible (FR-VAL-02), the entered value is retained for correction, and the submission or revision cannot proceed through the applicable validation step as though the value had not been supplied (FR-VAL-05). Decided: OQ-8. |
| FR-VAL-04 | The system shall validate administrator edits to a submission or an approved listing, and the content of a pending revision, using the same applicable field-obligation and format rules applied to public submissions. | Administrator | A3, A6 | Must | Parallels FR-VAL-01 for admins, and is **the bridge that carries the FR-VAL-05 rules to revisions** (VR-6). Unchanged by OQ-10: a revision is validated by the same rules as a submission, including under the FR-ADM-10b atomic operation. **A pending revision may be incomplete or invalid while it is being edited or corrected**; the currently approved listing stays publicly visible throughout (OQ-10), and a revision cannot be **approved** until every before-approval obligation is satisfied — including at least one usable phone, email, or website (FR-DATA-08). **Rejection or failed validation leaves the currently approved listing unchanged.** The rule set is FR-VAL-05. |
| FR-VAL-05 | The system shall enforce, at initial submission, the presence of business name, category, description, locality, and country, and shall accept the omission of administrative area, postal code, phone, email, and website; shall enforce format and safety checks on every value actually supplied, at submission and at every subsequent revision; and shall enforce before approval that all of those obligations are satisfied and that the listing carries at least one usable contact method — phone, email, or website. | System | L3 | **Must** | Decided: OQ-8, OQ-8b. Fills VR-S1 (required set), VR-S2 (contact minimum), VR-S3 (format posture); resolves seam S-1. **Three distinct gates:** *required at initial submission* (the five fields), *required when supplied* (format and safety checks on any optional value provided), and *required before approval* (all of the former, plus the FR-DATA-08 contact minimum). **Format posture:** permissive, international-friendly, and technology-neutral — enough to reject values that are blank where required, malformed beyond practical use, unsafe, outside established length or content boundaries, or incompatible with the field's basic purpose. It prescribes **no** regular expression, validation library, UI widget, schema type, database constraint, country-specific phone format, URL parser, or email-validation algorithm. **Location is never a contact method.** Invalid supplied values behave per FR-VAL-03. Administrator completion during moderation is FR-ADM-04 — completion, never a validation bypass. |
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
| FR-MOD-06 | The system shall provide an administrator corrective actions for already-public content found to be problematic, including unpublishing the listing under FR-ADM-12 and correcting its content under FR-ADM-09 / FR-ADM-10. | Administrator | A7 (exception) | **Must** | Decided: OQ-11. **Raised from `Should` by OQ-11.** Abuse-in-public handling is now **resolved**, not merely flagged: an authorized administrator may withdraw problematic public content by unpublishing it (FR-ADM-12), with a recorded reason and explicit confirmation. The corrective action is **reversible** and destroys nothing — permanent deletion is excluded from the MVP (OQ-11). Approving a revision while the listing is unpublished corrects content but does **not** republish it (FR-ADM-10, FR-MOD-01), so a correction cannot silently return problematic content to public view. Duplicate resolution remains FR-ADM-13 / OQ-12. |
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
| FR-CONF-04 | The system shall display an unambiguous confirmation of the resulting state after an administrator edits and saves a submission or approved listing. | Administrator | A6; confirmations | Should | Confirms the update took effect. For an approved listing the confirmation shall state the resulting **revision** state — whether a pending revision was recorded, or its information became the effective public version — so that "saved" is never mistaken for "published" (FR-ADM-10, FR-ADM-10b). |

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
| FR-AUD-01 | The system shall maintain a status for every listing record with the values *pending*, *approved*, and *rejected*, and shall change status only through defined administrator actions. | System | Scope: data; A4, A5 | Must | Lifecycle: submitted→pending; approve→approved; reject→rejected. **Unchanged by OQ-10:** a pending revision adds no listing status — a listing carrying one is still *approved* (DI-1). **Unchanged by OQ-11 (Decided 2026-08-04):** unpublishing adds **no fourth listing status** — an unpublished listing is still *approved*, and its public availability is the separate **publication-state** product concept (docs/08 *Status model*). `approved → unpublished` is a **publication-state change, not a status transition**, so no status transition edge is added (NFR-DATA-02). The three-value set is not reopened. |
| FR-AUD-02 | The system shall record the submission date of each listing at the time it is submitted. | System | Scope: data | Must | Administrative field (FR-DATA-09). Written **once** and never changed; initialized to the **same caller-supplied instant** as the last-updated date (ungated Product Owner ruling, issue #141; `NFR-DATA-05`, `DI-6`). |
| FR-AUD-03 | The system shall record the last-updated date of each listing whenever its content or status changes. | System | Scope: data | Must | Administrative field (FR-DATA-09). Each such change requires an instant **strictly later** than the current value, and an equal or earlier one is refused without mutation; **publication-state changes and refused actions change it not at all** (ungated Product Owner ruling, issue #141; `NFR-DATA-05`, `DI-6`). |
| FR-AUD-04 | The system shall keep record status and administrative dates as administrator/system-managed data that is never editable by the public. | System | Scope: data; boundaries | Must | Integrity of the status lifecycle. |
| FR-AUD-05 | The system shall record administrator edits and moderation actions in an audit log. | System | A3; stakeholder interest | Should | Audit logging is a stakeholder interest, **not** a mandatory MVP requirement. Decision pending: OQ-14. |
| FR-AUD-06 | The system shall retain a rejected initial submission and a rejected approved-listing revision for a defined retention period measured from the rejection, shall make each retained record available only to authorized administrators during that period, and shall purge each such record once it becomes purge-eligible at the end of that period. | System | A5, A6 | **Must** | Decided: OQ-13 (2026-08-04). **Raised from `Should` by OQ-13** — retention **and** purge are now approved for the MVP. **One uniform policy for both covered record types.** The period is **90 days from rejection** and its purpose limitation is `NFR-PRIV-05`. **Retention expiry makes a record *purge-eligible*; eligibility is not itself a purge and changes nothing else** — the record stays administrator-visible until purged. **Purge is a system obligation**, not an administrator-invoked action: it requires no per-record administrator decision, is **all-or-nothing** for the record concerned (NFR-DATA-03, DI-3), is **idempotent** (purging an already-purged or absent record is not an error), and **never alters an approved listing or any current approved version**. **Unpublished approved listings are excluded** (OQ-11). **Historical audit events are not governed here** — that remains OQ-14/NOQ-8, and purging a record does not necessarily purge audit events. Representation: DDM-8 and DDM-9, selected by ADR-017 (Accepted 2026-09-17), conforming to ADR-006. **Retention anchor (ungated Product Owner policy clarification, ADR-017 Q-1/Q-2, issue #137):** the moment of rejection is recorded as a **write-once rejection timestamp** — on a rejected initial submission and on a rejected revision — **separate from last-updated**, and used **only for retention eligibility**. It is administrator-visible and never public, and it is **not** review-action metadata (S-7) or an audit record (OQ-14/NOQ-8). |

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
| Basic location filtering | FR-SRCH-05, FR-DATA-04, FR-DATA-05, FR-DATA-06, FR-DATA-06b, FR-DATA-06c |
| Listing details | FR-VIS-04, FR-VIS-05, FR-DATA-11, FR-DATA-11b, FR-DATA-11c |
| Public listing-request form | FR-SUB-01, FR-SUB-02, FR-SUB-03 |
| Pending by default | FR-SUB-04, FR-MOD-01, FR-AUD-01 |
| Administrator review | FR-ADM-01, FR-ADM-03, FR-ERR-03 |
| Administrator approval | FR-ADM-06, FR-CONF-02 |
| Administrator rejection | FR-ADM-07, FR-ADM-08, FR-CONF-03 |
| Administrator editing | FR-ADM-04, FR-ADM-09, FR-ADM-10, FR-ADM-10b, FR-VAL-04, FR-CONF-04 |
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
| V4 Filter by location | FR-SRCH-05, FR-SRCH-07, FR-DATA-04, FR-DATA-05, FR-DATA-06, FR-DATA-06b |
| V5 View listing details | FR-VIS-04, FR-VIS-05, FR-VIS-07, FR-VIS-08, FR-DATA-11, FR-DATA-11b, FR-DATA-11c |
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
| A6 Review/update existing listing | FR-ADM-09, FR-ADM-10, FR-ADM-10b, FR-ADM-12, FR-VAL-04, FR-CONF-04 |
| A7 Handle duplicate/abusive content | FR-ADM-11, FR-ADM-13, FR-MOD-04, FR-MOD-05, FR-MOD-06, FR-MOD-08 |
| Cross-cutting: accessibility | FR-ACC-01..05 |
| Cross-cutting: responsiveness | FR-ACC-03 |
| Cross-cutting: privacy | FR-DATA-11, FR-DATA-11b, FR-DATA-11c, FR-VIS-05 |
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
- **A-3.** A small, predefined set of categories is sufficient for launch. **Discharged into a concrete list:** the approved vocabulary is **16 categories** (2026-10-08, issue #165) — see *The approved MVP category vocabulary*.
- **A-4.** Simple location fields — locality and country, with an optional
  administrative area and postal code — support useful filtering, and the
  directory is multi-country capable from launch (`OQ-6`).
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
| ~~OQ-5~~ | ~~Single vs. multiple category selection; who curates the category set and can admins manage it?~~ **Decided 2026-10-07 (Joe S.):** **exactly one required** category per listing, drawn from a **predefined, finite, platform-owned** vocabulary that is **flat** — **no hierarchy, tags, facets, aliases or localized labels**. Submitters select the **closest truthful applicable** category; there is **no free-text category, no "Other" value and no category-proposal workflow**. **Administrators may correct the category during moderation**, and a post-approval category change travels the **existing OQ-10 revision path** — **no new moderation object or state is introduced**. Where no approved category truthfully applies, the listing follows the **existing refusal/rejection behavior**; **no "uncategorized" state or value exists**. **FR-SRCH-09 multi-category selection remains unapproved and deferred**, and MVP filtering uses the **single canonical category**. The vocabulary is **repository-owned configuration changed through deployment**. ~~The initial category values are not selected by this ruling and require a separate Product Owner approval before `DDM-3` and the first schema migration.~~ **Those values were approved on 2026-10-08 (Joe S., issue #165): 16 categories, recorded with definitions, boundaries, tie-breakers and display order in *The approved MVP category vocabulary*. `DDM-3` is therefore no longer blocked by vocabulary approval — ~~it remains **undecided** and is now **ready for its own physical-design decision**, which the first schema migration still follows.~~ **`DDM-3` was then decided — `ADR-021`, `Accepted` 2026-10-09 (issue #167):** a **stable, repository-owned textual machine key** in a mandatory, non-null `text` column, enforced by a **`CHECK`** constraint over the complete approved key set, with **no reference table, foreign key, enum or seed data**, and labels and display order kept as governed documentation and future configuration.** ~~**`DDM-3` remains responsible for physical representation**~~ **`ADR-021` now holds the physical representation**, and ~~**no implementation is authorized** — the executable domain still accepts any non-blank category string, so **`DI-9` remains unimplemented**.~~ **Superseded by implementation on 2026-10-10 (issue #175):** `DI-9`/`VR-2`/`AV-7` are now enforced by the governed configuration module `src/domain/listing/category.ts`, by the domain validators at both validation stages, and by the migration's `CHECK` constraints — proved **exactly equal in both directions** against a real PostgreSQL server; `"food-and-drink"` and `"retail"` are now **rejected** everywhere. See FR-SRCH-04, FR-SRCH-09, FR-DATA-02, FR-DATA-10 and `docs/13`. | FR-SRCH-09, FR-DATA-02, FR-DATA-10 | Journeys OQ-5; Scope OQ-4; V3 |
| ~~OQ-6~~ | ~~Location granularity — city only, or also state/region and country (and is launch multi-country)?~~ **Decided:** locality **required**, country **required** (multi-country from launch), administrative area **optional**, postal code **optional** (international text), street address **not collected**. See FR-DATA-04, FR-DATA-05, FR-DATA-06, FR-DATA-06b, FR-DATA-06c and `docs/13`. | FR-SRCH-05, FR-DATA-04, FR-DATA-05, FR-DATA-06, FR-DATA-06b, FR-DATA-06c | Journeys OQ-6; Scope OQ-1, OQ-2; V4 |
| ~~OQ-7~~ | ~~Which listing/contact fields are ever shown publicly vs. withheld?~~ **Decided:** the public projection is business name, category, description, locality, country, administrative area where provided, postal code only where provided and designated public, and each contact method the business designated public; everything else is administrator-visible or audit-only and never public. See FR-DATA-11, FR-DATA-11b, FR-DATA-11c, FR-VIS-04, `docs/08` *Field classification*, and `docs/13`. | FR-VIS-04, FR-VIS-05, FR-DATA-11, FR-DATA-11b, FR-DATA-11c | Journeys OQ-7; V5, privacy |
| ~~OQ-8~~ | ~~Which fields are required at submission (and format checks)?~~ **Decided:** required at initial submission — business name, category, description, locality, country. Optional at initial submission — administrative area, postal code, phone, email, website. Format checks are **permissive, international-friendly, and technology-neutral**, rejecting values that are blank where required, malformed beyond practical use, unsafe, outside established length or content boundaries, or incompatible with the field's basic purpose; no regular expression, library, widget, schema type, database constraint, country-specific phone format, URL parser, or email algorithm is prescribed. A supplied-but-invalid optional value fails visibly, is preserved for correction, and is never silently dropped. An administrator may complete or correct information during moderation before approval, without bypassing validation. See FR-SUB-02, FR-SUB-05, FR-ADM-04, FR-VAL-01, FR-VAL-03, FR-VAL-05 and `docs/13`. | FR-SUB-02, FR-SUB-05, FR-ADM-04, FR-ADM-06, FR-VAL-01, FR-VAL-03, FR-VAL-05 | Journeys OQ-8; L2, L3 |
| ~~OQ-8b~~ | ~~Is at least one contact method enforced per listing?~~ **Decided:** yes — **before approval, not at initial submission**. A listing must carry at least one **usable** contact method (phone, email, or website) before it may be approved; locality, administrative area, postal code, country, and physical-location information never count. A submission may enter moderation with none. **No offline-business exemption** (Option B3 was not selected). "Usable" is structural, not verified: non-blank, passing the permissive format and safety checks, and retained as the value proposed for the listing. See FR-DATA-08, FR-ADM-06, FR-VAL-05 and `docs/13`. | FR-DATA-07, FR-DATA-08, FR-ADM-04, FR-ADM-06, FR-VAL-05 | Scope OQ-3; Journeys OQ-8 |
| OQ-9 | Is there any anti-spam safeguard for the unauthenticated submission form? | FR-SUB-09 | Journeys OQ-9; L2 |
| ~~OQ-10~~ | ~~Does an edit to an approved listing publish immediately or need secondary review?~~ **Decided:** secondary review. A proposed change to an approved listing is recorded as a **pending revision** that is never publicly visible; the approved listing stays public at its last approved version; approval makes the revision's information the effective public version; rejection leaves the approved listing unchanged. At most one pending revision per listing. An authorized administrator may create and approve a revision in one atomic authorized operation, with all safeguards enforced. See FR-ADM-10, FR-ADM-10b, `docs/08` `E7`/`DI-10`/`DI-11`, and `docs/13`. | FR-ADM-10, FR-ADM-10b | Journeys OQ-10; Scope OQ-10; A6 |
| ~~OQ-11~~ | ~~Can administrators unpublish or remove an approved (public) listing in the MVP?~~ **Decided 2026-08-04 (Joe S.):** yes — an authorized administrator may **unpublish** an approved listing and may **republish** it. Unpublishing is **reversible**, requires a **recorded current reason** and **explicit confirmation**, and excludes the listing from **every** public read path; a previously shared direct link receives the same **generic** unavailable result. The listing stays **administratively visible**. A **pending revision remains pending**, and approving it while unpublished updates the current approved version **without republishing**; republishing exposes the **current** approved version. **Permanent deletion is excluded from the MVP**, and **public removal requests are outside MVP scope**. **`FR-AUD-01` is unchanged** — publication state is a **separate product concept** from listing status, and **no fourth status** is added. Representation deferred (ADR-006, DDM-9) — since selected by ADR-017 (Accepted 2026-09-17); retention/purge remains OQ-13. | FR-ADM-12, FR-VIS-08, FR-MOD-06, FR-AUD-01 | Journeys OQ-11; Scope OQ-5; A6, A7 |
| OQ-12 | How are duplicate/near-duplicate submissions resolved during review? | FR-ADM-13, FR-MOD-04 | Journeys OQ-12; Scope OQ-8; A7 |
| ~~OQ-13~~ | ~~Are rejected submissions retained (for audit) or discarded?~~ **Decided 2026-08-04 (Joe S.):** retained, then purged. **Covered:** rejected initial submissions **and** rejected approved-listing revisions, under **one uniform policy**. **Retained 90 days from rejection**, for the stated purpose of allowing an administrator to review, explain, or reconsider a moderation decision and to provide moderation context for a bounded time. Retained records are **administrator-visible only** — never public, no submitter-facing view — including the **current rejection reason**. A rejected record is **terminal**: not editable, not re-approvable. At 90 days it becomes **purge-eligible** (visibility unchanged until purged), and **purge execution is in MVP scope as a system obligation** — all-or-nothing, idempotent, never altering an approved listing. **Excluded:** unpublished approved listings (OQ-11), the resubmission workflow, and category-specific retention. Audit events remain OQ-14/NOQ-8; representation is DDM-8/DDM-9, selected by ADR-017 (Accepted 2026-09-17), conforming to ADR-006. | FR-ADM-07, FR-AUD-06, NFR-PRIV-05 | Journeys OQ-13; Scope OQ-6; A5, A6 |
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
