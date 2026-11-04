/**
 * Recovery codes (`ADR-004` P-4; `ADR-028` PS-6; `ADR-029`; issue #266).
 *
 * A set is **10 codes of 128 random bits** each, from `crypto.randomBytes`. **Only the SHA-256
 * digest of a code's 16 raw bytes is stored** (`ADR-028` PS-1 rule 5), so the digest is the same
 * however the code was formatted when typed.
 *
 * **Display and entry form (issue #266 RD-1).** Lower-case hex, 32 characters, shown as four
 * groups of eight joined by hyphens. On entry, spaces and hyphens are removed and letters
 * lower-cased; anything that is not then exactly 32 hex digits does not parse. Only `Buffer`
 * encoding is used, so no encoder is written here.
 *
 * Nothing here logs, and no error carries a code.
 */

import { createHash, randomBytes } from "node:crypto";

export const RECOVERY_CODE_BYTES = 16;
export const RECOVERY_CODE_SET_SIZE = 10;

const HEX_CODE = /^[0-9a-f]{32}$/;

export interface GeneratedRecoveryCode {
  /** The display form, shown once. Never stored, never logged. */
  readonly code: string;
  /** The SHA-256 digest of the raw 16 bytes: the only form that is stored. */
  readonly digest: Buffer;
}

/** A source of random bytes; injectable so tests can drive generation deterministically. */
export type RandomSource = (size: number) => Buffer;

function digestOf(raw: Buffer): Buffer {
  return createHash("sha256").update(raw).digest();
}

/** The display form of 16 raw bytes: four groups of eight lower-case hex digits. */
export function formatRecoveryCode(raw: Buffer): string {
  const hex = raw.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32)].join("-");
}

/**
 * A fresh set of exactly ten **distinct** codes. A repeated draw is discarded and drawn again; at
 * 128 bits that never happens in practice, but distinctness is a property of the set, not luck.
 */
export function generateRecoveryCodes(random: RandomSource = randomBytes): readonly GeneratedRecoveryCode[] {
  const seen = new Set<string>();
  const codes: GeneratedRecoveryCode[] = [];

  while (codes.length < RECOVERY_CODE_SET_SIZE) {
    const raw = random(RECOVERY_CODE_BYTES);

    if (raw.length !== RECOVERY_CODE_BYTES) {
      throw new Error("the random source returned the wrong number of bytes");
    }

    const key = raw.toString("hex");

    if (!seen.has(key)) {
      seen.add(key);
      codes.push({ code: formatRecoveryCode(raw), digest: digestOf(raw) });
    }
  }

  return codes;
}

/**
 * The stored digest for a presented code, or `undefined` when it does not parse. Spaces and
 * hyphens are removed and letters lower-cased first, so formatting variants of one code share
 * one digest.
 */
export function recoveryCodeDigest(presented: string): Buffer | undefined {
  const normalized = presented.replace(/[\s-]/g, "").toLowerCase();

  if (!HEX_CODE.test(normalized)) {
    return undefined;
  }

  return digestOf(Buffer.from(normalized, "hex"));
}
