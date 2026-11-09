/**
 * Isolation, run state and cleanup for the `BI-4` timing pilot (issue #246; harness gate
 * revision 5 §5, §7–§10, §12; rulings `H-D5`, `H-D6`, `H-D10`, `H-D18`).
 *
 * ## What this module guarantees
 *
 * - **Refusal before creation (§7.1).** An occupied personal-demo port (3000 or 54329), a main
 *   tree that is not clean at the authorized commit, an inherited `LOCAL_DEMO_DATABASE_URL`, an
 *   unsuitable output directory, or a restricted-file baseline that cannot be taken: the harness
 *   refuses and changes nothing. A free port is **never** taken as evidence that the demo is
 *   stopped, and nothing here ever says it is.
 * - **An explicit disposable database URL (§8)**, built from the cluster this run started and
 *   checked before `next dev` is spawned.
 * - **An intent log (§9.1)** written and flushed before every resource is created, recording each
 *   process's identity (PID, operating-system creation time, executable, command line, port).
 * - **Ownership before every removal (§9.2).** A live process is checked against its recorded
 *   identity immediately before it is stopped, and stopped alone — `taskkill /PID <pid> /F`,
 *   never `/T`. An unrecorded process is reported, never stopped. Only the recorded worktree is
 *   removed, with `git worktree remove --force <recorded path>`; **`git worktree prune` is never
 *   run**, and a stale administrative record is reported, not removed. Nothing is ever stopped by
 *   name, image or port alone.
 * - **A run-specific cluster location, recorded before startup.** Each cluster's parent
 *   (`%TEMP%\cdp-bi4-cluster-<random>`) is logged and created before the shared helper is
 *   called. The helper's own root is redirected into it (`startUnderParent`), and its exact path
 *   is logged as soon as the helper has created it, before the server is initialised.
 *   Recovery removes only that recorded root and then the parent, and only when the parent is
 *   empty. It never searches for, or removes, anything it did not record.
 * - **Fail-closed cluster recovery.** A missing, unreadable, malformed or mismatched
 *   `postmaster.pid` is never taken as proof that a cluster is stopped
 *   (`establishClusterStopped`). Unless a verified shutdown or positive evidence of absence is
 *   available, the root and its parent are kept and the resource is reported as left, which
 *   makes `cleanup` exit nonzero.
 * - **A deterministic S-C kill point.** The child holds at a bounded checkpoint after its 10th
 *   measured request (`holdAtCheckpoint`), and the parent kills only after verifying its ready
 *   marker and identity.
 * - **Abort on signal (§9.3)** and a bounded teardown allowance (§12.3).
 * - **Smoke outcomes (§5).** Each pass's expected outcome is checked (`evaluateInProcessPass`,
 *   `evaluateForcedPass`). No pass starts after a cap or a failed prerequisite, the report is
 *   written after every pass and on failure, and anything but three passed passes exits nonzero
 *   (`driveSmoke`).
 * - **Restricted files and `.local-demo/` (§10).** `CLAUDE.md` and the handoff file are compared
 *   by metadata only (existence, size, modification time) and never read. `.local-demo/` is never
 *   opened, listed, stat-ed, read or written; the demo's ports are refusal conditions only.
 *
 * Every external effect goes through an injected seam, so the unit tests use fakes and start
 * nothing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  proveOwnedPostmaster,
  removeOwnedRoot,
  requestCompleteShutdown,
  waitForOwnedExit,
} from "../../src/data/testing/embedded-cluster";
import type { Boundary } from "./schedule";

/** The personal demo's site and database ports: refusal conditions only (`H-D6`). */
export const PERSONAL_DEMO_PORTS: readonly number[] = [3000, 54329];
export const LOOPBACK = "127.0.0.1";
export const DATABASE_NAME = "bi4_timing";
/** Every root the harness creates starts with this, inside the system temp directory. */
export const HARNESS_ROOT_PREFIX = "cdp-bi4-";
/** The two restricted files, by name only. Their contents are never read. */
export const RESTRICTED_FILES: readonly string[] = ["CLAUDE.md", "community-directory-through-issue-51-handoff.txt"];
/** The only lines `git status --porcelain` may show in the main tree. */
const ALLOWED_STATUS_LINES = new Set(RESTRICTED_FILES.map((name) => `?? ${name}`));

// ---------------------------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------------------------

/** Canonical form for comparison: real path where possible, resolved, case-folded on Windows. */
export function canonical(path: string, real: (path: string) => string = realpathSync): string {
  let resolved: string;

  try {
    resolved = resolve(real(path));
  } catch {
    resolved = resolve(path);
  }

  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether `child` is `parent` or lies inside it, compared canonically. */
export function isWithin(child: string, parent: string, real?: (path: string) => string): boolean {
  const c = canonical(child, real);
  const p = canonical(parent, real);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

/** Whether a path is a harness-owned root: directly inside the temp directory, `cdp-bi4-…`. */
export function isHarnessRoot(path: string, tempDirectory: string, real?: (path: string) => string): boolean {
  return (
    canonical(dirname(resolve(path)), real) === canonical(tempDirectory, real) &&
    basename(path).startsWith(HARNESS_ROOT_PREFIX)
  );
}

// ---------------------------------------------------------------------------------------------
// §7.1 Refusal conditions, checked before anything is created.
// ---------------------------------------------------------------------------------------------

export interface RestrictedMetadata {
  readonly [name: string]: { readonly exists: boolean; readonly size?: number; readonly mtimeMs?: number };
}

/** Existence, size and modification time only. Never opens or reads either file. */
export function restrictedMetadataOf(
  repositoryRoot: string,
  stat: (path: string) => { size: number; mtimeMs: number } | undefined = (path) => {
    try {
      const entry = statSync(path);
      return { size: entry.size, mtimeMs: entry.mtimeMs };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  },
): RestrictedMetadata {
  return Object.fromEntries(
    RESTRICTED_FILES.map((name) => {
      const entry = stat(join(repositoryRoot, name));
      return [name, entry === undefined ? { exists: false } : { exists: true, size: entry.size, mtimeMs: entry.mtimeMs }];
    }),
  );
}

/** Names whose metadata changed between two snapshots. */
export function restrictedChanges(before: RestrictedMetadata, after: RestrictedMetadata): readonly string[] {
  return RESTRICTED_FILES.filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
}

export interface PreconditionSeams {
  readonly repositoryRoot: string;
  readonly tempDirectory: string;
  readonly authorizedCommit: string;
  readonly outputDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  portIsFree(host: string, port: number): Promise<boolean>;
  gitHead(): Promise<string>;
  gitStatusPorcelain(): Promise<string>;
  /** `undefined` when the path does not exist. */
  directoryEntries(path: string): readonly string[] | undefined;
  realpath?(path: string): string;
  restrictedMetadata(): RestrictedMetadata;
}

export interface PreconditionResult {
  readonly refusals: readonly string[];
  readonly restrictedBaseline?: RestrictedMetadata;
  readonly statusBaseline?: string;
}

/** Problems with the owner-named output directory (`H-D9`, chosen at run authorization). */
export function outputDirectoryProblems(
  outputDirectory: string,
  seams: Pick<PreconditionSeams, "repositoryRoot" | "tempDirectory" | "directoryEntries" | "realpath">,
): readonly string[] {
  const problems: string[] = [];

  if (!isAbsolute(outputDirectory)) {
    return ["the output directory must be an absolute path"];
  }

  const entries = seams.directoryEntries(outputDirectory);

  if (entries === undefined) problems.push("the output directory must already exist");
  else if (entries.length > 0) problems.push("the output directory must be empty");
  if (isWithin(outputDirectory, seams.repositoryRoot, seams.realpath)) problems.push("the output directory must be outside the repository");
  if (isWithin(seams.repositoryRoot, outputDirectory, seams.realpath)) problems.push("the output directory must not contain the repository");
  if (isWithin(outputDirectory, seams.tempDirectory, seams.realpath)) {
    problems.push("the output directory must be outside the system temp directory, where every harness root is created");
  }
  if (isWithin(seams.tempDirectory, outputDirectory, seams.realpath)) {
    problems.push("the output directory must not be a parent of the system temp directory, and so of any harness root");
  }

  return problems;
}

/** Every §7.1 refusal condition. Nothing is created or changed by this check. */
export async function checkPreconditions(seams: PreconditionSeams): Promise<PreconditionResult> {
  const refusals: string[] = [];

  for (const port of PERSONAL_DEMO_PORTS) {
    if (!(await seams.portIsFree(LOOPBACK, port))) {
      refusals.push(
        `port ${port} on ${LOOPBACK} is occupied; it is a personal-demo port, so the harness refuses whatever is listening on it`,
      );
    }
  }

  const head = (await seams.gitHead()).trim();
  if (head !== seams.authorizedCommit) refusals.push(`the main tree is at ${head}, not the authorized commit ${seams.authorizedCommit}`);

  const status = await seams.gitStatusPorcelain();
  const unexpected = status.split(/\r?\n/).filter((line) => line.trim() !== "" && !ALLOWED_STATUS_LINES.has(line.trimEnd()));
  if (unexpected.length > 0) refusals.push(`the main tree is not clean: ${unexpected.length} unexpected status line(s)`);

  if (seams.environment.LOCAL_DEMO_DATABASE_URL !== undefined) {
    refusals.push("LOCAL_DEMO_DATABASE_URL is set in the harness's own environment; the harness never inherits a database URL");
  }

  refusals.push(...outputDirectoryProblems(seams.outputDirectory, seams));

  let restrictedBaseline: RestrictedMetadata | undefined;
  try {
    restrictedBaseline = seams.restrictedMetadata();
  } catch (error) {
    refusals.push(`the restricted-file metadata baseline could not be taken: ${(error as Error).message}`);
  }

  return { refusals, ...(restrictedBaseline === undefined ? {} : { restrictedBaseline }), statusBaseline: status };
}

/** Whether something is listening on `host:port`, by trying to bind it briefly. A check only. */
export function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((accept) => {
    const probe = net.createServer();
    probe.once("error", () => accept(false));
    probe.listen(port, host, () => probe.close(() => accept(true)));
  });
}

// ---------------------------------------------------------------------------------------------
// §8 The explicit disposable database URL.
// ---------------------------------------------------------------------------------------------

export function buildDatabaseUrl(parts: { readonly user: string; readonly password: string; readonly port: number }): string {
  return `postgres://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${LOOPBACK}:${parts.port}/${DATABASE_NAME}`;
}

/** The URL with its password removed, for the intent log and diagnostics. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "redacted";
    return parsed.toString();
  } catch {
    return "(unparseable database URL)";
  }
}

/** Every §8 check, before `next dev` is spawned. An empty result means the URL may be used. */
export function databaseUrlProblems(
  url: string,
  recorded: { readonly port: number; readonly clusterDirectory: string },
  readPidFile?: (path: string) => string,
): readonly string[] {
  const problems: string[] = [];
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return ["the database URL does not parse"];
  }

  if (parsed.protocol !== "postgres:") problems.push("the database URL scheme must be postgres:");
  if (parsed.hostname !== LOOPBACK) problems.push(`the database host must be exactly ${LOOPBACK}`);
  if (Number(parsed.port) !== recorded.port) problems.push("the database port is not the recorded port of this run's cluster");
  if (PERSONAL_DEMO_PORTS.includes(Number(parsed.port))) problems.push("the database port is a personal-demo port");
  if (parsed.pathname !== `/${DATABASE_NAME}`) problems.push(`the database must be ${DATABASE_NAME}`);

  try {
    proveOwnedPostmaster(recorded.clusterDirectory, readPidFile);
  } catch {
    problems.push("the cluster's postmaster.pid does not claim the recorded data directory");
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// §9.1 The intent log.
// ---------------------------------------------------------------------------------------------

export interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  /** Operating-system creation time, compared exactly (Windows FILETIME ticks as a string). */
  readonly creationTime: string;
  readonly executable: string | null;
  readonly commandLine: string | null;
}

export type ResourceKind = "harness-root" | "cluster" | "worktree" | "process";
export type ResourceState = "intended" | "created" | "stopped" | "removed" | "absent" | "left";

export interface ResourceEntry {
  readonly id: number;
  readonly kind: ResourceKind;
  readonly label: string;
  readonly state: ResourceState;
  readonly path?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly identity?: ProcessIdentity;
  /** The intent-log entry of the process this one descends from. */
  readonly parentEntry?: number;
  readonly clusterDirectory?: string;
  /** For a cluster: the run-specific parent the helper's root is created in, recorded before startup. */
  readonly parent?: string;
  readonly postmaster?: ProcessIdentity;
  readonly commit?: string;
  /** The worktree's administrative record name under `.git/worktrees/`. */
  readonly adminRecord?: string;
  readonly reason?: string;
}

export interface LogStore {
  read(path: string): string | undefined;
  /** Write the whole file durably: write, flush to disk, then replace. */
  writeDurably(path: string, text: string): void;
}

export const fileLogStore: LogStore = {
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  writeDurably: (path, text) => {
    const temporary = `${path}.tmp`;
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  },
};

/** `<out>/run-state.json`: every resource, appended and flushed before it is created. */
export class IntentLog {
  private readonly entriesById: ResourceEntry[] = [];
  private readonly events: { readonly at: string; readonly event: string; readonly id?: number }[] = [];

  constructor(
    readonly path: string,
    private readonly store: LogStore = fileLogStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    const existing = store.read(path);

    if (existing !== undefined) {
      const parsed = JSON.parse(existing) as { entries: ResourceEntry[]; events: IntentLog["events"] };
      this.entriesById.push(...parsed.entries);
      this.events.push(...parsed.events);
    }
  }

  /** Record a resource **before** it is created, and flush. Returns its id. */
  intend(kind: ResourceKind, label: string, fields: Partial<Omit<ResourceEntry, "id" | "kind" | "label" | "state">> = {}): number {
    const id = this.entriesById.length;
    this.entriesById.push({ id, kind, label, state: "intended", ...fields });
    this.note(`intend ${kind} ${label}`, id);
    return id;
  }

  update(id: number, fields: Partial<Omit<ResourceEntry, "id" | "kind" | "label">>): void {
    const entry = this.entriesById[id];
    if (entry === undefined) throw new Error(`no intent-log entry ${id}`);
    this.entriesById[id] = { ...entry, ...fields };
    this.note(`update ${entry.kind} ${entry.label}${fields.state === undefined ? "" : ` → ${fields.state}`}`, id);
  }

  note(event: string, id?: number): void {
    this.events.push({ at: this.now().toISOString(), event, ...(id === undefined ? {} : { id }) });
    this.store.writeDurably(this.path, `${JSON.stringify({ version: 1, entries: this.entriesById, events: this.events }, null, 2)}\n`);
  }

  entries(): readonly ResourceEntry[] {
    return [...this.entriesById];
  }
}

// ---------------------------------------------------------------------------------------------
// §9.2 Process identity.
// ---------------------------------------------------------------------------------------------

export interface ProcessOps {
  /**
   * The live identity, or `undefined` **only** when a successful lookup found no such process. A
   * failed, malformed, ambiguous or incomplete lookup throws `ProcessInspectionError`.
   */
  inspect(pid: number): Promise<ProcessIdentity | undefined>;
  children(pid: number): Promise<readonly ProcessIdentity[]>;
  /** The PID listening on `127.0.0.1:port` (or any address), if any. */
  listener(port: number): Promise<number | undefined>;
  /** Stop exactly one process. Never a tree. */
  stop(pid: number): Promise<void>;
}

/** The only `taskkill` arguments the harness ever uses: one PID, forced, never `/T`. */
export function taskkillArguments(pid: number): readonly string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`refusing to build a taskkill for pid ${pid}`);
  return ["/PID", String(pid), "/F"];
}

export type ProcessCheck =
  | { readonly status: "verified" }
  | { readonly status: "absent"; readonly reason: string }
  | { readonly status: "mismatch"; readonly reason: string };

/**
 * Compare a live process with its recorded identity, immediately before stopping it. A different
 * creation time means the PID was reused: the recorded process is gone and the live one is not
 * ours, so nothing is stopped. `verified` (the only status that permits a stop or a cluster
 * shutdown) also needs a non-blank executable and command line on **both** sides, equal to each
 * other. Missing or blank values are `mismatch`, never a match.
 */
export function checkProcessIdentity(
  recorded: ProcessIdentity,
  live: ProcessIdentity | undefined,
  port?: { readonly port: number; readonly listener: number | undefined },
): ProcessCheck {
  if (live === undefined) return { status: "absent", reason: "no process has the recorded PID" };
  // An identity without a usable creation time cannot show that the PID was reused, so it is
  // never read as absence.
  const usable = (value: unknown): boolean => typeof value === "string" && /^\d+$/.test(value);
  if (!usable(live.creationTime) || !usable(recorded.creationTime) || live.pid !== recorded.pid) {
    return { status: "mismatch", reason: "the live or recorded identity is incomplete; absence cannot be established" };
  }
  // PID reuse is decided by valid creation times alone, so it still works when CIM withholds
  // the executable or command line.
  if (live.creationTime !== recorded.creationTime) {
    return { status: "absent", reason: "the PID now belongs to a different process (creation time differs); nothing stopped" };
  }
  // A null or blank executable or command line stays representable, but it never verifies a live
  // process. Two unavailable values are not a match, so nothing is stopped and no shutdown is
  // requested on their strength.
  const available = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";
  if (!available(recorded.executable) || !available(live.executable)) {
    return { status: "mismatch", reason: "the executable path is unavailable in the recorded or live identity; the process cannot be verified" };
  }
  if (!available(recorded.commandLine) || !available(live.commandLine)) {
    return { status: "mismatch", reason: "the command line is unavailable in the recorded or live identity; the process cannot be verified" };
  }
  if (live.executable !== recorded.executable) return { status: "mismatch", reason: "executable path differs from the recorded identity" };
  if (live.commandLine !== recorded.commandLine) return { status: "mismatch", reason: "command line differs from the recorded identity" };
  if (port !== undefined && port.listener !== undefined && port.listener !== recorded.pid) {
    return { status: "mismatch", reason: `port ${port.port} is held by another process` };
  }
  return { status: "verified" };
}

type Runner = (command: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Run a command with an argument array and no shell. */
export const runFile: Runner = (command, args) =>
  new Promise((accept, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => accept({ code, stdout, stderr }));
  });

const POWERSHELL = "powershell.exe";

/**
 * A process lookup that failed or was ambiguous. It is **never** absence: callers that cannot
 * establish whether a process exists must leave the resource unresolved.
 */
export class ProcessInspectionError extends Error {
  constructor(detail: string) {
    super(`process inspection failed: ${detail}`);
    this.name = "ProcessInspectionError";
  }
}

/**
 * The CIM query, wrapped in an explicit success envelope: `{"ok":true,"processes":[...]}`. Any
 * error is terminating (`$ErrorActionPreference = 'Stop'`), so a failed query exits nonzero
 * instead of printing nothing. Empty output can therefore never be mistaken for "no process".
 */
export function identityScript(filter: string): string {
  return (
    `$ErrorActionPreference = 'Stop'; ` +
    `$found = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ ` +
    `pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; ` +
    `creationTime = $_.CreationDate.ToFileTimeUtc().ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } }); ` +
    `ConvertTo-Json -InputObject @{ ok = $true; processes = $found } -Compress -Depth 3`
  );
}

/**
 * Parse a lookup's result, or throw `ProcessInspectionError`. Success needs every one of these:
 * - exit code 0 and empty stderr;
 * - the `ok: true` envelope with a `processes` array;
 * - every entry a complete identity: integer PID and parent PID, a decimal creation time, and
 *   an executable and command line that are each a string or `null` (access denied).
 *
 * Only then does an empty array mean that no process matched.
 */
export function parseInspection(result: { readonly code: number | null; readonly stdout: string; readonly stderr: string }): ProcessIdentity[] {
  if (result.code !== 0) throw new ProcessInspectionError(`PowerShell exited ${result.code}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`}`);
  if (result.stderr.trim() !== "") throw new ProcessInspectionError(`PowerShell wrote to stderr: ${result.stderr.trim()}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new ProcessInspectionError(`the result is not JSON: ${JSON.stringify(result.stdout.trim().slice(0, 80))}`);
  }

  const envelope = parsed as { ok?: unknown; processes?: unknown } | null;
  if (envelope === null || typeof envelope !== "object" || envelope.ok !== true || !Array.isArray(envelope.processes)) {
    throw new ProcessInspectionError("the result lacks the success envelope");
  }

  return envelope.processes.map((entry: unknown) => {
    const candidate = entry as Partial<Record<keyof ProcessIdentity, unknown>> | null;
    const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid as number) <= 0 ||
      !Number.isSafeInteger(candidate.parentPid) ||
      (candidate.parentPid as number) < 0 ||
      typeof candidate.creationTime !== "string" ||
      !/^\d+$/.test(candidate.creationTime) ||
      !("executable" in candidate) ||
      !nullableString(candidate.executable) ||
      !("commandLine" in candidate) ||
      !nullableString(candidate.commandLine)
    ) {
      throw new ProcessInspectionError(`an incomplete process identity was returned: ${JSON.stringify(entry)}`);
    }
    return {
      pid: candidate.pid as number,
      parentPid: candidate.parentPid as number,
      creationTime: candidate.creationTime,
      executable: candidate.executable,
      commandLine: candidate.commandLine,
    };
  });
}

/** One listening TCP endpoint on a port: its local address and owning process. */
export interface ListeningEntry {
  readonly localAddress: string;
  readonly owningProcess: number;
}

/** `MSFT_NetTCPConnection.State` for a listening socket. */
const TCP_STATE_LISTEN = 2;

/**
 * The strict listener lookup's query (V-A only; `listener(port)` is unchanged). Every listening
 * TCP endpoint on the port, from CIM, which returns an empty set for no match rather than an
 * error. Errors are terminating (`$ErrorActionPreference = 'Stop'`) and nothing is suppressed, so a
 * failed query exits nonzero. The `ok: true` envelope separates a genuinely empty result from a
 * failure.
 */
export function listenerLookupScript(port: number): string {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`not a TCP port: ${port}`);
  return (
    `$ErrorActionPreference = 'Stop'; ` +
    `$found = @(Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'LocalPort = ${port} AND State = ${TCP_STATE_LISTEN}' | ` +
    `ForEach-Object { [pscustomobject]@{ localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; owningProcess = [int]$_.OwningProcess } }); ` +
    `ConvertTo-Json -InputObject @{ ok = $true; port = ${port}; entries = $found } -Compress -Depth 3`
  );
}

/**
 * Parse the strict lookup's result, or throw `ProcessInspectionError`. Success needs exit code 0,
 * empty stderr, the `ok: true` envelope for the requested port, and every entry a non-empty local
 * address, the requested port and a positive integer PID. Only then does an empty array mean the
 * port is unbound. Several entries are returned as they are; the caller decides.
 */
export function parseListenerLookup(port: number, result: { readonly code: number | null; readonly stdout: string; readonly stderr: string }): readonly ListeningEntry[] {
  if (result.code !== 0) throw new ProcessInspectionError(`the listener lookup for port ${port}: PowerShell exited ${result.code}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`}`);
  if (result.stderr.trim() !== "") throw new ProcessInspectionError(`the listener lookup for port ${port}: PowerShell wrote to stderr: ${result.stderr.trim()}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new ProcessInspectionError(`the listener lookup for port ${port} is not JSON: ${JSON.stringify(result.stdout.trim().slice(0, 80))}`);
  }

  const envelope = parsed as { ok?: unknown; port?: unknown; entries?: unknown } | null;
  if (envelope === null || typeof envelope !== "object" || envelope.ok !== true || envelope.port !== port || !Array.isArray(envelope.entries)) {
    throw new ProcessInspectionError(`the listener lookup for port ${port} lacks the success envelope`);
  }

  return envelope.entries.map((entry: unknown) => {
    const candidate = entry as { localAddress?: unknown; localPort?: unknown; owningProcess?: unknown } | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.localAddress !== "string" ||
      candidate.localAddress === "" ||
      candidate.localPort !== port ||
      !Number.isSafeInteger(candidate.owningProcess) ||
      (candidate.owningProcess as number) <= 0
    ) {
      throw new ProcessInspectionError(`the listener lookup for port ${port} returned a malformed entry: ${JSON.stringify(entry)}`);
    }
    return { localAddress: candidate.localAddress, owningProcess: candidate.owningProcess as number };
  });
}

/** The strict listener lookup for V-A. A failure to run PowerShell is an inspection failure, never "unbound". */
export function windowsListenerLookup(run: Runner = runFile): (port: number) => Promise<readonly ListeningEntry[]> {
  return async (port) => {
    const script = listenerLookupScript(port);
    let result: Awaited<ReturnType<Runner>>;
    try {
      result = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script]);
    } catch (error) {
      throw new ProcessInspectionError(`PowerShell could not be run for the listener lookup: ${(error as Error).message}`);
    }
    return parseListenerLookup(port, result);
  };
}

/** Windows process operations: CIM queries for identity, `taskkill /PID <pid> /F` to stop one. */
export function windowsProcessOps(run: Runner = runFile): ProcessOps {
  const integer = (value: number): number => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`not a positive integer: ${value}`);
    return value;
  };
  const powershell = (script: string) => run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script]);
  /** Run a lookup; a failure to start PowerShell is an inspection failure too, never absence. */
  const lookup = async (filter: string): Promise<ProcessIdentity[]> => {
    let result: Awaited<ReturnType<typeof powershell>>;
    try {
      result = await powershell(identityScript(filter));
    } catch (error) {
      throw new ProcessInspectionError(`PowerShell could not be run: ${(error as Error).message}`);
    }
    return parseInspection(result);
  };

  return {
    /** `undefined` only after a successful lookup that matched nothing; otherwise throws. */
    async inspect(pid) {
      const found = await lookup(`ProcessId = ${integer(pid)}`);
      if (found.length > 1) throw new ProcessInspectionError(`${found.length} processes matched pid ${pid}`);
      const [only] = found;
      if (only !== undefined && only.pid !== pid) throw new ProcessInspectionError(`the lookup for pid ${pid} returned pid ${only.pid}`);
      return only;
    },
    async children(pid) {
      const found = await lookup(`ParentProcessId = ${integer(pid)}`);
      if (found.some((entry) => entry.parentPid !== pid)) throw new ProcessInspectionError(`the child lookup for pid ${pid} returned another parent's process`);
      return found;
    },
    async listener(port) {
      const { code, stdout, stderr } = await powershell(
        `@(Get-NetTCPConnection -State Listen -LocalPort ${integer(port)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
      );
      if (code !== 0 || stderr.trim() !== "") throw new ProcessInspectionError(`the listener lookup for port ${port} failed (exit ${code})`);
      const text = stdout.trim();
      if (text === "") return undefined;
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value <= 0) throw new ProcessInspectionError(`the listener lookup for port ${port} returned ${JSON.stringify(text)}`);
      return value;
    },
    async stop(pid) {
      const { code, stderr } = await run("taskkill", taskkillArguments(pid));
      if (code !== 0) throw new Error(`taskkill for pid ${pid} exited ${code}: ${stderr.trim()}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Git: worktree creation and the recorded worktree's removal. There is no prune operation.
// ---------------------------------------------------------------------------------------------

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly detached: boolean;
  readonly prunable: boolean;
}

export function parseWorktreeList(porcelain: string): readonly WorktreeEntry[] {
  return porcelain
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line !== ""))
    .filter((lines) => lines.length > 0 && (lines[0] as string).startsWith("worktree "))
    .map((lines) => {
      const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
      return {
        path: (lines[0] as string).slice("worktree ".length),
        ...(head === undefined ? {} : { head }),
        detached: lines.includes("detached"),
        prunable: lines.some((line) => line.startsWith("prunable")),
      };
    });
}

export interface GitOps {
  head(): Promise<string>;
  statusPorcelain(): Promise<string>;
  worktreeList(): Promise<readonly WorktreeEntry[]>;
  addDetachedWorktree(path: string, commit: string): Promise<void>;
  /** `git worktree remove --force <recorded path>` — the only removal there is. */
  removeWorktree(path: string): Promise<void>;
}

/** Git through an argument array in the main tree. Every argument list is visible to the tests. */
export function createGitOps(repositoryRoot: string, run: Runner = runFile): GitOps {
  const git = async (args: readonly string[]): Promise<string> => {
    const { code, stdout, stderr } = await run("git", ["-C", repositoryRoot, ...args]);
    if (code !== 0) throw new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`);
    return stdout;
  };

  return {
    head: async () => (await git(["rev-parse", "HEAD"])).trim(),
    statusPorcelain: () => git(["status", "--porcelain"]),
    worktreeList: async () => parseWorktreeList(await git(["worktree", "list", "--porcelain"])),
    addDetachedWorktree: async (path, commit) => {
      await git(["worktree", "add", "--detach", path, commit]);
    },
    removeWorktree: async (path) => {
      await git(["worktree", "remove", "--force", path]);
    },
  };
}

/** The administrative record a worktree's `.git` file names (`gitdir: …/.git/worktrees/<name>`). */
export function adminRecordOf(gitFile: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
  if (match === null) return undefined;
  const gitdir = (match[1] as string).replace(/\\/g, "/");
  const parts = gitdir.split("/");
  return parts.at(-2) === "worktrees" ? parts.at(-1) : undefined;
}

export type WorktreeCheck =
  | { readonly status: "verified" }
  | { readonly status: "absent"; readonly reason: string }
  | { readonly status: "stale-record"; readonly reason: string }
  | { readonly status: "mismatch"; readonly reason: string };

/** §9.2 for the recorded worktree. Only a verified worktree may be removed. */
export function checkWorktree(
  entry: Pick<ResourceEntry, "path" | "commit" | "adminRecord">,
  list: readonly WorktreeEntry[],
  seams: {
    readonly directoryExists: (path: string) => boolean;
    readonly readGitFile: (worktreePath: string) => string | undefined;
    readonly adminRecordExists: (name: string) => boolean;
    readonly realpath?: (path: string) => string;
  },
): WorktreeCheck {
  if (entry.path === undefined || entry.commit === undefined) return { status: "mismatch", reason: "the intent log has no recorded path or commit" };

  const listed = list.find((candidate) => canonical(candidate.path, seams.realpath) === canonical(entry.path as string, seams.realpath));
  const exists = seams.directoryExists(entry.path);
  const recordExists = entry.adminRecord !== undefined && seams.adminRecordExists(entry.adminRecord);

  if (!exists) {
    return listed !== undefined || recordExists
      ? { status: "stale-record", reason: "the recorded directory is gone but its administrative record remains; not pruned, left for an owner ruling" }
      : { status: "absent", reason: "the recorded worktree and its record are both gone" };
  }

  if (listed === undefined) return { status: "mismatch", reason: "git worktree list does not show a worktree at the recorded path" };
  if (listed.head !== entry.commit) return { status: "mismatch", reason: "the worktree's HEAD is not the authorized commit" };
  if (!listed.detached) return { status: "mismatch", reason: "the worktree is not detached" };

  const gitFile = seams.readGitFile(entry.path);
  if (gitFile === undefined || adminRecordOf(gitFile) !== entry.adminRecord) {
    return { status: "mismatch", reason: "the worktree's .git file does not name the recorded administrative record" };
  }

  return { status: "verified" };
}

// ---------------------------------------------------------------------------------------------
// Clusters (recovery path only; the normal path is the helper's own cleanup).
// ---------------------------------------------------------------------------------------------

/** Every run-specific cluster parent starts with this, directly inside the temp directory. */
export const CLUSTER_PARENT_PREFIX = `${HARNESS_ROOT_PREFIX}cluster-`;

/** The helper names its root `cdp-<slug>-XXXXXX` (`mkdtemp`'s six-character suffix). */
export function clusterRootPattern(slug: string): RegExp {
  return new RegExp(`^cdp-${slug.replace(/[^A-Za-z0-9]/g, (character) => `\\${character}`)}-[A-Za-z0-9]{6}$`);
}

/** The temp-directory variables `os.tmpdir()` reads: `TEMP`/`TMP` on Windows, `TMPDIR` elsewhere. */
export const TEMP_VARIABLES = ["TEMP", "TMP", "TMPDIR"] as const;

/**
 * Call `start` with the temp directory pointed at `parent`, then restore it before returning.
 *
 * The shared helper creates its root with `mkdtempSync(join(tmpdir(), …))` synchronously, before
 * its first `await`. An async function runs synchronously up to its first `await`, so the root
 * is created inside `parent` while the variables are redirected. The variables are restored
 * before this returns, so nothing the server or the harness does later sees them. The caller
 * then confirms where the root actually went (`locateClusterRoot`) and refuses to continue on any
 * mismatch. It does not depend on this assumption silently holding.
 */
export function startUnderParent<T>(parent: string, start: () => Promise<T>, environment: NodeJS.ProcessEnv = process.env): Promise<T> {
  const saved = TEMP_VARIABLES.map((name) => [name, environment[name]] as const);

  for (const name of TEMP_VARIABLES) environment[name] = parent;

  try {
    return start();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  }
}

/**
 * The helper's root inside a run-specific parent the harness created moments earlier: exactly one
 * entry, named exactly as the helper names its roots. Anything else is a problem, never a guess.
 */
export function locateClusterRoot(
  parent: string,
  slug: string,
  list: (path: string) => readonly string[] | undefined = directoryEntries,
): { readonly path: string } | { readonly problem: string } {
  const entries = list(parent);
  if (entries === undefined) return { problem: "the run's cluster parent does not exist" };
  if (entries.length !== 1) return { problem: `the run's cluster parent holds ${entries.length} entries, not exactly the helper's root` };
  const name = entries[0] as string;
  if (!clusterRootPattern(slug).test(name)) return { problem: `the entry ${JSON.stringify(name)} is not named as the helper names a ${slug} root` };
  return { path: join(parent, name) };
}

/** Why a cluster entry's recorded location is not one this run owns. Empty means it is. */
export function clusterLocationProblems(entry: ResourceEntry, tempDirectory: string, real?: (path: string) => string): readonly string[] {
  const problems: string[] = [];

  if (entry.parent === undefined) return ["no run-specific cluster parent was recorded"];
  if (!isHarnessRoot(entry.parent, tempDirectory, real) || !basename(entry.parent).startsWith(CLUSTER_PARENT_PREFIX)) {
    problems.push("the recorded cluster parent is not a harness cluster parent directly inside the temp directory");
  }

  if (entry.path !== undefined) {
    if (canonical(dirname(resolve(entry.path)), real) !== canonical(entry.parent, real)) problems.push("the recorded cluster root is not directly inside the recorded parent");
    if (!clusterRootPattern(entry.label).test(basename(entry.path))) problems.push("the recorded cluster root is not named as the helper names this run's roots");
    if (entry.clusterDirectory === undefined || canonical(entry.clusterDirectory, real) !== canonical(join(entry.path, "cluster"), real)) {
      problems.push("the recorded cluster directory is not the recorded root's cluster directory");
    }
  } else if (entry.clusterDirectory !== undefined) {
    problems.push("a cluster directory is recorded without its root");
  }

  return problems;
}

/** Remove a directory only if it is empty; never recursive. */
export function removeEmptyDirectory(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a cluster's `postmaster.pid` shows. Only `proven` names a PID; every other status is an
 * absence of evidence, and none of them is ever taken as proof that the cluster is stopped.
 */
export type PidFileEvidence =
  | { readonly status: "proven"; readonly pid: number }
  | { readonly status: "missing" }
  | { readonly status: "unreadable" | "malformed" | "mismatch"; readonly detail: string };

/**
 * Classify `postmaster.pid` without acting on it. The parsing rules are the helper's own
 * (`proveOwnedPostmaster`), which also makes the data-directory comparison. This only separates
 * a missing file from one that could not be read, is malformed, or claims another directory.
 */
export function readPidFileEvidence(
  clusterDirectory: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  prove: (directory: string, readPidFile: (path: string) => string) => { readonly pid: number } = proveOwnedPostmaster,
): PidFileEvidence {
  let contents: string;

  try {
    contents = read(join(clusterDirectory, "postmaster.pid"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable", detail: (error as Error).message };
  }

  const [rawPid = "", rawDirectory = ""] = contents.split(/\r?\n/).map((line) => line.trim());
  const pid = Number(rawPid);
  if (!/^\d+$/.test(rawPid) || !Number.isSafeInteger(pid) || pid <= 0 || rawDirectory === "") {
    return { status: "malformed", detail: "line 1 is not a positive PID or line 2 claims no data directory" };
  }

  try {
    return { status: "proven", pid: prove(clusterDirectory, () => contents).pid };
  } catch (error) {
    return { status: "mismatch", detail: (error as Error).message };
  }
}

export interface ClusterOps {
  provePostmaster(clusterDirectory: string): PidFileEvidence;
  shutdown(clusterDirectory: string): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  waitForExit(pid: number): Promise<boolean>;
  removeRoot(root: string): Promise<boolean>;
}

export const helperClusterOps: ClusterOps = {
  provePostmaster: (clusterDirectory) => readPidFileEvidence(clusterDirectory),
  shutdown: async (clusterDirectory) => {
    const outcome = await requestCompleteShutdown(clusterDirectory);
    return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail };
  },
  waitForExit: async (pid) => (await waitForOwnedExit(pid)).exited,
  removeRoot: async (root) => (await removeOwnedRoot(root)).removed,
};

// ---------------------------------------------------------------------------------------------
// §9.2–§9.4, §12.3 Teardown and recovery cleanup.
// ---------------------------------------------------------------------------------------------

export interface TeardownSeams {
  readonly log: IntentLog;
  readonly processes: ProcessOps;
  readonly git: GitOps;
  readonly clusters: ClusterOps;
  readonly tempDirectory: string;
  readonly repositoryGitDirectory: string;
  /** Include clusters: true for `cleanup`; false inside the helper's body, which owns its own. */
  readonly includeClusters: boolean;
  /** Absolute time (ms) after which no further teardown step is attempted (§12.3). */
  readonly deadline: number;
  readonly now?: () => number;
  readonly directoryExists?: (path: string) => boolean;
  readonly readGitFile?: (worktreePath: string) => string | undefined;
  readonly removeDirectory?: (path: string) => Promise<boolean>;
  readonly realpath?: (path: string) => string;
  /** Lists a recorded cluster parent; used only to confirm it is empty before removing it. */
  readonly listDirectory?: (path: string) => readonly string[] | undefined;
  readonly removeEmptyDirectory?: (path: string) => boolean;
  /** Waits between process-exit polls and between worktree removal attempts. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Process-exit confirmation before a worktree is removed: polls, and the pause between them. */
export const PROCESS_EXIT_POLLS = 60;
export const PROCESS_EXIT_POLL_MS = 500;
/** `git worktree remove` attempts per worktree, and the pause before each retry. */
export const WORKTREE_REMOVE_ATTEMPTS = 5;
export const WORKTREE_RETRY_DELAY_MS = 3_000;

export interface TeardownReport {
  readonly stopped: readonly number[];
  readonly removed: readonly number[];
  readonly absent: readonly number[];
  readonly left: readonly { readonly id: number; readonly reason: string }[];
  readonly allowanceExhausted: boolean;
}

const SETTLED: readonly ResourceState[] = ["stopped", "removed", "absent"];

/** Depth of a process entry in the recorded parent chain, for deepest-first stopping. */
function depthOf(entry: ResourceEntry, entries: readonly ResourceEntry[]): number {
  let depth = 0;
  let current: ResourceEntry | undefined = entry;
  while (current?.parentEntry !== undefined) {
    depth += 1;
    current = entries[current.parentEntry];
  }
  return depth;
}

/**
 * Whether a recorded cluster can be shown to be stopped: `true`, or the reason it cannot.
 *
 * Absence is established only by positive evidence:
 * - the recorded postmaster is verified and a `pg_ctl` shutdown completes with its exit observed;
 * - or the recorded postmaster is gone, and `postmaster.pid` is either proven to name that same
 *   PID or a PID that is also gone, or is missing (a postmaster exits when its lock file goes);
 * - or, with no recorded identity, `postmaster.pid` is proven and names a PID that is gone.
 *
 * An unreadable, malformed or mismatched `postmaster.pid` never establishes anything. A missing
 * one establishes nothing on its own: it needs the recorded postmaster to be verified gone. A
 * live postmaster whose identity was never recorded is never stopped. A root that is already
 * gone is accepted only if the recorded postmaster is not alive.
 */
export async function establishClusterStopped(
  entry: ResourceEntry,
  evidence: PidFileEvidence,
  rootExists: boolean,
  seams: Pick<TeardownSeams, "processes" | "clusters">,
): Promise<true | string> {
  const recorded = entry.postmaster;
  const recordedCheck = recorded === undefined ? undefined : checkProcessIdentity(recorded, await seams.processes.inspect(recorded.pid));
  const recordedGone = recordedCheck?.status === "absent";

  if (!rootExists) {
    return recordedCheck === undefined || recordedGone ? true : `the root is gone but the recorded postmaster ${recorded?.pid} is still alive`;
  }

  switch (evidence.status) {
    case "unreadable":
    case "malformed":
    case "mismatch":
      return `postmaster.pid is ${evidence.status} (${evidence.detail}); neither shutdown nor absence can be established`;
    case "missing":
      if (recordedCheck === undefined) return "postmaster.pid is missing and no postmaster identity was recorded; absence cannot be established";
      return recordedGone ? true : `postmaster.pid is missing while the recorded postmaster ${recorded?.pid} is still alive (${recordedCheck.status})`;
    case "proven": {
      if (recorded === undefined) {
        const live = await seams.processes.inspect(evidence.pid);
        return live === undefined
          ? true
          : `a live process (pid ${evidence.pid}) holds postmaster.pid and no postmaster identity was recorded; an unrecorded process is never stopped`;
      }

      if (evidence.pid !== recorded.pid) {
        if ((await seams.processes.inspect(evidence.pid)) !== undefined) return `postmaster.pid names live pid ${evidence.pid}, not the recorded postmaster ${recorded.pid}`;
        return recordedGone ? true : `postmaster.pid names pid ${evidence.pid} while the recorded postmaster ${recorded.pid} is still alive`;
      }

      if (recordedCheck?.status === "mismatch") return recordedCheck.reason;
      if (recordedGone) return true;

      const shutdown = await seams.clusters.shutdown(entry.clusterDirectory as string);
      if (!shutdown.ok) return `pg_ctl shutdown of the owned cluster did not complete${shutdown.detail === undefined ? "" : `: ${shutdown.detail}`}`;
      if (!(await seams.clusters.waitForExit(recorded.pid))) return `the recorded postmaster ${recorded.pid} was not observed to exit after shutdown`;
      return true;
    }
  }
}

/**
 * Tear down everything the intent log records that is not already settled, in reverse order —
 * processes deepest first, then worktrees, then harness roots, then (for `cleanup`) clusters —
 * applying §9.2 to each. One failure never skips the rest. Idempotent: settled entries are skipped.
 */
export async function teardown(seams: TeardownSeams): Promise<TeardownReport> {
  const now = seams.now ?? Date.now;
  const exists = seams.directoryExists ?? existsSync;
  const readGitFile =
    seams.readGitFile ??
    ((path: string) => {
      try {
        return readFileSync(join(path, ".git"), "utf8");
      } catch {
        return undefined;
      }
    });
  const removeDirectory = seams.removeDirectory ?? (async (path: string) => (await removeOwnedRoot(path)).removed);
  const listDirectory = seams.listDirectory ?? directoryEntries;
  const removeEmpty = seams.removeEmptyDirectory ?? removeEmptyDirectory;
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resume) => setTimeout(resume, ms)));
  /** Remove the run's cluster parent once nothing is left in it; never search or recurse inside it. */
  const settleClusterParent = (entry: ResourceEntry, settledRoot: "removed" | "absent", rootReason?: string): void => {
    const parent = entry.parent as string;
    const inside = listDirectory(parent);
    if (inside === undefined) settle(entry, settledRoot, rootReason ?? "the cluster parent is already gone");
    else if (inside.length > 0) leave(entry, `the run's cluster parent still holds ${inside.length} unrecorded entr${inside.length === 1 ? "y" : "ies"}; nothing unrecorded is removed`);
    else if (removeEmpty(parent)) settle(entry, "removed");
    else leave(entry, "the empty cluster parent could not be removed");
  };
  const stopped: number[] = [];
  const removed: number[] = [];
  const absent: number[] = [];
  const left: { id: number; reason: string }[] = [];
  const { log } = seams;
  let allowanceExhausted = false;

  const settle = (entry: ResourceEntry, state: "stopped" | "removed" | "absent", reason?: string): void => {
    log.update(entry.id, { state, ...(reason === undefined ? {} : { reason }) });
    (state === "stopped" ? stopped : state === "removed" ? removed : absent).push(entry.id);
  };
  const leave = (entry: ResourceEntry, reason: string): void => {
    log.update(entry.id, { state: "left", reason });
    left.push({ id: entry.id, reason });
  };

  const entries = log.entries();
  const open = entries.filter((entry) => !SETTLED.includes(entry.state));
  const ordered = [
    ...open.filter((entry) => entry.kind === "process").sort((a, b) => depthOf(b, entries) - depthOf(a, entries) || b.id - a.id),
    ...open.filter((entry) => entry.kind === "worktree").sort((a, b) => b.id - a.id),
    ...open.filter((entry) => entry.kind === "harness-root").sort((a, b) => b.id - a.id),
    ...(seams.includeClusters ? open.filter((entry) => entry.kind === "cluster").sort((a, b) => b.id - a.id) : []),
  ];
  /**
   * Confirm every recorded process has exited, polling within the allowance. Returns `undefined`
   * when every one is confirmed gone, or the reason it could not be confirmed. A process that is
   * unresolved, has no recorded identity, or cannot be inspected is never taken as exited.
   */
  const ownedProcessesExited = async (): Promise<string | undefined> => {
    for (let poll = 1; ; poll += 1) {
      const pending: string[] = [];

      for (const owned of log.entries().filter((candidate) => candidate.kind === "process")) {
        if (owned.identity === undefined) {
          if (owned.pid !== undefined) return `process entry ${owned.id} (${owned.label}) has no recorded identity, so its exit cannot be confirmed`;
          continue;
        }
        if (owned.state === "left") return `process entry ${owned.id} (${owned.label}) is unresolved`;

        let live: ProcessIdentity | undefined;
        try {
          live = await seams.processes.inspect(owned.identity.pid);
        } catch (error) {
          if (error instanceof ProcessInspectionError) return `the exit of process entry ${owned.id} (${owned.label}) could not be confirmed: ${error.message}`;
          throw error;
        }
        if (checkProcessIdentity(owned.identity, live).status !== "absent") pending.push(`${owned.id} (${owned.label}, pid ${owned.identity.pid})`);
      }

      if (pending.length === 0) return undefined;
      if (poll >= PROCESS_EXIT_POLLS || now() + PROCESS_EXIT_POLL_MS > seams.deadline) {
        return `owned processes not confirmed exited: ${pending.join(", ")}`;
      }
      await sleep(PROCESS_EXIT_POLL_MS);
    }
  };

  /** §9.2 for the recorded worktree: path, commit and Git registration. A failed inspection is a result, never absence. */
  const inspectWorktree = async (entry: ResourceEntry): Promise<WorktreeCheck | { readonly status: "inspection-failed"; readonly reason: string }> => {
    try {
      return checkWorktree(entry, await seams.git.worktreeList(), {
        directoryExists: exists,
        readGitFile,
        adminRecordExists: (name) => exists(join(seams.repositoryGitDirectory, "worktrees", name)),
        ...(seams.realpath === undefined ? {} : { realpath: seams.realpath }),
      });
    } catch (error) {
      return { status: "inspection-failed", reason: `the worktree could not be inspected: ${(error as Error).message}` };
    }
  };

  /**
   * Remove the recorded worktree with `git worktree remove --force` only — never a recursive
   * delete, never `prune`. Owned processes must be confirmed exited first. A failed removal is
   * retried, a bounded number of times within the allowance, and the path, commit and Git
   * registration are rechecked before each retry. Only when both the directory and the Git
   * registration are confirmed gone is it settled, with the original error kept. Anything else
   * (one of them gone, a mismatch, a failed inspection) is left unresolved, with what remains
   * preserved.
   */
  const tearDownWorktree = async (entry: ResourceEntry): Promise<void> => {
    const blocked = await ownedProcessesExited();
    if (blocked !== undefined) {
      leave(entry, `worktree not removed: ${blocked}`);
      return;
    }

    const errors: string[] = [];
    const failures = (): string =>
      errors.length === 0 ? "" : `git worktree remove failed ${errors.length} time(s) (first: ${errors[0]}${errors.length > 1 ? `; last: ${errors.at(-1)}` : ""})`;
    const settleGone = (wasRemovedHere: boolean, reason: string): void => {
      if (errors.length === 0 && !wasRemovedHere) settle(entry, "absent", reason);
      else settle(entry, "removed", errors.length === 0 ? undefined : `${failures()}; the directory and its Git registration were then both confirmed gone`);
    };
    const leaveUnresolved = (reason: string): void => leave(entry, errors.length === 0 ? reason : `${failures()}; ${reason}; what remains is preserved`);

    for (let attempt = 1; ; attempt += 1) {
      const before = await inspectWorktree(entry);
      if (before.status === "absent") {
        settleGone(false, before.reason);
        return;
      }
      if (before.status !== "verified") {
        leaveUnresolved(before.reason);
        return;
      }

      // The deadline is rechecked immediately before every removal command, including the first:
      // process-exit polling and inspection take time, and no new command starts once the
      // allowance has expired. A command already started may still finish after the deadline.
      if (now() > seams.deadline) {
        allowanceExhausted = true;
        leaveUnresolved(`teardown allowance exhausted before git worktree remove attempt ${attempt}; no removal command was started`);
        return;
      }

      try {
        await seams.git.removeWorktree(entry.path as string);
      } catch (error) {
        errors.push((error as Error).message);
        log.note(`worktree entry ${entry.id}: git worktree remove attempt ${attempt} failed: ${(error as Error).message}`);
        if (attempt >= WORKTREE_REMOVE_ATTEMPTS || now() + WORKTREE_RETRY_DELAY_MS > seams.deadline) {
          const after = await inspectWorktree(entry);
          if (after.status === "absent") settleGone(true, after.reason);
          else leaveUnresolved(after.status === "verified" ? "the worktree is still in place" : after.reason);
          return;
        }
        await sleep(WORKTREE_RETRY_DELAY_MS);
        continue;
      }

      const after = await inspectWorktree(entry);
      if (after.status === "absent") settleGone(true, after.reason);
      else leaveUnresolved(`git worktree remove returned, but ${after.status === "verified" ? "the worktree is still in place" : after.reason}`);
      return;
    }
  };

  /** Recorded resources inside a harness root that are not settled; the root is kept while any exist. */
  const unresolvedInside = (root: ResourceEntry): readonly ResourceEntry[] =>
    log
      .entries()
      .filter(
        (other) =>
          other.id !== root.id &&
          !SETTLED.includes(other.state) &&
          [other.path, other.clusterDirectory, other.parent].some((path) => path !== undefined && isWithin(path, root.path as string, seams.realpath)),
      );

  for (const entry of ordered) {
    if (now() > seams.deadline) {
      allowanceExhausted = true;
      leave(entry, "teardown allowance exhausted; no further step attempted");
      continue;
    }

    try {
      if (entry.kind === "process") {
        if (entry.identity === undefined) {
          // Intended but never started, or started without a recorded identity: nothing that can
          // be proven ours, so nothing is stopped.
          if (entry.pid === undefined) settle(entry, "absent", "never started");
          else leave(entry, "no recorded identity; a process without one is never stopped");
          continue;
        }

        const live = await seams.processes.inspect(entry.identity.pid);
        const check = checkProcessIdentity(
          entry.identity,
          live,
          entry.port === undefined || live === undefined ? undefined : { port: entry.port, listener: await seams.processes.listener(entry.port) },
        );

        if (check.status === "absent") settle(entry, "absent", check.reason);
        else if (check.status === "mismatch") leave(entry, check.reason);
        else {
          await seams.processes.stop(entry.identity.pid);
          settle(entry, "stopped");
        }
      } else if (entry.kind === "worktree") {
        await tearDownWorktree(entry);
      } else if (entry.kind === "harness-root") {
        const inside = entry.path === undefined ? [] : unresolvedInside(entry);
        if (entry.path === undefined || !isHarnessRoot(entry.path, seams.tempDirectory, seams.realpath)) {
          leave(entry, "not a harness-owned root inside the temp directory");
        } else if (inside.length > 0) {
          leave(entry, `root preserved: it holds unresolved recorded resource(s) ${inside.map((other) => `${other.id} (${other.kind} ${other.label})`).join(", ")}`);
        } else if (!exists(entry.path)) settle(entry, "absent", "already gone");
        else if (await removeDirectory(entry.path)) settle(entry, "removed");
        else leave(entry, "the root could not be removed within the removal bound");
      } else if (entry.kind === "cluster") {
        const problems = clusterLocationProblems(entry, seams.tempDirectory, seams.realpath);
        if (problems.length > 0) {
          leave(entry, `not this run's cluster location: ${problems.join("; ")}`);
          continue;
        }

        if (entry.path === undefined || entry.clusterDirectory === undefined) {
          // Logged before startup, but the helper's root was never recorded: only an empty parent
          // is removed. Whatever is inside is reported for an owner ruling, never searched for.
          settleClusterParent(entry, "absent", "the cluster parent was never created or is already gone");
          continue;
        }

        // Fail closed: the root and parent are removed only once the cluster is shown to be
        // stopped, either by a verified shutdown of the recorded postmaster or by positive
        // evidence that no postmaster for this directory is alive. Anything less leaves both.
        let stopped: true | string;
        try {
          stopped = await establishClusterStopped(entry, seams.clusters.provePostmaster(entry.clusterDirectory), exists(entry.path), seams);
        } catch (error) {
          // A failed or ambiguous process lookup establishes nothing: the cluster stays unresolved.
          if (!(error instanceof ProcessInspectionError)) throw error;
          stopped = error.message;
        }
        if (stopped !== true) {
          leave(entry, `unresolved cluster; root and parent preserved: ${stopped}`);
          continue;
        }

        if (!exists(entry.path)) settleClusterParent(entry, "absent", "already gone");
        else if (await seams.clusters.removeRoot(entry.path)) settleClusterParent(entry, "removed");
        else leave(entry, "the cluster root could not be removed within the removal bound");
      }
    } catch (error) {
      leave(entry, `teardown step failed: ${(error as Error).message}`);
    }
  }

  log.note(
    `teardown: ${stopped.length} stopped, ${removed.length} removed, ${absent.length} absent, ${left.length} left${allowanceExhausted ? " (allowance exhausted)" : ""}`,
  );

  return { stopped, removed, absent, left, allowanceExhausted };
}

/** `cleanup`'s exit code: 0 only when nothing was left; any unresolved resource is nonzero. */
export function cleanupExitCode(report: Pick<TeardownReport, "left">): 0 | 1 {
  return report.left.length === 0 ? 0 : 1;
}

/** The exact recovery command a timed-out or interrupted run prints (§12.3). */
export function cleanupCommand(outDirectory: string): string {
  return `node --experimental-transform-types --import ./scripts/local-demo/register.mjs scripts/bi4-timing/cli.ts cleanup --run "${outDirectory}"`;
}

// ---------------------------------------------------------------------------------------------
// §9.3 Abort on signal.
// ---------------------------------------------------------------------------------------------

export const ABORT_EVENTS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP", "uncaughtException", "unhandledRejection"] as const;

export interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The label S-B's stop records. S-B calls the shared abort handler directly under this name; no
 * signal is sent or emitted, so no other `SIGINT` listener in the process (for example a
 * dependency's exit hook) is reached.
 */
export const SIMULATED_SIGINT = "simulated SIGINT";

/** The one abort handler every real signal listener and S-B's simulated `SIGINT` share. */
export type SignalAbortHandler = (event: string, ...args: unknown[]) => void;

/**
 * The shared abort handler: the first event aborts the run, deferring exit so teardown can run;
 * a later event is logged and ignored.
 */
export function createSignalAbortHandler(controller: AbortController, note: (message: string) => void = () => {}): SignalAbortHandler {
  return (event, ...args) => {
    if (controller.signal.aborted) {
      note(`${event} received again; ignored while teardown runs`);
      return;
    }
    note(`${event} received; aborting the run`);
    controller.abort(new Error(`${event}${args[0] instanceof Error ? `: ${args[0].message}` : ""}`));
  };
}

/**
 * Turn every signal, uncaught exception and unhandled rejection into an abort through the shared
 * handler, deferring exit so teardown can run. A second event is logged and ignored. Returns the
 * uninstaller.
 */
export function installAbortOnSignals(
  controller: AbortController,
  source: EventSource = process as unknown as EventSource,
  note: (message: string) => void = () => {},
  handler: SignalAbortHandler = createSignalAbortHandler(controller, note),
): () => void {
  const listeners = ABORT_EVENTS.map((event) => {
    const listener = (...args: unknown[]): void => handler(event, ...args);
    source.on(event, listener);
    return [event, listener] as const;
  });

  return () => {
    for (const [event, listener] of listeners) source.off(event, listener);
  };
}

// ---------------------------------------------------------------------------------------------
// Owned child processes (E2) and their descendants.
// ---------------------------------------------------------------------------------------------

export interface OwnedProcessRequest {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly port?: number;
  /** Standard output and error go to files in the output directory, never to harness pipes. */
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * Start a child the harness owns. The intent is logged first; the child is **detached**, so it is
 * not in the harness's job object and survives a forced termination of the harness (§5.3.1);
 * its identity is logged as soon as the operating system reports it.
 */
export async function startOwnedProcess(
  log: IntentLog,
  processes: ProcessOps,
  request: OwnedProcessRequest,
  spawner: typeof spawn = spawn,
): Promise<{ readonly entry: number; readonly child: ChildProcess }> {
  const entry = log.intend("process", request.label, request.port === undefined ? {} : { port: request.port });
  const out = openSync(request.stdoutPath, "a");
  const err = openSync(request.stderrPath, "a");
  let child: ChildProcess;

  try {
    child = spawner(request.command, [...request.args], {
      cwd: request.cwd,
      // Exactly the caller's allowlist; nothing is inherited.
      env: { ...request.env } as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", out, err],
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }

  if (child.pid === undefined) {
    log.update(entry, { state: "absent", reason: "spawn reported no PID" });
    throw new Error(`${request.label} could not be started`);
  }

  log.update(entry, { pid: child.pid });
  const identity = await processes.inspect(child.pid);

  if (identity === undefined) {
    throw new Error(`${request.label} exited before its identity could be recorded`);
  }

  log.update(entry, { state: "created", identity });
  return { entry, child };
}

/**
 * Record every current descendant of an owned process with its identity and parent entry, and
 * attribute a listening port to whichever recorded process actually holds it.
 */
export async function recordDescendants(log: IntentLog, processes: ProcessOps, rootEntry: number, port?: number): Promise<void> {
  const root = log.entries()[rootEntry];
  if (root?.identity === undefined) return;

  const queue: { pid: number; entry: number }[] = [{ pid: root.identity.pid, entry: rootEntry }];
  const listener = port === undefined ? undefined : await processes.listener(port);

  while (queue.length > 0) {
    const { pid, entry } = queue.shift() as { pid: number; entry: number };

    for (const child of await processes.children(pid)) {
      const known = log.entries().find((candidate) => candidate.identity?.pid === child.pid && candidate.identity.creationTime === child.creationTime);
      if (known !== undefined) continue;
      const id = log.intend("process", `${root.label} descendant ${child.pid}`, {
        parentEntry: entry,
        pid: child.pid,
        ...(port !== undefined && listener === child.pid ? { port } : {}),
      });
      log.update(id, { state: "created", identity: child });
      queue.push({ pid: child.pid, entry: id });
    }
  }

  if (port !== undefined && listener !== undefined && listener !== root.identity.pid && root.port === port) {
    // The port belongs to a descendant; the root keeps no port claim it does not hold.
    log.update(rootEntry, { port: undefined });
  }
}

// ---------------------------------------------------------------------------------------------
// §5.3 Zero residue, and §5.3.1 the forced smoke pass.
// ---------------------------------------------------------------------------------------------

export interface ResidueSeams {
  readonly processes: ProcessOps;
  readonly git: GitOps;
  readonly repositoryRoot: string;
  readonly repositoryGitDirectory: string;
  readonly restrictedBaseline: RestrictedMetadata;
  readonly statusBaseline: string;
  readonly portIsFree: (host: string, port: number) => Promise<boolean>;
  readonly directoryExists?: (path: string) => boolean;
  readonly restrictedMetadata?: () => RestrictedMetadata;
  readonly realpath?: (path: string) => string;
}

/** Everything that would make a pass's outcome other than zero residue. Empty means none. */
export async function residueOf(entries: readonly ResourceEntry[], seams: ResidueSeams): Promise<readonly string[]> {
  const exists = seams.directoryExists ?? existsSync;
  const residue: string[] = [];

  for (const entry of entries) {
    const identities = [entry.identity, entry.postmaster].filter((identity): identity is ProcessIdentity => identity !== undefined);

    for (const identity of identities) {
      let live: ProcessIdentity | undefined;
      try {
        live = await seams.processes.inspect(identity.pid);
      } catch (error) {
        if (!(error instanceof ProcessInspectionError)) throw error;
        residue.push(`process ${identity.pid} (${entry.label}) could not be inspected, so it may still be alive: ${error.message}`);
        continue;
      }
      if (live !== undefined && live.creationTime === identity.creationTime) residue.push(`process ${identity.pid} (${entry.label}) is still alive`);
    }

    if (entry.port !== undefined && !(await seams.portIsFree(LOOPBACK, entry.port))) residue.push(`port ${entry.port} (${entry.label}) is not free`);
    if ((entry.kind === "harness-root" || entry.kind === "cluster") && entry.path !== undefined && exists(entry.path)) {
      residue.push(`root ${entry.path} still exists`);
    }
    if (entry.kind === "cluster" && entry.parent !== undefined && exists(entry.parent)) residue.push(`cluster parent ${entry.parent} still exists`);
    if (entry.kind === "worktree" && entry.adminRecord !== undefined && exists(join(seams.repositoryGitDirectory, "worktrees", entry.adminRecord))) {
      residue.push(`the worktree record ${entry.adminRecord} remains under .git/worktrees/`);
    }
  }

  const worktrees = await seams.git.worktreeList();
  if (worktrees.length !== 1 || canonical((worktrees[0] as WorktreeEntry).path, seams.realpath) !== canonical(seams.repositoryRoot, seams.realpath)) {
    residue.push("git worktree list shows more than the main tree");
  }

  const changed = restrictedChanges(seams.restrictedBaseline, (seams.restrictedMetadata ?? (() => restrictedMetadataOf(seams.repositoryRoot)))());
  if (changed.length > 0) residue.push(`restricted-file metadata changed: ${changed.join(", ")}`);
  if ((await seams.git.statusPorcelain()) !== seams.statusBaseline) residue.push("the main tree's git status changed");

  return residue;
}

/** Which recorded resources must survive the harness's death for S-C to exercise recovery. */
export function requiredSurvivors(boundary: Boundary): readonly string[] {
  return boundary === "e2" ? ["cluster postmaster", "next dev", "calibration server", "worktree"] : ["cluster postmaster", "cluster root"];
}

export interface SurvivorSnapshot {
  readonly present: readonly string[];
  readonly processes: readonly ProcessIdentity[];
  readonly roots: readonly string[];
  readonly worktrees: readonly string[];
}

/** Record which intent-log resources are still present, after the harness is gone. */
export async function survivorSnapshot(
  entries: readonly ResourceEntry[],
  seams: { readonly processes: ProcessOps; readonly git: GitOps; readonly directoryExists?: (path: string) => boolean; readonly realpath?: (path: string) => string },
): Promise<SurvivorSnapshot> {
  const exists = seams.directoryExists ?? existsSync;
  const present = new Set<string>();
  const processes: ProcessIdentity[] = [];
  const roots: string[] = [];
  const worktrees: string[] = [];
  const listed = await seams.git.worktreeList();

  for (const entry of entries) {
    for (const [identity, name] of [
      [entry.identity, entry.label],
      [entry.postmaster, "cluster postmaster"],
    ] as const) {
      if (identity === undefined) continue;
      const live = await seams.processes.inspect(identity.pid);
      if (live !== undefined && live.creationTime === identity.creationTime) {
        processes.push(live);
        present.add(name);
      }
    }

    if ((entry.kind === "harness-root" || entry.kind === "cluster") && entry.path !== undefined && exists(entry.path)) {
      roots.push(entry.path);
      if (entry.kind === "cluster") present.add("cluster root");
    }

    if (
      entry.kind === "worktree" &&
      entry.path !== undefined &&
      listed.some((candidate) => canonical(candidate.path, seams.realpath) === canonical(entry.path as string, seams.realpath))
    ) {
      worktrees.push(entry.path);
      present.add("worktree");
    }
  }

  return { present: [...present], processes, roots, worktrees };
}

/** The S-C child writes this in its output directory when it reaches the checkpoint. */
export const SC_READY_FILE = "sc-ready.json";
/** How long the S-C child holds at the checkpoint before giving up and aborting its own run. */
export const SC_CHECKPOINT_TIMEOUT_MS = 60_000;

/** What the S-C child publishes at the checkpoint: who it is and how far it got. */
export interface ReadyMarker {
  readonly pid: number;
  readonly measured: number;
  /** The child's own identity, when it could read it; the parent compares it with its record. */
  readonly identity?: ProcessIdentity;
}

export interface CheckpointSeams {
  publish(marker: ReadyMarker): void;
  sleep(ms: number): Promise<void>;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * The S-C child's checkpoint, entered after its 10th measured request and before any further
 * request. It publishes the ready marker, then holds — sending nothing — until the parent
 * terminates it or the bound passes. On `"timeout"` the caller aborts its own run, so a parent
 * that never acts cannot leave the child measuring past the checkpoint.
 */
export async function holdAtCheckpoint(marker: ReadyMarker, seams: CheckpointSeams): Promise<"timeout" | "aborted"> {
  seams.publish(marker);
  const until = seams.now() + seams.timeoutMs;

  while (seams.now() < until) {
    if (seams.signal?.aborted) return "aborted";
    await seams.sleep(Math.min(50, until - seams.now()));
  }

  return seams.signal?.aborted ? "aborted" : "timeout";
}

/** Why a ready marker does not authorize the kill. Empty means it does. */
export function readyMarkerProblems(marker: ReadyMarker, spawnedPid: number, recorded: ProcessIdentity): readonly string[] {
  const problems: string[] = [];
  if (marker.pid !== spawnedPid) problems.push(`the ready marker names pid ${marker.pid}, not the spawned harness ${spawnedPid}`);
  if (marker.measured !== FORCED_KILL_AFTER) problems.push(`the ready marker reports ${marker.measured} measured requests, not ${FORCED_KILL_AFTER}`);
  if (marker.identity !== undefined && (marker.identity.creationTime !== recorded.creationTime || marker.identity.executable !== recorded.executable)) {
    problems.push("the identity in the ready marker differs from the one recorded at spawn");
  }
  return problems;
}

export interface ForcedPassSeams {
  readonly boundary: Boundary;
  readonly processes: ProcessOps;
  readonly git: GitOps;
  /** Start the harness child; resolves once its PID is known. */
  spawnHarness(): Promise<{ readonly pid: number }>;
  /**
   * Resolve with the child's ready marker once it is held at the checkpoint, or `undefined` if
   * the marker does not appear within the bound (or the child exits first).
   */
  waitForReady(): Promise<ReadyMarker | undefined>;
  /** Resolve true once the PID is confirmed gone, within a bound. */
  waitGone(pid: number): Promise<boolean>;
  /** Load the harness's intent log after its death. */
  loadLog(): IntentLog;
  /** Run `cleanup` on the harness's output. */
  cleanup(): Promise<TeardownReport>;
  readonly directoryExists?: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

export interface ForcedPassResult {
  readonly status: "exercised" | "not-exercised" | "refused";
  readonly reason?: string;
  readonly snapshot?: SurvivorSnapshot;
  readonly missingSurvivors?: readonly string[];
  readonly firstCleanup?: TeardownReport;
  readonly secondCleanup?: TeardownReport;
}

export const FORCED_KILL_AFTER = 10;

/**
 * §5.3.1. Kill **only** the harness process while it is held at its checkpoint after its 10th
 * measured request. The kill comes only after its ready marker names the spawned PID, reports
 * exactly 10, and carries a matching identity, and after its live identity is confirmed against
 * the one recorded at spawn. It uses `taskkill /PID <pid> /F`, never `/T`. Then the survivors are
 * snapshot, recovery `cleanup` runs, and it runs again to show it is a no-op. Because the child
 * sends nothing while held, the kill point is deterministic, not a race against a fast run.
 */
export async function forcedPass(seams: ForcedPassSeams): Promise<ForcedPassResult> {
  const { pid } = await seams.spawnHarness();
  const recorded = await seams.processes.inspect(pid);

  if (recorded === undefined) {
    return { status: "refused", reason: "the harness exited before its identity could be recorded; nothing was killed" };
  }

  const marker = await seams.waitForReady();
  if (marker === undefined) {
    return { status: "refused", reason: "the harness did not publish its ready marker at the checkpoint within the bound; nothing was killed" };
  }

  const problems = readyMarkerProblems(marker, pid, recorded);
  if (problems.length > 0) return { status: "refused", reason: `${problems.join("; ")}; nothing was killed` };

  const check = checkProcessIdentity(recorded, await seams.processes.inspect(pid));
  if (check.status !== "verified") {
    return { status: "refused", reason: `the harness identity did not match before the kill (${check.status === "absent" || check.status === "mismatch" ? check.reason : ""}); nothing was killed` };
  }

  await seams.processes.stop(pid);

  if (!(await seams.waitGone(pid))) {
    return { status: "refused", reason: "the harness PID did not exit after the kill; cleanup was not started" };
  }

  const log = seams.loadLog();
  const snapshot = await survivorSnapshot(log.entries(), seams);
  const missingSurvivors = requiredSurvivors(seams.boundary).filter((name) => !snapshot.present.includes(name));
  const firstCleanup = await seams.cleanup();
  const secondCleanup = await seams.cleanup();

  return {
    status: missingSurvivors.length === 0 ? "exercised" : "not-exercised",
    ...(missingSurvivors.length === 0 ? {} : { reason: `required survivors missing: ${missingSurvivors.join(", ")}` }),
    snapshot,
    missingSurvivors,
    firstCleanup,
    secondCleanup,
  };
}

// ---------------------------------------------------------------------------------------------
// §5 Smoke outcomes: what each pass is expected to show, and the order passes may run in.
// ---------------------------------------------------------------------------------------------

export type SmokePass = "S-A" | "S-B" | "S-C";
export const SMOKE_PASSES: readonly SmokePass[] = ["S-A", "S-B", "S-C"];
export type PassStatus = "passed" | "failed" | "refused" | "not-exercised" | "missing";

export interface PassVerdict {
  readonly status: PassStatus;
  readonly reasons: readonly string[];
}

/** What an in-process pass (S-A, S-B) reports back to the smoke driver. */
export interface InProcessPassReport {
  readonly exitCode: number;
  readonly requests: number;
  readonly measured: number;
  readonly stoppedBy: string | null;
  readonly invalid: readonly string[];
  readonly residue: readonly string[];
  readonly [detail: string]: unknown;
}

/** What the forced pass (S-C) reports back: the §5.3.1 result plus its counts and residue. */
export type ForcedPassReport = ForcedPassResult & {
  readonly requests: number;
  readonly measured: number;
  readonly residue: readonly string[];
};

/** The one abort S-B is expected to record: its simulated SIGINT after the 10th measured request. */
export const S_B_EXPECTED_ABORT = `Aborted: ${SIMULATED_SIGINT}`;

/**
 * What a run does after each measured request (outside the timed region). S-B, after exactly the
 * 10th, calls the shared abort handler directly as a simulated `SIGINT` — it never sends, emits
 * or broadcasts a signal — and the runner stops before its next request. S-C, after exactly the
 * 10th, holds at its checkpoint. Every other pass and count does nothing.
 */
export function measuredCheckpoint(
  pass: SmokePass | undefined,
  count: number,
  seams: { readonly abort: SignalAbortHandler; readonly hold: (count: number) => Promise<void> },
): void | Promise<void> {
  if (count !== FORCED_KILL_AFTER) return undefined;
  if (pass === "S-B") {
    seams.abort(SIMULATED_SIGINT);
    return undefined;
  }
  if (pass === "S-C") return seams.hold(count);
  return undefined;
}

/**
 * S-A is expected to run to completion: exit 0, nothing Invalid, not stopped, at least one
 * request, and zero residue. S-B is expected to be stopped by its simulated SIGINT after exactly
 * the 10th measured request, record that abort and nothing else, and leave zero residue. Any
 * refusal (exit 2) is reported as refused.
 */
export function evaluateInProcessPass(pass: "S-A" | "S-B", report: InProcessPassReport): PassVerdict {
  if (report.exitCode === 2) return { status: "refused", reasons: report.invalid.length > 0 ? [...report.invalid] : ["refused before anything was created"] };

  const reasons: string[] = [];

  if (pass === "S-A") {
    if (report.exitCode !== 0) reasons.push(`exit code ${report.exitCode}, expected 0`);
    for (const reason of report.invalid) reasons.push(`unexpected: ${reason}`);
    if (report.stoppedBy !== null) reasons.push(`stopped by ${report.stoppedBy}; S-A is expected to run to completion`);
    if (report.requests === 0) reasons.push("no request was made");
  } else {
    if (report.stoppedBy !== "abort") reasons.push(`stopped by ${report.stoppedBy ?? "nothing"}; S-B is expected to be stopped by its simulated SIGINT`);
    if (report.measured !== FORCED_KILL_AFTER) reasons.push(`${report.measured} measured requests; S-B is expected to stop after exactly ${FORCED_KILL_AFTER}`);
    if (!report.invalid.includes(S_B_EXPECTED_ABORT)) reasons.push(`the expected "${S_B_EXPECTED_ABORT}" was not recorded`);
    for (const reason of report.invalid.filter((entry) => entry !== S_B_EXPECTED_ABORT)) reasons.push(`unexpected: ${reason}`);
  }

  for (const line of report.residue) reasons.push(`residue: ${line}`);
  return { status: reasons.length === 0 ? "passed" : "failed", reasons };
}

/**
 * S-C is expected to be exercised: the harness killed after its 10th measured request with every
 * required survivor present, a first `cleanup` that leaves nothing, a second `cleanup` that does
 * nothing at all, and zero residue afterwards.
 */
export function evaluateForcedPass(report: ForcedPassReport): PassVerdict {
  if (report.status === "refused") return { status: "refused", reasons: [report.reason ?? "refused"] };
  if (report.status === "not-exercised") return { status: "not-exercised", reasons: [report.reason ?? "a required survivor was missing"] };

  const reasons: string[] = [];
  if (report.measured < FORCED_KILL_AFTER) reasons.push(`${report.measured} measured requests before the kill; expected at least ${FORCED_KILL_AFTER}`);
  if (report.firstCleanup === undefined) reasons.push("the recovery cleanup did not run");
  else for (const left of report.firstCleanup.left) reasons.push(`recovery cleanup left entry ${left.id}: ${left.reason}`);
  if (report.secondCleanup === undefined) reasons.push("the second cleanup did not run");
  else {
    const { stopped, removed, left } = report.secondCleanup;
    if (stopped.length + removed.length + left.length > 0) {
      reasons.push(`the second cleanup was not a no-op (${stopped.length} stopped, ${removed.length} removed, ${left.length} left)`);
    }
  }
  for (const line of report.residue) reasons.push(`residue: ${line}`);

  return { status: reasons.length === 0 ? "passed" : "failed", reasons };
}

export interface SmokeDriverSeams {
  readonly requestCap: number;
  /** Absolute time (ms) of the smoke time cap. */
  readonly deadline: number;
  readonly now?: () => number;
  runInProcess(pass: "S-A" | "S-B", requestCap: number): Promise<InProcessPassReport>;
  runForced(requestCap: number): Promise<ForcedPassReport>;
  /** Persist the report; called after every pass and once more at the end, whatever happened. */
  writeReport(report: Readonly<Record<string, unknown>>): void;
}

export interface SmokeOutcome {
  readonly exitCode: 0 | 1;
  readonly verdicts: Readonly<Record<SmokePass, PassVerdict>>;
  readonly requestsUsed: number;
}

/**
 * Run S-A, S-B and S-C in order. Each later pass needs the earlier one to have passed, and none
 * starts once the request or time cap is reached. Each pass that does not run is recorded as
 * missing, with the reason. The report is written after every pass and in a `finally`, so a
 * failure never loses it. The exit code is 0 only when all three passes passed within the caps.
 */
export async function driveSmoke(seams: SmokeDriverSeams, report: Record<string, unknown>): Promise<SmokeOutcome> {
  const now = seams.now ?? Date.now;
  const verdicts: Partial<Record<SmokePass, PassVerdict>> = {};
  let used = 0;
  let blocked: string | undefined;

  const record = (pass: SmokePass, verdict: PassVerdict, result?: Readonly<Record<string, unknown>>): void => {
    verdicts[pass] = verdict;
    report[pass] = { ...(result ?? {}), status: verdict.status, reasons: verdict.reasons };
  };
  const capReason = (): string | undefined =>
    now() > seams.deadline ? "the smoke time cap was reached" : used >= seams.requestCap ? "the smoke request cap was reached" : undefined;
  const allPassed = (): boolean => SMOKE_PASSES.every((pass) => verdicts[pass]?.status === "passed");
  const succeeded = (): boolean => allPassed() && used <= seams.requestCap && now() <= seams.deadline;
  const save = (): void => {
    report.requestsUsed = used;
    report.outcome = succeeded() ? "all three passes passed" : allPassed() ? "failed: a smoke cap was exceeded" : "failed";
    report.passStatus = Object.fromEntries(SMOKE_PASSES.map((pass) => [pass, verdicts[pass]?.status ?? "missing"]));
    seams.writeReport(report);
  };

  try {
    for (const pass of SMOKE_PASSES) {
      blocked ??= capReason();
      if (blocked !== undefined) {
        record(pass, { status: "missing", reasons: [`not started: ${blocked}`] });
        save();
        continue;
      }

      let verdict: PassVerdict;
      try {
        if (pass === "S-C") {
          const result = await seams.runForced(seams.requestCap - used);
          used += result.requests;
          verdict = evaluateForcedPass(result);
          record(pass, verdict, result as unknown as Record<string, unknown>);
        } else {
          const result = await seams.runInProcess(pass, seams.requestCap - used);
          used += result.requests;
          verdict = evaluateInProcessPass(pass, result);
          record(pass, verdict, result);
        }
      } catch (error) {
        verdict = { status: "failed", reasons: [`the pass did not complete: ${error instanceof Error ? error.message : String(error)}`] };
        record(pass, verdict);
      }

      if (verdict.status !== "passed") blocked = `${pass} was ${verdict.status}, so the next pass's prerequisite failed`;
      save();
    }
  } finally {
    for (const pass of SMOKE_PASSES) if (verdicts[pass] === undefined) record(pass, { status: "missing", reasons: ["not started: the smoke driver stopped early"] });
    save();
  }

  return {
    exitCode: succeeded() ? 0 : 1,
    verdicts: verdicts as Record<SmokePass, PassVerdict>,
    requestsUsed: used,
  };
}

// ---------------------------------------------------------------------------------------------
// §5.5 Smoke-based re-estimate (`H-D16`).
// ---------------------------------------------------------------------------------------------

export interface SmokeTiming {
  readonly setupMs: number;
  readonly teardownMs: number;
  /** Median elapsed time per request, per target. */
  readonly medianRequestMs: Readonly<Partial<Record<"operation" | "next" | "calibration", number>>>;
}

/** Setup + each target's full-pilot request count × its median smoke time per request + teardown. */
export function projectReplicateMs(timing: SmokeTiming, fullCounts: Readonly<Partial<Record<"operation" | "next" | "calibration", number>>>): number {
  let total = timing.setupMs + timing.teardownMs;
  for (const [target, count] of Object.entries(fullCounts)) {
    total += (count ?? 0) * (timing.medianRequestMs[target as keyof SmokeTiming["medianRequestMs"]] ?? 0);
  }
  return total;
}

/** Whether a projection needs an owner ruling before any full run: above 80% of the ceiling. */
export function projectionNeedsRuling(projectedMs: number, ceilingMinutes: number): boolean {
  return projectedMs > 0.8 * ceilingMinutes * 60_000;
}

// ---------------------------------------------------------------------------------------------
// Small conveniences for the runners.
// ---------------------------------------------------------------------------------------------

export function directoryEntries(path: string): readonly string[] | undefined {
  try {
    return statSync(path).isDirectory() ? readdirSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** Remove a harness root that is proven harness-owned. Refuses anything else. */
export async function removeHarnessRoot(path: string, tempDirectory: string): Promise<boolean> {
  if (!isHarnessRoot(path, tempDirectory)) throw new Error(`${path} is not a harness root; refusing to remove it`);
  if (!existsSync(path)) return true;
  return (await removeOwnedRoot(path)).removed;
}
