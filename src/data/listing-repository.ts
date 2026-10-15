/**
 * `C9` — the two listing operations this slice authorizes (issue #177).
 *
 * `ADR-002` `O-1` makes `C9` *"the single data-access path"*. That path begins here, with exactly
 * two functions:
 *
 * - **`insertSubmittedListing`** — persist one already-created, already-validated submission
 *   (`OP-3`).
 * - **`findListingById`** — retrieve one listing by its exact identifier.
 *
 * **There is no repository class and no generic abstraction.** Two functions over a Kysely
 * instance are the whole surface; an interface shaped for operations that do not exist yet would
 * be guessing at callers that do not exist yet. Later units add their own operations.
 *
 * ## What is deliberately absent
 *
 * No update and no delete. No enumeration, filtering, search, public projection or identity
 * transport. No revision query of any kind. And **nothing about staleness**: no version column,
 * no version token, no `lastUpdatedAt` comparison, no optimistic-lock predicate and no
 * stale-edit outcome. `ADR-017` defers *"stale-edit detection and resolution policy, and any
 * supporting version token"* to the units implementing revision creation, approval, the atomic
 * path and pending-record edits — none of which is here. `ADR-022` additionally records that
 * whether `lastUpdatedAt` is ever used as a concurrency token **is itself unruled**, so this
 * module takes no position. **Nothing here solves that future work.**
 *
 * ## No transaction, on purpose
 *
 * Each operation is a **single statement**, atomic by itself, participating in no multi-statement
 * invariant. `ADR-017` `PS-11` serializes *revision* transactions and leaves *"the isolation
 * level for the participating transactions"* to the unit implementing it — so opening a
 * transaction here would be choosing an isolation level nobody has ruled on. `C9` still owns
 * transactions; this slice simply has none to own.
 *
 * ## Failure vocabulary
 *
 * Expected outcomes are `Result` values, in the domain's own convention. The classification is
 * strict, because a boundary that blurs it is worse than one that throws.
 *
 * `StorageFailure` and its classification helpers moved to `storage-failure.ts` under issue #195,
 * unchanged, so the revision repository classifies driver errors identically rather than keeping a
 * second copy of the reasoning — including the non-enumerable `cause` that keeps the driver's
 * row-quoting `detail` out of logs and responses:
 *
 * - **Not found is its own outcome.** It never catches, wraps or masks a SQL error.
 * - **A hydration failure is never reported as not found.** A row that exists but cannot be
 *   represented is a different, louder problem than a row that is absent.
 * - **A duplicate identifier is its own outcome**, neither retried nor treated as success. No
 *   UUID-collision retry policy is selected — `ADR-017` `PS-1` and `ADR-019` make a collision a
 *   defect to surface, not a condition to paper over.
 * - **A refused stored instant is its own outcome.** The governed parser can reject a stored
 *   value (BC era, an offset carrying seconds — issue #173), and that is a readable-data problem,
 *   not an infrastructure one.
 * - **Everything unexpected stays unexpected.** A connection failure, a `CHECK` violation, a
 *   not-null violation or any other driver error becomes `STORAGE_FAILURE` — never not found,
 *   and never a domain validation result.
 */

import type { Kysely } from "kysely";

import type { Listing } from "../domain/listing/listing";
import type { ListingId } from "../domain/listing/listing-id";
import { err, ok, type Result } from "../domain/listing/result";
import { hydrateListing, serializeSubmittedListing } from "./listing-mapping";
import { identifierTextOf } from "./row-mapping";
import {
  constraintOf,
  sqlStateOf,
  storageFailure,
  type StorageFailure,
} from "./storage-failure";
import type { ListingHydrationFailure } from "./listing-mapping";
import type { ListingDatabase } from "./listing-table";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";

/** PostgreSQL's unique-violation class. Named, because a bare code is a riddle. */
const UNIQUE_VIOLATION = "23505";

/**
 * The constraint whose violation means *this identifier is already stored*.
 *
 * Classifying on `23505` alone would be right only by accident of the current schema. `listing`
 * carries exactly one unique constraint today — its primary key — but a later authorized unit
 * could add another (duplicate detection under `VR-S6`/`OQ-12` is an open question), and a name
 * collision reported as `LISTING_ALREADY_EXISTS` would be a confidently wrong answer. Requiring
 * the constraint as well means any other unique violation falls through to `STORAGE_FAILURE`,
 * where an unrecognised failure belongs.
 */
const LISTING_IDENTITY_CONSTRAINT = "listing_pkey";

export type InsertListingFailure =
  /** A listing with this identifier already exists; nothing was written. */
  | { readonly code: "LISTING_ALREADY_EXISTS" }
  | StorageFailure;

export type FindListingFailure =
  /** No listing is stored under this identifier. An ordinary answer, not an error condition. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /** The row exists but cannot be represented as a listing. Never reported as not found. */
  | { readonly code: "LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /**
   * A stored instant was refused by the governed parser (`ADR-022`, issue #173).
   *
   * Its own outcome rather than a `STORAGE_FAILURE`, because the database is perfectly healthy:
   * the row exists and a *stored value* is unreadable. It is distinguished from
   * `LISTING_UNREADABLE` because the refusal happens inside the driver while the row is being
   * read, before hydration can name a column — so the parser's own `reason` is carried instead.
   *
   * It is reachable: `instantOf` admits any safe integer, so a stored instant can sit in the
   * **BC era** or carry a historical offset with **seconds**, both of which issue #173 ruled must
   * be refused loudly rather than silently misread.
   */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  | StorageFailure;

/**
 * Persist one submitted listing (`OP-3`).
 *
 * The listing arrives **already created by the domain** — identified by `ADR-019`'s
 * application-generated UUID and stamped with the application's own instants — so this function
 * generates nothing and validates no business rule. `VR-S1` ran in `validation.ts` before the
 * aggregate existed; re-running it here would be a second, divergent copy of a governed rule.
 *
 * **It cannot overwrite an existing row.** A plain `insert` with no conflict clause is the whole
 * mechanism: the primary key refuses a repeated identifier, and the refusal is reported rather
 * than absorbed. There is no upsert, no `on conflict`, and no retry.
 *
 * Every value is a **bound parameter** — Kysely compiles the insert with placeholders — so
 * content that looks like SQL stays content.
 */
export async function insertSubmittedListing(
  db: Kysely<ListingDatabase>,
  listing: Listing,
): Promise<Result<void, InsertListingFailure>> {
  try {
    await db.insertInto("listing").values(serializeSubmittedListing(listing)).execute();
    return ok(undefined);
  } catch (cause) {
    if (
      sqlStateOf(cause) === UNIQUE_VIOLATION &&
      constraintOf(cause) === LISTING_IDENTITY_CONSTRAINT
    ) {
      return err({ code: "LISTING_ALREADY_EXISTS" } as const);
    }

    // Anything else — a `CHECK` violation, a not-null violation, a dead connection — stays
    // unexpected. It is never softened into a business outcome.
    return err(storageFailure(cause));
  }
}

/**
 * Retrieve one listing by its **exact** identifier.
 *
 * Exact equality only: no prefix, pattern, range or enumeration, and no filter or ordering, so
 * nothing here anticipates the public read paths whose criteria `OQ-4`/`S-4`/`DDM-4` leave open.
 *
 * It performs **no write**, touches no revision row, and returns the existing domain aggregate
 * rather than an administrative projection — which is why seam `S-7` (whether that projection
 * carries review history, with `S-8`/`OQ-14`) stays open and undecided.
 */
export async function findListingById(
  db: Kysely<ListingDatabase>,
  id: ListingId,
): Promise<Result<Listing, FindListingFailure>> {
  let row;

  try {
    row = await db
      .selectFrom("listing")
      .selectAll()
      .where("id", "=", identifierTextOf(id))
      .executeTakeFirst();
  } catch (cause) {
    // A governed instant the parser refused is not an infrastructure failure: the query ran and
    // the row is there. Classified separately so "the database is unreachable" and "a stored
    // value is unreadable" never look alike (and neither ever looks like "not found").
    if (cause instanceof TimestamptzParseError) {
      return err({ code: "STORED_INSTANT_UNREADABLE", reason: cause.reason } as const);
    }

    // Outside the try below on purpose: a query that failed is not a listing that is absent.
    return err(storageFailure(cause));
  }

  if (row === undefined) {
    return err({ code: "LISTING_NOT_FOUND" } as const);
  }

  const hydrated = hydrateListing(row);

  if (!hydrated.ok) {
    return err({ code: "LISTING_UNREADABLE", failure: hydrated.error } as const);
  }

  return ok(hydrated.value);
}
