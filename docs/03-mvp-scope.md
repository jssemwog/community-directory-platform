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
  approve, edit, or remove listings; the public can only submit requests.
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

**Open question:** whether administrators can **unpublish or remove** an approved
listing in the MVP, and whether rejected submissions are retained or discarded.
Recorded below.

## Content and moderation boundaries

- **Nothing is public until an administrator approves it.** This upholds the
  vision principle "trust over volume."
- **The public can only *request* listings**, never publish, edit, or delete
  them directly.
- **Administrators are the sole moderators** of what appears publicly.
- The MVP moderates listing records only; it does not host user-generated
  content such as reviews, comments, or events.

## Data required for a listing

A **minimal** listing record is proposed below. Fields are classified as
**required**, **optional**, **administrative** (system/admin-managed, not entered
by the public), or **undecided**. Not every candidate field is automatically
included.

| Field | Classification | Notes |
|---|---|---|
| Business or organization name | **Required** | Core identity of the listing. |
| Category | **Required** | Needed for category filtering; from a predefined set. |
| Description | **Required** | Short text describing the listing. |
| City | **Required** | Supports location filtering at city level. |
| State or region | **Optional** | Useful where cities are ambiguous. |
| Country | **Undecided** | Only needed if the directory spans countries; see open questions. |
| Phone | **Optional** | At least one contact method is expected (see below). |
| Email | **Optional** | Contact method. |
| Website | **Optional** | Contact method. |
| Status | **Administrative** | e.g. pending / approved / rejected; not set by the public. |
| Submission date | **Administrative** | Recorded by the system on submission. |
| Last updated date | **Administrative** | Recorded by the system on change. |

**Contact rule (open question):** the intent is that a listing carry **at least
one** contact method (phone, email, or website), but whether that minimum is
enforced in the MVP is undecided.

**Note on need vs. feature:** these fields describe the *information* a listing
holds. They do **not** imply a particular storage technology or schema — that is
architecture work, deliberately excluded here.

## MVP assumptions

- The primary value is served by the moderated public directory loop; accounts
  and self-service are not needed for a first useful release.
- Submission volume will be low enough that **manual administrative review** is
  practical (consistent with `01-vision.md`).
- A small, predefined set of categories is sufficient for launch.
- The initial geographic scope is limited enough that simple location fields
  (e.g. city) support useful filtering.
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

1. **Location granularity** — Is filtering by **city** enough for the MVP, or are
   state/region (and possibly country) needed? Affects required vs. optional
   location fields.
2. **Multi-country scope** — Is the launch single-country (making `Country`
   unnecessary) or broader?
3. **Contact-method minimum** — Should the MVP *enforce* at least one contact
   method per listing, or leave all contact fields optional?
4. **Category source** — Who defines the predefined category list, and can
   administrators manage it in the MVP or is it fixed?
5. **Removing/unpublishing approved listings** — Is administrator removal or
   unpublishing in scope for the MVP, or only approve/reject/edit?
6. **Retention of rejected submissions** — Are rejections kept for audit or
   discarded?
7. **Administrator access** — The MVP requires that only administrators can
   moderate, but *how* administrators are authenticated is an architecture
   decision deferred to later work; the requirement here is functional only.
8. **Duplicate submissions** — How are duplicate or near-duplicate listing
   requests handled during review?
9. **Success metrics** — Quantitative targets are not yet defined (see above).
10. **Edit review** — When an administrator edits an already-approved listing,
    is any secondary review needed, or does the edit publish immediately?

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
