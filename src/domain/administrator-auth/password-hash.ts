/**
 * Password hashing (`ADR-004` P-2, `ADR-028` D-2; issue #258).
 *
 * **scrypt from `node:crypto`**, N = 2^17, r = 8, p = 1, a 16-byte random salt and a 32-byte
 * derived key, stored in the self-describing D-2 encoding
 * `scrypt$ln=17,r=8,p=1$<salt base64>$<key base64>` (unpadded standard base64).
 *
 * **`maxmem` is explicit: 160 MiB** (issue #258, L-4). scrypt needs about 128 × N × r bytes,
 * 128 MiB here, and Node rejects a `maxmem` of exactly that, so the limit sits above it with
 * headroom. It is a ceiling per computation, not an allocation; the bounded limiter
 * (`hash-limiter.ts`) caps concurrent computations at 2.
 *
 * A password is **NFC-normalized** before hashing and verification (`ADR-004` P-2). Verification
 * accepts **only** the approved parameters: a stored hash naming any others is refused rather
 * than computed, so stored data cannot choose the work factor.
 *
 * Every call to these functions must run inside a slot of the bounded limiter. That is the
 * caller's obligation (`sign-in.ts`); this module performs no queueing of its own.
 */

import { randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

export const SCRYPT_COST_LOG2 = 17;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELISM = 1;
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_KEY_BYTES = 32;
export const SCRYPT_MAXMEM_BYTES = 160 * 1024 * 1024;

const PARAMETERS = `ln=${SCRYPT_COST_LOG2},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELISM}`;
const PREFIX = `scrypt$${PARAMETERS}$`;
const BASE64 = /^[A-Za-z0-9+/]+$/;

const OPTIONS: ScryptOptions = {
  N: 2 ** SCRYPT_COST_LOG2,
  r: SCRYPT_BLOCK_SIZE,
  p: SCRYPT_PARALLELISM,
  maxmem: SCRYPT_MAXMEM_BYTES,
};

function derive(password: BinaryLike, salt: Buffer, options: ScryptOptions = OPTIONS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_BYTES, options, (error, key) => {
      if (error === null) {
        resolve(key);
      } else {
        reject(error);
      }
    });
  });
}

function unpadded(value: Buffer): string {
  return value.toString("base64").replace(/=+$/, "");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await derive(password.normalize("NFC"), salt);
  return `${PREFIX}${unpadded(salt)}$${unpadded(key)}`;
}

/** `true` only for the correct password against a well-formed hash with approved parameters. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(PREFIX)) {
    return false;
  }

  const parts = stored.slice(PREFIX.length).split("$");

  if (parts.length !== 2 || !parts.every((part) => BASE64.test(part))) {
    return false;
  }

  const salt = Buffer.from(parts[0] ?? "", "base64");
  const expected = Buffer.from(parts[1] ?? "", "base64");

  if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEY_BYTES) {
    return false;
  }

  const actual = await derive(password.normalize("NFC"), salt);
  return timingSafeEqual(actual, expected);
}

/**
 * A hash of a random password nobody knows, for the dummy verification of an unknown account
 * (`ADR-004` P-5): the same algorithm, parameters and limiter as a real one.
 */
export async function createDummyPasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString("base64url"));
}

/** Exposed for the L-4 measurement only: derive with an explicit `maxmem`. */
export function deriveForMeasurement(maxmem: number): Promise<Buffer> {
  return derive("measurement", randomBytes(SCRYPT_SALT_BYTES), { ...OPTIONS, maxmem });
}
