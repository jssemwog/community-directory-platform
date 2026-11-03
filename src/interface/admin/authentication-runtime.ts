/**
 * The **one** administrator-authentication runtime per server process (issue #260 §3.4 and §12
 * qualifications 1 and 2).
 *
 * `ADR-028` D-17 bounds the password-step overshoot **per limiter instance**, so the runtime
 * must exist once per process however Next.js bundles the route modules that use it. It is
 * therefore anchored on `globalThis` under a `Symbol.for` key, not in module scope: separately
 * bundled Route Handlers and hot reloads all reach the same object. It is created through **one
 * shared initialization promise**, so concurrent first requests cannot create a second pool,
 * dummy hash or limiter. A failed initialization is forgotten, so a later request can retry.
 *
 * It is created lazily, only for a request the gate has opened, and never at import.
 *
 * ## Test-only diagnostics
 *
 * When the browser harness sets `LOCAL_ADMIN_DIAGNOSTICS_FILE` to an absolute path inside the
 * operating system's temporary directory, the runtime appends one JSON line per event to that
 * file: the process identity, the runtime and limiter identities, and each module instance that
 * served a request. It records no credential, token, digest, key, address or username. These
 * identities **never** appear in a response or in the ordinary outcome log (§3.8); without the
 * variable nothing is written.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type { Kysely } from "kysely";

import type { AdministratorAuthenticationDatabase } from "../../data/administrator-authentication-table";
import { createListingPersistence } from "../../data/connection";
import { HashLimiter } from "../../domain/administrator-auth/hash-limiter";
import { createDummyPasswordHash, verifyPassword } from "../../domain/administrator-auth/password-hash";
import type { SignInDependencies } from "../../domain/administrator-auth/sign-in";
import { LOCAL_TOTP_KEY_VERSION, type LocalAdministratorConfiguration } from "./local-gate";

/**
 * The per-source key for every local request. The gate guarantees a loopback request, and which
 * forwarded header to trust is `ADR-004` R-2, a production prerequisite this unit does not
 * decide; so no header is read for it (OD-7). All local sign-in shares one source window.
 */
export const LOCAL_SOURCE_ADDRESS = "local-loopback";

export const LOCAL_ADMIN_DIAGNOSTICS_FILE = "LOCAL_ADMIN_DIAGNOSTICS_FILE";

/** Local only; not a production pool policy (`ADR-016`). */
const POOL_MAX = 2;

const RUNTIME_KEY = Symbol.for("community-directory-platform.local-administrator-runtime");

/** This module's evaluation, so a hot reload is visible in the diagnostics. */
const MODULE_INSTANCE = randomUUID();

export interface AdministratorRuntime {
  readonly runtimeId: string;
  readonly limiterId: string;
  readonly deps: SignInDependencies;
  shutdown(): Promise<void>;
}

/** What the runtime is built from; tests substitute these to observe initialization. */
export interface RuntimeFactories {
  createDatabase(connectionString: string): {
    readonly db: Kysely<AdministratorAuthenticationDatabase>;
    shutdown(): Promise<void>;
  };
  createDummyPasswordHash(): Promise<string>;
  createLimiter(): HashLimiter;
}

export const DEFAULT_FACTORIES: RuntimeFactories = {
  createDatabase(connectionString) {
    const persistence = createListingPersistence({
      pool: { connectionString, max: POOL_MAX },
      startupParameters: { application_name: "local_administrator_auth" },
    });

    // The governed pool (`connection.ts`) is reused for its datestyle, instant parser and idle
    // error handling; only its row typing differs, and the storage module uses raw `sql`.
    return {
      db: persistence.db as unknown as Kysely<AdministratorAuthenticationDatabase>,
      shutdown: () => persistence.shutdown(),
    };
  },
  createDummyPasswordHash,
  createLimiter: () => new HashLimiter(),
};

interface Holder {
  readonly fingerprint: string;
  readonly promise: Promise<AdministratorRuntime>;
}

type Anchor = typeof globalThis & { [RUNTIME_KEY]?: Holder };

function fingerprintOf(configuration: LocalAdministratorConfiguration): string {
  return createHash("sha256")
    .update(configuration.connectionString)
    .update("\0")
    .update(configuration.totpKey)
    .update(configuration.throttleKey)
    .digest("hex");
}

/** The diagnostic sink's path, when the harness enabled it; otherwise `undefined`. */
function diagnosticsPath(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const supplied = environment[LOCAL_ADMIN_DIAGNOSTICS_FILE];

  if (supplied === undefined || supplied === "" || !isAbsolute(supplied)) {
    return undefined;
  }

  const inside = relative(resolve(tmpdir()), resolve(supplied));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? supplied : undefined;
}

/** Append one test-only diagnostic event. Never throws; never called with a secret. */
export function recordDiagnostic(
  event: string,
  details: Readonly<Record<string, string | number>> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const path = diagnosticsPath(environment);

  if (path === undefined) {
    return;
  }

  try {
    appendFileSync(
      path,
      `${JSON.stringify({ event, pid: process.pid, ppid: process.ppid, runtimeModule: MODULE_INSTANCE, ...details })}\n`,
    );
  } catch {
    // Diagnostics are evidence for a test; their absence fails that test, never a request.
  }
}

async function build(
  configuration: LocalAdministratorConfiguration,
  factories: RuntimeFactories,
): Promise<AdministratorRuntime> {
  const database = factories.createDatabase(configuration.connectionString);

  try {
    const dummyPasswordHash = await factories.createDummyPasswordHash();
    const runtime: AdministratorRuntime = {
      runtimeId: randomUUID(),
      limiterId: randomUUID(),
      deps: {
        db: database.db,
        clock: Date.now,
        limiter: factories.createLimiter(),
        passwords: { verify: verifyPassword },
        dummyPasswordHash,
        throttleKey: configuration.throttleKey,
        totpKeys: new Map([[LOCAL_TOTP_KEY_VERSION, configuration.totpKey]]),
      },
      shutdown: () => database.shutdown(),
    };

    recordDiagnostic("runtime-created", { runtimeId: runtime.runtimeId, limiterId: runtime.limiterId });
    return runtime;
  } catch (error) {
    await database.shutdown();
    throw error;
  }
}

/**
 * The process's runtime for this configuration. Every caller in the process, in every bundle,
 * receives the same promise; a changed configuration replaces it and closes the old pool.
 */
export function administratorRuntime(
  configuration: LocalAdministratorConfiguration,
  factories: RuntimeFactories = DEFAULT_FACTORIES,
): Promise<AdministratorRuntime> {
  const anchor = globalThis as Anchor;
  const fingerprint = fingerprintOf(configuration);
  const existing = anchor[RUNTIME_KEY];

  if (existing?.fingerprint === fingerprint) {
    return existing.promise;
  }

  const promise = build(configuration, factories);
  const holder: Holder = { fingerprint, promise };

  anchor[RUNTIME_KEY] = holder;
  void existing?.promise.then((previous) => previous.shutdown()).catch(() => undefined);

  promise.catch(() => {
    if (anchor[RUNTIME_KEY] === holder) {
      delete anchor[RUNTIME_KEY];
    }
  });

  return promise;
}

/** Test-only: close and forget the process's runtime. */
export async function resetAdministratorRuntimeForTests(): Promise<void> {
  const anchor = globalThis as Anchor;
  const existing = anchor[RUNTIME_KEY];

  delete anchor[RUNTIME_KEY];
  await existing?.promise.then((runtime) => runtime.shutdown()).catch(() => undefined);
}
