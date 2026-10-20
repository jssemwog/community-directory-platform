/**
 * Attacking tests for the `FR-ADM-04` pure-domain administrative edit (issue #215).
 *
 * Pure domain: no cluster, no clock, no sleep, no wall-clock threshold, no retry-until-green, no
 * environment gate and no production fault-injection hook. Every instant is supplied.
 *
 * **The field and transition matrices are table-driven deliberately.** The worst failure mode of
 * an operation with ten editable fields and four designatable ones is not getting a *case* wrong
 * — it is getting a *field* wrong, which hand-written per-case tests miss. So every designatable
 * transition is asserted for `postalCode`, `phone`, `email` and `website` from one table, and
 * every editable field is exercised from another: skipping one fails four tests, not none.
 *
 * **The no-op ruling gets its own section and its own hostile instants.** The ruling's two
 * consequences — that a no-op must not reach `withListingContent`, and that materiality is judged
 * from materialized content rather than patch shape — are each attacked from both directions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyAdministrativeEdit,
  type AdministrativeEdit,
  type AdministrativeEditFailure,
  type PatchField,
  type TimestampAdvancementFailure,
} from "./administrative-edit";
import type { CategoryKey } from "./category";
import type { DesignatableField, DesignationViolation } from "./designation";
import { instantOf, type Instant } from "./instant";
import type { DesignatableValue, Listing, ListingContent } from "./listing";
import { listingIdOf } from "./listing-id";
import type { DomainError, Result } from "./result";
import type { ListingStatus } from "./status";
import type { ValidationViolation } from "./validation";

/** The four governed fields, in `ADR-025`'s evaluation order. Pinned by test, not imported. */
const DESIGNATABLE = ["postalCode", "phone", "email", "website"] as const;

/** The five fields `VR-S1` requires. Pinned by test. */
const REQUIRED = ["name", "category", "description", "locality", "country"] as const;

/** Every editable field, pinned by test so a new one fails here rather than silently appearing. */
const EDITABLE = [...REQUIRED, "administrativeArea", ...DESIGNATABLE] as const;

function instant(epochMilliseconds: number): Instant {
  const made = instantOf(epochMilliseconds);

  if (!made.ok) {
    throw new Error(`fixture instant ${epochMilliseconds} is not usable`);
  }

  return made.value;
}

const SUBMITTED = instant(1_700_000_000_000);
const UPDATED = instant(1_700_000_100_000);
const LATER = instant(1_700_000_200_000);
const EARLIER = instant(1_700_000_050_000);

/** Valid content by the existing rules, so no fixture depends on malformed input. */
const CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

function pendingListing(content: ListingContent = CONTENT): Listing {
  return {
    id: listingIdOf("11111111-1111-4111-8111-111111111111"),
    status: "pending",
    content,
    timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED },
  };
}

function listingWith(field: DesignatableField, value: DesignatableValue | undefined): Listing {
  return pendingListing(value === undefined ? { ...CONTENT } : { ...CONTENT, [field]: value });
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

const supply = <T>(value: T) => ({ kind: "supply", value }) as const;
const PRESERVE = { kind: "preserve" } as const;
const REMOVE = { kind: "remove" } as const;

function widening(field: DesignatableField, change: DesignationViolation["change"]) {
  return { code: "DESIGNATION_WIDENING_REFUSED", field, change } as const;
}

function expectErr(
  result: Result<Listing, AdministrativeEditFailure>,
): AdministrativeEditFailure {
  if (result.ok) {
    throw new Error(`expected a refusal, got a listing`);
  }

  return result.error;
}

function expectOk(result: Result<Listing, AdministrativeEditFailure>): Listing {
  if (!result.ok) {
    throw new Error(`expected a listing, got ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

/* ------------------------------------------------------------------------------------------- */
/* A. Compile-time and structural proof                                                          */
/* ------------------------------------------------------------------------------------------- */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;

/** 1 + 2 + 3 — the three states, mutually exclusive, with values only on `supply`. */
type _PatchFieldIsExactlyThreeStates = Assert<
  Equals<
    PatchField<string>,
    { readonly kind: "preserve" } | { readonly kind: "remove" } | { readonly kind: "supply"; readonly value: string }
  >
>;
type _PreserveCarriesNoValue = Assert<Equals<keyof Extract<PatchField<string>, { kind: "preserve" }>, "kind">>;
type _RemoveCarriesNoValue = Assert<Equals<keyof Extract<PatchField<string>, { kind: "remove" }>, "kind">>;
type _SupplyCarriesTheCarrier = Assert<
  Equals<Extract<PatchField<DesignatableValue>, { kind: "supply" }>["value"], DesignatableValue>
>;

/** 4 + 5 — required fields are non-removable, and `category` carries `CategoryKey`. */
type _NameIsNotRemovable = Assert<Equals<Extract<NonNullable<AdministrativeEdit["name"]>, { kind: "remove" }>, never>>;
type _CategoryIsNotRemovable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["category"]>, { kind: "remove" }>, never>
>;
type _DescriptionIsNotRemovable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["description"]>, { kind: "remove" }>, never>
>;
type _LocalityIsNotRemovable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["locality"]>, { kind: "remove" }>, never>
>;
type _CountryIsNotRemovable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["country"]>, { kind: "remove" }>, never>
>;
type _CategorySupplyIsCategoryKey = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["category"]>, { kind: "supply" }>["value"], CategoryKey>
>;
type _CategorySupplyIsNotBareString = Assert<Equals<Equals<CategoryKey, string>, false>>;

/** The optional plain field *is* removable — the asymmetry is the whole point of two aliases. */
type _AdministrativeAreaIsRemovable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["administrativeArea"]>, { kind: "remove" }>, { readonly kind: "remove" }>
>;

/** 6 — a designatable supply carries a coherent `DesignatableValue`, never a bare carrier. */
type _PostalCodeSupplyIsDesignatable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["postalCode"]>, { kind: "supply" }>["value"], DesignatableValue>
>;
type _PhoneSupplyIsDesignatable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["phone"]>, { kind: "supply" }>["value"], DesignatableValue>
>;
type _EmailSupplyIsDesignatable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["email"]>, { kind: "supply" }>["value"], DesignatableValue>
>;
type _WebsiteSupplyIsDesignatable = Assert<
  Equals<Extract<NonNullable<AdministrativeEdit["website"]>, { kind: "supply" }>["value"], DesignatableValue>
>;

/** 7 — identity, lifecycle, timestamps, the rejection anchor and publication are unpatchable. */
type _EditNamesExactlyTheTenContentFields = Assert<Equals<keyof AdministrativeEdit, keyof ListingContent>>;
type _EditNamesNoListingKeys = Assert<
  Equals<Extract<keyof AdministrativeEdit, "id" | "status" | "timestamps" | "publication">, never>
>;

/** 8 + 9 — the exact input, success and failure types, and the lifecycle payload shape. */
type _Signature = Assert<
  Equals<
    typeof applyAdministrativeEdit,
    (listing: Listing, edit: AdministrativeEdit, at: Instant) => Result<Listing, AdministrativeEditFailure>
  >
>;
type _LifecycleFailureShape = Assert<
  Equals<
    Extract<AdministrativeEditFailure, { code: "LISTING_NOT_PENDING" }>,
    { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
  >
>;
type _ContentFailureCarriesValidationViolations = Assert<
  Equals<
    Extract<AdministrativeEditFailure, { code: "EDITED_CONTENT_INVALID" }>["violations"],
    readonly ValidationViolation[]
  >
>;
type _DesignationFailureCarriesDesignationViolations = Assert<
  Equals<
    Extract<AdministrativeEditFailure, { code: "DESIGNATION_POLICY_REFUSED" }>["violations"],
    readonly DesignationViolation[]
  >
>;
type _InvalidEditCarriesTheOfferedValue = Assert<
  Equals<
    Extract<AdministrativeEditFailure, { code: "INVALID_ADMINISTRATIVE_EDIT" }>,
    { readonly code: "INVALID_ADMINISTRATIVE_EDIT"; readonly offered: unknown }
  >
>;

/** 10 — the three violation vocabularies stay apart, in both directions. */
type _DesignationIsNotValidation = Assert<Equals<DesignationViolation extends ValidationViolation ? true : false, false>>;
type _ValidationIsNotDesignation = Assert<Equals<ValidationViolation extends DesignationViolation ? true : false, false>>;
type _NoListingNotPendingInDomainError = Assert<Equals<Extract<DomainError, { code: "LISTING_NOT_PENDING" }>, never>>;
type _NoEditedContentInvalidInDomainError = Assert<
  Equals<Extract<DomainError, { code: "EDITED_CONTENT_INVALID" }>, never>
>;

/** The reachable timestamp subset is a real subset of `DomainError`, and excludes the write-once code. */
type _TimestampSubsetIsDomainError = Assert<TimestampAdvancementFailure extends DomainError ? true : false>;
type _TimestampSubsetExcludesRejectionWriteOnce = Assert<
  Equals<Extract<TimestampAdvancementFailure, { code: "REJECTION_TIMESTAMP_ALREADY_SET" }>, never>
>;
type _StrictlyLaterIsReachable = Assert<
  Equals<
    Extract<AdministrativeEditFailure, { code: "INSTANT_NOT_STRICTLY_LATER" }>,
    { readonly code: "INSTANT_NOT_STRICTLY_LATER" }
  >
>;

/** Failures this operation must not be able to report at all. */
type _NoStaleFailure = Assert<Equals<Extract<AdministrativeEditFailure, { code: "STALE_LISTING_VERSION" }>, never>>;
type _NoStorageFailure = Assert<Equals<Extract<AdministrativeEditFailure, { code: "STORAGE_FAILURE" }>, never>>;
type _NoNoOpFailure = Assert<Equals<Extract<AdministrativeEditFailure, { code: "EDIT_HAS_NO_EFFECT" }>, never>>;

describe("the module's structural boundary", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("./administrative-edit.ts", import.meta.url)),
    "utf8",
  );

  /** Every module specifier this file imports, however the import is written. */
  function importSpecifiers(source: string): readonly string[] {
    const found = new Set<string>();

    for (const m of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g,
    )) {
      found.add(m[1] as string);
    }

    for (const m of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
      found.add(m[1] as string);
    }

    return [...found].sort();
  }

  /**
   * Source with comments and string/template literal **text** removed, so prose cannot match.
   *
   * The **corrected single-pass scanner** from `designation.test.ts` (PR #180's precedent), not a
   * chain of regular expressions: a regex version strips line comments only at the start of a
   * line, so a trailing `// Date.now` survives and every check below becomes unsound. Order
   * matters — `//` occurs inside `https://`, so a string is recognised as a string first. A
   * template is treated in two parts: its literal text is inert and stripped, a `${…}`
   * interpolation is executable and kept, nested templates included.
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

  it("imports exactly the sibling domain modules it needs and nothing else", () => {
    expect(importSpecifiers(SOURCE)).toEqual([
      "./designation",
      "./instant",
      "./listing",
      "./result",
      "./validation",
    ]);
  });

  it("imports nothing from the data layer, by specifier rather than by prose", () => {
    for (const specifier of importSpecifiers(SOURCE)) {
      expect(specifier.includes("data")).toBe(false);
      expect(specifier.startsWith("node:")).toBe(false);
      expect(specifier.startsWith("..")).toBe(false);
    }
  });

  it("mentions the data layer in its documentation, which is why the test reads specifiers", () => {
    // The positive control: a naive source-text search would hit this, and a denylist would be
    // satisfied by prose alone.
    expect(SOURCE).toContain("src/data/");
    expect(executableSource(SOURCE)).not.toContain("src/data/");
  });

  it("reads no clock and performs no I/O, randomness or normalization in its executable source", () => {
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
      // Normalization, which `ADR-025` prohibits for these fields.
      ".trim(",
      ".toLowerCase(",
      ".toUpperCase(",
      ".normalize(",
      ".replace(",
      "localeCompare",
      "new URL",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("names no role, override or authorization input in its executable source", () => {
    const code = executableSource(SOURCE);

    for (const forbidden of ["role", "override", "actor", "permission", "authoriz"]) {
      expect(code.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("never names validateBeforeApproval in executable code", () => {
    expect(executableSource(SOURCE)).not.toContain("validateBeforeApproval");
  });

  it("the comment and literal stripper actually strips, so the checks above can fail", () => {
    const sample = [
      "const a = 1; /* Date.now */ // Math.random",
      'const b = "process.env";',
      'const c = "https://example.ie"; // trailing Date.now',
      "const d = `fetch(`;",
    ].join("\n");
    const stripped = executableSource(sample);

    expect(stripped).not.toContain("Date.now");
    expect(stripped).not.toContain("Math.random");
    expect(stripped).not.toContain("process.env");
    expect(stripped).not.toContain("example.ie");
    expect(stripped).not.toContain("fetch(");
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("const b =");
    expect(stripped).toContain("const c =");
    expect(stripped).toContain("const d =");
  });

  it("the stripper keeps template interpolations, which are executable, and drops the text", () => {
    const sample = [
      "const a = `" + "Date.now is inert here`" + ";",
      "const b = `" + "x${Date.now()}y`" + ";",
      "const c = `" + "p${`" + "q${Math.random()}`" + "}r`" + ";",
    ].join("\n");
    const stripped = executableSource(sample);

    expect(stripped).not.toContain("Date.now is inert");
    expect(stripped).toContain("Date.now()");
    expect(stripped).toContain("Math.random()");
    expect(stripped).not.toContain("x$");
    expect(stripped).not.toContain("y`");
  });

  it("the module contains no template literal, so the scanner's weakest path is unreachable", () => {
    // The scanner's one known limitation, inherited with it: a `}` inside a string inside a
    // `${…}` interpolation closes the interpolation early, dropping the rest of the template —
    // which would fail **open** for the denylist above. That path cannot be taken here, and this
    // pins the reason: the module has no template literal in its executable source at all.
    expect(executableSource(SOURCE)).not.toContain("`");
  });

  it("the specifier extractor finds every import form it claims to", () => {
    const sample =
      'import x from "./a";\nimport type { Y } from "./b";\nimport "./c";\n' +
      'export { z } from "./d";\nconst s = "from \\"./not-an-import\\"";';

    expect(importSpecifiers(sample)).toEqual(["./a", "./b", "./c", "./d"]);
  });

  it("exports exactly the authorized surface, so a convenience symbol cannot leak", async () => {
    const module = await import("./administrative-edit");

    // Types are erased, so only the value exports can be observed at runtime — which is exactly
    // the surface a stray `export const PRESERVE = …` would widen.
    expect(Object.keys(module).sort()).toEqual(["applyAdministrativeEdit"]);
  });

  it("declares exactly the authorized exported type names in its source", () => {
    const code = executableSource(SOURCE);
    const exported = [...code.matchAll(/export\s+(?:type|interface|function|const)\s+(\w+)/g)].map(
      (m) => m[1] as string,
    );

    expect([...new Set(exported)].sort()).toEqual([
      "AdministrativeEdit",
      "AdministrativeEditFailure",
      "PatchField",
      "TimestampAdvancementFailure",
      "applyAdministrativeEdit",
    ]);
  });

  it("the exported-name extractor finds what it claims to, and nothing it should not", () => {
    const sample =
      "export type A = 1;\nexport interface B { x: 1 }\nexport function c() {}\n" +
      "export const d = 1;\ntype NotExported = 2;\nfunction alsoNot() {}\n";
    const found = [...sample.matchAll(/export\s+(?:type|interface|function|const)\s+(\w+)/g)].map(
      (m) => m[1] as string,
    );

    expect(found.sort()).toEqual(["A", "B", "c", "d"]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* B. Runtime field matrix                                                                       */
/* ------------------------------------------------------------------------------------------- */

describe("every editable field, exercised through all its legal states", () => {
  const PLAIN_REPLACEMENT: Record<(typeof REQUIRED)[number] | "administrativeArea", string> = {
    name: "Harbour Bakery & Cafe",
    category: "retail-shopping",
    description: "A small bakery and cafe.",
    locality: "Clonakilty",
    country: "FR",
    administrativeArea: "County Cork",
  };

  it("names exactly the ten governed content fields and no others", () => {
    expect([...EDITABLE].sort()).toEqual(Object.keys({
      name: 0,
      category: 0,
      description: 0,
      locality: 0,
      country: 0,
      administrativeArea: 0,
      postalCode: 0,
      phone: 0,
      email: 0,
      website: 0,
    } satisfies Record<keyof ListingContent, number>).sort());
  });

  for (const field of REQUIRED) {
    it(`${field}: preserve leaves it alone and is a no-op`, () => {
      const listing = pendingListing();
      const result = applyAdministrativeEdit(listing, { [field]: PRESERVE }, LATER);

      expect(expectOk(result)).toBe(listing);
    });

    it(`${field}: supply of a different value is material and is applied`, () => {
      const listing = pendingListing();
      const result = applyAdministrativeEdit(
        listing,
        { [field]: supply(PLAIN_REPLACEMENT[field]) },
        LATER,
      );
      const edited = expectOk(result);

      expect(edited).not.toBe(listing);
      expect(edited.content[field]).toBe(PLAIN_REPLACEMENT[field]);
      expect(edited.timestamps.lastUpdatedAt).toBe(LATER);
    });

    it(`${field}: remove is refused at runtime even though the type forbids writing it`, () => {
      const listing = pendingListing();
      const edit = { [field]: REMOVE } as unknown as AdministrativeEdit;

      expect(expectErr(applyAdministrativeEdit(listing, edit, LATER))).toEqual({
        code: "INVALID_ADMINISTRATIVE_EDIT",
        offered: REMOVE,
      });
    });
  }

  it("administrativeArea: preserve, supply and remove are all legal and behave distinctly", () => {
    const absent = pendingListing();
    const present = pendingListing({ ...CONTENT, administrativeArea: "County Cork" });

    // preserve, on both shapes.
    expect(expectOk(applyAdministrativeEdit(absent, { administrativeArea: PRESERVE }, LATER))).toBe(absent);
    expect(expectOk(applyAdministrativeEdit(present, { administrativeArea: PRESERVE }, LATER))).toBe(present);

    // supply onto an absent field: an addition, and material.
    const added = expectOk(applyAdministrativeEdit(absent, { administrativeArea: supply("County Cork") }, LATER));
    expect(added.content.administrativeArea).toBe("County Cork");

    // remove of a present field: material, and the key is genuinely gone.
    const removed = expectOk(applyAdministrativeEdit(present, { administrativeArea: REMOVE }, LATER));
    expect(removed.content.administrativeArea).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(removed.content, "administrativeArea")).toBe(false);

    // remove of an already-absent field: a no-op, by exact reference.
    expect(expectOk(applyAdministrativeEdit(absent, { administrativeArea: REMOVE }, LATER))).toBe(absent);
  });

  for (const field of DESIGNATABLE) {
    const here = CARRIER[field];
    const other = OTHER[field];

    it(`${field}: absent → absent (preserve) is a no-op`, () => {
      const listing = listingWith(field, undefined);
      expect(expectOk(applyAdministrativeEdit(listing, { [field]: PRESERVE }, LATER))).toBe(listing);
    });

    it(`${field}: absent → present private is a material addition`, () => {
      const listing = listingWith(field, undefined);
      const edited = expectOk(
        applyAdministrativeEdit(listing, { [field]: supply({ value: here, designatedPublic: false }) }, LATER),
      );

      expect(edited.content[field]).toEqual({ value: here, designatedPublic: false });
      expect(edited.timestamps.lastUpdatedAt).toBe(LATER);
    });

    it(`${field}: absent → present public is refused as an addition`, () => {
      const listing = listingWith(field, undefined);
      const error = expectErr(
        applyAdministrativeEdit(listing, { [field]: supply({ value: here, designatedPublic: true }) }, LATER),
      );

      expect(error).toEqual({
        code: "DESIGNATION_POLICY_REFUSED",
        violations: [widening(field, "added")],
      });
    });

    it(`${field}: present → absent is a material removal leaving no designation`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: true });
      const edited = expectOk(applyAdministrativeEdit(listing, { [field]: REMOVE }, LATER));

      expect(edited.content[field]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(edited.content, field)).toBe(false);
    });

    it(`${field}: present → exactly equal with unchanged designation is a no-op`, () => {
      for (const designatedPublic of [true, false] as const) {
        const listing = listingWith(field, { value: here, designatedPublic });
        const result = applyAdministrativeEdit(
          listing,
          { [field]: supply({ value: here, designatedPublic }) },
          LATER,
        );

        expect(expectOk(result)).toBe(listing);
      }
    });

    it(`${field}: public → equal private is a material restriction, not a no-op`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: true });
      const edited = expectOk(
        applyAdministrativeEdit(listing, { [field]: supply({ value: here, designatedPublic: false }) }, LATER),
      );

      expect(edited).not.toBe(listing);
      expect(edited.content[field]).toEqual({ value: here, designatedPublic: false });
      expect(edited.timestamps.lastUpdatedAt).toBe(LATER);
    });

    it(`${field}: private → equal public is refused as a widening of an unchanged value`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: false });
      const error = expectErr(
        applyAdministrativeEdit(listing, { [field]: supply({ value: here, designatedPublic: true }) }, LATER),
      );

      expect(error).toEqual({
        code: "DESIGNATION_POLICY_REFUSED",
        violations: [widening(field, "unchanged")],
      });
    });

    it(`${field}: present → different carrier private is a material replacement`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: true });
      const edited = expectOk(
        applyAdministrativeEdit(listing, { [field]: supply({ value: other, designatedPublic: false }) }, LATER),
      );

      expect(edited.content[field]).toEqual({ value: other, designatedPublic: false });
    });

    it(`${field}: present → different carrier public is refused as a replacement`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: false });
      const error = expectErr(
        applyAdministrativeEdit(listing, { [field]: supply({ value: other, designatedPublic: true }) }, LATER),
      );

      expect(error).toEqual({
        code: "DESIGNATION_POLICY_REFUSED",
        violations: [widening(field, "replaced")],
      });
    });

    it(`${field}: a replacement does not inherit the replaced value's public designation`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: true });
      const edited = expectOk(
        applyAdministrativeEdit(listing, { [field]: supply({ value: other }) }, LATER),
      );

      expect(edited.content[field]?.designatedPublic).not.toBe(true);
      expect(edited.content[field]?.value).toBe(other);
    });

    it(`${field}: an absent designation is read as private, not as a widening`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: false });
      const result = applyAdministrativeEdit(listing, { [field]: supply({ value: here }) }, LATER);

      // Equal carrier, and `undefined` is the same designation as `false`: a no-op, by reference.
      expect(expectOk(result)).toBe(listing);
    });

    it(`${field}: comparison is exact — no trimming, case folding or punctuation removal`, () => {
      const listing = listingWith(field, { value: here, designatedPublic: false });

      for (const nearly of [` ${here}`, `${here} `, here.toUpperCase(), here.replace(/[ .@:/+-]/g, "")]) {
        if (nearly === here) {
          continue;
        }

        const edited = expectOk(
          applyAdministrativeEdit(listing, { [field]: supply({ value: nearly }) }, LATER),
        );

        expect(edited).not.toBe(listing);
        expect(edited.content[field]?.value).toBe(nearly);
      }
    });
  }
});

/* ------------------------------------------------------------------------------------------- */
/* C. The no-op ruling                                                                           */
/* ------------------------------------------------------------------------------------------- */

describe("the issue #213 no-op ruling", () => {
  const FULL: ListingContent = {
    ...CONTENT,
    administrativeArea: "County Cork",
    postalCode: { value: CARRIER.postalCode, designatedPublic: true },
    phone: { value: CARRIER.phone, designatedPublic: false },
    email: { value: CARRIER.email, designatedPublic: true },
    website: { value: CARRIER.website, designatedPublic: false },
  };

  it("an empty edit returns the exact original reference", () => {
    const listing = pendingListing(FULL);
    expect(expectOk(applyAdministrativeEdit(listing, {}, LATER))).toBe(listing);
  });

  it("preserve on every field returns the exact original reference", () => {
    const listing = pendingListing(FULL);
    const edit = Object.fromEntries(EDITABLE.map((f) => [f, PRESERVE])) as AdministrativeEdit;

    expect(expectOk(applyAdministrativeEdit(listing, edit, LATER))).toBe(listing);
  });

  it("an absent key and an explicit preserve are the same instruction", () => {
    const listing = pendingListing(FULL);
    const explicit = Object.fromEntries(EDITABLE.map((f) => [f, PRESERVE])) as AdministrativeEdit;

    expect(expectOk(applyAdministrativeEdit(listing, {}, LATER))).toBe(
      expectOk(applyAdministrativeEdit(listing, explicit, LATER)),
    );
  });

  it("remove of an already-absent optional field returns the exact original reference", () => {
    const listing = pendingListing(CONTENT);
    const edit: AdministrativeEdit = {
      administrativeArea: REMOVE,
      postalCode: REMOVE,
      phone: REMOVE,
      email: REMOVE,
      website: REMOVE,
    };

    expect(expectOk(applyAdministrativeEdit(listing, edit, LATER))).toBe(listing);
  });

  it("supplying every field with its exact current value and designation is a no-op", () => {
    const listing = pendingListing(FULL);
    const edit: AdministrativeEdit = {
      name: supply(FULL.name),
      category: supply(FULL.category),
      description: supply(FULL.description),
      locality: supply(FULL.locality),
      country: supply(FULL.country),
      administrativeArea: supply(FULL.administrativeArea as string),
      postalCode: supply({ ...(FULL.postalCode as DesignatableValue) }),
      phone: supply({ ...(FULL.phone as DesignatableValue) }),
      email: supply({ ...(FULL.email as DesignatableValue) }),
      website: supply({ ...(FULL.website as DesignatableValue) }),
    };

    expect(expectOk(applyAdministrativeEdit(listing, edit, LATER))).toBe(listing);
  });

  it("a syntactically busy patch that materializes to identical content is still a no-op", () => {
    const listing = pendingListing(FULL);
    // Ten instructions, three kinds, every field named — and not one byte of change.
    const edit: AdministrativeEdit = {
      name: supply(FULL.name),
      category: PRESERVE,
      description: supply(FULL.description),
      locality: PRESERVE,
      country: supply(FULL.country),
      administrativeArea: supply(FULL.administrativeArea as string),
      postalCode: supply({ value: CARRIER.postalCode, designatedPublic: true }),
      phone: REMOVE === REMOVE ? supply({ value: CARRIER.phone, designatedPublic: false }) : PRESERVE,
      email: PRESERVE,
      website: supply({ value: CARRIER.website }),
    };

    expect(expectOk(applyAdministrativeEdit(listing, edit, LATER))).toBe(listing);
  });

  it("a no-op leaves lastUpdatedAt exactly as it was", () => {
    const listing = pendingListing(FULL);
    const result = expectOk(applyAdministrativeEdit(listing, {}, LATER));

    expect(result.timestamps.lastUpdatedAt).toBe(UPDATED);
    expect(result.timestamps).toBe(listing.timestamps);
  });

  it("a no-op does not inspect at — every hostile value the boundary admits is ignored", () => {
    const listing = pendingListing(FULL);

    const hostile: readonly unknown[] = [
      UPDATED, // equal: would be INSTANT_NOT_STRICTLY_LATER on a material edit
      EARLIER, // earlier: likewise
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.5,
      "1700000200000",
      {},
      { epochMilliseconds: Number.NaN },
      [],
      new Proxy(
        {},
        {
          get() {
            throw new Error("a no-op read the instant");
          },
        },
      ),
    ];

    for (const at of hostile) {
      const result = applyAdministrativeEdit(listing, {}, at as Instant);

      expect(expectOk(result)).toBe(listing);
    }
  });

  it("the same hostile instants do fail a material edit, so the test above is not vacuous", () => {
    const listing = pendingListing(FULL);
    const material: AdministrativeEdit = { name: supply("Harbour Bakery & Cafe") };

    expect(expectErr(applyAdministrativeEdit(listing, material, UPDATED))).toEqual({
      code: "INSTANT_NOT_STRICTLY_LATER",
    });
    expect(expectErr(applyAdministrativeEdit(listing, material, EARLIER))).toEqual({
      code: "INSTANT_NOT_STRICTLY_LATER",
    });
    expect(expectErr(applyAdministrativeEdit(listing, material, null as unknown as Instant))).toEqual({
      code: "INVALID_INSTANT",
      offered: null,
    });
  });

  it("invalid content is not laundered into no-op success", () => {
    const listing = pendingListing();
    // Blanking a required field changes nothing *comparable* until it is validated — and
    // validation comes first, so this is a refusal rather than a no-op and rather than a write.
    const error = expectErr(applyAdministrativeEdit(listing, { name: supply("   ") }, LATER));

    expect(error).toEqual({
      code: "EDITED_CONTENT_INVALID",
      violations: [{ code: "REQUIRED_VALUE_MISSING", field: "name" }],
    });
  });

  it("content that is already invalid is refused, not returned as a no-op", () => {
    // The mutation that moves content validation after the no-op determination survives every
    // other test in this file, because every other invalid-content case *changes* the content
    // and so never reaches the early return. Only a record that is **already** invalid and is
    // edited with a preserve-only patch tells the two orderings apart — and the ruling is
    // explicit that validation precedes the no-op determination, so this is a refusal.
    const listing = pendingListing({ ...CONTENT, name: "   " });

    for (const edit of [{}, { description: PRESERVE }] as readonly AdministrativeEdit[]) {
      expect(expectErr(applyAdministrativeEdit(listing, edit, LATER))).toEqual({
        code: "EDITED_CONTENT_INVALID",
        violations: [{ code: "REQUIRED_VALUE_MISSING", field: "name" }],
      });
    }
  });

  it("an already-invalid record is still refused when the patch would repair a different field", () => {
    const listing = pendingListing({ ...CONTENT, name: "   " });
    const error = expectErr(
      applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, LATER),
    );

    expect(error).toEqual({
      code: "EDITED_CONTENT_INVALID",
      violations: [{ code: "REQUIRED_VALUE_MISSING", field: "name" }],
    });
  });

  it("malformed patch input is not laundered into no-op success", () => {
    const listing = pendingListing();
    const malformed: readonly unknown[] = [
      null,
      "preserve",
      [],
      { name: null },
      { name: { kind: "keep" } },
      { name: { kind: "preserve", value: "Harbour Bakery" } },
      { name: { kind: "supply" } },
      { name: { kind: "supply", value: undefined } },
      { administrativeArea: { kind: "remove", value: "x" } },
      { postalCode: { kind: "supply", value: "P17 AB12" } },
      { postalCode: { kind: "supply", value: { value: 1 } } },
      { postalCode: { kind: "supply", value: { value: "P17 AB12", designatedPublic: "yes" } } },
      { notAField: PRESERVE },
    ];

    for (const edit of malformed) {
      const error = expectErr(applyAdministrativeEdit(listing, edit as AdministrativeEdit, LATER));

      expect(error.code).toBe("INVALID_ADMINISTRATIVE_EDIT");
    }
  });

  it("a designation refusal is not laundered into no-op success", () => {
    // The carrier is exactly equal, so a syntax-based materiality test would call this a no-op.
    const listing = listingWith("phone", { value: CARRIER.phone, designatedPublic: false });
    const error = expectErr(
      applyAdministrativeEdit(
        listing,
        { phone: supply({ value: CARRIER.phone, designatedPublic: true }) },
        LATER,
      ),
    );

    expect(error).toEqual({
      code: "DESIGNATION_POLICY_REFUSED",
      violations: [widening("phone", "unchanged")],
    });
  });

  it("a no-op reads nothing from listing.timestamps at all", () => {
    // Stronger than asserting the moment is unchanged: the bundle is never *touched*, which is
    // what proves the no-op returns before `withListingContent` rather than after a cheap check.
    let reads = 0;
    const listing = pendingListing(FULL);
    const watched = { ...listing };

    Object.defineProperty(watched, "timestamps", {
      get() {
        reads += 1;
        return listing.timestamps;
      },
    });

    const result = applyAdministrativeEdit(watched as Listing, {}, LATER);

    expect(expectOk(result)).toBe(watched);
    expect(reads).toBe(0);
  });

  it("a no-op on a record with an unreadable timestamp bundle still succeeds by reference", () => {
    // The documented consequence of returning before `withListingContent`: the no-op path cannot
    // report a timestamp defect, because it never looks. The same edit made material does report
    // it, which is the half that keeps this from being a silent hole.
    const broken: Listing = {
      ...pendingListing(FULL),
      timestamps: undefined as unknown as Listing["timestamps"],
    };

    expect(expectOk(applyAdministrativeEdit(broken, {}, LATER))).toBe(broken);
    expect(expectErr(applyAdministrativeEdit(broken, { locality: supply("Clonakilty") }, LATER))).toEqual({
      code: "LISTING_TIMESTAMPS_MISSING",
    });
  });

  it("a no-op never reconstructs the listing — identity holds all the way down", () => {
    const listing = pendingListing(FULL);
    const result = expectOk(applyAdministrativeEdit(listing, {}, LATER));

    expect(result).toBe(listing);
    expect(result.content).toBe(listing.content);
    expect(result.content.postalCode).toBe(listing.content.postalCode);
    expect(result.id).toBe(listing.id);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* D. Material edits                                                                             */
/* ------------------------------------------------------------------------------------------- */

describe("material edits", () => {
  it("a strictly later instant succeeds and advances lastUpdatedAt exactly once", () => {
    const listing = pendingListing();
    const edited = expectOk(applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, LATER));

    expect(edited.timestamps.lastUpdatedAt).toBe(LATER);
    expect(edited.timestamps.submittedAt).toBe(SUBMITTED);
  });

  it("an equal or earlier instant yields INSTANT_NOT_STRICTLY_LATER and writes nothing", () => {
    const listing = pendingListing();

    for (const at of [UPDATED, EARLIER]) {
      const result = applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, at);

      expect(expectErr(result)).toEqual({ code: "INSTANT_NOT_STRICTLY_LATER" });
      expect(listing.content.locality).toBe("Kinsale");
      expect(listing.timestamps.lastUpdatedAt).toBe(UPDATED);
    }
  });

  it("material success returns a new Listing and preserves every non-content field", () => {
    const listing: Listing = {
      ...pendingListing(),
      timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED },
    };
    const edited = expectOk(applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, LATER));

    expect(edited).not.toBe(listing);
    expect(edited.id).toBe(listing.id);
    expect(edited.status).toBe("pending");
    expect(edited.timestamps.submittedAt).toBe(SUBMITTED);
    expect(edited.timestamps.rejectedAt).toBeUndefined();
    expect(edited.publication).toBeUndefined();
    expect(edited.content).not.toBe(listing.content);
  });

  it("the content a material edit produces is complete, not a difference", () => {
    const listing = pendingListing({ ...CONTENT, phone: { value: CARRIER.phone, designatedPublic: true } });
    const edited = expectOk(applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, LATER));

    expect(edited.content).toEqual({
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Clonakilty",
      country: "IE",
      phone: { value: CARRIER.phone, designatedPublic: true },
    });
  });

  it("a restriction is material and is applied, not refused and not ignored", () => {
    const listing = listingWith("email", { value: CARRIER.email, designatedPublic: true });
    const edited = expectOk(
      applyAdministrativeEdit(
        listing,
        { email: supply({ value: CARRIER.email, designatedPublic: false }) },
        LATER,
      ),
    );

    expect(edited.content.email).toEqual({ value: CARRIER.email, designatedPublic: false });
    expect(edited.timestamps.lastUpdatedAt).toBe(LATER);
  });

  it("completion of a submission that arrived with no contact method is permitted", () => {
    // `FR-ADM-04`'s own purpose: the contact minimum is a before-approval rule, not this one's,
    // so a completion that adds the first contact method succeeds here.
    const listing = pendingListing();
    const edited = expectOk(
      applyAdministrativeEdit(
        listing,
        { phone: supply({ value: CARRIER.phone, designatedPublic: false }) },
        LATER,
      ),
    );

    expect(edited.content.phone).toEqual({ value: CARRIER.phone, designatedPublic: false });
  });

  it("a pending listing with no contact method at all is not refused for the contact minimum", () => {
    // The clearest proof that `validateBeforeApproval` is not the rule set in use: its
    // `CONTACT_METHOD_MINIMUM_UNMET` would fire on this exact input.
    const listing = pendingListing();

    expect(expectOk(applyAdministrativeEdit(listing, {}, LATER))).toBe(listing);
    expect(
      expectOk(applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, LATER)).content.locality,
    ).toBe("Clonakilty");
  });
});

/* ------------------------------------------------------------------------------------------- */
/* E. Precedence and accumulation                                                                */
/* ------------------------------------------------------------------------------------------- */

describe("failure precedence, stage by adjacent stage", () => {
  const BAD_EDIT = { name: { kind: "nonsense" } } as unknown as AdministrativeEdit;

  for (const status of ["approved", "rejected"] as const) {
    it(`lifecycle beats everything: a ${status} listing is refused before the patch is read`, () => {
      const listing: Listing = { ...pendingListing(), status: status as ListingStatus };

      expect(expectErr(applyAdministrativeEdit(listing, BAD_EDIT, LATER))).toEqual({
        code: "LISTING_NOT_PENDING",
        status,
      });
    });
  }

  it("lifecycle beats a would-be no-op, so a non-pending record is never silently accepted", () => {
    const listing: Listing = { ...pendingListing(), status: "approved" };

    expect(expectErr(applyAdministrativeEdit(listing, {}, LATER))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "approved",
    });
  });

  it("patch validity beats content validation", () => {
    const listing = pendingListing();
    // Blank name (a validation failure) *and* a malformed category instruction.
    const edit = {
      name: supply("   "),
      category: { kind: "supply" },
    } as unknown as AdministrativeEdit;

    expect(expectErr(applyAdministrativeEdit(listing, edit, LATER)).code).toBe(
      "INVALID_ADMINISTRATIVE_EDIT",
    );
  });

  it("content validation beats designation enforcement", () => {
    const listing = listingWith("phone", { value: CARRIER.phone, designatedPublic: false });
    const edit: AdministrativeEdit = {
      name: supply("   "),
      phone: supply({ value: CARRIER.phone, designatedPublic: true }),
    };

    expect(expectErr(applyAdministrativeEdit(listing, edit, LATER))).toEqual({
      code: "EDITED_CONTENT_INVALID",
      violations: [{ code: "REQUIRED_VALUE_MISSING", field: "name" }],
    });
  });

  it("designation enforcement beats the no-op determination", () => {
    const listing = listingWith("website", { value: CARRIER.website, designatedPublic: false });

    expect(
      expectErr(
        applyAdministrativeEdit(
          listing,
          { website: supply({ value: CARRIER.website, designatedPublic: true }) },
          LATER,
        ),
      ).code,
    ).toBe("DESIGNATION_POLICY_REFUSED");
  });

  it("the no-op determination beats the timestamp stage", () => {
    const listing = pendingListing();

    // Equal instant: a material edit would fail here, a no-op must not reach the check at all.
    expect(expectOk(applyAdministrativeEdit(listing, {}, UPDATED))).toBe(listing);
  });

  it("content violations accumulate, every one of them", () => {
    const listing = pendingListing();
    const edit: AdministrativeEdit = {
      name: supply(" "),
      description: supply(""),
      locality: supply("\t"),
      country: supply("  "),
    };
    const error = expectErr(applyAdministrativeEdit(listing, edit, LATER));

    expect(error).toEqual({
      code: "EDITED_CONTENT_INVALID",
      violations: [
        { code: "REQUIRED_VALUE_MISSING", field: "name" },
        { code: "REQUIRED_VALUE_MISSING", field: "description" },
        { code: "REQUIRED_VALUE_MISSING", field: "locality" },
        { code: "REQUIRED_VALUE_MISSING", field: "country" },
      ],
    });
  });

  it("an unapproved category is reported as CATEGORY_NOT_APPROVED, not as a malformed patch", () => {
    const listing = pendingListing();
    const edit = { category: supply("not-a-key") } as unknown as AdministrativeEdit;

    expect(expectErr(applyAdministrativeEdit(listing, edit, LATER))).toEqual({
      code: "EDITED_CONTENT_INVALID",
      violations: [{ code: "CATEGORY_NOT_APPROVED", field: "category" }],
    });
  });

  it("designation violations accumulate across all four fields in governed order", () => {
    const listing = pendingListing({
      ...CONTENT,
      postalCode: { value: CARRIER.postalCode, designatedPublic: false },
      phone: { value: CARRIER.phone, designatedPublic: false },
      email: { value: CARRIER.email, designatedPublic: false },
      website: { value: CARRIER.website, designatedPublic: false },
    });
    const edit: AdministrativeEdit = {
      // Deliberately listed out of policy order, to prove the *policy's* order is what is reported.
      website: supply({ value: OTHER.website, designatedPublic: true }),
      email: supply({ value: CARRIER.email, designatedPublic: true }),
      phone: supply({ value: OTHER.phone, designatedPublic: true }),
      postalCode: supply({ value: CARRIER.postalCode, designatedPublic: true }),
    };
    const error = expectErr(applyAdministrativeEdit(listing, edit, LATER));

    expect(error).toEqual({
      code: "DESIGNATION_POLICY_REFUSED",
      violations: [
        widening("postalCode", "unchanged"),
        widening("phone", "replaced"),
        widening("email", "unchanged"),
        widening("website", "replaced"),
      ],
    });
  });

  it("no failure ever carries a partial listing", () => {
    const listing = pendingListing();
    const failures: readonly Result<Listing, AdministrativeEditFailure>[] = [
      applyAdministrativeEdit({ ...listing, status: "approved" }, {}, LATER),
      applyAdministrativeEdit(listing, BAD_EDIT, LATER),
      applyAdministrativeEdit(listing, { name: supply(" ") }, LATER),
      applyAdministrativeEdit(
        listingWith("phone", { value: CARRIER.phone, designatedPublic: false }),
        { phone: supply({ value: CARRIER.phone, designatedPublic: true }) },
        LATER,
      ),
      applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, EARLIER),
    ];

    for (const result of failures) {
      expect(result.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, "value")).toBe(false);
    }
  });

  it("every failure code it can produce is one of the authorized ones", () => {
    const listing = pendingListing();
    const observed = new Set(
      [
        applyAdministrativeEdit({ ...listing, status: "approved" }, {}, LATER),
        applyAdministrativeEdit(listing, BAD_EDIT, LATER),
        applyAdministrativeEdit(listing, { name: supply(" ") }, LATER),
        applyAdministrativeEdit(
          listingWith("phone", { value: CARRIER.phone, designatedPublic: false }),
          { phone: supply({ value: CARRIER.phone, designatedPublic: true }) },
          LATER,
        ),
        applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, EARLIER),
        applyAdministrativeEdit(listing, { locality: supply("Clonakilty") }, undefined as unknown as Instant),
      ].map((r) => expectErr(r).code),
    );

    expect([...observed].sort()).toEqual([
      "DESIGNATION_POLICY_REFUSED",
      "EDITED_CONTENT_INVALID",
      "INSTANT_NOT_STRICTLY_LATER",
      "INVALID_ADMINISTRATIVE_EDIT",
      "INVALID_INSTANT",
      "LISTING_NOT_PENDING",
    ]);
  });

  it("the reachable timestamp failures are exactly the documented subset", () => {
    const listing = pendingListing();
    const material: AdministrativeEdit = { locality: supply("Clonakilty") };

    const invalidInstant = expectErr(
      applyAdministrativeEdit(listing, material, "nope" as unknown as Instant),
    ) satisfies TimestampAdvancementFailure | AdministrativeEditFailure;
    const notLater = expectErr(applyAdministrativeEdit(listing, material, UPDATED));
    const missing = expectErr(
      applyAdministrativeEdit(
        { ...listing, timestamps: undefined as unknown as Listing["timestamps"] },
        material,
        LATER,
      ),
    );

    expect(invalidInstant.code).toBe("INVALID_INSTANT");
    expect(notLater.code).toBe("INSTANT_NOT_STRICTLY_LATER");
    expect(missing.code).toBe("LISTING_TIMESTAMPS_MISSING");
  });
});

/* ------------------------------------------------------------------------------------------- */
/* F. Immutability and determinism                                                               */
/* ------------------------------------------------------------------------------------------- */

describe("immutability and determinism", () => {
  const FULL: ListingContent = {
    ...CONTENT,
    administrativeArea: "County Cork",
    postalCode: { value: CARRIER.postalCode, designatedPublic: true },
    phone: { value: CARRIER.phone, designatedPublic: false },
  };

  it("mutates neither the listing, its content, its nested values, nor the patch", () => {
    const listing = pendingListing(FULL);
    const listingBefore = structuredClone(listing as unknown as Record<string, unknown>);
    const supplied: DesignatableValue = { value: OTHER.phone, designatedPublic: false };
    const edit: AdministrativeEdit = {
      name: supply("Harbour Bakery & Cafe"),
      administrativeArea: REMOVE,
      phone: supply(supplied),
      email: PRESERVE,
    };
    const editBefore = structuredClone(edit as unknown as Record<string, unknown>);

    expectOk(applyAdministrativeEdit(listing, edit, LATER));

    expect(structuredClone(listing as unknown as Record<string, unknown>)).toEqual(listingBefore);
    expect(structuredClone(edit as unknown as Record<string, unknown>)).toEqual(editBefore);
    expect(supplied).toEqual({ value: OTHER.phone, designatedPublic: false });
  });

  it("mutates nothing on a refusal either", () => {
    const listing = pendingListing(FULL);
    const before = structuredClone(listing as unknown as Record<string, unknown>);

    expectErr(applyAdministrativeEdit(listing, { name: supply("  ") }, LATER));

    expect(structuredClone(listing as unknown as Record<string, unknown>)).toEqual(before);
  });

  it("a frozen listing and a frozen patch are both accepted, which proves nothing is written", () => {
    const content = Object.freeze({ ...FULL });
    const listing = Object.freeze({ ...pendingListing(content as ListingContent) });
    const edit = Object.freeze({ name: Object.freeze(supply("Harbour Bakery & Cafe")) });

    const edited = expectOk(applyAdministrativeEdit(listing, edit, LATER));

    expect(edited.content.name).toBe("Harbour Bakery & Cafe");
  });

  it("repeated calls with the same inputs give the same outcome", () => {
    const listing = pendingListing(FULL);
    const edit: AdministrativeEdit = { locality: supply("Clonakilty") };

    const first = expectOk(applyAdministrativeEdit(listing, edit, LATER));
    const second = expectOk(applyAdministrativeEdit(listing, edit, LATER));

    expect(second).toEqual(first);
    expect(second).not.toBe(first);

    const firstNoOp = applyAdministrativeEdit(listing, {}, LATER);
    const secondNoOp = applyAdministrativeEdit(listing, {}, LATER);

    expect(expectOk(firstNoOp)).toBe(listing);
    expect(expectOk(secondNoOp)).toBe(listing);
  });

  it("no ambient time affects the result — the same inputs an hour apart are identical", () => {
    // Not a timing test: the clock is not consulted, so two calls separated by any real elapsed
    // time must be byte-identical. Nothing sleeps and nothing is thresholded.
    const listing = pendingListing(FULL);
    const edit: AdministrativeEdit = { description: supply("A small bakery and cafe.") };

    const a = expectOk(applyAdministrativeEdit(listing, edit, LATER));
    const b = expectOk(applyAdministrativeEdit(listing, edit, LATER));

    expect(JSON.stringify(a.content)).toBe(JSON.stringify(b.content));
    expect(a.timestamps.lastUpdatedAt).toBe(b.timestamps.lastUpdatedAt);
  });
});
