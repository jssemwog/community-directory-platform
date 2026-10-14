/**
 * Attacking tests for the second schema migration (issue #183).
 *
 * `002-add-revision-base-version.ts` adds **one column** to `listing_revision`:
 * `base_listing_last_updated_at timestamptz(3) not null`, with no default, no `CHECK`, no
 * index and no trigger. These tests attempt every violation that declaration forbids and
 * fail to achieve it, which is what `CONTRIBUTING.md`'s definition of done requires.
 *
 * **They run against a real PostgreSQL server**, started from the `embedded-postgres`
 * development dependency, and they are **unconditional** — nothing is probed, skipped or
 * gated, so no constraint silently goes unattacked.
 *
 * **The server version is a test-harness detail with no production authority.** No
 * PostgreSQL version is selected for production, and nothing here asserts version-specific
 * behaviour: `timestamptz(3)` with declared fractional-second precision and
 * `ALTER TABLE ... ADD/DROP COLUMN` are long-standing core PostgreSQL requiring no
 * extension.
 *
 * **The migration is applied through `runMigration`**, so discovery, ordering and
 * invocation are the real governed ones (`ADR-018`) rather than a hand-rolled `ALTER`.
 * That is what makes the ordering assertion meaningful: `FileMigrationProvider` orders by
 * ascending filename, so `002` can only ever apply after `001`.
 *
 * **Unlike `first-schema-migration.test.ts`, this file registers the governed `pg`
 * timestamp parser** (`timestamp-parser.ts`, issue #173) on one of its clients. `ADR-023`
 * item 11 requires comparison by **exact epoch-millisecond equality**, and a round trip
 * asserted through anything other than the real parser would prove the wrong thing. A
 * second client without the override is kept alongside it, so the raw stored text can be
 * read when that is what a test needs.
 *
 * **What this file does not test, because it does not exist:** no domain field, no mapper,
 * no API transport, no staleness comparison, no administrator message, no `PS-11`
 * behaviour, no isolation level or retry policy, and no revision or moderation
 * persistence. `ADR-023` leaves each to a separately authorized later unit, and this
 * migration adds storage only.
 *
 * Isolation and cleanup are owned by `testing/embedded-cluster.ts` (issue #179): one
 * isolated cluster for this file on an ephemeral port with a disposable data directory,
 * torn down on every path — success, assertion failure and setup failure alike. A cleanup
 * that cannot prove the cluster is gone fails this file rather than leaving one behind,
 * which is the guarantee requirement 23 rests on.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  Kysely,
  PostgresDialect,
  type Insertable,
  type PostgresPool,
  type Selectable,
} from "kysely";
import { Migrator } from "kysely/migration";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import type { ListingRevisionTable, ListingTable } from "./listing-table";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import {
  CONNECTION_STRING_VARIABLE,
  createMigrationProvider,
  SUCCESS,
  runMigration,
  type MigrationDependencies,
} from "./migrate";

/** One query result row, as `pg` returns it. */
type Row = Readonly<Record<string, unknown>>;

/**
 * The narrow slice of `pg` this file uses.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent from this
 * repository (`ADR-017` records it as *"absent and deferred"*). Adding one is a dependency
 * change this unit is not authorized to make, so the module is reached through an explicit
 * runtime require and described here — the pattern `migrate.ts` established.
 */
interface PgModule {
  readonly Pool: new (config: {
    connectionString: string;
    max: number;
  }) => PostgresPool & { end(): Promise<void> };
  readonly Client: new (config: {
    connectionString: string;
    types?: unknown;
  }) => {
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

/** The two migrations, as `FileMigrationProvider` names them. */
const FIRST_MIGRATION_NAME = "001-create-listing-and-revision-tables";
const SECOND_MIGRATION_NAME = "002-add-revision-base-version";

/** The column `002` adds. */
const COLUMN = "base_listing_last_updated_at";

/** PostgreSQL error codes attacked for. Named, because a bare code is a riddle. */
const NOT_NULL_VIOLATION = "23502";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** `001`'s eighteen `listing_revision` columns, in order — the state `002` extends. */
const REVISION_COLUMNS_AFTER_001: readonly string[] = [
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
];

/** `001`'s twenty-one `listing` columns, in order — which `002` must leave untouched. */
const LISTING_COLUMNS_AFTER_001: readonly string[] = [
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
];

const VERIFIED_DATABASE = "second_migration_verification";
const REVERSAL_DATABASE = "second_migration_reversal";

const cluster = useEmbeddedPostgres({
  slug: "second-migration",
  databases: [VERIFIED_DATABASE, REVERSAL_DATABASE],
});

/** The client carrying the governed `timestamptz` override — epoch milliseconds, never `Date`. */
let parsing: PgClient;
/** A client without it, for reading the stored value as PostgreSQL renders it. */
let raw: PgClient;

function connectionStringFor(database: string): string {
  return cluster.connectionStringFor(database);
}

/** The governed runner, pointed at one disposable database. */
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

interface ColumnRow extends Row {
  readonly column_name: string;
  readonly data_type: string;
  readonly datetime_precision: number | null;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly is_identity: string;
  readonly is_generated: string;
}

async function columnsOf(client: PgClient, table: string): Promise<readonly ColumnRow[]> {
  const { rows } = await client.query<ColumnRow>(
    `select column_name, data_type, datetime_precision, is_nullable,
            column_default, is_identity, is_generated
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  );

  return rows;
}

async function columnNamesOf(client: PgClient, table: string): Promise<readonly string[]> {
  return (await columnsOf(client, table)).map((row) => row.column_name);
}

async function appliedMigrations(client: PgClient): Promise<readonly string[]> {
  const { rows } = await client.query<{ name: string }>(
    "select name from kysely_migration order by name",
  );

  return rows.map((row) => row.name);
}

/** Run a statement and return the PostgreSQL error code it raised, or `null` if it did not. */
async function errorCodeOf(
  client: PgClient,
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

const LISTING_INSTANT = "2026-01-02T03:04:05.123+00:00";

/** Insert an approved listing whose `last_updated_at` is a known instant. */
async function insertApprovedListing(instant: string = LISTING_INSTANT): Promise<string> {
  const id = randomUUID();
  const code = await errorCodeOf(
    parsing,
    `insert into listing (
       id, status, name, category, description, locality, country,
       administrative_area, postal_code, phone, email, website,
       publication_state, unpublish_reason, submitted_at, last_updated_at, rejected_at
     ) values ($1, 'approved', 'A Business', 'food-drink', 'A description.',
       'A Locality', 'A Country', null, null, null, null, null,
       'publicly_available', null, $2, $2, null)`,
    [id, instant],
  );

  expect(code).toBeNull();
  return id;
}

/**
 * Insert a revision, with the base-version column supplied unless overridden.
 *
 * `omitBaseVersion` leaves the column out of the statement entirely, which is what
 * requirement 13 attacks: a caller that does not know about the token at all.
 */
async function insertRevision(
  listingId: string,
  options: {
    readonly state?: string;
    readonly baseVersion?: string | null;
    readonly omitBaseVersion?: boolean;
    readonly rejectedAt?: string | null;
    readonly id?: string;
  } = {},
): Promise<string | null> {
  const {
    state = "pending",
    baseVersion = LISTING_INSTANT,
    omitBaseVersion = false,
    rejectedAt = state === "rejected" ? LISTING_INSTANT : null,
    id = randomUUID(),
  } = options;

  const row: Record<string, unknown> = {
    id,
    listing_id: listingId,
    state,
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
    rejected_at: rejectedAt,
  };

  if (!omitBaseVersion) {
    row[COLUMN] = baseVersion;
  }

  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  return errorCodeOf(
    parsing,
    `insert into listing_revision (${columns.join(", ")}) values (${placeholders.join(", ")})`,
    Object.values(row),
  );
}

beforeAll(async () => {
  parsing = new Client({
    connectionString: connectionStringFor(VERIFIED_DATABASE),
    types: createTimestamptzTypeOverrides(),
  });
  raw = new Client({ connectionString: connectionStringFor(VERIFIED_DATABASE) });

  await parsing.connect();
  await raw.connect();

  // Registered rather than closed by a local `afterAll`: the helper closes every registered
  // resource before it asks the server to stop, so that ordering cannot be got wrong here.
  cluster.closeBeforeShutdown("base-version parsing client", () => parsing.end());
  cluster.closeBeforeShutdown("base-version raw client", () => raw.end());
}, CLUSTER_TIMEOUT_MS);

describe("applying the chain", () => {
  it(
    "applies 001 then 002 through the governed runner and reports success",
    async () => {
      expect(await runMigration("latest", dependenciesFor(VERIFIED_DATABASE))).toBe(SUCCESS);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it("records exactly the two expected migrations, in governed order", async () => {
    // Exhaustive, not a subset: a third migration file, or either of these failing to apply,
    // must fail here. `FileMigrationProvider` orders by ascending name, so the ordinal
    // prefixes are the ordering, and `002` cannot precede `001`.
    expect(await appliedMigrations(raw)).toEqual([
      FIRST_MIGRATION_NAME,
      SECOND_MIGRATION_NAME,
    ]);
  });

  it("creates no third table", async () => {
    const { rows } = await raw.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name not like 'kysely_%'
        order by table_name`,
    );

    expect(rows.map((row) => row.table_name)).toEqual(["listing", "listing_revision"]);
  });
});

describe("what 002 changes, and what it must not", () => {
  it("leaves listing exactly as 001 created it", async () => {
    // Requirement 3. The column list, its order, and every column's type, nullability and
    // default — so a stray `ALTER` on the wrong table cannot pass.
    const columns = await columnsOf(raw, "listing");

    expect(columns.map((row) => row.column_name)).toEqual(LISTING_COLUMNS_AFTER_001);
    expect(columns.some((row) => row.column_name === COLUMN)).toBe(false);

    const lastUpdated = columns.find((row) => row.column_name === "last_updated_at");

    expect(lastUpdated?.data_type).toBe("timestamp with time zone");
    expect(lastUpdated?.datetime_precision).toBe(3);
    expect(lastUpdated?.is_nullable).toBe("NO");
    expect(lastUpdated?.column_default).toBeNull();
  });

  it("adds exactly one column to listing_revision, in the deterministic last position", async () => {
    // Requirement 4. `ALTER TABLE ... ADD COLUMN` takes the next ordinal position, so the
    // order is `001`'s eighteen followed by this one.
    expect(await columnNamesOf(raw, "listing_revision")).toEqual([
      ...REVISION_COLUMNS_AFTER_001,
      COLUMN,
    ]);
  });

  it("declares the column timestamptz(3), not null, with no default", async () => {
    // Requirements 5, 6, 7 and 8 together — the whole declaration, asserted as one shape.
    const found = (await columnsOf(raw, "listing_revision")).find(
      (row) => row.column_name === COLUMN,
    );

    expect(found?.data_type).toBe("timestamp with time zone");
    expect(found?.datetime_precision).toBe(3);
    expect(found?.is_nullable).toBe("NO");
    expect(found?.column_default).toBeNull();
    expect(found?.is_identity).toBe("NO");
    expect(found?.is_generated).toBe("NEVER");
  });

  it("adds no check constraint", async () => {
    // Requirement 9. `ADR-023`'s "must equal the listing's current value" is a cross-row
    // condition a CHECK cannot express, so none must exist — `001`'s eight remain, and the
    // not-null is counted separately by PostgreSQL as a check on some versions, so this
    // asserts on the constraint's own definition mentioning the column.
    const { rows } = await raw.query<{ constraint_name: string; check_clause: string }>(
      `select c.constraint_name, c.check_clause
         from information_schema.check_constraints c
         join information_schema.constraint_table_usage u
           on u.constraint_name = c.constraint_name
          and u.constraint_schema = c.constraint_schema
        where c.constraint_schema = 'public'
          and u.table_schema = 'public'
          and c.check_clause like '%' || $1 || '%'
          and c.check_clause not like '%IS NOT NULL%'`,
      [COLUMN],
    );

    expect(rows).toEqual([]);
  });

  it("adds no index, under DDM-4 or otherwise", async () => {
    // Requirement 10. `001`'s three integrity indexes are the whole inventory: two primary
    // keys and the DI-11 partial unique. Indexing is DDM-4, unresolved with OQ-4.
    const { rows } = await raw.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and tablename in ('listing','listing_revision')
        order by indexname`,
    );

    expect(rows.map((row) => row.indexname)).toEqual([
      "listing_pkey",
      "listing_revision_one_pending_per_listing",
      "listing_revision_pkey",
    ]);

    const { rows: mentioning } = await raw.query(
      `select indexname from pg_indexes
        where schemaname = 'public' and indexdef like '%' || $1 || '%'`,
      [COLUMN],
    );

    expect(mentioning).toEqual([]);
  });

  it("creates no trigger, and no sequence or extension of its own", async () => {
    // Requirements 11 and 12. Immutability is a write-path rule (`ADR-017` PS-9's precedent),
    // never a trigger; and nothing here needs a sequence or an extension.
    const { rows: triggers } = await raw.query(
      "select tgname from pg_trigger where not tgisinternal",
    );

    expect(triggers).toEqual([]);

    const { rows: sequences } = await raw.query(
      "select sequence_name from information_schema.sequences where sequence_schema = 'public'",
    );

    expect(sequences).toEqual([]);

    const { rows: extensions } = await raw.query<{ extname: string }>(
      "select extname from pg_extension where extname <> 'plpgsql' order by extname",
    );

    expect(extensions).toEqual([]);
  });
});

describe("the not-null obligation", () => {
  it("refuses a revision that omits the token entirely", async () => {
    // Requirement 13. `ADR-023` item 12: a missing token refuses the write. NOT NULL makes
    // absence unstorable rather than merely policed, so a caller that does not know about the
    // token cannot create an unapprovable row.
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { omitBaseVersion: true })).toBe(
      NOT_NULL_VIOLATION,
    );
  });

  it("refuses an explicit null token", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { baseVersion: null })).toBe(NOT_NULL_VIOLATION);
  });

  it("accepts a revision carrying the listing's captured last_updated_at", async () => {
    // Requirement 14 — the positive case, which is what makes the refusals above meaningful.
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();
  });

  it("requires the token on a rejected revision as well as a pending one", async () => {
    // Requirement 18. Both persisted states need it: pending for the OP-10 comparison, and
    // rejected because its base is part of the record OQ-13 retains. `approved` never
    // persists (`ADR-017` PS-4/PS-5), so these two are the whole of it.
    const pendingListing = await insertApprovedListing();
    const rejectedListing = await insertApprovedListing();

    expect(await insertRevision(pendingListing, { omitBaseVersion: true })).toBe(
      NOT_NULL_VIOLATION,
    );
    expect(
      await insertRevision(rejectedListing, { state: "rejected", omitBaseVersion: true }),
    ).toBe(NOT_NULL_VIOLATION);

    // And both succeed once it is supplied, so the refusal is about the token and not the state.
    expect(await insertRevision(pendingListing)).toBeNull();
    expect(await insertRevision(rejectedListing, { state: "rejected" })).toBeNull();
  });

  it("gives PostgreSQL no way to fabricate the token", async () => {
    // Requirement 17. With no default, no identity and no generated expression, the server
    // has nothing to supply — which is the point: a default would invent a base version
    // nobody captured, and a clock default would make every comparison pass.
    const listingId = await insertApprovedListing();

    expect(
      await errorCodeOf(
        parsing,
        `insert into listing_revision (
           id, listing_id, state, name, category, description, locality, country
         ) values ($1, $2, 'pending', 'A Business', 'food-drink', 'A description.',
           'A Locality', 'A Country')`,
        [randomUUID(), listingId],
      ),
    ).toBe(NOT_NULL_VIOLATION);

    const { rows } = await raw.query(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'listing_revision'
          and column_name = $1 and column_default is not null`,
      [COLUMN],
    );

    expect(rows).toEqual([]);
  });
});

describe("the ADR-022 round trip", () => {
  /**
   * Requirements 15 and 16.
   *
   * `ADR-023` item 11 requires **exact epoch-millisecond equality**, so the value read back
   * must be the identical integer — not a near value, and never a `Date`. The assertion goes
   * through the real governed parser, because a round trip proven with an ad-hoc conversion
   * would prove the conversion rather than the boundary.
   */
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["a representative modern instant", Date.UTC(2026, 0, 2, 3, 4, 5, 123)],
    ["the epoch itself", 0],
    ["a pre-epoch instant, negative milliseconds", Date.UTC(1962, 5, 14, 12, 30, 0, 250)],
    ["a millisecond edge, .001", Date.UTC(2026, 0, 2, 3, 4, 5, 1)],
    ["a millisecond edge, .999", Date.UTC(2026, 0, 2, 3, 4, 5, 999)],
  ];

  for (const [label, epochMilliseconds] of cases) {
    it(`round-trips ${label} as the identical epoch-millisecond integer`, async () => {
      const listingId = await insertApprovedListing();
      const revisionId = randomUUID();

      // Written as an explicit instant so the test states the value it means, and read back
      // through the override. `to_timestamp` takes seconds, so the millisecond count is
      // divided — and the division is exact for an integer millisecond value.
      const code = await errorCodeOf(
        parsing,
        `insert into listing_revision (
           id, listing_id, state, name, category, description, locality, country,
           administrative_area, postal_code, phone, email, website, rejected_at, ${COLUMN}
         ) values ($1, $2, 'pending', 'A Business', 'food-drink', 'A description.',
           'A Locality', 'A Country', null, null, null, null, null, null,
           to_timestamp($3::bigint / 1000.0))`,
        [revisionId, listingId, String(epochMilliseconds)],
      );

      expect(code).toBeNull();

      const { rows } = await parsing.query<{ token: unknown }>(
        `select ${COLUMN} as token from listing_revision where id = $1`,
        [revisionId],
      );
      const token = rows[0]?.token;

      expect(typeof token).toBe("number");
      expect(token).not.toBeInstanceOf(Date);
      expect(Number.isSafeInteger(token)).toBe(true);
      expect(token).toBe(epochMilliseconds);
    });
  }

  it("compares equal to the listing's own last_updated_at when the base is current", async () => {
    // The comparison `ADR-023` will perform, proven to be expressible on these two columns
    // alone — requirement 17 of the Scope Gate's audit: no further schema element is needed.
    // **This is not the staleness check**: no predicate, refusal path or message is
    // implemented here, and none is authorized by this unit.
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();

    const { rows } = await parsing.query<{ matches: boolean }>(
      `select r.${COLUMN} = l.last_updated_at as matches
         from listing_revision r join listing l on l.id = r.listing_id
        where r.listing_id = $1`,
      [listingId],
    );

    expect(rows[0]?.matches).toBe(true);
  });
});

describe("001's constraints still behave as 001 declared them", () => {
  /**
   * Requirement 19. Adding a column must not disturb anything `001` enforces, so the
   * neighbouring rules are re-attacked here rather than assumed — each with the token
   * correctly supplied, so that what fails is the rule under attack and not the new column.
   */
  it("still refuses a revision whose listing does not exist", async () => {
    expect(await insertRevision(randomUUID())).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("still refuses a second pending revision for one listing (DI-11)", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId)).toBeNull();
    expect(await insertRevision(listingId)).toBe(UNIQUE_VIOLATION);
  });

  it("still permits many rejected revisions beside one pending (DI-11 is about pending)", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { state: "rejected" })).toBeNull();
    expect(await insertRevision(listingId, { state: "rejected" })).toBeNull();
    expect(await insertRevision(listingId)).toBeNull();
  });

  it("still refuses an unapproved revision state", async () => {
    const listingId = await insertApprovedListing();

    expect(await insertRevision(listingId, { state: "approved" })).toBe(CHECK_VIOLATION);
  });

  it("still enforces rejected_at presence if and only if rejected", async () => {
    const listingId = await insertApprovedListing();
    const other = await insertApprovedListing();

    expect(
      await insertRevision(listingId, { state: "rejected", rejectedAt: null }),
    ).toBe(CHECK_VIOLATION);
    expect(
      await insertRevision(other, { state: "pending", rejectedAt: LISTING_INSTANT }),
    ).toBe(CHECK_VIOLATION);
  });

  it("still refuses a duplicate revision identity", async () => {
    const listingId = await insertApprovedListing();
    const id = randomUUID();

    expect(await insertRevision(listingId, { id })).toBeNull();
    expect(await insertRevision(await insertApprovedListing(), { id })).toBe(UNIQUE_VIOLATION);
  });

  it("still refuses an unapproved category on a revision", async () => {
    const listingId = await insertApprovedListing();
    const code = await errorCodeOf(
      parsing,
      `insert into listing_revision (
         id, listing_id, state, name, category, description, locality, country, ${COLUMN}
       ) values ($1, $2, 'pending', 'A Business', 'not-a-category', 'A description.',
         'A Locality', 'A Country', $3)`,
      [randomUUID(), listingId, LISTING_INSTANT],
    );

    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe("reversal", () => {
  /**
   * Requirements 20, 21 and 22, on a database of their own so that the verified schema above
   * is not torn down beneath the assertions that depend on it.
   *
   * `runMigration("down")` calls Kysely's `migrateDown`, which reverses **one** migration —
   * the most recently applied. So one `down` from latest removes `002` and nothing else, and
   * `001` must survive it intact.
   */
  it(
    "removes only 002, leaves 001 intact, and restores cleanly on reapply",
    async () => {
      const dependencies = dependenciesFor(REVERSAL_DATABASE);
      const client = new Client({
        connectionString: connectionStringFor(REVERSAL_DATABASE),
      });

      await client.connect();

      try {
        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);
        expect(await appliedMigrations(client)).toEqual([
          FIRST_MIGRATION_NAME,
          SECOND_MIGRATION_NAME,
        ]);

        const indexesBefore = await client.query<{ indexname: string }>(
          `select indexname from pg_indexes
            where schemaname = 'public' and tablename in ('listing','listing_revision')
            order by indexname`,
        );
        // The eight CHECK constraints 001 declared by name. `information_schema` also reports
        // implicit not-null entries, named positionally by attribute number
        // (`2200_16464_19_not_null`) rather than by column, so they shift with the column
        // count and say nothing about 001's rules — only the governed `_check` ones do, and
        // they are asserted by name rather than by count.
        const governedChecks = async (): Promise<readonly string[]> => {
          const { rows } = await client.query<{ constraint_name: string }>(
            `select constraint_name from information_schema.check_constraints
              where constraint_schema = 'public'
                and constraint_name like '%\_check' escape '\'
              order by constraint_name`,
          );

          return rows.map((row) => row.constraint_name);
        };

        const GOVERNED_CHECKS: readonly string[] = [
          "listing_category_check",
          "listing_publication_state_check",
          "listing_rejected_at_check",
          "listing_revision_category_check",
          "listing_revision_rejected_at_check",
          "listing_revision_state_check",
          "listing_status_check",
          "listing_unpublish_reason_check",
        ];

        expect(await governedChecks()).toEqual(GOVERNED_CHECKS);

        // Requirement 20 — one step down.
        expect(await runMigration("down", dependencies)).toBe(SUCCESS);

        // Requirement 21 — 001 remains applied, both tables remain, the column is gone, and
        // everything 001 created is untouched.
        expect(await appliedMigrations(client)).toEqual([FIRST_MIGRATION_NAME]);

        const { rows: tables } = await client.query<{ table_name: string }>(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_name in ('listing','listing_revision')
            order by table_name`,
        );

        expect(tables.map((row) => row.table_name)).toEqual(["listing", "listing_revision"]);
        expect(await columnNamesOf(client, "listing_revision")).toEqual(
          REVISION_COLUMNS_AFTER_001,
        );
        expect(await columnNamesOf(client, "listing")).toEqual(LISTING_COLUMNS_AFTER_001);

        const indexesAfter = await client.query<{ indexname: string }>(
          `select indexname from pg_indexes
            where schemaname = 'public' and tablename in ('listing','listing_revision')
            order by indexname`,
        );
        expect(indexesAfter.rows).toEqual(indexesBefore.rows);

        // 002 adds no CHECK, so reversing it must leave 001's eight exactly — the same set,
        // by name, not merely the same count.
        expect(await governedChecks()).toEqual(GOVERNED_CHECKS);

        // Requirement 22 — reapplying restores 002 exactly.
        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);
        expect(await appliedMigrations(client)).toEqual([
          FIRST_MIGRATION_NAME,
          SECOND_MIGRATION_NAME,
        ]);
        expect(await columnNamesOf(client, "listing_revision")).toEqual([
          ...REVISION_COLUMNS_AFTER_001,
          COLUMN,
        ]);

        const restored = (await columnsOf(client, "listing_revision")).find(
          (row) => row.column_name === COLUMN,
        );

        expect(restored?.data_type).toBe("timestamp with time zone");
        expect(restored?.datetime_precision).toBe(3);
        expect(restored?.is_nullable).toBe("NO");
        expect(restored?.column_default).toBeNull();
      } finally {
        await client.end();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

/**
 * The `C9` declaration agrees with what `002` actually created (issue #187).
 *
 * `listing-table.ts` tells the type system what it may assume about `listing_revision`.
 * Until this unit it did not mention the column `002` added — the type and the schema
 * disagreed, and nothing failed. These cases close that gap from **both** directions: the
 * column list, carrier and nullability are read from the live catalogue, the same three
 * are read from the Kysely declaration, and the two are compared.
 *
 * **This adds no second source of schema authority.** The migration remains the only
 * statement of the shape. The bridge below is a `Record<keyof ListingRevisionTable, true>`,
 * so `tsc` refuses it if it omits a declared column or names one that is not declared —
 * it cannot drift from the type it mirrors, and it asserts nothing about the database. The
 * database side of every comparison comes from `information_schema`.
 *
 * Still deliberately absent, and untestable because it does not exist: any revision
 * serializer, hydrator, insert, read or update. The declaration makes the column
 * *visible* to `C9` and nothing more.
 */
const DECLARED_REVISION_COLUMNS: Record<keyof ListingRevisionTable, true> = {
  id: true,
  listing_id: true,
  state: true,
  name: true,
  category: true,
  description: true,
  locality: true,
  country: true,
  administrative_area: true,
  postal_code: true,
  postal_code_designated_public: true,
  phone: true,
  phone_designated_public: true,
  email: true,
  email_designated_public: true,
  website: true,
  website_designated_public: true,
  rejected_at: true,
  base_listing_last_updated_at: true,
};

const DECLARED_REVISION_COLUMN_NAMES: readonly string[] =
  Object.keys(DECLARED_REVISION_COLUMNS);

describe("the Kysely declaration agrees with migration 002 (issue #187)", () => {
  it("declares the column under the exact database name the migration created", () => {
    // `COLUMN` is the fixture the rest of this file already measures `002` by, so the name
    // is not independently retyped here.
    expect(DECLARED_REVISION_COLUMN_NAMES).toContain(COLUMN);
  });

  it("declares every column the catalogue reports, and none the catalogue lacks", async () => {
    // Agreement in both directions, with the catalogue as the sole authority on the list.
    // Before this unit the declaration was missing `COLUMN`, and this case is what fails.
    const actual = [...(await columnNamesOf(raw, "listing_revision"))].sort();

    expect([...DECLARED_REVISION_COLUMN_NAMES].sort()).toEqual(actual);
  });

  it("agrees with the catalogue that the token is not nullable", async () => {
    // The declaration says `ReadOnlyColumn<number>`, not `number | null`; the catalogue
    // says `NOT NULL`. The type half is the `_TheDeclaredCarrierAdmitsNoNull` guard below,
    // which `npm run typecheck` enforces; this is the database half.
    const columns = await columnsOf(raw, "listing_revision");
    const token = columns.find((row) => row.column_name === COLUMN);

    expect(token?.is_nullable).toBe("NO");
    expect(token?.data_type).toBe("timestamp with time zone");
    expect(token?.datetime_precision).toBe(3);

    // The contrast that makes the declared non-nullability meaningful: the sibling whose
    // nullability is real, and which the declaration correctly types `number | null`.
    const rejectedAt = columns.find((row) => row.column_name === "rejected_at");

    expect(rejectedAt?.is_nullable).toBe("YES");
  });

  it("names a column the database accepts, carrying epoch milliseconds and not a Date", async () => {
    // Proves two things at once: the declared name is the real one rather than a plausible
    // near-miss, and the carrier the declaration promises (`number`) is the carrier the
    // offset-aware parser actually produces (issue #173), not the `Date` conversion
    // `ADR-022` forbids.
    //
    // Rows here are whatever this file's own `NOT NULL` cases left behind; this case
    // asserts nothing about how many there are, because revision persistence does not
    // exist and the count is not this unit's claim to make.
    const { rows } = await parsing.query<{ readonly captured: unknown }>(
      `select ${COLUMN} as captured from listing_revision`,
    );

    for (const row of rows) {
      expect(typeof row.captured).toBe("number");
      expect(Number.isSafeInteger(row.captured)).toBe(true);
      expect(row.captured).not.toBeInstanceOf(Date);
    }
  });

  it("leaves listing_revision unwritable, so no repository operation becomes possible", () => {
    // Making the column visible to `C9` must not make the table writable. Every column is
    // `ReadOnlyColumn`, so no insert compiles — the `_TheTableHasNoInsertableColumn` guard
    // below states that, and `tsc` enforces it. Nothing is executed here, because a
    // runtime insert would be the persistence this unit excludes.
    expect(DECLARED_REVISION_COLUMN_NAMES).toHaveLength(19);
  });
});

/**
 * Compile-time guards for the declaration (issue #187 ruling item 7).
 *
 * Checked by `tsc`, so `npm run typecheck` fails if the declared carrier is widened to
 * admit `null`, swapped for `Date`, or made insertable. No runtime assertion can catch
 * those: each would leave this suite green while the type system quietly promised
 * something the schema does not permit, or permitted a write the table forbids.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;

type SelectedRevision = Selectable<ListingRevisionTable>;
type InsertableRevision = Insertable<ListingRevisionTable>;

type _TheDeclaredCarrierIsNumber = Assert<
  Equals<SelectedRevision["base_listing_last_updated_at"], number>
>;
type _TheDeclaredCarrierAdmitsNoNull = Assert<
  Equals<null extends SelectedRevision["base_listing_last_updated_at"] ? true : false, false>
>;
type _TheDeclaredCarrierIsNotADate = Assert<
  Equals<Date extends SelectedRevision["base_listing_last_updated_at"] ? true : false, false>
>;
/** The sibling whose nullability is genuine, so the contrast cannot be flattened. */
type _TheRejectionAnchorStillAdmitsNull = Assert<
  Equals<SelectedRevision["rejected_at"], number | null>
>;
/** `Insertable` of a table whose every column is `never` on insert has no usable key. */
type _TheTableHasNoInsertableColumn = Assert<
  Equals<keyof InsertableRevision extends never ? true : false, true>
>;
/** The carrier matches the listing instant it copies, so the `C9` round trip cannot drift. */
type _ItMatchesTheListingInstantCarrier = Assert<
  Equals<
    SelectedRevision["base_listing_last_updated_at"],
    Selectable<ListingTable>["last_updated_at"]
  >
>;
