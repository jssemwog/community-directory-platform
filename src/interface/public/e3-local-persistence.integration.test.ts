/**
 * `E3-local` against a real, disposable embedded PostgreSQL cluster (issue #246, Scope Gate
 * revision 4 §6.3; revision 3 §4.2).
 *
 * - **E-I1/E-I6:** the least-privilege role passes C-1 to C-4 and reads `OP-2`, with only the
 *   granted privileges.
 * - **E-I2:** a wrong identifier, database, marker or role (a superuser included) is refused, and
 *   no listing query is sent.
 * - **E-I4/E-I5:** the role's **effective** privileges, inherited through `PUBLIC` included, and
 *   the refusal of every write.
 * - **FI-8 (pre-stream) and FI-9 (post-commit):** separate tests. The superuser changes the marker
 *   and terminates the app's session; FI-8 then calls the layout's pre-check, FI-9 the page's read
 *   after the pre-check has already passed.
 *
 * **These are simulated streaming cases, not wire-status checks.** The live `next start` status of
 * each request is verified only by the separately authorized `e3-check` acceptance run.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { randomBytes, randomUUID } from "node:crypto";

import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../data/testing/embedded-cluster";
import { createListingPersistence, type ListingPersistence } from "../../data/connection";
import { instantOf, type Instant } from "../../domain/listing/instant";
import type { Listing, ListingContent } from "../../domain/listing/listing";
import { listingIdOf } from "../../domain/listing/listing-id";
import { persistListingApproval } from "../../data/listing-approval";
import { insertSubmittedListing } from "../../data/listing-repository";
import { findPubliclyAvailableListing } from "../../data/public-listing-read";
import type { ListingDatabase } from "../../data/listing-table";
import {
  BI4_E3_DATABASE_URL,
  BI4_E3_EXPECTED_DATABASE,
  BI4_E3_EXPECTED_SYSTEM_IDENTIFIER,
  BI4_E3_LOCAL,
  BI4_E3_SYNTHETIC_MARKER,
  createE3Local,
  e3LocalConfigurationOf,
  e3LocalRoleSetupStatements,
  isRefused,
  REFUSED,
  type E3Local,
  type E3LocalConfiguration,
} from "./e3-local-persistence";

const DATABASE = "bi4_e3_verification";
const ROLE = "bi4_e3_app";
const PASSWORD = randomBytes(16).toString("hex");
const MARKER = `bi4-e3-synthetic:${randomBytes(16).toString("hex")}`;
const TEST_TIMEOUT_MS = 30_000;

const cluster = useEmbeddedPostgres({ slug: "e3-local", databases: [DATABASE], migrate: [DATABASE] });

const T0 = 1_767_323_045_123;

const CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: "+353 21 999 0000", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: "https://private.example.ie" },
};

let superuser: ListingPersistence;
let systemIdentifier: string;
let port: number;
let publicKey: string;
let pendingKey: string;
const handles: E3Local[] = [];

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) throw new Error("fixture instant is invalid");
  return result.value;
}

function appUrl(role = ROLE, password = PASSWORD): string {
  return `postgresql://${role}:${password}@127.0.0.1:${port}/${DATABASE}`;
}

function verifiedConfiguration(): E3LocalConfiguration {
  const configured = e3LocalConfigurationOf({
    NODE_ENV: "production",
    [BI4_E3_LOCAL]: "1",
    [BI4_E3_DATABASE_URL]: appUrl(),
    [BI4_E3_EXPECTED_SYSTEM_IDENTIFIER]: systemIdentifier,
    [BI4_E3_EXPECTED_DATABASE]: DATABASE,
    [BI4_E3_SYNTHETIC_MARKER]: MARKER,
  });
  if (configured === undefined) throw new Error("the verified configuration must be accepted");
  return configured;
}

/**
 * `OP-2` reads the handle actually issued, counted at the app layer on the reserved client: the
 * deterministic evidence that no listing query ran. A malformed identity is counted too, though
 * `findPubliclyAvailableListing` refuses it before any SQL.
 */
interface Counted {
  readonly handle: E3Local;
  readonly opTwoReads: () => number;
}

function handleFor(configuration: E3LocalConfiguration): Counted {
  let calls = 0;
  const handle = createE3Local(configuration, {
    find: (db, identity) => {
      calls += 1;
      return findPubliclyAvailableListing(db, identity);
    },
  });
  handles.push(handle);
  return { handle, opTwoReads: () => calls };
}

async function setMarker(marker: string): Promise<void> {
  await sql.raw(`comment on database "${DATABASE}" is '${marker}'`).execute(superuser.db);
}

async function appSessions(): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity where usename = ${ROLE}`.execute(superuser.db);
  return Number((rows[0] as { n: string }).n);
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resume) => setTimeout(resume, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Terminate the app role's sessions and wait until the server shows none. */
async function terminateAppSessions(): Promise<void> {
  await sql`select pg_terminate_backend(pid) from pg_stat_activity where usename = ${ROLE}`.execute(superuser.db);
  await waitFor(async () => (await appSessions()) === 0, "the app sessions to end");
  // Let the client side process the termination, as the live launcher does.
  await new Promise((resume) => setTimeout(resume, 500));
}

/** Scans of `listing` (sequential plus index), as the server's cumulative statistics count them. */
async function listingScans(): Promise<number> {
  return superuser.db.connection().execute(async (db) => {
    await sql`select pg_stat_clear_snapshot()`.execute(db);
    const { rows } = await sql<{ scans: string }>`select (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text as scans from pg_stat_user_tables where relname = 'listing'`.execute(db);
    return Number((rows[0] as { scans: string }).scans);
  });
}

/**
 * The scan count once it has held for a full second. An exiting backend flushes its counters as it
 * shuts down, which can land after its session has left `pg_stat_activity`, so a single equal pair
 * of reads is not enough under load. This is corroboration; the app-layer count is the evidence.
 */
async function settledListingScans(): Promise<number> {
  let previous = await listingScans();
  let stableReads = 0;
  for (let i = 0; i < 60 && stableReads < 4; i += 1) {
    await new Promise((resume) => setTimeout(resume, 250));
    const current = await listingScans();
    stableReads = current === previous ? stableReads + 1 : 0;
    previous = current;
  }
  return previous;
}

async function submit(key: string): Promise<Listing> {
  const listing: Listing = { id: listingIdOf(key), status: "pending", content: CONTENT, timestamps: { submittedAt: instant(T0), lastUpdatedAt: instant(T0) } };
  expect((await insertSubmittedListing(superuser.db, listing)).ok).toBe(true);
  return listing;
}

beforeAll(async () => {
  superuser = createListingPersistence({ pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 1 } });
  cluster.closeBeforeShutdown("superuser persistence", () => superuser.shutdown());
  cluster.closeBeforeShutdown("E3-local handles", () => Promise.all(handles.map((handle) => handle.shutdown())));
  port = cluster.port;

  for (const statement of e3LocalRoleSetupStatements({ database: DATABASE, role: ROLE, password: PASSWORD })) {
    await sql.raw(statement).execute(superuser.db);
  }
  await setMarker(MARKER);
  const { rows } = await sql<{ id: string }>`select system_identifier::text as id from pg_control_system()`.execute(superuser.db);
  systemIdentifier = (rows[0] as { id: string }).id;

  publicKey = randomUUID();
  pendingKey = randomUUID();
  const listing = await submit(publicKey);
  const approved = await persistListingApproval(superuser.db, { listingId: listing.id, viewedLastUpdatedAt: instant(T0), approvedAt: instant(T0 + 1_000) });
  expect(approved.ok).toBe(true);
  await submit(pendingKey);
}, CLUSTER_TIMEOUT_MS);

afterEach(async () => {
  while (handles.length > 0) await (handles.pop() as E3Local).shutdown();
  await setMarker(MARKER);
  await waitFor(async () => (await appSessions()) === 0, "the app sessions to close");
});

/** A plain pool as the app role, with no E3-local verification, for privilege enumeration. */
async function asAppRole<T>(work: (db: Kysely<ListingDatabase>) => Promise<T>): Promise<T> {
  const app = createListingPersistence({ pool: { connectionString: appUrl(), max: 1 } });
  try {
    return await work(app.db);
  } finally {
    await app.shutdown();
  }
}

describe("E-I1/E-I6: the least-privilege role verifies and reads OP-2", () => {
  it("passes C-1 to C-4 and reads public, never-existed and pending identities", async () => {
    const { handle, opTwoReads } = handleFor(verifiedConfiguration());

    expect(await handle.precheck()).toBe("ok");

    const present = await handle.read(publicKey);
    expect(isRefused(present)).toBe(false);
    expect(present).toMatchObject({ ok: true, value: { id: publicKey, listing: { name: "Harbour Bakery" } } });

    expect(await handle.read(randomUUID())).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(await handle.read(pendingKey)).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(await handle.read("not-a-uuid")).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(handle.isRefused()).toBe(false);
    expect(opTwoReads()).toBe(4);
  }, TEST_TIMEOUT_MS);
});

describe("E-I2: a wrong identity is refused before any listing query", () => {
  const cases: readonly [string, () => E3LocalConfiguration][] = [
    ["a wrong system identifier", () => ({ ...verifiedConfiguration(), expected: { ...verifiedConfiguration().expected, systemIdentifier: systemIdentifier === "1" ? "2" : "1" } })],
    ["a wrong database", () => ({ ...verifiedConfiguration(), expected: { ...verifiedConfiguration().expected, database: "postgres" } })],
    ["a wrong marker", () => ({ ...verifiedConfiguration(), expected: { ...verifiedConfiguration().expected, marker: `bi4-e3-synthetic:${"f".repeat(32)}` } })],
    ["a wrong role", () => ({ ...verifiedConfiguration(), expected: { ...verifiedConfiguration().expected, role: "postgres" } })],
    [
      "a superuser connection",
      () => ({ connectionString: cluster.connectionStringFor(DATABASE), expected: { ...verifiedConfiguration().expected, role: "postgres" } }),
    ],
  ];

  for (const [label, configure] of cases) {
    it(`refuses ${label}, with no scan of listing`, async () => {
      const before = await settledListingScans();
      const { handle, opTwoReads } = handleFor(configure());

      expect(await handle.precheck()).toBe("refused");
      expect(await handle.read(publicKey)).toBe(REFUSED);
      expect(await handle.precheck()).toBe("refused");

      expect(opTwoReads()).toBe(0);
      expect(await settledListingScans()).toBe(before);
    }, TEST_TIMEOUT_MS);
  }
});

describe("E-I4: the role's effective privileges, PUBLIC included", () => {
  it("holds exactly CONNECT, USAGE on public, SELECT on listing and EXECUTE on pg_control_system()", async () => {
    const report = await asAppRole(async (db) => {
      const database = await sql<{ connect: boolean; create: boolean; temporary: boolean }>`select has_database_privilege(current_database(), 'CONNECT') as connect, has_database_privilege(current_database(), 'CREATE') as create, has_database_privilege(current_database(), 'TEMPORARY') as temporary`.execute(db);
      const schema = await sql<{ usage: boolean; create: boolean }>`select has_schema_privilege('public', 'USAGE') as usage, has_schema_privilege('public', 'CREATE') as create`.execute(db);
      const tables = await sql<{ table: string; privilege: string; held: boolean }>`
        select t.tablename as table, p.privilege, has_table_privilege(format('public.%I', t.tablename), p.privilege) as held
        from pg_tables t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(privilege)
        where t.schemaname = 'public' order by 1, 2`.execute(db);
      const sequences = await sql<{ sequence: string; usage: boolean; update: boolean; select: boolean }>`
        select c.relname as sequence, has_sequence_privilege(c.oid, 'USAGE') as usage, has_sequence_privilege(c.oid, 'UPDATE') as update, has_sequence_privilege(c.oid, 'SELECT') as select
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname = 'public'`.execute(db);
      const control = await sql<{ execute: boolean }>`select has_function_privilege('pg_control_system()', 'EXECUTE') as execute`.execute(db);
      const attributes = await sql<Record<string, boolean>>`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit from pg_roles where rolname = current_user`.execute(db);
      const memberships = await sql<{ n: string }>`select count(*)::text as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = current_user`.execute(db);
      return { database: database.rows[0], schema: schema.rows[0], tables: tables.rows, sequences: sequences.rows, control: control.rows[0], attributes: attributes.rows[0], memberships: memberships.rows[0] };
    });

    expect(report.database).toEqual({ connect: true, create: false, temporary: false });
    expect(report.schema).toEqual({ usage: true, create: false });
    expect(report.tables.length).toBeGreaterThan(7);
    expect(new Set(report.tables.map((row) => row.table))).toContain("listing_revision");
    for (const row of report.tables) {
      expect(row.held, `${row.privilege} on ${row.table}`).toBe(row.table === "listing" && row.privilege === "SELECT");
    }
    for (const row of report.sequences) expect(row, row.sequence).toMatchObject({ usage: false, update: false, select: false });
    expect(report.control).toEqual({ execute: true });
    expect(report.attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false });
    expect(report.memberships).toEqual({ n: "0" });
  }, TEST_TIMEOUT_MS);

  it("cannot read data_directory, which the launcher checks instead", async () => {
    await expect(asAppRole((db) => sql`show data_directory`.execute(db))).rejects.toThrow(/permission denied|must be superuser|pg_read_all_settings/i);
  }, TEST_TIMEOUT_MS);
});

describe("E-I5: every write fails as the app role", () => {
  const writes: readonly [string, string][] = [
    ["insert into listing", "insert into listing (id) values (gen_random_uuid())"],
    ["update listing", "update listing set name = 'x'"],
    ["delete from listing", "delete from listing"],
    ["truncate listing", "truncate listing"],
    ["create a table", "create table public.e3_probe (id int)"],
    ["create a temporary table", "create temporary table e3_probe (id int)"],
    ["read the revision table", "select * from listing_revision"],
    ["comment on the database", `comment on database "${DATABASE}" is 'x'`],
  ];

  for (const [label, statement] of writes) {
    it(`refuses: ${label}`, async () => {
      await expect(asAppRole((db) => sql.raw(statement).execute(db))).rejects.toThrow(/permission denied|must be owner/i);
    }, TEST_TIMEOUT_MS);
  }
});

describe("FI-8: pre-stream — the layout's checkout opens a replacement that fails verification", () => {
  it("refuses the triggering pre-check and every later one, with no new app session", async () => {
    const { handle, opTwoReads } = handleFor(verifiedConfiguration());
    expect(await handle.precheck()).toBe("ok");
    expect(isRefused(await handle.read(publicKey))).toBe(false);

    await setMarker(`bi4-e3-synthetic:${"e".repeat(32)}`);
    await terminateAppSessions();
    const readsBefore = opTwoReads();

    // The triggering request: the layout's pre-check, which runs before any response is started.
    expect(await handle.precheck()).toBe("refused");
    await waitFor(async () => (await appSessions()) === 0, "the rejected session to close");

    // Later direct requests: refused without a checkout, so no session is opened.
    expect(await handle.precheck()).toBe("refused");
    expect(await handle.read(publicKey)).toBe(REFUSED);
    expect(await appSessions()).toBe(0);
    expect(opTwoReads()).toBe(readsBefore);
  }, TEST_TIMEOUT_MS);
});

describe("FI-9: post-commit residual — the page's replacement fails verification after the layout passed", () => {
  it("returns the generic outcome, runs no listing query on the rejected client, and refuses later requests", async () => {
    const { handle, opTwoReads } = handleFor(verifiedConfiguration());
    expect(await handle.precheck()).toBe("ok");
    expect(isRefused(await handle.read(publicKey))).toBe(false);
    expect(await handle.precheck()).toBe("ok");

    await setMarker(`bi4-e3-synthetic:${"d".repeat(32)}`);
    await terminateAppSessions();
    const before = await settledListingScans();
    const readsBefore = opTwoReads();

    // The page's read, after the layout's pre-check passed for this request.
    expect(await handle.read(publicKey)).toBe(REFUSED);
    await waitFor(async () => (await appSessions()) === 0, "the rejected session to close");

    expect(opTwoReads()).toBe(readsBefore);
    expect(await settledListingScans()).toBe(before);
    expect(await handle.precheck()).toBe("refused");
    expect(await appSessions()).toBe(0);
  }, TEST_TIMEOUT_MS);
});
