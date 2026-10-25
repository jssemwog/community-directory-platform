/**
 * `C9` — reject a **pending** listing submission and persist the rejection (`OP-8`, issue #234).
 *
 * One function over a Kysely instance, exactly as the sibling write paths established. It is the
 * first `C9` path to change a listing's **status**: `listing-table.ts` reserves that column for
 * `OP-7`/`OP-8` and types it `never` on update, so every earlier path is structurally unable to
 * touch it.
 *
 * ## The authority this module implements
 *
 * `docs/09` `OP-8`: a single, atomic status transition that records a write-once rejection
 * timestamp in the same transition (`FR-AUD-06`). Its transaction policy is **`ADR-026`**, and
 * nothing here is decided afresh:
 *
 * 1. `READ COMMITTED`, set explicitly on the transaction, never inherited;
 * 2. the listing row locked with `SELECT … FOR UPDATE` as the first state read, **before any
 *    domain evaluation**, and held to commit or rollback;
 * 3. **no automatic retry** of any failure — `40001`/`40P01` are classified and surfaced;
 * 4. **no viewed-version token** — a pending record that changed after the administrator viewed
 *    it is still rejectable, subject to the domain rules evaluated on the locked row.
 *
 * `OP-8` is **not** one of `ADR-024`'s four governed paths; it follows their lock-first shape
 * under `ADR-026` alone, so there is no stale comparison and no `STALE_LISTING_VERSION` here.
 *
 * ## The domain decides, once, against locked state
 *
 * `transitionListingStatus` is the sole authority on the permitted pair, the strictly-later
 * instant and the write-once anchor. Nothing below re-checks the status first: the domain's own
 * order — status before timestamps — **is** the contract's precedence, so a listing that is not
 * *pending* is reported as `LISTING_NOT_PENDING` even when the instant would not advance either.
 * Parsing (`STORED_INSTANT_UNREADABLE`) and hydration (`STORED_LISTING_UNREADABLE`) are decided
 * earlier, because the domain cannot be asked about a row it cannot represent.
 *
 * ## Why the write is a local parameterized statement
 *
 * `status` and `rejected_at` are update-`never` in `listing-table.ts`, and that is deliberate:
 * widening them there would make every other path able to write a status. So the `UPDATE` is one
 * **local** parameterized statement built with Kysely's `sql` template. The status values and the
 * identifier are bound parameters; both instants go through `timestamptzFromEpochMilliseconds`,
 * whose millisecond count is itself bound. Nothing is interpolated into SQL text, and no shared
 * type is widened.
 *
 * The guard is **identity plus lifecycle** — `id` and `status = 'pending'` — as ruled at this
 * issue's Scope Gate. Under the lock, after the domain has confirmed *pending*, it cannot match
 * zero rows, so zero rows is a loud protocol fault (`ADR-024` item 8's classification), never an
 * ordinary answer.
 *
 * ## What a failure means for stored data
 *
 * - A refusal decided **before** the `UPDATE` writes nothing. It is thrown through the sentinel
 *   below, so the transaction rolls back and releases the lock; an empty commit would be equally
 *   correct, but rollback keeps one shape across the sibling paths.
 * - A failure **of** the `UPDATE` statement — a store `CHECK`, or a `BEFORE`/`AFTER UPDATE`
 *   trigger — fails that one statement; none of its effects survive. That is not a rollback after
 *   an earlier successful statement: this path has no earlier write.
 * - More than one affected row follows a successful write, and is thrown so it rolls back.
 * - A database error reported **at `COMMIT`** is classified like any other and means the
 *   transaction did not commit. **A connection lost during `COMMIT` can leave the outcome
 *   unknown**: the resulting `StorageFailure` does not prove that nothing was written, and a later
 *   read shows only the current state, not which invocation committed it.
 *
 * ## Out of scope
 *
 * No transport, authorization, actor, attribution, moderation note or audit (`ADR-026` must-not
 * list; `S-7`/`S-8`, `FR-ADM-08`, `OQ-14`/`NOQ-8` remain open), and no read or write of
 * `listing_revision`: a pending listing cannot carry a revision.
 */

import { sql, type Kysely, type Transaction } from "kysely";

import { isInstant, type Instant } from "../domain/listing/instant";
import type { Listing } from "../domain/listing/listing";
import type { ListingId } from "../domain/listing/listing-id";
import { err, ok, type DomainError, type Result } from "../domain/listing/result";
import { transitionListingStatus } from "../domain/listing/status";
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
const REJECTED_STATUS = "rejected";

/**
 * Every way `rejectPendingListing` can fail, kept apart as `ADR-024` items 17–18 require.
 *
 * **`EXHAUSTED_RETRY` and `STALE_LISTING_VERSION` are absent**: nothing here retries, and
 * `ADR-026` item 4 rules out a viewed-version token.
 */
export type RejectPendingListingFailure =
  /** The supplied instant is not a usable moment. Refused before a transaction is opened. */
  | { readonly code: "INVALID_REJECTION_INSTANT" }
  /** No listing is stored under this identifier. Nothing was written. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /** The locked row exists but cannot be represented. **Never** reported as not found. */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /** `FR-ADM-07`/`NFR-DATA-02` — the listing is approved or already rejected. */
  | { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  /** `DI-6`/`NFR-DATA-05` — a usable instant that does not advance `lastUpdatedAt`. */
  | { readonly code: "REJECTION_INSTANT_NOT_LATER" }
  /** Any remaining domain refusal, carried intact rather than restated in a second vocabulary. */
  | { readonly code: "LISTING_REJECTION_REFUSED"; readonly error: DomainError }
  /** `ADR-024` item 8 — the guarded `UPDATE` matched no row under the lock. Nothing written. */
  | { readonly code: "GUARDED_UPDATE_PROTOCOL_FAILURE"; readonly detail: string }
  /** More than one row matched a primary-key guard. Unreachable; rolled back. */
  | { readonly code: "MULTI_ROW_PROTOCOL_FAILURE"; readonly detail: string }
  /** An integrity class fired — a fault to surface, never retried. */
  | { readonly code: "INTEGRITY_CONFLICT"; readonly sqlState: string; readonly constraint?: string }
  /** `40001`/`40P01` — classified, **not** retried (`ADR-026` item 3). */
  | { readonly code: "RETRYABLE_CONFLICT"; readonly sqlState: string }
  /** A stored `timestamptz` the governed parser refused. The query ran; this is not infra. */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  /** Everything else, including a lost connection — see the module header on `COMMIT`. */
  | StorageFailure;

/**
 * A governed refusal, thrown so the transaction rolls back and carried out as a `Result`.
 *
 * It never escapes this module.
 */
class ListingRejectionRefused extends Error {
  constructor(readonly failure: RejectPendingListingFailure) {
    super("the listing rejection was refused");
    this.name = "ListingRejectionRefused";
  }
}

/**
 * Translate a domain refusal, keeping the two approved dedicated codes and carrying the rest.
 *
 * `INVALID_INSTANT` is deliberately **carried**, not relabelled as the caller's
 * `INVALID_REJECTION_INSTANT`: the caller's instant was already checked before the transaction,
 * so a domain `INVALID_INSTANT` here could only concern a stored moment.
 */
function rejectionFailureFrom(error: DomainError): RejectPendingListingFailure {
  const code = (error as { readonly code?: unknown }).code;

  if (code === "FORBIDDEN_STATUS_TRANSITION") {
    const from = (error as { readonly from?: unknown }).from;

    return {
      code: "LISTING_NOT_PENDING",
      status: typeof from === "string" ? from : "unknown",
    } as const;
  }

  if (code === "INSTANT_NOT_STRICTLY_LATER") {
    return { code: "REJECTION_INSTANT_NOT_LATER" } as const;
  }

  return { code: "LISTING_REJECTION_REFUSED", error } as const;
}

/** `ADR-026` item 2 — the listing lock, the first state read, held through commit. */
async function lockListingRow(trx: Transaction<ListingDatabase>, listingId: string) {
  return await trx
    .selectFrom("listing")
    .selectAll()
    .where("id", "=", listingId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Reject one pending listing (`OP-8`), under `ADR-026`.
 *
 * The caller supplies the listing's identity and the rejection instant, and nothing else: no
 * `Listing`, token, role, actor, note, retry count, transaction or clock. Returns the **domain's
 * own** rejected `Listing` — `status: "rejected"`, `rejectedAt = lastUpdatedAt = rejectedAt` —
 * not a re-read, so it cannot disagree with what was committed.
 */
export async function rejectPendingListing(
  db: Kysely<ListingDatabase>,
  request: { readonly listingId: ListingId; readonly rejectedAt: Instant },
): Promise<Result<Listing, RejectPendingListingFailure>> {
  const { listingId, rejectedAt } = request;

  // Refused before a transaction is opened, so a caller error takes no lock and makes no round
  // trip. The domain would refuse it too, but only after a locked read it does not need.
  if (!isInstant(rejectedAt)) {
    return err({ code: "INVALID_REJECTION_INSTANT" } as const);
  }

  const listingText = identifierTextOf(listingId);

  try {
    const rejected = await db
      .transaction()
      // `ADR-026` item 1: set explicitly per transaction, never inherited from a server default.
      .setIsolationLevel("read committed")
      .execute(async (trx) => {
        // (1) The lock. FIRST, before any other database state is read, held to commit.
        const listingRow = await lockListingRow(trx, listingText);

        // (2) The listing must exist.
        if (listingRow === undefined) {
          throw new ListingRejectionRefused({ code: "LISTING_NOT_FOUND" } as const);
        }

        // (3) …and be representable. Unreadable and absent are different facts.
        const listing = hydrateListing(listingRow);

        if (!listing.ok) {
          throw new ListingRejectionRefused({
            code: "STORED_LISTING_UNREADABLE",
            failure: listing.error,
          } as const);
        }

        // (4) The domain decides lifecycle and instants, in its own order, on the locked row.
        const transition = transitionListingStatus(listing.value, REJECTED_STATUS, rejectedAt);

        if (!transition.ok) {
          throw new ListingRejectionRefused(rejectionFailureFrom(transition.error));
        }

        const rejectedListing = transition.value;
        const { lastUpdatedAt, rejectedAt: anchor } = rejectedListing.timestamps;

        // The domain always writes the anchor on `pending -> rejected`; a value without one is a
        // broken domain contract, reported in the domain's own vocabulary rather than written.
        if (anchor === undefined) {
          throw new ListingRejectionRefused({
            code: "LISTING_REJECTION_REFUSED",
            error: { code: "REJECTION_TIMESTAMP_MISSING" },
          } as const);
        }

        // (5) The one write: a local parameterized statement (see the module header). Every
        // value is the domain's own, and every value is bound.
        const update = await sql`
          update listing
             set status = ${REJECTED_STATUS},
                 rejected_at = ${timestamptzFromEpochMilliseconds(epochMillisecondsOf(anchor))},
                 last_updated_at = ${timestamptzFromEpochMilliseconds(epochMillisecondsOf(lastUpdatedAt))}
           where id = ${listingText}
             and status = ${PENDING_STATUS}
        `.execute(trx);

        const updatedRows = update.numAffectedRows;

        // (6) Exactly one row. Zero — after the lock and the domain's *pending* — is a protocol
        // fault, never staleness. More than one means a write succeeded and must not commit.
        if (updatedRows === undefined || updatedRows === 0n) {
          throw new ListingRejectionRefused({
            code: "GUARDED_UPDATE_PROTOCOL_FAILURE",
            detail: "the guarded listing rejection matched no row under the lock",
          } as const);
        }

        if (updatedRows > 1n) {
          throw new ListingRejectionRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "the guarded listing rejection matched more than one row",
          } as const);
        }

        // (7) Commit. The returned listing is the domain's own value, not a re-read.
        return rejectedListing;
      });

    return ok(rejected);
  } catch (cause) {
    // A governed refusal: raised inside the transaction so that it rolled back.
    if (cause instanceof ListingRejectionRefused) {
      return err(cause.failure);
    }

    // A governed instant the parser refused is not an infrastructure failure: the query ran.
    if (cause instanceof TimestamptzParseError) {
      return err({ code: "STORED_INSTANT_UNREADABLE", reason: cause.reason } as const);
    }

    // Everything below applies wherever the error arose — the lock, the `UPDATE` or `COMMIT`.
    const sqlState = sqlStateOf(cause);

    if (
      sqlState === UNIQUE_VIOLATION ||
      sqlState === CHECK_VIOLATION ||
      sqlState === FOREIGN_KEY_VIOLATION
    ) {
      const constraint = constraintOf(cause);

      // Surfaced as the fault it is, never retried. The constraint **name** is schema metadata;
      // its contents never appear.
      return err(
        constraint === undefined
          ? ({ code: "INTEGRITY_CONFLICT", sqlState } as const)
          : ({ code: "INTEGRITY_CONFLICT", sqlState, constraint } as const),
      );
    }

    if (sqlState !== undefined && RETRYABLE_CONFLICT_STATES.includes(sqlState)) {
      // Classification is **not** a licence to retry (`ADR-026` item 3).
      return err({ code: "RETRYABLE_CONFLICT", sqlState } as const);
    }

    // Anything else — a dead connection, an unrecognised driver error — reaches the caller
    // through `storageFailure`, whose enumerable surface carries no row values or credentials.
    return err(storageFailure(cause));
  }
}
