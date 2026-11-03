/**
 * The provisioning command against a real PostgreSQL (issue #260 §6.3 V-1 to V-4), driven through
 * its injectable terminal. The cluster is the governed disposable test cluster; `.local-demo/` is
 * never touched.
 */

import { randomBytes } from "node:crypto";

import { sql } from "kysely";
import { Secret } from "otpauth";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AdministratorAuthenticationDatabase } from "../../src/data/administrator-authentication-table";
import { createListingPersistence, type ListingPersistence } from "../../src/data/connection";
import { useEmbeddedPostgres } from "../../src/data/testing/embedded-cluster";
import { passwordBlocklist } from "../../src/domain/administrator-auth/password-policy";
import { totpCodeAt } from "../../src/domain/administrator-auth/totp";
import type { Kysely } from "kysely";
import { provisionSyntheticAdministrator, type ProvisioningResult } from "./administrator-provisioning";

// Each provisioning runs a real scrypt derivation (about 0.7 s).
vi.setConfig({ testTimeout: 120_000 });

const DATABASE = "admin_provisioning";
const cluster = useEmbeddedPostgres({ slug: "admin-provisioning", databases: [DATABASE], migrate: [DATABASE] });

let persistence: ListingPersistence;
let db: Kysely<AdministratorAuthenticationDatabase>;
const TOTP_KEY = randomBytes(32);

beforeAll(() => {
  persistence = createListingPersistence({ pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 2 } });
  db = persistence.db as unknown as Kysely<AdministratorAuthenticationDatabase>;
  cluster.closeBeforeShutdown("provisioning pool", () => persistence.shutdown());
});

interface Run {
  readonly result: ProvisioningResult;
  readonly lines: string[];
  readonly secret?: Buffer;
}

async function run(answers: { username: string; password?: string; again?: string; code?: (secret: Buffer) => string }): Promise<Run> {
  const lines: string[] = [];
  const secrets = [answers.password ?? "", answers.again ?? answers.password ?? ""];
  let secret: Buffer | undefined;

  const result = await provisionSyntheticAdministrator(
    {
      interactive: true,
      ask: async (prompt) => {
        if (!prompt.startsWith("Current six-digit code")) {
          return answers.username;
        }

        const base32 = lines.map((line) => /Secret \(base32\): ([A-Z2-7]+)/.exec(line)?.[1]).find((value) => value !== undefined) ?? "";
        secret = Buffer.from(Secret.fromBase32(base32).bytes);
        return (answers.code ?? ((s: Buffer) => totpCodeAt(s, Date.now())))(secret);
      },
      askSecret: async () => secrets.shift() ?? "",
      say: (line) => lines.push(line),
    },
    { db, clock: Date.now, totpKey: TOTP_KEY, environment: {}, databaseUrl: cluster.connectionStringFor(DATABASE) },
  );

  return { result, lines, secret };
}

const counts = async () => {
  const administrators = await sql<{ n: number }>`select count(*)::int as n from administrator`.execute(db);
  const factors = await sql<{ n: number }>`select count(*)::int as n from administrator_totp_factor`.execute(db);
  return { administrators: administrators.rows[0]?.n, factors: factors.rows[0]?.n };
};

const name = () => `synthetic-${randomBytes(5).toString("hex")}`;
const PASSWORD = "a long synthetic passphrase for tests";

describe("provisioning (V-1)", () => {
  it("creates one administrator and one confirmed factor, shows the secret once, and issues no recovery codes", async () => {
    const username = name();
    const before = await counts();
    const { result, lines } = await run({ username, password: PASSWORD });

    expect(result).toMatchObject({ ok: true, username });
    expect(await counts()).toEqual({ administrators: (before.administrators ?? 0) + 1, factors: (before.factors ?? 0) + 1 });

    const factor = await sql<{ state: string; factor_id: string; last_accepted_step: string }>`
      select f.state, f.factor_id, f.last_accepted_step from administrator_totp_factor f join administrator a on a.id = f.administrator_id where a.username = ${username}`.execute(db);
    expect(factor.rows[0]?.state).toBe("active");
    expect(factor.rows[0]?.last_accepted_step).not.toBeNull();

    expect(lines.filter((line) => line.includes("otpauth://"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("Secret (base32)"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("Recovery codes are not implemented")).length).toBeGreaterThanOrEqual(2);

    const recovery = await sql<{ present: boolean }>`select to_regclass('public.administrator_recovery_code') is not null as present`.execute(db);
    expect(recovery.rows[0]?.present).toBe(false);
  });
});

describe("refusals write nothing (V-2)", () => {
  it.each([
    ["a name without the synthetic- prefix", { username: "operator-ada", password: PASSWORD }],
    ["an unprovisionable name", { username: "synthetic-!!", password: PASSWORD }],
    ["a short password", { username: name(), password: "too short" }],
    ["an over-long password", { username: name(), password: "x".repeat(129) }],
    ["a blocklisted password", { username: name(), password: [...passwordBlocklist()][0] ?? "" }],
    ["mismatched confirmations", { username: name(), password: PASSWORD, again: `${PASSWORD}!` }],
  ])("%s", async (_label, answers) => {
    const before = await counts();
    const { result, lines } = await run(answers);

    expect(result.ok).toBe(false);
    expect(await counts()).toEqual(before);
    expect(lines.join("\n")).not.toContain(answers.password);
  });

  it("an existing name", async () => {
    const username = name();
    expect((await run({ username, password: PASSWORD })).result.ok).toBe(true);
    const before = await counts();

    expect((await run({ username, password: PASSWORD })).result).toEqual({ ok: false, reason: "USERNAME_REFUSED" });
    expect(await counts()).toEqual(before);
  });
});

describe("an unconfirmed enrolment (V-3)", () => {
  it("leaves the factor pending_confirmation, so the account cannot sign in", async () => {
    const username = name();
    const { result } = await run({ username, password: PASSWORD, code: (secret) => String((Number(totpCodeAt(secret, Date.now())) + 500_000) % 1_000_000).padStart(6, "0") });

    expect(result).toEqual({ ok: false, reason: "NOT_CONFIRMED" });
    const factor = await sql<{ state: string }>`
      select f.state from administrator_totp_factor f join administrator a on a.id = f.administrator_id where a.username = ${username}`.execute(db);
    expect(factor.rows[0]?.state).toBe("pending_confirmation");
  });
});

describe("secrets stay out of storage and output (V-4, a canary check, not a proof)", () => {
  it("stores only a hash and ciphertext, and prints the secret only in its one display", async () => {
    const username = name();
    const password = `canary-password-${randomBytes(8).toString("hex")}`;
    const { lines, secret } = await run({ username, password });
    const stored = await sql<{ row: string }>`
      select row_to_json(a)::text || row_to_json(f)::text as row
        from administrator a join administrator_totp_factor f on f.administrator_id = a.id where a.username = ${username}`.execute(db);
    const text = stored.rows[0]?.row ?? "";

    expect(text).not.toContain(password);
    expect(text).not.toContain(TOTP_KEY.toString("hex"));
    expect(text).not.toContain(secret?.toString("hex") ?? "unreachable");
    expect(lines.join("\n")).not.toContain(password);
    expect(lines.join("\n")).not.toContain(TOTP_KEY.toString("base64url"));
    expect(lines.filter((line) => line.includes(new Secret({ buffer: new Uint8Array(secret ?? Buffer.alloc(0)).buffer }).base32))).toHaveLength(2);
  });
});
