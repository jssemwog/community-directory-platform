/**
 * The recovery journey's handler bodies (issue #268 §3.2, §3.4 and §3.6). The `src/app/admin/`
 * Route Handlers are thin adapters over these, as for the sign-in entry points.
 *
 * **Order, for every entry:**
 * 1. the local gate (closed: the uniform `404`);
 * 2. the request checks (`checkForm`), with the exact field list;
 * 3. the credential cookie, read with the duplicate-aware parser;
 * 4. the runtime;
 * 5. the merged step.
 *
 * **Two classes of non-success are kept apart (§3.6).**
 * - **Class A, a request refusal,** fails step 2. It makes **no storage call** and sends **no
 *   `Set-Cookie`**, so a forged or malformed request can neither consume, count, end nor clear
 *   anything.
 * - **Class B, an authentication outcome,** comes after step 2. Only class B sets or clears cookies.
 *
 * **Logout is not an authorized recovery action** (RJ-D12). It deletes whatever row a well-formed
 * token names, of either kind, live or expired, and gives one completed answer; only a runtime or
 * storage failure differs (`503`, cookie kept).
 *
 * **Logging (`OD-8`):** one line per outcome, with the entry point, the outcome code and a
 * timestamp only; never a code, secret, token, digest, factor id, username or address.
 */

import { randomUUID } from "node:crypto";

import { logout } from "../../data/administrator-authentication";
import {
  reenrolmentCompletion,
  reenrolmentStart,
  recoveryStep,
  regeneration,
  type RecoveryDependencies,
} from "../../domain/administrator-auth/recovery";
import { tokenDigest } from "../../domain/administrator-auth/token";
import { enrolmentUriOf, RECOVERY_ENROLMENT_LABEL } from "../../domain/administrator-auth/totp-enrolment";
import {
  administratorRuntime,
  DEFAULT_FACTORIES,
  LOCAL_SOURCE_ADDRESS,
  recordDiagnostic,
  type AdministratorRuntime,
} from "./authentication-runtime";
import {
  codesDocument,
  completionDocument,
  documentResponse,
  notAcceptedDocument,
  RECOVERY_PATH,
  startDocument,
} from "./display-once";
import { closedGateResponse, FAILURE_LOCATION, gateOf, NO_STORE, RETRY_AFTER_SECONDS, seeOther, SIGN_IN_PATH, type EntryOptions } from "./entry-points";
import { LOCAL_TOTP_KEY_VERSION, type LocalAdministratorConfiguration } from "./local-gate";
import { checkForm } from "./request-checks";
import { recoverySessionOf } from "./require-recovery-session";
import { CHALLENGE_COOKIE, clearCookie, readCookie, RECOVERY_COOKIE, SESSION_COOKIE, setCookie } from "./session-cookies";

export type RecoveryEntryPoint = "recovery-code" | "recovery-start" | "recovery-complete" | "recovery-codes" | "recovery-sign-out";

/** Where a recovery-session action goes on a class A refusal or a non-session failure. */
export const RECOVERY_NOTICE_LOCATION = `${RECOVERY_PATH}?notice=1`;

/** A `factor_id` exactly as `randomUUID` issues it (§3.4 step 5). */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** This module's evaluation, so a hot reload is visible in the diagnostics. */
const MODULE_INSTANCE = randomUUID();

function outcomeLogger(options: EntryOptions): (entry: RecoveryEntryPoint, outcome: string) => void {
  const write = options.log ?? ((line: string) => console.info(line));
  const now = options.now ?? Date.now;

  return (entry, outcome) =>
    write(JSON.stringify({ event: "administrator-authentication", entry, outcome, at: new Date(now()).toISOString() }));
}

async function runtimeFor(
  configuration: LocalAdministratorConfiguration,
  options: EntryOptions,
  entry: RecoveryEntryPoint,
): Promise<AdministratorRuntime | undefined> {
  try {
    const runtime = await administratorRuntime(configuration, options.factories ?? DEFAULT_FACTORIES);

    recordDiagnostic(
      "entry",
      { entry, runtimeId: runtime.runtimeId, limiterId: runtime.limiterId, entryModule: MODULE_INSTANCE },
      options.environment,
    );
    return runtime;
  } catch {
    return undefined;
  }
}

/** The recovery steps' dependencies: the runtime's, with the one local key version selected. */
function recoveryDependencies(runtime: AdministratorRuntime): RecoveryDependencies {
  return { ...runtime.deps, currentTotpKeyVersion: LOCAL_TOTP_KEY_VERSION };
}

/** Class B, no usable recovery session: to sign-in, clearing the recovery cookie. */
function noRecoverySession(): Response {
  return seeOther(FAILURE_LOCATION, [clearCookie(RECOVERY_COOKIE)]);
}

/** `POST /admin/sign-in/recovery/verify`: password (already verified into a challenge), then a code. */
export async function recoveryCodeEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  const configuration = gateOf(request, options);

  if (configuration === undefined) {
    return closedGateResponse();
  }

  const log = outcomeLogger(options);
  const form = await checkForm(request, configuration.origin, ["code"]);

  if (!form.ok) {
    // Class A: no storage call and no Set-Cookie; the challenge cookie is left as it is.
    log("recovery-code", "REQUEST_REFUSED");
    return seeOther(FAILURE_LOCATION);
  }

  const clearChallenge = clearCookie(CHALLENGE_COOKIE);
  const challengeToken = readCookie(request.headers.get("cookie"), CHALLENGE_COOKIE);

  if (challengeToken === undefined) {
    log("recovery-code", "NO_CHALLENGE");
    return seeOther(FAILURE_LOCATION, [clearChallenge]);
  }

  const runtime = await runtimeFor(configuration, options, "recovery-code");

  if (runtime === undefined) {
    log("recovery-code", "RUNTIME_UNAVAILABLE");
    return seeOther(FAILURE_LOCATION, [clearChallenge]);
  }

  const outcome = await recoveryStep(recoveryDependencies(runtime), {
    challengeToken,
    code: form.fields.get("code") ?? "",
    sourceAddress: LOCAL_SOURCE_ADDRESS,
  });

  log("recovery-code", outcome.code);

  if (outcome.code === "RECOVERY_SESSION_ISSUED") {
    const seconds = (outcome.absoluteExpiresAt - runtime.deps.clock()) / 1000;
    // Storage has already deleted every other session of the administrator (`ADR-004` P-4).
    return seeOther(RECOVERY_PATH, [
      clearChallenge,
      clearCookie(SESSION_COOKIE),
      setCookie(RECOVERY_COOKIE, outcome.recoverySessionToken, seconds),
    ]);
  }

  return seeOther(FAILURE_LOCATION, [clearChallenge]);
}

interface ActionContext {
  readonly configuration: LocalAdministratorConfiguration;
  readonly fields: ReadonlyMap<string, string>;
  readonly token: string;
  readonly runtime: AdministratorRuntime;
  readonly log: (outcome: string) => void;
}

/** Steps 1 to 4 for an authorized recovery action, then `body` (step 5). */
async function recoveryAction(
  request: Request,
  options: EntryOptions,
  entry: RecoveryEntryPoint,
  expected: readonly string[],
  body: (context: ActionContext) => Promise<Response>,
): Promise<Response> {
  const configuration = gateOf(request, options);

  if (configuration === undefined) {
    return closedGateResponse();
  }

  const logger = outcomeLogger(options);
  const log = (outcome: string) => logger(entry, outcome);
  const form = await checkForm(request, configuration.origin, expected);

  if (!form.ok) {
    // Class A: no storage call and no Set-Cookie (§3.6, RJ-D13).
    log("REQUEST_REFUSED");
    return seeOther(RECOVERY_NOTICE_LOCATION);
  }

  const token = readCookie(request.headers.get("cookie"), RECOVERY_COOKIE);

  if (token === undefined) {
    log("NO_SESSION");
    return noRecoverySession();
  }

  const runtime = await runtimeFor(configuration, options, entry);

  if (runtime === undefined) {
    log("RUNTIME_UNAVAILABLE");
    return seeOther(RECOVERY_NOTICE_LOCATION);
  }

  return body({ configuration, fields: form.fields, token, runtime, log });
}

/** `POST /admin/recovery/reenrolment/start`: a new pending factor, its secret shown once. */
export function recoveryStartEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  return recoveryAction(request, options, "recovery-start", [], async ({ token, runtime, log }) => {
    const outcome = await reenrolmentStart(recoveryDependencies(runtime), { recoverySessionToken: token });
    log(outcome.code);

    if (outcome.code === "REENROLMENT_STARTED") {
      try {
        return documentResponse(startDocument(enrolmentUriOf(RECOVERY_ENROLMENT_LABEL, outcome.secret), outcome.factorId));
      } finally {
        outcome.secret.fill(0);
      }
    }

    // Start's only refusal is RECOVERY_SESSION_INVALID; a missing key or storage failure keeps the session.
    return outcome.code === "REFUSED" ? noRecoverySession() : seeOther(RECOVERY_NOTICE_LOCATION);
  });
}

/** `POST /admin/recovery/reenrolment/complete`: activate the factor; ten fresh codes shown once. */
export function recoveryCompleteEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  return recoveryAction(request, options, "recovery-complete", ["factor_id", "code"], async ({ configuration, fields, token, runtime, log }) => {
    const factorId = fields.get("factor_id") ?? "";

    if (!CANONICAL_UUID.test(factorId)) {
      // Never passed to storage. The session is established with the recovery page's own check,
      // whose `checkSession` refreshes a live session's activity before rejecting its kind (§3.5).
      const session = await recoverySessionOf(configuration, token, { factories: options.factories ?? DEFAULT_FACTORIES, log: options.log });
      log("INVALID_FACTOR_ID");
      return session === "valid" ? documentResponse(notAcceptedDocument(undefined)) : noRecoverySession();
    }

    const outcome = await reenrolmentCompletion(recoveryDependencies(runtime), {
      recoverySessionToken: token,
      factorId,
      code: fields.get("code") ?? "",
    });
    log(outcome.code);

    if (outcome.code === "REENROLMENT_COMPLETED") {
      // Storage has already deleted the recovery session (FA-R).
      return documentResponse(completionDocument(outcome.recoveryCodes), [clearCookie(RECOVERY_COOKIE)]);
    }

    if (outcome.code === "REFUSED") {
      return outcome.reason === "RECOVERY_SESSION_INVALID" ? noRecoverySession() : documentResponse(notAcceptedDocument(factorId));
    }

    return seeOther(RECOVERY_NOTICE_LOCATION);
  });
}

/** `POST /admin/recovery/codes`: replace the whole code set; the ten new codes shown once. */
export function recoveryCodesEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  return recoveryAction(request, options, "recovery-codes", [], async ({ token, runtime, log }) => {
    const outcome = await regeneration(recoveryDependencies(runtime), { recoverySessionToken: token });
    log(outcome.code);

    if (outcome.code === "RECOVERY_CODES_REGENERATED") {
      return documentResponse(codesDocument(outcome.recoveryCodes));
    }

    return outcome.code === "REFUSED" ? noRecoverySession() : seeOther(RECOVERY_NOTICE_LOCATION);
  });
}

/** The recovery logout's incomplete answer: not presented as completed, and the cookie is kept. */
function recoverySignOutIncomplete(): Response {
  return new Response("Ending the recovery session did not complete. Go back and try again.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE, "Retry-After": RETRY_AFTER_SECONDS },
  });
}

/**
 * `POST /admin/recovery/sign-out` (RJ-D5, RJ-D12): the uniform completed answer for a valid,
 * expired or unknown session and for an absent, malformed or duplicated cookie.
 */
export async function recoverySignOutEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  const configuration = gateOf(request, options);

  if (configuration === undefined) {
    return closedGateResponse();
  }

  const log = outcomeLogger(options);
  const form = await checkForm(request, configuration.origin, []);

  if (!form.ok) {
    // Class A: nothing deleted, no Set-Cookie.
    log("recovery-sign-out", "REQUEST_REFUSED");
    return seeOther(FAILURE_LOCATION);
  }

  const token = readCookie(request.headers.get("cookie"), RECOVERY_COOKIE);
  const digest = token === undefined ? null : tokenDigest(token);

  if (digest !== null) {
    const runtime = await runtimeFor(configuration, options, "recovery-sign-out");

    if (runtime === undefined) {
      log("recovery-sign-out", "RUNTIME_UNAVAILABLE");
      return recoverySignOutIncomplete();
    }

    const outcome = await logout(runtime.deps.db, { tokenDigest: digest });

    if (!outcome.ok) {
      log("recovery-sign-out", outcome.failure.code);
      return recoverySignOutIncomplete();
    }

    log("recovery-sign-out", outcome.value.code);
  } else {
    log("recovery-sign-out", "NO_SESSION");
  }

  return seeOther(SIGN_IN_PATH, [clearCookie(RECOVERY_COOKIE)]);
}
