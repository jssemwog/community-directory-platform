/**
 * Keyed digests for throttle subjects (`ADR-028` D-7, PS-7; issue #258).
 *
 * Throttle rows never hold a raw username, administrator identifier or client address: only an
 * HMAC-SHA-256 digest under a **separate server-held key** that never enters the database. The
 * key is a parameter here; where it comes from is the composing slice's concern, and locally it
 * is a development-only value (`ADR-004` L-5).
 *
 * Each purpose is a separate domain, so equal inputs used for different purposes never collide.
 */

import { createHmac } from "node:crypto";

export const THROTTLE_KEY_BYTES = 32;

/**
 * `recovery-code-administrator` is the `recovery_code` counter's subject (issue #266 amendment 2),
 * kept apart from `totp-administrator`: the separate purposes prevent linking one administrator's two
 * second-factor counter rows by equality of their subject digests alone.
 */
export type KeyedDigestPurpose =
  | "password-username"
  | "totp-administrator"
  | "recovery-code-administrator"
  | "source-address";

const SEPARATOR = Buffer.from([0]);

export function keyedDigest(key: Buffer, purpose: KeyedDigestPurpose, value: string): Buffer {
  if (key.length !== THROTTLE_KEY_BYTES) {
    throw new RangeError("the throttle key must be exactly 32 bytes");
  }

  return createHmac("sha256", key)
    .update(purpose, "utf8")
    .update(SEPARATOR)
    .update(value, "utf8")
    .digest();
}
