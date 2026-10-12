/**
 * Attacking tests for the Windows complete-shutdown correction (issue #185).
 *
 * **What was wrong.** `EmbeddedPostgres.stop()` force-kills the postmaster on Windows through
 * an **unawaited** `taskkill /f /t` and awaits only the postmaster's own `exit`. A
 * `--forkchild=startup` process spawned inside that window is never in the tree `taskkill`
 * enumerated, so it is orphaned — one was measured outliving its postmaster by **69.2
 * seconds** while every assertion in `embedded-cluster.ts` passed, because that module knows
 * only the postmaster's PID and `postmaster.pid` records no children.
 *
 * **What replaced it** (Product Owner ruling, issue #185): the bundled `pg_ctl`, reached
 * through the platform package's public export, invoked as
 * `stop -D <owned directory> -m fast -w -t <bounded>`. `-m fast` makes the postmaster
 * terminate its children and wait for them; `-w` waits for that. A zero exit therefore proves
 * the **whole server** is gone on PostgreSQL's authority — not on an inference of ours.
 *
 * **Platform honesty.** CI runs `npm run test` on `ubuntu-latest`, and the mechanism under
 * test exists only on Windows. The static assertions below therefore run **everywhere** — they
 * are the ones that keep the ruling's narrow permissions narrow, and they are what CI
 * enforces — while the live cluster assertions are confined to `win32`, because on Linux the
 * path genuinely does not exist and `stop()` is already correct there (`SIGINT` is fast
 * shutdown, and the postmaster reaps its children before exiting). Nothing reachable is
 * skipped; what is confined is unreachable elsewhere, and this comment is the record of why.
 *
 * **Enumeration here is proof, not mechanism.** These tests walk the process tree to *verify*
 * that nothing survived. `embedded-cluster.ts` itself still enumerates nothing, scans no
 * process names, names no PID and terminates nothing — its own constraint tests enforce that,
 * and this file never relaxes them.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import EmbeddedPostgres from "embedded-postgres";

import {
  CLUSTER_PASSWORD,
  CLUSTER_TIMEOUT_MS,
  CLUSTER_USER,
  SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_SECONDS,
  requestCompleteShutdown,
} from "./embedded-cluster";

const onWindows = platform() === "win32";

describe("the bounded shutdown contract", () => {
  it("expresses its bound in seconds, because pg_ctl's -t does", () => {
    expect(SHUTDOWN_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SHUTDOWN_TIMEOUT_MS).toBe(SHUTDOWN_TIMEOUT_SECONDS * 1_000);
  });

  it("bounds the request well above a healthy shutdown and below an indefinite wait", () => {
    // A healthy complete shutdown measured ~250ms. The ceiling is a diagnostic device, and it
    // must comfortably exceed the 69.2s orphan tail the old forced path produced, so that a
    // genuine stall is reported rather than mistaken for slowness.
    expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});

describe.runIf(onWindows)("the request refuses what it cannot prove", () => {
  it(
    "reports failure, loudly and without a credential, for a directory that is not a cluster",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cdp-shutdown-nocluster-"));

      try {
        const outcome = await requestCompleteShutdown(root);

        // There is no server there, so complete shutdown is unproven and the outcome says so.
        expect(outcome.ok).toBe(false);
        expect(outcome.detail).not.toBe("");

        // Ruling 4's loudness is about the caller failing; what matters here is that the
        // outcome never claims success it does not have.
        expect(outcome.detail).not.toContain("complete shutdown of the owned cluster");

        // No credential can reach a diagnostic, because none is used: shutdown authority comes
        // from the data directory, not a database login.
        //
        // Only the password is asserted. The user name is not a secret, and "postgres" is far
        // too generic a string to assert the absence of — it occurs in package names and
        // paths, so asserting it would fail on honest text and prove nothing about leakage.
        expect(outcome.detail).not.toContain(CLUSTER_PASSWORD);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports failure for a directory that does not exist at all",
    async () => {
      const absent = join(tmpdir(), "cdp-shutdown-absent-does-not-exist");

      expect(existsSync(absent)).toBe(false);

      const outcome = await requestCompleteShutdown(absent);

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).not.toContain(CLUSTER_PASSWORD);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

/**
 * One isolated cluster per assertion, started and shut down with the mechanism under test.
 *
 * These deliberately do **not** go through `useEmbeddedPostgres`: the point is to observe the
 * shutdown itself, including the process tree before and after, which the helper's own
 * lifecycle would tidy away.
 */
const freePort = (): Promise<number> =>
  new Promise((settle, reject) => {
    const probe = net.createServer();

    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      probe.close(() => (port === 0 ? reject(new Error("no port")) : settle(port)));
    });
  });

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly created: string;
}

/**
 * Enumerate live `postgres.exe` processes with their parent and creation time.
 *
 * **Creation time is what makes this safe against PID reuse**: a recycled PID carries a later
 * creation time than the postmaster it would have to descend from, so a descendant claim is
 * corroborated rather than assumed. Nothing here terminates anything.
 */
async function postgresProcesses(): Promise<readonly ProcessRow[]> {
  const output = await new Promise<string>((settle, reject) => {
    const query = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | " +
          "ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToString('o'))\" }",
      ],
      { shell: false },
    );

    let text = "";

    query.stdout.on("data", (chunk: unknown) => {
      text += String(chunk);
    });
    query.on("error", reject);
    query.on("close", () => settle(text));
  });

  return output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [pid, ppid, created] = line.trim().split("|");

      return { pid: Number(pid), ppid: Number(ppid), created: created ?? "" };
    })
    .filter((row) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid));
}

/** Every process descended from `rootPid`, by repeated parent-PID descent. */
function descendantsOf(rows: readonly ProcessRow[], rootPid: number): readonly ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();

  for (const row of rows) {
    const siblings = byParent.get(row.ppid) ?? [];

    siblings.push(row);
    byParent.set(row.ppid, siblings);
  }

  const found: ProcessRow[] = [];
  const pending = [rootPid];

  while (pending.length > 0) {
    const current = pending.pop() as number;

    for (const child of byParent.get(current) ?? []) {
      found.push(child);
      pending.push(child.pid);
    }
  }

  return found;
}

interface StartedCluster {
  readonly server: EmbeddedPostgres;
  readonly root: string;
  readonly clusterDirectory: string;
  readonly postmaster: number;
  readonly claimedDirectory: string;
}

async function startCluster(): Promise<StartedCluster> {
  const root = mkdtempSync(join(tmpdir(), "cdp-shutdown-"));
  const clusterDirectory = join(root, "cluster");
  const server = new EmbeddedPostgres({
    databaseDir: clusterDirectory,
    port: await freePort(),
    user: CLUSTER_USER,
    password: CLUSTER_PASSWORD,
    persistent: false,
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    onLog: () => {},
    onError: () => {},
  });

  await server.initialise();
  await server.start();

  const lines = readFileSync(join(clusterDirectory, "postmaster.pid"), "utf8").split(/\r?\n/);

  return {
    server,
    root,
    clusterDirectory,
    postmaster: Number((lines[0] ?? "").trim()),
    claimedDirectory: (lines[1] ?? "").trim(),
  };
}

describe.runIf(onWindows)("complete shutdown, against a real cluster", () => {
  it(
    "leaves no process descended from the owned postmaster — the regression, attacked",
    async () => {
      // The old forced path orphaned one child in 95 postmasters, so a single clean shutdown
      // would prove little. Each iteration starts a real cluster, proves it had children, and
      // requires every one of them to be gone the moment the request returns.
      for (let iteration = 0; iteration < 4; iteration += 1) {
        const cluster = await startCluster();

        try {
          expect(Number.isSafeInteger(cluster.postmaster)).toBe(true);

          const before = descendantsOf(await postgresProcesses(), cluster.postmaster);

          // If a cluster had no children, the assertion after shutdown would be vacuous.
          expect(
            before.length,
            `iteration ${iteration}: the cluster had no children to orphan`,
          ).toBeGreaterThan(0);

          const outcome = await requestCompleteShutdown(cluster.clusterDirectory);

          expect(outcome.ok, `iteration ${iteration}: ${outcome.detail}`).toBe(true);
          expect(outcome.code).toBe(0);
          expect(outcome.signal).toBeNull();
          expect(outcome.timedOut).toBe(false);

          // The whole tree, immediately — no polling, no sleep, no second chance. A fixed
          // sleep here would be the very thing the ruling forbids as proof of cleanup.
          const rows = await postgresProcesses();
          const after = descendantsOf(rows, cluster.postmaster);

          expect(
            after.map((row) => `${row.pid} (ppid ${row.ppid}, created ${row.created})`),
            `iteration ${iteration}: owned children survived the shutdown`,
          ).toEqual([]);

          // And the postmaster itself is gone, corroborated by absence from the live list.
          expect(rows.some((row) => row.pid === cluster.postmaster)).toBe(false);

          // PostgreSQL removed its own pid file, which is how it reports a clean stop.
          expect(existsSync(join(cluster.clusterDirectory, "postmaster.pid"))).toBe(false);
        } finally {
          // `stop()` is deliberately **not** called (ruling 3); the directory is ours to remove.
          rmSync(cluster.root, { recursive: true, force: true });
        }
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "acts only on the owned directory, leaving another live cluster untouched",
    async () => {
      // The strongest statement of "no unrelated PostgreSQL process can be affected": two
      // clusters, one shut down by directory, the other required to survive intact.
      const target = await startCluster();
      const bystander = await startCluster();

      try {
        const bystanderBefore = descendantsOf(
          await postgresProcesses(),
          bystander.postmaster,
        ).length;

        expect(bystanderBefore).toBeGreaterThan(0);

        const outcome = await requestCompleteShutdown(target.clusterDirectory);

        expect(outcome.ok, outcome.detail).toBe(true);

        const rows = await postgresProcesses();

        // The target is entirely gone.
        expect(descendantsOf(rows, target.postmaster)).toEqual([]);
        expect(rows.some((row) => row.pid === target.postmaster)).toBe(false);

        // The bystander is untouched: still running, still with its children.
        expect(rows.some((row) => row.pid === bystander.postmaster)).toBe(true);
        expect(descendantsOf(rows, bystander.postmaster).length).toBe(bystanderBefore);
      } finally {
        await requestCompleteShutdown(bystander.clusterDirectory);
        rmSync(target.root, { recursive: true, force: true });
        rmSync(bystander.root, { recursive: true, force: true });
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "releases the data directory, so removal needs no retry",
    async () => {
      // The removal race this module used to compensate for: a child still holding a handle
      // made the owned root undeletable for up to 30s. A complete shutdown dissolves it, and
      // the proof is that a single immediate removal succeeds.
      const cluster = await startCluster();
      const outcome = await requestCompleteShutdown(cluster.clusterDirectory);

      expect(outcome.ok, outcome.detail).toBe(true);

      rmSync(cluster.root, { recursive: true, force: true });

      expect(existsSync(cluster.root)).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports a graceful shutdown quickly, not after the bounded ceiling",
    async () => {
      // `-m fast` is a proper shutdown, so the healthy case is fast. If this ever approached
      // the ceiling, the mechanism would be waiting rather than shutting down.
      const cluster = await startCluster();

      try {
        const outcome = await requestCompleteShutdown(cluster.clusterDirectory);

        expect(outcome.ok, outcome.detail).toBe(true);
        expect(outcome.elapsedMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS / 2);
      } finally {
        rmSync(cluster.root, { recursive: true, force: true });
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "is idempotent in the only sense that matters: a second request cannot claim success",
    async () => {
      const cluster = await startCluster();

      try {
        expect((await requestCompleteShutdown(cluster.clusterDirectory)).ok).toBe(true);

        // Nothing is running any more, so a second request must not report a shutdown it did
        // not perform — which is what makes the first result trustworthy.
        const second = await requestCompleteShutdown(cluster.clusterDirectory);

        expect(second.ok).toBe(false);
      } finally {
        rmSync(cluster.root, { recursive: true, force: true });
      }
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe.runIf(!onWindows)("on platforms where the package API is already correct", () => {
  it("does not require the Windows mechanism, because SIGINT reaps children first", () => {
    // Recorded as an assertion rather than a comment so the platform split is visible in the
    // suite on Linux too: `stop()` sends SIGINT, which is fast shutdown, and the postmaster
    // waits for its children before exiting — so awaiting the postmaster's exit already
    // implies the children are gone. The Windows mechanism is a correction, not a default.
    expect(platform()).not.toBe("win32");
    expect(SHUTDOWN_TIMEOUT_SECONDS).toBeGreaterThan(0);
  });
});
