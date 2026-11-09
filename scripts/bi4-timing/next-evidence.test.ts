/**
 * The Next.js version guard for E2 (issue #246; approved amendment revision 4, §7.3 and
 * amendment §4), on fakes only. Nothing here starts a process, runs git or reads the real tree.
 *
 * The guard is evidence of the pinned version, the package manifest and that manifest's link to the
 * launched executable. It does not verify every installed file.
 */

import { describe, expect, it, vi } from "vitest";

import {
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
  lockfile: { gitBlobId: "b".repeat(40), commitBlobSha256: "l".repeat(64), worktreeCopySha256: "l".repeat(64), entries: [{ key: "node_modules/next", version: "16.3.3" }] },
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
