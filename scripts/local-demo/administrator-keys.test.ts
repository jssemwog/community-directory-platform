/**
 * The development-only keys (issue #260 §6.2 K-1, `ADR-004` L-5): exclusive creation, validation
 * on every read, and no key ever written to standard output or error. Every file lives in a
 * temporary directory; `.local-demo/` is never touched.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { administratorEnvironmentFor, ensureAdministratorKeys, readAdministratorKeys } from "./administrator-keys";

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdp-admin-keys-"));
  file = join(root, "administrator-keys.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("ensureAdministratorKeys", () => {
  it("creates two distinct 32-byte keys once, then reads the same keys back", () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (written.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (written.push(String(chunk)), true));

    const first = ensureAdministratorKeys(file);
    const second = ensureAdministratorKeys(file);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.keys.totpKey).toHaveLength(32);
    expect(first.keys.throttleKey).toHaveLength(32);
    expect(first.keys.totpKey.equals(first.keys.throttleKey)).toBe(false);
    expect(second.keys.totpKey.equals(first.keys.totpKey)).toBe(true);
    expect(second.keys.throttleKey.equals(first.keys.throttleKey)).toBe(true);

    const keys = [first.keys.totpKey, first.keys.throttleKey].map((key) => key.toString("base64url"));
    expect(written.join("")).toBe("");
    expect(keys.some((key) => written.join("").includes(key))).toBe(false);
  });

  it("never overwrites an existing file; a corrupted one is refused without revealing it", () => {
    writeFileSync(file, JSON.stringify({ version: 1, totpKeyV1: "secret-looking-value", throttleKey: "x" }));
    const before = readFileSync(file, "utf8");

    expect(() => ensureAdministratorKeys(file)).toThrow(/unreadable; nothing was changed/);
    expect(() => ensureAdministratorKeys(file)).not.toThrow(/secret-looking-value/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it.each([
    ["not JSON", "{"],
    ["a wrong version", JSON.stringify({ version: 2, totpKeyV1: Buffer.alloc(32, 1).toString("base64url"), throttleKey: Buffer.alloc(32, 2).toString("base64url") })],
    ["a short key", JSON.stringify({ version: 1, totpKeyV1: Buffer.alloc(31, 1).toString("base64url"), throttleKey: Buffer.alloc(32, 2).toString("base64url") })],
    ["equal keys", JSON.stringify({ version: 1, totpKeyV1: Buffer.alloc(32, 1).toString("base64url"), throttleKey: Buffer.alloc(32, 1).toString("base64url") })],
  ])("readAdministratorKeys refuses %s", (_label, content) => {
    writeFileSync(file, content);
    expect(() => readAdministratorKeys(file)).toThrow(/unreadable/);
  });

  it("creates the file readable by its owner only, where the platform supports modes", () => {
    ensureAdministratorKeys(file);

    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  });
});

describe("administratorEnvironmentFor", () => {
  it("gives exactly the three server-side gate variables, none NEXT_PUBLIC_", () => {
    const { keys } = ensureAdministratorKeys(file);
    const environment = administratorEnvironmentFor(keys, "https://127.0.0.1:3000");

    expect(Object.keys(environment).sort()).toEqual(["LOCAL_ADMIN_ORIGIN", "LOCAL_ADMIN_THROTTLE_KEY", "LOCAL_ADMIN_TOTP_KEY_V1"]);
    expect(environment.LOCAL_ADMIN_TOTP_KEY_V1).toBe(keys.totpKey.toString("base64url"));
  });
});
