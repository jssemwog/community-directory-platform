/**
 * `C9` — reject the listing's sole pending revision and persist the rejection (issue #199).
 *
 * One function over a Kysely instance, exactly as `listing-repository.ts`, `revision-repository.ts`
 * and `revision-approval.ts` established. It is the **third** `ADR-017` `PS-11` revision
 * transaction to be implemented, after `OP-6` (#196) and `OP-10` (#198).
 *
 * ## The one paragraph of authority this module implements
 *
 * `ADR-017`, *Revision storage and the effective public version*, states the whole transaction:
 *
 * > **Rejecting a revision** is one transaction that, under the listing lock (`PS-11`), sets its
 * > state to *rejected* and writes its write-once rejection timestamp (Q-1 ruling); **the listing
 * > row is not written** (`FR-ADM-10`).
 *
 * Every other decision here follows from that sentence plus `ADR-024`'s isolation, lock order,
 * retry classification and failure taxonomy. Nothing is invented, and **no operation identifier
 * is claimed**: `docs/09` records which operation expresses revision rejection as a
 * *"pre-existing question for this document"*, and that question stays open. This module is the
 * persistence unit, not an API surface.
 *
 * ## What makes this path different from `OP-6` and `OP-10`
 *
 * `OP-6` inserted one revision row and touched no listing. `OP-10` performed two mutations that
 * had to stand or fall together. This path performs **one** mutation, of **one** row, on the
 * table the listing lock does not even protect directly — and that unusual shape is the source of
 * every rule below.
 *
 * **It is deliberately *not* a fourth stale-token guarded-listing-write path.** `ADR-024` items
 * 6–8 bind the stale comparison to the moment *"before any mutation"* of the listing and carry
 * the captured token in *"the **guarded listing-write** predicate"*. This transaction writes no
 * listing row, so it has no such predicate and no listing mutation to gate. `ADR-024` item 6 says
 * where staleness lives in as many words — *"`OP-10` remains where a *revision* is stale"* — and
 * `ADR-023`'s ruling defines it the same way, *"a revision is stale at `OP-10`"*.
 *
 * So this module performs, and must keep performing, **none** of the following:
 *
 * - no base-token comparison;
 * - no `UPDATE listing` of any kind;
 * - no `lastUpdatedAt` advancement;
 * - no stale-input result (`STALE_LISTING_VERSION` is absent from the taxonomy below);
 * - no `DI-6` result — the pure `rejectPendingRevision` returns a revision collection and is
 *   given no means to produce a listing, so the advancement rule is not merely unused here, it is
 *   unreachable.
 *
 * **A stale proposal is therefore rejectable, and that is the correct behaviour rather than a
 * gap.** It is also the only escape it has: a stale proposal can never be approved
 * (`STALE_LISTING_VERSION`), so refusing to reject it would leave it unresolvable and holding the
 * listing's single `DI-11` pending slot for ever — which `FR-ADM-10b`'s ruled refusal, *"the
 * existing revision must first be approved or rejected"*, assumes is escapable. The integration
 * suite asserts the success, not merely the absence of a comparison.
 *
 * ## The listing lock is mandatory even though no listing row is written
 *
 * This is the one rule a reasonable reader would be tempted to optimise away, so it is argued
 * rather than stated. `PS-11` scopes itself to *"every revision-creating, approving, **rejecting**
 * and atomic transaction"*, and `ADR-017` names *"a participating path skips the listing lock"* as
 * a defect mode in its own right. Concretely, the lock is what makes `ADR-024`'s ruled
 * serialization true:
 *
 * > **approve vs reject** | Serialized. The loser finds nothing pending and reports **invalid
 * > lifecycle state** — never stale input, because its token was never the problem.
 *
 * Without the listing lock, an approval and a rejection would contend only on the revision row,
 * and the approval's *read* of the listing would no longer be ordered against the rejection at
 * all. The lock is taken **first**, before any pending check or revision read, and held through
 * commit. A deterministic interleaving test proves a rejection blocks on a foreign listing lock
 * before it reads any revision state, so the ordering cannot be quietly reversed.
 *
 * ## Update in place, and the identifier that stays here
 *
 * `ADR-017` says *"sets its state"* — the row is **updated in place**, never replaced. Same
 * primary key, same `listing_id`, same proposed content, same designations, same category, and
 * the **same captured base token**, which `ADR-023` forbids refreshing. `listing-table.ts`
 * enforces that structurally: only `state` and `rejected_at` are updatable at all.
 *
 * The row's physical `id` is read into a local and used **only** in the guarded `UPDATE`'s
 * predicate. It is never returned, never logged, and never reaches the domain — `DDM-2`'s
 * revision-identity question stays open, exactly as `ADR-019` requires. The proposal is addressed
 * by `listing_id` under `DI-11`, which is why the caller supplies no revision identifier.
 *
 * ## Why the success value is the rejected revision
 *
 * `rejectedAt` is the **retention anchor** `OQ-13` measures its 90 days from (`FR-AUD-06`), and
 * returning the domain's own rejected revision is the only way a caller observes it without a
 * read path that does not exist yet — rejected-revision retrieval is a separate unit and is not
 * implemented here. It is the domain's value rather than a re-read row, so it cannot disagree
 * with what was committed, and the domain `ListingRevision` type carries **no identity field**,
 * so the value transports no physical UUID.
 */

import type { Kysely, Transaction } from "kysely";

import { isInstant, type Instant } from "../domain/listing/instant";
import type { ListingId } from "../domain/listing/listing-id";
import type { DomainError } from "../domain/listing/result";
import { err, ok, type Result } from "../domain/listing/result";
import type { ListingRevision } from "../domain/listing/revision";
import { rejectPendingRevision as rejectPendingRevisionInDomain } from "../domain/listing/revision";
import { hydrateListing } from "./listing-mapping";
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

/** Integrity classes `ADR-024` item 14 classifies as **non-retryable**. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

/** The **only** two retryable states (`ADR-024` item 13). Classified here; retried nowhere. */
const RETRYABLE_CONFLICT_STATES: readonly string[] = ["40001", "40P01"];

/**
 * Why the sole pending revision could not be rejected.
 *
 * Every member is a distinct fact about the attempt, and **none is softened into another**.
 * `ADR-024` item 17 requires its seven kinds never collapse, and `ADR-023` requires staleness and
 * the `DI-6` advancement failure stay apart from each other and from ordinary refusals.
 *
 * ## The five codes that are deliberately absent
 *
 * Their absence is a governed property of this path, asserted by test, and a later author adding
 * one would be changing the decision rather than fixing an omission:
 *
 * - **no `STALE_LISTING_VERSION`** — staleness is defined at `OP-10` (`ADR-023`; `ADR-024`
 *   item 6), this path makes no comparison, and a stale proposal is rejectable;
 * - **no `DI-6`/instant-advancement code** — no listing timestamp is advanced, and the pure
 *   domain operation cannot reach the rule;
 * - **no content-validation code** — a rejected proposal is never validated (`FR-VAL-04`:
 *   *"Rejection or failed validation leaves the currently approved listing unchanged"*);
 * - **no guarded-listing-update failure** — there is no listing write to guard;
 * - **no exhausted-retry code** — `ADR-024` item 12 authorizes no automatic retry, and nothing
 *   here retries.
 *
 * ## One documented deviation from the issue's table
 *
 * Issue #199 listed a single `REJECTION_PROTOCOL_FAILURE` for a guarded-update row count other
 * than one. That is **split** here, on `ADR-024`'s own classification and `OP-10`'s precedent: a
 * **zero**-row revision mutation means the row was no longer pending, which `ADR-024` labels an
 * **invalid lifecycle state** (`INVALID_LIFECYCLE_STATE`), while **more than one** is a genuine
 * invariant breach (`MULTI_ROW_PROTOCOL_FAILURE`). `INTEGRITY_CONFLICT` is likewise its own
 * member rather than folded into `MULTIPLE_PENDING_REVISIONS`, matching `revision-approval.ts`.
 * The split adds distinctions; it removes none of the issue's members.
 */
export type RejectPendingRevisionFailure =
  /**
   * The supplied rejection instant is not a usable carrier; refused **before any transaction**.
   *
   * So a caller error never takes a lock. The domain would also refuse it, but a malformed
   * carrier should not reach SQL as `NaN` on the way.
   */
  | { readonly code: "INVALID_REJECTION_INSTANT" }
  /** No listing is stored under this identifier; nothing was written. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /** The locked listing row exists but cannot be represented. **Never** reported as not found. */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /** The listing exists but its lifecycle state cannot carry a pending revision (`FR-ADM-10`). */
  | { readonly code: "LISTING_NOT_APPROVED"; readonly status: string }
  /** The listing has no pending proposal to reject. An ordinary answer, not a fault. */
  | { readonly code: "PENDING_REVISION_NOT_FOUND" }
  /** More than one pending revision — unreachable under `DI-11`'s index; reported loudly. */
  | { readonly code: "MULTIPLE_PENDING_REVISIONS"; readonly count: number }
  /** The pending revision row exists but cannot be represented. */
  | { readonly code: "STORED_REVISION_UNREADABLE"; readonly failure: RevisionHydrationFailure }
  /**
   * A governed domain refusal, carried rather than reinterpreted.
   *
   * This is where `REJECTION_TIMESTAMP_ALREADY_SET` (the write-once anchor, refused rather than
   * repaired) and `REVISION_LISTING_MISMATCH` arrive, with the domain's own error attached.
   */
  | { readonly code: "REVISION_REJECTION_REFUSED"; readonly error: DomainError }
  /**
   * The guarded `UPDATE` matched **no** row, after the lock was held.
   *
   * `ADR-024`'s classification, followed as written: the revision was no longer pending, or
   * already carried an anchor — an **invalid lifecycle state**. It is **never stale input**,
   * because no token was ever compared on this path.
   */
  | { readonly code: "INVALID_LIFECYCLE_STATE"; readonly detail: string }
  /** A mutation affected more than one row. Unreachable under the lock and the primary key. */
  | { readonly code: "MULTI_ROW_PROTOCOL_FAILURE"; readonly detail: string }
  /**
   * The protocol reached a state it proves cannot happen.
   *
   * `ADR-024` requires a protocol violation be **loud** rather than absorbed into an ordinary
   * outcome. Reachable only if the lock, the statement order, the schema or the domain's own
   * contract is not what this module requires — exactly when silence would cost most.
   */
  | { readonly code: "REJECTION_PROTOCOL_FAILURE"; readonly detail: string }
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
 * failure value out of the callback would leave the transaction **committed** — and on this path
 * that would commit a listing lock's worth of work and, past the guarded update, a rejection the
 * caller was told had failed. A mutation test removes the throw and proves the rollback is real.
 *
 * It never escapes this module.
 */
class RejectionRefused extends Error {
  constructor(readonly failure: RejectPendingRevisionFailure) {
    super("the rejection was refused");
    this.name = "RejectionRefused";
  }
}

/**
 * Translate a domain refusal into this boundary's vocabulary, **preserving the distinctions**.
 *
 * The three refusals a caller can act on differently — the listing's lifecycle, an absent
 * proposal, and `DI-11`'s broken invariant — keep their own codes; everything else is carried as
 * itself with the domain error attached, including the write-once anchor conflict. Nothing is
 * reinterpreted, and in particular nothing is mapped to a staleness or advancement code, neither
 * of which exists on this path.
 */
function rejectionFailureFrom(error: DomainError): RejectPendingRevisionFailure {
  const code = (error as { readonly code?: unknown }).code;

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

  return { code: "REVISION_REJECTION_REFUSED", error } as const;
}

/**
 * `ADR-024` step 1 — the `PS-11` lock, taken **first** and held through commit.
 *
 * `selectAll`, not three columns: the domain's rejection operation requires the **complete**
 * readable aggregate, and handing it a partial listing would make it refuse one that is valid.
 * Identical to `revision-approval.ts`'s helper on purpose — one protocol, not two shapes.
 */
async function lockListingRow(trx: Transaction<ListingDatabase>, listingId: string) {
  return await trx
    .selectFrom("listing")
    .selectAll()
    .where("id", "=", listingId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Reject the listing's sole pending revision, persisting the rejection as one transaction.
 *
 * `rejectedAt` is supplied by the **application**: `ADR-022` forbids consulting a clock at the
 * `C9` boundary and `ADR-019` records that the application supplies every instant, so a default
 * here would fabricate a moment nobody observed. It is written **exactly** as supplied — never
 * normalized, rounded, re-read or turned into a `Date`.
 *
 * The caller supplies **neither** a revision identifier **nor** a base token. The proposal is
 * named by `DI-11`, and no token is compared on this path at all.
 *
 * **No rejection reason is accepted.** `FR-ADM-08` is a `Should`, `listing_revision` has no
 * reason column, and persisting one would need a migration — out of scope here, and the pure
 * domain operation takes no reason either.
 *
 * Returns the **rejected revision**: `state: "rejected"`, the exact `rejectedAt`, and the
 * unchanged `proposedContent` and `baseListingLastUpdatedAt`.
 */
export async function rejectPendingRevision(
  db: Kysely<ListingDatabase>,
  request: { readonly listingId: ListingId; readonly rejectedAt: Instant },
): Promise<Result<ListingRevision, RejectPendingRevisionFailure>> {
  const { listingId, rejectedAt } = request;

  // Refused before a transaction is opened, so a caller error never takes a lock. The domain
  // would also refuse it, but a malformed carrier should not reach SQL as `NaN` on the way.
  if (!isInstant(rejectedAt)) {
    return err({ code: "INVALID_REJECTION_INSTANT" } as const);
  }

  const listingText = identifierTextOf(listingId);

  try {
    const rejected = await db
      .transaction()
      // `ADR-024` item 1: set explicitly per transaction, never inherited from a server default.
      .setIsolationLevel("read committed")
      .execute(async (trx) => {
        // (1) The `PS-11` lock. FIRST, before any other database state is read, held to commit.
        // Mandatory even though no listing row is written — see the module header.
        const listingRow = await lockListingRow(trx, listingText);

        // (2) The listing must exist.
        if (listingRow === undefined) {
          throw new RejectionRefused({ code: "LISTING_NOT_FOUND" } as const);
        }

        // (3) …and be representable. A row that exists but cannot be read is a different, louder
        // problem than one that is absent, and the domain cannot be asked about it.
        const listing = hydrateListing(listingRow);

        if (!listing.ok) {
          throw new RejectionRefused({
            code: "STORED_LISTING_UNREADABLE",
            failure: listing.error,
          } as const);
        }

        // (4) The lifecycle check, decided from the locked row. The domain enforces it too; this
        // reports it before a revision read that would be pointless.
        if (listingRow.status !== "approved") {
          throw new RejectionRefused({
            code: "LISTING_NOT_APPROVED",
            status: listingRow.status,
          } as const);
        }

        // (5) The post-lock read, itself locked. A fresh statement snapshot under
        // `READ COMMITTED`, so it observes a preceding participant's committed revision work —
        // which is what makes the ruled `approve vs reject` serialization observable rather than
        // hoped for. `FOR UPDATE` is load-bearing: it is what a concurrent participant contends
        // on once both hold no listing lock.
        const revisionRows = await trx
          .selectFrom("listing_revision")
          .selectAll()
          .where("listing_id", "=", listingText)
          .where("state", "=", "pending")
          .forUpdate()
          .execute();

        // (6) There must be a proposal to reject. The loser of an approve-versus-reject race
        // arrives **here**, and is reported as a lifecycle fact — never as stale input, because
        // its token was never the problem and no token was compared.
        if (revisionRows.length === 0) {
          throw new RejectionRefused({ code: "PENDING_REVISION_NOT_FOUND" } as const);
        }

        // (7) `DI-11`'s index makes this unreachable. Reported rather than resolved: choosing
        // between two proposals would need an ordering the domain deliberately does not have.
        if (revisionRows.length > 1) {
          throw new RejectionRefused({
            code: "MULTIPLE_PENDING_REVISIONS",
            count: revisionRows.length,
          } as const);
        }

        const revisionRow = revisionRows[0] as NonNullable<(typeof revisionRows)[0]>;

        // (8) Hydrate the complete proposal. The physical identifier is kept **here**, in a
        // local, for the guarded `UPDATE` alone — never returned, never logged, never in the
        // domain. `hydratePendingRevision` refuses a row that already carries an anchor, so the
        // write-once contradiction cannot be hydrated into something that looks ordinary.
        const revisionId = revisionRow.id;
        const revision = hydratePendingRevision(revisionRow);

        if (!revision.ok) {
          throw new RejectionRefused({
            code: "STORED_REVISION_UNREADABLE",
            failure: revision.error,
          } as const);
        }

        // (9) The existing **pure** domain operation, with the caller's instant. No stale
        // comparison precedes it and none follows: this path has no listing mutation to gate.
        const resolved = rejectPendingRevisionInDomain(
          listing.value,
          [revision.value],
          rejectedAt,
        );

        // (10) Domain refusals are preserved exactly, not reinterpreted.
        if (!resolved.ok) {
          throw new RejectionRefused(rejectionFailureFrom(resolved.error));
        }

        // The domain retains the rejected proposal in the collection — it is kept under
        // `FR-AUD-06` until purged — so a single-entry input must come back as a single
        // *rejected* entry. Anything else is the domain's contract broken, and is loud.
        if (resolved.value.length !== 1) {
          throw new RejectionRefused({
            code: "REJECTION_PROTOCOL_FAILURE",
            detail: "the domain returned a collection of unexpected size for one proposal",
          } as const);
        }

        const rejectedRevision = resolved.value[0] as ListingRevision;

        if (rejectedRevision.state !== "rejected" || rejectedRevision.rejectedAt === undefined) {
          throw new RejectionRefused({
            code: "REJECTION_PROTOCOL_FAILURE",
            detail: "the domain returned a proposal that is not rejected",
          } as const);
        }

        // (11) The guarded update, **in place**: only `state` and the anchor are written, and
        // all four guards participate — the adapter-private identifier, the listing (defence in
        // depth against a wrong-row write), the *pending* state and the null anchor. The last
        // two are what make write-once hold in PostgreSQL rather than only in the domain.
        //
        // The anchor is written as a `timestamptz` expression through the **same** conversion
        // every other governed instant uses, so the caller's instant round-trips exact to the
        // millisecond (`ADR-022`). A bound number would have no `timestamptz` meaning at all.
        const update = await trx
          .updateTable("listing_revision")
          .set({
            state: "rejected",
            rejected_at: timestamptzFromEpochMilliseconds(
              epochMillisecondsOf(rejectedRevision.rejectedAt),
            ),
          })
          .where("id", "=", revisionId)
          .where("listing_id", "=", listingText)
          .where("state", "=", "pending")
          .where("rejected_at", "is", null)
          .executeTakeFirst();

        const updatedRows = Number(update.numUpdatedRows);

        // (12) Exactly one row, and the count participates in the correctness check
        // (`ADR-024` item 8's reasoning). Zero means the row was no longer pending or already
        // carried an anchor — `ADR-024` calls that an **invalid lifecycle state**, and it is
        // never stale input. More than one would mean the primary key is not what it claims.
        if (updatedRows === 0) {
          throw new RejectionRefused({
            code: "INVALID_LIFECYCLE_STATE",
            detail: "the rejected revision was no longer pending, or already carried an anchor",
          } as const);
        }

        if (updatedRows > 1) {
          throw new RejectionRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "the guarded revision update matched more than one row",
          } as const);
        }

        // (13) Commit. The listing row was never written on any path through this transaction.
        // The returned value is the domain's own, so it cannot disagree with what was committed.
        return rejectedRevision;
      });

    return ok(rejected);
  } catch (cause) {
    // A governed refusal: raised inside the transaction so that it rolled back, and carried out
    // here so the caller receives it as an ordinary `Result` rather than an exception.
    if (cause instanceof RejectionRefused) {
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

      // Surfaced as the fault it is, never retried (`ADR-024` item 14 classifies all three as
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

    // Anything else — a dead connection, an unrecognised driver error — stays unexpected, and
    // reaches the caller through `storageFailure`, whose enumerable surface carries no row
    // values, credentials, connection details or paths.
    return err(storageFailure(cause));
  }
}
