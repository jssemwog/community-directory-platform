/**
 * `ADR-028` D-17's process count P, established by **direct server evidence** (issue #260 §6.8 as
 * qualified by §12 items 1, 3 and 4).
 *
 * The evidence is the test-only diagnostics sink (`authentication-runtime.ts`), which the harness
 * alone enables: for each request that reached the runtime it records the serving process, its
 * parent, the runtime and limiter identities and the module instances involved. Nothing here is
 * read from a browser response or from the ordinary outcome log.
 *
 * These checks concern the server, not a browser engine, so they run once, in the `server` project,
 * which every engine project depends on: its first test is the run's first request to reach the
 * runtime. The browser journey runs in all three engines elsewhere.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  diagnostics,
  harnessState,
  keyedDigestOf,
  nextCode,
  provisionAccount,
  REPOSITORY_ROOT,
  resetThrottles,
  send,
  withPool,
  type Answer,
} from "./harness";

const state = harnessState();
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const headers = (cookie?: string) => ({
  Origin: state.origin,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/x-www-form-urlencoded",
  ...(cookie === undefined ? {} : { Cookie: cookie }),
});
const post = (path: string, fields: Record<string, string>, cookie?: string): Promise<Answer> =>
  send(state, state.certificatePath, "POST", path, { headers: headers(cookie), body: form(fields) });
const unknownName = (index: number) => `synthetic-unknown-${Date.now().toString(36)}-${index}`;

function cookieFrom(answer: Answer, name: string): string | undefined {
  const values = ([] as string[]).concat(answer.headers["set-cookie"] ?? []);
  const found = values.find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`));
  return found?.split(";")[0];
}

/** Evidence lines, printed by the list reporter and kept in the run output. */
const evidence = (line: string) => console.log(`[evidence] ${line}`);

const entries = () => diagnostics(state).filter((event) => event.event === "entry");

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await resetThrottles(state.connectionString);
});

test("concurrent first requests create exactly one runtime, pool, dummy hash and limiter", async () => {
  const before = diagnostics(state).filter((event) => event.event === "runtime-created").length;
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => post("/admin/sign-in/password", { username: unknownName(i), password: "not the password at all" })));
  const created = diagnostics(state).filter((event) => event.event === "runtime-created");

  evidence(`runtime-created before=${before} after=${created.length}; statuses=${answers.map((a) => a.status).join(",")}`);
  expect(before, "these must be the first requests that reach the runtime").toBe(0);
  expect(created).toHaveLength(1);
  expect(new Set(entries().map((event) => `${event.runtimeId}/${event.limiterId}`)).size).toBe(1);
});

test("both sign-in handlers run in one process and share one runtime and limiter", async () => {
  const account = provisionAccount(state);
  const password = await post("/admin/sign-in/password", { username: account.username, password: account.password });
  const challenge = cookieFrom(password, "__Host-admin-challenge");
  expect(password.status).toBe(303);
  expect(challenge).toBeDefined();

  const code = await post("/admin/sign-in/code/verify", { code: nextCode(account) }, challenge);
  expect(code.status).toBe(303);
  expect(code.headers.location).toBe("/admin");

  const seen = entries();
  const byEntry = new Set(seen.map((event) => event.entry));
  const processes = new Set(seen.map((event) => event.pid));
  const parents = new Set(seen.map((event) => event.ppid));
  const runtimes = new Set(seen.map((event) => event.runtimeId));
  const limiters = new Set(seen.map((event) => event.limiterId));
  const entryModules = new Set(seen.map((event) => `${event.entry}:${event.entryModule}`));

  evidence(
    `entries=${[...byEntry].join(",")} pids=${[...processes].join(",")} ppids=${[...parents].join(",")} spawned=${state.serverPid} runtimes=${runtimes.size} limiters=${limiters.size} entry-module-instances=${entryModules.size}`,
  );
  expect(byEntry).toEqual(new Set(["password", "code"]));
  expect(processes.size, "one serving process").toBe(1);
  expect([...parents], "the serving process is the spawned `next dev` CLI's own child").toEqual([state.serverPid]);
  expect(runtimes.size).toBe(1);
  expect(limiters.size).toBe(1);
});

test("a hot reload re-evaluates the handler module but keeps the process, runtime and limiter", async () => {
  const before = entries();
  const last = before[before.length - 1];
  expect(last).toBeDefined();

  // Turbopack ignores a timestamp-only touch, so the handler module gets a trailing comment for
  // the duration of this test. Its exact original bytes are restored in `finally` and checked.
  const target = join(REPOSITORY_ROOT, "src", "interface", "admin", "entry-points.ts");
  const original = readFileSync(target);
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  let reloaded: Record<string, string | number> | undefined;

  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from("\n// hot-reload probe (process-count.e2e.ts)\n")]));
    const deadline = Date.now() + 90_000;

    while (reloaded === undefined && Date.now() < deadline) {
      await post("/admin/sign-in/password", { username: unknownName(99), password: "not the password at all" });
      reloaded = entries().slice(before.length).find((event) => event.entryModule !== last?.entryModule);

      if (reloaded === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  } finally {
    writeFileSync(target, original);
  }

  expect(digest(readFileSync(target)), "the handler module is restored byte for byte").toBe(digest(original));

  evidence(
    reloaded === undefined ? "no re-evaluation observed" : `entry module ${String(last?.entryModule)} -> ${String(reloaded.entryModule)}; pid ${String(reloaded.pid)}; runtime ${String(reloaded.runtimeId) === String(last?.runtimeId) ? "same" : "different"}; limiter ${String(reloaded.limiterId) === String(last?.limiterId) ? "same" : "different"}`,
  );
  expect(reloaded, "the touched module was re-evaluated by the development server").toBeDefined();
  expect(reloaded?.pid).toBe(last?.pid);
  expect(reloaded?.runtimeId).toBe(last?.runtimeId);
  expect(reloaded?.limiterId).toBe(last?.limiterId);
  expect(diagnostics(state).filter((event) => event.event === "runtime-created")).toHaveLength(1);
});

test("capacity corroborates one 2-running, 8-queued limiter (not an exact count)", async () => {
  const answers = await Promise.all(Array.from({ length: 16 }, (_, i) => post("/admin/sign-in/password", { username: unknownName(100 + i), password: "not the password at all" })));
  const overloaded = answers.filter((answer) => answer.status === 503);
  const generic = answers.filter((answer) => answer.status === 303);

  evidence(`16 concurrent: ${generic.length} generic 303, ${overloaded.length} overloaded 503`);
  expect(generic.length + overloaded.length).toBe(16);
  expect(overloaded.length, "a queue of 8 behind 2 running must overflow under 16 simultaneous verifications").toBeGreaterThan(0);
  expect(generic.length, "one limiter admits at least its 10 places").toBeGreaterThanOrEqual(10);

  for (const answer of overloaded) {
    expect(answer.headers["retry-after"]).toBe("5");
  }
});

test("the D-17 bound holds through the real server, counted from completed accounting events", async () => {
  const account = provisionAccount(state);
  const wrong = { username: account.username, password: "definitely not this account's password" };
  const outcomes = () => diagnostics(state).filter((event) => event.event === "password-outcome");
  // Only this test's events count: everything before this index belongs to earlier tests.
  const start = outcomes().length;

  // Four username failures (a wait starts at the 5th), then fifteen more source failures: 19 of 20.
  for (let i = 0; i < 4; i += 1) {
    expect((await post("/admin/sign-in/password", wrong)).status).toBe(303);
  }

  for (let i = 0; i < 15; i += 1) {
    expect((await post("/admin/sign-in/password", { username: unknownName(200 + i), password: "not the password at all" })).status).toBe(303);
  }

  // Exactly the 19 preloading requests completed, each as a committed failure, before the batch.
  const preloaded = outcomes().slice(start);
  expect(preloaded.map((event) => event.code), "exactly 19 new completed failures before the concurrent batch").toEqual(Array.from({ length: 19 }, () => "FAILED"));
  const marker = outcomes().length;
  await Promise.all(Array.from({ length: 10 }, () => post("/admin/sign-in/password", wrong)));

  const concurrent = outcomes().slice(marker);
  const failed = concurrent.filter((event) => event.code === "FAILED").length;
  const throttled = concurrent.filter((event) => event.code === "THROTTLED").length;

  // Independent evidence: the username counter is a plain integer (no rolling cap below 100).
  const digest = keyedDigestOf(state.throttleKey, "password-username", account.username);
  const row = await withPool(state.connectionString, (pool) =>
    pool.query<{ consecutive_failures: number }>(
      "select consecutive_failures from authentication_throttle where scope = 'password' and subject_digest = $1",
      [digest],
    ),
  );
  const consecutive = row.rows[0]?.consecutive_failures ?? 0;

  evidence(
    `P=1. Source: ${preloaded.length} committed before (all new in this test), ${failed} committed concurrently (${19 + failed} total; limit 20, bound 20 + 2P = 22). Username: ${consecutive} consecutive (wait threshold 5, bound 5 + 2P - 1 = 6). Concurrent outcomes: ${failed} FAILED, ${throttled} THROTTLED, ${concurrent.length - failed - throttled} other.`,
  );
  expect(concurrent).toHaveLength(10);
  expect(failed).toBeGreaterThanOrEqual(1);
  expect(19 + failed, "per-source bound: at most 2P beyond the limit").toBeLessThanOrEqual(22);
  expect(consecutive, "per-username bound: at most 2P - 1 beyond the wait threshold").toBeLessThanOrEqual(6);
  expect(consecutive).toBe(4 + failed);
  expect(preloaded).toHaveLength(19);
});
