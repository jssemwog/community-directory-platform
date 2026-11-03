/**
 * The **local administrator gate** (issue #260, under the #254 exception).
 *
 * Administrator sign-in exists only for the launcher's local journey. The gate is open only when
 * **every** condition holds:
 *
 * 1. the server runs in **development** mode, so `next build` / `next start` never open it;
 * 2. `LOCAL_ADMIN_ORIGIN` is set by the launcher to its canonical origin, an `https://` URL on
 *    `127.0.0.1` with an explicit port and nothing else (local HTTPS, `ADR-004` L-3, issue #260
 *    OD-3);
 * 3. the database is the local demo's loopback database (`localDemoConnectionStringOf`);
 * 4. both development keys decode to exactly 32 bytes and differ (L-5, `ADR-028` D-7); and
 * 5. the request's `Host` header equals the canonical origin's host and port exactly: the
 *    loopback `Host` check, which also refuses DNS-rebinding names.
 *
 * Anything else is **closed**. A closed gate is never explained: every entry point gives the
 * same refusal, and no part of any value reaches a response. **Server-side only**: none of
 * these variables has a `NEXT_PUBLIC_` prefix, so Next.js never inlines them into a client
 * bundle (`ADR-002` `O-7`). Nothing here logs.
 *
 * The launcher binds the server to `127.0.0.1`. The application cannot observe its own
 * listening address, so that binding is the launcher's guarantee, not this module's (#260 §3.1).
 */

import { localDemoConnectionStringOf } from "../public/local-demo-persistence";

export const LOCAL_ADMIN_ORIGIN = "LOCAL_ADMIN_ORIGIN";
export const LOCAL_ADMIN_TOTP_KEY_V1 = "LOCAL_ADMIN_TOTP_KEY_V1";
export const LOCAL_ADMIN_THROTTLE_KEY = "LOCAL_ADMIN_THROTTLE_KEY";

/** The one TOTP key version the local journey uses. */
export const LOCAL_TOTP_KEY_VERSION = 1;

const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface LocalAdministratorConfiguration {
  /** For example `https://127.0.0.1:3000`. */
  readonly origin: string;
  /** The `Host` header every request must carry: `127.0.0.1:<port>`. */
  readonly host: string;
  readonly connectionString: string;
  readonly totpKey: Buffer;
  readonly throttleKey: Buffer;
}

type Environment = Readonly<Record<string, string | undefined>>;

function keyOf(value: string | undefined): Buffer | undefined {
  if (value === undefined || !BASE64URL.test(value)) {
    return undefined;
  }

  const key = Buffer.from(value, "base64url");
  return key.length === KEY_BYTES && key.toString("base64url") === value ? key : undefined;
}

function canonicalOriginOf(value: string | undefined): { origin: string; host: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.origin !== value
    ) {
      return undefined;
    }

    return { origin: url.origin, host: url.host };
  } catch {
    return undefined;
  }
}

/** The gate's configuration, or `undefined` when the environment does not open it. */
export function localAdministratorConfigurationOf(
  environment: Environment,
): LocalAdministratorConfiguration | undefined {
  const connectionString = localDemoConnectionStringOf(environment);
  const canonical = canonicalOriginOf(environment[LOCAL_ADMIN_ORIGIN]);
  const totpKey = keyOf(environment[LOCAL_ADMIN_TOTP_KEY_V1]);
  const throttleKey = keyOf(environment[LOCAL_ADMIN_THROTTLE_KEY]);

  if (
    environment.NODE_ENV !== "development" ||
    connectionString === undefined ||
    canonical === undefined ||
    totpKey === undefined ||
    throttleKey === undefined ||
    totpKey.equals(throttleKey)
  ) {
    return undefined;
  }

  return { ...canonical, connectionString, totpKey, throttleKey };
}

/**
 * The gate for one request: its configuration when the environment opens it **and** the
 * request's `Host` is exactly the canonical host; otherwise `undefined`.
 */
export function openGateFor(
  environment: Environment,
  hostHeader: string | null | undefined,
): LocalAdministratorConfiguration | undefined {
  const configuration = localAdministratorConfigurationOf(environment);

  return configuration !== undefined && hostHeader === configuration.host ? configuration : undefined;
}
