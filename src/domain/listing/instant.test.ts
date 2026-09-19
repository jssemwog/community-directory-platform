/**
 * Attacking tests for the logical instant (`P1` Slice C, issue #141).
 *
 * Each test attempts the violation and fails to achieve it — "the test passes" is not the
 * standard (`docs/12` *Definition of done*, condition 3).
 *
 * Under attack: that a moment is validated before it is trusted, that comparison is
 * **strict**, that an instant cannot be moved after it is made, and that the domain reads
 * no clock of its own (`DI-2`, `ADR-002` `O-11`, ruling 11).
 */
import { describe, expect, it } from "vitest";

import * as instantModule from "./instant";
import {
  instantEquals,
  instantIsAfter,
  instantOf,
  isInstant,
  type Instant,
} from "./instant";

function at(epochMilliseconds: number): Instant {
  const result = instantOf(epochMilliseconds);
  if (!result.ok) {
    throw new Error("fixture instant is invalid");
  }
  return result.value;
}

describe("accepting a supplied moment", () => {
  it("accepts an ordinary integer count of milliseconds", () => {
    const result = instantOf(1_700_000_000_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isInstant(result.value)).toBe(true);
    }
  });

  it("accepts zero and negative counts — no era or calendar bound is invented", () => {
    for (const offered of [0, -1, -1_000_000]) {
      expect(instantOf(offered).ok).toBe(true);
    }
  });

  it.each([
    ["a string", "2026-09-19T00:00:00Z"],
    ["a numeric string", "1700000000000"],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["a fractional value", 1_000.5],
    ["a value beyond exact integer range", Number.MAX_SAFE_INTEGER + 2],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an object", {}],
    ["an array", [1_000]],
    ["a Date", new Date(0)],
  ])("refuses %s as a value, without throwing", (_label, offered) => {
    expect(() => instantOf(offered)).not.toThrow();

    const result = instantOf(offered);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "INVALID_INSTANT", offered });
    }
  });

  it("refuses a raw number at the guard — only a validated instant is an instant", () => {
    expect(isInstant(1_000)).toBe(false);
    expect(isInstant({ epochMilliseconds: "1000" })).toBe(false);
    expect(isInstant({ epochMilliseconds: 1_000.5 })).toBe(false);
    expect(isInstant(null)).toBe(false);
    expect(isInstant([])).toBe(false);
    expect(isInstant(undefined)).toBe(false);
  });
});

describe("comparison is strict (ruling 3)", () => {
  it("reports a later moment as later", () => {
    expect(instantIsAfter(at(2_000), at(1_000))).toBe(true);
  });

  it("does not report an equal moment as later — the whole point of criterion 9", () => {
    expect(instantIsAfter(at(1_000), at(1_000))).toBe(false);
  });

  it("does not report an earlier moment as later", () => {
    expect(instantIsAfter(at(999), at(1_000))).toBe(false);
  });

  it("is irreflexive for every moment tried", () => {
    for (const value of [-1, 0, 1, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(instantIsAfter(at(value), at(value))).toBe(false);
    }
  });

  it("distinguishes adjacent milliseconds rather than rounding them together", () => {
    expect(instantIsAfter(at(1_001), at(1_000))).toBe(true);
    expect(instantEquals(at(1_001), at(1_000))).toBe(false);
  });

  it("treats separately constructed occurrences of one moment as equal", () => {
    expect(instantEquals(at(1_000), at(1_000))).toBe(true);
  });
});

describe("an instant cannot be moved after it is made", () => {
  it("refuses in-place edits of the value it carries", () => {
    const instant = at(1_000);
    const mutable = instant as unknown as { epochMilliseconds: number };

    // Whether the assignment throws or is silently discarded is the module system's
    // business; what is asserted is that it never takes effect.
    try {
      mutable.epochMilliseconds = 9_999;
    } catch {
      // A frozen object under strict mode refuses the write loudly; either way the
      // moment below is unchanged.
    }

    expect(instantEquals(instant, at(1_000))).toBe(true);
  });

  it("is frozen, so no property can be added to it either", () => {
    expect(Object.isFrozen(at(1_000))).toBe(true);
  });
});

describe("the domain reads no ambient clock (ruling 11)", () => {
  it("returns the same instant for the same input, however often it is asked", () => {
    const first = instantOf(1_000);
    const second = instantOf(1_000);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(instantEquals(first.value, second.value)).toBe(true);
    }
  });

  it("offers no generator — nothing here produces a moment that was not supplied", () => {
    expect(Object.keys(instantModule).sort()).toEqual([
      "instantEquals",
      "instantIsAfter",
      "instantOf",
      "isInstant",
    ]);
  });
});
