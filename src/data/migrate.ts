/**
 * Migration entry point — issue #157, implementing `Accepted` `ADR-018`.
 *
 * This is the **repository-owned programmatic entry point** `ADR-018` selected:
 * Kysely's core `Migrator` over `FileMigrationProvider`, with `pg` reached
 * through Kysely's core `PostgresDialect` (`ADR-016`). `kysely-ctl` is not
 * selected, not installed and not used, and no dependency is added here.
 *
 * **This module is schema-neutral.** It defines no table, column, constraint,
 * index, type or default, it contains no migration, and it does not decide
 * `DDM-2`'s identity-generation locus — that remains undecided and is a
 * prerequisite for the first schema migration, which is separate later work.
 *
 * **Importing this module runs nothing.** Every exported function is inert
 * until called, and the direct-invocation block at the bottom runs only when
 * Node was started with *this file* as its entry point. `ADR-018` prohibits
 * implicit migration execution during application startup, Next.js module
 * loading, server initialization and ordinary request handling, so no
 * application module may import this file.
 *
 * Execution is **explicit local developer invocation** only. CI migration
 * validation, production execution, deployment integration, credentials and
 * authority remain outstanding and are decided nowhere in this file.
 */
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import {
  FileMigrationProvider,
  Migrator,
  type MigrationResult,
  type MigrationResultSet,
} from "kysely/migration";

/** Exit status for a run that completed without error. */
export const SUCCESS = 0;

/** Exit status for any failure: configuration, migration or cleanup. */
export const FAILURE = 1;

/** Replacement text substituted for any secret that reaches a message. */
export const REDACTED = "[redacted]";

/**
 * The governed operations. Only the two `ADR-018` admits are exposed:
 * apply every pending migration, and — where a `down` exists and is honest —
 * revert exactly one step. The `Migrator` offers more; inventing an
 * administrative surface it did not authorize is not this unit's business.
 */
export const MIGRATION_OPERATIONS = ["latest", "down"] as const;

export type MigrationOperation = (typeof MIGRATION_OPERATIONS)[number];

/**
 * The repository-owned migrations location, resolved relative to this file so
 * that discovery does not depend on the working directory of the invocation.
 */
export const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * The environment variable carrying the migration target. It is read at
 * invocation time and is never committed, defaulted or embedded: there is
 * deliberately no fallback, so a run can never silently target something
 * nobody chose.
 */
export const CONNECTION_STRING_VARIABLE = "MIGRATION_DATABASE_URL";

const ACCEPTED_URL_SCHEMES = ["postgres://", "postgresql://"];

/** A configuration or usage fault, raised before anything is connected. */
export class MigrationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationConfigurationError";
  }
}

/** The `Migrator` surface this runner uses, narrowed so tests can stand in. */
export interface MigrationRunner {
  migrateToLatest(): Promise<MigrationResultSet>;
  migrateDown(): Promise<MigrationResultSet>;
}

/**
 * One invocation's database resources: the runner bound to them, and the
 * release that must happen on every path.
 */
export interface MigrationContext {
  readonly runner: MigrationRunner;
  destroy(): Promise<void>;
}

/**
 * The injected seams. They exist so that discovery, ordering, invocation,
 * cleanup and failure behaviour are verifiable without a live database, a
 * container, a service or a credential.
 */
export interface MigrationDependencies {
  /** Read-only view of the environment; never mutated. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createContext: (connectionString: string) => MigrationContext;
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
}

/** The message of an unknown thrown value, without assuming it is an `Error`. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Remove every known secret from text about to be emitted. The connection
 * string and its password are the only secrets this unit handles, and neither
 * may appear in a log line or an error report.
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.split(secret).join(REDACTED), text);
}

/**
 * Query parameters whose values are credentials in a PostgreSQL URL, and so
 * must be redacted individually as well as inside the whole URL.
 */
const CREDENTIAL_QUERY_PARAMETERS = ["password", "sslpassword"];

/**
 * The secret values derived from a connection string, longest first so that
 * the whole URL is removed before its parts and no partial match is left
 * behind.
 *
 * The username is treated as a secret too: a `pg` authentication failure
 * reports it verbatim (`password authentication failed for user "…"`), and
 * that message reaches a log line. The trade-off is accepted deliberately — a
 * pathologically short credential will garble otherwise readable output, which
 * is a safe failure, whereas emitting it is not.
 */
export function secretsOf(connectionString: string): readonly string[] {
  const secrets = [connectionString];

  try {
    const url = new URL(connectionString);

    for (const credential of [url.password, url.username]) {
      if (credential.length > 0) {
        secrets.push(credential, decodeURIComponent(credential));
      }
    }

    for (const [name, value] of url.searchParams) {
      if (
        CREDENTIAL_QUERY_PARAMETERS.includes(name.toLowerCase()) &&
        value.length > 0
      ) {
        secrets.push(value);
      }
    }
  } catch {
    // An unparseable value is still redacted whole, above.
  }

  return [...new Set(secrets)].sort(
    (left, right) => right.length - left.length,
  );
}

/**
 * Read the migration target from the environment. The value itself never
 * appears in a failure message — only the variable name does.
 */
export function readConnectionString(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env[CONNECTION_STRING_VARIABLE];

  if (value === undefined || value.trim().length === 0) {
    throw new MigrationConfigurationError(
      `${CONNECTION_STRING_VARIABLE} is not set. Set it to the PostgreSQL ` +
        `target you intend to migrate. There is no default, and no credential ` +
        `is stored in this repository.`,
    );
  }

  const connectionString = value.trim();

  if (!ACCEPTED_URL_SCHEMES.some((scheme) => connectionString.startsWith(scheme))) {
    throw new MigrationConfigurationError(
      `${CONNECTION_STRING_VARIABLE} must be a PostgreSQL connection URL ` +
        `beginning with ${ACCEPTED_URL_SCHEMES.join(" or ")}. Its value is ` +
        `not reproduced here.`,
    );
  }

  return connectionString;
}

/** Resolve the requested operation from the invocation arguments. */
export function parseOperation(
  argv: readonly string[],
): MigrationOperation {
  const allowed = MIGRATION_OPERATIONS.join(" | ");

  if (argv.length !== 1) {
    throw new MigrationConfigurationError(
      `Expected exactly one operation argument (${allowed}), received ` +
        `${argv.length}.`,
    );
  }

  const [requested] = argv;

  const operation = MIGRATION_OPERATIONS.find(
    (candidate) => candidate === requested,
  );

  if (operation === undefined) {
    // The received value is not echoed: a developer who pastes a connection
    // URL where an operation belongs would otherwise have it printed back.
    throw new MigrationConfigurationError(
      `Unknown operation. Expected one of: ${allowed}. The value received is ` +
        `not reproduced here, because it may be a credential pasted into the ` +
        `wrong argument.`,
    );
  }

  return operation;
}

/**
 * The provider Kysely discovers migrations through. The `import` hook converts
 * the absolute path to a `file://` URL so that discovery behaves identically
 * on Windows, where a bare drive-letter path is not a loadable specifier.
 */
export function createMigrationProvider(
  migrationFolder: string = MIGRATIONS_FOLDER,
  importModule: (filePath: string) => Promise<unknown> = (filePath) =>
    import(pathToFileURL(filePath).href),
): FileMigrationProvider {
  return new FileMigrationProvider({
    fs,
    path,
    migrationFolder,
    import: importModule,
  });
}

function reportResults(
  results: readonly MigrationResult[],
  deps: MigrationDependencies,
  secrets: readonly string[],
): void {
  for (const result of results) {
    const line = redactSecrets(
      `${result.status}: ${result.migrationName} (${result.direction})`,
      secrets,
    );

    if (result.status === "Success") {
      deps.info(line);
    } else {
      deps.error(line);
    }
  }
}

/**
 * Run one governed operation and report the process exit status. This function
 * never terminates the process: it returns the status so that the invocation
 * block owns termination and tests do not have to survive it.
 */
export async function runMigration(
  operation: MigrationOperation,
  deps: MigrationDependencies,
): Promise<number> {
  let connectionString: string;

  try {
    connectionString = readConnectionString(deps.env);
  } catch (cause) {
    deps.error(describeError(cause));
    return FAILURE;
  }

  const secrets = secretsOf(connectionString);

  let context: MigrationContext;

  try {
    context = deps.createContext(connectionString);
  } catch (cause) {
    deps.error(
      redactSecrets(
        `Could not open the migration connection: ${describeError(cause)}`,
        secrets,
      ),
    );
    return FAILURE;
  }

  let status = SUCCESS;

  try {
    const { error, results } =
      operation === "latest"
        ? await context.runner.migrateToLatest()
        : await context.runner.migrateDown();

    const applied = results ?? [];

    reportResults(applied, deps, secrets);

    if (error !== undefined) {
      deps.error(
        redactSecrets(`Migration failed: ${describeError(error)}`, secrets),
      );
      status = FAILURE;
    } else if (applied.length === 0) {
      deps.info(`Nothing to do: no migration was pending for "${operation}".`);
    }
  } catch (cause) {
    deps.error(
      redactSecrets(
        `Migration run threw: ${describeError(cause)}`,
        secrets,
      ),
    );
    status = FAILURE;
  } finally {
    try {
      await context.destroy();
    } catch (cause) {
      deps.error(
        redactSecrets(
          `Failed to release the migration connection: ${describeError(cause)}`,
          secrets,
        ),
      );
      status = FAILURE;
    }
  }

  return status;
}

/** Parse the arguments, run the operation, and report the exit status. */
export async function main(
  argv: readonly string[],
  deps: MigrationDependencies,
): Promise<number> {
  let operation: MigrationOperation;

  try {
    operation = parseOperation(argv);
  } catch (cause) {
    deps.error(describeError(cause));
    return FAILURE;
  }

  return runMigration(operation, deps);
}

interface PgModule {
  readonly Pool: new (config: { connectionString: string; max: number }) => PostgresPool & {
    end(): Promise<void>;
  };
}

/**
 * The real seams. Built only when this file is the process entry point, so
 * importing the module neither loads `pg` nor constructs a pool.
 *
 * `pg` ships no type declarations and `@types/pg` is not a dependency of this
 * repository; adding one is a dependency change this unit is not authorized to
 * make. The constructor is therefore reached through an explicit runtime
 * require and described by the narrow local type above, which is exactly the
 * subset Kysely's `PostgresDialect` consumes.
 */
export function createDefaultDependencies(): MigrationDependencies {
  const { Pool } = createRequire(import.meta.url)("pg") as PgModule;

  return {
    env: process.env,
    createContext: (connectionString) => {
      // One connection is enough for a single, deliberate, serial run.
      const pool = new Pool({ connectionString, max: 1 });
      const db = new Kysely<unknown>({
        dialect: new PostgresDialect({ pool }),
      });

      return {
        runner: new Migrator({ db, provider: createMigrationProvider() }),
        destroy: () => db.destroy(),
      };
    },
    info: (message) => {
      console.log(message);
    },
    error: (message) => {
      console.error(message);
    },
  };
}

/**
 * True only when Node was started with this file as its entry point. Under a
 * test runner, or under any importer, it is false — which is what keeps this
 * module from migrating anything by being loaded.
 */
export function isDirectInvocation(
  entryPath: string | undefined = process.argv[1],
): boolean {
  if (entryPath === undefined) {
    return false;
  }

  return path.resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isDirectInvocation()) {
  process.exitCode = await main(
    process.argv.slice(2),
    createDefaultDependencies(),
  );
}
