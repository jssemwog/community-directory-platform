/**
 * The recovery-session check without a database (issue #268 §6.1). A missing or malformed token is
 * refused before the runtime is reached, and an unavailable runtime is a refusal, never a throw. The
 * kind and expiry cases need a real database: `recovery-journey.integration.test.ts` H-R5 and H-R10.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { resetAdministratorRuntimeForTests, type RuntimeFactories } from "./authentication-runtime";
import type { LocalAdministratorConfiguration } from "./local-gate";
import { recoverySessionOf } from "./require-recovery-session";

const configuration: LocalAdministratorConfiguration = {
  origin: "https://127.0.0.1:3000",
  host: "127.0.0.1:3000",
  connectionString: "postgresql://demo:x@127.0.0.1:54329/demo",
  totpKey: randomBytes(32),
  throttleKey: randomBytes(32),
};

function failingFactories(): { readonly factories: RuntimeFactories; readonly touched: () => boolean } {
  let touched = false;
  const fail = () => {
    touched = true;
    throw new Error("the runtime is unavailable");
  };

  return { factories: { createDatabase: fail, createDummyPasswordHash: fail, createLimiter: fail }, touched: () => touched };
}

afterEach(async () => {
  await resetAdministratorRuntimeForTests();
});

describe("recoverySessionOf", () => {
  it.each([["no token", undefined], ["a malformed token", "not-a-token"], ["a short token", "AAAA"]])(
    "refuses %s without reaching the runtime",
    async (_label, token) => {
      const { factories, touched } = failingFactories();
      expect(await recoverySessionOf(configuration, token, { factories, log: () => undefined })).toBe("refused");
      expect(touched()).toBe(false);
    },
  );

  it("refuses, never throws, when the runtime is unavailable", async () => {
    const { factories, touched } = failingFactories();
    expect(await recoverySessionOf(configuration, randomBytes(32).toString("base64url"), { factories, log: () => undefined })).toBe("refused");
    expect(touched()).toBe(true);
  });

  it("logs exactly its entry, the outcome and a timestamp", async () => {
    const lines: string[] = [];
    const token = randomBytes(32).toString("base64url");
    await recoverySessionOf(configuration, token, { factories: failingFactories().factories, log: (line) => lines.push(line) });

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0] ?? "{}") as Record<string, string>;
    expect(Object.keys(logged).sort()).toEqual(["at", "entry", "event", "outcome"]);
    expect(logged).toMatchObject({ event: "administrator-authentication", entry: "recovery-session-check", outcome: "SESSION_REFUSED" });
    expect(lines[0]).not.toContain(token);
  });
});
