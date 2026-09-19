/**
 * Attacking tests for publication state (`P1` Slice B, issue #139).
 *
 * Each test attempts the violation and fails to achieve it — "the test passes" is not
 * the standard (`docs/12` *Definition of done*, condition 3). Criterion numbers refer to
 * issue #139's acceptance criteria.
 *
 * Under attack: the two-value set and its applicability (`docs/08` *Status model →
 * Publication state*), `FR-ADM-12`'s mandatory current reason, `FR-MOD-01` (publication
 * is never implicit), and `FR-AUD-01`/`DI-1` (no fourth listing status).
 */
import { describe, expect, it } from "vitest";

import { instantOf, type Instant } from "./instant";
import type { Listing, ListingContent } from "./listing";
import { withListingContent } from "./listing";
import { listingIdOf } from "./listing-id";
import { projectListingPublicly } from "./public-projection";
import {
  PUBLICATION_VALUES,
  isPubliclyAvailable,
  isPublicationValue,
  publicationOnApproval,
  republishListing,
  resolvePublicationState,
  unpublishListing,
  type PublicationState,
} from "./publication";
import {
  LISTING_STATUSES,
  PERMITTED_STATUS_TRANSITIONS,
  transitionListingStatus,
} from "./status";

const content: ListingContent = {
  name: "Harbour Bakery",
  category: "food-and-drink",
  description: "A small bakery.",
  locality: "Kinsale",
  country: "IE",
  phone: { value: "+353 21 000 0000", designatedPublic: true },
};

const revisedContent: ListingContent = { ...content, description: "A small bakery, now with a coffee counter." };

const listingId = listingIdOf("listing-1");

/**
 * `P1` Slice C (issue #141) makes administrative timestamps part of what a listing *is*,
 * so the fixtures supply them and the instants these tests pass are always strictly later
 * than `t0`. Timestamp rules are attacked in `timestamps.test.ts`; here they are only
 * carried, so that these tests keep attacking publication state — their subject.
 */
const t0 = instantAt(1_000);
const t1 = instantAt(2_000);
const t2 = instantAt(3_000);

function instantAt(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }
  return result.value;
}

function listing(
  status: Listing["status"],
  publication?: PublicationState,
): Listing {
  const timestamps =
    status === "rejected"
      ? { submittedAt: t0, lastUpdatedAt: t0, rejectedAt: t0 }
      : { submittedAt: t0, lastUpdatedAt: t0 };

  return publication === undefined
    ? { id: listingId, status, content, timestamps }
    : { id: listingId, status, content, publication, timestamps };
}

const publiclyAvailable = listing("approved", { value: "publicly_available" });
const originalReason = "Reported as misleading; awaiting owner contact.";
const unpublished = listing("approved", {
  value: "unpublished",
  reason: originalReason,
});

/** Criterion 1 — exactly one of two values, never none, never both. */
describe("criterion 1 — two publication values, applicable iff approved", () => {
  it("offers exactly two values and no more", () => {
    expect(PUBLICATION_VALUES).toEqual(["publicly_available", "unpublished"]);
    expect(PUBLICATION_VALUES).toHaveLength(2);
  });

  it("resolves an approved listing to exactly one of them", () => {
    for (const subject of [publiclyAvailable, unpublished]) {
      const resolved = resolvePublicationState(subject);

      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(PUBLICATION_VALUES).toContain(resolved.value.value);
      }
    }
  });

  it("cannot be made to hold both values at once", () => {
    // A state carrying both values is not representable; the nearest attack is a value
    // outside the set, which is refused rather than coerced to either member.
    const both = { value: "publicly_available unpublished" } as unknown as PublicationState;
    const result = resolvePublicationState(listing("approved", both));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_PUBLICATION_VALUE");
    }
  });

  it("refuses any value outside the set at the guard", () => {
    for (const offered of ["", "public", "PUBLICLY_AVAILABLE", "deleted", null, 0, {}]) {
      expect(isPublicationValue(offered)).toBe(false);
    }
  });
});

/** Criterion 2 — invalid publication-state / status combinations are refused. */
describe("criterion 2 — invalid publication-state / status combinations", () => {
  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "refuses a publication state offered for a %s listing",
    (status) => {
      const result = resolvePublicationState(
        listing(status, { value: "publicly_available" }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "PUBLICATION_STATE_NOT_APPLICABLE",
          status,
        });
      }
    },
  );

  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "reports a %s listing as having no publication state at all",
    (status) => {
      const result = resolvePublicationState(listing(status));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_APPROVED", status });
      }
    },
  );

  it("refuses a value outside the two-value set on an approved listing", () => {
    const result = resolvePublicationState(
      listing("approved", { value: "archived" } as unknown as PublicationState),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "UNKNOWN_PUBLICATION_VALUE",
        offered: "archived",
      });
    }
  });
});

/** Criterion 3 — explicit valid state required; missing never silently becomes public. */
describe("criterion 3 — a missing publication state is refused, never defaulted", () => {
  it("refuses an approved listing carrying no publication state", () => {
    const result = resolvePublicationState(listing("approved"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "PUBLICATION_STATE_MISSING" });
    }
  });

  it("does not treat a missing state as publicly available", () => {
    expect(isPubliclyAvailable(listing("approved"))).toBe(false);
  });

  it("does not treat a malformed state as publicly available", () => {
    const malformed = listing("approved", { value: "yes" } as unknown as PublicationState);

    expect(isPubliclyAvailable(malformed)).toBe(false);
  });

  it("states what an approval produces, rather than defaulting a missing value", () => {
    // The value is decided by `docs/08`'s `[*] → publicly available : approval` edge.
    expect(publicationOnApproval()).toEqual({ value: "publicly_available" });
    // ...and it is applied on the approval edge, not to a listing whose state is absent.
    const approved = transitionListingStatus(listing("pending"), "approved", t1);

    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.publication).toEqual({ value: "publicly_available" });
    }
  });
});

/** Criterion 4 — no fourth listing status appears. */
describe("criterion 4 — the listing status set is untouched", () => {
  it("still holds exactly the three FR-AUD-01 values", () => {
    expect(LISTING_STATUSES).toEqual(["pending", "approved", "rejected"]);
    expect(LISTING_STATUSES).toHaveLength(3);
  });

  it("still holds exactly the NFR-DATA-02 permitted transitions", () => {
    expect(PERMITTED_STATUS_TRANSITIONS).toEqual([
      ["pending", "approved"],
      ["pending", "rejected"],
      ["pending", "pending"],
      ["approved", "approved"],
    ]);
  });

  it("leaves an unpublished listing's status as approved", () => {
    expect(unpublished.status).toBe("approved");

    const result = unpublishListing(publiclyAvailable, "Reported as misleading.");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("approved");
    }
  });

  it("does not admit a publication value as a listing status", () => {
    for (const value of PUBLICATION_VALUES) {
      expect(LISTING_STATUSES).not.toContain(value as unknown as string);
    }
  });
});

/** Criteria 5-7 — unpublishing requires a current reason, which exists only while unpublished. */
describe("criteria 5-7 — the unpublish reason", () => {
  it("refuses an unpublish with a missing reason and leaves the listing public", () => {
    const result = unpublishListing(
      publiclyAvailable,
      undefined as unknown as string,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "UNPUBLISH_REASON_MISSING" });
    }
    expect(isPubliclyAvailable(publiclyAvailable)).toBe(true);
  });

  it.each(["", "   ", "\t\n"])(
    "refuses an unpublish whose reason is %j and leaves the listing public",
    (reason) => {
      const result = unpublishListing(publiclyAvailable, reason);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "UNPUBLISH_REASON_MISSING" });
      }
      expect(isPubliclyAvailable(publiclyAvailable)).toBe(true);
    },
  );

  it("records the reason when one is supplied", () => {
    const result = unpublishListing(publiclyAvailable, "Reported as misleading.");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.publication).toEqual({
        value: "unpublished",
        reason: "Reported as misleading.",
      });
    }
  });

  it("refuses a reason carried by a publicly available listing", () => {
    const withReason = listing("approved", {
      value: "publicly_available",
      reason: "left over from an earlier unpublishing",
    } as unknown as PublicationState);

    const result = resolvePublicationState(withReason);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "PUBLICATION_REASON_NOT_APPLICABLE" });
    }
  });

  it("refuses an unpublished listing whose reason is blank", () => {
    const result = resolvePublicationState(
      listing("approved", { value: "unpublished", reason: "  " }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "UNPUBLISH_REASON_MISSING" });
    }
  });

  it("does not mutate the listing it refuses or accepts", () => {
    const before = { ...publiclyAvailable };
    unpublishListing(publiclyAvailable, "");
    unpublishListing(publiclyAvailable, "Reported as misleading.");

    expect(publiclyAvailable).toEqual(before);
  });
});

/** Criteria 8-10 — republishing. */
describe("criteria 8-10 — republishing", () => {
  it("exposes the current approved content, not the content that was public before", () => {
    const withdrawn = unpublishListing(publiclyAvailable, "Reported as misleading.");
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;

    const corrected = withListingContent(withdrawn.value, revisedContent, t1);
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;

    const restored = republishListing(corrected.value);

    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.content).toEqual(revisedContent);
      expect(restored.value.content).not.toEqual(content);
      expect(isPubliclyAvailable(restored.value)).toBe(true);
    }
  });

  it("clears the unpublish reason", () => {
    const restored = republishListing(unpublished);

    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.publication).toEqual({ value: "publicly_available" });
      expect(restored.value.publication).not.toHaveProperty("reason");
      expect(JSON.stringify(restored.value)).not.toContain("awaiting owner contact");
    }
  });

  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "refuses to republish a %s listing",
    (status) => {
      const result = republishListing(listing(status));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_APPROVED", status });
      }
    },
  );

  it.each(LISTING_STATUSES.filter((status) => status !== "approved"))(
    "refuses to republish a %s listing even when one is offered a publication state",
    (status) => {
      const result = republishListing(
        listing(status, { value: "unpublished", reason: "withheld" }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "PUBLICATION_STATE_NOT_APPLICABLE",
          status,
        });
      }
    },
  );

  it("refuses to republish a listing that is already publicly available", () => {
    const result = republishListing(publiclyAvailable);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "PUBLICATION_TRANSITION_FORBIDDEN",
        from: "publicly_available",
        to: "publicly_available",
      });
    }
  });
});

/**
 * The repeated-action ruling (Product Owner, 2026-09-18, issue #139): a repeated
 * unpublish or republish is **refused** and changes the listing, its publication state
 * and its current reason **not at all**.
 */
describe("repeated actions are refused and change nothing (ruling, issue #139)", () => {
  it("refuses a second republish and leaves the listing byte-for-byte unchanged", () => {
    const before = structuredClone(publiclyAvailable);

    const result = republishListing(publiclyAvailable);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "PUBLICATION_TRANSITION_FORBIDDEN",
        from: "publicly_available",
        to: "publicly_available",
      });
    }
    expect(publiclyAvailable).toEqual(before);
    expect(isPubliclyAvailable(publiclyAvailable)).toBe(true);
  });

  it("refuses a second unpublish and never replaces the recorded current reason", () => {
    const before = structuredClone(unpublished);

    const result = unpublishListing(unpublished, "a second, different reason");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "PUBLICATION_TRANSITION_FORBIDDEN",
        from: "unpublished",
        to: "unpublished",
      });
    }
    expect(unpublished).toEqual(before);
    expect(unpublished.publication).toEqual({
      value: "unpublished",
      reason: originalReason,
    });
    expect(JSON.stringify(unpublished)).not.toContain("a second, different reason");
  });

  it("refuses a repeated action however many times it is attempted", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(republishListing(publiclyAvailable).ok).toBe(false);
      expect(unpublishListing(unpublished, "another reason").ok).toBe(false);
    }

    expect(isPubliclyAvailable(publiclyAvailable)).toBe(true);
    expect(unpublished.publication).toEqual({
      value: "unpublished",
      reason: originalReason,
    });
  });

  it("still permits the drawn edges, so the refusal is not a deadlock", () => {
    const withdrawn = unpublishListing(publiclyAvailable, "Reported as misleading.");
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;

    const restored = republishListing(withdrawn.value);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(isPubliclyAvailable(restored.value)).toBe(true);
    }
  });
});

/** Criterion 11 — content replacement preserves publication state. */
describe("criterion 11 — content replacement preserves publication state", () => {
  it("leaves an unpublished listing unpublished, with its reason intact", () => {
    const edited = withListingContent(unpublished, revisedContent, t1);

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(edited.value.content).toEqual(revisedContent);
    expect(edited.value.publication).toEqual(unpublished.publication);
    expect(isPubliclyAvailable(edited.value)).toBe(false);
  });

  it("leaves a publicly available listing publicly available", () => {
    const edited = withListingContent(publiclyAvailable, revisedContent, t1);

    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(isPubliclyAvailable(edited.value)).toBe(true);
    }
  });

  it("does not republish through the approved → approved content edge", () => {
    // This is the edge an approved revision travels (`ADR-006`, "approved → approved,
    // content only"). No revision-approval API exists or is added here; the edge itself
    // must not publish, because publication is never implicit (`FR-MOD-01`).
    const edited = withListingContent(unpublished, revisedContent, t1);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const transitioned = transitionListingStatus(edited.value, "approved", t2);

    expect(transitioned.ok).toBe(true);
    if (transitioned.ok) {
      expect(transitioned.value.publication).toEqual(unpublished.publication);
      expect(isPubliclyAvailable(transitioned.value)).toBe(false);
    }
  });

  it("produces no publication state on the pending -> rejected transition", () => {
    const rejected = transitionListingStatus(listing("pending"), "rejected", t1);

    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.value.publication).toBeUndefined();
    }
  });
});

/**
 * Malformed publication state, attacked through every entry point (issue #139).
 *
 * The state is typed, but on any real read path it arrives from outside the type system,
 * so each of these shapes is offered deliberately. The requirement is threefold: nothing
 * **throws** — a thrown error is not a domain outcome (`ADR-002` `O-11`); nothing becomes
 * **public** — fail-closed, because publication is never implicit (`FR-MOD-01`); and the
 * **input is unchanged**, since a refusal is inert with respect to the listing (`DI-3`).
 *
 * The public surface additionally reports only the one generic unavailable outcome, so a
 * malformed record is indistinguishable from an absent, pending, rejected or unpublished
 * one (`FR-VIS-08`, `BI-4`).
 */
describe("malformed publication state is refused, never thrown and never public", () => {
  const malformedStates: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["an array", []],
    ["a populated array", [{ value: "publicly_available" }]],
    ["a string", "publicly_available"],
    ["a number", 1],
    ["a boolean", true],
    ["an empty object", {}],
    ["an object with no value key", { reason: "withheld" }],
    ["an object whose value is null", { value: null }],
    ["an object whose value is a number", { value: 1 }],
    ["an object whose value is an object", { value: { value: "publicly_available" } }],
    ["an object with an unknown value", { value: "archived" }],
  ];

  function approvedWith(publication: unknown): Listing {
    return {
      id: listingId,
      status: "approved",
      content,
      publication: publication as PublicationState,
      timestamps: { submittedAt: t0, lastUpdatedAt: t0 },
    };
  }

  it.each(malformedStates)(
    "resolvePublicationState refuses %s without throwing",
    (_label, offered) => {
      const subject = approvedWith(offered);

      expect(() => resolvePublicationState(subject)).not.toThrow();

      const result = resolvePublicationState(subject);

      expect(result.ok).toBe(false);
    },
  );

  it.each(malformedStates)(
    "isPubliclyAvailable reports false for %s without throwing",
    (_label, offered) => {
      const subject = approvedWith(offered);

      expect(() => isPubliclyAvailable(subject)).not.toThrow();
      expect(isPubliclyAvailable(subject)).toBe(false);
    },
  );

  it.each(malformedStates)(
    "projectListingPublicly withholds %s behind the one generic outcome",
    (_label, offered) => {
      const subject = approvedWith(offered);

      expect(() => projectListingPublicly(subject)).not.toThrow();

      const result = projectListingPublicly(subject);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_PUBLICLY_AVAILABLE" });
        expect(Object.keys(result.error)).toEqual(["code"]);
      }
    },
  );

  it.each(malformedStates)(
    "the unavailable outcome for %s is identical to the absent, pending and rejected ones",
    (_label, offered) => {
      const malformed = projectListingPublicly(approvedWith(offered));
      const absent = projectListingPublicly(undefined);
      const pending = projectListingPublicly(listing("pending"));
      const rejected = projectListingPublicly(listing("rejected"));

      const serialized = [malformed, absent, pending, rejected].map((outcome) =>
        JSON.stringify(outcome),
      );

      expect(new Set(serialized).size).toBe(1);
    },
  );

  it.each(malformedStates)(
    "transitionListingStatus refuses the approved -> approved edge for %s without throwing",
    (_label, offered) => {
      const subject = approvedWith(offered);

      expect(() => transitionListingStatus(subject, "approved", t1)).not.toThrow();

      const result = transitionListingStatus(subject, "approved", t1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).not.toBe("FORBIDDEN_STATUS_TRANSITION");
      }
    },
  );

  it.each(malformedStates)(
    "no entry point mutates the listing it was offered for %s",
    (_label, offered) => {
      const subject = approvedWith(offered);
      const before = structuredClone(subject);

      resolvePublicationState(subject);
      isPubliclyAvailable(subject);
      projectListingPublicly(subject);
      transitionListingStatus(subject, "approved", t1);
      unpublishListing(subject, "Reported as misleading.");
      republishListing(subject);

      expect(subject).toEqual(before);
    },
  );

  it.each(malformedStates)(
    "unpublish and republish both refuse %s without throwing",
    (_label, offered) => {
      const subject = approvedWith(offered);

      expect(() => unpublishListing(subject, "Reported as misleading.")).not.toThrow();
      expect(() => republishListing(subject)).not.toThrow();
      expect(unpublishListing(subject, "Reported as misleading.").ok).toBe(false);
      expect(republishListing(subject).ok).toBe(false);
    },
  );

  it("refuses null and array states with a governed value rather than a missing one", () => {
    // `PUBLICATION_STATE_MISSING` means *absent*; a present-but-unusable state is a
    // different refusal, so the two are not conflated.
    for (const offered of [null, [], "publicly_available", 1]) {
      const result = resolvePublicationState(approvedWith(offered));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "UNKNOWN_PUBLICATION_VALUE",
          offered,
        });
      }
    }
  });
});

/**
 * The status-transition API is the other way a publication state can be reached, so the
 * same rules are attacked through it: initial approval initializes *publicly available*,
 * and the content-only `approved -> approved` edge preserves a valid state but **refuses**
 * a missing or malformed one rather than repairing it into a public listing.
 */
describe("publication state through transitionListingStatus (criteria 3 and 11)", () => {
  it("initializes publicly available on the initial pending -> approved transition", () => {
    const approved = transitionListingStatus(listing("pending"), "approved", t1);

    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.publication).toEqual({ value: "publicly_available" });
      expect(isPubliclyAvailable(approved.value)).toBe(true);
    }
  });

  it("preserves a valid existing state across the approved -> approved edge", () => {
    for (const subject of [publiclyAvailable, unpublished]) {
      const result = transitionListingStatus(subject, "approved", t1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.publication).toEqual(subject.publication);
      }
    }
  });

  it("refuses an approved -> approved transition on a listing whose state is missing", () => {
    const result = transitionListingStatus(listing("approved"), "approved", t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "PUBLICATION_STATE_MISSING" });
    }
  });

  it("refuses an approved -> approved transition on a listing whose state is malformed", () => {
    const malformed = listing(
      "approved",
      { value: "sort-of-public" } as unknown as PublicationState,
    );

    const result = transitionListingStatus(malformed, "approved", t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "UNKNOWN_PUBLICATION_VALUE",
        offered: "sort-of-public",
      });
    }
  });

  it("refuses an approved -> approved transition on an unpublished listing with a blank reason", () => {
    const blank = listing("approved", { value: "unpublished", reason: "   " });

    const result = transitionListingStatus(blank, "approved", t1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "UNPUBLISH_REASON_MISSING" });
    }
  });

  it("never repairs a missing or malformed state by making the listing public", () => {
    const subjects = [
      listing("approved"),
      listing("approved", { value: "sort-of-public" } as unknown as PublicationState),
      listing("approved", { value: "unpublished", reason: "" }),
    ];

    for (const subject of subjects) {
      const result = transitionListingStatus(subject, "approved", t1);

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      // The refusal never yields a listing at all, so nothing can have been published.
      expect(result.error).not.toHaveProperty("publication");
      expect(isPubliclyAvailable(subject)).toBe(false);
    }
  });
});
