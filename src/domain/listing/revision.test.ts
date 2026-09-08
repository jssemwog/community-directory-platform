/**
 * Attacking tests for the revision concept (`E7`) and the pending-revision constraint.
 *
 * Invariants under attack: `DI-11` (an approved listing has no more than one pending
 * revision at a time) and the `FR-ADM-10` conditions under which a proposal exists at
 * all. `DI-11` is asserted here as a **domain** rule only; cross-process and store-level
 * enforcement is a later persistence concern.
 */
import { describe, expect, it } from "vitest";

import type { Listing, ListingContent } from "./listing";
import { listingIdEquals, listingIdOf } from "./listing-id";
import {
  REVISION_STATES,
  admitPendingRevision,
  isRevisionState,
  pendingRevisionsOf,
  type ListingRevision,
} from "./revision";
import { LISTING_STATUSES } from "./status";

const content: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  phone: { value: "+353 21 000 0000", designatedPublic: true },
};

const listingId = listingIdOf("listing-1");
const approved: Listing = { id: listingId, status: "approved", content };

function proposal(overrides: Partial<ListingRevision> = {}): ListingRevision {
  return {
    listingId,
    state: "pending",
    proposedContent: { ...content, description: "A small bakery and cafe." },
    ...overrides,
  };
}

describe("revision states", () => {
  it("has exactly the three governed values", () => {
    expect([...REVISION_STATES]).toEqual(["pending", "approved", "rejected"]);
  });

  it.each(["proposed", "draft", "", null, undefined, 0, {}])(
    "rejects %o as a revision state",
    (candidate) => {
      expect(isRevisionState(candidate)).toBe(false);
    },
  );
});

describe("admitting a pending revision (FR-ADM-10)", () => {
  it("admits the first pending revision on an approved listing", () => {
    const result = admitPendingRevision(approved, [], proposal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(pendingRevisionsOf(approved, result.value)).toHaveLength(1);
  });

  it("rejects a proposal that names a different listing", () => {
    const result = admitPendingRevision(
      approved,
      [],
      proposal({ listingId: listingIdOf("listing-2") }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVISION_LISTING_MISMATCH");
    }
  });

  it("preserves the listing identity of an admitted proposal (DI-8)", () => {
    const result = admitPendingRevision(approved, [], proposal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const revision of result.value) {
      expect(listingIdEquals(revision.listingId, approved.id)).toBe(true);
    }
  });

  it.each(["approved", "rejected"] as const)(
    "refuses to admit a proposal already in the %s revision state",
    (state) => {
      const result = admitPendingRevision(approved, [], proposal({ state }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "REVISION_NOT_PENDING", state });
      }
    },
  );

  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "refuses a revision against a %s listing",
    (status) => {
      const result = admitPendingRevision(
        { id: listingId, status, content },
        [],
        proposal(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_APPROVED", status });
      }
    },
  );
});

describe("the pending-revision constraint (DI-11)", () => {
  it("rejects a second pending revision on a listing that already has one", () => {
    const first = admitPendingRevision(approved, [], proposal());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = admitPendingRevision(
      approved,
      first.value,
      proposal({ proposedContent: { ...content, description: "A competing proposal." } }),
    );

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
    }

    // The rejected attempt changes nothing: still exactly one pending revision.
    expect(pendingRevisionsOf(approved, first.value)).toHaveLength(1);
  });

  it("constrains the pending state, not revision history", () => {
    const history: readonly ListingRevision[] = [
      proposal({ state: "approved" }),
      proposal({ state: "rejected" }),
      proposal({ state: "approved" }),
    ];

    const result = admitPendingRevision(approved, history, proposal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // History is retained in full alongside the new pending proposal.
    expect(result.value).toHaveLength(history.length + 1);
    expect(pendingRevisionsOf(approved, result.value)).toHaveLength(1);
  });

  it("counts only the pending revisions of the listing in question", () => {
    const otherListingsPending = proposal({ listingId: listingIdOf("listing-2") });

    expect(pendingRevisionsOf(approved, [otherListingsPending])).toHaveLength(0);

    const result = admitPendingRevision(approved, [otherListingsPending], proposal());
    expect(result.ok).toBe(true);
  });

  it("does not mutate the revision collection it was given", () => {
    const existing: readonly ListingRevision[] = [];
    const result = admitPendingRevision(approved, existing, proposal());

    expect(result.ok).toBe(true);
    expect(existing).toHaveLength(0);
  });
});
