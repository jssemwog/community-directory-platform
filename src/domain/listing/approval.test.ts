/**
 * Attacking tests for the `OP-7` / `FR-ADM-06` pure-domain approval of a pending listing
 * (issue #238).
 *
 * Pure domain: no cluster, no clock, no sleep, no wall-clock threshold, no retry-until-green, no
 * environment gate and no production fault-injection hook. Every instant is supplied.
 *
 * **The already-approved case is attacked from both sides.** A control proves that the shared
 * primitive, called alone, would approve an approved listing a second time through its permitted
 * content-only edge; the operation under test must refuse it (U-1, Option B). The `docs/09`
 * operation-boundary no-op is deferred to the later `OP-7` scope and is **not** asserted here.
 *
 * **Designations are table-driven across all four designatable fields**, because the failure mode
 * that matters is getting a *field* wrong, not a case.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  approvePendingListing,
  type ApprovalTimestampFailure,
  type ApprovePendingListingFailure,
} from "./approval";
import type { CategoryKey } from "./category";
import { instantOf, type Instant } from "./instant";
import type { DesignatableValue, Listing, ListingContent } from "./listing";
import { listingIdOf } from "./listing-id";
import { projectListingPublicly } from "./public-projection";
import type { DomainError, Result } from "./result";
import { transitionListingStatus, type ListingStatus } from "./status";
import { validateBeforeApproval, type ValidationViolation } from "./validation";

/** The four governed fields, in `ADR-025` order. Pinned here, not imported. */
const DESIGNATABLE = ["postalCode", "phone", "email", "website"] as const;
type Designatable = (typeof DESIGNATABLE)[number];

function instant(epochMilliseconds: number): Instant {
  const made = instantOf(epochMilliseconds);

  if (made.ok) {
    return made.value;
  }

  throw new Error(`fixture instant ${epochMilliseconds} is not usable`);
}

const SUBMITTED = instant(1_700_000_000_000);
const UPDATED = instant(1_700_000_100_000);
const LATER = instant(1_700_000_200_000);
const EARLIER = instant(1_700_000_050_000);

/** Valid before approval by the existing rules: the five required fields and one contact. */
const CONTENT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  email: { value: "hello@example.ie" },
};

/** Valid at initial submission, but carrying no contact method at all. */
const NO_CONTACT: ListingContent = {
  name: "Harbour Bakery",
  category: "food-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

/** Invalid for approval on two content grounds: a blank required field and no contact. */
const INVALID: ListingContent = { ...NO_CONTACT, name: "  " };

const ID = listingIdOf("11111111-1111-4111-8111-111111111111");

function pendingListing(content: ListingContent = CONTENT): Listing {
  return {
    id: ID,
    status: "pending",
    content,
    timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED },
  };
}

function approvedListing(content: ListingContent = CONTENT): Listing {
  return {
    id: ID,
    status: "approved",
    content,
    publication: { value: "publicly_available" },
    timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED },
  };
}

function unpublishedListing(content: ListingContent = CONTENT): Listing {
  return {
    id: ID,
    status: "approved",
    content,
    publication: { value: "unpublished", reason: "Closed for renovation" },
    timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED },
  };
}

function rejectedListing(content: ListingContent = CONTENT): Listing {
  return {
    id: ID,
    status: "rejected",
    content,
    timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED, rejectedAt: UPDATED },
  };
}

/** A listing whose status is outside the governed set, as a cast or rehydrated record can be. */
function unknownStatusListing(status: unknown, content: ListingContent = CONTENT): Listing {
  return { ...pendingListing(content), status: status as ListingStatus };
}

/** A listing whose stored timestamps are replaced wholesale, through a cast. */
function withTimestamps(timestamps: unknown, content: ListingContent = CONTENT): Listing {
  return { ...pendingListing(content), timestamps: timestamps as Listing["timestamps"] };
}

/** An instant-shaped value that is not a usable instant. */
const MALFORMED_AT = { epochMilliseconds: 1.5 } as unknown as Instant;

function expectErr(result: Result<Listing, ApprovePendingListingFailure>): ApprovePendingListingFailure {
  if (result.ok) {
    throw new Error("expected a refusal, got a listing");
  }

  return result.error;
}

function expectOk(result: Result<Listing, ApprovePendingListingFailure>): Listing {
  if (result.ok) {
    return result.value;
  }

  throw new Error(`expected a listing, got ${JSON.stringify(result.error)}`);
}

function snapshot(value: unknown): unknown {
  return structuredClone(value);
}

/* ------------------------------------------------------------------------------------------- */
/* AC-10 — compile-time and structural proof                                                     */
/* ------------------------------------------------------------------------------------------- */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;

/** The exact signature: a listing and an instant, and nothing else (no actor, token, note, override or retry). */
type _ExactParameters = Assert<Equals<Parameters<typeof approvePendingListing>, [Listing, Instant]>>;
type _ExactReturn = Assert<
  Equals<ReturnType<typeof approvePendingListing>, Result<Listing, ApprovePendingListingFailure>>
>;

/** The exact failure union: two local members, then `DomainError` intact. */
type _ExactFailureUnion = Assert<
  Equals<
    ApprovePendingListingFailure,
    | { readonly code: "LISTING_NOT_PENDING"; readonly status: string }
    | { readonly code: "LISTING_CONTENT_INVALID"; readonly violations: readonly ValidationViolation[] }
    | DomainError
  >
>;

/** The shared vocabulary is unchanged: neither local code was added to `DomainError`. */
type _NoListingNotPendingInDomainError = Assert<
  Equals<Extract<DomainError, { code: "LISTING_NOT_PENDING" }>, never>
>;
type _NoListingContentInvalidInDomainError = Assert<
  Equals<Extract<DomainError, { code: "LISTING_CONTENT_INVALID" }>, never>
>;

/** The unknown-status code is the existing `DomainError` member, carried unchanged. */
type _UnknownStatusIsTheExistingMember = Assert<
  Equals<
    Extract<ApprovePendingListingFailure, { code: "UNKNOWN_LISTING_STATUS" }>,
    { readonly code: "UNKNOWN_LISTING_STATUS"; readonly offered: unknown }
  >
>;

/** The reachable timestamp subset is exactly six `DomainError` members, and no rejection code. */
type _TimestampSubsetIsExact = Assert<
  Equals<
    ApprovalTimestampFailure["code"],
    | "LISTING_TIMESTAMPS_MISSING"
    | "INVALID_LISTING_TIMESTAMPS"
    | "INVALID_INSTANT"
    | "TIMESTAMP_ORDER_VIOLATION"
    | "REJECTION_TIMESTAMP_NOT_APPLICABLE"
    | "INSTANT_NOT_STRICTLY_LATER"
  >
>;
type _TimestampSubsetIsDomainError = Assert<ApprovalTimestampFailure extends DomainError ? true : false>;

/** Failures this operation must not be able to report at all. */
type _NoStaleFailure = Assert<
  Equals<Extract<ApprovePendingListingFailure, { code: "STALE_LISTING_VERSION" }>, never>
>;
type _NoStorageFailure = Assert<
  Equals<Extract<ApprovePendingListingFailure, { code: "STORAGE_FAILURE" }>, never>
>;

describe("AC-10 — the module structural boundary", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("./approval.ts", import.meta.url)), "utf8");

  it("imports only the five sibling domain modules it composes, and nothing from src/data", () => {
    const specifiers = [...SOURCE.matchAll(/from\s+\x22([^\x22]+)\x22/g)].map((m) => m[1]);

    expect(specifiers.sort()).toEqual(["./instant", "./listing", "./result", "./status", "./validation"]);
  });

  it("exports exactly the authorized value surface", async () => {
    const module = await import("./approval");

    expect(Object.keys(module).sort()).toEqual(["approvePendingListing"]);
  });

  it("declares exactly the authorized exported names in its source", () => {
    const exported = [...SOURCE.matchAll(/export\s+(?:type|interface|function|const)\s+(\w+)/g)].map(
      (m) => m[1],
    );

    expect(exported.sort()).toEqual([
      "ApprovalTimestampFailure",
      "ApprovePendingListingFailure",
      "approvePendingListing",
    ]);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-1 — approval of a pending listing                                                          */
/* ------------------------------------------------------------------------------------------- */

describe("AC-1 FR-ADM-06 BI-8 DI-1 DI-2 DI-6 DI-8 — approving a pending listing", () => {
  it("approves a pending listing to exactly approved, publicly available, lastUpdatedAt at, with identity, content and submittedAt unchanged", () => {
    const listing = pendingListing();

    const approved = expectOk(approvePendingListing(listing, LATER));

    expect(approved).toEqual({
      id: ID,
      status: "approved",
      content: CONTENT,
      publication: { value: "publicly_available" },
      timestamps: { submittedAt: SUBMITTED, lastUpdatedAt: LATER },
    });
    expect(approved).not.toBe(listing);
  });

  it("records exactly the supplied instant as lastUpdatedAt and carries no rejectedAt", () => {
    const approved = expectOk(approvePendingListing(pendingListing(), LATER));

    expect(approved.timestamps.lastUpdatedAt).toBe(LATER);
    expect(approved.timestamps.submittedAt).toBe(SUBMITTED);
    expect(approved.timestamps.rejectedAt).toBeUndefined();
  });

  it("carries the content object through by reference, so nothing in it can be rewritten", () => {
    const content: ListingContent = {
      ...CONTENT,
      administrativeArea: "County Cork",
      postalCode: { value: "P17 AB12", designatedPublic: true },
      phone: { value: "+353 21 123 4567", designatedPublic: false },
    };

    const approved = expectOk(approvePendingListing(pendingListing(content), LATER));

    expect(approved.content).toBe(content);
    expect(approved.id).toBe(ID);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-2 — the status set, then the lifecycle (U-1 Option B; C-8)                                 */
/* ------------------------------------------------------------------------------------------- */

describe("AC-2 FR-ADM-06 DI-1 DI-2 BI-8 U-1 Option B — status set then lifecycle", () => {
  it("control: the shared primitive alone would approve an approved listing a second time through the content-only edge", () => {
    // This is the hazard the lifecycle guard exists for. If this control ever fails, the
    // primitive changed and the reasoning behind the guard must be revisited.
    const second = transitionListingStatus(approvedListing(), "approved", LATER);

    expect(second.ok).toBe(true);
  });

  it("refuses an approved, publicly available source with LISTING_NOT_PENDING approved, even with valid content and an advancing instant", () => {
    expect(expectErr(approvePendingListing(approvedListing(), LATER))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "approved",
    });
  });

  it("refuses an approved, unpublished source with LISTING_NOT_PENDING approved, and never republishes it", () => {
    expect(expectErr(approvePendingListing(unpublishedListing(), LATER))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "approved",
    });
  });

  it("refuses a rejected source with LISTING_NOT_PENDING rejected, even with valid content and an advancing instant", () => {
    expect(expectErr(approvePendingListing(rejectedListing(), LATER))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "rejected",
    });
  });

  it("returns no listing on a lifecycle refusal, so no second transition, timestamp advance or publication change exists", () => {
    const result = approvePendingListing(approvedListing(), LATER);

    expect(result).toEqual({ ok: false, error: { code: "LISTING_NOT_PENDING", status: "approved" } });
    expect(Object.keys(result).sort()).toEqual(["error", "ok"]);
  });

  const OUT_OF_SET: readonly (readonly [string, unknown])[] = [
    ["an unknown string", "bogus"],
    ["a mis-cased governed value", "Pending"],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { status: "pending" }],
  ];

  it.each(OUT_OF_SET)(
    "reports an out-of-set status (%s) as UNKNOWN_LISTING_STATUS carrying the same value, never LISTING_NOT_PENDING",
    (_label, status) => {
      const error = expectErr(approvePendingListing(unknownStatusListing(status), LATER));

      expect(error.code).toBe("UNKNOWN_LISTING_STATUS");
      expect(Object.keys(error).sort()).toEqual(["code", "offered"]);
      expect((error as { readonly offered: unknown }).offered).toBe(status);
    },
  );
});

/* ------------------------------------------------------------------------------------------- */
/* AC-3, AC-4 — the before-approval obligations, reused unchanged                                */
/* ------------------------------------------------------------------------------------------- */

const CONTACT_MINIMUM_UNMET = {
  code: "CONTACT_METHOD_MINIMUM_UNMET",
  fields: ["phone", "email", "website"],
} as const;

describe("AC-3 AC-4 FR-ADM-06 FR-VAL-05 VR-S2 FR-DATA-08 DI-9 — before-approval content validation", () => {
  it("refuses content with no usable contact method with LISTING_CONTENT_INVALID carrying CONTACT_METHOD_MINIMUM_UNMET", () => {
    expect(expectErr(approvePendingListing(pendingListing(NO_CONTACT), LATER))).toEqual({
      code: "LISTING_CONTENT_INVALID",
      violations: [CONTACT_MINIMUM_UNMET],
    });
  });

  it("refuses content whose only contact value is whitespace, because usable means non-blank", () => {
    const content: ListingContent = { ...NO_CONTACT, email: { value: "   ", designatedPublic: true } };

    expect(expectErr(approvePendingListing(pendingListing(content), LATER))).toEqual({
      code: "LISTING_CONTENT_INVALID",
      violations: [CONTACT_MINIMUM_UNMET],
    });
  });

  it("refuses full location data without a contact method, because location never counts and there is no offline exemption", () => {
    const content: ListingContent = {
      ...NO_CONTACT,
      administrativeArea: "County Cork",
      postalCode: { value: "P17 AB12", designatedPublic: true },
    };

    expect(expectErr(approvePendingListing(pendingListing(content), LATER))).toEqual({
      code: "LISTING_CONTENT_INVALID",
      violations: [CONTACT_MINIMUM_UNMET],
    });
  });

  it("carries every validateBeforeApproval violation unchanged and in its order: required fields, category, contact minimum", () => {
    const content = {
      ...NO_CONTACT,
      name: "",
      description: "  ",
      category: "not-an-approved-key" as CategoryKey,
    };
    const expected = [
      { code: "REQUIRED_VALUE_MISSING", field: "name" },
      { code: "REQUIRED_VALUE_MISSING", field: "description" },
      { code: "CATEGORY_NOT_APPROVED", field: "category" },
      CONTACT_MINIMUM_UNMET,
    ];

    const error = expectErr(approvePendingListing(pendingListing(content), LATER));
    const reference = validateBeforeApproval(content);

    expect(error).toEqual({ code: "LISTING_CONTENT_INVALID", violations: expected });
    expect(reference.ok).toBe(false);
    expect(error).toEqual({ code: "LISTING_CONTENT_INVALID", violations: reference.ok ? [] : reference.error });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-5 — timestamps, through the existing primitive                                             */
/* ------------------------------------------------------------------------------------------- */

describe("AC-5 DI-6 NFR-DATA-05 FR-AUD-03 — timestamps through the existing transition", () => {
  it("refuses an instant equal to lastUpdatedAt with INSTANT_NOT_STRICTLY_LATER", () => {
    expect(expectErr(approvePendingListing(pendingListing(), UPDATED))).toEqual({
      code: "INSTANT_NOT_STRICTLY_LATER",
    });
  });

  it("refuses an instant earlier than lastUpdatedAt with INSTANT_NOT_STRICTLY_LATER", () => {
    expect(expectErr(approvePendingListing(pendingListing(), EARLIER))).toEqual({
      code: "INSTANT_NOT_STRICTLY_LATER",
    });
  });

  it("refuses a malformed instant with INVALID_INSTANT carrying the offered value", () => {
    const error = expectErr(approvePendingListing(pendingListing(), MALFORMED_AT));

    expect(error.code).toBe("INVALID_INSTANT");
    expect((error as { readonly offered: unknown }).offered).toBe(MALFORMED_AT);
  });

  const STORED_DEFECTS: readonly (readonly [string, unknown, ApprovalTimestampFailure])[] = [
    ["absent", undefined, { code: "LISTING_TIMESTAMPS_MISSING" }],
    ["null", null, { code: "INVALID_LISTING_TIMESTAMPS", offered: null }],
    [
      "a malformed submittedAt",
      { submittedAt: MALFORMED_AT, lastUpdatedAt: UPDATED },
      { code: "INVALID_INSTANT", offered: MALFORMED_AT },
    ],
    [
      "submittedAt after lastUpdatedAt",
      { submittedAt: LATER, lastUpdatedAt: UPDATED },
      { code: "TIMESTAMP_ORDER_VIOLATION", field: "submittedAt" },
    ],
    [
      "a rejectedAt on a pending listing",
      { submittedAt: SUBMITTED, lastUpdatedAt: UPDATED, rejectedAt: UPDATED },
      { code: "REJECTION_TIMESTAMP_NOT_APPLICABLE", status: "pending" },
    ],
  ];

  it.each(STORED_DEFECTS)("reports stored timestamps that are %s with the existing code", (_label, timestamps, expected) => {
    expect(expectErr(approvePendingListing(withTimestamps(timestamps), LATER))).toEqual(expected);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-6 — precedence, each case failing at two or more stages                                    */
/* ------------------------------------------------------------------------------------------- */

describe("AC-6 failure precedence — status set, lifecycle, content, then timestamps", () => {
  it("an unknown status wins over invalid content and a non-advancing instant", () => {
    expect(expectErr(approvePendingListing(unknownStatusListing("bogus", INVALID), EARLIER))).toEqual({
      code: "UNKNOWN_LISTING_STATUS",
      offered: "bogus",
    });
  });

  it("an approved source wins over invalid content and a non-advancing instant", () => {
    expect(expectErr(approvePendingListing(approvedListing(INVALID), EARLIER))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "approved",
    });
  });

  it("a rejected source wins over invalid content and a non-advancing instant", () => {
    expect(expectErr(approvePendingListing(rejectedListing(INVALID), EARLIER))).toEqual({
      code: "LISTING_NOT_PENDING",
      status: "rejected",
    });
  });

  it("invalid content wins over a non-advancing instant", () => {
    expect(expectErr(approvePendingListing(pendingListing(INVALID), EARLIER)).code).toBe("LISTING_CONTENT_INVALID");
  });

  it("invalid content wins over a malformed instant", () => {
    expect(expectErr(approvePendingListing(pendingListing(INVALID), MALFORMED_AT)).code).toBe(
      "LISTING_CONTENT_INVALID",
    );
  });

  it("invalid content wins over malformed stored timestamps", () => {
    expect(expectErr(approvePendingListing(withTimestamps(null, INVALID), LATER)).code).toBe(
      "LISTING_CONTENT_INVALID",
    );
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-7 — publication state is not field visibility                                              */
/* ------------------------------------------------------------------------------------------- */

const CARRIER: Record<Designatable, string> = {
  postalCode: "P17 AB12",
  phone: "+353 21 123 4567",
  email: "contact@example.ie",
  website: "https://example.ie",
};

const DESIGNATION_STATES: readonly (readonly [string, boolean | undefined])[] = [
  ["the designation is absent", undefined],
  ["it is designated private", false],
  ["it is designated public", true],
];

const DESIGNATION_ROWS = DESIGNATABLE.flatMap((field) =>
  DESIGNATION_STATES.map(([label, designatedPublic]) => [field, label, designatedPublic] as const),
);

function designatable(field: Designatable, designatedPublic: boolean | undefined): DesignatableValue {
  return designatedPublic === undefined
    ? { value: CARRIER[field] }
    : { value: CARRIER[field], designatedPublic };
}

describe("AC-7 ADR-017 Q-4 ADR-025 BI-6 — approval preserves every designation and widens none", () => {
  it.each(DESIGNATION_ROWS)(
    "preserves the %s value and designation when %s, and the public projection exposes it only if it was already public",
    (field, _label, designatedPublic) => {
      const value = designatable(field, designatedPublic);
      const content: ListingContent = { ...CONTENT, [field]: value };

      const approved = expectOk(approvePendingListing(pendingListing(content), LATER));

      expect(approved.content[field]).toBe(value);
      expect(approved.content[field]).toEqual(designatable(field, designatedPublic));

      const projected = projectListingPublicly(approved);

      if (projected.ok) {
        expect(projected.value[field]).toBe(designatedPublic === true ? CARRIER[field] : undefined);

        for (const other of DESIGNATABLE.filter((candidate) => candidate !== field)) {
          // The base content carries a private email and nothing else designatable.
          expect(projected.value[other]).toBeUndefined();
        }
      } else {
        throw new Error(`expected an approved listing to project, got ${JSON.stringify(projected.error)}`);
      }
    },
  );
});

/* ------------------------------------------------------------------------------------------- */
/* AC-8 — immutability                                                                           */
/* ------------------------------------------------------------------------------------------- */

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && Object.isFrozen(value) === false) {
    Object.freeze(value);

    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }

  return value;
}

describe("AC-8 immutability — nothing given is mutated, and no failure carries a listing", () => {
  const FULL: ListingContent = {
    ...CONTENT,
    administrativeArea: "County Cork",
    postalCode: { value: CARRIER.postalCode, designatedPublic: true },
    phone: { value: CARRIER.phone, designatedPublic: false },
  };

  const CASES: readonly (readonly [string, () => Listing, Instant])[] = [
    ["a success", () => pendingListing(FULL), LATER],
    ["an approved source", () => approvedListing(FULL), LATER],
    ["a rejected source", () => rejectedListing(FULL), LATER],
    ["an unknown status", () => unknownStatusListing("bogus", FULL), LATER],
    ["invalid content", () => pendingListing(INVALID), LATER],
    ["a non-advancing instant", () => pendingListing(FULL), EARLIER],
  ];

  it.each(CASES)("mutates neither the listing, its content, its designations nor its timestamps on %s", (_label, make, at) => {
    const listing = make();
    const before = snapshot(listing);

    approvePendingListing(listing, at);

    expect(snapshot(listing)).toEqual(before);
  });

  it.each(CASES)("accepts a deeply frozen input on %s, which proves nothing is written", (_label, make, at) => {
    const listing = deepFreeze(make());

    expect(() => approvePendingListing(listing, at)).not.toThrow();
  });

  it.each(CASES.slice(1))("returns only a failure, with no listing alongside it, on %s", (_label, make, at) => {
    const result = approvePendingListing(make(), at);

    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["error", "ok"]);
  });

  it("repeated calls with the same inputs give equal, distinct results", () => {
    const listing = pendingListing(FULL);

    const first = expectOk(approvePendingListing(listing, LATER));
    const second = expectOk(approvePendingListing(listing, LATER));

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-9 — an inherited limitation, characterized and not endorsed                                */
/* ------------------------------------------------------------------------------------------- */

describe("AC-9 inherited limitation of the current domain composition (characterization only)", () => {
  it("characterization only: a malformed pending input carrying a publication value currently approves to publicly_available; this records present behaviour, not a policy", () => {
    // A pending row cannot carry a publication state in the store. The pending branch of the
    // shared transition does not read the field, so the outcome below is what the present
    // composition produces. It is not an approved repair or normalization policy and not a
    // guarantee about arbitrary inputs; if it changes, that change must be reviewed, not assumed.
    const malformed: Listing = {
      ...pendingListing(),
      publication: { value: "unpublished", reason: "Not applicable while pending" },
    };

    expect(expectOk(approvePendingListing(malformed, LATER)).publication).toEqual({
      value: "publicly_available",
    });
  });
});

/* ------------------------------------------------------------------------------------------- */
/* AC-11 — the reachable failure set                                                             */
/* ------------------------------------------------------------------------------------------- */

describe("AC-11 the reachable failure set", () => {
  it("produces every code in the documented reachable set, and none outside it", () => {
    const outcomes = [
      approvePendingListing(unknownStatusListing("bogus"), LATER),
      approvePendingListing(approvedListing(), LATER),
      approvePendingListing(rejectedListing(), LATER),
      approvePendingListing(pendingListing(INVALID), LATER),
      approvePendingListing(withTimestamps(undefined), LATER),
      approvePendingListing(withTimestamps(null), LATER),
      approvePendingListing(withTimestamps({ submittedAt: MALFORMED_AT, lastUpdatedAt: UPDATED }), LATER),
      approvePendingListing(withTimestamps({ submittedAt: LATER, lastUpdatedAt: UPDATED }), LATER),
      approvePendingListing(
        withTimestamps({ submittedAt: SUBMITTED, lastUpdatedAt: UPDATED, rejectedAt: UPDATED }),
        LATER,
      ),
      approvePendingListing(pendingListing(), MALFORMED_AT),
      approvePendingListing(pendingListing(), UPDATED),
    ];
    const reachable: readonly string[] = [
      "UNKNOWN_LISTING_STATUS",
      "LISTING_NOT_PENDING",
      "LISTING_CONTENT_INVALID",
      "LISTING_TIMESTAMPS_MISSING",
      "INVALID_LISTING_TIMESTAMPS",
      "INVALID_INSTANT",
      "TIMESTAMP_ORDER_VIOLATION",
      "REJECTION_TIMESTAMP_NOT_APPLICABLE",
      "INSTANT_NOT_STRICTLY_LATER",
    ];

    const produced = new Set(outcomes.map((outcome) => expectErr(outcome).code));

    expect([...produced].sort()).toEqual([...reachable].sort());
  });
});
