/**
 * The seeded schedule for the `BI-4` timing pilot (issue #246; harness gate revision 5 §4, §5.2;
 * timing Scope Gate revision 4 §3).
 *
 * Everything a run sends is decided here, before anything starts, from one recorded seed: the
 * identities, which class each belongs to, the malformed strings, the calibration conditions and
 * the order of every request. Two runs with the same seed and the same explicit delays send the
 * same requests in the same order.
 *
 * ## What this module decides and what it leaves open
 *
 * It fixes the approved pilot shape (`H-D2`): 20 identities per class per comparison, R = 100
 * measured requests per identity in 100 interleaved blocks, one probe per identity, 20 discarded
 * warm-up blocks and, at E2, 10 route-compile requests. The smoke schedule is the separately
 * approved operational shape (`H-D15`).
 *
 * It decides **no** calibration delay and **no** background population size. Both are supplied
 * by the caller at run authorization (`H-D3`, timing `T-D7`); there is no default for either.
 * Exactly three delays are accepted, because the approved counts assume three.
 *
 * Nothing here measures, judges or thresholds anything.
 */

import { createHash } from "node:crypto";

/** The four states `BI-4` names. */
export type TestClass = "NE" | "PE" | "RJ" | "UP";

/**
 * Every class a planned identity can belong to.
 *
 * - `NCA` / `NCB`: the two disjoint null-control subsets of never-existed identities.
 * - `MF`: malformed identities (unknown size and direction; never a positive control).
 * - `DL`: the E1-only injected-delay control (absent identities behind a busy-wait).
 * - `CAL`: the E2 standalone calibration server's conditions.
 * - `CMP`: the fixed absent identity used for E2 route compilation and readiness only.
 */
export type ItemClass = TestClass | "NCA" | "NCB" | "MF" | "DL" | "CAL" | "CMP";

export type Boundary = "e1" | "e2";
export type Mode = "full" | "smoke";

/** Where a request goes: the in-process operation (E1), `next dev`, or the calibration server. */
export type Target = "operation" | "next" | "calibration";

/** The three balanced comparisons. Each has its own disjoint never-existed subset. */
export type Comparison = "C-PE" | "C-RJ" | "C-UP";

export const COMPARISONS: readonly Comparison[] = ["C-PE", "C-RJ", "C-UP"];

/** The non-public class each comparison sets against its never-existed subset. */
export const COMPARED_CLASS: Readonly<Record<Comparison, TestClass>> = {
  "C-PE": "PE",
  "C-RJ": "RJ",
  "C-UP": "UP",
};

/** Where a calibration delay is placed: nowhere, before the first chunk, or before the final one. */
export type Placement = "none" | "first" | "final";

export interface PlanIdentity {
  readonly index: number;
  /** What is sent: a canonical UUID, a malformed string, or a calibration path's own UUID. */
  readonly key: string;
  readonly cls: ItemClass;
  readonly target: Target;
  /** For `NE` only: the comparison whose never-existed subset this identity belongs to. */
  readonly comparison?: Comparison;
  /** For `DL` and delayed `CAL`: the index into the run's explicit delays. */
  readonly delayIndex?: number;
  /** For `CAL` only. */
  readonly placement?: Placement;
  /** For `CAL` only: the calibration server's condition number (see `calibrationConditions`). */
  readonly condition?: number;
}

export type Phase = "compile" | "probe" | "warmup" | "measured";

export interface PlannedRequest {
  /** Position in the whole run, from 0. */
  readonly sequence: number;
  readonly phase: Phase;
  /** 1-based block number for warm-up and measured blocks; 0 for compile and probe requests. */
  readonly block: number;
  readonly identity: number;
}

export interface Plan {
  readonly boundary: Boundary;
  readonly mode: Mode;
  readonly seed: string;
  readonly delaysNs: readonly number[];
  readonly identities: readonly PlanIdentity[];
  /** Approved, publicly available background rows (timing `T-D7`); count chosen at run time. */
  readonly background: readonly string[];
  readonly requests: readonly PlannedRequest[];
  readonly measuredBlocks: number;
  readonly warmupBlocks: number;
}

/** Identities per class per comparison (timing `T-D5`, approved through `H-D2`). */
export const IDENTITIES_PER_CLASS = 20;
/** Measured requests per evaluated identity: max(k) for the pilot settings k = 1, 10, 100. */
export const MEASURED_BLOCKS = 100;
export const WARMUP_BLOCKS = 20;
export const COMPILE_REQUESTS = 10;

/** The pilot settings for the attacker budget k. Not a policy (timing `T-D4`). */
export const PILOT_K: readonly number[] = [1, 10, 100];

/** Smoke shape (`H-D15`): one identity per group, R_s = 5, one discarded block. */
export const SMOKE_MEASURED_BLOCKS = 5;
export const SMOKE_WARMUP_BLOCKS = 1;
export const SMOKE_COMPILE_REQUESTS = 3;

/** Hard smoke caps across all three passes of one boundary (`H-D15`). */
export const SMOKE_CAPS: Readonly<Record<Boundary, { readonly requests: number; readonly minutes: number }>> = {
  e1: { requests: 200, minutes: 10 },
  e2: { requests: 250, minutes: 30 },
};

/** Hard ceilings per full replicate and for analysis, and the separate teardown allowance (`H-D4`). */
export const PHASE_CEILING_MINUTES = { e1: 20, e2: 75, analysis: 45 } as const;
export const TEARDOWN_ALLOWANCE_MINUTES = 3;

/** The approved counts assume exactly three delay values per boundary (`H-D2`, `H-D3`). */
export const DELAY_COUNT = 3;

/** A canonical lower-case UUID; the shape `OP-2` accepts (case-insensitively) before any query. */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The letters malformed strings are built from: never hexadecimal, never needing URL escaping. */
const MALFORMED_ALPHABET = "ghijklmnopqrstuvwxyz";
const UUID_GROUPS = [8, 4, 4, 4, 12] as const;

/**
 * A seeded generator: xoshiro128** over a state taken from SHA-256 of the seed and a stream name.
 *
 * Separate streams keep, for example, the block order independent of how many identities were
 * drawn, so a change in one concern never silently reshuffles another.
 */
export class SeededRandom {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string, stream: string) {
    const digest = createHash("sha256").update(`${seed}\u0000${stream}`, "utf8").digest();

    this.s0 = digest.readUInt32LE(0);
    this.s1 = digest.readUInt32LE(4);
    this.s2 = digest.readUInt32LE(8);
    this.s3 = digest.readUInt32LE(12);

    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 1;
    }
  }

  /** The next 32-bit unsigned value. */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);

    return result;
  }

  /** A uniform integer in [0, bound), without modulo bias. */
  below(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 2 ** 32) {
      throw new RangeError(`bound must be an integer in 1..2^32, not ${bound}`);
    }

    const limit = 2 ** 32 - (2 ** 32 % bound);

    for (;;) {
      const value = this.nextUint32();

      if (value < limit) {
        return value % bound;
      }
    }
  }

  /** A seeded Fisher–Yates permutation of a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];

    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.below(i + 1);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }

    return copy;
  }
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** A random UUID v4 in canonical lower-case form, drawn from the seeded generator. */
export function seededUuid(random: SeededRandom): string {
  const bytes = Buffer.alloc(16);

  for (let i = 0; i < 16; i += 4) {
    bytes.writeUInt32LE(random.nextUint32(), i);
  }

  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A malformed identity: 36 characters in the UUID's 8-4-4-4-12 hyphen layout, with every other
 * character from `g`–`z`. It is therefore never UUID-shaped, needs no URL escaping, and contains
 * no `/`, `.`, `%` or `?`, so it reaches the same `/directory/[listingId]` route.
 */
export function seededMalformed(random: SeededRandom): string {
  return UUID_GROUPS.map((length) =>
    Array.from({ length }, () => MALFORMED_ALPHABET[random.below(MALFORMED_ALPHABET.length)]).join(""),
  ).join("-");
}

/** Refuse anything but exactly three distinct positive integer delays, in nanoseconds. */
export function validateDelays(delaysNs: readonly number[]): readonly number[] {
  if (delaysNs.length !== DELAY_COUNT) {
    throw new Error(`exactly ${DELAY_COUNT} calibration delays are required (H-D2, H-D3); got ${delaysNs.length}`);
  }

  for (const delay of delaysNs) {
    if (!Number.isSafeInteger(delay) || delay <= 0) {
      throw new Error(`each calibration delay must be a positive integer number of nanoseconds; got ${delay}`);
    }
  }

  if (new Set(delaysNs).size !== delaysNs.length) {
    throw new Error("the calibration delays must be distinct");
  }

  return [...delaysNs];
}

/**
 * The calibration server's conditions: 0 is the undelayed baseline, then each delay before the
 * first chunk, then each delay before the final chunk.
 */
export function calibrationConditions(
  delaysNs: readonly number[],
): readonly { readonly condition: number; readonly placement: Placement; readonly delayIndex?: number }[] {
  return [
    { condition: 0, placement: "none" },
    ...delaysNs.map((_, delayIndex) => ({ condition: 1 + delayIndex, placement: "first" as const, delayIndex })),
    ...delaysNs.map((_, delayIndex) => ({
      condition: 1 + delaysNs.length + delayIndex,
      placement: "final" as const,
      delayIndex,
    })),
  ];
}

interface Slot {
  readonly cls: ItemClass;
  readonly target: Target;
  readonly comparison?: Comparison;
  readonly delayIndex?: number;
  readonly placement?: Placement;
  readonly condition?: number;
}

function repeat(slot: Slot, count: number): Slot[] {
  return Array.from({ length: count }, () => slot);
}

/** The identity slots of one boundary, before keys are drawn and assigned. */
function slotsFor(boundary: Boundary, mode: Mode, delaysNs: readonly number[]): Slot[] {
  const per = mode === "full" ? IDENTITIES_PER_CLASS : 1;
  const testTarget: Target = boundary === "e1" ? "operation" : "next";
  const slots: Slot[] = [];
  const comparisons = mode === "full" ? COMPARISONS : COMPARISONS.slice(0, 1);

  for (const comparison of comparisons) {
    slots.push(...repeat({ cls: "NE", target: testTarget, comparison }, per));
  }

  for (const cls of ["PE", "RJ", "UP", "NCA", "NCB", "MF"] as const) {
    slots.push(...repeat({ cls, target: testTarget }, per));
  }

  if (boundary === "e1") {
    const delayIndexes = mode === "full" ? delaysNs.map((_, index) => index) : [0];

    for (const delayIndex of delayIndexes) {
      slots.push(...repeat({ cls: "DL", target: "operation", delayIndex }, per));
    }
  } else {
    const conditions = calibrationConditions(delaysNs);
    const chosen =
      mode === "full"
        ? conditions
        : conditions.filter(
            (entry) => entry.placement === "none" || entry.delayIndex === 0,
          );

    for (const entry of chosen) {
      slots.push(
        ...repeat(
          {
            cls: "CAL",
            target: "calibration",
            placement: entry.placement,
            condition: entry.condition,
            ...(entry.delayIndex === undefined ? {} : { delayIndex: entry.delayIndex }),
          },
          per,
        ),
      );
    }

    slots.push({ cls: "CMP", target: "next" });
  }

  return slots;
}

export interface PlanRequest {
  readonly boundary: Boundary;
  readonly mode: Mode;
  readonly seed: string;
  readonly delaysNs: readonly number[];
  /** Background population size (timing `T-D7`), explicit; zero is allowed only if chosen. */
  readonly background: number;
}

/** Build the complete, deterministic plan for one boundary replicate or smoke pass. */
export function buildPlan(request: PlanRequest): Plan {
  if (request.seed.trim() === "") {
    throw new Error("an explicit, non-empty seed is required");
  }

  if (!Number.isSafeInteger(request.background) || request.background < 0) {
    throw new Error(`the background population must be a non-negative integer; got ${request.background}`);
  }

  const delaysNs = validateDelays(request.delaysNs);
  const slots = slotsFor(request.boundary, request.mode, delaysNs);

  // 1. Draw every key first; classes are assigned afterwards by a seeded permutation, so every
  //    class is spread evenly across the key space.
  const keyRandom = new SeededRandom(request.seed, "keys");
  const used = new Set<string>();
  const drawUuid = (): string => {
    for (;;) {
      const candidate = seededUuid(keyRandom);

      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  const uuidSlots = slots.filter((slot) => slot.cls !== "MF");
  const malformedSlots = slots.filter((slot) => slot.cls === "MF");
  const uuidKeys = uuidSlots.map(() => drawUuid());
  const background = Array.from({ length: request.background }, () => drawUuid());

  const malformedRandom = new SeededRandom(request.seed, "malformed");
  const malformed = new Set<string>();

  while (malformed.size < malformedSlots.length) {
    malformed.add(seededMalformed(malformedRandom));
  }

  const assignment = new SeededRandom(request.seed, "assignment").shuffle(uuidSlots);
  const identities: PlanIdentity[] = [];

  assignment.forEach((slot, position) => {
    identities.push({ index: identities.length, key: uuidKeys[position] as string, ...slot });
  });

  [...malformed].forEach((key, position) => {
    identities.push({ index: identities.length, key, ...(malformedSlots[position] as Slot) });
  });

  // 2. Order: compile requests (E2), one probe per identity, discarded blocks, measured blocks.
  //    Each block holds one request per identity in a seeded random order.
  const orderRandom = new SeededRandom(request.seed, "order");
  const blockMembers = identities.filter((identity) => identity.cls !== "CMP").map((identity) => identity.index);
  const compile = identities.find((identity) => identity.cls === "CMP");
  const measuredBlocks = request.mode === "full" ? MEASURED_BLOCKS : SMOKE_MEASURED_BLOCKS;
  const warmupBlocks = request.mode === "full" ? WARMUP_BLOCKS : SMOKE_WARMUP_BLOCKS;
  const compileCount = request.mode === "full" ? COMPILE_REQUESTS : SMOKE_COMPILE_REQUESTS;
  const requests: PlannedRequest[] = [];
  const push = (phase: Phase, block: number, identity: number): void => {
    requests.push({ sequence: requests.length, phase, block, identity });
  };

  if (compile !== undefined) {
    for (let i = 0; i < compileCount; i += 1) {
      push("compile", 0, compile.index);
    }
  }

  for (const identity of orderRandom.shuffle(blockMembers)) {
    push("probe", 0, identity);
  }

  for (let block = 1; block <= warmupBlocks; block += 1) {
    for (const identity of orderRandom.shuffle(blockMembers)) {
      push("warmup", block, identity);
    }
  }

  for (let block = 1; block <= measuredBlocks; block += 1) {
    for (const identity of orderRandom.shuffle(blockMembers)) {
      push("measured", block, identity);
    }
  }

  return {
    boundary: request.boundary,
    mode: request.mode,
    seed: request.seed,
    delaysNs,
    identities,
    background,
    requests,
    measuredBlocks,
    warmupBlocks,
  };
}

export interface PlanCounts {
  readonly total: number;
  readonly byTarget: Readonly<Record<Target, number>>;
  readonly byPhase: Readonly<Record<Phase, number>>;
  readonly measuredByClass: Readonly<Partial<Record<ItemClass, number>>>;
  readonly identitiesByClass: Readonly<Partial<Record<ItemClass, number>>>;
}

/** Count a plan's requests, for the manifest and for the cap and ceiling checks. */
export function countsOf(plan: Plan): PlanCounts {
  const byTarget: Record<Target, number> = { operation: 0, next: 0, calibration: 0 };
  const byPhase: Record<Phase, number> = { compile: 0, probe: 0, warmup: 0, measured: 0 };
  const measuredByClass: Partial<Record<ItemClass, number>> = {};
  const identitiesByClass: Partial<Record<ItemClass, number>> = {};

  for (const identity of plan.identities) {
    identitiesByClass[identity.cls] = (identitiesByClass[identity.cls] ?? 0) + 1;
  }

  for (const request of plan.requests) {
    const identity = plan.identities[request.identity] as PlanIdentity;

    byTarget[identity.target] += 1;
    byPhase[request.phase] += 1;

    if (request.phase === "measured") {
      measuredByClass[identity.cls] = (measuredByClass[identity.cls] ?? 0) + 1;
    }
  }

  return { total: plan.requests.length, byTarget, byPhase, measuredByClass, identitiesByClass };
}
