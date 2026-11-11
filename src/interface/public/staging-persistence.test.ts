/**
 * `staging-persistence.ts` with fakes (issue #246, OP-2 staging Scope Gate revision 2 §3.5, §7).
 *
 * ST-1 pool configuration (C-1′ TLS, one client); ST-2 C-2 to C-4 and sticky refusal, with a queued
 * checkout settling; ST-3 counters, `overlappedReads` as dispatch-time overlap; ST-4 calibration off
 * by default, bounded, recorded; ST-5 status snapshot, side-by-side windows, no secrets;
 * ST-6 `publicReadSource` selection; ST-7 role setup statements.
 *
 * Real TLS verification and real SQL are in `staging-persistence.integration.test.ts`.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createListingPersistence, type ListingPersistence, type ListingPersistenceConfiguration } from "../../data/connection";
import { REFUSED } from "./e3-local-persistence";
import { publicReadSource } from "./public-read-persistence";
import { CALIBRATION_DELAY_CEILING_NS, type StagingConfiguration } from "./staging-access";
import {
  CALIBRATION_OVERRUN_NS,
  CALIBRATION_RING_SIZE,
  createStaging,
  spin,
  STAGING_VERIFICATION_STATEMENT,
  stagingConnectionMatches,
  stagingPoolConfiguration,
  stagingRoleSetupStatements,
  summarizeCalibration,
  type LoopHistogram,
  type StagingHandle,
} from "./staging-persistence";

const MARKER = `bi4-staging-synthetic:${"e".repeat(32)}`;
const CAL_A = "c1000000-0000-4000-8000-000000000001";
const CAL_B = "c2000000-0000-4000-8000-000000000002";
const ORDINARY = "9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f";
const SECRET_URL = `postgres://bi4_staging_app:${"s".repeat(32)}@db.example.test:25060/bi4_staging`;

function configuration(calibration: StagingConfiguration["calibration"] = []): StagingConfiguration {
  return {
    connectionString: SECRET_URL,
    caPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
    expected: { host: "db.example.test", database: "bi4_staging", role: "bi4_staging_app", marker: MARKER },
    keyDigestHex: "f".repeat(64),
    calibration,
  };
}

const noHistogram = () => undefined;

/* ------------------------------------------------------------------------------------------- */
/* The real stack over a fake pg client (as in the E3-local tests)                                */
/* ------------------------------------------------------------------------------------------- */

interface FakeServer {
  database: string;
  marker: string | null;
  role: string;
  superuser: boolean;
}

function realStack(server: FakeServer) {
  const created: { statements: string[] }[] = [];
  const pools: Record<string, unknown>[] = [];

  class FakeClient extends EventEmitter {
    readonly statements: string[] = [];
    _queryable = true;
    _ending = false;

    constructor() {
      super();
      created.push(this);
    }

    connect(callback: (error?: Error) => void): void {
      setImmediate(() => callback(undefined));
    }

    async query(text: string): Promise<{ rows: unknown[]; command: string; rowCount: number }> {
      this.statements.push(text);
      if (text === STAGING_VERIFICATION_STATEMENT) {
        return { rows: [{ database: server.database, marker: server.marker, role: server.role, superuser: server.superuser }], command: "SELECT", rowCount: 1 };
      }
      return { rows: [], command: "SELECT", rowCount: 0 };
    }

    end(callback?: () => void): void {
      this._ending = true;
      this._queryable = false;
      setImmediate(() => {
        this.emit("end");
        callback?.();
      });
    }
  }

  const createPersistence = (config: ListingPersistenceConfiguration): ListingPersistence => {
    pools.push({ ...config.pool });
    return createListingPersistence({ ...config, pool: { ...config.pool, Client: FakeClient } as never });
  };

  return { created, pools, createPersistence };
}

const goodServer = (): FakeServer => ({ database: "bi4_staging", marker: MARKER, role: "bi4_staging_app", superuser: false });
const isListingQuery = (statement: string): boolean => statement.includes('"listing"');

/** A scripted pool whose checkouts resolve when told to. */
function scriptedPool() {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const db = {
    connection: () => ({
      execute: (callback: (db: unknown) => Promise<unknown>) =>
        new Promise((resolve, reject) => {
          pending.push({ resolve: () => resolve(callback({ reserved: true })), reject });
        }),
    }),
  };
  return { persistence: { db, shutdown: async () => {} } as unknown as ListingPersistence, pending };
}

const NOT_FOUND = Object.freeze({ ok: false as const, error: Object.freeze({ kind: "not-found" }) });
const find = vi.fn(async () => NOT_FOUND as never);

/* =========================================================================================== */

describe("ST-1: the pool configuration (C-1′)", () => {
  it("uses TLS with the pinned CA and full verification, one client, never evicted", () => {
    const pool = stagingPoolConfiguration(configuration(), async () => {});
    expect(pool.ssl).toEqual({ ca: configuration().caPem, rejectUnauthorized: true });
    expect(pool.max).toBe(1);
    expect(pool.idleTimeoutMillis).toBe(0);
    expect(pool.connectionString).toBe(SECRET_URL);
    expect(typeof pool.onConnect).toBe("function");
    expect(pool).not.toHaveProperty("maxUses");
    expect(pool).not.toHaveProperty("maxLifetimeSeconds");
  });

  it("passes that configuration to the persistence factory", () => {
    const stack = realStack(goodServer());
    void createStaging(configuration(), { createPersistence: stack.createPersistence, histogram: noHistogram }).shutdown();
    expect(stack.pools[0]?.ssl).toEqual({ ca: configuration().caPem, rejectUnauthorized: true });
  });
});

describe("ST-2: C-2 to C-4 and sticky refusal", () => {
  it("accepts only the expected database, marker and non-superuser role", async () => {
    const expected = configuration().expected;
    const client = (row: Record<string, unknown>) => ({ query: async () => ({ rows: [row] }) });
    const good = { database: "bi4_staging", marker: MARKER, role: "bi4_staging_app", superuser: false };
    expect(await stagingConnectionMatches(client(good), expected)).toBe(true);
    for (const bad of [{ database: "defaultdb" }, { marker: null }, { marker: "other" }, { role: "doadmin" }, { superuser: true }, { superuser: null }]) {
      expect(await stagingConnectionMatches(client({ ...good, ...bad }), expected), JSON.stringify(bad)).toBe(false);
    }
    expect(await stagingConnectionMatches({ query: async () => ({ rows: [] }) }, expected)).toBe(false);
  });

  it("refuses on a failed check, sends no listing query, and stays refused", async () => {
    const stack = realStack({ ...goodServer(), marker: "bi4-staging-synthetic:other" });
    const handle = createStaging(configuration(), { createPersistence: stack.createPersistence, histogram: noHistogram });

    expect(await handle.precheck()).toBe("refused");
    expect(await handle.read(ORDINARY)).toBe(REFUSED);
    expect(handle.isRefused()).toBe(true);
    expect(stack.created.flatMap((c) => c.statements).some(isListingQuery)).toBe(false);
    expect(handle.status().state).toBe("refused");
    expect(handle.status().refusals).toBe(1);
    await handle.shutdown();
  });

  it("settles a concurrent read queued behind a failing connection with the refusal", async () => {
    const stack = realStack({ ...goodServer(), superuser: true });
    const handle = createStaging(configuration(), { createPersistence: stack.createPersistence, histogram: noHistogram });

    const results = await Promise.all([handle.precheck(), handle.read(ORDINARY)]);
    expect(results).toEqual(["refused", REFUSED]);
    expect(stack.created.flatMap((c) => c.statements).some(isListingQuery)).toBe(false);
    await handle.shutdown();
  });

  it("reads through a verified connection and reports verified", async () => {
    const stack = realStack(goodServer());
    const handle = createStaging(configuration(), { createPersistence: stack.createPersistence, find, histogram: noHistogram });

    expect(await handle.precheck()).toBe("ok");
    expect(await handle.read(ORDINARY)).toBe(NOT_FOUND);
    const status = handle.status();
    expect(status.state).toBe("verified");
    expect(status.refusals).toBe(0);
    expect(status.readsAfterRefusal).toBe(0);
    await handle.shutdown();
  });
});

describe("ST-3: counters", () => {
  it("counts every read, and overlap only when a read begins while another is in progress", async () => {
    const scripted = scriptedPool();
    const handle = createStaging(configuration(), { createPersistence: () => scripted.persistence, find, histogram: noHistogram });

    const first = handle.read(ORDINARY);
    const second = handle.read(ORDINARY);
    scripted.pending.forEach((checkout) => checkout.resolve());
    await Promise.all([first, second]);
    expect(handle.status().overlappedReads).toBe(1);
    expect(handle.status().s2Reads).toBe(2);

    const third = handle.read(ORDINARY);
    scripted.pending[2]?.resolve();
    await third;
    const fourth = handle.read(ORDINARY);
    scripted.pending[3]?.resolve();
    await fourth;
    expect(handle.status().overlappedReads).toBe(1);
    expect(handle.status().s2Reads).toBe(4);
  });
});

describe("ST-4: calibration", () => {
  it("is off by default: no busy-wait for any identity", async () => {
    const busyWait = vi.fn(() => 0);
    const scripted = scriptedPool();
    const handle = createStaging(configuration(), { createPersistence: () => scripted.persistence, find, busyWait, histogram: noHistogram });
    const read = handle.read(CAL_A);
    scripted.pending[0]?.resolve();
    await read;
    expect(busyWait).not.toHaveBeenCalled();
    expect(handle.status().calibrationEnabled).toBe(false);
  });

  it("delays only approved identities, after the database read, and records the realized delay", async () => {
    const order: string[] = [];
    const busyWait = vi.fn((ns: number) => {
      order.push(`wait ${ns}`);
      return ns + 50_000;
    });
    const recordingFind = vi.fn(async () => {
      order.push("read");
      return NOT_FOUND as never;
    });
    const scripted = scriptedPool();
    const handle = createStaging(configuration([{ identity: CAL_A, delayNs: 1_000_000 }, { identity: CAL_B, delayNs: 0 }]), {
      createPersistence: () => scripted.persistence,
      find: recordingFind,
      busyWait,
      histogram: noHistogram,
    });

    for (const identity of [CAL_A, ORDINARY, CAL_B, CAL_A]) {
      const read = handle.read(identity);
      scripted.pending[scripted.pending.length - 1]?.resolve();
      await read;
    }

    expect(order).toEqual(["read", "wait 1000000", "read", "read", "wait 0", "read", "wait 1000000"]);
    const status = handle.status();
    expect(status.calibrationEnabled).toBe(true);
    expect(status.calibrationSinceLastStatus).toEqual([
      { nominalNs: 0, count: 1, minNs: 50_000, p50Ns: 50_000, p99Ns: 50_000, maxNs: 50_000, overruns: 0 },
      { nominalNs: 1_000_000, count: 2, minNs: 1_050_000, p50Ns: 1_050_000, p99Ns: 1_050_000, maxNs: 1_050_000, overruns: 0 },
    ]);
    expect(handle.status().calibrationSinceLastStatus).toEqual([]);
    expect(handle.status().calibrationTotal).toHaveLength(2);
  });

  it("does not delay a refused read", async () => {
    const busyWait = vi.fn(() => 0);
    const stack = realStack({ ...goodServer(), marker: null });
    const handle = createStaging(configuration([{ identity: CAL_A, delayNs: 1000 }]), { createPersistence: stack.createPersistence, busyWait, histogram: noHistogram });
    expect(await handle.read(CAL_A)).toBe(REFUSED);
    expect(busyWait).not.toHaveBeenCalled();
    await handle.shutdown();
  });

  it("bounds the ring and counts overruns", () => {
    const records = Array.from({ length: 3 }, (_, index) => ({ sequence: index, identityIndex: 0, nominalNs: 1000, realizedNs: 1000 + index * CALIBRATION_OVERRUN_NS }));
    expect(summarizeCalibration(records)).toEqual([{ nominalNs: 1000, count: 3, minNs: 1000, p50Ns: 1000 + CALIBRATION_OVERRUN_NS, p99Ns: 1000 + 2 * CALIBRATION_OVERRUN_NS, maxNs: 1000 + 2 * CALIBRATION_OVERRUN_NS, overruns: 1 }]);
    expect(CALIBRATION_RING_SIZE).toBe(20_000);
  });

  it("keeps at most the ring size of records", async () => {
    const scripted = scriptedPool();
    const handle = createStaging(configuration([{ identity: CAL_A, delayNs: 0 }]), { createPersistence: () => scripted.persistence, find, busyWait: () => 1, histogram: noHistogram });
    for (let i = 0; i < CALIBRATION_RING_SIZE + 5; i += 1) {
      const read = handle.read(CAL_A);
      scripted.pending[i]?.resolve();
      await read;
    }
    expect(handle.status().calibrationTotal[0]?.count).toBe(CALIBRATION_RING_SIZE);
  });

  it("spins for at least the requested time, and never past the ceiling", () => {
    expect(spin(200_000)).toBeGreaterThanOrEqual(200_000);
    const start = process.hrtime.bigint();
    spin(CALIBRATION_DELAY_CEILING_NS * 1000);
    expect(Number(process.hrtime.bigint() - start)).toBeLessThan(CALIBRATION_DELAY_CEILING_NS * 50);
  });
});

describe("ST-5: the status snapshot", () => {
  it("starts unconnected, reports the event-loop window beside calibration, and resets it", async () => {
    const histogram: LoopHistogram = {
      enable: vi.fn(),
      reset: vi.fn(),
      min: 1_000_000,
      max: 3_000_000,
      mean: 1_500_000,
      exceeds: 0,
      count: 10,
      percentile: (p: number) => (p >= 99 ? 3_000_000 : 1_200_000),
    };
    const handle = createStaging(configuration(), { createPersistence: () => scriptedPool().persistence, histogram: () => histogram, bootNonce: "n".repeat(32) });
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    const status = handle.status();
    expect(status.state).toBe("unconnected");
    expect(status.bootNonce).toBe("n".repeat(32));
    expect(status.eventLoopSinceLastStatus).toEqual({ resolutionMs: 1, samples: 10, minNs: 1_000_000, meanNs: 1_500_000, p50Ns: 1_200_000, p99Ns: 3_000_000, maxNs: 3_000_000 });
    expect(histogram.reset).toHaveBeenCalledTimes(1);
  });

  it("never contains the connection string, password, marker or digest", () => {
    const handle: StagingHandle = createStaging(configuration(), { createPersistence: () => scriptedPool().persistence, histogram: noHistogram });
    const text = JSON.stringify(handle.status());
    for (const secret of [SECRET_URL, "s".repeat(32), MARKER, "f".repeat(64)]) expect(text).not.toContain(secret);
  });
});

describe("ST-6: publicReadSource selection", () => {
  const demo = { db: {}, shutdown: async () => {} } as unknown as ListingPersistence;
  const e3 = { isRefused: () => false } as never;
  const staging = { isRefused: () => false } as unknown as StagingHandle;

  it("uses staging alone when the mode is on", () => {
    expect(publicReadSource({ staging: () => ({ kind: "on", handle: staging }), demo: () => demo, e3Local: () => e3 })).toEqual({ kind: "staging", staging });
  });

  it("returns no source at all under deny-all, even if the demo or E3-local is configured", () => {
    expect(publicReadSource({ staging: () => ({ kind: "deny-all" }), demo: () => demo, e3Local: () => e3 })).toBeUndefined();
  });

  it("keeps the old order when staging is off", () => {
    const off = () => ({ kind: "off" }) as const;
    expect(publicReadSource({ staging: off, demo: () => demo, e3Local: () => e3 })).toEqual({ kind: "demo", persistence: demo });
    expect(publicReadSource({ staging: off, demo: () => undefined, e3Local: () => e3 })).toEqual({ kind: "e3-local", e3 });
    expect(publicReadSource({ staging: off, demo: () => undefined, e3Local: () => undefined })).toBeUndefined();
  });
});

describe("ST-7: the app-role setup statements", () => {
  it("revokes PUBLIC's defaults, then grants exactly connect, usage and select on listing", () => {
    expect(stagingRoleSetupStatements({ database: "bi4_staging", role: "bi4_staging_app", password: "a".repeat(32) })).toEqual([
      'revoke all on database "bi4_staging" from public',
      "revoke all on schema public from public",
      `create role "bi4_staging_app" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit password '${"a".repeat(32)}'`,
      'grant connect on database "bi4_staging" to "bi4_staging_app"',
      'grant usage on schema public to "bi4_staging_app"',
      'grant select on public.listing to "bi4_staging_app"',
    ]);
  });

  it("refuses unsafe names and passwords", () => {
    expect(() => stagingRoleSetupStatements({ database: "Bad", role: "r", password: "a".repeat(32) })).toThrow();
    expect(() => stagingRoleSetupStatements({ database: "d", role: "r;drop", password: "a".repeat(32) })).toThrow();
    expect(() => stagingRoleSetupStatements({ database: "d", role: "r", password: "short" })).toThrow();
    expect(() => stagingRoleSetupStatements({ database: "d", role: "r", password: `${"a".repeat(20)}'` })).toThrow();
  });
});
