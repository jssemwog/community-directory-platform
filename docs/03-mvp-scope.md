# Community Directory Platform — MVP Scope

This document defines the **minimum viable product (MVP)** for the first
production release of the Community Directory Platform. It decides which
capabilities are required for a first useful release and which are deferred.

It builds on and is consistent with:

- [`docs/01-vision.md`](./01-vision.md) — product vision.
- [`docs/02-stakeholders.md`](./02-stakeholders.md) — stakeholders and needs.

**Scope of this document.** It describes *what* the MVP does (functional scope),
not *how* it is built. It does **not** select frameworks, databases, hosting
platforms, or implementation patterns; those are deferred to later architecture
work. The **Community Directory Mini Lab** is treated only as a learning
prototype — a source of lessons, not a template. Nothing is included here merely
because it appeared in that prototype.

## How to read this document

Capabilities are marked:

- **In scope** — committed for the MVP.
- **Out of scope** — explicitly excluded from the MVP (may return as a future
  capability).
- **Open question** — a decision not yet made; recorded under *Risks and open
  questions*.

---

## MVP purpose

Deliver the smallest release that lets community members **find trustworthy local
listings** and lets **administrators keep those listings accurate**, while
allowing the public to **submit new listings for review**.

The MVP proves the core loop from the vision — public search of approved
listings plus a moderated submission flow — as a real, operable product rather
than a prototype.

## MVP users

Derived from the primary stakeholders in
[`docs/02-stakeholders.md`](./02-stakeholders.md):

- **Visitors** — find and view approved listings; no account required.
- **Listers** — members of the public who submit a listing request. In the MVP a
  lister is simply *anyone using the public submission form* — there are no
  lister accounts (see Out of scope).
- **Administrators** — review submissions and maintain listing accuracy.

Secondary stakeholders (community leaders, sponsors/advertisers, support/
technical maintainers) are acknowledged but are **not** a design focus of the
MVP.

> **Need vs. feature.** Stakeholder *needs* (e.g. "owners want their listing to
> be accurate and visible") are met in the MVP through *features available to
> everyone* (a public submission form + administrator editing), **not** through
> owner accounts. The need is served; the specific feature is deferred.

## In-scope capabilities

Committed for the MVP:

- **Public browsing of approved listings** — anyone can view the directory.
- **Keyword search** — find listings by text.
- **Basic category filtering** — filter by a single predefined category.
- **Basic location filtering** — filter by a location value (see *Data required
  for a listing* and open questions for granularity).
- **Listing details** — view the full information of one approved listing.
- **Public listing-request form** — anyone can submit a proposed listing.
- **Pending by default** — new submissions are not public until approved.
- **Administrator review** — administrators can see pending submissions.
- **Administrator approval** — make a listing public.
- **Administrator rejection** — decline a submission.
- **Administrator editing** — correct or update listing content.
- **Protection against unauthorized public changes** — only administrators can
  approve, edit, or unpublish listings; the public can only submit requests.
- **Responsive design** — usable on common phone, tablet, and desktop sizes.
- **Basic accessibility** — sensible semantics, keyboard access, and readable
  contrast for core flows.

## Out-of-scope capabilities

Explicitly excluded from the MVP (candidates for later work; see *Future
capabilities*):

- Business-owner accounts.
- Self-service listing claiming.
- Reviews and ratings.
- Listing analytics.
- Paid advertising or sponsored placement.
- Community event management.
- Transactions, bookings, or payments.
- Social-network features.
- Native mobile applications.
- Advanced integrations (external data sources, third-party APIs).

Excluding these keeps the MVP small enough to build and operate while still
delivering the core value in the vision.

## Core user journeys supported

1. **Visitor browses approved listings** — opens the directory and sees approved
   listings.
2. **Visitor searches or filters listings** — narrows results by keyword,
   category, and/or location.
3. **Visitor views listing details** — opens one listing to see its full
   information.
4. **Lister submits a listing request** — completes the public form; the
   submission is saved as *pending* and is not yet public.
5. **Administrator reviews a pending submission** — views the queue of pending
   submissions and their details.
6. **Administrator approves, rejects, or edits a submission** — approves (makes
   public), rejects (declines), or edits (corrects content, before or after
   approval).

These six journeys define the functional boundary of the MVP.

## Administrative workflow

The MVP moderation flow, expressed functionally (not as an implementation):

1. A submission arrives from the public form with status **pending**.
2. An administrator reviews the pending submission's content.
3. The administrator takes one action:
   - **Approve** → status becomes **approved**; the listing becomes publicly
     visible.
   - **Reject** → the submission is declined and does not become public.
   - **Edit** → the administrator corrects content; the listing can then be
     approved (or, if already approved, the correction is published).
4. Approved listings may be **edited** later by an administrator to keep them
   accurate.
5. Approved listings may be **unpublished** by an authorized administrator, and
   **republished** later. Unpublishing withdraws the listing from every public
   path while the record continues to exist administratively; it is **reversible**
   and destroys nothing. **Decided: `OQ-11` (2026-08-04).**

**Open question:** whether rejected submissions are retained or discarded
(`OQ-13`). Recorded below.

## Content and moderation boundaries

- **Nothing is public until an administrator approves it.** This upholds the
  vision principle "trust over volume."
- **The public can only *request* listings**, never publish, edit, or delete
  them directly.
- **Administrators are the sole moderators** of what appears publicly.
- The MVP moderates listing records only; it does not host user-generated
  content such as reviews, comments, or events.

## Data required for a listing

A **minimal** listing record is proposed below. Fields are classified as **required at
initial submission**, **optional at initial submission**, **administrative**
(system/admin-managed, not entered by the public), or **not collected**. Not every
candidate field is automatically included. A field that is *optional at initial
submission* may still be needed before approval — see the contact rule below.

| Field | Classification | Notes |
|---|---|---|
| Business or organization name | **Required at initial submission** | Core identity of the listing. Decided: `OQ-8`. |
| Category | **Required at initial submission** | Needed for category filtering; from a predefined set. Decided: `OQ-8`. |
| Description | **Required at initial submission** | Short text describing the listing. Decided: `OQ-8`. |
| Locality | **Required at initial submission** | The town, city, village, municipality, or comparable named place. User-facing label: "City, town, or locality." Supports location filtering. Decided: `OQ-6`, `OQ-8`. |
| Country | **Required at initial submission** | Every listing carries a country; the directory is multi-country capable from launch. Decided: `OQ-6`, `OQ-8`. |
| Administrative area | **Optional at initial submission** | State, province, region, county, district, parish, or comparable subdivision. User-facing label: "State, province, region, or district." Not required where no such subdivision meaningfully applies. **Not a contact method.** Decided: `OQ-6`, `OQ-8`. |
| Postal code | **Optional at initial submission** | Text, international formats; may be omitted by any listing. User-facing label: "Postal code or ZIP code." **Not a contact method.** Decided: `OQ-6`, `OQ-8`. |
| Precise or residential street address | **Not collected** | Deliberately excluded from the initial MVP. Decided: `OQ-6`. |
| Phone | **Optional at initial submission** | Contact method. Counts toward the before-approval contact minimum. Decided: `OQ-8`, `OQ-8b`. |
| Email | **Optional at initial submission** | Contact method. Counts toward the before-approval contact minimum. Decided: `OQ-8`, `OQ-8b`. |
| Website | **Optional at initial submission** | Contact method. Counts toward the before-approval contact minimum. Decided: `OQ-8`, `OQ-8b`. |
| Status | **Administrative** | e.g. pending / approved / rejected; not set by the public. |
| Submission date | **Administrative** | Recorded by the system on submission. |
| Last updated date | **Administrative** | Recorded by the system on change. |

**Location fields (decided — `OQ-6`).** The MVP collects **no precise business street
address and no residential street address**. For a home-based business the location
information is limited to locality, country, the administrative area where provided, and a
postal code only where voluntarily provided. Postal code is treated as text — letters,
digits, spaces, and hyphens — with **no universal United States five-digit rule**, and is
never used to infer or expose a residential street address. Which of these stored fields
appear publicly is a **separate** decision (`OQ-7`), now also decided — see *What the
public sees* below. No storage mechanism, normalisation approach, country list, or
technology is chosen by this decision.

**What the public sees (decided — `OQ-7`).** The public directory shows only what a
visitor needs in order to **identify the business, understand what it offers, understand
its general location, and contact it through an intentionally public business contact
method**. The public read path does **not** show every stored field; it serves an explicit
**public projection**:

| Category | Fields |
|---|---|
| **Public** | Business name, category, description, locality, country, administrative area where provided; postal code only where provided and designated for public display; each contact method (phone, email, website) the business designated public, that was supplied as a business contact and passed moderation. |
| **Administrator-visible** | Record status, **current publication state** and the **current unpublish reason** required by `OQ-11`, submission/update/review timestamps, reviewer identity, moderation notes, rejection reasons, approval and unpublishing history, and any submitter information another approved requirement authorises collecting. *(`OQ-11` requires a current reason as current administrative state; whether durable historical event records exist remains `OQ-14`/`NOQ-8`.)* |
| **Audit-only** | Audit entries and security-event records — never public. |
| **Not collected during the MVP** | Precise business and residential street addresses (`OQ-6`). |

A person's name appears publicly **only** where it is intentionally part of the approved
business name or description; no separate public owner-name field is created. For a
home-based business the public location remains locality, country, administrative area
where provided, and postal code only where voluntarily provided and approved for public
display. Full classification: `docs/08-data-model.md` *Field classification*. No storage
mechanism or visibility-flag design is chosen by this decision.

**Submission obligations (decided — `OQ-8`).** Three distinct gates, and the documentation
keeps them distinct:

- **Required at initial submission** — business name, category, description, locality,
  country.
- **Optional at initial submission** — administrative area, postal code, phone, email,
  website. A submission may omit all five and still be accepted into moderation.
- **Required when supplied** — any optional value that *is* provided must pass the
  applicable format and safety checks. A supplied-but-invalid value **fails visibly, is
  preserved for correction, and is never silently dropped**; the submission cannot proceed
  through that validation step as though the value had not been supplied.
- **Required before approval** — everything above, plus the contact minimum below.

Validation is **permissive, international-friendly, and technology-neutral**. It rejects
values that are blank where required, malformed beyond practical use, unsafe, outside
established length or content boundaries, or incompatible with the field's basic purpose —
and it prescribes **no** regular expression, validation library, form control, schema type,
database constraint, country-specific phone format, URL parser, or email-validation
algorithm. This decision sets **obligation and validation only: it adds, removes, renames,
and combines no field, and leaves the `OQ-7` public projection untouched.**

**Administrator completion (decided — `OQ-8`).** During moderation and before approval an
administrator may complete missing optional information and correct submitted information.
**This is completion, not a bypass** — everything the administrator supplies or corrects is
validated by the same rules as a public submission, and **all information must satisfy the
applicable validation rules before approval.**

**Contact rule (decided — `OQ-8b`):** a listing must carry **at least one usable** contact
method — **phone, email, or website** — **before it may be approved**. The minimum applies
**before approval, not at initial submission**: a public submission may therefore enter
moderation with no phone, email, or website, but it cannot be approved until at least one
usable contact method exists (the administrator may supply one under the completion rule
above). A contact value is **usable** when it is non-blank, passes the applicable permissive
format and safety checks, and is retained as the value proposed for the listing. **Usable
means structurally usable — not verified as owned, reachable, or currently active**; the MVP
introduces no confirmation email, SMS verification, phone call, ownership proof, domain
verification, or third-party validation service. **Locality, administrative area, postal
code, country, and any physical-location or address information are not contact methods**
and never satisfy this minimum. **A business with no usable phone, email, or website cannot
be approved under the MVP policy; there is no offline-business exemption.**

**Note on need vs. feature:** these fields describe the *information* a listing
holds. They do **not** imply a particular storage technology or schema — that is
architecture work, deliberately excluded here.

## MVP assumptions

- The primary value is served by the moderated public directory loop; accounts
  and self-service are not needed for a first useful release.
- Submission volume will be low enough that **manual administrative review** is
  practical (consistent with `01-vision.md`).
- A small, predefined set of categories is sufficient for launch.
- Simple location fields (locality, country, and optionally administrative area) support
  useful filtering; the directory is multi-country capable from launch and no listing is
  silently defaulted to a single country.
- A small number of trusted administrators operate the platform.

## MVP constraints

- **Content must be approved before it is public** (moderation-first).
- **Only administrators** may approve, edit, or remove listings.
- The product must be **responsive** and meet **basic accessibility** for core
  flows.
- The MVP must be **small enough to build and operate** as an initial release.
- **No architecture decisions** are made in this document: no frameworks,
  databases, hosting, or implementation patterns are selected here.

## MVP success criteria

Qualitative for the MVP; concrete targets are deferred (consistent with the
vision, which leaves metrics "to be defined later"):

- Visitors can find a relevant approved listing through browse, search, or
  filter, and view its details.
- A member of the public can submit a listing request that is captured as
  pending and is not publicly visible until approved.
- Administrators can review the pending queue and approve, reject, or edit
  submissions.
- No public actor can publish or alter listings without administrator action.
- Core flows are usable on phone and desktop and meet basic accessibility.

**Open question:** which quantitative targets (e.g. number of approved listings,
review turnaround time) define "success" for the first release.

## Risks and open questions

1. ~~**Location granularity**~~ — **Decided (`OQ-6`)**: locality and country required,
   administrative area and postal code optional, street address not collected. See *Data
   required for a listing* above.
2. ~~**Multi-country scope**~~ — **Decided (`OQ-6`)**: the MVP is multi-country capable from
   launch; country is required on every listing.
3. ~~**Contact-method minimum**~~ — **Decided (`OQ-8b`)**: the MVP **enforces** at least
   one **usable** contact method (phone, email, or website) **before approval** — not at
   initial submission. A submission with no contact method still enters moderation; it
   simply cannot be approved until one exists. Location and address information never
   count. **No offline-business exemption.** Recorded alongside the `OQ-8` submission
   obligations in *Data required for a listing* above; see `docs/05` `FR-DATA-08`,
   `FR-VAL-05` and `docs/13`.
4. **Category source** — Who defines the predefined category list, and can
   administrators manage it in the MVP or is it fixed?
5. ~~**Removing/unpublishing approved listings**~~ — **Decided 2026-08-04 (Joe S.
   — `OQ-11`).** An authorized administrator **may unpublish** an approved
   listing and **may republish** it. Unpublishing is **reversible**, requires a
   **recorded current reason** and an **explicit confirmation**, and removes the
   listing from **every** public read path — keyword search, category results,
   location results, public listing collections, and direct public retrieval. A
   previously shared public link receives the **same generic listing-unavailable
   result** given for a listing that never existed, one awaiting review, and one
   rejected. The listing stays **administratively visible**. A **pending revision
   remains pending** when the listing is unpublished, and approving that revision
   updates the current approved version **without republishing**; a later explicit
   republish exposes the **current** approved version. **Permanent deletion is
   excluded from the MVP**, and **ordinary public-user removal requests are
   outside MVP scope**. **`FR-AUD-01` is unchanged** — publication state is a
   **separate product concept** from listing status, and **no fourth listing
   status is introduced**. How this is represented remains deferred (`ADR-006`,
   `DDM-9`); retention and purge remain `OQ-13`.
6. **Retention of rejected submissions** — Are rejections kept for audit or
   discarded?
7. **Administrator access** — The MVP requires that only administrators can
   moderate, but *how* administrators are authenticated is an architecture
   decision deferred to later work; the requirement here is functional only.
8. **Duplicate submissions** — How are duplicate or near-duplicate listing
   requests handled during review?
9. **Success metrics** — Quantitative targets are not yet defined (see above).
10. ~~**Edit review**~~ — **Decided (`OQ-10`)**: secondary review. A proposed change
    to an already-approved listing is recorded as a **pending revision** that is never
    publicly visible; the approved listing stays publicly visible at its last approved
    version while the revision is reviewed; approval makes the revision's information
    the effective public version; rejection leaves the approved listing unchanged. A
    listing has at most one pending revision at a time. An authorized administrator may
    create and approve a revision within one atomic authorized operation, provided every
    validation, authorization, and publication safeguard succeeds. See `docs/05`
    `FR-ADM-10`, `FR-ADM-10b` and `docs/13`.

## Future capabilities

Documented for continuity, **not** committed. These are the out-of-scope items
plus adjacent ideas from the vision's *Future direction*:

- Business-owner accounts and self-service listing claiming.
- Reviews and ratings.
- Listing analytics for owners.
- Paid advertising or sponsored placement (with fair, transparent rules).
- Community event management.
- Transactions, bookings, or payments.
- Social-network features.
- Native mobile applications.
- Advanced integrations and richer categorization or geographic browsing.

Any of these becomes a commitment only through later scope, requirements, and
planning work — never automatically, and never merely because the prototype
demonstrated something related.
