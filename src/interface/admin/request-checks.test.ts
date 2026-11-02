/**
 * The request checks every state-changing administrator request passes before any storage call
 * (issue #260 §6.1 R-1 and R-2; OD-5).
 */

import { describe, expect, it } from "vitest";

import { checkForm, MAX_FORM_BYTES, originAllowed } from "./request-checks";

const ORIGIN = "https://127.0.0.1:3000";
const FIELDS = ["username", "password"];

function request(init: { headers?: Record<string, string>; body?: string; method?: string } = {}): Request {
  return new Request(`${ORIGIN}/admin/sign-in/password`, {
    method: init.method ?? "POST",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      ...init.headers,
    },
    body: init.method === "GET" ? undefined : (init.body ?? "username=synthetic-a&password=correct%20horse%20battery"),
  });
}

describe("checkForm", () => {
  it("R-2: accepts a well-formed same-origin form and returns exactly its fields", async () => {
    const checked = await checkForm(request(), ORIGIN, FIELDS);
    expect(checked.ok).toBe(true);
    expect(checked.ok && Object.fromEntries(checked.fields)).toEqual({ username: "synthetic-a", password: "correct horse battery" });
  });

  it("accepts a form without Sec-Fetch-Site, and one declaring UTF-8", async () => {
    const without = new Request(`${ORIGIN}/x`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: "username=a&password=b" });
    expect((await checkForm(without, ORIGIN, FIELDS)).ok).toBe(true);
  });

  it.each([
    ["a missing Origin", { headers: { Origin: "" } }],
    ["the literal null Origin", { headers: { Origin: "null" } }],
    ["an http Origin", { headers: { Origin: "http://127.0.0.1:3000" } }],
    ["another port", { headers: { Origin: "https://127.0.0.1:3001" } }],
    ["localhost", { headers: { Origin: "https://localhost:3000" } }],
    ["a trailing slash", { headers: { Origin: `${ORIGIN}/` } }],
    ["Sec-Fetch-Site same-site", { headers: { "Sec-Fetch-Site": "same-site" } }],
    ["Sec-Fetch-Site cross-site", { headers: { "Sec-Fetch-Site": "cross-site" } }],
    ["Sec-Fetch-Site none", { headers: { "Sec-Fetch-Site": "none" } }],
    ["JSON", { headers: { "Content-Type": "application/json" } }],
    ["multipart", { headers: { "Content-Type": "multipart/form-data; boundary=x" } }],
    ["plain text", { headers: { "Content-Type": "text/plain" } }],
    ["another charset", { headers: { "Content-Type": "application/x-www-form-urlencoded; charset=latin1" } }],
    ["a missing field", { body: "username=a" }],
    ["a duplicated field", { body: "username=a&username=b&password=c" }],
    ["an extra field", { body: "username=a&password=b&role=admin" }],
    ["a body over the limit", { body: `username=a&password=${"x".repeat(MAX_FORM_BYTES)}` }],
  ])("R-1: refuses %s", async (_label, change) => {
    const headers = { ...(change as { headers?: Record<string, string> }).headers };
    const built = request({ ...(change as object), headers });

    if (headers.Origin === "") {
      built.headers.delete("origin");
    }

    expect(await checkForm(built, ORIGIN, FIELDS)).toEqual({ ok: false });
  });

  it("R-1: refuses a declared length over the limit without reading the body", async () => {
    let pulled = false;
    // A zero high-water mark, so the stream is pulled only if the checks read it.
    const body = new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 });
    const oversize = new Request(`${ORIGIN}/x`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(MAX_FORM_BYTES + 1) },
      body,
      duplex: "half",
    } as RequestInit);

    expect(await checkForm(oversize, ORIGIN, FIELDS)).toEqual({ ok: false });
    expect(pulled).toBe(false);
  });

  it.each([
    ["a body that errors while being read", () => new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("connection reset")); } }, { highWaterMark: 0 })],
    ["a body that errors after a first chunk", () => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new Error("aborted upload"));
          } else {
            sent = true;
            controller.enqueue(new TextEncoder().encode("username=a&"));
          }
        },
      }, { highWaterMark: 0 });
    }],
    ["an oversized body whose cancellation fails", () => new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_FORM_BYTES + 1)); },
      cancel() { throw new Error("cancel failed"); },
    }, { highWaterMark: 0 })],
  ])("R-1: refuses %s, without throwing, and releases the reader", async (_label, makeBody) => {
    const body = makeBody();
    const failing = new Request(`${ORIGIN}/x`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);

    await expect(checkForm(failing, ORIGIN, FIELDS)).resolves.toEqual({ ok: false });
    expect(failing.body?.locked).toBe(false);
  });

  it("R-1: refuses a method other than POST", async () => {
    expect(await checkForm(request({ method: "PUT" }), ORIGIN, FIELDS)).toEqual({ ok: false });
  });

  it("refuses a body that is not valid UTF-8", async () => {
    const invalid = new Request(`${ORIGIN}/x`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new Uint8Array([0x75, 0x3d, 0xff, 0xfe]) });
    expect(await checkForm(invalid, ORIGIN, ["u"])).toEqual({ ok: false });
  });

  it("accepts an empty form when no field is expected (sign-out)", async () => {
    expect(await checkForm(request({ body: "" }), ORIGIN, [])).toEqual({ ok: true, fields: new Map() });
  });
});

describe("originAllowed", () => {
  it("requires the exact Origin and a same-origin fetch, when declared", () => {
    expect(originAllowed(request(), ORIGIN)).toBe(true);
    expect(originAllowed(request({ headers: { "Sec-Fetch-Site": "cross-site" } }), ORIGIN)).toBe(false);
  });
});
