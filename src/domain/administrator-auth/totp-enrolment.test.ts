/** The shared `otpauth://` enrolment URI (issue #268 §6.1, §6.4 equivalence and RJ-D4). */

import { describe, expect, it } from "vitest";

import { enrolmentUriOf, RECOVERY_ENROLMENT_LABEL, TOTP_ISSUER } from "./totp-enrolment";

describe("enrolmentUriOf", () => {
  it("gives the ADR-004 parameters, the issuer and the matching base32 secret", () => {
    const secret = Buffer.alloc(20, 7);
    const { uri, base32 } = enrolmentUriOf("synthetic-ada", secret);
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
    expect(parsed.searchParams.get("secret")).toBe(base32);
    expect(parsed.searchParams.get("issuer")).toBe(TOTP_ISSUER);
    expect(decodeURIComponent(parsed.pathname)).toBe(`/${TOTP_ISSUER}:synthetic-ada`);
  });

  it("labels a recovery re-enrolment with the fixed label, never a username (RJ-D4)", () => {
    const { uri } = enrolmentUriOf(RECOVERY_ENROLMENT_LABEL, Buffer.alloc(20, 9));

    expect(RECOVERY_ENROLMENT_LABEL).toBe("synthetic administrator");
    expect(decodeURIComponent(new URL(uri).pathname)).toBe(`/${TOTP_ISSUER}:synthetic administrator`);
  });

  it("does not alter the secret it is given", () => {
    const secret = Buffer.alloc(20, 3);
    enrolmentUriOf("synthetic-ada", secret);
    expect(secret).toEqual(Buffer.alloc(20, 3));
  });
});
