/**
 * Attacking tests for the status set and the permitted lifecycle transitions.
 *
 * Invariants under attack: `DI-1` (exactly one status, drawn from the `FR-AUD-01` set)
 * and `DI-2` (status changes only along a permitted `NFR-DATA-02` transition).
 */
import { describe, expect, it } from "vitest";

import type { Listing, ListingContent } from "./listing";
import { instantOf, type Instant } from "./instant";
import { listingIdOf } from "./listing-id";
import {
  LISTING_STATUSES,
  PERMITTED_STATUS_TRANSITIONS,
  isListingStatus,
  isPermittedStatusTransition,
  transitionListingStatus,
  type ListingStatus,
} from "./status";

const content: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
};

/**
 * An approved listing carries a valid publication state, because `P1` Slice B (issue
 * #139) makes that part of what an approved listing *is* (`docs/08` *Status model ->
 * Publication state*). The fixture supplies it so these tests keep attacking transition
 * legality — their subject — rather than tripping over a listing that is invalid for an
 * unrelated reason. Publication state's own rules are attacked in `publication.test.ts`.
 */
function instantAt(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }
  return result.value;
}

const t0 = instantAt(1_000);
const t1 = instantAt(2_000);

/**
 * `P1` Slice C (issue #141) adds the administrative timestamps, and a *rejected* fixture
 * carries the rejection anchor its status requires. Every transition below supplies `t1`,
 * strictly later than the fixture's `lastUpdatedAt`, so these tests keep attacking
 * transition legality rather than tripping over the chronological rule — which is
 * attacked on its own terms in `timestamps.test.ts`.
 */
function listingAt(status: ListingStatus): Listing {
  const timestamps =
    status === "rejected"
      ? { submittedAt: t0, lastUpdatedAt: t0, rejectedAt: t0 }
      : { submittedAt: t0, lastUpdatedAt: t0 };
  const base = { id: listingIdOf("listing-1"), status, content, timestamps };
  return status === "approved"
    ? { ...base, publication: { value: "publicly_available" as const } }
    : base;
}

/** The `NFR-DATA-02` enumeration, written out again here so the test asserts the rule
 *  rather than re-reading the implementation's own table. */
const EXPECTED_PERMITTED = new Set([
  "pending>approved",
  "pending>rejected",
  "pending>pending",
  "approved>approved",
]);

describe("listing status set (FR-AUD-01, DI-1)", () => {
  it("has exactly the three governed values and no fourth", () => {
    expect([...LISTING_STATUSES]).toEqual(["pending", "approved", "rejected"]);
  });

  it.each([
    "unpublished",
    "retained",
    "purged",
    "draft",
    "PENDING",
    "",
    " pending ",
    null,
    undefined,
    0,
    1,
    {},
    ["pending"],
  ])("rejects %o as a status", (candidate) => {
    expect(isListingStatus(candidate)).toBe(false);
  });
});

describe("permitted transitions (NFR-DATA-02, DI-2)", () => {
  it("permits exactly the enumerated ordered pairs over the full status matrix", () => {
    const observed = new Set<string>();

    for (const from of LISTING_STATUSES) {
      for (const to of LISTING_STATUSES) {
        if (isPermittedStatusTransition(from, to)) {
          observed.add(`${from}>${to}`);
        }
      }
    }

    expect(observed).toEqual(EXPECTED_PERMITTED);
  });

  it("exposes a table that matches the rule it claims to encode", () => {
    const declared = new Set(
      PERMITTED_STATUS_TRANSITIONS.map(([from, to]) => `${from}>${to}`),
    );
    expect(declared).toEqual(EXPECTED_PERMITTED);
  });

  it("achieves every permitted transition, and no forbidden one, across the full matrix", () => {
    for (const from of LISTING_STATUSES) {
      for (const to of LISTING_STATUSES) {
        const before = listingAt(from);
        const result = transitionListingStatus(before, to, t1);
        const permitted = EXPECTED_PERMITTED.has(`${from}>${to}`);

        expect(result.ok).toBe(permitted);

        if (result.ok) {
          expect(result.value.status).toBe(to);
        } else {
          expect(result.error).toEqual({
            code: "FORBIDDEN_STATUS_TRANSITION",
            from,
            to,
          });
        }

        // The attempt never mutates the record it was given, permitted or not.
        expect(before.status).toBe(from);
      }
    }
  });

  it("leaves rejected terminal — no transition out of it exists", () => {
    for (const to of LISTING_STATUSES) {
      expect(transitionListingStatus(listingAt("rejected"), to, t1).ok).toBe(false);
    }
  });

  it("never lets an unrecognised status bypass the transition function", () => {
    for (const offered of ["unpublished", "APPROVED", "", null, undefined, 1, {}]) {
      const result = transitionListingStatus(
        listingAt("pending"),
        offered as unknown as ListingStatus,
        t1,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("UNKNOWN_LISTING_STATUS");
      }
    }
  });

  it("reports failure as a value rather than throwing", () => {
    expect(() => transitionListingStatus(listingAt("approved"), "pending", t1)).not.toThrow();
  });

  it("carries content through a permitted transition unchanged", () => {
    const result = transitionListingStatus(listingAt("pending"), "approved", t1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toEqual(content);
    }
  });
});
