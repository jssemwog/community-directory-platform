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
 *   and the checkout's copy, read **once** before `npm ci`: Git's filtered blob ID of that buffer
 *   (`hash-object --stdin --path=package-lock.json`) must equal the commit's blob ID, and the same
 *   bytes must equal the commit's exactly or after CR LF → LF of the copy only (amendment r5 A5-1);
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

/** One `git config --show-origin --get-all` line: where a value comes from, and the value. */
export interface ConfigValue {
  readonly origin: string;
  readonly value: string;
}

/** The checkout's effective Git settings and attributes for `package-lock.json` (amendment r5 §2.3). Recorded, not interpreted. */
export interface GitSettingsRecord {
  readonly autocrlf: readonly ConfigValue[];
  readonly eol: readonly ConfigValue[];
  readonly safecrlf: readonly ConfigValue[];
  /** `git check-attr -a -- package-lock.json`, one line per attribute. */
  readonly attributes: readonly string[];
  /** `git ls-files --eol -- package-lock.json`. */
  readonly lsFilesEol: string;
}

export interface LockfileEvidence {
  /** `git rev-parse <commit>:package-lock.json`. */
  readonly gitBlobId: string;
  /** SHA-256 of the blob from the run commit's object. */
  readonly commitBlobSha256: string;
  /** SHA-256 of the checkout's `package-lock.json`, from the one captured read (before `npm ci` in a worktree). */
  readonly worktreeCopySha256: string;
  /** SHA-256 of the same buffer with every CR LF pair replaced by LF; a standalone CR is unchanged. */
  readonly worktreeCopyCrlfToLfSha256?: string;
  /** `git -C <checkout> hash-object --stdin --path=package-lock.json`, fed the same buffer. */
  readonly worktreeFilteredBlobId?: string;
  readonly gitSettings?: GitSettingsRecord;
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

/** The guard's verdict with the first failed check and a concise reason (amendment r5 A5-2). */
export interface GuardExplanation {
  readonly outcome: NextGuardOutcome;
  /** The first failed check, in the fixed order; `none` when the outcome is `ok`. */
  readonly check: string;
  readonly reason: string;
  /** Which byte match the lockfile passed with, once the lockfile checks have passed. */
  readonly lockfileByteMatch?: LockfileByteMatch;
}

export type LockfileByteMatch = "exact" | "crlf-only";

export type CheckoutLockfileResult =
  | { readonly ok: true; readonly byteMatch: LockfileByteMatch }
  | { readonly ok: false; readonly outcome: "missing" | "disagreement"; readonly check: string; readonly reason: string };

function settingsComplete(settings: GitSettingsRecord | undefined): settings is GitSettingsRecord {
  const values = (list: unknown): boolean =>
    Array.isArray(list) && list.every((entry) => typeof entry?.origin === "string" && typeof entry?.value === "string");
  return (
    settings !== undefined &&
    values(settings.autocrlf) &&
    values(settings.eol) &&
    values(settings.safecrlf) &&
    Array.isArray(settings.attributes) &&
    settings.attributes.every((line) => typeof line === "string") &&
    typeof settings.lsFilesEol === "string"
  );
}

/** The lockfile fields A5-1 needs, in the fixed order their absence is reported. */
const LOCKFILE_FIELDS = [
  "gitBlobId",
  "commitBlobSha256",
  "worktreeFilteredBlobId",
  "worktreeCopySha256",
  "worktreeCopyCrlfToLfSha256",
  "gitSettings",
] as const;

function absentLockfileField(lockfile: LockfileEvidence): string | undefined {
  for (const field of LOCKFILE_FIELDS) {
    const present = field === "gitSettings" ? settingsComplete(lockfile.gitSettings) : isString(lockfile[field]);
    if (!present) return `lockfile.${field}`;
  }
  return undefined;
}

/**
 * A5-1 checks 1 and 2 on one checkout's captured lockfile evidence: Git's filtered blob ID must
 * equal the commit's blob ID, and the captured bytes must equal the commit's bytes exactly or after
 * CR LF → LF of the captured copy only. Used by the guard, by the checkout preflight and by the
 * V-A stop before `npm ci`.
 */
export function checkCheckoutLockfile(lockfile: LockfileEvidence | undefined): CheckoutLockfileResult {
  if (lockfile === undefined) return { ok: false, outcome: "missing", check: "field-absent:lockfile", reason: "field-absent:lockfile: no lockfile evidence was recorded" };

  const absent = absentLockfileField(lockfile);
  if (absent !== undefined) return { ok: false, outcome: "missing", check: `field-absent:${absent}`, reason: `field-absent:${absent}: the evidence has no usable ${absent}` };

  if (lockfile.worktreeFilteredBlobId !== lockfile.gitBlobId) {
    return { ok: false, outcome: "disagreement", check: "lockfile-git-blob", reason: "lockfile-git-blob: Git's filtered blob ID of the captured copy differs from the commit's blob ID" };
  }

  if (lockfile.worktreeCopySha256 === lockfile.commitBlobSha256) return { ok: true, byteMatch: "exact" };
  if (lockfile.worktreeCopyCrlfToLfSha256 === lockfile.commitBlobSha256) return { ok: true, byteMatch: "crlf-only" };

  return { ok: false, outcome: "disagreement", check: "lockfile-bytes", reason: "lockfile-bytes: the captured copy matches the commit blob neither exactly nor after CR LF → LF" };
}

const fail = (outcome: NextGuardOutcome, check: string, detail: string): GuardExplanation => ({ outcome, check, reason: `${check}: ${detail}` });

/**
 * The guard (amendment r4 §4.2–4.4 as amended by r5) with its first failed check. Checks run in
 * the fixed A5-2 order; the outcome categories are unchanged and any outcome but `ok` withholds.
 */
export function explainNextVersionGuard(evidence: NextVersionEvidence | undefined, manifestCommit: string): GuardExplanation {
  if (evidence === undefined) return fail("missing", "evidence-absent", "no Next.js version evidence was recorded");

  const { runCommit, worktreePath, worktreeHead, lockfile, launch, installedBeforeStart: before, installedAfterMeasured: after } = evidence;
  const absent = (field: string): GuardExplanation => fail("missing", `field-absent:${field}`, `the evidence has no usable ${field}`);

  if (!isString(runCommit)) return absent("runCommit");
  if (!isString(worktreePath)) return absent("worktreePath");
  if (!isString(worktreeHead)) return absent("worktreeHead");
  if (lockfile === undefined) return absent("lockfile");
  const lockfileAbsent = absentLockfileField(lockfile);
  if (lockfileAbsent !== undefined) return absent(lockfileAbsent);
  if (!Array.isArray(lockfile.entries) || lockfile.entries.length === 0) return absent("lockfile.entries");
  if (!launchComplete(launch)) return absent("launch");
  if (!readComplete(before)) return absent("installedBeforeStart");
  if (!readComplete(after)) return absent("installedAfterMeasured");

  if (!COMMIT.test(runCommit) || runCommit !== manifestCommit) return fail("disagreement", "run-commit", "the evidence's run commit is not the manifest's authorized commit");
  if (worktreeHead !== runCommit) return fail("disagreement", "worktree-head", "the worktree's HEAD is not the run commit");

  const entry = lockfile.entries[0] as LockfileEntry;
  if (lockfile.entries.length !== 1 || entry.key !== "node_modules/next") {
    return fail("disagreement", "lockfile-entries", "the commit's lockfile does not have exactly one node_modules/next entry");
  }

  const lockfileCheck = checkCheckoutLockfile(lockfile);
  if (!lockfileCheck.ok) return { outcome: lockfileCheck.outcome, check: lockfileCheck.check, reason: lockfileCheck.reason };
  const byteMatch = lockfileCheck.byteMatch;
  const withMatch = (explanation: GuardExplanation): GuardExplanation => ({ ...explanation, lockfileByteMatch: byteMatch });

  if (entry.version !== before.version) return withMatch(fail("disagreement", "lockfile-version", "the installed version differs from the commit's lockfile"));
  if (before.version !== after.version) return withMatch(fail("disagreement", "installed-version-changed", "the installed version changed between the pre-start and post-measurement reads"));
  if (before.packageJsonSha256 !== after.packageJsonSha256) return withMatch(fail("disagreement", "manifest-hash-changed", "the package manifest's bytes changed between reads"));

  const expectedEntry = win32.join(worktreePath, "node_modules", "next", "dist", "bin", "next");
  const pathsInside = (read: InstalledNextRead): boolean => {
    const packageRoot = win32.dirname(read.packageJsonRealPath);
    return inside(read.entryRealPath, packageRoot) && inside(packageRoot, worktreePath);
  };
  const live = after.liveIdentity;

  if (canonicalPath(launch.entryPath) !== canonicalPath(expectedEntry)) return withMatch(fail("launch-mismatch", "entry-path", "the launched entry script is not the worktree's next binary"));
  if (!commandLineMatchesLaunch(launch.commandLine, launch)) return withMatch(fail("launch-mismatch", "command-line", "the observed command line is not exactly the expected next dev arguments"));
  if (!pathsInside(before) || !pathsInside(after)) return withMatch(fail("launch-mismatch", "paths-contained", "a resolved path lies outside the package or the worktree"));
  if (
    canonicalPath(before.packageJsonRealPath) !== canonicalPath(after.packageJsonRealPath) ||
    canonicalPath(before.entryRealPath) !== canonicalPath(after.entryRealPath)
  ) {
    return withMatch(fail("launch-mismatch", "paths-stable", "the resolved manifest or entry path changed between reads"));
  }
  if (before.name !== "next" || after.name !== "next") return withMatch(fail("launch-mismatch", "package-name", "the package manifest does not name next"));
  if (live === undefined || live.pid !== launch.pid || live.creationTime !== launch.creationTime || live.commandLine !== launch.commandLine) {
    return withMatch(fail("launch-mismatch", "live-identity", "the live process after measuring is not the launched process"));
  }

  if (before.version !== REVIEWED_NEXT_VERSION) {
    return withMatch(fail("unreviewed-version", "unreviewed-version", `version ${before.version} has not been reviewed; the reviewed version is ${REVIEWED_NEXT_VERSION}`));
  }

  return { outcome: "ok", check: "none", reason: "every guard check passed", lockfileByteMatch: byteMatch };
}

/** The guard's outcome alone. Any outcome but `ok` withholds. */
export function evaluateNextVersionGuard(evidence: NextVersionEvidence | undefined, manifestCommit: string): NextGuardOutcome {
  return explainNextVersionGuard(evidence, manifestCommit).outcome;
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

/** A Git invocation: arguments, optional standard input, and the exit code with standard output's bytes. */
export type GitRunner = (args: readonly string[], input?: Buffer) => { readonly code: number; readonly stdout: Buffer };

/** Replace every CR LF pair with LF. A standalone CR, and every other byte, is left unchanged. */
export function crlfToLf(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  let length = 0;

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[length] = bytes[i] as number;
    length += 1;
  }

  return out.subarray(0, length);
}

function configValues(git: GitRunner, checkout: string, key: string): ConfigValue[] | undefined {
  const { code, stdout } = git(["-C", checkout, "config", "--show-origin", "--get-all", key]);
  if (code === 1 && stdout.length === 0) return []; // unset at every scope
  if (code !== 0) return undefined;
  return stdout
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab < 0 ? { origin: "", value: line } : { origin: line.slice(0, tab), value: line.slice(tab + 1) };
    });
}

function gitSettingsOf(git: GitRunner, checkout: string): GitSettingsRecord | undefined {
  const autocrlf = configValues(git, checkout, "core.autocrlf");
  const eol = configValues(git, checkout, "core.eol");
  const safecrlf = configValues(git, checkout, "core.safecrlf");
  const attributes = git(["-C", checkout, "check-attr", "-a", "--", "package-lock.json"]);
  const lsFiles = git(["-C", checkout, "ls-files", "--eol", "--", "package-lock.json"]);

  if (autocrlf === undefined || eol === undefined || safecrlf === undefined || attributes.code !== 0 || lsFiles.code !== 0) return undefined;

  return {
    autocrlf,
    eol,
    safecrlf,
    attributes: attributes.stdout.toString("utf8").split(/\r?\n/).filter((line) => line !== ""),
    lsFilesEol: lsFiles.stdout.toString("utf8").trim(),
  };
}

/**
 * Capture one checkout's lockfile evidence from **one** buffer (amendment r5 §2.3): its raw hash,
 * its CR LF → LF hash, and Git's filtered blob ID of that same buffer, fed on standard input to
 * `git -C <checkout> hash-object --stdin --path=package-lock.json`. Also records the checkout's
 * settings and attributes. A failed Git call leaves its field absent; nothing throws.
 */
export function captureLockfile(
  checkout: string,
  buffer: Buffer,
  git: GitRunner,
): Pick<LockfileEvidence, "worktreeCopySha256" | "worktreeCopyCrlfToLfSha256" | "worktreeFilteredBlobId" | "gitSettings"> {
  const safe = <T>(read: () => T | undefined): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const filtered = safe(() => {
    const result = git(["-C", checkout, "hash-object", "--stdin", "--path=package-lock.json"], buffer);
    const id = result.stdout.toString("utf8").trim();
    return result.code === 0 && /^[0-9a-f]{40,64}$/.test(id) ? id : undefined;
  });
  const settings = safe(() => gitSettingsOf(git, checkout));

  return {
    worktreeCopySha256: sha256Hex(buffer),
    worktreeCopyCrlfToLfSha256: sha256Hex(crlfToLf(buffer)),
    ...(filtered === undefined ? {} : { worktreeFilteredBlobId: filtered }),
    ...(settings === undefined ? {} : { gitSettings: settings }),
  };
}

/**
 * The full lockfile evidence for one checkout: the commit side from the run commit's object, and
 * the checkout side captured from **one** read of `<checkout>\package-lock.json`. `undefined`
 * when the commit side or the read fails; absent fields otherwise.
 */
export function collectLockfileEvidence(input: {
  readonly commit: string;
  readonly repositoryRoot: string;
  readonly checkout: string;
  readonly readFile: (path: string) => Buffer;
  readonly git: GitRunner;
}): LockfileEvidence | undefined {
  let buffer: Buffer;
  try {
    buffer = input.readFile(win32.join(input.checkout, "package-lock.json"));
  } catch {
    return undefined;
  }

  const ok = (args: readonly string[]): Buffer => {
    const result = input.git(args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited ${result.code}`);
    return result.stdout;
  };
  const commitSide = readLockfileEvidence(
    input.commit,
    {
      show: (spec) => ok(["-C", input.repositoryRoot, "show", spec]),
      blobId: (spec) => ok(["-C", input.repositoryRoot, "rev-parse", spec]).toString("utf8"),
    },
    () => buffer,
  );

  return commitSide === undefined ? undefined : { ...commitSide, ...captureLockfile(input.checkout, buffer, input.git) };
}

/** The live identity's comparable fields, or `undefined` when absent or unverifiable. */
export function liveIdentityOf(identity: { pid: number; creationTime: string; commandLine: string | null } | undefined): LiveIdentity | undefined {
  if (identity === undefined || !isString(identity.commandLine)) return undefined;
  return { pid: identity.pid, creationTime: identity.creationTime, commandLine: identity.commandLine };
}
