/**
 * Next.js version evidence for E2 (issue #246; approved amendment revision 4 to harness gate
 * revision 5, §7.3 and amendment §4).
 *
 * The guard is **evidence of the pinned version, the package manifest and that manifest's link to
 * the launched executable. It does not verify every installed file.** An `ok` outcome must never
 * be described as verifying the installed package's contents.
 *
 * It ties together:
 *
 * - the lockfile read from the **run commit's object** (`git show <commit>:package-lock.json`),
 *   with the worktree's copy read before `npm ci` and required to be byte-identical;
 * - the worktree's `node_modules/next/package.json`, read before `next dev` starts and again after
 *   measuring: the same name, version and manifest bytes (SHA-256) at both reads, and the same
 *   canonical resolved paths for the manifest and the entry script at both reads, each inside the
 *   package and the worktree;
 * - the launched process: its entry script, its observed Windows command line parsed into the
 *   exact expected argument sequence (Node executable, entry script, `dev`, `--hostname`,
 *   `127.0.0.1`, `--port`, the port), and the live identity after measuring.
 *
 * **What it does not cover:** the entry script's bytes and every other installed file are not
 * hashed. A change to a file's content at an unchanged resolved path, other than the package
 * manifest, is not detected. The resolved paths are compared as paths, not as file identities.
 *
 * Missing or mismatched evidence, or any version other than `REVIEWED_NEXT_VERSION`, withholds
 * interpretation pending review. The readers never throw: a collection failure leaves its field
 * absent, and the guard then withholds. Nothing here starts a process or reaches a network; file,
 * git and process access are injected.
 */

import { win32 } from "node:path";

import { sha256Hex, type NextGuardOutcome } from "./body-compare";

export type { NextGuardOutcome };

/** The version the §11.2A grammar was reviewed against. Changing it needs a new review. */
export const REVIEWED_NEXT_VERSION = "16.3.3";

export interface LockfileEntry {
  readonly key: string;
  readonly version: string;
}

export interface LockfileEvidence {
  /** `git rev-parse <commit>:package-lock.json`. */
  readonly gitBlobId: string;
  /** SHA-256 of the blob from the run commit's object. */
  readonly commitBlobSha256: string;
  /** SHA-256 of the worktree's `package-lock.json`, read before `npm ci`. */
  readonly worktreeCopySha256: string;
  /** Every `node_modules/next` and `*\/node_modules/next` entry in the commit's blob. */
  readonly entries: readonly LockfileEntry[];
}

export interface InstalledNextRead {
  readonly packageJsonRealPath: string;
  readonly entryRealPath: string;
  readonly name: string;
  readonly version: string;
  readonly packageJsonSha256: string;
}

export interface LiveIdentity {
  readonly pid: number;
  readonly creationTime: string;
  readonly commandLine: string;
}

export interface LaunchRecord {
  readonly nodeExecutable: string;
  readonly entryPath: string;
  readonly port: number;
  readonly pid: number;
  readonly creationTime: string;
  readonly commandLine: string;
}

/** Recorded in the run manifest as `nextEvidence`. Every field may be absent; absence withholds. */
export interface NextVersionEvidence {
  readonly runCommit?: string;
  /** The worktree's real path. */
  readonly worktreePath?: string;
  /** `git rev-parse HEAD` in the worktree. */
  readonly worktreeHead?: string;
  readonly lockfile?: LockfileEvidence;
  readonly launch?: LaunchRecord;
  readonly installedBeforeStart?: InstalledNextRead;
  readonly installedAfterMeasured?: InstalledNextRead & { readonly liveIdentity?: LiveIdentity };
}

const COMMIT = /^[0-9a-f]{40}$/;
const isString = (value: unknown): value is string => typeof value === "string" && value !== "";

function readComplete(read: InstalledNextRead | undefined): read is InstalledNextRead {
  return (
    read !== undefined &&
    isString(read.packageJsonRealPath) &&
    isString(read.entryRealPath) &&
    typeof read.name === "string" &&
    typeof read.version === "string" &&
    isString(read.packageJsonSha256)
  );
}

function launchComplete(launch: LaunchRecord | undefined): launch is LaunchRecord {
  return (
    launch !== undefined &&
    isString(launch.nodeExecutable) &&
    isString(launch.entryPath) &&
    Number.isSafeInteger(launch.port) &&
    Number.isSafeInteger(launch.pid) &&
    isString(launch.creationTime) &&
    isString(launch.commandLine)
  );
}

/** Lower-cased `path.win32.resolve`, as `cli.ts` compares worktree paths. */
const canonicalPath = (path: string): string => win32.resolve(path).toLowerCase();

/** Whether `inner` is `outer` itself or lies inside it. */
function inside(inner: string, outer: string): boolean {
  const a = canonicalPath(inner);
  const b = canonicalPath(outer);
  return a === b || a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
}

/**
 * Split an observed Windows command line into arguments, under the quoting Node and libuv produce
 * for `spawn`: arguments separated by exactly one space; each argument either unquoted (no space,
 * tab, quote or control character) or wholly enclosed in one pair of double quotes, with no quote,
 * control character or trailing backslash inside and no leading or trailing whitespace. Anything
 * else — unbalanced or embedded quotes, escaped quotes, empty arguments, repeated or edge
 * whitespace — is refused as malformed or ambiguous, and `undefined` is returned.
 */
export function parseWindowsCommandLine(line: string): readonly { readonly text: string; readonly quoted: boolean }[] | undefined {
  if (line === "" || line.startsWith(" ") || line.endsWith(" ")) return undefined;

  const parts: { text: string; quoted: boolean }[] = [];
  let at = 0;

  while (at < line.length) {
    if (line[at] === '"') {
      const close = line.indexOf('"', at + 1);
      if (close < 0) return undefined;
      const inner = line.slice(at + 1, close);
      if (inner === "" || inner !== inner.trim() || inner.endsWith("\\") || /[\x00-\x1f\x7f\t]/.test(inner)) return undefined;
      parts.push({ text: inner, quoted: true });
      at = close + 1;
    } else {
      const space = line.indexOf(" ", at);
      const end = space < 0 ? line.length : space;
      const text = line.slice(at, end);
      if (text === "" || /["\t\x00-\x1f\x7f]/.test(text)) return undefined;
      parts.push({ text, quoted: false });
      at = end;
    }

    if (at < line.length) {
      // Exactly one space between arguments, and never at the end.
      if (line[at] !== " " || line[at + 1] === " " || at + 1 === line.length) return undefined;
      at += 1;
    }
  }

  return parts;
}

/**
 * Whether an observed command line is exactly the expected `next dev` launch. The Node executable
 * and the entry script may be quoted, as Windows quoting requires for a path with spaces, and must
 * then equal the recorded paths exactly; an unquoted path with a space cannot match, because it
 * would split into extra arguments. The remaining five arguments must be unquoted and exact.
 */
export function commandLineMatchesLaunch(commandLine: string, launch: Pick<LaunchRecord, "nodeExecutable" | "entryPath" | "port">): boolean {
  const parts = parseWindowsCommandLine(commandLine);
  const fixed = ["dev", "--hostname", "127.0.0.1", "--port", String(launch.port)];

  if (parts === undefined || parts.length !== 2 + fixed.length) return false;
  if (launch.nodeExecutable.includes('"') || launch.entryPath.includes('"')) return false;

  const [executable, entry, ...rest] = parts as [{ text: string; quoted: boolean }, { text: string; quoted: boolean }, ...{ text: string; quoted: boolean }[]];

  return (
    executable.text === launch.nodeExecutable &&
    entry.text === launch.entryPath &&
    rest.every((part, index) => !part.quoted && part.text === fixed[index])
  );
}

/**
 * The guard (amendment §4.2–4.4). Outcomes are decided in order: `missing`, `disagreement`,
 * `launch-mismatch`, `unreviewed-version`, then `ok`. Any outcome but `ok` withholds.
 */
export function evaluateNextVersionGuard(evidence: NextVersionEvidence | undefined, manifestCommit: string): NextGuardOutcome {
  if (evidence === undefined) return "missing";

  const { runCommit, worktreePath, worktreeHead, lockfile, launch, installedBeforeStart: before, installedAfterMeasured: after } = evidence;

  if (
    !isString(runCommit) ||
    !isString(worktreePath) ||
    !isString(worktreeHead) ||
    lockfile === undefined ||
    !isString(lockfile.gitBlobId) ||
    !isString(lockfile.commitBlobSha256) ||
    !isString(lockfile.worktreeCopySha256) ||
    !Array.isArray(lockfile.entries) ||
    lockfile.entries.length === 0 ||
    !launchComplete(launch) ||
    !readComplete(before) ||
    !readComplete(after)
  ) {
    return "missing";
  }

  const entry = lockfile.entries[0] as LockfileEntry;

  if (
    !COMMIT.test(runCommit) ||
    runCommit !== worktreeHead ||
    runCommit !== manifestCommit ||
    lockfile.commitBlobSha256 !== lockfile.worktreeCopySha256 ||
    lockfile.entries.length !== 1 ||
    entry.key !== "node_modules/next" ||
    entry.version !== before.version ||
    before.version !== after.version ||
    before.packageJsonSha256 !== after.packageJsonSha256
  ) {
    return "disagreement";
  }

  const expectedEntry = win32.join(worktreePath, "node_modules", "next", "dist", "bin", "next");
  const pathsInside = (read: InstalledNextRead): boolean => {
    const packageRoot = win32.dirname(read.packageJsonRealPath);
    return inside(read.entryRealPath, packageRoot) && inside(packageRoot, worktreePath);
  };
  const live = after.liveIdentity;

  if (
    canonicalPath(launch.entryPath) !== canonicalPath(expectedEntry) ||
    !commandLineMatchesLaunch(launch.commandLine, launch) ||
    !pathsInside(before) ||
    !pathsInside(after) ||
    // The same resolved manifest and entry script before start and after measuring.
    canonicalPath(before.packageJsonRealPath) !== canonicalPath(after.packageJsonRealPath) ||
    canonicalPath(before.entryRealPath) !== canonicalPath(after.entryRealPath) ||
    before.name !== "next" ||
    after.name !== "next" ||
    live === undefined ||
    live.pid !== launch.pid ||
    live.creationTime !== launch.creationTime ||
    live.commandLine !== launch.commandLine
  ) {
    return "launch-mismatch";
  }

  if (before.version !== REVIEWED_NEXT_VERSION) return "unreviewed-version";

  return "ok";
}

// ---------------------------------------------------------------------------------------------
// Readers. Each returns `undefined` instead of throwing; absence withholds.
// ---------------------------------------------------------------------------------------------

export interface FileReadOps {
  readonly readFile: (path: string) => Buffer | string;
  readonly realpath: (path: string) => string;
}

/** The worktree's installed `next` package manifest and entry script, read with real paths. */
export function readInstalledNext(worktreePath: string, ops: FileReadOps): InstalledNextRead | undefined {
  try {
    const packageJson = win32.join(worktreePath, "node_modules", "next", "package.json");
    const bytes = ops.readFile(packageJson);
    const parsed = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes) as { name?: unknown; version?: unknown };

    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") return undefined;

    return {
      packageJsonRealPath: ops.realpath(packageJson),
      entryRealPath: ops.realpath(win32.join(worktreePath, "node_modules", "next", "dist", "bin", "next")),
      name: parsed.name,
      version: parsed.version,
      packageJsonSha256: sha256Hex(bytes),
    };
  } catch {
    return undefined;
  }
}

export interface LockfileGitOps {
  /** `git show <spec>`: the blob's exact bytes. */
  readonly show: (spec: string) => Buffer | string;
  /** `git rev-parse <spec>`. */
  readonly blobId: (spec: string) => string;
}

/** The lockfile from the run commit's object, and the hash of the worktree's copy. */
export function readLockfileEvidence(
  commit: string,
  git: LockfileGitOps,
  readWorktreeLockfile: () => Buffer | string,
): LockfileEvidence | undefined {
  try {
    const spec = `${commit}:package-lock.json`;
    const blob = git.show(spec);
    const parsed = JSON.parse(Buffer.isBuffer(blob) ? blob.toString("utf8") : blob) as { packages?: Record<string, { version?: unknown }> };
    const packages = parsed.packages ?? {};
    const entries = Object.keys(packages)
      .filter((key) => key === "node_modules/next" || key.endsWith("/node_modules/next"))
      .map((key) => {
        const version = packages[key]?.version;
        return { key, version: typeof version === "string" ? version : "" };
      });

    return {
      gitBlobId: git.blobId(spec).trim(),
      commitBlobSha256: sha256Hex(blob),
      worktreeCopySha256: sha256Hex(readWorktreeLockfile()),
      entries,
    };
  } catch {
    return undefined;
  }
}

/** The live identity's comparable fields, or `undefined` when absent or unverifiable. */
export function liveIdentityOf(identity: { pid: number; creationTime: string; commandLine: string | null } | undefined): LiveIdentity | undefined {
  if (identity === undefined || !isString(identity.commandLine)) return undefined;
  return { pid: identity.pid, creationTime: identity.creationTime, commandLine: identity.commandLine };
}
