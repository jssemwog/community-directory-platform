/**
 * `staging-check`: the OP-2 private staging operator tool (issue #246, OP-2 staging Scope Gate
 * revision 2; approval record of 2026-11-11).
 *
 * **Every live use needs its own authorization**, separately from the gate and from this code:
 * the §5 regression runs, provisioning, setup, readiness, any measurement and teardown. Merging this
 * tool authorizes nothing. It provisions nothing and **deletes no provider resource**. The operator
 * creates and deletes resources in the provider consoles, and this tool verifies before and after.
 *
 * What it does:
 * - **Record (§6.1):** writes `staging-record.json`, bound to the DigitalOcean cluster ID, project
 *   and endpoint and to the Render service ID, project and endpoint, **before any SQL**. Prints its
 *   SHA-256. Every later step re-reads it and re-checks that hash (V-1).
 * - **Verify before SQL (V-1 to V-7)** with a **read-only** DigitalOcean token, TLS `verify-full`
 *   with the recorded CA, and identity reads. Shared regional IPs are checked as a **network filter
 *   only**, never as identity.
 * - **Setup:** creates `bi4_staging` on a fresh cluster, sets the synthetic marker, migrates, loads
 *   synthetic fixtures, creates the least-privilege app role, and writes the app's environment values
 *   to the output directory. Nothing secret is printed.
 * - **Readiness (§8 A):** the gate coverage, the cache-policy gate R-2b (K-1 to K-5 **through Render**),
 *   the counter check, remote equivalence and leak scans.
 * - **Status (M-1),** identity fallback (F-1 to F-4), spend projection (§6.4), pre-deletion
 *   verification (D-1) and deletion confirmation (D-2).
 * - **Regression (§5, PB-1 to PB-5)** and the **local configured staging-mode check** (approval
 *   ruling 1). See README *OP-2 staging* for the departure on how the two servers are started.
 *
 * Secrets come from the environment only, never from flags: `BI4_STAGING_DO_TOKEN`,
 * `BI4_STAGING_DOADMIN_PASSWORD`, `BI4_STAGING_KEY`. Reports and console output redact them.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { rootCertificates } from "node:tls";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Migrator } from "kysely/migration";
import { sql, type Kysely } from "kysely";

import { createListingPersistence, type ListingPersistence } from "../../src/data/connection";
import type { ListingDatabase } from "../../src/data/listing-table";
import { createMigrationProvider } from "../../src/data/migrate";
import {
  CALIBRATION_DELAY_CEILING_NS,
  isStagingHostName,
  STAGING_DATABASE,
  STAGING_KEY_HEADER,
  STAGING_MARKER_PATTERN,
  STAGING_STATUS_PATH,
  stagingKeyDigestHex,
} from "../../src/interface/public/staging-access";
import {
  HOSTNAME_MISMATCH_CODE,
  isHostnameMismatch,
  isNetworkRefusal,
  isTlsVerificationFailure,
  isTrustChainFailure,
  stagingRoleSetupStatements,
  tlsFailureCode,
} from "../../src/interface/public/staging-persistence";
import type { StagingStatusPayload } from "../../src/interface/public/staging-status";
import { comparisonListOf, maskNextRequestId, maskOwnIdentity, PLACEHOLDER } from "./body-compare";
import { createRedactor, e3FixturePlan, e3Fixtures, leakHits, prefixHits, redactDeep, type E3Fixtures, type ScannedItem } from "./e3-check";
import { loadFixtures, verifyStoredStates } from "./fixtures";
import {
  parseWorktreeList,
  RESTRICTED_FILES,
  runFile,
  windowsListenerLookup,
  windowsProcessOps,
  type ListeningEntry,
  type ProcessIdentity,
  type ProcessOps,
} from "./isolation";

/* ------------------------------------------------------------------------------------------- */
/* Constants                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export const RECORD_SCHEMA = "bi4-staging-record/1";
export const RECORD_FILE = "staging-record.json";
export const APP_ENV_FILE = "render-environment.secret.json";
export const KEY_FILE = "staging-key.secret.txt";

/** Proposed attempt caps (D-G8). */
export const REGRESS_CAP = 500;
export const READINESS_CAP = 300;

export const APP_ROLE = "bi4_staging_app";
export const DO_REGION = "nyc3";
export const DO_ENGINE = "pg";
export const DO_VERSION = "18";
export const RENDER_REGION = "virginia";
export const RENDER_PLANS: readonly string[] = ["1c-2g", "standard"];
/** The response header Render adds per request (Render logging docs), removed with `Date` (D-G6). */
export const VARYING_RESPONSE_HEADERS: readonly string[] = ["date", "rndr-id"];

/** Environment variables holding the operator's secrets. Never flags. */
export const DO_TOKEN_VARIABLE = "BI4_STAGING_DO_TOKEN";
export const DOADMIN_PASSWORD_VARIABLE = "BI4_STAGING_DOADMIN_PASSWORD";
export const KEY_VARIABLE = "BI4_STAGING_KEY";

/** The two window options (§6.4, D-G3). Seven days is the approved planning basis. */
export interface WindowOption {
  readonly id: "7-day" | "14-day";
  readonly days: number;
  readonly ceilingUsd: number;
  readonly stopUsd: number;
  readonly latestDeletion: string;
  readonly tokenExpiryAtLeast: string;
}

export const WINDOW_OPTIONS: Readonly<Record<WindowOption["id"], WindowOption>> = {
  "7-day": { id: "7-day", days: 7, ceilingUsd: 30, stopUsd: 24, latestDeletion: "2026-12-11T23:59:00-05:00", tokenExpiryAtLeast: "2026-12-14" },
  "14-day": { id: "14-day", days: 14, ceilingUsd: 50, stopUsd: 40, latestDeletion: "2026-12-18T23:59:00-05:00", tokenExpiryAtLeast: "2026-12-21" },
};
export const LATEST_PROVISIONING = "2026-12-04T23:59:00-05:00";

/** The rates the projection uses (§6.4). Taxes excluded. */
export const RATES = { renderMonthlyUsd: 25, doHourlyUsd: 0.02254, doWorstCaseUsd: 15.15, daysPerMonth: 30 } as const;

/* ------------------------------------------------------------------------------------------- */
/* The record (§6.1)                                                                              */
/* ------------------------------------------------------------------------------------------- */

export interface TrustedSource {
  readonly uuid?: string;
  readonly type: string;
  readonly value: string;
}

export interface StagingRecord {
  readonly schema: typeof RECORD_SCHEMA;
  readonly writtenAt: string;
  readonly digitalOcean: {
    readonly clusterId: string;
    readonly name: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly region: string;
    readonly engine: string;
    readonly version: string;
    readonly size: string;
    readonly host: string;
    readonly port: number;
    readonly createdAt: string;
    readonly caSha256: string;
    /** The expected network filter: Render Virginia's published outbound ranges. Not identity. */
    readonly trustedSources: readonly TrustedSource[];
  };
  readonly render: {
    readonly serviceId: string;
    readonly name: string;
    readonly ownerId: string;
    readonly environmentId: string;
    readonly projectName: string;
    readonly dashboardUrl: string;
    readonly url: string;
    readonly region: string;
    readonly plan: string;
    readonly numInstances: number;
    readonly healthCheckPath: string;
    readonly autoDeploy: "no";
    readonly previews: "off";
    readonly edgeCache: "off";
  };
  readonly run: {
    readonly nonce: string;
    readonly marker: string;
    readonly keyDigestHex: string;
    readonly authorizedCommit: string;
    readonly fixtures: E3Fixtures;
    readonly calibrationIdentities: readonly string[];
    readonly window: WindowOption["id"];
    readonly deletionDeadline: string;
    readonly tokenExpiryAtLeast: string;
    readonly ceilingUsd: number;
    readonly stopUsd: number;
    /** P-0 (§5.3): the passed live `e3-check` on this candidate, required before any hosted resource. */
    readonly p0: { readonly reportSha256: string; readonly commit: string };
  };
}

/* ------------------------------------------------------------------------------------------- */
/* P-0 (§5.3): the required live e3-check on the candidate, enforced before any record           */
/* ------------------------------------------------------------------------------------------- */

/**
 * The `e3-check.json` of one live run must show, for exactly the authorized commit: normal
 * acceptance passed, E-A4b passed, no problems, no safety problems and nothing left by teardown.
 * Its bytes must hash to the value the operator transcribed from the run's console.
 */
export function p0Problems(reportBytes: Buffer, expectedSha256: string, authorizedCommit: string): readonly string[] {
  const actual = sha256Hex(reportBytes);
  if (actual !== expectedSha256) return [`P-0: the e3-check report hashes to ${actual}, not the stated ${expectedSha256}`];
  let report: {
    header?: Record<string, unknown>;
    acceptancePassed?: unknown;
    faultInjection?: { result?: unknown };
    problems?: unknown;
    safety?: unknown;
    teardown?: { left?: unknown };
  };
  try {
    report = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    return ["P-0: the e3-check report is not JSON"];
  }
  const problems: string[] = [];
  if (report.header?.["Authorized commit"] !== authorizedCommit) problems.push(`P-0: the e3-check ran on ${String(report.header?.["Authorized commit"])}, not the authorized candidate ${authorizedCommit}`);
  if (report.acceptancePassed !== true) problems.push("P-0: e3-check normal acceptance did not pass");
  if (report.faultInjection?.result !== "pass") problems.push("P-0: e3-check E-A4b did not pass");
  if (!Array.isArray(report.problems) || report.problems.length > 0) problems.push("P-0: the e3-check report lists problems");
  if (!Array.isArray(report.safety) || report.safety.length > 0) problems.push("P-0: the e3-check report lists safety problems (residue not established as zero)");
  if (!Array.isArray(report.teardown?.left) || report.teardown.left.length > 0) problems.push("P-0: the e3-check teardown left resources");
  return problems;
}

const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The record's canonical bytes: sorted-key JSON, LF, one trailing newline. */
export function recordBytes(record: StagingRecord): Buffer {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]))
        : value;
  return Buffer.from(`${JSON.stringify(sort(record), null, 2)}\n`, "utf8");
}

export const sha256Hex = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** The deletion deadline: creation + the window's days, and never after the option's latest date. */
export function deletionDeadlineOf(createdAt: string, option: WindowOption): string {
  const byWindow = Date.parse(createdAt) + option.days * 86_400_000;
  const latest = Date.parse(option.latestDeletion);
  return new Date(Math.min(byWindow, latest)).toISOString();
}

/** §6.2: the read-only token stays valid at least 3 days past the deletion deadline (UTC date). */
export function tokenExpiryOf(deletionDeadline: string): string {
  return new Date(Date.parse(deletionDeadline) + 3 * 86_400_000).toISOString().slice(0, 10);
}

/** Every problem with a record's content. An empty list means it may be used. */
export function recordProblems(record: StagingRecord): readonly string[] {
  const problems: string[] = [];
  const d = record.digitalOcean;
  const r = record.render;
  const run = record.run;
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };

  need(record.schema === RECORD_SCHEMA, "unknown record schema");
  need(UUID.test(d.clusterId), "the DigitalOcean cluster ID is not a UUID");
  need(UUID.test(d.projectId), "the DigitalOcean project ID is not a UUID");
  need(d.name === `bi4-staging-${run.nonce}`, "the cluster name is not bi4-staging-<nonce>");
  need(d.region === DO_REGION, `the cluster region is not ${DO_REGION}`);
  need(d.engine === DO_ENGINE, "the cluster engine is not pg (Standard Edition)");
  need(d.version === DO_VERSION, `the PostgreSQL version is not ${DO_VERSION}`);
  need(isStagingHostName(d.host), "the cluster host is not a DNS name");
  need(Number.isInteger(d.port) && d.port > 0 && d.port < 65536, "the cluster port is invalid");
  need(SHA256.test(d.caSha256), "the CA SHA-256 is malformed");
  need(d.trustedSources.length > 0, "no trusted source is recorded: a cluster is publicly accessible by default");
  need(d.trustedSources.every((rule) => rule.type === "ip_addr"), "every recorded trusted source must be an IPv4 address or range (Render's published outbound ranges)");
  need(/^srv-[a-z0-9]+$/.test(r.serviceId), "the Render service ID is not srv-…");
  need(r.dashboardUrl.includes(r.serviceId), "the dashboard URL does not contain the service ID");
  need(/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(r.url), "the Render URL is not an https onrender.com origin");
  need(r.region === RENDER_REGION, `the Render region is not ${RENDER_REGION}`);
  need(RENDER_PLANS.includes(r.plan), "the Render plan is not 1c-2g");
  need(r.numInstances === 1, "the Render service must have exactly one instance");
  need(r.healthCheckPath === "", "an HTTP health-check path is set; the TCP default is required (§3.4)");
  need(r.autoDeploy === "no" && r.previews === "off" && r.edgeCache === "off", "auto-deploy, previews and edge caching must all be off");
  need(/^[0-9a-f]{12}$/.test(run.nonce), "the run nonce is malformed");
  need(STAGING_MARKER_PATTERN.test(run.marker), "the marker is malformed");
  need(SHA256.test(run.keyDigestHex), "the key digest is malformed");
  need(COMMIT.test(run.authorizedCommit), "the authorized commit is not a full SHA");
  need(run.p0 !== undefined && SHA256.test(run.p0.reportSha256) && run.p0.commit === run.authorizedCommit, "P-0: no passed live e3-check on the authorized commit is recorded (required before any hosted resource)");
  need(run.calibrationIdentities.length <= 4 && run.calibrationIdentities.every((id) => V4.test(id)), "calibration identities must be at most 4 v4 UUIDs");
  const fixtureIds = [...run.fixtures.neverExisted, run.fixtures.pending, run.fixtures.rejected, run.fixtures.unpublished, run.fixtures.publiclyAvailable];
  need(run.calibrationIdentities.every((id) => !fixtureIds.includes(id)), "a calibration identity collides with a fixture identity");
  const option = WINDOW_OPTIONS[run.window];
  need(option !== undefined, "unknown window option");
  if (option !== undefined) {
    need(run.ceilingUsd === option.ceilingUsd && run.stopUsd === option.stopUsd, "the ceiling or stop does not match the window option");
    need(run.deletionDeadline === deletionDeadlineOf(d.createdAt, option), "the deletion deadline does not follow from the creation time and window");
    need(run.tokenExpiryAtLeast === tokenExpiryOf(run.deletionDeadline), "the token expiry must be the deletion deadline + 3 days (§6.2)");
    need(Date.parse(d.createdAt) <= Date.parse(LATEST_PROVISIONING), "the cluster was created after the latest provisioning date; the dates need re-approval");
  }
  return problems;
}

/** V-1: read the record and check its bytes against the hash printed when it was written. */
export function readRecord(bytes: Buffer, expectedSha256: string): { readonly record?: StagingRecord; readonly problems: readonly string[] } {
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) return { problems: [`V-1: the record's SHA-256 is ${actual}, not the printed ${expectedSha256}`] };
  let record: StagingRecord;
  try {
    record = JSON.parse(bytes.toString("utf8")) as StagingRecord;
  } catch {
    return { problems: ["V-1: the record is not JSON"] };
  }
  const problems = recordProblems(record).map((problem) => `V-1: ${problem}`);
  return problems.length > 0 ? { problems } : { record, problems: [] };
}

/** Fresh run values: nonce, marker, key (returned once, for the secret file), fixtures, calibration IDs. */
export function newRunValues(calibrationCount: number): { readonly nonce: string; readonly marker: string; readonly key: string; readonly fixtures: E3Fixtures; readonly calibrationIdentities: readonly string[] } {
  if (!Number.isInteger(calibrationCount) || calibrationCount < 0 || calibrationCount > 4) throw new Error("--calibration-identities must be 0 to 4");
  const key = randomBytes(32).toString("base64url");
  return {
    nonce: randomBytes(6).toString("hex"),
    marker: `bi4-staging-synthetic:${randomBytes(16).toString("hex")}`,
    key,
    fixtures: e3Fixtures(randomUUID, (bytes) => randomBytes(bytes).toString("hex")),
    calibrationIdentities: Array.from({ length: calibrationCount }, () => randomUUID()),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* DigitalOcean (read-only API): V-2, V-6 (db_names), V-7, D-2                                    */
/* ------------------------------------------------------------------------------------------- */

export interface DoCluster {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly version: string;
  readonly region: string;
  readonly size: string;
  readonly status: string;
  readonly project_id?: string;
  readonly created_at: string;
  readonly connection: { readonly host: string; readonly port: number };
  readonly db_names?: readonly string[] | null;
}

export type DoClusterResult = { readonly status: 200; readonly cluster: DoCluster } | { readonly status: number };

export interface DoApi {
  cluster(id: string): Promise<DoClusterResult>;
  firewall(id: string): Promise<readonly TrustedSource[]>;
}

/** The real read-only client. The token comes from the environment and is sent only to the API. */
export function digitalOceanApi(token: string, fetchImpl: typeof fetch = fetch): DoApi {
  const get = async (path: string) => fetchImpl(`https://api.digitalocean.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  return {
    async cluster(id) {
      const response = await get(`/v2/databases/${encodeURIComponent(id)}`);
      if (response.status !== 200) return { status: response.status };
      return { status: 200, cluster: ((await response.json()) as { database: DoCluster }).database };
    },
    async firewall(id) {
      const response = await get(`/v2/databases/${encodeURIComponent(id)}/firewall`);
      if (response.status !== 200) throw new Error(`V-7: the trusted-source request returned ${response.status}`);
      return ((await response.json()) as { rules: TrustedSource[] }).rules.map(({ uuid, type, value }) => ({ uuid, type, value }));
    },
  };
}

/** V-2: the API's view of the recorded cluster. */
export function clusterProblems(record: StagingRecord, result: DoClusterResult): readonly string[] {
  if (result.status !== 200 || !("cluster" in result)) return [`V-2: GET cluster returned ${result.status}`];
  const c = result.cluster;
  const d = record.digitalOcean;
  const problems: string[] = [];
  const same = (label: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`V-2: ${label} is ${JSON.stringify(actual)}, recorded ${JSON.stringify(expected)}`);
  };
  same("status", c.status, "online");
  same("id", c.id, d.clusterId);
  same("name", c.name, d.name);
  same("project_id", c.project_id, d.projectId);
  same("region", c.region, d.region);
  same("engine", c.engine, d.engine);
  same("version", c.version, d.version);
  same("size", c.size, d.size);
  same("connection.host", c.connection.host, d.host);
  same("connection.port", c.connection.port, d.port);
  same("created_at", c.created_at, d.createdAt);
  return problems;
}

/**
 * V-6 by phase. `bootstrap`: the cluster is fresh (exactly `defaultdb`). `existing`: our database
 * exists and nothing else does (marker changes, D-1). `any`: verify before or after setup; only
 * foreign databases are refused.
 */
export type PreflightPhase = "bootstrap" | "existing" | "any";

export function databaseNamesProblems(phase: PreflightPhase, names: readonly string[] | null | undefined): readonly string[] {
  const list = [...(names ?? [])].sort();
  const ours = list.every((name) => name === "defaultdb" || name === STAGING_DATABASE);
  if (phase === "bootstrap") return JSON.stringify(list) === JSON.stringify(["defaultdb"]) ? [] : [`V-6: db_names is ${JSON.stringify(list)}, expected exactly ["defaultdb"] on a fresh cluster`];
  if (!ours) return [`V-6: db_names is ${JSON.stringify(list)}, expected a subset of ["defaultdb","${STAGING_DATABASE}"]`];
  if (phase === "existing" && !list.includes(STAGING_DATABASE)) return [`V-6: ${STAGING_DATABASE} does not exist yet`];
  return [];
}

/**
 * The preflight every SQL-sending command runs first (V-2, V-3, V-6, V-7). It reads only the
 * DigitalOcean API and the CA file: **no connection is opened and no SQL is sent.** A non-empty
 * problem list means the command must stop before connecting.
 */
export async function preflight(record: StagingRecord, caPem: string, api: DoApi, operatorRule: TrustedSource | undefined, phase: PreflightPhase): Promise<{ readonly problems: readonly string[]; readonly databases: readonly string[] }> {
  const result = await api.cluster(record.digitalOcean.clusterId);
  const problems = [...clusterProblems(record, result), ...caProblems(record, caPem)];
  const databases = "cluster" in result ? [...(result.cluster.db_names ?? [])] : [];
  if ("cluster" in result) problems.push(...databaseNamesProblems(phase, result.cluster.db_names));
  problems.push(...trustedSourceProblems(record, await api.firewall(record.digitalOcean.clusterId), operatorRule));
  return { problems, databases };
}

/** V-7: the trusted-source rules equal the recorded set. A network filter only, never identity. */
export function trustedSourceProblems(record: StagingRecord, rules: readonly TrustedSource[], allowOperatorRule: TrustedSource | undefined): readonly string[] {
  const key = (rule: TrustedSource) => `${rule.type}:${rule.value}`;
  const expected = new Set([...record.digitalOcean.trustedSources.map(key), ...(allowOperatorRule === undefined ? [] : [key(allowOperatorRule)])]);
  const actual = new Set(rules.map(key));
  const missing = [...expected].filter((rule) => !actual.has(rule));
  const extra = [...actual].filter((rule) => !expected.has(rule));
  return [
    ...missing.map((rule) => `V-7: trusted source ${rule} is missing`),
    ...extra.map((rule) => `V-7: unexpected trusted source ${rule}`),
  ];
}

/** D-2: after deletion, only a 404 confirms it. Anything else is unresolved. */
export function deletionConfirmation(result: DoClusterResult): { readonly confirmed: boolean; readonly note: string } {
  return result.status === 404 ? { confirmed: true, note: "D-2: GET cluster returned 404" } : { confirmed: false, note: `D-2: UNRESOLVED: GET cluster returned ${result.status}` };
}

/* ------------------------------------------------------------------------------------------- */
/* Database connections as doadmin: V-3, V-4, V-5, setup, D-1                                     */
/* ------------------------------------------------------------------------------------------- */

/** V-3: the CA's bytes hash to the recorded value. */
export function caProblems(record: StagingRecord, caPem: string): readonly string[] {
  return sha256Hex(caPem) === record.digitalOcean.caSha256 ? [] : ["V-3: the CA certificate's SHA-256 does not match the record"];
}

/** A doadmin URL built **only** from the record's host and port. */
export function doadminUrl(record: StagingRecord, password: string, database: string): string {
  return `postgresql://doadmin:${encodeURIComponent(password)}@${record.digitalOcean.host}:${record.digitalOcean.port}/${database}`;
}

export interface OperatorSql {
  /** Open a TLS connection with the given CA; nothing is sent until the first statement. */
  connect(url: string, caPem: string, applicationName: string): ListingPersistence;
}

/** A bounded connect, so a filtered network shows as a timeout rather than a hang. */
export const OPERATOR_CONNECT_TIMEOUT_MS = 15_000;

export const realOperatorSql: OperatorSql = {
  connect: (url, caPem, applicationName) =>
    createListingPersistence({
      pool: { connectionString: url, ssl: { ca: caPem, rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: OPERATOR_CONNECT_TIMEOUT_MS },
      startupParameters: { application_name: applicationName },
    }),
};

/** The outcome of one connection attempt whose only statement is an identity read. */
export type Attempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** Connect and send only `select current_database()` (V-5: identity reads come first). */
export async function attemptIdentityRead(operatorSql: OperatorSql, url: string, caPem: string, applicationName: string): Promise<Attempt> {
  const connection = operatorSql.connect(url, caPem, applicationName);
  try {
    await sql`select current_database() as database`.execute(connection.db);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await connection.shutdown();
  }
}

/**
 * V-4. The positive control must succeed. **Each negative control must fail with exactly the error
 * it exists to provoke:**
 * - the wrong-CA control: a **trust-chain** verification failure (`isTrustChainFailure`);
 * - the wrong-hostname control (the IP literal): a **hostname mismatch**,
 *   `ERR_TLS_CERT_ALTNAME_INVALID` (`isHostnameMismatch`).
 *
 * Any other outcome leaves that control **inconclusive** and fails V-4: a different certificate
 * error (including the other control's error), a network failure, or an authentication failure.
 */
export function tlsControlProblems(results: { readonly positive: Attempt; readonly wrongCa: Attempt; readonly ipLiteral: Attempt }): readonly string[] {
  const problems: string[] = [];
  if (!results.positive.ok) {
    problems.push(
      isTlsVerificationFailure(results.positive.error)
        ? "V-4: TLS verify-full to the recorded host with the recorded CA failed certificate verification"
        : "V-4: the positive TLS control could not connect (not a TLS result); the negative controls cannot be interpreted",
    );
  }
  const controls = [
    { label: "a CA that did not issue the server certificate", attempt: results.wrongCa, expected: "a trust-chain verification failure", matches: isTrustChainFailure },
    { label: "the cluster's IP literal as the host", attempt: results.ipLiteral, expected: `a hostname mismatch (${HOSTNAME_MISMATCH_CODE})`, matches: isHostnameMismatch },
  ];
  for (const { label, attempt, expected, matches } of controls) {
    if (attempt.ok) problems.push(`V-4: ${label} was accepted`);
    else if (!matches(attempt.error)) problems.push(`V-4: the control with ${label} did not fail with ${expected} (got ${describeFailure(attempt.error)}), so it is inconclusive`);
  }
  return problems;
}

/** A failure's class, for a control's report. Never the error's message, which may name the host. */
export function describeFailure(error: unknown): string {
  const code = tlsFailureCode(error);
  if (code !== undefined) return `certificate error ${code}`;
  if (isNetworkRefusal(error)) return "a network failure";
  const pgCode = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (pgCode === "28P01" || pgCode === "28000") return `an authentication failure (${pgCode})`;
  return typeof pgCode === "string" ? `error ${pgCode}` : "an unclassified failure";
}

/** R-8. With the operator rule removed, the connection must be refused **at the network**. */
export function networkFilterProblems(attempt: Attempt): readonly string[] {
  if (attempt.ok) return ["R-8: an operator connection succeeded with the operator rule removed"];
  if (isTlsVerificationFailure(attempt.error)) return ["R-8: the connection reached TLS and failed verification, so the network filter is not shown"];
  if (!isNetworkRefusal(attempt.error)) return ["R-8: the connection failed for an unclassified reason, so the network filter is not shown"];
  return [];
}

/** Resolve the recorded DNS name to one IPv4 address, for the IP-literal control. */
export type ResolveIpv4 = (host: string) => Promise<string>;
export const realResolveIpv4: ResolveIpv4 = async (host) => (await lookup(host, { family: 4 })).address;

/** V-4 against the recorded endpoint: the positive control and both negative controls. */
export async function runTlsControls(record: StagingRecord, caPem: string, password: string, operatorSql: OperatorSql, resolveIpv4: ResolveIpv4): Promise<readonly string[]> {
  const url = doadminUrl(record, password, "defaultdb");
  const ip = await resolveIpv4(record.digitalOcean.host);
  const ipUrl = `postgresql://doadmin:${encodeURIComponent(password)}@${ip}:${record.digitalOcean.port}/defaultdb`;
  return tlsControlProblems({
    positive: await attemptIdentityRead(operatorSql, url, caPem, "bi4_staging_v4"),
    wrongCa: await attemptIdentityRead(operatorSql, url, negativeControlCas(), "bi4_staging_v4"),
    ipLiteral: await attemptIdentityRead(operatorSql, ipUrl, caPem, "bi4_staging_v4"),
  });
}

/** V-5: identity reads, before any other statement. */
export async function identityProblems(db: Kysely<ListingDatabase>, expectedDatabase: string): Promise<readonly string[]> {
  const { rows } = await sql<{ database: string; session_user: string; major: string }>`select current_database() as database, session_user, (current_setting('server_version_num')::int / 10000)::text as major`.execute(db);
  const row = rows[0] as { database: string; session_user: string; major: string } | undefined;
  if (row === undefined) return ["V-5: the identity read returned no row"];
  const problems: string[] = [];
  if (row.database !== expectedDatabase) problems.push(`V-5: current_database() is ${row.database}, expected ${expectedDatabase}`);
  if (row.session_user !== "doadmin") problems.push(`V-5: session_user is ${row.session_user}, expected doadmin`);
  if (row.major !== DO_VERSION) problems.push(`V-5: the server major version is ${row.major}, expected ${DO_VERSION}`);
  return problems;
}

/** The stored marker of `bi4_staging`. */
export async function storedMarker(db: Kysely<ListingDatabase>): Promise<string | null> {
  const { rows } = await sql<{ marker: string | null }>`select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()`.execute(db);
  return (rows[0] as { marker: string | null } | undefined)?.marker ?? null;
}

/** V-4's negative controls must refuse: a CA that did not issue the certificate, and an IP-literal host. */
export function negativeControlCas(): string {
  const root = rootCertificates[0];
  if (root === undefined) throw new Error("no bundled root certificate is available for the wrong-CA control");
  return root;
}

/* ------------------------------------------------------------------------------------------- */
/* HTTP exchanges                                                                                  */
/* ------------------------------------------------------------------------------------------- */

export interface Exchange {
  readonly status: number;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
}

export interface ExchangeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Transport = (origin: string, request: ExchangeRequest) => Promise<Exchange>;

/** One request, no redirect followed, the body read in full. */
export const realTransport: Transport = (origin, request) =>
  new Promise((resolve, reject) => {
    const url = new URL(request.path, origin);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: request.method, headers: { connection: "close", ...request.headers }, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timed out after 30 s")));
    req.on("error", reject);
    req.end();
  });

export function headerValuesOf(exchange: Exchange, name: string): readonly string[] {
  const values: string[] = [];
  for (let i = 0; i < exchange.rawHeaders.length; i += 2) if ((exchange.rawHeaders[i] as string).toLowerCase() === name) values.push(exchange.rawHeaders[i + 1] as string);
  return values;
}

/** The header list with the declared varying headers (`Date`, `Rndr-Id`) removed. */
export function withoutVaryingHeaders(rawHeaders: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (!VARYING_RESPONSE_HEADERS.includes((rawHeaders[i] as string).toLowerCase())) kept.push(rawHeaders[i] as string, rawHeaders[i + 1] as string);
  }
  return kept;
}

export interface Budget {
  readonly limit: number;
  used(): number;
  take(label: string): void;
}

export function createBudget(limit: number): Budget {
  let used = 0;
  return {
    limit,
    used: () => used,
    take(label) {
      if (used >= limit) throw new Error(`the ${limit}-attempt cap was reached before ${label}; nothing further is sent`);
      used += 1;
    },
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The gate (R-3, R-4) and the cache policy (R-2b, K-1 to K-5)                                    */
/* ------------------------------------------------------------------------------------------- */

export type KeyMode = "none" | "wrong" | "valid";

export interface Probe {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly key: KeyMode;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expect: "gate" | "gate-or-redirect" | "pass";
}

export const PROBE_METHODS: readonly string[] = ["GET", "HEAD", "POST", "OPTIONS"];

/** The §5 / R-3 path list. The static asset path is discovered per build. */
export function probePaths(fixtures: E3Fixtures, staticAsset: string, randomSuffix: string = randomBytes(4).toString("hex")): readonly string[] {
  return [
    "/",
    "/directory",
    "/directory/",
    `/directory/${fixtures.publiclyAvailable}`,
    `/directory/${fixtures.neverExisted[0]}`,
    `/directory/${fixtures.malformed}`,
    "/admin",
    "/admin/sign-in",
    "/admin/sign-in/code",
    "/admin/sign-in/recovery",
    "/admin/recovery",
    "/admin/sign-in/password",
    "/admin/sign-in/code/verify",
    "/admin/sign-in/recovery/verify",
    "/admin/sign-out",
    "/admin/recovery/codes",
    "/admin/recovery/sign-out",
    "/admin/recovery/reenrolment/start",
    "/admin/recovery/reenrolment/complete",
    staticAsset,
    "/_next/image?url=%2Ffavicon.ico&w=64&q=75",
    "/favicon.ico",
    STAGING_STATUS_PATH,
    `/bi4-staging-probe-${randomSuffix}`,
  ];
}

/** R-3 (keyless and wrong key, every path and method, plus the special forms) and R-4 (keyed, not S2 or status). */
export function gateProbes(fixtures: E3Fixtures, staticAsset: string): readonly Probe[] {
  const probes: Probe[] = [];
  const paths = probePaths(fixtures, staticAsset);
  for (const path of paths) {
    for (const method of PROBE_METHODS) {
      const expect = path.endsWith("/") && path !== "/" ? "gate-or-redirect" : "gate";
      probes.push({ label: `R-3 keyless ${method} ${path}`, method, path, key: "none", expect });
      probes.push({ label: `R-3 wrong key ${method} ${path}`, method, path, key: "wrong", expect });
    }
  }
  const s2 = `/directory/${fixtures.neverExisted[0]}`;
  probes.push({ label: "R-3 key in query string", method: "GET", path: `${s2}?${STAGING_KEY_HEADER}=KEY`, key: "none", expect: "gate" });
  probes.push({ label: "R-3 key in cookie", method: "GET", path: s2, key: "none", headers: { cookie: `${STAGING_KEY_HEADER}=KEY` }, expect: "gate" });
  probes.push({ label: "R-3 keyed with a query string", method: "GET", path: `${s2}?x=1`, key: "valid", expect: "gate" });
  // R-4 (§8 A): with a valid key, every path other than S2 and the status route gets the gate 404
  // (GET on each path), and so do the methods S2 and the status route do not allow.
  for (const path of paths) {
    if (/^\/directory\/[^/]+$/.test(path) || path === STAGING_STATUS_PATH) continue;
    probes.push({ label: `R-4 keyed GET ${path}`, method: "GET", path, key: "valid", expect: path.endsWith("/") && path !== "/" ? "gate-or-redirect" : "gate" });
  }
  for (const method of ["POST", "OPTIONS"]) probes.push({ label: `R-4 keyed ${method} ${s2}`, method, path: s2, key: "valid", expect: "gate" });
  for (const method of ["HEAD", "POST", "OPTIONS"]) probes.push({ label: `R-4 keyed ${method} status`, method, path: STAGING_STATUS_PATH, key: "valid", expect: "gate" });
  return probes;
}

/** Whether a response is the gate `404`, exactly. */
export function gateProblems(exchange: Exchange, label: string, method: string): readonly string[] {
  const problems: string[] = [];
  if (exchange.status !== 404) problems.push(`${label}: status ${exchange.status}, expected the gate 404`);
  if (method !== "HEAD" && exchange.body.toString("utf8") !== "Not Found") problems.push(`${label}: body is not the gate's "Not Found"`);
  const contentType = headerValuesOf(exchange, "content-type");
  if (contentType.length !== 1 || contentType[0] !== "text/plain; charset=utf-8") problems.push(`${label}: Content-Type is ${JSON.stringify(contentType)}`);
  const cacheControl = headerValuesOf(exchange, "cache-control");
  if (cacheControl.length !== 1 || cacheControl[0] !== "no-store") problems.push(`${label}: Cache-Control is ${JSON.stringify(cacheControl)}`);
  if (headerValuesOf(exchange, "age").length > 0) problems.push(`${label}: an Age header is present (a cache served it)`);
  return problems;
}

/** Evaluate one probe. A redirect is acceptable only for a trailing-slash form, to the slash-less path. */
export function probeProblems(probe: Probe, exchange: Exchange): readonly string[] {
  if (probe.expect === "gate-or-redirect" && exchange.status === 308) {
    const location = headerValuesOf(exchange, "location");
    return location.length === 1 && location[0] === probe.path.replace(/\/$/, "") ? [] : [`${probe.label}: 308 to ${JSON.stringify(location)}`];
  }
  if (probe.expect === "pass") return exchange.status === 404 && exchange.body.toString("utf8") === "Not Found" ? [`${probe.label}: got the gate 404`] : [];
  return gateProblems(exchange, probe.label, probe.method);
}

/** All gate responses must be byte-identical apart from `Date` and `Rndr-Id`. */
export function gateUniformityProblems(exchanges: readonly { readonly label: string; readonly method: string; readonly exchange: Exchange }[]): readonly string[] {
  const gates = exchanges.filter((item) => item.exchange.status === 404 && item.method !== "HEAD");
  const signature = (exchange: Exchange) => sha256Hex(Buffer.concat([Buffer.from(JSON.stringify(withoutVaryingHeaders(exchange.rawHeaders))), exchange.body]));
  const [first] = gates;
  if (first === undefined) return [];
  const reference = signature(first.exchange);
  return gates.filter((item) => signature(item.exchange) !== reference).map((item) => `${item.label}: the gate response differs from ${first.label}'s apart from Date and Rndr-Id`);
}

/** §4.1: a keyed response's `Cache-Control`, as received through Render. */
export function cachePolicyProblems(exchange: Exchange, label: string): readonly string[] {
  const values = headerValuesOf(exchange, "cache-control");
  const directives = values.flatMap((value) => value.split(",").map((part) => part.trim().toLowerCase()));
  const problems: string[] = [];
  if (values.length === 0) problems.push(`${label}: no Cache-Control header`);
  if (!directives.includes("no-store")) problems.push(`${label}: Cache-Control ${JSON.stringify(values)} lacks no-store`);
  if (directives.includes("public")) problems.push(`${label}: Cache-Control has public`);
  if (directives.some((directive) => directive.startsWith("s-maxage"))) problems.push(`${label}: Cache-Control has s-maxage`);
  if (headerValuesOf(exchange, "age").length > 0) problems.push(`${label}: an Age header is present`);
  return problems;
}

export interface KCheckRun {
  readonly url: string;
  readonly results: readonly { readonly id: string; readonly label: string; readonly exchange: Exchange; readonly problems: readonly string[] }[];
}

/** K-1 to K-5 for one URL (§4.2). `wait` is the K-2 30-second pause. */
export async function runKChecks(
  url: string,
  send: (request: ExchangeRequest, key: KeyMode) => Promise<Exchange>,
  wait: (ms: number) => Promise<void>,
): Promise<KCheckRun> {
  const results: { id: string; label: string; exchange: Exchange; problems: readonly string[] }[] = [];
  const add = (id: string, label: string, exchange: Exchange, problems: readonly string[]) => results.push({ id, label, exchange, problems });

  const keyed = await send({ method: "GET", path: url }, "valid");
  add("K-5", `K-5 keyed GET ${url}`, keyed, cachePolicyProblems(keyed, `K-5 ${url}`));
  const k1 = await send({ method: "GET", path: url }, "none");
  add("K-1", `K-1 keyless GET ${url} after keyed`, k1, gateProblems(k1, `K-1 ${url}`, "GET"));
  const etag = headerValuesOf(keyed, "etag")[0];
  const lastModified = headerValuesOf(keyed, "last-modified")[0] ?? new Date().toUTCString();
  const k3 = await send({ method: "GET", path: url, headers: { ...(etag === undefined ? {} : { "if-none-match": etag }), "if-modified-since": lastModified } }, "none");
  add("K-3", `K-3 keyless conditional GET ${url}`, k3, [...gateProblems(k3, `K-3 ${url}`, "GET"), ...(k3.status === 304 ? [`K-3 ${url}: 304 Not Modified`] : [])]);
  const k4head = await send({ method: "HEAD", path: url }, "none");
  add("K-4", `K-4 keyless HEAD ${url}`, k4head, gateProblems(k4head, `K-4 HEAD ${url}`, "HEAD"));
  const k4range = await send({ method: "GET", path: url, headers: { range: "bytes=0-99" } }, "none");
  add("K-4", `K-4 keyless ranged GET ${url}`, k4range, gateProblems(k4range, `K-4 range ${url}`, "GET"));
  await wait(30_000);
  const k2 = await send({ method: "GET", path: url }, "none");
  add("K-2", `K-2 keyless GET ${url} after 30 s`, k2, gateProblems(k2, `K-2 ${url}`, "GET"));
  return { url, results };
}

/* ------------------------------------------------------------------------------------------- */
/* Remote equivalence (R-10), status (M-1, R-9), identity fallback (F-1 to F-4)                   */
/* ------------------------------------------------------------------------------------------- */

export interface EquivalenceMember {
  readonly label: string;
  readonly identity: string;
  readonly state: "NE" | "PE" | "RJ" | "UP";
  readonly exchange: Exchange;
}

/** R-10: the five members agree on status, masked body and header list (Date and Rndr-Id removed). */
export function remoteEquivalenceProblems(members: readonly EquivalenceMember[], publicControls: readonly { readonly label: string; readonly identity: string; readonly exchange: Exchange; readonly publicName: string }[]): readonly string[] {
  const problems: string[] = [];
  const signatures = members.map((member) => ({
    label: member.label,
    status: member.exchange.status,
    body: sha256Hex(maskOwnIdentity(member.exchange.body, member.identity).masked),
    headers: comparisonListOf(withoutVaryingHeaders(member.exchange.rawHeaders), member.identity).hash,
  }));
  for (const state of ["NE", "PE", "RJ", "UP"] as const) if (!members.some((member) => member.state === state)) problems.push(`R-10: no ${state} member`);
  if (members.filter((member) => member.state === "NE").length < 2) problems.push("R-10: at least two never-existed members are required");
  const [reference] = signatures;
  if (reference !== undefined) {
    if (reference.status !== 200) problems.push(`R-10: ${reference.label} status ${reference.status}, expected 200`);
    for (const signature of signatures.slice(1)) {
      if (signature.status !== reference.status) problems.push(`R-10: ${signature.label} status differs`);
      if (signature.body !== reference.body) problems.push(`R-10: ${signature.label} masked body differs`);
      if (signature.headers !== reference.headers) problems.push(`R-10: ${signature.label} header list differs (Date and Rndr-Id removed)`);
    }
    for (const control of publicControls) {
      if (!control.exchange.body.toString("utf8").includes(control.publicName)) problems.push(`R-10: ${control.label} does not show the public listing`);
      if (sha256Hex(maskOwnIdentity(control.exchange.body, control.identity).masked) === reference.body) problems.push(`R-10: ${control.label} equals the never-existed body, so the comparison showed no difference`);
    }
  }
  return problems;
}

/** M-1 / R-5 / R-9: one status payload against the record and, optionally, the previous one. */
export function statusProblems(
  record: StagingRecord,
  current: StagingStatusPayload,
  previous: StagingStatusPayload | undefined,
  expectedReadDelta: number | undefined,
): readonly string[] {
  const problems: string[] = [];
  const host = new URL(record.render.url).hostname;
  if (current.render.serviceId !== record.render.serviceId) problems.push(`M-1: RENDER_SERVICE_ID is ${current.render.serviceId}, recorded ${record.render.serviceId}`);
  if (current.render.externalHostname !== host) problems.push(`M-1: RENDER_EXTERNAL_HOSTNAME is ${current.render.externalHostname}, recorded ${host}`);
  if (current.render.gitCommit !== record.run.authorizedCommit) problems.push(`M-1: RENDER_GIT_COMMIT is ${current.render.gitCommit}, authorized ${record.run.authorizedCommit}`);
  if (current.state !== "verified") problems.push(`M-1: state is ${current.state}, expected verified`);
  if (current.counters.refusals !== 0) problems.push(`M-1: refusals is ${current.counters.refusals}`);
  if (current.counters.readsAfterRefusal !== 0) problems.push(`M-1: readsAfterRefusal is ${current.counters.readsAfterRefusal}`);
  if (previous !== undefined) {
    if (current.bootNonce !== previous.bootNonce) problems.push("M-1: bootNonce changed: the process restarted");
    if (current.render.instanceId !== previous.render.instanceId) problems.push("M-1: RENDER_INSTANCE_ID changed");
    const overlapDelta = current.counters.overlappedReads - previous.counters.overlappedReads;
    if (overlapDelta !== 0) problems.push(`M-1 / SP-5: ${overlapDelta} overlapped read(s) observed: any observed read overlap during a measured phase invalidates the run`);
    if (expectedReadDelta !== undefined) {
      const delta = current.counters.s2Reads - previous.counters.s2Reads;
      if (delta !== expectedReadDelta) problems.push(`R-9: s2Reads grew by ${delta}, expected ${expectedReadDelta} (a cached or foreign keyed response would explain it)`);
    }
  }
  return problems;
}

/** F-1 to F-4 (§6.3): what the operator must confirm in the console, and the one automated check. */
export function identityFallbackChecklist(record: StagingRecord): readonly string[] {
  return [
    `F-1 (primary): open ${record.render.dashboardUrl} and confirm: name ${record.render.name}, ID ${record.render.serviceId}, region ${record.render.region}, plan ${record.render.plan}, URL ${record.render.url}, project ${record.render.projectName}, environment ${record.render.environmentId}.`,
    `F-2 (binding): in that service's environment, BI4_STAGING_ACCESS_KEY_SHA256 equals ${record.run.keyDigestHex} and BI4_STAGING_SYNTHETIC_MARKER equals the recorded marker (compare in the console; the marker is not printed here).`,
    `F-3 (corroborating): the latest deploy's commit equals ${record.run.authorizedCommit}.`,
    "F-4 (corroboration only): a keyless request returns the gate 404 with an Rndr-Id header (checked below).",
  ];
}

/* ------------------------------------------------------------------------------------------- */
/* Spend projection (§6.4)                                                                         */
/* ------------------------------------------------------------------------------------------- */

export interface Projection {
  readonly elapsedDays: number;
  readonly remainingDays: number;
  readonly projectedUsd: number;
  readonly stopUsd: number;
  readonly ceilingUsd: number;
  readonly stop: boolean;
  readonly deadlinePassed: boolean;
}

/**
 * Spend so far plus the remaining days to the deadline at the §6.4 rates. Render is projected per
 * second. DigitalOcean is counted at the worst case, its full monthly price, unless its billing page
 * shows hourly accrual. The stop rule fires at the chosen option's stop (seven days: $24).
 */
export function projectSpend(record: StagingRecord, nowIso: string, accrued: { readonly renderUsd: number; readonly doUsd: number }, doHourlyAccrualShown: boolean): Projection {
  const option = WINDOW_OPTIONS[record.run.window];
  const now = Date.parse(nowIso);
  const created = Date.parse(record.digitalOcean.createdAt);
  const deadline = Date.parse(record.run.deletionDeadline);
  const elapsedDays = Math.max(0, (now - created) / 86_400_000);
  const remainingDays = Math.max(0, (deadline - now) / 86_400_000);
  const render = accrued.renderUsd + (RATES.renderMonthlyUsd / RATES.daysPerMonth) * remainingDays;
  const digitalOcean = doHourlyAccrualShown ? accrued.doUsd + RATES.doHourlyUsd * 24 * remainingDays : Math.max(accrued.doUsd, RATES.doWorstCaseUsd);
  const projectedUsd = Math.round((render + digitalOcean) * 100) / 100;
  return {
    elapsedDays: Math.round(elapsedDays * 100) / 100,
    remainingDays: Math.round(remainingDays * 100) / 100,
    projectedUsd,
    stopUsd: option.stopUsd,
    ceilingUsd: option.ceilingUsd,
    stop: projectedUsd >= option.stopUsd,
    deadlinePassed: now >= deadline,
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Regression (§5): PB-1 to PB-5                                                                  */
/* ------------------------------------------------------------------------------------------- */

export type RegressionMode = "PB-1" | "PB-2" | "PB-3" | "PB-4" | "PB-5";
export const REGRESSION_MODES: readonly RegressionMode[] = ["PB-1", "PB-2", "PB-3", "PB-4", "PB-5"];

/** The probe matrix (§5): every path × GET, HEAD, POST, OPTIONS. */
export function regressionProbes(fixtures: E3Fixtures, staticAsset: string, randomSuffix?: string): readonly ExchangeRequest[] {
  return probePaths(fixtures, staticAsset, randomSuffix).flatMap((path) => PROBE_METHODS.map((method) => ({ method, path })));
}

/** The gate's baseline commit (§5): every baseline capture must be exactly this. */
export const GATE_BASELINE_COMMIT = "ba1002746f2b8a9d133182151af97961d1dfa06c";

/** Fixed identities for the regression matrix, so the baseline and candidate send identical paths. */
export const REGRESSION_FIXTURES: E3Fixtures = Object.freeze({
  neverExisted: ["e0000000-0000-4000-8000-000000000001", "e0000000-0000-4000-8000-000000000002"] as const,
  pending: "e0000000-0000-4000-8000-000000000003",
  rejected: "e0000000-0000-4000-8000-000000000004",
  unpublished: "e0000000-0000-4000-8000-000000000005",
  publiclyAvailable: "e0000000-0000-4000-8000-000000000006",
  malformed: "e3-malformed-regress00001",
  publicName: "",
  fixtureTexts: [],
}) as unknown as E3Fixtures;
export const REGRESSION_RANDOM_SUFFIX = "regress0";

/** PB-5's demo listings (`scripts/local-demo/fixtures.ts`): one approved, one pending, one rejected. */
export const DEMO_LISTINGS = Object.freeze({
  approved: { id: "0b7e4c52-6f1a-4d3b-8e29-5a1c7f3d9e01", name: "Juniper Lane Bakery" },
  pending: { id: "5acd9ba7-be6f-4c8a-937e-af6bce8c4d56", name: "Pending Example Florist" },
  rejected: { id: "6bdeacb8-cf7a-4d9b-a48f-ba7cdf9d5e67", name: "Rejected Example Consultancy" },
});
/** The local demo's fixed origin (`scripts/local-demo/local-demo.ts`). */
export const DEMO_ORIGIN = "http://127.0.0.1:3000";

/** PB-5's requests: the directory, the approved listing, the two non-public listings, a malformed one. */
export function demoRequests(): readonly ExchangeRequest[] {
  return [
    { method: "GET", path: "/directory" },
    { method: "GET", path: `/directory/${DEMO_LISTINGS.approved.id}` },
    { method: "GET", path: `/directory/${DEMO_LISTINGS.pending.id}` },
    { method: "GET", path: `/directory/${DEMO_LISTINGS.rejected.id}` },
    { method: "GET", path: "/directory/demo-malformed-regress" },
  ];
}

/* ------------------------------------------------------------------------------------------- */
/* The operator-managed regression procedure: what each capture proves                            */
/* ------------------------------------------------------------------------------------------- */

export type RegressionSide = "baseline" | "candidate";

/** Which sides each mode needs (§5.1): PB-3 and PB-4 are candidate-only. */
export function sidesFor(mode: RegressionMode): readonly RegressionSide[] {
  return mode === "PB-3" || mode === "PB-4" ? ["candidate"] : ["baseline", "candidate"];
}

/**
 * What independently corroborates each mode's launch-environment attestation, and what it cannot
 * show. Nothing reads a running process's environment; HTTP behaviour and process identity are the
 * only observations.
 */
export const ATTESTATION_CORROBORATION: Readonly<Record<RegressionMode, string>> = {
  "PB-1": "the HTTP signature (/ answers 200, so the staging gate is off; /directory is the framework 404, so the E3-local rule is off), the listener's command line (next start from the stated worktree) and the build proof",
  "PB-2": "the HTTP signature (/ answers 200, so the staging gate is off; /directory is the plain Not Found, so BI4_E3_LOCAL=1 reached the proxy), the listener's command line and the build proof",
  "PB-3": "the HTTP signature only (/ is the gate 404, so BI4_STAGING is armed and deny-all is in force) and the listener's command line. PB-3 and PB-4 cannot be distinguished by HTTP behaviour: both are deny-all, so whether BI4_E3_LOCAL was also set rests on this attestation alone. There is no build proof (every asset is gated)",
  "PB-4": "the HTTP signature only (/ is the gate 404, so BI4_STAGING is armed and deny-all is in force) and the listener's command line. PB-3 and PB-4 cannot be distinguished by HTTP behaviour: both are deny-all, so whether BI4_E3_LOCAL was also set rests on this attestation alone. There is no build proof (every asset is gated)",
  "PB-5": "the HTTP signature (/directory lists the demo's approved listing, so the dev demo's data source is configured) and the listener's command line. Under next dev every BI4_* variable is ignored, so their absence is attested, not observed. There is no build proof (dev server)",
};

/**
 * The environment the operator says the server was launched with, as `BI4_*` and `LOCAL_DEMO_*`
 * names only. **Operator attestation**, hashed into the capture. It is checked for consistency with
 * the mode here; `ATTESTATION_CORROBORATION` says which observations support it.
 */
export function modeEnvironmentProblems(mode: RegressionMode, variables: Readonly<Record<string, string>>): readonly string[] {
  const names = Object.keys(variables).sort();
  const problems: string[] = [];
  if (names.some((name) => !name.startsWith("BI4_") && !name.startsWith("LOCAL_DEMO_"))) problems.push("the environment file may list only BI4_* and LOCAL_DEMO_* names");
  const expect = (wanted: Readonly<Record<string, string>>, exact: boolean): void => {
    for (const [name, value] of Object.entries(wanted)) if (variables[name] !== value) problems.push(`${mode}: ${name} must be ${JSON.stringify(value)}`);
    if (exact && names.some((name) => !(name in wanted))) problems.push(`${mode}: only ${JSON.stringify(Object.keys(wanted))} may be set`);
  };
  if (mode === "PB-1" || mode === "PB-5") expect({}, true);
  if (mode === "PB-2") expect({ BI4_E3_LOCAL: "1" }, true);
  if (mode === "PB-3") expect({ BI4_STAGING: "1" }, true);
  if (mode === "PB-4") {
    expect({ BI4_STAGING: "1", BI4_E3_LOCAL: "1" }, false);
    if (names.some((name) => name.startsWith("LOCAL_DEMO_"))) problems.push("PB-4: no LOCAL_DEMO_* variable may be set");
  }
  return problems;
}

/** The behavioural mode signature, observed before the capture (§5.1). */
export function modeSignatureProblems(mode: RegressionMode, observed: { readonly home: Exchange; readonly directory: Exchange }): readonly string[] {
  const plain = (exchange: Exchange) => exchange.status === 404 && exchange.body.toString("utf8") === "Not Found";
  switch (mode) {
    case "PB-1":
      return [...(observed.home.status === 200 ? [] : [`PB-1 signature: / returned ${observed.home.status}`]), ...(observed.directory.status === 404 && !plain(observed.directory) ? [] : ["PB-1 signature: /directory is not the framework 404 (the E3-local rule or staging appears to be on)"])];
    case "PB-2":
      return [...(observed.home.status === 200 ? [] : [`PB-2 signature: / returned ${observed.home.status}`]), ...(plain(observed.directory) ? [] : ["PB-2 signature: /directory is not the E3-local plain 404 (BI4_E3_LOCAL=1 appears unset)"])];
    case "PB-3":
    case "PB-4":
      return gateProblems(observed.home, `${mode} signature: /`, "GET");
    case "PB-5":
      return observed.directory.status === 200 && observed.directory.body.toString("utf8").includes(DEMO_LISTINGS.approved.name) ? [] : ["PB-5 signature: /directory does not list the demo's approved listing (the demo is not running)"];
  }
}

const normalizedPath = (path: string): string => resolve(path).replace(/\\/g, "/").toLowerCase();

/** Commit proof: a registered, clean, detached worktree at exactly the stated commit. */
export async function worktreeProblems(seams: Pick<StagingSeams, "git" | "repositoryRoot">, worktree: string, commit: string, side: RegressionSide): Promise<readonly string[]> {
  const problems: string[] = [];
  if (!isAbsolute(worktree) || !existsSync(worktree)) return [`worktree ${worktree} must be an absolute, existing path`];
  if (normalizedPath(worktree) === normalizedPath(seams.repositoryRoot) || !relative(seams.repositoryRoot, worktree).startsWith("..")) problems.push("the worktree must not be, or be inside, the main repository tree");
  if (!COMMIT.test(commit)) problems.push("--commit must be a full 40-character SHA");
  if (side === "baseline" && commit !== GATE_BASELINE_COMMIT) problems.push(`the baseline must be the gate baseline ${GATE_BASELINE_COMMIT}`);
  const head = (await seams.git(worktree, ["rev-parse", "HEAD"])).trim();
  if (head !== commit) problems.push(`the worktree is at ${head}, not ${commit}`);
  const dirty = (await seams.git(worktree, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty !== "") problems.push("the worktree has tracked changes");
  const registered = parseWorktreeList(await seams.git(seams.repositoryRoot, ["worktree", "list", "--porcelain"])).find((entry) => normalizedPath(entry.path) === normalizedPath(worktree));
  if (registered === undefined) problems.push("the worktree is not registered with the main repository");
  else if (!registered.detached || registered.head !== commit) problems.push("the registered worktree is not detached at the stated commit");
  return problems;
}

/**
 * Server identity: every listener on the port is on 127.0.0.1 and owned by one process, whose
 * command line runs Next.js from this worktree. The identity (PID and creation time) is recorded,
 * so the teardown proof can show this exact process is gone.
 */
export async function serverIdentityProblems(seams: Pick<StagingSeams, "listeners" | "processes">, origin: string, worktree: string): Promise<{ readonly problems: readonly string[]; readonly port: number; readonly identity?: ProcessIdentity }> {
  const port = Number(new URL(origin).port);
  const entries = await seams.listeners(port);
  const owners = [...new Set(entries.map((entry) => entry.owningProcess))];
  const problems: string[] = [];
  if (entries.length === 0) return { problems: [`nothing listens on port ${port}`], port };
  if (entries.some((entry) => entry.localAddress !== "127.0.0.1")) problems.push(`port ${port} has a listener not on 127.0.0.1`);
  if (owners.length !== 1) problems.push(`port ${port} has ${owners.length} owning processes`);
  const identity = owners.length === 1 ? await seams.processes.inspect(owners[0] as number) : undefined;
  if (identity === undefined) return { problems: [...problems, "the listening process could not be identified"], port };
  const commandLine = (identity.commandLine ?? "").replace(/\\/g, "/").toLowerCase();
  if (!commandLine.includes(normalizedPath(worktree))) problems.push("the listening process's command line does not run from this worktree");
  if (!/next/.test(commandLine)) problems.push("the listening process is not a Next.js server");
  if (!/^\d+$/.test(identity.creationTime)) problems.push("the listening process has no usable creation time, so its later absence could not be proven");
  return { problems, port, identity };
}

/** Build proof (PB-1, PB-2): the static asset the server serves is byte-identical to this worktree's build output. */
export function assetProofProblems(worktree: string, assetPath: string | undefined, served: Exchange | undefined): readonly string[] {
  if (assetPath === undefined || served === undefined) return ["no static asset was found on the home page, so the build is not proven"];
  const file = join(worktree, ".next", decodeURIComponent(assetPath.replace(/^\/_next\//, "")));
  if (!existsSync(file)) return [`the served asset ${assetPath} is not in this worktree's .next`];
  if (served.status !== 200) return [`the served asset returned ${served.status}`];
  return sha256Hex(readFileSync(file)) === sha256Hex(served.body) ? [] : ["the served asset differs from this worktree's build output"];
}

export interface CapturedExchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly rawHeaders: readonly string[];
  readonly bodyBase64: string;
}

export interface RegressionCapture {
  readonly schema: "bi4-staging-regress-capture/1";
  readonly mode: RegressionMode;
  readonly side: RegressionSide;
  readonly origin: string;
  readonly commit: string;
  readonly worktree: string;
  /**
   * What the operator says the server was started with. **Operator attestation, not observation:**
   * no tool here can read another process's environment. `corroboration` states which independent
   * checks support it, and what they cannot show.
   */
  readonly launchEnvironment: {
    readonly kind: "operator attestation";
    readonly sha256: string;
    readonly variables: Readonly<Record<string, string>>;
    readonly corroboration: string;
  };
  /** Where the capture stopped, or `null` when every stage passed and the matrix was sent. */
  readonly stoppedAt: string | null;
  readonly server: { readonly port: number; readonly identity: ProcessIdentity | null };
  readonly buildId: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly attempts: number;
  readonly problems: readonly string[];
  readonly exchanges: readonly CapturedExchange[];
}

export const captureFileName = (mode: RegressionMode, side: RegressionSide): string => `${mode}-${side}.capture.json`;

const toExchange = (captured: CapturedExchange): Exchange => ({ status: captured.status, rawHeaders: captured.rawHeaders, body: Buffer.from(captured.bodyBase64, "base64") });

/** PB-5: the demo pages agree after the dev request-ID mask, and show the right content on both sides. */
export function demoComparisonProblems(baseline: readonly CapturedExchange[], candidate: readonly CapturedExchange[]): readonly string[] {
  const problems: string[] = [];
  const masked = (exchange: Exchange): string => {
    const result = maskNextRequestId(exchange.body);
    const body = result.outcome === "ok" ? result.masked : exchange.body;
    return body.toString("latin1").replace(/\/_next\/static\/[^"'\s)]+/g, "/_next/static/<asset>");
  };
  demoRequests().forEach((request, index) => {
    const b = baseline[index];
    const c = candidate[index];
    if (b === undefined || c === undefined || b.path !== request.path || c.path !== request.path) {
      problems.push(`PB-5 ${request.path}: missing or misordered exchange`);
      return;
    }
    const be = toExchange(b);
    const ce = toExchange(c);
    if (be.status !== ce.status) problems.push(`PB-5 ${request.path}: status ${ce.status}, baseline ${be.status}`);
    if (masked(be) !== masked(ce)) problems.push(`PB-5 ${request.path}: body differs from the baseline after masking`);
  });
  const text = (list: readonly CapturedExchange[], index: number) => (list[index] === undefined ? "" : toExchange(list[index] as CapturedExchange).body.toString("utf8"));
  for (const [side, list] of [["baseline", baseline], ["candidate", candidate]] as const) {
    if (!text(list, 1).includes(DEMO_LISTINGS.approved.name)) problems.push(`PB-5 (${side}): the approved demo listing does not render its name`);
    for (const index of [2, 3, 4]) if (!text(list, index).includes("<h1>Not available</h1>")) problems.push(`PB-5 (${side}): ${demoRequests()[index]?.path} does not render the not-available content`);
    for (const name of [DEMO_LISTINGS.pending.name, DEMO_LISTINGS.rejected.name]) if (list.some((_, index) => text(list, index).includes(name))) problems.push(`PB-5 (${side}): a non-public demo listing's name appears`);
  }
  return problems;
}

/** Compare a mode's captures (§5). Every capture must be precondition-clean, for the right side and mode. */
export function compareCaptures(mode: RegressionMode, baseline: RegressionCapture | undefined, candidate: RegressionCapture): readonly string[] {
  const problems: string[] = [];
  const own = (capture: RegressionCapture, side: RegressionSide) => {
    if (capture.mode !== mode || capture.side !== side) problems.push(`the ${side} capture is for ${capture.mode} ${capture.side}`);
    if (capture.problems.length > 0) problems.push(`the ${side} capture has unresolved precondition problems`);
  };
  own(candidate, "candidate");
  if (sidesFor(mode).includes("baseline")) {
    if (baseline === undefined) return [...problems, `${mode} needs a baseline capture`];
    own(baseline, "baseline");
    if (baseline.commit !== GATE_BASELINE_COMMIT) problems.push(`the baseline capture is at ${baseline.commit}, not the gate baseline`);
    if (candidate.commit === baseline.commit) problems.push("the candidate and baseline are the same commit");
  }
  const candidateExchanges = candidate.exchanges.map(toExchange);
  if (mode === "PB-3" || mode === "PB-4") {
    problems.push(...denyAllProblems(candidate.exchanges.map(({ method, path }) => ({ method, path })), candidateExchanges));
  } else if (mode === "PB-5") {
    problems.push(...demoComparisonProblems((baseline as RegressionCapture).exchanges, candidate.exchanges));
  } else {
    const b = baseline as RegressionCapture;
    const probes = b.exchanges.map(({ method, path }) => ({ method, path }));
    const candidatePaths = candidate.exchanges.map(({ method, path }) => `${method} ${path.replace(/\/_next\/static\/.+$/, "/_next/static/<asset>")}`);
    const baselinePaths = probes.map(({ method, path }) => `${method} ${path.replace(/\/_next\/static\/.+$/, "/_next/static/<asset>")}`);
    if (JSON.stringify(candidatePaths) !== JSON.stringify(baselinePaths)) problems.push("the baseline and candidate captures sent different request lists");
    problems.push(...compareRegression(probes, b.exchanges.map(toExchange), candidateExchanges, { ...(b.buildId === null ? {} : { baseline: b.buildId }), ...(candidate.buildId === null ? {} : { candidate: candidate.buildId }) }));
  }
  return problems;
}

/**
 * Teardown proof for every capture in a run directory: the recorded server process is gone (or its
 * PID now belongs to a different process), nothing listens on its port, the worktree directory is
 * gone and no longer registered, and the main tree shows only its pre-existing untracked files.
 */
export async function regressionTeardownProblems(seams: Pick<StagingSeams, "git" | "listeners" | "processes" | "repositoryRoot">, captures: readonly RegressionCapture[]): Promise<readonly string[]> {
  const problems: string[] = [];
  const worktrees = parseWorktreeList(await seams.git(seams.repositoryRoot, ["worktree", "list", "--porcelain"]));
  for (const capture of captures) {
    const label = `${capture.mode} ${capture.side}`;
    const recorded = capture.server.identity;
    if (recorded === null) problems.push(`${label}: no server identity was recorded, so its absence cannot be proven`);
    else {
      const live = await seams.processes.inspect(recorded.pid);
      if (live !== undefined && live.creationTime === recorded.creationTime) problems.push(`${label}: the server process ${recorded.pid} is still running`);
    }
    if ((await seams.listeners(capture.server.port)).length > 0) problems.push(`${label}: port ${capture.server.port} still has a listener`);
    if (existsSync(capture.worktree)) problems.push(`${label}: the worktree directory still exists`);
    if (worktrees.some((entry) => normalizedPath(entry.path) === normalizedPath(capture.worktree))) problems.push(`${label}: the worktree is still registered`);
  }
  const status = (await seams.git(seams.repositoryRoot, ["status", "--porcelain"])).split(/\r?\n/).filter((line) => line !== "");
  const expected = new Set(RESTRICTED_FILES.map((file) => `?? ${file}`));
  for (const line of status) if (!expected.has(line)) problems.push(`main tree: unexpected status line ${JSON.stringify(line)}`);
  return problems;
}

/** R-1: a local build of the authorized commit names no staging value or prefix in client assets. */
export function buildScanProblems(worktree: string): readonly string[] {
  const root = join(worktree, ".next", "static");
  if (!existsSync(join(worktree, ".next", "BUILD_ID"))) return ["R-1: the worktree has no completed build (.next/BUILD_ID is missing)"];
  const problems: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const bytes = readFileSync(path);
        for (const needle of ["BI4_STAGING", STAGING_KEY_HEADER, "bi4-staging-synthetic"]) if (bytes.includes(Buffer.from(needle))) problems.push(`R-1: ${relative(worktree, path)} contains ${needle}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return problems;
}

/** Header values masked before comparison: `Date`, `ETag`, `x-nextjs-*` identifiers, build IDs. */
export function maskBuildDependent(exchange: Exchange, buildId: string | undefined): { readonly headers: readonly string[]; readonly body: string } {
  const headers: string[] = [];
  for (let i = 0; i < exchange.rawHeaders.length; i += 2) {
    const name = (exchange.rawHeaders[i] as string).toLowerCase();
    let value = exchange.rawHeaders[i + 1] as string;
    if (name === "date" || name === "etag" || name.startsWith("x-nextjs-")) value = "<masked>";
    if (buildId !== undefined) value = value.split(buildId).join("<build>");
    headers.push(name, value);
  }
  let body = exchange.body.toString("latin1");
  if (buildId !== undefined) body = body.split(buildId).join("<build>");
  body = body.replace(/\/_next\/static\/[^"'\s)]+/g, "/_next/static/<asset>");
  return { headers, body };
}

/** The build ID a page names (`/_next/static/<id>/…` or `"buildId":"…"`), if any. */
export function buildIdOf(html: string): string | undefined {
  return /"buildId":"([^"]+)"/.exec(html)?.[1] ?? /\/_next\/static\/([A-Za-z0-9_-]{8,})\/_(?:buildManifest|ssgManifest)/.exec(html)?.[1];
}

/** The first static asset a page references. */
export function staticAssetOf(html: string): string | undefined {
  return /(\/_next\/static\/[^"'\s)]+\.js)/.exec(html)?.[1];
}

/** §5.2: the only approved difference (D-G1 ruled: bytes must be identical, so none by default). */
export const APPROVED_REGRESSION_DIFFERENCES: readonly string[] = [];

/** PB-1 / PB-2: candidate equals baseline per probe, after masking. */
export function compareRegression(
  probes: readonly ExchangeRequest[],
  baseline: readonly Exchange[],
  candidate: readonly Exchange[],
  buildIds: { readonly baseline?: string; readonly candidate?: string },
): readonly string[] {
  const problems: string[] = [];
  probes.forEach((probe, index) => {
    const label = `${probe.method} ${probe.path.replace(/\/bi4-staging-probe-[0-9a-f]+$/, "/<random>").replace(/\/_next\/static\/.+$/, "/_next/static/<asset>")}`;
    if (APPROVED_REGRESSION_DIFFERENCES.includes(label)) return;
    const b = baseline[index];
    const c = candidate[index];
    if (b === undefined || c === undefined) {
      problems.push(`${label}: missing exchange`);
      return;
    }
    if (b.status !== c.status) problems.push(`${label}: status ${c.status}, baseline ${b.status}`);
    const mb = maskBuildDependent(b, buildIds.baseline);
    const mc = maskBuildDependent(c, buildIds.candidate);
    if (JSON.stringify(mb.headers) !== JSON.stringify(mc.headers)) problems.push(`${label}: header list differs after masking`);
    if (mb.body !== mc.body) problems.push(`${label}: body differs after masking`);
  });
  return problems;
}

/** PB-3 / PB-4: deny-all on the candidate (gate 404, or the framework 308 for trailing-slash forms). */
export function denyAllProblems(probes: readonly ExchangeRequest[], candidate: readonly Exchange[]): readonly string[] {
  return probes.flatMap((probe, index) => {
    const exchange = candidate[index];
    if (exchange === undefined) return [`${probe.method} ${probe.path}: missing exchange`];
    return probeProblems({ label: `${probe.method} ${probe.path}`, method: probe.method, path: probe.path, key: "none", expect: probe.path.endsWith("/") && probe.path !== "/" ? "gate-or-redirect" : "gate" }, exchange);
  });
}

/** Loopback-only origins for the regression and local checks. */
export function loopbackOriginProblems(origin: string): readonly string[] {
  try {
    const url = new URL(origin);
    const problems: string[] = [];
    if (url.protocol !== "http:") problems.push(`${origin}: only http on loopback is allowed`);
    if (url.hostname !== "127.0.0.1") problems.push(`${origin}: the host must be 127.0.0.1`);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") problems.push(`${origin}: an origin only, with no path`);
    return problems;
  } catch {
    return [`${origin}: not a URL`];
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Leak scans                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export function exchangeScanItem(label: string, exchange: Exchange): ScannedItem {
  const headers: string[] = [];
  for (let i = 0; i < exchange.rawHeaders.length; i += 2) headers.push(`${exchange.rawHeaders[i]}: ${exchange.rawHeaders[i + 1]}`);
  return { where: `response ${label}`, bytes: Buffer.concat([Buffer.from(headers.join("\r\n"), "latin1"), Buffer.from("\r\n\r\n"), exchange.body]) };
}

/** R-12 / T-2: no key, digest, password or marker in any response; no `BI4_STAGING_` prefix. */
export function stagingLeakProblems(items: readonly ScannedItem[], secrets: { readonly key?: string; readonly digest?: string; readonly doadminPassword?: string; readonly appPassword?: string; readonly marker?: string }): readonly string[] {
  const values = Object.entries(secrets)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([label, value]) => ({ label, value }));
  return [
    ...leakHits(items, values).map((hit) => `leak: ${hit.label} appears in ${hit.where}`),
    ...prefixHits(items, "BI4_STAGING_").map((where) => `leak: the BI4_STAGING_ prefix appears in ${where}`),
  ];
}

/* ------------------------------------------------------------------------------------------- */
/* Setup (as doadmin, over TLS): database, marker, migration, fixtures, role                      */
/* ------------------------------------------------------------------------------------------- */

export interface SetupResult {
  readonly appPassword: string;
  readonly appEnvironment: Readonly<Record<string, string>>;
  readonly storedStateProblems: readonly string[];
}

/** The Render environment values for the app (§2.6). Written only to the secret file. */
export function appEnvironmentOf(record: StagingRecord, appPassword: string, caPem: string, calibration: readonly { readonly identity: string; readonly delayNs: number }[]): Readonly<Record<string, string>> {
  for (const entry of calibration) {
    if (!record.run.calibrationIdentities.includes(entry.identity)) throw new Error("a calibration identity is not one of the recorded, approved identities");
    if (!Number.isInteger(entry.delayNs) || entry.delayNs < 0 || entry.delayNs > CALIBRATION_DELAY_CEILING_NS) throw new Error("a calibration delay is outside 0 to the 2 ms ceiling");
  }
  return {
    BI4_STAGING: "1",
    BI4_STAGING_DATABASE_URL: `postgresql://${APP_ROLE}:${appPassword}@${record.digitalOcean.host}:${record.digitalOcean.port}/${STAGING_DATABASE}`,
    BI4_STAGING_EXPECTED_HOST: record.digitalOcean.host,
    BI4_STAGING_CA_PEM: caPem,
    BI4_STAGING_EXPECTED_DATABASE: STAGING_DATABASE,
    BI4_STAGING_SYNTHETIC_MARKER: record.run.marker,
    BI4_STAGING_ACCESS_KEY_SHA256: record.run.keyDigestHex,
    ...(calibration.length === 0 ? {} : { BI4_STAGING_CALIBRATION: calibration.map((entry) => `${entry.identity}:${entry.delayNs}`).join(",") }),
  };
}

export interface SetupSeams {
  readonly operatorSql: OperatorSql;
  readonly migrate: (db: Kysely<unknown>) => Promise<void>;
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<void> {
  const { error, results } = await new Migrator({ db, provider: createMigrationProvider() }).migrateToLatest();
  if (error !== undefined) throw error instanceof Error ? error : new Error(`the governed migration failed: ${String(error)}`);
  const failed = results?.filter((result) => result.status !== "Success") ?? [];
  if (failed.length > 0) throw new Error(`the governed migration did not succeed for ${failed.map((result) => result.migrationName).join(", ")}`);
}

/**
 * Setup, after V-1 to V-7 passed and the API showed `db_names` exactly `["defaultdb"]`. Each
 * connection is TLS `verify-full` to the recorded host with the recorded CA, as `doadmin`.
 */
export async function runSetup(record: StagingRecord, caPem: string, doadminPassword: string, seams: SetupSeams): Promise<SetupResult> {
  const bootstrap = seams.operatorSql.connect(doadminUrl(record, doadminPassword, "defaultdb"), caPem, "bi4_staging_setup");
  try {
    const identity = await identityProblems(bootstrap.db, "defaultdb");
    if (identity.length > 0) throw new Error(identity.join("; "));
    await sql.raw(`create database "${STAGING_DATABASE}"`).execute(bootstrap.db);
  } finally {
    await bootstrap.shutdown();
  }

  const main = seams.operatorSql.connect(doadminUrl(record, doadminPassword, STAGING_DATABASE), caPem, "bi4_staging_setup");
  try {
    const identity = await identityProblems(main.db, STAGING_DATABASE);
    if (identity.length > 0) throw new Error(identity.join("; "));
    if ((await storedMarker(main.db)) !== null) throw new Error("the new database already carries a comment; refusing");
    await sql.raw(`comment on database "${STAGING_DATABASE}" is '${record.run.marker}'`).execute(main.db);
    if ((await storedMarker(main.db)) !== record.run.marker) throw new Error("the marker did not read back");
    const { rows: tables } = await sql<{ n: string }>`select count(*)::text as n from pg_tables where schemaname = 'public'`.execute(main.db);
    if ((tables[0] as { n: string }).n !== "0") throw new Error("the new database already has tables; refusing");
    await seams.migrate(main.db as unknown as Kysely<unknown>);
    const { rows: existing } = await sql<{ n: string }>`select count(*)::text as n from listing`.execute(main.db);
    if ((existing[0] as { n: string }).n !== "0") throw new Error("listing rows exist before seeding; refusing");
    const plan = e3FixturePlan(record.run.fixtures);
    await loadFixtures(main.db, plan);
    const storedStateProblems = await verifyStoredStates(main.db, plan);
    for (const identity of record.run.calibrationIdentities) {
      const { rows } = await sql<{ n: string }>`select count(*)::text as n from listing where id = ${identity}::uuid`.execute(main.db);
      if ((rows[0] as { n: string }).n !== "0") throw new Error("a calibration identity exists in listing; refusing");
    }
    const appPassword = randomBytes(24).toString("hex");
    for (const statement of stagingRoleSetupStatements({ database: STAGING_DATABASE, role: APP_ROLE, password: appPassword })) {
      await sql.raw(statement).execute(main.db);
    }
    return { appPassword, appEnvironment: appEnvironmentOf(record, appPassword, caPem, []), storedStateProblems };
  } finally {
    await main.shutdown();
  }
}

/** The app role's effective privileges, read back (R-6). */
export async function appRolePrivilegeProblems(db: Kysely<ListingDatabase>): Promise<readonly string[]> {
  const { rows } = await sql<{ super: boolean; createrole: boolean; createdb: boolean; select_listing: boolean; insert_listing: boolean; update_listing: boolean; delete_listing: boolean; create_schema: boolean }>`
    select r.rolsuper as super, r.rolcreaterole as createrole, r.rolcreatedb as createdb,
      has_table_privilege(${APP_ROLE}, 'public.listing', 'SELECT') as select_listing,
      has_table_privilege(${APP_ROLE}, 'public.listing', 'INSERT') as insert_listing,
      has_table_privilege(${APP_ROLE}, 'public.listing', 'UPDATE') as update_listing,
      has_table_privilege(${APP_ROLE}, 'public.listing', 'DELETE') as delete_listing,
      has_schema_privilege(${APP_ROLE}, 'public', 'CREATE') as create_schema
    from pg_roles r where r.rolname = ${APP_ROLE}`.execute(db);
  const row = rows[0];
  if (row === undefined) return ["R-6: the app role does not exist"];
  const problems: string[] = [];
  if (row.super || row.createrole || row.createdb) problems.push("R-6: the app role has a role attribute beyond login");
  if (!row.select_listing) problems.push("R-6: the app role cannot SELECT listing");
  if (row.insert_listing || row.update_listing || row.delete_listing) problems.push("R-6: the app role can write listing");
  if (row.create_schema) problems.push("R-6: the app role can CREATE in public");
  return problems;
}

/** D-1's data checks: our marker, and listing holds exactly the recorded fixture identities. */
export async function predeleteDataProblems(db: Kysely<ListingDatabase>, record: StagingRecord): Promise<readonly string[]> {
  const problems: string[] = [];
  if ((await storedMarker(db)) !== record.run.marker) problems.push("D-1: the marker does not match the record");
  const { rows } = await sql<{ id: string }>`select id::text as id from listing order by id`.execute(db);
  const stored = rows.map((row) => row.id).sort();
  const f = record.run.fixtures;
  const expected = [f.pending, f.rejected, f.unpublished, f.publiclyAvailable].sort();
  if (JSON.stringify(stored) !== JSON.stringify(expected)) problems.push(`D-1: listing holds ${stored.length} identities that are not exactly the recorded fixtures`);
  return problems;
}

/* ------------------------------------------------------------------------------------------- */
/* Reports                                                                                         */
/* ------------------------------------------------------------------------------------------- */

export function writeReport(out: string, name: string, report: unknown, redact: (text: string) => string): void {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(redactDeep(report, redact), null, 2)}\n`);
}

/** The redactor for every secret this tool may hold. */
export function stagingRedactor(values: { readonly key?: string; readonly doadminPassword?: string; readonly appPassword?: string; readonly token?: string }): (text: string) => string {
  return createRedactor([values.key, values.doadminPassword, values.appPassword, values.token]);
}

/** A key-shaped placeholder never sent as a real key: used for the wrong-key probes. */
export function wrongKey(): string {
  let candidate = randomBytes(32).toString("base64url");
  while (candidate.length !== 43) candidate = randomBytes(32).toString("base64url");
  return candidate;
}

/** Headers for a probe's key mode. The real key is attached only for `valid`. */
export function keyHeaders(mode: KeyMode, key: string, wrong: string): Readonly<Record<string, string>> {
  if (mode === "valid") return { [STAGING_KEY_HEADER]: key };
  if (mode === "wrong") return { [STAGING_KEY_HEADER]: wrong };
  return {};
}

/** The key file's content is the key and a newline; its digest must equal the record's. */
export function keyFileProblems(key: string, record: StagingRecord): readonly string[] {
  return stagingKeyDigestHex(key) === record.run.keyDigestHex ? [] : ["the key does not hash to the recorded digest"];
}

/** Read a UTF-8 file with CRLF normalized. */
export function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

export { PLACEHOLDER };

/* =========================================================================================== */
/* Subcommands                                                                                    */
/* =========================================================================================== */

/** Each subcommand's flags; every listed flag is required (the CLI's strict parser). */
export const STAGING_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "staging-record": ["--inputs", "--ca", "--out"],
  "staging-verify": ["--record", "--record-sha256", "--ca", "--operator-rule"],
  "staging-setup": ["--record", "--record-sha256", "--ca", "--operator-rule", "--out"],
  "staging-marker": ["--record", "--record-sha256", "--ca", "--operator-rule", "--set"],
  "staging-readiness": ["--record", "--record-sha256", "--out"],
  "staging-status": ["--record", "--record-sha256", "--previous", "--expected-reads", "--expect", "--out"],
  "staging-identity": ["--record", "--record-sha256"],
  "staging-project": ["--record", "--record-sha256", "--render-accrued-usd", "--do-accrued-usd", "--do-hourly-accrual"],
  "staging-predelete": ["--record", "--record-sha256", "--ca", "--operator-rule"],
  "staging-confirm-deleted": ["--record", "--record-sha256"],
  "staging-regress-capture": ["--mode", "--side", "--url", "--worktree", "--commit", "--environment", "--out"],
  "staging-regress-compare": ["--mode", "--out"],
  "staging-regress-teardown": ["--out"],
  "staging-build-scan": ["--worktree", "--commit", "--out"],
  "staging-local-check": ["--base-url", "--identity", "--out"],
};

export const STAGING_USAGE = `
OP-2 private staging (OP-2 staging Scope Gate revision 2). Each live use needs its own authorization.
Secrets come only from the environment: ${DO_TOKEN_VARIABLE} (read-only), ${DOADMIN_PASSWORD_VARIABLE}, ${KEY_VARIABLE}.
This tool provisions nothing and deletes no provider resource.

  staging-record   --inputs <json> --ca <pem> --out <abs dir>
  staging-verify   --record <file> --record-sha256 <hex> --ca <pem> --operator-rule <ipv4/cidr|none>
  staging-setup    --record <file> --record-sha256 <hex> --ca <pem> --operator-rule <ipv4/cidr> --out <abs dir>
  staging-marker   --record <file> --record-sha256 <hex> --ca <pem> --operator-rule <ipv4/cidr> --set wrong|recorded
  staging-readiness --record <file> --record-sha256 <hex> --out <abs dir>
  staging-status   --record <file> --record-sha256 <hex> --previous <status json|none> --expected-reads <n|none> --expect verified|refused --out <abs dir>
  staging-identity --record <file> --record-sha256 <hex>
  staging-project  --record <file> --record-sha256 <hex> --render-accrued-usd <n> --do-accrued-usd <n> --do-hourly-accrual yes|no
  staging-predelete --record <file> --record-sha256 <hex> --ca <pem> --operator-rule <ipv4/cidr>
  staging-confirm-deleted --record <file> --record-sha256 <hex>
  staging-regress-capture --mode PB-1..PB-5 --side baseline|candidate --url <http://127.0.0.1:port> --worktree <abs dir> --commit <sha> --environment <json> --out <run dir>
  staging-regress-compare --mode PB-1..PB-5 --out <run dir>
  staging-regress-teardown --out <run dir>
  staging-build-scan --worktree <abs dir> --commit <sha> --out <abs dir>
  staging-local-check --base-url <http://127.0.0.1:port> --identity <uuid> --out <abs dir>

--operator-rule none on staging-verify is R-8: the rules must equal the recorded Render ranges and
an operator connection must be refused at the network. The regression procedure is operator-managed
(README): the operator creates the worktrees, builds and starts and stops the servers; capture proves
the commit, environment, server identity, mode and build before capturing, compare evaluates, and
teardown proves the processes, ports and worktrees are gone.`;

export interface StagingSeams {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly api: (token: string) => DoApi;
  readonly operatorSql: OperatorSql;
  readonly resolveIpv4: ResolveIpv4;
  readonly migrate: (db: Kysely<unknown>) => Promise<void>;
  readonly transport: Transport;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => string;
  readonly outputProblems: (out: string) => readonly string[];
  readonly say: (line: string) => void;
  /** Git in a given directory (argument array, no shell). */
  readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
  readonly processes: Pick<ProcessOps, "inspect" | "listener">;
  readonly listeners: (port: number) => Promise<readonly ListeningEntry[]>;
  readonly repositoryRoot: string;
}

function secret(seams: StagingSeams, name: string): string {
  const value = seams.environment[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set in the environment`);
  return value;
}

function loadRecord(flags: Readonly<Record<string, string>>): StagingRecord {
  const { record, problems } = readRecord(readFileSync(flags["--record"] as string), flags["--record-sha256"] as string);
  if (record === undefined) throw new Error(problems.join("; "));
  return record;
}

function operatorRuleOf(text: string): TrustedSource | undefined {
  if (text === "none") return undefined;
  if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(text)) throw new Error("--operator-rule must be an IPv4 address or CIDR, or none");
  return { type: "ip_addr", value: text };
}

function requireOut(seams: StagingSeams, out: string): void {
  const problems = seams.outputProblems(out);
  if (problems.length > 0) throw new Error(`refused: ${problems.join("; ")}`);
}

/**
 * The common gate in front of every SQL-sending command: the API preflight (no SQL), then the V-4
 * TLS controls (identity reads only). Only when both are clean may the command open an operator
 * connection, and `withOperator` makes its first statement the V-5 identity read.
 */
async function gateBeforeSql(record: StagingRecord, caPem: string, seams: StagingSeams, operatorRule: TrustedSource, phase: PreflightPhase): Promise<{ readonly problems: readonly string[]; readonly databases: readonly string[] }> {
  const checked = await preflight(record, caPem, seams.api(secret(seams, DO_TOKEN_VARIABLE)), operatorRule, phase);
  if (checked.problems.length > 0) return checked;
  return { problems: await runTlsControls(record, caPem, secret(seams, DOADMIN_PASSWORD_VARIABLE), seams.operatorSql, seams.resolveIpv4), databases: checked.databases };
}

async function withOperator<T>(record: StagingRecord, caPem: string, seams: StagingSeams, database: string, work: (db: Kysely<ListingDatabase>) => Promise<T>): Promise<T> {
  const connection = seams.operatorSql.connect(doadminUrl(record, secret(seams, DOADMIN_PASSWORD_VARIABLE), database), caPem, "bi4_staging_operator");
  try {
    const identity = await identityProblems(connection.db, database);
    if (identity.length > 0) throw new Error(identity.join("; "));
    return await work(connection.db);
  } finally {
    await connection.shutdown();
  }
}

async function keyedExchange(record: StagingRecord, seams: StagingSeams, budget: Budget, label: string, request: ExchangeRequest, key: KeyMode, keys: { readonly key: string; readonly wrong: string }): Promise<Exchange> {
  budget.take(label);
  return seams.transport(record.render.url, { ...request, headers: { ...request.headers, ...keyHeaders(key, keys.key, keys.wrong) } });
}

async function readStatus(record: StagingRecord, seams: StagingSeams, budget: Budget, keys: { readonly key: string; readonly wrong: string }, label: string): Promise<StagingStatusPayload> {
  const exchange = await keyedExchange(record, seams, budget, label, { method: "GET", path: STAGING_STATUS_PATH }, "valid", keys);
  if (exchange.status !== 200) throw new Error(`${label}: the status route returned ${exchange.status}`);
  return JSON.parse(exchange.body.toString("utf8")) as StagingStatusPayload;
}

/** Run one subcommand. Returns the exit code: 0 only when every check passed. */
export async function runStagingCommand(command: string, flags: Readonly<Record<string, string>>, seams: StagingSeams): Promise<number> {
  const say = seams.say;

  if (command === "staging-record") {
    const out = flags["--out"] as string;
    requireOut(seams, out);
    const inputs = JSON.parse(readText(flags["--inputs"] as string)) as {
      digitalOcean: { clusterId: string; projectName: string; trustedSources: TrustedSource[] };
      render: StagingRecord["render"];
      run: { authorizedCommit: string; window: WindowOption["id"]; calibrationIdentities: number; p0Report: string; p0ReportSha256: string };
    };
    const caPem = readText(flags["--ca"] as string);
    const option = WINDOW_OPTIONS[inputs.run.window];
    if (option === undefined) throw new Error("run.window must be 7-day or 14-day");
    // P-0 first: no provider is contacted and no record is written without a passed live e3-check
    // on exactly the authorized candidate.
    const p0 = p0Problems(readFileSync(inputs.run.p0Report), inputs.run.p0ReportSha256, inputs.run.authorizedCommit);
    if (p0.length > 0) throw new Error(`the record was not written: ${p0.join("; ")}`);
    const result = await seams.api(secret(seams, DO_TOKEN_VARIABLE)).cluster(inputs.digitalOcean.clusterId);
    if (!("cluster" in result)) throw new Error(`the DigitalOcean cluster request returned ${result.status}`);
    const cluster = result.cluster;
    const values = newRunValues(inputs.run.calibrationIdentities);
    const deletionDeadline = deletionDeadlineOf(cluster.created_at, option);
    const record: StagingRecord = {
      schema: RECORD_SCHEMA,
      writtenAt: seams.now(),
      digitalOcean: {
        clusterId: cluster.id,
        name: cluster.name,
        projectId: cluster.project_id ?? "",
        projectName: inputs.digitalOcean.projectName,
        region: cluster.region,
        engine: cluster.engine,
        version: cluster.version,
        size: cluster.size,
        host: cluster.connection.host,
        port: cluster.connection.port,
        createdAt: cluster.created_at,
        caSha256: sha256Hex(caPem),
        trustedSources: inputs.digitalOcean.trustedSources.map(({ type, value }) => ({ type, value })),
      },
      render: inputs.render,
      run: {
        nonce: values.nonce,
        marker: values.marker,
        keyDigestHex: stagingKeyDigestHex(values.key),
        authorizedCommit: inputs.run.authorizedCommit,
        fixtures: values.fixtures,
        calibrationIdentities: values.calibrationIdentities,
        window: option.id,
        deletionDeadline,
        tokenExpiryAtLeast: tokenExpiryOf(deletionDeadline),
        ceilingUsd: option.ceilingUsd,
        stopUsd: option.stopUsd,
        p0: { reportSha256: inputs.run.p0ReportSha256, commit: inputs.run.authorizedCommit },
      },
    };
    // The cluster must be named for this run's nonce; the operator renames nothing, so the name
    // check is against the nonce the operator chose when creating it.
    const named = { ...record, run: { ...record.run, nonce: cluster.name.replace(/^bi4-staging-/, "") } };
    const problems = recordProblems(named);
    if (problems.length > 0) throw new Error(`the record was not written: ${problems.join("; ")}`);
    const bytes = recordBytes(named);
    writeFileSync(join(out, RECORD_FILE), bytes);
    writeFileSync(join(out, KEY_FILE), `${values.key}\n`);
    say(`record written: ${join(out, RECORD_FILE)}`);
    say(`record SHA-256: ${sha256Hex(bytes)}`);
    say(`deletion deadline: ${named.run.deletionDeadline}; token must stay valid until at least ${named.run.tokenExpiryAtLeast}`);
    say(`the access key is in ${join(out, KEY_FILE)}; it is not printed`);
    return 0;
  }

  const record = loadRecord(flags);

  if (command === "staging-verify" || command === "staging-predelete") {
    const caPem = readText(flags["--ca"] as string);
    const operatorRule = operatorRuleOf(flags["--operator-rule"] as string);
    const problems: string[] = [];
    if (operatorRule === undefined) {
      if (command === "staging-predelete") throw new Error("D-1 needs a temporary operator rule");
      // R-8: the rules equal the recorded Render ranges, and an operator connection is refused at the network.
      const checked = await preflight(record, caPem, seams.api(secret(seams, DO_TOKEN_VARIABLE)), undefined, "any");
      problems.push(...checked.problems);
      if (checked.problems.length === 0) {
        problems.push(...networkFilterProblems(await attemptIdentityRead(seams.operatorSql, doadminUrl(record, secret(seams, DOADMIN_PASSWORD_VARIABLE), "defaultdb"), caPem, "bi4_staging_r8")));
      }
    } else {
      const gate = await gateBeforeSql(record, caPem, seams, operatorRule, command === "staging-predelete" ? "existing" : "any");
      problems.push(...gate.problems);
      if (gate.problems.length === 0) {
        if (command === "staging-verify" && !gate.databases.includes(STAGING_DATABASE)) {
          say(`V-6 and R-6 not applicable yet: ${STAGING_DATABASE} has not been created (run staging-setup); no connection to it was attempted`);
        } else {
          problems.push(...(await withOperator(record, caPem, seams, STAGING_DATABASE, async (db) => [
            ...((await storedMarker(db)) === record.run.marker ? [] : ["V-6: the marker does not match the record"]),
            ...(command === "staging-predelete" ? await predeleteDataProblems(db, record) : await appRolePrivilegeProblems(db)),
          ])));
        }
      }
    }
    for (const problem of problems) say(problem);
    if (command === "staging-predelete" && problems.length === 0) {
      say(`D-1 passed. Match in the DigitalOcean console before deleting: id ${record.digitalOcean.clusterId}, name ${record.digitalOcean.name}, project ${record.digitalOcean.projectId} (${record.digitalOcean.projectName}).`);
    }
    say(problems.length === 0 ? `${command}: passed` : `${command}: FAILED (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "staging-setup") {
    const out = flags["--out"] as string;
    requireOut(seams, out);
    const caPem = readText(flags["--ca"] as string);
    const operatorRule = operatorRuleOf(flags["--operator-rule"] as string);
    if (operatorRule === undefined) throw new Error("setup needs the temporary operator rule");
    const gate = await gateBeforeSql(record, caPem, seams, operatorRule, "bootstrap");
    if (gate.problems.length > 0) throw new Error(`setup refused before any SQL: ${gate.problems.join("; ")}`);
    const result = await runSetup(record, caPem, secret(seams, DOADMIN_PASSWORD_VARIABLE), { operatorSql: seams.operatorSql, migrate: seams.migrate });
    const privileges = await withOperator(record, caPem, seams, STAGING_DATABASE, appRolePrivilegeProblems);
    writeFileSync(join(out, APP_ENV_FILE), `${JSON.stringify(result.appEnvironment, null, 2)}\n`);
    const problems = [...result.storedStateProblems, ...privileges];
    for (const problem of problems) say(problem);
    say(`the Render environment values are in ${join(out, APP_ENV_FILE)}; they are not printed`);
    say(problems.length === 0 ? "staging-setup: passed" : `staging-setup: FAILED (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "staging-marker") {
    const caPem = readText(flags["--ca"] as string);
    const operatorRule = operatorRuleOf(flags["--operator-rule"] as string);
    if (operatorRule === undefined) throw new Error("changing the marker needs the temporary operator rule");
    const set = flags["--set"];
    if (set !== "wrong" && set !== "recorded") throw new Error("--set must be wrong or recorded");
    const gate = await gateBeforeSql(record, caPem, seams, operatorRule, "existing");
    if (gate.problems.length > 0) throw new Error(`refused before any SQL: ${gate.problems.join("; ")}`);
    const marker = set === "recorded" ? record.run.marker : `bi4-staging-synthetic:${randomBytes(16).toString("hex")}`;
    await withOperator(record, caPem, seams, STAGING_DATABASE, async (db) => {
      const current = await storedMarker(db);
      // Only our own database is ever re-marked: the recorded marker before --set wrong, and a
      // staging-shaped marker (the one --set wrong wrote) before --set recorded.
      const allowed = set === "wrong" ? current === record.run.marker : current !== null && STAGING_MARKER_PATTERN.test(current);
      if (!allowed) throw new Error(`refused: the current marker is not ${set === "wrong" ? "the recorded marker" : "a staging marker"}; nothing was changed`);
      await sql.raw(`comment on database "${STAGING_DATABASE}" is '${marker}'`).execute(db);
    });
    say(`marker set to ${set === "recorded" ? "the recorded value" : "a non-matching value"}; restart the Render service, then run staging-status --expect ${set === "recorded" ? "verified" : "refused"}`);
    return 0;
  }

  // The key is needed only where it is sent: status and readiness. Identity, projection and the
  // deletion confirmation must still work after the key file has been deleted at teardown.
  const keyed = command === "staging-status" || command === "staging-readiness";
  const key = keyed ? secret(seams, KEY_VARIABLE) : "";
  if (keyed) {
    const keyProblems = keyFileProblems(key, record);
    if (keyProblems.length > 0) throw new Error(keyProblems.join("; "));
  }
  const keys = { key, wrong: wrongKey() };
  const redact = stagingRedactor({ key: keyed ? key : undefined, token: seams.environment[DO_TOKEN_VARIABLE], doadminPassword: seams.environment[DOADMIN_PASSWORD_VARIABLE] });

  if (command === "staging-status") {
    const out = flags["--out"] as string;
    requireOut(seams, out);
    const budget = createBudget(2);
    const current = await readStatus(record, seams, budget, keys, "status");
    const previousFlag = flags["--previous"] as string;
    const previous = previousFlag === "none" ? undefined : (JSON.parse(readText(previousFlag)) as StagingStatusPayload);
    const expectedFlag = flags["--expected-reads"] as string;
    const expectedReads = expectedFlag === "none" ? undefined : Number(expectedFlag);
    const expect = flags["--expect"];
    let problems = [...statusProblems(record, current, previous, expectedReads)];
    if (expect === "refused") {
      problems = problems.filter((problem) => !problem.includes("state is") && !problem.includes("refusals is") && !problem.includes("bootNonce changed") && !problem.includes("RENDER_INSTANCE_ID changed"));
      if (current.state !== "refused") problems.push(`R-7: state is ${current.state}, expected refused (fresh-process refusal)`);
    } else if (expect !== "verified") {
      throw new Error("--expect must be verified or refused");
    }
    writeReport(out, "status", { current, problems }, redact);
    for (const problem of problems) say(problem);
    say(problems.length === 0 ? "staging-status: passed" : `staging-status: FAILED (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "staging-identity") {
    for (const line of identityFallbackChecklist(record)) say(line);
    const exchange = await seams.transport(record.render.url, { method: "GET", path: "/" });
    const f4 = [...gateProblems(exchange, "F-4", "GET"), ...(headerValuesOf(exchange, "rndr-id").length === 1 ? [] : ["F-4: no single Rndr-Id header"])];
    for (const problem of f4) say(problem);
    say(f4.length === 0 ? "F-4 passed (corroboration only); F-1 to F-3 are confirmed by the operator in the console" : "F-4 FAILED");
    return f4.length === 0 ? 0 : 1;
  }

  if (command === "staging-project") {
    const renderUsd = Number(flags["--render-accrued-usd"]);
    const doUsd = Number(flags["--do-accrued-usd"]);
    if (!Number.isFinite(renderUsd) || renderUsd < 0 || !Number.isFinite(doUsd) || doUsd < 0) throw new Error("accrued amounts must be non-negative numbers");
    const hourly = flags["--do-hourly-accrual"];
    if (hourly !== "yes" && hourly !== "no") throw new Error("--do-hourly-accrual must be yes or no");
    const projection = projectSpend(record, seams.now(), { renderUsd, doUsd }, hourly === "yes");
    say(JSON.stringify(projection, null, 2));
    if (projection.deadlinePassed) say("the deletion deadline has passed: teardown now");
    say(projection.stop ? `STOP: the projected $${projection.projectedUsd} reaches the $${projection.stopUsd} stop; stop measurement and begin teardown` : `under the $${projection.stopUsd} stop`);
    return projection.stop || projection.deadlinePassed ? 1 : 0;
  }

  if (command === "staging-confirm-deleted") {
    const confirmation = deletionConfirmation(await seams.api(secret(seams, DO_TOKEN_VARIABLE)).cluster(record.digitalOcean.clusterId));
    say(confirmation.note);
    if (confirmation.confirmed) say("revoke the DigitalOcean token now (T-6), and record the time");
    return confirmation.confirmed ? 0 : 1;
  }

  if (command === "staging-readiness") {
    const out = flags["--out"] as string;
    requireOut(seams, out);
    const budget = createBudget(READINESS_CAP);
    const fixtures = record.run.fixtures;
    const problems: string[] = [];
    const scanned: ScannedItem[] = [];
    const log: { label: string; status: number; headers: readonly string[]; bytes: number }[] = [];
    const send = async (label: string, request: ExchangeRequest, mode: KeyMode): Promise<Exchange> => {
      const exchange = await keyedExchange(record, seams, budget, label, request, mode, keys);
      scanned.push(exchangeScanItem(label, exchange));
      log.push({ label, status: exchange.status, headers: exchange.rawHeaders, bytes: exchange.body.length });
      return exchange;
    };

    const first = await readStatus(record, seams, budget, keys, "status (start)");
    problems.push(...statusProblems(record, first, undefined, undefined));

    // R-3 and R-4.
    const gateResults: { label: string; method: string; exchange: Exchange }[] = [];
    for (const probe of gateProbes(fixtures, "/_next/static/chunks/main.js")) {
      const request = { method: probe.method, path: probe.path.replace("=KEY", `=${keys.key}`), ...(probe.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(probe.headers).map(([name, value]) => [name, value.replace("=KEY", `=${keys.key}`)])) }) };
      const exchange = await send(probe.label, request, probe.key);
      problems.push(...probeProblems(probe, exchange));
      gateResults.push({ label: probe.label, method: probe.method, exchange });
    }
    problems.push(...gateUniformityProblems(gateResults));

    // R-2b: K-1 to K-5, through Render.
    for (const url of [`/directory/${fixtures.publiclyAvailable}`, `/directory/${fixtures.neverExisted[0]}`, STAGING_STATUS_PATH]) {
      const run = await runKChecks(url, (request, mode) => send(`K ${request.method} ${url} (${mode})`, request, mode), seams.wait);
      for (const result of run.results) problems.push(...result.problems);
      const keyed = run.results.find((result) => result.id === "K-5");
      if (keyed !== undefined) say(`R-2b: Cache-Control through Render for ${url}: ${JSON.stringify(headerValuesOf(keyed.exchange, "cache-control"))}`);
    }

    // R-9: the read counter grows by exactly the keyed S2 requests sent.
    const beforeCount = await readStatus(record, seams, budget, keys, "status (R-9 before)");
    for (let i = 0; i < 3; i += 1) await send(`R-9 keyed S2 ${i + 1}`, { method: "GET", path: `/directory/${fixtures.publiclyAvailable}` }, "valid");
    const afterCount = await readStatus(record, seams, budget, keys, "status (R-9 after)");
    problems.push(...statusProblems(record, afterCount, beforeCount, 3));

    // R-10: remote equivalence, public controls first and last.
    const s2 = (identity: string) => ({ method: "GET", path: `/directory/${identity}` });
    const before10 = await readStatus(record, seams, budget, keys, "status (R-10 before)");
    const firstControl = await send("R-10 public control (first)", s2(fixtures.publiclyAvailable), "valid");
    const members: EquivalenceMember[] = [];
    for (const [label, identity, state] of [
      ["never-existed 1", fixtures.neverExisted[0], "NE"],
      ["never-existed 2", fixtures.neverExisted[1], "NE"],
      ["pending", fixtures.pending, "PE"],
      ["rejected", fixtures.rejected, "RJ"],
      ["unpublished", fixtures.unpublished, "UP"],
    ] as const) {
      members.push({ label: `R-10 ${label}`, identity, state, exchange: await send(`R-10 ${label}`, s2(identity), "valid") });
    }
    const malformed = await send("R-10 malformed", s2(fixtures.malformed), "valid");
    if (malformed.status !== 200 || !malformed.body.toString("utf8").includes("<h1>Not available</h1>")) problems.push("R-10: the malformed control did not render the not-available content");
    const lastControl = await send("R-10 public control (last)", s2(fixtures.publiclyAvailable), "valid");
    problems.push(
      ...remoteEquivalenceProblems(members, [
        { label: "R-10 public control (first)", identity: fixtures.publiclyAvailable, exchange: firstControl, publicName: fixtures.publicName },
        { label: "R-10 public control (last)", identity: fixtures.publiclyAvailable, exchange: lastControl, publicName: fixtures.publicName },
      ]),
    );
    const after10 = await readStatus(record, seams, budget, keys, "status (R-10 after)");
    problems.push(...statusProblems(record, after10, before10, 8));

    // R-12: leak scan of every response.
    problems.push(...stagingLeakProblems(scanned, { key: keys.key, digest: record.run.keyDigestHex, marker: record.run.marker }));

    const largestS2 = Math.max(0, ...log.filter((entry) => entry.status === 200).map((entry) => entry.bytes));
    writeReport(out, "readiness", { attempts: budget.used(), cap: budget.limit, problems, largestKeyedResponseBytes: largestS2, coverage: READINESS_COVERAGE, exchanges: log, statusStart: first, statusEnd: after10 }, redact);
    for (const problem of problems) say(problem);
    say(`attempts: ${budget.used()} of ${budget.limit}; largest keyed response ${largestS2} bytes (R-2 egress estimate)`);
    say(problems.length === 0 ? "staging-readiness: passed for R-2b, R-3, R-4, R-9, R-10 and R-12 (responses)." : `staging-readiness: FAILED (${problems.length})`);
    say("Readiness is not complete on this command alone. Still owed, by coverage table:");
    for (const entry of READINESS_COVERAGE.filter((item) => item.kind !== "automated" || item.outstanding !== "none")) say(`  ${entry.id} [${entry.kind}] ${entry.coveredBy}: ${entry.outstanding}`);
    return problems.length === 0 ? 0 : 1;
  }

  throw new Error(`unknown staging subcommand ${command}`);
}

/** Per-capture attempt cap: two captures make one regression run, within the 500 cap (D-G8). */
export const CAPTURE_CAP = REGRESS_CAP / 2;

/**
 * A regression run directory may already hold this run's own files (one capture per side), so it
 * is not required to be empty; everything else `outputDirectoryProblems` checks still applies.
 */
function requireRunDirectory(seams: StagingSeams, out: string): void {
  const problems = seams.outputProblems(out).filter((problem) => problem !== "the output directory must be empty");
  if (problems.length > 0) throw new Error(`refused: ${problems.join("; ")}`);
}

function readCapture(out: string, mode: RegressionMode, side: RegressionSide): { readonly capture?: RegressionCapture; readonly sha256?: string } {
  const path = join(out, captureFileName(mode, side));
  if (!existsSync(path)) return {};
  const bytes = readFileSync(path);
  return { capture: JSON.parse(bytes.toString("utf8")) as RegressionCapture, sha256: sha256Hex(bytes) };
}

/* ------------------------------------------------------------------------------------------- */
/* Coverage: exactly what this tool establishes, and what remains operator evidence                */
/* ------------------------------------------------------------------------------------------- */

export interface CoverageEntry {
  readonly id: string;
  readonly coveredBy: string;
  readonly kind: "automated" | "automated + operator action" | "operator evidence" | "not implemented";
  readonly outstanding: string;
}

/** Gate §5.3 and §8: every check, the subcommand that covers it, and the evidence still owed. */
export const READINESS_COVERAGE: readonly CoverageEntry[] = [
  { id: "P-0", coveredBy: "staging-record (p0Problems)", kind: "automated + operator action", outstanding: "the separately authorized live e3-check on the committed candidate; its e3-check.json and SHA-256" },
  { id: "R-0", coveredBy: "staging-regress-capture / -compare / -teardown (PB-1 to PB-5)", kind: "automated + operator action", outstanding: "the operator creates the worktrees, builds, starts and stops the servers, and provides each launch-environment operator attestation; PB-3 versus PB-4 rests on that attestation alone" },
  { id: "R-1", coveredBy: "staging-build-scan", kind: "automated", outstanding: "none beyond the build itself" },
  { id: "R-2", coveredBy: "staging-record (recordProblems) and staging-status (service ID, hostname, commit)", kind: "automated + operator action", outstanding: "the Render settings transcribed from the dashboard (plan, region, instances, health path, auto-deploy, previews, edge cache, variable names); the response size is in the readiness log" },
  { id: "R-2b", coveredBy: "staging-readiness (K-1 to K-5 through Render)", kind: "automated", outstanding: "none" },
  { id: "R-3", coveredBy: "staging-readiness", kind: "automated", outstanding: "none" },
  { id: "R-4", coveredBy: "staging-readiness (GET on every path, plus the disallowed methods on S2 and status)", kind: "automated", outstanding: "none" },
  { id: "R-5", coveredBy: "staging-verify (V-4: positive, wrong-CA and IP-literal controls) and staging-status (verified)", kind: "automated", outstanding: "none" },
  { id: "R-6", coveredBy: "staging-setup and staging-verify (role attributes and listing privileges)", kind: "automated", outstanding: "none" },
  { id: "R-7", coveredBy: "staging-marker, then staging-status --expect refused / verified", kind: "automated + operator action", outstanding: "the two Render service restarts, with their times" },
  { id: "R-8", coveredBy: "staging-verify --operator-rule none (network refusal required)", kind: "automated + operator action", outstanding: "removing the operator's trusted-source rule in the console" },
  { id: "R-9", coveredBy: "staging-readiness", kind: "automated", outstanding: "none" },
  { id: "R-10", coveredBy: "staging-readiness (Date and Rndr-Id removed, own UUID masked)", kind: "automated", outstanding: "none" },
  { id: "R-11", coveredBy: "none", kind: "not implemented", outstanding: "the calibration pilot belongs to the later measurement slice" },
  { id: "R-12", coveredBy: "staging-readiness (every response)", kind: "automated + operator action", outstanding: "an export of the Render application logs for the scan" },
  { id: "M-1", coveredBy: "staging-status --previous", kind: "automated", outstanding: "none" },
  { id: "M-2", coveredBy: "none", kind: "operator evidence", outstanding: "the Render event list for each window (no deploy, restart, instance, edge-cache, plan or suspension event)" },
  { id: "M-3, M-4, M-5, M-8", coveredBy: "none", kind: "not implemented", outstanding: "the remote measurement harness (later slice)" },
  { id: "M-6", coveredBy: "staging-project", kind: "automated + operator action", outstanding: "the accrued amounts read from both billing pages at each phase boundary" },
  { id: "M-7", coveredBy: "staging-verify --operator-rule none", kind: "automated + operator action", outstanding: "no operator rule during the run" },
  { id: "T-1, T-3, T-4 (D-2)", coveredBy: "staging-status or staging-identity; staging-predelete; staging-confirm-deleted", kind: "automated + operator action", outstanding: "the console deletions themselves" },
  { id: "T-2", coveredBy: "staging-readiness (responses)", kind: "operator evidence", outstanding: "the final Render log export and the run's console output for the leak scan" },
  { id: "T-5, T-6", coveredBy: "staging-identity (F-1 to F-4 checklist, F-4 automated)", kind: "operator evidence", outstanding: "the Render service and project deletions, the token revocation time, and the deletion of the local key, CA and password files" },
];

/** The loopback subcommands: no record, no provider. */
export async function runLoopbackCommand(command: string, flags: Readonly<Record<string, string>>, seams: StagingSeams): Promise<number> {
  const say = seams.say;
  const out = flags["--out"] as string;

  if (command === "staging-regress-capture") {
    requireRunDirectory(seams, out);
    const mode = flags["--mode"] as RegressionMode;
    const side = flags["--side"] as RegressionSide;
    if (!REGRESSION_MODES.includes(mode)) throw new Error("--mode must be PB-1 to PB-5");
    if (!sidesFor(mode).includes(side)) throw new Error(`${mode} takes --side ${sidesFor(mode).join(" or ")}`);
    const origin = flags["--url"] as string;
    const originProblems = loopbackOriginProblems(origin);
    if (originProblems.length > 0) throw new Error(originProblems.join("; "));
    if (mode === "PB-5" && origin !== `${DEMO_ORIGIN}/` && origin !== DEMO_ORIGIN) throw new Error(`PB-5 captures the local demo at ${DEMO_ORIGIN}`);
    if (existsSync(join(out, captureFileName(mode, side)))) throw new Error(`${captureFileName(mode, side)} already exists in this run directory; captures are never overwritten`);
    const worktree = resolve(flags["--worktree"] as string);
    const commit = flags["--commit"] as string;
    const environmentBytes = readFileSync(flags["--environment"] as string);
    const variables = (JSON.parse(environmentBytes.toString("utf8")) as { variables: Record<string, string> }).variables;
    const budget = createBudget(CAPTURE_CAP);
    const send = async (request: ExchangeRequest): Promise<Exchange> => {
      budget.take(`${request.method} ${request.path}`);
      return seams.transport(origin, request);
    };
    const startedAt = seams.now();

    // Stage 1, with no HTTP request: the worktree (commit), the declared launch environment
    // (operator attestation) and the listener identity. Any finding here stops the run before the
    // first request; a thrown error stops it too, with nothing written.
    const problems: string[] = [...(await worktreeProblems(seams, worktree, commit, side)), ...modeEnvironmentProblems(mode, variables)];
    const server = await serverIdentityProblems(seams, origin, worktree);
    problems.push(...server.problems);
    const preHttpFindings = problems.length;

    // Stage 2, only after stage 1 is clean: the mode-signature and build probes.
    let asset: string | undefined;
    let probeFindings = 0;
    if (preHttpFindings === 0) {
      const home = await send({ method: "GET", path: "/" });
      const directory = await send({ method: "GET", path: "/directory" });
      const before = problems.length;
      problems.push(...modeSignatureProblems(mode, { home, directory }));
      if (mode === "PB-1" || mode === "PB-2") {
        asset = staticAssetOf(home.body.toString("utf8"));
        const served = asset === undefined ? undefined : await send({ method: "GET", path: asset });
        problems.push(...assetProofProblems(worktree, asset, served));
      }
      probeFindings = problems.length - before;
    }
    const buildId = existsSync(join(worktree, ".next", "BUILD_ID")) ? readText(join(worktree, ".next", "BUILD_ID")).trim() : null;

    // Stage 3, the regression matrix: only when both earlier stages are clean.
    const requests = problems.length > 0 ? [] : mode === "PB-5" ? demoRequests() : regressionProbes(REGRESSION_FIXTURES, asset ?? "/_next/static/chunks/main.js", REGRESSION_RANDOM_SUFFIX);
    const stoppedAt = preHttpFindings > 0 ? "before any HTTP request (worktree, launch-environment attestation or listener identity)" : probeFindings > 0 ? "after the mode-signature and build probes; the regression matrix was skipped" : null;
    const exchanges: CapturedExchange[] = [];
    for (const request of requests) {
      const exchange = await send(request);
      exchanges.push({ method: request.method, path: request.path, status: exchange.status, rawHeaders: exchange.rawHeaders, bodyBase64: exchange.body.toString("base64") });
    }

    const capture: RegressionCapture = {
      schema: "bi4-staging-regress-capture/1",
      mode,
      side,
      origin,
      commit,
      worktree,
      launchEnvironment: {
        kind: "operator attestation",
        sha256: sha256Hex(environmentBytes),
        variables,
        corroboration: ATTESTATION_CORROBORATION[mode],
      },
      server: { port: server.port, identity: server.identity ?? null },
      buildId,
      startedAt,
      endedAt: seams.now(),
      attempts: budget.used(),
      stoppedAt,
      problems,
      exchanges,
    };
    const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, "utf8");
    writeFileSync(join(out, captureFileName(mode, side)), bytes);
    for (const problem of problems) say(problem);
    say(`capture written: ${captureFileName(mode, side)}, SHA-256 ${sha256Hex(bytes)}; ${exchanges.length} exchanges; attempts ${budget.used()} of ${budget.limit}`);
    if (server.identity !== undefined) say(`server identity recorded: pid ${server.identity.pid}, created ${server.identity.creationTime}, port ${server.port}`);
    say(`launch environment: operator attestation (SHA-256 ${sha256Hex(environmentBytes)}); corroborated only by: ${ATTESTATION_CORROBORATION[mode]}`);
    say(problems.length === 0 ? `staging-regress-capture ${mode} ${side}: passed` : `staging-regress-capture ${mode} ${side}: FAILED (${problems.length}); stopped ${stoppedAt}`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "staging-regress-compare") {
    requireRunDirectory(seams, out);
    const mode = flags["--mode"] as RegressionMode;
    if (!REGRESSION_MODES.includes(mode)) throw new Error("--mode must be PB-1 to PB-5");
    const baseline = readCapture(out, mode, "baseline");
    const candidate = readCapture(out, mode, "candidate");
    if (candidate.capture === undefined) throw new Error(`${captureFileName(mode, "candidate")} is missing`);
    const problems = compareCaptures(mode, baseline.capture, candidate.capture);
    writeReport(out, `compare-${mode}`, { mode, captures: { baseline: baseline.sha256 ?? null, candidate: candidate.sha256 }, problems }, (text) => text);
    say(`captures: baseline ${baseline.sha256 ?? "(none: candidate-only mode)"}, candidate ${candidate.sha256}`);
    for (const problem of problems) say(problem);
    say(problems.length === 0 ? `staging-regress-compare ${mode}: passed` : `staging-regress-compare ${mode}: FAILED (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "staging-regress-teardown") {
    requireRunDirectory(seams, out);
    const captures = readdirSync(out)
      .filter((name) => name.endsWith(".capture.json"))
      .map((name) => JSON.parse(readFileSync(join(out, name), "utf8")) as RegressionCapture);
    if (captures.length === 0) throw new Error("no captures in this run directory");
    const problems = await regressionTeardownProblems(seams, captures);
    writeReport(out, "teardown", { captures: captures.map((capture) => `${capture.mode} ${capture.side}`), problems }, (text) => text);
    for (const problem of problems) say(problem);
    say(problems.length === 0 ? `staging-regress-teardown: zero residue for ${captures.length} capture(s)` : `staging-regress-teardown: RESIDUE (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "staging-build-scan") {
    requireOut(seams, out);
    const worktree = resolve(flags["--worktree"] as string);
    const problems = [...(await worktreeProblems(seams, worktree, flags["--commit"] as string, "candidate")), ...buildScanProblems(worktree)];
    writeReport(out, "build-scan", { worktree, commit: flags["--commit"], problems }, (text) => text);
    for (const problem of problems) say(problem);
    say(problems.length === 0 ? "staging-build-scan (R-1): passed" : `staging-build-scan (R-1): FAILED (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  requireOut(seams, out);

  if (command === "staging-local-check") {
    const origin = flags["--base-url"] as string;
    const originProblems = loopbackOriginProblems(origin);
    if (originProblems.length > 0) throw new Error(originProblems.join("; "));
    const identity = flags["--identity"] as string;
    if (!UUID.test(identity)) throw new Error("--identity must be a lower-case UUID");
    const key = secret(seams, KEY_VARIABLE);
    const send = (request: ExchangeRequest, mode: KeyMode) => seams.transport(origin, { ...request, headers: { ...request.headers, ...keyHeaders(mode, key, wrongKey()) } });
    const keyedS2 = await send({ method: "GET", path: `/directory/${identity}` }, "valid");
    const keylessS2 = await send({ method: "GET", path: `/directory/${identity}` }, "none");
    const status = await send({ method: "GET", path: STAGING_STATUS_PATH }, "valid");
    const problems = [
      ...(keyedS2.status === 200 ? [] : [`keyed S2 returned ${keyedS2.status}`]),
      ...cachePolicyProblems(keyedS2, "keyed S2 (local next start)"),
      ...gateProblems(keylessS2, "keyless S2", "GET"),
      ...(status.status === 200 ? [] : [`status returned ${status.status}`]),
      ...cachePolicyProblems(status, "status (local next start)"),
    ];
    const observed = { keyedS2CacheControl: headerValuesOf(keyedS2, "cache-control"), statusCacheControl: headerValuesOf(status, "cache-control") };
    writeReport(out, "local-check", { note: "implementation feedback only (approval ruling 1); R-2b through Render is the readiness gate", observed, problems }, createRedactor([key]));
    say(`keyed S2 Cache-Control under local next start: ${JSON.stringify(observed.keyedS2CacheControl)}`);
    for (const problem of problems) say(problem);
    say(problems.length === 0 ? "staging-local-check: passed (implementation feedback only)" : `staging-local-check: FAILED (${problems.length})`);
    return problems.length === 0 ? 0 : 1;
  }

  throw new Error(`unknown loopback subcommand ${command}`);
}

/** The real seams. */
export function realStagingSeams(outputProblems: (out: string) => readonly string[], repositoryRoot: string): StagingSeams {
  const processes = windowsProcessOps();
  return {
    environment: process.env,
    api: (token) => digitalOceanApi(token),
    operatorSql: realOperatorSql,
    resolveIpv4: realResolveIpv4,
    migrate: migrateToLatest,
    transport: realTransport,
    wait: (ms) => new Promise((resume) => setTimeout(resume, ms)),
    now: () => new Date().toISOString(),
    outputProblems,
    say: (line) => process.stdout.write(`${line}\n`),
    git: async (cwd, args) => {
      const { code, stdout, stderr } = await runFile("git", ["-C", cwd, ...args]);
      if (code !== 0) throw new Error(`git ${args[0]} in ${cwd} exited ${code}: ${stderr.trim()}`);
      return stdout;
    },
    processes: { inspect: (pid) => processes.inspect(pid), listener: (port) => processes.listener(port) },
    listeners: windowsListenerLookup(),
    repositoryRoot,
  };
}

/** The CLI entry for every `staging-*` subcommand. */
export function stagingMain(command: string, flags: Readonly<Record<string, string>>, seams: StagingSeams): Promise<number> {
  return command.startsWith("staging-regress-") || command === "staging-build-scan" || command === "staging-local-check" ? runLoopbackCommand(command, flags, seams) : runStagingCommand(command, flags, seams);
}
