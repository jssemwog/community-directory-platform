/**
 * Static checks on housekeeping (Unit HK Scope Gate, revision 4, issue #274, §6.2): the three
 * statements' shape, the tables they may name, the closed E3 list, the single importer, and the
 * entry-point mapping that §3.2's "same generic refusal" relies on.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const source = read("src/data/administrator-authentication.ts");
const body = source.slice(source.indexOf("export async function removeExpiredAuthenticationRows("));
const STATEMENT_TABLES = ["administrator_pending_challenge", "administrator_consumed_challenge", "administrator_session"];
const OTHER_TABLES = ["administrator_totp_factor", "administrator_recovery_code", "authentication_throttle", "authentication_source_window"];

/** Each `sql` template inside the operation, as written. */
const statements = [...body.matchAll(/sql`([\s\S]*?)`/g)].map((match) => match[1] ?? "");

describe("§6.2: the housekeeping statements", () => {
  it("are exactly three DELETEs, each with FOR UPDATE SKIP LOCKED and a <= expiry predicate", () => {
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).toMatch(/^delete from /);
      expect(statement).toMatch(/for update skip locked/);
      expect(statement).toMatch(/<= \$\{at\(now\)\}/);
      expect(statement).not.toMatch(/>=|<(?!=)/);
    }
    expect(body.match(/"housekeeping-[a-z-]+"/g)).toEqual(['"housekeeping-pending-challenges"', '"housekeeping-consumed-challenges"', '"housekeeping-sessions"']);
  });

  it("name only their three tables, take no table lock, open no transaction and read the clock once", () => {
    for (const [index, statement] of statements.entries()) {
      const named = STATEMENT_TABLES.filter((table) => new RegExp(`\\b${table}\\b`).test(statement));
      expect(named).toEqual([STATEMENT_TABLES[index]]);
      for (const table of [...OTHER_TABLES, "administrator "]) {
        expect(statement).not.toContain(table);
      }
    }
    expect(body).not.toMatch(/lock table|\bbegin\b|transact\(|lockAdministrator\(/i);
    expect(body.match(/clock\(\)/g)).toHaveLength(1);
  });

  it("confirm an abort only for the closed E3 list, on the driver's DatabaseError with severity ERROR", () => {
    expect(source).toMatch(/const CONFIRMED_ABORT_STATES: readonly string\[\] = \["P0001", "40P01"\];/);
    expect(source).toMatch(/cause instanceof DatabaseError/);
    expect(source).toMatch(/cause\.severity === "ERROR"/);
  });
});

describe("§6.2: the single importer", () => {
  function files(directory: string): string[] {
    return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
    );
  }

  it("is administrator-housekeeping.ts, outside tests", () => {
    const importers = [...files("src"), ...files("scripts")]
      .filter((path) => /\.tsx?$/.test(path) && !/\.(test|integration\.test)\.ts$/.test(path))
      .filter((path) => read(path).includes("removeExpiredAuthenticationRows") && !path.endsWith("administrator-authentication.ts"))
      .map((path) => relative(".", path).replaceAll("\\", "/"));
    expect(importers).toEqual(["scripts/local-demo/administrator-housekeeping.ts"]);
  });
});

describe("§6.2: the caller-facing mapping §3.2 relies on", () => {
  for (const [file, entry, step, logName] of [
    ["src/interface/admin/entry-points.ts", "export async function codeEntry(", "await totpStep(", '"code"'],
    ["src/interface/admin/recovery-entry-points.ts", "export async function recoveryCodeEntry(", "await recoveryStep(", '"recovery-code"'],
  ] as const) {
    it(`${entry.replace("export async function ", "").replace("(", "")} answers every non-success after the step with one generic refusal and logs only outcome.code`, () => {
      const text = read(file);
      const start = text.indexOf(entry);
      expect(start).toBeGreaterThan(-1);
      const end = text.indexOf("\n}\n", start) === -1 ? text.indexOf("\r\n}\r\n", start) : text.indexOf("\n}\n", start);
      const afterStep = text.slice(text.indexOf(step, start), end);

      expect(afterStep.match(/return seeOther\(/g)).toHaveLength(2);
      expect(afterStep.match(/return seeOther\(FAILURE_LOCATION, \[clearChallenge\]\);/g)).toHaveLength(1);
      expect(afterStep).toContain(`log(${logName}, outcome.code);`);
      expect(afterStep).not.toMatch(/outcome\.reason/);
    });
  }
});
