/**
 * The operator reset through the real server (Unit OR Scope Gate, revision 4, §6.4 P-R1 to P-R4,
 * §6.5 B-R1 to B-R3).
 *
 * The reset runs through the harness's `reset` service, which drives the real command logic with
 * a scripted terminal while the harness server runs. The command itself needs the launcher lock,
 * which the running harness does not hold (RV-D1); it is tested in `administrator-reset.*.test.ts`.
 *
 * P-R tests send raw HTTPS requests (engine-independent, chromium only). B-R tests run in
 * Chromium, Firefox and WebKit. **Arranged state is limited** to two counters set one failure
 * below the ceiling (O-2, O-3), because reaching 100 consecutive failures through requests would
 * take hours of throttle waits; the ceiling itself is then reached by a real request.
 */

import { expect, test, type Page } from "@playwright/test";

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ListedSession, SessionListingOutcome } from "../../src/data/administrator-authentication";

import {
  controlAccount,
  harnessState,
  keyedDigestOf,
  nextCode,
  provisionAccount,
  REPOSITORY_ROOT,
  resetAccount,
  resetThrottles,
  send,
  withPool,
  type Answer,
  type SyntheticAccount,
} from "./harness";

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

const query = <T>(text: string, values: readonly unknown[]) => withPool(state.connectionString, async (pool) => (await pool.query(text, values)).rows as T[]);
const factorState = async (account: SyntheticAccount) => (await query<{ state: string }>("select state from administrator_totp_factor where administrator_id = $1", [account.administratorId]))[0]?.state;
const codeCount = async (account: SyntheticAccount) => Number((await query<{ n: number }>("select count(*)::int as n from administrator_recovery_code where administrator_id = $1", [account.administratorId]))[0]?.n);
const pendingCount = async (account: SyntheticAccount) => Number((await query<{ n: number }>("select count(*)::int as n from administrator_pending_challenge where administrator_id = $1", [account.administratorId]))[0]?.n);
const disabledText = async (account: SyntheticAccount) => (await query<{ d: string | null }>("select disabled_at::text as d from administrator where id = $1", [account.administratorId]))[0]?.d;

const moduleUrl = (...path: string[]) => JSON.stringify(pathToFileURL(join(REPOSITORY_ROOT, ...path)).href);

/**
 * The real operator listing (`listSessions`), run in a child process as the harness services are:
 * Playwright's CommonJS loader cannot load the storage modules themselves.
 */
const LISTING_SCRIPT = `
  const { listSessions } = await import(${moduleUrl("src", "data", "administrator-authentication.ts")});
  const { createListingPersistence } = await import(${moduleUrl("src", "data", "connection.ts")});
  const persistence = createListingPersistence({ pool: { connectionString: process.argv[1], max: 1 } });
  try {
    const listed = await listSessions(persistence.db, { administratorId: process.argv[2] }, Date.now);
    console.log("RESULT " + JSON.stringify(listed.ok ? listed.value : { code: "STORAGE_FAILURE" }));
  } finally {
    await persistence.shutdown();
  }
`;

/** The recovery entries of the `listSessions` result that have `live: true`. */
async function liveRecoverySessions(account: SyntheticAccount): Promise<readonly ListedSession[]> {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-transform-types", "--import", JSON.parse(moduleUrl("scripts", "local-demo", "register.mjs")) as string, "--input-type=module", "-e", LISTING_SCRIPT, state.connectionString, account.administratorId],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("RESULT "));
  expect(result.status === 0 && line !== undefined, `the operator listing ran: ${result.stderr}`).toBe(true);
  const listed = JSON.parse(line?.slice("RESULT ".length) ?? "{}") as SessionListingOutcome | { readonly code: "STORAGE_FAILURE" };
  expect(listed.code, "the operator listing ran").toBe("SESSIONS_LISTED");
  const sessions = listed.code === "SESSIONS_LISTED" ? listed.sessions : [];
  return sessions.filter((session) => session.kind === "recovery" && session.live);
}

/** The §3.7 precondition, by the `listSessions` result: no `recovery` entry has `live: true`. */
async function expectNoLiveRecoverySession(account: SyntheticAccount): Promise<void> {
  expect(await liveRecoverySessions(account), "no recovery session has live: true").toEqual([]);
}

/** Set a counter one failure below the ceiling, with a wait that has already passed (schema-valid). */
async function counterAt99(scope: "password" | "recovery_code", subject: Buffer): Promise<void> {
  await query(
    `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
     values ($1, $2, 99, now() - interval '1 second', now() - interval '1 second')
     on conflict (scope, subject_digest) do update set consecutive_failures = 99, wait_until = now() - interval '1 second'`,
    [scope, subject],
  );
}

/** Reset, then prove the new credentials sign in and the reset's codes exist. */
async function resetAndSignIn(account: SyntheticAccount): Promise<SyntheticAccount> {
  const reset = resetAccount(state, account);
  expect(reset.outcome).toBe("CREDENTIALS_RESET_CONFIRMED");
  expect(reset.recoveryCodes).toHaveLength(10);
  const session = await rawSession(reset);
  expect((await get("/admin", session)).status).toBe(200);
  return reset;
}

/* ------------------------------------------------------------------------------------------- */
/* P-R: raw HTTPS against the real server                                                       */
/* ------------------------------------------------------------------------------------------- */

test("P-R1: after a reset to a different password, the old session and credentials fail and the new ones sign in", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  const session = await rawSession(account);
  const reset = resetAccount(state, account);
  expect(reset.password).not.toBe(account.password);

  expect((await get("/admin", session)).status, "the old session is revoked").toBe(307);
  const old = await post("/admin/sign-in/password", { username: account.username, password: account.password });
  expect(old.headers.location, "the old password").toBe(FAILURE);
  expect((await get("/admin", await rawSession(reset))).status, "the new password and TOTP").toBe(200);
});

test("P-R1b: after a reset reusing the password, the old TOTP on a pre-reset challenge fails; the same password with the new TOTP signs in", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  const early = await rawChallenge(account);
  const reset = resetAccount(state, account, account.password);

  const stale = await post("/admin/sign-in/code/verify", { code: nextCode(account) }, early);
  expect(stale.headers.location, "the invalidated pre-reset challenge").toBe(FAILURE);
  expect(cookieFrom(stale, SESSION)).toBe("");
  expect((await get("/admin", await rawSession(reset))).status).toBe(200);
});

test("P-R2: a code the reset showed opens a recovery session, and RA-1 discards the factor as before", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const reset = resetAccount(state, provisionAccount(state));
  const recovery = await rawRecovery(reset, reset.recoveryCodes[0] ?? "");
  expect((await get("/admin/recovery", recovery)).status).toBe(200);
  expect(await factorState(reset)).toBe("reenrolment_required");
});

test("P-R3: disable, then reset; a fresh password request after T1 with the new password issues no challenge (D-16)", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  expect(controlAccount(state, "disable", account.administratorId)).toEqual({ code: "DISABLED" });
  const disabledBefore = await disabledText(account);
  const reset = resetAccount(state, account);
  expect(reset.outcome).toBe("CREDENTIALS_RESET_ACCOUNT_DISABLED");
  expect(reset.secretBase32, "nothing is shown for a disabled account").toBe("");
  expect(reset.recoveryCodes).toEqual([]);
  const pendingBefore = await pendingCount(account);

  const fresh = await post("/admin/sign-in/password", { username: account.username, password: reset.password });
  expect(fresh.status).toBe(303);
  expect(fresh.headers.location).toBe(FAILURE);
  expect(cookieFrom(fresh, CHALLENGE), "no challenge cookie").toBe("");
  expect(await pendingCount(account), "no challenge row").toBe(pendingBefore);
  expect(await disabledText(account)).toBe(disabledBefore);
  expect(await factorState(account), "no TOTP step: T2 never ran").toBe("pending_confirmation");
});

test("P-R4 O-1: the last code is used and its recovery session ends; then reset and sign in", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  let recovery = "";
  for (const code of account.recoveryCodes) {
    recovery = await rawRecovery(account, code);
  }
  expect(await codeCount(account)).toBe(0);
  await post("/admin/recovery/sign-out", {}, recovery);
  await expectNoLiveRecoverySession(account);
  expect(await factorState(account)).not.toBe("active");
  await resetAndSignIn(account);
});

test("P-R4 O-2: with Q live after the ceiling it is not O-2; once Q has ended it is, and the reset remedies it", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const ceiling = async (account: SyntheticAccount) => {
    const recovery = await rawRecovery(account, account.recoveryCodes[0] ?? "");
    await counterAt99("recovery_code", keyedDigestOf(state.throttleKey, "recovery-code-administrator", account.administratorId));
    const wrong = await post("/admin/sign-in/recovery/verify", { code: "0".repeat(32) }, await rawChallenge(account));
    expect(wrong.headers.location).toBe(FAILURE);
    expect(await codeCount(account), "the real ceiling deleted the codes").toBe(0);
    return recovery;
  };

  // Negative control: Q survives the ceiling and can still regenerate, so this is not O-2.
  const control = provisionAccount(state);
  const live = await ceiling(control);
  expect(await liveRecoverySessions(control), "Q is listed with live: true after the ceiling").toHaveLength(1);
  expect((await post("/admin/recovery/codes", {}, live)).status).toBe(200);
  expect(await codeCount(control)).toBe(10);

  const account = provisionAccount(state);
  const recovery = await ceiling(account);
  await post("/admin/recovery/sign-out", {}, recovery);
  await expectNoLiveRecoverySession(account);
  await resetAndSignIn(account);
});

test("P-R4 O-3: the password is disabled by the ceiling; then reset and sign in", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  await counterAt99("password", keyedDigestOf(state.throttleKey, "password-username", account.username));
  await post("/admin/sign-in/password", { username: account.username, password: `${account.password} but wrong` });
  await expectNoLiveRecoverySession(account);
  expect((await query<{ pd: string | null }>("select password_disabled_at::text as pd from administrator where id = $1", [account.administratorId]))[0]?.pd).not.toBeNull();
  expect(cookieFrom(await post("/admin/sign-in/password", { username: account.username, password: account.password }), CHALLENGE), "no route remains").toBe("");
  await resetAndSignIn(account);
});

test("P-R4 operational lockout: a lost regeneration, then Q ends; then reset and sign in", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "raw-request evidence is engine-independent; asserted once");
  const account = provisionAccount(state);
  const recovery = await rawRecovery(account, account.recoveryCodes[0] ?? "");
  // The regeneration's response is discarded whole: ten codes are stored that nobody knows.
  expect((await post("/admin/recovery/codes", {}, recovery)).status).toBe(200);
  await post("/admin/recovery/sign-out", {}, recovery);
  await expectNoLiveRecoverySession(account);
  expect(await codeCount(account)).toBe(10);
  expect(cookieFrom(await post("/admin/sign-in/recovery/verify", { code: account.recoveryCodes[1] ?? "" }, await rawChallenge(account)), RECOVERY), "every known code fails").toBe("");
  await resetAndSignIn(account);
});

/* ------------------------------------------------------------------------------------------- */
/* B-R: in each engine                                                                          */
/* ------------------------------------------------------------------------------------------- */

async function enterPassword(page: Page, account: SyntheticAccount): Promise<void> {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function signInThroughPage(page: Page, account: SyntheticAccount): Promise<void> {
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
  await page.getByLabel(/Six-digit code/).fill(nextCode(account));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in.")).toBeVisible();
}

test("B-R1: signed in, a reset makes the next /admin navigation land on sign-in", async ({ page }) => {
  const account = provisionAccount(state);
  await signInThroughPage(page, account);
  resetAccount(state, account);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await expect(page.getByText("Signed in.")).toHaveCount(0);
});

test("B-R2: in a recovery session, a reset makes the recovery page land on sign-in", async ({ page }) => {
  const account = provisionAccount(state);
  await enterPassword(page, account);
  await expect(page).toHaveURL(/\/admin\/sign-in\/code$/);
  await page.getByRole("link", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(account.recoveryCodes[0] ?? "");
  await page.getByRole("button", { name: "Use recovery code" }).click();
  await expect(page.getByRole("heading", { name: "Recovery session", exact: true })).toBeVisible();

  resetAccount(state, account);
  await page.goto("/admin/recovery");
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test("B-R3: the new credentials sign in through the pages", async ({ page }) => {
  const reset = resetAccount(state, provisionAccount(state));
  await signInThroughPage(page, reset);
});
