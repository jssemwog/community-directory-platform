# Community Directory Platform — Product Vision

This document explains why the Community Directory Platform is being built, who
it serves, the problem it addresses, and what success looks like. It is written
to be understandable to someone new to the project and to give later scope,
requirements, architecture, and planning work a stable foundation.

It is consistent with the stakeholder analysis in
[`docs/02-stakeholders.md`](./02-stakeholders.md).

## How to read this document

To avoid over-committing this early, statements are labeled by confidence:

- **Approved direction** — agreed intent that guides the product.
- **MVP scope (to be defined later)** — likely candidates for the first release,
  not yet finalized.
- **Future possibility** — ideas worth remembering but explicitly *not* promised.

---

## Product vision statement

To help people easily discover the local businesses, organizations, and
resources in their community, and to give those listed a trustworthy, accessible
place to be found.

*(Approved direction.)*

## Problem statement

Local businesses and community resources are hard to find in one reliable place.
Information is scattered across search engines, social media, and word of mouth,
and it is often outdated or incomplete. Community members waste time and miss
local options, while smaller organizations struggle to be discovered. There is
no single, trustworthy, community-oriented directory that is easy to browse and
maintain.

*(Approved direction.)*

## Target users

Drawn directly from [`docs/02-stakeholders.md`](./02-stakeholders.md). The
primary users the product is designed around:

- **Visitors** — people looking for local businesses, organizations, or
  resources. They need fast, accurate search and trustworthy details, ideally
  without needing an account.
- **Business owners and listers** — people who want their business or
  organization listed accurately and found by relevant visitors.
- **Administrators** — the people who keep listings accurate and trustworthy
  through review and moderation.

Secondary stakeholders (community leaders, sponsors/advertisers, and
support/technical maintainers) are described in the stakeholders document and are
considered but not the primary design focus of the initial product.

*(Approved direction.)*

## Proposed solution

A web application that presents a searchable directory of community listings.
At a high level:

- Visitors can search and browse approved listings without an account.
- People can submit a listing request, which is not published until it is
  reviewed.
- Administrators review submissions and moderate content so that what visitors
  see is trustworthy.

The exact feature set of the first release is **MVP scope to be defined later**.
This document intentionally avoids committing to specific features (such as
business-owner accounts, listing claiming, analytics, paid promotion, or
community events) that have not yet been approved. Where the stakeholders
document raises such needs, they are treated as future possibilities here.

*(Approved direction for the shape; specific features are MVP scope to be
defined later.)*

## Value proposition

- **For visitors:** one trustworthy, easy-to-use place to discover local
  options, without sign-up friction.
- **For business owners and listers:** a simple path to being discovered by the
  people already looking.
- **For the community:** an inclusive, public-interest view of local resources
  rather than a pay-to-appear listing.

*(Approved direction.)*

## Product principles

These principles guide trade-offs when stakeholder needs conflict (see the
conflicts section of [`docs/02-stakeholders.md`](./02-stakeholders.md)):

- **Trust over volume.** Accuracy and moderation come before raw listing counts.
- **Visitor experience first.** Neutral, useful results are protected from being
  crowded out by promotion.
- **Low friction.** Core discovery works without an account.
- **Accessibility and inclusivity.** Works on mobile and with assistive
  technologies; represents the community fairly.
- **Sustainable and maintainable.** Favor a system the maintainers can operate
  reliably over time.

*(Approved direction.)*

## Goals

- Provide a public, searchable directory of approved community listings.
- Allow the public to submit listing requests for review.
- Give administrators the tools to review and moderate content.
- Keep displayed information trustworthy and reasonably current.
- Be understandable and usable by people unfamiliar with the platform.

*(Approved direction. The concrete first-release subset is MVP scope to be
defined later.)*

## Non-goals

The following are explicitly **not** goals at this stage:

- Becoming a social network, review site, or transaction/booking platform.
- Committing to business-owner accounts, self-service listing claiming, or
  listing analytics (future possibilities).
- Offering paid promotion or advertising placement (future possibility).
- Hosting community events (out of scope; noted as not part of the MVP in the
  stakeholders document).
- Treating the mini lab prototype as the production architecture (see below).

*(Approved direction.)*

## Success indicators

Concrete targets will be set later; the intended indicators of success are:

- Visitors can find relevant listings quickly and report the results as
  trustworthy.
- A healthy, growing set of accurate approved listings.
- Listing requests are reviewed within a reasonable, consistent time.
- Low rates of stale, duplicate, or abusive content.
- Administrators and maintainers can operate the platform without excessive
  effort.

*(Approved direction for the indicators; specific metric targets are to be
defined later.)*

## Assumptions and constraints

**Assumptions**

- There is a real community need for a single trustworthy local directory.
- Enough listings can be gathered and kept current to be useful.
- Manual administrative review is acceptable at the expected initial volume.

**Constraints**

- Content must be moderated before public display to preserve trust.
- The platform should remain accessible and mobile-friendly.
- Scope, requirements, and architecture for the production platform are still to
  be defined; this document should not pre-commit them.

*(Approved direction.)*

## Relationship to the prototype mini lab

The **Community Directory Mini Lab** is a separate prototype project. It was
built as a small learning application to prove the basic concept and to support
returning to software development after a break. Its characteristics include:

- Next.js 14 (App Router), TypeScript, and Tailwind CSS.
- A Supabase-hosted database accessed directly via `supabase-js`, protected by
  Row Level Security.
- One main page and one `business_listings` table.
- Keyword search over approved listings, displayed publicly.
- A listing request form that inserts records with a `pending` status.
- Manual approval through Supabase.
- GitHub for source control and Vercel for deployment.

The mini lab is now **frozen as a prototype and teaching artifact**. It is
**not** the production Community Directory Platform and must **not** dictate the
final architecture or full product scope. It is valuable as proof that the core
concept — public search of approved listings plus a moderated submission flow —
works, and as a reference for lessons learned. Decisions about the production
technology stack, data model, and architecture are deferred to later
architecture work.

*(Approved direction: the mini lab informs but does not constrain the production
platform.)*

## Future direction

Ideas worth remembering but explicitly **not** committed:

- Business-owner accounts and self-service listing claiming.
- Listing analytics for owners.
- Sponsorship or advertising placements with fair, transparent rules.
- Community programs or events.
- Richer categorization, geographic browsing, and integrations.

These are **future possibilities**. They will only become commitments through
later scope, requirements, and planning work.

*(Future possibility.)*
