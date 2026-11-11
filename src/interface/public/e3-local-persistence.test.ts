/**
 * Unit tests for `E3-local` (issue #246, Scope Gate revision 4 §5.2 and §6.2), with no database.
 *
 * Two kinds of double are used, and each test says which:
 * - **the real stack over a fake `pg` client**: `connection.ts`, the real `pg-pool` and the real
 *   Kysely dialect run unchanged, and only the transport is replaced. These prove what the pool
 *   does with a client whose `onConnect` verification fails;
 * - **a scripted pool**, where each checkout's timing is controlled, for the cases that depend on
 *   the order of a layout and a page (FI-3, FI-6).
 *
 * **These are simulated streaming cases, not wire-status checks.** "404" here means the layout's
 * pre-check returned `"refused"`, on which the layout calls `notFound()` before rendering. Whether
 * `next start` then sends HTTP 404, and when a response is committed, is verified only by the
 * separately authorized live `e3-check` acceptance run.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createListingPersistence,
  type ListingPersistence,
  type ListingPersistenceConfiguration,
} from "../../data/connection";
import {
  BI4_E3_DATABASE_URL,
  BI4_E3_EXPECTED_DATABASE,
  BI4_E3_EXPECTED_SYSTEM_IDENTIFIER,
  BI4_E3_LOCAL,
  BI4_E3_SYNTHETIC_MARKER,
  connectionMatches,
  createE3Local,
  E3_IDLE_TIMEOUT_MILLIS,
  E3_LOCAL_VARIABLES,
  E3_POOL_MAX,
  e3LocalConfigurationOf,
  e3LocalPersistence,
  e3LocalRoleSetupStatements,
  E3LocalRefused,
  isRefused,
  REFUSED,
  VERIFICATION_STATEMENT,
  type E3Expected,
  type E3LocalConfiguration,
} from "./e3-local-persistence";
import { publicReadSource } from "./public-read-persistence";

const PASSWORD = "Abcdef0123456789Xyz";
const MARKER = `bi4-e3-synthetic:${"0123456789abcdef".repeat(2)}`;
const URL_OK = `postgresql://bi4_e3_app:${PASSWORD}@127.0.0.1:55432/bi4_e3`;
const NE = "9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f";

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    [BI4_E3_LOCAL]: "1",
    [BI4_E3_DATABASE_URL]: URL_OK,
    [BI4_E3_EXPECTED_SYSTEM_IDENTIFIER]: "7300000000000000001",
    [BI4_E3_EXPECTED_DATABASE]: "bi4_e3",
    [BI4_E3_SYNTHETIC_MARKER]: MARKER,
    ...overrides,
  };
}

function configuration(): E3LocalConfiguration {
  const configured = e3LocalConfigurationOf(environment());
  if (configured === undefined) throw new Error("the fixture configuration must be accepted");
  return configured;
}

/* ------------------------------------------------------------------------------------------- */
/* The real stack over a fake pg client                                                           */
/* ------------------------------------------------------------------------------------------- */

interface FakeServer {
  systemIdentifier: string;
  database: string;
  marker: string | null;
  role: string;
  superuser: boolean;
  failConnect: boolean;
  failVerificationQuery: boolean;
}

function fakeServer(): FakeServer {
  return {
    systemIdentifier: "7300000000000000001",
    database: "bi4_e3",
    marker: MARKER,
    role: "bi4_e3_app",
    superuser: false,
    failConnect: false,
    failVerificationQuery: false,
  };
}

/** A real stack whose transport is a fake client answering from `server`. */
function realStack(server: FakeServer) {
  const created: FakeClient[] = [];
  const pools: Record<string, unknown>[] = [];

  class FakeClient extends EventEmitter {
    readonly statements: string[] = [];
    ended = false;
    _queryable = true;
    _ending = false;

    constructor() {
      super();
      created.push(this);
    }

    connect(callback: (error?: Error) => void): void {
      setImmediate(() => callback(server.failConnect ? new Error("connect ECONNREFUSED 127.0.0.1:55432") : undefined));
    }

    async query(text: string): Promise<{ rows: unknown[]; command: string; rowCount: number }> {
      this.statements.push(text);
      if (text === VERIFICATION_STATEMENT) {
        if (server.failVerificationQuery) throw new Error("permission denied for function pg_control_system");
        return {
          rows: [{ system_identifier: server.systemIdentifier, database: server.database, marker: server.marker, role: server.role, superuser: server.superuser }],
          command: "SELECT",
          rowCount: 1,
        };
      }
      return { rows: [], command: "SELECT", rowCount: 0 };
    }

    end(callback?: () => void): void {
      this.ended = true;
      this._ending = true;
      this._queryable = false;
      setImmediate(() => {
        this.emit("end");
        callback?.();
      });
    }

    /** The server ends an idle session, as `pg_terminate_backend` does. */
    drop(): void {
      this._queryable = false;
      this.emit("error", new Error("terminating connection due to administrator command"));
    }
  }

  const createPersistence = (config: ListingPersistenceConfiguration): ListingPersistence => {
    pools.push({ ...config.pool });
    return createListingPersistence({ ...config, pool: { ...config.pool, Client: FakeClient } as never });
  };

  return { created, pools, createPersistence };
}

const isListingQuery = (statement: string): boolean => statement.includes('"listing"');
const settle = (): Promise<void> => new Promise((resume) => setTimeout(resume, 10));

/* ------------------------------------------------------------------------------------------- */
/* A scripted pool, for order-dependent cases                                                     */
/* ------------------------------------------------------------------------------------------- */

interface Checkout {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** The first two pending checkouts, in the order they were requested. */
function firstTwo(pending: readonly Checkout[]): readonly [Checkout, Checkout] {
  const [first, second] = pending;
  if (first === undefined || second === undefined) throw new Error("expected two pending checkouts");
  return [first, second];
}

function scriptedPool() {
  const pending: Checkout[] = [];
  const reserved = { reserved: true };
  let checkouts = 0;
  let shutdowns = 0;
  const db = {
    connection: () => ({
      execute: (callback: (db: unknown) => Promise<unknown>) => {
        checkouts += 1;
        return new Promise((resolve, reject) => {
          pending.push({ resolve: () => resolve(callback(reserved)), reject });
        });
      },
    }),
  };
  const persistence = { db, shutdown: async () => void (shutdowns += 1) } as unknown as ListingPersistence;
  return { persistence, pending, reserved, checkouts: () => checkouts, shutdowns: () => shutdowns };
}

/* =========================================================================================== */

describe("E-U1/E-U2: enablement is pure and strict", () => {
  it("accepts the full production configuration", () => {
    expect(configuration()).toEqual({
      connectionString: URL_OK,
      expected: { systemIdentifier: "7300000000000000001", database: "bi4_e3", role: "bi4_e3_app", marker: MARKER },
    });
  });

  it("is off unless NODE_ENV is production and the flag is exactly 1", () => {
    for (const mode of ["development", "test", undefined]) {
      expect(e3LocalConfigurationOf(environment({ NODE_ENV: mode })), String(mode)).toBeUndefined();
    }
    for (const flag of [undefined, "", "0", "true", " 1", "01"]) {
      expect(e3LocalConfigurationOf(environment({ [BI4_E3_LOCAL]: flag })), JSON.stringify(flag)).toBeUndefined();
    }
  });

  it("refuses every host but 127.0.0.1, a missing port, another scheme and any query string", () => {
    for (const url of [
      `postgresql://bi4_e3_app:${PASSWORD}@localhost:55432/bi4_e3`,
      `postgresql://bi4_e3_app:${PASSWORD}@[::1]:55432/bi4_e3`,
      `postgresql://bi4_e3_app:${PASSWORD}@10.0.0.5:55432/bi4_e3`,
      `postgresql://bi4_e3_app:${PASSWORD}@127.0.0.2:55432/bi4_e3`,
      `postgresql://bi4_e3_app:${PASSWORD}@db.example.com:55432/bi4_e3`,
      `postgresql://bi4_e3_app:${PASSWORD}@127.0.0.1/bi4_e3`,
      `http://bi4_e3_app:${PASSWORD}@127.0.0.1:55432/bi4_e3`,
      `${URL_OK}?host=10.0.0.5`,
      `${URL_OK}?hostaddr=10.0.0.5`,
      `${URL_OK}?sslmode=disable`,
      `${URL_OK}?`,
      `${URL_OK}#x`,
      `postgresql://bi4_e3_app:${PASSWORD}@127.0.0.1:55432/other_db`,
      `postgresql://:${PASSWORD}@127.0.0.1:55432/bi4_e3`,
      "postgresql://bi4_e3_app:short@127.0.0.1:55432/bi4_e3",
      "postgresql://bi4_e3_app:%E0%A4%A@127.0.0.1:55432/bi4_e3",
      "not a url",
    ]) {
      expect(e3LocalConfigurationOf(environment({ [BI4_E3_DATABASE_URL]: url })), url).toBeUndefined();
    }
  });

  it("refuses a missing or malformed expected value", () => {
    for (const [name, value] of [
      [BI4_E3_DATABASE_URL, undefined],
      [BI4_E3_EXPECTED_SYSTEM_IDENTIFIER, undefined],
      [BI4_E3_EXPECTED_SYSTEM_IDENTIFIER, "12a"],
      [BI4_E3_EXPECTED_SYSTEM_IDENTIFIER, ""],
      [BI4_E3_EXPECTED_DATABASE, undefined],
      [BI4_E3_EXPECTED_DATABASE, "Bi4"],
      [BI4_E3_SYNTHETIC_MARKER, undefined],
      [BI4_E3_SYNTHETIC_MARKER, "bi4-e3-synthetic:short"],
      [BI4_E3_SYNTHETIC_MARKER, MARKER.toUpperCase()],
    ] as const) {
      expect(e3LocalConfigurationOf(environment({ [name]: value })), `${name}=${String(value)}`).toBeUndefined();
    }
  });

  it("decides enablement before any connection: a refused configuration builds no handle or pool", () => {
    const cache = globalThis as { __bi4E3Local?: unknown };
    const before = cache.__bi4E3Local;
    const saved = { ...process.env };
    try {
      Object.assign(process.env, environment({ [BI4_E3_DATABASE_URL]: `${URL_OK}?host=10.0.0.5` }));
      expect(e3LocalPersistence()).toBeUndefined();
      expect(cache.__bi4E3Local).toBe(before);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("E-U5: names and messages leak nothing", () => {
  it("uses no NEXT_PUBLIC_ name and ignores NEXT_PUBLIC_ spellings", () => {
    for (const name of E3_LOCAL_VARIABLES) expect(name.startsWith("NEXT_PUBLIC_")).toBe(false);
    const prefixed = Object.fromEntries(Object.entries(environment()).map(([key, value]) => [key === "NODE_ENV" ? key : `NEXT_PUBLIC_${key}`, value]));
    expect(e3LocalConfigurationOf(prefixed)).toBeUndefined();
  });

  it("refuses with one generic error that names no check and no value", () => {
    const error = new E3LocalRefused();
    expect(error.message).toBe("E3-local refused");
    for (const secret of [PASSWORD, MARKER, "7300000000000000001", "bi4_e3_app", "55432"]) expect(error.message).not.toContain(secret);
  });
});

describe("E-U6/E-U8: the selector, and the demo is unchanged", () => {
  it("chooses the demo first and never consults E3-local when the demo is configured", () => {
    const demo = { db: {}, shutdown: async () => {} } as unknown as ListingPersistence;
    const e3Local = vi.fn();

    expect(publicReadSource({ demo: () => demo, e3Local })).toEqual({ kind: "demo", persistence: demo });
    expect(e3Local).not.toHaveBeenCalled();
  });

  it("chooses E3-local only when the demo is absent, and otherwise none", () => {
    const handle = createE3Local(configuration(), { createPersistence: () => scriptedPool().persistence });

    expect(publicReadSource({ demo: () => undefined, e3Local: () => handle })).toEqual({ kind: "e3-local", e3: handle });
    expect(publicReadSource({ demo: () => undefined, e3Local: () => undefined })).toBeUndefined();
  });

  it("is not configured under next dev, so the demo path is the only one", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, environment({ NODE_ENV: "development" }));
      expect(e3LocalPersistence()).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("builds one handle per process for the production configuration, without connecting", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, environment());
      const first = e3LocalPersistence();
      expect(first).toBeDefined();
      expect(e3LocalPersistence()).toBe(first);
      expect(first?.isRefused()).toBe(false);
      await first?.shutdown();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("the E3-local pool settings (S-8)", () => {
  it("is one client, never evicted (idleTimeoutMillis 0 explicitly), never recycled, verified on connect", () => {
    const stack = realStack(fakeServer());
    void createE3Local(configuration(), { createPersistence: stack.createPersistence }).shutdown();
    const pool = stack.pools[0] as Record<string, unknown>;

    expect(E3_POOL_MAX).toBe(1);
    expect(E3_IDLE_TIMEOUT_MILLIS).toBe(0);
    expect(pool.max).toBe(1);
    expect(pool.idleTimeoutMillis).toBe(0);
    expect("maxUses" in pool).toBe(false);
    expect("maxLifetimeSeconds" in pool).toBe(false);
    expect(typeof pool.onConnect).toBe("function");
    expect(pool.connectionString).toBe(URL_OK);
  });
});

describe("C-1 to C-4: connection verification", () => {
  const expected: E3Expected = { systemIdentifier: "7300000000000000001", database: "bi4_e3", role: "bi4_e3_app", marker: MARKER };
  const row = { system_identifier: "7300000000000000001", database: "bi4_e3", marker: MARKER, role: "bi4_e3_app", superuser: false };
  const client = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) });

  it("passes only when every check matches, in one statement", async () => {
    const ok = client([row]);
    expect(await connectionMatches(ok, expected)).toBe(true);
    expect(ok.query).toHaveBeenCalledExactlyOnceWith(VERIFICATION_STATEMENT);
  });

  it("fails on each single mismatch, a superuser, a null marker, or a wrong row count", async () => {
    for (const change of [
      { system_identifier: "7300000000000000002" },
      { database: "postgres" },
      { marker: "bi4-e3-synthetic:ffffffffffffffffffffffffffffffff" },
      { marker: null },
      { role: "postgres" },
      { superuser: true },
      { superuser: null },
    ]) {
      expect(await connectionMatches(client([{ ...row, ...change }]), expected), JSON.stringify(change)).toBe(false);
    }
    expect(await connectionMatches(client([]), expected)).toBe(false);
    expect(await connectionMatches(client([row, row]), expected)).toBe(false);
  });

  it("marks the process refused before onConnect rejects, and does not end the pool inside the hook", async () => {
    let captured: ListingPersistenceConfiguration | undefined;
    const scripted = scriptedPool();
    const handle = createE3Local(configuration(), {
      createPersistence: (config) => {
        captured = config;
        return scripted.persistence;
      },
    });
    const onConnect = captured?.pool.onConnect as (client: unknown) => Promise<void>;

    await expect(onConnect(client([row]))).resolves.toBeUndefined();
    expect(handle.isRefused()).toBe(false);

    const failing = onConnect(client([{ ...row, marker: null }]));
    await expect(failing).rejects.toBeInstanceOf(E3LocalRefused);
    expect(handle.isRefused()).toBe(true);
    // Pool-lifecycle amendment: refusal never ends the pool; only an explicit shutdown does.
    expect(scripted.shutdowns()).toBe(0);

    // A connection opened after refusal is rejected before any SQL.
    const later = client([row]);
    await expect(onConnect(later)).rejects.toBeInstanceOf(E3LocalRefused);
    expect(later.query).not.toHaveBeenCalled();

    await handle.shutdown();
    expect(scripted.shutdowns()).toBe(1);
  });
});

describe("E-U3/FI-2: a failed verification on the layout's checkout (real stack)", () => {
  for (const [label, change] of [
    ["C-1 system identifier", (s: FakeServer) => void (s.systemIdentifier = "1")],
    ["C-2 database", (s: FakeServer) => void (s.database = "postgres")],
    ["C-3 marker", (s: FakeServer) => void (s.marker = null)],
    ["C-4 role", (s: FakeServer) => void (s.role = "postgres")],
    ["C-4 superuser", (s: FakeServer) => void (s.superuser = true)],
    ["a verification query error", (s: FakeServer) => void (s.failVerificationQuery = true)],
  ] as const) {
    it(`refuses on ${label}: pre-stream 404, client closed, only the verification statement sent`, async () => {
      const server = fakeServer();
      change(server);
      const stack = realStack(server);
      const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

      expect(await handle.precheck()).toBe("refused");
      await settle();

      expect(stack.created).toHaveLength(1);
      const rejected = stack.created[0] as (typeof stack.created)[number];
      expect(rejected.statements).toEqual([VERIFICATION_STATEMENT]);
      expect(rejected.ended).toBe(true);

      // Sticky: neither the layout nor the page opens or reserves anything afterwards.
      expect(await handle.precheck()).toBe("refused");
      expect(await handle.read(NE)).toBe(REFUSED);
      expect(stack.created).toHaveLength(1);
      expect(stack.created.flatMap((c) => c.statements).some(isListingQuery)).toBe(false);
    });
  }
});

describe("FI-1/FI-4: an already-refused process does no checkout at all", () => {
  it("returns refused from the layout and REFUSED from the page with zero checkouts", async () => {
    const scripted = scriptedPool();
    const handle = createE3Local(configuration(), { createPersistence: () => scripted.persistence });
    const find = vi.fn();

    const first = handle.read(NE);
    (scripted.pending.shift() as { reject: (error: Error) => void }).reject(new E3LocalRefused());
    expect(await first).toBe(REFUSED);
    expect(scripted.checkouts()).toBe(1);

    expect(await handle.precheck()).toBe("refused");
    expect(await handle.read(NE)).toBe(REFUSED);
    expect(scripted.checkouts()).toBe(1);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("FI-3: the layout re-reads the refusal after its own checkout, in either order", () => {
  it("layout checks out first; a concurrent page refusal lands before the layout's re-read", async () => {
    const scripted = scriptedPool();
    const find = vi.fn();
    const handle = createE3Local(configuration(), { createPersistence: () => scripted.persistence, find });

    const layout = handle.precheck();
    const page = handle.read(NE);
    const [layoutCheckout, pageCheckout] = firstTwo(scripted.pending);

    pageCheckout.reject(new E3LocalRefused());
    expect(await page).toBe(REFUSED);
    layoutCheckout.resolve();

    expect(await layout).toBe("refused");
    expect(find).not.toHaveBeenCalled();
  });

  it("page checks out first and is refused; the layout then refuses without a checkout", async () => {
    const scripted = scriptedPool();
    const find = vi.fn();
    const handle = createE3Local(configuration(), { createPersistence: () => scripted.persistence, find });

    const page = handle.read(NE);
    (scripted.pending.shift() as { reject: (error: Error) => void }).reject(new E3LocalRefused());
    expect(await page).toBe(REFUSED);

    expect(await handle.precheck()).toBe("refused");
    expect(scripted.checkouts()).toBe(1);
    expect(find).not.toHaveBeenCalled();
  });

  it("layout's own checkout fails while the page's succeeds: the layout still refuses", async () => {
    const scripted = scriptedPool();
    const find = vi.fn(async () => ({ ok: false as const, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" as const } }));
    const handle = createE3Local(configuration(), { createPersistence: () => scripted.persistence, find });

    const page = handle.read(NE);
    const layout = handle.precheck();
    const [pageCheckout, layoutCheckout] = firstTwo(scripted.pending);

    pageCheckout.resolve();
    expect(isRefused(await page)).toBe(false);
    layoutCheckout.reject(new Error("connect ECONNREFUSED"));
    expect(await layout).toBe("refused");
  });
});

describe("FI-5: post-commit residual — the page's new client fails verification (real stack)", () => {
  it("renders the generic outcome with no listing query on the rejected client, then refuses later requests", async () => {
    const server = fakeServer();
    const stack = realStack(server);
    const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

    // The layout passed: one verified client, idle in the pool.
    expect(await handle.precheck()).toBe("ok");
    const verified = stack.created[0] as (typeof stack.created)[number];
    expect(verified.statements).toEqual([VERIFICATION_STATEMENT]);

    // The server drops that session and the marker changes before the page reserves a client.
    verified.drop();
    server.marker = "bi4-e3-synthetic:ffffffffffffffffffffffffffffffff";
    await settle();

    expect(await handle.read(NE)).toBe(REFUSED);
    await settle();

    expect(stack.created).toHaveLength(2);
    const rejected = stack.created[1] as (typeof stack.created)[number];
    expect(rejected.statements).toEqual([VERIFICATION_STATEMENT]);
    expect(rejected.ended).toBe(true);
    expect(stack.created.flatMap((c) => c.statements).some(isListingQuery)).toBe(false);

    // A later direct request: the layout refuses without a checkout.
    expect(await handle.precheck()).toBe("refused");
    expect(stack.created).toHaveLength(2);
  });
});

describe("FI-6: refusal between the page's reservation and its query", () => {
  it("runs no query on the reserved client", async () => {
    const scripted = scriptedPool();
    const find = vi.fn();
    const handle = createE3Local(configuration(), { createPersistence: () => scripted.persistence, find });

    const page = handle.read(NE);
    const other = handle.read(NE);
    const [pageCheckout, otherCheckout] = firstTwo(scripted.pending);

    otherCheckout.reject(new E3LocalRefused());
    expect(await other).toBe(REFUSED);
    pageCheckout.resolve();

    expect(await page).toBe(REFUSED);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("FI-7 / S-11: any checkout error is a sticky refusal", () => {
  it("refuses on a connection error in the layout (real stack)", async () => {
    const server = fakeServer();
    server.failConnect = true;
    const stack = realStack(server);
    const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

    expect(await handle.precheck()).toBe("refused");
    server.failConnect = false;
    expect(await handle.precheck()).toBe("refused");
    expect(await handle.read(NE)).toBe(REFUSED);
    expect(stack.created).toHaveLength(1);
  });

  it("refuses on a connection error in the page (real stack)", async () => {
    const server = fakeServer();
    server.failConnect = true;
    const stack = realStack(server);
    const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

    expect(await handle.read(NE)).toBe(REFUSED);
    expect(handle.isRefused()).toBe(true);
    expect(await handle.precheck()).toBe("refused");
  });
});

describe("E-U4/E-U9: the normal path, and every new client is verified", () => {
  it("verifies once per new client, including the replacement after a drop", async () => {
    const stack = realStack(fakeServer());
    const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

    expect(await handle.precheck()).toBe("ok");
    const outcome = await handle.read(NE);
    expect(isRefused(outcome)).toBe(false);
    expect(outcome).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });

    const first = stack.created[0] as (typeof stack.created)[number];
    expect(stack.created).toHaveLength(1);
    expect(first.statements[0]).toBe(VERIFICATION_STATEMENT);
    expect(first.statements.filter((s) => s === VERIFICATION_STATEMENT)).toHaveLength(1);
    expect(first.statements.slice(1).every(isListingQuery)).toBe(true);

    first.drop();
    await settle();
    expect(await handle.read(NE)).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });

    const second = stack.created[1] as (typeof stack.created)[number];
    expect(second.statements[0]).toBe(VERIFICATION_STATEMENT);
    expect(second.statements.slice(1).every(isListingQuery)).toBe(true);
    await handle.shutdown();
  });

  it("works in both render orders with no shared-client assumption", async () => {
    for (const order of ["layout-first", "page-first"] as const) {
      const stack = realStack(fakeServer());
      const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

      const [layout, page] =
        order === "layout-first"
          ? await Promise.all([handle.precheck(), handle.read(NE)])
          : await Promise.all([handle.read(NE), handle.precheck()]).then(([p, l]) => [l, p] as const);

      expect(layout, order).toBe("ok");
      expect(isRefused(page), order).toBe(false);
      for (const client of stack.created) expect(client.statements[0], order).toBe(VERIFICATION_STATEMENT);
      await handle.shutdown();
    }
  });

  it("keeps a malformed identity away from the listing table while still guarding the read", async () => {
    const stack = realStack(fakeServer());
    const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

    expect(await handle.read("not-a-uuid")).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(stack.created.flatMap((c) => c.statements).some(isListingQuery)).toBe(false);
    await handle.shutdown();
  });
});

describe("the app-role setup statements (revision 3 §4.1)", () => {
  it("revokes PUBLIC's defaults, then grants exactly connect, usage, select on listing, and execute", () => {
    expect(e3LocalRoleSetupStatements({ database: "bi4_e3", role: "bi4_e3_app", password: PASSWORD })).toEqual([
      'revoke all on database "bi4_e3" from public',
      "revoke all on schema public from public",
      `create role "bi4_e3_app" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit password '${PASSWORD}'`,
      'grant connect on database "bi4_e3" to "bi4_e3_app"',
      'grant usage on schema public to "bi4_e3_app"',
      'grant select on public.listing to "bi4_e3_app"',
      'grant execute on function pg_control_system() to "bi4_e3_app"',
    ]);
  });

  it("refuses identifiers or passwords that would need quoting", () => {
    for (const input of [
      { database: 'x"; drop', role: "r", password: PASSWORD },
      { database: "db", role: "Role", password: PASSWORD },
      { database: "db", role: "r", password: "short" },
      { database: "db", role: "r", password: `${PASSWORD}'` },
    ]) {
      expect(() => e3LocalRoleSetupStatements(input)).toThrow();
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Regression: the refusal timeout seen in run e3-check-a63838bb (issue #246)                      */
/* ------------------------------------------------------------------------------------------- */

/**
 * In the live run, the request that triggered each refusal (E-A3, E-A4b) got no response within
 * 60 s, while the next request got an immediate 404. Under `next start`, the directory layout's
 * pre-check and the page's read run in parallel, so two checkouts race on the one-client pool:
 * the first opens a client whose `onConnect` verification fails; the second is queued behind it.
 *
 * These tests use the real stack (`connection.ts`, the pinned `pg-pool`, Kysely) over a fake
 * client, and a **bounded wait**: a checkout that never settles fails with a clear message
 * instead of hanging the suite.
 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<{ readonly settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ settled: true as const, value })), bound]);
  } finally {
    clearTimeout(timer);
  }
}

const SETTLE_BOUND_MS = 2_000;

describe("refusal timeout regression (#246, run e3-check-a63838bb)", () => {
  for (const order of ["layout-first", "page-first"] as const) {
    it(`settles both the layout pre-check and the page read when the new client fails verification (${order})`, async () => {
      const server = fakeServer();
      server.marker = "bi4-e3-synthetic:ffffffffffffffffffffffffffffffff";
      const stack = realStack(server);
      const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });

      // Both start in the same turn, as the layout and the page do under `next start`.
      const precheck = order === "layout-first" ? handle.precheck() : undefined;
      const read = handle.read(NE);
      const precheckSecond = order === "page-first" ? handle.precheck() : undefined;
      const layout = (precheck ?? precheckSecond) as Promise<"ok" | "refused">;

      const layoutOutcome = await settlesWithin(layout, SETTLE_BOUND_MS);
      const pageOutcome = await settlesWithin(read, SETTLE_BOUND_MS);

      expect(layoutOutcome.settled, `the layout pre-check did not settle within ${SETTLE_BOUND_MS} ms (${order})`).toBe(true);
      expect(pageOutcome.settled, `the page read did not settle within ${SETTLE_BOUND_MS} ms (${order})`).toBe(true);
      if (layoutOutcome.settled) expect(layoutOutcome.value).toBe("refused");
      if (pageOutcome.settled) expect(pageOutcome.value).toBe(REFUSED);
      expect(stack.created.flatMap((c) => c.statements).some(isListingQuery)).toBe(false);

      // The first client was verified and failed; every client opened after refusal sent no SQL.
      const [verified, ...afterRefusal] = stack.created;
      expect(verified?.statements).toEqual([VERIFICATION_STATEMENT]);
      expect(afterRefusal.length).toBeGreaterThan(0);
      for (const client of afterRefusal) expect(client.statements).toEqual([]);

      // Every failed client is closed.
      await settle();
      for (const client of stack.created) expect(client.ended).toBe(true);

      // Later direct requests do no checkout at all.
      const opened = stack.created.length;
      expect(await handle.precheck()).toBe("refused");
      expect(await handle.read(NE)).toBe(REFUSED);
      expect(stack.created).toHaveLength(opened);

      // The explicit shutdown completes once the queued operations have settled.
      expect(await settlesWithin(handle.shutdown(), SETTLE_BOUND_MS), `the explicit shutdown did not complete within ${SETTLE_BOUND_MS} ms (${order})`).toEqual({ settled: true, value: undefined });
    });
  }

  it("a single checkout whose new client fails verification settles (the uncontended path, already covered)", async () => {
    const server = fakeServer();
    server.marker = null;
    const stack = realStack(server);
    const handle = createE3Local(configuration(), { createPersistence: stack.createPersistence });
    const outcome = await settlesWithin(handle.precheck(), SETTLE_BOUND_MS);
    expect(outcome).toEqual({ settled: true, value: "refused" });
  });
});
