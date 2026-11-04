/**
 * The **synthetic-account provisioning command** for the local journey (`ADR-004` P-6 provisioning
 * form, `ADR-028` *Migration sequencing*; issue #260 §3.6 and OD-4).
 *
 * Run by an operator through `npm run demo:local:admin -- add`, never imported by the
 * application server and never on the request path. It creates one administrator whose username
 * starts with `synthetic-`, sets the password through the policy (`password-policy.ts`), enrols
 * TOTP and confirms it with one current code **together with ten recovery codes**, through the
 * `ADR-029` RA-5 confirmation (issue #268 §3.1). The codes are shown **once**, to the operator's
 * terminal only. After this, nothing calls the caller-restricted `confirmTotpEnrolment`; it stays
 * reserved for the future operator reset (RA-7).
 *
 * **Provisioning stays incomplete under `ADR-004`**: disabling an account, resetting a password or
 * TOTP, revoking sessions and the operator reset are not built, and each is required before any
 * public reachability. The command says so every time it runs.
 *
 * The password is read without echo and never printed. The `otpauth://` URI and the base32 secret
 * are shown **once**, to the operator's terminal only: never logged, written to a file or
 * returned by any web route; so are the recovery codes. On a wrong confirmation code the factor
 * stays `pending_confirmation` and no code is stored, so the account cannot sign in; the command does
 * not repeat the confirmation, and `demo:local:reset` clears a stranded synthetic account.
 *
 * Terminal input and output go through `ProvisioningTerminal`, so tests drive the command
 * without a TTY.
 */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { StringDecoder } from "node:string_decoder";

import type { Kysely } from "kysely";
import {
  confirmTotpEnrolmentWithRecoveryCodes,
  createAdministrator,
  findCredential,
  startTotpEnrolment,
  type Clock,
} from "../../src/data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { hashPassword } from "../../src/domain/administrator-auth/password-hash";
import { checkNewPassword } from "../../src/domain/administrator-auth/password-policy";
import { generateRecoveryCodes } from "../../src/domain/administrator-auth/recovery-code";
import { sealTotpSecret } from "../../src/domain/administrator-auth/secret-box";
import { totpVerifierFor } from "../../src/domain/administrator-auth/sign-in";
import { generateTotpSecret } from "../../src/domain/administrator-auth/totp";
import { enrolmentUriOf as sharedEnrolmentUriOf, TOTP_ISSUER } from "../../src/domain/administrator-auth/totp-enrolment";
import { isProvisionableUsername, normalizeSubmittedUsername } from "../../src/domain/administrator-auth/username";
import { LOCAL_TOTP_KEY_VERSION } from "../../src/interface/admin/local-gate";

export const SYNTHETIC_PREFIX = "synthetic-";
export { TOTP_ISSUER };

export const INCOMPLETE_NOTICE =
  "Ten recovery codes are shown once when enrolment is confirmed; store them offline. " +
  "Provisioning is still incomplete under ADR-004: disabling an account, password or TOTP reset, session revocation and the operator reset are not implemented. " +
  "It is a synthetic account for the local journey only.";

export interface ProvisioningTerminal {
  /** Both standard input and output are interactive terminals. */
  readonly interactive: boolean;
  ask(prompt: string): Promise<string>;
  /** Read a line without echoing it. */
  askSecret(prompt: string): Promise<string>;
  say(line: string): void;
}

export interface ProvisioningDependencies {
  readonly db: Kysely<AdministratorAuthenticationDatabase>;
  readonly clock: Clock;
  readonly totpKey: Buffer;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The launcher's own loopback cluster; checked again here. */
  readonly databaseUrl: string;
}

export type ProvisioningResult =
  | { readonly ok: true; readonly administratorId: string; readonly username: string }
  | {
      readonly ok: false;
      readonly reason:
        | "NOT_INTERACTIVE"
        | "PRODUCTION"
        | "NOT_LOCAL_DATABASE"
        | "USERNAME_REFUSED"
        | "PASSWORD_REFUSED"
        | "PASSWORDS_DIFFER"
        | "STORAGE_FAILURE"
        | "NOT_CONFIRMED";
    };

/**
 * The refusals that need no database: a non-interactive terminal, or production mode. The
 * launcher's `admin add` checks these **before** it starts the cluster, migrates or creates the
 * keys file, and provisioning checks them again.
 */
export function launchRefusalOf(
  terminal: Pick<ProvisioningTerminal, "interactive">,
  environment: Readonly<Record<string, string | undefined>>,
): { readonly reason: "NOT_INTERACTIVE" | "PRODUCTION"; readonly message: string } | undefined {
  if (!terminal.interactive) {
    return { reason: "NOT_INTERACTIVE", message: "Run this command in an interactive terminal; nothing was changed." };
  }

  if (environment.NODE_ENV === "production") {
    return { reason: "PRODUCTION", message: "This command never runs with NODE_ENV=production; nothing was changed." };
  }

  return undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const RULE_MESSAGES = {
  TOO_SHORT: "The password must be at least 15 characters.",
  TOO_LONG: "The password must be at most 128 characters.",
  BLOCKLISTED: "That password is on the list of common or compromised passwords.",
} as const;

/** The enrolment URI an authenticator app reads; shown once. Delegates to the shared builder. */
export function enrolmentUriOf(username: string, secret: Buffer): { readonly uri: string; readonly base32: string } {
  return sharedEnrolmentUriOf(username, secret);
}

/** Provision one synthetic administrator. Writes nothing unless every check before it passed. */
export async function provisionSyntheticAdministrator(
  terminal: ProvisioningTerminal,
  deps: ProvisioningDependencies,
): Promise<ProvisioningResult> {
  terminal.say(INCOMPLETE_NOTICE);

  const refusal = launchRefusalOf(terminal, deps.environment);

  if (refusal !== undefined) {
    terminal.say(refusal.message);
    return { ok: false, reason: refusal.reason };
  }

  if (!isLoopbackDatabaseUrl(deps.databaseUrl)) {
    terminal.say("This command provisions only the local demo's loopback database; nothing was changed.");
    return { ok: false, reason: "NOT_LOCAL_DATABASE" };
  }

  const username = normalizeSubmittedUsername(await terminal.ask(`Username (must start with "${SYNTHETIC_PREFIX}"): `));
  const existing = isProvisionableUsername(username) ? await findCredential(deps.db, username) : undefined;

  if (!username.startsWith(SYNTHETIC_PREFIX) || existing === undefined || !existing.ok || existing.value !== undefined) {
    terminal.say("That username cannot be used. Use a new name of 3 to 64 characters (a-z, 0-9, ., _ or -) starting with \"synthetic-\"; nothing was changed.");
    return { ok: false, reason: existing !== undefined && !existing.ok ? "STORAGE_FAILURE" : "USERNAME_REFUSED" };
  }

  const policy = checkNewPassword(await terminal.askSecret("Password (15 to 128 characters; not shown): "));

  if (!policy.ok) {
    terminal.say(`${RULE_MESSAGES[policy.rule]} Nothing was changed.`);
    return { ok: false, reason: "PASSWORD_REFUSED" };
  }

  if ((await terminal.askSecret("Password again: ")).normalize("NFC") !== policy.normalized) {
    terminal.say("The passwords differ; nothing was changed.");
    return { ok: false, reason: "PASSWORDS_DIFFER" };
  }

  const administratorId = randomUUID();
  const created = await createAdministrator(
    deps.db,
    { administratorId, username, passwordHash: await hashPassword(policy.normalized) },
    deps.clock,
  );

  if (!created.ok) {
    terminal.say("The administrator could not be stored; nothing was changed.");
    return { ok: false, reason: "STORAGE_FAILURE" };
  }

  const secret = generateTotpSecret();

  try {
    const factorId = randomUUID();
    const sealed = sealTotpSecret(deps.totpKey, LOCAL_TOTP_KEY_VERSION, administratorId, secret);
    const started = await startTotpEnrolment(deps.db, { administratorId, factorId, material: sealed }, deps.clock);

    if (!started.ok || started.value.code !== "ENROLMENT_STARTED") {
      terminal.say("TOTP enrolment could not be started; the account exists but cannot sign in. Run `npm run demo:local:reset` to clear it.");
      return { ok: false, reason: "STORAGE_FAILURE" };
    }

    const enrolment = enrolmentUriOf(username, secret);
    terminal.say("Add this account to your authenticator app now. It is shown only once:");
    terminal.say(`  ${enrolment.uri}`);
    terminal.say(`  Secret (base32): ${enrolment.base32}`);

    // The code is verified under the lock, at the post-lock instant, with the ten codes (RA-5).
    const code = (await terminal.ask("Current six-digit code: ")).trim();
    const codes = generateRecoveryCodes();
    const confirmed = await confirmTotpEnrolmentWithRecoveryCodes(
      deps.db,
      {
        administratorId,
        factorId,
        verify: totpVerifierFor(new Map([[LOCAL_TOTP_KEY_VERSION, deps.totpKey]]), code),
        codeDigests: codes.map((generated) => generated.digest),
      },
      deps.clock,
    );

    if (confirmed.ok && confirmed.value.code === "REFUSED" && confirmed.value.reason === "WRONG_CODE") {
      terminal.say("That code did not match. The account exists but cannot sign in until enrolment is confirmed, which this command does not repeat; run `npm run demo:local:reset` to clear it.");
      return { ok: false, reason: "NOT_CONFIRMED" };
    }

    if (!confirmed.ok || confirmed.value.code !== "ENROLMENT_CONFIRMED") {
      terminal.say("TOTP enrolment could not be confirmed and no recovery code was stored; the account cannot sign in. Run `npm run demo:local:reset` to clear it.");
      return { ok: false, reason: "STORAGE_FAILURE" };
    }

    terminal.say("Recovery codes. Each works once, after the password, if the authenticator is lost. Store them offline now; they are shown only once:");

    for (const generated of codes) {
      terminal.say(`  ${generated.code}`);
    }
  } finally {
    secret.fill(0);
  }

  terminal.say(`Provisioned ${username}. Sign in at the local journey's /admin/sign-in.`);
  terminal.say(INCOMPLETE_NOTICE);
  return { ok: true, administratorId, username };
}

/** The streams the real terminal uses; tests pass disposable TTY-shaped fixtures. */
export interface TerminalStreams {
  readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?(mode: boolean): unknown; pause(): unknown; resume(): unknown };
  readonly output: NodeJS.WritableStream & { readonly isTTY?: boolean };
}

const INTERRUPTED = "Interrupted; nothing further was changed.";

/**
 * The real terminal: line input through `readline`, secret input in raw mode without echo.
 *
 * Each question opens its own `readline` interface and closes it before returning, so no
 * `readline` listener is attached while a secret is typed: nothing can echo it. Secret input
 * is decoded as a UTF-8 stream, so a character split across reads stays whole. Enter ends it;
 * Ctrl-C, Ctrl-D or the end of input interrupt it. Raw mode is always switched off again,
 * however the prompt ends.
 */
export function processTerminal(
  streams: TerminalStreams = { input: process.stdin, output: process.stdout },
): ProvisioningTerminal & { close(): void } {
  const { input, output } = streams;

  const ask = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const lines = readline.createInterface({ input, output, terminal: input.isTTY === true });
      let answered = false;

      lines.once("SIGINT", () => lines.close());
      lines.once("close", () => {
        if (!answered) {
          reject(new Error(INTERRUPTED));
        }
      });
      lines.question(prompt, (answer) => {
        answered = true;
        lines.close();
        resolve(answer);
      });
    });

  const askSecret = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder("utf8");
      let value = "";
      let finished = false;

      const finish = (error?: Error) => {
        if (finished) {
          return;
        }

        finished = true;
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);

        try {
          input.setRawMode?.(false);
        } finally {
          input.pause();
          output.write("\n");
        }

        if (error === undefined) {
          resolve(value);
        } else {
          reject(error);
        }
      };
      const onEnd = () => finish(new Error(INTERRUPTED));
      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);

        for (const character of text) {
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }

          if (character === "\u0003" || character === "\u0004") {
            finish(new Error(INTERRUPTED));
            return;
          }

          if (character === "\u007f" || character === "\b") {
            value = [...value].slice(0, -1).join("");
          } else if (character >= " ") {
            value += character;
          }
        }
      };

      output.write(prompt);

      try {
        input.setRawMode?.(true);
        input.on("data", onData);
        input.once("end", onEnd);
        input.resume();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(INTERRUPTED));
      }
    });

  return {
    interactive: input.isTTY === true && output.isTTY === true,
    ask,
    askSecret,
    say: (line) => output.write(`${line}\n`),
    close: () => {
      input.setRawMode?.(false);
      input.pause();
    },
  };
}
