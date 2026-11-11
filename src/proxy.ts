import { NextResponse, type NextRequest } from "next/server";

import {
  isStagingS2Path,
  presentsStagingKey,
  STAGING_KEY_HEADER,
  STAGING_STATUS_PATH,
  stagingModeOf,
  type StagingConfiguration,
} from "./interface/public/staging-access";

/**
 * Response headers for the administrative paths only (issue #260 OD-10).
 *
 * **This is not a security boundary, and it makes no authentication or authorization
 * decision.** Next.js 16 says Proxy "should not be your only line of defense"; the gate and the
 * session are checked by each page and Route Handler (`ADR-004` P-1). It reads no cookie,
 * session, key or gate state, imports nothing that holds authentication state, and never
 * redirects, rewrites or grants anything. It asks browsers not to cache, frame or leak referrers
 * for these responses, and it does one other thing, below: it refuses page `OPTIONS`.
 *
 * **`Referrer-Policy: same-origin`, not `no-referrer`.** With `no-referrer`, Chromium 156 was
 * observed (one captured same-origin sign-in form post, issue #260 review) sending `Origin: null`,
 * which the exact `Origin` check refuses, so sign-in failed in that engine. Firefox and WebKit
 * were not captured under `no-referrer`. `same-origin` still sends no referrer to any other
 * origin. This departs from OD-10's stated value and is disclosed for review.
 *
 * **Unconditional `OPTIONS` refusal on the page paths.** Next.js answers `OPTIONS` on any page
 * route with an empty `400` before rendering, so the administrator pages' gate would never see
 * it. This answers `OPTIONS` on the five administrator page paths (the recovery pages since issue
 * #268) with the same uniform `404`
 * the closed gate gives (issue #260 §12 qualification 8), whether the gate is open or closed:
 * pages support no `OPTIONS` in either case. The Route Handlers answer their own `OPTIONS`.
 *
 * **`/directory` under `E3-local` (issue #246, Scope Gate revision 4 §2).** In production with
 * `BI4_E3_LOCAL` exactly `1`, the directory index (`S1`) answers a plain-text `404` for every
 * method. The directory layout cannot tell `S1` from `S2`, and `S1`'s own gate sits inside a
 * loading boundary, so this is what makes its wire status a real 404. It is **not** a security
 * boundary: `S1`'s page gate still refuses. It reads only those two variables, **on each request**;
 * it touches no database and shares no state with rendering. Only the exact pathname `/directory`
 * matches: `/directory/` is answered by the framework's trailing-slash redirect before this runs,
 * and case or encoding variants are not normalized. Otherwise `/directory` passes through with no
 * header added; the admin headers are never applied to it.
 *
 * **OP-2 private staging (issue #246, OP-2 staging Scope Gate revision 2 §3).** The matcher is
 * **global** (`/:path*`), because the staging gate must see every request and a matcher must be a
 * build-time constant. Outside the staging mode, behaviour is unchanged: the admin headers apply to
 * `/admin` and `/admin/**` only (what the old matcher covered), the `OPTIONS` refusal and the
 * `E3-local` rule are as before, and **every other path passes through with no header added**.
 *
 * Under the staging mode (production, `BI4_STAGING` present; `staging-access.ts`), the service is
 * publicly reachable and **application-key gated**:
 * - deny-all (armed but not validly configured): every request gets the gate `404`;
 * - otherwise a request passes **only** if it is `GET`/`HEAD` on one `S2` path or `GET` on the
 *   status route, has no query string and no `Cookie` header, and presents the key in exactly one
 *   `X-BI4-Staging-Key` header. Everything else, `/admin/**`, `/` and static assets included, gets
 *   the gate `404`, keyed or not;
 * - the key header is **deleted** from the forwarded request, so nothing upstream sees it;
 * - a keyed `S2` response gets `Cache-Control: private, no-store`, the same for every class (§4.1).
 *   Whether that value survives to the wire is checked by the local configured check and, for
 *   readiness, through Render (R-2b).
 *
 * The gate is **not** the only line of defence: the staging data are synthetic, the status route
 * re-checks the mode itself, and the app role can read only `listing`.
 */
const PAGE_PATHS = new Set(["/admin", "/admin/sign-in", "/admin/sign-in/code", "/admin/sign-in/recovery", "/admin/recovery"]);

const DIRECTORY_INDEX = "/directory";

/** The plain-text `404` shared by the `E3-local` rule, the `OPTIONS` refusal and the staging gate. */
function plainNotFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** The staging gate (§3.2). Every refusal is the same response. */
function stagingGate(request: NextRequest, configuration: StagingConfiguration): NextResponse {
  // The key is checked first and always, so the work does not depend on the path.
  const keyed = presentsStagingKey(request.headers, configuration.keyDigestHex);
  const { pathname, search } = request.nextUrl;
  const method = request.method;
  const isS2 = isStagingS2Path(pathname) && (method === "GET" || method === "HEAD");
  const isStatus = pathname === STAGING_STATUS_PATH && method === "GET";

  if (!keyed || !(isS2 || isStatus) || search !== "" || request.headers.has("cookie")) {
    return plainNotFound();
  }

  const forwarded = new Headers(request.headers);
  forwarded.delete(STAGING_KEY_HEADER);
  const response = NextResponse.next({ request: { headers: forwarded } });

  if (isS2) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  return response;
}

export function proxy(request: NextRequest) {
  const staging = stagingModeOf(process.env);

  if (staging.kind === "deny-all") {
    return plainNotFound();
  }

  if (staging.kind === "on") {
    return stagingGate(request, staging.configuration);
  }

  const { pathname } = request.nextUrl;

  if (pathname === DIRECTORY_INDEX) {
    if (process.env.NODE_ENV === "production" && process.env.BI4_E3_LOCAL === "1") {
      return plainNotFound();
    }

    return NextResponse.next();
  }

  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) {
    return NextResponse.next();
  }

  if (request.method === "OPTIONS" && PAGE_PATHS.has(pathname)) {
    return plainNotFound();
  }

  const response = NextResponse.next();

  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("Referrer-Policy", "same-origin");

  return response;
}

export const config = {
  matcher: ["/:path*"],
};
