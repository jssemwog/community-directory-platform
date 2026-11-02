/**
 * The TOTP secret at rest (`ADR-004` P-3, issue #258).
 *
 * **AES-256-GCM** from `node:crypto`, with a **fresh 96-bit IV** from `crypto.randomBytes` per
 * encryption, a **128-bit tag**, and the administrator's identifier and the key version as
 * associated data, so a sealed secret moved to another administrator, or relabelled with another
 * key version, fails to open. The 32-byte keys are parameters: the composing slice holds them in
 * server configuration, never in the database (`ADR-028` PS-1 rule 5).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const TOTP_KEY_BYTES = 32;
export const TOTP_IV_BYTES = 12;
export const TOTP_TAG_BYTES = 16;

export interface SealedTotpSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

function associatedData(administratorId: string, keyVersion: number): Buffer {
  return Buffer.from(`administrator:${administratorId};key-version:${keyVersion}`, "utf8");
}

export function sealTotpSecret(
  key: Buffer,
  keyVersion: number,
  administratorId: string,
  secret: Buffer,
): SealedTotpSecret {
  if (key.length !== TOTP_KEY_BYTES) {
    throw new RangeError("the TOTP encryption key must be exactly 32 bytes");
  }

  if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
    throw new RangeError("the key version must be a positive integer");
  }

  const iv = randomBytes(TOTP_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TOTP_TAG_BYTES });
  cipher.setAAD(associatedData(administratorId, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);

  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion };
}

/**
 * Open a sealed secret, or return `null` when no available key matches its version or when
 * authentication fails. A `null` is never distinguished further: the caller treats the factor
 * as unreadable, which key replacement handles without the old key (`ADR-004` P-6).
 */
export function openTotpSecret(
  keyring: ReadonlyMap<number, Buffer>,
  administratorId: string,
  sealed: SealedTotpSecret,
): Buffer | null {
  const key = keyring.get(sealed.keyVersion);

  if (
    key === undefined ||
    key.length !== TOTP_KEY_BYTES ||
    sealed.iv.length !== TOTP_IV_BYTES ||
    sealed.tag.length !== TOTP_TAG_BYTES
  ) {
    return null;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv, {
      authTagLength: TOTP_TAG_BYTES,
    });
    decipher.setAAD(associatedData(administratorId, sealed.keyVersion));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}
