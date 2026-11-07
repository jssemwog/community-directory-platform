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
  BODY_WITHHELD,
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
