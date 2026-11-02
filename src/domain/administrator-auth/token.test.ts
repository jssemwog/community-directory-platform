/** Token generation and digests (issue #258). */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { generateToken, tokenDigest } from "./token";

describe("tokens", () => {
  it("are 32 random bytes in base64url, stored only as a 32-byte SHA-256 digest", () => {
    const { token, digest } = generateToken();
    const raw = Buffer.from(token, "base64url");

    expect(raw).toHaveLength(32);
    expect(digest).toEqual(createHash("sha256").update(raw).digest());
    expect(digest).toHaveLength(32);
    expect(tokenDigest(token)).toEqual(digest);
  });

  it("differ on every generation", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(seen.size).toBe(200);
  });

  it("refuse anything that is not the canonical encoding of exactly 32 bytes", () => {
    const { token } = generateToken();

    expect(tokenDigest("")).toBeNull();
    expect(tokenDigest(token.slice(1))).toBeNull();
    expect(tokenDigest(token + "A")).toBeNull();
    expect(tokenDigest(token + "=")).toBeNull();
    expect(tokenDigest(Buffer.alloc(31).toString("base64url"))).toBeNull();
  });
});
