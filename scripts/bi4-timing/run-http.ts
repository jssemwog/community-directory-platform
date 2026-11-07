/**
 * The E2 runner for the `BI-4` timing pilot (issue #246; harness gate revision 5 §6, §11; timing
 * Scope Gate revision 4 §2, §3.4). **Exploratory only.**
 *
 * One client — this process — sends one request at a time, in the plan's order, across `next dev`
 * and the calibration server. Each target has its own keep-alive agent with `maxSockets = 1`.
 *
 * Every timing event is a `process.hrtime.bigint()` reading in the client, measured from t₀ taken
 * immediately before `request.end()`: TTFB at `'response'` (status line and headers parsed), the
 * first `'data'` event (recorded only), and TTLB at `'end'` (last body byte). Socket reuse and the
 * local port are recorded per request.
 *
 * For every `next dev` response it preserves: the status, the **raw header list** exactly as
 * `rawHeaders` gives it and its hash, the client wall clock around the exchange (for the `Date`
 * plausibility check), the raw body's hash, and the body masked for **only** the request's own
 * identity, with the replacement count and offsets. Masked bodies are stored once per hash, so
 * every raw body can be rebuilt exactly and checked against its raw hash. Requests carry
 * `Accept-Encoding: identity`; any `Content-Encoding` is recorded and makes the run Invalid.
 * There are no retries.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import type { MeasurementRecord } from "./analyze";
import { maskOwnIdentity, serializeHeaderList, sha256Hex } from "./body-compare";
import type { RunControl, RunOutcome } from "./run-operation";
import type { Plan, PlanIdentity } from "./schedule";

const HOST = "127.0.0.1";
const REQUEST_HEADERS = { "Accept-Encoding": "identity", "Cache-Control": "no-cache", Connection: "keep-alive" } as const;

export interface Exchange {
  readonly status: number;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
  readonly ttfbNs: bigint;
  readonly firstBodyNs?: bigint;
  readonly ttlbNs: bigint;
  readonly reusedSocket: boolean;
  readonly localPort?: number;
  readonly writeStartMs: number;
  readonly responseEndMs: number;
}

/** Send one GET and capture its timing events, socket facts, headers and body. */
export function sendOne(agent: http.Agent, port: number, path: string, timeoutMs: number): Promise<Exchange> {
  return new Promise((accept, reject) => {
    let t0 = 0n;
    let writeStartMs = 0;
    let ttfb = 0n;
    let firstBody: bigint | undefined;
    let localPort: number | undefined;
    const request = http.request({ host: HOST, port, path, method: "GET", agent, headers: REQUEST_HEADERS });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    request.once("error", reject);
    request.once("socket", (socket) => {
      localPort = socket.localPort;
      if (localPort === undefined) socket.once("connect", () => (localPort = socket.localPort));
    });
    request.once("response", (response) => {
      ttfb = process.hrtime.bigint() - t0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (firstBody === undefined) firstBody = process.hrtime.bigint() - t0;
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const ttlb = process.hrtime.bigint() - t0;
        accept({
          status: response.statusCode ?? -1,
          rawHeaders: [...response.rawHeaders],
          body: Buffer.concat(chunks),
          ttfbNs: ttfb,
          ...(firstBody === undefined ? {} : { firstBodyNs: firstBody }),
          ttlbNs: ttlb,
          reusedSocket: request.reusedSocket,
          ...(localPort === undefined ? {} : { localPort }),
          writeStartMs,
          responseEndMs: Date.now(),
        });
      });
    });

    writeStartMs = Date.now();
    t0 = process.hrtime.bigint();
    request.end();
  });
}

export function pathFor(identity: PlanIdentity): string {
  return identity.target === "calibration" ? `/cal/${identity.condition as number}/${identity.key}` : `/directory/${identity.key}`;
}

/** Poll a target until `accept(exchange)` holds or the bound passes. Readiness requests are not measured. */
export async function waitReady(
  port: number,
  path: string,
  ready: (exchange: Exchange) => boolean,
  boundMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + boundMs;
  const agent = new http.Agent({ keepAlive: false });

  try {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("aborted while waiting for readiness");
      try {
        if (ready(await sendOne(agent, port, path, 60_000))) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resume) => setTimeout(resume, 500));
    }
  } finally {
    agent.destroy();
  }

  throw new Error(`port ${port} was not ready within ${boundMs}ms`);
}

export interface HttpTargets {
  readonly nextPort: number;
  readonly calibrationPort: number;
  /** Masked bodies are written here once per masked hash. */
  readonly bodiesDirectory: string;
}

/** Run the plan's E2 requests. */
export async function runHttp(plan: Plan, targets: HttpTargets, control: RunControl): Promise<RunOutcome> {
  const agents = {
    next: new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 1_000 }),
    calibration: new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 1_000 }),
  };
  const stored = new Set<string>();
  let completed = 0;
  let measured = 0;

  if (!existsSync(targets.bodiesDirectory)) mkdirSync(targets.bodiesDirectory, { recursive: true });

  try {
    for (const request of plan.requests) {
      if (control.signal.aborted) return { completed, stoppedBy: "abort" };
      if (completed >= control.requestCap) return { completed, stoppedBy: "cap" };

      const identity = plan.identities[request.identity] as PlanIdentity;
      const target = identity.target === "calibration" ? "calibration" : "next";
      const base = {
        sequence: request.sequence,
        phase: request.phase,
        block: request.block,
        identity: request.identity,
        cls: identity.cls,
        target: identity.target,
      };
      let record: MeasurementRecord;

      try {
        const exchange = await sendOne(agents[target], target === "next" ? targets.nextPort : targets.calibrationPort, pathFor(identity), 120_000);
        let encodingValue: string | undefined;

        for (let i = 0; i < exchange.rawHeaders.length; i += 2) {
          if ((exchange.rawHeaders[i] as string).toLowerCase() === "content-encoding") encodingValue = exchange.rawHeaders[i + 1];
        }

        const timing = {
          ttfbNs: exchange.ttfbNs.toString(),
          ...(exchange.firstBodyNs === undefined ? {} : { firstBodyNs: exchange.firstBodyNs.toString() }),
          ttlbNs: exchange.ttlbNs.toString(),
          status: exchange.status,
          reusedSocket: exchange.reusedSocket,
          ...(exchange.localPort === undefined ? {} : { localPort: exchange.localPort }),
          rawBodyHash: sha256Hex(exchange.body),
          rawHeaders: exchange.rawHeaders,
          rawHeaderHash: sha256Hex(serializeHeaderList(exchange.rawHeaders)),
          writeStartMs: exchange.writeStartMs,
          responseEndMs: exchange.responseEndMs,
          ...(encodingValue === undefined ? {} : { contentEncoding: encodingValue }),
        };

        if (target === "next") {
          const masked = maskOwnIdentity(exchange.body, identity.key);
          const maskedHash = sha256Hex(masked.masked);

          if (!stored.has(maskedHash)) {
            writeFileSync(join(targets.bodiesDirectory, `${maskedHash}.bin`), masked.masked);
            stored.add(maskedHash);
          }

          record = { ...base, ...timing, maskedBodyHash: maskedHash, bodyReplacements: masked.count, bodyOffsets: masked.offsets };
        } else {
          record = { ...base, ...timing };
        }
      } catch (error) {
        record = { ...base, transportError: (error as Error).message };
      }

      control.onRecord(record);
      completed += 1;

      if (request.phase === "measured") {
        measured += 1;
        const held = control.onMeasured?.(measured);
        if (held !== undefined) await held;
      }
    }
  } finally {
    agents.next.destroy();
    agents.calibration.destroy();
  }

  return { completed };
}
