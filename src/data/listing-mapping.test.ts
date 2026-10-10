/**
 * Attacking tests for the `C9` listing mapping (issue #177).
 *
 * Serialization is exercised for fidelity. **Hydration is attacked**: a row is untrusted input,
 * so every test below that builds one builds it the way a console, a restore or a bug could —
 * including shapes the store's own `CHECK`s would refuse — and requires an **explicit failure**
 * rather than a repaired or half-built aggregate.
 *
 * The round-trip against a real server lives in `listing-persistence.integration.test.ts`; these
 * prove the mapping itself, where every row shape is reachable.
 */
import { describe, expect, it } from "vitest";

import { CATEGORY_KEYS } from "../domain/listing/category";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { Listing } from "../domain/listing/listing";
import type { CategoryKey } from "../domain/listing/category";
import { hydrateListing, serializeSubmittedListing } from "./listing-mapping";
import type { ListingRow } from "./listing-table";

const SUBMITTED_AT = 1_767_323_045_123;
const UPDATED_AT = 1_767_323_045_123;
const REJECTED_AT = 1_767_323_999_001;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

const IDENTIFIER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The minimal pending submission: five required fields, no optional value at all. */
const minimalSubmission: Listing = {
  id: listingIdOf(IDENTIFIER),
  status: "pending",
  content: {
    name: "Harbour Bakery",
    category: "food-drink",
    description: "A small bakery.",
    locality: "Kinsale",
    country: "IE",
  },
  timestamps: { submittedAt: instant(SUBMITTED_AT), lastUpdatedAt: instant(UPDATED_AT) },
};

/** A pending submission carrying every optional value and a mix of designations. */
const fullSubmission: Listing = {
  ...minimalSubmission,
  content: {
    ...minimalSubmission.content,
    administrativeArea: "County Cork",
    postalCode: { value: "P17 ABC", designatedPublic: true },
    phone: { value: "+353 21 000 0000", designatedPublic: true },
    email: { value: "hello@example.ie", designatedPublic: false },
    website: { value: "https://example.ie" },
  },
};

/** A row as the configured connection delivers one: instants already epoch milliseconds. */
function rowOf(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: IDENTIFIER,
    status: "pending",
    name: "Harbour Bakery",
    category: "food-drink",
    description: "A small bakery.",
    locality: "Kinsale",
    country: "IE",
    administrative_area: null,
    postal_code: null,
    postal_code_designated_public: false,
    phone: null,
    phone_designated_public: false,
    email: null,
    email_designated_public: false,
    website: null,
    website_designated_public: false,
    publication_state: null,
    unpublish_reason: null,
    submitted_at: SUBMITTED_AT,
    last_updated_at: UPDATED_AT,
    rejected_at: null,
    ...overrides,
  };
}

/** A designatable value with its designation stated, which is how the store records it. */
function withDesignation<K extends string>(
  key: K,
  value: { readonly value: string; readonly designatedPublic?: boolean } | undefined,
): Partial<Record<K, { readonly value: string; readonly designatedPublic: boolean }>> {
  return value === undefined
    ? {}
    : ({ [key]: { value: value.value, designatedPublic: value.designatedPublic === true } } as Record<
        K,
        { readonly value: string; readonly designatedPublic: boolean }
      >);
}

describe("serializing a submitted listing", () => {
  it("uses the application's identifier exactly as supplied (ADR-019)", () => {
    expect(serializeSubmittedListing(minimalSubmission).id).toBe(IDENTIFIER);
  });

  it("records the submitted status and nothing that applies only later", () => {
    const row = serializeSubmittedListing(minimalSubmission);

    expect(row.status).toBe("pending");
    expect(row.publication_state).toBeNull();
    expect(row.unpublish_reason).toBeNull();
    expect(row.rejected_at).toBeNull();
  });

  it("writes an absent optional value as SQL null, never as an empty string", () => {
    const row = serializeSubmittedListing(minimalSubmission);

    expect(row.administrative_area).toBeNull();
    expect(row.postal_code).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
    expect(row.website).toBeNull();
  });

  it("defaults every designation of an absent value to false (PS-2, fail-closed)", () => {
    const row = serializeSubmittedListing(minimalSubmission);

    expect(row.postal_code_designated_public).toBe(false);
    expect(row.phone_designated_public).toBe(false);
    expect(row.email_designated_public).toBe(false);
    expect(row.website_designated_public).toBe(false);
  });

  it("carries each designation beside its own value (PS-2)", () => {
    const row = serializeSubmittedListing(fullSubmission);

    expect(row.postal_code).toBe("P17 ABC");
    expect(row.postal_code_designated_public).toBe(true);
    expect(row.phone_designated_public).toBe(true);
    expect(row.email_designated_public).toBe(false);
    // Supplied with no designation at all: fail-closed, not public.
    expect(row.website).toBe("https://example.ie");
    expect(row.website_designated_public).toBe(false);
  });

  it("stores the governed category key, never a label", () => {
    expect(serializeSubmittedListing(minimalSubmission).category).toBe("food-drink");
    expect(CATEGORY_KEYS).toContain(serializeSubmittedListing(minimalSubmission).category);
  });

  it("stores every approved category key unchanged", () => {
    for (const category of CATEGORY_KEYS) {
      const listing: Listing = {
        ...minimalSubmission,
        content: { ...minimalSubmission.content, category },
      };

      expect(serializeSubmittedListing(listing).category).toBe(category);
    }
  });

  it("preserves location text exactly, with no trimming or normalization (ADR-020)", () => {
    const listing: Listing = {
      ...minimalSubmission,
      content: {
        ...minimalSubmission.content,
        name: "  Harbour  Bakery  ",
        locality: "  Kinsale ",
        country: "ie",
        administrativeArea: "co. CORK  ",
      },
    };
    const row = serializeSubmittedListing(listing);

    expect(row.name).toBe("  Harbour  Bakery  ");
    expect(row.locality).toBe("  Kinsale ");
    expect(row.country).toBe("ie");
    expect(row.administrative_area).toBe("co. CORK  ");
  });

  it("builds the instants as expressions, not as bare numbers or Dates", () => {
    const row = serializeSubmittedListing(minimalSubmission);

    for (const value of [row.submitted_at, row.last_updated_at]) {
      expect(typeof value).toBe("object");
      expect(value).not.toBeInstanceOf(Date);
      // A Kysely expression, which is what a `timestamptz` column can actually accept.
      expect(typeof (value as { toOperationNode?: unknown }).toOperationNode).toBe("function");
    }
  });

  it("does not mutate the listing it serializes", () => {
    const snapshot = JSON.stringify(fullSubmission);

    serializeSubmittedListing(fullSubmission);

    expect(JSON.stringify(fullSubmission)).toBe(snapshot);
  });

  it("is deterministic", () => {
    const first = serializeSubmittedListing(fullSubmission);
    const second = serializeSubmittedListing(fullSubmission);

    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    expect(first.id).toBe(second.id);
    expect(first.postal_code_designated_public).toBe(second.postal_code_designated_public);
  });
});

describe("hydrating a stored listing", () => {
  it("rebuilds a pending listing with no optional field present", () => {
    const result = hydrateListing(rowOf());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("pending");
    expect(result.value.content.category).toBe("food-drink");
    expect(result.value.publication).toBeUndefined();
    expect(result.value.timestamps.rejectedAt).toBeUndefined();
    // Absent, not present-and-undefined: an explicit `undefined` key would survive
    // serialization and `Object.keys` as though the field existed.
    expect(Object.keys(result.value.content).sort()).toEqual([
      "category",
      "country",
      "description",
      "locality",
      "name",
    ]);
    expect("publication" in result.value).toBe(false);
    expect("rejectedAt" in result.value.timestamps).toBe(false);
  });

  it("round-trips the identifier through the governed boundary", () => {
    const result = hydrateListing(rowOf());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toEqual(listingIdOf(IDENTIFIER));
  });

  it("rebuilds every optional value with its own designation", () => {
    const result = hydrateListing(
      rowOf({
        administrative_area: "County Cork",
        postal_code: "P17 ABC",
        postal_code_designated_public: true,
        phone: "+353 21 000 0000",
        phone_designated_public: false,
        email: "hello@example.ie",
        email_designated_public: true,
        website: "https://example.ie",
        website_designated_public: false,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content.administrativeArea).toBe("County Cork");
    expect(result.value.content.postalCode).toEqual({
      value: "P17 ABC",
      designatedPublic: true,
    });
    expect(result.value.content.phone).toEqual({
      value: "+353 21 000 0000",
      designatedPublic: false,
    });
    expect(result.value.content.email).toEqual({
      value: "hello@example.ie",
      designatedPublic: true,
    });
    expect(result.value.content.website).toEqual({
      value: "https://example.ie",
      designatedPublic: false,
    });
  });

  it("rebuilds an approved, publicly available listing", () => {
    const result = hydrateListing(
      rowOf({ status: "approved", publication_state: "publicly_available" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.publication).toEqual({ value: "publicly_available" });
  });

  it("rebuilds an approved, unpublished listing with its reason", () => {
    const result = hydrateListing(
      rowOf({
        status: "approved",
        publication_state: "unpublished",
        unpublish_reason: "Reported by a visitor",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.publication).toEqual({
      value: "unpublished",
      reason: "Reported by a visitor",
    });
  });

  it("rebuilds a rejected listing with its write-once rejection anchor (PS-9)", () => {
    const result = hydrateListing(rowOf({ status: "rejected", rejected_at: REJECTED_AT }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.timestamps.rejectedAt).toEqual(instant(REJECTED_AT));
  });

  it("preserves millisecond precision on every instant", () => {
    const result = hydrateListing(
      rowOf({ submitted_at: SUBMITTED_AT, last_updated_at: SUBMITTED_AT + 1 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.timestamps.submittedAt).toEqual(instant(SUBMITTED_AT));
    expect(result.value.timestamps.lastUpdatedAt).toEqual(instant(SUBMITTED_AT + 1));
  });

  it("admits a pre-epoch instant, which ADR-022 allows", () => {
    const result = hydrateListing(
      rowOf({ submitted_at: -2_208_988_800_123, last_updated_at: -2_208_988_800_123 }),
    );

    expect(result.ok).toBe(true);
  });

  it("lets no Date into the domain", () => {
    const result = hydrateListing(rowOf({ status: "rejected", rejected_at: REJECTED_AT }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const value of Object.values(result.value.timestamps)) {
      expect(value).not.toBeInstanceOf(Date);
    }
    expect(JSON.stringify(result.value)).not.toContain("T00:00:00");
  });

  it("does not mutate the row, and does not share its mutable state", () => {
    const row = rowOf({ postal_code: "P17 ABC", postal_code_designated_public: true });
    const snapshot = JSON.stringify(row);
    const result = hydrateListing(row);

    expect(JSON.stringify(row)).toBe(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Mutating the row afterwards must not reach the hydrated aggregate.
    row.postal_code = "CHANGED";
    row.postal_code_designated_public = false;

    expect(result.value.content.postalCode).toEqual({
      value: "P17 ABC",
      designatedPublic: true,
    });
  });

  it("loads no revision and invents no revision identity", () => {
    const result = hydrateListing(rowOf());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(result.value)).not.toContain("revision");
    expect(Object.keys(result.value).sort()).toEqual([
      "content",
      "id",
      "status",
      "timestamps",
    ]);
  });

  it("accepts every approved category key", () => {
    for (const category of CATEGORY_KEYS) {
      expect(hydrateListing(rowOf({ category })).ok, category).toBe(true);
    }
  });
});

describe("hydration refuses a row the domain cannot represent", () => {
  it("refuses an unknown status", () => {
    for (const status of ["", "Pending", "archived", "approved ", "unknown"]) {
      const result = hydrateListing(rowOf({ status }));

      expect(result.ok, status).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({ code: "UNKNOWN_LISTING_STATUS", column: "status" });
    }
  });

  it("refuses an unapproved category, however plausible it looks", () => {
    for (const category of [
      "food-and-drink",
      "retail",
      "other",
      "uncategorized",
      "FOOD-DRINK",
      " food-drink",
      "Food & Drink",
      "",
    ]) {
      const result = hydrateListing(rowOf({ category }));

      expect(result.ok, category).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({ code: "UNAPPROVED_CATEGORY", column: "category" });
    }
  });

  it("refuses an unknown publication value on an approved row", () => {
    const result = hydrateListing(
      rowOf({ status: "approved", publication_state: "semi_public" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toEqual({
      code: "UNKNOWN_PUBLICATION_STATE",
      column: "publication_state",
    });
  });

  it("refuses an approved row with no publication state, rather than assuming public", () => {
    const result = hydrateListing(rowOf({ status: "approved", publication_state: null }));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toEqual({
      code: "PUBLICATION_STATE_NOT_APPLICABLE",
      column: "publication_state",
    });
  });

  it("refuses a publication state on a listing that is not approved", () => {
    for (const status of ["pending", "rejected"]) {
      const result = hydrateListing(
        rowOf({
          status,
          publication_state: "publicly_available",
          rejected_at: status === "rejected" ? REJECTED_AT : null,
        }),
      );

      expect(result.ok, status).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({
        code: "PUBLICATION_STATE_NOT_APPLICABLE",
        column: "publication_state",
      });
    }
  });

  it("refuses an unpublished listing with no reason", () => {
    const result = hydrateListing(
      rowOf({ status: "approved", publication_state: "unpublished", unpublish_reason: null }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toEqual({
      code: "UNPUBLISH_REASON_NOT_APPLICABLE",
      column: "unpublish_reason",
    });
  });

  it("refuses a reason on a publicly available listing, rather than ignoring it", () => {
    const result = hydrateListing(
      rowOf({
        status: "approved",
        publication_state: "publicly_available",
        unpublish_reason: "left behind by an earlier unpublish",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toEqual({
      code: "UNPUBLISH_REASON_NOT_APPLICABLE",
      column: "unpublish_reason",
    });
  });

  it("refuses a rejected listing with no rejection anchor (PS-9)", () => {
    const result = hydrateListing(rowOf({ status: "rejected", rejected_at: null }));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toEqual({
      code: "REJECTION_TIMESTAMP_NOT_APPLICABLE",
      column: "rejected_at",
    });
  });

  it("refuses a rejection anchor on a listing that is not rejected", () => {
    for (const status of ["pending", "approved"]) {
      const result = hydrateListing(
        rowOf({
          status,
          rejected_at: REJECTED_AT,
          publication_state: status === "approved" ? "publicly_available" : null,
        }),
      );

      expect(result.ok, status).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({
        code: "REJECTION_TIMESTAMP_NOT_APPLICABLE",
        column: "rejected_at",
      });
    }
  });

  it("refuses an instant that is not a safe-integer millisecond count", () => {
    const cases: [Partial<ListingRow>, string][] = [
      [{ submitted_at: 1.5 }, "submitted_at"],
      [{ last_updated_at: Number.NaN }, "last_updated_at"],
      [{ submitted_at: Number.MAX_SAFE_INTEGER + 2 }, "submitted_at"],
      [{ last_updated_at: Number.POSITIVE_INFINITY }, "last_updated_at"],
      [{ status: "rejected", rejected_at: 0.25 }, "rejected_at"],
    ];

    for (const [overrides, column] of cases) {
      const result = hydrateListing(rowOf(overrides));

      expect(result.ok, column).toBe(false);
      if (result.ok) return;

      expect(result.error).toEqual({ code: "UNUSABLE_INSTANT", column });
    }
  });

  it("names the column and never echoes the offending stored value", () => {
    const secretish = "P17-ABC-do-not-echo";
    const result = hydrateListing(rowOf({ category: secretish }));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(JSON.stringify(result.error)).not.toContain(secretish);
  });
});

describe("the designation anomaly follows the issue's stated rule", () => {
  it("hydrates a designation flag with a null value as an absent field", () => {
    // No `CHECK` ties the flag to a non-null value and the column is `not null default false`,
    // so the store can hold this. There is nothing to designate, so the field is absent — the
    // only reading that cannot publish a designation for a value that does not exist.
    const result = hydrateListing(
      rowOf({
        postal_code: null,
        postal_code_designated_public: true,
        phone: null,
        phone_designated_public: true,
        email: null,
        email_designated_public: true,
        website: null,
        website_designated_public: true,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect("postalCode" in result.value.content).toBe(false);
    expect("phone" in result.value.content).toBe(false);
    expect("email" in result.value.content).toBe(false);
    expect("website" in result.value.content).toBe(false);
    expect(result.value.content.postalCode).toBeUndefined();
  });

  it("does not invent a value to carry the stray flag", () => {
    const result = hydrateListing(
      rowOf({ phone: null, phone_designated_public: true }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(result.value)).not.toContain("designatedPublic");
  });
});

describe("serialization and hydration round-trip without loss", () => {
  const legalShapes: readonly Listing[] = [
    minimalSubmission,
    fullSubmission,
    {
      ...fullSubmission,
      content: { ...fullSubmission.content, category: "retail-shopping" as CategoryKey },
    },
  ];

  /**
   * The one thing a round trip cannot preserve, and why that is correct.
   *
   * `DesignatableValue.designatedPublic` is **optional** in the domain so that an *undecided*
   * designation is expressible, and `listing.ts` states the rule for it: *"an attribute whose
   * designation is undecided is **not public**"*. The store has no third state — `ADR-017`
   * `PS-2` makes the column `boolean not null default false` precisely so that undecided and
   * explicitly-private are **the same stored fact**. So a value submitted with no designation
   * comes back designated `false`: the same meaning, recorded explicitly. Nothing governed is
   * lost, and hydration must not instead omit a `false` it genuinely read, which would make a
   * deliberate "not public" indistinguishable from an absent field in the other direction.
   */
  const withExplicitDesignations = (listing: Listing): Listing => ({
    ...listing,
    content: {
      ...listing.content,
      ...withDesignation("postalCode", listing.content.postalCode),
      ...withDesignation("phone", listing.content.phone),
      ...withDesignation("email", listing.content.email),
      ...withDesignation("website", listing.content.website),
    },
  });

  it("collapses an undecided designation to not-public, as PS-2 requires", () => {
    const row = serializeSubmittedListing(fullSubmission);

    // Submitted with no designation at all.
    expect(fullSubmission.content.website).toEqual({ value: "https://example.ie" });
    expect("designatedPublic" in (fullSubmission.content.website ?? {})).toBe(false);
    // Stored as the fail-closed default, and read back as the same meaning, stated outright.
    expect(row.website_designated_public).toBe(false);
  });

  it("returns the same aggregate for every legal submission shape", () => {
    for (const listing of legalShapes) {
      const row = serializeSubmittedListing(listing);

      // The instants come back as the epoch milliseconds the parser would deliver; everything
      // else is the row exactly as written.
      const delivered = {
        ...row,
        submitted_at: SUBMITTED_AT,
        last_updated_at: UPDATED_AT,
        rejected_at: null,
        administrative_area: row.administrative_area ?? null,
        postal_code: row.postal_code ?? null,
        phone: row.phone ?? null,
        email: row.email ?? null,
        website: row.website ?? null,
        publication_state: row.publication_state ?? null,
        unpublish_reason: row.unpublish_reason ?? null,
        postal_code_designated_public: row.postal_code_designated_public ?? false,
        phone_designated_public: row.phone_designated_public ?? false,
        email_designated_public: row.email_designated_public ?? false,
        website_designated_public: row.website_designated_public ?? false,
      } as ListingRow;

      const hydrated = hydrateListing(delivered);

      expect(hydrated.ok).toBe(true);
      if (!hydrated.ok) return;

      expect(hydrated.value).toEqual(withExplicitDesignations(listing));
    }
  });
});
