/**
 * The real-browser harness for the local administrator journey (issue #260 §3.9).
 *
 * It owns everything it uses, in a temporary directory: its own embedded PostgreSQL on loopback
 * (the governed test helper, migrated), per-run development keys, a self-signed certificate for
 * `127.0.0.1` made by the launcher's own `local-tls.ts`, a test-only diagnostics file, and its own
 * servers bound to `127.0.0.1`. **It never reads or writes `.local-demo/`.**
 *
 * ## Two halves in one file
 *
 * Playwright loads this file as CommonJS, and Node 22 refuses CommonJS output that mentions
 * `import.meta`, which several reused repository modules do. So the Playwright half below uses
 * only Node built-ins, and everything that reuses repository code (the cluster helper, the
 * launcher's TLS, key and lifecycle modules, the provisioning command, the keyed digest) runs as
 * a **service**: this same file, executed by Node under the launcher's TypeScript loader
 * (`scripts/local-demo/register.mjs`), with dynamic imports only. Global setup starts the
 * long-lived `setup` service; tests call short `provision` and `digest` services.
 *
 * `next dev` holds a lock in its build directory, so one development server runs at a time: the
 * service checks the production build and the closed development gate first, with real browsers,
 * then starts the gate-open server the journey tests use.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = process.cwd();
export const HOST = "127.0.0.1";
export const DATABASE = "admin_browser";
export const STATE_VARIABLE = "ADMIN_BROWSER_HARNESS_STATE";
export const SERVER_PID_VARIABLE = "ADMIN_BROWSER_SERVER_PID";
/**
 * Test-only failure injection for the harness's own cleanup test (`gate.e2e.ts`): a comma-separated
 * list of `cluster-start` (setup fails before the cluster is started, so no partial cluster-start
 * failure is exercised), `after-cluster` (setup fails once the cluster is up) and `evidence`
 * (copying the evidence fails during teardown).
 */
export const INJECT_FAILURE_VARIABLE = "ADMIN_BROWSER_HARNESS_INJECT_FAILURE";

const HARNESS_FILE = join(REPOSITORY_ROOT, "tests", "browser", "harness.ts");
const LOADER = pathToFileURL(join(REPOSITORY_ROOT, "scripts", "local-demo", "register.mjs")).href;
const NEXT_BIN = join(REPOSITORY_ROOT, "node_modules", "next", "dist", "bin", "next");
const SITE_CONTROL = pathToFileURL(join(REPOSITORY_ROOT, "scripts", "local-demo", "site-control.mjs")).href;
const SITE_CONTROL_OWNER_ENV = "LOCAL_DEMO_SITE_CONTROL_OWNER";

/** What the setup service hands every test, through one JSON file named by `STATE_VARIABLE`. */
export interface HarnessState {
  readonly origin: string;
  readonly port: number;
  readonly serverPid: number;
  readonly connectionString: string;
  readonly certificatePath: string;
  readonly diagnosticsFile: string;
  readonly outcomeLogFile: string;
  readonly totpKey: string;
  readonly throttleKey: string;
  readonly closedGateEvidenceFile: string;
}

export function harnessState(): HarnessState {
  const file = process.env[STATE_VARIABLE];

  if (file === undefined) {
    throw new Error("the browser harness state is missing; run through `npm run test:browser`");
  }

  return JSON.parse(readFileSync(file, "utf8")) as HarnessState;
}

/** Every new administrator path, and every method each must refuse uniformly when closed. */
export const ENTRY_PAGES = ["/admin", "/admin/sign-in", "/admin/sign-in/code", "/admin/sign-in/recovery", "/admin/recovery"] as const;
export const ENTRY_HANDLERS = [
  "/admin/sign-in/password",
  "/admin/sign-in/code/verify",
  "/admin/sign-out",
  // The recovery journey (issue #268).
  "/admin/sign-in/recovery/verify",
  "/admin/recovery/reenrolment/start",
  "/admin/recovery/reenrolment/complete",
  "/admin/recovery/codes",
  "/admin/recovery/sign-out",
] as const;
export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Text that only an open administrator page renders. */
export const PAGE_MARKERS = ["Administrator sign-in", "Authenticator code", "Signed in", "Administration", "Recovery code", "Recovery session"] as const;

export interface ClosedGateEvidence {
  /** `production` is `next start` with the full gate environment; `development` is `next dev` without it. */
  readonly phase: "production" | "development";
  readonly handlers: Array<{ readonly path: string; readonly method: string; readonly status: number; readonly body: string; readonly allow?: string }>;
  readonly pages: Array<{ readonly engine: string; readonly path: string; readonly status: number | null; readonly markers: string[] }>;
  readonly buildRoutes?: string[];
  /** How many client-bundle files contain a canary key or connection string from the build's environment. */
  readonly bundleCanaryHits?: number;
  readonly bundleFilesScanned?: number;
}

/* ------------------------------------------------------------------------------------------- */
/* The Playwright half: Node built-ins, `pg` and `otpauth` only                                */
/* ------------------------------------------------------------------------------------------- */

export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** One request, trusting the run's own certificate for this request only. */
export function send(
  server: { readonly origin: string },
  certificatePath: string,
  method: string,
  path: string,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs?: number } = {},
): Promise<Answer> {
  const url = new URL(path, server.origin);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  // Node sends a DELETE or OPTIONS body with neither a length nor chunking unless told, and the
  // server then reads the leftover bytes as a malformed second request; so the length is declared.
  const headers = {
    ...options.headers,
    ...(options.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(options.body)) }),
  };

  return new Promise((resolve, reject) => {
    const outgoing = transport(
      url,
      {
        method,
        headers,
        ca: readFileSync(certificatePath),
        // The certificate is checked against the URL's address, never a deliberately wrong Host header.
        checkServerIdentity: (_host, certificate) => checkServerIdentity(url.hostname, certificate),
        timeout: options.timeoutMs ?? 120_000,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );

    outgoing.on("timeout", () => outgoing.destroy(new Error("request timed out")));
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

type Pool = {
  query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
  on(event: string, listener: () => void): void;
};

/** A query pool on the harness's own database, for arranging and observing stored state. */
export function harnessPool(connectionString: string): Pool {
  const { Pool: PgPool } = require("pg") as { Pool: new (config: Record<string, unknown>) => Pool };
  const pool = new PgPool({ connectionString, max: 2 });
  pool.on("error", () => undefined);
  return pool;
}

export async function withPool<T>(connectionString: string, body: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = harnessPool(connectionString);

  try {
    return await body(pool);
  } finally {
    await pool.end();
  }
}

/** Clear every throttle row, so one test's failures never refuse another's sign-in. */
export function resetThrottles(connectionString: string): Promise<void> {
  return withPool(connectionString, async (pool) => {
    await pool.query("delete from authentication_throttle");
    await pool.query("delete from authentication_source_window");
  });
}

/** The test-only diagnostic events recorded so far. */
export function diagnostics(state: Pick<HarnessState, "diagnosticsFile">): Array<Record<string, string | number>> {
  if (!existsSync(state.diagnosticsFile)) {
    return [];
  }

  return readFileSync(state.diagnosticsFile, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, string | number>);
}

/** Run a short service and return its single JSON answer. */
function runService<T>(command: string, args: readonly string[]): T {
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", LOADER, HARNESS_FILE, command, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("RESULT "));

  if (result.status !== 0 || line === undefined) {
    throw new Error(`the ${command} service failed (exit ${String(result.status)})`);
  }

  return JSON.parse(line.slice("RESULT ".length)) as T;
}

export interface SyntheticAccount {
  readonly username: string;
  readonly password: string;
  readonly secretBase32: string;
  readonly administratorId: string;
  /** The ten codes the provisioning command showed once (issue #268 §3.1); none when unconfirmed. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Provision one synthetic administrator through the real command logic, driven by a scripted
 * terminal in the service. `confirm: false` answers the confirmation with a wrong code, leaving
 * the factor `pending_confirmation`.
 */
export function provisionAccount(state: Pick<HarnessState, "connectionString" | "totpKey">, options: { readonly confirm?: boolean } = {}): SyntheticAccount {
  return runService<SyntheticAccount>("provision", [state.connectionString, state.totpKey, options.confirm === false ? "unconfirmed" : "confirmed"]);
}

/**
 * Invoke one issue #270 storage operation through the `control` service, as the operator commands
 * would, while the harness server keeps running. The commands themselves need the launcher lock,
 * which the running harness does not hold (RV-D1).
 */
export function controlAccount(
  state: Pick<HarnessState, "connectionString">,
  operation: "revoke-all" | "revoke" | "disable",
  administratorId: string,
  sessionId = "",
): { readonly code: string } {
  return runService<{ readonly code: string }>("control", [state.connectionString, operation, administratorId, sessionId]);
}

/**
 * Run the operator reset (the Unit OR Scope Gate) through the real command logic, driven by a
 * scripted terminal in the `reset` service, while the harness server keeps running. Like the
 * control service, it stands in for the operator, who would run the command under the launcher
 * lock with the demo stopped (RV-D1). It returns the account with what the command showed once:
 * the new password, the new secret and the ten codes, or neither for a disabled account (D-16).
 */
export function resetAccount(
  state: Pick<HarnessState, "connectionString" | "totpKey" | "throttleKey">,
  account: Pick<SyntheticAccount, "username" | "administratorId">,
  password = `reset journey ${randomBytes(12).toString("hex")}`,
): SyntheticAccount & { readonly outcome: string } {
  return runService<SyntheticAccount & { readonly outcome: string }>("reset", [state.connectionString, state.totpKey, state.throttleKey, account.username, password]);
}

/** The real `keyedDigest`, computed by the service. */
export function keyedDigestOf(throttleKey: string, purpose: string, value: string): Buffer {
  return Buffer.from(runService<string>("digest", [throttleKey, purpose, value]), "base64url");
}

/** A TOTP code from an independent `otpauth` instance with the `ADR-004` parameters. */
export function codeAt(account: Pick<SyntheticAccount, "secretBase32">, epochMilliseconds: number): string {
  const { Secret, TOTP } = require("otpauth") as typeof import("otpauth");
  return new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(account.secretBase32) }).generate({ timestamp: epochMilliseconds });
}

/** A code for the next time step: inside the one-step window, and after the enrolment's step. */
export function nextCode(account: Pick<SyntheticAccount, "secretBase32">): string {
  return codeAt(account, Date.now() + 30_000);
}

/**
 * Playwright global setup: start the long-lived `setup` service, wait for its state file, and
 * return the teardown, which asks the service to stop everything it started.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const service = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", LOADER, HARNESS_FILE, "setup"], {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "pipe", "inherit", "ipc"],
    windowsHide: true,
  });
  const exited = new Promise<number>((resolve) => service.once("exit", (code) => resolve(code ?? 1)));

  const stateFile = await new Promise<string>((resolve, reject) => {
    let pending = "";
    service.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const ready = /^READY (.+)$/m.exec(pending);

      if (ready?.[1] !== undefined) {
        resolve(ready[1].trim());
      }
    });
    void exited.then((code) => reject(new Error(`the browser harness setup service exited (${code}) before it was ready`)));
  });

  process.env[STATE_VARIABLE] = stateFile;
  process.env[SERVER_PID_VARIABLE] = String(harnessState().serverPid);

  return async () => {
    if (service.connected) {
      service.send("stop");
    }

    const code = await exited;

    if (code !== 0) {
      throw new Error(`the browser harness teardown did not complete cleanly (${code})`);
    }
  };
}

/** What an injected-failure run of the setup service reported, for the harness cleanup test. */
export interface InjectedSetupRun {
  readonly code: number;
  readonly root: string | undefined;
  readonly clusterPort: number | undefined;
  readonly clusterRoot: string | undefined;
  readonly stderr: string;
}

/** Run the real `setup` service with `failures` injected, to completion. */
export function runInjectedSetup(failures: string): Promise<InjectedSetupRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", LOADER, HARNESS_FILE, "setup"], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, [INJECT_FAILURE_VARIABLE]: failures },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("exit", (code) => {
      const cluster = /^CLUSTER ([0-9]+) (.+)$/m.exec(stdout);
      resolve({
        code: code ?? 1,
        root: /^ROOT (.+)$/m.exec(stdout)?.[1]?.trim(),
        clusterPort: cluster?.[1] === undefined ? undefined : Number(cluster[1]),
        clusterRoot: cluster?.[2]?.trim(),
        stderr,
      });
    });
  });
}

/* ------------------------------------------------------------------------------------------- */
/* The service half: run by Node under the launcher's loader; repository code by dynamic import */
/* ------------------------------------------------------------------------------------------- */

interface RunningServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly origin: string;
}

interface Certificate {
  readonly keyPath: string;
  readonly certPath: string;
}

/** The parent environment without anything that could open the gate or change the mode. */
function baseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(LOCAL_ADMIN_|LOCAL_DEMO_|NODE_ENV$|ADMIN_BROWSER_)/.test(name)) {
      environment[name] = value;
    }
  }

  return { ...environment, NEXT_TELEMETRY_DISABLED: "1" };
}

async function gateEnvironmentFor(
  keys: { readonly totpKey: Buffer; readonly throttleKey: Buffer },
  port: number,
  connectionString: string,
  diagnosticsFile?: string,
): Promise<Record<string, string>> {
  const { administratorEnvironmentFor } = await import("../../scripts/local-demo/administrator-keys");
  const { LOCAL_DEMO_DATABASE_URL } = await import("../../src/interface/public/local-demo-persistence");
  const { LOCAL_ADMIN_DIAGNOSTICS_FILE } = await import("../../src/interface/admin/authentication-runtime");

  return {
    [LOCAL_DEMO_DATABASE_URL]: connectionString,
    ...administratorEnvironmentFor(keys, `https://${HOST}:${port}`),
    ...(diagnosticsFile === undefined ? {} : { [LOCAL_ADMIN_DIAGNOSTICS_FILE]: diagnosticsFile }),
  };
}

/** Start `next dev` (over the run's certificate) or `next start` on `127.0.0.1`. */
async function startServer(
  mode: "dev" | "start",
  port: number,
  certificate: Certificate,
  environment: Readonly<Record<string, string>>,
  outputFile?: string,
): Promise<RunningServer> {
  const { httpsArgumentsFor } = await import("../../scripts/local-demo/local-tls");
  const args =
    mode === "dev"
      ? ["dev", "--hostname", HOST, "--port", String(port), ...httpsArgumentsFor(certificate)]
      : ["start", "--hostname", HOST, "--port", String(port)];
  const child = spawn(process.execPath, ["--import", SITE_CONTROL, NEXT_BIN, ...args], {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    // `next dev` and `next start` set NODE_ENV themselves; the parent's is removed.
    env: { ...baseEnvironment(), ...environment, [SITE_CONTROL_OWNER_ENV]: String(process.pid) } as unknown as NodeJS.ProcessEnv,
  });

  child.stdout?.on("data", (chunk: Buffer) => (outputFile === undefined ? undefined : appendFileSync(outputFile, chunk)));
  child.stderr?.on("data", () => undefined);

  // `next start` serves plain HTTP; the production check needs it only to answer at all.
  const server: RunningServer = { child, port, origin: `${mode === "dev" ? "https" : "http"}://${HOST}:${port}` };
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the ${mode} server exited during startup`);
    }

    try {
      await send(server, certificate.certPath, "GET", "/admin/sign-in", { timeoutMs: 60_000 });
      return server;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await stopServer(server);
  throw new Error(`the ${mode} server did not answer within the startup bound`);
}

async function stopServer(server: RunningServer): Promise<void> {
  const { stopOwnedSite } = await import("../../scripts/local-demo/lifecycle");
  const outcome = await stopOwnedSite(server.child, { host: HOST, port: server.port, timeoutMs: 30_000 });

  if (outcome !== "stopped") {
    throw new Error(`the server did not stop cleanly: ${outcome}`);
  }
}

function runBuild(environment: Readonly<Record<string, string>>): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NEXT_BIN, "build"], {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...baseEnvironment(), ...environment } as unknown as NodeJS.ProcessEnv,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function probeClosedGate(phase: ClosedGateEvidence["phase"], server: RunningServer, certificate: Certificate): Promise<ClosedGateEvidence> {
  const { chromium, firefox, webkit } = await import("@playwright/test");
  const handlers: ClosedGateEvidence["handlers"][number][] = [];
  const pages: ClosedGateEvidence["pages"][number][] = [];

  for (const path of [...ENTRY_HANDLERS, ...ENTRY_PAGES]) {
    for (const method of METHODS) {
      const answer = await send(server, certificate.certPath, method, path, {
        headers: { Origin: server.origin, "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
        body: method === "GET" || method === "HEAD" ? undefined : "username=a&password=b&code=123456",
      });
      const allow = answer.headers.allow;
      handlers.push({ path, method, status: answer.status, body: answer.body, ...(typeof allow === "string" ? { allow } : {}) });
    }
  }

  for (const [engine, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]] as const) {
    const browser = await type.launch();

    try {
      const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();

      for (const path of ENTRY_PAGES) {
        const response = await page.goto(`${server.origin}${path}`);
        const text = await page.locator("body").innerText();
        pages.push({ engine, path, status: response?.status() ?? null, markers: PAGE_MARKERS.filter((marker) => text.includes(marker)) });
      }
    } finally {
      await browser.close();
    }
  }

  return { phase, handlers, pages };
}

/** Count the client-bundle files under `.next/static` that contain any of the canaries. */
async function scanClientBundles(canaries: readonly string[]): Promise<{ hits: number; files: number }> {
  const { readdirSync, statSync } = await import("node:fs");
  const pending = [join(REPOSITORY_ROOT, ".next", "static")];
  let hits = 0;
  let files = 0;

  while (pending.length > 0) {
    const directory = pending.pop() ?? "";

    for (const name of readdirSync(directory)) {
      const path = join(directory, name);

      if (statSync(path).isDirectory()) {
        pending.push(path);
      } else {
        files += 1;
        const text = readFileSync(path, "latin1");
        hits += canaries.some((canary) => text.includes(canary)) ? 1 : 0;
      }
    }
  }

  return { hits, files };
}

/**
 * Run every teardown step, in order, even when an earlier one throws, and return the failures.
 * A failed evidence copy can therefore never leave the cluster or the temporary root behind.
 */
async function runEvery(steps: ReadonlyArray<readonly [string, () => unknown]>): Promise<string[]> {
  const failures: string[] = [];

  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return failures;
}

/** The long-lived `setup` service: announces `READY <state file>`, then waits for `stop`. */
async function setupService(): Promise<number> {
  const { cleanupCluster, freePort, startClusterForTests } = await import("../../src/data/testing/embedded-cluster");
  const { ensureLocalCertificate } = await import("../../scripts/local-demo/local-tls");
  const injected = new Set((process.env[INJECT_FAILURE_VARIABLE] ?? "").split(",").filter(Boolean));
  const root = mkdtempSync(join(tmpdir(), "cdp-admin-browser-"));
  // An injected run uses its own cluster slug, so it never meets the real run's cluster.
  const request = { slug: injected.size > 0 ? "admin-browser-cleanup" : "admin-browser", databases: [DATABASE], migrate: [DATABASE] };
  let started: Awaited<ReturnType<typeof startClusterForTests>> | undefined;
  let server: RunningServer | undefined;
  let failed = false;

  process.stdout.write(`ROOT ${root}\n`);

  try {
    if (injected.has("cluster-start")) {
      throw new Error("injected: the cluster failed to start");
    }

    started = await startClusterForTests(request);
    process.stdout.write(`CLUSTER ${started.state.port} ${started.state.root}\n`);

    if (injected.has("after-cluster")) {
      throw new Error("injected: setup failed after the cluster started");
    }

    const connectionString = started.cluster.connectionStringFor(DATABASE);
    const certificate = await ensureLocalCertificate(join(root, "tls"));
    const keys = { totpKey: randomBytes(32), throttleKey: randomBytes(32) };
    const evidence: ClosedGateEvidence[] = [];

    // O-1: a production build, made with canary gate values in its environment (O-6), then served
    // by `next start` with the full gate environment.
    const canaryKeys = { totpKey: randomBytes(32), throttleKey: randomBytes(32) };
    const buildEnvironment = await gateEnvironmentFor(canaryKeys, 1, connectionString);
    const build = await runBuild(buildEnvironment);

    if (build.code !== 0) {
      throw new Error("next build failed in the browser harness");
    }

    const scanned = await scanClientBundles([
      canaryKeys.totpKey.toString("base64url"),
      canaryKeys.throttleKey.toString("base64url"),
      connectionString,
    ]);

    const productionPort = await freePort();
    const production = await startServer("start", productionPort, certificate, await gateEnvironmentFor(keys, productionPort, connectionString));

    try {
      evidence.push({
        ...(await probeClosedGate("production", production, certificate)),
        buildRoutes: build.output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[┌├└]\s+[ƒ○●]\s+\//.test(line)),
        bundleCanaryHits: scanned.hits,
        bundleFilesScanned: scanned.files,
      });
    } finally {
      await stopServer(production);
    }

    // O-2: `next dev` started without the launcher's environment.
    const closedPort = await freePort();
    const closed = await startServer("dev", closedPort, certificate, {});

    try {
      evidence.push(await probeClosedGate("development", closed, certificate));
    } finally {
      await stopServer(closed);
    }

    // The gate-open journey server, with the test-only diagnostics sink.
    const port = await freePort();
    const diagnosticsFile = join(root, "diagnostics.jsonl");
    const outcomeLogFile = join(root, "outcomes.log");
    server = await startServer("dev", port, certificate, await gateEnvironmentFor(keys, port, connectionString, diagnosticsFile), outcomeLogFile);

    const state: HarnessState = {
      origin: server.origin,
      port,
      serverPid: server.child.pid ?? 0,
      connectionString,
      certificatePath: certificate.certPath,
      diagnosticsFile,
      outcomeLogFile,
      totpKey: keys.totpKey.toString("base64url"),
      throttleKey: keys.throttleKey.toString("base64url"),
      closedGateEvidenceFile: join(root, "closed-gate.json"),
    };
    const stateFile = join(root, "state.json");

    writeFileSync(state.closedGateEvidenceFile, JSON.stringify(evidence, null, 2));
    writeFileSync(stateFile, JSON.stringify(state));
    process.stdout.write(`READY ${stateFile}\n`);

    await new Promise<void>((resolve) => {
      process.once("message", () => resolve());
      process.once("disconnect", () => resolve());
    });
  } catch (error) {
    failed = true;
    process.stderr.write(`browser harness setup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  } finally {
    // Every step runs even if an earlier one fails: keep the run's evidence (never a key,
    // credential or certificate) in the git-ignored Playwright output directory, then remove
    // the cluster and everything else the run created.
    const problems = await runEvery([
      ["stop the journey server", async () => {
        if (server !== undefined) {
          await stopServer(server);
        }
      }],
      ["copy the evidence", async () => {
        if (injected.has("evidence")) {
          throw new Error("injected: the evidence could not be copied");
        }

        const { copyFileSync, mkdirSync } = await import("node:fs");
        const kept = join(REPOSITORY_ROOT, "test-results", "admin-harness");
        mkdirSync(kept, { recursive: true });

        for (const name of ["outcomes.log", "diagnostics.jsonl", "closed-gate.json"]) {
          if (existsSync(join(root, name))) {
            copyFileSync(join(root, name), join(kept, name));
          }
        }
      }],
      ["clean up the cluster", async () => {
        if (started !== undefined) {
          await cleanupCluster(started.state, request);
        }
      }],
      ["remove the temporary root", () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })],
    ]);

    for (const problem of problems) {
      failed = true;
      process.stderr.write(`browser harness teardown: ${problem}\n`);
    }
  }

  return failed ? 1 : 0;
}

/** The `provision` service: one synthetic account through the real command, scripted. */
async function provisionService(connectionString: string, totpKey: string, mode: string): Promise<SyntheticAccount> {
  const { provisionSyntheticAdministrator } = await import("../../scripts/local-demo/administrator-provisioning");
  const { createListingPersistence } = await import("../../src/data/connection");
  const { totpCodeAt } = await import("../../src/domain/administrator-auth/totp");
  const { Secret } = await import("otpauth");
  const { sql } = await import("kysely");
  const username = `synthetic-${randomBytes(6).toString("hex")}`;
  const password = `local journey ${randomBytes(12).toString("hex")}`;
  const answers = [username, password, password];
  const lines: string[] = [];
  let secretBase32 = "";
  const persistence = createListingPersistence({ pool: { connectionString, max: 1 } });

  try {
    const result = await provisionSyntheticAdministrator(
      {
        interactive: true,
        ask: async (prompt) => {
          if (!prompt.startsWith("Current six-digit code")) {
            return answers.shift() ?? "";
          }

          secretBase32 = lines.map((line) => /Secret \(base32\): ([A-Z2-7]+)/.exec(line)?.[1]).find((value) => value !== undefined) ?? "";
          const code = totpCodeAt(Buffer.from(Secret.fromBase32(secretBase32).bytes), Date.now());
          return mode === "unconfirmed" ? String((Number(code) + 500_000) % 1_000_000).padStart(6, "0") : code;
        },
        askSecret: async () => answers.shift() ?? "",
        say: (line) => lines.push(line),
      },
      { db: persistence.db as never, clock: Date.now, totpKey: Buffer.from(totpKey, "base64url"), environment: {}, databaseUrl: connectionString },
    );

    const expected = mode === "unconfirmed" ? !result.ok && result.reason === "NOT_CONFIRMED" : result.ok;

    if (!expected) {
      throw new Error(`provisioning gave ${JSON.stringify(result)}`);
    }

    const row = await sql<{ id: string }>`select id from administrator where username = ${username}`.execute(persistence.db);
    const recoveryCodes = lines.filter((line) => /^  [0-9a-f]{8}(-[0-9a-f]{8}){3}$/.test(line)).map((line) => line.trim());
    return { username, password, secretBase32, administratorId: row.rows[0]?.id ?? "", recoveryCodes };
  } finally {
    await persistence.shutdown();
  }
}

/** The `control` service: one revocation or disable storage operation (issue #270). */
async function controlService(connectionString: string, operation: string, administratorId: string, sessionId: string): Promise<{ readonly code: string }> {
  const storage = await import("../../src/data/administrator-authentication");
  const { createListingPersistence } = await import("../../src/data/connection");
  const persistence = createListingPersistence({ pool: { connectionString, max: 1 } });
  const db = persistence.db as never;

  try {
    const outcome =
      operation === "revoke-all"
        ? await storage.revokeAllSessions(db, { administratorId })
        : operation === "revoke"
          ? await storage.revokeSession(db, { administratorId, sessionId })
          : operation === "disable"
            ? await storage.disableAccount(db, { administratorId }, Date.now)
            : undefined;

    if (outcome === undefined || !outcome.ok) {
      throw new Error(`control ${operation} gave ${JSON.stringify(outcome)}`);
    }

    return { code: outcome.value.code };
  } finally {
    await persistence.shutdown();
  }
}

/** The `reset` service: one operator reset through the real command, with a scripted terminal. */
async function resetService(connectionString: string, totpKey: string, throttleKey: string, username: string, password: string): Promise<SyntheticAccount & { readonly outcome: string }> {
  const { resetSyntheticAdministrator } = await import("../../scripts/local-demo/administrator-reset");
  const { createListingPersistence } = await import("../../src/data/connection");
  const { totpCodeAt } = await import("../../src/domain/administrator-auth/totp");
  const { Secret } = await import("otpauth");
  const { sql } = await import("kysely");
  const answers = [username, username];
  const secrets = [password, password];
  const lines: string[] = [];
  let secretBase32 = "";
  const persistence = createListingPersistence({ pool: { connectionString, max: 1 } });

  try {
    const result = await resetSyntheticAdministrator(
      {
        interactive: true,
        ask: async (prompt) => {
          if (!prompt.startsWith("Current six-digit code")) {
            return answers.shift() ?? "";
          }

          secretBase32 = lines.map((line) => /Secret \(base32\): ([A-Z2-7]+)/.exec(line)?.[1]).find((value) => value !== undefined) ?? "";
          return totpCodeAt(Buffer.from(Secret.fromBase32(secretBase32).bytes), Date.now());
        },
        askSecret: async () => secrets.shift() ?? "",
        say: (line) => lines.push(line),
      },
      {
        db: persistence.db as never,
        clock: Date.now,
        keys: { totpKey: Buffer.from(totpKey, "base64url"), throttleKey: Buffer.from(throttleKey, "base64url") },
        environment: {},
        databaseUrl: connectionString,
      },
    );

    if (result.outcome !== "CREDENTIALS_RESET_CONFIRMED" && result.outcome !== "CREDENTIALS_RESET_ACCOUNT_DISABLED") {
      throw new Error(`reset gave ${JSON.stringify(result)}`);
    }

    const row = await sql<{ id: string }>`select id from administrator where username = ${username}`.execute(persistence.db);
    const recoveryCodes = lines.filter((line) => /^  [0-9a-f]{8}(-[0-9a-f]{8}){3}$/.test(line)).map((line) => line.trim());
    return { outcome: result.outcome, username, password, secretBase32, administratorId: row.rows[0]?.id ?? "", recoveryCodes };
  } finally {
    await persistence.shutdown();
  }
}

async function digestService(key: string, purpose: string, value: string): Promise<string> {
  const { keyedDigest } = await import("../../src/domain/administrator-auth/keyed-digest");
  return keyedDigest(Buffer.from(key, "base64url"), purpose as "password-username", value).toString("base64url");
}

const invokedAsService =
  process.argv[1] !== undefined && process.argv[1].toLowerCase().replace(/\//g, "\\") === HARNESS_FILE.toLowerCase().replace(/\//g, "\\");

if (invokedAsService) {
  const [command, ...args] = process.argv.slice(2);
  const run = async (): Promise<number> => {
    if (command === "setup") {
      return setupService();
    }

    const value =
      command === "provision"
        ? await provisionService(args[0] ?? "", args[1] ?? "", args[2] ?? "confirmed")
        : command === "digest"
          ? await digestService(args[0] ?? "", args[1] ?? "", args[2] ?? "")
          : command === "control"
            ? await controlService(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "")
            : command === "reset"
              ? await resetService(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "", args[4] ?? "")
              : undefined;

    if (value === undefined) {
      return 2;
    }

    process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
    return 0;
  };

  run().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`harness service ${String(command)} failed: ${error instanceof Error ? error.message : "unknown"}\n`);
      process.exit(1);
    },
  );
}
