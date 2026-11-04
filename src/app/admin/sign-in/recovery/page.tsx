import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { openGateFor } from "../../../../interface/admin/local-gate";
import { CHALLENGE_COOKIE } from "../../../../interface/admin/session-cookies";

/**
 * The recovery-code form (issue #268 §3.2 and RJ-D7), reached from the TOTP page. Like that page,
 * rendering it checks only that a challenge cookie is **present**; the challenge itself is checked
 * only when a code is submitted, so this page reveals nothing about whether a challenge is valid.
 * A recovery code is accepted only after the password, in the same pending challenge (`ADR-004`
 * P-4).
 */
export default async function SignInRecoveryCodePage() {
  if (openGateFor(process.env, (await headers()).get("host")) === undefined) {
    notFound();
  }

  if ((await cookies()).get(CHALLENGE_COOKIE) === undefined) {
    redirect("/admin/sign-in");
  }

  return (
    <main>
      <h1>Recovery code</h1>
      <p>
        Use one of your recovery codes if your authenticator is lost. A code works once. Using one ends every other
        session and opens a restricted recovery session, in which you must set up a new authenticator.
      </p>
      <form method="post" action="/admin/sign-in/recovery/verify">
        <p>
          <label htmlFor="code">Recovery code</label>
          <br />
          <input id="code" name="code" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
        </p>
        <button type="submit">Use recovery code</button>
      </form>
    </main>
  );
}
