/**
 * The staging status payload (issue #246, OP-2 staging Scope Gate revision 2 §7.5).
 *
 * Served only under the staging source, behind the proxy's key gate, at the reserved `S2` identity
 * `GET /directory/__bi4_status__` (amendment A1, option D). The page renders it as JSON in one
 * `<script type="application/json" id="bi4-staging-status">` element, after the directory layout's
 * pre-check. A cold refusing process never reaches the page: the layout answers 404 first.
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

import { STAGING_STATUS_IDENTITY } from "./staging-access";
import type { StagingHandle, StagingSnapshot } from "./staging-persistence";

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

/** The id of the one element that carries the status JSON in the page. */
export const STATUS_ELEMENT_ID = "bi4-staging-status";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON safe to place inside a `<script>` element: `<`, `>`, `&`, U+2028 and U+2029 are escaped, so
 * the payload can never close the element or start a comment. `JSON.parse` reads it back unchanged.
 */
export function jsonForScriptElement(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEPARATOR)
    .join("\\" + "u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\" + "u2029");
}

/** The slice of a public read source the status view needs. */
export type StatusViewSource = { readonly kind: "staging"; readonly staging: Pick<StagingHandle, "precheck" | "status"> } | { readonly kind: string };

/**
 * The status view for one `S2` request, or `null`.
 *
 * Returns `null`, so the page takes its ordinary path, for every source other than staging (the
 * demo, `E3-local`, none) and for every identity other than the reserved one. For the reserved
 * identity under staging, it runs the pre-check (as the layout does) and returns the escaped payload
 * JSON. **It never calls `read()`,** so status reads do not count as listing reads. A refused
 * pre-check still returns the payload, with `state: "refused"`. That can only show when the refusal
 * arrived after the layout's own pre-check passed (S-7); a cold refusing process is answered 404 by
 * the layout first.
 */
export async function statusViewFor(
  source: StatusViewSource | undefined,
  listingId: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (source === undefined || source.kind !== "staging" || listingId !== STAGING_STATUS_IDENTITY) return null;
  const staging = (source as { staging: Pick<StagingHandle, "precheck" | "status"> }).staging;
  await staging.precheck();
  return jsonForScriptElement(stagingStatusPayload(staging.status(), environment));
}
