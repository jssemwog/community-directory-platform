/**
 * Attacking tests for the public/withheld projection.
 *
 * Invariants under attack: `DI-5` at the domain level (no record whose status is not
 * *approved* has a public projection), the `OQ-7` field set (`S-2`), the `S-2`
 * fail-closed default, and `DI-10` (a pending revision is never reachable through the
 * public projection).
 *
 * `P1` Slice B (issue #139) adds `BI-4`/`FR-VIS-08`: an unpublished listing is withheld
 * too, and every unavailable case yields **one** outcome that discloses nothing. The
 * Slice A assertions below are preserved in intent; where one asserted the old
 * status-carrying refusal, it now asserts the disclosure-free outcome that replaced it,
 * because the shape it described is the observable difference `BI-4` forbids.
 */
import { describe, expect, it } from "vitest";

import type { Listing, ListingContent } from "./listing";
import { listingIdOf } from "./listing-id";
import type { PublicationState } from "./publication";
import {
  PUBLIC_PROJECTION_FIELDS,
  projectListingPublicly,
} from "./public-projection";
import type { ListingRevision } from "./revision";
import { LISTING_STATUSES } from "./status";

/** The single unavailable outcome (`FR-VIS-08`, `BI-4`). */
const UNAVAILABLE = { code: "LISTING_NOT_PUBLICLY_AVAILABLE" } as const;

/** Every governed attribute supplied, and every designation set to public. */
const fullyPublicContent: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  administrativeArea: "County Cork",
  postalCode: { value: "P17 XY12", designatedPublic: true },
  phone: { value: "+353 21 000 0000", designatedPublic: true },
  email: { value: "hello@example.test", designatedPublic: true },
  website: { value: "https://example.test", designatedPublic: true },
};

const listingId = listingIdOf("listing-1");

function approvedListing(content: ListingContent): Listing {
  return {
    id: listingId,
    status: "approved",
    content,
    publication: { value: "publicly_available" },
  };
}

const unpublishReason = "Reported as misleading; awaiting owner contact.";

function unpublishedListing(content: ListingContent): Listing {
  return {
    id: listingId,
    status: "approved",
    content,
    publication: { value: "unpublished", reason: unpublishReason },
  };
}

describe("record-level exposure (FR-VIS-02, DI-5)", () => {
  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "refuses a public projection for a %s record",
    (status) => {
      const result = projectListingPublicly({
        id: listingId,
        status,
        content: fullyPublicContent,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual(UNAVAILABLE);
      }
    },
  );

  it("projects an approved, publicly available record", () => {
    expect(projectListingPublicly(approvedListing(fullyPublicContent)).ok).toBe(true);
  });
});

/** Criterion 5 (projection half) — an unpublished listing is withheld. */
describe("criterion 5 — publication state gates the projection (FR-ADM-12)", () => {
  it("withholds an approved but unpublished listing", () => {
    const result = projectListingPublicly(unpublishedListing(fullyPublicContent));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(UNAVAILABLE);
    }
  });

  it("withholds an approved listing whose publication state is missing", () => {
    const result = projectListingPublicly({
      id: listingId,
      status: "approved",
      content: fullyPublicContent,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(UNAVAILABLE);
    }
  });

  it("withholds an approved listing whose publication state is malformed", () => {
    const result = projectListingPublicly({
      id: listingId,
      status: "approved",
      content: fullyPublicContent,
      publication: { value: "sort-of-public" } as unknown as PublicationState,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(UNAVAILABLE);
    }
  });
});

/** Criterion 12 — absent, pending, rejected and unpublished are indistinguishable. */
describe("criterion 12 — one unavailable outcome (FR-VIS-08, BI-4)", () => {
  const outcomes = {
    absent: projectListingPublicly(undefined),
    pending: projectListingPublicly({
      id: listingId,
      status: "pending",
      content: fullyPublicContent,
    }),
    rejected: projectListingPublicly({
      id: listingId,
      status: "rejected",
      content: fullyPublicContent,
    }),
    unpublished: projectListingPublicly(unpublishedListing(fullyPublicContent)),
  } as const;

  it("refuses all four", () => {
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.ok).toBe(false);
    }
  });

  it("returns the identical outcome for all four", () => {
    const serialized = Object.values(outcomes).map((outcome) =>
      JSON.stringify(outcome),
    );

    expect(new Set(serialized).size).toBe(1);
    for (const outcome of Object.values(outcomes)) {
      expect(outcome).toEqual({ ok: false, error: UNAVAILABLE });
    }
  });

  it("returns the same key set, so no case is distinguishable by shape", () => {
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(Object.keys(outcome.error)).toEqual(["code"]);
    }
  });
});

/** Criterion 13 — unavailable outcomes disclose nothing. */
describe("criterion 13 — the unavailable outcome discloses nothing", () => {
  it("carries no identity, status, publication value, reason, timestamp or revision content", () => {
    const pendingRevision: ListingRevision = {
      listingId,
      state: "pending",
      proposedContent: { ...fullyPublicContent, description: "PROPOSED DESCRIPTION" },
    };

    const result = projectListingPublicly(unpublishedListing(fullyPublicContent), [
      pendingRevision,
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const serialized = JSON.stringify(result.error);
    for (const disclosed of [
      "listing-1",
      "approved",
      "pending",
      "rejected",
      "unpublished",
      "publicly_available",
      unpublishReason,
      "PROPOSED DESCRIPTION",
      "Harbour Bakery",
      "submittedAt",
      "lastUpdatedAt",
    ]) {
      expect(serialized).not.toContain(disclosed);
    }

    expect(result.error).toEqual(UNAVAILABLE);
  });

  it("preserves the Slice A public field contract on a successful projection", () => {
    const result = projectListingPublicly(approvedListing(fullyPublicContent));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value).sort()).toEqual(
      [...PUBLIC_PROJECTION_FIELDS].sort(),
    );
  });

  it("adds no identifier field, and excludes administrative metadata", () => {
    const result = projectListingPublicly(approvedListing(fullyPublicContent));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const withheld of [
      "id",
      "listingId",
      "identifier",
      "slug",
      "status",
      "publication",
      "reason",
      "submittedAt",
      "lastUpdatedAt",
    ]) {
      expect(Object.keys(result.value)).not.toContain(withheld);
    }
  });
});

describe("field-level exposure (OQ-7, S-2)", () => {
  it("returns exactly the OQ-7 public field set and no other key", () => {
    const result = projectListingPublicly(approvedListing(fullyPublicContent));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exhaustive key-set comparison, not a spot check.
    expect(Object.keys(result.value).sort()).toEqual([...PUBLIC_PROJECTION_FIELDS].sort());
    expect([...PUBLIC_PROJECTION_FIELDS].sort()).toEqual(
      [
        "administrativeArea",
        "category",
        "country",
        "description",
        "email",
        "locality",
        "name",
        "phone",
        "postalCode",
        "website",
      ].sort(),
    );
  });

  it("never exposes identity, status, or any other attribute of the record", () => {
    const result = projectListingPublicly(approvedListing(fullyPublicContent));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const withheld of ["id", "status", "content", "submittedAt", "lastUpdatedAt"]) {
      expect(Object.keys(result.value)).not.toContain(withheld);
    }
  });

  it("withholds a contact method the business did not designate public", () => {
    const result = projectListingPublicly(
      approvedListing({
        ...fullyPublicContent,
        phone: { value: "+353 21 000 0000", designatedPublic: false },
        email: { value: "private@example.test", designatedPublic: false },
        website: { value: "https://example.test", designatedPublic: true },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value)).not.toContain("phone");
    expect(Object.keys(result.value)).not.toContain("email");
    expect(result.value.website).toBe("https://example.test");
    expect(JSON.stringify(result.value)).not.toContain("private@example.test");
  });

  it("fails closed where a designation is undecided (S-2)", () => {
    const result = projectListingPublicly(
      approvedListing({
        ...fullyPublicContent,
        postalCode: { value: "P17 XY12" },
        phone: { value: "+353 21 000 0000" },
        email: { value: "hello@example.test" },
        website: { value: "https://example.test" },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Administrative area stays public — OQ-7 makes it public where provided, with no
    // designation of its own. The designatable values all fall away.
    expect(Object.keys(result.value).sort()).toEqual([
      "administrativeArea",
      "category",
      "country",
      "description",
      "locality",
      "name",
    ]);
  });

  it("omits optional attributes that were never provided", () => {
    const result = projectListingPublicly(
      approvedListing({
        name: "Harbour Bakery",
        category: "food-and-drink",
        description: "A small bakery.",
        locality: "Kinsale",
        country: "IE",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value).sort()).toEqual([
      "category",
      "country",
      "description",
      "locality",
      "name",
    ]);
  });
});

describe("pending-revision invisibility (DI-10)", () => {
  it("exposes no value derived from a pending revision", () => {
    const pendingRevision: ListingRevision = {
      listingId,
      state: "pending",
      proposedContent: {
        name: "Harbour Bakery — NEW NAME",
        category: "retail",
        description: "PROPOSED DESCRIPTION",
        locality: "Cobh",
        country: "IE",
        phone: { value: "+353 21 999 9999", designatedPublic: true },
      },
    };

    const result = projectListingPublicly(approvedListing(fullyPublicContent), [
      pendingRevision,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.value);
    for (const proposed of [
      "NEW NAME",
      "PROPOSED DESCRIPTION",
      "retail",
      "Cobh",
      "+353 21 999 9999",
    ]) {
      expect(serialized).not.toContain(proposed);
    }

    // The effective public version is unchanged by the proposal's existence.
    const withoutRevision = projectListingPublicly(approvedListing(fullyPublicContent));
    expect(withoutRevision.ok).toBe(true);
    if (!withoutRevision.ok) return;

    expect(result.value).toEqual(withoutRevision.value);
  });
});
