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
 * development dependency, so there is nothing to probe and nothing to skip.
 *
 * Isolation and cleanup are owned by `testing/embedded-cluster.ts` (issue #179): one isolated
 * cluster for this file on an **ephemeral port** with a **disposable data directory**, torn down
 * on every path — success, assertion failure and setup failure alike. The helper closes this
 * file's clients first, requests shutdown once, **waits for the owned postmaster to exit**, and
 * only then removes the directory, under a bounded retry for Windows' transient file-handle
 * release. Cleanup is verified, and a cleanup that cannot prove the cluster is gone fails this
 * file rather than leaving one behind.
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
import { beforeAll, describe, expect, it } from "vitest";
import { type PostgresPool } from "kysely";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "./testing/embedded-cluster";
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

const DATABASE = "parser_verification";

/**
 * One isolated cluster for this file, owned by the shared helper (issue #179), with the governed
 * migration already applied — these tests read the real migration's columns rather than an
 * ad-hoc table, and the helper applies it through the same real provider and `Migrator` this
 * file used to drive itself.
 *
 * The helper also waits for the owned postmaster to exit before removing anything, which is what
 * this file's own teardown never did.
 */
const cluster = useEmbeddedPostgres({
  slug: "parser",
  databases: [DATABASE],
  migrate: [DATABASE],
});

/** 2026-01-01T21:34:05.123Z — one instant, used throughout. */
const REFERENCE_MILLISECONDS = 1_767_303_245_123;

/** A client carrying the governed override: every timestamptz arrives as a number. */
let parsing: PgClient;
/** A client with pg's defaults, proving the override did not leak globally. */
let defaulting: PgClient;

function connectionString(): string {
  return cluster.connectionStringFor(DATABASE);
}

/**
 * Run `body` with one session setting changed, restoring whatever was actually in force.
 *
 * Both clients below are file-level and shared by every test, so a setting left behind is a
 * setting every later test inherits. The **captured** value is restored rather than an assumed
 * one, the restoration happens in `finally`, and if the body and the restoration both fail both
 * are kept — the body's failure first, because that is the one worth reading.
 */
async function withSessionSetting(
  client: PgClient,
  setting: "timezone" | "datestyle",
  value: string,
  body: () => Promise<void>,
): Promise<void> {
  const { rows } = await client.query<{ value: string }>(
    `select current_setting('${setting}') as value`,
  );
  const original = rows[0]?.value;

  if (original === undefined) {
    throw new Error(`the session ${setting} could not be read, so it cannot be restored`);
  }

  await client.query(`set ${setting} to '${value}'`);

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
      await client.query(`set ${setting} to '${original}'`);
    } catch (restoreError) {
      if (!threw) {
        throw restoreError;
      }

      throw new AggregateError(
        [bodyError, restoreError],
        `the assertion failed and restoring the session ${setting} also failed; the first ` +
          "error is the original failure",
      );
    }
  }
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
  parsing = new Client({
    connectionString: connectionString(),
    types: createTimestamptzTypeOverrides(),
  });
  defaulting = new Client({ connectionString: connectionString() });

  await parsing.connect();
  await defaulting.connect();

  // Registered rather than closed by a local `afterAll`: the helper closes every registered
  // resource before it asks the server to stop.
  cluster.closeBeforeShutdown("parsing client", () => parsing.end());
  cluster.closeBeforeShutdown("defaulting client", () => defaulting.end());
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

    for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      await withSessionSetting(parsing, "timezone", zone, async () => {
        const { rows } = await parsing.query(
          "select submitted_at from listing where id = $1",
          [listingId],
        );

        readings.push(rows[0]?.submitted_at);
      });
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

    for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
      await withSessionSetting(parsing, "timezone", zone, async () => {
        const { rows } = await parsing.query(
          "select to_timestamp($1::bigint / 1000.0)::timestamptz(3)::text as rendered",
          [String(REFERENCE_MILLISECONDS)],
        );

        renderings.add(String(rows[0]?.rendered));
      });
    }

    // Three different strings, one instant — which is why the offset must be honoured.
    expect(renderings.size).toBe(3);
  });
});

describe("incompatible DateStyle fails loudly", () => {
  it("refuses the SQL,MDY rendering rather than misparsing it", async () => {
    await withSessionSetting(parsing, "datestyle", "SQL, MDY", async () => {
      await expect(parsing.query("select now()::timestamptz(3) as moment")).rejects.toThrow(
        TimestamptzParseError,
      );
    });

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
