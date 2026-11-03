/**
 * The password policy applied **when a password is set** (`ADR-004` P-2, issue #260 §3.7).
 *
 * - NFC normalization first; the stored hash covers the NFC form, so sign-in normalizes too.
 * - **15 to 128 code points**, each counted once.
 * - **No composition rules and no expiry.**
 * - A case-insensitive match against the committed **offline blocklist** is refused (L-2,
 *   OD-2). See `PASSWORD-BLOCKLIST.md` for its provenance, its licence uncertainty and its
 *   suitability limit: it was chosen for synthetic local accounts, and whether a larger corpus
 *   is needed is a question for the security review before any public reachability.
 *
 * Sign-in never applies the policy. The refusal names the rule, never the value.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MIN_PASSWORD_CODE_POINTS = 15;
export const MAX_PASSWORD_CODE_POINTS = 128;

export type PasswordPolicyResult =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly rule: "TOO_SHORT" | "TOO_LONG" | "BLOCKLISTED" };

let blocklist: ReadonlySet<string> | undefined;

/** The committed blocklist, read once. Line endings are normalized for any checkout. */
export function passwordBlocklist(): ReadonlySet<string> {
  blocklist ??= new Set(
    readFileSync(fileURLToPath(new URL("./password-blocklist.txt", import.meta.url)), "utf8")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line !== ""),
  );

  return blocklist;
}

export function checkNewPassword(candidate: string): PasswordPolicyResult {
  const normalized = candidate.normalize("NFC");
  const length = [...normalized].length;

  if (length < MIN_PASSWORD_CODE_POINTS) {
    return { ok: false, rule: "TOO_SHORT" };
  }

  if (length > MAX_PASSWORD_CODE_POINTS) {
    return { ok: false, rule: "TOO_LONG" };
  }

  return passwordBlocklist().has(normalized.toLowerCase())
    ? { ok: false, rule: "BLOCKLISTED" }
    : { ok: true, normalized };
}
