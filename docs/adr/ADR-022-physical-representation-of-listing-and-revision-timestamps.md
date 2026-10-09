# `ADR-022` — Store every governed listing and revision instant as PostgreSQL `timestamptz(3)`, converted at the `C9` boundary to and from the domain's epoch-millisecond carrier

| Field | Value |
|---|---|
| **Status** | **`Accepted`** — 2026-10-09 (issue #169). The binding architecture ruling was given on issue #169 **before this document was drafted**, and is recorded below |
| **Date** | 2026-10-09 |
| **Decision owner** | **Joe S.** — product owner / architecture owner (`docs/13`, *Gate summary*). **Ruled 2026-10-09:** PostgreSQL **`timestamptz(3)`** for every governed listing and revision timestamp, absolute-instant semantics, millisecond precision, `NOT NULL` on `submittedAt` and `lastUpdatedAt`, nullable `rejectedAt` under its existing presence-**iff**-*rejected* invariant, an exact epoch-millisecond round trip at the `C9` boundary, `Date` confined to infrastructure, and explicit offset-aware `pg` parser configuration; `timestamp without time zone`, `date`, `bigint` epoch milliseconds, textual storage and mixed representations are **rejected for this schema** |
| **Decision gate** | *none* — `DG-1` is **`Resolved`** (2026-08-04) and `DG-2` is **`Resolved`** (2026-08-27, issue #93); this ADR is a constituent of neither. `DG-3` and `DG-4` are **`Unresolved`** and neither holds this decision |
| **Related open questions** | **Depends on:** nothing unresolved. The behaviour these data serve is already governed — `DI-6`/`NFR-DATA-05` (write-once `submittedAt`, strictly-increasing `lastUpdatedAt`, issue #141), `ADR-017` `PS-9` (write-once rejection timestamps, present **iff** *rejected*, issue #137) and the `OQ-13` retention ruling (issue #149). **Must NOT answer:** **`OQ-4`/`S-4`/`DDM-4`** searchable fields, indexing and text search; the **stale-edit detection policy and any supporting version token**; **`OQ-14`/`NOQ-8`/`DDM-7`/`S-8`** audit-entry storage; the **public projection form** (view or single `C9` query module); **`DDM-2`'s** domain carrier type, revision identity domain type and public identity transport; **`VR-S3`**'s safety and length boundaries (`DD-1`/`DD-2`); **PostgreSQL major version**, extension policy, **provisioning**, region, tier, sizing, pool, pooler, TLS, credentials and secrets; **CI migration validation** and **production migration execution**; **database-test tooling** and testing depth (`DG-4`); the **first schema migration**; `DG-3`, `DG-4` |
| **Supersedes** | *none* — `ADR-017` is **not** superseded. It deliberately deferred *"**Names, exact data types**, migration contents and authoring format"*, and this ADR **fills that deferral** for the governed instants rather than revising it, exactly as `ADR-020` filled its `DDM-5` exclusion and `ADR-021` its `DDM-3` exclusion |
| **Superseded by** | *none* |

> **Status: `Accepted` — 2026-10-09 (issue #169). In force; later work may rely on it.**
> **It authorizes no implementation.** No `pg` parser configuration, driver or runtime
> configuration, source or test change, schema, migration, DDL, provisioning or persistence
> code is created by this document or by its acceptance.

## Status and chronology — why this ADR is `Accepted` rather than `Proposed`

**The same sequence as `ADR-019`, `ADR-020` and `ADR-021`, and recorded for the same
reason.** In order:

1. **Domain timestamp behaviour was already governed.** `P1` Slice C (issue #141)
   established the logical instant and the timestamp bundle: `submittedAt` written once and
   never changed, `lastUpdatedAt` moved on **every** content or status change and requiring
   an instant **strictly later** than the current value, and a write-once rejection
   timestamp. `ADR-017` `PS-9` (issue #137) added that the rejection timestamp is present
   **if and only if** the record is *rejected*, with immutability enforced on the write path.
2. **Retention and lifecycle decisions fixed the required semantics.** The `OQ-13` ruling
   (issue #149) made *"90 days from rejection"* a **fixed elapsed duration** of exactly
   2,160 hours — 7,776,000,000 milliseconds — measured from the write-once rejection
   instant, purge-eligible **at** the exact boundary, with *"**no** calendar day, time zone,
   daylight-saving rule"*. That requires **absolute-instant** semantics and **exact
   comparability**, and it fixed them as behaviour before any storage question arose.
3. **The referral chain left the physical type and precision unresolved.** `ADR-017` `PS-9`
   selects *"a timestamp datum on each structure"* — a datum, with **no type**. Its own
   deferred-items table lists *"**Names, exact data types**, migration contents and
   authoring format"* as blocking **"Every migration"** and sends them to *"`ADR-015`
   outstanding items; never part of this ADR"*. `ADR-015`'s outstanding items were **five
   policy items** — authoring format, invocation, execution environment and timing, and
   rollback policy — all settled by `ADR-018`, which contains **no data-type governance at
   all**. Meanwhile `src/domain/listing/instant.ts` states *"**It is not a storage or
   transport decision.** No column type, precision, nullability, time-zone handling,
   serialization or wire format is selected or implied here… leaves its type to that
   layer"*, and `src/domain/listing/timestamps.ts` repeats *"**Nothing here decides
   storage.**"* Every document handed the question to the next, and the chain ended without
   an answer.
4. **Issue #169 identified this as the remaining first-migration content gate.** It
   classified `DDM-4`, the stale-edit/version-token question, `DDM-7`/`OQ-14`,
   PostgreSQL-version selection, provisioning and the `ADR-010` obligations against the
   authoritative sentence that settles each, found none of them to be a first-migration
   **content** prerequisite, and **requested** a ruling — marking its own recommendation
   *"advisory until explicitly selected"*.
5. **The binding ruling preceded this ADR draft.** The decision was ruled on issue #169
   before this file existed.

The register defines `Proposed` as *"drafted and under review; the decision is not yet in
force"*. A proposal exists to **obtain** a ruling. Here the ruling arrived first, so there is
nothing left to propose.

**No gate is opened**, and **`Accepted` does not mean implemented** — it means the rule is in
force and later work may rely on it. **Nothing in this document is evidence that any part of
it has been built**, and in particular **no `pg` parser is configured and no test exercises
one**.

## Context

**The semantics were governed; the representation was not.** A migration author sitting down
before this decision would have had explicit instruction for identity (`uuid`, primary key,
not null, **no generation default** — `ADR-019`), for location (free text, and *"a
`varchar(n)` must not be chosen merely because a migration needs a type"* — `ADR-020`) and
for category (one mandatory, non-null `text` column under a `CHECK` — `ADR-021`), and
**nothing at all for the timestamps**. `src/data/migrations/README.md` was silent on them.

That is the failure `ADR-017`'s own risk table names — *"A representation chosen by the first
migration rather than the approved one (`IR-1`)"* — and the choice is not cheaply reversible:
converting a zone-less column to an absolute-instant column later **reinterprets every
stored row** against whatever session timezone is in force.

**The requirements these data answer to.** `FR-AUD-02` and `FR-AUD-03` (submission and
last-updated dates recorded), `FR-AUD-06` and `NFR-PRIV-05` (rejected-record retention),
`NFR-DATA-05` (submission date recorded once and unchanged; last-updated changing on every
content or status change). The invariants they must not breach: **`DI-6`** (write-once
`submittedAt`; strictly-later `lastUpdatedAt`; write-once rejection timestamp present **iff**
*rejected*), and the `OQ-13` retention boundary.

## Authoritative datum inventory

Taken from the **executable domain**, not from prose. `src/domain/listing/timestamps.ts`
declares:

```
export interface ListingTimestamps {
  readonly submittedAt: Instant;
  readonly lastUpdatedAt: Instant;
  readonly rejectedAt?: Instant;
}
```

and `src/domain/listing/revision.ts` declares `ListingRevision` carrying
`readonly rejectedAt?: Instant` and **no other instant**.

**Mapping note.** Issue #169 spoke informally of *"the three governed timestamp data"*.
Counted as **data on structures**, there are **four**, because `rejectedAt` exists
independently on both the listing and the revision — `ADR-017` `PS-9` says *"a timestamp
datum on **each structure**"*, and `revision.ts` describes the revision's own anchor as
*"**separate from any last-updated notion**"*. The inventory below is authoritative; the
issue's count was a loose reference to the three distinct **domain names**, not a different
field set. **No field is invented and none is renamed.**

| Authoritative domain name | Structure | Lifecycle meaning | Required / nullable | Presence invariant | Write-once / update behaviour | Physical PostgreSQL type | Domain carrier | Round-trip obligation |
|---|---|---|---|---|---|---|---|---|
| **`submittedAt`** | Listing | The moment the record was submitted; a submission **is** a listing whose status is *pending* | **Required — `NOT NULL`** | Present on **every** listing, in every status; `FR-AUD-02` admits no record without one | **Write-once** — never changes after creation (`DI-6`, `NFR-DATA-05`) | **`timestamptz(3)`** | `Instant` (epoch-millisecond integer, `Number.isSafeInteger`) | Exact epoch-millisecond equality on read-back |
| **`lastUpdatedAt`** | Listing | The moment of the most recent content or status change | **Required — `NOT NULL`** | Present on **every** listing; equal to `submittedAt` at creation (ruling 1, issue #141) | **Updated**, and only forward: every successful content change and permitted status transition requires an instant **strictly later** than the current value | **`timestamptz(3)`** | `Instant` | Exact epoch-millisecond equality, and the **strict ordering must survive persistence** |
| **`rejectedAt`** | Listing | The listing's write-once retention anchor | **Nullable** | Present **if and only if** the listing's status is *rejected* (`ADR-017` `PS-9`) | **Write-once** — never changes once written; immutability enforced on the write path (`PS-9`), not by a store trigger | **`timestamptz(3)`** | `Instant`, or absent | Exact epoch-millisecond equality; `NULL` ↔ absent |
| **`rejectedAt`** | Revision (`ListingRevision`, `E7`) | The revision's **own** write-once retention anchor, *"separate from any last-updated notion"* | **Nullable** | Present **if and only if** the revision's state is *rejected* | **Write-once**; administrator-visible, **never public** (`DI-10`) | **`timestamptz(3)`** | `Instant`, or absent | Exact epoch-millisecond equality; `NULL` ↔ absent |

**Not in this inventory, and not added by this ADR.** The revision structure carries **no**
`submittedAt` and **no** `lastUpdatedAt` — `revision.ts` declares none, and inventing one
would be a data decision nobody has made. Only *pending* and *rejected* revision states
persist (`PS-5`), so a persisted revision row carries `rejectedAt` exactly when its state is
*rejected*. **No publication, purge, approval or audit timestamp is introduced** — purge
eligibility is **derived** (`PS-10`), unpublishing and republishing move **no** timestamp
(`timestamps.ts`), and `E5`'s existence is `OQ-14`, unresolved.

## Decision

**We will store every governed listing and revision instant as PostgreSQL
`timestamptz(3)`, and the `C9` persistence boundary will convert between it and the domain's
epoch-millisecond carrier with an exact round trip, keeping `Date` out of the domain.**

The decision has twenty-one parts, each binding.

### Type, precision and semantics

1. **PostgreSQL `timestamptz(3)` for every governed instant** in the inventory above.
2. **Millisecond precision**, fixed by the `(3)`.
3. **Absolute-instant semantics.** Every stored value denotes a point in time — **not** a
   local wall-clock time, **not** a calendar date, **not** a timezone-dependent business
   date.

### Nullability and the lifecycle invariant

4. **`submittedAt` and `lastUpdatedAt` are `NOT NULL`**, under those authoritative names, on
   the listing structure.
5. **`rejectedAt` is nullable**, on both structures.
6. **`rejectedAt` is present if and only if the applicable record's lifecycle value is
   *rejected*** — the existing invariant (`ADR-017` `PS-9`, `DI-6`), **preserved and not
   reopened**. This ADR states it in the chosen type; it neither amends nor re-derives it.

### Domain carrier and the boundary

7. **The domain carrier remains an epoch-millisecond integer.** No domain type changes.
8. **`Date` never enters the domain model.**
9. **The infrastructure adapter owns the conversion** — the `C9` boundary, not the domain.
   If a driver adapter uses `Date` internally, it stays confined there.
10. **Offset-aware parsing.** Parsing honours the explicit offset carried by the value
    PostgreSQL returns.
11. **Independence from the host timezone, DST rules and locale.** Nothing in the conversion
    may consult them.
12. **No ambient clock during hydration.** Reading a stored instant consults no clock —
    consistent with `instant.ts`, where *"Time is supplied, never read"*.
13. **Exact epoch-millisecond round trip.** A value written and read back must equal the
    original domain value exactly.

### Failure behaviour

14. **Strict rejection of invalid or unsafe values.** A value that is malformed, out of
    range, or not representable as a safe epoch-millisecond integer **fails at the
    persistence boundary**.
15. **No silent truncation, rounding or normalisation.** Precision the domain cannot
    represent is an error, never quietly discarded.

### Parser configuration

16. **Explicit `pg` parser configuration is required before persistence implementation is
    complete.**
17. **Parser behaviour must be tested.**
18. **No reliance on the `pg` default `Date` conversion.**

### Scope

19. **No PostgreSQL extension is required.**
20. **No PostgreSQL-version-specific feature is required** beyond broadly supported
    `timestamptz` fractional-second precision.
21. **No implementation is introduced by this decision.**

## PostgreSQL semantics, stated accurately

These are the properties the decision relies on, recorded so that no later reader has to
rediscover or guess them.

- **`timestamptz` represents an absolute instant.** It is a point on the timeline, not a
  wall-clock reading.
- **PostgreSQL normalises the instant on input and does not retain the original input
  timezone label.** An offset supplied on input is used to resolve the instant and is then
  **not preserved** as data. **This ADR makes no claim that the original timezone or offset
  is permanently stored, because it is not.**
- **Displayed text can vary with the session `TimeZone` while representing the same
  instant.** Two sessions may render one stored value differently; the value has not
  changed.
- **Application correctness must therefore compare the absolute instant, never formatted
  text.** Ordering, the `DI-6` strict-increase rule and the `OQ-13` elapsed-duration
  boundary are all comparisons of instants.
- **`(3)` constrains fractional seconds to milliseconds.** Values are stored at millisecond
  resolution.
- **The write path must avoid silently sending greater precision**, so that the constraint is
  never the thing that discards detail (decision 15).
- **Nullability is a separate declaration.** Where a datum is required, the migration must
  declare `NOT NULL` explicitly; the type implies nothing about it.

## Round-trip contract

Defined here, **not implemented here.**

### Domain to database

- The input is a **validated, safe epoch-millisecond integer** — the domain's existing
  guarantee (`Number.isSafeInteger`, `instant.ts`).
- Conversion produces an **offset-explicit instant representation** suitable for
  `timestamptz(3)`.
- **No local-time interpretation** at any step.
- **No precision beyond milliseconds** is sent.

### Database to domain

- The driver parser or adapter interprets the returned **offset-aware** value as an
  **absolute instant**.
- The output is a **safe epoch-millisecond integer**.
- The output **must exactly equal the originally stored domain value** for the round trip to
  be valid.
- **`Date` must not cross the boundary into domain code.**
- **Unsafe, malformed or out-of-range values fail explicitly** rather than being coerced.

**Deliberately not selected here, and recorded as later implementation details:**
the concrete conversion code, any library helper, and **whether the parser is registered
globally or per client**. Decision 16 requires the configuration to exist and be explicit;
**which mechanism carries it is an implementation decision**, and this ADR does not pre-empt
it.

## Parser configuration boundary

- **Explicit parser behaviour is required** — the default `Date` conversion must not be
  relied on silently (decisions 16–18).
- The configuration must be **repository-owned and testable**.
- It **must not rely on the machine-local timezone**.
- It **must not mutate unrelated `pg` parsing globally without deliberate scope** — if a
  global registration is chosen, that scope is a deliberate, recorded choice rather than a
  side effect.
- **The exact registration mechanism remains an implementation decision**, as nothing
  governs it today.
- **Parser tests must include**: the same instant expressed with **multiple different
  offsets**; **DST-boundary** examples; **pre-epoch** values if domain-valid; **millisecond
  edge** values; and **invalid** values that must fail.

**No test is added by this decision unit.** The obligation is recorded; the tests belong to
the unit that configures the parser.

## Alternatives considered

**None of these is incorrect.** Each has a genuine advantage, and each is **rejected for this
schema**, with the rationale preserved so it is not silently re-made (`IR-6`).

### `timestamp without time zone` — rejected

| | |
|---|---|
| **Legitimate advantage** | Slightly simpler mental model when every writer is known to use one zone; no session-`TimeZone` influence on rendered text |
| **Why rejected here** | It stores a **wall-clock reading with no zone**, so its meaning depends on an **undocumented and unenforceable convention**. A writer with a different session `TimeZone` silently shifts stored moments, and elapsed-duration arithmetic across a DST boundary becomes ambiguous — colliding directly with the `OQ-13` ruling's *"**no** calendar day, time zone, daylight-saving rule"* and with `DI-6`'s strict ordering |
| **Migration / operational consequence** | **The worst of the set.** Converting to `timestamptz` later **reinterprets every existing row** against whatever session timezone is in force — a data-correctness migration, not a type change, and precisely the irreversibility this gate existed to prevent |

### `date` — rejected

| | |
|---|---|
| **Legitimate advantage** | Compact, and sufficient for genuinely calendar-shaped data |
| **Why rejected here** | **None of these data is a calendar date.** All four are instants, and `DI-6` compares them for strict increase while `OQ-13` measures an exact 2,160-hour elapsed duration between them. A date discards the time of day outright |
| **Migration / operational consequence** | Information-destroying: the discarded time of day is **unrecoverable**, so no later migration could restore the precision the governed rules require |

### `bigint` epoch milliseconds — rejected

| | |
|---|---|
| **Legitimate advantage** | **Carrier-faithful** — it stores the domain's representation verbatim, with a lossless and perfectly symmetric round trip, no zone semantics at all, and no possibility of producing a `Date`. This is a real advantage, and the strongest case against the selection |
| **Why rejected here** | It **sacrifices readable SQL temporal semantics and ordinary temporal operations.** The stored value is opaque in the store and in every administrative query — the ground on which `ADR-017` set aside small integer codes — and any SQL date arithmetic, range query or reporting needs conversion everywhere. `pg` also returns `int8` as a **string** by default, so an explicit parsing contract is required either way and the choice buys no simplification there |
| **Migration / operational consequence** | Reversible in principle — `bigint` → `timestamptz` is a deterministic, non-destructive conversion with no zone ambiguity — so this remains a **legitimate later option** if the carrier fidelity ever outweighs readability. Moving the other way is equally deterministic |

### Textual timestamp storage — rejected

| | |
|---|---|
| **Legitimate advantage** | Maximally portable, and preserves the exact submitted text including its offset label |
| **Why rejected here** | Forfeits all type checking, ordering and temporal operations in the store; ordering becomes lexicographic rather than chronological unless every value is identically formatted, which nothing enforces; and admitting malformed values becomes possible at the storage layer |
| **Migration / operational consequence** | Conversion later is a parse-and-rewrite of every row, with per-row failure modes for any value that drifted from the assumed format |

### Mixed physical representations — rejected

| | |
|---|---|
| **Legitimate advantage** | Each datum could in principle be optimised independently |
| **Why rejected here** | The four governed data are compared with one another and against one elapsed-duration rule. Mixing representations would require conversion at every comparison, multiply the round-trip contracts, and make the `DI-6` and `OQ-13` guarantees depend on which pair is being compared |
| **Migration / operational consequence** | Every later change would have to be made several times, and a divergence between two of the data would be a silent correctness defect rather than a type error |

## Change and compatibility scenarios

| # | Scenario | Behaviour, and what would be required |
|---|---|---|
| 1 | **Insert and hydrate an ordinary instant** | Domain supplies a safe epoch-millisecond integer; the boundary sends an offset-explicit millisecond value; read-back returns the **identical** integer. **No migration, no adapter change, no validation change.** |
| 2 | **The same instant expressed with different offsets** | Both resolve to the **same** absolute instant and compare equal; PostgreSQL normalises on input and retains no offset label. **No change required** — and this is a required **parser test case** |
| 3 | **Millisecond boundary values** | Representable exactly by both `timestamptz(3)` and the carrier. **No change required** — a required **parser test case** |
| 4 | **Rejected versus non-rejected nullability** | `rejectedAt` is `NULL` on a *pending* or *approved* record and present on a *rejected* one, enforced by the existing presence-**iff** constraint; the domain maps `NULL` ↔ absent. **No change required** |
| 5 | **Very old or far-future domain-valid values** | Admitted so long as they are safe epoch-millisecond integers and within `timestamptz` range, which is far wider. **No change required**; pre-epoch values are a required **parser test case** |
| 6 | **An invalid database value reaches the adapter** | It **fails explicitly** at the boundary (decisions 14–15) — never rounded, normalised or silently coerced. **Requires no migration; requires the adapter's validation** to exist, which is later implementation |
| 7 | **Parser misconfiguration** | A `Date`, a locale-dependent parse, or a lost millisecond would otherwise reach the domain. **Requires an adapter fix and a parser test**, not a migration — which is why decisions 16–18 make the configuration explicit and tested rather than default |
| 8 | **Session timezone change** | **Stored instants do not change.** Rendered text may differ; comparisons are unaffected because they compare instants, not text. **No change required** — and no application logic may depend on rendered text |
| 9 | **Migration rollback** | Dropping a newly added `timestamptz(3)` column is clean **while no row depends on it**. **Changing the type after rows exist is not cleanly reversible** — `timestamptz` → `timestamp without time zone` discards the instant's absoluteness. Under `ADR-018` the honest path is a **forward corrective migration**, and any destructive step needs separate explicit authorization and an `ADR-010`-based safeguard and recovery assessment |
| 10 | **A future increase in precision** | `timestamptz(3)` → `timestamptz(6)` is an **additive widening** that no stored value contradicts, so it needs **a schema migration but no backfill**. It would, however, permit values the **current carrier cannot represent**, so it additionally **requires a domain-carrier decision and an adapter change** — and must not be done as a schema-only change. Narrowing precision later would be **lossy** |

## Consequences

**Positive:**

- **The last identified first-migration content gate is closed**: the governed instants now
  have a type, a precision, a nullability rule and a round-trip contract.
- **Absolute-instant semantics match what the governed rules require** — `DI-6`'s strict
  increase and the `OQ-13` exact 2,160-hour boundary are both comparisons of instants.
- **Millisecond precision makes the round trip symmetric**: the store cannot hold a moment
  the domain cannot represent.
- **The store stays readable** — ordinary SQL temporal operations, ordering and range queries
  work without conversion, honouring the same preference by which `ADR-017` rejected integer
  codes and `ADR-020` chose `text`.
- **`Date` is kept out of the domain** without abandoning the idiomatic column type.
- **A latent failure mode is removed**: the `pg` default `Date` conversion can no longer be
  relied on silently.

**Negative:**

- **An explicit parser configuration is now owed**, with tests across offsets, DST
  boundaries, pre-epoch values, millisecond edges and invalid input. That work did not exist
  before this decision; it is named here and remains unimplemented.
- **A conversion exists at the boundary** rather than storing the carrier verbatim, so there
  is one more place a defect could live — which is exactly why decision 17 requires it to be
  tested.
- **A pinned precision is a commitment.** Widening later is additive but reaches the domain
  carrier (scenario 10).
- **Nothing is simplified for administrative tooling that wants raw epoch values** — those
  must convert.

**Reversibility:** **Moderate, and asymmetric.** `timestamptz(3)` → `bigint` and
`timestamptz(3)` → `timestamptz(6)` are deterministic and non-destructive. `timestamptz` →
`timestamp without time zone` or → `date` is **lossy and must not be treated as a type
change**. **Nothing is expensive to reverse today, because no schema and no rows exist** —
no backfill is owed.

## Assumptions

| Assumption | If it is wrong |
|---|---|
| **Millisecond resolution is sufficient** for every governed instant, as the domain carrier already assumes | A finer requirement reaches the carrier, not only the column: scenario 10 applies, and `instant.ts` would need its own decision |
| **The domain carrier remains an epoch-millisecond safe integer** (`instant.ts`) | The boundary contract would be re-derived against the new carrier; the column could stay as it is |
| **`pg` and Kysely core `PostgresDialect`** (`ADR-016`) permit configuring timestamp parsing without forking or patching | The conversion would move to an explicit mapping layer in `C9`; the column choice is unaffected |
| **No governed rule depends on a calendar date or a business-day boundary** — the `OQ-13` ruling says so in terms | A calendar-shaped rule would need its own representation decision; it must not be derived from these instants by assuming a timezone |
| **`timestamptz` with explicit fractional-second precision is available** on whatever version is later selected (it is long-standing core PostgreSQL) | The precision would have to be enforced at the boundary instead of declared; the semantics would not change |

## Risks

| Risk | Consequence | Response |
|---|---|---|
| **The parser is never configured**, and the `pg` default silently returns `Date` | `Date` crosses into the domain, defeating decision 8 and reintroducing the mutable, locale-aware type `instant.ts` refused | Decisions 16–18 make explicit configuration and tests a **stated obligation of the persistence unit**, and name the required test cases |
| **A migration author declares `timestamptz` without `(3)`** | The store can hold sub-millisecond detail the domain cannot represent, making the round trip asymmetric | Decisions 1–2 and the reconciled `src/data/migrations/README.md` state the precision explicitly |
| **A migration author omits `NOT NULL`** | `submittedAt` or `lastUpdatedAt` could be absent, contradicting `FR-AUD-02` and `DI-6` | Decision 4, and the PostgreSQL-semantics note that the type implies nothing about nullability |
| **Someone compares rendered text** instead of instants | Session-`TimeZone` differences look like data differences | The semantics section states it directly: compare the absolute instant, never formatted text |
| **Sub-millisecond input is silently truncated** by a future write path | A written value differs from the value read back, breaking the exact round trip | Decision 15 forbids silent truncation; decision 14 requires explicit failure |
| **A global parser registration changes unrelated `pg` parsing** | Other types are affected as an invisible side effect | The parser-boundary section forbids undeliberate global scope and leaves the mechanism to be chosen explicitly |
| **`Accepted` is read as implemented** | The persistence unit assumes a parser exists | The status block, decision 21 and the reconciled documents all state that no parser, schema, migration or persistence exists |

## Open questions this decision must NOT answer

| Open question | How this decision avoids answering it |
|---|---|
| **`OQ-4` / `S-4` / `DDM-4`** — searchable fields, matching mode, indexing and text search | **Unresolved, untouched.** No index of any kind is declared or implied; `ADR-017` selected none, and later indexing arrives additively |
| **Stale-edit detection policy and any supporting version token** | **Still product policy not yet ruled.** `ADR-017` offers *"a listing version or **last-updated value** recorded when an edit is prepared"* as examples; this ADR fixes the **type** of `lastUpdatedAt` and takes **no position** on whether it is ever used as a concurrency token, nor on whether a separate token is added |
| **`OQ-14` / `NOQ-8` / `DDM-7` / `S-8`** — audit-entry storage | **Unresolved.** No audit structure, column or timestamp is introduced; `E5`'s existence is still an open product question |
| **Public projection form** (database view or single `C9` query module) | **Still deferred** by `ADR-017`. This ADR declares no view and no query module |
| **`DDM-2`'s** remaining items — domain carrier type, revision identity domain type, public identity transport | Untouched. The carrier is **retained as it is**, not re-selected, and no identifier transport is declared |
| **`VR-S3`** safety and length boundaries (`DD-1`/`DD-2`) | Untouched — no length or bound is introduced for any column |
| **PostgreSQL major version, extension policy** | **Not selected**, and decisions 19–20 record that the choice needs neither |
| **Provisioning**, region, tier, sizing, pool, pooler, TLS, credentials, secrets | **None selected**; **no database is contacted** by this decision |
| **CI migration validation, production migration execution, deployment integration, production authority** | Outstanding under `ADR-018`, and not decided here |
| **`ADR-010`** capability validation, independent off-provider copy, restore rehearsals | **Outstanding.** `ADR-010` is read, and **neither extended nor reinterpreted** |
| **Database-test tooling** and testing **depth** (`DG-4`) | **Unselected and `Unresolved`.** The parser tests this ADR requires are an obligation on a later unit, which must work within whatever tooling is then governed; **no tooling is chosen here and no test is added** |
| **The first schema migration** | A **separately authorized later unit** under `ADR-018`. This ADR fixes what it must declare for these four data and creates none of it |
| **The `pg` parser's registration mechanism**, conversion code and library helpers | Explicitly recorded as **later implementation details**; decision 16 requires the configuration, not a particular shape |
| **Category configuration, `DI-9`/`AV-7` validation, the `ADR-021` equality test** | Untouched, still owed, still unimplemented |
| **`OQ-5`, `DDM-3`, the approved vocabulary and machine keys** | Not reopened and not amended |
| **`DG-3`, `DG-4`** | Neither opened, narrowed nor pre-empted |

## First-migration readiness

**What this decision changes.** The **timestamp physical representation is determined**, and
with it **no known first-migration content decision remains** — on the evidence gathered in
issue #169, which classified each competing candidate against the authoritative sentence that
settles it: `ADR-017` selected **no index or search structure** and records the `DI-11`
pending-uniqueness constraint as *"integrity, not performance"*; the stale-edit/version-token
deferral blocks *"`OP-6` revision creation, `OP-10` approval and the `FR-ADM-10b` atomic
path… **their tests**"*, **not the migration**; `DDM-7` is *"only meaningful once `E5` is
known to exist"*; and the intended DDL needs **no extension and no particular server
version**.

**Distinguished from that, and still open: decisions that could add later columns or
indexes.** These do **not** block authoring, and each would arrive **additively**:

- the **stale-edit/version-token** policy — could add a **column**, if a token separate from
  `lastUpdatedAt` is ever ruled;
- **`OQ-4`/`DDM-4`** — will add **indexes**, and could require an extension if a text-search
  or trigram strategy is later chosen;
- **`OQ-14`/`DDM-7`** — would add a **separate audit structure**, and `ADR-017` recorded a
  constraint on how a future audit reference may interact with purge;
- the **public projection form** — would add a **database view**, if a view rather than a
  `C9` query module is chosen;
- a **governed length bound** (`VR-S3`, `DD-1`/`DD-2`) — would add constraints to text
  columns.

**What this decision does not change.** **It does not authorize the first schema
migration**, which remains a **separately authorized later unit**. **Authoring readiness is
not execution or deployment readiness.** Remaining operational and implementation
prerequisites, recorded accurately:

- **no PostgreSQL major version is selected**;
- **nothing is provisioned** — no account, cluster, region, tier or sizing;
- `ADR-010`'s **capability validation** is owed **before provisioning**, and its **independent
  off-provider copy** and **restore rehearsals** are owed **before launch**; the rehearsal
  environment and mechanism remain **deferred** and the mechanism **unselected**;
- **local migration execution** needs a disposable PostgreSQL server; `ADR-018`'s first
  authorized execution shape is **explicit local developer invocation**;
- **database-test tooling is unselected** and testing depth is `DG-4`, `Unresolved`;
- **CI migration validation**, **production execution**, **deployment integration**,
  **credentials** and **production authority** are all outstanding;
- the **`pg` parser configuration and its tests** are owed before persistence implementation
  is complete;
- the **category configuration module**, **`DI-9`/`AV-7` validation** and the **`ADR-021`
  equality test** are owed;
- **`OQ-14`** should be answered **before production traffic**, because uncaptured history
  cannot be recovered retrospectively.

## Traceability

| | |
|---|---|
| **Requirements** | `FR-AUD-02`, `FR-AUD-03`, `FR-AUD-06`; `NFR-DATA-05`, `NFR-PRIV-05`. **Not answered:** `FR-SRCH-01`–`09` |
| **Journeys** | `L2`/`L3` (submission), `A3`/`A6` (moderation, rejection), `S7` (post-approval revision) |
| **Components** | **`C9`** (the data layer and the conversion boundary), `C6` (write paths enforcing write-once behaviour) |
| **Invariants** | **`DI-6`** (write-once `submittedAt`; strictly-later `lastUpdatedAt`; write-once `rejectedAt` present **iff** *rejected*); the `OQ-13` 2,160-hour retention boundary. **Not breached:** `DI-1`, `DI-8`, `DI-10`, `DI-11` |
| **Decisions consumed** | `ADR-017` `PS-9` and its *"exact data types"* deferral; `ADR-016` (`pg` through Kysely core `PostgresDialect`); `ADR-018` (authoring format, forward-only rollback); `ADR-019`, `ADR-020`, `ADR-021` (the type-governance precedent); `ADR-010` (read, neither extended nor reinterpreted); the issue #141 timestamp rulings, the issue #137 `PS-9` rulings and the issue #149 retention ruling — all unchanged |
| **Documents amended** | `docs/adr/README.md` (the register), `src/data/migrations/README.md`, `docs/08-data-model.md`, `docs/13-decision-log.md`, `docs/traceability-matrix.md`, `src/data/README.md` — **amended in the same pull request** (`IP-9`) |
| **Issue / pull request** | Closes issue #169. Ruling recorded on issue #169, 2026-10-09 |
