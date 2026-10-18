/**
 * `C9` — the two revision operations this slice authorizes (issue #195).
 *
 * - **`createPendingRevision`** — `OP-6` against an approved listing, under `ADR-024`'s
 *   `PS-11` protocol.
 * - **`findPendingRevisionByListing`** — retrieve a listing's **sole** pending revision.
 *
 * Two functions over a Kysely instance, exactly as `listing-repository.ts` established; there is
 * no repository class and no generic abstraction, because an interface shaped for operations that
 * do not exist yet would be guessing at callers that do not exist yet.
 *
 * ## The transaction, and why its order is the correctness argument
 *
 * `ADR-024` (`Accepted` 2026-10-14, issue #189) fixes one protocol for all four governed write
 * paths, and it names its own material tradeoff: correctness depends on **enforced statement and
 * lock order** rather than on the engine. The order below is therefore not a style choice, and
 * `revision-persistence.integration.test.ts` drives it with real interleavings rather than
 * trusting it.
 *
 * `READ COMMITTED` is set **explicitly per transaction** rather than inherited from a server
 * default, which is what makes the behaviour independent of how any particular server is
 * configured. The listing row is locked **first**, before any check or content read, and held
 * through commit; the pending-revision read happens **after** that lock, in a fresh statement
 * snapshot, which is precisely how `ADR-024` meets `PS-11`'s visibility requirement: a preceding
 * participant may create a revision while **locking but not modifying** the listing row, so
 * conflict detection must never be assumed from lock acquisition alone.
 *
 * ## `ADR-025`, enforced here (issue #207)
 *
 * `OP-6` **does** enforce the designation policy, as of this unit. The locked listing read is
 * widened to the complete row and hydrated with the governed mapper, and
 * `enforceDesignationPolicy` is invoked **once**, with the **authoritative post-lock stored
 * content** as the current side and the caller's **original** proposed content as the other.
 * A prohibited widening, public addition or public replacement is refused as
 * `DESIGNATION_POLICY_REFUSED` **before any persistence mutation**, carrying every offending
 * field in the rule's own deterministic order.
 *
 * **Nothing is normalized and nothing is privatized.** `ADR-025` governs no canonicalization for
 * these four fields, so an unequal carrier is a replacement however it differs, and a refused
 * proposal is refused rather than quietly rewritten — `FR-VAL-03`/`FR-CONF-04` and `ADR-023`'s
 * refusal posture both require the caller be told.
 *
 * The rule runs **after** the lifecycle, `DI-11` and stale-token decisions, so none of those
 * outcomes moves: a stale proposal is stale even when it also widens a designation, which is
 * `ADR-023`'s requirement that staleness never be mislabelled, read in the other direction.
 * **`OP-10` does not revalidate the policy** — that is separately sequenced work.
 *
 * ## What `OP-6` deliberately does not do
 *
 * **No listing write.** `docs/09` is explicit that `OP-6` changes content, never the effective
 * public version, so `last_updated_at` must not move: the operation changed no listing content,
 * and moving it would make every other pending proposal stale for nothing.
 *
 * That is also why the captured token appears here as a **pre-insert equality check** and as an
 * **inserted value**, and not in a SQL predicate. `ADR-024`'s ruling speaks of *"the original
 * token carried in the guarded listing-**write** predicate, with the affected-row count
 * participating in the correctness check"* — and `OP-6` performs no listing write to guard, while
 * `INSERT … VALUES` has no `WHERE` clause at all. The ADR's own `OP-6` sequence shows the token
 * exactly this way, and shows `WHERE last_updated_at = $base` only under `OP-10` and `FR-ADM-04`,
 * both of which genuinely `UPDATE listing`. **Manufacturing a no-op listing `UPDATE` merely to
 * create a predicate is therefore forbidden**, not merely unnecessary.
 *
 * Two taxonomy members are consequently **unreachable here**, and are documented rather than
 * implemented as dead branches:
 *
 * - **The same-millisecond `DI-6` advancement failure.** `DI-6`/`NFR-DATA-05` governs a
 *   *strictly increasing* `lastUpdatedAt`. `OP-6` reads no clock, supplies no `$now` and advances
 *   no timestamp, so there is no advancement to fail. It stays distinct from staleness everywhere
 *   it does apply (`OP-10`, `FR-ADM-04`), and `ADR-023` requires it never be mislabelled as
 *   stale input — a rule this operation cannot violate because it cannot reach it.
 * - **Exhausted retry.** `ADR-024` authorizes **no automatic application-level retry**, so no
 *   retry exists here to exhaust. `40001`/`40P01` are *classified* defensively — the server
 *   decides which `SQLSTATE` it raises — and classification is explicitly **not** a licence to
 *   retry. Nothing below retries anything.
 *
 * ## Failure vocabulary
 *
 * `ADR-024`'s seven kinds must not collapse into one another, and `listing-repository.ts`'s
 * discipline is reused rather than re-derived: not found is its own outcome and never masks a SQL
 * error; a row that exists but cannot be represented is a different, louder problem than a row
 * that is absent; a refused stored instant is its own outcome because the database is perfectly
 * healthy; and everything unexpected stays `STORAGE_FAILURE`.
 *
 * **Classification uses `SQLSTATE` *and* the constraint name.** `23505` alone cannot distinguish
 * a repeated revision identifier from `DI-11`'s conditional uniqueness, and those are different
 * facts: one is an identity collision the application caused, the other is the integrity backstop
 * firing. Reporting either as the other would be confidently wrong.
 */

import type { Kysely, Transaction } from "kysely";

import {
  enforceDesignationPolicy,
  type DesignationViolation,
} from "../domain/listing/designation";
import { instantEquals, isInstant, instantOf } from "../domain/listing/instant";
import type { ListingId } from "../domain/listing/listing-id";
import { err, ok, type Result } from "../domain/listing/result";
import { isPendingRevision, type ListingRevision } from "../domain/listing/revision";
import { hydrateListing, type ListingHydrationFailure } from "./listing-mapping";
import {
  hydratePendingRevision,
  serializePendingRevision,
  type RevisionHydrationFailure,
} from "./revision-mapping";
import type { PendingListingRevision } from "../domain/listing/revision";
import { identifierTextOf } from "./row-mapping";
import type { ListingDatabase } from "./listing-table";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";
import { storageFailure, sqlStateOf, constraintOf, type StorageFailure } from "./storage-failure";

/** PostgreSQL's unique-violation class. Named, because a bare code is a riddle. */
const UNIQUE_VIOLATION = "23505";

/** PostgreSQL's serialization-failure and deadlock classes — the only two `ADR-024` admits. */
const RETRYABLE_CONFLICT_STATES: readonly string[] = ["40001", "40P01"];

/** The constraint whose violation means *this revision identifier is already stored*. */
const REVISION_IDENTITY_CONSTRAINT = "listing_revision_pkey";

/**
 * `DI-11`'s conditional uniqueness, as `001` names it.
 *
 * Its violation means the **backstop fired**: the post-lock read should already have refused the
 * second proposal, so reaching the index is a protocol fault to surface rather than an ordinary
 * outcome, and never a reason to retry (`ADR-024`: *"a backstop firing is a fault to surface"*).
 */
const PENDING_UNIQUENESS_CONSTRAINT = "listing_revision_one_pending_per_listing";

/**
 * Why a pending revision could not be created.
 *
 * Every member is a distinct fact about the attempt. None of them is softened into another, and
 * none of them is a domain validation result — the caller validated the proposal before this
 * boundary was reached.
 */
export type CreatePendingRevisionFailure =
  /** No listing is stored under this identifier; nothing was written. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /** The listing exists but its lifecycle state cannot accept a proposal (`FR-ADM-10`). */
  | { readonly code: "LISTING_NOT_APPROVED"; readonly status: string }
  /** `DI-11` — a proposal is already pending, decided **under the lock**. Not queued. */
  | { readonly code: "PENDING_REVISION_ALREADY_EXISTS" }
  /**
   * `ADR-023` — the captured base token does not equal the listing's current version.
   *
   * Nothing was written, and the listing and any pending revision are unchanged. **Distinct
   * from every other outcome**, and in particular never conflated with a timestamp-advancement
   * failure, which this operation cannot reach at all.
   */
  | { readonly code: "STALE_LISTING_VERSION" }
  /**
   * `ADR-025` — the proposal would publish a value the policy requires to be private.
   *
   * The **complete** violation array the pure rule produced, in its own deterministic field
   * order, carried intact: `FR-VAL-02`/`VR-5` require the specific fields at fault, and a caller
   * that widened two of them is told about both. Each entry names a **field** and the **change
   * classification** that produced the refusal — never a value, so nothing private travels in a
   * failure.
   *
   * **Distinct from every neighbour, by construction.** `ADR-025` requires this refusal stay
   * separate from malformed content (`INVALID_PENDING_REVISION`), stale input
   * (`STALE_LISTING_VERSION`), timestamp advancement (unreachable here), lifecycle failure
   * (`LISTING_NOT_APPROVED`) and storage failure, and the type system holds that apart:
   * `DesignationViolation` is not assignable to `ValidationViolation` in either direction.
   *
   * It is **not** retryable. The proposal is refused, not deferred.
   */
  | {
      readonly code: "DESIGNATION_POLICY_REFUSED";
      readonly violations: readonly DesignationViolation[];
    }
  /**
   * The locked listing row exists but cannot be represented (`ADR-025` enforcement input).
   *
   * **Never reported as not found**, and never as a caller error: the row is present and the
   * caller supplied nothing wrong — the *stored state* disagrees with the governed model, which
   * is the louder problem `listing-repository.ts` and `approveAndApplyPendingRevision` already
   * treat as its own outcome. The carrier is the mapper's own `ListingHydrationFailure`, which
   * names a **code and a column** and carries no row content, no value, no SQL and no
   * credential. Nothing retries it.
   */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /** The supplied revision is not a usable pending proposal; refused before any transaction. */
  | {
      readonly code: "INVALID_PENDING_REVISION";
      readonly reason:
        | "not-pending"
        | "rejection-anchor-present"
        | "unusable-base-token"
        | "unusable-listing-identifier"
        | "unusable-revision-identifier"
        | "unreadable-revision";
    }
  /** A revision with this identifier already exists (`listing_revision_pkey`). */
  | { readonly code: "REVISION_ALREADY_EXISTS" }
  /** `DI-11`'s index fired — the backstop, which the protocol should have pre-empted. */
  | { readonly code: "PENDING_UNIQUENESS_CONFLICT" }
  /**
   * The server raised a serialization failure or a deadlock.
   *
   * **Classified, never retried** — `ADR-024` authorizes no automatic application-level retry,
   * and a future authorized one must reuse, reread and recompare the original token.
   */
  | { readonly code: "RETRYABLE_CONFLICT"; readonly sqlState: string }
  /** The locked listing's own stored instant was refused by the governed parser (`ADR-022`). */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  /**
   * The protocol reached a state it proves cannot happen.
   *
   * `ADR-024` requires a protocol violation be **loud** rather than absorbed into an ordinary
   * outcome. It is reachable only if the lock, the statement order or the schema is not what this
   * module requires, which is exactly when silence would be most expensive.
   */
  | { readonly code: "REVISION_PROTOCOL_FAILURE"; readonly detail: string }
  | StorageFailure;

export type FindPendingRevisionFailure =
  /** No pending revision is stored for this listing. An ordinary answer, not an error. */
  | { readonly code: "PENDING_REVISION_NOT_FOUND" }
  /** The row exists but cannot be represented. Never reported as not found. */
  | { readonly code: "REVISION_UNREADABLE"; readonly failure: RevisionHydrationFailure }
  /**
   * More than one pending revision exists for one listing.
   *
   * **Unreachable while `DI-11`'s index exists**, and reported loudly rather than resolved by
   * picking one: choosing between them would require an ordering or identity the domain
   * deliberately does not have, and would hide a broken invariant behind a plausible answer.
   */
  | { readonly code: "MULTIPLE_PENDING_REVISIONS"; readonly count: number }
  /** A stored instant was refused by the governed parser (`ADR-022`, issue #173). */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  | StorageFailure;

/**
 * A refusal raised from inside the transaction so that it **rolls back**.
 *
 * Kysely commits when its callback returns and rolls back only when it throws, so returning a
 * failure value would leave the transaction **committed**. On the refusal paths nothing has been
 * written, so a commit would write nothing either — but it would release the `PS-11` lock through
 * `COMMIT` rather than `ROLLBACK`, and more importantly the code would be claiming a rollback it
 * never performed. `ADR-024` requires a refused `OP-6` to leave the listing and any pending
 * revision unchanged, and the honest way to say that is to actually roll back.
 *
 * It never escapes this module: `createPendingRevision` catches it and returns its failure.
 */
class PendingRevisionRefused extends Error {
  constructor(readonly failure: CreatePendingRevisionFailure) {
    super("the pending revision was refused");
    this.name = "PendingRevisionRefused";
  }
}

/**
 * Whether the supplied value is a usable pending proposal, checked before anything is opened.
 *
 * **This is not domain validation.** `VR-S1`/`VR-6` ran in `validation.ts` before the proposal
 * existed, and re-running them here would be a second, divergent copy of a governed rule — the
 * reasoning `insertSubmittedListing` already records. What is checked is only what this boundary
 * must not be able to write:
 *
 * - a **non-pending** state, because `001`'s `CHECK` admits `pending` and `rejected` and this
 *   slice persists only the former, while `approved` never persists at all (`ADR-017` Q-3);
 * - a **rejection anchor on a pending proposal**, which no governed operation can produce;
 * - an **unusable base token**, because `ADR-023` item 12 refuses a missing or malformed one and
 *   a bad carrier would otherwise reach SQL as `NaN`;
 * - **unusable identifiers**, because `ADR-019` makes them application-supplied and a non-string
 *   would be silently stringified by the `uuid` cast.
 *
 * A caller error must surface as a caller error, not as a `STORAGE_FAILURE` from a `CHECK` the
 * store happened to catch.
 */
function refusePendingRevision(
  revisionId: string,
  revision: ListingRevision,
): CreatePendingRevisionFailure | undefined {
  if (typeof revisionId !== "string" || revisionId === "") {
    return { code: "INVALID_PENDING_REVISION", reason: "unusable-revision-identifier" } as const;
  }

  // Ordered so that each refusal names the *specific* fact that is wrong, before the general
  // shape check below reports anything else as simply unreadable.
  if (revision?.state !== "pending") {
    return { code: "INVALID_PENDING_REVISION", reason: "not-pending" } as const;
  }

  if (revision.rejectedAt !== undefined) {
    return { code: "INVALID_PENDING_REVISION", reason: "rejection-anchor-present" } as const;
  }

  if (!isInstant(revision.baseListingLastUpdatedAt)) {
    return { code: "INVALID_PENDING_REVISION", reason: "unusable-base-token" } as const;
  }

  const listingId = (revision.listingId as unknown as { readonly supplied?: unknown })?.supplied;

  if (typeof listingId !== "string" || listingId === "") {
    return { code: "INVALID_PENDING_REVISION", reason: "unusable-listing-identifier" } as const;
  }

  // The domain's own full judgement, last: it proves the complete readable shape — the identity
  // object, the governed state, inspectable proposed content, the rejection-anchor rule and the
  // exact base-token carrier. Anything the specific checks above did not name is reported as
  // unreadable rather than guessed at, and this is also the call that **narrows** the value, so
  // no cast is needed downstream.
  if (!isPendingRevision(revision)) {
    return { code: "INVALID_PENDING_REVISION", reason: "unreadable-revision" } as const;
  }

  return undefined;
}

/**
 * `ADR-024` step 1 — the `PS-11` lock, taken first and held through commit.
 *
 * **`selectAll`, not three columns** (issue #207). `ADR-025` compares the proposal against *"the
 * listing's current persisted value"*, so enforcement needs the **complete** stored content, and
 * the only authority for it is the row this statement locks. Reading it here rather than in a
 * second query is what makes the comparison unforgeable: there is no window between the lock and
 * the read in which a rival could change what is compared.
 *
 * This is `approveAndApplyPendingRevision`'s `lockListingRow` precedent, for the same reason it
 * records — *"the domain's operation requires the complete readable aggregate"*. It is still
 * **one statement**, still the **first state read**, and still `SELECT … FOR UPDATE` on the
 * listing row, so `ADR-024`'s lock-first ordering is unchanged; only the projection widened.
 */
async function lockListing(trx: Transaction<ListingDatabase>, listingId: string) {
  return await trx
    .selectFrom("listing")
    .selectAll()
    .where("id", "=", listingId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Create one pending revision (`OP-6`), under `ADR-024`'s protocol.
 *
 * `revisionId` is `ADR-019`'s **application-generated** UUID v4. It is not a domain value: the
 * revision identity domain type does not exist, `DDM-2` leaves it open, and nothing here creates
 * one. The identifier is supplied, never generated — there is no database default to fall back on
 * — and no `RETURNING` clause is used, because inventing an identity contract is exactly the
 * decision this unit must not take.
 *
 * The proposal arrives **already created and already validated by the domain**, carrying its own
 * listing identifier, the complete proposed content and the **original** captured base token.
 *
 * Every value is a **bound parameter** — Kysely compiles the insert with placeholders — so content
 * that looks like SQL stays content.
 */
export async function createPendingRevision(
  db: Kysely<ListingDatabase>,
  request: {
    readonly revisionId: string;
    readonly revision: ListingRevision;
  },
): Promise<Result<void, CreatePendingRevisionFailure>> {
  const { revisionId, revision } = request;

  // Refused before a transaction is opened, so a caller error never takes a lock.
  const refusal = refusePendingRevision(revisionId, revision);

  if (refusal !== undefined) {
    return err(refusal);
  }

  // Narrowed by the domain's own guard rather than by a cast: `refusePendingRevision` has already
  // run it, so this cannot fail, and asking again is how the compiler — not a comment — comes to
  // know the value is a `PendingListingRevision`.
  if (!isPendingRevision(revision)) {
    return err({ code: "INVALID_PENDING_REVISION", reason: "unreadable-revision" } as const);
  }

  const pending: PendingListingRevision = revision;
  const listingId = identifierTextOf(pending.listingId);

  try {
    await db
      .transaction()
      // `ADR-024`: set explicitly per transaction, never inherited from a server default.
      .setIsolationLevel("read committed")
      .execute(async (trx) => {
        // (1) The `PS-11` lock. FIRST, before any check or content read, held to commit.
        const locked = await lockListing(trx, listingId);

        // (2) The listing must exist.
        if (locked === undefined) {
          throw new PendingRevisionRefused({ code: "LISTING_NOT_FOUND" } as const);
        }

        // (3) …and be able to accept a proposal. `FR-ADM-10` admits a revision only against an
        // approved listing, which is the domain's own rule in `admitPendingRevision`.
        if (locked.status !== "approved") {
          throw new PendingRevisionRefused({
            code: "LISTING_NOT_APPROVED",
            status: locked.status,
          } as const);
        }

        // (4) The post-lock read. A fresh statement snapshot under `READ COMMITTED`, so it
        // observes a preceding participant's committed revision even when that participant only
        // **locked** the listing row — `PS-11`'s visibility requirement, met rather than assumed.
        const existing = await trx
          .selectFrom("listing_revision")
          .select("id")
          .where("listing_id", "=", listingId)
          .where("state", "=", "pending")
          .forUpdate()
          .execute();

        // (5) `DI-11`, decided **under the lock** rather than by the index. A second proposal is
        // rejected, not queued, and neither the pending revision nor the listing is disturbed.
        if (existing.length > 0) {
          throw new PendingRevisionRefused({
            code: "PENDING_REVISION_ALREADY_EXISTS",
          } as const);
        }

        // (6) The stale check, **before any mutation** (`ADR-023` item 12). The locked listing's
        // current version is compared with the token the caller captured when the work began, by
        // exact epoch-millisecond equality — the same `Instant` carrier on both sides, which is
        // why the comparison cannot drift into different representations.
        const current = instantOf(locked.last_updated_at);

        if (!current.ok) {
          // The column is `NOT NULL` and the parser delivers safe integers, so this is a stored
          // value that cannot be read rather than an absence — and never a staleness claim.
          throw new PendingRevisionRefused({
            code: "REVISION_PROTOCOL_FAILURE",
            detail: "the locked listing's last_updated_at is not a usable instant",
          } as const);
        }

        if (!instantEquals(pending.baseListingLastUpdatedAt, current.value)) {
          // Thrown, so the transaction genuinely **rolls back**: nothing is written, and the
          // listing and any pending revision are unchanged. Never automatically refreshed,
          // merged or overwritten.
          throw new PendingRevisionRefused({ code: "STALE_LISTING_VERSION" } as const);
        }

        // (7) Hydrate the locked listing — the authority `ADR-025` compares against (issue
        // #207). It happens **here**, after every pre-existing refusal, because only the
        // designation rule needs it: placing it earlier would add a failure mode to paths that
        // are already decided, and would move outcomes no part of this unit is authorized to
        // move. `approveAndApplyPendingRevision` hydrates earlier for the opposite reason — its
        // domain operation needs the whole aggregate from the start.
        //
        // A row that exists but cannot be represented is a different, louder problem than one
        // that is absent, and it is never a caller error: the proposal is fine, the store is
        // not.
        const storedListing = hydrateListing(locked);

        if (!storedListing.ok) {
          throw new PendingRevisionRefused({
            code: "STORED_LISTING_UNREADABLE",
            failure: storedListing.error,
          } as const);
        }

        // (8) `ADR-025`, enforced **before any mutation** and exactly once. The current side is
        // the **locked, stored** listing's content — never the caller's, never a pre-lock read —
        // and the proposed side is the caller's **original** content, unnormalized and
        // unmodified. Nothing is coerced to private: a widening is refused, with every offending
        // field reported in the rule's own deterministic order.
        const designation = enforceDesignationPolicy(
          storedListing.value.content,
          pending.proposedContent,
        );

        if (!designation.ok) {
          // Thrown, so the transaction genuinely **rolls back**: no revision row is inserted,
          // the listing is not written, and no timestamp moves.
          throw new PendingRevisionRefused({
            code: "DESIGNATION_POLICY_REFUSED",
            violations: designation.error,
          } as const);
        }

        // (9) Insert, carrying the ORIGINAL captured token — never the value just read. No
        // listing write, no timestamp advance, no recapture, no retry, no external side effect.
        await trx
          .insertInto("listing_revision")
          .values(serializePendingRevision(revisionId, pending))
          .execute();
      });

    // Reached only when the transaction committed, which happens only on the insert path.
    return ok(undefined);
  } catch (cause) {
    // A governed refusal: raised inside the transaction so that it rolled back, and carried out
    // here so the caller still receives it as an ordinary `Result` rather than an exception.
    if (cause instanceof PendingRevisionRefused) {
      return err(cause.failure);
    }

    // A governed instant the parser refused is not an infrastructure failure: the query ran.
    if (cause instanceof TimestamptzParseError) {
      return err({ code: "STORED_INSTANT_UNREADABLE", reason: cause.reason } as const);
    }

    const sqlState = sqlStateOf(cause);

    if (sqlState === UNIQUE_VIOLATION) {
      const constraint = constraintOf(cause);

      if (constraint === REVISION_IDENTITY_CONSTRAINT) {
        return err({ code: "REVISION_ALREADY_EXISTS" } as const);
      }

      if (constraint === PENDING_UNIQUENESS_CONSTRAINT) {
        // The backstop fired, which means the post-lock read did not pre-empt it. Surfaced as
        // the fault it is — never retried, and never reported as the ordinary `DI-11` refusal.
        return err({ code: "PENDING_UNIQUENESS_CONFLICT" } as const);
      }
    }

    if (sqlState !== undefined && RETRYABLE_CONFLICT_STATES.includes(sqlState)) {
      // Classified defensively, because the server decides which `SQLSTATE` it raises.
      // Classification is **not** a licence to retry, and nothing here retries.
      return err({ code: "RETRYABLE_CONFLICT", sqlState } as const);
    }

    // Anything else — a `CHECK` violation, a foreign-key violation, a dead connection — stays
    // unexpected. It is never softened into a business outcome.
    return err(storageFailure(cause));
  }
}

/**
 * Retrieve the listing's **sole** pending revision.
 *
 * **Named by `DI-11`, not by identity.** An approved listing has at most one pending revision at
 * a time, enforced by `listing_revision_one_pending_per_listing`, so `listing_id` plus the
 * *pending* state names exactly one row — the same way the domain names it, where
 * `resolveSolePendingRevision` records that the rule *"names the proposal without identifying
 * it"*. No revision identifier is accepted, returned or exposed, and the row's `id` never leaves
 * `src/data/`.
 *
 * **No lock, and no transaction.** This is a single statement, atomic by itself, participating in
 * no multi-statement invariant — `findListingById`'s reasoning exactly. `ADR-024` scopes the
 * `PS-11` lock to the governed **write** paths; taking one for an independent read would hold an
 * exclusive listing lock for a query that mutates nothing, and `OP-10` takes its own lock and
 * does its own locked read when it needs one.
 *
 * It performs **no write**, touches no listing row, and returns the domain revision rather than an
 * administrative projection — which is why seam `S-7`/`S-8` (whether that projection carries
 * review history, with `OQ-14`) stays open and undecided. It is not a public read path: `DI-10`
 * keeps pending revisions out of every public projection, and `publicProjectionOf` reads nothing
 * from any revision.
 */
export async function findPendingRevisionByListing(
  db: Kysely<ListingDatabase>,
  listingId: ListingId,
): Promise<Result<PendingListingRevision, FindPendingRevisionFailure>> {
  let rows;

  try {
    rows = await db
      .selectFrom("listing_revision")
      .selectAll()
      .where("listing_id", "=", identifierTextOf(listingId))
      .where("state", "=", "pending")
      .execute();
  } catch (cause) {
    if (cause instanceof TimestamptzParseError) {
      return err({ code: "STORED_INSTANT_UNREADABLE", reason: cause.reason } as const);
    }

    // Outside the checks below on purpose: a query that failed is not a revision that is absent.
    return err(storageFailure(cause));
  }

  if (rows.length === 0) {
    return err({ code: "PENDING_REVISION_NOT_FOUND" } as const);
  }

  if (rows.length > 1) {
    // `DI-11` makes this unreachable. Reported rather than resolved: picking one would need an
    // ordering the domain does not have, and would hide a broken invariant.
    return err({ code: "MULTIPLE_PENDING_REVISIONS", count: rows.length } as const);
  }

  const hydrated = hydratePendingRevision(rows[0] as NonNullable<(typeof rows)[0]>);

  if (!hydrated.ok) {
    return err({ code: "REVISION_UNREADABLE", failure: hydrated.error } as const);
  }

  return ok(hydrated.value);
}
