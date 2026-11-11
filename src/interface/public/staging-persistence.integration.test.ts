/**
 * The OP-2 staging source against a real, disposable embedded PostgreSQL cluster with **TLS**
 * (issue #246, OP-2 staging Scope Gate revision 2 §2.2, §7; AC-6).
 *
 * TLS is turned on after startup with `ALTER SYSTEM` and a configuration reload, so the shared
 * cluster helper is unchanged. A throwaway CA and a server certificate naming **only** `localhost`
 * are generated per run with `openssl` and deleted afterwards. No key is committed.
 *
 * - SI-1: C-1′ (TLS `verify-full`) and C-2 to C-4 pass over TLS; `OP-2` reads public, never-existed
 *   and pending identities; the session is shown to be encrypted.
 * - SI-2: a wrong CA, or a certificate from the right CA naming a different host, is refused before
 *   any listing query. It also pins a driver hazard: with an IP-literal host, `pg` checks the
 *   certificate against `localhost`, so the configuration's refusal of IP literals is load-bearing.
 * - SI-3: a wrong database, marker or role is refused before any listing query.
 * - SI-4: the role's privileges: it reads `listing` and cannot write it.
 * - SI-5: calibration through the real read records a realized delay at least the nominal one.
 *
 * This is not the hosted DigitalOcean endpoint. Whether its certificate names its public hostname
 * is established only by readiness (V-4, R-5).
 */

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createListingPersistence, type ListingPersistence } from "../../data/connection";
import { CLUSTER_TIMEOUT_MS, useEmbeddedPostgres } from "../../data/testing/embedded-cluster";
import { instantOf, type Instant } from "../../domain/listing/instant";
import type { Listing, ListingContent } from "../../domain/listing/listing";
import { listingIdOf } from "../../domain/listing/listing-id";
import { persistListingApproval } from "../../data/listing-approval";
import { insertSubmittedListing } from "../../data/listing-repository";
import { findPubliclyAvailableListing } from "../../data/public-listing-read";
import { REFUSED } from "./e3-local-persistence";
import type { StagingConfiguration } from "./staging-access";
import {
  createStaging,
  isHostnameMismatch,
  isNetworkRefusal,
  isTlsVerificationFailure,
  isTrustChainFailure,
  stagingRoleSetupStatements,
  type StagingHandle,
} from "./staging-persistence";

const DATABASE = "bi4_staging";
const ROLE = "bi4_staging_app";
const PASSWORD = randomBytes(16).toString("hex");
const MARKER = `bi4-staging-synthetic:${randomBytes(16).toString("hex")}`;
const TEST_TIMEOUT_MS = 30_000;
const T0 = 1_767_323_045_123;

const CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "Co. Cork",
  postalCode: { value: "P17 AB12", designatedPublic: true },
  phone: { value: "+353 21 999 0000", designatedPublic: false },
  email: { value: "hello@example.ie", designatedPublic: true },
  website: { value: "https://private.example.ie" },
};

const cluster = useEmbeddedPostgres({ slug: "staging", databases: [DATABASE], migrate: [DATABASE] });

let superuser: ListingPersistence;
let certificates: string;
let caPem: string;
let otherCaPem: string;
let publicKey: string;
let pendingKey: string;
const handles: StagingHandle[] = [];

/** `openssl`, from PATH or Git for Windows. Absent is a failure, not a skip. */
function opensslCommand(): string {
  for (const candidate of ["openssl", "C:/Program Files/Git/usr/bin/openssl.exe", "C:/Program Files/Git/mingw64/bin/openssl.exe"]) {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error("openssl is required for the staging TLS integration test and was not found");
}

function makeCertificates(directory: string): void {
  const openssl = opensslCommand();
  const run = (args: string[]) => execFileSync(openssl, args, { cwd: directory, stdio: "ignore" });
  const caExtensions = join(directory, "ca.cnf");
  const serverExtensions = join(directory, "server.cnf");
  writeFileSync(caExtensions, "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
  writeFileSync(serverExtensions, "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n");

  for (const name of ["ca", "other-ca"]) {
    run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=bi4-staging-test-${name}`, "-keyout", `${name}.key`, "-out", `${name}.csr`]);
    run(["x509", "-req", "-in", `${name}.csr`, "-signkey", `${name}.key`, "-days", "1", "-extfile", caExtensions, "-out", `${name}.pem`]);
  }
  run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr"]);
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "1", "-days", "1", "-extfile", serverExtensions, "-out", "server.pem"]);

  // Same CA, but naming only another host: the hostname check must refuse it.
  const elsewhereExtensions = join(directory, "elsewhere.cnf");
  writeFileSync(elsewhereExtensions, "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:elsewhere.invalid\n");
  run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=elsewhere.invalid", "-keyout", "elsewhere.key", "-out", "elsewhere.csr"]);
  run(["x509", "-req", "-in", "elsewhere.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "2", "-days", "1", "-extfile", elsewhereExtensions, "-out", "elsewhere.pem"]);
}

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) throw new Error("fixture instant is invalid");
  return result.value;
}

async function submit(key: string): Promise<Listing> {
  const listing: Listing = { id: listingIdOf(key), status: "pending", content: CONTENT, timestamps: { submittedAt: instant(T0), lastUpdatedAt: instant(T0) } };
  expect((await insertSubmittedListing(superuser.db, listing)).ok).toBe(true);
  return listing;
}

function configuration(overrides: { host?: string; ca?: string; database?: string; marker?: string; role?: string; calibration?: StagingConfiguration["calibration"] } = {}): StagingConfiguration {
  const host = overrides.host ?? "localhost";
  return {
    connectionString: `postgresql://${ROLE}:${PASSWORD}@${host}:${cluster.port}/${DATABASE}`,
    caPem: overrides.ca ?? caPem,
    expected: { host, database: overrides.database ?? DATABASE, role: overrides.role ?? ROLE, marker: overrides.marker ?? MARKER },
    keyDigestHex: "0".repeat(64),
    calibration: overrides.calibration ?? [],
  };
}

interface Counted {
  readonly handle: StagingHandle;
  readonly reads: () => number;
  readonly sslSeen: () => boolean[];
}

/** A handle whose `OP-2` reads are counted on the reserved client, and which records the TLS state. */
function handleFor(config: StagingConfiguration): Counted {
  let reads = 0;
  const ssl: boolean[] = [];
  const handle = createStaging(config, {
    find: async (db, identity) => {
      reads += 1;
      const { rows } = await sql<{ ssl: boolean }>`select ssl from pg_stat_ssl where pid = pg_backend_pid()`.execute(db);
      ssl.push((rows[0] as { ssl: boolean }).ssl);
      return findPubliclyAvailableListing(db, identity);
    },
  });
  handles.push(handle);
  return { handle, reads: () => reads, sslSeen: () => ssl };
}

beforeAll(async () => {
  superuser = createListingPersistence({ pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 1 } });
  cluster.closeBeforeShutdown("superuser persistence", () => superuser.shutdown());
  cluster.closeBeforeShutdown("staging handles", () => Promise.all(handles.map((handle) => handle.shutdown())));

  certificates = mkdtempSync(join(tmpdir(), "cdp-staging-tls-"));
  makeCertificates(certificates);
  caPem = readFileSync(join(certificates, "ca.pem"), "utf8");
  otherCaPem = readFileSync(join(certificates, "other-ca.pem"), "utf8");

  const path = (name: string) => join(certificates, name).replace(/\\/g, "/");
  await sql.raw(`alter system set ssl_cert_file = '${path("server.pem")}'`).execute(superuser.db);
  await sql.raw(`alter system set ssl_key_file = '${path("server.key")}'`).execute(superuser.db);
  await sql.raw("alter system set ssl = on").execute(superuser.db);
  await sql.raw("select pg_reload_conf()").execute(superuser.db);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = createListingPersistence({ pool: { connectionString: cluster.connectionStringFor(DATABASE), max: 1 } });
    try {
      const { rows } = await sql<{ ssl: string }>`show ssl`.execute(probe.db);
      if ((rows[0] as { ssl: string }).ssl === "on") break;
    } finally {
      await probe.shutdown();
    }
    if (Date.now() > deadline) throw new Error("the server did not turn TLS on");
    await new Promise((resume) => setTimeout(resume, 100));
  }

  for (const statement of stagingRoleSetupStatements({ database: DATABASE, role: ROLE, password: PASSWORD })) {
    await sql.raw(statement).execute(superuser.db);
  }
  await sql.raw(`comment on database "${DATABASE}" is '${MARKER}'`).execute(superuser.db);

  publicKey = randomUUID();
  pendingKey = randomUUID();
  const listing = await submit(publicKey);
  expect((await persistListingApproval(superuser.db, { listingId: listing.id, viewedLastUpdatedAt: instant(T0), approvedAt: instant(T0 + 1_000) })).ok).toBe(true);
  await submit(pendingKey);
}, CLUSTER_TIMEOUT_MS);

afterEach(async () => {
  while (handles.length > 0) await (handles.pop() as StagingHandle).shutdown();
});

afterAll(() => {
  if (certificates !== undefined) rmSync(certificates, { recursive: true, force: true });
});

describe("SI-1: TLS verify-full and C-2 to C-4 pass; OP-2 reads over an encrypted session", () => {
  it("verifies, reads public, never-existed and pending, and every read is on TLS", async () => {
    const { handle, reads, sslSeen } = handleFor(configuration());

    expect(await handle.precheck()).toBe("ok");
    expect(await handle.read(publicKey)).toMatchObject({ ok: true, value: { id: publicKey, listing: { name: "Harbour Bakery" } } });
    expect(await handle.read(randomUUID())).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(await handle.read(pendingKey)).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(reads()).toBe(3);
    expect(sslSeen()).toEqual([true, true, true]);
    expect(handle.status().state).toBe("verified");
  }, TEST_TIMEOUT_MS);
});

async function useServerCertificate(name: "server" | "elsewhere"): Promise<void> {
  const path = (file: string) => join(certificates, file).replace(/\\/g, "/");
  await sql.raw(`alter system set ssl_cert_file = '${path(`${name}.pem`)}'`).execute(superuser.db);
  await sql.raw(`alter system set ssl_key_file = '${path(`${name}.key`)}'`).execute(superuser.db);
  await sql.raw("select pg_reload_conf()").execute(superuser.db);
  // Each new backend reads the reloaded configuration; give the postmaster a moment to apply it.
  await new Promise((resume) => setTimeout(resume, 500));
}

describe("SI-2: TLS identity failures refuse before any listing query", () => {
  it("refuses a CA that did not issue the server certificate", async () => {
    const { handle, reads } = handleFor(configuration({ ca: otherCaPem }));
    expect(await handle.precheck()).toBe("refused");
    expect(await handle.read(publicKey)).toBe(REFUSED);
    expect(reads()).toBe(0);
    expect(handle.status().state).toBe("refused");
  }, TEST_TIMEOUT_MS);

  it("refuses a certificate from the right CA that names a different host (the hostname check)", async () => {
    await useServerCertificate("elsewhere");
    try {
      const { handle, reads } = handleFor(configuration());
      expect(await handle.precheck()).toBe("refused");
      expect(await handle.read(publicKey)).toBe(REFUSED);
      expect(reads()).toBe(0);
    } finally {
      await useServerCertificate("server");
    }
    const { handle } = handleFor(configuration());
    expect(await handle.precheck()).toBe("ok");
  }, TEST_TIMEOUT_MS);

  it("pins a driver hazard: with an IP-literal host, pg checks the certificate against 'localhost'", async () => {
    // `pg` sets the TLS servername only for a non-IP host, and Node then checks identity against
    // its default host, `localhost`. So an IP literal is NOT verified as that IP. This is why the
    // staging configuration refuses IP literals (`isStagingHostName`, SA-3): that refusal is what
    // makes C-1′ a real hostname check. If this test starts failing, the driver changed.
    const { handle } = handleFor(configuration({ host: "127.0.0.1" }));
    expect(await handle.precheck()).toBe("ok");
  }, TEST_TIMEOUT_MS);
});

describe("SI-2b: the operator tool's TLS control classifier, on real errors", () => {
  async function connectError(connectionString: string, ca: string): Promise<unknown> {
    const probe = createListingPersistence({ pool: { connectionString, ssl: { ca, rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 5_000 } });
    try {
      await sql`select 1`.execute(probe.db);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      await probe.shutdown();
    }
  }

  it("classifies a wrong CA and a hostname mismatch as TLS failures, and a closed port as a network refusal", async () => {
    const wrongCa = await connectError(configuration().connectionString, otherCaPem);
    expect(isTlsVerificationFailure(wrongCa)).toBe(true);
    expect(isTrustChainFailure(wrongCa)).toBe(true);
    expect(isHostnameMismatch(wrongCa)).toBe(false);
    expect(isNetworkRefusal(wrongCa)).toBe(false);

    await useServerCertificate("elsewhere");
    let mismatch: unknown;
    try {
      mismatch = await connectError(configuration().connectionString, caPem);
    } finally {
      await useServerCertificate("server");
    }
    expect(isTlsVerificationFailure(mismatch)).toBe(true);
    expect(isHostnameMismatch(mismatch)).toBe(true);
    expect(isTrustChainFailure(mismatch)).toBe(false);

    const closedPort = await connectError(`postgresql://${ROLE}:${PASSWORD}@localhost:1/${DATABASE}`, caPem);
    expect(isTlsVerificationFailure(closedPort)).toBe(false);
    expect(isNetworkRefusal(closedPort)).toBe(true);

    expect(await connectError(configuration().connectionString, caPem)).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});

describe("SI-3: C-2 to C-4 failures refuse before any listing query", () => {
  for (const [label, config] of [
    ["a wrong database", () => configuration({ database: "postgres" })],
    ["a wrong marker", () => configuration({ marker: `bi4-staging-synthetic:${"f".repeat(32)}` })],
    ["a wrong expected role", () => configuration({ role: "postgres" })],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const { handle, reads } = handleFor(config());
      expect(await handle.precheck()).toBe("refused");
      expect(await handle.read(publicKey)).toBe(REFUSED);
      expect(reads()).toBe(0);
    }, TEST_TIMEOUT_MS);
  }
});

describe("SI-4: the role reads listing and cannot write it", () => {
  it("is refused every write", async () => {
    const app = createListingPersistence({
      pool: { connectionString: configuration().connectionString, ssl: { ca: caPem, rejectUnauthorized: true }, max: 1 },
    });
    try {
      const { rows } = await sql<{ n: string }>`select count(*)::text as n from listing`.execute(app.db);
      expect(Number((rows[0] as { n: string }).n)).toBe(2);
      await expect(sql`delete from listing`.execute(app.db)).rejects.toThrow(/permission denied/);
      await expect(sql`update listing set status = 'approved'`.execute(app.db)).rejects.toThrow(/permission denied/);
      await expect(sql.raw(`create table staging_probe (x int)`).execute(app.db)).rejects.toThrow(/permission denied/);
    } finally {
      await app.shutdown();
    }
  }, TEST_TIMEOUT_MS);
});

describe("SI-5: calibration through the real read", () => {
  it("delays only the calibration identity, and records realized ≥ nominal", async () => {
    const calibrationIdentity = "c1000000-0000-4000-8000-0000000000aa";
    const { handle } = handleFor(configuration({ calibration: [{ identity: calibrationIdentity, delayNs: 1_000_000 }] }));

    expect(await handle.read(calibrationIdentity)).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    expect(await handle.read(randomUUID())).toEqual({ ok: false, error: { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } });
    const [summary] = handle.status().calibrationSinceLastStatus;
    expect(summary?.nominalNs).toBe(1_000_000);
    expect(summary?.count).toBe(1);
    expect(summary?.minNs).toBeGreaterThanOrEqual(1_000_000);
  }, TEST_TIMEOUT_MS);
});
