/**
 * The shared storage-failure classifier (`storage-failure.ts`; issue #258 correction pass).
 *
 * `sqlState` must carry a genuine PostgreSQL `SQLSTATE` and nothing else. A Node system error
 * reaching the driver, such as a reset or broken socket, has a `code` too, and labelling it
 * `sqlState` would claim the server said something it did not (issue #258 §12).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { constraintOf, sqlStateOf, storageFailure } from "./storage-failure";

const { DatabaseError } = createRequire(import.meta.url)("pg") as {
  DatabaseError: new (message: string, length: number, name: string) => Error & Record<string, unknown>;
};

/** A server error exactly as `pg` builds one from an ErrorResponse message. */
function serverError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new DatabaseError("server error", 0, "error"), { severity: "ERROR", code }, extra);
}

/** A real Node system error, raised by the platform rather than built by hand. */
function realSystemError(): NodeJS.ErrnoException {
  try {
    readFileSync(`definitely-missing-${process.pid}-${Date.now()}`);
  } catch (cause) {
    return cause as NodeJS.ErrnoException;
  }

  throw new Error("expected the read to fail");
}

/** A socket error as Node reports one: a code, a numeric errno and the failing syscall. */
const socketError = (code: string, errno: number, syscall: string) =>
  Object.assign(new Error(`${syscall} ${code}`), { code, errno, syscall });

describe("sqlStateOf keeps genuine SQLSTATE values", () => {
  for (const code of ["23505", "23514", "23503", "40001", "40P01", "57014", "57P01", "P0001", "XX000", "0A000", "22P02", "HV000", "F0000"]) {
    it(`preserves ${code} from a server error`, () => {
      expect(sqlStateOf(serverError(code))).toBe(code);
      expect(storageFailure(serverError(code)).sqlState).toBe(code);
    });
  }

  it("preserves a SQLSTATE on a plain object carrying only a code, as before", () => {
    expect(sqlStateOf({ code: "23505" })).toBe("23505");
  });
});

describe("sqlStateOf refuses codes that are not SQLSTATE values", () => {
  for (const [name, cause] of [
    ["ECONNRESET on a reset socket", socketError("ECONNRESET", -4077, "read")],
    ["EPIPE on a broken socket", socketError("EPIPE", -4047, "write")],
    ["ECONNREFUSED on a refused connection", socketError("ECONNREFUSED", -4078, "connect")],
    ["ETIMEDOUT on a timed-out connection", socketError("ETIMEDOUT", -4039, "connect")],
    ["a five-letter system code without errno or syscall", { code: "EPIPE" }],
    ["a five-letter system code naming another errno", { code: "EPERM" }],
    ["a Node internal error code", Object.assign(new Error("closed"), { code: "ERR_SOCKET_CLOSED" })],
    ["a lower-case code", { code: "40p01" }],
    ["a code of the wrong length", { code: "4000" }],
    ["a numeric code", { code: 23505 }],
  ] as const) {
    it(`refuses ${name}`, () => {
      expect(sqlStateOf(cause)).toBeUndefined();
      expect(Object.keys(storageFailure(cause))).toEqual(["code"]);
    });
  }

  it("refuses a real system error raised by Node", () => {
    const cause = realSystemError();
    expect(typeof cause.code).toBe("string");
    expect(typeof cause.errno).toBe("number");
    expect(sqlStateOf(cause)).toBeUndefined();
    expect(storageFailure(cause)).toEqual({ code: "STORAGE_FAILURE" });
  });

  it("refuses a connection error with no code at all", () => {
    expect(sqlStateOf(new Error("Connection terminated unexpectedly"))).toBeUndefined();
    for (const cause of [null, undefined, "57P01", 57]) {
      expect(sqlStateOf(cause)).toBeUndefined();
    }
  });
});

describe("storageFailure stays sanitized", () => {
  it("exposes only the SQLSTATE and constraint name, keeping the driver error non-enumerable", () => {
    const canary = "canary-row-value-7f3a";
    const cause = serverError("23505", {
      constraint: "administrator_session_pkey",
      detail: `Key (token_digest)=(${canary}) already exists.`,
    });
    const failure = storageFailure(cause);

    expect(failure).toEqual({ code: "STORAGE_FAILURE", sqlState: "23505", constraint: "administrator_session_pkey" });
    expect(Object.keys(failure)).toEqual(["code", "sqlState", "constraint"]);
    expect(failure.cause).toBe(cause);
    expect(Object.getOwnPropertyDescriptor(failure, "cause")?.enumerable).toBe(false);

    for (const rendered of [JSON.stringify(failure), inspect(failure), String(JSON.stringify({ ...failure }))]) {
      expect(rendered).not.toContain(canary);
    }
  });

  it("still drops a constraint name outside the identifier shape", () => {
    expect(constraintOf({ constraint: "Robert'); drop table" })).toBeUndefined();
    expect(constraintOf({ constraint: "listing_status_check" })).toBe("listing_status_check");
  });
});
