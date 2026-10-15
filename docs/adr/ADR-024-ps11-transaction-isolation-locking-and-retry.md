# `ADR-024` — Run every governed revision and administrative write at PostgreSQL `READ COMMITTED` under the `PS-11` listing-row lock, with an explicit captured-token comparison before any mutation and no automatic application-level retry

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-14 (issue #189). The Product Owner's **binding ruling was given on issue #189 before this document was drafted**, and is recorded below |
| **Date** | 2026-10-14 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-14:** approve the complete recommended package — PostgreSQL **`READ COMMITTED`**, set **explicitly per transaction**; `ADR-017`'s **`PS-11` protocol** applied as written, with an exclusive `SELECT … FOR UPDATE` on the **listing row first**, before any pending-revision check or content read, **held through commit**; **all relevant reads after the lock**; the **exact captured-token comparison before any mutation**; the **original token carried in the guarded listing-write predicate**, with the **affected-row count participating in the correctness check**; **no automatic application-level retry**, with **only `40001` and `40P01`** classified retryable and **no additional retryable cases invented**; a retry must **reuse, reread and recompare** the original token and may **never** follow an external side effect; the complete **seven-way failure taxonomy**, with a **same-millisecond `DI-6` failure distinct from staleness**; and **one protocol for all four governed write paths**, `listing` before `listing_revision`, ascending listing identifier where an operation ever spans several |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision |
| **Related open questions** | **Depends on:** nothing unresolved. Every rule it rests on is already in force — **`ADR-017` `PS-11`** (per-listing serialization and its visibility requirement; issue #137), **`ADR-017` `DI-11`** (at most one pending revision, as a conditional uniqueness constraint), **`ADR-017` Q-1/Q-2/Q-3** (write-once rejection anchors; no approved revision row persists), **`ADR-022`** (`timestamptz(3)` and the exact epoch-millisecond round trip; issue #169), **`ADR-023`** (the stale-edit policy and the captured token; issue #181), **`DI-6`/`NFR-DATA-05`** (strictly-increasing `lastUpdatedAt`). **Must NOT answer:** the **transaction implementation** itself; **revision and moderation persistence** (`OP-6`, `OP-10`, `FR-ADM-04`, `FR-ADM-10b` and their tests); revision **serialization and hydration**; the **administrator conflict message** and **API transport mechanics**; **retry attempt count, backoff and jitter** values; the **production PostgreSQL version**; **provisioning, credentials, pool, TLS, secret and environment configuration**; `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` and `default_transaction_isolation` **server settings**; **`OQ-4`/`S-4`/`DDM-4`** searchable fields, indexing and text search; **`OQ-14`/`NOQ-8`/`DDM-7`/`S-8`** audit-entry storage; the **public projection form**; **replacement-value semantics** and the **restriction-only designation** (`ADR-017` deferrals); `DG-3`, `DG-4` |
| **Supersedes** | *none* — `ADR-017` is **not** superseded. It **deferred** this decision deliberately, recording that *"no isolation level or retry policy is selected here"*, and this ADR fills that deferral rather than revising it. `ADR-023` is likewise not superseded; this is its **step 5** |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-14 (issue #189). In force; later work may rely on it.**
> **It authorizes no implementation.** No transaction code, SQL, repository, revision or
> moderation operation, stale comparison, retry mechanism, administrator message, API
> transport, schema, migration, provisioning or deployment is created by this document or by
> its acceptance. Nothing in `src/` changes on the strength of it.

---

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

The **binding ruling preceded this draft**. Issue #189 carried a Scope Gate that established the
constraints from `ADR-017`, `ADR-022` and `ADR-023`, analysed five strategies against the
`PS-11` visibility requirement, and requested a ruling on eight named items. The Product Owner
approved the complete recommended package on 2026-10-14, in a single binding comment on that
issue, **before any part of this document existed**.

Publishing it as `Proposed` would therefore misrepresent the record: there is nothing left to
propose. This follows the uniform precedent of **`ADR-019`, `ADR-020`, `ADR-021`, `ADR-022` and
`ADR-023`**, each accepted directly for the same reason. The alternative route — a `Proposed`
publication followed by a separate acceptance — exists for decisions whose argument is still
open, which this one is not.

## Why an ADR, and not implementation notes alone

Applied against *When an ADR is required* (`docs/adr/README.md`), independently, not against
preference. All four criteria are met:

| Criterion | Why it applies |
|---|---|
| **Structural** | It fixes the transaction protocol semantics for **four write paths** and the `C9` boundary, and it determines whether retry infrastructure exists in the system at all. |
| **Costly to reverse** | Changing the isolation level later means re-deriving every operation's statement sequence, re-arguing the visibility requirement from first principles, and rewriting every concurrency test. |
| **Cross-cutting** | `OP-6`, `OP-10`, `FR-ADM-04`, `FR-ADM-10b`, components `C6` and `C9`, the test strategy and operational configuration must all live with it. |
| **Contested** | A reasonable engineer would choose `SERIALIZABLE` with bounded retry. The argument against it — that it adds retry obligations for no stale-detection gain — must survive on the record (`IR-6`). |

**`IP-9` applies independently:** implementation forces a decision the chain did not make, and
`ADR-017` deferred it **by name**.

**Next-number status, confirmed independently.** `ADR-023` is the highest numbered ADR file in
`docs/adr/`, and the string `ADR-024` occurred nowhere in `docs/` or `src/` before this
document. **`ADR-024` is therefore the next unused number**, taken under *Numbering and
filenames*; this decision is **not named by `docs/07`**, which did not anticipate it.

## Context

`ADR-017` selected **`PS-11`** — per-listing serialization of revision work — and specified it
in unusual detail. What it deliberately left open was one sentence long:

> One candidate is for each statement after the lock to take a fresh snapshot (a read-committed
> style of isolation); **no isolation level or retry policy is selected here.**

`ADR-023` then listed the same gap as its **step 5**, *"Not decided"*, and observed in its own
*Consequences* that comparing a captured token against a freshly-read row under the lock
*"satisfies `PS-11`'s visibility requirement without needing serializable isolation and
mandatory retry — though the isolation level itself remains undecided."* That was a narrowing,
not a ruling.

**What `PS-11` already decided, and this ADR does not reopen:** the lock is **exclusive**,
**row-level**, on the **`listing` row**; it is acquired **before** any pending-state check or
content read; it is **held until commit or rollback**; and **all four participating paths follow
one protocol**. `DI-11`'s conditional uniqueness over pending rows is **a backstop, not the
serialization mechanism**, because the atomic path removes its temporary row before commit.

**The acceptance test `ADR-017` set** is its *visibility requirement*: the chosen mechanism must
*"demonstrably make post-lock checks observe the preceding participant's committed state, or
abort and restart"*, and conflict detection *"must not be assumed from lock acquisition
alone"* — because **a participant may create a revision while locking, but not modifying, the
listing row**. That sentence is the whole technical crux, and it is what separates the viable
strategies from the plausible ones.

---

## Decision

### Isolation

1. **PostgreSQL `READ COMMITTED`**, for every governed write path, **set explicitly for each
   transaction** rather than inherited from a server default. The server's
   `default_transaction_isolation` is operational configuration this decision does not set, and
   relying on it would make correctness depend on a value outside the repository.

### One protocol, four paths

2. **One `PS-11` protocol** governs all of:
   - **`OP-6`** — revision creation;
   - **`OP-10`** — revision approval and application;
   - **`FR-ADM-04`** — administrative edits;
   - **`FR-ADM-10b`** — the atomic create-and-approve path.

   **No per-operation isolation split.** Different visibility semantics per path would mean a
   developer reasoning about one path could not rely on what another guarantees, and `ADR-017`
   already names *"a participating path skips the listing lock"* as a defect mode.

### Locking

3. Acquire **`SELECT … FOR UPDATE` on the listing row first** — before any pending-revision
   check, any content read and any mutation — and **hold it through commit** (or rollback).
4. Read the relevant listing and revision state **only after** acquiring that lock.
5. Acquire the **`listing` lock before any `listing_revision` lock**. Where a future operation
   ever spans multiple listings, acquire in **ascending listing-identifier order**.

### The stale comparison

6. Compare the **original captured base token** with the **current listing `lastUpdatedAt`**,
   read under the lock, **before any mutation**. Equality is **exact epoch-millisecond
   equality** (`ADR-022`, `ADR-023` item 11).

   At **`OP-10`** that token is the one **persisted with the revision** — the case `ADR-023`
   names, where staleness is defined. On the paths where **no revision row exists yet**
   (**`OP-6`**, **`FR-ADM-04`**, and **`FR-ADM-10b`** before its insert) the **same comparison**
   is made against the token the **caller captured when work began**, under `ADR-023` item 12's
   rule that *a missing or unequal token refuses the write*. The comparison, the exactness and
   the prohibition in item 9 are identical in both cases; **only the token's origin differs, and
   it is never re-captured from the row being compared**. This narrows nothing in `ADR-023`:
   `OP-10` remains where a *revision* is stale.
7. Include **that same original token** in the **guarded listing-write predicate**
   (`… WHERE id = $1 AND last_updated_at = $capturedBase`).
8. Treat an **affected-row count of zero**, after the lock was held and the stale comparison
   succeeded, as a **loud protocol/invariant failure** — **not** stale input and **not** an
   ordinary business outcome. Under a correctly held lock it is unreachable, so reaching it
   means the protocol itself is broken and must fail conspicuously rather than be reported as a
   routine refusal.
9. **Never recapture, refresh or replace the original token.** Re-reading the row and copying
   its current value into the comparison, or into a retry, is precisely the auto-refresh
   `ADR-023` items 2–4 forbid.

### What locking does not do

10. **Serialization or row locking alone does not satisfy stale-input detection.** The lock
    orders transactions; it cannot see what an editing screen already held. This carries
    `ADR-023`'s interpretation 16 forward unchanged.
11. **`DI-11`'s partial unique index remains an integrity backstop, not the serialization
    mechanism.** An operation that relies on `23505` to discover a concurrent pending revision
    is defective, not merely unlucky.

### Retry

12. **No automatic application-level retry** in the MVP transaction implementation.
13. Classify **only `40001` and `40P01`** as retryable database conflicts, for an **outer
    authorized caller or policy**. **Do not invent further retryable cases**; any SQLSTATE not
    classified here is non-retryable until separately ruled.
14. Classify **`23505`, `23514`, `23503`, `55P03`, `57014`** and the **connection class**
    (`08003`, `08006`, `57P01`) as **non-retryable under this decision**.
15. Any **future authorized retry** must **reuse, reread and recompare the original captured
    token**, and **must not occur after an external side effect**.
16. **Retry attempt count, backoff and jitter remain downstream configuration**, unless the
    ruling fixes a **minimum correctness bound** — in which case that bound is binding and only
    the values above it are configurable.

### Failure taxonomy

17. Preserve the complete taxonomy. These **seven kinds must not collapse into one another**:

    | Kind | Meaning |
    |---|---|
    | **Stale input** | the captured token is missing or unequal; the governed `ADR-023` message; refresh and resubmit |
    | **Missing record** | the listing or the revision does not exist |
    | **Invalid lifecycle state** | listing not *approved*; revision not *pending*; rejection anchor already set |
    | **Uniqueness/integrity conflict** | `23505` and the other integrity classes — a backstop firing is a fault to surface |
    | **Retryable database conflict** | `40001`, `40P01` |
    | **Exhausted retry** | distinct from the above: the operation did not happen, and the caller must know |
    | **Database unavailable** | the connection class, distinct from every conflict |

18. A **same-millisecond `DI-6` timestamp-advancement failure remains distinct from
    staleness**, and must never be reported as stale input. Two administrators acting inside one
    millisecond is a `DI-6` problem; conflating the two would deliver the wrong governed
    message.

### Scope

19. **No public behaviour or notification change beyond `ADR-023`.** The public user receives no
    notification and observes no partial change; the public projection is untouched; the token
    remains non-public.
20. **No isolation choice authorizes persistence, API, migration, messaging, provisioning or
    deployment.** Every one of those remains a separately authorized later unit.

---

## Transaction order — the four governed paths

Pseudocode precise enough to review. `$base` is the token **captured before the transaction
began**, when the administrator's work started (`ADR-023` items 9–10). `$now` is the instant
supplied by the caller; the domain reads no clock.

### `OP-6` — create a pending revision

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

-- (1) the PS-11 lock. FIRST, before any check or content read.
SELECT id, status, last_updated_at
  FROM listing
 WHERE id = $listingId
   FOR UPDATE;
-- 0 rows                -> MISSING RECORD
-- status <> 'approved'  -> INVALID LIFECYCLE STATE

-- (2) post-lock read. A fresh statement snapshot, so it observes the preceding
--     participant's committed revision even though that participant only LOCKED
--     the listing row. This is the PS-11 visibility requirement being met.
SELECT id FROM listing_revision
 WHERE listing_id = $listingId AND state = 'pending'
   FOR UPDATE;
-- >= 1 row              -> INVALID LIFECYCLE STATE (DI-11 / FR-ADM-10b refusal,
--                          decided under the lock, not by the index)

-- (3) the stale check, before any mutation (ADR-023 item 12).
IF $base <> listing.last_updated_at THEN -> STALE INPUT (rollback; nothing written)

-- (4) validate the complete proposed set in the domain. No I/O, no clock.

-- (5) insert, carrying the ORIGINAL captured token, never the value just read.
INSERT INTO listing_revision (..., base_listing_last_updated_at)
VALUES (..., $base);
-- 23505                 -> UNIQUENESS/INTEGRITY CONFLICT (the backstop fired: a
--                          fault to surface, never a retry)

COMMIT;
```

### `OP-10` — approve and apply the pending revision

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

SELECT id, status, last_updated_at FROM listing WHERE id = $listingId FOR UPDATE;
-- 0 rows / not approved -> MISSING RECORD / INVALID LIFECYCLE STATE

SELECT id, state, base_listing_last_updated_at, <content>
  FROM listing_revision
 WHERE listing_id = $listingId AND state = 'pending'
   FOR UPDATE;
-- 0 rows                -> MISSING RECORD (no pending revision)
-- > 1 row               -> impossible under the DI-11 index; integrity fault

-- the stale check, BEFORE ANY MUTATION
IF revision.base_listing_last_updated_at <> listing.last_updated_at
   THEN -> STALE INPUT (rollback; listing and revision unchanged)

-- validate the proposal; then DI-6: $now must be strictly after last_updated_at,
-- else TIMESTAMP NOT ADVANCED -- a DISTINCT failure, never reported as stale.

UPDATE listing
   SET <content>, last_updated_at = $now
 WHERE id = $listingId
   AND last_updated_at = revision.base_listing_last_updated_at;   -- the token, again
-- 0 rows affected       -> LOUD PROTOCOL FAILURE (unreachable under the lock)

DELETE FROM listing_revision WHERE id = $revisionId AND state = 'pending';
-- 0 rows                -> INVALID LIFECYCLE STATE

COMMIT;
```

### `FR-ADM-04` — administrative edit of the listing

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

SELECT id, status, last_updated_at FROM listing WHERE id = $listingId FOR UPDATE;
-- 0 rows                -> MISSING RECORD

SELECT id FROM listing_revision
 WHERE listing_id = $listingId AND state = 'pending'
   FOR UPDATE;            -- read under the lock, so the FR-ADM-10b interaction is
                          -- decided on committed state rather than a stale snapshot

IF $base <> listing.last_updated_at THEN -> STALE INPUT (rollback)

-- validate; DI-6 advancement check as above

UPDATE listing
   SET <content>, last_updated_at = $now
 WHERE id = $listingId AND last_updated_at = $base;
-- 0 rows affected       -> LOUD PROTOCOL FAILURE

COMMIT;
```

### `FR-ADM-10b` — the atomic create-and-approve path

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

SELECT id, status, last_updated_at FROM listing WHERE id = $listingId FOR UPDATE;

-- the ruled refusal while a revision is pending is decided HERE, under the lock
SELECT id FROM listing_revision
 WHERE listing_id = $listingId AND state = 'pending'
   FOR UPDATE;
-- >= 1 row              -> INVALID LIFECYCLE STATE (refusal; nothing written)

IF $base <> listing.last_updated_at THEN -> STALE INPUT (rollback)

-- validate, then insert / apply / remove as ONE atomic unit (ADR-017 Q-3)
INSERT INTO listing_revision (..., base_listing_last_updated_at) VALUES (..., $base);

UPDATE listing
   SET <content>, last_updated_at = $now
 WHERE id = $listingId AND last_updated_at = $base;
-- 0 rows affected       -> LOUD PROTOCOL FAILURE

DELETE FROM listing_revision WHERE id = $insertedId;
-- the temporary row never survives the transaction, which is why DI-11's index
-- cannot be the serialization mechanism

COMMIT;    -- any refusal or failure rolls back to the actual pre-operation state (DI-3)
```

**Lock order, stated once for all four:** the **`listing` row first**, then that listing's
`listing_revision` rows, then commit. One listing per transaction today; ascending
listing-identifier order if that ever changes.

---

## Concurrency and interleaving

`T1` and `T2` are two governed transactions on the same listing. `T2` always blocks on `T1`'s
listing-row lock and proceeds only after `T1` commits or rolls back.

| Case | Behaviour under this decision |
|---|---|
| **create vs create** | `T2` blocks; after `T1` commits, `T2`'s post-lock read takes a **fresh snapshot**, sees the new pending row, and refuses with **invalid lifecycle state** — decided under the lock, **not** by `23505`. |
| **approve vs approve** | `T2` blocks; afterwards the revision is gone (removed by `T1`), so `T2` reports **missing record**. No double application. |
| **approve vs reject** | Serialized. The loser finds nothing pending and reports **invalid lifecycle state** — never stale input, because its token was never the problem. |
| **approve vs administrative edit** | Whichever commits first advances `last_updated_at`. The loser's captured token is then **unequal**, so it is refused as **stale input** with the governed message, and nothing is partially applied. This is the case `ADR-023` exists for. |
| **atomic path vs revision creation** | Serialized. The ruled `FR-ADM-10b` refusal is decided by the post-lock pending check. The atomic path's temporary row is inserted and removed inside its own transaction, so the other participant sees either no pending row or a committed one — never a half state. |
| **concurrent submissions for one listing** | Fully serialized by the listing lock: one transaction at a time performs revision work on a listing, which is exactly what `PS-11` selected. |
| **missing listing** | The `FOR UPDATE` returns 0 rows; **missing record**; rollback. No lock is held, and nothing is written. |
| **revision no longer pending** | The post-lock `SELECT … FOR UPDATE` returns 0 rows (or a non-pending row): **missing record** or **invalid lifecycle state**. A fresh snapshot is what makes this observable. |
| **lock order / deadlock** | A single row, locked first, in one order, by every path: no cycle is constructible between governed paths. A `40P01` therefore indicates a **lock-order defect** (or an unrelated/future lock holder), and is treated as a signal to investigate, not merely a race to retry. |
| **the discriminating visibility case** — `T1` locks the listing row and **inserts a revision without updating the listing row** | **`READ COMMITTED` passes.** `T2` blocks on the lock; when `T1` commits, `T2`'s *next statement* takes a **new snapshot** and sees the inserted revision, so its pending check is correct. This is the case that eliminates `REPEATABLE READ` below, and the case `ADR-017` specifically warned must not be left to lock acquisition alone. |

---

## Why `READ COMMITTED`, stated precisely

**`READ COMMITTED` supports the required post-lock fresh statement snapshot.** In this level
each statement takes its own snapshot of committed data. The `SELECT … FOR UPDATE` blocks until
the predecessor commits, and **the statements that follow it see a snapshot taken after that
commit**. The pending-revision check therefore observes the predecessor's committed insert. This
is the candidate `ADR-017` named, and it satisfies the visibility requirement **without any
abort-and-restart obligation**.

**`REPEATABLE READ` can retain a snapshot that cannot see the newly committed revision.** Its
snapshot is fixed at the transaction's first statement and does not advance. In the
discriminating case the predecessor **only locked** the listing row — it never modified it — so
when the lock is released there is **no concurrent-update conflict to report** and **no `40001`
is raised**. The lock is granted and the transaction continues **on its original snapshot**, in
which the predecessor's inserted revision **does not exist**. The `DI-11` check then passes
wrongly, and the only remaining obstacle is the partial unique index — which `ADR-017`
explicitly refuses to use as the serialization mechanism. The failure is not that
`REPEATABLE READ` is unsafe in general; it is that **it fails the specific acceptance test this
protocol was given**, and it would demote an integrity backstop into the primary detector while
also requiring retry.

**`SERIALIZABLE` adds abort/retry obligations but does not detect stale input captured outside
the transaction.** Serializable Snapshot Isolation guarantees that concurrent transactions are
equivalent to *some* serial order; in the discriminating case it would detect the
read-write dependency and abort one transaction with `40001`, which is a genuine strength and
would make the visibility requirement unconditionally true. But **staleness is about data read
before any transaction began** — content sitting in an administrator's editing screen. A stale
write arriving as the only transaction in flight is **perfectly serializable and perfectly
wrong**. The explicit captured-token comparison is therefore mandatory under `SERIALIZABLE` too,
so the level buys **nothing on the governed requirement** while obliging every path to be safely
replayable and every caller to handle `40001`. It remains the correct answer if the system later
acquires multi-row invariants that a single-row lock cannot express.

**Compare-and-swap without the ruled initial lock does not satisfy the complete `PS-11`
protocol.** A guarded `UPDATE … WHERE last_updated_at = $base` is genuinely strong: it is
atomic, needs no lock, and makes lost-update protection impossible to forget because it sits in
the statement that does the work. That idea is **kept**, as item 7's predicate. What it cannot
do is replace the lock: `PS-11` requires the exclusive lock **before** the pending check and the
content read, and without it the `DI-11` check, the content read and — critically — the atomic
path's *check, insert, apply, remove* sequence all interleave with a concurrent participant
between statements. Adopting compare-and-swap **alone** would require amending `ADR-017`, which
this decision does not do.

**`40001` and `40P01` remain classified even though automatic retry is not selected, and this is
deliberately defensive rather than expected.** `READ COMMITTED` is **not** claimed to eliminate
every possible occurrence of either code. The server, not the application, decides which
SQLSTATE it raises; a deadlock remains reportable whenever some other holder — a future
operation, a migration, an administrative session or an extension — takes locks in a different
order, and a serialization failure can surface from circumstances outside this protocol's
control. Classifying both costs nothing and keeps an unexpected conflict from silently falling
into an unrelated bucket, such as being mistaken for stale input. Leaving them unclassified
**because they are not expected** would be the defect. Classification is not a licence to retry:
item 12 selects no automatic retry, so these codes surface to an outer authorized caller.

---

## The material tradeoff

**Correctness under this decision depends on enforced statement and lock order, not on the
database engine refusing to let the program be wrong.** The protection lives in three places a
developer can omit: the lock taken **first**, the stale comparison placed **before any
mutation**, and the token carried **in the write predicate**. Code that reads content before
taking the lock, or compares after mutating, gets a **silently weaker guarantee that still
passes every single-threaded test**. `SERIALIZABLE` would have moved part of that burden into
the engine, at the cost of mandatory retry.

The consequence is accepted explicitly: **deterministic interleaving tests are mandatory, not
optional.** Every case in the matrix above — and especially the discriminating visibility case —
must be proved by controlled interleaving against a real PostgreSQL, with two connections and
explicit transaction boundaries, so that the ordering guarantees are demonstrated rather than
assumed. Those tests must be **deterministic rather than timing-dependent**: a flaky concurrency
test cannot distinguish a real ordering regression from a loaded machine.

---

## Alternatives considered

| Alternative | Assessment |
|---|---|
| **`REPEATABLE READ` with explicit locking** | Its genuine advantage is real: a stable in-transaction snapshot makes multi-statement reads mutually consistent, and it raises `40001` automatically when the locked row *was* modified. **Rejected** because it fails the `PS-11` visibility requirement in the discriminating case, where the predecessor only locked the listing row, and because it would make `DI-11`'s index the primary detector. **Not characterised as incorrect** — it is the wrong fit for this specific acceptance test. |
| **`SERIALIZABLE` with bounded retry** | The strongest alternative, and the conventional choice. It makes the visibility requirement unconditionally true and protects invariants not yet written down. **Rejected as premature, not wrong:** it does not detect stale input, which is the governed requirement, so it adds mandatory retry and replayability obligations for no gain on the ruling. **It remains the right answer** if multi-row invariants arrive that a single-row lock cannot express. |
| **Compare-and-swap predicates with no initial lock** | Genuinely attractive: simplest possible mechanism, no lock ordering, no retry. **Rejected** because it contradicts `PS-11` as ruled and leaves the atomic path's multi-statement sequence unprotected. Its predicate is **retained** inside the lock as item 7. |
| **Per-operation isolation (a hybrid)** | **Rejected as unjustified**, not unworkable. `PS-11` requires one protocol for all participating paths; all four lock the same single row and all four need post-lock visibility, so no operation's needs differ enough to warrant divergent semantics. |
| **Automatic application-level retry in the MVP** | **Rejected** because `READ COMMITTED` makes retry unnecessary on these statements, and a retry wrapper written before it is needed would have to be made safe against re-running a transaction whose token comparison must not be re-captured. Classification without automatic retry keeps the option open without the hazard. |

---

## Consequences

**Positive:**

- **`PS-11`'s visibility requirement is satisfied by a named mechanism**, not by hope: the
  post-lock fresh snapshot is a documented property of the chosen level.
- **No retry infrastructure is owed.** No path must be made replayable, and no caller must
  handle `40001` as a routine outcome.
- **Detection stays explicit**, as `ADR-023` interpretation 16 requires. Nothing about the
  protection is inferred from the isolation level.
- **A correct operation is never spuriously failed.** Blocking rather than aborting means
  contention costs latency, not false errors.
- **No version-specific feature is used**, so **no PostgreSQL version is selected** and nothing
  here depends on one.
- **The failure taxonomy is fixed before the code exists**, so the governed `ADR-023` message
  cannot be delivered for a `DI-6` or lifecycle failure.

**Negative, and accepted:**

- **Correctness depends on enforced ordering** — see *The material tradeoff*.
- **Interleaving tests become mandatory**, which is real, ongoing test cost.
- **Future multi-row invariants get no automatic protection** from a single-row lock, and would
  need this decision revisited.
- **Blocking is a latency cost under contention**, where an abort-and-retry design would fail
  fast instead.

## Assumptions

- `DI-6`'s strictly-increasing `lastUpdatedAt` remains in force. `ADR-023` already records that
  **relaxing `DI-6` requires separately governed reassessment**, and that reassessment would
  reach this decision too, because the guarded predicate rests on the same value.
- Each governed transaction touches **one** listing. Item 5's ascending-identifier rule exists
  so that the day this stops being true does not become a deadlock discovery.
- The application sets the isolation level explicitly, so no server default is load-bearing.

## Risks

| Risk | Mitigation |
|---|---|
| A path reads content **before** taking the lock | The interleaving tests, and the reviewed statement order recorded above |
| A retry is added later that **re-captures** the token | Items 9 and 15; the prohibition is on the record before any retry exists |
| `23505` is treated as a retryable race | Items 11, 13 and 14: a backstop firing is a fault to surface |
| A stale refusal is reported for a `DI-6` same-millisecond failure | Item 18, carried from `ADR-023` |
| A zero affected-row count is reported as an ordinary refusal | Item 8: it is a loud protocol failure |
| A flaky concurrency test hides a real ordering regression | The tests must be deterministic, not timing-dependent |

## Open questions this decision must NOT answer

The **transaction implementation** itself; **revision and moderation persistence** (`OP-6`,
`OP-10`, `FR-ADM-04`, `FR-ADM-10b` and their tests); revision **serialization and hydration**;
the **administrator conflict message** and **API transport mechanics**; **retry attempt count,
backoff and jitter** values; the **production PostgreSQL version**; **provisioning, credentials,
pool, TLS, secret and environment configuration**; the `statement_timeout`, `lock_timeout`,
`idle_in_transaction_session_timeout` and `default_transaction_isolation` **server settings**;
**`OQ-4`/`S-4`/`DDM-4`** searchable fields, indexing and text search; **`OQ-14`/`NOQ-8`/`DDM-7`/
`S-8`** audit-entry storage; the **public projection form**; **replacement-value semantics** and
the **restriction-only designation** (`ADR-017`'s remaining deferrals); `DG-3`; `DG-4`.

**No isolation level is assigned to any operation outside the four governed write paths.** Read
paths, the public projection and any future operation are untouched by this decision.

## Traceability

| Source | What it contributes |
|---|---|
| **`ADR-017`** `PS-11` (`Accepted` 2026-09-17, issue #137) | The lock, its acquisition point, its duration, the one-protocol rule, the `DI-11` backstop characterisation, and the **visibility requirement** this decision had to satisfy. Its *"no isolation level or retry policy is selected here"* deferral is what this ADR fills. |
| **`ADR-022`** (`Accepted` 2026-10-09, issue #169) | `timestamptz(3)` and the exact epoch-millisecond round trip that makes item 6's exact equality real. |
| **`ADR-023`** (`Accepted` 2026-10-12, issue #181) | The stale-edit policy, the captured token, exact equality, the refusal of a missing or unequal token, the non-public token, interpretation 16, the `DI-6` distinction, and **step 5**, which is this ADR. |
| **Issue #189** | The Scope Gate that established the constraints and analysed the strategies, and the **binding ruling** recorded in its single comment. |
| **`DI-6`/`NFR-DATA-05`** (issue #141) | The strictly-increasing `lastUpdatedAt` the token and the guarded predicate both rest on. |
| **`DI-11`**, **`FR-ADM-10b`**, **`ADR-017` Q-1/Q-2/Q-3** | The sole-pending-revision rule, the refusal while a revision is pending, the write-once rejection anchors, and the removal of an approved revision row inside the applying transaction. |
