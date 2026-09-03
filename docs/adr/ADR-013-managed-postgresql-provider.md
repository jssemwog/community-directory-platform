# `ADR-013` — Adopt DigitalOcean Managed PostgreSQL as the named managed PostgreSQL provider for the MVP, and defer every provisioning, sizing and implementation decision

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Date** | 2026-09-03 |
| **Decision owner** | Joe S. — product owner |
| **Decision gate** | `DG-2` — technology. **Resolved** 2026-08-27 (issue #93). This ADR takes the **named-provider** decision `ADR-003` deferred; it opens no gate and authorizes no implementation |
| **Related open questions** | **Depends on** (all Decided): ~~`NOQ-2`~~ 2026-07-30 · ~~`NOQ-3`~~ 2026-07-30, amended by ruling **R1** 2026-08-18. **Carried as shaping inputs, not blockers:** `NOQ-1`, `NOQ-4` (`PA-1`). **Must NOT answer:** `DDM-2`–`DDM-10`, `OQ-4`, `OQ-9`, `OQ-14` / `NOQ-8`, `NOQ-9` (`ADR-004`, `DG-3`), `NOQ-5`, `NOQ-6`, `NOQ-7` — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **Accepted, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is *"Decided and **in force**. Work may rely on it."* The product owner accepted this decision on **2026-09-03**, following the `Proposed`-stage publication recorded on issue #101 and merged by **PR #102** on 2026-09-01, and the separate governed acceptance step recorded on **issue #103** — the `ADR-005` `Proposed` → `Accepted` precedent (issue #89 / PR #90, then issue #91 / PR #92). **`DDM-1` is discharged by this ADR only as to the named managed service and vendor**; `DDM-2`–`DDM-10` are untouched. Acceptance **provisions nothing**: no database exists, no account exists, no region, tier, sizing or PostgreSQL version is selected, and **no implementation is authorized** by this document. **`ADR-010` is not discharged** — its independent off-provider copy, its restore rehearsals and its provider-capability validation all remain **outstanding**.

---

## Context

**`ADR-003` fixed the engine and the posture, and deliberately deferred the provider.** Accepted 2026-08-23 (issue #81), it selected **PostgreSQL under a managed operating posture** and recorded that *"the named provider is deliberately deferred. No vendor or service is selected here, and none may be inferred from this document. That decision requires a separate, explicit product-owner ruling."* **`DDM-1`** has carried that outstanding half ever since, together with **`ADR-010`'s provider-capability validation**.

**`ADR-005` fixed the application host and conferred no preference on the datastore.** Accepted 2026-08-27 (issue #91), it selected **Render** with a long-running Node.js web service, and stated that **Render PostgreSQL is not selected** — *"a co-located database offering confers no standing on that separate decision"* — naming selection of the datastore provider by co-location rather than by decision as an explicit risk.

**`ADR-010` supplies the capability filter.** Accepted 2026-08-19 (issue #69), it fixed a **single-instance** availability posture against `NFR-REL-02`'s **99% over a rolling monthly window**, and a recovery posture of **at least daily backups** (`NFR-BACK-01`), a recovery capability **finer than the ordinary scheduled-backup interval**, an **RPO of up to 24 hours** and an **RTO of one business day** (`NFR-BACK-03`), **equivalent confidentiality, access control and protection for every copy** (`NFR-BACK-04`), a restore rehearsed **before launch and at least quarterly** (`NFR-BACK-02`, `NFR-BACK-05`), and **at least one recoverable copy independent of the primary data-store provider**, no more than 24 hours behind committed live data (`NFR-BACK-06`, as amended by ruling **R1**). It records that **no mechanism, location, service, or provider is selected** for that independent copy, and that **whole-region survival is not separately required** for the MVP.

**Why the decision is taken now.** `P0b` implementation is live — the scaffold (PR #96), the CI pipeline (PR #98) and the required build gate (PR #100). The next implementation steps approach the data path, which is precisely where an unmade provider decision gets made silently by a connection string. `DDM-1` is **not** a `P0b` blocker — the owner ruling of 2026-08-26 (issue #87 / PR #88) settled that its deferred named provider did not block `DG-2` closure — so this is **downstream implementation enablement**, commissioned to prevent an accidental selection.

**No budget or cost ceiling exists anywhere in the requirement chain**, and none is invented here. **No data-residency requirement exists.**

## Decision

**We will use DigitalOcean Managed PostgreSQL as the named managed PostgreSQL provider for the MVP.**

**This decision is specific to the Community Directory Platform. It is not a universal datastore policy, and subsequent projects may decide differently.**

### Selected

| | |
|---|---|
| **Managed PostgreSQL provider** | **DigitalOcean** |
| **Named service** | **DigitalOcean Managed PostgreSQL** — the provisioned managed-cluster product, not a serverless posture |

That is the whole of the decision. **`ADR-003`'s engine and managed posture are unchanged**; this ADR resolves only the **named provider** half that `ADR-003` deferred.

### Explicitly not selected

This ADR selects **no** database region; **no** plan, tier, or instance size, for production or for non-production; **no** production or non-production sizing; **no** database name, schema, columns, keys, constraints or indexes (`DDM-2`–`DDM-10`); **no** search implementation (`ADR-007`, `OQ-4`); **no** ORM, data-access library, query builder, PostgreSQL driver, connection pooler or migration framework (**ruling R-A**); **no** authentication mechanism, credential policy or identity store (`ADR-004`, `DG-3`); **no** secrets tooling, secret names or credentials; **no** backup implementation mechanism, independent-copy destination, independent-copy tooling or independent-copy schedule; **no** Render deployment configuration or database-connectivity implementation; and **no** PostgreSQL version. **It authorizes no provisioning**: no DigitalOcean account, no billing commitment, no trial, no database cluster.

## Rationale

- **A conventional managed PostgreSQL.** DigitalOcean Managed PostgreSQL is a provisioned managed cluster running PostgreSQL itself, reached over an ordinary encrypted PostgreSQL connection — the shape `ADR-003`'s managed posture and `ADR-005`'s long-running Node service both assume, with no adaptation of the data path (`H1`, `H2`, `H10`).
- **A provider separate from the application host.** Keeping the primary datastore with a vendor other than Render preserves the architectural independence posture `ADR-005` explicitly protected, and keeps the datastore decision a decision rather than a consequence of co-location.
- **Backups map directly to the obligation, without an interpretive argument.** Its documented model is **daily full backups plus write-ahead-log archiving**, included at every tier, with restore to any point in the previous 7 days. `NFR-BACK-01`'s **at least daily** obligation maps directly to the provider's documented daily full-backup capability, and `ADR-010`'s **finer-than-interval** recovery capability maps directly to its write-ahead-log-based point-in-time restore — two distinct obligations supported by two distinct documented mechanisms. **Naming the provider alone does not satisfy either obligation**: provisioning, validation, operation, the independent copy and restore rehearsal all remain outstanding.
- **Recovery capability is not tier-gated in the way the alternatives' is.** Backup and point-in-time restore are documented as included at every tier rather than as a paid add-on or a workspace-plan property, so the capability `ADR-010` requires does not depend on a plan choice this ADR deliberately does not make.
- **Predictable fixed pricing.** Cost enters as **predictability**, not as a threshold — no budget exists to test against. A fixed monthly cluster price is easier to reason about at `PA-1` than usage-based billing, and **no monthly figure is committed by this ADR**.
- **Portability is preserved.** Ordinary `pg_dump` / `pg_restore` compatibility and the absence of proprietary coupling keep `ADR-003`'s portability reasoning intact, and keep the export path that any later independent-copy mechanism will need.

**DigitalOcean did not dominate every criterion**, and this ADR does not pretend otherwise. The honest tradeoffs are recorded under *Consequences* and *Risks*.

## `ADR-010` compatibility — and what it does not settle

**Choosing DigitalOcean does not satisfy `ADR-010`.** It makes the posture **reachable**; the obligations remain the project's.

| `ADR-010` obligation | Bearing of this decision |
|---|---|
| **At least daily backups** (`NFR-BACK-01`) | **Compatible** — daily full backups are documented as included at every tier |
| **Recovery finer than the backup interval** | **Compatible** — write-ahead-log-based point-in-time restore within the documented recovery window |
| **RPO ≤ 24 hours, including loss of the primary provider** (`NFR-BACK-03`, `R1`) | **Compatible for provider-internal failure only.** The provider-loss half is met by the **independent copy**, which this ADR does not provide |
| **RTO of one business day** (`NFR-BACK-03`) | **Compatible** — a documented restore path exists; the procedure and its measured duration remain to be established |
| **An independent recoverable copy, ≤ 24 hours stale** (`NFR-BACK-06`, as amended) | **NOT satisfied, and outstanding.** `ADR-010` selects **no mechanism, location, service, or provider** for it, and neither does this ADR. DigitalOcean's ordinary export capability makes such a copy **feasible**; establishing it is a separate later decision |
| **Equivalent protection for every copy** (`NFR-BACK-04`) | **Compatible** — encryption in transit and at rest are documented; the access-control model for exported and independent copies remains to be established |
| **Restore rehearsed before launch and quarterly** (`NFR-BACK-02`, `NFR-BACK-05`) | **Outstanding.** Not performed, not scheduled, and not made possible merely by naming a provider |
| **99% monthly availability** (`NFR-REL-01`, `NFR-REL-02`, `NFR-REL-05`) | **Not impeded.** `ADR-010`'s single-instance posture requires neither automatic failover nor multi-region survival; availability remains the system's responsibility, not the provider's guarantee |

> **Naming a provider satisfies no recovery obligation.** `ADR-010`'s provider-capability validation is **carried forward, not closed**, and must be re-verified against current official documentation before provisioning.

## Alternatives considered

Four candidates were compared, spanning the serverless, developer-platform, co-located and provisioned-managed-cluster postures. **No candidate was disqualified outright**; all four have a paid configuration with no known disqualifier, and the decision was made on weighted criteria. **No free tier is production-suitable** — three of the four fail a hard requirement on their free tier.

| Candidate | Posture | Recovery model | Indicative cost — decision-time evidence, accessed 2026-08-31 |
|---|---|---|---|
| **DigitalOcean Managed PostgreSQL** *(selected)* | Provisioned managed cluster | Daily full backups + write-ahead logs; restore to any point in the previous 7 days, included at every tier | From **$15.15/month** at the smallest documented configuration |
| **Neon** | Serverless PostgreSQL | Continuous history with instant restore; **no built-in scheduled backups**; history retention varies by plan | Usage-based |
| **Supabase** | Developer platform on PostgreSQL | Daily backups on paid plans; **point-in-time recovery is a paid add-on**; free tier has **no automatic backups** and pauses when idle | Paid plan plus a materially priced PITR add-on |
| **Render PostgreSQL** | Managed, co-located with the application host | Continuous backup on **paid** instances; recovery window is workspace-plan dependent; **no recovery on Free**, which expires 30 days after creation | Tiered, plus storage |

### Neon *(not selected)*

**Not rejected on capability.** Its continuous-history model with instant restore is a strong recovery story, and `pg_dump` / `pg_restore` are supported, so portability is preserved.

**Why it was not selected.** `NFR-BACK-01` requires **at least daily backups**, and Neon's model is **history retention rather than discrete documented daily backups** — satisfying the wording would require an **interpretive argument** rather than a direct mapping to a documented daily backup. Secondary tradeoffs: **usage-based cost** is less predictable than a fixed cluster price at `PA-1`, and **region is fixed at project creation**, which removes a later degree of freedom this ADR deliberately leaves open.

### Supabase *(not selected)*

**Not rejected on capability.** It is PostgreSQL, with a capable platform around it.

**Why it was not selected.** Its **free tier fails `H3` outright** — no automatic backups, and it pauses when idle. On paid plans the **point-in-time recovery that `ADR-010`'s finer-than-interval capability requires is a separately priced add-on**, so the capability is a purchasing decision rather than an included property of the service, which sits awkwardly against an ADR that deliberately selects no tier.

### Render PostgreSQL *(not selected)*

**Not rejected on capability, and it is operationally the simplest option.** Co-location with the application host gives same-platform private networking and one vendor relationship to manage — a genuine advantage for a single maintainer.

**Why it was not selected.** Combining the application and the **primary datastore** on Render **increases provider concentration** and **weakens the architectural independence posture** relative to a separate datastore provider — the concentration `ADR-005` named as a risk when it declined to select Render PostgreSQL by co-location. Its **recovery behaviour is also more plan- and workspace-dependent** than a model where backup and point-in-time restore are included at every tier.

**Major-cloud managed PostgreSQL** (RDS, Cloud SQL, Azure Database for PostgreSQL) remained in the candidate universe and was not carried to detailed comparison: the evidence gathered was insufficient at commissioning, and the account, IAM and network surface is disproportionate to `PA-1` and to `NFR-OPS-04`.

## Consequences

### Positive

- **`DDM-1`'s named-provider half is decided** — deliberately, on recorded evidence, rather than by a connection string.
- **The datastore stays independent of the application host**, preserving `ADR-005`'s recorded boundary in practice and not only in principle.
- **Backup and point-in-time recovery map to `ADR-010` by documented mechanisms**, not by interpretation.
- **Ordinary PostgreSQL connectivity** from the long-running Node service, with no adaptation of `C9`.
- **Portability is preserved** — standard dump and restore, no proprietary coupling.

### Negative — stated plainly

- **Two vendors instead of one.** A separate datastore provider means a second account, a second billing relationship and a second console for a single maintainer — the operational simplicity Render PostgreSQL would have offered is genuinely given up.
- **No same-platform private networking.** Connectivity is an ordinary TLS-encrypted PostgreSQL connection over the public network; any allow-listing without static egress is extra setup, and must be surfaced rather than assumed.
- **No SLA is asserted here.** This ADR **asserts no DigitalOcean SLA percentage**; none was established as applicable at the tiers this MVP would plausibly use, and none is inferred.
- **Cost is not validated.** No tier is selected and no monthly figure is committed; the production cost is not established by this document.
- **The independent copy is still missing.** The obligation `R1` sharpened remains entirely outstanding.
- **Pricing, plan names and PostgreSQL version support are mutable.** Every such fact here is decision-time evidence with an access date, and must be re-verified before provisioning.

## Reversibility

**Bounded.** Migrating to another managed PostgreSQL provider while retaining PostgreSQL touches: the connection configuration and its secrets; the data itself, moved by ordinary `pg_dump` / `pg_restore`; and whatever backup and independent-copy mechanism is later built against this provider. **Application and domain code: none expected**, because `C9` remains the sole data-access path and nothing above it is provider-shaped. **This is not zero lock-in** — a live database means a data migration with a cutover, which is exactly why `docs/adr/README.md` classifies a decision of this weight as ADR-worthy.

## Assumptions

| | |
|---|---|
| **`PA-1`** — the directory is small at first release | Carried, not resolved. `NOQ-1` and `NOQ-4` remain **Unresolved shaping inputs**. If `PA-1` proves false, sizing — and then this decision — are among the first things to revisit (`DD-12`) |
| **No governed budget exists** | No cost ceiling appears anywhere in the requirement chain. Cost was weighed as **predictability**, never as a threshold, and **no monthly figure is committed here** |
| **No data-residency requirement exists** | None appears in `docs/06`. A US region pairable with the Render deployment region is assumed available; **the region itself is not selected** |

## Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| **Naming a provider is mistaken for satisfying `ADR-010`** | The independent off-provider copy and the restore rehearsal are assumed done | The *`ADR-010` compatibility* table states which obligations remain outstanding, and names the independent copy as **not satisfied** |
| **Mutable provider facts harden into architecture** | Pricing, plan names or version support are treated as durable commitments | Every such fact is recorded as decision-time evidence with an access date, and **none is normative**; re-verification before provisioning is required |
| **The tier is chosen by inference from this ADR** | A purchasing decision is made without being made | **No tier, sizing or region is selected**; the capabilities a production-sensible configuration must have are stated as obligations instead |
| ~~**`Proposed` is treated as in force**~~ — **discharged at acceptance, 2026-09-03** | Provisioning or connectivity work begins on the strength of a draft | ~~The header callout states that this ADR is **not in force**, that `DDM-1` is not yet discharged, and that acceptance is a **separate governed step**~~ — the separate governed acceptance step was performed (issue #103), so this ADR **is** in force. **The risk it guarded against does not transfer to provisioning**: being in force still authorizes no account, cluster or connectivity — see the row below |
| **Provisioning follows acceptance automatically** | An account, a cluster and a billing commitment appear without their own authorization | Provisioning requires a **separately commissioned and explicitly authorized later work unit**; nothing in this ADR or its acceptance authorizes it |

## Deferred decisions

Each remains open, and none is decided or narrowed by this ADR: DigitalOcean **account and billing setup**; **database provisioning**; the **database region**; the **development tier**, the **production tier** and all **sizing**; **credentials** and **secret management**, including secret names; **TLS and network allow-list details**; **connection pooling**; the **ORM**, **driver** and **migration framework**; the **physical schema**, **indexes** and **search implementation**; **authentication**; the **backup mechanism**; the **independent-copy destination, tooling and schedule**; **restore automation**; and the **Render database-connectivity implementation**.

## Compatibility with Accepted ADRs

| | |
|---|---|
| **`ADR-001`** — modular monolith, server-enforced boundary | Not reopened. One process connects **server-side** to an external managed PostgreSQL; `C9` remains the sole data-access path and there is no browser-direct access |
| **`ADR-002`** — TypeScript and Next.js | Not reopened. **Ruling R-A** stands: no ORM, client, query builder, pooler or migration tool is selected here |
| **`ADR-003`** — PostgreSQL, managed posture | **Not rewritten, and not reopened.** `ADR-003` decided the **engine and the managed posture** on 2026-08-23 and deferred the named provider; **this ADR decides only that deferred half, later and separately.** `ADR-003` remains the historical record of what it decided and when |
| **`ADR-005`** — Render hosting, long-running Node runtime | Not reopened. **Render remains the application host only.** `ADR-005` did **not** select Render PostgreSQL, and this ADR does not reverse that: **DigitalOcean Managed PostgreSQL is a separate datastore-provider decision** |
| **`ADR-006`** — listing model and lifecycle | Not reopened. The model is logical; its physical representation remains `DDM-2`–`DDM-10` |
| **`ADR-010`** — availability and recovery posture | Not reopened and **not discharged**. The 99% target, the ≤ 24-hour RPO, the at-least-daily backups, the one-business-day RTO, the independent off-provider copy, the pre-launch and quarterly restore rehearsals, and the exclusion of whole-region survival as a separate MVP failure class all stand exactly as written |

## Open questions this decision must NOT answer

| Question | Status |
|---|---|
| **`DDM-2`–`DDM-10`** — identity strategy, physical schema, columns, keys, constraints, indexes, revision and lifecycle representation, migrations | **Untouched** |
| **`ADR-007` / `OQ-4`** — search approach | **Untouched.** No index or text-search strategy is decided by naming a provider |
| **`ADR-004` / `NOQ-9`** — administrator authentication | **Untouched**, under `DG-3` |
| **`ADR-012`** — testing strategy and tooling | **Untouched** |
| **ORM, data-access, driver, pooler, migrations** | **Untouched** under **ruling R-A** |
| **Region, tier, sizing, provisioning, billing** | **Deferred.** No evidence makes any of them architecturally inseparable from the provider decision |
| **The backup mechanism and the independent copy** | **Untouched** — `ADR-010` selects **no mechanism, location, service, or provider**, and neither does this ADR |
| **Render deployment and database-connectivity configuration** | **Untouched.** `ADR-005`'s tier, sizing and deployment configuration remain unselected |
| **PostgreSQL version** | **Untouched.** Supported versions are a mutable provider fact; version selection is a provisioning and runtime choice |
| **`NOQ-1`, `NOQ-4`** — performance thresholds and expected load | **Carried as `PA-1`**, not answered |
| **Implementation** | **Not authorized.** Acceptance puts the **named-provider decision** in force and nothing more; provisioning remains a separate later work unit |

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-BACK-01`–`NFR-BACK-06` (as amended by ruling `R1`) — the capability filter; `NFR-REL-01`, `NFR-REL-02`, `NFR-REL-05` (availability, announced maintenance); `NFR-SEC-04`, `NFR-SEC-08` (protection in transit; secrets); `NFR-OPS-01`, `NFR-OPS-04` (operable by a small team; proportionate infrastructure); `NFR-SCALE-01` (at `PA-1`) |
| **Components** | `C9` — the sole data-access path to the external managed PostgreSQL |
| **Invariants** | Must not breach: `DI-1`–`DI-11`. This ADR decides nothing about them |
| **Decisions** | `DDM-1` — the **named managed service and vendor**; **discharged by this `Accepted` ADR (2026-09-03), and only as to the named provider** — DigitalOcean Managed PostgreSQL. `DDM-2`–`DDM-10` and `ADR-010`'s outstanding obligations are untouched by that discharge. `DD-3` — already discharged by `ADR-003`; untouched. `DG-2` — **Resolved** 2026-08-27 (issue #93); this ADR is not a constituent and changes nothing about it. `NOQ-2`, `NOQ-3`/`R1` — Decided, inputs. `NOQ-1`, `NOQ-4` — shaping inputs, carried as `PA-1` |
| **Related ADRs** | `ADR-003` (Accepted — the engine and managed posture whose deferred provider this decides; not reopened); `ADR-005` (Accepted — the application host, which selected no database; not reopened); `ADR-010` (Accepted — the capability filter; not reopened and **not discharged**); `ADR-001`, `ADR-002`, `ADR-006` (Accepted; not reopened); `ADR-004`, `ADR-007`, `ADR-008`, `ADR-009`, `ADR-011`, `ADR-012` (open, and not decided here) |
| **Governance** | **Issue #101** — the commissioned `DDM-1` decision, which classified the artifact as a **new `ADR-013`** on `docs/adr/README.md`'s *When an ADR is required* test (costly to reverse, cross-cutting, contested) and on the uniform `ADR-002` / `ADR-003` / `ADR-005` precedent of a `Proposed` publication followed by a separate owner `Accepted` ruling. **Owner ruling** — *approve Option A, DigitalOcean Managed PostgreSQL*. **Issue #103** — the separate governed acceptance step, with the owner's file-set ruling of 2026-09-03 excluding `docs/07-system-architecture.md` and `docs/12-implementation-plan.md` on the ground that their `DD-3` / `ADR-003` wording is historical context for the earlier deferral and does not authoritatively record the `DDM-1` answer |
| **Documents amended** | **At the earlier `Proposed` stage (PR #102):** `docs/adr/README.md` (register row) and `docs/traceability-matrix.md` (ADR register row) only — following the `ADR-002` and `ADR-005` `Proposed`-stage precedent. `docs/07-system-architecture.md`, `docs/08-data-model.md`, `docs/12-implementation-plan.md` and `docs/13-decision-log.md` are **untouched**: no statement in them becomes false merely because this ADR is `Proposed`. **At acceptance (issue #103):** this file, `docs/adr/README.md`, `docs/traceability-matrix.md`, `docs/08-data-model.md` (the `DDM-1` row) and `docs/13-decision-log.md` — the `Accepted` lifecycle status and the **named-provider discharge of `DDM-1`**. **`docs/07-system-architecture.md` and `docs/12-implementation-plan.md` are untouched by owner ruling of 2026-09-03**, departing from the `ADR-002` / `ADR-003` / `ADR-005` acceptance precedent because this ADR discharges no `DD-*`: their `DD-3` and `ADR-003` rows record the **history of the earlier deferral**, not the authoritative `DDM-1` state, which `docs/08` holds. **No gate is marked `Resolved`** — `DG-2` was already `Resolved` (issue #93) and this ADR is not a constituent of it |
| **Issue / pull request** | **Proposed:** issue #101 — `architecture: decide the MVP managed PostgreSQL provider in ADR-013`; pull request #102 — `docs: propose DigitalOcean Managed PostgreSQL provider`, merged 2026-09-01. **Accepted:** issue #103 — `architecture: accept ADR-013 DigitalOcean Managed PostgreSQL provider` |

### Sources consulted

External claims in this ADR rest on the official sources gathered for issue #101, accessed **2026-08-31**. **Pricing, plan names, recovery-window lengths and supported PostgreSQL versions are mutable provider facts, recorded as decision-time evidence and not as architectural requirements**; each must be re-verified against current official documentation before provisioning.

| Source | Supports |
|---|---|
| DigitalOcean — Managed Databases pricing (`digitalocean.com/pricing/managed-databases`) | Fixed monthly cluster pricing; **$15.15/month** at the smallest documented configuration — decision-time evidence only |
| DigitalOcean — PostgreSQL features (`docs.digitalocean.com/products/databases/postgresql/details/features/`) | **Daily full backups plus write-ahead logs**, restore to any point in the previous 7 days, included at every tier; **SSL in transit**, encryption at rest; optional standby node |
| Neon — plans and backups (`neon.com/docs/introduction/plans`, `neon.com/docs/manage/backups`) | Continuous history with instant restore and **no built-in scheduled backups**; plan-dependent history retention; usage-based pricing — used only for the rejected-alternative rationale |
| Supabase — pricing (`supabase.com/pricing`) | Daily backups on paid plans; **PITR as a separately priced add-on**; free tier without automatic backups and pausing when idle — used only for the rejected-alternative rationale |
| Render — PostgreSQL backups and pricing (`render.com/docs/postgresql-backups`, `render.com/pricing`) | Continuous backup on **paid** instances with a workspace-plan-dependent recovery window; **no recovery on Free**, which expires 30 days after creation — used only for the rejected-alternative rationale |

**No DigitalOcean SLA is asserted anywhere in this ADR.** No applicable SLA percentage or qualifying tier was established from official documentation, and none is inferred.
