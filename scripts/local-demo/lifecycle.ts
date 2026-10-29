/**
 * Lifecycle safeguards for the local demonstration (issue #248): the launcher lock, the
 * three-way PostgreSQL status, the reset decision and the bounded site shutdown.
 *
 * Everything here acts only on what the demo owns: its own lock file, the cluster in its own data
 * directory (through `pg_ctl`), and the `next dev` process the launcher spawned. Nothing locates
 * or stops a process by name or port; a port is only ever *checked*.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";

/** What `pg_ctl status` established about the owned cluster. */
export type ClusterStatus = "running" | "stopped" | "unknown";

/**
 * `pg_ctl status` exits 0 when the server is running and 3 when it is not. Any other exit
 * (4: no accessible data directory), a signal or a spawn failure (`null`) leaves it unknown.
 */
export function clusterStatusOf(exitCode: number | null): ClusterStatus {
  if (exitCode === 0) {
    return "running";
  }

  return exitCode === 3 ? "stopped" : "unknown";
}

/**
 * Why `reset` must not delete `.local-demo/`, or `undefined` when deletion is safe: the cluster is
 * confirmed stopped **and** nothing holds its port. A cluster whose `postmaster.pid` went missing
 * reports "stopped" to `pg_ctl` but still holds the port, so a busy port is treated as possibly
 * running, even if the holder is unrelated.
 */
export function resetRefusalOf(status: ClusterStatus, databasePortFree: boolean, databasePort: number): string | undefined {
  if (status === "unknown") {
    return "pg_ctl could not confirm that the local PostgreSQL cluster is stopped; nothing was deleted.";
  }

  if (status === "running") {
    return "The local PostgreSQL cluster is still running; nothing was deleted.";
  }

  if (!databasePortFree) {
    return `Port ${databasePort} is still in use, so a cluster from .local-demo/ may still be running; nothing was deleted.`;
  }

  return undefined;
}

/** Whether something is listening on `host:port`, by trying to bind it briefly. */
export function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** Poll until `host:port` is free, for at most `timeoutMs`. */
export async function waitForPortFree(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await portIsFree(host, port)) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Whether a process with this id exists. A permission error means it exists; any doubt counts as
 * alive, so a lock is never reclaimed from a process that might still hold it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface LockHolder {
  readonly pid: number;
  readonly command: string;
}

export interface OwnedLock {
  /** Whether the lock file still carries this launcher's token. */
  stillOwned(): boolean;
  /** Remove the lock file, only if it is still this launcher's. Safe to call more than once. */
  release(): void;
}

export type LockAttempt =
  | { readonly ok: true; readonly lock: OwnedLock }
  | { readonly ok: false; readonly reason: "active"; readonly holder: LockHolder }
  | { readonly ok: false; readonly reason: "unreadable" | "contended" };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The file's text, or `undefined` if it does not exist. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function holderOf(raw: string): (LockHolder & { readonly token: string }) | undefined {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; command?: unknown; token?: unknown };

    if (Number.isInteger(parsed.pid) && typeof parsed.command === "string" && typeof parsed.token === "string") {
      return { pid: parsed.pid as number, command: parsed.command, token: parsed.token };
    }
  } catch {
    // Unparseable: reported as unreadable below.
  }

  return undefined;
}

/**
 * Take the launcher lock at `path` for `command`, created exclusively (`wx`).
 *
 * - A lock whose process is alive is never taken: the attempt fails as `active`.
 * - A lock that cannot be read as one of ours is never taken: `unreadable`.
 * - A lock whose process has exited is moved aside atomically and the move is checked: if what
 *   was moved is not the stale lock that was read (another launcher replaced it meanwhile), it is
 *   restored and the attempt fails as `contended`.
 */
export function acquireLauncherLock(
  path: string,
  command: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): LockAttempt {
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, command, token, startedAt: new Date().toISOString() });

  const lock: OwnedLock = {
    stillOwned: () => {
      const raw = readIfPresent(path);

      return raw !== undefined && holderOf(raw)?.token === token;
    },
    release: () => {
      try {
        if (lock.stillOwned()) {
          rmSync(path, { force: true });
        }
      } catch {
        // Releasing is best effort; a leftover lock names an exited process and is reclaimed.
      }
    },
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return { ok: true, lock };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const observed = readIfPresent(path);

    if (observed === undefined) {
      continue;
    }

    const holder = holderOf(observed);

    if (holder === undefined) {
      return { ok: false, reason: "unreadable" };
    }

    if (isAlive(holder.pid)) {
      return { ok: false, reason: "active", holder: { pid: holder.pid, command: holder.command } };
    }

    const aside = `${path}.stale-${token}`;

    try {
      renameSync(path, aside);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }

      throw error;
    }

    if (readIfPresent(aside) !== observed) {
      try {
        linkSync(aside, path);
      } catch {
        // A newer lock is already in place; the owner of the moved one sees it is no longer theirs.
      }

      rmSync(aside, { force: true });
      return { ok: false, reason: "contended" };
    }

    rmSync(aside, { force: true });
  }

  return { ok: false, reason: "contended" };
}

/** Resolve `true` once `child` has exited, or `false` after `timeoutMs`. */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }

    child.once("exit", onExit);
  });
}

/** The message `site-control.mjs` turns into the site's own SIGTERM handling. */
export const SITE_STOP_MESSAGE = "local-demo:stop";

export type SiteStopOutcome = "stopped" | "did-not-exit" | "port-still-in-use";

/**
 * Stop the owned site process and confirm that it, and any worker it started, has finished.
 *
 * 1. Ask it to stop through its IPC channel, so `next dev` runs its own shutdown, which stops its
 *    worker and waits for it. Then wait up to `timeoutMs` for it to exit.
 * 2. If it has not exited, terminate that one process (`kill()` on the spawned child) and wait
 *    up to `timeoutMs` again.
 * 3. Wait up to `timeoutMs` for the site port to be released, which confirms that no worker of
 *    the site is still serving. The port is only checked; nothing listening on it is touched.
 */
export async function stopOwnedSite(
  site: ChildProcess,
  options: { readonly host: string; readonly port: number; readonly timeoutMs: number },
): Promise<SiteStopOutcome> {
  if (site.exitCode === null && site.signalCode === null) {
    if (site.connected) {
      try {
        site.send(SITE_STOP_MESSAGE);
      } catch {
        // The channel closed meanwhile; the exit wait below decides.
      }
    }

    if (!(await waitForExit(site, options.timeoutMs))) {
      site.kill();

      if (!(await waitForExit(site, options.timeoutMs))) {
        return "did-not-exit";
      }
    }
  }

  return (await waitForPortFree(options.host, options.port, options.timeoutMs)) ? "stopped" : "port-still-in-use";
}
