/**
 * TOTP over `otpauth` (`ADR-004` P-3, issue #258).
 *
 * SHA-1, 6 digits, a 30-second step and one step either side, as `ADR-004` approves; `otpauth`
 * is pinned at 9.5.2 (L-1). `matchTotpStep` returns the **absolute** RFC 6238 time step a code
 * matched, because replay prevention compares steps (`ADR-004` P-7, `last_accepted_step`), not
 * codes. The secret is 20 random bytes (160 bits).
 */

import { randomBytes } from "node:crypto";

import { Secret, TOTP } from "otpauth";

export const TOTP_SECRET_BYTES = 20;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const CODE_FORM = /^[0-9]{6}$/;

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

function totpFor(secret: Buffer): TOTP {
  const copy = new Uint8Array(secret);
  return new TOTP({
    secret: new Secret({ buffer: copy.buffer }),
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  });
}

/** The RFC 6238 time step containing an instant. */
export function totpStepAt(epochMilliseconds: number): number {
  return Math.floor(epochMilliseconds / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for an instant. Used to confirm an enrolment, and by tests. */
export function totpCodeAt(secret: Buffer, epochMilliseconds: number): string {
  return totpFor(secret).generate({ timestamp: epochMilliseconds });
}

/** The absolute step a code matches within the window, or `null` if it matches none. */
export function matchTotpStep(
  secret: Buffer,
  code: string,
  epochMilliseconds: number,
): number | null {
  if (!CODE_FORM.test(code)) {
    return null;
  }

  const delta = totpFor(secret).validate({
    token: code,
    timestamp: epochMilliseconds,
    window: TOTP_WINDOW,
  });

  return delta === null ? null : totpStepAt(epochMilliseconds) + delta;
}
