/**
 * The local demonstration's lifecycle safeguards (issue #248): one launcher at a time, an occupied
 * port, the three-way `pg_ctl` status, the reset refusal and a bounded, confirmed site shutdown.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireLauncherLock,
  clusterStatusOf,
  isProcessAlive,
  portIsFree,
  resetRefusalOf,
  stopOwnedSite,
  waitForExit,
} from "./lifecycle";

const HOST = "127.0.0.1";
const SITE_CONTROL = new URL("./site-control.mjs", import.meta.url).href;
const TEST_TIMEOUT_MS = 30_000;

let directory: string;
let lockPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "local-demo-lifecycle-"));
  lockPath = join(directory, "launcher.lock");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);

  if (pid === undefined) {
    throw new Error("Could not spawn a short-lived process.");
  }

  return pid;
}

describe("the launcher lock", () => {
  it("lets one command hold it and refuses a second while the first is alive", () => {
    const first = acquireLauncherLock(lockPath, "start");
    const second = acquireLauncherLock(lockPath, "start");

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "active", holder: { pid: process.pid, command: "start" } });
    expect(first.ok && first.lock.stillOwned()).toBe(true);
  });

  it("refuses stop and reset while a start holds it, leaving the holder's lock in place", () => {
    const holder = acquireLauncherLock(lockPath, "start");
    const before = readFileSync(lockPath, "utf8");

    for (const command of ["stop", "reset"]) {
      expect(acquireLauncherLock(lockPath, command)).toMatchObject({ ok: false, reason: "active" });
    }

    expect(readFileSync(lockPath, "utf8")).toBe(before);
    expect(holder.ok && holder.lock.stillOwned()).toBe(true);
  });

  it("is free again once released, and release removes only its own lock", () => {
    const first = acquireLauncherLock(lockPath, "start");

    expect(first.ok).toBe(true);
    if (first.ok) {
      first.lock.release();
    }

    const second = acquireLauncherLock(lockPath, "start");

    expect(second.ok).toBe(true);
    if (first.ok) {
      first.lock.release();
    }
    expect(second.ok && second.lock.stillOwned()).toBe(true);
  });

  it("reclaims a lock left by a process that has exited", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: exitedPid(), command: "start", token: "stale" }));

    const attempt = acquireLauncherLock(lockPath, "start");

    expect(attempt.ok).toBe(true);
    expect(attempt.ok && attempt.lock.stillOwned()).toBe(true);
  });

  it("never takes a lock it cannot read as one of its own", () => {
    writeFileSync(lockPath, "not a lock");

    expect(acquireLauncherLock(lockPath, "start")).toEqual({ ok: false, reason: "unreadable" });
    expect(readFileSync(lockPath, "utf8")).toBe("not a lock");
  });

  it("backs off and restores the newer lock when another launcher reclaimed the stale one first", () => {
    const rival = JSON.stringify({ pid: process.pid, command: "start", token: "rival" });

    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, command: "start", token: "stale" }));

    const attempt = acquireLauncherLock(lockPath, "start", () => {
      writeFileSync(lockPath, rival);
      return false;
    });

    expect(attempt).toEqual({ ok: false, reason: "contended" });
    expect(readFileSync(lockPath, "utf8")).toBe(rival);
  });

  it("treats this process as alive and an exited one as not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(exitedPid())).toBe(false);
  });
});

describe("the pg_ctl status and the reset decision", () => {
  it("separates confirmed running, confirmed stopped and everything else", () => {
    expect(clusterStatusOf(0)).toBe("running");
    expect(clusterStatusOf(3)).toBe("stopped");

    for (const code of [1, 2, 4, 127, null]) {
      expect(clusterStatusOf(code)).toBe("unknown");
    }
  });

  it("refuses deletion unless the cluster is confirmed stopped and its port is free", () => {
    expect(resetRefusalOf("unknown", true, 54329)).toMatch(/could not confirm.*nothing was deleted/);
    expect(resetRefusalOf("running", true, 54329)).toMatch(/still running; nothing was deleted/);
    expect(resetRefusalOf("stopped", false, 54329)).toMatch(/Port 54329 is still in use.*nothing was deleted/);
    expect(resetRefusalOf("stopped", true, 54329)).toBeUndefined();
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address() as net.AddressInfo;

      probe.close(() => resolve(port));
    });
  });
}

describe("an occupied port", () => {
  it("is reported busy, and free once its holder closes", async () => {
    const port = await freePort();
    const holder = net.createServer();

    await new Promise<void>((resolve) => holder.listen(port, HOST, resolve));
    expect(await portIsFree(HOST, port)).toBe(false);

    await new Promise<void>((resolve) => holder.close(() => resolve()));
    expect(await portIsFree(HOST, port)).toBe(true);
  });
});

/**
 * A stand-in for `next dev`: a parent that starts a worker listening on `port` and, like
 * `next dev`, stops that worker and waits for it in its SIGTERM handler. A `stubborn` site ignores
 * the stop request and starts its worker detached, so the worker outlives a forced exit.
 */
function fakeSite(port: number, stubborn: boolean): ChildProcess {
  const source = `
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, ["-e", ${JSON.stringify(
      `require("node:net").createServer().listen(${port}, "${HOST}", () => process.stdout.write("listening"))`,
    )}], { stdio: ["ignore", "pipe", "inherit"], detached: ${stubborn} });
    worker.stdout.once("data", () => process.send({ worker: worker.pid }));
    ${stubborn ? "" : `process.on("SIGTERM", () => { worker.kill(); worker.once("exit", () => process.exit(0)); });`}
  `;

  return spawn(process.execPath, ["--import", SITE_CONTROL, "-e", source], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

function workerOf(site: ChildProcess): Promise<number> {
  return new Promise((resolve) => site.once("message", (message) => resolve((message as { worker: number }).worker)));
}

describe("stopping the owned site", () => {
  it("asks it to stop, waits for it and its worker, and confirms the port is released", async () => {
    const port = await freePort();
    const site = fakeSite(port, false);
    const worker = await workerOf(site);

    expect(await portIsFree(HOST, port)).toBe(false);
    expect(await stopOwnedSite(site, { host: HOST, port, timeoutMs: 10_000 })).toBe("stopped");
    expect(site.exitCode).toBe(0);
    expect(isProcessAlive(worker)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("stops the site the same way when the launcher's channel closes", async () => {
    const port = await freePort();
    const site = fakeSite(port, false);
    const worker = await workerOf(site);

    site.disconnect();

    expect(await waitForExit(site, 10_000)).toBe(true);
    expect(site.exitCode).toBe(0);
    expect(isProcessAlive(worker)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("reports failure, never success, when a worker still holds the port after the bound", async () => {
    const port = await freePort();
    const site = fakeSite(port, true);
    const worker = await workerOf(site);

    try {
      expect(await stopOwnedSite(site, { host: HOST, port, timeoutMs: 1_500 })).toBe("port-still-in-use");
      expect(site.exitCode !== null || site.signalCode !== null).toBe(true);
    } finally {
      // The test's own orphaned worker, by the id its parent reported.
      if (isProcessAlive(worker)) {
        process.kill(worker);
      }
    }
  }, TEST_TIMEOUT_MS);

  it("goes straight to the port check for a site that already exited", async () => {
    const port = await freePort();
    const site = spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "ignore", "ignore", "ipc"] });

    expect(await waitForExit(site, 10_000)).toBe(true);
    expect(await stopOwnedSite(site, { host: HOST, port, timeoutMs: 1_000 })).toBe("stopped");
  }, TEST_TIMEOUT_MS);
});
