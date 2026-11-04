/**
 * The recovery handler bodies without a database (issue #268 §6.1, §6.2 H-R1 and H-R2 in part). A
 * closed gate gives the one uniform refusal; within the gate, every class A refusal reaches no
 * runtime and sends no `Set-Cookie`; a missing credential cookie is refused before any storage.
 * The database cases are in `recovery-journey.integration.test.ts`.
 */

import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_DEMO_DATABASE_URL } from "../public/local-demo-persistence";
import { resetAdministratorRuntimeForTests, type RuntimeFactories } from "./authentication-runtime";
import { closedGateResponse, FAILURE_LOCATION, unsupportedEntry, type EntryOptions } from "./entry-points";
import { LOCAL_ADMIN_ORIGIN, LOCAL_ADMIN_THROTTLE_KEY, LOCAL_ADMIN_TOTP_KEY_V1 } from "./local-gate";
import {
  RECOVERY_NOTICE_LOCATION,
  recoveryCodeEntry,
  recoveryCodesEntry,
  recoveryCompleteEntry,
  recoverySignOutEntry,
  recoveryStartEntry,
} from "./recovery-entry-points";

const ORIGIN = "https://127.0.0.1:3000";
const TOKEN = randomBytes(32).toString("base64url");
const environment = {
  NODE_ENV: "development",
  [LOCAL_DEMO_DATABASE_URL]: "postgresql://demo:canary-db-password@127.0.0.1:54329/demo",
  [LOCAL_ADMIN_ORIGIN]: ORIGIN,
  [LOCAL_ADMIN_TOTP_KEY_V1]: randomBytes(32).toString("base64url"),
  [LOCAL_ADMIN_THROTTLE_KEY]: randomBytes(32).toString("base64url"),
};

function forbiddenFactories(): { readonly factories: RuntimeFactories; readonly touched: () => boolean } {
  let touched = false;
  const fail = () => {
    touched = true;
    throw new Error("the runtime must not be reached");
  };

  return { factories: { createDatabase: fail, createDummyPasswordHash: fail, createLimiter: fail }, touched: () => touched };
}

const COOKIES = `__Host-admin-challenge=${TOKEN}; __Host-admin-recovery=${TOKEN}; __Host-admin-session=${TOKEN}`;

function request(method: string, init: { host?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`${ORIGIN}/admin/recovery/x`, {
    method,
    headers: {
      Host: init.host ?? "127.0.0.1:3000",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: COOKIES,
      ...init.headers,
    },
    body: method === "GET" || method === "HEAD" ? undefined : init.body,
  });
}

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

afterEach(async () => {
  await resetAdministratorRuntimeForTests();
});

/** Each entry, its exact field list, a valid body, and its class A location (RJ-D13). */
const ENTRIES = {
  "recovery-code": { handler: recoveryCodeEntry, body: "code=00112233-44556677-8899aabb-ccddeeff", refused: FAILURE_LOCATION },
  "recovery-start": { handler: recoveryStartEntry, body: "", refused: RECOVERY_NOTICE_LOCATION },
  "recovery-complete": { handler: recoveryCompleteEntry, body: "factor_id=0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b&code=123456", refused: RECOVERY_NOTICE_LOCATION },
  "recovery-codes": { handler: recoveryCodesEntry, body: "", refused: RECOVERY_NOTICE_LOCATION },
  "recovery-sign-out": { handler: recoverySignOutEntry, body: "", refused: FAILURE_LOCATION },
} as const;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

describe("H-R1: a closed gate, at the handler boundary", () => {
  it.each([
    ["production mode", { ...environment, NODE_ENV: "production" }, "127.0.0.1:3000"],
    ["no launcher environment", { NODE_ENV: "development" }, "127.0.0.1:3000"],
    ["a non-canonical Host", environment, "localhost:3000"],
  ] as const)("gives the one uniform refusal for every entry and method: %s", async (_label, env, host) => {
    const { factories, touched } = forbiddenFactories();
    const options: EntryOptions = { environment: env, factories, log: () => undefined };
    const expected = await snapshot(closedGateResponse());

    for (const method of METHODS) {
      for (const { handler, body } of Object.values(ENTRIES)) {
        const answer = method === "POST" ? await handler(request(method, { host, body }), options) : unsupportedEntry(request(method, { host }), options);
        expect(await snapshot(answer), method).toEqual(expected);
      }
    }

    expect(touched()).toBe(false);
  });

  it("within the gate, an unsupported method gets 405 with Allow: POST, no Set-Cookie and no runtime", async () => {
    const { factories, touched } = forbiddenFactories();
    const answer = unsupportedEntry(request("PUT"), { environment, factories });

    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(touched()).toBe(false);
  });
});

describe("H-R2 (no database): every class A refusal reaches no runtime and sends no Set-Cookie", () => {
  const attacks: Array<[string, (body: string) => { headers?: Record<string, string>; body?: string }]> = [
    ["a foreign Origin", (body) => ({ headers: { Origin: "https://127.0.0.1:3001" }, body })],
    ["a missing Origin", (body) => ({ headers: { Origin: "" }, body })],
    ["Sec-Fetch-Site: cross-site", (body) => ({ headers: { "Sec-Fetch-Site": "cross-site" }, body })],
    ["Sec-Fetch-Site: same-site", (body) => ({ headers: { "Sec-Fetch-Site": "same-site" }, body })],
    ["a wrong content type", (body) => ({ headers: { "Content-Type": "text/plain" }, body })],
    ["an over-long body", () => ({ body: `code=${"a".repeat(5000)}` })],
    ["an over-long declared length", (body) => ({ headers: { "Content-Length": "5000" }, body })],
    ["an extra field", (body) => ({ body: body === "" ? "extra=1" : `${body}&extra=1` })],
    ["a duplicated field", (body) => ({ body: body === "" ? "x=1&x=1" : `${body}&${body}` })],
  ];

  for (const [name, entry] of Object.entries(ENTRIES)) {
    it.each(attacks)(`${name}: %s`, async (_label, attack) => {
      const { factories, touched } = forbiddenFactories();
      const lines: string[] = [];
      const shaped = attack(entry.body);
      const answer = await entry.handler(request("POST", shaped), { environment, factories, log: (line) => lines.push(line) });

      expect(answer.status).toBe(303);
      expect(answer.headers.get("location")).toBe(entry.refused);
      expect(answer.headers.getSetCookie()).toEqual([]);
      expect(touched()).toBe(false);
      expect(lines.map((line) => (JSON.parse(line) as Record<string, string>).outcome)).toEqual(["REQUEST_REFUSED"]);
    });
  }

  it.each(Object.entries(ENTRIES))("%s: a missing field is a class A refusal, where it has a field", async (_name, entry) => {
    if (entry.body === "") {
      return;
    }

    const { factories, touched } = forbiddenFactories();
    const answer = await entry.handler(request("POST", { body: "" }), { environment, factories, log: () => undefined });
    expect(answer.headers.get("location")).toBe(entry.refused);
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(touched()).toBe(false);
  });
});

describe("class B without a usable credential cookie: refused before any storage", () => {
  it("recovery-code with no challenge cookie clears only the challenge cookie", async () => {
    const { factories, touched } = forbiddenFactories();
    const answer = await recoveryCodeEntry(request("POST", { headers: { Cookie: "" }, body: ENTRIES["recovery-code"].body }), { environment, factories, log: () => undefined });

    expect(answer.headers.get("location")).toBe(FAILURE_LOCATION);
    expect(answer.headers.getSetCookie()).toEqual(["__Host-admin-challenge=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict"]);
    expect(touched()).toBe(false);
  });

  it.each(["recovery-start", "recovery-complete", "recovery-codes"] as const)("%s with an absent or duplicated recovery cookie goes to sign-in, clearing it", async (name) => {
    for (const cookie of ["", `__Host-admin-recovery=${TOKEN}; __Host-admin-recovery=${TOKEN}`]) {
      const { factories, touched } = forbiddenFactories();
      const answer = await ENTRIES[name].handler(request("POST", { headers: { Cookie: cookie }, body: ENTRIES[name].body }), { environment, factories, log: () => undefined });

      expect(answer.headers.get("location")).toBe(FAILURE_LOCATION);
      expect(answer.headers.getSetCookie()).toEqual(["__Host-admin-recovery=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict"]);
      expect(touched()).toBe(false);
    }
  });

  it("recovery-sign-out with an absent, malformed or duplicated cookie gives the completed answer, touching no storage", async () => {
    const answers = [];

    for (const cookie of ["", "__Host-admin-recovery=not-a-token", `__Host-admin-recovery=${TOKEN}; __Host-admin-recovery=${TOKEN}`]) {
      const { factories, touched } = forbiddenFactories();
      answers.push(await snapshot(await recoverySignOutEntry(request("POST", { headers: { Cookie: cookie }, body: "" }), { environment, factories, log: () => undefined })));
      expect(touched()).toBe(false);
    }

    expect(answers[0]).toEqual({
      status: 303,
      headers: [["cache-control", "no-store"], ["location", "/admin/sign-in"], ["set-cookie", "__Host-admin-recovery=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict"]],
      body: "",
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("recovery-sign-out with a runtime failure gives 503, keeping the cookie", async () => {
    const { factories } = forbiddenFactories();
    const answer = await recoverySignOutEntry(request("POST", { body: "" }), { environment, factories, log: () => undefined });

    expect(answer.status).toBe(503);
    expect(answer.headers.get("retry-after")).toBe("5");
    expect(answer.headers.getSetCookie()).toEqual([]);
  });
});
