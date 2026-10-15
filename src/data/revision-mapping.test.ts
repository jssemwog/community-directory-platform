/**
 * Attacking tests for the revision mapping boundary (issue #195).
 *
 * Serialization is checked for **exactness and completeness** — every governed field reaches its
 * column, nothing is trimmed, defaulted or invented, and the captured token is written exactly as
 * captured. Hydration is checked **adversarially**: these rows are the ones a console, a later
 * migration, a restore or a bug could write, and each must fail as itself rather than be repaired.
 *
 * The real-PostgreSQL half lives in `revision-persistence.integration.test.ts`; nothing here
 * touches a database, so these cases are instant and independent of any server.
 */
import { describe, expect, it } from "vitest";

import { CATEGORY_KEYS, type CategoryKey } from "../domain/listing/category";
import { instantOf, type Instant } from "../domain/listing/instant";
import { listingIdOf } from "../domain/listing/listing-id";
import type { PendingListingRevision } from "../domain/listing/revision";
import { hydratePendingRevision, serializePendingRevision } from "./revision-mapping";
import type { ListingRevisionRow } from "./listing-table";

const REVISION_ID = "7f1d4a7e-2c3b-4f9a-8d1e-5b6c7a8d9e01";
const LISTING_ID = "11111111-2222-3333-4444-555555555555";
const BASE_TOKEN = 1_767_323_045_123;

function instant(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);

  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }

  return result.value;
}

/** A pending proposal, exactly as the domain would have produced it. */
function pending(
  overrides: Partial<PendingListingRevision> = {},
): PendingListingRevision {
  return {
    listingId: listingIdOf(LISTING_ID),
    state: "pending",
    proposedContent: {
      name: "Harbour Bakery",
      category: "food-drink",
      description: "A small bakery.",
      locality: "Kinsale",
      country: "IE",
    },
    baseListingLastUpdatedAt: instant(BASE_TOKEN),
    ...overrides,
  } as PendingListingRevision;
}

/** A stored pending row, as the configured connection delivers one. */
function row(overrides: Partial<ListingRevisionRow> = {}): ListingRevisionRow {
  return {
    id: REVISION_ID,
    listing_id: LISTING_ID,
    state: "pending",
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
    rejected_at: null,
    base_listing_last_updated_at: BASE_TOKEN,
    ...overrides,
  };
}

describe("serializing a pending revision", () => {
  it("writes the supplied identifiers exactly, generating nothing", () => {
    // `ADR-019` makes the application the sole generator and declares no database default, so
    // there is nothing to fall back on — and nothing here may invent one.
    const insert = serializePendingRevision(REVISION_ID, pending());

    expect(insert.id).toBe(REVISION_ID);
    expect(insert.listing_id).toBe(LISTING_ID);
  });

  it("writes the pending state and no rejection anchor", () => {
    // The applicability rule is recorded, not re-decided: a pending proposal has no anchor,
    // which is also what `listing_revision_rejected_at_check` requires.
    const insert = serializePendingRevision(REVISION_ID, pending());

    expect(insert.state).toBe("pending");
    expect(insert.rejected_at).toBeNull();
  });

  it("writes every governed content field, with absent optionals as SQL null", () => {
    const insert = serializePendingRevision(REVISION_ID, pending());

    expect(insert.name).toBe("Harbour Bakery");
    expect(insert.category).toBe("food-drink");
    expect(insert.description).toBe("A small bakery.");
    expect(insert.locality).toBe("Kinsale");
    expect(insert.country).toBe("IE");

    // Absent is SQL `null`, never `''` — the distinction `ADR-020` relies on.
    expect(insert.administrative_area).toBeNull();
    expect(insert.postal_code).toBeNull();
    expect(insert.phone).toBeNull();
    expect(insert.email).toBeNull();
    expect(insert.website).toBeNull();
  });

  it("writes each designation beside its value, fail-closed when the value is absent", () => {
    // `ADR-017` `PS-2`: there is nothing to designate without a value, and `false` is the
    // honest flag for it. Every flag is supplied explicitly rather than left to the default.
    const bare = serializePendingRevision(REVISION_ID, pending());

    expect(bare.postal_code_designated_public).toBe(false);
    expect(bare.phone_designated_public).toBe(false);
    expect(bare.email_designated_public).toBe(false);
    expect(bare.website_designated_public).toBe(false);

    const designated = serializePendingRevision(
      REVISION_ID,
      pending({
        proposedContent: {
          ...pending().proposedContent,
          postalCode: { value: "P17 AB12", designatedPublic: true },
          phone: { value: "+353 21 123 4567", designatedPublic: false },
          email: { value: "hello@example.ie", designatedPublic: true },
          website: { value: "https://example.ie", designatedPublic: false },
        },
      }),
    );

    expect(designated.postal_code).toBe("P17 AB12");
    expect(designated.postal_code_designated_public).toBe(true);
    expect(designated.phone).toBe("+353 21 123 4567");
    expect(designated.phone_designated_public).toBe(false);
    expect(designated.email).toBe("hello@example.ie");
    expect(designated.email_designated_public).toBe(true);
    expect(designated.website).toBe("https://example.ie");
    expect(designated.website_designated_public).toBe(false);
  });

  it("treats a missing designation flag as not public, rather than as permission", () => {
    // A value whose `designatedPublic` is absent must never serialize as public: the default is
    // fail-closed, and `=== true` is what makes an absent or truthy-but-not-true flag private.
    const insert = serializePendingRevision(
      REVISION_ID,
      pending({
        proposedContent: {
          ...pending().proposedContent,
          phone: { value: "+353 21 123 4567" } as never,
        },
      }),
    );

    expect(insert.phone).toBe("+353 21 123 4567");
    expect(insert.phone_designated_public).toBe(false);
  });

  it("never trims, folds or otherwise tidies a value", () => {
    // `VR-S3` leaves format expression undecided, so a persistence layer that "cleaned" a value
    // would be inventing a governed rule.
    const insert = serializePendingRevision(
      REVISION_ID,
      pending({
        proposedContent: {
          ...pending().proposedContent,
          name: "  Harbour   BAKERY  ",
          locality: " kinsale ",
        },
      }),
    );

    expect(insert.name).toBe("  Harbour   BAKERY  ");
    expect(insert.locality).toBe(" kinsale ");
  });

  it("writes the captured base token as an expression, not a bare number", () => {
    // PostgreSQL cannot cast a number to `timestamptz`, and the conversion must stay exact to
    // the millisecond, so the column receives the shared `row-mapping.ts` expression.
    const insert = serializePendingRevision(REVISION_ID, pending());

    expect(typeof insert.base_listing_last_updated_at).toBe("object");
    expect(insert.base_listing_last_updated_at).not.toBeInstanceOf(Date);
    expect(typeof insert.base_listing_last_updated_at).not.toBe("number");
  });

  it("mutates neither the revision nor its content", () => {
    const original = pending();
    const snapshot = JSON.stringify(original);

    serializePendingRevision(REVISION_ID, original);

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("hydrating a pending revision", () => {
  it("rebuilds the complete proposal, without the row's identifier", () => {
    const hydrated = hydratePendingRevision(row());

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    expect(hydrated.value.state).toBe("pending");
    expect(hydrated.value.listingId).toEqual(listingIdOf(LISTING_ID));
    expect(hydrated.value.proposedContent.name).toBe("Harbour Bakery");
    expect(hydrated.value.rejectedAt).toBeUndefined();

    // The row's `id` is deliberately not mapped: `ListingRevision` has no identifier field and
    // `DDM-2`'s revision identity domain type is open. Nothing may leak it in by the back door.
    expect(Object.keys(hydrated.value)).not.toContain("id");
    expect(JSON.stringify(hydrated.value)).not.toContain(REVISION_ID);
  });

  it("carries the base token as an exact epoch-millisecond instant, never a Date", () => {
    const hydrated = hydratePendingRevision(row());

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    expect(hydrated.value.baseListingLastUpdatedAt).toEqual(instant(BASE_TOKEN));
    expect(hydrated.value.baseListingLastUpdatedAt).not.toBeInstanceOf(Date);
    expect(JSON.stringify(hydrated.value.baseListingLastUpdatedAt)).toBe(
      JSON.stringify({ epochMilliseconds: BASE_TOKEN }),
    );
  });

  it.each([0, -1, -6_857_222_400_000, 253_402_300_799_999])(
    "round-trips the base token at %i, including pre-epoch values",
    (epochMilliseconds) => {
      // `ADR-022` admits pre-epoch instants, so a negative carrier is an ordinary value here
      // and must survive unchanged rather than be clamped to the epoch.
      const hydrated = hydratePendingRevision(
        row({ base_listing_last_updated_at: epochMilliseconds }),
      );

      expect(hydrated.ok).toBe(true);

      if (!hydrated.ok) return;

      expect(hydrated.value.baseListingLastUpdatedAt).toEqual(instant(epochMilliseconds));
    },
  );

  it.each(CATEGORY_KEYS)("accepts the approved category %s", (category: CategoryKey) => {
    const hydrated = hydratePendingRevision(row({ category }));

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    expect(hydrated.value.proposedContent.category).toBe(category);
  });

  it.each(["", "Food-Drink", "food drink", "other", "unknown-key"])(
    "refuses the unapproved category %o rather than dropping it",
    (category) => {
      const hydrated = hydratePendingRevision(row({ category }));

      expect(hydrated.ok).toBe(false);

      if (hydrated.ok) return;

      expect(hydrated.error).toEqual({ code: "UNAPPROVED_CATEGORY", column: "category" });
    },
  );

  it("keeps a null value absent rather than converting it to an empty string", () => {
    const hydrated = hydratePendingRevision(row());

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    const content = hydrated.value.proposedContent;

    // Absent, not present-and-empty: an explicit `undefined` key would survive `Object.keys`
    // and comparison as though the field existed.
    expect(Object.keys(content)).not.toContain("administrativeArea");
    expect(Object.keys(content)).not.toContain("postalCode");
    expect(Object.keys(content)).not.toContain("phone");
    expect(Object.keys(content)).not.toContain("email");
    expect(Object.keys(content)).not.toContain("website");
  });

  it("rebuilds each designatable value with its designation", () => {
    const hydrated = hydratePendingRevision(
      row({
        administrative_area: "Co. Cork",
        postal_code: "P17 AB12",
        postal_code_designated_public: true,
        phone: "+353 21 123 4567",
        phone_designated_public: false,
        email: "hello@example.ie",
        email_designated_public: true,
        website: "https://example.ie",
        website_designated_public: false,
      }),
    );

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    expect(hydrated.value.proposedContent).toMatchObject({
      administrativeArea: "Co. Cork",
      postalCode: { value: "P17 AB12", designatedPublic: true },
      phone: { value: "+353 21 123 4567", designatedPublic: false },
      email: { value: "hello@example.ie", designatedPublic: true },
      website: { value: "https://example.ie", designatedPublic: false },
    });
  });

  it("drops a designation flag standing over a null value, rather than leaking it", () => {
    // No `CHECK` ties the flag to a non-null column, and the flag is `not null default false`,
    // so the store can hold a `true` flag over `NULL`. There is nothing to designate in that
    // row, and the only reading that cannot leak a designation is to hydrate the field absent.
    const hydrated = hydratePendingRevision(
      row({ phone: null, phone_designated_public: true }),
    );

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    expect(Object.keys(hydrated.value.proposedContent)).not.toContain("phone");
  });

  it.each(["", "Pending", "PENDING", "draft", "withdrawn"])(
    "refuses the ungoverned stored state %o",
    (state) => {
      const hydrated = hydratePendingRevision(row({ state }));

      expect(hydrated.ok).toBe(false);

      if (hydrated.ok) return;

      expect(hydrated.error).toEqual({ code: "UNKNOWN_REVISION_STATE", column: "state" });
    },
  );

  it("reports a stored approved revision as unpersistable, not merely unknown", () => {
    // `ADR-017` Q-3 removes the approved proposal in the same atomic unit that applies it, and
    // `001`'s `CHECK` forbids the value — so observing one is an integrity fault in the store
    // and is reported as itself.
    const hydrated = hydratePendingRevision(row({ state: "approved" }));

    expect(hydrated.ok).toBe(false);

    if (hydrated.ok) return;

    expect(hydrated.error).toEqual({
      code: "UNPERSISTABLE_REVISION_STATE",
      column: "state",
    });
  });

  it("reports a rejected revision as not pending, which is not a corruption claim", () => {
    // Nothing is wrong with the row; it is simply not this slice's business. Retrieving
    // rejected history is a later unit, and it would force `DDM-2`'s identity decision.
    const hydrated = hydratePendingRevision(
      row({ state: "rejected", rejected_at: BASE_TOKEN + 5 }),
    );

    expect(hydrated.ok).toBe(false);

    if (hydrated.ok) return;

    expect(hydrated.error).toEqual({ code: "REVISION_NOT_PENDING", column: "state" });
  });

  it("refuses a pending revision carrying a rejection anchor", () => {
    // A state no governed operation can produce: the anchor is written **by** the rejection
    // (`ADR-017` Q-1/Q-2). Refused rather than dropped, so the contradiction cannot be hidden.
    const hydrated = hydratePendingRevision(row({ rejected_at: BASE_TOKEN + 5 }));

    expect(hydrated.ok).toBe(false);

    if (hydrated.ok) return;

    expect(hydrated.error).toEqual({
      code: "REJECTION_TIMESTAMP_NOT_APPLICABLE",
      column: "rejected_at",
    });
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 2 ** 53])(
    "refuses the unusable stored base token %o rather than repairing it",
    (base_listing_last_updated_at) => {
      // `ADR-023` item 12 — the token is mandatory and exact. A non-safe-integer carrier is an
      // unreadable value, not an absence, and it is never defaulted to anything.
      const hydrated = hydratePendingRevision(row({ base_listing_last_updated_at }));

      expect(hydrated.ok).toBe(false);

      if (hydrated.ok) return;

      expect(hydrated.error).toEqual({
        code: "UNUSABLE_INSTANT",
        column: "base_listing_last_updated_at",
      });
    },
  );

  it("refuses a Date in the base-token column, rather than coercing it", () => {
    // Reachable only if the governed parser is not registered on the pool, which is exactly
    // when silent coercion would hide a misconfigured connection (`ADR-022` decision 9).
    const hydrated = hydratePendingRevision(
      row({ base_listing_last_updated_at: new Date(BASE_TOKEN) as never }),
    );

    expect(hydrated.ok).toBe(false);

    if (hydrated.ok) return;

    expect(hydrated.error).toEqual({
      code: "UNUSABLE_INSTANT",
      column: "base_listing_last_updated_at",
    });
  });

  it("names the column at fault and never echoes the stored value", () => {
    // These failures reach callers and logs, and a stored value is proposed listing content
    // this layer has no business re-publishing in an error string.
    const secret = "9 Harbour Row, Kinsale";
    const hydrated = hydratePendingRevision(
      row({ category: "not-a-category", administrative_area: secret }),
    );

    expect(hydrated.ok).toBe(false);

    if (hydrated.ok) return;

    const serialized = JSON.stringify(hydrated.error);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("not-a-category");
    expect(serialized).not.toContain(REVISION_ID);
    expect(Object.keys(hydrated.error)).toEqual(["code", "column"]);
  });

  it("judges the state before anything that depends on it", () => {
    // A rejected row whose category is also unapproved is reported as *not pending*: the row is
    // not this slice's business, and partially rebuilding it first would report the wrong fact.
    const hydrated = hydratePendingRevision(
      row({ state: "rejected", rejected_at: BASE_TOKEN, category: "not-a-category" }),
    );

    expect(hydrated.ok).toBe(false);

    if (hydrated.ok) return;

    expect(hydrated.error.code).toBe("REVISION_NOT_PENDING");
  });

  it("round-trips a fully populated proposal through both directions", () => {
    const original = pending({
      proposedContent: {
        name: "Harbour Bakery",
        category: "food-drink",
        description: "A small bakery.",
        locality: "Kinsale",
        country: "IE",
        administrativeArea: "Co. Cork",
        postalCode: { value: "P17 AB12", designatedPublic: true },
        phone: { value: "+353 21 123 4567", designatedPublic: false },
        email: { value: "hello@example.ie", designatedPublic: true },
        website: { value: "https://example.ie", designatedPublic: false },
      },
    });

    const insert = serializePendingRevision(REVISION_ID, original);

    // The instant arrives back from the store as a millisecond count, which is what the
    // integration suite proves end to end; here the rest of the row is carried across.
    const stored = row({
      ...(insert as unknown as ListingRevisionRow),
      base_listing_last_updated_at: BASE_TOKEN,
      rejected_at: null,
    });

    const hydrated = hydratePendingRevision(stored);

    expect(hydrated.ok).toBe(true);

    if (!hydrated.ok) return;

    expect(hydrated.value).toEqual(original);
  });
});
