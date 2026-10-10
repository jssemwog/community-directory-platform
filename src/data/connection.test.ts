/**
 * Attacking tests for the `C9` connection boundary (issue #177).
 *
 * These run **without a database**, and that is the point: the obligations under attack here are
 * about what the boundary refuses and what it does *not* do on import. The live behaviour —
 * `DateStyle` in force on real backends, instants arriving as epoch milliseconds — is proved
 * against a real server in `listing-persistence.integration.test.ts`.
 *
 * This file is deliberately the **only** place that inspects the CommonJS module cache. Vitest
 * gives each test file its own module registry, so "has `pg` been loaded yet?" is a meaningful
 * question here and would be meaningless in a file that also opens connections.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  GOVERNED_DATESTYLE,
  PersistenceConfigurationError,
  createListingPersistence,
  startupOptionsFor,
  type ListingPoolConfiguration,
} from "./connection";

const require_ = createRequire(import.meta.url);

/** Has the driver been loaded into this worker's CommonJS registry yet? */
function pgIsLoaded(): boolean {
  return Object.keys(require_.cache).some((path) =>
    /[\\/]node_modules[\\/]pg[\\/]lib[\\/]index\.js$/.test(path),
  );
}

/** A configuration pointing nowhere. Nothing in this file is allowed to connect. */
const unreachable: ListingPoolConfiguration = {
  host: "127.0.0.1",
  port: 1,
  user: "nobody",
  password: "unused-in-this-file",
  database: "nothing",
};

describe("importing the module does nothing (issue #177 §7)", () => {
  it("has not loaded the driver merely because this module was imported", () => {
    // Asserted first, before any test can construct a pool: a module that reached for `pg` at
    // import time would also be a module that could construct a pool at import time.
    expect(pgIsLoaded()).toBe(false);
  });

  it("builds the startup options without a driver, a pool or a connection", () => {
    expect(startupOptionsFor()).toContain(`-c datestyle=${GOVERNED_DATESTYLE}`);
    expect(pgIsLoaded()).toBe(false);
  });
});

describe("the governed DateStyle is always present", () => {
  it("emits it with no caller parameters at all", () => {
    expect(startupOptionsFor()).toBe("-c datestyle=ISO");
  });

  it("emits it exactly once when the caller asks for the same thing", () => {
    const options = startupOptionsFor({ DateStyle: "ISO" });

    expect(options.match(/datestyle=/g)).toHaveLength(1);
    expect(options).toBe("-c datestyle=ISO");
  });

  it("emits it first, and keeps the caller's own parameters after it", () => {
    const options = startupOptionsFor({
      application_name: "directory",
      statement_timeout: "5000",
    });

    expect(options).toBe(
      "-c datestyle=ISO -c application_name=directory -c statement_timeout=5000",
    );
  });

  it("preserves every compatible caller parameter, whatever the key order", () => {
    const forward = startupOptionsFor({ a_one: "1", b_two: "2" });
    const backward = startupOptionsFor({ b_two: "2", a_one: "1" });

    for (const options of [forward, backward]) {
      expect(options.startsWith("-c datestyle=ISO")).toBe(true);
      expect(options).toContain("-c a_one=1");
      expect(options).toContain("-c b_two=2");
    }
  });
});

describe("a caller cannot defeat the governed DateStyle (issue #177 §8)", () => {
  it("refuses an incompatible DateStyle instead of resolving precedence", () => {
    for (const hostile of ["SQL", "SQL, MDY", "German", "Postgres", "postgres, dmy"]) {
      let thrown: unknown;

      try {
        startupOptionsFor({ datestyle: hostile });
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown, hostile).toBeInstanceOf(PersistenceConfigurationError);
      expect((thrown as PersistenceConfigurationError).problem.reason).toBe(
        "DATESTYLE_CONFLICT",
      );
    }
  });

  it("refuses it whatever the capitalization of the parameter name", () => {
    for (const name of ["datestyle", "DateStyle", "DATESTYLE", "dAtEsTyLe"]) {
      expect(() => startupOptionsFor({ [name]: "SQL" })).toThrow(
        PersistenceConfigurationError,
      );
    }
  });

  it("accepts a compatible DateStyle whatever its capitalization or spacing", () => {
    for (const value of ["ISO", "iso", "ISO, MDY", "iso,mdy", " ISO ", "ISO, DMY"]) {
      expect(startupOptionsFor({ datestyle: value })).toBe("-c datestyle=ISO");
    }
  });

  it("refuses two spellings of the same parameter rather than letting key order decide", () => {
    let thrown: unknown;

    try {
      startupOptionsFor({ DateStyle: "ISO", datestyle: "SQL" });
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PersistenceConfigurationError);
    expect((thrown as PersistenceConfigurationError).problem.reason).toBe(
      "DUPLICATE_STARTUP_PARAMETER",
    );
  });

  it("refuses a duplicate of any parameter, not only of DateStyle", () => {
    expect(() => startupOptionsFor({ Application_Name: "a", application_name: "b" })).toThrow(
      PersistenceConfigurationError,
    );
  });

  it("refuses a parameter name that could escape its own -c pair", () => {
    for (const name of [
      "datestyle -c x",
      "a b",
      "a=b",
      "-c",
      "a'b",
      'a"b',
      "a\\b",
      "a\nb",
      "",
      "1leading_digit",
    ]) {
      expect(() => startupOptionsFor({ [name]: "x" }), name).toThrow(
        PersistenceConfigurationError,
      );
    }
  });

  it("refuses a parameter value that could introduce another option", () => {
    for (const value of [
      "x -c datestyle=SQL",
      "x y",
      "-c",
      "x'y",
      'x"y',
      "x\\y",
      "x\ty",
      "x\ny",
      "",
    ]) {
      expect(() => startupOptionsFor({ application_name: value }), value).toThrow(
        PersistenceConfigurationError,
      );
    }
  });

  it("never emits an option string containing a shell-significant character", () => {
    const options = startupOptionsFor({ application_name: "directory", search_path: "public" });

    expect(options).toMatch(/^-c [A-Za-z][A-Za-z0-9_.]*=[A-Za-z0-9_.,:+]+( -c [A-Za-z][A-Za-z0-9_.]*=[A-Za-z0-9_.,:+]+)*$/);
  });
});

describe("the boundary owns the options field (issue #177 §7)", () => {
  it("refuses a caller-supplied options field outright", () => {
    let thrown: unknown;

    try {
      createListingPersistence({
        pool: { ...unreachable, options: "-c datestyle=SQL" } as ListingPoolConfiguration,
      });
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PersistenceConfigurationError);
    expect((thrown as PersistenceConfigurationError).problem.reason).toBe(
      "CALLER_SUPPLIED_OPTIONS",
    );
  });

  it("refuses a connection string carrying options, which pg would let win", () => {
    // `pg` merges a parsed connection string **over** explicit configuration
    // (`Object.assign({}, config, parse(config.connectionString))`), so this URL would
    // otherwise override the governed DateStyle.
    for (const url of [
      "postgresql://u:p@127.0.0.1:1/d?options=-c%20datestyle%3DSQL",
      "postgresql://u:p@127.0.0.1:1/d?OPTIONS=-c%20datestyle%3DSQL",
      "postgres://u:p@127.0.0.1:1/d?application_name=a&options=-c%20datestyle%3DGerman",
    ]) {
      let thrown: unknown;

      try {
        createListingPersistence({ pool: { connectionString: url } });
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown, url).toBeInstanceOf(PersistenceConfigurationError);
      expect((thrown as PersistenceConfigurationError).problem.reason).toBe(
        "CONNECTION_STRING_CARRIES_OPTIONS",
      );
    }
  });

  it("refuses a connection string it cannot parse, rather than guessing", () => {
    let thrown: unknown;

    try {
      createListingPersistence({ pool: { connectionString: "not a url" } });
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(PersistenceConfigurationError);
    expect((thrown as PersistenceConfigurationError).problem.reason).toBe(
      "CONNECTION_STRING_UNPARSEABLE",
    );
  });
});

describe("a refused configuration never reaches the network (issue #177 §8)", () => {
  it("throws before the driver is even loaded", () => {
    // The strongest statement available without a server: if `pg` has not been required, no
    // pool exists and no connection can have been attempted.
    expect(pgIsLoaded()).toBe(false);

    expect(() =>
      createListingPersistence({
        pool: unreachable,
        startupParameters: { datestyle: "SQL" },
      }),
    ).toThrow(PersistenceConfigurationError);

    expect(pgIsLoaded()).toBe(false);
  });
});

describe("errors leak nothing (issue #177 §11)", () => {
  const secret = "sup3r-secret-password";

  it("keeps the connection string, host, user and password out of every message", () => {
    const attempts: (() => unknown)[] = [
      () =>
        createListingPersistence({
          pool: { connectionString: `postgresql://admin:${secret}@db.internal:5432/app?options=-c%20datestyle%3DSQL` },
        }),
      () =>
        createListingPersistence({
          pool: { connectionString: `postgresql://admin:${secret}@db.internal` , options: "x" } as ListingPoolConfiguration,
        }),
      () => createListingPersistence({ pool: { connectionString: `not-a-url-${secret}` } }),
      () =>
        createListingPersistence({
          pool: { host: "db.internal", user: "admin", password: secret },
          startupParameters: { datestyle: "SQL" },
        }),
    ];

    for (const attempt of attempts) {
      let thrown: unknown;

      try {
        attempt();
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown).toBeInstanceOf(PersistenceConfigurationError);

      const rendered = `${(thrown as Error).message} ${(thrown as Error).stack ?? ""} ${JSON.stringify(
        (thrown as PersistenceConfigurationError).problem,
      )}`;

      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain("db.internal");
      expect(rendered).not.toContain("admin");
      expect(rendered).not.toContain("postgresql://");
    }
  });

  it("names a refused parameter but never its value", () => {
    let thrown: unknown;

    try {
      startupOptionsFor({ application_name: `leak-${secret}` });
    } catch (cause) {
      thrown = cause;
    }

    const problem = (thrown as PersistenceConfigurationError).problem;

    expect(problem.reason).toBe("UNSAFE_STARTUP_PARAMETER_VALUE");
    expect(JSON.stringify(problem)).not.toContain(secret);
  });

  it("reports a conflicting DateStyle value, which is a governed setting and not a secret", () => {
    let thrown: unknown;

    try {
      startupOptionsFor({ datestyle: "SQL" });
    } catch (cause) {
      thrown = cause;
    }

    const problem = (thrown as PersistenceConfigurationError).problem;

    expect(problem).toEqual({ reason: "DATESTYLE_CONFLICT", supplied: "SQL" });
  });
});

describe("the driver's global state is never touched (issue #177 §7)", () => {
  it("leaves pg's own timestamptz parser at the driver default", async () => {
    // Loading `pg` here is deliberate and happens after every cache assertion above.
    const pg = require_("pg") as {
      types: { getTypeParser(oid: number, format: string): unknown };
    };
    const before = pg.types.getTypeParser(1184, "text");

    const persistence = createListingPersistence({ pool: unreachable });

    try {
      expect(pg.types.getTypeParser(1184, "text")).toBe(before);
      // And the default really is the driver's `Date`-producing parser, so the comparison
      // above is not comparing two copies of our own override.
      expect((pg.types.getTypeParser(1184, "text") as (v: string) => unknown)(
        "2026-01-02 03:04:05.123+00",
      )).toBeInstanceOf(Date);
    } finally {
      await persistence.shutdown();
    }
  });
});

describe("shutdown (issue #177 §5)", () => {
  it("is safe to call more than once", async () => {
    const persistence = createListingPersistence({ pool: unreachable });

    await expect(persistence.shutdown()).resolves.toBeUndefined();
    await expect(persistence.shutdown()).resolves.toBeUndefined();
  });

  it("exposes the database handle and not the pool", () => {
    const persistence = createListingPersistence({ pool: unreachable });

    try {
      expect(Object.keys(persistence).sort()).toEqual(["db", "shutdown"]);
    } finally {
      void persistence.shutdown();
    }
  });
});
