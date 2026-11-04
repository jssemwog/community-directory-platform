/**
 * The local recovery journey through the real server (issue #268 §6.3 P-R2 to P-R5, and §6.5 R-1
 * to R-8).
 *
 * - **P-R tests** send raw HTTPS requests to the harness's running `next dev` server, with real
 *   cookies, because only the real server shows what Next.js does at a page boundary. They are
 *   engine-independent, so they run once, on chromium. P-R1 (the closed gate) and P-R6 (the build
 *   and file lists) are in `gate.e2e.ts`, through the harness's shared path lists.
 * - **R tests** drive the journey in Chromium, Firefox and WebKit.
 *
 * Expiry is exercised by moving stored timestamps in the harness's own database. Redirect statuses
 * are as the framework sends them: Route Handlers answer `303`, a page-level `redirect()` `307`.
 * **Nothing here claims** back/forward-cache behaviour, resubmission prompts, or what a browser does
 * with a response cut off by a network failure (issue #268 §11).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { codeAt, harnessState, nextCode, provisionAccount, resetThrottles, send, withPool, type Answer, type SyntheticAccount } from "./harness";

const state = harnessState();
test.use({ baseURL: state.origin });
test.describe.configure({ mode: "serial" });

const SESSION = "__Host-admin-session";
const CHALLENGE = "__Host-admin-challenge";
const RECOVERY = "__Host-admin-recovery";
const NEW_HANDLERS = [
  "/admin/sign-in/recovery/verify",
  "/admin/recovery/reenrolment/start",
  "/admin/recovery/reenrolment/complete",
  "/admin/recovery/codes",
  "/admin/recovery/sign-out",
] as const;

test.beforeEach(async () => {
  await resetThrottles(state.connectionString);
});

/* ------------------------------------------------------------------------------------------- */
/* Raw HTTPS helpers (the real server, no browser)                                             */
/* ------------------------------------------------------------------------------------------- */

const formHeaders = (cookie?: string): Record<string, string> => ({
  Origin: state.origin,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/x-www-form-urlencoded",
  ...(cookie === undefined ? {} : { Cookie: cookie }),
});
const post = (path: string, fields: Record<string, string>, cookie?: string): Promise<Answer> =>
  send(state, state.certificatePath, "POST", path, { headers: formHeaders(cookie), body: new URLSearchParams(fields).toString() });
const get = (path: string, cookie?: string): Promise<Answer> =>
  send(state, state.certificatePath, "GET", path, { headers: cookie === undefined ? {} : { Cookie: cookie } });

/** `name=value` of a cookie the answer sets (not clears). */
function cookieFrom(answer: Answer, name: string): string {
  const values = ([] as string[]).concat(answer.headers["set-cookie"] ?? []);
  return values.find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(";")[0] ?? "";
}

const valueOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

async function rawChallenge(account: SyntheticAccount): Promise<string> {
  const challenge = cookieFrom(await post("/admin/sign-in/password", { username: account.username, password: account.password }), CHALLENGE);
  expect(challenge, "the password step issued a challenge").not.toBe("");
  return challenge;
}

async function rawRecovery(account: SyntheticAccount, code: string): Promise<string> {
  const recovery = cookieFrom(await post("/admin/sign-in/recovery/verify", { code }, await rawChallenge(account)), RECOVERY);
  expect(recovery, "the recovery code opened a recovery session").not.toBe("");
  return recovery;
}

async function rawAdministrator(account: SyntheticAccount): Promise<string> {
  const session = cookieFrom(await post("/admin/sign-in/code/verify", { code: nextCode(account) }, await rawChallenge(account)), SESSION);
  expect(session, "password plus TOTP issued an administrator session").not.toBe("");
  return session;
}

const ageSessions = (administratorId: string, minutes: number) =>
  withPool(state.connectionString, (pool) =>
    pool.query(
      "update administrator_session set created_at = created_at - make_interval(mins => $2), last_activity_at = last_activity_at - make_interval(mins => $2), absolute_expires_at = absolute_expires_at - make_interval(mins => $2) where administrator_id = $1",
      [administratorId, minutes],
    ),
  );
const sessionRows = (administratorId: string) =>
  withPool(state.connectionString, async (pool) => (await pool.query("select kind from administrator_session where administrator_id = $1", [administratorId])).rows.map((row) => row.kind as string));

/** Every authentication row, as stored text, without session activity (a followed page's check may move it). */
const storedWithoutActivity = () =>
  withPool(state.connectionString, async (pool) => {
    const out: Record<string, string[]> = {};
    for (const table of ["administrator", "administrator_totp_factor", "administrator_session", "administrator_pending_challenge", "administrator_consumed_challenge", "administrator_recovery_code", "authentication_throttle", "authentication_source_window"]) {
      out[table] = (await pool.query(`select (row_to_json(t)::jsonb - 'last_activity_at')::text as r from ${table} t`)).rows.map((row) => row.r as string).sort();
    }
    return out;
  });

/* ------------------------------------------------------------------------------------------- */
/* Browser helpers                                                                              */
/* ------------------------------------------------------------------------------------------- */

async function enterPassword(page: Page, account: SyntheticAccount): Promise<void> {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
}

async function useRecoveryCode(page: Page, account: SyntheticAccount, code: string): Promise<void> {
  await enterPassword(page, account);
  await page.getByRole("link", { name: "Use a recovery code instead" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in\/recovery$/);
  await page.getByLabel("Recovery code").fill(code);
  await page.getByRole("button", { name: "Use recovery code" }).click();
  await expect(page).toHaveURL(/\/admin\/recovery$/);
  await expect(page.getByRole("heading", { name: "Recovery session", exact: true })).toBeVisible();
}

async function signInWithTotp(page: Page, account: SyntheticAccount, secretBase32: string): Promise<void> {
  await enterPassword(page, account);
  await page.getByLabel(/Six-digit code from your authenticator app/).fill(nextCode({ secretBase32 }));
  await page.getByRole("button", { name: "Sign in" }).click();
}

const recoveryCookie = async (context: BrowserContext) => (await context.cookies()).find((cookie) => cookie.name === RECOVERY);
const secretOn = (page: Page) => page.locator("p", { hasText: "Secret (base32):" }).locator("code").innerText();
const codesOn = (page: Page) => page.locator("li code").allInnerTexts();
const wrongCode = (secretBase32: string) => String((Number(codeAt({ secretBase32 }, Date.now())) + 500_000) % 1_000_000).padStart(6, "0");

/* ------------------------------------------------------------------------------------------- */
/* P-R: the real server's pages and methods (engine-independent)                                */
/* ------------------------------------------------------------------------------------------- */

test("P-R2: with the gate open, every non-POST method on each recovery handler gets 405 with Allow: POST", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");

  for (const path of NEW_HANDLERS) {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const answer = await send(state, state.certificatePath, method, path, { headers: { Origin: state.origin } });
      expect(answer.status, `${method} ${path}`).toBe(405);
      expect(answer.headers.allow, `${method} ${path}`).toBe("POST");
      expect(answer.headers["set-cookie"], `${method} ${path}`).toBeUndefined();
    }
  }
});

test("P-R3: the recovery-code page and the recovery page render only with their cookie, and refuse every other", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);

  const noChallenge = await get("/admin/sign-in/recovery");
  expect(noChallenge.status).toBe(307);
  expect(noChallenge.headers.location).toBe("/admin/sign-in");
  const withChallenge = await get("/admin/sign-in/recovery", `${CHALLENGE}=${"A".repeat(43)}`);
  expect(withChallenge.status, "only presence is checked when rendering").toBe(200);
  expect(withChallenge.body).toContain("Recovery code");

  const live = await rawRecovery(account, account.recoveryCodes[0] ?? "");
  const rendered = await get("/admin/recovery", live);
  expect(rendered.status).toBe(200);
  for (const text of ["Recovery session", "not administrator access", "Set up a new authenticator", "Replace recovery codes", "End recovery session", "A secret shown earlier will stop working", "This replaces every recovery code"]) {
    expect(rendered.body, text).toContain(text);
  }
  expect(rendered.body).not.toContain(account.username);
  expect(rendered.body).not.toContain(account.administratorId);

  const administrator = await rawAdministrator(provisionAccount(state));
  const expiredAccount = provisionAccount(state);
  const expired = await rawRecovery(expiredAccount, expiredAccount.recoveryCodes[0] ?? "");
  await ageSessions(expiredAccount.administratorId, 20);

  for (const [label, cookie] of [
    ["no cookie", undefined],
    ["an unknown token", `${RECOVERY}=${"A".repeat(43)}`],
    ["an expired session", expired],
    ["an administrator-kind token", `${RECOVERY}=${valueOf(administrator)}`],
    ["a duplicated cookie, valid first", `${live}; ${RECOVERY}=${"A".repeat(43)}`],
    ["a duplicated cookie, valid second", `${RECOVERY}=${"A".repeat(43)}; ${live}`],
  ] as const) {
    const answer = await get("/admin/recovery", cookie);
    console.log(`[evidence] /admin/recovery with ${label}: ${answer.status} -> ${String(answer.headers.location)}`);
    expect(answer.status, label).toBe(307);
    expect(answer.headers.location, label).toBe("/admin/sign-in");
    expect(answer.body, label).not.toContain("End recovery session");
  }

  expect(await sessionRows(account.administratorId), "a refused duplicate deletes nothing").toEqual(["recovery"]);
});

test("P-R4: BI-5 at the real /admin page: a recovery session is never administrator access", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  const recovery = await rawRecovery(account, account.recoveryCodes[0] ?? "");
  const administrator = await rawAdministrator(provisionAccount(state));

  for (const [label, cookie] of [
    ["the recovery token as the session cookie", `${SESSION}=${valueOf(recovery)}`],
    ["the recovery cookie alone", recovery],
    ["both cookies, crossed", `${SESSION}=${valueOf(recovery)}; ${RECOVERY}=${valueOf(administrator)}`],
  ] as const) {
    const answer = await get("/admin", cookie);
    console.log(`[evidence] /admin with ${label}: ${answer.status}`);
    expect(answer.status, label).toBe(307);
    expect(answer.headers.location, label).toBe("/admin/sign-in");
    expect(answer.body, label).not.toContain("Signed in.");
  }

  const control = await get("/admin", administrator);
  expect(control.status, "the control: a real administrator session renders").toBe(200);
});

test("P-R5: every display-once document is no-store with the Proxy headers; the new pages carry the observed development Cache-Control (proposed exception)", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  const recovery = await rawRecovery(account, account.recoveryCodes[0] ?? "");
  const PROXY = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "referrer-policy": "same-origin" } as const;
  const record = (label: string, answer: Answer) =>
    console.log(
      `[evidence] P-R5 ${label}: ${answer.status}; Cache-Control: ${String(answer.headers["cache-control"])}; X-Frame-Options: ${String(answer.headers["x-frame-options"])}; Content-Security-Policy: ${String(answer.headers["content-security-policy"])}; Referrer-Policy: ${String(answer.headers["referrer-policy"])}`,
    );

  // The pages (GET). The existing sign-in page is the control.
  const pages: Array<[string, Answer]> = [
    ["the existing sign-in page (control)", await get("/admin/sign-in")],
    ["the recovery-code page", await get("/admin/sign-in/recovery", `${CHALLENGE}=${"A".repeat(43)}`)],
    ["the recovery page", await get("/admin/recovery", recovery)],
  ];

  // Every display-once document (POST), in an order the one recovery session allows: start,
  // regeneration, a refused completion (retry form), an invalid factor_id (restart only), then the
  // successful completion, which ends the session.
  const start = await post("/admin/recovery/reenrolment/start", {}, recovery);
  const base32 = /Secret \(base32\): <code>([A-Z2-7]+)<\/code>/.exec(start.body)?.[1] ?? "";
  const factorId = /name="factor_id" value="([0-9a-f-]+)"/.exec(start.body)?.[1] ?? "";
  expect(base32, "the start document shows the secret").not.toBe("");
  const right = codeAt({ secretBase32: base32 }, Date.now());
  const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
  const documents: Array<[string, Answer]> = [
    ["the start document", start],
    ["the regeneration document", await post("/admin/recovery/codes", {}, recovery)],
    ["the refused completion (retry form)", await post("/admin/recovery/reenrolment/complete", { factor_id: factorId, code: wrong }, recovery)],
    ["the invalid-UUID completion (restart only)", await post("/admin/recovery/reenrolment/complete", { factor_id: "not-a-uuid", code: right }, recovery)],
    ["the successful completion", await post("/admin/recovery/reenrolment/complete", { factor_id: factorId, code: right }, recovery)],
  ];

  for (const [label, answer] of [...pages, ...documents]) {
    record(label, answer);
  }

  // Each display-once document: 200 and all four exact headers.
  for (const [label, answer] of documents) {
    expect(answer.status, label).toBe(200);
    expect(answer.headers["cache-control"], label).toBe("no-store");
    for (const [name, value] of Object.entries(PROXY)) {
      expect(answer.headers[name], `${label}: ${name}`).toBe(value);
    }
  }

  // The documents are the ones intended.
  expect(documents[1]?.[1].body).toContain("New recovery codes");
  expect(documents[2]?.[1].body).toContain("Code not accepted");
  expect(documents[2]?.[1].body).toContain(`name="factor_id" value="${factorId}"`);
  expect(documents[3]?.[1].body).toContain("Code not accepted");
  expect(documents[3]?.[1].body).not.toContain('name="factor_id"');
  expect(documents[3]?.[1].body).toContain('action="/admin/recovery/reenrolment/start"');
  expect(documents[4]?.[1].body).toContain("Authenticator set up");
  expect(documents[4]?.[1].headers["set-cookie"]).toEqual([`${RECOVERY}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`]);

  // The pages: 200 and the Proxy's three headers.
  for (const [label, answer] of pages) {
    expect(answer.status, label).toBe(200);
    for (const [name, value] of Object.entries(PROXY)) {
      expect(answer.headers[name], `${label}: ${name}`).toBe(value);
    }
  }

  // PROPOSED EXCEPTION, pending the Product Owner's review (issue #268 §6.3 P-R5 requires no-store).
  // Under `next dev` the framework sends rendered pages with its own Cache-Control, replacing the
  // Proxy's no-store, for the existing sign-in page too. The new pages show no secret or code. The
  // exact observed development value is asserted, for the new pages and the control alike.
  for (const [label, answer] of pages) {
    expect(answer.headers["cache-control"], `${label}: the observed development value`).toBe("no-cache, must-revalidate");
  }
});

/* ------------------------------------------------------------------------------------------- */
/* R: the journey in each engine                                                                */
/* ------------------------------------------------------------------------------------------- */

test("R-1: password, recovery code, a refused then accepted completion, ten codes, and the new TOTP signs in", async ({ page, context, browserName }) => {
  const account = provisionAccount(state);
  expect(account.recoveryCodes).toHaveLength(10);
  await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");

  const cookie = await recoveryCookie(context);
  console.log(`[evidence] R-1 ${browserName} recovery cookie store: secure=${String(cookie?.secure)} httpOnly=${String(cookie?.httpOnly)} sameSite=${String(cookie?.sameSite)} path=${String(cookie?.path)}`);
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: "/", domain: "127.0.0.1" });
  // The #261 WebKit SameSite evidence gap is carried: WebKit's report is recorded, not trusted.
  expect(browserName === "webkit" ? ["Strict", "None"] : ["Strict"]).toContain(cookie?.sameSite);
  expect(await sessionRows(account.administratorId)).toEqual(["recovery"]);

  await page.getByRole("button", { name: "Set up a new authenticator" }).click();
  await expect(page.getByRole("heading", { name: "New authenticator", exact: true })).toBeVisible();
  const secretBase32 = await secretOn(page);
  expect(secretBase32).toMatch(/^[A-Z2-7]+$/);

  await page.getByLabel("Six-digit code from your new authenticator").fill(wrongCode(secretBase32));
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Code not accepted", exact: true })).toBeVisible();
  await expect(page.getByText(secretBase32)).toHaveCount(0);

  await page.getByLabel("Six-digit code from your new authenticator").fill(codeAt({ secretBase32 }, Date.now()));
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Authenticator set up", exact: true })).toBeVisible();
  const fresh = await codesOn(page);
  expect(fresh).toHaveLength(10);
  expect(await recoveryCookie(context)).toBeUndefined();
  expect(await sessionRows(account.administratorId)).toEqual([]);

  await signInWithTotp(page, account, secretBase32);
  await expect(page.getByText("Signed in.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await signInWithTotp(page, account, account.secretBase32);
  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);

  await enterPassword(page, account);
  await page.getByRole("link", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(account.recoveryCodes[1] ?? "");
  await page.getByRole("button", { name: "Use recovery code" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);
});

test("R-2: with a live recovery session, /admin lands on sign-in", async ({ page }) => {
  const account = provisionAccount(state);
  await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await expect(page.getByText("Signed in.")).toHaveCount(0);
});

test("R-3: regeneration warns first, shows ten new codes; an old code fails and a new one works", async ({ page }) => {
  const account = provisionAccount(state);
  await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");
  await expect(page.getByText("This replaces every recovery code, including any shown before.")).toBeVisible();

  await page.getByRole("button", { name: "Replace recovery codes" }).click();
  await expect(page.getByRole("heading", { name: "New recovery codes", exact: true })).toBeVisible();
  const fresh = await codesOn(page);
  expect(fresh).toHaveLength(10);
  await page.getByRole("link", { name: "Return to the recovery session" }).click();
  await page.getByRole("button", { name: "End recovery session" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);

  await enterPassword(page, account);
  await page.getByRole("link", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(account.recoveryCodes[1] ?? "");
  await page.getByRole("button", { name: "Use recovery code" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);

  await useRecoveryCode(page, account, fresh[0] ?? "");
});

test("R-4: ending the recovery session deletes it; back, reload and the old cookie all fail", async ({ page, context }) => {
  const account = provisionAccount(state);
  await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");
  const old = await recoveryCookie(context);

  await page.getByRole("button", { name: "End recovery session" }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  expect(await recoveryCookie(context)).toBeUndefined();
  expect(await sessionRows(account.administratorId)).toEqual([]);

  await page.goBack();
  await page.reload();
  await expect(page.getByRole("button", { name: "End recovery session" })).toHaveCount(0);

  await context.addCookies([{ name: RECOVERY, value: old?.value ?? "", url: state.origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  await page.goto("/admin/recovery");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test("R-5: a recovery session aged past 15 minutes is refused at the page and at every action", async ({ page, context }) => {
  const account = provisionAccount(state);
  await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");
  const cookie = `${RECOVERY}=${(await recoveryCookie(context))?.value ?? ""}`;
  await ageSessions(account.administratorId, 16);

  await page.reload();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);

  for (const [path, fields] of [
    ["/admin/recovery/reenrolment/start", {}],
    ["/admin/recovery/codes", {}],
    ["/admin/recovery/reenrolment/complete", { factor_id: "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", code: "123456" }],
  ] as const) {
    const answer = await post(path, fields, cookie);
    expect(answer.status, path).toBe(303);
    expect(answer.headers.location, path).toBe("/admin/sign-in?notice=1");
  }
});

test("R-6: forms posted from another loopback origin are refused, change nothing, and leave the cookies working", async ({ page, context, browserName }) => {
  const account = provisionAccount(state);
  const forms: Record<string, { readonly target: string; readonly fields: string }> = {
    "/verify": { target: "/admin/sign-in/recovery/verify", fields: `<input name="code" value="${account.recoveryCodes[2] ?? ""}">` },
    "/start": { target: "/admin/recovery/reenrolment/start", fields: "" },
    "/complete": { target: "/admin/recovery/reenrolment/complete", fields: '<input name="factor_id" value="0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b"><input name="code" value="123456">' },
    "/codes": { target: "/admin/recovery/codes", fields: "" },
    "/sign-out": { target: "/admin/recovery/sign-out", fields: "" },
  };
  const attacker = createServer((request, response) => {
    const chosen = forms[request.url ?? ""] ?? forms["/start"]!;
    response.setHeader("Content-Type", "text/html");
    response.end(`<form id="f" method="post" action="${state.origin}${chosen.target}">${chosen.fields}</form><script>document.getElementById("f").submit()</script>`);
  });
  await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  const attackerOrigin = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}`;

  try {
    // A live recovery session and, alongside, a live challenge cookie.
    await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");
    await page.goto("/admin/sign-in");
    await page.getByLabel("Username").fill(account.username);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);

    for (const [path, { target }] of Object.entries(forms)) {
      const before = await storedWithoutActivity();
      const initial = page.waitForResponse((response) => response.url() === `${state.origin}${target}` && response.request().method() === "POST", { timeout: 30_000 });
      const landed = page.waitForURL((url) => url.origin === state.origin && url.pathname !== target, { timeout: 30_000 });
      await page.goto(`${attackerOrigin}${path}`);

      // The initial cross-site POST response, on its own.
      const response = await initial;
      const setCookie = (await response.headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie");
      console.log(`[evidence] R-6 ${browserName} ${target}: ${response.status()} -> ${String(response.headers().location)}; Set-Cookie reported: ${setCookie.length}`);
      expect(response.status(), target).toBe(303);
      expect(response.headers().location, target).toMatch(/^\/admin\/(sign-in|recovery)\?notice=1$/);
      expect(setCookie, `${target}: no Set-Cookie`).toEqual([]);
      await landed;
      // Activity is excluded: the followed page's own session check may move it.
      expect(await storedWithoutActivity(), `${target}: nothing changed`).toEqual(before);
    }

    // The cookies are still present, and the legitimate next actions still work.
    const names = (await context.cookies()).map((cookie) => cookie.name);
    expect(names).toContain(RECOVERY);
    expect(names).toContain(CHALLENGE);
    await page.goto("/admin/sign-in/recovery");
    await page.getByLabel("Recovery code").fill(account.recoveryCodes[1] ?? "");
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(page).toHaveURL(/\/admin\/recovery$/);
    await page.getByRole("button", { name: "Set up a new authenticator" }).click();
    await expect(page.getByRole("heading", { name: "New authenticator", exact: true })).toBeVisible();
  } finally {
    await new Promise((resolve) => attacker.close(resolve));
    await context.clearCookies();
  }
});

test("R-7: the recovery journey works by keyboard alone, with labelled fields and an announced notice", async ({ page }) => {
  const account = provisionAccount(state);
  const press = async (name: string) => {
    await page.getByRole("button", { name }).focus();
    await page.keyboard.press("Enter");
  };
  const recoverByKeyboard = async (code: string) => {
    await page.goto("/admin/sign-in");
    await page.getByLabel("Username").focus();
    await page.keyboard.type(account.username);
    await page.keyboard.press("Tab");
    await page.keyboard.type(account.password);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
    await page.getByRole("link", { name: "Use a recovery code instead" }).focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Recovery code").focus();
    await page.keyboard.type(code);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/recovery$/);
  };

  // Regeneration and ending the session.
  await recoverByKeyboard(account.recoveryCodes[0] ?? "");
  await press("Replace recovery codes");
  await expect(page.getByRole("heading", { name: "New recovery codes", exact: true })).toBeVisible();
  const fresh = await codesOn(page);
  await page.getByRole("link", { name: "Return to the recovery session" }).focus();
  await page.keyboard.press("Enter");
  await press("End recovery session");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);

  // Start, a refused code with its announced notice, the retry, and completion.
  await recoverByKeyboard(fresh[0] ?? "");
  await press("Set up a new authenticator");
  const secretBase32 = await secretOn(page);
  await page.getByLabel("Six-digit code from your new authenticator").focus();
  await page.keyboard.type(wrongCode(secretBase32));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/could not be finished/);
  await page.getByLabel("Six-digit code from your new authenticator").focus();
  await page.keyboard.type(codeAt({ secretBase32 }, Date.now()));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Authenticator set up", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Go to sign-in" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test("R-8: no secret or code in any request URL; the otpauth URI is text, not a link; nothing reappears", async ({ page }) => {
  const account = provisionAccount(state);
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  await useRecoveryCode(page, account, account.recoveryCodes[0] ?? "");
  await page.getByRole("button", { name: "Replace recovery codes" }).click();
  const regenerated = await codesOn(page);
  await page.getByRole("link", { name: "Return to the recovery session" }).click();
  await expect(page.getByText(regenerated[0] ?? "unreachable")).toHaveCount(0);

  await page.getByRole("button", { name: "Set up a new authenticator" }).click();
  const secretBase32 = await secretOn(page);
  await expect(page.getByText("otpauth://", { exact: false })).toBeVisible();
  expect(await page.locator("[href*='otpauth'], [src*='otpauth'], [action*='otpauth']").count()).toBe(0);
  await page.getByLabel("Six-digit code from your new authenticator").fill(codeAt({ secretBase32 }, Date.now()));
  await page.getByRole("button", { name: "Finish setup" }).click();
  const completed = await codesOn(page);
  expect(completed).toHaveLength(10);
  await page.goto("/admin/recovery");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await expect(page.getByText(completed[0] ?? "unreachable")).toHaveCount(0);

  const secrets = [secretBase32, ...account.recoveryCodes, ...regenerated, ...completed].flatMap((value) => [value, value.replace(/-/g, "")]);
  console.log(`[evidence] R-8 request URLs recorded: ${urls.length}`);
  expect(urls.length).toBeGreaterThan(5);
  for (const url of urls) {
    expect(url.startsWith("otpauth:"), url).toBe(false);
    for (const secret of secrets) {
      expect(url, "a request URL").not.toContain(secret);
    }
  }
});
