/**
 * The page-level session check (issue #260 §3.2): refused without reaching storage when no usable
 * token is presented, and refused when the runtime is unavailable. Valid and expired sessions are
 * exercised against real PostgreSQL in `admin-journey.integration.test.ts`.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { resetAdministratorRuntimeForTests, type RuntimeFactories } from "./authentication-runtime";
import type { LocalAdministratorConfiguration } from "./local-gate";
import { administratorSessionOf } from "./require-administrator";

const configuration: LocalAdministratorConfiguration = {
  origin: "https://127.0.0.1:3000",
  host: "127.0.0.1:3000",
  connectionString: "postgresql://demo:x@127.0.0.1:54329/demo",
  totpKey: randomBytes(32),
  throttleKey: randomBytes(32),
};

afterEach(async () => {
  await resetAdministratorRuntimeForTests();
});

describe("administratorSessionOf", () => {
  it.each([undefined, "", "not a token", "x".repeat(200)])("refuses %s without reaching the runtime", async (token) => {
    let reached = false;
    const fail = () => {
      reached = true;
      throw new Error("unreachable");
    };
    const factories: RuntimeFactories = { createDatabase: fail, createDummyPasswordHash: fail, createLimiter: fail };
    const lines: string[] = [];

    expect(await administratorSessionOf(configuration, token, { factories, log: (line) => lines.push(line) })).toBe("refused");
    expect(reached).toBe(false);
    expect(lines.map((line) => Object.keys(JSON.parse(line) as object).sort())).toEqual([["at", "entry", "event", "outcome"]]);
  });

  it("refuses when the runtime cannot be created", async () => {
    const factories: RuntimeFactories = {
      createDatabase: () => ({ db: {} as never, shutdown: async () => undefined }),
      createDummyPasswordHash: async () => {
        throw new Error("simulated");
      },
      createLimiter: () => {
        throw new Error("unreachable");
      },
    };

    expect(await administratorSessionOf(configuration, randomBytes(32).toString("base64url"), { factories, log: () => undefined })).toBe("refused");
  });
});
