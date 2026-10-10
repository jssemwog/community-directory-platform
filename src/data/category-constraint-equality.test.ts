/**
 * `ADR-021` decision 10 — the governed category configuration and the migration's `CHECK`
 * constraints enforce **exactly the same set of keys** (issue #175).
 *
 * **Equality means both directions.** Proving that every configured key inserts successfully
 * is insufficient: a constraint could admit an extra unauthorized key that no configured value
 * would ever reveal. So the set the database actually enforces is read back from the
 * **PostgreSQL catalogue** — `pg_get_constraintdef()` returns the effective, server-normalised
 * definition — and compared as a **set** against the configuration. A missing key *and* an
 * extra key both fail.
 *
 * **There are exactly two executable sources of the vocabulary, and both are used here.** The
 * governed configuration is imported from the domain module; the constraint is read from the
 * live server. The migration's own private constant is **not** exported to make this
 * convenient — the migration is immutable (`ADR-018`) — and **no third expected-key list is
 * written in this file**. Nothing below restates a key.
 *
 * Catalogue inspection establishes exact set equality; the behavioural attacks that follow
 * confirm the constraint behaves as the catalogue says it does.
 *
 * Isolation and cleanup follow the pattern established by `first-schema-migration.test.ts`:
 * one server on an **ephemeral port** with a **disposable data directory**, torn down on every
 * path — success, assertion failure and setup failure alike — with removal asserted rather
 * than hoped for. The tests are **unconditional**: the binaries ship with the
 * `embedded-postgres` development dependency, so there is no environment to probe and nothing
 * to skip.
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

import { CATEGORIES, CATEGORY_KEYS } from "../domain/listing/category";
import {
  CONNECTION_STRING_VARIABLE,
  createMigrationProvider,
  SUCCESS,
  runMigration,
  type MigrationDependencies,
} from "./migrate";

type Row = Readonly<Record<string, unknown>>;

/**
 * The narrow slice of `pg` this file uses — reached through an explicit runtime require,
 * because `pg` ships no type declarations and `@types/pg` is deliberately absent
 * (`ADR-017`). Adding one is a dependency change this unit is not authorized to make.
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

const CHECK_VIOLATION = "23514";

/**
 * Revision rows are inserted as **rejected**, because only a *pending* revision is unique
 * per listing (`listing_revision_one_pending_per_listing`) and this file needs many rows
 * against one listing. `listing_revision_rejected_at_check` then requires a rejection
 * instant, so one is supplied: the category is the only thing under attack here.
 */
const REJECTED_AT = "2026-01-02T03:04:05.123+00:00";

/** The two constraints under test, each with the table that must own it. */
const CATEGORY_CONSTRAINTS = [
  { constraint: "listing_category_check", table: "listing" },
  { constraint: "listing_revision_category_check", table: "listing_revision" },
] as const;

const SERVER_USER = "postgres";
const SERVER_PASSWORD = "verification-only";
const VERIFIED_DATABASE = "category_equality_verification";

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
      probe.close((closeError) => (closeError ? reject(closeError) : resolve(port)));
    });
  });
}

/**
 * Remove the disposable directory, retrying briefly: Windows releases the cluster's file
 * handles a moment after the server exits. The verdict is returned and asserted by the
 * caller, because a cleanup that quietly failed would leave a cluster behind on every run.
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

/** The governed runner over the real provider, pointed at the disposable database. */
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
 * The key set the server **actually enforces**, read from the catalogue.
 *
 * `pg_get_constraintdef()` renders the predicate as
 * `CHECK ((category = ANY (ARRAY['arts-culture-entertainment'::text, …])))`. The approved keys
 * match `^[a-z]+(-[a-z]+)*$`, so none contains a quote and extraction of the single-quoted
 * literals is unambiguous. The parsing is **strict**: a definition that is missing, or that is
 * not the `= ANY (ARRAY[…])` membership predicate this proof assumes, throws rather than
 * yielding a set that would make the comparison vacuous.
 */
async function enforcedKeysOf(constraint: string, table: string): Promise<readonly string[]> {
  const { rows } = await client.query<{ definition: string; table_name: string }>(
    `select pg_get_constraintdef(c.oid) as definition, t.relname as table_name
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where c.conname = $1 and c.contype = 'c' and n.nspname = 'public'`,
    [constraint],
  );

  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one CHECK constraint named ${constraint}, found ${rows.length}`,
    );
  }

  const row = rows[0] as { definition: string; table_name: string };

  if (row.table_name !== table) {
    throw new Error(
      `${constraint} is owned by ${row.table_name}, not by the expected table ${table}`,
    );
  }

  if (!/category\s*=\s*ANY\s*\(\s*ARRAY\s*\[/i.test(row.definition)) {
    throw new Error(
      `${constraint} is not the expected category membership predicate: ${row.definition}`,
    );
  }

  const literals = [...row.definition.matchAll(/'([^']*)'/g)].map(
    (match) => match[1] as string,
  );

  if (literals.length === 0) {
    throw new Error(`${constraint} yielded no quoted literals: ${row.definition}`);
  }

  return literals;
}

const sorted = (keys: readonly string[]): readonly string[] => [...keys].sort();

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "cdp-category-"));
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

  client = new Client({ connectionString: connectionStringFor(VERIFIED_DATABASE) });
  await client.connect();

  // The real migration, through the real runner — the constraints under test must be the
  // ones the governed migration actually creates, not ones this file wrote.
  const status = await runMigration("latest", dependenciesFor(VERIFIED_DATABASE));
  expect(status).toBe(SUCCESS);
}, CLUSTER_TIMEOUT_MS);

afterAll(async () => {
  // Every step is attempted even if an earlier one throws: a half-released cluster is worse
  // than a noisy teardown.
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

describe("exact set equality, catalogue against configuration", () => {
  it.each(CATEGORY_CONSTRAINTS)(
    "$constraint enforces exactly the configured key set, on $table",
    async ({ constraint, table }) => {
      const enforced = await enforcedKeysOf(constraint, table);

      // Sizes first, so a duplicated literal fails here rather than hiding behind
      // set membership that would still look complete.
      expect(enforced).toHaveLength(CATEGORY_KEYS.length);
      expect(new Set(enforced).size).toBe(CATEGORY_KEYS.length);

      // And then the keys themselves, as sets: a **missing** key and an **extra** key both
      // fail this, which is what makes it equality rather than a subset check.
      expect(sorted(enforced)).toEqual(sorted([...CATEGORY_KEYS]));
    },
    CLUSTER_TIMEOUT_MS,
  );

  it("the two constraints enforce the same set as each other", async () => {
    const [listing, revision] = await Promise.all(
      CATEGORY_CONSTRAINTS.map(({ constraint, table }) => enforcedKeysOf(constraint, table)),
    );

    expect(sorted(listing as readonly string[])).toEqual(sorted(revision as readonly string[]));
  });

  it("fails on a missing, extra, duplicate or misspelled key", async () => {
    // The comparison itself is under attack here: a proof that cannot fail proves nothing.
    // Each mutation below is applied to the **enforced** set and must break the comparison.
    const enforced = await enforcedKeysOf("listing_category_check", "listing");
    const configured = sorted([...CATEGORY_KEYS]);

    const missing = enforced.slice(1);
    const extra = [...enforced, "artisanal-submarines"];
    // Right length, wrong contents: two keys dropped and one repeated twice, so only the
    // distinct-size assertion can catch it.
    const duplicate = [...enforced.slice(2), enforced[0] as string, enforced[0] as string];
    const misspelled = [
      ...enforced.slice(1),
      `${(enforced[0] as string).slice(0, -1)}x`,
    ];

    expect(sorted(missing)).not.toEqual(configured);
    expect(sorted(extra)).not.toEqual(configured);
    expect(sorted(misspelled)).not.toEqual(configured);

    // A duplicate has the right length and the right membership, so only the distinct-size
    // assertion catches it. That is why the test above asserts both.
    expect(duplicate).toHaveLength(configured.length);
    expect(new Set(duplicate).size).not.toBe(configured.length);
  });
});

describe("the catalogue and the running server agree (forward behavioural proof)", () => {
  it(
    "accepts every configured key in a listing row",
    async () => {
      for (const category of CATEGORY_KEYS) {
        expect(await insertListing({ category }), category).toBeNull();
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "accepts every configured key in a revision's proposed content",
    async () => {
      const listingId = await insertApprovedListing();

      for (const category of CATEGORY_KEYS) {
        expect(await insertRevision(listingId, { category, state: "rejected", rejected_at: REJECTED_AT }), category).toBe(
          null,
        );
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("representative unapproved values are refused by both tables", () => {
  /**
   * Rejected vocabulary, fixture-only strings, a label, a case variant and padded and
   * malformed keys. These are **attacking inputs**, not an expected-key list: not one of them
   * is an approved key, and the approved keys are never restated in this file.
   */
  const refused = [
    "other",
    "miscellaneous",
    "uncategorized",
    "health-wellness",
    "food-and-drink",
    "retail",
    "FOOD-DRINK",
    " food-drink",
    "food-drink ",
    "food_drink",
    "",
  ] as const;

  it(
    "refuses each of them in listing and in listing_revision",
    async () => {
      const listingId = await insertApprovedListing();

      for (const category of refused) {
        expect(await insertListing({ category }), `listing: ${category}`).toBe(CHECK_VIOLATION);
        expect(
          await insertRevision(listingId, { category, state: "rejected", rejected_at: REJECTED_AT }),
          `listing_revision: ${category}`,
        ).toBe(CHECK_VIOLATION);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "refuses every approved label — the stored identity is the key, never the label",
    async () => {
      const listingId = await insertApprovedListing();

      for (const { label } of CATEGORIES) {
        expect(await insertListing({ category: label }), label).toBe(CHECK_VIOLATION);
        expect(
          await insertRevision(listingId, { category: label, state: "rejected", rejected_at: REJECTED_AT }),
          label,
        ).toBe(CHECK_VIOLATION);
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

/** Insert a listing, returning the PostgreSQL error code or `null` on success. */
async function insertListing(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string | null> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    status: "pending",
    name: "A Business",
    category: CATEGORY_KEYS[0],
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
    category: CATEGORY_KEYS[0],
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
