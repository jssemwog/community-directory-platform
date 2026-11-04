/**
 * Static checks for issue #270 (§6.1 V-3 and Annex A N6).
 *
 * - **No statement clears `disabled_at`** (`ADR-028` D-12). No re-enablement exists, and the
 *   storage module must not contain one by accident.
 * - **The new outcome types are exhaustive.** Each `switch` below compiles only if it handles every
 *   outcome code, so adding a code without handling it fails the typecheck.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AccountDisableOutcome,
  AllSessionsRevocationOutcome,
  SessionListingOutcome,
  SessionRevocationOutcome,
} from "./administrator-authentication";

const SOURCE = readFileSync(join(import.meta.dirname, "administrator-authentication.ts"), "utf8");

function never(value: never): never {
  throw new Error(`unhandled outcome ${JSON.stringify(value)}`);
}

const listing = (o: SessionListingOutcome) => {
  switch (o.code) {
    case "SESSIONS_LISTED":
    case "ADMINISTRATOR_NOT_FOUND":
      return o.code;
    default:
      return never(o);
  }
};
const revokeOne = (o: SessionRevocationOutcome) => {
  switch (o.code) {
    case "SESSION_REVOKED":
    case "NO_SUCH_SESSION":
      return o.code;
    default:
      return never(o);
  }
};
const revokeAll = (o: AllSessionsRevocationOutcome) => {
  switch (o.code) {
    case "SESSIONS_REVOKED":
    case "ADMINISTRATOR_NOT_FOUND":
      return o.code;
    default:
      return never(o);
  }
};
const disable = (o: AccountDisableOutcome) => {
  switch (o.code) {
    case "DISABLED":
    case "ALREADY_DISABLED":
    case "ADMINISTRATOR_NOT_FOUND":
      return o.code;
    default:
      return never(o);
  }
};

describe("the storage module's statements (issue #270)", () => {
  it("never assigns disabled_at NULL, nor any value other than the disable's $now", () => {
    const assignments = [...SOURCE.matchAll(/set\s+[^;`]*?\bdisabled_at\s*=\s*([^\s,`]+)/gi)].map((match) => match[1] ?? "");

    expect(assignments.length, "exactly the one disable assignment").toBe(1);
    expect(assignments[0]).toBe("${at(now)}");
    expect(SOURCE).not.toMatch(/\bdisabled_at\s*=\s*null\b/i);
    expect(SOURCE).not.toMatch(/\bdisabled_at\s*:\s*null\b/);
  });

  it("the listing never selects token_digest", () => {
    const listingSql = SOURCE.slice(SOURCE.indexOf('"list-sessions"'), SOURCE.indexOf("order by s.created_at, s.id"));
    expect(listingSql).not.toMatch(/token_digest/);
    expect(listingSql).not.toMatch(/for update/i);
  });

  it("each new outcome type is handled exhaustively", () => {
    expect(listing({ code: "ADMINISTRATOR_NOT_FOUND" })).toBe("ADMINISTRATOR_NOT_FOUND");
    expect(revokeOne({ code: "NO_SUCH_SESSION" })).toBe("NO_SUCH_SESSION");
    expect(revokeAll({ code: "SESSIONS_REVOKED", revoked: 0 })).toBe("SESSIONS_REVOKED");
    expect(disable({ code: "ALREADY_DISABLED" })).toBe("ALREADY_DISABLED");
  });
});
