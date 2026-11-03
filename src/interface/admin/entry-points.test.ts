/**
 * The entry points at the handler boundary, without a database (issue #260 §6.1 G-2 and R-1, §12
 * qualifications 6 and 8). A closed gate gives one uniform refusal for every entry point, method
 * and input; within the gate, a refused request reaches no storage, and an unsupported method
 * answers `405` instead of the framework's automatic one.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_DEMO_DATABASE_URL } from "../public/local-demo-persistence";
import { resetAdministratorRuntimeForTests, type RuntimeFactories } from "./authentication-runtime";
import { closedGateResponse, codeEntry, FAILURE_LOCATION, passwordEntry, signOutEntry, unsupportedEntry, type EntryOptions } from "./entry-points";
import { LOCAL_ADMIN_ORIGIN, LOCAL_ADMIN_THROTTLE_KEY, LOCAL_ADMIN_TOTP_KEY_V1 } from "./local-gate";

const ORIGIN = "https://127.0.0.1:3000";
const environment = {
  NODE_ENV: "development",
  [LOCAL_DEMO_DATABASE_URL]: "postgresql://demo:canary-db-password@127.0.0.1:54329/demo",
  [LOCAL_ADMIN_ORIGIN]: ORIGIN,
  [LOCAL_ADMIN_TOTP_KEY_V1]: randomBytes(32).toString("base64url"),
  [LOCAL_ADMIN_THROTTLE_KEY]: randomBytes(32).toString("base64url"),
};

/** Factories that fail the test if anything reaches the runtime. */
function forbiddenFactories(): { readonly factories: RuntimeFactories; readonly touched: () => boolean } {
  let touched = false;
  const fail = () => {
    touched = true;
    throw new Error("the runtime must not be reached");
  };

  return { factories: { createDatabase: fail, createDummyPasswordHash: fail, createLimiter: fail }, touched: () => touched };
}

function request(method: string, init: { host?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`${ORIGIN}/admin/x`, {
    method,
    headers: {
      Host: init.host ?? "127.0.0.1:3000",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: "__Host-admin-session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-admin-challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ...init.headers,
    },
    body: method === "GET" || method === "HEAD" ? undefined : (init.body ?? "username=synthetic-a&password=x&code=123456"),
  });
}

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

afterEach(async () => {
  await resetAdministratorRuntimeForTests();
});

const HANDLERS = { password: passwordEntry, code: codeEntry, "sign-out": signOutEntry } as const;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

describe("a closed gate (G-2, at the handler boundary)", () => {
  const closedEnvironments: Array<[string, Record<string, string | undefined>, string]> = [
    ["production mode", { ...environment, NODE_ENV: "production" }, "127.0.0.1:3000"],
    ["no launcher environment", { NODE_ENV: "development" }, "127.0.0.1:3000"],
    ["a non-canonical Host", environment, "localhost:3000"],
    ["a LAN Host", environment, "192.168.1.20:3000"],
  ];

  it.each(closedEnvironments)("gives the one uniform refusal for every handler and method: %s", async (_label, env, host) => {
    const { factories, touched } = forbiddenFactories();
    const options: EntryOptions = { environment: env, factories, log: () => undefined };
    const expected = await snapshot(closedGateResponse());

    for (const method of METHODS) {
      for (const handler of Object.values(HANDLERS)) {
        const answer = method === "POST" ? await handler(request(method, { host }), options) : unsupportedEntry(request(method, { host }), options);
        expect(await snapshot(answer), `${method}`).toEqual(expected);
      }
    }

    expect(expected).toMatchObject({ status: 404, body: "Not Found" });
    expect(JSON.stringify(expected)).not.toMatch(/canary|127\.0\.0\.1|Allow/i);
    expect(touched()).toBe(false);
  });
});

describe("within the gate", () => {
  it("answers an unsupported method with 405 and Allow: POST, never reaching the runtime", async () => {
    const { factories, touched } = forbiddenFactories();
    const answer = unsupportedEntry(request("PUT"), { environment, factories });

    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(touched()).toBe(false);
  });

  it.each(Object.entries(HANDLERS))("R-1: %s refuses a cross-origin request generically, before any storage call", async (_name, handler) => {
    const { factories, touched } = forbiddenFactories();
    const lines: string[] = [];
    const answer = await handler(request("POST", { headers: { Origin: "https://127.0.0.1:3001", "Sec-Fetch-Site": "same-site" } }), {
      environment,
      factories,
      log: (line) => lines.push(line),
    });

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(FAILURE_LOCATION);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(touched()).toBe(false);
    expect(lines.map((line) => JSON.parse(line) as Record<string, string>).map((entry) => entry.outcome)).toEqual(["REQUEST_REFUSED"]);
  });

  it.each(Object.entries(HANDLERS))("R-1: %s turns a failing request body into the generic refusal, never reaching the runtime", async (_name, handler) => {
    const { factories, touched } = forbiddenFactories();
    const lines: string[] = [];
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("aborted upload")); } }, { highWaterMark: 0 });
    const failing = new Request(`${ORIGIN}/admin/x`, {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3000",
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "__Host-admin-session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-admin-challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      body,
      duplex: "half",
    } as RequestInit);
    const answer = await handler(failing, { environment, factories, log: (line) => lines.push(line) });

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(FAILURE_LOCATION);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(failing.body?.locked).toBe(false);
    expect(touched()).toBe(false);
    expect(lines.map((line) => (JSON.parse(line) as Record<string, string>).outcome)).toEqual(["REQUEST_REFUSED"]);
  });

  it("sign-out with a session cookie but no runtime is not presented as completed, and keeps the cookie", async () => {
    const { factories, touched } = forbiddenFactories();
    const lines: string[] = [];
    const answer = await signOutEntry(request("POST", { body: "" }), { environment, factories, log: (line) => lines.push(line) });

    expect(answer.status).toBe(503);
    expect(answer.headers.get("location")).toBeNull();
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(answer.headers.get("retry-after")).toBe("5");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.text()).toMatch(/did not complete/);
    expect(touched()).toBe(true);
    expect(lines.map((line) => (JSON.parse(line) as Record<string, string>).outcome)).toEqual(["RUNTIME_UNAVAILABLE"]);
  });

  it("sign-out without a session cookie clears the cookie and touches no storage", async () => {
    const { factories, touched } = forbiddenFactories();
    const answer = await signOutEntry(request("POST", { headers: { Cookie: "" }, body: "" }), { environment, factories, log: () => undefined });

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/admin/sign-in");
    expect(answer.headers.get("set-cookie")).toBe("__Host-admin-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict");
    expect(touched()).toBe(false);
  });
});
