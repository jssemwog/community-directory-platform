/**
 * Attacking tests for the `timestamptz` boundary parser (issue #173).
 *
 * These are the no-database half: the grammar, the arithmetic, the disclosed narrowing and
 * the refusals. The live-driver half is `timestamp-parser.integration.test.ts`, which
 * proves the same contract through real `pg` against a real server — these two are
 * complements, and neither substitutes for the other.
 *
 * Every refusal is attacked by **attempting** the violation and asserting the stable
 * `reason`, not merely that something threw: a test that accepts any error would pass
 * against a parser that refused everything.
 */
import { describe, expect, it } from "vitest";

import {
  createTimestamptzTypeOverrides,
  parseTimestamptz,
  TIMESTAMPTZ_OID,
  TimestamptzParseError,
  type TimestamptzParseFailure,
} from "./timestamp-parser";

/** Assert the parser refuses `value`, and refuses it for the stated reason. */
function expectRefusal(value: unknown, reason: TimestamptzParseFailure): void {
  let caught: unknown;

  try {
    (parseTimestamptz as (candidate: unknown) => unknown)(value);
  } catch (error) {
    caught = error;
  }

  expect(caught, `expected ${String(value)} to be refused`).toBeInstanceOf(
    TimestamptzParseError,
  );
  expect((caught as TimestamptzParseError).reason, String(value)).toBe(reason);
  expect((caught as TimestamptzParseError).offendingValue).toBe(String(value));
}

describe("ordinary instants", () => {
  it("parses a UTC instant with milliseconds", () => {
    expect(parseTimestamptz("2026-01-02 03:04:05.123+00")).toBe(1_767_323_045_123);
  });

  it("parses the epoch itself", () => {
    expect(parseTimestamptz("1970-01-01 00:00:00+00")).toBe(0);
  });

  it("uses PostgreSQL's space separator, not an ISO-8601 T", () => {
    expect(parseTimestamptz("2026-01-02 03:04:05.123+00")).toBe(1_767_323_045_123);
    expectRefusal("2026-01-02T03:04:05.123+00", "MALFORMED");
  });

  it("returns a plain safe-integer number, never a Date or an Instant", () => {
    const parsed = parseTimestamptz("2026-01-02 03:04:05.123+00");

    expect(typeof parsed).toBe("number");
    expect(Number.isSafeInteger(parsed)).toBe(true);
    expect(parsed).not.toBeInstanceOf(Date);
  });

  it("passes a null through, because a nullable column yields one", () => {
    expect(parseTimestamptz(null)).toBeNull();
  });
});

describe("offsets", () => {
  // 2026-01-01T21:34:05.123Z, rendered from four sessions whose zones differ.
  const sameInstant = 1_767_303_245_123;

  it.each([
    ["2026-01-01 21:34:05.123+00", "UTC"],
    ["2026-01-02 03:04:05.123+05:30", "positive, with minutes"],
    ["2026-01-01 13:34:05.123-08", "negative, two-digit"],
    ["2026-01-01 22:34:05.123+01", "positive, two-digit"],
  ])("resolves %s (%s) to the same instant", (text) => {
    expect(parseTimestamptz(text)).toBe(sameInstant);
  });

  it("treats a positive offset as local-ahead-of-UTC", () => {
    expect(parseTimestamptz("2026-01-01 01:00:00+01")).toBe(
      parseTimestamptz("2026-01-01 00:00:00+00"),
    );
  });

  it("treats a negative offset as local-behind-UTC", () => {
    expect(parseTimestamptz("2025-12-31 23:00:00-01")).toBe(
      parseTimestamptz("2026-01-01 00:00:00+00"),
    );
  });

  it("refuses an offset beyond PostgreSQL's ±15:59 range", () => {
    expectRefusal("2026-01-02 03:04:05+16", "CALENDAR_FIELD_OUT_OF_RANGE");
    expectRefusal("2026-01-02 03:04:05+10:60", "CALENDAR_FIELD_OUT_OF_RANGE");
  });
});

describe("DST boundaries", () => {
  /**
   * A DST transition changes the *offset PostgreSQL renders*, never the instant. These are
   * the two sides of the 2026 US spring-forward in `America/New_York`: 06:59:59Z is still
   * `-05`, and 07:00:00Z is already `-04`.
   */
  it("parses both sides of a spring-forward transition to the right instants", () => {
    const beforeTransition = parseTimestamptz("2026-03-08 01:59:59.999-05");
    const afterTransition = parseTimestamptz("2026-03-08 03:00:00.000-04");

    expect(afterTransition - beforeTransition).toBe(1);
  });

  it("parses both sides of a fall-back transition, where local time repeats", () => {
    // 2026-11-01 01:30 local occurs twice; the offset is what distinguishes them.
    const firstPass = parseTimestamptz("2026-11-01 01:30:00-04");
    const secondPass = parseTimestamptz("2026-11-01 01:30:00-05");

    expect(secondPass - firstPass).toBe(3_600_000);
  });
});

describe("fractional seconds", () => {
  it.each([
    ["2026-01-02 03:04:05+00", 0],
    ["2026-01-02 03:04:05.1+00", 100],
    ["2026-01-02 03:04:05.12+00", 120],
    ["2026-01-02 03:04:05.123+00", 123],
  ])("reads %s as +%ims", (text, expectedMilliseconds) => {
    const whole = parseTimestamptz("2026-01-02 03:04:05+00");

    expect(parseTimestamptz(text) - whole).toBe(expectedMilliseconds);
  });

  it("preserves an exact millisecond rather than approximating it", () => {
    expect(parseTimestamptz("2026-01-02 03:04:05.001+00") % 1000).toBe(1);
    expect(parseTimestamptz("2026-01-02 03:04:05.999+00") % 1000).toBe(999);
  });

  it.each([
    "2026-01-02 03:04:05.1234+00",
    "2026-01-02 03:04:05.123456+00",
    "2026-01-02 03:04:05.000001+00",
  ])("refuses %s rather than rounding it", (text) => {
    expectRefusal(text, "SUB_MILLISECOND_PRECISION");
  });
});

describe("pre-epoch values", () => {
  it("admits a pre-epoch instant, and does not refuse it for its sign", () => {
    expect(parseTimestamptz("1900-01-01 00:00:00+00")).toBe(-2_208_988_800_000);
  });

  it("admits a pre-epoch instant with milliseconds", () => {
    expect(parseTimestamptz("1899-12-31 23:59:59.877+00")).toBe(-2_208_988_800_123);
  });

  it("admits the first representable AD instant", () => {
    expect(parseTimestamptz("0001-01-01 00:00:00+00")).toBe(-62_135_596_800_000);
  });
});

describe("the disclosed narrowing", () => {
  it("refuses BC-era text explicitly, naming the era as the reason", () => {
    expectRefusal("0044-03-15 12:00:00-04:56:02 BC", "BC_ERA");
    expectRefusal("0001-01-01 00:00:00+00 BC", "BC_ERA");
  });

  it("refuses an offset carrying seconds explicitly, even in an AD instant", () => {
    expectRefusal("1883-11-18 12:00:00-04:56:02", "OFFSET_HAS_SECONDS");
  });

  it("never represents a rejected form as an approximate or rounded instant", () => {
    // The refusal must be a throw, not a nearby number.
    expect(() => parseTimestamptz("0044-03-15 12:00:00-04:56:02 BC")).toThrow(
      TimestamptzParseError,
    );
    expect(() => parseTimestamptz("1883-11-18 12:00:00-04:56:02")).toThrow(
      TimestamptzParseError,
    );
  });
});

describe("infinite and non-finite values", () => {
  it.each(["infinity", "-infinity"])("refuses %s", (text) => {
    expectRefusal(text, "INFINITE");
  });

  it("refuses a non-string input rather than coercing it", () => {
    expectRefusal(Number.NaN, "NOT_A_STRING");
    expectRefusal(Number.POSITIVE_INFINITY, "NOT_A_STRING");
    expectRefusal(1_767_323_045_123, "NOT_A_STRING");
    expectRefusal(undefined, "NOT_A_STRING");
  });
});

describe("malformed and offset-free input", () => {
  it.each([
    "",
    "   ",
    "not a timestamp",
    "2026-01-02",
    "2026-01-02 03:04:05",
    "2026-01-02 03:04+00",
    "2026-1-2 3:4:5+00",
    "2026-01-02 03:04:05.+00",
    "2026-01-02 03:04:05+0",
    "2026-01-02 03:04:05 +00",
    "  2026-01-02 03:04:05+00",
    "2026-01-02 03:04:05+00  ",
  ])("refuses %o", (text) => {
    expectRefusal(text, "MALFORMED");
  });

  it("refuses an offset-free value, because the offset must be honoured not assumed", () => {
    expectRefusal("2026-01-02 03:04:05.123", "MALFORMED");
  });

  it("refuses a timezone abbreviation, including the DateStyle=SQL,MDY form", () => {
    // Probed from a real server under `set datestyle to 'SQL, MDY'`.
    expectRefusal("01/01/2026 19:04:05.123 PST", "MALFORMED");
    expectRefusal("2026-01-02 03:04:05.123 UTC", "MALFORMED");
    expectRefusal("2026-01-02 03:04:05.123 PST", "MALFORMED");
  });

  it("refuses a value with trailing content after a valid prefix", () => {
    expectRefusal("2026-01-02 03:04:05.123+00 extra", "MALFORMED");
  });
});

describe("calendar validity", () => {
  it.each([
    "2026-02-30 00:00:00+00",
    "2026-13-01 00:00:00+00",
    "2026-00-01 00:00:00+00",
    "2026-01-00 00:00:00+00",
    "2026-01-32 00:00:00+00",
    "2026-01-02 24:00:00+00",
    "2026-01-02 03:60:00+00",
    "2026-01-02 03:04:60+00",
    "0000-01-01 00:00:00+00",
  ])("refuses the impossible date or time %s", (text) => {
    expectRefusal(text, "CALENDAR_FIELD_OUT_OF_RANGE");
  });

  it("accepts a leap day in a leap year and refuses it otherwise", () => {
    expect(parseTimestamptz("2028-02-29 00:00:00+00")).toBeTypeOf("number");
    expectRefusal("2027-02-29 00:00:00+00", "CALENDAR_FIELD_OUT_OF_RANGE");
  });

  it("applies the century rule for leap years", () => {
    expect(parseTimestamptz("2000-02-29 00:00:00+00")).toBeTypeOf("number");
    expectRefusal("1900-02-29 00:00:00+00", "CALENDAR_FIELD_OUT_OF_RANGE");
  });
});

describe("the governed admissible range", () => {
  /**
   * `ADR-022` records that the admissible range is the **intersection** of the layers a
   * value crosses, and that a safe integer is not automatically representable. This module
   * crosses no `Date`, so `Date`'s narrower ±8.64e15 ms bound does not apply — the binding
   * bound is the domain carrier's `Number.isSafeInteger`. These tests verify the
   * intersection rather than asserting that any one system's range contains another.
   */
  it("accepts an instant just inside the safe-integer bound", () => {
    // 275760-09-13 is inside Number.MAX_SAFE_INTEGER milliseconds of the epoch.
    const parsed = parseTimestamptz("275760-09-13 00:00:00+00");

    expect(Number.isSafeInteger(parsed)).toBe(true);
  });

  it("refuses an instant beyond the safe-integer bound", () => {
    expectRefusal("400000-01-01 00:00:00+00", "NOT_A_SAFE_INTEGER");
  });

  it("accepts a far-past AD instant that remains a safe integer", () => {
    expect(Number.isSafeInteger(parseTimestamptz("0001-01-01 00:00:00+00"))).toBe(true);
  });

  it("returns only safe integers for every accepted value", () => {
    const accepted = [
      "1970-01-01 00:00:00+00",
      "0001-01-01 00:00:00+00",
      "2026-01-02 03:04:05.123+05:30",
      "1899-12-31 23:59:59.877-08",
      "275760-09-13 00:00:00+00",
    ];

    for (const text of accepted) {
      expect(Number.isSafeInteger(parseTimestamptz(text)), text).toBe(true);
    }
  });
});

describe("ambient independence", () => {
  const reference = "2026-01-02 03:04:05.123+05:30";
  const expected = 1_767_303_245_123;

  it("is unaffected by the host time zone", () => {
    const original = process.env.TZ;

    try {
      for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = zone;
        expect(parseTimestamptz(reference), zone).toBe(expected);
      }
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
  });

  it("is unaffected by the locale", () => {
    const original = process.env.LANG;

    try {
      for (const locale of ["C", "en_US.UTF-8", "de_DE.UTF-8", "ar_EG.UTF-8"]) {
        process.env.LANG = locale;
        expect(parseTimestamptz(reference), locale).toBe(expected);
      }
    } finally {
      if (original === undefined) {
        delete process.env.LANG;
      } else {
        process.env.LANG = original;
      }
    }
  });

  it("consults no clock, so repeated parses are identical", () => {
    const first = parseTimestamptz(reference);
    const second = parseTimestamptz(reference);

    expect(first).toBe(second);
    expect(first).toBe(expected);
  });

  it("constructs no Date, so no Date-shaped value can escape", () => {
    const source = parseTimestamptz.toString() + createTimestamptzTypeOverrides.toString();

    expect(source).not.toMatch(/new Date|Date\.parse|Date\.UTC|Date\.now/);
  });
});

describe("the pg type-override configuration", () => {
  it("targets the timestamptz OID, and that OID is 1184", () => {
    expect(TIMESTAMPTZ_OID).toBe(1184);
  });

  it("installs the parser for timestamptz in text mode", () => {
    const overrides = createTimestamptzTypeOverrides();
    const parser = overrides.getTypeParser(TIMESTAMPTZ_OID, "text");

    expect(parser("2026-01-02 03:04:05.123+00")).toBe(1_767_323_045_123);
  });

  it("overrides only that OID, leaving timestamp and arrays untouched", () => {
    const overrides = createTimestamptzTypeOverrides();
    const ours = overrides.getTypeParser(TIMESTAMPTZ_OID, "text");

    // 1114 = timestamp without time zone; 1185 = timestamptz[]. Neither is governed here.
    expect(overrides.getTypeParser(1114, "text")).not.toBe(ours);
    expect(overrides.getTypeParser(1185, "text")).not.toBe(ours);
  });

  it("mutates no process-global pg parser registry", async () => {
    const pgTypes = (await import("pg-types")) as unknown as {
      getTypeParser: (oid: number, format: string) => (value: string) => unknown;
    };
    const before = pgTypes.getTypeParser(TIMESTAMPTZ_OID, "text");

    createTimestamptzTypeOverrides();

    const after = pgTypes.getTypeParser(TIMESTAMPTZ_OID, "text");

    expect(after).toBe(before);
    // The global default still produces a Date; that is precisely why an explicit
    // override is required rather than relied upon.
    expect(after("2026-01-02 03:04:05.123+00")).toBeInstanceOf(Date);
  });

  it("returns an independent registry on each call", () => {
    expect(createTimestamptzTypeOverrides()).not.toBe(createTimestamptzTypeOverrides());
  });

  it("creates no connection and reads no credential when the module is imported", async () => {
    // A fresh import must complete without a server, an environment variable or a
    // credential — which it does, or this file could not have loaded at all.
    const reimported = await import("./timestamp-parser");

    expect(typeof reimported.parseTimestamptz).toBe("function");
    expect(typeof reimported.createTimestamptzTypeOverrides).toBe("function");
  });
});
