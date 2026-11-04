/**
 * The administrator entry points' handler bodies (issue #260 §3.2): password, code and sign-out,
 * plus the answer for every other method. The `src/app/admin/` Route Handlers are thin adapters
 * over these, which take a plain `Request` and return a `Response`, so they are testable without
 * a Next.js runtime.
 *
 * **Every request is gated first** (`local-gate.ts`). A closed gate gives one uniform refusal for
 * every method and input, so an unsupported method never reaches the framework's automatic 405
 * (§12 qualification 8). Within the gate, each state-changing request passes the request checks
 * (`request-checks.ts`) before any storage call.
 *
 * **Outcomes are generic** (`ADR-004` P-5): an unknown account, a wrong password or code, a
 * throttled step, a refused challenge, a storage failure and a refused request all give the same
 * `303` to the sign-in page. Only the limiter's overload differs, as `ADR-004` P-7 requires: a
 * `503` with `Retry-After`, the same for every account. No claim is made that these responses are
 * byte-identical or take equal time (§12 qualification 6).
 *
 * **Sign-out** gives one completed answer whether or not a session existed. When its deletion
 * cannot be attempted or fails, it says so (`503`, the session cookie kept) instead of
 * presenting the sign-out as completed.
 *
 * **Logging (§3.8, OD-8):** one line per outcome, carrying the entry point, the outcome code and
 * a timestamp, and nothing else.
 */

import { randomUUID } from "node:crypto";

import { logout } from "../../data/administrator-authentication";
import { passwordStep, totpStep } from "../../domain/administrator-auth/sign-in";
import { tokenDigest } from "../../domain/administrator-auth/token";
import {
  administratorRuntime,
  DEFAULT_FACTORIES,
  LOCAL_SOURCE_ADDRESS,
  recordDiagnostic,
  type AdministratorRuntime,
  type RuntimeFactories,
} from "./authentication-runtime";
import { openGateFor, type LocalAdministratorConfiguration } from "./local-gate";
import { checkForm } from "./request-checks";
import { CHALLENGE_COOKIE, clearCookie, readCookie, RECOVERY_COOKIE, SESSION_COOKIE, setCookie } from "./session-cookies";

export const SIGN_IN_PATH = "/admin/sign-in";
export const CODE_PATH = "/admin/sign-in/code";
export const PROTECTED_PATH = "/admin";
/** Where every failure and refusal goes; the page shows one generic notice. */
export const FAILURE_LOCATION = `${SIGN_IN_PATH}?notice=1`;
export const RETRY_AFTER_SECONDS = "5";

/** This module's evaluation, so a hot reload is visible in the diagnostics. */
const MODULE_INSTANCE = randomUUID();

export type EntryPoint = "password" | "code" | "sign-out";

export interface EntryOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly factories?: RuntimeFactories;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

export const NO_STORE = "no-store";

/** The single answer for a closed gate, at every entry point and for every method. */
export function closedGateResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

export function seeOther(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": NO_STORE });

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 303, headers });
}

function overloaded(): Response {
  return new Response("Try again later.", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE,
      "Retry-After": RETRY_AFTER_SECONDS,
    },
  });
}

function outcomeLogger(options: EntryOptions): (entry: EntryPoint, outcome: string) => void {
  const write = options.log ?? ((line: string) => console.info(line));
  const now = options.now ?? Date.now;

  return (entry, outcome) =>
    write(JSON.stringify({ event: "administrator-authentication", entry, outcome, at: new Date(now()).toISOString() }));
}

export function gateOf(request: Request, options: EntryOptions): LocalAdministratorConfiguration | undefined {
  return openGateFor(options.environment ?? process.env, request.headers.get("host"));
}

async function runtimeFor(
  configuration: LocalAdministratorConfiguration,
  options: EntryOptions,
  entry: EntryPoint,
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

/** `POST /admin/sign-in/password`: the password step. Issues only the pending challenge. */
export async function passwordEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  const configuration = gateOf(request, options);

  if (configuration === undefined) {
    return closedGateResponse();
  }

  const log = outcomeLogger(options);
  const form = await checkForm(request, configuration.origin, ["username", "password"]);

  if (!form.ok) {
    log("password", "REQUEST_REFUSED");
    return seeOther(FAILURE_LOCATION);
  }

  const runtime = await runtimeFor(configuration, options, "password");

  if (runtime === undefined) {
    log("password", "RUNTIME_UNAVAILABLE");
    return seeOther(FAILURE_LOCATION);
  }

  // The stored hash covers the NFC form the provisioning policy set (`ADR-004` P-2, §3.7).
  const outcome = await passwordStep(runtime.deps, {
    username: form.fields.get("username") ?? "",
    password: (form.fields.get("password") ?? "").normalize("NFC"),
    sourceAddress: LOCAL_SOURCE_ADDRESS,
  });

  // A `FAILED` outcome is returned only after its failure accounting committed (`sign-in.ts`),
  // so this record is the completed accounting event the D-17 test counts (§12 qualification 4).
  recordDiagnostic("password-outcome", { code: outcome.code }, options.environment);
  log("password", outcome.code);

  if (outcome.code === "CHALLENGE_ISSUED") {
    const seconds = (outcome.expiresAt - runtime.deps.clock()) / 1000;
    return seeOther(CODE_PATH, [setCookie(CHALLENGE_COOKIE, outcome.challengeToken, seconds)]);
  }

  return outcome.code === "OVERLOADED" ? overloaded() : seeOther(FAILURE_LOCATION);
}

/** `POST /admin/sign-in/code/verify`: the TOTP step. The only way to obtain a session. */
export async function codeEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  const configuration = gateOf(request, options);

  if (configuration === undefined) {
    return closedGateResponse();
  }

  const log = outcomeLogger(options);
  const form = await checkForm(request, configuration.origin, ["code"]);
  const clearChallenge = clearCookie(CHALLENGE_COOKIE);

  if (!form.ok) {
    log("code", "REQUEST_REFUSED");
    return seeOther(FAILURE_LOCATION);
  }

  const challengeToken = readCookie(request.headers.get("cookie"), CHALLENGE_COOKIE);

  if (challengeToken === undefined) {
    log("code", "NO_CHALLENGE");
    return seeOther(FAILURE_LOCATION, [clearChallenge]);
  }

  const runtime = await runtimeFor(configuration, options, "code");

  if (runtime === undefined) {
    log("code", "RUNTIME_UNAVAILABLE");
    return seeOther(FAILURE_LOCATION, [clearChallenge]);
  }

  const outcome = await totpStep(runtime.deps, {
    challengeToken,
    code: form.fields.get("code") ?? "",
    sourceAddress: LOCAL_SOURCE_ADDRESS,
  });

  recordDiagnostic("code-outcome", { code: outcome.code }, options.environment);
  log("code", outcome.code);

  if (outcome.code === "SESSION_ISSUED") {
    const seconds = (outcome.absoluteExpiresAt - runtime.deps.clock()) / 1000;
    // A stale recovery cookie never survives a full sign-in (issue #268 RJ-D6).
    return seeOther(PROTECTED_PATH, [
      clearChallenge,
      setCookie(SESSION_COOKIE, outcome.sessionToken, seconds),
      clearCookie(RECOVERY_COOKIE),
    ]);
  }

  return seeOther(FAILURE_LOCATION, [clearChallenge]);
}

/**
 * A sign-out whose deletion could not be attempted or did not complete (the runtime or storage
 * failed). It is not presented as completed: the session cookie is kept, so the session record
 * and the browser stay consistent and a retry can finish it.
 */
function signOutIncomplete(): Response {
  return new Response("Sign-out did not complete. You may still be signed in; go back and try again.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE, "Retry-After": RETRY_AFTER_SECONDS },
  });
}

/**
 * `POST /admin/sign-out`: delete the session record if any. An absent cookie and an unknown
 * session give the same completed answer; only a runtime or storage failure differs.
 */
export async function signOutEntry(request: Request, options: EntryOptions = {}): Promise<Response> {
  const configuration = gateOf(request, options);

  if (configuration === undefined) {
    return closedGateResponse();
  }

  const log = outcomeLogger(options);
  const form = await checkForm(request, configuration.origin, []);

  if (!form.ok) {
    log("sign-out", "REQUEST_REFUSED");
    return seeOther(FAILURE_LOCATION);
  }

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const digest = token === undefined ? null : tokenDigest(token);

  if (digest !== null) {
    const runtime = await runtimeFor(configuration, options, "sign-out");

    if (runtime === undefined) {
      log("sign-out", "RUNTIME_UNAVAILABLE");
      return signOutIncomplete();
    }

    const outcome = await logout(runtime.deps.db, { tokenDigest: digest });

    if (!outcome.ok) {
      log("sign-out", outcome.failure.code);
      return signOutIncomplete();
    }

    log("sign-out", outcome.value.code);
  } else {
    log("sign-out", "NO_SESSION");
  }

  return seeOther(SIGN_IN_PATH, [clearCookie(SESSION_COOKIE)]);
}

/** Every other method on an entry point: the closed-gate refusal, or `405` within the gate. */
export function unsupportedEntry(request: Request, options: EntryOptions = {}): Response {
  if (gateOf(request, options) === undefined) {
    return closedGateResponse();
  }

  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": NO_STORE } });
}
