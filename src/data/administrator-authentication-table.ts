/**
 * The Kysely schema typing for the `ADR-028` administrator authentication tables (issue #258).
 *
 * **Every column is typed read-only.** The authentication operations
 * (`administrator-authentication.ts`) write only through raw, labelled SQL, because each
 * statement's shape is fixed by `ADR-028` PS-8 and its required row count by PS-8b. A typed
 * `insertInto` or `updateTable` against these tables therefore does not compile, so no second,
 * unreviewed write path can appear.
 *
 * `ADMINISTRATOR_AUTHENTICATION_COLUMNS` is the exact column set of migration `003`. The
 * `ExactKeys` guards below fail `tsc` if a table interface and that list drift apart, and
 * `third-schema-migration.test.ts` checks the same list against the live catalogue, so the
 * typing, the list and the schema cannot disagree unnoticed.
 *
 * `administrator_recovery_code` is absent on purpose: it is migration `004`, a later slice.
 */

import type { ColumnType } from "kysely";

type ReadOnlyColumn<Select> = ColumnType<Select, never, never>;

/** A governed `timestamptz(3)` instant, read as epoch milliseconds by the governed parser. */
type Instant = ReadOnlyColumn<number>;
type OptionalInstant = ReadOnlyColumn<number | null>;
type Bytes = ReadOnlyColumn<Buffer>;
type OptionalBytes = ReadOnlyColumn<Buffer | null>;

export interface AdministratorTable {
  id: ReadOnlyColumn<string>;
  username: ReadOnlyColumn<string>;
  password_hash: ReadOnlyColumn<string>;
  password_disabled_at: OptionalInstant;
  disabled_at: OptionalInstant;
  created_at: Instant;
}

export interface AdministratorTotpFactorTable {
  administrator_id: ReadOnlyColumn<string>;
  state: ReadOnlyColumn<string>;
  factor_id: ReadOnlyColumn<string | null>;
  secret_ciphertext: OptionalBytes;
  secret_iv: OptionalBytes;
  secret_tag: OptionalBytes;
  key_version: ReadOnlyColumn<number | null>;
  /** `bigint`; `pg` returns it as text, and the operations parse it explicitly. */
  last_accepted_step: ReadOnlyColumn<string | null>;
}

export interface AdministratorPendingChallengeTable {
  token_digest: Bytes;
  administrator_id: ReadOnlyColumn<string>;
  created_at: Instant;
  expires_at: Instant;
  invalidated: ReadOnlyColumn<boolean>;
}

export interface AdministratorConsumedChallengeTable {
  token_digest: Bytes;
  administrator_id: ReadOnlyColumn<string>;
  expires_at: Instant;
}

export interface AdministratorSessionTable {
  token_digest: Bytes;
  id: ReadOnlyColumn<string>;
  administrator_id: ReadOnlyColumn<string>;
  kind: ReadOnlyColumn<string>;
  created_at: Instant;
  last_activity_at: Instant;
  absolute_expires_at: Instant;
}

export interface AuthenticationThrottleTable {
  scope: ReadOnlyColumn<string>;
  subject_digest: Bytes;
  consecutive_failures: ReadOnlyColumn<number>;
  wait_until: OptionalInstant;
  last_failure_at: Instant;
}

export interface AuthenticationSourceWindowTable {
  source_digest: Bytes;
  /** Never read as an array: predicates count its elements in SQL. */
  recent_failures: ReadOnlyColumn<string>;
}

export interface AdministratorAuthenticationDatabase {
  administrator: AdministratorTable;
  administrator_totp_factor: AdministratorTotpFactorTable;
  administrator_pending_challenge: AdministratorPendingChallengeTable;
  administrator_consumed_challenge: AdministratorConsumedChallengeTable;
  administrator_session: AdministratorSessionTable;
  authentication_throttle: AuthenticationThrottleTable;
  authentication_source_window: AuthenticationSourceWindowTable;
}

/** The exact column set of each table migration `003` creates, in declaration order. */
export const ADMINISTRATOR_AUTHENTICATION_COLUMNS = {
  administrator: [
    "id",
    "username",
    "password_hash",
    "password_disabled_at",
    "disabled_at",
    "created_at",
  ],
  administrator_totp_factor: [
    "administrator_id",
    "state",
    "factor_id",
    "secret_ciphertext",
    "secret_iv",
    "secret_tag",
    "key_version",
    "last_accepted_step",
  ],
  administrator_pending_challenge: [
    "token_digest",
    "administrator_id",
    "created_at",
    "expires_at",
    "invalidated",
  ],
  administrator_consumed_challenge: ["token_digest", "administrator_id", "expires_at"],
  administrator_session: [
    "token_digest",
    "id",
    "administrator_id",
    "kind",
    "created_at",
    "last_activity_at",
    "absolute_expires_at",
  ],
  authentication_throttle: [
    "scope",
    "subject_digest",
    "consecutive_failures",
    "wait_until",
    "last_failure_at",
  ],
  authentication_source_window: ["source_digest", "recent_failures"],
} as const satisfies { readonly [T in keyof AdministratorAuthenticationDatabase]: readonly string[] };

type Columns = typeof ADMINISTRATOR_AUTHENTICATION_COLUMNS;

/** `true` only when two key sets are identical; anything else fails the assignment below. */
type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Guarded = {
  readonly [T in keyof AdministratorAuthenticationDatabase]: ExactKeys<
    keyof AdministratorAuthenticationDatabase[T],
    Columns[T][number]
  >;
};

const columnSetsMatchTheTypes: Guarded = {
  administrator: true,
  administrator_totp_factor: true,
  administrator_pending_challenge: true,
  administrator_consumed_challenge: true,
  administrator_session: true,
  authentication_throttle: true,
  authentication_source_window: true,
};

void columnSetsMatchTheTypes;
