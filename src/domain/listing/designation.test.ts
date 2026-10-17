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

/**
 * `ADR-025`'s classification, asserted **through the public policy** rather than through the
 * classifier.
 *
 * The Release Gate made `classifyDesignatableChange` private: no requirement identifies a
 * production consumer, and test observability must not decide a public API. Every classification
 * is still provable here, because the policy reports the classification that caused a refusal in
 * `violation.change` — so a misclassification changes the reported `change`, not merely an
 * internal label.
 *
 * The one exception is recorded rather than papered over. A **removal** is always accepted, so no
 * violation carries `change: "removed"`, and the label itself is unobservable. What `ADR-025`
 * actually binds about a removal — that it is not omission or preservation, and that no
 * designation survives — is a statement about the **content** the policy returns, and is asserted
 * that way in the matrix below.
 */
describe("the ADR-025 classification, observed through the policy", () => {
  it.each(FIELDS)("reports an exactly equal carrier as unchanged (%s)", (field) => {
    // Private → public on an identical carrier: refused, and the reported classification is the
    // proof that the carrier was compared equal rather than treated as a replacement.
    const result = enforceDesignationPolicy(
      withField(field, { value: CARRIER[field], designatedPublic: false }),
      withField(field, { value: CARRIER[field], designatedPublic: true }),
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "unchanged")]);
  });

  it.each(FIELDS)("reports a different carrier as replaced (%s)", (field) => {
    const result = enforceDesignationPolicy(
      withField(field, { value: CARRIER[field], designatedPublic: true }),
      withField(field, { value: OTHER[field], designatedPublic: true }),
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "replaced")]);
  });

  it.each(FIELDS)("reports an arriving value as added (%s)", (field) => {
    const result = enforceDesignationPolicy(
      withField(field, undefined),
      withField(field, { value: CARRIER[field], designatedPublic: true }),
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toEqual([violation(field, "added")]);
  });

  it.each(FIELDS)("treats a designation-only change as unchanged, not replaced (%s)", (field) => {
    // Same carrier, designation widened. If the carrier comparison wrongly reported a
    // replacement, the reported `change` would say so.
    const result = enforceDesignationPolicy(
      withField(field, { value: CARRIER[field] }),
      withField(field, { value: CARRIER[field], designatedPublic: true }),
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error[0]?.change).toBe("unchanged");
  });

  it.each(FIELDS)("never reports a removal as a violation at all (%s)", (field) => {
    // The behavioural half of `ADR-025`'s removal rule: accepted, and — see the matrix below —
    // the returned content has the field absent, so nothing was preserved.
    expect(
      enforceDesignationPolicy(
        withField(field, { value: CARRIER[field], designatedPublic: true }),
        withField(field, undefined),
      ).ok,
    ).toBe(true);
  });

  it.each(FIELDS)("accepts absent → absent without a violation (%s)", (field) => {
    expect(
      enforceDesignationPolicy(withField(field, undefined), withField(field, undefined)).ok,
    ).toBe(true);
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
    "refuses a public $label difference, and reports it as a replacement ($field)",
    ({ field, current, proposed }) => {
      // Both sides were public, so if the carriers had been normalized to equal the policy
      // would have accepted this as an unchanged public value. The refusal proves no
      // normalization happened, and the reported `change` proves it was read as a replacement
      // rather than as something else that happens to be refused.
      const result = enforceDesignationPolicy(
        withField(field, { value: current, designatedPublic: true }),
        withField(field, { value: proposed, designatedPublic: true }),
      );

      expect(result.ok).toBe(false);

      if (!result.ok) expect(result.error).toEqual([violation(field, "replaced")]);
    },
  );

  it.each(FORMATTING)(
    "would accept the same pair if the carriers really were equal ($label, $field)",
    ({ field, current }) => {
      // The positive control that makes the table above meaningful: with a byte-identical
      // carrier on both sides, the very same public→public designation is accepted. So the
      // refusals above are caused by the carrier difference and nothing else.
      expect(
        enforceDesignationPolicy(
          withField(field, { value: current, designatedPublic: true }),
          withField(field, { value: current, designatedPublic: true }),
        ).ok,
      ).toBe(true);
    },
  );
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
   *
   * A template is the one literal treated in two parts, because the Release Gate's hostile probes
   * found the scanner swallowing a whole template and hiding `${Date.now()}` from the check below.
   * Its **literal text is inert** and is stripped like any string; a `${...}` **interpolation is
   * executable** and is kept, nested templates included. The scanner does not descend into strings
   * inside an interpolation, so a forbidden identifier quoted *there* is a false positive — which
   * fails closed, and is the direction to err in.
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

      if (ch === '"' || ch === "'") {
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

      if (ch === "`") {
        // A template's **literal text** is stripped like any string, but a `${…}`
        // interpolation is executable and is kept. A hostile probe found the first version
        // swallowing the whole template, which hid `${Date.now()}` from the check below.
        i += 1;
        out += "``";

        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }

          if (source[i] === "`") {
            i += 1;
            break;
          }

          if (source.slice(i, i + 2) === "${") {
            let depth = 0;

            while (i < source.length) {
              if (source[i] === "{") {
                depth += 1;
              } else if (source[i] === "}") {
                depth -= 1;

                if (depth === 0) {
                  out += "}";
                  i += 1;
                  break;
                }
              }

              out += source[i];
              i += 1;
            }

            continue;
          }

          i += 1;
        }

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

  it("the stripper keeps template interpolations, which are executable, and drops the text", () => {
    // The second defect the Release Gate's probes found: skipping a template wholesale hid
    // `${Date.now()}` from the forbidden-identifier check. Literal text is inert; `${...}` is not.
    const sample = [
      "const a = `" + "Date.now is inert here`" + ";",
      "const b = `" + "x${Date.now()}y`" + ";",
      "const c = `" + "p${`" + "q${Math.random()}`" + "}r`" + ";",
    ].join("\n");
    const stripped = executableSource(sample);

    // Inert literal text is still removed, so prose in a template cannot trip the check.
    expect(stripped).not.toContain("Date.now is inert");
    // Executable interpolation content survives, at one level and nested.
    expect(stripped).toContain("Date.now()");
    expect(stripped).toContain("Math.random()");
    // The inert text around a live interpolation is still gone.
    expect(stripped).not.toContain("x$");
    expect(stripped).not.toContain("y`");
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
