# `ADR-001` — Adopt a modular monolith with a server-enforced public/administrative boundary; reject microservices and browser-direct data access

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Date** | 2026-07-24 |
| **Decision owner** | Product owner — *assign* |
| **Decision gate** | `DG-0` — the architecture **shape** is decidable today; **blocked by nothing** |
| **Related open questions** | Depends on **none**. Must **not** answer: `DG-1` (`OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13`, `OQ-4`, `OQ-5`) · `DG-2` (`NOQ-1`–`NOQ-4`, technology stack) · `DG-3` (`NOQ-9`, `DD-4` — the auth **mechanism**) |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

> **What this ADR ratifies, in one sentence.** The architecture **shape** recommended in
> `docs/07-system-architecture.md` — **Option A** — is adopted, so it is not re-litigated
> during implementation (`PA-4`), and the rejection of the browser-direct shape is recorded
> **explicitly** so it cannot be re-made by accident (`IR-6`, `IP-8`).

**This ADR decides a shape, and only a shape.** It selects no language, framework, data-store
product, hosting platform, runtime model, or authentication mechanism. Those are `ADR-002`–
`ADR-005`, and they are **blocked** on `DG-2`/`DG-3`. See *Open questions this decision must
not answer* — that section is not boilerplate here; it is half the point of writing this ADR
at all.

---

## Context

The MVP's binding constraints are already established in `docs/07` (drivers `D-1`–`D-7`) and
are **not reopened here**:

- A **hard moderation boundary** that must be enforced where the client cannot reach it
  (`D-1`, `D-3`) — *nothing is public until approved*.
- A sharp split between an **anonymous public** and **a handful of trusted administrators**
  (`D-2`), with **no other role** in the MVP (`FR-AUTH-04`).
- An **unauthenticated public write surface** that must be validated **server-side** (`D-4`).
- A **small team with no operations staff** (`D-6`) — one primary developer (`NFR-OPS-01`).
- **Accessibility** best served by delivering real content rather than assembling it in the
  browser (`D-7`, `NFR-ACC-01/02`, `NFR-COMP-03/04`).
- An **unquantified-but-small** early load (`A-5`, `A-6`), carried as the stated assumption
  `PA-1` — *not* resolved here.

`docs/07` evaluated five realistic option combinations against these constraints and the
Issue #13 criteria, and **recommended Option A**. The chain has been reviewed and approved
through `docs/12`. What remained was to **ratify** that recommendation as a decision of
record — because a recommendation can be drifted away from, and an argued rejection that is
never written down as a decision *gets silently re-made* (`IR-6`). That is this ADR.

## Decision

**We adopt Option A: a single deployable, internally modular, server-rendered web
application, backed by one managed transactional (relational-shaped) data store reached over
a private network path, with a server-enforced public/administrative boundary.**

Concretely, and technology-neutrally:

1. **One deployable serves all three surfaces** — public read (`C1`), public submission
   (`C2`), and administrative (`C3`) — internally layered (interface, domain, data access).
   *One deployment, one log stream, one test suite, one thing to restore.*
2. **The public/administrative boundary is enforced on the server, on every request**
   (`C8`), not in the interface layer. *A hidden administrative control is a courtesy, not a
   protection* — denial reveals nothing, not even whether a record exists.
3. **The public read path cannot express a non-approved query.** The projection that returns
   approved, public content (`C4`) has **no method** that returns a pending, rejected, or
   withheld record. Privacy is a **property of the query model**, not of a filter someone
   remembered to apply.
4. **The public write path cannot express an approved record.** An unauthenticated
   submission (`C5`) can create **only** a pending record; status is written by exactly one
   privileged path (`C6`). *What is small and what is safe here are the same decision.*
5. **The store has no public route and no client-held credential.** All access is
   server-mediated over a private path — a **hard requirement** (`docs/07` hard requirement
   4), and the disqualifier that keeps the mini lab shape out (`R-10`).

## Alternatives considered

Each was evaluated in `docs/07` against the MVP's actual drivers, **not in the abstract**.
This ADR records the outcomes and their requirement-based reasons; it does not re-run the
analysis.

| Alternative | Disposition | Why — on the requirements |
|---|---|---|
| **Option E — Microservices** | **Rejected outright** — not deferred | Solves independent scaling and *multi-team* deployment. The MVP has **one developer** (`NFR-OPS-01`) and **one transactional invariant** (`D-8`) that would have to be split across service boundaries — introducing distributed transactions or eventual consistency into *nothing is public until approved*, the one guarantee the product cannot afford to get wrong. It would make the system **less** reliable, for benefits nobody asked for. |
| **Option C — Browser-direct data access (the mini lab shape)** | **Rejected on the requirements** | See *The mini lab* below. The security boundary would move into vendor policy configuration; the client would hold a store credential in the untrusted zone; server-side validation of the public write path would become awkward exactly where it matters most; and a database console is **not** an administrative interface (`FR-ADM-*`, `NFR-OPS-02`). |
| **Option B — Split frontend + backend API** | **Deferred, not rejected** | Fully capable, and the **textbook shape once a second client exists**. Today it buys independent FE/BE scaling and multi-client reuse — **neither an MVP requirement** — at the cost of doubled operational surface and a harder accessibility story, all carried by one developer. Sensible later; unearned now. |
| **Option D — Function-per-capability serverless** | **Deferred, not rejected** | Fragments a domain with exactly one transactional invariant across many units; cold starts press on `NFR-PERF-04`. **Note:** deploying the *Option A artifact* onto a serverless **runtime** is a legitimate hosting choice and is **not** foreclosed (`DD-5`). What is rejected is *decomposition*, not serverless hosting. |

### The mini lab is a reference implementation, not the default production path

**This subsection is the reason `ADR-001` is written now** (`IP-8`, `IR-6`, `R-10`).

The Community Directory Mini Lab (constraint `C-5`) proved the concept with **browser-direct
data access under row-level policies and console-based moderation**. That was the right call
for a prototype. **Its lessons are carried forward in full** — moderation-first works, the
core loop is small, and *a pending status plus an approved-only read filter is the whole
trick.* **Its shape is not.**

The mini lab shape (Option C) is **rejected on its merits against the documented
requirements**, not merely "not adopted by default":

- The invariant *nothing is public until approved* would stop being a property of code the
  team owns and tests (`NFR-MAINT-03`) and become a property of correctly authored database
  policies — **one mistaken policy exposes every pending and rejected submission.**
- **The client would hold a data-store credential** — a key shipped into the untrusted zone
  (`TB-1`), negating the load-bearing property that *the store has no public route*.
- **Moderation in a database console fails `FR-ADM-01..13`, `FR-CONF-02..04`, and
  `NFR-OPS-02`** — a non-technical administrator cannot be handed a SQL console, so the MVP
  would have to build an administrative application anyway.

**The distinction that must not be lost** (`R-10`): *using a managed database product* is
perfectly compatible with Option A and remains a live candidate for `ADR-003`. What is
rejected is **browser-direct access with policy-as-security**. *"Managed" is a hosting
decision; "browser-direct" is an architecture decision.* **Conflating the two is the single
most likely way for the mini lab shape to reappear by accident** — which is why this ADR
records the rejection explicitly, and why hard requirement 4 states *no client-held store
credential, no public route to the store* as a **disqualifier**.

## Consequences

**Positive:**

- The three boundary guarantees hold **by construction**: the public read path *cannot*
  express a non-approved query, the public write path *cannot* express an approved record,
  and the administrative path *cannot* be reached without an authorized identity.
- **One deployment, one pipeline, one log stream, one thing to restore** — matched to one
  developer with no operations staff (`NFR-OPS-01/04`).
- The moderation guarantee is **testable without a browser** (`NFR-MAINT-03`) — the
  highest-value test in the suite (`R-6`) attacks the boundary at the operation level.
- Server-rendered content serves the accessibility and older-browser requirements directly
  (`NFR-ACC-*`, `NFR-COMP-03/04`).

**Negative (stated with eyes open):**

- All surfaces **scale and deploy together**; the administrative interface ships with the
  public application. *Neither is a real cost at MVP load, and neither is irreversible.*
- The administrative surface living inside the same application is **the likeliest place for
  a security mistake** (`R-6`, `TB-3`) — accepted, and mitigated by `C8` gating server-side
  on every request with **explicit** automated coverage.
- Twelve **named components** may read as more structure than a small application needs.
  They are **logical responsibilities, not deployment units or mandated modules**; an
  implementation may collapse several into one module while preserving the enforced seams
  (`C4` approved-only, `C6` sole status writer, `C9` sole store access). **Nothing here
  mandates ceremony.**

**Reversibility — the seams preserved at no cost today (`C4`–`C9`):**

- **Stateless instances** — redundancy and horizontal scaling become an *operational* change,
  not a redesign, if `NOQ-2` ever demands more than ~99%.
- **Enforced internal seams** (`C4`, `C5`, `C6`, `C7`, `C8`, `C9`) — **the administrative
  surface, or any other component, can be extracted later without unpicking the domain.**
  This is precisely what keeps **Option B a deferred option rather than a future rewrite.**
- **No vendor-proprietary capability in the domain** — hosting and store products remain
  replaceable (`ADR-003`, `ADR-005`).

## Assumptions

| Assumption | If it is wrong |
|---|---|
| `PA-1` — the directory is **small at first release** (`A-5`, `A-6`) | Store, indexing, and search sequencing (`DD-14`) are revisited. Statelessness allows scaling out; `C4` isolates search, so an index is an **additive** change — *measured, never presumed* (`R-5`). **This is the first decision to revisit** if the assumption breaks. |
| `PA-3` — the team is **small, with no dedicated operations staff** | The one-deployment / one-pipeline argument weakens; but a larger team is exactly the condition under which the preserved seams pay off. |
| `PA-4` — Option A is **ratified, not re-litigated** during implementation | This ADR *is* that ratification. If it is reopened, it is reopened **as a decision** — a new ADR superseding this one — not by drift. |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **`R-10` — the mini lab shape returns through the back door.** A managed store product is chosen (legitimate) and browser-direct access quietly arrives with it | Reintroduces every disqualifying property of Option C | **This ADR records the rejection explicitly.** Hard requirement 4 (*no client-held store credential, no public route to the store*) is a **disqualifier** any future `ADR-003` must honour. |
| **`R-6` — the administrative surface is the likeliest place for a security mistake** (`TB-3`) | If breached: every pending and rejected submission | `C8` gates server-side on **every** request, including direct-URL and non-browser access. This boundary **must carry explicit automated test coverage** — the single highest-value test in the suite. |
| **Overengineering** — twelve components read as ceremony | Complexity unearned at `A-5`/`A-6` | Components are logical responsibilities, not modules; conditional ones (`C10`, `C11`) are built **only if** their questions resolve yes (`IP-7`). |

## Open questions this decision must NOT answer

**This ADR ratifies the shape, and stops there.** It has no authority over the questions
below, and naming an answer to any of them — even in passing — would be the gate bypassed in
a document that looks official.

| Open question | How this decision avoids answering it |
|---|---|
| `DG-1` — `OQ-6`, `OQ-7`, `OQ-8`/`OQ-8b`, `OQ-10`, `OQ-11`, `OQ-13`, `OQ-4`, `OQ-5` | **No entity, field, category, location granularity, or lifecycle state is named.** `docs/08`'s seams are *referenced*, never *populated*. The projection (`C4`) is ratified as a **rule** — *no field outside the approved public set is ever exposed* — while **which fields** those are remains `OQ-7`'s to answer. |
| `DG-2` — technology stack (`ADR-002`, `ADR-005`), store product (`ADR-003`), `NOQ-1`–`NOQ-4` | **No language, framework, store product, hosting platform, or runtime model is named.** "Relational-shaped" and "managed transactional store" describe a **required capability**, not a product. The store choice is `ADR-003`, blocked on `NOQ-2`/`NOQ-3`. |
| `DG-3` / `DD-4` — administrator authentication **mechanism** (`ADR-004`, `NOQ-9`) | **The administrative boundary is settled; the mechanism is not.** This ADR says the boundary is enforced at `C8` on every request — it does **not** say *how* an administrator authenticates. |

**If implementing this shape ever seems to *require* answering one of the above — stop.**
That is the finding. Take the question to its owner (`docs/13-decision-log.md`); do not settle
it here.

## Traceability

| | |
|---|---|
| **Requirements** | `D-1`–`D-7` (drivers); `FR-AUTH-01..04`, `FR-VIS-01`, `FR-SUB-01`, `FR-MOD-02`, `FR-ADM-01..13`, `FR-CONF-02..04`; `NFR-PRIV-01/02`, `NFR-SEC-01/02/05/08`, `NFR-MAINT-03/04`, `NFR-OPS-01/02/04`, `NFR-ACC-01/02`, `NFR-COMP-03/04`, `NFR-PERF-04`, `NFR-SCALE-01` |
| **Journeys** | Public read (`V1`–`V7`), public submission (`L1`–`L4`), administrative (`A1`–`A7`) — the three surfaces this shape separates |
| **Components** | `C1`–`C12` (`docs/07`); the enforced seams `C4`, `C5`, `C6`, `C7`, `C8`, `C9` |
| **Invariants** | Enables (does not itself prove) `BI-1`–`BI-9` and `DI-1`–`DI-9`; the shape exists so these are enforceable server-side (`IP-1`, `IP-5`) |
| **Decision gates** | Decided under `DG-0`. Explicitly does **not** touch `DG-1`, `DG-2`, `DG-3` |
| **Documents amended** | None. This ADR **ratifies** `docs/07`'s recommendation; it adds no architectural decision `docs/07` did not already make |
| **Source** | `docs/07-system-architecture.md` (*Architecture options considered*, *Recommended architecture*, `R-10`); `docs/12-implementation-plan.md` (`PA-4`, `IP-8`, `IR-6`) |
| **Issue / pull request** | Closes #29 |
