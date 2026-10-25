# `ADR-026` — Run `OP-8`'s rejection of a pending submission at explicit PostgreSQL `READ COMMITTED`, locking the listing row before any domain evaluation, with no automatic retry and no viewed-version token

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-25 (issue #235). The Product Owner's **binding ruling was given on 2026-10-25, before this document was drafted**, and is recorded below |
| **Date** | 2026-10-25 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-25, for `OP-8` only:** **explicit `READ COMMITTED`** on each `OP-8` transaction; the **listing row locked with `SELECT … FOR UPDATE` before any domain evaluation**, held to commit or rollback; **no automatic retry**; and **no viewed-version token** |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision, which governs a persistence protocol and exposes no surface |
| **Related open questions** | **Depends on:** nothing unresolved. Every rule it rests on is already in force — **`ADR-017` `PS-7`** (status as a checked datum), **`PS-9`** (a write-once rejection timestamp present **iff** *rejected*) and **`PS-11`** (the listing-row lock taken first); **`ADR-022`** (`timestamptz(3)`, exact epoch-millisecond round trip); **`ADR-023`** (staleness defined for four paths); **`ADR-024`** (the `READ COMMITTED` lock-first protocol for those four paths); **`DI-6`/`NFR-DATA-05`** (strictly later instants). **Must NOT answer:** `OP-7`, `OP-9` or purge; the server settings `statement_timeout`, `lock_timeout` and `default_transaction_isolation`; attribution and review data (`S-7`/`S-8`); authentication (`NOQ-9`); audit (`OQ-14`/`NOQ-8`); the moderation note (`FR-ADM-08`); the implementation itself |
| **Supersedes** | *none* — **`ADR-024` is neither superseded nor amended.** It assigned *"no isolation level … to any operation outside the four governed write paths"*; this ADR fills that gap **for `OP-8` alone** and does **not** add `OP-8` to those four paths. `ADR-017` and `ADR-023` are likewise neither superseded nor amended |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-25 (issue #235). In force; later work may rely on it.**
> **It authorizes no implementation.** No transaction code, SQL, repository operation, failure
> union, test, transport, authorization, message, audit, schema, migration or deployment is
> created by this document or by its acceptance. `OP-8` persistence is issue #234, which
> **may not begin until this ADR merges**.

---

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

The **binding ruling preceded this draft**.

1. On 2026-10-25, during the Scope Gate review of issue #234 (*persist rejection of a pending
   listing submission*), the Product Owner approved the decisions that issue records as **D-1**
   (explicit isolation, the listing-row lock, no retry) and **D-2** (no stale-token
   comparison). #234's item **U-1** asked that the **lock-first** form of D-1 be confirmed.
   **That request was redundant:** the lock-first choice had already been explicitly approved,
   and it is not an unresolved decision.
2. On the same day, in authorizing issue #235, the Product Owner restated the four items —
   **explicit `READ COMMITTED`**, **listing-row `FOR UPDATE` before domain evaluation**, **no
   retry**, **no viewed-version token** — as already approved. Issue #235 records them as a
   binding ruling that it does not reopen.
3. This document was drafted afterwards, to record that ruling.

Publishing it as `Proposed` would misrepresent the record: there is nothing left to propose. This
follows the uniform precedent of **`ADR-019` through `ADR-025`**, each accepted directly for the
same reason.

## Why an ADR, and not implementation notes alone

Applied against *When an ADR is required* (`docs/adr/README.md`):

| Criterion | Why it applies |
|---|---|
| **Structural** | It fixes the transaction semantics of a `C9` write path — the isolation level, where the lock is taken relative to domain evaluation, and whether retry exists on it. |
| **Costly to reverse** | Modestly: no data or schema follows from it, but reversing it means re-deriving `OP-8`'s statement sequence and rewriting its concurrency tests. |
| **Cross-cutting** | `OP-8` writes the same listing row as `FR-ADM-04`, whose `ADR-024` protocol locks that row first; how the two coordinate is a property of both. |
| **Contested** | Each alternative below is a reasonable engineering choice; the reasoning for the selected one must survive on the record (`IR-6`). |

**`IP-9` applies independently.** `ADR-024` states that *"No isolation level is assigned to any
operation outside the four governed write paths"*, so implementing `OP-8` forces a decision the
chain did not make. Under `docs/adr/README.md` (*"the ADR merges first"*), `CONTRIBUTING.md`
(*Pull requests that must be split*) and `docs/12` (*Pull-request strategy*), this ADR merges
**before** the code that depends on it.

**Next-number status, confirmed independently.** `ADR-025` is the highest numbered ADR file in
`docs/adr/`, and the string `ADR-026` occurred nowhere in the repository before this document;
the only reference anywhere was issue #235. **`ADR-026` is therefore the next unused number**,
taken under *Numbering and filenames*.

## Context

**The operation.** `docs/09` `OP-8` rejects a pending submission. It is a **single, atomic status
transition** (`NFR-DATA-03`, `DI-3`), and it records a **write-once rejection timestamp in the
same transition**, separate from last-updated and used only for retention eligibility
(`FR-AUD-06`). Rejection is **terminal** (`FR-ADM-07`): `NFR-DATA-02` permits no transition out
of *rejected*. The status change advances `last updated at` to a **strictly later** instant
(`FR-AUD-03`, `DI-6`).

**The rules already in force.**

- `ADR-017` `PS-7` makes status a mandatory datum under a store check; `PS-9` makes the rejection
  timestamp present **iff** *rejected* and immutable on the write path; `PS-11` serializes
  revision work by an exclusive listing-row lock taken **before** any check or content read.
- `ADR-024` runs its **four governed paths** — `OP-6`, `OP-10`, `FR-ADM-04` and `FR-ADM-10b` —
  at `READ COMMITTED`, set explicitly, with the listing-row lock first and no automatic retry.
  It assigns **no isolation level outside those four paths**.
- `ADR-023` confines staleness to the same four paths, and notes that *"`OP-7`, `OP-8` and
  `OP-9` matter only because their status transitions move `lastUpdatedAt` beneath a listing an
  administrator may already have open."*
- The domain's `transitionListingStatus` is the authority on the permitted pair, the strictly
  later instant and the write-once anchor.

**The concurrency neighbourhood.** The only implemented writer that changes an existing **pending** listing row is
`FR-ADM-04` (issue #217), which locks that row first and compares a captured token. The revision
paths (`OP-6`, `OP-10`, revision rejection, `FR-ADM-10b`) act only on **approved** listings, so
none of them can act on the same pending row as `OP-8`. No data-layer code changes the status of an existing listing today;
`src/data/listing-table.ts` reserves that column for `OP-7`/`OP-8`.

## Decision

**For `OP-8` — rejecting a pending submission — and for no other operation, we will:**

1. **Run each rejection in one transaction at PostgreSQL `READ COMMITTED`, set explicitly on
   that transaction** — never inherited from a server or session default.
2. **Lock the listing row with `SELECT … FOR UPDATE` as the transaction's first state read,
   before any domain evaluation**, and hold that lock until commit or rollback. Domain rules are
   evaluated **only** against the row read under that lock.
3. **Not retry automatically.** No failure is retried automatically by the operation;
   `40001` and `40P01` in particular are classified and surfaced to the caller. Whether to retry
   is a **separate policy choice**, and this decision makes it *no*.
4. **Carry and compare no viewed-version, captured or base-version token.** A rejection of a
   pending record that changed after the administrator viewed it proceeds, subject to the domain
   rules evaluated on the locked, current row.

**Scope.** `OP-8` only. It is **not** one of `ADR-024`'s four governed paths, and it does not
extend `ADR-023`'s staleness policy. **No accepted ADR body is amended**: `ADR-024`, `ADR-017`
and `ADR-023` stand unchanged, and none is superseded. `OP-7`, `OP-9`, purge (`PS-10`) and every
other operation remain undecided by this ADR.

**Left to the implementing unit (issue #234).** The statement shape of the write after the lock,
the failure-code names and the tests — provided they observe items 1–4.

## Alternatives considered

None of these is technically invalid; each is recorded with why it was not selected (`IR-6`).

| Alternative | Why it was rejected |
|---|---|
| **A1 — A single guarded `UPDATE` carrying the transition in its predicate** (`status = 'pending'` and a strictly later instant), with `READ COMMITTED` still set explicitly | **The `UPDATE` itself takes the row lock.** Under `READ COMMITTED`, if the row is being changed concurrently it waits, then re-evaluates its predicate against the newly committed row version, so it is atomic and race-free **for the predicates it carries**. The distinction this decision draws is **not** whether row locks are taken — an `UPDATE` still acquires them — but **locking before reading and evaluating domain rules**. A1 has no earlier read, so it avoids a stale decision only by moving the whole decision into the statement: it re-expresses the permitted pair, the instant rule and the write-once anchor as SQL predicates — a second copy of governed domain rules. An unsatisfied predicate returns zero affected rows; reporting *which* rule refused would need further design, for example a follow-up read or a statement that returns the observed state. **That is a design tradeoff, not an inability of SQL to return richer information.** Not selected: the ruling keeps the domain as the sole evaluator, run once against locked current state. |
| **A2 — An unlocked read, domain evaluation, then a guarded `UPDATE`** | The eventual `UPDATE` still acquires the row lock, but **write locking alone does not protect the earlier read, evaluate and write sequence**: reading without an early lock can leave the domain decision based on **stale state**, because no concurrent writer is held off between the read and the write. The guard can only detect such an interleaving afterwards, as a zero-row outcome, which the operation must classify; under a no-retry policy that becomes a caller-visible failure, whereas the lock-first design evaluates the domain only after acquiring the lock, on current state. It also coordinates on the row differently from `FR-ADM-04`, which locks at its first read. Not selected, for the same reason as A1. |
| **B — `SERIALIZABLE`**, with or without an explicit lock | It guarantees that concurrently committed transactions behave as if run in some serial order. **It does not by itself establish application correctness**: the domain rules must still be evaluated against the right state and written correctly, and the store constraints still enforce the invariants. Under conflict PostgreSQL may abort a transaction with `40001`; **whether to retry is a separate policy choice**, and under item 3 such an abort is surfaced, not retried. **The serialization failures each design can produce may differ, but `READ COMMITTED` with explicit locking is not guaranteed merely to wait or succeed either**: a lock-first rejection can still fail — for example with `40P01` in a deadlock — and is then classified and surfaced in the same way. It would also differ from the `READ COMMITTED` protocol `ADR-024` runs on the same row; PostgreSQL permits mixing levels, but cross-path reasoning would no longer rest on one protocol. Not selected: the ruling chose `READ COMMITTED` with an explicit row lock, consistent with `FR-ADM-04`. |
| **C — A captured viewed-version token, as `ADR-023` uses for its four paths** | It would detect that the record changed since the administrator viewed it, and require a refresh. Not selected by **ruling item 4**: rejection publishes nothing (`DI-5`), and a token would refuse a rejection made after a colleague's legitimate correction. `ADR-023` confines staleness to its four paths, and this ADR does not extend it. |
| **D — `FOR UPDATE NOWAIT` or `FOR UPDATE SKIP LOCKED`** | Both avoid waiting. `NOWAIT` raises an error at once if the row is locked; `SKIP LOCKED` returns no row, which the operation would have to distinguish from absence. Each turns ordinary contention into a failure or an absence-like outcome, and that behaviour has not been ruled. Not selected: the ruling chose to wait. |
| **E — A transaction-scoped advisory lock keyed by listing identity** | An advisory lock coordinates **only the transactions that take it**, so it serializes correctly **provided every conflicting writer participates in the same advisory-lock protocol**. The existing listing writers (`FR-ADM-04` and the `PS-11` paths) do not: they take the **row** lock. Their eventual `UPDATE` statements, like `OP-8`'s, still acquire row locks, but **an advisory lock alone does not coordinate `OP-8`'s earlier read and domain evaluation with writers outside that protocol**, so its decision could rest on stale state. Closing that gap would require `OP-8` also to take the row lock before reading, or every listing writer to adopt the advisory-lock protocol — two lock kinds whose acquisition order must then be kept consistent across paths. Advisory locks do not inherently cause deadlocks; here they add a coordination obligation. Not selected: the ruling uses the same row lock as the existing writers. |
| **F — Bounded automatic retry on `40001`/`40P01`** | A legitimate policy, and one a reasonable engineer might pair with `SERIALIZABLE`. Not selected by **ruling item 3**, consistent with `ADR-024`'s posture; a later ruling could adopt retry without changing items 1, 2 or 4. |

## Consequences

**Positive:**

- `OP-8` locks the **same listing row**, at its **first state read**, as the existing listing
  writers do. **This consistent listing-row locking supports serialization with those
  writers**, and checks made after the lock observe the preceding holder's committed state.
- The domain remains the **sole evaluator** of lifecycle rules and instants, run once against
  locked current state; no rule is duplicated in SQL.
- No retry machinery is introduced, and no token is carried, persisted or compared.
- `ADR-024`, `ADR-017` and `ADR-023` are untouched, so their records remain accurate history.

**Negative:**

- A rejection **waits** behind any transaction holding the listing-row lock. No lock or
  statement timeout is decided — those server settings remain deferred — and this ADR
  establishes no maximum wait duration.
- **Consistent row locking does not guarantee freedom from all deadlocks.** A future path that
  acquires other locks in a different order could still deadlock with `OP-8`. A `40P01` is
  classified and surfaced, **never retried**.
- An administrator may reject content that changed after they viewed it. Rejection is
  **terminal** (`FR-ADM-07`), so a submission corrected in the interval cannot be revived; a
  fresh submission is required. This is accepted by ruling item 4.
- One more write path follows the `PS-11` lock-first shape **outside** `ADR-024`'s enumeration,
  so a reader of the listing-row protocol must consult both ADRs.

**Reversibility:**

- **Cheap to moderate.** No schema, data or migration follows from this decision. Reversing it
  means a superseding ADR, a re-derived `OP-8` statement sequence and rewritten concurrency
  tests. Adopting retry later (alternative F) would not require changing items 1, 2 or 4.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| Every writer that changes a **pending** listing row takes the listing-row lock at its first state read — today, `FR-ADM-04` alone | That writer's earlier reads and decisions are not coordinated with `OP-8`, even though its eventual `UPDATE` still takes the row lock; this decision must be revisited together with the new path. |
| The revision paths act only on **approved** listings, so none can act on the same pending row as `OP-8` | A path writing revisions against pending listings would need its coordination with `OP-8` decided. |
| Under PostgreSQL `READ COMMITTED`, statements after the lock see data committed before each began — the basis `ADR-024` states | Post-lock reads could act on stale state; the protocol would need re-deriving. |
| Rejection has no public effect (`DI-5`, `FR-ADM-07`) | Ruling item 4 — no viewed-version token — would need to be reconsidered. |
| `PA-1`: first-release load is small, so waiting on a held lock is acceptable | Contention handling and the deferred timeout settings would need deciding. |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| A future writer of the listing row skips the early row lock, or takes it only after reading | Its decisions can rest on stale state that `OP-8` has since changed, even though its eventual `UPDATE` still takes the row lock | This ADR names the obligation; each implementing unit carries concurrency tests against `OP-8` and reviews lock order. |
| Another transaction holds the listing-row lock for a long time | Rejections stall, with no timeout | Timeout settings remain a separate deferred decision; contention is observable through `pg_locks` and `pg_stat_activity`. |
| A deadlock arises from a future path's lock order | `OP-8` fails with `40P01`, not retried | Treated as a signal to investigate lock order, as `ADR-024` treats it, not as an ordinary outcome. |
| An administrator rejects a submission that was corrected after they viewed it | A terminal rejection of content they did not see | Accepted by ruling item 4; the lister's remedy is a fresh submission. |
| `OP-8` is mistaken for one of `ADR-024`'s governed paths | A reader expects a token comparison that does not exist | This ADR, its register row and its matrix row each state that it is not one of those paths. |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OP-7`** isolation, locking and staleness | Not decided. `OP-7` publishes, so its staleness posture is a separate ruling; nothing here is precedent for it. |
| **`OP-9`** publication-state change | Not decided. |
| **Purge** (`PS-10`; `OQ-13` scheduling) | Not decided. Only the write-once anchor `PS-9` already requires is relied on. |
| **Server `statement_timeout`, `lock_timeout`, `default_transaction_isolation`** | Still deferred by `ADR-024`. Item 1 sets isolation per transaction precisely so that no server default is relied on. |
| **Attribution and review data** (`S-7`/`S-8`); **authentication** (`NOQ-9`, `DG-3`) | No actor, role, reviewer field or credential is named; the protocol carries none. |
| **Audit** (`OQ-14`/`NOQ-8`, `IR-7`) | No audit entry is named or implied. |
| **The moderation note** (`FR-ADM-08`) | Not named; no field is introduced. |
| **Failure-code names and statement shape** | Left to issue #234, within items 1–4. |

## Traceability

| | |
|---|---|
| **Requirements** | `FR-ADM-07`, `FR-AUD-01`, `FR-AUD-03`, `FR-AUD-04`, `FR-AUD-06` (the rejection timestamp only), `NFR-DATA-02`, `NFR-DATA-03`, `NFR-DATA-05` |
| **Journeys** | `A5` |
| **Components** | `C6` (Moderation Service — the only writer of status), `C9` (Listing Repository) |
| **Invariants** | `BI-7`, `BI-8`, `DI-1`, `DI-2`, `DI-3`, `DI-6` |
| **Related decisions** | `ADR-017` (`PS-7`, `PS-9`, `PS-11`), `ADR-022`, `ADR-023`, `ADR-024` — none amended or superseded |
| **Documents amended** | `docs/adr/README.md` (the in-force paragraph and one register row) and `docs/traceability-matrix.md` (one ADR row), in the same pull request (`IP-9`). No accepted ADR body is amended. `OP-8`'s implementation status is recorded by issue #234 when it lands |
| **Issue / pull request** | Issue #235; the pull request number is supplied on merge. Implementation: issue #234, blocked until this ADR merges |
