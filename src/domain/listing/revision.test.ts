/**
 * Attacking tests for the revision concept (`E7`) and the pending-revision constraint.
 *
 * Invariants under attack: `DI-11` (an approved listing has no more than one pending
 * revision at a time) and the `FR-ADM-10` conditions under which a proposal exists at
 * all. `DI-11` is asserted here as a **domain** rule only; cross-process and store-level
 * enforcement is a later persistence concern.
 */
import { describe, expect, it } from "vitest";

import { instantOf, type Instant } from "./instant";
import type { Listing, ListingContent } from "./listing";
import { listingIdEquals, listingIdOf } from "./listing-id";
import { projectListingPublicly } from "./public-projection";
import type { DomainError } from "./result";
import {
  REVISION_STATES,
  admitPendingRevision,
  approvePendingRevision,
  isRevisionState,
  pendingRevisionsOf,
  rejectPendingRevision,
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

function instantAt(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }
  return result.value;
}

const t0 = instantAt(1_000);

/**
 * `P1` Slice C (issue #141) — administrative timestamps are part of what a listing is.
 * They are supplied here so these tests keep attacking their own subject; a rejected
 * fixture carries the rejection anchor its status requires.
 */
const pendingTimestamps = { submittedAt: t0, lastUpdatedAt: t0 };
const rejectedTimestamps = { submittedAt: t0, lastUpdatedAt: t0, rejectedAt: t0 };

function timestampsFor(status: Listing["status"]) {
  return status === "rejected" ? rejectedTimestamps : pendingTimestamps;
}

const approved: Listing = {
  id: listingId,
  status: "approved",
  content,
  timestamps: pendingTimestamps,
};

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
        { id: listingId, status, content, timestamps: timestampsFor(status) },
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


/**
 * `P1` Slice D (issue #145) — resolving the listing's sole pending revision.
 *
 * There is no target argument to attack, because object reference is not domain identity:
 * a proposal rehydrated from anywhere is the same proposal. `DI-11` names it instead, so
 * these tests attack the *lookup* as hard as the operations — nothing pending, more than
 * one pending, one belonging to another listing, and every malformed shape that could
 * reach a property read.
 *
 * The fixtures carry a publication state because approval must be proven to leave it
 * exactly as it found it, including leaving an unpublished listing unpublished.
 */
const t1 = instantAt(2_000);
const t2 = instantAt(3_000);

const published: Listing = { ...approved, publication: { value: "publicly_available" } };

const unpublished: Listing = {
  ...approved,
  publication: { value: "unpublished", reason: "Reported as abusive." },
};

const revisedDescription = "A small bakery and cafe.";

/**
 * Rebuilds a collection as structurally equal values that share no object reference with
 * the originals — what persistence, a request body or another process would hand back.
 */
function reconstructed(
  revisions: readonly ListingRevision[],
): readonly ListingRevision[] {
  return revisions.map((revision) => ({
    listingId: listingIdOf("listing-1"),
    state: revision.state,
    proposedContent: { ...revision.proposedContent },
    ...(revision.rejectedAt === undefined ? {} : { rejectedAt: revision.rejectedAt }),
  }));
}

describe("resolving the sole pending revision (DI-11, FR-ADM-10)", () => {
  it("refuses when the listing has no pending revision", () => {
    for (const result of [
      approvePendingRevision(published, [], t1),
      rejectPendingRevision(published, [], t1),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
      }
    }
  });

  it("refuses when only retained history is present", () => {
    const history: readonly ListingRevision[] = [
      proposal({ state: "rejected", rejectedAt: t0 }),
      proposal({ state: "approved" }),
    ];

    const result = approvePendingRevision(published, history, t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
    }
  });

  it("refuses more than one pending revision rather than choosing one", () => {
    const revisions: readonly ListingRevision[] = [
      proposal(),
      proposal({ proposedContent: { ...content, description: "A competing proposal." } }),
    ];

    for (const result of [
      approvePendingRevision(published, revisions, t1),
      rejectPendingRevision(published, revisions, t1),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "MULTIPLE_PENDING_REVISIONS", count: 2 });
      }
    }

    expect(revisions).toHaveLength(2);
  });

  it("reports a pending revision belonging to another listing as a mismatch", () => {
    const foreign = proposal({ listingId: listingIdOf("listing-2") });
    const result = approvePendingRevision(published, [foreign], t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REVISION_LISTING_MISMATCH" });
    }
  });

  it("counts only this listing's pending revisions when another listing also has one", () => {
    const foreign = proposal({ listingId: listingIdOf("listing-2") });
    const mine = proposal();
    const result = approvePendingRevision(published, [foreign, mine], t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.listing.content.description).toBe(revisedDescription);
    expect(result.value.revisions).toEqual([foreign]);
  });

  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "refuses resolution against a %s listing",
    (status) => {
      const result = approvePendingRevision(
        { id: listingId, status, content, timestamps: timestampsFor(status) },
        [proposal()],
        t1,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_APPROVED", status });
      }
    },
  );

  it("resolves a reconstructed collection exactly as it resolves the original", () => {
    const original: readonly ListingRevision[] = [
      proposal({ state: "rejected", rejectedAt: t0 }),
      proposal(),
    ];
    const rebuilt = reconstructed(original);

    // No entry of the rebuilt collection is the same object as its original.
    rebuilt.forEach((revision, position) => {
      expect(revision).not.toBe(original[position]);
    });

    const fromOriginal = approvePendingRevision(published, original, t1);
    const fromRebuilt = approvePendingRevision(published, rebuilt, t1);

    expect(fromOriginal.ok).toBe(true);
    expect(fromRebuilt.ok).toBe(true);
    if (!fromOriginal.ok || !fromRebuilt.ok) return;

    expect(fromRebuilt.value).toEqual(fromOriginal.value);
  });

  it("rejects a reconstructed collection exactly as it rejects the original", () => {
    const original: readonly ListingRevision[] = [proposal()];
    const fromOriginal = rejectPendingRevision(published, original, t1);
    const fromRebuilt = rejectPendingRevision(published, reconstructed(original), t1);

    expect(fromOriginal.ok).toBe(true);
    expect(fromRebuilt.ok).toBe(true);
    if (!fromOriginal.ok || !fromRebuilt.ok) return;

    expect(fromRebuilt.value).toEqual(fromOriginal.value);
  });
});

describe("malformed resolution input is governed, never thrown", () => {
  it.each([null, undefined, "not-a-collection", 7, { length: 1 }])(
    "refuses %o as a revision collection",
    (revisions) => {
      for (const result of [
        approvePendingRevision(published, revisions as never, t1),
        rejectPendingRevision(published, revisions as never, t1),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            code: "INVALID_REVISION_COLLECTION",
            offered: revisions,
          });
        }
      }
    },
  );

  it.each([null, undefined, [], "revision", 7, true])(
    "refuses %o as a collection entry",
    (entry) => {
      const result = approvePendingRevision(published, [entry as never], t1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "INVALID_REVISION", offered: entry });
      }
    },
  );

  it.each([
    ["listingId", { listingId: null as never }],
    ["listingId", { listingId: "listing-1" as never }],
    ["state", { state: "proposed" as never }],
    ["state", { state: undefined as never }],
    ["proposedContent", { proposedContent: null as never }],
    ["proposedContent", { proposedContent: "content" as never }],
    ["proposedContent", { proposedContent: { ...content, name: 7 as never } }],
    ["proposedContent", { proposedContent: { ...content, phone: "07000" as never } }],
    [
      "proposedContent",
      { proposedContent: { ...content, phone: { value: 7 as never } } },
    ],
    ["rejectedAt", { rejectedAt: 1_000 as never }],
    ["rejectedAt", { rejectedAt: {} as never }],
  ])("refuses a revision with a malformed %s", (_field, overrides) => {
    const entry = proposal(overrides);

    for (const result of [
      approvePendingRevision(published, [entry], t1),
      rejectPendingRevision(published, [entry], t1),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_REVISION");
      }
    }
  });

  it("refuses a malformed entry even when a valid pending revision is also present", () => {
    const revisions: readonly ListingRevision[] = [null as never, proposal()];
    const result = approvePendingRevision(published, revisions, t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "INVALID_REVISION", offered: null });
    }

    // Nothing was applied, and nothing was written.
    expect(published.content.description).toBe("A small bakery.");
    expect(revisions).toHaveLength(2);
  });

  it("mutates nothing and throws nothing for any malformed input", () => {
    const listingBefore = structuredClone(published);
    const malformed: readonly unknown[] = [
      null,
      undefined,
      "collection",
      [null],
      [proposal({ state: "proposed" as never })],
      [proposal({ listingId: null as never })],
    ];

    for (const revisions of malformed) {
      expect(() =>
        approvePendingRevision(published, revisions as never, t1),
      ).not.toThrow();
      expect(() =>
        rejectPendingRevision(published, revisions as never, t1),
      ).not.toThrow();
    }

    expect(published).toEqual(listingBefore);
  });
});

describe("approving the pending revision (FR-ADM-10, ADR-017 Q-3)", () => {
  it("applies the proposal's content and removes that proposal in one result", () => {
    const target = proposal();
    const result = approvePendingRevision(published, [target], t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.listing.content.description).toBe(revisedDescription);
    expect(result.value.revisions).toHaveLength(0);
    // One successful value carries both halves: no shape exists in which the content was
    // applied and the proposal was not, or the reverse (DI-3 at the domain level).
    expect(Object.keys(result.value).sort()).toEqual(["listing", "revisions"]);
  });

  it("preserves identity, approved status, submittedAt and publication state", () => {
    const result = approvePendingRevision(published, [proposal()], t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const listing = result.value.listing;
    expect(listingIdEquals(listing.id, published.id)).toBe(true);
    expect(listing.status).toBe("approved");
    expect(listing.timestamps.submittedAt).toEqual(published.timestamps.submittedAt);
    expect(listing.timestamps.rejectedAt).toBeUndefined();
    expect(listing.publication).toEqual(published.publication);
  });

  it("advances only lastUpdatedAt, to the supplied instant (DI-6)", () => {
    const result = approvePendingRevision(published, [proposal()], t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.listing.timestamps.lastUpdatedAt).toEqual(t1);
    expect(result.value.listing.timestamps.submittedAt).toEqual(t0);
  });

  it("leaves an unpublished listing unpublished, and publicly unavailable", () => {
    const result = approvePendingRevision(unpublished, [proposal()], t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.listing.publication).toEqual(unpublished.publication);
    expect(result.value.listing.content.description).toBe(revisedDescription);

    const projected = projectListingPublicly(result.value.listing);
    expect(projected.ok).toBe(false);
    if (!projected.ok) {
      expect(projected.error).toEqual({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
    }
  });

  it("refuses content that fails a before-approval obligation, mutating neither input", () => {
    const { phone: _phone, ...withoutContact } = content;
    const target = proposal({ proposedContent: withoutContact });
    const revisions: readonly ListingRevision[] = [target];

    const result = approvePendingRevision(published, revisions, t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVISION_CONTENT_INVALID");
      if (result.error.code === "REVISION_CONTENT_INVALID") {
        expect(result.error.violations).toContainEqual({
          code: "CONTACT_METHOD_MINIMUM_UNMET",
          fields: ["phone", "email", "website"],
        });
      }
    }

    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toBe(target);
    expect(published.content.description).toBe("A small bakery.");
  });

  it("refuses content missing a field required at initial submission", () => {
    const result = approvePendingRevision(
      published,
      [proposal({ proposedContent: { ...content, name: "   " } })],
      t1,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "REVISION_CONTENT_INVALID") {
      expect(result.error.violations).toContainEqual({
        code: "REQUIRED_VALUE_MISSING",
        field: "name",
      });
    }
  });

  it.each([
    ["equal", t0],
    ["earlier", instantAt(500)],
  ])("refuses an instant that is %s than lastUpdatedAt", (_label, at) => {
    const result = approvePendingRevision(published, [proposal()], at);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "INSTANT_NOT_STRICTLY_LATER" });
    }
  });

  it.each([null, undefined, Number.NaN, 1.5, "1000", {}])(
    "refuses %o as an instant without throwing",
    (offered) => {
      const result = approvePendingRevision(published, [proposal()], offered as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "INVALID_INSTANT", offered });
      }
    },
  );

  it("removes only the approved proposal, leaving retained history in place and in order", () => {
    const rejectedHistory = proposal({ state: "rejected", rejectedAt: t0 });
    const approvedHistory = proposal({ state: "approved" });
    const target = proposal();
    const revisions: readonly ListingRevision[] = [
      rejectedHistory,
      approvedHistory,
      target,
    ];

    const result = approvePendingRevision(published, revisions, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.revisions).toEqual([rejectedHistory, approvedHistory]);
    expect(result.value.revisions).not.toContain(target);
    // The retained records keep their positions, their values and their anchors.
    expect(result.value.revisions[0]).toBe(rejectedHistory);
    expect(result.value.revisions[1]).toBe(approvedHistory);
    expect(result.value.revisions[0]?.rejectedAt).toEqual(t0);
  });

  it("removes the pending proposal from the middle without disturbing its neighbours", () => {
    const first = proposal({ state: "approved" });
    const last = proposal({ state: "rejected", rejectedAt: t0 });
    const revisions: readonly ListingRevision[] = [first, proposal(), last];

    const result = approvePendingRevision(published, revisions, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.revisions).toEqual([first, last]);
  });

  it("frees the admission slot, and two pending revisions remain refused (DI-11)", () => {
    const resolved = approvePendingRevision(published, [proposal()], t1);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const readmitted = admitPendingRevision(
      resolved.value.listing,
      resolved.value.revisions,
      proposal({ proposedContent: { ...content, description: "A later proposal." } }),
    );
    expect(readmitted.ok).toBe(true);
    if (!readmitted.ok) return;

    const second = admitPendingRevision(
      resolved.value.listing,
      readmitted.value,
      proposal({ proposedContent: { ...content, description: "A competing proposal." } }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
    }
  });

  it("refuses a second approval, because nothing is pending any more", () => {
    const first = approvePendingRevision(published, [proposal()], t1);

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = approvePendingRevision(
      first.value.listing,
      first.value.revisions,
      t2,
    );

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
    }
  });

  it("does not mutate the listing or the collection it was given", () => {
    const target = proposal();
    const revisions: readonly ListingRevision[] = [target];
    const listingBefore = structuredClone(published);
    const targetBefore = structuredClone(target);

    const result = approvePendingRevision(published, revisions, t1);

    expect(result.ok).toBe(true);
    expect(published).toEqual(listingBefore);
    expect(revisions).toHaveLength(1);
    expect(target).toEqual(targetBefore);
  });
});

describe("rejecting the pending revision (FR-ADM-10, ADR-017 Q-1/Q-2)", () => {
  it("records the write-once rejection anchor and the rejected state", () => {
    const target = proposal();
    const result = rejectPendingRevision(published, [target], t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.state).toBe("rejected");
    expect(result.value[0]?.rejectedAt).toEqual(t1);
    expect(result.value[0]?.proposedContent).toEqual(target.proposedContent);
  });

  it("leaves the listing deeply unchanged, timestamps included", () => {
    const listingBefore = structuredClone(published);

    const result = rejectPendingRevision(published, [proposal()], t1);

    expect(result.ok).toBe(true);
    expect(published).toEqual(listingBefore);
    expect(published.timestamps.lastUpdatedAt).toEqual(t0);
    expect(published.content.description).toBe("A small bakery.");
  });

  it("replaces exactly the pending proposal, leaving every other entry in place", () => {
    const rejectedHistory = proposal({ state: "rejected", rejectedAt: t0 });
    const approvedHistory = proposal({ state: "approved" });
    const revisions: readonly ListingRevision[] = [
      rejectedHistory,
      proposal(),
      approvedHistory,
    ];

    const result = rejectPendingRevision(published, revisions, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    expect(result.value[0]).toBe(rejectedHistory);
    expect(result.value[2]).toBe(approvedHistory);
    expect(result.value[1]?.state).toBe("rejected");
    expect(result.value[1]?.rejectedAt).toEqual(t1);
    expect(pendingRevisionsOf(published, result.value)).toHaveLength(0);
  });

  it("frees the admission slot without changing the listing (DI-11)", () => {
    const rejected = rejectPendingRevision(published, [proposal()], t1);

    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;

    const readmitted = admitPendingRevision(published, rejected.value, proposal());
    expect(readmitted.ok).toBe(true);
    if (!readmitted.ok) return;

    const second = admitPendingRevision(
      published,
      readmitted.value,
      proposal({ proposedContent: { ...content, description: "A competing proposal." } }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toEqual({ code: "PENDING_REVISION_ALREADY_EXISTS" });
    }
  });

  it("refuses a second rejection, because nothing is pending any more", () => {
    const first = rejectPendingRevision(published, [proposal()], t1);

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = rejectPendingRevision(published, first.value, t2);

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
    }
    // The anchor written by the first rejection is untouched.
    expect(first.value[0]?.rejectedAt).toEqual(t1);
  });

  it("refuses to approve a rejected proposal, because nothing is pending any more", () => {
    const rejected = rejectPendingRevision(published, [proposal()], t1);

    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;

    const result = approvePendingRevision(published, rejected.value, t2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "PENDING_REVISION_NOT_FOUND" });
    }
    expect(rejected.value[0]?.rejectedAt).toEqual(t1);
  });

  it("refuses a pending proposal that already carries an anchor", () => {
    const result = rejectPendingRevision(published, [proposal({ rejectedAt: t0 })], t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
    }
  });

  it.each([null, undefined, Number.NaN, 1.5, "1000", {}])(
    "refuses %o as a rejection instant without throwing",
    (offered) => {
      const result = rejectPendingRevision(published, [proposal()], offered as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "INVALID_INSTANT", offered });
      }
    },
  );

  it("does not mutate the collection or the proposal it was given", () => {
    const target = proposal();
    const revisions: readonly ListingRevision[] = [target];
    const targetBefore = structuredClone(target);

    const result = rejectPendingRevision(published, revisions, t1);

    expect(result.ok).toBe(true);
    expect(revisions[0]).toBe(target);
    expect(target).toEqual(targetBefore);
    expect(target.state).toBe("pending");
    expect(target.rejectedAt).toBeUndefined();
  });
});

describe("revision content never reaches a public outcome (DI-10)", () => {
  it("is absent from a successful projection while a revision is pending", () => {
    const projected = projectListingPublicly(published, [proposal()]);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    expect(projected.value.description).toBe("A small bakery.");
    expect(JSON.stringify(projected.value)).not.toContain(revisedDescription);
  });

  it("is absent from a successful projection after a rejection", () => {
    const rejected = rejectPendingRevision(published, [proposal()], t1);

    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;

    const projected = projectListingPublicly(published, rejected.value);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    expect(JSON.stringify(projected.value)).not.toContain(revisedDescription);
    expect(JSON.stringify(projected.value)).not.toContain("rejectedAt");
  });

  it("is absent from the unavailable outcome, which carries nothing at all", () => {
    const projected = projectListingPublicly(unpublished, [proposal()]);

    expect(projected.ok).toBe(false);
    if (projected.ok) return;

    expect(projected.error).toEqual({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
    expect(JSON.stringify(projected.error)).not.toContain(revisedDescription);
  });

  it("carries no resolution detail into a public outcome, whatever the revisions are", () => {
    for (const revisions of [
      [],
      [proposal(), proposal()],
      [null as never],
      [proposal({ state: "rejected", rejectedAt: t0 })],
    ]) {
      const projected = projectListingPublicly(unpublished, revisions);

      expect(projected.ok).toBe(false);
      if (!projected.ok) {
        expect(projected.error).toEqual({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
      }
    }
  });
});

describe("a pending revision carrying a rejection anchor is refused (ADR-017 Q-1/Q-2)", () => {
  const anchored = () => proposal({ rejectedAt: t0 });

  it.each([
    ["approval", approvePendingRevision],
    ["rejection", rejectPendingRevision],
  ] as const)("refuses %s with the write-once error", (_label, operate) => {
    const target = anchored();
    const revisions: readonly ListingRevision[] = [target];
    const listingBefore = structuredClone(published);
    const targetBefore = structuredClone(target);

    const result = operate(published, revisions, t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
    }

    // Neither input is touched, and the anchor is exactly where it was.
    expect(published).toEqual(listingBefore);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toBe(target);
    expect(target).toEqual(targetBefore);
    expect(target.rejectedAt).toEqual(t0);
    expect(target.state).toBe("pending");
  });

  it("approval cannot make the invalid anchor disappear by removing the proposal", () => {
    const target = anchored();
    const revisions: readonly ListingRevision[] = [target];

    const result = approvePendingRevision(published, revisions, t1);

    expect(result.ok).toBe(false);
    // The proposal — and its anchor — survive the refusal in place.
    expect(revisions).toEqual([target]);
    expect(revisions[0]?.rejectedAt).toEqual(t0);
    expect(published.content.description).toBe("A small bakery.");
  });

  it("rejection cannot replace the existing anchor", () => {
    const target = anchored();
    const result = rejectPendingRevision(published, [target], t2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
    }
    expect(target.rejectedAt).toEqual(t0);
    expect(target.rejectedAt).not.toEqual(t2);
  });

  it("refuses before validation, so invalid content does not change the outcome", () => {
    const { phone: _phone, ...withoutContact } = content;
    const target = proposal({ rejectedAt: t0, proposedContent: withoutContact });

    const result = approvePendingRevision(published, [target], t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
    }
  });

  it("still admits and resolves a proposal that carries no anchor", () => {
    const resolved = approvePendingRevision(published, [proposal()], t1);
    expect(resolved.ok).toBe(true);

    const rejected = rejectPendingRevision(published, [proposal()], t1);
    expect(rejected.ok).toBe(true);
  });
});

describe("a malformed listing is refused by both Slice D entry points", () => {
  const malformedListings: readonly (readonly [string, unknown, DomainError])[] = [
    ["null", null, { code: "INVALID_LISTING", offered: null }],
    ["an array", [], { code: "INVALID_LISTING", offered: [] }],
    ["a primitive", "listing-1", { code: "INVALID_LISTING", offered: "listing-1" }],
    [
      "an object missing status",
      { ...published, status: undefined },
      { code: "UNKNOWN_LISTING_STATUS", offered: undefined },
    ],
    [
      "an object with an unknown status",
      { ...published, status: "archived" },
      { code: "UNKNOWN_LISTING_STATUS", offered: "archived" },
    ],
    [
      "an object with malformed identity",
      { ...published, id: null },
      { code: "INVALID_LISTING", offered: null },
    ],
    [
      "an object with malformed content",
      { ...published, content: { ...content, name: 7 } },
      { code: "INVALID_LISTING", offered: { ...content, name: 7 } },
    ],
    [
      "an object with an unusable timestamp bundle",
      { ...published, timestamps: null },
      { code: "INVALID_LISTING_TIMESTAMPS", offered: null },
    ],
    [
      "an object with no timestamps at all",
      { ...published, timestamps: undefined },
      { code: "LISTING_TIMESTAMPS_MISSING" },
    ],
    [
      "an approved object with a malformed publication state",
      { ...published, publication: { value: "archived" } },
      { code: "UNKNOWN_PUBLICATION_VALUE", offered: "archived" },
    ],
    [
      "an approved object with no publication state",
      { ...approved },
      { code: "PUBLICATION_STATE_MISSING" },
    ],
  ];

  it.each(malformedListings)(
    "refuses %s without throwing, leaving the collection unchanged",
    (_label, listing, expected) => {
      for (const operate of [approvePendingRevision, rejectPendingRevision]) {
        const target = proposal();
        const revisions: readonly ListingRevision[] = [target];

        let result: ReturnType<typeof operate> | undefined;
        expect(() => {
          result = operate(listing as Listing, revisions, t1);
        }).not.toThrow();

        expect(result?.ok).toBe(false);
        if (result !== undefined && !result.ok) {
          expect(result.error).toEqual(expected);
        }

        expect(revisions).toEqual([target]);
        expect(revisions[0]).toBe(target);
        expect(target.state).toBe("pending");
        expect(target.rejectedAt).toBeUndefined();
      }
    },
  );

  it("reads no clock while refusing any malformed listing", () => {
    const realNow = Date.now;
    const realDate = globalThis.Date;
    let consulted = false;

    Date.now = () => {
      consulted = true;
      return realNow.call(Date);
    };
    globalThis.Date = new Proxy(realDate, {
      construct(inner, args: readonly unknown[]) {
        if (args.length === 0) consulted = true;
        return Reflect.construct(inner, args as unknown[]);
      },
    }) as DateConstructor;

    try {
      for (const [, listing] of malformedListings) {
        approvePendingRevision(listing as Listing, [proposal()], t1);
        rejectPendingRevision(listing as Listing, [proposal()], t1);
      }
    } finally {
      Date.now = realNow;
      globalThis.Date = realDate;
    }

    expect(consulted).toBe(false);
  });

  it("keeps a malformed listing distinct from a well-formed non-approved one", () => {
    const wellFormedPending: Listing = {
      id: listingId,
      status: "pending",
      content,
      timestamps: pendingTimestamps,
    };

    const result = approvePendingRevision(wellFormedPending, [proposal()], t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "LISTING_NOT_APPROVED", status: "pending" });
    }
  });

  it("keeps a blank required value a content-policy violation, not a shape defect", () => {
    const result = approvePendingRevision(
      published,
      [proposal({ proposedContent: { ...content, name: "   " } })],
      t1,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVISION_CONTENT_INVALID");
    }
  });
});

describe("the resolution operations read no ambient clock", () => {
  it("cannot produce a timestamp without a supplied instant", () => {
    const realNow = Date.now;
    const realDate = globalThis.Date;
    let consulted = false;

    Date.now = () => {
      consulted = true;
      return realNow.call(Date);
    };
    globalThis.Date = new Proxy(realDate, {
      construct(inner, args: readonly unknown[]) {
        if (args.length === 0) consulted = true;
        return Reflect.construct(inner, args as unknown[]);
      },
    }) as DateConstructor;

    try {
      const approvedResult = approvePendingRevision(published, [proposal()], t1);
      const rejectedResult = rejectPendingRevision(published, [proposal()], t1);

      expect(approvedResult.ok).toBe(true);
      expect(rejectedResult.ok).toBe(true);
    } finally {
      Date.now = realNow;
      globalThis.Date = realDate;
    }

    expect(consulted).toBe(false);
  });
});
