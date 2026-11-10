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
import { checkProcessIdentity, type ListeningEntry, type ProcessIdentity, type ResourceEntry, type ResourceState, type TeardownReport } from "./isolation";
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
/* Stopping a phase's server (full process-identity checks)                                       */
/* ------------------------------------------------------------------------------------------- */

export interface PhaseStopDeps {
  entries(): readonly ResourceEntry[];
  update(id: number, patch: { readonly state: ResourceState; readonly reason?: string }): void;
  /** Record the server's current descendants in the intent log. */
  recordDescendants(): Promise<void>;
  inspect(pid: number): Promise<ProcessIdentity | undefined>;
  /** Stop exactly one process. */
  stop(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  readonly exitPolls: number;
  readonly exitPollMs: number;
}

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

/**
 * Stop one phase's server and its recorded descendants, deepest first, each only after the full
 * identity check (`checkProcessIdentity`: PID, creation time, executable and command line) says
 * `verified`. A mismatch is never stopped. If recording the descendants fails, or any identity
 * inspection, stop or exit check is inconclusive, this throws an `E3Stop`. The run then starts no
 * further phase, and the intent log keeps every unresolved entry for the final owned-resource
 * teardown.
 */
export async function stopPhaseServer(rootEntry: number, deps: PhaseStopDeps): Promise<void> {
  const unresolved: string[] = [];
  try {
    await deps.recordDescendants();
  } catch (error) {
    throw new E3Stop(`Stopped (phase shutdown unresolved): recording the server's descendants failed (${(error as Error).message}); nothing was stopped, and the intent log is kept for teardown`);
  }

  const entries = deps.entries();
  const tree = entries
    .map((entry) => ({ entry, depth: depthUnder(entry, rootEntry, entries) }))
    .filter((item): item is { entry: ResourceEntry; depth: number } => item.depth !== undefined && item.entry.state === "created")
    .sort((a, b) => b.depth - a.depth);
  const stopped: { entry: ResourceEntry; recorded: ProcessIdentity }[] = [];

  for (const { entry } of tree) {
    const recorded = entry.identity;
    if (recorded === undefined) {
      unresolved.push(`${entry.label} has no recorded identity`);
      continue;
    }
    let live: ProcessIdentity | undefined;
    try {
      live = await deps.inspect(recorded.pid);
    } catch (error) {
      unresolved.push(`${entry.label} could not be inspected (${(error as Error).message})`);
      continue;
    }
    const check = checkProcessIdentity(recorded, live);
    if (check.status === "absent") {
      deps.update(entry.id, { state: "absent", reason: check.reason });
      continue;
    }
    if (check.status === "mismatch") {
      unresolved.push(`${entry.label} was not stopped: ${check.reason}`);
      continue;
    }
    try {
      await deps.stop(recorded.pid);
      stopped.push({ entry, recorded });
    } catch (error) {
      unresolved.push(`${entry.label} could not be stopped (${(error as Error).message})`);
    }
  }

  for (const { entry, recorded } of stopped) {
    let gone = false;
    for (let poll = 0; poll < deps.exitPolls && !gone; poll += 1) {
      try {
        gone = checkProcessIdentity(recorded, await deps.inspect(recorded.pid)).status === "absent";
      } catch {
        gone = false;
      }
      if (!gone) await deps.sleep(deps.exitPollMs);
    }
    if (gone) deps.update(entry.id, { state: "stopped" });
    else unresolved.push(`${entry.label}'s exit could not be confirmed`);
  }

  if (unresolved.length > 0) {
    throw new E3Stop(`Stopped (phase shutdown unresolved): ${unresolved.join("; ")}; no further phase was started, and the intent log is kept for teardown`);
  }
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

export interface E3RunSeams {
  /** Disposable worktree at the authorized commit, then `npm ci`. */
  readonly prepareWorktree: () => Promise<void>;
  /** `next build` with exactly the given environment; throws on failure. */
  readonly build: (environment: Readonly<Record<string, string>>) => Promise<void>;
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
    await seams.build(buildEnvironment);
    built = true;
    seams.note("E-A1: next build succeeded with no database and no E3 runtime configuration");

    await seams.withCluster(async (cluster) => {
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
