/**
 * A reproducible end-to-end check of the local demo's lifecycle safeguards (issue #248), against
 * the real launcher, PostgreSQL and `next dev`. It is not part of `npm run test`; run it with
 * `node scripts/local-demo/check-lifecycle.mjs` while no local demo is running and ports 3000 and
 * 54329 on 127.0.0.1 are free. It reseeds the demo database, as `npm run demo:local` does, and
 * leaves `.local-demo/` in place with the cluster stopped.
 *
 * It checks, in order:
 * 1. an occupied site port makes `start` refuse before it changes anything;
 * 2. a second `start`, a `stop` and a `reset` all refuse while a demo is active, and that demo
 *    keeps serving;
 * 3. an orderly shutdown makes the launcher exit 0 only after the site child exited, port 3000
 *    became bindable and the cluster stopped (this does not prove every site worker exited);
 * 4. `reset` deletes nothing while the database port is busy or `pg_ctl` cannot confirm a stop;
 * 5. a stale or unreadable launcher lock makes `start`, `stop` and `reset` refuse, and leaves the
 *    lock byte-for-byte unchanged. The check then removes the lock files it wrote itself.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOST = "127.0.0.1";
const WEB_PORT = 3000;
const DATABASE_PORT = 54329;
const DIRECTORY_URL = `http://${HOST}:${WEB_PORT}/directory`;
const DEMO_DIRECTORY = join(ROOT, ".local-demo");
const PG_VERSION = join(DEMO_DIRECTORY, "pgdata", "PG_VERSION");
const LAUNCHER = [
  "--no-warnings",
  "--experimental-transform-types",
  "--import",
  "./scripts/local-demo/register.mjs",
  "scripts/local-demo/local-demo.ts",
];

let failures = 0;

function check(name, condition) {
  process.stdout.write(`${condition ? "PASS" : "FAIL"}  ${name}\n`);
  failures += condition ? 0 : 1;
}

/** Run a launcher command to completion; resolve with its exit code and output. */
function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...LAUNCHER, command], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("exit", (code) => resolve({ code, output }));
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once("error", () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

function occupy(port) {
  return new Promise((resolve) => {
    const holder = net.createServer();

    holder.listen(port, HOST, () => resolve(holder));
  });
}

async function statusOf(url) {
  try {
    return (await fetch(url)).status;
  } catch {
    return 0;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

if (!(await portIsFree(WEB_PORT)) || !(await portIsFree(DATABASE_PORT))) {
  process.stdout.write("Ports 3000 and 54329 on 127.0.0.1 must be free; stop any local demo first.\n");
  process.exit(2);
}

if (existsSync(join(DEMO_DIRECTORY, "launcher.lock"))) {
  process.stdout.write(".local-demo/launcher.lock exists; this check never touches a lock it did not write. Resolve it first.\n");
  process.exit(2);
}

// 1. An occupied site port.
{
  const holder = await occupy(WEB_PORT);
  const { code, output } = await runCommand("start");

  holder.close();
  check("start refuses while port 3000 is occupied", code === 1 && output.includes("Port 3000 on 127.0.0.1 is in use"));
  check(
    "  ...before starting, migrating or seeding anything",
    !/Starting PostgreSQL|Applying migrations|synthetic listings/.test(output),
  );
  check("  ...and leaves port 54329 free", await portIsFree(DATABASE_PORT));
}

// 2. An active demo, and the commands that must not disturb it.
const active = spawn(process.execPath, [...LAUNCHER, "start"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let activeOutput = "";

active.stdout.on("data", (chunk) => (activeOutput += chunk));
active.stderr.on("data", (chunk) => (activeOutput += chunk));

const serving = await waitFor(async () => (await statusOf(DIRECTORY_URL)) === 200, 180_000);

check("the first start serves /directory", serving);

if (serving) {
  const second = await runCommand("start");

  check("a second start refuses while the first is active", second.code === 1 && second.output.includes("is still active"));
  check("  ...without reseeding or stopping anything", !/Starting PostgreSQL|Applying migrations|synthetic listings|Stopping/.test(second.output));

  for (const command of ["stop", "reset"]) {
    const { code, output } = await runCommand(command);

    check(`${command} refuses while the demo is active`, code === 1 && output.includes("is still active"));
  }

  check("the active demo still serves /directory", (await statusOf(DIRECTORY_URL)) === 200);
  check("the active demo's directory is still in place", existsSync(PG_VERSION));
}

// 3. An orderly shutdown (the same path as Ctrl+C), requested over IPC.
{
  const exited = new Promise((resolve) => active.once("exit", (code) => resolve(code)));
  const requestedAt = Date.now();

  active.send("local-demo:shutdown");

  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 120_000))]);

  check(`the launcher exits 0 after shutdown (${Date.now() - requestedAt} ms)`, code === 0);
  check("  ...reporting success only after the site and the cluster stopped", /Stopping PostgreSQL[\s\S]*Stopped\.\s*$/.test(activeOutput));
  check("  ...with port 3000 bindable again (the site child exited; not proof every worker did)", await portIsFree(WEB_PORT));
  check("  ...and port 54329 released", await portIsFree(DATABASE_PORT));
  check("  ...and the launcher lock released", !existsSync(join(DEMO_DIRECTORY, "launcher.lock")));
}

// 4. Reset refuses on doubt.
{
  const holder = await occupy(DATABASE_PORT);
  const { code, output } = await runCommand("reset");

  holder.close();
  check("reset refuses while port 54329 is busy", code === 1 && output.includes("Port 54329 is still in use"));
  check("  ...and deletes nothing", existsSync(PG_VERSION));
}

{
  // pg_ctl status exits 4 for a directory that is not a cluster: neither running nor stopped.
  const aside = `${PG_VERSION}.check-aside`;

  renameSync(PG_VERSION, aside);

  try {
    const { code, output } = await runCommand("reset");

    check("reset refuses when pg_ctl cannot confirm the status", code === 1 && output.includes("could not confirm"));
    check("  ...and deletes nothing", existsSync(aside));
  } finally {
    renameSync(aside, PG_VERSION);
  }
}

// 5. A stale or unreadable lock fails closed and is left exactly as it was.
{
  const lockPath = join(DEMO_DIRECTORY, "launcher.lock");
  const { pid: exitedPid } = spawnSync(process.execPath, ["-e", ""]);
  const cases = [
    ["stale", JSON.stringify({ pid: exitedPid, command: "start", token: "check-stale" }), "no longer appears to be running"],
    ["unreadable", "not a lock", "is unreadable"],
  ];

  for (const [kind, content, message] of cases) {
    writeFileSync(lockPath, content);

    try {
      for (const command of ["start", "stop", "reset"]) {
        const { code, output } = await runCommand(command);

        check(`${command} refuses the ${kind} lock`, code === 1 && output.includes(message));
        check("  ...leaving the lock unchanged", readFileSync(lockPath, "utf8") === content);
        check("  ...and starting or deleting nothing", existsSync(PG_VERSION) && (await portIsFree(WEB_PORT)) && (await portIsFree(DATABASE_PORT)));
      }
    } finally {
      // Deliberate recovery of a lock this check wrote itself, with no demo running.
      rmSync(lockPath, { force: true });
    }
  }
}

process.stdout.write(failures === 0 ? "\nAll lifecycle checks passed.\n" : `\n${failures} lifecycle check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
