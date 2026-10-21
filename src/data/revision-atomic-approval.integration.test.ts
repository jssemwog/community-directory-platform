/**
 * Attacking tests for the `FR-ADM-10b` atomic create-and-approve path against a real PostgreSQL
 * server (issue #219).
 *
 * `ADR-024` names its own material tradeoff: correctness depends on **enforced statement and
 * lock order** rather than on the engine, *"which makes deterministic interleaving tests
 * mandatory"*. This path adds two things no sibling had to prove — a **transient row that is
 * inserted and deleted inside one transaction**, and an **equal-content proposal that must still
 * write**, because the issue #213 `FR-ADM-04` no-op ruling deliberately does not reach it — so
 * the attacks below are as much about what must happen as about what must not.
 *
 * ## How the interleavings stay deterministic
 *
 * No test sleeps, polls an assertion, or re-runs anything until it passes. Where a participant
 * must be *blocked* while another commits, the suite synchronises on **observable lock
 * acquisition** read from `pg_stat_activity`, with a named sentinel if the wait never appears, so
 * that a participant which fails to block fails immediately instead of hanging.
 *
 * ## Forcing outcomes the protocol says are impossible
 *
 * A suppressed insert, a zero-row guarded `UPDATE`, a suppressed `DELETE` and the two integrity
 * backstops cannot arise under the lock. Each is produced only in a **disposable database this
 * suite owns**, with test-only `BEFORE` triggers that return `NULL` or raise a chosen `SQLSTATE`.
 * Triggers are dropped in each test's `finally` and swept unconditionally in `afterEach`; nothing
 * in `src/` knows the mechanism exists. **No production fault-injection hook is introduced.**
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql, type ControlledTransaction } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing, ListingContent } from "../domain/listing/listing";
import type { PendingListingRevision } from "../domain/listing/revision";
import {
  createListingPersistence,
  startupOptionsFor,
  type ListingPersistence,
} from "./connection";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import type { ListingDatabase } from "./listing-table";
import { insertSubmittedListing } from "./listing-repository";
import { createPendingRevision } from "./revision-repository";
import { approveAndApplyPendingRevision } from "./revision-approval";
import { rejectPendingRevision } from "./revision-rejection";
import { applyAdministrativeEditToPendingListing } from "./listing-administrative-edit";
import {
  createAndApproveRevisionAtomically,
  type AtomicRevisionFailure,
} from "./revision-atomic-approval";

const VERIFIED_DATABASE = "atomic_approval_verification";
/** A second database this suite owns, where impossible states may be constructed. */
const HOSTILE_DATABASE = "atomic_approval_hostile";

const cluster = useEmbeddedPostgres({
  slug: "atomic-approval",
  databases: [VERIFIED_DATABASE, HOSTILE_DATABASE],
  migrate: [VERIFIED_DATABASE, HOSTILE_DATABASE],
});

/** The boundary under test. */
let persistence: ListingPersistence;
/** A rival participant, so a lock can be held while the boundary runs. */
let rival: ListingPersistence;
/** A connection that only observes, so it is never the blocked backend. */
let observer: ListingPersistence;
/** The disposable database where impossible states are built. */
let hostile: ListingPersistence;
/** The same boundary, with every executed statement captured. */
let capturing: ReturnType<typeof createCapturingPersistence>;

const RIVAL_APPLICATION_NAME = "atomic_approval_rival";

const SUBMITTED_AT = 1_767_323_040_000;
const BASE_AT = 1_767_323_045_123;
/** Strictly later than `BASE_AT`, as `DI-6` requires of every application. */
const APPLIED_AT = BASE_AT + 1_000;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

const BASE = instant(BASE_AT);
const LATER = instant(APPLIED_AT);

/**
 * The content the listing is approved with.
 *
 * It carries a contact method because `validateBeforeApproval` requires one (`FR-DATA-08`), and
 * a **public** `email` so that the `ADR-025` case *"the business's own public designation,
 * carried forward unchanged"* is exercised by the equal-content proposal.
 */
const APPROVED_CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: false },
  phone: { value: "+353 21 123 4567", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: "https://example.ie", designatedPublic: false },
};

/**
 * A lawful material proposal — different in every field that can differ.
 *
 * Every designatable value it replaces is **private**, because `ADR-025` makes a replacement
 * default private and refuses one that asks to be public.
 */
const PROPOSED_CONTENT: ListingContent = {
  name: "Harbour Bakery & Cafe",
  category: "retail-shopping",
  description: "A small bakery, now with a cafe.",
  locality: "Cobh",
  country: "IE",
  administrativeArea: "Co. Waterford",
  postalCode: { value: "X91 CD34", designatedPublic: false },
  phone: { value: "+353 21 765 4321", designatedPublic: false },
  email: { value: "cafe@example.ie", designatedPublic: false },
  website: { value: "https://cafe.example.ie", designatedPublic: false },
};

function approvedListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "approved",
    content: APPROVED_CONTENT,
    publication: { value: "publicly_available" },
    timestamps: { submittedAt: instant(SUBMITTED_AT), lastUpdatedAt: BASE },
    ...overrides,
  };
}

function listingText(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

async function seed(
  db = persistence.db,
  overrides: Partial<Listing> = {},
): Promise<Listing> {
  const listing = approvedListing(overrides);

  expect((await insertSubmittedListing(db, listing)).ok).toBe(true);

  return listing;
}

function proposalFor(listing: Listing, content: ListingContent): PendingListingRevision {
  return {
    listingId: listing.id,
    state: "pending",
    proposedContent: content,
    baseListingLastUpdatedAt: listing.timestamps.lastUpdatedAt,
  } as PendingListingRevision;
}

async function atomic(
  listing: Listing,
  options: {
    content?: ListingContent;
    at?: Instant;
    base?: Instant;
    revisionId?: string;
    db?: Kysely<ListingDatabase>;
  } = {},
) {
  return await createAndApproveRevisionAtomically(options.db ?? persistence.db, {
    listingId: listing.id,
    revisionId: "revisionId" in options ? (options.revisionId as string) : randomUUID(),
    // `in`, not `??`: a test that deliberately supplies an unusable token must not have it
    // silently replaced by the default.
    baseListingLastUpdatedAt: "base" in options ? (options.base as Instant) : BASE,
    // `in`, not `??`: a test that deliberately supplies unreadable content must not have it
    // silently replaced by the lawful default — which is how this helper first hid that case.
    proposedContent: "content" in options ? (options.content as ListingContent) : PROPOSED_CONTENT,
    at: "at" in options ? (options.at as Instant) : LATER,
  });
}

function expectRefusal(result: Awaited<ReturnType<typeof atomic>>): AtomicRevisionFailure {
  if (result.ok) {
    throw new Error("expected a refusal, got a listing");
  }

  return result.error;
}

function expectListing(result: Awaited<ReturnType<typeof atomic>>): Listing {
  if (!result.ok) {
    throw new Error(`expected a listing, got ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

async function storedRow(listing: Listing, db = persistence.db) {
  const rows = await sql<{
    id: string;
    status: string;
    name: string;
    category: string;
    description: string;
    locality: string;
    country: string;
    administrative_area: string | null;
    postal_code: string | null;
    postal_code_designated_public: boolean;
    phone: string | null;
    phone_designated_public: boolean;
    email: string | null;
    email_designated_public: boolean;
    website: string | null;
    website_designated_public: boolean;
    publication_state: string | null;
    unpublish_reason: string | null;
    submitted_at: number;
    last_updated_at: number;
    rejected_at: number | null;
  }>`select * from listing where id = ${listingText(listing)}::uuid`.execute(db);

  const row = rows.rows[0];

  if (row === undefined) {
    throw new Error("the seeded listing is missing");
  }

  return row;
}

async function revisionRows(listing: Listing, db = persistence.db) {
  const rows = await sql<{ id: string; state: string }>`
    select id, state from listing_revision where listing_id = ${listingText(listing)}::uuid
  `.execute(db);

  return rows.rows;
}

/** Sessions left holding a transaction open. Must always settle at zero. */
async function sessionsInTransaction(db = observer.db): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from pg_stat_activity
     where datname = current_database()
       and state in ('idle in transaction', 'idle in transaction (aborted)')
  `.execute(db);

  return rows.rows[0]?.count ?? 0;
}

/**
 * The narrow slice of `pg` this file reaches directly, to build a **logging** boundary.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is described here — the pattern `migrate.ts` and the sibling suites established.
 */
interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => PgPool;
}

interface PgPool {
  on(event: "error", listener: (error: Error) => void): unknown;
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A `C9` boundary identical to the production one, with every executed statement captured.
 *
 * **No production change buys this.** The operation accepts any `Kysely<ListingDatabase>`, and
 * Kysely's own `log` option reports each statement it executes as compiled SQL plus bound
 * parameters — so the *actually executed* statements can be inspected without a fault-injection
 * hook, a source-text assertion, or any weakening of the lock. The pool is configured exactly as
 * `createListingPersistence` configures its own; anything less would test a different boundary.
 */
function createCapturingPersistence(database: string): {
  readonly db: Kysely<ListingDatabase>;
  readonly statements: readonly CapturedStatement[];
  reset(): void;
  shutdown(): Promise<void>;
} {
  const statements: CapturedStatement[] = [];

  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(database),
    max: 2,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: "atomic_approval_capture" }),
  });

  // The listener `connection.ts` attaches on every application pool, for the reason it records:
  // an idle client killed by the server raises the pool's `error` event, and an unhandled
  // `EventEmitter` `error` throws. Handled by doing nothing, exactly as production does.
  pool.on("error", () => undefined);

  const db = new Kysely<ListingDatabase>({
    dialect: new PostgresDialect({ pool: pool as never }),
    log: (event) => {
      if (event.level === "query") {
        statements.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });

  return {
    db,
    statements,
    reset: () => {
      statements.length = 0;
    },
    shutdown: () => db.destroy(),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Statement analysers — each attacked with hostile samples below, so none can pass vacuously.   */
/* ------------------------------------------------------------------------------------------- */

const isListingLock = (statement: CapturedStatement): boolean =>
  /^\s*select\b[\s\S]*\bfrom\s+"listing"[\s\S]*\bfor update\b/i.test(statement.sql) &&
  !/"listing_revision"/i.test(statement.sql);

const isRevisionRead = (statement: CapturedStatement): boolean =>
  /^\s*select\b[\s\S]*\bfrom\s+"listing_revision"/i.test(statement.sql);

const isWrite = (statement: CapturedStatement): boolean =>
  /^\s*(update|insert|delete)\b/i.test(statement.sql);

const isListingUpdate = (statement: CapturedStatement): boolean =>
  /^\s*update\s+"listing"\s+set\b/i.test(statement.sql);

const isRevisionInsert = (statement: CapturedStatement): boolean =>
  /^\s*insert\s+into\s+"listing_revision"\s*\(/i.test(statement.sql);

const isRevisionDelete = (statement: CapturedStatement): boolean =>
  /^\s*delete\s+from\s+"listing_revision"/i.test(statement.sql);

/** What the analyser found in one `UPDATE`, so a failure names the missing part. */
interface GuardedUpdateShape {
  readonly setColumns: readonly string[];
  readonly whereHasListingId: boolean;
  readonly whereHasLastUpdatedAt: boolean;
  readonly whereConvertsAnInstant: boolean;
  readonly setsForbiddenColumn: string | undefined;
}

/**
 * Describe the guarded shape of one compiled `UPDATE`, by splitting `SET` from `WHERE`.
 *
 * The split is the whole point: `last_updated_at` appears on **both** sides — assigned in `SET`
 * and compared in `WHERE` — so an assertion that merely searched the statement would pass with
 * the predicate removed. The `OP-10` and `FR-ADM-04` suites established this; the `SET` column
 * list is extracted in full as well, so an omitted or forbidden column is named rather than
 * guessed.
 */
function guardedUpdateShapeOf(statementSql: string): GuardedUpdateShape {
  const whereAt = statementSql.search(/\swhere\s/i);
  const setClause = whereAt === -1 ? statementSql : statementSql.slice(0, whereAt);
  const whereClause = whereAt === -1 ? "" : statementSql.slice(whereAt);

  const setColumns = [...setClause.matchAll(/"([a-z_]+)"\s*=/gi)]
    .map((match) => match[1] as string)
    .filter((column) => column !== "listing");

  const forbidden = [
    "id",
    "status",
    "submitted_at",
    "rejected_at",
    "publication_state",
    "unpublish_reason",
  ].find((column) => setColumns.includes(column));

  return {
    setColumns,
    whereHasListingId: /"id"\s*=/i.test(whereClause),
    whereHasLastUpdatedAt: /"last_updated_at"\s*=/i.test(whereClause),
    whereConvertsAnInstant: /to_timestamp\s*\(/i.test(whereClause),
    setsForbiddenColumn: forbidden,
  };
}

/** The exact column surface an applied revision may write on the listing row. */
const AUTHORIZED_SET_COLUMNS = [
  "name",
  "category",
  "description",
  "locality",
  "country",
  "administrative_area",
  "postal_code",
  "postal_code_designated_public",
  "phone",
  "phone_designated_public",
  "email",
  "email_designated_public",
  "website",
  "website_designated_public",
  "last_updated_at",
] as const;

/** The exact column surface the transient revision insert may write. */
const AUTHORIZED_INSERT_COLUMNS = [
  "id",
  "listing_id",
  "state",
  "name",
  "category",
  "description",
  "locality",
  "country",
  "administrative_area",
  "postal_code",
  "postal_code_designated_public",
  "phone",
  "phone_designated_public",
  "email",
  "email_designated_public",
  "website",
  "website_designated_public",
  "rejected_at",
  "base_listing_last_updated_at",
] as const;

/** The columns the transient insert must never write — no creation instant is invented. */
const FORBIDDEN_INSERT_COLUMNS = ["created_at", "submitted_at", "approved_at", "last_updated_at"];

interface RevisionInsertShape {
  readonly columns: readonly string[];
  readonly hasReturning: boolean;
  readonly writesForbiddenColumn: string | undefined;
}

function revisionInsertShapeOf(statementSql: string): RevisionInsertShape {
  const columnList = /insert\s+into\s+"listing_revision"\s*\(([^)]*)\)/i.exec(statementSql);
  const columns = [...(columnList?.[1] ?? "").matchAll(/"([a-z_]+)"/gi)].map(
    (match) => match[1] as string,
  );

  return {
    columns,
    hasReturning: /\breturning\b/i.test(statementSql),
    writesForbiddenColumn: FORBIDDEN_INSERT_COLUMNS.find((column) => columns.includes(column)),
  };
}

interface RevisionDeleteShape {
  readonly whereHasId: boolean;
  readonly whereHasListingId: boolean;
  readonly whereHasState: boolean;
}

/**
 * Describe one compiled revision `DELETE`.
 *
 * `"listing_id"` contains `"id"` as a substring, so each predicate is matched on its own quoted
 * column name with the assignment that follows it — a looser search would report a
 * listing-id-only delete as carrying the revision identity, which is exactly the weakening this
 * analyser exists to catch.
 */
function revisionDeleteShapeOf(statementSql: string): RevisionDeleteShape {
  const whereAt = statementSql.search(/\swhere\s/i);
  const whereClause = whereAt === -1 ? "" : statementSql.slice(whereAt);

  return {
    whereHasId: /(?:^|[\s(])"id"\s*=/i.test(whereClause),
    whereHasListingId: /"listing_id"\s*=/i.test(whereClause),
    whereHasState: /"state"\s*=/i.test(whereClause),
  };
}

const LOCK_WAIT_SENTINEL = "no backend ever blocked on a lock";

/**
 * Wait until PostgreSQL reports a backend blocked on a lock, then return.
 *
 * A condition wait on a fact the server publishes — not a sleep, and not a retry. Each iteration
 * is one round trip, so the loop paces itself and ends the moment the fact appears. The bound
 * exists so a participant that never blocks fails **immediately and by name** instead of hanging
 * until the test timeout and leaving a cluster behind.
 */
async function awaitLockWaiter(attempts = 2_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await sql<{ count: number }>`
      select count(*)::int as count
        from pg_stat_activity
       where wait_event_type = 'Lock' and datname = current_database()
    `.execute(observer.db);

    if ((waiting.rows[0]?.count ?? 0) > 0) {
      return;
    }
  }

  throw new Error(`${LOCK_WAIT_SENTINEL}: the operation under test did not wait for the lock`);
}

/**
 * Hold the listing lock for the duration of `body`, and **always** settle and release it.
 *
 * The hardened pattern issue #201 established, reused rather than re-invented. Acquisition is
 * **inside** the `try`: a `SELECT … FOR UPDATE` that throws leaves the transaction open and
 * aborted, still holding whatever it acquired, so taking the lock before the `try` would leak it
 * on a setup failure. Only `startTransaction()` sits outside — if that throws there is nothing to
 * release. The **body's** failure is primary and always propagates; if cleanup also fails both
 * are reported through an `AggregateError` whose **first** error is the body's.
 *
 * This matters beyond tidiness: a held row lock also holds a table-level lock on `listing`, and
 * this file's `afterEach` runs `drop trigger … on listing`, which needs `ACCESS EXCLUSIVE`. A
 * leaked lock would make cleanup block indefinitely and bury the real failure under a timeout.
 */
async function withRivalLock(
  listing: Listing,
  body: (trx: ControlledTransaction<ListingDatabase>) => Promise<void>,
): Promise<void> {
  const trx = await rival.db.startTransaction().setIsolationLevel("read committed").execute();

  let bodyError: unknown;
  let threw = false;

  try {
    // Inside the `try` on purpose — see the header.
    await trx
      .selectFrom("listing")
      .select("id")
      .where("id", "=", listingText(listing))
      .forUpdate()
      .execute();

    await body(trx);
  } catch (error) {
    threw = true;
    bodyError = error;
    throw error;
  } finally {
    try {
      if (trx.isCommitted === false && trx.isRolledBack === false) {
        await trx.rollback().execute();
      }
    } catch (releaseError) {
      if (!threw) {
        throw releaseError;
      }

      throw new AggregateError(
        [bodyError, releaseError],
        "the test body failed and releasing the rival lock also failed; the first error is " +
          "the original failure",
      );
    }
  }
}

/** Test-only triggers share one prefix, so the unconditional sweep can find every one. */
const TRIGGER_PREFIX = "atomic_probe_";

async function dropProbeTriggers(db: Kysely<ListingDatabase>): Promise<void> {
  // Bounded, so a leaked lock makes cleanup fail loudly instead of hanging the run.
  await sql`set local lock_timeout = '5s'`.execute(db);

  const triggers = await sql<{ tgname: string; relname: string }>`
    select t.tgname, c.relname
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and t.tgname like ${`${TRIGGER_PREFIX}%`}
  `.execute(db);

  for (const trigger of triggers.rows) {
    await sql.raw(`drop trigger if exists "${trigger.tgname}" on "${trigger.relname}"`).execute(db);
  }

  const functions = await sql<{ proname: string }>`
    select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like ${`${TRIGGER_PREFIX}%`}
  `.execute(db);

  for (const routine of functions.rows) {
    await sql.raw(`drop function if exists "${routine.proname}"() cascade`).execute(db);
  }
}

/** Install one test-only `BEFORE` trigger in the hostile database, and return its name. */
async function installProbe(
  table: "listing" | "listing_revision",
  event: "insert" | "update" | "delete",
  body: string,
  suffix: string,
): Promise<void> {
  const name = `${TRIGGER_PREFIX}${suffix}`;

  await sql
    .raw(
      `create or replace function "${name}"() returns trigger as $$ begin ${body} end; $$ language plpgsql`,
    )
    .execute(hostile.db);
  await sql
    .raw(
      `create trigger "${name}" before ${event} on "${table}" for each row execute function "${name}"()`,
    )
    .execute(hostile.db);
}

beforeAll(async () => {
  persistence = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
  });
  rival = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 2 },
    // Labelled so this pool's sessions can be counted rather than inferred from a total.
    // `application_name` is a label: it changes no behaviour and no concurrency semantics.
    startupParameters: { application_name: RIVAL_APPLICATION_NAME },
  });
  observer = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(VERIFIED_DATABASE), max: 1 },
  });
  hostile = createListingPersistence({
    pool: { connectionString: cluster.connectionStringFor(HOSTILE_DATABASE), max: 2 },
  });
  capturing = createCapturingPersistence(VERIFIED_DATABASE);

  cluster.closeBeforeShutdown("capturing persistence", () => capturing.shutdown());
  cluster.closeBeforeShutdown("verified persistence", () => persistence.shutdown());
  cluster.closeBeforeShutdown("rival persistence", () => rival.shutdown());
  cluster.closeBeforeShutdown("observer persistence", () => observer.shutdown());
  cluster.closeBeforeShutdown("hostile persistence", () => hostile.shutdown());
}, CLUSTER_TIMEOUT_MS);

afterEach(async () => {
  // Unconditional, so a failing assertion can never leave a probe trigger behind.
  await dropProbeTriggers(persistence.db);
  await dropProbeTriggers(hostile.db);
  capturing.reset();

  expect(await sessionsInTransaction()).toBe(0);
});

/* ------------------------------------------------------------------------------------------- */
/* Compile-time guards                                                                           */
/* ------------------------------------------------------------------------------------------- */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type Operation = typeof createAndApproveRevisionAtomically;
type Request = Parameters<Operation>[1];

/** The request carries exactly the five authorized values, and nothing else. */
type _RequestSurface = Assert<
  Equals<
    keyof Request,
    "listingId" | "revisionId" | "baseListingLastUpdatedAt" | "proposedContent" | "at"
  >
>;
/** A **complete** proposal, never `FR-ADM-04`'s three-state patch. */
type _CompleteContent = Assert<Equals<Request["proposedContent"], ListingContent>>;
type _NoPatch = Assert<
  Equals<Extract<keyof Request, "edit" | "patch" | "changes" | "fields">, never>
>;
/** No caller-supplied Listing, role, override, retry, transaction, clock or audit context. */
type _NoListing = Assert<Equals<Extract<keyof Request, "listing" | "content">, never>>;
type _NoRole = Assert<
  Equals<Extract<keyof Request, "role" | "actor" | "override" | "reason" | "audit">, never>
>;
type _NoRetry = Assert<
  Equals<Extract<keyof Request, "retries" | "attempts" | "trx" | "now" | "clock">, never>
>;
/** Exactly one governed instant. */
type _OneInstant = Assert<
  Equals<Extract<keyof Request, "at" | "approvedAt" | "createdAt" | "editedAt">, "at">
>;
/** The revision identifier is a plain adapter-boundary string — `DDM-2` stays open. */
type _RevisionIdIsString = Assert<Equals<Request["revisionId"], string>>;
/** Exactly two parameters: the boundary and the request. */
type _Arity = Assert<Equals<Parameters<Operation>["length"], 2>>;
/** The success type is the governed `Listing` — never a pair carrying a revision identity. */
type _Success = Assert<
  Equals<
    Awaited<ReturnType<Operation>>,
    import("../domain/listing/result").Result<Listing, AtomicRevisionFailure>
  >
>;
/** Nothing in the success value can carry a revision identifier. */
type _NoRevisionIdOut = Assert<
  Equals<Extract<keyof Listing, "revisionId" | "revision" | "revisions">, never>
>;
/** No `Date` crosses the boundary in either direction. */
type _NoDateIn = Assert<Equals<Extract<Request[keyof Request], Date>, never>>;
/** `EXHAUSTED_RETRY` is absent — `ADR-024` item 12 authorizes no retry. */
type _NoExhaustedRetry = Assert<
  Equals<Extract<AtomicRevisionFailure, { code: "EXHAUSTED_RETRY" }>, never>
>;
/** The distinctions `ADR-024` items 17–18 require, each with its own bare or payloaded shape. */
type _StaleIsBare = Assert<
  Equals<
    Extract<AtomicRevisionFailure, { code: "STALE_LISTING_VERSION" }>,
    { readonly code: "STALE_LISTING_VERSION" }
  >
>;
type _AdvancementIsBare = Assert<
  Equals<
    Extract<AtomicRevisionFailure, { code: "APPROVAL_INSTANT_NOT_LATER" }>,
    { readonly code: "APPROVAL_INSTANT_NOT_LATER" }
  >
>;
/** The `DI-11` refusal and the index backstop are different members. */
type _RefusalAndBackstopDiffer = Assert<
  Equals<
    Extract<
      AtomicRevisionFailure,
      { code: "PENDING_REVISION_ALREADY_EXISTS" | "PENDING_UNIQUENESS_CONFLICT" }
    > extends never
      ? false
      : true,
    true
  >
>;
/** Identity conflict is its own member, never `PENDING_UNIQUENESS_CONFLICT`. */
type _IdentityConflict = Assert<
  Equals<
    Extract<AtomicRevisionFailure, { code: "REVISION_ALREADY_EXISTS" }>,
    { readonly code: "REVISION_ALREADY_EXISTS" }
  >
>;
/** The module exports exactly the operation and its failure type. */
type _ExportSurface = Assert<
  Equals<
    keyof typeof import("./revision-atomic-approval"),
    "createAndApproveRevisionAtomically"
  >
>;

describe("the authorized boundary", () => {
  it("accepts a complete proposal, a supplied identifier, a token and one instant", async () => {
    const listing = await seed();

    // The call compiles only with exactly these five values, and succeeds with them.
    expectListing(
      await createAndApproveRevisionAtomically(persistence.db, {
        listingId: listing.id,
        revisionId: randomUUID(),
        baseListingLastUpdatedAt: BASE,
        proposedContent: PROPOSED_CONTENT,
        at: LATER,
      }),
    );
  });

  it("mutates nothing it was given", async () => {
    const listing = await seed();
    const request = {
      listingId: listing.id,
      revisionId: randomUUID(),
      baseListingLastUpdatedAt: BASE,
      proposedContent: PROPOSED_CONTENT,
      at: LATER,
    };
    const snapshot = structuredClone({ ...request, listingId: listingText(listing) });

    expectListing(await createAndApproveRevisionAtomically(persistence.db, request));

    expect({ ...request, listingId: listingText(listing) }).toEqual(snapshot);
    expect(PROPOSED_CONTENT).toEqual(structuredClone(PROPOSED_CONTENT));
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The governed success                                                                          */
/* ------------------------------------------------------------------------------------------- */

describe("a material atomic create-and-approve", () => {
  it("applies the proposal, advances lastUpdatedAt and leaves no revision row", async () => {
    const listing = await seed();

    const applied = expectListing(await atomic(listing));

    expect(applied.content).toEqual(PROPOSED_CONTENT);
    expect(applied.status).toBe("approved");
    expect(applied.timestamps.lastUpdatedAt).toEqual(LATER);
    expect(applied.timestamps.submittedAt).toEqual(instant(SUBMITTED_AT));
    expect(applied.publication).toEqual({ value: "publicly_available" });

    const row = await storedRow(listing);

    // The returned value is the domain's own, and it matches what was committed.
    expect(row.name).toBe(PROPOSED_CONTENT.name);
    expect(row.category).toBe(PROPOSED_CONTENT.category);
    expect(row.description).toBe(PROPOSED_CONTENT.description);
    expect(row.locality).toBe(PROPOSED_CONTENT.locality);
    expect(row.administrative_area).toBe(PROPOSED_CONTENT.administrativeArea);
    expect(row.postal_code).toBe(PROPOSED_CONTENT.postalCode?.value);
    expect(row.postal_code_designated_public).toBe(false);
    expect(row.phone).toBe(PROPOSED_CONTENT.phone?.value);
    expect(row.email).toBe(PROPOSED_CONTENT.email?.value);
    expect(row.email_designated_public).toBe(false);
    expect(row.website).toBe(PROPOSED_CONTENT.website?.value);
    expect(row.last_updated_at).toBe(APPLIED_AT);
    // Unchanged throughout: the listing was approved and stays approved (`DI-1`).
    expect(row.status).toBe("approved");
    expect(row.submitted_at).toBe(SUBMITTED_AT);
    expect(row.rejected_at).toBeNull();
    expect(row.publication_state).toBe("publicly_available");

    // `ADR-017` Q-3: the transient proposal does not survive the transaction.
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("removes a lawful optional value when the complete proposal omits it", async () => {
    const listing = await seed();
    const withoutOptionals: ListingContent = {
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Kinsale",
      country: "IE",
      phone: { value: "+353 21 123 4567", designatedPublic: false },
    };

    const applied = expectListing(await atomic(listing, { content: withoutOptionals }));

    expect(applied.content.administrativeArea).toBeUndefined();
    expect(applied.content.email).toBeUndefined();

    const row = await storedRow(listing);

    expect(row.administrative_area).toBeNull();
    expect(row.email).toBeNull();
    expect(row.postal_code).toBeNull();
    // Absence in a complete proposal is removal, never preservation (`ADR-025`).
    expect(row.website).toBeNull();
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("permits an unchanged public designation to be carried forward", async () => {
    const listing = await seed();
    const sameEmailStillPublic: ListingContent = {
      ...PROPOSED_CONTENT,
      email: { value: "hello@example.ie", designatedPublic: true },
    };

    const applied = expectListing(await atomic(listing, { content: sameEmailStillPublic }));

    expect(applied.content.email).toEqual({ value: "hello@example.ie", designatedPublic: true });
    expect((await storedRow(listing)).email_designated_public).toBe(true);
  });

  it("permits restricting a public value to private", async () => {
    const listing = await seed();
    const restricted: ListingContent = {
      ...APPROVED_CONTENT,
      email: { value: "hello@example.ie", designatedPublic: false },
    };

    expectListing(await atomic(listing, { content: restricted }));

    expect((await storedRow(listing)).email_designated_public).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Equal-content parity — the decisive contract                                                  */
/* ------------------------------------------------------------------------------------------- */

describe("a proposal equal to the current approved content", () => {
  it("is an ordinary revision: it writes, advances lastUpdatedAt and leaves nothing behind", async () => {
    const listing = await seed();
    const before = await storedRow(listing);

    const applied = expectListing(await atomic(listing, { content: APPROVED_CONTENT }));

    // Not refused, and **not** an `FR-ADM-04`-style no-op: the governed instant becomes the new
    // version, exactly as merged `OP-6` + `OP-10` would have left it.
    expect(applied.content).toEqual(APPROVED_CONTENT);
    expect(applied.timestamps.lastUpdatedAt).toEqual(LATER);

    const row = await storedRow(listing);

    expect(row.last_updated_at).toBe(APPLIED_AT);
    expect(row.last_updated_at).not.toBe(before.last_updated_at);
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("is not returned by exact reference, because it is not the no-op path", async () => {
    const listing = await seed();

    const applied = expectListing(await atomic(listing, { content: APPROVED_CONTENT }));

    // `applyAdministrativeEdit` returns its input by reference on a no-op. Nothing here does:
    // the value is the domain's newly applied listing, carrying a different timestamp.
    expect(applied).not.toBe(listing);
    expect(applied.timestamps.lastUpdatedAt).not.toEqual(listing.timestamps.lastUpdatedAt);
  });

  it("still requires a strictly later instant, so no-op leniency cannot leak in", async () => {
    const listing = await seed();

    // The issue #213 ruling says an `FR-ADM-04` no-op must **not** inspect the instant. On this
    // path the instant is inspected, because this path has no no-op.
    expect(expectRefusal(await atomic(listing, { content: APPROVED_CONTENT, at: BASE })).code).toBe(
      "APPROVAL_INSTANT_NOT_LATER",
    );
    expect(
      expectRefusal(await atomic(listing, { content: APPROVED_CONTENT, at: instant(BASE_AT - 1) }))
        .code,
    ).toBe("APPROVAL_INSTANT_NOT_LATER");

    // And nothing was written on either refusal.
    expect((await storedRow(listing)).last_updated_at).toBe(BASE_AT);
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("still refuses an equal private value offered as public", async () => {
    const listing = await seed();
    const widened: ListingContent = {
      ...APPROVED_CONTENT,
      phone: { value: "+353 21 123 4567", designatedPublic: true },
    };

    const failure = expectRefusal(await atomic(listing, { content: widened }));

    expect(failure.code).toBe("DESIGNATION_POLICY_REFUSED");
    expect((await storedRow(listing)).last_updated_at).toBe(BASE_AT);
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("executes exactly the same statements as a material success", async () => {
    const equal = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(equal, { content: APPROVED_CONTENT, db: capturing.db }));
    const equalTrace = capturing.statements.map((statement) => statement.sql);

    const material = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(material, { db: capturing.db }));
    const materialTrace = capturing.statements.map((statement) => statement.sql);

    // Statement-level proof that no materiality short-circuit exists: the two traces have the
    // same shape, including the revision `INSERT`, the listing `UPDATE` and the `DELETE`.
    expect(equalTrace.length).toBe(materialTrace.length);
    expect(equalTrace.filter((statement) => /^\s*insert/i.test(statement))).toHaveLength(1);
    expect(equalTrace.filter((statement) => /^\s*update/i.test(statement))).toHaveLength(1);
    expect(equalTrace.filter((statement) => /^\s*delete/i.test(statement))).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Governed refusals                                                                             */
/* ------------------------------------------------------------------------------------------- */

describe("the refusals, each distinct and each writing nothing", () => {
  it("refuses a missing listing without taking a lock", async () => {
    const absent = approvedListing();

    expect(expectRefusal(await atomic(absent)).code).toBe("LISTING_NOT_FOUND");
  });

  it.each([
    ["pending", "pending"],
    ["rejected", "rejected"],
  ])("refuses a listing whose status is %s", async (_label, status) => {
    const listing = await seed(persistence.db, {
      status: status as Listing["status"],
      publication: undefined,
      ...(status === "rejected" ? { timestamps: { submittedAt: instant(SUBMITTED_AT), lastUpdatedAt: BASE, rejectedAt: BASE } } : {}),
    });

    const failure = expectRefusal(await atomic(listing));

    expect(failure).toEqual({ code: "LISTING_NOT_APPROVED", status });
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("refuses while a pending revision exists, leaving it and the listing untouched", async () => {
    const listing = await seed();

    expect(
      (
        await createPendingRevision(persistence.db, {
          revisionId: randomUUID(),
          revision: proposalFor(listing, PROPOSED_CONTENT),
        })
      ).ok,
    ).toBe(true);

    const before = await storedRow(listing);
    const existing = await revisionRows(listing);

    expect(expectRefusal(await atomic(listing)).code).toBe("PENDING_REVISION_ALREADY_EXISTS");

    // The issue #137 ruling: both are unchanged, and no newly created proposal remains.
    expect(await storedRow(listing)).toEqual(before);
    expect(await revisionRows(listing)).toEqual(existing);
  });

  it("refuses a stale token, distinctly from an advancement failure", async () => {
    const listing = await seed();

    expect(expectRefusal(await atomic(listing, { base: instant(BASE_AT - 1) }))).toEqual({
      code: "STALE_LISTING_VERSION",
    });
    expect(expectRefusal(await atomic(listing, { base: instant(BASE_AT + 1) }))).toEqual({
      code: "STALE_LISTING_VERSION",
    });
    expect(await revisionRows(listing)).toEqual([]);
    expect((await storedRow(listing)).last_updated_at).toBe(BASE_AT);
  });

  it("refuses invalid proposed content as a validation failure, with the fields at fault", async () => {
    const listing = await seed();
    const blankName: ListingContent = { ...PROPOSED_CONTENT, name: "   " };

    const failure = expectRefusal(await atomic(listing, { content: blankName }));

    expect(failure.code).toBe("PROPOSED_CONTENT_INVALID");
    expect(failure).toMatchObject({ violations: expect.any(Array) });
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("refuses a proposal carrying no usable contact method", async () => {
    const listing = await seed();
    const noContact: ListingContent = {
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Kinsale",
      country: "IE",
    };

    expect(expectRefusal(await atomic(listing, { content: noContact })).code).toBe(
      "PROPOSED_CONTENT_INVALID",
    );
  });

  it("refuses a designation widening, reporting every offending field in order", async () => {
    const listing = await seed();
    const widened: ListingContent = {
      ...APPROVED_CONTENT,
      postalCode: { value: "P17 AB12", designatedPublic: true },
      phone: { value: "+353 21 123 4567", designatedPublic: true },
    };

    const failure = expectRefusal(await atomic(listing, { content: widened }));

    if (failure.code !== "DESIGNATION_POLICY_REFUSED") {
      throw new Error(`expected a designation refusal, got ${failure.code}`);
    }

    expect(failure.violations.map((violation) => violation.field)).toEqual(["postalCode", "phone"]);
    // No value travels in a failure.
    expect(JSON.stringify(failure.violations)).not.toContain("P17 AB12");
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("refuses an unusable instant, identifier or token before opening a transaction", async () => {
    const listing = await seed();

    expect(
      expectRefusal(await atomic(listing, { at: Number.NaN as unknown as Instant })).code,
    ).toBe("INVALID_APPROVAL_INSTANT");
    expect(expectRefusal(await atomic(listing, { revisionId: "" })).code).toBe(
      "INVALID_REVISION_IDENTIFIER",
    );
    expect(
      expectRefusal(await atomic(listing, { revisionId: 7 as unknown as string })).code,
    ).toBe("INVALID_REVISION_IDENTIFIER");
    expect(
      expectRefusal(await atomic(listing, { base: undefined as unknown as Instant })).code,
    ).toBe("STALE_LISTING_VERSION");
  });

  it("refuses proposed content the rules cannot inspect, distinctly from invalid content", async () => {
    const listing = await seed();

    const failure = expectRefusal(
      await atomic(listing, { content: null as unknown as ListingContent }),
    );

    expect(failure.code).toBe("INVALID_PROPOSED_CONTENT");
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("decides the lifecycle before the designation rule and the validators", async () => {
    // A pending listing with content that is also invalid and widening: the lifecycle refusal is
    // the one reported, because precedence is decided under the lock before anything else runs.
    const listing = await seed(persistence.db, { status: "pending", publication: undefined });
    const widenedAndInvalid: ListingContent = {
      ...APPROVED_CONTENT,
      name: "  ",
      phone: { value: "+353 21 123 4567", designatedPublic: true },
    };

    expect(expectRefusal(await atomic(listing, { content: widenedAndInvalid })).code).toBe(
      "LISTING_NOT_APPROVED",
    );
  });

  it("decides staleness before the designation rule", async () => {
    const listing = await seed();
    const widened: ListingContent = {
      ...APPROVED_CONTENT,
      phone: { value: "+353 21 123 4567", designatedPublic: true },
    };

    expect(
      expectRefusal(await atomic(listing, { content: widened, base: instant(BASE_AT - 1) })).code,
    ).toBe("STALE_LISTING_VERSION");
  });

  it("carries no partial listing on any failure", async () => {
    const listing = await seed();
    const result = await atomic(listing, { base: instant(BASE_AT - 1) });

    expect(result.ok).toBe(false);
    expect(Object.keys(result)).toEqual(["ok", "error"]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Revision identity                                                                             */
/* ------------------------------------------------------------------------------------------- */

describe("revision identity stays inside the adapter", () => {
  it("never appears in the success value", async () => {
    const listing = await seed();
    const revisionId = randomUUID();

    const applied = expectListing(await atomic(listing, { revisionId }));

    expect(JSON.stringify(applied)).not.toContain(revisionId);
    expect(Object.keys(applied).sort()).toEqual(
      ["content", "id", "publication", "status", "timestamps"].sort(),
    );
  });

  it("reports a duplicate identifier as an identity conflict, never as a DI-11 conflict", async () => {
    const listing = await seed();
    const revisionId = randomUUID();

    // A **rejected** revision occupies the identifier without occupying `DI-11`'s pending slot,
    // so the post-lock pending read finds nothing and the insert hits `listing_revision_pkey`.
    // This is a real primary-key `23505`, not a simulated one.
    await sql`
      insert into listing_revision (
        id, listing_id, state, name, category, description, locality, country,
        rejected_at, base_listing_last_updated_at
      ) values (
        ${revisionId}::uuid, ${listingText(listing)}::uuid, 'rejected',
        'Proposed', 'food-drink', 'Proposed description.', 'Kinsale', 'IE',
        to_timestamp(${BASE_AT}::double precision / 1000),
        to_timestamp(${BASE_AT}::double precision / 1000)
      )
    `.execute(persistence.db);

    const before = await storedRow(listing);
    const failure = expectRefusal(await atomic(listing, { revisionId }));

    expect(failure).toEqual({ code: "REVISION_ALREADY_EXISTS" });
    // Never the `DI-11` vocabulary, and never the ordinary pending refusal.
    expect(failure.code).not.toBe("PENDING_UNIQUENESS_CONFLICT");
    expect(failure.code).not.toBe("PENDING_REVISION_ALREADY_EXISTS");
    // The whole transaction rolled back: the listing is untouched and the rejected row survives.
    expect(await storedRow(listing)).toEqual(before);
    expect(await revisionRows(listing)).toEqual([{ id: revisionId, state: "rejected" }]);
  });

  it("reports the DI-11 index backstop as its own fault, never as an identity conflict", async () => {
    const listing = await seed(hostile.db);

    await installProbe(
      "listing_revision",
      "insert",
      `raise exception 'probe' using errcode = '23505', constraint = 'listing_revision_one_pending_per_listing';`,
      "di11_backstop",
    );

    try {
      const before = await storedRow(listing, hostile.db);
      const failure = expectRefusal(await atomic(listing, { db: hostile.db }));

      expect(failure).toEqual({ code: "PENDING_UNIQUENESS_CONFLICT" });
      expect(failure.code).not.toBe("REVISION_ALREADY_EXISTS");
      expect(await storedRow(listing, hostile.db)).toEqual(before);
      expect(await revisionRows(listing, hostile.db)).toEqual([]);
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });

  it("lets PostgreSQL generate nothing — the identifier column has no default", async () => {
    const defaults = await sql<{ column_name: string; column_default: string | null }>`
      select column_name, column_default
        from information_schema.columns
       where table_name = 'listing_revision' and column_name = 'id'
    `.execute(persistence.db);

    expect(defaults.rows[0]?.column_default).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Executed-statement proof                                                                      */
/* ------------------------------------------------------------------------------------------- */

describe("the statements PostgreSQL actually received", () => {
  it("sets READ COMMITTED explicitly and locks the listing as the first state read", async () => {
    const listing = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(listing, { db: capturing.db }));

    const sqls = capturing.statements.map((statement) => statement.sql);

    expect(sqls.some((statement) => /isolation level read committed/i.test(statement))).toBe(true);

    const firstStateRead = capturing.statements.findIndex(
      (statement) => /^\s*select\b/i.test(statement.sql) || isWrite(statement),
    );

    expect(isListingLock(capturing.statements[firstStateRead] as CapturedStatement)).toBe(true);
    expect(capturing.statements[firstStateRead]?.sql).toMatch(/for update/i);
  });

  it("executes exactly the authorized statements, in the authorized order", async () => {
    const listing = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(listing, { db: capturing.db }));

    const lockIndex = capturing.statements.findIndex(isListingLock);
    const revisionReadIndex = capturing.statements.findIndex(isRevisionRead);
    const insertIndex = capturing.statements.findIndex(isRevisionInsert);
    const updateIndex = capturing.statements.findIndex(isListingUpdate);
    const deleteIndex = capturing.statements.findIndex(isRevisionDelete);

    expect(capturing.statements.filter(isListingLock)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionRead)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionInsert)).toHaveLength(1);
    expect(capturing.statements.filter(isListingUpdate)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionDelete)).toHaveLength(1);

    // `ADR-024`'s order: lock → pending read → insert → guarded update → delete.
    expect(lockIndex).toBeLessThan(revisionReadIndex);
    expect(revisionReadIndex).toBeLessThan(insertIndex);
    expect(insertIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(deleteIndex);
    expect(capturing.statements[revisionReadIndex]?.sql).toMatch(/for update/i);
    // Exactly three writes, and no other.
    expect(capturing.statements.filter(isWrite)).toHaveLength(3);
  });

  it("inserts the transient revision with the exact surface and the original token", async () => {
    const listing = await seed(capturing.db);
    const revisionId = randomUUID();

    capturing.reset();
    expectListing(await atomic(listing, { revisionId, db: capturing.db }));

    const insert = capturing.statements.filter(isRevisionInsert)[0] as CapturedStatement;
    const shape = revisionInsertShapeOf(insert.sql);

    expect([...shape.columns].sort()).toEqual([...AUTHORIZED_INSERT_COLUMNS].sort());
    expect(shape.writesForbiddenColumn).toBeUndefined();
    // No `RETURNING`: no identity contract is invented (`DDM-2`).
    expect(shape.hasReturning).toBe(false);
    expect(insert.parameters).toContain(revisionId);
    expect(insert.parameters).toContain(listingText(listing));
    expect(insert.parameters).toContain("pending");
    expect(insert.parameters).toContain(null);
    // The caller's original token, carried unchanged — never the approval instant.
    const numbers = insert.parameters.filter(
      (parameter): parameter is number => typeof parameter === "number",
    );

    expect(numbers).toContain(BASE_AT);
    expect(numbers).not.toContain(APPLIED_AT);
  });

  it("performs exactly one listing UPDATE, with the authorized SET and the guarded WHERE", async () => {
    const listing = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(listing, { db: capturing.db }));

    const updates = capturing.statements.filter(isListingUpdate);

    expect(updates).toHaveLength(1);

    const shape = guardedUpdateShapeOf((updates[0] as CapturedStatement).sql);

    expect([...shape.setColumns].sort()).toEqual([...AUTHORIZED_SET_COLUMNS].sort());
    expect(shape.setsForbiddenColumn).toBeUndefined();
    expect(shape.whereHasListingId).toBe(true);
    expect(shape.whereHasLastUpdatedAt).toBe(true);
    expect(shape.whereConvertsAnInstant).toBe(true);
  });

  it("binds the caller's ORIGINAL token in the guard, and the approval instant in SET", async () => {
    const listing = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(listing, { db: capturing.db }));

    const update = capturing.statements.filter(isListingUpdate)[0] as CapturedStatement;
    const numbers = update.parameters.filter(
      (parameter): parameter is number => typeof parameter === "number",
    );

    // Both instants appear — the new one in `SET`, the base in `WHERE` — and the base must be
    // there. A refreshed token would also be `BASE_AT` here, which is why the SQL-level
    // assertion above pins the predicate's presence and the mutation suite pins its source.
    expect(numbers).toContain(BASE_AT);
    expect(numbers).toContain(APPLIED_AT);
    expect(update.parameters).toContain(listingText(listing));
  });

  it("deletes the transient revision by identity, listing and pending state", async () => {
    const listing = await seed(capturing.db);
    const revisionId = randomUUID();

    capturing.reset();
    expectListing(await atomic(listing, { revisionId, db: capturing.db }));

    const deletion = capturing.statements.filter(isRevisionDelete)[0] as CapturedStatement;
    const shape = revisionDeleteShapeOf(deletion.sql);

    expect(shape.whereHasId).toBe(true);
    expect(shape.whereHasListingId).toBe(true);
    expect(shape.whereHasState).toBe(true);
    expect(deletion.parameters).toContain(revisionId);
    expect(deletion.parameters).toContain(listingText(listing));
    expect(deletion.parameters).toContain("pending");
  });

  it("writes nothing at all on every pre-insert refusal", async () => {
    const listing = await seed(capturing.db);

    for (const options of [
      { base: instant(BASE_AT - 1) },
      { content: { ...PROPOSED_CONTENT, name: "   " } },
      { content: { ...APPROVED_CONTENT, phone: { value: "+353 21 123 4567", designatedPublic: true } } },
      { at: BASE },
    ]) {
      capturing.reset();
      expectRefusal(await atomic(listing, { ...options, db: capturing.db }));
      expect(capturing.statements.filter(isWrite)).toEqual([]);
    }
  });

  it("never repeats a statement in a way that would be a retry", async () => {
    const listing = await seed(capturing.db);

    capturing.reset();
    expectListing(await atomic(listing, { db: capturing.db }));

    // One transaction, one lock, one of each write: no second attempt of anything.
    expect(
      capturing.statements.filter((statement) => /isolation level read committed/i.test(statement.sql)),
    ).toHaveLength(1);
    expect(capturing.statements.filter(isListingLock)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionInsert)).toHaveLength(1);
    expect(capturing.statements.filter(isListingUpdate)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionDelete)).toHaveLength(1);
  });

  it("makes no second attempt after a retryable conflict", async () => {
    const listing = await seed(hostile.db);
    const hostileCapture = createCapturingPersistence(HOSTILE_DATABASE);

    try {
      await installProbe(
        "listing",
        "update",
        `raise exception 'probe' using errcode = '40001';`,
        "serialization_failure",
      );

      const failure = expectRefusal(await atomic(listing, { db: hostileCapture.db }));

      expect(failure).toEqual({ code: "RETRYABLE_CONFLICT", sqlState: "40001" });
      // Classified, never retried: **one** transaction, one lock, one insert, and no second
      // attempt at any of them. The `UPDATE` that raised is reported by Kysely as an `error`
      // event rather than a `query` event, so its absence here is expected — what matters is
      // that nothing was tried twice.
      expect(
        hostileCapture.statements.filter((statement) =>
          /isolation level read committed/i.test(statement.sql),
        ),
      ).toHaveLength(1);
      expect(hostileCapture.statements.filter(isListingLock)).toHaveLength(1);
      expect(hostileCapture.statements.filter(isRevisionInsert)).toHaveLength(1);
      expect(hostileCapture.statements.filter(isRevisionDelete)).toEqual([]);
      expect(await revisionRows(listing, hostile.db)).toEqual([]);
    } finally {
      await dropProbeTriggers(hostile.db);
      await hostileCapture.shutdown();
    }
  });
});

describe("the statement analysers are not vacuous", () => {
  const sample = (statementSql: string): CapturedStatement => ({
    sql: statementSql,
    parameters: [],
  });

  it("rejects an UPDATE that assigns the timestamp but does not compare it", () => {
    const shape = guardedUpdateShapeOf(
      'update "listing" set "name" = $1, "last_updated_at" = to_timestamp($2) where "id" = $3',
    );

    expect(shape.setColumns).toContain("last_updated_at");
    expect(shape.whereHasListingId).toBe(true);
    // The missing guard: this is exactly what a whole-statement search would have passed.
    expect(shape.whereHasLastUpdatedAt).toBe(false);
  });

  it("rejects an UPDATE missing the listing-id predicate", () => {
    const shape = guardedUpdateShapeOf(
      'update "listing" set "name" = $1 where "last_updated_at" = to_timestamp($2)',
    );

    expect(shape.whereHasListingId).toBe(false);
  });

  it("rejects an UPDATE that sets a forbidden column", () => {
    for (const column of ["id", "status", "submitted_at", "rejected_at", "publication_state"]) {
      const shape = guardedUpdateShapeOf(
        `update "listing" set "name" = $1, "${column}" = $2 where "id" = $3 and "last_updated_at" = to_timestamp($4)`,
      );

      expect(shape.setsForbiddenColumn).toBe(column);
    }
  });

  it("rejects an UPDATE whose SET omits an authorized content column", () => {
    const shape = guardedUpdateShapeOf(
      'update "listing" set "name" = $1 where "id" = $2 and "last_updated_at" = to_timestamp($3)',
    );

    expect([...shape.setColumns].sort()).not.toEqual([...AUTHORIZED_SET_COLUMNS].sort());
  });

  it("rejects an UPDATE whose predicate names the token only inside another clause", () => {
    // A hostile sample whose `SET` mentions a column named like the guard, so a naive search of
    // the whole statement would find `last_updated_at` twice and conclude the guard is present.
    const shape = guardedUpdateShapeOf(
      'update "listing" set "last_updated_at" = to_timestamp($1), "name" = $2 where "id" = $3',
    );

    expect(shape.whereHasLastUpdatedAt).toBe(false);
  });

  it("rejects an INSERT missing a required column, carrying a forbidden one, or RETURNING", () => {
    const missing = revisionInsertShapeOf(
      'insert into "listing_revision" ("id", "listing_id", "state") values ($1, $2, $3)',
    );

    expect([...missing.columns].sort()).not.toEqual([...AUTHORIZED_INSERT_COLUMNS].sort());

    const forbidden = revisionInsertShapeOf(
      'insert into "listing_revision" ("id", "created_at") values ($1, $2)',
    );

    expect(forbidden.writesForbiddenColumn).toBe("created_at");

    const returning = revisionInsertShapeOf(
      'insert into "listing_revision" ("id") values ($1) returning "id"',
    );

    expect(returning.hasReturning).toBe(true);
  });

  it("rejects a DELETE weakened to listing-id-only or state-only", () => {
    const listingOnly = revisionDeleteShapeOf(
      'delete from "listing_revision" where "listing_id" = $1',
    );

    expect(listingOnly.whereHasListingId).toBe(true);
    // The weakening: `"listing_id"` contains `id`, so a looser analyser would pass this.
    expect(listingOnly.whereHasId).toBe(false);
    expect(listingOnly.whereHasState).toBe(false);

    const stateOnly = revisionDeleteShapeOf(
      `delete from "listing_revision" where "state" = 'pending'`,
    );

    expect(stateOnly.whereHasId).toBe(false);
    expect(stateOnly.whereHasListingId).toBe(false);
  });

  it("rejects a trace whose revision read precedes the listing lock", () => {
    const hostileTrace: readonly CapturedStatement[] = [
      sample('select "id" from "listing_revision" where "listing_id" = $1 for update'),
      sample('select * from "listing" where "id" = $1 for update'),
    ];

    const lockIndex = hostileTrace.findIndex(isListingLock);
    const revisionIndex = hostileTrace.findIndex(isRevisionRead);

    expect(revisionIndex).toBeLessThan(lockIndex);
  });

  it("rejects a trace whose cleanup precedes the listing update, or that omits either", () => {
    const reordered: readonly CapturedStatement[] = [
      sample('insert into "listing_revision" ("id") values ($1)'),
      sample('delete from "listing_revision" where "id" = $1'),
      sample('update "listing" set "name" = $1 where "id" = $2'),
    ];

    expect(reordered.findIndex(isRevisionDelete)).toBeLessThan(
      reordered.findIndex(isListingUpdate),
    );

    const noCleanup: readonly CapturedStatement[] = [
      sample('insert into "listing_revision" ("id") values ($1)'),
      sample('update "listing" set "name" = $1 where "id" = $2'),
    ];

    expect(noCleanup.filter(isRevisionDelete)).toEqual([]);

    const noInsert: readonly CapturedStatement[] = [
      sample('update "listing" set "name" = $1 where "id" = $2'),
    ];

    expect(noInsert.filter(isRevisionInsert)).toEqual([]);
  });

  it("notices an extra write and distinguishes every statement kind", () => {
    const extra: readonly CapturedStatement[] = [
      sample('insert into "listing_revision" ("id") values ($1)'),
      sample('update "listing" set "name" = $1 where "id" = $2'),
      sample('update "listing" set "name" = $1 where "id" = $2'),
      sample('delete from "listing_revision" where "id" = $1'),
    ];

    expect(extra.filter(isListingUpdate)).toHaveLength(2);
    expect(extra.filter(isWrite)).toHaveLength(4);

    expect(isListingLock(sample('select * from "listing" where "id" = $1 for update'))).toBe(true);
    expect(
      isListingLock(
        sample('select "id" from "listing_revision" where "listing_id" = $1 for update'),
      ),
    ).toBe(false);
    expect(isListingLock(sample('select * from "listing" where "id" = $1'))).toBe(false);
    expect(isRevisionInsert(sample('insert into "listing" ("id") values ($1)'))).toBe(false);
    expect(isRevisionDelete(sample('delete from "listing" where "id" = $1'))).toBe(false);
    expect(isWrite(sample('select * from "listing"'))).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Test-only fault injection — atomicity and rollback                                            */
/* ------------------------------------------------------------------------------------------- */

describe("outcomes the protocol says are unreachable", () => {
  it("reports a suppressed revision INSERT loudly, and changes nothing", async () => {
    const listing = await seed(hostile.db);

    await installProbe("listing_revision", "insert", `return null;`, "suppress_insert");

    try {
      const before = await storedRow(listing, hostile.db);
      const failure = expectRefusal(await atomic(listing, { db: hostile.db }));

      expect(failure.code).toBe("REVISION_INSERT_PROTOCOL_FAILURE");
      expect(await storedRow(listing, hostile.db)).toEqual(before);
      expect(await revisionRows(listing, hostile.db)).toEqual([]);
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });

  it("rolls the transient INSERT back when the guarded UPDATE matches no row", async () => {
    const listing = await seed(hostile.db);

    await installProbe("listing", "update", `return null;`, "suppress_update");

    try {
      const before = await storedRow(listing, hostile.db);
      const failure = expectRefusal(await atomic(listing, { db: hostile.db }));

      expect(failure.code).toBe("GUARDED_UPDATE_PROTOCOL_FAILURE");
      expect(await storedRow(listing, hostile.db)).toEqual(before);
      // The whole point of the atomic unit: no partial revision survives.
      expect(await revisionRows(listing, hostile.db)).toEqual([]);
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });

  it("rolls the listing UPDATE back when the revision cleanup matches no row", async () => {
    const listing = await seed(hostile.db);

    await installProbe("listing_revision", "delete", `return null;`, "suppress_delete");

    try {
      const before = await storedRow(listing, hostile.db);
      const failure = expectRefusal(await atomic(listing, { db: hostile.db }));

      expect(failure.code).toBe("INVALID_LIFECYCLE_STATE");
      // The applied content and the advanced timestamp are both gone again.
      expect(await storedRow(listing, hostile.db)).toEqual(before);
      expect((await storedRow(listing, hostile.db)).last_updated_at).toBe(BASE_AT);
      expect(await revisionRows(listing, hostile.db)).toEqual([]);
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });

  it("rolls everything back when a write raises an integrity failure", async () => {
    const listing = await seed(hostile.db);

    await installProbe(
      "listing",
      "update",
      `raise exception 'probe' using errcode = '23514', constraint = 'probe_check';`,
      "integrity_on_update",
    );

    try {
      const before = await storedRow(listing, hostile.db);
      const failure = expectRefusal(await atomic(listing, { db: hostile.db }));

      expect(failure.code).toBe("INTEGRITY_CONFLICT");
      expect(failure).toMatchObject({ sqlState: "23514" });
      expect(await storedRow(listing, hostile.db)).toEqual(before);
      expect(await revisionRows(listing, hostile.db)).toEqual([]);
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });

  it("carries no SQL, credential or proposal content in a storage diagnosis", async () => {
    const listing = await seed(hostile.db);

    await installProbe(
      "listing_revision",
      "insert",
      `raise exception 'probe with %', 'detail' using errcode = '22000';`,
      "unexpected_state",
    );

    try {
      const failure = expectRefusal(await atomic(listing, { db: hostile.db }));
      const serialized = JSON.stringify(failure);

      expect(failure.code).toBe("STORAGE_FAILURE");
      expect(serialized).not.toContain("insert into");
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain(PROPOSED_CONTENT.name);
      // The cause is carried for diagnosis but never enumerated into a payload.
      expect(Object.keys(JSON.parse(serialized) as object)).not.toContain("cause");
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });

  it("leaves no session idle in transaction after a forced failure", async () => {
    const listing = await seed(hostile.db);

    await installProbe("listing", "update", `return null;`, "suppress_update_sessions");

    try {
      expectRefusal(await atomic(listing, { db: hostile.db }));

      const idle = await sql<{ count: number }>`
        select count(*)::int as count
          from pg_stat_activity
         where datname = current_database()
           and state in ('idle in transaction', 'idle in transaction (aborted)')
      `.execute(hostile.db);

      expect(idle.rows[0]?.count ?? 0).toBe(0);
    } finally {
      await dropProbeTriggers(hostile.db);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Deterministic concurrency                                                                     */
/* ------------------------------------------------------------------------------------------- */

describe("the PS-11 lock, under contention", () => {
  it("blocks behind a lock-only participant, then succeeds when it releases", async () => {
    const listing = await seed();
    let applied: Listing | undefined;

    await withRivalLock(listing, async (trx) => {
      const pending = atomic(listing);

      // The boundary must actually be blocked before the rival releases, or the test would
      // prove nothing about ordering.
      await awaitLockWaiter();
      await trx.rollback().execute();

      applied = expectListing(await pending);
    });

    // A participant that only locked and mutated nothing leaves the token unchanged, so the
    // operation proceeds — `ADR-024`'s discriminating `READ COMMITTED` visibility case.
    expect(applied?.content).toEqual(PROPOSED_CONTENT);
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("refuses as stale after waiting for a participant that advanced the row", async () => {
    const listing = await seed();
    let failure: AtomicRevisionFailure | undefined;

    await withRivalLock(listing, async (trx) => {
      const pending = atomic(listing);

      await awaitLockWaiter();

      // The rival advances the row itself, then commits while the boundary waits.
      await trx
        .updateTable("listing")
        .set({
          last_updated_at: sql<number>`to_timestamp(${APPLIED_AT}::double precision / 1000)`,
        })
        .where("id", "=", listingText(listing))
        .execute();
      await trx.commit().execute();

      failure = expectRefusal(await pending);
    });

    expect(failure).toEqual({ code: "STALE_LISTING_VERSION" });
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("sees a pending revision committed while it waited, and refuses under the ruling", async () => {
    const listing = await seed();
    let failure: AtomicRevisionFailure | undefined;
    const rivalRevisionId = randomUUID();

    await withRivalLock(listing, async (trx) => {
      const pending = atomic(listing);

      await awaitLockWaiter();

      // `OP-6`'s row, committed while the atomic path waits. Its own statement snapshot after
      // the lock is released is what makes this observable — the `PS-11` visibility requirement.
      await sql`
        insert into listing_revision (
          id, listing_id, state, name, category, description, locality, country,
          base_listing_last_updated_at
        ) values (
          ${rivalRevisionId}::uuid, ${listingText(listing)}::uuid, 'pending',
          'Proposed', 'food-drink', 'Proposed description.', 'Kinsale', 'IE',
          to_timestamp(${BASE_AT}::double precision / 1000)
        )
      `.execute(trx);
      await trx.commit().execute();

      failure = expectRefusal(await pending);
    });

    expect(failure).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
    // Decided under the lock, not by the index: the rival's row is untouched.
    expect(await revisionRows(listing)).toEqual([{ id: rivalRevisionId, state: "pending" }]);
    expect((await storedRow(listing)).last_updated_at).toBe(BASE_AT);
  });

  it("no participant can observe the transient revision", async () => {
    const listing = await seed();
    let observedDuring = -1;

    await withRivalLock(listing, async (trx) => {
      const pending = atomic(listing);

      await awaitLockWaiter();

      // While the boundary is blocked it has executed nothing, so there is no transient row;
      // once the rival releases, the boundary's insert and delete are both inside its own
      // transaction and this session can never land between them without the lock.
      observedDuring = (await revisionRows(listing, rival.db)).length;

      await trx.rollback().execute();
      expectListing(await pending);
    });

    expect(observedDuring).toBe(0);
    expect(await revisionRows(listing)).toEqual([]);
  });

  it("makes a second atomic attempt with the same original token stale", async () => {
    const listing = await seed();

    expectListing(await atomic(listing));

    // `FR-ADM-10b` versus `FR-ADM-10b`: whichever commits first advances the token, so the
    // loser's capture is unequal and it is refused as stale — never partially applied.
    expect(expectRefusal(await atomic(listing)).code).toBe("STALE_LISTING_VERSION");
    expect(await revisionRows(listing)).toEqual([]);
    expect((await storedRow(listing)).last_updated_at).toBe(APPLIED_AT);
  });

  it("makes an equal-content second attempt stale too", async () => {
    const listing = await seed();

    expectListing(await atomic(listing, { content: APPROVED_CONTENT }));

    expect(
      expectRefusal(await atomic(listing, { content: APPROVED_CONTENT })).code,
    ).toBe("STALE_LISTING_VERSION");
  });

  it("leaves OP-6 creation stale, and OP-10 and rejection with nothing pending", async () => {
    const listing = await seed();

    expectListing(await atomic(listing));

    // `OP-6` with the pre-operation token: stale, because the atomic path advanced the listing.
    const creation = await createPendingRevision(persistence.db, {
      revisionId: randomUUID(),
      revision: proposalFor(listing, PROPOSED_CONTENT),
    });

    expect(creation.ok).toBe(false);
    expect(creation.ok === false && creation.error.code).toBe("STALE_LISTING_VERSION");

    // `OP-10`: the transient proposal never survived, so there is nothing to approve.
    const approval = await approveAndApplyPendingRevision(persistence.db, {
      listingId: listing.id,
      approvedAt: instant(APPLIED_AT + 1_000),
    });

    expect(approval.ok).toBe(false);
    expect(approval.ok === false && approval.error.code).toBe("PENDING_REVISION_NOT_FOUND");

    // Rejection: likewise nothing pending, and never reported as stale.
    const rejection = await rejectPendingRevision(persistence.db, {
      listingId: listing.id,
      rejectedAt: instant(APPLIED_AT + 1_000),
    });

    expect(rejection.ok).toBe(false);
    expect(rejection.ok === false && rejection.error.code).toBe("PENDING_REVISION_NOT_FOUND");
  });

  it("releases the rival lock even when the test body throws", async () => {
    // The `finally` in `withRivalLock` exists for exactly this case: every other test in this
    // file settles the rival transaction itself, so the guard is unexercised unless a body
    // fails. Removing that cleanup would leave a lock behind and hang `afterEach`, which is why
    // it is proved here rather than assumed.
    const listing = await seed();
    const bodyFailure = new Error("deliberate body failure");

    await expect(
      withRivalLock(listing, async () => {
        throw bodyFailure;
      }),
    ).rejects.toBe(bodyFailure);

    // The lock is gone: the boundary runs to completion without waiting for anything.
    expectListing(await atomic(listing));
    expect(await sessionsInTransaction()).toBe(0);
  });

  it("cannot be paired with FR-ADM-04 on one listing, and the refusals prove why", async () => {
    // `FR-ADM-04` requires a **pending** listing; this path requires an **approved** one, and
    // `NFR-DATA-02` admits no approved-to-pending transition. The pairing is unconstructible,
    // and each path refuses the other's subject rather than acting on it.
    const approved = await seed();
    const pending = await seed(persistence.db, { status: "pending", publication: undefined });

    const editOnApproved = await applyAdministrativeEditToPendingListing(persistence.db, {
      listingId: approved.id,
      baseListingLastUpdatedAt: BASE,
      edit: { locality: { kind: "supply", value: "Cobh" } },
      at: LATER,
    });

    expect(editOnApproved.ok).toBe(false);
    expect(editOnApproved.ok === false && editOnApproved.error.code).toBe("LISTING_NOT_PENDING");

    expect(expectRefusal(await atomic(pending)).code).toBe("LISTING_NOT_APPROVED");
  });
});
