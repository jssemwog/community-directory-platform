/**
 * The standalone E2 calibration server for the `BI-4` timing pilot (issue #246; timing Scope Gate
 * revision 4 §4.2; harness gate revision 5 §2, §7.2).
 *
 * A minimal loopback HTTP server, outside production code, run as **its own child process** so
 * its busy-waits block only its own event loop and never the measuring client's. It streams a
 * response shaped like `S2` — a first chunk, then a final chunk — and can busy-wait a known d
 * before either: before the first chunk calibrates TTFB, before the final chunk calibrates TTLB.
 *
 * It validates the client measurement pipeline and the analysis at known d. It says nothing about
 * the Next.js dev server, the database path or production. The delaying proxy is deferred.
 *
 * Usage (spawned by the harness only):
 *   node --experimental-transform-types calibration-server.ts --port <port> --delays-ns <a,b,c>
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

import { calibrationConditions, validateDelays } from "./schedule";

const LOOPBACK_HOST = "127.0.0.1";

/** Spin until `ns` nanoseconds have passed. Deliberately blocks the event loop. */
export function busyWaitNs(ns: number): void {
  const end = process.hrtime.bigint() + BigInt(ns);
  while (process.hrtime.bigint() < end) {
    // spin
  }
}

/** Fixed bytes, identical for every condition, so only the delay differs between conditions. */
export const FIRST_CHUNK = '<!DOCTYPE html><html lang="en"><head><title>Calibration</title></head><body><div>Loading…</div>';
export const FINAL_CHUNK = "<main><h1>Calibration</h1><p>Fixed calibration body.</p></main></body></html>";
export const HEALTH_PATH = "/health";

const PATH_SHAPE = /^\/cal\/(\d+)\/([0-9a-f-]{36})$/;

/** The request handler, for a fixed set of explicit delays. */
export function calibrationHandler(delaysNs: readonly number[]): http.RequestListener {
  const conditions = calibrationConditions(validateDelays(delaysNs));

  return (request, response) => {
    if (request.method === "GET" && request.url === HEALTH_PATH) {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("ok");
      return;
    }

    const match = request.method === "GET" ? PATH_SHAPE.exec(request.url ?? "") : null;
    const condition = match === null ? undefined : conditions[Number(match[1])];

    if (condition === undefined) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const delay = condition.delayIndex === undefined ? 0 : (delaysNs[condition.delayIndex] as number);

    if (condition.placement === "first") busyWaitNs(delay);

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.write(FIRST_CHUNK);

    if (condition.placement === "final") busyWaitNs(delay);

    response.end(FINAL_CHUNK);
  };
}

function parse(argv: readonly string[]): { port: number; delaysNs: number[] } {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    const found = index < 0 ? undefined : argv[index + 1];
    if (found === undefined) throw new Error(`${flag} is required`);
    return found;
  };
  const port = Number(value("--port"));
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("--port must be a TCP port");
  return { port, delaysNs: value("--delays-ns").split(",").map(Number) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, delaysNs } = parse(process.argv.slice(2));
  const server = http.createServer(calibrationHandler(delaysNs));

  // Sequential keep-alive traffic from one client: idle gaps must not close the socket.
  server.keepAliveTimeout = 600_000;
  server.headersTimeout = 601_000;
  server.listen(port, LOOPBACK_HOST);
}
