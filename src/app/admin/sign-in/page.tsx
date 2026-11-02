import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { openGateFor } from "../../../interface/admin/local-gate";

/**
 * The password form (issue #260 §3.2). It needs no session and grants nothing: a correct
 * password yields only a pending challenge, never administrative access (`ADR-004` P-1).
 * After any failure the form shows the same one notice, whatever the cause (`ADR-004` P-5).
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (openGateFor(process.env, (await headers()).get("host")) === undefined) {
    notFound();
  }

  const notice = (await searchParams).notice !== undefined;

  return (
    <main>
      <h1>Administrator sign-in</h1>
      {notice ? (
        <p role="alert">Sign-in did not succeed. Check your details and try again.</p>
      ) : null}
      <form method="post" action="/admin/sign-in/password">
        <p>
          <label htmlFor="username">Username</label>
          <br />
          <input id="username" name="username" type="text" autoComplete="username" required autoCapitalize="none" spellCheck={false} />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </p>
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
