# `ADR-027` — Run `OP-7`'s approval of a pending submission at explicit PostgreSQL `READ COMMITTED`, locking the listing row before any state read or domain evaluation, requiring the originally viewed `lastUpdatedAt` token, writing status and publication in one guarded statement, with no automatic retry

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-26 (issue #240). The Product Owner's **binding rulings were given on 2026-10-26, before this document was drafted**, and are recorded below |
| **Date** | 2026-10-26 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-26, for `OP-7` only:** rulings **R-1 to R-12** and the token preflight option **PF-A**, as recorded on issue #240 |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision, which governs a persistence protocol and exposes no surface |
| **Related open questions** | **Depends on:** nothing unresolved. Every rule it rests on is already in force — **`ADR-017`** (`DDM-9`, `PS-7`, `PS-8`, `PS-11`), **`ADR-022`** (`timestamptz(3)`, exact epoch-millisecond round trip), **`ADR-023`** (stale-input policy for four paths), **`ADR-024`** (the `READ COMMITTED` lock-first protocol for those four paths), **`ADR-025`** (designations), **`DI-6`/`NFR-DATA-05`** (strictly later instants) and the merged pure-domain `approvePendingListing` (issue #238). **Must NOT answer:** see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* — **`ADR-023`, `ADR-024` and `ADR-026` are neither superseded nor amended.** `ADR-024` assigned *"no isolation level … to any operation outside the four governed write paths"*, and `ADR-026` decided `OP-8` alone; this ADR fills the gap **for `OP-7` alone**. It does **not** add `OP-7` to `ADR-024`'s four paths, extend `ADR-023`'s scope text, or inherit anything from `ADR-026` |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-26 (issue #240). In force; later work may rely on it.**
> **It authorizes no implementation.** No transaction code, SQL, repository operation, failure
> union, test, schema, migration, transport, authentication, authorization, attribution, audit,
> message or UI is created by this document or by its acceptance. `OP-7` persistence is a
> **separate issue that may not begin until this ADR merges**, and the authenticated `OP-7`
> operation boundary is a later unit behind `DG-3`.

---

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

The **binding rulings preceded this draft**.

1. On 2026-10-26 the pure-domain half of `OP-7`, `approvePendingListing`, merged (issue #238,
   PR #239, `6be666b`). It refuses an already-approved source and leaves persistence to a
   separate decision.
2. The same day, a read-only decision Scope Gate set out the options for `OP-7` persistence. The
   Product Owner approved rulings **R-1 to R-12** and authorized issue #240 to record them,
   presenting the token preflight question (**PF**) as a recommendation rather than selecting it.
3. Later on 2026-10-26 the Product Owner selected **PF-A**, and issue #240 was updated to record
   it, with PF-B and PF-C kept as options not selected. The same update qualified R-5, R-7 and
   R-10 so that lifecycle handling and the already-approved path apply only after both preflights
   pass, and replaced R-11's closing sentence with the statement that no timeout policy or
   maximum wait is established. The Product Owner also confirmed that `Accepted` status follows
   this chronology without renewed approval.
4. This document was drafted afterwards, to record those rulings.

Publishing it as `Proposed` would misrepresent the record: nothing is left to propose. This
follows the uniform precedent of **`ADR-019` through `ADR-026`**, each accepted directly for the
same reason.

## Why an ADR, and not implementation notes alone

Applied against *When an ADR is required* (`docs/adr/README.md`):

| Criterion | Why it applies |
|---|---|
| **Structural** | It fixes the transaction semantics of a `C9` write path — isolation, lock placement, the stale comparison and its precedence, the write shape and the retry posture — and it changes `OP-7`'s input contract by adding a required version token. |
| **Costly to reverse** | No data or schema follows from it, but reversing it means re-deriving `OP-7`'s statement sequence and its concurrency tests, and changing the input contract the later operation boundary will rely on. |
| **Cross-cutting** | `OP-7` writes the same pending listing row as `FR-ADM-04` (`ADR-024`) and `OP-8` (`ADR-026`), and it creates the *approved* listings the revision paths act on. How these coordinate is a property of all of them. |
| **Contested** | Each alternative below is a reasonable engineering choice, and the rejected one closest to precedent — no token, as for `OP-8` — must have its reasoning survive on the record (`IR-6`). |

**`IP-9` applies independently.** `ADR-024` states that *"No isolation level is assigned to any
operation outside the four governed write paths"*, and `ADR-026` lists *"`OP-7` isolation,
locking and staleness"* among the questions it must not answer. Implementing `OP-7` persistence
therefore forces a decision the chain has not made. Under `docs/adr/README.md` (*"the ADR merges
first"*), `CONTRIBUTING.md` (*Pull requests that must be split*) and `docs/12` (*Pull-request
strategy*), this ADR merges **before** the code that depends on it.

**Next-number status, confirmed independently.** `ADR-026` is the highest numbered ADR file in
`docs/adr/`, and the string `ADR-027` occurred in no tracked file before this document; the only
reference anywhere was issue #240. The gaps `ADR-004`, `ADR-007`–`ADR-009` and `ADR-011` are
names reserved by `docs/07`, not free numbers. **`ADR-027` is therefore the next unused number**,
taken under *Numbering and filenames*.

## Context

**The operation.** `docs/09` `OP-7` approves a pending submission. Approval sets the status to
*approved* and makes the listing publicly visible **only where every before-approval obligation
is satisfied** (`FR-ADM-06`, `FR-VAL-05`). It is a **single, atomic status transition**
(`NFR-DATA-03`, `DI-3`) that advances `last updated at` to a strictly later instant (`FR-AUD-03`,
`DI-6`). `ADR-017` `DDM-9` fixes that **initial approval sets status to *approved* and publication
state to *publicly available* in the same transaction**, and migration `001`'s
`listing_publication_state_check` requires a publication state **if and only if** the status is
*approved*.

**The domain composition already exists.** `approvePendingListing`
(`src/domain/listing/approval.ts`, issue #238) checks the status set, then the lifecycle, then
`validateBeforeApproval`, then makes one call to
`transitionListingStatus(listing, "approved", at)`. It refuses an already-approved source with
`LISTING_NOT_PENDING { status: "approved" }` and carries content by reference, so every
designation is preserved. The shared transition permits a content-only `approved -> approved`
edge for `OP-10` and `FR-ADM-10b`; the composition guards against it.

**The idempotency promise.** `docs/09`, in its section on idempotency of administrative
operations, commits that approving an already-approved record is **not an error and not a second
transition** — a no-op that returns the current state, with no second audit entry or
last-updated bump. Under the Product Owner's ruling on issue #238 (U-1, Option B), that no-op
belongs to the **future authenticated `OP-7` operation boundary**, not to the domain.

**The rules already in force.**

- `ADR-017` `PS-11` serializes revision work by an exclusive listing-row lock taken first.
- `ADR-024` runs its four governed paths (`OP-6`, `OP-10`, `FR-ADM-04`, `FR-ADM-10b`) at
  `READ COMMITTED`, set explicitly, with the listing-row lock first, the caller's **original**
  token compared and never recaptured, a guarded write whose zero-row outcome is a protocol
  failure, no automatic retry, and a seven-kind failure taxonomy. It assigns **no isolation level
  outside those four paths**.
- `ADR-023` defines stale input for the same four paths: the token is `lastUpdatedAt`, compared by
  exact epoch-millisecond equality; a missing or unequal token refuses the write; no role may
  override it; it is never public; and a timestamp-advancement failure is distinct from stale.
- `ADR-026` decides `OP-8` alone: lock first, no retry, and **no viewed-version token**, because
  rejection publishes nothing.

**Why approval differs from rejection.** `ADR-026`'s reason for carrying no token does not hold
for approval: approval **publishes**. Without a token, an administrator who reviewed a pending
record could approve it after a colleague's `FR-ADM-04` correction committed, publishing content
the approver never reviewed.

**The concurrency neighbourhood.** The writers that change an existing **pending** listing row are
`FR-ADM-04` (`ADR-024`) and `OP-8` (`ADR-026`); both lock that row at their first state read.
`OP-7` becomes a third. The revision paths act only on **approved** listings, so they share no
eligible source with `OP-7`; `OP-9` is unimplemented and also acts only on approved listings.
`ADR-026` records the assumption that every writer of a pending row locks it first, and that the
decision must be revisited if a new writer is added; this ADR keeps `OP-7` consistent with that
assumption.

## Decision

**For `OP-7` — approving a pending submission — and for no other operation, we will:**

1. **Isolation (R-1).** Run each approval in one transaction at PostgreSQL **`READ COMMITTED`, set
   explicitly** on that transaction — never inherited from a server or session default.
2. **Lock (R-2).** Lock the **listing row with `SELECT … FOR UPDATE` as the transaction's first
   state read**, before any status, token or content read and before any domain evaluation, and
   **hold it through transaction completion** (commit or rollback). Domain rules are evaluated
   only against the row read under that lock.
3. **Retry (R-3).** **Not retry automatically.** No failure is retried by the operation; `40001`
   and `40P01` are classified and surfaced to the caller.
4. **Viewed-version token (R-4).** **Require** the listing's `lastUpdatedAt` **as originally
   viewed** by the approving administrator, and compare it with the locked row's current
   `lastUpdatedAt` by **exact epoch-millisecond equality**. A **missing or unequal** token refuses
   the approval as **stale input**: nothing is written, and the administrator must refresh and
   resubmit. The token is **never recaptured, refreshed or replaced** from the row being compared.
   **No role may override it.** It is **never public**. This is `OP-7`'s own rule, applying the
   same semantics as `ADR-023`; it does not amend `ADR-023`.
5. **Token preflight (PF-A).** Before any transaction, read or lock:
   1. a **missing or malformed** token (not a usable instant) is refused as **stale input**;
   2. only then is the approval instant `at` validated, and an unusable instant receives its
      **dedicated invalid-instant refusal**;
   3. only when both pass is the transaction opened.
6. **Precedence under the lock (R-5).** **Lifecycle before token comparison**: an already-approved
   or rejected source is reported as such, never as stale. **Stale before content validation**:
   content the administrator did not review is not judged for them. **Timestamp advancement
   distinct from stale**: a usable, equal token with an `at` that does not advance `lastUpdatedAt`
   is a timestamp-advancement failure, never stale input. **These comparison-stage rules apply only
   after both preflights pass.** A tokenless or malformed-token request never reaches lifecycle
   handling — it receives stale even for an already-approved or rejected record — while a
   **usable but unequal** original token passes preflight and reaches lifecycle handling first.
7. **Write (R-6).** Make **one parameterized guarded `UPDATE`** setting exactly
   `status = 'approved'`, `publication_state = 'publicly_available'` and
   `last_updated_at = at`, with predicates on **identity** (`id`), **pending status**
   (`status = 'pending'`) and the **original token** (`last_updated_at = token`). **No content
   or `*_designated_public` column is written.** Zero affected rows after the lock and checks is a
   **loud protocol failure**, not stale input or a business outcome.
8. **Already approved, in persistence (R-7).** For an already-approved source, return a
   **distinguishable already-approved refusal** and **write nothing** — no status, publication,
   timestamp or content change. This refusal is reached only after both preflights pass.
9. **Already approved, at the operation boundary (R-8).** The **future authenticated `OP-7`
   operation boundary** must turn that refusal into the `docs/09` **current-state no-op**: no
   reapproval, no republication (an unpublished listing stays unpublished), no timestamp advance
   and no duplicate audit effect. This obligation is **required and deferred**; it is **not
   implemented or satisfied** by this ADR or by the persistence slice. **Authorization happens at
   that boundary before persistence is invoked; persistence neither performs nor bypasses it.**
10. **Later-read semantics (R-9).** If the boundary obtains the current state by a **later read**,
    that is **the state at that later read**, not the exact snapshot persistence saw under its
    lock — for example, a publication-state change committed in between is reflected. That is
    acceptable as *current state*.
11. **Repeated invocations (R-10).** Telling a **repeated invocation** (for example a double-click)
    apart from **another administrator's earlier approval** needs **request identity** — some way
    to recognise the same request — **not attribution alone**. Provided each request carries a
    usable token and a usable instant, both cases yield the already-approved refusal and the
    current-state no-op; a tokenless or malformed-token repeat receives stale. Whether and how
    request identity is introduced is **unresolved** and belongs to the later boundary.
12. **Timeouts (R-11).** Production `lock_timeout`, `statement_timeout` and
    `default_transaction_isolation` stay **deferred**, as in `ADR-024` and `ADR-026`. **This
    decision establishes no production timeout policy or maximum wait; database failures remain
    possible.**
13. **Visibility (R-12).** `publicly_available` is **listing-level publication state**, not field
    visibility. Approval **preserves every visibility designation and grants no restricted field
    public visibility** (`ADR-017` Q-4, `ADR-025`).

### Full precedence

1. **Preflight** (no transaction, read or lock): token — missing or malformed is **stale**; then
   instant — unusable is the **invalid-instant** refusal.
2. `BEGIN` at explicit `READ COMMITTED`; then the listing-row `SELECT … FOR UPDATE`.
3. Missing listing; then a row that cannot be read or hydrated.
4. Out-of-set status; then lifecycle — the **already-approved** refusal, or **not pending**
   (rejected).
5. Token comparison: a usable but unequal original token is **stale**.
6. Domain `approvePendingListing`: content invalid; then timestamp advancement.
7. The guarded `UPDATE`: zero affected rows is a **protocol failure**.
8. `COMMIT`.

For a missing or malformed token, every record state — absent (not revealed), pending, approved
and rejected — receives **stale**, and nothing is written.

### Serialized outcomes, operation by operation

Every writer of a pending listing row locks it first, so these interleavings are **serialized**,
not raced. The **holder** is the transaction that acquired the lock first. Each `OP-7` case
assumes the request passed both preflights: a usable original token `t0` and a usable instant.

| Interleaving | Outcome |
|---|---|
| **`OP-7` vs `OP-7`** (two approvals, both viewed `t0`) | If the holder's checks pass and it commits an approval, the waiter, after the lock, finds *approved* and receives the **already-approved refusal** (lifecycle before token); there is no second write. If the holder is refused or rolls back, the waiter proceeds as in the rollback row. |
| **`OP-8` holds and commits a rejection** | `OP-7` finds *rejected* and receives the **not-pending refusal (rejected)**. Nothing written. |
| **`OP-7` holds and commits; then `OP-8`** | `OP-8` finds *approved* and refuses under `ADR-026`, unchanged. |
| **`FR-ADM-04` holds and commits an edit (`t0` → `t1`)** | `OP-7` finds *pending* with `t0` ≠ `t1` and receives **stale**, so this approval does not publish the edited content the approver did not review. |
| **`OP-7` holds and commits; then `FR-ADM-04`** | `FR-ADM-04` finds *approved* and refuses on lifecycle, before its token, under `ADR-024`, unchanged. |
| **Any holder rolls back** | The row is unchanged, so `OP-7` evaluates it as it was: with an equal token the approval may proceed, subject to content and timestamp rules and to the database failures described below. |
| **Revision paths** (`OP-6`, `OP-10`, revision rejection, `FR-ADM-10b`) | They act only on *approved* listings. Before `OP-7` commits they refuse the pending listing; afterwards they **may proceed, subject to their own checks** under `ADR-024`. No shared eligible source. |
| **`OP-9`** | Unimplemented, and applies only to approved listings. No interleaving is defined here. |
| **Tokenless or malformed-token `OP-7`, any record** | **Stale** before any transaction, read or lock; no interleaving with any other writer. A usable token with an unusable `at` receives the invalid-instant refusal, also before any transaction. |
| **Same administrator: edit, then approve** | The edit advances `lastUpdatedAt`. The approval must carry the version viewed **after** that edit, or it is stale. Supplying that version is the later boundary's concern. |

These outcomes describe ordering, not timing. **Nothing here promises that an approval waits for a
bounded time, eventually succeeds, or is free from deadlock** — see below.

### Commit and error limitations

- **No bound on waiting is decided.** A waiter blocks while another transaction holds the row
  lock, until the lock is released or the wait ends in a database failure such as cancellation or
  connection loss. No timeout is decided (R-11), so this ADR sets no maximum wait.
- **Deadlock is not ruled out.** Every listing writer locking the same row first helps coordinate
  them, but consistent locking does **not** guarantee freedom from deadlock — for example, a path
  that acquires other locks in a different order could deadlock with `OP-7`. A `40P01` is
  classified and surfaced, **never retried**, and treated as a signal to investigate lock order.
- **Other database failures remain possible**, including a serialization failure (`40001`),
  statement cancellation, administrator-terminated backends and connection loss. Each is
  classified and surfaced, not retried.
- **A failed or indeterminate `COMMIT`.** If the connection is lost or the commit fails in a way
  that leaves its outcome unknown, the operation cannot know whether the approval took effect, and
  **this ADR guarantees neither outcome**. How such an outcome is classified is left to the
  implementing unit, within `ADR-024`'s failure taxonomy, as issue #234 did for `OP-8`. Nothing
  here retries automatically (R-3). If a caller later resubmits, it must still carry the
  **original** token (R-4), and the row's then-current state, read under the lock, and the existing
  checks determine the outcome. If the first approval committed **and** the row is still
  *approved* when the resubmission reads it, the resubmission receives the already-approved
  refusal rather than a second approval (R-5, R-7). If the row has since changed — or the first
  attempt did not take effect — its then-current state and the existing checks decide: for
  example, a still-pending row with an unchanged `lastUpdatedAt` may be approved under the normal
  rules, while other states lead to stale or the not-pending refusal. That later read shows only
  the current state; **it does not prove which invocation, if any, committed** an earlier
  approval.

### Left to the implementing unit

Within the rules above, the persistence issue decides:

- the failure-code names;
- the statement text, as a local parameterized statement, on the `OP-8` precedent, because
  `listing-table.ts` types `status` and `publication_state` as not updatable;
- the tests;
- whether a `listing_revision` read is made — recommendation: **none**, on the `OP-8` precedent,
  because pending listings carry no revisions;
- reconciling the `listing-table.ts` comment that attributes `publication_state` to `OP-9` alone,
  although initial approval writes it under `ADR-017`.

## Alternatives considered

None of these is technically invalid; each is recorded with why it was not selected (`IR-6`).

| Alternative | Why it was not selected |
|---|---|
| **A — `SERIALIZABLE`**, with or without an explicit lock or bounded retry | It guarantees that committed transactions behave as if run in some serial order, which is a real strength. It does not by itself establish application correctness, and under conflict PostgreSQL may abort with `40001`, which needs a retry policy R-3 rules out. It would also differ from the `READ COMMITTED` protocol `FR-ADM-04` and `OP-8` run on the same row. Not selected: the ruling chose explicit `READ COMMITTED` with the row lock, consistent with the other listing writers. |
| **B — A single guarded `UPDATE` with no prior lock** | Atomic and race-free for the predicates it carries, and the simplest mechanism. But it moves the decision into SQL: content validation (`validateBeforeApproval`) cannot be expressed as a predicate, and reporting *which* rule refused would need further design. Not selected: the ruling keeps the domain as the sole evaluator, run once against locked current state. |
| **C — An unlocked read, domain evaluation, then a guarded `UPDATE`** | The final statement still takes the row lock, but the earlier read and decision are not protected: the domain can decide on stale state, detected only afterwards as a zero-row outcome. It also coordinates differently from `FR-ADM-04` and `OP-8`. Not selected. |
| **D — `FOR UPDATE NOWAIT` or `SKIP LOCKED`** | Both avoid waiting. They turn ordinary contention into a failure or an absence-like outcome, and that behaviour has not been ruled. Not selected. |
| **E — A transaction-scoped advisory lock** | Coordinates only the transactions that take it. The existing listing writers take the **row** lock, so an advisory lock alone would not protect `OP-7`'s read and evaluation from them. Not selected. |
| **F — No viewed-version token, as for `OP-8`** | Simpler, and consistent with `ADR-026`. But a colleague's edit committed after the approver's review would be **published without review**. `ADR-026`'s reason for omitting a token — rejection publishes nothing — is inverted for approval. Not selected. |
| **G — An optional token** | Gives protection only to callers that send it, which is no protection for those that omit it. Not selected. |
| **H — Token comparison before lifecycle** | Makes every stale case uniform. But a double-click would be reported as *stale* rather than reaching the `docs/09` no-op, because the first approval moves `lastUpdatedAt`. Not selected (R-5). |
| **I — Content validation before the stale check** | Reports defects in content the administrator never reviewed, instead of asking them to refresh. Not selected (R-5). |
| **J — Separate statements for status and publication state** | Each statement is simpler, and inside one transaction the two changes would still become visible to other transactions together, at commit, so this is not a visibility problem. The costs are elsewhere: `listing_publication_state_check` is checked per statement (PostgreSQL `CHECK` constraints are not deferrable), so writing status alone, or publication state alone, leaves the row violating it and would be refused; and each extra guarded statement adds its own zero-row and failure outcomes to classify and coordinate. One statement satisfies the check as written. Not selected (R-6). |
| **K — Persistence performs the no-op**, returning success with the locked snapshot | Gives the boundary everything in one call. But it puts response semantics in persistence, ahead of authorization, and has a refusal path carry a listing, against the domain convention. Not selected (R-7, R-8). |
| **L — Bounded automatic retry** on `40001`/`40P01` | A legitimate policy. Not selected (R-3), consistent with `ADR-024` and `ADR-026`. A later ruling could adopt it, provided any retry reuses the **original** token and never recaptures it. |
| **PF-B — Carry a missing token into the transaction**, treating it as unequal after lifecycle | Answers by actual record state, including the no-op for an approved record. But it takes the row lock for a request that can never succeed on a pending record, and the token rule then depends on lock state. Not selected (PF-A chosen). |
| **PF-C — A distinct preflight code for a missing token** | Separates a caller error from staleness. But it splits `ADR-023`'s *missing or unequal* class into two outcomes, and needs its own message ruling. Not selected (PF-A chosen). |

## Consequences

**Positive:**

- **Content changed after review is not published by the approval.** This is the intended
  protection, and it holds when every writer that changes the listing advances `lastUpdatedAt`
  (`DI-6`) and the approved protocol is correctly implemented: a colleague's committed edit then
  makes the approver's token unequal, so the approval is refused as stale.
- `OP-7` locks the **same listing row**, at its **first state read**, as `FR-ADM-04` and `OP-8`,
  so the writers of a pending row coordinate on one lock, consistent with `ADR-026`'s assumption.
- The domain remains the **sole evaluator** of lifecycle, content and timestamp rules, run once
  against locked current state; no rule is duplicated in SQL.
- Status and publication state are written together in one statement inside one transaction,
  which the store's publication-state check requires and which keeps the approval atomic (`BI-7`).
- No content or designation column is written, so the approval itself does not change field
  visibility.
- The `docs/09` no-op is placed explicitly at the authenticated boundary rather than left
  implicit.

**Negative:**

- **The input contract grows.** Every `OP-7` caller must carry the originally viewed version, and
  the later boundary must capture and supply it.
- **A tokenless retry on an approved record gets *stale*, not the no-op** (PF-A); the administrator
  must refresh to see the approval.
- **An approval may wait** behind any transaction holding the listing-row lock, with no decided
  bound, and database failures — including deadlock — remain possible.
- **A legitimate correction after review forces a refresh.** The approver must re-review the
  edited record before approving.
- Readers of the listing-row protocol must now consult `ADR-024`, `ADR-026` and this ADR.

**Reversibility:**

- **Cheap to moderate.** No schema, data or migration follows from this decision. Reversing it
  means a superseding ADR, a re-derived statement sequence and rewritten concurrency tests, and —
  for the token — changing the input contract the operation boundary relies on. Adopting retry
  later would not require changing the other rulings.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| Every writer that changes a **pending** listing row — `FR-ADM-04`, `OP-8` and now `OP-7` — takes the listing-row lock at its first state read | A writer that reads first can decide on stale state; this decision must be revisited together with that path. |
| The revision paths act only on **approved** listings | A path writing revisions against pending listings would need its coordination with `OP-7` decided. |
| `lastUpdatedAt` advances strictly on every content or status change (`DI-6`, `NFR-DATA-05`) and round-trips exactly (`ADR-022`) | The token would stop identifying a version; `ADR-023` items 17–18 already require reassessment if `DI-6` is relaxed. |
| Under PostgreSQL `READ COMMITTED`, statements after the lock see data committed before each began | Post-lock reads could act on stale state; the protocol would need re-deriving. |
| The later authenticated boundary will capture and supply the originally viewed version, and authorize before calling persistence | Without it, every approval is stale, or authorization could be bypassed; that boundary's scope must carry both. |
| `PA-1`: first-release load is small, so waiting on a held lock is acceptable | Contention handling and the deferred timeout settings would need deciding. |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| A future writer of the listing row skips the early lock | Its decisions can rest on state `OP-7` has since changed | This ADR names the obligation; each implementing unit carries concurrency tests and reviews lock order. |
| The token is recaptured from the row (for example, in a retry or by a convenience helper) | Staleness detection silently disappears | Forbidden by R-4; the persistence unit must attack it with a test. |
| The already-approved refusal is surfaced as an error by the future boundary | The `docs/09` no-op promise is broken | R-8 makes the no-op a **required** obligation of that boundary's scope. |
| A long-held lock stalls approvals | No decided timeout limits the wait | Timeouts remain a separate deferred decision; contention is observable through `pg_locks` and `pg_stat_activity`. |
| A deadlock arises from a future path's lock order | `OP-7` fails with `40P01`, not retried | Treated as a signal to investigate lock order. |
| An indeterminate `COMMIT` is reported as success or as ordinary failure | The caller acts on a false belief about publication | The implementing unit decides its classification within `ADR-024`'s taxonomy. A caller resubmission (never automatic) carries the original token. If the first approval committed **and** the row is still *approved* when the resubmission reads it, the resubmission receives the already-approved refusal rather than a second approval; if the row has since changed, its then-current state and the existing checks determine the outcome. The later read does not prove which invocation committed. |
| `OP-7` is mistaken for one of `ADR-024`'s governed paths, or `ADR-026`'s no-token policy is assumed to apply | A reader expects the wrong token behaviour | This ADR, its register row and its matrix row each state that it is `OP-7` only and inherits nothing from `ADR-026`. |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OP-9`** publication-state change | Not decided. |
| **Purge** (`PS-10`) | Not decided. |
| **Server `lock_timeout`, `statement_timeout`, `default_transaction_isolation`** | Still deferred (R-11). Isolation is set per transaction precisely so no server default is relied on. |
| **Attribution and review data** (`S-7`/`S-8`) | No actor, role or reviewer field is named; the protocol carries none. |
| **Authentication and authorization** (`NOQ-9`, `DG-3`) | Placed at the later boundary (R-8); nothing here performs or bypasses it. |
| **Audit** (`OQ-14`/`NOQ-8`, `IR-7`) | No audit entry is named or implied; *no duplicate audit effect* binds the boundary only if audit exists. |
| **`FR-CONF-02` confirmation messaging** | Not decided; the boundary's concern. |
| **The request-identity mechanism** (R-10) | Recorded as unresolved. |
| **`OP-8`'s already-rejected treatment** (#234) | Not decided; assessed separately. |
| **Failure-code names, statement text, tests** | Left to the persistence issue, within the rules above. |

## Traceability

| | |
|---|---|
| **Requirements** | `FR-ADM-06`, `FR-VAL-05`, `FR-MOD-01`, `FR-AUD-01`, `FR-AUD-03`, `NFR-DATA-02`, `NFR-DATA-03`, `NFR-DATA-05` |
| **Journeys** | `A4` |
| **Operations** | `OP-7` |
| **Components** | `C6` (Moderation Service — the only writer of status), `C9` (Listing Repository) |
| **Invariants** | `BI-6`, `BI-7`, `BI-8`, `DI-1`, `DI-2`, `DI-3`, `DI-5`, `DI-6` — none is upgraded by this document |
| **Related decisions** | `ADR-017` (`DDM-9`, `PS-7`, `PS-8`, `PS-11`), `ADR-022`, `ADR-023`, `ADR-024`, `ADR-025`, `ADR-026` — none amended or superseded |
| **Documents amended** | `docs/adr/README.md` (the in-force paragraph and one register row), `docs/traceability-matrix.md` (one ADR row) and `docs/09-api-design.md` (the `OP-7` *Provides* and *Errors / empty states* cells), in the same pull request (`IP-9`). The `docs/09` idempotency clause, the issue #238 status paragraph and every accepted ADR body are unchanged |
| **Issue / pull request** | Issue #240; the pull request number is supplied on merge. `OP-7` persistence is a separate issue, blocked until this ADR merges |
