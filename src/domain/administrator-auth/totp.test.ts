/** TOTP over `otpauth` against the RFC 6238 SHA-1 test vectors (issue #258). */

import { describe, expect, it } from "vitest";

import { generateTotpSecret, matchTotpStep, totpCodeAt, totpStepAt } from "./totp";

/** RFC 6238 Appendix B: the SHA-1 seed, and the last six digits of each eight-digit vector. */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_VECTORS: readonly (readonly [number, string])[] = [
  [59, "287082"],
  [1_111_111_109, "081804"],
  [1_111_111_111, "050471"],
  [1_234_567_890, "005924"],
  [2_000_000_000, "279037"],
  [20_000_000_000, "353130"],
];

describe("TOTP (ADR-004 P-3)", () => {
  it("matches the RFC 6238 SHA-1 vectors at 6 digits and a 30-second step", () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCodeAt(RFC_SECRET, seconds * 1000)).toBe(code);
      expect(matchTotpStep(RFC_SECRET, code, seconds * 1000)).toBe(totpStepAt(seconds * 1000));
    }
  });

  it("accepts one step either side, returns the matched step, and nothing further", () => {
    const at = 1_234_567_890_000;
    const step = totpStepAt(at);
    const previous = totpCodeAt(RFC_SECRET, at - 30_000);
    const next = totpCodeAt(RFC_SECRET, at + 30_000);

    expect(matchTotpStep(RFC_SECRET, previous, at)).toBe(step - 1);
    expect(matchTotpStep(RFC_SECRET, next, at)).toBe(step + 1);
    expect(matchTotpStep(RFC_SECRET, totpCodeAt(RFC_SECRET, at - 60_000), at)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, totpCodeAt(RFC_SECRET, at + 60_000), at)).toBeNull();
  });

  it("refuses a malformed code without validating it", () => {
    expect(matchTotpStep(RFC_SECRET, "28708", 59_000)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, "2870821", 59_000)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, "28708a", 59_000)).toBeNull();
  });

  it("generates 160-bit secrets", () => {
    expect(generateTotpSecret()).toHaveLength(20);
    expect(generateTotpSecret()).not.toEqual(generateTotpSecret());
  });
});
