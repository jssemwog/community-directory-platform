/**
 * The local journey's **development-only** keys (`ADR-004` L-5, `ADR-028` D-7; issue #260 §2).
 *
 * Two random 32-byte keys, the AES-256-GCM TOTP key (version 1) and the HMAC throttle key, kept
 * in one git-ignored file under `.local-demo/`, created **exclusively** on first use and never
 * printed. They reach only the spawned `next dev` process and the provisioning command, as
 * server-side environment variables with no `NEXT_PUBLIC_` prefix. `demo:local:reset` deletes
 * the file with the cluster, so no account outlives its keys. **No key is committed, no `.env`
 * file is read or written, and no production key exists** (`ADR-004` R-3 is untouched).
 *
 * Errors never carry a key or any part of the file.
 */

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

import {
  LOCAL_ADMIN_ORIGIN,
  LOCAL_ADMIN_THROTTLE_KEY,
  LOCAL_ADMIN_TOTP_KEY_V1,
} from "../../src/interface/admin/local-gate";

export const ADMINISTRATOR_KEY_BYTES = 32;

export interface AdministratorKeys {
  readonly totpKey: Buffer;
  readonly throttleKey: Buffer;
}

interface StoredKeys {
  readonly version: 1;
  readonly totpKeyV1: string;
  readonly throttleKey: string;
}

const UNREADABLE =
  "The local administrator keys are unreadable; nothing was changed. Run `npm run demo:local:reset` to start again.";

function decoded(value: unknown): Buffer | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const key = Buffer.from(value, "base64url");
  return key.length === ADMINISTRATOR_KEY_BYTES && key.toString("base64url") === value ? key : undefined;
}

/** Read and validate the keys file; throw a generic error on any defect. */
export function readAdministratorKeys(file: string): AdministratorKeys {
  let parsed: Partial<StoredKeys>;

  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredKeys>;
  } catch {
    throw new Error(UNREADABLE);
  }

  const totpKey = decoded(parsed.totpKeyV1);
  const throttleKey = decoded(parsed.throttleKey);

  if (parsed.version !== 1 || totpKey === undefined || throttleKey === undefined || totpKey.equals(throttleKey)) {
    throw new Error(UNREADABLE);
  }

  return { totpKey, throttleKey };
}

/**
 * The keys in `file`, creating them first if the file does not exist. Creation is exclusive
 * (`wx`), so an existing file is never overwritten; it is read and validated instead.
 */
export function ensureAdministratorKeys(file: string): { readonly keys: AdministratorKeys; readonly created: boolean } {
  const keys: AdministratorKeys = {
    totpKey: randomBytes(ADMINISTRATOR_KEY_BYTES),
    throttleKey: randomBytes(ADMINISTRATOR_KEY_BYTES),
  };
  let descriptor: number;

  try {
    descriptor = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { keys: readAdministratorKeys(file), created: false };
    }

    throw new Error("The local administrator keys could not be created; nothing was changed.");
  }

  try {
    const stored: StoredKeys = {
      version: 1,
      totpKeyV1: keys.totpKey.toString("base64url"),
      throttleKey: keys.throttleKey.toString("base64url"),
    };

    writeSync(descriptor, JSON.stringify(stored));
  } finally {
    closeSync(descriptor);
  }

  return { keys, created: true };
}

/** The variables the launcher adds to the spawned server's environment, and nowhere else. */
export function administratorEnvironmentFor(keys: AdministratorKeys, origin: string): Record<string, string> {
  return {
    [LOCAL_ADMIN_ORIGIN]: origin,
    [LOCAL_ADMIN_TOTP_KEY_V1]: keys.totpKey.toString("base64url"),
    [LOCAL_ADMIN_THROTTLE_KEY]: keys.throttleKey.toString("base64url"),
  };
}
