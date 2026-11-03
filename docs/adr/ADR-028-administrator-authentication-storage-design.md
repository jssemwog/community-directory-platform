# `ADR-028` — Store administrator authentication state as current-state PostgreSQL tables keyed by an application-generated administrator identity, with every `ADR-004` concurrency outcome enforced by one conditional statement or one administrator-row-locked transaction

| Field | Value |
|---|---|
| **Status** | **`Superseded`** by **`ADR-029`** — 2026-11-03 (issue #264), **by reference** (`ADR-029` RA-10). It was **`Accepted`** 2026-11-01 (issue #256), published as `Proposed` 2026-11-01; see *Status and chronology*. **Every provision not listed in `ADR-029` *Affected provisions* remains in force through `ADR-029`, word for word as written below.** Listed provisions are read as amended there. Per `docs/adr/README.md`, this file is not otherwise edited |
| **Date** | 2026-11-01 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-11-01** (issue #256): D-15 first, then D-1 to D-14, D-16 and D-17 with qualifications (*Owner rulings*); acceptance authorized the same day with the reviewed corrections |
| **Decision gate** | **`DG-3`**, which **remains `Unresolved`**. This decision depends only on **`NOQ-9`** (Decided 2026-10-30, `ADR-004` `Accepted`) and on the **local-only gate-scope exception** of issue #254 (`docs/13`, *Gate-scope exception*), following the `ADR-004` precedent: an ADR written under `DG-3` once its own question was answered |
| **Related open questions** | **Depends on:** `NOQ-9` (Decided). **Must NOT answer:** `OQ-14` + `NOQ-8`, including how long administrator records are retained and whether they may be deleted; `NOQ-7`; `OQ-9`; `NOQ-5`, `NOQ-6`; `BI-4` timing (#246); `DG-4`; any `ADR-004` parameter; `ADR-004` R-1 to R-4 — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* — `ADR-004` is **not** amended; this ADR supplies the physical storage that `ADR-004` left to implementation |
| **Superseded by** | **`ADR-029`** — 2026-11-03 (issue #264), by reference (`ADR-029` RA-10) |

> **`Accepted` 2026-11-01 (issue #256), and in force as the storage design for administrator
> authentication.** It was published as `Proposed` the same day and accepted after the owner's
> rulings and the reviewed corrections (*Status and chronology*).
> **Acceptance authorizes no** dependency, migration, schema, route, command, provisioning or
> test. Implementation is separate issue-linked work, local-only under issue #254: **synthetic**
> accounts, **development mode**, the **web server bound to loopback**, a **local database**,
> and **no moderation or business-administration capability** reachable.

---

## Status and chronology

All on 2026-11-01, issue #256:

1. This ADR was drafted as **`Proposed`**, with D-1 to D-17 as recommendations, and revised in
   review: retention wording, challenge binding, credential freshness, recovery-session
   re-authorization, throttling bounds, clock sampling and lock order.
2. The Product Owner **ruled D-15**: Design B, which preserves `ADR-004`'s conditional `DELETE`
   and adds an atomic consumed-challenge record (*D-15 ruling record*).
3. The Product Owner **approved D-1 to D-14, D-16 and D-17** as recommended, with the D-6,
   D-11, D-12 and D-17 qualifications (*Ruling record*).
4. Final consistency corrections were reviewed:
   - the challenge is looked up again in both tables after the lock;
   - required affected-row counts are defined (PS-8b);
   - the throttle tables moved into migration `003`.
5. The Product Owner **authorized acceptance** with those corrections, and the status became
   **`Accepted`**.

**Acceptance resolves no open question and opens no gate.** `DG-3` remains `Unresolved`:
`OQ-9` and `OQ-14` + `NOQ-8` are undecided, and #246 / `BI-4` remain pending. `ADR-004` is
unchanged. **Acceptance authorizes no implementation.** Each slice needs its own authorized
issue, local-only under #254.

---

## Context

`ADR-004` (`Accepted` 2026-10-30, issue #252) decided the administrator authentication
**mechanism and its parameters**: a password and a mandatory TOTP factor, server-side sessions,
single-use recovery codes, abuse controls, and the atomic outcomes of P-7. **It deliberately
named no table, column or constraint.** `docs/08` `E3` records the administrator identity as
*"required; stored elsewhere"*, outside the listing store. Naming a field is a data decision
(`CONTRIBUTING.md`), and this repository records physical designs as ADRs (`ADR-017`,
`ADR-022`).

**Forces.**

- **`ADR-004` is fixed input.** Every lifetime, size, algorithm, threshold and limit below is
  cited from it **and is not reopened**: sessions 30 minutes idle and 12 hours absolute, pending
  challenge 5 minutes, recovery session 15 minutes and not extendable (P-1); a 32-byte session
  token stored only as a SHA-256 digest (P-1); scrypt with a self-describing stored hash (P-2);
  a 160-bit TOTP secret under AES-256-GCM with a 96-bit IV, a 128-bit tag, and the
  administrator identifier and key version as associated data (P-3); 10 recovery codes of 128
  bits stored as SHA-256 digests (P-4); waits from the 5th consecutive failure, doubling from
  30 seconds up to 1 hour, the authenticator disabled at 100, and 20 failed attempts per hour per
  keyed source (P-5); key replacement without the old key (P-6); and the concurrency outcomes of
  P-7.
- **Disable, not delete, is not a retention decision.** `ADR-004` P-6 disables accounts instead
  of deleting them so that attribution (`AA-4`) stays resolvable *"while the identifier is
  retained"*, and states that this *"does not decide that identifiers are kept indefinitely"*:
  retention is `OQ-14` + `NOQ-8`. This ADR inherits that boundary and narrows nothing.
- **Verification is slower than the state it checks.** A scrypt verification waits for a hash
  slot and can take seconds; a reset, factor replacement, disable or revocation can commit in
  the meantime. The storage must make an **obsolete** verification unable to issue a usable
  challenge or session.
- **Statelessness.** Render runs one stateless instance (`ADR-005`), so no session, challenge
  or throttle state may live in process memory. It all lives in PostgreSQL (`ADR-003`), reached
  through Kysely (`ADR-014`, `ADR-016`), and is created by forward-only migrations in raw DDL
  (`ADR-018`).
- **Repository conventions.** Identity is an **application-generated UUID v4** with no store
  default (`ADR-019`, for listings). Instants are **`timestamptz(3)`**, supplied by the caller,
  with **no database clock default** (`ADR-022`, for listings). Writes use explicit
  **`READ COMMITTED`**, lock a parent row first, and do **no automatic retry** (`ADR-024`–`ADR-027`,
  for listings). This ADR adopts those conventions for its own tables and **extends none of those
  ADRs**.
- **Audit is undecided.** Whether any authentication event is an audit record is `OQ-14` +
  `NOQ-8`. Storage that kept event history would answer it by construction.

---

## Decision

**We will store administrator authentication state in eight PostgreSQL tables that hold current
state only, enforce each `ADR-004` P-7 outcome with one conditional statement or one
administrator-row-locked transaction, re-establish under that lock that the exact credential
version verified is still current before anything is issued, and keep all cryptographic keys
outside the database.**

### PS-1. Common rules

1. **Identity.** `administrator.id` is a UUID v4 generated by the application, never reused
   (`ADR-004` P-6), with **no generation default** (the `ADR-019` posture).
2. **Instants.** Every instant is `timestamptz(3)`, supplied by the application clock. **No
   `now()` or `current_timestamp` default and no database-side clock** in any predicate (the
   `ADR-022` posture). **`$now` is never the request-start instant.** Each sample is taken after
   the wait it follows:
   - **password admission:** sampled on arrival and used only for the admission reads;
   - **password re-check:** sampled again **after the hash slot is granted**, so time spent
     queued never makes a check run against an earlier time;
   - **every transaction:** sampled once, **after its lock phase** (rule 4) has acquired every
     row lock it needs, including its counter rows. Every expiry, wait and window predicate is
     evaluated against that instant **before any write**; the instants the transaction writes
     and the TOTP time step it verifies use the same instant.

   A later write can still wait, but only on a row held by a rule-4 exception, which finishes
   without waiting. Such a wait can only make a written lifetime start slightly earlier than
   its commit, which shortens it and never extends it; no predicate is evaluated after it.
3. **Disable, not delete; retention undecided.** The slices this design serves disable
   accounts and **provide no deletion operation** (`ADR-004` P-6). That is the scope of this
   design, **not a retention policy**: how long administrator rows, identifiers and rows
   referring to them are kept, and whether or how they may ever be deleted, is `OQ-14` +
   `NOQ-8` (with `NOQ-7` for operational logs) and is **not decided here** (D-11). Every foreign
   key is **`ON DELETE NO ACTION`**, so no deletion can cascade silently; any future deletion
   would be separately governed.
4. **Lock order.** Every transaction acquires row locks in its **lock phase**, in this order,
   and never takes a lower rank after a higher one:
   1. the one `administrator` row, by `SELECT ... FOR UPDATE`; a command over several
      administrators uses one transaction per administrator;
   2. the presented challenge's rows of that administrator, looked up again in
      `administrator_pending_challenge` and then in `administrator_consumed_challenge`, if any;
   3. the presented `administrator_session` row of that administrator (a recovery session), if
      any;
   4. the one `authentication_source_window` row, inserted empty first if absent;
   5. the `authentication_throttle` rows the transaction may write, inserted empty first if
      absent, in `(scope, subject_digest)` order.

   `administrator_totp_factor` and `administrator_recovery_code` rows, and the other challenge
   and session rows of an administrator, are written only by transactions holding that
   administrator's rank-1 lock. Explicit `READ COMMITTED`; **no automatic retry**. **Three
   exceptions, none of which can close a cycle:** the **session check** locks one session row,
   takes nothing else and never waits once it holds it; a **password failure for an unknown
   username** has no rank-1 row and takes ranks 4 then 5; **housekeeping** of expired rows locks
   only with `FOR UPDATE SKIP LOCKED` and never waits. Every other path follows the order:
   second-factor steps take 1, 2, 4, 5; a known-username password failure takes 1, 4, 5; a
   password success takes 1, then writes its own rank-5 row; recovery-session operations take
   1, 3; disable, revoke, reset and key replacement take 1 and write dependent and rank-5 rows
   under it. Single conditional statements outside a transaction need no lock phase.
5. **Secrets.** Only digests and ciphertext are stored. Session tokens, challenge tokens and
   recovery codes are stored as **SHA-256 digests** (`bytea`, 32 bytes). Throttle subjects are
   stored as **HMAC-SHA-256 digests** under a server-held key (D-7). The TOTP encryption key and
   the throttle key live **only** in server environment configuration (`ADR-004` P-3, `ADR-005`
   `O-5`).
6. **Current state only; logging is local practice, not product policy.** No table records an
   event, a history row or a count of past successes. **Three bounded items are kept as
   authentication enforcement state, and none decides an audit obligation:**
   - `administrator_consumed_challenge`, holding only a digest, an administrator and the original
     expiry, meaningless after that expiry (D-15);
   - the `invalidated` flag on a pending challenge (PS-4);
   - the per-source rolling record of at most 20 failure instants (D-6).

   **Today**, under #254, the local development server may write the operational log entries
   `ADR-004` P-5 names (failures, waits, disables and recovery-code use, without credentials,
   codes or secrets) to its own output, as evidence for synthetic testing. **That is current
   local practice and decides nothing for the eventual product**: whether provisioning, reset,
   revoke, disable or authentication events must be logged, retained or kept as audit records is
   `OQ-14` + `NOQ-8` and `NOQ-7`, all undecided. No table here is designed to satisfy, or to
   preclude, an audit requirement.

### PS-2. Administrator identities and password credentials — `administrator`

| Column | Type and constraint | Meaning |
|---|---|---|
| `id` | `uuid` primary key; no default | The administrator identity (`AA-4` attribution target) |
| `username` | `text not null unique`, `CHECK` against the provisioning form (D-1) | The sign-in name, stored only in its normalized form |
| `password_hash` | `text not null`, `CHECK (password_hash LIKE 'scrypt$%')` | The self-describing scrypt hash (encoding: D-2). Every reset writes a fresh salt, so **the stored string itself identifies the password version** that a verification read (PS-8a) |
| `password_disabled_at` | `timestamptz(3)` nullable | Set when the password authenticator reaches 100 consecutive failures (P-5); cleared by the operator reset |
| `disabled_at` | `timestamptz(3)` nullable | Set when the account is disabled. **No slice under this design clears it.** `ADR-004` names no re-enable operation, and re-enabling is **deferred** (D-12, ruled 2026-11-01): a deferral, not a permanent policy this column sets |
| `created_at` | `timestamptz(3) not null` | Provisioning instant |

### PS-3. Encrypted TOTP material and replay state — `administrator_totp_factor`

One row per administrator: `administrator_id uuid` is both the **primary key** and the foreign
key to `administrator`.

| Column | Type and constraint | Meaning |
|---|---|---|
| `state` | `text not null`, `CHECK (state IN ('pending_confirmation', 'active', 'reenrolment_required'))` | Enrolment lifecycle |
| `factor_id` | `uuid unique`, application-generated | **The factor version (D-13).** A new value is written whenever a new secret is generated: provisioning, re-enrolment or the operator reset. Routine re-encryption of the **same** secret keeps it. Every acceptance and confirmation names the `factor_id` it verified (PS-8) |
| `secret_ciphertext` | `bytea`, `CHECK (octet_length(secret_ciphertext) = 20)` | The 160-bit secret under AES-256-GCM. GCM ciphertext has the plaintext length |
| `secret_iv` | `bytea`, `CHECK (octet_length(secret_iv) = 12)` | The fresh 96-bit IV of that encryption |
| `secret_tag` | `bytea`, `CHECK (octet_length(secret_tag) = 16)` | The 128-bit authentication tag |
| `key_version` | `integer`, `CHECK (key_version > 0)` | Which server-held key encrypted it; part of the associated data with `administrator_id` |
| `last_accepted_step` | `bigint`, `CHECK (last_accepted_step >= 0)` | The last accepted RFC 6238 time step (replay state) |

**Consistency constraints:**

- **Material present if and only if usable:** `factor_id`, `secret_ciphertext`, `secret_iv`,
  `secret_tag` and `key_version` are all non-null if and only if `state <> 'reenrolment_required'`.
- **An active factor has replay state:** `state <> 'active' OR last_accepted_step IS NOT NULL`.

**A missing row means no factor.** Sign-in never completes without an `active` row.

### PS-4. Pending challenges and consumed-challenge records — `administrator_pending_challenge` and `administrator_consumed_challenge`

A separate table from sessions, so that **a password alone can never be presented as a
session**. No query that checks a session reads either table.

**`administrator_pending_challenge`** holds challenges that have not been consumed.

| Column | Type and constraint |
|---|---|
| `token_digest` | `bytea` primary key, `CHECK (octet_length(token_digest) = 32)` |
| `administrator_id` | `uuid not null` references `administrator` |
| `created_at` | `timestamptz(3) not null` |
| `expires_at` | `timestamptz(3) not null`, `CHECK (expires_at = created_at + interval '5 minutes')` |
| `invalidated` | `boolean not null`, written `false` at creation: the marker that keeps an invalidated challenge distinct from an unknown one |

**`administrator_consumed_challenge`** records each consumption until the challenge's original
expiry (D-15, ruled 2026-11-01).

| Column | Type and constraint |
|---|---|
| `token_digest` | `bytea` primary key, `CHECK (octet_length(token_digest) = 32)`: the consumed challenge's digest |
| `administrator_id` | `uuid not null` references `administrator`: the challenge's administrator |
| `expires_at` | `timestamptz(3) not null`: the challenge's **original** expiry, copied unchanged |

It holds nothing else: no instant of consumption, no outcome, no session and no credential.

**Consuming a challenge** (`ADR-004` P-7, unchanged). In one transaction under the
administrator lock:

1. **(required)** the conditional `DELETE FROM administrator_pending_challenge WHERE
   token_digest = $d AND administrator_id = $id AND invalidated = false AND expires_at > $now
   RETURNING expires_at`;
2. **(required)** `INSERT INTO administrator_consumed_challenge` of the same digest, the same
   administrator and that returned `expires_at`.

So there is **at most one session per challenge**, and a digest is never in both tables.

**Invalidating challenges.** Wherever this ADR says a transaction deletes an administrator's
pending challenges (D-14, PS-8, PS-8a), the statement is the *(cleanup)* `UPDATE
administrator_pending_challenge SET invalidated = true WHERE administrator_id = $id AND
invalidated = false`. **It never touches `administrator_consumed_challenge`**, so a later
reset, factor replacement, key replacement, disable or revoke-all leaves a consumed record
consumed. The session the consumption issued is removed by that change's own session
deletion.

**Classification** (D-15, ruled 2026-11-01). After the lock phase and the clock, a
second-factor submission's challenge is classified in this order:

1. **unknown:** no row in either table **when both are looked up again under the administrator
   lock** (PS-8). A digest only ever moves from pending to consumed, so a consumption that
   committed while the request waited is found as consumed, never as unknown;
2. **expired:** `expires_at <= $now`, in whichever table holds it;
3. **disabled:** the account or its password authenticator is disabled;
4. **consumed:** a row in `administrator_consumed_challenge`, necessarily within its original
   five-minute lifetime;
5. **invalidated:** `invalidated = true`;
6. **live.**

Unknown, expired, disabled and invalidated are the generic failure and count nothing. **Only
*consumed* is a counted replay under this rule**, against the submitted authenticator and the
source. Expiry is tested first, so a consumed record counts only within its original
lifetime, and housekeeping removes rows only after `expires_at`. **Whether a submission is
counted therefore never depends on housekeeping.**

**Two replay rules, kept distinct.**

- **`ADR-004` P-7, *TOTP acceptance* (accepted):** *"Accepted only if the conditional update
  advances the last accepted time step. Concurrent submissions of one code: **at most one
  succeeds**; the rest fail as replays and count as failures."* It is enforced on a **live**
  challenge by `last_accepted_step`, whichever challenge carries the code.
- **The consumed-challenge classification (D-15, ruled 2026-11-01; new):** a submission that
  presents a challenge already consumed, within its original lifetime, is a replay counted as
  a failure. It applies to TOTP and recovery-code submissions alike, and adds to `ADR-004`
  without changing it.

**A challenge is bound to one administrator.** It is created **only** after a correct password,
inside the locked transaction of PS-8 that confirms the account is enabled, its password
authenticator is not disabled and its `password_hash` is still the one verified. Its
`administrator_id` is that administrator, and it is **only ever consumed together with that
same `administrator_id`**: the second factor or recovery code is verified against that
administrator alone. Both second-factor paths classify the challenge at the post-lock `$now`
**before any verification or failure accounting** (PS-8). A failed second factor leaves the
challenge live until it expires or succeeds (D-5).

### PS-5. Full and restricted recovery sessions — `administrator_session`

| Column | Type and constraint |
|---|---|
| `token_digest` | `bytea` primary key, `CHECK (octet_length(token_digest) = 32)` |
| `id` | `uuid not null unique`, application-generated: a **non-secret handle** for the revoke-one operation (D-9) |
| `administrator_id` | `uuid not null` references `administrator` |
| `kind` | `text not null`, `CHECK (kind IN ('administrator', 'recovery'))` |
| `created_at` | `timestamptz(3) not null` |
| `last_activity_at` | `timestamptz(3) not null`, `CHECK (last_activity_at >= created_at)` |
| `absolute_expires_at` | `timestamptz(3) not null`, `CHECK ((kind = 'administrator' AND absolute_expires_at = created_at + interval '12 hours') OR (kind = 'recovery' AND absolute_expires_at = created_at + interval '15 minutes'))` |

**Only `kind = 'administrator'` satisfies `C8`.** A recovery session permits only TOTP
re-enrolment, recovery-code regeneration and logout (`ADR-004` P-1). **The lifetime `CHECK`s
store `ADR-004` approved values as constraints** (D-10), so changing a value is a governed
migration, never a configuration edit. Activity never moves `absolute_expires_at`, so a
recovery session cannot be extended.

**Recovery-session authorization is re-established inside every recovery transaction.** The
request-level session check is not sufficient on its own. Each operation a recovery session
permits runs in one transaction that locks `administrator`, then locks with `SELECT ... FOR
UPDATE` the row with the presented `token_digest`, **the same `administrator_id`** and
`kind = 'recovery'`, then samples `$now` and requires `disabled_at IS NULL`,
`absolute_expires_at > $now` and `last_activity_at > $now - interval '30 minutes'`. Any
failure rolls the whole transaction back. A recovery session expired, revoked, ended or issued
to another administrator therefore authorizes nothing, even if it passed an earlier check.

### PS-6. Recovery codes — `administrator_recovery_code`

| Column | Type and constraint |
|---|---|
| `administrator_id` | `uuid not null` references `administrator` |
| `code_digest` | `bytea not null`, `CHECK (octet_length(code_digest) = 32)` |
| primary key | `(administrator_id, code_digest)` |

**A used code is deleted** (`ADR-004` P-4), so there is no "used" flag. The limit of 10 codes is
a write-path rule, because regeneration replaces the whole set in one locked transaction. A
`CHECK` sees one row and cannot count.

### PS-7. Abuse-control state — `authentication_throttle` and `authentication_source_window`

**`authentication_throttle`** holds the consecutive-failure counter of one authenticator.

| Column | Type and constraint |
|---|---|
| `scope` | `text not null`, `CHECK (scope IN ('password', 'totp', 'recovery_code'))` |
| `subject_digest` | `bytea not null`, `CHECK (octet_length(subject_digest) = 32)` |
| `consecutive_failures` | `integer not null`, `CHECK (consecutive_failures >= 0)` |
| `wait_until` | `timestamptz(3)`; `CHECK ((consecutive_failures >= 5) = (wait_until IS NOT NULL))` |
| `last_failure_at` | `timestamptz(3) not null` |
| primary key | `(scope, subject_digest)` |

The subject depends on the scope:

- **`password`:** an HMAC digest of the **normalized submitted username**, whether or not the
  account exists (P-5). There is therefore **no foreign key**, and no submitted text (which may
  be a mistyped password) is ever stored in clear.
- **`totp` and `recovery_code`:** an HMAC digest of `administrator.id`, where the identity is
  the one bound to the challenge (PS-4).

A row exists while failures are outstanding, or with zero failures only so that a transaction
can lock it (PS-1 rule 4). A success **deletes** it.

**Where each check runs, and what it bounds.** Let P be the number of processes that handle
sign-in, each with its own hash limiter of 2 running and 8 queued verifications (P-7).

- **Second-factor steps** take no hash slot. Their lock phase holds the administrator, the
  challenge, the source row and their counter row; their checks run after the clock, under those
  locks. A second-factor failure is recorded only after a locked read shows its limit not yet
  reached, so **second-factor steps never take a counter past its limit**.
- **The password step** cannot hold a lock across queueing and hashing: an unknown username has
  no row to lock, and no transaction stays open across a hash. It is checked at **admission**
  and again **after its hash slot is granted**, with a fresh `$now`, and a failure **commits its
  accounting before releasing its slot**. A verification can therefore miss a limit only while
  it is **running past its re-check**: at most 2 per process, 2P in all. Once a limit is
  committed, every later re-check sees it and refuses. **The bound requires that a failed
  verification keep its hash slot until its failure-accounting transaction has committed.**
  Releasing the slot earlier would let a queued request pass its re-check before the failure is
  visible, and the bound would not hold.
- **Resulting bound (D-17).** At the moment a limit is first reached, at most 2P password
  verifications are outstanding past their re-check. **The per-source limit can be exceeded by
  at most 2P failures**, because the failure that reaches it may come from a second-factor step
  or another process. **A per-username threshold** (the wait from the 5th failure, or the ceiling
  at 100) **can be exceeded by at most 2P − 1**, because only password failures feed that
  counter, so the failure that reaches it is one of the outstanding verifications.
- **P is not verified** for the local development server. The first slice must establish it
  and state the resulting bound, or confine sign-in handling to one process.

**Walkthrough, one process (P = 1).** Source S holds 19 failures in its window (limit 20).
Username u holds 4 consecutive failures (a wait starts at the 5th).

| Step | Request | What happens | S | u |
|---|---|---|---|---|
| 1 | P1, P2: passwords for u from S | Admission reads 19 and 4: admitted; they take both hash slots. P3, also for u, queues | 19 | 4 |
| 2 | P1, P2 | Slots granted; re-check with a fresh `$now` reads 19 and 4: both hash | 19 | 4 |
| 3 | T1: TOTP for administrator A from S | Locks A, its challenge, S, its `totp` row; clock; reads 19, below the limit; wrong code; failure committed | 20 | 4 |
| 4 | T2: recovery code for administrator B from S | Locks B and its challenge, then waits for S behind T1; locks S; clock; reads 20: refused, nothing counted | 20 | 4 |
| 5 | P1 | Hash fails; failure transaction locks u's account, S, u's `password` row; clock; both upserts; commit; **then** slot released | 21 | 5, wait set |
| 6 | P3 | Takes the freed slot; re-check with a fresh `$now` reads 21 and the wait: refused, no hash, nothing counted | 21 | 5 |
| 7 | P2 | Hash fails; failure committed | 22 | 6 |

S ends 2 above its limit (2P: P1 and P2 were both past their re-check when T1 reached it). u's
wait threshold is exceeded by 1 (2P − 1: P2). No second-factor step counted past a limit.
The D-6 rolling record keeps only the latest 20 instants; the bound counts verified
failures, not stored ones.

**D-17 (ruled 2026-11-01) accepts this bound for synthetic local use only**, on the conditions
in the *Ruling record*. Production acceptance is deferred. It changes no `ADR-004` value.

**`authentication_source_window`** holds the per-source limit of 20 failed attempts per hour
(`ADR-004` P-5), as the **bounded rolling record** ruled under D-6 (2026-11-01).

| Column | Type and constraint |
|---|---|
| `source_digest` | `bytea` primary key, `CHECK (octet_length(source_digest) = 32)`: an HMAC digest of the client address. Locally that is the socket address; the trusted production header is `ADR-004` R-2 and is not decided here |
| `recent_failures` | `timestamptz(3)[] not null`, `CHECK (cardinality(recent_failures) BETWEEN 0 AND 20)`: the instants of at most the 20 most recent failures, and nothing else. An empty row exists only so that it can be locked (PS-8) |

A source is **refused while at least 20 elements are later than `$now - interval '1 hour'`**.
No more than 20 failures are therefore counted in any rolling hour, apart from the password-step
overshoot above. One upsert appends `$now`, drops elements older than one hour and keeps the
latest 20:

```sql
INSERT INTO authentication_source_window AS w (source_digest, recent_failures)
VALUES ($s, ARRAY[$now]::timestamptz(3)[])
ON CONFLICT (source_digest) DO UPDATE SET recent_failures = (
  SELECT array_agg(f ORDER BY f)
  FROM (SELECT f FROM unnest(array_append(w.recent_failures, $now)) AS u(f)
        WHERE f > $now - interval '1 hour'
        ORDER BY f DESC LIMIT 20) AS kept)
```

**This is authentication enforcement state** (D-6): at most 20 bare instants per keyed source,
with no outcome, account, username or content. **It decides no audit obligation**, which stays
with `OQ-14` + `NOQ-8`. The approved value of 20 per hour is unchanged.

### PS-8a. Freshness rule: an obsolete verification issues nothing usable

Credential verification reads a version of the credential and then takes time. **Nothing is
issued from that verification unless, under the administrator lock, the same version is still
current.**

1. **Issuing transactions re-check under the lock.** Every transaction that issues a challenge,
   a full session or a recovery session locks `administrator` first and, under that lock,
   requires: the account enabled (`disabled_at IS NULL`); the authenticator concerned not
   disabled; and **the exact version verified still current** — `password_hash` equal to the
   string that was verified; `factor_id` equal to the factor verified, with `state = 'active'`;
   the recovery-code digest still present (its conditional `DELETE` returns one row); the
   challenge still live for the same administrator (PS-4). Any mismatch rolls the transaction back
   and the request receives the generic failure (counting: D-15).
2. **Changing transactions invalidate under the same lock.** Every transaction that changes a
   password, factor, recovery-code set or account state, or revokes, locks the same row and, in
   that transaction, **deletes the administrator's pending challenges** (D-14) and the sessions
   its row in PS-8 names.
3. **Both sides take one lock, so they serialize.** If the issuing transaction commits first,
   the later change deletes what it issued. If the change commits first, the issuing
   transaction sees the new version and rolls back. The session check's enabled-state
   predicate is a further backstop for disable (`ADR-004` P-7, last row).

| Race | What prevents a usable result |
|---|---|
| Password verified, then a **reset** commits before the challenge is created | The challenge-issue transaction finds `password_hash` changed and rolls back |
| Challenge created, then a **reset, factor replacement, key replacement, disable or revoke-all** commits | That transaction marked the challenge `invalidated` (PS-4); the post-lock classification refuses the attempt without counting anything (D-15) |
| TOTP code verified against factor F, then the factor is **replaced** (re-enrolment start, reset, key replacement or the TOTP ceiling) | The acceptance `UPDATE` requires `factor_id = F` and `state = 'active'`; zero rows, rollback |
| TOTP acceptance and a **routine re-encryption** run together | Re-encryption keeps `factor_id` and is itself conditional on it, so the same secret is accepted and no stale ciphertext is written |
| Recovery code matched, then the set is **regenerated** or **reset** | The conditional `DELETE` of that digest returns zero rows; rollback |
| Sign-in waits on the lock while a **disable** commits | The issuing transaction sees `disabled_at` set and rolls back |
| Session issued, then a **disable, revoke-all or reset** commits | That transaction deletes the session; every later check refuses, as does the enabled-state predicate |
| Recovery-session operation while the recovery session **expires, is revoked, is ended or the account is disabled** | The in-transaction recovery-session re-check of PS-5 returns zero rows; rollback |
| Password succeeds while its counter reaches **the ceiling** concurrently | The ceiling sets `password_disabled_at` under the lock; whichever transaction holds the lock second sees the other result |
| A request **waits in the hash queue or on a lock** past an expiry instant | `$now` is sampled after the wait (PS-1 rule 2), so the expiry is checked at the time the decision is made |
| Password step in flight while **revoke-all** commits | Revoke-all ends existing sessions and challenges but changes no credential, so a challenge issued after its commit, from the still-current password, is legitimate. A credential change is the reset, which the first row covers |

### PS-8. Atomic operations

Each row states the sequence that enforces the outcome. `$d` is the SHA-256 digest of a
presented token or code; `$id` is always the administrator **resolved from the presented
challenge or session**, never from the request. Every transaction runs in three phases:

1. **Lock:** the PS-1 rule 4 lock phase: the administrator row, then, with no time predicate,
   the presented challenge or session row, the source row and the counter rows the transaction
   may write, each counter row inserted empty first if absent.
2. **Clock:** sample `$now` once, **after the last lock is granted** (PS-1 rule 2).
3. **Predicates and writes**, all against that `$now`. `disabled_at IS NULL` is required unless
   the row says otherwise.

Each statement is marked by what its row count means:

- **(required):** it must affect exactly the row count PS-8b gives (1, or 10 for a recovery-code
  set), or the whole transaction rolls back;
- **(branch):** its row count selects the path that follows, and neither count is an error;
- *(cleanup):* zero or more rows is expected and is never a failure.

"Generic failure, nothing counted" means a rollback, the `ADR-004` P-5 generic response, and
no write to any counter (D-15).

| Operation | Sequence | Outcome that must hold |
|---|---|---|
| **Session check** (every administrative request, Server Action and Route Handler) | One short transaction that takes **no administrator lock** (a rule-4 exception). **Lock phase:** `SELECT 1 FROM administrator_session WHERE token_digest = $d FOR UPDATE`; no row refuses. **Clock.** **(required)** `UPDATE administrator_session s SET last_activity_at = $now FROM administrator a WHERE s.token_digest = $d AND a.id = s.administrator_id AND a.disabled_at IS NULL AND s.absolute_expires_at > $now AND s.last_activity_at > $now - interval '30 minutes' RETURNING s.administrator_id, s.kind`; zero rows refuses. Commit. The join reads `administrator` without locking, and the update touches only the row already held, so nothing waits after the lock phase | Idle and absolute expiry **and** the enabled state are checked by the server in one conditional statement, at an instant sampled after any wait for the session row; cookie expiry is never relied on (P-1). A disable or revocation that committed first is seen; one still in progress is ordered after this check (P-1 semantics). Only `kind = 'administrator'` passes `C8` |
| **Password step** | **Admission:** clock; read the source record and the `password` counter of the normalized username. A source at its limit or an active wait is the generic failure: no slot is taken and nothing is counted. **Queue:** wait for a hash slot (2 running, 8 queued, 5 seconds); a timeout is a 503 with no accounting. **Re-check:** clock again; repeat both reads, refusing as at admission and releasing the slot; read `id` and `password_hash` H by normalized username. **Hash:** verify against H, or run the dummy verification for an unknown username. **Failure:** one transaction. Lock phase: the administrator (known username only), the source row, the `password` counter row. Clock. **(required)** the counter upsert; **(required)** the per-source upsert; the ceiling if reached; commit, **then** release the slot. **Success:** release the slot; one transaction. Lock phase: the administrator. Clock. Require `disabled_at IS NULL AND password_disabled_at IS NULL AND password_hash = H`, or the generic failure with nothing counted (D-15). **(required)** `INSERT` the challenge for `$id` with `created_at = $now` and `invalidated = false`; *(cleanup)* `DELETE` the `password` counter row; commit | A throttled request costs no hashing. A password alone creates only a challenge. **A password changed during verification issues nothing** (PS-8a). A failure is visible to every later re-check before its slot is reused, which gives the PS-7 bound |
| **Challenge to full session** | **Resolve** `$id` from the presented digest in `administrator_pending_challenge`, else in `administrator_consumed_challenge`. No row in either is **unknown**: generic failure, nothing counted, no transaction; a digest never returns to either table once gone, so this miss is final. One transaction. **Lock phase:** the administrator; then **both tables are looked up again**: **(branch)** `SELECT expires_at, invalidated FROM administrator_pending_challenge WHERE token_digest = $d AND administrator_id = $id FOR UPDATE` and **(branch)** `SELECT expires_at FROM administrator_consumed_challenge WHERE token_digest = $d AND administrator_id = $id FOR UPDATE`. A consumption that committed while this request waited is therefore found as consumed, never as unknown. A row in neither is unknown: roll back, nothing counted; the source row; the `totp` counter row. **Clock.** **Classify before any verification or accounting**, in the PS-4 order. Expired, disabled or invalidated: generic failure, nothing counted. **Throttle:** an active `totp` wait or the source limit: generic failure, nothing counted. **Consumed:** a replay under the D-15 rule; **(required)** the `totp` counter upsert; **(required)** the per-source upsert; the ceiling if reached; commit. **Live:** verify the code against the `active` factor (`factor_id` F and its material) at `$now`, giving `$step`. A step not greater than `last_accepted_step` is an `ADR-004` TOTP replay. **Wrong code or TOTP replay:** **(required)** the `totp` counter upsert; **(required)** the per-source upsert; the ceiling if reached; commit, and the challenge stays live (D-5). **Right code:** consume the challenge (PS-4: the **(required)** conditional `DELETE` and the **(required)** consumed-record `INSERT`); **(required)** `UPDATE administrator_totp_factor SET last_accepted_step = $step WHERE administrator_id = $id AND factor_id = F AND state = 'active' AND last_accepted_step < $step`; **(required)** `INSERT` an `administrator` session with `created_at = $now`; *(cleanup)* `DELETE` the `totp` counter row; commit | **At most one session per challenge**, **at most one acceptance per time step**, and only for **the exact factor verified** and **the administrator bound to the challenge**. Concurrent duplicates serialize on the administrator lock. The first consumes the challenge; each later one within its original lifetime finds the consumed record and **fails as a counted replay** (D-15). The same code on another live challenge fails as an `ADR-004` TOTP replay and is counted. Unknown, expired, disabled and invalidated are refused uncounted |
| **Recovery code to restricted session** | **Resolve**, **lock phase** (with the `recovery_code` counter row), **clock**, **classify** and **throttle** exactly as above, using the `recovery_code` wait. **Consumed:** a replay under the D-15 rule; **(required)** the `recovery_code` counter upsert; **(required)** the per-source upsert; the ceiling if reached; commit. **Live:** **(branch)** `DELETE FROM administrator_recovery_code WHERE administrator_id = $id AND code_digest = $c RETURNING 1`. **No row (wrong or used code):** **(required)** the `recovery_code` counter upsert; **(required)** the per-source upsert; the ceiling if reached; commit. **Nothing else is written, and the challenge stays live (D-5).** **One row:** consume the challenge (PS-4: the **(required)** conditional `DELETE` and the **(required)** consumed-record `INSERT`); *(cleanup)* `DELETE` every session of `$id`, both kinds; *(cleanup)* invalidate its other pending challenges (PS-4, D-14); **(required)** `INSERT` a `recovery` session with `created_at = $now`; *(cleanup)* `DELETE` the `recovery_code` counter row; commit | **At most one success per code** (P-7), only for the administrator whose password was verified. Code consumption, challenge consumption, revocation of its other sessions (P-4) and recovery-session issue **commit together or not at all**. A wrong code commits only its failure accounting. A duplicate on a consumed challenge, within its original lifetime, fails as a counted replay (D-15) |
| **Recovery-session authorization** (inside each of the next three rows when reached from a recovery session) | In the lock phase, after the administrator: **(required)** `SELECT absolute_expires_at, last_activity_at FROM administrator_session WHERE token_digest = $r AND administrator_id = $id AND kind = 'recovery' FOR UPDATE`. After the clock: require `absolute_expires_at > $now AND last_activity_at > $now - interval '30 minutes'`, or roll back | Only a live, unexpired recovery session of the **same** administrator authorizes the operation (PS-5) |
| **Re-enrolment start** (recovery session, provisioning or operator reset) | Lock, with the recovery session where applicable; clock; recovery-session authorization where applicable; **(required)** `INSERT ... ON CONFLICT (administrator_id) DO UPDATE SET state = 'pending_confirmation', factor_id = $g, secret_ciphertext = $c, secret_iv = $iv, secret_tag = $tag, key_version = $v, last_accepted_step = NULL`; *(cleanup)* `DELETE` its pending challenges (D-14) and its `administrator` sessions | A factor is never half-written, a pending factor never completes sign-in, and any acceptance verified against the replaced factor fails |
| **Recovery-code regeneration** (recovery session) | Lock, with the recovery session; clock; recovery-session authorization; *(cleanup)* `DELETE` all of its codes; **(required, 10 rows)** `INSERT` ten new digests; *(cleanup)* `DELETE` its pending challenges (D-14) | The set is replaced whole; a code matched against the old set fails |
| **Re-enrolment completion** (recovery session) | Lock, with the recovery session; clock; recovery-session authorization; **(required)** `DELETE FROM administrator_session WHERE token_digest = $r AND administrator_id = $id AND kind = 'recovery'`; **(required)** `UPDATE administrator_totp_factor SET state = 'active', last_accepted_step = $step WHERE administrator_id = $id AND factor_id = $g AND state = 'pending_confirmation'`; *(cleanup)* `DELETE` its codes; **(required, 10 rows)** `INSERT` ten new digests (D-8); *(cleanup)* `DELETE` its pending challenges (D-14) | The recovery session ends and a fresh full sign-in with the new factor is required (P-1). It confirms only **the factor generated in this re-enrolment** |
| **TOTP confirmation** (provisioning or operator reset) | Lock; clock; **(required)** the same confirmation `UPDATE` naming `factor_id = $g`; *(cleanup)* `DELETE` its pending challenges (D-14) | Of concurrent confirmations, at most one succeeds, and only for the secret the operator verified |
| **Failure counter** | **(required)** `INSERT ... ON CONFLICT (scope, subject_digest) DO UPDATE SET consecutive_failures = t.consecutive_failures + 1, last_failure_at = $now, wait_until = CASE WHEN t.consecutive_failures + 1 >= 5 THEN $now + LEAST(interval '30 seconds' * power(2, t.consecutive_failures + 1 - 5), interval '1 hour') END RETURNING consecutive_failures, wait_until`, inside the failure transactions above, after their clock | Concurrent failures are never lost; the wait is computed in the same statement; a success resets only its own counter (P-7) |
| **Per-source counter** | In the lock phase of every transaction that may count a failure: *(cleanup)* `INSERT ... ON CONFLICT (source_digest) DO NOTHING` of an empty row, then `SELECT ... FOR UPDATE`. After the clock: **(required)** the upsert of the form chosen under D-6 (PS-7) | Concurrent failures are never lost; a check made under the lock is exact |
| **Ceiling at 100** | In the failure transaction, under the lock, when the counter returns `>= 100`: **password** sets `password_disabled_at` (an unknown username has no account and nothing to disable); **TOTP** sets `reenrolment_required` and discards the material and `factor_id` (D-3); **recovery codes** *(cleanup)* deletes the remaining codes (D-4). Each also *(cleanup)* deletes the pending challenges of that administrator (D-14) | Only that authenticator is disabled (P-5); in-flight verifications of it fail by PS-8a |
| **Logout** | *(cleanup)* `DELETE FROM administrator_session WHERE token_digest = $d` (either kind) | Every subsequent check refuses |
| **Revoke one** / **revoke all** | **(required)** `DELETE FROM administrator_session WHERE id = $session_id AND administrator_id = $id`; no row reports that no such session exists / one transaction: lock (enabled not required); *(cleanup)* `DELETE` its sessions (both kinds) and pending challenges (D-14) | Every session check that begins after the commit refuses. Work already past its check may finish; no ordering is guaranteed against a concurrent write (`ADR-004` P-1 semantics, unchanged) |
| **Disable account** | One transaction: lock (enabled not required); clock; **(required)** `UPDATE administrator SET disabled_at = $now WHERE id = $id AND disabled_at IS NULL`; no row reports that the account is already disabled; *(cleanup)* `DELETE` its sessions (both kinds) and pending challenges (D-14) | As above; issuing transactions waiting on the lock roll back, and the enabled-state predicate refuses anything else |
| **Operator reset (break-glass)** | One transaction: lock (whether a disabled account may be reset: D-16); clock; **(required)** replace `password_hash` with a fresh salt and clear `password_disabled_at`; the re-enrolment start with a new `factor_id`; *(cleanup)* `DELETE` its codes and **(required, 10 rows)** `INSERT` ten new digests; *(cleanup)* `DELETE` its sessions, pending challenges (D-14) and throttle rows (the `password` row of its username and its `totp` and `recovery_code` rows). Confirmation follows as a separate transaction | No transaction is held open during operator input. The account cannot sign in until the new factor is confirmed, and **every verification of the old password, factor or codes fails** (PS-8a) |
| **Key replacement without the old key** | Per administrator, one transaction: lock (enabled not required); **(branch)** `UPDATE administrator_totp_factor SET state = 'reenrolment_required', factor_id = NULL, secret_ciphertext = NULL, secret_iv = NULL, secret_tag = NULL, key_version = NULL, last_accepted_step = NULL WHERE administrator_id = $id AND (key_version <> ALL($available_versions) OR $suspected_compromise)`. No row: the factor stays readable and nothing else is written. One row: *(cleanup)* `DELETE` its sessions (both kinds) and pending challenges (D-14) | **Never reads, decrypts or needs the old key.** "Not readable" is decided from `key_version` alone. Password hashes and recovery-code digests are untouched, so the password-plus-recovery-code route survives (P-6) |
| **Routine re-encryption** (old key available) | One transaction: lock; **(required)** `UPDATE ... SET secret_ciphertext = $c, secret_iv = $iv, secret_tag = $tag, key_version = $new WHERE administrator_id = $id AND factor_id = F AND key_version = $old`. **No challenge is deleted:** re-encrypting the same secret is not a factor change (D-14) | The same secret under a new key; a factor replaced meanwhile is not overwritten |

**Expired rows are inert.** Every read predicate excludes them, so correctness never depends on
their removal. Removing them is housekeeping for this local design and **sets no retention
period** for anything `OQ-14` + `NOQ-8` or `NOQ-7` might govern.

### PS-8b. Required affected-row counts

Each **(required)** statement must affect **exactly** the count below, or the whole transaction
rolls back. A count of 10 applies only to the recovery-code set inserts; every other required
statement affects exactly 1 row. **(branch)** statements may affect 0 or 1 row and choose the
path; *(cleanup)* statements may affect any number and are never checked.

| Operation | Required statements and counts | Branch statements |
|---|---|---|
| Session check | `UPDATE` session: 1 | Session `SELECT ... FOR UPDATE`: 0 refuses |
| Password step, failure | Counter upsert: 1; per-source upsert: 1; password ceiling `UPDATE administrator`: 1 when reached | — |
| Password step, success | Challenge `INSERT`: 1 | — |
| Challenge to full session, success | Challenge `DELETE`: 1; consumed-record `INSERT`: 1; factor step `UPDATE`: 1; session `INSERT`: 1 | Pending and consumed lookups under the lock |
| Challenge to full session, failure or replay | Counter upsert: 1; per-source upsert: 1; TOTP ceiling `UPDATE`: 1 when reached | As above |
| Recovery code to restricted session, success | Challenge `DELETE`: 1; consumed-record `INSERT`: 1; recovery-session `INSERT`: 1 | Lookups as above; code `DELETE`: 1 |
| Recovery code to restricted session, failure or replay | Counter upsert: 1; per-source upsert: 1 | Lookups as above; code `DELETE`: 0 |
| Recovery-session authorization | Recovery-session `SELECT ... FOR UPDATE`: 1 | — |
| Re-enrolment start | Factor upsert: 1 | — |
| Recovery-code regeneration | Code `INSERT`: **10** | — |
| Re-enrolment completion | Recovery-session `DELETE`: 1; factor confirmation `UPDATE`: 1; code `INSERT`: **10** | — |
| TOTP confirmation | Factor confirmation `UPDATE`: 1 | — |
| Revoke one | Session `DELETE`: 1 (0 reports no such session) | — |
| Disable account | `UPDATE administrator`: 1 (0 reports already disabled) | — |
| Operator reset | Password `UPDATE`: 1; factor upsert: 1; code `INSERT`: **10** | — |
| Key replacement | — | Factor `UPDATE`: 0 leaves the factor readable |
| Routine re-encryption | Factor `UPDATE`: 1 | — |
| Logout, revoke all | — | — |

### PS-9. Deliberate omissions

Each item below is an alternative this decision does not adopt. An author who adds one back
silently adopts it; an omission here is **not a ruling that the capability must never exist**.

- **No event, history or attempt-log table.** That would answer `OQ-14` + `NOQ-8` by
  construction. (The D-6 rolling record keeps at most 20 bare instants per keyed source as
  authentication enforcement state and decides no audit obligation. The D-15 consumed-challenge
  record holds only a digest, an administrator and an original expiry, and means nothing after
  that expiry.)
- **No raw client address and no raw submitted username** in any throttle table: only keyed
  digests are stored.
- **No database clock default, trigger, cascade, `pgcrypto` call or stored procedure.**
  Cryptography stays in `node:crypto` and `otpauth` (`ADR-004`).
- **No session payload or role column.** `FR-AUTH-01` admits no role beyond administrator.
- **No route that creates an administrator and no self-service registration** (`ADR-004` P-6,
  `FR-AUTH-04`).
- **No deletion and no re-enable operation is designed.** Both are deferred (D-11, D-12, ruled
  2026-11-01). Their absence here reflects the scope of this design and of `ADR-004`, **not a
  permanent policy**.

---

## Owner rulings — 2026-11-01

**The Product Owner ruled every decision below on 2026-11-01** (issue #256). D-15 was ruled
first (*D-15 ruling record*); D-1 to D-14, D-16 and D-17 were approved as recommended, with the
qualifications in the *Ruling record*. The rulings fix these choices **within this ADR**, which was
**accepted on 2026-11-01** (*Status and chronology*).

| # | Decision | Ruling (2026-11-01) |
|---|---|---|
| **D-1** | Username form and normalization | Provisioned usernames are lower-case ASCII matching `^[a-z0-9][a-z0-9._-]{2,63}$`. A submitted username is NFC-normalized and lower-cased before lookup and throttle keying |
| **D-2** | Stored password-hash encoding and derived-key length | A PHC-style string `scrypt$ln=17,r=8,p=1$<salt base64>$<key base64>`, with a **32-byte** derived key |
| **D-3** | How a TOTP factor disabled at 100 failures is represented | Reuse `reenrolment_required` and discard the material: the password-plus-recovery-code route then leads to re-enrolment, as P-5 requires |
| **D-4** | How recovery codes disabled at 100 failures are represented | Delete the remaining codes; new codes come from re-enrolment or the operator reset (P-5) |
| **D-5** | Whether a failed second factor consumes the pending challenge | **No.** It stays usable until expiry or success, with each failure counted and throttled under the lock |
| **D-6** | Window semantics for *"20 failed attempts per hour"* per source | The **bounded rolling record** (PS-7): no more than 20 failures in any rolling hour, as **authentication enforcement state** that decides no audit obligation. The value 20 per hour is unchanged |
| **D-7** | The key for throttle digests | A separate server-held HMAC key, never in the database, with a development-only value locally (as `ADR-004` L-5) |
| **D-8** | When fresh recovery codes are issued after recovery | In the same transaction that completes re-enrolment, shown once |
| **D-9** | The handle for "revoke one session" | A non-secret application-generated session `id` |
| **D-10** | Whether `ADR-004` lifetimes become store constraints | **Yes**, as the `CHECK`s in PS-4 and PS-5 |
| **D-11** | Administrator deletion and retention | **Deferred, not a permanent policy:** no local slice deletes an administrator; synthetic local data may be discarded by recreating the local database, which is not a product deletion. Retention and deletion stay with `OQ-14` + `NOQ-8` and `NOQ-7` |
| **D-12** | Whether a disabled account may be re-enabled | **Deferred, not a permanent policy:** no slice clears `disabled_at`. If re-enabling is later approved, it should be an operator-command operation under the lock that also requires a password and TOTP reset |
| **D-13** | How "the exact factor verified" is identified | An explicit application-generated `factor_id`, renewed with every new secret, rather than comparing `secret_iv` and `key_version`, which change on routine re-encryption and give a cryptographic parameter a second meaning |
| **D-14** | Which pending challenges a change invalidates | Every password, factor or recovery-code change (including the ceiling actions, but not re-encryption of the same secret), every account-state change and revoke-all deletes **all** pending challenges of that administrator; recovery-code success also deletes its other challenges. PS-8 marks each such deletion *(cleanup)* |
| **D-15** | Consumed-challenge classification | **Ruled 2026-11-01 (see the ruling record):** Design B; `ADR-004`'s conditional `DELETE` is preserved, plus an atomic consumed-challenge record; expiry takes precedence; later invalidation preserves consumed records; the disabled checks take precedence. Correct but obsolete verifications (PS-8a) are uncounted |
| **D-16** | Whether the operator reset applies to a disabled account | Allowed, but it **does not re-enable**: sign-in stays refused while re-enabling is deferred (D-12) |
| **D-17** | The password-step overshoot | **Accepted only for synthetic local use.** With P processes handling sign-in (PS-7, walkthrough): at most **2P** failures beyond the per-source limit, and at most **2P − 1** beyond a per-username wait or ceiling threshold; second-factor steps never count past a limit. Before relying on it, the implementation must establish P, keep each failed verification's hash slot until its accounting commits, and test the bound. **Production acceptance is deferred** and is to be re-assessed under `ADR-004` R-1 before any public reachability |

### D-15 ruling record — 2026-11-01

**Ruled by the Product Owner (Joe S.), 2026-11-01, issue #256.** The ruling fixes D-15 within
this ADR. It was recorded while ADR-028 was `Proposed`; ADR-028 was accepted later the same day.

1. **Design B is approved.** `ADR-004` P-7's conditional `DELETE` of a consumed challenge is
   **preserved**. The same transaction atomically inserts a **consumed-challenge record**
   holding the challenge's digest, administrator identity and original expiry (PS-4).
2. **Expiry takes precedence.** A consumed challenge counts as a replay only within its
   original five-minute lifetime. Afterwards it is expired and uncounted, independent of
   housekeeping.
3. **Later invalidation preserves consumed records.** The disabled-account and
   disabled-password checks take precedence over the consumed classification.
4. **No successor ADR.** `ADR-004` is unchanged, because its conditional `DELETE` is kept.

**What it adds to `ADR-004`.** `ADR-004` P-7 requires that concurrent submissions of one TOTP
code fail as replays and count as failures. That requirement stays enforced by
`last_accepted_step`. The ruling adds a **separate classification rule**: a submission on a
consumed challenge, within its original lifetime, is a counted replay for either second factor
(PS-4, *Two replay rules, kept distinct*).

### Ruling record — D-1 to D-14, D-16 and D-17 — 2026-11-01

**Ruled by the Product Owner (Joe S.), 2026-11-01, issue #256.** D-1 to D-14, D-16 and D-17 are
approved as recommended. The existing D-15 ruling is preserved. The following qualifications are
part of the ruling:

- **D-6:** the bounded rolling record is adopted as **authentication enforcement state**. It
  decides **no** eventual audit obligation (`OQ-14` + `NOQ-8`).
- **D-11 and D-12** are **deferrals, not permanent product policies**. No local slice deletes
  or re-enables an administrator. Retention and deletion stay with `OQ-14` + `NOQ-8` and
  `NOQ-7`, and re-enablement stays undecided.
- **D-17 is accepted only for synthetic local use.** Before relying on the bound, the
  implementation must:
  1. establish the number of processes that handle sign-in;
  2. retain each failed verification's hash slot until its accounting commits;
  3. test the bound.

  **Acceptance for production is deferred.**

---

## Alternatives considered

| Alternative | Why it is not adopted |
|---|---|
| **One token table for challenges and sessions**, distinguished by a kind column | One wrong predicate would let a password-only challenge pass a session check. Separate tables make that impossible by construction |
| **Session and throttle state in process memory or a cache** | Breaks the stateless-instance requirement (`ADR-005`) and adds an unapproved service |
| **Stateless signed cookies** | Rejected by `ADR-004` (*Alternatives considered*), and logout and revocation could not refuse later checks |
| **TOTP columns on `administrator`** | Mixes re-enrollable material with identity, and makes "material present if and only if usable" harder to state as one row constraint |
| **Trusting a verification without re-checking the version under the lock** | A reset, factor replacement or disable committed during a multi-second hash would not stop the session being issued (PS-8a) |
| **`secret_iv` as the factor version** | Changes on routine re-encryption of the same secret, and gives a cryptographic parameter a second meaning (D-13) |
| **A "used" flag on recovery codes** | `ADR-004` P-4 deletes a used code. A retained used row is history, which edges toward `OQ-14` |
| **Database clock (`now()`) in predicates** | Departs from the `ADR-022` posture and makes expiry untestable with an injected clock |
| **Storing failed attempts as rows and counting them** | Unbounded growth, an implicit attempt history (`OQ-14`), and non-atomic counting. The D-6 rolling record is bounded at 20 bare instants per keyed source instead |
| **A fixed one-hour per-source window** | Admits up to 39 failures within seconds across a window boundary, so it does not meet the any-hour reading of *"20 failed attempts per hour"*. Not adopted: D-6 (2026-11-01) chose the bounded rolling record |
| **Terminal-state `UPDATE` of the challenge row instead of deleting it** | Departs from `ADR-004` P-7's conditional `DELETE` and would need a successor ADR. Not adopted: the D-15 ruling of 2026-11-01 chose the consumed-challenge record instead |

---

## Consequences

**Positive:**

- Every `ADR-004` P-7 outcome has a named statement shape that can be attacked with concurrent
  duplicate requests against a real PostgreSQL.
- Expiry, enabled state, replay and credential freshness are enforced on the server and in the
  store; an obsolete verification issues nothing usable.
- Key loss is recoverable without the lost key.

**Negative:**

- Eight new tables, and a write on every session check (`last_activity_at`).
- All authentication writes for one administrator serialize on its row. With a handful of
  administrators this is negligible, and it is what makes the second-factor waits exact.
- Lifetime `CHECK`s make a parameter change a migration.
- Password-step limits can be exceeded by at most 2 failures per process that handles sign-in
  (D-17). Throttle rows for attacker-supplied usernames, empty counter rows, invalidated
  challenges and consumed-challenge records awaiting housekeeping can accumulate. These are
  pre-public-reachability concerns alongside `ADR-004` R-1 and R-2.

**Reversibility:** **Moderate.** The tables are new and forward-only (`ADR-018`). An external
identity provider would later replace `administrator.password_hash` and the TOTP and recovery
tables, but keep the identity and session shape.

**Migration sequencing (recommended; each migration lands with the first slice that depends on
it):** `003` creates `administrator`, `administrator_totp_factor`,
`administrator_pending_challenge`, `administrator_consumed_challenge`, `administrator_session`,
`authentication_throttle` and `authentication_source_window` with the first sign-in slice. That
slice already performs failure accounting, source checks and the D-17 verification, and its
second-factor lock phase locks both throttle tables. `004` creates `administrator_recovery_code`
with the recovery slice. Until then,
provisioning enrols the password and TOTP but issues no recovery codes. **That deferral does not
satisfy complete `ADR-004` provisioning**, which also issues recovery codes (P-6). Complete
provisioning, including recovery-code issuance, **remains required before any public
reachability**.

**Implementation review boundaries (recommendation only; each needs its own authorized issue
under #254).** The first working sign-in may be reviewed in two pull requests, provided **no
intermediate state exposes a route or command that issues a session without server-side
expiry, atomic duplicate protection, request checks and bounded hashing**:

1. **Storage and primitives, with no reachable surface.** Migration `003`, including both throttle
   tables; the PS-8 statements
   for the password step, challenge to session, session check, logout, provisioning enrolment
   and confirmation; the scrypt hasher **only behind** the bounded limiter (2 running, 8 queued,
   5 seconds, then 503 with `Retry-After`); the TOTP wrapper, secret box and token digests.
   Reviewed against a real local PostgreSQL for expiry with an injected clock, `$now` sampled
   after queue and lock waits, the post-lock challenge classification, concurrent duplicate
   challenge and TOTP submissions, replay, factor-version and password-version races, the
   password re-check after a slot is granted, failed-verification slots held through the
   accounting commit, the D-17 bound itself, and limiter saturation. No route, page or command.
2. **The first usable journey.** The local-only gate (development mode, the web server bound
   to loopback, a loopback `Host` check, a local database), the synthetic-account provisioning
   command, password then TOTP sign-in, logout, the trivial protected page, the session check
   on every administrative entry point, `Origin` and `Sec-Fetch-Site` refusal, and the cookie
   attributes. It wires only the reviewed primitives of step 1, so expiry, duplicate
   protection, request checks and bounded hashing are present from its first usable version.

Revocation and disable, recovery codes and the recovery session, key replacement and the
operator reset then follow as their own slices. **All `ADR-004` controls and the security
review remain prerequisites before any public reachability**, which stays prohibited.

**Implementation acceptance expectations for these cases.** Each is exercised against a real
local PostgreSQL in the slice that introduces it:

- **Lookup again after the lock:** a duplicate that resolved a pending challenge before waiting
  on the administrator lock, while another request consumed it, is classified **consumed** and
  counted. It is never classified as unknown.
- **Required row counts:** every required statement is asserted against its PS-8b count, and a
  mismatch rolls the whole transaction back. This includes exactly ten code inserts in
  regeneration, re-enrolment completion and the operator reset (recovery slice).
- **Throttle tables in `003`:** the first slice's failure accounting, source checks, its
  second-factor lock phase and the D-17 bound test all run against `authentication_throttle`
  and `authentication_source_window` created by migration `003`.

---

## Open questions this decision must NOT answer

| Open question | How this decision avoids it |
|---|---|
| **`OQ-14` + `NOQ-8`**: audit logging | Current state only; no event or history storage (PS-1 rule 6, PS-9). Whether provisioning, reset, revoke, disable or authentication events require audit in the eventual product is **not decided**. Local operational logging under #254 is evidence for synthetic testing only |
| **`OQ-14` + `NOQ-8`**: retention and deletion of administrator records | No deletion operation is designed and no retention period is set (PS-1 rule 3, D-11). Disable-not-delete is the `ADR-004` P-6 scope, which **does not decide that identifiers are kept indefinitely** |
| **`NOQ-7`**: operational-log retention | No retention period for any log. Expired-row removal is housekeeping and sets none |
| **`OQ-9`**: anti-spam | The throttle tables serve `C8` sign-in only, never the public submission path or `C11` |
| **`NOQ-5`, `NOQ-6`**: accessibility level and support matrix | No storage choice touches them. The sign-in screen a later slice adds claims no conformance level or support matrix |
| **#246 / `BI-4`** | Untouched; `BI-4` stays **pending**. No timing threshold is set |
| **`DG-3`, `DG-4`** | `DG-3` stays `Unresolved`; nothing here is releasable. Public administrative reachability stays prohibited (#254, `ADR-004` ruling 7) |
| **`ADR-004` parameters and R-1 to R-4** | Cited, not changed. D-6 interprets the window of the per-source limit without changing its value; the production client-address header and sizing stay R-1 and R-2 |

---

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-SEC-01`, `02`, `04`, `07`, `08`; `NFR-OBS-01`, `02`; `FR-AUTH-01`–`04` |
| **Entities and invariants** | `docs/08` `E3`; `docs/09` `AA-1`–`AA-5`; `docs/11` `BI-5`, `BI-9`; must not breach `BI-4`, `BI-6` |
| **Components** | `C8`, `C9`, `C12` |
| **Decisions relied on** | `ADR-003`, `ADR-004`, `ADR-005`, `ADR-014`, `ADR-016`, `ADR-018`; posture adopted from `ADR-019`, `ADR-022`, `ADR-024` without extending them |
| **Issue / pull request** | Issue #256 |
