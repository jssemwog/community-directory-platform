/**
 * The **operator commands** for sessions and accounts (`ADR-004` P-1, P-6; issue #270 §3.2):
 * `sessions`, `revoke`, `revoke-all` and `disable`, run through `npm run demo:local:admin -- <sub>`.
 *
 * Like provisioning, they are run explicitly by an operator, **with the demo stopped**, under the
 * launcher lock (RV-D1). They are never imported by the application server and never run on the
 * request path. They act only on `synthetic-` accounts (RV-D7), in the local demo's loopback
 * database.
 *
 * - **`sessions`** shows the account's disabled states once, then each session's non-secret `id`,
 *   kind, timestamps and whether it is live (RV-D2). It is a read only: no activity is refreshed,
 *   and no token or digest is ever shown.
 * - **`revoke`** ends one session, by its `id`.
 * - **`revoke-all`** ends every session of the account and invalidates its pending challenges.
 * - **`disable`** asks for the username to be retyped (RV-D4), after warning that **nothing in this
 *   project re-enables an account** (`ADR-028` D-12), and that the future operator reset will not
 *   either (D-16).
 *
 * Every outcome is also written as one four-field outcome line (`event`, `entry`, `outcome`, `at`)
 * to the operator's terminal (RV-D8). Nothing here prints a token, digest, password, code or secret.
 */

import type { Kysely } from "kysely";

import {
  disableAccount,
  findCredential,
  listSessions,
  revokeAllSessions,
  revokeSession,
  type Clock,
  type ListedSession,
} from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { isProvisionableUsername, normalizeSubmittedUsername } from "../../src/domain/administrator-auth/username";
import { isLoopbackDatabaseUrl, launchRefusalOf, SYNTHETIC_PREFIX, type ProvisioningTerminal } from "./administrator-provisioning";

export const CONTROL_SUBCOMMANDS = ["sessions", "revoke", "revoke-all", "disable"] as const;
export type ControlSubcommand = (typeof CONTROL_SUBCOMMANDS)[number];

/** A session `id` exactly as the application issues it (`randomUUID`). */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENTRY: Readonly<Record<ControlSubcommand, string>> = {
  sessions: "operator-sessions",
  revoke: "operator-revoke",
  "revoke-all": "operator-revoke-all",
  disable: "operator-disable",
};

export const DISABLE_WARNING =
  "Disabling cannot be undone in this project: the account will never sign in or use a recovery code again, " +
  "and the future operator reset will not re-enable it. Only `npm run demo:local:reset`, which deletes all local data, removes it.";

/**
 * Revoke-all's and disable's storage-failure message. A failure can be reported after the server
 * committed (a lost COMMIT acknowledgement), so it never promises that nothing was changed.
 */
export const UNCONFIRMED_OUTCOME = "The operation did not report success. Run sessions to inspect the current account and session state.";

export interface ControlDependencies {
  readonly db: Kysely<AdministratorAuthenticationDatabase>;
  readonly clock: Clock;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The launcher's own loopback cluster; checked again here. */
  readonly databaseUrl: string;
}

export type ControlResult = { readonly ok: boolean; readonly outcome: string };

const instant = (epochMilliseconds: number | null) => (epochMilliseconds === null ? "no" : new Date(epochMilliseconds).toISOString());

/** One session, as text: never a token or digest. */
export function describeSession(session: ListedSession): string {
  return `  ${session.id}  ${session.kind}  created ${instant(session.createdAt)}  last active ${instant(session.lastActivityAt)}  expires ${instant(session.absoluteExpiresAt)}  ${session.live ? "live" : "not live"}`;
}

/** Run one operator subcommand. Writes nothing unless every check before it passed. */
export async function controlSyntheticAdministrator(
  subcommand: ControlSubcommand,
  terminal: ProvisioningTerminal,
  deps: ControlDependencies,
): Promise<ControlResult> {
  const finish = (ok: boolean, outcome: string): ControlResult => {
    terminal.say(JSON.stringify({ event: "administrator-authentication", entry: ENTRY[subcommand], outcome, at: new Date(deps.clock()).toISOString() }));
    return { ok, outcome };
  };

  const refusal = launchRefusalOf(terminal, deps.environment);

  if (refusal !== undefined) {
    terminal.say(refusal.message);
    return finish(false, refusal.reason);
  }

  if (!isLoopbackDatabaseUrl(deps.databaseUrl)) {
    terminal.say("This command acts only on the local demo's loopback database; nothing was changed.");
    return finish(false, "NOT_LOCAL_DATABASE");
  }

  const username = normalizeSubmittedUsername(await terminal.ask(`Username (must start with "${SYNTHETIC_PREFIX}"): `));

  if (!username.startsWith(SYNTHETIC_PREFIX) || !isProvisionableUsername(username)) {
    terminal.say(`Only "${SYNTHETIC_PREFIX}" accounts can be managed here; nothing was changed.`);
    return finish(false, "USERNAME_REFUSED");
  }

  if (subcommand === "disable") {
    // Confirmed before any storage call (issue #270 §6.2 C-1, RV-D4).
    terminal.say(DISABLE_WARNING);
    const confirmation = normalizeSubmittedUsername((await terminal.ask("Type the username again to disable it: ")).trim());

    if (confirmation !== username) {
      terminal.say("The usernames differ; nothing was changed.");
      return finish(false, "NOT_CONFIRMED");
    }
  }

  const credential = await findCredential(deps.db, username);

  if (!credential.ok) {
    terminal.say("The account could not be read; nothing was changed.");
    return finish(false, credential.failure.code);
  }

  if (credential.value === undefined) {
    terminal.say("No such synthetic administrator; nothing was changed.");
    return finish(false, "ADMINISTRATOR_NOT_FOUND");
  }

  const { administratorId } = credential.value;

  if (subcommand === "sessions" || subcommand === "revoke") {
    const listed = await listSessions(deps.db, { administratorId }, deps.clock);

    if (!listed.ok || listed.value.code !== "SESSIONS_LISTED") {
      terminal.say("The sessions could not be read; nothing was changed.");
      return finish(false, listed.ok ? listed.value.code : listed.failure.code);
    }

    const { account, sessions } = listed.value;
    terminal.say(`Account disabled: ${instant(account.disabledAt)}. Password disabled: ${instant(account.passwordDisabledAt)}.`);
    terminal.say(sessions.length === 0 ? "No sessions." : `Sessions (${sessions.length}):`);

    for (const session of sessions) {
      terminal.say(describeSession(session));
    }

    if (subcommand === "sessions") {
      return finish(true, "SESSIONS_LISTED");
    }

    const sessionId = (await terminal.ask("Session id to revoke: ")).trim();

    if (!CANONICAL_UUID.test(sessionId)) {
      terminal.say("That is not a session id; nothing was changed.");
      return finish(false, "SESSION_ID_REFUSED");
    }

    const revoked = await revokeSession(deps.db, { administratorId, sessionId });

    if (!revoked.ok) {
      // Revoke-one is autocommitted: a failure reported after the server committed cannot be told
      // apart from one before it. `sessions` shows the true state (issue #270 §11).
      terminal.say("The revocation did not report success. Run `sessions` to see whether the session remains.");
      return finish(false, revoked.failure.code);
    }

    terminal.say(revoked.value.code === "SESSION_REVOKED" ? "Revoked." : "No such session for this account; nothing was changed.");
    return finish(revoked.value.code === "SESSION_REVOKED", revoked.value.code);
  }

  if (subcommand === "revoke-all") {
    const revoked = await revokeAllSessions(deps.db, { administratorId });

    if (!revoked.ok) {
      terminal.say(UNCONFIRMED_OUTCOME);
      return finish(false, revoked.failure.code);
    }

    if (revoked.value.code !== "SESSIONS_REVOKED") {
      terminal.say("No such synthetic administrator; nothing was changed.");
      return finish(false, revoked.value.code);
    }

    terminal.say(`Revoked ${revoked.value.revoked} session(s); pending sign-in challenges were invalidated. The password and authenticator are unchanged.`);
    return finish(true, "SESSIONS_REVOKED");
  }

  const disabled = await disableAccount(deps.db, { administratorId }, deps.clock);

  if (!disabled.ok) {
    terminal.say(UNCONFIRMED_OUTCOME);
    return finish(false, disabled.failure.code);
  }

  if (disabled.value.code === "ALREADY_DISABLED") {
    terminal.say("That account is already disabled; nothing was changed.");
    return finish(false, "ALREADY_DISABLED");
  }

  if (disabled.value.code === "ADMINISTRATOR_NOT_FOUND") {
    terminal.say("No such synthetic administrator; nothing was changed.");
    return finish(false, "ADMINISTRATOR_NOT_FOUND");
  }

  terminal.say(`Disabled. ${disabled.value.revoked} session(s) ended; pending sign-in challenges were invalidated.`);
  return finish(true, "DISABLED");
}
