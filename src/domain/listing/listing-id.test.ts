/**
 * Attacking tests for stable, content-independent listing identity (`DI-8`, `docs/08` **P2**).
 */
import { describe, expect, it } from "vitest";

import { instantOf, type Instant } from "./instant";
import { withListingContent, type Listing, type ListingContent } from "./listing";
import * as listingIdModule from "./listing-id";
import { listingIdEquals, listingIdOf } from "./listing-id";
import { transitionListingStatus } from "./status";

const content: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

function instantAt(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }
  return result.value;
}

const t0 = instantAt(1_000);
const t1 = instantAt(2_000);

/** `P1` Slice C (issue #141) — every listing carries its administrative moments. */
const listing: Listing = {
  id: listingIdOf("listing-1"),
  status: "pending",
  content,
  timestamps: { submittedAt: t0, lastUpdatedAt: t0 },
};

describe("listing identity (DI-8)", () => {
  it("survives a content edit — including a change of name", () => {
    const edited = withListingContent(
      listing,
      {
        ...content,
        name: "Harbour Bakery & Cafe",
        description: "A small bakery and cafe.",
      },
      t1,
    );

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(listingIdEquals(edited.value.id, listing.id)).toBe(true);
    expect(edited.value.content.name).not.toBe(listing.content.name);
  });

  it("survives every permitted status transition", () => {
    const approved = transitionListingStatus(listing, "approved", t1);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    expect(listingIdEquals(approved.value.id, listing.id)).toBe(true);

    const rejected = transitionListingStatus(listing, "rejected", t1);
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;

    expect(listingIdEquals(rejected.value.id, listing.id)).toBe(true);
  });

  it("is not derived from content — identical content does not make one identity", () => {
    const other: Listing = {
      id: listingIdOf("listing-2"),
      status: "pending",
      content,
      timestamps: { submittedAt: t0, lastUpdatedAt: t0 },
    };

    expect(listingIdEquals(other.id, listing.id)).toBe(false);
  });

  it("treats separately wrapped occurrences of the same identifier as one identity", () => {
    expect(listingIdEquals(listingIdOf("listing-1"), listingIdOf("listing-1"))).toBe(true);
  });

  it("distinguishes different identifiers", () => {
    expect(listingIdEquals(listingIdOf("listing-1"), listingIdOf("listing-3"))).toBe(false);
  });

  it("generates nothing — the module offers only wrapping and comparison (DDM-2)", () => {
    expect(Object.keys(listingIdModule).sort()).toEqual([
      "listingIdEquals",
      "listingIdOf",
    ]);
  });
});
