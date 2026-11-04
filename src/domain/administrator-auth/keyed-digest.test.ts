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

  it("recovery-code-administrator (issue #266 amendment 2) is deterministic and separate from totp-administrator", () => {
    const id = "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b";
    const recovery = keyedDigest(key, "recovery-code-administrator", id);

    expect(recovery).toHaveLength(32);
    expect(keyedDigest(key, "recovery-code-administrator", id)).toEqual(recovery);
    expect(recovery).not.toEqual(keyedDigest(key, "totp-administrator", id));
    expect(keyedDigest(randomBytes(32), "recovery-code-administrator", id)).not.toEqual(recovery);
  });

  it("keep every existing purpose's output unchanged (known answers under a fixed key)", () => {
    const fixed = Buffer.alloc(32, 7);

    expect(keyedDigest(fixed, "password-username", "x").toString("hex")).toBe("f4b97b01952bcacb77760535064d6d727abd4b89eafc72aa7dfceb5a95b4eadb");
    expect(keyedDigest(fixed, "totp-administrator", "x").toString("hex")).toBe("8f94430afa01b31bbfcfc5336723eed708d0b85abe6e76a5bc12405a277f67d1");
    expect(keyedDigest(fixed, "source-address", "x").toString("hex")).toBe("9afe511cf0f0af20da9f019d6d4d663434b62d4bdc0686ef18a753b914ad3f3e");
  });

  it("refuse a key that is not 32 bytes", () => {
    expect(() => keyedDigest(randomBytes(16), "source-address", "x")).toThrow(RangeError);
  });
});
