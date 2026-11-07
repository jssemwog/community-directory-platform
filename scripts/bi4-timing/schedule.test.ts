/**
 * The `BI-4` timing pilot's seeded schedule (issue #246; harness gate revision 5 §4, §5.2, §5.4):
 * determinism, balance, disjoint never-existed subsets, malformed shape and route-neutrality, the
 * approved full-pilot counts, and smoke schedules that fit inside their caps.
 */

import { describe, expect, it } from "vitest";

import {
  buildPlan,
  calibrationConditions,
  CANONICAL_UUID,
  COMPARISONS,
  countsOf,
  SeededRandom,
  seededMalformed,
  SMOKE_CAPS,
  validateDelays,
  type Boundary,
  type Plan,
  type PlanRequest,
} from "./schedule";

/** Arbitrary test delays; the real ones are chosen at run authorization (`H-D3`). */
const DELAYS = [11_000, 37_000, 123_000];

function plan(boundary: Boundary, overrides: Partial<PlanRequest> = {}): Plan {
  return buildPlan({ boundary, mode: "full", seed: "schedule-test", delaysNs: DELAYS, background: 7, ...overrides });
}

/** The OP-2 shape check, verbatim from `src/data/public-listing-read.ts`. */
const OP2_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("determinism", () => {
  it("builds the identical plan from the same seed and delays", () => {
    expect(plan("e1")).toEqual(plan("e1"));
    expect(plan("e2")).toEqual(plan("e2"));
  });

  it("builds a different plan from a different seed", () => {
    const a = plan("e2");
    const b = plan("e2", { seed: "another-seed" });

    expect(a.identities.map((identity) => identity.key)).not.toEqual(b.identities.map((identity) => identity.key));
    expect(a.requests.map((request) => request.identity)).not.toEqual(b.requests.map((request) => request.identity));
  });

  it("draws the same sequence from the same seed and stream, and a different one from another stream", () => {
    const first = new SeededRandom("s", "x");
    const second = new SeededRandom("s", "x");
    const other = new SeededRandom("s", "y");
    const draw = (random: SeededRandom): number[] => Array.from({ length: 8 }, () => random.nextUint32());

    expect(draw(first)).toEqual(draw(second));
    expect(draw(new SeededRandom("s", "x"))).not.toEqual(draw(other));
  });
});

describe("explicit inputs with no defaults", () => {
  it("refuses anything but three distinct positive integer delays", () => {
    expect(() => validateDelays([])).toThrow(/exactly 3/);
    expect(() => validateDelays([1, 2])).toThrow(/exactly 3/);
    expect(() => validateDelays([1, 2, 3, 4])).toThrow(/exactly 3/);
    expect(() => validateDelays([1, 2, 0])).toThrow(/positive integer/);
    expect(() => validateDelays([1, 2, 2.5])).toThrow(/positive integer/);
    expect(() => validateDelays([5, 5, 6])).toThrow(/distinct/);
    expect(validateDelays(DELAYS)).toEqual(DELAYS);
  });

  it("refuses an empty seed and a negative or fractional background size", () => {
    expect(() => plan("e1", { seed: " " })).toThrow(/seed/);
    expect(() => plan("e1", { background: -1 })).toThrow(/background/);
    expect(() => plan("e1", { background: 1.5 })).toThrow(/background/);
  });
});

describe("the full-pilot counts (H-D2)", () => {
  it("plans 29,040 E1 requests: 12,000 test, 4,000 null, 6,000 delay, 2,000 malformed, 5,040 warm-up", () => {
    const counts = countsOf(plan("e1"));
    const measured = counts.measuredByClass;

    expect(counts.total).toBe(29_040);
    expect((measured.NE ?? 0) + (measured.PE ?? 0) + (measured.RJ ?? 0) + (measured.UP ?? 0)).toBe(12_000);
    expect((measured.NCA ?? 0) + (measured.NCB ?? 0)).toBe(4_000);
    expect(measured.DL).toBe(6_000);
    expect(measured.MF).toBe(2_000);
    expect(counts.byPhase.probe + counts.byPhase.warmup).toBe(5_040);
    expect(counts.byPhase.compile).toBe(0);
    expect(counts.byTarget).toEqual({ operation: 29_040, next: 0, calibration: 0 });
  });

  it("plans 38,730 E2 requests: 21,790 to next dev and 16,940 to calibration, with 6,730 warm-up", () => {
    const counts = countsOf(plan("e2"));
    const measured = counts.measuredByClass;

    expect(counts.total).toBe(38_730);
    expect(counts.byTarget).toEqual({ operation: 0, next: 21_790, calibration: 16_940 });
    expect((measured.NE ?? 0) + (measured.PE ?? 0) + (measured.RJ ?? 0) + (measured.UP ?? 0)).toBe(12_000);
    expect((measured.NCA ?? 0) + (measured.NCB ?? 0)).toBe(4_000);
    expect(measured.MF).toBe(2_000);
    expect(measured.CAL).toBe(14_000);
    expect(counts.byPhase.compile + counts.byPhase.probe + counts.byPhase.warmup).toBe(6_730);
    expect(counts.byPhase.compile).toBe(10);
  });

  it("totals 135,540 requests over two replicates of each boundary", () => {
    expect(2 * countsOf(plan("e1")).total + 2 * countsOf(plan("e2")).total).toBe(135_540);
  });
});

describe("balance and disjoint never-existed subsets", () => {
  for (const boundary of ["e1", "e2"] as const) {
    it(`${boundary}: gives every comparison 20 NE and 20 non-public identities, with disjoint NE subsets`, () => {
      const built = plan(boundary);
      const seen = new Set<string>();

      for (const comparison of COMPARISONS) {
        const subset = built.identities.filter((identity) => identity.cls === "NE" && identity.comparison === comparison);

        expect(subset).toHaveLength(20);

        for (const identity of subset) {
          expect(seen.has(identity.key)).toBe(false);
          seen.add(identity.key);
        }
      }

      for (const cls of ["PE", "RJ", "UP", "NCA", "NCB", "MF"] as const) {
        expect(built.identities.filter((identity) => identity.cls === cls)).toHaveLength(20);
      }
    });

    it(`${boundary}: sends every measured identity exactly once per block, R = 100 times in all`, () => {
      const built = plan(boundary);
      const perIdentity = new Map<number, number[]>();

      for (const request of built.requests.filter((entry) => entry.phase === "measured")) {
        perIdentity.set(request.identity, [...(perIdentity.get(request.identity) ?? []), request.block]);
      }

      const members = built.identities.filter((identity) => identity.cls !== "CMP");

      expect(perIdentity.size).toBe(members.length);

      for (const blocks of perIdentity.values()) {
        expect(blocks).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      }
    });
  }

  it("keeps every UUID key distinct across classes, the background and the compile identity", () => {
    const built = plan("e2", { background: 50 });
    const keys = [...built.identities.map((identity) => identity.key), ...built.background];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("interleaves classes inside blocks rather than grouping them", () => {
    const built = plan("e1");
    const firstBlock = built.requests.filter((request) => request.phase === "measured" && request.block === 1);
    const classes = firstBlock.map((request) => built.identities[request.identity]?.cls);
    let runs = 1;

    for (let i = 1; i < classes.length; i += 1) {
      if (classes[i] !== classes[i - 1]) runs += 1;
    }

    expect(runs).toBeGreaterThan(100);
  });

  it("assigns E2 calibration a baseline plus each delay before the first and the final chunk", () => {
    const built = plan("e2");
    const byCondition = new Map<number, number>();

    for (const identity of built.identities.filter((entry) => entry.cls === "CAL")) {
      byCondition.set(identity.condition as number, (byCondition.get(identity.condition as number) ?? 0) + 1);
    }

    expect([...byCondition.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...byCondition.values()].every((count) => count === 20)).toBe(true);
    expect(calibrationConditions(DELAYS).map((entry) => entry.placement)).toEqual([
      "none",
      "first",
      "first",
      "first",
      "final",
      "final",
      "final",
    ]);
  });
});

describe("identity shapes", () => {
  it("draws canonical lower-case UUID v4 keys for every non-malformed identity", () => {
    for (const identity of plan("e2").identities.filter((entry) => entry.cls !== "MF")) {
      expect(identity.key).toMatch(CANONICAL_UUID);
      expect(identity.key[14]).toBe("4");
      expect("89ab").toContain(identity.key[19]);
    }
  });

  it("builds malformed strings that are never UUID-shaped, need no escaping, and stay on the detail route", () => {
    const random = new SeededRandom("malformed-test", "malformed");

    for (let i = 0; i < 500; i += 1) {
      const value = seededMalformed(random);

      expect(value).toHaveLength(36);
      expect(value).toMatch(/^[g-z]{8}-[g-z]{4}-[g-z]{4}-[g-z]{4}-[g-z]{12}$/);
      expect(OP2_UUID_SHAPE.test(value)).toBe(false);
      expect(encodeURIComponent(value)).toBe(value);
      expect(value).not.toMatch(/[/.%?]/);
    }
  });
});

describe("smoke schedules (H-D15)", () => {
  it("plans 40 measured and 16 warm-up E1 requests per pass, 168 for three passes, within the 200 cap", () => {
    const counts = countsOf(buildPlan({ boundary: "e1", mode: "smoke", seed: "s", delaysNs: DELAYS, background: 0 }));

    expect(counts.byPhase.measured).toBe(40);
    expect(counts.byPhase.probe + counts.byPhase.warmup).toBe(16);
    expect(Object.values(counts.identitiesByClass).reduce((sum, count) => sum + (count ?? 0), 0)).toBe(8);
    expect(3 * counts.total).toBe(168);
    expect(3 * counts.total).toBeLessThanOrEqual(SMOKE_CAPS.e1.requests);
  });

  it("plans 50 measured and 23 warm-up E2 requests per pass, 219 for three passes, within the 250 cap", () => {
    const built = buildPlan({ boundary: "e2", mode: "smoke", seed: "s", delaysNs: DELAYS, background: 0 });
    const counts = countsOf(built);

    expect(counts.byPhase.measured).toBe(50);
    expect(counts.byPhase.compile + counts.byPhase.probe + counts.byPhase.warmup).toBe(23);
    expect(counts.identitiesByClass.CAL).toBe(3);
    expect(built.identities.filter((identity) => identity.cls === "CAL").map((identity) => identity.placement).sort()).toEqual([
      "final",
      "first",
      "none",
    ]);
    expect(3 * counts.total).toBe(219);
    expect(3 * counts.total).toBeLessThanOrEqual(SMOKE_CAPS.e2.requests);
  });
});
