/**
 * The process-wide runtime (issue #260 §6.8 D-4, §6.6 E-4 and §12 qualification 2): one shared
 * initialization promise, one runtime across separate module instances, a retry after a failed
 * initialization, a diagnostics sink confined to the temporary directory, and no clock hook.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HashLimiter } from "../../domain/administrator-auth/hash-limiter";
import type { LocalAdministratorConfiguration } from "./local-gate";
import {
  administratorRuntime,
  LOCAL_ADMIN_DIAGNOSTICS_FILE,
  LOCAL_SOURCE_ADDRESS,
  recordDiagnostic,
  resetAdministratorRuntimeForTests,
  type RuntimeFactories,
} from "./authentication-runtime";

const configuration = (): LocalAdministratorConfiguration => ({
  origin: "https://127.0.0.1:3000",
  host: "127.0.0.1:3000",
  connectionString: "postgresql://demo:x@127.0.0.1:54329/demo",
  totpKey: randomBytes(32),
  throttleKey: randomBytes(32),
});

function countingFactories(options: { readonly failDummy?: number } = {}) {
  const counts = { databases: 0, dummies: 0, limiters: 0, shutdowns: 0 };
  let failures = options.failDummy ?? 0;
  const factories: RuntimeFactories = {
    createDatabase: () => {
      counts.databases += 1;
      return { db: {} as never, shutdown: async () => void (counts.shutdowns += 1) };
    },
    createDummyPasswordHash: async () => {
      counts.dummies += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));

      if (failures > 0) {
        failures -= 1;
        throw new Error("simulated failure");
      }

      return "scrypt$dummy";
    },
    createLimiter: () => {
      counts.limiters += 1;
      return new HashLimiter();
    },
  };

  return { counts, factories };
}

afterEach(async () => {
  await resetAdministratorRuntimeForTests();
  vi.resetModules();
});

describe("administratorRuntime", () => {
  it("D-4: concurrent first callers share one initialization: one pool, one dummy hash, one limiter", async () => {
    const { counts, factories } = countingFactories();
    const config = configuration();
    const runtimes = await Promise.all(Array.from({ length: 12 }, () => administratorRuntime(config, factories)));

    expect(new Set(runtimes).size).toBe(1);
    expect(counts).toEqual({ databases: 1, dummies: 1, limiters: 1, shutdowns: 0 });
    expect(runtimes[0]?.deps.limiter).toBeInstanceOf(HashLimiter);
  });

  it("D-4: a separately evaluated module instance reaches the same runtime through globalThis", async () => {
    const { counts, factories } = countingFactories();
    const config = configuration();
    const first = await administratorRuntime(config, factories);

    vi.resetModules();
    const reloaded = await import("./authentication-runtime");
    const second = await reloaded.administratorRuntime(config, factories);

    expect(second).toBe(first);
    expect(second.limiterId).toBe(first.limiterId);
    expect(counts.limiters).toBe(1);
  });

  it("forgets a failed initialization, closes its pool, and lets a later request retry", async () => {
    const { counts, factories } = countingFactories({ failDummy: 1 });
    const config = configuration();

    await expect(administratorRuntime(config, factories)).rejects.toThrow("simulated failure");
    expect(counts.shutdowns).toBe(1);

    const runtime = await administratorRuntime(config, factories);
    expect(runtime.deps.dummyPasswordHash).toBe("scrypt$dummy");
    expect(counts.databases).toBe(2);
  });

  it("replaces the runtime when the configuration changes, closing the old pool", async () => {
    const { counts, factories } = countingFactories();
    const first = await administratorRuntime(configuration(), factories);
    const second = await administratorRuntime(configuration(), factories);

    expect(second).not.toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counts.shutdowns).toBe(1);
  });

  it("E-4: the clock is Date.now, and nothing exposes a way to replace it", async () => {
    const { factories } = countingFactories();
    const runtime = await administratorRuntime(configuration(), factories);

    expect(runtime.deps.clock).toBe(Date.now);
    expect(Object.keys(runtime).sort()).toEqual(["deps", "limiterId", "runtimeId", "shutdown"]);
    expect(Object.keys(await import("./authentication-runtime")).filter((name) => /clock/i.test(name))).toEqual([]);
  });

  it("uses one fixed literal source address and reads no header for it (OD-7)", () => {
    expect(LOCAL_SOURCE_ADDRESS).toBe("local-loopback");
  });
});

describe("recordDiagnostic", () => {
  it("writes nothing without the harness variable, or for a path outside the temporary directory", () => {
    const outside = join(process.cwd(), "diagnostics-should-not-exist.jsonl");

    recordDiagnostic("x", {}, {});
    recordDiagnostic("x", {}, { [LOCAL_ADMIN_DIAGNOSTICS_FILE]: "relative.jsonl" });
    recordDiagnostic("x", {}, { [LOCAL_ADMIN_DIAGNOSTICS_FILE]: outside });

    expect(existsSync(outside)).toBe(false);
    expect(existsSync("relative.jsonl")).toBe(false);
  });

  it("appends one JSON line with the process identity inside the temporary directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cdp-diagnostics-"));
    const file = join(root, "events.jsonl");

    try {
      recordDiagnostic("entry", { entry: "password" }, { [LOCAL_ADMIN_DIAGNOSTICS_FILE]: file });
      const event = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>;
      expect(event).toMatchObject({ event: "entry", entry: "password", pid: process.pid, ppid: process.ppid });
      expect(typeof event.runtimeModule).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
