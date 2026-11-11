/**
 * `staging-status.ts` and the status route (issue #246, OP-2 staging Scope Gate revision 2 §7.5).
 *
 * SS-1 the payload's fields and side-by-side windows; SS-2 no secrets; SS-3 the route is inert
 * outside the staging mode and exports every method (D-G1). Byte equality with the framework's
 * not-found page is checked by the separately authorized PB-1 run, not here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { StagingSnapshot } from "./staging-persistence";
import { STATUS_HEADERS, STATUS_SCHEMA, stagingStatusPayload } from "./staging-status";

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
    expect(STATUS_HEADERS["Cache-Control"]).toBe("no-store");
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

describe("SS-3: the status route", () => {
  const source = readFileSync(fileURLToPath(new URL("../../app/bi4-staging/status/route.ts", import.meta.url)), "utf8");

  it("exports every HTTP method, so none falls back to Next's automatic 405 or OPTIONS reply", () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(source, method).toMatch(new RegExp(`export (async function|const) ${method}\\b`));
    }
  });

  it("answers notFound() unless the staging mode is on, and every other method always answers notFound()", () => {
    expect(source).toMatch(/if \(source\.kind !== "on"\) \{\s*notFound\(\);/);
    expect(source).toMatch(/async function absent\(\): Promise<Response> \{\s*notFound\(\);\s*\}/);
  });
});
