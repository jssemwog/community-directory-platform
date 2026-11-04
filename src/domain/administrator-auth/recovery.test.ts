/**
 * Unit tests for the recovery steps' refusals that need no database (issue #266 §6.2).
 *
 * A token that is not a well-formed 32-byte token cannot match any stored digest, so each step
 * refuses it before reaching storage. The database is a stub that fails the test if touched.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { reenrolmentCompletion, reenrolmentStart, recoveryStep, regeneration, type RecoveryDependencies } from "./recovery";

const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error("storage must not be reached");
    },
  },
);

const deps: RecoveryDependencies = {
  db: untouchable as RecoveryDependencies["db"],
  clock: () => {
    throw new Error("the clock must not be read");
  },
  throttleKey: randomBytes(32),
  totpKeys: new Map([[1, randomBytes(32)]]),
  currentTotpKeyVersion: 1,
};

/** A well-formed token: it passes the digest check, so only the key check can stop the start. */
const WELL_FORMED = randomBytes(32).toString("base64url");

const MALFORMED = ["", "not-a-token", "a".repeat(43), "!".repeat(43)];

describe("the recovery steps refuse a malformed token without touching storage", () => {
  it("recoveryStep refuses UNKNOWN_CHALLENGE", async () => {
    for (const challengeToken of MALFORMED) {
      expect(await recoveryStep(deps, { challengeToken, code: "00112233-44556677-8899aabb-ccddeeff", sourceAddress: "127.0.0.1" })).toEqual({
        code: "REFUSED",
        reason: "UNKNOWN_CHALLENGE",
      });
    }
  });

  it("the recovery-session steps refuse RECOVERY_SESSION_INVALID", async () => {
    const invalid = { code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" };

    for (const recoverySessionToken of MALFORMED) {
      expect(await reenrolmentStart(deps, { recoverySessionToken })).toEqual(invalid);
      expect(await reenrolmentCompletion(deps, { recoverySessionToken, factorId: "f", code: "123456" })).toEqual(invalid);
      expect(await regeneration(deps, { recoverySessionToken })).toEqual(invalid);
    }
  });
});

describe("re-enrolment start without a usable current TOTP key (issue #266 amendment 5)", () => {
  it("returns TOTP_KEY_UNAVAILABLE before reaching storage or the clock, never a plain error", async () => {
    const key = randomBytes(32);

    for (const [name, totpKeys, currentTotpKeyVersion] of [
      ["missing selected key", new Map([[1, key]]), 2],
      ["the highest key is not inferred", new Map([[1, key], [2, randomBytes(32)]]), 3],
      ["empty keyring", new Map<number, Buffer>(), 1],
      ["a selected key of the wrong length", new Map([[1, key.subarray(0, 31)]]), 1],
      ["a version sealing would reject", new Map([[0, key]]), 0],
    ] as const) {
      const outcome = await reenrolmentStart({ ...deps, totpKeys, currentTotpKeyVersion }, { recoverySessionToken: WELL_FORMED });
      expect(outcome, name).toEqual({ code: "TOTP_KEY_UNAVAILABLE" });
      expect(JSON.stringify(outcome), name).not.toContain(key.toString("hex"));
    }
  });
});
