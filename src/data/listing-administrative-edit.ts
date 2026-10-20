/**
 * `C9` — `FR-ADM-04`: apply an administrative edit to a **pending** listing (issue #217).
 *
 * The third of `ADR-024`'s four governed write paths to be implemented, after `OP-6` (issue
 * #195) and `OP-10` (issue #197). It reuses their protocol shape rather than re-deriving it, and
 * it is a new module for the same reason they are: one file per `PS-11` path.
 *
 * ## What makes this path different from the other two
 *
 * `OP-6` and `OP-10` are **revision** operations against an **approved** listing. This one edits
 * a **pending** listing **in place**, during moderation and before approval, and creates,
 * modifies, approves, rejects and deletes **no** `listing_revision` row. It is the only governed
 * write path whose content arrives as a **partial** edit rather than a complete set, and the only
 * one that can legitimately **write nothing at all** and still succeed.
 *
 * ## The domain owns every content decision; this module owns the transaction
 *
 * `applyAdministrativeEdit` (issue #215) is the sole authority on lifecycle eligibility, patch
 * validity and materialization, `VR-S1` content validation, `ADR-025` designation enforcement,
 * the issue #213 no-op ruling and `DI-6` advancement. **None of those rules is restated here.**
 * This module locks, compares the stale token, hands the domain a hydrated aggregate, and turns
 * the one value it returns into at most one statement.
 *
 * ## The pending-revision read is mandatory, and its result is an invariant
 *
 * `ADR-024`'s `FR-ADM-04` block prescribes it literally, between the listing lock and the stale
 * comparison:
 *
 * ```sql
 * SELECT id FROM listing_revision
 *  WHERE listing_id = $listingId AND state = 'pending'
 *    FOR UPDATE;            -- read under the lock, so the FR-ADM-10b interaction is
 *                           -- decided on committed state rather than a stale snapshot
 * ```
 *
 * It is executed exactly as written. What it can find is the interesting part: **nothing, ever.**
 * `admitPendingRevision` and `createPendingRevision` both refuse unless the listing is
 * **approved**, and `NFR-DATA-02` admits no `approved → pending` transition, so a *pending*
 * listing cannot carry a pending revision. `ADR-024` was recorded on 2026-10-14, before the issue
 * #213 Scope Gate settled that `FR-ADM-04` governs **pending** records only; the statement it
 * prescribes for the `FR-ADM-10b` interaction is therefore, on this path, an **invariant check**.
 *
 * Three readings were available and two were rejected. **Dropping the statement** would
 * reinterpret an `Accepted` ADR from memory. **Executing it and ignoring the result** would be
 * dead SQL that proves nothing. So it is executed and a non-empty result is refused **loudly** as
 * `INVALID_LIFECYCLE_STATE`, on `ADR-024` item 8's own posture for an unreachable case and on
 * `MULTIPLE_PENDING_REVISIONS`'s precedent that *"the state is invalid, and resolution refuses
 * it"*. The ADR is followed as written, the invariant is enforced rather than assumed, and no new
 * decision was taken.
 *
 * **The lifecycle check runs first, and that ordering is load-bearing.** An *approved* listing
 * carrying a pending revision is ordinary — `OP-6` creates exactly that — so a revision read
 * placed ahead of the lifecycle decision would report a caller's wrong-lifecycle mistake as a
 * loud invariant violation and assert something false about it. Deciding the lifecycle from the
 * locked row first, as `revision-approval.ts` does and as `ADR-024`'s own projection of `status`
 * invites, is what leaves the invariant reachable only where it is actually an invariant. The integration suite proves the branch is live by constructing the state
 * in a disposable database that no production path can produce.
 *
 * ## Stale input is this module's, not the domain's
 *
 * The issue #213 ruling forbids the **domain** from evaluating the instant on a no-op. That says
 * nothing about `ADR-023`'s base token, which is a **separate input with separate authority**: it
 * is compared here, under the lock, before the domain is called, on **every** path including the
 * one that turns out to be a no-op. A caller editing from a stale screen is refused whether or
 * not the edit would have changed anything.
 *
 * The token is the caller's **original** capture. It is never recaptured, refreshed or replaced
 * (`ADR-023` items 2–4, `ADR-024` item 9), and it appears a second time in the guarded write
 * predicate (`ADR-024` item 7).
 *
 * ## The no-op writes nothing and commits
 *
 * The domain returns the **exact same object** it was handed when the edit materializes to no
 * change, so this module detects a no-op by **reference identity** against the aggregate it
 * hydrated — not by re-comparing content, which would duplicate the ruling in adapter code.
 *
 * It then executes **no further SQL** and returns normally, so the transaction **commits**. Both
 * settlements release the lock and neither writes anything, so nothing observable distinguishes
 * them; the choice follows this repository's convention that a success returns normally and only
 * a refusal throws the sentinel. Committing is also the more provable one: a defect that wrote on
 * this path would leave a **visible row change**, which a rollback would hide.
 *
 * **No `UPDATE` is manufactured to demonstrate that the lock was taken.** The lock is proved by
 * the captured statements and by the concurrency suite.
 *
 * ## The guarded write, and what its predicate is for
 *
 * As in `OP-10`, the token is compared before any mutation **and** carried into
 * `WHERE last_updated_at = $base`. Under a correctly held lock the predicate cannot fail, which
 * is exactly `ADR-024` item 8's *"unreachable under the lock"* — so a zero affected-row count is a
 * **loud protocol failure**, never stale input, and the predicate's value is as defence in depth
 * against a later unit weakening or reordering the lock. Its presence is proved by inspecting the
 * statement PostgreSQL actually received, with `SET` split from `WHERE`, because
 * `last_updated_at` appears on both sides.
 *
 * ## What this module does not do
 *
 * No transport, HTTP handler, authorization, role, override, administrator message formatting,
 * audit storage or event, retry, schema, migration, dependency, revision identity, `FR-ADM-09`,
 * `FR-ADM-10b`, search, retention, purge or deployment behaviour — and **no production
 * fault-injection hook**. It reads no clock: every instant is supplied.
 */

import type { Kysely, Transaction } from "kysely";

import {
  applyAdministrativeEdit,
  type AdministrativeEdit,
} from "../domain/listing/administrative-edit";
import type { DesignationViolation } from "../domain/listing/designation";
import { instantEquals, instantOf, isInstant, type Instant } from "../domain/listing/instant";
import type { Listing } from "../domain/listing/listing";
import type { ListingId } from "../domain/listing/listing-id";
import { err, ok, type DomainError, type Result } from "../domain/listing/result";
import type { ValidationViolation } from "../domain/listing/validation";
import { hydrateListing, serializeAppliedListingContent } from "./listing-mapping";
import type { ListingHydrationFailure } from "./listing-mapping";
import type { ListingDatabase } from "./listing-table";
import {
  epochMillisecondsOf,
  identifierTextOf,
  timestamptzFromEpochMilliseconds,
} from "./row-mapping";
import { constraintOf, sqlStateOf, storageFailure, type StorageFailure } from "./storage-failure";
import { TimestamptzParseError, type TimestamptzParseFailure } from "./timestamp-parser";

/** PostgreSQL's integrity classes. Named, because a bare code is a riddle. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

/** PostgreSQL's serialization-failure and deadlock classes — the only two `ADR-024` admits. */
const RETRYABLE_CONFLICT_STATES: readonly string[] = ["40001", "40P01"];

/**
 * Why an administrative edit could not be applied.
 *
 * `ADR-024` item 17's seven kinds must not collapse into one another, and items 17–18 make four
 * of them reachable within a few statements here: **stale input**, **invalid content**, a
 * **designation refusal** and a **`DI-6` advancement failure** are four separate facts with four
 * separate codes, and none is ever reported as another.
 *
 * **`EXHAUSTED_RETRY` is absent**, because `ADR-024` item 12 authorizes no automatic retry and
 * nothing here retries. The `40001`/`40P01` classification below is defensive only.
 */
export type AdministrativeEditPersistenceFailure =
  /** No listing is stored under this identifier; no lock is held and nothing was written. */
  | { readonly code: "LISTING_NOT_FOUND" }
  /**
   * The locked listing row exists but cannot be represented.
   *
   * **Never reported as not found**, and never as a caller error: the row is present and the
   * caller supplied nothing wrong — the *stored state* disagrees with the governed model.
   */
  | { readonly code: "STORED_LISTING_UNREADABLE"; readonly failure: ListingHydrationFailure }
  /**
   * The mandatory post-lock pending-revision read found a row against a **pending** listing.
   *
   * Unreachable through any production path (see the module header), and therefore refused
   * **loudly** rather than reported as an ordinary outcome or quietly tolerated.
   *
   * **Distinct from `LISTING_NOT_PENDING`, and decided after it.** An *approved* listing with a
   * pending revision is an entirely ordinary state that `OP-6` creates on purpose; it is simply
   * not this operation's subject, and it is reported as the lifecycle refusal it is. Only a
   * *pending* listing can reach this code, which is what makes the claim it carries true.
   */
  | { readonly code: "INVALID_LIFECYCLE_STATE"; readonly detail: string }
  /** `FR-ADM-04` governs editing **before approval**; the domain refused the lifecycle state. */
  | { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  /**
   * `ADR-023` — the caller's captured token does not equal the listing's current version.
   *
   * Nothing was written and the listing is unchanged. **Distinct from every neighbour**, and in
   * particular never conflated with `EDIT_INSTANT_NOT_LATER`: two administrators acting inside
   * one millisecond is a `DI-6` problem, not a stale screen (`ADR-024` item 18).
   */
  | { readonly code: "STALE_LISTING_VERSION" }
  /** The edit is not a usable edit. The domain's own shape refusal, carried through. */
  | { readonly code: "INVALID_ADMINISTRATIVE_EDIT"; readonly offered: unknown }
  /** `FR-VAL-04`/`VR-6` — the materialized content fails the initial-submission obligations. */
  | {
      readonly code: "EDITED_CONTENT_INVALID";
      readonly violations: readonly ValidationViolation[];
    }
  /**
   * `ADR-025` — the edit would publish a value the policy requires to be private.
   *
   * The **complete** violation array in the policy's own deterministic field order, carried
   * intact and carrying **no value**, exactly as `OP-6` reports it.
   */
  | {
      readonly code: "DESIGNATION_POLICY_REFUSED";
      readonly violations: readonly DesignationViolation[];
    }
  /** `DI-6`/`NFR-DATA-05` — the supplied instant does not advance `lastUpdatedAt`. */
  | { readonly code: "EDIT_INSTANT_NOT_LATER" }
  /** The supplied instant is not a usable moment. Refused before a transaction is opened. */
  | { readonly code: "INVALID_EDIT_INSTANT" }
  /** Any remaining domain refusal, carried intact rather than restated in a second vocabulary. */
  | { readonly code: "ADMINISTRATIVE_EDIT_REFUSED"; readonly error: DomainError }
  /** `ADR-024` item 8 — zero affected rows under the lock. A protocol fault, never staleness. */
  | { readonly code: "GUARDED_UPDATE_PROTOCOL_FAILURE"; readonly detail: string }
  /** More than one row matched a primary-key-guarded update. Unreachable; reported loudly. */
  | { readonly code: "MULTI_ROW_PROTOCOL_FAILURE"; readonly detail: string }
  /** `ADR-024` item 14 — an integrity backstop fired. A fault to surface, never retried. */
  | { readonly code: "INTEGRITY_CONFLICT"; readonly sqlState: string; readonly constraint?: string }
  /** `ADR-024` item 13 — classified, **not** retried; nothing in this module retries. */
  | { readonly code: "RETRYABLE_CONFLICT"; readonly sqlState: string }
  /** A stored `timestamptz` the governed parser refused. The query ran; this is not infra. */
  | { readonly code: "STORED_INSTANT_UNREADABLE"; readonly reason: TimestamptzParseFailure }
  /** Everything else — a dead connection, an unrecognised driver error. */
  | StorageFailure;

/**
 * A governed refusal, thrown so the transaction genuinely **rolls back**.
 *
 * Returning a failure `Result` from inside the callback would **commit** it, which is the defect
 * this sentinel exists to make impossible. It never escapes this module.
 */
class AdministrativeEditRefused extends Error {
  constructor(readonly failure: AdministrativeEditPersistenceFailure) {
    super("the administrative edit was refused");
    this.name = "AdministrativeEditRefused";
  }
}

/**
 * Translate a domain refusal into this boundary's vocabulary, **preserving the distinctions**.
 *
 * `ADR-024` items 17–18 require the four reachable kinds to stay apart, so each is mapped to its
 * own code and the remainder is carried intact rather than flattened. Nothing is re-derived: the
 * domain's own payloads travel unchanged.
 */
function editFailureFrom(
  error: AdministrativeEditPersistenceFailure | DomainError | { readonly code?: unknown },
): AdministrativeEditPersistenceFailure {
  const code = (error as { readonly code?: unknown }).code;

  if (code === "LISTING_NOT_PENDING") {
    const status = (error as { readonly status?: unknown }).status;

    return {
      code: "LISTING_NOT_PENDING",
      status: typeof status === "string" ? status : "unknown",
    } as const;
  }

  if (code === "INVALID_ADMINISTRATIVE_EDIT") {
    return {
      code: "INVALID_ADMINISTRATIVE_EDIT",
      offered: (error as { readonly offered?: unknown }).offered,
    } as const;
  }

  if (code === "EDITED_CONTENT_INVALID") {
    return {
      code: "EDITED_CONTENT_INVALID",
      violations: (error as { readonly violations: readonly ValidationViolation[] }).violations,
    } as const;
  }

  if (code === "DESIGNATION_POLICY_REFUSED") {
    return {
      code: "DESIGNATION_POLICY_REFUSED",
      violations: (error as { readonly violations: readonly DesignationViolation[] }).violations,
    } as const;
  }

  if (code === "INSTANT_NOT_STRICTLY_LATER") {
    // `ADR-024` item 18: its own code, never stale input.
    return { code: "EDIT_INSTANT_NOT_LATER" } as const;
  }

  if (code === "INVALID_INSTANT") {
    return { code: "INVALID_EDIT_INSTANT" } as const;
  }

  return { code: "ADMINISTRATIVE_EDIT_REFUSED", error: error as DomainError } as const;
}

/**
 * `ADR-024` step 1 — the `PS-11` lock, taken first and held through commit.
 *
 * `selectAll`, not a projection: the domain operation requires the **complete** readable
 * aggregate — status, every content field, publication state and all three timestamps — and
 * handing it a partial listing would make it refuse a listing that is perfectly valid. This is
 * `lockListingRow`'s precedent in `revision-approval.ts`, and `createPendingRevision`'s since
 * issue #207.
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
 * Apply one administrative edit to a pending listing (`FR-ADM-04`), under `ADR-024`'s protocol.
 *
 * The caller supplies the listing's identity, the token it captured when the administrator's work
 * began, the three-state edit, and the instant. It supplies **no** `Listing` — the authoritative
 * aggregate is the one read under the lock — and **no** revision identifier, role, override,
 * retry count, transaction or clock.
 *
 * Returns the **domain's own** `Listing`: on a material edit the value it produced, and on a
 * no-op the aggregate hydrated here, returned by the **same reference** the domain was handed.
 * Either way the result is the resulting state `FR-CONF-04` asks for, and it cannot disagree with
 * what was committed because it is not a re-read.
 *
 * Nothing supplied is mutated.
 */
export async function applyAdministrativeEditToPendingListing(
  db: Kysely<ListingDatabase>,
  request: {
    readonly listingId: ListingId;
    readonly baseListingLastUpdatedAt: Instant;
    readonly edit: AdministrativeEdit;
    readonly at: Instant;
  },
): Promise<Result<Listing, AdministrativeEditPersistenceFailure>> {
  const { listingId, baseListingLastUpdatedAt, edit, at } = request;

  // Refused before a transaction is opened, so a caller error never takes a lock. The domain
  // would also refuse a malformed instant — but only on the **material** path, because the issue
  // #213 ruling forbids it from inspecting one on a no-op, and a carrier that cannot reach SQL
  // should not be discovered halfway through a locked transaction.
  if (!isInstant(baseListingLastUpdatedAt)) {
    return err({ code: "STALE_LISTING_VERSION" } as const);
  }

  const listingText = identifierTextOf(listingId);

  try {
    const edited = await db
      .transaction()
      // `ADR-024` item 1: set explicitly per transaction, never inherited from a server default.
      .setIsolationLevel("read committed")
      .execute(async (trx) => {
        // (1) The `PS-11` lock. FIRST, before any other database state is read, held to commit.
        const listingRow = await lockListingRow(trx, listingText);

        // (2) The listing must exist.
        if (listingRow === undefined) {
          throw new AdministrativeEditRefused({ code: "LISTING_NOT_FOUND" } as const);
        }

        // (3) …and be representable. A row that exists but cannot be read is a different, louder
        // problem than one that is absent, and the domain cannot be asked about it. Hydration
        // precedes the stale comparison deliberately: the comparison needs a governed `Instant`,
        // and "unreadable" and "stale" are different facts that must not be swapped.
        const listing = hydrateListing(listingRow);

        if (!listing.ok) {
          throw new AdministrativeEditRefused({
            code: "STORED_LISTING_UNREADABLE",
            failure: listing.error,
          } as const);
        }

        // (4) The lifecycle check, decided from the locked row — **before** the revision read.
        // `revision-approval.ts` reports its own lifecycle here for the same reason ("before a
        // revision read that would be pointless"), and `ADR-024`'s `FR-ADM-04` projection selects
        // `status` precisely so it can be decided at this point.
        //
        // Ordering it here is what makes step (5)'s invariant **true**. An *approved* listing with
        // a pending revision is an ordinary, production-reachable state, not a broken one; reading
        // the revision first would report that caller's wrong-lifecycle mistake as a loud protocol
        // violation and assert something false about it. `ADR-024` item 17 keeps *invalid lifecycle
        // state* and an integrity fault apart, and this is where that separation is made.
        //
        // The domain enforces the same rule again at step (7); this is not a substitute for it.
        if (listingRow.status !== "pending") {
          throw new AdministrativeEditRefused({
            code: "LISTING_NOT_PENDING",
            status: listingRow.status,
          } as const);
        }

        // (5) `ADR-024`'s prescribed post-lock revision read, after the listing lock (item 5) and
        // itself locked. Reached only for a **pending** listing, where it finds nothing — see the
        // module header — so this is the invariant check that proves it.
        const pendingRevisions = await trx
          .selectFrom("listing_revision")
          .select("id")
          .where("listing_id", "=", listingText)
          .where("state", "=", "pending")
          .forUpdate()
          .execute();

        if (pendingRevisions.length > 0) {
          throw new AdministrativeEditRefused({
            code: "INVALID_LIFECYCLE_STATE",
            detail: "a pending listing carries a pending revision, which no governed path creates",
          } as const);
        }

        // (6) The stale check, **before any mutation** (`ADR-023` item 12, `ADR-024` item 6). The
        // token is the **caller's original** capture — never recaptured from the row being
        // compared — against the locked listing's current version, by exact epoch-millisecond
        // equality on the same `Instant` carrier, so the comparison cannot drift between
        // representations. It runs on every path, including the one that proves to be a no-op:
        // the issue #213 ruling governs the **domain's** use of the edit instant and says nothing
        // about `ADR-023`'s token, which is a separate input with separate authority.
        const current = instantOf(listingRow.last_updated_at);

        if (!current.ok) {
          throw new AdministrativeEditRefused({
            code: "GUARDED_UPDATE_PROTOCOL_FAILURE",
            detail: "the locked listing's last_updated_at is not a usable instant",
          } as const);
        }

        if (!instantEquals(baseListingLastUpdatedAt, current.value)) {
          throw new AdministrativeEditRefused({ code: "STALE_LISTING_VERSION" } as const);
        }

        // (7) The merged **pure** domain operation, unchanged and unassisted. Lifecycle, patch
        // validity, `VR-S1` validation, `ADR-025` enforcement, the no-op ruling and `DI-6` are
        // all decided there, in that order. Nothing above or below re-implements any of them.
        const result = applyAdministrativeEdit(listing.value, edit, at);

        if (!result.ok) {
          throw new AdministrativeEditRefused(editFailureFrom(result.error));
        }

        // (8) The ruling, read through the contract the domain actually offers: it returns the
        // **exact object** it was handed when the materialized content equals the current
        // content. Reference identity is therefore the whole test — re-comparing content here
        // would duplicate the ruling in adapter code and could disagree with it.
        if (result.value === listing.value) {
          // No `UPDATE`, no `INSERT`, no `DELETE`, and `last_updated_at` untouched. Returning
          // normally commits a transaction that wrote nothing and releases the lock; a defect
          // that wrote here would leave a visible row change rather than being hidden by a
          // rollback.
          return result.value;
        }

        // (9) The guarded update — the **original** caller token in the predicate, never a
        // refreshed one and never the edit instant, and only the columns the domain changed.
        const update = await trx
          .updateTable("listing")
          .set(serializeAppliedListingContent(result.value))
          .where("id", "=", listingText)
          // The token as a `timestamptz`, through the **same** expression the insert uses. A
          // bound number would be no comparison at all: PostgreSQL cannot compare `timestamptz`
          // to `bigint`, so the predicate would raise `42883` rather than quietly match nothing —
          // and sharing the conversion is what keeps it exact to the millisecond.
          .where(
            "last_updated_at",
            "=",
            timestamptzFromEpochMilliseconds(epochMillisecondsOf(baseListingLastUpdatedAt)),
          )
          .executeTakeFirst();

        const updatedRows = Number(update.numUpdatedRows);

        // (10) Exactly one row. Zero — after the lock was held and the comparison succeeded — is a
        // loud protocol failure and never stale input, which the comparison already ruled out.
        if (updatedRows === 0) {
          throw new AdministrativeEditRefused({
            code: "GUARDED_UPDATE_PROTOCOL_FAILURE",
            detail: "the guarded listing update matched no row under the lock",
          } as const);
        }

        if (updatedRows > 1) {
          throw new AdministrativeEditRefused({
            code: "MULTI_ROW_PROTOCOL_FAILURE",
            detail: "the guarded listing update matched more than one row",
          } as const);
        }

        // (11) Commit. The edited listing is the domain's own value, not a re-read.
        return result.value;
      });

    return ok(edited);
  } catch (cause) {
    // A governed refusal: raised inside the transaction so that it rolled back, and carried out
    // here so the caller receives it as an ordinary `Result` rather than an exception.
    if (cause instanceof AdministrativeEditRefused) {
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

    // Anything else — a dead connection, an unrecognised driver error — stays unexpected.
    return err(storageFailure(cause));
  }
}
