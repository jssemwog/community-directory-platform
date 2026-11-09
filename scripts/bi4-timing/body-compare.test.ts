/**
 * Response bodies and headers for the `BI-4` timing pilot (issue #246; harness gate revision 5
 * §11, `H-D17`, `H-D19`), on constructed responses only.
 *
 * Exact masking of the request's own identity; exact agreement as the only way HTTP timing can be
 * interpreted; the diagnostic model unable to establish agreement; and the header gate — raw lists
 * preserved, `Date` the only declared varying header with its plausibility checks, exact
 * comparison of everything else, the state-association label, and one code path for all four
 * states.
 */

import { describe, expect, it } from "vitest";

import {
  BODY_VARIATION_LABEL,
  BODY_WITHHELD,
  evaluateE2Gates,
  maskNextRequestId,
  NEXT_R_PREFIX,
  NEXT_R_SUFFIX,
  NEXT_VERSION_WITHHELD,
  REQUEST_ID_MASK_WITHHELD,
  REQUEST_ID_VALUE_REPEATED,
  separatesStates,
  summarizeBodyVariation,
  type E2Observation,
  type NextGuardOutcome,
  checkDate,
  compareMalformed,
  comparisonListOf,
  diagnoseVariation,
  diffTokens,
  DIAGNOSTIC_LABEL,
  evaluateBodyGate,
  evaluateHeaderGate,
  HEADER_WITHHELD,
  listingStateOf,
  maskOwnIdentity,
  NOT_SHOWN_STATE_ASSOCIATED,
  PLACEHOLDER,
  serializeHeaderList,
  sha256Hex,
  STATE_ASSOCIATED,
  tokenize,
  unmaskAt,
  type ResponseObservation,
} from "./body-compare";
import type { ItemClass } from "./schedule";

const OWN = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const OTHER = "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0, 400);
const DATE = new Date(Math.floor(NOW / 1_000) * 1_000).toUTCString();

/** A header list shaped like the detail route's, with `Date` second. */
function headers(overrides: { readonly date?: string | null; readonly extra?: readonly string[] } = {}): string[] {
  const list = ["Vary", "RSC, Accept-Encoding", "Date", overrides.date ?? DATE, "Content-Type", "text/html; charset=utf-8"];

  if (overrides.date === null) {
    list.splice(2, 2);
  }

  return [...list, ...(overrides.extra ?? []), "Connection", "keep-alive"];
}

function body(identity: string, text = "Not available"): Buffer {
  return Buffer.from(`<html><a href="/directory/${identity}">x</a><h1>${text}</h1></html>`, "utf8");
}

let nextRequest = 0;

function observe(
  cls: ItemClass,
  options: { readonly identity?: string; readonly text?: string; readonly status?: number; readonly rawHeaders?: string[] } = {},
): ResponseObservation {
  const identity = options.identity ?? `${String(nextRequest).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const masked = maskOwnIdentity(body(identity, options.text), identity);

  nextRequest += 1;

  return {
    request: nextRequest,
    cls,
    identity,
    status: options.status ?? 200,
    maskedBodyHash: sha256Hex(masked.masked),
    bodyReplacements: masked.count,
    rawHeaders: options.rawHeaders ?? headers(),
    clock: { writeStartMs: NOW - 5, responseEndMs: NOW + 5 },
  };
}

/** Two requests in each of the four states, never-existed drawn from both null subsets too. */
function agreeingSet(): ResponseObservation[] {
  return (["NE", "NCA", "NCB", "PE", "RJ", "UP", "NE", "PE", "RJ", "UP"] as const).map((cls) => observe(cls));
}

describe("exact masking of the request's own identity (§11.2)", () => {
  it("replaces every non-overlapping occurrence, byte for byte, with a same-length placeholder", () => {
    const raw = Buffer.from(`${OWN}|${OWN}${OWN}|end`, "ascii");
    const { masked, count, offsets } = maskOwnIdentity(raw, OWN);

    expect(count).toBe(3);
    expect(offsets).toEqual([0, 37, 73]);
    expect(masked.length).toBe(raw.length);
    expect(masked.toString("ascii")).toBe(`${PLACEHOLDER}|${PLACEHOLDER}${PLACEHOLDER}|end`);
    expect(PLACEHOLDER).toHaveLength(36);
  });

  it("is case-sensitive and leaves every other UUID in place", () => {
    const raw = Buffer.from(`${OWN.toUpperCase()} ${OTHER} ${OWN}`, "ascii");
    const { masked, count } = maskOwnIdentity(raw, OWN);

    expect(count).toBe(1);
    expect(masked.toString("ascii")).toBe(`${OWN.toUpperCase()} ${OTHER} ${PLACEHOLDER}`);
  });

  it("works on bytes, not decoded text, and leaves non-ASCII bytes untouched", () => {
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(OWN, "ascii"), Buffer.from("é", "utf8")]);
    const { masked } = maskOwnIdentity(raw, OWN);

    expect([...masked.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(masked.subarray(38).toString("utf8")).toBe("é");
  });

  it("keeps the raw evidence recoverable exactly, even if the body already held the placeholder text", () => {
    const raw = Buffer.from(`${PLACEHOLDER} then ${OWN}`, "ascii");
    const result = maskOwnIdentity(raw, OWN);

    expect(result.count).toBe(1);
    expect(unmaskAt(result.masked, OWN, result.offsets).equals(raw)).toBe(true);
    expect(sha256Hex(unmaskAt(result.masked, OWN, result.offsets))).toBe(sha256Hex(raw));
  });

  it("refuses an identity that is not 36 printable ASCII characters", () => {
    expect(() => maskOwnIdentity(Buffer.alloc(0), "short")).toThrow(/36/);
  });
});

describe("the body gate: exact agreement or withheld (§11.3, H-D17)", () => {
  it("agrees when every masked body, replacement count and status is identical", () => {
    const result = evaluateBodyGate(agreeingSet());

    expect(result.agreement).toBe(true);
    expect(result.label).toBe("agreement");
    expect(result.differing).toEqual([]);
  });

  it("withholds on one differing byte across states", () => {
    const set = [...agreeingSet(), observe("RJ", { text: "Not availablE" })];
    const result = evaluateBodyGate(set);

    expect(result.agreement).toBe(false);
    expect(result.label).toBe(BODY_WITHHELD);
    expect(result.differing).toEqual([set.at(-1)?.request]);
  });

  it("withholds on one differing byte between two never-existed requests", () => {
    const result = evaluateBodyGate([...agreeingSet(), observe("NCB", { text: "Not availabl3" })]);

    expect(result.agreement).toBe(false);
    expect(result.label).toBe(BODY_WITHHELD);
  });

  it("withholds on a differing replacement count or status even when masked bytes match", () => {
    const set = agreeingSet();
    const countDiffers = { ...(set[3] as ResponseObservation), bodyReplacements: 2 };
    const statusDiffers = { ...(set[4] as ResponseObservation), status: 404 };

    expect(evaluateBodyGate([...set, countDiffers]).agreement).toBe(false);
    expect(evaluateBodyGate([...set, statusDiffers]).agreement).toBe(false);
  });

  it("still withholds when the diagnostic model places every edit inside V", () => {
    const learning = [body(PLACEHOLDER, "Not available 1"), body(PLACEHOLDER, "Not available 2")];
    const differingBody = body(PLACEHOLDER, "Not available 3");
    const diagnosis = diagnoseVariation({ learning, differing: [{ request: 99, body: differingBody }], ncb: [] });
    const gate = evaluateBodyGate([...agreeingSet(), observe("UP", { text: "Not available 3" })]);

    expect(diagnosis.perRequest[0]?.allEditsInsideV).toBe(true);
    expect(diagnosis.label).toBe(DIAGNOSTIC_LABEL);
    expect(gate.agreement).toBe(false);
    expect(gate.label).toBe(BODY_WITHHELD);
  });

  it("ignores MF responses in the gate and reports their difference without withholding", () => {
    const set = [...agreeingSet(), observe("MF", { identity: "ghijklmn-opqr-stuv-wxyz-ghijklmnopqr", text: "Different" })];
    const gate = evaluateBodyGate(set);
    const report = compareMalformed(set, gate, evaluateHeaderGate(set));

    expect(gate.agreement).toBe(true);
    expect(report).toEqual({ withholds: false, requests: 1, bodyDiffersFromReference: 1, headersDifferFromReference: 0 });
  });
});

describe("the diagnostic variation model (§11.5)", () => {
  it("is deterministic, prefers deletions on ties, and coalesces adjacent edits into replacements", () => {
    const reference = tokenize(Buffer.from("a b c d", "latin1"));
    const other = tokenize(Buffer.from("a x c", "latin1"));
    const first = diffTokens(reference, other);

    expect(first).toEqual(diffTokens(reference, other));
    expect(first?.map((edit) => edit.op)).toEqual(["replace", "delete"]);
    expect(diffTokens(tokenize(Buffer.from("ab", "latin1")), tokenize(Buffer.from("ba", "latin1")))).toEqual([
      { op: "replace", referenceStart: 0, referenceEnd: 1, otherStart: 0, otherEnd: 1 },
    ]);
  });

  it("tokenizes word runs and single other bytes", () => {
    expect(tokenize(Buffer.from("ab_1-<x>", "latin1"))).toEqual(["ab_1", "-", "<", "x", ">"]);
  });

  it("produces the same output for the same inputs and reports edits outside V", () => {
    const input = {
      learning: [body(PLACEHOLDER, "A"), body(PLACEHOLDER, "A")],
      differing: [{ request: 7, body: body(PLACEHOLDER, "B") }],
      ncb: [body(PLACEHOLDER, "A")],
    };
    const output = diagnoseVariation(input);

    expect(diagnoseVariation(input)).toEqual(output);
    expect(output.variablePositions).toEqual([]);
    expect(output.perRequest[0]?.allEditsInsideV).toBe(false);
    expect(output.ncbAllInsideV).toBe(true);
  });
});

describe("the header gate (§11.6, H-D19)", () => {
  it("agrees when every comparison list is identical and every Date passes D1–D4", () => {
    const result = evaluateHeaderGate(agreeingSet());

    expect(result.agreement).toBe(true);
    expect(result.label).toBe("agreement");
    expect(result.association).toBeUndefined();
  });

  it("serializes raw headers as name: value CRLF in received order, and comparison removes only Date", () => {
    const raw = ["X-A", "1", "date", DATE, "X-B", "2"];

    expect(serializeHeaderList(raw).toString("utf8")).toBe(`X-A: 1\r\ndate: ${DATE}\r\nX-B: 2\r\n`);
    expect(comparisonListOf(raw, OWN).list).toEqual(["X-A", "1", "X-B", "2"]);
  });

  it("masks the request's own identity in a header value but not another UUID, counting replacements apart from the body", () => {
    const raw = ["Link", `</directory/${OWN}>; rel=self, </directory/${OTHER}>`];
    const comparison = comparisonListOf(raw, OWN);

    expect(comparison.replacements).toBe(1);
    expect(comparison.list[1]).toBe(`</directory/${PLACEHOLDER}>; rel=self, </directory/${OTHER}>`);
  });

  it("withholds and labels state-associated when a header value differs for one state only", () => {
    const set = agreeingSet().map((observation) =>
      observation.cls === "RJ" ? { ...observation, rawHeaders: headers({ extra: ["Cache-Control", "private"] }) } : observation,
    );
    const result = evaluateHeaderGate(set);

    expect(result.label).toBe(HEADER_WITHHELD);
    expect(result.conditionC).toBe(true);
    expect(result.association).toBe(STATE_ASSOCIATED);
  });

  it("withholds and labels state-associated when a header is present for one state only, or reordered for one state", () => {
    const present = agreeingSet().map((observation) =>
      observation.cls === "UP" ? { ...observation, rawHeaders: [...headers(), "X-Extra", "1"] } : observation,
    );
    const reordered = agreeingSet().map((observation) => {
      if (observation.cls !== "PE") return observation;
      const list = headers();
      return { ...observation, rawHeaders: [...list.slice(4, 6), ...list.slice(0, 4), ...list.slice(6)] };
    });

    expect(evaluateHeaderGate(present).association).toBe(STATE_ASSOCIATED);
    expect(evaluateHeaderGate(reordered).label).toBe(HEADER_WITHHELD);
    expect(evaluateHeaderGate(reordered).association).toBe(STATE_ASSOCIATED);
  });

  it("withholds and labels unexplained when a header differs between two never-existed requests", () => {
    const set = [...agreeingSet(), observe("NCA", { rawHeaders: headers({ extra: ["X-Request", "2"] }) })];
    const result = evaluateHeaderGate(set);

    expect(result.label).toBe(HEADER_WITHHELD);
    expect(result.association).toBe(NOT_SHOWN_STATE_ASSOCIATED);
  });

  it("withholds without the state-associated label when values overlap between states", () => {
    const variant = headers({ extra: ["X-Variant", "b"] });
    const set = [
      ...agreeingSet(),
      observe("NE", { rawHeaders: variant }),
      observe("PE", { rawHeaders: variant }),
      observe("PE", { rawHeaders: variant }),
    ];
    const result = evaluateHeaderGate(set);

    expect(result.agreement).toBe(false);
    expect(result.association).toBe(NOT_SHOWN_STATE_ASSOCIATED);
  });

  it("withholds when Date is missing, duplicated, malformed, moved or outside the D3 window", () => {
    const outside = new Date(Math.floor(NOW / 1_000) * 1_000 - 5_000).toUTCString();
    const variants: string[][] = [
      headers({ date: null }),
      [...headers(), "Date", DATE],
      headers({ date: "Sat, 7 Nov 2026 12:00:00 GMT" }),
      ["Date", DATE, ...headers({ date: null })],
      headers({ date: outside }),
    ];

    for (const rawHeaders of variants) {
      const result = evaluateHeaderGate([...agreeingSet(), observe("UP", { rawHeaders })]);

      expect(result.conditionB, rawHeaders.join("|")).toBe(true);
      expect(result.label).toBe(HEADER_WITHHELD);
    }
  });

  it("does not withhold on Date values that differ across states but pass D1–D4", () => {
    const later = new Date(Math.floor(NOW / 1_000) * 1_000 + 1_000).toUTCString();
    const set = agreeingSet().map((observation) =>
      observation.cls === "RJ" ? { ...observation, rawHeaders: headers({ date: later }) } : observation,
    );
    const result = evaluateHeaderGate(set);

    expect(result.agreement).toBe(true);
    expect(result.dates.find((entry) => entry.values[0] === later)?.d3).toBe(true);
  });

  it("describes the Date window as plausibility: it checks format, presence and time, nothing about state", () => {
    const check = checkDate(headers(), { writeStartMs: NOW, responseEndMs: NOW });

    expect(check).toEqual({ d1: true, d2: true, d3: true, index: 1, values: [DATE] });
  });

  it("preserves the raw header list unmodified", () => {
    const raw = headers({ extra: ["Link", `</directory/${OWN}>`] });
    const copy = [...raw];
    const observation = observe("PE", { identity: OWN, rawHeaders: raw });

    evaluateHeaderGate([...agreeingSet(), observation]);
    comparisonListOf(raw, OWN);

    expect(raw).toEqual(copy);
    expect(observation.rawHeaders).toBe(raw);
  });

  it("runs the identical code path for NE, PE, RJ and UP: the same variation withholds whichever state carries it", () => {
    for (const cls of ["NE", "PE", "RJ", "UP"] as const) {
      const set = agreeingSet().map((observation) =>
        listingStateOf(observation.cls) === cls
          ? { ...observation, rawHeaders: headers({ extra: ["X-Odd", "1"] }) }
          : observation,
      );
      const result = evaluateHeaderGate(set);

      expect(result.label, cls).toBe(HEADER_WITHHELD);
      expect(result.association, cls).toBe(STATE_ASSOCIATED);
    }
  });

  it("reports MF header differences without withholding", () => {
    const set = [
      ...agreeingSet(),
      observe("MF", { identity: "ghijklmn-opqr-stuv-wxyz-ghijklmnopqr", rawHeaders: headers({ extra: ["X-MF", "1"] }) }),
    ];
    const gate = evaluateHeaderGate(set);

    expect(gate.agreement).toBe(true);
    expect(compareMalformed(set, evaluateBodyGate(set), gate).headersDifferFromReference).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Approved amendment revision 4 (§11.2A, §7.3, §11.3, §11.4): the E2 `next dev` request-ID mask.
// ---------------------------------------------------------------------------------------------

const value = (n: number): string => String(n).padStart(21, "A");
const NO_SCRIPT = (): Buffer => Buffer.from("<html>no script</html>", "latin1");
const OK_GUARD = "ok" as const;

function nextBody(identity: string, v: string, options: { before?: string; after?: string; text?: string } = {}): Buffer {
  return Buffer.from(
    `<html><a href="/directory/${identity}">x</a>${options.before ?? ""}${NEXT_R_PREFIX}${v}${NEXT_R_SUFFIX}${options.after ?? "fetch('?_rsc=k')}"}</script><h1>${options.text ?? "Not available"}</h1></html>`,
    "latin1",
  );
}

function observeNext(
  cls: ItemClass,
  options: { raw?: (identity: string) => Buffer; v?: string; text?: string; after?: string; before?: string; status?: number; rawHeaders?: string[]; identity?: string } = {},
): E2Observation {
  const identity = options.identity ?? `${String(nextRequest).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const raw = options.raw?.(identity) ?? nextBody(identity, options.v ?? value(nextRequest), options);
  const uuid = maskOwnIdentity(raw, identity);

  nextRequest += 1;

  return {
    request: nextRequest,
    cls,
    identity,
    status: options.status ?? 200,
    maskedBodyHash: sha256Hex(uuid.masked),
    bodyReplacements: uuid.count,
    requestIdMask: maskNextRequestId(uuid.masked),
    rawHeaders: options.rawHeaders ?? headers(),
    clock: { writeStartMs: NOW - 5, responseEndMs: NOW + 5 },
  };
}

const STATES = ["NE", "NCA", "NCB", "PE", "RJ", "UP", "NE", "PE", "RJ", "UP"] as const;
const validSet = (): E2Observation[] => STATES.map((cls) => observeNext(cls));
const gates = (observations: E2Observation[], guard: NextGuardOutcome = OK_GUARD) => evaluateE2Gates({ guard, observations });

describe("narrow match (H-D20)", () => {
  it("T-M1 masks exactly the one value at the same length and leaves its input untouched", () => {
    const body = nextBody(PLACEHOLDER, value(1));
    const copy = Buffer.from(body);
    const result = maskNextRequestId(body);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.value).toBe(value(1));
    expect(result.masked.length).toBe(body.length);
    expect(result.masked.toString("latin1")).toBe(body.toString("latin1").replace(value(1), "*".repeat(21)));
    expect(body.equals(copy)).toBe(true);
  });

  it("T-M2 does not depend on the byte offset", () => {
    const near = maskNextRequestId(nextBody(PLACEHOLDER, value(1)));
    const far = maskNextRequestId(nextBody(PLACEHOLDER, value(1), { before: " ".repeat(5_000) }));

    expect(near.outcome).toBe("ok");
    expect(far.outcome).toBe("ok");
  });

  it("T-M3 does not touch another nanoid-shaped value or the _rsc value", () => {
    const other = `self.__next_other="${value(9)}";`;
    const result = maskNextRequestId(nextBody(PLACEHOLDER, value(1), { before: other, after: "fetch('?_rsc=abcdefghijklmnopqrstu')}" }));

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.masked.toString("latin1")).toContain(other);
    expect(result.masked.toString("latin1")).toContain("?_rsc=abcdefghijklmnopqrstu");
  });

  it("T-M4 agrees when only the value differs, with UUID-only hashes still distinct", () => {
    const set = validSet();
    const result = gates(set);

    expect(result.reasons).toEqual([]);
    expect(result.uuidOnly.agreement).toBe(false);
    expect(result.postMask?.agreement).toBe(true);
    expect(new Set(set.map((o) => o.maskedBodyHash)).size).toBe(set.length);
  });

  it("T-M5 the prefix, suffix and placeholder have the approved lengths", () => {
    expect(Buffer.byteLength(NEXT_R_PREFIX, "ascii")).toBe(32);
    expect(Buffer.byteLength(NEXT_R_SUFFIX, "ascii")).toBe(69);
  });
});

describe("refusal cases", () => {
  const close = "x}</script>";

  it.each([
    ["no __next_r, script present", `<script id="_R_">x</script>`, "missing"],
    ["no script at all", `<p>x</p>`, "missing"],
    ["other case", `<script id="_R_">self.__NEXT_R="${value(1)}${NEXT_R_SUFFIX}${close}`, "missing"],
    ["full target twice", `${NEXT_R_PREFIX}${value(1)}${NEXT_R_SUFFIX}${NEXT_R_PREFIX}${value(2)}${NEXT_R_SUFFIX}${close}`, "duplicate"],
    ["second bare name elsewhere", `${NEXT_R_PREFIX}${value(1)}${NEXT_R_SUFFIX}${close}__next_r`, "duplicate"],
    ["second script tag", `${NEXT_R_PREFIX}${value(1)}${NEXT_R_SUFFIX}${close}<script id="_R_">`, "duplicate"],
    ["other script id", `<script id="_X_">self.__next_r="${value(1)}${NEXT_R_SUFFIX}${close}`, "unexpected"],
    ["extra attribute", `<script id="_R_" nonce="n">self.__next_r="${value(1)}${NEXT_R_SUFFIX}${close}`, "unexpected"],
    ["src attribute", `<script id="_R_" src="/x.js">self.__next_r="${value(1)}${NEXT_R_SUFFIX}${close}`, "unexpected"],
    ["single quote", `<script id="_R_">self.__next_r='${value(1)}${NEXT_R_SUFFIX}${close}`, "unexpected"],
    ["other assignment target", `<script id="_R_">window.__next_r="${value(1)}${NEXT_R_SUFFIX}${close}`, "unexpected"],
    ["20 bytes", `${NEXT_R_PREFIX}${"A".repeat(20)}${NEXT_R_SUFFIX}${close}`, "malformed"],
    ["22 bytes", `${NEXT_R_PREFIX}${"A".repeat(22)}${NEXT_R_SUFFIX}${close}`, "malformed"],
    ["empty", `${NEXT_R_PREFIX}${NEXT_R_SUFFIX}${close}`, "malformed"],
    ["byte outside the alphabet", `${NEXT_R_PREFIX}${"A".repeat(20)}!${NEXT_R_SUFFIX}${close}`, "malformed"],
    ["the placeholder itself", `${NEXT_R_PREFIX}${"*".repeat(21)}${NEXT_R_SUFFIX}${close}`, "malformed"],
    ["other suffix", `${NEXT_R_PREFIX}${value(1)}";x${close}`, "malformed"],
    ["no closing script tag", `${NEXT_R_PREFIX}${value(1)}${NEXT_R_SUFFIX}x`, "malformed"],
    ["truncated", `${NEXT_R_PREFIX}${"A".repeat(5)}`, "malformed"],
  ])("T-R1 %s", (_name, text, outcome) => {
    expect(maskNextRequestId(Buffer.from(text, "latin1")).outcome).toBe(outcome);
  });

  it.each(["NE", "NCA", "NCB", "PE", "RJ", "UP"] as const)("T-R2 one failed mask in %s withholds", (cls) => {
    expect(gates([...validSet(), observeNext(cls, { raw: NO_SCRIPT })]).reasons).toEqual([REQUEST_ID_MASK_WITHHELD]);
  });

  it("T-R3 withholds when every body fails the same way, though all hashes match", () => {
    const set = STATES.map((cls) => observeNext(cls, { raw: NO_SCRIPT }));
    const result = gates(set);

    expect(new Set(set.map((o) => o.maskedBodyHash)).size).toBe(1);
    expect(result.reasons).toEqual([REQUEST_ID_MASK_WITHHELD]);
    expect(result.postMask).toBeUndefined();
  });

  it("T-R4 reports an MF mask failure without withholding", () => {
    const result = gates([...validSet(), observeNext("MF", { raw: NO_SCRIPT })]);

    expect(result.reasons).toEqual([]);
    expect(result.maskReported.map((entry) => entry.outcome)).toEqual(["missing"]);
  });

  it("T-R5 a failed mask and an unrelated difference are both reported", () => {
    const set = [...validSet(), observeNext("UP", { raw: NO_SCRIPT }), observeNext("RJ", { text: "Not availablE" })];

    expect(gates(set).reasons).toEqual([REQUEST_ID_MASK_WITHHELD, BODY_WITHHELD]);
  });

  it("T-R6 an empty agreement set establishes nothing and withholds", () => {
    expect(gates([]).reasons).toEqual([BODY_WITHHELD, HEADER_WITHHELD]);
    expect(gates([]).postMaskScope).toBe("none");
  });

  it("T-R7 agreeing successful responses and one failed mask: a subset comparison, not replicate-wide agreement", () => {
    const set = [...validSet(), observeNext("PE", { raw: NO_SCRIPT })];
    const result = gates(set);

    expect(result.reasons).toEqual([REQUEST_ID_MASK_WITHHELD]);
    expect(result.postMaskScope).toBe("subset");
    expect(result.postMask?.agreement).toBe(true);
    expect(result.postMask?.variationSummary.requests).toBe(set.length - 1);
    expect(gates(validSet()).postMaskScope).toBe("replicate");
    expect(gates(STATES.map((cls) => observeNext(cls, { raw: NO_SCRIPT }))).postMaskScope).toBe("none");
  });

  it("T-R8 a separate mismatch among the successful responses is still reported alongside the mask failure", () => {
    const result = gates([...validSet(), observeNext("UP", { raw: NO_SCRIPT }), observeNext("RJ", { text: "Not availablE" })]);

    expect(result.postMaskScope).toBe("subset");
    expect(result.postMask?.agreement).toBe(false);
    expect(result.reasons).toEqual([REQUEST_ID_MASK_WITHHELD, BODY_WITHHELD]);
  });
});

describe("repeated values across responses", () => {
  it("T-D1 a value repeated across two measured responses withholds with its own reason", () => {
    const first = observeNext("NE", { v: "Z".repeat(21) });
    const second = observeNext("RJ", { v: "Z".repeat(21) });
    const result = gates([...validSet(), first, second]);

    expect(result.reasons).toEqual([REQUEST_ID_VALUE_REPEATED]);
    expect(result.repeatedValues).toEqual([{ value: "Z".repeat(21), requests: [first.request, second.request], classes: ["NE", "RJ"], identities: 2 }]);
  });

  it("T-D2 a repeat within one identity also withholds", () => {
    const identity = "aaaaaaaa-0000-4000-8000-000000000000";
    const set = [observeNext("PE", { identity, v: "Y".repeat(21) }), observeNext("PE", { identity, v: "Y".repeat(21) })];

    expect(gates([...validSet(), ...set]).reasons).toEqual([REQUEST_ID_VALUE_REPEATED]);
  });

  it("T-D3 stays separate from a duplicate occurrence within one body", () => {
    const twice = `${NEXT_R_PREFIX}${value(1)}${NEXT_R_SUFFIX}${NEXT_R_PREFIX}${value(1)}${NEXT_R_SUFFIX}x}</script>`;
    const result = gates([...validSet(), observeNext("UP", { raw: () => Buffer.from(twice, "latin1") })]);

    expect(result.reasons).toContain(REQUEST_ID_MASK_WITHHELD);
    expect(result.reasons).not.toContain(REQUEST_ID_VALUE_REPEATED);
  });

  it("T-D4 a repeat involving MF is reported only", () => {
    const set = [observeNext("NE", { v: "X".repeat(21) }), observeNext("MF", { v: "X".repeat(21) })];
    const result = gates([...validSet(), ...set]);

    expect(result.reasons).toEqual([]);
    expect(result.repeatedReported.map((repeat) => repeat.classes)).toEqual([["NE", "MF"]]);
  });
});

describe("the guard outcome reaches the decision", () => {
  it.each(["missing", "disagreement", "launch-mismatch", "unreviewed-version"] as const)(
    "T-N4 %s withholds even when bodies and headers agree",
    (guard) => {
      expect(gates(validSet(), guard).reasons).toEqual([NEXT_VERSION_WITHHELD]);
    },
  );
});

describe("the body diagnostic describes signatures and classifies nothing", () => {
  const entries = (spec: Record<string, readonly string[]>) =>
    Object.entries(spec).flatMap(([state, signatures]) => signatures.map((signature, i) => ({ state, signature, identity: `${state}${i}` })));
  const unique = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("T-V1 regression: all-unique signatures (the S-A shape) are counted, not labelled", () => {
    const summary = summarizeBodyVariation(entries({ NE: unique("n", 15), PE: unique("p", 5), RJ: unique("r", 5), UP: unique("u", 5) }));

    expect(summary.label).toBe(BODY_VARIATION_LABEL);
    expect(summary.distinctSignatures).toBe(30);
    expect(summary.perState.PE).toMatchObject({ requests: 5, recurringSignatures: 0, singletonSignatures: 5 });
    expect(summary.overlap.every((pair) => pair.sharedSignatures === 0)).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/state-associated|non-timing/i);
  });

  it("T-V2 a single repeated signature in each state makes no state-associated finding", () => {
    const summary = summarizeBodyVariation(entries({ NE: ["a", "a"], RJ: ["b", "b"] }));

    expect(summary.perState.NE).toMatchObject({ recurringSignatures: 1, requestsInRecurringSignatures: 2 });
    expect(summary.overlap).toEqual([{ first: "NE", second: "RJ", sharedSignatures: 0 }]);
    expect(JSON.stringify(summary)).not.toMatch(/state-associated/i);
  });

  it("T-V3 overlap is reported as a count", () => {
    expect(summarizeBodyVariation(entries({ NE: ["a", "a", "b"], RJ: ["b", "b"] })).overlap).toEqual([{ first: "NE", second: "RJ", sharedSignatures: 1 }]);
  });

  it("T-V4 unique and recurring signatures give the same withholding decision", () => {
    const allUnique = STATES.map((cls, i) => observeNext(cls, { text: `Not available ${i}` }));
    const recurringByState = STATES.map((cls) => observeNext(cls, cls === "RJ" ? { text: "Rejected" } : {}));
    const oneByte = [...validSet(), observeNext("NCB", { text: "Not availabl3" })];

    for (const set of [allUnique, recurringByState, oneByte]) {
      expect(gates(set).reasons).toEqual([BODY_WITHHELD]);
    }
  });

  it("T-V5 the body gate no longer returns separatesStates", () => {
    const result = evaluateBodyGate(STATES.map((cls, i) => observeNext(cls, { text: `Not available ${i}` })));

    expect(result).not.toHaveProperty("separatesStates");
    expect(result.variationSummary.label).toBe(BODY_VARIATION_LABEL);
  });
});

describe("header behaviour is preserved by the body diagnostic change", () => {
  const list = (i: number): string[] => headers({ extra: ["X-Request", String(i)] });

  it("T-H1 compatibility check: all-unique header hashes keep today's literal §11.6.6 label", () => {
    const result = evaluateHeaderGate(STATES.map((cls, i) => observe(cls, { rawHeaders: list(i) })));

    expect(result.label).toBe(HEADER_WITHHELD);
    expect(result.conditionC).toBe(true);
    expect(result.association).toBe(STATE_ASSOCIATED);
  });

  it("T-H2 a body difference changes nothing in the header result", () => {
    const set = STATES.map((cls) => observeNext(cls));
    const before = evaluateHeaderGate(set);
    const after = evaluateHeaderGate(set.map((o, i) => ({ ...o, maskedBodyHash: `changed${i}`, bodyReplacements: 9, status: 500 })));

    expect(after).toEqual(before);
    expect(before.agreement).toBe(true);
  });

  it("T-H3 evaluateE2Gates reports the unchanged header result on the original observations", () => {
    const set = [...validSet(), observeNext("RJ", { rawHeaders: headers({ extra: ["Cache-Control", "private"] }) })];
    const result = gates(set);

    expect(result.headers).toEqual(evaluateHeaderGate(set));
    expect(result.reasons).toEqual([HEADER_WITHHELD]);
  });

  it("T-H4 separatesStates keeps §11.6.6's disjoint-set behaviour", () => {
    expect(separatesStates({ NE: { a: 1 }, RJ: { b: 1 } })).toBe(true);
    expect(separatesStates({ NE: { a: 2, b: 1 }, RJ: { b: 1 } })).toBe(false);
  });

  it("T-H5 the header label draws no body conclusion and does not alter header withholding", () => {
    const set = STATES.map((cls, i) => observeNext(cls, { rawHeaders: list(i) }));
    const result = gates(set);

    expect(result.headers).toEqual(evaluateHeaderGate(set));
    expect(result.headers.association).toBe(STATE_ASSOCIATED);
    expect(result.reasons).toEqual([HEADER_WITHHELD]);
    expect(result.postMask?.agreement).toBe(true);
    expect(JSON.stringify([result.postMask, result.uuidOnly])).not.toMatch(/state-associated/i);
  });
});

describe("an unrelated byte difference still withholds", () => {
  it.each([
    ["elsewhere, across states", "RJ", { text: "Not availablE" }],
    ["elsewhere, between never-existed requests", "NCB", { text: "Not availabl3" }],
    ["inside the same script, after the suffix", "PE", { after: "fetch('?_rsc=DIFF')}" }],
    ["a second nanoid-shaped value", "UP", { before: `self.__next_other="${"B".repeat(21)}";` }],
    ["a one-byte shift before the script", "NE", { before: " " }],
  ] as const)("T-U1 %s", (_name, cls, options) => {
    expect(gates([...validSet(), observeNext(cls, options)]).reasons).toEqual([BODY_WITHHELD]);
  });

  it("T-U2 a differing status or UUID replacement count withholds", () => {
    const set = validSet();

    expect(gates([...set, observeNext("RJ", { status: 404 })]).reasons).toEqual([BODY_WITHHELD]);
    expect(gates([...set, { ...observeNext("PE"), bodyReplacements: 2 }]).reasons).toEqual([BODY_WITHHELD]);
  });
});

describe("diagnostics stay outside the gate", () => {
  it("T-X1 stage 1 keeps the value visible while the post-mask result is reported apart", () => {
    const bodies = [value(101), value(102), value(103)].map((v) => nextBody(PLACEHOLDER, v));
    const diagnosis = diagnoseVariation({ learning: bodies.slice(0, 2), differing: [{ request: 1, body: bodies[2] as Buffer }], ncb: [] });
    const result = gates(validSet());

    expect(diagnosis.perRequest[0]?.edits?.length).toBeGreaterThan(0);
    expect(diagnosis.label).toBe(DIAGNOSTIC_LABEL);
    expect(result.uuidOnly.agreement).toBe(false);
    expect(result.postMask?.agreement).toBe(true);
  });

  it("T-X2 a diagnostic explanation never overrides a failed gate check", () => {
    const learning = ["Not available 1", "Not available 2"].map((text) => nextBody(PLACEHOLDER, value(1), { text }));
    const diagnosis = diagnoseVariation({ learning, differing: [{ request: 99, body: nextBody(PLACEHOLDER, value(1), { text: "Not available 3" }) }], ncb: [] });

    expect(diagnosis.perRequest[0]?.allEditsInsideV).toBe(true);
    expect(gates([...validSet(), observeNext("UP", { text: "Not available 3" })]).reasons).toEqual([BODY_WITHHELD]);
  });
});
