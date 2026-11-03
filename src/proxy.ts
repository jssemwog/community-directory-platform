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
 * it. This answers `OPTIONS` on the three administrator page paths with the same uniform `404`
 * the closed gate gives (issue #260 §12 qualification 8), whether the gate is open or closed:
 * pages support no `OPTIONS` in either case. The Route Handlers answer their own `OPTIONS`.
 */
const PAGE_PATHS = new Set(["/admin", "/admin/sign-in", "/admin/sign-in/code"]);

export function proxy(request: NextRequest) {
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
  matcher: ["/admin", "/admin/:path*"],
};
