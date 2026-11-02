/**
 * The entry points against a real PostgreSQL (issue #260 §6.4 H-1 to H-8), at the handler
 * boundary: plain `Request` in, `Response` out, through the real gate, request checks, runtime,
 * sign-in steps and storage. Uniformity is asserted on what these handlers construct (status,
 * headers other than `Date`, body); no timing equivalence is claimed, and none of this completes
 * `BI-4`.
 */

import { randomBytes } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { Secret } from "otpauth";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { provisionSyntheticAdministrator } from "../../../scripts/local-demo/administrator-provisioning";
import type { AdministratorAuthenticationDatabase } from "../../data/administrator-authentication-table";
import { createListingPersistence, type ListingPersistence } from "../../data/connection";
import { useEmbeddedPostgres } from "../../data/testing/embedded-cluster";
import { HashLimiter } from "../../domain/administrator-auth/hash-limiter";
import { totpCodeAt } from "../../domain/administrator-auth/totp";
import { LOCAL_DEMO_DATABASE_URL } from "../public/local-demo-persistence";
import { DEFAULT_FACTORIES, resetAdministratorRuntimeForTests } from "./authentication-runtime";
import { codeEntry, FAILURE_LOCATION, passwordEntry, signOutEntry, type EntryOptions } from "./entry-points";
import { LOCAL_ADMIN_ORIGIN, LOCAL_ADMIN_THROTTLE_KEY, LOCAL_ADMIN_TOTP_KEY_V1, localAdministratorConfigurationOf } from "./local-gate";
import { administratorSessionOf } from "./require-administrator";

// Real scrypt derivations (about 0.7 s each) run through the real limiter in these tests.
vi.setConfig({ testTimeout: 120_000 });

const DATABASE = "admin_journey";
const cluster = useEmbeddedPostgres({ slug: "admin-journey", databases: [DATABASE], migrate: [DATABASE] });

const ORIGIN = "https://127.0.0.1:3000";
const TOTP_KEY = randomBytes(32);
const THROTTLE_KEY = randomBytes(32);
let environment: Record<string, string>;
let persistence: ListingPersistence;
let db: Kysely<AdministratorAuthenticationDatabase>;
const lines: string[] = [];

beforeAll(() => {
  environment = {
    NODE_ENV: "development",
    [LOCAL_DEMO_DATABASE_URL]: cluster.connectionStringFor(DATABASE),
    [LOCAL_ADMIN_ORIGIN]: ORIGIN,
    [LOCAL_ADMIN_TOTP_KEY_V1]: TOTP_KEY.toString("base64url"),
    [LOCAL_ADMIN_THROTTLE_KEY]: THROTTLE_KEY.toString("base64url"),
  };
  persistence = createListingPersistence({ pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 2 } });
  db = persistence.db as unknown as Kysely<AdministratorAuthenticationDatabase>;
  cluster.closeBeforeShutdown("journey pool", () => persistence.shutdown());
  cluster.closeBeforeShutdown("runtime", () => resetAdministratorRuntimeForTests());
});

afterEach(async () => {
  lines.length = 0;
  await sql`delete from authentication_throttle`.execute(db);
  await sql`delete from authentication_source_window`.execute(db);
});

const options = (extra: Partial<EntryOptions> = {}): EntryOptions => ({ environment, log: (line) => lines.push(line), ...extra });

function post(path: string, body: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Host: "127.0.0.1:3000",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body,
  });
}

const passwordForm = (username: string, password: string) => new URLSearchParams({ username, password }).toString();

interface Account {
  readonly username: string;
  readonly password: string;
  readonly secret: Buffer;
}

async function provision(password = `synthetic journey ${randomBytes(8).toString("hex")}`): Promise<Account> {
  const username = `synthetic-${randomBytes(5).toString("hex")}`;
  const said: string[] = [];
  const answers = [password, password];
  let secret = Buffer.alloc(0);
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
    { db, clock: Date.now, totpKey: TOTP_KEY, environment: {}, databaseUrl: cluster.connectionStringFor(DATABASE) },
  );

  expect(result.ok).toBe(true);
  return { username, password, secret };
}

const cookieValue = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(";")[0];

async function shape(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== "date").sort();
  return { status: response.status, headers, body: await response.text() };
}

const outcomes = () => lines.map((line) => (JSON.parse(line) as { outcome: string }).outcome);
const count = async (table: string) => (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)).rows[0]?.n ?? 0;

async function challengeFor(account: Account): Promise<string> {
  const answer = await passwordEntry(post("/admin/sign-in/password", passwordForm(account.username, account.password)), options());
  const challenge = cookieValue(answer, "__Host-admin-challenge");
  expect(challenge).toBeDefined();
  return challenge ?? "";
}

describe("the password entry point", () => {
  it("H-1: a correct password sets only the challenge cookie, and no session exists yet", async () => {
    const account = await provision();
    const before = await count("administrator_session");
    const answer = await passwordEntry(post("/admin/sign-in/password", passwordForm(account.username, account.password)), options());

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/admin/sign-in/code");
    expect(answer.headers.getSetCookie()).toHaveLength(1);
    expect(answer.headers.getSetCookie()[0]).toMatch(/^__Host-admin-challenge=[A-Za-z0-9_-]+; Max-Age=(29\d|300); Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    expect(await count("administrator_session")).toBe(before);
    expect(outcomes()).toEqual(["CHALLENGE_ISSUED"]);
  });

  it("H-2: wrong, unknown, throttled and password-disabled all give the same generic answer", async () => {
    const known = await provision();
    const disabled = await provision();
    await sql`update administrator set password_disabled_at = now() where username = ${disabled.username}`.execute(db);

    const wrong = await shape(await passwordEntry(post("/admin/sign-in/password", passwordForm(known.username, "not the password at all")), options()));
    const unknown = await shape(await passwordEntry(post("/admin/sign-in/password", passwordForm("synthetic-nobody-here", "not the password at all")), options()));
    const disabledAnswer = await shape(await passwordEntry(post("/admin/sign-in/password", passwordForm(disabled.username, disabled.password)), options()));

    for (let i = 0; i < 4; i += 1) {
      await passwordEntry(post("/admin/sign-in/password", passwordForm(known.username, "not the password at all")), options());
    }

    const throttled = await shape(await passwordEntry(post("/admin/sign-in/password", passwordForm(known.username, known.password)), options()));

    expect(wrong).toEqual({ status: 303, headers: [["cache-control", "no-store"], ["location", FAILURE_LOCATION]], body: "" });
    expect(unknown).toEqual(wrong);
    expect(disabledAnswer).toEqual(wrong);
    expect(throttled).toEqual(wrong);
    expect(outcomes()).toEqual(["FAILED", "FAILED", "REFUSED", "FAILED", "FAILED", "FAILED", "FAILED", "THROTTLED"]);
  });

  it("H-8: the submitted password is NFC-normalized before verification", async () => {
    const composed = "café synthetic passphrase";
    const account = await provision(composed);
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);

    const answer = await passwordEntry(post("/admin/sign-in/password", passwordForm(account.username, decomposed)), options());
    expect(answer.headers.get("location")).toBe("/admin/sign-in/code");
  });
});

describe("overload (H-3)", () => {
  it("an overloaded limiter gives 503 with Retry-After, the same for known and unknown names, uncounted", async () => {
    const account = await provision();
    await resetAdministratorRuntimeForTests();
    const narrow = { ...DEFAULT_FACTORIES, createLimiter: () => new HashLimiter({ maxRunning: 1, maxQueued: 0 }) };
    const later = <T>(work: () => Promise<T>) => new Promise<T>((resolve, reject) => setTimeout(() => work().then(resolve, reject), 150));

    try {
      // Initialize the narrow runtime first, so the timing below concerns only the hash slot.
      await passwordEntry(post("/admin/sign-in/password", passwordForm("synthetic-warm-up", "not the password at all")), options({ factories: narrow }));
      lines.length = 0;

      const [first, known, unknown] = await Promise.all([
        passwordEntry(post("/admin/sign-in/password", passwordForm("synthetic-holds-the-slot", "not the password at all")), options({ factories: narrow })),
        later(() => passwordEntry(post("/admin/sign-in/password", passwordForm(account.username, account.password)), options({ factories: narrow }))),
        later(() => passwordEntry(post("/admin/sign-in/password", passwordForm("synthetic-nobody-here", "not the password at all")), options({ factories: narrow }))),
      ]);
      const knownShape = await shape(known);

      expect(first.status).toBe(303);
      expect(knownShape).toEqual({
        status: 503,
        headers: [["cache-control", "no-store"], ["content-type", "text/plain; charset=utf-8"], ["retry-after", "5"]],
        body: "Try again later.",
      });
      expect(await shape(unknown)).toEqual(knownShape);
      expect(outcomes().sort()).toEqual(["FAILED", "OVERLOADED", "OVERLOADED"]);
      // The warm-up and the slot holder were counted; neither overloaded request was.
      expect(await count("authentication_throttle")).toBe(2);
    } finally {
      await resetAdministratorRuntimeForTests();
    }
  });
});

describe("the code entry point and the session check", () => {
  it("H-4: a correct code issues one session; a duplicate of the challenge and a replayed code do not", async () => {
    const account = await provision();
    const challenge = await challengeFor(account);
    const code = totpCodeAt(account.secret, Date.now() + 30_000);
    const answers = await Promise.all([
      codeEntry(post("/admin/sign-in/code/verify", `code=${code}`, challenge), options()),
      codeEntry(post("/admin/sign-in/code/verify", `code=${code}`, challenge), options()),
    ]);
    const issued = answers.filter((answer) => answer.headers.get("location") === "/admin");
    const refused = answers.filter((answer) => answer.headers.get("location") !== "/admin");

    expect(issued).toHaveLength(1);
    expect(issued[0]?.headers.getSetCookie()).toEqual([
      "__Host-admin-challenge=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
      expect.stringMatching(/^__Host-admin-session=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Strict$/),
    ]);
    expect(await shape(refused[0] as Response)).toEqual({
      status: 303,
      headers: [["cache-control", "no-store"], ["location", FAILURE_LOCATION], ["set-cookie", "__Host-admin-challenge=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict"]],
      body: "",
    });

    const replay = await codeEntry(post("/admin/sign-in/code/verify", `code=${code}`, await challengeFor(account)), options());
    expect(replay.headers.get("location")).toBe(FAILURE_LOCATION);
  });

  it("H-5: only a valid administrator session passes; a challenge token, a random and a malformed token do not", async () => {
    const account = await provision();
    const challenge = await challengeFor(account);
    const answer = await codeEntry(post("/admin/sign-in/code/verify", `code=${totpCodeAt(account.secret, Date.now() + 30_000)}`, challenge), options());
    const session = cookieValue(answer, "__Host-admin-session")?.split("=")[1];
    const configuration = localAdministratorConfigurationOf(environment);
    expect(configuration).toBeDefined();

    const check = (token: string | undefined) => administratorSessionOf(configuration!, token, { log: () => undefined });
    expect(await check(session)).toBe("valid");
    expect(await check(challenge.split("=")[1])).toBe("refused");
    expect(await check(randomBytes(32).toString("base64url"))).toBe("refused");
    expect(await check("not-a-token")).toBe("refused");
    expect(await check(undefined)).toBe("refused");
  });

  it("H-6: logout deletes the session; with no cookie or an unknown cookie the answer is identical", async () => {
    const account = await provision();
    const challenge = await challengeFor(account);
    const answer = await codeEntry(post("/admin/sign-in/code/verify", `code=${totpCodeAt(account.secret, Date.now() + 30_000)}`, challenge), options());
    const session = cookieValue(answer, "__Host-admin-session") ?? "";
    const configuration = localAdministratorConfigurationOf(environment)!;
    const before = await count("administrator_session");

    const loggedOut = await shape(await signOutEntry(post("/admin/sign-out", "", session), options()));
    expect(await count("administrator_session")).toBe(before - 1);
    expect(await administratorSessionOf(configuration, session.split("=")[1], { log: () => undefined })).toBe("refused");

    expect(await shape(await signOutEntry(post("/admin/sign-out", ""), options()))).toEqual(loggedOut);
    expect(await shape(await signOutEntry(post("/admin/sign-out", "", `__Host-admin-session=${randomBytes(32).toString("base64url")}`), options()))).toEqual(loggedOut);
    expect(loggedOut).toEqual({
      status: 303,
      headers: [["cache-control", "no-store"], ["location", "/admin/sign-in"], ["set-cookie", "__Host-admin-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict"]],
      body: "",
    });
  });
});

describe("sign-out failure, retry and replay (H-6)", () => {
  it("a failed deletion is not presented as completed; a retry completes it, and a replayed token gets the no-session answer", async () => {
    await resetAdministratorRuntimeForTests();
    let failLogout = false;
    // The runtime's real pool, except that the logout statement fails while `failLogout` is set.
    const failable = {
      ...DEFAULT_FACTORIES,
      createDatabase(connectionString: string) {
        const real = DEFAULT_FACTORIES.createDatabase(connectionString);
        const db = new Proxy(real.db, {
          get(target, property, receiver) {
            if (property !== "getExecutor") {
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }

            return () => {
              const executor = target.getExecutor();
              return new Proxy(executor, {
                get(inner, name) {
                  const value = Reflect.get(inner, name, inner) as unknown;

                  if (name === "executeQuery") {
                    return (query: { sql: string }, ...rest: unknown[]) => {
                      if (failLogout && query.sql.includes("adr028:logout")) {
                        return Promise.reject(new Error("injected storage failure"));
                      }

                      return (value as (...args: unknown[]) => unknown).call(inner, query, ...rest);
                    };
                  }

                  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
                },
              });
            };
          },
        });

        return { db, shutdown: real.shutdown };
      },
    };

    try {
      const account = await provision();
      const challengeAnswer = await passwordEntry(post("/admin/sign-in/password", passwordForm(account.username, account.password)), options({ factories: failable }));
      const challenge = cookieValue(challengeAnswer, "__Host-admin-challenge") ?? "";
      const issued = await codeEntry(post("/admin/sign-in/code/verify", `code=${totpCodeAt(account.secret, Date.now() + 30_000)}`, challenge), options({ factories: failable }));
      const session = cookieValue(issued, "__Host-admin-session") ?? "";
      const configuration = localAdministratorConfigurationOf(environment)!;
      const before = await count("administrator_session");
      expect(session).not.toBe("");
      lines.length = 0;

      // Failure: not presented as completed, the cookie kept, the session still valid.
      failLogout = true;
      const failed = await shape(await signOutEntry(post("/admin/sign-out", "", session), options({ factories: failable })));
      failLogout = false;
      expect(failed).toEqual({
        status: 503,
        headers: [["cache-control", "no-store"], ["content-type", "text/plain; charset=utf-8"], ["retry-after", "5"]],
        body: "Sign-out did not complete. You may still be signed in; go back and try again.",
      });
      expect(await count("administrator_session")).toBe(before);
      expect(await administratorSessionOf(configuration, session.split("=")[1], { log: () => undefined })).toBe("valid");

      // Retry with the same cookie: completed, deleted, the cookie cleared.
      const retried = await shape(await signOutEntry(post("/admin/sign-out", "", session), options({ factories: failable })));
      expect(retried).toEqual({
        status: 303,
        headers: [["cache-control", "no-store"], ["location", "/admin/sign-in"], ["set-cookie", "__Host-admin-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict"]],
        body: "",
      });
      expect(await count("administrator_session")).toBe(before - 1);
      expect(await administratorSessionOf(configuration, session.split("=")[1], { log: () => undefined })).toBe("refused");

      // Replay of the deleted token: the same completed answer as no session or an unknown one.
      const replayed = await shape(await signOutEntry(post("/admin/sign-out", "", session), options({ factories: failable })));
      expect(replayed).toEqual(retried);
      expect(await shape(await signOutEntry(post("/admin/sign-out", ""), options({ factories: failable })))).toEqual(retried);
      expect(await count("administrator_session")).toBe(before - 1);

      const recorded = outcomes();
      expect(recorded).toHaveLength(4);
      expect(recorded[0]).not.toBe("LOGGED_OUT");
      expect(recorded.slice(1)).toEqual(["LOGGED_OUT", "LOGGED_OUT", "NO_SESSION"]);
    } finally {
      await resetAdministratorRuntimeForTests();
    }
  });
});

describe("the outcome log (H-7)", () => {
  it("records only the entry point, the outcome code and a timestamp; canaries never appear", async () => {
    const account = await provision();
    const canaryPassword = `canary-password-${randomBytes(6).toString("hex")}`;
    await passwordEntry(post("/admin/sign-in/password", passwordForm(account.username, canaryPassword)), options());
    const challenge = await challengeFor(account);
    await codeEntry(post("/admin/sign-in/code/verify", "code=000000", challenge), options());
    await signOutEntry(post("/admin/sign-out", "", `__Host-admin-session=${randomBytes(32).toString("base64url")}`), options());

    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);

    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(["at", "entry", "event", "outcome"]);
    }

    const canaries = [
      account.username,
      account.password,
      canaryPassword,
      challenge.split("=")[1] ?? "unreachable",
      TOTP_KEY.toString("base64url"),
      THROTTLE_KEY.toString("base64url"),
      cluster.connectionStringFor(DATABASE),
      "127.0.0.1",
    ];

    for (const canary of canaries) {
      expect(all).not.toContain(canary);
    }
  });
});
