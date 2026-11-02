/** The AES-256-GCM secret box (issue #258). */

import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openTotpSecret, sealTotpSecret } from "./secret-box";

describe("TOTP secret at rest (ADR-004 P-3)", () => {
  const key = randomBytes(32);
  const keyring = new Map([[1, key]]);
  const administratorId = randomUUID();
  const secret = randomBytes(20);

  it("round-trips with a 20-byte ciphertext, a 12-byte IV and a 16-byte tag", () => {
    const sealed = sealTotpSecret(key, 1, administratorId, secret);

    expect(sealed.ciphertext).toHaveLength(20);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(openTotpSecret(keyring, administratorId, sealed)).toEqual(secret);
  });

  it("uses a fresh IV for every encryption", () => {
    const ivs = new Set(
      Array.from({ length: 100 }, () => sealTotpSecret(key, 1, administratorId, secret).iv.toString("hex")),
    );
    expect(ivs.size).toBe(100);
  });

  it("refuses a tampered ciphertext, tag or IV", () => {
    const sealed = sealTotpSecret(key, 1, administratorId, secret);
    const flip = (value: Buffer) => {
      const copy = Buffer.from(value);
      copy[0] = (copy[0] ?? 0) ^ 1;
      return copy;
    };

    expect(openTotpSecret(keyring, administratorId, { ...sealed, ciphertext: flip(sealed.ciphertext) })).toBeNull();
    expect(openTotpSecret(keyring, administratorId, { ...sealed, tag: flip(sealed.tag) })).toBeNull();
    expect(openTotpSecret(keyring, administratorId, { ...sealed, iv: flip(sealed.iv) })).toBeNull();
  });

  it("binds the administrator identifier and the key version as associated data", () => {
    const sealed = sealTotpSecret(key, 1, administratorId, secret);

    expect(openTotpSecret(keyring, randomUUID(), sealed)).toBeNull();
    // The same key filed under another version: the version label alone must not open it.
    expect(openTotpSecret(new Map([[2, key]]), administratorId, { ...sealed, keyVersion: 2 })).toBeNull();
    // No key for the version at all: unreadable, which key replacement handles (P-6).
    expect(openTotpSecret(new Map(), administratorId, sealed)).toBeNull();
  });

  it("refuses bad keys and key versions when sealing", () => {
    expect(() => sealTotpSecret(randomBytes(16), 1, administratorId, secret)).toThrow(RangeError);
    expect(() => sealTotpSecret(key, 0, administratorId, secret)).toThrow(RangeError);
  });
});
