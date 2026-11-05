/**
 * The housekeeping command against a real disposable cluster (Unit HK Scope Gate, revision 4,
 * issue #274, §6.3 C-1, C-3, C-4 and C-5). The cluster is the test harness's own, migrated as the
 * launcher's startup would migrate it; nothing here reads or writes `.local-demo/`.
 */

import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAdministrator } from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { startupOptionsFor } from "../../src/data/connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../src/data/testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "../../src/data/timestamp-parser";
import { generateToken } from "../../src/domain/administrator-auth/token";
import type { ProvisioningTerminal } from "./administrator-provisioning";
import { HOUSEKEEPING_INCOMPLETE_MESSAGE, HOUSEKEEPING_NOTICE, runHousekeeping } from "./administrator-housekeeping";

interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<PgResult>;
  release(destroy?: boolean | Error): void;
}

interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: readonly unknown[]): Promise<PgResult>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as { Pool: new (config: Record<string, unknown>) => PgPool };

const DATABASE = "admin_housekeeping_command";
const cluster = useEmbeddedPostgres({ slug: "admin-housekeeping-command", databases: [DATABASE], migrate: [DATABASE] });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AT = Date.UTC(2026, 10, 5, 12, 0, 0);

/** Every statement the command sent through this connection: its `adr028:` label, or `sql`. */
const sent: string[] = [];
/** A labelled statement that executes, then throws as if its acknowledgement were lost. */
let lostAcknowledgement: string | undefined;
let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;
let databaseUrl: string;

beforeAll(() => {
  databaseUrl = cluster.connectionStringFor(DATABASE);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, types: createTimestamptzTypeOverrides(), options: startupOptionsFor({ application_name: "hk_command" }) });
  pool.on("error", () => undefined);
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          const label = text.startsWith("/* adr028:") ? text.slice(10, text.indexOf(" */")) : undefined;
          sent.push(label ?? "sql");
          const result = await client.query(text, values);
          if (label !== undefined && label === lostAcknowledgement) {
            lostAcknowledgement = undefined;
            throw new Error("acknowledgement lost (injected after the statement executed)");
          }
          return result;
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    end: () => pool.end(),
  };
  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
  observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  observer.on("error", () => undefined);
  cluster.closeBeforeShutdown("housekeeping command", () => db.destroy());
  cluster.closeBeforeShutdown("housekeeping command observer", () => observer.end());
}, CLUSTER_TIMEOUT_MS);

beforeEach(async () => {
  sent.length = 0;
  lostAcknowledgement = undefined;
  for (const table of ["administrator_session", "administrator_pending_challenge", "administrator_consumed_challenge"]) {
    await observer.query(`delete from ${table}`);
  }
});

function terminal(): ProvisioningTerminal & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    interactive: true,
    lines,
    ask: async () => {
      throw new Error("no prompt expected");
    },
    askSecret: async () => {
      throw new Error("no secret prompt expected");
    },
    say: (line) => lines.push(line),
  };
}

const iso = (epochMilliseconds: number) => new Date(epochMilliseconds).toISOString();
const count = async (table: string) => Number((await observer.query(`select count(*)::int as n from ${table}`)).rows[0]?.n);
const counts = async () => [await count("administrator_pending_challenge"), await count("administrator_consumed_challenge"), await count("administrator_session")];

/** Expired rows (and one live row per table, which must survive) for one new administrator. */
async function seedRows(pending: number, consumed: number, sessions: number): Promise<void> {
  const id = randomUUID();
  const created = await createAdministrator(db, { administratorId: id, username: `synthetic-${randomBytes(5).toString("hex")}`, passwordHash: "scrypt$ln=17,r=8,p=1$c2FsdA$a2V5" }, () => AT);
  expect(created.ok).toBe(true);

  for (let i = 0; i < pending; i++) {
    await observer.query("insert into administrator_pending_challenge values ($1, $2, $3::timestamptz, $3::timestamptz + interval '5 minutes', false)", [generateToken().digest, id, iso(AT - HOUR)]);
  }
  for (let i = 0; i < consumed; i++) {
    await observer.query("insert into administrator_consumed_challenge values ($1, $2, $3::timestamptz)", [generateToken().digest, id, iso(AT - MINUTE)]);
  }
  for (let i = 0; i < sessions; i++) {
    await observer.query(
      "insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at) values ($1, $2, $3, 'administrator', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '12 hours')",
      [generateToken().digest, randomUUID(), id, iso(AT - 13 * HOUR)],
    );
  }
  await observer.query("insert into administrator_pending_challenge values ($1, $2, $3::timestamptz, $3::timestamptz + interval '5 minutes', false)", [generateToken().digest, id, iso(AT - MINUTE)]);
  await observer.query("insert into administrator_consumed_challenge values ($1, $2, $3::timestamptz)", [generateToken().digest, id, iso(AT + MINUTE)]);
  await observer.query(
    "insert into administrator_session (token_digest, id, administrator_id, kind, created_at, last_activity_at, absolute_expires_at) values ($1, $2, $3, 'administrator', $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '12 hours')",
    [generateToken().digest, randomUUID(), id, iso(AT - MINUTE)],
  );
}

const outcomes = (lines: readonly string[]) => lines.filter((line) => line.startsWith("{")).map((line) => (JSON.parse(line) as Record<string, string>).outcome);
const HOUSEKEEPING_LABELS = ["housekeeping-pending-challenges", "housekeeping-consumed-challenges", "housekeeping-sessions"];

describe("C-1: an R3 refusal on a real cluster sends no housekeeping statement", () => {
  it("NOT_LOCAL_DATABASE after startup: no statement from runHousekeeping, and every expired row remains", async () => {
    await seedRows(2, 2, 2);
    const before = await counts();
    sent.length = 0;
    const io = terminal();

    const result = await runHousekeeping(io, { db, clock: () => AT, environment: {}, databaseUrl: "postgresql://demo:x@db.internal:5432/app" });

    expect(result).toEqual({ ok: false, outcome: "NOT_LOCAL_DATABASE" });
    expect(sent, "runHousekeeping sent no statement at all").toEqual([]);
    expect(sent.some((label) => HOUSEKEEPING_LABELS.includes(label))).toBe(false);
    expect(outcomes(io.lines)).toEqual(["NOT_LOCAL_DATABASE"]);
    expect(await counts()).toEqual(before);
  });
});

describe("C-3: end to end", () => {
  it("prints per-statement counts equal to the rows removed, a total, and one completed outcome line", async () => {
    await seedRows(3, 2, 4);
    const before = await counts();
    sent.length = 0;
    const io = terminal();

    const result = await runHousekeeping(io, { db, clock: () => AT, environment: {}, databaseUrl });
    const after = await counts();

    expect(result).toEqual({ ok: true, outcome: "HOUSEKEEPING_COMPLETED" });
    expect(before.map((n, i) => n - (after[i] ?? 0))).toEqual([3, 2, 4]);
    expect(io.lines).toEqual([
      HOUSEKEEPING_NOTICE,
      "pending challenges: deleted 3",
      "consumed records: deleted 2",
      "sessions: deleted 4",
      "Removed 9 expired rows.",
      expect.stringMatching(/^\{"event":"administrator-authentication","entry":"housekeeping","outcome":"HOUSEKEEPING_COMPLETED","at":"2026-11-05T12:00:00\.000Z"\}$/),
    ]);
    expect(sent).toEqual(HOUSEKEEPING_LABELS);
    expect(after).toEqual([1, 1, 1]);
  });
});

describe("C-4: an unknown result prints no number and no total", () => {
  it("a lost acknowledgement on the session DELETE is reported unknown, with the incomplete text", async () => {
    await seedRows(1, 1, 2);
    lostAcknowledgement = "housekeeping-sessions";
    const io = terminal();

    const result = await runHousekeeping(io, { db, clock: () => AT, environment: {}, databaseUrl });

    expect(result).toEqual({ ok: false, outcome: "HOUSEKEEPING_INCOMPLETE" });
    expect(io.lines.slice(1, 4)).toEqual(["pending challenges: deleted 1", "consumed records: deleted 1", "sessions: unknown"]);
    expect(io.lines).toContain(HOUSEKEEPING_INCOMPLETE_MESSAGE);
    expect(io.lines.some((line) => line.startsWith("Removed"))).toBe(false);
    expect(io.lines.join("\n")).not.toMatch(/nothing was changed/i);
    expect(outcomes(io.lines)).toEqual(["HOUSEKEEPING_INCOMPLETE"]);
  });
});

describe("C-5: no secrets in any output line", () => {
  it("prints no digest, token or row identifier", async () => {
    await seedRows(2, 1, 1);
    const ids = (await observer.query("select id::text as v from administrator_session union all select encode(token_digest, 'hex') from administrator_session union all select encode(token_digest, 'hex') from administrator_pending_challenge")).rows.map(
      (row) => row.v as string,
    );
    const io = terminal();

    await runHousekeeping(io, { db, clock: () => AT, environment: {}, databaseUrl });

    const output = io.lines.join("\n");
    for (const value of ids) {
      expect(output).not.toContain(value);
    }
    expect(output).not.toMatch(/[0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });
});
