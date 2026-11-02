/**
 * The `C9` storage-failure vocabulary, shared by every repository (issue #195).
 *
 * `listing-repository.ts` established all of this while listings were the only persisted
 * aggregate. The revision repository must classify driver errors the same way — anything else
 * would mean two boundaries disagreeing about what a `SQLSTATE` means — so it is extracted here
 * rather than copied, unchanged in behaviour.
 *
 * **The security property is the reason this is one module and not two.** A PostgreSQL constraint
 * error carries `detail: "Failing row contains (…)"` as an **enumerable own property** — measured,
 * not assumed — so an error passed through verbatim would publish row values into any log line,
 * JSON response or `{...spread}` that touched it. That reasoning has to hold for proposed revision
 * content exactly as it holds for listing content, and a second copy of it is a second chance to
 * get it wrong.
 */

import { constants } from "node:os";

/**
 * A failure the store reported.
 *
 * **Its enumerable surface is deliberately tiny, and that is a security property rather than
 * tidiness.** Only a `SQLSTATE` and a constraint **name** are exposed: both are schema metadata,
 * neither is data or a credential.
 *
 * The original error is still retained on `cause`, because a diagnosis without it is guesswork —
 * but as a **non-enumerable** property, so it never appears in `JSON.stringify`, a spread or a
 * structured log by accident. A caller that genuinely needs it must reach for it deliberately,
 * and it is typed `unknown` so that reaching for a field inside it is a conscious cast.
 *
 * It is deliberately **not** a domain error: the domain's vocabulary describes governed business
 * failures, and "the database was unreachable" is not one of them.
 */
export interface StorageFailure {
  readonly code: "STORAGE_FAILURE";
  /** PostgreSQL's `SQLSTATE`, when the driver supplied one. */
  readonly sqlState?: string;
  /** The violated constraint's **name**, when the driver supplied one. Never its contents. */
  readonly constraint?: string;
  /** The original driver error. **Non-enumerable**: retained for diagnosis, never serialized. */
  readonly cause: unknown;
}

/**
 * A conservative SQL identifier, used to decide whether a constraint name may be exposed.
 *
 * The name is **server-supplied**, and these repositories authored only lower-case identifiers. A
 * value outside that shape is not echoed: it would be unrecognised text of unknown provenance
 * appearing in an error that callers may log.
 */
const SAFE_CONSTRAINT_NAME = /^[a-z_][a-z0-9_]*$/;

/** A `SQLSTATE`'s shape: exactly five digits or upper-case letters. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * PostgreSQL's `SQLSTATE` for an error, if the driver attached one.
 *
 * **Not every `code` is a `SQLSTATE`.** The driver also surfaces Node system errors, such as
 * `ECONNRESET` or `EPIPE` on a broken socket, with their own `code`. Labelling one of those
 * `sqlState` would claim the server said something it never said (issue #258 §12). A value is
 * kept only when it has a `SQLSTATE`'s shape **and** the error is not a system error: Node gives
 * every system error a numeric `errno` and usually a `syscall`, and a server error has neither.
 * A five-letter system code like `EPIPE` fits the shape, so the shape alone would not do; and a
 * code that names a Node `errno` constant is refused even without those fields. No PostgreSQL
 * `SQLSTATE` class begins with `E`, so no genuine server code is lost.
 */
export function sqlStateOf(cause: unknown): string | undefined {
  const candidate = cause as
    | { readonly code?: unknown; readonly errno?: unknown; readonly syscall?: unknown }
    | null
    | undefined;
  const code = candidate?.code;

  if (typeof code !== "string" || !SQLSTATE.test(code) || Object.hasOwn(constants.errno, code)) {
    return undefined;
  }

  return candidate?.errno === undefined && candidate?.syscall === undefined ? code : undefined;
}

/**
 * The violated constraint's name, if the driver named one **and** it looks like an identifier a
 * repository could have written. Anything else is dropped rather than echoed.
 */
export function constraintOf(cause: unknown): string | undefined {
  const constraint = (cause as { readonly constraint?: unknown } | null)?.constraint;

  return typeof constraint === "string" && SAFE_CONSTRAINT_NAME.test(constraint)
    ? constraint
    : undefined;
}

export function storageFailure(cause: unknown): StorageFailure {
  const sqlState = sqlStateOf(cause);
  const constraint = constraintOf(cause);

  const failure: {
    code: "STORAGE_FAILURE";
    sqlState?: string;
    constraint?: string;
  } = { code: "STORAGE_FAILURE" };

  if (sqlState !== undefined) {
    failure.sqlState = sqlState;
  }

  if (constraint !== undefined) {
    failure.constraint = constraint;
  }

  // Non-enumerable on purpose: see `StorageFailure`. `JSON.stringify`, object spread and most
  // structured loggers walk enumerable properties only, so the driver's `detail` — which can
  // quote the failing row — cannot escape through them.
  Object.defineProperty(failure, "cause", {
    value: cause,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return failure as StorageFailure;
}
