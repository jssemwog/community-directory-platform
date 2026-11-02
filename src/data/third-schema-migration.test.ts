/**
 * Attacking tests for the third schema migration (issue #258).
 *
 * `003-create-administrator-authentication-tables.ts` creates the seven `ADR-028` tables. These
 * tests attempt every violation its constraints forbid and fail to achieve it, check the exact
 * column, foreign-key, default, trigger and extension surface against the catalogue, and take
 * the migration down and up again on a database of its own.
 *
 * **They run against a real PostgreSQL server** from the `embedded-postgres` development
 * dependency, unconditionally, in one disposable cluster owned by `testing/embedded-cluster.ts`.
 * Nothing here touches any other database.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import { ADMINISTRATOR_AUTHENTICATION_COLUMNS } from "./administrator-authentication-table";
import {
  CONNECTION_STRING_VARIABLE,
  createMigrationProvider,
  SUCCESS,
  runMigration,
  type MigrationDependencies,
} from "./migrate";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";

type Row = Readonly<Record<string, unknown>>;

interface PgModule {
  readonly Pool: new (config: { connectionString: string; max: number }) => PostgresPool & {
    end(): Promise<void>;
  };
  readonly Client: new (config: { connectionString: string }) => {
    connect(): Promise<void>;
    query<R extends Row = Row>(statement: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
    end(): Promise<void>;
  };
}

const { Pool, Client } = createRequire(import.meta.url)("pg") as PgModule;
type PgClient = InstanceType<PgModule["Client"]>;

const VERIFIED_DATABASE = "third_migration_verification";
const REVERSAL_DATABASE = "third_migration_reversal";

const cluster = useEmbeddedPostgres({
  slug: "third-migration",
  databases: [VERIFIED_DATABASE, REVERSAL_DATABASE],
  migrate: [VERIFIED_DATABASE],
});

const MIGRATIONS = [
  "001-create-listing-and-revision-tables",
  "002-add-revision-base-version",
  "003-create-administrator-authentication-tables",
];

const AUTH_TABLES = Object.keys(ADMINISTRATOR_AUTHENTICATION_COLUMNS).sort();

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const NOW = "2026-11-01T12:00:00.000Z";
const HASH = "scrypt$ln=17,r=8,p=1$c2FsdA$a2V5";

let client: PgClient;

function dependenciesFor(database: string): MigrationDependencies {
  return {
    env: { [CONNECTION_STRING_VARIABLE]: cluster.connectionStringFor(database) },
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

/** The SQLSTATE a statement fails with, or `null` if it succeeds. */
async function codeOf(statement: string, values: readonly unknown[] = []): Promise<string | null> {
  try {
    await client.query(statement, values);
    return null;
  } catch (cause) {
    return (cause as { code?: string }).code ?? "no-code";
  }
}

async function insertAdministrator(id = randomUUID(), username = `admin-${id.slice(0, 8)}`): Promise<string> {
  await client.query(
    `insert into administrator (id, username, password_hash, password_disabled_at, disabled_at, created_at)
     values ($1, $2, $3, null, null, $4)`,
    [id, username, HASH, NOW],
  );
  return id;
}

async function insertFactor(administratorId: string, overrides: Partial<Record<string, unknown>> = {}) {
  const v: Record<string, unknown> = {
    state: "active",
    factor_id: randomUUID(),
    secret_ciphertext: randomBytes(20),
    secret_iv: randomBytes(12),
    secret_tag: randomBytes(16),
    key_version: 1,
    last_accepted_step: 1,
    ...overrides,
  };

  return codeOf(
    `insert into administrator_totp_factor
       (administrator_id, state, factor_id, secret_ciphertext, secret_iv, secret_tag, key_version, last_accepted_step)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [administratorId, v.state, v.factor_id, v.secret_ciphertext, v.secret_iv, v.secret_tag, v.key_version, v.last_accepted_step],
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: cluster.connectionStringFor(VERIFIED_DATABASE) });
  await client.connect();
  cluster.closeBeforeShutdown("third-migration client", () => client.end());
}, CLUSTER_TIMEOUT_MS);

describe("applying the chain", () => {
  it("records exactly the three governed migrations, in order", async () => {
    const { rows } = await client.query<{ name: string }>("select name from kysely_migration order by name");
    expect(rows.map((row) => row.name)).toEqual(MIGRATIONS);
  });

  it("creates exactly nine base tables: the two listing tables and the seven ADR-028 tables", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely_%'
        order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([...AUTH_TABLES, "listing", "listing_revision"].sort());
  });

  it("creates exactly the declared columns, in order, with no default anywhere", async () => {
    for (const [table, columns] of Object.entries(ADMINISTRATOR_AUTHENTICATION_COLUMNS)) {
      const { rows } = await client.query<{ column_name: string; column_default: string | null }>(
        `select column_name, column_default from information_schema.columns
          where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [table],
      );
      expect(rows.map((row) => row.column_name)).toEqual(columns);
      expect(rows.filter((row) => row.column_default !== null)).toEqual([]);
    }
  });

  it("stores every instant as timestamptz(3), including the rolling record's elements", async () => {
    const { rows } = await client.query<{ t: string; c: string }>(
      `select format_type(a.atttypid, a.atttypmod) as t, c.relname || '.' || a.attname as c
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relname = any($1) and a.attnum > 0 and not a.attisdropped
          and format_type(a.atttypid, a.atttypmod) like 'timestamp%'`,
      [AUTH_TABLES],
    );
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => !row.t.startsWith("timestamp(3) with time zone"))).toEqual([]);
    expect(rows.find((row) => row.c === "authentication_source_window.recent_failures")?.t).toBe(
      "timestamp(3) with time zone[]",
    );
  });

  it("declares every foreign key ON DELETE NO ACTION, and no trigger or extension", async () => {
    const { rows: keys } = await client.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint
        where contype = 'f' and conrelid::regclass::text = any($1) order by conname`,
      [AUTH_TABLES],
    );
    expect(keys.map((row) => row.conname)).toEqual([
      "administrator_consumed_challenge_administrator_fkey",
      "administrator_pending_challenge_administrator_fkey",
      "administrator_session_administrator_fkey",
      "administrator_totp_factor_administrator_fkey",
    ]);
    expect(keys.every((row) => row.confdeltype === "a")).toBe(true);

    const { rows: triggers } = await client.query(
      `select tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text = any($1)`,
      [AUTH_TABLES],
    );
    expect(triggers).toEqual([]);

    const { rows: extensions } = await client.query<{ extname: string }>("select extname from pg_extension");
    expect(extensions.map((row) => row.extname)).toEqual(["plpgsql"]);
  });
});

describe("administrator and TOTP factor constraints", () => {
  it("refuses a username outside the D-1 form, a duplicate username and a non-scrypt hash", async () => {
    const insert = (username: string, hash = HASH) =>
      codeOf(
        `insert into administrator (id, username, password_hash, password_disabled_at, disabled_at, created_at)
         values ($1, $2, $3, null, null, $4)`,
        [randomUUID(), username, hash, NOW],
      );

    expect(await insert("Admin")).toBe(CHECK_VIOLATION);
    expect(await insert("ab")).toBe(CHECK_VIOLATION);
    expect(await insert("-abc")).toBe(CHECK_VIOLATION);
    expect(await insert("a".repeat(65))).toBe(CHECK_VIOLATION);
    expect(await insert("valid-name", "bcrypt$x")).toBe(CHECK_VIOLATION);
    expect(await insert("valid-name")).toBeNull();
    expect(await insert("valid-name")).toBe(UNIQUE_VIOLATION);
  });

  it("refuses wrong material lengths, a bad state, version or step, and a missing administrator", async () => {
    const id = await insertAdministrator();

    expect(await insertFactor(id, { state: "other" })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { secret_ciphertext: randomBytes(19) })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { secret_iv: randomBytes(11) })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { secret_tag: randomBytes(15) })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { key_version: 0 })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { last_accepted_step: -1 })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(randomUUID())).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("keeps material present if and only if usable, and replay state on an active factor", async () => {
    const id = await insertAdministrator();
    const discarded = {
      state: "reenrolment_required", factor_id: null, secret_ciphertext: null, secret_iv: null,
      secret_tag: null, key_version: null, last_accepted_step: null,
    };

    expect(await insertFactor(id, { ...discarded, factor_id: randomUUID() })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { ...discarded, secret_tag: randomBytes(16) })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { factor_id: null })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { key_version: null })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { state: "pending_confirmation", secret_iv: null })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { last_accepted_step: null })).toBe(CHECK_VIOLATION);
    expect(await insertFactor(id, { state: "pending_confirmation", last_accepted_step: null })).toBeNull();
    expect(await codeOf("delete from administrator_totp_factor where administrator_id = $1", [id])).toBeNull();
    expect(await insertFactor(id, discarded)).toBeNull();
  });

  it("refuses a factor_id shared by two administrators (D-13)", async () => {
    const factorId = randomUUID();

    expect(await insertFactor(await insertAdministrator(), { factor_id: factorId })).toBeNull();
    expect(await insertFactor(await insertAdministrator(), { factor_id: factorId })).toBe(UNIQUE_VIOLATION);
  });
});

describe("challenge and session constraints", () => {
  it("refuses a pending challenge with a wrong digest length, lifetime or administrator", async () => {
    const id = await insertAdministrator();
    const insert = (digest: Buffer, minutes: number, administratorId = id) =>
      codeOf(
        `insert into administrator_pending_challenge (token_digest, administrator_id, created_at, expires_at, invalidated)
         values ($1, $2, $3::timestamptz, $3::timestamptz + make_interval(mins => $4), false)`,
        [digest, administratorId, NOW, minutes],
      );

    expect(await insert(randomBytes(31), 5)).toBe(CHECK_VIOLATION);
    expect(await insert(randomBytes(32), 4)).toBe(CHECK_VIOLATION);
    expect(await insert(randomBytes(32), 6)).toBe(CHECK_VIOLATION);
    expect(await insert(randomBytes(32), 5, randomUUID())).toBe(FOREIGN_KEY_VIOLATION);
    expect(await insert(randomBytes(32), 5)).toBeNull();
  });

  it("refuses a consumed-challenge record with a wrong digest length or administrator", async () => {
    const id = await insertAdministrator();
    const insert = (digest: Buffer, administratorId = id) =>
      codeOf(
        `insert into administrator_consumed_challenge (token_digest, administrator_id, expires_at) values ($1, $2, $3)`,
        [digest, administratorId, NOW],
      );

    expect(await insert(randomBytes(33))).toBe(CHECK_VIOLATION);
    expect(await insert(randomBytes(32), randomUUID())).toBe(FOREIGN_KEY_VIOLATION);
    expect(await insert(randomBytes(32))).toBeNull();
  });

  it("enforces the 12-hour and 15-minute lifetimes, the kind, activity order and the unique id", async () => {
    const id = await insertAdministrator();
    const insert = (kind: string, lifetime: string, overrides: { sessionId?: string; activity?: string } = {}) =>
      codeOf(
        `insert into administrator_session
           (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz + $7::interval)`,
        [randomBytes(32), overrides.sessionId ?? randomUUID(), id, kind, NOW, overrides.activity ?? NOW, lifetime],
      );

    expect(await insert("administrator", "12 hours")).toBeNull();
    expect(await insert("recovery", "15 minutes")).toBeNull();
    expect(await insert("administrator", "11 hours")).toBe(CHECK_VIOLATION);
    expect(await insert("administrator", "15 minutes")).toBe(CHECK_VIOLATION);
    expect(await insert("recovery", "12 hours")).toBe(CHECK_VIOLATION);
    expect(await insert("other", "12 hours")).toBe(CHECK_VIOLATION);
    expect(await insert("administrator", "12 hours", { activity: "2026-11-01T11:59:59.999Z" })).toBe(CHECK_VIOLATION);

    const sessionId = randomUUID();
    expect(await insert("administrator", "12 hours", { sessionId })).toBeNull();
    expect(await insert("administrator", "12 hours", { sessionId })).toBe(UNIQUE_VIOLATION);
  });
});

describe("abuse-control constraints", () => {
  it("refuses a bad scope, digest length, negative count and an inconsistent wait", async () => {
    const insert = (scope: string, digest: Buffer, failures: number, waitUntil: string | null) =>
      codeOf(
        `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
         values ($1, $2, $3, $4, $5)`,
        [scope, digest, failures, waitUntil, NOW],
      );

    expect(await insert("other", randomBytes(32), 1, null)).toBe(CHECK_VIOLATION);
    expect(await insert("password", randomBytes(31), 1, null)).toBe(CHECK_VIOLATION);
    expect(await insert("password", randomBytes(32), -1, null)).toBe(CHECK_VIOLATION);
    expect(await insert("password", randomBytes(32), 5, null)).toBe(CHECK_VIOLATION);
    expect(await insert("password", randomBytes(32), 4, NOW)).toBe(CHECK_VIOLATION);
    expect(await insert("totp", randomBytes(32), 0, null)).toBeNull();
    expect(await insert("recovery_code", randomBytes(32), 5, NOW)).toBeNull();
  });

  it("holds at most 20 failure instants per source (D-6), and refuses a bad digest length", async () => {
    const insert = (digest: Buffer, count: number) =>
      codeOf(
        `insert into authentication_source_window (source_digest, recent_failures)
         values ($1, array(select $2::timestamptz + make_interval(secs => g) from generate_series(1, $3::int) g))`,
        [digest, NOW, count],
      );

    expect(await insert(randomBytes(32), 0)).toBeNull();
    expect(await insert(randomBytes(32), 20)).toBeNull();
    expect(await insert(randomBytes(32), 21)).toBe(CHECK_VIOLATION);
    expect(await insert(randomBytes(30), 1)).toBe(CHECK_VIOLATION);
  });
});

describe("reversal", () => {
  it(
    "drops exactly the seven tables, leaves 001 and 002 intact, and reapplies cleanly",
    async () => {
      const dependencies = dependenciesFor(REVERSAL_DATABASE);
      const reversal = new Client({ connectionString: cluster.connectionStringFor(REVERSAL_DATABASE) });
      await reversal.connect();

      const tables = async () =>
        (
          await reversal.query<{ table_name: string }>(
            `select table_name from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely_%'
              order by table_name`,
          )
        ).rows.map((row) => row.table_name);
      const applied = async () =>
        (await reversal.query<{ name: string }>("select name from kysely_migration order by name")).rows.map(
          (row) => row.name,
        );

      try {
        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);
        expect(await applied()).toEqual(MIGRATIONS);

        expect(await runMigration("down", dependencies)).toBe(SUCCESS);
        expect(await applied()).toEqual(MIGRATIONS.slice(0, 2));
        expect(await tables()).toEqual(["listing", "listing_revision"]);

        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);
        expect(await applied()).toEqual(MIGRATIONS);
        expect(await tables()).toEqual([...AUTH_TABLES, "listing", "listing_revision"].sort());
      } finally {
        await reversal.end();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});
