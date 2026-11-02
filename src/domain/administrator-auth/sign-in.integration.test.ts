/**
 * The sign-in steps against a real PostgreSQL, including the `ADR-028` D-17 accounting bound
 * (issue #258, §6 D).
 *
 * D-17 is accepted **only for synthetic local use**, and only once the bound is tested. These
 * tests check it as a function of P, the number of limiter instances (one per process that
 * handles sign-in), for P = 1 and P = 2. **Measuring the real P of the local development server
 * is the journey slice's work**: no process serves sign-in in this unit.
 *
 * A negative control shows that releasing a failed verification's slot before its accounting
 * commits breaks the bound. That variant exists only in this file.
 *
 * Some tests inject a fault at one labelled statement: the wrapper raises an error shaped as
 * `pg` builds a server error, before sending that statement, or reports it as affecting zero
 * rows. Real server-raised failures are covered in `administrator-authentication.integration`.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";

import * as auth from "../../data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../data/administrator-authentication-table";
import { startupOptionsFor } from "../../data/connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../data/testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "../../data/timestamp-parser";
import { HashLimiter } from "./hash-limiter";
import { keyedDigest } from "./keyed-digest";
import { createDummyPasswordHash, hashPassword, verifyPassword } from "./password-hash";
import { sealTotpSecret } from "./secret-box";
import { passwordStep, totpStep, type PasswordVerifier, type SignInDependencies } from "./sign-in";
import { generateToken } from "./token";
import { generateTotpSecret, totpCodeAt, totpStepAt } from "./totp";

type Row = Record<string, unknown>;

interface PgClient {
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  release(destroy?: boolean | Error): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface PgPool {
  connect(): Promise<PgClient>;
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as {
  Pool: new (config: Record<string, unknown>) => PgPool;
  DatabaseError: new (message: string, length: number, name: string) => Error;
};

const DATABASE = "auth_sign_in";

const cluster = useEmbeddedPostgres({ slug: "auth-sign-in", databases: [DATABASE], migrate: [DATABASE] });

const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const STUB_HASH = "scrypt$ln=17,r=8,p=1$c3R1Yi1zYWx0LTE2Ynl0ZQ$c3R1Yi1rZXk";
const HASH_TIMEOUT_MS = 120_000;

let current = NOW;
const clock: auth.Clock = () => current;

/** Events in order: statement labels, `commit`, and whatever the test's own stubs record. */
const events: string[] = [];

/** Every labelled statement the operations sent, in order. */
const labels: string[] = [];

interface Fault {
  /** Which execution of the label to attack, counting from 1 after `injectFault`. */
  readonly occurrence: number;
  readonly kind: "error" | "zero";
  readonly sqlState?: string;
  readonly message?: string;
  readonly detail?: string;
}

const faults = new Map<string, Fault>();
const executions = new Map<string, number>();

function injectFault(label: string, fault: Fault): void {
  faults.set(label, fault);
  executions.clear();
}

function clearFaults(): void {
  faults.clear();
  executions.clear();
}

function labelOf(text: string): string | undefined {
  const start = "/* adr028:";
  return text.startsWith(start) ? text.slice(start.length, text.indexOf(" */")) : undefined;
}

let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;
let dummyPasswordHash: string;

function createPool(applicationName: string, max: number): PgPool {
  const pool = new pg.Pool({
    connectionString: cluster.connectionStringFor(DATABASE),
    max,
    types: createTimestamptzTypeOverrides(),
    options: startupOptionsFor({ application_name: applicationName }),
  });
  pool.on("error", () => undefined);
  pool.on("connect", (client) => (client as PgClient).on("error", () => undefined));
  return pool;
}

beforeAll(async () => {
  const pool = createPool("adr028_sign_in", 24);
  const logged = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          const label = labelOf(text);
          const fault = label === undefined ? undefined : faults.get(label);
          let attacked = false;

          if (label !== undefined) {
            labels.push(label);
            const execution = (executions.get(label) ?? 0) + 1;
            executions.set(label, execution);
            attacked = fault?.occurrence === execution;
          }

          if (attacked && fault?.kind === "error") {
            throw Object.assign(new pg.DatabaseError(fault.message ?? "injected test fault", 0, "error"), {
              severity: "ERROR",
              code: fault.sqlState,
              detail: fault.detail,
            });
          }

          const result = await client.query(text, values);

          if (text === "commit") {
            events.push("commit");
          }

          return attacked && fault?.kind === "zero" ? { ...result, rows: [], rowCount: 0 } : result;
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    end: () => pool.end(),
  };

  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: logged as never }) });
  observer = createPool("adr028_sign_in_observer", 4);
  dummyPasswordHash = await createDummyPasswordHash();
  cluster.closeBeforeShutdown("sign-in operations", () => db.destroy());
  cluster.closeBeforeShutdown("sign-in observer", () => observer.end());
}, CLUSTER_TIMEOUT_MS);

function dependencies(limiter: HashLimiter, passwords: PasswordVerifier): SignInDependencies {
  return { db, clock, limiter, passwords, dummyPasswordHash, throttleKey: THROTTLE_KEY, totpKeys: TOTP_KEYS };
}

/** A verifier that always fails after a short computation, recording when it finishes. */
function failingVerifier(delayMs = 40): PasswordVerifier {
  return {
    verify: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push("verified");
      return false;
    },
  };
}

const usernameDigestOf = (username: string) => keyedDigest(THROTTLE_KEY, "password-username", username);
const sourceDigestOf = (address: string) => keyedDigest(THROTTLE_KEY, "source-address", address);

async function passwordCounter(username: string): Promise<number> {
  const { rows } = await observer.query<{ n: number }>(
    "select consecutive_failures as n from authentication_throttle where scope = 'password' and subject_digest = $1",
    [usernameDigestOf(username)],
  );
  return Number(rows[0]?.n ?? 0);
}

async function presetSourceFailures(address: string, count: number): Promise<void> {
  await observer.query(
    `insert into authentication_source_window (source_digest, recent_failures)
     values ($1, array(select to_timestamp($2::bigint / 1000.0) - make_interval(secs => g) from generate_series(1, $3::int) g))`,
    [sourceDigestOf(address), current, count],
  );
}

async function presetPasswordCounter(username: string, failures: number): Promise<void> {
  await observer.query(
    `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
     values ('password', $1, $2, null, to_timestamp($3::bigint / 1000.0))`,
    [usernameDigestOf(username), failures, current - 1_000],
  );
}

async function provision(passwordHash: string): Promise<{ id: string; username: string; secret: Buffer }> {
  const id = randomUUID();
  const username = `admin-${id.slice(0, 8)}`;
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const ok = <T>(stored: auth.Stored<T>): T => {
    if (!stored.ok) {
      throw new Error(JSON.stringify(stored.failure));
    }
    return stored.value;
  };

  ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash }, clock));
  ok(await auth.startTotpEnrolment(db, { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, secret) }, clock));
  ok(await auth.confirmTotpEnrolment(db, { administratorId: id, factorId, step: totpStepAt(current) }, clock));
  current += 60_000;
  return { id, username, secret };
}

class InstrumentedLimiter extends HashLimiter {
  override async acquire() {
    const slot = await super.acquire();

    if (slot === "overloaded") {
      return slot;
    }

    events.push("acquired");
    return {
      release: () => {
        if (!released.has(slot)) {
          released.add(slot);
          events.push("released");
        }
        slot.release();
      },
    };
  }
}

const released = new WeakSet<object>();

describe("the sign-in steps end to end", () => {
  it(
    "issues a challenge for the right password, a session for the right code, and verifies unknown accounts against the dummy",
    async () => {
      const admin = await provision(await hashPassword("a synthetic local password"));
      const seen: string[] = [];
      const real: PasswordVerifier = {
        verify: async (password, stored) => {
          seen.push(stored);
          return verifyPassword(password, stored);
        },
      };
      const deps = dependencies(new HashLimiter(), real);
      const sourceAddress = `127.0.0.${Math.floor(Math.random() * 200) + 2}`;

      const challenge = await passwordStep(deps, { username: admin.username.toUpperCase(), password: "a synthetic local password", sourceAddress });
      expect(challenge.code).toBe("CHALLENGE_ISSUED");

      if (challenge.code === "CHALLENGE_ISSUED") {
        const session = await totpStep(deps, {
          challengeToken: challenge.challengeToken,
          code: totpCodeAt(admin.secret, current),
          sourceAddress,
        });
        expect(session.code).toBe("SESSION_ISSUED");
      }

      expect((await passwordStep(deps, { username: admin.username, password: "wrong", sourceAddress })).code).toBe("FAILED");
      expect((await passwordStep(deps, { username: "nobody-here", password: "wrong", sourceAddress })).code).toBe("FAILED");
      expect(seen.at(-1)).toBe(dummyPasswordHash);
    },
    HASH_TIMEOUT_MS,
  );

  it("refuses a throttled request before any hash slot, and an overloaded one without counting it", async () => {
    const username = `throttled-${randomUUID().slice(0, 8)}`;
    await observer.query(
      `insert into authentication_throttle (scope, subject_digest, consecutive_failures, wait_until, last_failure_at)
       values ('password', $1, 5, to_timestamp($2::bigint / 1000.0), to_timestamp($2::bigint / 1000.0))`,
      [usernameDigestOf(username), current + 30_000],
    );
    const limiter = new HashLimiter();
    let calls = 0;
    const counting: PasswordVerifier = { verify: async () => ((calls += 1), false) };

    expect((await passwordStep(dependencies(limiter, counting), { username, password: "x", sourceAddress: "10.0.0.1" })).code).toBe("THROTTLED");
    expect(calls).toBe(0);
    expect(limiter.running).toBe(0);

    const full = new HashLimiter({ maxRunning: 1, maxQueued: 0 });
    const held = await full.acquire();
    const other = `overloaded-${randomUUID().slice(0, 8)}`;
    expect((await passwordStep(dependencies(full, counting), { username: other, password: "x", sourceAddress: "10.0.0.2" })).code).toBe("OVERLOADED");
    expect(await passwordCounter(other)).toBe(0);
    if (held !== "overloaded") {
      held.release();
    }
  });
});

describe("D-17: a failed verification holds its slot until its accounting commits", () => {
  it("commits each failure before the slot it held is released", async () => {
    const limiter = new InstrumentedLimiter({ maxRunning: 1 });
    const sourceAddress = `slot-${randomUUID()}`;
    events.length = 0;

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        passwordStep(dependencies(limiter, failingVerifier()), {
          username: `slot-${index}-${randomUUID().slice(0, 6)}`,
          password: "x",
          sourceAddress,
        }),
      ),
    );

    const order = events.filter((event) => ["acquired", "verified", "commit", "released"].includes(event));
    expect(order).toEqual(Array.from({ length: 4 }, () => ["acquired", "verified", "commit", "released"]).flat());
  });
});

/** The negative control: a variant that releases the slot BEFORE its accounting commits. */
async function releasingEarly(
  limiter: HashLimiter,
  request: { readonly username: string; readonly sourceAddress: string },
): Promise<"FAILED" | "REFUSED"> {
  const usernameDigest = usernameDigestOf(request.username);
  const sourceDigest = sourceDigestOf(request.sourceAddress);
  const admission = await auth.readPasswordAdmission(db, { sourceDigest, usernameDigest }, clock());

  if (!admission.ok || admission.value.sourceLimited || admission.value.waitActive) {
    return "REFUSED";
  }

  const slot = await limiter.acquire();

  if (slot === "overloaded") {
    return "REFUSED";
  }

  const recheck = await auth.readPasswordAdmission(db, { sourceDigest, usernameDigest }, clock());

  if (!recheck.ok || recheck.value.sourceLimited || recheck.value.waitActive) {
    slot.release();
    return "REFUSED";
  }

  await failingVerifier().verify("x", dummyPasswordHash);
  slot.release();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const counted = await auth.recordPasswordFailure(db, { administratorId: undefined, usernameDigest, sourceDigest }, clock);
  return counted.ok ? "FAILED" : "REFUSED";
}

describe("D-17: the accounting bound, as a function of P limiter instances", () => {
  for (const P of [1, 2]) {
    it(`exceeds a per-username threshold by at most 2P - 1 = ${2 * P - 1} (P = ${P})`, async () => {
      const username = `bound-${P}-${randomUUID().slice(0, 8)}`;
      await presetPasswordCounter(username, 4);
      const limiters = Array.from({ length: P }, () => new HashLimiter());
      const sourceAddress = `user-bound-${randomUUID()}`;

      const outcomes = await Promise.all(
        Array.from({ length: 10 * P }, (_, index) =>
          passwordStep(dependencies(limiters[index % P] as HashLimiter, failingVerifier()), { username, password: "x", sourceAddress }),
        ),
      );
      const final = await passwordCounter(username);

      expect(final).toBeGreaterThanOrEqual(5);
      expect(final - 5).toBeLessThanOrEqual(2 * P - 1);
      expect(outcomes.filter((outcome) => outcome.code === "FAILED")).toHaveLength(final - 4);
      expect(limiters.every((limiter) => limiter.running === 0 && limiter.queued === 0)).toBe(true);
    });

    it(`exceeds the source limit by at most 2P = ${2 * P}, with second-factor steps never past it (P = ${P})`, async () => {
      const sourceAddress = `source-bound-${randomUUID()}`;
      await presetSourceFailures(sourceAddress, 19);
      const limiters = Array.from({ length: P }, () => new HashLimiter());
      const admin = await provision(STUB_HASH);
      const challenges = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const token = generateToken();
          const issued = await auth.issuePasswordChallenge(
            db,
            { administratorId: admin.id, verifiedPasswordHash: STUB_HASH, usernameDigest: usernameDigestOf(admin.username), challengeDigest: token.digest },
            clock,
          );
          expect(issued.ok && issued.value.code).toBe("CHALLENGE_ISSUED");
          return token.token;
        }),
      );
      const valid = new Set([-30_000, 0, 30_000].map((offset) => totpCodeAt(admin.secret, current + offset)));
      const wrong = ["111111", "222222", "333333", "444444"].find((code) => !valid.has(code)) as string;

      const passwords = Array.from({ length: 10 * P }, (_, index) =>
        passwordStep(dependencies(limiters[index % P] as HashLimiter, failingVerifier()), {
          username: `spray-${index}-${randomUUID().slice(0, 6)}`,
          password: "x",
          sourceAddress,
        }),
      );
      const seconds = challenges.map((challengeToken) =>
        totpStep(dependencies(limiters[0] as HashLimiter, failingVerifier()), { challengeToken, code: wrong, sourceAddress }),
      );

      const passwordOutcomes = await Promise.all(passwords);
      const secondOutcomes = await Promise.all(seconds);
      const countedPassword = passwordOutcomes.filter((outcome) => outcome.code === "FAILED").length;
      const countedSecond = secondOutcomes.filter((outcome) => outcome.code === "FAILED").length;

      expect(countedSecond).toBeLessThanOrEqual(1);
      expect(countedPassword + countedSecond).toBeGreaterThanOrEqual(1);
      expect(countedPassword + countedSecond - 1).toBeLessThanOrEqual(2 * P);

      const { rows } = await observer.query<{ n: number }>(
        "select cardinality(recent_failures)::int as n from authentication_source_window where source_digest = $1",
        [sourceDigestOf(sourceAddress)],
      );
      expect(Number(rows[0]?.n)).toBe(20);
    });
  }

  it("is broken by a variant that releases the slot before its accounting commits (negative control)", async () => {
    const sourceAddress = `control-${randomUUID()}`;
    await presetSourceFailures(sourceAddress, 19);
    const limiter = new HashLimiter();

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        releasingEarly(limiter, { username: `control-${index}-${randomUUID().slice(0, 6)}`, sourceAddress }),
      ),
    );

    // With P = 1 the bound allows at most 1 + 2P = 3 counted failures from 19; this variant exceeds it.
    expect(outcomes.filter((outcome) => outcome === "FAILED").length).toBeGreaterThan(3);
  });
});

describe("a database failure during accounting", () => {
  it("is classified, not retried, counted nowhere, and releases the hash slot", async () => {
    const sourceAddress = `db-failure-${randomUUID()}`;
    await presetSourceFailures(sourceAddress, 1);
    await observer.query(
      `create or replace function adr028_test_fault() returns trigger language plpgsql as $$
       begin raise exception 'injected test fault' using errcode = '40001'; end $$`,
    );
    await observer.query(
      "create trigger adr028_test_fault before update on authentication_source_window for each row execute function adr028_test_fault()",
    );
    const limiter = new HashLimiter();
    const username = `db-failure-${randomUUID().slice(0, 8)}`;

    try {
      const outcome = await passwordStep(dependencies(limiter, failingVerifier()), { username, password: "x", sourceAddress });
      expect(outcome).toEqual({ code: "STORAGE_FAILURE", failure: { code: "RETRYABLE_CONFLICT", sqlState: "40001" } });
    } finally {
      await observer.query("drop trigger if exists adr028_test_fault on authentication_source_window");
    }

    expect(limiter.running).toBe(0);
    expect(limiter.queued).toBe(0);
    expect(await passwordCounter(username)).toBe(0);
  });
});

/** Every accounting row a password step can write, for some usernames and one source. */
async function accounting(usernames: readonly string[], address: string): Promise<Row> {
  const counters = [];

  for (const username of usernames) {
    const { rows } = await observer.query(
      `select consecutive_failures, wait_until::text as wait_until, last_failure_at::text as last_failure_at
         from authentication_throttle where scope = 'password' and subject_digest = $1`,
      [usernameDigestOf(username)],
    );
    counters.push(rows[0] ?? null);
  }

  const { rows } = await observer.query("select recent_failures::text as instants from authentication_source_window where source_digest = $1", [
    sourceDigestOf(address),
  ]);
  return { counters, source: rows[0] ?? null };
}

async function pendingChallenges(administratorId: string | undefined): Promise<number> {
  if (administratorId === undefined) {
    return 0;
  }

  const { rows } = await observer.query<{ n: number }>(
    "select count(*)::int as n from administrator_pending_challenge where administrator_id = $1",
    [administratorId],
  );
  return Number(rows[0]?.n);
}

/** A limiter that runs `onAcquire` once a slot is granted, before the step's re-check. */
class HookedLimiter extends HashLimiter {
  onAcquire: (() => Promise<void>) | undefined;

  override async acquire() {
    const slot = await super.acquire();

    if (slot !== "overloaded" && this.onAcquire !== undefined) {
      await this.onAcquire();
    }

    return slot;
  }
}

interface ExitCase {
  readonly name: string;
  readonly known: boolean;
  /** What the stub verifier does: fail, succeed, or throw. */
  readonly verifier: "fail" | "succeed" | "throw";
  readonly arrange?: (context: { readonly username: string; readonly administratorId?: string; readonly limiter: HookedLimiter }) => Promise<void>;
  /** The outcome code, or "THROWS" when the step rejects. */
  readonly expected: string;
  /** Runs inside the verifier, between the credential lookup and the outcome. */
  readonly duringVerify?: (context: { readonly administratorId?: string }) => Promise<void>;
  /** Whether the step reaches the verifier at all. */
  readonly verifies: boolean;
  /** Whether the accounting rows must be exactly as the step found them. */
  readonly accountingUnchanged: boolean;
}

/** A wait that began while the request queued for its slot, set from the hooked limiter. */
async function startWait(username: string): Promise<void> {
  await observer.query(
    "update authentication_throttle set consecutive_failures = 5, wait_until = to_timestamp($2::bigint / 1000.0) where scope = 'password' and subject_digest = $1",
    [usernameDigestOf(username), current + 30_000],
  );
}

const EXIT_CASES: readonly ExitCase[] = [
  {
    name: "the re-check read fails",
    known: false,
    verifier: "fail",
    arrange: async () => injectFault("read-password-counter", { occurrence: 2, kind: "error", sqlState: "57014" }),
    expected: "STORAGE_FAILURE",
    verifies: false,
    accountingUnchanged: true,
  },
  {
    name: "the re-check finds a wait that began while the request queued",
    known: false,
    verifier: "fail",
    arrange: async ({ username, limiter }) => {
      limiter.onAcquire = async () => {
        limiter.onAcquire = undefined;
        await startWait(username);
      };
    },
    expected: "THROTTLED",
    verifies: false,
    accountingUnchanged: false,
  },
  {
    name: "the credential lookup fails",
    known: true,
    verifier: "fail",
    arrange: async () => injectFault("find-credential", { occurrence: 1, kind: "error", sqlState: "40001" }),
    expected: "STORAGE_FAILURE",
    verifies: false,
    accountingUnchanged: true,
  },
  { name: "the password verifier throws", known: true, verifier: "throw", expected: "THROWS", verifies: true, accountingUnchanged: true },
  {
    name: "the failure accounting fails",
    known: false,
    verifier: "fail",
    arrange: async () => injectFault("count-failure", { occurrence: 1, kind: "error", sqlState: "40001" }),
    expected: "STORAGE_FAILURE",
    verifies: true,
    accountingUnchanged: true,
  },
  {
    name: "the failure accounting misses a required count",
    known: true,
    verifier: "fail",
    arrange: async () => injectFault("count-source-failure", { occurrence: 1, kind: "zero" }),
    expected: "STORAGE_FAILURE",
    verifies: true,
    accountingUnchanged: true,
  },
  {
    name: "the challenge issue fails after a correct password",
    known: true,
    verifier: "succeed",
    arrange: async () => injectFault("issue-challenge", { occurrence: 1, kind: "error", sqlState: "57014" }),
    expected: "STORAGE_FAILURE",
    verifies: true,
    accountingUnchanged: true,
  },
  {
    name: "the verified password changed before the challenge was issued",
    known: true,
    verifier: "succeed",
    duringVerify: async ({ administratorId }) => {
      await observer.query("update administrator set password_hash = $2 where id = $1", [
        administratorId,
        STUB_HASH.replace("c3R1Yi1rZXk", "b3RoZXIta2V5"),
      ]);
    },
    expected: "REFUSED",
    verifies: true,
    accountingUnchanged: true,
  },
];

describe("every password-path exit after a slot is granted releases that slot", () => {
  for (const exit of EXIT_CASES) {
    it(`when ${exit.name}`, async () => {
      const admin = exit.known ? await provision(STUB_HASH) : undefined;
      const username = admin?.username ?? `nobody-${randomUUID().slice(0, 8)}`;
      const sourceAddress = `exit-${randomUUID()}`;
      await presetPasswordCounter(username, 2);
      await presetSourceFailures(sourceAddress, 1);

      const limiter = new HookedLimiter({ maxRunning: 1, maxQueued: 0 });
      let verifications = 0;
      const verifier: PasswordVerifier = {
        verify: async () => {
          verifications += 1;
          await exit.duringVerify?.({ administratorId: admin?.id });
          if (exit.verifier === "throw") {
            throw new Error("verifier fault");
          }
          return exit.verifier === "succeed";
        },
      };

      await exit.arrange?.({ username, administratorId: admin?.id, limiter });
      const before = await accounting([username], sourceAddress);
      const pendingBefore = await pendingChallenges(admin?.id);

      try {
        const step = passwordStep(dependencies(limiter, verifier), { username, password: "x", sourceAddress });

        if (exit.expected === "THROWS") {
          await expect(step).rejects.toThrow("verifier fault");
        } else {
          expect((await step).code).toBe(exit.expected);
        }
      } finally {
        clearFaults();
      }

      // The slot came back: nothing running or queued, and a one-slot limiter grants at once.
      expect(limiter.running).toBe(0);
      expect(limiter.queued).toBe(0);
      const again = await limiter.acquire();
      expect(again).not.toBe("overloaded");
      if (again !== "overloaded") {
        again.release();
      }

      expect(verifications).toBe(exit.verifies ? 1 : 0);
      expect(await pendingChallenges(admin?.id)).toBe(pendingBefore);
      if (exit.accountingUnchanged) {
        expect(await accounting([username], sourceAddress)).toEqual(before);
      }
    });
  }
});

describe("overload", () => {
  it("gives a known and an unknown username the identical outcome, without lookup or accounting", async () => {
    const admin = await provision(STUB_HASH);
    const unknown = `nobody-${randomUUID().slice(0, 8)}`;
    const sourceAddress = `overload-${randomUUID()}`;
    await presetSourceFailures(sourceAddress, 3);
    await presetPasswordCounter(admin.username, 1);

    const full = new HashLimiter({ maxRunning: 1, maxQueued: 0 });
    const held = await full.acquire();
    let verifications = 0;
    const verifier: PasswordVerifier = { verify: async () => ((verifications += 1), false) };
    const before = await accounting([admin.username, unknown], sourceAddress);

    labels.length = 0;
    const known = await passwordStep(dependencies(full, verifier), { username: admin.username, password: "x", sourceAddress });
    const knownLabels = [...labels];
    labels.length = 0;
    const unknownOutcome = await passwordStep(dependencies(full, verifier), { username: unknown, password: "x", sourceAddress });

    expect(known).toStrictEqual({ code: "OVERLOADED" });
    expect(unknownOutcome).toStrictEqual(known);
    // The same statements in both cases: the admission reads only, and no account lookup.
    expect(knownLabels).toEqual(["count-source-window", "read-password-counter"]);
    expect(labels).toEqual(knownLabels);
    expect(verifications).toBe(0);
    expect(await accounting([admin.username, unknown], sourceAddress)).toEqual(before);

    if (held !== "overloaded") {
      held.release();
    }
  });
});

/* Canaries: sensitive values planted where an outcome or a log line could carry them. */

/** PostgreSQL renders bytea as a backslash, `x`, then hex. */
const BACKSLASH = String.fromCharCode(92);

function forms(canary: Buffer | string): string[] {
  const bytes = typeof canary === "string" ? Buffer.from(canary, "utf8") : canary;
  const encoded = [bytes.toString("hex"), `${BACKSLASH}x${bytes.toString("hex")}`, bytes.toString("base64"), bytes.toString("base64url")];
  return typeof canary === "string" ? [canary, ...encoded] : encoded;
}

/** No canary, in any of those encodings, in the usual renderings of `value`. */
function expectNoCanary(value: unknown, canaries: readonly (Buffer | string)[]): void {
  const renderings = [JSON.stringify(value), inspect(value, { depth: null }), String(value)];

  for (const rendered of renderings) {
    for (const canary of canaries) {
      for (const form of forms(canary)) {
        expect(rendered).not.toContain(form);
      }
    }
  }
}

/** A username whose password counter is in an active wait, so the step refuses at admission. */
async function throttledUsername(): Promise<string> {
  const username = `throttled-${randomUUID().slice(0, 8)}`;
  await presetPasswordCounter(username, 0);
  await startWait(username);
  return username;
}

describe("canaries in representative outcomes and log output (not an exhaustive secrecy proof)", () => {
  it(
    "never surface a password, token, TOTP secret, key or stored hash in a refusal, failure or log line",
    async () => {
      const password = `canary-password-${randomUUID()}`;
      const wrongPassword = `canary-wrong-${randomUUID()}`;
      const storedHash = await hashPassword(password);
      const admin = await provision(storedHash);
      const sourceAddress = `canary-${randomUUID()}`;
      const deps = dependencies(new HashLimiter(), { verify: verifyPassword });
      const shortKey = Buffer.alloc(16, 7);
      const secrets: (Buffer | string)[] = [password, wrongPassword, storedHash, admin.secret, TOTP_KEY, THROTTLE_KEY, shortKey];
      const logged: unknown[][] = [];
      const failures: unknown[] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(args);
        }),
      );

      try {
        failures.push(await passwordStep(deps, { username: admin.username, password: wrongPassword, sourceAddress }));
        failures.push(await passwordStep(deps, { username: "nobody-canary", password, sourceAddress }));

        // A driver error that echoes values, as a constraint error's detail can.
        injectFault("count-failure", {
          occurrence: 1,
          kind: "error",
          sqlState: "40001",
          message: `fault while handling ${wrongPassword}`,
          detail: `Failing row contains (${password}, ${storedHash})`,
        });
        failures.push(await passwordStep(deps, { username: admin.username, password: wrongPassword, sourceAddress }));
        clearFaults();

        const issued = await passwordStep(deps, { username: admin.username, password, sourceAddress });
        expect(issued.code).toBe("CHALLENGE_ISSUED");
        const challengeToken = issued.code === "CHALLENGE_ISSUED" ? issued.challengeToken : "";
        secrets.push(challengeToken);
        const right = totpCodeAt(admin.secret, current);
        const wrong = right === "000000" ? "000001" : "000000";

        failures.push(await totpStep(deps, { challengeToken, code: wrong, sourceAddress }));
        injectFault("issue-session", {
          occurrence: 1,
          kind: "error",
          sqlState: "23505",
          detail: `Key (token_digest)=(${challengeToken}) already exists; secret ${admin.secret.toString("base64")}`,
        });
        failures.push(await totpStep(deps, { challengeToken, code: right, sourceAddress }));
        clearFaults();

        const session = await totpStep(deps, { challengeToken, code: right, sourceAddress });
        expect(session.code).toBe("SESSION_ISSUED");
        secrets.push(session.code === "SESSION_ISSUED" ? session.sessionToken : "");
        failures.push(await totpStep(deps, { challengeToken, code: right, sourceAddress }));

        failures.push(await passwordStep(deps, { username: await throttledUsername(), password, sourceAddress: `other-${randomUUID()}` }));

        const full = new HashLimiter({ maxRunning: 1, maxQueued: 0 });
        const held = await full.acquire();
        failures.push(
          await passwordStep(dependencies(full, { verify: verifyPassword }), {
            username: admin.username,
            password,
            sourceAddress: `other-${randomUUID()}`,
          }),
        );
        if (held !== "overloaded") {
          held.release();
        }

        // Primitive errors raised while handling key material.
        for (const raise of [
          () => keyedDigest(shortKey, "source-address", password),
          () => sealTotpSecret(shortKey, 1, admin.id, admin.secret),
        ]) {
          let raised: unknown;
          try {
            raise();
          } catch (cause) {
            raised = cause;
          }
          expect(raised).toBeInstanceOf(RangeError);
          failures.push({ message: (raised as Error).message, text: String(raised), inspected: inspect(raised) });
        }
      } finally {
        clearFaults();
        for (const spy of spies) {
          spy.mockRestore();
        }
      }

      expect(failures.map((outcome) => (outcome as { code?: string }).code)).toEqual([
        "FAILED",
        "FAILED",
        "STORAGE_FAILURE",
        "FAILED",
        "STORAGE_FAILURE",
        "FAILED",
        "THROTTLED",
        "OVERLOADED",
        undefined,
        undefined,
      ]);

      for (const outcome of failures) {
        expectNoCanary(outcome, secrets);
      }
      expectNoCanary(logged, secrets);
      expect(logged).toEqual([]);
    },
    HASH_TIMEOUT_MS,
  );
});
