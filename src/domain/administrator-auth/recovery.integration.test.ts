/**
 * The recovery steps against a real PostgreSQL (issue #266 §6.2, §6.9).
 *
 * The whole server-side journey, composed from the steps only: password, recovery code,
 * re-enrolment start and completion, and regeneration, then a fresh password-plus-TOTP sign-in.
 * Plaintext codes and the TOTP secret are returned to the caller once; the outcomes otherwise
 * carry neither. The persistence operations are attacked in `administrator-recovery.integration`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";

import * as auth from "../../data/administrator-authentication";
import type { AdministratorAuthenticationDatabase } from "../../data/administrator-authentication-table";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../data/testing/embedded-cluster";
import { createTimestamptzTypeOverrides } from "../../data/timestamp-parser";
import { HashLimiter } from "./hash-limiter";
import { keyedDigest } from "./keyed-digest";
import { generateRecoveryCodes } from "./recovery-code";
import { reenrolmentCompletion, reenrolmentStart, recoveryStep, regeneration, type RecoveryDependencies } from "./recovery";
import { openTotpSecret, sealTotpSecret } from "./secret-box";
import { passwordStep, totpStep, totpVerifierFor, type SignInDependencies } from "./sign-in";
import { generateTotpSecret, totpCodeAt } from "./totp";

interface PgPool {
  query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const pg = createRequire(import.meta.url)("pg") as { Pool: new (config: Record<string, unknown>) => PgPool };

const DATABASE = "auth_recovery_steps";
const cluster = useEmbeddedPostgres({ slug: "auth-recovery-steps", databases: [DATABASE], migrate: [DATABASE] });

const THROTTLE_KEY = randomBytes(32);
const TOTP_KEY = randomBytes(32);
const TOTP_KEYS = new Map([[1, TOTP_KEY]]);
const PASSWORD = "a synthetic local password";
const SOURCE = "127.0.0.1";
const STUB_HASH = "scrypt$ln=17,r=8,p=1$c3R1Yi1zYWx0LTE2Ynl0ZQ$c3R1Yi1rZXk";

let current = Date.UTC(2026, 10, 3, 12, 0, 0);
const clock: auth.Clock = () => current;

let db: Kysely<AdministratorAuthenticationDatabase>;
let observer: PgPool;

const passwords = { verify: async (password: string) => password === PASSWORD };

beforeAll(async () => {
  const pool = new pg.Pool({ connectionString: cluster.connectionStringFor(DATABASE), max: 6, types: createTimestamptzTypeOverrides() });
  pool.on("error", () => undefined);
  db = new Kysely<AdministratorAuthenticationDatabase>({ dialect: new PostgresDialect({ pool: pool as never }) });
  observer = new pg.Pool({ connectionString: cluster.connectionStringFor(DATABASE), max: 2 });
  observer.on("error", () => undefined);
  cluster.closeBeforeShutdown("recovery-step operations", () => db.destroy());
  cluster.closeBeforeShutdown("recovery-step observer", () => observer.end());
}, CLUSTER_TIMEOUT_MS);

const signIn = (): SignInDependencies => ({
  db,
  clock,
  limiter: new HashLimiter(),
  passwords,
  dummyPasswordHash: STUB_HASH,
  throttleKey: THROTTLE_KEY,
  totpKeys: TOTP_KEYS,
});
const recovery = (): RecoveryDependencies => ({ db, clock, throttleKey: THROTTLE_KEY, totpKeys: TOTP_KEYS, currentTotpKeyVersion: 1 });

function ok<T>(stored: auth.Stored<T>): T {
  if (!stored.ok) {
    throw new Error(JSON.stringify(stored.failure));
  }
  return stored.value;
}

async function provision() {
  const id = randomUUID();
  const username = `admin-${id.slice(0, 8)}`;
  const secret = generateTotpSecret();
  const factorId = randomUUID();
  const codes = generateRecoveryCodes();

  ok(await auth.createAdministrator(db, { administratorId: id, username, passwordHash: STUB_HASH }, clock));
  ok(await auth.startTotpEnrolment(db, { administratorId: id, factorId, material: sealTotpSecret(TOTP_KEY, 1, id, secret) }, clock));
  expect(
    ok(
      await auth.confirmTotpEnrolmentWithRecoveryCodes(
        db,
        {
          administratorId: id,
          factorId,
          verify: totpVerifierFor(TOTP_KEYS, totpCodeAt(secret, current)),
          codeDigests: codes.map((c) => c.digest),
        },
        clock,
      ),
    ),
  ).toEqual({ code: "ENROLMENT_CONFIRMED" });
  current += 60_000;
  return { id, username, secret, codes };
}

async function challenge(username: string): Promise<string> {
  const outcome = await passwordStep(signIn(), { username, password: PASSWORD, sourceAddress: SOURCE });
  if (outcome.code !== "CHALLENGE_ISSUED") {
    throw new Error(outcome.code);
  }
  return outcome.challengeToken;
}

describe("the recovery journey, server side", () => {
  it("password and a code, re-enrolment, completion, then password and the new TOTP sign in", async () => {
    const admin = await provision();

    const recovered = await recoveryStep(recovery(), {
      challengeToken: await challenge(admin.username),
      code: admin.codes[0]?.code ?? "",
      sourceAddress: SOURCE,
    });
    expect(recovered.code).toBe("RECOVERY_SESSION_ISSUED");
    const token = recovered.code === "RECOVERY_SESSION_ISSUED" ? recovered.recoverySessionToken : "";

    // The old TOTP secret no longer signs in.
    current += 60_000;
    expect(
      await totpStep(signIn(), { challengeToken: await challenge(admin.username), code: totpCodeAt(admin.secret, current), sourceAddress: SOURCE }),
    ).toMatchObject({ code: "REFUSED", reason: "FACTOR_UNAVAILABLE" });

    const regenerated = await regeneration(recovery(), { recoverySessionToken: token });
    expect(regenerated.code).toBe("RECOVERY_CODES_REGENERATED");

    const started = await reenrolmentStart(recovery(), { recoverySessionToken: token });
    expect(started.code).toBe("REENROLMENT_STARTED");
    if (started.code !== "REENROLMENT_STARTED") {
      return;
    }

    const completed = await reenrolmentCompletion(recovery(), {
      recoverySessionToken: token,
      factorId: started.factorId,
      code: totpCodeAt(started.secret, current),
    });
    expect(completed.code).toBe("REENROLMENT_COMPLETED");
    const fresh = completed.code === "REENROLMENT_COMPLETED" ? completed.recoveryCodes : [];
    expect(fresh).toHaveLength(10);
    expect(new Set(fresh).size).toBe(10);

    // The recovery session is gone; the stored set is exactly the fresh codes' digests.
    expect(await regeneration(recovery(), { recoverySessionToken: token })).toEqual({ code: "REFUSED", reason: "RECOVERY_SESSION_INVALID" });
    const stored = await observer.query<{ n: number }>("select count(*)::int as n from administrator_recovery_code where administrator_id = $1", [admin.id]);
    expect(stored.rows[0]?.n).toBe(10);

    current += 60_000;
    expect(
      (await totpStep(signIn(), { challengeToken: await challenge(admin.username), code: totpCodeAt(started.secret, current), sourceAddress: SOURCE })).code,
    ).toBe("SESSION_ISSUED");

    // A fresh code opens recovery; a code from before completion does not.
    expect(
      (await recoveryStep(recovery(), { challengeToken: await challenge(admin.username), code: admin.codes[1]?.code ?? "", sourceAddress: SOURCE })).code,
    ).toBe("FAILED");
    expect(
      (await recoveryStep(recovery(), { challengeToken: await challenge(admin.username), code: (fresh[0] ?? "").toUpperCase(), sourceAddress: SOURCE })).code,
    ).toBe("RECOVERY_SESSION_ISSUED");
  });

  it("returns plaintext only in its own success field, and no outcome renders a code or the secret otherwise", async () => {
    const admin = await provision();
    const outcomes: unknown[] = [];

    const recovered = await recoveryStep(recovery(), { challengeToken: await challenge(admin.username), code: admin.codes[0]?.code ?? "", sourceAddress: SOURCE });
    outcomes.push(recovered);
    const token = recovered.code === "RECOVERY_SESSION_ISSUED" ? recovered.recoverySessionToken : "";
    outcomes.push(await recoveryStep(recovery(), { challengeToken: await challenge(admin.username), code: admin.codes[0]?.code ?? "", sourceAddress: SOURCE }));
    const started = await reenrolmentStart(recovery(), { recoverySessionToken: token });
    const secret = started.code === "REENROLMENT_STARTED" ? started.secret : Buffer.alloc(0);
    outcomes.push(await reenrolmentCompletion(recovery(), { recoverySessionToken: token, factorId: randomUUID(), code: "000000" }));

    for (const value of outcomes) {
      const rendered = [JSON.stringify(value), inspect(value, { depth: null })];
      for (const text of rendered) {
        for (const code of admin.codes) {
          expect(text).not.toContain(code.code);
          expect(text).not.toContain(code.code.split("-").join(""));
        }
        expect(text).not.toContain(admin.secret.toString("hex"));
        expect(text).not.toContain(secret.toString("hex"));
      }
    }
  });
});

describe("the recovery_code counter subject (issue #266 amendment 2)", () => {
  it("is the recovery-code-administrator digest, not linkable to the same administrator's totp row", async () => {
    const admin = await provision();
    expect((await recoveryStep(recovery(), { challengeToken: await challenge(admin.username), code: "wrong", sourceAddress: SOURCE })).code).toBe("FAILED");
    expect((await totpStep(signIn(), { challengeToken: await challenge(admin.username), code: "000000", sourceAddress: SOURCE })).code).toBe("FAILED");

    const rows = await observer.query<{ scope: string; subject: string }>(
      "select scope, encode(subject_digest, 'hex') as subject from authentication_throttle where scope in ('totp', 'recovery_code') and subject_digest = any($1) order by scope",
      [[keyedDigest(THROTTLE_KEY, "recovery-code-administrator", admin.id), keyedDigest(THROTTLE_KEY, "totp-administrator", admin.id)]],
    );
    expect(rows.rows).toEqual([
      { scope: "recovery_code", subject: keyedDigest(THROTTLE_KEY, "recovery-code-administrator", admin.id).toString("hex") },
      { scope: "totp", subject: keyedDigest(THROTTLE_KEY, "totp-administrator", admin.id).toString("hex") },
    ]);
  });
});

describe("the current TOTP key version (issue #266 amendment 5): explicit, never inferred", () => {
  async function recoveryToken(admin: Awaited<ReturnType<typeof provision>>): Promise<string> {
    const recovered = await recoveryStep(recovery(), { challengeToken: await challenge(admin.username), code: admin.codes[0]?.code ?? "", sourceAddress: SOURCE });
    if (recovered.code !== "RECOVERY_SESSION_ISSUED") {
      throw new Error(recovered.code);
    }
    return recovered.recoverySessionToken;
  }

  /** Every row of the administrator's in every table a start could write, as the database holds it. */
  async function stateOf(id: string) {
    const rows = async (table: string) =>
      (await observer.query(`select * from ${table} where administrator_id = $1 order by 1, 2`, [id])).rows;
    return {
      administrator: (await observer.query("select * from administrator where id = $1", [id])).rows,
      factor: await rows("administrator_totp_factor"),
      sessions: await rows("administrator_session"),
      pending: await rows("administrator_pending_challenge"),
      consumed: await rows("administrator_consumed_challenge"),
      codes: await rows("administrator_recovery_code"),
    };
  }

  it("seals under exactly the configured version among several keys, not the highest, and that factor completes", async () => {
    const keys = new Map([[1, randomBytes(32)], [2, randomBytes(32)], [3, randomBytes(32)]]);

    for (const version of [1, 2]) {
      const admin = await provision();
      const token = await recoveryToken(admin);
      const deps = { ...recovery(), totpKeys: keys, currentTotpKeyVersion: version };
      const started = await reenrolmentStart(deps, { recoverySessionToken: token });
      expect(started.code, `version ${version}`).toBe("REENROLMENT_STARTED");
      if (started.code !== "REENROLMENT_STARTED") {
        return;
      }

      const row = (
        await observer.query<{ key_version: number; secret_ciphertext: Buffer; secret_iv: Buffer; secret_tag: Buffer }>(
          "select key_version, secret_ciphertext, secret_iv, secret_tag from administrator_totp_factor where administrator_id = $1",
          [admin.id],
        )
      ).rows[0];
      expect(row?.key_version, `version ${version}`).toBe(version);
      const sealed = { ciphertext: row?.secret_ciphertext ?? Buffer.alloc(0), iv: row?.secret_iv ?? Buffer.alloc(0), tag: row?.secret_tag ?? Buffer.alloc(0), keyVersion: version };
      // Only the selected key opens it; the highest one does not.
      expect(openTotpSecret(new Map([[version, keys.get(version) ?? Buffer.alloc(0)]]), admin.id, sealed)).toEqual(started.secret);
      expect(openTotpSecret(new Map([[version, keys.get(3) ?? Buffer.alloc(0)]]), admin.id, sealed)).toBeNull();

      const completed = await reenrolmentCompletion(deps, { recoverySessionToken: token, factorId: started.factorId, code: totpCodeAt(started.secret, current) });
      expect(completed.code, `version ${version}`).toBe("REENROLMENT_COMPLETED");
    }
  });

  it("returns TOTP_KEY_UNAVAILABLE for a missing selected key or an empty keyring, writing nothing and disclosing no secret", async () => {
    const present = randomBytes(32);

    for (const [name, totpKeys, currentTotpKeyVersion] of [
      ["missing selected key", new Map([[1, present]]), 2],
      ["empty keyring", new Map<number, Buffer>(), 1],
    ] as const) {
      const admin = await provision();
      const token = await recoveryToken(admin);
      const before = await stateOf(admin.id);
      const outcome = await reenrolmentStart({ ...recovery(), totpKeys, currentTotpKeyVersion }, { recoverySessionToken: token });

      expect(outcome, name).toEqual({ code: "TOTP_KEY_UNAVAILABLE" });
      expect(inspect(outcome, { depth: null }), name).not.toContain(present.toString("hex"));
      expect(await stateOf(admin.id), name).toEqual(before);
      // The recovery session is untouched and still works with a usable key.
      expect((await reenrolmentStart(recovery(), { recoverySessionToken: token })).code, name).toBe("REENROLMENT_STARTED");
    }
  });
});
