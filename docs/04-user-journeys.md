# Community Directory Platform — MVP User Journeys

## Purpose

This document describes the **end-to-end user journeys** supported by the
approved MVP of the Community Directory Platform. Each journey explains *how* a
primary user accomplishes a goal — their intent, steps, decisions, outcomes, and
failure paths — in **technology-neutral** terms.

It builds on and is consistent with:

- [`docs/01-vision.md`](./01-vision.md) — product vision.
- [`docs/02-stakeholders.md`](./02-stakeholders.md) — stakeholders and needs.
- [`docs/03-mvp-scope.md`](./03-mvp-scope.md) — approved MVP scope.

**What this document is not.** It does not select frameworks, databases, APIs,
hosting, or implementation patterns. It does not define detailed functional
requirements — journeys describe *experience and intent*, and will later be used
to **derive** requirements, acceptance criteria, and backlog items. It stays
within the approved MVP scope and introduces no out-of-scope capability (no
owner accounts, listing claiming, reviews, ratings, analytics, payments,
advertising, events, or social features). The **Community Directory Mini Lab**
is treated only as a learning reference.

## Journey conventions

Each journey below uses this structure:

- **Primary actor** — the person pursuing the goal.
- **Goal** — what they want to accomplish.
- **Preconditions** — what must be true before the journey starts.
- **Trigger** — what starts the journey.
- **Main success path** — the expected sequence when things go well.
- **Alternate paths** — valid variations that still reach the goal.
- **Failure or exception paths** — what happens when something goes wrong.
- **Postcondition** — the resulting state after the journey.
- **Related MVP capabilities** — in-scope capabilities from
  [`docs/03-mvp-scope.md`](./03-mvp-scope.md) that the journey exercises.
- **Open questions** — unresolved product decisions (never settled here).

**Actors** (from the MVP scope):

- **Visitor** — anyone browsing the public directory; no account.
- **Lister** — any member of the public using the public listing-request form;
  no account.
- **Administrator** — an authenticated operator who moderates content. *How*
  administrators authenticate is deferred to architecture; journeys assume only
  that the administrator is authorized.

---

## Visitor journeys

### V1. Browse approved listings

- **Primary actor:** Visitor
- **Goal:** See what listings exist in the directory.
- **Preconditions:** The directory is reachable; zero or more approved listings
  exist.
- **Trigger:** The visitor opens the directory.
- **Main success path:**
  1. The visitor opens the directory.
  2. The system shows a list of **approved** listings.
  3. The visitor scans the listings.
- **Alternate paths:**
  - Many listings exist → the visitor pages through or continues scrolling
    (presentation mechanism deferred).
  - The visitor narrows results using search or filters (see V2–V4).
- **Failure or exception paths:**
  - No approved listings exist yet → an **empty state** explains the directory
    has no listings yet (distinct from a no-results state, V6).
  - The directory is temporarily unavailable → a clear error is shown.
- **Postcondition:** The visitor has seen the set of approved listings.
- **Related MVP capabilities:** Public browsing of approved listings; responsive
  design; basic accessibility.
- **Open questions:** Default ordering of listings (e.g. alphabetical, newest,
  random).

### V2. Search listings by keyword

- **Primary actor:** Visitor
- **Goal:** Find listings matching a word or phrase.
- **Preconditions:** The directory is reachable.
- **Trigger:** The visitor enters a keyword.
- **Main success path:**
  1. The visitor types a keyword.
  2. The system returns approved listings matching the keyword.
  3. The visitor reviews the matches.
- **Alternate paths:**
  - The visitor refines the keyword and searches again.
  - The visitor combines the keyword with a category or location filter
    (V3, V4).
- **Failure or exception paths:**
  - No listing matches → the **no-results** journey (V6).
  - The keyword is empty/whitespace → the system treats it as browsing (V1) or
    prompts for input.
- **Postcondition:** The visitor sees keyword-matched results or a no-results
  state.
- **Related MVP capabilities:** Keyword search; public browsing; responsive
  design; basic accessibility.
- **Open questions:** Which listing fields are searched (name, description,
  category, location); whether matching is exact, partial, or fuzzy.

### V3. Filter listings by category

- **Primary actor:** Visitor
- **Goal:** Narrow listings to a single category.
- **Preconditions:** A predefined set of categories exists.
- **Trigger:** The visitor selects a category.
- **Main success path:**
  1. The visitor chooses a category from the available set.
  2. The system shows approved listings in that category.
- **Alternate paths:**
  - The visitor combines the category with a keyword (V2) or location (V4).
  - The visitor clears the category to return to all listings (V1).
- **Failure or exception paths:**
  - No listing in the chosen category → no-results state (V6).
- **Postcondition:** The visitor sees listings limited to the chosen category.
- **Related MVP capabilities:** Basic category filtering; public browsing;
  responsive design; basic accessibility.
- **Open questions:** Whether multiple categories can be selected at once (the
  MVP describes "a single predefined category"); who curates the category list
  (MVP open question).

### V4. Filter listings by location

- **Primary actor:** Visitor
- **Goal:** Narrow listings to a location.
- **Preconditions:** Listings carry a location value (e.g. city).
- **Trigger:** The visitor selects or enters a location.
- **Main success path:**
  1. The visitor specifies a location value.
  2. The system shows approved listings for that location.
- **Alternate paths:**
  - The visitor combines location with keyword (V2) or category (V3).
  - The visitor clears the location filter (V1).
- **Failure or exception paths:**
  - No listing in that location → no-results state (V6).
- **Postcondition:** The visitor sees listings limited to the chosen location.
- **Related MVP capabilities:** Basic location filtering; public browsing;
  responsive design; basic accessibility.
- **Open questions:** Location granularity — city only, or also state/region and
  country (MVP open questions #1–2). This directly shapes the filter.

### V5. View listing details

- **Primary actor:** Visitor
- **Goal:** See the full information for one listing.
- **Preconditions:** At least one approved listing exists.
- **Trigger:** The visitor selects a listing from a list or result set.
- **Main success path:**
  1. The visitor selects a listing.
  2. The system shows that listing's full details (e.g. name, category,
     description, location, available contact methods).
- **Alternate paths:**
  - The visitor returns to the previous list/results and selects another
    listing.
- **Failure or exception paths:**
  - The listing is no longer approved/available (e.g. removed between listing
    and selection) → a clear "listing not available" message; the visitor
    returns to browsing.
- **Postcondition:** The visitor has read the full details of a listing.
- **Related MVP capabilities:** Listing details; public browsing; responsive
  design; basic accessibility.
- **Open questions:** Which fields are shown publicly vs. withheld (privacy —
  e.g. whether a submitter's contact details are ever public).

### V6. Handle a search with no results

- **Primary actor:** Visitor
- **Goal:** Understand that nothing matched and know what to do next.
- **Preconditions:** The visitor has run a search or filter.
- **Trigger:** A search/filter returns zero matches.
- **Main success path:**
  1. The system detects no matching approved listings.
  2. The system shows a clear **no-results** message.
  3. The system offers a way forward (e.g. adjust or clear the search/filter).
- **Alternate paths:**
  - The visitor broadens or clears criteria and retries (V2–V4), or returns to
    browsing all listings (V1).
- **Failure or exception paths:**
  - No-results is confused with an error or empty directory → messaging must
    distinguish "no matches for your search" from "no listings exist yet" and
    from "something went wrong."
- **Postcondition:** The visitor understands the outcome and has a next step.
- **Related MVP capabilities:** Keyword search; category/location filtering;
  basic accessibility.
- **Open questions:** Whether to suggest alternatives (e.g. nearby locations) —
  candidate for later, not assumed in MVP.

### V7. Encounter inaccurate or outdated information

- **Primary actor:** Visitor
- **Goal:** Recognize that a listing looks wrong or stale.
- **Preconditions:** The visitor is viewing a listing (V5).
- **Trigger:** The visitor notices information that appears inaccurate or
  outdated.
- **Main success path:**
  1. The visitor observes questionable information.
  2. The visitor forms a judgment about the listing's trustworthiness.
- **Alternate paths:**
  - The visitor cross-checks other listings or leaves the directory.
- **Failure or exception paths:**
  - The visitor has **no way to signal** the problem in the MVP → trust erodes
    silently. Whether the MVP provides any feedback channel is an open question
    (see below); no such feature is assumed here.
- **Postcondition:** The visitor has judged the listing; any correction happens
  later through administrator review (A6/A7), not through a visitor action in the
  MVP.
- **Related MVP capabilities:** Listing details; (moderation/accuracy is served
  by administrator journeys). No new capability is introduced.
- **Open questions:** Does the MVP offer any "report a problem"/feedback path? If
  not, how do inaccuracies reach administrators? This must not silently become an
  out-of-scope feature; it is recorded as a product question, not a decision.

---

## Lister journeys

### L1. Open the listing-request form

- **Primary actor:** Lister (any member of the public)
- **Goal:** Reach the form to propose a new listing.
- **Preconditions:** The directory is reachable.
- **Trigger:** The lister chooses to add/suggest a listing.
- **Main success path:**
  1. The lister selects the option to request a listing.
  2. The system presents the listing-request form with its fields.
- **Alternate paths:**
  - The lister arrives directly at the form (e.g. via a shared link).
- **Failure or exception paths:**
  - The form is temporarily unavailable → a clear error is shown.
- **Postcondition:** The lister is viewing the empty request form.
- **Related MVP capabilities:** Public listing-request form; responsive design;
  basic accessibility.
- **Open questions:** None specific.

### L2. Submit a new listing request

- **Primary actor:** Lister
- **Goal:** Propose a listing for inclusion in the directory.
- **Preconditions:** The lister is viewing the request form (L1).
- **Trigger:** The lister completes and submits the form.
- **Main success path:**
  1. The lister enters listing information (e.g. name, category, description,
     location, contact method).
  2. The lister submits the form.
  3. The system validates the input (see L3).
  4. On success, the system records the submission as **pending** and not
     publicly visible.
  5. The system shows a pending-confirmation (L4).
- **Alternate paths:**
  - The lister submits with only required fields, omitting optional ones.
- **Failure or exception paths:**
  - Validation fails → the correct-errors journey (L3).
  - The submission cannot be saved → a clear error invites a retry; no partial
    public listing is created.
- **Postcondition:** A new **pending** submission exists, invisible to the
  public, awaiting administrator review.
- **Related MVP capabilities:** Public listing-request form; pending by default;
  protection against unauthorized public changes; responsive design; basic
  accessibility.
- **Open questions:** Which fields are required at submission (name, category,
  description, city are candidates; contact-method minimum is a MVP open
  question); whether any anti-spam step exists for an unauthenticated form.

### L3. Correct validation errors

- **Primary actor:** Lister
- **Goal:** Fix invalid or missing input so the request can be submitted.
- **Preconditions:** The lister submitted the form with invalid/missing data.
- **Trigger:** The system detects validation problems.
- **Main success path:**
  1. The system identifies the specific problems.
  2. The system shows clear, field-level messages describing what to fix.
  3. The lister corrects the input, preserving already-entered valid data.
  4. The lister resubmits (returns to L2).
- **Alternate paths:**
  - The lister abandons the submission → nothing is saved.
- **Failure or exception paths:**
  - Error messages are unclear or entered data is lost → the lister cannot
    recover easily. The MVP intent is clear messages and preserved input.
- **Postcondition:** Either a valid submission proceeds (L2/L4) or nothing is
  recorded.
- **Related MVP capabilities:** Public listing-request form; basic accessibility
  (errors must be perceivable, e.g. not by color alone).
- **Open questions:** The exact validation rules (required fields, contact
  minimum, format checks) are requirements to be derived later, not decided
  here.

### L4. Receive confirmation that the submission is pending review

- **Primary actor:** Lister
- **Goal:** Know the request was received and understand what happens next.
- **Preconditions:** A submission was successfully recorded (L2).
- **Trigger:** The submission is saved as pending.
- **Main success path:**
  1. The system shows a clear confirmation that the request was received.
  2. The confirmation states the submission is **pending review** and not yet
     public.
- **Alternate paths:**
  - None specific.
- **Failure or exception paths:**
  - The lister expects the listing to appear immediately → the confirmation must
    set the expectation that review is required first.
- **Postcondition:** The lister understands the submission is pending and
  awaiting administrator action.
- **Related MVP capabilities:** Pending by default; clear confirmation messages;
  basic accessibility.
- **Open questions:** Since there are no lister accounts, does the lister receive
  any reference or notification of the outcome (approval/rejection), or none in
  the MVP? Recorded as a product question.

---

## Administrator journeys

### A1. View pending submissions

- **Primary actor:** Administrator
- **Goal:** See submissions awaiting review.
- **Preconditions:** The administrator is authenticated/authorized; zero or more
  pending submissions exist.
- **Trigger:** The administrator opens the pending queue.
- **Main success path:**
  1. The administrator opens the review area.
  2. The system lists pending submissions.
- **Alternate paths:**
  - The administrator sorts/filters the queue (mechanism deferred).
- **Failure or exception paths:**
  - No pending submissions → an empty state indicates nothing to review.
  - Unauthorized access is attempted → access is denied (see cross-cutting).
- **Postcondition:** The administrator sees the current pending work.
- **Related MVP capabilities:** Administrator review; protection against
  unauthorized public changes.
- **Open questions:** Queue ordering (e.g. oldest first).

### A2. Review a submission

- **Primary actor:** Administrator
- **Goal:** Assess a single submission's content and quality.
- **Preconditions:** A pending submission exists (A1).
- **Trigger:** The administrator opens a submission.
- **Main success path:**
  1. The administrator opens a pending submission.
  2. The system shows its full submitted details.
  3. The administrator evaluates accuracy, completeness, and appropriateness.
  4. The administrator proceeds to edit (A3), approve (A4), or reject (A5).
- **Alternate paths:**
  - The administrator defers and returns to the queue (A1).
- **Failure or exception paths:**
  - The submission is a duplicate/incomplete/misleading/abusive → handled via A7.
- **Postcondition:** The administrator has assessed the submission and chosen a
  next action.
- **Related MVP capabilities:** Administrator review.
- **Open questions:** None beyond those in A3–A7.

### A3. Edit submitted information

- **Primary actor:** Administrator
- **Goal:** Correct or improve a submission's content.
- **Preconditions:** The administrator is reviewing a submission (A2).
- **Trigger:** The administrator chooses to edit.
- **Main success path:**
  1. The administrator modifies fields (e.g. fix a typo, standardize category).
  2. The system validates and saves the changes to the submission.
  3. The administrator may then approve (A4) or reject (A5).
- **Alternate paths:**
  - The administrator edits and leaves the submission pending for later.
- **Failure or exception paths:**
  - Edited data fails validation → the administrator must correct it (parallels
    L3).
- **Postcondition:** The submission reflects the administrator's edits; status is
  unchanged until an approve/reject action.
- **Related MVP capabilities:** Administrator editing; administrator review.
- **Open questions:** Whether edits are audit-logged (stakeholders note an
  interest in audit trails; not confirmed for MVP).

### A4. Approve a submission

- **Primary actor:** Administrator
- **Goal:** Make a submission publicly visible.
- **Preconditions:** A pending submission is reviewed (A2), optionally edited
  (A3).
- **Trigger:** The administrator approves.
- **Main success path:**
  1. The administrator approves the submission.
  2. The system sets its status to **approved**.
  3. The listing becomes publicly visible (now reachable by V1–V5).
- **Alternate paths:**
  - The administrator edits first (A3), then approves.
- **Failure or exception paths:**
  - The action cannot be saved → status remains pending; a clear error invites
    retry.
- **Postcondition:** The listing is approved and public.
- **Related MVP capabilities:** Administrator approval; pending by default;
  public browsing.
- **Open questions:** None specific.

### A5. Reject a submission

- **Primary actor:** Administrator
- **Goal:** Decline a submission so it does not become public.
- **Preconditions:** A pending submission is reviewed (A2).
- **Trigger:** The administrator rejects.
- **Main success path:**
  1. The administrator rejects the submission.
  2. The system marks it as **rejected**; it never becomes public.
- **Alternate paths:**
  - The administrator records a reason for rejection (if supported).
- **Failure or exception paths:**
  - The action cannot be saved → the submission remains pending.
- **Postcondition:** The submission is rejected and not public.
- **Related MVP capabilities:** Administrator rejection; protection against
  unauthorized public changes.
- **Open questions:** Are rejected submissions retained (for audit) or discarded
  (MVP open question #6)? Is the lister informed (see L4 open question)?

### A6. Review or update an existing listing

- **Primary actor:** Administrator
- **Goal:** Keep an already-approved listing accurate and current.
- **Preconditions:** An approved listing exists.
- **Trigger:** The administrator opens an approved listing (e.g. prompted by a
  suspected inaccuracy from V7).
- **Main success path:**
  1. The administrator opens the approved listing.
  2. The administrator edits its content to correct/update it.
  3. The system validates and saves; the public listing reflects the update.
- **Alternate paths:**
  - No change is needed → the administrator leaves the listing as-is.
- **Failure or exception paths:**
  - Edited data fails validation → the administrator corrects it.
- **Postcondition:** The approved listing is up to date.
- **Related MVP capabilities:** Administrator editing; listing details; public
  browsing.
- **Open questions:** Does an edit to an approved listing publish immediately or
  need secondary review (MVP open question #10)? Can an administrator
  **unpublish or remove** an approved listing in the MVP (MVP open question #5)?
  Both are recorded, not decided.

### A7. Handle duplicate, incomplete, misleading, or abusive content

- **Primary actor:** Administrator
- **Goal:** Keep the directory trustworthy by resolving problematic submissions
  or listings.
- **Preconditions:** The administrator is reviewing a submission (A2) or an
  existing listing (A6).
- **Trigger:** The administrator identifies content that is duplicate,
  incomplete, misleading, or abusive.
- **Main success path:**
  1. The administrator classifies the problem.
  2. The administrator applies the appropriate available action: edit to fix
     (A3/A6), reject (A5), or — for existing listings — take a corrective action
     subject to the open questions in A6.
- **Alternate paths:**
  - Incomplete but fixable → the administrator completes it via edit, then
    approves.
  - Duplicate → the administrator declines the new one in favor of the existing
    listing (resolution mechanism is an open question).
- **Failure or exception paths:**
  - Abusive content must not become public; if already public, it must be
    correctable/removable — dependent on the remove/unpublish open question.
- **Postcondition:** The problematic content is resolved to the extent MVP
  actions allow; unresolved aspects are captured as open questions.
- **Related MVP capabilities:** Administrator review, editing, rejection; content
  and moderation boundaries; protection against unauthorized public changes.
- **Open questions:** Duplicate-resolution mechanism (MVP open question #8);
  removal/unpublish of already-public content (MVP open question #5); whether
  abuse handling needs any escalation path beyond a single administrator.

---

## Cross-cutting journey considerations

These apply across all journeys above and must be reflected when journeys are
turned into requirements:

- **Accessibility** — Core flows (browse, search, filter, view, submit, correct
  errors, review) must be operable by keyboard and assistive technologies, with
  perceivable, non-color-only status and error messaging.
- **Mobile responsiveness** — All visitor and lister flows must be usable on
  phone, tablet, and desktop sizes.
- **Privacy** — Only intended fields are shown publicly. Contact details supplied
  in a submission should be exposed only as intended (open question on which
  fields are public), and administrator-only data (status, dates) is never
  presented as public content.
- **Validation** — Listing-request input is validated with clear, specific,
  recoverable messages that preserve entered data (L2/L3); administrator edits
  are validated too (A3/A6).
- **Error handling** — Unexpected failures (unavailable directory/form, failed
  save) produce clear messages and safe retries without creating partial public
  content.
- **Content moderation** — Nothing is public until an administrator approves it;
  administrators are the sole moderators; the public can only *request* listings
  (A1–A7; upholds the vision's "trust over volume").
- **Unauthorized access** — Non-administrators cannot reach administrator
  journeys or change public content; attempts are denied. (*How* authorization
  is implemented is deferred to architecture.)
- **Empty states** — "No listings yet" (V1), "no matches for your search" (V6),
  and "no pending submissions" (A1) are distinct and clearly worded.
- **Clear confirmation messages** — Successful submissions (L4) and administrator
  actions (A4/A5/A6) give unambiguous confirmation of what happened and the
  resulting state.

---

## Coverage matrix

Every **in-scope MVP capability** from
[`docs/03-mvp-scope.md`](./03-mvp-scope.md) maps to at least one journey:

| In-scope MVP capability | Journeys |
|---|---|
| Public browsing of approved listings | V1, V5 |
| Keyword search | V2, V6 |
| Basic category filtering | V3, V6 |
| Basic location filtering | V4, V6 |
| Listing details | V5, A6 |
| Public listing-request form | L1, L2, L3 |
| Pending by default | L2, L4, A1, A4 |
| Administrator review | A1, A2, A7 |
| Administrator approval | A4 |
| Administrator rejection | A5, A7 |
| Administrator editing | A3, A6, A7 |
| Protection against unauthorized public changes | L2, A1, A5, A7, cross-cutting (unauthorized access) |
| Responsive design | Cross-cutting (mobile responsiveness); all V/L journeys |
| Basic accessibility | Cross-cutting (accessibility); all journeys |

No out-of-scope capability appears in any journey.

## Open questions

Unresolved **product** questions (recorded, not decided; no implementation
choices implied):

1. **Feedback on inaccuracies (V7).** Does the MVP provide any "report a
   problem" path for visitors, or do inaccuracies reach administrators by other
   means? Must not silently become an out-of-scope feature.
2. **Lister follow-up (L4/A5).** With no lister accounts, does a lister receive
   any reference or notification of approval/rejection, or nothing in the MVP?
3. **Default listing order (V1).** Alphabetical, newest, or otherwise.
4. **Search scope and matching (V2).** Which fields are searched; exact vs.
   partial vs. fuzzy matching.
5. **Category selection (V3).** Single vs. multiple categories; who curates the
   category set (MVP open question #4).
6. **Location granularity (V4).** City only, or city/region/country (MVP open
   questions #1–2).
7. **Public vs. private fields (V5, privacy).** Which listing/contact fields are
   ever shown publicly.
8. **Required submission fields and contact minimum (L2/L3).** Exact required set
   and whether at least one contact method is enforced (MVP open question #3).
9. **Anti-spam for the public form (L2).** Whether any safeguard exists for an
   unauthenticated submission form.
10. **Edit-after-approval (A6).** Immediate publish vs. secondary review (MVP
    open question #10).
11. **Remove/unpublish approved listings (A6/A7).** Whether administrators can
    remove or unpublish public listings in the MVP (MVP open question #5).
12. **Duplicate resolution (A7).** How duplicates are resolved during review (MVP
    open question #8).
13. **Rejected-submission retention (A5).** Kept for audit or discarded (MVP open
    question #6).
14. **Audit logging (A3).** Whether administrator edits/actions are logged
    (stakeholder interest; not confirmed for MVP).
15. **Abuse escalation (A7).** Whether abuse handling needs any path beyond a
    single administrator.

These are product decisions for later scope and requirements work. They are
listed here so journeys can be turned into requirements, acceptance criteria, and
backlog items without treating any open question as already settled.
