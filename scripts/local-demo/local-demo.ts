/**
 * The **local demonstration** of the public directory (issue #248): `start`, `stop` and `reset`.
 *
 * `start` initialises a PostgreSQL cluster under `.local-demo/` on first use. It then:
 * 1. starts the cluster, listening on **127.0.0.1 only**;
 * 2. applies the governed migrations;
 * 3. re-creates the synthetic listings through the existing operations (`fixtures.ts`);
 * 4. runs `next dev` on **127.0.0.1**, with the connection string in that server process's
 *    environment only.
 *
 * Ctrl+C stops the site and then the cluster. `stop` stops a cluster left running. `reset` stops
 * it and deletes `.local-demo/`, including the local administrator keys, certificate and accounts.
 *
 * ## The local administrator journey (issue #260, under the #254 exception)
 *
 * `admin start` runs the same demo **over local HTTPS** with the local administrator gate open
 * (`src/interface/admin/local-gate.ts`): it creates development-only keys in
 * `.local-demo/administrator-keys.json` and a self-signed certificate for `127.0.0.1` in
 * `.local-demo/tls/` on first use, and passes them only to the spawned `next dev`. No trust store
 * is changed, so the browser shows a certificate warning the first time. `admin add` provisions
 * one synthetic administrator while the demo is stopped. Plain `start` is unchanged: HTTP, with
 * the gate closed. Recovery codes, revocation and account management do not exist; the journey
 * is local and synthetic only.
 *
 * ## One command at a time, and nothing deleted on doubt (`lifecycle.ts`)
 *
 * - Every command takes the owned launcher lock `.local-demo/launcher.lock` first, by exclusive
 *   creation. While it exists, a second `start` cannot reseed or stop the demo, and `stop` and
 *   `reset` refuse. An existing lock is never moved or deleted automatically, even when its
 *   process has exited; a person removes it after confirming no demo launcher or site remains.
 * - `start` checks that the site port is free before it changes anything.
 * - `pg_ctl status` is read as running, stopped or unknown. On unknown, `start` and `stop` change
 *   nothing, and `reset` deletes nothing; `reset` also refuses while the database port is busy.
 * - Shutdown asks the spawned site to stop over IPC (`site-control.mjs`) and waits, within bounds,
 *   for that child to exit and the site port to become bindable; only then does it stop the
 *   cluster and report success. That does not prove every site worker exited.
 *
 * ## Local only, and nothing shared
 *
 * - The PostgreSQL binaries are the ones `embedded-postgres` already installs for the test suite;
 *   nothing is downloaded and no service or account is used.
 * - `embedded-postgres` itself is **not** imported, because importing it installs a process exit
 *   hook that would end this process before its own orderly shutdown completes. Only the
 *   platform package's `initdb` and `pg_ctl` paths are used, and the cluster is started and
 *   stopped by PostgreSQL's own `pg_ctl` (`-m fast -w`), as the test helper does on Windows.
 * - The password is random per cluster, kept in the git-ignored `.local-demo/credentials.json`,
 *   and never printed. Errors are reported by code and step, never with a connection string.
 * - This is not a production configuration: no pool, TLS or credential policy is decided here
 *   (`ADR-016`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect, sql, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";

import { createListingPersistence } from "../../src/data/connection";
import { createMigrationProvider } from "../../src/data/migrate";
import { LOCAL_DEMO_DATABASE_URL } from "../../src/interface/public/local-demo-persistence";
import { resetAndSeedSyntheticListings, SYNTHETIC_LISTINGS } from "./fixtures";
import { administratorEnvironmentFor, ensureAdministratorKeys } from "./administrator-keys";
import { CONTROL_SUBCOMMANDS, controlSyntheticAdministrator, type ControlSubcommand } from "./administrator-control";
import { INCOMPLETE_NOTICE, launchRefusalOf, processTerminal, provisionSyntheticAdministrator } from "./administrator-provisioning";
import { ensureLocalCertificate, httpsArgumentsFor } from "./local-tls";
import {
  acquireLauncherLock,
  clusterStatusOf,
  portIsFree,
  resetRefusalOf,
  SITE_CONTROL_OWNER_ENV,
  stopOwnedSite,
  type ClusterStatus,
  type OwnedLock,
} from "./lifecycle";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEMO_DIRECTORY = join(REPOSITORY_ROOT, ".local-demo");
const DATA_DIRECTORY = join(DEMO_DIRECTORY, "pgdata");
const SERVER_LOG = join(DEMO_DIRECTORY, "postgres.log");
const CREDENTIALS_FILE = join(DEMO_DIRECTORY, "credentials.json");
const LAUNCHER_LOCK = join(DEMO_DIRECTORY, "launcher.lock");
const ADMINISTRATOR_KEYS_FILE = join(DEMO_DIRECTORY, "administrator-keys.json");
const TLS_DIRECTORY = join(DEMO_DIRECTORY, "tls");

const HOST = "127.0.0.1";
const DATABASE_PORT = 54329;
const WEB_PORT = 3000;
/** The administrator journey's canonical origin: local HTTPS on loopback (issue #260 OD-3). */
const ADMIN_ORIGIN = `https://${HOST}:${WEB_PORT}`;
const DATABASE_USER = "demo";
const DATABASE_NAME = "community_directory_demo";
const PG_CTL_TIMEOUT_SECONDS = "60";
/** How long each shutdown step waits for the site: its exit, a forced exit, the port release. */
const SITE_STOP_TIMEOUT_MS = 15_000;
/** The IPC message a supervising process (the lifecycle check) sends to request shutdown. */
const LAUNCHER_SHUTDOWN_MESSAGE = "local-demo:shutdown";

interface PostgresBinaries {
  readonly initdb: string;
  readonly pg_ctl: string;
}

const require = createRequire(import.meta.url);

function say(line: string): void {
  process.stdout.write(`[local-demo] ${line}\n`);
}

/** The binaries `embedded-postgres` installed for this platform, without importing it. */
async function postgresBinaries(): Promise<PostgresBinaries> {
  const os = platform() === "win32" ? "windows" : platform();
  // A computed specifier: the package exists only for the current platform.
  const specifier = `@embedded-postgres/${os}-${arch()}`;
  const binaries = (await import(specifier)) as Partial<PostgresBinaries>;

  if (typeof binaries.initdb !== "string" || typeof binaries.pg_ctl !== "string") {
    throw new Error("The bundled PostgreSQL binaries for this platform were not found.");
  }

  return { initdb: binaries.initdb, pg_ctl: binaries.pg_ctl };
}

/** Run a binary with an argument array and no shell; resolve with its exit code. */
function run(command: string, args: readonly string[], quiet = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: quiet ? "ignore" : "inherit", windowsHide: true });

    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** The owned cluster's status. With no data directory there is no cluster of ours to run. */
async function clusterStatus(binaries: PostgresBinaries): Promise<ClusterStatus> {
  if (!existsSync(DATA_DIRECTORY)) {
    return "stopped";
  }

  try {
    return clusterStatusOf(await run(binaries.pg_ctl, ["status", "-D", DATA_DIRECTORY]));
  } catch {
    return clusterStatusOf(null);
  }
}

const UNKNOWN_STATUS =
  "pg_ctl could not confirm whether the local PostgreSQL cluster is running; nothing was changed. See .local-demo/postgres.log.";

/** Take the launcher lock for `command`, or explain who holds it and change nothing. */
function takeLauncherLock(command: string): OwnedLock {
  mkdirSync(DEMO_DIRECTORY, { recursive: true });

  const attempt = acquireLauncherLock(LAUNCHER_LOCK, command);

  if (attempt.ok) {
    process.on("exit", () => attempt.lock.release());
    return attempt.lock;
  }

  if (attempt.reason === "active") {
    throw new Error(
      `A local demo \`${attempt.holder.command}\` (process ${attempt.holder.pid}) is still active; nothing was changed. ` +
        "Stop it with Ctrl+C in its terminal first.",
    );
  }

  if (attempt.reason === "stale") {
    throw new Error(
      `.local-demo/launcher.lock was left by a local demo \`${attempt.holder.command}\` (process ${attempt.holder.pid}) ` +
        "that no longer appears to be running; nothing was changed. Confirm that no local demo launcher or site is " +
        "still running, then delete .local-demo/launcher.lock and try again.",
    );
  }

  if (attempt.reason === "unreadable") {
    throw new Error(
      ".local-demo/launcher.lock is unreadable; nothing was changed. Remove it only after confirming no local demo command is running.",
    );
  }

  throw new Error("The launcher lock kept changing while being taken; nothing was changed. Try again.");
}

function readPassword(): string {
  const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as { password?: unknown };

  if (typeof parsed.password !== "string" || parsed.password === "") {
    throw new Error("The local demo credentials are unreadable; run `npm run demo:local:reset`.");
  }

  return parsed.password;
}

function connectionStringFor(database: string, password: string): string {
  return `postgresql://${DATABASE_USER}:${encodeURIComponent(password)}@${HOST}:${DATABASE_PORT}/${database}`;
}

async function initialiseIfNeeded(binaries: PostgresBinaries): Promise<void> {
  if (existsSync(join(DATA_DIRECTORY, "PG_VERSION"))) {
    if (!existsSync(CREDENTIALS_FILE)) {
      throw new Error("The local demo cluster has no credentials file; run `npm run demo:local:reset`.");
    }

    return;
  }

  say("Initialising a local PostgreSQL cluster in .local-demo/ (first run only)…");
  mkdirSync(DEMO_DIRECTORY, { recursive: true });

  const password = randomBytes(24).toString("hex");
  const passwordFile = join(DEMO_DIRECTORY, "initdb-password.tmp");

  writeFileSync(CREDENTIALS_FILE, JSON.stringify({ password }), { mode: 0o600 });
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });

  try {
    const code = await run(binaries.initdb, [
      `--pgdata=${DATA_DIRECTORY}`,
      `--username=${DATABASE_USER}`,
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);

    if (code !== 0) {
      throw new Error("initdb failed; run `npm run demo:local:reset` and try again.");
    }
  } finally {
    rmSync(passwordFile, { force: true });
  }
}

async function startCluster(binaries: PostgresBinaries): Promise<void> {
  const status = await clusterStatus(binaries);

  if (status === "unknown") {
    throw new Error(UNKNOWN_STATUS);
  }

  if (status === "running") {
    // No live launcher holds the lock, so this cluster was left by an earlier session.
    say("The local PostgreSQL cluster was left running by an earlier session; reusing it.");
    return;
  }

  if (!(await portIsFree(HOST, DATABASE_PORT))) {
    throw new Error(`Port ${DATABASE_PORT} on ${HOST} is in use by another process.`);
  }

  say(`Starting PostgreSQL on ${HOST}:${DATABASE_PORT}…`);

  const code = await run(binaries.pg_ctl, [
    "start",
    "-D",
    DATA_DIRECTORY,
    "-l",
    SERVER_LOG,
    "-w",
    "-t",
    PG_CTL_TIMEOUT_SECONDS,
    "-o",
    `-p ${DATABASE_PORT} -c listen_addresses=${HOST}`,
  ]);

  if (code !== 0) {
    throw new Error("PostgreSQL did not start; see .local-demo/postgres.log.");
  }
}

/** Stop the owned cluster and confirm it stopped; throw if that cannot be confirmed. */
async function stopCluster(binaries: PostgresBinaries): Promise<void> {
  const status = await clusterStatus(binaries);

  if (status === "unknown") {
    throw new Error(UNKNOWN_STATUS);
  }

  if (status === "stopped") {
    return;
  }

  say("Stopping PostgreSQL…");

  const code = await run(binaries.pg_ctl, ["stop", "-D", DATA_DIRECTORY, "-m", "fast", "-w", "-t", PG_CTL_TIMEOUT_SECONDS]);

  if (code !== 0 || (await clusterStatus(binaries)) !== "stopped") {
    throw new Error("PostgreSQL could not be confirmed stopped; run `npm run demo:local:stop` again.");
  }
}

function plainKysely(connectionString: string): Kysely<unknown> {
  const { Pool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PostgresPool & { on(event: "error", listener: () => void): void };
  };
  const pool = new Pool({ connectionString, max: 1 });

  pool.on("error", () => {});

  return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

async function prepareDatabase(password: string, seed = true): Promise<void> {
  const admin = plainKysely(connectionStringFor("postgres", password));

  try {
    const { rows } = await sql<{ exists: boolean }>`
      select exists (select 1 from pg_database where datname = ${DATABASE_NAME}) as exists
    `.execute(admin);

    if (rows[0]?.exists !== true) {
      say(`Creating the ${DATABASE_NAME} database…`);
      await sql`create database ${sql.id(DATABASE_NAME)}`.execute(admin);
    }
  } finally {
    await admin.destroy();
  }

  const migrating = plainKysely(connectionStringFor(DATABASE_NAME, password));

  try {
    say("Applying migrations…");

    const { error } = await new Migrator({ db: migrating, provider: createMigrationProvider() }).migrateToLatest();

    if (error !== undefined) {
      throw new Error("Applying the migrations failed.");
    }
  } finally {
    await migrating.destroy();
  }

  if (!seed) {
    return;
  }

  const persistence = createListingPersistence({
    pool: { connectionString: connectionStringFor(DATABASE_NAME, password), max: 1 },
  });

  try {
    say(`Creating ${SYNTHETIC_LISTINGS.length} synthetic listings through the existing operations…`);
    await resetAndSeedSyntheticListings(persistence.db);
  } finally {
    await persistence.shutdown();
  }
}

async function start(): Promise<void> {
  await startSite(false);
}

/** `start`, or with `administrator` the local administrator journey over local HTTPS. */
async function startSite(administrator: boolean): Promise<void> {
  const binaries = await postgresBinaries();
  const lock = takeLauncherLock(administrator ? "admin start" : "start");

  if (!(await portIsFree(HOST, WEB_PORT))) {
    throw new Error(`Port ${WEB_PORT} on ${HOST} is in use by another process; nothing was changed.`);
  }

  await initialiseIfNeeded(binaries);
  await startCluster(binaries);

  let stopping = false;
  let site: ChildProcess | undefined;

  const shutdown = async (requestedExitCode: number): Promise<void> => {
    if (stopping) {
      return;
    }

    stopping = true;

    let exitCode = requestedExitCode;

    if (site !== undefined) {
      const outcome = await stopOwnedSite(site, { host: HOST, port: WEB_PORT, timeoutMs: SITE_STOP_TIMEOUT_MS });

      if (outcome === "did-not-exit") {
        say("The site process did not exit within the shutdown bound.");
        exitCode = 1;
      } else if (outcome === "port-still-in-use") {
        say(`The site exited, but port ${WEB_PORT} was not released within the shutdown bound; a site worker may still be running.`);
        exitCode = 1;
      }
    }

    try {
      await stopCluster(binaries);
    } catch (error) {
      say(error instanceof Error ? error.message : "PostgreSQL could not be confirmed stopped.");
      exitCode = 1;
    }

    lock.release();
    say(exitCode === 0 ? "Stopped." : "Shutdown finished with the problems reported above.");
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("message", (message) => {
    if (message === LAUNCHER_SHUTDOWN_MESSAGE) {
      void shutdown(0);
    }
  });

  try {
    if (!lock.stillOwned()) {
      throw new Error("The launcher lock is no longer this launcher's; nothing was reseeded.");
    }

    await prepareDatabase(readPassword());

    const administratorEnvironment = administrator
      ? administratorEnvironmentFor(ensureAdministratorKeys(ADMINISTRATOR_KEYS_FILE).keys, ADMIN_ORIGIN)
      : {};
    const httpsArguments = administrator ? httpsArgumentsFor(await ensureLocalCertificate(TLS_DIRECTORY)) : [];

    site = spawn(
      process.execPath,
      [
        "--import",
        new URL("./site-control.mjs", import.meta.url).href,
        require.resolve("next/dist/bin/next"),
        "dev",
        "--hostname",
        HOST,
        "--port",
        String(WEB_PORT),
        ...httpsArguments,
      ],
      {
        cwd: REPOSITORY_ROOT,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          [LOCAL_DEMO_DATABASE_URL]: connectionStringFor(DATABASE_NAME, readPassword()),
          [SITE_CONTROL_OWNER_ENV]: String(process.pid),
          ...administratorEnvironment,
        },
      },
    );
  } catch (error) {
    say(error instanceof Error ? error.message : "Preparing the local demo failed.");
    await shutdown(1);
    return;
  }

  site.once("error", () => {
    say("The site process could not be started.");
    void shutdown(1);
  });
  site.once("exit", (code) => void shutdown(code ?? 1));

  say(
    administrator
      ? `Open ${ADMIN_ORIGIN}/admin/sign-in (accept the local certificate warning once) — press Ctrl+C to stop the site and the database.`
      : `Open http://${HOST}:${WEB_PORT}/directory — press Ctrl+C to stop the site and the database.`,
  );
}

async function stop(): Promise<void> {
  if (!existsSync(DEMO_DIRECTORY)) {
    say("Nothing to stop.");
    return;
  }

  const binaries = await postgresBinaries();
  const lock = takeLauncherLock("stop");

  try {
    await stopCluster(binaries);
  } finally {
    lock.release();
  }

  say("Stopped.");
}

async function reset(): Promise<void> {
  if (!existsSync(DEMO_DIRECTORY)) {
    say("Nothing to reset.");
    return;
  }

  const binaries = await postgresBinaries();
  const lock = takeLauncherLock("reset");

  try {
    await stopCluster(binaries);

    const refusal = resetRefusalOf(await clusterStatus(binaries), await portIsFree(HOST, DATABASE_PORT), DATABASE_PORT);

    if (refusal !== undefined) {
      throw new Error(refusal);
    }

    rmSync(DEMO_DIRECTORY, { recursive: true, force: true });
  } finally {
    lock.release();
  }

  say("Removed .local-demo/.");
}

/**
 * `admin add`: provision one synthetic administrator (issue #260 §3.6). It runs only while the
 * demo is stopped, under the same lock: start the cluster on loopback, apply the governed
 * migrations (without reseeding listings), provision, and stop the cluster again.
 */
async function adminAdd(): Promise<void> {
  const terminal = processTerminal();
  // Refuse a non-interactive terminal or production mode before anything is started, migrated
  // or created: no lock, cluster, migration or keys file is touched on these refusals.
  const refusal = launchRefusalOf(terminal, process.env);

  if (refusal !== undefined) {
    terminal.say(INCOMPLETE_NOTICE);
    terminal.say(refusal.message);
    terminal.close();
    process.exitCode = 1;
    return;
  }

  const binaries = await postgresBinaries();
  const lock = takeLauncherLock("admin add");
  let exitCode = 0;

  try {
    await initialiseIfNeeded(binaries);
    await startCluster(binaries);

    try {
      await prepareDatabase(readPassword(), false);

      const { keys } = ensureAdministratorKeys(ADMINISTRATOR_KEYS_FILE);
      const databaseUrl = connectionStringFor(DATABASE_NAME, readPassword());
      const persistence = createListingPersistence({ pool: { connectionString: databaseUrl, max: 1 } });

      try {
        const result = await provisionSyntheticAdministrator(terminal, {
          // The storage module uses raw `sql`; only the row typing differs from the listing pool.
          db: persistence.db as unknown as Parameters<typeof provisionSyntheticAdministrator>[1]["db"],
          clock: Date.now,
          totpKey: keys.totpKey,
          environment: process.env,
          databaseUrl,
        });

        exitCode = result.ok ? 0 : 1;
      } finally {
        await persistence.shutdown();
      }
    } finally {
      await stopCluster(binaries);
    }
  } finally {
    lock.release();
    terminal.close();
  }

  process.exitCode = exitCode;
}

/**
 * `admin sessions | revoke | revoke-all | disable` (issue #270 RV-D1): like `add`, refused before
 * anything starts, then run with the demo stopped, under the launcher lock. It needs no keys.
 */
async function adminControl(subcommand: ControlSubcommand): Promise<void> {
  const terminal = processTerminal();
  const refusal = launchRefusalOf(terminal, process.env);

  if (refusal !== undefined) {
    terminal.say(refusal.message);
    terminal.close();
    process.exitCode = 1;
    return;
  }

  const binaries = await postgresBinaries();
  const lock = takeLauncherLock(`admin ${subcommand}`);
  let exitCode = 0;

  try {
    await initialiseIfNeeded(binaries);
    await startCluster(binaries);

    try {
      await prepareDatabase(readPassword(), false);

      const databaseUrl = connectionStringFor(DATABASE_NAME, readPassword());
      const persistence = createListingPersistence({ pool: { connectionString: databaseUrl, max: 1 } });

      try {
        const result = await controlSyntheticAdministrator(subcommand, terminal, {
          // The storage module uses raw `sql`; only the row typing differs from the listing pool.
          db: persistence.db as unknown as Parameters<typeof controlSyntheticAdministrator>[2]["db"],
          clock: Date.now,
          environment: process.env,
          databaseUrl,
        });

        exitCode = result.ok ? 0 : 1;
      } finally {
        await persistence.shutdown();
      }
    } finally {
      await stopCluster(binaries);
    }
  } finally {
    lock.release();
    terminal.close();
  }

  process.exitCode = exitCode;
}

async function admin(): Promise<void> {
  const subcommand = process.argv[3];

  if (subcommand === "start") {
    await startSite(true);
  } else if (subcommand === "add") {
    await adminAdd();
  } else if ((CONTROL_SUBCOMMANDS as readonly string[]).includes(subcommand ?? "")) {
    await adminControl(subcommand as ControlSubcommand);
  } else {
    say("Usage: local-demo.ts admin start | add | sessions | revoke | revoke-all | disable");
    process.exitCode = 1;
  }
}

const commands: Record<string, () => Promise<void>> = { start, stop, reset, admin };
const command = commands[process.argv[2] ?? "start"];

if (command === undefined) {
  say("Usage: local-demo.ts start | stop | reset | admin start | admin add | admin sessions | admin revoke | admin revoke-all | admin disable");
  process.exit(1);
}

command().catch((error: unknown) => {
  say(error instanceof Error ? error.message : "The local demo failed.");
  process.exit(1);
});
