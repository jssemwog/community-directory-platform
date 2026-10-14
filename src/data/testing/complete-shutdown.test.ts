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
import { afterAll, describe, expect, it } from "vitest";
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
  EXIT_POLL_INTERVAL_MS,
  EXIT_WAIT_CEILING_MS,
  SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_SECONDS,
  requestCompleteShutdown,
  waitForOwnedExit,
  type LifecycleSeams,
  type Presence,
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

/**
 * Every root this file creates, so that **no path can leak one**.
 *
 * The per-test `finally` blocks below remove their own root on the normal paths. This registry
 * is the backstop for the two paths they cannot cover: a cluster that fails to start, and a
 * test that aborts before reaching its cleanup. Both were observed in practice - when an
 * unrelated stale directory made a sibling test fail, the aborted runs left roots behind - and
 * a test file that leaks disposable clusters is the exact defect this unit exists to remove, so
 * it must not be one itself. Removal is idempotent, so an already-cleaned root costs nothing.
 */
const createdRoots: string[] = [];

afterAll(() => {
  for (const root of createdRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A root that cannot be removed is surfaced by the suite's own residue checks rather than
      // by throwing here, which would mask the failure that actually matters.
    }
  }
});

async function startCluster(): Promise<StartedCluster> {
  const root = mkdtempSync(join(tmpdir(), "cdp-shutdown-"));

  createdRoots.push(root);

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

  try {
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
  } catch (error) {
    // A half-built cluster is torn down here rather than left to the registry, so what gets
    // reported is the start failure itself and not a later removal complaint.
    try {
      await requestCompleteShutdown(clusterDirectory);
    } catch {
      // Best effort: there may be nothing to stop, which is not what this path reports.
    }

    rmSync(root, { recursive: true, force: true });

    throw error;
  }
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
    "completes because PostgreSQL finished, not because the ceiling fired (issue #190)",
    async () => {
      // The claim worth asserting is **why** the request settled, not how many milliseconds
      // the host took to do it.
      //
      // This replaces `elapsedMs < SHUTDOWN_TIMEOUT_MS / 2`, which measured wall-clock
      // duration and failed intermittently — roughly one run in five locally — whenever the
      // machine was busy, at ~11s against a 15s bound, while the mechanism had behaved
      // correctly. A healthy `-m fast` shutdown that takes 12s on a loaded machine violates
      // none of the guarantees this module exists to make, so failing it taught readers to
      // re-run rather than investigate. Raising the constant would only have made the flake
      // rarer and the test weaker at its stated job.
      //
      // The mechanism has exactly two ways to settle, and they are distinguishable without a
      // clock: `pg_ctl … -w` exits (`close`), or the outer ceiling fires (`timedOut`). The
      // original "quickly" assertion was a proxy for the first. `timedOut` states it exactly.
      //
      // The clock is injected and virtual, so nothing here depends on host speed. Because the
      // seam is the *only* clock the mechanism can read, counting its reads also proves the
      // request did not poll: a healthy settle reads it twice — once at entry, once when the
      // outcome is built — and `elapsedMs` is therefore one virtual tick, not a wall-clock
      // measurement. A polling implementation, or one that waited toward the ceiling, would
      // read it many more times and report a far larger elapsed figure.
      const cluster = await startCluster();

      let ticks = 0;
      const readings: number[] = [];
      const virtualNow = (): number => {
        const reading = ticks;
        readings.push(reading);
        ticks += 1;
        return reading;
      };

      try {
        const outcome = await requestCompleteShutdown(cluster.clusterDirectory, {
          now: virtualNow,
        });

        // It succeeded, and PostgreSQL is the reason.
        expect(outcome.ok, outcome.detail).toBe(true);
        expect(outcome.code).toBe(0);
        expect(outcome.signal).toBeNull();
        expect(outcome.detail).toBe(
          "PostgreSQL reported a complete shutdown of the owned cluster",
        );

        // It did not reach the ceiling. This is the real content of the old assertion.
        expect(outcome.timedOut).toBe(false);

        // It did not wait: the only clock available was read exactly twice, so no polling or
        // bounded wait occurred, and virtual time never advanced toward the ceiling.
        expect(readings).toEqual([0, 1]);
        expect(outcome.elapsedMs).toBe(1);
        expect(outcome.elapsedMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);

        // The real cleanup guarantees, unchanged and still asserted here: no owned PostgreSQL
        // process survives, and the released directory is removable with no retry.
        expect(descendantsOf(await postgresProcesses(), cluster.postmaster)).toEqual([]);
        rmSync(cluster.root, { recursive: true, force: true });
        expect(existsSync(cluster.root)).toBe(false);
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

/**
 * The bounded wait, proved deterministically (issue #190).
 *
 * `requestCompleteShutdown` settles one of two ways — `pg_ctl … -w` exits, or its outer
 * ceiling fires — and the case above proves a healthy shutdown took the first. The
 * *waiting* this module does lives in `waitForOwnedExit`, whose ceiling, poll interval and
 * clock are all injected, so the four faults the old wall-clock assertion was guarding
 * against can be driven exactly rather than approximated by a stopwatch.
 *
 * These use a **virtual clock**: `sleep` advances time instead of consuming it, so each
 * case is instant, deterministic, and identical on a fast machine and a loaded one. There
 * are no fixed sleeps, no real-time thresholds, no skips and no retries — those are the
 * mechanisms this issue exists to remove, not to relocate.
 *
 * `requestCompleteShutdown`'s own ceiling is a real `setTimeout` that the seams do not
 * reach, so a hang of *that* function cannot be simulated without changing production
 * code — which this unit is not authorized to do. Its loudness on failure is proved
 * instead by the existing cases above, each of which asserts `ok: false` with a detail and
 * no credential.
 */
const UNBOUNDED_WAIT_SENTINEL = "unbounded wait detected";

/**
 * The legitimate maximum number of waits a bounded poll loop can perform: one per poll
 * interval until the ceiling. Derived from the module's own constants, never hard-coded,
 * so it cannot drift away from the mechanism it bounds.
 */
const LEGITIMATE_WAITS = Math.ceil(EXIT_WAIT_CEILING_MS / EXIT_POLL_INTERVAL_MS);

/** A small allowance above the legitimate maximum, so an honest loop is never tripped. */
const WAIT_ALLOWANCE = 8;

/**
 * A virtual clock whose `sleep` is instrumented and **self-limiting**.
 *
 * `sleep` advances virtual time normally and counts iterations, and throws a stable
 * test-only sentinel once the count passes a small allowance above `LEGITIMATE_WAITS`.
 *
 * That limit is what makes the "bound removed entirely" mutation **detectable**. Without
 * it, a loop that had lost its ceiling would spin on resolved promises forever: virtual
 * time never reaches a ceiling that no longer exists, no real time passes, so vitest's own
 * timeout cannot fire and the run hangs rather than failing. Counting the iterations turns
 * that hang into an immediate, explicit failure — and the sentinel is thrown from the test
 * seam, so **no production code and no new production seam is involved**, and no
 * wall-clock timing or fixed sleeping is introduced.
 */
function virtualWaitSeams(
  observe: () => Presence,
  options: { readonly cap?: number } = {},
): LifecycleSeams & {
  readonly polls: () => number;
  readonly waits: () => number;
  readonly cap: number;
  readonly elapsed: () => number;
} {
  const cap = options.cap ?? LEGITIMATE_WAITS + WAIT_ALLOWANCE;
  let current = 0;
  let polls = 0;
  let waits = 0;

  return {
    now: () => current,
    sleep: async (ms: number) => {
      waits += 1;

      if (waits > cap) {
        throw new Error(
          `${UNBOUNDED_WAIT_SENTINEL}: ${waits} waits exceeded the ${cap} admissible for a ` +
            `${EXIT_WAIT_CEILING_MS}ms ceiling polled every ${EXIT_POLL_INTERVAL_MS}ms`,
        );
      }

      current += ms;
    },
    observe: () => {
      polls += 1;
      return observe();
    },
    polls: () => polls,
    waits: () => waits,
    cap,
    elapsed: () => current,
  };
}

describe("the bounded wait cannot hang, spin or exhaust silently (issue #190)", () => {
  it("fault 1 — a process that never exits reaches the ceiling and fails", async () => {
    // The hang. The observer never reports exit, so the wait must end at the ceiling and
    // report failure. If the bound were removed this case would never return.
    const seams = virtualWaitSeams(() => "present");

    const result = await waitForOwnedExit(999_999, seams);

    expect(result.exited).toBe(false);
    expect(result.last).toBe("present");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(EXIT_WAIT_CEILING_MS);
  });

  it("fault 2 — the wait is bounded, and an unbounded one is detected, not survived", async () => {
    // Boundedness stated as an exact count rather than a duration: with a fixed poll
    // interval, a ceiling admits a known maximum number of waits.
    //
    // The seam's `sleep` enforces that count, so a loop which had lost its ceiling fails
    // here **immediately and explicitly** instead of spinning on resolved promises until
    // someone kills the process. An honest loop never comes near the cap, so this must
    // resolve rather than reject.
    const seams = virtualWaitSeams(() => "present");

    const result = await waitForOwnedExit(999_999, seams);

    expect(result.exited).toBe(false);
    expect(seams.polls()).toBeGreaterThan(1);
    expect(seams.waits()).toBeLessThanOrEqual(LEGITIMATE_WAITS);
    expect(seams.waits()).toBeLessThan(seams.cap);
    // Virtual time advanced to the ceiling and stopped there, rather than running on.
    expect(seams.elapsed()).toBeGreaterThanOrEqual(EXIT_WAIT_CEILING_MS);
    expect(seams.elapsed()).toBeLessThan(EXIT_WAIT_CEILING_MS + EXIT_POLL_INTERVAL_MS * 2);
  });

  it("fault 2b — the unbounded-wait detector is live, not decorative", async () => {
    // A guard nothing can trip is no guard at all. Driving the same bounded loop against a
    // deliberately tiny cap proves the sentinel really fires, and names the reason — which
    // is exactly what the bound-removal mutation now produces, in milliseconds and with no
    // hang, no vitest timeout and no process to terminate by hand.
    const seams = virtualWaitSeams(() => "present", { cap: 3 });

    await expect(waitForOwnedExit(999_999, seams)).rejects.toThrow(
      UNBOUNDED_WAIT_SENTINEL,
    );

    // It stopped at the cap rather than running on, and no real time was consumed.
    expect(seams.waits()).toBe(4);
    expect(seams.elapsed()).toBe(EXIT_POLL_INTERVAL_MS * 3);
  });

  it("fault 3 — a healthy exit does not spin toward the ceiling", async () => {
    // The replacement for "it was quick", stated as behaviour: an already-exited process is
    // observed once, slept on never, and costs no virtual time at all. An implementation
    // that polled to the ceiling before noticing would fail here instead of passing
    // vacuously — which a wall-clock threshold on a fast machine would not catch.
    const seams = virtualWaitSeams(() => "exited");

    const result = await waitForOwnedExit(999_999, seams);

    expect(result.exited).toBe(true);
    expect(seams.polls()).toBe(1);
    expect(seams.elapsed()).toBe(0);
    expect(result.elapsedMs).toBe(0);
  });

  it("fault 3b — it stops at the moment of exit, not at the ceiling", async () => {
    // The same guarantee once waiting genuinely happens: three observations, two sleeps, and
    // it stops. Not one poll more, and nowhere near the ceiling.
    let calls = 0;
    const seams = virtualWaitSeams(() => (calls++ < 2 ? "present" : "exited"));

    const result = await waitForOwnedExit(999_999, seams);

    expect(result.exited).toBe(true);
    expect(seams.polls()).toBe(3);
    expect(seams.elapsed()).toBe(EXIT_POLL_INTERVAL_MS * 2);
    expect(result.elapsedMs).toBeLessThan(EXIT_WAIT_CEILING_MS);
  });

  it("fault 4 — an exhausted wait can never report success", async () => {
    // Loud failure. Every way of exhausting the ceiling must leave `exited` false: a silent
    // success here is the defect the whole module exists to remove, and it is exactly what a
    // "quick enough" assertion could never have detected.
    for (const stuck of ["present", "indeterminate"] as const) {
      const seams = virtualWaitSeams(() => stuck);

      const result = await waitForOwnedExit(999_999, seams);

      expect(result.exited, `a stuck '${stuck}' observation claimed success`).toBe(false);
      expect(result.last).toBe(stuck);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(EXIT_WAIT_CEILING_MS);
    }
  });
});
