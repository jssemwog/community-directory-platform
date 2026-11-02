/** D-7 keyed digests (issue #258). */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { keyedDigest } from "./keyed-digest";

describe("keyed digests (D-7)", () => {
  const key = randomBytes(32);

  it("are 32 bytes, stable for one key, and different under another key", () => {
    const one = keyedDigest(key, "source-address", "127.0.0.1");

    expect(one).toHaveLength(32);
    expect(keyedDigest(key, "source-address", "127.0.0.1")).toEqual(one);
    expect(keyedDigest(randomBytes(32), "source-address", "127.0.0.1")).not.toEqual(one);
  });

  it("separate purposes, so equal values never collide across them", () => {
    expect(keyedDigest(key, "password-username", "x")).not.toEqual(keyedDigest(key, "totp-administrator", "x"));
  });

  it("refuse a key that is not 32 bytes", () => {
    expect(() => keyedDigest(randomBytes(16), "source-address", "x")).toThrow(RangeError);
  });
});
