/**
 * The `otpauth://` enrolment URI an authenticator app reads (`ADR-004` P-3; issue #268 §3.4,
 * RJ-D4 and RJ-D14).
 *
 * One builder serves both the provisioning command and the recovery re-enrolment start, so the
 * two can never drift apart. The URI carries the TOTP secret, so a caller shows it **once**, as
 * text only: never in a link, a navigation, a `Location`, a query string or any resource request.
 */

import { Secret, TOTP } from "otpauth";

import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "./totp";

export const TOTP_ISSUER = "Community Directory (local synthetic)";

/**
 * The fixed account label for a re-enrolment started from a recovery session (RJ-D4). No merged
 * operation returns the username there, and an unverified typed name is never put in a label.
 */
export const RECOVERY_ENROLMENT_LABEL = "synthetic administrator";

/** The enrolment URI and the matching base32 secret for `label` (a username, or the fixed label). */
export function enrolmentUriOf(label: string, secret: Buffer): { readonly uri: string; readonly base32: string } {
  const copy = new Uint8Array(secret);
  const shared = new Secret({ buffer: copy.buffer });
  const totp = new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: shared,
  });

  return { uri: totp.toString(), base32: shared.base32 };
}
