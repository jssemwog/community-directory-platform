/**
 * Attacking tests for the decided validation obligations.
 *
 * Under attack: `VR-S1` (the required-at-initial-submission set), `VR-S2` (the
 * before-approval contact minimum, `OQ-8b`), and the only decided, expressible part of
 * the `VR-S3` posture — blankness. No format pattern is asserted anywhere, because none
 * is decided.
 */
import { describe, expect, it } from "vitest";

import { CATEGORY_KEYS, type CategoryKey } from "./category";
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
  category: "food-drink",
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
      // A blank category is part of the violation under test, so it must stay blank.
      // `ListingContent.category` is now `CategoryKey` (#175), so the invalid value is
      // cast **here, locally and narrowly**, rather than the test being weakened: the
      // point is that the runtime boundary still reports it, and a type cannot.
      category: "" as CategoryKey,
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

/**
 * `DI-9`/`VR-2`/`AV-7` — category set membership (issue #175, `ADR-021`).
 *
 * The compile-time narrowing of `ListingContent.category` to `CategoryKey` is **not** the
 * enforcement, so every attacking case below passes its invalid value through a **local,
 * explicit, test-only cast**: that is precisely the untrusted boundary, cast or rehydrated
 * record these validators exist to judge. Weakening an assertion to satisfy the type would
 * delete the test rather than fix it.
 */
describe("category set membership (DI-9, VR-2)", () => {
  /** The narrowest honest runtime-boundary technique: a cast at the point of attack. */
  const withCategory = (category: string): ListingContent => ({
    ...minimalSubmission,
    category: category as CategoryKey,
  });

  it("accepts every one of the 16 approved keys at initial submission (item 11)", () => {
    for (const key of CATEGORY_KEYS) {
      expect(validateInitialSubmission(withCategory(key)).ok).toBe(true);
    }
  });

  it("accepts every one of the 16 approved keys before approval (item 11)", () => {
    for (const key of CATEGORY_KEYS) {
      const result = validateBeforeApproval({
        ...withCategory(key),
        phone: { value: "+353 21 123 4567" },
      });

      expect(result.ok).toBe(true);
    }
  });

  it("rejects an unapproved key with the stable code, naming the field (item 11)", () => {
    const result = validateInitialSubmission(withCategory("artisanal-submarines"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([{ code: "CATEGORY_NOT_APPROVED", field: "category" }]);
    }
  });

  it("rejects each invalid class before approval as well — no privileged bypass (item 11)", () => {
    for (const invalid of [
      "artisanal-submarines",
      "Food & Drink",
      "food-and-drink",
      "retail",
      "other",
      "uncategorized",
      "FOOD-DRINK",
      " food-drink",
      "food-drink ",
      "food_drink",
    ]) {
      const result = validateBeforeApproval({
        ...withCategory(invalid),
        phone: { value: "+353 21 123 4567" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContainEqual({
          code: "CATEGORY_NOT_APPROVED",
          field: "category",
        });
      }
    }
  });

  it("rejects an approved label — the stored identity is the key, never the label", () => {
    const result = validateInitialSubmission(withCategory("Food & Drink"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([{ code: "CATEGORY_NOT_APPROVED", field: "category" }]);
    }
  });

  it("rejects the former fixture values, which were never approved values", () => {
    for (const fixtureOnly of ["food-and-drink", "retail"]) {
      expect(validateInitialSubmission(withCategory(fixtureOnly)).ok).toBe(false);
    }
  });

  it("normalizes nothing: a padded or mis-cased key is rejected, never repaired (item 13)", () => {
    for (const nearMiss of [" food-drink", "food-drink ", " food-drink ", "Food-Drink"]) {
      const result = validateInitialSubmission(withCategory(nearMiss));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Not accepted-after-fixing, and not reported as merely missing.
        expect(result.error).toEqual([{ code: "CATEGORY_NOT_APPROVED", field: "category" }]);
      }
    }
  });

  it("still reports blankness as REQUIRED_VALUE_MISSING, not membership (item 12)", () => {
    for (const blank of ["", " ", "   ", "\t"]) {
      const result = validateInitialSubmission(withCategory(blank));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Exactly one violation: the pre-existing VR-S1 rule, unchanged. A caller who
        // supplied nothing and a caller who supplied an unapproved value have made
        // different mistakes and are told so separately.
        expect(result.error).toEqual([{ code: "REQUIRED_VALUE_MISSING", field: "category" }]);
      }
    }
  });

  it("reports an absent category as REQUIRED_VALUE_MISSING only (item 12)", () => {
    const { category: _omitted, ...withoutCategory } = minimalSubmission;
    const result = validateInitialSubmission(withoutCategory as ListingContent);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([{ code: "REQUIRED_VALUE_MISSING", field: "category" }]);
    }
  });

  it("reports the membership violation alongside every other field at fault (VR-5)", () => {
    const result = validateBeforeApproval({
      ...withCategory("other"),
      name: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([
        { code: "REQUIRED_VALUE_MISSING", field: "name" },
        { code: "CATEGORY_NOT_APPROVED", field: "category" },
        { code: "CONTACT_METHOD_MINIMUM_UNMET", fields: ["phone", "email", "website"] },
      ]);
    }
  });

  it("is deterministic and mutates no input (item 16)", () => {
    const content = withCategory("other");
    const snapshot = JSON.stringify(content);

    const first = validateInitialSubmission(content);
    const second = validateInitialSubmission(content);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(content)).toBe(snapshot);
  });
});
