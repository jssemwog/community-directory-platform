/**
 * Synthetic tests for the `e3-check` launcher (issue #246, `E3-local` Scope Gate revision 4;
 * E-O1 to E-O4). Every seam is a fake: no server, database, build or worktree is involved, and no
 * wire status is established here. The live run is separately authorized.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";

import { createListingPersistence } from "../../src/data/connection";
import type { ListingDatabase } from "../../src/data/listing-table";
import { applyGovernedMigration, CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../src/data/testing/embedded-cluster";
import {
  appDatabaseUrl,
  BOOTSTRAP_APPLICATION_NAME,
  BOOTSTRAP_DATABASE,
  buildEnvironmentProblems,
  createE3SuperuserOps,
  createRedactor,
  E3_CLUSTER_REQUEST,
  e3FinalSafety,
  loopbackTargetProblems,
  redactDeep,
  stopPhaseServer,
  type PhaseStopDeps,
  type SuperuserConnection,
  type SuperuserDeps,
  checkAppListener,
  compareE3Equivalence,
  databaseListenerProblems,
  E3_DATABASE,
  E3_REQUEST_CAP,
  e3Requests,
  E3Stop,
  e3ConsoleLines,
  leakHits,
  phaseEnvironment,
  prefixHits,
  renderE3Report,
  runE3Check,
  verifyDatabaseListener,
  type AppServer,
  type E3Exchange,
  type E3Fixtures,
  type E3Inspections,
  type E3Phase,
  type E3RunSeams,
  type E3Secrets,
  type ScannedItem,
  type SuperuserOps,
} from "./e3-check";
import type { ListeningEntry, ProcessIdentity, ResourceEntry, TeardownReport } from "./isolation";

const FIXTURES: E3Fixtures = {
  neverExisted: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
  pending: "33333333-3333-4333-8333-333333333333",
  rejected: "44444444-4444-4444-8444-444444444444",
  unpublished: "55555555-5555-4555-8555-555555555555",
  publiclyAvailable: "66666666-6666-4666-8666-666666666666",
  malformed: "e3-malformed-0001",
  publicName: "Harbour Bakery",
  fixtureTexts: ["A small bakery.", "Kinsale", "P17 AB12"],
};
const SECRETS: E3Secrets = { role: "bi4_e3_app_abcd1234", password: "0123456789abcdef0123456789abcdef", marker: `bi4-e3-synthetic:${"a".repeat(32)}` };
const DB_PORT = 55_432;
const POSTMASTER = { pid: 4_100, creationTime: "pm-1" };
const SYSTEM_IDENTIFIER = "7300000000000000001";
const CLUSTER_DIRECTORY = "C:\\Temp\\cdp-bi4-cluster-x\\root\\cluster";
const BUILD_ENVIRONMENT = { PATH: "C:\\Windows", NEXT_TELEMETRY_DISABLED: "1" };

const identity = (pid: number, creationTime: string): ProcessIdentity => ({ pid, parentPid: 1, creationTime, executable: null, commandLine: null });

/* ------------------------------------------------------------------------------------------- */
/* A healthy fake world, adjustable per test                                                      */
/* ------------------------------------------------------------------------------------------- */

interface World {
  events: string[];
  sent: { phase: E3Phase | "?"; method: string; path: string }[];
  dbEntries: () => readonly ListeningEntry[];
  respond: (phase: E3Phase, method: string, path: string) => E3Exchange;
  scan: { staticAssets: ScannedItem[]; otherBuildFiles: ScannedItem[]; logs: ScannedItem[] };
  buildFails: boolean;
  dataDirectory: string;
  storedAfter: readonly string[];
  /** The phase whose server stop is unresolved, if any. */
  stopUnresolved?: E3Phase;
  /** Make the E-A4b session termination fail. */
  terminateFails?: boolean;
  /** Replace the fake superuser, e.g. with the real `createE3SuperuserOps` over recording fakes. */
  superuser?: () => SuperuserOps;
  /** Resources registered with the fake helper; its cleanup would close these. */
  registered: string[];
}

function exchange(status: number, body: string, headers: readonly string[] = []): E3Exchange {
  const now = Date.now();
  return { status, rawHeaders: ["Date", new Date(now).toUTCString(), "Content-Type", "text/html; charset=utf-8", ...headers], body: Buffer.from(body, "utf8"), writeStartMs: now, responseEndMs: now };
}

const ADMIN = ["Cache-Control", "no-store", "X-Frame-Options", "DENY", "Content-Security-Policy", "frame-ancestors 'none'", "Referrer-Policy", "same-origin"];
const notAvailable = (id: string): string => `<html><h1>Not available</h1><p>The listing is not available.</p><a href="/directory/${id}">x</a></html>`;

/** Healthy behaviour, per phase, as revision 4 §5.1 expects. */
function healthy(phase: E3Phase, method: string, path: string): E3Exchange {
  if (path === "/") return exchange(200, "<html>home</html>");
  if (path === "/directory/") return exchange(308, "/directory", ["Location", "/directory"]);
  if (path === "/admin") return method === "OPTIONS" ? exchange(404, "Not Found", ["Content-Type", "text/plain; charset=utf-8"]) : exchange(404, "<html>404</html>", ADMIN);
  if (path === "/Directory" || path === "/%64irectory") return exchange(404, "<html>404</html>");
  if (path === "/directory") return phase === "E-A2" ? exchange(404, "<html>404</html>") : exchange(404, "Not Found");
  const id = path.slice("/directory/".length);
  if (phase !== "E-A4") return exchange(404, "<html>404</html>");
  if (id === FIXTURES.publiclyAvailable) return exchange(200, `<html><h1>Harbour Bakery</h1><p>${id}</p></html>`);
  return exchange(200, notAvailable(id));
}

function world(): World {
  return {
    events: [],
    sent: [],
    dbEntries: () => [
      { localAddress: "127.0.0.1", owningProcess: POSTMASTER.pid },
      { localAddress: "::1", owningProcess: POSTMASTER.pid },
    ],
    respond: healthy,
    scan: { staticAssets: [{ where: ".next/static/chunks/a.js", bytes: Buffer.from("console.log(1)") }], otherBuildFiles: [], logs: [{ where: "next-start.out.log", bytes: Buffer.from("ready") }] },
    buildFails: false,
    dataDirectory: CLUSTER_DIRECTORY.replace(/\\/g, "/"),
    storedAfter: [],
    registered: [],
  };
}

function seamsFor(w: World): E3RunSeams {
  const apps = new Map<number, { phase: E3Phase; pid: number }>();
  let nextPort = 40_000;
  let currentPhase: E3Phase | undefined;

  const inspections: E3Inspections = {
    lookup: async (port) => {
      if (port === DB_PORT) {
        w.events.push("lookup:db");
        return w.dbEntries();
      }
      const app = apps.get(port);
      return app === undefined ? [] : [{ localAddress: "127.0.0.1", owningProcess: app.pid }];
    },
    inspect: async (pid) => (pid === POSTMASTER.pid ? identity(pid, POSTMASTER.creationTime) : identity(pid, `app-${pid}`)),
    children: async () => [],
  };

  const superuser: SuperuserOps = {
    createDatabase: async () => void w.events.push("create-database"),
    migrate: async () => void w.events.push("migrate"),
    loadFixtures: async () => void w.events.push("fixtures"),
    verifyStoredStates: async () => {
      w.events.push("verify-stored");
      return w.events.includes("start:E-A2") ? w.storedAfter : [];
    },
    systemIdentifier: async () => SYSTEM_IDENTIFIER,
    dataDirectory: async () => w.dataDirectory,
    run: async (statements) => void w.events.push(`role-setup:${statements.length}`),
    setMarker: async (marker) => void w.events.push(`marker:${marker === SECRETS.marker ? "run" : "changed"}`),
    terminateAppSessions: async () => {
      w.events.push("terminate");
      if (w.terminateFails === true) throw new Error("the app sessions did not end");
      currentPhase = "E-A4b";
    },
  };

  return {
    prepareWorktree: async () => void w.events.push("worktree"),
    build: async (environment) => {
      w.events.push(`build:${Object.keys(environment).sort().join(",")}`);
      if (w.buildFails) throw new Error("next build exited 1");
    },
    withCluster: async (body) => {
      w.events.push("cluster:create");
      try {
        return await body({
          port: DB_PORT,
          postmaster: POSTMASTER,
          clusterDirectory: CLUSTER_DIRECTORY,
          connectSuperuser: () => {
            w.events.push("superuser:connect");
            return w.superuser?.() ?? superuser;
          },
        });
      } finally {
        w.events.push("cluster:shutdown");
      }
    },
    startApp: async (phase, environment) => {
      const port = (nextPort += 1);
      apps.set(port, { phase, pid: port + 1 });
      currentPhase = phase;
      w.events.push(`start:${phase}:${environment.BI4_E3_LOCAL ?? "absent"}`);
      w.events.push(`start:${phase}`);
      const app: AppServer = {
        port,
        server: { pid: port + 1, creationTime: `app-${port + 1}` },
        stop: async () => {
          w.events.push(`stop:${phase}`);
          if (w.stopUnresolved === phase) throw new E3Stop(`Stopped (phase shutdown unresolved): ${phase}'s exit could not be confirmed`);
          apps.delete(port);
        },
      };
      return app;
    },
    send: async (port, method, path) => {
      const phase = path === "/" ? (apps.get(port)?.phase ?? "?") : (currentPhase ?? "?");
      w.sent.push({ phase, method, path });
      return w.respond(phase as E3Phase, method, path);
    },
    inspections,
    scanItems: async () => w.scan,
    fixtures: FIXTURES,
    secrets: SECRETS,
    sleep: async () => {},
    now: Date.now,
    signal: new AbortController().signal,
    note: () => {},
  };
}

/* =========================================================================================== */

describe("the request plan", () => {
  it("fits the 60-attempt cap with readiness for three servers", () => {
    const total = (["E-A2", "E-A3", "E-A4", "E-A4b"] as const).reduce((n, phase) => n + e3Requests(phase, FIXTURES).length, 0);
    expect(E3_REQUEST_CAP).toBe(60);
    expect(total + 3).toBeLessThanOrEqual(60);
  });

  it("sends the public control first and last in E-A4, so a refusal in between shows", () => {
    const labels = e3Requests("E-A4", FIXTURES).filter((r) => r.path.startsWith("/directory/") && r.path !== "/directory/").map((r) => r.expect.kind);
    expect(labels[0]).toBe("public");
    expect(labels[labels.length - 1]).toBe("public");
  });

  it("gives E-A2 every value but the flag, E-A3 a wrong identifier, and E-A4 the verified set", () => {
    const values = { url: appDatabaseUrl(SECRETS, DB_PORT), systemIdentifier: SYSTEM_IDENTIFIER, marker: SECRETS.marker };
    expect(phaseEnvironment("E-A2", values).BI4_E3_LOCAL).toBeUndefined();
    expect(phaseEnvironment("E-A3", values)).toMatchObject({ BI4_E3_LOCAL: "1", BI4_E3_EXPECTED_SYSTEM_IDENTIFIER: "1" });
    expect(phaseEnvironment("E-A3", { ...values, systemIdentifier: "1" }).BI4_E3_EXPECTED_SYSTEM_IDENTIFIER).toBe("2");
    expect(phaseEnvironment("E-A4", values)).toEqual({
      BI4_E3_LOCAL: "1",
      BI4_E3_DATABASE_URL: `postgresql://${SECRETS.role}:${SECRETS.password}@127.0.0.1:${DB_PORT}/${E3_DATABASE}`,
      BI4_E3_EXPECTED_SYSTEM_IDENTIFIER: SYSTEM_IDENTIFIER,
      BI4_E3_EXPECTED_DATABASE: E3_DATABASE,
      BI4_E3_SYNTHETIC_MARKER: SECRETS.marker,
    });
  });

  it("refuses a build environment carrying a mode variable or a database URL", () => {
    expect(buildEnvironmentProblems(BUILD_ENVIRONMENT)).toEqual([]);
    expect(buildEnvironmentProblems({ ...BUILD_ENVIRONMENT, BI4_E3_LOCAL: "1" })).toHaveLength(1);
    expect(buildEnvironmentProblems({ ...BUILD_ENVIRONMENT, LOCAL_DEMO_DATABASE_URL: "x" })).toHaveLength(1);
    expect(buildEnvironmentProblems({ ...BUILD_ENVIRONMENT, OTHER: "postgresql://a@127.0.0.1/x" })).toHaveLength(1);
  });
});

describe("L-3: the database listener rule", () => {
  const pm = POSTMASTER.pid;

  it("accepts loopback entries all owned by the postmaster, with at least one on 127.0.0.1", () => {
    expect(databaseListenerProblems([{ localAddress: "127.0.0.1", owningProcess: pm }], pm)).toEqual([]);
    expect(databaseListenerProblems([{ localAddress: "127.0.0.1", owningProcess: pm }, { localAddress: "::1", owningProcess: pm }], pm)).toEqual([]);
  });

  it("refuses a foreign owner, a non-loopback address, no 127.0.0.1 entry, or no entry", () => {
    expect(databaseListenerProblems([{ localAddress: "127.0.0.1", owningProcess: 999 }], pm)).toHaveLength(1);
    expect(databaseListenerProblems([{ localAddress: "127.0.0.1", owningProcess: pm }, { localAddress: "::1", owningProcess: 999 }], pm)).toHaveLength(1);
    expect(databaseListenerProblems([{ localAddress: "127.0.0.1", owningProcess: pm }, { localAddress: "0.0.0.0", owningProcess: pm }], pm)).toHaveLength(1);
    expect(databaseListenerProblems([{ localAddress: "::1", owningProcess: pm }], pm)).toEqual(["no entry is bound to 127.0.0.1"]);
    expect(databaseListenerProblems([], pm)).toHaveLength(1);
  });

  it("stops on a failed lookup or a replaced postmaster", async () => {
    const base: E3Inspections = { lookup: async () => [{ localAddress: "127.0.0.1", owningProcess: POSTMASTER.pid }], inspect: async (pid) => identity(pid, POSTMASTER.creationTime), children: async () => [] };
    await expect(verifyDatabaseListener(DB_PORT, POSTMASTER, base, "t")).resolves.toBeUndefined();
    await expect(verifyDatabaseListener(DB_PORT, POSTMASTER, { ...base, lookup: async () => Promise.reject(new Error("CIM failed")) }, "t")).rejects.toBeInstanceOf(E3Stop);
    await expect(verifyDatabaseListener(DB_PORT, POSTMASTER, { ...base, inspect: async (pid) => identity(pid, "other") }, "t")).rejects.toThrow(/gone or was replaced/);
    await expect(verifyDatabaseListener(DB_PORT, POSTMASTER, { ...base, inspect: async () => undefined }, "t")).rejects.toThrow(/gone or was replaced/);
  });
});

describe("the app listener rule", () => {
  const server = { pid: 7, creationTime: "s" };
  const base: E3Inspections = { lookup: async () => [{ localAddress: "127.0.0.1", owningProcess: 7 }], inspect: async (pid) => identity(pid, "s"), children: async () => [] };

  it("accepts one 127.0.0.1 entry owned by the server or a descendant", async () => {
    expect(await checkAppListener(1, server, base)).toBe(7);
    expect(await checkAppListener(1, server, { ...base, lookup: async () => [{ localAddress: "127.0.0.1", owningProcess: 8 }], children: async (pid) => (pid === 7 ? [identity(8, "c")] : []) })).toBe(8);
    expect(await checkAppListener(1, server, { ...base, lookup: async () => [] })).toBe("unbound");
  });

  it("refuses several entries, another address, or a foreign owner", async () => {
    await expect(checkAppListener(1, server, { ...base, lookup: async () => [{ localAddress: "127.0.0.1", owningProcess: 7 }, { localAddress: "::1", owningProcess: 7 }] })).rejects.toBeInstanceOf(E3Stop);
    await expect(checkAppListener(1, server, { ...base, lookup: async () => [{ localAddress: "0.0.0.0", owningProcess: 7 }] })).rejects.toBeInstanceOf(E3Stop);
    await expect(checkAppListener(1, server, { ...base, lookup: async () => [{ localAddress: "127.0.0.1", owningProcess: 99 }] })).rejects.toBeInstanceOf(E3Stop);
  });
});

describe("E-O1: order, listener-first, rechecks", () => {
  it("passes a healthy run in the approved order, with no superuser SQL before L-3", async () => {
    const w = world();
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.stops).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.acceptancePassed).toBe(true);

    const at = (event: string): number => w.events.indexOf(event);
    expect(at("worktree")).toBe(0);
    expect(at(`build:${Object.keys(BUILD_ENVIRONMENT).sort().join(",")}`)).toBe(1);
    expect(at("cluster:create")).toBe(2);
    expect(at("lookup:db")).toBe(3);
    expect(at("superuser:connect")).toBe(4);
    // L-4's first network SQL is the database creation, after L-3; migrations follow it.
    expect(at("create-database")).toBe(5);
    expect(at("migrate")).toBe(6);
    expect(at("start:E-A2")).toBeGreaterThan(at("role-setup:7"));
    expect(w.events).toContain("start:E-A2:absent");
    expect(w.events).toContain("start:E-A3:1");
    expect(w.events).toContain("start:E-A4:1");
    expect(at("terminate")).toBeGreaterThan(at("start:E-A4"));
    expect(at("stop:E-A4")).toBeGreaterThan(at("terminate"));
    expect(w.events.lastIndexOf("verify-stored")).toBeGreaterThan(at("stop:E-A4"));
    expect(at("cluster:shutdown")).toBe(w.events.length - 1);

    // L-3, then per phase: before start, handoff, after the last request; and after E-A4b.
    expect(w.events.filter((e) => e === "lookup:db")).toHaveLength(1 + 3 * 3 + 1);
  });

  for (const [label, entries] of [
    ["a foreign owner", [{ localAddress: "127.0.0.1", owningProcess: 999 }]],
    ["a non-loopback address", [{ localAddress: "127.0.0.1", owningProcess: POSTMASTER.pid }, { localAddress: "192.168.1.5", owningProcess: POSTMASTER.pid }]],
    ["no 127.0.0.1 entry", [{ localAddress: "::1", owningProcess: POSTMASTER.pid }]],
  ] as const) {
    it(`stops before any SQL or server on ${label}`, async () => {
      const w = world();
      w.dbEntries = () => entries;
      const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

      expect(report.acceptancePassed).toBe(false);
      expect(report.stops[0]).toMatch(/^Stopped \(database listener, L-3/);
      expect(w.events).not.toContain("superuser:connect");
      expect(w.events.some((e) => e.startsWith("start:"))).toBe(false);
      expect(w.sent).toEqual([]);
      expect(w.events).toContain("cluster:shutdown");
    });
  }

  it("stops, and stops the server, when a recheck fails mid-run", async () => {
    const w = world();
    let lookups = 0;
    w.dbEntries = () => ((lookups += 1) >= 5 ? [{ localAddress: "127.0.0.1", owningProcess: 999 }] : world().dbEntries());
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.acceptancePassed).toBe(false);
    expect(report.stops[0]).toMatch(/database listener/);
    const started = w.events.filter((e) => /^start:E-A\d$/.test(e)).map((e) => e.slice(6));
    for (const phase of started) expect(w.events).toContain(`stop:${phase}`);
  });

  it("stops before the cluster when the build fails, and still scans nothing it did not build", async () => {
    const w = world();
    w.buildFails = true;
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.stops[0]).toMatch(/next build exited 1/);
    expect(w.events).not.toContain("cluster:create");
    expect(report.scans).toBeUndefined();
    expect(report.acceptancePassed).toBe(false);
  });

  it("stops when the server's data_directory is not the created cluster directory", async () => {
    const w = world();
    w.dataDirectory = "D:/somewhere/else";
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.stops[0]).toMatch(/data_directory/);
    expect(w.events.some((e) => e.startsWith("start:"))).toBe(false);
  });

  it("refuses a build environment with a mode variable before preparing anything", async () => {
    const w = world();
    const report = await runE3Check(seamsFor(w), { ...BUILD_ENVIRONMENT, BI4_E3_DATABASE_URL: "x" });

    expect(report.stops[0]).toMatch(/build environment/);
    expect(w.events).toEqual([]);
  });
});

describe("E-O2: the 60-attempt cap, readiness and failures included", () => {
  it("never sends a 61st attempt when readiness never succeeds", async () => {
    const w = world();
    w.respond = (phase, method, path) => (path === "/" ? exchange(503, "starting") : healthy(phase, method, path));
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(w.sent).toHaveLength(60);
    expect(report.attempts).toHaveLength(60);
    expect(report.stops[0]).toMatch(/^Stopped \(cap\)/);
    expect(report.acceptancePassed).toBe(false);
  });

  it("charges transport failures too", async () => {
    const w = world();
    const seams = seamsFor(w);
    let failures = 0;
    const report = await runE3Check(
      {
        ...seams,
        send: async (port, method, path) => {
          if (path === "/" && failures < 2) {
            failures += 1;
            w.sent.push({ phase: "?", method, path });
            throw new Error("ECONNREFUSED");
          }
          return seams.send(port, method, path);
        },
      },
      BUILD_ENVIRONMENT,
    );

    expect(report.attempts.filter((a) => a.outcome === "ECONNREFUSED")).toHaveLength(2);
    expect(report.attempts.length).toBe(w.sent.length);
    expect(report.acceptancePassed).toBe(true);
  });
});

describe("E-O3: comparison rules", () => {
  const runWith = async (respond: World["respond"]) => {
    const w = world();
    w.respond = respond;
    return runE3Check(seamsFor(w), BUILD_ENVIRONMENT);
  };

  it("fails E-A4 on any unmasked per-request value in a body", async () => {
    let n = 0;
    const report = await runWith((phase, method, path) => {
      const base = healthy(phase, method, path);
      return phase === "E-A4" && path === `/directory/${FIXTURES.pending}` ? { ...base, body: Buffer.concat([base.body, Buffer.from(`<!-- ${(n += 1)} -->`)]) } : base;
    });
    expect(report.acceptancePassed).toBe(false);
    expect(report.problems.some((p) => /S2 pending: masked body differs/.test(p))).toBe(true);
  });

  it("fails E-A4 on a header difference other than Date", async () => {
    const report = await runWith((phase, method, path) => {
      const base = healthy(phase, method, path);
      return phase === "E-A4" && path === `/directory/${FIXTURES.rejected}` ? { ...base, rawHeaders: [...base.rawHeaders, "X-Extra", "1"] } : base;
    });
    expect(report.problems.some((p) => /S2 rejected: header comparison list differs/.test(p))).toBe(true);
  });

  it("removes only Date: a different Date alone does not fail the comparison", async () => {
    const report = await runWith((phase, method, path) => {
      const base = healthy(phase, method, path);
      if (phase !== "E-A4" || path !== `/directory/${FIXTURES.unpublished}`) return base;
      const later = Date.now() + 1_000;
      return { ...base, rawHeaders: ["Date", new Date(later).toUTCString(), ...base.rawHeaders.slice(2)], responseEndMs: later };
    });
    expect(report.problems).toEqual([]);
  });

  it("fails on an implausible Date", async () => {
    const report = await runWith((phase, method, path) => {
      const base = healthy(phase, method, path);
      return phase === "E-A4" && path === `/directory/${FIXTURES.pending}` ? { ...base, rawHeaders: ["Date", "Mon, 01 Jan 2001 00:00:00 GMT", ...base.rawHeaders.slice(2)] } : base;
    });
    expect(report.problems.some((p) => /S2 pending: Date failed/.test(p))).toBe(true);
  });

  it("judges the malformed control on its own rules: fixture text or a fixture identity fails it", async () => {
    for (const leak of ["Kinsale", FIXTURES.pending, "Something went wrong"]) {
      const report = await runWith((phase, method, path) =>
        phase === "E-A4" && path === `/directory/${FIXTURES.malformed}` ? exchange(200, `<h1>Not available</h1>${leak}`) : healthy(phase, method, path),
      );
      expect(report.problems.some((p) => /S2 malformed/.test(p)), leak).toBe(true);
    }
  });

  it("does not require the malformed body to equal the never-existed body", async () => {
    const report = await runWith((phase, method, path) =>
      phase === "E-A4" && path === `/directory/${FIXTURES.malformed}` ? exchange(200, "<h1>Not available</h1><p>different shell</p>") : healthy(phase, method, path),
    );
    expect(report.problems).toEqual([]);
  });

  it("fails when the positive control shows no difference from never-existed", async () => {
    const report = await runWith((phase, method, path) =>
      phase === "E-A4" && path === `/directory/${FIXTURES.publiclyAvailable}` ? exchange(200, notAvailable(FIXTURES.publiclyAvailable)) : healthy(phase, method, path),
    );
    expect(report.acceptancePassed).toBe(false);
    expect(report.problems.some((p) => /positive control|public listing/.test(p))).toBe(true);
  });

  it("S-7: a generic 200 from a refusal during the normal sequence fails the run", async () => {
    // The last public control renders the generic content, as a mid-sequence refusal would.
    let publicRequests = 0;
    const report = await runWith((phase, method, path) => {
      if (phase === "E-A4" && path === `/directory/${FIXTURES.publiclyAvailable}` && (publicRequests += 1) === 2) return exchange(200, notAvailable(FIXTURES.publiclyAvailable));
      return healthy(phase, method, path);
    });
    expect(report.acceptancePassed).toBe(false);
    expect(report.problems.some((p) => /S2 public \(control, last\)/.test(p))).toBe(true);
  });

  it("fails when /directory under E3-local is not the proxy's plain 404, or S1 content appears in a variant", async () => {
    const plain = await runWith((phase, method, path) => (phase === "E-A4" && path === "/directory" ? exchange(404, "<html>404</html>") : healthy(phase, method, path)));
    expect(plain.problems.some((p) => /plain-text Not Found/.test(p))).toBe(true);

    const variant = await runWith((phase, method, path) => (phase === "E-A4" && path === "/Directory" ? exchange(200, "<h1>Directory</h1>") : healthy(phase, method, path)));
    expect(variant.problems.some((p) => /S1 content was exposed/.test(p))).toBe(true);
  });

  it("records case and encoding variants without judging their status", async () => {
    const report = await runWith((phase, method, path) => (phase === "E-A4" && path === "/%64irectory" ? exchange(400, "bad request") : healthy(phase, method, path)));
    expect(report.problems).toEqual([]);
    const record = report.phases.find((p) => p.phase === "E-A4")?.requests.find((r) => r.path === "/%64irectory");
    expect(record?.status).toBe(400);
  });

  it("fails when the trailing-slash redirect or the admin headers change", async () => {
    const redirect = await runWith((phase, method, path) => (path === "/directory/" ? exchange(404, "x") : healthy(phase, method, path)));
    expect(redirect.problems.some((p) => /status 404, expected 308/.test(p))).toBe(true);

    const admin = await runWith((phase, method, path) => (path === "/admin" && method === "GET" ? exchange(404, "x", ["Cache-Control", "no-store"]) : healthy(phase, method, path)));
    expect(admin.problems.some((p) => /admin header x-frame-options/.test(p))).toBe(true);

    const leaked = await runWith((phase, method, path) => (path === "/directory" ? { ...healthy(phase, method, path), rawHeaders: [...healthy(phase, method, path).rawHeaders, "X-Frame-Options", "DENY"] } : healthy(phase, method, path)));
    expect(leaked.problems.some((p) => /admin header \(x-frame-options\) was applied to \/directory/.test(p))).toBe(true);
  });

  it("fails when the triggering E-A3 request is not a 404", async () => {
    const report = await runWith((phase, method, path) => (phase === "E-A3" && path === `/directory/${FIXTURES.neverExisted[0]}` ? exchange(200, notAvailable(FIXTURES.neverExisted[0])) : healthy(phase, method, path)));
    expect(report.problems.some((p) => /E-A3 S2 never-existed \(triggering request\): status 200, expected 404/.test(p))).toBe(true);
  });

  it("compares nothing when there is no equivalence set, and says so", () => {
    expect(compareE3Equivalence([]).problems).toContain("the equivalence set has no NE member");
  });
});

describe("E-A4b: its own pass or fail, separate from normal acceptance", () => {
  it("FAILS E-A4b, and keeps the normal run passing, when the injected requests do not answer 404", async () => {
    const w = world();
    w.respond = (phase, method, path) => (phase === "E-A4b" ? exchange(200, notAvailable("x")) : healthy(phase, method, path));
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.acceptancePassed).toBe(true);
    expect(report.faultInjection?.result).toBe("fail");
    expect(report.faultInjection?.observed.map((o) => o.status)).toEqual([200, 200]);
    const markdown = renderE3Report(report, {});
    expect(markdown).toMatch(/Normal acceptance:\*\* PASSED/);
    expect(markdown).toMatch(/## E-A4b fault injection: FAIL/);
    expect(markdown).toMatch(/never changes the normal acceptance result/);
    expect(e3ConsoleLines(report, [])).toContain("E-A4b fault injection (separate from normal acceptance): FAIL; observed 200, 200");
  });

  it("PASSES E-A4b when both injected requests answer 404", async () => {
    const report = await runE3Check(seamsFor(world()), BUILD_ENVIRONMENT);
    expect(report.faultInjection).toEqual({ result: "pass", observed: [{ label: expect.any(String), status: 404 }, { label: expect.any(String), status: 404 }], problems: [] });
    expect(renderE3Report(report, {})).toMatch(/## E-A4b fault injection: PASS/);
    expect(e3ConsoleLines(report, [])).toContain("E-A4b fault injection (separate from normal acceptance): PASS; observed 404, 404");
  });

  it("FAILS E-A4b, without failing normal acceptance, when the injection itself cannot complete", async () => {
    const w = world();
    w.terminateFails = true;
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.acceptancePassed).toBe(true);
    expect(report.faultInjection?.result).toBe("fail");
    expect(report.faultInjection?.problems.some((p) => /did not complete: the app sessions did not end/.test(p))).toBe(true);
    expect(report.faultInjection?.problems.some((p) => /0 of 2 injected requests/.test(p))).toBe(true);
  });

  it("reports NOT RUN when the run stopped before E-A4b", async () => {
    const w = world();
    w.buildFails = true;
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);
    expect(report.faultInjection).toBeUndefined();
    expect(renderE3Report(report, {})).toMatch(/## E-A4b fault injection: NOT RUN/);
    expect(e3ConsoleLines(report, [])).toContain("E-A4b fault injection (separate from normal acceptance): NOT RUN");
  });
});

describe("E-O4: leak scans, and secrets never reach the report", () => {
  const plant = async (where: "static" | "build" | "log" | "response", value: string) => {
    const w = world();
    if (where === "static") w.scan.staticAssets.push({ where: ".next/static/chunks/b.js", bytes: Buffer.from(`x=${JSON.stringify(value)}`) });
    if (where === "build") w.scan.otherBuildFiles.push({ where: ".next/server/app.js", bytes: Buffer.from(value) });
    if (where === "log") w.scan.logs.push({ where: "next-start-E-A4.err.log", bytes: Buffer.from(`error: ${value}`) });
    if (where === "response") w.respond = (phase, method, path) => (path === "/admin" && method === "GET" ? { ...healthy(phase, method, path), rawHeaders: [...healthy(phase, method, path).rawHeaders, "X-Debug", value] } : healthy(phase, method, path));
    return runE3Check(seamsFor(w), BUILD_ENVIRONMENT);
  };

  for (const where of ["static", "build", "log", "response"] as const) {
    it(`fails on a planted password in ${where}`, async () => {
      const report = await plant(where, SECRETS.password);
      expect(report.acceptancePassed).toBe(false);
      expect(report.scans?.leakHits.some((hit) => hit.label === "app role password")).toBe(true);
    });
  }

  it("fails on the URL, the marker, the system identifier or the data directory", async () => {
    for (const [value, label] of [
      [appDatabaseUrl(SECRETS, DB_PORT), "app database URL"],
      [SECRETS.marker, "synthetic marker"],
      [SYSTEM_IDENTIFIER, "system identifier"],
      [CLUSTER_DIRECTORY.replace(/\\/g, "/"), "data directory"],
    ] as const) {
      const report = await plant("log", value);
      expect(report.scans?.leakHits.some((hit) => hit.label === label), label).toBe(true);
    }
  });

  it("fails when a client asset names a mode variable, even without a value", async () => {
    const report = await plant("static", "BI4_E3_LOCAL");
    expect(report.scans?.staticPrefixHits).toEqual([".next/static/chunks/b.js"]);
    expect(report.acceptancePassed).toBe(false);
  });

  it("matches the percent-encoded spelling of a value too", () => {
    expect(leakHits([{ where: "x", bytes: Buffer.from(encodeURIComponent("a b/c")) }], [{ label: "v", value: "a b/c" }])).toEqual([{ where: "x", label: "v" }]);
    expect(prefixHits([{ where: "y", bytes: Buffer.from("nothing") }])).toEqual([]);
  });

  it("never writes the password or the URL into the report, in JSON or Markdown", async () => {
    const report = await plant("log", SECRETS.password);
    const text = `${JSON.stringify(report)}\n${renderE3Report(report, { commit: "abc" })}`;
    expect(text).not.toContain(SECRETS.password);
    expect(text).not.toContain(appDatabaseUrl(SECRETS, DB_PORT));
  });
});

/* =========================================================================================== */
/* Corrections: helper request, bootstrap, phase stops, residue, redaction                        */
/* =========================================================================================== */

/** A Kysely instance whose only connection records each statement, for the superuser unit tests. */
function recordingConnection(log: string[], label: string, fails?: (statement: string) => boolean): SuperuserConnection {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      log.push(`${label}:${query.sql}`);
      if (fails?.(query.sql) === true) throw new Error(`database "${E3_DATABASE}" already exists`);
      return { rows: [] };
    },
    streamQuery: (() => {
      throw new Error("not used");
    }) as DatabaseConnection["streamQuery"],
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => {
      log.push(`${label}:open`);
      return connection;
    },
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<ListingDatabase>({
    dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() },
  });
  return { db, shutdown: async () => void log.push(`${label}:shutdown`) };
}

function recordingDeps(log: string[], registered: string[], options: { readonly urlFor?: (database: string) => string; readonly createFails?: boolean } = {}): SuperuserDeps {
  return {
    port: DB_PORT,
    urlFor: options.urlFor ?? ((database) => `postgresql://postgres:verification-only@127.0.0.1:${DB_PORT}/${database}`),
    connect: (url, applicationName) => {
      const parsed = new URL(url);
      const database = parsed.pathname.slice(1);
      log.push(`connect:${parsed.hostname}:${parsed.port}/${database}:${applicationName}`);
      return recordingConnection(log, database, options.createFails === true ? (s) => /^create database/.test(s) : undefined);
    },
    register: (label) => void registered.push(label),
    migrate: async (url) => void log.push(`migrate:${new URL(url).pathname.slice(1)}`),
    sleep: async () => {},
    now: Date.now,
  };
}

describe("the cluster helper request (L-1)", () => {
  it("asks the helper for no database and no migration", () => {
    expect(E3_CLUSTER_REQUEST).toEqual({ slug: "bi4-e3", databases: [] });
    expect("migrate" in E3_CLUSTER_REQUEST).toBe(false);
    expect(Object.isFrozen(E3_CLUSTER_REQUEST)).toBe(true);
    expect(Object.isFrozen(E3_CLUSTER_REQUEST.databases)).toBe(true);
  });

  it("is the request cli.ts passes to withEmbeddedPostgres, its only call for e3-check", () => {
    const source = readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");
    const e3Section = source.slice(source.indexOf("// e3-check (E3-local Scope Gate revision 4)"));
    expect(e3Section.match(/withEmbeddedPostgres\(/g)).toHaveLength(1);
    expect(e3Section).toContain("withEmbeddedPostgres(E3_CLUSTER_REQUEST,");
    expect(e3Section).not.toMatch(/databases:\s*\[E3_DATABASE\]/);
  });
});

describe("L-4: the superuser bootstrap over 127.0.0.1", () => {
  it("opens and registers nothing when constructed", () => {
    const log: string[] = [];
    const registered: string[] = [];
    void createE3SuperuserOps(recordingDeps(log, registered));
    expect(log).toEqual([]);
    expect(registered).toEqual([]);
  });

  it("creates bi4_e3 over a bootstrap connection to postgres at 127.0.0.1 on the owned port, then closes it", async () => {
    const log: string[] = [];
    const registered: string[] = [];
    const ops = createE3SuperuserOps(recordingDeps(log, registered));

    await ops.createDatabase();
    expect(log).toEqual([`connect:127.0.0.1:${DB_PORT}/postgres:bi4_e3_bootstrap`, "postgres:open", 'postgres:create database "bi4_e3"', "postgres:shutdown"]);
    expect(registered).toEqual(["e3 bootstrap connection"]);

    // Everything after it uses bi4_e3, on a separate connection opened only then.
    await ops.migrate();
    await ops.setMarker(SECRETS.marker);
    expect(log.slice(4)).toEqual([
      "migrate:bi4_e3",
      `connect:127.0.0.1:${DB_PORT}/bi4_e3:bi4_e3_superuser`,
      "bi4_e3:open",
      `bi4_e3:comment on database "bi4_e3" is '${SECRETS.marker}'`,
    ]);
    expect(registered).toEqual(["e3 bootstrap connection", "e3 superuser connection"]);
  });

  it("closes the bootstrap connection even when the creation fails", async () => {
    const log: string[] = [];
    const ops = createE3SuperuserOps(recordingDeps(log, [], { createFails: true }));

    await expect(ops.createDatabase()).rejects.toThrow(/already exists/);
    expect(log[log.length - 1]).toBe("postgres:shutdown");
  });

  it("refuses a superuser target that is not 127.0.0.1 on the owned port, before connecting", async () => {
    for (const urlFor of [
      (database: string) => `postgresql://postgres:verification-only@localhost:${DB_PORT}/${database}`,
      (database: string) => `postgresql://postgres:verification-only@127.0.0.1:${DB_PORT + 1}/${database}`,
      (database: string) => `postgresql://postgres:verification-only@127.0.0.1:${DB_PORT}/${database}?host=10.0.0.5`,
      () => `postgresql://postgres:verification-only@127.0.0.1:${DB_PORT}/other`,
    ]) {
      const log: string[] = [];
      await expect(createE3SuperuserOps(recordingDeps(log, [], { urlFor })).createDatabase()).rejects.toBeInstanceOf(E3Stop);
      expect(log).toEqual([]);
    }
    expect(loopbackTargetProblems(`postgresql://u:p@127.0.0.1:${DB_PORT}/postgres`, DB_PORT, "postgres")).toEqual([]);
  });

  it("sends zero network SQL, cleanup included, when L-3 fails", async () => {
    const w = world();
    const log: string[] = [];
    w.superuser = () => createE3SuperuserOps(recordingDeps(log, w.registered));
    w.dbEntries = () => [{ localAddress: "127.0.0.1", owningProcess: 999 }];
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.stops[0]).toMatch(/^Stopped \(database listener, L-3, before any network SQL\)/);
    expect(w.events).toContain("cluster:shutdown");
    // Nothing connected, nothing sent, and nothing registered for the helper's cleanup to close;
    // the helper itself was asked for no database, and its cleanup is `pg_ctl stop`.
    expect(w.events).not.toContain("superuser:connect");
    expect(log).toEqual([]);
    expect(w.registered).toEqual([]);
  });
});

describe("the real cluster helper, started with E3_CLUSTER_REQUEST", () => {
  const cluster = useEmbeddedPostgres({ slug: E3_CLUSTER_REQUEST.slug, databases: [...E3_CLUSTER_REQUEST.databases] });

  it("enters the callback with no database created; the bootstrap creates bi4_e3 over 127.0.0.1 and closes", async () => {
    const observer = createListingPersistence({ pool: { connectionString: cluster.connectionStringFor(BOOTSTRAP_DATABASE), max: 1 }, startupParameters: { application_name: "e3_test_observer" } });
    const databases = async (): Promise<string[]> => (await sql<{ datname: string }>`select datname from pg_database order by 1`.execute(observer.db)).rows.map((row) => row.datname);
    const bootstrapSessions = async (): Promise<number> =>
      Number(((await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity where application_name = ${BOOTSTRAP_APPLICATION_NAME}`.execute(observer.db)).rows[0] as { n: string }).n);
    const untilNoBootstrap = async (): Promise<void> => {
      for (let i = 0; i < 100 && (await bootstrapSessions()) > 0; i += 1) await new Promise((resume) => setTimeout(resume, 100));
      expect(await bootstrapSessions()).toBe(0);
    };

    try {
      // The helper created nothing beyond initdb's own databases.
      expect(await databases()).toEqual(["postgres", "template0", "template1"]);

      const ops = createE3SuperuserOps({
        port: cluster.port,
        urlFor: (database) => cluster.connectionStringFor(database),
        connect: (url, applicationName) => createListingPersistence({ pool: { connectionString: url, max: 1 }, startupParameters: { application_name: applicationName } }),
        register: (label, close) => cluster.closeBeforeShutdown(label, close),
        migrate: applyGovernedMigration,
        sleep: (ms) => new Promise((resume) => setTimeout(resume, ms)),
        now: Date.now,
      });

      await ops.createDatabase();
      expect(await databases()).toContain(E3_DATABASE);
      await untilNoBootstrap();

      await ops.migrate();
      await ops.loadFixtures(FIXTURES);
      expect(await ops.verifyStoredStates(FIXTURES)).toEqual([]);
      expect((await ops.dataDirectory()).replace(/\\/g, "/").toLowerCase()).toBe(cluster.clusterDirectory.replace(/\\/g, "/").toLowerCase());

      // A failed creation still closes its bootstrap connection.
      await expect(ops.createDatabase()).rejects.toThrow(/already exists/);
      await untilNoBootstrap();
    } finally {
      await observer.shutdown();
    }
  }, CLUSTER_TIMEOUT_MS);
});

describe("stopping a phase's server with full identity checks", () => {
  const EXE = "C:\\node\\node.exe";
  const full = (pid: number, creationTime: string, commandLine = `node next start ${pid}`): ProcessIdentity => ({ pid, parentPid: 1, creationTime, executable: EXE, commandLine });

  function tree(overrides: { live?: Map<number, ProcessIdentity | "throws">; recordFails?: boolean; neverExits?: boolean } = {}) {
    const entries: ResourceEntry[] = [
      { id: 0, kind: "process", label: "next start E-A2", state: "created", identity: full(100, "1000") },
      { id: 1, kind: "process", label: "next start E-A2 descendant 101", state: "created", identity: full(101, "1001"), parentEntry: 0 },
      { id: 2, kind: "process", label: "unrelated", state: "created", identity: full(200, "2000") },
    ];
    const alive = new Map<number, ProcessIdentity | "throws">(
      overrides.live ?? [
        [100, full(100, "1000")],
        [101, full(101, "1001")],
        [200, full(200, "2000")],
      ],
    );
    const stops: number[] = [];
    const inspected: number[] = [];
    const deps: PhaseStopDeps = {
      entries: () => entries,
      update: (id, patch) => {
        entries[id] = { ...(entries[id] as ResourceEntry), ...patch };
      },
      recordDescendants: async () => {
        if (overrides.recordFails === true) throw new Error("CIM query failed");
      },
      inspect: async (pid) => {
        inspected.push(pid);
        const live = alive.get(pid);
        if (live === "throws") throw new Error("inspection failed");
        return live;
      },
      stop: async (pid) => {
        stops.push(pid);
        if (overrides.neverExits !== true) alive.delete(pid);
      },
      sleep: async () => {},
      exitPolls: 3,
      exitPollMs: 1,
    };
    return { entries, stops, inspected, deps };
  }

  it("stops the verified tree deepest first, never touching an unrelated entry", async () => {
    const t = tree();
    await stopPhaseServer(0, t.deps);
    expect(t.stops).toEqual([101, 100]);
    expect(t.entries.map((e) => e.state)).toEqual(["stopped", "stopped", "created"]);
  });

  it("never sends a stop on an identity mismatch, and leaves the run unresolved", async () => {
    const t = tree({ live: new Map([[100, full(100, "1000")], [101, full(101, "1001", "something else")], [200, full(200, "2000")]]) });
    await expect(stopPhaseServer(0, t.deps)).rejects.toThrow(/phase shutdown unresolved.*command line differs/);
    expect(t.stops).not.toContain(101);
    expect(t.entries[1]?.state).toBe("created");
  });

  it("never sends a stop when the live identity lacks its command line", async () => {
    const t = tree({ live: new Map<number, ProcessIdentity>([[100, { ...full(100, "1000"), commandLine: null }], [101, full(101, "1001")]]) });
    await expect(stopPhaseServer(0, t.deps)).rejects.toBeInstanceOf(E3Stop);
    expect(t.stops).not.toContain(100);
  });

  it("treats a failed inspection as unresolved, with no stop for that process", async () => {
    const t = tree({ live: new Map<number, ProcessIdentity | "throws">([[100, "throws"], [101, full(101, "1001")]]) });
    await expect(stopPhaseServer(0, t.deps)).rejects.toThrow(/could not be inspected/);
    expect(t.stops).toEqual([101]);
  });

  it("stops nothing and inspects nothing when recording descendants fails", async () => {
    const t = tree({ recordFails: true });
    await expect(stopPhaseServer(0, t.deps)).rejects.toThrow(/recording the server's descendants failed/);
    expect(t.stops).toEqual([]);
    expect(t.inspected).toEqual([]);
    expect(t.entries.map((e) => e.state)).toEqual(["created", "created", "created"]);
  });

  it("is unresolved when an exit cannot be confirmed, and keeps the entry for teardown", async () => {
    const t = tree({ neverExits: true });
    await expect(stopPhaseServer(0, t.deps)).rejects.toThrow(/exit could not be confirmed/);
    expect(t.entries[0]?.state).toBe("created");
  });

  it("records a reused PID as absent and sends no stop", async () => {
    const t = tree({ live: new Map([[100, full(100, "9999")], [101, full(101, "1001")]]) });
    await stopPhaseServer(0, t.deps);
    expect(t.stops).toEqual([101]);
    expect(t.entries[0]?.state).toBe("absent");
  });

  it("never starts the next phase when a phase's shutdown is unresolved", async () => {
    const w = world();
    w.stopUnresolved = "E-A2";
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(w.events).toContain("stop:E-A2");
    expect(w.events.some((e) => e.startsWith("start:E-A3"))).toBe(false);
    expect(report.stops).toEqual(["Stopped (phase shutdown unresolved): E-A2's exit could not be confirmed"]);
    expect(report.acceptancePassed).toBe(false);
    expect(w.events).toContain("cluster:shutdown");
  });

  it("reports both the phase failure and an unresolved shutdown, and starts nothing after", async () => {
    const w = world();
    w.stopUnresolved = "E-A2";
    let lookups = 0;
    w.dbEntries = () => ((lookups += 1) === 3 ? [{ localAddress: "127.0.0.1", owningProcess: 999 }] : world().dbEntries());
    const report = await runE3Check(seamsFor(w), BUILD_ENVIRONMENT);

    expect(report.stops).toHaveLength(2);
    expect(report.stops.some((s) => /phase shutdown unresolved/.test(s))).toBe(true);
    expect(report.stops.some((s) => /database listener, E-A2 handoff/.test(s))).toBe(true);
    expect(w.events.some((e) => e.startsWith("start:E-A3"))).toBe(false);
  });
});

describe("final safety: independent residue checks", () => {
  const clean: TeardownReport = { stopped: [1], removed: [2], absent: [], left: [], allowanceExhausted: false };
  const settled: ResourceEntry[] = [
    { id: 0, kind: "process", label: "next start E-A4", state: "stopped", identity: { pid: 7, parentPid: 1, creationTime: "1", executable: "x", commandLine: "y" }, port: 41_000 },
    { id: 1, kind: "worktree", label: "worktree", state: "removed", path: "C:\\Temp\\cdp-bi4-e3-x\\worktree", adminRecord: "worktree" },
  ];

  it("reports residue the teardown summary alone would miss, and does not claim zero residue", async () => {
    const seen: (readonly ResourceEntry[])[] = [];
    const safety = await e3FinalSafety({
      teardown: async () => clean,
      entries: () => settled,
      residue: async (entries) => {
        seen.push(entries);
        return ["process 7 (next start E-A4) is still alive", "port 41000 (next start E-A4) is not free", "the worktree record worktree remains under .git/worktrees/", "the main tree's git status changed"];
      },
    });
    expect(seen).toEqual([settled]);
    expect(safety.zeroResidue).toBe(false);
    expect(safety.problems).toHaveLength(4);
    expect(safety.problems.every((p) => p.startsWith("residue: "))).toBe(true);
    const report = await runE3Check(seamsFor(world()), BUILD_ENVIRONMENT);
    expect(e3ConsoleLines(report, safety.problems)).toContain("Teardown: NOT clean (4 finding(s))");
  });

  it("does not establish zero residue when the inspection itself fails", async () => {
    const safety = await e3FinalSafety({ teardown: async () => clean, entries: () => settled, residue: async () => Promise.reject(new Error("PowerShell could not be run")) });
    expect(safety.zeroResidue).toBe(false);
    expect(safety.problems).toEqual(["the residue inspection failed, so zero residue is not established: PowerShell could not be run"]);
  });

  it("reports teardown leftovers, unsettled intent-log entries, and a teardown that threw", async () => {
    const leftover = await e3FinalSafety({
      teardown: async () => ({ ...clean, left: [{ id: 3, reason: "worktree removal failed" }], allowanceExhausted: true }),
      entries: () => [...settled, { id: 4, kind: "harness-root", label: "e3 root", state: "created", path: "C:\\Temp\\x" }],
      residue: async () => [],
    });
    expect(leftover.problems).toEqual(["teardown left entry 3: worktree removal failed", "the teardown allowance was exhausted", "the intent log shows e3 root as created"]);
    const threw = await e3FinalSafety({ teardown: async () => Promise.reject(new Error("boom")), entries: () => settled, residue: async () => [] });
    expect(threw.problems).toEqual(["teardown failed: boom"]);
    expect(threw.zeroResidue).toBe(false);
  });

  it("claims zero residue only when every check is empty", async () => {
    expect(await e3FinalSafety({ teardown: async () => clean, entries: () => settled, residue: async () => [] })).toEqual({ teardown: clean, problems: [], zeroResidue: true });
  });
});

describe("redaction of the app-role password and URL", () => {
  const URL_SECRET = appDatabaseUrl(SECRETS, DB_PORT);
  const rendered = (report: Awaited<ReturnType<typeof runE3Check>>): string => `${JSON.stringify(report)}\n${renderE3Report(report, {})}\n${e3ConsoleLines(report, []).join("\n")}`;

  it("keeps both out of a redirect header and an exception, in JSON, Markdown and console output", async () => {
    const w = world();
    w.respond = (phase, method, path) =>
      phase === "E-A4" && path === "/directory/" ? exchange(308, "x", ["Location", `${URL_SECRET}?debug=${SECRETS.password}`]) : healthy(phase, method, path);
    const seams = seamsFor(w);
    const report = await runE3Check(
      {
        ...seams,
        send: async (port, method, path) => {
          if (path === "/Directory") throw new Error(`connect failed for ${URL_SECRET} (password ${SECRETS.password})`);
          return seams.send(port, method, path);
        },
      },
      BUILD_ENVIRONMENT,
    );
    const text = rendered(report);

    expect(text).not.toContain(SECRETS.password);
    expect(text).not.toContain(URL_SECRET);
    expect(text).not.toContain(encodeURIComponent(SECRETS.password));
    // The findings stay useful: the redirect is still reported, with its value redacted.
    expect(report.problems.some((p) => p.includes('/directory/ (trailing slash): Location is ["[redacted]?debug=[redacted]"]'))).toBe(true);
    expect(report.attempts.some((a) => a.outcome === "connect failed for [redacted] (password [redacted])")).toBe(true);
  });

  it("keeps both out of a stop caused by an exception", async () => {
    const w = world();
    const seams = seamsFor(w);
    const report = await runE3Check(
      {
        ...seams,
        startApp: async (phase, environment) => {
          if (phase === "E-A3") throw new Error(`spawn failed with BI4_E3_DATABASE_URL=${environment.BI4_E3_DATABASE_URL}`);
          return seams.startApp(phase, environment);
        },
      },
      BUILD_ENVIRONMENT,
    );
    const text = rendered(report);

    expect(text).not.toContain(SECRETS.password);
    expect(text).not.toContain(URL_SECRET);
    expect(report.stops).toEqual(["Stopped (setup or run): spawn failed with BI4_E3_DATABASE_URL=[redacted]"]);
    expect(e3ConsoleLines(report, [])).toContain("Stopped (setup or run): spawn failed with BI4_E3_DATABASE_URL=[redacted]");
  });

  it("redacts encoded spellings and ignores values too short to be secrets", () => {
    const redact = createRedactor([SECRETS.password, "a b/c?d e1", "short", undefined]);
    expect(redact(`x ${SECRETS.password} y ${encodeURIComponent("a b/c?d e1")} short`)).toBe("x [redacted] y [redacted] short");
    expect(redactDeep({ a: [`k=${SECRETS.password}`], b: 1 }, redact)).toEqual({ a: ["k=[redacted]"], b: 1 });
  });
});
