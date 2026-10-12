# `ADR-023` — Detect a stale administrator edit by exact equality on the listing's existing `lastUpdatedAt` instant, captured when work begins and persisted with a pending revision, and reject the write outright with no override

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-12 (issue #181). The Product Owner's **binding ruling was given on issue #181 before this document was drafted**, and is recorded below |
| **Date** | 2026-10-12 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-12:** *Option A* — stale changes must be detected; a stale write is **rejected**, never automatically refreshed, merged or overwritten; the administrator receives a complete governed message and must refresh and resubmit; the public user receives no notification and observes no partial change; **no role may override**; a revision is stale at `OP-10` whenever the listing's current version differs from its captured base; the base token is captured at revision creation and **persisted with the revision**; the MVP token is the listing's existing **`lastUpdatedAt`**, compared by **exact epoch-millisecond equality**, refusing a **missing or unequal** token, **never public**; and **no dedicated counter or fingerprint** is introduced for the MVP. Options B, C, D, E and F are **rejected** |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision |
| **Related open questions** | **Depends on:** nothing unresolved. The rules this policy rests on are already in force — **`DI-6`/`NFR-DATA-05`** (write-once `submittedAt`, **strictly-increasing** `lastUpdatedAt`; issue #141), **`ADR-017` `PS-11`** (per-listing serialization of revision work; issue #137), **`ADR-017` `DI-11`** (at most one pending revision), **`FR-ADM-10b`**'s refusal while a revision is pending, **`ADR-017` Q-3** (no approved revision row persists) and **`ADR-022`** (the exact epoch-millisecond round trip). **Must NOT answer:** the **physical column name, its nullability and the migration shape**; the **legacy/backfill posture**; the **`ListingRevision` field representation**; the **API transport mechanics**; the **`PS-11` isolation level**; the **retry policy**; the **transaction implementation**; **revision and moderation persistence**; **provisioning and deployment**; **`OQ-4`/`S-4`/`DDM-4`** searchable fields, indexing and text search; **`OQ-14`/`NOQ-8`/`DDM-7`/`S-8`** audit-entry storage; the **public projection form**; **`DDM-2`'s** remaining items; **`VR-S3`**'s safety and length boundaries; **replacement-value semantics** (`ADR-017` Q-4); `DG-3`, `DG-4` |
| **Supersedes** | *none* — `ADR-017` is **not** superseded. It **deferred** this policy deliberately, recording it as *"product policy not yet ruled"*, and this ADR fills that deferral rather than revising it |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-12 (issue #181). In force; later work may rely on it.**
> **It authorizes no implementation.** No schema, migration, DDL, token column, domain field,
> comparison logic, API change, transaction code, revision or moderation operation,
> provisioning or deployment is created by this document or by its acceptance.

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

**The same sequence as `ADR-019` through `ADR-022`, and recorded for the same reason.** The
chronology, in order:

1. **`ADR-017` deferred this policy explicitly** (`Accepted` 2026-09-17, issue #137). Its
   *Deferred implementation details and dependencies* table carries a row for **stale-edit
   detection and resolution policy** and any supporting version token, naming what it blocks —
   *"Implementing `OP-6` revision creation, `OP-10` approval and the `FR-ADM-10b` atomic path,
   and pending-record edits under `FR-ADM-04`; their tests"* — and stating that *"Whether stale
   input is rejected, overwritten, merged or retried is **product policy not yet ruled**; a
   version token, if any, follows that policy. **None is selected here**"*.
2. **Issue #181 was the Scope Gate**, which established the current facts from the domain and
   the schema, analysed six options against fifteen dimensions, marked its own recommendation
   **advisory**, and **requested** six rulings. It decided nothing.
3. **The Product Owner ruled on issue #181 on 2026-10-12**, selecting Option A and answering all
   six questions, with five additional interpretations and an explicit non-authorization clause.
   The ruling is recorded verbatim in the issue's single ruling comment.
4. **This ADR was drafted after that ruling**, to record a decision already taken. Publishing it
   as `Proposed` would misrepresent the chronology: there is nothing left to propose.

**The precedent is established and consistent.** `ADR-019`, `ADR-020`, `ADR-021` and `ADR-022`
were each `Accepted` directly on the same ground — the binding ruling preceded the draft — and
the register records that reasoning on each row.

## Why an ADR, and not product-decision documentation alone

Applied against *When an ADR is required* (`docs/adr/README.md`), not against preference. All
four criteria are met:

| Criterion | Why it applies |
|---|---|
| **Structural** | It shapes the data model and a component boundary: a base token must be **persisted with a pending revision**, and the administrator read and write paths at `C9`/`C6` must carry it. |
| **Costly to reverse** | Undoing it means migrating data (a token column added or dropped), rewriting the tests that prove the refusal, and re-arguing the token choice. |
| **Cross-cutting** | Four write paths (`OP-6`, `OP-10`, `FR-ADM-04`, `FR-ADM-10b`), components `C6` and `C9`, the `PS-11` isolation decision that follows it, and the test strategy must all live with it. |
| **Contested** | A reasonable engineer would have chosen a dedicated version counter (Option B). `IR-6` requires that the argument, not only the answer, survives. |

It is not *"a reversible, local, uncontested choice"*, so the *"Do not write one"* clause does
not apply. **The number was not taken for continuity:** `ADR-023` is the next unused number, and
none of the five blocked ADRs covers this decision — `ADR-004` is administrator authentication,
`ADR-007` the search approach, `ADR-008` anti-spam, `ADR-009` audit logging, `ADR-011`
accessibility. This is *"a decision the chain did not anticipate"*, taking `ADR-013` onward under
*Numbering and filenames*.

**The comparable-decision precedent points the same way.** `ADR-022` filled a *different*
`ADR-017` deferral — *"names, exact data types"* — and took its own ADR number while stating that
`ADR-017` was not superseded. `ADR-017`'s Q-1–Q-5 product rulings were instead recorded in the
governed documents **because an ADR was in flight to host them**; none is in flight now, and this
ruling additionally selects a token with three alternatives rejected on the requirements.

## Context

**`PS-11` orders transactions; it cannot see what an editing screen already holds.** `ADR-017`
selected per-listing serialization: every transaction that creates, approves or rejects a
revision, or performs the administrator create-and-approve operation, takes an exclusive lock on
the listing row **before** checking pending state or reading the content it will use, and holds
it to commit or rollback. `ADR-017` then states the limit of that protection in its own words:

> **Serialization is not stale-input detection.** The lock orders transactions; it does **not**
> detect that an administrator prepared a revision, or an atomic edit, from content that has
> since changed. Content read into an editing screen before the transaction begins is outside
> the lock.

**Four write paths are exposed** (`ADR-017`'s own list): `OP-6` revision creation against an
approved listing; `OP-10` revision approval; the `FR-ADM-10b` atomic create-and-approve path; and
pending-record edits under `FR-ADM-04`. `OP-7`, `OP-8` and `OP-9` matter only because their status
transitions move `lastUpdatedAt` beneath a listing an administrator may already have open.

**What the records held, before this decision.** Established from the code by issue #181:

- `ListingRevision` (`src/domain/listing/revision.ts`) carries `id`, `listingId`, `state`,
  `proposedContent` and an optional `rejectedAt` — and nothing else.
- `listing_revision` (`src/data/migrations/001-create-listing-and-revision-tables.ts`) carries
  the identity, state, content and designation columns and `rejected_at timestamptz(3)` — and
  nothing else.
- **The revision therefore records no base listing version and no creation instant.** `ADR-022`
  states the same inventory affirmatively: *"The revision carries **no** `submittedAt` and
  **no** `lastUpdatedAt`."*

**Two governed facts make an instant usable as a version token**, and both are in force for
reasons unrelated to concurrency:

1. **`ADR-022` guarantees exact equality.** Every governed instant is `timestamptz(3)` with a
   mandated **exact epoch-millisecond round trip**, no silent rounding, truncation or
   normalisation, and comparison on **instants, not formatted text**.
2. **`DI-6`/`NFR-DATA-05` makes `lastUpdatedAt` strictly forward-moving per listing**, enforced
   in code rather than only documented: `advancedTimestamps` (`src/domain/listing/timestamps.ts`)
   **refuses** an instant that is not strictly later than the current value. An equal instant is
   not accepted and then disambiguated — it is rejected outright.

Together these mean `listing.lastUpdatedAt` is already a **monotonic per-listing version
counter**, denominated in milliseconds. **Two accepted versions of one listing can never share a
`lastUpdatedAt`.** This was tested against the collision and comparison semantics by issue #181,
not assumed from `ADR-017` having named the value as a candidate.

**Requirements bearing on the resolution.** `FR-VAL-03` requires that work *"fails visibly, is
preserved for correction, and is never silently dropped"*; `FR-CONF-04` requires *"an unambiguous
confirmation of the resulting state"* and that *"saved" is never mistaken for "published"*;
`FR-ADM-10b` requires that a failure *"leave the currently approved listing unchanged"*;
`FR-ADM-04` states that administrator editing *"is not a validation bypass"*; and `DI-10` keeps
revision data out of every public read path.

## Decision

**We will detect a stale administrator edit, reject it outright, and use the listing's existing
`lastUpdatedAt` instant as the concurrency token — captured when work begins, persisted with a
pending revision, and compared for exact epoch-millisecond equality — with no override for any
role.**

The Product Owner's ruling of 2026-10-12 (issue #181), preserved without weakening any
condition:

### Detection

1. **Stale changes must be detected.**

### Resolution

2. **A stale write is rejected** — when the listing has changed since the administrator or
   revision author began the work, the attempted write **must be rejected**. It **must not** be
   automatically refreshed, merged or overwritten.
3. **Nothing is saved or partially applied.**
4. **The listing and pending revision remain unchanged.**

### What is communicated

5. **The administrator receives the complete governed message and must refresh and resubmit.**
   The result must be clear and unambiguous, and must state that:
   - the listing changed after the work began;
   - nothing was saved or applied;
   - the current listing and pending revision remain unchanged; and
   - the work must be refreshed and resubmitted against the current listing.
6. **The public user receives no notification** and observes no partial change.

### Override posture

7. **No role may override** the stale condition. **Staleness is a concurrency-safety rule, not
   an ordinary validation rule or a discretionary moderation outcome.**

### Staleness at `OP-10` approval

8. **A revision is stale at `OP-10` when the listing's current version differs from its captured
   base.**
9. **The base token is captured at revision creation and persisted with the revision.**

### The concurrency token

10. **The MVP token is `listing.lastUpdatedAt`** — the listing's existing instant, captured when
    work begins.
11. **Exact epoch-millisecond equality is required**, and the exact epoch-millisecond value is
    preserved.
12. **A missing or unequal token refuses the write.**
13. **The token is never public.**
14. **No dedicated counter or fingerprint** is introduced for the MVP.

### Interpretation carried with the ruling

15. **A same-millisecond `DI-6` failure remains distinct from stale input.** An attempted update
    that fails `DI-6` because the proposed new `lastUpdatedAt` is not strictly later remains a
    **distinct timestamp-advancement failure**; it **must not be mislabeled as stale input**.
16. **Locking or serialization alone is insufficient.** Row locking or transaction serialization
    alone does **not** satisfy stale-input detection.
17. **`lastUpdatedAt` remains load-bearing for this policy while `DI-6` is in force.**
18. **Relaxing `DI-6` requires separately governed reassessment** of the concurrency-token
    policy.

### Scope

This ADR decides **stale-input detection and resolution policy only**. The physical column
design, nullability, migration, domain-field representation, `PS-11` isolation level, retry
policy and implementation **remain separately reviewed downstream steps**, and this ADR selects
none of them (see *Open questions this decision must NOT answer*).

## Sequencing

| Step | What it settles | State |
|---|---|---|
| **1. Product policy** | Detection, resolution, messaging, override, `OP-10` staleness, and the token | **Decided** — this ADR, 2026-10-12 (issue #181) |
| **2. Physical token design** | The column name, its nullability, which record carries it, and the predicate form | **Not decided** |
| **3. Schema migration** | The migration that adds it, and its shape | **Not decided** |
| **4. Domain/API representation** | The `ListingRevision` field representation and the API transport mechanics | **Not decided** |
| **5. `PS-11` isolation and retry decision** | The isolation level and the retry policy | **Not decided** |
| **6. Revision/moderation persistence** | `OP-6`, `OP-10`, `FR-ADM-04`, `FR-ADM-10b` and their tests | **Not decided** |

Steps 2–6 are each **separately authorized later units**. None is authorized by this ADR.

## Alternatives considered

Six options were analysed on issue #181 against user-visible behaviour, administrator behaviour,
lost-update protection, each of the three write-path shapes, database/schema impact,
domain-model impact, API requirements, transaction and isolation implications, timestamp
precision hazards, retry behaviour, auditability, migration and backfill needs, testability and
future extensibility. **Option A was ruled.** The rest are rejected below, and **none is
characterised as technically incorrect** — every rationale is preserved (`IR-6`).

| Alternative | Why it was rejected |
|---|---|
| **B — a dedicated monotonic version counter** on the listing, with the base version on the revision | **Its genuine advantage is real**: it is wholly independent of clock precision and of `DI-6`, and semantically a version number means only "version". Rejected as **premature under current governance**, not wrong: it duplicates a monotonic per-listing counter the system **already has and already enforces in code** (`advancedTimestamps`), and it costs **two** columns, a new domain primitive, a new validator, an increment rule and a new invariant keeping two counters consistent — which can disagree. The same *premature-not-wrong* reasoning `ADR-020` and `ADR-021` applied. **It remains the correct answer if `DI-6`'s strict monotonicity is ever relaxed** (ruling interpretation 18) |
| **C — a content/version fingerprint** over the content read | **Cannot see status or publication-state changes** unless they are in the hashed input, so an edit prepared before an `OP-9` unpublish would not register as stale. It makes a **canonicalisation rule** a governed artifact — exactly which fields, in what order, with what null and designation encoding — which any later field addition invalidates, and which `VR-S3`'s unresolved bounds and the designation semantics both feed. Its one real attraction, distinguishing "written" from "actually different", is a semantic nicety no governed requirement asks for |
| **D — last-write-wins, no stale detection** | **Its advantage is real**: the only option needing no column, no field and no API change. Rejected as **unsafe for the governed confirmation posture** — not as wrong engineering, and a legitimate choice had single-administrator operation been judged to make the race unreachable. It collides with `FR-VAL-03` (*"never silently dropped"*), `FR-CONF-04` (*"unambiguous confirmation of the resulting state"*) and `FR-ADM-10b` (a failure must *"leave the currently approved listing unchanged"*): reporting success while discarding another administrator's accepted change confirms a state that is not the resulting state. A public listing could silently revert to older content, which the public **does** see |
| **E — serialize writes through transaction locking only**, with no persisted token | **Not a candidate**: it answers a question already answered. This *is* `PS-11`, which `ADR-017` already selected, and `ADR-017` states that it *"does **not** detect"* stale input. Choosing it as the stale policy is choosing D while believing otherwise — the most dangerous of the alternatives, because it looks like protection. Carried into the ruling as interpretation 16 |
| **F — Option A for the single-round-trip paths, and no detection at approval** | **Its attraction is real**: zero schema impact, deferring the only column anyone would add. Rejected because it covers the fast races and leaves the **highest-consequence** path open — `OP-10` approval is exactly where stale content becomes **publicly visible**, and it is the only path with a real time gap and a possible second actor. The deferred column costs **nothing** today (no rows exist, no backfill owed) and becomes strictly more expensive once revision rows exist |
| **Resolution by auto-refresh, merge or silent overwrite** (within Option A) | Ruled out by ruling items 2–4. Auto-refresh and merge each decide, on the administrator's behalf, which of two conflicting intents survives; silent overwrite discards accepted work without notice. All three collide with `FR-VAL-03`'s *"preserved for correction"* posture |
| **An administrator override of a detected stale condition** | Ruled out by ruling item 7: **staleness is a concurrency-safety rule, not an ordinary validation rule or a discretionary moderation outcome.** It follows the governed pattern that administrator privilege completes and corrects but never bypasses a safeguard — `FR-ADM-04`'s *"not a validation bypass"* and `ADR-017` Q-4's restrict-never-widen rule. The relief valve is refresh-and-resubmit, which costs one round trip and loses nothing |

## Consequences

**Positive:**

- **Lost-update protection is complete** for the listing's content and status, because every
  accepted change moves the token (`DI-6`) and every comparison is exact (`ADR-022`).
- **No new domain primitive, validator or carrier.** `Instant` already exists as a validated safe
  epoch-millisecond integer with exact equality, and `ADR-022` already guarantees its round trip.
- **It narrows the `PS-11` isolation question instead of enlarging it.** Comparing a captured
  token against a freshly-read row under the lock satisfies `PS-11`'s visibility requirement
  without needing serializable isolation and mandatory retry — though the isolation level
  itself remains undecided (step 5).
- **No backfill is owed.** No revision rows exist, so the token arrives at zero data cost.
- **Deterministic testability.** Injected instants and asserted refusals; no sleeps, no clock-skew
  sensitivity, no concurrency timing. The existing embedded-cluster harness covers the
  integration case.
- **The captured base token is a genuine audit gain**: it records what each proposal was prepared
  against, which nothing recorded before.

**Negative:**

- **`lastUpdatedAt` becomes load-bearing for concurrency control as well as for audit meaning**
  (ruling interpretation 17). Two responsibilities now rest on one datum.
- **The administrator loses work on a conflict** and must refresh and resubmit. This is the
  deliberate cost of refusing to merge or overwrite, and it is bounded at one round trip.
- **Two distinct refusals must be kept distinct in the administrator-facing result** — staleness
  and the `DI-6` same-millisecond timestamp-advancement failure (ruling interpretation 15) — which
  is a messaging obligation the implementation must honour and the tests must prove.
- **Every affected write path gains a required input.** A missing token refuses the write
  (ruling item 12), so the administrator read and write paths are coupled through the token.
- **`OP-10` requires persistence** (ruling item 9), which is what obliges a later token column.

**Reversibility:**

Moderately cheap now and progressively more expensive. **Today** no revision rows exist, so
adopting or abandoning the persisted token is a schema change with **no backfill**. Moving later
to Option B is an **additive** migration beside the token, and the product policy ruled here —
detect, reject, no override, `OP-10` staleness — would **not** change; only the token would.
Moving to Option D would mean deleting protection the governed confirmation posture relies on,
and is therefore the expensive direction. Interpretation 18 fixes the trigger for revisiting:
**if `DI-6` is relaxed, the token policy is reassessed through separately governed work.**

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **`DI-6`/`NFR-DATA-05` holds** — `lastUpdatedAt` moves strictly forward per listing, and `advancedTimestamps` refuses an equal or earlier instant | The token's uniqueness guarantee weakens **silently**: two accepted versions could share a value and a stale write could compare equal. This is exactly why interpretations 17 and 18 are recorded — relaxing `DI-6` requires separately governed reassessment, and Option B is the prepared answer |
| **`ADR-022`'s exact epoch-millisecond round trip holds**, with no silent rounding, truncation or normalisation | Equality comparison stops being sound in one direction and the token could compare unequal to itself. `ADR-022` decisions 13–15 and its required parser tests are the control |
| **Millisecond resolution remains sufficient** for distinguishing successive accepted versions | Unchanged for the token itself, but an `ADR-022` scenario-10 precision widening reaches the domain carrier **and** this policy, and must not be done as a schema-only change |
| **Every participating write path goes through `PS-11`'s lock** before reading the content it will use | A path that skips the lock could read, compare and write across another transaction's commit. `ADR-017` already records this as a risk requiring one protocol for every participating path |
| **Administrator conflicts are infrequent**, so refresh-and-resubmit is an acceptable cost | If conflicts are common, the lost-work cost rises and merge assistance becomes worth reconsidering — a **new product decision**, not an implementation adjustment |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **Staleness and the `DI-6` same-millisecond failure are conflated** in the result the administrator sees | The administrator is told their work is stale when the clock simply did not advance, and refreshes pointlessly — or the reverse | Ruling interpretation 15 makes them **distinct** conditions; the implementation must report them separately and the tests must prove both |
| **A write path omits the token** and the comparison is silently skipped | Exactly the lost update this ADR exists to prevent, with no visible failure | Ruling item 12: a **missing** token refuses the write. Absence is a refusal, never a bypass |
| **The token leaks into a public response** | Internal version state becomes publicly observable, against `DI-10` | Ruling item 13: the token is **never public**. It crosses the administrator boundary only |
| **A later precision or `DI-6` change is made as a local edit** without noticing it reaches concurrency control | The token's guarantee weakens with no decision having been taken | Interpretations 17 and 18 record the dependency explicitly, in this ADR and in `docs/08`'s `DI-6` passage |
| **`PS-11` isolation is selected against a different policy than the one ruled** | Either an isolation level stronger than needed with mandatory retry, or one that does not make post-lock reads observe the preceding commit | Sequencing step 5 places the isolation decision **after** this one, and this ADR selects none of it |
| **Implementation treats this ADR as authorization** | A column, migration or comparison lands without its own review | The status banner, the *Scope* subsection and the sequencing table each state that steps 2–6 are separately authorized |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **The physical column name** | The ruling names the **token** (`lastUpdatedAt`'s value) and **where it must live** (persisted with the revision). It names no column |
| **Column nullability** | Not stated. Nullability depends on the migration shape and on whether the column arrives with the revision-persistence unit — step 2/3 |
| **The migration shape** | No migration is written, authored, named or described. `src/data/migrations/` is unchanged |
| **Legacy / backfill posture** | Recorded only as the **fact** that no revision rows exist today, which is why no backfill is owed. No posture for any future state is selected |
| **`ListingRevision` field representation** | The domain type is **unchanged** by this ADR. That a base token must be persisted is policy; the field's name, optionality and placement are step 4 |
| **API transport mechanics** | The ruling requires the token to cross the administrator boundary and never be public. The wire shape, parameter name, header-or-body carriage and error code are step 4 |
| **`PS-11` isolation level** | Expressly left to step 5. `ADR-017`'s requirement that post-lock checks observe the preceding participant's committed state — or abort and restart — stands unchanged and unselected |
| **Retry policy** | Not selected. The ruling fixes what the **administrator** does on a conflict (refresh and resubmit); whether any layer retries automatically is step 5 |
| **Transaction implementation** | Whether the comparison is a compare-and-swap predicate or an equality check after the `PS-11` lock is left open; both satisfy the ruled policy |
| **Revision and moderation persistence** | `OP-6`, `OP-10`, `FR-ADM-04` and `FR-ADM-10b` remain unimplemented. This ADR adds no persistence and no operation |
| **Provisioning and deployment** | Untouched. No database is contacted, provisioned or configured |
| **`OQ-4` / `S-4` / `DDM-4`** — searchable fields, matching mode, **indexing and text-search strategy** | Unresolved and untouched. **`DDM-4` is indexing and text search; it does not own stale edits**, and this ADR adds no index and makes no search statement |
| **`OQ-14` / `NOQ-8` / `DDM-7` / `S-8`** — audit-entry storage | The captured base token is **not** an audit entry and introduces no audit structure. A refused write leaves no audit record by virtue of this ADR |
| **The public projection form** (view or single `C9` query module) | Untouched; the token is never public, so no public projection changes |
| **`DDM-2`'s** remaining items — domain carrier type, revision identity domain type, public identity transport | Untouched. The token reuses the existing `Instant`; no identity decision is made |
| **`VR-S3`**'s safety and length boundaries | Untouched; no validation rule changes |
| **Replacement-value semantics and restriction-only designation enforcement** (`ADR-017` Q-4) | Still deferred by `ADR-017`. This ADR governs staleness of the **base**, not what counts as a replacement value |
| **`DG-3`, `DG-4`** | Neither is opened, closed or relied upon |

## Traceability

| | |
|---|---|
| **Requirements** | `FR-ADM-04`, `FR-ADM-05`, `FR-ADM-09`, `FR-ADM-10`, `FR-ADM-10b`; `FR-VAL-04`, `FR-VAL-05`; `FR-VAL-03`, `FR-CONF-04` (the no-silent-loss and unambiguous-confirmation posture this resolution answers to); `FR-DATA-11c`; `NFR-DATA-02`, `NFR-DATA-03`, `NFR-DATA-05` |
| **Journeys** | `A3`, `A6` |
| **Components** | `C6` (Moderation Service), `C9` (Listing Repository) — shaped by this policy. `C8` (Identity and Access) — **context only**: it gates the privileged write paths; **no `C8` behaviour changes** |
| **Invariants** | `DI-3`, `DI-6`, `DI-10`, `DI-11`; `BI-3`, `BI-7` — none breached; `DI-6` is relied upon and recorded as load-bearing |
| **Deferred decisions** | **`ADR-017`'s stale-edit/version-token deferral — discharged as to policy and token by this `Accepted` ADR** (2026-10-12, issue #181). **Still outstanding from `ADR-017`:** the **isolation level** for the participating transactions, **replacement-value semantics** and **restriction-only designation enforcement**. `DDM-3`, `DDM-5` discharged elsewhere; **`DDM-4`** and **`DDM-7`** remain open and untouched |
| **Seams** | `S-2`, `S-5`, `S-11` — resolved, preserved. `S-3` resolved. `S-4`, `S-7`–`S-10` — open and untouched |
| **ADRs** | Conforms to `ADR-006` and `ADR-017` (**not superseded** — this fills its deferral); relies on `ADR-022`'s round-trip contract; consistent with `ADR-014`, `ADR-015`, `ADR-016`, `ADR-018`–`ADR-021` |
| **Documents amended** | `docs/adr/README.md` (the register row and count); `docs/05`, `docs/07`, `docs/08`, `docs/09`, `docs/11`, `docs/12`, `docs/13`, `docs/traceability-matrix.md`; `src/data/README.md`; `src/data/migrations/README.md` — current-status statements only |
| **Issue / pull request** | Issue **#181**; the pull request that merges this ADR |
