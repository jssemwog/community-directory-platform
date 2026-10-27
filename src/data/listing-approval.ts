/**
 * `C9` — approve a **pending** listing submission and persist the approval (`OP-7`, issue #242).
 *
 * One function over a Kysely instance, the shape the sibling write paths established. It is the
 * second `C9` path to change a listing's **status** after `OP-8`, and the first to write
 * `publication_state`: `ADR-017` `DDM-9` has initial approval set *approved* and *publicly
 * available* together, and `listing_publication_state_check` requires both or neither.
 *
 * ## The authority this module implements
 *
 * `docs/09` `OP-7`, under **`ADR-027`** — nothing here is decided afresh:
 *
 * 1. **Preflight (PF-A)**, before any transaction, read or lock: a missing or malformed
 *    viewed-version token is **stale**; only then is the approval instant checked.
 * 2. `READ COMMITTED`, set explicitly on the transaction (R-1).
 * 3. The listing row locked with `SELECT … FOR UPDATE` as the first state read, before any domain
 *    evaluation, held to commit or rollback (R-2).
 * 4. Under the lock: missing, then unreadable; then **lifecycle before token comparison**, so an
 *    already-approved or rejected source is reported as such, never as stale (R-5, R-7).
 * 5. The caller's **original** token compared with the locked `last_updated_at` by exact
 *    epoch-millisecond equality; never recaptured (R-4).
 * 6. The merged pure-domain `approvePendingListing` (#238): content validation, then timestamp
 *    advancement — so stale is decided before content, and a non-advancing instant is never stale.
 * 7. **One** guarded `UPDATE` of `status`, `publication_state` and `last_updated_at`, with
 *    identity, pending-status and original-token predicates (R-6). No content or designation
 *    column is written, so every visibility designation is preserved (R-12).
 * 8. No automatic retry; `40001`/`40P01` are classified and surfaced (R-3).
 *
 * ## The already-approved case
 *
 * Persistence returns `LISTING_NOT_PENDING { status: "approved" }` and writes nothing. The
 * `docs/09` **current-state no-op** for that case belongs to the future authenticated `OP-7`
 * operation boundary (`ADR-027` R-8). It is **not implemented or satisfied here**, and nothing here
 * authorizes the caller.
 *
 * ## Why the write is a local parameterized statement
 *
 * `status` and `publication_state` are update-`never` in `listing-table.ts`, deliberately, so
 * that no other path can write them. As in `OP-8`, the `UPDATE` is one local statement built with
 * Kysely's `sql` template; every value, including both instants, is a bound parameter.
 *
 * ## What a failure means for stored data
 *
 * A refusal decided before the `UPDATE` writes nothing and rolls back. A failure **of** the
 * `UPDATE` fails that one statement. A database error at `COMMIT` means it did not commit — but a
 * connection lost **during** `COMMIT` can leave the outcome unknown: the resulting
 * `StorageFailure` does not prove that nothing was written, and a later read shows only the
 * then-current state, not which invocation committed (`ADR-027` *Commit and error limitations*).
 */

import { sql, type Kysely, type Transaction } from "kysely";

import { approvePendingListing } from "../domain/listing/approval";
import { instantEquals, isInstant, type Instant } from "../domain/listing/instant";
import type { Listing } from "../domain/listing/listing";
import type { ListingId } from "../domain/listing/listing-id";
import { err, ok, type DomainError, type Result } from "../domain/listing/result";
import type { ValidationViolation } from "../domain/listing/validation";
import { hydrateListing, type ListingHydrationFailure } from "./listing-mapping";
import type { ListingDatabase } from "./listing-table";
import {
  epochMillisecondsOf,
  identifierTextOf,
  timestamptzFromEpochMilliseconds,
} from "./row-mapping";
import { constraintOf, sqlStateOf, storageFailure, type StorageFailure } from "./storage-failure";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";

/** `unique_violation`, `check_violation`, `foreign_key_violation` — integrity, never retried. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

/** `ADR-024` item 13's two retryable classes — classified, and nothing here retries. */
const RETRYABLE_CONFLICT_STATES: readonly string[] = ["40001", "40P01"];

/** The two governed statuses this path reads and writes, bound as parameters. */
const PENDING_STATUS = "pending";
const APPROVED_STATUS = "approved";

/**
 * Every way `persistListingApproval` can fail, kept apart as `ADR-024` items 17–18 require.
 *
 * **`EXHAUSTED_RETRY` is absent**: nothing here retries.
 */
export type PersistListingApprovalFailure =
  /** `ADR-027` R-4 / PF-A — a missing, malformed or unequal viewed-version token. */
  | { readonly code: "STALE_LISTING_VERSION" }
  /** The approval instant is not a usable moment. Refused before a transaction is opened. */
  | { readonly code: "INVALID_APPROVAL_INSTANT" }
  /** No listing is stored under this identifier. Nothing was written. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /** The locked row exists but cannot be represented. **Never** reported as not found. */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /**
   * `FR-ADM-06`/`NFR-DATA-02` — the listing is not *pending*. `status: "approved"` is the
   * already-approved refusal (`ADR-027` R-7); nothing was written.
   */
  | { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  /** `FR-ADM-06`/`FR-VAL-05` — the before-approval obligations, carried unchanged. */
  | {
      readonly code: "LISTING_CONTENT_INVALID";
      readonly violations: readonly ValidationViolation[];
    }
  /** `DI-6`/`NFR-DATA-05` — a usable instant that does not advance `lastUpdatedAt`. Not stale. */
  | { readonly code: "APPROVAL_INSTANT_NOT_LATER" }
  /** Any remaining domain refusal, carried intact rather than restated in a second vocabulary. */
  | { readonly code: "LISTING_APPROVAL_REFUSED"; readonly error: DomainError }
  /** `ADR-024` item 8 — the guarded `UPDATE` matched no row under the lock. Nothing written. */
  | { readonly code: "GUARDED_UPDATE_PROTOCOL_FAILURE"; readonly detail: string }
  /** More than one row matched a primary-key guard. Unreachable; rolled back. */
  | { readonly code: "MULTI_ROW_PROTOCOL_FAILURE"; readonly detail: string }
  /** An integrity class fired — a fault to surface, never retried. */
  | { readonly code: "INTEGRITY_CONFLICT"; readonly sqlState: string; readonly constraint?: string }
  /** `40001`/`40P01` — classified, **not** retried (`ADR-027` R-3). */
  | { readonly code: "RETRYABLE_CONFLICT"; readonly sqlState: string }
  /** A stored `timestamptz` the governed parser refused. The query ran; this is not infra. */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  /** Everything else, including a lost connection — see the module header on `COMMIT`. */
  | StorageFailure;

/** A governed refusal, thrown so the transaction rolls back and carried out as a `Result`. */
class ListingApprovalRefused extends Error {
  constructor(readonly failure: PersistListingApprovalFailure) {
    super("the listing approval was refused");
    this.name = "ListingApprovalRefused";
  }
}

/** `ADR-027` R-2 — the listing lock, the first state read, held through commit. */
async function lockListingRow(trx: Transaction<ListingDatabase>, listingId: string) {
  return await trx
    .selectFrom("listing")
    .selectAll()
    .where("id", "=", listingId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Approve one pending listing (`OP-7`), under `ADR-027`.
 *
 * The caller supplies the listing's identity, the `lastUpdatedAt` it **originally viewed**, and
 * the approval instant — nothing else: no `Listing`, role, actor, note, retry count, transaction or
 * clock. Returns the **domain's own** approved `Listing`, not a re-read.
 */
export async function persistListingApproval(
  db: Kysely<ListingDatabase>,
  request: {
    readonly listingId: ListingId;
    readonly viewedLastUpdatedAt: Instant;
    readonly approvedAt: Instant;
  },
): Promise<Result<Listing, PersistListingApprovalFailure>> {
  const { listingId, viewedLastUpdatedAt, approvedAt } = request;

  // PF-A (1): a missing or malformed token is stale, before any transaction, read or lock.
  if (!isInstant(viewedLastUpdatedAt)) {
    return err({ code: "STALE_LISTING_VERSION" } as const);
  }

  // PF-A (2): only then is the approval instant checked, still before any round trip.
  if (!isInstant(approvedAt)) {
    return err({ code: "INVALID_APPROVAL_INSTANT" } as const);
  }

  const listingText = identifierTextOf(listingId);

  try {
    const approved = await db
      .transaction()
      // R-1: set explicitly per transaction, never inherited from a server default.
      .setIsolationLevel("read committed")
      .execute(async (trx) => {
        // (1) The lock. FIRST, before any other database state is read, held to commit.
        const listingRow = await lockListingRow(trx, listingText);

        // (2) The listing must exist.
        if (listingRow === undefined) {
          throw new ListingApprovalRefused({ code: "LISTING_NOT_FOUND" } as const);
        }

        // (3) …and be representable. Unreadable and absent are different facts.
        const listing = hydrateListing(listingRow);

        if (!listing.ok) {
          throw new ListingApprovalRefused({
            code: "STORED_LISTING_UNREADABLE",
            failure: listing.error,
          } as const);
        }

        // (4) Lifecycle before token comparison (R-5): an already-approved or rejected source is
        // reported as such — never as stale — and nothing is written (R-7).
        if (listing.value.status !== PENDING_STATUS) {
          throw new ListingApprovalRefused({
            code: "LISTING_NOT_PENDING",
            status: listing.value.status,
          } as const);
        }

        // (5) The stale comparison, on the **original** caller token, before any content judgement
        // and before any write (R-4, R-5). Never recaptured from the row being compared.
        if (!instantEquals(viewedLastUpdatedAt, listing.value.timestamps.lastUpdatedAt)) {
          throw new ListingApprovalRefused({ code: "STALE_LISTING_VERSION" } as const);
        }

        // (6) The merged pure-domain approval: content validation, then timestamp advancement.
        const decision = approvePendingListing(listing.value, approvedAt);

        if (!decision.ok) {
          const failure = decision.error;

          if (
            failure.code === "LISTING_CONTENT_INVALID" ||
            failure.code === "LISTING_NOT_PENDING"
          ) {
            throw new ListingApprovalRefused(failure);
          }

          if (failure.code === "INSTANT_NOT_STRICTLY_LATER") {
            throw new ListingApprovalRefused({ code: "APPROVAL_INSTANT_NOT_LATER" } as const);
          }

          throw new ListingApprovalRefused({ code: "LISTING_APPROVAL_REFUSED", error: failure });
        }

        const approvedListing = decision.value;
        const publication = approvedListing.publication;

        // The domain always initializes publication on approval; a value without one is a broken
        // domain contract, reported in the domain's own vocabulary rather than written.
        if (publication === undefined) {
          throw new ListingApprovalRefused({
            code: "LISTING_APPROVAL_REFUSED",
            error: { code: "PUBLICATION_STATE_MISSING" },
          } as const);
        }

        // (7) The one write (R-6). Every value is bound; the original token is in the predicate,
        // through the same `timestamptz` conversion the insert uses, so the comparison is exact.
        const newLastUpdatedAt = timestamptzFromEpochMilliseconds(
          epochMillisecondsOf(approvedListing.timestamps.lastUpdatedAt),
        );
        const viewedVersion = timestamptzFromEpochMilliseconds(
          epochMillisecondsOf(viewedLastUpdatedAt),
        );
        const update = await sql`
          update listing
             set status = ${APPROVED_STATUS},
                 publication_state = ${publication.value},
                 last_updated_at = ${newLastUpdatedAt}
           where id = ${listingText}
             and status = ${PENDING_STATUS}
             and last_updated_at = ${viewedVersion}
        `.execute(trx);

        const updatedRows = update.numAffectedRows;

        // (8) Exactly one row. Zero — after the lock, the lifecycle and the token comparison — is
        // a protocol fault, never staleness. More than one must not commit.
        if (updatedRows === undefined || updatedRows === 0n) {
          throw new ListingApprovalRefused({
            code: "GUARDED_UPDATE_PROTOCOL_FAILURE",
            detail: "the guarded listing approval matched no row under the lock",
          } as const);
        }

        if (updatedRows > 1n) {
          throw new ListingApprovalRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "the guarded listing approval matched more than one row",
          } as const);
        }

        // (9) Commit. The returned listing is the domain's own value, not a re-read.
        return approvedListing;
      });

    return ok(approved);
  } catch (cause) {
    if (cause instanceof ListingApprovalRefused) {
      return err(cause.failure);
    }

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

      return err(
        constraint === undefined
          ? ({ code: "INTEGRITY_CONFLICT", sqlState } as const)
          : ({ code: "INTEGRITY_CONFLICT", sqlState, constraint } as const),
      );
    }

    if (sqlState !== undefined && RETRYABLE_CONFLICT_STATES.includes(sqlState)) {
      // Classification is **not** a licence to retry (R-3).
      return err({ code: "RETRYABLE_CONFLICT", sqlState } as const);
    }

    return err(storageFailure(cause));
  }
}
