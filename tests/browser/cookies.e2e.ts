/**
 * `ADR-004` L-3 in real browsers (issue #260 §6.5 L3-1): does each engine store **and send back**
 * a `__Host-` cookie with the production attributes?
 *
 * - Over plain `http://127.0.0.1`, a bare server sets exactly the production attributes. This is
 *   the evidence for the transport rule: the result is recorded per engine, and HTTPS was chosen
 *   because an engine stored the cookie without sending it back (WebKit, in the early probe).
 * - Over the journey's local HTTPS, the real sign-in sets the real session cookie, and a later
 *   `/admin` render proves the engine sent it back.
 *
 * This is local evidence only. It is **not** a browser support claim (`NOQ-6` is undecided), and
 * `ignoreHTTPSErrors` is the automated harness's trust in its own certificate; a person sees the
 * browser's certificate warning instead (§12 qualification 5).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { harnessState, nextCode, provisionAccount, resetThrottles } from "./harness";

const state = harnessState();
const PRODUCTION_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

test("L3-1 over plain HTTP: the production cookie is recorded, not weakened", async ({ page, context, browserName }) => {
  const server = createServer((request, response) => {
    if (request.url === "/set") {
      response.setHeader("Set-Cookie", `__Host-l3-probe=v1; Max-Age=60; ${PRODUCTION_ATTRIBUTES}`);
    }

    response.end(`cookie=${request.headers.cookie ?? ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await page.goto(`${origin}/set`);
    const stored = (await context.cookies(origin)).some((cookie) => cookie.name === "__Host-l3-probe");
    await page.goto(`${origin}/echo`);
    const sentBack = (await page.locator("body").innerText()).includes("__Host-l3-probe=v1");

    console.log(`[evidence] L-3 http://127.0.0.1 ${browserName} ${context.browser()?.version() ?? ""}: ${stored ? "stored" : "not stored"}, ${sentBack ? "sent back" : "not sent back"}`);
    test.info().annotations.push({ type: "L-3 http", description: `${stored ? "stored" : "not stored"}, ${sentBack ? "sent back" : "not sent back"}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("L3-1 over local HTTPS: the real session cookie is stored and sent back", async ({ page, context, browserName }) => {
  await resetThrottles(state.connectionString);
  const account = provisionAccount(state);

  await page.goto(`${state.origin}/admin/sign-in`);
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel(/Six-digit code/).fill(nextCode(account));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);

  const session = (await context.cookies(state.origin)).find((cookie) => cookie.name === "__Host-admin-session");
  await page.goto(`${state.origin}/admin`);
  const sentBack = await page.getByText("Signed in.").isVisible();

  console.log(`[evidence] L-3 ${state.origin.replace(/:\d+$/, ":<port>")} ${browserName} ${context.browser()?.version() ?? ""}: ${session === undefined ? "not stored" : "stored"}, ${sentBack ? "sent back" : "not sent back"}`);
  // Playwright's Windows WebKit build reports SameSite as None in its cookie store; see S-1.
  expect(session).toMatchObject({ secure: true, httpOnly: true, path: "/", domain: "127.0.0.1" });
  expect(sentBack).toBe(true);
});
