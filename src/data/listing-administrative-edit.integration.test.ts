/**
 * Attacking tests for the `FR-ADM-04` persistence path against a real PostgreSQL server
 * (issue #217).
 *
 * `ADR-024` names its own material tradeoff: correctness depends on **enforced statement and
 * lock order** rather than on the engine, *"which makes deterministic interleaving tests
 * mandatory"*. This path adds two things `OP-6` and `OP-10` never had to prove — a success that
 * **writes nothing at all**, and a prescribed revision read whose result is an **invariant**
 * rather than a decision — so the attacks below are as much about absence as about ordering.
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
 * Two states cannot arise under the lock: a guarded `UPDATE` affecting zero rows, and a
 * **pending listing carrying a pending revision**. Both are produced only in a **disposable
 * database this suite owns** — the first with a test-only `BEFORE` trigger that returns `NULL`,
 * the second by inserting a revision row directly. Triggers are dropped in each test's `finally`
 * and swept unconditionally in `afterEach`; nothing in `src/` knows either mechanism exists.
 * **No production fault-injection hook is introduced, and no production path capable of creating
 * that revision state is added.**
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Kysely,
  PostgresDialect,
  sql,
  type ControlledTransaction,
} from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

import type { AdministrativeEdit } from "../domain/listing/administrative-edit";
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
import {
  applyAdministrativeEditToPendingListing,
  type AdministrativeEditPersistenceFailure,
} from "./listing-administrative-edit";

const VERIFIED_DATABASE = "administrative_edit_verification";
/** A second database this suite owns, where impossible states may be constructed. */
const HOSTILE_DATABASE = "administrative_edit_hostile";

const cluster = useEmbeddedPostgres({
  slug: "admin-edit",
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

const RIVAL_APPLICATION_NAME = "administrative_edit_rival";

const SUBMITTED_AT = 1_767_323_040_000;
const BASE_AT = 1_767_323_045_123;
/** Strictly later than `BASE_AT`, as `DI-6` requires of a material edit. */
const EDIT_AT = BASE_AT + 1_000;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

const BASE = instant(BASE_AT);
const LATER = instant(EDIT_AT);

/** Content a pending submission may lawfully arrive with. */
const SUBMITTED_CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

/** The same, carrying every optional field, so removals and restrictions have something to act on. */
const COMPLETE_CONTENT: ListingContent = {
  ...SUBMITTED_CONTENT,
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: "+353 21 123 4567", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: "https://example.ie", designatedPublic: false },
};

function pendingListing(content: ListingContent = SUBMITTED_CONTENT): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "pending",
    content,
    timestamps: { submittedAt: instant(SUBMITTED_AT), lastUpdatedAt: BASE },
  };
}

function listingText(listing: Listing): string {
  return (listing.id as unknown as { readonly supplied: string }).supplied;
}

const supply = <T>(value: T) => ({ kind: "supply", value }) as const;
const PRESERVE = { kind: "preserve" } as const;
const REMOVE = { kind: "remove" } as const;

async function seed(
  content: ListingContent = SUBMITTED_CONTENT,
  db = persistence.db,
  overrides: Partial<Listing> = {},
): Promise<Listing> {
  const listing = { ...pendingListing(content), ...overrides };

  expect((await insertSubmittedListing(db, listing)).ok).toBe(true);

  return listing;
}

async function edit(
  listing: Listing,
  administrativeEdit: AdministrativeEdit,
  options: { at?: Instant; base?: Instant; db?: Kysely<ListingDatabase> } = {},
) {
  return await applyAdministrativeEditToPendingListing(options.db ?? persistence.db, {
    listingId: listing.id,
    // `in`, not `??`: a test that deliberately supplies an unusable token must not have it
    // silently replaced by the default, which is how this helper first hid that very case.
    baseListingLastUpdatedAt: "base" in options ? (options.base as Instant) : BASE,
    edit: administrativeEdit,
    at: options.at ?? LATER,
  });
}

function expectRefusal(
  result: Awaited<ReturnType<typeof edit>>,
): AdministrativeEditPersistenceFailure {
  if (result.ok) {
    throw new Error("expected a refusal, got a listing");
  }

  return result.error;
}

function expectListing(result: Awaited<ReturnType<typeof edit>>): Listing {
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

async function revisionRowCount(listing: Listing, db = persistence.db): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count
      from listing_revision where listing_id = ${listingText(listing)}::uuid
  `.execute(db);

  return rows.rows[0]?.count ?? 0;
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
    options: startupOptionsFor({ application_name: "administrative_edit_capture" }),
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

const isRevisionWrite = (statement: CapturedStatement): boolean =>
  /^\s*(update|insert|delete)\b[\s\S]*"listing_revision"/i.test(statement.sql);

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
 * the predicate removed. The sibling `OP-10` suite established this; here the `SET` column list
 * is extracted in full as well, so an omitted or forbidden column is named rather than guessed.
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

/** The exact column surface a material administrative edit may write. */
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
const TRIGGER_PREFIX = "admin_edit_probe_";

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

type Operation = typeof applyAdministrativeEditToPendingListing;
type Request = Parameters<Operation>[1];

/** The request carries exactly the four authorized values, and nothing else. */
type _RequestSurface = Assert<
  Equals<keyof Request, "listingId" | "baseListingLastUpdatedAt" | "edit" | "at">
>;
/** No caller-supplied Listing, revision identifier, role, retry, transaction or clock. */
type _NoListing = Assert<Equals<Extract<keyof Request, "listing" | "content">, never>>;
type _NoRevisionId = Assert<Equals<Extract<keyof Request, "revisionId" | "revision">, never>>;
type _NoRole = Assert<Equals<Extract<keyof Request, "role" | "actor" | "override">, never>>;
type _NoRetry = Assert<Equals<Extract<keyof Request, "retries" | "attempts" | "trx" | "now">, never>>;
/** Exactly two parameters: the boundary and the request. */
type _Arity = Assert<Equals<Parameters<Operation>["length"], 2>>;
/** The success type is the governed Listing. */
type _Success = Assert<
  Equals<Awaited<ReturnType<Operation>>, import("../domain/listing/result").Result<Listing, AdministrativeEditPersistenceFailure>>
>;
/** No `Date` crosses the boundary in either direction. */
type _NoDateIn = Assert<Equals<Extract<Request[keyof Request], Date>, never>>;
/** `EXHAUSTED_RETRY` is absent — `ADR-024` item 12 authorizes no retry. */
type _NoExhaustedRetry = Assert<
  Equals<Extract<AdministrativeEditPersistenceFailure, { code: "EXHAUSTED_RETRY" }>, never>
>;
/** The four `ADR-024` item 17–18 kinds stay apart, each with its own distinct payload. */
type _StaleIsBare = Assert<
  Equals<
    Extract<AdministrativeEditPersistenceFailure, { code: "STALE_LISTING_VERSION" }>,
    { readonly code: "STALE_LISTING_VERSION" }
  >
>;
type _TimestampIsBare = Assert<
  Equals<
    Extract<AdministrativeEditPersistenceFailure, { code: "EDIT_INSTANT_NOT_LATER" }>,
    { readonly code: "EDIT_INSTANT_NOT_LATER" }
  >
>;
type _ContentCarriesValidation = Assert<
  Equals<
    Extract<AdministrativeEditPersistenceFailure, { code: "EDITED_CONTENT_INVALID" }>["violations"],
    readonly import("../domain/listing/validation").ValidationViolation[]
  >
>;
type _DesignationCarriesDesignation = Assert<
  Equals<
    Extract<AdministrativeEditPersistenceFailure, { code: "DESIGNATION_POLICY_REFUSED" }>["violations"],
    readonly import("../domain/listing/designation").DesignationViolation[]
  >
>;
/** No revision-resolution code leaked into this path's vocabulary. */
type _NoRevisionCodes = Assert<
  Equals<
    Extract<
      AdministrativeEditPersistenceFailure,
      { code: "PENDING_REVISION_NOT_FOUND" | "PENDING_REVISION_ALREADY_EXISTS" | "MULTIPLE_PENDING_REVISIONS" }
    >,
    never
  >
>;

describe("the protected column surface stays protected", () => {
  it("rejects every forbidden column at compile time through the existing update types", () => {
    // The tripwire is the type, not this test: `id`, `status`, `submitted_at`, `rejected_at`,
    // `publication_state` and `unpublish_reason` are `never` on update in `listing-table.ts`, so
    // the expressions below do not compile. Verified experimentally during development by
    // widening two of them and watching `tsc` fail for the intended reason, then restoring the
    // file byte-for-byte. Recorded here as the exact surface a material edit may write.
    expect([...AUTHORIZED_SET_COLUMNS].sort()).toEqual(
      [
        "administrative_area",
        "category",
        "country",
        "description",
        "email",
        "email_designated_public",
        "last_updated_at",
        "locality",
        "name",
        "phone",
        "phone_designated_public",
        "postal_code",
        "postal_code_designated_public",
        "website",
        "website_designated_public",
      ].sort(),
    );
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Repository behaviour                                                                          */
/* ------------------------------------------------------------------------------------------- */

describe("material edits", () => {
  it("applies an edit to every one of the ten content fields", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const result = expectListing(
      await edit(listing, {
        name: supply("Harbour Bakery & Cafe"),
        category: supply("retail-shopping"),
        description: supply("A bakery and cafe."),
        locality: supply("Cobh"),
        country: supply("FR"),
        administrativeArea: supply("Co. Waterford"),
        postalCode: supply({ value: "P17 CD34", designatedPublic: false }),
        phone: supply({ value: "+353 21 765 4321", designatedPublic: false }),
        email: supply({ value: "contact@example.ie", designatedPublic: false }),
        website: supply({ value: "https://example.ie/contact", designatedPublic: false }),
      }),
    );

    expect(result.timestamps.lastUpdatedAt).toEqual(LATER);
    // The returned aggregate is the domain's own value and must agree with what was written —
    // a result reconstructed from the pre-edit content would pass every row assertion below.
    expect(result.content.name).toBe("Harbour Bakery & Cafe");
    expect(result.content.locality).toBe("Cobh");
    expect(result.content.postalCode).toEqual({ value: "P17 CD34", designatedPublic: false });
    expect(result.content.administrativeArea).toBe("Co. Waterford");

    const row = await storedRow(listing);

    expect(row.name).toBe("Harbour Bakery & Cafe");
    expect(row.category).toBe("retail-shopping");
    expect(row.description).toBe("A bakery and cafe.");
    expect(row.locality).toBe("Cobh");
    expect(row.country).toBe("FR");
    expect(row.administrative_area).toBe("Co. Waterford");
    expect(row.postal_code).toBe("P17 CD34");
    expect(row.phone).toBe("+353 21 765 4321");
    expect(row.email).toBe("contact@example.ie");
    expect(row.website).toBe("https://example.ie/contact");
    expect(row.last_updated_at).toBe(EDIT_AT);
  });

  it("removes every optional field that may lawfully be removed", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    expectListing(
      await edit(listing, {
        administrativeArea: REMOVE,
        postalCode: REMOVE,
        phone: REMOVE,
        email: REMOVE,
        website: REMOVE,
      }),
    );

    const row = await storedRow(listing);

    expect(row.administrative_area).toBeNull();
    expect(row.postal_code).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
    expect(row.website).toBeNull();
    // A removal leaves no surviving designation (`ADR-025`); the columns fail closed.
    expect(row.postal_code_designated_public).toBe(false);
    expect(row.email_designated_public).toBe(false);
  });

  it("applies a public-to-private restriction as a material change", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    expectListing(
      await edit(listing, { email: supply({ value: "hello@example.ie", designatedPublic: false }) }),
    );

    const row = await storedRow(listing);

    expect(row.email).toBe("hello@example.ie");
    expect(row.email_designated_public).toBe(false);
    expect(row.last_updated_at).toBe(EDIT_AT);
  });

  it("normalizes nothing — a re-spaced carrier is a replacement and becomes private", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    expectListing(await edit(listing, { phone: supply({ value: "+353211234567" }) }));

    const row = await storedRow(listing);

    expect(row.phone).toBe("+353211234567");
    expect(row.phone_designated_public).toBe(false);
  });

  it("round-trips the instant exactly, including a pre-epoch moment", async () => {
    const preEpochBase = instant(-2_000);
    const preEpochEdit = instant(-1_000);
    const listing = await seed(SUBMITTED_CONTENT, persistence.db, {
      timestamps: { submittedAt: instant(-3_000), lastUpdatedAt: preEpochBase },
    });

    expectListing(
      await edit(listing, { locality: supply("Cobh") }, { base: preEpochBase, at: preEpochEdit }),
    );

    expect((await storedRow(listing)).last_updated_at).toBe(-1_000);
  });

  it("leaves every protected field byte-identical and writes no revision row", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const before = await storedRow(listing);

    expectListing(await edit(listing, { locality: supply("Cobh") }));

    const after = await storedRow(listing);

    expect(after.id).toBe(before.id);
    expect(after.status).toBe("pending");
    expect(after.submitted_at).toBe(before.submitted_at);
    expect(after.rejected_at).toBeNull();
    expect(after.publication_state).toBeNull();
    expect(after.unpublish_reason).toBeNull();
    expect(await revisionRowCount(listing)).toBe(0);
  });
});

describe("refusals", () => {
  it("refuses a missing listing and writes nothing", async () => {
    const absent = pendingListing();

    expect(expectRefusal(await edit(absent, { locality: supply("Cobh") }))).toEqual({
      code: "LISTING_NOT_FOUND",
    });
  });

  it("refuses a non-pending listing through the domain", async () => {
    const listing = await seed();

    await sql`update listing set status = 'rejected', rejected_at = to_timestamp(${BASE_AT}::double precision / 1000) where id = ${listingText(listing)}::uuid`.execute(
      persistence.db,
    );

    expect(expectRefusal(await edit(listing, { locality: supply("Cobh") }))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "rejected",
    });
  });

  it("refuses an approved listing with a NORMAL pending revision as a lifecycle error", async () => {
    // Production-reachable with no hostile state at all: `OP-6` creates exactly this. Reading
    // the revision before deciding the lifecycle would report it as the loud invariant failure
    // and assert something false about it, collapsing two of `ADR-024` item 17's kinds.
    const listing = await seed(SUBMITTED_CONTENT, persistence.db, {
      status: "approved",
      publication: { value: "publicly_available" },
    });

    expect(
      (
        await createPendingRevision(persistence.db, {
          revisionId: randomUUID(),
          revision: {
            listingId: listing.id,
            state: "pending",
            proposedContent: { ...SUBMITTED_CONTENT, locality: "Cobh" },
            baseListingLastUpdatedAt: BASE,
          } as PendingListingRevision,
        })
      ).ok,
    ).toBe(true);

    expect(expectRefusal(await edit(listing, { locality: supply("Cobh") }))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "approved",
    });

    // The ordinary pending revision is untouched by the refusal.
    expect(await revisionRowCount(listing)).toBe(1);
  });

  it("refuses a stale token, distinctly from every neighbour, and writes nothing", async () => {
    const listing = await seed();
    const before = await storedRow(listing);

    expect(
      expectRefusal(
        await edit(listing, { locality: supply("Cobh") }, { base: instant(BASE_AT - 1) }),
      ),
    ).toEqual({ code: "STALE_LISTING_VERSION" });

    expect(await storedRow(listing)).toEqual(before);
  });

  it("decides the lifecycle before the stale token, as the sibling PS-11 paths do", async () => {
    const listing = await seed();

    // `insertSubmittedListing` stores pending submissions only, so the lifecycle is moved by SQL,
    // exactly as the non-pending test above does.
    await sql`update listing set status = 'rejected', rejected_at = to_timestamp(${BASE_AT}::double precision / 1000) where id = ${listingText(listing)}::uuid`.execute(
      persistence.db,
    );

    // Both would refuse. The lifecycle one wins, decided from the locked row.
    expect(
      expectRefusal(
        await edit(listing, { locality: supply("Cobh") }, { base: instant(BASE_AT - 1) }),
      ),
    ).toEqual({ code: "LISTING_NOT_PENDING", status: "rejected" });
  });

  it("refuses a malformed patch", async () => {
    const listing = await seed();
    const malformed = { name: { kind: "keep" } } as unknown as AdministrativeEdit;

    expect(expectRefusal(await edit(listing, malformed)).code).toBe("INVALID_ADMINISTRATIVE_EDIT");
  });

  it("accumulates every content violation, in the validator's order", async () => {
    const listing = await seed();

    expect(
      expectRefusal(
        await edit(listing, { name: supply("  "), description: supply(""), country: supply("\t") }),
      ),
    ).toEqual({
      code: "EDITED_CONTENT_INVALID",
      violations: [
        { code: "REQUIRED_VALUE_MISSING", field: "name" },
        { code: "REQUIRED_VALUE_MISSING", field: "description" },
        { code: "REQUIRED_VALUE_MISSING", field: "country" },
      ],
    });
  });

  it("accumulates designation violations across all four fields in governed order", async () => {
    const listing = await seed({
      ...SUBMITTED_CONTENT,
      postalCode: { value: "P17 AB12", designatedPublic: false },
      phone: { value: "+353 21 123 4567", designatedPublic: false },
      email: { value: "hello@example.ie", designatedPublic: false },
      website: { value: "https://example.ie", designatedPublic: false },
    });

    expect(
      expectRefusal(
        await edit(listing, {
          // Listed out of policy order deliberately, to prove the *policy's* order is reported.
          website: supply({ value: "https://example.ie/new", designatedPublic: true }),
          email: supply({ value: "hello@example.ie", designatedPublic: true }),
          phone: supply({ value: "+353 21 765 4321", designatedPublic: true }),
          postalCode: supply({ value: "P17 AB12", designatedPublic: true }),
        }),
      ),
    ).toEqual({
      code: "DESIGNATION_POLICY_REFUSED",
      violations: [
        { code: "DESIGNATION_WIDENING_REFUSED", field: "postalCode", change: "unchanged" },
        { code: "DESIGNATION_WIDENING_REFUSED", field: "phone", change: "replaced" },
        { code: "DESIGNATION_WIDENING_REFUSED", field: "email", change: "unchanged" },
        { code: "DESIGNATION_WIDENING_REFUSED", field: "website", change: "replaced" },
      ],
    });
  });

  it("refuses a public addition and leaves the row untouched", async () => {
    const listing = await seed();
    const before = await storedRow(listing);

    expect(
      expectRefusal(
        await edit(listing, { phone: supply({ value: "+353 21 123 4567", designatedPublic: true }) }),
      ).code,
    ).toBe("DESIGNATION_POLICY_REFUSED");

    expect(await storedRow(listing)).toEqual(before);
  });

  it("refuses an equal or earlier instant on a material edit, never as stale input", async () => {
    const listing = await seed();

    for (const at of [BASE, instant(BASE_AT - 1)]) {
      expect(expectRefusal(await edit(listing, { locality: supply("Cobh") }, { at }))).toEqual({
        code: "EDIT_INSTANT_NOT_LATER",
      });
    }

    expect((await storedRow(listing)).last_updated_at).toBe(BASE_AT);
  });

  it("refuses an unusable base token before opening a transaction", async () => {
    const listing = await seed();

    expect(
      expectRefusal(
        await edit(listing, { locality: supply("Cobh") }, { base: null as unknown as Instant }),
      ),
    ).toEqual({ code: "STALE_LISTING_VERSION" });
  });

  it("reports an unreadable stored listing rather than not-found", async () => {
    const listing = await seed(SUBMITTED_CONTENT, hostile.db);

    // A status outside the governed set, stored only in the disposable database.
    await sql`alter table listing drop constraint if exists listing_status_check`.execute(hostile.db);
    await sql`update listing set status = 'nonsense' where id = ${listingText(listing)}::uuid`.execute(
      hostile.db,
    );

    const failure = expectRefusal(
      await edit(listing, { locality: supply("Cobh") }, { db: hostile.db }),
    );

    // Exactly this code: a row that exists but cannot be represented is never reported as
    // absent, and never as a lifecycle refusal the domain was never able to make.
    expect(failure.code).toBe("STORED_LISTING_UNREADABLE");

    await sql`update listing set status = 'pending' where id = ${listingText(listing)}::uuid`.execute(
      hostile.db,
    );
  });

  it("mutates neither the edit nor any value supplied inside it", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const supplied = { value: "+353 21 765 4321", designatedPublic: false };
    const administrativeEdit: AdministrativeEdit = {
      locality: supply("Cobh"),
      administrativeArea: REMOVE,
      phone: supply(supplied),
      email: PRESERVE,
    };
    const before = JSON.stringify(administrativeEdit);

    expectListing(await edit(listing, administrativeEdit));

    expect(JSON.stringify(administrativeEdit)).toBe(before);
    expect(supplied).toEqual({ value: "+353 21 765 4321", designatedPublic: false });
  });

  it("keeps causes non-enumerable and leaks no sensitive content", async () => {
    const listing = await seed();
    const failure = expectRefusal(
      await edit(listing, { locality: supply("Cobh") }, { base: instant(BASE_AT - 1) }),
    );

    expect(JSON.stringify(failure)).not.toContain("connectionString");
    expect(JSON.stringify(failure)).not.toContain("password");
    expect(Object.keys(failure)).toEqual(["code"]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The no-op ruling, at the persistence boundary                                                 */
/* ------------------------------------------------------------------------------------------- */

describe("a valid no-op", () => {
  it("writes nothing, preserves last_updated_at, and commits", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const before = await storedRow(listing);

    capturing.reset();
    const result = expectListing(await edit(listing, {}, { db: capturing.db }));

    expect(result.timestamps.lastUpdatedAt).toEqual(BASE);
    expect(capturing.statements.filter(isWrite)).toEqual([]);
    expect(await storedRow(listing)).toEqual(before);
    // Committed, not left open: the afterEach sweep would catch a session still in transaction.
    expect(await sessionsInTransaction()).toBe(0);
  });

  it("is a no-op for a busy patch that materializes to identical content", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const before = await storedRow(listing);

    capturing.reset();
    expectListing(
      await edit(
        listing,
        {
          name: supply(COMPLETE_CONTENT.name),
          category: PRESERVE,
          description: supply(COMPLETE_CONTENT.description),
          administrativeArea: supply("Co. Cork"),
          postalCode: supply({ value: "P17 AB12", designatedPublic: true }),
          website: supply({ value: "https://example.ie" }),
        },
        { db: capturing.db },
      ),
    );

    expect(capturing.statements.filter(isWrite)).toEqual([]);
    expect(await storedRow(listing)).toEqual(before);
  });

  it("is a no-op for removing an already-absent optional value", async () => {
    const listing = await seed(SUBMITTED_CONTENT);
    const before = await storedRow(listing);

    capturing.reset();
    expectListing(await edit(listing, { administrativeArea: REMOVE, phone: REMOVE }, { db: capturing.db }));

    expect(capturing.statements.filter(isWrite)).toEqual([]);
    expect(await storedRow(listing)).toEqual(before);
  });

  it("ignores a hostile instant, because the domain never evaluates one on this path", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const before = await storedRow(listing);

    for (const at of [BASE, instant(BASE_AT - 5_000), undefined, Number.NaN, {}, "later"]) {
      capturing.reset();
      const result = await edit(listing, {}, { at: at as Instant, db: capturing.db });

      expect(result.ok).toBe(true);
      expect(capturing.statements.filter(isWrite)).toEqual([]);
    }

    expect(await storedRow(listing)).toEqual(before);
  });

  it("still compares the stale token — the ruling governs the domain's instant, not ADR-023", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    // An edit that would be a no-op, from a stale screen: refused, not quietly accepted.
    expect(expectRefusal(await edit(listing, {}, { base: instant(BASE_AT - 1) }))).toEqual({
      code: "STALE_LISTING_VERSION",
    });
  });

  it("still takes the listing lock and still performs the revision read", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    capturing.reset();
    expectListing(await edit(listing, {}, { db: capturing.db }));

    expect(capturing.statements.filter(isListingLock)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionRead)).toHaveLength(1);
  });

  it("is idempotent at this boundary — repeating it changes nothing", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    const before = await storedRow(listing);

    expectListing(await edit(listing, {}));
    expectListing(await edit(listing, {}));

    expect(await storedRow(listing)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Executed-statement proof                                                                      */
/* ------------------------------------------------------------------------------------------- */

describe("the statements PostgreSQL actually received", () => {
  it("sets READ COMMITTED explicitly and locks the listing as the first state read", async () => {
    const listing = await seed();

    capturing.reset();
    expectListing(await edit(listing, { locality: supply("Cobh") }, { db: capturing.db }));

    const sqls = capturing.statements.map((statement) => statement.sql);

    expect(sqls.some((statement) => /isolation level read committed/i.test(statement))).toBe(true);

    const firstStateRead = capturing.statements.findIndex(
      (statement) => /^\s*select\b/i.test(statement.sql) || isWrite(statement),
    );

    expect(isListingLock(capturing.statements[firstStateRead] as CapturedStatement)).toBe(true);
    expect(capturing.statements[firstStateRead]?.sql).toMatch(/for update/i);
  });

  it("reads the listing once and the pending revision once, in that order, both locked", async () => {
    const listing = await seed();

    capturing.reset();
    expectListing(await edit(listing, { locality: supply("Cobh") }, { db: capturing.db }));

    const lockIndex = capturing.statements.findIndex(isListingLock);
    const revisionIndex = capturing.statements.findIndex(isRevisionRead);

    expect(capturing.statements.filter(isListingLock)).toHaveLength(1);
    expect(capturing.statements.filter(isRevisionRead)).toHaveLength(1);
    expect(revisionIndex).toBeGreaterThan(lockIndex);
    expect(capturing.statements[revisionIndex]?.sql).toMatch(/for update/i);
    expect(capturing.statements.filter(isRevisionWrite)).toEqual([]);
  });

  it("performs exactly one listing UPDATE, with the authorized SET and the guarded WHERE", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    capturing.reset();
    expectListing(await edit(listing, { locality: supply("Cobh") }, { db: capturing.db }));

    const updates = capturing.statements.filter(isListingUpdate);

    expect(updates).toHaveLength(1);

    const shape = guardedUpdateShapeOf((updates[0] as CapturedStatement).sql);

    expect([...shape.setColumns].sort()).toEqual([...AUTHORIZED_SET_COLUMNS].sort());
    expect(shape.setsForbiddenColumn).toBeUndefined();
    expect(shape.whereHasListingId).toBe(true);
    expect(shape.whereHasLastUpdatedAt).toBe(true);
    expect(shape.whereConvertsAnInstant).toBe(true);
  });

  it("binds the caller's ORIGINAL token in the guard, never the edit instant", async () => {
    const listing = await seed();

    capturing.reset();
    expectListing(await edit(listing, { locality: supply("Cobh") }, { db: capturing.db }));

    const update = capturing.statements.filter(isListingUpdate)[0] as CapturedStatement;
    const numbers = update.parameters.filter(
      (parameter): parameter is number => typeof parameter === "number",
    );

    // Both instants appear — the new one in `SET`, the base in `WHERE` — and the base must be
    // there. A refreshed token would also be `BASE_AT` here, which is why the SQL-level
    // assertion above pins the predicate's presence and the mutation suite pins its source.
    expect(numbers).toContain(BASE_AT);
    expect(numbers).toContain(EDIT_AT);
    expect(update.parameters).toContain(listingText(listing));
  });

  it("writes nothing at all on a stale refusal or a domain refusal", async () => {
    const listing = await seed();

    capturing.reset();
    expectRefusal(
      await edit(listing, { locality: supply("Cobh") }, { base: instant(BASE_AT - 1), db: capturing.db }),
    );
    expect(capturing.statements.filter(isWrite)).toEqual([]);

    capturing.reset();
    expectRefusal(await edit(listing, { name: supply("   ") }, { db: capturing.db }));
    expect(capturing.statements.filter(isWrite)).toEqual([]);
  });

  it("never issues an INSERT, a DELETE, or a repeated statement that would be a retry", async () => {
    const listing = await seed();

    capturing.reset();
    expectListing(await edit(listing, { locality: supply("Cobh") }, { db: capturing.db }));

    expect(capturing.statements.filter((s) => /^\s*(insert|delete)\b/i.test(s.sql))).toEqual([]);
    expect(capturing.statements.filter(isListingUpdate)).toHaveLength(1);
    expect(capturing.statements.filter(isListingLock)).toHaveLength(1);
  });
});

describe("the statement analysers are not vacuous", () => {
  const sample = (statementSql: string): CapturedStatement => ({ sql: statementSql, parameters: [] });

  it("rejects an UPDATE that assigns the timestamp but does not compare it", () => {
    const shape = guardedUpdateShapeOf(
      'update "listing" set "name" = $1, "last_updated_at" = to_timestamp($2) where "id" = $3',
    );

    expect(shape.setColumns).toContain("last_updated_at");
    expect(shape.whereHasListingId).toBe(true);
    // The missing guard: this is exactly what a whole-statement search would have passed.
    expect(shape.whereHasLastUpdatedAt).toBe(false);
  });

  it("rejects an UPDATE that sets a forbidden column", () => {
    for (const column of ["id", "status", "submitted_at", "rejected_at", "publication_state"]) {
      const shape = guardedUpdateShapeOf(
        `update "listing" set "name" = $1, "${column}" = $2 where "id" = $3 and "last_updated_at" = to_timestamp($4)`,
      );

      expect(shape.setsForbiddenColumn).toBe(column);
    }
  });

  it("rejects an UPDATE missing the listing-id predicate", () => {
    const shape = guardedUpdateShapeOf(
      'update "listing" set "name" = $1 where "last_updated_at" = to_timestamp($2)',
    );

    expect(shape.whereHasListingId).toBe(false);
  });

  it("rejects an UPDATE whose SET omits an authorized content column", () => {
    const shape = guardedUpdateShapeOf(
      'update "listing" set "name" = $1 where "id" = $2 and "last_updated_at" = to_timestamp($3)',
    );

    expect([...shape.setColumns].sort()).not.toEqual([...AUTHORIZED_SET_COLUMNS].sort());
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

  it("distinguishes a listing lock from a revision read and from a write", () => {
    expect(isListingLock(sample('select * from "listing" where "id" = $1 for update'))).toBe(true);
    expect(
      isListingLock(sample('select "id" from "listing_revision" where "listing_id" = $1 for update')),
    ).toBe(false);
    expect(isListingLock(sample('select * from "listing" where "id" = $1'))).toBe(false);
    expect(isWrite(sample('update "listing" set "name" = $1'))).toBe(true);
    expect(isWrite(sample('select * from "listing"'))).toBe(false);
    expect(isRevisionWrite(sample('delete from "listing_revision" where "id" = $1'))).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The impossible revision state                                                                 */
/* ------------------------------------------------------------------------------------------- */

describe("the mandatory revision read is live", () => {
  it("refuses loudly when a pending listing carries a pending revision", async () => {
    // Constructed only here, in a database this suite owns and discards. No production path can
    // produce it: both revision-creation paths require an APPROVED listing, and `NFR-DATA-02`
    // admits no approved-to-pending transition. No production invariant or schema is weakened.
    const listing = await seed(SUBMITTED_CONTENT, hostile.db);
    const revisionId = randomUUID();

    await sql`
      insert into listing_revision (
        id, listing_id, state, name, category, description, locality, country,
        base_listing_last_updated_at
      ) values (
        ${revisionId}::uuid, ${listingText(listing)}::uuid, 'pending',
        'Proposed', 'food-drink', 'Proposed description.', 'Kinsale', 'IE',
        to_timestamp(${BASE_AT}::double precision / 1000)
      )
    `.execute(hostile.db);

    try {
      const before = await storedRow(listing, hostile.db);
      const failure = expectRefusal(
        await edit(listing, { locality: supply("Cobh") }, { db: hostile.db }),
      );

      expect(failure.code).toBe("INVALID_LIFECYCLE_STATE");
      // The listing is not updated and the revision is neither updated nor deleted: the whole
      // transaction rolled back.
      expect(await storedRow(listing, hostile.db)).toEqual(before);
      expect(await revisionRowCount(listing, hostile.db)).toBe(1);
    } finally {
      await sql`delete from listing_revision where id = ${revisionId}::uuid`.execute(hostile.db);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Test-only fault injection                                                                     */
/* ------------------------------------------------------------------------------------------- */

describe("outcomes the protocol says are unreachable", () => {
  it("reports a zero-row guarded UPDATE as a loud protocol failure, and rolls back", async () => {
    const listing = await seed();
    const trigger = `${TRIGGER_PREFIX}suppress_update`;

    try {
      await sql.raw(`
        create or replace function ${trigger}_fn() returns trigger as $$
        begin return null; end;
        $$ language plpgsql
      `).execute(persistence.db);
      await sql.raw(`
        create trigger "${trigger}" before update on "listing"
        for each row execute function ${trigger}_fn()
      `).execute(persistence.db);

      const before = await storedRow(listing);
      const failure = expectRefusal(await edit(listing, { locality: supply("Cobh") }));

      expect(failure.code).toBe("GUARDED_UPDATE_PROTOCOL_FAILURE");
      expect(await storedRow(listing)).toEqual(before);
    } finally {
      await dropProbeTriggers(persistence.db);
      await sql.raw(`drop function if exists ${trigger}_fn()`).execute(persistence.db);
    }
  });

  it("rolls back a write failure raised after the lock, leaving no partial state", async () => {
    const listing = await seed();
    const trigger = `${TRIGGER_PREFIX}raise_on_update`;

    try {
      await sql.raw(`
        create or replace function ${trigger}_fn() returns trigger as $$
        begin raise exception 'probe' using errcode = '23514', constraint = 'probe_check'; end;
        $$ language plpgsql
      `).execute(persistence.db);
      await sql.raw(`
        create trigger "${trigger}" before update on "listing"
        for each row execute function ${trigger}_fn()
      `).execute(persistence.db);

      const before = await storedRow(listing);
      const failure = expectRefusal(await edit(listing, { locality: supply("Cobh") }));

      expect(failure.code).toBe("INTEGRITY_CONFLICT");
      expect(failure).toMatchObject({ sqlState: "23514" });
      expect(await storedRow(listing)).toEqual(before);
    } finally {
      await dropProbeTriggers(persistence.db);
      await sql.raw(`drop function if exists ${trigger}_fn()`).execute(persistence.db);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Deterministic concurrency                                                                     */
/* ------------------------------------------------------------------------------------------- */

describe("the PS-11 lock, under contention", () => {
  it("blocks behind another participant holding the listing lock, then proceeds", async () => {
    const listing = await seed();
    let outcome: Awaited<ReturnType<typeof edit>> | undefined;

    await withRivalLock(listing, async (trx) => {
      const running = edit(listing, { locality: supply("Cobh") });

      // Synchronised on the server's own published fact, not on a sleep.
      await awaitLockWaiter();
      await trx.rollback().execute();

      outcome = await running;
    });

    expect(outcome?.ok).toBe(true);
    expect((await storedRow(listing)).locality).toBe("Cobh");
  });

  it("serializes two concurrent edits; the loser is refused as stale, not as anything else", async () => {
    const listing = await seed();

    const first = await edit(listing, { locality: supply("Cobh") });

    expect(first.ok).toBe(true);

    // The second administrator captured the same base before the first committed.
    expect(expectRefusal(await edit(listing, { locality: supply("Youghal") }))).toEqual({
      code: "STALE_LISTING_VERSION",
    });

    expect((await storedRow(listing)).locality).toBe("Cobh");
  });

  it("makes the second operation read committed post-lock state", async () => {
    const listing = await seed();
    let second: Awaited<ReturnType<typeof edit>> | undefined;

    await withRivalLock(listing, async (trx) => {
      // The rival advances the row itself, then commits while the boundary waits.
      await trx
        .updateTable("listing")
        .set({
          locality: "Youghal",
          last_updated_at: sql<number>`to_timestamp(${EDIT_AT}::double precision / 1000)`,
        })
        .where("id", "=", listingText(listing))
        .execute();

      const running = edit(listing, { locality: supply("Cobh") });

      await awaitLockWaiter();
      await trx.commit().execute();

      second = await running;
    });

    // It saw the committed `last_updated_at`, so the caller's base is now unequal.
    expect(second?.ok).toBe(false);
    expect(second?.ok === false && second.error.code).toBe("STALE_LISTING_VERSION");
    expect((await storedRow(listing)).locality).toBe("Youghal");
  });

  it("takes and holds the lock even for a no-op", async () => {
    const listing = await seed(COMPLETE_CONTENT);
    let outcome: Awaited<ReturnType<typeof edit>> | undefined;

    await withRivalLock(listing, async (trx) => {
      const running = edit(listing, {});

      // If the no-op path skipped the lock this sentinel fires immediately by name.
      await awaitLockWaiter();
      await trx.rollback().execute();

      outcome = await running;
    });

    expect(outcome?.ok).toBe(true);
  });

  it("releases the rival lock even when the test body throws", async () => {
    // The `finally` in `withRivalLock` exists for exactly this case: every other test in this
    // file settles the rival transaction itself, so the guard is unexercised unless a body
    // fails. A leaked lock here would make the `afterEach` trigger sweep block on
    // ACCESS EXCLUSIVE and bury the real failure under a timeout.
    const listing = await seed();

    await expect(
      withRivalLock(listing, async () => {
        throw new Error("probe: the body failed while holding the lock");
      }),
    ).rejects.toThrow("probe: the body failed while holding the lock");

    expect(await sessionsInTransaction()).toBe(0);

    // And the lock really is gone: the boundary completes without waiting for anyone.
    expectListing(await edit(listing, { locality: supply("Cobh") }));
  });

  it("leaves no session idle in transaction after success, no-op, or refusal", async () => {
    const listing = await seed(COMPLETE_CONTENT);

    expectListing(await edit(listing, {}));
    expectListing(await edit(listing, { locality: supply("Cobh") }));
    expectRefusal(await edit(listing, { locality: supply("Youghal") }, { base: instant(1) }));
    expectRefusal(await edit(pendingListing(), { locality: supply("Cobh") }));

    expect(await sessionsInTransaction()).toBe(0);
  });
});
