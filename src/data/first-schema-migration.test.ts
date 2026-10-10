/**
 * Attacking tests for the first schema migration (issue #171).
 *
 * **These tests run against a real PostgreSQL server**, started from the
 * `embedded-postgres` development dependency authorized on issue #171. They are
 * **unconditional**: the server binaries ship with the dependency, so there is no
 * environment to probe, nothing to skip and no path on which a constraint silently goes
 * unattacked. `CONTRIBUTING.md`'s definition of done requires that every invariant a unit
 * touches be *"proven by an attacking test — one that attempts the violation and fails to
 * achieve it"*, and that is what the bulk of this file is.
 *
 * **The server version is a test-harness detail with no production authority.** No
 * PostgreSQL version is selected for production (`ADR-013` names only the provider), and
 * nothing here asserts version-specific behaviour: every feature exercised —
 * `uuid`, `text`, `boolean`, `timestamptz(3)`, `CHECK`, primary and foreign keys and a
 * partial unique index — is long-standing core PostgreSQL requiring no extension.
 *
 * **No production code is exercised beyond the governed migration runner.** The
 * migration is applied through `runMigration`, so discovery, ordering and invocation are
 * the real ones (`ADR-018`). **The `C9` `pg` timestamp parser is deliberately not
 * implemented or registered** — `ADR-022` leaves it to the persistence unit, so the
 * round-trip assertion below converts explicitly in SQL instead.
 *
 * Isolation and cleanup: one server per file on an **ephemeral port** with a **disposable
 * data directory**, torn down in `afterAll` on every path — success, assertion failure and
 * setup failure alike — with the directory removal asserted rather than hoped for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { CATEGORY_KEYS } from "../domain/listing/category";
import {
  CONNECTION_STRING_VARIABLE,
  createMigrationProvider,
  SUCCESS,
  runMigration,
  type MigrationDependencies,
} from "./migrate";

/** One query result row, as `pg` returns it: column name to value. */
type Row = Readonly<Record<string, unknown>>;

/**
 * The narrow slice of `pg` this file uses.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately not a dependency of this
 * repository (`ADR-017` records it as *"absent and deferred"*). Adding one is a dependency
 * change this unit is not authorized to make, so the module is reached through an explicit
 * runtime require and described here — the same pattern `migrate.ts` established for its
 * own use of `Pool`.
 */
interface PgModule {
  readonly Pool: new (config: {
    connectionString: string;
    max: number;
  }) => PostgresPool & { end(): Promise<void> };
  readonly Client: new (config: { connectionString: string }) => {
    connect(): Promise<void>;
    query<R extends Row = Row>(
      statement: string,
      values?: readonly unknown[],
    ): Promise<{ rows: R[] }>;
    end(): Promise<void>;
  };
}

const { Pool, Client } = createRequire(import.meta.url)("pg") as PgModule;

type PgClient = InstanceType<PgModule["Client"]>;

/** The migration under test, as `FileMigrationProvider` names it. */
const MIGRATION_NAME = "001-create-listing-and-revision-tables";

/** PostgreSQL error codes this file attacks for. Named, because a bare code is a riddle. */
const NOT_NULL_VIOLATION = "23502";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/**
 * The approved category machine keys — **imported, never restated** (issue #175).
 *
 * This file previously carried its own hardcoded list, a **third** executable copy of the
 * vocabulary alongside the configuration and the migration's own private constant. A list
 * maintained in a test is a list that can disagree with the application silently, so it is
 * gone: the governed configuration (`src/domain/listing/category.ts`) is now the single
 * application-owned executable vocabulary, and the migration keeps its independent
 * historical `CHECK` predicate. Those two are compared directly in
 * `category-constraint-equality.test.ts`.
 */
const APPROVED_CATEGORY_KEYS = CATEGORY_KEYS;

const SERVER_USER = "postgres";
const SERVER_PASSWORD = "verification-only";
const VERIFIED_DATABASE = "migration_verification";
const DOWN_DATABASE = "down_verification";

/** Generous, because initialising a cluster is slow and flakiness is worse than waiting. */
const CLUSTER_TIMEOUT_MS = 300_000;

let server: EmbeddedPostgres;
let serverPort: number;
let dataRoot: string;
let client: PgClient;

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
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Remove the disposable directory, retrying briefly.
 *
 * Windows releases the cluster's file handles a moment after the server exits, so a single
 * attempt can lose a race it would win 200ms later. The return value is asserted by the
 * caller: a cleanup that quietly failed would leave a cluster behind on every run.
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

/**
 * The governed runner, pointed at one disposable database.
 *
 * `createContext` mirrors `createDefaultDependencies` deliberately — the point is to run
 * the **real** `Migrator` over the **real** `FileMigrationProvider`, so that discovery,
 * ordering and the migration file itself are all under test. Only the environment and the
 * log sinks are substituted.
 */
function dependenciesFor(database: string): MigrationDependencies {
  return {
    env: { [CONNECTION_STRING_VARIABLE]: connectionStringFor(database) },
    createContext: (connectionString) => {
      const pool = new Pool({ connectionString, max: 1 });
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

      return {
        runner: new Migrator({ db, provider: createMigrationProvider() }),
        destroy: () => db.destroy(),
      };
    },
    info: () => {},
    error: () => {},
  };
}

/** Run a statement and return the PostgreSQL error code it raised, or `null` if it did not. */
async function errorCodeOf(
  statement: string,
  values: readonly unknown[] = [],
): Promise<string | null> {
  try {
    await client.query(statement, [...values]);
    return null;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : "unknown";
  }
}

/**
 * Insert a listing, returning the error code or `null` on success.
 *
 * Every attacking test needs a row that is valid except for the one thing it attacks, so
 * the valid shape lives here once and each caller overrides a single column.
 */
async function insertListing(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string | null> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    status: "pending",
    name: "A Business",
    category: "food-drink",
    description: "A description.",
    locality: "A Locality",
    country: "A Country",
    administrative_area: null,
    postal_code: null,
    phone: null,
    email: null,
    website: null,
    publication_state: null,
    unpublish_reason: null,
    submitted_at: "2026-01-02T03:04:05.123+00:00",
    last_updated_at: "2026-01-02T03:04:05.123+00:00",
    rejected_at: null,
    ...overrides,
  };

  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  return errorCodeOf(
    `insert into listing (${columns.join(", ")}) values (${placeholders.join(", ")})`,
    Object.values(row),
  );
}

/** Insert a listing that must succeed, and return its identifier. */
async function insertApprovedListing(): Promise<string> {
  const id = randomUUID();
  const code = await insertListing({
    id,
    status: "approved",
    publication_state: "publicly_available",
  });

  expect(code).toBeNull();
  return id;
}

async function insertRevision(
  listingId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string | null> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    listing_id: listingId,
    state: "pending",
    name: "A Business",
    category: "food-drink",
    description: "A description.",
    locality: "A Locality",
    country: "A Country",
    administrative_area: null,
    postal_code: null,
    phone: null,
    email: null,
    website: null,
    rejected_at: null,
    ...overrides,
  };

  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  return errorCodeOf(
    `insert into listing_revision (${columns.join(", ")}) values (${placeholders.join(", ")})`,
    Object.values(row),
  );
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "cdp-migration-"));
  serverPort = await freePort();

  server = new EmbeddedPostgres({
    databaseDir: join(dataRoot, "cluster"),
    port: serverPort,
    user: SERVER_USER,
    password: SERVER_PASSWORD,
    persistent: false,
    // `C` keeps collation behaviour out of the comparison; the migration depends on none.
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    onLog: () => {},
    onError: () => {},
  });

  await server.initialise();
  await server.start();
  await server.createDatabase(VERIFIED_DATABASE);
  await server.createDatabase(DOWN_DATABASE);

  client = new Client({ connectionString: connectionStringFor(VERIFIED_DATABASE) });
  await client.connect();
}, CLUSTER_TIMEOUT_MS);

afterAll(async () => {
  // Every step is attempted even if an earlier one throws: a half-released cluster is
  // worse than a noisy teardown.
  try {
    await client?.end();
  } catch {
    // The server is going away regardless.
  }

  try {
    await server?.stop();
  } catch {
    // Fall through to directory removal, which is the guarantee that matters.
  }

  const removed = await removeWithRetry(dataRoot);
  expect(removed, `the disposable cluster at ${dataRoot} was not removed`).toBe(true);
}, CLUSTER_TIMEOUT_MS);

describe("up migration", () => {
  it(
    "applies through the governed runner and reports success",
    async () => {
      const status = await runMigration("latest", dependenciesFor(VERIFIED_DATABASE));

      expect(status).toBe(SUCCESS);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it("is the migration the provider discovered, under its governed name", async () => {
    const { rows } = await client.query<{ name: string }>(
      "select name from kysely_migration order by name",
    );

    expect(rows.map((row) => row.name)).toEqual([MIGRATION_NAME]);
  });

  it("creates exactly the two governed tables, and no other", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name not like 'kysely_%'
        order by table_name`,
    );

    expect(rows.map((row) => row.table_name)).toEqual(["listing", "listing_revision"]);
  });
});

describe("schema shape", () => {
  type Column = {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    datetime_precision: number | null;
  };

  const columnsOf = async (table: string) => {
    const { rows } = await client.query<Column>(
      `select column_name, data_type, is_nullable, column_default, datetime_precision
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [table],
    );

    return rows;
  };

  it("gives listing exactly its 21 governed columns, in order", async () => {
    const rows = await columnsOf("listing");

    expect(rows).toHaveLength(21);
    expect(rows.map((row) => row.column_name)).toEqual([
      "id",
      "status",
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
      "publication_state",
      "unpublish_reason",
      "submitted_at",
      "last_updated_at",
      "rejected_at",
    ]);
  });

  it("gives listing_revision exactly its 18 governed columns, in order", async () => {
    const rows = await columnsOf("listing_revision");

    expect(rows).toHaveLength(18);
    expect(rows.map((row) => row.column_name)).toEqual([
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
    ]);
  });

  it("stores no submitted or last-updated instant on a revision", async () => {
    const names = (await columnsOf("listing_revision")).map((row) => row.column_name);

    expect(names).not.toContain("submitted_at");
    expect(names).not.toContain("last_updated_at");
    expect(names).not.toContain("status");
    expect(names).not.toContain("publication_state");
    expect(names).not.toContain("unpublish_reason");
  });

  it("types identity as uuid, not null, on both structures", async () => {
    for (const table of ["listing", "listing_revision"]) {
      const identity = (await columnsOf(table)).find((row) => row.column_name === "id");

      expect(identity?.data_type, table).toBe("uuid");
      expect(identity?.is_nullable, table).toBe("NO");
    }

    const parent = (await columnsOf("listing_revision")).find(
      (row) => row.column_name === "listing_id",
    );

    expect(parent?.data_type).toBe("uuid");
    expect(parent?.is_nullable).toBe("NO");
  });

  it("types every content column as text, with no length bound anywhere", async () => {
    const textColumns = [
      "status",
      "name",
      "category",
      "description",
      "locality",
      "country",
      "administrative_area",
      "postal_code",
      "phone",
      "email",
      "website",
      "publication_state",
      "unpublish_reason",
    ];

    const rows = await columnsOf("listing");

    for (const name of textColumns) {
      expect(rows.find((row) => row.column_name === name)?.data_type, name).toBe("text");
    }

    const { rows: bounded } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('listing','listing_revision')
          and character_maximum_length is not null`,
    );

    expect(bounded).toEqual([]);
  });

  it("requires the five always-present content columns and allows the four optional ones", async () => {
    const rows = await columnsOf("listing");
    const nullabilityOf = (name: string) =>
      rows.find((row) => row.column_name === name)?.is_nullable;

    for (const name of ["status", "name", "category", "description", "locality", "country"]) {
      expect(nullabilityOf(name), name).toBe("NO");
    }

    for (const name of [
      "administrative_area",
      "postal_code",
      "phone",
      "email",
      "website",
      "publication_state",
      "unpublish_reason",
      "rejected_at",
    ]) {
      expect(nullabilityOf(name), name).toBe("YES");
    }
  });

  it("types all four governed instants as timestamptz(3)", async () => {
    const expectations: ReadonlyArray<readonly [string, string, string]> = [
      ["listing", "submitted_at", "NO"],
      ["listing", "last_updated_at", "NO"],
      ["listing", "rejected_at", "YES"],
      ["listing_revision", "rejected_at", "YES"],
    ];

    for (const [table, column, nullable] of expectations) {
      const found = (await columnsOf(table)).find((row) => row.column_name === column);

      expect(found?.data_type, `${table}.${column}`).toBe("timestamp with time zone");
      expect(found?.datetime_precision, `${table}.${column}`).toBe(3);
      expect(found?.is_nullable, `${table}.${column}`).toBe(nullable);
    }
  });

  it("defaults false on exactly the four designation columns, and nowhere else", async () => {
    const designations = [
      "postal_code_designated_public",
      "phone_designated_public",
      "email_designated_public",
      "website_designated_public",
    ];

    for (const table of ["listing", "listing_revision"]) {
      const rows = await columnsOf(table);

      for (const name of designations) {
        const found = rows.find((row) => row.column_name === name);

        expect(found?.data_type, `${table}.${name}`).toBe("boolean");
        expect(found?.is_nullable, `${table}.${name}`).toBe("NO");
        expect(found?.column_default, `${table}.${name}`).toBe("false");
      }

      for (const row of rows) {
        if (!designations.includes(row.column_name)) {
          expect(row.column_default, `${table}.${row.column_name}`).toBeNull();
        }
      }
    }
  });

  it("declares no generated identity and no database clock default", async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('listing','listing_revision')
          and (is_identity = 'YES'
               or is_generated <> 'NEVER'
               or column_default ilike '%gen_random_uuid%'
               or column_default ilike '%uuid_generate%'
               or column_default ilike '%nextval%'
               or column_default ilike '%now()%'
               or column_default ilike '%current_timestamp%')`,
    );

    expect(rows).toEqual([]);
  });

  it("creates only the integrity indexes — two primary keys and one partial unique", async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename in ('listing','listing_revision')
        order by indexname`,
    );

    expect(rows.map((row) => row.indexname)).toEqual([
      "listing_pkey",
      "listing_revision_one_pending_per_listing",
      "listing_revision_pkey",
    ]);

    const partial = rows.find(
      (row) => row.indexname === "listing_revision_one_pending_per_listing",
    );

    expect(partial?.indexdef).toContain("UNIQUE");
    expect(partial?.indexdef).toMatch(/WHERE \(?state = 'pending'/);
  });

  it("creates no trigger, view or extension of its own", async () => {
    const { rows: triggers } = await client.query(
      `select trigger_name from information_schema.triggers where trigger_schema = 'public'`,
    );
    const { rows: views } = await client.query(
      `select table_name from information_schema.views where table_schema = 'public'`,
    );
    const { rows: extensions } = await client.query(
      `select extname from pg_extension where extname <> 'plpgsql'`,
    );

    expect(triggers).toEqual([]);
    expect(views).toEqual([]);
    expect(extensions).toEqual([]);
  });
});

describe("identity integrity", () => {
  it("accepts a well-formed listing", async () => {
    expect(await insertListing()).toBeNull();
  });

  it("refuses a null listing identity", async () => {
    expect(await insertListing({ id: null })).toBe(NOT_NULL_VIOLATION);
  });

  it("refuses a duplicate listing identity", async () => {
    const id = randomUUID();

    expect(await insertListing({ id })).toBeNull();
    expect(await insertListing({ id })).toBe(UNIQUE_VIOLATION);
  });

  it("refuses a null or duplicate revision identity", async () => {
    const listingId = await insertApprovedListing();
    const revisionId = randomUUID();

    expect(await insertRevision(listingId, { id: revisionId })).toBeNull();
    expect(await insertRevision(listingId, { id: revisionId, state: "rejected", rejected_at: "2026-01-03T00:00:00.000+00:00" })).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await insertRevision(listingId, { id: null })).toBe(NOT_NULL_VIOLATION);
  });
});

describe("foreign key behaviour", () => {
  it("refuses a revision whose listing does not exist", async () => {
    expect(await insertRevision(randomUUID())).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("refuses a null parent reference", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { listing_id: null })).toBe(NOT_NULL_VIOLATION);
  });

  it("refuses deleting a listing that still has a revision — no cascade", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();
    expect(
      await errorCodeOf("delete from listing where id = $1", [listingId]),
    ).toBe(FOREIGN_KEY_VIOLATION);

    const { rows } = await client.query<{ count: string }>(
      "select count(*)::text as count from listing_revision where listing_id = $1",
      [listingId],
    );

    expect(rows[0]?.count, "the child row must survive the refused delete").toBe("1");
  });

  it("permits deleting a listing once its revisions are gone", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();
    expect(
      await errorCodeOf("delete from listing_revision where listing_id = $1", [listingId]),
    ).toBeNull();
    expect(await errorCodeOf("delete from listing where id = $1", [listingId])).toBeNull();
  });
});

describe("listing status check", () => {
  it.each(["pending", "approved", "rejected"])("accepts %s", async (status) => {
    const overrides: Record<string, unknown> = { status };

    if (status === "approved") {
      overrides.publication_state = "publicly_available";
    }

    if (status === "rejected") {
      overrides.rejected_at = "2026-01-03T00:00:00.000+00:00";
    }

    expect(await insertListing(overrides)).toBeNull();
  });

  it.each(["unpublished", "draft", "purged", "Approved", ""])(
    "refuses %s",
    async (status) => {
      expect(await insertListing({ status })).toBe(CHECK_VIOLATION);
    },
  );

  it("refuses a null status", async () => {
    expect(await insertListing({ status: null })).toBe(NOT_NULL_VIOLATION);
  });
});

describe("category check", () => {
  it.each(APPROVED_CATEGORY_KEYS)("accepts the approved key %s", async (category) => {
    expect(await insertListing({ category })).toBeNull();
  });

  it("admits exactly the sixteen approved keys and nothing more", async () => {
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint where conname = 'listing_category_check'`,
    );

    const definition = rows[0]?.definition ?? "";
    const quoted = [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1]);

    expect([...quoted].sort()).toEqual([...APPROVED_CATEGORY_KEYS].sort());
  });

  it.each([
    "other",
    "miscellaneous",
    "uncategorized",
    "health-wellness",
    "food-and-drink",
    "retail",
    "Food & Drink",
    "FOOD-DRINK",
    "",
  ])("refuses the unapproved value %s", async (category) => {
    expect(await insertListing({ category })).toBe(CHECK_VIOLATION);
  });

  it("refuses a null category — from NOT NULL, not from the CHECK", async () => {
    expect(await insertListing({ category: null })).toBe(NOT_NULL_VIOLATION);
  });

  it("applies the same membership rule to a revision's proposed category", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { category: "travel-accommodation" })).toBeNull();
    expect(await insertRevision(listingId, { category: "not-a-category" })).toBe(
      CHECK_VIOLATION,
    );
    expect(await insertRevision(listingId, { category: null })).toBe(NOT_NULL_VIOLATION);
  });
});

describe("publication-state check", () => {
  it.each(["publicly_available", "unpublished"])(
    "accepts %s on an approved listing",
    async (publicationState) => {
      const overrides: Record<string, unknown> = {
        status: "approved",
        publication_state: publicationState,
      };

      if (publicationState === "unpublished") {
        overrides.unpublish_reason = "A current reason.";
      }

      expect(await insertListing(overrides)).toBeNull();
    },
  );

  it("refuses an approved listing with no publication state", async () => {
    expect(await insertListing({ status: "approved", publication_state: null })).toBe(
      CHECK_VIOLATION,
    );
  });

  it("refuses an unapproved publication value on an approved listing", async () => {
    expect(await insertListing({ status: "approved", publication_state: "hidden" })).toBe(
      CHECK_VIOLATION,
    );
  });

  it.each(["pending", "rejected"])(
    "refuses a publication state on a %s listing",
    async (status) => {
      const overrides: Record<string, unknown> = {
        status,
        publication_state: "publicly_available",
      };

      if (status === "rejected") {
        overrides.rejected_at = "2026-01-03T00:00:00.000+00:00";
      }

      expect(await insertListing(overrides)).toBe(CHECK_VIOLATION);
    },
  );
});

describe("unpublish-reason check", () => {
  it("accepts a reason exactly when the listing is unpublished", async () => {
    expect(
      await insertListing({
        status: "approved",
        publication_state: "unpublished",
        unpublish_reason: "A current reason.",
      }),
    ).toBeNull();
  });

  it("refuses an unpublished listing with no reason", async () => {
    expect(
      await insertListing({
        status: "approved",
        publication_state: "unpublished",
        unpublish_reason: null,
      }),
    ).toBe(CHECK_VIOLATION);
  });

  it("refuses a reason on a publicly available listing", async () => {
    expect(
      await insertListing({
        status: "approved",
        publication_state: "publicly_available",
        unpublish_reason: "A reason that should not exist.",
      }),
    ).toBe(CHECK_VIOLATION);
  });

  it("refuses a reason when there is no publication state at all", async () => {
    expect(
      await insertListing({
        status: "pending",
        publication_state: null,
        unpublish_reason: "A reason that should not exist.",
      }),
    ).toBe(CHECK_VIOLATION);
  });
});

describe("listing rejection-timestamp presence rule", () => {
  it("accepts a rejected listing carrying its anchor", async () => {
    expect(
      await insertListing({
        status: "rejected",
        rejected_at: "2026-01-03T04:05:06.789+00:00",
      }),
    ).toBeNull();
  });

  it("refuses a rejected listing with no anchor", async () => {
    expect(await insertListing({ status: "rejected", rejected_at: null })).toBe(
      CHECK_VIOLATION,
    );
  });

  it.each(["pending", "approved"])(
    "refuses an anchor on a %s listing",
    async (status) => {
      const overrides: Record<string, unknown> = {
        status,
        rejected_at: "2026-01-03T04:05:06.789+00:00",
      };

      if (status === "approved") {
        overrides.publication_state = "publicly_available";
      }

      expect(await insertListing(overrides)).toBe(CHECK_VIOLATION);
    },
  );
});

describe("revision state and rejection-timestamp presence rule", () => {
  it.each(["pending", "rejected"])("accepts the persisted state %s", async (state) => {
    const listingId = await insertApprovedListing();
    const overrides: Record<string, unknown> =
      state === "rejected"
        ? { state, rejected_at: "2026-01-03T00:00:00.000+00:00" }
        : { state };

    expect(await insertRevision(listingId, overrides)).toBeNull();
  });

  it("refuses the approved state, which PS-4 removes rather than persists", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { state: "approved" })).toBe(CHECK_VIOLATION);
  });

  it("refuses an unknown or null state", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { state: "withdrawn" })).toBe(CHECK_VIOLATION);
    expect(await insertRevision(listingId, { state: null })).toBe(NOT_NULL_VIOLATION);
  });

  it("refuses a rejected revision with no anchor", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { state: "rejected", rejected_at: null })).toBe(
      CHECK_VIOLATION,
    );
  });

  it("refuses an anchor on a pending revision", async () => {
    const listingId = await insertApprovedListing();

    expect(
      await insertRevision(listingId, {
        state: "pending",
        rejected_at: "2026-01-03T00:00:00.000+00:00",
      }),
    ).toBe(CHECK_VIOLATION);
  });
});

describe("sole pending revision per listing (DI-11)", () => {
  it("accepts one pending revision", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();
  });

  it("refuses a second pending revision on the same listing", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();
    expect(await insertRevision(listingId)).toBe(UNIQUE_VIOLATION);
  });

  it("permits any number of rejected revisions beside one pending revision", async () => {
    const listingId = await insertApprovedListing();
    const rejected = { state: "rejected", rejected_at: "2026-01-03T00:00:00.000+00:00" };

    expect(await insertRevision(listingId, rejected)).toBeNull();
    expect(await insertRevision(listingId, rejected)).toBeNull();
    expect(await insertRevision(listingId)).toBeNull();
    expect(await insertRevision(listingId)).toBe(UNIQUE_VIOLATION);
  });

  it("permits one pending revision on each of two listings", async () => {
    const first = await insertApprovedListing();
    const second = await insertApprovedListing();

    expect(await insertRevision(first)).toBeNull();
    expect(await insertRevision(second)).toBeNull();
  });
});

describe("governed millisecond timestamp round trip", () => {
  /**
   * Conversion is explicit SQL on both sides, so nothing here depends on how the driver
   * parses a timestamp. **The `C9` `pg` type parser is deliberately neither implemented
   * nor registered** (`ADR-022` leaves it to the persistence unit), and these assertions
   * must keep working whatever it eventually does.
   */
  const readEpochMilliseconds = async (listingId: string, column: string) => {
    const { rows } = await client.query<{ ms: string }>(
      `select (extract(epoch from ${column}) * 1000)::bigint::text as ms
         from listing where id = $1`,
      [listingId],
    );

    return Number(rows[0]?.ms);
  };

  it("returns the exact epoch millisecond that was written", async () => {
    const id = randomUUID();
    const epochMilliseconds = 1_767_303_245_123;

    expect(
      await insertListing({
        id,
        submitted_at: new Date(epochMilliseconds).toISOString(),
        last_updated_at: new Date(epochMilliseconds).toISOString(),
      }),
    ).toBeNull();

    expect(await readEpochMilliseconds(id, "submitted_at")).toBe(epochMilliseconds);
  });

  it("treats the same instant written at different offsets as one value", async () => {
    const utc = randomUUID();
    const shifted = randomUUID();

    expect(
      await insertListing({
        id: utc,
        submitted_at: "2026-01-01T21:34:05.123+00:00",
        last_updated_at: "2026-01-01T21:34:05.123+00:00",
      }),
    ).toBeNull();

    expect(
      await insertListing({
        id: shifted,
        submitted_at: "2026-01-02T03:04:05.123+05:30",
        last_updated_at: "2026-01-02T03:04:05.123+05:30",
      }),
    ).toBeNull();

    const fromUtc = await readEpochMilliseconds(utc, "submitted_at");
    const fromShifted = await readEpochMilliseconds(shifted, "submitted_at");

    expect(fromShifted).toBe(fromUtc);
    expect(fromUtc).toBe(1_767_303_245_123);
  });

  it("is unaffected by the session time zone", async () => {
    const id = randomUUID();
    const epochMilliseconds = 1_767_303_245_123;

    expect(
      await insertListing({
        id,
        submitted_at: new Date(epochMilliseconds).toISOString(),
        last_updated_at: new Date(epochMilliseconds).toISOString(),
      }),
    ).toBeNull();

    const readings: number[] = [];

    for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
      await client.query(`set time zone '${zone}'`);
      readings.push(await readEpochMilliseconds(id, "submitted_at"));
    }

    await client.query("set time zone 'UTC'");

    expect(readings).toEqual([epochMilliseconds, epochMilliseconds, epochMilliseconds]);
  });

  it("preserves a pre-epoch instant, which is valid and not merely negative", async () => {
    const id = randomUUID();
    const epochMilliseconds = -2_208_988_800_123;

    expect(
      await insertListing({
        id,
        submitted_at: new Date(epochMilliseconds).toISOString(),
        last_updated_at: new Date(epochMilliseconds).toISOString(),
      }),
    ).toBeNull();

    expect(await readEpochMilliseconds(id, "submitted_at")).toBe(epochMilliseconds);
  });

  it("refuses a null on either required instant", async () => {
    expect(await insertListing({ submitted_at: null })).toBe(NOT_NULL_VIOLATION);
    expect(await insertListing({ last_updated_at: null })).toBe(NOT_NULL_VIOLATION);
  });
});

describe("down migration against an empty schema", () => {
  it(
    "applies and then reverses completely, leaving neither governed table behind",
    async () => {
      const dependencies = dependenciesFor(DOWN_DATABASE);
      const downClient = new Client({
        connectionString: connectionStringFor(DOWN_DATABASE),
      });

      await downClient.connect();

      try {
        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);

        const { rows: created } = await downClient.query<{ table_name: string }>(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_name in ('listing','listing_revision')
            order by table_name`,
        );

        expect(created.map((row) => row.table_name)).toEqual([
          "listing",
          "listing_revision",
        ]);

        expect(await runMigration("down", dependencies)).toBe(SUCCESS);

        const { rows: remaining } = await downClient.query(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_name in ('listing','listing_revision')`,
        );

        expect(remaining).toEqual([]);
      } finally {
        await downClient.end();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});
