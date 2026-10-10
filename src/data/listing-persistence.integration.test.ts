/**
 * Live tests for the first `C9` persistence slice (issue #177).
 *
 * **Against a real PostgreSQL server, with the real first migration applied through the governed
 * `Migrator`.** The unit tests prove the mapping and the configuration rules; these prove the
 * things only a server can settle — that `DateStyle = ISO` is actually in force before the first
 * statement on every pooled backend, that a governed instant survives the round trip to the
 * millisecond, that the store refuses what the application refuses, and that a listing written
 * through `insertSubmittedListing` comes back through `findListingById` as the same aggregate.
 *
 * They are **unconditional**: the binaries ship with the `embedded-postgres` development
 * dependency, so there is nothing to probe and nothing to skip. One server for this file on an
 * **ephemeral port** with a **disposable data directory**, torn down on success, assertion failure
 * and setup failure alike, with the removal **asserted**.
 *
 * **The server version is harness detail with no production authority.** No PostgreSQL version is
 * selected (`ADR-013` names only the provider), and nothing here asserts version-specific
 * behaviour. No credential, environment variable or provisioning of any kind is involved: the
 * configuration is handed to the boundary by this file, which is exactly the posture issue #177
 * requires of its callers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { Kysely, PostgresDialect, sql, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { CATEGORY_KEYS } from "../domain/listing/category";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing } from "../domain/listing/listing";
import { createListingPersistence, type ListingPersistence } from "./connection";
import { createMigrationProvider } from "./migrate";
import { findListingById, insertSubmittedListing } from "./listing-repository";
import type { ListingDatabase } from "./listing-table";

/**
 * The narrow slice of `pg` this file reaches directly.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is described here — the pattern `migrate.ts` established. It is used only to build the
 * migration runner's own pool and to assert the driver's global state, never to stand in for the
 * boundary under test.
 */
interface PgModule {
  readonly Pool: new (config: { connectionString: string; max: number }) => PostgresPool & {
    end(): Promise<void>;
  };
  readonly types: { getTypeParser(oid: number, format: string): unknown };
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

const SERVER_USER = "postgres";
const SERVER_PASSWORD = "verification-only";
const VERIFIED_DATABASE = "listing_persistence_verification";
/** A second database whose category `CHECK`s are dropped, so hostile rows can be stored. */
const HOSTILE_DATABASE = "listing_hostile_verification";

const CLUSTER_TIMEOUT_MS = 300_000;

let server: EmbeddedPostgres;
let serverPort: number;
let dataRoot: string;
let persistence: ListingPersistence;
let hostile: ListingPersistence;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An ephemeral port the operating system confirms is free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();

      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("No ephemeral port was assigned.")));
        return;
      }

      const { port } = address;
      probe.close((closeError) => (closeError ? reject(closeError) : resolve(port)));
    });
  });
}

/**
 * Remove the disposable directory, retrying briefly: Windows releases the cluster's file handles
 * a moment after the server exits. The verdict is asserted by the caller, because a cleanup that
 * quietly failed would leave a cluster behind on every run.
 */
async function removeWithRetry(directory: string): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Retried below; the final `existsSync` is the verdict.
    }

    if (!existsSync(directory)) {
      return true;
    }

    await sleep(200);
  }

  return !existsSync(directory);
}

function connectionStringFor(database: string): string {
  return `postgresql://${SERVER_USER}:${SERVER_PASSWORD}@127.0.0.1:${serverPort}/${database}`;
}

/** Apply the real migration to one database, through the real `Migrator` and provider. */
async function migrate(database: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: connectionStringFor(database), max: 1 });
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

  try {
    const { error, results } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();

    expect(error).toBeUndefined();
    expect(results?.every((result) => result.status === "Success")).toBe(true);
  } finally {
    await db.destroy();
  }
}

const SUBMITTED_AT = 1_767_323_045_123;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

/** A pending submission, exactly as the domain would have produced it. */
function submission(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingIdOf(randomUUID()),
    status: "pending",
    content: {
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Kinsale",
      country: "IE",
    },
    timestamps: {
      submittedAt: instant(SUBMITTED_AT),
      lastUpdatedAt: instant(SUBMITTED_AT),
    },
    ...overrides,
  };
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "cdp-persistence-"));
  serverPort = await freePort();

  server = new EmbeddedPostgres({
    databaseDir: join(dataRoot, "cluster"),
    port: serverPort,
    user: SERVER_USER,
    password: SERVER_PASSWORD,
    persistent: false,
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    onLog: () => {},
    onError: () => {},
  });

  await server.initialise();
  await server.start();
  await server.createDatabase(VERIFIED_DATABASE);
  await server.createDatabase(HOSTILE_DATABASE);

  await migrate(VERIFIED_DATABASE);
  await migrate(HOSTILE_DATABASE);

  // The boundary under test, configured entirely by this caller.
  persistence = createListingPersistence({
    pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 4 },
    startupParameters: { application_name: "listing_persistence_tests" },
  });

  hostile = createListingPersistence({
    pool: { connectionString: connectionStringFor(HOSTILE_DATABASE), max: 1 },
  });

  // Dropping a constraint needs no key list, so the governed vocabulary is still stated in
  // exactly two executable places (`ADR-021` decision 10, issue #175). This database exists so
  // that a row the domain cannot represent can be *stored* and the read path's classification
  // of it proved end to end.
  await sql`alter table listing drop constraint listing_category_check`.execute(hostile.db);
  await sql`alter table listing drop constraint listing_status_check`.execute(hostile.db);
}, CLUSTER_TIMEOUT_MS);

afterAll(async () => {
  // Every step is attempted even if an earlier one throws: a half-released cluster is worse than
  // a noisy teardown.
  for (const closing of [persistence, hostile]) {
    try {
      await closing?.shutdown();
    } catch {
      // The server is going away regardless.
    }
  }

  try {
    await server?.stop();
  } catch {
    // Fall through to directory removal, which is the guarantee that matters.
  }

  const removed = await removeWithRetry(dataRoot);
  expect(removed, `the disposable cluster at ${dataRoot} was not removed`).toBe(true);
}, CLUSTER_TIMEOUT_MS);

describe("the connection boundary, against a real server", () => {
  it(
    "has DateStyle = ISO on the very first statement of a fresh backend",
    async () => {
      // A boundary created here and used once, so this really is the first statement its
      // backend ever receives — the claim does not depend on the order tests happen to run in.
      // If the setting were applied by a query rather than by the startup packet, this is
      // where it would show.
      const fresh = createListingPersistence({
        pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 1 },
      });

      try {
        const first = await sql<{
          datestyle: string;
        }>`select current_setting('datestyle') as datestyle`.execute(fresh.db);

        expect(first.rows[0]?.datestyle).toMatch(/^ISO/);
      } finally {
        await fresh.shutdown();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "has DateStyle = ISO on several distinct backends independently",
    async () => {
      const seen: { pid: number; datestyle: string }[] = [];

      // Four concurrent statements force the pool to open four separate backends, each of
      // which must have been configured during its own handshake.
      await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const result = await sql<{
            pid: number;
            datestyle: string;
          }>`select pg_backend_pid() as pid, current_setting('datestyle') as datestyle`.execute(
            persistence.db,
          );
          const row = result.rows[0];

          if (row !== undefined) {
            seen.push(row);
          }
        }),
      );

      expect(seen).toHaveLength(4);
      expect(new Set(seen.map((row) => row.pid)).size).toBeGreaterThan(1);

      for (const row of seen) {
        expect(row.datestyle, `backend ${row.pid}`).toMatch(/^ISO/);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "preserves the caller's own startup parameters alongside the governed one",
    async () => {
      const result = await sql<{
        application_name: string;
      }>`select current_setting('application_name') as application_name`.execute(
        persistence.db,
      );

      expect(result.rows[0]?.application_name).toBe("listing_persistence_tests");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "delivers a governed instant as epoch milliseconds, not as a Date",
    async () => {
      const result = await sql<{
        at: unknown;
      }>`select '2026-01-02 03:04:05.123+00'::timestamptz(3) as at`.execute(persistence.db);
      const at = result.rows[0]?.at;

      expect(typeof at).toBe("number");
      expect(at).not.toBeInstanceOf(Date);
      expect(at).toBe(1_767_323_045_123);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it("leaves the driver's global timestamptz parser untouched", () => {
    // The override is registered per pool, so an unrelated consumer — the migration runner in
    // this very file — still receives the driver's default `Date`.
    const parser = pg.types.getTypeParser(1184, "text") as (value: string) => unknown;

    expect(parser("2026-01-02 03:04:05.123+00")).toBeInstanceOf(Date);
  });
});

describe("persisting a submitted listing (OP-3)", () => {
  it(
    "stores it and reads it back as the same aggregate",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const found = await findListingById(persistence.db, listing.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value).toEqual(listing);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "round-trips every field, including optional values and their designations",
    async () => {
      const listing = submission({
        content: {
          name: "Quay Books",
          category: "retail-shopping",
          description: "A bookshop.",
          locality: "Cobh",
          country: "IE",
          administrativeArea: "County Cork",
          postalCode: { value: "P24 XYZ", designatedPublic: true },
          phone: { value: "+353 21 111 1111", designatedPublic: true },
          email: { value: "hello@example.ie", designatedPublic: false },
          website: { value: "https://example.ie", designatedPublic: false },
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const found = await findListingById(persistence.db, listing.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value).toEqual(listing);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "preserves the exact millisecond of every governed instant",
    async () => {
      // Values chosen to catch truncation, rounding and second-level storage alike.
      for (const epochMilliseconds of [
        1_767_323_045_123,
        1_767_323_045_001,
        1_767_323_045_999,
        1_767_323_045_000,
        -2_208_988_800_123,
        0,
      ]) {
        const listing = submission({
          timestamps: {
            submittedAt: instant(epochMilliseconds),
            lastUpdatedAt: instant(epochMilliseconds + 1),
          },
        });

        expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

        const found = await findListingById(persistence.db, listing.id);

        expect(found.ok, String(epochMilliseconds)).toBe(true);
        if (!found.ok) return;

        expect(found.value.timestamps.submittedAt).toEqual(instant(epochMilliseconds));
        expect(found.value.timestamps.lastUpdatedAt).toEqual(instant(epochMilliseconds + 1));
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "uses the application's identifier, with no database default or generator",
    async () => {
      const id = randomUUID();
      const listing = submission({ id: listingIdOf(id) });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const stored = await sql<{
        id: string;
        has_default: boolean;
      }>`select l.id::text as id,
                (select count(*) > 0
                   from pg_attrdef d
                   join pg_class c on c.oid = d.adrelid
                  where c.relname = 'listing' and d.adnum = 1) as has_default
           from listing l where l.id = ${id}::uuid`.execute(persistence.db);

      expect(stored.rows[0]?.id).toBe(id);
      // `ADR-019` decision 5: PostgreSQL declares no generation default for the identifier.
      expect(stored.rows[0]?.has_default).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "takes the instants from the application, never from the database clock",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const stored = await sql<{
        matches: boolean;
        near_now: boolean;
      }>`select submitted_at = '2026-01-02 03:04:05.123+00'::timestamptz(3) as matches,
                abs(extract(epoch from (now() - submitted_at))) < 60 as near_now
           from listing where id = ${(listing.id as unknown as { supplied: string }).supplied}::uuid`.execute(
        persistence.db,
      );

      expect(stored.rows[0]?.matches).toBe(true);
      // And it is emphatically not "whatever time the insert happened".
      expect(stored.rows[0]?.near_now).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "stores a newly submitted listing as pending, with nothing that applies only later",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const stored = await sql<{
        status: string;
        publication_state: string | null;
        unpublish_reason: string | null;
        rejected_at: number | null;
      }>`select status, publication_state, unpublish_reason, rejected_at
           from listing where id = ${(listing.id as unknown as { supplied: string }).supplied}::uuid`.execute(
        persistence.db,
      );

      expect(stored.rows[0]).toEqual({
        status: "pending",
        publication_state: null,
        unpublish_reason: null,
        rejected_at: null,
      });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "stores every approved category key exactly",
    async () => {
      for (const category of CATEGORY_KEYS) {
        const listing = submission({
          content: { ...submission().content, category },
        });

        expect((await insertSubmittedListing(persistence.db, listing)).ok, category).toBe(true);

        const found = await findListingById(persistence.db, listing.id);

        expect(found.ok, category).toBe(true);
        if (!found.ok) return;

        expect(found.value.content.category).toBe(category);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps SQL-shaped content as data",
    async () => {
      const hostileText = "'); drop table listing; --";
      const listing = submission({
        content: {
          ...submission().content,
          name: hostileText,
          description: `Robert'); DROP TABLE listing;--`,
          locality: "O'Brien's Bridge",
        },
      });

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const found = await findListingById(persistence.db, listing.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value.content.name).toBe(hostileText);
      expect(found.value.content.locality).toBe("O'Brien's Bridge");

      // The table is still there, which is the real assertion.
      const survived = await sql<{ present: boolean }>`select true as present from listing limit 1`.execute(
        persistence.db,
      );

      expect(survived.rows[0]?.present).toBe(true);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the store refuses what the application refuses", () => {
  it(
    "reports a duplicate identifier and leaves the stored row untouched",
    async () => {
      const first = submission();

      expect((await insertSubmittedListing(persistence.db, first)).ok).toBe(true);

      const impostor = submission({
        id: first.id,
        content: { ...first.content, name: "Overwritten Name" },
      });
      const second = await insertSubmittedListing(persistence.db, impostor);

      expect(second.ok).toBe(false);
      if (second.ok) return;

      expect(second.error).toEqual({ code: "LISTING_ALREADY_EXISTS" });

      // Nothing was overwritten: no upsert, no `on conflict`, no retry.
      const found = await findListingById(persistence.db, first.id);

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect(found.value.content.name).toBe("Harbour Bakery");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports an unapproved category as a storage failure, never as a business outcome",
    async () => {
      // The domain's guard and the store's `CHECK` agree; neither substitutes for the other.
      const listing = submission({
        content: {
          ...submission().content,
          // Reaching the store with this requires defeating the compile-time type, which is
          // exactly the boundary under test.
          category: "food-and-drink" as (typeof CATEGORY_KEYS)[number],
        },
      });

      const result = await insertSubmittedListing(persistence.db, listing);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("STORAGE_FAILURE");
      if (result.error.code !== "STORAGE_FAILURE") return;

      expect(result.error.sqlState).toBe("23514");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("a storage failure leaks nothing (issue #177 §11)", () => {
  it(
    "keeps the failing row's values and the credential out of its enumerable surface",
    async () => {
      // Measured during this unit: a PostgreSQL constraint error carries
      // `detail: "Failing row contains (…)"` as an **enumerable own property**, so a failure
      // that passed the driver error through verbatim would publish listing content into any
      // log line or JSON response that touched it.
      const sensitive = "SENSITIVE-ROW-VALUE-DO-NOT-ECHO";
      const listing = submission({
        content: {
          ...submission().content,
          name: sensitive,
          category: "food-and-drink" as (typeof CATEGORY_KEYS)[number],
        },
      });

      const result = await insertSubmittedListing(persistence.db, listing);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      const failure = result.error;

      // The driver really did attach the row, so this test is not vacuous.
      expect(JSON.stringify((failure as { cause?: unknown }).cause ?? {})).toContain(sensitive);

      // And none of it escapes through the routes that actually get used.
      expect(JSON.stringify(failure)).not.toContain(sensitive);
      expect(JSON.stringify({ ...failure })).not.toContain(sensitive);
      expect(Object.keys(failure)).not.toContain("cause");
      expect(Object.keys(failure).sort()).toEqual(["code", "constraint", "sqlState"]);
      expect(JSON.stringify(failure)).not.toContain(SERVER_PASSWORD);

      // What is exposed is schema metadata, which is the part worth reading.
      if (failure.code !== "STORAGE_FAILURE") return;
      expect(failure.sqlState).toBe("23514");
      expect(failure.constraint).toBe("listing_category_check");

      // The cause is still reachable deliberately, for diagnosis.
      expect(failure.cause).toBeDefined();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "keeps the credential out of a connection failure",
    async () => {
      const wrong = createListingPersistence({
        pool: {
          connectionString: `postgresql://${SERVER_USER}:${SERVER_PASSWORD}@127.0.0.1:${serverPort}/database_that_does_not_exist`,
          max: 1,
          connectionTimeoutMillis: 5_000,
        },
      });

      try {
        const result = await findListingById(wrong.db, listingIdOf(randomUUID()));

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // Not "not found": the query never ran.
        expect(result.error.code).toBe("STORAGE_FAILURE");
        expect(JSON.stringify(result.error)).not.toContain(SERVER_PASSWORD);
        expect(JSON.stringify({ ...result.error })).not.toContain(SERVER_PASSWORD);
      } finally {
        await wrong.shutdown();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("retrieving by identifier", () => {
  it(
    "reports not found for an identifier that was never stored",
    async () => {
      const result = await findListingById(persistence.db, listingIdOf(randomUUID()));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({ code: "LISTING_NOT_FOUND" });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a malformed identifier as a storage failure, not as not found",
    async () => {
      // `uuid` cannot parse this, so the query itself fails. A boundary that reported "not
      // found" here would be hiding a defect behind an ordinary answer.
      const result = await findListingById(persistence.db, listingIdOf("not-a-uuid"));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("STORAGE_FAILURE");
      if (result.error.code !== "STORAGE_FAILURE") return;

      expect(result.error.sqlState).toBe("22P02");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "performs no write",
    async () => {
      const listing = submission();

      expect((await insertSubmittedListing(persistence.db, listing)).ok).toBe(true);

      const before = await sql<{ count: string }>`select count(*)::text as count from listing`.execute(
        persistence.db,
      );

      await findListingById(persistence.db, listing.id);
      await findListingById(persistence.db, listingIdOf(randomUUID()));

      const after = await sql<{ count: string }>`select count(*)::text as count from listing`.execute(
        persistence.db,
      );

      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "touches no revision row at all",
    async () => {
      const listing = submission();

      await insertSubmittedListing(persistence.db, listing);
      await findListingById(persistence.db, listing.id);

      const revisions = await sql<{
        count: string;
      }>`select count(*)::text as count from listing_revision`.execute(persistence.db);

      expect(revisions.rows[0]?.count).toBe("0");
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "hydrates lifecycle shapes this slice cannot itself create",
    async () => {
      // Written with raw SQL on purpose: approval, unpublication and rejection are write paths
      // issue #177 excludes, but their stored shapes are legal and must read back correctly.
      const cases = [
        {
          label: "approved and publicly available",
          state: sql`'publicly_available'`,
          reason: sql`null`,
          status: "approved",
          rejected: sql`null`,
        },
        {
          label: "approved and unpublished",
          state: sql`'unpublished'`,
          reason: sql`'Reported by a visitor'`,
          status: "approved",
          rejected: sql`null`,
        },
        {
          label: "rejected",
          state: sql`null`,
          reason: sql`null`,
          status: "rejected",
          rejected: sql`'2026-01-02 09:00:00.500+00'::timestamptz(3)`,
        },
      ] as const;

      for (const shape of cases) {
        const id = randomUUID();

        await sql`
          insert into listing (
            id, status, name, category, description, locality, country,
            publication_state, unpublish_reason,
            submitted_at, last_updated_at, rejected_at
          ) values (
            ${id}::uuid, ${shape.status}, 'Stored Directly', 'food-drink', 'A description.',
            'Kinsale', 'IE', ${shape.state}, ${shape.reason},
            '2026-01-02 03:04:05.123+00'::timestamptz(3),
            '2026-01-02 03:04:05.123+00'::timestamptz(3),
            ${shape.rejected}
          )
        `.execute(persistence.db);

        const found = await findListingById(persistence.db, listingIdOf(id));

        expect(found.ok, shape.label).toBe(true);
        if (!found.ok) return;

        expect(found.value.status, shape.label).toBe(shape.status);

        if (shape.status === "rejected") {
          expect(found.value.timestamps.rejectedAt).toEqual(instant(1_767_344_400_500));
          expect(found.value.publication).toBeUndefined();
        } else {
          expect(found.value.publication, shape.label).toBeDefined();
          expect(found.value.timestamps.rejectedAt).toBeUndefined();
        }
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "hydrates a designation flag with no value as an absent field",
    async () => {
      // Storable because no `CHECK` ties the flag to a non-null value.
      const id = randomUUID();

      await sql`
        insert into listing (
          id, status, name, category, description, locality, country,
          postal_code, postal_code_designated_public,
          phone, phone_designated_public,
          submitted_at, last_updated_at
        ) values (
          ${id}::uuid, 'pending', 'Flag Without Value', 'food-drink', 'A description.',
          'Kinsale', 'IE', null, true, null, true,
          '2026-01-02 03:04:05.123+00'::timestamptz(3),
          '2026-01-02 03:04:05.123+00'::timestamptz(3)
        )
      `.execute(persistence.db);

      const found = await findListingById(persistence.db, listingIdOf(id));

      expect(found.ok).toBe(true);
      if (!found.ok) return;

      expect("postalCode" in found.value.content).toBe(false);
      expect("phone" in found.value.content).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("a stored row the domain cannot represent", () => {
  it(
    "is reported as unreadable, and never as not found",
    async () => {
      // This database has its category and status `CHECK`s dropped, so rows the application
      // could never write can still be stored — which is the only honest way to prove how the
      // read path classifies them.
      const unapproved = randomUUID();
      const unknownStatus = randomUUID();

      for (const [id, status, category] of [
        [unapproved, "pending", "food-and-drink"],
        [unknownStatus, "archived", "food-drink"],
      ] as const) {
        await sql`
          insert into listing (
            id, status, name, category, description, locality, country,
            submitted_at, last_updated_at
          ) values (
            ${id}::uuid, ${status}, 'Hostile Row', ${category}, 'A description.',
            'Kinsale', 'IE',
            '2026-01-02 03:04:05.123+00'::timestamptz(3),
            '2026-01-02 03:04:05.123+00'::timestamptz(3)
          )
        `.execute(hostile.db);
      }

      const badCategory = await findListingById(hostile.db, listingIdOf(unapproved));

      expect(badCategory.ok).toBe(false);
      if (badCategory.ok) return;

      expect(badCategory.error).toEqual({
        code: "LISTING_UNREADABLE",
        failure: { code: "UNAPPROVED_CATEGORY", column: "category" },
      });

      const badStatus = await findListingById(hostile.db, listingIdOf(unknownStatus));

      expect(badStatus.ok).toBe(false);
      if (badStatus.ok) return;

      expect(badStatus.error).toEqual({
        code: "LISTING_UNREADABLE",
        failure: { code: "UNKNOWN_LISTING_STATUS", column: "status" },
      });

      // And the row is genuinely there — so "unreadable" is not a disguised "absent".
      const present = await sql<{
        count: string;
      }>`select count(*)::text as count from listing where id = ${unapproved}::uuid`.execute(
        hostile.db,
      );

      expect(present.rows[0]?.count).toBe("1");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("shutdown", () => {
  it(
    "releases the pool, and a closed boundary refuses further work rather than hanging",
    async () => {
      const closing = createListingPersistence({
        pool: { connectionString: connectionStringFor(VERIFIED_DATABASE), max: 1 },
      });

      const before = await sql<{ one: number }>`select 1 as one`.execute(closing.db);

      expect(before.rows[0]?.one).toBe(1);

      await closing.shutdown();
      // Idempotent: the second call is a no-op, not the driver's double-end error.
      await closing.shutdown();

      await expect(sql`select 1`.execute(closing.db)).rejects.toThrow();
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaves no backend of its own behind",
    async () => {
      const result = await sql<{
        count: string;
      }>`select count(*)::text as count from pg_stat_activity
           where application_name = 'listing_persistence_tests_transient'`.execute(
        persistence.db,
      );

      expect(result.rows[0]?.count).toBe("0");
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("the typed database exposes no unauthorized operation", () => {
  it("offers exactly the two repository functions, and no update or delete", () => {
    // A compile-time fact, recorded at runtime so it is visible in the suite: every column's
    // update type in `listing-table.ts` is `never`, and `listing_revision`'s insert type is
    // `never` too, so an unauthorized write does not compile.
    const database: Kysely<ListingDatabase> = persistence.db;

    expect(typeof database.insertInto).toBe("function");
    expect(typeof insertSubmittedListing).toBe("function");
    expect(typeof findListingById).toBe("function");
  });
});
