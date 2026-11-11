/**
 * `staging-status.ts` and the status view (issue #246, OP-2 staging Scope Gate revision 2 §7.5, as
 * amended by A1 revision 2, option D).
 *
 * SS-1 the payload's fields and side-by-side windows; SS-2 no secrets; SS-3 / A1-U7 there is no
 * status route (D-G1); A1-U10 `statusViewFor`; A1-U11 the script-element escaping; A1-U12 the page's
 * status branch never reads. Equality with the baseline outside staging is checked by the
 * separately authorized PB run, not here.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { STAGING_STATUS_IDENTITY } from "./staging-access";
import type { StagingSnapshot } from "./staging-persistence";
import { jsonForScriptElement, STATUS_ELEMENT_ID, STATUS_SCHEMA, stagingStatusPayload, statusViewFor } from "./staging-status";

const snapshot: StagingSnapshot = {
  bootNonce: "b".repeat(32),
  state: "verified",
  s2Reads: 7,
  refusals: 0,
  readsAfterRefusal: 0,
  overlappedReads: 0,
  calibrationEnabled: true,
  calibrationSinceLastStatus: [{ nominalNs: 1000, count: 2, minNs: 1100, p50Ns: 1100, p99Ns: 1200, maxNs: 1200, overruns: 0 }],
  calibrationTotal: [{ nominalNs: 1000, count: 5, minNs: 1100, p50Ns: 1150, p99Ns: 1300, maxNs: 1300, overruns: 0 }],
  eventLoopSinceLastStatus: { resolutionMs: 1, samples: 40, minNs: 1_000_000, meanNs: 1_100_000, p50Ns: 1_050_000, p99Ns: 2_000_000, maxNs: 2_100_000 },
};

describe("SS-1: the payload", () => {
  it("reports identity, state, counters and the two same-window summaries side by side", () => {
    const payload = stagingStatusPayload(snapshot, {
      RENDER_SERVICE_ID: "srv-abc",
      RENDER_INSTANCE_ID: "srv-abc-xyz",
      RENDER_GIT_COMMIT: "c".repeat(40),
      RENDER_EXTERNAL_HOSTNAME: "bi4.onrender.com",
    });
    expect(payload.schema).toBe(STATUS_SCHEMA);
    expect(payload.bootNonce).toBe("b".repeat(32));
    expect(payload.render).toEqual({ serviceId: "srv-abc", instanceId: "srv-abc-xyz", gitCommit: "c".repeat(40), externalHostname: "bi4.onrender.com" });
    expect(payload.state).toBe("verified");
    expect(payload.counters).toEqual({ s2Reads: 7, refusals: 0, readsAfterRefusal: 0, overlappedReads: 0 });
    expect(payload.sinceLastStatus.eventLoop).toBe(snapshot.eventLoopSinceLastStatus);
    expect(payload.sinceLastStatus.calibration).toBe(snapshot.calibrationSinceLastStatus);
    expect(payload.calibration).toEqual({ enabled: true, total: snapshot.calibrationTotal });
    expect(payload.notes.join(" ")).toMatch(/not subtracted/);
  });

  it("reports a missing Render variable as null", () => {
    expect(stagingStatusPayload(snapshot, {}).render).toEqual({ serviceId: null, instanceId: null, gitCommit: null, externalHostname: null });
  });
});

describe("SS-2: no secrets", () => {
  it("reads only the four Render variables from the environment", () => {
    const environment = {
      RENDER_SERVICE_ID: "srv-abc",
      BI4_STAGING_DATABASE_URL: "postgres://u:secretsecretsecret1@h:1/bi4_staging",
      BI4_STAGING_ACCESS_KEY_SHA256: "a".repeat(64),
      BI4_STAGING_SYNTHETIC_MARKER: `bi4-staging-synthetic:${"d".repeat(32)}`,
      BI4_STAGING_CA_PEM: "-----BEGIN CERTIFICATE-----",
    };
    const text = JSON.stringify(stagingStatusPayload(snapshot, environment));
    for (const name of Object.keys(environment).filter((name) => name.startsWith("BI4_"))) {
      expect(text).not.toContain(environment[name as keyof typeof environment]);
    }
  });
});

describe("SS-3 / A1-U7: no status route (D-G1)", () => {
  it("has no route file under src/app/bi4-staging, so /bi4-staging/status is a missing route in every build", () => {
    expect(existsSync(fileURLToPath(new URL("../../app/bi4-staging/status/route.ts", import.meta.url)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL("../../app/bi4-staging", import.meta.url)))).toBe(false);
  });
});

/** A fake staging handle that records calls; `read` must never be called by the status view. */
function fakeStaging(precheckResult: "ok" | "refused", state: StagingSnapshot["state"]) {
  const calls: string[] = [];
  const staging = {
    async precheck() {
      calls.push("precheck");
      return precheckResult;
    },
    status() {
      calls.push("status");
      return { ...snapshot, state };
    },
    async read() {
      calls.push("read");
      throw new Error("the status view must not read");
    },
  };
  return { calls, staging };
}

describe("A1-U10: statusViewFor", () => {
  const environment = {
    RENDER_SERVICE_ID: "srv-abc",
    BI4_STAGING_DATABASE_URL: "postgres://u:secretsecretsecret1@h:1/bi4_staging",
    BI4_STAGING_ACCESS_KEY_SHA256: "a".repeat(64),
    BI4_STAGING_SYNTHETIC_MARKER: `bi4-staging-synthetic:${"d".repeat(32)}`,
  };

  it("returns null for every source other than staging, and for no source", async () => {
    for (const kind of ["demo", "e3-local"]) {
      expect(await statusViewFor({ kind }, STAGING_STATUS_IDENTITY, environment), kind).toBeNull();
    }
    expect(await statusViewFor(undefined, STAGING_STATUS_IDENTITY, environment)).toBeNull();
  });

  it("returns null for any other identity under staging, without touching the handle", async () => {
    const { calls, staging } = fakeStaging("ok", "verified");
    for (const identity of ["9f0c5a1e-3b7d-4c2a-8e6f-1a2b3c4d5e6f", "__BI4_STATUS__", "__bi4_status__x", "e3-malformed-1", ""]) {
      expect(await statusViewFor({ kind: "staging", staging }, identity, environment), identity).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("for the reserved identity: pre-checks, then reports status, never reads; no secret appears", async () => {
    const { calls, staging } = fakeStaging("ok", "verified");
    const json = await statusViewFor({ kind: "staging", staging }, STAGING_STATUS_IDENTITY, environment);
    expect(calls).toEqual(["precheck", "status"]);
    const payload = JSON.parse(json as string);
    expect(payload.schema).toBe(STATUS_SCHEMA);
    expect(payload.state).toBe("verified");
    for (const name of Object.keys(environment).filter((name) => name.startsWith("BI4_"))) {
      expect(json).not.toContain(environment[name as keyof typeof environment]);
    }
  });

  it("a refused pre-check still reports the payload, with state refused (the S-7 case), and never reads", async () => {
    const { calls, staging } = fakeStaging("refused", "refused");
    const payload = JSON.parse((await statusViewFor({ kind: "staging", staging }, STAGING_STATUS_IDENTITY, {})) as string);
    expect(payload.state).toBe("refused");
    expect(calls).not.toContain("read");
  });
});

describe("A1-U11: JSON safe inside a script element", () => {
  it("escapes <, >, &, U+2028 and U+2029, and parses back to the same value", () => {
    const value = { a: "</script><!-- &amp;", b: `x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x2029)}z` };
    const text = jsonForScriptElement(value);
    expect(text).not.toMatch(/[<>&]/);
    expect(text).not.toContain(String.fromCharCode(0x2028));
    expect(text).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe("A1-U12: the page's status branch", () => {
  const page = readFileSync(fileURLToPath(new URL("../../app/directory/[listingId]/page.tsx", import.meta.url)), "utf8");

  it("calls statusViewFor before any OP-2 read, and returns before reading when it yields a view", () => {
    const view = page.indexOf("await statusViewFor(source, listingId, process.env)");
    expect(view).toBeGreaterThan(0);
    for (const read of ["findPubliclyAvailableListing(source", "source.e3.read(", "source.staging.read("]) {
      expect(page.indexOf(read), read).toBeGreaterThan(view);
    }
    const branch = page.slice(view, page.indexOf("const outcome ="));
    expect(branch).toMatch(/if \(statusJson !== null\) \{\s*return <script type="application\/json" id=\{STATUS_ELEMENT_ID\}/);
    expect(branch).not.toMatch(/\.read\(/);
    expect(STATUS_ELEMENT_ID).toBe("bi4-staging-status");
  });

  it("leaves the directory layout's pre-check unchanged (the layout is not edited by amendment A1)", () => {
    const layout = readFileSync(fileURLToPath(new URL("../../app/directory/layout.tsx", import.meta.url)), "utf8");
    expect(layout).toMatch(/if \(source\.kind === "staging" && \(await source\.staging\.precheck\(\)\) === "refused"\) \{\s*notFound\(\);/);
  });
});
