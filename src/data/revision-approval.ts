/**
 * `C9` — `OP-10`: approve the sole pending revision and apply it, atomically (issue #197).
 *
 * One function over a Kysely instance, exactly as `listing-repository.ts` and
 * `revision-repository.ts` established. It is the second of `ADR-024`'s four governed write
 * paths to be implemented, and it reuses the first's protocol shape rather than re-deriving it.
 *
 * ## What makes this operation different from `OP-6`
 *
 * `OP-6` wrote one row and touched no listing. `OP-10` performs **two** mutations that must
 * stand or fall together: the listing's content becomes the proposal's content, and the applied
 * proposal is removed. `ADR-017` Q-3 requires exactly that — *"applying the approved proposal's
 * content and removing that proposal"* as **one atomic unit** (`NFR-DATA-03`, `DI-3`) — so there
 * is no outcome in which the content was applied and the proposal survived, or the reverse.
 *
 * The domain already expresses that in its **type**: `approvePendingRevision` returns a single
 * `RevisionResolution` carrying both the updated listing and the collection without the approved
 * proposal. This module's whole job is to turn that one value into one transaction.
 *
 * **`DI-6` is engaged here, and `OP-6` could not reach it.** `advancedTimestamps` refuses an
 * approval instant that is not **strictly** later than the listing's current `lastUpdatedAt`.
 * `ADR-023` requires that failure never be mislabelled as stale input, and both are reachable in
 * this operation — so they are separate codes, asserted separately, and neither is derived from
 * the other.
 *
 * ## The guarded write, and why the token appears twice
 *
 * `ADR-024`'s ruling requires *"the original token carried in the guarded listing-write
 * predicate, with the affected-row count participating in the correctness check"*. `OP-10` does
 * perform a listing write, so unlike `OP-6` it has a predicate to guard: the token is compared
 * before any mutation **and** carried into `WHERE last_updated_at = $base`. A zero affected-row
 * count is then a **loud protocol failure** — unreachable under the lock — and never stale input,
 * which the comparison has already ruled out.
 *
 * The token is the **persisted revision's own** captured base. The caller supplies neither it nor
 * a revision identifier; it is never recaptured, refreshed or replaced.
 *
 * **What a test can and cannot prove about that predicate, stated honestly.** It is proven
 * *correct and satisfiable*: were it malformed — a bound number against a `timestamptz`, say, or
 * a value that did not match — the update would affect zero rows and **every** success case in
 * `revision-approval.integration.test.ts` would fail as a guarded-write protocol failure
 * instead. What cannot be proven is that **removing** it changes any outcome: with the listing
 * row locked and the comparison already passed, `last_updated_at` cannot differ from the token
 * by the time the update runs. Removing the predicate therefore fails no test, which was
 * verified rather than assumed.
 *
 * That is not a gap in the suite but a property `ADR-024` itself asserts — it marks the zero-row
 * case *"unreachable under the lock"* — so a test able to reach it would contradict the ADR. The
 * predicate stays because the ADR requires it and because it is the one check that would survive
 * a future unit weakening or reordering the lock; its redundancy under the current protocol is
 * the reason it is defence in depth rather than the mechanism.
 *
 * ## Identity stays inside this function
 *
 * The revision's physical `id` is read under the lock, used once for the `DELETE`, and discarded.
 * It is not a parameter, not part of the result, and never logged. `DDM-2`'s *"revision identity
 * domain type"* remains open, exactly as `ADR-019` requires — and `ADR-024`'s own `OP-10`
 * sequence is what makes that possible, by addressing the revision through `listing_id` and the
 * *pending* state and re-reading its identifier internally.
 *
 * ## Failure vocabulary
 *
 * `ADR-024`'s seven kinds must not collapse into one another, and `listing-repository.ts`'s
 * discipline is reused rather than re-derived. One classification is `ADR-024`'s to make, and it
 * is followed as written: for the `DELETE`, **exactly one** row is success, **zero** is
 * `INVALID_LIFECYCLE_STATE` — the revision was no longer pending — and **more than one** is a
 * protocol failure, which a primary key makes unreachable.
 *
 * Two members stay unreachable, as in `OP-6`, and are documented rather than implemented as dead
 * branches: **exhausted retry**, because `ADR-024` authorizes no automatic retry and nothing here
 * retries, and the `40001`/`40P01` classification is defensive only.
 */

import type { Kysely, Transaction } from "kysely";

import { instantEquals, instantOf, isInstant, type Instant } from "../domain/listing/instant";
import type { Listing } from "../domain/listing/listing";
import type { ListingId } from "../domain/listing/listing-id";
import type { DomainError } from "../domain/listing/result";
import { err, ok, type Result } from "../domain/listing/result";
import { approvePendingRevision } from "../domain/listing/revision";
import { hydrateListing, serializeAppliedListingContent } from "./listing-mapping";
import type { ListingHydrationFailure } from "./listing-mapping";
import { hydratePendingRevision, type RevisionHydrationFailure } from "./revision-mapping";
import {
  epochMillisecondsOf,
  identifierTextOf,
  timestamptzFromEpochMilliseconds,
} from "./row-mapping";
import type { ListingDatabase } from "./listing-table";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";
import { constraintOf, sqlStateOf, storageFailure, type StorageFailure } from "./storage-failure";

/** PostgreSQL's integrity classes. Named, because a bare code is a riddle. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

/** PostgreSQL's serialization-failure and deadlock classes — the only two `ADR-024` admits. */
const RETRYABLE_CONFLICT_STATES: readonly string[] = ["40001", "40P01"];

/**
 * Why an approval could not be applied.
 *
 * Every member is a distinct fact. **Stale input is never conflated** with invalid content, with
 * a lifecycle refusal, or with the `DI-6` advancement failure — `ADR-023` requires all four to
 * stay apart, and three of them are reachable within a few statements of each other here.
 */
export type ApproveAndApplyFailure =
  /** No listing is stored under this identifier; nothing was written. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /** The listing exists but its lifecycle state cannot accept an approval (`FR-ADM-10`). */
  | { readonly code: "LISTING_NOT_APPROVED"; readonly status: string }
  /** The listing has no pending proposal to approve. */
  | { readonly code: "PENDING_REVISION_NOT_FOUND" }
  /** More than one pending revision — unreachable under `DI-11`'s index; reported loudly. */
  | { readonly code: "MULTIPLE_PENDING_REVISIONS"; readonly count: number }
  /** The locked listing row exists but cannot be represented. Never reported as not found. */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /** The pending revision row exists but cannot be represented. */
  | { readonly code: "STORED_REVISION_UNREADABLE"; readonly failure: RevisionHydrationFailure }
  /**
   * `ADR-023` — the proposal's captured base token does not equal the listing's current version.
   *
   * Rolled back; the listing keeps its content and the proposal stays pending. **Never**
   * reported for invalid content, an ineligible lifecycle state or a non-advancing instant.
   */
  | { readonly code: "STALE_LISTING_VERSION" }
  /**
   * The proposal's content does not satisfy the before-approval obligations.
   *
   * Approving invalid content would **publish** it (`docs/09` `OP-10`), so this is a refusal and
   * not a warning. The violations are the domain's own, carried unchanged.
   */
  | { readonly code: "REVISION_CONTENT_INVALID"; readonly error: DomainError }
  /**
   * `DI-6`/`NFR-DATA-05` — the approval instant is not strictly later than `lastUpdatedAt`.
   *
   * A same-millisecond or earlier instant lands here, and `ADR-023` requires it stay **distinct
   * from staleness**: the proposal is perfectly fresh, and the clock reading is what is wrong.
   */
  | { readonly code: "APPROVAL_INSTANT_NOT_LATER" }
  /** Any other governed domain refusal, carried rather than reinterpreted. */
  | { readonly code: "REVISION_APPROVAL_REFUSED"; readonly error: DomainError }
  /** The supplied approval instant is not a usable carrier; refused before any transaction. */
  | { readonly code: "INVALID_APPROVAL_INSTANT" }
  /**
   * The guarded `UPDATE` matched no row, after the lock **and** a successful comparison.
   *
   * `ADR-024` calls this a loud protocol failure and marks it unreachable under the lock. It is
   * never stale input: staleness was already ruled out by the comparison.
   */
  | { readonly code: "GUARDED_UPDATE_PROTOCOL_FAILURE"; readonly detail: string }
  /**
   * The `DELETE` matched no row — `ADR-024` classifies this as an invalid lifecycle state: the
   * revision was no longer pending. Its label is authoritative and is followed here.
   */
  | { readonly code: "INVALID_LIFECYCLE_STATE"; readonly detail: string }
  /** A mutation affected more than one row. Unreachable, and loud. */
  | { readonly code: "MULTI_ROW_PROTOCOL_FAILURE"; readonly detail: string }
  /** An integrity class fired — a fault to surface, never retried. */
  | { readonly code: "INTEGRITY_CONFLICT"; readonly sqlState: string; readonly constraint?: string }
  /** `40001`/`40P01` — **classified, never retried**. */
  | { readonly code: "RETRYABLE_CONFLICT"; readonly sqlState: string }
  /** A stored instant was refused by the governed parser (`ADR-022`, issue #173). */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  | StorageFailure;

/**
 * A refusal raised from inside the transaction so that it **rolls back**.
 *
 * Kysely commits when its callback returns and rolls back only when it throws, so returning a
 * failure value would leave the transaction committed — and here that would be far worse than in
 * `OP-6`, because by the time some refusals are reached the listing has already been updated.
 * `ADR-017` Q-3's atomicity depends on the rollback being real.
 *
 * It never escapes this module.
 */
class ApprovalRefused extends Error {
  constructor(readonly failure: ApproveAndApplyFailure) {
    super("the approval was refused");
    this.name = "ApprovalRefused";
  }
}

/**
 * Translate a domain refusal into this boundary's vocabulary, **preserving the distinctions**.
 *
 * `INSTANT_NOT_STRICTLY_LATER` becomes its own code rather than being folded into a generic
 * refusal, because `ADR-023` names it as a carried interpretation that must not be mislabelled.
 * `REVISION_CONTENT_INVALID` likewise: approving invalid content would publish it, and a caller
 * needs to tell that from a clock problem. Everything else is carried as itself.
 */
function approvalFailureFrom(error: DomainError): ApproveAndApplyFailure {
  const code = (error as { readonly code?: unknown }).code;

  if (code === "INSTANT_NOT_STRICTLY_LATER") {
    return { code: "APPROVAL_INSTANT_NOT_LATER" } as const;
  }

  if (code === "REVISION_CONTENT_INVALID") {
    return { code: "REVISION_CONTENT_INVALID", error } as const;
  }

  if (code === "LISTING_NOT_APPROVED") {
    const status = (error as { readonly status?: unknown }).status;

    return {
      code: "LISTING_NOT_APPROVED",
      status: typeof status === "string" ? status : "unknown",
    } as const;
  }

  if (code === "PENDING_REVISION_NOT_FOUND") {
    return { code: "PENDING_REVISION_NOT_FOUND" } as const;
  }

  if (code === "MULTIPLE_PENDING_REVISIONS") {
    const count = (error as { readonly count?: unknown }).count;

    return {
      code: "MULTIPLE_PENDING_REVISIONS",
      count: typeof count === "number" ? count : 2,
    } as const;
  }

  return { code: "REVISION_APPROVAL_REFUSED", error } as const;
}

/** `ADR-024` step 1 — the `PS-11` lock, taken first and held through commit. */
async function lockListingRow(
  trx: Transaction<ListingDatabase>,
  listingId: string,
) {
  // `selectAll`, not three columns: the domain's approval operation requires the **complete**
  // readable aggregate — status, content, publication state and every timestamp — and handing it
  // a partial listing would make it refuse a listing that is perfectly valid.
  return await trx
    .selectFrom("listing")
    .selectAll()
    .where("id", "=", listingId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Approve the listing's sole pending revision and apply it, as one atomic unit (`OP-10`).
 *
 * `approvedAt` is supplied by the **application**: `ADR-022` forbids consulting a clock at the
 * `C9` boundary and `ADR-019` records that the application supplies every instant, so a default
 * here would fabricate a moment nobody observed.
 *
 * The caller supplies **neither** a revision identifier **nor** a base token. The proposal is
 * named by `DI-11` — an approved listing has at most one pending revision — and its captured base
 * token comes from the persisted row.
 *
 * Returns the **applied listing**: the proposal's content, the advanced `lastUpdatedAt`, and the
 * unchanged identity, status, `submittedAt` and publication state. That value is the confirmation
 * of the resulting state `FR-CONF-04` asks for, and it is the domain's own result rather than a
 * re-read, so it cannot disagree with what was committed.
 */
export async function approveAndApplyPendingRevision(
  db: Kysely<ListingDatabase>,
  request: { readonly listingId: ListingId; readonly approvedAt: Instant },
): Promise<Result<Listing, ApproveAndApplyFailure>> {
  const { listingId, approvedAt } = request;

  // Refused before a transaction is opened, so a caller error never takes a lock. The domain
  // would also refuse it, but a malformed carrier should not reach SQL as `NaN` on the way.
  if (!isInstant(approvedAt)) {
    return err({ code: "INVALID_APPROVAL_INSTANT" } as const);
  }

  const listingText = identifierTextOf(listingId);

  try {
    const applied = await db
      .transaction()
      // `ADR-024`: set explicitly per transaction, never inherited from a server default.
      .setIsolationLevel("read committed")
      .execute(async (trx) => {
        // (1) The `PS-11` lock. FIRST, before any other database state is read, held to commit.
        const listingRow = await lockListingRow(trx, listingText);

        // (2) The listing must exist.
        if (listingRow === undefined) {
          throw new ApprovalRefused({ code: "LISTING_NOT_FOUND" } as const);
        }

        // (3) …and be representable. A row that exists but cannot be read is a different, louder
        // problem than one that is absent, and the domain cannot be asked about it.
        const listing = hydrateListing(listingRow);

        if (!listing.ok) {
          throw new ApprovalRefused({
            code: "STORED_LISTING_UNREADABLE",
            failure: listing.error,
          } as const);
        }

        // (4) The lifecycle check, decided from the locked row. The domain enforces it too; this
        // reports it before a revision read that would be pointless.
        if (listingRow.status !== "approved") {
          throw new ApprovalRefused({
            code: "LISTING_NOT_APPROVED",
            status: listingRow.status,
          } as const);
        }

        // (5) The post-lock read, itself locked. A fresh statement snapshot under
        // `READ COMMITTED`, so it observes a preceding participant's committed revision even
        // when that participant only **locked** the listing row — `PS-11`'s visibility
        // requirement, met rather than assumed.
        const revisionRows = await trx
          .selectFrom("listing_revision")
          .selectAll()
          .where("listing_id", "=", listingText)
          .where("state", "=", "pending")
          .forUpdate()
          .execute();

        // (6) There must be exactly one proposal to approve.
        if (revisionRows.length === 0) {
          throw new ApprovalRefused({ code: "PENDING_REVISION_NOT_FOUND" } as const);
        }

        // (7) `DI-11`'s index makes this unreachable. Reported rather than resolved: choosing
        // between two proposals would need an ordering the domain deliberately does not have.
        if (revisionRows.length > 1) {
          throw new ApprovalRefused({
            code: "MULTIPLE_PENDING_REVISIONS",
            count: revisionRows.length,
          } as const);
        }

        const revisionRow = revisionRows[0] as NonNullable<(typeof revisionRows)[0]>;

        // (8) Hydrate the complete proposal. The physical identifier is kept **here**, in a
        // local, for the `DELETE` alone — it is never returned, parameterised or logged.
        const revisionId = revisionRow.id;
        const revision = hydratePendingRevision(revisionRow);

        if (!revision.ok) {
          throw new ApprovalRefused({
            code: "STORED_REVISION_UNREADABLE",
            failure: revision.error,
          } as const);
        }

        // (9) The stale check, **before any mutation** (`ADR-023` item 12). The token is the
        // **persisted proposal's own** captured base, compared by exact epoch-millisecond
        // equality against the locked listing's current version — the same `Instant` carrier on
        // both sides, so the comparison cannot drift into different representations.
        const base = revision.value.baseListingLastUpdatedAt;
        const current = instantOf(listingRow.last_updated_at);

        if (!current.ok) {
          throw new ApprovalRefused({
            code: "GUARDED_UPDATE_PROTOCOL_FAILURE",
            detail: "the locked listing's last_updated_at is not a usable instant",
          } as const);
        }

        if (!instantEquals(base, current.value)) {
          // Thrown, so the transaction genuinely rolls back: nothing is written, and the listing
          // and the pending revision are unchanged. Never refreshed, merged or overwritten.
          throw new ApprovalRefused({ code: "STALE_LISTING_VERSION" } as const);
        }

        // (10) The existing **pure** domain operation, with the caller's approval instant. It
        // re-runs the before-approval obligations, applies the content, advances `lastUpdatedAt`
        // under `DI-6`, and preserves identity, status, `submittedAt` and the publication state.
        const resolution = approvePendingRevision(
          listing.value,
          [revision.value],
          approvedAt,
        );

        if (!resolution.ok) {
          throw new ApprovalRefused(approvalFailureFrom(resolution.error));
        }

        // The domain removes the approved proposal from the collection; `ADR-017` Q-3 says no
        // approved revision row persists, so the collection it returns must be empty here.
        if (resolution.value.revisions.length !== 0) {
          throw new ApprovalRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "the domain returned a surviving revision for an approved proposal",
          } as const);
        }

        // (11) The guarded update — the **original** persisted token in the predicate, never a
        // refreshed one, and only the columns the domain actually changed.
        const update = await trx
          .updateTable("listing")
          .set(serializeAppliedListingContent(resolution.value.listing))
          .where("id", "=", listingText)
          // The token as a `timestamptz`, through the **same** expression the insert and the
          // `base_listing_last_updated_at` column use. A bound number would be no comparison at
          // all here: PostgreSQL cannot compare `timestamptz` to `bigint`, so the predicate
          // would raise `42883` rather than quietly match nothing — but it also must stay exact
          // to the millisecond, which is what sharing the conversion guarantees.
          .where("last_updated_at", "=", timestamptzFromEpochMilliseconds(epochMillisecondsOf(base)))
          .executeTakeFirst();

        const updatedRows = Number(update.numUpdatedRows);

        // (12) Exactly one row. Zero — after the lock and a successful comparison — is a loud
        // protocol failure and never staleness, which the comparison already ruled out.
        if (updatedRows === 0) {
          throw new ApprovalRefused({
            code: "GUARDED_UPDATE_PROTOCOL_FAILURE",
            detail: "the guarded listing update matched no row under the lock",
          } as const);
        }

        if (updatedRows > 1) {
          throw new ApprovalRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "the guarded listing update matched more than one row",
          } as const);
        }

        // (13) Remove the applied proposal, by its adapter-private identifier, with the listing
        // and the pending state as defence in depth: both are implied by the locked read, and
        // both make a wrong-row delete impossible even under a later bug.
        const deletion = await trx
          .deleteFrom("listing_revision")
          .where("id", "=", revisionId)
          .where("listing_id", "=", listingText)
          .where("state", "=", "pending")
          .executeTakeFirst();

        const deletedRows = Number(deletion.numDeletedRows);

        // (14) `ADR-024`'s classification, followed as written: zero deleted rows means the
        // revision was no longer pending, which is an **invalid lifecycle state** rather than a
        // protocol failure. The listing update above is rolled back with it.
        if (deletedRows === 0) {
          throw new ApprovalRefused({
            code: "INVALID_LIFECYCLE_STATE",
            detail: "the applied revision was no longer pending when it was removed",
          } as const);
        }

        if (deletedRows > 1) {
          throw new ApprovalRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "removing the applied revision matched more than one row",
          } as const);
        }

        // (15) Commit, atomically. The applied listing is the domain's own value.
        return resolution.value.listing;
      });

    return ok(applied);
  } catch (cause) {
    // A governed refusal: raised inside the transaction so that it rolled back, and carried out
    // here so the caller receives it as an ordinary `Result` rather than an exception.
    if (cause instanceof ApprovalRefused) {
      return err(cause.failure);
    }

    // A governed instant the parser refused is not an infrastructure failure: the query ran.
    if (cause instanceof TimestamptzParseError) {
      return err({ code: "STORED_INSTANT_UNREADABLE", reason: cause.reason } as const);
    }

    const sqlState = sqlStateOf(cause);

    if (
      sqlState === UNIQUE_VIOLATION ||
      sqlState === CHECK_VIOLATION ||
      sqlState === FOREIGN_KEY_VIOLATION
    ) {
      const constraint = constraintOf(cause);

      // Surfaced as the fault it is, never retried (`ADR-024` classifies all three as
      // non-retryable). The constraint **name** is schema metadata; its contents never appear.
      return err(
        constraint === undefined
          ? ({ code: "INTEGRITY_CONFLICT", sqlState } as const)
          : ({ code: "INTEGRITY_CONFLICT", sqlState, constraint } as const),
      );
    }

    if (sqlState !== undefined && RETRYABLE_CONFLICT_STATES.includes(sqlState)) {
      // Classified defensively, because the server decides which `SQLSTATE` it raises.
      // Classification is **not** a licence to retry, and nothing here retries.
      return err({ code: "RETRYABLE_CONFLICT", sqlState } as const);
    }

    // Anything else — a dead connection, an unrecognised driver error — stays unexpected.
    return err(storageFailure(cause));
  }
}
