/**
 * `003` — the administrator authentication tables (issue #258).
 *
 * **This migration implements an already accepted decision and creates no new policy.** It
 * creates exactly the seven tables `ADR-028` (`Accepted` 2026-11-01, issue #256) assigns to
 * migration `003`, with the constraints of its PS-2 to PS-7:
 *
 * - `administrator` — identity and password credential (PS-2);
 * - `administrator_totp_factor` — encrypted TOTP material and replay state (PS-3);
 * - `administrator_pending_challenge` and `administrator_consumed_challenge` — pending
 *   challenges and the D-15 consumed-challenge record (PS-4);
 * - `administrator_session` — full and restricted recovery sessions (PS-5);
 * - `authentication_throttle` and `authentication_source_window` — abuse-control state,
 *   the latter as the D-6 bounded rolling record (PS-7).
 *
 * `administrator_recovery_code` is **not** created here: `ADR-028` assigns it to migration
 * `004`, with the recovery slice. Recovery-code issuance therefore stays deferred, and
 * **complete `ADR-004` provisioning remains required before any public reachability**.
 *
 * - **`ADR-018`** — raw PostgreSQL DDL through Kysely's `sql` tag, as `001` and `002`.
 * - **`ADR-019` posture** (PS-1 rule 1) — every identifier is supplied by the application;
 *   no column has a generation default.
 * - **`ADR-022` posture** (PS-1 rule 2) — every instant is `timestamptz(3)` and no column has
 *   a clock default; every expiry predicate is written by the caller against its own `$now`.
 * - **PS-1 rule 3** — every foreign key is `ON DELETE NO ACTION`. Nothing cascades and no
 *   deletion operation exists. This is the scope of the design, **not a retention policy**:
 *   retention and deletion stay with `OQ-14` + `NOQ-8` and `NOQ-7` (D-11).
 *
 * **Every `CHECK` is kept determinate.** A `CHECK` that evaluates to UNKNOWN is satisfied, so
 * each consistency rule below tests nullability explicitly (the reason `001` records for its
 * own publication-state check). The length checks on nullable `bytea` columns are lenient on
 * null on purpose: a null is governed by the material-consistency check instead.
 *
 * **Deliberate omissions** (PS-9): no event, history or attempt-log table; no raw client
 * address or raw submitted username; no default, trigger, cascade, `pgcrypto` call or stored
 * procedure; no session payload or role column.
 *
 * **The `down` is honest only while no real account can exist.** It drops exactly the seven
 * tables. Under issue #254 every account that can be stored is synthetic and local, so the
 * reversal loses nothing that matters; that condition must be re-examined before any
 * non-local use, as `001` and `002` record for their own reversals.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table administrator (
      id uuid not null,
      username text not null,
      password_hash text not null,
      password_disabled_at timestamptz(3),
      disabled_at timestamptz(3),
      created_at timestamptz(3) not null,

      constraint administrator_pkey primary key (id),
      constraint administrator_username_key unique (username),

      -- D-1: the provisioning form, stored only normalized.
      constraint administrator_username_check
        check (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),

      -- D-2: the self-describing scrypt encoding.
      constraint administrator_password_hash_check
        check (password_hash like 'scrypt$%')
    )
  `.execute(db);

  await sql`
    create table administrator_totp_factor (
      administrator_id uuid not null,
      state text not null,
      factor_id uuid,
      secret_ciphertext bytea,
      secret_iv bytea,
      secret_tag bytea,
      key_version integer,
      last_accepted_step bigint,

      constraint administrator_totp_factor_pkey primary key (administrator_id),
      constraint administrator_totp_factor_administrator_fkey
        foreign key (administrator_id) references administrator (id) on delete no action,
      constraint administrator_totp_factor_factor_id_key unique (factor_id),

      constraint administrator_totp_factor_state_check
        check (state in ('pending_confirmation', 'active', 'reenrolment_required')),
      constraint administrator_totp_factor_ciphertext_length_check
        check (octet_length(secret_ciphertext) = 20),
      constraint administrator_totp_factor_iv_length_check
        check (octet_length(secret_iv) = 12),
      constraint administrator_totp_factor_tag_length_check
        check (octet_length(secret_tag) = 16),
      constraint administrator_totp_factor_key_version_check
        check (key_version > 0),
      constraint administrator_totp_factor_step_check
        check (last_accepted_step >= 0),

      -- Material present if and only if usable (PS-3), including the D-13 factor version.
      constraint administrator_totp_factor_material_check
        check (
          case
            when state = 'reenrolment_required' then
              factor_id is null and secret_ciphertext is null and secret_iv is null
                and secret_tag is null and key_version is null
            else
              factor_id is not null and secret_ciphertext is not null and secret_iv is not null
                and secret_tag is not null and key_version is not null
          end
        ),

      -- An active factor has replay state.
      constraint administrator_totp_factor_replay_state_check
        check (state <> 'active' or last_accepted_step is not null)
    )
  `.execute(db);

  await sql`
    create table administrator_pending_challenge (
      token_digest bytea not null,
      administrator_id uuid not null,
      created_at timestamptz(3) not null,
      expires_at timestamptz(3) not null,
      invalidated boolean not null,

      constraint administrator_pending_challenge_pkey primary key (token_digest),
      constraint administrator_pending_challenge_administrator_fkey
        foreign key (administrator_id) references administrator (id) on delete no action,
      constraint administrator_pending_challenge_digest_length_check
        check (octet_length(token_digest) = 32),

      -- ADR-004 P-1: a pending challenge lives 5 minutes (D-10).
      constraint administrator_pending_challenge_lifetime_check
        check (expires_at = created_at + interval '5 minutes')
    )
  `.execute(db);

  await sql`
    create table administrator_consumed_challenge (
      token_digest bytea not null,
      administrator_id uuid not null,
      expires_at timestamptz(3) not null,

      constraint administrator_consumed_challenge_pkey primary key (token_digest),
      constraint administrator_consumed_challenge_administrator_fkey
        foreign key (administrator_id) references administrator (id) on delete no action,
      constraint administrator_consumed_challenge_digest_length_check
        check (octet_length(token_digest) = 32)
    )
  `.execute(db);

  await sql`
    create table administrator_session (
      token_digest bytea not null,
      id uuid not null,
      administrator_id uuid not null,
      kind text not null,
      created_at timestamptz(3) not null,
      last_activity_at timestamptz(3) not null,
      absolute_expires_at timestamptz(3) not null,

      constraint administrator_session_pkey primary key (token_digest),
      constraint administrator_session_id_key unique (id),
      constraint administrator_session_administrator_fkey
        foreign key (administrator_id) references administrator (id) on delete no action,
      constraint administrator_session_digest_length_check
        check (octet_length(token_digest) = 32),
      constraint administrator_session_kind_check
        check (kind in ('administrator', 'recovery')),
      constraint administrator_session_activity_check
        check (last_activity_at >= created_at),

      -- ADR-004 P-1 lifetimes as constraints (D-10): 12 hours full, 15 minutes recovery.
      constraint administrator_session_lifetime_check
        check (
          (kind = 'administrator' and absolute_expires_at = created_at + interval '12 hours')
          or (kind = 'recovery' and absolute_expires_at = created_at + interval '15 minutes')
        )
    )
  `.execute(db);

  await sql`
    create table authentication_throttle (
      scope text not null,
      subject_digest bytea not null,
      consecutive_failures integer not null,
      wait_until timestamptz(3),
      last_failure_at timestamptz(3) not null,

      constraint authentication_throttle_pkey primary key (scope, subject_digest),
      constraint authentication_throttle_scope_check
        check (scope in ('password', 'totp', 'recovery_code')),
      constraint authentication_throttle_digest_length_check
        check (octet_length(subject_digest) = 32),
      -- Zero only for a row that exists so that it can be locked (PS-1 rule 4).
      constraint authentication_throttle_failures_check
        check (consecutive_failures >= 0),
      -- ADR-004 P-5: a wait exists from the 5th consecutive failure, and only then.
      constraint authentication_throttle_wait_check
        check ((consecutive_failures >= 5) = (wait_until is not null))
    )
  `.execute(db);

  await sql`
    create table authentication_source_window (
      source_digest bytea not null,
      recent_failures timestamptz(3)[] not null,

      constraint authentication_source_window_pkey primary key (source_digest),
      constraint authentication_source_window_digest_length_check
        check (octet_length(source_digest) = 32),
      -- D-6: at most the 20 most recent failure instants; empty only while locked.
      constraint authentication_source_window_cardinality_check
        check (cardinality(recent_failures) between 0 and 20)
    )
  `.execute(db);
}

/**
 * Drop exactly the seven tables, dependants first. The module header records why this
 * reversal is honest only while every stored account is synthetic and local.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table authentication_source_window`.execute(db);
  await sql`drop table authentication_throttle`.execute(db);
  await sql`drop table administrator_session`.execute(db);
  await sql`drop table administrator_consumed_challenge`.execute(db);
  await sql`drop table administrator_pending_challenge`.execute(db);
  await sql`drop table administrator_totp_factor`.execute(db);
  await sql`drop table administrator`.execute(db);
}
