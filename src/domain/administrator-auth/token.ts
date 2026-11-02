/**
 * Session and challenge tokens (`ADR-004` P-1, issue #258).
 *
 * A token is **32 random bytes** from `crypto.randomBytes`, carried as base64url. **Only its
 * SHA-256 digest is stored** (`ADR-028` PS-1 rule 5), so a database read never yields a usable
 * token. A presented token that is not the canonical encoding of exactly 32 bytes has no
 * digest: it is unknown, and nothing is looked up for it.
 */

import { createHash, randomBytes } from "node:crypto";

export const TOKEN_BYTES = 32;

export interface GeneratedToken {
  /** The bearer value. Never stored, never logged. */
  readonly token: string;
  /** The SHA-256 digest of the raw 32 bytes: the only form that is stored. */
  readonly digest: Buffer;
}

function digestOf(raw: Buffer): Buffer {
  return createHash("sha256").update(raw).digest();
}

export function generateToken(): GeneratedToken {
  const raw = randomBytes(TOKEN_BYTES);
  return { token: raw.toString("base64url"), digest: digestOf(raw) };
}

/** The stored digest for a presented token, or `null` if it is not a canonical 32-byte token. */
export function tokenDigest(presented: string): Buffer | null {
  const raw = Buffer.from(presented, "base64url");

  if (raw.length !== TOKEN_BYTES || raw.toString("base64url") !== presented) {
    return null;
  }

  return digestOf(raw);
}
