/**
 * `OP-6`'s integration with `ADR-025`, pinned at compile time and structurally (issue #207).
 *
 * The behaviour lives in `revision-persistence.integration.test.ts`, against a real server. What
 * cannot be proved there is the shape of the contract and the direction of the dependency: a
 * repository that quietly reimplemented the comparison, widened its input, made a designation
 * optional, or started normalizing values would still pass every behavioural case it happened to
 * have. These guards close that gap.
 *
 * The scanner below follows the **corrected** precedent now on `main`
 * (`src/domain/listing/designation.test.ts`): a single pass that strips comments and the inert
 * text of string and template literals while **keeping** `${…}` interpolations, because those
 * are executable. Its own anti-vacuity tests are carried with it — a structural test whose
 * stripper silently stops working asserts nothing at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { DesignationViolation } from "../domain/listing/designation";
import type { ListingRevision } from "../domain/listing/revision";
import type { Result } from "../domain/listing/result";
import type { ListingHydrationFailure } from "./listing-mapping";
import {
  createPendingRevision,
  type CreatePendingRevisionFailure,
} from "./revision-repository";

const REPOSITORY_PATH = fileURLToPath(new URL("./revision-repository.ts", import.meta.url));
const REPOSITORY_SOURCE = readFileSync(REPOSITORY_PATH, "utf8");
const DESIGNATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../domain/listing/designation.ts", import.meta.url)),
  "utf8",
);

/**
 * Source with comments and literal text removed, so prose cannot satisfy or trip a check.
 *
 * Carried from `designation.test.ts` deliberately rather than imported: a test helper exported
 * for reuse becomes a production-shaped surface, and the Release Gate's correction to this
 * scanner — keep `${…}`, strip the inert text around it, and recognise a string *before*
 * treating `//` as a comment so `https://` survives — is what must travel, not the identifier.
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

/** Every module specifier a source imports, however the import is written. */
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

/** Occurrences of `needle` in executable code, so comments and prose cannot inflate the count. */
function executableOccurrences(source: string, needle: string): number {
  return executableSource(source).split(needle).length - 1;
}

describe("the data layer consumes the domain rule rather than restating it", () => {
  it("imports the merged designation policy from the domain", () => {
    const specifiers = importSpecifiers(REPOSITORY_SOURCE);

    expect(specifiers).toContain("../domain/listing/designation");
    expect(specifiers).toContain("./listing-mapping");
  });

  it("invokes the policy exactly once, in executable code", () => {
    // One call site. Two would mean the rule runs twice — on different inputs, or after a
    // mutation — and nothing in the behavioural suite distinguishes a second, redundant call
    // on the same inputs from the single governed one.
    expect(executableOccurrences(REPOSITORY_SOURCE, "enforceDesignationPolicy(")).toBe(1);
  });

  it("mentions the policy in prose too, which is why the count reads executable code only", () => {
    // The positive control: a naive text count would be higher, so the helper is doing work.
    expect(REPOSITORY_SOURCE.split("enforceDesignationPolicy").length - 1).toBeGreaterThan(2);
  });

  it("reimplements no part of the comparison or the classification in the adapter", () => {
    const code = executableSource(REPOSITORY_SOURCE);

    for (const forbidden of [
      "designatedPublic",
      "DESIGNATION_WIDENING_REFUSED",
      "postalCode",
      "classifyDesignatableChange",
      // No normalization helper, of any of the shapes `ADR-025` forbids inventing.
      "toLowerCase",
      "toUpperCase",
      "trim(",
      "normalize(",
      "replace(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("introduces no listing write and no retry", () => {
    const code = executableSource(REPOSITORY_SOURCE);

    expect(code).not.toContain("updateTable");
    expect(code).not.toContain("deleteFrom");
    expect(code).not.toContain("setTimeout");
    expect(code).not.toMatch(/\bretry\b/i);
  });

  it("leaves the pure policy free of any data-layer dependency", () => {
    for (const specifier of importSpecifiers(DESIGNATION_SOURCE)) {
      expect(specifier.includes("data")).toBe(false);
      expect(specifier.startsWith("..")).toBe(false);
      expect(specifier.startsWith("node:")).toBe(false);
    }
  });

  it("wires no other consumer in this unit", () => {
    // `OP-10`, rejection, the public projection and every transport module must still not
    // consume the rule: revalidation elsewhere is separately sequenced work.
    for (const relative of [
      "./revision-approval.ts",
      "./revision-rejection.ts",
      "../domain/listing/public-projection.ts",
      "../domain/listing/revision.ts",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

      expect(executableSource(source)).not.toContain("enforceDesignationPolicy");
    }
  });

  it("the stripper actually strips, so every check above can fail", () => {
    const sample = [
      "const a = 1; /* designatedPublic */ // toLowerCase",
      'const b = "enforceDesignationPolicy(";',
      'const c = "https://example.ie"; // trailing trim(',
      "const d = `replace(`;",
    ].join("\n");
    const stripped = executableSource(sample);

    expect(stripped).not.toContain("designatedPublic");
    expect(stripped).not.toContain("toLowerCase");
    expect(stripped).not.toContain("enforceDesignationPolicy(");
    expect(stripped).not.toContain("example.ie");
    expect(stripped).not.toContain("trim(");
    expect(stripped).not.toContain("replace(");
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("const d =");
  });

  it("the stripper keeps template interpolations, which are executable", () => {
    const sample = [
      "const a = `" + "enforceDesignationPolicy( is inert here`" + ";",
      "const b = `" + "x${enforceDesignationPolicy()}y`" + ";",
    ].join("\n");
    const stripped = executableSource(sample);

    expect(stripped).not.toContain("is inert here");
    expect(stripped).toContain("enforceDesignationPolicy()");
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
 * `npm run typecheck` fails if the contract drifts. No runtime assertion can catch these: each
 * would leave the suite green while the type system quietly admitted something the governed
 * contract excludes.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;

type Create = typeof createPendingRevision;
type CreateParams = Parameters<Create>;
type CreateRequest = CreateParams[1];
type CreateResult = Awaited<ReturnType<Create>>;

/** The external input is unchanged: a database handle and the same two-field request. */
type _TwoParameters = Assert<Equals<CreateParams["length"], 2>>;
type _RequestShape = Assert<
  Equals<
    CreateRequest,
    { readonly revisionId: string; readonly revision: ListingRevision }
  >
>;

/** The success type is unchanged: nothing is returned, so no identity escapes the adapter. */
type _SuccessUnchanged = Assert<
  Equals<CreateResult, Result<void, CreatePendingRevisionFailure>>
>;
type _SuccessCarriesNothing = Assert<
  Equals<Extract<CreateResult, { ok: true }>["value"], void>
>;

/** No revision identifier is returned, and none is optional on the way in. */
type _IdentityStaysAdapterPrivate = Assert<
  Equals<"revisionId" extends keyof Extract<CreateResult, { ok: true }> ? true : false, false>
>;
type _IdentityIsRequired = Assert<Equals<undefined extends CreateRequest["revisionId"] ? true : false, false>>;

/** The base token stays mandatory: it is part of every revision state, never optional here. */
type _BaseTokenMandatory = Assert<
  Equals<undefined extends ListingRevision["baseListingLastUpdatedAt"] ? true : false, false>
>;

/** The exact failure union, member by member. A new member fails this, which is the point. */
type FailureCode = CreatePendingRevisionFailure["code"];
type _FailureUnion = Assert<
  Equals<
    FailureCode,
    | "LISTING_NOT_FOUND"
    | "LISTING_NOT_APPROVED"
    | "PENDING_REVISION_ALREADY_EXISTS"
    | "STALE_LISTING_VERSION"
    | "DESIGNATION_POLICY_REFUSED"
    | "STORED_LISTING_UNREADABLE"
    | "INVALID_PENDING_REVISION"
    | "REVISION_ALREADY_EXISTS"
    | "PENDING_UNIQUENESS_CONFLICT"
    | "RETRYABLE_CONFLICT"
    | "STORED_INSTANT_UNREADABLE"
    | "REVISION_PROTOCOL_FAILURE"
    | "STORAGE_FAILURE"
  >
>;

type DesignationRefusal = Extract<
  CreatePendingRevisionFailure,
  { readonly code: "DESIGNATION_POLICY_REFUSED" }
>;

/** The complete violation array, readonly, exactly as the pure rule produced it. */
type _ViolationsAreTheDomainArray = Assert<
  Equals<DesignationRefusal["violations"], readonly DesignationViolation[]>
>;
/** Readonly in the direction that matters: a caller cannot treat it as a mutable array. */
type _ViolationsNotMutable = Assert<
  Equals<DesignationRefusal["violations"] extends DesignationViolation[] ? true : false, false>
>;
type _RefusalCarriesNothingElse = Assert<
  Equals<keyof DesignationRefusal, "code" | "violations">
>;

type StoredListingUnreadable = Extract<
  CreatePendingRevisionFailure,
  { readonly code: "STORED_LISTING_UNREADABLE" }
>;

/** The safe mapper carrier, and nothing of the row. */
type _HydrationFailureCarrier = Assert<
  Equals<StoredListingUnreadable["failure"], ListingHydrationFailure>
>;
type _UnreadableCarriesNothingElse = Assert<
  Equals<keyof StoredListingUnreadable, "code" | "failure">
>;

/** No `Date`, raw row, transport type or `unknown` may reach the policy through this boundary. */
type _NoUnknownInRequest = Assert<Equals<unknown extends CreateRequest ? true : false, false>>;
type _NoDateInRequest = Assert<Equals<Date extends CreateRequest ? true : false, false>>;
type _NoRowInRequest = Assert<
  Equals<Record<string, unknown> extends CreateRequest ? true : false, false>
>;

/** No retry option was introduced: the request grew no third member and no configuration. */
type _NoRetryOption = Assert<Equals<"retry" extends keyof CreateRequest ? true : false, false>>;
type _NoAttemptsOption = Assert<
  Equals<"attempts" extends keyof CreateRequest ? true : false, false>
>;
