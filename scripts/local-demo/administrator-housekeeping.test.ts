/**
 * The housekeeping command without a database (Unit HK Scope Gate, revision 4, issue #274, §6.3
 * C-1, C-2, C-4 and C-5). Every R3 refusal here happens before any storage call: the database
 * throws if it is touched at all. The R1 refusal and the launcher order are read from the source.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProvisioningTerminal } from "./administrator-provisioning";
import {
  describeResult,
  HOUSEKEEPING_INCOMPLETE_MESSAGE,
  HOUSEKEEPING_NOTICE,
  HOUSEKEEPING_SUBCOMMAND,
  housekeepingOutcomeLine,
  runHousekeeping,
} from "./administrator-housekeeping";

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

function terminal(interactive: boolean): ProvisioningTerminal & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    interactive,
    lines,
    ask: async () => {
      throw new Error("no prompt expected");
    },
    askSecret: async () => {
      throw new Error("no secret prompt expected");
    },
    say: (line) => lines.push(line),
  };
}

const AT = Date.UTC(2026, 10, 5, 12, 0, 0);
const outcomeLines = (lines: readonly string[]) => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, string>);

describe("C-1: R3 refusals send no housekeeping statement", () => {
  it.each([
    ["a non-interactive terminal", false, {}, "postgresql://demo:x@127.0.0.1:54329/demo", "NOT_INTERACTIVE"],
    ["NODE_ENV=production", true, { NODE_ENV: "production" }, "postgresql://demo:x@127.0.0.1:54329/demo", "PRODUCTION"],
    ["a non-loopback database", true, {}, "postgresql://demo:x@db.internal:5432/app", "NOT_LOCAL_DATABASE"],
  ] as const)("refuses %s with its message, exactly one outcome line and no database access", async (_label, interactive, environment, databaseUrl, outcome) => {
    const { db, touched } = untouchable();
    const io = terminal(interactive);

    expect(await runHousekeeping(io, { db, clock: () => AT, environment, databaseUrl })).toEqual({ ok: false, outcome });
    expect(touched()).toBe(false);
    expect(outcomeLines(io.lines)).toEqual([{ event: "administrator-authentication", entry: "housekeeping", outcome, at: "2026-11-05T12:00:00.000Z" }]);
    expect(io.lines.filter((line) => !line.startsWith("{"))).toHaveLength(1);
    expect(io.lines).not.toContain(HOUSEKEEPING_NOTICE);
  });

  it("the R1 outcome line has the same four fields", () => {
    expect(JSON.parse(housekeepingOutcomeLine("PRODUCTION", AT))).toEqual({ event: "administrator-authentication", entry: "housekeeping", outcome: "PRODUCTION", at: "2026-11-05T12:00:00.000Z" });
  });
});

describe("C-2: the launcher wrapper, read from the source", () => {
  const source = readFileSync(join(import.meta.dirname, "local-demo.ts"), "utf8");
  const body = source.slice(source.indexOf("async function adminHousekeeping("), source.indexOf("async function adminReset("));
  const at = (needle: string, from = 0) => {
    const index = body.indexOf(needle, from);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it("R1 refuses, with its outcome line, before the binaries, the lock and the cluster; housekeeping runs after startup", () => {
    const refusal = at("launchRefusalOf(terminal, process.env)");
    const outcomeLine = at("housekeepingOutcomeLine(refusal.reason", refusal);
    const refusalReturn = at("return;", outcomeLine);

    for (const step of ["postgresBinaries()", "takeLauncherLock("]) {
      expect(at(step), `${step} after R1`).toBeGreaterThan(refusalReturn);
    }
    expect(at("initialiseIfNeeded(")).toBeGreaterThan(at("takeLauncherLock("));
    expect(at("startCluster(")).toBeGreaterThan(at("initialiseIfNeeded("));
    expect(at("prepareDatabase(")).toBeGreaterThan(at("startCluster("));
    expect(at("runHousekeeping(")).toBeGreaterThan(at("prepareDatabase("));
  });

  it("reads and creates no key file", () => {
    expect(body).not.toMatch(/readAdministratorKeys\(|ensureAdministratorKeys\(|readResetKeys\(|ADMINISTRATOR_KEYS_FILE/);
  });

  it("is dispatched as housekeeping and listed in both usage strings", () => {
    const dispatch = source.slice(source.indexOf("async function admin()"));
    expect(HOUSEKEEPING_SUBCOMMAND).toBe("housekeeping");
    expect(dispatch).toContain("subcommand === HOUSEKEEPING_SUBCOMMAND");
    expect(dispatch).toContain("await adminHousekeeping()");
    expect(dispatch.match(/\| housekeeping"/g)?.length).toBe(1);
    expect(dispatch.match(/\| admin housekeeping"/g)?.length).toBe(1);
  });
});

describe("C-4: failure text", () => {
  it("prints a number only for an acknowledged deletion", () => {
    expect(describeResult("sessions", { status: "deleted", count: 3 })).toBe("sessions: deleted 3");
    expect(describeResult("sessions", { status: "rolled-back" })).toBe("sessions: rolled back, nothing deleted");
    expect(describeResult("sessions", { status: "unknown" })).toBe("sessions: unknown");
    expect(describeResult("sessions", { status: "not-run" })).toBe("sessions: not run");
    for (const status of ["rolled-back", "unknown", "not-run"] as const) {
      expect(describeResult("sessions", { status })).not.toMatch(/\d/);
    }
  });

  it("never says nothing was changed once housekeeping has started", () => {
    expect(HOUSEKEEPING_INCOMPLETE_MESSAGE).not.toMatch(/nothing was changed/i);
    const source = readFileSync(join(import.meta.dirname, "administrator-housekeeping.ts"), "utf8");
    const afterStart = source.slice(source.indexOf("terminal.say(HOUSEKEEPING_NOTICE);"));
    expect(afterStart).not.toMatch(/nothing was changed/i);
    expect(afterStart).toMatch(/if \(!report\.completed\)[\s\S]*?return finish\(false, "HOUSEKEEPING_INCOMPLETE"\);[\s\S]*Removed \$\{total\}/);
  });
});

describe("C-5: no secrets", () => {
  it("the command's fixed text carries no digest, token or identifier", () => {
    for (const line of [HOUSEKEEPING_NOTICE, HOUSEKEEPING_INCOMPLETE_MESSAGE, housekeepingOutcomeLine("HOUSEKEEPING_COMPLETED", AT)]) {
      expect(line).not.toMatch(/[0-9a-f]{32,}|[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });
});
