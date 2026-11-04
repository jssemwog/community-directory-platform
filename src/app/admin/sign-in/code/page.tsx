import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { openGateFor } from "../../../../interface/admin/local-gate";
import { CHALLENGE_COOKIE } from "../../../../interface/admin/session-cookies";

/**
 * The TOTP form (issue #260 §3.2). Rendering it checks only that a challenge cookie is
 * **present**; the challenge itself is checked only when a code is submitted, so this page
 * reveals nothing about whether a challenge is valid.
 */
export default async function SignInCodePage() {
  if (openGateFor(process.env, (await headers()).get("host")) === undefined) {
    notFound();
  }

  if ((await cookies()).get(CHALLENGE_COOKIE) === undefined) {
    redirect("/admin/sign-in");
  }

  return (
    <main>
      <h1>Authenticator code</h1>
      <form method="post" action="/admin/sign-in/code/verify">
        <p>
          <label htmlFor="code">Six-digit code from your authenticator app</label>
          <br />
          <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
        </p>
        <button type="submit">Sign in</button>
      </form>
      <p>
        <a href="/admin/sign-in/recovery">Use a recovery code instead</a>
      </p>
    </main>
  );
}
