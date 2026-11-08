/**
 * Isolation, run state and cleanup for the `BI-4` timing pilot (issue #246; harness gate
 * revision 5 §5, §7–§10, §12; `H-D18`), with fakes only: no process, port, worktree or cluster
 * is touched, and no signal is sent. S-B's simulated SIGINT goes through the shared abort handler
 * without process.emit; the 10-request stop is checked against the E1 runner with malformed
 * identities that never reach the fake database. The single exception is one test that creates and removes its own temporary directory.
 * It proves that a root made through `os.tmpdir()` lands in the run-specific cluster parent.
 *
 * The intent log; abort-driven teardown; ownership checks before every removal; process identity
 * (a reused PID is never stopped, stops are never `/T`, an unrecorded child is reported and left);
 * worktree removal limited to the recorded path with no `prune`, and a stale record reported;
 * the refusal conditions; the explicit database URL; the restricted-file metadata guard; cleanup
 * idempotence; the teardown allowance; the forced smoke pass; each smoke pass's expected outcome
 * and the order passes may run in; the run-specific cluster location; the S-C checkpoint and its
 * timeout; fail-closed cluster recovery; Windows process inspection that never reads a failed,
 * malformed, ambiguous or incomplete lookup as absence; identity checks that never let an unavailable
 * executable or command line verify a live process; and the 80% re-estimate rule.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { ListingDatabase } from "../../src/data/listing-table";

import {
  adminRecordOf,
  buildDatabaseUrl,
  checkPreconditions,
  checkProcessIdentity,
  cleanupExitCode,
  clusterLocationProblems,
  clusterRootPattern,
  createGitOps,
  createSignalAbortHandler,
  databaseUrlProblems,
  driveSmoke,
  establishClusterStopped,
  evaluateForcedPass,
  evaluateInProcessPass,
  FORCED_KILL_AFTER,
  forcedPass,
  holdAtCheckpoint,
  identityScript,
  installAbortOnSignals,
  IntentLog,
  locateClusterRoot,
  measuredCheckpoint,
  outputDirectoryProblems,
  parseInspection,
  parseWorktreeList,
  ProcessInspectionError,
  readPidFileEvidence,
  readyMarkerProblems,
  projectionNeedsRuling,
  projectReplicateMs,
  recordDescendants,
  redactDatabaseUrl,
  residueOf,
  restrictedChanges,
  restrictedMetadataOf,
  S_B_EXPECTED_ABORT,
  SIMULATED_SIGINT,
  startUnderParent,
  taskkillArguments,
  TEMP_VARIABLES,
  teardown,
  windowsProcessOps,
  type ClusterOps,
  type EventSource,
  type ForcedPassReport,
  type GitOps,
  type InProcessPassReport,
  type LogStore,
  type PidFileEvidence,
  type PreconditionSeams,
  type ProcessIdentity,
  type ProcessOps,
  type ReadyMarker,
  type ResourceEntry,
  type SmokeDriverSeams,
  type TeardownSeams,
  type WorktreeEntry,
} from "./isolation";
import { runOperation } from "./run-operation";
import type { Plan } from "./schedule";

const ROOT = resolve(sep, "bi4-fake");
const TEMP = join(ROOT, "Temp");
const REPO = join(ROOT, "repo");
const GIT_DIR = join(REPO, ".git");
const COMMIT = "ee86fa24e321bba2fcd0aae8dd757a72c38e0c12";
const OUT = join(ROOT, "out");
const identityPath = (path: string): string => path;
const CLUSTER_SLUG = "bi4-smoke-e2";
const CLUSTER_PARENT = join(TEMP, "cdp-bi4-cluster-0a1b2c3d4e5f");
const CLUSTER_ROOT = join(CLUSTER_PARENT, "cdp-bi4-smoke-e2-Ab12Cd");

function identity(pid: number, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return { pid, parentPid: 1, creationTime: `13400000000${pid}`, executable: "C:\\node.exe", commandLine: `node child-${pid}`, ...overrides };
}

class MemoryStore implements LogStore {
  readonly files = new Map<string, string>();
  writes = 0;
  read(path: string): string | undefined {
    return this.files.get(path);
  }
  writeDurably(path: string, text: string): void {
    this.writes += 1;
    this.files.set(path, text);
  }
}

class FakeProcesses implements ProcessOps {
  readonly table = new Map<number, ProcessIdentity>();
  readonly listeners = new Map<number, number>();
  readonly stopped: number[] = [];

  add(...identities: ProcessIdentity[]): this {
    for (const entry of identities) this.table.set(entry.pid, entry);
    return this;
  }
  async inspect(pid: number): Promise<ProcessIdentity | undefined> {
    return this.table.get(pid);
  }
  async children(pid: number): Promise<readonly ProcessIdentity[]> {
    return [...this.table.values()].filter((entry) => entry.parentPid === pid);
  }
  async listener(port: number): Promise<number | undefined> {
    return this.listeners.get(port);
  }
  async stop(pid: number): Promise<void> {
    this.stopped.push(pid);
    this.table.delete(pid);
    for (const [port, holder] of this.listeners) if (holder === pid) this.listeners.delete(port);
  }
}

class FakeGit implements GitOps {
  readonly removed: string[] = [];
  constructor(public worktrees: WorktreeEntry[]) {}
  async head(): Promise<string> {
    return COMMIT;
  }
  async statusPorcelain(): Promise<string> {
    return "?? CLAUDE.md\n";
  }
  async worktreeList(): Promise<readonly WorktreeEntry[]> {
    return this.worktrees;
  }
  async addDetachedWorktree(): Promise<void> {}
  async removeWorktree(path: string): Promise<void> {
    this.removed.push(path);
    this.worktrees = this.worktrees.filter((entry) => entry.path !== path);
  }
}

const noClusters: ClusterOps = {
  provePostmaster: () => ({ status: "missing" }),
  shutdown: async () => ({ ok: true }),
  waitForExit: async () => true,
  removeRoot: async () => true,
};

/** A run with a root, a worktree, next dev and its descendant, and a calibration server. */
function recordedRun(store = new MemoryStore()) {
  const log = new IntentLog(join(OUT, "run-state.json"), store);
  const root = log.intend("harness-root", "http root", { path: join(TEMP, "cdp-bi4-http-abc") });
  log.update(root, { state: "created" });
  const worktreePath = join(TEMP, "cdp-bi4-http-abc", "worktree");
  const worktree = log.intend("worktree", "worktree", { path: worktreePath, commit: COMMIT });
  log.update(worktree, { state: "created", adminRecord: "worktree" });
  const next = log.intend("process", "next dev", { port: 51000 });
  log.update(next, { state: "created", pid: 200, identity: identity(200) });
  const worker = log.intend("process", "next dev descendant 201", { parentEntry: next, pid: 201, port: 51000 });
  log.update(worker, { state: "created", identity: identity(201, { parentPid: 200 }) });
  const calibration = log.intend("process", "calibration server", { port: 51001 });
  log.update(calibration, { state: "created", pid: 300, identity: identity(300) });

  const processes = new FakeProcesses().add(identity(200), identity(201, { parentPid: 200 }), identity(300));
  processes.listeners.set(51000, 201);
  processes.listeners.set(51001, 300);

  const git = new FakeGit([
    { path: REPO, head: COMMIT, detached: false, prunable: false },
    { path: join(TEMP, "cdp-bi4-http-abc", "worktree"), head: COMMIT, detached: true, prunable: false },
  ]);
  const directories = new Set([join(TEMP, "cdp-bi4-http-abc"), worktreePath, join(GIT_DIR, "worktrees", "worktree")]);
  const removedDirectories: string[] = [];

  const seams: TeardownSeams = {
    log,
    processes,
    git,
    clusters: noClusters,
    tempDirectory: TEMP,
    repositoryGitDirectory: GIT_DIR,
    includeClusters: true,
    deadline: Number.POSITIVE_INFINITY,
    realpath: identityPath,
    directoryExists: (path) => directories.has(resolve(path)),
    readGitFile: () => "gitdir: C:/repo/.git/worktrees/worktree\n",
    removeDirectory: async (path) => {
      removedDirectories.push(path);
      directories.delete(path);
      return true;
    },
    listDirectory: (path) =>
      directories.has(resolve(path)) ? [...directories].filter((entry) => resolve(dirname(entry)) === resolve(path)).map((entry) => basename(entry)) : undefined,
    removeEmptyDirectory: (path) => {
      const inside = [...directories].some((entry) => resolve(dirname(entry)) === resolve(path));
      if (inside || !directories.has(resolve(path))) return false;
      removedDirectories.push(path);
      return directories.delete(resolve(path));
    },
  };

  git.removeWorktree = async (path: string) => {
    git.removed.push(path);
    git.worktrees = git.worktrees.filter((entry) => resolve(entry.path) !== resolve(path));
    directories.delete(path);
    directories.delete(join(GIT_DIR, "worktrees", "worktree"));
  };

  return { log, store, processes, git, seams, directories, removedDirectories, ids: { root, worktree, next, worker, calibration } };
}

describe("the intent log (§9.1)", () => {
  it("records each resource before it is created, flushes on every change, and reloads from disk", () => {
    const store = new MemoryStore();
    const log = new IntentLog("run-state.json", store);
    const id = log.intend("process", "next dev", { port: 5 });

    expect(log.entries()[id]?.state).toBe("intended");
    expect(store.writes).toBe(1);

    log.update(id, { state: "created", pid: 9, identity: identity(9) });

    expect(store.writes).toBe(2);
    expect(new IntentLog("run-state.json", store).entries()).toEqual(log.entries());
  });

  it("never needs the database password: the URL is redacted wherever it is written", () => {
    const url = buildDatabaseUrl({ user: "postgres", password: "verification-only", port: 55555 });

    expect(redactDatabaseUrl(url)).not.toContain("verification-only");
    expect(redactDatabaseUrl(url)).toContain("redacted");
  });
});

describe("abort-driven teardown (§9.3)", () => {
  function emitter() {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const source: EventSource = {
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      off: (event, listener) => listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)),
    };
    return { source, listeners, emit: (event: string, ...args: unknown[]) => (listeners.get(event) ?? []).forEach((listener) => listener(...args)) };
  }

  it("turns the first signal or exception into an abort, ignores a second, and uninstalls cleanly", () => {
    const { source, listeners, emit } = emitter();
    const controller = new AbortController();
    const notes: string[] = [];
    const uninstall = installAbortOnSignals(controller, source, (message) => notes.push(message));

    expect([...listeners.keys()].sort()).toEqual(["SIGBREAK", "SIGHUP", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]);

    emit("SIGINT");
    expect(controller.signal.aborted).toBe(true);

    emit("SIGTERM");
    expect(notes).toEqual(["SIGINT received; aborting the run", "SIGTERM received again; ignored while teardown runs"]);

    uninstall();
    expect([...listeners.values()].every((entries) => entries.length === 0)).toBe(true);
  });

  it("routes real signals and the simulated SIGINT through one shared handler", () => {
    const { source, emit } = emitter();
    const controller = new AbortController();
    const notes: string[] = [];
    const calls: string[] = [];
    const shared = createSignalAbortHandler(controller, (message) => notes.push(message));
    const handler = (event: string, ...args: unknown[]): void => {
      calls.push(event);
      shared(event, ...args);
    };
    const uninstall = installAbortOnSignals(controller, source, (message) => notes.push(message), handler);

    // The simulated SIGINT is a direct call: it aborts with its own label.
    handler(SIMULATED_SIGINT);
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe(SIMULATED_SIGINT);

    // A real signal afterwards reaches the same handler and is ignored as a second event.
    emit("SIGINT");
    expect(calls).toEqual([SIMULATED_SIGINT, "SIGINT"]);
    expect(notes).toEqual([`${SIMULATED_SIGINT} received; aborting the run`, "SIGINT received again; ignored while teardown runs"]);
    expect(S_B_EXPECTED_ABORT).toBe(`Aborted: ${SIMULATED_SIGINT}`);
    uninstall();
  });

  it("acts after exactly the 10th measured request only: S-B aborts, S-C holds, S-A does nothing", async () => {
    const aborts: string[] = [];
    const holds: number[] = [];
    const seams = { abort: (event: string) => void aborts.push(event), hold: async (count: number) => void holds.push(count) };

    for (let count = 1; count <= 20; count += 1) {
      if (count !== FORCED_KILL_AFTER) {
        expect(measuredCheckpoint("S-B", count, seams)).toBeUndefined();
        expect(measuredCheckpoint("S-C", count, seams)).toBeUndefined();
      }
      expect(measuredCheckpoint("S-A", count, seams)).toBeUndefined();
      expect(measuredCheckpoint(undefined, count, seams)).toBeUndefined();
    }
    expect(aborts).toEqual([]);
    expect(holds).toEqual([]);

    expect(measuredCheckpoint("S-B", FORCED_KILL_AFTER, seams)).toBeUndefined();
    await measuredCheckpoint("S-C", FORCED_KILL_AFTER, seams);
    expect(aborts).toEqual([SIMULATED_SIGINT]);
    expect(holds).toEqual([FORCED_KILL_AFTER]);
  });

  // A synthetic E1 plan of malformed identities: OP-2 refuses each before any query, so the fake
  // database is never reached. Warm-up requests come first, then 30 measured ones.
  function malformedPlan(): Plan {
    const identities = Array.from({ length: 5 }, (_, index) => ({ index, key: `not-a-uuid-${index}`, cls: "MF" as const, target: "operation" as const }));
    const requests = [
      ...Array.from({ length: 6 }, (_, sequence) => ({ sequence, phase: "warmup" as const, block: 1, identity: sequence % 5 })),
      ...Array.from({ length: 30 }, (_, i) => ({ sequence: 6 + i, phase: "measured" as const, block: 2 + Math.floor(i / 5), identity: i % 5 })),
    ];
    return { boundary: "e1", mode: "smoke", seed: "fake", delaysNs: [1, 2, 3], identities, background: [], requests, measuredBlocks: 6, warmupBlocks: 1 };
  }
  const neverQueried = new Proxy({}, { get: () => { throw new Error("the fake database was reached"); } }) as unknown as Kysely<ListingDatabase>;

  it("stops S-B before its next request after exactly 10 measured requests, aborted as a simulated SIGINT", async () => {
    const controller = new AbortController();
    const phases: string[] = [];
    const abort = createSignalAbortHandler(controller);

    const outcome = await runOperation(malformedPlan(), neverQueried, {
      signal: controller.signal,
      requestCap: 200,
      onRecord: (record) => phases.push(record.phase),
      onMeasured: (count) => measuredCheckpoint("S-B", count, { abort, hold: async () => {} }),
    });

    expect(outcome).toEqual({ completed: 16, stoppedBy: "abort" });
    expect(phases.filter((phase) => phase === "measured")).toHaveLength(FORCED_KILL_AFTER);
    expect((controller.signal.reason as Error).message).toBe(SIMULATED_SIGINT);

    // S-A, with the same plan, runs to completion.
    const sa = new AbortController();
    const all = await runOperation(malformedPlan(), neverQueried, {
      signal: sa.signal,
      requestCap: 200,
      onRecord: () => {},
      onMeasured: (count) => measuredCheckpoint("S-A", count, { abort: createSignalAbortHandler(sa), hold: async () => {} }),
    });
    expect(all).toEqual({ completed: 36 });
    expect(sa.signal.aborted).toBe(false);
  });

  it("aborts and cleans up without sending, emitting or broadcasting SIGINT to other listeners", async () => {
    // Stands in for any other process-level SIGINT listener, such as a dependency's exit hook.
    const otherListener = vi.fn();
    process.on("SIGINT", otherListener);
    const emitSpy = vi.spyOn(process, "emit");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const controller = new AbortController();
      const notes: string[] = [];
      const { source } = emitter();
      const abort = createSignalAbortHandler(controller, (message) => notes.push(message));
      const uninstall = installAbortOnSignals(controller, source, (message) => notes.push(message), abort);

      const outcome = await runOperation(malformedPlan(), neverQueried, {
        signal: controller.signal,
        requestCap: 200,
        onRecord: () => {},
        onMeasured: (count) => measuredCheckpoint("S-B", count, { abort, hold: async () => {} }),
      });
      expect(outcome.stoppedBy).toBe("abort");

      // Teardown runs as usual after the abort and leaves nothing.
      const run = recordedRun();
      const report = await teardown(run.seams);
      expect(report.left).toEqual([]);
      expect(run.processes.stopped).toEqual([201, 300, 200]);

      expect(otherListener).not.toHaveBeenCalled();
      expect(emitSpy.mock.calls.filter((call) => (call[0] as unknown) === "SIGINT")).toEqual([]);
      expect(killSpy).not.toHaveBeenCalled();
      // Only the direct call aborted the run; the installed real listeners never fired.
      expect(notes).toEqual([`${SIMULATED_SIGINT} received; aborting the run`]);
      uninstall();
    } finally {
      emitSpy.mockRestore();
      killSpy.mockRestore();
      process.off("SIGINT", otherListener);
    }
  });
});

describe("ownership checks and process identity (§9.2, H-D18)", () => {
  it("stops each verified process alone, deepest first, then removes the recorded worktree, then the root", async () => {
    const run = recordedRun();
    const report = await teardown(run.seams);

    expect(run.processes.stopped).toEqual([201, 300, 200]);
    expect(run.git.removed).toEqual([join(TEMP, "cdp-bi4-http-abc", "worktree")]);
    expect(run.removedDirectories).toEqual([join(TEMP, "cdp-bi4-http-abc")]);
    expect(report.left).toEqual([]);
  });

  it("never stops a reused PID: a different creation time means the recorded process is gone", async () => {
    const run = recordedRun();
    run.processes.add(identity(300, { creationTime: "999" }));

    const report = await teardown(run.seams);

    expect(run.processes.stopped).not.toContain(300);
    expect(report.absent).toContain(run.ids.calibration);
    expect(checkProcessIdentity(identity(300), identity(300, { creationTime: "999" })).status).toBe("absent");
  });

  it("refuses to stop a process whose executable, command line or port does not match, and leaves it", async () => {
    expect(checkProcessIdentity(identity(5), identity(5, { executable: "C:\\other.exe" })).status).toBe("mismatch");
    expect(checkProcessIdentity(identity(5), identity(5, { commandLine: "node other" })).status).toBe("mismatch");
    expect(checkProcessIdentity(identity(5), identity(5), { port: 9, listener: 77 }).status).toBe("mismatch");
    expect(checkProcessIdentity(identity(5), identity(5), { port: 9, listener: undefined }).status).toBe("verified");

    const run = recordedRun();
    run.processes.add(identity(300, { commandLine: "node something-else" }));
    const report = await teardown(run.seams);

    expect(run.processes.stopped).not.toContain(300);
    expect(report.left.map((entry) => entry.id)).toContain(run.ids.calibration);
  });

  it("builds taskkill for one PID, forced, never with /T, and the Windows operations use exactly that", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const ops = windowsProcessOps(async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    });

    await ops.stop(4242);

    expect(taskkillArguments(4242)).toEqual(["/PID", "4242", "/F"]);
    expect(calls).toEqual([{ command: "taskkill", args: ["/PID", "4242", "/F"] }]);
    expect(calls.flatMap((call) => call.args)).not.toContain("/T");
    expect(() => taskkillArguments(0)).toThrow();
  });

  it("records descendants with their identities and reports, never stops, a live child that is not recorded", async () => {
    const run = recordedRun();
    run.processes.add(identity(202, { parentPid: 200 }));

    const report = await teardown({ ...run.seams });

    expect(run.processes.stopped).not.toContain(202);
    expect(report.left).toEqual([]);

    const fresh = recordedRun();
    fresh.processes.add(identity(202, { parentPid: 200 }));
    await recordDescendants(fresh.log, fresh.processes, fresh.ids.next, 51000);

    expect(fresh.log.entries().some((entry) => entry.identity?.pid === 202 && entry.parentEntry === fresh.ids.next)).toBe(true);
  });

  it("leaves a root that is not a harness root inside the temp directory", async () => {
    const run = recordedRun();
    run.log.intend("harness-root", "elsewhere", { path: join(ROOT, "Users", "someone", "cdp-bi4-http-zzz") });
    run.log.intend("harness-root", "wrong prefix", { path: join(TEMP, "something-else") });

    const report = await teardown(run.seams);

    expect(report.left.map((entry) => entry.reason)).toEqual([
      "not a harness-owned root inside the temp directory",
      "not a harness-owned root inside the temp directory",
    ]);
    expect(run.removedDirectories).toEqual([join(TEMP, "cdp-bi4-http-abc")]);
  });
});

describe("worktree removal (§9.2, H-D18)", () => {
  it("issues no prune and no command but worktree add, list and remove of the recorded path", async () => {
    const calls: (readonly string[])[] = [];
    const git = createGitOps(REPO, async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\n", stderr: "" };
    });

    await git.head();
    await git.statusPorcelain();
    await git.worktreeList();
    await git.addDetachedWorktree(join(TEMP, "cdp-bi4-http-x", "worktree"), COMMIT);
    await git.removeWorktree(join(TEMP, "cdp-bi4-http-x", "worktree"));

    expect(calls.flat()).not.toContain("prune");
    expect(calls.at(-1)).toEqual(["-C", REPO, "worktree", "remove", "--force", join(TEMP, "cdp-bi4-http-x", "worktree")]);
    expect(calls.at(-2)).toEqual(["-C", REPO, "worktree", "add", "--detach", join(TEMP, "cdp-bi4-http-x", "worktree"), COMMIT]);
  });

  it("removes only the recorded worktree, leaving every other worktree alone", async () => {
    const run = recordedRun();
    run.git.worktrees.push({ path: join(ROOT, "elsewhere", "other"), head: COMMIT, detached: true, prunable: false });

    await teardown(run.seams);

    expect(run.git.removed).toEqual([join(TEMP, "cdp-bi4-http-abc", "worktree")]);
    expect(run.git.worktrees.map((entry) => entry.path)).toEqual([REPO, join(ROOT, "elsewhere", "other")]);
  });

  it("reports a stale record — directory gone, record still present — and neither prunes nor removes anything", async () => {
    const run = recordedRun();
    run.directories.delete(join(TEMP, "cdp-bi4-http-abc", "worktree"));

    const report = await teardown(run.seams);

    expect(run.git.removed).toEqual([]);
    expect(report.left.find((entry) => entry.id === run.ids.worktree)?.reason).toMatch(/administrative record remains; not pruned/);
    expect(report.left.find((entry) => entry.id === run.ids.root)?.reason).toMatch(/worktree was left in place/);
  });

  it("refuses a worktree whose HEAD, detachment or administrative record does not match", async () => {
    for (const change of [
      (run: ReturnType<typeof recordedRun>) => ((run.git.worktrees[1] as { head: string }).head = "0".repeat(40)),
      (run: ReturnType<typeof recordedRun>) => ((run.git.worktrees[1] as { detached: boolean }).detached = false),
      (run: ReturnType<typeof recordedRun>) => (run.seams = { ...run.seams, readGitFile: () => "gitdir: C:/repo/.git/worktrees/other\n" }),
    ]) {
      const run = recordedRun();
      change(run);
      await teardown(run.seams);
      expect(run.git.removed).toEqual([]);
    }
  });

  it("parses porcelain worktree lists and administrative record names", () => {
    expect(parseWorktreeList("worktree C:/repo\nHEAD a\nbranch refs/heads/main\n\nworktree C:/t/w\nHEAD b\ndetached\n")).toEqual([
      { path: "C:/repo", head: "a", detached: false, prunable: false },
      { path: "C:/t/w", head: "b", detached: true, prunable: false },
    ]);
    expect(adminRecordOf("gitdir: C:/repo/.git/worktrees/worktree1\n")).toBe("worktree1");
    expect(adminRecordOf("gitdir: C:/elsewhere/thing\n")).toBeUndefined();
  });
});

describe("refusal conditions (§7.1, H-D6)", () => {
  function seams(overrides: Partial<PreconditionSeams> = {}): PreconditionSeams {
    return {
      repositoryRoot: REPO,
      tempDirectory: TEMP,
      authorizedCommit: COMMIT,
      outputDirectory: OUT,
      environment: {},
      portIsFree: async () => true,
      gitHead: async () => `${COMMIT}\n`,
      gitStatusPorcelain: async () => "?? CLAUDE.md\n?? community-directory-through-issue-51-handoff.txt\n",
      directoryEntries: (path) => (path === OUT ? [] : undefined),
      realpath: identityPath,
      restrictedMetadata: () => ({}),
      ...overrides,
    };
  }

  it("passes a clean, correctly placed run and takes the baselines", async () => {
    const result = await checkPreconditions(seams());

    expect(result.refusals).toEqual([]);
    expect(result.restrictedBaseline).toEqual({});
  });

  it("refuses when either personal-demo port is occupied, and never infers anything about the demo from free ports", async () => {
    const occupied = await checkPreconditions(seams({ portIsFree: async (_host, port) => port !== 3000 }));
    const both = await checkPreconditions(seams({ portIsFree: async () => false }));
    const free = await checkPreconditions(seams());

    expect(occupied.refusals).toHaveLength(1);
    expect(occupied.refusals[0]).toMatch(/port 3000/);
    expect(both.refusals).toHaveLength(2);
    expect(JSON.stringify([occupied, both, free])).not.toMatch(/stopped|not running/i);
  });

  it("refuses a tree that is dirty or not at the authorized commit", async () => {
    expect((await checkPreconditions(seams({ gitStatusPorcelain: async () => " M src/x.ts\n" }))).refusals).toHaveLength(1);
    expect((await checkPreconditions(seams({ gitHead: async () => "abc" }))).refusals).toHaveLength(1);
  });

  it("refuses an inherited LOCAL_DEMO_DATABASE_URL", async () => {
    const result = await checkPreconditions(seams({ environment: { LOCAL_DEMO_DATABASE_URL: "postgres://x" } }));

    expect(result.refusals).toEqual([
      "LOCAL_DEMO_DATABASE_URL is set in the harness's own environment; the harness never inherits a database URL",
    ]);
  });

  it("refuses an output directory that is relative, missing, non-empty, inside the repository or the temp directory, or a parent of either", () => {
    const base = { repositoryRoot: REPO, tempDirectory: TEMP, realpath: identityPath };
    const entries = (list: readonly string[] | undefined) => () => list;

    expect(outputDirectoryProblems("relative", { ...base, directoryEntries: entries([]) })).toHaveLength(1);
    expect(outputDirectoryProblems(OUT, { ...base, directoryEntries: entries(undefined) })).toEqual(["the output directory must already exist"]);
    expect(outputDirectoryProblems(OUT, { ...base, directoryEntries: entries(["x"]) })).toEqual(["the output directory must be empty"]);
    expect(outputDirectoryProblems(join(REPO, "out"), { ...base, directoryEntries: entries([]) })).toEqual(["the output directory must be outside the repository"]);
    expect(outputDirectoryProblems(join(TEMP, "out"), { ...base, directoryEntries: entries([]) })).toHaveLength(1);
    expect(outputDirectoryProblems(ROOT, { ...base, directoryEntries: entries([]) })).toHaveLength(2);
  });

  it("refuses when the restricted-file baseline cannot be taken", async () => {
    const result = await checkPreconditions(
      seams({
        restrictedMetadata: () => {
          throw new Error("EACCES");
        },
      }),
    );

    expect(result.refusals).toEqual(["the restricted-file metadata baseline could not be taken: EACCES"]);
  });
});

describe("the explicit database URL (§8)", () => {
  const pidFile = (directory: string) => () => `4321\n${directory}\n`;

  it("builds the URL from recorded values and accepts it only for the recorded cluster", () => {
    const url = buildDatabaseUrl({ user: "postgres", password: "verification-only", port: 55555 });
    const recorded = { port: 55555, clusterDirectory: join(TEMP, "cdp-bi4-e2-a", "cluster") };

    expect(url).toBe("postgres://postgres:verification-only@127.0.0.1:55555/bi4_timing");
    expect(databaseUrlProblems(url, recorded, pidFile(recorded.clusterDirectory))).toEqual([]);
  });

  it("refuses another host, port, database, a personal-demo port, or a postmaster claiming another directory", () => {
    const recorded = { port: 55555, clusterDirectory: join(TEMP, "cdp-bi4-e2-a", "cluster") };
    const owned = pidFile(recorded.clusterDirectory);

    expect(databaseUrlProblems("postgres://u:p@localhost:55555/bi4_timing", recorded, owned)).toHaveLength(1);
    expect(databaseUrlProblems("postgres://u:p@127.0.0.1:55556/bi4_timing", recorded, owned)).toHaveLength(1);
    expect(databaseUrlProblems("postgres://u:p@127.0.0.1:55555/other", recorded, owned)).toHaveLength(1);
    expect(databaseUrlProblems("postgres://u:p@127.0.0.1:54329/bi4_timing", { ...recorded, port: 54329 }, owned)).toEqual([
      "the database port is a personal-demo port",
    ]);
    expect(databaseUrlProblems(buildDatabaseUrl({ user: "u", password: "p", port: 55555 }), recorded, pidFile(join(ROOT, "elsewhere")))).toEqual([
      "the cluster's postmaster.pid does not claim the recorded data directory",
    ]);
  });
});

describe("the restricted-file guard (§10)", () => {
  it("takes existence, size and modification time only, through stat, and detects any change", () => {
    const seen: string[] = [];
    const before = restrictedMetadataOf(REPO, (path) => {
      seen.push(path);
      return path.endsWith("CLAUDE.md") ? { size: 10, mtimeMs: 1 } : undefined;
    });
    const after = restrictedMetadataOf(REPO, (path) => (path.endsWith("CLAUDE.md") ? { size: 11, mtimeMs: 2 } : undefined));

    expect(seen.map((path) => path.split(/[\\/]/).at(-1))).toEqual(["CLAUDE.md", "community-directory-through-issue-51-handoff.txt"]);
    expect(before).toEqual({ "CLAUDE.md": { exists: true, size: 10, mtimeMs: 1 }, "community-directory-through-issue-51-handoff.txt": { exists: false } });
    expect(restrictedChanges(before, after)).toEqual(["CLAUDE.md"]);
    expect(restrictedChanges(before, before)).toEqual([]);
  });
});

describe("cleanup idempotence and the teardown allowance (§9.4, §12.3)", () => {
  it("changes nothing on a second run", async () => {
    const run = recordedRun();
    await teardown(run.seams);
    const second = await teardown(run.seams);

    expect(second.stopped).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.left).toEqual([]);
  });

  it("stops attempting once the allowance is exhausted, records what was left, and a later cleanup finishes it", async () => {
    const run = recordedRun();
    let clock = 0;
    const first = await teardown({ ...run.seams, deadline: 1, now: () => (clock += 1) });

    expect(first.allowanceExhausted).toBe(true);
    expect(first.left.length).toBeGreaterThan(0);
    expect(first.left.every((entry) => entry.reason.startsWith("teardown allowance exhausted"))).toBe(true);

    const later = await teardown(run.seams);
    expect(later.left).toEqual([]);
  });

  it("shuts a verified cluster down through pg_ctl before removing its root, and leaves one whose postmaster does not match", async () => {
    const calls: string[] = [];
    const clusters: ClusterOps = {
      provePostmaster: () => ({ status: "proven", pid: 900 }),
      shutdown: async () => (calls.push("shutdown"), { ok: true }),
      waitForExit: async () => (calls.push("wait"), true),
      removeRoot: async () => (calls.push("remove"), true),
    };
    const build = (postmaster: ProcessIdentity) => {
      const store = new MemoryStore();
      const log = new IntentLog("state", store);
      const id = log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
      log.update(id, { state: "created", path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), postmaster });
      return log;
    };
    const processes = new FakeProcesses().add(identity(900));
    const base = recordedRun().seams;
    const parentSeams = { directoryExists: () => true, listDirectory: () => [], removeEmptyDirectory: () => (calls.push("remove parent"), true) };

    const first = await teardown({ ...base, ...parentSeams, log: build(identity(900)), processes, clusters });
    expect(calls).toEqual(["shutdown", "wait", "remove", "remove parent"]);
    expect(first.removed).toEqual([0]);

    calls.length = 0;
    const report = await teardown({ ...base, ...parentSeams, log: build(identity(900, { executable: "C:\\other.exe" })), processes, clusters });
    expect(calls).toEqual([]);
    expect(report.left).toHaveLength(1);
  });
});

describe("zero residue (§5.3)", () => {
  it("reports live processes, held ports, roots, worktree records, restricted-file changes and status changes", async () => {
    const run = recordedRun();
    const residue = await residueOf(run.log.entries(), {
      processes: run.processes,
      git: run.git,
      repositoryRoot: REPO,
      repositoryGitDirectory: GIT_DIR,
      restrictedBaseline: { "CLAUDE.md": { exists: true, size: 1, mtimeMs: 1 } },
      statusBaseline: "?? CLAUDE.md\n",
      portIsFree: async () => false,
      directoryExists: run.seams.directoryExists as (path: string) => boolean,
      restrictedMetadata: () => ({ "CLAUDE.md": { exists: true, size: 2, mtimeMs: 2 } }),
      realpath: identityPath,
    });

    expect(residue.some((line) => line.startsWith("process 200"))).toBe(true);
    expect(residue.some((line) => line.startsWith("port 51000"))).toBe(true);
    expect(residue.some((line) => line.startsWith("root"))).toBe(true);
    expect(residue).toContain("the worktree record worktree remains under .git/worktrees/");
    expect(residue).toContain("git worktree list shows more than the main tree");
    expect(residue).toContain("restricted-file metadata changed: CLAUDE.md");

    await teardown(run.seams);
    const clean = await residueOf(run.log.entries(), {
      processes: run.processes,
      git: run.git,
      repositoryRoot: REPO,
      repositoryGitDirectory: GIT_DIR,
      restrictedBaseline: {},
      statusBaseline: "?? CLAUDE.md\n",
      portIsFree: async () => true,
      directoryExists: run.seams.directoryExists as (path: string) => boolean,
      restrictedMetadata: () => ({}),
      realpath: identityPath,
    });
    expect(clean).toEqual([]);
  });
});

describe("the forced smoke pass (§5.3.1, H-D18)", () => {
  function forced(options: { readonly identityChanges?: boolean; readonly survivorsGone?: boolean; readonly marker?: Partial<ReadyMarker> | null } = {}) {
    const run = recordedRun();
    const harness = identity(100);
    run.processes.add(harness);
    // The cluster the harness started, with its postmaster.
    const cluster = run.log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
    run.log.update(cluster, { state: "created", path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), postmaster: identity(900) });
    run.processes.add(identity(900));
    run.directories.add(CLUSTER_PARENT);
    run.directories.add(CLUSTER_ROOT);
    if (options.survivorsGone) run.processes.table.delete(900);

    let cleanups = 0;
    const seams = {
      boundary: "e2" as const,
      processes: run.processes,
      git: run.git,
      spawnHarness: async () => ({ pid: 100 }),
      waitForReady: async (): Promise<ReadyMarker | undefined> => {
        if (options.identityChanges) run.processes.add(identity(100, { commandLine: "node something-else" }));
        return options.marker === null ? undefined : { pid: 100, measured: FORCED_KILL_AFTER, identity: identity(100), ...options.marker };
      },
      waitGone: async (pid: number) => !run.processes.table.has(pid),
      loadLog: () => run.log,
      cleanup: async () => {
        cleanups += 1;
        return teardown({
          ...run.seams,
          clusters: {
            provePostmaster: () => (run.processes.table.has(900) ? { status: "proven", pid: 900 } : { status: "missing" }),
            shutdown: async () => (run.processes.table.delete(900), { ok: true }),
            waitForExit: async () => true,
            removeRoot: async () => (run.directories.delete(CLUSTER_ROOT), true),
          },
        });
      },
      directoryExists: run.seams.directoryExists,
      realpath: identityPath,
    };

    return { run, seams, cleanups: () => cleanups };
  }

  it("kills only the harness PID after confirming its identity, snapshots survivors, cleans up, and the second cleanup is a no-op", async () => {
    const { run, seams } = forced();
    const result = await forcedPass(seams);

    expect(run.processes.stopped[0]).toBe(100);
    expect(result.status).toBe("exercised");
    expect(result.snapshot?.present).toEqual(expect.arrayContaining(["cluster postmaster", "next dev", "calibration server", "worktree"]));
    expect(result.firstCleanup?.stopped.length).toBeGreaterThan(0);
    expect(result.secondCleanup?.stopped).toEqual([]);
    expect(result.secondCleanup?.removed).toEqual([]);
  });

  it("refuses to kill when the harness identity changed, and starts no cleanup", async () => {
    const { run, seams, cleanups } = forced({ identityChanges: true });
    const result = await forcedPass(seams);

    expect(result.status).toBe("refused");
    expect(run.processes.stopped).toEqual([]);
    expect(cleanups()).toBe(0);
  });

  it("marks the pass Not exercised when a required survivor is missing", async () => {
    const { seams } = forced({ survivorsGone: true });
    const result = await forcedPass(seams);

    expect(result.status).toBe("not-exercised");
    expect(result.missingSurvivors).toEqual(["cluster postmaster"]);
  });
});

describe("the smoke-based re-estimate (§5.5, H-D16)", () => {
  it("projects setup + count × median per request + teardown, and needs a ruling above 80% of the ceiling", () => {
    const projected = projectReplicateMs({ setupMs: 60_000, teardownMs: 10_000, medianRequestMs: { next: 30, calibration: 2 } }, { next: 21_790, calibration: 16_940 });

    expect(projected).toBe(60_000 + 10_000 + 21_790 * 30 + 16_940 * 2);
    expect(projectionNeedsRuling(0.8 * 75 * 60_000, 75)).toBe(false);
    expect(projectionNeedsRuling(0.8 * 75 * 60_000 + 1, 75)).toBe(true);
  });
});

describe("smoke pass outcomes (§5)", () => {
  const sa = (overrides: Partial<InProcessPassReport> = {}): InProcessPassReport => ({
    exitCode: 0, requests: 40, measured: 30, stoppedBy: null, invalid: [], residue: [], ...overrides,
  });
  const sb = (overrides: Partial<InProcessPassReport> = {}): InProcessPassReport => ({
    exitCode: 1, requests: 20, measured: FORCED_KILL_AFTER, stoppedBy: "abort", invalid: [S_B_EXPECTED_ABORT], residue: [], ...overrides,
  });
  const cleanReport = { stopped: [], removed: [], absent: [], left: [], allowanceExhausted: false };
  const sc = (overrides: Partial<ForcedPassReport> = {}): ForcedPassReport => ({
    status: "exercised", requests: 20, measured: FORCED_KILL_AFTER, residue: [],
    firstCleanup: { ...cleanReport, stopped: [1], removed: [2] }, secondCleanup: cleanReport, ...overrides,
  });

  it("passes S-A only when it ran to completion with nothing Invalid and zero residue", () => {
    expect(evaluateInProcessPass("S-A", sa())).toEqual({ status: "passed", reasons: [] });
    expect(evaluateInProcessPass("S-A", sa({ exitCode: 2, invalid: ["port 3000 is occupied"] })).status).toBe("refused");
    expect(evaluateInProcessPass("S-A", sa({ exitCode: 1, invalid: ["Invalid (cleanup)"] })).status).toBe("failed");
    expect(evaluateInProcessPass("S-A", sa({ stoppedBy: "cap", exitCode: 1, invalid: ["Failed (cap): smoke request cap reached"] })).status).toBe("failed");
    expect(evaluateInProcessPass("S-A", sa({ requests: 0, measured: 0 })).status).toBe("failed");
    expect(evaluateInProcessPass("S-A", sa({ residue: ["root C:\\x still exists"] })).reasons).toEqual(["residue: root C:\\x still exists"]);
  });

  it("passes S-B only when its simulated SIGINT stopped it after exactly the 10th measured request, and nothing else went wrong", () => {
    expect(evaluateInProcessPass("S-B", sb())).toEqual({ status: "passed", reasons: [] });
    // Running to completion is the wrong outcome for the interruption pass.
    expect(evaluateInProcessPass("S-B", sb({ exitCode: 0, stoppedBy: null, invalid: [], measured: 30 })).status).toBe("failed");
    expect(evaluateInProcessPass("S-B", sb({ measured: 11 })).status).toBe("failed");
    expect(evaluateInProcessPass("S-B", sb({ invalid: ["Aborted: SIGTERM"] })).reasons).toEqual([
      `the expected "${S_B_EXPECTED_ABORT}" was not recorded`,
      "unexpected: Aborted: SIGTERM",
    ]);
    expect(evaluateInProcessPass("S-B", sb({ invalid: [S_B_EXPECTED_ABORT, "Invalid (cleanup)"] })).status).toBe("failed");
    expect(evaluateInProcessPass("S-B", sb({ residue: ["port 51000 (next dev) is not free"] })).status).toBe("failed");
    expect(evaluateInProcessPass("S-B", sb({ exitCode: 2, invalid: ["refused"] })).status).toBe("refused");
  });

  it("passes S-C only when exercised, with a clean recovery cleanup, a no-op second cleanup and zero residue", () => {
    expect(evaluateForcedPass(sc())).toEqual({ status: "passed", reasons: [] });
    expect(evaluateForcedPass(sc({ status: "refused", reason: "identity changed" }))).toEqual({ status: "refused", reasons: ["identity changed"] });
    expect(evaluateForcedPass(sc({ status: "not-exercised", reason: "required survivors missing: cluster postmaster" })).status).toBe("not-exercised");
    expect(evaluateForcedPass(sc({ firstCleanup: { ...cleanReport, left: [{ id: 3, reason: "mismatch" }] } })).status).toBe("failed");
    expect(evaluateForcedPass(sc({ secondCleanup: { ...cleanReport, removed: [4] } })).reasons).toEqual(["the second cleanup was not a no-op (0 stopped, 1 removed, 0 left)"]);
    expect(evaluateForcedPass(sc({ secondCleanup: undefined })).status).toBe("failed");
    expect(evaluateForcedPass(sc({ measured: 9 })).status).toBe("failed");
    expect(evaluateForcedPass(sc({ residue: ["git worktree list shows more than the main tree"] })).status).toBe("failed");
  });

  function driver(options: {
    readonly inProcess?: Partial<Record<"S-A" | "S-B", Partial<InProcessPassReport> | Error>>;
    readonly forced?: Partial<ForcedPassReport> | Error;
    readonly requestCap?: number;
    readonly now?: () => number;
  } = {}) {
    const calls: string[] = [];
    const writes: Record<string, unknown>[] = [];
    const seams: SmokeDriverSeams = {
      requestCap: options.requestCap ?? 200,
      deadline: 1_000,
      now: options.now ?? (() => 0),
      runInProcess: async (pass, cap) => {
        calls.push(`${pass} cap ${cap}`);
        const configured = options.inProcess?.[pass];
        if (configured instanceof Error) throw configured;
        return pass === "S-A" ? sa(configured) : sb(configured);
      },
      runForced: async (cap) => {
        calls.push(`S-C cap ${cap}`);
        if (options.forced instanceof Error) throw options.forced;
        return sc(options.forced);
      },
      writeReport: (report) => writes.push(JSON.parse(JSON.stringify(report)) as Record<string, unknown>),
    };
    return { seams, calls, writes, report: { boundary: "e1" } as Record<string, unknown> };
  }

  it("exits 0 only when all three passes passed, sharing one request budget, and writes the report after every pass", async () => {
    const run = driver();
    const outcome = await driveSmoke(run.seams, run.report);

    expect(outcome.exitCode).toBe(0);
    expect(run.calls).toEqual(["S-A cap 200", "S-B cap 160", "S-C cap 140"]);
    expect(run.writes.length).toBeGreaterThanOrEqual(3);
    expect(run.writes[0]?.passStatus).toEqual({ "S-A": "passed", "S-B": "missing", "S-C": "missing" });
    expect(run.report.outcome).toBe("all three passes passed");
    expect(run.report.requestsUsed).toBe(80);
  });

  it("starts no later pass after a failed prerequisite, records them missing, and exits nonzero", async () => {
    const run = driver({ inProcess: { "S-A": { exitCode: 1, invalid: ["Invalid (cleanup)"] } } });
    const outcome = await driveSmoke(run.seams, run.report);

    expect(outcome.exitCode).toBe(1);
    expect(run.calls).toEqual(["S-A cap 200"]);
    expect(outcome.verdicts["S-B"]).toEqual({ status: "missing", reasons: ["not started: S-A was failed, so the next pass's prerequisite failed"] });
    expect(outcome.verdicts["S-C"].status).toBe("missing");
    expect(run.report.outcome).toBe("failed");

    const interrupted = driver({ inProcess: { "S-B": { stoppedBy: null, exitCode: 0, invalid: [], measured: 30 } } });
    expect((await driveSmoke(interrupted.seams, interrupted.report)).exitCode).toBe(1);
    expect(interrupted.calls).toEqual(["S-A cap 200", "S-B cap 160"]);
  });

  it("starts no pass once the request cap or the time cap is reached", async () => {
    const capped = driver({ requestCap: 40 });
    expect((await driveSmoke(capped.seams, capped.report)).exitCode).toBe(1);
    expect(capped.calls).toEqual(["S-A cap 40"]);
    expect((capped.report["S-B"] as { reasons: string[] }).reasons).toEqual(["not started: the smoke request cap was reached"]);

    let clock = 0;
    const timed = driver({ now: () => clock });
    timed.seams = {
      ...timed.seams,
      runInProcess: async (pass) => {
        timed.calls.push(pass);
        clock = 2_000;
        return sa();
      },
    };
    expect((await driveSmoke(timed.seams, timed.report)).exitCode).toBe(1);
    expect(timed.calls).toEqual(["S-A"]);
    expect((timed.report["S-B"] as { reasons: string[] }).reasons).toEqual(["not started: the smoke time cap was reached"]);
  });

  it("preserves the report when a pass throws, and exits nonzero", async () => {
    const run = driver({ inProcess: { "S-B": new Error("cluster startup failed") } });
    const outcome = await driveSmoke(run.seams, run.report);
    const last = run.writes.at(-1) as Record<string, { status: string; reasons: string[] }>;

    expect(outcome.exitCode).toBe(1);
    expect(run.calls).toEqual(["S-A cap 200", "S-B cap 160"]);
    expect(last["S-A"]?.status).toBe("passed");
    expect(last["S-B"]).toEqual({ status: "failed", reasons: ["the pass did not complete: cluster startup failed"] });
    expect(last["S-C"]?.status).toBe("missing");
  });

  it("exits nonzero when S-C is refused or Not exercised, or leaves residue", async () => {
    for (const forced of [{ status: "refused" as const, reason: "x" }, { status: "not-exercised" as const, reason: "y" }, { residue: ["root z still exists"] }]) {
      const run = driver({ forced });
      expect((await driveSmoke(run.seams, run.report)).exitCode).toBe(1);
    }
  });
});

describe("the run-specific cluster location", () => {
  it("redirects the temp variables only while the start call runs synchronously, and restores them, including unset ones", async () => {
    const environment = { TEMP: "C:\\T", TMP: "C:\\T" } as unknown as NodeJS.ProcessEnv;
    let seenAtCall: (string | undefined)[] = [];
    let seenAfterAwait: (string | undefined)[] = [];

    await startUnderParent(
      CLUSTER_PARENT,
      async () => {
        seenAtCall = TEMP_VARIABLES.map((name) => environment[name]);
        await Promise.resolve();
        seenAfterAwait = TEMP_VARIABLES.map((name) => environment[name]);
      },
      environment,
    );

    expect(seenAtCall).toEqual([CLUSTER_PARENT, CLUSTER_PARENT, CLUSTER_PARENT]);
    expect(seenAfterAwait).toEqual(["C:\\T", "C:\\T", undefined]);
    expect("TMPDIR" in environment).toBe(false);
    expect(() =>
      startUnderParent(
        CLUSTER_PARENT,
        () => {
          throw new Error("sync");
        },
        environment,
      ),
    ).toThrow("sync");
    expect(environment).toEqual({ TEMP: "C:\\T", TMP: "C:\\T" });
  });

  it("places a mkdtemp root made through os.tmpdir() inside the parent, as the helper makes its root", async () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-location-test-"));
    try {
      const parent = join(base, "cdp-bi4-cluster-0a1b2c3d4e5f");
      mkdirSync(parent);
      const made = startUnderParent(parent, async () => mkdtempSync(join(tmpdir(), `cdp-${CLUSTER_SLUG}-`)));
      const located = locateClusterRoot(parent, CLUSTER_SLUG);

      expect(located).toEqual({ path: await made });
      expect(tmpdir()).not.toBe(parent);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("locates only exactly one entry named as the helper names this slug's roots", () => {
    const list = (entries: string[] | undefined) => () => entries;
    expect(locateClusterRoot(CLUSTER_PARENT, CLUSTER_SLUG, list([basename(CLUSTER_ROOT)]))).toEqual({ path: CLUSTER_ROOT });
    expect(locateClusterRoot(CLUSTER_PARENT, CLUSTER_SLUG, list(undefined))).toHaveProperty("problem");
    expect(locateClusterRoot(CLUSTER_PARENT, CLUSTER_SLUG, list([]))).toHaveProperty("problem");
    expect(locateClusterRoot(CLUSTER_PARENT, CLUSTER_SLUG, list([basename(CLUSTER_ROOT), "cdp-bi4-smoke-e2-Zz99Yy"]))).toHaveProperty("problem");
    expect(locateClusterRoot(CLUSTER_PARENT, CLUSTER_SLUG, list(["cdp-bi4-smoke-e1-Ab12Cd"]))).toHaveProperty("problem");
    expect(clusterRootPattern("bi4-smoke-e2").test("cdp-bi4-smoke-e2-Ab12Cd")).toBe(true);
    expect(clusterRootPattern("bi4-smoke-e2").test("cdp-bi4-smoke-e2-Ab12Cd-x")).toBe(false);
  });

  it("accepts only a recorded parent directly in temp, with the root directly inside it and its cluster directory", () => {
    const entry: ResourceEntry = { id: 0, kind: "cluster", label: CLUSTER_SLUG, state: "created", parent: CLUSTER_PARENT, path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster") };
    const outside = join(TEMP, "cdp-bi4-smoke-e2-Ab12Cd");

    expect(clusterLocationProblems(entry, TEMP, identityPath)).toEqual([]);
    expect(clusterLocationProblems({ ...entry, parent: undefined }, TEMP, identityPath)).toEqual(["no run-specific cluster parent was recorded"]);
    expect(clusterLocationProblems({ ...entry, parent: join(ROOT, "elsewhere", "cdp-bi4-cluster-1") }, TEMP, identityPath).length).toBeGreaterThan(0);
    expect(clusterLocationProblems({ ...entry, parent: join(TEMP, "cdp-bi4-http-1") }, TEMP, identityPath).length).toBeGreaterThan(0);
    expect(clusterLocationProblems({ ...entry, path: outside, clusterDirectory: join(outside, "cluster") }, TEMP, identityPath)).toEqual([
      "the recorded cluster root is not directly inside the recorded parent",
    ]);
    expect(clusterLocationProblems({ ...entry, path: join(CLUSTER_PARENT, "other"), clusterDirectory: join(CLUSTER_PARENT, "other", "cluster") }, TEMP, identityPath)).toHaveLength(1);
    expect(clusterLocationProblems({ ...entry, clusterDirectory: join(CLUSTER_ROOT, "elsewhere") }, TEMP, identityPath)).toHaveLength(1);
  });

  function clusterTeardown(fields: Partial<Omit<ResourceEntry, "id" | "kind" | "label">>, directories: string[]) {
    const log = new IntentLog("state", new MemoryStore());
    const id = log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
    if (Object.keys(fields).length > 0) log.update(id, fields);
    const present = new Set(directories);
    const calls: string[] = [];
    const seams: TeardownSeams = {
      ...recordedRun().seams,
      log,
      processes: new FakeProcesses(),
      clusters: { ...noClusters, removeRoot: async (path) => (calls.push(`remove root ${path}`), present.delete(path)) },
      directoryExists: (path) => present.has(path),
      listDirectory: (path) => (present.has(path) ? [...present].filter((candidate) => dirname(candidate) === path).map((candidate) => basename(candidate)) : undefined),
      removeEmptyDirectory: (path) => (calls.push(`remove parent ${path}`), present.delete(path)),
    };
    return { log, seams, calls, present };
  }

  it("removes an empty parent whose root was never recorded, and reports, never searches, one that holds anything", async () => {
    const empty = clusterTeardown({}, [CLUSTER_PARENT]);
    expect((await teardown(empty.seams)).removed).toEqual([0]);
    expect(empty.calls).toEqual([`remove parent ${CLUSTER_PARENT}`]);

    const occupied = clusterTeardown({}, [CLUSTER_PARENT, CLUSTER_ROOT]);
    const report = await teardown(occupied.seams);
    expect(report.left).toEqual([{ id: 0, reason: "the run's cluster parent still holds 1 unrecorded entry; nothing unrecorded is removed" }]);
    expect(occupied.calls).toEqual([]);
    expect(occupied.present.has(CLUSTER_ROOT)).toBe(true);

    const never = clusterTeardown({}, []);
    expect((await teardown(never.seams)).absent).toEqual([0]);
  });

  it("removes the recorded root, then the parent only if empty, and touches nothing at an unverified location", async () => {
    // A recorded postmaster that is gone, with postmaster.pid missing: absence is established.
    const recorded = { state: "created" as const, path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), postmaster: identity(950) };
    const clean = clusterTeardown(recorded, [CLUSTER_PARENT, CLUSTER_ROOT]);
    expect((await teardown(clean.seams)).removed).toEqual([0]);
    expect(clean.calls).toEqual([`remove root ${CLUSTER_ROOT}`, `remove parent ${CLUSTER_PARENT}`]);

    const stray = join(CLUSTER_PARENT, "unrecorded");
    const crowded = clusterTeardown(recorded, [CLUSTER_PARENT, CLUSTER_ROOT, stray]);
    expect((await teardown(crowded.seams)).left).toHaveLength(1);
    expect(crowded.calls).toEqual([`remove root ${CLUSTER_ROOT}`]);
    expect(crowded.present.has(stray)).toBe(true);

    const outside = join(TEMP, "cdp-bi4-smoke-e2-Ab12Cd");
    const unverified = clusterTeardown({ state: "created", path: outside, clusterDirectory: join(outside, "cluster") }, [CLUSTER_PARENT, outside]);
    const report = await teardown(unverified.seams);
    expect(report.left[0]?.reason).toMatch(/^not this run's cluster location/);
    expect(unverified.calls).toEqual([]);
  });

  it("reports a remaining cluster parent as residue", async () => {
    const { log } = clusterTeardown({ state: "removed" }, []);
    const residue = await residueOf(log.entries(), {
      processes: new FakeProcesses(),
      git: new FakeGit([{ path: REPO, head: COMMIT, detached: false, prunable: false }]),
      repositoryRoot: REPO,
      repositoryGitDirectory: GIT_DIR,
      restrictedBaseline: {},
      statusBaseline: "?? CLAUDE.md\n",
      portIsFree: async () => true,
      directoryExists: (path) => path === CLUSTER_PARENT,
      restrictedMetadata: () => ({}),
      realpath: identityPath,
    });
    expect(residue).toEqual([`cluster parent ${CLUSTER_PARENT} still exists`]);
  });
});

describe("the S-C checkpoint (§5.3.1, revision 3)", () => {
  /** A fake clock that advances only when the checkpoint sleeps. */
  function fakeClock() {
    let now = 0;
    const sleeps: number[] = [];
    return { now: () => now, sleep: async (ms: number) => (sleeps.push(ms), (now += ms), undefined), sleeps };
  }

  it("publishes the ready marker before holding, sends nothing while held, and times out at the bound", async () => {
    const clock = fakeClock();
    const events: string[] = [];
    const outcome = await holdAtCheckpoint(
      { pid: 100, measured: FORCED_KILL_AFTER },
      { publish: (marker) => events.push(`publish ${marker.pid}/${marker.measured}`), sleep: async (ms) => (events.push("hold"), clock.sleep(ms)), now: clock.now, timeoutMs: 120 },
    );

    expect(outcome).toBe("timeout");
    expect(events[0]).toBe("publish 100/10");
    expect(events.slice(1).every((event) => event === "hold")).toBe(true);
    expect(clock.now()).toBe(120);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(50);
  });

  it("stops holding when its run is aborted", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const outcome = await holdAtCheckpoint(
      { pid: 100, measured: FORCED_KILL_AFTER },
      {
        publish: () => {},
        sleep: async (ms) => {
          await clock.sleep(ms);
          if (clock.now() >= 100) controller.abort();
        },
        now: clock.now,
        timeoutMs: 60_000,
        signal: controller.signal,
      },
    );

    expect(outcome).toBe("aborted");
    expect(clock.now()).toBe(100);
  });

  it("authorizes the kill only for a marker from the spawned PID, at exactly 10, with a matching identity", () => {
    const recorded = identity(100);
    expect(readyMarkerProblems({ pid: 100, measured: 10, identity: recorded }, 100, recorded)).toEqual([]);
    expect(readyMarkerProblems({ pid: 100, measured: 10 }, 100, recorded)).toEqual([]);
    expect(readyMarkerProblems({ pid: 101, measured: 10 }, 100, recorded)).toEqual(["the ready marker names pid 101, not the spawned harness 100"]);
    expect(readyMarkerProblems({ pid: 100, measured: 11 }, 100, recorded)).toEqual(["the ready marker reports 11 measured requests, not 10"]);
    expect(readyMarkerProblems({ pid: 100, measured: 10, identity: identity(100, { creationTime: "1" }) }, 100, recorded)).toEqual([
      "the identity in the ready marker differs from the one recorded at spawn",
    ]);
  });
});

describe("the forced pass waits for the checkpoint (§5.3.1, revision 3)", () => {
  function forcedRun(marker: Partial<ReadyMarker> | null) {
    const run = recordedRun();
    run.processes.add(identity(100));
    let cleanups = 0;
    const seams = {
      boundary: "e1" as const,
      processes: run.processes,
      git: run.git,
      spawnHarness: async () => ({ pid: 100 }),
      waitForReady: async (): Promise<ReadyMarker | undefined> =>
        marker === null ? undefined : { pid: 100, measured: FORCED_KILL_AFTER, identity: identity(100), ...marker },
      waitGone: async (pid: number) => !run.processes.table.has(pid),
      loadLog: () => run.log,
      cleanup: async () => (cleanups += 1, teardown(run.seams)),
      directoryExists: run.seams.directoryExists,
      realpath: identityPath,
    };
    return { run, seams, cleanups: () => cleanups };
  }

  it("refuses, kills nothing and starts no cleanup when no ready marker appears within the bound", async () => {
    const { run, seams, cleanups } = forcedRun(null);
    const result = await forcedPass(seams);

    expect(result).toEqual({ status: "refused", reason: "the harness did not publish its ready marker at the checkpoint within the bound; nothing was killed" });
    expect(run.processes.stopped).toEqual([]);
    expect(cleanups()).toBe(0);
  });

  it("refuses a marker from another PID, at another count, or with another identity", async () => {
    for (const marker of [{ pid: 999 }, { measured: 11 }, { identity: identity(100, { executable: "C:\\other.exe" }) }]) {
      const { run, seams, cleanups } = forcedRun(marker);
      const result = await forcedPass(seams);
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/nothing was killed$/);
      expect(run.processes.stopped).toEqual([]);
      expect(cleanups()).toBe(0);
    }
  });

  it("kills only the held harness once its marker and live identity are verified", async () => {
    const { run, seams } = forcedRun({});
    await forcedPass(seams);
    expect(run.processes.stopped[0]).toBe(100);
  });
});

describe("fail-closed cluster recovery (revision 3)", () => {
  const recordedPostmaster = identity(900);

  it("classifies postmaster.pid as missing, unreadable, malformed, mismatched or proven without acting on it", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const proveOk = () => ({ pid: 900 });
    const proveMismatch = () => {
      throw new Error("claims data directory elsewhere");
    };
    const directory = join(CLUSTER_ROOT, "cluster");

    expect(readPidFileEvidence(directory, fail("ENOENT"), proveOk)).toEqual({ status: "missing" });
    expect(readPidFileEvidence(directory, fail("EACCES"), proveOk).status).toBe("unreadable");
    expect(readPidFileEvidence(directory, () => "not-a-pid\nC:/x\n", proveOk).status).toBe("malformed");
    expect(readPidFileEvidence(directory, () => "900\n\n", proveOk).status).toBe("malformed");
    expect(readPidFileEvidence(directory, () => "0\nC:/x\n", proveOk).status).toBe("malformed");
    expect(readPidFileEvidence(directory, () => "900\nC:/elsewhere\n", proveMismatch)).toEqual({ status: "mismatch", detail: "claims data directory elsewhere" });
    expect(readPidFileEvidence(directory, () => "900\nC:/x\n", proveOk)).toEqual({ status: "proven", pid: 900 });
  });

  /** A recorded cluster on disk, with the given pid-file evidence and live processes. */
  function unresolved(evidence: PidFileEvidence, options: { readonly postmaster?: ProcessIdentity; readonly live?: ProcessIdentity[]; readonly shutdownOk?: boolean; readonly exits?: boolean } = {}) {
    const log = new IntentLog("state", new MemoryStore());
    const id = log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
    log.update(id, { state: "created", path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), ...(options.postmaster === undefined ? {} : { postmaster: options.postmaster }) });
    const present = new Set([CLUSTER_PARENT, CLUSTER_ROOT]);
    const calls: string[] = [];
    const processes = new FakeProcesses().add(...(options.live ?? []));
    const seams: TeardownSeams = {
      ...recordedRun().seams,
      log,
      processes,
      clusters: {
        provePostmaster: () => evidence,
        shutdown: async () => (calls.push("shutdown"), { ok: options.shutdownOk ?? true }),
        waitForExit: async () => (calls.push("wait"), options.exits ?? true),
        removeRoot: async (path) => (calls.push("remove root"), present.delete(path)),
      },
      directoryExists: (path) => present.has(path),
      listDirectory: (path) => (present.has(path) ? [...present].filter((candidate) => dirname(candidate) === path).map((candidate) => basename(candidate)) : undefined),
      removeEmptyDirectory: (path) => (calls.push("remove parent"), present.delete(path)),
    };
    return { seams, calls, present, processes };
  }

  const preserved = async (run: ReturnType<typeof unresolved>, reason: RegExp) => {
    const report = await teardown(run.seams);
    expect(report.left).toHaveLength(1);
    expect(report.left[0]?.reason).toMatch(/^unresolved cluster; root and parent preserved: /);
    expect(report.left[0]?.reason).toMatch(reason);
    expect(run.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(run.present.has(CLUSTER_ROOT) && run.present.has(CLUSTER_PARENT)).toBe(true);
    expect(run.processes.stopped).toEqual([]);
    return report;
  };

  it("preserves the root and parent when postmaster.pid is missing and no identity was recorded", async () => {
    await preserved(unresolved({ status: "missing" }), /missing and no postmaster identity was recorded/);
  });

  it("preserves them when postmaster.pid is unreadable, malformed or mismatched, even with the recorded postmaster gone", async () => {
    await preserved(unresolved({ status: "unreadable", detail: "EACCES" }, { postmaster: recordedPostmaster }), /postmaster\.pid is unreadable/);
    await preserved(unresolved({ status: "malformed", detail: "bad" }, { postmaster: recordedPostmaster }), /postmaster\.pid is malformed/);
    await preserved(unresolved({ status: "mismatch", detail: "other directory" }, { postmaster: recordedPostmaster }), /postmaster\.pid is mismatch/);
  });

  it("never stops a live postmaster whose identity was never recorded, and neither shuts it down nor removes anything", async () => {
    const run = unresolved({ status: "proven", pid: 901 }, { live: [identity(901)] });
    await preserved(run, /pid 901.*no postmaster identity was recorded; an unrecorded process is never stopped/);
    expect(run.calls).toEqual([]);
  });

  it("preserves them when postmaster.pid is missing but the recorded postmaster is alive, or names another live PID", async () => {
    await preserved(unresolved({ status: "missing" }, { postmaster: recordedPostmaster, live: [recordedPostmaster] }), /missing while the recorded postmaster 900 is still alive/);
    await preserved(unresolved({ status: "proven", pid: 902 }, { postmaster: recordedPostmaster, live: [identity(902)] }), /names live pid 902, not the recorded postmaster 900/);
  });

  it("preserves them when shutdown fails or the exit is never observed", async () => {
    await preserved(unresolved({ status: "proven", pid: 900 }, { postmaster: recordedPostmaster, live: [recordedPostmaster], shutdownOk: false }), /pg_ctl shutdown .* did not complete/);
    await preserved(unresolved({ status: "proven", pid: 900 }, { postmaster: recordedPostmaster, live: [recordedPostmaster], exits: false }), /was not observed to exit/);
  });

  it("preserves the parent when the root is gone but the recorded postmaster is still alive", async () => {
    const run = unresolved({ status: "missing" }, { postmaster: recordedPostmaster, live: [recordedPostmaster] });
    run.present.delete(CLUSTER_ROOT);
    const report = await teardown(run.seams);
    expect(report.left[0]?.reason).toMatch(/the root is gone but the recorded postmaster 900 is still alive/);
    expect(run.present.has(CLUSTER_PARENT)).toBe(true);
  });

  it("removes the root and parent only on positive evidence: verified shutdown, a gone recorded postmaster, or a proven stale PID", async () => {
    const shut = unresolved({ status: "proven", pid: 900 }, { postmaster: recordedPostmaster, live: [recordedPostmaster] });
    expect((await teardown(shut.seams)).removed).toEqual([0]);
    expect(shut.calls).toEqual(["shutdown", "wait", "remove root", "remove parent"]);

    const gone = unresolved({ status: "missing" }, { postmaster: recordedPostmaster });
    expect((await teardown(gone.seams)).removed).toEqual([0]);

    const stale = unresolved({ status: "proven", pid: 903 });
    expect((await teardown(stale.seams)).removed).toEqual([0]);
    expect(stale.calls).toEqual(["remove root", "remove parent"]);
  });

  it("decides the same way when called directly, so cleanup reports the resource as left and exits nonzero", async () => {
    const run = unresolved({ status: "missing" });
    const entry = run.seams.log.entries()[0] as ResourceEntry;
    expect(await establishClusterStopped(entry, { status: "missing" }, true, run.seams)).toMatch(/absence cannot be established/);
    expect(await establishClusterStopped({ ...entry, postmaster: recordedPostmaster }, { status: "missing" }, true, run.seams)).toBe(true);
  });
});

describe("Windows process inspection never reads a failed lookup as absence (revision 4)", () => {
  const complete = { pid: 900, parentPid: 1, creationTime: "133400000000900", executable: "C:\\pg\\postgres.exe", commandLine: "postgres -D x" };
  const envelope = (processes: unknown[]) => JSON.stringify({ ok: true, processes });
  /** Windows operations over a runner that always answers with this result. */
  const opsAnswering = (result: { code: number | null; stdout: string; stderr: string } | Error) =>
    windowsProcessOps(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

  it("returns undefined only for a successful lookup that matched nothing, and the identity for exactly one match", async () => {
    expect(await opsAnswering(ok(envelope([]))).inspect(900)).toBeUndefined();
    expect(await opsAnswering(ok(envelope([complete]))).inspect(900)).toEqual(complete);
    expect(await opsAnswering(ok(envelope([{ ...complete, executable: null, commandLine: null }]))).inspect(900)).toEqual({ ...complete, executable: null, commandLine: null });
  });

  it("throws, never returns undefined, for a PowerShell or CIM failure", async () => {
    const failures = [
      { code: 1, stdout: "", stderr: "Get-CimInstance : Access denied" },
      { code: null, stdout: "", stderr: "" },
      { code: 0, stdout: envelope([]), stderr: "WARNING: something" },
      // Empty output with exit 0 was read as "no process" before revision 4.
      ok(""),
    ];
    for (const failure of failures) await expect(opsAnswering(failure).inspect(900)).rejects.toThrow(ProcessInspectionError);
    await expect(opsAnswering(new Error("spawn powershell.exe ENOENT")).inspect(900)).rejects.toThrow(/PowerShell could not be run/);
  });

  it("throws for a malformed result, a missing envelope, or an ambiguous match", async () => {
    for (const stdout of ["not json", "[]", JSON.stringify(complete), JSON.stringify({ ok: false, processes: [] }), JSON.stringify({ ok: true })]) {
      await expect(opsAnswering(ok(stdout)).inspect(900)).rejects.toThrow(ProcessInspectionError);
    }
    await expect(opsAnswering(ok(envelope([complete, { ...complete, creationTime: "1" }]))).inspect(900)).rejects.toThrow(/2 processes matched pid 900/);
    await expect(opsAnswering(ok(envelope([{ ...complete, pid: 901 }]))).inspect(900)).rejects.toThrow(/returned pid 901/);
    await expect(opsAnswering(ok(envelope([{ ...complete, parentPid: 7 }]))).children(900)).rejects.toThrow(/another parent/);
  });

  it("throws for an incomplete identity rather than returning it", async () => {
    const { creationTime: _dropped, ...withoutCreation } = complete;
    const { executable: _gone, ...withoutExecutable } = complete;
    for (const entry of [withoutCreation, { ...complete, creationTime: null }, { ...complete, creationTime: "" }, { ...complete, creationTime: "yesterday" }, withoutExecutable, { ...complete, pid: "900" }, null]) {
      await expect(opsAnswering(ok(envelope([entry]))).inspect(900)).rejects.toThrow(/incomplete process identity/);
    }
  });

  it("makes the query fail loudly and wraps its result in an explicit success envelope", () => {
    const script = identityScript("ProcessId = 900");
    expect(script.startsWith("$ErrorActionPreference = 'Stop'; ")).toBe(true);
    expect(script).toContain("ConvertTo-Json -InputObject @{ ok = $true; processes = $found }");
    expect(parseInspection(ok(envelope([])))).toEqual([]);
  });

  it("fails the listener lookup on a nonzero exit or a malformed PID, and reports no listener only on empty success", async () => {
    await expect(opsAnswering({ code: 1, stdout: "", stderr: "boom" }).listener(51000)).rejects.toThrow(ProcessInspectionError);
    await expect(opsAnswering(ok("abc")).listener(51000)).rejects.toThrow(ProcessInspectionError);
    expect(await opsAnswering(ok("")).listener(51000)).toBeUndefined();
    expect(await opsAnswering(ok("4242\r\n")).listener(51000)).toBe(4242);
  });

  it("never treats an identity without a usable creation time as a reused PID", () => {
    const recorded = identity(900);
    expect(checkProcessIdentity(recorded, { ...recorded, creationTime: "" }).status).toBe("mismatch");
    expect(checkProcessIdentity(recorded, { ...recorded, creationTime: undefined as unknown as string }).status).toBe("mismatch");
    expect(checkProcessIdentity(recorded, { ...recorded, pid: 901 }).status).toBe("mismatch");
    expect(checkProcessIdentity(recorded, identity(900, { creationTime: "999" })).status).toBe("absent");
  });

  /** A recorded cluster whose process lookups go through the real Windows operations over a fake runner. */
  function clusterWithInspection(result: { code: number | null; stdout: string; stderr: string } | Error, evidence: PidFileEvidence) {
    const log = new IntentLog("state", new MemoryStore());
    const id = log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
    log.update(id, { state: "created", path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), postmaster: identity(900) });
    const present = new Set([CLUSTER_PARENT, CLUSTER_ROOT]);
    const calls: string[] = [];
    const seams: TeardownSeams = {
      ...recordedRun().seams,
      log,
      processes: opsAnswering(result),
      clusters: {
        provePostmaster: () => evidence,
        shutdown: async () => (calls.push("shutdown"), { ok: true }),
        waitForExit: async () => (calls.push("wait"), true),
        removeRoot: async (path) => (calls.push("remove root"), present.delete(path)),
      },
      directoryExists: (path) => present.has(path),
      listDirectory: (path) => (present.has(path) ? [...present].filter((candidate) => dirname(candidate) === path).map((candidate) => basename(candidate)) : undefined),
      removeEmptyDirectory: (path) => (calls.push("remove parent"), present.delete(path)),
    };
    return { log, seams, calls, present };
  }

  it("preserves the cluster root and parent, reports unresolved cleanup and exits nonzero when inspection fails", async () => {
    const failures: ({ code: number | null; stdout: string; stderr: string } | Error)[] = [
      { code: 1, stdout: "", stderr: "Get-CimInstance : The RPC server is unavailable." },
      ok(""),
      ok("<html>"),
      ok(envelope([{ ...complete, creationTime: null }])),
      new Error("spawn powershell.exe ENOENT"),
    ];

    for (const failure of failures) {
      for (const evidence of [{ status: "missing" } as const, { status: "proven", pid: 900 } as const]) {
        const run = clusterWithInspection(failure, evidence);
        const report = await teardown(run.seams);

        expect(report.left).toHaveLength(1);
        expect(report.left[0]?.reason).toMatch(/^unresolved cluster; root and parent preserved: process inspection failed: /);
        expect(report.removed).toEqual([]);
        expect(report.absent).toEqual([]);
        expect(run.calls).toEqual([]);
        expect(run.present.has(CLUSTER_ROOT) && run.present.has(CLUSTER_PARENT)).toBe(true);
        expect(run.log.entries()[0]?.state).toBe("left");
        expect(cleanupExitCode(report)).toBe(1);
      }
    }
  });

  it("reports an uninspectable process as residue and fails S-C, so smoke exits nonzero", async () => {
    const run = clusterWithInspection({ code: 1, stdout: "", stderr: "CIM failure" }, { status: "missing" });
    const residue = await residueOf(run.log.entries(), {
      processes: run.seams.processes,
      git: new FakeGit([{ path: REPO, head: COMMIT, detached: false, prunable: false }]),
      repositoryRoot: REPO,
      repositoryGitDirectory: GIT_DIR,
      restrictedBaseline: {},
      statusBaseline: "?? CLAUDE.md\n",
      portIsFree: async () => true,
      directoryExists: run.seams.directoryExists as (path: string) => boolean,
      restrictedMetadata: () => ({}),
      realpath: identityPath,
    });
    expect(residue.some((line) => /^process 900 \(bi4-smoke-e2\) could not be inspected/.test(line))).toBe(true);

    const report = await teardown(run.seams);
    const cleanReport = { stopped: [], removed: [], absent: [], left: [], allowanceExhausted: false };
    const verdict = evaluateForcedPass({ status: "exercised", requests: 20, measured: FORCED_KILL_AFTER, residue, firstCleanup: report, secondCleanup: cleanReport });
    expect(verdict.status).toBe("failed");
    expect(verdict.reasons.some((reason) => reason.includes("process inspection failed"))).toBe(true);
    expect(cleanupExitCode({ left: [] })).toBe(0);
  });
});

describe("unavailable executable or command line never verifies a live process (revision 5)", () => {
  const CREATED = "133400000000900";
  /** An identity whose executable and command line CIM did not provide. */
  const unavailable = (pid: number, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
    pid, parentPid: 1, creationTime: CREATED, executable: null, commandLine: null, ...overrides,
  });

  /** The real Windows operations over a fake runner that records every command it is asked to run. */
  function fakeWindows(live: (pid: number) => ProcessIdentity | undefined) {
    const commands: string[] = [];
    const ops = windowsProcessOps(async (command, args) => {
      commands.push(command);
      if (command === "taskkill") return { code: 0, stdout: "", stderr: "" };
      const script = args[args.length - 1] as string;
      const pid = Number(/ProcessId = (\d+)/.exec(script)?.[1]);
      if (script.includes("Get-NetTCPConnection")) return { code: 0, stdout: "", stderr: "" };
      const found = live(pid);
      return { code: 0, stdout: JSON.stringify({ ok: true, processes: found === undefined ? [] : [found] }), stderr: "" };
    });
    return { ops, commands };
  }

  it("keeps null values representable in lookup results", async () => {
    const { ops } = fakeWindows((pid) => unavailable(pid));
    expect(await ops.inspect(900)).toEqual(unavailable(900));
  });

  it("returns mismatch, never verified, when either side's executable or command line is null or blank", () => {
    const full = identity(900, { creationTime: CREATED });
    expect(checkProcessIdentity(unavailable(900), unavailable(900)).status).toBe("mismatch");
    expect(checkProcessIdentity(unavailable(900, { executable: "", commandLine: "" }), unavailable(900, { executable: "", commandLine: "" })).status).toBe("mismatch");
    expect(checkProcessIdentity(unavailable(900, { executable: "  ", commandLine: "x" }), unavailable(900, { executable: "  ", commandLine: "x" })).status).toBe("mismatch");
    expect(checkProcessIdentity(full, { ...full, executable: null }).status).toBe("mismatch");
    expect(checkProcessIdentity({ ...full, commandLine: null }, full).status).toBe("mismatch");
    expect(checkProcessIdentity(full, full).status).toBe("verified");
  });

  it("still decides PID reuse from valid creation times when the other fields are unavailable", () => {
    expect(checkProcessIdentity(unavailable(900), unavailable(900, { creationTime: "133400000000999" })).status).toBe("absent");
    expect(checkProcessIdentity(unavailable(900), undefined).status).toBe("absent");
  });

  it("never stops a recorded process when both recorded and live executable and command line are unavailable", async () => {
    const run = recordedRun();
    const log = new IntentLog("state", new MemoryStore());
    const id = log.intend("process", "next dev", { port: 51000 });
    log.update(id, { state: "created", pid: 900, identity: unavailable(900) });
    const windows = fakeWindows((pid) => (pid === 900 ? unavailable(900) : undefined));

    const report = await teardown({ ...run.seams, log, processes: windows.ops });

    expect(windows.commands).not.toContain("taskkill");
    expect(report.stopped).toEqual([]);
    expect(report.absent).toEqual([]);
    expect(report.left[0]?.reason).toMatch(/executable path is unavailable/);
    expect(cleanupExitCode(report)).toBe(1);
  });

  it("requests no cluster shutdown and removes no directory when the recorded and live postmaster fields are unavailable", async () => {
    for (const evidence of [{ status: "proven", pid: 900 } as const, { status: "missing" } as const]) {
      const log = new IntentLog("state", new MemoryStore());
      const id = log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
      log.update(id, { state: "created", path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), postmaster: unavailable(900) });
      const present = new Set([CLUSTER_PARENT, CLUSTER_ROOT]);
      const calls: string[] = [];
      const windows = fakeWindows((pid) => (pid === 900 ? unavailable(900) : undefined));

      const report = await teardown({
        ...recordedRun().seams,
        log,
        processes: windows.ops,
        clusters: {
          provePostmaster: () => evidence,
          shutdown: async () => (calls.push("shutdown"), { ok: true }),
          waitForExit: async () => (calls.push("wait"), true),
          removeRoot: async (path) => (calls.push("remove root"), present.delete(path)),
        },
        directoryExists: (path) => present.has(path),
        listDirectory: (path) => (present.has(path) ? [...present].filter((candidate) => dirname(candidate) === path).map((candidate) => basename(candidate)) : undefined),
        removeEmptyDirectory: (path) => (calls.push("remove parent"), present.delete(path)),
      });

      expect(calls).toEqual([]);
      expect(windows.commands).not.toContain("taskkill");
      expect(present.has(CLUSTER_ROOT) && present.has(CLUSTER_PARENT)).toBe(true);
      expect(report.removed).toEqual([]);
      expect(report.left[0]?.reason).toMatch(/^unresolved cluster; root and parent preserved: /);
      expect(cleanupExitCode(report)).toBe(1);
    }
  });

  it("still removes the cluster when the unavailable-field postmaster's PID was reused (creation time differs)", async () => {
    const log = new IntentLog("state", new MemoryStore());
    const id = log.intend("cluster", CLUSTER_SLUG, { parent: CLUSTER_PARENT });
    log.update(id, { state: "created", path: CLUSTER_ROOT, clusterDirectory: join(CLUSTER_ROOT, "cluster"), postmaster: unavailable(900) });
    const present = new Set([CLUSTER_PARENT, CLUSTER_ROOT]);
    const calls: string[] = [];
    const windows = fakeWindows((pid) => (pid === 900 ? unavailable(900, { creationTime: "133400000000999" }) : undefined));

    const report = await teardown({
      ...recordedRun().seams,
      log,
      processes: windows.ops,
      clusters: {
        provePostmaster: () => ({ status: "missing" }),
        shutdown: async () => (calls.push("shutdown"), { ok: true }),
        waitForExit: async () => (calls.push("wait"), true),
        removeRoot: async (path) => (calls.push("remove root"), present.delete(path)),
      },
      directoryExists: (path) => present.has(path),
      listDirectory: (path) => (present.has(path) ? [...present].filter((candidate) => dirname(candidate) === path).map((candidate) => basename(candidate)) : undefined),
      removeEmptyDirectory: (path) => (calls.push("remove parent"), present.delete(path)),
    });

    expect(calls).toEqual(["remove root", "remove parent"]);
    expect(report.removed).toEqual([0]);
  });

  it("refuses the S-C kill when the harness's recorded and live fields are unavailable", async () => {
    const run = recordedRun();
    const windows = fakeWindows((pid) => (pid === 100 ? unavailable(100) : undefined));
    let cleanups = 0;
    const result = await forcedPass({
      boundary: "e1",
      processes: windows.ops,
      git: run.git,
      spawnHarness: async () => ({ pid: 100 }),
      waitForReady: async () => ({ pid: 100, measured: FORCED_KILL_AFTER }),
      waitGone: async () => true,
      loadLog: () => run.log,
      cleanup: async () => (cleanups += 1, teardown(run.seams)),
    });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/nothing was killed$/);
    expect(windows.commands).not.toContain("taskkill");
    expect(cleanups).toBe(0);
  });
});
