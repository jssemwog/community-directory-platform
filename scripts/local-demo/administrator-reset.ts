/**
 * The **operator reset** (break-glass) for a synthetic local account (`ADR-004` P-6 (2); Unit OR
 * Scope Gate, revision 4, approved 2026-11-05), run through
 * `npm run demo:local:admin -- reset-credentials`.
 *
 * Like the other operator commands it runs explicitly, **with the demo stopped**, under the
 * launcher lock (RV-D1). It is never imported by the application server and never runs on the
 * request path. It acts only on `synthetic-` accounts (RV-D7), in the local demo's loopback
 * database. The launcher validates the administrator keys before it starts the cluster (§3.1
 * item 7), and only those validated keys reach this module.
 *
 * One run is: the account lookup and status; a warning and a retyped username (RV-D4); a new
 * password, read twice without echo; then **T1** (`resetAdministratorCredentials`), the new
 * authenticator shown once, and **T2** (`confirmOperatorReset`), bound to T1 through one
 * `ResetRun` built before T1. The ten recovery codes are shown once, only after T2 is known to
 * have committed. **A disabled account stays disabled** (`ADR-028` D-16): T1 runs, nothing is
 * shown and T2 is never sent.
 *
 * A storage failure after T1 or T2 was sent may hide a commit. The command then runs the probe
 * once and acts only as §3.6 states. It never says "nothing was changed" once T1 has been sent,
 * and it never concludes a rollback: the advisory launcher lock cannot exclude another writer.
 *
 * Every outcome is one four-field line (`event`, `entry`, `outcome`, `at`) on the operator's
 * terminal (RV-D8). Nothing here prints a password, hash, digest, token or key; the secret, the
 * `otpauth://` URI and the codes go only to the operator's terminal, once.
 */

import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import {
  confirmOperatorReset,
  findCredential,
  listSessions,
  probeOperatorReset,
  RECOVERY_CODE_COUNT,
  resetAdministratorCredentials,
  type Clock,
  type OperatorResetProbe,
  type ResetRun,
  type Stored,
} from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { keyedDigest } from "../../src/domain/administrator-auth/keyed-digest";
import { hashPassword } from "../../src/domain/administrator-auth/password-hash";
import { checkNewPassword } from "../../src/domain/administrator-auth/password-policy";
import { generateRecoveryCodes, type GeneratedRecoveryCode } from "../../src/domain/administrator-auth/recovery-code";
import { sealTotpSecret } from "../../src/domain/administrator-auth/secret-box";
import { totpVerifierFor } from "../../src/domain/administrator-auth/sign-in";
import { generateTotpSecret } from "../../src/domain/administrator-auth/totp";
import { enrolmentUriOf } from "../../src/domain/administrator-auth/totp-enrolment";
import { isProvisionableUsername, normalizeSubmittedUsername } from "../../src/domain/administrator-auth/username";
import { LOCAL_TOTP_KEY_VERSION } from "../../src/interface/admin/local-gate";
import { readAdministratorKeys, type AdministratorKeys } from "./administrator-keys";
import { isLoopbackDatabaseUrl, launchRefusalOf, SYNTHETIC_PREFIX, type ProvisioningTerminal } from "./administrator-provisioning";

export const RESET_SUBCOMMAND = "reset-credentials";
const ENTRY = "operator-reset";

/** Confirmation attempts against one factor, uncounted (OR-D5). */
export const CONFIRMATION_ATTEMPTS = 3;

export const KEYS_UNREADABLE_MESSAGE = "The local administrator keys are missing or unreadable; nothing was changed.";

/** The §3.2 warning for every account. */
export function resetWarningFor(username: string): string {
  return (
    `This replaces the password, the authenticator and all recovery codes of ${username}, ends every session, and clears its sign-in waits. ` +
    "The old password, authenticator and codes stop working immediately. The account cannot sign in until the new authenticator is confirmed in this run. " +
    "If the old password may be known to someone else, choose a different one: reusing it is allowed. " +
    "This account's sign-in waits are cleared, but the per-address limit (20 failed sign-ins per hour from one address, shared by all accounts) is not. " +
    "Sign-in from an address that reached it can still be delayed for up to an hour after the reset."
  );
}

/** The §3.2 addition for a disabled account (D-16, D-12). */
export const DISABLED_RESET_WARNING =
  "This account is disabled. The reset does not re-enable it (D-16), and nothing in this project re-enables an account (D-12). It will stay unable to sign in.";

export const RESET_UNCONFIRMED_MESSAGE =
  "The reset did not report success, and whether it was applied cannot be confirmed. Run a fresh reset.";
export const CONFIRMATION_UNCONFIRMED_MESSAGE =
  "The confirmation did not report success and its result cannot be confirmed. Run a fresh reset.";
export const STATE_CHANGED_MESSAGE = "The account changed after this reset; nothing was confirmed. Run a fresh reset.";

const RULE_MESSAGES = {
  TOO_SHORT: "The password must be at least 15 characters.",
  TOO_LONG: "The password must be at most 128 characters.",
  BLOCKLISTED: "That password is on the list of common or compromised passwords.",
} as const;

/** The launcher's key validation (§3.1 item 7): never creates keys, never prints them. */
export function readResetKeys(file: string): { readonly ok: true; readonly keys: AdministratorKeys } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, keys: readAdministratorKeys(file) };
  } catch {
    return { ok: false, message: KEYS_UNREADABLE_MESSAGE };
  }
}

export interface ResetDependencies {
  readonly db: Kysely<AdministratorAuthenticationDatabase>;
  readonly clock: Clock;
  /** Validated by the launcher before the cluster started. */
  readonly keys: AdministratorKeys;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The launcher's own loopback cluster; checked again here. */
  readonly databaseUrl: string;
  /** The password hash; `hashPassword` unless a test substitutes a faster one. */
  readonly hash?: (password: string) => Promise<string>;
  /** The recovery codes; `generateRecoveryCodes` unless a test substitutes them. */
  readonly codes?: () => readonly GeneratedRecoveryCode[];
}

export type ResetResult = { readonly ok: boolean; readonly outcome: string };

/** The §3.6 rows after an uncertain T1. */
export type UncertainResetRow = "U1-a" | "U1-b" | "U1-c" | "U1-d" | "U1-e" | "U1-f";

export function classifyUncertainReset(probe: Stored<OperatorResetProbe>): UncertainResetRow {
  if (!probe.ok) {
    return "U1-f";
  }

  const p = probe.value;

  if (!p.found) {
    return "U1-e";
  }

  if (p.passwordMatches && p.factorMatches) {
    if (!p.accountEnabled) {
      return "U1-b";
    }

    return p.factorState === "pending_confirmation" && p.originIsNull && p.codeSetMatches ? "U1-a" : "U1-c";
  }

  return p.passwordMatches || p.factorMatches ? "U1-d" : "U1-e";
}

/** The §3.6 rows after an uncertain T2. */
export type UncertainConfirmationRow = "U2-a" | "U2-b" | "U2-c" | "U2-d" | "U2-e" | "U2-f" | "U2-g";

export function classifyUncertainConfirmation(probe: Stored<OperatorResetProbe>): UncertainConfirmationRow {
  if (!probe.ok || !probe.value.found) {
    return "U2-g";
  }

  const p = probe.value;

  if (!(p.passwordMatches && p.factorMatches)) {
    return p.passwordMatches || p.factorMatches ? "U2-f" : "U2-g";
  }

  if (!p.accountEnabled) {
    return "U2-d";
  }

  if (p.factorState === "active" && p.originIsNull && p.codeSetMatches) {
    return "U2-a";
  }

  if (p.factorState === "active" && !p.codeSetMatches) {
    return "U2-c";
  }

  if (p.factorState === "pending_confirmation" && p.originIsNull && p.codeSetMatches) {
    return "U2-b";
  }

  return "U2-e";
}

const instant = (epochMilliseconds: number | null) => (epochMilliseconds === null ? "no" : new Date(epochMilliseconds).toISOString());

/** Ten distinct 32-byte digests, or the run is refused before T1 (C-8). */
function isCodeDigestSet(codes: readonly GeneratedRecoveryCode[]): boolean {
  return (
    codes.length === RECOVERY_CODE_COUNT &&
    codes.every((code) => code.digest.length === 32) &&
    new Set(codes.map((code) => code.digest.toString("hex"))).size === RECOVERY_CODE_COUNT
  );
}

/** Run one operator reset. Writes nothing unless every check before T1 passed. */
export async function resetSyntheticAdministrator(terminal: ProvisioningTerminal, deps: ResetDependencies): Promise<ResetResult> {
  const finish = (ok: boolean, outcome: string): ResetResult => {
    terminal.say(JSON.stringify({ event: "administrator-authentication", entry: ENTRY, outcome, at: new Date(deps.clock()).toISOString() }));
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
  const listed = await listSessions(deps.db, { administratorId }, deps.clock);

  if (!listed.ok || listed.value.code !== "SESSIONS_LISTED") {
    terminal.say("The account could not be read; nothing was changed.");
    return finish(false, listed.ok ? listed.value.code : listed.failure.code);
  }

  const disabled = listed.value.account.disabledAt !== null;
  terminal.say(`Account disabled: ${instant(listed.value.account.disabledAt)}. Password disabled: ${instant(listed.value.account.passwordDisabledAt)}.`);
  terminal.say(resetWarningFor(username));

  if (disabled) {
    terminal.say(DISABLED_RESET_WARNING);
  }

  const confirmation = normalizeSubmittedUsername((await terminal.ask("Type the username again to reset it: ")).trim());

  if (confirmation !== username) {
    terminal.say("The usernames differ; nothing was changed.");
    return finish(false, "NOT_CONFIRMED");
  }

  const policy = checkNewPassword(await terminal.askSecret("New password (15 to 128 characters; not shown): "));

  if (!policy.ok) {
    terminal.say(`${RULE_MESSAGES[policy.rule]} Nothing was changed.`);
    return finish(false, "PASSWORD_REFUSED");
  }

  if ((await terminal.askSecret("New password again: ")).normalize("NFC") !== policy.normalized) {
    terminal.say("The passwords differ; nothing was changed.");
    return finish(false, "PASSWORDS_DIFFER");
  }

  const codes = (deps.codes ?? generateRecoveryCodes)();

  if (!isCodeDigestSet(codes)) {
    terminal.say("The new recovery codes could not be generated; nothing was changed.");
    return finish(false, "GENERATION_REFUSED");
  }

  const expectedPasswordHash = await (deps.hash ?? hashPassword)(policy.normalized);
  const secret = generateTotpSecret();

  try {
    // The one handoff (§3.3): built once, before T1, and never rebuilt.
    const run: ResetRun = Object.freeze({
      administratorId,
      expectedPasswordHash,
      factorId: randomUUID(),
      expectedCodeDigests: Object.freeze(codes.map((code) => code.digest)),
    });

    const reset = await resetAdministratorCredentials(
      deps.db,
      {
        run,
        material: sealTotpSecret(deps.keys.totpKey, LOCAL_TOTP_KEY_VERSION, administratorId, secret),
        throttleSubjects: {
          password: keyedDigest(deps.keys.throttleKey, "password-username", username),
          totp: keyedDigest(deps.keys.throttleKey, "totp-administrator", administratorId),
          recoveryCode: keyedDigest(deps.keys.throttleKey, "recovery-code-administrator", administratorId),
        },
      },
      deps.clock,
    );

    let accountDisabled: boolean;

    if (reset.ok) {
      if (reset.value.code === "ADMINISTRATOR_NOT_FOUND") {
        terminal.say("The account no longer exists.");
        return finish(false, "ADMINISTRATOR_NOT_FOUND");
      }

      accountDisabled = reset.value.accountDisabled;
    } else {
      const row = classifyUncertainReset(await probeOperatorReset(deps.db, { run }));

      if (row === "U1-e" || row === "U1-f") {
        terminal.say(RESET_UNCONFIRMED_MESSAGE);
        return finish(false, "RESET_UNCONFIRMED");
      }

      if (row === "U1-c" || row === "U1-d") {
        terminal.say(row === "U1-c" ? "The reset was committed, but the account changed afterwards. Run a fresh reset." : STATE_CHANGED_MESSAGE);
        return finish(false, "RESET_STATE_CHANGED");
      }

      terminal.say("The reset was committed.");
      accountDisabled = row === "U1-b";
    }

    // §3.5 step 5: checked before any display and before any T2 statement.
    if (accountDisabled) {
      terminal.say("Credentials reset. The account is still disabled and cannot sign in (D-16).");
      return finish(true, "CREDENTIALS_RESET_ACCOUNT_DISABLED");
    }

    const enrolment = enrolmentUriOf(username, secret);
    terminal.say("Add this account to your authenticator app now, replacing any earlier entry for it. It is shown only once:");
    terminal.say(`  ${enrolment.uri}`);
    terminal.say(`  Secret (base32): ${enrolment.base32}`);

    const showCodes = (): ResetResult => {
      terminal.say("Recovery codes. Each works once, after the password, if the authenticator is lost. Store them offline now; they are shown only once:");

      for (const generated of codes) {
        terminal.say(`  ${generated.code}`);
      }

      terminal.say("Reset complete. Sign in with the new password and authenticator.");
      return finish(true, "CREDENTIALS_RESET_CONFIRMED");
    };

    for (let attempt = 1; attempt <= CONFIRMATION_ATTEMPTS; attempt += 1) {
      const code = (await terminal.ask("Current six-digit code: ")).trim();
      const confirmed = await confirmOperatorReset(
        deps.db,
        { run, verify: totpVerifierFor(new Map([[LOCAL_TOTP_KEY_VERSION, deps.keys.totpKey]]), code) },
        deps.clock,
      );

      if (confirmed.ok) {
        if (confirmed.value.code === "RESET_CONFIRMED") {
          return showCodes();
        }

        const { reason } = confirmed.value;

        if (reason === "WRONG_CODE") {
          if (attempt < CONFIRMATION_ATTEMPTS) {
            terminal.say("That code did not match; try again.");
          }
          continue;
        }

        if (reason === "ACCOUNT_DISABLED") {
          terminal.say("The account was disabled during this run; nothing was confirmed (D-16).");
          return finish(false, "RESET_ACCOUNT_DISABLED_DURING_RUN");
        }

        if (reason === "FACTOR_UNREADABLE") {
          terminal.say("The new authenticator could not be read; nothing was confirmed. Run a fresh reset.");
          return finish(false, "FACTOR_UNREADABLE");
        }

        terminal.say(STATE_CHANGED_MESSAGE);
        return finish(false, "RESET_STATE_CHANGED");
      }

      const row = classifyUncertainConfirmation(await probeOperatorReset(deps.db, { run }));

      if (row === "U2-a") {
        terminal.say("Confirmed.");
        return showCodes();
      }

      if (row === "U2-b") {
        terminal.say("Not confirmed.");
        continue;
      }

      if (row === "U2-c") {
        terminal.say("The new authenticator is confirmed, but the recovery codes changed after the reset, so they are not shown. Run a fresh reset to obtain codes.");
        return finish(false, "RESET_STATE_CHANGED");
      }

      if (row === "U2-d") {
        terminal.say("The account was disabled during this run (D-16).");
        return finish(false, "RESET_ACCOUNT_DISABLED_DURING_RUN");
      }

      if (row === "U2-g") {
        terminal.say(CONFIRMATION_UNCONFIRMED_MESSAGE);
        return finish(false, "RESET_UNCONFIRMED");
      }

      terminal.say(STATE_CHANGED_MESSAGE);
      return finish(false, "RESET_STATE_CHANGED");
    }

    terminal.say(`The new authenticator was not confirmed; the account cannot sign in. Run \`${RESET_SUBCOMMAND}\` again.`);
    return finish(false, "NOT_CONFIRMED");
  } finally {
    secret.fill(0);
  }
}
