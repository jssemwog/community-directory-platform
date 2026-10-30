# `ADR-004` — Authenticate administrators with an app-owned password and a mandatory TOTP second factor over server-side sessions, with explicitly provisioned accounts and no public registration

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-30 (issue #252). **In force.** Published as `Proposed` 2026-10-30; see *Status and chronology* |
| **Date** | 2026-10-30 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-30, twice** (issue #252): first the **direction** (*Approved direction*), then the **consolidated choices and the lockout and sole-maintainer recovery risk** (*Second ruling*); acceptance authorized the same day after two wording corrections |
| **Decision gate** | **`DG-3`** — `NOQ-9` (`DD-4`). **`DG-3` remains `Unresolved`:** `OQ-9` (anti-spam) and `OQ-14` + `NOQ-8` (audit logging) are undecided, and this ADR answers neither |
| **Related open questions** | **Depends on:** `NOQ-9`, **decided 2026-10-30**: the direction and then the parameters in this ADR were approved. **Must NOT answer:** `OQ-9`, `OQ-14`/`NOQ-8`, `NOQ-7`, `NOQ-5`, `NOQ-6`, `BI-4` timing (#246), the `DG-4` release decision — see *Open questions this decision must NOT answer* |
| **Supersedes** | *none* — `ADR-001`'s administrative boundary (`C8`, server-side, every request) is **not** amended; this ADR supplies the mechanism `ADR-001` deferred |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-30 (issue #252). In force; later work may rely on it.**
> **It authorizes no implementation**: no dependency, migration, schema, route, command, cookie,
> session store or test is created by this document or by its acceptance. Implementation is
> separate issue-linked work. **`DG-3` remains `Unresolved`.**

---

## Status and chronology

All on 2026-10-30, issue #252:

1. The Product Owner ruled the **direction** (*Approved direction*), recorded on issue #252.
2. This ADR was drafted as **`Proposed`**, with its parameters as recommendations.
3. The Product Owner **approved the consolidated choices** and **accepted the lockout and
   sole-maintainer recovery risk** (*Second ruling*).
4. The Product Owner **authorized acceptance** after two wording corrections: the existing TOTP
   encryption key is not a prerequisite for recovery (consistent with P-6), and statements of
   immediate revocation are qualified by P-1's semantics. Both were applied, and the status became
   **`Accepted`**.

Acceptance resolves `NOQ-9` only. **`DG-3` remains `Unresolved`**: `OQ-9` and `OQ-14` + `NOQ-8`
are undecided.

---

## Context

`ADR-001` settled the **boundary**: `C8` authenticates administrators and authorizes every
administrative action, server-side, on every request, and a denial reveals nothing. It deferred
the **mechanism** to `DD-4` and its strength to `NOQ-9` (`NFR-SEC-07`). `P4` cannot begin without
it, and `/admin` is today an empty, unprotected shell (`README.md`).

**Forces.**

- **Requirements.** `NFR-SEC-01`/`02` (gated functions; denial reveals nothing), `NFR-SEC-04`
  (protection in transit), `NFR-SEC-07` (a *defined* minimum credential and session strength for
  "a small trusted operator team"), `NFR-SEC-08` and `NFR-OBS-02` (credentials never stored
  readable, never logged), `NFR-OBS-01` (denied access logged), `FR-AUTH-01`–`04` (no role beyond
  visitor, lister and administrator; no self-service accounts), `docs/09` `AA-1`–`AA-5` (including
  **attribution to exactly one identity**, `AA-4`), `docs/11` `BI-5`, `BI-9` and "not whether an
  identity was recognised".
- **Operation.** One primary maintainer and a handful of trusted administrators (`docs/07` `D-6`,
  `A-2`). Render runs **one stateless long-running instance** (`ADR-005`), so no session or
  throttle state may live in process memory. Secrets stay server-side (`ADR-005` `O-5`).
- **Product Owner constraints (2026-10-30).** No recurring authentication-service fee; no paid
  plan, mandatory add-on or expiring trial. A bounded comparison found no managed service whose
  free tier both enforces MFA and suits this deployment (issue #252 discussion).

---

## Approved direction (ruled 2026-10-30, issue #252)

These points are the Product Owner's ruling, not proposals:

1. **App-owned administrator authentication:** a **password** plus a **mandatory TOTP** second
   factor, for the MVP.
2. **No recurring authentication-service fee.**
3. **Maintained libraries or established platform implementations** for password hashing, TOTP
   and cryptography. **No authentication primitive is invented** in this repository.
4. **Accounts are explicitly provisioned. There is no public registration.**
5. **Single-use recovery codes**, a **documented sole-maintainer recovery procedure**,
   **server-side sessions**, **logout**, **revocation** and **abuse controls** are required.
6. **No formal NIST AAL2 compliance claim** is made.
7. **A security review is required before any administrative capability becomes publicly
   reachable.**

## Second ruling (2026-10-30, issue #252)

The Product Owner, the same day:

1. **Approved the consolidated choices** in *Approved choices* below, as written, including the
   values in P-1 to P-7.
2. **Accepted, for the MVP, the documented lockout and sole-maintainer recovery risk:** an attacker
   who knows an administrator username may obstruct sign-in and eventually require
   operator-assisted recovery, and recovery depends on retained server and database access.

Neither ruling resolves `DG-3` or authorizes implementation or provisioning. Acceptance followed separately (*Status and chronology*).

---

## Approved parameters (ruled 2026-10-30)

Each item was proposed with its basis below and is now approved by the second ruling. Sources were read on 2026-10-30; anything not
confirmed from a primary source is marked **unverified**.

**Standards status.** The **binding** requirements are this repository's (`NFR-SEC-*`,
`NFR-OBS-*`, `FR-AUTH-*`, `docs/09` `AA-*`, `docs/11` `BI-5`/`BI-9`) and the 2026-10-30 ruling.
NIST SP 800-63B-4, NIST SP 800-38D, RFC 6238 and the OWASP cheat sheets are **design references**:
their *SHALL*/*SHOULD* wording is quoted as the basis for a proposal, **not** adopted as a project
requirement. **No conformance with any of them is claimed** (ruling 6), and a departure from one,
such as the password-hashing choice in P-2, is recorded rather than hidden.

### P-1. Sessions

| Item | Approved choice | Basis and tradeoff |
|---|---|---|
| Storage | A **server-side session record** in PostgreSQL; the browser holds only an opaque token | Required by the ruling. Next.js's authentication guide describes database sessions as "more secure" though more complex. Revocation then refuses every **subsequent** session check, while work already past its check may finish (P-1 semantics): delete the record |
| Token | **32 random bytes** from `crypto.randomBytes`, base64url; **only a SHA-256 digest of it is stored** | NIST SP 800-63B-4 §5.1 requires session secrets of at least 64 bits; OWASP asks 128 bits for self-built identifiers. Storing a digest means a database read does not yield a usable cookie |
| Cookie | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain` | NIST §5.1.1 (HTTPS-only, HttpOnly, `__Host-`, `Path=/`, Lax or Strict); OWASP prefers `Strict`. Administrators arrive by typing or bookmarking, so `Strict` costs little. **Unverified:** browser acceptance of a `Secure`/`__Host-` cookie over `http://127.0.0.1` in local development; the implementing unit must check, and must not weaken production attributes to suit development |
| Idle timeout | **30 minutes** | Within NIST's AAL2 *SHOULD* (no more than 1 hour) without claiming AAL2; the top of OWASP's 15–30 minute range for lower-risk applications. Moderation is done in short sittings. Stricter alternative: 15 minutes |
| Absolute lifetime | **12 hours** | Within NIST's AAL2 *SHOULD* (no more than 24 hours); one working day. Alternative: 8 hours (OWASP's office-worker example is 4–8 hours) |
| Enforcement | Both timeouts **checked on the server** on every request; cookie expiry is not relied on | NIST §5.1.1: cookie expiry "SHALL NOT be relied upon to enforce session timeouts" |
| Rotation | A **new** session at full sign-in; the password-only step holds a separate **pending-challenge** record (5 minutes) that grants nothing. The challenge is consumed atomically (P-7), so one challenge yields at most one session | OWASP: renew the identifier after any privilege change. A password alone never reaches any administrative state |
| Recovery session | Password **plus** an unused recovery code yields a **restricted recovery session** (15 minutes, not extendable). It permits **only** TOTP re-enrolment, recovery-code regeneration and logout; `C8` treats it as **not** an administrator session, so every administrative operation refuses it. Completing re-enrolment ends it and requires a fresh full sign-in with the new factor | Keeps a recovery code from substituting for TOTP in normal administration, and proves the new factor works before any administrative access |
| Logout | Deletes the server record and clears the cookie | NIST §5.1: secrets invalidated at logout; OWASP: invalidate server-side |
| Revocation | Commands to revoke **one** or **all** sessions of an administrator; disabling an account revokes all its sessions, pending challenges and recovery sessions. Semantics below | Required by the ruling |

**Revocation and disablement semantics.** Revoking a session or disabling an account commits in
one database transaction that removes or invalidates the affected session records. **Every
session check that begins after that commit refuses the request.** The design does **not**
cancel work already in progress: a request whose session check completed before the commit may
finish, including a render or an administrative operation already past its check. Each
state-changing administrative operation re-checks the session and the account's enabled state
inside its own database transaction, which narrows that window; **the ADR does not guarantee an
ordering** between that re-check and a concurrently committing revocation, and any such write
remains attributed to the revoked administrator. Tighter serialization, if wanted, is a separate
decision.

**Where the check runs.** Next.js 16 states that Proxy "should not be your only line of defense"
and that a page-level check "does not extend to the Server Actions defined within it". The
session must therefore be verified **in the server-side data-access path of every administrative
operation**, Server Action and Route Handler (`AA-5`, `BI-9`); Proxy and layouts may add only
optimistic redirects.

**Cross-site requests.** Server Actions compare `Origin` with `Host`, but Next.js documents that
"a request that carries no `Origin` header at all is allowed through with a warning". The design
adds an explicit check on every state-changing administrative request: reject a missing or
mismatched `Origin`, or a `Sec-Fetch-Site` of `cross-site`, with `SameSite=Strict` as defence in
depth. This follows OWASP's CSRF guidance that SameSite alone "does not replace a proper CSRF
defense".

### P-2. Passwords

| Item | Approved choice | Basis and tradeoff |
|---|---|---|
| Algorithm | **`scrypt` from Node's built-in `node:crypto`**, with OWASP's first listed scrypt configuration, **N = 2^17, r = 8, p = 1**, a **16-byte random salt**, and `maxmem` set explicitly above Node's 32 MiB default (Node errors when about `128 × N × r` exceeds `maxmem`; here about 128 MiB). **Resource budget:** about 128 MiB per computation, at most two at once (P-7), an **approximate peak password-hashing work budget of about 256 MiB**, not the application's total memory | An established platform implementation available on the repository's Node `>=22.12.0`, with no native dependency. **No incompatibility was found.** OWASP lists scrypt as the choice "if Argon2id is not available", and Node 22 has no Argon2 (`crypto.argon2` arrived in v24.7.0). **Recorded departure:** NIST SP 800-63B-4 §3.1.1.2 says a scheme from SP 800-132 (PBKDF2) "SHOULD be used"; this ADR does not follow that recommendation and claims no NIST conformance |
| Not chosen | **Argon2id** via `@node-rs/argon2` (MIT; 2.2.2 per the npm registry; prebuilt, no node-gyp): OWASP's first choice, but a native dependency for a modest gain over scrypt. Revisit with `crypto.argon2` after a move to Node 24. **PBKDF2** via `node:crypto`: follows NIST's *SHOULD*, but OWASP ranks it below scrypt and its parameters were not verified here | The stored hash is self-describing, so a later change of algorithm needs only rehash on the next successful sign-in |
| Encoding | A self-describing stored hash (algorithm, parameters, salt), so parameters can be raised with **rehash on next successful sign-in** | Allows a later move to `crypto.argon2` (Node 24) without forcing resets |
| Policy | **Minimum 15 characters**, a maximum of 128 (NIST suggests at least 64), each code point counted once, **NFC normalisation**, **no composition rules**, paste and password managers allowed, **no periodic expiry**, and a **blocklist** of common or compromised passwords | NIST §3.1.1.2. Fifteen is NIST's single-factor minimum; eight would suffice with MFA, but these are hand-provisioned privileged accounts. **The blocklist source is not chosen:** it must work offline (no external service at sign-in) and be of "sufficient size"; selecting a maintained list is an open item |
| Concurrency | Every password verification, including the **dummy verification for an unknown account**, runs through **one process-wide limit on concurrent hash computations** with a bounded wait queue. See P-7 | Each scrypt computation needs about 128 MiB, so unbounded concurrency could exhaust memory. A low administrator count bounds legitimate use, **not attacker traffic** |

### P-3. TOTP

| Item | Approved choice | Basis and tradeoff |
|---|---|---|
| Library | **`otpauth`** (MIT; latest 9.5.2 per the npm registry; one runtime dependency, `@noble/hashes`) | Implements RFC 4226 and RFC 6238; `validate({ token, window })` **returns the matched time-step delta**, which replay prevention needs. Alternative: **`otplib` v13** (MIT; "a complete rewrite"; its README does not document a returned delta) |
| Algorithm | SHA-1, 6 digits, 30-second step | RFC 6238 defaults, supported by common authenticator apps; `otpauth` advises keeping its defaults. Node's caution on SHA-1 concerns collision resistance in signatures, not HMAC |
| Window | **One step either side** | RFC 6238 recommends "at most one time step" for network delay |
| Replay | Store the **last accepted time step** per administrator. A code is accepted only by a **single conditional update** that advances that step; of two concurrent requests carrying the same or an older code, **at most one is accepted** (P-7) | NIST: "accept a given OTP only once"; RFC 6238 §5.2 |
| Secret | **20 random bytes** (160 bits) | NIST: at least 112 bits; `otpauth`: no fewer than 128 bits |
| Secret at rest | **AES-256-GCM** via `node:crypto`: a fresh **96-bit IV from `crypto.randomBytes`** per encryption, a **128-bit tag**, and the administrator's identifier and a key version as associated data. The 32-byte key is held **only** in server environment configuration, never in the database | **Verified** in NIST SP 800-38D: §5.2.1.1 recommends restricting IVs to 96 bits; §8.2.2 requires a random field of at least 96 bits from an approved RBG; §8.3 limits a key to 2^32 encryptions when IVs are random, which is far above this use (one encryption per enrolment); §5.2.1.2 permits 128-bit tags. NIST announced in March 2024 that SP 800-38D will be revised; no draft was checked. NIST 800-63B-4 requires OTP keys to be "strongly protected … by access controls". Backups hold only ciphertext (`NFR-BACK-04`). **Loss or compromise of the key** is handled by the replacement procedure in P-6, which does not need the lost key |
| Enrolment | Shown **once** at provisioning as an `otpauth://` URI and base32 secret, and confirmed by one valid code before it takes effect | No QR-code library is proposed; one could be added later |

### P-4. Recovery codes

| Item | Approved choice | Basis and tradeoff |
|---|---|---|
| Issue | **10 codes**, each **128 random bits**, shown once at enrolment and on regeneration | Single use is required (NIST §3.1.2.2). At 128 bits, above NIST's 112-bit threshold, NIST permits an approved hash function rather than a slow password hash |
| Storage | A **SHA-256** digest of each code; a used code is deleted | NIST 800-63B-4 §3.1.2.2: look-up secrets "stored in a hashed form using an approved hashing function"; below 112 bits a salted password-hashing scheme is required instead, which 128-bit codes avoid. **SHA-256 as an approved function, verified:** the SP 800-63B-4 glossary defines approved cryptography as "FIPS-approved or NIST-recommended"; NIST's Hash Functions project states that "Approved hash algorithms … are specified in" FIPS 180-4 and FIPS 202, and that FIPS 180-4 specifies SHA-256. **Remaining caveats:** the same project page also says "Currently only the four fixed-length SHA-3 algorithms are approved hash algorithms", read here as limited to FIPS 202's SHA-3 family, since the page lists FIPS 180-4 as a source of approved algorithms; NIST decided in 2023 to revise FIPS 180-4. **Tradeoff:** long codes are tedious to type |
| Use | Accepted **only after a correct password** in the same pending challenge; it never substitutes for the password. It is consumed by a **single conditional delete** of its digest, so of two concurrent attempts with the same code **at most one succeeds** (P-7). Success yields the **restricted recovery session** (P-1), **revokes the administrator's other sessions**, and requires TOTP re-enrolment and fresh codes before any administrative access | Treats the use of a recovery code as a suspected loss of the device |

### P-5. Abuse controls

| Item | Approved choice | Basis and tradeoff |
|---|---|---|
| Per authenticator | **Separate consecutive-failure counters** for the **password** (keyed by the normalised submitted username, whether or not the account exists, so known and unknown names are throttled alike), the **TOTP** factor and the **recovery codes**. From the **5th** consecutive failure of a counter, that step requires a **wait that doubles from 30 seconds up to 1 hour**; a success resets that counter. Counters are updated atomically (P-7) | NIST §3.2.2 counts failures "using a specific authenticator" and allows increasing waits ("e.g., 30 seconds up to an hour") |
| Lockout tradeoff | **Corrected:** the waits do obstruct the real administrator. Anyone who knows or guesses a username can keep its password step in 1-hour waits indefinitely, and the wait applies to the administrator too. This is **lockout by delay**, not merely slower guessing. Usernames are therefore treated as non-public, and the per-source limit slows a single source; **neither stops a distributed attacker** | OWASP warns that lockout "can be used to cause a denial of service". The doubling wait trades availability for guessing resistance; the 1-hour cap bounds each wait, not the total obstruction |
| Ceiling | At **100** consecutive failures of **one** counter, **that authenticator alone is disabled**. **Password disabled:** no sign-in route remains, because recovery codes are accepted only after a correct password; recovery is the **operator procedure** (P-6). **TOTP disabled:** the **password plus recovery-code** route remains, leading to the restricted recovery session and TOTP re-enrolment. **Recovery codes disabled:** the normal password-plus-TOTP route remains, and new codes are issued through re-enrolment or the operator procedure | NIST's upper bound: "no more than 100 by disabling that authenticator". With the doubling wait, reaching 100 takes **roughly four days** of continuous attempts: an estimate that depends on the throttling values and the attacker's pacing, **not a guarantee**. TOTP and recovery-code failures occur only **after a correct password**, so they also indicate a compromised password and are logged prominently |
| Per source | **20 failed attempts per hour** per keyed hash of the client address, stored in PostgreSQL | Slows password spraying across accounts; the instance is stateless (`ADR-005`). **Unverified:** how Render's proxy reports the client address; the implementing unit must establish which header can be trusted |
| Responses | One generic failure message for an unknown account, a wrong password, a wrong code, a throttled step and a disabled authenticator. An unknown account receives a **dummy verification** with the same algorithm and parameters, through the same concurrency limit (P-7) | OWASP Authentication; `docs/11` ("not whether an identity was recognised"). **No timing threshold is set or claimed**; see *Open questions* |
| Logging | Failures, waits, disables and recovery-code use go to the operational log **without credentials, codes or secrets** | `NFR-OBS-01`/`02`, `NFR-SEC-08`. Whether any of these is an *audit* event is `OQ-14`/`NOQ-8` and is not decided here |

### P-6. Provisioning and sole-maintainer recovery

| Item | Approved choice | Basis and tradeoff |
|---|---|---|
| Provisioning | A **repository-owned command**, run explicitly by an operator with server and database access, never imported by the application server or run on the request path. It creates an administrator, sets the password from a non-echoed prompt, enrols TOTP, issues recovery codes, disables an account, resets a password or TOTP, and revokes sessions | Mirrors `ADR-018`'s explicit-invocation posture. No route can create an administrator (`FR-AUTH-04`) |
| Identity | An application-generated identifier per administrator, never reused. Accounts are **disabled, not deleted**, so attribution (`AA-4`) stays resolvable while the identifier is retained | Disabling instead of deleting **does not decide that identifiers are kept indefinitely.** How long an administrator identifier, and any record referring to it, is retained is an audit-lifecycle question (`OQ-14` + `NOQ-8`) and is **not decided here** |
| Recovery procedure | An operator runbook: **(1)** password plus a recovery code, leading to the restricted recovery session (P-1); **(2)** otherwise the operator, with server and database access, runs the command to reset the password and TOTP, which revokes all sessions and issues new recovery codes; **(3)** the event is recorded in the operational log | Required by the ruling. For a sole maintainer this command **is** the break-glass path. **The design is approved; the command does not exist yet** |
| Key replacement | When the TOTP encryption key is **lost** or **suspected compromised**, a deliberate operator procedure that **never needs the old key**: **(1)** generate a new key with a new version and deploy it; **(2)** run a command that, in one transaction per administrator, marks every TOTP factor not readable under an available key as **requiring re-enrolment**, discards its ciphertext, and revokes that administrator's sessions, pending challenges and recovery sessions; **(3)** each administrator signs in with password plus a recovery code and re-enrols, or the operator re-enrols them with the provisioning command. On **suspected compromise**, step (2) applies to **every** factor, even those still readable, and recovery codes are regenerated at re-enrolment. **Routine rotation** with the old key available may instead re-encrypt under the new key | Password hashes and recovery-code digests do not depend on the key, so the recovery-code route survives key loss. A compromised key must be treated as exposing every TOTP secret |
| Residual dependency | Recovery depends on the maintainer keeping access to Render and the database provider, which have their own sign-in and recovery | Outside this ADR. Recommended practice: keep recovery codes offline and apart from the authenticator device |

### P-7. Atomic outcomes and bounded work

**Required outcomes under concurrency.** Each is a single conditional statement, or a transaction
that locks the administrator's row, in PostgreSQL. The implementing unit must prove each one with
concurrent duplicate requests. No isolation level beyond this is decided here; `ADR-024`–`ADR-027`
govern listing writes and are not extended.

| Operation | Outcome that must hold |
|---|---|
| TOTP acceptance | Accepted only if the conditional update advances the last accepted time step. Concurrent submissions of one code: **at most one succeeds**; the rest fail as replays and count as failures |
| Recovery-code consumption | Consumed only by a conditional delete of the matching unused digest. Concurrent use of one code: **at most one succeeds** |
| Pending challenge to session | The challenge is consumed by a conditional delete when the session is created: **at most one session per challenge** |
| Failure counters and waits | Increment, read and wait computation happen in **one atomic update**, so concurrent failures are never lost; a success resets only the counter it belongs to. Concurrent success and failure on one counter apply in the database's serialized order; no other ordering is promised |
| Session issue after revocation | A session created by a challenge consumed after the account was disabled must not be usable: the session check verifies the account's enabled state |

**Bounded password-hashing work and overload** (approved values; to be confirmed locally under L-4 and against the
production instance under R-1):

- **Concurrency limit:** at most **2** concurrent password-hash computations per process (an
  approximate hashing-work budget of about 256 MiB, not total application memory), whether real or dummy.
- **Wait queue:** at most **8** waiting verifications, each waiting at most **5 seconds**.
- **Overload:** a request that finds the queue full or times out receives a **generic "try again
  later" response** (HTTP 503 with `Retry-After`). It is the same for known and unknown accounts,
  does **not** count as an authentication failure, and is logged.
- **Order of checks:** the per-source limit and the per-authenticator wait are checked **before**
  a hash slot is requested, so throttled requests cost no hashing work.
- **Rationale:** the limit protects memory and availability against attacker traffic; the number
  of administrators bounds only legitimate use. A flood can still deny sign-in by filling the
  queue; that residual risk is stated, not solved.

---

## Approved choices (ruled 2026-10-30)

| Area | Approved choice |
|---|---|
| Sessions | Server-side; 256-bit token stored as a SHA-256 digest; `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`; **30 minutes idle, 12 hours absolute**; pending challenge 5 minutes; restricted recovery session 15 minutes |
| Request checks | Session verified in every administrative operation, Server Action and Route Handler; explicit `Origin` / `Sec-Fetch-Site` check on state-changing requests |
| Password hashing | **scrypt** (`node:crypto`), N = 2^17, r = 8, p = 1, 16-byte salt, `maxmem` set explicitly; an approximate hashing-work budget of about 256 MiB at two concurrent computations, not total application memory |
| Password policy | 15–128 characters, NFC, offline blocklist, no composition rules, no periodic expiry |
| TOTP | `otpauth`; SHA-1, 6 digits, 30-second step, one step either side; atomic replay prevention; 160-bit secret under AES-256-GCM (96-bit random IV, 128-bit tag) with a server-held key |
| Recovery codes | 10 codes of 128 bits, stored as SHA-256 digests; accepted only after the password; atomic single use; leads to the restricted recovery session |
| Abuse controls | Per-authenticator counters (password keyed by submitted username); waits from the 5th failure, doubling 30 seconds to 1 hour; that authenticator disabled at 100; 20 failures per hour per source; generic responses with a dummy verification for unknown accounts |
| Bounded work | 2 concurrent hash computations, a queue of 8, a 5-second wait, then a generic 503 that is not counted as a failure |
| Revocation | Effective for every session check after commit; no cancellation of work already past its check; no ordering guarantee against a concurrent write |
| Recovery | Password plus recovery code; otherwise the operator command (break-glass); key replacement that never needs the lost key |
| **Accepted risk (ruled 2026-10-30): lockout and sole-maintainer recovery** | An attacker who knows an administrator username may obstruct sign-in with 1-hour waits and, after an estimated four days (dependent on the throttling values and the attacker's pacing, not a guarantee), disable its password, requiring **operator-assisted recovery**. Recovery depends on **retained server and database access**. It does **not** need the existing TOTP encryption key: if that key is lost, the key-replacement procedure in P-6 applies. **Accepted by the Product Owner for the MVP** |

**After acceptance.** No incompatibility was found for the approved choices, and the SHA-256
basis is verified with the caveats in P-4. The prerequisites below are implementation and
deployment work, not acceptance conditions, and **each stays required**.

## Local implementation prerequisites

No Render account, instance or other hosted service is needed to build and test authentication
locally.

| # | Prerequisite |
|---|---|
| L-1 | Check the current version, maintenance status and security advisories of `otpauth` at implementation time, and pin it |
| L-2 | Select an offline password blocklist: its source, size, licence and update route |
| L-3 | Verify local cookie behaviour: whether `__Host-`/`Secure` cookies work on `http://127.0.0.1`, or whether local HTTPS is needed. Production attributes are never weakened |
| L-4 | Measure scrypt locally: the explicit `maxmem`, memory per computation, and behaviour under the concurrency limit |
| L-5 | Use a development-only TOTP encryption key, never a production key, kept out of the repository |

## Production deployment prerequisites

Required only before deployment, and before any administrative capability is publicly reachable
(which also needs the security review in ruling 7).

| # | Prerequisite |
|---|---|
| R-1 | Validate the Render instance's memory and CPU against the hashing budget and concurrency values |
| R-2 | Configure and verify the trusted proxy: which forwarded header carries the client address on Render, and that others are ignored |
| R-3 | Provision, back up and document the production TOTP encryption key and its version, outside the database. **No provisioning is authorized by this ADR** |
| R-4 | Complete the security review before public reachability |

---

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Microsoft Entra ID with Conditional Access** | It can target this app and enforce an MFA strength, but only with an Entra ID P1 licence (listed at $7.00 per user per month, paid yearly): a recurring fee the Product Owner excluded. Recovery of the tenant by a sole administrator is not documented |
| **Google or GitHub sign-in** | GitHub user sign-in is OAuth 2.0 with no OIDC ID token and no per-sign-in MFA signal; GitHub Actions OIDC authenticates workflows, not people. Google cannot enforce MFA on personal accounts, and its `amr` claim needs a published, verified app and "may not be present". Neither lets this app *require* the second factor |
| **Clerk (Hobby) or Auth0 (Free)** | MFA is paid on both free tiers. Clerk: MFA "requires a paid plan for production use"; Auth0: OTP-app factors are "Not available" on Free |
| **Supabase Auth (Free)** | TOTP is free, but enforcement remains the application's job, session timeouts are paid, and "Free projects are paused after 1 week of inactivity", which could lock every administrator out between moderation sessions |
| **Password only** | Fails the ruling. OWASP calls MFA "by far the best defense" against password attacks |
| **Passkeys (WebAuthn) as the second factor** | Phishing-resistant, but more to build and harder to recover for a sole maintainer. A possible later addition, not part of the MVP |
| **Stateless signed-cookie sessions** | Logout and revocation would not refuse subsequent session checks without a server-side denylist, and the ruling requires server-side sessions |
| **Hand-written TOTP, hashing or encryption** | Forbidden by the ruling; maintained libraries and platform implementations exist |

---

## Consequences

**Positive:**

- The application enforces the second factor itself on every sign-in, at no recurring cost, with
  no external service on the sign-in path and the same behaviour locally and in production.
- Server-side sessions make logout and revocation refuse every subsequent session check (work
  already past its check may finish; P-1) and keep the instance stateless.
- `ADR-001`'s `C8` boundary gains a concrete, testable mechanism, which `P4` requires.

**Negative:**

- The repository owns security-critical code: password verification, TOTP, secret encryption,
  recovery codes, throttling and sessions. It needs attack-level tests and the required security
  review.
- TOTP is **not phishing-resistant** (NIST: "OTP authentication is not phishing-resistant"), one
  reason no AAL2 claim is made.
- A new server secret, the TOTP encryption key, must be kept and rotated. Losing it does not
  block recovery, but forces the key-replacement procedure (P-6) and TOTP re-enrolment.
- A new dependency (the TOTP library) needs maintenance; password hashing and encryption use
  `node:crypto` only.
- Node 22 reaches end of life on 2027-04-30 (Node.js release schedule), so a runtime upgrade, and
  with it a possible move to `crypto.argon2`, is foreseeable.

**Reversibility:** **Moderate.** A later move to an external identity provider would replace
sign-in and enrolment but keep the session store, the `C8` checks and the identity-keyed shape.
Stored password hashes are self-describing, so the algorithm can change through rehash on sign-in.

---

## Assumptions

| Assumption | If it is wrong |
|---|---|
| A handful of administrators and one primary maintainer (`A-2`, `D-6`) | Invitation flows, self-service enrolment or roles would be needed; revisit this ADR |
| The maintainer keeps server, database and environment access for recovery | Recovery falls back to the hosting and database providers' own account recovery |
| Administrators can run a standard authenticator app | A different second factor would be needed |
| Administrators reach the deployment over HTTPS (`NFR-SEC-04`) | The `__Host-`/`Secure` cookie posture fails; the deployment must be fixed, not the cookie weakened |

---

## Risks

| Risk | Consequence | Response |
|---|---|---|
| A defect in the app-owned flow | Unauthorized administrative access | Attack-level tests (`BI-5`, `BI-9`, replay, throttling, expiry, revocation) and the required security review before public reachability |
| Loss or compromise of the TOTP encryption key | Stored TOTP secrets become unreadable or must be presumed exposed | The key-replacement procedure (P-6), which needs no old key: affected factors are reset, sessions revoked, and administrators re-enrol through password plus recovery code or the operator command |
| The sole maintainer loses password, device and recovery codes | Administration stops until server-side recovery | The documented procedure (P-6) and offline storage of recovery codes |
| The throttle is used to obstruct a real administrator | Lockout by delay: sign-in held in 1-hour waits, and the password authenticator disabled after an estimated four days of attempts (throttling-dependent, not a guarantee) | Usernames kept non-public, the per-source limit, prominent logging, and the operator procedure. **Residual risk accepted by the Product Owner for the MVP, 2026-10-30** |
| A flood of sign-in attempts | Memory pressure, or sign-in unavailable while the hashing queue is full | The concurrency limit and bounded queue (P-7) protect the instance; sign-in availability under flood is not guaranteed |
| A database leak | Exposure of hashes and ciphertext | Slow password hashing, session tokens stored as digests, TOTP secrets encrypted under a key held outside the database |

---

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OQ-9`**: anti-spam for public submissions | Sign-in throttling protects `C8` only. Nothing here applies to the public submission path or `C11` |
| **`OQ-14` + `NOQ-8`**: audit logging | Authentication events go to the **operational** log (`NFR-OBS-01`). Whether any becomes an audit record, its retention, and the lifecycle of retained identifiers are not decided |
| **`NOQ-7`**: operational-log retention | No retention period is set; only what must never be logged (`NFR-OBS-02`) |
| **#246 / `BI-4`**: public read-path equivalence, including timing | Untouched; `BI-4` remains **pending**. The sign-in non-disclosure in P-5 is a separate `NFR-SEC-02` / `BI-5` obligation. **Whether it covers response timing is not decided**, and no timing threshold is set |
| **`NOQ-5`, `NOQ-6`**: accessibility and support claims | No conformance or support claim. The sign-in screens must still meet `NFR-ACC-01`–`03` |
| **NIST AAL2** | No compliance claim (ruling 6). NIST figures are cited as design references only |
| **`DG-4`**: the release decision | Nothing here makes anything releasable; public reachability also needs the security review |

---

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-SEC-01`, `02`, `04`, `07`, `08`; `NFR-OBS-01`, `02`; `FR-AUTH-01`–`04`; `FR-MOD-02` |
| **Journeys** | `A1`–`A7`: every administrative journey sits behind this mechanism |
| **Components** | `C8` (Identity and Access); `C3` (administrative surface); `C9` (session and credential storage); `C12` (operational logging) |
| **Invariants** | `BI-5`, `BI-9`; `docs/09` `AA-1`–`AA-5`; must not breach `BI-4` or `BI-6` |
| **Documents amended** | `docs/adr/README.md`, `docs/13-decision-log.md`, `docs/traceability-matrix.md` and `README.md` record the rulings and this acceptance; `docs/06`, `docs/07` and `docs/12` record `NOQ-9` as decided |
| **Issue / pull request** | Issue #252; accepted through the pull request that closes it |

### Sources consulted (2026-10-30)

- NIST SP 800-63B-4: §3.1.1.2 password verifiers, §3.1.2 look-up secrets, §3.1.4–3.1.5 OTP, §3.2.2 rate limiting, §5.1–5.2 sessions. <https://pages.nist.gov/800-63-4/sp800-63b.html>; <https://pages.nist.gov/800-63-4/sp800-63b/authenticators/>; <https://pages.nist.gov/800-63-4/sp800-63b/session/>
- NIST SP 800-38D (GCM): §5.2.1.1, §5.2.1.2, §8.2.2, §8.3. <https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf>; the planned revision: <https://csrc.nist.gov/pubs/sp/800/38/d/final>
- OWASP Cheat Sheets: Password Storage, Session Management, Authentication, and Cross-Site Request Forgery Prevention. <https://cheatsheetseries.owasp.org/>
- RFC 6238 (TOTP). <https://www.rfc-editor.org/rfc/rfc6238>
- Node.js v22 `crypto` documentation, <https://nodejs.org/docs/latest-v22.x/api/crypto.html>, and the release schedule, <https://github.com/nodejs/Release>
- Next.js 16: the Authentication and Data Security guides, `cookies`, Proxy, and the `serverActions` configuration. <https://nextjs.org/docs>
- `otpauth`, <https://github.com/hectorm/otpauth>; `otplib`, <https://github.com/yeojz/otplib>; `@node-rs/argon2`, <https://github.com/napi-rs/node-rs/tree/main/packages/argon2>. Versions are from the npm registry
