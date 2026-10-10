/**
 * `C9` boundary — PostgreSQL `timestamptz` text to the domain's epoch-millisecond carrier
 * (issue #173, implementing `Accepted` `ADR-022`).
 *
 * **This is a boundary mechanism, not a domain service.** It exists because `ADR-022`
 * requires *"an explicit, repository-owned and tested `pg` timestamp parser"* with **no
 * reliance on the driver's default `Date` conversion** — `pg-types` registers `parseDate`
 * for OID `1184`, so without this every read would hand the domain a JavaScript `Date`,
 * which decision 8 forbids and which `instant.ts` refused because *"a `Date` is mutable"*
 * and *"carries formatting and time-zone behaviour this slice has no business owning"*.
 *
 * **No `Date` is constructed anywhere in this module.** The conversion is arithmetic over
 * the proleptic Gregorian calendar, so there is no object to leak, no local-timezone
 * interpretation to get wrong, and nothing whose own range silently narrows the governed
 * one. That also makes the result independent of the host time zone, the session
 * `TimeZone` beyond the offset carried in the text, daylight-saving rules, the locale and
 * any clock — none of which is consulted.
 *
 * **Importing this module does nothing.** It opens no connection, reads no environment
 * variable or credential, mutates no `pg` global, and constructs no `Pool` or `Client`.
 * `createTimestamptzTypeOverrides` must be called and its value passed explicitly to a
 * future `C9` pool, which is deliberately not built here.
 *
 * ## The grammar this accepts, and why it is this one
 *
 * The parser receives **exactly the text PostgreSQL sends**, which under the default
 * `DateStyle = ISO` is:
 *
 * ```
 * YYYY-MM-DD HH:MM:SS[.f[f[f]]]±HH[:MM]
 * ```
 *
 * Determined empirically against a real server, not assumed: the separator is a **space,
 * not `T`**; the offset is rendered **`+00`**, **`-08`** or **`+05:30`**; the **fractional
 * part is absent entirely when zero**; and the **rendered offset follows the session
 * `TimeZone`**, so one instant arrives as different text in different sessions — which is
 * exactly why decision 10 requires the offset to be honoured rather than assumed.
 *
 * ## The deliberate, disclosed narrowing
 *
 * **BC-era text and offsets carrying seconds are rejected** (Product Owner ruling on issue
 * #173). PostgreSQL emits both — `0044-03-15 12:00:00-04:56:02 BC` is a real value — and
 * both are *representable* within `ADR-022`'s governed intersection, so declining them
 * narrows this boundary's range relative to PostgreSQL's.
 *
 * **That narrowing is intentional and disclosed, never silent.** It is acceptable because
 * all four governed data are **system-set operational instants** — `submitted_at` at
 * submission, `last_updated_at` on each change, and the two write-once rejection anchors —
 * so no valid application path can produce a BC-era value or a historical sub-minute
 * offset. It is a statement about **this boundary**, not about PostgreSQL's capabilities,
 * and each form is detected deterministically and rejected with its own reason code rather
 * than being coerced into an approximate instant.
 *
 * ## A consequence worth knowing before writing a query
 *
 * The four governed columns are `timestamptz(3)`, so their values always arrive at
 * millisecond resolution. **A bare `timestamptz` expression does not** — `now()` renders as
 * `2026-10-10 11:52:52.613844-04`, with microseconds, and this parser **refuses it** as
 * `SUB_MILLISECOND_PRECISION` rather than rounding, exactly as `ADR-022` decision 15
 * requires. That is the intended behaviour, not a limitation to work around: a later `C9`
 * query that selects such an expression must cast it — `now()::timestamptz(3)` — so the
 * truncation is **deliberate and visible in the SQL** rather than silent in the adapter.
 *
 * ## A `C9` obligation this module cannot discharge
 *
 * The grammar above holds under `DateStyle = ISO`. Under `DateStyle = 'SQL, MDY'` the same
 * instant arrives as `01/01/2026 19:04:05.123 PST` — a timezone **abbreviation with no
 * numeric offset** — which this parser **rejects**, loudly, rather than guessing a zone.
 * **Pinning `DateStyle` to `ISO` on the connection is a `C9` connection-configuration
 * obligation and is deferred**, because connection configuration is not this unit's to
 * make. It is recorded here so that it is found by reading the parser rather than by
 * reading production logs.
 */
import { createRequire } from "node:module";

/** The PostgreSQL OID of `timestamp with time zone`. The only type this unit overrides. */
export const TIMESTAMPTZ_OID = 1184;

/** Why a value was refused. Stable, so tests and callers can assert the reason. */
export type TimestamptzParseFailure =
  | "NOT_A_STRING"
  | "MALFORMED"
  | "INFINITE"
  | "BC_ERA"
  | "OFFSET_HAS_SECONDS"
  | "SUB_MILLISECOND_PRECISION"
  | "CALENDAR_FIELD_OUT_OF_RANGE"
  | "NOT_A_SAFE_INTEGER";

/**
 * Refusal of a `timestamptz` value, carrying a stable `reason`.
 *
 * A `pg` type parser is invoked by the driver and can only signal failure by throwing, so
 * this is thrown rather than returned — unlike the domain, which reports governed failures
 * as values. The message includes the offending text because diagnosing a boundary refusal
 * without it is guesswork; the text is a timestamp and carries no credential.
 */
export class TimestamptzParseError extends Error {
  readonly reason: TimestamptzParseFailure;
  readonly offendingValue: string;

  constructor(reason: TimestamptzParseFailure, offendingValue: string) {
    super(`Refused PostgreSQL timestamptz value (${reason}): ${offendingValue}`);
    this.name = "TimestamptzParseError";
    this.reason = reason;
    this.offendingValue = offendingValue;
  }
}

/**
 * `YYYY-MM-DD HH:MM:SS[.fraction]±HH[:MM[:SS]]`, with the parts this unit must inspect
 * captured rather than merely matched.
 *
 * The fraction and the offset's minute and second components are captured **without a
 * length limit** on purpose: an over-long fraction and a seconds-bearing offset must be
 * **detected and refused with their own reasons**, not silently fail to match and arrive as
 * an indistinguishable `MALFORMED`.
 */
const ISO_TIMESTAMPTZ =
  /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

/** PostgreSQL's offsets span ±15:59; anything beyond is not a value it can have emitted. */
const MAXIMUM_OFFSET_HOURS = 15;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return isLeapYear(year) ? 29 : 28;
  }
}

/**
 * Days from 1970-01-01 to the given proleptic Gregorian date.
 *
 * The standard era-based civil-from-days inverse. It is exact integer arithmetic over the
 * whole supported range and — the reason it is here rather than a `Date` — it consults no
 * time zone, no locale and no clock.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * Convert one PostgreSQL `timestamptz` text value to epoch milliseconds.
 *
 * Returns a **plain safe-integer `number`**, never an `Instant` and never a `Date`
 * (issue #173 Choice B): constructing the branded domain instant belongs to the later
 * row-to-domain mapper.
 *
 * `null` passes through, because a nullable column legitimately yields it and `pg` calls a
 * type parser only for non-null values — the explicit branch exists so that a caller
 * reading this does not have to wonder.
 *
 * Throws {@link TimestamptzParseError} on every other input. Nothing is rounded, clamped,
 * defaulted or partially parsed.
 */
export function parseTimestamptz(value: string): number;
export function parseTimestamptz(value: null): null;
export function parseTimestamptz(value: string | null): number | null;
export function parseTimestamptz(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return failWith("NOT_A_STRING", value);
  }

  // `infinity` and `-infinity` are valid timestamptz values and are not instants the
  // domain can hold (`ADR-022`). Checked before the grammar so they refuse by their own
  // reason rather than as a shapeless malformed value.
  if (value === "infinity" || value === "-infinity") {
    return failWith("INFINITE", value);
  }

  // The era suffix is checked before the grammar for the same reason: the disclosed
  // narrowing must be identifiable, not hidden inside a generic match failure.
  if (value.endsWith(" BC")) {
    return failWith("BC_ERA", value);
  }

  const matched = ISO_TIMESTAMPTZ.exec(value);

  if (matched === null) {
    return failWith("MALFORMED", value);
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    offsetSignText,
    offsetHourText,
    offsetMinuteText,
    offsetSecondText,
  ] = matched;

  if (offsetSecondText !== undefined) {
    return failWith("OFFSET_HAS_SECONDS", value);
  }

  if (fractionText !== undefined && fractionText.length > 3) {
    return failWith("SUB_MILLISECOND_PRECISION", value);
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > MAXIMUM_OFFSET_HOURS ||
    offsetMinute > 59
  ) {
    return failWith("CALENDAR_FIELD_OUT_OF_RANGE", value);
  }

  // `.1` means 100ms and `.12` means 120ms, so the captured digits are right-padded
  // rather than read as an integer.
  const milliseconds =
    fractionText === undefined ? 0 : Number(fractionText.padEnd(3, "0"));

  const localSeconds =
    daysFromCivil(year, month, day) * SECONDS_PER_DAY +
    hour * SECONDS_PER_HOUR +
    minute * SECONDS_PER_MINUTE +
    second;

  // A `+` offset means the rendered local time runs ahead of UTC, so the offset is
  // subtracted to recover the instant.
  const offsetSeconds =
    (offsetSignText === "-" ? -1 : 1) *
    (offsetHour * SECONDS_PER_HOUR + offsetMinute * SECONDS_PER_MINUTE);

  const epochMilliseconds =
    (localSeconds - offsetSeconds) * MILLISECONDS_PER_SECOND + milliseconds;

  // The governed admissible range is the intersection of the layers a value crosses
  // (`ADR-022`). Having crossed no `Date`, the binding bound is the domain carrier's, and
  // this is the check that enforces it — a representable calendar date whose instant falls
  // outside the safe-integer range is refused rather than silently losing precision.
  if (!Number.isSafeInteger(epochMilliseconds)) {
    return failWith("NOT_A_SAFE_INTEGER", value);
  }

  return epochMilliseconds;
}

function failWith(reason: TimestamptzParseFailure, value: unknown): never {
  throw new TimestamptzParseError(reason, typeof value === "string" ? value : String(value));
}

/** The slice of `pg` this module needs. */
interface PgTypeOverrides {
  setTypeParser(
    oid: number,
    format: string,
    parseFn: (value: string) => unknown,
  ): void;
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

interface PgModule {
  readonly TypeOverrides: new (userTypes?: unknown) => PgTypeOverrides;
}

/**
 * A `pg` type-override registry that parses `timestamptz` with {@link parseTimestamptz}.
 *
 * Pass the returned value as the **`types`** option of a future `Pool` or `Client`:
 * `pg` resolves overrides per client (`TypeOverrides.getTypeParser` consults the instance
 * before its fallback registry), so **the process-global `pg.types` registry is never
 * mutated** — the hazard `ADR-022`'s parser-configuration boundary names. A client
 * constructed without this value keeps `pg`'s default behaviour, which is what makes the
 * scope provably narrow.
 *
 * **Only `TIMESTAMPTZ_OID` is overridden.** `timestamp without time zone` (1114) and
 * `timestamptz[]` (1185) are deliberately untouched: the schema contains no such column,
 * and `ADR-022` governs only the four instants.
 *
 * `pg` is reached through `createRequire` and described by the narrow local type above,
 * because `pg` ships no declarations and `@types/pg` is deliberately absent from this
 * repository (`ADR-017`) — the pattern `migrate.ts` established. The require happens here
 * rather than at module scope so that **importing this module loads nothing and does
 * nothing**.
 */
export function createTimestamptzTypeOverrides(): PgTypeOverrides {
  const { TypeOverrides } = createRequire(import.meta.url)("pg") as PgModule;
  const overrides = new TypeOverrides();

  overrides.setTypeParser(TIMESTAMPTZ_OID, "text", (value: string) =>
    parseTimestamptz(value),
  );

  return overrides;
}
