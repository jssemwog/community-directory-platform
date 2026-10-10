/**
 * Live-driver tests for the `timestamptz` boundary parser (issue #173).
 *
 * The unit tests in `timestamp-parser.test.ts` prove the grammar and the arithmetic against
 * strings. **These prove the contract through real `pg` against a real PostgreSQL server,
 * reading the real migration's own columns** — because a parser that is correct about
 * strings someone wrote down is not yet known to be correct about the strings the driver
 * actually delivers.
 *
 * They are **unconditional**: the server binaries ship with the `embedded-postgres`
 * development dependency, so there is nothing to probe and nothing to skip. One server per
 * file on an **ephemeral port** with a **disposable data directory**, torn down on success,
 * assertion failure and setup failure alike, with the removal **asserted**.
 *
 * **The server version is a test-harness detail with no production authority.** No
 * PostgreSQL version is selected (`ADR-013` names only the provider), and nothing here
 * asserts version-specific behaviour.
 *
 * **Nothing here constructs production persistence.** The clients below exist to exercise
 * the driver path; no pool, repository, credential or connection configuration is created
 * for the application, and `DateStyle = ISO` remains a recorded `C9` obligation rather than
 * something this unit sets.
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

import { createMigrationProvider } from "./migrate";
import {
  createTimestamptzTypeOverrides,
  TIMESTAMPTZ_OID,
  TimestamptzParseError,
} from "./timestamp-parser";

type Row = Readonly<Record<string, unknown>>;

/**
 * The slice of `pg` this file uses. `pg` ships no declarations and `@types/pg` is
 * deliberately absent (`ADR-017`), so it is reached through `createRequire` and described
 * here — the pattern `migrate.ts` established.
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

const SERVER_USER = "postgres";
const SERVER_PASSWORD = "verification-only";
const DATABASE = "parser_verification";
const CLUSTER_TIMEOUT_MS = 300_000;

/** 2026-01-01T21:34:05.123Z — one instant, used throughout. */
const REFERENCE_MILLISECONDS = 1_767_303_245_123;

let server: EmbeddedPostgres;
let serverPort: number;
let dataRoot: string;
/** A client carrying the governed override: every timestamptz arrives as a number. */
let parsing: PgClient;
/** A client with pg's defaults, proving the override did not leak globally. */
let defaulting: PgClient;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function removeWithRetry(directory: string): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Retried; the final `existsSync` is the verdict.
    }

    if (!existsSync(directory)) {
      return true;
    }

    await sleep(200);
  }

  return !existsSync(directory);
}

function connectionString(): string {
  return `postgresql://${SERVER_USER}:${SERVER_PASSWORD}@127.0.0.1:${serverPort}/${DATABASE}`;
}

/** Insert one listing whose four governed instants are all the reference instant. */
async function insertListingAt(epochMilliseconds: number): Promise<string> {
  const id = randomUUID();
  // The instant is handed to PostgreSQL as an offset-explicit literal computed in SQL from
  // epoch milliseconds, so the write path depends on no client-side date formatting.
  await parsing.query(
    `insert into listing (
       id, status, name, category, description, locality, country,
       submitted_at, last_updated_at, rejected_at
     ) values (
       $1, 'rejected', 'A Business', 'food-drink', 'A description.', 'A Locality', 'A Country',
       to_timestamp($2::bigint / 1000.0), to_timestamp($2::bigint / 1000.0),
       to_timestamp($2::bigint / 1000.0)
     )`,
    [id, String(epochMilliseconds)],
  );

  return id;
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "cdp-parser-"));
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
  await server.createDatabase(DATABASE);

  // The governed schema, applied through the governed runner — these tests read the real
  // migration's columns rather than an ad-hoc table.
  const pool = new Pool({ connectionString: connectionString(), max: 1 });
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

  try {
    const migrated = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();

    expect(migrated.error, "the governed migration must apply").toBeUndefined();
  } finally {
    await db.destroy();
  }

  parsing = new Client({
    connectionString: connectionString(),
    types: createTimestamptzTypeOverrides(),
  });
  defaulting = new Client({ connectionString: connectionString() });

  await parsing.connect();
  await defaulting.connect();
}, CLUSTER_TIMEOUT_MS);

afterAll(async () => {
  for (const client of [parsing, defaulting]) {
    try {
      await client?.end();
    } catch {
      // The server is going away regardless.
    }
  }

  try {
    await server?.stop();
  } catch {
    // Fall through to removal, which is the guarantee that matters.
  }

  const removed = await removeWithRetry(dataRoot);
  expect(removed, `the disposable cluster at ${dataRoot} was not removed`).toBe(true);
}, CLUSTER_TIMEOUT_MS);

describe("the override on a live connection", () => {
  it("delivers a safe-integer number, never a Date", async () => {
    const { rows } = await parsing.query("select now()::timestamptz(3) as moment");
    const moment = rows[0]?.moment;

    expect(typeof moment).toBe("number");
    expect(moment).not.toBeInstanceOf(Date);
    expect(Number.isSafeInteger(moment)).toBe(true);
  });

  it("leaves a client without the override on pg's default Date, proving no global mutation", async () => {
    const { rows } = await defaulting.query("select now()::timestamptz(3) as moment");

    expect(rows[0]?.moment).toBeInstanceOf(Date);
  });

  it("parses a known instant to the exact epoch millisecond", async () => {
    const { rows } = await parsing.query(
      "select to_timestamp($1::bigint / 1000.0)::timestamptz(3) as moment",
      [String(REFERENCE_MILLISECONDS)],
    );

    expect(rows[0]?.moment).toBe(REFERENCE_MILLISECONDS);
  });

  it("overrides only timestamptz, leaving timestamp without time zone to pg", async () => {
    const { rows } = await parsing.query(
      "select (timestamp '2026-01-02 03:04:05.123') as naive",
    );

    // OID 1114 is deliberately untouched, so pg's default still produces a Date.
    expect(rows[0]?.naive).toBeInstanceOf(Date);
    expect(TIMESTAMPTZ_OID).toBe(1184);
  });
});

describe("the four governed columns", () => {
  it("delivers every one of them as an exact epoch millisecond", async () => {
    const listingId = await insertListingAt(REFERENCE_MILLISECONDS);

    const revisionId = randomUUID();
    await parsing.query(
      `insert into listing_revision (
         id, listing_id, state, name, category, description, locality, country, rejected_at
       ) values ($1, $2, 'rejected', 'A Business', 'food-drink', 'A description.',
                 'A Locality', 'A Country', to_timestamp($3::bigint / 1000.0))`,
      [revisionId, listingId, String(REFERENCE_MILLISECONDS)],
    );

    const { rows: listingRows } = await parsing.query(
      "select submitted_at, last_updated_at, rejected_at from listing where id = $1",
      [listingId],
    );
    const { rows: revisionRows } = await parsing.query(
      "select rejected_at from listing_revision where id = $1",
      [revisionId],
    );

    const governed = [
      listingRows[0]?.submitted_at,
      listingRows[0]?.last_updated_at,
      listingRows[0]?.rejected_at,
      revisionRows[0]?.rejected_at,
    ];

    expect(governed).toHaveLength(4);

    for (const value of governed) {
      expect(typeof value).toBe("number");
      expect(value).toBe(REFERENCE_MILLISECONDS);
    }
  });

  it("returns null for an absent nullable instant, not an error", async () => {
    const id = randomUUID();
    await parsing.query(
      `insert into listing (
         id, status, name, category, description, locality, country,
         submitted_at, last_updated_at
       ) values ($1, 'pending', 'A Business', 'food-drink', 'A description.',
                 'A Locality', 'A Country',
                 to_timestamp($2::bigint / 1000.0), to_timestamp($2::bigint / 1000.0))`,
      [id, String(REFERENCE_MILLISECONDS)],
    );

    const { rows } = await parsing.query(
      "select rejected_at from listing where id = $1",
      [id],
    );

    expect(rows[0]?.rejected_at).toBeNull();
  });
});

describe("round trips through the real driver", () => {
  it("preserves the exact millisecond on write and read", async () => {
    const listingId = await insertListingAt(REFERENCE_MILLISECONDS);

    const { rows } = await parsing.query(
      "select submitted_at from listing where id = $1",
      [listingId],
    );

    expect(rows[0]?.submitted_at).toBe(REFERENCE_MILLISECONDS);
  });

  it.each([0, 1, 999, 123])("preserves a .%i millisecond remainder", async (remainder) => {
    const target = 1_767_303_245_000 + remainder;
    const listingId = await insertListingAt(target);

    const { rows } = await parsing.query(
      "select submitted_at from listing where id = $1",
      [listingId],
    );

    expect(rows[0]?.submitted_at).toBe(target);
  });

  it("preserves a pre-epoch instant", async () => {
    const target = -2_208_988_800_123;
    const listingId = await insertListingAt(target);

    const { rows } = await parsing.query(
      "select submitted_at from listing where id = $1",
      [listingId],
    );

    expect(rows[0]?.submitted_at).toBe(target);
  });
});

describe("session independence against the live server", () => {
  it("returns the same epoch millisecond under every session time zone", async () => {
    const listingId = await insertListingAt(REFERENCE_MILLISECONDS);
    const readings: unknown[] = [];

    try {
      for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        await parsing.query(`set time zone '${zone}'`);

        const { rows } = await parsing.query(
          "select submitted_at from listing where id = $1",
          [listingId],
        );

        readings.push(rows[0]?.submitted_at);
      }
    } finally {
      await parsing.query("set time zone 'UTC'");
    }

    expect(readings).toEqual([
      REFERENCE_MILLISECONDS,
      REFERENCE_MILLISECONDS,
      REFERENCE_MILLISECONDS,
      REFERENCE_MILLISECONDS,
    ]);
  });

  it("shows the rendered text differing while the instant does not", async () => {
    const renderings = new Set<string>();

    try {
      for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
        await parsing.query(`set time zone '${zone}'`);

        const { rows } = await parsing.query(
          "select to_timestamp($1::bigint / 1000.0)::timestamptz(3)::text as rendered",
          [String(REFERENCE_MILLISECONDS)],
        );

        renderings.add(String(rows[0]?.rendered));
      }
    } finally {
      await parsing.query("set time zone 'UTC'");
    }

    // Three different strings, one instant — which is why the offset must be honoured.
    expect(renderings.size).toBe(3);
  });
});

describe("incompatible DateStyle fails loudly", () => {
  it("refuses the SQL,MDY rendering rather than misparsing it", async () => {
    try {
      await parsing.query("set datestyle to 'SQL, MDY'");

      await expect(parsing.query("select now()::timestamptz(3) as moment")).rejects.toThrow(
        TimestamptzParseError,
      );
    } finally {
      await parsing.query("set datestyle to 'ISO, MDY'");
    }

    // And the connection is usable again once the governed DateStyle is restored, which is
    // why pinning `DateStyle = ISO` is recorded as a `C9` connection obligation.
    const { rows } = await parsing.query("select now()::timestamptz(3) as moment");

    expect(typeof rows[0]?.moment).toBe("number");
  });
});

describe("values PostgreSQL can hold but this boundary refuses", () => {
  it("refuses infinity, rather than delivering an approximate instant", async () => {
    await expect(
      parsing.query("select (timestamptz 'infinity') as moment"),
    ).rejects.toThrow(TimestamptzParseError);
  });

  it("refuses -infinity", async () => {
    await expect(
      parsing.query("select (timestamptz '-infinity') as moment"),
    ).rejects.toThrow(TimestamptzParseError);
  });

  it("refuses a BC-era instant, the disclosed narrowing", async () => {
    await expect(
      parsing.query("select (timestamptz '0044-03-15 12:00:00 BC') as moment"),
    ).rejects.toThrow(TimestamptzParseError);
  });

  it("refuses sub-millisecond precision rather than rounding it", async () => {
    // A bare timestamptz keeps microseconds; the governed columns are (3), which is why
    // this can only arrive from a value the migration did not define.
    await expect(
      parsing.query("select (timestamptz '2026-01-02 03:04:05.123456+00') as moment"),
    ).rejects.toThrow(TimestamptzParseError);
  });

  it("still accepts the governed columns after each refusal", async () => {
    const listingId = await insertListingAt(REFERENCE_MILLISECONDS);
    const { rows } = await parsing.query(
      "select submitted_at from listing where id = $1",
      [listingId],
    );

    expect(rows[0]?.submitted_at).toBe(REFERENCE_MILLISECONDS);
  });
});
