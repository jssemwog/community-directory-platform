/**
 * The OP-2 **private staging** mode's configuration and access key (issue #246, OP-2 staging Scope
 * Gate revision 2 §3 and §7; proposal revision 2 §2.6).
 *
 * **Pure and database-free.** `src/proxy.ts` imports this module on every request, so it reads only
 * its inputs and `node:crypto`. It opens nothing, logs nothing and holds no state.
 *
 * **Publicly reachable, application-key gated.** The staging service has a public hostname. This
 * module decides who may reach the application. It is not a network control.
 *
 * **Fail closed** (§3.5). With `NODE_ENV=production`:
 * - `BI4_STAGING` absent: the mode is **off**, and nothing changes;
 * - `BI4_STAGING` present with **any** value: the gate is **armed**;
 * - armed and fully valid: the mode is **on**;
 * - armed and anything else: **deny-all**. That covers a value other than exactly `1`, any staging
 *   variable missing or malformed, `BI4_E3_LOCAL` set, the local demo's variable set, or calibration
 *   malformed or out of bounds. Every request then gets the gate's `404`, even with a valid key.
 *
 * Under any other `NODE_ENV` (for example `next dev`), every `BI4_STAGING*` variable is ignored.
 */

import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";

/** The flag. Present with any value arms the gate; exactly `"1"` (and a valid configuration) turns the mode on. */
export const BI4_STAGING = "BI4_STAGING";
/** The app role's URL: `postgres(ql)://role:password@<expected host>:<port>/bi4_staging`, no query string. */
export const BI4_STAGING_DATABASE_URL = "BI4_STAGING_DATABASE_URL";
/** The database server's DNS name. The URL's host must equal it exactly. TLS verifies it. */
export const BI4_STAGING_EXPECTED_HOST = "BI4_STAGING_EXPECTED_HOST";
/** The cluster's CA certificate: exactly one PEM certificate. */
export const BI4_STAGING_CA_PEM = "BI4_STAGING_CA_PEM";
/** The database name, which must be `bi4_staging` and the URL's path. */
export const BI4_STAGING_EXPECTED_DATABASE = "BI4_STAGING_EXPECTED_DATABASE";
/** The per-lifetime synthetic marker, set as the database comment by the operator tool. */
export const BI4_STAGING_SYNTHETIC_MARKER = "BI4_STAGING_SYNTHETIC_MARKER";
/** SHA-256 of the access key, as 64 lower-case hex digits. The key itself is never configured. */
export const BI4_STAGING_ACCESS_KEY_SHA256 = "BI4_STAGING_ACCESS_KEY_SHA256";
/** Optional. Calibration identities and delays (§7). Absent means calibration is off. */
export const BI4_STAGING_CALIBRATION = "BI4_STAGING_CALIBRATION";

/** Every variable the mode reads, the flag included. */
export const STAGING_VARIABLES: readonly string[] = [
  BI4_STAGING,
  BI4_STAGING_DATABASE_URL,
  BI4_STAGING_EXPECTED_HOST,
  BI4_STAGING_CA_PEM,
  BI4_STAGING_EXPECTED_DATABASE,
  BI4_STAGING_SYNTHETIC_MARKER,
  BI4_STAGING_ACCESS_KEY_SHA256,
  BI4_STAGING_CALIBRATION,
];

/** Variables whose presence alongside an armed staging gate forces deny-all. */
export const CONFLICTING_VARIABLES: readonly string[] = ["BI4_E3_LOCAL", "LOCAL_DEMO_DATABASE_URL"];

/** The only database name the mode accepts (proposal revision 2 §2.6). */
export const STAGING_DATABASE = "bi4_staging";

/** The request header that carries the key (§3.3). Lower case, as `Headers` reports it. */
export const STAGING_KEY_HEADER = "x-bi4-staging-key";

/** The key's exact shape: 32 random bytes as 43 base64url characters. */
export const STAGING_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The digest's exact shape. */
export const STAGING_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The marker's exact shape: a fixed prefix and a 32-hex-digit per-lifetime nonce. */
export const STAGING_MARKER_PATTERN = /^bi4-staging-synthetic:[0-9a-f]{32}$/;

/**
 * The reserved `S2` identity that serves the staging status (amendment A1, option D). It is not
 * UUID-shaped, so `OP-2` can never treat it as a listing, and it is never inserted. Status is served
 * at `/directory/__bi4_status__` only when the staging source is configured. Outside staging that
 * path is an ordinary `S2` path with no configured source, so it behaves exactly as on the baseline.
 */
export const STAGING_STATUS_IDENTITY = "__bi4_status__";

/**
 * The calibration delay ceiling, **a code constant, not configuration** (§7.2, D-G4): 2 ms.
 * A configured delay above it makes the configuration malformed, so the mode denies everything.
 */
export const CALIBRATION_DELAY_CEILING_NS = 2_000_000;

/** At most this many calibration identities (§7.2, D-G4). */
export const CALIBRATION_MAX_IDENTITIES = 4;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const PASSWORD = /^[A-Za-z0-9]{16,128}$/;
const PORT = /^[1-9][0-9]{0,4}$/;
/** A lower-case DNS name of labels. An IPv4 literal is refused separately; `:` and `[` never match. */
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_LITERAL = /^[0-9]+(?:\.[0-9]+){0,3}$/;
/** A lower-case, v4-shaped UUID (`ADR-019`). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]{1,76}\r?\n)+-----END CERTIFICATE-----\r?\n?$/;

/** One calibration identity and its nominal delay. */
export interface CalibrationEntry {
  readonly identity: string;
  readonly delayNs: number;
}

/** What the database connection must be (C-2 to C-4) and how TLS must identify it (C-1′). */
export interface StagingExpected {
  readonly host: string;
  readonly database: string;
  readonly role: string;
  readonly marker: string;
}

export interface StagingConfiguration {
  readonly connectionString: string;
  readonly caPem: string;
  readonly expected: StagingExpected;
  readonly keyDigestHex: string;
  readonly calibration: readonly CalibrationEntry[];
}

export type StagingMode =
  | { readonly kind: "off" }
  | { readonly kind: "deny-all" }
  | { readonly kind: "on"; readonly configuration: StagingConfiguration };

const OFF: StagingMode = Object.freeze({ kind: "off" });
const DENY_ALL: StagingMode = Object.freeze({ kind: "deny-all" });

/** Whether a host is a DNS name the mode accepts: lower case, labels only, never an IP literal. */
export function isStagingHostName(host: string): boolean {
  return DNS_NAME.test(host) && !IPV4_LITERAL.test(host);
}

/** One PEM certificate that Node can parse, or `undefined`. */
export function singleCertificateOf(pem: string): string | undefined {
  if (!PEM_CERTIFICATE.test(pem)) return undefined;
  try {
    new X509Certificate(pem);
    return pem;
  } catch {
    return undefined;
  }
}

/**
 * The calibration set, or `undefined` when the value is malformed or out of bounds.
 * Format: `<uuid>:<delayNs>` entries joined by commas, 1 to 4 of them, distinct identities, each
 * delay an integer from 0 to the ceiling inclusive.
 */
export function calibrationOf(value: string): readonly CalibrationEntry[] | undefined {
  const parts = value.split(",");
  if (parts.length < 1 || parts.length > CALIBRATION_MAX_IDENTITIES) return undefined;

  const entries: CalibrationEntry[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const match = /^([0-9a-f-]{36}):(0|[1-9][0-9]{0,6})$/.exec(part);
    if (match === null) return undefined;
    const identity = match[1] as string;
    const delayNs = Number(match[2]);
    if (!UUID_V4.test(identity) || seen.has(identity)) return undefined;
    if (!Number.isSafeInteger(delayNs) || delayNs < 0 || delayNs > CALIBRATION_DELAY_CEILING_NS) return undefined;
    seen.add(identity);
    entries.push(Object.freeze({ identity, delayNs }));
  }

  return Object.freeze(entries);
}

/** The full configuration, or `undefined` if anything is missing or malformed. */
function configurationOf(environment: Readonly<Record<string, string | undefined>>): StagingConfiguration | undefined {
  const supplied = environment[BI4_STAGING_DATABASE_URL];
  const host = environment[BI4_STAGING_EXPECTED_HOST];
  const caPem = environment[BI4_STAGING_CA_PEM];
  const database = environment[BI4_STAGING_EXPECTED_DATABASE];
  const marker = environment[BI4_STAGING_SYNTHETIC_MARKER];
  const digest = environment[BI4_STAGING_ACCESS_KEY_SHA256];
  const calibrationValue = environment[BI4_STAGING_CALIBRATION];

  if (
    supplied === undefined ||
    host === undefined ||
    !isStagingHostName(host) ||
    caPem === undefined ||
    database !== STAGING_DATABASE ||
    marker === undefined ||
    !STAGING_MARKER_PATTERN.test(marker) ||
    digest === undefined ||
    !STAGING_DIGEST_PATTERN.test(digest)
  ) {
    return undefined;
  }

  const certificate = singleCertificateOf(caPem);
  if (certificate === undefined) return undefined;

  const calibration = calibrationValue === undefined ? Object.freeze([]) : calibrationOf(calibrationValue);
  if (calibration === undefined) return undefined;

  let url: URL;
  let role: string;
  let password: string;

  try {
    url = new URL(supplied);
    role = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return undefined;
  }

  // No query string and no fragment: a `host=`, `hostaddr=` or `sslmode=` parameter would override
  // the host or the TLS settings, because `pg` merges a parsed URL over the explicit configuration.
  const acceptable =
    (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
    url.hostname === host &&
    PORT.test(url.port) &&
    url.search === "" &&
    !supplied.includes("?") &&
    !supplied.includes("#") &&
    url.pathname === `/${database}` &&
    IDENTIFIER.test(role) &&
    PASSWORD.test(password);

  if (!acceptable) return undefined;

  return Object.freeze({
    connectionString: supplied,
    caPem: certificate,
    expected: Object.freeze({ host, database, role, marker }),
    keyDigestHex: digest,
    calibration,
  });
}

/**
 * The mode for this environment. Pure, and read on every request, so a changed environment takes
 * effect at once and enablement is testable without a server.
 */
export function stagingModeOf(environment: Readonly<Record<string, string | undefined>>): StagingMode {
  if (environment.NODE_ENV !== "production" || environment[BI4_STAGING] === undefined) {
    return OFF;
  }

  if (environment[BI4_STAGING] !== "1") return DENY_ALL;
  if (CONFLICTING_VARIABLES.some((name) => environment[name] !== undefined)) return DENY_ALL;

  const configuration = configurationOf(environment);

  return configuration === undefined ? DENY_ALL : { kind: "on", configuration };
}

/** SHA-256 of a key, as lower-case hex. Used by the operator tool and by tests. */
export function stagingKeyDigestHex(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Whether the request presents the key. Exactly one well-formed header value whose SHA-256 equals
 * the configured digest, compared in constant time. `Headers` joins a repeated header with `", "`,
 * which never matches the key's shape, so a duplicate is refused. Every failure is the same `false`.
 */
export function presentsStagingKey(headers: Headers, digestHex: string): boolean {
  const presented = headers.get(STAGING_KEY_HEADER);
  const expected = Buffer.from(digestHex, "hex");
  const shaped = presented !== null && STAGING_KEY_PATTERN.test(presented);
  // The digest is computed whatever the shape, so a malformed value costs the same hash.
  const actual = createHash("sha256")
    .update(shaped ? presented : "", "utf8")
    .digest();

  return shaped && expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Whether a pathname is one `S2` path: `/directory/<one non-empty segment>`. */
export function isStagingS2Path(pathname: string): boolean {
  return /^\/directory\/[^/]+$/.test(pathname);
}
