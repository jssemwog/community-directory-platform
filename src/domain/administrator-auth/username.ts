/**
 * Administrator usernames (`ADR-028` D-1, issue #258).
 *
 * A provisioned username is lower-case ASCII matching `PROVISIONABLE_USERNAME`; migration `003`
 * enforces the same form with `administrator_username_check`. A **submitted** username is
 * NFC-normalized and lower-cased before lookup and before throttle keying, so known and unknown
 * names are throttled alike (`ADR-004` P-5).
 */

/** D-1: the provisioning form. Identical to the `administrator_username_check` pattern. */
export const PROVISIONABLE_USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** D-1: the normalization applied to every submitted username, before anything else. */
export function normalizeSubmittedUsername(submitted: string): string {
  return submitted.normalize("NFC").toLowerCase();
}

/** Whether a normalized username could be stored at all; anything else is unknown by form. */
export function isProvisionableUsername(normalized: string): boolean {
  return PROVISIONABLE_USERNAME.test(normalized);
}
