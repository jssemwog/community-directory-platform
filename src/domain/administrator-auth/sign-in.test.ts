/** The sign-in step logic, without a database (issue #258). */

import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { HashLimiter } from "./hash-limiter";
import { sealTotpSecret } from "./secret-box";
import { totpStep, totpVerifierFor, type SignInDependencies } from "./sign-in";
import { generateTotpSecret, totpCodeAt, totpStepAt } from "./totp";

const AT = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("the TOTP verifier handed to the locked transaction", () => {
  const key = randomBytes(32);
  const administratorId = randomUUID();
  const secret = generateTotpSecret();
  const factor = { administratorId, factorId: randomUUID(), ...sealTotpSecret(key, 1, administratorId, secret) };

  it("returns the matched absolute step for a right code", () => {
    expect(totpVerifierFor(new Map([[1, key]]), totpCodeAt(secret, AT))(factor, AT)).toEqual({
      kind: "match",
      step: totpStepAt(AT),
    });
  });

  it("returns a mismatch for a wrong code", () => {
    const valid = new Set([-30_000, 0, 30_000].map((offset) => totpCodeAt(secret, AT + offset)));
    const wrong = ["111111", "222222", "333333", "444444"].find((code) => !valid.has(code)) as string;

    expect(totpVerifierFor(new Map([[1, key]]), wrong)(factor, AT)).toEqual({ kind: "mismatch" });
  });

  it("reports material no available key opens as unreadable, never as a mismatch", () => {
    expect(totpVerifierFor(new Map([[2, key]]), totpCodeAt(secret, AT))(factor, AT)).toEqual({ kind: "unreadable" });
  });
});

describe("the TOTP step", () => {
  it("refuses a malformed challenge token without touching the store", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the store must not be touched");
        },
      },
    );
    const deps = {
      db: untouchable,
      clock: () => AT,
      limiter: new HashLimiter(),
      passwords: { verify: async () => false },
      dummyPasswordHash: "scrypt$ln=17,r=8,p=1$x$y",
      throttleKey: randomBytes(32),
      totpKeys: new Map(),
    } as unknown as SignInDependencies;

    expect(await totpStep(deps, { challengeToken: "not-a-token", code: "123456", sourceAddress: "127.0.0.1" })).toEqual({
      code: "REFUSED",
      reason: "UNKNOWN_CHALLENGE",
    });
  });
});
