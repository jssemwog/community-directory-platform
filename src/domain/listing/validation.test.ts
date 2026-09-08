/**
 * Attacking tests for the decided validation obligations.
 *
 * Under attack: `VR-S1` (the required-at-initial-submission set), `VR-S2` (the
 * before-approval contact minimum, `OQ-8b`), and the only decided, expressible part of
 * the `VR-S3` posture — blankness. No format pattern is asserted anywhere, because none
 * is decided.
 */
import { describe, expect, it } from "vitest";

import type { ListingContent } from "./listing";
import {
  CONTACT_METHOD_FIELDS,
  REQUIRED_AT_INITIAL_SUBMISSION,
  isUsableValue,
  usableContactMethodsOf,
  validateBeforeApproval,
  validateInitialSubmission,
} from "./validation";

const minimalSubmission: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

describe("the decided obligation sets", () => {
  it("requires exactly the five OQ-8 fields at initial submission", () => {
    expect([...REQUIRED_AT_INITIAL_SUBMISSION]).toEqual([
      "name",
      "category",
      "description",
      "locality",
      "country",
    ]);
  });

  it("recognises exactly the three FR-DATA-07 contact methods", () => {
    expect([...CONTACT_METHOD_FIELDS]).toEqual(["phone", "email", "website"]);
  });
});

describe("usability — the expressible part of VR-S3", () => {
  it.each([undefined, "", " ", "\t", "\n", "   \n  "])(
    "treats %o as unusable",
    (candidate) => {
      expect(isUsableValue(candidate)).toBe(false);
    },
  );

  it.each([
    "a",
    "+353 21 000 0000",
    "0035321000000",
    "hello@example.test",
    "hello+tag@sub.example.test",
    "https://example.test",
    "example.test",
    "  padded  ",
    "書店",
  ])("treats %o as usable — the posture is permissive, not a pattern", (candidate) => {
    expect(isUsableValue(candidate)).toBe(true);
  });
});

describe("initial submission (VR-S1, FR-VAL-01)", () => {
  it("accepts a submission carrying only the five required fields", () => {
    const result = validateInitialSubmission(minimalSubmission);

    expect(result.ok).toBe(true);
  });

  it("accepts a submission with no phone, email, or website (FR-SUB-05, OQ-8b)", () => {
    const result = validateInitialSubmission(minimalSubmission);

    expect(result.ok).toBe(true);
    expect(usableContactMethodsOf(minimalSubmission)).toHaveLength(0);
  });

  it.each(REQUIRED_AT_INITIAL_SUBMISSION)(
    "rejects a submission whose %s is missing, and names that field",
    (field) => {
      const result = validateInitialSubmission({ ...minimalSubmission, [field]: "" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual([{ code: "REQUIRED_VALUE_MISSING", field }]);
      }
    },
  );

  it.each(REQUIRED_AT_INITIAL_SUBMISSION)(
    "rejects a %s of whitespace alone",
    (field) => {
      const result = validateInitialSubmission({ ...minimalSubmission, [field]: "   " });

      expect(result.ok).toBe(false);
    },
  );

  it("names every field at fault, not merely the first (VR-5, FR-VAL-02)", () => {
    const result = validateInitialSubmission({
      name: "",
      category: "",
      description: "",
      locality: "",
      country: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.map((violation) => violation.code)).toEqual(
        REQUIRED_AT_INITIAL_SUBMISSION.map(() => "REQUIRED_VALUE_MISSING"),
      );
      expect(
        result.error.map((violation) =>
          violation.code === "REQUIRED_VALUE_MISSING" ? violation.field : null,
        ),
      ).toEqual([...REQUIRED_AT_INITIAL_SUBMISSION]);
    }
  });

  it("does not apply the contact minimum at this stage (FR-VAL-01)", () => {
    const result = validateInitialSubmission(minimalSubmission);

    expect(result.ok).toBe(true);
  });

  it("reports failure as a value rather than throwing", () => {
    expect(() =>
      validateInitialSubmission({ ...minimalSubmission, name: "" }),
    ).not.toThrow();
  });
});

describe("before approval (VR-S2, FR-DATA-08, OQ-8b)", () => {
  it("refuses to approve a record carrying no contact method", () => {
    const result = validateBeforeApproval(minimalSubmission);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([
        {
          code: "CONTACT_METHOD_MINIMUM_UNMET",
          fields: ["phone", "email", "website"],
        },
      ]);
    }
  });

  it.each(CONTACT_METHOD_FIELDS)("accepts a record whose only contact is %s", (field) => {
    const result = validateBeforeApproval({
      ...minimalSubmission,
      [field]: { value: "supplied" },
    });

    expect(result.ok).toBe(true);
  });

  it("does not count a blank contact value toward the minimum", () => {
    for (const blank of ["", "   ", "\n"]) {
      const result = validateBeforeApproval({
        ...minimalSubmission,
        phone: { value: blank },
        email: { value: blank },
        website: { value: blank },
      });

      expect(result.ok).toBe(false);
    }
  });

  it("counts a contact method the business withheld from public display", () => {
    // Usability is structural; the OQ-7 public designation is a separate question.
    const result = validateBeforeApproval({
      ...minimalSubmission,
      email: { value: "private@example.test", designatedPublic: false },
    });

    expect(result.ok).toBe(true);
  });

  it("never lets location information satisfy the contact minimum", () => {
    const result = validateBeforeApproval({
      ...minimalSubmission,
      administrativeArea: "County Cork",
      postalCode: { value: "P17 XY12", designatedPublic: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual({
        code: "CONTACT_METHOD_MINIMUM_UNMET",
        fields: ["phone", "email", "website"],
      });
    }
  });

  it("reports both a missing required field and the unmet contact minimum together", () => {
    const result = validateBeforeApproval({ ...minimalSubmission, country: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([
        { code: "REQUIRED_VALUE_MISSING", field: "country" },
        { code: "CONTACT_METHOD_MINIMUM_UNMET", fields: ["phone", "email", "website"] },
      ]);
    }
  });

  it("applies the same rules whether the content is a submission or a revision (VR-6)", () => {
    // No privileged bypass exists: the before-approval rule set is one function.
    const revisionContent: ListingContent = { ...minimalSubmission, name: "" };

    expect(validateBeforeApproval(revisionContent).ok).toBe(false);
    expect(validateInitialSubmission(revisionContent).ok).toBe(false);
  });
});
