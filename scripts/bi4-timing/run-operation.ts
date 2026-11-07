/**
 * The E1 runner for the `BI-4` timing pilot (issue #246; harness gate revision 5 §6; timing Scope
 * Gate revision 4 §2, §4.1). **Diagnostic only.**
 *
 * Calls `findPubliclyAvailableListing` in-process, one request at a time, in the plan's order. For
 * each request `process.hrtime.bigint()` is read immediately before and immediately after the
 * awaited call. For `DL` identities the call is the E1-only delay wrapper — a busy-wait of the
 * explicit d followed by the same call — so d lies inside the timed region by construction. The
 * wrapper lives here, never in `src/`.
 *
 * It also records what each call returned: a hash of the value's canonical serialization, and
 * whether the error is the same frozen reference `OP-2` returns for every unavailable outcome.
 * The analyzer requires those to agree exactly across the four states before interpreting E1.
 */

import type { Kysely } from "kysely";

import type { ListingDatabase } from "../../src/data/listing-table";
import { findPubliclyAvailableListing } from "../../src/data/public-listing-read";
import type { MeasurementRecord } from "./analyze";
import { sha256Hex } from "./body-compare";
import { busyWaitNs } from "./calibration-server";
import type { Plan, PlanIdentity } from "./schedule";

/** A deterministic serialization: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export interface RunControl {
  readonly signal: AbortSignal;
  /** Stop after this many requests in total (smoke caps). */
  readonly requestCap: number;
  readonly onRecord: (record: MeasurementRecord) => void;
  /**
   * Called after each measured request with the running count, outside the timed region. If it
   * returns a promise (the S-C checkpoint), no further request is sent until it settles.
   */
  readonly onMeasured?: (count: number) => void | Promise<void>;
}

export interface RunOutcome {
  readonly completed: number;
  readonly stoppedBy?: "abort" | "cap";
}

export async function runOperation(plan: Plan, db: Kysely<ListingDatabase>, control: RunControl): Promise<RunOutcome> {
  // The frozen unavailable reference, obtained without any query: a non-UUID identity is refused
  // before the database is reached. This is not a planned request and is not recorded.
  const reference = await findPubliclyAvailableListing(db, "reference-probe");
  const sharedReference = reference.ok ? undefined : reference.error;
  let completed = 0;
  let measured = 0;

  for (const request of plan.requests) {
    if (control.signal.aborted) return { completed, stoppedBy: "abort" };
    if (completed >= control.requestCap) return { completed, stoppedBy: "cap" };

    const identity = plan.identities[request.identity] as PlanIdentity;
    const delay = identity.cls === "DL" ? (plan.delaysNs[identity.delayIndex as number] as number) : 0;
    // For DL, the awaited call is the wrapper: busy-wait d, then the same operation.
    const call =
      delay > 0
        ? () => {
            busyWaitNs(delay);
            return findPubliclyAvailableListing(db, identity.key);
          }
        : () => findPubliclyAvailableListing(db, identity.key);
    const start = process.hrtime.bigint();
    const outcome = await call();
    const elapsed = process.hrtime.bigint() - start;

    control.onRecord({
      sequence: request.sequence,
      phase: request.phase,
      block: request.block,
      identity: request.identity,
      cls: identity.cls,
      target: identity.target,
      elapsedNs: elapsed.toString(),
      valueHash: sha256Hex(canonicalJson(outcome)),
      sharedErrorReference: !outcome.ok && sharedReference !== undefined && outcome.error === sharedReference,
    });

    completed += 1;

    if (request.phase === "measured") {
      measured += 1;
      const held = control.onMeasured?.(measured);
      if (held !== undefined) await held;
    }
  }

  return { completed };
}
