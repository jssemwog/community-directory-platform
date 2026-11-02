/**
 * The local administrator journey in real browsers (issue #260 §6.5 and §6.6): sign-in,
 * password-only refusal, protected-page access, logout, cross-site refusal, an unconfirmed
 * factor, keyboard operation and expiry. Every test runs in Chromium, Firefox and WebKit.
 *
 * Expiry is exercised by moving **stored** timestamps in the harness's own database; the running
 * server has no clock hook. Redirect statuses are recorded as the framework actually sends them:
 * the Route Handlers answer `303`, while a page-level `redirect()` answers `307`.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { harnessState, nextCode, provisionAccount, resetThrottles, send, withPool, type SyntheticAccount } from "./harness";

const state = harnessState();
test.use({ baseURL: state.origin });
test.describe.configure({ mode: "serial" });

const SESSION = "__Host-admin-session";
const CHALLENGE = "__Host-admin-challenge";

test.beforeEach(async () => {
  await resetThrottles(state.connectionString);
});

async function enterPassword(page: Page, account: SyntheticAccount, password = account.password): Promise<void> {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function signIn(page: Page, account: SyntheticAccount): Promise<void> {
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
  await page.getByLabel(/Six-digit code/).fill(nextCode(account));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText("Signed in.")).toBeVisible();
}

/** The status of the first response in the redirect chain that led to the current page. */
async function firstStatus(page: Page, path: string): Promise<{ readonly first: number | undefined; readonly final: number | undefined }> {
  const response = await page.goto(path);
  let request = response?.request();

  while (request?.redirectedFrom() !== null && request?.redirectedFrom() !== undefined) {
    request = request.redirectedFrom() ?? undefined;
  }

  return { first: (await request?.response())?.status(), final: response?.status() };
}

const sessionRows = (administratorId: string) =>
  withPool(state.connectionString, async (pool) => (await pool.query("select 1 from administrator_session where administrator_id = $1", [administratorId])).rowCount ?? 0);

test("S-1: password then TOTP signs in, with the production cookie attributes", async ({ page, context, browserName }) => {
  const account = provisionAccount(state);
  const verified = page.waitForResponse((response) => response.url().endsWith("/admin/sign-in/code/verify"));
  await signIn(page, account);

  // What the engine reports the server sent: exactly the production attributes.
  const sent = (await (await verified).headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie")
    // Some engines report several Set-Cookie headers as one newline-joined value.
    .flatMap((header) => header.value.split(String.fromCharCode(10)));
  console.log(`[evidence] S-1 ${browserName} Set-Cookie headers received: ${sent.length}`);
  // Playwright's WebKit exposes no Set-Cookie on this redirect; the exact header is asserted
  // engine-independently at the handler boundary (admin-journey.integration H-4).
  if (browserName !== "webkit" || sent.length > 0) {
    expect(sent.some((value) => new RegExp(`^${SESSION}=[A-Za-z0-9_-]{43}; Max-Age=[0-9]+; Path=/; Secure; HttpOnly; SameSite=Strict$`).test(value))).toBe(true);
  }

  // What the engine reports storing. Playwright's Windows WebKit build reports SameSite as None for
  // this cookie; that report is recorded, not trusted, and cross-site refusal is tested in S-5.
  const session = (await context.cookies()).find((cookie) => cookie.name === SESSION);
  console.log(`[evidence] S-1 ${browserName} cookie store: secure=${String(session?.secure)} httpOnly=${String(session?.httpOnly)} sameSite=${String(session?.sameSite)} path=${String(session?.path)} domain=${String(session?.domain)}`);
  expect(session).toMatchObject({ secure: true, httpOnly: true, path: "/", domain: "127.0.0.1" });
  expect(browserName === "webkit" ? ["Strict", "None"] : ["Strict"]).toContain(session?.sameSite);
  expect((await context.cookies()).some((cookie) => cookie.name === CHALLENGE), "the challenge cookie is cleared").toBe(false);
  expect(await sessionRows(account.administratorId)).toBe(1);
});

test("S-2: a correct password alone grants nothing", async ({ page, context, browserName }) => {
  const account = provisionAccount(state);
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);

  const challenge = (await context.cookies()).find((cookie) => cookie.name === CHALLENGE);
  expect(challenge).toMatchObject({ secure: true, httpOnly: true, path: "/" });
  // Playwright's Windows WebKit build reports SameSite as None in its cookie store; see S-1.
  expect(browserName === "webkit" ? ["Strict", "None"] : ["Strict"]).toContain(challenge?.sameSite);

  const direct = await firstStatus(page, "/admin");
  console.log(`[evidence] password-only /admin: first ${String(direct.first)}, final ${String(direct.final)}`);
  expect(direct.first).toBe(307);
  await expect(page).toHaveURL(/\/admin\/sign-in$/);

  // The challenge token presented as a session token is refused.
  await context.addCookies([{ name: SESSION, value: challenge?.value ?? "", url: state.origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  expect(await sessionRows(account.administratorId)).toBe(0);
});

test("S-3: the protected page is never rendered without a valid session", async ({ page, context }) => {
  for (const value of [undefined, "not-a-token", "A".repeat(43), "x".repeat(200)]) {
    await context.clearCookies();

    if (value !== undefined) {
      await context.addCookies([{ name: SESSION, value, url: state.origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
    }

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/sign-in$/);
    await expect(page.getByText("Signed in.")).toHaveCount(0);
  }
});

test("S-3: a duplicated session cookie is refused at the real /admin page, whichever copy is valid", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  await signIn(page, account);
  const session = (await context.cookies()).find((cookie) => cookie.name === SESSION)?.value ?? "";
  expect(session).not.toBe("");

  const visit = (cookie: string) => send(state, state.certificatePath, "GET", "/admin", { headers: { Cookie: cookie } });
  const single = await visit(`${SESSION}=${session}`);
  expect(single.status, "the control: one valid copy renders").toBe(200);
  expect(single.body).toContain("Signed in.");

  for (const cookie of [
    `${SESSION}=${session}; ${SESSION}=${session}`,
    `${SESSION}=${session}; ${SESSION}=${"A".repeat(43)}`,
    `${SESSION}=${"A".repeat(43)}; ${SESSION}=${session}`,
  ]) {
    const answer = await visit(cookie);
    console.log(`[evidence] duplicate session cookie at /admin: ${answer.status} -> ${String(answer.headers.location)}`);
    expect(answer.status).toBe(307);
    expect(answer.headers.location).toBe("/admin/sign-in");
    expect(answer.body).not.toContain("Signed in.");
  }

  expect(await sessionRows(account.administratorId), "a refused duplicate deletes nothing").toBe(1);
});

test("S-4: logout deletes the session; back, reload and the old cookie all fail", async ({ page, context }) => {
  const account = provisionAccount(state);
  await signIn(page, account);
  const old = (await context.cookies()).find((cookie) => cookie.name === SESSION);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  expect((await context.cookies()).some((cookie) => cookie.name === SESSION)).toBe(false);
  expect(await sessionRows(account.administratorId)).toBe(0);

  await page.goBack();
  await page.reload();
  await expect(page.getByText("Signed in.")).toHaveCount(0);

  await context.addCookies([{ name: SESSION, value: old?.value ?? "", url: state.origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test("S-5: forms posted from another loopback origin are refused and change nothing", async ({ page, context }) => {
  const account = provisionAccount(state);
  await signIn(page, account);

  const attacker = createServer((request, response) => {
    const target = request.url === "/sign-out" ? "/admin/sign-out" : "/admin/sign-in/password";
    const fields = request.url === "/sign-out" ? "" : `<input name="username" value="${account.username}"><input name="password" value="${account.password}">`;
    response.setHeader("Content-Type", "text/html");
    response.end(`<form id="f" method="post" action="${state.origin}${target}">${fields}</form><script>document.getElementById("f").submit()</script>`);
  });
  await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  const attackerOrigin = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}`;

  try {
    for (const path of ["/password", "/sign-out"]) {
      const before = await withPool(state.connectionString, async (pool) => ({
        throttle: (await pool.query("select 1 from authentication_throttle")).rowCount,
        window: (await pool.query("select 1 from authentication_source_window")).rowCount,
        challenges: (await pool.query("select 1 from administrator_pending_challenge")).rowCount,
      }));
      const landed = page.waitForURL((url) => url.origin === state.origin, { timeout: 30_000 });
      await page.goto(`${attackerOrigin}${path}`);
      await landed;

      expect(page.url(), `${path}: refused with the generic answer`).toMatch(/\/admin\/sign-in(\?notice=1)?$/);
      expect(await withPool(state.connectionString, async (pool) => ({
        throttle: (await pool.query("select 1 from authentication_throttle")).rowCount,
        window: (await pool.query("select 1 from authentication_source_window")).rowCount,
        challenges: (await pool.query("select 1 from administrator_pending_challenge")).rowCount,
      }))).toEqual(before);
    }

    // The cross-origin sign-out did not end the session.
    expect(await sessionRows(account.administratorId)).toBe(1);
    await page.goto("/admin");
    await expect(page.getByText("Signed in.")).toBeVisible();
  } finally {
    await new Promise((resolve) => attacker.close(resolve));
    await context.clearCookies();
  }
});

test("S-6: an account whose factor was never confirmed cannot reach the protected page", async ({ page }) => {
  const account = provisionAccount(state, { confirm: false });
  await enterPassword(page, account);
  await page.waitForURL(/\/admin\/sign-in(\/code)?(\?notice=1)?$/);

  if (/\/code$/.test(page.url())) {
    await page.getByLabel(/Six-digit code/).fill(nextCode(account));
    await page.getByRole("button", { name: "Sign in" }).click();
  }

  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  expect(await sessionRows(account.administratorId)).toBe(0);
});

test("S-7: the journey works by keyboard alone, with labelled fields and an announced notice", async ({ page }) => {
  const account = provisionAccount(state);
  await page.goto("/admin/sign-in");

  // A failure first, to see the generic notice announced.
  await page.getByLabel("Username").focus();
  await page.keyboard.type(account.username);
  await page.keyboard.press("Tab");
  await page.keyboard.type("not the right password at all");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?notice=1$/);
  await expect(page.getByRole("alert")).toHaveText(/did not succeed/);

  await page.getByLabel("Username").focus();
  await page.keyboard.type(account.username);
  await page.keyboard.press("Tab");
  await page.keyboard.type(account.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);

  await page.getByLabel(/Six-digit code/).focus();
  await page.keyboard.type(nextCode(account));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Signed in.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

/** Move every stored session instant back by `interval`, keeping the table's activity and lifetime checks true. */
const ageSession = (administratorId: string, interval: string) =>
  withPool(state.connectionString, (pool) =>
    pool.query(
      "update administrator_session set created_at = created_at - $2::interval, last_activity_at = last_activity_at - $2::interval, absolute_expires_at = absolute_expires_at - $2::interval where administrator_id = $1",
      [administratorId, interval],
    ),
  );

test("E-1: an idle session expires after 30 minutes and an active one is extended", async ({ page }) => {
  const account = provisionAccount(state);
  await signIn(page, account);

  // Just inside the idle limit (5 seconds of margin for the two clocks on this machine): it renders,
  // and the check advances the activity time.
  await ageSession(account.administratorId, "29 minutes 55 seconds");
  await page.goto("/admin");
  await expect(page.getByText("Signed in.")).toBeVisible();
  const advanced = await withPool(state.connectionString, async (pool) =>
    (await pool.query<{ idle: boolean }>("select last_activity_at > now() - interval '1 minute' as idle from administrator_session where administrator_id = $1", [account.administratorId])).rows[0]?.idle,
  );
  expect(advanced).toBe(true);

  await ageSession(account.administratorId, "30 minutes 5 seconds");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test("E-2: a session past its 12-hour absolute lifetime is refused despite fresh activity", async ({ page }) => {
  const account = provisionAccount(state);
  await signIn(page, account);

  // Twelve hours and five seconds old, with activity moved back to just now.
  await ageSession(account.administratorId, "12 hours 5 seconds");
  await withPool(state.connectionString, (pool) =>
    pool.query("update administrator_session set last_activity_at = now() - interval '1 second' where administrator_id = $1", [account.administratorId]),
  );
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test("E-3: a challenge older than 5 minutes refuses even a correct code", async ({ page }) => {
  const account = provisionAccount(state);
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);

  await withPool(state.connectionString, (pool) =>
    pool.query(
      "update administrator_pending_challenge set created_at = now() - interval '5 minutes 10 seconds', expires_at = now() - interval '10 seconds' where administrator_id = $1",
      [account.administratorId],
    ),
  );
  await page.getByLabel(/Six-digit code/).fill(nextCode(account));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await sessionRows(account.administratorId)).toBe(0);
});
