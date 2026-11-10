/**
 * `e3-check`: the `E3-local` acceptance launcher (issue #246; `E3-local` Scope Gate revision 4,
 * approved, with its approval record's clarification). **Every run needs its own explicit
 * authorization.** Approving the gate, or this code, authorizes no run.
 *
 * This module holds the run's order and its rules, behind injected seams, so they are testable
 * without a server, a database or a build. `cli.ts` binds the real seams.
 *
 * ## Order
 *
 * 1. **E-A1:** worktree, `npm ci`, then `next build` with no `BI4_E3_*` variable and no database
 *    URL, before any cluster exists.
 * 2. **L-1/L-2:** the cluster is created with `E3_CLUSTER_REQUEST`: **no database and no
 *    migration**. Before the callback the helper runs only `initdb` (a bootstrap child process
 *    with no listener; this is not network SQL) and the server start, so it sends no SQL. The
 *    target is `127.0.0.1` and the cluster's own port. The postmaster's identity comes from
 *    `postmaster.pid`.
 * 3. **L-3:** before the run's first network SQL statement, every listening entry on that port must
 *    belong to the recorded postmaster (same PID and creation time), on loopback only, with at least
 *    one entry on `127.0.0.1`. If it fails, no network SQL is sent at all, during cleanup included:
 *    nothing has been registered with the helper, whose cleanup is `pg_ctl stop`.
 * 4. **L-4:** only then, as the superuser over `127.0.0.1` on the harness-owned port: `bi4_e3` is
 *    created over a bootstrap connection to the built-in `postgres` database, which is closed even
 *    on failure; then, on `bi4_e3`, migrations, fixtures, identity (system identifier, and
 *    `data_directory` equal to the created directory), the synthetic marker, and the app role.
 * 5. **E-A2, E-A3, E-A4:** one `next start` each. **L-5:** the database listener is checked again
 *    before each start, at the handoff before any request, and after the last request. The app's
 *    own listener must be exactly one `127.0.0.1` entry owned by the recorded `next start` process
 *    or a descendant.
 *    Each phase's server is stopped only after full identity checks; if its shutdown is
 *    unresolved, no further phase starts (`stopPhaseServer`).
 * 6. **E-A4b:** deliberate fault injection, with its **own pass or fail**, reported separately
 *    from the normal acceptance result (ruling S-7).
 * 7. **E-A5:** stored states verified while the database is up; then the leak scans.
 * 8. **After the run** (the caller): owned-resource teardown, then the independent residue checks
 *    (`e3FinalSafety`). Zero residue is never inferred from the teardown summary alone.
 *
 * ## Rules
 *
 * - **Hard cap:** 60 HTTP attempts across every phase, readiness and failed attempts included,
 *   checked before each send. When it is spent, nothing more is sent.
 * - **Wire status is what is judged.** Every request is direct, redirects are not followed, and
 *   the status is read from the response. It is never inferred from timing.
 * - **E-A4 comparison:** for well-formed never-existed, pending, rejected and unpublished
 *   identities, the status, the body with **only** the request's own UUID masked (count included),
 *   and the header list with **only** `Date` removed (own UUID masked) must be identical; `Date` is
 *   checked separately. Nothing else is normalized. The malformed control and the public positive
 *   control are judged on their own rules.
 * - **S-7:** a generic 200 caused by a database refusal during the normal sequence fails the run.
 *   The public control is sent at the start and the end of E-A4, so a refusal in between shows.
 * - **Secrets:** the app-role password and URL are redacted from every report and console line,
 *   including response headers and exception messages (`createRedactor`, `redactDeep`).
 */

import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";

import type { ListingDatabase } from "../../src/data/listing-table";
import { DIRECTORY_COPY } from "../../src/interface/public/directory-view";
import { E3_MARKER_PATTERN, e3LocalRoleSetupStatements } from "../../src/interface/public/e3-local-persistence";
import { checkDate, comparisonListOf, maskOwnIdentity } from "./body-compare";
import { FIXTURE_CONTENT, loadFixtures, verifyStoredStates } from "./fixtures";
import { checkProcessIdentity, type ListeningEntry, type PidFileEvidence, type ProcessIdentity, type ResourceEntry, type ResourceState, type TeardownReport } from "./isolation";
import type { Plan, PlanIdentity } from "./schedule";

/** The hard HTTP attempt cap across every phase (ruling S-6). */
export const E3_REQUEST_CAP = 60;
/** The disposable database's name. */
export const E3_DATABASE = "bi4_e3";
/** Addresses a database listening entry may use (L-3). */
export const DATABASE_LOOPBACK_ADDRESSES: readonly string[] = ["127.0.0.1", "::1"];
/** The only address the app's listener may use. */
export const APP_LOOPBACK = "127.0.0.1";
/** The app's readiness path: the home page, which reads no data. */
export const READINESS_PATH = "/";
export const READINESS_POLL_MS = 500;
export const READINESS_BOUND_MS = 120_000;

/** A stop: the run ends, owned-resource teardown still runs, and the message is reported. */
export class E3Stop extends Error {}

/* ------------------------------------------------------------------------------------------- */
/* The attempt budget                                                                             */
/* ------------------------------------------------------------------------------------------- */

export type E3Phase = "E-A2" | "E-A3" | "E-A4" | "E-A4b";

export interface E3Attempt {
  readonly attempt: number;
  readonly phase: E3Phase;
  readonly kind: "readiness" | "request";
  readonly method: string;
  readonly path: string;
  /** `status <code>`, or the transport error's message. */
  readonly outcome: string;
}

export interface E3Budget {
  readonly limit: number;
  remaining(): number;
  charge(attempt: Omit<E3Attempt, "attempt">): void;
  attempts(): readonly E3Attempt[];
}

export function createE3Budget(limit: number = E3_REQUEST_CAP): E3Budget {
  const attempts: E3Attempt[] = [];
  return {
    limit,
    remaining: () => Math.max(0, limit - attempts.length),
    charge: (attempt) => void attempts.push({ attempt: attempts.length + 1, ...attempt }),
    attempts: () => [...attempts],
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Listener checks                                                                                */
/* ------------------------------------------------------------------------------------------- */

export interface RecordedProcess {
  readonly pid: number;
  readonly creationTime: string;
}

export interface E3Inspections {
  /** Every listening entry on the port; throws on a failed or malformed lookup. */
  readonly lookup: (port: number) => Promise<readonly ListeningEntry[]>;
  readonly inspect: (pid: number) => Promise<ProcessIdentity | undefined>;
  readonly children: (pid: number) => Promise<readonly ProcessIdentity[]>;
}

/** L-3's rule for a set of listening entries. An empty list of problems means they pass. */
export function databaseListenerProblems(entries: readonly ListeningEntry[], postmasterPid: number): readonly string[] {
  if (entries.length === 0) return ["no listening entry on the cluster port"];
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.owningProcess !== postmasterPid) problems.push(`an entry on ${entry.localAddress} is owned by process ${entry.owningProcess}, not the recorded postmaster ${postmasterPid}`);
    if (!DATABASE_LOOPBACK_ADDRESSES.includes(entry.localAddress)) problems.push(`an entry is bound to ${entry.localAddress}, which is not loopback`);
  }
  if (!entries.some((entry) => entry.localAddress === "127.0.0.1")) problems.push("no entry is bound to 127.0.0.1");
  return problems;
}

/** L-3 and L-5: the database listener belongs to the recorded, still-live postmaster. No SQL. */
export async function verifyDatabaseListener(port: number, postmaster: RecordedProcess, inspections: E3Inspections, when: string): Promise<void> {
  const stop = (detail: string): E3Stop => new E3Stop(`Stopped (database listener, ${when}): ${detail}`);
  let entries: readonly ListeningEntry[];
  let live: ProcessIdentity | undefined;
  try {
    entries = await inspections.lookup(port);
  } catch (error) {
    throw stop(`the lookup failed: ${(error as Error).message}`);
  }
  try {
    live = await inspections.inspect(postmaster.pid);
  } catch (error) {
    throw stop(`the postmaster inspection failed: ${(error as Error).message}`);
  }
  if (live === undefined || live.creationTime !== postmaster.creationTime) throw stop(`the recorded postmaster ${postmaster.pid} is gone or was replaced`);
  const problems = databaseListenerProblems(entries, postmaster.pid);
  if (problems.length > 0) throw stop(problems.join("; "));
}

/**
 * The app's listener, with no HTTP: `"unbound"` for a successful empty lookup; otherwise exactly
 * one entry, on `127.0.0.1`, owned by the recorded server or a descendant of it.
 */
export async function checkAppListener(port: number, server: RecordedProcess, inspections: E3Inspections): Promise<"unbound" | number> {
  const stop = (detail: string): E3Stop => new E3Stop(`Stopped (app listener): ${detail}`);
  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      throw stop(`${what} failed: ${(error as Error).message}`);
    }
  };

  const entries = await attempt("the lookup", () => inspections.lookup(port));
  if (entries.length === 0) return "unbound";
  if (entries.length > 1) throw stop(`port ${port} has ${entries.length} listening entries`);
  const [entry] = entries as [ListeningEntry];
  if (entry.localAddress !== APP_LOOPBACK) throw stop(`port ${port} is bound to ${entry.localAddress}`);

  const root = await attempt("the server inspection", () => inspections.inspect(server.pid));
  if (root === undefined || root.creationTime !== server.creationTime) throw stop(`the recorded server ${server.pid} is gone or was replaced`);
  if (entry.owningProcess === server.pid) return entry.owningProcess;

  const queue = [server.pid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of await attempt("the descendant inspection", () => inspections.children(parent))) {
      if (child.pid === entry.owningProcess) return entry.owningProcess;
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        queue.push(child.pid);
      }
    }
  }
  throw stop(`port ${port} is owned by process ${entry.owningProcess}, which is not the recorded server or a descendant`);
}

export async function verifyAppListenerNow(port: number, server: RecordedProcess, inspections: E3Inspections): Promise<void> {
  if ((await checkAppListener(port, server, inspections)) === "unbound") throw new E3Stop(`Stopped (app listener): port ${port} is not bound at the handoff`);
}

/* ------------------------------------------------------------------------------------------- */
/* The request plan and its expectations                                                          */
/* ------------------------------------------------------------------------------------------- */

export interface E3Fixtures {
  readonly neverExisted: readonly [string, string];
  readonly pending: string;
  readonly rejected: string;
  readonly unpublished: string;
  readonly publiclyAvailable: string;
  readonly malformed: string;
  /** Text that only a public listing's page shows. */
  readonly publicName: string;
  /** Fixture text that must never appear in a malformed-identity response. */
  readonly fixtureTexts: readonly string[];
}

export type Expectation =
  | { readonly kind: "not-found"; readonly body?: "plain" | "framework"; readonly headers?: "admin" | "none" }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "recorded" }
  | { readonly kind: "equivalence"; readonly identity: string; readonly state: "NE" | "PE" | "RJ" | "UP" }
  | { readonly kind: "malformed" }
  | { readonly kind: "public"; readonly identity: string };

export interface E3Request {
  readonly phase: E3Phase;
  readonly label: string;
  readonly method: "GET" | "OPTIONS";
  readonly path: string;
  readonly expect: Expectation;
}

const s2 = (identity: string): string => `/directory/${identity}`;

/** The requests of one phase, in order (revision 4 §5.1). */
export function e3Requests(phase: E3Phase, fixtures: E3Fixtures): readonly E3Request[] {
  const [ne0, ne1] = fixtures.neverExisted;
  const req = (label: string, path: string, expect: Expectation, method: "GET" | "OPTIONS" = "GET"): E3Request => ({ phase, label, method, path, expect });

  switch (phase) {
    case "E-A2":
      return [
        req("/directory (flag absent)", "/directory", { kind: "not-found", headers: "none" }),
        req("/directory/ (trailing slash)", "/directory/", { kind: "redirect", location: "/directory" }),
        req("S2 never-existed", s2(ne0), { kind: "not-found" }),
        req("S2 pending", s2(fixtures.pending), { kind: "not-found" }),
        req("S2 public", s2(fixtures.publiclyAvailable), { kind: "not-found" }),
        req("/admin", "/admin", { kind: "not-found", headers: "admin" }),
      ];
    case "E-A3":
      return [
        req("/directory (proxy rule)", "/directory", { kind: "not-found", body: "plain", headers: "none" }),
        req("S2 never-existed (triggering request)", s2(ne0), { kind: "not-found" }),
        req("S2 public (after refusal)", s2(fixtures.publiclyAvailable), { kind: "not-found" }),
      ];
    case "E-A4":
      return [
        req("/directory (proxy rule)", "/directory", { kind: "not-found", body: "plain", headers: "none" }),
        req("/directory/ (trailing slash)", "/directory/", { kind: "redirect", location: "/directory" }),
        req("/Directory (case variant)", "/Directory", { kind: "recorded" }),
        req("/%64irectory (encoded variant)", "/%64irectory", { kind: "recorded" }),
        req("S2 public (control, first)", s2(fixtures.publiclyAvailable), { kind: "public", identity: fixtures.publiclyAvailable }),
        req("S2 never-existed 1", s2(ne0), { kind: "equivalence", identity: ne0, state: "NE" }),
        req("S2 never-existed 2", s2(ne1), { kind: "equivalence", identity: ne1, state: "NE" }),
        req("S2 pending", s2(fixtures.pending), { kind: "equivalence", identity: fixtures.pending, state: "PE" }),
        req("S2 rejected", s2(fixtures.rejected), { kind: "equivalence", identity: fixtures.rejected, state: "RJ" }),
        req("S2 unpublished", s2(fixtures.unpublished), { kind: "equivalence", identity: fixtures.unpublished, state: "UP" }),
        req("S2 malformed (control)", s2(fixtures.malformed), { kind: "malformed" }),
        req("S2 public (control, last)", s2(fixtures.publiclyAvailable), { kind: "public", identity: fixtures.publiclyAvailable }),
        req("/admin", "/admin", { kind: "not-found", headers: "admin" }),
        req("OPTIONS /admin", "/admin", { kind: "not-found", body: "plain" }, "OPTIONS"),
      ];
    case "E-A4b":
      return [
        req("S2 never-existed (triggering request, fault injected)", s2(ne0), { kind: "not-found" }),
        req("S2 public (after refusal, fault injected)", s2(fixtures.publiclyAvailable), { kind: "not-found" }),
      ];
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Evaluation                                                                                     */
/* ------------------------------------------------------------------------------------------- */

export interface E3Exchange {
  readonly status: number;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
  readonly writeStartMs: number;
  readonly responseEndMs: number;
}

export const NOT_AVAILABLE_MARKUP = "<h1>Not available</h1>";
/** `S1`'s own heading: it must never appear under `E3-local`. */
export const S1_MARKUP = "<h1>Directory</h1>";
const ERROR_COPY: readonly string[] = ["Something went wrong", DIRECTORY_COPY.listingError, DIRECTORY_COPY.directoryError];
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export const ADMIN_HEADER_VALUES: Readonly<Record<string, string>> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "same-origin",
};

export function headerValues(rawHeaders: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if ((rawHeaders[i] as string).toLowerCase() === name) values.push(rawHeaders[i + 1] as string);
  return values;
}

/** Problems with one exchange under its own expectation (the E-A4 set is compared separately). */
export function exchangeProblems(request: E3Request, exchange: E3Exchange, fixtures: E3Fixtures): readonly string[] {
  const problems: string[] = [];
  const body = exchange.body.toString("utf8");
  const expect = request.expect;
  const status = (wanted: number): void => {
    if (exchange.status !== wanted) problems.push(`status ${exchange.status}, expected ${wanted}`);
  };

  if (body.includes(S1_MARKUP)) problems.push("S1 content was exposed");

  switch (expect.kind) {
    case "not-found":
      status(404);
      if (expect.body === "plain" && body !== "Not Found") problems.push("the body is not the proxy's plain-text Not Found");
      if (expect.headers === "admin") {
        for (const [name, value] of Object.entries(ADMIN_HEADER_VALUES)) {
          const found = headerValues(exchange.rawHeaders, name);
          if (found.length !== 1 || found[0] !== value) problems.push(`admin header ${name} is ${JSON.stringify(found)}, expected ${JSON.stringify(value)}`);
        }
        if (!headerValues(exchange.rawHeaders, "cache-control").some((value) => value.includes("no-store"))) problems.push("admin response lacks Cache-Control no-store");
      }
      if (expect.headers === "none") {
        for (const name of Object.keys(ADMIN_HEADER_VALUES)) if (headerValues(exchange.rawHeaders, name).length > 0) problems.push(`an admin header (${name}) was applied to /directory`);
      }
      break;
    case "redirect": {
      status(308);
      const location = headerValues(exchange.rawHeaders, "location");
      if (location.length !== 1 || location[0] !== expect.location) problems.push(`Location is ${JSON.stringify(location)}, expected ${JSON.stringify(expect.location)}`);
      break;
    }
    case "recorded":
      break;
    case "equivalence":
      status(200);
      if (!body.includes(NOT_AVAILABLE_MARKUP)) problems.push("the not-available content is missing");
      break;
    case "malformed": {
      status(200);
      if (!body.includes(NOT_AVAILABLE_MARKUP)) problems.push("the not-available content is missing");
      for (const text of [fixtures.publicName, ...fixtures.fixtureTexts]) if (body.includes(text)) problems.push("fixture text appears in the malformed response");
      for (const copy of ERROR_COPY) if (body.includes(copy)) problems.push("error copy appears in the malformed response");
      const uuids = new Set(body.match(UUID_ANYWHERE) ?? []);
      const known = [...fixtures.neverExisted, fixtures.pending, fixtures.rejected, fixtures.unpublished, fixtures.publiclyAvailable];
      if (known.some((identity) => uuids.has(identity))) problems.push("a fixture identity appears in the malformed response");
      break;
    }
    case "public":
      status(200);
      if (!body.includes(fixtures.publicName)) problems.push("the public listing's name is missing (a refusal or failure would explain it)");
      if (body.includes(NOT_AVAILABLE_MARKUP)) problems.push("the public listing rendered the not-available content");
      break;
  }

  return problems;
}

export interface Observed {
  readonly request: E3Request;
  readonly exchange: E3Exchange;
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export interface EquivalenceResult {
  readonly problems: readonly string[];
  readonly signatures: readonly { readonly label: string; readonly status: number; readonly body: string; readonly replacements: number; readonly headers: string; readonly date: string }[];
}

/** The E-A4 comparison (revision 2 §4.1) and the positive control's difference (§4.3). */
export function compareE3Equivalence(observed: readonly Observed[]): EquivalenceResult {
  const members = observed.filter((o): o is Observed & { request: { expect: { kind: "equivalence"; identity: string } } } => o.request.expect.kind === "equivalence");
  const problems: string[] = [];
  const signatures = members.map(({ request, exchange }) => {
    const identity = (request.expect as { identity: string }).identity;
    const masked = maskOwnIdentity(exchange.body, identity);
    const headers = comparisonListOf(exchange.rawHeaders, identity);
    const date = checkDate(exchange.rawHeaders, exchange);
    if (!(date.d1 && date.d2 && date.d3)) problems.push(`${request.label}: Date failed its checks (d1 ${date.d1}, d2 ${date.d2}, d3 ${date.d3})`);
    return { label: request.label, status: exchange.status, body: sha256(masked.masked), replacements: masked.count, headers: headers.hash, date: date.values.join(", ") };
  });

  const states = new Set(members.map((member) => (member.request.expect as { state: string }).state));
  for (const state of ["NE", "PE", "RJ", "UP"]) if (!states.has(state)) problems.push(`the equivalence set has no ${state} member`);
  if (members.filter((member) => (member.request.expect as { state: string }).state === "NE").length < 2) problems.push("the equivalence set needs at least two never-existed members");

  const [reference] = signatures;
  if (reference !== undefined) {
    for (const signature of signatures.slice(1)) {
      if (signature.status !== reference.status) problems.push(`${signature.label}: status ${signature.status} differs from ${reference.label}'s ${reference.status}`);
      if (signature.body !== reference.body || signature.replacements !== reference.replacements) problems.push(`${signature.label}: masked body differs from ${reference.label}'s`);
      if (signature.headers !== reference.headers) problems.push(`${signature.label}: header comparison list differs from ${reference.label}'s`);
    }

    const neverExisted = members.find((member) => (member.request.expect as { state: string }).state === "NE");
    for (const control of observed.filter((o) => o.request.expect.kind === "public")) {
      const identity = (control.request.expect as { identity: string }).identity;
      if (neverExisted !== undefined && sha256(maskOwnIdentity(control.exchange.body, identity).masked) === reference.body) {
        problems.push(`${control.request.label}: the positive control's masked body equals the never-existed body, so the comparator showed no difference`);
      }
    }
  }

  return { problems, signatures };
}

/* ------------------------------------------------------------------------------------------- */
/* Leak scans (revision 2 §5.4)                                                                   */
/* ------------------------------------------------------------------------------------------- */

export interface SensitiveValue {
  readonly label: string;
  readonly value: string;
}

export interface ScannedItem {
  readonly where: string;
  readonly bytes: Buffer;
}

/** Every place a sensitive value appears, by label. The value itself is never reported. */
export function leakHits(items: readonly ScannedItem[], values: readonly SensitiveValue[]): readonly { readonly where: string; readonly label: string }[] {
  const hits: { where: string; label: string }[] = [];
  for (const item of items) {
    for (const { label, value } of values) {
      if (value === "") continue;
      const spellings = new Set([value, encodeURIComponent(value)]);
      if ([...spellings].some((spelling) => item.bytes.includes(Buffer.from(spelling, "utf8")))) hits.push({ where: item.where, label });
    }
  }
  return hits;
}

/** Client assets that name a mode variable at all. */
export function prefixHits(items: readonly ScannedItem[], prefix = "BI4_E3_"): readonly string[] {
  return items.filter((item) => item.bytes.includes(Buffer.from(prefix, "utf8"))).map((item) => item.where);
}

/** Response bytes for the scan: the status line's headers and the body. */
export function exchangeItem(label: string, exchange: E3Exchange): ScannedItem {
  const headers: string[] = [];
  for (let i = 0; i < exchange.rawHeaders.length; i += 2) headers.push(`${exchange.rawHeaders[i]}: ${exchange.rawHeaders[i + 1]}`);
  return { where: `response ${label}`, bytes: Buffer.concat([Buffer.from(headers.join("\r\n"), "latin1"), Buffer.from("\r\n\r\n"), exchange.body]) };
}

/* ------------------------------------------------------------------------------------------- */
/* The cluster request and the superuser connections (L-1, L-4)                                   */
/* ------------------------------------------------------------------------------------------- */

/**
 * The cluster helper request. **It names no database and no migration.** So before the callback
 * runs, the helper does only two things, and neither sends SQL:
 * - `initdb`: a bootstrap child process that writes the data directory and has no listener;
 * - the server start, which waits for "ready to accept connections" on stderr.
 *
 * Its cleanup sends no SQL either. It closes only the resources registered with it, then runs
 * `pg_ctl stop -D <dir>`, which needs no credential. The first network SQL statement of the run
 * is therefore the launcher's own, after L-3 (`withEmbeddedPostgres` and `bringUp` in
 * `src/data/testing/embedded-cluster.ts`; `embedded-postgres` `createDatabase`, `getPgClient`).
 */
export const E3_CLUSTER_REQUEST: { readonly slug: string; readonly databases: readonly string[] } = Object.freeze({
  slug: "bi4-e3",
  databases: Object.freeze([]) as readonly string[],
});

/** PostgreSQL's built-in database, used only to create `bi4_e3`. */
export const BOOTSTRAP_DATABASE = "postgres";
export const BOOTSTRAP_APPLICATION_NAME = "bi4_e3_bootstrap";
export const SUPERUSER_APPLICATION_NAME = "bi4_e3_superuser";

/** The superuser's operations. Created only after L-3 has passed. */
export interface SuperuserOps {
  /** L-4's first step: create `bi4_e3` over a bootstrap connection, closed even on failure. */
  createDatabase(): Promise<void>;
  migrate(): Promise<void>;
  loadFixtures(fixtures: E3Fixtures): Promise<void>;
  verifyStoredStates(fixtures: E3Fixtures): Promise<readonly string[]>;
  systemIdentifier(): Promise<string>;
  dataDirectory(): Promise<string>;
  run(statements: readonly string[]): Promise<void>;
  setMarker(marker: string): Promise<void>;
  /** Terminate the app role's sessions and wait until the server shows none. */
  terminateAppSessions(role: string): Promise<void>;
}

/** One superuser connection. Constructing it opens nothing; the first statement does. */
export interface SuperuserConnection {
  readonly db: Kysely<ListingDatabase>;
  shutdown(): Promise<void>;
}

export interface SuperuserDeps {
  /** The harness-owned cluster port. */
  readonly port: number;
  /** The helper's URL for a database on that cluster (`connectionStringFor`). */
  readonly urlFor: (database: string) => string;
  readonly connect: (url: string, applicationName: string) => SuperuserConnection;
  /** Register a close with the helper, which runs it before stopping the server. */
  readonly register: (label: string, close: () => Promise<unknown>) => void;
  readonly migrate: (url: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** A superuser target must be `127.0.0.1` on the harness-owned port, naming exactly `database`. */
export function loopbackTargetProblems(url: string, port: number, database: string): readonly string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return ["the superuser URL could not be parsed"];
  }
  const problems: string[] = [];
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") problems.push(`the scheme is ${parsed.protocol}`);
  if (parsed.hostname !== "127.0.0.1") problems.push(`the host is ${parsed.hostname}, not 127.0.0.1`);
  if (parsed.port !== String(port)) problems.push(`the port is ${parsed.port}, not the harness-owned ${port}`);
  if (parsed.pathname !== `/${database}`) problems.push(`the database is ${parsed.pathname.slice(1)}, not ${database}`);
  if (parsed.search !== "") problems.push("the URL carries a query string");
  return problems;
}

/** The stored rows the fixture helpers need; they read only `identities` and `background`. */
export function e3FixturePlan(fixtures: E3Fixtures): Plan {
  const identities: PlanIdentity[] = [
    ...fixtures.neverExisted.map((key) => ({ key, cls: "NE" as const })),
    { key: fixtures.pending, cls: "PE" as const },
    { key: fixtures.rejected, cls: "RJ" as const },
    { key: fixtures.unpublished, cls: "UP" as const },
  ].map((identity, index) => ({ index, key: identity.key, cls: identity.cls, target: "next" as const }));
  return { identities, background: [fixtures.publiclyAvailable] } as unknown as Plan;
}

export function e3Fixtures(uuid: () => string, hex: (bytes: number) => string): E3Fixtures {
  return {
    neverExisted: [uuid(), uuid()],
    pending: uuid(),
    rejected: uuid(),
    unpublished: uuid(),
    publiclyAvailable: uuid(),
    malformed: `e3-malformed-${hex(6)}`,
    publicName: FIXTURE_CONTENT.name,
    fixtureTexts: [
      FIXTURE_CONTENT.description,
      FIXTURE_CONTENT.locality,
      FIXTURE_CONTENT.postalCode?.value ?? "",
      FIXTURE_CONTENT.phone?.value ?? "",
      FIXTURE_CONTENT.website?.value ?? "",
    ].filter((text) => text !== ""),
  };
}

/**
 * The superuser operations over explicit `127.0.0.1` connections. Constructing them opens
 * nothing and registers nothing, so a run that stops at L-3 leaves the helper nothing to close.
 */
export function createE3SuperuserOps(deps: SuperuserDeps): SuperuserOps {
  let main: SuperuserConnection | undefined;
  const target = (database: string): string => {
    const url = deps.urlFor(database);
    const problems = loopbackTargetProblems(url, deps.port, database);
    if (problems.length > 0) throw new E3Stop(`Stopped (superuser target): ${problems.join("; ")}`);
    return url;
  };
  const db = (): Kysely<ListingDatabase> => {
    if (main === undefined) {
      const opened = deps.connect(target(E3_DATABASE), SUPERUSER_APPLICATION_NAME);
      deps.register("e3 superuser connection", () => opened.shutdown());
      main = opened;
    }
    return main.db;
  };
  const appSessions = async (role: string): Promise<number> =>
    Number(((await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity where usename = ${role}`.execute(db())).rows[0] as { n: string }).n);

  return {
    async createDatabase() {
      const bootstrap = deps.connect(target(BOOTSTRAP_DATABASE), BOOTSTRAP_APPLICATION_NAME);
      deps.register("e3 bootstrap connection", () => bootstrap.shutdown());
      try {
        await sql.raw(`create database "${E3_DATABASE}"`).execute(bootstrap.db);
      } finally {
        await bootstrap.shutdown();
      }
    },
    migrate: async () => deps.migrate(target(E3_DATABASE)),
    loadFixtures: (fixtures) => loadFixtures(db(), e3FixturePlan(fixtures)),
    verifyStoredStates: (fixtures) => verifyStoredStates(db(), e3FixturePlan(fixtures)),
    systemIdentifier: async () => ((await sql<{ id: string }>`select system_identifier::text as id from pg_control_system()`.execute(db())).rows[0] as { id: string }).id,
    dataDirectory: async () => ((await sql<{ data_directory: string }>`show data_directory`.execute(db())).rows[0] as { data_directory: string }).data_directory,
    run: async (statements) => {
      for (const statement of statements) await sql.raw(statement).execute(db());
    },
    setMarker: async (marker) => {
      if (!E3_MARKER_PATTERN.test(marker)) throw new Error("the marker must match the E3 marker pattern");
      await sql.raw(`comment on database "${E3_DATABASE}" is '${marker}'`).execute(db());
    },
    terminateAppSessions: async (role) => {
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where usename = ${role}`.execute(db());
      const deadline = deps.now() + 10_000;
      while ((await appSessions(role)) > 0) {
        if (deps.now() > deadline) throw new E3Stop("Stopped (fault injection): the app sessions did not end within 10 s");
        await deps.sleep(100);
      }
      // Let the server process notice the termination before the next request.
      await deps.sleep(1_000);
    },
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Stopping owned process trees (full identity checks, ownership-proving orphan sweep)            */
/* ------------------------------------------------------------------------------------------- */

/** Rounds of the orphan sweep (amendment A1 §4.4). Anything found after the last is uncertain. */
export const ORPHAN_SWEEP_ROUNDS = 3;

/** A Windows FILETIME (100 ns ticks since 1601-01-01 UTC) for a wall-clock time in milliseconds. */
export function fileTimeOf(epochMilliseconds: number): bigint {
  return (BigInt(Math.floor(epochMilliseconds)) + 11_644_473_600_000n) * 10_000n;
}

const numeric = (value: string | null | undefined): value is string => typeof value === "string" && /^\d+$/.test(value);
const nonBlank = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";

/** Seams for finding and recording processes the recorded tree does not yet show. */
export interface SweepDeps {
  children(pid: number): Promise<readonly ProcessIdentity[]>;
  /** Record a process entry: with an identity (`created`), or with only a PID (`left`, and never stopped). */
  record(fields: { readonly label: string; readonly parentEntry: number; readonly pid: number; readonly identity?: ProcessIdentity; readonly reason?: string }): number;
  /** O-4: whether this executable may belong to the owned operation. */
  allowedExecutable(executable: string, parent: ProcessIdentity): boolean;
  /** Wall clock, in milliseconds, for `stopSentAt`. */
  now(): number;
}

export interface TreeStopDeps {
  entries(): readonly ResourceEntry[];
  update(id: number, patch: { readonly state: ResourceState; readonly reason?: string }): void;
  /** Record the root's current descendants in the intent log. */
  recordDescendants(): Promise<void>;
  inspect(pid: number): Promise<ProcessIdentity | undefined>;
  /** Stop exactly one process. */
  stop(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  readonly exitPolls: number;
  readonly exitPollMs: number;
  /** The orphan sweep. Absent for a phase server, whose descendants `recordDescendants` covers. */
  readonly sweep?: SweepDeps;
}

export type PhaseStopDeps = TreeStopDeps;

/** How deep `entry` sits under `rootEntry` in the recorded parent chain, or `undefined`. */
export function depthUnder(entry: ResourceEntry, rootEntry: number, entries: readonly ResourceEntry[]): number | undefined {
  let depth = 0;
  let current: ResourceEntry | undefined = entry;
  while (current !== undefined) {
    if (current.id === rootEntry) return depth;
    if (current.parentEntry === undefined) return undefined;
    current = entries[current.parentEntry];
    depth += 1;
  }
  return undefined;
}

/** A stopped, verified process whose exit was confirmed: the only kind of parent the sweep starts from (O-1). */
interface ProvenParent {
  readonly entryId: number;
  readonly label: string;
  readonly identity: ProcessIdentity;
  /** Wall clock immediately before its stop was sent. */
  readonly stopSentAt: number;
}

/**
 * Why a sweep candidate cannot be shown to belong to a proven parent (O-2 to O-5), or
 * `undefined` when it can. A command line is never proof of anything.
 */
export function orphanProofProblem(candidate: ProcessIdentity, parent: { readonly identity: ProcessIdentity; readonly stopSentAt: number }, allowedExecutable: (executable: string, parent: ProcessIdentity) => boolean): string | undefined {
  if (candidate.parentPid !== parent.identity.pid) return "its parent PID is not the stopped parent's";
  if (!numeric(candidate.creationTime) || !numeric(parent.identity.creationTime) || !nonBlank(candidate.executable) || !nonBlank(candidate.commandLine)) {
    return "its identity is incomplete, so ownership cannot be shown";
  }
  const created = BigInt(candidate.creationTime);
  if (created <= BigInt(parent.identity.creationTime)) return "it was created before its recorded parent";
  if (created > fileTimeOf(parent.stopSentAt)) return "it was created after its parent's stop was sent, so the parent PID may have been reused";
  if (!allowedExecutable(candidate.executable, parent.identity)) return "its executable is outside the owned set";
  return undefined;
}

/**
 * Stop one recorded tree, deepest first, each process only after `checkProcessIdentity` says
 * `verified`, then run the ownership-proving orphan sweep (amendment A1 §4.1, §4.4).
 *
 * Returns what stayed unresolved; an empty list means everything was stopped and its exit
 * confirmed. Nothing uncertain is ever stopped. An unconfirmed exit sets its entry to `left`
 * with its identity kept, and an uncertain orphan is recorded with only its PID, so final
 * teardown never stops it and keeps every directory it could still use.
 */
export async function stopOwnedTree(rootEntry: number, deps: TreeStopDeps): Promise<readonly string[]> {
  const unresolved: string[] = [];
  try {
    await deps.recordDescendants();
  } catch (error) {
    return [`recording the server's descendants failed (${(error as Error).message}); nothing was stopped`];
  }

  /** Verify, stop and confirm one recorded process. Returns the proven parent on success. */
  const stopOne = async (entry: { readonly id: number; readonly label: string }, recorded: ProcessIdentity): Promise<ProvenParent | undefined> => {
    let live: ProcessIdentity | undefined;
    try {
      live = await deps.inspect(recorded.pid);
    } catch (error) {
      unresolved.push(`${entry.label} could not be inspected (${(error as Error).message})`);
      return undefined;
    }
    const check = checkProcessIdentity(recorded, live);
    if (check.status === "absent") {
      deps.update(entry.id, { state: "absent", reason: check.reason });
      return undefined;
    }
    if (check.status === "mismatch") {
      unresolved.push(`${entry.label} was not stopped: ${check.reason}`);
      return undefined;
    }
    const stopSentAt = deps.sweep?.now() ?? 0;
    try {
      await deps.stop(recorded.pid);
    } catch (error) {
      unresolved.push(`${entry.label} could not be stopped (${(error as Error).message})`);
      return undefined;
    }
    let gone = false;
    for (let poll = 0; poll < deps.exitPolls && !gone; poll += 1) {
      try {
        gone = checkProcessIdentity(recorded, await deps.inspect(recorded.pid)).status === "absent";
      } catch {
        gone = false;
      }
      if (!gone) await deps.sleep(deps.exitPollMs);
    }
    if (!gone) {
      deps.update(entry.id, { state: "left", reason: "its exit could not be confirmed after the stop; its identity is kept for teardown" });
      unresolved.push(`${entry.label}'s exit could not be confirmed`);
      return undefined;
    }
    deps.update(entry.id, { state: "stopped" });
    return { entryId: entry.id, label: entry.label, identity: recorded, stopSentAt };
  };

  const entries = deps.entries();
  const tree = entries
    .map((entry) => ({ entry, depth: depthUnder(entry, rootEntry, entries) }))
    .filter((item): item is { entry: ResourceEntry; depth: number } => item.depth !== undefined && item.entry.state === "created")
    .sort((a, b) => b.depth - a.depth);

  // Every process is verified and stopped before any exit is confirmed, deepest first.
  const proven: ProvenParent[] = [];
  for (const { entry } of tree) {
    if (entry.identity === undefined) {
      unresolved.push(`${entry.label} has no recorded identity`);
      continue;
    }
    const parent = await stopOne(entry, entry.identity);
    if (parent !== undefined) proven.push(parent);
  }

  const sweep = deps.sweep;
  if (sweep === undefined) return unresolved;

  const recorded = (candidate: ProcessIdentity): boolean =>
    deps.entries().some((entry) => (entry.identity !== undefined ? entry.identity.pid === candidate.pid && entry.identity.creationTime === candidate.creationTime : entry.pid === candidate.pid));
  const childrenOf = async (parent: ProvenParent): Promise<readonly ProcessIdentity[] | undefined> => {
    try {
      return (await sweep.children(parent.identity.pid)).filter((candidate) => !recorded(candidate));
    } catch (error) {
      unresolved.push(`the children of ${parent.label} could not be listed (${(error as Error).message})`);
      return undefined;
    }
  };
  const uncertain = (candidate: ProcessIdentity, parent: ProvenParent, reason: string): void => {
    sweep.record({ label: `orphan ${candidate.pid} of ${parent.label} (uncertain)`, parentEntry: parent.entryId, pid: candidate.pid, reason });
    unresolved.push(`orphan ${candidate.pid} of ${parent.label} was not stopped: ${reason}`);
  };

  let parents = proven;
  for (let round = 1; round <= ORPHAN_SWEEP_ROUNDS && parents.length > 0; round += 1) {
    const next: ProvenParent[] = [];
    for (const parent of parents) {
      for (const candidate of (await childrenOf(parent)) ?? []) {
        const problem = orphanProofProblem(candidate, parent, sweep.allowedExecutable);
        if (problem !== undefined) {
          uncertain(candidate, parent, problem);
          continue;
        }
        const label = `orphan ${candidate.pid} of ${parent.label}`;
        const id = sweep.record({ label, parentEntry: parent.entryId, pid: candidate.pid, identity: candidate });
        // O-5: re-verified immediately before its stop, inside `stopOne`.
        const stopped = await stopOne({ id, label }, candidate);
        if (stopped !== undefined) next.push(stopped);
      }
    }
    parents = next;
  }
  for (const parent of parents) {
    for (const candidate of (await childrenOf(parent)) ?? []) uncertain(candidate, parent, `still found after ${ORPHAN_SWEEP_ROUNDS} sweep rounds`);
  }

  return unresolved;
}

/**
 * Stop one phase's server and its recorded descendants (`stopOwnedTree`, without a sweep). If
 * anything is unresolved this throws an `E3Stop`: the run then starts no further phase, and the
 * intent log keeps every unresolved entry for the final owned-resource teardown.
 */
export async function stopPhaseServer(rootEntry: number, deps: PhaseStopDeps): Promise<void> {
  const unresolved = await stopOwnedTree(rootEntry, deps);
  if (unresolved.length > 0) {
    throw new E3Stop(`Stopped (phase shutdown unresolved): ${unresolved.join("; ")}; no further phase was started, and the intent log is kept for teardown`);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Bounded setup steps (amendment A1 §3–§4)                                                       */
/* ------------------------------------------------------------------------------------------- */

export const NPM_CI_DEADLINE_MS = 10 * 60_000;
export const NEXT_BUILD_DEADLINE_MS = 10 * 60_000;
export const CLUSTER_STARTUP_DEADLINE_MS = 3 * 60_000;
export const CLUSTER_SETTLE_MS = 120_000;

/** A started owned process: its intent-log entry and its exit. */
export interface OwnedStep {
  readonly entry: number;
  readonly exited: Promise<number | null>;
}

/** A cancellable timer. */
export interface Timer {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface BoundedStepSeams {
  readonly timeout: (ms: number) => Timer;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** Absolute wall-clock time (ms) at which the whole run's ceiling falls. */
  readonly runDeadline: number;
  /** Record a step's exit. `late` means after its outcome was fixed: noted only, never success. */
  readonly stepExited: (entry: number, code: number | null, late: boolean) => void;
  /** Identity-checked stop of the step's tree with the orphan sweep (`stopOwnedTree`). */
  readonly stopStep: (entry: number) => Promise<readonly string[]>;
}

/** Resolves when the signal aborts; `dispose` removes the listener. */
function abortWatch(signal: AbortSignal): { readonly promise: Promise<void>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    listener = () => resolve();
    signal.addEventListener("abort", listener, { once: true });
  });
  return { promise, dispose: () => listener !== undefined && signal.removeEventListener("abort", listener) };
}

/**
 * One bounded setup step (`npm ci`, `next build`), against an **absolute** deadline: the earlier
 * of `now + deadlineMs` and the run's own deadline, fixed before anything starts.
 *
 * - **Before `start()`:** the abort signal and the remaining time are checked. If either has run
 *   out, nothing is started.
 * - **During `start()`:** the time it takes counts against the same deadline. An inspection inside
 *   `start()` (process identity, through PowerShell) is unbounded (ruling A1-3), so it can delay
 *   this; the deadline is then enforced as soon as `start()` returns.
 * - **After `start()`:** the signal and the deadline are checked again. If startup crossed the
 *   deadline, the recorded owned process is settled and the run stops.
 * - **Before accepting an exit as success:** they are checked again. An exit observed after the
 *   deadline or the abort is late: it is recorded, never treated as success, and the step is
 *   settled.
 *
 * Settling means stopping the step's tree with identity checks and the orphan sweep, then
 * throwing an `E3Stop`, so no later step or phase starts.
 */
export async function runBoundedProcessStep(seams: BoundedStepSeams, label: string, deadlineMs: number, start: () => Promise<OwnedStep>): Promise<void> {
  const deadlineAt = Math.min(seams.now() + deadlineMs, seams.runDeadline);
  const allowance = Math.max(0, deadlineAt - seams.now());
  if (seams.signal.aborted) throw new E3Stop(`Stopped (E-A1 ${label} aborted): the run was aborted before ${label} started; nothing was started`);
  if (seams.now() >= deadlineAt) throw new E3Stop(`Stopped (E-A1 ${label} timeout): no time remained before ${label} would start; nothing was started`);

  const step = await start();
  let fixed = false;
  let observed: { readonly code: number | null } | undefined;
  const exited = step.exited.then((code) => {
    observed = { code };
    if (fixed) seams.stepExited(step.entry, code, true);
    return "exit" as const;
  });
  /** The outcome is fixed: record any exit as late, settle the owned process, and stop the run. */
  const settleAndStop = async (reason: "timeout" | "aborted", detail: string): Promise<never> => {
    fixed = true;
    if (observed !== undefined) seams.stepExited(step.entry, observed.code, true);
    const unresolved = await seams.stopStep(step.entry);
    throw new E3Stop(
      `Stopped (E-A1 ${label} ${reason}): ${detail}; ` +
        (unresolved.length === 0 ? "its processes were stopped and their exits confirmed" : `unresolved: ${unresolved.join("; ")}; the intent log is kept for teardown`),
    );
  };
  const expired = (): "timeout" | "aborted" | undefined => (seams.signal.aborted ? "aborted" : seams.now() >= deadlineAt ? "timeout" : undefined);
  const detailOf = (reason: "timeout" | "aborted", when: string): string => (reason === "timeout" ? `${label} did not finish within ${allowance} ms (${when})` : `${label} was interrupted (${when})`);

  // Startup itself may have crossed the deadline, or the run may have been aborted meanwhile.
  await Promise.resolve();
  const afterStart = expired();
  if (afterStart !== undefined) return settleAndStop(afterStart, detailOf(afterStart, afterStart === "timeout" ? "its startup crossed the deadline" : "the run was aborted during its startup"));

  const timer = seams.timeout(Math.max(0, deadlineAt - seams.now()));
  const aborted = abortWatch(seams.signal);
  const first = await Promise.race([exited, timer.promise.then(() => "timeout" as const), aborted.promise.then(() => "aborted" as const)]);
  timer.cancel();
  aborted.dispose();

  if (first === "exit") {
    // An exit counts as success only if it arrived before the deadline and without an abort.
    const late = expired();
    if (late !== undefined) return settleAndStop(late, detailOf(late, "its exit arrived after the deadline"));
    const code = (observed as { code: number | null }).code;
    seams.stepExited(step.entry, code, false);
    if (code !== 0) throw new E3Stop(`Stopped (E-A1): ${label} exited ${String(code)}`);
    return;
  }
  return settleAndStop(first, detailOf(first, first === "timeout" ? "the deadline passed" : "the run was aborted"));
}

/** The refusal a cluster callback entered after its startup deadline throws, before any SQL. */
export const LATE_CLUSTER_CALLBACK = "Stopped (L-1): cluster startup completed after its deadline";

/** The handle a gated callback sees: `connectSuperuser` refuses once the gate has closed. */
export function gateClusterHandle(handle: E3ClusterHandle, gate: { readonly open: boolean }): E3ClusterHandle {
  return {
    ...handle,
    connectSuperuser: () => {
      if (!gate.open) throw new E3Stop(LATE_CLUSTER_CALLBACK);
      return handle.connectSuperuser();
    },
  };
}

export interface ClusterStartupSeams extends Pick<BoundedStepSeams, "timeout" | "signal" | "now" | "runDeadline"> {
  readonly withCluster: <T>(body: (cluster: E3ClusterHandle) => Promise<T>) => Promise<T>;
  /** Find, record and stop the owned startup children (`interruptClusterStartup`). Returns what stayed unresolved. */
  readonly interruptClusterStartup: () => Promise<readonly string[]>;
  /** Record the cluster entry as `left`: the helper did not settle in time. */
  readonly markClusterUnsettled: (reason: string) => void;
}

const isCleanupFailure = (error: unknown): boolean => error instanceof AggregateError || (error as Error | undefined)?.name === "ClusterCleanupError";

/**
 * Cluster startup against an **absolute** deadline: the earlier of `now +
 * CLUSTER_STARTUP_DEADLINE_MS` and the run's own (amendment A1 §4.2–§4.3).
 *
 * **The callback checks the clock itself.** At entry, before it cancels the startup timer, checks
 * the listener or permits any SQL, it checks the abort signal and the absolute deadline. A
 * callback that arrives late is refused even if the timer callback has not run yet, and the gate
 * closes for good, so `connectSuperuser` refuses too. The gate records entry only after that check
 * passes, so an expired deadline is never overridden by it.
 *
 * **If the deadline or the abort comes first,** the owned startup children are stopped, and the
 * helper is given `CLUSTER_SETTLE_MS` to settle. If it does not, the cluster entry is recorded as
 * `left`.
 */
export async function runBoundedClusterStartup<T>(seams: ClusterStartupSeams, body: (cluster: E3ClusterHandle) => Promise<T>): Promise<T> {
  const deadlineAt = Math.min(seams.now() + CLUSTER_STARTUP_DEADLINE_MS, seams.runDeadline);
  const allowance = Math.max(0, deadlineAt - seams.now());
  if (seams.signal.aborted) throw new E3Stop("Stopped (L-1 aborted): the run was aborted before cluster startup; nothing was started");
  if (seams.now() >= deadlineAt) throw new E3Stop("Stopped (L-1 timeout): no time remained before cluster startup; nothing was started");

  /** `pending` until the callback either enters in time or the gate closes; never reopens. */
  const gate = { open: true, state: "pending" as "pending" | "entered" | "closed" };
  const close = (): void => {
    gate.open = false;
    gate.state = "closed";
  };
  const timer = seams.timeout(allowance);
  const aborted = abortWatch(seams.signal);
  const stopWatching = (): void => {
    timer.cancel();
    aborted.dispose();
  };

  const run = seams.withCluster(async (handle) => {
    // First, before anything else: the gate, the abort and the absolute deadline.
    if (gate.state === "closed" || seams.signal.aborted || seams.now() >= deadlineAt) {
      close();
      throw new E3Stop(LATE_CLUSTER_CALLBACK);
    }
    gate.state = "entered";
    stopWatching();
    return body(gateClusterHandle(handle, gate));
  });
  type Outcome = { readonly kind: "settled"; readonly ok: true; readonly value: T } | { readonly kind: "settled"; readonly ok: false; readonly error: unknown } | { readonly kind: "timeout" | "aborted" };
  const outcome: Outcome = await Promise.race([
    run.then(
      (value): Outcome => ({ kind: "settled", ok: true, value }),
      (error: unknown): Outcome => ({ kind: "settled", ok: false, error }),
    ),
    timer.promise.then((): Outcome => ({ kind: "timeout" })),
    aborted.promise.then((): Outcome => ({ kind: "aborted" })),
  ]);

  if (outcome.kind === "settled") {
    stopWatching();
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }
  // The callback passed its own deadline and abort check before the timer was observed here, so
  // startup completed in time; the body runs on under its own checks.
  if (gate.state === "entered") return run;

  close();
  stopWatching();
  const unresolved = [...(await seams.interruptClusterStartup())];
  const settle = seams.timeout(CLUSTER_SETTLE_MS);
  let helperError: unknown;
  const settled = await Promise.race([
    run.then(
      () => "settled" as const,
      (error: unknown) => {
        helperError = error;
        return "settled" as const;
      },
    ),
    settle.promise.then(() => "pending" as const),
  ]);
  settle.cancel();
  if (settled === "pending") {
    seams.markClusterUnsettled(`the cluster helper did not settle within ${CLUSTER_SETTLE_MS} ms after startup was ${outcome.kind === "timeout" ? "timed out" : "interrupted"}; its root and parent may still be in use and are preserved`);
    unresolved.push(`the cluster helper did not settle within ${CLUSTER_SETTLE_MS} ms`);
  } else if (isCleanupFailure(helperError)) {
    unresolved.push(`the cluster helper's cleanup did not complete (${(helperError as Error).message})`);
  }
  throw new E3Stop(
    `Stopped (L-1 ${outcome.kind}): cluster startup ${outcome.kind === "timeout" ? `did not reach the callback within ${allowance} ms` : "was interrupted"}; ` +
      (unresolved.length === 0 ? "the startup processes were stopped and the helper settled" : `unresolved: ${unresolved.join("; ")}; the affected directories are preserved`),
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Interrupting cluster startup (amendment A1 §4.2)                                               */
/* ------------------------------------------------------------------------------------------- */

export interface ClusterInterruptDeps {
  /** The recorded cluster directory, or `undefined` if it was never located. */
  readonly clusterDirectory: string | undefined;
  readonly harnessPid: number;
  children(pid: number): Promise<readonly ProcessIdentity[]>;
  /** The bundled binary's path, or `undefined` when it cannot be resolved. */
  bundledBinary(name: "initdb" | "postgres"): string | undefined;
  samePath(a: string, b: string): boolean;
  record(fields: { readonly label: string; readonly pid: number; readonly identity?: ProcessIdentity; readonly reason?: string }): number;
  update(id: number, patch: { readonly state: ResourceState; readonly reason?: string }): void;
  note(message: string, entry?: number): void;
  /** `postmaster.pid` evidence, by the helper's own proof (`readPidFileEvidence`). */
  pidFileEvidence(clusterDirectory: string): PidFileEvidence;
  inspect(pid: number): Promise<ProcessIdentity | undefined>;
  /** `requestCompleteShutdown`: `pg_ctl stop -m fast -w -t 30 -D <dir>`, outer bound 30 s, kills nothing. */
  requestShutdown(clusterDirectory: string): Promise<{ readonly ok: boolean; readonly timedOut: boolean; readonly detail: string }>;
  /** `stopOwnedTree` for a recorded startup child, with the sweep. */
  stopTree(entry: number): Promise<readonly string[]>;
}

/** Windows command-line tokens, honouring double quotes. */
export function commandLineTokens(commandLine: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const character of commandLine) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(character) && !quoted) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The data directory a startup child's arguments name: `--pgdata=<dir>` (initdb) or `-D <dir>` (postgres). */
export function dataDirectoryArgument(kind: "initdb" | "postgres", commandLine: string): string | undefined {
  const tokens = commandLineTokens(commandLine);
  if (kind === "initdb") return tokens.find((token) => token.startsWith("--pgdata="))?.slice("--pgdata=".length);
  const at = tokens.indexOf("-D");
  return at < 0 ? undefined : tokens[at + 1];
}

/**
 * Find, record and stop the cluster helper's owned startup children (amendment A1 §4.2).
 *
 * A child counts only if it is the harness's own child, its executable is exactly the bundled
 * `initdb` or `postgres`, and its parsed arguments name the recorded cluster directory as a
 * value. A child with an incomplete identity is recorded as uncertain and never stopped.
 * `postgres` is shut down with `pg_ctl` **only** after both existing proofs: `postmaster.pid`
 * proven for the recorded directory, naming the recorded child, whose live identity verifies.
 * An unproven `pg_ctl` outcome is recorded, with the fact that its PID is unavailable, and left
 * unresolved; nothing is killed in its place.
 */
export async function interruptClusterStartup(deps: ClusterInterruptDeps): Promise<readonly string[]> {
  const directory = deps.clusterDirectory;
  if (directory === undefined) return ["the cluster directory was never recorded, so no startup process can be attributed to it"];
  let candidates: readonly ProcessIdentity[];
  try {
    candidates = await deps.children(deps.harnessPid);
  } catch (error) {
    return [`the harness's child processes could not be listed (${(error as Error).message})`];
  }

  const unresolved: string[] = [];
  const owned: { readonly kind: "initdb" | "postgres"; readonly id: number; readonly identity: ProcessIdentity }[] = [];
  for (const candidate of candidates) {
    if (candidate.parentPid !== deps.harnessPid || !nonBlank(candidate.executable)) continue;
    const kind = (["initdb", "postgres"] as const).find((name) => {
      const binary = deps.bundledBinary(name);
      return binary !== undefined && deps.samePath(candidate.executable as string, binary);
    });
    if (kind === undefined) continue;
    const named = nonBlank(candidate.commandLine) ? dataDirectoryArgument(kind, candidate.commandLine) : undefined;
    if (named === undefined || !deps.samePath(named, directory)) continue;
    if (!numeric(candidate.creationTime)) {
      deps.record({ label: `cluster startup ${kind} ${candidate.pid} (uncertain)`, pid: candidate.pid, reason: "its identity is incomplete, so it cannot be verified" });
      unresolved.push(`${kind} ${candidate.pid} was not stopped: its identity is incomplete`);
      continue;
    }
    owned.push({ kind, id: deps.record({ label: `cluster startup ${kind} ${candidate.pid}`, pid: candidate.pid, identity: candidate }), identity: candidate });
  }

  for (const child of owned.filter((c) => c.kind === "postgres")) {
    const evidence = deps.pidFileEvidence(directory);
    const leave = (reason: string): void => {
      deps.update(child.id, { state: "left", reason });
      unresolved.push(`postgres ${child.identity.pid}: ${reason}`);
    };
    if (evidence.status === "proven") {
      if (evidence.pid !== child.identity.pid) {
        leave(`postmaster.pid names pid ${evidence.pid}, not the recorded postgres child; pg_ctl was not run`);
        continue;
      }
      let live: ProcessIdentity | undefined;
      try {
        live = await deps.inspect(child.identity.pid);
      } catch (error) {
        leave(`its identity could not be inspected (${(error as Error).message}); pg_ctl was not run`);
        continue;
      }
      const check = checkProcessIdentity(child.identity, live);
      if (check.status === "absent") {
        deps.update(child.id, { state: "absent", reason: check.reason });
        continue;
      }
      if (check.status !== "verified") {
        leave(`${check.reason}; pg_ctl was not run`);
        continue;
      }
      deps.note(`pg_ctl stop -m fast requested for the owned cluster directory; postmaster pid ${child.identity.pid} proven and verified`, child.id);
      const outcome = await deps.requestShutdown(directory);
      if (!outcome.ok) {
        const reason = `pg_ctl stop ${outcome.timedOut ? "did not complete within its bound" : "failed"} (${outcome.detail}); complete shutdown is unproven; the pg_ctl process was not stopped and its PID is unavailable`;
        deps.note(`pg_ctl stop outcome: unresolved. ${reason}`, child.id);
        leave(reason);
        continue;
      }
      deps.note("pg_ctl stop outcome: PostgreSQL reported a complete shutdown of the owned cluster", child.id);
      unresolved.push(...(await deps.stopTree(child.id)));
    } else if (evidence.status === "missing") {
      // No postmaster.pid yet: an identity-checked stop of the child itself, then the sweep.
      unresolved.push(...(await deps.stopTree(child.id)));
    } else {
      leave(`postmaster.pid is ${evidence.status} (${evidence.detail}); pg_ctl was not run and the child was not stopped`);
    }
  }

  for (const child of owned.filter((c) => c.kind === "initdb")) unresolved.push(...(await deps.stopTree(child.id)));
  return unresolved;
}

/* ------------------------------------------------------------------------------------------- */
/* The exit code                                                                                  */
/* ------------------------------------------------------------------------------------------- */

/**
 * `2` for a refusal before anything was created; `0` only when normal acceptance passed and
 * zero residue was established; `1` otherwise. E-A4b never affects it.
 */
export function e3ExitCode(report: Pick<E3Report, "acceptancePassed"> | undefined, safety: Pick<FinalSafety, "zeroResidue"> | undefined, refused = false): 0 | 1 | 2 {
  if (refused) return 2;
  return report?.acceptancePassed === true && safety?.zeroResidue === true ? 0 : 1;
}

/* ------------------------------------------------------------------------------------------- */
/* Final safety: teardown, then independent residue checks                                        */
/* ------------------------------------------------------------------------------------------- */

export interface FinalSafetyInput {
  readonly teardown: () => Promise<TeardownReport>;
  readonly entries: () => readonly ResourceEntry[];
  /** The independent residue checks (`residueOf`): process identities, paths, ports, worktree records, repository state. */
  readonly residue: (entries: readonly ResourceEntry[]) => Promise<readonly string[]>;
}

export interface FinalSafety {
  readonly teardown?: TeardownReport;
  readonly problems: readonly string[];
  /** True only when teardown, the intent log and the independent residue checks all show nothing left. */
  readonly zeroResidue: boolean;
}

/** Teardown, then the independent residue checks. Zero residue is never inferred from the teardown summary alone. */
export async function e3FinalSafety(input: FinalSafetyInput): Promise<FinalSafety> {
  const problems: string[] = [];
  let report: TeardownReport | undefined;
  try {
    report = await input.teardown();
  } catch (error) {
    problems.push(`teardown failed: ${(error as Error).message}`);
  }
  for (const left of report?.left ?? []) problems.push(`teardown left entry ${left.id}: ${left.reason}`);
  if (report?.allowanceExhausted === true) problems.push("the teardown allowance was exhausted");
  const entries = input.entries();
  for (const entry of entries) {
    if (entry.state === "left" || entry.state === "created" || entry.state === "intended") problems.push(`the intent log shows ${entry.label} as ${entry.state}`);
  }
  try {
    problems.push(...(await input.residue(entries)).map((item) => `residue: ${item}`));
  } catch (error) {
    problems.push(`the residue inspection failed, so zero residue is not established: ${(error as Error).message}`);
  }
  return { ...(report === undefined ? {} : { teardown: report }), problems, zeroResidue: problems.length === 0 };
}

/* ------------------------------------------------------------------------------------------- */
/* Redaction                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export const REDACTED = "[redacted]";

/** Replace each value, and its percent-encoded spelling, with `[redacted]`. Longest first. */
export function createRedactor(values: readonly (string | undefined)[]): (text: string) => string {
  const spellings = [...new Set(values.filter((value): value is string => value !== undefined && value.length >= 8).flatMap((value) => [value, encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  return (text) => spellings.reduce((current, spelling) => current.split(spelling).join(REDACTED), text);
}

/** Every string in a JSON-shaped value, redacted. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === "string" ? redact(item) : item)) as T;
}

/* ------------------------------------------------------------------------------------------- */
/* The run                                                                                        */
/* ------------------------------------------------------------------------------------------- */

export interface E3ClusterHandle {
  /** The port the launcher chose for the cluster it created (L-1). */
  readonly port: number;
  /** From `postmaster.pid`, proven against the created directory, with its live identity (L-2). */
  readonly postmaster: RecordedProcess;
  readonly clusterDirectory: string;
  /** The superuser operations. Called only after L-3; opens nothing until their first statement. */
  connectSuperuser(): SuperuserOps;
}

export interface AppServer {
  readonly port: number;
  readonly server: RecordedProcess;
  /** Throws an `E3Stop` when the shutdown cannot be shown complete (`stopPhaseServer`). */
  stop(): Promise<void>;
}

export interface E3Secrets {
  readonly role: string;
  readonly password: string;
  readonly marker: string;
}

export interface E3RunSeams extends BoundedStepSeams, ClusterStartupSeams {
  /** Disposable worktree at the authorized commit. Git calls are unbounded (amendment A1 §6, ruling A1-3). */
  readonly prepareWorktree: () => Promise<void>;
  /** Start `npm ci` in the worktree as a recorded owned process. */
  readonly startInstall: () => Promise<OwnedStep>;
  /** Start `next build` with exactly the given environment as a recorded owned process. */
  readonly startBuild: (environment: Readonly<Record<string, string>>) => Promise<OwnedStep>;
  /** Create the cluster with `E3_CLUSTER_REQUEST` (no database, no migration), run the body, then shut it down. */
  readonly withCluster: <T>(body: (cluster: E3ClusterHandle) => Promise<T>) => Promise<T>;
  /** `next start` on a free loopback port with exactly the given extra environment. */
  readonly startApp: (phase: E3Phase, environment: Readonly<Record<string, string>>) => Promise<AppServer>;
  readonly send: (port: number, method: "GET" | "OPTIONS", path: string) => Promise<E3Exchange>;
  readonly inspections: E3Inspections;
  /** The files to scan, read after the servers have stopped and before teardown. */
  readonly scanItems: () => Promise<{ readonly staticAssets: readonly ScannedItem[]; readonly otherBuildFiles: readonly ScannedItem[]; readonly logs: readonly ScannedItem[] }>;
  readonly fixtures: E3Fixtures;
  readonly secrets: E3Secrets;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly note: (message: string) => void;
}

export interface PhaseRecord {
  readonly phase: E3Phase;
  readonly requests: readonly { readonly label: string; readonly method: string; readonly path: string; readonly status: number | null; readonly location?: string; readonly problems: readonly string[] }[];
}

export interface FaultInjectionResult {
  /** E-A4b's own result. It never changes `acceptancePassed` (ruling S-7). */
  readonly result: "pass" | "fail";
  readonly observed: readonly { readonly label: string; readonly status: number | null }[];
  readonly problems: readonly string[];
}

export interface E3Report {
  /** True only when every normal-sequence check, scan and stored-state check passed. */
  readonly acceptancePassed: boolean;
  readonly stops: readonly string[];
  readonly problems: readonly string[];
  readonly phases: readonly PhaseRecord[];
  readonly equivalence?: EquivalenceResult;
  /** E-A4b, reported separately; absent when it did not run. */
  readonly faultInjection?: FaultInjectionResult;
  readonly scans?: { readonly staticPrefixHits: readonly string[]; readonly leakHits: readonly { readonly where: string; readonly label: string }[] };
  readonly evidence: { readonly port?: number; readonly systemIdentifier?: string; readonly dataDirectory?: string; readonly marker?: string };
  readonly attempts: readonly E3Attempt[];
  readonly attemptLimit: number;
}

/** The app-role connection URL. Never written to any report or console line. */
export function appDatabaseUrl(secrets: E3Secrets, port: number): string {
  return `postgresql://${secrets.role}:${secrets.password}@127.0.0.1:${port}/${E3_DATABASE}`;
}

/** The environment of each `next start` phase. */
export function phaseEnvironment(phase: "E-A2" | "E-A3" | "E-A4", values: { readonly url: string; readonly systemIdentifier: string; readonly marker: string }): Record<string, string> {
  const base = {
    BI4_E3_DATABASE_URL: values.url,
    BI4_E3_EXPECTED_SYSTEM_IDENTIFIER: values.systemIdentifier,
    BI4_E3_EXPECTED_DATABASE: E3_DATABASE,
    BI4_E3_SYNTHETIC_MARKER: values.marker,
  };
  if (phase === "E-A2") return base; // every value but the flag
  if (phase === "E-A3") return { ...base, BI4_E3_LOCAL: "1", BI4_E3_EXPECTED_SYSTEM_IDENTIFIER: values.systemIdentifier === "1" ? "2" : "1" };
  return { ...base, BI4_E3_LOCAL: "1" };
}

/** The build's environment check: no mode variable and no database URL, by name or by value. */
export function buildEnvironmentProblems(environment: Readonly<Record<string, string>>): readonly string[] {
  return Object.keys(environment)
    .filter((name) => name.startsWith("BI4_E3_") || /DATABASE_URL/i.test(name) || /^postgres(ql)?:/i.test(environment[name] as string))
    .map((name) => `the build environment carries ${name}`);
}

const messageOf = (error: unknown): string => (error instanceof E3Stop ? error.message : `Stopped (setup or run): ${(error as Error).message}`);

/**
 * The acceptance run. Returns its report, already redacted of the app-role password and URL.
 * Owned-resource teardown and the residue checks are the caller's (`e3FinalSafety`), after this
 * returns.
 */
export async function runE3Check(seams: E3RunSeams, buildEnvironment: Readonly<Record<string, string>>): Promise<E3Report> {
  const budget = createE3Budget(E3_REQUEST_CAP);
  const stops: string[] = [];
  const problems: string[] = [];
  const phases: PhaseRecord[] = [];
  const responses: ScannedItem[] = [];
  const evidence: { port?: number; systemIdentifier?: string; dataDirectory?: string; marker?: string } = {};
  let equivalence: EquivalenceResult | undefined;
  let faultInjection: FaultInjectionResult | undefined;
  let scans: E3Report["scans"];
  let appUrl: string | undefined;
  let built = false;

  const sendCharged = async (phase: E3Phase, kind: E3Attempt["kind"], port: number, method: "GET" | "OPTIONS", path: string): Promise<E3Exchange | undefined> => {
    if (seams.signal.aborted) throw new E3Stop("Stopped (aborted)");
    if (budget.remaining() <= 0) throw new E3Stop(`Stopped (cap): the ${budget.limit}-attempt HTTP budget is spent`);
    try {
      const exchange = await seams.send(port, method, path);
      budget.charge({ phase, kind, method, path, outcome: `status ${exchange.status}` });
      return exchange;
    } catch (error) {
      budget.charge({ phase, kind, method, path, outcome: (error as Error).message });
      return undefined;
    }
  };

  /** Readiness: the owned listener first (no HTTP while unbound), then a probe, every probe charged. */
  const waitReady = async (phase: E3Phase, app: AppServer): Promise<void> => {
    const deadline = seams.now() + READINESS_BOUND_MS;
    while (seams.now() < deadline) {
      if ((await checkAppListener(app.port, app.server, seams.inspections)) === "unbound") {
        await seams.sleep(READINESS_POLL_MS);
        continue;
      }
      const exchange = await sendCharged(phase, "readiness", app.port, "GET", READINESS_PATH);
      if (exchange?.status === 200) return;
      await seams.sleep(READINESS_POLL_MS);
    }
    throw new E3Stop(`Stopped (readiness): ${phase}'s server was not ready within ${READINESS_BOUND_MS} ms`);
  };

  const runRequests = async (phase: E3Phase, app: AppServer): Promise<Observed[]> => {
    const observed: Observed[] = [];
    const record: PhaseRecord["requests"][number][] = [];
    phases.push({ phase, requests: record });
    for (const request of e3Requests(phase, seams.fixtures)) {
      const exchange = await sendCharged(phase, "request", app.port, request.method, request.path);
      if (exchange === undefined) {
        record.push({ label: request.label, method: request.method, path: request.path, status: null, problems: ["the request failed in transport"] });
        continue;
      }
      responses.push(exchangeItem(`${phase} ${request.label}`, exchange));
      observed.push({ request, exchange });
      const location = headerValues(exchange.rawHeaders, "location")[0];
      record.push({ label: request.label, method: request.method, path: request.path, status: exchange.status, ...(location === undefined ? {} : { location }), problems: exchangeProblems(request, exchange, seams.fixtures) });
    }
    return observed;
  };

  /**
   * One phase. The server is always asked to stop. If its shutdown is unresolved, that is a stop:
   * the next phase never starts. When the phase itself also failed, both are reported.
   */
  const runPhase = async (phase: "E-A2" | "E-A3" | "E-A4", cluster: E3ClusterHandle, environment: Record<string, string>, afterRequests?: (app: AppServer, observed: readonly Observed[]) => Promise<void>): Promise<void> => {
    await verifyDatabaseListener(cluster.port, cluster.postmaster, seams.inspections, `before ${phase} next start`);
    const app = await seams.startApp(phase, environment);
    let failure: unknown;
    try {
      await waitReady(phase, app);
      await verifyDatabaseListener(cluster.port, cluster.postmaster, seams.inspections, `${phase} handoff`);
      await verifyAppListenerNow(app.port, app.server, seams.inspections);
      const observed = await runRequests(phase, app);
      await verifyDatabaseListener(cluster.port, cluster.postmaster, seams.inspections, `after ${phase}'s last request`);
      if (afterRequests !== undefined) await afterRequests(app, observed);
    } catch (error) {
      failure = error;
    }
    try {
      await app.stop();
    } catch (stopError) {
      if (failure === undefined) throw stopError;
      stops.push(messageOf(stopError));
    }
    if (failure !== undefined) throw failure;
  };

  try {
    // E-A1: before any cluster exists, with no mode variable and no database URL.
    const environmentProblems = buildEnvironmentProblems(buildEnvironment);
    if (environmentProblems.length > 0) throw new E3Stop(`Stopped (build environment): ${environmentProblems.join("; ")}`);
    await seams.prepareWorktree();
    // Bounded: a timeout or abort stops the step's tree, and no later step or phase starts.
    await runBoundedProcessStep(seams, "npm ci", NPM_CI_DEADLINE_MS, () => seams.startInstall());
    await runBoundedProcessStep(seams, "next build", NEXT_BUILD_DEADLINE_MS, () => seams.startBuild(buildEnvironment));
    built = true;
    seams.note("E-A1: next build succeeded with no database and no E3 runtime configuration");

    // Bounded and gated: a callback entered after the startup deadline throws before L-3.
    await runBoundedClusterStartup(seams, async (cluster) => {
      evidence.port = cluster.port;
      // L-3: before the run's first network SQL statement. The helper was asked for no database,
      // so it has sent none; only initdb's bootstrap and the server start have run.
      await verifyDatabaseListener(cluster.port, cluster.postmaster, seams.inspections, "L-3, before any network SQL");

      // L-4: the first network SQL, over 127.0.0.1 on the harness-owned port.
      const superuser = cluster.connectSuperuser();
      await superuser.createDatabase();
      await superuser.migrate();
      await superuser.loadFixtures(seams.fixtures);
      const before = await superuser.verifyStoredStates(seams.fixtures);
      if (before.length > 0) throw new E3Stop(`Stopped (stored state before requests): ${before.join("; ")}`);
      const systemIdentifier = await superuser.systemIdentifier();
      const dataDirectory = await superuser.dataDirectory();
      evidence.systemIdentifier = systemIdentifier;
      evidence.dataDirectory = dataDirectory;
      if (dataDirectory.replace(/\\/g, "/").toLowerCase() !== cluster.clusterDirectory.replace(/\\/g, "/").toLowerCase()) {
        throw new E3Stop("Stopped (identity): the server's data_directory is not the created cluster directory");
      }
      await superuser.setMarker(seams.secrets.marker);
      evidence.marker = seams.secrets.marker;
      await superuser.run(e3LocalRoleSetupStatements({ database: E3_DATABASE, role: seams.secrets.role, password: seams.secrets.password }));
      appUrl = appDatabaseUrl(seams.secrets, cluster.port);
      const values = { url: appUrl, systemIdentifier, marker: seams.secrets.marker };

      await runPhase("E-A2", cluster, phaseEnvironment("E-A2", values));
      await runPhase("E-A3", cluster, phaseEnvironment("E-A3", values));
      await runPhase("E-A4", cluster, phaseEnvironment("E-A4", values), async (app, verified) => {
        // The normal sequence's comparison is settled before any fault is injected.
        equivalence = compareE3Equivalence(verified);

        // E-A4b: deliberate fault injection, on the same verified server. Its failure is its own
        // result and never fails the normal acceptance; a listener stop afterwards still stops.
        let incomplete: string | undefined;
        try {
          await superuser.setMarker(`bi4-e3-synthetic:${"0".repeat(32)}`);
          await superuser.terminateAppSessions(seams.secrets.role);
          await runRequests("E-A4b", app);
        } catch (error) {
          incomplete = (error as Error).message;
        }
        const record = phases.find((p) => p.phase === "E-A4b");
        const observed = (record?.requests ?? []).map((r) => ({ label: r.label, status: r.status }));
        const injectionProblems = [
          ...(record?.requests ?? []).flatMap((r) => r.problems.map((p) => `${r.label}: ${p}`)),
          ...(incomplete === undefined ? [] : [`the fault injection did not complete: ${incomplete}`]),
          ...(observed.length === e3Requests("E-A4b", seams.fixtures).length ? [] : [`${observed.length} of ${e3Requests("E-A4b", seams.fixtures).length} injected requests were observed`]),
        ];
        faultInjection = { result: injectionProblems.length === 0 ? "pass" : "fail", observed, problems: injectionProblems };
        await verifyDatabaseListener(cluster.port, cluster.postmaster, seams.inspections, "after E-A4b");
      });

      // E-A5: stored states, while the database is up.
      const after = await superuser.verifyStoredStates(seams.fixtures);
      if (after.length > 0) problems.push(`stored state after requests: ${after.join("; ")}`);
    });
  } catch (error) {
    stops.push(messageOf(error));
  }

  // The scans, once the servers have stopped and before teardown removes the worktree.
  if (built) {
    try {
      const items = await seams.scanItems();
      const values: SensitiveValue[] = [
        ...(appUrl === undefined ? [] : [{ label: "app database URL", value: appUrl }]),
        { label: "app role password", value: seams.secrets.password },
        { label: "synthetic marker", value: seams.secrets.marker },
        { label: "app role name", value: seams.secrets.role },
        ...(evidence.systemIdentifier === undefined ? [] : [{ label: "system identifier", value: evidence.systemIdentifier }]),
        ...(evidence.dataDirectory === undefined ? [] : [{ label: "data directory", value: evidence.dataDirectory }]),
      ];
      scans = {
        staticPrefixHits: prefixHits(items.staticAssets),
        leakHits: leakHits([...items.staticAssets, ...items.otherBuildFiles, ...items.logs, ...responses], values),
      };
    } catch (error) {
      stops.push(`Stopped (scan): ${(error as Error).message}`);
    }
  }

  for (const phase of phases.filter((p) => p.phase !== "E-A4b")) {
    for (const request of phase.requests) for (const problem of request.problems) problems.push(`${phase.phase} ${request.label}: ${problem}`);
  }
  if (equivalence !== undefined) problems.push(...equivalence.problems.map((p) => `E-A4 equivalence: ${p}`));
  if (scans !== undefined) {
    problems.push(...scans.staticPrefixHits.map((where) => `client asset names a mode variable: ${where}`));
    problems.push(...scans.leakHits.map((hit) => `${hit.label} found in ${hit.where}`));
  }
  const expectedPhases: readonly E3Phase[] = ["E-A2", "E-A3", "E-A4"];
  for (const phase of expectedPhases) if (!phases.some((p) => p.phase === phase)) problems.push(`${phase} did not run`);

  const report: E3Report = {
    acceptancePassed: stops.length === 0 && problems.length === 0 && scans !== undefined,
    stops,
    problems,
    phases,
    ...(equivalence === undefined ? {} : { equivalence }),
    ...(faultInjection === undefined ? {} : { faultInjection }),
    ...(scans === undefined ? {} : { scans }),
    evidence,
    attempts: budget.attempts(),
    attemptLimit: budget.limit,
  };
  // Headers, statuses and exception messages can carry anything a server or driver chose to say.
  return redactDeep(report, createRedactor([seams.secrets.password, appUrl, evidence.port === undefined ? undefined : appDatabaseUrl(seams.secrets, evidence.port)]));
}

/** E-A4b's line, wherever the result is shown. */
export function faultInjectionLine(report: E3Report): string {
  const result = report.faultInjection;
  if (result === undefined) return "E-A4b fault injection (separate from normal acceptance): NOT RUN";
  const observed = result.observed.map((o) => o.status ?? "transport failure").join(", ");
  return `E-A4b fault injection (separate from normal acceptance): ${result.result.toUpperCase()}; observed ${observed === "" ? "nothing" : observed}`;
}

/** The console lines for a finished run. Built from the redacted report; the caller redacts again. */
export function e3ConsoleLines(report: E3Report, safety: readonly string[]): readonly string[] {
  return [
    `e3-check: normal acceptance ${report.acceptancePassed ? "PASSED" : "FAILED"}; ${report.attempts.length} of ${report.attemptLimit} HTTP attempts`,
    ...report.stops,
    faultInjectionLine(report),
    safety.length === 0 ? "Teardown: zero residue by the independent checks" : `Teardown: NOT clean (${safety.length} finding(s))`,
    ...safety,
  ];
}

/** The Markdown report. It carries no password and no URL. */
export function renderE3Report(report: E3Report, header: Readonly<Record<string, string>>): string {
  const lines = ["# BI-4 E3-local acceptance run (issue #246)", ""];
  for (const [key, value] of Object.entries(header)) lines.push(`- **${key}:** ${value}`);
  lines.push(
    `- **Normal acceptance:** ${report.acceptancePassed ? "PASSED" : "FAILED"}`,
    `- **${faultInjectionLine(report)}**`,
    `- **HTTP attempts:** ${report.attempts.length} of ${report.attemptLimit}`,
    "",
    "Wire statuses below were read from direct responses under `next start`; redirects were not followed.",
    "",
  );
  if (report.stops.length > 0) lines.push("## Stops", "", ...report.stops.map((s) => `- ${s}`), "");
  for (const phase of report.phases.filter((p) => p.phase !== "E-A4b")) {
    lines.push(`## ${phase.phase}`, "", "| Request | Method | Status | Problems |", "|---|---|---|---|");
    for (const r of phase.requests) lines.push(`| ${r.label} | ${r.method} | ${r.status ?? "transport failure"}${r.location === undefined ? "" : ` → ${r.location}`} | ${r.problems.length === 0 ? "none" : r.problems.join("; ")} |`);
    lines.push("");
  }
  if (report.equivalence !== undefined) {
    lines.push("## E-A4 equivalence set", "", "| Member | Status | Masked body SHA-256 | Own-UUID replacements | Header list SHA-256 | Date |", "|---|---|---|---|---|---|");
    for (const s of report.equivalence.signatures) lines.push(`| ${s.label} | ${s.status} | \`${s.body}\` | ${s.replacements} | \`${s.headers}\` | ${s.date} |`);
    lines.push("", report.equivalence.problems.length === 0 ? "No difference." : report.equivalence.problems.map((p) => `- ${p}`).join("\n"), "");
  }
  lines.push(`## E-A4b fault injection: ${report.faultInjection === undefined ? "NOT RUN" : report.faultInjection.result.toUpperCase()}`, "", "Reported separately; this result never changes the normal acceptance result.", "");
  if (report.faultInjection !== undefined) {
    for (const o of report.faultInjection.observed) lines.push(`- ${o.label}: observed status ${o.status ?? "transport failure"}`);
    for (const p of report.faultInjection.problems) lines.push(`- Problem: ${p}`);
    lines.push("");
  }
  if (report.scans !== undefined) {
    lines.push("## Leak scans", "", `- Client assets naming \`BI4_E3_\`: ${report.scans.staticPrefixHits.length}`, `- Sensitive values found: ${report.scans.leakHits.length}`, "");
    for (const hit of report.scans.leakHits) lines.push(`  - ${hit.label} in ${hit.where}`);
  }
  if (report.problems.length > 0) lines.push("## Problems", "", ...report.problems.map((p) => `- ${p}`), "");
  lines.push("The app-role password and connection URL were passed only in the server process's environment and are redacted wherever they would otherwise appear.", "");
  return lines.join("\n");
}
