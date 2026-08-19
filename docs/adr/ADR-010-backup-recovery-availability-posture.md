# `ADR-010` — Adopt a single-instance availability posture with finer-grained recovery capability and a 24-hour-fresh independent copy

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Date** | 2026-08-19 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*) |
| **Decision gate** | **`DG-2`** |
| **Related open questions** | **Depends on:** ~~`NOQ-2`~~ **Decided 2026-07-30** (availability target) · ~~`NOQ-3`~~ **Decided 2026-07-30**, as amended by ruling **R1** on 2026-08-18 (backup, RPO, RTO, independent copy). **Must NOT answer:** the technology-stack question (`ADR-002`–`ADR-005`, `ADR-012`), `NOQ-1`, `NOQ-4`, `DDM-1`–`DDM-10` |
| **Supersedes** | *none* |
| **Superseded by** | *none* |

---

## Context

`docs/07-system-architecture.md` defers two decisions that this ADR exists to take:
**`DD-8`** — the availability target, *and whether redundancy is deployed* — and **`DD-9`** —
backup frequency, recovery point objective, and recovery time objective. Both were blocked on
product-owner questions. Both questions are now answered, and the deferred half of each is not.

**The numbers are settled; the posture was not.** `NOQ-2` (**Decided 2026-07-30**) fixed the
availability target at **99% of the time over a rolling monthly window, excluding announced
maintenance**, with the public read path taking priority over administrative tools
(`NFR-REL-01`, `NFR-REL-02`, `NFR-REL-05`). `NOQ-3` (**Decided 2026-07-30**) fixed the recovery
obligations: **at least daily backups** (`NFR-BACK-01`), a **documented, tested recovery
procedure restore-tested before launch** (`NFR-BACK-02`), an **RPO of up to 24 hours and an RTO
of one business day** (`NFR-BACK-03`), **equivalent confidentiality, access control and
protection for every copy** (`NFR-BACK-04`), a restore **tested at least quarterly** thereafter
(`NFR-BACK-05`), and **at least one backup copy independent of the primary data-store
provider** (`NFR-BACK-06`).

**Ruling `R1` closed a gap those numbers left open.** `NFR-BACK-03` stated the recovery point
objective without naming a failure class, while `NFR-BACK-06` originally guaranteed only a
weekly *refresh cadence* for the independent copy — which could leave that copy roughly a week
behind live data, and which in any case did not reliably bound its actual staleness: backup
generation and copy transfer each introduce lag, and those lags **compound**. `R1` therefore
constrains **staleness**, not cadence. On **2026-08-18** the
owner ruled that **there is one recovery point objective for the MVP recovery posture, and it
governs every in-scope recovery scenario including complete loss of, or loss of access to, the
primary provider**. `NFR-BACK-06` was amended accordingly: the independent copy must be **no
more than 24 hours behind the committed state of the live data**. That amendment is already
normative in this repository; this ADR **inherits it and does not re-decide it**.

**What remained undecided, and is decided here.** `DD-8` still required an answer on runtime
redundancy: a target is not a topology, and `docs/07` records that *"99% and 99.9% are
different deployments"* while statelessness *"preserves both options"*. `DD-9` still required
the recovery **capability** to be stated: `docs/07` is explicit that these objectives fix the
required backup *capability*, **not merely a schedule**, and that the mechanism delivering it
is still to be chosen.

**Why this must precede `ADR-003`.** `docs/07` `DD-3` states that the data-store product
*"cannot be responsibly chosen until `NOQ-2` and `NOQ-3` are answered"*, and **hard requirement
5** disqualifies any candidate that is not *"a store with point-in-time restorable,
confidentiality-preserving backups"*. That disqualifier is a **capability filter**, and until
the required capability is stated it cannot be applied honestly — a store chosen first would
retroactively define the posture instead of being screened by it. The ADR register records
`ADR-010` as **feeding `ADR-003`** for exactly this reason.

**Three distinctions this decision rests on.**

- **Availability and recoverability are related but distinct.** One is about being reachable;
  the other is about getting the data back. `docs/07` records the project's priority plainly:
  *"with one maintainer, data loss is fatal and a short outage is not"*, revisitable *"when
  `NOQ-2` commits to a target above roughly 99%"* — and `NOQ-2` committed to exactly 99%.
- **Redundancy is not backup.** A second running instance can help survive an
  application-instance or host failure. It does not protect the shared data state from
  accidental deletion or corruption; multiple application instances can continue serving the
  same damaged state.
- **Recovering bytes is not recovering the product.** A restore that returns every record but
  violates the accepted lifecycle invariants has failed, however healthy it looks.

## Decision

**We will adopt a single-instance availability posture, require a recovery capability finer
than the ordinary scheduled-backup interval, and require at least one independent recoverable
copy no more than 24 hours behind the committed state of the live data — all stated as required
outcomes, selecting no technology.**

These are one decision, not three: the availability posture is defensible *because* the
recovery posture is strong, and the independent-copy requirement is what makes the availability
posture survivable when the provider itself is lost. Separating them would let each be judged
against a standard the others were carrying.

### Availability posture (`DD-8`)

- The MVP runs a **single application instance**.
- **Runtime redundancy is not required**, and **no automatic failover is required**.
- The **99% availability target is unchanged** — this decision does not lower, raise, or
  reinterpret `NOQ-2`.
- **Redundancy may be revisited** if observed operation shows the 99% target cannot be met.
  `ADR-001`'s stateless instances keep that an operational change rather than a redesign.
- This decision selects **no hosting platform, runtime model, or deployment topology** — those
  remain `DD-5` and `ADR-005`.

### Recovery posture (`DD-9`)

- The **at least daily** backup obligation stands (`NFR-BACK-01`).
- The **RPO of up to 24 hours** and **RTO of one business day** stand (`NFR-BACK-03`).
- A restore is **tested before launch** and **at least quarterly** thereafter (`NFR-BACK-02`,
  `NFR-BACK-05`), rehearsed in a manner **safe and isolated from production**. A **permanently
  dedicated non-production environment is not required** for the MVP; the rehearsal environment
  and mechanism remain **deferred** to downstream technology and implementation decisions.
- **A recovery capability finer than the ordinary scheduled-backup interval is required.** Its
  purpose is to recover from **accidental deletion, operator error, and data corruption** —
  failures where the valuable capability is returning to a point just before the mistake rather
  than discarding a whole interval of legitimate work alongside it.
- **The 24-hour RPO is the maximum tolerated data loss, not the required granularity of the
  recovery mechanism.** Requiring better precision does not conflict with it.
- The **mechanism is not selected**.

### Provider-loss posture (inherited from `R1`)

- **At least one recoverable copy is held independently of the primary data-store provider**,
  and it must be **no more than 24 hours behind the committed state of the live data**
  (`NFR-BACK-06`, as amended).
- **Provider loss is therefore held to the same 24-hour RPO** as every other in-scope scenario.
  There is **no weaker provider-loss objective**.
- **This is a freshness obligation only.** The independent copy is **not** required to preserve
  the finer-grained recovery capability described above. That capability serves operator error
  and corruption; this one serves provider loss. **The two purposes are not collapsed.**
- **No mechanism, location, service, or provider is selected.**

### Failure classes in MVP scope

**In scope:** loss of, or loss of access to, the primary provider; accidental deletion and
operator error; data corruption.

**Not separately required for the MVP:** whole-region survival as an independent failure class.
Provider loss must **not** be reinterpreted as requiring whole-region redundancy.

### Retention and rotation

**Retention duration, rotation schedule, and deletion mechanics remain deferred**
(`NFR-BACK-04`). **No retention period is set here.** Whatever is eventually chosen must
preserve the existing obligations on every copy and on every recovery procedure:
confidentiality and access control, valid purge decisions, and the rule that a restoration
**must not silently return an expired or purged record to live use**.

### Hard requirement 5 — reconciled, not weakened

`docs/07` hard requirement 5 requires *"a store with point-in-time restorable,
confidentiality-preserving backups."* **The owner retains the stronger reading of that phrase.**
It stands as a genuine capability requirement, not a placeholder satisfied by scheduled
snapshots.

Consequently **`ADR-003` must screen candidate stores for a recovery capability finer than the
ordinary scheduled-backup interval**, and the 24-hour RPO remains the **maximum tolerated
loss** rather than the granularity the mechanism must provide. The two statements are
compatible: one is a ceiling on loss, the other a floor on capability.

### What a valid recovery must preserve

A technically successful restore is not sufficient. A recovery is correct only if the restored
**business state** is correct. It must preserve, as applicable:

- **stable listing identity** across the record's life (`DI-8`, `NFR-DATA-06`);
- **valid listing lifecycle state** — the three-value status set of `FR-AUD-01`, with no
  transition `NFR-DATA-02` does not permit, and **rejection terminal**;
- the **currently approved version** of an approved listing;
- **pending-revision non-publication** (`DI-10`) and **at most one pending revision per
  listing** (`DI-11`);
- **publication state** — an unpublished listing returns unpublished;
- **purge and non-resurrection obligations** — a purged or expired rejected record must not
  return to live use (`FR-AUD-06`, `NFR-BACK-04`, `ADR-006`);
- **transactional consistency** — no partially applied state (`DI-3`, `NFR-DATA-03`,
  `NFR-REL-04`).

This states the **required outcome**. It selects **no physical representation** — those remain
`ADR-006`'s deferred data decisions (`DDM-1`–`DDM-10`).

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Option A — single instance, scheduled-backup recovery only.** One running instance; recovery by restoring the most recent scheduled backup, with no capability finer than that interval. | **Rejected on the failure classes, not on cost.** It satisfies the coarse 24-hour RPO and would have been the operationally simplest posture. But `Q4` places **accidental deletion, operator error, and data corruption** in MVP scope, and against those A is weakest: undoing one bad operation late in the day means discarding that whole day of otherwise legitimate work. It also cannot satisfy **hard requirement 5** under the reading the owner retained. |
| **Option B — single instance, finer-grained recovery capability.** *(chosen)* | **Selected.** It keeps the availability side operationally simple, which `docs/07` weights **Highest** for a single maintainer and which the recorded recoverability-over-availability priority supports at exactly 99%. It addresses operator error and corruption meaningfully rather than nominally. It honours hard requirement 5's stronger reading. And it gives `ADR-003` an **explicit capability filter** while selecting no store. |
| **Option C — runtime-redundant deployment, scheduled-backup recovery.** More than one instance serving traffic; recovery as in Option A. | **Rejected for the MVP.** It improves **runtime availability**, not data recovery. Runtime redundancy does not protect the shared data state from corruption or operator error; multiple application instances can continue serving the same corrupted state. It adds monitoring burden and a new silent failure mode (a replica that has failed unnoticed) to the resource `docs/07` calls scarcest. `docs/07` ties revisiting redundancy to a target **above roughly 99%**, and that trigger was not crossed. **It remains available later** if observed operation shows 99% cannot be met. |
| **Doing less than the committed obligations** — for example backups without an independent off-provider copy, or without a tested restore. | **Not viable at any price.** It breaks `NFR-BACK-06` and `NFR-BACK-02`, both **Must**. Recorded here only so the option is visibly rejected rather than silently unavailable. |

## Consequences

**Positive:**

- **`ADR-003` inherits an explicit recovery-capability filter** stated as an outcome, so store
  selection is screened by a decided capability instead of defining one after the fact.
- **Operator-error and corruption recovery is materially stronger** than a scheduled-interval
  posture would provide.
- **The provider-loss recovery target is explicit** — one objective, no weaker tier, no gap
  between the survival promise and what survives.
- **The availability posture stays operationally simple**, consistent with `ADR-001`'s *"one
  deployment, one log stream, one test suite, one thing to restore."*
- **Restore rehearsals test actual recoverability**, including the business-state invariants —
  `docs/07` `R-7` exists because an unexercised restore is *"a belief, not a capability."*

**Negative:**

- **The candidate-store field for `ADR-003` is narrower.** Requiring capability beyond scheduled
  snapshots excludes stores that would satisfy the 24-hour RPO alone. This is a deliberate cost.
- **It may increase cost or operational complexity** relative to scheduled snapshots alone. The
  repository establishes no figures, and none are asserted here.
- **A single instance still permits outages**, with no automatic failover; recovery of
  availability depends on a maintainer noticing and acting.
- **Meeting 99% must be observed operationally**, not assumed. `NFR-REL-02` is a **Must**, and a
  single prolonged recovery could consume a month's allowance.
- **Recovery procedures must validate business-state correctness**, not merely that data is
  present — a heavier rehearsal than a byte-level restore check.

**Reversibility:**

- The **availability posture is cheap to reverse.** Statelessness (`ADR-001`) keeps adding
  instances an operational change, not a redesign; nothing here forecloses it.
- The **recovery-capability requirement is expensive to reverse after `ADR-003` lands**, because
  it is a store-selection filter: relaxing it later means revisiting the store choice.
- The **independent-copy freshness obligation** is `NOQ-3` as amended by `R1` and is not this
  ADR's to relax.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **The MVP is operated by a small team without dedicated operations staff** (`NFR-OPS-01`, `A-5`). | The case for a single instance weakens: with more operational capacity, redundancy costs less than it does here, and Option C becomes worth revisiting. |
| **The directory is small at first release** (`PA-1`, `A-5`, `A-6`). | Recovery time, backup volume, and the cost of a finer-grained capability all scale with it. `docs/12` names `PA-1` as the first assumption to revisit if wrong. |
| **99% availability is achievable without runtime redundancy** in observed operation. | `DD-8` is reopened. `NFR-REL-02` is a **Must**, so persistent shortfall against it forces redundancy back onto the table — the revisit this decision explicitly leaves open. |
| **`NOQ-1` and `NOQ-4` remain unresolved**, and everything here assumes "small" rather than a measured load (`docs/07` `R-4`). | Load large enough to change the recovery profile would make both the availability posture and the recovery mechanism worth re-examining. |
| **Stateless application instances remain the architecture** (`ADR-001`). | The cheap reversibility of the availability posture disappears; adding redundancy would become a redesign rather than an operational change. |
| **A store exists that satisfies the required capability at acceptable cost** once `ADR-003` evaluates candidates. | If no candidate satisfies both the capability filter and the project's other hard requirements, this ADR must be revisited before `ADR-003` can proceed — the filter, not the store, would be what needs re-deciding. |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **The finer-grained capability is provisioned but never exercised.** | A recovery capability nobody has used is `docs/07` `R-7` in a new form — a belief rather than a capability, discovered during a real incident. | The restore rehearsal required before launch and at least quarterly (`NFR-BACK-02`, `NFR-BACK-05`) must exercise **this** path, not only a whole-backup restore. |
| **The capability filter over-constrains `ADR-003`.** | Store selection narrows to candidates that are more costly or more complex than the project needs, on a criterion adopted here rather than measured. | The filter is stated as a **capability**, not a mechanism, keeping the widest field consistent with it. If `ADR-003` finds the field unworkably narrow, that is a finding to bring back here — not a reason to quietly relax the filter. |
| **A restore succeeds technically and corrupts business state.** | Listings return under wrong identities, a pending revision becomes public (`DI-10`), or a purged record returns to live use — each a trust failure that looks like a successful recovery. | The recovery obligations above are stated as outcomes the rehearsal must verify, not merely as data-presence checks. |
| **The single instance misses the 99% target in practice.** | `NFR-REL-02`, a **Must**, is breached, and the availability posture chosen here is the proximate cause. | The decision explicitly leaves redundancy available for revisit on observed evidence; `ADR-001`'s statelessness keeps that change operational. |
| **The independent copy silently falls behind 24 hours.** | Provider loss then exceeds the RPO — the exact gap `R1` closed, reopened by drift rather than by decision. | `NFR-BACK-06` states the obligation as **staleness relative to committed live data**, which is directly observable, rather than as a refresh cadence that can be met while the copy still lags. |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **The technology stack** — language, framework, store, hosting, authentication, CI, test tooling (`DG-2`; `ADR-002`–`ADR-005`, `ADR-012`) | Every requirement here is stated as a **capability or an outcome**. No product, vendor, service, or mechanism is named or implied, and **`DG-2` remains Unresolved**. |
| **The data-store product** (`DD-3`, `DDM-1`, `ADR-003`) | This ADR states the capability `ADR-003` must screen for; it does not screen. **`ADR-003` is not promoted** and remains free to choose the product, its hosting and management model, its schema and indexing. |
| **Hosting platform, runtime model, deployment topology** (`DD-5`, `ADR-005`) | "Single instance" is a **posture**, not a topology. Where and how it runs is untouched. |
| **The backup, replication, snapshot, or point-in-time mechanism** | Named nowhere. The requirement is *recovery to a point finer than the ordinary scheduled interval* — an outcome any conforming mechanism may deliver. |
| **Physical data representation** (`DDM-1`–`DDM-10`, `ADR-006`) | The recovery obligations are expressed as **business-state outcomes** — identity, lifecycle, publication state, non-resurrection — never as fields, flags, tables, or timestamps. |
| **Backup retention duration and rotation** (`NFR-BACK-04`) | Explicitly deferred. **No period is set**, and the deferral is recorded as a deferral rather than resolved by silence. |
| **`NOQ-1` / `NOQ-4`** — performance thresholds and expected load | Carried as stated assumptions (`PA-1`), not resolved. No threshold is asserted anywhere in this ADR. |
| **`NOQ-5` / `NOQ-6`** — accessibility level and support matrix | Untouched; unrelated to this decision and not mentioned in it. |
| **Whether whole-region survival becomes an MVP obligation** | Explicitly **not required** as an independent failure class. Provider loss is in scope; region loss is not, and provider loss is not reinterpreted as implying it. |
| **Whether disaster-recovery drills become a committed MVP obligation** (`docs/11`) | The committed obligation remains the restore test of `NFR-BACK-02`/`NFR-BACK-05`. This ADR adds no wider drill commitment. |

## Traceability

| | |
|---|---|
| **Requirements** | `NFR-REL-01`, `NFR-REL-02`, `NFR-REL-05`, `NFR-REL-06`; `NFR-BACK-01`–`NFR-BACK-06`; `NFR-OPS-01`, `NFR-OPS-04`, `NFR-OPS-05`; `NFR-DATA-03`, `NFR-DATA-06`; `NFR-PRIV-03`; `FR-AUD-01`, `FR-AUD-06` |
| **Journeys** | Indirect. No journey changes. The availability target is measured against the **public read path** (`V1`–`V7`), which `NFR-REL-02` prioritises over administrative tools (`A1`–`A7`). |
| **Components** | `C4` (public read projection), `C6` (moderation and status), `C7` (validation), `C9` (data access), `C12` (operational plane). The store itself is reached only server-side over a private path (`ADR-001`, hard requirement 4). |
| **Invariants** | Must not breach: `DI-3` (atomicity), `DI-8` (durable identity), `DI-10` (pending revision never public), `DI-11` (at most one pending revision); `BI-1`, `BI-4`, `BI-6` — a restore must not expose what the boundary invariants protect. |
| **Documents amended** | `docs/adr/README.md` (register status and the in-force summary); `docs/07-system-architecture.md` (the `ADR-010` register row); `docs/traceability-matrix.md` (the `ADR-010` row). **`DD-8` and `DD-9` are discharged by this acceptance** — the availability posture and the required recovery capability are now decided. **The mechanism is not:** the store, its backup and point-in-time implementation, and the hosting and deployment model all remain open (`DD-3`, `DD-5`, `DDM-1`, `ADR-003`, `ADR-005`). |
| **Issue / pull request** | Issue **#69**. Pull request: *to be recorded when opened.* Prerequisite work: Issue **#70** / PR **#72** (`R1` applied to the requirements), Issue **#71** / PR **#73** (test-strategy synchronization). Prerequisite decisions: closed issues **#43** (`NOQ-2`), **#44** (`NOQ-3`). |

---

**Status note.** This ADR is **`Accepted`** — accepted by the product owner on **2026-08-19**
(issue #69) and therefore **in force**. Work may rely on it, and later decisions must conform
to it. It **discharges `DD-8` and `DD-9`**: the availability posture and the required recovery
capability are decided.

**Acceptance opens no gate.** `ADR-010` now supplies the capability constraints `ADR-003` must
respect, but **`ADR-003` is not thereby decided, promoted, or begun** — commissioning it is a
separate governed action. **No store, provider, product, mechanism, hosting platform, or
deployment topology is selected.** **`DG-2` remains Unresolved** — its technology-stack blocker
is untouched, and the accounting stays three hard blockers, two Decided, one Unresolved. The
**technology stack remains Unresolved**, and **no implementation is authorized**: `P0b` and
`P1`–`P5` remain blocked by `DG-2`.
