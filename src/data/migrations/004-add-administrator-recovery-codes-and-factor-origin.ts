/**
 * `004` — recovery codes and the TOTP factor's recovery origin (issue #266).
 *
 * **This migration implements an already accepted decision and creates no new policy.** It
 * creates what `ADR-029` (`Accepted` 2026-11-03, issue #264) assigns to migration `004`, as
 * specified exactly by the implementation Scope Gate (issue #266, Annex A.4):
 *
 * - `administrator_recovery_code`, as `ADR-028` PS-6 defines it, carried forward by `ADR-029`:
 *   one row per unused code, holding only its SHA-256 digest. A used code is deleted, so there is
 *   no "used" column;
 * - `administrator_totp_factor.origin_recovery_session_id` and
 *   `administrator_totp_factor_origin_check` (`ADR-029` RA-3). The column records the non-secret
 *   id of the recovery session that started a pending factor. The `CHECK` lets an origin exist
 *   only on a `pending_confirmation` factor, so it is current state, never history.
 *
 * Migration `003` is not edited.
 *
 * - **`ADR-018`** — raw PostgreSQL DDL through Kysely's `sql` tag, as `001` to `003`.
 * - **No default and no foreign key** on the new column (`ADR-022` posture; sessions are
 *   deleted, so a foreign key would block that). Existing factor rows read `NULL`, which the new
 *   `CHECK` admits for every state.
 * - **Every foreign key is `ON DELETE NO ACTION`** (`ADR-028` PS-1 rule 3). No default, trigger,
 *   cascade or extension.
 *
 * **The new `CHECK` intentionally changes one existing behaviour without editing its source**
 * (`ADR-029` RA-3). `confirmTotpEnrolment` leaves the origin untouched, so when it names a factor
 * with a recovery origin its activation `UPDATE` violates the `CHECK`, and the transaction rolls
 * back. For a factor with a `NULL` origin it behaves exactly as before.
 *
 * **The `down` is destructive.** It deletes every recovery code and every recorded origin, and
 * they cannot be restored. Under `ADR-018` that is honest only while synthetic local data alone
 * can exist, on the same basis as `003`'s reversal (issue #254). Non-synthetic data would need
 * separate explicit authorization.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table administrator_recovery_code (
      administrator_id uuid not null,
      code_digest bytea not null,
      constraint administrator_recovery_code_pkey
        primary key (administrator_id, code_digest),
      constraint administrator_recovery_code_administrator_fkey
        foreign key (administrator_id) references administrator (id) on delete no action,
      constraint administrator_recovery_code_digest_length_check
        check (octet_length(code_digest) = 32)
    )
  `.execute(db);

  await sql`
    alter table administrator_totp_factor
      add column origin_recovery_session_id uuid
  `.execute(db);

  await sql`
    alter table administrator_totp_factor
      add constraint administrator_totp_factor_origin_check
        check (origin_recovery_session_id is null or state = 'pending_confirmation')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table administrator_totp_factor drop constraint administrator_totp_factor_origin_check`.execute(db);
  await sql`alter table administrator_totp_factor drop column origin_recovery_session_id`.execute(db);
  await sql`drop table administrator_recovery_code`.execute(db);
}
