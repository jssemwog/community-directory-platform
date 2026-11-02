/** D-1 username normalization and form (issue #258). */

import { describe, expect, it } from "vitest";

import { isProvisionableUsername, normalizeSubmittedUsername } from "./username";

describe("username normalization (D-1)", () => {
  it("lower-cases and NFC-normalizes a submitted username", () => {
    expect(normalizeSubmittedUsername("Admin.One")).toBe("admin.one");
    // U+0065 U+0301 composes to U+00E9 under NFC.
    expect(normalizeSubmittedUsername("Cafe" + String.fromCharCode(0x301))).toBe(
      "caf" + String.fromCharCode(0xe9),
    );
  });

  it("accepts exactly the provisioning form", () => {
    for (const ok of ["abc", "a.b-c_d", "0admin", "a".repeat(64)]) {
      expect(isProvisionableUsername(ok)).toBe(true);
    }

    for (const bad of ["ab", "-abc", ".abc", "Abc", "a b", "a".repeat(65), "caf" + String.fromCharCode(0xe9)]) {
      expect(isProvisionableUsername(bad)).toBe(false);
    }
  });
});
