/** scrypt password hashing and the L-4 measurement (issue #258). */

import { describe, expect, it } from "vitest";

import {
  SCRYPT_MAXMEM_BYTES,
  createDummyPasswordHash,
  deriveForMeasurement,
  hashPassword,
  verifyPassword,
} from "./password-hash";

const HASH_TIMEOUT_MS = 60_000;
const PREFIX = "scrypt$ln=17,r=8,p=1$";

describe("scrypt hashing (ADR-004 P-2, D-2)", () => {
  it(
    "stores the D-2 encoding and verifies only the right password",
    async () => {
      const stored = await hashPassword("correct horse battery staple");
      const [, , salt, key] = stored.split("$");

      expect(stored.startsWith(PREFIX)).toBe(true);
      expect(Buffer.from(salt ?? "", "base64")).toHaveLength(16);
      expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
      expect(`${salt}${key}`).not.toContain("=");
      expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
      expect(await verifyPassword("correct horse battery stapler", stored)).toBe(false);
    },
    HASH_TIMEOUT_MS,
  );

  it(
    "normalizes to NFC, so composed and decomposed forms verify alike",
    async () => {
      const composed = "caf" + String.fromCharCode(0xe9) + " password";
      const decomposed = "cafe" + String.fromCharCode(0x301) + " password";
      const stored = await hashPassword(composed);

      expect(await verifyPassword(decomposed, stored)).toBe(true);
    },
    HASH_TIMEOUT_MS,
  );

  it("refuses, without computing, a hash naming other parameters or malformed parts", async () => {
    const stored = await hashPassword("x".repeat(16));
    const [, , salt, key] = stored.split("$");

    expect(await verifyPassword("x".repeat(16), `scrypt$ln=10,r=8,p=1$${salt}$${key}`)).toBe(false);
    expect(await verifyPassword("x".repeat(16), `scrypt$ln=17,r=8,p=1$${salt}`)).toBe(false);
    expect(await verifyPassword("x".repeat(16), `scrypt$ln=17,r=8,p=1$${salt}$${key}$extra`)).toBe(false);
    expect(await verifyPassword("x".repeat(16), "plain")).toBe(false);
  }, HASH_TIMEOUT_MS);

  it("produces a dummy hash nobody can match", async () => {
    const dummy = await createDummyPasswordHash();

    expect(dummy.startsWith(PREFIX)).toBe(true);
    expect(await verifyPassword("", dummy)).toBe(false);
  }, HASH_TIMEOUT_MS);
});

describe("L-4: scrypt maxmem, measured locally", () => {
  it(
    "is rejected at exactly 128 MiB and accepted at the configured 160 MiB",
    async () => {
      await expect(deriveForMeasurement(128 * 1024 * 1024)).rejects.toThrow();

      const started = performance.now();
      await expect(deriveForMeasurement(SCRYPT_MAXMEM_BYTES)).resolves.toHaveLength(32);
      const elapsedMs = Math.round(performance.now() - started);

      // Reported, not asserted against a threshold: duration is a property of this machine.
      console.info(`L-4: one scrypt derivation at N=2^17, r=8, p=1 took ${elapsedMs} ms`);
      expect(SCRYPT_MAXMEM_BYTES).toBe(160 * 1024 * 1024);
    },
    HASH_TIMEOUT_MS,
  );
});
