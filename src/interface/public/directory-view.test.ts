import { describe, expect, it } from "vitest";

import type { PublicListing, PublicListingReadFailure } from "../../data/public-listing-read";
import { err, ok } from "../../domain/listing/result";
import { DIRECTORY_COPY, NOT_AVAILABLE, directoryStateOf, listingDetailStateOf } from "./directory-view";

const STORAGE_FAILURE = { code: "STORAGE_FAILURE" } as unknown as PublicListingReadFailure;
const UNREADABLE_ROW = { code: "STORED_LISTING_UNREADABLE", failure: {} } as unknown as PublicListingReadFailure;
const NOT_PUBLICLY_AVAILABLE = Object.freeze({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" as const });

const FULL: PublicListing = {
  id: "0b7e4c52-6f1a-4d3b-8e29-5a1c7f3d9e01",
  listing: {
    name: "Juniper Lane Bakery",
    category: "food-drink",
    description: "A fictional bakery.",
    locality: "Elmstead",
    administrativeArea: "North Vale",
    country: "Exampleland",
    postalCode: "EX1 4JL",
    phone: "+1 555 0101",
    email: "hello@juniper-bakery.example",
    website: "https://juniper-bakery.example",
  },
};

const MINIMAL: PublicListing = {
  id: "1c8f5d63-7a2b-4e4c-9f3a-6b2d8a4e0f12",
  listing: {
    name: "Harbourside Bicycle Repair",
    category: "automotive-transport",
    description: "Fictional repairs.",
    locality: "Harrow Bay",
    country: "Exampleland",
  },
};

describe("S1 view state (docs/10 Empty states, Error states)", () => {
  it("never renders a read failure as an empty directory", () => {
    for (const failure of [STORAGE_FAILURE, UNREADABLE_ROW]) {
      const state = directoryStateOf(err(failure));

      expect(state).toEqual({ kind: "error" });
      expect(state.kind).not.toBe("empty-directory");
    }
  });

  it("distinguishes an empty directory from an error, with different wording", () => {
    expect(directoryStateOf(ok([]))).toEqual({ kind: "empty-directory" });
    expect(DIRECTORY_COPY.emptyDirectory).not.toBe(DIRECTORY_COPY.directoryError);
  });

  it("lists entries in the order the read path returned, with the approved category label", () => {
    const state = directoryStateOf(ok([FULL, MINIMAL]));

    expect(state).toEqual({
      kind: "results",
      entries: [
        { id: FULL.id, name: "Juniper Lane Bakery", category: "Food & Drink", place: "Elmstead, North Vale, Exampleland" },
        { id: MINIMAL.id, name: "Harbourside Bicycle Repair", category: "Automotive & Transport", place: "Harrow Bay, Exampleland" },
      ],
    });
  });

  it("withholds an unknown category key rather than showing it raw", () => {
    const state = directoryStateOf(ok([{ ...MINIMAL, listing: { ...MINIMAL.listing, category: "not-a-key" } }]));

    expect(state.kind === "results" && state.entries[0]).not.toHaveProperty("category");
  });
});

describe("S2 view state (docs/10 S2, UP-4)", () => {
  it("maps every not-publicly-available outcome to the one shared not-available state", () => {
    const first = listingDetailStateOf(err(NOT_PUBLICLY_AVAILABLE));
    const second = listingDetailStateOf(err({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" }));

    expect(first).toBe(NOT_AVAILABLE);
    expect(second).toBe(NOT_AVAILABLE);
    expect(Object.isFrozen(NOT_AVAILABLE)).toBe(true);
    expect(Object.keys(NOT_AVAILABLE)).toEqual(["kind"]);
  });

  it("renders a read failure as an error, never as not available", () => {
    for (const failure of [STORAGE_FAILURE, UNREADABLE_ROW]) {
      expect(listingDetailStateOf(err(failure))).toEqual({ kind: "error" });
    }
  });

  it("shows every public field with a value, labelled, and links only an http(s) website", () => {
    expect(listingDetailStateOf(ok(FULL))).toEqual({
      kind: "present",
      listing: {
        name: "Juniper Lane Bakery",
        description: "A fictional bakery.",
        fields: [
          { label: "Category", value: "Food & Drink" },
          { label: "Location", value: "Elmstead, North Vale, Exampleland" },
          { label: "Postal code", value: "EX1 4JL" },
          { label: "Phone", value: "+1 555 0101" },
          { label: "Email", value: "hello@juniper-bakery.example" },
          { label: "Website", value: "https://juniper-bakery.example", href: "https://juniper-bakery.example/" },
        ],
      },
    });
  });

  it("omits absent fields entirely rather than rendering them blank (FR-VIS-05)", () => {
    const state = listingDetailStateOf(ok(MINIMAL));

    expect(state.kind === "present" && state.listing.fields.map((field) => field.label)).toEqual([
      "Category",
      "Location",
    ]);
  });

  it("shows a non-web website value as text with no link", () => {
    for (const website of ["javascript:alert(1)", "ftp://files.example", "not a url"]) {
      const state = listingDetailStateOf(ok({ ...MINIMAL, listing: { ...MINIMAL.listing, website } }));
      const field = state.kind === "present" ? state.listing.fields.find((f) => f.label === "Website") : undefined;

      expect(field).toEqual({ label: "Website", value: website });
    }
  });

  it("carries no identifier, status, timestamp or failure detail into any state", () => {
    const states = [
      listingDetailStateOf(ok(FULL)),
      listingDetailStateOf(err(NOT_PUBLICLY_AVAILABLE)),
      listingDetailStateOf(err(UNREADABLE_ROW)),
    ];

    for (const state of states) {
      const serialized = JSON.stringify(state);

      expect(serialized).not.toContain(FULL.id);
      expect(serialized).not.toMatch(/status|submitted|lastUpdated|publication|STORED_|STORAGE_/);
    }
  });
});
