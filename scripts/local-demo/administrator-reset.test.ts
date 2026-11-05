/**
 * The operator reset without a database (Unit OR Scope Gate, revision 4, §6.3 C-1a, C-5, C-6 and
 * C-7). Every refusal here happens before any storage call: the database throws if it is used at
 * all. The key-file defects are written to a fresh temporary directory, never `.local-demo/`.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { OperatorResetProbe, Stored } from "../../src/data/administrator-authentication";
import type { AdministratorKeys } from "./administrator-keys";
import type { ProvisioningTerminal } from "./administrator-provisioning";
import {
  classifyUncertainConfirmation,
  classifyUncertainReset,
  DISABLED_RESET_WARNING,
  KEYS_UNREADABLE_MESSAGE,
  readResetKeys,
  RESET_SUBCOMMAND,
  resetSyntheticAdministrator,
  resetWarningFor,
} from "./administrator-reset";

function untouchable(): { readonly db: never; readonly touched: () => boolean } {
  let touched = false;
  const db = new Proxy(
    {},
    {
      get: () => {
        touched = true;
        throw new Error("the database must not be reached");
      },
    },
  );
  return { db: db as never, touched: () => touched };
}

function terminal(interactive: boolean, answers: readonly string[] = []): ProvisioningTerminal & { readonly lines: string[] } {
  const lines: string[] = [];
  const queue = [...answers];
  return {
    interactive,
    lines,
    ask: async () => queue.shift() ?? "",
    askSecret: async () => {
      throw new Error("no secret prompt expected");
    },
    say: (line) => lines.push(line),
  };
}

const KEYS: AdministratorKeys = { totpKey: randomBytes(32), throttleKey: randomBytes(32) };

const deps = (db: never, overrides: { environment?: Record<string, string>; databaseUrl?: string } = {}) => ({
  db,
  clock: () => Date.UTC(2026, 10, 5, 12, 0, 0),
  keys: KEYS,
  environment: overrides.environment ?? {},
  databaseUrl: overrides.databaseUrl ?? "postgresql://demo:x@127.0.0.1:54329/demo",
  hash: async () => {
    throw new Error("no hash expected");
  },
});

const outcomeLines = (lines: readonly string[]) => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, string>);

describe("C-1a: refusals before storage, in the command", () => {
  it.each([
    ["a non-interactive terminal", false, {}, [], "NOT_INTERACTIVE"],
    ["NODE_ENV=production", true, { environment: { NODE_ENV: "production" } }, [], "PRODUCTION"],
    ["a non-loopback database", true, { databaseUrl: "postgresql://demo:x@db.internal:5432/app" }, [], "NOT_LOCAL_DATABASE"],
    ["a username without the synthetic- prefix", true, {}, ["operator-ada"], "USERNAME_REFUSED"],
    ["an unprovisionable username", true, {}, ["synthetic-!!"], "USERNAME_REFUSED"],
  ] as const)("refuses %s with one outcome line and no storage call", async (_label, interactive, overrides, answers, outcome) => {
    const { db, touched } = untouchable();
    const io = terminal(interactive, answers);

    expect(await resetSyntheticAdministrator(io, deps(db, overrides))).toEqual({ ok: false, outcome });
    expect(touched()).toBe(false);
    expect(outcomeLines(io.lines)).toEqual([{ event: "administrator-authentication", entry: "operator-reset", outcome, at: "2026-11-05T12:00:00.000Z" }]);
  });
});

describe("C-1a: the key validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "or-keys-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const valid = { version: 1, totpKeyV1: randomBytes(32).toString("base64url"), throttleKey: randomBytes(32).toString("base64url") };
  const write = (name: string, content: string) => {
    const file = join(directory, name);
    writeFileSync(file, content);
    return file;
  };

  it("accepts a valid file and returns exactly its two keys", () => {
    const read = readResetKeys(write("valid.json", JSON.stringify(valid)));
    expect(read.ok).toBe(true);
    expect(read.ok && read.keys.totpKey.toString("base64url")).toBe(valid.totpKeyV1);
  });

  it.each([
    ["missing", () => join(directory, "absent.json")],
    ["unparseable", () => write("bad.json", "{not json")],
    ["version 2", () => write("v2.json", JSON.stringify({ ...valid, version: 2 }))],
    ["a non-canonical base64url key", () => write("noncanonical.json", JSON.stringify({ ...valid, totpKeyV1: `${valid.totpKeyV1}=` }))],
    ["a key of 31 bytes", () => write("short.json", JSON.stringify({ ...valid, throttleKey: randomBytes(31).toString("base64url") }))],
    ["two equal keys", () => write("equal.json", JSON.stringify({ ...valid, throttleKey: valid.totpKeyV1 }))],
  ] as const)("refuses a keys file that is %s, without suggesting demo:local:reset", (_label, file) => {
    expect(readResetKeys(file())).toEqual({ ok: false, message: KEYS_UNREADABLE_MESSAGE });
    expect(KEYS_UNREADABLE_MESSAGE).not.toMatch(/demo:local:reset/);
    expect(KEYS_UNREADABLE_MESSAGE).toMatch(/nothing was changed/);
  });
});

describe("C-6: the launcher subcommand", () => {
  const source = readFileSync(join(import.meta.dirname, "local-demo.ts"), "utf8");
  const body = source.slice(source.indexOf("async function adminReset("), source.indexOf("async function admin()"));
  const at = (needle: string) => {
    const index = body.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it("refuses before the binaries and lock; validates the keys under the lock before the cluster; never creates keys", () => {
    const refusalReturn = body.indexOf("return;", at("launchRefusalOf(terminal, process.env)"));
    expect(refusalReturn).toBeGreaterThan(at("launchRefusalOf(terminal, process.env)"));

    for (const step of ["postgresBinaries()", "takeLauncherLock("]) {
      expect(at(step), `${step} after the refusal`).toBeGreaterThan(refusalReturn);
    }

    const keys = at("readResetKeys(ADMINISTRATOR_KEYS_FILE)");
    expect(keys).toBeGreaterThan(at("takeLauncherLock("));

    for (const step of ["initialiseIfNeeded(", "startCluster(", "prepareDatabase(", "resetSyntheticAdministrator("]) {
      expect(at(step), `${step} after the key validation`).toBeGreaterThan(keys);
    }

    // A key defect returns before the cluster, so no seal or digest is ever computed from it.
    const keyReturn = body.indexOf("return;", keys);
    expect(keyReturn).toBeLessThan(at("initialiseIfNeeded("));
    expect(body).not.toContain("ensureAdministratorKeys(");
    expect(body).toContain("keys: keys.keys");
  });

  it("is dispatched as reset-credentials and listed in both usage lines", () => {
    const dispatch = source.slice(source.indexOf("async function admin()"));
    expect(RESET_SUBCOMMAND).toBe("reset-credentials");
    expect(dispatch).toContain("subcommand === RESET_SUBCOMMAND");
    expect(dispatch).toContain("await adminReset()");
    expect(dispatch.match(/reset-credentials/g)?.length).toBe(2);
  });
});

describe("C-7: the warning text", () => {
  it("names the reset's effects, the reuse advice and the per-address limit; the D-16 sentence is separate", () => {
    const warning = resetWarningFor("synthetic-ada");
    expect(warning).toMatch(/replaces the password, the authenticator and all recovery codes of synthetic-ada/);
    expect(warning).toMatch(/choose a different one: reusing it is allowed/);
    expect(warning).toMatch(/20 failed sign-ins per hour from one address/);
    expect(warning).toMatch(/can still be delayed for up to an hour after the reset/);
    expect(warning).not.toMatch(/D-16/);
    expect(DISABLED_RESET_WARNING).toMatch(/does not re-enable it \(D-16\)/);
  });
});

const probe = (fields: Partial<OperatorResetProbe>): Stored<OperatorResetProbe> => ({
  ok: true,
  value: { found: true, passwordMatches: true, factorMatches: true, factorState: "pending_confirmation", originIsNull: true, accountEnabled: true, codeSetMatches: true, ...fields },
});
const failed: Stored<OperatorResetProbe> = { ok: false, failure: { code: "STORAGE_FAILURE" } as never };

describe("C-5: the §3.6 rows", () => {
  it("after an uncertain T1", () => {
    expect(classifyUncertainReset(probe({}))).toBe("U1-a");
    expect(classifyUncertainReset(probe({ accountEnabled: false }))).toBe("U1-b");
    expect(classifyUncertainReset(probe({ accountEnabled: false, factorState: "active", codeSetMatches: false }))).toBe("U1-b");
    expect(classifyUncertainReset(probe({ factorState: "active" }))).toBe("U1-c");
    expect(classifyUncertainReset(probe({ originIsNull: false }))).toBe("U1-c");
    expect(classifyUncertainReset(probe({ codeSetMatches: false }))).toBe("U1-c");
    expect(classifyUncertainReset(probe({ factorMatches: false, factorState: null }))).toBe("U1-d");
    expect(classifyUncertainReset(probe({ passwordMatches: false }))).toBe("U1-d");
    expect(classifyUncertainReset(probe({ passwordMatches: false, factorMatches: false, factorState: null }))).toBe("U1-e");
    expect(classifyUncertainReset(probe({ found: false }))).toBe("U1-e");
    expect(classifyUncertainReset(failed)).toBe("U1-f");
  });

  it("after an uncertain T2: codes only on U2-a", () => {
    expect(classifyUncertainConfirmation(probe({ factorState: "active" }))).toBe("U2-a");
    expect(classifyUncertainConfirmation(probe({}))).toBe("U2-b");
    expect(classifyUncertainConfirmation(probe({ factorState: "active", codeSetMatches: false }))).toBe("U2-c");
    expect(classifyUncertainConfirmation(probe({ factorState: "active", accountEnabled: false }))).toBe("U2-d");
    expect(classifyUncertainConfirmation(probe({ accountEnabled: false }))).toBe("U2-d");
    expect(classifyUncertainConfirmation(probe({ codeSetMatches: false }))).toBe("U2-e");
    expect(classifyUncertainConfirmation(probe({ originIsNull: false }))).toBe("U2-e");
    expect(classifyUncertainConfirmation(probe({ factorState: "reenrolment_required" }))).toBe("U2-e");
    expect(classifyUncertainConfirmation(probe({ passwordMatches: false, factorState: "active" }))).toBe("U2-f");
    expect(classifyUncertainConfirmation(probe({ factorMatches: false, factorState: null }))).toBe("U2-f");
    expect(classifyUncertainConfirmation(probe({ passwordMatches: false, factorMatches: false, factorState: null }))).toBe("U2-g");
    expect(classifyUncertainConfirmation(probe({ found: false }))).toBe("U2-g");
    expect(classifyUncertainConfirmation(failed)).toBe("U2-g");
  });

  it("the command never says nothing was changed after T1 was sent", () => {
    const source = readFileSync(join(import.meta.dirname, "administrator-reset.ts"), "utf8");
    const afterT1 = source.slice(source.indexOf("const reset = await resetAdministratorCredentials("));
    expect(afterT1).not.toMatch(/nothing was changed/i);
  });
});
