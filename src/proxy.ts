import { NextResponse, type NextRequest } from "next/server";

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
 */
const PAGE_PATHS = new Set(["/admin", "/admin/sign-in", "/admin/sign-in/code", "/admin/sign-in/recovery", "/admin/recovery"]);

const DIRECTORY_INDEX = "/directory";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === DIRECTORY_INDEX) {
    if (process.env.NODE_ENV === "production" && process.env.BI4_E3_LOCAL === "1") {
      return new NextResponse("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return NextResponse.next();
  }

  if (request.method === "OPTIONS" && PAGE_PATHS.has(request.nextUrl.pathname)) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const response = NextResponse.next();

  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("Referrer-Policy", "same-origin");

  return response;
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/directory"],
};
