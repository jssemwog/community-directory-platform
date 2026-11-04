/**
 * The operator commands without a database (issue #270 §6.2 C-1, C-2 and C-4). Every refusal here
 * happens before any storage call: the database throws if it is used at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTROL_SUBCOMMANDS, controlSyntheticAdministrator, DISABLE_WARNING, UNCONFIRMED_OUTCOME, type ControlSubcommand } from "./administrator-control";
import type { ProvisioningTerminal } from "./administrator-provisioning";

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

const deps = (db: never, overrides: { environment?: Record<string, string>; databaseUrl?: string } = {}) => ({
  db,
  clock: () => Date.UTC(2026, 10, 4, 12, 0, 0),
  environment: overrides.environment ?? {},
  databaseUrl: overrides.databaseUrl ?? "postgresql://demo:x@127.0.0.1:54329/demo",
});

const outcomeLines = (lines: readonly string[]) => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, string>);

describe("C-1: refusals before any storage call", () => {
  for (const subcommand of CONTROL_SUBCOMMANDS) {
    it.each([
      ["a non-interactive terminal", false, {}, [], "NOT_INTERACTIVE"],
      ["NODE_ENV=production", true, { environment: { NODE_ENV: "production" } }, [], "PRODUCTION"],
      ["a non-loopback database", true, { databaseUrl: "postgresql://demo:x@db.internal:5432/app" }, [], "NOT_LOCAL_DATABASE"],
      ["a username without the synthetic- prefix", true, {}, ["operator-ada"], "USERNAME_REFUSED"],
      ["an unprovisionable username", true, {}, ["synthetic-!!"], "USERNAME_REFUSED"],
    ] as const)(`${subcommand}: refuses %s`, async (_label, interactive, overrides, answers, outcome) => {
      const { db, touched } = untouchable();
      const io = terminal(interactive, answers);
      const result = await controlSyntheticAdministrator(subcommand as ControlSubcommand, io, deps(db, overrides));

      expect(result).toEqual({ ok: false, outcome });
      expect(touched()).toBe(false);
      expect(outcomeLines(io.lines).map((line) => line.outcome)).toEqual([outcome]);
    });
  }

  it("disable: a mismatched confirmation is refused before any storage call, after the irreversibility warning", async () => {
    const { db, touched } = untouchable();
    const io = terminal(true, ["synthetic-ada", "synthetic-adb"]);

    expect(await controlSyntheticAdministrator("disable", io, deps(db))).toEqual({ ok: false, outcome: "NOT_CONFIRMED" });
    expect(touched()).toBe(false);
    expect(io.lines).toContain(DISABLE_WARNING);
    expect(DISABLE_WARNING).toMatch(/cannot be undone in this project/);
    expect(DISABLE_WARNING).toMatch(/operator reset will not re-enable it/);
    expect(io.lines.indexOf(DISABLE_WARNING)).toBeLessThan(io.lines.findIndex((line) => line.includes("NOT_CONFIRMED")));
  });
});

describe("C-2: the launcher refuses each new subcommand before it starts anything", () => {
  it("adminControl returns on the refusal before the binaries, lock, cluster and migration", () => {
    const source = readFileSync(join(import.meta.dirname, "local-demo.ts"), "utf8");
    const body = source.slice(source.indexOf("async function adminControl("), source.indexOf("async function admin()"));
    const at = (needle: string) => {
      const index = body.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const refusalReturn = body.indexOf("return;", at("launchRefusalOf(terminal, process.env)"));

    expect(refusalReturn).toBeGreaterThan(at("launchRefusalOf(terminal, process.env)"));

    for (const step of ["postgresBinaries()", "takeLauncherLock(", "initialiseIfNeeded(", "startCluster(", "prepareDatabase("]) {
      expect(at(step), `${step} comes after the refusal's return`).toBeGreaterThan(refusalReturn);
    }

    // It needs no keys, so it never creates or reads the keys file.
    expect(body).not.toContain("ensureAdministratorKeys(");
  });

  it("every control subcommand is dispatched to adminControl, and nothing else is", () => {
    const source = readFileSync(join(import.meta.dirname, "local-demo.ts"), "utf8");
    const dispatch = source.slice(source.indexOf("async function admin()"), source.indexOf("const commands"));

    expect(dispatch).toContain("CONTROL_SUBCOMMANDS");
    expect(dispatch).toContain("adminControl(subcommand as ControlSubcommand)");
    expect([...CONTROL_SUBCOMMANDS]).toEqual(["sessions", "revoke", "revoke-all", "disable"]);
  });
});

describe("C-4: the outcome line", () => {
  it("has exactly the four fields, with the subcommand's entry name", async () => {
    for (const [subcommand, entry] of [
      ["sessions", "operator-sessions"],
      ["revoke", "operator-revoke"],
      ["revoke-all", "operator-revoke-all"],
      ["disable", "operator-disable"],
    ] as const) {
      const io = terminal(false);
      await controlSyntheticAdministrator(subcommand, io, deps(untouchable().db));
      const [line] = outcomeLines(io.lines);

      expect(Object.keys(line ?? {}).sort()).toEqual(["at", "entry", "event", "outcome"]);
      expect(line).toMatchObject({ event: "administrator-authentication", entry, outcome: "NOT_INTERACTIVE", at: "2026-11-04T12:00:00.000Z" });
    }
  });
});

describe("C-3: the storage-failure message of revoke-all and disable", () => {
  it("is the exact uncommitted-outcome sentence, and those failure branches never say nothing was changed", () => {
    expect(UNCONFIRMED_OUTCOME).toBe("The operation did not report success. Run sessions to inspect the current account and session state.");
    const source = readFileSync(join(import.meta.dirname, "administrator-control.ts"), "utf8");
    const revokeAll = source.slice(source.indexOf('if (subcommand === "revoke-all")'), source.indexOf("const disabled = await disableAccount"));
    const disable = source.slice(source.indexOf("const disabled = await disableAccount"), source.indexOf('if (disabled.value.code === "ALREADY_DISABLED")'));
    for (const [name, branch] of [["revoke-all", revokeAll.slice(0, revokeAll.indexOf('if (revoked.value.code !== "SESSIONS_REVOKED")'))], ["disable", disable]] as const) {
      expect(branch, name).toContain("terminal.say(UNCONFIRMED_OUTCOME)");
      expect(branch, name).not.toMatch(/nothing was changed/);
    }
  });
});
