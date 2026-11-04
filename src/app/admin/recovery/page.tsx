import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { WARNINGS } from "../../../interface/admin/display-once";
import { openGateFor } from "../../../interface/admin/local-gate";
import { recoverySessionOf } from "../../../interface/admin/require-recovery-session";
import { readCookie, RECOVERY_COOKIE } from "../../../interface/admin/session-cookies";

/**
 * The restricted recovery session's page (`ADR-004` P-1; issue #268 §3.3 and RJ-D11).
 *
 * It checks the gate and then the recovery session itself, on every request, reading the recovery
 * cookie with the duplicate-aware parser. It offers only what the recovery session permits:
 * setting up a new authenticator, replacing the recovery codes, and ending the session. It shows
 * no username, identifier, code count, factor state or administrative content. **It is not
 * administrator access**: `/admin` never reads this cookie, and refuses the session's kind.
 */
export default async function RecoverySessionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requestHeaders = await headers();
  const configuration = openGateFor(process.env, requestHeaders.get("host"));

  if (configuration === undefined) {
    notFound();
  }

  const token = readCookie(requestHeaders.get("cookie"), RECOVERY_COOKIE);

  if ((await recoverySessionOf(configuration, token)) !== "valid") {
    redirect("/admin/sign-in");
  }

  const notice = (await searchParams).notice !== undefined;

  return (
    <main>
      <h1>Recovery session</h1>
      <p>
        This is a restricted recovery session, not administrator access. It lasts at most 15 minutes and is never
        extended. To sign in again, set up a new authenticator.
      </p>
      {notice ? <p role="alert">That did not succeed. Try again.</p> : null}
      <h2>Set up a new authenticator</h2>
      <form method="post" action="/admin/recovery/reenrolment/start">
        <p>{WARNINGS.startBefore}</p>
        <button type="submit">Set up a new authenticator</button>
      </form>
      <h2>Replace recovery codes</h2>
      <form method="post" action="/admin/recovery/codes">
        <p>{WARNINGS.codesBefore}</p>
        <button type="submit">Replace recovery codes</button>
      </form>
      <h2>End recovery session</h2>
      <form method="post" action="/admin/recovery/sign-out">
        <button type="submit">End recovery session</button>
      </form>
    </main>
  );
}
