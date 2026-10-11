/**
 * The one embedded-PostgreSQL lifecycle every database-backed test file uses (issue #179).
 *
 * **This module is test-only.** Nothing under `src/app`, and no production module, may import
 * it: it reaches `embedded-postgres`, which is a development dependency, and it starts a real
 * server. It lives under `src/data/testing/` so that boundary is structural rather than a
 * comment, and it is not exported from any production entry point.
 *
 * ## Why it exists
 *
 * Four test files each hand-rolled the same cluster lifecycle, and all four were wrong in the
 * same way. `EmbeddedPostgres.stop()` on Windows spawns `taskkill /pid <postmaster> /f /t`
 * **without awaiting it** and then waits only on the Node-level `'exit'` event of the *parent*
 * postmaster handle. The postmaster's `--forkchild` children — checkpointer, background writer,
 * walwriter, autovacuum launcher, logical replication launcher — are not Node children, so
 * nothing waits for them; `stop()` then immediately removes the data directory itself, racing
 * the operating system's release of those children's file handles. On a loaded machine the
 * children lose and `stop()` throws `EBUSY: rmdir`. Each test file caught that error, fell
 * through to a three-second removal retry, and on a bad run left a disposable cluster behind
 * and failed its own cleanup assertion.
 *
 * ## What this module guarantees instead
 *
 * Shutdown is requested **once** through the package's public API. The postmaster's identity is
 * then taken from PostgreSQL's own `postmaster.pid` — whose second line records the data
 * directory that process claims — and accepted **only** when that claim matches the directory
 * this helper created. Exit is then *observed*, never caused: `process.kill(pid, 0)` asks
 * whether the process exists and nothing else. Only once the owned postmaster is gone is the
 * owned temporary root removed, under a bounded retry over the transient Windows lock codes.
 *
 * **No process is ever signalled, killed or enumerated.** There is no `taskkill`, no `pg_ctl`,
 * no `wmic`, no `tasklist`, no shell, no process-name matching and no elevation anywhere in
 * this file. The PID is observational evidence; it is never a target. A PID that cannot be
 * proven to own this helper's directory is refused, and refusal authorizes no action at all.
 *
 * Cleanup never reports success while a known process or the owned directory remains, and a
 * cleanup failure fails the test file rather than being logged and forgiven. Diagnostics name
 * the stage, the owned PID, the owned path and the elapsed time — never a password and never a
 * connection string.
 *
 * `DG-4` testing depth remains Unresolved; this module settles no testing policy.
 */

import { afterAll, beforeAll } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createMigrationProvider } from "./../migrate";

/**
 * The narrow slice of `pg` this module uses.
 *
 * `pg` ships no type declarations and `@types/pg` is deliberately absent (`ADR-017`), so the
 * module is reached through an explicit runtime require and described here — the pattern
 * `migrate.ts` established and every database-backed test file already follows.
 */
interface PgModule {
  readonly Pool: new (config: { connectionString: string; max: number }) => PostgresPool & {
    end(): Promise<void>;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
}

const pg = createRequire(import.meta.url)("pg") as PgModule;

/**
 * Test-only credentials for a disposable cluster.
 *
 * Exported because a suite that asserts a credential never leaks must assert against the
 * credential actually in use — a locally restated copy would let the assertion pass while
 * testing nothing. They are never emitted in a diagnostic by this module.
 */
export const CLUSTER_USER = "postgres";
export const CLUSTER_PASSWORD = "verification-only";

const SERVER_USER = CLUSTER_USER;
const SERVER_PASSWORD = CLUSTER_PASSWORD;

/** Generous, because initialising a cluster is slow and flakiness is worse than waiting. */
export const CLUSTER_TIMEOUT_MS = 300_000;

/** How often the owned postmaster is observed, and for how long, before cleanup fails. */
export const EXIT_POLL_INTERVAL_MS = 100;
export const EXIT_WAIT_CEILING_MS = 30_000;

/** How often removal is retried, and for how long, before cleanup fails. */
export const REMOVE_RETRY_INTERVAL_MS = 200;
export const REMOVE_CEILING_MS = 30_000;

/**
 * Filesystem error codes that mean "Windows has not released a handle yet", and nothing more.
 *
 * Retrying anything else would retry a real error — a permissions mistake, a path bug — until a
 * deadline and then report the deadline instead of the cause.
 */
export const TRANSIENT_REMOVAL_CODES: readonly string[] = ["EBUSY", "EPERM", "ENOTEMPTY"];

/** The stage a cleanup had reached when it failed. Part of the diagnostic, never a credential. */
export type CleanupStage =
  | "resource-close"
  | "ownership-proof"
  | "stop-request"
  | "exit-wait"
  | "directory-removal"
  | "verify";

/** A cleanup that could not prove the cluster is gone. Always fails the test file. */
export class ClusterCleanupError extends Error {
  readonly stage: CleanupStage;
  readonly ownedPid: number | undefined;
  readonly ownedRoot: string;
  readonly elapsedMs: number;

  constructor(details: {
    stage: CleanupStage;
    ownedPid: number | undefined;
    ownedRoot: string;
    elapsedMs: number;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `embedded PostgreSQL cleanup failed at stage "${details.stage}" after ` +
        `${details.elapsedMs}ms: ${details.detail} ` +
        `(owned pid ${details.ownedPid ?? "unknown"}, owned root ${details.ownedRoot})`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );

    this.name = "ClusterCleanupError";
    this.stage = details.stage;
    this.ownedPid = details.ownedPid;
    this.ownedRoot = details.ownedRoot;
    this.elapsedMs = details.elapsedMs;
  }
}

/** What observing a PID established. `indeterminate` is not "gone". */
export type Presence = "present" | "exited" | "indeterminate";

/**
 * Ask the operating system whether a PID exists. **This sends no signal.**
 *
 * `process.kill(pid, 0)` performs the permission and existence check a signal would perform and
 * then delivers nothing — on Windows as on Linux. `ESRCH` is the only answer that proves
 * absence. `EPERM` means a process with that id exists but belongs to someone else, which does
 * not disprove existence and so must keep the caller waiting. Any other errno is a real failure
 * and is raised rather than guessed at.
 */
export function observePresence(pid: number): Presence {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    const code = (error as { code?: string }).code;

    if (code === "ESRCH") return "exited";
    if (code === "EPERM") return "indeterminate";

    throw error;
  }
}

/** The postmaster this helper owns, proven against the directory this helper created. */
export interface OwnedPostmaster {
  readonly pid: number;
  readonly claimedDirectory: string;
}

/**
 * Canonicalize a path for comparison.
 *
 * `postmaster.pid` records the data directory with forward slashes even on Windows, and the
 * operating system is case-insensitive there, so the two legitimate differences — separator and
 * case — are normalized away and nothing else is. `realpathSync` is attempted first so a
 * symlinked or short-form temporary directory still compares equal; a path that no longer
 * exists falls back to lexical resolution rather than failing the comparison outright.
 */
function canonicalize(path: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(path);
  } catch {
    canonical = resolve(path);
  }

  canonical = resolve(canonical);

  return platform() === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Read the owned cluster's `postmaster.pid` and prove the PID in it belongs to *this* cluster.
 *
 * Line 1 is the postmaster PID; line 2 is the data directory that postmaster claims. The claim
 * is what makes the PID safe to observe: a PID alone could be anything, and a process *name*
 * proves nothing at all. Missing, malformed, non-integer, non-positive or mismatched evidence
 * is refused, and a refusal authorizes no action — the caller treats it as a cleanup failure,
 * never as licence to go looking for the process some other way.
 */
export function proveOwnedPostmaster(
  clusterDirectory: string,
  readPidFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): OwnedPostmaster {
  const pidPath = join(clusterDirectory, "postmaster.pid");
  let contents: string;

  try {
    contents = readPidFile(pidPath);
  } catch (error) {
    throw new Error(`the owned cluster's postmaster.pid could not be read at ${pidPath}`, {
      cause: error,
    });
  }

  const lines = contents.split(/\r?\n/);
  const rawPid = (lines[0] ?? "").trim();
  const rawDirectory = (lines[1] ?? "").trim();

  if (!/^\d+$/.test(rawPid)) {
    throw new Error(
      `the owned cluster's postmaster.pid line 1 is not an integer PID: ${JSON.stringify(rawPid)}`,
    );
  }

  const pid = Number(rawPid);

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`the owned cluster's postmaster.pid line 1 is not a positive PID: ${rawPid}`);
  }

  if (rawDirectory === "") {
    throw new Error("the owned cluster's postmaster.pid line 2 claims no data directory");
  }

  if (canonicalize(rawDirectory) !== canonicalize(clusterDirectory)) {
    throw new Error(
      `the postmaster at pid ${pid} claims data directory ${rawDirectory}, which is not the ` +
        `directory this helper created (${clusterDirectory}); ownership is unproven and no ` +
        "process action is authorized",
    );
  }

  return { pid, claimedDirectory: rawDirectory };
}

/** The seams the helper's own attacking tests substitute. Production paths use the defaults. */
export interface LifecycleSeams {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly observe?: (pid: number) => Presence;
  readonly remove?: (path: string) => void;
  readonly exists?: (path: string) => boolean;
}

interface ResolvedSeams {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly observe: (pid: number) => Presence;
  readonly remove: (path: string) => void;
  readonly exists: (path: string) => boolean;
}

function resolveSeams(seams: LifecycleSeams = {}): ResolvedSeams {
  return {
    now: seams.now ?? (() => Date.now()),
    sleep: seams.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    observe: seams.observe ?? observePresence,
    remove: seams.remove ?? ((path) => rmSync(path, { recursive: true, force: true })),
    exists: seams.exists ?? ((path) => existsSync(path)),
  };
}

/**
 * Wait for an owned postmaster to exit, bounded.
 *
 * Nothing here hurries the process along; the wait is pure observation. A healthy shutdown is
 * measured in hundreds of milliseconds, so the ceiling is a diagnostic device rather than a
 * routine cost — and exhausting it is a failure, because a cleanup that gave up quietly is the
 * defect this module exists to remove. A recycled PID can therefore cost at most this wait: it
 * can never be acted upon.
 */
export async function waitForOwnedExit(
  pid: number,
  seams: LifecycleSeams = {},
): Promise<{ exited: boolean; elapsedMs: number; last: Presence }> {
  const { now, sleep, observe } = resolveSeams(seams);
  const started = now();
  let last: Presence = observe(pid);

  while (last !== "exited") {
    if (now() - started >= EXIT_WAIT_CEILING_MS) {
      return { exited: false, elapsedMs: now() - started, last };
    }

    await sleep(EXIT_POLL_INTERVAL_MS);
    last = observe(pid);
  }

  return { exited: true, elapsedMs: now() - started, last };
}

/** A removal attempt's outcome. A non-transient error is never retried. */
export interface RemovalOutcome {
  readonly removed: boolean;
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly lastError: unknown;
}

/** True when a filesystem error is a Windows handle-release lag and nothing more. */
export function isTransientRemovalError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;

  return code !== undefined && TRANSIENT_REMOVAL_CODES.includes(code);
}

/**
 * Remove the owned root, retrying only while Windows is still letting go of it.
 *
 * Absence is rechecked after a removal that reported success, because "no error" and "nothing
 * there" are different claims and only the second one is the guarantee.
 */
export async function removeOwnedRoot(
  root: string,
  seams: LifecycleSeams = {},
): Promise<RemovalOutcome> {
  const { now, sleep, remove, exists } = resolveSeams(seams);
  const started = now();
  let attempts = 0;
  let lastError: unknown;

  for (;;) {
    attempts += 1;

    try {
      remove(root);
      lastError = undefined;

      if (!exists(root)) {
        return { removed: true, elapsedMs: now() - started, attempts, lastError: undefined };
      }
    } catch (error) {
      lastError = error;

      if (!isTransientRemovalError(error)) {
        return { removed: false, elapsedMs: now() - started, attempts, lastError: error };
      }
    }

    if (now() - started >= REMOVE_CEILING_MS) {
      return { removed: !exists(root), elapsedMs: now() - started, attempts, lastError };
    }

    await sleep(REMOVE_RETRY_INTERVAL_MS);
  }
}

/** An ephemeral port the operating system confirms is free. */
export function freePort(): Promise<number> {
  return new Promise((accept, refuse) => {
    const probe = net.createServer();

    probe.once("error", refuse);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();

      if (address === null || typeof address === "string") {
        probe.close(() => refuse(new Error("No ephemeral port was assigned.")));
        return;
      }

      const { port } = address;
      probe.close((closeError) => (closeError ? refuse(closeError) : accept(port)));
    });
  });
}

/** What a test file asks for. One cluster, its databases, and optionally the real migration. */
export interface ClusterRequest {
  /** Names the disposable root (`cdp-<slug>-XXXXXX`), so a stray directory is attributable. */
  readonly slug: string;
  readonly databases: readonly string[];
  /** Databases the governed migration is applied to before the suite runs. */
  readonly migrate?: readonly string[];
  /** Test-only seams. Absent in every real suite. */
  readonly seams?: LifecycleSeams;
  /** Test-only: substitute the shutdown request, to attack its failure classification. */
  readonly requestStop?: (server: EmbeddedPostgres) => Promise<void>;
}

/**
 * One isolated cluster, as the owning test file sees it.
 *
 * There is no `EmbeddedPostgres` on this interface. A suite cannot reach the server handle, so
 * it cannot stop it, cannot remove its directory and cannot reorder teardown — which is the
 * whole point: the lifecycle is not something a caller can get wrong by forgetting a step.
 */
export interface EmbeddedCluster {
  readonly port: number;
  readonly dataRoot: string;
  readonly clusterDirectory: string;
  connectionStringFor(database: string): string;
  /**
   * Hand the helper a caller-created `Pool`, `Client` or `Kysely` to close **before** the
   * server is asked to stop. Registration, rather than a second `afterAll`, is what makes the
   * ordering a property of the helper instead of a property of hook-registration order.
   */
  closeBeforeShutdown(label: string, close: () => Promise<unknown>): void;
}

interface ClusterState {
  root: string;
  clusterDirectory: string;
  port: number;
  server: EmbeddedPostgres | undefined;
  started: boolean;
  owned: OwnedPostmaster | undefined;
  resources: { label: string; close: () => Promise<unknown> }[];
  stopRequested: boolean;
  settled: boolean;
}

/** Apply the governed migration to one database, through the real provider and `Migrator`. */
export async function applyGovernedMigration(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });

  // The same reason `connection.ts` handles this: an idle client killed by the server raises
  // the pool's `error` event, and an unhandled `EventEmitter` `error` throws.
  pool.on("error", () => {});

  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

  try {
    const { error, results } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();

    if (error !== undefined) {
      throw error instanceof Error
        ? error
        : new Error(`the governed migration failed: ${String(error)}`);
    }

    const failed = results?.filter((result) => result.status !== "Success") ?? [];

    if (failed.length > 0) {
      throw new Error(
        `the governed migration did not succeed for ${failed
          .map((result) => result.migrationName)
          .join(", ")}`,
      );
    }
  } finally {
    await db.destroy();
  }
}

function newState(slug: string): ClusterState {
  const root = mkdtempSync(join(tmpdir(), `cdp-${slug}-`));

  return {
    root,
    clusterDirectory: join(root, "cluster"),
    port: 0,
    server: undefined,
    started: false,
    owned: undefined,
    resources: [],
    stopRequested: false,
    settled: false,
  };
}

function handleFor(state: ClusterState): EmbeddedCluster {
  return {
    get port() {
      return state.port;
    },
    get dataRoot() {
      return state.root;
    },
    get clusterDirectory() {
      return state.clusterDirectory;
    },
    connectionStringFor(database: string): string {
      if (!state.started) {
        throw new Error(
          "the embedded cluster is not running; a connection string is only available " +
            "between startup and shutdown",
        );
      }

      return `postgresql://${SERVER_USER}:${SERVER_PASSWORD}@127.0.0.1:${state.port}/${database}`;
    },
    closeBeforeShutdown(label: string, close: () => Promise<unknown>): void {
      state.resources.push({ label, close });
    },
  };
}

/**
 * Start one cluster in an already-created state, on an ephemeral port, and prove what it owns.
 *
 * The state — and therefore the owned root — exists before this is called, so a failure part
 * way through startup still leaves the caller something to clean up.
 */
async function bringUp(state: ClusterState, request: ClusterRequest): Promise<EmbeddedCluster> {
  const cluster = handleFor(state);

  state.port = await freePort();
  state.server = new EmbeddedPostgres({
    databaseDir: state.clusterDirectory,
    port: state.port,
    user: SERVER_USER,
    password: SERVER_PASSWORD,
    persistent: false,
    // `C` keeps collation behaviour out of every comparison; no suite depends on one.
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    onLog: () => {},
    onError: () => {},
  });

  await state.server.initialise();
  await state.server.start();
  state.started = true;

  // Proven now, while the file exists: shutdown removes it, and an identity read afterwards
  // would be an identity guessed at.
  state.owned = proveOwnedPostmaster(state.clusterDirectory);

  for (const database of request.databases) {
    await state.server.createDatabase(database);
  }

  for (const database of request.migrate ?? []) {
    await applyGovernedMigration(cluster.connectionStringFor(database));
  }

  return cluster;
}

/** Bring a cluster up, cleaning up completely if startup fails part way through. */
async function startCluster(request: ClusterRequest): Promise<{
  state: ClusterState;
  cluster: EmbeddedCluster;
}> {
  const state = newState(request.slug);

  try {
    return { state, cluster: await bringUp(state, request) };
  } catch (setupError) {
    try {
      await cleanupCluster(state, request);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "cluster setup failed and the cleanup that followed it also failed; the first error is " +
          "the original failure",
      );
    }

    throw setupError;
  }
}

/**
 * Close the caller's resources, stop the server, wait for the owned process, remove the root,
 * and prove all of it. Throws `ClusterCleanupError` if it cannot.
 *
 * Safe to call twice: the second call finds nothing registered, nothing started and nothing on
 * disk, and touches nothing outside the owned root either time.
 */
export async function cleanupCluster(
  state: ClusterState,
  request: ClusterRequest = { slug: "unknown", databases: [] },
): Promise<void> {
  const seams = resolveSeams(request.seams);
  const started = seams.now();
  const failures: ClusterCleanupError[] = [];
  /** The one upstream failure that is reconsidered at the end rather than reported at once. */
  let transientStopFailure: ClusterCleanupError | undefined;

  const fail = (stage: CleanupStage, detail: string, cause?: unknown): void => {
    failures.push(
      new ClusterCleanupError({
        stage,
        ownedPid: state.owned?.pid,
        ownedRoot: state.root,
        elapsedMs: seams.now() - started,
        detail,
        cause,
      }),
    );
  };

  // 1. The caller's pools, clients and Kysely instances, newest first — all of them attempted
  //    even when one throws, and every failure kept rather than swallowed.
  const resources = state.resources.splice(0).reverse();

  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      fail("resource-close", `closing the caller's "${resource.label}" failed`, error);
    }
  }

  // 2. Ownership. Required only if a server was actually started: a setup failure before start
  //    leaves no postmaster to own, which is not a cleanup failure.
  if (state.started && state.owned === undefined) {
    try {
      state.owned = proveOwnedPostmaster(state.clusterDirectory);
    } catch (error) {
      fail("ownership-proof", "the owned postmaster could not be identified", error);
    }
  }

  // 3. One shutdown request, through the package's public API.
  if (state.server !== undefined && state.started && !state.stopRequested) {
    state.stopRequested = true;

    try {
      await (request.requestStop ?? ((server: EmbeddedPostgres) => server.stop()))(state.server);
    } catch (error) {
      // `stop()` removes the data directory itself, immediately, while the postmaster's
      // children may still hold handles on it. That specific failure — a transient lock on a
      // path inside the owned root — is the upstream defect this module compensates for, so it
      // is retained and reconsidered at the end rather than treated as fatal here. Any *other*
      // stop failure is a different fact and is never suppressed.
      const code = (error as { code?: string }).code;
      const path = (error as { path?: string }).path;
      const inOwnedRoot =
        typeof path === "string" && canonicalize(path).startsWith(canonicalize(state.root));

      if (isTransientRemovalError(error) && inOwnedRoot) {
        transientStopFailure = new ClusterCleanupError({
          stage: "stop-request",
          ownedPid: state.owned?.pid,
          ownedRoot: state.root,
          elapsedMs: seams.now() - started,
          detail:
            `the shutdown request's own directory removal reported ${code ?? "a lock"}; ` +
            "awaiting owned-process exit and removing the root here instead",
          cause: error,
        });
      } else {
        fail("stop-request", "the shutdown request failed", error);
      }
    }
  }

  // 4. Observe the owned postmaster until it is gone. Nothing is signalled.
  if (state.owned !== undefined) {
    try {
      const { exited, elapsedMs, last } = await waitForOwnedExit(state.owned.pid, request.seams);

      if (!exited) {
        fail(
          "exit-wait",
          `the owned postmaster was still ${last} after ${elapsedMs}ms; the ${EXIT_WAIT_CEILING_MS}ms ` +
            "ceiling was exhausted",
        );
      }
    } catch (error) {
      fail("exit-wait", "observing the owned postmaster failed", error);
    }
  }

  // 5. Remove only this helper's own root, and only now.
  const removal = await removeOwnedRoot(state.root, request.seams);

  if (!removal.removed) {
    fail(
      "directory-removal",
      isTransientRemovalError(removal.lastError)
        ? `the owned root was still locked after ${removal.elapsedMs}ms and ${removal.attempts} ` +
            "attempts"
        : `removing the owned root failed with a non-transient error after ${removal.attempts} ` +
            "attempt(s)",
      removal.lastError,
    );
  }

  // 6. Verify, rather than conclude. "No error" and "nothing left" are different claims.
  if (seams.exists(state.root)) {
    fail("verify", "the owned root still exists after cleanup reported success");
  }

  if (state.owned !== undefined && failures.length === 0) {
    const presence = seams.observe(state.owned.pid);

    if (presence !== "exited") {
      fail("verify", `the owned postmaster is still ${presence} after cleanup`);
    }
  }

  state.settled = true;
  state.started = false;
  state.server = undefined;

  if (failures.length === 0) {
    // The upstream `EBUSY` is only forgiven here, where the process is proven gone, the root is
    // proven removed and no residue remains.
    return;
  }

  const reported = transientStopFailure === undefined ? failures : [transientStopFailure, ...failures];

  throw reported.length === 1
    ? reported[0]
    : new AggregateError(reported, "embedded PostgreSQL cleanup failed; see the errors in order");
}

/**
 * The declaration a database-backed test file makes, once, at module scope.
 *
 * Calling it registers both halves of the lifecycle, so a suite cannot start a cluster without
 * also having arranged for it to be cleaned up and verified. The returned handle is live from
 * the moment `beforeAll` completes until `afterAll` begins.
 */
export function useEmbeddedPostgres(request: ClusterRequest): EmbeddedCluster {
  // The handle a suite holds is stable from module scope; the state behind it appears at
  // startup, so the suite needs no accessor indirection and no lifecycle knowledge.
  let state: ClusterState | undefined;
  const pending: { label: string; close: () => Promise<unknown> }[] = [];
  const live = (): ClusterState => {
    if (state === undefined) {
      throw new Error(
        "the embedded cluster is not running; it is available only between this file's " +
          "beforeAll and afterAll",
      );
    }

    return state;
  };

  const handle: EmbeddedCluster = {
    get port() {
      return live().port;
    },
    get dataRoot() {
      return live().root;
    },
    get clusterDirectory() {
      return live().clusterDirectory;
    },
    connectionStringFor: (database) => handleFor(live()).connectionStringFor(database),
    closeBeforeShutdown: (label, close) => {
      if (state === undefined) {
        pending.push({ label, close });
        return;
      }

      state.resources.push({ label, close });
    },
  };

  beforeAll(async () => {
    const started = await startCluster(request);

    started.state.resources.push(...pending.splice(0));
    state = started.state;
  }, CLUSTER_TIMEOUT_MS);

  afterAll(async () => {
    if (state === undefined) {
      // Startup failed and already cleaned up after itself; there is nothing left to own.
      return;
    }

    await cleanupCluster(state, request);
  }, CLUSTER_TIMEOUT_MS);

  return handle;
}

/**
 * One cluster for the duration of one callback — the form the helper's own attacking tests use.
 *
 * If the body fails **and** cleanup fails, both are reported through an `AggregateError` whose
 * **first** error is the body's. The original failure is what a reader is looking for; a noisy
 * teardown must never be what replaces it.
 */
export async function withEmbeddedPostgres<T>(
  request: ClusterRequest,
  body: (cluster: EmbeddedCluster) => Promise<T>,
): Promise<T> {
  const { state, cluster } = await startCluster(request);
  let bodyError: unknown;
  let threw = false;

  try {
    return await body(cluster);
  } catch (error) {
    threw = true;
    bodyError = error;
    throw error;
  } finally {
    try {
      await cleanupCluster(state, request);
    } catch (cleanupError) {
      if (!threw) {
        throw cleanupError;
      }

      throw new AggregateError(
        [bodyError, cleanupError],
        "the test body failed and cluster cleanup also failed; the first error is the original " +
          "failure",
      );
    }
  }
}

/**
 * Start a cluster whose cleanup the caller drives explicitly.
 *
 * Exposed for the helper's own tests, which must attack partial setup and repeated cleanup. A
 * suite uses `useEmbeddedPostgres` instead, precisely so that it has no opportunity to.
 */
export async function startClusterForTests(request: ClusterRequest): Promise<{
  state: ClusterState;
  cluster: EmbeddedCluster;
}> {
  return startCluster(request);
}

export type { ClusterState };
