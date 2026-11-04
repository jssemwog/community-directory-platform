/**
 * The display-once documents of the recovery journey (issue #268 §3.4, §3.4.1, RJ-D2, RJ-D3 and
 * RJ-D14).
 *
 * Each is the body of the `POST` response that created what it shows: a minimal, complete HTML
 * document built here, never a page that could be fetched again. Nothing it shows is stored in
 * plaintext anywhere, so a lost or closed document cannot be shown again (§3.4.2).
 *
 * - **Every dynamic value is HTML-escaped**, even values that are only hex, base32, a URI or a UUID.
 * - **No script, no external resource and no request-bearing attribute carries a secret** (§3.4,
 *   the URL prohibition). Forms post to fixed paths, and the TOTP code and `factor_id` travel only
 *   in the `POST` body. The `otpauth://` URI appears **only as text** in the start document, never
 *   as a link (RJ-D14).
 * - Headings, labelled fields and plain links keep every document usable by keyboard alone.
 *
 * The documents are `no-store`, and the Proxy adds its headers. Whether a browser can show one again
 * from its back/forward cache, or warns before resubmitting, is not claimed (§11).
 */

import { NO_STORE } from "./entry-points";

export const RECOVERY_PATH = "/admin/recovery";
export const RECOVERY_START_PATH = "/admin/recovery/reenrolment/start";
export const RECOVERY_COMPLETE_PATH = "/admin/recovery/reenrolment/complete";
export const RECOVERY_CODES_PATH = "/admin/recovery/codes";
export const RECOVERY_SIGN_OUT_PATH = "/admin/recovery/sign-out";

/** The warnings shown before and after the actions that replace material (§3.4.1). */
export const WARNINGS = {
  startBefore: "Starting again replaces any setup you began in this session. A secret shown earlier will stop working.",
  startAfter: "Do not reload this page: reloading starts a new setup, and this secret stops working.",
  codesBefore: "This replaces every recovery code, including any shown before. Store the new codes before leaving the page.",
  codesAfter: "Do not reload this page: reloading replaces these codes.",
  completedAfter: "These codes are shown only once. Reloading will not show them again.",
} as const;

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escape a value for text or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function documentOf(title: string, body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** A display-once document as a response: `200`, `text/html`, `no-store`, with any `Set-Cookie` given. */
export function documentResponse(html: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE });

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(html, { status: 200, headers });
}

function codeList(codes: readonly string[]): string {
  return ["<ol>", ...codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`), "</ol>"].join("\n");
}

/** The completion form, for the start document and the retry form of "code not accepted". */
function completionForm(factorId: string, label: string): string {
  return [
    `<form method="post" action="${RECOVERY_COMPLETE_PATH}">`,
    `<input type="hidden" name="factor_id" value="${escapeHtml(factorId)}">`,
    "<p>",
    `<label for="code">${escapeHtml(label)}</label>`,
    "<br>",
    '<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>',
    "</p>",
    '<button type="submit">Finish setup</button>',
    "</form>",
  ].join("\n");
}

/** The restart form, with its replacement warning (§3.4.1). */
export function restartForm(): string {
  return [
    `<form method="post" action="${RECOVERY_START_PATH}">`,
    `<p>${escapeHtml(WARNINGS.startBefore)}</p>`,
    '<button type="submit">Start the authenticator setup again</button>',
    "</form>",
  ].join("\n");
}

/** Start: the new secret, shown once as text only, and the completion form. */
export function startDocument(enrolment: { readonly uri: string; readonly base32: string }, factorId: string): string {
  return documentOf(
    "New authenticator",
    [
      "<h1>New authenticator</h1>",
      "<p>Add this account to your authenticator app now. It is shown only once.</p>",
      `<p role="alert">${escapeHtml(WARNINGS.startAfter)}</p>`,
      "<h2>Setup key</h2>",
      `<p>Secret (base32): <code>${escapeHtml(enrolment.base32)}</code></p>`,
      `<p>Enrolment URI (copy it into your app; it is not a link): <code>${escapeHtml(enrolment.uri)}</code></p>`,
      "<h2>Confirm</h2>",
      completionForm(factorId, "Six-digit code from your new authenticator"),
    ].join("\n"),
  );
}

/** Completion: the ten fresh codes, shown once. The recovery session has ended. */
export function completionDocument(codes: readonly string[]): string {
  return documentOf(
    "Authenticator set up",
    [
      "<h1>Authenticator set up</h1>",
      "<p>Your recovery session has ended. Sign in again with your password and your new authenticator.</p>",
      "<h2>New recovery codes</h2>",
      `<p role="alert">${escapeHtml(WARNINGS.completedAfter)}</p>`,
      "<p>Each code works once, after your password, if your authenticator is lost. Store them offline now.</p>",
      codeList(codes),
      '<p><a href="/admin/sign-in">Go to sign-in</a></p>',
    ].join("\n"),
  );
}

/** Regeneration: the ten new codes, shown once. The recovery session continues. */
export function codesDocument(codes: readonly string[]): string {
  return documentOf(
    "New recovery codes",
    [
      "<h1>New recovery codes</h1>",
      `<p role="alert">${escapeHtml(WARNINGS.codesAfter)}</p>`,
      "<p>Every earlier code no longer works. Each new code works once, after your password. Store them offline now; they are shown only once.</p>",
      codeList(codes),
      `<p><a href="${RECOVERY_PATH}">Return to the recovery session</a></p>`,
    ].join("\n"),
  );
}

/**
 * "Code not accepted" (RJ-D3): one template and one message for every completion refusal. It
 * differs only in whether the retry form is present and in the escaped `factor_id` it carries. The
 * secret is never shown again.
 */
export function notAcceptedDocument(retryFactorId: string | undefined): string {
  return documentOf(
    "Code not accepted",
    [
      "<h1>Code not accepted</h1>",
      '<p role="alert">The setup could not be finished. Try a current code again, or start the setup again.</p>',
      ...(retryFactorId === undefined ? [] : ["<h2>Try again</h2>", completionForm(retryFactorId, "Six-digit code from your new authenticator")]),
      "<h2>Start again</h2>",
      restartForm(),
      `<p><a href="${RECOVERY_PATH}">Return to the recovery session</a></p>`,
    ].join("\n"),
  );
}
