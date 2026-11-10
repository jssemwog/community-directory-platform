/**
 * `E3-local`: the public listing-detail route (`S2`, `OP-2`) under `next build` + `next start`,
 * against a **disposable synthetic** PostgreSQL cluster that the `e3-check` launcher created and
 * owns (issue #246; `E3-local` Scope Gate revision 4, approved, with its approval record's
 * clarification).
 *
 * **Default off and production only.** The mode is configured only when `NODE_ENV` is
 * `production`, `BI4_E3_LOCAL` is exactly `1`, and every value below is present and well formed.
 * Anything else means **not configured**, and the routes answer exactly as they do today. Under
 * `next dev` these variables are ignored and the local demo is unchanged.
 *
 * **What it guarantees, and what it does not.** The launcher derives the target from its own
 * cluster and checks the database listener's owner before any SQL (revision 3 §3). This module
 * then verifies **every newly opened connection** in `pg-pool`'s awaited `onConnect`, before the
 * pool hands it out: the cluster's system identifier, the database, the per-run synthetic marker,
 * and that the session user is the expected non-superuser role. These checks corroborate the
 * launcher's ownership checks; they do not establish ownership on their own.
 *
 * **Refusal is sticky and silent.** A failed verification, or **any** checkout error (ruling S-11),
 * marks the process refused until it restarts. Refusal is never logged, rendered or explained:
 * - the directory layout returns 404 when its own checkout fails or when it sees the refusal
 *   (`precheck`), before it renders anything;
 * - the page renders the generic not-available content without a query (`read`). This is the
 *   approved S-7 fallback, and applies only when the response was already committed.
 *
 * No render order is assumed: the layout and the page may run in either order, on different
 * clients. A client that fails `onConnect` is closed by `pg-pool` and never handed out, so no
 * listing query can run on it.
 *
 * **Server-side only.** Nothing here has a `NEXT_PUBLIC_` name, and nothing logs.
 */

import type { Kysely } from "kysely";

import {
  createListingPersistence,
  type ListingPersistence,
  type ListingPersistenceConfiguration,
} from "../../data/connection";
import type { ListingDatabase } from "../../data/listing-table";
import { findPubliclyAvailableListing } from "../../data/public-listing-read";

/** The flag. Exactly `"1"` enables the mode, and only in production. */
export const BI4_E3_LOCAL = "BI4_E3_LOCAL";
/** The app role's connection URL: `postgres(ql)://role:password@127.0.0.1:<port>/<database>`. */
export const BI4_E3_DATABASE_URL = "BI4_E3_DATABASE_URL";
/** The cluster's `pg_control_system().system_identifier`, as recorded by the launcher. */
export const BI4_E3_EXPECTED_SYSTEM_IDENTIFIER = "BI4_E3_EXPECTED_SYSTEM_IDENTIFIER";
/** The database name, which must also be the URL's path. */
export const BI4_E3_EXPECTED_DATABASE = "BI4_E3_EXPECTED_DATABASE";
/** The per-run synthetic marker, set as the database comment by the launcher. */
export const BI4_E3_SYNTHETIC_MARKER = "BI4_E3_SYNTHETIC_MARKER";

/** Every variable the mode reads. */
export const E3_LOCAL_VARIABLES: readonly string[] = [
  BI4_E3_LOCAL,
  BI4_E3_DATABASE_URL,
  BI4_E3_EXPECTED_SYSTEM_IDENTIFIER,
  BI4_E3_EXPECTED_DATABASE,
  BI4_E3_SYNTHETIC_MARKER,
];

/** The only host the mode accepts (revision 2 §3.5): not `localhost`, not `::1`. */
export const E3_LOCAL_HOST = "127.0.0.1";

/** The marker's exact shape: a fixed prefix and a 32-hex-digit per-run nonce. */
export const E3_MARKER_PATTERN = /^bi4-e3-synthetic:[0-9a-f]{32}$/;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_IDENTIFIER = /^[0-9]{1,20}$/;
const PASSWORD = /^[A-Za-z0-9]{16,128}$/;

/** What the app expects of every connection (C-1 to C-4). */
export interface E3Expected {
  readonly systemIdentifier: string;
  readonly database: string;
  readonly role: string;
  readonly marker: string;
}

export interface E3LocalConfiguration {
  readonly connectionString: string;
  readonly expected: E3Expected;
}

/**
 * The mode's configuration, or `undefined` when it is not configured. Pure over its inputs, so
 * enablement is decided before any connection is attempted and is testable without a server.
 */
export function e3LocalConfigurationOf(
  environment: Readonly<Record<string, string | undefined>>,
): E3LocalConfiguration | undefined {
  if (environment.NODE_ENV !== "production" || environment[BI4_E3_LOCAL] !== "1") {
    return undefined;
  }

  const supplied = environment[BI4_E3_DATABASE_URL];
  const systemIdentifier = environment[BI4_E3_EXPECTED_SYSTEM_IDENTIFIER];
  const database = environment[BI4_E3_EXPECTED_DATABASE];
  const marker = environment[BI4_E3_SYNTHETIC_MARKER];

  if (
    supplied === undefined ||
    systemIdentifier === undefined ||
    !SYSTEM_IDENTIFIER.test(systemIdentifier) ||
    database === undefined ||
    !IDENTIFIER.test(database) ||
    marker === undefined ||
    !E3_MARKER_PATTERN.test(marker)
  ) {
    return undefined;
  }

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

  // `search` and `hash` must be empty: a `host=` or `hostaddr=` parameter would redirect `pg`.
  const acceptable =
    (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
    url.hostname === E3_LOCAL_HOST &&
    url.port !== "" &&
    url.search === "" &&
    !supplied.includes("?") &&
    url.hash === "" &&
    url.pathname === `/${database}` &&
    IDENTIFIER.test(role) &&
    PASSWORD.test(password);

  return acceptable ? { connectionString: supplied, expected: { systemIdentifier, database, role, marker } } : undefined;
}

/**
 * C-1 to C-4 in one statement. Each is a plain read the least-privilege role can perform with the
 * grants in `e3LocalRoleSetupStatements` (the explicit `EXECUTE` on `pg_control_system()`, plus the
 * catalog reads PostgreSQL allows every role).
 */
export const VERIFICATION_STATEMENT =
  "select (select system_identifier::text from pg_control_system()) as system_identifier, " +
  "current_database() as database, " +
  "(select shobj_description(oid, 'pg_database') from pg_database where datname = current_database()) as marker, " +
  "current_user as role, " +
  "(select rolsuper from pg_roles where rolname = current_user) as superuser";

/** The narrow slice of a `pg` client that verification uses. */
export interface VerifiableClient {
  query(text: string): Promise<{ readonly rows: readonly unknown[] }>;
}

/** Whether one connection is the expected server, database, marker and non-superuser role. */
export async function connectionMatches(client: VerifiableClient, expected: E3Expected): Promise<boolean> {
  const { rows } = await client.query(VERIFICATION_STATEMENT);

  if (rows.length !== 1) {
    return false;
  }

  const row = rows[0] as Record<string, unknown>;

  return (
    row.system_identifier === expected.systemIdentifier &&
    row.database === expected.database &&
    row.marker === expected.marker &&
    row.role === expected.role &&
    row.superuser === false
  );
}

/** The one generic error a refused checkout carries. It names no check and no value. */
export class E3LocalRefused extends Error {
  constructor() {
    super("E3-local refused");
    this.name = "E3LocalRefused";
  }
}

/** The page's outcome when the process is refused: render the generic not-available content. */
export const REFUSED = Object.freeze({ refused: true as const });
export type Refused = typeof REFUSED;

/** Whether a page outcome is the refusal. */
export function isRefused(outcome: object): outcome is Refused {
  return outcome === REFUSED;
}

type ReadResult = Awaited<ReturnType<typeof findPubliclyAvailableListing>>;

/** The `E3-local` handle the routes use. */
export interface E3Local {
  /** Whether the process is refused. Sticky until restart. */
  isRefused(): boolean;
  /**
   * The layout's pre-check (revision 4 §3.2):
   * 1. if already refused, return `"refused"` with **no checkout**;
   * 2. otherwise check out a client and release it with **no SQL** (a newly opened client passes
   *    `onConnect` first);
   * 3. after that settles, success or failure, re-read the refusal.
   *
   * A checkout error of any kind refuses the process.
   */
  precheck(): Promise<"ok" | "refused">;
  /**
   * The page's guarded read (revision 4 §3.3). If refused, return `REFUSED` with no checkout.
   * Otherwise reserve a client; a failed reservation refuses the process and returns `REFUSED`.
   * On the reserved client, re-read the refusal **before** the `OP-2` query.
   */
  read(identity: unknown): Promise<ReadResult | Refused>;
  /** End the pool. Safe to call more than once. */
  shutdown(): Promise<void>;
}

/** Seams for tests. Production uses the defaults. */
export interface E3LocalSeams {
  readonly createPersistence?: (configuration: ListingPersistenceConfiguration) => ListingPersistence;
  readonly find?: (db: Kysely<ListingDatabase>, identity: unknown) => Promise<ReadResult>;
}

/**
 * The `E3-local` pool settings (rulings S-8 and revision 4 §3.1): one client, never evicted
 * (`idleTimeoutMillis: 0` explicitly, because `pg-pool` otherwise defaults to 10 000 ms), never
 * recycled (no `maxUses`, no `maxLifetimeSeconds`). Not a production pool policy (`ADR-016`).
 */
export const E3_POOL_MAX = 1;
export const E3_IDLE_TIMEOUT_MILLIS = 0;

/** Build the handle. One per process in production (`e3LocalPersistence`); tests build their own. */
export function createE3Local(configuration: E3LocalConfiguration, seams: E3LocalSeams = {}): E3Local {
  const createPersistence = seams.createPersistence ?? createListingPersistence;
  const find = seams.find ?? findPubliclyAvailableListing;
  let refused = false;
  let persistence: ListingPersistence | undefined;

  const refuse = (): void => {
    if (refused) {
      return;
    }

    refused = true;
    // Ends the pool; `pg-pool` waits for checked-out clients to be released.
    void persistence?.shutdown().catch(() => {});
  };

  persistence = createPersistence({
    pool: {
      connectionString: configuration.connectionString,
      max: E3_POOL_MAX,
      idleTimeoutMillis: E3_IDLE_TIMEOUT_MILLIS,
      onConnect: async (client: unknown) => {
        let matches = false;

        try {
          matches = await connectionMatches(client as VerifiableClient, configuration.expected);
        } catch {
          matches = false;
        }

        if (!matches) {
          // Marked before rejecting, so any request that sees this checkout fail sees the refusal.
          refuse();
          throw new E3LocalRefused();
        }
      },
    },
    startupParameters: { application_name: "bi4_e3_local" },
  });

  const db = persistence.db;

  return {
    isRefused: () => refused,
    async precheck() {
      if (refused) {
        return "refused";
      }

      try {
        await db.connection().execute(async () => undefined);
      } catch {
        refuse();
      }

      return refused ? "refused" : "ok";
    },
    async read(identity) {
      if (refused) {
        return REFUSED;
      }

      try {
        return await db.connection().execute(async (reserved) => {
          if (refused) {
            return REFUSED;
          }

          return find(reserved, identity);
        });
      } catch {
        refuse();
        return REFUSED;
      }
    },
    async shutdown() {
      refused = true;
      await persistence?.shutdown();
    },
  };
}

/** One handle per configuration, per process. */
const cache = globalThis as typeof globalThis & {
  __bi4E3Local?: { readonly key: string; readonly handle: E3Local };
};

/** The process's `E3-local` handle, or `undefined` when the mode is not configured. */
export function e3LocalPersistence(): E3Local | undefined {
  const configuration = e3LocalConfigurationOf(process.env);

  if (configuration === undefined) {
    return undefined;
  }

  const key = JSON.stringify(configuration);

  if (cache.__bi4E3Local?.key !== key) {
    void cache.__bi4E3Local?.handle.shutdown().catch(() => {});
    cache.__bi4E3Local = { key, handle: createE3Local(configuration) };
  }

  return cache.__bi4E3Local.handle;
}

/**
 * The launcher's app-role setup, run as the cluster superuser before the app starts
 * (revision 3 §4.1). The single source shared by `e3-check` and the integration test.
 *
 * `PUBLIC`'s default database and schema privileges are revoked first, so the role's **effective**
 * privileges are exactly what is granted here: connect, use schema `public`, read `listing`, and
 * execute `pg_control_system()`. The catalog reads C-3 and C-4 need stay readable to every role by
 * PostgreSQL default.
 */
export function e3LocalRoleSetupStatements(input: {
  readonly database: string;
  readonly role: string;
  readonly password: string;
}): readonly string[] {
  if (!IDENTIFIER.test(input.database) || !IDENTIFIER.test(input.role)) {
    throw new Error("the database and role names must be plain lower-case identifiers");
  }

  if (!PASSWORD.test(input.password)) {
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
    `grant execute on function pg_control_system() to ${role}`,
  ];
}
