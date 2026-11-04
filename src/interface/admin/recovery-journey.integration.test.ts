/**
 * The recovery journey's handler bodies against a real PostgreSQL (issue #268 §6.2 H-R1 to H-R13):
 * plain `Request` in, `Response` out, through the real gate, request checks, runtime, recovery steps
 * and storage.
 *
 * **What this layer establishes:** what the handler bodies and the session-check functions return
 * and write. **It does not establish** actual Next.js page rendering, page redirects, framework
 * method handling or Proxy behaviour; those are tested through the real server (`tests/browser/`).
 *
 * The runtime's database is the real one, reached through a test-owned `pg` pool wrapper that
 * records every statement the runtime sends, labelled or not. "No storage call" means the wrapper
 * saw nothing during that one invocation. A separate observer pool reads the whole stored state.
 * Nothing here simulates an unbuilt operation; the one arranged state (fewer stored codes, an aged
 * session) is written directly by setup, as #266's suite does.
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import { Kysely, PostgresDialect } from "kysely";
import { Secret } from "otpauth";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { provisionSyntheticAdministrator } from "../../../scripts/local-demo/administrator-provisioning";
import type { AdministratorAuthenticationDatabase } from "../../data/administrator-authentication-table";
import { startupOptionsFor } from "../../data/connection";
import { useEmbeddedPostgres } from "../../data/testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "../../data/timestamp-parser";
import { recoveryCodeDigest } from "../../domain/administrator-auth/recovery-code";
import { totpCodeAt } from "../../domain/administrator-auth/totp";
import { LOCAL_DEMO_DATABASE_URL } from "../public/local-demo-persistence";
import { DEFAULT_FACTORIES, resetAdministratorRuntimeForTests, type RuntimeFactories } from "./authentication-runtime";
import { WARNINGS } from "./display-once";
import { codeEntry, FAILURE_LOCATION, passwordEntry, type EntryOptions } from "./entry-points";
import { LOCAL_ADMIN_ORIGIN, LOCAL_ADMIN_THROTTLE_KEY, LOCAL_ADMIN_TOTP_KEY_V1, localAdministratorConfigurationOf } from "./local-gate";
import {
  RECOVERY_NOTICE_LOCATION,
  recoveryCodeEntry,
  recoveryCodesEntry,
  recoveryCompleteEntry,
  recoverySignOutEntry,
  recoveryStartEntry,
} from "./recovery-entry-points";
import { administratorSessionOf } from "./require-administrator";
import { recoverySessionOf } from "./require-recovery-session";

// Real scrypt derivations (about 0.7 s each) run for every provisioning and password step.
vi.setConfig({ testTimeout: 180_000 });

interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(destroy?: boolean | Error): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as { Pool: new (config: Record<string, unknown>) => PgPool };

const DATABASE = "admin_recovery_journey";
const cluster = useEmbeddedPostgres({ slug: "admin-recovery-journey", databases: [DATABASE], migrate: [DATABASE] });

const ORIGIN = "https://127.0.0.1:3000";
const TOTP_KEY = randomBytes(32);
const THROTTLE_KEY = randomBytes(32);
const RECOVERY = "__Host-admin-recovery";
const SESSION = "__Host-admin-session";
const CHALLENGE = "__Host-admin-challenge";
const CLEAR_RECOVERY = `${RECOVERY}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
const CLEAR_SESSION = `${SESSION}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
const CLEAR_CHALLENGE = `${CHALLENGE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;

let environment: Record<string, string>;
let observer: PgPool;
/** Every statement the runtime sent, in order: its `adr028:` label, or `sql`. */
const sent: string[] = [];
const lines: string[] = [];

/** The runtime's database: the real cluster, through a pool wrapper that records every statement. */
const observedFactories: RuntimeFactories = {
  ...DEFAULT_FACTORIES,
  createDatabase(connectionString) {
    const pool = new pg.Pool({
      connectionString,
      max: 2,
      types: createTimestamptzTypeOverrides(),
      options: startupOptionsFor({ application_name: "recovery_journey_test" }),
    });
    pool.on("error", () => undefined);
    const record = (text: string) => sent.push(text.startsWith("/* adr028:") ? text.slice(10, text.indexOf(" */")) : "sql");
    const wrapped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (text: string, values?: readonly unknown[]) => {
            record(text);
            return client.query(text, values);
          },
          release: (destroy?: boolean | Error) => client.release(destroy),
        };
      },
      end: () => pool.end(),
    };
    const db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
    return { db, shutdown: () => db.destroy() };
  },
};

beforeAll(async () => {
  environment = {
    NODE_ENV: "development",
    [LOCAL_DEMO_DATABASE_URL]: cluster.connectionStringFor(DATABASE),
    [LOCAL_ADMIN_ORIGIN]: ORIGIN,
    [LOCAL_ADMIN_TOTP_KEY_V1]: TOTP_KEY.toString("base64url"),
    [LOCAL_ADMIN_THROTTLE_KEY]: THROTTLE_KEY.toString("base64url"),
  };
  await resetAdministratorRuntimeForTests();
  observer = new pg.Pool({ connectionString: cluster.connectionStringFor(DATABASE), max: 2 });
  observer.on("error", () => undefined);
  cluster.closeBeforeShutdown("recovery journey observer", () => observer.end());
  cluster.closeBeforeShutdown("runtime", () => resetAdministratorRuntimeForTests());
});

afterEach(async () => {
  lines.length = 0;
  await observer.query("delete from authentication_throttle");
  await observer.query("delete from authentication_source_window");
});

const options = (): EntryOptions => ({ environment, factories: observedFactories, log: (line) => lines.push(line) });
const configuration = () => {
  const found = localAdministratorConfigurationOf(environment);
  expect(found).toBeDefined();
  return found!;
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

function post(path: string, body: string | Uint8Array, cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Host: "127.0.0.1:3000",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
    body,
  });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** `name=value` of a cookie the response sets (not clears). */
const cookieOf = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(";")[0];
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

interface Account {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly secret: Buffer;
  readonly codes: readonly string[];
}

async function provision(): Promise<Account> {
  const username = `synthetic-${randomBytes(5).toString("hex")}`;
  const password = `synthetic recovery ${randomBytes(8).toString("hex")}`;
  const said: string[] = [];
  const answers = [password, password];
  let secret = Buffer.alloc(0);
  const runtimeDb = observedFactories.createDatabase(cluster.connectionStringFor(DATABASE));

  try {
    const result = await provisionSyntheticAdministrator(
      {
        interactive: true,
        ask: async (prompt) => {
          if (!prompt.startsWith("Current six-digit code")) {
            return username;
          }

          const base32 = said.map((line) => /Secret \(base32\): ([A-Z2-7]+)/.exec(line)?.[1]).find((value) => value !== undefined) ?? "";
          secret = Buffer.from(Secret.fromBase32(base32).bytes);
          return totpCodeAt(secret, Date.now());
        },
        askSecret: async () => answers.shift() ?? "",
        say: (line) => said.push(line),
      },
      { db: runtimeDb.db, clock: Date.now, totpKey: TOTP_KEY, environment: {}, databaseUrl: cluster.connectionStringFor(DATABASE) },
    );

    if (!result.ok) {
      throw new Error(`provisioning gave ${result.reason}`);
    }

    const codes = said.filter((line) => /^  [0-9a-f]{8}(-[0-9a-f]{8}){3}$/.test(line)).map((line) => line.trim());
    expect(codes).toHaveLength(10);
    return { id: result.administratorId, username, password, secret, codes };
  } finally {
    await runtimeDb.shutdown();
  }
}

async function challengeFor(account: Account): Promise<string> {
  const answer = await passwordEntry(post("/admin/sign-in/password", form({ username: account.username, password: account.password })), options());
  const challenge = cookieOf(answer, CHALLENGE);
  expect(challenge, "the password step issued a challenge").toBeDefined();
  return challenge ?? "";
}

/** Password, then the code at `index`: the recovery cookie `name=value`. */
async function recoveryFor(account: Account, code: string | undefined = account.codes[0]): Promise<string> {
  const answer = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: code ?? "" }), await challengeFor(account)), options());
  const cookie = cookieOf(answer, RECOVERY);
  expect(cookie, "the recovery code opened a recovery session").toBeDefined();
  return cookie ?? "";
}

/** Password, then a TOTP code for `secret`: the administrator session cookie `name=value`. */
async function administratorFor(account: Account, secret: Buffer = account.secret): Promise<string> {
  const answer = await codeEntry(post("/admin/sign-in/code/verify", form({ code: totpCodeAt(secret, Date.now() + 30_000) }), await challengeFor(account)), options());
  const cookie = cookieOf(answer, SESSION);
  expect(cookie, "password plus TOTP issued an administrator session").toBeDefined();
  return cookie ?? "";
}

const start = (cookie: string) => recoveryStartEntry(post("/admin/recovery/reenrolment/start", "", cookie), options());
const regenerate = (cookie: string) => recoveryCodesEntry(post("/admin/recovery/codes", "", cookie), options());
const complete = (cookie: string, factorId: string, code: string) =>
  recoveryCompleteEntry(post("/admin/recovery/reenrolment/complete", form({ factor_id: factorId, code }), cookie), options());
const signOut = (cookie?: string) => recoverySignOutEntry(post("/admin/recovery/sign-out", "", cookie), options());

/** The secret and `factor_id` a start document shows. */
async function started(response: Response): Promise<{ readonly secret: Buffer; readonly factorId: string; readonly html: string }> {
  const html = await response.text();
  const base32 = /Secret \(base32\): <code>([A-Z2-7]+)<\/code>/.exec(html)?.[1] ?? "";
  const factorId = /name="factor_id" value="([0-9a-f-]+)"/.exec(html)?.[1] ?? "";
  expect(base32, "the start document shows the secret").not.toBe("");
  return { secret: Buffer.from(Secret.fromBase32(base32).bytes), factorId, html };
}

const codesIn = (html: string) => [...html.matchAll(/<li><code>([0-9a-f-]{35})<\/code><\/li>/g)].map((match) => match[1] ?? "");

const TABLES = [
  "administrator",
  "administrator_totp_factor",
  "administrator_session",
  "administrator_pending_challenge",
  "administrator_consumed_challenge",
  "administrator_recovery_code",
  "authentication_throttle",
  "authentication_source_window",
] as const;

/** Every row of every authentication table, as stored text, optionally without session activity. */
async function stored(options: { readonly withoutActivity?: boolean } = {}): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};

  for (const table of TABLES) {
    const rows = (await observer.query(`select row_to_json(t)::jsonb as r from ${table} t`)).rows.map((row) => {
      const value = { ...(row.r as Record<string, unknown>) };

      if (options.withoutActivity === true && table === "administrator_session") {
        delete value.last_activity_at;
      }

      return JSON.stringify(value);
    });
    out[table] = rows.sort();
  }

  return out;
}

const sessionRow = async (cookie: string) =>
  (
    await observer.query(
      "select kind, (extract(epoch from last_activity_at) * 1000000)::bigint::text as activity, absolute_expires_at::text as absolute from administrator_session where token_digest = sha256(decode($1, 'base64'))",
      [tokenOf(cookie).replace(/-/g, "+").replace(/_/g, "/") + "="],
    )
  ).rows[0] as { kind: string; activity: string; absolute: string } | undefined;
const codeRows = async (account: Account) =>
  Number((await observer.query("select count(*)::int as n from administrator_recovery_code where administrator_id = $1", [account.id])).rows[0]?.n);
const factorOf = async (account: Account) =>
  (await observer.query("select state, factor_id, origin_recovery_session_id as origin from administrator_totp_factor where administrator_id = $1", [account.id]))
    .rows[0] as { state: string; factor_id: string | null; origin: string | null };
const liveSessions = async (account: Account) =>
  Number((await observer.query("select count(*)::int as n from administrator_session where administrator_id = $1 and absolute_expires_at > now()", [account.id])).rows[0]?.n);
/** Move every stored instant of the account's sessions back by `minutes`. */
const ageSessions = (account: Account, minutes: number) =>
  observer.query(
    "update administrator_session set created_at = created_at - make_interval(mins => $2), last_activity_at = last_activity_at - make_interval(mins => $2), absolute_expires_at = absolute_expires_at - make_interval(mins => $2) where administrator_id = $1",
    [account.id, minutes],
  );

describe("H-R2: class A refusals with live credentials attached", () => {
  it("make no storage call, send no Set-Cookie and change nothing, and the credential still works afterwards", async () => {
    const account = await provision();
    const challenge = await challengeFor(account);
    const recovery = await recoveryFor(account, account.codes[1]);
    const freshChallenge = await challengeFor(account);
    const cookies = `${freshChallenge}; ${recovery}`;
    const entries = [
      ["verify", (r: Request) => recoveryCodeEntry(r, options()), "/admin/sign-in/recovery/verify", { code: account.codes[2] ?? "" }, FAILURE_LOCATION],
      ["start", (r: Request) => recoveryStartEntry(r, options()), "/admin/recovery/reenrolment/start", {}, RECOVERY_NOTICE_LOCATION],
      ["complete", (r: Request) => recoveryCompleteEntry(r, options()), "/admin/recovery/reenrolment/complete", { factor_id: "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", code: "123456" }, RECOVERY_NOTICE_LOCATION],
      ["codes", (r: Request) => recoveryCodesEntry(r, options()), "/admin/recovery/codes", {}, RECOVERY_NOTICE_LOCATION],
      ["sign-out", (r: Request) => recoverySignOutEntry(r, options()), "/admin/recovery/sign-out", {}, FAILURE_LOCATION],
    ] as const;
    const attacks: Array<[string, (body: string) => { readonly body: string | Uint8Array; readonly headers: Record<string, string> }]> = [
      ["a foreign Origin", (body) => ({ body, headers: { Origin: "https://127.0.0.1:3001" } })],
      ["a missing Origin", (body) => ({ body, headers: { Origin: "" } })],
      ["Sec-Fetch-Site: cross-site", (body) => ({ body, headers: { "Sec-Fetch-Site": "cross-site" } })],
      ["Sec-Fetch-Site: same-site", (body) => ({ body, headers: { "Sec-Fetch-Site": "same-site" } })],
      ["a wrong content type", (body) => ({ body, headers: { "Content-Type": "multipart/form-data; boundary=x" } })],
      ["an over-long body", () => ({ body: `code=${"a".repeat(5000)}`, headers: {} })],
      // Raw bytes that are not UTF-8 (a percent-escape like `%FF` is valid UTF-8 text and decodes to U+FFFD).
      ["invalid UTF-8", () => ({ body: Uint8Array.from([0x63, 0x6f, 0x64, 0x65, 0x3d, 0xff, 0xfe]), headers: {} })],
      ["an extra field", (body) => ({ body: body === "" ? "extra=1" : `${body}&extra=1`, headers: {} })],
      ["a duplicated field", (body) => ({ body: body === "" ? "x=1&x=1" : `${body}&${body}`, headers: {} })],
    ];
    expect(challenge).not.toBe("");

    for (const [name, handler, path, fields, location] of entries) {
      for (const [label, attack] of attacks) {
        const shaped = attack(form(fields));
        const before = await stored();
        const mark = sent.length;
        const answer = await handler(post(path, shaped.body, cookies, shaped.headers));

        // The initial handler response, inspected on its own.
        expect(sent.length - mark, `${name}, ${label}: storage calls`).toBe(0);
        expect(answer.headers.getSetCookie(), `${name}, ${label}`).toEqual([]);
        expect(answer.status, `${name}, ${label}`).toBe(303);
        expect(answer.headers.get("location"), `${name}, ${label}`).toBe(location);
        expect(await stored(), `${name}, ${label}: the whole stored state`).toEqual(before);
      }
    }

    // Separately, afterwards: the attached credentials still work. The challenge is used first,
    // because a re-enrolment start would invalidate it (RA-4) and a code success would end Q.
    const pending = await observer.query("select invalidated from administrator_pending_challenge where administrator_id = $1", [account.id]);
    expect(pending.rows.map((row) => row.invalidated)).toContain(false);
    expect(await recoverySessionOf(configuration(), tokenOf(recovery), { factories: observedFactories, log: () => undefined })).toBe("valid");
    expect((await recoveryStartEntry(post("/admin/recovery/reenrolment/start", "", recovery), options())).status).toBe(200);
  });
});

describe("H-R3, H-R4: the recovery code", () => {
  it("H-R3: an accepted code sets only the recovery cookie, clears the others, and leaves nine codes", async () => {
    const account = await provision();
    const administrator = await administratorFor(account);
    const challenge = await challengeFor(account);
    const answer = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[0] ?? "" }), `${challenge}; ${administrator}`), options());

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/admin/recovery");
    const cookies = answer.headers.getSetCookie();
    expect(cookies.slice(0, 2)).toEqual([CLEAR_CHALLENGE, CLEAR_SESSION]);
    expect(cookies[2]).toMatch(/^__Host-admin-recovery=[A-Za-z0-9_-]{43}; Max-Age=(8\d\d|900); Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    expect(cookies).toHaveLength(3);

    const sessions = (await observer.query("select kind from administrator_session where administrator_id = $1", [account.id])).rows;
    expect(sessions).toEqual([{ kind: "recovery" }]);
    expect((await factorOf(account)).state).toBe("reenrolment_required");
    expect(await codeRows(account)).toBe(9);
  });

  it("H-R4: every failure gives the same generic answer, clears only the challenge cookie, and counts exactly as merged", async () => {
    const account = await provision();
    const shapes: string[] = [];
    const shape = async (response: Response) =>
      JSON.stringify({ status: response.status, location: response.headers.get("location"), cookies: response.headers.getSetCookie(), body: await response.text() });
    const counter = async () =>
      (await observer.query("select coalesce(sum(consecutive_failures), 0)::int as n from authentication_throttle where scope = 'recovery_code'")).rows[0]?.n;

    // Counted: wrong, used, unparseable, and a consumed replay.
    const used = await recoveryFor(account, account.codes[0]);
    expect(used).not.toBe("");

    for (const code of ["ffffffff-ffffffff-ffffffff-ffffffff", account.codes[0] ?? "", "not a code"]) {
      const before = Number(await counter());
      shapes.push(await shape(await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code }), await challengeFor(account)), options())));
      expect(Number(await counter()), code).toBe(before + 1);
    }

    const consumedChallenge = await challengeFor(account);
    await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[1] ?? "" }), consumedChallenge), options());
    const beforeReplay = Number(await counter());
    shapes.push(await shape(await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[2] ?? "" }), consumedChallenge), options())));
    expect(Number(await counter())).toBe(beforeReplay + 1);

    // Uncounted, before storage: no challenge cookie, and a duplicated one.
    for (const cookie of [undefined, `${consumedChallenge}; ${consumedChallenge}`]) {
      const before = await stored();
      const mark = sent.length;
      shapes.push(await shape(await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[3] ?? "" }), cookie), options())));
      expect(sent.length - mark).toBe(0);
      expect(await stored()).toEqual(before);
    }

    // Uncounted refusals: an unknown challenge, and an expired one.
    const unknown = `${CHALLENGE}=${randomBytes(32).toString("base64url")}`;
    const before = await stored();
    shapes.push(await shape(await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[3] ?? "" }), unknown), options())));
    expect(await stored()).toEqual(before);

    const expiring = await challengeFor(account);
    await observer.query("update administrator_pending_challenge set created_at = created_at - interval '6 minutes', expires_at = expires_at - interval '6 minutes' where administrator_id = $1", [account.id]);
    const beforeExpired = Number(await counter());
    shapes.push(await shape(await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[3] ?? "" }), expiring), options())));
    expect(Number(await counter())).toBe(beforeExpired);

    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0] ?? "{}")).toEqual({ status: 303, location: FAILURE_LOCATION, cookies: [CLEAR_CHALLENGE], body: "" });
  });
});

describe("H-R5: kind separation, with the actual storage effects (§3.5)", () => {
  it("each check refuses the other kind; only the presented live session's activity moves", async () => {
    const account = await provision();
    const administrator = await administratorFor(account);
    const bystander = await provision();
    const bystanderSession = await administratorFor(bystander);
    const recoveryAccount = await provision();
    const recovery = await recoveryFor(recoveryAccount);

    // administratorSessionOf refuses a live recovery token: its activity moves, its absolute expiry does not.
    let before = await sessionRow(recovery);
    await pause();
    expect(await administratorSessionOf(configuration(), tokenOf(recovery), { factories: observedFactories, log: () => undefined })).toBe("refused");
    let after = await sessionRow(recovery);
    expect(after?.absolute).toBe(before?.absolute);
    expect(BigInt(after?.activity ?? "0")).toBeGreaterThan(BigInt(before?.activity ?? "0"));

    // recoverySessionOf refuses a live administrator token, with the same disclosed effect.
    before = await sessionRow(administrator);
    let others = await stored({ withoutActivity: true });
    await pause();
    expect(await recoverySessionOf(configuration(), tokenOf(administrator), { factories: observedFactories, log: () => undefined })).toBe("refused");
    after = await sessionRow(administrator);
    expect(BigInt(after?.activity ?? "0")).toBeGreaterThan(BigInt(before?.activity ?? "0"));
    expect(await stored({ withoutActivity: true })).toEqual(others);

    // Start, regeneration and completion with a valid UUID: refused with no mutation at all.
    const asRecovery = `${RECOVERY}=${tokenOf(administrator)}`;
    for (const [name, run] of [
      ["start", () => start(asRecovery)],
      ["regeneration", () => regenerate(asRecovery)],
      ["completion", () => complete(asRecovery, "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", "123456")],
    ] as const) {
      const whole = await stored();
      const mark = sent.length;
      const answer = await run();
      expect(answer.status, name).toBe(303);
      expect(answer.headers.get("location"), name).toBe(FAILURE_LOCATION);
      expect(answer.headers.getSetCookie(), name).toEqual([CLEAR_RECOVERY]);
      expect(await stored(), `${name}: the whole state, activity included`).toEqual(whole);
      expect(sent.slice(mark), name).toEqual(["resolve-recovery-session"]);
    }

    // Completion with an invalid factor_id and an administrator token: only that session's activity moves.
    before = await sessionRow(administrator);
    others = await stored({ withoutActivity: true });
    const mark = sent.length;
    await pause();
    const invalid = await complete(asRecovery, "not-a-uuid", "123456");
    expect(invalid.headers.get("location")).toBe(FAILURE_LOCATION);
    expect(invalid.headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
    expect(sent.slice(mark).filter((label) => label !== "sql")).toEqual(["lock-session", "check-session"]);
    expect(BigInt((await sessionRow(administrator))?.activity ?? "0")).toBeGreaterThan(BigInt(before?.activity ?? "0"));
    expect(await stored({ withoutActivity: true })).toEqual(others);
    expect(await sessionRow(bystanderSession)).toBeDefined();

    // Recovery logout is not an authorized action: it deletes the presented administrator row only.
    const beforeLogout = await stored({ withoutActivity: true });
    const loggedOut = await signOut(asRecovery);
    expect(loggedOut.headers.get("location")).toBe("/admin/sign-in");
    expect(await sessionRow(administrator)).toBeUndefined();
    const afterLogout = await stored({ withoutActivity: true });
    expect(afterLogout.administrator_session).toHaveLength((beforeLogout.administrator_session?.length ?? 0) - 1);
    expect({ ...afterLogout, administrator_session: [] }).toEqual({ ...beforeLogout, administrator_session: [] });
    expect(await sessionRow(bystanderSession)).toBeDefined();
  });
});

describe("H-R6 to H-R8: start, completion and regeneration", () => {
  it("H-R6: start shows the secret once with both warnings, origin Q; a replay replaces the factor", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    const answer = await start(recovery);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.getSetCookie()).toEqual([]);
    const first = await started(answer);
    expect(first.html).toContain(WARNINGS.startAfter);
    expect(first.html).toContain("otpauth://totp/");
    expect(first.html).toContain("synthetic%20administrator");
    const factor = await factorOf(account);
    expect(factor).toMatchObject({ state: "pending_confirmation", factor_id: first.factorId });
    expect(factor.origin).not.toBeNull();

    const second = await started(await start(recovery));
    expect(second.factorId).not.toBe(first.factorId);
    const refused = await complete(recovery, first.factorId, totpCodeAt(first.secret, Date.now()));
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Code not accepted");
    expect((await complete(recovery, second.factorId, totpCodeAt(second.secret, Date.now()))).headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
  });

  it("H-R7: refused codes keep the attempt open with one template; the right code completes; a replay cannot repeat it", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    const begun = await started(await start(recovery));
    const otherAccount = await provision();
    const otherRecovery = await recoveryFor(otherAccount);
    const otherBegun = await started(await start(otherRecovery));
    const normalize = (html: string) => html.replace(/<h2>Try again<\/h2>\n<form[\s\S]*?<\/form>\n/, "");

    const documents: string[] = [];
    for (const [label, factorId, code] of [
      ["a wrong code", begun.factorId, String((Number(totpCodeAt(begun.secret, Date.now())) + 500_000) % 1_000_000).padStart(6, "0")],
      ["another session's factor_id", otherBegun.factorId, totpCodeAt(otherBegun.secret, Date.now())],
      ["an unknown factor_id", "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", totpCodeAt(begun.secret, Date.now())],
    ] as const) {
      const before = await stored();
      const answer = await complete(recovery, factorId, code);
      expect(answer.status, label).toBe(200);
      expect(answer.headers.getSetCookie(), label).toEqual([]);
      const html = await answer.text();
      expect(html, label).toContain(`name="factor_id" value="${factorId}"`);
      expect(html, label).not.toContain(new Secret({ buffer: new Uint8Array(begun.secret).buffer }).base32);
      documents.push(normalize(html.replace(factorId, "X")));
      expect(await stored(), `${label}: nothing written or counted`).toEqual(before);
    }

    expect(new Set(documents).size).toBe(1);

    // Invalid factor_id values never reach a completion statement (§3.4 step 5).
    for (const hostile of ["not-a-uuid", begun.factorId.toUpperCase(), `{${begun.factorId}}`, `${begun.factorId}0`, `"><script>x</script>`, "x' or '1'='1"]) {
      const mark = sent.length;
      const answer = await complete(recovery, hostile, "123456");
      const html = await answer.text();
      expect(answer.status, hostile).toBe(200);
      expect(sent.slice(mark).filter((label) => label !== "sql"), hostile).toEqual(["lock-session", "check-session"]);
      expect(html, hostile).not.toContain('name="factor_id"');
      expect(html, hostile).not.toContain(hostile);
      expect(normalize(html), hostile).toBe(documents[0]);
    }

    // The right code against the same factor_id completes.
    const done = await complete(recovery, begun.factorId, totpCodeAt(begun.secret, Date.now()));
    expect(done.status).toBe(200);
    expect(done.headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
    const fresh = codesIn(await done.text());
    expect(fresh).toHaveLength(10);
    expect(await sessionRow(recovery)).toBeUndefined();
    expect(await factorOf(account)).toMatchObject({ state: "active", factor_id: begun.factorId, origin: null });
    expect(await codeRows(account)).toBe(10);

    // A replay finds no session; the factor and codes are unchanged.
    const before = await stored({ withoutActivity: true });
    const replay = await complete(recovery, begun.factorId, totpCodeAt(begun.secret, Date.now()));
    expect(replay.headers.get("location")).toBe(FAILURE_LOCATION);
    expect(replay.headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
    expect(await stored({ withoutActivity: true })).toEqual(before);

    // The new TOTP signs in; an old code and the old TOTP do not.
    expect(await administratorFor(account, begun.secret)).not.toBe("");
    const old = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[5] ?? "" }), await challengeFor(account)), options());
    expect(old.headers.get("location")).toBe(FAILURE_LOCATION);
    const oldTotp = await codeEntry(post("/admin/sign-in/code/verify", form({ code: totpCodeAt(account.secret, Date.now() + 30_000) }), await challengeFor(account)), options());
    expect(oldTotp.headers.get("location")).toBe(FAILURE_LOCATION);
    const viaNew = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: fresh[0] ?? "" }), await challengeFor(account)), options());
    expect(viaNew.headers.get("location")).toBe("/admin/recovery");
  });

  it("H-R8: regeneration shows ten new codes, keeps the session and the counter; a replay replaces them again", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    // A counted failure while Q is live, so regeneration's "counter not cleared" (RA-9) is observable.
    await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: "ffffffff-ffffffff-ffffffff-ffffffff" }), await challengeFor(account)), options());
    const counter = async () => (await observer.query("select consecutive_failures as n from authentication_throttle where scope = 'recovery_code'")).rows[0]?.n;
    const counted = await counter();
    expect(counted).toBe(1);

    const first = await regenerate(recovery);
    expect(first.status).toBe(200);
    expect(first.headers.getSetCookie()).toEqual([]);
    const firstHtml = await first.text();
    expect(firstHtml).toContain(WARNINGS.codesAfter);
    const firstCodes = codesIn(firstHtml);
    expect(firstCodes).toHaveLength(10);
    expect(await counter()).toBe(counted);
    expect(await sessionRow(recovery)).toBeDefined();

    const secondCodes = codesIn(await (await regenerate(recovery)).text());
    expect(secondCodes).toHaveLength(10);
    expect(secondCodes.filter((code) => firstCodes.includes(code))).toEqual([]);
    expect(await codeRows(account)).toBe(10);

    await signOut(recovery);
    const earlier = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: firstCodes[0] ?? "" }), await challengeFor(account)), options());
    expect(earlier.headers.get("location")).toBe(FAILURE_LOCATION);
    const latest = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: secondCodes[0] ?? "" }), await challengeFor(account)), options());
    expect(latest.headers.get("location")).toBe("/admin/recovery");
  });
});

describe("H-R9, H-R10: logout and expiry", () => {
  it("H-R9: logout gives one completed answer for live, expired, unknown, absent, malformed and duplicated", async () => {
    const live = await provision();
    const liveCookie = await recoveryFor(live);
    const expired = await provision();
    const expiredCookie = await recoveryFor(expired);
    await ageSessions(expired, 20);
    const answers: string[] = [];
    const shape = async (response: Response) =>
      JSON.stringify({ status: response.status, location: response.headers.get("location"), cookies: response.headers.getSetCookie(), body: await response.text() });

    answers.push(await shape(await signOut(liveCookie)));
    expect(await sessionRow(liveCookie)).toBeUndefined();
    answers.push(await shape(await signOut(expiredCookie)));
    expect(await sessionRow(expiredCookie)).toBeUndefined();
    answers.push(await shape(await signOut(`${RECOVERY}=${randomBytes(32).toString("base64url")}`)));

    for (const cookie of [undefined, `${RECOVERY}=not-a-token`, `${liveCookie}; ${liveCookie}`]) {
      const mark = sent.length;
      answers.push(await shape(await signOut(cookie)));
      expect(sent.length - mark).toBe(0);
    }

    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? "{}")).toEqual({ status: 303, location: "/admin/sign-in", cookies: [CLEAR_RECOVERY], body: "" });
    expect((await start(liveCookie)).headers.get("location")).toBe(FAILURE_LOCATION);
  });

  it("H-R9: a storage failure is 503 with the cookie kept, and a retry completes", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    await resetAdministratorRuntimeForTests();
    let fail = true;
    const failing: RuntimeFactories = {
      ...observedFactories,
      createDatabase(connectionString) {
        const real = observedFactories.createDatabase(connectionString);
        const db = new Proxy(real.db, {
          get(target, property, receiver) {
            if (property === "getExecutor") {
              return () => {
                const executor = target.getExecutor();
                return new Proxy(executor, {
                  get(inner, name) {
                    const value = Reflect.get(inner, name, inner) as unknown;
                    if (name === "executeQuery") {
                      return (query: { sql: string }, ...rest: unknown[]) =>
                        fail && query.sql.includes("adr028:logout") ? Promise.reject(new Error("injected")) : (value as (...a: unknown[]) => unknown).call(inner, query, ...rest);
                    }
                    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(inner) : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        return { db, shutdown: real.shutdown };
      },
    };

    try {
      const failed = await recoverySignOutEntry(post("/admin/recovery/sign-out", "", recovery), { environment, factories: failing, log: () => undefined });
      expect(failed.status).toBe(503);
      expect(failed.headers.get("retry-after")).toBe("5");
      expect(failed.headers.getSetCookie()).toEqual([]);
      expect(await sessionRow(recovery)).toBeDefined();
      fail = false;
      const retried = await recoverySignOutEntry(post("/admin/recovery/sign-out", "", recovery), { environment, factories: failing, log: () => undefined });
      expect(retried.headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
      expect(await sessionRow(recovery)).toBeUndefined();
    } finally {
      await resetAdministratorRuntimeForTests();
    }
  });

  it("H-R10: a recovery session past 15 minutes is refused by every action and by the check, despite fresh activity", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    expect(await recoverySessionOf(configuration(), tokenOf(recovery), { factories: observedFactories, log: () => undefined })).toBe("valid");
    const absolute = (await sessionRow(recovery))?.absolute;
    expect(await recoverySessionOf(configuration(), tokenOf(recovery), { factories: observedFactories, log: () => undefined })).toBe("valid");
    expect((await sessionRow(recovery))?.absolute, "activity never extends it").toBe(absolute);

    await observer.query(
      "update administrator_session set created_at = created_at - interval '16 minutes', absolute_expires_at = absolute_expires_at - interval '16 minutes' where administrator_id = $1",
      [account.id],
    );
    const before = await stored({ withoutActivity: true });

    expect(await recoverySessionOf(configuration(), tokenOf(recovery), { factories: observedFactories, log: () => undefined })).toBe("refused");
    for (const answer of [await start(recovery), await regenerate(recovery), await complete(recovery, "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", "123456")]) {
      expect(answer.headers.get("location")).toBe(FAILURE_LOCATION);
      expect(answer.headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
    }
    expect(await stored({ withoutActivity: true })).toEqual(before);
  });
});

describe("H-R11: cookie cleanup", () => {
  it("a TOTP sign-in clears a stale recovery cookie; the exact headers of every class B row", async () => {
    const account = await provision();
    const stale = await recoveryFor(account, account.codes[0]);
    const begun = await started(await start(stale));
    const fresh = codesIn(await (await complete(stale, begun.factorId, totpCodeAt(begun.secret, Date.now()))).text());
    expect(fresh).toHaveLength(10);

    const challenge = await challengeFor(account);
    const signedIn = await codeEntry(post("/admin/sign-in/code/verify", form({ code: totpCodeAt(begun.secret, Date.now() + 30_000) }), `${challenge}; ${stale}`), options());
    const cookies = signedIn.headers.getSetCookie();
    expect(cookies[0]).toBe(CLEAR_CHALLENGE);
    expect(cookies[1]).toMatch(/^__Host-admin-session=[A-Za-z0-9_-]{43}; /);
    expect(cookies[2]).toBe(CLEAR_RECOVERY);
    expect(cookies).toHaveLength(3);

    // A refused completion keeps the cookie; regeneration and a start send none.
    const recovery = await recoveryFor(account, fresh[0]);
    expect((await start(recovery)).headers.getSetCookie()).toEqual([]);
    expect((await regenerate(recovery)).headers.getSetCookie()).toEqual([]);
    expect((await complete(recovery, "0b5f2a8e-3c1d-4e6f-9a7b-1c2d3e4f5a6b", "123456")).headers.getSetCookie()).toEqual([]);
  });
});

describe("H-R12: response loss after commit (server state and conditional next steps only)", () => {
  it("a lost acceptance: another known code opens a new session, deleting the lost one", async () => {
    const account = await provision();
    const challenge = await challengeFor(account);
    // Case (b): the response is discarded whole.
    await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[0] ?? "" }), challenge), options());
    expect(await liveSessions(account)).toBe(1);
    const next = await recoveryFor(account, account.codes[1]);
    expect(await liveSessions(account)).toBe(1);
    expect(await recoverySessionOf(configuration(), tokenOf(next), { factories: observedFactories, log: () => undefined })).toBe("valid");
  });

  it("a lost acceptance of the last stored code, then Q's end: database state O-1 (zero code rows, no active factor)", async () => {
    const account = await provision();
    // Arranged state, written by setup: only the first displayed code remains stored.
    await observer.query("delete from administrator_recovery_code where administrator_id = $1 and code_digest <> $2", [account.id, recoveryCodeDigest(account.codes[0] ?? "")]);
    expect(await codeRows(account)).toBe(1);
    // Case (b): the acceptance's response is discarded whole, so Q's token is never held.
    const answer = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: account.codes[0] ?? "" }), await challengeFor(account)), options());
    expect(answer.headers.get("location")).toBe("/admin/recovery");
    await ageSessions(account, 20);
    expect(await codeRows(account)).toBe(0);
    expect((await factorOf(account)).state).not.toBe("active");
    expect(await liveSessions(account)).toBe(0);
  });

  it("a lost start: a repeated start replaces the factor; after Q ends, a known code discards it", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    await start(recovery);
    const lostFactor = (await factorOf(account)).factor_id;
    const replaced = await started(await start(recovery));
    expect(replaced.factorId).not.toBe(lostFactor);
    await signOut(recovery);
    await recoveryFor(account, account.codes[1]);
    expect((await factorOf(account)).state).toBe("reenrolment_required");
  });

  it("a lost regeneration: while Q lives, a repeat restores known codes; if Q ends first, operational lockout, not state O", async () => {
    const recovered = await provision();
    const recovery = await recoveryFor(recovered);
    await regenerate(recovery);
    const known = codesIn(await (await regenerate(recovery)).text());
    expect(known).toHaveLength(10);

    const locked = await provision();
    const lockedRecovery = await recoveryFor(locked);
    await regenerate(lockedRecovery);
    await signOut(lockedRecovery);
    expect(await codeRows(locked)).toBe(10);
    expect((await factorOf(locked)).state).not.toBe("active");
    expect(await liveSessions(locked)).toBe(0);
    // Every code the user knew was deleted by the lost regeneration.
    const old = await recoveryCodeEntry(post("/admin/sign-in/recovery/verify", form({ code: locked.codes[1] ?? "" }), await challengeFor(locked)), options());
    expect(old.headers.get("location")).toBe(FAILURE_LOCATION);
  });

  it("a lost completion body (case a): the cookie cleared, ten unknown codes stored, and the new TOTP signs in", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    const begun = await started(await start(recovery));
    const response = await complete(recovery, begun.factorId, totpCodeAt(begun.secret, Date.now()));
    // Case (a): headers kept and applied, body discarded.
    expect(response.headers.getSetCookie()).toEqual([CLEAR_RECOVERY]);
    await response.body?.cancel();
    expect(await codeRows(account)).toBe(10);
    expect((await factorOf(account)).state).toBe("active");
    expect(await administratorFor(account, begun.secret)).not.toBe("");
  });
});

describe("H-R13: logging and secrecy", () => {
  it("logs only the permitted fields; no secret, code or token in any log line, Location or URL-bearing attribute", async () => {
    const account = await provision();
    const recovery = await recoveryFor(account);
    const responses: Response[] = [];
    responses.push(await start(recovery));
    const startHtml = await responses[0]!.clone().text();
    const begun = await started(responses[0]!.clone());
    responses.push(await regenerate(recovery));
    responses.push(await complete(recovery, begun.factorId, "000000"));
    responses.push(await complete(recovery, begun.factorId, totpCodeAt(begun.secret, Date.now())));

    const secrets = [
      ...account.codes,
      ...account.codes.map((code) => code.replace(/-/g, "")),
      new Secret({ buffer: new Uint8Array(begun.secret).buffer }).base32,
      begun.secret.toString("hex"),
      tokenOf(recovery),
    ];
    const htmls = await Promise.all(responses.map((response) => response.clone().text()));
    for (const html of htmls) {
      secrets.push(...codesIn(html));
    }

    for (const line of lines) {
      const logged = JSON.parse(line) as Record<string, string>;
      expect(Object.keys(logged).sort()).toEqual(["at", "entry", "event", "outcome"]);
      for (const secret of secrets) {
        expect(line).not.toContain(secret);
      }
    }

    for (const [index, response] of responses.entries()) {
      const html = htmls[index] ?? "";
      const urls = [response.headers.get("location") ?? "", ...[...html.matchAll(/\s(?:href|src|action|formaction|srcset|poster|data)="([^"]*)"/g)].map((match) => match[1] ?? "")];
      for (const url of urls) {
        for (const secret of secrets) {
          expect(url).not.toContain(secret);
        }
        expect(url).not.toContain("otpauth");
      }
    }

    expect(startHtml.match(/otpauth:\/\//g)).toHaveLength(1);
    expect(htmls.slice(1).some((html) => html.includes("otpauth"))).toBe(false);
  });
});
