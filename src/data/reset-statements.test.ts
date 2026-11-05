/**
 * Static checks for the operator reset (Unit OR Scope Gate, revision 4, §6.2 and Annex A N2).
 *
 * - **No new statement names `disabled_at` in a `SET` clause** (D-16: the reset never re-enables).
 * - **T1's factor write names a `NULL` origin** in both its insert and its update (`ADR-029` RA-3).
 * - **The reset never calls** `startTotpEnrolment` or `confirmTotpEnrolment` (RA-7 reserves the
 *   latter; OR-D2a).
 * - **The trusted caller:** only the reset command imports T1, T2 and the probe.
 * - **T2 carries its bindings**: the hash comparison, the code-set statement and the guarded update.
 * - **The new outcome types are exhaustive.**
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import type { CredentialResetOutcome, OperatorResetConfirmationOutcome } from "./administrator-authentication";

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE = readFileSync(join(import.meta.dirname, "administrator-authentication.ts"), "utf8");
const RESET_SECTION = SOURCE.slice(SOURCE.indexOf("export interface ResetRun"));
const T1 = RESET_SECTION.slice(RESET_SECTION.indexOf("export async function resetAdministratorCredentials"), RESET_SECTION.indexOf("function isExpectedCodeSet"));
const T2 = RESET_SECTION.slice(RESET_SECTION.indexOf("export async function confirmOperatorReset"), RESET_SECTION.indexOf("export interface OperatorResetProbe"));

function never(value: never): never {
  throw new Error(`unhandled outcome ${JSON.stringify(value)}`);
}

const reset = (o: CredentialResetOutcome) => {
  switch (o.code) {
    case "CREDENTIALS_RESET":
    case "ADMINISTRATOR_NOT_FOUND":
      return o.code;
    default:
      return never(o);
  }
};
const confirmation = (o: OperatorResetConfirmationOutcome) => {
  switch (o.code) {
    case "RESET_CONFIRMED":
    case "REFUSED":
      return o.code;
    default:
      return never(o);
  }
};

/** Every non-test TypeScript source under the given directories. */
function sources(...directories: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry) && !/\.(test|e2e)\.tsx?$/.test(entry)) {
        found.push(path);
      }
    }
  };
  directories.forEach((directory) => walk(join(ROOT, directory)));
  return found;
}

describe("the operator reset's statements", () => {
  it("no reset statement names disabled_at in a SET clause", () => {
    expect(RESET_SECTION).not.toMatch(/set\s+[^;`]*?\bdisabled_at\s*=/i);
    expect(T1).toMatch(/password_disabled_at = null/);
  });

  it("T1's factor write names a NULL origin in the insert and the update", () => {
    const factor = T1.slice(T1.indexOf('"reset-factor"'), T1.indexOf("deleteRecoveryCodes"));
    expect(factor).toMatch(/key_version, last_accepted_step, origin_recovery_session_id\)/);
    expect(factor).toMatch(/\$\{material\.keyVersion\}, null, null\)/);
    expect(factor).toMatch(/origin_recovery_session_id = null`/);
  });

  it("the reset never calls startTotpEnrolment or confirmTotpEnrolment", () => {
    expect(RESET_SECTION).not.toMatch(/\bstartTotpEnrolment\(/);
    expect(RESET_SECTION).not.toMatch(/\bconfirmTotpEnrolment\(/);
    const command = readFileSync(join(ROOT, "scripts", "local-demo", "administrator-reset.ts"), "utf8");
    expect(command).not.toMatch(/\bstartTotpEnrolment\b/);
    expect(command).not.toMatch(/\bconfirmTotpEnrolment\b/);
  });

  it("only the reset command imports T1, T2 and the probe", () => {
    // `tests/` holds only test code (the browser harness reaches storage directly, as for RV).
    const importers = sources("src", "scripts")
      .filter((path) => /\b(resetAdministratorCredentials|confirmOperatorReset|probeOperatorReset)\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path).replace(/\\/g, "/"))
      .filter((path) => path !== "src/data/administrator-authentication.ts");

    expect(importers).toEqual(["scripts/local-demo/administrator-reset.ts"]);
  });

  it("T2 compares the run's hash, checks the exact code set, and guards its update", () => {
    expect(T2).toMatch(/administrator\.password_hash !== reset\.expectedPasswordHash/);
    expect(T2).toMatch(/storedCodeSetIs\(trx, administratorId, reset\.expectedCodeDigests\)/);
    const update = T2.slice(T2.indexOf('"confirm-operator-reset"'));
    expect(update).toMatch(/factor_id = \$\{factorId\}/);
    expect(update).toMatch(/state = 'pending_confirmation'/);
    expect(update).toMatch(/origin_recovery_session_id is null/);
    expect(T2).not.toMatch(/insertRecoveryCodes/);
  });

  it("each new outcome type is handled exhaustively", () => {
    expect(reset({ code: "ADMINISTRATOR_NOT_FOUND" })).toBe("ADMINISTRATOR_NOT_FOUND");
    expect(confirmation({ code: "REFUSED", reason: "CODE_SET_CHANGED" })).toBe("REFUSED");
  });
});
