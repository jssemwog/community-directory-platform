/**
 * Unit tests for the recovery-code primitive (issue #266 §6.2).
 */

import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  formatRecoveryCode,
  generateRecoveryCodes,
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_SET_SIZE,
  recoveryCodeDigest,
} from "./recovery-code";

const sha256 = (raw: Buffer) => createHash("sha256").update(raw).digest();

describe("generateRecoveryCodes", () => {
  it("produces exactly ten distinct codes of 16 bytes each, from the injected source", () => {
    const draws: Buffer[] = [];
    const source = (size: number) => {
      const raw = randomBytes(size);
      draws.push(raw);
      return raw;
    };

    const codes = generateRecoveryCodes(source);

    expect(codes).toHaveLength(RECOVERY_CODE_SET_SIZE);
    expect(draws.every((raw) => raw.length === RECOVERY_CODE_BYTES)).toBe(true);
    expect(new Set(codes.map((code) => code.code)).size).toBe(RECOVERY_CODE_SET_SIZE);
    codes.forEach((code, index) => {
      expect(code.code).toBe(formatRecoveryCode(draws[index] as Buffer));
      expect(code.digest).toEqual(sha256(draws[index] as Buffer));
    });
  });

  it("discards a repeated draw, so the set stays distinct", () => {
    const repeated = Buffer.alloc(RECOVERY_CODE_BYTES, 7);
    let calls = 0;
    const source = (size: number) => (calls++ < 3 ? Buffer.from(repeated) : randomBytes(size));

    const codes = generateRecoveryCodes(source);

    expect(codes).toHaveLength(RECOVERY_CODE_SET_SIZE);
    expect(new Set(codes.map((code) => code.code)).size).toBe(RECOVERY_CODE_SET_SIZE);
    expect(codes.filter((code) => code.code === formatRecoveryCode(repeated))).toHaveLength(1);
  });

  it("refuses a source that returns the wrong number of bytes, without echoing it", () => {
    const short = Buffer.from("00112233", "hex");
    expect(() => generateRecoveryCodes(() => short)).toThrowError(/wrong number of bytes/);
    try {
      generateRecoveryCodes(() => short);
    } catch (cause) {
      expect(String(cause)).not.toContain(short.toString("hex"));
    }
  });
});

describe("the display and entry form (RD-1)", () => {
  it("formats 16 bytes as four groups of eight lower-case hex digits", () => {
    const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    expect(formatRecoveryCode(raw)).toBe("00112233-44556677-8899aabb-ccddeeff");
  });

  it("round-trips: the displayed code parses to the digest of its raw bytes", () => {
    for (const code of generateRecoveryCodes()) {
      expect(recoveryCodeDigest(code.code)).toEqual(code.digest);
    }
  });

  it("gives formatting variants of one code one digest", () => {
    const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const expected = sha256(raw);

    for (const variant of [
      "00112233-44556677-8899aabb-ccddeeff",
      "00112233445566778899AABBCCDDEEFF",
      "0011 2233 4455 6677 8899 aabb ccdd eeff",
      " 00112233-44556677 8899AABB-ccddeeff \t",
    ]) {
      expect(recoveryCodeDigest(variant)).toEqual(expected);
    }
  });

  it("does not parse a wrong length, a non-hex character or empty input", () => {
    for (const presented of [
      "",
      "   ",
      "00112233-44556677-8899aabb-ccddee",
      "00112233-44556677-8899aabb-ccddeeff00",
      "00112233-44556677-8899aabb-ccddeefg",
      "00112233_44556677_8899aabb_ccddeeff",
      "0x112233445566778899aabbccddeeff",
    ]) {
      expect(recoveryCodeDigest(presented)).toBeUndefined();
    }
  });
});
