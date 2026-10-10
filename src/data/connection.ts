/**
 * The application's `C9` connection boundary (issue #177).
 *
 * `ADR-014` selected **Kysely** as the `C9` access approach and `ADR-016` selected **`pg` through
 * Kysely core `PostgresDialect`**, *"and with [it] the in-process pool **mechanism** that ships
 * with the driver"*. This module is where those two selections finally meet a pool — and it
 * discharges the obligation `src/data/README.md` has carried since issue #173: *"**`DateStyle` =
 * ISO on the connection remains a `C9` obligation**."*
 *
 * ## It owns two settings and chooses no policy
 *
 * `ADR-016` is explicit that it selects *"**no** pool size, idle timeout, connection timeout,
 * retry policy or graceful-shutdown wiring; **no** TLS verification policy, certificate source or
 * connection-string format; **no** credentials or secrets provider"*. Those remain undecided, and
 * the only way to build a pool without deciding them is to **take them from the caller**. So:
 *
 * - **The caller supplies the connection and pool configuration.** This module reads **no**
 *   environment variable — not `MIGRATION_DATABASE_URL`, which belongs to the migration CLI
 *   (`ADR-018`) and is untouched here — holds no default credential, and selects no size,
 *   timeout, retry or TLS posture.
 * - **This module supplies exactly two things**: the governed `timestamptz` type overrides
 *   (`ADR-022` decision 9) and `DateStyle = ISO`.
 *
 * There is **no composition root**: nothing calls this but its tests. Wiring it to the
 * application is a later, separately authorized unit.
 *
 * ## Why `DateStyle` travels in the startup packet
 *
 * Under `DateStyle = SQL` PostgreSQL emits a timezone **abbreviation with no numeric offset**,
 * which the governed parser refuses loudly — so a connection that runs even one statement before
 * the setting lands is a connection that can fail or, worse, be misread.
 *
 * The obvious idiom does not work. **`pg-pool` emits `'connect'` synchronously and hands the
 * client to the waiter without awaiting the handler**, so a `client.query("set datestyle …")`
 * there is a race, not a guarantee; it was measured doing exactly that. It is therefore
 * **rejected**, and so are per-query and transaction-local settings, which leave the same window.
 *
 * `pg` instead places a configured `options` string into the **startup packet**
 * (`pg/lib/client.js`: `if (params.options) { data.options = params.options }`), so the setting
 * is applied during the connection handshake, **before any statement can be issued**, on every
 * client the pool creates — `pg-pool` constructs each one as `new this.Client(this.options)`.
 * That is the mechanism used here.
 *
 * ## Caller startup parameters are preserved, and cannot defeat the governed one
 *
 * Callers may need their own startup parameters (`application_name`, `statement_timeout`, and so
 * on), so they are **kept, not discarded**. They arrive as a **typed record of name/value pairs**
 * rather than as an options string, deliberately: accepting raw option text would mean writing a
 * command-line parser and splitting on whitespace to find out what the caller asked for, and
 * getting that subtly wrong is how a governed setting gets silently overridden. With a record,
 * conflict detection is exact and there is nothing to parse.
 *
 * Every rejection below happens **during construction, before any connection is attempted**.
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { createRequire } from "node:module";

import { createTimestamptzTypeOverrides } from "./timestamp-parser";
import type { ListingDatabase } from "./listing-table";

/**
 * The `DateStyle` this boundary guarantees.
 *
 * `ISO` fixes the **output format** — `YYYY-MM-DD HH:MM:SS[.fff]±HH[:MM]`, the grammar the parser
 * implements. PostgreSQL pairs it with a date-**order** component (it reports `ISO, MDY`), which
 * affects only the interpretation of ambiguous *input* and is left at the server's own value:
 * nothing in this repository sends an ambiguous date, because every instant is written as an
 * unambiguous expression (`listing-mapping.ts`).
 */
export const GOVERNED_DATESTYLE = "ISO";

/** The startup parameter name this boundary owns. Compared case-insensitively. */
const DATESTYLE_PARAMETER = "datestyle";

/**
 * `DateStyle` values a caller may supply without conflict: they request the style already
 * guaranteed. Anything else is a conflict, including `SQL`, `German` and `Postgres`.
 */
const COMPATIBLE_DATESTYLES = ["iso", "iso, mdy", "iso,mdy", "iso, dmy", "iso,dmy", "iso, ymd", "iso,ymd"];

/**
 * Caller-supplied PostgreSQL startup parameters, as `name → value`.
 *
 * Rendered into the connection's `options` string as `-c name=value`. Names and values are
 * restricted to characters that need no escaping (see `startupOptionsFor`), so the rendering is
 * deterministic and no quoting or shell-style parsing is involved.
 */
export type StartupParameters = Readonly<Record<string, string>>;

/**
 * The connection and pool configuration this boundary accepts and passes through **unchanged**.
 *
 * Every field is the caller's to decide. `options` is **absent on purpose** — this boundary owns
 * it — and a caller that supplies one anyway is refused rather than silently overridden.
 */
export interface ListingPoolConfiguration {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly ssl?: unknown;
  readonly application_name?: string;
  readonly max?: number;
  readonly min?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly maxUses?: number;
  readonly maxLifetimeSeconds?: number;
  readonly allowExitOnIdle?: boolean;
  readonly statement_timeout?: number | false;
  readonly query_timeout?: number;
  readonly keepAlive?: boolean;
}

export interface ListingPersistenceConfiguration {
  /** The caller's own connection and pool settings. */
  readonly pool: ListingPoolConfiguration;
  /** Optional caller startup parameters, preserved alongside the governed `DateStyle`. */
  readonly startupParameters?: StartupParameters;
}

/** Why a configuration was refused. The reason is a code, never the configuration. */
export type PersistenceConfigurationProblem =
  | { readonly reason: "DATESTYLE_CONFLICT"; readonly supplied: string }
  | { readonly reason: "DUPLICATE_STARTUP_PARAMETER"; readonly parameter: string }
  | { readonly reason: "UNSAFE_STARTUP_PARAMETER_NAME"; readonly parameter: string }
  | { readonly reason: "UNSAFE_STARTUP_PARAMETER_VALUE"; readonly parameter: string }
  | { readonly reason: "CALLER_SUPPLIED_OPTIONS" }
  | { readonly reason: "CONNECTION_STRING_CARRIES_OPTIONS" }
  | { readonly reason: "CONNECTION_STRING_UNPARSEABLE" };

/**
 * A refused configuration.
 *
 * Thrown rather than returned: a misconfiguration is a defect in the caller's wiring, not an
 * expected runtime outcome, and `ADR-019`'s *fail-closed* posture says a boundary that cannot be
 * built correctly must not be built at all. Expected outcomes — not found, a duplicate
 * identifier — are `Result` values in `listing-repository.ts`.
 *
 * **The message names the problem, never the configuration.** No connection string, host, user,
 * password or parameter value appears in it; `parameter` carries a *name* only.
 */
export class PersistenceConfigurationError extends Error {
  readonly problem: PersistenceConfigurationProblem;

  constructor(problem: PersistenceConfigurationProblem) {
    super(`The listing persistence configuration was refused: ${problem.reason}.`);
    this.name = "PersistenceConfigurationError";
    this.problem = problem;
  }
}

/**
 * Characters a startup parameter name may contain.
 *
 * PostgreSQL configuration parameter names are ASCII words, so this admits every real one while
 * excluding whitespace, `=`, quotes and backslashes — the characters that would otherwise need
 * escaping inside the `options` string. Refusing them is why the rendering below can be a plain
 * join rather than a quoting algorithm.
 */
const SAFE_PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;

/**
 * Characters a startup parameter value may contain.
 *
 * Deliberately conservative: no whitespace, quote, backslash or `-`-leading form, so a value can
 * neither terminate its own `-c` pair nor introduce another one.
 */
const SAFE_PARAMETER_VALUE = /^[A-Za-z0-9_.,:+][A-Za-z0-9_.,:+]*$/;

/**
 * Build the `options` startup string, with the governed `DateStyle` first and the caller's
 * parameters after it.
 *
 * Exported so that the conflict rules can be attacked directly, without a database.
 *
 * Ordering is **not** the guarantee. A caller cannot win by ordering, capitalization or a
 * duplicate spelling, because a conflicting or repeated `DateStyle` is **refused** before a
 * string is produced at all — the only `datestyle` that survives is one that asks for what is
 * already guaranteed, and it is then emitted once, from here.
 */
export function startupOptionsFor(parameters: StartupParameters = {}): string {
  const seen = new Map<string, string>();

  for (const [name, value] of Object.entries(parameters)) {
    if (!SAFE_PARAMETER_NAME.test(name)) {
      throw new PersistenceConfigurationError({
        reason: "UNSAFE_STARTUP_PARAMETER_NAME",
        parameter: name,
      });
    }

    const canonical = name.toLowerCase();

    // Two spellings of one parameter — `DateStyle` and `datestyle`, say — leave the effective
    // setting to object key order. Refused rather than resolved.
    if (seen.has(canonical)) {
      throw new PersistenceConfigurationError({
        reason: "DUPLICATE_STARTUP_PARAMETER",
        parameter: canonical,
      });
    }

    // `DateStyle` is judged **before** the generic value grammar, and is exempt from it. Its
    // legitimate values contain a space and a comma (`ISO, MDY`), which that grammar refuses —
    // and it can afford to: a compatible value is replaced by the governed one below and an
    // incompatible one is refused outright, so a caller's `datestyle` text never reaches the
    // options string at all. Checking the grammar first would misreport `SQL, MDY` as an unsafe
    // value when the real objection is that it conflicts.
    if (canonical === DATESTYLE_PARAMETER) {
      // Comparing case- and space-insensitively: `ISO`, `iso` and `ISO, MDY` all ask for the
      // style already guaranteed. `SQL`, `German` and `Postgres` do not, and are refused here
      // rather than fighting the governed value for precedence at connection time.
      if (!COMPATIBLE_DATESTYLES.includes(value.trim().toLowerCase())) {
        throw new PersistenceConfigurationError({
          reason: "DATESTYLE_CONFLICT",
          supplied: value,
        });
      }

      // Compatible, so it is honoured by the governed pair below rather than emitted twice.
      seen.set(canonical, GOVERNED_DATESTYLE);
      continue;
    }

    if (!SAFE_PARAMETER_VALUE.test(value)) {
      throw new PersistenceConfigurationError({
        reason: "UNSAFE_STARTUP_PARAMETER_VALUE",
        parameter: name,
      });
    }

    seen.set(canonical, value);
  }

  seen.set(DATESTYLE_PARAMETER, GOVERNED_DATESTYLE);

  // The governed pair is emitted first for legibility. PostgreSQL applies every `-c` pair in the
  // startup packet before the session accepts a statement, so position carries no meaning.
  const governed = `-c ${DATESTYLE_PARAMETER}=${GOVERNED_DATESTYLE}`;
  const rest = [...seen.entries()]
    .filter(([name]) => name !== DATESTYLE_PARAMETER)
    .map(([name, value]) => `-c ${name}=${value}`);

  return [governed, ...rest].join(" ");
}

/**
 * Refuse a caller configuration that would take the `options` field out of this boundary's hands.
 *
 * Two routes exist, and both are closed:
 *
 * 1. **An explicit `options` field.** `ListingPoolConfiguration` does not declare one, but types
 *    are erased, so it is checked at runtime.
 * 2. **An `options` parameter inside a connection string.** This one is not obvious and matters:
 *    `pg` merges a parsed connection string **over** the explicit configuration
 *    (`connection-parameters.js`: `Object.assign({}, config, parse(config.connectionString))`),
 *    so `?options=-c%20datestyle%3DSQL` in the URL would **override** the governed setting. The
 *    connection string is therefore inspected with Node's own `URL`, and one carrying an
 *    `options` parameter is refused.
 *
 * A connection string without an `options` parameter is left completely alone — `pg`'s parse
 * returns no `options` key for it, so the governed value survives the merge.
 */
function assertOptionsAreOurs(pool: ListingPoolConfiguration): void {
  if ("options" in (pool as Record<string, unknown>)) {
    throw new PersistenceConfigurationError({ reason: "CALLER_SUPPLIED_OPTIONS" });
  }

  if (pool.connectionString === undefined) {
    return;
  }

  let parsed: URL;

  try {
    parsed = new URL(pool.connectionString);
  } catch {
    // Refused without echoing the string: it carries the password.
    throw new PersistenceConfigurationError({ reason: "CONNECTION_STRING_UNPARSEABLE" });
  }

  for (const name of parsed.searchParams.keys()) {
    if (name.toLowerCase() === "options") {
      throw new PersistenceConfigurationError({
        reason: "CONNECTION_STRING_CARRIES_OPTIONS",
      });
    }
  }
}

/** The narrow slice of `pg` this module uses. */
interface PgModule {
  readonly Pool: new (config: Record<string, unknown>) => PostgresPool & {
    end(): Promise<void>;
  };
}

/**
 * The configured `C9` boundary.
 *
 * `db` is the only handle callers need; the pool is deliberately not exposed, so no caller can
 * reach past Kysely to the driver or re-register a type parser behind this module's back.
 */
export interface ListingPersistence {
  readonly db: Kysely<ListingDatabase>;
  /**
   * Release the pool and its connections.
   *
   * Explicit, because `ADR-005` describes a long-running process whose pool outlives any single
   * operation — nothing here may close itself on a whim. Calling it more than once is safe: the
   * second call is a no-op rather than the driver's *"Called end on pool more than once"*.
   */
  shutdown(): Promise<void>;
}

/**
 * Build the `C9` boundary from caller-supplied configuration.
 *
 * **Importing this module does none of this.** `pg` is reached through a local `require` at call
 * time — the pattern `timestamp-parser.ts` established — so no pool is constructed, no connection
 * is opened and no ambient state is touched until a caller asks.
 *
 * **No global `pg` type state is mutated.** The governed parser is installed on *this pool's*
 * `types` registry, which `pg` copies per client (`client.js`: `this._types = new
 * TypeOverrides(c.types)`). `pg.types.setTypeParser` is never called, so an unrelated pool — the
 * migration CLI's included — keeps the driver's default `Date` behaviour.
 */
export function createListingPersistence(
  configuration: ListingPersistenceConfiguration,
): ListingPersistence {
  // Validation first, so a refused configuration never reaches the network.
  assertOptionsAreOurs(configuration.pool);
  const options = startupOptionsFor(configuration.startupParameters);

  const { Pool } = createRequire(import.meta.url)("pg") as PgModule;

  const pool = new Pool({
    ...configuration.pool,
    // `ADR-022` decision 9 — the governed instants arrive as epoch milliseconds, per pool.
    types: createTimestamptzTypeOverrides(),
    // Delivered in the startup packet, so it is in force before the first statement.
    options,
  });

  const db = new Kysely<ListingDatabase>({ dialect: new PostgresDialect({ pool }) });

  let closed = false;

  return {
    db,
    async shutdown(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      // Destroying the Kysely instance ends the pool it was given, which is the one above.
      await db.destroy();
    },
  };
}
