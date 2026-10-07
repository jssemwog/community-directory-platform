/**
 * Migration infrastructure tests — issue #157.
 *
 * These prove the *mechanism*: discovery, provider and runner wiring, the two
 * governed operations, configuration handling, connection lifecycle, failure
 * reporting and exit status. They prove nothing about any schema, because no
 * schema exists.
 *
 * **No test here reaches a database.** There is no live PostgreSQL instance, no
 * container, no service, no credential and no provisioning step: every seam the
 * runner uses is injected, and the only filesystem touched is a temporary
 * directory this file creates and removes.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { MigrationResult, MigrationResultSet } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTION_STRING_VARIABLE,
  FAILURE,
  MIGRATIONS_FOLDER,
  MIGRATION_OPERATIONS,
  MigrationConfigurationError,
  REDACTED,
  SUCCESS,
  createMigrationProvider,
  isDirectInvocation,
  main,
  parseOperation,
  readConnectionString,
  redactSecrets,
  runMigration,
  secretsOf,
} from "./migrate";
import type {
  MigrationContext,
  MigrationDependencies,
  MigrationRunner,
} from "./migrate";

const CONNECTION_STRING = "postgres://someone:s3cr3t-pw@localhost:5432/local";

interface Recorder {
  readonly deps: MigrationDependencies;
  readonly info: string[];
  readonly errors: string[];
  readonly connections: string[];
  readonly destroys: number[];
  readonly calls: string[];
}

interface FakeOptions {
  readonly latest?: () => Promise<MigrationResultSet>;
  readonly down?: () => Promise<MigrationResultSet>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly createContext?: (connectionString: string) => MigrationContext;
  readonly destroy?: () => Promise<void>;
}

function succeededWith(...names: string[]): MigrationResultSet {
  const results: MigrationResult[] = names.map((migrationName) => ({
    migrationName,
    direction: "Up",
    status: "Success",
  }));

  return { results };
}

function recorder(options: FakeOptions = {}): Recorder {
  const info: string[] = [];
  const errors: string[] = [];
  const connections: string[] = [];
  const destroys: number[] = [];
  const calls: string[] = [];

  const runner: MigrationRunner = {
    migrateToLatest: async () => {
      calls.push("migrateToLatest");
      return options.latest === undefined
        ? succeededWith()
        : await options.latest();
    },
    migrateDown: async () => {
      calls.push("migrateDown");
      return options.down === undefined
        ? succeededWith()
        : await options.down();
    },
  };

  const createContext =
    options.createContext ??
    ((connectionString: string): MigrationContext => {
      connections.push(connectionString);

      return {
        runner,
        destroy: async () => {
          destroys.push(calls.length);
          if (options.destroy !== undefined) {
            await options.destroy();
          }
        },
      };
    });

  return {
    deps: {
      env: options.env ?? { [CONNECTION_STRING_VARIABLE]: CONNECTION_STRING },
      createContext,
      info: (message) => info.push(message),
      error: (message) => errors.push(message),
    },
    info,
    errors,
    connections,
    destroys,
    calls,
  };
}

describe("migration discovery (ADR-018 FileMigrationProvider)", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "cdp-migrations-"));
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("resolves the repository-owned migrations folder from this module", () => {
    expect(MIGRATIONS_FOLDER).toBe(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
    );
  });

  it("discovers no migration today, because none exists", async () => {
    const discovered = await createMigrationProvider().getMigrations();

    expect(Object.keys(discovered)).toEqual([]);
  });

  it("discovers migration files in ascending name order and ignores non-migrations", async () => {
    await fs.writeFile(path.join(folder, "002-second.ts"), "", "utf8");
    await fs.writeFile(path.join(folder, "001-first.ts"), "", "utf8");
    await fs.writeFile(path.join(folder, "README.md"), "", "utf8");

    const imported: string[] = [];
    const provider = createMigrationProvider(folder, async (filePath) => {
      imported.push(filePath);
      return { up: async () => {} };
    });

    const discovered = await provider.getMigrations();

    expect(Object.keys(discovered).sort()).toEqual(["001-first", "002-second"]);
    expect(imported.every((filePath) => path.dirname(filePath) === folder)).toBe(
      true,
    );
    expect(imported.some((filePath) => filePath.endsWith("README.md"))).toBe(
      false,
    );
  });
});

describe("configuration boundary", () => {
  it("reads the connection string from the injected environment", () => {
    expect(
      readConnectionString({ [CONNECTION_STRING_VARIABLE]: CONNECTION_STRING }),
    ).toBe(CONNECTION_STRING);
  });

  it("accepts the postgresql:// scheme and trims surrounding whitespace", () => {
    expect(
      readConnectionString({
        [CONNECTION_STRING_VARIABLE]: "  postgresql://localhost/db  ",
      }),
    ).toBe("postgresql://localhost/db");
  });

  it("fails when the variable is absent", () => {
    expect(() => readConnectionString({})).toThrow(MigrationConfigurationError);
  });

  it("fails when the variable is blank, rather than defaulting to a target", () => {
    expect(() =>
      readConnectionString({ [CONNECTION_STRING_VARIABLE]: "   " }),
    ).toThrow(MigrationConfigurationError);
  });

  it("fails on a value that is not a PostgreSQL URL, without echoing it", () => {
    let message = "";

    try {
      readConnectionString({ [CONNECTION_STRING_VARIABLE]: "mysql://nope" });
    } catch (cause) {
      message = (cause as Error).message;
    }

    expect(message).toContain(CONNECTION_STRING_VARIABLE);
    expect(message).not.toContain("mysql://nope");
  });
});

describe("operation parsing", () => {
  it("accepts each governed operation and nothing else", () => {
    for (const operation of MIGRATION_OPERATIONS) {
      expect(parseOperation([operation])).toBe(operation);
    }

    expect(() => parseOperation(["status"])).toThrow(
      MigrationConfigurationError,
    );
  });

  it("requires exactly one operation argument", () => {
    expect(() => parseOperation([])).toThrow(MigrationConfigurationError);
    expect(() => parseOperation(["latest", "down"])).toThrow(
      MigrationConfigurationError,
    );
  });
});

describe("secret redaction", () => {
  it("removes the connection string and its password from text", () => {
    const text = `failed for ${CONNECTION_STRING} with password s3cr3t-pw`;

    const redacted = redactSecrets(text, secretsOf(CONNECTION_STRING));

    expect(redacted).not.toContain(CONNECTION_STRING);
    expect(redacted).not.toContain("s3cr3t-pw");
    expect(redacted).toContain(REDACTED);
  });
});

describe("runMigration", () => {
  it("maps 'latest' to migrateToLatest and reports success", async () => {
    const fake = recorder({ latest: async () => succeededWith("001-first") });

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(SUCCESS);
    expect(fake.calls).toEqual(["migrateToLatest"]);
    expect(fake.info).toContain("Success: 001-first (Up)");
    expect(fake.errors).toEqual([]);
  });

  it("maps 'down' to migrateDown and to that alone", async () => {
    const fake = recorder({ down: async () => succeededWith("001-first") });

    const status = await runMigration("down", fake.deps);

    expect(status).toBe(SUCCESS);
    expect(fake.calls).toEqual(["migrateDown"]);
  });

  it("opens exactly one connection from the configured value", async () => {
    const fake = recorder();

    await runMigration("latest", fake.deps);

    expect(fake.connections).toEqual([CONNECTION_STRING]);
  });

  it("says so plainly when nothing was pending", async () => {
    const fake = recorder();

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(SUCCESS);
    expect(fake.info.join("\n")).toContain("Nothing to do");
  });

  it("releases the connection after a successful run", async () => {
    const fake = recorder();

    await runMigration("latest", fake.deps);

    expect(fake.destroys).toHaveLength(1);
  });

  it("reports a migration-engine error, fails, and still releases the connection", async () => {
    const fake = recorder({
      latest: async () => ({
        error: new Error("relation already exists"),
        results: [
          { migrationName: "001-first", direction: "Up", status: "Error" },
          { migrationName: "002-second", direction: "Up", status: "NotExecuted" },
        ],
      }),
    });

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(FAILURE);
    expect(fake.errors).toContain("Error: 001-first (Up)");
    expect(fake.errors.join("\n")).toContain("relation already exists");
    expect(fake.destroys).toHaveLength(1);
  });

  it("handles a thrown migration failure, fails, and still releases the connection", async () => {
    const fake = recorder({
      latest: async () => {
        throw new Error("advisory lock timeout");
      },
    });

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(FAILURE);
    expect(fake.errors.join("\n")).toContain("advisory lock timeout");
    expect(fake.destroys).toHaveLength(1);
  });

  it("fails without opening a connection when configuration is missing", async () => {
    const fake = recorder({ env: {} });

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(FAILURE);
    expect(fake.connections).toEqual([]);
    expect(fake.destroys).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("fails when the connection cannot be opened, with nothing to release", async () => {
    const fake = recorder({
      createContext: () => {
        throw new Error("ENOTFOUND db.example.invalid");
      },
    });

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(FAILURE);
    expect(fake.errors.join("\n")).toContain("ENOTFOUND");
    expect(fake.destroys).toEqual([]);
  });

  it("fails when cleanup fails, even though the migrations succeeded", async () => {
    const fake = recorder({
      destroy: async () => {
        throw new Error("pool already ended");
      },
    });

    const status = await runMigration("latest", fake.deps);

    expect(status).toBe(FAILURE);
    expect(fake.errors.join("\n")).toContain("pool already ended");
  });

  it("releases the connection only after the migrations have run", async () => {
    const fake = recorder({ latest: async () => succeededWith("001-first") });

    await runMigration("latest", fake.deps);

    expect(fake.destroys).toEqual([1]);
  });

  it("never emits the connection string or its password, whatever fails", async () => {
    const fake = recorder({
      latest: async () => {
        throw new Error(`connect failed: ${CONNECTION_STRING}`);
      },
    });

    await runMigration("latest", fake.deps);

    const emitted = [...fake.info, ...fake.errors].join("\n");

    expect(emitted).not.toContain(CONNECTION_STRING);
    expect(emitted).not.toContain("s3cr3t-pw");
    expect(emitted).toContain(REDACTED);
  });

  it("does not mutate the caller's environment or dependencies", async () => {
    const env = Object.freeze({
      [CONNECTION_STRING_VARIABLE]: CONNECTION_STRING,
    });
    const fake = recorder({ env });

    await runMigration("latest", fake.deps);

    expect(env).toEqual({ [CONNECTION_STRING_VARIABLE]: CONNECTION_STRING });
  });
});

describe("main", () => {
  it("runs the requested operation and reports a successful status", async () => {
    const fake = recorder();
    const argv = Object.freeze(["latest"]);

    const status = await main(argv, fake.deps);

    expect(status).toBe(SUCCESS);
    expect(fake.calls).toEqual(["migrateToLatest"]);
    expect(argv).toEqual(["latest"]);
  });

  it("reports a non-zero status for an unknown operation, and runs nothing", async () => {
    const fake = recorder();

    const status = await main(["sideways"], fake.deps);

    expect(status).toBe(FAILURE);
    expect(fake.calls).toEqual([]);
    expect(fake.connections).toEqual([]);
  });

  it("reports a non-zero status when no operation is given", async () => {
    const fake = recorder();

    expect(await main([], fake.deps)).toBe(FAILURE);
    expect(fake.calls).toEqual([]);
  });
});

describe("explicit invocation only (ADR-018)", () => {
  it("does not treat an import as an invocation", () => {
    expect(isDirectInvocation()).toBe(false);
  });

  it("recognises only this file as a direct invocation", () => {
    const self = fileURLToPath(import.meta.url).replace(
      /migrate\.test\.ts$/,
      "migrate.ts",
    );

    expect(isDirectInvocation(self)).toBe(true);
    expect(isDirectInvocation(path.join(path.dirname(self), "other.ts"))).toBe(
      false,
    );
    expect(isDirectInvocation(undefined)).toBe(false);
  });

  it("left the process exit status untouched by being imported", () => {
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });
});
