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
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import * as http from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

import {
  applyGovernedMigration,
  CLUSTER_PASSWORD,
  CLUSTER_USER,
  freePort,
  proveOwnedPostmaster,
  requestCompleteShutdown,
  withEmbeddedPostgres,
  type EmbeddedCluster,
} from "../../src/data/testing/embedded-cluster";
import { createListingPersistence } from "../../src/data/connection";
import {
  appDatabaseUrl,
  createE3SuperuserOps,
  createRedactor,
  E3_CLUSTER_REQUEST,
  e3ConsoleLines,
  e3ExitCode,
  e3FinalSafety,
  e3Fixtures,
  E3Stop,
  interruptClusterStartup,
  redactDeep,
  renderE3Report,
  runE3Check,
  stopOwnedTree,
  stopPhaseServer,
  type AppServer,
  type E3ClusterHandle,
  type E3Exchange,
  type E3RunSeams,
  type E3Secrets,
  type OwnedStep,
  type ScannedItem,
  type Timer,
  type TreeStopDeps,
} from "./e3-check";
import {
  DEFAULT_ANALYSIS,
  medianOf,
  VALIDATION_EVALUATION_MINUTES,
  VALIDATION_MARKER,
  writeAnalysis,
  writeE2Validation,
  type MeasurementRecord,
  type RunManifest,
  type ValidationOptions,
  type ValidationReport,
} from "./analyze";
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
  HARNESS_ROOT_PREFIX,
  windowsListenerLookup,
  holdAtCheckpoint,
  helperClusterOps,
  installAbortOnSignals,
  IntentLog,
  isHarnessRoot,
  isWithin,
  locateClusterRoot,
  measuredCheckpoint,
  outputDirectoryProblems,
  PERSONAL_DEMO_PORTS,
  portIsFree,
  PROCESS_EXIT_POLL_MS,
  PROCESS_EXIT_POLLS,
  ProcessInspectionError,
  projectionNeedsRuling,
  projectReplicateMs,
  readPidFileEvidence,
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
  type ListeningEntry,
  type ProcessIdentity,
  type ProcessOps,
  type TeardownReport,
} from "./isolation";
import {
  checkCheckoutLockfile,
  collectLockfileEvidence,
  liveIdentityOf,
  readInstalledNext,
  type GitRunner,
  type LockfileEvidence,
  type NextVersionEvidence,
} from "./next-evidence";
import { runOperation } from "./run-operation";
import { pathFor, runHttp, sendOne, waitReady, type Exchange } from "./run-http";
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
import { realStagingSeams, STAGING_FLAGS, STAGING_USAGE, stagingMain } from "./staging-check";

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
  validate-e2 --out <abs dir> --validation-out <abs dir> --seed <s> --delays-ns <a,b,c> --background <n> --commit <sha>
  analyze --run <run dir> --out <abs dir>
  cleanup --run <run dir>
  e3-check --out <abs dir> --commit <sha>
  --help

No input has a default. The output directory must be absolute, existing, empty, outside the
repository and outside the system temp directory. Exactly three distinct calibration delays, in
nanoseconds. Results are exploratory or diagnostic; no threshold or verdict is applied.

validate-e2 is validation only, not a smoke run: one E2 pass of the smoke schedule (80-request
cap; cooperative limits of 20 min for the pass, 3 for teardown, 5 for evaluation), evaluated by the
shared E2 gates into --validation-out. It computes no timing statistic, starts no S-B or S-C, and
changes no smoke verdict. analyze refuses its output.

e3-check is the E3-local acceptance run (E3-local Scope Gate revision 4): next build with no
database or E3 configuration, then one disposable cluster and three next start phases, with a hard
60-attempt HTTP cap across every phase. It computes no timing statistic. Deliberate fault injection
(E-A4b) is reported separately from the normal acceptance result.
${STAGING_USAGE}`;

const FLAGS: Readonly<Record<string, readonly string[]>> = {
  smoke: ["--boundary", "--out", "--seed", "--delays-ns", "--background", "--commit"],
  e1: ["--replicate", "--out", "--seed", "--delays-ns", "--background", "--commit", "--smoke-pass", "--request-cap", "--deadline"],
  e2: ["--replicate", "--out", "--seed", "--delays-ns", "--background", "--commit", "--smoke-pass", "--request-cap", "--deadline"],
  "validate-e2": ["--out", "--validation-out", "--seed", "--delays-ns", "--background", "--commit"],
  analyze: ["--run", "--out"],
  cleanup: ["--run"],
  "e3-check": ["--out", "--commit"],
  ...STAGING_FLAGS,
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

export interface BoundaryOptions {
  readonly boundary: Boundary;
  readonly mode: Mode;
  readonly pass?: "S-A" | "S-B" | "S-C";
  /** Only on a V-A validation pass (amendment r5 A5-3); such a pass has no smoke pass label. */
  readonly validation?: typeof VALIDATION_MARKER;
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

/** V-A limits (amendment r5 A5-3). The request cap is hard; the pass time limit is cooperative. */
export const VALIDATION_REQUEST_CAP = 80;
export const VALIDATION_PASS_MINUTES = 20;

/** The options of a V-A validation pass: the E2 smoke schedule, no pass label, the marker and the V-A limits. */
export function validationOptions(flags: Readonly<Record<string, string>>, now: number): BoundaryOptions {
  return {
    boundary: "e2",
    mode: "smoke",
    validation: VALIDATION_MARKER,
    out: flags["--out"] as string,
    seed: flags["--seed"] as string,
    delaysNs: delaysOf(flags["--delays-ns"] as string),
    background: backgroundOf(flags["--background"] as string),
    commit: flags["--commit"] as string,
    requestCap: VALIDATION_REQUEST_CAP,
    deadline: now + VALIDATION_PASS_MINUTES * MINUTE,
  };
}

/** The run manifest as first written. `invalid` is the run's own array, which later steps extend. */
export function initialManifest(
  options: BoundaryOptions,
  plan: Pick<ReturnType<typeof buildPlan>, "delaysNs" | "background" | "identities">,
  startedAt: Date,
  environment: Readonly<Record<string, unknown>>,
  invalid: readonly string[],
): RunManifest {
  return {
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
    environment,
    invalid,
    ...(options.validation === undefined ? {} : { validation: options.validation }),
  };
}

/** A V-A stop inside the run: owned-resource teardown still runs, and the message is recorded as given. */
export class ValidationStop extends Error {}

/** Where a V-A pass writes its HTTP attempt trace, inside `--out`. */
export const VALIDATION_ATTEMPTS_FILE = "http-attempts.json";

/** V-A readiness polling interval, as `waitReady` uses for every other run. */
export const VALIDATION_READINESS_POLL_MS = 500;

export interface HttpAttempt {
  readonly attempt: number;
  readonly phase: "readiness" | "plan";
  readonly target: "next" | "calibration";
  readonly path: string;
  /** `status <code>`, or the transport error's message. */
  readonly outcome: string;
}

/**
 * One shared V-A HTTP attempt budget (amendment r5 A5-3): readiness attempts for both servers,
 * failed ones included, and every planned request all count. Callers check `remaining()` before
 * each send; `trace` records each attempt once it has an outcome.
 */
export interface AttemptBudget {
  readonly limit: number;
  remaining(): number;
  trace(phase: HttpAttempt["phase"], target: HttpAttempt["target"], path: string, outcome: string): void;
  summary(): { readonly limit: number; readonly used: number; readonly byPhase: Readonly<Record<string, number>>; readonly attempts: readonly HttpAttempt[] };
}

export function createAttemptBudget(limit: number): AttemptBudget {
  const attempts: HttpAttempt[] = [];
  return {
    limit,
    remaining: () => Math.max(0, limit - attempts.length),
    trace: (phase, target, path, outcome) => {
      attempts.push({ attempt: attempts.length + 1, phase, target, path, outcome });
    },
    summary: () => {
      const byPhase: Record<string, number> = {};
      for (const attempt of attempts) byPhase[`${attempt.phase}:${attempt.target}`] = (byPhase[`${attempt.phase}:${attempt.target}`] ?? 0) + 1;
      return { limit, used: attempts.length, byPhase, attempts: [...attempts] };
    },
  };
}

/** The recorded server process a V-A listener must belong to. */
export interface OwnedServer {
  readonly pid: number;
  readonly creationTime: string;
}

/** The only address a V-A listener may be bound to. */
export const VALIDATION_LOOPBACK = "127.0.0.1";

/** The inspections a V-A listener check uses: the strict listener lookup, and process identity. */
export interface ListenerInspections {
  /** Every listening entry on the port (`windowsListenerLookup`); throws on a failed or malformed lookup. */
  readonly lookup: (port: number) => Promise<readonly ListeningEntry[]>;
  readonly processes: Pick<ProcessOps, "children" | "inspect">;
}

export interface ListenerCheck {
  readonly target: HttpAttempt["target"];
  readonly port: number;
  readonly server: OwnedServer;
  readonly inspections: ListenerInspections;
}

/**
 * One V-A listener check, with no HTTP. A successful empty lookup is `"unbound"`. Otherwise the
 * port must have exactly one listening entry, bound to `127.0.0.1`, owned by the recorded server
 * process or a descendant found by walking its children, and the recorded process must still have
 * its recorded creation time. A failed lookup, several entries, a wrong address, a foreign owner, a
 * replaced server or a failed ownership inspection throws a `ValidationStop` before anything is sent.
 */
export async function checkOwnedListener(input: ListenerCheck): Promise<"unbound" | number> {
  const stop = (detail: string): ValidationStop => new ValidationStop(`Invalid (validation stop): ${input.target} listener ${detail}`);
  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      throw stop(`${what} failed: ${(error as Error).message}`);
    }
  };

  const entries = await attempt("lookup", () => input.inspections.lookup(input.port));
  if (entries.length === 0) return "unbound";
  if (entries.length > 1) {
    throw stop(`on port ${input.port} is ambiguous: ${entries.length} listening entries (${entries.map((entry) => `${entry.localAddress} pid ${entry.owningProcess}`).join(", ")})`);
  }

  const [entry] = entries as [ListeningEntry];
  if (entry.localAddress !== VALIDATION_LOOPBACK) throw stop(`on port ${input.port} is bound to ${entry.localAddress}, not ${VALIDATION_LOOPBACK}`);

  const root = await attempt("ownership inspection", () => input.inspections.processes.inspect(input.server.pid));
  if (root === undefined || root.creationTime !== input.server.creationTime) {
    throw stop(`could not be verified: the recorded server process ${input.server.pid} is gone or was replaced`);
  }
  if (entry.owningProcess === input.server.pid) return entry.owningProcess;

  // Walk the recorded server's descendants; the owner must be one of them.
  const queue = [input.server.pid];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of await attempt("ownership inspection", () => input.inspections.processes.children(parent))) {
      if (child.pid === entry.owningProcess) return entry.owningProcess;
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        queue.push(child.pid);
      }
    }
  }

  throw stop(`on port ${input.port} is owned by process ${entry.owningProcess}, which is not the recorded server or one of its descendants`);
}

/** Wait, with no HTTP, until the owned listener is confirmed; an unbound port is polled only until the readiness deadline. */
export async function waitForOwnedListener(
  input: ListenerCheck & { readonly deadline: number; readonly signal: AbortSignal; readonly sleep: (ms: number) => Promise<void>; readonly now: () => number },
): Promise<number> {
  while (input.now() < input.deadline) {
    if (input.signal.aborted) throw new Error("aborted while waiting for readiness");
    const result = await checkOwnedListener(input);
    if (result !== "unbound") return result;
    await input.sleep(VALIDATION_READINESS_POLL_MS);
  }

  throw new Error(`port ${input.port} had no listener within the readiness bound`);
}

/** Immediately before scheduled traffic: one check, in which an unbound port is refused too. */
export async function verifyOwnedListenerNow(input: ListenerCheck): Promise<number> {
  const result = await checkOwnedListener(input);
  if (result === "unbound") throw new ValidationStop(`Invalid (validation stop): ${input.target} listener on port ${input.port} is no longer bound before scheduled traffic`);
  return result;
}

/**
 * V-A readiness for one server, within one readiness deadline. **Before every HTTP attempt** —
 * the first and every retry — the owned listener is checked again (no HTTP, waiting only while the
 * port is unbound), then the shared budget, and only then is the probe sent and charged. When the
 * budget is spent, it stops with no further request.
 */
export async function waitReadyWithinBudget(input: {
  readonly budget: AttemptBudget;
  readonly target: HttpAttempt["target"];
  readonly port: number;
  readonly path: string;
  readonly ready: (exchange: Exchange) => boolean;
  readonly boundMs: number;
  readonly signal: AbortSignal;
  readonly send: (port: number, path: string) => Promise<Exchange>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** The recorded server and the inspections that confirm it owns the listener. */
  readonly listener: { readonly server: OwnedServer; readonly inspections: ListenerInspections };
}): Promise<void> {
  const deadline = input.now() + input.boundMs;
  const check: ListenerCheck = { target: input.target, port: input.port, server: input.listener.server, inspections: input.listener.inspections };

  while (input.now() < deadline) {
    if (input.signal.aborted) throw new Error("aborted while waiting for readiness");
    await waitForOwnedListener({ ...check, deadline, signal: input.signal, sleep: input.sleep, now: input.now });
    // The ownership check is awaited, so the pass may have been aborted, or the readiness deadline
    // passed, meanwhile. Either stops here: nothing is sent and no attempt is charged.
    if (input.signal.aborted) throw new Error("aborted while waiting for readiness");
    if (input.now() >= deadline) throw new Error(`port ${input.port} was not ready within ${input.boundMs}ms`);
    if (input.budget.remaining() <= 0) {
      throw new ValidationStop(`Invalid (validation cap): the ${input.budget.limit}-attempt HTTP budget was exhausted during ${input.target} readiness`);
    }

    let outcome: string;
    let isReady = false;
    try {
      const exchange = await input.send(input.port, input.path);
      outcome = `status ${exchange.status}`;
      isReady = input.ready(exchange);
    } catch (error) {
      outcome = (error as Error).message;
    }
    input.budget.trace("readiness", input.target, input.path, outcome);
    if (isReady) return;
    await input.sleep(VALIDATION_READINESS_POLL_MS);
  }

  throw new Error(`port ${input.port} was not ready within ${input.boundMs}ms`);
}

/**
 * V-A order for HTTP: readiness for each server in turn, then the post-readiness bookkeeping, then
 * the listener checks for **both** servers immediately before handing off, then the plan with only
 * the budget that remains as its cap. If any step throws — a spent budget, or a listener refused
 * at handoff — the plan never starts.
 */
export async function readinessThenMeasure<T>(input: {
  readonly budget: AttemptBudget;
  readonly readiness: readonly (() => Promise<void>)[];
  readonly afterReadiness: () => Promise<void>;
  readonly handoff: readonly (() => Promise<unknown>)[];
  readonly measure: (cap: number) => Promise<T>;
}): Promise<T> {
  for (const wait of input.readiness) await wait();
  await input.afterReadiness();
  for (const check of input.handoff) await check();
  return input.measure(input.budget.remaining());
}

export interface OutputSafetySeams {
  readonly repositoryRoot: string;
  readonly tempDirectory: string;
  readonly directoryEntries: (path: string) => readonly string[] | undefined;
  /** Resolves links and Windows junctions; the real binding is `realpathSync.native`. */
  readonly realpath: (path: string) => string;
}

function overlapProblems(out: string, validationOut: string, seams: OutputSafetySeams): string[] {
  if (!isAbsolute(out) || !isAbsolute(validationOut)) return [];
  if (isWithin(validationOut, out, seams.realpath)) return ["--validation-out must not be --out or lie inside it, including through a junction or link"];
  if (isWithin(out, validationOut, seams.realpath)) return ["--validation-out must not contain --out, including through a junction or link"];
  return [];
}

/**
 * Before anything is created or written: the existing output-directory rules for **both**
 * directories (absolute, existing, empty, outside the repository and the temp directory), and no
 * overlap between them on resolved paths, junction aliases included.
 */
export function validationOutputDirectoryProblems(out: string, validationOut: string, seams: OutputSafetySeams): string[] {
  return [
    ...outputDirectoryProblems(out, seams).map((problem) => `--out: ${problem}`),
    ...outputDirectoryProblems(validationOut, seams).map((problem) => `--validation-out: ${problem}`),
    ...overlapProblems(out, validationOut, seams),
  ];
}

/**
 * Immediately before **every** report write (preflight-stop, completed or incomplete): the full
 * destination policy. Both directories must resolve; the destination must still pass every
 * output-directory rule (absolute, existing, empty, outside the repository and the system temp
 * directory, on resolved paths) and must still be separate from the capture directory.
 */
export function reportDestinationProblems(out: string, validationOut: string, seams: OutputSafetySeams): string[] {
  const unresolved = (label: string, path: string): string[] => {
    try {
      seams.realpath(path);
      return [];
    } catch (error) {
      return [`${label}: the path could not be resolved (${(error as Error).message})`];
    }
  };
  const resolution = [...unresolved("--validation-out", validationOut), ...unresolved("--out", out)];
  if (resolution.length > 0) return resolution;
  return [...outputDirectoryProblems(validationOut, seams).map((problem) => `--validation-out: ${problem}`), ...overlapProblems(out, validationOut, seams)];
}

/**
 * The V-A stop before `npm ci` (amendment r5 A5-1): the disposable worktree's lockfile must pass
 * checks 1 and 2. Never stops a smoke or full run, which keep revision 4's "collection failures
 * never abort a run".
 */
export function lockfileStopFor(options: Pick<BoundaryOptions, "validation">, lockfile: LockfileEvidence | undefined): string | undefined {
  if (options.validation === undefined) return undefined;
  const result = checkCheckoutLockfile(lockfile);
  return result.ok ? undefined : `Invalid (validation stop): worktree lockfile ${result.check}`;
}

/**
 * The tail of a boundary run inside the cluster body. **V-A only** (ruling D-V7): stored fixture
 * states are verified while the database is available, then owned resources are torn down. Smoke
 * and full runs keep the existing order: teardown, then verification. Teardown always runs.
 */
export async function finishBoundary(steps: {
  readonly validation: boolean;
  readonly run: () => Promise<void>;
  readonly verifyStoredStates: () => Promise<readonly string[]>;
  readonly teardown: () => Promise<void>;
  readonly recordInvalid: (reason: string) => void;
}): Promise<void> {
  const verify = async (): Promise<void> => {
    const after = await steps.verifyStoredStates();
    if (after.length > 0) steps.recordInvalid(`Invalid (stored state): ${after.join("; ")}`);
  };

  try {
    await steps.run();
    if (steps.validation) await verify();
  } finally {
    await steps.teardown();
  }

  if (!steps.validation) await verify();
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
  let manifest: RunManifest = initialManifest(options, plan, startedAt, { ...(await environmentManifest()), counts: countsOf(plan) }, invalid);
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
    invalid.push(error instanceof ValidationStop ? error.message : `Invalid (setup or run): ${(error as Error).message}`);
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

    await finishBoundary({
      validation: options.validation !== undefined,
      run: async () => {
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
      },
      verifyStoredStates: () => verifyStoredStates(persistence.db, plan),
      teardown: async () => {
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
      },
      recordInvalid: (reason) => invalid.push(reason),
    });
  }

  const changed = restrictedChanges(restrictedBaseline, restrictedMetadataOf(REPOSITORY_ROOT));
  if (changed.length > 0) invalid.push(`Invalid (file safety): restricted-file metadata changed for ${changed.join(", ")}`);
  if (controller.signal.aborted) {
    const reason = (controller.signal.reason as Error | undefined)?.message ?? "abort";
    stoppedBy = reason === "timeout" ? "timeout" : stoppedBy ?? "abort";
    invalid.push(
      reason === "timeout"
        ? options.validation !== undefined
          ? `Invalid (validation timeout): the ${VALIDATION_PASS_MINUTES}-minute pass limit was reached`
          : options.mode === "smoke"
            ? "Failed (cap): smoke time cap reached"
            : "Invalid (timeout)"
        : `Aborted: ${reason}`,
    );
  }
  if (stoppedBy === "cap") {
    invalid.push(options.validation !== undefined ? `Invalid (validation cap): the ${VALIDATION_REQUEST_CAP}-attempt HTTP budget was reached` : "Failed (cap): smoke request cap reached");
  }

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

/** Git through an argument array, with optional standard input, returning the exit code and stdout bytes. */
const runGit: GitRunner = (args, input) => {
  try {
    return { code: 0, stdout: execFileSync("git", [...args], { ...(input === undefined ? {} : { input }), maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: Buffer };
    return { code: typeof failed.status === "number" ? failed.status : -1, stdout: Buffer.isBuffer(failed.stdout) ? failed.stdout : Buffer.alloc(0) };
  }
};

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

  // The lockfile comes from the run commit's object; the worktree's copy is read once, before
  // `npm ci`, and that buffer feeds the raw, CR LF → LF and Git-filtered checks (amendment r5 A5-1).
  const lockfile = collectLockfileEvidence({
    commit: options.commit,
    repositoryRoot: REPOSITORY_ROOT,
    checkout: worktree,
    readFile: (path) => readFileSync(path),
    git: runGit,
  });
  let evidence: NextVersionEvidence = {
    runCommit: options.commit,
    ...optional("worktreePath", collected(() => realpathSync.native(worktree))),
    ...optional("worktreeHead", collected(() => execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())),
    ...optional("lockfile", lockfile),
  };
  recordNextEvidence(evidence);

  // V-A only: a worktree lockfile failure stops here, before `npm ci` and `next dev`. The error
  // reaches the cluster body's teardown, which still removes every recorded resource.
  const stop = lockfileStopFor(options, lockfile);
  if (stop !== undefined) throw new ValidationStop(stop);

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
  const nextReady = (exchange: Exchange): boolean => exchange.status === 200 && exchange.body.includes("<h1>Not available</h1>");
  const calibrationReady = (exchange: Exchange): boolean => exchange.status === 200;
  const targets = { nextPort, calibrationPort, bodiesDirectory: join(options.out, "bodies") };
  let outcome: Awaited<ReturnType<typeof runHttp>>;

  if (options.validation === undefined) {
    await waitReady(nextPort, `/directory/${compile.key}`, nextReady, 5 * MINUTE, control.signal);
    await waitReady(calibrationPort, HEALTH_PATH, calibrationReady, 30_000, control.signal);
    await recordDescendants(log, processes, next.entry, nextPort);
    await recordDescendants(log, processes, calibration.entry, calibrationPort);
    setSetupMs(Date.now() - setupStart);
    outcome = await runHttp(plan, targets, control);
  } else {
    // V-A: every HTTP attempt — readiness for both servers, failures included, and every planned
    // request — is traced and charged to one shared budget, checked before each send.
    const budget = createAttemptBudget(options.requestCap);
    const agent = new http.Agent({ keepAlive: false });
    const send = (port: number, path: string): Promise<Exchange> => sendOne(agent, port, path, 60_000);
    const sleep = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));
    // The recorded identity of each server process, as logged when it was started.
    const ownedServer = (entry: number, label: string): OwnedServer => {
      const identity = log.entries()[entry]?.identity;
      if (identity === undefined) throw new ValidationStop(`Invalid (validation stop): ${label} has no recorded process identity`);
      return { pid: identity.pid, creationTime: identity.creationTime };
    };
    // The strict listener lookup (every entry, address and owner); `listener(port)` stays for teardown.
    const inspections: ListenerInspections = { lookup: windowsListenerLookup(), processes };
    const nextCheck = (): ListenerCheck => ({ target: "next", port: nextPort, server: ownedServer(next.entry, "next dev"), inspections });
    const calibrationCheck = (): ListenerCheck => ({ target: "calibration", port: calibrationPort, server: ownedServer(calibration.entry, "calibration server"), inspections });

    try {
      outcome = await readinessThenMeasure({
        budget,
        readiness: [
          () =>
            waitReadyWithinBudget({
              budget,
              target: "next",
              port: nextPort,
              path: `/directory/${compile.key}`,
              ready: nextReady,
              boundMs: 5 * MINUTE,
              signal: control.signal,
              send,
              sleep,
              now: Date.now,
              listener: { server: nextCheck().server, inspections },
            }),
          () =>
            waitReadyWithinBudget({
              budget,
              target: "calibration",
              port: calibrationPort,
              path: HEALTH_PATH,
              ready: calibrationReady,
              boundMs: 30_000,
              signal: control.signal,
              send,
              sleep,
              now: Date.now,
              listener: { server: calibrationCheck().server, inspections },
            }),
        ],
        afterReadiness: async () => {
          await recordDescendants(log, processes, next.entry, nextPort);
          await recordDescendants(log, processes, calibration.entry, calibrationPort);
          setSetupMs(Date.now() - setupStart);
        },
        // Both listeners again, immediately before the scheduled traffic.
        handoff: [() => verifyOwnedListenerNow(nextCheck()), () => verifyOwnedListenerNow(calibrationCheck())],
        measure: (cap) =>
          runHttp(plan, targets, {
            ...control,
            requestCap: cap,
            onRecord: (record) => {
              const identity = plan.identities[record.identity] as PlanIdentity;
              budget.trace("plan", identity.target === "calibration" ? "calibration" : "next", pathFor(identity), record.transportError ?? `status ${record.status}`);
              control.onRecord(record);
            },
          }),
      });
    } finally {
      agent.destroy();
      writeFileSync(join(options.out, VALIDATION_ATTEMPTS_FILE), `${JSON.stringify(budget.summary(), null, 2)}\n`);
    }
  }

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

// ---------------------------------------------------------------------------------------------
// validate-e2: one V-A validation pass (amendment r5 A5-3), never a smoke run.
// ---------------------------------------------------------------------------------------------

export interface PreflightResult {
  /** Reasons to stop before anything is created. Empty when V-A may start. */
  readonly stops: readonly string[];
  /** What the preflight recorded, reported as evidence. */
  readonly findings: Readonly<Record<string, unknown>>;
}

/** Everything `runValidateE2` reaches outside itself. It has no smoke driver and no forced pass. */
export interface ValidateE2Seams {
  readonly now: () => number;
  /** The output-directory rules for both directories and their overlap (`validationOutputDirectoryProblems`). */
  readonly outputProblems: (out: string, validationOut: string) => readonly string[];
  /** The report destination's rules and overlap, rechecked immediately before any report write (`reportDestinationProblems`). */
  readonly destinationProblems: (out: string, validationOut: string) => readonly string[];
  /** The checkout lockfile preflight and the other read-only checks. Creates nothing. */
  readonly preflight: (options: BoundaryOptions) => Promise<PreflightResult>;
  /** Exactly one pass. */
  readonly runPass: (options: BoundaryOptions) => Promise<{ readonly exitCode: number; readonly invalid: readonly string[] }>;
  /** The zero-residue check after the pass; each entry is one remaining resource. */
  readonly residue: (runDirectory: string) => Promise<readonly string[]>;
  readonly evaluate: (runDirectory: string, outDirectory: string, options: ValidationOptions) => ValidationReport;
  /** Write the preflight findings when V-A does not start. */
  readonly writePreflightStop: (outDirectory: string, result: PreflightResult) => void;
  readonly say: (line: string) => void;
}

/**
 * `validate-e2`: output rules for both directories → preflight → one pass → residue → evaluation.
 * A bad directory refuses with exit 2 before anything is created or written. A preflight stop or
 * a refused pass ends it with exit 2 and no evaluation. The report destination is rechecked before
 * every write; if it fails, nothing is written. An Invalid pass, or residue, is still evaluated,
 * and Invalid is listed first. Exit 0 only when the pass exited 0, there is no residue, and the
 * complete report has **no Invalid reason**; a withheld gate alone is a reported result, printed as
 * the headline, not a failure. An incomplete evaluation exits 1.
 */
export async function runValidateE2(flags: Readonly<Record<string, string>>, seams: ValidateE2Seams): Promise<number> {
  const out = flags["--out"] as string;
  const validationOut = flags["--validation-out"] as string;
  const refuse = (problems: readonly string[]): void => {
    for (const problem of problems) seams.say(`refused: ${problem}`);
  };
  const directories = seams.outputProblems(out, validationOut);

  if (directories.length > 0) {
    refuse(directories);
    return 2;
  }

  const options = validationOptions(flags, seams.now());
  const preflight = await seams.preflight(options);

  if (preflight.stops.length > 0) {
    refuse(preflight.stops);
    const destination = seams.destinationProblems(out, validationOut);
    if (destination.length > 0) refuse(destination);
    else seams.writePreflightStop(validationOut, preflight);
    return 2;
  }

  const pass = await seams.runPass(options);

  if (pass.exitCode === 2) {
    refuse(pass.invalid);
    return 2;
  }

  const residue = await seams.residue(out);
  const destination = seams.destinationProblems(out, validationOut);

  if (destination.length > 0) {
    refuse(destination);
    seams.say("no validation report was written; the pass's own output is unchanged");
    return 1;
  }

  const report = seams.evaluate(out, validationOut, {
    deadline: seams.now() + VALIDATION_EVALUATION_MINUTES * MINUTE,
    now: seams.now,
    extraInvalid: residue.length === 0 ? [] : [`Invalid (residue): ${residue.join("; ")}`],
    preflight: preflight.findings,
  });

  seams.say(report.headline);

  if (report.status === "incomplete") {
    seams.say(`evaluation INCOMPLETE: partial output only, in ${join(validationOut, "incomplete")}; no completed report was written.`);
    return 1;
  }

  seams.say(`Interpretation: ${report.interpretation}`);
  return pass.exitCode === 0 && residue.length === 0 && report.invalid.length === 0 ? 0 : 1;
}

/** The real seams of `validate-e2`. Windows only, like every run. */
function realValidateSeams(): ValidateE2Seams {
  const git = createGitOps(REPOSITORY_ROOT);
  const processes = windowsProcessOps();
  let baselines: { restricted: RestrictedMetadata; status: string } | undefined;
  const safety: OutputSafetySeams = {
    repositoryRoot: REPOSITORY_ROOT,
    tempDirectory: tmpdir(),
    directoryEntries,
    // Resolves symbolic links and Windows junctions to the final path.
    realpath: (path) => realpathSync.native(path),
  };

  return {
    now: Date.now,
    outputProblems: (out, validationOut) => validationOutputDirectoryProblems(out, validationOut, safety),
    destinationProblems: (out, validationOut) => reportDestinationProblems(out, validationOut, safety),
    say,
    preflight: async (options) => {
      const stops: string[] = [];
      const top = await checkPreconditions({
        repositoryRoot: REPOSITORY_ROOT,
        tempDirectory: tmpdir(),
        authorizedCommit: options.commit,
        outputDirectory: options.out,
        environment: process.env,
        portIsFree,
        gitHead: () => git.head(),
        gitStatusPorcelain: () => git.statusPorcelain(),
        directoryEntries,
        restrictedMetadata: () => restrictedMetadataOf(REPOSITORY_ROOT),
      });
      stops.push(...top.refusals);
      if (top.restrictedBaseline !== undefined && top.statusBaseline !== undefined) {
        baselines = { restricted: top.restrictedBaseline as RestrictedMetadata, status: top.statusBaseline as string };
      }

      // P-1 to P-4: the current checkout's lockfile, one read feeding every check.
      const lockfile = collectLockfileEvidence({ commit: options.commit, repositoryRoot: REPOSITORY_ROOT, checkout: REPOSITORY_ROOT, readFile: (path) => readFileSync(path), git: runGit });
      const lockfileCheck = checkCheckoutLockfile(lockfile);
      if (!lockfileCheck.ok) stops.push(`checkout lockfile ${lockfileCheck.check}`);

      // P-5: real-path forms.
      const temp = collected(() => realpathSync.native(tmpdir()));
      const node = collected(() => realpathSync.native(process.execPath));
      if (temp !== tmpdir()) stops.push(`the temp directory's real path differs from ${tmpdir()}`);
      if (node !== process.execPath) stops.push(`the Node executable's real path differs from ${process.execPath}`);

      // P-6: nothing harness-shaped is present.
      const leftovers = collected(() => readdirSync(tmpdir()).filter((name) => name.startsWith(HARNESS_ROOT_PREFIX)));
      if (leftovers === undefined) stops.push("the temp directory could not be listed");
      else if (leftovers.length > 0) stops.push(`harness-shaped entries are present in the temp directory: ${leftovers.join(", ")}`);
      const worktrees = await git.worktreeList().catch(() => undefined);
      if (worktrees === undefined) stops.push("git worktree list failed");
      else if (worktrees.length !== 1 || worktrees.some((entry) => entry.prunable)) stops.push("git worktree list shows more than the main tree, or a prunable entry");

      if (baselines === undefined && top.refusals.length === 0) stops.push("the residue baselines could not be taken");

      return {
        stops,
        findings: { lockfile, lockfileCheck, tempDirectory: tmpdir(), tempRealPath: temp, nodeExecutable: process.execPath, nodeRealPath: node, leftovers, worktrees },
      };
    },
    runPass: async (options) => {
      const result = await runBoundary(options);
      return { exitCode: result.exitCode, invalid: result.invalid };
    },
    residue: async (runDirectory) => {
      if (baselines === undefined) return ["the residue baselines were not taken"];
      return residueOf(new IntentLog(join(runDirectory, "run-state.json")).entries(), {
        processes,
        git,
        repositoryRoot: REPOSITORY_ROOT,
        repositoryGitDirectory: join(REPOSITORY_ROOT, ".git"),
        restrictedBaseline: baselines.restricted,
        statusBaseline: baselines.status,
        portIsFree,
      });
    },
    evaluate: (runDirectory, outDirectory, options) =>
      writeE2Validation(runDirectory, outDirectory, {
        ...options,
        realpath: safety.realpath,
        // The full destination policy, rerun by the writer immediately before it writes anything.
        destinationCheck: () => reportDestinationProblems(runDirectory, outDirectory, safety),
      }),
    writePreflightStop: (outDirectory, result) => {
      // The caller has just rerun the full destination policy (`destinationProblems`) for this write.
      const headline = "Gate result: not established — the validation pass did not start";
      writeFileSync(join(outDirectory, "preflight-stop.json"), `${JSON.stringify({ headline, ...result }, null, 2)}\n`);
      writeFileSync(join(outDirectory, "preflight-stop.md"), `${[headline, "", "Validation only. Nothing was created.", "", ...result.stops.map((stop) => `- ${stop}`)].join("\n")}\n`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// e3-check (E3-local Scope Gate revision 4): the real seams. The order and the rules are in
// `e3-check.ts`, where they are tested; this binds them to processes, Git, the cluster and HTTP.
// ---------------------------------------------------------------------------------------------

/** The cooperative limit for one e3-check run. The 60-attempt HTTP cap is the hard one. */
export const E3_PASS_MINUTES = 30;

/** Environment names a child may inherit. Nothing names a database or an E3 setting. */
const E3_INHERITED = ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"] as const;

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { NEXT_TELEMETRY_DISABLED: "1" };
  for (const name of E3_INHERITED) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** One direct request: no agent reuse, no redirect following, identity encoding. */
function sendE3(port: number, method: "GET" | "OPTIONS", path: string): Promise<E3Exchange> {
  return new Promise((accept, reject) => {
    let writeStartMs = 0;
    const request = http.request({ host: VALIDATION_LOOPBACK, port, path, method, agent: false, headers: { "Accept-Encoding": "identity", Connection: "close" } });
    request.setTimeout(60_000, () => request.destroy(new Error("timed out after 60000ms")));
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => accept({ status: response.statusCode ?? -1, rawHeaders: [...response.rawHeaders], body: Buffer.concat(chunks), writeStartMs, responseEndMs: Date.now() }));
    });
    writeStartMs = Date.now();
    request.end();
  });
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

async function e3Check(flags: Readonly<Record<string, string>>): Promise<number> {
  if (platform() !== "win32") throw new Error("the harness's process and cleanup operations are Windows-only");
  // Generated first, so every message this command prints or writes can be redacted.
  const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
  const secrets = { role: `bi4_e3_app_${hex(4)}`, password: hex(16), marker: `bi4-e3-synthetic:${hex(16)}` };
  let redact = createRedactor([secrets.password]);
  try {
    return await e3CheckWith(flags, secrets, (next) => (redact = next), (text) => redact(text));
  } catch (error) {
    throw new Error(redact((error as Error).message));
  }
}

async function e3CheckWith(
  flags: Readonly<Record<string, string>>,
  secrets: E3Secrets,
  setRedactor: (redact: (text: string) => string) => void,
  redact: (text: string) => string,
): Promise<number> {
  const out = flags["--out"] as string;
  const commit = flags["--commit"] as string;
  const git = createGitOps(REPOSITORY_ROOT);
  const processes = windowsProcessOps();
  const tempDirectory = tmpdir();
  const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
  const print = (message: string): void => say(redact(message));

  const preconditions = await checkPreconditions({
    repositoryRoot: REPOSITORY_ROOT,
    tempDirectory,
    authorizedCommit: commit,
    outputDirectory: out,
    environment: process.env,
    portIsFree,
    gitHead: () => git.head(),
    gitStatusPorcelain: () => git.statusPorcelain(),
    directoryEntries,
    restrictedMetadata: () => restrictedMetadataOf(REPOSITORY_ROOT),
  });
  const refusals = [...preconditions.refusals, ...Object.keys(process.env).filter((name) => name.startsWith("BI4_E3_")).map((name) => `${name} is set in the harness's own environment`)];
  if (refusals.length > 0) {
    for (const refusal of refusals) print(`refused: ${refusal}`);
    return e3ExitCode(undefined, undefined, true);
  }
  const restrictedBaseline = preconditions.restrictedBaseline as RestrictedMetadata;
  const statusBaseline = preconditions.statusBaseline ?? "";

  const log = new IntentLog(join(out, "run-state.json"));
  const note = (message: string, entry?: number): void => log.note(redact(message), entry);
  const controller = new AbortController();
  const abortOn = createSignalAbortHandler(controller, (message) => note(message));
  const uninstall = installAbortOnSignals(controller, undefined, (message) => note(message), abortOn);
  const ceiling = setTimeout(() => controller.abort(new Error("timeout")), E3_PASS_MINUTES * MINUTE);
  const startedAt = new Date();
  const fixtures = e3Fixtures(randomUUID, hex);
  const inspections = { lookup: windowsListenerLookup(), inspect: (pid: number) => processes.inspect(pid), children: (pid: number) => processes.children(pid) };
  let worktree: string | undefined;
  const nextEntry = (): string => join(worktree as string, "node_modules", "next", "dist", "bin", "next");
  const sleep = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));
  const runDeadline = Date.now() + E3_PASS_MINUTES * MINUTE;
  const timeout = (ms: number): Timer => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(handle) };
  };
  const sameExecutable = (a: string, b: string | null): boolean => b !== null && canonical(a) === canonical(b);
  /** The cluster entry and, once located, its directory: what the startup interruption is pointed at. */
  let currentCluster: { readonly entry: number; directory?: string } | undefined;
  const stepLabels = new Map<number, string>();

  /** Record a process: with an identity it is `created`; with only a PID it is `left` and never stopped. */
  const recordProcess = (label: string, pid: number, parentEntry: number | undefined, identity?: ProcessIdentity, reason?: string): number => {
    const id = log.intend("process", label, { pid, ...(parentEntry === undefined ? {} : { parentEntry }) });
    log.update(id, identity === undefined ? { state: "left", reason: reason ?? "ownership could not be shown; never stopped" } : { state: "created", identity });
    return id;
  };

  /** Identity-checked tree stop with the ownership-proving orphan sweep (amendment A1 §4.1, §4.4). */
  const treeDeps = (rootEntry: number, allowedExecutable: (executable: string, parent: ProcessIdentity) => boolean): TreeStopDeps => ({
    entries: () => log.entries(),
    update: (id, patch) => log.update(id, patch),
    recordDescendants: () => recordDescendants(log, processes, rootEntry),
    inspect: (pid) => processes.inspect(pid),
    stop: (pid) => processes.stop(pid),
    sleep,
    exitPolls: PROCESS_EXIT_POLLS,
    exitPollMs: PROCESS_EXIT_POLL_MS,
    sweep: {
      children: (pid) => processes.children(pid),
      record: ({ label, parentEntry, pid, identity, reason }) => recordProcess(label, pid, parentEntry, identity, reason),
      allowedExecutable,
      now: Date.now,
    },
  });

  /** Start a bounded setup step as a recorded owned process, and observe its exit. */
  const startStep = async (label: string, args: readonly string[], env: Readonly<Record<string, string>>, logName: string): Promise<OwnedStep> => {
    const started = await startOwnedProcess(log, processes, {
      label,
      command: process.execPath,
      args,
      cwd: worktree as string,
      env,
      stdoutPath: join(out, `${logName}.out.log`),
      stderrPath: join(out, `${logName}.err.log`),
    });
    stepLabels.set(started.entry, label);
    const child = started.child;
    const exited = new Promise<number | null>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode);
      else child.once("exit", (code) => done(code));
    });
    return { entry: started.entry, exited };
  };

  const seams: E3RunSeams = {
    prepareWorktree: async () => {
      const root = join(tempDirectory, `${HARNESS_ROOT_PREFIX}e3-${hex(6)}`);
      if (!isHarnessRoot(root, tempDirectory)) throw new Error("internal: the e3 root is not a harness root");
      const rootEntry = log.intend("harness-root", "e3 root", { path: root });
      mkdirSync(root, { recursive: false });
      log.update(rootEntry, { state: "created" });
      worktree = join(root, "worktree");
      const worktreeEntry = log.intend("worktree", "worktree", { path: worktree, commit });
      await git.addDetachedWorktree(worktree, commit);
      const adminRecord = adminRecordOf(readFileSync(join(worktree, ".git"), "utf8"));
      log.update(worktreeEntry, { state: "created", ...(adminRecord === undefined ? {} : { adminRecord }) });
      const listed = (await git.worktreeList()).find((entry) => resolve(entry.path).toLowerCase() === resolve(worktree as string).toLowerCase());
      if (listed?.head !== commit || !listed.detached) throw new E3Stop("Stopped (setup): the disposable worktree is not detached at the authorized commit");
    },
    startInstall: async () => {
      const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      if (!existsSync(npmCli)) throw new E3Stop("Stopped (setup): npm-cli.js was not found beside the running node");
      return startStep("npm ci", [npmCli, "ci", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts"], Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("BI4_E3_") && !/DATABASE_URL/i.test(entry[0]))), "npm-ci");
    },
    startBuild: (environment) => startStep("next build", [nextEntry(), "build"], environment, "next-build"),
    stepExited: (entry, code, late) => {
      if (late) note(`${stepLabels.get(entry) ?? "step"} exited ${String(code)} after its deadline; recorded only, never treated as success`, entry);
      else log.update(entry, { state: "absent", reason: `exited ${String(code)}` });
    },
    stopStep: (entry) => stopOwnedTree(entry, treeDeps(entry, (executable, parent) => sameExecutable(executable, parent.executable) || sameExecutable(executable, process.execPath) || (worktree !== undefined && isWithin(executable, worktree)))),
    timeout,
    runDeadline,
    interruptClusterStartup: async () => {
      let binDirectory: string | undefined;
      try {
        // Only the declared `pg_ctl` export is read: its directory identifies the bundled binaries
        // by path. Nothing here runs `initdb` or `postgres` (issue #185).
        binDirectory = dirname((await import("@embedded-postgres/windows-x64")).pg_ctl);
      } catch {
        binDirectory = undefined;
      }
      const inBinDirectory = (executable: string): boolean => binDirectory !== undefined && isWithin(executable, binDirectory);
      return interruptClusterStartup({
        clusterDirectory: currentCluster?.directory,
        harnessPid: process.pid,
        children: (pid) => processes.children(pid),
        bundledBinary: (name) => (binDirectory === undefined ? undefined : join(binDirectory, `${name}.exe`)),
        samePath: (a, b) => canonical(a) === canonical(b),
        record: ({ label, pid, identity, reason }) => recordProcess(label, pid, currentCluster?.entry, identity, reason),
        update: (id, patch) => log.update(id, patch),
        note: (message, entry) => note(message, entry),
        pidFileEvidence: (directory) => readPidFileEvidence(directory),
        inspect: (pid) => processes.inspect(pid),
        requestShutdown: async (directory) => {
          const outcome = await requestCompleteShutdown(directory);
          return { ok: outcome.ok, timedOut: outcome.timedOut, detail: outcome.detail };
        },
        stopTree: (id) => stopOwnedTree(id, treeDeps(id, inBinDirectory)),
      });
    },
    markClusterUnsettled: (reason) => {
      if (currentCluster !== undefined) log.update(currentCluster.entry, { state: "left", reason });
    },
    withCluster: async <T>(body: (cluster: E3ClusterHandle) => Promise<T>): Promise<T> => {
      const slug = E3_CLUSTER_REQUEST.slug;
      const clusterParent = join(tempDirectory, `${CLUSTER_PARENT_PREFIX}${hex(6)}`);
      const clusterEntry = log.intend("cluster", slug, { parent: clusterParent });
      currentCluster = { entry: clusterEntry };
      if (!isHarnessRoot(clusterParent, tempDirectory)) throw new Error("internal: the cluster parent is not a harness root");
      mkdirSync(clusterParent, { recursive: false });
      let recordedRoot: string | undefined;
      let locationProblem: string | undefined;

      try {
        // L-1: no database and no migration, so the helper sends no SQL before the callback.
        const running = startUnderParent(clusterParent, () =>
          withEmbeddedPostgres(E3_CLUSTER_REQUEST, async (cluster) => {
            if (locationProblem !== undefined) throw new Error(`the cluster root was not created in the recorded location: ${locationProblem}`);
            if (canonical(cluster.dataRoot) !== canonical(recordedRoot as string) || canonical(cluster.clusterDirectory) !== canonical(join(recordedRoot as string, "cluster"))) {
              throw new Error("the helper's cluster root is not the recorded run-specific root");
            }
            // L-2.
            const owned = proveOwnedPostmaster(cluster.clusterDirectory);
            const live = await processes.inspect(owned.pid);
            if (live === undefined) throw new E3Stop("Stopped (L-2): the postmaster exited before its identity was recorded");
            log.update(clusterEntry, { state: "created", path: cluster.dataRoot, clusterDirectory: cluster.clusterDirectory, port: cluster.port, postmaster: live });
            if (PERSONAL_DEMO_PORTS.includes(cluster.port)) throw new E3Stop("Stopped (L-1): the cluster port is a personal-demo port");
            return body({
              port: cluster.port,
              postmaster: { pid: live.pid, creationTime: live.creationTime },
              clusterDirectory: cluster.clusterDirectory,
              // Opens nothing and registers nothing until its first statement, after L-3.
              connectSuperuser: () =>
                createE3SuperuserOps({
                  port: cluster.port,
                  urlFor: (database) => cluster.connectionStringFor(database),
                  connect: (url, applicationName) => createListingPersistence({ pool: { connectionString: url, max: 1 }, startupParameters: { application_name: applicationName } }),
                  register: (label, close) => cluster.closeBeforeShutdown(label, close),
                  migrate: applyGovernedMigration,
                  sleep,
                  now: Date.now,
                }),
            });
          }),
        );
        const located = locateClusterRoot(clusterParent, slug);
        if ("path" in located) {
          recordedRoot = located.path;
          currentCluster = { entry: clusterEntry, directory: join(located.path, "cluster") };
          log.update(clusterEntry, { state: "created", path: located.path, clusterDirectory: join(located.path, "cluster") });
        } else {
          locationProblem = located.problem;
          note(`cluster location refused: ${located.problem}`, clusterEntry);
        }
        const result = await running;
        if (recordedRoot !== undefined && existsSync(recordedRoot)) log.update(clusterEntry, { state: "left", reason: "the helper reported success but its root still exists" });
        else if (removeEmptyDirectory(clusterParent)) log.update(clusterEntry, { state: "removed" });
        else log.update(clusterEntry, { state: "left", reason: "the cluster parent was not empty or could not be removed" });
        return result;
      } catch (error) {
        if (!(error instanceof AggregateError) && (recordedRoot === undefined || !existsSync(recordedRoot))) {
          if (!existsSync(clusterParent)) log.update(clusterEntry, { state: "absent", reason: "the cluster parent was never created" });
          else if (removeEmptyDirectory(clusterParent)) log.update(clusterEntry, { state: "removed", reason: "the helper cleaned up after itself; the empty parent was removed" });
          else log.update(clusterEntry, { state: "left", reason: "the cluster parent was not empty after the helper's cleanup" });
        } else {
          // The helper's cleanup did not complete (ruling A1-5 included): preserve and record.
          log.update(clusterEntry, { state: "left", reason: "the cluster helper's cleanup did not complete; the cluster root and parent are preserved" });
        }
        throw error;
      }
    },
    startApp: async (phase, environment): Promise<AppServer> => {
      const port = await freePort();
      if (PERSONAL_DEMO_PORTS.includes(port)) throw new E3Stop("Stopped (setup): the app port is a personal-demo port");
      const app = await startOwnedProcess(log, processes, {
        label: `next start ${phase}`,
        command: process.execPath,
        args: [nextEntry(), "start", "--hostname", VALIDATION_LOOPBACK, "--port", String(port)],
        cwd: worktree as string,
        env: { ...inheritedEnvironment(), ...environment },
        port,
        stdoutPath: join(out, `next-start-${phase}.out.log`),
        stderrPath: join(out, `next-start-${phase}.err.log`),
      });
      const recorded = log.entries()[app.entry]?.identity;
      if (recorded === undefined) throw new E3Stop(`Stopped (setup): next start ${phase} has no recorded identity`);
      return {
        port,
        server: { pid: recorded.pid, creationTime: recorded.creationTime },
        stop: () =>
          stopPhaseServer(app.entry, {
            entries: () => log.entries(),
            update: (id, patch) => log.update(id, patch),
            recordDescendants: () => recordDescendants(log, processes, app.entry, port),
            inspect: (pid) => processes.inspect(pid),
            stop: (pid) => processes.stop(pid),
            sleep,
            exitPolls: PROCESS_EXIT_POLLS,
            exitPollMs: PROCESS_EXIT_POLL_MS,
          }),
      };
    },
    send: sendE3,
    inspections,
    scanItems: async () => {
      const nextDirectory = join(worktree as string, ".next");
      const staticDirectory = join(nextDirectory, "static");
      const staticAssets: ScannedItem[] = [];
      const otherBuildFiles: ScannedItem[] = [];
      for (const path of filesUnder(nextDirectory)) {
        const item = { where: path.slice((worktree as string).length + 1), bytes: readFileSync(path) };
        (isWithin(path, staticDirectory) ? staticAssets : otherBuildFiles).push(item);
      }
      const logs = readdirSync(out).filter((name) => name.endsWith(".log")).map((name) => ({ where: name, bytes: readFileSync(join(out, name)) }));
      return { staticAssets, otherBuildFiles, logs };
    },
    fixtures,
    secrets,
    sleep,
    now: Date.now,
    signal: controller.signal,
    note: (message) => note(message),
  };

  let report: Awaited<ReturnType<typeof runE3Check>> | undefined;
  let safety: Awaited<ReturnType<typeof e3FinalSafety>>;
  try {
    report = await runE3Check(seams, inheritedEnvironment());
  } finally {
    clearTimeout(ceiling);
    uninstall();
    safety = await e3FinalSafety({
      teardown: () =>
        teardown({
          log,
          processes,
          git,
          clusters: helperClusterOps,
          tempDirectory,
          repositoryGitDirectory: join(REPOSITORY_ROOT, ".git"),
          includeClusters: false,
          deadline: Date.now() + TEARDOWN_ALLOWANCE_MINUTES * MINUTE,
        }),
      entries: () => log.entries(),
      residue: (entries) =>
        residueOf(entries, {
          processes,
          git,
          repositoryRoot: REPOSITORY_ROOT,
          repositoryGitDirectory: join(REPOSITORY_ROOT, ".git"),
          restrictedBaseline,
          statusBaseline,
          portIsFree,
        }),
    });
  }

  // The report is redacted already; the port is now known, so the full URL is redacted here too.
  const port = report.evidence.port;
  const finalRedact = createRedactor([secrets.password, port === undefined ? undefined : appDatabaseUrl(secrets, port)]);
  setRedactor(finalRedact);
  if (!safety.zeroResidue) print(`Resources may remain. Recovery needs its own authorization: ${cleanupCommand(out)}`);

  const header = {
    "Authorized commit": commit,
    Started: startedAt.toISOString(),
    Ended: new Date().toISOString(),
    Node: process.version,
    Platform: `${platform()} ${release()}`,
    Teardown: safety.zeroResidue ? "zero residue by the independent checks (processes, paths, ports, worktree records, repository state)" : `NOT clean: ${safety.problems.join("; ")}`,
  };
  writeFileSync(join(out, "e3-check.json"), `${JSON.stringify(redactDeep({ header, ...report, teardown: safety.teardown ?? null, safety: safety.problems }, finalRedact), null, 2)}\n`);
  writeFileSync(join(out, "e3-check.md"), `${finalRedact(renderE3Report(report, header))}\n`);

  for (const line of e3ConsoleLines(report, safety.problems)) print(line);
  print(`report in ${out}`);
  return e3ExitCode(report, safety);
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

  if (command === "e3-check") return e3Check(flags);

  if (command.startsWith("staging-")) {
    return stagingMain(command, flags, realStagingSeams((out) => outputDirectoryProblems(out, { repositoryRoot: REPOSITORY_ROOT, tempDirectory: tmpdir(), directoryEntries }), REPOSITORY_ROOT));
  }

  if (command === "validate-e2") {
    if (platform() !== "win32") throw new Error("the harness's process and cleanup operations are Windows-only");
    return runValidateE2(flags, realValidateSeams());
  }

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
