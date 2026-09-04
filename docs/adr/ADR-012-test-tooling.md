# `ADR-012` — Adopt Vitest as the MVP's primary implementation-level test runner, beginning with `P1` Slice A, and defer every other testing layer and all release-depth policy

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Date** | 2026-09-04 |
| **Decision owner** | Joe S. — product owner |
| **Decision gate** | **None for the test-tooling portion decided here** — it carries no unresolved gate. Its one prerequisite, `ADR-002`, is **`Accepted`** and supplies the stack this tooling must serve. **`DG-2` was already `Resolved` 2026-08-27 (issue #93) before this ADR existed**; this ADR is **not** a `DG-2` constituent, does **not** reopen or complete `DG-2`, and opens no gate. **Testing *depth* remains governed by `DG-4`, which is `Unresolved` and is not resolved by this decision.** |
| **Related open questions** | **Depends on:** nothing unresolved — `ADR-002` (Accepted) fixes the language and framework this tooling must serve. **Must NOT answer:** `NOQ-5`, `NOQ-7`, testing **depth** (`DG-4`), `OQ-4` (`ADR-007`), `NOQ-9` (`ADR-004`, `DG-3`), `DDM-1`–`DDM-10` — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **Accepted, and therefore in force.** Per `docs/adr/README.md`, an `Accepted` ADR is *"Decided and **in force**. Work may rely on it."* The product owner accepted this decision on **2026-09-04**, following the `Proposed`-stage publication of **2026-09-03** recorded on issue #105 and merged by **PR #106**, and the separate governed acceptance step recorded on **issue #107** — the `ADR-005` and `ADR-013` `Proposed` → `Accepted` precedent (issue #101 / PR #102, then issue #103 / PR #104). **Later implementation may rely on the selected runner.** But acceptance is **not installation**: no dependency is installed, no `package.json` or `package-lock.json` change is made, no test script, configuration, or test file is created, no CI change is made, and **`P1` Slice A is not authorized to begin** — it remains a separate later work unit with its own commissioning and implementation authorization.

---

## Context

**The repository cannot currently complete any implementation issue.** `CONTRIBUTING.md`'s Definition of Done requires that **"Its tests are merged with it"** (#2, `IP-6`) and that **"Every invariant it touches is proven by an attacking test"** (#3). `docs/12`'s `P1` exit criteria require that **`DI-1`–`DI-11` are proven**. But `package.json` declares only `dev`, `build`, `start` and `typecheck`, and carries **no test runner and no direct test dependency**.

**The gap was deliberate, and it was recorded as deliberate.** `.github/workflows/ci.yml` states in its own header that the pipeline *"deliberately runs no tests: test-tooling selection is `ADR-012`'s tooling half and testing depth is `DG-4`, both separately governed. A placeholder suite would claim testing that does not exist, so none is added here."* `docs/11-test-strategy.md` was written to match, and **as at 2026-09-03** it *"selects no testing framework, browser-automation tool, test runner, assertion library, mocking library, CI system, cloud service, or hosting"*, and records that *"No automation tool, runner, or framework is selected. What must be checked is the strategy; how is a later decision."*

**Why the decision is taken now.** `P0b` is complete — the scaffold (PR #96), the CI pipeline (PR #98) and the required build gate (PR #100) — and `P1` is gate-clear (`DG-1` `Resolved` 2026-08-04, `DG-2` `Resolved` 2026-08-27). The next work is **`P1` Slice A**, the logical/domain data foundation. Slice A cannot reach Definition of Done without an executable test suite, and **installing a runner inside an implementation pull request would answer this question invisibly** — the failure `docs/adr/README.md` names as *"An ADR must not answer an open question implicitly"* and which Definition of Done #6 forbids outright.

**What `ADR-012` was always for, and what this ADR does with it.** `docs/07` claims `ADR-012` for *"Testing strategy — with the `TB-3` administrative boundary as its highest-value target"* against `NFR-MAINT-03` and `R-6`. **As a matter of historical planning classification** — and *only* as that — `docs/adr/README.md` associated its **tooling** with `DG-2` and its **depth** with `DG-4`, and recorded that it *"cannot be written in full until `ADR-002` lands"*. **Current governance status is different, and is what governs.** `ADR-002` **landed on 2026-08-25**, so the **test-tooling portion became independently writable**. **`DG-2` was subsequently `Resolved` on 2026-08-27 (issue #93) for its own already-established constituents, and `ADR-012` is not one of them** — the owner ruling of 2026-08-26 (issue #87) had said so expressly. **This ADR therefore decides only the test-tooling portion, prospectively, and it decides no part of a gate.** The **depth** question remains untouched under the still-unresolved `DG-4`.

**The obligations this tooling must serve.** `ADR-002`'s binding obligations **`O-10`** — *architecture and security tests compensate where framework convention is softer than structural enforcement, with the `TB-3` administrative boundary as the highest-value target* — and **`O-11`** — *business logic is testable in-process, without a browser and without a deployed environment*. `docs/11`'s *Automation candidates* rates `BI-1`–`BI-9` and `DI-1`–`DI-11` **Highest** priority, the latter *"purely mechanical; no judgment required."*

## Decision

**We will use Vitest as the MVP's primary implementation-level test runner, beginning with `P1` Slice A.**

**One primary implementation-level runner, not one per slice.** The project adopts a single implementation-level runner posture rather than allowing a different primary runner to be selected silently by each implementation slice.

**This decision is specific to the Community Directory Platform. It is not a universal testing policy, and subsequent projects may decide differently.**

### Within scope

| | |
|---|---|
| **Primary implementation-level test runner** | **Vitest** |
| **Assertions** | Vitest's **native** assertion capability **may serve** the implementation-level suite; no separate assertion library is required by this decision |
| **Mocking / stubbing / spying** | Vitest's **native** capability **may be used where a test actually needs it**. This is a permitted capability, **not a mandated technique** — Slice A is deterministic domain logic with no I/O and is expected to need none |
| **TypeScript** | Test sources are TypeScript, run by the selected runner **without a separately configured TypeScript transform step**. **Type *checking* remains `next build`'s job**, which `.github/workflows/ci.yml` already consumes; this ADR adds no second type-validation mechanism. **This does not extend to the repository's `tsconfig` path alias**: current official evidence records that Vite-based resolution does **not** consume `tsconfig` path mappings automatically, so **repository alias resolution must be reconciled during implementation**. **This ADR selects no alias mechanism and no plugin** |

### Explicitly not selected

This ADR selects **no** Vitest package version; **no** installation, and it performs none; **no** `package.json` or `package-lock.json` change; **no** test script name; **no** configuration file, format, or filename; **no** test-file naming suffix or directory layout beyond whatever repository governance already mandates; **no** coverage provider and **no** coverage threshold; **no** DOM simulator; **no** React or component-testing library; **no** browser or end-to-end tool; **no** accessibility-testing tool; **no** database or integration-test infrastructure; **no** provider-integration testing; **no** recovery or restore-rehearsal tooling; **no** `DG-4` release-depth policy or release-approval criterion; **no** CI change and **no** new required check; **no** persistence technology — no ORM, PostgreSQL driver, query builder, connection pooler or migration framework; **no** physical schema; **no** `DDM-*`; **no** DigitalOcean provisioning; **no** authentication mechanism; and **no** search technology.

## Alternatives considered

Three credible **primary implementation-level runner** postures were compared, derived from Next.js's own testing index — which documents **Vitest** and **Jest** for unit testing and Cypress and Playwright for end-to-end testing — plus **Node's built-in test runner** as a zero-dependency posture. **Playwright, Cypress, React Testing Library, database containers and accessibility tools were not treated as competing primary runners**: they solve different test layers and remain candidates for later complementary tooling.

**No candidate was disqualified outright.** All three are open source and free for this use, so **no financial differentiation exists and none is invented**; the comparison turned on repository fit and operational burden for a single maintainer.

| Alternative | Why it was rejected |
|---|---|
| **Node's built-in test runner** (`node:test`) — *the runner-up, and a genuinely strong option* | **Not rejected on capability or quality.** It is Stable in Node, needs **zero added runner dependencies** — the smallest supply-chain surface of any candidate — and provides assertions, mocking, watch mode and concurrency. It was not selected on **repository fit**, and specifically on the fit of its **built-in TypeScript execution posture**: that posture works by type stripping, which **ignores `tsconfig.json`**, leaves **`tsconfig` path mappings unsupported** — and this repository's `tsconfig.json` uses the alias `@/* → ./src/*` — **cannot handle `.tsx`**, and reached Stable **above the Node version this repository currently pins**. Node documents **third-party TypeScript tooling as the route to fuller TypeScript support**, so those needs are **addressable**: what they require is **additional tooling and/or a complementary test environment or runner posture**. **That does not prove a second runner is inevitable** — it does mean the simplicity and zero-dependency advantage that is this option's principal merit would be **partly spent** on reconciling the repository's existing TypeScript conventions, which is why the owner's one-primary-runner posture favoured the alternative. |
| **Jest** | **Not rejected on maturity or ecosystem** — it is mature, widely supported, and Next.js ships a `next/jest` transformer for it. It carries **more transform and configuration burden for this repository**: TypeScript requires an additional transformer that does **not** type-check, or `ts-jest`; and path aliases must be **duplicated** from `tsconfig.json` into the runner's own module mapping, a standing maintenance liability. `next/jest`'s principal benefits — stylesheet, image, font and `.env` handling — are **irrelevant to Slice A**, which contains no components and no framework surface. |

## Consequences

### Positive

- **The primary implementation-level runner is explicit**, decided deliberately rather than by whichever tool the first test commit happened to install.
- **`P1` Slice A becomes able to reach Definition of Done** — its unit-level obligations (`DI-1`, `DI-2`, `DI-5`, `DI-8`, `DI-10`, `DI-11`, validation behavior, deterministic error and edge behavior) become executable and provable by attacking tests.
- **Assertions and mocking are integrated**, so no separate assertion or mocking library is required by this decision.
- **A low-friction TypeScript workflow** — TypeScript test sources require **no separately configured TypeScript transform step**, unlike a transformer-based posture. **Alias handling is not automatic**: the selected runner's Vite-based resolution provides an **integration path** for the repository's `tsconfig` path alias, and the **exact reconciliation is implementation-time configuration**, not decided here.
- **`ADR-002` `O-11` is satisfiable in practice** — business logic is testable in-process, without a browser and without a deployed environment.
- **The same primary runner can extend into later implementation-level testing** where appropriate, rather than forcing a second primary runner at the first component test.
- **Compatible with later complementary layers** — an end-to-end tool, an accessibility checker and database-test infrastructure remain separate, later, additive choices.

### Negative — stated plainly

- **It adds development dependencies when implemented.** The zero-dependency posture Node's built-in runner would have given up is genuinely given up here.
- **A larger supply-chain surface** than the built-in alternative, for a single-maintainer project.
- **Some future layers still need complementary tooling.** End-to-end, accessibility and database-integration testing are not solved by this choice, and **async Server Components are documented as unsupported by unit runners of this class**, with end-to-end testing recommended for them — a future-layer consequence recorded honestly here, not a Slice A constraint.
- **Choosing a runner does not end test architecture.** Coverage policy, release depth and the later layers remain open decisions.
- **A runtime-floor consequence may follow at implementation time.** The selected runner's supported-Node floor and this repository's declared `engines` floor must be reconciled when it is installed; that reconciliation is **implementation-time work, not decided here**.

## Reversibility

**Bounded, and cheaper than most tooling reversals.** Switching primary runners later would touch: test file imports and any runner-specific API surface; whatever mocking helpers exist at that point; the runner configuration, if any; the npm script; and any CI wiring. **Application and domain code: none expected** — `ADR-002` `O-11` requires business logic to be testable in-process, so the code under test is not runner-shaped. The selected runner's assertion API is deliberately close to the most common alternative's, which narrows the cost of an exit further. **This is not zero cost**: the more tests exist when a switch happens, the more expensive it becomes, which is precisely why the choice is recorded as an architecture decision rather than left to an implementation commit.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`P1` Slice A is deterministic logical/domain code** needing no DOM, no React component environment, no database and no provider integration | If Slice A turned out to need a DOM or a store, the *minimum* tooling for the first slice would be larger — but the runner choice itself would not change, since the selected runner extends to those layers additively |
| **One primary implementation-level runner is worth more than the smallest dependency surface** — the owner's stated preference | If minimum dependency surface later proves the higher value, Node's built-in runner becomes the better answer, and this ADR is the first thing to revisit |
| **`ADR-002`'s stack stands** — TypeScript and Next.js | A framework change would reopen tooling fit; the reversibility above is what bounds that cost |
| **Mutable tooling facts remain as recorded** — supported runtime floors, package availability and framework guidance are **decision-time evidence dated 2026-09-03**, not architectural requirements | Each must be **re-verified against current official documentation before implementation**; a changed floor is an implementation-time reconciliation, not a new architecture decision |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **`Accepted` is read as installation, or as authorization to implement** | A dependency is installed, or Slice A begins, on the strength of this ADR alone | The header callout states that acceptance puts the **decision** in force and **is not installation**: it authorizes no dependency, no configuration, no test, no CI change and no Slice A implementation, each of which remains a separate later work unit |
| **Selecting a runner is mistaken for settling testing depth** | `DG-4` is treated as resolved; a coverage threshold or release criterion appears without being decided | *`DG-4` relationship* below states that depth is untouched, and `docs/11` `T7` — *"No coverage percentage, no pyramid, no tool architecture"* — is preserved. **No numerical coverage threshold exists in this repository, and none is created here** |
| **Optional capabilities harden into mandated technique** | Mocking is used reflexively where a direct test would be better, weakening the evidence `docs/11` `T1` and `T3` ask for | Assertions and mocking are recorded as **permitted capabilities**, not required practice; Slice A is expected to need no mocking at all |
| **Implementation trivia is read as architecture** | A version, a config filename or a script name is treated as a durable commitment | *Explicitly not selected* names each as unselected; the version in particular is **implementation-time**, and every mutable fact here is decision-time evidence with an access date |
| **This ADR is read as authorizing `P1` Slice A** | Implementation begins without its own commissioned work unit | This ADR authorizes no implementation; Slice A remains a **separate later work unit**, not commissioned by this document |

## `DG-2` relationship

**`DG-2` was already `Resolved` — 2026-08-27, issue #93 — before this ADR existed.** This ADR **does not reopen it**, is **not retroactively a constituent of it**, and its acceptance is **not required to resolve `DG-2` again**. The owner ruling of 2026-08-26 (issue #87) had already established that **`ADR-012` does not block `DG-2` closure** and that its **depth** half belongs to `DG-4`. This tooling decision is taken **prospectively, after that gate closed**, to enable implementation. **An ADR records a decision; it does not open a gate** — and this one closes none either.

## `DG-4` relationship

**`DG-4` remains `Unresolved`.** Selecting an implementation-level runner is **distinct from release-depth policy**. This ADR decides **no** release threshold, **no** release-approval criterion, **no** required end-to-end depth, **no** coverage provider and **no** numerical coverage threshold. `docs/11`'s Category 1 unconditional gates, Category 2 judgment gates and `T7`'s refusal of a coverage percentage all stand exactly as written.

## `P1` Slice A relationship

**The first `P1` implementation slice is the logical/domain data foundation, and it decides no `DDM-*`.** This ADR makes automated verification of **already-decided** domain behavior possible — status-transition legality including illegal transitions rejected (`DI-1`, `DI-2`), the public/private projection as logic (`S-2`, `DI-5`), the revision rules (`DI-10`, `DI-11`), stable content-independent identity (`DI-8`), decided validation behavior, and deterministic error and edge behavior. **It authorizes no Slice A implementation**, creates no test, and decides nothing about the physical representation of anything.

## Persistence boundary

This ADR selects **no ORM**, **no PostgreSQL driver**, **no query builder**, **no connection pooler**, **no migration framework**, **no physical schema**, **no database-test mechanism**, and **no provider resource**. `ADR-013` discharged **`DDM-1` only as to the named provider**; **`DDM-2`–`DDM-10` remain unresolved** and are untouched here. Persistence technology remains a **separate later work unit**, approved in principle only and **not commissioned** by this document. **No DigitalOcean provisioning implication arises from this ADR**, and `ADR-010`'s outstanding obligations — provider-capability validation, the independent off-provider recoverable copy, and the restore rehearsals — are unaffected and remain outstanding.

## Lifecycle boundary

**This document is `Accepted` and in force.** Under `docs/adr/README.md`'s statuses, an `Accepted` ADR is *"Decided and in force. Work may rely on it."* It was published as `Proposed` on 2026-09-03 (issue #105, PR #106) and **accepted on 2026-09-04** through the separate governed acceptance work unit (issue #107), following the uniform `ADR-002` / `ADR-003` / `ADR-005` / `ADR-013` precedent. **What is in force is the test-tooling decision only.** Acceptance itself installs nothing and authorizes no dependency installation, no configuration, no test, no CI change and no implementation — **Vitest is the `Accepted` runner decision, not an installed dependency.**

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **Testing depth** (`DG-4`) | **Untouched.** The depth half of `ADR-012`'s original scope is expressly excluded; no release threshold or approval criterion is stated |
| **`NOQ-5`** — accessibility standard and level | **Untouched.** No accessibility tool is selected, and `docs/11` already forbids an automated check from asserting a conformance level |
| **`NOQ-7`** — log retention | **Untouched.** Unrelated to runner selection |
| **`OQ-4` / `ADR-007`** — search approach | **Untouched.** No index, query or search behavior is decided by choosing a test runner |
| **`NOQ-9` / `ADR-004`** — administrator authentication | **Untouched**, under `DG-3`. `O-10` names the `TB-3` boundary as the highest-value *test* target; testing a boundary decides nothing about the mechanism that enforces it |
| **`DDM-1`–`DDM-10`** — physical data representation | **Untouched.** No schema, key, index, identity strategy, revision storage, migration tooling or database-test mechanism is decided |
| **Persistence technology** (ruling `R-A`) | **Untouched.** No ORM, driver, query builder, pooler or migration framework is selected |
| **Coverage policy** | **Untouched.** No provider and no threshold; `docs/11` `T7` stands |
| **The CI required-check set** | **Untouched.** `.github/workflows/ci.yml` and branch protection are unchanged. Wiring a test command into CI, and any decision to make it *required*, are **later governed work** — issue #99 / PR #100 established that making a check required is its own act |
| **Later complementary test layers** | **Untouched.** DOM simulator, component library, browser/end-to-end tool, accessibility tool and database-test infrastructure each remain a separate later choice |
| **Implementation** | **Not authorized.** Acceptance puts the **test-runner decision** in force and nothing more; installation and `P1` Slice A are separate later work units |

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-MAINT-03` — maintainability and the testability it depends on; `R-6` — the risk `ADR-012` exists to answer (`docs/07`) |
| **Journeys** | **None decided here.** Journey-level testing (`V1`–`V7`, `L1`–`L4`, `A1`–`A7`) belongs to the journey level and its own later tooling |
| **Components** | **None selected or shaped.** `C1`–`C12` are unchanged by this ADR. `ADR-002` `O-11` obliges that **business logic is testable in-process, without a browser and without a deployed environment** — that, and no more, is what is attributed to `ADR-002` here; it states no runner-independence requirement. `ADR-012` selects the runner used to exercise such logic |
| **Invariants** | Must not breach: `BI-1`–`BI-9`, `DI-1`–`DI-11`. This ADR **decides nothing about them** — it makes them provable. `docs/11` rates both sets **Highest** for automation |
| **Decisions** | **`ADR-012`'s test-tooling portion** — decided here, and **in force since 2026-09-04**; later implementation may rely on it. **`ADR-012`'s depth portion — untouched**, under `DG-4`. `DD-2` — already discharged by `ADR-003`'s sibling `ADR-002`; untouched. `DG-2` — **`Resolved`** 2026-08-27 (issue #93); this ADR is not a constituent and changes nothing about it. `DG-4` — **`Unresolved`**; unchanged |
| **Related ADRs** | `ADR-002` (Accepted — TypeScript and Next.js, whose `O-10` and `O-11` this tooling must serve; not reopened); `ADR-001`, `ADR-003`, `ADR-005`, `ADR-006`, `ADR-010`, `ADR-013` (Accepted; not reopened, and none of their obligations discharged); `ADR-004`, `ADR-007`, `ADR-008`, `ADR-009`, `ADR-011` (open, and not decided here) |
| **Governance** | **Issue #105** — `architecture: decide the MVP test tooling in ADR-012`, the commissioned decision work unit, which recovered the tooling-versus-depth distinction from `docs/adr/README.md`, `.github/workflows/ci.yml` and `docs/11`, and established that no `P1` implementation could reach Definition of Done without this decision. **Owner ruling 2026-09-03** — *select Vitest as the primary implementation-level test runner, beginning with `P1` Slice A* |
| **Documents amended** | **At the earlier `Proposed` stage (PR #106):** this file, `docs/adr/README.md` (register row, the register's `Blocked`/`Not yet writable` framing, and the derived cannot-be-written count), `docs/traceability-matrix.md` (ADR register row) and `docs/13-decision-log.md`, whose statement that `ADR-012` *"remains unwritten"* that publication made false. **`docs/11-test-strategy.md` and `docs/12-implementation-plan.md` were untouched at that stage**: a `Proposed` ADR puts nothing in force. **At acceptance (issue #107):** this file, `docs/adr/README.md` (the `ADR-012` register row and the derived decisions-in-force count), `docs/traceability-matrix.md` (ADR register row), `docs/13-decision-log.md` (the `Proposed`-lifecycle statement) and `docs/11-test-strategy.md` — whose *"No automation tool, runner, or framework is selected"* is a present-tense **repository** claim that acceptance makes false. **`docs/11`'s separate statement of what the strategy document *itself* selects remains true and is untouched**, as is **`docs/12-implementation-plan.md`**, whose *"the testing tool still follows from it via `ADR-012`"* is a lifecycle pointer that acceptance does not falsify. **No gate is marked `Resolved`** — `DG-2` was already `Resolved` (issue #93) and this ADR is not a constituent of it; `DG-4` is unchanged |
| **Issue / pull request** | **Proposed:** issue #105 — `architecture: decide the MVP test tooling in ADR-012`; pull request #106 — `docs: propose ADR-012 Vitest test tooling`, merged 2026-09-04. **Accepted:** issue #107 — `architecture: accept ADR-012 Vitest test tooling` |

### Sources consulted

External claims rest on the official documentation gathered for issue #105, accessed **2026-09-03**: Next.js *Testing* and its Vitest and Jest guides; the Node.js *Test runner*, *Modules: TypeScript* and *Previous releases* pages; the Vitest *Features*, *Getting Started*, *Configuring Vitest* and *Common Errors* pages — the last supporting the record that Vite-based resolution does not consume `tsconfig` path mappings automatically, which the current Next.js Vitest guide reflects by configuring an explicit path-integration plugin in its TypeScript setup; and the Jest *Getting Started* page. **No such plugin is selected by this ADR** — it is cited only as decision-time evidence that alias integration can require explicit configuration. Package version numbers were read from the npm registry and are **registry metadata, not normative documentation**.

> **Supported runtime floors, package versions, framework guidance and tool capabilities are mutable facts, recorded as decision-time evidence dated 2026-09-03 and not as architectural requirements.** Each must be **re-verified against current official documentation before implementation**. **No exact package version is normative anywhere in this ADR**; the version is an implementation-time choice.
