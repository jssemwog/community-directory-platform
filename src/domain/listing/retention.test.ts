/**
 * Attacking tests for retention eligibility (`P1` Slice E, issue #149).
 *
 * Under attack: the `OQ-13` retention period as the Product Owner ruling fixes its
 * boundary — a **fixed elapsed duration** of exactly 90 × 24 hours measured from each
 * record's write-once rejection anchor (`ADR-017` Q-1/Q-2), with the record **not**
 * purge-eligible before that boundary and eligible **at** it and after it.
 *
 * What these tests deliberately do **not** assert: that anything is purged, scheduled,
 * stored, restored, authorized or audited. Eligibility *permits* a purge this slice does
 * not implement, and changes nothing else about the record (`FR-AUD-06`, `docs/11`).
 */
import { describe, expect, it } from "vitest";

import { instantOf, type Instant } from "./instant";
import type { Listing, ListingContent } from "./listing";
import { listingIdOf } from "./listing-id";
import type { DomainError } from "./result";
import {
  RETENTION_PERIOD_MILLISECONDS,
  listingIsPurgeEligible,
  revisionIsPurgeEligible,
} from "./retention";
import { REVISION_STATES, type ListingRevision } from "./revision";
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

/** The anchor every fixture below is measured from, unless it says otherwise. */
const anchor = instantAt(1_000);
const boundary = instantAt(1_000 + RETENTION_PERIOD_MILLISECONDS);
const justBefore = instantAt(1_000 + RETENTION_PERIOD_MILLISECONDS - 1);
const justAfter = instantAt(1_000 + RETENTION_PERIOD_MILLISECONDS + 1);

function rejectedListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingId,
    status: "rejected",
    content,
    timestamps: { submittedAt: anchor, lastUpdatedAt: anchor, rejectedAt: anchor },
    ...overrides,
  };
}

function rejectedRevision(overrides: Partial<ListingRevision> = {}): ListingRevision {
  return {
    listingId,
    state: "rejected",
    proposedContent: { ...content, description: "A small bakery and cafe." },
    rejectedAt: anchor,
    ...overrides,
  };
}

/** Rebuilt through a serialization round trip: same values, no shared references. */
function reconstructed<T>(value: T): T {
  return structuredClone(value);
}

function expectEligibility(
  result: ReturnType<typeof listingIsPurgeEligible>,
  eligible: boolean,
): void {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toBe(eligible);
  }
}

describe("the retention period is the ruling's fixed elapsed duration", () => {
  it("is exactly 90 × 24 hours, in every unit the ruling states", () => {
    expect(RETENTION_PERIOD_MILLISECONDS).toBe(7_776_000_000);
    expect(RETENTION_PERIOD_MILLISECONDS / 1000).toBe(7_776_000);
    expect(RETENTION_PERIOD_MILLISECONDS / (60 * 60 * 1000)).toBe(2_160);
    expect(RETENTION_PERIOD_MILLISECONDS / (24 * 60 * 60 * 1000)).toBe(90);
  });

  it("is a duration and not a moment, so it is a plain safe integer count", () => {
    expect(Number.isSafeInteger(RETENTION_PERIOD_MILLISECONDS)).toBe(true);
    expect(typeof RETENTION_PERIOD_MILLISECONDS).toBe("number");
  });
});

describe("a rejected listing at the retention boundary (FR-AUD-06, OQ-13)", () => {
  it("is not purge-eligible one millisecond before the boundary", () => {
    expectEligibility(listingIsPurgeEligible(rejectedListing(), justBefore), false);
  });

  it("is purge-eligible at the exact boundary", () => {
    expectEligibility(listingIsPurgeEligible(rejectedListing(), boundary), true);
  });

  it("is purge-eligible one millisecond after the boundary", () => {
    expectEligibility(listingIsPurgeEligible(rejectedListing(), justAfter), true);
  });

  it("is not purge-eligible at the moment of rejection itself", () => {
    expectEligibility(listingIsPurgeEligible(rejectedListing(), anchor), false);
  });

  it("is not purge-eligible one day short, and is one day past", () => {
    const day = 24 * 60 * 60 * 1000;

    expectEligibility(
      listingIsPurgeEligible(
        rejectedListing(),
        instantAt(1_000 + RETENTION_PERIOD_MILLISECONDS - day),
      ),
      false,
    );
    expectEligibility(
      listingIsPurgeEligible(
        rejectedListing(),
        instantAt(1_000 + RETENTION_PERIOD_MILLISECONDS + day),
      ),
      true,
    );
  });

  it("is not purge-eligible when evaluated before its own rejection", () => {
    expectEligibility(listingIsPurgeEligible(rejectedListing(), instantAt(0)), false);
  });
});

describe("a rejected revision at the retention boundary (FR-AUD-06, OQ-13)", () => {
  it("is not purge-eligible one millisecond before the boundary", () => {
    expectEligibility(revisionIsPurgeEligible(rejectedRevision(), justBefore), false);
  });

  it("is purge-eligible at the exact boundary", () => {
    expectEligibility(revisionIsPurgeEligible(rejectedRevision(), boundary), true);
  });

  it("is purge-eligible one millisecond after the boundary", () => {
    expectEligibility(revisionIsPurgeEligible(rejectedRevision(), justAfter), true);
  });

  it("is not purge-eligible at the moment of rejection itself", () => {
    expectEligibility(revisionIsPurgeEligible(rejectedRevision(), anchor), false);
  });
});

describe("one uniform rule covers both record types (OQ-13)", () => {
  it.each([
    ["one millisecond before", justBefore, false],
    ["at the boundary", boundary, true],
    ["one millisecond after", justAfter, true],
  ] as const)(
    "answers identically for a listing and a revision %s",
    (_label, evaluatedAt, expected) => {
      const forListing = listingIsPurgeEligible(rejectedListing(), evaluatedAt);
      const forRevision = revisionIsPurgeEligible(rejectedRevision(), evaluatedAt);

      expect(forListing).toEqual(forRevision);
      expectEligibility(forListing, expected);
      expectEligibility(forRevision, expected);
    },
  );

  it("applies the same period to several representative anchors, including zero", () => {
    for (const epoch of [0, 1, 1_000, 1_700_000_000_000]) {
      const at = instantAt(epoch);
      const listing = rejectedListing({
        timestamps: { submittedAt: at, lastUpdatedAt: at, rejectedAt: at },
      });
      const revision = rejectedRevision({ rejectedAt: at });

      for (const [offset, expected] of [
        [RETENTION_PERIOD_MILLISECONDS - 1, false],
        [RETENTION_PERIOD_MILLISECONDS, true],
      ] as const) {
        const evaluatedAt = instantAt(epoch + offset);
        expectEligibility(listingIsPurgeEligible(listing, evaluatedAt), expected);
        expectEligibility(revisionIsPurgeEligible(revision, evaluatedAt), expected);
      }
    }
  });

  it("does not vary the period by category, content or listing identity", () => {
    const other = rejectedListing({
      id: listingIdOf("listing-2"),
      content: { ...content, category: "retail", name: "Quay Books" },
    });

    expect(listingIsPurgeEligible(other, boundary)).toEqual(
      listingIsPurgeEligible(rejectedListing(), boundary),
    );
  });
});

describe("the arithmetic stays inside the supported numeric domain", () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const minimum = -Number.MAX_SAFE_INTEGER;

  it("answers at the top of the representable range, where the boundary is not representable", () => {
    // `rejectedAt + period` would exceed the exactly-representable range here, so a
    // boundary moment can never be constructed — the answer must come from the elapsed
    // quantity instead.
    const at = instantAt(maximum);
    const listing = rejectedListing({
      timestamps: { submittedAt: at, lastUpdatedAt: at, rejectedAt: at },
    });

    expectEligibility(listingIsPurgeEligible(listing, at), false);
    expectEligibility(
      revisionIsPurgeEligible(rejectedRevision({ rejectedAt: at }), at),
      false,
    );
  });

  it("answers at the bottom of the representable range", () => {
    const at = instantAt(minimum);
    const revision = rejectedRevision({ rejectedAt: at });

    expectEligibility(
      revisionIsPurgeEligible(revision, instantAt(minimum + RETENTION_PERIOD_MILLISECONDS - 1)),
      false,
    );
    expectEligibility(
      revisionIsPurgeEligible(revision, instantAt(minimum + RETENTION_PERIOD_MILLISECONDS)),
      true,
    );
  });

  it("stays correct when the elapsed difference itself exceeds the safe range", () => {
    // The difference between two safe integers need not be a safe integer. The sign still
    // settles the question exactly at that magnitude, and no finite result is invented.
    const anchored = instantAt(minimum);
    const evaluated = instantAt(maximum);

    expectEligibility(
      revisionIsPurgeEligible(rejectedRevision({ rejectedAt: anchored }), evaluated),
      true,
    );
    expectEligibility(
      revisionIsPurgeEligible(rejectedRevision({ rejectedAt: evaluated }), anchored),
      false,
    );
  });

  it("never produces a non-finite or fractional answer, only a boolean", () => {
    for (const evaluatedAt of [justBefore, boundary, justAfter]) {
      const result = listingIsPurgeEligible(rejectedListing(), evaluatedAt);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("boolean");
      }
    }
  });
});

describe("a record outside the rejected lifecycle is refused, never answered", () => {
  it.each(LISTING_STATUSES.filter((status) => status !== "rejected"))(
    "refuses a %s listing rather than reporting it ineligible",
    (status) => {
      const listing = rejectedListing({
        status,
        timestamps: { submittedAt: anchor, lastUpdatedAt: anchor },
        ...(status === "approved" ? { publication: { value: "publicly_available" } } : {}),
      });

      const result = listingIsPurgeEligible(listing, boundary);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "LISTING_NOT_REJECTED", status });
      }
    },
  );

  it.each(REVISION_STATES.filter((state) => state !== "rejected"))(
    "refuses a %s revision rather than reporting it ineligible",
    (state) => {
      const revision = rejectedRevision({ state, rejectedAt: undefined });
      const result = revisionIsPurgeEligible(revision, boundary);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "REVISION_NOT_REJECTED", state });
      }
    },
  );

  it("keeps the listing and revision refusals distinct from one another", () => {
    const listing = listingIsPurgeEligible(
      rejectedListing({
        status: "pending",
        timestamps: { submittedAt: anchor, lastUpdatedAt: anchor },
      }),
      boundary,
    );
    const revision = revisionIsPurgeEligible(
      rejectedRevision({ state: "pending", rejectedAt: undefined }),
      boundary,
    );

    expect(listing.ok).toBe(false);
    expect(revision.ok).toBe(false);
    if (!listing.ok && !revision.ok) {
      expect(listing.error.code).not.toBe(revision.error.code);
    }
  });
});

describe("a missing or malformed anchor is refused (ADR-017 Q-1/Q-2)", () => {
  it("refuses a rejected listing carrying no anchor", () => {
    const listing = rejectedListing({
      timestamps: { submittedAt: anchor, lastUpdatedAt: anchor },
    });

    const result = listingIsPurgeEligible(listing, boundary);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_MISSING" });
    }
  });

  it("refuses a rejected revision carrying no anchor", () => {
    const result = revisionIsPurgeEligible(
      rejectedRevision({ rejectedAt: undefined }),
      boundary,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "REJECTION_TIMESTAMP_MISSING" });
    }
  });

  it.each([null, 1_000, {}, [], "1970-01-01", { epochMilliseconds: 1.5 }])(
    "refuses %o as a listing anchor",
    (rejectedAt) => {
      const listing = rejectedListing({
        timestamps: {
          submittedAt: anchor,
          lastUpdatedAt: anchor,
          rejectedAt: rejectedAt as never,
        },
      });

      const result = listingIsPurgeEligible(listing, boundary);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INSTANT");
      }
    },
  );

  it.each([null, 1_000, {}, [], "1970-01-01", { epochMilliseconds: Number.NaN }])(
    "refuses %o as a revision anchor",
    (rejectedAt) => {
      const result = revisionIsPurgeEligible(
        rejectedRevision({ rejectedAt: rejectedAt as never }),
        boundary,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "INVALID_INSTANT", offered: rejectedAt });
      }
    },
  );
});

describe("a malformed evaluation instant is refused", () => {
  it.each([null, undefined, 1_000, {}, [], "now", { epochMilliseconds: "1000" }])(
    "refuses %o as the evaluation instant, for both record types",
    (evaluatedAt) => {
      for (const result of [
        listingIsPurgeEligible(rejectedListing(), evaluatedAt as never),
        revisionIsPurgeEligible(rejectedRevision(), evaluatedAt as never),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({ code: "INVALID_INSTANT", offered: evaluatedAt });
        }
      }
    },
  );
});

describe("malformed input is governed, never thrown", () => {
  it.each([null, undefined, [], "listing-1", 7, true])(
    "refuses %o as a listing",
    (listing) => {
      let result: ReturnType<typeof listingIsPurgeEligible> | undefined;

      expect(() => {
        result = listingIsPurgeEligible(listing as never, boundary);
      }).not.toThrow();

      expect(result?.ok).toBe(false);
      if (result !== undefined && !result.ok) {
        expect(result.error).toEqual({ code: "INVALID_LISTING", offered: listing });
      }
    },
  );

  it.each([null, undefined, [], "revision", 7, true])(
    "refuses %o as a revision",
    (revision) => {
      let result: ReturnType<typeof revisionIsPurgeEligible> | undefined;

      expect(() => {
        result = revisionIsPurgeEligible(revision as never, boundary);
      }).not.toThrow();

      expect(result?.ok).toBe(false);
      if (result !== undefined && !result.ok) {
        expect(result.error).toEqual({ code: "INVALID_REVISION", offered: revision });
      }
    },
  );

  it.each([undefined, null, "archived", 7])(
    "refuses %o as a listing status without reading further",
    (status) => {
      const result = listingIsPurgeEligible(
        rejectedListing({ status: status as never }),
        boundary,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "UNKNOWN_LISTING_STATUS", offered: status });
      }
    },
  );

  it.each([undefined, null, "purged", 7])(
    "refuses %o as a revision state as a shape defect",
    (state) => {
      const result = revisionIsPurgeEligible(
        rejectedRevision({ state: state as never }),
        boundary,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "INVALID_REVISION", offered: state });
      }
    },
  );

  it.each([null, undefined, 7, "timestamps"])(
    "refuses %o as a listing timestamp bundle",
    (timestamps) => {
      const result = listingIsPurgeEligible(
        rejectedListing({ timestamps: timestamps as never }),
        boundary,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["LISTING_TIMESTAMPS_MISSING", "INVALID_LISTING_TIMESTAMPS"]).toContain(
          result.error.code,
        );
      }
    },
  );

  it("throws for no malformed input at all", () => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      [],
      "x",
      7,
      { status: "rejected" },
      { status: "rejected", timestamps: null },
      { state: "rejected" },
    ];

    for (const candidate of malformed) {
      expect(() => listingIsPurgeEligible(candidate as never, boundary)).not.toThrow();
      expect(() => revisionIsPurgeEligible(candidate as never, boundary)).not.toThrow();
      expect(() => listingIsPurgeEligible(candidate as never, 7 as never)).not.toThrow();
      expect(() => revisionIsPurgeEligible(candidate as never, 7 as never)).not.toThrow();
    }
  });
});

describe("governed failures stay distinct from one another", () => {
  it("does not collapse unrelated defects into one code", () => {
    const codes = new Set<DomainError["code"]>();

    const failures: readonly ReturnType<typeof listingIsPurgeEligible>[] = [
      listingIsPurgeEligible(null as never, boundary),
      listingIsPurgeEligible(rejectedListing({ status: "archived" as never }), boundary),
      listingIsPurgeEligible(
        rejectedListing({
          status: "pending",
          timestamps: { submittedAt: anchor, lastUpdatedAt: anchor },
        }),
        boundary,
      ),
      listingIsPurgeEligible(
        rejectedListing({ timestamps: { submittedAt: anchor, lastUpdatedAt: anchor } }),
        boundary,
      ),
      listingIsPurgeEligible(rejectedListing(), 7 as never),
      revisionIsPurgeEligible(null as never, boundary),
      revisionIsPurgeEligible(
        rejectedRevision({ state: "approved", rejectedAt: undefined }),
        boundary,
      ),
    ];

    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        codes.add(failure.error.code);
      }
    }

    // Seven distinguishable defect families, and seven distinct codes.
    expect(codes.size).toBe(failures.length);
  });

  it("keeps the two revision shape defects distinguishable by what they carry", () => {
    // `INVALID_REVISION` covers both an unusable container and an unusable `state`, exactly
    // as it does for revision resolution (`P1` Slice D). One code is correct — they are the
    // same kind of defect — and the offending value is what tells a caller which it was.
    const notAnObject = revisionIsPurgeEligible(null as never, boundary);
    const unusableState = revisionIsPurgeEligible(
      rejectedRevision({ state: "purged" as never }),
      boundary,
    );

    expect(notAnObject.ok).toBe(false);
    expect(unusableState.ok).toBe(false);
    if (!notAnObject.ok && !unusableState.ok) {
      expect(notAnObject.error).toEqual({ code: "INVALID_REVISION", offered: null });
      expect(unusableState.error).toEqual({ code: "INVALID_REVISION", offered: "purged" });
      expect(notAnObject.error).not.toEqual(unusableState.error);
    }
  });
});

describe("eligibility is a query and changes nothing", () => {
  it.each([
    ["before the boundary", justBefore],
    ["at the boundary", boundary],
    ["after the boundary", justAfter],
  ] as const)("leaves a rejected listing deeply unchanged %s", (_label, evaluatedAt) => {
    const listing = rejectedListing();
    const before = structuredClone(listing);

    listingIsPurgeEligible(listing, evaluatedAt);

    expect(listing).toEqual(before);
    expect(listing.status).toBe("rejected");
    expect(listing.timestamps.rejectedAt).toEqual(anchor);
    expect(listing.timestamps.lastUpdatedAt).toEqual(anchor);
    expect(listing.publication).toBeUndefined();
  });

  it.each([
    ["before the boundary", justBefore],
    ["at the boundary", boundary],
    ["after the boundary", justAfter],
  ] as const)("leaves a rejected revision deeply unchanged %s", (_label, evaluatedAt) => {
    const revision = rejectedRevision();
    const before = structuredClone(revision);

    revisionIsPurgeEligible(revision, evaluatedAt);

    expect(revision).toEqual(before);
    expect(revision.state).toBe("rejected");
    expect(revision.rejectedAt).toEqual(anchor);
    expect(revision.proposedContent).toEqual(before.proposedContent);
  });

  it("leaves the supplied evaluation instant unchanged", () => {
    const evaluatedAt = instantAt(1_000 + RETENTION_PERIOD_MILLISECONDS);
    const before = structuredClone(evaluatedAt);

    listingIsPurgeEligible(rejectedListing(), evaluatedAt);
    revisionIsPurgeEligible(rejectedRevision(), evaluatedAt);

    expect(evaluatedAt).toEqual(before);
  });

  it("mutates nothing on any failure path", () => {
    const listing = rejectedListing();
    const revision = rejectedRevision();
    const listingBefore = structuredClone(listing);
    const revisionBefore = structuredClone(revision);

    for (const evaluatedAt of [null, undefined, 7, "now", {}]) {
      listingIsPurgeEligible(listing, evaluatedAt as never);
      revisionIsPurgeEligible(revision, evaluatedAt as never);
    }

    listingIsPurgeEligible(null as never, boundary);
    revisionIsPurgeEligible(null as never, boundary);

    expect(listing).toEqual(listingBefore);
    expect(revision).toEqual(revisionBefore);
  });

  it("removes no revision and returns no collection", () => {
    const revision = rejectedRevision();
    const result = revisionIsPurgeEligible(revision, justAfter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The answer is the eligibility and nothing else: no record, no collection, no
      // replacement value that a caller could mistake for a performed purge.
      expect(typeof result.value).toBe("boolean");
      expect(Object.keys(result).sort()).toEqual(["ok", "value"]);
    }
    expect(revision.state).toBe("rejected");
  });
});

describe("behavior does not depend on object-reference identity", () => {
  it("answers identically for a reconstructed listing", () => {
    const original = rejectedListing();
    const rebuilt = reconstructed(original);

    expect(rebuilt).not.toBe(original);
    expect(rebuilt.timestamps.rejectedAt).not.toBe(original.timestamps.rejectedAt);

    for (const evaluatedAt of [justBefore, boundary, justAfter]) {
      expect(listingIsPurgeEligible(rebuilt, evaluatedAt)).toEqual(
        listingIsPurgeEligible(original, evaluatedAt),
      );
    }
  });

  it("answers identically for a reconstructed revision", () => {
    const original = rejectedRevision();
    const rebuilt = reconstructed(original);

    expect(rebuilt).not.toBe(original);

    for (const evaluatedAt of [justBefore, boundary, justAfter]) {
      expect(revisionIsPurgeEligible(rebuilt, evaluatedAt)).toEqual(
        revisionIsPurgeEligible(original, evaluatedAt),
      );
    }
  });

  it("answers identically for a reconstructed evaluation instant", () => {
    expect(listingIsPurgeEligible(rejectedListing(), reconstructed(boundary))).toEqual(
      listingIsPurgeEligible(rejectedListing(), boundary),
    );
  });

  it("treats two separately built records with equal anchors identically", () => {
    const first = rejectedRevision();
    const second = rejectedRevision({
      proposedContent: { ...content, description: "Something else entirely." },
    });

    expect(revisionIsPurgeEligible(second, boundary)).toEqual(
      revisionIsPurgeEligible(first, boundary),
    );
  });
});

describe("no ambient clock is read", () => {
  it("cannot answer without the supplied instant, and consults no clock", () => {
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
      listingIsPurgeEligible(rejectedListing(), justBefore);
      listingIsPurgeEligible(rejectedListing(), boundary);
      revisionIsPurgeEligible(rejectedRevision(), justAfter);
      revisionIsPurgeEligible(rejectedRevision(), 7 as never);
      listingIsPurgeEligible(null as never, boundary);
    } finally {
      Date.now = realNow;
      globalThis.Date = realDate;
    }

    expect(consulted).toBe(false);
  });

  it("gives the same answer however often it is asked", () => {
    const listing = rejectedListing();

    expect(listingIsPurgeEligible(listing, boundary)).toEqual(
      listingIsPurgeEligible(listing, boundary),
    );
    expect(listingIsPurgeEligible(listing, justBefore)).toEqual(
      listingIsPurgeEligible(listing, justBefore),
    );
  });
});
