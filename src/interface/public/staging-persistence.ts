/**
 * The OP-2 **private staging** data source for `S2` (issue #246, OP-2 staging Scope Gate revision 2
 * §2–§4 and §7). Production only, default off; configured by `staging-access.ts`.
 *
 * **Identity checks.** DigitalOcean grants no superuser, so `E3-local`'s C-1 (`pg_control_system()`)
 * is replaced by **C-1′: TLS `verify-full`**. The pool connects with `ssl: { ca, rejectUnauthorized:
 * true }`, and Node then verifies the certificate chain against the pinned CA **and** that the
 * certificate names the configured host. C-2 to C-4 run in `pg-pool`'s awaited `onConnect` on every
 * newly opened connection, before it is handed out: the database, the synthetic marker (the database
 * comment) and a non-superuser role.
 *
 * **Refusal is sticky and silent**, with `E3-local`'s post-#284 semantics. A failed check, or any
 * checkout error, refuses the process until restart. The pool is not ended inside `onConnect`. Any
 * connection opened after refusal is rejected before any SQL, so a queued checkout settles.
 *
 * **Calibration (§7) is off by default.** Only when `BI4_STAGING_CALIBRATION` is valid does a read
 * of an approved calibration identity busy-wait, **after** the database read, for its bounded
 * nominal delay. The realized delay is measured around the busy-wait and kept in a bounded ring.
 *
 * **What the counters observe (§7.4, as corrected).** A busy-wait blocks the event loop, and no
 * JavaScript runs meanwhile, so nothing here can see a request arrive. `overlappedReads` counts
 * reads whose `read()` **began** while another `read()` had begun and not finished: concurrency at
 * the moment of dispatch into this module. It sees nothing about arrival, waiting, or any request
 * that never reaches this module. The event-loop delay histogram is **report-only**. It is reported
 * beside the realized calibration delays, never net of them, and stalls are not attributed.
 *
 * **Server-side only.** Nothing here has a `NEXT_PUBLIC_` name, and nothing logs.
 */

import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { Kysely } from "kysely";

import {
  createListingPersistence,
  type ListingPersistence,
  type ListingPersistenceConfiguration,
  type ListingPoolConfiguration,
} from "../../data/connection";
import type { ListingDatabase } from "../../data/listing-table";
import { findPubliclyAvailableListing } from "../../data/public-listing-read";
import { REFUSED, type Refused } from "./e3-local-persistence";
import {
  CALIBRATION_DELAY_CEILING_NS,
  stagingModeOf,
  type CalibrationEntry,
  type StagingConfiguration,
  type StagingExpected,
} from "./staging-access";

/** C-2 to C-4 in one statement: plain reads any role may perform. */
export const STAGING_VERIFICATION_STATEMENT =
  "select current_database() as database, " +
  "(select shobj_description(oid, 'pg_database') from pg_database where datname = current_database()) as marker, " +
  "current_user as role, " +
  "(select rolsuper from pg_roles where rolname = current_user) as superuser";

/** The narrow slice of a `pg` client that verification uses. */
export interface VerifiableClient {
  query(text: string): Promise<{ readonly rows: readonly unknown[] }>;
}

/** Whether one connection is the expected database, marker and non-superuser role. */
export async function stagingConnectionMatches(client: VerifiableClient, expected: StagingExpected): Promise<boolean> {
  const { rows } = await client.query(STAGING_VERIFICATION_STATEMENT);
  if (rows.length !== 1) return false;
  const row = rows[0] as Record<string, unknown>;
  return row.database === expected.database && row.marker === expected.marker && row.role === expected.role && row.superuser === false;
}

/**
 * Node's certificate-verification error codes. A negative TLS control passes only on one of these,
 * so a refusal for any other reason (a closed port, a timeout) cannot pass for a TLS refusal.
 */
export const TLS_VERIFICATION_CODES: readonly string[] = [
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

/** Network-level refusal codes: what a closed port or a trusted-source filter produces. */
export const NETWORK_REFUSAL_CODES: readonly string[] = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"];

function errorChain(error: unknown): readonly Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value === null || typeof value !== "object" || seen.includes(value as Record<string, unknown>)) return;
    const record = value as Record<string, unknown>;
    seen.push(record);
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors)) for (const inner of record.errors) visit(inner, depth + 1);
  };
  visit(error, 0);
  return seen;
}

/** Whether an error is a TLS certificate-verification failure (chain or hostname). */
export function isTlsVerificationFailure(error: unknown): boolean {
  return errorChain(error).some((entry) => typeof entry.code === "string" && TLS_VERIFICATION_CODES.includes(entry.code));
}

/** Trust-chain verification failures: the certificate does not chain to the pinned CA. */
export const TRUST_CHAIN_CODES: readonly string[] = [
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
];

/** The hostname check's failure: the certificate does not name the host that was asked for. */
export const HOSTNAME_MISMATCH_CODE = "ERR_TLS_CERT_ALTNAME_INVALID";

/** The first TLS verification code in an error's chain, if any. */
export function tlsFailureCode(error: unknown): string | undefined {
  const entry = errorChain(error).find((item) => typeof item.code === "string" && TLS_VERIFICATION_CODES.includes(item.code));
  return entry?.code as string | undefined;
}

/** A trust-chain failure, and nothing else: an expiry or a hostname mismatch is not one. */
export function isTrustChainFailure(error: unknown): boolean {
  const code = tlsFailureCode(error);
  return code !== undefined && TRUST_CHAIN_CODES.includes(code);
}

/** A hostname mismatch, and nothing else. */
export function isHostnameMismatch(error: unknown): boolean {
  return tlsFailureCode(error) === HOSTNAME_MISMATCH_CODE;
}

/** Whether an error is a network-level refusal or timeout, and not a TLS verification failure. */
export function isNetworkRefusal(error: unknown): boolean {
  if (isTlsVerificationFailure(error)) return false;
  return errorChain(error).some(
    (entry) =>
      (typeof entry.code === "string" && NETWORK_REFUSAL_CODES.includes(entry.code)) ||
      (typeof entry.message === "string" && /timeout expired|Connection terminated due to connection timeout|connect ETIMEDOUT/.test(entry.message)),
  );
}

/** The one generic error a refused checkout carries. It names no check and no value. */
export class StagingRefused extends Error {
  constructor() {
    super("staging refused");
    this.name = "StagingRefused";
  }
}

/** One pool client, never evicted or recycled. Not a production pool policy (`ADR-016`). */
export const STAGING_POOL_MAX = 1;
export const STAGING_IDLE_TIMEOUT_MILLIS = 0;

/** Ring size for realized calibration delays (§7.3). */
export const CALIBRATION_RING_SIZE = 20_000;
/** A realized delay above nominal by more than this is an overrun (§7.3). */
export const CALIBRATION_OVERRUN_NS = 200_000;
/** The event-loop histogram's resolution in milliseconds: the smallest Node allows (§7.4). */
export const EVENT_LOOP_RESOLUTION_MS = 1;

/**
 * The pool configuration (C-1′). TLS with the pinned CA and full verification. The connection string
 * carries no query string (`staging-access.ts`), so nothing in it can override `ssl`.
 */
export function stagingPoolConfiguration(
  configuration: StagingConfiguration,
  onConnect: (client: unknown) => Promise<void>,
): ListingPoolConfiguration {
  return {
    connectionString: configuration.connectionString,
    ssl: { ca: configuration.caPem, rejectUnauthorized: true },
    max: STAGING_POOL_MAX,
    idleTimeoutMillis: STAGING_IDLE_TIMEOUT_MILLIS,
    onConnect,
  };
}

export interface CalibrationRecord {
  readonly sequence: number;
  readonly identityIndex: number;
  readonly nominalNs: number;
  readonly realizedNs: number;
}

export interface CalibrationSummary {
  readonly nominalNs: number;
  readonly count: number;
  readonly minNs: number;
  readonly p50Ns: number;
  readonly p99Ns: number;
  readonly maxNs: number;
  readonly overruns: number;
}

export interface EventLoopSummary {
  readonly resolutionMs: number;
  readonly samples: number;
  readonly minNs: number;
  readonly meanNs: number;
  readonly p50Ns: number;
  readonly p99Ns: number;
  readonly maxNs: number;
}

export type StagingState = "unconnected" | "verified" | "refused";

/** One snapshot for the status route. Holds no connection value, marker, digest or key. */
export interface StagingSnapshot {
  readonly bootNonce: string;
  readonly state: StagingState;
  readonly s2Reads: number;
  readonly refusals: number;
  readonly readsAfterRefusal: number;
  readonly overlappedReads: number;
  readonly calibrationEnabled: boolean;
  /** Since the previous status read; reported beside the event-loop histogram, never net of it. */
  readonly calibrationSinceLastStatus: readonly CalibrationSummary[];
  readonly calibrationTotal: readonly CalibrationSummary[];
  /** Since the previous status read. Report-only. */
  readonly eventLoopSinceLastStatus: EventLoopSummary | null;
}

type ReadResult = Awaited<ReturnType<typeof findPubliclyAvailableListing>>;

/** The staging handle the routes use. */
export interface StagingHandle {
  isRefused(): boolean;
  /** The layout's pre-check: as `E3-local`'s. */
  precheck(): Promise<"ok" | "refused">;
  /** The page's guarded read: as `E3-local`'s, plus counters and calibration. */
  read(identity: unknown): Promise<ReadResult | Refused>;
  /** A status snapshot. Resets the "since last status" windows. */
  status(): StagingSnapshot;
  shutdown(): Promise<void>;
}

export interface BusyWait {
  /** Spin for `ns` nanoseconds and return the realized nanoseconds. */
  (ns: number): number;
}

/** Spin on the monotonic clock. Blocks the event loop by design; bounded by the ceiling. */
export const spin: BusyWait = (ns) => {
  const bounded = BigInt(Math.min(Math.max(0, Math.trunc(ns)), CALIBRATION_DELAY_CEILING_NS));
  const start = process.hrtime.bigint();
  let now = start;
  while (now - start < bounded) now = process.hrtime.bigint();
  return Number(now - start);
};

/** The histogram slice the handle uses. */
export interface LoopHistogram {
  enable(): void;
  reset(): void;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly exceeds: number;
  percentile(p: number): number;
  readonly count?: number;
}

export interface StagingSeams {
  readonly createPersistence?: (configuration: ListingPersistenceConfiguration) => ListingPersistence;
  readonly find?: (db: Kysely<ListingDatabase>, identity: unknown) => Promise<ReadResult>;
  readonly busyWait?: BusyWait;
  readonly histogram?: () => LoopHistogram | undefined;
  readonly bootNonce?: string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] as number;
}

/** Per-nominal summaries of calibration records, in ascending nominal order. */
export function summarizeCalibration(records: readonly CalibrationRecord[]): readonly CalibrationSummary[] {
  const byNominal = new Map<number, number[]>();
  for (const record of records) {
    const list = byNominal.get(record.nominalNs) ?? [];
    list.push(record.realizedNs);
    byNominal.set(record.nominalNs, list);
  }
  return [...byNominal.entries()]
    .sort(([a], [b]) => a - b)
    .map(([nominalNs, realized]) => {
      const sorted = [...realized].sort((a, b) => a - b);
      return {
        nominalNs,
        count: sorted.length,
        minNs: sorted[0] as number,
        p50Ns: percentile(sorted, 50),
        p99Ns: percentile(sorted, 99),
        maxNs: sorted[sorted.length - 1] as number,
        overruns: sorted.filter((value) => value > nominalNs + CALIBRATION_OVERRUN_NS).length,
      };
    });
}

function summarizeLoop(histogram: LoopHistogram): EventLoopSummary {
  return {
    resolutionMs: EVENT_LOOP_RESOLUTION_MS,
    samples: histogram.count ?? -1,
    minNs: histogram.min,
    meanNs: Number.isFinite(histogram.mean) ? histogram.mean : 0,
    p50Ns: histogram.percentile(50),
    p99Ns: histogram.percentile(99),
    maxNs: histogram.max,
  };
}

const defaultHistogram = (): LoopHistogram => monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS }) as IntervalHistogram as LoopHistogram;

/** Build the handle. One per process in production (`stagingSource`); tests build their own. */
export function createStaging(configuration: StagingConfiguration, seams: StagingSeams = {}): StagingHandle {
  const createPersistence = seams.createPersistence ?? createListingPersistence;
  const find = seams.find ?? findPubliclyAvailableListing;
  const busyWait = seams.busyWait ?? spin;
  const bootNonce = seams.bootNonce ?? randomBytes(16).toString("hex");
  const calibration = new Map<string, { readonly index: number; readonly entry: CalibrationEntry }>(
    configuration.calibration.map((entry, index) => [entry.identity, { index, entry }]),
  );
  const histogram = (seams.histogram ?? defaultHistogram)();
  histogram?.enable();

  let refused = false;
  let verified = false;
  let s2Reads = 0;
  let refusals = 0;
  let readsAfterRefusal = 0;
  let overlappedReads = 0;
  let inFlight = 0;
  let sequence = 0;
  const ring: CalibrationRecord[] = [];
  let sinceLastStatus: CalibrationRecord[] = [];

  const refuse = (): void => {
    if (!refused) refusals += 1;
    refused = true;
  };

  const persistence = createPersistence({
    pool: stagingPoolConfiguration(configuration, async (client: unknown) => {
      if (refused) throw new StagingRefused();

      let matches = false;
      try {
        matches = await stagingConnectionMatches(client as VerifiableClient, configuration.expected);
      } catch {
        matches = false;
      }

      if (!matches) {
        refuse();
        throw new StagingRefused();
      }

      verified = true;
    }),
    startupParameters: { application_name: "bi4_staging" },
  });

  const db = persistence.db;

  const guardedFind = (reserved: Kysely<ListingDatabase>, identity: unknown): Promise<ReadResult> => {
    if (refused) readsAfterRefusal += 1;
    return find(reserved, identity);
  };

  const calibrate = (identity: unknown): void => {
    if (typeof identity !== "string") return;
    const match = calibration.get(identity);
    if (match === undefined) return;
    const realizedNs = busyWait(match.entry.delayNs);
    sequence += 1;
    const record = { sequence, identityIndex: match.index, nominalNs: match.entry.delayNs, realizedNs };
    ring.push(record);
    if (ring.length > CALIBRATION_RING_SIZE) ring.shift();
    sinceLastStatus.push(record);
    if (sinceLastStatus.length > CALIBRATION_RING_SIZE) sinceLastStatus.shift();
  };

  return {
    isRefused: () => refused,
    async precheck() {
      if (refused) return "refused";
      try {
        await db.connection().execute(async () => undefined);
      } catch {
        refuse();
      }
      return refused ? "refused" : "ok";
    },
    async read(identity) {
      s2Reads += 1;
      if (inFlight > 0) overlappedReads += 1;
      inFlight += 1;

      try {
        if (refused) return REFUSED;

        let outcome: ReadResult | Refused;
        try {
          outcome = await db.connection().execute(async (reserved) => (refused ? REFUSED : guardedFind(reserved, identity)));
        } catch {
          refuse();
          return REFUSED;
        }

        if (outcome !== REFUSED) calibrate(identity);
        return outcome;
      } finally {
        inFlight -= 1;
      }
    },
    status() {
      const window = sinceLastStatus;
      sinceLastStatus = [];
      const loop = histogram === undefined ? null : summarizeLoop(histogram);
      histogram?.reset();
      return {
        bootNonce,
        state: refused ? "refused" : verified ? "verified" : "unconnected",
        s2Reads,
        refusals,
        readsAfterRefusal,
        overlappedReads,
        calibrationEnabled: calibration.size > 0,
        calibrationSinceLastStatus: summarizeCalibration(window),
        calibrationTotal: summarizeCalibration(ring),
        eventLoopSinceLastStatus: loop,
      };
    },
    async shutdown() {
      refused = true;
      await persistence.shutdown();
    },
  };
}

/** One handle per configuration, and one boot nonce per process. */
const cache = globalThis as typeof globalThis & {
  __bi4StagingBootNonce?: string;
  __bi4Staging?: { readonly key: string; readonly handle: StagingHandle };
};

export type StagingSource =
  | { readonly kind: "off" }
  | { readonly kind: "deny-all" }
  | { readonly kind: "on"; readonly handle: StagingHandle };

/** The process's staging source, read from the environment on each call. */
export function stagingSource(): StagingSource {
  const mode = stagingModeOf(process.env);
  if (mode.kind !== "on") return mode;

  cache.__bi4StagingBootNonce ??= randomBytes(16).toString("hex");
  const key = JSON.stringify(mode.configuration);

  if (cache.__bi4Staging?.key !== key) {
    void cache.__bi4Staging?.handle.shutdown().catch(() => {});
    cache.__bi4Staging = { key, handle: createStaging(mode.configuration, { bootNonce: cache.__bi4StagingBootNonce }) };
  }

  return { kind: "on", handle: cache.__bi4Staging.handle };
}

/**
 * The app-role setup the operator tool runs as `doadmin` on `bi4_staging` (proposal revision 2
 * §1.3 e). `PUBLIC`'s default privileges are revoked first, so the role's effective privileges are
 * exactly: connect, use schema `public`, read `listing`. No `pg_control_system()` grant (C-1′
 * replaces C-1). The role is created by SQL because DigitalOcean sets privileges only through a
 * SQL client.
 */
export function stagingRoleSetupStatements(input: { readonly database: string; readonly role: string; readonly password: string }): readonly string[] {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(input.database) || !/^[a-z_][a-z0-9_]{0,62}$/.test(input.role)) {
    throw new Error("the database and role names must be plain lower-case identifiers");
  }
  if (!/^[A-Za-z0-9]{16,128}$/.test(input.password)) {
    throw new Error("the role password must be 16 to 128 ASCII letters or digits");
  }

  const database = `"${input.database}"`;
  const role = `"${input.role}"`;

  return [
    `revoke all on database ${database} from public`,
    "revoke all on schema public from public",
    `create role ${role} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit password '${input.password}'`,
    `grant connect on database ${database} to ${role}`,
    `grant usage on schema public to ${role}`,
    `grant select on public.listing to ${role}`,
  ];
}
