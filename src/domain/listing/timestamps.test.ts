/**
 * Attacking tests for the administrative timestamps (`P1` Slice C, issue #141).
 *
 * Each test attempts the violation and fails to achieve it — "the test passes" is not the
 * standard (`docs/12` *Definition of done*, condition 3). Criterion numbers refer to
 * issue #141's fifteen acceptance criteria.
 *
 * Under attack: `DI-6` (`submittedAt` write-once; `lastUpdatedAt` on every content **or
 * status** change; a write-once rejection timestamp), `NFR-DATA-05`, the strict
 * chronological order the Product Owner ruled for this slice, the rejection anchor's
 * applicability (`ADR-017` Q-1/Q-2), and `NFR-PRIV-01`/`BI-6` — no timestamp is ever
 * public.
 */
import { describe, expect, it } from "vitest";

import { instantEquals, instantOf, type Instant } from "./instant";
import {
  submitListing,
  withListingContent,
  type Listing,
  type ListingContent,
} from "./listing";
import { listingIdOf } from "./listing-id";
import { projectListingPublicly } from "./public-projection";
import {
  republishListing,
  unpublishListing,
  type PublicationState,
} from "./publication";
import { transitionListingStatus } from "./status";
import * as listingModule from "./listing";
import * as timestampsModule from "./timestamps";
import {
  resolveListingTimestamps,
  timestampsOnSubmission,
  type ListingTimestamps,
} from "./timestamps";

function at(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }
  return result.value;
}

const t0 = at(1_000);
const t1 = at(2_000);
const t2 = at(3_000);

const content: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  phone: { value: "+353 21 000 0000", designatedPublic: true },
};

const revisedContent: ListingContent = {
  ...content,
  description: "A small bakery, now with a coffee counter.",
};

const listingId = listingIdOf("listing-1");

/** A pending listing as the initial-submission operation actually produces one. */
function submitted(): Listing {
  const result = submitListing(listingId, content, t0);
  if (!result.ok) {
    throw new Error("fixture submission failed");
  }
  return result.value;
}

/** A listing assembled directly, so that malformed records can be attacked. */
function listingWith(
  status: Listing["status"],
  timestamps: ListingTimestamps,
  publication?: PublicationState,
): Listing {
  return publication === undefined
    ? { id: listingId, status, content, timestamps }
    : { id: listingId, status, content, publication, timestamps };
}

function approvedAt(lastUpdatedAt: Instant): Listing {
  return listingWith(
    "approved",
    { submittedAt: t0, lastUpdatedAt },
    { value: "publicly_available" },
  );
}

/** Criterion 1 — what an initial submission produces. */
describe("criterion 1 — initial submission", () => {
  it("sets submittedAt and lastUpdatedAt to the same supplied instant", () => {
    const result = submitListing(listingId, content, t0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(instantEquals(result.value.timestamps.submittedAt, t0)).toBe(true);
    expect(instantEquals(result.value.timestamps.lastUpdatedAt, t0)).toBe(true);
    expect(
      instantEquals(
        result.value.timestamps.submittedAt,
        result.value.timestamps.lastUpdatedAt,
      ),
    ).toBe(true);
  });

  it("produces no rejectedAt and no publication state", () => {
    const listing = submitted();

    expect(listing.timestamps.rejectedAt).toBeUndefined();
    expect(listing.publication).toBeUndefined();
    expect(listing.status).toBe("pending");
  });

  it("refuses a malformed instant rather than inventing one", () => {
    for (const offered of [Number.NaN, "now", null, undefined, {}, 1.5]) {
      const result = submitListing(listingId, content, offered as unknown as Instant);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INSTANT");
      }
    }
  });

  it("states the same thing through timestampsOnSubmission", () => {
    const timestamps = timestampsOnSubmission(t0);

    expect(timestamps.submittedAt).toBe(t0);
    expect(timestamps.lastUpdatedAt).toBe(t0);
    expect(timestamps.rejectedAt).toBeUndefined();
  });
});

/** Criterion 2 — submittedAt never moves. */
describe("criterion 2 — submittedAt is write-once", () => {
  it("survives a content replacement", () => {
    const edited = withListingContent(submitted(), revisedContent, t1);

    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(instantEquals(edited.value.timestamps.submittedAt, t0)).toBe(true);
    }
  });

  it("survives every permitted status transition", () => {
    const approved = transitionListingStatus(submitted(), "approved", t1);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(instantEquals(approved.value.timestamps.submittedAt, t0)).toBe(true);

    const again = transitionListingStatus(approved.value, "approved", t2);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(instantEquals(again.value.timestamps.submittedAt, t0)).toBe(true);

    const edited = transitionListingStatus(submitted(), "pending", t1);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(instantEquals(edited.value.timestamps.submittedAt, t0)).toBe(true);

    const rejected = transitionListingStatus(submitted(), "rejected", t1);
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(instantEquals(rejected.value.timestamps.submittedAt, t0)).toBe(true);
  });

  it("survives unpublishing and republishing", () => {
    const withdrawn = unpublishListing(approvedAt(t1), "Reported as misleading.");
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    expect(instantEquals(withdrawn.value.timestamps.submittedAt, t0)).toBe(true);

    const restored = republishListing(withdrawn.value);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(instantEquals(restored.value.timestamps.submittedAt, t0)).toBe(true);
    }
  });

  it("is never rewritten by a governed operation, which leaves its input alone", () => {
    // What `DI-6` actually guarantees: no governed operation writes `submittedAt` after
    // creation, and none mutates the record it was given. Object freezing is not the
    // mechanism and is not asserted here — a rehydrated bundle may not be frozen.
    const before = submitted();
    const originalTimestamps = before.timestamps;

    const edited = withListingContent(before, revisedContent, t1);
    const approved = transitionListingStatus(before, "approved", t1);
    const rejected = transitionListingStatus(before, "rejected", t1);

    for (const result of [edited, approved, rejected]) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(instantEquals(result.value.timestamps.submittedAt, t0)).toBe(true);
      }
    }

    // The input is the same object it was, field for field, and was not reassigned.
    expect(before.timestamps).toBe(originalTimestamps);
    expect(before.timestamps).toEqual({ submittedAt: t0, lastUpdatedAt: t0 });
    expect(instantEquals(before.timestamps.submittedAt, t0)).toBe(true);
    expect(instantEquals(before.timestamps.lastUpdatedAt, t0)).toBe(true);
    expect(before.content).toEqual(content);
    expect(before.status).toBe("pending");
  });
});

/** Criterion 3 — content replacement. */
describe("criterion 3 — content replacement advances lastUpdatedAt", () => {
  it("requires and records a strictly later instant", () => {
    const edited = withListingContent(submitted(), revisedContent, t1);

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(instantEquals(edited.value.timestamps.lastUpdatedAt, t1)).toBe(true);
    expect(edited.value.content).toEqual(revisedContent);
  });

  it("preserves status, publication state and rejectedAt applicability", () => {
    const unpublishedListing = listingWith(
      "approved",
      { submittedAt: t0, lastUpdatedAt: t1 },
      { value: "unpublished", reason: "Reported as misleading." },
    );

    const edited = withListingContent(unpublishedListing, revisedContent, t2);

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(edited.value.status).toBe("approved");
    expect(edited.value.publication).toEqual(unpublishedListing.publication);
    expect(edited.value.timestamps.rejectedAt).toBeUndefined();
  });

  it("carries a rejected record's rejectedAt through unchanged, never replacing it", () => {
    // **Scope.** This verifies **timestamp preservation** under `withListingContent`,
    // which is status-agnostic and was so before this slice (`P1` Slice A). It neither
    // authorizes nor defines a rejected-listing edit workflow, and issue #141 decides
    // nothing about who may initiate such an edit or whether one is offered anywhere.
    // What is asserted is only this: if that helper is used, the retention anchor is
    // preserved exactly and `lastUpdatedAt` advances.
    const rejected = listingWith("rejected", {
      submittedAt: t0,
      lastUpdatedAt: t1,
      rejectedAt: t1,
    });

    const edited = withListingContent(rejected, revisedContent, t2);

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(instantEquals(edited.value.timestamps.rejectedAt as Instant, t1)).toBe(true);
    expect(instantEquals(edited.value.timestamps.lastUpdatedAt, t2)).toBe(true);
  });

  it("does not mutate the listing it was given", () => {
    const before = submitted();
    withListingContent(before, revisedContent, t1);

    expect(before.content).toEqual(content);
    expect(instantEquals(before.timestamps.lastUpdatedAt, t0)).toBe(true);
  });
});

/** Criteria 4 and 5 — every permitted transition, including the approval with no edit. */
describe("criteria 4 and 5 — every permitted status transition advances lastUpdatedAt", () => {
  it("advances it on pending -> approved, whose content does not change at all", () => {
    const before = submitted();
    const approved = transitionListingStatus(before, "approved", t1);

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    // The case `docs/11` calls the test almost everyone forgets.
    expect(approved.value.content).toEqual(before.content);
    expect(instantEquals(approved.value.timestamps.lastUpdatedAt, t1)).toBe(true);
    expect(instantEquals(before.timestamps.lastUpdatedAt, t0)).toBe(true);
  });

  it("advances it on pending -> pending, the administrator content edit edge", () => {
    const result = transitionListingStatus(submitted(), "pending", t1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(instantEquals(result.value.timestamps.lastUpdatedAt, t1)).toBe(true);
    }
  });

  it("advances it on approved -> approved, the revision-approval edge", () => {
    const result = transitionListingStatus(approvedAt(t1), "approved", t2);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(instantEquals(result.value.timestamps.lastUpdatedAt, t2)).toBe(true);
    }
  });

  it("advances it on pending -> rejected", () => {
    const result = transitionListingStatus(submitted(), "rejected", t1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(instantEquals(result.value.timestamps.lastUpdatedAt, t1)).toBe(true);
    }
  });

  it("refuses every permitted transition offered an instant that does not advance", () => {
    const cases: readonly (readonly [Listing, Listing["status"]])[] = [
      [submitted(), "approved"],
      [submitted(), "rejected"],
      [submitted(), "pending"],
      [approvedAt(t0), "approved"],
    ];

    for (const [before, to] of cases) {
      for (const offered of [t0, at(999)]) {
        const result = transitionListingStatus(before, to, offered);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({ code: "INSTANT_NOT_STRICTLY_LATER" });
        }
      }
    }
  });
});

/** Criterion 6 — the rejection anchor. */
describe("criterion 6 — pending -> rejected writes the retention anchor", () => {
  it("sets rejectedAt to the same instant as the new lastUpdatedAt", () => {
    const result = transitionListingStatus(submitted(), "rejected", t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { lastUpdatedAt, rejectedAt } = result.value.timestamps;

    expect(rejectedAt).toBeDefined();
    expect(instantEquals(rejectedAt as Instant, t1)).toBe(true);
    expect(instantEquals(rejectedAt as Instant, lastUpdatedAt)).toBe(true);
  });

  it("writes it in the transition itself, not as a separate act", () => {
    const before = submitted();
    expect(before.timestamps.rejectedAt).toBeUndefined();

    const rejected = transitionListingStatus(before, "rejected", t1);

    expect(rejected.ok).toBe(true);
    // The record the caller supplied is untouched by the write.
    expect(before.timestamps.rejectedAt).toBeUndefined();
  });

  it("writes no anchor on any transition that is not a rejection", () => {
    for (const [before, to] of [
      [submitted(), "approved"],
      [submitted(), "pending"],
      [approvedAt(t0), "approved"],
    ] as const) {
      const result = transitionListingStatus(before, to, t1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timestamps.rejectedAt).toBeUndefined();
      }
    }
  });
});

/** Criterion 7 — applicability, in both directions. */
describe("criterion 7 — rejectedAt is present iff the listing is rejected", () => {
  it.each(["pending", "approved"] as const)(
    "refuses a %s listing that carries a rejection anchor",
    (status) => {
      const malformed = listingWith(
        status,
        { submittedAt: t0, lastUpdatedAt: t0, rejectedAt: t0 },
        status === "approved" ? { value: "publicly_available" } : undefined,
      );

      const result = resolveListingTimestamps(malformed);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "REJECTION_TIMESTAMP_NOT_APPLICABLE",
          status,
        });
      }
    },
  );

  it("refuses a rejected listing that carries none", () => {
    const malformed = listingWith("rejected", { submittedAt: t0, lastUpdatedAt: t0 });

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_MISSING" });
    }
  });

  it("accepts a well-formed record of each status", () => {
    expect(resolveListingTimestamps(submitted()).ok).toBe(true);
    expect(resolveListingTimestamps(approvedAt(t1)).ok).toBe(true);
    expect(
      resolveListingTimestamps(
        listingWith("rejected", {
          submittedAt: t0,
          lastUpdatedAt: t1,
          rejectedAt: t1,
        }),
      ).ok,
    ).toBe(true);
  });

  it("refuses to write through a malformed record rather than repairing it", () => {
    const malformed = listingWith("pending", {
      submittedAt: t0,
      lastUpdatedAt: t0,
      rejectedAt: t0,
    });

    const transitioned = transitionListingStatus(malformed, "approved", t1);
    const edited = withListingContent(malformed, revisedContent, t1);

    expect(transitioned.ok).toBe(false);
    expect(edited.ok).toBe(false);
  });
});

/** Criterion 8 — the anchor is write-once, with no timestamp-edit API to attack. */
describe("criterion 8 — an existing rejectedAt can never be replaced", () => {
  it("offers no operation that edits a timestamp directly", () => {
    // The attack criterion 8 names is "replace an existing rejectedAt". There is no
    // operation to attempt it with: the exported surface carries no setter, no patch and
    // no timestamp argument that a caller could aim at a stored moment. Each governed
    // operation takes the *moment of the change* and derives what to write from it.
    expect(Object.keys(listingModule).sort()).toEqual([
      "submitListing",
      "withListingContent",
    ]);
    expect(Object.keys(timestampsModule).sort()).toEqual([
      "advancedTimestamps",
      "resolveListingTimestamps",
      "timestampsOnSubmission",
    ]);
  });

  it("cannot be made to write a second anchor through advancedTimestamps either", () => {
    // The one function that writes an anchor refuses to write over one that exists,
    // whatever the caller claims about the change.
    const alreadyRejected = { submittedAt: t0, lastUpdatedAt: t1, rejectedAt: t1 };

    const result = timestampsModule.advancedTimestamps(alreadyRejected, t2, true);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_ALREADY_SET" });
    }
    expect(instantEquals(alreadyRejected.rejectedAt, t1)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 1_000],
    ["a string", "2026-09-19"],
    ["undefined", undefined],
  ])(
    "refuses a %s container at the advance boundary without throwing",
    (_label, offered) => {
      // `advancedTimestamps` is exported, so it cannot assume its caller passed something
      // that already resolved. A malformed container must not reach the comparison, which
      // would dereference it and turn a governed failure into a thrown one.
      const call = () =>
        timestampsModule.advancedTimestamps(
          offered as unknown as ListingTimestamps,
          t2,
          false,
        );

      expect(call).not.toThrow();

      const result = call();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "INVALID_LISTING_TIMESTAMPS",
          offered,
        });
      }
    },
  );

  it.each([
    ["a bare number", 1_000],
    ["a string", "2026-09-19T00:00:00Z"],
    ["a Date", new Date(0)],
    ["null", null],
    ["undefined", undefined],
  ])(
    "refuses a container whose lastUpdatedAt is %s without throwing",
    (_label, offered) => {
      // The field the comparison actually reads. Before the correction this reached
      // `instantIsAfter` and threw; it must now be a governed refusal.
      const call = () =>
        timestampsModule.advancedTimestamps(
          {
            submittedAt: t0,
            lastUpdatedAt: offered as unknown as Instant,
          },
          t2,
          false,
        );

      expect(call).not.toThrow();

      const result = call();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "INVALID_INSTANT", offered });
      }
    },
  );

  it("refuses a container whose rejectedAt is malformed, without throwing", () => {
    const call = () =>
      timestampsModule.advancedTimestamps(
        {
          submittedAt: t0,
          lastUpdatedAt: t1,
          rejectedAt: "yesterday" as unknown as Instant,
        },
        t2,
        false,
      );

    expect(call).not.toThrow();

    const result = call();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "INVALID_INSTANT",
        offered: "yesterday",
      });
    }
  });

  it("refuses every transition out of rejected, so no second anchor is reachable", () => {
    const rejected = listingWith("rejected", {
      submittedAt: t0,
      lastUpdatedAt: t1,
      rejectedAt: t1,
    });

    for (const to of ["pending", "approved", "rejected"] as const) {
      const result = transitionListingStatus(rejected, to, t2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("FORBIDDEN_STATUS_TRANSITION");
      }

      expect(instantEquals(rejected.timestamps.rejectedAt as Instant, t1)).toBe(true);
    }
  });

  it("refuses to rewrite the anchor even where the transition itself would be permitted", () => {
    // A *pending* record that already carries an anchor is malformed, and the rejection
    // path refuses it rather than overwriting what is there.
    const malformed = listingWith("pending", {
      submittedAt: t0,
      lastUpdatedAt: t0,
      rejectedAt: t0,
    });

    const result = transitionListingStatus(malformed, "rejected", t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REJECTION_TIMESTAMP_NOT_APPLICABLE");
    }
    expect(instantEquals(malformed.timestamps.rejectedAt as Instant, t0)).toBe(true);
  });
});

/** Criterion 9 — equal and earlier instants. */
describe("criterion 9 — an instant that does not advance is refused", () => {
  it("refuses an equal instant on a content replacement", () => {
    const before = submitted();
    const result = withListingContent(before, revisedContent, t0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "INSTANT_NOT_STRICTLY_LATER" });
    }
    expect(before.content).toEqual(content);
    expect(instantEquals(before.timestamps.lastUpdatedAt, t0)).toBe(true);
  });

  it("refuses an earlier instant on a content replacement", () => {
    const result = withListingContent(submitted(), revisedContent, at(1));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "INSTANT_NOT_STRICTLY_LATER" });
    }
  });

  it("refuses a malformed instant on either operation, without throwing", () => {
    for (const offered of [Number.NaN, "later", null, undefined, {}, 2.5]) {
      const edited = () =>
        withListingContent(submitted(), revisedContent, offered as unknown as Instant);
      const transitioned = () =>
        transitionListingStatus(submitted(), "approved", offered as unknown as Instant);

      expect(edited).not.toThrow();
      expect(transitioned).not.toThrow();

      const editedResult = edited();
      const transitionedResult = transitioned();

      expect(editedResult.ok).toBe(false);
      expect(transitionedResult.ok).toBe(false);
      if (!editedResult.ok) {
        expect(editedResult.error.code).toBe("INVALID_INSTANT");
      }
      if (!transitionedResult.ok) {
        expect(transitionedResult.error.code).toBe("INVALID_INSTANT");
      }
    }
  });

  it("writes nothing when it refuses — the record is returned to no one, unchanged", () => {
    const before = approvedAt(t1);
    const result = transitionListingStatus(before, "approved", t1);

    expect(result.ok).toBe(false);
    expect(instantEquals(before.timestamps.lastUpdatedAt, t1)).toBe(true);
    expect(before.publication).toEqual({ value: "publicly_available" });
  });
});

/** Criterion 10 — publication operations move nothing. */
describe("criterion 10 — unpublish and republish preserve every timestamp", () => {
  it("preserves them on an unpublish", () => {
    const before = approvedAt(t1);
    const withdrawn = unpublishListing(before, "Reported as misleading.");

    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;

    expect(withdrawn.value.timestamps).toEqual(before.timestamps);
  });

  it("preserves them on a republish", () => {
    const unpublishedListing = listingWith(
      "approved",
      { submittedAt: t0, lastUpdatedAt: t1 },
      { value: "unpublished", reason: "Reported as misleading." },
    );

    const restored = republishListing(unpublishedListing);

    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.timestamps).toEqual(unpublishedListing.timestamps);
    }
  });

  it("takes no instant at all — publication has no moment to record", () => {
    expect(unpublishListing.length).toBe(2);
    expect(republishListing.length).toBe(1);
  });
});

/** Criterion 11 — refusals are inert. */
describe("criterion 11 — refused actions preserve every timestamp", () => {
  it("leaves timestamps untouched on a forbidden transition", () => {
    const before = listingWith("rejected", {
      submittedAt: t0,
      lastUpdatedAt: t1,
      rejectedAt: t1,
    });

    const result = transitionListingStatus(before, "approved", t2);

    expect(result.ok).toBe(false);
    expect(before.timestamps).toEqual({
      submittedAt: t0,
      lastUpdatedAt: t1,
      rejectedAt: t1,
    });
  });

  it("leaves timestamps untouched on an unknown status", () => {
    const before = submitted();
    const result = transitionListingStatus(
      before,
      "archived" as unknown as Listing["status"],
      t1,
    );

    expect(result.ok).toBe(false);
    expect(instantEquals(before.timestamps.lastUpdatedAt, t0)).toBe(true);
  });

  it("leaves timestamps untouched on a repeated unpublish", () => {
    const unpublishedListing = listingWith(
      "approved",
      { submittedAt: t0, lastUpdatedAt: t1 },
      { value: "unpublished", reason: "Reported as misleading." },
    );

    const result = unpublishListing(unpublishedListing, "Reported again.");

    expect(result.ok).toBe(false);
    expect(unpublishedListing.timestamps).toEqual({
      submittedAt: t0,
      lastUpdatedAt: t1,
    });
  });

  it("leaves timestamps untouched on a repeated republish", () => {
    const before = approvedAt(t1);
    const result = republishListing(before);

    expect(result.ok).toBe(false);
    expect(before.timestamps).toEqual({ submittedAt: t0, lastUpdatedAt: t1 });
  });
});

/** Criterion 12 — no timestamp is ever public. */
describe("criterion 12 — timestamps never reach a public surface", () => {
  it("omits every timestamp from a successful projection", () => {
    const projected = projectListingPublicly(approvedAt(t1));

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const keys = Object.keys(projected.value);
    expect(keys).not.toContain("timestamps");
    expect(keys).not.toContain("submittedAt");
    expect(keys).not.toContain("lastUpdatedAt");
    expect(keys).not.toContain("rejectedAt");

    const serialized = JSON.stringify(projected.value);
    for (const moment of ["1000", "2000", "3000"]) {
      expect(serialized).not.toContain(moment);
    }
  });

  it("carries no timestamp on the generic unavailable outcome", () => {
    const rejected = listingWith("rejected", {
      submittedAt: t0,
      lastUpdatedAt: t1,
      rejectedAt: t1,
    });

    for (const subject of [undefined, submitted(), rejected]) {
      const result = projectListingPublicly(subject);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
      }
    }
  });
});

/** Criterion 13 — malformed records are governed failures, never throws. */
describe("criterion 13 — malformed timestamps are refused as values", () => {
  function listingWithRawTimestamps(offered: unknown): Listing {
    return {
      id: listingId,
      status: "pending",
      content,
      timestamps: offered,
    } as unknown as Listing;
  }

  it("reports an absent bundle as missing, not as malformed", () => {
    const malformed = listingWithRawTimestamps(undefined);

    expect(() => resolveListingTimestamps(malformed)).not.toThrow();

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "LISTING_TIMESTAMPS_MISSING" });
    }
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 1_000],
    ["a string", "2026-09-19"],
    ["a boolean", true],
  ])(
    "reports a present bundle that is %s as an unusable container, without throwing",
    (_label, offered) => {
      const malformed = listingWithRawTimestamps(offered);

      expect(() => resolveListingTimestamps(malformed)).not.toThrow();

      const result = resolveListingTimestamps(malformed);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Exactly this code — a container defect is not an instant defect, and absent is
        // not malformed. Each case asserts one code, never a set of acceptable ones.
        expect(result.error).toEqual({
          code: "INVALID_LISTING_TIMESTAMPS",
          offered,
        });
      }
    },
  );

  it.each([
    ["a bare number", 1_000],
    ["a string", "2026-09-19T00:00:00Z"],
    ["a Date", new Date(0)],
    ["null", null],
    ["undefined", undefined],
  ])("refuses a submittedAt that is %s", (_label, offered) => {
    const malformed = listingWith("pending", {
      submittedAt: offered as unknown as Instant,
      lastUpdatedAt: t0,
    });

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INSTANT");
    }
  });

  it("refuses a malformed lastUpdatedAt", () => {
    const malformed = listingWith("pending", {
      submittedAt: t0,
      lastUpdatedAt: "yesterday" as unknown as Instant,
    });

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INSTANT");
    }
  });

  it("refuses a record whose submission postdates its last update", () => {
    const malformed = listingWith("pending", { submittedAt: t2, lastUpdatedAt: t1 });

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "TIMESTAMP_ORDER_VIOLATION",
        field: "submittedAt",
      });
    }
  });

  it("refuses a record rejected before it was submitted", () => {
    // The anchor predates the submission it is supposed to follow: submitted at 2000,
    // last updated at 3000, but rejected at 1000. Rulings 1, 3, 6 and 7 cannot produce
    // this — `rejectedAt` is written equal to a `lastUpdatedAt` that has already reached
    // or passed `submittedAt`, and never moves again — so a record carrying it was not
    // produced by these operations and is refused rather than relied on.
    const rejectedBeforeSubmitted = listingWith("rejected", {
      submittedAt: at(2_000),
      lastUpdatedAt: at(3_000),
      rejectedAt: at(1_000),
    });

    expect(() => resolveListingTimestamps(rejectedBeforeSubmitted)).not.toThrow();

    const result = resolveListingTimestamps(rejectedBeforeSubmitted);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "TIMESTAMP_ORDER_VIOLATION",
        field: "rejectedAt",
      });
    }
  });

  it("refuses an anchor that predates submission on a non-rejected record too", () => {
    // Evaluated before applicability, so the moments are judged whatever the status.
    const malformed = listingWith("pending", {
      submittedAt: at(2_000),
      lastUpdatedAt: at(3_000),
      rejectedAt: at(1_000),
    });

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "TIMESTAMP_ORDER_VIOLATION",
        field: "rejectedAt",
      });
    }
  });

  it("refuses a rejected record whose anchor postdates its last update", () => {
    const malformed = listingWith("rejected", {
      submittedAt: t0,
      lastUpdatedAt: t1,
      rejectedAt: t2,
    });

    const result = resolveListingTimestamps(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "TIMESTAMP_ORDER_VIOLATION",
        field: "rejectedAt",
      });
    }
  });

  it("never throws on any governed operation, whatever it is given", () => {
    const malformed = {
      id: listingId,
      status: "rejected",
      content,
      timestamps: null,
    } as unknown as Listing;

    expect(() => transitionListingStatus(malformed, "approved", t1)).not.toThrow();
    expect(() => withListingContent(malformed, revisedContent, t1)).not.toThrow();
    expect(() => projectListingPublicly(malformed)).not.toThrow();
  });
});

/** Criterion 14 — Slice A and Slice B behaviour is intact under the new invariant. */
describe("criterion 14 — earlier slices still behave as they did", () => {
  it("still initializes publication state on the approval edge", () => {
    const approved = transitionListingStatus(submitted(), "approved", t1);

    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.publication).toEqual({ value: "publicly_available" });
    }
  });

  it("still preserves publication state across the approved -> approved edge", () => {
    const unpublishedListing = listingWith(
      "approved",
      { submittedAt: t0, lastUpdatedAt: t1 },
      { value: "unpublished", reason: "Reported as misleading." },
    );

    const result = transitionListingStatus(unpublishedListing, "approved", t2);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.publication).toEqual(unpublishedListing.publication);
    }
  });

  it("still keeps identity stable across a timestamped edit", () => {
    const before = submitted();
    const edited = withListingContent(before, revisedContent, t1);

    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.value.id).toBe(before.id);
    }
  });

  it("still carries no publication state off the approved status", () => {
    const rejected = transitionListingStatus(submitted(), "rejected", t1);

    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.value.publication).toBeUndefined();
    }
  });

  it("runs a full lifecycle with timestamps that only ever move forward", () => {
    const listing = submitted();

    const approved = transitionListingStatus(listing, "approved", t1);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    const edited = withListingContent(approved.value, revisedContent, t2);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const withdrawn = unpublishListing(edited.value, "Reported as misleading.");
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;

    const restored = republishListing(withdrawn.value);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(instantEquals(restored.value.timestamps.submittedAt, t0)).toBe(true);
    expect(instantEquals(restored.value.timestamps.lastUpdatedAt, t2)).toBe(true);
    expect(restored.value.timestamps.rejectedAt).toBeUndefined();
    expect(resolveListingTimestamps(restored.value).ok).toBe(true);
  });
});
