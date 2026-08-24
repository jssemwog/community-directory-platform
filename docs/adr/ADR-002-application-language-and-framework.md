# `ADR-002` — Adopt TypeScript and Next.js as the MVP application language and framework, and defer every separable delivery technology

| Field | Value |
|---|---|
| **Status** | **Proposed** |
| **Date** | 2026-08-24 |
| **Decision owner** | Joe S. — product owner |
| **Decision gate** | `DG-2` — technology. **Unresolved.** This ADR contributes to the technology-decision work; it does not close the gate |
| **Related open questions** | **Carried as shaping inputs, not blockers:** `NOQ-1`, `NOQ-4` (`PA-1`). **Must NOT answer:** `NOQ-9`, `OQ-4`, `OQ-9`, `OQ-14` / `NOQ-8`, `NOQ-5`, `NOQ-6`, `DDM-1`–`DDM-10`, `DU-1`, `DA-8` — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **Proposed, and therefore NOT in force.** Per `docs/adr/README.md`, a `Proposed` ADR is *"Drafted and under review. The decision is **not yet in force**; nothing may depend on it."* The product owner has made the technology **selection** recorded below, and this document records that selection for review. It is **not** `Accepted`. **`DD-2` is not discharged**, **`DG-2` remains Unresolved**, `ADR-005` remains open, and **no implementation is authorized.**

---

## Context

`docs/07-system-architecture.md` defers the application technology as **`DD-2`** — *"Language and application framework… Must satisfy hard requirements 1, 2, and 6."* `DD-2` is the last undischarged deferred decision standing between the architecture and the `P0b` scaffold: `docs/12-implementation-plan.md` records that the repository scaffold and project structure, and the continuous-integration pipeline and its test tooling, are each **blocked on `ADR-002`**, and `docs/adr/README.md` records that **`ADR-012` "cannot be written in full until `ADR-002` lands."**

**Nothing was blocking the decision.** `ADR-002`'s register entry names **no open question**: hard requirements 1, 2 and 6 together with `DD-2` are stated *inputs*, not blockers. Its only associated questions — **`NOQ-1`** (performance thresholds) and **`NOQ-4`** (expected first-release load) — are classified independently in `docs/07`, `docs/12` and `docs/13` as **shaping inputs that inform technology selection and do not block it**, and are carried as the stated assumption **`PA-1`** ("the directory is small at first release"). No threshold is asserted anywhere, and none may be invented (`docs/11`, Category 3).

**Four Accepted ADRs constrain the choice and are not reopened here.** `ADR-001` fixed a modular monolith with a **server-enforced public/administrative boundary**, rejecting microservices and browser-direct data access. `ADR-003` fixed **PostgreSQL under a managed operating posture**, discharging `DD-3` while deferring the named provider. `ADR-006` fixed the listing model, its lifecycle states, the revision entity **`E7`**, and invariants `DI-1`–`DI-11`. `ADR-010` fixed a **single-instance availability posture** with stateless instances and a defined recovery capability.

**The decision is needed now because it is the maximum unblocker** — and because `docs/07` warns that a stack chosen late is chosen hastily. **It does not resolve `DG-2`.** `DG-2` also requires `ADR-005`, and the repository carries an unresolved ambiguity about `DG-2`'s exact closure scope. Writing this ADR opens no gate; `docs/adr/README.md` records precisely that of Accepted `ADR-003`.

This decision answers to hard requirements 1, 2 and 6 (`docs/07`, *Technology-selection criteria*), and inherits hard requirements 3, 4 and 5 as live disqualifiers through `C9` and risk `R-10`. It serves `NFR-ACC-01/02`, `NFR-COMP-03/04`, `NFR-SEC-01/02/05/08`, `NFR-DATA-01/03`, `NFR-MAINT-03`, `NFR-OPS-01/04`, and journeys `V1`–`V4`, `L2`, `A3`–`A7`.

## Decision

**We will adopt TypeScript as the application language and Next.js as the application and server framework for the Community Directory Platform MVP.**

**This decision is specific to the Community Directory Platform. It is not a universal technology policy, and subsequent projects may decide differently.**

### Selected

| | |
|---|---|
| **Application language** | **TypeScript** |
| **Application / server framework** | **Next.js** |

### Framework and runtime consequences

Next.js's server mode runs on a **Node.js runtime**. This is an unavoidable consequence of the framework, **not** an independently taken decision, and **it is not an `ADR-005` decision**: the hosting platform, deployment model, and runtime topology remain entirely open under `DD-5`. **No Node.js major version is selected here.** **No Next.js version is selected here** — version choice is downstream.

### Intrinsic consequences under ruling R-B

The product owner ruled (**R-B**) that this ADR may record frontend and routing consequences that are **intrinsic and inseparable** from the selected framework, and that it acquires **no general authority** over separable frontend decisions. Accordingly, and only this far:

| Intrinsic consequence | Why it is inseparable |
|---|---|
| **React** as the component and rendering model | Next.js's server rendering is React Server Components; the framework cannot be adopted without it |
| **A Next.js routing model** | File-system routing is the framework's structure; there is no Next.js without a Next.js router |
| **The `next build` build and bundling pipeline** | Part of the framework, not a separable selection |
| **A Node.js runtime** for server mode | As above |

### Default but replaceable — not settled here

**The App Router is the framework's current default direction and the expected starting point, and it is recorded here as a default-but-replaceable direction only.** Next.js provides both the App Router and the Pages Router. **R-B does not make the choice between them intrinsic**, and this ADR does **not** settle it as an independent architecture decision. The same applies to the per-route rendering posture and to where the client/server component boundary is drawn in this application: the *mechanism* is intrinsic, the *placement* is design work governed by the obligations below.

### Explicitly not selected

This ADR selects **no** ORM, data-access library, query builder, PostgreSQL client, or migration tool (**ruling R-A**); **no** hosting platform, cloud, container service, deployment platform, or CDN — **Vercel is not selected**; **no** authentication mechanism; **no** test framework or runner; **no** continuous-integration system; **no** named PostgreSQL provider; **no** physical schema or index; **no** build or package tooling beyond the framework's own pipeline; and **no** separable frontend technology — **Tailwind is not selected**, nor is any component library, CSS framework, icon set, or form library.

## Rationale

**TypeScript + Next.js was not the architecture-only leader of the governed comparison, and this document does not pretend otherwise.**

Six candidates were compared under identical hard filters, criteria, weighting classifications, and evidence standards, using current primary sources. The sequence, recorded so it cannot be rewritten later as though the outcome were predetermined:

1. An initial longlist of thirteen was reduced to four — Python + Django, C# + ASP.NET Core Razor Pages, Ruby + Rails, PHP + Laravel. **Next.js was excluded at that stage** on hard requirement 1 and risk `R-10`. The initial recommendation was **Python + Django**.
2. On the product owner's input, Next.js was re-examined against current official documentation and **passed every hard filter**. It was admitted as a candidate. The recommendation remained **Python + Django**.
3. Java + Spring Boot was then restored to the shortlist — its earlier exclusion had been comparative rather than requirements-derived and did not survive the stated exclusion rules — and, once the owner's extensive historical Java/Spring experience was weighed under the High-weight developer-productivity criterion, it became the **delivery-aware recommendation**.
4. **The product owner selected TypeScript + Next.js.**

**The judgment actually made:**

- **TypeScript + Next.js satisfied every repository-derived hard filter.** Familiarity and productivity became material **only after** that threshold was met. They did not substitute for a requirements comparison, and they could not have rescued a hard-filter failure.
- **Python + Django was the architecture-only leader** — chiefly because its default project template ships CSRF protection, template autoescaping, clickjacking protection and host-header validation together, which is the strongest available answer to the Highest-weighted "security posture out of the box" criterion. It was **consciously not selected**.
- **Java + Spring Boot** was strong on nine criteria, has the longest runtime support horizon of any candidate, and enables CSRF protection by default. It is **not selected** because **the owner has not actively used Java/Spring for more than three years and does not want to return to that stack for this project.** Developer familiarity is a proxy for *present-day delivery risk*, not for career totals; experience three years dormant does not carry the same productivity as experience recently exercised.
- **The owner had a positive practical experience with TypeScript + Next.js** in the earlier Community Directory mini prototype. That is **legitimate familiarity and productivity evidence**. It is **not architectural precedent**: `docs/07` `C-5` records the mini lab as a frozen learning prototype, lists *"It was used in the mini lab"* among the reasons that must **not** decide, and rejected the prototype's **shape** on the requirements (`R-10`). This decision is **not** "the prototype used Next.js, therefore Next.js was selected."
- **A deliberate project goal is to develop current, reusable competence** in a stack the owner can use to build future projects more efficiently. `docs/01-vision.md` frames this project as a return to development after a break, and `docs/07` states that *"a stack the developer can be productive in **is** a delivery requirement."* For this MVP, developer productivity legitimately includes the strategic value of building current competence — not only of drawing on existing expertise. This is **not** future organizational standardization, which is neither claimed nor implied.
- **Full-stack TypeScript offers real productivity benefits** for a single maintainer: one primary language across server and delivery concerns, and shared types where genuinely appropriate.
- **The known framework weaknesses are accepted**, with the explicit compensating obligations recorded below. They are obligations, not disclaimers.

**Next.js was not objectively best on every criterion, and this ADR does not claim it was.** It rated *Moderate* where alternatives rated *Strong* on both Highest-weighted criteria. The selection trades some framework-provided assurance for present-day delivery capability and reusable competence, and accepts the duty to supply by discipline what the framework does not supply by default.

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Python + Django** | **Not rejected on the requirements — it was the architecture-only leader.** Its default project template ships CSRF, autoescaping, clickjacking protection and host validation simultaneously; verified in Django's own project template source. Django 5.2 LTS carries extended support to April 2028. It was **consciously not selected** because the owner has no current familiarity with it and the reusable-competence goal favoured the selection. This rejection is the one most likely to be revisited if the compensating obligations below prove burdensome. |
| **Java + Spring Boot** | **Not rejected on capability.** Strong on nine criteria; Spring Security *"protects against CSRF attacks by default… no additional code is necessary"*; package and module boundaries plus static typing give compile-time enforcement of `ADR-001`'s inward dependency rule; Java LTS support runs to at least December 2029 (Java 21) and September 2031 (Java 25). It carries the heaviest operational weight of the shortlist — JVM footprint, tuning, and a costlier hosting class at `PA-1` scale — against the Highest-weighted operational-simplicity criterion. **Decisively:** the owner's substantial Java/Spring expertise is **more than three years dormant**, so it does not represent present-day delivery familiarity, and the owner does not wish to return to that stack for this project. |
| **C# + ASP.NET Core Razor Pages** | **Not rejected on capability.** It offers the only formally dated framework support contract of any candidate — .NET 10 is LTS to **2028-11-14**, on a predictable annual November cycle — plus antiforgery and HTML encoding on by default, and static typing with assembly boundaries that enforce `C9` as the sole data-access path at compile time. It supplies the least pre-built application surface of the shortlist, requiring the most scaffolding from a single maintainer, and offers no familiarity advantage. |
| **PHP + Laravel** | **Not rejected on capability.** Widest hosting portability of any candidate, including commodity hosting — the strongest hedge while `ADR-005` is open — with origin-aware request-forgery protection in the current release. Its 18-month bug-fix window and the coupling of framework majors to PHP version floors (Laravel 13 requires PHP 8.3–8.5) impose a recurring upgrade rhythm, and it offers no familiarity advantage. |
| **Ruby + Rails** | **Not rejected on capability.** The most opinionated end-to-end path, imposing the fewest decisions on a solo maintainer, with CSRF on by default and three security headers shipped. **Decisively:** the shortest support window of the shortlist — one year of bug fixes and two years of security fixes per minor series — which taxes the resource `docs/07` names scarcest, maintainer attention. |
| **Python + FastAPI** | **Rejected on hard requirement 1.** It is an API framework; server-rendered HTML with progressive enhancement is not its idiom. |
| **TypeScript + Express** | **Rejected on the Highest-weighted security-defaults criterion.** Unopinionated, so authorization, validation and request security would be hand-assembled — the opposite of `docs/07`'s "defaults become the system" reasoning. |
| **Elixir + Phoenix, Java/Kotlin + Spring MVC variants, Go, Rust + Axum, PHP + Symfony, Python + Flask** | Considered and set aside as contributing no materially distinct tradeoff **against this repository's stated weights**, or as dominated by a shortlisted candidate. Phoenix is the notable case: it passes every hard filter, but its distinguishing strength is concurrency and throughput — the two criteria `docs/07` weights **Low** and explicitly declares *"not a tiebreaker."* |

## Consequences

**Positive:**

- **One primary language across the relevant application and server concerns**, reducing context switching for a single maintainer, with shared types where genuinely appropriate.
- **Server rendering by default.** Layouts and pages are Server Components by default, which keeps the public surface server-rendered as hard requirement 1 requires. **Progressive enhancement is a narrower claim, and is stated here only as far as the evidence goes:** the official documentation records progressive enhancement explicitly for **argument binding** on Server Actions (`bind` "supports progressive enhancement"), while the Server Actions guide otherwise describes dispatch through a client dispatcher. **Journey-level progressive enhancement is therefore an obligation of design, not a property inherited from the framework** — see the accessibility consequence below.
- **Strong secret isolation.** Environment variables are server-only unless explicitly prefixed for client exposure, and a build-time guard exists to prevent server-only modules being imported into client code — directly serving `NFR-SEC-08` and hard requirement 4.
- **A mature, PostgreSQL-capable ecosystem** — parameterized queries, explicit transaction control, connection pooling, and database-backed integration testing are all well established. **This is viability evidence only; no persistence technology is selected.**
- **Reasonable deployment portability** when provider-specific features are avoided: self-hosting is officially supported as a Node.js server, a Docker image, or a static export, and does not require any particular provider.
- **A published support policy exists.** Next.js documents an Active LTS and a Maintenance LTS phase, with *"Each major version… remain[ing] in Maintenance LTS for two years following the initial release."* A formal, pre-announced security release programme is also published.
- **Reusable competence.** The stack is one the owner intends to keep using, so effort spent here compounds rather than being spent once.
- **`ADR-005` remains genuinely open** — both long-running and container deployment shapes stay viable.

**Negative:**

- **The server/client boundary is enforced by convention plus tooling, not by structure.** Directives and a build-time guard make it real and checkable, but server and client code share a module graph — a boundary a developer can erode by accident in a way that is not possible in the alternatives. This matters because `R-6` names the administrative surface as the likeliest place for a security mistake.
- **Request-security defaults are narrower in scope than the alternatives', though they are not absent.** Next.js documents framework-level protections **for the Server Actions flow**: an **origin-based CSRF check** in which the request's `Origin` is compared to the `Host` (or `X-Forwarded-Host`) and **mismatches are rejected**, plus a default body-size limit, encrypted action IDs with dead-code elimination, and closure-variable encryption. **This is an origin comparison, not a token-based CSRF mechanism, and it is documented for Server Actions — not asserted here for every Route Handler or other request surface an application may add.** The five alternatives each ship an explicit, developer-visible CSRF mechanism enabled by default across their request surface. The official documentation is also explicit that *"Framework protections are not a substitute for application-level checks"* and that a Server Action *"is reachable to anyone who can send the same POST"*. **Request security across the application's own entry points therefore still has to be addressed deliberately.**
- **No first-party validation layer.** Server-side validation at `C7` is a design obligation rather than a framework default.
- **No first-party test harness.** The alternatives ship an official harness with automatic test-database lifecycle or an in-memory HTTP test host; here it is assembled.
- **The weakest modular-monolith fit of the candidates compared.** The framework organises code by route, which is orthogonal to the `C1`–`C12` seams, and nothing enforces `ADR-001`'s inward dependency rule. **Domain logic can drift toward the UI** because co-location is convenient.
- **Tighter coupling between the server framework and delivery concerns** than any alternative, and the only candidate carrying an intrinsic frontend and routing consequence.
- **Redundancy later is more involved.** The page and data cache defaults to per-instance local storage, and multi-instance operation additionally requires a shared Server Actions encryption key, a custom cache handler with tag coordination, and a deployment identifier for version-skew protection. Under `ADR-010`'s accepted single-instance posture none of this is triggered today, but `ADR-010` values statelessness precisely so that redundancy stays an **operational** change; here it would be a larger one.
- **Some near-term learning cost remains.** Prior exposure was a prototype, not production work, and building current competence is part of the goal rather than a completed state.
- **Accessibility needs deliberate design.** The rendering model supports semantic HTML and progressive enhancement, but the framework's documented pattern for displaying validation errors is oriented toward client-side state, which must be designed against `NFR-ACC-01/02` rather than adopted by default.

**Reversibility:** **Expensive in both cases, bounded in only one of them. The two reversals this ADR could face do not have the same cost or the same boundary, and must not be conflated.** **(A) Replacing Next.js while retaining TypeScript and the application/domain architecture** is the bounded case. Framework-specific UI, routing and delivery code — routes, rendering, request handling, the build pipeline — would still require full replacement. What survives is the domain: if domain and application logic are kept in plain TypeScript modules behind the `C1`–`C12` seams, with `C9` the sole data-access path, then the domain, its tests, the PostgreSQL data model, and the Accepted ADRs are untouched. Keeping business logic independent of React and Next.js delivery mechanisms is what makes this replacement materially easier. **(B) Reversing the broader `ADR-002` decision — replacing TypeScript itself — is a materially broader migration**, because the domain modules that survive case (A) are themselves TypeScript and would have to be rewritten in the new language. Only the PostgreSQL data model and the Accepted ADRs survive unchanged. **Neither case is cheap, and neither is guaranteed.** In both, the bound depends on the discipline this ADR requires: **if domain or application logic becomes embedded in Next.js or React constructs, the claimed reversibility weakens substantially, and case (A) degrades toward the cost of case (B).** That is the single strongest practical argument for treating **O-8**, **O-9** and **O-11** — and the obligations below generally — as binding rather than advisory.

## Compensating architectural obligations

**These obligations are the condition on which the accepted tradeoffs rest. They are not commentary, and implementation may not treat them as optional.** They state *what must hold*; they select **no** library, tool, or mechanism.

| # | Obligation |
|---|---|
| **O-1** | **All PostgreSQL access is server-side.** `C9` remains the single data-access path and owns transactions, so a create, edit, or moderation action completes fully or has no effect (`NFR-DATA-03`). |
| **O-2** | **Browser-direct datastore access is prohibited.** No client holds a datastore credential and no public route reaches the store (`NFR-SEC-08`, hard requirement 4). Risk `R-10` is restated: a managed datastore is a hosting decision; browser-direct access is an architecture decision, and `ADR-001` settled it. |
| **O-3** | **Authorization is enforced server-side on every request** at `C8`. The framework distributes this obligation across each server entry point, so it must be met systematically rather than assumed from where a component is rendered. |
| **O-4** | **UI visibility is never authorization.** Hiding a control, omitting a link, or guarding a client route is not access control (`docs/09`, `docs/10`). |
| **O-5** | **Validation is deliberate and server-side where authoritative.** Client-side checks are a convenience only; the authoritative check is at `C7` (`docs/07`). |
| **O-6** | **Request security is deliberately reviewed and addressed** for every state-changing entry point. The framework's documented origin-based check covers the Server Actions flow only, and its own documentation states that framework protections are not a substitute for application-level checks — so coverage is established per entry point rather than assumed. |
| **O-7** | **Secrets remain server-only.** No credential, key, or connection string reaches the client bundle. |
| **O-8** | **Domain and application logic is not scattered** across React components, Server Components, Server Actions, or Route Handlers merely because co-location is convenient. It lives in plain modules behind the `C1`–`C12` seams. |
| **O-9** | **Dependency direction remains explicit and inward** — interface → domain → data access (`docs/07`) — and is not inverted by framework convenience. |
| **O-10** | **Architecture and security tests compensate where framework convention is softer than structural enforcement**, with the `TB-3` administrative boundary as the highest-value target (`NFR-MAINT-03`, `R-6`). |
| **O-11** | **Business logic is testable independently of browser rendering** — in-process, without a browser and without a deployed environment (hard requirement 6). |
| **O-12** | **Deployment discipline stays provider-neutral until `ADR-005`.** Provider-specific or multi-instance-coordination capabilities are not adopted merely because they are convenient; adopting them early would narrow `ADR-005` by default rather than by decision. |

## Compatibility with Accepted ADRs

**This ADR reopens none of the following, and is subordinate to all of them.**

| Accepted ADR | Obligation this ADR accepts |
|---|---|
| **`ADR-001`** — modular monolith, server-enforced boundary | Next.js is adopted **inside** the accepted architecture and **does not replace it**. `C1`–`C12` remain in-process seams within one deployable artifact; the public/administrative boundary is enforced server-side at `C8` on every request; microservices and browser-direct data access remain rejected. The framework does not enforce these structurally, which is precisely why obligations **O-8**, **O-9** and **O-10** exist. |
| **`ADR-003`** — PostgreSQL, managed posture | The application integrates with **PostgreSQL under a managed operating posture**. The **named provider remains deferred** (`DDM-1`). The ecosystem's PostgreSQL maturity was **evidence of viability only**; under **R-A** no ORM, client, query builder, or migration tool is selected. |
| **`ADR-006`** — listing model and lifecycle | The stack must express the single-entity listing model, the three-value status set, publication state, the revision entity **`E7`**, the retention and purge obligations, and invariants `DI-1`–`DI-11` — notably `DI-10` (a pending proposal is reachable by no public path) and `DI-11` (at most one pending proposal), together with the atomic apply-on-approval of `FR-ADM-10b`. The model is logical; physical representation remains `DDM-1`–`DDM-10`. |
| **`ADR-010`** — availability and recovery posture | The application runs **stateless** under a **single-instance** posture, holding no sticky in-process state that would make redundancy a redesign. The negative consequence recorded above — per-instance cache and multi-instance coordination — is the honest qualification on that, and obligation **O-12** is its response. |

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`PA-1`** — the directory is small at first release (`NOQ-1`, `NOQ-4` unanswered) | The Low weighting of performance and elastic scalability was correct for this comparison. If load is materially larger, this is the first decision to revisit, together with `DD-12`, `ADR-007` and the indexing strategy. |
| The compensating obligations **O-1**–**O-12** are actually upheld | The principal justification for accepting a framework rated *Moderate* on both Highest-weighted criteria disappears, and with it much of the bounded reversibility recorded above. This ADR would then warrant revisiting against Python + Django, the architecture-only leader. |
| Current familiarity with TypeScript and Next.js translates into delivery speed on production-quality work | The productivity argument that decided the selection weakens, and the near-term learning cost recorded above grows. The competence-building goal remains valid but is no longer a delivery *advantage*. |
| The published two-year Maintenance LTS policy continues to be honoured in practice | Long-term maintenance planning for a system intended to run for years by a small team becomes less predictable, and `NFR-MAINT-02/05` are harder to satisfy. |
| A single maintainer can uphold a convention-and-tooling boundary as reliably as a structural one | `R-6` — the administrative surface being the likeliest place for a security mistake — becomes materially more likely, and **O-10**'s architecture and security tests become the last line of defence rather than a supplement. |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **The server/client boundary erodes.** Server-only logic or a secret reaches client code through a shared module graph | A credential or non-public submission data is exposed; `NFR-SEC-08` and `NFR-PRIV-01/02` are breached | **O-2**, **O-7**; use of the build-time server-only guard; **O-10** boundary tests. The framework's build-time error is a real control and must be relied on deliberately, not incidentally |
| **Authorization is missed at one server entry point.** The obligation is distributed across every server action and route handler rather than centralized | The `TB-3` administrative boundary is bypassed at a single unguarded point — `R-6` realized | **O-3**, and **O-10** tests treating the administrative boundary as the highest-value target. A systematic, enumerable pattern for entry points is required |
| **Request-security handling is uneven across entry points**, because the documented framework check covers the Server Actions flow rather than every request surface the application may add | A state-changing entry point outside that coverage is exploitable cross-origin | **O-6** — deliberate review of every state-changing entry point, recorded rather than assumed; the framework's own documentation states its protections are not a substitute for application-level checks |
| **Domain logic leaks into React components, Server Components, Server Actions, or Route Handlers** | The `C1`–`C12` seams dissolve; `ADR-001` is eroded in practice while nominally intact; **reversibility is lost** | **O-8**, **O-9**, **O-11**, enforced by **O-10** |
| **`ADR-005` is narrowed by default** through early adoption of provider-specific or multi-instance-coordination capabilities | The hosting decision is pre-empted by convenience rather than taken deliberately | **O-12**. The specific capabilities to avoid are named in the negative consequences above |
| **Validation is inconsistent** across the public write path and the administrative surface | `FR-VAL-*` and the `S-1` obligation set are unevenly enforced; `OQ-8`/`OQ-8b` outcomes are not reliably honoured | **O-5**, with the authoritative check at `C7` and the contact-method minimum enforced at the `P4` approval step |
| **Accessibility regresses** where the validation-error pattern favours client-side state | `NFR-ACC-01/02` and `NFR-COMP-03/04` are breached on the public submission journey | Design the submission and error paths to function without client scripting; the accessibility behaviours `UA-1`–`UA-6` are built and tested from the first screen regardless of `NOQ-5` |
| **Lifecycle assumption proves optimistic** despite the published policy | Upgrade pressure arrives sooner than planned for a single maintainer | Track the Active and Maintenance LTS phases and the published security-release programme; revisit at `DD-12` if maintenance cost exceeds the `PA-1` assumption |

## `DG-2` boundary

**This ADR does not close `DG-2`, and acceptance of it would not close `DG-2`.**

`docs/13-decision-log.md` records the technology stack as an **Unresolved** hard blocker, and `docs/traceability-matrix.md` records it as spanning `ADR-002`–`ADR-005`. **`ADR-005` — the hosting platform and runtime model — remains outstanding.** The repository additionally carries an **unresolved ambiguity about `DG-2`'s exact closure scope**, with competing readings concerning `ADR-004`'s gate, `ADR-012`'s `DG-2`/`DG-4` split, and CI's classification. **This ADR resolves none of them, by design.** `P0b` and `P1`–`P5` remain blocked.

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **ORM / data-access technology** (**ruling R-A**) | No ORM, data-access library, query builder, PostgreSQL client, or migration tool is named or implied. Ecosystem maturity was cited as **evidence of viability only**. The framework bundles no data layer, so nothing is adopted by default |
| **`DD-5` / `ADR-005`** — hosting platform and runtime model | Only the framework's Node.js runtime requirement is recorded, as a consequence. No provider, cloud, container service, deployment platform, or CDN is chosen. **Vercel is not selected**; prior deployment exposure to it is familiarity evidence only. Obligation **O-12** exists to keep the decision open |
| **`DDM-1`** — named PostgreSQL service and vendor | Untouched; the provider remains deferred by owner ruling, and `ADR-010`'s provider-capability validation remains outstanding |
| **`DDM-2`–`DDM-10`** — physical schema, indexes, text-search strategy | No schema, column, type, constraint, or index is named |
| **`DD-4` / `NOQ-9` / `ADR-004`** — administrator authentication | The **boundary** is settled by `ADR-001` and honoured by **O-3**; the **mechanism**, credential policy, and identity store are not chosen |
| **`ADR-012`** — testing strategy and tooling | Testability was assessed as evidence against hard requirement 6 only. No test framework, runner, or automation tool is selected, and the `DG-2`/`DG-4` split is untouched |
| **Continuous integration** | No CI system is selected. Its gate classification remains ambiguous and is not resolved here |
| **`DU-1` / `DA-8`** — separable frontend technologies | Under **R-B**, only the **intrinsic** consequences are recorded — React, a Next.js routing model, the build pipeline, the runtime. **App Router versus Pages Router is recorded as default-but-replaceable, not as a settled decision.** Component library, CSS framework, icon set, form library, and other separable frontend tooling **remain unowned and deferred**; **Tailwind is not selected**. This ADR does not become the general owner of `DU-1` or `DA-8` |
| **Build and package tooling** | Beyond the framework's own build pipeline, no build system or package tooling is selected; no governed document assigns ownership of it |
| **`OQ-4` / `ADR-007`** — searchable fields and search approach | No search mechanism or index is chosen; a dedicated index still requires *measured* justification |
| **`OQ-9` / `ADR-008`** — anti-spam | No mechanism is chosen; the `C11` seam is unaffected |
| **`OQ-14` + `NOQ-8` / `ADR-009`** — audit logging | No audit approach is chosen. The stack's capability to emit at `C10` was noted as capability only |
| **`NOQ-5`, `NOQ-6` / `ADR-011`** — accessibility standard and support matrix | No conformance level or matrix is claimed; the accessibility *behaviours* are obligations regardless |
| **`NOQ-1`, `NOQ-4`** — thresholds and load | Carried as `PA-1`. **No threshold is asserted, and none is invented** |
| **`DG-2` closure scope, and K-3** | Untouched. The competing readings, and the circular statement at `docs/12-implementation-plan.md:225`, remain as they are, pending a separate owner ruling |

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-ACC-01`, `NFR-ACC-02`; `NFR-COMP-03`, `NFR-COMP-04`; `NFR-SEC-01`, `NFR-SEC-02`, `NFR-SEC-05`, `NFR-SEC-08`; `NFR-DATA-01`, `NFR-DATA-03`; `NFR-MAINT-02`, `NFR-MAINT-03`, `NFR-MAINT-05`; `NFR-OPS-01`, `NFR-OPS-04`; `NFR-PRIV-01`, `NFR-PRIV-02`; `FR-VAL-01`–`FR-VAL-06`; `FR-ADM-10b` |
| **Journeys** | `V1`–`V4` (browse, search, filter); `L2` (submission); `A3`–`A7` (administrative review and moderation) |
| **Components** | `C1`–`C12` as in-process seams; `C7` (validation); `C8` (administrative boundary); `C9` (sole data-access path, owns transactions); `C10` (audit emission — conditional, not decided here) |
| **Invariants** | Must not breach: `BI-1`, `BI-3`, `BI-6`, `BI-8`; `DI-1`–`DI-11`, in particular `DI-10` and `DI-11` |
| **Decisions** | `DD-2` — **NOT discharged**; this ADR is `Proposed`, not in force. `DG-2` — **Unresolved**. Hard requirements 1, 2, 6 (and 3, 4, 5 inherited via `C9` and `R-10`). `NOQ-1`, `NOQ-4` carried as `PA-1`. Owner rulings **R-A** (ORM/data-access outside this ADR) and **R-B** (inseparable frontend/router consequences only) |
| **Related ADRs** | `ADR-001` (Accepted — the boundary and `R-10`; not reopened); `ADR-003` (Accepted — PostgreSQL under a managed posture; not reopened); `ADR-006` (Accepted — the model this stack must express; not reopened); `ADR-010` (Accepted — the availability and recovery posture; not reopened); `ADR-004`, `ADR-005`, `ADR-007`, `ADR-008`, `ADR-009`, `ADR-011`, `ADR-012` (open, and not decided here) |
| **Documents amended** | `docs/adr/README.md` and `docs/traceability-matrix.md` — the `Proposed` lifecycle status only. **`DD-2` is not marked discharged and `DG-2` is not marked Resolved**, because this ADR is not `Accepted` and is not in force |
| **Issue / pull request** | Issue #85 — `architecture: decide the MVP application language and framework in ADR-002`. Pull request — **to be assigned** |

### Sources consulted

External claims in this ADR rest on current primary sources, accessed **2026-08-24**. Version- and date-sensitive facts will drift.

| Source | Supports |
|---|---|
| Next.js — Support Policy (`nextjs.org/support-policy`) | Active LTS and Maintenance LTS phases; *"Each major version will remain in Maintenance LTS for two years following the initial release"*; 16.x Active LTS (released 2025-10-21), 15.x Maintenance LTS (released 2024-10-21) |
| Next.js — Security release programme (`nextjs.org/blog/next-security-release-program`) | A formal, pre-announced monthly security-release programme, with ad-hoc patches for urgent disclosures |
| Next.js — Server and Client Components; Forms; Server Actions and Mutations; Self-hosting (official docs) | Server Components by default; the `'use client'` module-graph boundary; server-only environment variables and the server-only import guard; **progressive enhancement stated for `bind` argument binding specifically — the documentation makes no journey-level progressive-enhancement claim**; **framework-level Server Actions protections — origin-versus-`Host`/`X-Forwarded-Host` CSRF check with mismatches rejected, body-size limit, encrypted action IDs, closure encryption — together with the statement that these "are not a substitute for application-level checks"**; self-hosting as a Node.js server, Docker image, or static export; per-instance cache and multi-instance coordination requirements |
| Django — download page, databases reference, security topic guide, project template source | Comparison evidence for the architecture-only leader |
| Microsoft — .NET support policy; Razor Pages overview | .NET 10 LTS to 2028-11-14; antiforgery and HTML encoding defaults |
| Spring — Spring Boot project page; Spring Security CSRF reference; Eclipse Adoptium support page | Spring Security CSRF enabled by default; Java LTS horizons |
| Rails — maintenance policy, security guide; Laravel — release notes | Support windows and security defaults for the remaining alternatives |
