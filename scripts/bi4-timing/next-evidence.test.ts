/**
 * The Next.js version guard for E2 (issue #246; approved amendment revision 4, §7.3 and
 * amendment §4), on fakes only. Nothing here starts a process, runs git or reads the real tree.
 *
 * The guard is evidence of the pinned version, the package manifest and that manifest's link to the
 * launched executable. It does not verify every installed file.
 */

import { describe, expect, it, vi } from "vitest";

import {
  captureLockfile,
  checkCheckoutLockfile,
  collectLockfileEvidence,
  crlfToLf,
  explainNextVersionGuard,
  type GitRunner,
  type LockfileEvidence,
  commandLineMatchesLaunch,
  evaluateNextVersionGuard,
  parseWindowsCommandLine,
  liveIdentityOf,
  readInstalledNext,
  readLockfileEvidence,
  REVIEWED_NEXT_VERSION,
  type NextVersionEvidence,
} from "./next-evidence";
import { sha256Hex } from "./body-compare";

const COMMIT = "d3fed966f32c7f44be7de5e31eae297f4051f348";
const WORKTREE = String.raw`C:\t\cdp-bi4-http-a\worktree`;
const ENTRY = String.raw`${WORKTREE}\node_modules\next\dist\bin\next`;
const NODE = String.raw`C:\node\node.exe`;
const COMMAND = `${NODE} ${ENTRY} dev --hostname 127.0.0.1 --port 5000`;
const read = {
  packageJsonRealPath: String.raw`${WORKTREE}\node_modules\next\package.json`,
  entryRealPath: ENTRY,
  name: "next",
  version: "16.3.3",
  packageJsonSha256: "p".repeat(64),
};
const good = {
  runCommit: COMMIT,
  worktreePath: WORKTREE,
  worktreeHead: COMMIT,
  // Amendment r5 A5-1 fields: Git's filtered blob ID equals the commit's, and the raw copy matches exactly.
  lockfile: {
    gitBlobId: "b".repeat(40),
    commitBlobSha256: "l".repeat(64),
    worktreeCopySha256: "l".repeat(64),
    worktreeCopyCrlfToLfSha256: "c".repeat(64),
    worktreeFilteredBlobId: "b".repeat(40),
    gitSettings: { autocrlf: [{ origin: "file:C:/Program Files/Git/etc/gitconfig", value: "true" }], eol: [], safecrlf: [], attributes: [], lsFilesEol: "i/lf    w/crlf  attr/                 \tpackage-lock.json" },
    entries: [{ key: "node_modules/next", version: "16.3.3" }],
  },
  launch: { nodeExecutable: NODE, entryPath: ENTRY, port: 5000, pid: 7, creationTime: "1", commandLine: COMMAND },
  installedBeforeStart: read,
  installedAfterMeasured: { ...read, liveIdentity: { pid: 7, creationTime: "1", commandLine: COMMAND } },
};
const after = (change: object) => ({ installedAfterMeasured: { ...good.installedAfterMeasured, ...change } });

describe("version guard", () => {
  it("T-N1 passes only with everything tied together", () => {
    expect(evaluateNextVersionGuard(good, COMMIT)).toBe("ok");
    expect(REVIEWED_NEXT_VERSION).toBe("16.3.3");
  });

  it.each([
    ["no evidence", undefined],
    ["no lockfile entry", { ...good, lockfile: { ...good.lockfile, entries: [] } }],
    ["no pre-start read", { ...good, installedBeforeStart: undefined }],
    ["no post-measurement read", { ...good, installedAfterMeasured: undefined }],
    ["no launch record", { ...good, launch: undefined }],
    ["no worktree head", { ...good, worktreeHead: undefined }],
    ["no lockfile at all", { ...good, lockfile: undefined }],
    ["no run commit", { ...good, runCommit: undefined }],
  ])("T-N2 missing: %s", (_name, evidence) => {
    expect(evaluateNextVersionGuard(evidence as NextVersionEvidence | undefined, COMMIT)).toBe("missing");
  });

  it.each([
    ["evidence from another commit", { ...good, runCommit: "c1c152666dbb6c3d5f08aa629e9e5df18f49bf4e" }],
    ["worktree at another commit", { ...good, worktreeHead: "c1c152666dbb6c3d5f08aa629e9e5df18f49bf4e" }],
    ["worktree lockfile differs from the commit's", { ...good, lockfile: { ...good.lockfile, worktreeCopySha256: "x".repeat(64) } }],
    ["two lockfile entries", { ...good, lockfile: { ...good.lockfile, entries: [...good.lockfile.entries, { key: "node_modules/x/node_modules/next", version: "16.3.3" }] } }],
    ["a range, not a version", { ...good, lockfile: { ...good.lockfile, entries: [{ key: "node_modules/next", version: "^16.3.3" }] } }],
    ["installed differs from the lockfile", { ...good, installedBeforeStart: { ...read, version: "16.3.4" }, ...after({ version: "16.3.4" }) }],
    ["version changes during the run", { ...good, ...after({ version: "16.3.4" }) }],
    ["package manifest changes during the run", { ...good, ...after({ packageJsonSha256: "q".repeat(64) }) }],
  ])("T-N3 disagreement: %s", (_name, evidence) => {
    expect(evaluateNextVersionGuard(evidence, COMMIT)).toBe("disagreement");
  });

  it("T-N3 disagreement: the manifest names another commit than the evidence", () => {
    expect(evaluateNextVersionGuard(good, "c1c152666dbb6c3d5f08aa629e9e5df18f49bf4e")).toBe("disagreement");
  });

  it("T-N5 a consistent but unreviewed version withholds", () => {
    const v = "16.3.4";
    const evidence = { ...good, lockfile: { ...good.lockfile, entries: [{ key: "node_modules/next", version: v }] }, installedBeforeStart: { ...read, version: v }, ...after({ version: v }) };

    expect(evaluateNextVersionGuard(evidence, COMMIT)).toBe("unreviewed-version");
  });

  it.each([
    ["entry outside the worktree", { ...good, launch: { ...good.launch, entryPath: String.raw`C:\repo\node_modules\next\dist\bin\next` } }],
    ["entry real path escapes the package", { ...good, installedBeforeStart: { ...read, entryRealPath: String.raw`C:\repo\node_modules\next\dist\bin\next` } }],
    ["package real path escapes the worktree", { ...good, ...after({ packageJsonRealPath: String.raw`C:\repo\node_modules\next\package.json`, entryRealPath: String.raw`C:\repo\node_modules\next\dist\bin\next` }) }],
    ["not the dev command", { ...good, launch: { ...good.launch, commandLine: `${NODE} ${ENTRY} start --hostname 127.0.0.1 --port 5000` } }],
    ["not loopback", { ...good, launch: { ...good.launch, commandLine: `${NODE} ${ENTRY} dev --hostname 0.0.0.0 --port 5000` } }],
    ["other package name", { ...good, installedBeforeStart: { ...read, name: "not-next" } }],
    ["a different process after measuring", { ...good, ...after({ liveIdentity: { pid: 7, creationTime: "2", commandLine: COMMAND } }) }],
    ["process gone after measuring", { ...good, ...after({ liveIdentity: undefined }) }],
  ])("T-N6 launch mismatch: %s", (_name, evidence) => {
    expect(evaluateNextVersionGuard(evidence, COMMIT)).toBe("launch-mismatch");
  });

  it("T-N7 the historical smoke's shape, no installed-version evidence, is missing", () => {
    expect(evaluateNextVersionGuard(undefined, COMMIT)).toBe("missing");
  });

  it("T-N8 readers record absence, not a throw, when the package cannot be read", () => {
    const ops = { readFile: () => { throw new Error("ENOENT"); }, realpath: (p: string) => p };

    expect(readInstalledNext(WORKTREE, ops)).toBeUndefined();
    expect(readInstalledNext(WORKTREE, { readFile: () => Buffer.from("not json"), realpath: (p: string) => p })).toBeUndefined();
    expect(readInstalledNext(WORKTREE, { readFile: () => Buffer.from("{}"), realpath: (p: string) => p })).toBeUndefined();
  });

  it("T-N8 the package reader hashes the exact manifest bytes and records real paths", () => {
    const bytes = Buffer.from('{"name":"next","version":"16.3.3"}');
    const paths: string[] = [];
    const result = readInstalledNext(WORKTREE, { readFile: () => bytes, realpath: (p) => (paths.push(p), p) });

    expect(result).toEqual({ ...read, packageJsonSha256: sha256Hex(bytes) });
    expect(paths).toEqual([read.packageJsonRealPath, ENTRY]);
  });

  it("T-N9 the lockfile reader uses the commit's object and lists every next entry", () => {
    const git = { show: vi.fn(() => JSON.stringify({ packages: { "node_modules/next": { version: "16.3.3" }, "node_modules/x/node_modules/next": { version: "1.0.0" } } })), blobId: () => "b".repeat(40) };
    const result = readLockfileEvidence(COMMIT, git, () => "{}");

    expect(git.show).toHaveBeenCalledWith(`${COMMIT}:package-lock.json`);
    expect(result?.entries).toHaveLength(2);
    expect(result?.commitBlobSha256).not.toBe(result?.worktreeCopySha256);
  });

  it("T-N9 a lockfile reader failure records absence", () => {
    const failing = { show: () => { throw new Error("bad object"); }, blobId: () => "b".repeat(40) };

    expect(readLockfileEvidence(COMMIT, failing, () => "{}")).toBeUndefined();
  });

  it("T-N10 a live identity without a command line cannot verify the launch", () => {
    expect(liveIdentityOf({ pid: 7, creationTime: "1", commandLine: null })).toBeUndefined();
    expect(liveIdentityOf(undefined)).toBeUndefined();
    expect(liveIdentityOf({ pid: 7, creationTime: "1", commandLine: COMMAND })).toEqual({ pid: 7, creationTime: "1", commandLine: COMMAND });
  });

  it("T-N11 the resolved entry changing to another file in the same package withholds, though manifest hash and version match", () => {
    const moved = { ...good, ...after({ entryRealPath: String.raw`${WORKTREE}\node_modules\next\dist\bin\other.js` }) };

    expect(moved.installedAfterMeasured.packageJsonSha256).toBe(good.installedBeforeStart.packageJsonSha256);
    expect(moved.installedAfterMeasured.version).toBe(good.installedBeforeStart.version);
    expect(evaluateNextVersionGuard(moved, COMMIT)).toBe("launch-mismatch");
  });

  it("T-N12 the resolved package manifest changing between reads withholds", () => {
    const relocated = String.raw`${WORKTREE}\node_modules\next\dist\package.json`;
    const evidence = { ...good, ...after({ packageJsonRealPath: relocated, entryRealPath: String.raw`${WORKTREE}\node_modules\next\dist\bin\next` }) };

    expect(evaluateNextVersionGuard(evidence, COMMIT)).toBe("launch-mismatch");
  });

  it("T-N12 resolved paths that differ only in letter case or separators are the same path", () => {
    const sameButSpelledDifferently = { ...good, ...after({ entryRealPath: ENTRY.toUpperCase().replace("C:\\T\\", "c:/t/") }) };

    expect(evaluateNextVersionGuard(sameButSpelledDifferently, COMMIT)).toBe("ok");
  });
});

describe("the observed Windows command line (normal quoting accepted, anything else refused)", () => {
  const SPACED = String.raw`C:\Program Files\nodejs\node.exe`;
  const SPACED_TREE = String.raw`C:\Users\A User\AppData\Local\Temp\cdp-bi4-http-a\worktree`;
  const SPACED_ENTRY = String.raw`${SPACED_TREE}\node_modules\next\dist\bin\next`;
  const spacedLaunch = { nodeExecutable: SPACED, entryPath: SPACED_ENTRY, port: 5000 };
  const tail = "dev --hostname 127.0.0.1 --port 5000";
  /** Evidence whose launch, reads and live identity use the given paths and command line. */
  const evidenceWith = (node: string, tree: string, commandLine: string): NextVersionEvidence => {
    const entry = String.raw`${tree}\node_modules\next\dist\bin\next`;
    const r = { ...read, packageJsonRealPath: String.raw`${tree}\node_modules\next\package.json`, entryRealPath: entry };
    return {
      ...good,
      worktreePath: tree,
      launch: { ...good.launch, nodeExecutable: node, entryPath: entry, commandLine },
      installedBeforeStart: r,
      installedAfterMeasured: { ...r, liveIdentity: { pid: 7, creationTime: "1", commandLine } },
    };
  };

  it("T-C1 accepts the unquoted form the second smoke recorded", () => {
    expect(commandLineMatchesLaunch(COMMAND, good.launch)).toBe(true);
    expect(evaluateNextVersionGuard(good, COMMIT)).toBe("ok");
  });

  it("T-C2 accepts a quoted executable and a quoted entry, both with spaces", () => {
    const commandLine = `"${SPACED}" "${SPACED_ENTRY}" ${tail}`;

    expect(commandLineMatchesLaunch(commandLine, spacedLaunch)).toBe(true);
    expect(evaluateNextVersionGuard(evidenceWith(SPACED, SPACED_TREE, commandLine), COMMIT)).toBe("ok");
  });

  it("T-C2 accepts a quoted executable with an unquoted entry, and quotes around a path without spaces", () => {
    expect(commandLineMatchesLaunch(`"${SPACED}" ${ENTRY} ${tail}`, { ...spacedLaunch, entryPath: ENTRY })).toBe(true);
    expect(commandLineMatchesLaunch(`${NODE} "${SPACED_ENTRY}" ${tail}`, { ...spacedLaunch, nodeExecutable: NODE })).toBe(true);
    expect(commandLineMatchesLaunch(`"${NODE}" "${ENTRY}" ${tail}`, good.launch)).toBe(true);
    expect(evaluateNextVersionGuard(evidenceWith(SPACED, WORKTREE, `"${SPACED}" ${ENTRY} ${tail}`), COMMIT)).toBe("ok");
  });

  it.each([
    ["an unquoted executable path with a space (ambiguous)", `${SPACED} "${SPACED_ENTRY}" ${tail}`],
    ["an unquoted entry path with a space (ambiguous)", `"${SPACED}" ${SPACED_ENTRY} ${tail}`],
    ["an unbalanced quote", `"${SPACED} "${SPACED_ENTRY}" ${tail}`],
    ["an unterminated quote", `"${SPACED}" "${SPACED_ENTRY} ${tail}`],
    ["a quote inside an argument", `"${SPACED}" "${SPACED_ENTRY}"x ${tail}`],
    ["an escaped quote", `"${SPACED}\\"" "${SPACED_ENTRY}" ${tail}`],
    ["a quoted path ending in a backslash", `"${SPACED}\\" "${SPACED_ENTRY}" ${tail}`],
    ["an empty quoted argument", `"${SPACED}" "" "${SPACED_ENTRY}" ${tail}`],
    ["whitespace inside the quotes at an edge", `" ${SPACED}" "${SPACED_ENTRY}" ${tail}`],
    ["two spaces between arguments", `"${SPACED}"  "${SPACED_ENTRY}" ${tail}`],
    ["a tab between arguments", `"${SPACED}"\t"${SPACED_ENTRY}" ${tail}`],
    ["a trailing space", `"${SPACED}" "${SPACED_ENTRY}" ${tail} `],
    ["a leading space", ` "${SPACED}" "${SPACED_ENTRY}" ${tail}`],
    ["another executable", `"C:\\Program Files\\other\\node.exe" "${SPACED_ENTRY}" ${tail}`],
    ["another entry script", `"${SPACED}" "${SPACED_TREE}\\node_modules\\next\\dist\\bin\\other" ${tail}`],
    ["start, not dev", `"${SPACED}" "${SPACED_ENTRY}" start --hostname 127.0.0.1 --port 5000`],
    ["another hostname", `"${SPACED}" "${SPACED_ENTRY}" dev --hostname 0.0.0.0 --port 5000`],
    ["another port", `"${SPACED}" "${SPACED_ENTRY}" dev --hostname 127.0.0.1 --port 5001`],
    ["an extra argument", `"${SPACED}" "${SPACED_ENTRY}" ${tail} --turbo`],
    ["a missing argument", `"${SPACED}" "${SPACED_ENTRY}" dev --hostname 127.0.0.1 --port`],
    ["reordered arguments", `"${SPACED}" "${SPACED_ENTRY}" dev --port 5000 --hostname 127.0.0.1`],
    ["a quoted fixed argument", `"${SPACED}" "${SPACED_ENTRY}" "dev" --hostname 127.0.0.1 --port 5000`],
    ["the =-joined form", `"${SPACED}" "${SPACED_ENTRY}" dev --hostname=127.0.0.1 --port 5000`],
  ])("T-C3 refuses %s", (_name, commandLine) => {
    expect(commandLineMatchesLaunch(commandLine, spacedLaunch)).toBe(false);
    expect(evaluateNextVersionGuard(evidenceWith(SPACED, SPACED_TREE, commandLine), COMMIT)).toBe("launch-mismatch");
  });

  it("T-C4 refuses a recorded path that itself holds a quote, which no quoting can express", () => {
    expect(commandLineMatchesLaunch(`"C:\\a" ${ENTRY} ${tail}`, { ...good.launch, nodeExecutable: 'C:\\a"' })).toBe(false);
  });

  it("T-C5 parses quoted arguments with spaces as single arguments", () => {
    expect(parseWindowsCommandLine(`"${SPACED}" x "a b"`)).toEqual([
      { text: SPACED, quoted: true },
      { text: "x", quoted: false },
      { text: "a b", quoted: true },
    ]);
    expect(parseWindowsCommandLine("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Amendment revision 5 A5-1: one captured lockfile read feeds Git's filtered blob ID and the byte
// check. All Git is a fake runner; nothing runs git or reads the real tree.
// ---------------------------------------------------------------------------------------------

const REPO = String.raw`C:\repo`;
const BLOB_ID = "0a49409109d2809920889829a71561950f4b7aab";
const OTHER_ID = "59592c9025a4d6e84ede37cb87bd01f857a386f3";
const COMMIT_BYTES = Buffer.from('{\n  "packages": {\n    "node_modules/next": { "version": "16.3.3" }\n  }\n}\n', "latin1");
const crlf = (bytes: Buffer): Buffer => Buffer.from(bytes.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
const edited = (bytes: Buffer): Buffer => Buffer.from(bytes.toString("latin1").replace("16.3.3", "16.3.4"), "latin1");

/** How the fake `hash-object --stdin` answers: like `core.autocrlf=true`, always the commit's ID (a hiding clean filter), or never. */
type FilterModel = "autocrlf" | "hides-edits" | "never";

function fakeGit(model: FilterModel, overrides: { readonly fail?: readonly string[] } = {}) {
  const calls: { args: readonly string[]; input?: Buffer }[] = [];
  const ok = (text: string | Buffer) => ({ code: 0, stdout: Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8") });
  const runner: GitRunner = (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    const command = args[2] as string;
    if (overrides.fail?.includes(command) || overrides.fail?.includes(args.join(" "))) return { code: 128, stdout: Buffer.alloc(0) };
    if (command === "show") return ok(COMMIT_BYTES);
    if (command === "rev-parse") return ok(`${BLOB_ID}\n`);
    if (command === "hash-object") {
      const matches = model === "hides-edits" || (model === "autocrlf" && crlfToLf(input as Buffer).equals(COMMIT_BYTES));
      return ok(`${matches ? BLOB_ID : OTHER_ID}\n`);
    }
    if (command === "config") return args[5] === "core.autocrlf" ? ok("file:C:/Program Files/Git/etc/gitconfig\ttrue\n") : { code: 1, stdout: Buffer.alloc(0) };
    if (command === "check-attr") return ok("");
    if (command === "ls-files") return ok("i/lf    w/crlf  attr/                 \tpackage-lock.json\n");
    return { code: 2, stdout: Buffer.alloc(0) };
  };
  return { runner, calls };
}

function collected(checkoutBytes: Buffer, model: FilterModel, overrides: { readonly fail?: readonly string[] } = {}) {
  const git = fakeGit(model, overrides);
  const reads: string[] = [];
  const lockfile = collectLockfileEvidence({
    commit: COMMIT,
    repositoryRoot: REPO,
    checkout: WORKTREE,
    readFile: (path) => (reads.push(path), checkoutBytes),
    git: git.runner,
  });
  return { lockfile, git, reads };
}

const withLockfile = (lockfile: LockfileEvidence | undefined): NextVersionEvidence => ({ ...good, ...(lockfile === undefined ? { lockfile: undefined } : { lockfile }) });

describe("worktree lockfile rule (amendment r5 A5-1)", () => {
  it("T-L1 an exact match passes, with byte match exact", () => {
    const { lockfile } = collected(COMMIT_BYTES, "autocrlf");
    const result = explainNextVersionGuard(withLockfile(lockfile), COMMIT);

    expect(result.outcome).toBe("ok");
    expect(result.lockfileByteMatch).toBe("exact");
    expect(lockfile?.worktreeFilteredBlobId).toBe(BLOB_ID);
  });

  it("T-L2 a CRLF-only copy passes, with byte match crlf-only", () => {
    const { lockfile } = collected(crlf(COMMIT_BYTES), "autocrlf");
    const result = explainNextVersionGuard(withLockfile(lockfile), COMMIT);

    expect(lockfile?.worktreeCopySha256).not.toBe(lockfile?.commitBlobSha256);
    expect(result.outcome).toBe("ok");
    expect(result.lockfileByteMatch).toBe("crlf-only");
  });

  it("T-L3 a substantive edit with unequal blob IDs withholds on Git's view", () => {
    const result = explainNextVersionGuard(withLockfile(collected(crlf(edited(COMMIT_BYTES)), "autocrlf").lockfile), COMMIT);

    expect(result.outcome).toBe("disagreement");
    expect(result.check).toBe("lockfile-git-blob");
  });

  it("T-L4 a substantive edit with the blob IDs forced equal withholds on the bytes", () => {
    const bytes = crlf(edited(COMMIT_BYTES));
    const forced = { ...(good.lockfile as LockfileEvidence), worktreeFilteredBlobId: good.lockfile.gitBlobId, worktreeCopySha256: sha256Hex(bytes), worktreeCopyCrlfToLfSha256: sha256Hex(crlfToLf(bytes)) };

    expect(explainNextVersionGuard(withLockfile(forced), COMMIT)).toMatchObject({ outcome: "disagreement", check: "lockfile-bytes" });
  });

  it("T-L5 a clean filter that hides an edit cannot pass: the byte check refuses it", () => {
    const { lockfile } = collected(crlf(edited(COMMIT_BYTES)), "hides-edits");
    const result = explainNextVersionGuard(withLockfile(lockfile), COMMIT);

    expect(lockfile?.worktreeFilteredBlobId).toBe(lockfile?.gitBlobId);
    expect(result).toMatchObject({ outcome: "disagreement", check: "lockfile-bytes" });
    expect(result.reason).toContain("lockfile-bytes");
  });

  it("T-L6 a standalone CR is not removed and withholds", () => {
    const loneCr = Buffer.from(COMMIT_BYTES.toString("latin1").replace('"packages"', '"pack\rages"'), "latin1");

    expect(crlfToLf(Buffer.from("a\rb\r\nc", "latin1")).toString("latin1")).toBe("a\rb\nc");
    expect(explainNextVersionGuard(withLockfile(collected(crlf(loneCr), "hides-edits").lockfile), COMMIT)).toMatchObject({ outcome: "disagreement", check: "lockfile-bytes" });
  });

  it("T-L7 an LF changed to CR withholds: CR LF → LF is never applied to the commit side", () => {
    const text = crlf(COMMIT_BYTES).toString("latin1");
    const lfToCr = Buffer.from(text.replace("\r\n", "\r"), "latin1");

    expect(explainNextVersionGuard(withLockfile(collected(lfToCr, "hides-edits").lockfile), COMMIT)).toMatchObject({ outcome: "disagreement", check: "lockfile-bytes" });
  });

  it("T-L8 exact bytes with a different filtered blob ID withhold on Git's view", () => {
    expect(explainNextVersionGuard(withLockfile(collected(COMMIT_BYTES, "never").lockfile), COMMIT)).toMatchObject({ outcome: "disagreement", check: "lockfile-git-blob" });
  });

  it.each(["gitBlobId", "commitBlobSha256", "worktreeFilteredBlobId", "worktreeCopySha256", "worktreeCopyCrlfToLfSha256", "gitSettings"] as const)(
    "T-L9 an absent %s is missing, and names the field",
    (field) => {
      const lockfile = { ...(good.lockfile as LockfileEvidence) } as Record<string, unknown>;
      delete lockfile[field];

      expect(explainNextVersionGuard(withLockfile(lockfile as unknown as LockfileEvidence), COMMIT)).toMatchObject({ outcome: "missing", check: `field-absent:lockfile.${field}` });
    },
  );

  it("T-L9 malformed settings are missing too", () => {
    const lockfile = { ...(good.lockfile as LockfileEvidence), gitSettings: { autocrlf: "true" } } as unknown as LockfileEvidence;

    expect(explainNextVersionGuard(withLockfile(lockfile), COMMIT).check).toBe("field-absent:lockfile.gitSettings");
  });

  it("T-L10 one read: hash-object receives exactly the buffer that was hashed, with the exact Git arguments", () => {
    const bytes = crlf(COMMIT_BYTES);
    const { lockfile, git, reads } = collected(bytes, "autocrlf");
    const hashObject = git.calls.find((call) => call.args[2] === "hash-object");

    expect(reads).toEqual([String.raw`${WORKTREE}\package-lock.json`]);
    expect(hashObject?.args).toEqual(["-C", WORKTREE, "hash-object", "--stdin", "--path=package-lock.json"]);
    expect(hashObject?.input?.equals(bytes)).toBe(true);
    expect(sha256Hex(hashObject?.input as Buffer)).toBe(lockfile?.worktreeCopySha256);
    expect(git.calls.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ["-C", REPO, "show", `${COMMIT}:package-lock.json`],
        ["-C", REPO, "rev-parse", `${COMMIT}:package-lock.json`],
        ["-C", WORKTREE, "config", "--show-origin", "--get-all", "core.autocrlf"],
        ["-C", WORKTREE, "config", "--show-origin", "--get-all", "core.eol"],
        ["-C", WORKTREE, "config", "--show-origin", "--get-all", "core.safecrlf"],
        ["-C", WORKTREE, "check-attr", "-a", "--", "package-lock.json"],
        ["-C", WORKTREE, "ls-files", "--eol", "--", "package-lock.json"],
      ]),
    );
    expect(lockfile?.gitSettings).toEqual({
      autocrlf: [{ origin: "file:C:/Program Files/Git/etc/gitconfig", value: "true" }],
      eol: [],
      safecrlf: [],
      attributes: [],
      lsFilesEol: "i/lf    w/crlf  attr/                 \tpackage-lock.json",
    });
  });

  it("T-L11 a failing Git call leaves its field absent and never throws", () => {
    expect(collected(COMMIT_BYTES, "autocrlf", { fail: ["hash-object"] }).lockfile?.worktreeFilteredBlobId).toBeUndefined();
    expect(collected(COMMIT_BYTES, "autocrlf", { fail: ["check-attr"] }).lockfile?.gitSettings).toBeUndefined();
    expect(collected(COMMIT_BYTES, "autocrlf", { fail: ["show"] }).lockfile).toBeUndefined();
    expect(collectLockfileEvidence({ commit: COMMIT, repositoryRoot: REPO, checkout: WORKTREE, readFile: () => { throw new Error("EBUSY"); }, git: fakeGit("autocrlf").runner })).toBeUndefined();
    expect(captureLockfile(WORKTREE, COMMIT_BYTES, () => { throw new Error("spawn failed"); }).worktreeFilteredBlobId).toBeUndefined();
  });

  it("T-L12 the checkout check passes a CRLF checkout and names the failed check for an edited one", () => {
    const main = (bytes: Buffer, model: FilterModel) =>
      collectLockfileEvidence({ commit: COMMIT, repositoryRoot: REPO, checkout: REPO, readFile: () => bytes, git: fakeGit(model).runner });

    expect(checkCheckoutLockfile(main(crlf(COMMIT_BYTES), "autocrlf"))).toEqual({ ok: true, byteMatch: "crlf-only" });
    expect(checkCheckoutLockfile(main(crlf(edited(COMMIT_BYTES)), "autocrlf"))).toMatchObject({ ok: false, check: "lockfile-git-blob" });
    expect(checkCheckoutLockfile(main(crlf(edited(COMMIT_BYTES)), "hides-edits"))).toMatchObject({ ok: false, check: "lockfile-bytes" });
    expect(checkCheckoutLockfile(undefined)).toMatchObject({ ok: false, outcome: "missing" });
  });
});

describe("guard reasons (amendment r5 A5-2)", () => {
  const variants: readonly [string, NextVersionEvidence | undefined, string, string][] = [
    ["good", good, "ok", "none"],
    ["no evidence", undefined, "missing", "evidence-absent"],
    ["no run commit", { ...good, runCommit: undefined }, "missing", "field-absent:runCommit"],
    ["no worktree path", { ...good, worktreePath: undefined }, "missing", "field-absent:worktreePath"],
    ["no worktree head", { ...good, worktreeHead: undefined }, "missing", "field-absent:worktreeHead"],
    ["no lockfile", { ...good, lockfile: undefined }, "missing", "field-absent:lockfile"],
    ["no lockfile entry", { ...good, lockfile: { ...good.lockfile, entries: [] } }, "missing", "field-absent:lockfile.entries"],
    ["no launch", { ...good, launch: undefined }, "missing", "field-absent:launch"],
    ["no pre-start read", { ...good, installedBeforeStart: undefined }, "missing", "field-absent:installedBeforeStart"],
    ["no post-measurement read", { ...good, installedAfterMeasured: undefined }, "missing", "field-absent:installedAfterMeasured"],
    ["another commit", { ...good, runCommit: "c1c152666dbb6c3d5f08aa629e9e5df18f49bf4e" }, "disagreement", "run-commit"],
    ["worktree elsewhere", { ...good, worktreeHead: "c1c152666dbb6c3d5f08aa629e9e5df18f49bf4e" }, "disagreement", "worktree-head"],
    ["two entries", { ...good, lockfile: { ...good.lockfile, entries: [...good.lockfile.entries, { key: "node_modules/x/node_modules/next", version: "16.3.3" }] } }, "disagreement", "lockfile-entries"],
    ["filtered blob differs", { ...good, lockfile: { ...good.lockfile, worktreeFilteredBlobId: "d".repeat(40) } }, "disagreement", "lockfile-git-blob"],
    ["bytes differ", { ...good, lockfile: { ...good.lockfile, worktreeCopySha256: "x".repeat(64) } }, "disagreement", "lockfile-bytes"],
    ["installed differs from lockfile", { ...good, installedBeforeStart: { ...read, version: "16.3.4" }, ...after({ version: "16.3.4" }) }, "disagreement", "lockfile-version"],
    ["version changes", { ...good, ...after({ version: "16.3.4" }) }, "disagreement", "installed-version-changed"],
    ["manifest changes", { ...good, ...after({ packageJsonSha256: "q".repeat(64) }) }, "disagreement", "manifest-hash-changed"],
    ["entry elsewhere", { ...good, launch: { ...good.launch, entryPath: String.raw`C:\repo\node_modules\next\dist\bin\next` } }, "launch-mismatch", "entry-path"],
    ["not dev", { ...good, launch: { ...good.launch, commandLine: `${NODE} ${ENTRY} start --hostname 127.0.0.1 --port 5000` } }, "launch-mismatch", "command-line"],
    ["escapes package", { ...good, installedBeforeStart: { ...read, entryRealPath: String.raw`C:\repo\node_modules\next\dist\bin\next` } }, "launch-mismatch", "paths-contained"],
    ["entry moves", { ...good, ...after({ entryRealPath: String.raw`${WORKTREE}\node_modules\next\dist\bin\other.js` }) }, "launch-mismatch", "paths-stable"],
    ["other name", { ...good, installedBeforeStart: { ...read, name: "not-next" } }, "launch-mismatch", "package-name"],
    ["other process", { ...good, ...after({ liveIdentity: { pid: 7, creationTime: "2", commandLine: COMMAND } }) }, "launch-mismatch", "live-identity"],
    ["process gone", { ...good, ...after({ liveIdentity: undefined }) }, "launch-mismatch", "live-identity"],
    [
      "unreviewed",
      { ...good, lockfile: { ...good.lockfile, entries: [{ key: "node_modules/next", version: "16.3.4" }] }, installedBeforeStart: { ...read, version: "16.3.4" }, ...after({ version: "16.3.4" }) },
      "unreviewed-version",
      "unreviewed-version",
    ],
  ];

  it.each(variants)("T-G1 %s: the explanation's outcome is the guard's outcome", (_name, evidence, outcome) => {
    expect(explainNextVersionGuard(evidence, COMMIT).outcome).toBe(outcome);
    expect(evaluateNextVersionGuard(evidence, COMMIT)).toBe(outcome);
  });

  it.each(variants)("T-G2 %s: the failed check is named, in a concise reason", (_name, evidence, _outcome, check) => {
    const result = explainNextVersionGuard(evidence, COMMIT);

    expect(result.check).toBe(check);
    if (check !== "none") expect(result.reason.startsWith(`${check}: `)).toBe(true);
    expect(result.reason.length).toBeLessThan(160);
  });

  it("T-G3 several failures report the first in the fixed order", () => {
    const many = {
      ...good,
      runCommit: "c1c152666dbb6c3d5f08aa629e9e5df18f49bf4e",
      lockfile: { ...good.lockfile, worktreeCopySha256: "x".repeat(64) },
      ...after({ liveIdentity: undefined }),
    };
    const lockfileAndLaunch = { ...good, lockfile: { ...good.lockfile, worktreeCopySha256: "x".repeat(64) }, ...after({ liveIdentity: undefined }) };

    expect(explainNextVersionGuard(many, COMMIT).check).toBe("run-commit");
    expect(explainNextVersionGuard(lockfileAndLaunch, COMMIT).check).toBe("lockfile-bytes");
  });
});
