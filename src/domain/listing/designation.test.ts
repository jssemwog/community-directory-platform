/**
 * Attacking tests for the `ADR-025` designation policy (issue #205).
 *
 * Pure domain: no cluster, no clock, no I/O, no sleep and no duration in any assertion. The
 * whole matrix is exercised per field, and the cases that matter most are the ones where a
 * value a business withheld could become public.
 *
 * **The transition matrix is table-driven across all four governed fields deliberately.** The
 * policy's worst failure mode is not getting one case wrong — it is getting one *field* wrong,
 * which a hand-written test per case would miss. So every case is asserted for `postalCode`,
 * `phone`, `email` and `website` from one table, and skipping any field fails four tests rather
 * than none.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  classifyDesignatableChange,
  enforceDesignationPolicy,
  type DesignatableField,
  type DesignationChange,
  type DesignationViolation,
} from "./designation";
import type { DesignatableValue, ListingContent } from "./listing";
import type { ValidationViolation } from "./validation";

/** The governed fields, in the order the policy evaluates them. Pinned by test, not imported. */
const FIELDS = ["postalCode", "phone", "email", "website"] as const;

/** Content that is valid by the existing rules, so no fixture depends on malformed input. */
const BASE: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

function withField(field: DesignatableField, value: DesignatableValue | undefined): ListingContent {
  return value === undefined ? { ...BASE } : { ...BASE, [field]: value };
}

/** A representative valid carrier per field, so comparisons are never between nonsense. */
const CARRIER: Record<DesignatableField, string> = {
  postalCode: "P17 AB12",
  phone: "+353 21 123 4567",
  email: "hello@example.ie",
  website: "https://example.ie",
};

/** A different valid carrier per field, for the replacement cases. */
const OTHER: Record<DesignatableField, string> = {
  postalCode: "P17 CD34",
  phone: "+353 21 765 4321",
  email: "contact@example.ie",
  website: "https://example.ie/contact",
};

const violation = (
  field: DesignatableField,
  change: DesignationChange,
): DesignationViolation => ({ code: "DESIGNATION_WIDENING_REFUSED", field, change });

describe("the ADR-025 classification, per field", () => {
  it.each(FIELDS)("classifies absent → absent as unchanged (%s)", (field) => {
    expect(classifyDesignatableChange(undefined, undefined)).toBe("unchanged");
    expect(
      enforceDesignationPolicy(withField(field, undefined), withField(field, undefined)).ok,
    ).toBe(true);
  });

  it.each(FIELDS)("classifies an exactly equal carrier as unchanged (%s)", (field) => {
    const same = { value: CARRIER[field] };

    expect(classifyDesignatableChange(same, { value: CARRIER[field] })).toBe("unchanged");
  });

  it.each(FIELDS)("classifies present → absent as removed, never unchanged (%s)", (field) => {
    // `ADR-017`'s proposal is a complete set, so an absent value is an explicit removal. If this
    // were read as omission or preservation the classification would say "unchanged".
    expect(classifyDesignatableChange({ value: CARRIER[field] }, undefined)).toBe("removed");
  });

  it.each(FIELDS)("classifies absent → present as added (%s)", (field) => {
    expect(classifyDesignatableChange(undefined, { value: CARRIER[field] })).toBe("added");
  });

  it.each(FIELDS)("classifies a different carrier as replaced (%s)", (field) => {
    expect(
      classifyDesignatableChange({ value: CARRIER[field] }, { value: OTHER[field] }),
    ).toBe("replaced");
  });

  it.each(FIELDS)("a designation change alone never makes a value a replacement (%s)", (field) => {
    // This is what allows an unchanged value to be restricted: the designation is not part of
    // the comparison, only the carrier is.
    expect(
      classifyDesignatableChange(
        { value: CARRIER[field], designatedPublic: true },
        { value: CARRIER[field], designatedPublic: false },
      ),
    ).toBe("unchanged");
  });
});

describe("the ADR-025 matrix, enforced per field", () => {
  it.each(FIELDS)("A — absent → absent is accepted (%s)", (field) => {
    const proposed = withField(field, undefined);
    const result = enforceDesignationPolicy(withField(field, undefined), proposed);

    expect(result.ok).toBe(true);

    if (result.ok) expect(result.value).toBe(proposed);
  });

  it.each(FIELDS)("B — unchanged, same public designation is accepted (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: true });
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: true });

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(true);
  });

  it.each(FIELDS)("B — unchanged, same private designation is accepted (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: false });
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: false });

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(true);
  });

  it.each(FIELDS)("B — unchanged, public → private restriction is accepted (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: true });
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: false });

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(true);
  });

  it.each(FIELDS)("B — unchanged, private → public widening is refused (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: false });
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: true });
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "unchanged")]);
  });

  it.each(FIELDS)("B — an absent current designation is private, so widening it is refused (%s)", (field) => {
    // `PS-2` fail-closed: nobody designated it, so it is not public and may not become public.
    const current = withField(field, { value: CARRIER[field] });
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: true });
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "unchanged")]);
  });

  it.each(FIELDS)("C — present → absent removal is accepted, and no designation survives (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: true });
    const proposed = withField(field, undefined);
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(proposed);
      expect(result.value[field]).toBeUndefined();
    }
  });

  it.each(FIELDS)("D — a private addition is accepted (%s)", (field) => {
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: false });

    expect(enforceDesignationPolicy(withField(field, undefined), proposed).ok).toBe(true);
  });

  it.each(FIELDS)("D — an addition with no designation is accepted as private (%s)", (field) => {
    const proposed = withField(field, { value: CARRIER[field] });

    expect(enforceDesignationPolicy(withField(field, undefined), proposed).ok).toBe(true);
  });

  it.each(FIELDS)("D — a public addition is refused (%s)", (field) => {
    const proposed = withField(field, { value: CARRIER[field], designatedPublic: true });
    const result = enforceDesignationPolicy(withField(field, undefined), proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "added")]);
  });

  it.each(FIELDS)("E — a private replacement is accepted (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: true });
    const proposed = withField(field, { value: OTHER[field], designatedPublic: false });

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(true);
  });

  it.each(FIELDS)("E — a public replacement is refused, never inheriting the old designation (%s)", (field) => {
    // The previous value was public. `ADR-025`: a replacement never inherits that.
    const current = withField(field, { value: CARRIER[field], designatedPublic: true });
    const proposed = withField(field, { value: OTHER[field], designatedPublic: true });
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "replaced")]);
  });

  it.each(FIELDS)("E — a replacement with no designation is accepted as private (%s)", (field) => {
    const current = withField(field, { value: CARRIER[field], designatedPublic: true });
    const proposed = withField(field, { value: OTHER[field] });

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(true);
  });
});

describe("no normalization of any kind", () => {
  /** Each pair differs only in formatting, and each must be a refused public replacement. */
  const FORMATTING: readonly {
    readonly label: string;
    readonly field: DesignatableField;
    readonly current: string;
    readonly proposed: string;
  }[] = [
    { label: "leading whitespace", field: "postalCode", current: "P17 AB12", proposed: " P17 AB12" },
    { label: "trailing whitespace", field: "postalCode", current: "P17 AB12", proposed: "P17 AB12 " },
    { label: "case", field: "postalCode", current: "P17 AB12", proposed: "p17 ab12" },
    { label: "punctuation", field: "phone", current: "+353-21-123-4567", proposed: "+353 21 123 4567" },
    { label: "phone formatting", field: "phone", current: "+353 21 123 4567", proposed: "+353211234567" },
    { label: "email case", field: "email", current: "Hello@Example.ie", proposed: "hello@example.ie" },
    { label: "URL trailing slash", field: "website", current: "https://example.ie", proposed: "https://example.ie/" },
    { label: "URL scheme spelling", field: "website", current: "https://example.ie", proposed: "HTTPS://example.ie" },
  ];

  it.each(FORMATTING)(
    "treats a $label difference as a replacement, not an equal value ($field)",
    ({ field, current, proposed }) => {
      expect(classifyDesignatableChange({ value: current }, { value: proposed })).toBe("replaced");
    },
  );

  it.each(FORMATTING)(
    "refuses a public $label difference, because it is a replacement ($field)",
    ({ field, current, proposed }) => {
      const result = enforceDesignationPolicy(
        withField(field, { value: current, designatedPublic: true }),
        withField(field, { value: proposed, designatedPublic: true }),
      );

      expect(result.ok).toBe(false);

      if (!result.ok) expect(result.error).toEqual([violation(field, "replaced")]);
    },
  );

  it("accepts only byte-identical carriers as unchanged", () => {
    // The positive control for the table above: the same string really is unchanged.
    expect(classifyDesignatableChange({ value: "P17 AB12" }, { value: "P17 AB12" })).toBe(
      "unchanged",
    );
  });
});

describe("accumulation, ordering and the absence of partial results", () => {
  it("accepts several legal changes in one proposal", () => {
    const current: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: true },
      phone: { value: CARRIER.phone, designatedPublic: true },
      email: { value: CARRIER.email, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      // restricted
      postalCode: { value: CARRIER.postalCode, designatedPublic: false },
      // replaced, private
      phone: { value: OTHER.phone, designatedPublic: false },
      // removed
      // added, private
      website: { value: CARRIER.website, designatedPublic: false },
    };
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(true);

    if (result.ok) expect(result.value).toBe(proposed);
  });

  it("reports every violation, not just the first", () => {
    const current: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: false },
      phone: { value: CARRIER.phone, designatedPublic: false },
      email: { value: CARRIER.email, designatedPublic: false },
      website: { value: CARRIER.website, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: true },
      phone: { value: CARRIER.phone, designatedPublic: true },
      email: { value: CARRIER.email, designatedPublic: true },
      website: { value: CARRIER.website, designatedPublic: true },
    };
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toHaveLength(4);
      expect(result.error.map((v) => v.field)).toEqual([
        "postalCode",
        "phone",
        "email",
        "website",
      ]);
    }
  });

  it("returns violations in the governed field order, whichever fields offend", () => {
    // Only the outer two offend; the order must still be postalCode before website.
    const current: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: false },
      website: { value: CARRIER.website, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: true },
      website: { value: CARRIER.website, designatedPublic: true },
    };
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error.map((v) => v.field)).toEqual(["postalCode", "website"]);
  });

  it("refuses the whole proposal for one prohibited field among otherwise valid changes", () => {
    const current: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: true },
      phone: { value: CARRIER.phone, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      // legal: a restriction
      postalCode: { value: CARRIER.postalCode, designatedPublic: false },
      // prohibited: a widening
      phone: { value: CARRIER.phone, designatedPublic: true },
    };
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      // No partial result: a refusal carries violations and no content.
      expect(result.error).toEqual([violation("phone", "unchanged")]);
      expect(result).not.toHaveProperty("value");
    }
  });

  it("distinguishes the classification that caused each refusal", () => {
    const current: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: false },
      phone: { value: CARRIER.phone, designatedPublic: true },
    };
    const proposed: ListingContent = {
      ...BASE,
      postalCode: { value: CARRIER.postalCode, designatedPublic: true },
      phone: { value: OTHER.phone, designatedPublic: true },
      email: { value: CARRIER.email, designatedPublic: true },
    };
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toEqual([
        violation("postalCode", "unchanged"),
        violation("phone", "replaced"),
        violation("email", "added"),
      ]);
    }
  });
});

describe("purity", () => {
  it("returns the proposed content by exact reference on success", () => {
    const proposed: ListingContent = { ...BASE, phone: { value: CARRIER.phone } };

    const result = enforceDesignationPolicy(BASE, proposed);

    expect(result.ok).toBe(true);

    if (result.ok) expect(result.value).toBe(proposed);
  });

  it("mutates neither argument, on success or refusal", () => {
    const current: ListingContent = {
      ...BASE,
      phone: { value: CARRIER.phone, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      phone: { value: CARRIER.phone, designatedPublic: true },
    };
    const currentBefore = structuredClone(current);
    const proposedBefore = structuredClone(proposed);

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(false);
    expect(current).toEqual(currentBefore);
    expect(proposed).toEqual(proposedBefore);

    const legal: ListingContent = {
      ...BASE,
      phone: { value: CARRIER.phone, designatedPublic: false },
    };
    const legalBefore = structuredClone(legal);

    expect(enforceDesignationPolicy(current, legal).ok).toBe(true);
    expect(current).toEqual(currentBefore);
    expect(legal).toEqual(legalBefore);
  });

  it("is deterministic across repeated calls", () => {
    const current: ListingContent = {
      ...BASE,
      email: { value: CARRIER.email, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      email: { value: CARRIER.email, designatedPublic: true },
    };

    const first = enforceDesignationPolicy(current, proposed);
    const second = enforceDesignationPolicy(current, proposed);
    const third = enforceDesignationPolicy(current, proposed);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("ignores non-designation content entirely", () => {
    // Every plain field differs, and no designation does. The decision must not change.
    const current: ListingContent = {
      ...BASE,
      phone: { value: CARRIER.phone, designatedPublic: true },
    };
    const proposed: ListingContent = {
      name: "Completely Different Bakery",
      category: "retail-shopping",
      description: "Rewritten entirely.",
      locality: "Cobh",
      country: "FR",
      administrativeArea: "Co. Cork",
      phone: { value: CARRIER.phone, designatedPublic: true },
    };

    expect(enforceDesignationPolicy(current, proposed).ok).toBe(true);
  });
});

describe("the failure taxonomy stays distinct", () => {
  it("uses only the one governed code", () => {
    const current: ListingContent = {
      ...BASE,
      website: { value: CARRIER.website, designatedPublic: false },
    };
    const proposed: ListingContent = {
      ...BASE,
      website: { value: CARRIER.website, designatedPublic: true },
    };
    const result = enforceDesignationPolicy(current, proposed);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(new Set(result.error.map((v) => v.code))).toEqual(
        new Set(["DESIGNATION_WIDENING_REFUSED"]),
      );
      // Never a validation, stale, advancement, lifecycle or storage code.
      for (const v of result.error) {
        expect(v.code).not.toBe("REQUIRED_VALUE_MISSING");
        expect(v.code).not.toBe("CATEGORY_NOT_APPROVED");
        expect(v.code).not.toBe("CONTACT_METHOD_MINIMUM_UNMET");
        expect(v.code).not.toBe("STALE_LISTING_VERSION");
        expect(v.code).not.toBe("INSTANT_NOT_STRICTLY_LATER");
        expect(v.code).not.toBe("LISTING_NOT_APPROVED");
        expect(v.code).not.toBe("STORAGE_FAILURE");
      }
    }
  });
});

/**
 * The module's structural boundary.
 *
 * **Asserted on the import specifiers, not by searching the source text.** The module's own
 * documentation names `src/data/` while explaining that it must not depend on it, so a
 * `not.toContain("src/data")` assertion would fail on a comment — or, worse, pass for the wrong
 * reason once the wording changed. PR #180 corrected exactly that class of unsound structural
 * test, and this does not repeat it: the specifier set is extracted from `from "…"` clauses and
 * bare side-effect imports, and then pinned **exactly**, so any new dependency at all — data
 * layer, `node:` builtin or otherwise — fails here rather than only the ones a denylist guessed.
 */
describe("the module's structural boundary", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("./designation.ts", import.meta.url)),
    "utf8",
  );

  /** Every module specifier this file imports, however the import is written. */
  function importSpecifiers(source: string): readonly string[] {
    const found = new Set<string>();

    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g)) {
      found.add(m[1] as string);
    }

    // Bare side-effect imports: `import "./x"` with no binding and no `from`.
    for (const m of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
      found.add(m[1] as string);
    }

    return [...found].sort();
  }

  /**
   * Source with comments and string/template literals removed, so prose cannot match.
   *
   * A **single-pass scanner**, not a chain of regular expressions. The regex version of this
   * helper stripped line comments only at the start of a line, so a trailing `// Date.now`
   * survived and the forbidden-identifier check below was unsound — exactly the defect its own
   * self-attack test caught, and exactly the class of unsound structural test PR #180 corrected.
   * Order matters too: `//` occurs inside `https://`, so a string must be recognised as a string
   * rather than stripped after the comments.
   */
  function executableSource(source: string): string {
    let out = "";
    let i = 0;

    while (i < source.length) {
      const two = source.slice(i, i + 2);

      if (two === "/*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        out += " ";
        continue;
      }

      if (two === "//") {
        const end = source.indexOf("\n", i + 2);
        i = end === -1 ? source.length : end;
        out += " ";
        continue;
      }

      const ch = source[i] as string;

      if (ch === '"' || ch === "'" || ch === "`") {
        i += 1;

        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }

          if (source[i] === ch) {
            i += 1;
            break;
          }

          i += 1;
        }

        out += ch + ch;
        continue;
      }

      out += ch;
      i += 1;
    }

    return out;
  }

  it("imports exactly two sibling domain modules and nothing else", () => {
    expect(importSpecifiers(SOURCE)).toEqual(["./listing", "./result"]);
  });

  it("imports nothing from the data layer, by specifier rather than by prose", () => {
    for (const specifier of importSpecifiers(SOURCE)) {
      expect(specifier.includes("data")).toBe(false);
      expect(specifier.startsWith("node:")).toBe(false);
      expect(specifier.startsWith("..")).toBe(false);
    }
  });

  it("mentions the data layer in its documentation, which is why the test reads specifiers", () => {
    // The positive control for the two assertions above: a naive source-text search would hit
    // this and a denylist would be satisfied by prose alone.
    expect(SOURCE).toContain("src/data/");
    expect(executableSource(SOURCE)).not.toContain("src/data/");
  });

  it("reads no clock and performs no I/O or randomness in its executable source", () => {
    const code = executableSource(SOURCE);

    for (const forbidden of [
      "Date.now",
      "new Date",
      "Temporal",
      "Math.random",
      "process.",
      "require(",
      "fetch(",
      "readFile",
      "writeFile",
      "console.",
      "setTimeout",
      "crypto",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("the comment and literal stripper actually strips, so the check above can fail", () => {
    // Attacking the helper: without this, a broken stripper would make every assertion vacuous.
    // This test earned its place — it caught the first implementation stripping line comments
    // only at the start of a line, which left a trailing `// Date.now` in the "executable"
    // source and made the forbidden-identifier check unsound.
    const sample = [
      "const a = 1; /* Date.now */ // Math.random",
      'const b = "process.env";',
      'const c = "https://example.ie"; // trailing Date.now',
      "const d = `fetch(`;",
    ].join("\n");
    const stripped = executableSource(sample);

    // Block comments, and line comments anywhere on the line — not only at its start.
    expect(stripped).not.toContain("Date.now");
    expect(stripped).not.toContain("Math.random");
    // String and template contents, including a URL whose `//` must not open a comment.
    expect(stripped).not.toContain("process.env");
    expect(stripped).not.toContain("example.ie");
    expect(stripped).not.toContain("fetch(");
    // Executable code survives, so the check this feeds is not vacuously empty.
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("const b =");
    expect(stripped).toContain("const c =");
    expect(stripped).toContain("const d =");
  });

  it("the specifier extractor finds every import form it claims to", () => {
    const sample =
      'import x from "./a";\nimport type { Y } from "./b";\nimport "./c";\n' +
      'export { z } from "./d";\nconst s = "from \\"./not-an-import\\"";';

    expect(importSpecifiers(sample)).toEqual(["./a", "./b", "./c", "./d"]);
  });
});

/**
 * Compile-time guards, checked by `tsc`.
 *
 * `npm run typecheck` fails if the API's shape drifts. No runtime assertion can catch these:
 * each would leave the suite green while the type system quietly admitted something the
 * governed contract excludes.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;

type Policy = typeof enforceDesignationPolicy;
type PolicyParams = Parameters<Policy>;
type PolicyReturn = ReturnType<Policy>;

/** Both inputs are exactly `ListingContent` — not a `Listing`, not a row, not `unknown`. */
type _CurrentIsListingContent = Assert<Equals<PolicyParams[0], ListingContent>>;
type _ProposedIsListingContent = Assert<Equals<PolicyParams[1], ListingContent>>;

/** Exactly two parameters: no override, role, flag or option can be passed. */
type _NoOverrideParameter = Assert<Equals<PolicyParams["length"], 2>>;

/** Success is the domain content type, never a persistence or transport type. */
type _SuccessIsListingContent = Assert<
  Equals<Extract<PolicyReturn, { ok: true }>["value"], ListingContent>
>;

/** Failure is exactly the accumulated violation list. */
type _FailureIsViolationList = Assert<
  Equals<Extract<PolicyReturn, { ok: false }>["error"], readonly DesignationViolation[]>
>;

/** `DesignatableField` is exactly the four governed names. A fifth must be added deliberately. */
type _FieldsAreExactlyFour = Assert<
  Equals<DesignatableField, "postalCode" | "phone" | "email" | "website">
>;

/** `DesignationChange` is exactly the four classification names. */
type _ChangesAreExactlyFour = Assert<
  Equals<DesignationChange, "unchanged" | "removed" | "added" | "replaced">
>;

/**
 * The taxonomy distinctness `ADR-025` requires, pinned in **both** directions: neither type may
 * be substituted for the other, so a later edit cannot quietly fold this refusal into ordinary
 * content validation.
 */
type _ViolationIsNotAValidationViolation = Assert<
  Equals<DesignationViolation extends ValidationViolation ? true : false, false>
>;
type _ValidationViolationIsNotADesignationViolation = Assert<
  Equals<ValidationViolation extends DesignationViolation ? true : false, false>
>;

/** Nothing weaker may enter the API: these must not be assignable to the parameters. */
type _UnknownIsRejected = Assert<Equals<unknown extends PolicyParams[0] ? true : false, false>>;
type _DateIsRejected = Assert<Equals<Date extends PolicyParams[0] ? true : false, false>>;
type _NumberIsRejected = Assert<Equals<number extends PolicyParams[0] ? true : false, false>>;
type _PartialIsRejected = Assert<
  Equals<Partial<ListingContent> extends PolicyParams[0] ? true : false, false>
>;

/** The classification helper takes an optional designatable value on each side, and returns one. */
type _ClassifyTakesDesignatable = Assert<
  Equals<Parameters<typeof classifyDesignatableChange>[0], DesignatableValue | undefined>
>;
type _ClassifyReturnsChange = Assert<
  Equals<ReturnType<typeof classifyDesignatableChange>, DesignationChange>
>;

/** The violation's own shape, so a field cannot be dropped or widened. */
type _ViolationShape = Assert<
  Equals<
    DesignationViolation,
    {
      readonly code: "DESIGNATION_WIDENING_REFUSED";
      readonly field: DesignatableField;
      readonly change: DesignationChange;
    }
  >
>;
