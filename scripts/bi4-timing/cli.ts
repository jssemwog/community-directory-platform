/**
 * The command line for the `BI-4` timing pilot harness (issue #246; harness gate revision 5).
 *
 * Subcommands: `smoke`, `e1`, `e2`, `analyze`, `cleanup`, and `--help`. Every run-shaping input is
 * explicit — calibration delays, output directory, seed, background population and authorized
 * commit have **no defaults** (`H-D3`, `H-D9`, timing `T-D7`). Unknown flags are refused.
 *
 * **Every run needs its own explicit authorization** (`H-D10`): each smoke run, each full-pilot
 * replicate and each `cleanup --run`. Approving the harness authorizes none of them. `--help`
 * starts nothing; it also proves the harness and the cluster helper load outside the test runner.
 *
 * Nothing here applies a threshold or issues a verdict. `BI-4` stays pending.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import {
  CLUSTER_PASSWORD,
  CLUSTER_USER,
  freePort,
  proveOwnedPostmaster,
  withEmbeddedPostgres,
  type EmbeddedCluster,
} from "../../src/data/testing/embedded-cluster";
import { createListingPersistence } from "../../src/data/connection";
import { DEFAULT_ANALYSIS, medianOf, writeAnalysis, type MeasurementRecord, type RunManifest } from "./analyze";
import { loadFixtures, prepareStorage, storageSizes, verifyStoredStates } from "./fixtures";
import {
  adminRecordOf,
  buildDatabaseUrl,
  canonical,
  checkPreconditions,
  cleanupCommand,
  cleanupExitCode,
  CLUSTER_PARENT_PREFIX,
  createGitOps,
  createSignalAbortHandler,
  databaseUrlProblems,
  directoryEntries,
  driveSmoke,
  forcedPass,
  holdAtCheckpoint,
  helperClusterOps,
  installAbortOnSignals,
  IntentLog,
  isHarnessRoot,
  locateClusterRoot,
  measuredCheckpoint,
  outputDirectoryProblems,
  PERSONAL_DEMO_PORTS,
  portIsFree,
  ProcessInspectionError,
  projectionNeedsRuling,
  projectReplicateMs,
  recordDescendants,
  removeEmptyDirectory,
  residueOf,
  restrictedChanges,
  restrictedMetadataOf,
  runFile,
  SC_CHECKPOINT_TIMEOUT_MS,
  SC_READY_FILE,
  startOwnedProcess,
  startUnderParent,
  teardown,
  windowsProcessOps,
  type ForcedPassReport,
  type InProcessPassReport,
  type ReadyMarker,
  type RestrictedMetadata,
  type TeardownReport,
} from "./isolation";
import { liveIdentityOf, readInstalledNext, readLockfileEvidence, type NextVersionEvidence } from "./next-evidence";
import { runOperation } from "./run-operation";
import { runHttp, waitReady } from "./run-http";
import {
  buildPlan,
  countsOf,
  PHASE_CEILING_MINUTES,
  SMOKE_CAPS,
  TEARDOWN_ALLOWANCE_MINUTES,
  type Boundary,
  type Mode,
  type PlanIdentity,
} from "./schedule";
import { HEALTH_PATH } from "./calibration-server";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..", "..");
const REGISTER = join(REPOSITORY_ROOT, "scripts", "local-demo", "register.mjs");
const CLI = fileURLToPath(import.meta.url);
const CALIBRATION_SERVER = join(HERE, "calibration-server.ts");
const MINUTE = 60_000;

export const USAGE = `BI-4 timing pilot harness (issue #246). Every run needs its own explicit authorization.

  smoke   --boundary e1|e2 --out <abs dir> --seed <s> --delays-ns <a,b,c> --background <n> --commit <sha>
  e1      --replicate 1|2  --out <abs dir> --seed <s> --delays-ns <a,b,c> --background <n> --commit <sha>
  e2      --replicate 1|2  --out <abs dir> --seed <s> --delays-ns <a,b,c> --background <n> --commit <sha>
  analyze --run <run dir> --out <abs dir>
  cleanup --run <run dir>
  --help

No input has a default. The output directory must be absolute, existing, empty, outside the
repository and outside the system temp directory. Exactly three distinct calibration delays, in
nanoseconds. Results are exploratory or diagnostic; no threshold or verdict is applied.`;

const FLAGS: Readonly<Record<string, readonly string[]>> = {
  smoke: ["--boundary", "--out", "--seed", "--delays-ns", "--background", "--commit"],
  e1: ["--replicate", "--out", "--seed", "--delays-ns", "--background", "--commit", "--smoke-pass", "--request-cap", "--deadline"],
  e2: ["--replicate", "--out", "--seed", "--delays-ns", "--background", "--commit", "--smoke-pass", "--request-cap", "--deadline"],
  analyze: ["--run", "--out"],
  cleanup: ["--run"],
};

/** Internal flags, used only when the smoke driver spawns a forced-pass child. */
const INTERNAL_FLAGS = new Set(["--smoke-pass", "--request-cap", "--deadline"]);

export interface ParsedArguments {
  readonly command: string;
  readonly flags: Readonly<Record<string, string>>;
}

/** Strict parsing: a known subcommand, known flags only, each with a value, none repeated. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") return { command: "help", flags: {} };
  const allowed = FLAGS[command];
  if (allowed === undefined) throw new Error(`unknown subcommand ${command}`);

  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] as string;
    const value = rest[i + 1];
    if (!allowed.includes(flag)) throw new Error(`unknown flag ${flag} for ${command}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag in flags) throw new Error(`${flag} given twice`);
    flags[flag] = value;
  }

  const required = allowed.filter((flag) => !INTERNAL_FLAGS.has(flag));
  const missing = required.filter((flag) => !(flag in flags));
  if (missing.length > 0) throw new Error(`missing required ${missing.join(", ")}; no input has a default`);

  return { command, flags };
}

function delaysOf(text: string): number[] {
  return text.split(",").map((part) => {
    if (!/^\d+$/.test(part.trim())) throw new Error(`--delays-ns takes comma-separated integers; got ${JSON.stringify(part)}`);
    return Number(part);
  });
}

function backgroundOf(text: string): number {
  if (!/^\d+$/.test(text)) throw new Error("--background takes a non-negative integer");
  return Number(text);
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function environmentManifest(): Promise<Record<string, unknown>> {
  const capture = async (command: string, args: readonly string[]): Promise<string> => {
    try {
      return (await runFile(command, args)).stdout.trim();
    } catch {
      return "(not collected)";
    }
  };

  return {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "(unknown)",
    logicalCpus: cpus().length,
    powerPlan: await capture("powercfg", ["/getactivescheme"]),
    // Recorded as a noise source only; nothing is acted on.
    busiestProcesses: await capture("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU | ConvertTo-Json -Compress",
    ]),
  };
}

interface BoundaryOptions {
  readonly boundary: Boundary;
  readonly mode: Mode;
  readonly pass?: "S-A" | "S-B" | "S-C";
  readonly replicate?: number;
  readonly out: string;
  readonly seed: string;
  readonly delaysNs: readonly number[];
  readonly background: number;
  readonly commit: string;
  readonly requestCap: number;
  /** Absolute time (ms) at which the phase ceiling or smoke cap aborts the run. */
  readonly deadline: number;
}

interface BoundaryResult {
  readonly exitCode: number;
  readonly requests: number;
  /** Measured-phase requests only (warm-up excluded). */
  readonly measured: number;
  readonly invalid: readonly string[];
  readonly stoppedBy?: string;
  readonly teardown?: TeardownReport;
  readonly setupMs: number;
  readonly teardownMs: number;
  readonly records: readonly MeasurementRecord[];
}

/** One boundary replicate or one in-process smoke pass, from refusal checks to teardown. */
async function runBoundary(options: BoundaryOptions): Promise<BoundaryResult> {
  if (platform() !== "win32") throw new Error("the harness's process and cleanup operations are Windows-only");

  const git = createGitOps(REPOSITORY_ROOT);
  const processes = windowsProcessOps();
  const tempDirectory = tmpdir();
  const preconditions = await checkPreconditions({
    repositoryRoot: REPOSITORY_ROOT,
    tempDirectory,
    authorizedCommit: options.commit,
    outputDirectory: options.out,
    environment: process.env,
    portIsFree,
    gitHead: () => git.head(),
    gitStatusPorcelain: () => git.statusPorcelain(),
    directoryEntries,
    restrictedMetadata: () => restrictedMetadataOf(REPOSITORY_ROOT),
  });

  if (preconditions.refusals.length > 0) {
    for (const refusal of preconditions.refusals) say(`refused: ${refusal}`);
    return { exitCode: 2, requests: 0, measured: 0, invalid: preconditions.refusals, setupMs: 0, teardownMs: 0, records: [] };
  }

  const restrictedBaseline = preconditions.restrictedBaseline as RestrictedMetadata;
  const plan = buildPlan({ boundary: options.boundary, mode: options.mode, seed: options.seed, delaysNs: options.delaysNs, background: options.background });
  const log = new IntentLog(join(options.out, "run-state.json"));
  const controller = new AbortController();
  // One shared handler for the real signal listeners and S-B's simulated SIGINT.
  const abortOn = createSignalAbortHandler(controller, (message) => log.note(message));
  const uninstall = installAbortOnSignals(controller, undefined, (message) => log.note(message), abortOn);
  const invalid: string[] = [];
  const records: MeasurementRecord[] = [];
  const requestsFd = openSync(join(options.out, "requests.ndjson"), "a");
  const ceiling = setTimeout(() => controller.abort(new Error("timeout")), Math.max(0, options.deadline - Date.now()));
  const startedAt = new Date();
  let manifest: RunManifest = {
    mode: options.mode,
    boundary: options.boundary,
    ...(options.pass === undefined ? {} : { pass: options.pass }),
    ...(options.replicate === undefined ? {} : { replicate: options.replicate }),
    seed: options.seed,
    delaysNs: plan.delaysNs,
    backgroundCount: plan.background.length,
    commit: options.commit,
    identities: plan.identities,
    startedAt: startedAt.toISOString(),
    environment: { ...(await environmentManifest()), counts: countsOf(plan) },
    invalid,
  };
  const writeManifest = (): void => writeFileSync(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  let stoppedBy: string | undefined;
  let teardownReport: TeardownReport | undefined;
  let setupMs = 0;
  let teardownStartedAt = 0;

  writeManifest();

  const onRecord = (record: MeasurementRecord): void => {
    writeSync(requestsFd, `${JSON.stringify(record)}\n`);
    records.push(record);
  };
  const onMeasured = (count: number): void | Promise<void> => {
    if (options.mode === "smoke") writeFileSync(join(options.out, "progress.json"), `${JSON.stringify({ measured: count })}\n`);
    // S-B: a direct call to the shared handler, never process.emit("SIGINT"). S-C: the checkpoint.
    return measuredCheckpoint(options.pass, count, { abort: abortOn, hold: holdForParent });
  };
  /** S-C: publish the ready marker and send nothing more until the parent acts or the bound passes. */
  const holdForParent = async (count: number): Promise<void> => {
    const identity = await processes.inspect(process.pid).catch(() => undefined);
    const outcome = await holdAtCheckpoint(
      { pid: process.pid, measured: count, ...(identity === undefined ? {} : { identity }) },
      {
        publish: (marker) => {
          // Written then renamed, so the parent never reads a partial marker.
          const path = join(options.out, SC_READY_FILE);
          writeFileSync(`${path}.tmp`, `${JSON.stringify(marker)}\n`);
          renameSync(`${path}.tmp`, path);
        },
        sleep: (ms) => new Promise((resume) => setTimeout(resume, ms)),
        now: Date.now,
        timeoutMs: Math.max(0, Math.min(SC_CHECKPOINT_TIMEOUT_MS, options.deadline - Date.now())),
        signal: controller.signal,
      },
    );
    if (outcome === "timeout") controller.abort(new Error("S-C checkpoint timeout: the parent did not terminate the harness"));
  };

  const slug = `bi4-${options.mode === "smoke" ? "smoke-" : ""}${options.boundary}`;
  // The run-specific parent is recorded, then created, before the helper is called. The helper's
  // root is created inside it, and its exact path is recorded before the server is initialised.
  const clusterParent = join(tempDirectory, `${CLUSTER_PARENT_PREFIX}${randomBytes(6).toString("hex")}`);
  const clusterEntry = log.intend("cluster", slug, { parent: clusterParent });
  const setupStart = Date.now();
  let recordedRoot: string | undefined;

  try {
    if (!isHarnessRoot(clusterParent, tempDirectory)) throw new Error("internal: the cluster parent is not a harness root");
    mkdirSync(clusterParent, { recursive: false });

    let locationProblem: string | undefined;
    const running = startUnderParent(clusterParent, () =>
      withEmbeddedPostgres({ slug, databases: ["bi4_timing"], migrate: ["bi4_timing"] }, async (cluster) => {
        if (locationProblem !== undefined) throw new Error(`the cluster root was not created in the recorded location: ${locationProblem}`);
        if (canonical(cluster.dataRoot) !== canonical(recordedRoot as string) || canonical(cluster.clusterDirectory) !== canonical(join(recordedRoot as string, "cluster"))) {
          throw new Error("the helper's cluster root is not the recorded run-specific root");
        }
        return clusterBody(cluster);
      }),
    );
    // Synchronous with the call above: the helper has created its root and has not yet awaited.
    const located = locateClusterRoot(clusterParent, slug);
    if ("path" in located) {
      recordedRoot = located.path;
      log.update(clusterEntry, { state: "created", path: located.path, clusterDirectory: join(located.path, "cluster") });
    } else {
      locationProblem = located.problem;
      log.note(`cluster location refused: ${located.problem}`, clusterEntry);
    }
    await running;

    // The helper removed its own root; remove the now-empty parent, never recursively.
    if (recordedRoot !== undefined && existsSync(recordedRoot)) log.update(clusterEntry, { state: "left", reason: "the helper reported success but its root still exists" });
    else if (removeEmptyDirectory(clusterParent)) log.update(clusterEntry, { state: "removed" });
    else log.update(clusterEntry, { state: "left", reason: "the cluster parent was not empty or could not be removed" });
  } catch (error) {
    invalid.push(`Invalid (setup or run): ${(error as Error).message}`);
    log.note(`run failed: ${(error as Error).message}`);

    // Unless cleanup also failed (an AggregateError), the helper has already removed its own root,
    // so only the empty parent can remain. Otherwise the entry stays open for `cleanup`.
    if (!(error instanceof AggregateError) && (recordedRoot === undefined || !existsSync(recordedRoot))) {
      if (!existsSync(clusterParent)) log.update(clusterEntry, { state: "absent", reason: "the cluster parent was never created" });
      else if (removeEmptyDirectory(clusterParent)) log.update(clusterEntry, { state: "removed", reason: "the helper cleaned up after itself; the empty parent was removed" });
      else log.update(clusterEntry, { state: "left", reason: "the cluster parent was not empty after the helper's cleanup" });
    }
  } finally {
    clearTimeout(ceiling);
    uninstall();
    closeSync(requestsFd);
  }

  async function clusterBody(cluster: EmbeddedCluster): Promise<void> {
    const owned = proveOwnedPostmaster(cluster.clusterDirectory);
    const postmaster = await processes.inspect(owned.pid);
    log.update(clusterEntry, {
      state: "created",
      path: cluster.dataRoot,
      clusterDirectory: cluster.clusterDirectory,
      port: cluster.port,
      ...(postmaster === undefined ? {} : { postmaster }),
    });

    if (PERSONAL_DEMO_PORTS.includes(cluster.port)) throw new Error("the cluster port is a personal-demo port");

    const url = buildDatabaseUrl({ user: CLUSTER_USER, password: CLUSTER_PASSWORD, port: cluster.port });
    const urlProblems = databaseUrlProblems(url, { port: cluster.port, clusterDirectory: cluster.clusterDirectory });
    if (urlProblems.length > 0) throw new Error(`database URL refused: ${urlProblems.join("; ")}`);

    const persistence = createListingPersistence({ pool: { connectionString: url, max: 2 } });
    cluster.closeBeforeShutdown("harness pool", () => persistence.shutdown());

    await loadFixtures(persistence.db, plan);
    const before = await verifyStoredStates(persistence.db, plan);
    if (before.length > 0) throw new Error(`stored-state verification failed: ${before.join("; ")}`);
    await prepareStorage(persistence.db);
    manifest = { ...manifest, environment: { ...manifest.environment, storage: await storageSizes(persistence.db), autovacuumListing: false } };
    writeManifest();

    const control = { signal: controller.signal, requestCap: options.requestCap, onRecord, onMeasured };

    try {
      if (options.boundary === "e1") {
        setupMs = Date.now() - setupStart;
        const outcome = await runOperation(plan, persistence.db, control);
        stoppedBy = outcome.stoppedBy;
      } else {
        const recordNextEvidence = (evidence: NextVersionEvidence): void => {
          manifest = { ...manifest, nextEvidence: evidence };
          writeManifest();
        };
        const outcome = await runE2(plan, url, options, log, processes, git, control, (ms) => (setupMs = ms), setupStart, recordNextEvidence);
        stoppedBy = outcome.stoppedBy;
      }
    } finally {
      teardownStartedAt = Date.now();
      teardownReport = await teardown({
        log,
        processes,
        git,
        clusters: helperClusterOps,
        tempDirectory,
        repositoryGitDirectory: join(REPOSITORY_ROOT, ".git"),
        includeClusters: false,
        deadline: Date.now() + TEARDOWN_ALLOWANCE_MINUTES * MINUTE,
      });
    }

    const after = await verifyStoredStates(persistence.db, plan);
    if (after.length > 0) invalid.push(`Invalid (stored state): ${after.join("; ")}`);
  }

  const changed = restrictedChanges(restrictedBaseline, restrictedMetadataOf(REPOSITORY_ROOT));
  if (changed.length > 0) invalid.push(`Invalid (file safety): restricted-file metadata changed for ${changed.join(", ")}`);
  if (controller.signal.aborted) {
    const reason = (controller.signal.reason as Error | undefined)?.message ?? "abort";
    stoppedBy = reason === "timeout" ? "timeout" : stoppedBy ?? "abort";
    invalid.push(reason === "timeout" ? (options.mode === "smoke" ? "Failed (cap): smoke time cap reached" : "Invalid (timeout)") : `Aborted: ${reason}`);
  }
  if (stoppedBy === "cap") invalid.push("Failed (cap): smoke request cap reached");

  const leftover = teardownReport?.left ?? [];
  if (leftover.length > 0 || log.entries().some((entry) => entry.state === "left" || entry.state === "created" || entry.state === "intended")) {
    invalid.push(teardownReport?.allowanceExhausted ? "Invalid (timeout, cleanup incomplete)" : "Invalid (cleanup)");
    say(`Resources were left in place. Recovery needs its own authorization: ${cleanupCommand(options.out)}`);
  }

  manifest = { ...manifest, endedAt: new Date().toISOString(), invalid };
  writeManifest();

  return {
    exitCode: invalid.length === 0 ? 0 : 1,
    requests: records.length,
    measured: records.filter((record) => record.phase === "measured").length,
    invalid,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    ...(teardownReport === undefined ? {} : { teardown: teardownReport }),
    setupMs,
    teardownMs: teardownStartedAt === 0 ? 0 : Date.now() - teardownStartedAt,
    records,
  };
}

/** Run a collection step; a failure leaves the field absent, and the version guard then withholds. */
function collected<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** File reads for the Next.js evidence: exact bytes, and real paths that follow links. */
const NEXT_EVIDENCE_FILES = { readFile: (path: string) => readFileSync(path), realpath: (path: string) => realpathSync.native(path) };

/**
 * E2 setup inside the cluster body: root, worktree, `npm ci`, `next dev`, calibration server.
 * Records the Next.js version evidence (amendment §4.2–4.3) through `recordNextEvidence`.
 */
async function runE2(
  plan: ReturnType<typeof buildPlan>,
  url: string,
  options: BoundaryOptions,
  log: IntentLog,
  processes: ReturnType<typeof windowsProcessOps>,
  git: ReturnType<typeof createGitOps>,
  control: Parameters<typeof runHttp>[2],
  setSetupMs: (ms: number) => void,
  setupStart: number,
  recordNextEvidence: (evidence: NextVersionEvidence) => void,
): ReturnType<typeof runHttp> {
  // The root's exact path is recorded before it is created.
  const root = join(tmpdir(), `cdp-bi4-http-${randomBytes(6).toString("hex")}`);
  if (!isHarnessRoot(root, tmpdir())) throw new Error("internal: the HTTP root is not a harness root");
  const rootEntry = log.intend("harness-root", "http root", { path: root });
  mkdirSync(root, { recursive: false });
  log.update(rootEntry, { state: "created" });

  const worktree = join(root, "worktree");
  const worktreeEntry = log.intend("worktree", "worktree", { path: worktree, commit: options.commit });
  await git.addDetachedWorktree(worktree, options.commit);
  const adminRecord = adminRecordOf(readFileSync(join(worktree, ".git"), "utf8"));
  log.update(worktreeEntry, { state: "created", ...(adminRecord === undefined ? {} : { adminRecord }) });
  const listed = (await git.worktreeList()).find((entry) => resolve(entry.path).toLowerCase() === resolve(worktree).toLowerCase());
  if (listed?.head !== options.commit || !listed.detached) throw new Error("the disposable worktree is not detached at the authorized commit");

  // The lockfile comes from the run commit's object; the worktree's copy is hashed before `npm ci`.
  let evidence: NextVersionEvidence = {
    runCommit: options.commit,
    ...optional("worktreePath", collected(() => realpathSync.native(worktree))),
    ...optional("worktreeHead", collected(() => execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())),
    ...optional(
      "lockfile",
      readLockfileEvidence(
        options.commit,
        {
          show: (spec) => execFileSync("git", ["-C", REPOSITORY_ROOT, "show", spec], { maxBuffer: 256 * 1024 * 1024 }),
          blobId: (spec) => execFileSync("git", ["-C", REPOSITORY_ROOT, "rev-parse", spec], { encoding: "utf8" }),
        },
        () => readFileSync(join(worktree, "package-lock.json")),
      ),
    ),
  };
  recordNextEvidence(evidence);

  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error("Invalid (setup): npm-cli.js was not found beside the running node");
  const npm = await startOwnedProcess(log, processes, {
    label: "npm ci",
    command: process.execPath,
    args: [npmCli, "ci", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts"],
    cwd: worktree,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdoutPath: join(options.out, "npm-ci.out.log"),
    stderrPath: join(options.out, "npm-ci.err.log"),
  });
  const npmExit = await new Promise<number | null>((done) => npm.child.once("exit", (code) => done(code)));
  if (npmExit !== 0) throw new Error(`Invalid (setup): npm ci exited ${npmExit}`);
  log.update(npm.entry, { state: "absent", reason: "exited after completing" });

  const nextPort = await freePort();
  const calibrationPort = await freePort();
  if (PERSONAL_DEMO_PORTS.includes(nextPort) || PERSONAL_DEMO_PORTS.includes(calibrationPort)) throw new Error("a harness port is a personal-demo port");

  const allow = (name: string): Record<string, string> => {
    const value = process.env[name];
    return value === undefined ? {} : { [name]: value };
  };
  // Pre-start: the installed package manifest, after `npm ci` and before `next dev` starts.
  evidence = { ...evidence, ...optional("installedBeforeStart", readInstalledNext(worktree, NEXT_EVIDENCE_FILES)) };
  recordNextEvidence(evidence);

  const nextEntry = join(worktree, "node_modules", "next", "dist", "bin", "next");
  const next = await startOwnedProcess(log, processes, {
    label: "next dev",
    command: process.execPath,
    args: [nextEntry, "dev", "--hostname", "127.0.0.1", "--port", String(nextPort)],
    cwd: worktree,
    env: { ...allow("PATH"), ...allow("SystemRoot"), ...allow("TEMP"), ...allow("TMP"), NEXT_TELEMETRY_DISABLED: "1", LOCAL_DEMO_DATABASE_URL: url },
    port: nextPort,
    stdoutPath: join(options.out, "next-dev.out.log"),
    stderrPath: join(options.out, "next-dev.err.log"),
  });
  // Launch: the exact entry script and the identity the operating system recorded for it.
  const launched = log.entries()[next.entry]?.identity;
  if (launched !== undefined && launched.commandLine !== null && launched.commandLine !== "") {
    evidence = {
      ...evidence,
      launch: {
        nodeExecutable: process.execPath,
        entryPath: nextEntry,
        port: nextPort,
        pid: launched.pid,
        creationTime: launched.creationTime,
        commandLine: launched.commandLine,
      },
    };
    recordNextEvidence(evidence);
  }
  const calibration = await startOwnedProcess(log, processes, {
    label: "calibration server",
    command: process.execPath,
    args: ["--no-warnings", "--experimental-transform-types", "--import", pathToFileURL(REGISTER).href, CALIBRATION_SERVER, "--port", String(calibrationPort), "--delays-ns", plan.delaysNs.join(",")],
    cwd: root,
    env: { ...allow("PATH"), ...allow("SystemRoot"), ...allow("TEMP"), ...allow("TMP") },
    port: calibrationPort,
    stdoutPath: join(options.out, "calibration.out.log"),
    stderrPath: join(options.out, "calibration.err.log"),
  });

  const compile = plan.identities.find((identity) => identity.cls === "CMP") as PlanIdentity;
  await waitReady(nextPort, `/directory/${compile.key}`, (exchange) => exchange.status === 200 && exchange.body.includes("<h1>Not available</h1>"), 5 * MINUTE, control.signal);
  await waitReady(calibrationPort, HEALTH_PATH, (exchange) => exchange.status === 200, 30_000, control.signal);
  await recordDescendants(log, processes, next.entry, nextPort);
  await recordDescendants(log, processes, calibration.entry, calibrationPort);
  setSetupMs(Date.now() - setupStart);

  const outcome = await runHttp(plan, { nextPort, calibrationPort, bodiesDirectory: join(options.out, "bodies") }, control);

  // Post-measurement, before teardown: only when every measured request completed.
  if (outcome.stoppedBy === undefined) {
    const after = readInstalledNext(worktree, NEXT_EVIDENCE_FILES);
    if (after !== undefined) {
      const pid = evidence.launch?.pid ?? log.entries()[next.entry]?.identity?.pid;
      const live = pid === undefined ? undefined : liveIdentityOf(await processes.inspect(pid).catch(() => undefined));
      evidence = { ...evidence, installedAfterMeasured: { ...after, ...(live === undefined ? {} : { liveIdentity: live }) } };
      recordNextEvidence(evidence);
    }
  }

  return outcome;
}

/** `{ [key]: value }` when the value is present, otherwise nothing: absence is recorded as absence. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** `cleanup --run <out>`: replay the intent log and apply §9.2 to every resource. */
async function cleanupRun(runDirectory: string): Promise<TeardownReport> {
  const statePath = join(runDirectory, "run-state.json");
  if (!existsSync(statePath)) throw new Error(`no run-state.json in ${runDirectory}`);

  return teardown({
    log: new IntentLog(statePath),
    processes: windowsProcessOps(),
    git: createGitOps(REPOSITORY_ROOT),
    clusters: helperClusterOps,
    tempDirectory: tmpdir(),
    repositoryGitDirectory: join(REPOSITORY_ROOT, ".git"),
    includeClusters: true,
    deadline: Date.now() + TEARDOWN_ALLOWANCE_MINUTES * MINUTE,
  });
}

function medianRequestMs(records: readonly MeasurementRecord[]): Partial<Record<"operation" | "next" | "calibration", number>> {
  const result: Partial<Record<"operation" | "next" | "calibration", number>> = {};
  for (const target of ["operation", "next", "calibration"] as const) {
    const values = records
      .filter((record) => record.target === target)
      .flatMap((record) =>
        record.elapsedNs !== undefined
          ? [Number(record.elapsedNs) / 1e6]
          : record.writeStartMs !== undefined && record.responseEndMs !== undefined
            ? [record.responseEndMs - record.writeStartMs]
            : [],
      );
    if (values.length > 0) result[target] = medianOf(values);
  }
  return result;
}

/** The three smoke passes of one boundary (§5): operational checks only. */
async function smoke(flags: Readonly<Record<string, string>>): Promise<number> {
  const boundary = flags["--boundary"] as Boundary;
  if (boundary !== "e1" && boundary !== "e2") throw new Error("--boundary must be e1 or e2");
  if (platform() !== "win32") throw new Error("the harness's process and cleanup operations are Windows-only");

  const out = flags["--out"] as string;
  const caps = SMOKE_CAPS[boundary];
  const deadline = Date.now() + caps.minutes * MINUTE;
  const git = createGitOps(REPOSITORY_ROOT);
  const processes = windowsProcessOps();
  const base = {
    boundary,
    mode: "smoke" as const,
    seed: flags["--seed"] as string,
    delaysNs: delaysOf(flags["--delays-ns"] as string),
    background: backgroundOf(flags["--background"] as string),
    commit: flags["--commit"] as string,
  };
  const top = await checkPreconditions({
    repositoryRoot: REPOSITORY_ROOT,
    tempDirectory: tmpdir(),
    authorizedCommit: base.commit,
    outputDirectory: out,
    environment: process.env,
    portIsFree,
    gitHead: () => git.head(),
    gitStatusPorcelain: () => git.statusPorcelain(),
    directoryEntries,
    restrictedMetadata: () => restrictedMetadataOf(REPOSITORY_ROOT),
  });
  if (top.refusals.length > 0) {
    for (const refusal of top.refusals) say(`refused: ${refusal}`);
    return 2;
  }

  const residueSeams = {
    processes,
    git,
    repositoryRoot: REPOSITORY_ROOT,
    repositoryGitDirectory: join(REPOSITORY_ROOT, ".git"),
    restrictedBaseline: top.restrictedBaseline as RestrictedMetadata,
    statusBaseline: top.statusBaseline as string,
    portIsFree,
  };
  const report: Record<string, unknown> = { boundary, caps, mode: "smoke", note: "Operational checks only. No timing statistic, comparison, lead or finding." };
  const reportPath = join(out, "smoke-report.json");
  const writeReport = (current: Readonly<Record<string, unknown>>): void => writeFileSync(reportPath, `${JSON.stringify(current, null, 2)}\n`);
  const measuredIn = (passOut: string): { requests: number; measured: number } => {
    if (!existsSync(join(passOut, "requests.ndjson"))) return { requests: 0, measured: 0 };
    const lines = readFileSync(join(passOut, "requests.ndjson"), "utf8").split("\n").filter((line) => line.trim() !== "");
    return { requests: lines.length, measured: lines.filter((line) => (JSON.parse(line) as MeasurementRecord).phase === "measured").length };
  };

  const runInProcess = async (pass: "S-A" | "S-B", requestCap: number): Promise<InProcessPassReport> => {
    const passOut = join(out, pass);
    mkdirSync(passOut);
    const result = await runBoundary({ ...base, pass, out: passOut, requestCap, deadline });
    return {
      exitCode: result.exitCode,
      requests: result.requests,
      measured: result.measured,
      stoppedBy: result.stoppedBy ?? null,
      invalid: result.invalid,
      residue: await residueOf(new IntentLog(join(passOut, "run-state.json")).entries(), residueSeams),
      captured: result.records.slice(0, 1),
      setupMs: result.setupMs,
      teardownMs: result.teardownMs,
      medianRequestMs: medianRequestMs(result.records),
    };
  };

  const runForced = async (requestCap: number): Promise<ForcedPassReport> => {
    const passOut = join(out, "S-C");
    mkdirSync(passOut);
    let child: ReturnType<typeof spawn> | undefined;
    let forced: ForcedPassReport | undefined;

    try {
      const result = await forcedPass({
        boundary,
        processes,
        git,
        spawnHarness: async () => {
          const stdout = openSync(join(out, "S-C.harness.out.log"), "a");
          const stderr = openSync(join(out, "S-C.harness.err.log"), "a");
          child = spawn(
            process.execPath,
            [
              "--no-warnings",
              "--experimental-transform-types",
              "--import",
              pathToFileURL(REGISTER).href,
              CLI,
              boundary,
              "--replicate", "1",
              "--out", passOut,
              "--seed", base.seed,
              "--delays-ns", base.delaysNs.join(","),
              "--background", String(base.background),
              "--commit", base.commit,
              "--smoke-pass", "S-C",
              "--request-cap", String(Math.max(0, requestCap)),
              "--deadline", String(deadline),
            ],
            { cwd: REPOSITORY_ROOT, shell: false, windowsHide: true, stdio: ["ignore", stdout, stderr] },
          );
          closeSync(stdout);
          closeSync(stderr);
          if (child.pid === undefined) throw new Error("the forced-pass harness could not be started");
          return { pid: child.pid };
        },
        waitForReady: async () => {
          const until = Math.min(deadline, Date.now() + SC_CHECKPOINT_TIMEOUT_MS + 5 * MINUTE);
          while (Date.now() < until) {
            if (child?.exitCode !== null && child?.exitCode !== undefined) return undefined;
            try {
              return JSON.parse(readFileSync(join(passOut, SC_READY_FILE), "utf8")) as ReadyMarker;
            } catch {
              // Not published yet.
            }
            await new Promise((resume) => setTimeout(resume, 50));
          }
          return undefined;
        },
        waitGone: async (pid) => {
          // Gone only on a successful lookup that finds nothing. A failed lookup is not absence,
          // so it counts as "not yet confirmed gone"; when the bound passes, cleanup is not started.
          for (let i = 0; i < 100; i += 1) {
            const found = await processes.inspect(pid).then(
              (identity) => (identity === undefined ? "gone" : "present"),
              (error: unknown) => {
                if (error instanceof ProcessInspectionError) return "unknown";
                throw error;
              },
            );
            if (found === "gone") return true;
            await new Promise((resume) => setTimeout(resume, 100));
          }
          return false;
        },
        loadLog: () => new IntentLog(join(passOut, "run-state.json")),
        cleanup: () => cleanupRun(passOut),
      });
      forced = { ...result, ...measuredIn(passOut), residue: [] };
    } catch (error) {
      // Nothing was killed. The child was given the same deadline, so its own teardown runs. Wait
      // for it to exit, within its teardown allowance, before measuring residue.
      const running = child;
      if (running !== undefined && running.exitCode === null) {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, (TEARDOWN_ALLOWANCE_MINUTES + 1) * MINUTE);
          running.once("exit", () => (clearTimeout(timer), done()));
        });
      }
      forced = { status: "refused", reason: `the forced pass did not complete and nothing was killed: ${(error as Error).message}`, ...measuredIn(passOut), residue: [] };
    }

    return { ...forced, residue: await residueOf(new IntentLog(join(passOut, "run-state.json")).entries(), residueSeams) };
  };

  const outcome = await driveSmoke({ requestCap: caps.requests, deadline, runInProcess, runForced, writeReport }, report);

  // The §5.5 projection, only from a passed S-A. It is runtime planning, never timing evidence.
  const sa = report["S-A"] as { status: string; setupMs: number; teardownMs: number; medianRequestMs: Record<string, number> } | undefined;
  if (sa?.status === "passed") {
    const full = countsOf(buildPlan({ ...base, mode: "full" })).byTarget;
    const projectedMs = projectReplicateMs({ setupMs: sa.setupMs, teardownMs: sa.teardownMs, medianRequestMs: sa.medianRequestMs }, full);
    report.projection = {
      purpose: "runtime planning only; never timing evidence",
      projectedReplicateMinutes: projectedMs / MINUTE,
      ceilingMinutes: PHASE_CEILING_MINUTES[boundary],
      needsOwnerRuling: projectionNeedsRuling(projectedMs, PHASE_CEILING_MINUTES[boundary]),
    };
    writeReport(report);
  }

  for (const pass of ["S-A", "S-B", "S-C"] as const) say(`${pass}: ${outcome.verdicts[pass].status}${outcome.verdicts[pass].reasons.length === 0 ? "" : ` — ${outcome.verdicts[pass].reasons.join("; ")}`}`);
  say(`smoke report written to ${reportPath}`);
  return outcome.exitCode;
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArguments(argv);

  if (command === "help") {
    say(USAGE);
    return 0;
  }

  if (command === "cleanup") {
    const report = await cleanupRun(resolve(flags["--run"] as string));
    say(JSON.stringify(report, null, 2));
    return cleanupExitCode(report);
  }

  if (command === "analyze") {
    const run = resolve(flags["--run"] as string);
    const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8")) as RunManifest;
    const out = flags["--out"] as string;
    const problems = outputDirectoryProblems(out, { repositoryRoot: REPOSITORY_ROOT, tempDirectory: tmpdir(), directoryEntries });
    if (problems.length > 0) throw new Error(`refused: ${problems.join("; ")}`);
    const report = writeAnalysis(run, out, { ...DEFAULT_ANALYSIS, seed: manifest.seed, deadline: Date.now() + PHASE_CEILING_MINUTES.analysis * MINUTE });
    if (report.status === "incomplete") {
      say(
        `analysis INCOMPLETE: ${report.incomplete?.reason ?? "the cooperative analysis deadline was reached"} during ${report.incomplete?.during ?? "the analysis"}. ` +
          `Partial output only, in ${join(out, "incomplete")}; no completed report was written.`,
      );
      return 1;
    }
    say(`analysis written to ${out}: ${report.invalid.length} Invalid condition(s), ${report.withheld.length} withheld label(s)`);
    return 0;
  }

  if (command === "smoke") return smoke(flags);

  const boundary = command as Boundary;
  const pass = flags["--smoke-pass"];
  if (pass !== undefined && pass !== "S-C") throw new Error("--smoke-pass is internal and accepts only S-C");
  const replicate = Number(flags["--replicate"]);
  if (pass === undefined && replicate !== 1 && replicate !== 2) throw new Error("--replicate must be 1 or 2");

  const result = await runBoundary({
    boundary,
    mode: pass === undefined ? "full" : "smoke",
    ...(pass === undefined ? { replicate } : { pass }),
    out: flags["--out"] as string,
    seed: flags["--seed"] as string,
    delaysNs: delaysOf(flags["--delays-ns"] as string),
    background: backgroundOf(flags["--background"] as string),
    commit: flags["--commit"] as string,
    requestCap: flags["--request-cap"] === undefined ? Number.POSITIVE_INFINITY : Number(flags["--request-cap"]),
    deadline: flags["--deadline"] === undefined ? Date.now() + PHASE_CEILING_MINUTES[boundary] * MINUTE : Number(flags["--deadline"]),
  });

  for (const reason of result.invalid) say(reason);
  return result.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
