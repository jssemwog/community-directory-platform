/**
 * Attacking tests for the fourth schema migration (issue #266 §6.1).
 *
 * `004-add-administrator-recovery-codes-and-factor-origin.ts` creates `administrator_recovery_code`
 * (`ADR-028` PS-6) and adds `administrator_totp_factor.origin_recovery_session_id` with
 * `administrator_totp_factor_origin_check` (`ADR-029` RA-3). These tests attempt every violation
 * its constraints forbid and fail to achieve it, check the exact column, constraint, default,
 * foreign-key and trigger surface against the catalogue, and take the migration down and up
 * again on a database of its own.
 *
 * **They run against a real PostgreSQL server** from the `embedded-postgres` development
 * dependency, in one disposable cluster owned by `testing/embedded-cluster.ts`. Nothing here
 * touches any other database.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

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

const VERIFIED_DATABASE = "fourth_migration_verification";
const REVERSAL_DATABASE = "fourth_migration_reversal";

const cluster = useEmbeddedPostgres({
  slug: "fourth-migration",
  databases: [VERIFIED_DATABASE, REVERSAL_DATABASE],
  migrate: [VERIFIED_DATABASE],
});

const MIGRATIONS = [
  "001-create-listing-and-revision-tables",
  "002-add-revision-base-version",
  "003-create-administrator-authentication-tables",
  "004-add-administrator-recovery-codes-and-factor-origin",
];

/** `003`'s factor columns, in order; `004` appends the origin. */
const FACTOR_COLUMNS_AFTER_003 = [
  "administrator_id",
  "state",
  "factor_id",
  "secret_ciphertext",
  "secret_iv",
  "secret_tag",
  "key_version",
  "last_accepted_step",
];

const TABLES_AFTER_003 = [
  "administrator",
  "administrator_consumed_challenge",
  "administrator_pending_challenge",
  "administrator_session",
  "administrator_totp_factor",
  "authentication_source_window",
  "authentication_throttle",
  "listing",
  "listing_revision",
];

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const NOW = "2026-11-03T12:00:00.000Z";
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

/** The constraint a statement violates, or `null` if it succeeds. */
async function constraintOf(statement: string, values: readonly unknown[] = []): Promise<string | null> {
  try {
    await client.query(statement, values);
    return null;
  } catch (cause) {
    return (cause as { constraint?: string }).constraint ?? "no-constraint";
  }
}

async function extensionsOf(target: PgClient): Promise<string[]> {
  const { rows } = await target.query<{ extname: string }>("select extname from pg_extension order by extname");
  return rows.map((row) => row.extname);
}

async function insertAdministrator(id = randomUUID()): Promise<string> {
  await client.query(
    `insert into administrator (id, username, password_hash, password_disabled_at, disabled_at, created_at)
     values ($1, $2, $3, null, null, $4)`,
    [id, `admin-${id.slice(0, 8)}`, HASH, NOW],
  );
  return id;
}

const insertCode = (administratorId: string, digest: Buffer | null) =>
  codeOf("insert into administrator_recovery_code (administrator_id, code_digest) values ($1, $2)", [
    administratorId,
    digest,
  ]);

/** Insert a factor row with an origin; returns the violated constraint, or `null`. */
function insertFactorWithOrigin(administratorId: string, state: string, origin: string | null): Promise<string | null> {
  const material = state === "reenrolment_required";
  return constraintOf(
    `insert into administrator_totp_factor
       (administrator_id, state, factor_id, secret_ciphertext, secret_iv, secret_tag, key_version,
        last_accepted_step, origin_recovery_session_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      administratorId,
      state,
      material ? null : randomUUID(),
      material ? null : randomBytes(20),
      material ? null : randomBytes(12),
      material ? null : randomBytes(16),
      material ? null : 1,
      state === "active" ? 1 : null,
      origin,
    ],
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: cluster.connectionStringFor(VERIFIED_DATABASE) });
  await client.connect();
  cluster.closeBeforeShutdown("fourth-migration client", () => client.end());
}, CLUSTER_TIMEOUT_MS);

describe("applying the chain", () => {
  it("records exactly the four governed migrations, in order", async () => {
    const { rows } = await client.query<{ name: string }>("select name from kysely_migration order by name");
    expect(rows.map((row) => row.name)).toEqual(MIGRATIONS);
  });

  it("creates exactly ten base tables, the eighth ADR-028 table being administrator_recovery_code", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely_%'
        order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([...TABLES_AFTER_003, "administrator_recovery_code"].sort());
  });
});

describe("administrator_recovery_code (ADR-028 PS-6)", () => {
  it("has exactly its two columns, no default, its named constraints, no trigger and no extension", async () => {
    const { rows: columns } = await client.query<{ column_name: string; column_default: string | null; is_nullable: string; data_type: string }>(
      `select column_name, column_default, is_nullable, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'administrator_recovery_code' order by ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: "administrator_id", column_default: null, is_nullable: "NO", data_type: "uuid" },
      { column_name: "code_digest", column_default: null, is_nullable: "NO", data_type: "bytea" },
    ]);

    const { rows: constraints } = await client.query<{ conname: string; contype: string; confdeltype: string }>(
      `select conname, contype, confdeltype from pg_constraint
        where conrelid = 'administrator_recovery_code'::regclass order by conname`,
    );
    expect(constraints).toEqual([
      { conname: "administrator_recovery_code_administrator_fkey", contype: "f", confdeltype: "a" },
      { conname: "administrator_recovery_code_digest_length_check", contype: "c", confdeltype: " " },
      { conname: "administrator_recovery_code_pkey", contype: "p", confdeltype: " " },
    ]);

    const { rows: triggers } = await client.query(
      "select tgname from pg_trigger where not tgisinternal and tgrelid = 'administrator_recovery_code'::regclass",
    );
    expect(triggers).toEqual([]);

    // No extension is installed by the chain, and nothing of the table depends on one.
    expect(await extensionsOf(client)).toEqual(["plpgsql"]);
    const { rows: extensionDependencies } = await client.query(
      `select 1 from pg_depend d join pg_extension e on d.refclassid = 'pg_extension'::regclass and d.refobjid = e.oid
        where d.classid = 'pg_class'::regclass and d.objid = 'administrator_recovery_code'::regclass`,
    );
    expect(extensionDependencies).toEqual([]);
  });

  it("refuses a digest of 0, 31 or 33 bytes, a null digest, and a duplicate code for one administrator", async () => {
    const id = await insertAdministrator();
    const digest = randomBytes(32);

    expect(await insertCode(id, Buffer.alloc(0))).toBe(CHECK_VIOLATION);
    expect(await insertCode(id, randomBytes(31))).toBe(CHECK_VIOLATION);
    expect(await insertCode(id, randomBytes(33))).toBe(CHECK_VIOLATION);
    expect(await insertCode(id, null)).toBe(NOT_NULL_VIOLATION);
    expect(await insertCode(id, digest)).toBeNull();
    expect(await insertCode(id, digest)).toBe(UNIQUE_VIOLATION);
    // The same digest for another administrator is a different key.
    expect(await insertCode(await insertAdministrator(), digest)).toBeNull();
  });

  it("refuses a code for a missing administrator, and refuses deleting an administrator that has codes (NO ACTION)", async () => {
    const id = await insertAdministrator();

    expect(await insertCode(randomUUID(), randomBytes(32))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await insertCode(id, randomBytes(32))).toBeNull();
    expect(await codeOf("delete from administrator where id = $1", [id])).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("the factor's recovery origin (ADR-029 RA-3)", () => {
  it("is a nullable uuid with no default and no foreign key, appended after 003's columns", async () => {
    const { rows } = await client.query<{ column_name: string; column_default: string | null; is_nullable: string; data_type: string }>(
      `select column_name, column_default, is_nullable, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'administrator_totp_factor' order by ordinal_position`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([...FACTOR_COLUMNS_AFTER_003, "origin_recovery_session_id"]);
    expect(rows.at(-1)).toEqual({
      column_name: "origin_recovery_session_id",
      column_default: null,
      is_nullable: "YES",
      data_type: "uuid",
    });

    const { rows: keys } = await client.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'administrator_totp_factor'::regclass and contype = 'f' order by conname`,
    );
    expect(keys.map((row) => row.conname)).toEqual(["administrator_totp_factor_administrator_fkey"]);

    const { rows: checks } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'administrator_totp_factor_origin_check'`,
    );
    expect(checks).toHaveLength(1);
  });

  it("refuses an origin on an active or reenrolment_required factor, naming the origin CHECK", async () => {
    const origin = randomUUID();

    expect(await insertFactorWithOrigin(await insertAdministrator(), "active", origin)).toBe(
      "administrator_totp_factor_origin_check",
    );
    // Material null, so only the origin CHECK can fire for this state.
    expect(await insertFactorWithOrigin(await insertAdministrator(), "reenrolment_required", origin)).toBe(
      "administrator_totp_factor_origin_check",
    );
    expect(await codeOf(
      `insert into administrator_totp_factor
         (administrator_id, state, factor_id, secret_ciphertext, secret_iv, secret_tag, key_version, last_accepted_step,
          origin_recovery_session_id)
       values ($1, 'active', $2, $3, $4, $5, 1, 1, $6)`,
      [await insertAdministrator(), randomUUID(), randomBytes(20), randomBytes(12), randomBytes(16), origin],
    )).toBe(CHECK_VIOLATION);
  });

  it("accepts an origin on a pending factor, and a NULL origin in every state", async () => {
    expect(await insertFactorWithOrigin(await insertAdministrator(), "pending_confirmation", randomUUID())).toBeNull();

    for (const state of ["active", "pending_confirmation", "reenrolment_required"]) {
      expect(await insertFactorWithOrigin(await insertAdministrator(), state, null)).toBeNull();
    }
  });

  it("refuses activating a pending factor while its origin is still set, and allows it once cleared", async () => {
    const id = await insertAdministrator();
    expect(await insertFactorWithOrigin(id, "pending_confirmation", randomUUID())).toBeNull();

    expect(
      await constraintOf(
        "update administrator_totp_factor set state = 'active', last_accepted_step = 1 where administrator_id = $1",
        [id],
      ),
    ).toBe("administrator_totp_factor_origin_check");
    expect(
      await constraintOf(
        `update administrator_totp_factor set state = 'active', last_accepted_step = 1, origin_recovery_session_id = null
          where administrator_id = $1`,
        [id],
      ),
    ).toBeNull();
  });
});

describe("reversal", () => {
  it(
    "removes the CHECK, the column and the table, leaves 003's schema exactly, and reapplies cleanly",
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
      const factorColumns = async () =>
        (
          await reversal.query<{ column_name: string }>(
            `select column_name from information_schema.columns
              where table_schema = 'public' and table_name = 'administrator_totp_factor' order by ordinal_position`,
          )
        ).rows.map((row) => row.column_name);
      const originCheck = async () =>
        (
          await reversal.query<{ n: number }>(
            "select count(*)::int as n from pg_constraint where conname = 'administrator_totp_factor_origin_check'",
          )
        ).rows[0]?.n;
      const applied = async () =>
        (await reversal.query<{ name: string }>("select name from kysely_migration order by name")).rows.map(
          (row) => row.name,
        );

      try {
        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);
        expect(await applied()).toEqual(MIGRATIONS);
        expect(await originCheck()).toBe(1);

        expect(await runMigration("down", dependencies)).toBe(SUCCESS);
        expect(await applied()).toEqual(MIGRATIONS.slice(0, 3));
        expect(await tables()).toEqual(TABLES_AFTER_003);
        expect(await factorColumns()).toEqual(FACTOR_COLUMNS_AFTER_003);
        expect(await originCheck()).toBe(0);
        expect(await extensionsOf(reversal)).toEqual(["plpgsql"]);

        expect(await runMigration("latest", dependencies)).toBe(SUCCESS);
        expect(await applied()).toEqual(MIGRATIONS);
        expect(await tables()).toEqual([...TABLES_AFTER_003, "administrator_recovery_code"].sort());
        expect(await factorColumns()).toEqual([...FACTOR_COLUMNS_AFTER_003, "origin_recovery_session_id"]);
        expect(await originCheck()).toBe(1);
        expect(await extensionsOf(reversal)).toEqual(["plpgsql"]);
      } finally {
        await reversal.end();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});
