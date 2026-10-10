/**
 * Attacking tests for the governed category configuration (issue #175, `ADR-021`).
 *
 * The configuration is a **closed, product-decided vocabulary**, so these tests do not merely
 * exercise it — they attempt the violations the governance forbids and fail to achieve them
 * (`CONTRIBUTING.md` Definition of Done item 3).
 *
 * **No second expected-key list is written here.** The labels, definitions and boundary notes
 * are read from **`docs/05` itself**, the authoritative approved vocabulary, so a drift between
 * the running code and the approved document fails this suite rather than passing unnoticed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as categoryModule from "./category";
import {
  CATEGORIES,
  CATEGORY_KEYS,
  categoryFor,
  isCategoryKey,
  type Category,
} from "./category";

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("./category.ts", import.meta.url)),
  "utf8",
);

const REQUIREMENTS_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../docs/05-functional-requirements.md", import.meta.url)),
  "utf8",
);

interface ApprovedRow {
  readonly position: number;
  readonly label: string;
  readonly definition: string;
  readonly boundary: string;
}

/**
 * The approved vocabulary table of `docs/05` *Approved labels, definitions and boundaries*.
 *
 * Only **markup** is removed — the `**bold**` around a label and the `*italics*` around the
 * boundary targets. No word, character, space or punctuation mark is altered, so the
 * comparison below remains byte-for-byte on the approved text itself.
 */
function approvedVocabularyFromRequirements(): readonly ApprovedRow[] {
  const rows: ApprovedRow[] = [];

  for (const line of REQUIREMENTS_SOURCE.split(/\r?\n/)) {
    const match = /^\|\s*(\d+)\s*\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line);

    if (match === null) {
      continue;
    }

    rows.push({
      position: Number(match[1]),
      label: match[2] as string,
      definition: match[3] as string,
      boundary: (match[4] as string).split("*").join(""),
    });
  }

  return rows;
}

const APPROVED = approvedVocabularyFromRequirements();

/** Values the governance explicitly rejected, and fixture strings that were never approved. */
const FORBIDDEN_AND_FIXTURE_VALUES = [
  "other",
  "miscellaneous",
  "uncategorized",
  "events",
  "agriculture",
  "religious-faith-organizations",
  "health-wellness",
  "food-and-drink",
  "retail",
] as const;

describe("the approved vocabulary is read from docs/05, not from a second list here", () => {
  it("found exactly the 16 approved rows", () => {
    expect(APPROVED).toHaveLength(16);
    expect(APPROVED.map((row) => row.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });
});

describe("shape and size of the configuration", () => {
  it("holds exactly 16 entries (item 1)", () => {
    expect(CATEGORIES).toHaveLength(16);
    expect(CATEGORY_KEYS).toHaveLength(16);
  });

  it("holds 16 unique keys and 16 unique labels (item 1)", () => {
    expect(new Set(CATEGORIES.map((category) => category.key)).size).toBe(16);
    expect(new Set(CATEGORIES.map((category) => category.label)).size).toBe(16);
  });

  it("carries a non-empty definition and boundary note on every entry (item 6)", () => {
    for (const category of CATEGORIES) {
      expect(category.definition.trim().length).toBeGreaterThan(0);
      expect(category.boundary.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("the machine keys obey the approved convention", () => {
  it("matches the stable-key grammar exactly (item 2)", () => {
    for (const key of CATEGORY_KEYS) {
      expect(key).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("retains no 'and' anywhere in any key (item 2)", () => {
    for (const key of CATEGORY_KEYS) {
      expect(key.split("-")).not.toContain("and");
    }
  });

  it("collides with no rejected or fixture-only value (item 2)", () => {
    for (const forbidden of FORBIDDEN_AND_FIXTURE_VALUES) {
      expect(CATEGORY_KEYS).not.toContain(forbidden);
    }
  });

  it("is not derived from a label at runtime (item 9)", () => {
    // A key generated from its label would make the one-to-one mapping an accident of string
    // manipulation rather than an approved decision, and would silently invent a key for any
    // future label. The module must therefore contain no case-folding, slugifying or
    // normalizing operation at all.
    for (const forbiddenOperation of [
      "toLowerCase",
      "toUpperCase",
      "normalize",
      "replace",
      "replaceAll",
      "slugify",
    ]) {
      expect(MODULE_SOURCE).not.toContain(`${forbiddenOperation}(`);
    }
  });
});

describe("the mapping and order match the approved document", () => {
  it("is in the approved alphabetical display order (item 5)", () => {
    expect(CATEGORIES.map((category) => category.label)).toEqual(
      APPROVED.map((row) => row.label),
    );
  });

  it("matches docs/05 byte-for-byte on label, definition and boundary (items 3, 4, 6)", () => {
    expect(
      CATEGORIES.map(({ label, definition, boundary }) => ({ label, definition, boundary })),
    ).toEqual(
      APPROVED.map(({ label, definition, boundary }) => ({ label, definition, boundary })),
    );
  });

  it("maps key to label one-to-one, in both directions (item 3)", () => {
    // Typed over `string` on both sides deliberately: the point is to look each value up by
    // the *other* one and get back where it started, which a narrowed key type would make
    // unexpressible.
    const keyByLabel = new Map<string, string>(
      CATEGORIES.map((category) => [category.label, category.key]),
    );
    const labelByKey = new Map<string, string>(
      CATEGORIES.map((category) => [category.key, category.label]),
    );

    expect(keyByLabel.size).toBe(16);
    expect(labelByKey.size).toBe(16);

    for (const category of CATEGORIES) {
      expect(labelByKey.get(keyByLabel.get(category.label) as string)).toBe(category.label);
      expect(keyByLabel.get(labelByKey.get(category.key) as string)).toBe(category.key);
    }
  });
});

describe("the derived surfaces agree with the records (item 7)", () => {
  it("derives the key list from the records in order", () => {
    expect([...CATEGORY_KEYS]).toEqual(CATEGORIES.map((category) => category.key));
  });

  it("resolves every key back to its own record through the lookup", () => {
    for (const category of CATEGORIES) {
      expect(categoryFor(category.key)).toEqual(category);
    }
  });

  it("resolves nothing for an unapproved, blank or non-string key", () => {
    for (const candidate of [
      "food-and-drink",
      "Food & Drink",
      " food-drink ",
      "",
      "   ",
      null,
      undefined,
      42,
      {},
      ["food-drink"],
    ]) {
      expect(categoryFor(candidate)).toBeUndefined();
    }
  });
});

describe("isCategoryKey (item 8)", () => {
  it("accepts all 16 approved keys", () => {
    for (const key of CATEGORY_KEYS) {
      expect(isCategoryKey(key)).toBe(true);
    }
  });

  it("rejects every approved label — the stored identity is the key, never the label", () => {
    for (const category of CATEGORIES) {
      expect(isCategoryKey(category.label)).toBe(false);
    }
  });

  it("rejects rejected vocabulary and fixture-only strings", () => {
    for (const forbidden of FORBIDDEN_AND_FIXTURE_VALUES) {
      expect(isCategoryKey(forbidden)).toBe(false);
    }
  });

  it("rejects case variants without normalizing them (item 13)", () => {
    for (const variant of [
      "Food-Drink",
      "FOOD-DRINK",
      "food-Drink",
      "Retail-Shopping",
      "ARTS-CULTURE-ENTERTAINMENT",
    ]) {
      expect(isCategoryKey(variant)).toBe(false);
    }
  });

  it("rejects whitespace-padded approved keys without trimming them (item 13)", () => {
    for (const padded of [
      " food-drink",
      "food-drink ",
      " food-drink ",
      "\tfood-drink",
      "food-drink\n",
      "food -drink",
    ]) {
      expect(isCategoryKey(padded)).toBe(false);
    }
  });

  it("rejects malformed and near-miss keys", () => {
    for (const malformed of [
      "food_drink",
      "food--drink",
      "-food-drink",
      "food-drink-",
      "fooddrink",
      "food-drinks",
      "food-and-drink-2",
      "arts-culture",
    ]) {
      expect(isCategoryKey(malformed)).toBe(false);
    }
  });

  it("rejects empty and whitespace-only values", () => {
    for (const blank of ["", " ", "   ", "\t", "\n", " "]) {
      expect(isCategoryKey(blank)).toBe(false);
    }
  });

  it("rejects null, undefined and non-strings", () => {
    for (const candidate of [
      null,
      undefined,
      0,
      1,
      Number.NaN,
      true,
      false,
      {},
      [],
      ["food-drink"],
      new String("food-drink"),
      Symbol("food-drink"),
      () => "food-drink",
      { key: "food-drink" },
      { toString: () => "food-drink" },
    ]) {
      expect(isCategoryKey(candidate)).toBe(false);
    }
  });

  it("is deterministic and leaves the configuration unchanged (item 16)", () => {
    const before = JSON.stringify(CATEGORIES);

    for (let round = 0; round < 3; round += 1) {
      expect(CATEGORY_KEYS.every((key) => isCategoryKey(key))).toBe(true);
      expect(isCategoryKey("food-and-drink")).toBe(false);
    }

    expect(JSON.stringify(CATEGORIES)).toBe(before);
  });
});

describe("the configuration is frozen at runtime (item 10)", () => {
  it("refuses mutation of the category array", () => {
    const mutable = CATEGORIES as Category[];

    // `key` is the narrowed union, so smuggling an unapproved one past the compiler needs an
    // explicit widening. That is the attack: the **runtime** freeze must stop it regardless
    // of what the type system was told.
    expect(() =>
      mutable.push({ ...CATEGORIES[0], key: "smuggled" } as unknown as Category),
    ).toThrow(TypeError);
    expect(() => mutable.pop()).toThrow(TypeError);
    expect(() => {
      mutable[0] = { ...CATEGORIES[1] } as Category;
    }).toThrow(TypeError);
    expect(CATEGORIES).toHaveLength(16);
  });

  it("refuses mutation of the key array", () => {
    const mutable = CATEGORY_KEYS as string[];

    expect(() => mutable.push("smuggled")).toThrow(TypeError);
    expect(CATEGORY_KEYS).toHaveLength(16);
  });

  it("refuses mutation of an individual record", () => {
    const record = CATEGORIES[0] as { key: string; label: string };

    expect(() => {
      record.key = "smuggled";
    }).toThrow(TypeError);
    expect(() => {
      record.label = "Smuggled";
    }).toThrow(TypeError);
    expect(CATEGORIES[0].key).toBe("arts-culture-entertainment");
  });

  it("does not expose the mutable records or the private membership index", () => {
    // Adding a key to a leaked `Set` or `Map`, or to the underlying record array, would widen
    // the approved vocabulary at runtime — which only a governed Product Owner decision,
    // applied through a deployment, may do.
    const surface = Object.keys(categoryModule);

    expect(surface).not.toContain("KEYS");
    expect(surface).not.toContain("BY_KEY");
    expect(surface).not.toContain("CATEGORY_RECORDS");
    expect([...surface].sort()).toEqual(
      ["CATEGORIES", "CATEGORY_KEYS", "categoryFor", "isCategoryKey"].sort(),
    );
  });
});
