/**
 * Attacks on the embedded-PostgreSQL lifecycle helper itself (issue #179).
 *
 * **These tests prove the helper, they do not merely use it.** A harness that is only exercised
 * by the suites that depend on it is a harness whose failure paths are untested — and the defect
 * this helper exists to fix lived entirely in a failure path: teardown reported a cluster
 * unremoved, or quietly left one behind, because nothing waited for the owned postmaster to
 * exit before the directory was removed.
 *
 * Two kinds of test appear below, deliberately.
 *
 * **Real clusters** prove the end-to-end lifecycle: that a cluster starts, that two of them are
 * isolated, and that after cleanup there is no owned process and no owned directory left. These
 * are slow and there are deliberately few of them.
 *
 * **Injected seams** prove the failure paths. The clock, the sleep, the process observation and
 * the filesystem removal are all substitutable, so a 30-second timeout is attacked in
 * milliseconds against a virtual clock, and an `EBUSY` retry is attacked without needing to
 * manufacture a real file lock — which on Windows would mean risking exactly the uncontrolled
 * process this helper exists to prevent. No test here crashes a real PostgreSQL server.
 *
 * The last describe is structural: it reads this module's own source and asserts that no
 * process-killing, process-enumerating or unscoped-removal mechanism appears in it. That is a
 * property worth pinning in a test rather than in a comment, because it is the single rule that
 * makes observing a PID safe.
 *
 * A structural test is only as good as its reading of the source, so two of its assertions exist
 * to keep it honest: one proves the comment stripper still exposes the declarations being
 * constrained, and one proves each prohibition actually matches the thing it prohibits. Without
 * those, a stripper that ate the file or a pattern that matched nothing would read as a
 * guarantee while asserting a tautology.
 */

import { describe, expect, it, onTestFinished } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLUSTER_PASSWORD,
  CLUSTER_TIMEOUT_MS,
  ClusterCleanupError,
  EXIT_WAIT_CEILING_MS,
  REMOVE_CEILING_MS,
  cleanupCluster,
  isTransientRemovalError,
  observePresence,
  proveOwnedPostmaster,
  removeOwnedRoot,
  startClusterForTests,
  waitForOwnedExit,
  withEmbeddedPostgres,
  type ClusterState,
  type LifecycleSeams,
  type Presence,
} from "./embedded-cluster";

interface PgModule {
  readonly Client: new (config: { connectionString: string }) => {
    connect(): Promise<void>;
    query(statement: string): Promise<{ rows: Readonly<Record<string, unknown>>[] }>;
    end(): Promise<void>;
  };
}

const { Client } = createRequire(import.meta.url)("pg") as PgModule;

/** A filesystem error shaped the way Node shapes one, so the code path under test is the real one. */
function fsError(code: string, path: string): Error & { code: string; path: string } {
  return Object.assign(new Error(`${code}: simulated, rmdir '${path}'`), { code, path });
}

/** A virtual clock: `sleep` advances time instead of spending it. */
function virtualClock(): LifecycleSeams & { elapsed: () => number } {
  let current = 0;

  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

/** A state object for a cluster that was never started — the shape cleanup has to tolerate. */
function fakeState(overrides: Partial<ClusterState> = {}): ClusterState {
  const root = join(tmpdir(), `cdp-fake-${Math.random().toString(36).slice(2)}`);

  return {
    root,
    clusterDirectory: join(root, "cluster"),
    port: 0,
    server: undefined,
    started: false,
    owned: undefined,
    resources: [],
    stopRequested: false,
    settled: false,
    ...overrides,
  };
}

describe("the real lifecycle, end to end", () => {
  it(
    "starts a usable cluster and leaves no owned process and no owned directory behind",
    async () => {
      let root = "";
      let pid = 0;

      await withEmbeddedPostgres({ slug: "helper-normal", databases: ["helper_check"] }, async (cluster) => {
        root = cluster.dataRoot;
        pid = proveOwnedPostmaster(cluster.clusterDirectory).pid;

        expect(existsSync(cluster.clusterDirectory)).toBe(true);
        expect(observePresence(pid)).toBe("present");

        const client = new Client({
          connectionString: cluster.connectionStringFor("helper_check"),
        });

        cluster.closeBeforeShutdown("probe client", () => client.end());
        await client.connect();

        const { rows } = await client.query("select 1 as one");

        expect(rows[0]?.one).toBe(1);
      });

      // The two guarantees, asserted rather than assumed.
      expect(observePresence(pid)).toBe("exited");
      expect(existsSync(root)).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "gives two concurrent instances distinct roots and distinct ports, and cleans up both",
    async () => {
      const observed: { root: string; port: number; pid: number }[] = [];

      await Promise.all(
        ["helper-parallel-a", "helper-parallel-b"].map((slug) =>
          withEmbeddedPostgres({ slug, databases: [] }, async (cluster) => {
            observed.push({
              root: cluster.dataRoot,
              port: cluster.port,
              pid: proveOwnedPostmaster(cluster.clusterDirectory).pid,
            });
          }),
        ),
      );

      expect(observed).toHaveLength(2);
      expect(observed[0]?.root).not.toBe(observed[1]?.root);
      expect(observed[0]?.port).not.toBe(observed[1]?.port);
      expect(observed[0]?.pid).not.toBe(observed[1]?.pid);

      for (const instance of observed) {
        expect(existsSync(instance.root)).toBe(false);
        expect(observePresence(instance.pid)).toBe("exited");
      }
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "cleans up after a setup failure, leaving nothing of the half-built cluster",
    async () => {
      const slug = "helper-setupfail";
      const residue = (): string[] =>
        readdirSync(tmpdir()).filter((entry) => entry.startsWith(`cdp-${slug}-`));

      expect(residue()).toEqual([]);

      // The cluster starts, and then the governed migration is pointed at a database that was
      // never created. That is a failure *after* a real postmaster exists — the case that
      // matters, because there is now something to clean up.
      await expect(
        withEmbeddedPostgres(
          { slug, databases: [], migrate: ["database_that_was_never_created"] },
          async () => undefined,
        ),
      ).rejects.toThrow();

      expect(residue()).toEqual([]);
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "reports the body failure first when cleanup also fails, and is safe to clean up twice",
    async () => {
      const bodyFailure = new Error("the assertion under test failed");
      let root = "";
      let refuse = true;

      const seams: LifecycleSeams = {
        // A non-transient filesystem error: it must fail immediately, not be retried to a
        // deadline, and it must not replace the body's failure.
        remove: (path) => {
          if (refuse) throw fsError("ENOTDIR", path);

          rmSync(path, { recursive: true, force: true });
        },
      };

      const { state, cluster } = await startClusterForTests({
        slug: "helper-dual",
        databases: [],
        seams,
      });

      root = cluster.dataRoot;

      // A safety net, not the thing under test: whatever any assertion below does, this test
      // does not leave residue. The assertions still prove the helper removed it first.
      onTestFinished(async () => {
        refuse = false;
        // Through the helper's own bounded retry, not a bare removal: Windows may still be
        // letting go of the directory, which is the very thing that retry exists for.
        await removeOwnedRoot(root);
      });

      let raised: unknown;

      try {
        try {
          throw bodyFailure;
        } finally {
          await cleanupCluster(state, { slug: "helper-dual", databases: [], seams });
        }
      } catch (error) {
        raised = error;
      }

      // Cleanup failed loudly, and it failed for the reason given rather than at a deadline:
      // the removal error itself, plus the verification that caught the surviving directory.
      expect(raised).toBeInstanceOf(AggregateError);

      const stages = (raised as AggregateError).errors.map(
        (error: ClusterCleanupError) => error.stage,
      );

      // `stop()` may or may not have thrown its own `EBUSY` on this run — that race is the
      // whole reason this module exists — so it is retained when present rather than asserted
      // into existence. What is not optional is the removal failure and the verification that
      // caught the surviving directory.
      expect(stages.filter((stage) => stage !== "stop-request")).toEqual([
        "directory-removal",
        "verify",
      ]);
      expect(String(raised)).not.toContain(CLUSTER_PASSWORD);

      // The owned process is nevertheless gone: shutdown and the exit wait both ran.
      expect(observePresence(state.owned?.pid ?? 0)).toBe("exited");
      expect(existsSync(root)).toBe(true);

      // Cleaning up a second time is safe, touches only the owned root, and completes it.
      refuse = false;
      await cleanupCluster(state, { slug: "helper-dual", databases: [], seams });

      expect(existsSync(root)).toBe(false);

      // And a third time, on an already-settled state, is still safe.
      await cleanupCluster(state, { slug: "helper-dual", databases: [], seams });
    },
    CLUSTER_TIMEOUT_MS,
  );

  it(
    "preserves both failures when the body throws and cleanup throws",
    async () => {
      const bodyFailure = new Error("the body failed first");
      let root = "";
      const seams: LifecycleSeams = {
        remove: (path) => {
          root = path;
          throw fsError("ENOTDIR", path);
        },
        // The verification stage is not what this test is about; one cleanup failure keeps the
        // assertion on the thing under test, which is how the two failures are reported.
        exists: () => false,
      };

      const raised = await withEmbeddedPostgres(
        { slug: "helper-aggregate", databases: [], seams },
        async () => {
          throw bodyFailure;
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      try {
        expect(raised).toBeInstanceOf(AggregateError);

        const errors = (raised as AggregateError).errors;

        // The original failure is first, and identifiable. A noisy teardown never replaces it.
        expect(errors[0]).toBe(bodyFailure);

        // The cleanup half is one `ClusterCleanupError`, or an aggregate of them when the
        // upstream `stop()` threw its own transient lock on this run as well — a race, so the
        // shape is flattened rather than asserted into one form.
        const cleanupHalf =
          errors[1] instanceof AggregateError
            ? (errors[1].errors as unknown[])
            : [errors[1] as unknown];

        expect(cleanupHalf.length).toBeGreaterThan(0);
        for (const error of cleanupHalf) {
          expect(error).toBeInstanceOf(ClusterCleanupError);
        }

        expect(
          cleanupHalf.map((error) => (error as ClusterCleanupError).stage),
        ).toContain("directory-removal");
        expect(String(raised)).not.toContain(CLUSTER_PASSWORD);
      } finally {
        // This test owns that root and the injected seam refused to remove it, so it does so
        // here — in `finally`, because a failing assertion above must not leave residue
        // either, and through the helper's bounded retry rather than a bare removal, because
        // Windows may still be releasing the cluster's handles.
        const outcome = await removeOwnedRoot(root);

        expect(outcome.removed).toBe(true);
      }

      expect(existsSync(root)).toBe(false);
    },
    CLUSTER_TIMEOUT_MS,
  );
});

describe("ownership proof", () => {
  const withPidFile = (contents: string): string => {
    const root = mkdtempSync(join(tmpdir(), "cdp-pidfile-"));

    writeFileSync(join(root, "postmaster.pid"), contents, "utf8");

    return root;
  };

  it("accepts a PID whose postmaster.pid claims the owned directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cdp-pidfile-"));

    try {
      // Shaped like the real thing: PID, claimed data directory, start time, port.
      writeFileSync(join(root, "postmaster.pid"), `4242\n${root}\n1791740961\n58242\n`, "utf8");

      const owned = proveOwnedPostmaster(root);

      expect(owned.pid).toBe(4242);
      expect(owned.claimedDirectory).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the forward-slash, differently-cased form PostgreSQL actually writes", () => {
    const root = withPidFile("1\n");

    try {
      const claimed =
        process.platform === "win32" ? root.replace(/\\/g, "/").toUpperCase() : root;

      writeFileSync(join(root, "postmaster.pid"), `4243\n${claimed}\n`, "utf8");

      expect(proveOwnedPostmaster(root).pid).toBe(4243);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing postmaster.pid", () => {
    const root = mkdtempSync(join(tmpdir(), "cdp-nopid-"));

    try {
      expect(() => proveOwnedPostmaster(root)).toThrow(/could not be read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["an empty file", ""],
    ["a non-numeric PID", "not-a-pid\n/some/dir\n"],
    ["a negative PID", "-5\n/some/dir\n"],
    ["a zero PID", "0\n/some/dir\n"],
    ["a fractional PID", "12.5\n/some/dir\n"],
  ])("refuses %s", (_label, contents) => {
    const root = withPidFile(contents);

    try {
      expect(() => proveOwnedPostmaster(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a PID whose claimed data directory is some other directory", () => {
    const root = withPidFile(`4244\n${join(tmpdir(), "a-directory-this-helper-never-made")}\n`);

    try {
      expect(() => proveOwnedPostmaster(root)).toThrow(/ownership is unproven/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a PID that claims no directory at all", () => {
    const root = withPidFile("4245\n\n");

    try {
      expect(() => proveOwnedPostmaster(root)).toThrow(/claims no data directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("process observation", () => {
  it("reports the current process as present, having sent it nothing", () => {
    expect(observePresence(process.pid)).toBe("present");
  });

  it("reports an impossible PID as exited", () => {
    // A PID this high is not in use; `ESRCH` is the only honest answer.
    expect(observePresence(2_147_483_646)).toBe("exited");
  });

  it("treats an indeterminate answer as 'not gone' and keeps waiting to the deadline", async () => {
    const clock = virtualClock();
    const seen: Presence[] = [];
    const result = await waitForOwnedExit(999_999, {
      ...clock,
      observe: () => {
        seen.push("indeterminate");
        return "indeterminate";
      },
    });

    expect(result.exited).toBe(false);
    expect(result.last).toBe("indeterminate");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(EXIT_WAIT_CEILING_MS);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("stops waiting the moment the owned process is gone", async () => {
    const clock = virtualClock();
    let calls = 0;
    const result = await waitForOwnedExit(999_999, {
      ...clock,
      observe: () => {
        calls += 1;
        return calls < 3 ? "present" : "exited";
      },
    });

    expect(result.exited).toBe(true);
    expect(calls).toBe(3);
    expect(result.elapsedMs).toBeLessThan(EXIT_WAIT_CEILING_MS);
  });

  it("raises an unexpected errno rather than guessing at it", async () => {
    await expect(
      waitForOwnedExit(999_999, {
        ...virtualClock(),
        observe: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      }),
    ).rejects.toThrow("EIO");
  });
});

describe("bounded directory removal", () => {
  it.each(["EBUSY", "EPERM", "ENOTEMPTY"])("retries a transient %s and then succeeds", async (code) => {
    const clock = virtualClock();
    let attempts = 0;
    const outcome = await removeOwnedRoot("/owned/root", {
      ...clock,
      remove: (path) => {
        attempts += 1;
        if (attempts < 4) throw fsError(code, path);
      },
      exists: () => false,
    });

    expect(outcome.removed).toBe(true);
    expect(outcome.attempts).toBe(4);
    expect(clock.elapsed()).toBeGreaterThan(0);
  });

  it("fails immediately on a non-transient error instead of retrying to a deadline", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const outcome = await removeOwnedRoot("/owned/root", {
      ...clock,
      remove: (path) => {
        attempts += 1;
        throw fsError("ENOTDIR", path);
      },
      exists: () => true,
    });

    expect(outcome.removed).toBe(false);
    expect(attempts).toBe(1);
    expect(clock.elapsed()).toBe(0);
    expect(isTransientRemovalError(outcome.lastError)).toBe(false);
  });

  it("gives up at the removal ceiling rather than retrying forever", async () => {
    const clock = virtualClock();
    const outcome = await removeOwnedRoot("/owned/root", {
      ...clock,
      remove: (path) => {
        throw fsError("EBUSY", path);
      },
      exists: () => true,
    });

    expect(outcome.removed).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(REMOVE_CEILING_MS);
    expect(isTransientRemovalError(outcome.lastError)).toBe(true);
  });

  it("rechecks absence, because a removal that reported success is not proof", async () => {
    const clock = virtualClock();
    let exists = true;
    let attempts = 0;
    const outcome = await removeOwnedRoot("/owned/root", {
      ...clock,
      remove: () => {
        attempts += 1;
        // Reports success while leaving the directory in place — twice.
        if (attempts >= 3) exists = false;
      },
      exists: () => exists,
    });

    expect(outcome.removed).toBe(true);
    expect(attempts).toBe(3);
  });
});

describe("cleanup failure behaviour, against injected seams", () => {
  const seamsFor = (overrides: LifecycleSeams): LifecycleSeams => ({
    ...virtualClock(),
    ...overrides,
  });

  it("fails loudly when the owned postmaster never exits", async () => {
    const state = fakeState({
      started: true,
      owned: { pid: 4242, claimedDirectory: "/owned/root/cluster" },
    });
    const seams = seamsFor({
      observe: () => "present",
      remove: () => {},
      exists: () => false,
    });

    const raised = await cleanupCluster(state, { slug: "x", databases: [], seams }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(raised).toBeInstanceOf(ClusterCleanupError);
    expect((raised as ClusterCleanupError).stage).toBe("exit-wait");
    expect((raised as ClusterCleanupError).ownedPid).toBe(4242);
    expect((raised as ClusterCleanupError).message).toContain("4242");
  });

  it("fails loudly when removal never succeeds", async () => {
    const state = fakeState({
      started: true,
      owned: { pid: 4242, claimedDirectory: "/owned/root/cluster" },
    });
    const seams = seamsFor({
      observe: () => "exited",
      remove: (path) => {
        throw fsError("EBUSY", path);
      },
      exists: () => true,
    });

    const raised = await cleanupCluster(state, { slug: "x", databases: [], seams }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(raised).toBeInstanceOf(AggregateError);
    expect(
      (raised as AggregateError).errors.map((error: ClusterCleanupError) => error.stage),
    ).toEqual(["directory-removal", "verify"]);
  });

  it("fails loudly when ownership cannot be proven, and observes nothing at all", async () => {
    let observed = 0;
    const state = fakeState({ started: true });
    const seams = seamsFor({
      observe: () => {
        observed += 1;
        return "exited";
      },
      remove: () => {},
      exists: () => false,
    });

    const raised = await cleanupCluster(state, { slug: "x", databases: [], seams }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(raised).toBeInstanceOf(ClusterCleanupError);
    expect((raised as ClusterCleanupError).stage).toBe("ownership-proof");

    // Unproven ownership authorizes nothing — not even looking at a process.
    expect(observed).toBe(0);
  });

  it("keeps a caller's resource-shutdown failure instead of swallowing it", async () => {
    const state = fakeState({
      resources: [
        {
          label: "the caller's pool",
          close: () => Promise.reject(new Error("pool.end failed")),
        },
      ],
    });
    const seams = seamsFor({ remove: () => {}, exists: () => false });

    const raised = await cleanupCluster(state, { slug: "x", databases: [], seams }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(raised).toBeInstanceOf(ClusterCleanupError);
    expect((raised as ClusterCleanupError).stage).toBe("resource-close");
    expect((raised as ClusterCleanupError).message).toContain("the caller's pool");
  });

  it("closes the caller's resources newest first, and attempts all of them", async () => {
    const closed: string[] = [];
    const state = fakeState({
      resources: [
        { label: "first", close: async () => void closed.push("first") },
        {
          label: "second",
          close: () => Promise.reject(new Error("second failed")),
        },
        { label: "third", close: async () => void closed.push("third") },
      ],
    });
    const seams = seamsFor({ remove: () => {}, exists: () => false });

    await cleanupCluster(state, { slug: "x", databases: [], seams }).catch(() => undefined);

    expect(closed).toEqual(["third", "first"]);
  });

  it("succeeds silently for a cluster that was never started", async () => {
    const state = fakeState();
    const seams = seamsFor({ remove: () => {}, exists: () => false });

    await expect(
      cleanupCluster(state, { slug: "x", databases: [], seams }),
    ).resolves.toBeUndefined();
  });

  it("never names a credential in a diagnostic", async () => {
    const state = fakeState({
      started: true,
      owned: { pid: 4242, claimedDirectory: "/owned/root/cluster" },
    });
    const seams = seamsFor({
      observe: () => "present",
      remove: () => {},
      exists: () => false,
    });

    const raised = await cleanupCluster(state, { slug: "x", databases: [], seams }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const rendered = `${String(raised)} ${JSON.stringify(raised, Object.getOwnPropertyNames(raised))}`;

    expect(rendered).not.toContain(CLUSTER_PASSWORD);
    expect(rendered).not.toContain("postgresql://");
  });
});

describe("the safety rule this module rests on", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./embedded-cluster.ts", import.meta.url)),
    "utf8",
  );

  /**
   * The module's executable text, with its prose removed.
   *
   * The documentation deliberately *names* the mechanisms this module refuses to use, so a scan
   * of the whole file would fail on its own explanation. Comments therefore go — but they must
   * go precisely. Deleting everything between the first comment-open and the next comment-close
   * with one regular expression also deletes whatever sits between two *string literals* that
   * happen to contain those delimiters, silently removing executable text and turning this suite
   * into a test that passes because it can no longer see the code.
   *
   * So the stripper below is a scanner that knows what a string and a template literal are and
   * leaves their contents alone, and `exposes the executable text it is asserting against`
   * proves it did. Trailing line comments are stripped too, so prose at the end of a line of
   * real code is no longer a failure: the assertions judge code, and the comments stay free to
   * name what the code refuses to do.
   */
  const stripComments = (text: string): string => {
    type Mode = "code" | "line" | "block" | "'" | '"' | "`";

    let out = "";
    let index = 0;
    let mode: Mode = "code";

    while (index < text.length) {
      const here = text[index] as string;
      const next = text[index + 1];

      if (mode === "code") {
        if (here === "/" && next === "/") {
          mode = "line";
          index += 2;
          continue;
        }

        if (here === "/" && next === "*") {
          mode = "block";
          index += 2;
          continue;
        }

        if (here === "'" || here === '"' || here === "`") {
          mode = here;
        }

        out += here;
        index += 1;
        continue;
      }

      if (mode === "line") {
        if (here === "\n") {
          mode = "code";
          out += here;
        }

        index += 1;
        continue;
      }

      if (mode === "block") {
        if (here === "*" && next === "/") {
          mode = "code";
          index += 2;
          continue;
        }

        // Newlines survive, so a line-numbered diagnostic still points somewhere real.
        if (here === "\n") out += here;

        index += 1;
        continue;
      }

      // Inside a string or template literal: the contents are code, and an escape takes a pair.
      if (here === "\\") {
        out += here + (next ?? "");
        index += 2;
        continue;
      }

      out += here;

      if (here === mode) mode = "code";

      index += 1;
    }

    return out;
  };

  const code = stripComments(source);

  /**
   * The guard on every other assertion here.
   *
   * A stripper that ate the module would make all of the prohibitions below vacuously true, so
   * the stripped text is required to still contain the declarations that carry the behaviour
   * being constrained. If this fails, nothing else in this describe means anything.
   */
  it("exposes the executable text it is asserting against", () => {
    for (const anchor of [
      "export function observePresence",
      "export function proveOwnedPostmaster",
      "export async function waitForOwnedExit",
      "export async function removeOwnedRoot",
      "export async function cleanupCluster",
      "process.kill(pid, 0)",
      "rmSync(",
    ]) {
      expect(code, `the comment stripper removed ${anchor}`).toContain(anchor);
    }

    // And it really did remove the prose, rather than leaving the file untouched.
    expect(code.length).toBeLessThan(source.length);
    expect(code).not.toContain("No process is ever signalled");
  });

  it.each([
    "taskkill",
    "pg_ctl",
    "wmic",
    "tasklist",
    "powershell",
    "execSync",
    "spawnSync",
    "execFile",
    "child_process",
    "worker_threads",
  ])("contains no reference to %s", (forbidden) => {
    expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it("sends no signal: the only process.kill is the existence check", () => {
    const calls = code.match(/process\.kill\([^)]*\)/g) ?? [];

    expect(calls).toEqual(["process.kill(pid, 0)"]);
  });

  it("names no signal it could send", () => {
    expect(code).not.toMatch(/SIG[A-Z]+/);
  });

  /**
   * Every removal this module is forbidden to perform, each with a sample that must match it.
   *
   * Counting one `rmSync(` proved less than it appeared to: a second removal through any *other*
   * filesystem API left that count at one and the assertion satisfied. The prohibition is on
   * removing anything but the owned root, so the other APIs are named here — and each pattern
   * carries a hostile sample, because a prohibition that matches nothing is worse than no
   * prohibition at all: it reads as a guarantee while asserting a tautology.
   *
   * Matching is on identifier boundaries, since a bare substring is both too weak and too
   * strong: `rm(` would miss `rmdirSync`, and would hit the `rm(` inside `platform()`.
   */
  const prohibitedRemovals: readonly { pattern: RegExp; sample: string }[] = [
    { pattern: /\brmdirSync\b/, sample: "rmdirSync(parent, { recursive: true });" },
    { pattern: /\bunlinkSync\b/, sample: "unlinkSync(someFile);" },
    { pattern: /\brimraf\b/, sample: 'import rimraf from "rimraf";' },
    { pattern: /\bfsPromises\b/, sample: "await fsPromises.rm(parent);" },
    {
      pattern: /(^|[^.\w])(fs|fsp|promises)\s*\.\s*(rm|rmdir|unlink)\b/m,
      sample: "await fs.rm(parent, { recursive: true });",
    },
    { pattern: /(^|[^.\w])(rm|rmdir|unlink)\s*\(/m, sample: "await rm(parent);" },
  ];

  it("states removal prohibitions that actually match what they prohibit", () => {
    for (const { pattern, sample } of prohibitedRemovals) {
      expect(sample, `${String(pattern)} matches nothing, so it prohibits nothing`).toMatch(
        pattern,
      );
    }

    // And none of them catches the one permitted call, so passing them is a real result.
    for (const { pattern } of prohibitedRemovals) {
      expect("rmSync(path, { recursive: true, force: true })").not.toMatch(pattern);
    }
  });

  it("removes only through the one seam, and only a path it was handed", () => {
    for (const { pattern } of prohibitedRemovals) {
      expect(code, `${String(pattern)} is a removal this module may not perform`).not.toMatch(
        pattern,
      );
    }

    const removals = code.match(/rmSync\([^)]*\)/g) ?? [];

    expect(removals).toEqual(["rmSync(path, { recursive: true, force: true })"]);
  });

  it("removes no pattern: the removal takes a path, never a glob", () => {
    expect(code).not.toMatch(/rmSync\([^)]*[*?][^)]*\)/);
  });
});
