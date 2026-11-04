import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { administratorSessionOf } from "../../interface/admin/require-administrator";
import { openGateFor } from "../../interface/admin/local-gate";
import { readCookie, SESSION_COOKIE } from "../../interface/admin/session-cookies";

/**
 * The trivial protected administrator page (issue #260 §3.2, under the #254 exception).
 *
 * It checks the gate and then the session itself, on every request, and shows nothing but
 * "Signed in" and a way to sign out: no username, identifier, record, queue or administrative
 * capability. No moderation or business-administration capability exists behind it.
 *
 * The session token is read from the raw `Cookie` header with the duplicate-aware parser, so a
 * request carrying the session cookie more than once is refused, whichever copy is valid.
 */
export default async function AdministrativeSurfaceRoot() {
  const requestHeaders = await headers();
  const configuration = openGateFor(process.env, requestHeaders.get("host"));

  if (configuration === undefined) {
    notFound();
  }

  const token = readCookie(requestHeaders.get("cookie"), SESSION_COOKIE);

  if ((await administratorSessionOf(configuration, token)) !== "valid") {
    redirect("/admin/sign-in");
  }

  return (
    <main>
      <h1>Administration</h1>
      <p>Signed in.</p>
      <p>
        Local synthetic sign-in only. No administrative capability exists yet, and account management
        beyond the operator&apos;s revoke and disable commands is not implemented.
      </p>
      <form method="post" action="/admin/sign-out">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
