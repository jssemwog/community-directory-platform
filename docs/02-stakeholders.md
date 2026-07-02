# Community Directory Platform — Stakeholders

This document identifies the people and groups affected by the Community
Directory Platform and describes what each of them needs from the system. It is
written to be understandable to someone new to the project.

The Community Directory Platform is a web application that lists local
businesses, organizations, and community resources so that community members can
discover them, and so that listed parties can be found.

## How to read this document

- **Primary stakeholders** interact with the platform directly and are essential
  to its core purpose. Their needs shape the main features.
- **Secondary stakeholders** are affected by or support the platform but are not
  part of its everyday core loop. Their needs shape governance, funding, and
  operations.

---

## Primary stakeholders

### Visitors
People who come to the platform to find businesses, organizations, or resources.

**Interests and needs**
- Fast, accurate search and browsing by category, location, and keyword.
- Trustworthy, up-to-date listing details (hours, contact info, location).
- A simple experience that works without an account.
- Accessible design that works on mobile and assistive technologies.

### Business owners and listers
People who create and maintain a listing for their business or organization.

**Interests and needs**
- An easy way to create and update a listing.
- Confidence that their information is displayed accurately and prominently.
- Visibility to relevant visitors (good ranking and categorization).

> Note: dedicated business-owner accounts, claiming a listing, and listing
> analytics are potential future needs rather than current MVP commitments.

### Administrators
The people who operate the platform day to day and keep content trustworthy.

**Interests and needs**
- Tools to review, approve, edit, and remove listings.
- Moderation controls to handle spam, duplicates, and abuse.
- User and role management.
- Clear audit trails of changes.

---

## Secondary stakeholders

### Community leaders
Local officials, neighborhood associations, and organizers who care about the
health and representation of the community the directory serves.

**Interests and needs**
- Accurate, inclusive representation of local businesses and resources.
- Ability to highlight community programs (community events are not currently
  part of the MVP).
- Assurance the platform serves the public interest, not just paying listers.

### Sponsors or advertisers
Organizations that provide funding or pay for promotion on the platform.

**Interests and needs**
- Clear, fairly priced promotional placements.
- Measurable exposure and return on their spending.
- Association with a reputable, well-run platform.

### Support and technical maintainers
Engineers and support staff who keep the platform running and help users.

**Interests and needs**
- A maintainable, well-documented, observable codebase.
- Reliable infrastructure, monitoring, and backups.
- Efficient tools to diagnose issues and answer user questions.
- Manageable, sustainable operational workload.

---

## Potential conflicts between stakeholder needs

Different stakeholders can want incompatible things. Noting these early helps the
team make deliberate trade-offs.

- **Advertisers vs. visitors.** Sponsors want prominent promotion; visitors want
  neutral, trustworthy results. Too much paid placement erodes visitor trust.
- **Business owners vs. administrators.** Listers want maximum visibility and
  self-service control; administrators need moderation and accuracy standards
  that can slow or reject changes.
- **Community leaders vs. sponsors.** Community representation goals (inclusive,
  public-interest coverage) can conflict with revenue goals that favor paying
  listers.
- **Visitors vs. business owners.** Visitors want strict, verified information;
  owners want fast, low-friction publishing.
- **Maintainers vs. everyone.** Feature demands from all groups compete with the
  maintainers' need for a sustainable, stable, well-tested system.

## Summary

| Stakeholder | Type | Core need |
| --- | --- | --- |
| Visitors | Primary | Find accurate listings quickly and easily |
| Business owners and listers | Primary | Create and maintain a visible, accurate listing |
| Administrators | Primary | Keep content trustworthy and manage the platform |
| Community leaders | Secondary | Fair, inclusive community representation |
| Sponsors or advertisers | Secondary | Fair, measurable promotional value |
| Support and technical maintainers | Secondary | A reliable, maintainable, sustainable system |
