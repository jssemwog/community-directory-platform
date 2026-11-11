/**
 * The staging status payload (issue #246, OP-2 staging Scope Gate revision 2 §7.5).
 *
 * Served only under the staging mode, behind the proxy's key gate, at `GET /bi4-staging/status`.
 * It reports process identity (to detect restarts and redeploys), the data source's state, the
 * read counters and the side-by-side calibration and event-loop summaries.
 *
 * **It never returns a connection value, the marker, the digest or the key.** The Render values are
 * the platform's own runtime variables (`RENDER_SERVICE_ID`, `RENDER_INSTANCE_ID`,
 * `RENDER_GIT_COMMIT`, `RENDER_EXTERNAL_HOSTNAME`). A missing one is reported as `null`.
 *
 * **Report-only fields.** The event-loop histogram and the realized calibration delays are reported
 * side by side, for the same window. The calibration delays are **not** subtracted from the
 * histogram, and no sampled stall is attributed to a cause (approval ruling 2).
 */

import type { StagingSnapshot } from "./staging-persistence";

export const STATUS_SCHEMA = "bi4-staging-status/1";

export interface StagingStatusPayload {
  readonly schema: typeof STATUS_SCHEMA;
  readonly bootNonce: string;
  readonly render: {
    readonly serviceId: string | null;
    readonly instanceId: string | null;
    readonly gitCommit: string | null;
    readonly externalHostname: string | null;
  };
  readonly state: StagingSnapshot["state"];
  readonly counters: {
    readonly s2Reads: number;
    readonly refusals: number;
    readonly readsAfterRefusal: number;
    readonly overlappedReads: number;
  };
  /** Same window for both; reported side by side, neither derived from the other. */
  readonly sinceLastStatus: {
    readonly eventLoop: StagingSnapshot["eventLoopSinceLastStatus"];
    readonly calibration: StagingSnapshot["calibrationSinceLastStatus"];
  };
  readonly calibration: {
    readonly enabled: boolean;
    readonly total: StagingSnapshot["calibrationTotal"];
  };
  readonly notes: readonly string[];
}

export const STATUS_NOTES: readonly string[] = Object.freeze([
  "overlappedReads counts reads that began while another read was in progress, observed at dispatch into the persistence; it does not observe arrival or waiting.",
  "The event-loop histogram is report-only; calibration delays are reported beside it and not subtracted; stalls are not attributed to a cause.",
]);

const valueOrNull = (value: string | undefined): string | null => (value === undefined || value === "" ? null : value);

/** Build the payload from a snapshot and the process environment. Pure. */
export function stagingStatusPayload(snapshot: StagingSnapshot, environment: Readonly<Record<string, string | undefined>>): StagingStatusPayload {
  return {
    schema: STATUS_SCHEMA,
    bootNonce: snapshot.bootNonce,
    render: {
      serviceId: valueOrNull(environment.RENDER_SERVICE_ID),
      instanceId: valueOrNull(environment.RENDER_INSTANCE_ID),
      gitCommit: valueOrNull(environment.RENDER_GIT_COMMIT),
      externalHostname: valueOrNull(environment.RENDER_EXTERNAL_HOSTNAME),
    },
    state: snapshot.state,
    counters: {
      s2Reads: snapshot.s2Reads,
      refusals: snapshot.refusals,
      readsAfterRefusal: snapshot.readsAfterRefusal,
      overlappedReads: snapshot.overlappedReads,
    },
    sinceLastStatus: {
      eventLoop: snapshot.eventLoopSinceLastStatus,
      calibration: snapshot.calibrationSinceLastStatus,
    },
    calibration: { enabled: snapshot.calibrationEnabled, total: snapshot.calibrationTotal },
    notes: STATUS_NOTES,
  };
}

/** The response headers for the payload. */
export const STATUS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});
