/**
 * Revocation and disablement through the real server (issue #270 §6.3 P-V1 to P-V3, §6.4 B-V1 to
 * B-V3).
 *
 * The storage operations are invoked through the harness's `control` service while the harness
 * server runs. The operator commands themselves need the launcher lock, which the running harness
 * does not hold (RV-D1); the commands are tested in `administrator-control.*.test.ts`.
 *
 * P-V tests send raw HTTPS requests (engine-independent, chromium only). B-V tests run in
 * Chromium, Firefox and WebKit. A page-level `redirect()` answers `307`; a Route Handler `303`.
 */

import { expect, test, type Page } from "@playwright/test";

import { controlAccount, harnessState, nextCode, provisionAccount, resetThrottles, send, withPool, type Answer, type SyntheticAccount } from "./harness";

const state = harnessState();
test.use({ baseURL: state.origin });
test.describe.configure({ mode: "serial" });

const SESSION = "__Host-admin-session";
const CHALLENGE = "__Host-admin-challenge";
const RECOVERY = "__Host-admin-recovery";
const FAILURE = "/admin/sign-in?notice=1";

test.beforeEach(async () => {
  await resetThrottles(state.connectionString);
});

const post = (path: string, fields: Record<string, string>, cookie?: string): Promise<Answer> =>
  send(state, state.certificatePath, "POST", path, {
    headers: { Origin: state.origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded", ...(cookie === undefined ? {} : { Cookie: cookie }) },
    body: new URLSearchParams(fields).toString(),
  });
const get = (path: string, cookie?: string): Promise<Answer> => send(state, state.certificatePath, "GET", path, { headers: cookie === undefined ? {} : { Cookie: cookie } });

function cookieFrom(answer: Answer, name: string): string {
  const values = ([] as string[]).concat(answer.headers["set-cookie"] ?? []);
  return values.find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(";")[0] ?? "";
}

async function rawChallenge(account: SyntheticAccount): Promise<string> {
  const challenge = cookieFrom(await post("/admin/sign-in/password", { username: account.username, password: account.password }), CHALLENGE);
  expect(challenge, "the password step issued a challenge").not.toBe("");
  return challenge;
}

async function rawSession(account: SyntheticAccount): Promise<string> {
  const session = cookieFrom(await post("/admin/sign-in/code/verify", { code: nextCode(account) }, await rawChallenge(account)), SESSION);
  expect(session, "password plus TOTP issued a session").not.toBe("");
  return session;
}

async function rawRecovery(account: SyntheticAccount, code: string): Promise<string> {
  const recovery = cookieFrom(await post("/admin/sign-in/recovery/verify", { code }, await rawChallenge(account)), RECOVERY);
  expect(recovery, "the recovery code opened a recovery session").not.toBe("");
  return recovery;
}

/**
 * Wait until the 30-second TOTP step advances. A second sign-in of the same account inside one step
 * would present an already-accepted step, which the merged sign-in correctly refuses as a replay
 * (`ADR-004` P-3), so a test needing two sessions waits for the next step (browser run 1 of #270).
 */
async function nextTotpStep(): Promise<void> {
  const step = Math.floor(Date.now() / 30_000);
  while (Math.floor(Date.now() / 30_000) === step) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const sessionIds = (administratorId: string) =>
  withPool(state.connectionString, async (pool) =>
    (await pool.query("select id from administrator_session where administrator_id = $1 order by created_at", [administratorId])).rows.map((row) => row.id as string),
  );
const throttleState = () =>
  withPool(state.connectionString, async (pool) => ({
    throttle: (await pool.query("select scope, encode(subject_digest, 'hex') as s, consecutive_failures as n from authentication_throttle order by 1, 2")).rows,
    window: (await pool.query("select encode(source_digest, 'hex') as s, recent_failures::text as r from authentication_source_window order by 1")).rows,
  }));

/* ------------------------------------------------------------------------------------------- */
/* P-V: raw HTTPS against the real server                                                       */
/* ------------------------------------------------------------------------------------------- */

test("P-V1: after revoke-all, the next /admin and /admin/recovery requests redirect, and a recovery action refuses", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const signedIn = provisionAccount(state);
  const session = await rawSession(signedIn);
  expect((await get("/admin", session)).status, "the control: the session works").toBe(200);
  expect(controlAccount(state, "revoke-all", signedIn.administratorId)).toEqual({ code: "SESSIONS_REVOKED" });
  const admin = await get("/admin", session);
  expect(admin.status).toBe(307);
  expect(admin.headers.location).toBe("/admin/sign-in");

  const recovering = provisionAccount(state);
  const recovery = await rawRecovery(recovering, recovering.recoveryCodes[0] ?? "");
  expect((await get("/admin/recovery", recovery)).status, "the control: the recovery session works").toBe(200);
  expect(controlAccount(state, "revoke-all", recovering.administratorId)).toEqual({ code: "SESSIONS_REVOKED" });
  const page = await get("/admin/recovery", recovery);
  expect(page.status).toBe(307);
  expect(page.headers.location).toBe("/admin/sign-in");
  const action = await post("/admin/recovery/codes", {}, recovery);
  expect(action.status).toBe(303);
  expect(action.headers.location).toBe(FAILURE);
});

test("P-V2: after a disable, correct-input attempts are refused uncounted; a wrong password keeps the existing accounting", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  // Order matters: a recovery-code success invalidates other challenges, so the recovery session comes first.
  const recovery = await rawRecovery(account, account.recoveryCodes[0] ?? "");
  const challenge = await rawChallenge(account);
  expect(controlAccount(state, "disable", account.administratorId)).toEqual({ code: "DISABLED" });
  const before = await throttleState();

  for (const [label, attempt] of [
    ["password, correct", () => post("/admin/sign-in/password", { username: account.username, password: account.password })],
    ["TOTP, correct code, pre-disable challenge", () => post("/admin/sign-in/code/verify", { code: nextCode(account) }, challenge)],
    ["recovery code, correct code, pre-disable challenge", () => post("/admin/sign-in/recovery/verify", { code: account.recoveryCodes[1] ?? "" }, challenge)],
  ] as const) {
    const answer = await attempt();
    expect(answer.status, label).toBe(303);
    expect(answer.headers.location, label).toBe(FAILURE);
  }

  for (const [label, path] of [
    ["start", "/admin/recovery/reenrolment/start"],
    ["regeneration", "/admin/recovery/codes"],
  ] as const) {
    const answer = await post(path, {}, recovery);
    expect(answer.status, label).toBe(303);
    expect(answer.headers.location, label).toBe(FAILURE);
  }
  const completion = await post("/admin/recovery/reenrolment/complete", { factor_id: "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", code: "123456" }, recovery);
  expect(completion.headers.location).toBe(FAILURE);

  expect(await throttleState(), "the uncounted attempts changed no throttle or source row").toEqual(before);

  const wrong = await post("/admin/sign-in/password", { username: account.username, password: `${account.password} but wrong` });
  expect(wrong.headers.location).toBe(FAILURE);
  const after = await throttleState();
  const passwordRows = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.scope === "password");
  expect(passwordRows(after.throttle).reduce((sum, row) => sum + Number(row.n), 0), "exactly one added password failure").toBe(passwordRows(before.throttle).reduce((sum, row) => sum + Number(row.n), 0) + 1);
  expect(after.window, "the source window recorded the failure").not.toEqual(before.window);
});

test("P-V3: revoke-one of an administrator session leaves a second session of the same account working", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  const first = await rawSession(account);
  await nextTotpStep();
  const second = await rawSession(account);
  const [firstId] = await sessionIds(account.administratorId);
  expect(controlAccount(state, "revoke", account.administratorId, firstId ?? "")).toEqual({ code: "SESSION_REVOKED" });

  const revoked = await get("/admin", first);
  expect(revoked.status).toBe(307);
  expect(revoked.headers.location).toBe("/admin/sign-in");
  const kept = await get("/admin", second);
  expect(kept.status).toBe(200);
  expect(kept.body).toContain("Signed in.");
});

/* ------------------------------------------------------------------------------------------- */
/* B-V: in each engine                                                                          */
/* ------------------------------------------------------------------------------------------- */

async function enterPassword(page: Page, account: SyntheticAccount): Promise<void> {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("B-V1: signed in, a revoke-all makes the next /admin navigation land on sign-in", async ({ page }) => {
  const account = provisionAccount(state);
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
  await page.getByLabel(/Six-digit code/).fill(nextCode(account));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in.")).toBeVisible();

  expect(controlAccount(state, "revoke-all", account.administratorId)).toEqual({ code: "SESSIONS_REVOKED" });
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await expect(page.getByText("Signed in.")).toHaveCount(0);
});

test("B-V2: in a recovery session, a disable makes the recovery page land on sign-in, and password plus a code is refused", async ({ page }) => {
  const account = provisionAccount(state);
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
  await page.getByRole("link", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(account.recoveryCodes[0] ?? "");
  await page.getByRole("button", { name: "Use recovery code" }).click();
  await expect(page.getByRole("heading", { name: "Recovery session", exact: true })).toBeVisible();

  expect(controlAccount(state, "disable", account.administratorId)).toEqual({ code: "DISABLED" });
  await page.goto("/admin/recovery");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);

  // The correct password is now refused at the password step itself, so no code can be entered.
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);
  await expect(page.getByRole("alert")).toBeVisible();
});

test("B-V3: after a disable, a fresh sign-in with the correct password is refused with the generic notice", async ({ page }) => {
  const account = provisionAccount(state);
  expect(controlAccount(state, "disable", account.administratorId)).toEqual({ code: "DISABLED" });
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\?notice=1$/);
  await expect(page.getByRole("alert")).toHaveText(/did not succeed/);
});
