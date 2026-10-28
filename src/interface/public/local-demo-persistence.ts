/**
 * The **local demonstration's** composition root for the public read path (issue #248).
 *
 * `src/data/connection.ts` records that wiring `C9` to the application is a separately authorized
 * unit, and `ADR-016` decides no pool size, timeout, TLS, credential or connection-string policy.
 * This module does **not** make that production decision. It enables the `S1`/`S2` pages only for
 * the localhost demonstration started by `npm run demo:local`, and only when all three hold:
 *
 * 1. `LOCAL_DEMO_DATABASE_URL` is set — by the demo script, in the server process's environment;
 * 2. that URL's host is a **loopback** address; and
 * 3. the server runs in **development** mode, so `next build` / `next start` never enable it.
 *
 * Anything else means **not configured**, and the pages answer 404 as if they did not exist. A
 * malformed or non-loopback value is treated the same way: it is refused, not reported, so no
 * part of the value can reach a response.
 *
 * **Server-side only.** The connection string is read from the server's environment at request
 * time; it has no `NEXT_PUBLIC_` prefix, so Next.js never inlines it into a client bundle
 * (`ADR-002` `O-7`). Nothing here logs.
 */

import { createListingPersistence, type ListingPersistence } from "../../data/connection";

/** The one variable the demo script sets. Never `NEXT_PUBLIC_`-prefixed. */
export const LOCAL_DEMO_DATABASE_URL = "LOCAL_DEMO_DATABASE_URL";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Demo-only pool size; not a production pool policy (`ADR-016`). */
const DEMO_POOL_MAX = 2;

/**
 * The connection string the demo may use, or `undefined` when the demo is not configured.
 * Pure over its inputs, so the gate is testable without a server.
 */
export function localDemoConnectionStringOf(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const supplied = environment[LOCAL_DEMO_DATABASE_URL];

  if (environment.NODE_ENV !== "development" || supplied === undefined || supplied === "") {
    return undefined;
  }

  try {
    const url = new URL(supplied);
    const isPostgres = url.protocol === "postgres:" || url.protocol === "postgresql:";

    return isPostgres && LOOPBACK_HOSTS.has(url.hostname) ? supplied : undefined;
  } catch {
    return undefined;
  }
}

/** One pool per connection string, kept across development hot reloads. */
const cache = globalThis as typeof globalThis & {
  __localDemoPersistence?: { readonly connectionString: string; readonly persistence: ListingPersistence };
};

/** The demo's `C9` boundary, or `undefined` when the demo is not configured. */
export function localDemoPersistence(): ListingPersistence | undefined {
  const connectionString = localDemoConnectionStringOf(process.env);

  if (connectionString === undefined) {
    return undefined;
  }

  if (cache.__localDemoPersistence?.connectionString !== connectionString) {
    void cache.__localDemoPersistence?.persistence.shutdown();
    cache.__localDemoPersistence = {
      connectionString,
      persistence: createListingPersistence({
        pool: { connectionString, max: DEMO_POOL_MAX },
        startupParameters: { application_name: "local_directory_demo" },
      }),
    };
  }

  return cache.__localDemoPersistence.persistence;
}
