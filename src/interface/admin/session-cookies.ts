/**
 * The three administrator cookies (`ADR-004` P-1; issue #260 §3.5; the recovery cookie, issue #268
 * §3.3 and RJ-D1).
 *
 * All carry exactly `Secure; HttpOnly; SameSite=Strict; Path=/` and no `Domain`, the `__Host-`
 * requirements. **No function here can produce a weaker cookie**: there is no option to omit an
 * attribute, and local development uses local HTTPS rather than a development-only cookie
 * (L-3). Cookie expiry is a courtesy; the server enforces every lifetime on each request.
 */

export const SESSION_COOKIE = "__Host-admin-session";
export const CHALLENGE_COOKIE = "__Host-admin-challenge";
/** The restricted recovery session's token. `/admin` never reads it (issue #268 §3.5). */
export const RECOVERY_COOKIE = "__Host-admin-recovery";

export type AdministratorCookie = typeof SESSION_COOKIE | typeof CHALLENGE_COOKIE | typeof RECOVERY_COOKIE;

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";
const TOKEN_FORM = /^[A-Za-z0-9_-]{1,128}$/;

/** A `Set-Cookie` value that stores `value` for `maxAgeSeconds` (at least 1, whole seconds). */
export function setCookie(name: AdministratorCookie, value: string, maxAgeSeconds: number): string {
  if (!TOKEN_FORM.test(value)) {
    throw new RangeError("a cookie value must be a base64url token");
  }

  return `${name}=${value}; Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}; ${ATTRIBUTES}`;
}

/** A `Set-Cookie` value that removes the cookie, with the same attributes. */
export function clearCookie(name: AdministratorCookie): string {
  return `${name}=; Max-Age=0; ${ATTRIBUTES}`;
}

/**
 * The cookie's value from a `Cookie` header, or `undefined` when it is absent, malformed or
 * present more than once. An ambiguous header is never resolved in either direction.
 */
export function readCookie(header: string | null | undefined, name: AdministratorCookie): string | undefined {
  if (header === null || header === undefined) {
    return undefined;
  }

  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));

  return values.length === 1 && TOKEN_FORM.test(values[0] ?? "") ? values[0] : undefined;
}
