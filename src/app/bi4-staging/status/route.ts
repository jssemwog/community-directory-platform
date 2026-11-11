import { notFound } from "next/navigation";

import { stagingSource } from "../../../interface/public/staging-persistence";
import { STATUS_HEADERS, stagingStatusPayload } from "../../../interface/public/staging-status";

/**
 * `GET /bi4-staging/status` — the OP-2 staging status route (issue #246, OP-2 staging Scope Gate
 * revision 2 §7.5). A thin wrapper; the payload is built in `staging-status.ts`.
 *
 * **Inert outside the staging mode.** Unless the staging mode is **on**, every method answers
 * through `notFound()`, so a non-staging build answers this path as the framework's not-found, not
 * with a route-specific body (D-G1). That is why **every** method is exported: an unexported method
 * would otherwise get Next's automatic `405` or `OPTIONS` reply, which would differ from a path
 * that does not exist. Whether the bytes equal the baseline's is checked by the separately
 * authorized PB-1 regression run, not by unit tests.
 *
 * Under the staging mode, the proxy has already required the key and a plain `GET`. The route
 * re-checks the mode itself, so it is not the proxy's only line of defence.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const source = stagingSource();

  if (source.kind !== "on") {
    notFound();
  }

  return new Response(JSON.stringify(stagingStatusPayload(source.handle.status(), process.env)), {
    status: 200,
    headers: STATUS_HEADERS,
  });
}

async function absent(): Promise<Response> {
  notFound();
}

export const HEAD = absent;
export const POST = absent;
export const PUT = absent;
export const PATCH = absent;
export const DELETE = absent;
export const OPTIONS = absent;
