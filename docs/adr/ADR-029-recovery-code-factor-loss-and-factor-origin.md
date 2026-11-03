# `ADR-029` — Treat a successful recovery-code use as loss of the TOTP factor, and record each pending factor's recovery origin in storage, so that only the recovery session that started a factor can complete it

| Field | Value |
|---|---|
| **Status** | **`Proposed`**, 2026-11-03 (issue #262). **Not in force**; nothing may depend on it until a separately authorized acceptance |
| **Date** | 2026-11-03 |
| **Decision owner** | **Joe S.**, product owner and architecture owner (`docs/13`, *Gate summary*) |
| **Decision gate** | **`DG-3`**, which **remains `Unresolved`**. This ADR is written under `DG-3` once its own question is answered, inside the local-only exception of issue #254, as `ADR-004` and `ADR-028` were |
| **Related open questions** | **Depends on two Product Owner rulings of 2026-11-03** (issue #262; recorded in `docs/13`, *Ungated Product Owner policy clarifications*): **RQ-1:** `ADR-004` P-4 applies to the account (Reading A). **RQ-2:** `ADR-004` P-5's ceiling bullets are authenticator-local. **Must NOT answer:** `OQ-14` + `NOQ-8`, `NOQ-7`, `OQ-9`, `NOQ-5`, `NOQ-6`, `BI-4` timing (#246), `DG-4`, any `ADR-004` value, and `ADR-004` R-1 to R-4 |
| **Supersedes** | **`ADR-028`**, by whole supersession **by reference** (RA-10), **only on acceptance**. Until then `ADR-028` stays `Accepted` and in force, and is not marked `Superseded` |
| **Superseded by** | *none* |

> **`Proposed`, and therefore NOT in force.** Per `docs/adr/README.md`, a `Proposed` ADR is
> *"Drafted and under review. The decision is **not yet in force**; nothing may depend on it."*
> **This document does not accept itself**, and **`ADR-028` stays `Accepted` and in force** until
> this ADR is separately accepted. It authorizes no implementation, migration, schema, route,
> command or test, and **does not change `ADR-004`**. The RQ-1 and RQ-2 rulings it relies on are
> recorded in `docs/13`.

---

## Context

### What the accepted documents say

`ADR-004` P-4 says a successful recovery-code use "yields the **restricted recovery session**
(P-1), **revokes the administrator's other sessions**, and requires TOTP re-enrolment and fresh
codes before any administrative access", on the basis that it "Treats the use of a recovery code
as a suspected loss of the device".

`ADR-028` PS-8 *Recovery code to restricted session*, in its success branch:
- consumes the challenge;
- deletes every session, of both kinds;
- invalidates the other pending challenges;
- inserts the recovery session;
- clears the counter.

**It writes no factor row.** *Challenge to full session* issues a full session from password plus
a code of "the `active` factor". So under `ADR-028`, the old factor keeps issuing full sessions
after a code use until *Re-enrolment start* replaces it.

`ADR-028` also records **no origin** for a pending factor. Storage therefore cannot tell a factor
started by provisioning from one started inside a recovery session. Its *TOTP confirmation* row
("provisioning or operator reset") can activate either.

### Why a successor ADR

Under Reading A, `ADR-028` under-implements its fixed input. Recording a factor's origin is a new
data decision. An accepted ADR is not edited into agreement (`docs/adr/README.md`: "**write a new
ADR** that supersedes it").

### Facts from the code at `f7f77d6`

- **`completeTotpChallenge`** refuses with `FACTOR_UNAVAILABLE`, **uncounted**, whenever the factor is not `active`. That check comes after classification and the throttle.
- **`startTotpEnrolment`** (the provisioning form of *Re-enrolment start*):
  - upserts the factor to `pending_confirmation`, naming its columns explicitly;
  - invalidates pending challenges;
  - deletes **only `kind = 'administrator'` sessions**.
- **`confirmTotpEnrolment`** activates the named pending factor:
  - from a **caller-supplied `step`**, verifying no code;
  - issuing no codes;
  - checking no session.

  A `CHECK` violation inside its transaction returns `{ ok: false, failure: { code: "INTEGRITY_CONFLICT", sqlState: "23514", constraint } }` and rolls the whole transaction back.
- **`logout`** is a single cleanup `DELETE` of a session of either kind, taking no administrator lock.
- **Migration `003`** enforces:
  - "material present if and only if `state <> 'reenrolment_required'`";
  - "`state <> 'active' OR last_accepted_step IS NOT NULL`".

  Its constraint names follow `<table>_<purpose>_check`.
- **Existing tests** select explicit factor columns, not `*`.

## Authority relationship with `ADR-004` (RQ-1 and RQ-2, ruled 2026-11-03)

### The provisions

- **P-4, *Use*:** "Success yields the **restricted recovery session** (P-1), **revokes the administrator's other sessions**, and requires TOTP re-enrolment and fresh codes before any administrative access | Treats the use of a recovery code as a suspected loss of the device"
- **P-1, *Recovery session*:** "It permits **only** TOTP re-enrolment, recovery-code regeneration and logout; … Completing re-enrolment ends it and requires a fresh full sign-in with the new factor"
- **P-5, *Ceiling*:** "**that authenticator alone is disabled**. **Password disabled:** no sign-in route remains … recovery is the **operator procedure** (P-6). **TOTP disabled:** the **password plus recovery-code** route remains … **Recovery codes disabled:** the normal password-plus-TOTP route remains, and new codes are issued through re-enrolment or the operator procedure"
- **P-6, *Recovery procedure*:** "**(1)** password plus a recovery code, leading to the restricted recovery session (P-1); **(2)** otherwise the operator, with server and database access, runs the command to reset the password and TOTP, which revokes all sessions and issues new recovery codes"
- **P-6, *Key replacement* (3):** "each administrator signs in with password plus a recovery code and re-enrols, or the operator re-enrols them with the provisioning command"

### RQ-1 (ruled 2026-11-03: Reading A)

P-4's requirement applies to the **account**. After a code use, no administrator session is
issued until re-enrolment completes and fresh codes exist. This is based on P-4's own reason:
"suspected loss of the device".

### When no route remains

**Facts carried forward from `ADR-028`:**
- **Consuming the last code still succeeds** and opens a recovery session Q, leaving 0 codes.
- **Through a live Q,** regeneration inserts 10 codes, and completion activates a new factor and inserts 10 codes.
- **The recovery-code ceiling deletes codes and invalidates challenges, but deletes no session.** A live Q therefore survives it. Regeneration and completion do **not** clear the `recovery_code` counter.
- **The password ceiling deletes no session either,** and PS-5 does not test `password_disabled_at`.

**State O (operator-only).** An account is in state O when **neither** of these remains:
- **a usable sign-in route:** the account is enabled, the password is not disabled, **and** the factor is `active` or at least one code remains;
- **a valid recovery-session route:** a live recovery session (unexpired, with the account enabled) through which regeneration or completion can still run.

| How state O is reached | Under accepted `ADR-004` and `ADR-028` | Additionally under this ADR |
|---|---|---|
| **O-1.** The last code is consumed, and its recovery session then ends (expiry, logout, or a later revocation) without regeneration or completion, with no factor `active` | If the factor was already unusable before the last code was used (the TOTP ceiling, or key replacement), **or** a re-enrolment start in that session replaced it before the session ended | Whenever the last code is used and its session ends unfinished, because the code use discards the factor (RA-1) |
| **O-2.** The ceiling deletes the codes while no factor is `active`, and no live recovery session completes | The TOTP ceiling (D-3), then the recovery-code ceiling (D-4) | One code use, then the ceiling |
| **O-3.** The password is disabled | The password ceiling | Unchanged |

**A disabled account** (`disabled_at`) also has neither route, but it is **not recoverable by the
operator reset alone**: D-16 allows a reset of a disabled account, but the reset **does not
re-enable** it. Restoring it needs the **separately deferred re-enablement procedure** (D-12), which
D-12 says should be an operator-command operation under the lock that also requires a password and
TOTP reset. **No such procedure is designed or authorized.**

### RQ-2 (ruled 2026-11-03: authenticator-local)

- **P-5's bullets state what each ceiling itself disables** ("that authenticator alone is disabled"). "Remains" means the ceiling does not remove the other route. It is not a guarantee that holds regardless of other provisions.
- **P-6 (2), the operator reset, governs every state O of an *enabled* account.** A disabled account additionally needs the deferred re-enablement procedure (D-12, D-16).
- **This is the only reading under which the accepted design is itself consistent,** because D-3 followed by D-4 already falsifies the guarantee reading.

### Relationship

- **`ADR-004` stays the authority for P-1 and P-4 to P-6, unedited and not superseded.** RQ-1 and RQ-2 are recorded as owner interpretations in `docs/13`.
- **`ADR-029` supersedes only `ADR-028`.**
- **Accepting a risk does not reconcile two provisions.** The exposure this ADR creates (*Consequences*, *Risks*) is a separate risk, accepted only for synthetic local use, and only at this ADR's acceptance.

## Decision

**We will:**
1. discard the TOTP factor in the same transaction as a successful recovery-code use;
2. keep the remaining codes for recovery;
3. record, in storage, the recovery session that started each pending factor;
4. require that origin for recovery completion and its absence for provisioning confirmation;
5. enforce, per activation path, that fresh codes exist and no recovery session outlives the recovery.

### RA-1. Factor discard on recovery-code success

In the success branch, under the administrator lock, after the code's conditional `DELETE`
returned one row and the challenge was consumed, and before the recovery-session `INSERT`,
*(cleanup)*:

```sql
UPDATE administrator_totp_factor
   SET state = 'reenrolment_required', factor_id = NULL, secret_ciphertext = NULL,
       secret_iv = NULL, secret_tag = NULL, key_version = NULL, last_accepted_step = NULL,
       origin_recovery_session_id = NULL
 WHERE administrator_id = $id AND state <> 'reenrolment_required'
```

- **It covers an `active` factor and a `pending_confirmation` factor alike.** The count is 0 or 1, and neither is an error.
- **Classification precedence is preserved.** From that commit, until a factor is activated again, *Challenge to full session* keeps classifying in its existing PS-4 order.
  - Unknown, expired, disabled (account or password), invalidated and throttled challenges are refused uncounted, as before.
  - A consumed challenge is still a counted replay (D-15).
  - **Only an otherwise eligible live challenge reaches the factor check**, where it is refused `FACTOR_UNAVAILABLE`, uncounted.
- **Sessions issued earlier were deleted in the same commit.** A request already past its session check may finish (`ADR-004` P-1 semantics).

### RA-2. The remaining codes are kept, for recovery only

Only the presented code is deleted. Old codes **never coexist with administrative access**:
administrative access needs an `active` factor, and every permitted activation path issues fresh
codes (RA-6). Deleting the remaining codes would turn every abandoned recovery into state O-1.

### RA-3. Origin provenance (storage)

**Column:** `administrator_totp_factor.origin_recovery_session_id uuid`.
- It is nullable, with **no default** (the `ADR-022` posture) and **no foreign key**, because sessions are deleted.
- It holds the **non-secret** `administrator_session.id` (D-9), never a token or a digest.

**Constraint:** `administrator_totp_factor_origin_check`:

```sql
CHECK (origin_recovery_session_id IS NULL OR state = 'pending_confirmation')
```

So an origin exists only on a pending factor, and **no history is kept**. It is current state
only (PS-1 rule 6).

**The column's value after every operation that creates, replaces, discards or activates a
factor:**

| Operation | Value afterwards | Enforced by |
|---|---|---|
| `startTotpEnrolment` (existing, provisioning form), **insert** | `NULL` (the column is omitted from its insert) | Storage |
| `startTotpEnrolment` (existing), **upsert over an existing row** | **Unchanged.** Its `DO UPDATE` does not name the column, so a pending row with an origin **keeps** it | Storage writes nothing; **excluding this use is a caller restriction** (RA-7) |
| **Recovery-session *Re-enrolment start*** (new, RA-4) | `Q.id` of the presenting recovery session, on insert and on upsert | Storage |
| **Recovery completion** (new, RA-4) | `NULL`, in the same **(required)** `UPDATE` that sets `active` | Storage |
| **Initial provisioning confirmation** (new, RA-5) | Requires `NULL` beforehand; stays `NULL` | Storage |
| `confirmTotpEnrolment` (existing) on a factor with origin `NULL` | `NULL`; activates as at `f7f77d6` | Storage |
| **`confirmTotpEnrolment` (existing) on a factor with an origin** | **The `UPDATE` violates `administrator_totp_factor_origin_check`.** It returns `INTEGRITY_CONFLICT`, `23514`, rolls back and writes nothing | **Storage: an intentional behaviour change; its source is unchanged** |
| **RA-1 discard** (new) | `NULL` | Storage |
| TOTP ceiling (existing, `active` to `reenrolment_required`) | `NULL` (an `active` row's origin is `NULL`) | Storage |
| TOTP step advance (existing, `active`) | `NULL` | Storage |
| Key replacement, discard or re-encryption (future) | **Must** write `NULL`; otherwise its `UPDATE` fails the `CHECK` | Storage (fail-closed); a future-conformance requirement |
| Operator reset, re-enrolment start (future) | **Must** write `NULL` | A future-conformance requirement |
| Logout, revocation, expiry, housekeeping | Unchanged. An origin may name a deleted session. That is by design: such a factor can no longer be completed, because no live session has that `id` | — |

### RA-4. Recovery-session sequences (amending `ADR-028` PS-8)

***Re-enrolment start*, recovery-session form.**
1. **Lock:** the administrator, then the presented recovery session Q `FOR UPDATE`.
2. **Clock.**
3. **Recovery-session authorization** (PS-5).
4. **(required)** `INSERT … ON CONFLICT (administrator_id) DO UPDATE SET state = 'pending_confirmation', factor_id = $g, secret_ciphertext = $c, secret_iv = $iv, secret_tag = $tag, key_version = $v, last_accepted_step = NULL, origin_recovery_session_id = $q`, with the insert values including `$q`.
5. *(cleanup)* Invalidate the pending challenges.
6. *(cleanup)* Delete the `administrator` sessions.

***Re-enrolment completion*.**
1. **Lock:** the administrator, then Q.
2. **Clock.**
3. **Recovery-session authorization.**
4. **(branch)** Read the factor row. Unless `state = 'pending_confirmation' AND factor_id = $g AND origin_recovery_session_id = $q`, **refuse with nothing written**.
5. Verify the code against `$g`'s material at `$now`, giving `$step`. A mismatch is refused with nothing written, uncounted.
6. **(required)** `DELETE` Q.
7. **(required)** `UPDATE administrator_totp_factor SET state = 'active', last_accepted_step = $step, origin_recovery_session_id = NULL WHERE administrator_id = $id AND factor_id = $g AND state = 'pending_confirmation' AND origin_recovery_session_id = $q`.
8. *(cleanup)* Delete the codes.
9. **(required, 10)** Insert ten digests.
10. *(cleanup)* Invalidate the pending challenges.

**Binding:** recovery completion activates **only** a factor whose origin is the presenting recovery session. That is a storage rule for this operation.

**Reachability of a mismatched origin.** Under Reading A, a second recovery session exists only after a code success, and that success discards any pending factor (RA-1). A mismatched origin is therefore not reachable through the operations this ADR defines. The predicate is a backstop, and it is tested by setting the state directly.

### RA-5. Initial provisioning confirmation (new `ADR-028` PS-8 row)

1. **Lock:** the administrator.
2. **Clock.**
3. Require `disabled_at IS NULL`.
4. **(branch)** Any `administrator_session` row of `$id`, of either kind, live or expired: refuse.
5. **(branch)** Any `administrator_recovery_code` row of `$id`: refuse.
6. **(branch)** Read the factor row. Unless `state = 'pending_confirmation' AND factor_id = $g AND origin_recovery_session_id IS NULL`: refuse.
7. Verify the code against `$g`'s material at `$now`, giving `$step`. A mismatch is refused.
8. **(required)** `UPDATE … SET state = 'active', last_accepted_step = $step WHERE administrator_id = $id AND factor_id = $g AND state = 'pending_confirmation' AND origin_recovery_session_id IS NULL`.
9. **(required, 10)** Insert ten digests.
10. *(cleanup)* Invalidate the pending challenges.

Every refusal writes nothing.

**Why reads under the administrator lock are enough:**
- Sessions are inserted only under the administrator lock. Logout only deletes them.
- Codes are written only under that lock.

**The no-session and no-code checks are safety (RA-6), not authorization.** Authorization is the
origin predicate. After last-code use, a recovery start and a logout, no session row and no code
row remain, but the factor's origin is non-null, so this operation refuses.

### RA-6. Activation safety (FA), per path

After any recovery-code use, a factor becomes `active` only through one of these paths:

| Rule | Path | What must hold | Source of fresh codes |
|---|---|---|---|
| **FA-R** | Recovery completion (RA-4) | The presenting recovery session was live, the same administrator's and the factor's origin. It is deleted **(required, 1)**. The code is verified under the lock | The activation commit **(required, 10)** |
| **FA-P** | Initial provisioning confirmation (RA-5) | No session row, no code row, a `NULL` origin, and the code verified under the lock | The activation commit **(required, 10)** |
| **FA-O** | Operator-reset confirmation (future, `ADR-028` *TOTP confirmation*) | The factor is the one an *Operator reset* commit wrote. That commit deleted every session, replaced the code set with 10 and invalidated challenges. The factor is still `pending_confirmation` under that `factor_id`, with a `NULL` origin. A code use after the reset discards it (RA-1), so no recovery-code use can intervene before a successful activation | **The earlier reset commit** |

**Enforcement status. This is not a claim about the whole storage layer:**
- **FA-R and FA-P are enforced by storage** for the operations this ADR defines.
- **FA-O is a conformance requirement** on the future operator-reset unit.
- **The existing `confirmTotpEnrolment` stays a caller-restricted path.** RA-3 makes storage refuse it for a factor with a recovery origin. For a factor with a `NULL` origin, it still activates with no fresh codes, no session check and no code verification. Only its single caller prevents misuse: the provisioning command, confirming a factor it created in the same run for a new account.

### RA-7. Caller restrictions retained

- **The provisioning form of *Re-enrolment start* (`startTotpEnrolment`)** is used only for an administrator created in the same provisioning run. Its upsert would keep a stale origin (RA-3), and it leaves recovery sessions alive.
- **`confirmTotpEnrolment`** is used only by the provisioning command, for the factor that run created. Once the provisioning command moves to RA-5 (a later, separately authorized recovery-journey unit), it is the designed *TOTP confirmation* for the future operator reset only (FA-O).
- **These are caller restrictions, not storage guarantees.** A later authorized unit retires or guards both functions.

### RA-8. Completion, abandonment, retry and state O

| Situation | Behaviour |
|---|---|
| **Completion** | RA-4. The next session needs password plus the **new** TOTP |
| **Abandoned before start** | The factor is `reenrolment_required`. Password plus TOTP on an otherwise eligible live challenge is refused `FACTOR_UNAVAILABLE`, uncounted; earlier classifications keep their precedence. Password plus a remaining code opens a new recovery session |
| **Abandoned after start** | The pending factor stays stored, with its origin naming the ended session, so no session can complete it. The next code success discards it (RA-1), and so would the operator reset |
| **Retry within one Q** | Start may repeat, and each start replaces the factor (a new `factor_id`, the same origin). A completion naming an earlier `factor_id` is refused with nothing written. A wrong completion code is refused, uncounted |
| **Last code consumed** | It succeeds and opens Q with 0 codes. Regeneration or completion through Q restores a route. State O-1 begins only if Q ends without either |
| **Ceiling with a live Q** | Q survives. Regeneration or completion restores codes, but the counter stays at 100 or more, so the next wrong code (after the wait) deletes them again |
| **State O, account enabled** | `ADR-004` P-6 (2): the **operator reset**, which is not built |
| **Account disabled** | The **separately deferred re-enablement procedure** (D-12). The operator reset alone does not restore it (D-16). Neither is built |

### RA-9. Classification and counters

- **Classification is unchanged:** the PS-4 order and D-15 apply.
- **`FACTOR_UNAVAILABLE` stays uncounted** and returns the generic response.
- **The counters are unchanged.** Only a successful code use or the operator reset clears the `recovery_code` counter. **Disclosed consequence:** after the ceiling, codes regenerated or issued at completion are deleted by the next wrong code once the wait passes.

### RA-10. Form of the record: whole supersession by reference

1. **The text is pinned.** The carried-forward text is `ADR-028` exactly as accepted: blob `3af7733a473761ba3e7977ffa9c5c0f33f5ea791` at `docs/adr/ADR-028-administrator-authentication-storage-design.md`, from commit `2ea949b` (PR #257), unchanged through `f7f77d6`. On acceptance, only `ADR-028`'s *Status* and *Superseded by* fields change, as `docs/adr/README.md` prescribes.
2. **Authority and text.**
   - Every provision not listed under *Affected provisions* is re-adopted word for word: its authority comes from `ADR-029`'s acceptance, and its text from the pinned `ADR-028`.
   - Listed provisions change only as stated.
3. **Identifiers.**
   - `PS-1` to `PS-9`, `PS-8a`, `PS-8b`, `D-1` to `D-17` and both ruling records keep their names. `ADR-029` adds `RA-1` to `RA-10`.
   - Citations of unchanged provisions stay valid. Changed provisions are cited as "`ADR-028` PS-8 as amended by `ADR-029` RA-4".
   - The 23 source and test files citing `ADR-028` need no edit.
4. **Traceability.**
   - `ADR-028`'s traceability is re-adopted unchanged, and `ADR-029` adds its own rows.
   - The `docs/adr/README.md` register and the `docs/traceability-matrix.md` `FR-AUTH` row name both ADRs.
   - The `ADR-028` history (#256, #257) stays in its file and register row.

## Affected provisions

| `ADR-028` provision | Under `ADR-029` |
|---|---|
| *Decision*, PS-1, PS-2, PS-4, PS-5, PS-6, PS-7, PS-9 | Carried forward unchanged |
| **PS-3** | **Extended:** one column and `administrator_totp_factor_origin_check` (RA-3); `reenrolment_required` is also written by RA-1 |
| **PS-8, *Recovery code to restricted session*** | **Amended:** adds the RA-1 *(cleanup)* `UPDATE` |
| **PS-8, *Re-enrolment start*** | **Amended:** the recovery-session form writes the origin (RA-4). The provisioning form is restricted to callers (RA-7) |
| **PS-8, *Re-enrolment completion*** | **Amended:** the origin predicate and origin clearing (RA-4) |
| **PS-8, *TOTP confirmation*** | **Extended:** refused in storage for a factor with an origin, by the `CHECK` (RA-3). FA-O for the operator reset (RA-6) |
| **PS-8, new row *Initial provisioning confirmation*** | **Added** (RA-5) |
| PS-8, every other row | Carried forward unchanged |
| **PS-8a** | **Extended:** a code success, then TOTP on another challenge (`invalidated`); a code success, then TOTP on a later challenge (`FACTOR_UNAVAILABLE`); a TOTP session issued, then a code success (session deleted, factor discarded); a recovery start, a logout, then provisioning confirmation (refused on origin) |
| **PS-8b** | **Extended:** RA-1 is *(cleanup)*. RA-4 completion and RA-5 keep their required counts of 1, 1 and 10, and of 1 and 10 |
| ***Consequences*, *Migration sequencing*** | **Amended:** `004` also adds the origin column and its `CHECK` |
| D-1 to D-17, the ruling records, *Alternatives*, *Open questions*, *Traceability* | Carried forward unchanged |

## Schema

Migration `004` (its exact DDL is specified in the implementation Scope Gate, still pending):
- creates `administrator_recovery_code` as PS-6 defines it;
- adds `origin_recovery_session_id uuid` and `administrator_totp_factor_origin_check` to `administrator_totp_factor`. Migration `003` is not edited, and existing rows are `NULL`.

**The `down`:**
- drops the `CHECK`, the column and the table;
- **destroys any codes and origins**, which is permitted, as for `003`, only while synthetic local data alone can exist (`ADR-018`).

## Race outcomes, in both serialization orders

**Notation:**
- X is the administrator, with an `active` factor F (at step s) and 10 codes;
- R is a recovery-code success on challenge A;
- T is a TOTP completion on challenge B;
- Q is an existing recovery session.

| Race | First order | Second order | Holds in both |
|---|---|---|---|
| R vs T | **T first:** session S is issued. **Then R:** S is deleted, F is discarded and the recovery session is issued | **R first:** F is discarded and B is invalidated. **Then T:** refused `invalidated`, uncounted | One session, the recovery session; F `reenrolment_required`; 9 codes; nothing counted |
| R vs start in Q | **Start first:** g is written with origin Q. **Then R:** Q is deleted, g is discarded (origin `NULL`), and Q2 is issued | **R first:** Q is gone. **Then start:** authorization finds 0 rows and rolls back | Q2 live; the factor `reenrolment_required`; no origin |
| R vs completion in Q | **Completion first:** g is active, 10 codes, Q is deleted, and A is invalidated. **Then R:** refused | **R first:** g is discarded and Q is deleted. **Then completion:** authorization finds 0 rows and rolls back | Never both an active factor and a live recovery session |
| R vs regeneration in Q | **Regeneration first:** A is invalidated. **Then R:** refused | **R first:** Q is deleted. **Then regeneration:** rolls back | Exactly one takes effect |
| R vs the 100th TOTP failure | **Failure first:** F is discarded and A is invalidated. **Then R:** refused | **R first:** F is discarded and B is invalidated. **Then the failure:** refused, and the ceiling is not reached | F `reenrolment_required` |
| Completion vs logout of Q | **Completion first** (it holds Q's row lock, so logout waits): logout then deletes 0 rows | **Logout first:** completion's authorization finds 0 rows and rolls back | No partial activation |
| Start vs logout of Q | **Start first:** g has origin Q. **Then logout:** g cannot be completed by any session | **Logout first:** start rolls back | No pending factor completable by another session |
| Provisioning confirmation after a start and a logout | — | — | Refused on origin; nothing written |

## Implementation feasibility

**No existing source line changes.** RA-1 to RA-5 are new operations and new private helpers.

**One existing behaviour changes, intentionally and by schema alone:**
- `confirmTotpEnrolment` now fails with `23514` and rolls back when it names a factor with a recovery origin.
- Every other existing function writes only rows that satisfy the new `CHECK`:
  - the TOTP ceiling and the step advance touch only `active` rows, whose origin is `NULL`;
  - `startTotpEnrolment` writes `pending_confirmation`, which is always allowed.

**Existing tests select explicit factor columns.** Only the migration column-set and constraint-set
assertions become false, and those are allowlisted.

## Operator recovery is not implemented, and `demo:local:reset` is not recovery

The `ADR-004` P-6 operator reset (`ADR-028` PS-8) keeps the administrator identity (`AA-4`), every
other account and all directory data. **It does not exist** ("the command does not exist yet").

`demo:local:reset`, once the cluster is stopped and port 54329 is free, **deletes the whole
`.local-demo/` directory**:
- every administrator;
- all listing data;
- the cluster credentials;
- the development keys;
- the certificate.

The next start recreates everything, and every administrator must be provisioned again. **It
recovers no account.** `ADR-028` D-11 permits it only because synthetic local data is not product
data.

**Until the operator reset is built, an enabled account in state O cannot be recovered. A disabled
account cannot be restored until the deferred re-enablement procedure is also designed, authorized
and built.**

## Alternatives considered

| Alternative | Why it is not adopted |
|---|---|
| Reading B, with a clarification | The old factor keeps issuing full sessions after a code use |
| Delete the remaining codes on success | Every abandoned recovery becomes state O-1 |
| **Caller restriction instead of origin provenance** | Storage could not tell provisioning confirmation from recovery completion. After a logout, anyone able to call the confirmation could complete a recovery-started factor |
| Inferring the origin from other tables | Misuses D-15 enforcement state, and those rows can be removed |
| Clearing the counter at regeneration or completion | Not adopted in this ADR; the counter behaviour is carried forward unchanged (RA-9) |

## Consequences

**Positive:**
- A used code always forces re-enrolment before any administrator session.
- Storage distinguishes recovery completion from provisioning confirmation, binds completion to the session that started the factor, and refuses the existing confirmation for recovery-origin factors.

**Negative:**
- One schema change to a `003` table.
- **An intentional behaviour change to an existing function** whose source is not edited.
- State O becomes reachable through legitimate use, and its only remedy is the unbuilt operator reset.
- The post-ceiling counter consequence (RA-9).
- Two caller-restricted existing functions remain (RA-7).

**Reversibility:** **high while only synthetic data exists.**

## Assumptions

| Assumption | If it is wrong |
|---|---|
| Sessions are inserted only under the administrator lock | RA-5's no-session read needs a lock |
| At most one recovery session exists per administrator at a time | The RA-4 origin predicate still binds completion. Only the reachability note changes |
| Callers respect RA-7 | The remaining caller-restricted gaps open |

## Risks

| Risk | Response |
|---|---|
| State O with no built remedy | Accepted for synthetic local use only, at acceptance. The operator reset, and for disabled accounts the deferred re-enablement procedure, stay prerequisites before public reachability |
| A stale origin left by `startTotpEnrolment` | Caller-restricted (RA-7). No caller does this |
| A future factor writer forgets the origin | Its `UPDATE` fails the `CHECK`, so it fails closed. Future conformance |

## Open questions this decision must NOT answer

The same as `ADR-028`: `OQ-14` + `NOQ-8`, `NOQ-7`, `OQ-9`, `NOQ-5`, `NOQ-6`, #246 / `BI-4`,
`DG-3`, `DG-4`, the `ADR-004` parameters and R-1 to R-4. The origin column is current state, not
an audit record. **`DG-3` remains `Unresolved`.**

## Traceability

| | |
|---|---|
| **Requirements** | Carried forward from `ADR-028` |
| **Invariants** | `BI-5`, `BI-9`, `AA-1`–`AA-5`; must not breach `BI-4` or `BI-6` |
| **Components** | `C8`, `C9`, `C12` |
| **Decisions relied on** | `ADR-004` P-1, P-4 (RQ-1), P-5 (RQ-2), P-6; `ADR-028` at blob `3af7733a`; `ADR-018`; `ADR-022` |
| **Documents amended on acceptance** | `docs/adr/README.md` (register); `ADR-028` *Status* and *Superseded by* only; `docs/13` (RQ-1, RQ-2, acceptance); `docs/traceability-matrix.md` (`FR-AUTH`) |
| **Issue / pull request** | Issue #262 (this proposal); acceptance is a separate step |
