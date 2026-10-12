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
 * **The governed runner applies every migration in the folder, so the state under test is the
 * whole applied chain** - `001` and, since issue #183, `002`. This file's subject is still
 * `001`: its tables, columns, constraints and indexes. What `002` changes is accounted for
 * where it lands - the applied-migration list, `listing_revision`'s column count, the revision
 * fixture's `not null` obligation, and the step-by-step reversal at the end - and `002`'s own
 * attacking tests live in `second-schema-migration.test.ts`, not here.
 *
 * Isolation and cleanup are owned by `testing/embedded-cluster.ts` (issue #179): one isolated
 * cluster for this file on an **ephemeral port** with a **disposable data directory**, torn down
 * on every path — success, assertion failure and setup failure alike. The helper closes this
 * file's clients first, requests shutdown once, **waits for the owned postmaster to exit**, and
 * only then removes the directory, under a bounded retry for Windows' transient file-handle
 * release. Cleanup is verified, and a cleanup that cannot prove the cluster is gone fails this
 * file rather than leaving one behind.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

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

/**
 * The second migration, as the provider names it (issue #183).
 *
 * This file's subject is still `001`, but the governed runner applies **every** migration in
 * the folder, so `002` is part of the state every assertion below observes. It is named here
 * so that the discovery and history assertions can state the real, ordered set rather than
 * pretend `001` arrives alone. `002`'s own attacking tests live in
 * `second-schema-migration.test.ts`.
 */
const SECOND_MIGRATION_NAME = "002-add-revision-base-version";

/**
 * The base-version column `002` adds (`ADR-023` items 9-12).
 *
 * `001` does not create it, and this file does not attack it — but it is `not null`, so every
 * revision fixture here must supply it, and the revision shape assertion must count it.
 */
const BASE_VERSION_COLUMN = "base_listing_last_updated_at";

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

const VERIFIED_DATABASE = "migration_verification";
const DOWN_DATABASE = "down_verification";

/**
 * One isolated cluster for this file, owned by the shared helper (issue #179).
 *
 * The directory, the ephemeral port, the server, the single shutdown request, the wait for the
 * owned postmaster to exit and the bounded removal all live in `testing/embedded-cluster.ts`.
 * The wait is the part this file never had: `EmbeddedPostgres.stop()` returns before the
 * postmaster's children have released the data directory, so a teardown that removed it
 * immediately was racing them.
 */
const cluster = useEmbeddedPostgres({
  slug: "migration",
  databases: [VERIFIED_DATABASE, DOWN_DATABASE],
});

let client: PgClient;
/** The session time zone the cluster starts with — established, not assumed. */
let baselineTimeZone: string;

function connectionStringFor(database: string): string {
  return cluster.connectionStringFor(database);
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

/**
 * Run `body` with the session time zone pinned, restoring whatever was actually in force.
 *
 * `client` is this file's one client, shared by every test in it, so a mutation left in place is
 * a mutation every later test inherits. Restoring in `finally` — and restoring the **captured**
 * setting rather than an assumed `UTC` — is what keeps that from depending on execution order.
 * If the body fails, its failure is the one reported; if restoration also fails, both are kept,
 * because a teardown error that swallowed the assertion would hide the reason the test ran.
 */
async function currentTimeZone(): Promise<string> {
  const { rows } = await client.query<{ zone: string }>(
    "select current_setting('timezone') as zone",
  );
  const zone = rows[0]?.zone;

  if (zone === undefined) {
    throw new Error("the session time zone could not be read");
  }

  return zone;
}

async function withSessionTimeZone(zone: string, body: () => Promise<void>): Promise<void> {
  const original = await currentTimeZone();

  await client.query(`set time zone '${zone}'`);

  let bodyError: unknown;
  let threw = false;

  try {
    await body();
  } catch (error) {
    threw = true;
    bodyError = error;
    throw error;
  } finally {
    try {
      await client.query(`set time zone '${original}'`);
    } catch (restoreError) {
      if (!threw) {
        throw restoreError;
      }

      throw new AggregateError(
        [bodyError, restoreError],
        "the assertion failed and restoring the session time zone also failed; the first error " +
          "is the original failure",
      );
    }
  }
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
    // `002` made this `not null` (`ADR-023` item 12: a missing token refuses). Every revision
    // fixture must therefore carry it, including the ones attacking something else - a row
    // that omits it fails on 23502 before reaching the constraint under attack. The value is
    // the listing fixture's own `last_updated_at`, which is what a captured base token is.
    [BASE_VERSION_COLUMN]: "2026-01-02T03:04:05.123+00:00",
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
  client = new Client({ connectionString: connectionStringFor(VERIFIED_DATABASE) });
  await client.connect();

  // The cluster's own default, captured once: the guard below restores *this*, and the leak
  // test asserts against it. Hardcoding `UTC` would assert a value this file never established.
  baselineTimeZone = await currentTimeZone();

  // Registered rather than closed by a local `afterAll`: the helper closes every registered
  // resource before it asks the server to stop, so that ordering cannot be got wrong here.
  cluster.closeBeforeShutdown("migration verification client", () => client.end());
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

    // Exactly the two governed migrations, in the order the ordinal prefixes impose. Stated
    // exhaustively rather than as a subset: a third file appearing in the folder, or either of
    // these failing to apply, must fail here rather than pass unnoticed.
    expect(rows.map((row) => row.name)).toEqual([MIGRATION_NAME, SECOND_MIGRATION_NAME]);
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

  it("gives listing_revision exactly its 19 governed columns, in order", async () => {
    const rows = await columnsOf("listing_revision");

    // Eighteen from `001`, then the base-version column `002` appends (issue #183). `ALTER
    // TABLE ... ADD COLUMN` takes the next ordinal position, so the deterministic order is
    // `001`'s eighteen followed by it — asserted exhaustively and in order, not as a subset.
    expect(rows).toHaveLength(19);
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
      BASE_VERSION_COLUMN,
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

  it("types ADR-022's four lifecycle and rejection instants as timestamptz(3)", async () => {
    // These four are `ADR-022`'s inventory, created by `001`, and they are the whole of it:
    // two write-once/forward-moving listing instants and the two presence-iff-rejected
    // retention anchors. The base-version instant `002` adds is **not** one of them - it
    // belongs to `ADR-023` and is asserted separately below - so this list stays at four and
    // must not be grown into "all the timestamps".
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

  it("carries exactly five timestamptz columns: ADR-022's four plus ADR-023's base version", async () => {
    // The inventory assertion the two ADRs jointly imply. Counting them here is what stops a
    // sixth instant arriving unnoticed, and naming the fifth separately is what keeps
    // `ADR-022`'s four from being quietly redefined as five.
    const instants: string[] = [];

    for (const table of ["listing", "listing_revision"] as const) {
      for (const row of await columnsOf(table)) {
        if (row.data_type === "timestamp with time zone") {
          instants.push(`${table}.${row.column_name}`);
        }
      }
    }

    expect(instants.sort()).toEqual([
      `listing_revision.${BASE_VERSION_COLUMN}`,
      "listing.last_updated_at",
      "listing.rejected_at",
      "listing.submitted_at",
      "listing_revision.rejected_at",
    ].sort());
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
      await withSessionTimeZone(zone, async () => {
        readings.push(await readEpochMilliseconds(id, "submitted_at"));
      });
    }

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
  /**
   * **One `down` is one step, and there are now two migrations** (issue #183).
   *
   * `runMigration("down")` calls Kysely's `migrateDown`, which reverses **the most recently
   * applied migration only**. While `001` stood alone, a single `down` emptied the schema, and
   * this test asserted exactly that. With `002` applied on top, the first `down` reverses
   * `002` and **both tables remain** - so reaching `001`'s reversal now takes a second `down`.
   *
   * That is asserted step by step rather than collapsed, because the intermediate state is the
   * one a real rollback would land in, and a test that only checked the end state would pass
   * even if the first `down` had dropped a table it must not touch.
   */
  it(
    "reverses one migration per step, reaching an empty schema only after both",
    async () => {
      const dependencies = dependenciesFor(DOWN_DATABASE);
      const downClient = new Client({
        connectionString: connectionStringFor(DOWN_DATABASE),
      });

      await downClient.connect();

      const tablesNow = async (): Promise<string[]> => {
        const { rows } = await downClient.query<{ table_name: string }>(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_name in ('listing','listing_revision')
            order by table_name`,
        );

        return rows.map((row) => row.table_name);
      };

      const appliedNow = async (): Promise<string[]> => {
        const { rows } = await downClient.query<{ name: string }>(
          "select name from kysely_migration order by name",
        );

        return rows.map((row) => row.name);
      };

      const revisionColumnsNow = async (): Promise<string[]> => {
        const { rows } = await downClient.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'listing_revision'
            order by ordinal_position`,
        );

        return rows.map((row) => row.column_name);
      };

      try {
        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);

        expect(await tablesNow()).toEqual(["listing", "listing_revision"]);
        expect(await appliedNow()).toEqual([MIGRATION_NAME, SECOND_MIGRATION_NAME]);
        expect(await revisionColumnsNow()).toContain(BASE_VERSION_COLUMN);

        // First step: `002` only. The column goes; everything `001` created stays.
        expect(await runMigration("down", dependencies)).toBe(SUCCESS);

        expect(await appliedNow()).toEqual([MIGRATION_NAME]);
        expect(await tablesNow()).toEqual(["listing", "listing_revision"]);

        const afterFirstDown = await revisionColumnsNow();

        expect(afterFirstDown).not.toContain(BASE_VERSION_COLUMN);
        expect(afterFirstDown).toHaveLength(18);

        // Second step: `001`. Only now is the schema empty.
        expect(await runMigration("down", dependencies)).toBe(SUCCESS);

        expect(await appliedNow()).toEqual([]);
        expect(await tablesNow()).toEqual([]);
      } finally {
        await downClient.end();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

/**
 * The session-setting guard itself, attacked (issue #179).
 *
 * The time-zone test above shares this file's one client with every other test in it, so a zone
 * left in place is a zone they all inherit. These two prove the guard restores on the failure
 * path — which is the only path where it matters — and that nothing leaks out of it.
 */
describe("the session time zone guard", () => {
  it(
    "restores the captured setting even when the guarded assertion throws",
    async () => {
      const before = await currentTimeZone();

      await expect(
        withSessionTimeZone("Asia/Kolkata", async () => {
          expect(await currentTimeZone()).toBe("Asia/Kolkata");

          throw new Error("a deliberate assertion failure");
        }),
      ).rejects.toThrow("a deliberate assertion failure");

      expect(await currentTimeZone()).toBe(before);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "leaves no session state behind for a later test to inherit",
    async () => {
      expect(await currentTimeZone()).toBe(baselineTimeZone);

      await withSessionTimeZone("Pacific/Kiritimati", async () => {
        expect(await currentTimeZone()).toBe("Pacific/Kiritimati");
      });

      expect(await currentTimeZone()).toBe(baselineTimeZone);
    },
    CLUSTER_TIMEOUT_MS,
  );
});
