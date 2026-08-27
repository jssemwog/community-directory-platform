# `ADR-005` — Adopt Render as the MVP application hosting platform, deploying the Next.js modular monolith as a long-running Node.js web service, and defer every separable delivery and procurement decision

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Date** | 2026-08-27 |
| **Decision owner** | Joe S. — product owner |
| **Decision gate** | `DG-2` — technology. **Unresolved.** This ADR is `DG-2`'s **final remaining substantive constituent** (owner ruling, issue #87 / PR #88); it does not close the gate |
| **Related open questions** | **Carried as shaping inputs, not blockers:** `NOQ-1`, `NOQ-4` (`PA-1`). **Must NOT answer:** `NOQ-9` (`ADR-004`, `DG-3`), `NOQ-5`, `NOQ-6`, `NOQ-7`, `OQ-4`, `OQ-9`, `OQ-14` / `NOQ-8`, `DDM-1`–`DDM-10`, `DU-1`, `DA-8` — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **Accepted, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is *"Decided and **in force**. Work may rely on it."* The product owner accepted this decision on 2026-08-27, following the governed candidate comparison, the `Proposed`-stage publication recorded on issue #89 and merged by **PR #90**, and the detailed review recorded on issue #91. **`DD-5` is discharged** by it. But **an ADR records a decision; it does not open a gate**: **`DG-2` remains Unresolved** — this ADR completes the gate's **final remaining substantive decision**, and `DG-2` proceeds to `Resolved` only through a **separate governed synchronization** — the compensating obligations **O-1**–**O-9** below are binding rather than advisory, and **no implementation is authorized** by this document.

---

## Context

`docs/07-system-architecture.md` defers the hosting decision as **`DD-5`** — *"Hosting platform and runtime model (long-running instance versus serverless runtime)"* — recording that **both satisfy the architecture** and that *"statelessness keeps both open"*, against `NFR-OPS-04`, and with the standing constraint that it **must not reopen the rejected decomposition of Option D**.

**`ADR-005` is the last substantive decision `DG-2` is waiting on.** The product owner's ruling of 2026-08-26, recorded on **issue #87** and merged by **PR #88**, established that *"`DG-2`'s remaining closure scope is `ADR-005` alone"*: `ADR-002`, `ADR-003` and `ADR-010` are `Accepted` and their `DG-2` work is complete; `NOQ-2` and `NOQ-3` are **Decided**; **`ADR-004` belongs to `DG-3`**, **`ADR-012` does not block `DG-2`** (its depth half is `DG-4`), **CI is `P0b` / derivative implementation-enablement work** the gate's closure unblocks, and **`DDM-1`'s deferred named managed provider does not block closure**. That ruling **prospectively supersedes** the earlier ambiguity recorded in `Accepted` `ADR-002` and `ADR-010`, which are historical records and are **not edited**.

**Nothing was blocking the decision.** `ADR-005`'s register entry named **no open question**: `DD-5` is a stated *input*, not a blocker, and `docs/07` records that `NOQ-2` — **Decided** 2026-07-30 — *"no longer blocks `DD-8`; the hosting product is not selected — that remains `ADR-005`, under `DG-2`."* `NOQ-1` and `NOQ-4` are classified independently as **shaping inputs** that inform technology selection without blocking it, carried as the stated assumption **`PA-1`** ("the directory is small at first release"). No performance or load threshold is asserted anywhere, and none may be invented (`docs/11`, Category 3).

**Four Accepted ADRs constrain the choice and are not reopened here.** `ADR-001` fixed a **modular monolith** as **one deployable artifact**, with `C1`–`C12` as **in-process** seams and a **server-enforced** public/administrative boundary at `C8`, rejecting microservices and browser-direct data access. `ADR-002` fixed **TypeScript and Next.js**, recording a **Node.js runtime** as an unavoidable framework *consequence* and **not** an `ADR-005` decision, and binding obligations `O-1`–`O-12` — of which **`O-12`** exists precisely to keep this decision open. `ADR-003` fixed **PostgreSQL under a managed operating posture**, deferring the **named managed service and vendor**. `ADR-010` fixed a **single-instance availability posture** with stateless instances, recording that *"'Single instance' is a **posture**, not a topology. Where and how it runs is untouched."*

**No budget or cost ceiling exists anywhere in the requirement chain**, and none is invented here. **No data-residency requirement exists.**

## Decision

**We will use Render as the MVP application hosting platform, and deploy the Next.js modular monolith as a long-running Node.js web service.**

**This decision is specific to the Community Directory Platform. It is not a universal hosting policy, and subsequent projects may decide differently.**

### Selected

| | |
|---|---|
| **Application hosting platform** | **Render** |
| **Application runtime model** | **Long-running Node.js web-service process** — a continuously running server, not a per-invocation function |

### Deployment topology implied by this selection

The ordinary Render web-service topology: **one long-running application instance** behind **Render's managed routing and TLS termination**, deployed from the repository, with health checks and rollback as the platform provides them. That is the topology this selection implies — **nothing further is chosen**. Load balancing, CDN, multi-region placement, private networking and autoscaling policy are **not** selected and are not required by the current architecture; `ADR-010` fixes a **single-instance posture**, so redundancy remains an operational change rather than a redesign.

### Always-on production posture — an architectural obligation

Render's **free** web-service tier **spins a service down after 15 minutes of inactivity** (Render documentation, accessed 2026-08-26). A public directory that sleeps is not a public directory.

> **Production deployment must use an always-on Render service configuration compatible with the MVP availability target; a configuration that deliberately spins the production service down after inactivity is not acceptable.**

This is an **architectural** obligation about service posture, **not** a plan selection and **not** a pricing commitment. **No Render paid tier, instance size, or region is selected here** — no current evidence establishes that an exact tier is architecturally inseparable from this decision, so tier and sizing remain implementation and procurement detail, subject to later cost validation.

### Explicitly not selected

This ADR selects **no** named managed PostgreSQL provider — **Render PostgreSQL is not selected**, and neither is Supabase or any other database service; **no** ORM, data-access library, query builder, PostgreSQL client, connection pooler, or migration tool (**ruling R-A**); **no** authentication mechanism, credential policy, or identity store; **no** test framework or runner; **no** continuous-integration system; **no** package manager, build tool, container technology or **Docker**; **no** deployment-automation or infrastructure-as-code tool; **no** observability product; **no** DNS or CDN configuration; **no** physical schema or index; and **no** Node.js or Next.js version. **Vercel is not selected.**

## Rationale

**The runtime model is the substance of this decision, and it was chosen on architecture rather than on ergonomics.** A long-running Node process is the closest runtime match to a modular monolith that holds one transactional invariant and talks to a relational store:

- **Full framework fidelity by the ordinary path.** Next.js's own deployment documentation (accessed 2026-08-26) records that a **Node.js server** and a **Docker container** each support **"All"** features, while **adapter**-based platforms **"vary"**. Render is reached by the plain Node path, so feature fidelity does not depend on a third party tracking Next.js releases. Render is additionally one of the providers with an official Next.js deployment template hosted under the Next.js GitHub organisation.
- **Conventional PostgreSQL connectivity.** A continuously running process holds a stable, long-lived connection pool. `docs/07` warned when rejecting Option D's shape that *"connection management against a relational store"* becomes harder under a function-oriented model; a long-running service simply does not have that problem.
- **A simple mental model.** `next build` then `next start` — the same process locally and in production, which serves `NFR-MAINT-02` and keeps `NFR-OPS-01` honest for a small team with no dedicated operations staff.
- **Bounded provider coupling.** The application remains an ordinary Node server. What is Render-specific is deployment and environment configuration, not the runtime or the domain.
- **Moderate-to-low operational burden.** Render owns the operating system, runtime, process supervision, TLS and routing; the team owns the application. That is materially less burden than an infrastructure-oriented option, which matters directly against **`NFR-OPS-04`** — the very requirement `DD-5` cites.
- **A straightforward deploy and redeploy model.** Render documents zero-downtime deploys, configurable health checks and instant rollback (accessed 2026-08-26), which is what application-host recovery within the `NFR-BACK-03` **one-business-day RTO** actually requires.

**Render did not dominate every criterion, and this ADR does not pretend otherwise.** The honest tradeoffs are recorded under *Consequences* and *Risks*.

## Alternatives considered

Three finalists emerged from a governed comparison of five candidates across the long-running, container and serverless runtime categories, under hard filters derived from `ADR-001`, `ADR-002`, `ADR-003` and the `NFR` chain. **All five passed every hard filter**; the decision was made on weighted criteria, not on disqualification.

### Vercel — framework-managed serverless *(not selected)*

**Not rejected on capability, and it was the closest contender.** Vercel is the **verified adapter** platform for Next.js — one of only two verified adapters, running the full Next.js compatibility test suite with testing coordinated before major releases — giving it the **strongest and most native Next.js integration available**, together with **excellent deployment ergonomics**, per-branch preview deployments, and **genuine prior owner familiarity from the mini lab**. That familiarity is real evidence and it lowered learning and setup risk.

**Why it was not selected.** Its **framework-managed serverless runtime** is the least natural fit for this architecture: per-invocation execution brings **PostgreSQL connection-pressure considerations** of exactly the kind `docs/07` flagged, and function execution is **duration-capped** (Vercel documentation, accessed 2026-08-26: 10 s default / 60 s maximum on Hobby; 15 s / 300 s on Pro). It carries the **greatest provider and runtime coupling** of the finalists — the outcome obligation **`O-12`** was written to prevent being reached by default rather than by decision. Its published **uptime guarantee is limited to the Enterprise plan** (99.99%); the research established **no applicable SLA at the tiers this MVP would plausibly use**. Its **runtime-log retention is short** — 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise — which sits awkwardly against `NFR-OBS-01`'s requirement that logs be sufficient *"for a maintainer to diagnose a problem **after it occurs**."*

**Familiarity was weighed, and it was not allowed to decide.** Consistent with `C-5`, the `docs/07` anti-criteria and the `ADR-002` precedent, mini-lab experience is **familiarity evidence, not architectural precedent**, and Next.js sharing an ecosystem with Vercel confers no architectural standing.

### Fly.io — container *(not selected)*

**Not rejected on capability.** Fly.io offers the **strongest container-oriented portability and control** of the finalists: an OCI image runs anywhere, giving the best exit path; Next.js support is **full** via the documented Docker path, with an official template under the Next.js organisation; and it publishes a **99.9% monthly uptime commitment** with service credits — the most explicit availability evidence any finalist produced. Its per-second compute pricing was also the most transparent.

**Why it was not selected.** It places **more responsibility on the operator** — base-image currency, machine placement, health, routing behaviour, scaling and resilience are all more explicitly the team's concern. For a first release operated by a small team without dedicated operations staff (`NFR-OPS-01`, a **Must**), that burden is **greater than this MVP needs**, and `NFR-OPS-04` cautions specifically against infrastructure disproportionate to a small first release.

### Also examined and not carried to the finalist round

**Netlify** (adapter-based serverless) passed every hard filter and documents a full Next.js feature matrix via the open-source OpenNext adapter, but its adapter is **not** among the Next.js team's verified adapters, and it offered no criterion on which it clearly led the finalists. **AWS App Runner** (managed container) is architecturally sound, supports Node.js, and offers VPC connectivity to a managed PostgreSQL, but its account, IAM and VPC surface is the heaviest of the candidates against `NFR-OPS-04`. Neither is recorded here as a rejected finalist; both are noted for completeness.

## Consequences

### Positive

- **`DD-5`'s runtime question is settled on architecture.** A long-running process matches the modular monolith, the transactional invariant and the relational store without compromise.
- **Full Next.js feature support** through the ordinary Node path, independent of adapter maintenance.
- **Conventional external-PostgreSQL connectivity** with a stable pool, avoiding function-model connection pressure.
- **Low operational burden** — Render owns operating system, runtime, supervision, TLS and routing.
- **Application-host recovery is straightforward** — redeploy from source, with zero-downtime deploys and instant rollback documented.
- **Reversibility stays bounded** — the application remains an ordinary Node server; coupling is concentrated in deployment configuration.

### Negative — stated plainly

- **Availability evidence is weaker than one alternative's.** The research **did not establish an applicable Render SLA percentage or qualifying tier** from official documentation. This ADR **asserts no Render SLA**. Fly.io's published 99.9% commitment was more explicit; Vercel's applies only at Enterprise.
- **Choosing a platform does not deliver availability.** `NFR-REL-02`'s **99% over a rolling monthly window, excluding announced maintenance** (`NFR-REL-05`) remains the **application's** responsibility — a function of configuration, runtime operation, deployment practice and the separately governed datastore, not of platform selection.
- **Free-tier posture is unusable in production.** Idle spin-down is incompatible with a public directory, which is why the always-on obligation above is architectural rather than advisory.
- **Some provider coupling remains.** Deployment and environment configuration are Render-specific. **This is not zero lock-in**, and claiming otherwise would be false.
- **Less Next.js-specific platform tooling** than the framework-native alternative — no verified-adapter guarantee, and preview ergonomics are good rather than best-in-class.
- **Cost is not yet validated.** Tier and sizing are deferred, so the production cost is not established here.

## Compensating architectural obligations

These are the conditions on which the accepted tradeoffs rest. They are **binding rather than advisory**, and each is reviewable.

| | |
|---|---|
| **O-1** | **The production service runs always-on.** A configuration that deliberately spins the production service down after inactivity is not an acceptable production posture (`NFR-REL-02`). |
| **O-2** | **The application remains an ordinary Next.js Node server.** It must stay runnable by `next build` and `next start` on any Node-capable host, so that the runtime is not the thing that couples us. |
| **O-3** | **No unnecessary Render-specific dependency.** Render-managed products and platform-specific runtime APIs are not adopted merely because they are convenient or co-located; adopting them would erode the reversibility recorded below. Continues `ADR-002` `O-12` past this decision. |
| **O-4** | **Deployment is reproducible from source.** The running service must be redeployable from the repository, so application-host recovery and provider exit are both real (`NFR-BACK-03` RTO). |
| **O-5** | **Secrets remain server-only.** Configuration and secrets are held in server-side environment configuration, never in client bundles, never in logs or error messages (`NFR-SEC-08`, `NFR-OBS-02`). |
| **O-6** | **PostgreSQL access remains server-side.** The application connects to the external managed PostgreSQL from the server over an encrypted connection; `C9` remains the sole data-access path and there is no browser-direct access (`ADR-001`, `ADR-002` `O-1`, `NFR-SEC-04`). |
| **O-7** | **Authorization stays in the application.** The hosting platform does not replace the server-enforced public/administrative boundary at `C8`, which is checked on every request (`NFR-SEC-01`, `NFR-SEC-02`). |
| **O-8** | **Availability and observability are validated before launch, against recorded evidence.** Before the first production release, the deployed configuration must be shown — in writing, against the deployed service rather than against platform marketing — to (a) run always-on per **O-1**, (b) emit the logs `NFR-OBS-01` requires and expose the health signal `NFR-OBS-03` requires, and (c) retain those logs for at least the period `NFR-OBS-06` requires, stating the configured retention explicitly where it exceeds the platform default. `NFR-REL-02`'s 99% target is measured over a rolling month and therefore **cannot** be demonstrated before launch; what must be shown beforehand is that the deployed configuration contains **no known impediment** to meeting it, and that the measurement itself is in place. **Release without this record does not satisfy the obligation. The mechanism and the observability product are not selected here.** |
| **O-9** | **Decisions outside this ADR do not quietly narrow the exit path.** `O-2` binds the *application* to a portable Node server and `O-3` bars unnecessary *Render-specific* dependencies; `O-9` covers what neither reaches — **later hosting-, runtime- and deployment-adjacent decisions**, including those taken under other ADRs or during implementation, which are individually reasonable yet cumulatively make leaving Render materially harder than the **bounded** classification under *Reversibility* claims. Such a decision is **taken deliberately and recorded, with the reversibility cost named**, and the *Reversibility* classification is re-examined rather than assumed to survive. This bars neither ordinary Render configuration nor `O-1`'s always-on posture, and it asserts no provider-neutrality absolute. |

## Reversibility

**Bounded — and conditional on the obligations above holding.**

Migrating away from Render while retaining **TypeScript**, **Next.js** and **PostgreSQL** touches a small, well-identified surface:

| Migration surface | Cost |
|---|---|
| **Application and domain code** | **None expected.** The application is an ordinary Node server; nothing in the domain is Render-shaped, provided **O-2** and **O-3** hold. |
| **Deployment configuration** | **Small.** Service definition, build and start commands, health-check path. |
| **Environment and secrets configuration** | **Small.** Re-created on the destination platform. |
| **Platform-specific deployment behaviour** | **Small.** Rollback, preview and deploy triggers are re-expressed in the destination's terms. |
| **Runtime assumptions** | **Small**, and smaller than for a serverless origin, because a plain Node process is the most widely supported target. |
| **Datastore** | **None.** The database is external and outside this decision. |

**This is not zero lock-in.** Deployment and environment configuration are genuinely Render-specific and must be rebuilt. But the coupling is confined to the deployment layer, which is what makes the classification **bounded** rather than moderate — and that bound depends on **O-2** and **O-3**.

## Application-host recovery, and how it differs from datastore recovery

**This ADR does not duplicate `ADR-010`, and the two loss cases must not be conflated.**

- **Application-host loss** is `ADR-005`'s concern only to this extent: the application is **redeployable from source** to Render or to another provider (**O-4**), comfortably inside the **one-business-day RTO** of `NFR-BACK-03`. The application holds no durable state to recover; `ADR-010`'s stateless posture is what makes this true.
- **Datastore loss — including complete loss of, or loss of access to, the primary data-store provider — is governed entirely by `ADR-010` and `NFR-BACK-01`–`NFR-BACK-06`**, as amended by ruling **R1**, and belongs to the **deferred named managed provider** (`DDM-1`). The independent copy requirement of `NFR-BACK-06` is an obligation on **that provider's data**, not on the application host.
- **Selecting an application host satisfies no datastore-provider-loss obligation.** `ADR-010`'s provider-capability validation remains outstanding and travels with `DDM-1`.

## Compatibility with Accepted ADRs

| | |
|---|---|
| **`ADR-001`** — modular monolith, server-enforced boundary | Render hosts the **single deployable artifact**; `C1`–`C12` remain **in-process** seams; the public/administrative boundary is enforced server-side at `C8` on every request (**O-7**); microservices and browser-direct data access remain rejected (**O-6**). **A long-running process is the most direct expression of this shape.** |
| **`ADR-002`** — TypeScript and Next.js | Not reopened. The Node.js runtime this ADR hosts is the framework *consequence* `ADR-002` recorded, **not** a new decision. Obligations `O-1`–`O-12` remain binding; **`O-12`'s provider-neutral discipline is discharged by this decision being taken deliberately**, and is continued past it by **O-3**. No frontend, router, ORM or data-access technology is selected — **ruling R-A** and **ruling R-B** are untouched. |
| **`ADR-003`** — PostgreSQL, managed posture | Not reopened. The application connects **server-side** to an **external managed PostgreSQL** under the accepted operating posture. **The named managed service and vendor remain deferred** (`DDM-1`, owner ruling 2026-08-23). **Application hosting does not absorb datastore-provider selection**, and **Render PostgreSQL is not selected** — a co-located database offering confers no standing on that separate decision. |
| **`ADR-006`** — listing model and lifecycle | Not reopened. Hosting expresses the model; it decides nothing about it. |
| **`ADR-010`** — availability and recovery posture | Not reopened. The application runs **stateless** under a **single-instance** posture, so redundancy remains an operational change. `NFR-REL-02`'s 99% target and `NFR-REL-05`'s **excluded announced maintenance** stand as written. Recovery obligations for data remain `ADR-010`'s, not this ADR's. |

## Assumptions

| | |
|---|---|
| **`PA-1`** — the directory is small at first release | Carried, not resolved. `NOQ-1` and `NOQ-4` remain **Unresolved shaping inputs**. A long-running single instance is sized to this assumption; **if `PA-1` proves false, the instance sizing and then this decision are among the first things to revisit** (`DD-12`). |
| **No governed budget exists** | No cost ceiling appears anywhere in the requirement chain. Cost was weighed as **predictability**, never as a threshold, and **no monthly figure is committed here**. |
| **No data-residency requirement exists** | None appears in `docs/06`. Region remains an implementation choice. |

## Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| **Platform selection is mistaken for an availability guarantee** | `NFR-REL-02` is assumed satisfied rather than demonstrated | **O-8**. This ADR **asserts no Render SLA** and records that availability remains the application's responsibility |
| **Free-tier posture reaches production** | The public directory sleeps and the availability target fails outright | **O-1**, stated as an architectural obligation |
| **Render-specific coupling accumulates quietly** | The bounded reversibility recorded above degrades toward moderate or worse | **O-2**, **O-3**, **O-9** |
| **The datastore provider is chosen by co-location rather than by decision** | `DDM-1` is discharged silently and `ADR-010`'s capability validation is skipped | Recorded above and under *Open questions this decision must NOT answer*; **Render PostgreSQL is not selected** |
| **Acceptance is treated as a gate opening** | Implementation proceeds because the last substantive `DG-2` decision is taken, even though the gate is still `Unresolved` — the `IR-1` gate-bypass failure | The header callout and the *`DG-2` boundary* section both state that this ADR **opens no gate**, that `DG-2` remains `Unresolved` pending a **separate governed synchronization**, and that `P0b` and `P1`–`P5` stay blocked |
| **Cost is not validated before launch** | An unbudgeted running cost is discovered late | Tier and sizing deferred with **future cost validation required**; no dollar amount is committed |

## `DG-2` boundary

- **`ADR-005` is `DG-2`'s final remaining substantive architecture decision** — owner ruling, **issue #87** / **PR #88**, 2026-08-26.
- **This ADR is `Accepted`.** It is **in force**, **`DD-5` is discharged**, and work may rely on the hosting and runtime decision it records.
- **`DG-2` remains Unresolved**, and the `P0b` scaffold and all of `P1` remain blocked by it.
- **This acceptance completes `DG-2`'s remaining substantive decision — and does not, by itself, resolve `DG-2`.** *An ADR records a decision; it does not open a gate.* A **separate governed `DG-2` → `Resolved` synchronization** remains required, exactly as `docs/13-decision-log.md` records. **Until that synchronization lands, `DG-2` is `Unresolved` and nothing it blocks is unblocked.**
- **`ADR-004` remains under `DG-3`**; **`ADR-012` does not block `DG-2`** and testing depth is `DG-4`; **CI is `P0b` / derivative work**; **`DDM-1`'s deferred named provider does not block closure**. None is touched here.
- **No implementation is authorized.** `P0b` and `P1`–`P5` remain blocked.

## Open questions this decision must NOT answer

| Question | Status |
|---|---|
| **`DDM-1`** — the named managed PostgreSQL service and vendor | **Untouched.** Deferred by owner ruling 2026-08-23; `ADR-010`'s provider-capability validation remains outstanding with it. **Render PostgreSQL is not selected** |
| **`DD-4` / `NOQ-9` / `ADR-004`** — administrator authentication | **Untouched**, under `DG-3`. The boundary is settled by `ADR-001` and honoured by **O-7**; the **mechanism**, credential policy and identity store are not chosen, and no platform-bundled authentication decides them |
| **`ADR-012`** — testing strategy and tooling | **Untouched.** No test framework, runner or automation tool is selected; the `DG-2`/`DG-4` split is unchanged |
| **Continuous integration** | **Untouched.** No CI system is selected. CI is `P0b` / derivative implementation-enablement work that `DG-2`'s closure unblocks (owner ruling, issue #87). This ADR notes only that **O-4**'s reproducible deployment is what CI will later automate |
| **ORM, data-access, pooler, driver, migrations** | **Untouched** under **ruling R-A** |
| **Exact Render tier, instance size and region** | **Deferred.** No current evidence makes an exact tier architecturally inseparable from this decision; **O-1** constrains the *posture*, not the plan. Cost validation remains required |
| **Package manager, build tooling, container technology, Docker, IaC, deployment automation** | **Untouched.** None is needed to make this decision |
| **Observability product, DNS and CDN configuration** | **Untouched.** **O-8** states the obligation; it selects no mechanism |
| **Physical schema and indexes** | **Untouched** — `DDM-1`–`DDM-10` |
| **`NOQ-1`, `NOQ-4`** — performance thresholds and expected load | **Carried as `PA-1`**, not answered. No threshold is asserted, and none may be invented |
| **Implementation** | **Not authorized.** `P0b` and `P1`–`P5` remain blocked by `DG-2` |

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-REL-02`, `NFR-REL-05` (availability, announced maintenance); `NFR-OPS-01`, `NFR-OPS-04`, `NFR-OPS-05` (operable by a small team; proportionate infrastructure; documented procedures); `NFR-SEC-01`, `NFR-SEC-02`, `NFR-SEC-04`, `NFR-SEC-08` (server-enforced boundary; protection in transit; secrets); `NFR-OBS-01`, `NFR-OBS-02`, `NFR-OBS-03`, `NFR-OBS-06` (logs, exclusion, health signal, retention); `NFR-BACK-03` (RTO, for application redeployment only); `NFR-MAINT-02`; `NFR-SCALE-01` (at `PA-1`) |
| **Journeys** | `V1`–`V4` (browse, search, filter — the availability target's subject); `L2` (submission); `A3`–`A7` (administrative review) |
| **Components** | `C1`–`C12` as in-process seams within one deployable artifact; `C8` (administrative boundary, server-enforced on every request); `C9` (sole data-access path to the external managed PostgreSQL) |
| **Invariants** | Must not breach: `BI-1`, `BI-6`, `BI-8`; `DI-1`–`DI-11`. This ADR decides nothing about them |
| **Decisions** | `DD-5` — **discharged** by this `Accepted` ADR (2026-08-27): Render, with a long-running Node.js web-service runtime. `DG-2` — **Unresolved**; this ADR completes its final remaining substantive decision and **opens no gate**. `NOQ-2` (Decided), `NOQ-3`/`R1` (Decided) — inputs. `NOQ-1`, `NOQ-4` — shaping inputs, carried as `PA-1`. `DDM-1` — untouched. `NFR-OPS-04` — the requirement `DD-5` cites |
| **Related ADRs** | `ADR-001` (Accepted — the monolith and the boundary; not reopened); `ADR-002` (Accepted — TypeScript and Next.js, whose Node.js runtime this hosts; not reopened); `ADR-003` (Accepted — PostgreSQL under a managed posture, provider deferred; not reopened); `ADR-006` (Accepted — the model; not reopened); `ADR-010` (Accepted — the availability and recovery posture; not reopened); `ADR-004`, `ADR-007`, `ADR-008`, `ADR-009`, `ADR-011`, `ADR-012` (open, and not decided here) |
| **Governance** | **Issue #87 / PR #88** — the owner ruling of 2026-08-26 establishing that `DG-2`'s remaining closure scope is `ADR-005` alone. That ruling **prospectively supersedes** the closure-scope ambiguity recorded in `Accepted` `ADR-002` and `ADR-010`, which remain **unedited** historical records under the register's *superseding, not editing* rule |
| **Documents amended** | **At acceptance:** `docs/adr/README.md`, `docs/traceability-matrix.md`, `docs/07-system-architecture.md`, `docs/12-implementation-plan.md` — the `Accepted` lifecycle status, and the **discharge of `DD-5`**. **`DG-2` is NOT marked Resolved**, because acceptance opens no gate; the formal `Resolved` transition is a **separate governed synchronization**. `docs/13-decision-log.md` is **untouched**, following the `ADR-002` (PR #86) and `ADR-003` (PR #82) acceptance precedents, so `DG-2`'s status and its hard-blocker accounting are unchanged. **At the earlier `Proposed` stage (PR #90):** `docs/adr/README.md` and `docs/traceability-matrix.md` only |
| **Issue / pull request** | **Proposed:** issue #89 — `architecture: decide the MVP application hosting platform and runtime model in ADR-005`; pull request #90 — `docs: propose ADR-005 Render hosting and long-running Node runtime`, merged 2026-08-27. **Accepted:** issue #91 — `architecture: accept ADR-005 Render hosting and long-running Node runtime`; pull request #92 — `docs: accept ADR-005 Render hosting and long-running Node runtime` |

### Sources consulted

External claims in this ADR rest on current primary sources, accessed **2026-08-26**. Version- and date-sensitive facts will drift.

| Source | Supports |
|---|---|
| Next.js — Deploying (`nextjs.org/docs/app/getting-started/deploying`) | A **Node.js server** and a **Docker container** each support **"All"** Next.js features, while **adapters** "vary"; verified adapters are Vercel and Bun; Render and Fly.io have official Next.js deployment templates under the Next.js organisation |
| Render — Web Services (`render.com/docs/web-services`) | Web services run as **long-running, persistent processes**; Node.js supported; zero-downtime deploys, configurable health checks, instant rollback, autoscaling |
| Render — Fully Managed TLS Certificates (`render.com/docs/tls`) | TLS certificates are **issued and automatically renewed** by the platform for the default subdomain and added custom domains, and **`HTTP` requests are automatically redirected to `HTTPS`** — the basis for this ADR's *managed routing and TLS termination* claim and for **O-5**/**O-6**'s encrypted-transport expectation. **No certificate authority, DNS or CDN configuration is selected by citing it** |
| Render — Pricing and free services (`render.com/pricing`, `render.com/docs/free`) | Paid instances run continuously; **free web services spin down after 15 minutes of inactivity**; workspace plan plus usage-based compute |
| Vercel — Limits (`vercel.com/docs/limits`) | Function duration 10 s default / 60 s maximum on Hobby, 15 s / 300 s on Pro; **runtime logs retained 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise** — used only for the rejected-alternative rationale |
| Vercel — Enterprise Service Level Agreement (`vercel.com/legal/sla`) | The published **99.99% uptime commitment applies to Enterprise**; no uptime guarantee is documented for lower plans — used only for the rejected-alternative rationale |
| Fly.io — Architecture and Service Level Agreement (`fly.io/docs/reference/architecture/`, `fly.io/legal/sla-uptime/`) | Firecracker microVMs with Anycast routing and proxy TLS termination; a **99.9% monthly uptime commitment** with service credits — used only for the rejected-alternative rationale |

**No Render SLA is asserted anywhere in this ADR.** The research did **not** establish an applicable Render SLA percentage or qualifying tier from official documentation, and none is inferred.
