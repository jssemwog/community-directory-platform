/**
 * `staging-check.ts` with fakes and synthetic data only (issue #246, OP-2 staging Scope Gate
 * revision 2). Nothing here reaches a provider, a network or a database.
 *
 * SC-1 the record and V-1; SC-2 the DigitalOcean checks (V-2, V-6, V-7, D-2); SC-3 the gate probes
 * and their evaluation (R-3, R-4); SC-4 the cache policy and K-1 to K-5; SC-5 remote equivalence
 * (R-10, Date and Rndr-Id removed); SC-6 status (M-1, R-9, SP-5); SC-7 spend projection;
 * SC-8 regression (PB); SC-9 setup values, leaks and origins; SC-10 readiness end to end against a
 * fake endpoint. Amendment A1 revision 2: A1-U1 to A1-U6 the `Last-Modified` rule (SC-8); A1-U13
 * the status path and probe sets (SC-3); A1-U15 and A1-U16 the classified status reader and
 * `--expect` (SC-16, SC-10); A1-U17 and A1-U18 readiness against refusing and healthy cold
 * endpoints (SC-10).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type Dialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ListingPersistence } from "../../src/data/connection";
import type { ListingDatabase } from "../../src/data/listing-table";

import { stagingKeyDigestHex } from "../../src/interface/public/staging-access";
import type { StagingStatusPayload } from "../../src/interface/public/staging-status";
import { e3Fixtures } from "./e3-check";
import type { ListeningEntry, ProcessIdentity } from "./isolation";
import {
  appEnvironmentOf,
  ATTESTATION_CORROBORATION,
  assetProofProblems,
  buildScanProblems,
  captureFileName,
  classifyStatus,
  compareCaptures,
  DEMO_LISTINGS,
  demoComparisonProblems,
  demoRequests,
  expectProblems,
  FORMER_STATUS_PATH,
  GATE_BASELINE_COMMIT,
  isFrameworkNotFound,
  lastModifiedRelief,
  modeEnvironmentProblems,
  modeSignatureProblems,
  networkFilterProblems,
  p0Problems,
  READINESS_COVERAGE,
  regressionTeardownProblems,
  runLoopbackCommand,
  runTlsControls,
  serverIdentityProblems,
  tlsControlProblems,
  worktreeProblems,
  type CapturedExchange,
  type DoApi,
  type OperatorSql,
  type RegressionCapture,
  type TrustedSource,
  buildIdOf,
  cachePolicyProblems,
  clusterProblems,
  compareRegression,
  databaseNamesProblems,
  deletionConfirmation,
  deletionDeadlineOf,
  denyAllProblems,
  gateProbes,
  gateProblems,
  gateUniformityProblems,
  loopbackOriginProblems,
  probeProblems,
  projectSpend,
  READINESS_CAP,
  readRecord,
  recordBytes,
  recordProblems,
  regressionProbes,
  remoteEquivalenceProblems,
  runKChecks,
  runStagingCommand,
  sha256Hex,
  STAGING_STATUS_PATH,
  staticAssetOf,
  stagingLeakProblems,
  statusProblems,
  tokenExpiryOf,
  trustedSourceProblems,
  WINDOW_OPTIONS,
  type DoCluster,
  type Exchange,
  type ExchangeRequest,
  type StagingRecord,
  type StagingSeams,
} from "./staging-check";

const KEY = randomBytes(32).toString("base64url");
const fixtures = e3Fixtures(randomUUID, (bytes) => randomBytes(bytes).toString("hex"));
const CREATED = "2026-11-20T15:00:00Z";
const CLUSTER_ID = "1c2d3e4f-0000-4000-8000-0000000000aa";
const PROJECT_ID = "2c2d3e4f-0000-4000-8000-0000000000bb";

function record(overrides: Partial<{ digitalOcean: Partial<StagingRecord["digitalOcean"]>; render: Partial<StagingRecord["render"]>; run: Partial<StagingRecord["run"]> }> = {}): StagingRecord {
  const deadline = deletionDeadlineOf(CREATED, WINDOW_OPTIONS["7-day"]);
  return {
    schema: "bi4-staging-record/1",
    writtenAt: "2026-11-20T15:10:00Z",
    digitalOcean: {
      clusterId: CLUSTER_ID,
      name: "bi4-staging-0123456789ab",
      projectId: PROJECT_ID,
      projectName: "bi4-staging",
      region: "nyc3",
      engine: "pg",
      version: "18",
      size: "db-s-1vcpu-1gb",
      host: "bi4-staging-0123456789ab-do-user-1-0.b.db.ondigitalocean.com",
      port: 25060,
      createdAt: CREATED,
      caSha256: "a".repeat(64),
      trustedSources: [{ type: "ip_addr", value: "198.51.100.0/24" }],
      ...overrides.digitalOcean,
    },
    render: {
      serviceId: "srv-abc123",
      name: "bi4-staging",
      ownerId: "tea-xyz",
      environmentId: "evm-123",
      projectName: "bi4-staging",
      dashboardUrl: "https://dashboard.render.com/web/srv-abc123",
      url: "https://bi4-staging.onrender.com",
      region: "virginia",
      plan: "1c-2g",
      numInstances: 1,
      healthCheckPath: "",
      autoDeploy: "no",
      previews: "off",
      edgeCache: "off",
      ...overrides.render,
    },
    run: {
      nonce: "0123456789ab",
      marker: `bi4-staging-synthetic:${"b".repeat(32)}`,
      keyDigestHex: stagingKeyDigestHex(KEY),
      authorizedCommit: "c".repeat(40),
      fixtures,
      calibrationIdentities: [randomUUID()],
      window: "7-day",
      deletionDeadline: deadline,
      tokenExpiryAtLeast: tokenExpiryOf(deadline),
      ceilingUsd: 30,
      stopUsd: 24,
      p0: { reportSha256: "f".repeat(64), commit: "c".repeat(40) },
      ...overrides.run,
    },
  };
}

function exchange(status: number, headers: Record<string, string> | string[], body = ""): Exchange {
  const raw = Array.isArray(headers) ? headers : Object.entries(headers).flat();
  return { status, rawHeaders: raw, body: Buffer.from(body) };
}

/** Seams that refuse every effect unless a test supplies it. */
function baseSeams(overrides: Partial<StagingSeams> = {}): StagingSeams {
  const refuse = (what: string) => () => {
    throw new Error(`no ${what} in this test`);
  };
  return {
    environment: {},
    api: refuse("provider"),
    operatorSql: { connect: refuse("database") },
    resolveIpv4: async () => "203.0.113.10",
    migrate: async () => {},
    transport: async () => {
      throw new Error("no HTTP in this test");
    },
    wait: async () => {},
    now: () => CREATED,
    outputProblems: () => [],
    say: () => {},
    git: async () => {
      throw new Error("no git in this test");
    },
    processes: { inspect: async () => undefined, listener: async () => undefined },
    listeners: async () => [],
    repositoryRoot: "C:/repo",
    ...overrides,
  };
}

const GATE = () => exchange(404, ["Content-Type", "text/plain; charset=utf-8", "Cache-Control", "no-store", "Date", new Date().toUTCString(), "Rndr-Id", randomBytes(6).toString("hex")], "Not Found");

/** The framework's not-found page, as the directory layout's `notFound()` answers it. */
const FRAMEWORK_404 = () =>
  exchange(404, ["Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate", "Content-Type", "text/html; charset=utf-8", "X-Powered-By", "Next.js"], '<!DOCTYPE html><html lang="en"><head><title>404: This page could not be found.</title></head><body><h1>404</h1></body></html>');

/** A status page: one escaped JSON element, as the page's status branch renders it. */
function statusPage(payload: unknown, options: { readonly elements?: number; readonly type?: string } = {}): Exchange {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const element = `<script type="${options.type ?? "application/json"}" id="bi4-staging-status">${json}</script>`;
  return exchange(200, ["Content-Type", "text/html; charset=utf-8", "Cache-Control", "private, no-store"], `<!DOCTYPE html><html><body>${element.repeat(options.elements ?? 1)}</body></html>`);
}

/* ------------------------------------------------------------------------------------------- */

describe("SC-1: the record and V-1", () => {
  it("accepts a well-formed record and reads it back only with the printed hash", () => {
    const valid = record();
    expect(recordProblems(valid)).toEqual([]);
    const bytes = recordBytes(valid);
    expect(readRecord(bytes, sha256Hex(bytes)).problems).toEqual([]);
    expect(readRecord(bytes, "0".repeat(64)).problems[0]).toMatch(/^V-1: the record's SHA-256/);
    expect(recordBytes(JSON.parse(bytes.toString("utf8")) as StagingRecord).equals(bytes)).toBe(true);
  });

  it("derives the seven-day deadline, capped at the option's latest date, and the token expiry", () => {
    expect(deletionDeadlineOf("2026-11-20T15:00:00Z", WINDOW_OPTIONS["7-day"])).toBe("2026-11-27T15:00:00.000Z");
    expect(deletionDeadlineOf("2026-12-04T15:00:00Z", WINDOW_OPTIONS["7-day"])).toBe("2026-12-11T15:00:00.000Z");
    expect(deletionDeadlineOf("2026-12-05T15:00:00Z", WINDOW_OPTIONS["7-day"])).toBe(new Date("2026-12-11T23:59:00-05:00").toISOString());
    expect(tokenExpiryOf("2026-11-27T15:00:00.000Z")).toBe("2026-11-30");
    expect(WINDOW_OPTIONS["7-day"]).toMatchObject({ ceilingUsd: 30, stopUsd: 24 });
  });

  it("refuses every recorded property the gate fixes", () => {
    const cases: [string, StagingRecord][] = [
      ["region", record({ digitalOcean: { region: "sfo3" } })],
      ["engine", record({ digitalOcean: { engine: "advanced_pg" } })],
      ["version", record({ digitalOcean: { version: "17" } })],
      ["IP host", record({ digitalOcean: { host: "203.0.113.4" } })],
      ["name", record({ digitalOcean: { name: "prod-db" } })],
      ["no trusted source", record({ digitalOcean: { trustedSources: [] } })],
      ["non-IP trusted source", record({ digitalOcean: { trustedSources: [{ type: "app", value: "x" }] } })],
      ["render region", record({ render: { region: "oregon" } })],
      ["render plan", record({ render: { plan: "0.5c-512mb" } })],
      ["instances", record({ render: { numInstances: 2 } })],
      ["health path", record({ render: { healthCheckPath: "/healthz" } })],
      ["edge cache", record({ render: { edgeCache: "on" as never } })],
      ["ceiling", record({ run: { ceilingUsd: 50 } })],
      ["deadline", record({ run: { deletionDeadline: "2026-12-30T00:00:00.000Z" } })],
      ["token expiry", record({ run: { tokenExpiryAtLeast: "2026-11-27" } })],
      ["late provisioning", record({ digitalOcean: { createdAt: "2026-12-06T00:00:00Z" } })],
      ["calibration collision", record({ run: { calibrationIdentities: [fixtures.pending] } })],
    ];
    for (const [label, candidate] of cases) expect(recordProblems(candidate).length, label).toBeGreaterThan(0);
  });
});

describe("SC-2: DigitalOcean checks", () => {
  const cluster = (overrides: Partial<DoCluster> = {}): DoCluster => ({
    id: CLUSTER_ID,
    name: "bi4-staging-0123456789ab",
    engine: "pg",
    version: "18",
    region: "nyc3",
    size: "db-s-1vcpu-1gb",
    status: "online",
    project_id: PROJECT_ID,
    created_at: CREATED,
    connection: { host: record().digitalOcean.host, port: 25060 },
    db_names: ["defaultdb"],
    ...overrides,
  });

  it("V-2 matches every recorded field and refuses any difference", () => {
    expect(clusterProblems(record(), { status: 200, cluster: cluster() })).toEqual([]);
    expect(clusterProblems(record(), { status: 200, cluster: cluster({ project_id: "other" }) })[0]).toMatch(/project_id/);
    expect(clusterProblems(record(), { status: 200, cluster: cluster({ connection: { host: "evil.example", port: 25060 } }) })[0]).toMatch(/connection.host/);
    expect(clusterProblems(record(), { status: 200, cluster: cluster({ status: "creating" }) })[0]).toMatch(/status/);
    expect(clusterProblems(record(), { status: 403 })).toEqual(["V-2: GET cluster returned 403"]);
  });

  it("V-6 requires a fresh cluster on bootstrap and only our database before deletion", () => {
    expect(databaseNamesProblems("bootstrap", ["defaultdb"])).toEqual([]);
    expect(databaseNamesProblems("bootstrap", ["defaultdb", "bi4_staging"])).toHaveLength(1);
    expect(databaseNamesProblems("existing", ["defaultdb", "bi4_staging"])).toEqual([]);
    expect(databaseNamesProblems("existing", ["defaultdb"])).toEqual(["V-6: bi4_staging does not exist yet"]);
    expect(databaseNamesProblems("existing", ["defaultdb", "bi4_staging", "customers"])).toHaveLength(1);
    expect(databaseNamesProblems("any", ["defaultdb"])).toEqual([]);
    expect(databaseNamesProblems("any", ["defaultdb", "customers"])).toHaveLength(1);
  });

  it("V-7 treats trusted sources as a network filter that must equal the recorded set", () => {
    const r = record();
    expect(trustedSourceProblems(r, [{ uuid: "u", type: "ip_addr", value: "198.51.100.0/24" }], undefined)).toEqual([]);
    expect(trustedSourceProblems(r, [{ type: "ip_addr", value: "198.51.100.0/24" }, { type: "ip_addr", value: "203.0.113.9" }], undefined)).toEqual(["V-7: unexpected trusted source ip_addr:203.0.113.9"]);
    expect(trustedSourceProblems(r, [{ type: "ip_addr", value: "198.51.100.0/24" }, { type: "ip_addr", value: "203.0.113.9" }], { type: "ip_addr", value: "203.0.113.9" })).toEqual([]);
    expect(trustedSourceProblems(r, [], undefined)).toEqual(["V-7: trusted source ip_addr:198.51.100.0/24 is missing"]);
  });

  it("D-2 confirms deletion only on 404", () => {
    expect(deletionConfirmation({ status: 404 }).confirmed).toBe(true);
    for (const status of [200, 401, 403, 500]) expect(deletionConfirmation({ status }).confirmed).toBe(false);
  });
});

describe("SC-3: the gate probes", () => {
  it("covers every path and method keyless and with a wrong key, and fits the readiness cap", () => {
    const probes = gateProbes(fixtures, "/_next/static/chunks/main.js");
    const keyless = probes.filter((probe) => probe.key === "none" && probe.label.startsWith("R-3 keyless"));
    expect(keyless).toHaveLength(25 * 4);
    expect(probes.filter((probe) => probe.key === "wrong")).toHaveLength(25 * 4);
    expect(probes.some((probe) => probe.label === "R-3 key in cookie")).toBe(true);
    expect(probes.filter((probe) => probe.key === "valid" && probe.path === "/admin")).toHaveLength(1);
    expect(probes.some((probe) => probe.key === "valid" && probe.method === "GET" && /^\/directory\/[^/?]+$/.test(probe.path))).toBe(false);
    expect(probes.length + 18 + 15).toBeLessThanOrEqual(READINESS_CAP);
  });

  it("A1-U13: probes the status identity as an S2 path and the former status route as an ordinary path", () => {
    expect(STAGING_STATUS_PATH).toBe("/directory/__bi4_status__");
    expect(FORMER_STATUS_PATH).toBe("/bi4-staging/status");
    const probes = gateProbes(fixtures, "/_next/static/chunks/main.js");
    const keyed = probes.filter((probe) => probe.key === "valid");
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      expect(keyed.some((probe) => probe.path === FORMER_STATUS_PATH && probe.method === method && probe.expect === "gate"), `keyed ${method} former`).toBe(true);
      expect(probes.some((probe) => probe.key === "none" && probe.path === STAGING_STATUS_PATH && probe.method === method), `keyless ${method} status`).toBe(true);
    }
    expect(keyed.filter((probe) => probe.path === STAGING_STATUS_PATH).map((probe) => probe.method).sort()).toEqual(["OPTIONS", "POST"]);
    const matrix = regressionProbes(fixtures, "/_next/static/chunks/a.js").map((probe) => `${probe.method} ${probe.path}`);
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      expect(matrix).toContain(`${method} ${STAGING_STATUS_PATH}`);
      expect(matrix).toContain(`${method} ${FORMER_STATUS_PATH}`);
    }
  });

  it("accepts only the exact gate 404, or a 308 to the slash-less path for trailing-slash forms", () => {
    expect(gateProblems(GATE(), "x", "GET")).toEqual([]);
    expect(gateProblems(exchange(404, { "Content-Type": "text/html", "Cache-Control": "no-store" }, "Not Found"), "x", "GET")).toHaveLength(1);
    expect(gateProblems(exchange(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "Not Found"), "x", "GET")).toHaveLength(1);
    expect(gateProblems(exchange(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Age: "3" }, "Not Found"), "x", "GET")).toHaveLength(1);
    const slash = { label: "s", method: "GET", path: "/directory/", key: "none" as const, expect: "gate-or-redirect" as const };
    expect(probeProblems(slash, exchange(308, { Location: "/directory" }))).toEqual([]);
    expect(probeProblems(slash, exchange(308, { Location: "/elsewhere" }))).toHaveLength(1);
  });

  it("requires every gate response to be identical apart from Date and Rndr-Id", () => {
    expect(gateUniformityProblems([{ label: "a", method: "GET", exchange: GATE() }, { label: "b", method: "POST", exchange: GATE() }])).toEqual([]);
    const odd = exchange(404, ["Content-Type", "text/plain; charset=utf-8", "Cache-Control", "no-store", "X-Extra", "1"], "Not Found");
    expect(gateUniformityProblems([{ label: "a", method: "GET", exchange: GATE() }, { label: "b", method: "GET", exchange: odd }])).toHaveLength(1);
  });
});

describe("SC-4: the cache policy and K-1 to K-5", () => {
  it("requires no-store and refuses public, s-maxage or an Age header", () => {
    expect(cachePolicyProblems(exchange(200, { "Cache-Control": "private, no-store" }), "k")).toEqual([]);
    expect(cachePolicyProblems(exchange(200, { "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate" }), "k")).toEqual([]);
    expect(cachePolicyProblems(exchange(200, {}), "k").length).toBeGreaterThan(0);
    expect(cachePolicyProblems(exchange(200, { "Cache-Control": "public, max-age=60" }), "k").length).toBeGreaterThan(0);
    expect(cachePolicyProblems(exchange(200, { "Cache-Control": "no-store, s-maxage=10" }), "k")).toHaveLength(1);
    expect(cachePolicyProblems(exchange(200, { "Cache-Control": "no-store", Age: "1" }), "k")).toHaveLength(1);
  });

  it("passes when keyless requests always get the gate, and fails on a served copy or a 304", async () => {
    const wait = vi.fn(async () => {});
    const keyed = exchange(200, { "Cache-Control": "private, no-store", ETag: '"abc"' }, "<h1>Not available</h1>");
    const good = await runKChecks("/directory/x", async (_request, mode) => (mode === "valid" ? keyed : GATE()), wait);
    expect(good.results.flatMap((result) => result.problems)).toEqual([]);
    expect(good.results.map((result) => result.id)).toEqual(["K-5", "K-1", "K-3", "K-4", "K-4", "K-2"]);
    expect(wait).toHaveBeenCalledWith(30_000);

    const cached = await runKChecks("/directory/x", async (request, mode) => (mode === "valid" || request.headers?.["if-none-match"] === undefined ? keyed : exchange(304, {})), wait);
    const problems = cached.results.flatMap((result) => result.problems);
    expect(problems.some((problem) => problem.startsWith("K-1"))).toBe(true);
    expect(problems.some((problem) => problem.includes("304 Not Modified"))).toBe(true);
  });
});

describe("SC-5: remote equivalence with Date and Rndr-Id removed", () => {
  const page = (identity: string, text = "<h1>Not available</h1>") => exchange(200, ["Content-Type", "text/html; charset=utf-8", "Cache-Control", "private, no-store", "Date", new Date().toUTCString(), "Rndr-Id", randomBytes(6).toString("hex")], `<a href="/directory/${identity}">${text}</a>`);
  const members = () =>
    (
      [
        ["NE1", fixtures.neverExisted[0], "NE"],
        ["NE2", fixtures.neverExisted[1], "NE"],
        ["PE", fixtures.pending, "PE"],
        ["RJ", fixtures.rejected, "RJ"],
        ["UP", fixtures.unpublished, "UP"],
      ] as const
    ).map(([label, identity, state]) => ({ label, identity, state, exchange: page(identity) }));
  const control = () => ({ label: "public", identity: fixtures.publiclyAvailable, exchange: page(fixtures.publiclyAvailable, fixtures.publicName), publicName: fixtures.publicName });

  it("agrees when only the identity, Date and Rndr-Id differ", () => {
    expect(remoteEquivalenceProblems(members(), [control()])).toEqual([]);
  });

  it("refuses a differing body, a differing header, or a public control equal to never-existed", () => {
    const set = members();
    const differentBody = set.map((member, index) => (index === 2 ? { ...member, exchange: page(member.identity, "<h1>Pending</h1>") } : member));
    expect(remoteEquivalenceProblems(differentBody, [control()])).toContain("R-10: PE masked body differs");
    const extraHeader = set.map((member, index) => (index === 3 ? { ...member, exchange: { ...member.exchange, rawHeaders: [...member.exchange.rawHeaders, "X-Cache", "HIT"] } } : member));
    expect(remoteEquivalenceProblems(extraHeader, [control()])[0]).toMatch(/RJ header list differs/);
    expect(remoteEquivalenceProblems(set, [{ ...control(), exchange: page(fixtures.publiclyAvailable), publicName: "<h1>Not available</h1>" }]).some((p) => p.includes("equals the never-existed body"))).toBe(true);
  });
});

describe("SC-6: status (M-1, R-9, SP-5)", () => {
  const payload = (overrides: Omit<Partial<StagingStatusPayload>, "counters"> & { counters?: Partial<StagingStatusPayload["counters"]> } = {}): StagingStatusPayload => ({
    schema: "bi4-staging-status/1",
    bootNonce: "n".repeat(32),
    render: { serviceId: "srv-abc123", instanceId: "srv-abc123-i1", gitCommit: "c".repeat(40), externalHostname: "bi4-staging.onrender.com" },
    state: "verified",
    sinceLastStatus: { eventLoop: null, calibration: [] },
    calibration: { enabled: false, total: [] },
    notes: [],
    ...overrides,
    counters: { s2Reads: 10, refusals: 0, readsAfterRefusal: 0, overlappedReads: 0, ...overrides.counters },
  });

  it("passes for the recorded service, commit and a verified state", () => {
    expect(statusProblems(record(), payload(), payload(), 0)).toEqual([]);
  });

  it("flags a restart, a new instance, a wrong commit, a refusal, a read-count mismatch, and any overlap", () => {
    const r = record();
    expect(statusProblems(r, payload({ bootNonce: "m".repeat(32) }), payload(), undefined)[0]).toMatch(/restarted/);
    expect(statusProblems(r, payload({ render: { ...payload().render, instanceId: "i2" } }), payload(), undefined)[0]).toMatch(/INSTANCE_ID/);
    expect(statusProblems(r, payload({ render: { ...payload().render, gitCommit: "d".repeat(40) } }), undefined, undefined)[0]).toMatch(/GIT_COMMIT/);
    expect(statusProblems(r, payload({ state: "refused", counters: { refusals: 1 } }), undefined, undefined)).toHaveLength(2);
    expect(statusProblems(r, payload({ counters: { s2Reads: 12 } }), payload(), 3)[0]).toMatch(/R-9/);
    expect(statusProblems(r, payload({ counters: { overlappedReads: 1 } }), payload(), undefined)[0]).toMatch(/invalidates the run/);
  });
});

describe("SC-7: spend projection (seven-day basis, $24 stop, $30 ceiling)", () => {
  it("projects Render per second and DigitalOcean at its worst case unless hourly accrual is shown", () => {
    const r = record();
    const atCreation = projectSpend(r, CREATED, { renderUsd: 0, doUsd: 0 }, false);
    expect(atCreation.projectedUsd).toBe(20.98);
    expect(atCreation.stop).toBe(false);
    expect(atCreation.ceilingUsd).toBe(30);
    expect(projectSpend(r, CREATED, { renderUsd: 0, doUsd: 0 }, true).projectedUsd).toBe(9.62);
    expect(projectSpend(r, CREATED, { renderUsd: 3.1, doUsd: 0 }, false).stop).toBe(true);
    expect(projectSpend(r, "2026-11-28T00:00:00Z", { renderUsd: 6, doUsd: 4 }, true).deadlinePassed).toBe(true);
  });
});

describe("SC-8: regression (PB-1 to PB-5)", () => {
  it("builds the matrix and compares after masking Date, ETag, x-nextjs-* and build IDs", () => {
    const probes = regressionProbes(fixtures, "/_next/static/chunks/a.js");
    expect(probes).toHaveLength(25 * 4);
    const page = (build: string, date: string) => exchange(200, ["Date", date, "ETag", `"${build}"`, "x-nextjs-cache", build], `<script src="/_next/static/${build}/_buildManifest.js"></script>`);
    const baseline = probes.map(() => page("BUILDAAAA1", "Mon, 01 Jan 2026 00:00:00 GMT"));
    const candidate = probes.map(() => page("BUILDBBBB2", "Tue, 02 Jan 2026 00:00:00 GMT"));
    expect(compareRegression(probes, baseline, candidate, { baseline: "BUILDAAAA1", candidate: "BUILDBBBB2" })).toEqual([]);
    const changed = candidate.map((item, index) => (index === 0 ? { ...item, status: 404 } : item));
    expect(compareRegression(probes, baseline, changed, { baseline: "BUILDAAAA1", candidate: "BUILDBBBB2" })[0]).toMatch(/status 404, baseline 200/);
    const header = candidate.map((item, index) => (index === 5 ? { ...item, rawHeaders: [...item.rawHeaders, "X-Frame-Options", "DENY"] } : item));
    expect(compareRegression(probes, baseline, header, { baseline: "BUILDAAAA1", candidate: "BUILDBBBB2" })[0]).toMatch(/header list differs/);
  });

  describe("amendment A1 §1: Last-Modified on the paired static asset", () => {
    const ASSET = "/_next/static/chunks/a.js";
    const probes: ExchangeRequest[] = [
      { method: "GET", path: ASSET },
      { method: "HEAD", path: ASSET },
      { method: "POST", path: ASSET },
      { method: "OPTIONS", path: ASSET },
      { method: "GET", path: "/" },
      { method: "GET", path: "/bi4-staging/status" },
      { method: "GET", path: "/directory/e0000000-0000-4000-8000-000000000001" },
    ];
    const BYTES = "console.log('asset');".repeat(20);
    const asset = (lastModified: string | null, body = BYTES, extra: string[] = []): Exchange =>
      exchange(200, ["Cache-Control", "public, max-age=31536000, immutable", ...(lastModified === null ? [] : ["Last-Modified", lastModified]), "Content-Type", "application/javascript; charset=UTF-8", ...extra], body);
    const head = (lastModified: string | null, extra: string[] = []): Exchange => ({ ...asset(lastModified, BYTES, extra), body: Buffer.alloc(0) });
    const page = (lastModified: string): Exchange => exchange(200, ["Content-Type", "text/html; charset=utf-8", "Last-Modified", lastModified], "<html>same</html>");
    const B = "Wed, 11 Nov 2026 18:43:16 GMT";
    const C = "Wed, 11 Nov 2026 18:45:04 GMT";
    // Positions: 0 GET asset, 1 HEAD asset, 2 POST asset, 3 OPTIONS asset, 4 GET /, 5 GET former status, 6 GET S2.
    const side = (lm: string, overrides: Partial<Record<number, Exchange>> = {}): Exchange[] =>
      [asset(lm), head(lm), page(lm), page(lm), page(B), page(B), page(B)].map((item, index) => overrides[index] ?? item);
    const compare = (b: Exchange[], c: Exchange[]) => compareRegression(probes, b, c, {});
    const sameOther = { 2: page(B), 3: page(B) };

    it("A1-U1: equal bytes, one Last-Modified each side, different values: GET and HEAD pass", () => {
      expect(compare(side(B), side(C, sameOther))).toEqual([]);
      expect(lastModifiedRelief(probes, side(B), side(C), 0)).toBe(true);
      expect(lastModifiedRelief(probes, side(B), side(C), 1)).toBe(true);
    });

    it("A1-U2: unequal asset bytes fail on GET (header and body) and on HEAD (header)", () => {
      const different = asset(C, `${BYTES.slice(0, -1)}X`);
      const problems = compare(side(B), side(C, { ...sameOther, 0: different }));
      expect(problems).toContain("GET /_next/static/<asset>: header list differs after masking");
      expect(problems).toContain("GET /_next/static/<asset>: body differs after masking");
      expect(problems).toContain("HEAD /_next/static/<asset>: header list differs after masking");
    });

    it("A1-U2: a non-200 paired GET removes the relief", () => {
      const notOk = { ...asset(C), status: 304 };
      expect(compare(side(B), side(C, { ...sameOther, 0: notOk }))).toContain("HEAD /_next/static/<asset>: header list differs after masking");
    });

    it("A1-U3: a Last-Modified missing on either side, or duplicated, fails", () => {
      expect(compare(side(B, { 0: asset(null) }), side(C, sameOther))).toContain("GET /_next/static/<asset>: header list differs after masking");
      expect(compare(side(B), side(C, { ...sameOther, 1: head(null) }))).toContain("HEAD /_next/static/<asset>: header list differs after masking");
      const twice = asset(C, BYTES, ["Last-Modified", C]);
      expect(lastModifiedRelief(probes, side(B), side(C, { 0: twice }), 0)).toBe(false);
      expect(compare(side(B), side(C, { ...sameOther, 0: twice }))).toContain("GET /_next/static/<asset>: header list differs after masking");
    });

    it("A1-U4: a Last-Modified difference on a non-static route fails", () => {
      const problems = compare(side(B), side(C, { ...sameOther, 4: page(C), 5: page(C), 6: page(C) }));
      expect(problems).toEqual([
        "GET /: header list differs after masking",
        "GET /bi4-staging/status: header list differs after masking",
        "GET /directory/e0000000-0000-4000-8000-000000000001: header list differs after masking",
      ]);
    });

    it("A1-U5: POST and OPTIONS on the static asset are not eligible", () => {
      expect(compare(side(B), side(C))).toEqual(["POST /_next/static/<asset>: header list differs after masking", "OPTIONS /_next/static/<asset>: header list differs after masking"]);
    });

    it("A1-U6: any other header difference on an eligible probe still fails", () => {
      expect(compare(side(B), side(C, { ...sameOther, 0: asset(C, BYTES, ["X-Extra", "1"]) }))).toEqual(["GET /_next/static/<asset>: header list differs after masking"]);
      const cache = exchange(200, ["Cache-Control", "no-cache", "Last-Modified", C, "Content-Type", "application/javascript; charset=UTF-8"], BYTES);
      expect(compare(side(B), side(C, { ...sameOther, 0: cache }))).toEqual(["GET /_next/static/<asset>: header list differs after masking"]);
      const moved = exchange(200, ["Last-Modified", C, "Cache-Control", "public, max-age=31536000, immutable", "Content-Type", "application/javascript; charset=UTF-8"], BYTES);
      expect(compare(side(B), side(C, { ...sameOther, 0: moved }))).toEqual(["GET /_next/static/<asset>: header list differs after masking"]);
    });
  });

  it("finds a page's build ID and first static asset", () => {
    const html = '<script src="/_next/static/chunks/main-123.js"></script><script src="/_next/static/AbCdEf123456/_buildManifest.js"></script>';
    expect(staticAssetOf(html)).toBe("/_next/static/chunks/main-123.js");
    expect(buildIdOf(html)).toBe("AbCdEf123456");
  });

  it("PB-3/PB-4 require deny-all", () => {
    const probes: ExchangeRequest[] = [{ method: "GET", path: "/" }, { method: "GET", path: "/directory/" }];
    expect(denyAllProblems(probes, [GATE(), exchange(308, { Location: "/directory" })])).toEqual([]);
    expect(denyAllProblems(probes, [exchange(200, {}), GATE()]).length).toBeGreaterThan(0);
  });
});

describe("SC-9: setup values, leaks and origins", () => {
  it("writes the Render environment from the record, with calibration only for recorded identities within the ceiling", () => {
    const r = record();
    const values = appEnvironmentOf(r, "p".repeat(48), "PEM", []);
    expect(values.BI4_STAGING_DATABASE_URL).toBe(`postgresql://bi4_staging_app:${"p".repeat(48)}@${r.digitalOcean.host}:25060/bi4_staging`);
    expect(values.BI4_STAGING_EXPECTED_HOST).toBe(r.digitalOcean.host);
    expect(values.BI4_STAGING_ACCESS_KEY_SHA256).toBe(r.run.keyDigestHex);
    expect(values).not.toHaveProperty("BI4_STAGING_CALIBRATION");
    const identity = r.run.calibrationIdentities[0] as string;
    expect(appEnvironmentOf(r, "p".repeat(48), "PEM", [{ identity, delayNs: 2_000_000 }]).BI4_STAGING_CALIBRATION).toBe(`${identity}:2000000`);
    expect(() => appEnvironmentOf(r, "p".repeat(48), "PEM", [{ identity: randomUUID(), delayNs: 0 }])).toThrow(/approved/);
    expect(() => appEnvironmentOf(r, "p".repeat(48), "PEM", [{ identity, delayNs: 2_000_001 }])).toThrow(/ceiling/);
  });

  it("finds the key, digest or prefix in any scanned response", () => {
    const items = [{ where: "a", bytes: Buffer.from(`ok ${KEY}`) }, { where: "b", bytes: Buffer.from("BI4_STAGING_X") }];
    expect(stagingLeakProblems(items, { key: KEY })).toEqual(["leak: key appears in a", "leak: the BI4_STAGING_ prefix appears in b"]);
  });

  it("allows only http://127.0.0.1 origins for the loopback checks", () => {
    expect(loopbackOriginProblems("http://127.0.0.1:3100")).toEqual([]);
    expect(loopbackOriginProblems("http://localhost:3100").length).toBeGreaterThan(0);
    expect(loopbackOriginProblems("https://bi4-staging.onrender.com").length).toBeGreaterThan(0);
    expect(loopbackOriginProblems("http://127.0.0.1:3100/x").length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* SC-10: readiness end to end against a fake endpoint that implements the gate                   */
/* ------------------------------------------------------------------------------------------- */

/**
 * A fake staging endpoint. Status is served at the reserved S2 identity, behind a layout-style
 * pre-check: with `refusing`, every keyed S2 request, status included, gets the framework 404 (a
 * cold refusing process), and no read happens. Status reads never count as S2 reads.
 */
function fakeEndpoint(r: StagingRecord, options: { readonly cacheControl?: string; readonly cacheKeyless?: boolean; readonly refusing?: boolean } = {}) {
  let s2Reads = 0;
  let lastKeyed: Exchange | undefined;
  const statusReadsAt: number[] = [];
  const gate = () => GATE();
  const transport = async (_origin: string, request: ExchangeRequest): Promise<Exchange> => {
    const url = new URL(request.path, "https://x");
    const keyed = request.headers?.["x-bi4-staging-key"] === KEY;
    const s2 = /^\/directory\/[^/]+$/.test(url.pathname);
    if (url.pathname.endsWith("/") && url.pathname !== "/") return exchange(308, { Location: url.pathname.slice(0, -1) });
    if (!keyed) return options.cacheKeyless && lastKeyed !== undefined ? lastKeyed : gate();
    if (url.search !== "" || request.headers?.cookie !== undefined) return gate();
    if (s2 && (request.method === "GET" || request.method === "HEAD") && options.refusing) return FRAMEWORK_404();
    if (url.pathname === "/directory/__bi4_status__" && request.method === "GET") {
      statusReadsAt.push(s2Reads);
      const status: StagingStatusPayload = {
        schema: "bi4-staging-status/1",
        bootNonce: "n".repeat(32),
        render: { serviceId: r.render.serviceId, instanceId: "i1", gitCommit: r.run.authorizedCommit, externalHostname: new URL(r.render.url).hostname },
        state: "verified",
        counters: { s2Reads, refusals: 0, readsAfterRefusal: 0, overlappedReads: 0 },
        sinceLastStatus: { eventLoop: null, calibration: [] },
        calibration: { enabled: false, total: [] },
        notes: [],
      };
      return statusPage(status);
    }
    if (s2 && request.method === "GET") {
      s2Reads += 1;
      const identity = url.pathname.slice("/directory/".length);
      const text = identity === r.run.fixtures.publiclyAvailable ? `<h1>${r.run.fixtures.publicName}</h1>` : "<h1>Not available</h1>";
      lastKeyed = exchange(200, ["Content-Type", "text/html; charset=utf-8", "Cache-Control", options.cacheControl ?? "private, no-store", "Rndr-Id", randomBytes(4).toString("hex")], `<a href="/directory/${identity}">${text}</a>`);
      return lastKeyed;
    }
    return gate();
  };
  return { transport, statusReadsAt, s2ReadCount: () => s2Reads };
}

describe("SC-10: readiness end to end against a fake endpoint", () => {
  const directories: string[] = [];
  afterEach(() => {
    while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
  });

  function run(r: StagingRecord, options: Parameters<typeof fakeEndpoint>[1] = {}) {
    const directory = mkdtempSync(join(tmpdir(), "staging-check-"));
    directories.push(directory);
    const recordFile = join(directory, "record.json");
    const bytes = recordBytes(r);
    writeFileSync(recordFile, bytes);
    const out = mkdtempSync(join(tmpdir(), "staging-check-out-"));
    directories.push(out);
    const lines: string[] = [];
    const endpoint = fakeEndpoint(r, options);
    const seams = baseSeams({ environment: { BI4_STAGING_KEY: KEY }, transport: endpoint.transport, say: (line) => lines.push(line) });
    return runStagingCommand("staging-readiness", { "--record": recordFile, "--record-sha256": sha256Hex(bytes), "--out": out }, seams).then((code) => ({ code, lines, endpoint, out }));
  }

  function runStatus(r: StagingRecord, expect: string, options: Parameters<typeof fakeEndpoint>[1] = {}) {
    const directory = mkdtempSync(join(tmpdir(), "staging-check-"));
    directories.push(directory);
    const recordFile = join(directory, "record.json");
    const bytes = recordBytes(r);
    writeFileSync(recordFile, bytes);
    const out = mkdtempSync(join(tmpdir(), "staging-check-out-"));
    directories.push(out);
    const lines: string[] = [];
    const sent: string[] = [];
    const endpoint = fakeEndpoint(r, options);
    const transport = (origin: string, request: ExchangeRequest) => {
      sent.push(`${request.method} ${request.path}`);
      return endpoint.transport(origin, request);
    };
    const seams = baseSeams({ environment: { BI4_STAGING_KEY: KEY }, transport, say: (line) => lines.push(line) });
    const flags = { "--record": recordFile, "--record-sha256": sha256Hex(bytes), "--previous": "none", "--expected-reads": "none", "--expect": expect, "--out": out };
    return runStagingCommand("staging-status", flags, seams).then((code) => ({ code, lines, sent, out }));
  }

  it("A1-U18: healthy cold endpoint: the first status read is verified with s2Reads 0, and status reads never count", async () => {
    const { code, endpoint, out } = await run(record());
    expect(code).toBe(0);
    expect(endpoint.statusReadsAt[0]).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "readiness.json"), "utf8"));
    expect(report.statusStart.state).toBe("verified");
    expect(report.statusStart.counters.s2Reads).toBe(0);
    // The final status shows exactly the keyed listing reads the endpoint counted; status reads add none.
    expect(report.statusEnd.counters.s2Reads).toBe(endpoint.s2ReadCount());
    expect(report.stoppedAt).toBeUndefined();
  });

  it("A1-U17: refusing endpoint: readiness fails at R-5 with refused-404 and sends nothing more", async () => {
    const { code, lines, out } = await run(record(), { refusing: true });
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith("R-5: status (start) is refused-404"))).toBe(true);
    expect(Number(/attempts: (\d+) of/.exec(lines.join("\n"))?.[1])).toBe(1);
    const report = JSON.parse(readFileSync(join(out, "readiness.json"), "utf8"));
    expect(report.stoppedAt).toBe("status (start)");
    expect(report.statusStart).toBeNull();
  });

  it("A1-U16: staging-status --expect refused passes on refused-404 with the keyed S2 framework 404 (R-7)", async () => {
    const r = record();
    const refused = await runStatus(r, "refused", { refusing: true });
    expect(refused.code).toBe(0);
    expect(refused.sent).toEqual(["GET /directory/__bi4_status__", `GET /directory/${r.run.fixtures.publiclyAvailable}`]);
    const report = JSON.parse(readFileSync(join(refused.out, "status.json"), "utf8"));
    expect(report.classification).toBe("refused-404");
    expect(report.r7KeyedS2).toBe("framework 404");
  });

  it("A1-U16: --expect refused fails on a healthy endpoint; --expect verified passes there and fails on a refusing one", async () => {
    expect((await runStatus(record(), "refused")).code).toBe(1);
    expect((await runStatus(record(), "verified")).code).toBe(0);
    const failing = await runStatus(record(), "verified", { refusing: true });
    expect(failing.code).toBe(1);
    expect(failing.sent).toEqual(["GET /directory/__bi4_status__"]);
  });

  it("passes against an endpoint that implements the gate and the cache policy, within the cap", async () => {
    const { code, lines } = await run(record());
    const coverage = lines.filter((line) => line.startsWith("  "));
    expect(lines.filter((line) => !line.startsWith("R-2b") && !line.startsWith("attempts") && !line.startsWith("staging-readiness") && !line.startsWith("Readiness is not complete") && !line.startsWith("  "))).toEqual([]);
    expect(lines).toContain("Readiness is not complete on this command alone. Still owed, by coverage table:");
    expect(coverage.some((line) => line.includes("R-11 [not implemented]"))).toBe(true);
    expect(coverage.some((line) => line.includes("M-2 [operator evidence]"))).toBe(true);
    expect(code).toBe(0);
    const attempts = Number(/attempts: (\d+) of/.exec(lines.join("\n"))?.[1]);
    expect(attempts).toBeLessThanOrEqual(READINESS_CAP);
    expect(lines.some((line) => line.includes('"private, no-store"'))).toBe(true);
  });

  it("fails when the keyed response lacks no-store, or a keyless request receives the keyed response", async () => {
    expect((await run(record(), { cacheControl: "private, max-age=60" })).code).toBe(1);
    expect((await run(record(), { cacheKeyless: true })).code).toBe(1);
  });

  it("confirms deletion (D-2) without the key, which teardown has already deleted, and only on 404", async () => {
    const directory = mkdtempSync(join(tmpdir(), "staging-check-"));
    directories.push(directory);
    const r = record();
    const bytes = recordBytes(r);
    writeFileSync(join(directory, "record.json"), bytes);
    const lines: string[] = [];
    const seamsFor = (status: number): StagingSeams =>
      baseSeams({ environment: { BI4_STAGING_DO_TOKEN: "dop_v1_readonly_fixture" }, api: () => ({ cluster: async () => ({ status }), firewall: async () => [] }), say: (line) => lines.push(line) });
    const flags = { "--record": join(directory, "record.json"), "--record-sha256": sha256Hex(bytes) };
    expect(await runStagingCommand("staging-confirm-deleted", flags, seamsFor(404))).toBe(0);
    expect(await runStagingCommand("staging-confirm-deleted", flags, seamsFor(200))).toBe(1);
    expect(lines.some((line) => line.includes("UNRESOLVED"))).toBe(true);
  });

  it("refuses a key that does not hash to the recorded digest", async () => {
    await expect(run(record({ run: { keyDigestHex: "e".repeat(64) } }))).rejects.toThrow(/does not hash/);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* SC-16: the classified status reader (amendment A1 revision 2 §2.6)                              */
/* ------------------------------------------------------------------------------------------- */

describe("SC-16: the classified status reader", () => {
  const payload = {
    schema: "bi4-staging-status/1",
    bootNonce: "n".repeat(32),
    render: { serviceId: "srv", instanceId: "i1", gitCommit: "c".repeat(40), externalHostname: "h" },
    state: "verified",
    counters: { s2Reads: 0, refusals: 0, readsAfterRefusal: 0, overlappedReads: 0 },
    sinceLastStatus: { eventLoop: null, calibration: [] },
    calibration: { enabled: false, total: [] },
    notes: ["a </script> in a note"],
  };

  it("A1-U15: 200 with one valid element is status", () => {
    const read = classifyStatus(statusPage(payload));
    expect(read.kind).toBe("status");
    expect(read.kind === "status" && read.payload.notes[0]).toBe("a </script> in a note");
  });

  it("A1-U15: the gate's exact 404 is gated; a framework HTML 404 without an element is refused-404", () => {
    expect(classifyStatus(GATE()).kind).toBe("gated");
    expect(classifyStatus(FRAMEWORK_404()).kind).toBe("refused-404");
    expect(isFrameworkNotFound(FRAMEWORK_404())).toBe(true);
    expect(isFrameworkNotFound(GATE())).toBe(false);
  });

  it("A1-U15: everything else is malformed", () => {
    const cases: [string, Exchange][] = [
      ["no element", exchange(200, { "Content-Type": "text/html" }, "<html><body>listing</body></html>")],
      ["two elements", statusPage(payload, { elements: 2 })],
      ["wrong type", statusPage(payload, { type: "text/javascript" })],
      ["bad JSON", exchange(200, { "Content-Type": "text/html" }, '<html><script type="application/json" id="bi4-staging-status">{nope</script></html>')],
      ["schema mismatch", statusPage({ ...payload, schema: "other/1" })],
      ["unknown state", statusPage({ ...payload, state: "fine" })],
      ["missing counters", statusPage({ ...payload, counters: undefined })],
      ["500", exchange(500, { "Content-Type": "text/html" }, "<html>error</html>")],
      ["304", exchange(304, {})],
      ["404 with an element", { ...statusPage(payload), status: 404 }],
      ["404 plain text, not the gate", exchange(404, { "Content-Type": "text/plain" }, "nope")],
    ];
    for (const [label, response] of cases) expect(classifyStatus(response).kind, label).toBe("malformed");
  });

  it("A1-U16: expectProblems", () => {
    const verified = classifyStatus(statusPage(payload));
    const refusedPayload = classifyStatus(statusPage({ ...payload, state: "refused" }));
    const refused404 = classifyStatus(FRAMEWORK_404());
    const gated = classifyStatus(GATE());
    const malformed = classifyStatus(exchange(500, {}));
    expect(expectProblems("verified", verified)).toEqual([]);
    for (const read of [refusedPayload, refused404, gated, malformed]) expect(expectProblems("verified", read)).toHaveLength(1);
    expect(expectProblems("refused", refused404)).toEqual([]);
    expect(expectProblems("refused", refusedPayload)).toEqual([]);
    for (const read of [verified, gated, malformed]) expect(expectProblems("refused", read)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* SC-11: P-0, the required live e3-check, enforced before any record                              */
/* ------------------------------------------------------------------------------------------- */

describe("SC-11: P-0", () => {
  const commit = "c".repeat(40);
  const report = (overrides: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        header: { "Authorized commit": commit },
        acceptancePassed: true,
        faultInjection: { result: "pass" },
        problems: [],
        safety: [],
        teardown: { left: [] },
        ...overrides,
      }),
    );

  it("accepts a passed run on exactly the authorized commit, with its stated hash", () => {
    const bytes = report();
    expect(p0Problems(bytes, sha256Hex(bytes), commit)).toEqual([]);
  });

  it("refuses a wrong hash, another commit, a failed acceptance, a failed E-A4b, problems, safety problems or residue", () => {
    expect(p0Problems(report(), "0".repeat(64), commit)[0]).toMatch(/hashes to/);
    for (const overrides of [
      { header: { "Authorized commit": "d".repeat(40) } },
      { acceptancePassed: false },
      { faultInjection: { result: "fail" } },
      { problems: ["x"] },
      { safety: ["residue"] },
      { teardown: { left: [3] } },
    ]) {
      const bytes = report(overrides);
      expect(p0Problems(bytes, sha256Hex(bytes), commit).length, JSON.stringify(overrides)).toBeGreaterThan(0);
    }
  });

  it("makes a record without P-0 on the authorized commit unusable", () => {
    expect(recordProblems(record({ run: { p0: { reportSha256: "f".repeat(64), commit: "d".repeat(40) } } }))).toContainEqual(expect.stringMatching(/^P-0/));
  });
});

/* ------------------------------------------------------------------------------------------- */
/* A fake SQL stack: real Kysely, a scripted driver, every statement recorded per connection      */
/* ------------------------------------------------------------------------------------------- */

interface FakeConnection {
  readonly url: string;
  readonly ca: string;
  readonly statements: string[];
}

function fakeOperatorSql(options: { goodCa: string; marker?: string | null; failNetwork?: boolean }) {
  const connections: FakeConnection[] = [];
  const operatorSql: OperatorSql = {
    connect(url, ca) {
      const connection: FakeConnection = { url, ca, statements: [] };
      connections.push(connection);
      const host = new URL(url).hostname;
      const database = new URL(url).pathname.slice(1);
      const dialect: Dialect = {
        createAdapter: () => new PostgresAdapter(),
        createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
        createDriver: () => ({
          init: async () => {},
          destroy: async () => {},
          beginTransaction: async () => {},
          commitTransaction: async () => {},
          rollbackTransaction: async () => {},
          releaseConnection: async () => {},
          acquireConnection: async () => {
            if (options.failNetwork) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
            if (ca !== options.goodCa) throw Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
            if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) throw Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
            return {
              executeQuery: async (query: { sql: string }) => {
                connection.statements.push(query.sql);
                if (query.sql.includes("session_user")) return { rows: [{ database, session_user: "doadmin", major: "18" }] };
                if (query.sql.startsWith("select current_database()")) return { rows: [{ database }] };
                if (query.sql.includes("shobj_description")) return { rows: [{ marker: options.marker ?? null }] };
                return { rows: [] };
              },
              streamQuery: async function* () {},
            };
          },
        }),
      } as unknown as Dialect;
      const db = new Kysely<ListingDatabase>({ dialect });
      return { db, shutdown: async () => db.destroy() } as unknown as ListingPersistence;
    },
  };
  return { operatorSql, connections };
}

const GOOD_CA = "-----BEGIN CERTIFICATE-----\ngood\n-----END CERTIFICATE-----\n";

function fakeApi(r: StagingRecord, overrides: Partial<DoCluster> = {}, rules: TrustedSource[] = [...r.digitalOcean.trustedSources, { type: "ip_addr", value: "203.0.113.9" }]): DoApi {
  return {
    cluster: async () => ({
      status: 200,
      cluster: {
        id: r.digitalOcean.clusterId,
        name: r.digitalOcean.name,
        engine: "pg",
        version: "18",
        region: "nyc3",
        size: r.digitalOcean.size,
        status: "online",
        project_id: r.digitalOcean.projectId,
        created_at: r.digitalOcean.createdAt,
        connection: { host: r.digitalOcean.host, port: r.digitalOcean.port },
        db_names: ["defaultdb"],
        ...overrides,
      },
    }),
    firewall: async () => rules,
  };
}

function recordFiles(r: StagingRecord) {
  const directory = mkdtempSync(join(tmpdir(), "staging-check-db-"));
  const bytes = recordBytes(r);
  writeFileSync(join(directory, "record.json"), bytes);
  writeFileSync(join(directory, "ca.pem"), GOOD_CA);
  return { directory, flags: { "--record": join(directory, "record.json"), "--record-sha256": sha256Hex(bytes), "--ca": join(directory, "ca.pem") } };
}

const withCa = (overrides: Parameters<typeof record>[0] = {}) => record({ ...overrides, digitalOcean: { caSha256: sha256Hex(GOOD_CA), ...overrides.digitalOcean } });
const DB_ENVIRONMENT = { BI4_STAGING_DO_TOKEN: "dop_v1_readonly_fixture", BI4_STAGING_DOADMIN_PASSWORD: "doadmin-fixture-password" };

/* ------------------------------------------------------------------------------------------- */
/* SC-12: the database preflight                                                                  */
/* ------------------------------------------------------------------------------------------- */

describe("SC-12: database preflight", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true });
  });

  function setup(r: StagingRecord, api: DoApi, stack: ReturnType<typeof fakeOperatorSql>) {
    const files = recordFiles(r);
    const out = mkdtempSync(join(tmpdir(), "staging-check-out-"));
    cleanup.push(files.directory, out);
    return {
      seams: baseSeams({ environment: DB_ENVIRONMENT, api: () => api, operatorSql: stack.operatorSql }),
      flags: { ...files.flags, "--operator-rule": "203.0.113.9" },
      out,
    };
  }

  it("sends no SQL and opens no connection when the API disagrees with the record (V-2)", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA });
    const { seams, flags, out } = setup(r, fakeApi(r, { connection: { host: "other.example.com", port: 25060 } }), stack);
    await expect(runStagingCommand("staging-setup", { ...flags, "--out": out }, seams)).rejects.toThrow(/refused before any SQL/);
    expect(stack.connections).toEqual([]);
  });

  it("refuses setup on a cluster that is not fresh (V-6), before any connection", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA });
    const { seams, flags, out } = setup(r, fakeApi(r, { db_names: ["defaultdb", "bi4_staging"] }), stack);
    await expect(runStagingCommand("staging-setup", { ...flags, "--out": out }, seams)).rejects.toThrow(/fresh cluster/);
    expect(stack.connections).toEqual([]);
  });

  it("refuses setup with a CA whose hash differs from the record (V-3), before any connection", async () => {
    const r = record();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA });
    const { seams, flags, out } = setup(r, fakeApi(r), stack);
    await expect(runStagingCommand("staging-setup", { ...flags, "--out": out }, seams)).rejects.toThrow(/V-3/);
    expect(stack.connections).toEqual([]);
  });

  it("refuses setup when the trusted sources are not exactly the record plus the operator rule (V-7), before any connection", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA });
    const rules = [...r.digitalOcean.trustedSources, { type: "ip_addr", value: "203.0.113.9" }, { type: "ip_addr", value: "0.0.0.0/0" }];
    const { seams, flags, out } = setup(r, fakeApi(r, {}, rules), stack);
    await expect(runStagingCommand("staging-setup", { ...flags, "--out": out }, seams)).rejects.toThrow(/unexpected trusted source ip_addr:0\.0\.0\.0\/0/);
    expect(stack.connections).toEqual([]);
  });

  it("refuses setup when a TLS control fails, before any statement beyond identity reads", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: "-----BEGIN CERTIFICATE-----\nother\n-----END CERTIFICATE-----\n" });
    const { seams, flags, out } = setup(r, fakeApi(r), stack);
    await expect(runStagingCommand("staging-setup", { ...flags, "--out": out }, seams)).rejects.toThrow(/V-4/);
    expect(stack.connections.flatMap((connection) => connection.statements)).toEqual([]);
  });

  it("verify before setup runs the TLS controls on defaultdb only and never connects to bi4_staging", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA });
    const lines: string[] = [];
    const { seams, flags } = setup(r, fakeApi(r), stack);
    expect(await runStagingCommand("staging-verify", flags, { ...seams, say: (line) => lines.push(line) })).toBe(0);
    expect(stack.connections.length).toBe(3);
    expect(stack.connections.every((connection) => new URL(connection.url).pathname === "/defaultdb")).toBe(true);
    expect(lines.some((line) => line.includes("not applicable yet"))).toBe(true);
  });

  it("makes the identity read the first statement on every operator connection (V-5)", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA, marker: r.run.marker });
    const { seams, flags } = setup(r, fakeApi(r, { db_names: ["defaultdb", "bi4_staging"] }), stack);
    expect(await runStagingCommand("staging-marker", { ...flags, "--set": "wrong" }, seams)).toBe(0);
    const opened = stack.connections.filter((connection) => connection.statements.length > 0);
    expect(opened.length).toBeGreaterThan(0);
    for (const connection of opened) expect(connection.statements[0]).toMatch(/^select current_database\(\)/);
    expect(stack.connections.some((connection) => connection.statements.some((statement) => statement.startsWith("comment on database")))).toBe(true);
  });

  it("refuses to re-mark a database whose current marker is not the recorded one, and changes nothing", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA, marker: "someone else's comment" });
    const { seams, flags } = setup(r, fakeApi(r, { db_names: ["defaultdb", "bi4_staging"] }), stack);
    await expect(runStagingCommand("staging-marker", { ...flags, "--set": "wrong" }, seams)).rejects.toThrow(/nothing was changed/);
    expect(stack.connections.some((connection) => connection.statements.some((statement) => statement.startsWith("comment on database")))).toBe(false);
  });

  it("refuses a marker change before bi4_staging exists, without connecting", async () => {
    const r = withCa();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA, marker: r.run.marker });
    const { seams, flags } = setup(r, fakeApi(r), stack);
    await expect(runStagingCommand("staging-marker", { ...flags, "--set": "wrong" }, seams)).rejects.toThrow(/does not exist yet/);
    expect(stack.connections).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* SC-13: the TLS controls and the network-filter classification                                  */
/* ------------------------------------------------------------------------------------------- */

describe("SC-13: TLS controls (V-4) and the network filter (R-8)", () => {
  const failure = (code: string, message = code) => ({ ok: false as const, error: Object.assign(new Error(message), { code }) });
  const tls = failure("SELF_SIGNED_CERT_IN_CHAIN");
  const altname = failure("ERR_TLS_CERT_ALTNAME_INVALID");
  const timeout = failure("ETIMEDOUT", "connect ETIMEDOUT");
  const refused = failure("ECONNREFUSED", "connect ECONNREFUSED");
  const ok = { ok: true as const };

  it("passes only with a successful positive control and both negatives refused by TLS verification", () => {
    expect(tlsControlProblems({ positive: ok, wrongCa: tls, ipLiteral: altname })).toEqual([]);
  });

  it("fails when a negative control is accepted", () => {
    expect(tlsControlProblems({ positive: ok, wrongCa: ok, ipLiteral: altname })).toEqual(["V-4: a CA that did not issue the server certificate was accepted"]);
    expect(tlsControlProblems({ positive: ok, wrongCa: tls, ipLiteral: ok })).toEqual(["V-4: the cluster's IP literal as the host was accepted"]);
  });

  it("requires a trust-chain failure for the wrong-CA control and a hostname mismatch for the wrong-hostname control", () => {
    for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      expect(tlsControlProblems({ positive: ok, wrongCa: failure(code), ipLiteral: altname }), code).toEqual([]);
    }
  });

  it("rejects the two expected errors when they are swapped", () => {
    const swapped = tlsControlProblems({ positive: ok, wrongCa: altname, ipLiteral: tls });
    expect(swapped).toHaveLength(2);
    expect(swapped[0]).toMatch(/a CA that did not issue.*did not fail with a trust-chain verification failure \(got certificate error ERR_TLS_CERT_ALTNAME_INVALID\).*inconclusive/);
    expect(swapped[1]).toMatch(/IP literal.*did not fail with a hostname mismatch \(ERR_TLS_CERT_ALTNAME_INVALID\) \(got certificate error SELF_SIGNED_CERT_IN_CHAIN\).*inconclusive/);
  });

  it("leaves a control inconclusive on a different certificate error, a network failure or an authentication failure", () => {
    const expired = failure("CERT_HAS_EXPIRED");
    const authentication = failure("28P01", "password authentication failed for user doadmin");
    for (const [label, outcome, pattern] of [
      ["expired certificate", expired, /certificate error CERT_HAS_EXPIRED/],
      ["timeout", timeout, /a network failure/],
      ["refused", refused, /a network failure/],
      ["authentication", authentication, /an authentication failure \(28P01\)/],
    ] as const) {
      const wrongCa = tlsControlProblems({ positive: ok, wrongCa: outcome, ipLiteral: altname });
      expect(wrongCa, `wrong-CA ${label}`).toHaveLength(1);
      expect(wrongCa[0], `wrong-CA ${label}`).toMatch(pattern);
      expect(wrongCa[0], `wrong-CA ${label}`).toMatch(/inconclusive/);
      const hostname = tlsControlProblems({ positive: ok, wrongCa: tls, ipLiteral: outcome });
      expect(hostname, `hostname ${label}`).toHaveLength(1);
      expect(hostname[0], `hostname ${label}`).toMatch(pattern);
    }
  });

  it("fails when the positive control fails, naming whether TLS or the network failed", () => {
    expect(tlsControlProblems({ positive: tls, wrongCa: tls, ipLiteral: altname })[0]).toMatch(/failed certificate verification/);
    expect(tlsControlProblems({ positive: timeout, wrongCa: tls, ipLiteral: altname })[0]).toMatch(/could not connect/);
  });

  it("R-8 requires a network refusal: success, a TLS failure or an unclassified failure all fail", () => {
    expect(networkFilterProblems(timeout)).toEqual([]);
    expect(networkFilterProblems(refused)).toEqual([]);
    expect(networkFilterProblems(ok)[0]).toMatch(/succeeded/);
    expect(networkFilterProblems(tls)[0]).toMatch(/reached TLS/);
    expect(networkFilterProblems({ ok: false, error: new Error("password authentication failed") })[0]).toMatch(/unclassified/);
  });

  it("runs the controls against the recorded host, a public root CA, and the resolved IPv4 literal, with identity reads only", async () => {
    const r = record();
    const stack = fakeOperatorSql({ goodCa: GOOD_CA });
    expect(await runTlsControls(r, GOOD_CA, "pw", stack.operatorSql, async () => "203.0.113.10")).toEqual([]);
    expect(stack.connections.map((connection) => new URL(connection.url).hostname)).toEqual([r.digitalOcean.host, r.digitalOcean.host, "203.0.113.10"]);
    expect(stack.connections[1]?.ca).not.toBe(GOOD_CA);
    expect(stack.connections.every((connection) => connection.statements.every((statement) => statement.startsWith("select current_database()")))).toBe(true);
  });

  it("R-8 through staging-verify --operator-rule none passes on a timeout and fails if the connection succeeds", async () => {
    const r = withCa();
    const files = recordFiles(r);
    try {
      const api = fakeApi(r, {}, [...r.digitalOcean.trustedSources]);
      const filtered = baseSeams({ environment: DB_ENVIRONMENT, api: () => api, operatorSql: fakeOperatorSql({ goodCa: GOOD_CA, failNetwork: true }).operatorSql });
      expect(await runStagingCommand("staging-verify", { ...files.flags, "--operator-rule": "none" }, filtered)).toBe(0);
      const open = baseSeams({ environment: DB_ENVIRONMENT, api: () => api, operatorSql: fakeOperatorSql({ goodCa: GOOD_CA }).operatorSql });
      expect(await runStagingCommand("staging-verify", { ...files.flags, "--operator-rule": "none" }, open)).toBe(1);
    } finally {
      rmSync(files.directory, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* SC-14: the operator-managed regression procedure                                               */
/* ------------------------------------------------------------------------------------------- */

describe("SC-14: regression procedure proofs", () => {
  const candidateCommit = "a".repeat(40);
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true });
  });

  it("checks the launch environment per mode (operator evidence)", () => {
    expect(modeEnvironmentProblems("PB-1", {})).toEqual([]);
    expect(modeEnvironmentProblems("PB-1", { BI4_E3_LOCAL: "1" })).toHaveLength(1);
    expect(modeEnvironmentProblems("PB-2", { BI4_E3_LOCAL: "1" })).toEqual([]);
    expect(modeEnvironmentProblems("PB-3", { BI4_STAGING: "1" })).toEqual([]);
    expect(modeEnvironmentProblems("PB-3", { BI4_STAGING: "1", BI4_STAGING_CA_PEM: "x" })).toHaveLength(1);
    expect(modeEnvironmentProblems("PB-4", { BI4_STAGING: "1", BI4_E3_LOCAL: "1", BI4_STAGING_EXPECTED_HOST: "h" })).toEqual([]);
    expect(modeEnvironmentProblems("PB-4", { BI4_STAGING: "1" })).toHaveLength(1);
    expect(modeEnvironmentProblems("PB-5", { PATH: "x" })).toHaveLength(2);
  });

  it("observes each mode's behavioural signature", () => {
    const framework404 = exchange(404, { "Content-Type": "text/html" }, "<html>404</html>");
    const plain404 = exchange(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "Not Found");
    const home = exchange(200, {}, "<html></html>");
    expect(modeSignatureProblems("PB-1", { home, directory: framework404 })).toEqual([]);
    expect(modeSignatureProblems("PB-1", { home, directory: plain404 })).toHaveLength(1);
    expect(modeSignatureProblems("PB-2", { home, directory: plain404 })).toEqual([]);
    expect(modeSignatureProblems("PB-2", { home, directory: framework404 })).toHaveLength(1);
    expect(modeSignatureProblems("PB-3", { home: GATE(), directory: GATE() })).toEqual([]);
    expect(modeSignatureProblems("PB-3", { home, directory: GATE() }).length).toBeGreaterThan(0);
    expect(modeSignatureProblems("PB-5", { home, directory: exchange(200, {}, `<a>${DEMO_LISTINGS.approved.name}</a>`) })).toEqual([]);
  });

  it("proves the commit: a registered, clean, detached worktree at the stated SHA; the baseline must be the gate baseline", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "staging-wt-"));
    cleanup.push(worktree);
    const git = (head: string, dirty: string, registered: boolean) => async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "rev-parse") return `${head}\n`;
      if (args[0] === "status") return dirty;
      if (args[0] === "worktree") return registered ? `worktree C:/repo\nHEAD ${"9".repeat(40)}\nbranch refs/heads/main\n\nworktree ${worktree.replace(/\\/g, "/")}\nHEAD ${head}\ndetached\n` : "worktree C:/repo\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const seams = (head: string, dirty = "", registered = true) => ({ git: git(head, dirty, registered), repositoryRoot: join(tmpdir(), "elsewhere-repo") });
    expect(await worktreeProblems(seams(GATE_BASELINE_COMMIT), worktree, GATE_BASELINE_COMMIT, "baseline")).toEqual([]);
    expect(await worktreeProblems(seams(candidateCommit), worktree, candidateCommit, "candidate")).toEqual([]);
    expect(await worktreeProblems(seams(candidateCommit), worktree, candidateCommit, "baseline")).toContainEqual(expect.stringMatching(/gate baseline/));
    expect(await worktreeProblems(seams("b".repeat(40)), worktree, candidateCommit, "candidate")).toContainEqual(expect.stringMatching(/is at/));
    expect(await worktreeProblems(seams(candidateCommit, " M src/proxy.ts"), worktree, candidateCommit, "candidate")).toContainEqual(expect.stringMatching(/tracked changes/));
    expect(await worktreeProblems(seams(candidateCommit, "", false), worktree, candidateCommit, "candidate")).toContainEqual(expect.stringMatching(/not registered/));
  });

  it("proves the server: one loopback listener whose process runs Next.js from this worktree", async () => {
    // Host-native absolute paths: a Windows-style literal such as `C:\wt\candidate` is not absolute
    // under POSIX, so `resolve()` would place it under the working directory on Linux CI.
    const worktree = mkdtempSync(join(tmpdir(), "staging-identity-wt-"));
    const otherWorktree = mkdtempSync(join(tmpdir(), "staging-identity-other-"));
    cleanup.push(worktree, otherWorktree);
    const nextBin = (root: string) => join(root, "node_modules", "next", "dist", "bin", "next");
    const identity: ProcessIdentity = { pid: 4242, parentPid: 1, creationTime: "133000000000000000", executable: process.execPath, commandLine: `"${process.execPath}" ${nextBin(worktree)} start -p 3101` };
    const seams = (entries: ListeningEntry[], live: ProcessIdentity | undefined) => ({ listeners: async () => entries, processes: { inspect: async () => live, listener: async () => undefined } });
    const origin = "http://127.0.0.1:3101";
    expect((await serverIdentityProblems(seams([{ localAddress: "127.0.0.1", owningProcess: 4242 }], identity), origin, worktree)).problems).toEqual([]);
    expect((await serverIdentityProblems(seams([], undefined), origin, worktree)).problems[0]).toMatch(/nothing listens/);
    expect((await serverIdentityProblems(seams([{ localAddress: "0.0.0.0", owningProcess: 4242 }], identity), origin, worktree)).problems[0]).toMatch(/not on 127\.0\.0\.1/);
    expect((await serverIdentityProblems(seams([{ localAddress: "127.0.0.1", owningProcess: 4242 }], { ...identity, commandLine: `"${process.execPath}" ${nextBin(otherWorktree)} start -p 3101` }), origin, worktree)).problems[0]).toMatch(/not run from this worktree/);
  });

  it("proves the build: the served asset equals this worktree's .next output", () => {
    const worktree = mkdtempSync(join(tmpdir(), "staging-build-"));
    cleanup.push(worktree);
    mkdirSync(join(worktree, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(join(worktree, ".next", "static", "chunks", "a.js"), "console.log(1)");
    expect(assetProofProblems(worktree, "/_next/static/chunks/a.js", exchange(200, {}, "console.log(1)"))).toEqual([]);
    expect(assetProofProblems(worktree, "/_next/static/chunks/a.js", exchange(200, {}, "console.log(2)"))[0]).toMatch(/differs/);
    expect(assetProofProblems(worktree, "/_next/static/chunks/b.js", exchange(200, {}, "x"))[0]).toMatch(/not in this worktree/);
    expect(assetProofProblems(worktree, undefined, undefined)[0]).toMatch(/not proven/);
  });

  const capture = (overrides: Partial<RegressionCapture>): RegressionCapture => ({
    schema: "bi4-staging-regress-capture/1",
    mode: "PB-1",
    side: "baseline",
    origin: "http://127.0.0.1:3101",
    commit: GATE_BASELINE_COMMIT,
    worktree: "C:/wt/baseline",
    launchEnvironment: { kind: "operator attestation", sha256: "0".repeat(64), variables: {}, corroboration: "" },
    stoppedAt: null,
    server: { port: 3101, identity: { pid: 1, parentPid: 0, creationTime: "1", executable: "node", commandLine: "next" } },
    buildId: null,
    startedAt: CREATED,
    endedAt: CREATED,
    attempts: 1,
    problems: [],
    exchanges: [],
    ...overrides,
  });
  const captured = (path: string, status: number, body: string, headers: string[] = ["Content-Type", "text/html"], method = "GET"): CapturedExchange => ({ method, path, status, rawHeaders: headers, bodyBase64: Buffer.from(body).toString("base64") });

  it("compares PB-1 captures, and refuses a wrong baseline commit, a dirty capture, a different request list or a changed response", () => {
    const exchanges = [captured("/", 200, "home"), captured("/admin", 404, "nf")];
    const baseline = capture({ exchanges });
    const candidate = capture({ side: "candidate", commit: candidateCommit, worktree: "C:/wt/candidate", exchanges });
    expect(compareCaptures("PB-1", baseline, candidate)).toEqual([]);
    expect(compareCaptures("PB-1", capture({ exchanges, commit: "b".repeat(40) }), candidate)).toContainEqual(expect.stringMatching(/not the gate baseline/));
    expect(compareCaptures("PB-1", baseline, { ...candidate, problems: ["x"] })).toContainEqual(expect.stringMatching(/precondition/));
    expect(compareCaptures("PB-1", baseline, { ...candidate, exchanges: [exchanges[0] as CapturedExchange] })).toContainEqual(expect.stringMatching(/different request lists/));
    expect(compareCaptures("PB-1", baseline, { ...candidate, exchanges: [exchanges[0] as CapturedExchange, captured("/admin", 200, "oops")] }).length).toBeGreaterThan(0);
    expect(compareCaptures("PB-1", undefined, candidate)).toContainEqual(expect.stringMatching(/needs a baseline/));
  });

  it("PB-3 needs only a candidate capture, and requires deny-all", () => {
    const gate = (path: string) => captured(path, 404, "Not Found", ["Content-Type", "text/plain; charset=utf-8", "Cache-Control", "no-store"]);
    expect(compareCaptures("PB-3", undefined, capture({ mode: "PB-3", side: "candidate", commit: candidateCommit, exchanges: [gate("/"), gate("/admin")] }))).toEqual([]);
    expect(compareCaptures("PB-3", undefined, capture({ mode: "PB-3", side: "candidate", commit: candidateCommit, exchanges: [captured("/", 200, "home")] })).length).toBeGreaterThan(0);
  });

  it("PB-5 compares the demo listing pages after the dev request-ID mask, and requires the right content on both sides", () => {
    const page = (requestId: string, content: string) => `<html>${content}<script id="_R_">self.__next_r="${requestId}";if(document.cookie.indexOf('next-instant-navigation-testing=')>-1){x}</script></html>`;
    const side = (id: string, overrides: Record<number, string> = {}) =>
      demoRequests().map((request, index) =>
        captured(request.path, 200, overrides[index] ?? page(id, index === 0 ? `<a>${DEMO_LISTINGS.approved.name}</a>` : index === 1 ? `<h1>${DEMO_LISTINGS.approved.name}</h1>` : "<h1>Not available</h1>")),
      );
    const baselineId = "A".repeat(21);
    const candidateId = "B".repeat(21);
    expect(demoComparisonProblems(side(baselineId), side(candidateId))).toEqual([]);
    expect(demoComparisonProblems(side(baselineId), side(candidateId, { 1: page(candidateId, "<h1>Not available</h1>") })).length).toBeGreaterThan(0);
    expect(demoComparisonProblems(side(baselineId), side(candidateId, { 2: page(candidateId, `<h1>${DEMO_LISTINGS.pending.name}</h1>`) })).length).toBeGreaterThan(0);
  });

  it("proves teardown: process gone, port free, worktree gone and unregistered, main tree clean", async () => {
    const recorded: ProcessIdentity = { pid: 4242, parentPid: 1, creationTime: "5", executable: "node", commandLine: "next" };
    const gone = join(tmpdir(), "staging-wt-gone-never-created");
    const c = capture({ server: { port: 3101, identity: recorded }, worktree: gone });
    const seams = (o: { live?: ProcessIdentity; listeners?: ListeningEntry[]; worktrees?: string; status?: string }) => ({
      git: async (_cwd: string, args: readonly string[]) => (args[0] === "worktree" ? (o.worktrees ?? "worktree C:/repo\n") : (o.status ?? "?? CLAUDE.md\n?? community-directory-through-issue-51-handoff.txt\n")),
      listeners: async () => o.listeners ?? [],
      processes: { inspect: async () => o.live, listener: async () => undefined },
      repositoryRoot: "C:/repo",
    });
    expect(await regressionTeardownProblems(seams({}), [c])).toEqual([]);
    expect(await regressionTeardownProblems(seams({ live: { ...recorded, creationTime: "9" } }), [c])).toEqual([]);
    expect(await regressionTeardownProblems(seams({ live: recorded }), [c])).toContainEqual(expect.stringMatching(/still running/));
    expect(await regressionTeardownProblems(seams({ listeners: [{ localAddress: "127.0.0.1", owningProcess: 7 }] }), [c])).toContainEqual(expect.stringMatching(/still has a listener/));
    expect(await regressionTeardownProblems(seams({ worktrees: `worktree C:/repo\n\nworktree ${gone.replace(/\\/g, "/")}\nHEAD x\ndetached\n` }), [c])).toContainEqual(expect.stringMatching(/still registered/));
    expect(await regressionTeardownProblems(seams({ status: "?? CLAUDE.md\n M src/proxy.ts\n" }), [c])).toContainEqual(expect.stringMatching(/unexpected status line/));
    expect(await regressionTeardownProblems(seams({}), [capture({ server: { port: 1, identity: null }, worktree: gone })])).toContainEqual(expect.stringMatching(/no server identity/));
  });

  it("R-1 scans the client assets of a completed build", () => {
    const worktree = mkdtempSync(join(tmpdir(), "staging-scan-"));
    cleanup.push(worktree);
    expect(buildScanProblems(worktree)[0]).toMatch(/BUILD_ID/);
    mkdirSync(join(worktree, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(join(worktree, ".next", "BUILD_ID"), "abc");
    writeFileSync(join(worktree, ".next", "static", "chunks", "a.js"), "ok");
    expect(buildScanProblems(worktree)).toEqual([]);
    writeFileSync(join(worktree, ".next", "static", "chunks", "b.js"), "process.env.BI4_STAGING_KEY");
    expect(buildScanProblems(worktree)[0]).toMatch(/contains BI4_STAGING/);
  });

  /**
   * A capture rig where every stage passes unless an option breaks one: a real worktree directory
   * with a built asset, fake Git and process lookups that agree with it, and an HTTP fake that
   * records every request sent.
   */
  function captureRig(options: {
    head?: string;
    variables?: Record<string, string>;
    commandLine?: string;
    gitThrows?: boolean;
    listenersThrow?: boolean;
    directoryBody?: string;
    assetBody?: string;
  } = {}) {
    const worktree = mkdtempSync(join(tmpdir(), "staging-capture-wt-"));
    const out = mkdtempSync(join(tmpdir(), "staging-capture-out-"));
    cleanup.push(worktree, out);
    mkdirSync(join(worktree, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(join(worktree, ".next", "static", "chunks", "a.js"), "built");
    writeFileSync(join(worktree, ".next", "BUILD_ID"), "build-1");
    const environment = join(out, "env.json");
    writeFileSync(environment, JSON.stringify({ variables: options.variables ?? {} }));
    const sent: string[] = [];
    const seams = baseSeams({
      repositoryRoot: join(tmpdir(), "elsewhere-repo"),
      git: async (_cwd, args) => {
        if (options.gitThrows) throw new Error("not a git worktree");
        if (args[0] === "rev-parse") return `${options.head ?? candidateCommit}\n`;
        if (args[0] === "status") return "";
        return `worktree ${worktree.replace(/\\/g, "/")}\nHEAD ${candidateCommit}\ndetached\n`;
      },
      listeners: async () => {
        if (options.listenersThrow) throw new Error("ProcessInspectionError: the listener lookup failed");
        return [{ localAddress: "127.0.0.1", owningProcess: 4242 }];
      },
      processes: {
        inspect: async () => ({ pid: 4242, parentPid: 1, creationTime: "133", executable: "node.exe", commandLine: options.commandLine ?? `node ${worktree}\\node_modules\\next\\dist\\bin\\next start -p 3101` }),
        listener: async () => 4242,
      },
      transport: async (_origin, request) => {
        sent.push(`${request.method} ${request.path}`);
        if (request.path === "/") return exchange(200, {}, '<script src="/_next/static/chunks/a.js"></script>');
        if (request.path === "/directory") return exchange(404, { "Content-Type": "text/html" }, options.directoryBody ?? "<html>framework 404</html>");
        if (request.path === "/_next/static/chunks/a.js") return exchange(200, {}, options.assetBody ?? "built");
        return exchange(404, {}, "x");
      },
    });
    const flags = { "--mode": "PB-1", "--side": "candidate", "--url": "http://127.0.0.1:3101", "--worktree": worktree, "--commit": candidateCommit, "--environment": environment, "--out": out };
    const read = (): RegressionCapture => JSON.parse(readFileSync(join(out, captureFileName("PB-1", "candidate")), "utf8")) as RegressionCapture;
    return { seams, flags, sent, read, out };
  }

  it("sends the matrix only when every stage passes, and labels the launch environment as operator attestation", async () => {
    const rig = captureRig();
    expect(await runLoopbackCommand("staging-regress-capture", rig.flags, rig.seams)).toBe(0);
    expect(rig.sent.slice(0, 3)).toEqual(["GET /", "GET /directory", "GET /_next/static/chunks/a.js"]);
    expect(rig.sent.length).toBe(3 + 25 * 4);
    const capture = rig.read();
    expect(capture.stoppedAt).toBeNull();
    expect(capture.launchEnvironment.kind).toBe("operator attestation");
    expect(capture.launchEnvironment.corroboration).toMatch(/HTTP signature/);
  });

  for (const [label, options] of [
    ["a worktree finding (HEAD is another commit)", { head: "b".repeat(40) }],
    ["a declared-environment finding (BI4_E3_LOCAL attested under PB-1)", { variables: { BI4_E3_LOCAL: "1" } }],
    ["a listener-identity finding (the process runs from another worktree)", { commandLine: "node C:\\other\\next start" }],
  ] as const) {
    it(`stops before any HTTP request on ${label}, and records where it stopped`, async () => {
      const rig = captureRig(options);
      expect(await runLoopbackCommand("staging-regress-capture", rig.flags, rig.seams)).toBe(1);
      expect(rig.sent).toEqual([]);
      const capture = rig.read();
      expect(capture.stoppedAt).toMatch(/before any HTTP request/);
      expect(capture.exchanges).toEqual([]);
      expect(capture.problems.length).toBeGreaterThan(0);
    });
  }

  it("stops before any HTTP request when a stage-1 check throws, and writes nothing", async () => {
    for (const options of [{ gitThrows: true }, { listenersThrow: true }]) {
      const rig = captureRig(options);
      await expect(runLoopbackCommand("staging-regress-capture", rig.flags, rig.seams)).rejects.toThrow(/not a git worktree|listener lookup failed/);
      expect(rig.sent, JSON.stringify(options)).toEqual([]);
      expect(existsSync(join(rig.out, captureFileName("PB-1", "candidate")))).toBe(false);
    }
  });

  it("skips the matrix when the mode-signature probe fails", async () => {
    const rig = captureRig({ directoryBody: "Not Found" });
    expect(await runLoopbackCommand("staging-regress-capture", rig.flags, rig.seams)).toBe(1);
    expect(rig.sent).toEqual(["GET /", "GET /directory", "GET /_next/static/chunks/a.js"]);
    expect(rig.read().stoppedAt).toMatch(/matrix was skipped/);
  });

  it("skips the matrix when the build probe fails", async () => {
    const rig = captureRig({ assetBody: "a different build" });
    expect(await runLoopbackCommand("staging-regress-capture", rig.flags, rig.seams)).toBe(1);
    expect(rig.sent).toEqual(["GET /", "GET /directory", "GET /_next/static/chunks/a.js"]);
    expect(rig.read().stoppedAt).toMatch(/matrix was skipped/);
    expect(rig.read().exchanges).toEqual([]);
  });

  it("never overwrites a capture", async () => {
    const rig = captureRig();
    writeFileSync(join(rig.out, captureFileName("PB-1", "candidate")), "{}");
    await expect(runLoopbackCommand("staging-regress-capture", rig.flags, rig.seams)).rejects.toThrow(/never overwritten/);
    expect(rig.sent).toEqual([]);
  });

  it("states that PB-3 and PB-4 cannot be distinguished by HTTP behaviour", () => {
    for (const mode of ["PB-3", "PB-4"] as const) expect(ATTESTATION_CORROBORATION[mode]).toMatch(/cannot be distinguished by HTTP behaviour/);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* SC-15: the coverage table                                                                       */
/* ------------------------------------------------------------------------------------------- */

describe("SC-15: readiness coverage", () => {
  it("names every gate check and states the evidence still owed", () => {
    const ids = READINESS_COVERAGE.flatMap((entry) => entry.id.replace(/\s*\(.*?\)/g, "").split(/,\s*/));
    for (const id of ["P-0", "R-0", "R-1", "R-2", "R-2b", "R-3", "R-4", "R-5", "R-6", "R-7", "R-8", "R-9", "R-10", "R-11", "R-12", "M-1", "M-2", "M-3", "M-4", "M-5", "M-6", "M-7", "M-8", "T-1", "T-2", "T-3", "T-4", "T-5", "T-6"]) {
      expect(ids, id).toContain(id);
    }
    expect(READINESS_COVERAGE.find((entry) => entry.id === "R-11")?.kind).toBe("not implemented");
    expect(READINESS_COVERAGE.every((entry) => entry.outstanding.length > 0)).toBe(true);
  });
});
