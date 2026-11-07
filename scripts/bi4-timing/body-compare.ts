/**
 * Response bodies and headers for the `BI-4` timing pilot (issue #246; harness gate revision 5
 * §11, rulings `H-D7`, `H-D17`, `H-D19`).
 *
 * ## The rule this module enforces
 *
 * HTTP timing is interpreted only if every measured never-existed (including both null-control
 * subsets), pending, rejected and unpublished request agrees **exactly** on:
 *
 * - its body, after masking **only** the request's own identity (§11.2), with the same
 *   replacement count and the same status (§11.3); and
 * - its headers, compared exactly after the same masking, with `Date` the only header removed
 *   from that comparison and checked instead by a fixed timestamp plausibility check (§11.6).
 *
 * Any difference withholds timing interpretation for the boundary replicate. Nothing here can
 * lift that: the diagnostic variation model (§11.5) locates differences and is labelled as unable
 * to establish agreement.
 *
 * ## What is never done
 *
 * No other normalization, no tolerance, no learned allowance. Malformed (`MF`) responses are
 * compared and reported, but are outside the gate. Nothing here measures time or reaches a
 * network, a process or a database.
 */

import { createHash } from "node:crypto";

import type { ItemClass, TestClass } from "./schedule";

/** The same-length placeholder that replaces the request's own identity (§11.2). */
export const PLACEHOLDER = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

/** The only request-varying header declared in advance (§11.6.5), compared case-insensitively. */
export const DECLARED_VARYING_HEADERS: readonly string[] = ["date"];

export const BODY_WITHHELD = "Withheld — masked body mismatch";
export const HEADER_WITHHELD = "Withheld — response header mismatch";
export const STATE_ASSOCIATED = "State-associated";
export const NOT_SHOWN_STATE_ASSOCIATED = "Unexplained — not shown to be state-associated";
export const DIAGNOSTIC_LABEL = "diagnostic — does not establish agreement";

/** The classes whose measured responses form the agreement set, and the listing state of each. */
const STATE_OF: Readonly<Partial<Record<ItemClass, TestClass>>> = {
  NE: "NE",
  NCA: "NE",
  NCB: "NE",
  PE: "PE",
  RJ: "RJ",
  UP: "UP",
};

/** The listing state a class is checked as, or `undefined` if it is outside the agreement set. */
export function listingStateOf(cls: ItemClass): TestClass | undefined {
  return STATE_OF[cls];
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MaskResult {
  readonly masked: Buffer;
  readonly count: number;
  /** Byte offsets of every replacement, so the raw body can be rebuilt exactly. */
  readonly offsets: readonly number[];
}

/**
 * Replace every non-overlapping occurrence of the identity's exact ASCII bytes, left to right,
 * case-sensitively, with the same-length placeholder. Bytes, not decoded text.
 */
export function maskOwnIdentity(raw: Buffer, identity: string): MaskResult {
  const needle = Buffer.from(identity, "ascii");

  if (needle.length !== PLACEHOLDER.length || !/^[\x21-\x7e]+$/.test(identity)) {
    throw new Error("the masked identity must be exactly 36 printable ASCII characters");
  }

  const masked = Buffer.from(raw);
  const offsets: number[] = [];
  let from = 0;

  for (;;) {
    const at = raw.indexOf(needle, from);

    if (at < 0) {
      break;
    }

    masked.write(PLACEHOLDER, at, "ascii");
    offsets.push(at);
    from = at + needle.length;
  }

  return { masked, count: offsets.length, offsets };
}

/** Rebuild the raw bytes from a masked body and its recorded offsets (evidence preservation). */
export function unmaskAt(masked: Buffer, identity: string, offsets: readonly number[]): Buffer {
  const raw = Buffer.from(masked);

  for (const at of offsets) {
    raw.write(identity, at, "ascii");
  }

  return raw;
}

/** The fixed header-list serialization (§11.6.2): `name ": " value "\r\n"` per pair, in order, UTF-8. */
export function serializeHeaderList(rawHeaders: readonly string[]): Buffer {
  if (rawHeaders.length % 2 !== 0) {
    throw new Error("a raw header list holds name/value pairs");
  }

  let text = "";

  for (let i = 0; i < rawHeaders.length; i += 2) {
    text += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }

  return Buffer.from(text, "utf8");
}

export interface ComparisonList {
  readonly list: readonly string[];
  readonly hash: string;
  readonly replacements: number;
}

/**
 * The comparison list (§11.6.3): remove the declared request-varying headers, mask the request's
 * own identity in every remaining value (on its bytes, as received), keep everything else —
 * name case, order and repeats — and hash it with the fixed serialization.
 */
export function comparisonListOf(rawHeaders: readonly string[], identity: string): ComparisonList {
  const list: string[] = [];
  let replacements = 0;

  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;

    if (DECLARED_VARYING_HEADERS.includes(name.toLowerCase())) {
      continue;
    }

    const masked = maskOwnIdentity(Buffer.from(rawHeaders[i + 1] as string, "latin1"), identity);

    replacements += masked.count;
    list.push(name, masked.masked.toString("latin1"));
  }

  return { list, hash: sha256Hex(serializeHeaderList(list)), replacements };
}

/** IMF-fixdate (RFC 9110 §5.6.7). */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** The client wall-clock context of one exchange, for the D3 plausibility window. */
export interface ExchangeClock {
  /** `Date.now()` immediately before the request was written. */
  readonly writeStartMs: number;
  /** `Date.now()` when the response's last byte arrived. */
  readonly responseEndMs: number;
}

export interface DateCheck {
  /** D1: exactly one `Date` entry. */
  readonly d1: boolean;
  /** D2: IMF-fixdate. */
  readonly d2: boolean;
  /** D3: inside the plausibility window. */
  readonly d3: boolean;
  /** The entry's pair index in the raw list, when exactly one exists. D4 is decided per set. */
  readonly index: number | undefined;
  /** The raw value(s), reported separately and never compared across states. */
  readonly values: readonly string[];
}

/**
 * D1–D3 for one response. **A timestamp plausibility check, not proof that `Date` is independent
 * of listing state**: a value can pass every check and still vary with state inside the window.
 */
export function checkDate(rawHeaders: readonly string[], clock: ExchangeClock): DateCheck {
  const found: { index: number; value: string }[] = [];

  for (let i = 0; i < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] as string).toLowerCase() === "date") {
      found.push({ index: i / 2, value: rawHeaders[i + 1] as string });
    }
  }

  const values = found.map((entry) => entry.value);

  if (found.length !== 1) {
    return { d1: false, d2: false, d3: false, index: undefined, values };
  }

  const { index, value } = found[0] as { index: number; value: string };
  const parsed = Date.parse(value);
  const d2 = IMF_FIXDATE.test(value) && Number.isFinite(parsed) && new Date(parsed).toUTCString() === value;
  const low = Math.floor(clock.writeStartMs / 1_000) * 1_000 - 1_000;
  const high = Math.ceil(clock.responseEndMs / 1_000) * 1_000 + 1_000;
  const d3 = d2 && parsed >= low && parsed <= high;

  return { d1: true, d2, d3, index, values };
}

/** One measured response, as the gates see it. */
export interface ResponseObservation {
  readonly request: number;
  readonly cls: ItemClass;
  readonly identity: string;
  readonly status: number;
  readonly maskedBodyHash: string;
  readonly bodyReplacements: number;
  readonly rawHeaders: readonly string[];
  readonly clock: ExchangeClock;
}

type CountsByState = Readonly<Partial<Record<TestClass, Readonly<Record<string, number>>>>>;

function countByState(entries: readonly { readonly state: TestClass; readonly signature: string }[]): CountsByState {
  const counts: Partial<Record<TestClass, Record<string, number>>> = {};

  for (const { state, signature } of entries) {
    const forState = (counts[state] ??= {});
    forState[signature] = (forState[signature] ?? 0) + 1;
  }

  return counts;
}

/**
 * Whether the evidence separates listing states (§11.6.6): two states whose sets of observed
 * signatures are disjoint. Overlap — a value seen in more than one state, however unevenly — is
 * not separation.
 */
export function separatesStates(counts: CountsByState): boolean {
  const sets = Object.values(counts).map((forState) => new Set(Object.keys(forState ?? {})));

  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i] as Set<string>;
      const b = sets[j] as Set<string>;

      if (a.size > 0 && b.size > 0 && [...a].every((signature) => !b.has(signature))) {
        return true;
      }
    }
  }

  return false;
}

function mostFrequent(signatures: readonly string[]): string | undefined {
  const counts = new Map<string, number>();

  for (const signature of signatures) {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;

  for (const [signature, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > bestCount) {
      best = signature;
      bestCount = count;
    }
  }

  return best;
}

export interface BodyGateResult {
  readonly agreement: boolean;
  readonly label: "agreement" | typeof BODY_WITHHELD;
  /** Masked hash, replacement count and status, joined; most frequent among never-existed. */
  readonly reference: string | undefined;
  /** Requests whose signature differs from the reference. */
  readonly differing: readonly number[];
  readonly perState: CountsByState;
  /** Descriptive only: whether the differences separate listing states. Never lifts withholding. */
  readonly separatesStates: boolean;
}

function bodySignature(observation: ResponseObservation): string {
  return `${observation.maskedBodyHash}|${observation.bodyReplacements}|${observation.status}`;
}

/**
 * §11.3: exact agreement of masked body, replacement count and status across the agreement set.
 * There is no tolerance: one differing byte anywhere, including between two never-existed
 * requests, withholds.
 */
export function evaluateBodyGate(observations: readonly ResponseObservation[]): BodyGateResult {
  const gated = observations.flatMap((observation) => {
    const state = listingStateOf(observation.cls);
    return state === undefined ? [] : [{ observation, state, signature: bodySignature(observation) }];
  });
  const reference = mostFrequent(gated.filter((entry) => entry.state === "NE").map((entry) => entry.signature));
  const distinct = new Set(gated.map((entry) => entry.signature));
  const agreement = gated.length > 0 && distinct.size === 1;
  const perState = countByState(gated);

  return {
    agreement,
    label: agreement ? "agreement" : BODY_WITHHELD,
    reference,
    differing: gated.filter((entry) => entry.signature !== reference).map((entry) => entry.observation.request),
    perState,
    separatesStates: !agreement && separatesStates(perState),
  };
}

export interface HeaderGateResult {
  readonly agreement: boolean;
  readonly label: "agreement" | typeof HEADER_WITHHELD;
  /** Condition B: a declared `Date` check failed somewhere in the set. */
  readonly conditionB: boolean;
  /** Condition C: undeclared variation, including within a single state. */
  readonly conditionC: boolean;
  /** Descriptive label for a withheld mismatch (§11.6.6). It never changes the withholding. */
  readonly association: typeof STATE_ASSOCIATED | typeof NOT_SHOWN_STATE_ASSOCIATED | undefined;
  readonly referenceComparison: string | undefined;
  readonly differing: readonly number[];
  readonly comparisonPerState: CountsByState;
  readonly datePatternPerState: CountsByState;
  /** Every request's raw `Date` value and D1–D4 outcome, reported separately. */
  readonly dates: readonly {
    readonly request: number;
    readonly values: readonly string[];
    readonly d1: boolean;
    readonly d2: boolean;
    readonly d3: boolean;
    readonly d4: boolean;
  }[];
}

/**
 * §11.6: the header gate. The same code path for every listing state; no state is the reference
 * for another. Any unexplained mismatch — condition B or C — withholds.
 */
export function evaluateHeaderGate(observations: readonly ResponseObservation[]): HeaderGateResult {
  const gated = observations.flatMap((observation) => {
    const state = listingStateOf(observation.cls);

    if (state === undefined) {
      return [];
    }

    const comparison = comparisonListOf(observation.rawHeaders, observation.identity);

    return [
      {
        observation,
        state,
        comparison: `${comparison.hash}|${comparison.replacements}`,
        date: checkDate(observation.rawHeaders, observation.clock),
      },
    ];
  });

  // D4: the position must be identical across the whole set; the modal position is the only
  // one that can satisfy that for everyone.
  const modalIndex = mostFrequent(gated.map((entry) => String(entry.date.index)));
  const allSameIndex = new Set(gated.map((entry) => String(entry.date.index))).size === 1;
  const dates = gated.map((entry) => ({
    request: entry.observation.request,
    values: entry.date.values,
    d1: entry.date.d1,
    d2: entry.date.d2,
    d3: entry.date.d3,
    d4: entry.date.index !== undefined && allSameIndex && String(entry.date.index) === modalIndex,
  }));
  const pattern = (d: (typeof dates)[number]): string =>
    `${d.d1 ? 1 : 0}${d.d2 ? 1 : 0}${d.d3 ? 1 : 0}${d.d4 ? 1 : 0}`;

  const conditionB = dates.some((d) => !(d.d1 && d.d2 && d.d3 && d.d4));
  const conditionC = gated.length > 0 && new Set(gated.map((entry) => entry.comparison)).size > 1;
  const comparisonPerState = countByState(gated.map((entry) => ({ state: entry.state, signature: entry.comparison })));
  const datePatternPerState = countByState(
    gated.map((entry, position) => ({ state: entry.state, signature: pattern(dates[position] as (typeof dates)[number]) })),
  );
  const agreement = gated.length > 0 && !conditionB && !conditionC;
  const referenceComparison = mostFrequent(
    gated.filter((entry) => entry.state === "NE").map((entry) => entry.comparison),
  );
  const separated =
    (conditionC && separatesStates(comparisonPerState)) || (conditionB && separatesStates(datePatternPerState));

  return {
    agreement,
    label: agreement ? "agreement" : HEADER_WITHHELD,
    conditionB,
    conditionC,
    association: agreement ? undefined : separated ? STATE_ASSOCIATED : NOT_SHOWN_STATE_ASSOCIATED,
    referenceComparison,
    differing: gated
      .filter((entry, position) => {
        const d = dates[position] as (typeof dates)[number];
        return entry.comparison !== referenceComparison || !(d.d1 && d.d2 && d.d3 && d.d4);
      })
      .map((entry) => entry.observation.request),
    comparisonPerState,
    datePatternPerState,
    dates,
  };
}

export interface MalformedReport {
  /** Reported only. `MF` never withholds the four-way results. */
  readonly withholds: false;
  readonly requests: number;
  readonly bodyDiffersFromReference: number;
  readonly headersDifferFromReference: number;
}

/** `MF` responses against the never-existed references: preserved and reported, never gated. */
export function compareMalformed(
  observations: readonly ResponseObservation[],
  body: BodyGateResult,
  headers: HeaderGateResult,
): MalformedReport {
  const malformed = observations.filter((observation) => observation.cls === "MF");

  return {
    withholds: false,
    requests: malformed.length,
    bodyDiffersFromReference: malformed.filter((observation) => bodySignature(observation) !== body.reference).length,
    headersDifferFromReference: malformed.filter((observation) => {
      const comparison = comparisonListOf(observation.rawHeaders, observation.identity);
      return `${comparison.hash}|${comparison.replacements}` !== headers.referenceComparison;
    }).length,
  };
}

// ---------------------------------------------------------------------------------------------
// §11.5 The diagnostic variation model: diagnosis only, never agreement.
// ---------------------------------------------------------------------------------------------

/** Maximal runs of `[A-Za-z0-9_]`, and every other byte as a token of its own. */
export function tokenize(body: Buffer): readonly string[] {
  return body.toString("latin1").match(/[A-Za-z0-9_]+|[\s\S]/g) ?? [];
}

export interface Edit {
  readonly op: "replace" | "delete" | "insert";
  /** Reference token range [start, end); empty for an insertion, which sits before `start`. */
  readonly referenceStart: number;
  readonly referenceEnd: number;
  readonly otherStart: number;
  readonly otherEnd: number;
}

/** The largest middle section the dynamic-programming diff will attempt (cells). */
export const DIFF_CELL_LIMIT = 16_000_000;

/**
 * A token-level longest-common-subsequence diff of `other` against `reference`.
 *
 * Deterministic: common prefix and suffix are trimmed, the middle is solved by dynamic
 * programming, and ties are broken by preferring deletions first. Adjacent deletions and
 * insertions are coalesced into replacements. Returns `undefined` if the middle is too large.
 */
export function diffTokens(reference: readonly string[], other: readonly string[]): readonly Edit[] | undefined {
  let prefix = 0;

  while (prefix < reference.length && prefix < other.length && reference[prefix] === other[prefix]) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < reference.length - prefix &&
    suffix < other.length - prefix &&
    reference[reference.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = reference.slice(prefix, reference.length - suffix);
  const b = other.slice(prefix, other.length - suffix);
  const n = a.length;
  const m = b.length;

  if ((n + 1) * (m + 1) > DIFF_CELL_LIMIT) {
    return undefined;
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      table[i * width + j] =
        a[i - 1] === b[j - 1]
          ? (table[(i - 1) * width + (j - 1)] as number) + 1
          : Math.max(table[(i - 1) * width + j] as number, table[i * width + (j - 1)] as number);
    }
  }

  // Backtrack from the end; collect single-token operations in reverse.
  const steps: { op: "match" | "delete" | "insert"; i: number; j: number }[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      steps.push({ op: "match", i: i - 1, j: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || (table[(i - 1) * width + j] as number) >= (table[i * width + (j - 1)] as number))) {
      steps.push({ op: "delete", i: i - 1, j });
      i -= 1;
    } else {
      steps.push({ op: "insert", i, j: j - 1 });
      j -= 1;
    }
  }

  steps.reverse();

  const edits: Edit[] = [];
  let k = 0;

  while (k < steps.length) {
    const step = steps[k] as (typeof steps)[number];

    if (step.op === "match") {
      k += 1;
      continue;
    }

    // A run's first step carries both starting positions: a deletion records the deleted token's
    // index and the other side's position; an insertion records the reverse.
    let deletions = 0;
    let insertions = 0;
    const referenceStart = step.i;
    const otherStart = step.j;

    while (k < steps.length && (steps[k] as (typeof steps)[number]).op !== "match") {
      if ((steps[k] as (typeof steps)[number]).op === "delete") deletions += 1;
      else insertions += 1;
      k += 1;
    }

    edits.push({
      op: deletions > 0 && insertions > 0 ? "replace" : deletions > 0 ? "delete" : "insert",
      referenceStart: prefix + referenceStart,
      referenceEnd: prefix + referenceStart + deletions,
      otherStart: prefix + otherStart,
      otherEnd: prefix + otherStart + insertions,
    });
  }

  return edits;
}

/** Reference positions an edit touches: its range, or the neighbours of an insertion point. */
export function touchedPositions(edit: Edit, referenceLength: number): readonly number[] {
  if (edit.op !== "insert") {
    return Array.from({ length: edit.referenceEnd - edit.referenceStart }, (_, offset) => edit.referenceStart + offset);
  }

  return [edit.referenceStart - 1, edit.referenceStart].filter((position) => position >= 0 && position < referenceLength);
}

export interface DiagnosticOutput {
  readonly label: typeof DIAGNOSTIC_LABEL;
  readonly referenceHash: string | undefined;
  readonly variablePositions: readonly number[];
  readonly learningBodies: number;
  readonly perRequest: readonly {
    readonly request: number;
    /** `undefined` when the diff was too large to compute. */
    readonly edits: readonly Edit[] | undefined;
    readonly allEditsInsideV: boolean | undefined;
  }[];
  readonly ncbAllInsideV: boolean | undefined;
}

/**
 * §11.5. Runs only after the body gate has found a disagreement. Learns V from warm-up
 * never-existed and `NC-A` bodies, then describes each differing body against the reference.
 * **Its output never establishes agreement and never lifts withholding.**
 */
export function diagnoseVariation(input: {
  readonly learning: readonly Buffer[];
  readonly differing: readonly { readonly request: number; readonly body: Buffer }[];
  readonly ncb: readonly Buffer[];
}): DiagnosticOutput {
  const byHash = new Map<string, Buffer>();
  const frequency = new Map<string, number>();

  for (const body of input.learning) {
    const hash = sha256Hex(body);
    byHash.set(hash, body);
    frequency.set(hash, (frequency.get(hash) ?? 0) + 1);
  }

  const referenceHash = mostFrequent(input.learning.map((body) => sha256Hex(body)));

  if (referenceHash === undefined) {
    return {
      label: DIAGNOSTIC_LABEL,
      referenceHash,
      variablePositions: [],
      learningBodies: 0,
      perRequest: input.differing.map(({ request }) => ({ request, edits: undefined, allEditsInsideV: undefined })),
      ncbAllInsideV: undefined,
    };
  }

  const reference = tokenize(byHash.get(referenceHash) as Buffer);
  const variable = new Set<number>();
  const diffCache = new Map<string, readonly Edit[] | undefined>();
  const diffOf = (body: Buffer): readonly Edit[] | undefined => {
    const hash = sha256Hex(body);

    if (!diffCache.has(hash)) {
      diffCache.set(hash, diffTokens(reference, tokenize(body)));
    }

    return diffCache.get(hash);
  };

  for (const hash of byHash.keys()) {
    for (const edit of diffOf(byHash.get(hash) as Buffer) ?? []) {
      for (const position of touchedPositions(edit, reference.length)) {
        variable.add(position);
      }
    }
  }

  const insideV = (edits: readonly Edit[] | undefined): boolean | undefined =>
    edits === undefined
      ? undefined
      : edits.every((edit) => touchedPositions(edit, reference.length).every((position) => variable.has(position)));

  const ncbResults = input.ncb.map((body) => insideV(diffOf(body)));

  return {
    label: DIAGNOSTIC_LABEL,
    referenceHash,
    variablePositions: [...variable].sort((x, y) => x - y),
    learningBodies: input.learning.length,
    perRequest: input.differing.map(({ request, body }) => {
      const edits = diffOf(body);
      return { request, edits, allEditsInsideV: insideV(edits) };
    }),
    ncbAllInsideV: ncbResults.includes(undefined) ? undefined : ncbResults.every(Boolean),
  };
}
