/**
 * Analysis for the `BI-4` timing pilot (issue #246; timing Scope Gate revision 4 §5; harness gate
 * revision 5 §1, §5.4, §11).
 *
 * ## What it computes
 *
 * Per comparison and per metric (E1 elapsed; E2 TTFB and TTLB, each for all requests and for
 * reused-socket requests only):
 *
 * - the difference in medians and in 10th percentiles, with 95% percentile intervals from a
 *   **two-way cluster bootstrap** that resamples identities within each class and the time blocks
 *   independently, weighting each request by the product of the two draw counts;
 * - variance components, the intra-identity correlation, the design effect against an
 *   independent-requests bootstrap, and the drift trend in per-block medians;
 * - held-out accuracy of a one-threshold classifier on the median of k requests, for the pilot
 *   settings k = 1, 10 and 100. Folds are grouped by identity; the classifier is **refit inside
 *   every bootstrap replicate**; a resampled identity's copies always share a fold. The temporal
 *   holdout (train on blocks 1–50, evaluate on 51–100) is computed **only for k = 1 and 10**;
 *   k = 100 comes from the identity-held-out analysis only;
 * - identity-level medians with a heterogeneity test, and **exploratory** precision projections
 *   of the median and p10 half-widths. Precision projections of classifier accuracy are a
 *   **proposed deferral** (`PROPOSED_DEFERRALS`); held-out accuracy and its interval are still
 *   reported at every pilot k.
 *
 * The rules that turn intervals into labels were left unspecified by timing r4. They are
 * exploratory, not owner-ratified, and are listed in every report (`EXPLORATORY_CONTROL_RULES`).
 *
 * ## The analysis deadline is cooperative, not a hard ceiling
 *
 * The 45-minute deadline (`H-D4`) is checked cooperatively by the analysis itself: once per
 * iteration of every bootstrap, cross-validation, simulation and evidence loop, and at each stage
 * boundary. When a check finds the deadline passed, the analysis stops. It is reported as
 * **incomplete**, and whatever finished is written to `incomplete/` as a partial report. A completed
 * `report.json`/`report.md` is never written for an incomplete analysis.
 *
 * **Deviation from a hard ceiling:** nothing outside the analysis process enforces the deadline.
 * Work between two checks can overrun it: one iteration, reading and parsing the run,
 * `diagnoseVariation`, rendering and writing the report. A hung or stalled process is not
 * terminated. No watchdog or separate process kills the analysis at 45 minutes.
 *
 * ## What it never does
 *
 * It applies no threshold and issues no verdict. A result is "difference detected" (a lead; at E1
 * diagnostic only), "not detected" with the interval width, "Invalid" with the reason, or one of
 * the "Withheld" labels from the gates. It refuses smoke-mode data. `BI-4` stays pending whatever
 * it reports.
 *
 * ## E2 bodies (approved amendment revision 4: §7.3, §11.2A, §11.3, §11.4, §11.4A)
 *
 * The stored UUID-masked bodies are read and verified against their recorded hashes; an absent or
 * mismatched body is a `missing` mask outcome. The Next.js version guard, the request-ID mask, the
 * repeated-value check, post-mask exact agreement and the unchanged header gate all withhold. An
 * E2 body mismatch is **withheld, not Invalid** (§11.4A): it is described, never called
 * state-associated or a possible non-timing `BI-4` finding, and any independent Invalid condition
 * is still reported and takes priority. The diagnostic model runs on the UUID-masked bodies,
 * before the request-ID mask, whenever they differ, and never lifts withholding.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  compareMalformed,
  diagnoseVariation,
  evaluateE2Gates,
  listingStateOf,
  maskNextRequestId,
  POST_MASK_NOT_ESTABLISHED,
  POST_MASK_SUBSET_LABEL,
  postMaskObservation,
  sha256Hex,
  unmaskAt,
  type BodyGateResult,
  type E2GateResult,
  type E2Observation,
  type HeaderGateResult,
  type RequestIdMaskResult,
} from "./body-compare";
import { explainNextVersionGuard, type LockfileByteMatch, type NextVersionEvidence } from "./next-evidence";
import {
  COMPARED_CLASS,
  COMPARISONS,
  PILOT_K,
  SeededRandom,
  type Boundary,
  type Comparison,
  type ItemClass,
  type Mode,
  type PlanIdentity,
  type Phase,
  type Target,
} from "./schedule";

// ---------------------------------------------------------------------------------------------
// The on-disk run format, written by the runners and read here.
// ---------------------------------------------------------------------------------------------

/** One request, as written to `requests.ndjson`. Times are nanoseconds as decimal strings. */
export interface MeasurementRecord {
  readonly sequence: number;
  readonly phase: Phase;
  readonly block: number;
  readonly identity: number;
  readonly cls: ItemClass;
  readonly target: Target;
  /** E1: the awaited call's elapsed time. */
  readonly elapsedNs?: string;
  /** E1: SHA-256 of the returned value's canonical serialization. */
  readonly valueHash?: string;
  /** E1: whether the returned error is the same frozen reference every never-existed call got. */
  readonly sharedErrorReference?: boolean;
  /** E2 timing events, measured from t₀ immediately before `request.end()`. */
  readonly ttfbNs?: string;
  readonly firstBodyNs?: string;
  readonly ttlbNs?: string;
  readonly status?: number;
  readonly reusedSocket?: boolean;
  readonly localPort?: number;
  readonly rawBodyHash?: string;
  readonly maskedBodyHash?: string;
  readonly bodyReplacements?: number;
  readonly bodyOffsets?: readonly number[];
  /** The raw header list exactly as `rawHeaders` gave it, preserved for every request. */
  readonly rawHeaders?: readonly string[];
  readonly rawHeaderHash?: string;
  readonly writeStartMs?: number;
  readonly responseEndMs?: number;
  readonly contentEncoding?: string;
  readonly transportError?: string;
}

/** The run manifest, written before measurement and completed afterwards. */
export interface RunManifest {
  readonly mode: Mode;
  readonly boundary: Boundary;
  readonly pass?: string;
  readonly replicate?: number;
  readonly seed: string;
  readonly delaysNs: readonly number[];
  readonly backgroundCount: number;
  readonly commit: string;
  readonly identities: readonly PlanIdentity[];
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly environment?: Readonly<Record<string, unknown>>;
  /** Reasons recorded by the runner that make the run Invalid (file safety, stored state, …). */
  readonly invalid: readonly string[];
  /** E2: the Next.js version evidence (amendment §4). Absent in runs made before it existed. */
  readonly nextEvidence?: NextVersionEvidence;
  /** Present only on a V-A validation pass (amendment r5 A5-3). Such a run is also `mode: "smoke"`, so `analyze` refuses it. */
  readonly validation?: typeof VALIDATION_MARKER;
}

/** The marker a V-A validation pass carries in its manifest. */
export const VALIDATION_MARKER = "e2-evidence";

/**
 * The stored UUID-masked body for a hash, already verified against that hash, or `undefined`
 * when it is absent, unreadable or mismatched.
 */
export type BodySource = (maskedBodyHash: string) => Buffer | undefined;

/** Refuse anything but full-pilot data (§5.4). */
export function assertFullPilot(manifest: Pick<RunManifest, "mode">): void {
  if (manifest.mode !== "full") {
    throw new Error(`analyze refuses ${manifest.mode}-mode data: smoke results are operational checks only (§5.4)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Statistics.
// ---------------------------------------------------------------------------------------------

/** One measured value: which identity, which class, which block. */
export interface Observation {
  readonly identity: string;
  readonly block: number;
  readonly value: number;
  readonly reused?: boolean;
}

/**
 * The lower weighted quantile: the smallest value whose cumulative weight reaches q of the total.
 * `sorted` must be ascending; `weights` aligns with it. With unit weights it is the plain quantile.
 */
export function weightedQuantile(sorted: readonly number[], weights: readonly number[], q: number): number {
  let total = 0;

  for (const weight of weights) total += weight;

  if (total <= 0) {
    return Number.NaN;
  }

  const target = q * total;
  let cumulative = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    cumulative += weights[i] as number;

    if (cumulative >= target && (weights[i] as number) > 0) {
      return sorted[i] as number;
    }
  }

  return sorted[sorted.length - 1] as number;
}

export function quantileOf(values: readonly number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return weightedQuantile(sorted, sorted.map(() => 1), q);
}

export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function percentileInterval(estimates: readonly number[]): readonly [number, number] {
  const finite = estimates.filter(Number.isFinite).sort((x, y) => x - y);
  if (finite.length === 0) return [Number.NaN, Number.NaN];
  const at = (q: number): number => finite[Math.min(finite.length - 1, Math.max(0, Math.floor(q * (finite.length - 1))))] as number;
  return [at(0.025), at(0.975)];
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

interface PreparedClass {
  readonly values: readonly number[];
  readonly identityOf: readonly number[];
  readonly blockOf: readonly number[];
  readonly identities: readonly string[];
}

function prepare(observations: readonly Observation[]): PreparedClass {
  const sorted = [...observations].sort((x, y) => x.value - y.value);
  const identities = [...new Set(observations.map((observation) => observation.identity))].sort();
  const index = new Map(identities.map((identity, position) => [identity, position]));

  return {
    values: sorted.map((observation) => observation.value),
    identityOf: sorted.map((observation) => index.get(observation.identity) as number),
    blockOf: sorted.map((observation) => observation.block),
    identities,
  };
}

/** Thrown from inside a computation loop once the analysis ceiling has passed. */
export class AnalysisCeilingReached extends Error {
  constructor() {
    super("the cooperative analysis deadline was reached");
    this.name = "AnalysisCeilingReached";
  }
}

/**
 * Called once per loop iteration; throws `AnalysisCeilingReached` after the deadline. Cooperative:
 * it only fires when called, so it bounds the work between two calls, not the process.
 */
export type Checkpoint = () => void;

export const NO_CHECKPOINT: Checkpoint = () => {};

export function ceilingCheckpoint(deadline: number | undefined, now: () => number = Date.now): Checkpoint {
  if (deadline === undefined) return NO_CHECKPOINT;
  return () => {
    if (now() > deadline) throw new AnalysisCeilingReached();
  };
}

export interface LocationResult {
  readonly q: number;
  /** Quantile of the second group minus quantile of the first. */
  readonly estimate: number;
  readonly interval: readonly [number, number];
  /** The same interval from an independent-requests bootstrap, for the design effect. */
  readonly independentInterval: readonly [number, number];
  readonly designEffect: number;
}

/**
 * The two-way cluster bootstrap of a quantile difference (timing r4 §5.1): identities resampled
 * within each class, blocks resampled independently, each request weighted by the product of its
 * identity's and its block's draw counts.
 */
export function clusterBootstrapDifference(
  first: readonly Observation[],
  second: readonly Observation[],
  q: number,
  replicates: number,
  random: SeededRandom,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): LocationResult {
  const a = prepare(first);
  const b = prepare(second);
  const blocks = [...new Set([...first, ...second].map((observation) => observation.block))].sort((x, y) => x - y);
  const blockIndex = new Map(blocks.map((block, position) => [block, position]));
  const unit = (prepared: PreparedClass): number[] => prepared.values.map(() => 1);
  const estimate = weightedQuantile(b.values, unit(b), q) - weightedQuantile(a.values, unit(a), q);
  const draws = (size: number): Uint32Array => {
    const counts = new Uint32Array(size);
    for (let i = 0; i < size; i += 1) counts[random.below(size)] += 1;
    return counts;
  };
  const weighted = (prepared: PreparedClass, identityCounts: Uint32Array, blockCounts: Uint32Array): number =>
    weightedQuantile(
      prepared.values,
      prepared.values.map(
        (_, i) =>
          (identityCounts[prepared.identityOf[i] as number] as number) *
          (blockCounts[blockIndex.get(prepared.blockOf[i] as number) as number] as number),
      ),
      q,
    );
  const clustered: number[] = [];
  const independent: number[] = [];

  for (let r = 0; r < replicates; r += 1) {
    checkpoint();
    const blockCounts = draws(blocks.length);
    clustered.push(
      weighted(b, draws(b.identities.length), blockCounts) - weighted(a, draws(a.identities.length), blockCounts),
    );
    independent.push(
      weightedQuantile(b.values, Array.from(draws(b.values.length)), q) -
        weightedQuantile(a.values, Array.from(draws(a.values.length)), q),
    );
  }

  return {
    q,
    estimate,
    interval: percentileInterval(clustered),
    independentInterval: percentileInterval(independent),
    designEffect: variance(clustered) / variance(independent),
  };
}

export interface VarianceComponents {
  readonly identity: number;
  readonly block: number;
  readonly residual: number;
  readonly intraIdentityCorrelation: number;
}

/**
 * Method-of-moments components for a crossed identity × block layout with one request per cell;
 * negative estimates are clipped to zero.
 */
export function varianceComponents(observations: readonly Observation[]): VarianceComponents {
  const identities = [...new Set(observations.map((observation) => observation.identity))];
  const blocks = [...new Set(observations.map((observation) => observation.block))];
  const I = identities.length;
  const B = blocks.length;
  const grand = observations.reduce((sum, observation) => sum + observation.value, 0) / observations.length;
  const meanBy = (key: (observation: Observation) => string | number): Map<string | number, number> => {
    const sums = new Map<string | number, { sum: number; count: number }>();
    for (const observation of observations) {
      const entry = sums.get(key(observation)) ?? { sum: 0, count: 0 };
      entry.sum += observation.value;
      entry.count += 1;
      sums.set(key(observation), entry);
    }
    return new Map([...sums].map(([k, { sum, count }]) => [k, sum / count]));
  };
  const identityMeans = meanBy((observation) => observation.identity);
  const blockMeans = meanBy((observation) => observation.block);
  let ssIdentity = 0;
  let ssBlock = 0;
  let ssResidual = 0;

  for (const mean of identityMeans.values()) ssIdentity += B * (mean - grand) ** 2;
  for (const mean of blockMeans.values()) ssBlock += I * (mean - grand) ** 2;
  for (const observation of observations) {
    ssResidual +=
      (observation.value -
        (identityMeans.get(observation.identity) as number) -
        (blockMeans.get(observation.block) as number) +
        grand) **
      2;
  }

  const msResidual = ssResidual / Math.max(1, (I - 1) * (B - 1));
  const identity = Math.max(0, (ssIdentity / Math.max(1, I - 1) - msResidual) / B);
  const block = Math.max(0, (ssBlock / Math.max(1, B - 1) - msResidual) / I);
  const total = identity + block + msResidual;

  return { identity, block, residual: msResidual, intraIdentityCorrelation: total > 0 ? identity / total : Number.NaN };
}

/** Ordinary least-squares slope of per-block medians on block number. */
export function driftSlope(observations: readonly Observation[]): number {
  const byBlock = new Map<number, number[]>();
  for (const observation of observations) byBlock.set(observation.block, [...(byBlock.get(observation.block) ?? []), observation.value]);
  const points = [...byBlock].map(([block, values]) => [block, medianOf(values)] as const);
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const sxx = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return sxx === 0 ? Number.NaN : points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / sxx;
}

// ---------------------------------------------------------------------------------------------
// The classifier and its held-out accuracy (timing r4 §5.2).
// ---------------------------------------------------------------------------------------------

/** One identity's requests, keyed by block, with its class label (1 = the compared class). */
export interface Series {
  readonly identity: string;
  readonly label: 0 | 1;
  readonly byBlock: ReadonlyMap<number, number>;
}

export interface Threshold {
  readonly threshold: number;
  /** `high`: predict the compared class above the threshold; `low`: below it. */
  readonly direction: "high" | "low";
}

export type Fitter = (values: readonly number[], labels: readonly (0 | 1)[]) => Threshold;

/**
 * Fit the single threshold that maximizes training accuracy. Fixed in advance: no model
 * selection and no tuning beyond the threshold. Ties go to the earliest cut, `high` first.
 */
export const fitThreshold: Fitter = (values, labels) => {
  const order = values.map((_, i) => i).sort((x, y) => (values[x] as number) - (values[y] as number));
  const positives = labels.reduce<number>((sum, label) => sum + label, 0);
  const negatives = labels.length - positives;
  let best: Threshold = { threshold: (values[order[0] as number] ?? 0) - 1, direction: "high" };
  let bestCorrect = positives;
  let lowCorrect = negatives;

  if (lowCorrect > bestCorrect) {
    best = { threshold: best.threshold, direction: "low" };
    bestCorrect = lowCorrect;
  }

  let zerosBelow = 0;
  let onesBelow = 0;

  for (let position = 0; position < order.length; position += 1) {
    const i = order[position] as number;
    if (labels[i] === 1) onesBelow += 1;
    else zerosBelow += 1;

    const next = order[position + 1];
    const current = values[i] as number;

    if (next !== undefined && (values[next] as number) === current) {
      continue;
    }

    const threshold = next === undefined ? current + 1 : (current + (values[next] as number)) / 2;
    const highCorrect = zerosBelow + (positives - onesBelow);
    lowCorrect = onesBelow + (negatives - zerosBelow);

    if (highCorrect > bestCorrect) {
      best = { threshold, direction: "high" };
      bestCorrect = highCorrect;
    }

    if (lowCorrect > bestCorrect) {
      best = { threshold, direction: "low" };
      bestCorrect = lowCorrect;
    }
  }

  return best;
};

export function predict(model: Threshold, value: number): 0 | 1 {
  return model.direction === "high" ? (value > model.threshold ? 1 : 0) : value < model.threshold ? 1 : 0;
}

/**
 * Disjoint k-subsets from consecutive blocks in the given block sequence, each reduced to its
 * median. Missing blocks (a transport failure) are skipped; an incomplete final subset is dropped.
 */
export function kSubsetMedians(series: Series, blockSequence: readonly number[], k: number): readonly number[] {
  const values = blockSequence.flatMap((block) => {
    const value = series.byBlock.get(block);
    return value === undefined ? [] : [value];
  });
  const medians: number[] = [];

  for (let start = 0; start + k <= values.length; start += k) {
    medians.push(medianOf(values.slice(start, start + k)));
  }

  return medians;
}

export const FOLDS = 5;

/**
 * Grouped, stratified folds: each label's distinct original identities are shuffled and dealt
 * round-robin. Copies of a resampled identity share its original ID, so they share a fold, and a
 * copy can never train and evaluate on itself.
 */
export function assignFolds(series: readonly Series[], random: SeededRandom): ReadonlyMap<string, number> {
  const folds = new Map<string, number>();

  for (const label of [0, 1] as const) {
    const distinct = [...new Set(series.filter((entry) => entry.label === label).map((entry) => entry.identity))].sort();

    random.shuffle(distinct).forEach((identity, position) => folds.set(identity, position % FOLDS));
  }

  return folds;
}

export interface AccuracyInput {
  readonly series: readonly Series[];
  readonly k: number;
  /** Blocks used for training units and for evaluation units. Identical unless temporal. */
  readonly trainBlocks: readonly number[];
  readonly testBlocks: readonly number[];
  readonly folds: ReadonlyMap<string, number>;
  readonly fit?: Fitter;
}

/** Pooled held-out accuracy over all folds, plus each fold's accuracy (descriptive only). */
export function heldOutAccuracy(input: AccuracyInput): { readonly accuracy: number; readonly perFold: readonly number[] } {
  const fit = input.fit ?? fitThreshold;
  let correct = 0;
  let total = 0;
  const perFold: number[] = [];

  for (let fold = 0; fold < FOLDS; fold += 1) {
    const training = input.series.filter((entry) => input.folds.get(entry.identity) !== fold);
    const heldOut = input.series.filter((entry) => input.folds.get(entry.identity) === fold);

    if (heldOut.length === 0 || training.length === 0) {
      continue;
    }

    const values: number[] = [];
    const labels: (0 | 1)[] = [];

    for (const entry of training) {
      for (const median of kSubsetMedians(entry, input.trainBlocks, input.k)) {
        values.push(median);
        labels.push(entry.label);
      }
    }

    const model = fit(values, labels);
    let foldCorrect = 0;
    let foldTotal = 0;

    for (const entry of heldOut) {
      for (const median of kSubsetMedians(entry, input.testBlocks, input.k)) {
        foldCorrect += predict(model, median) === entry.label ? 1 : 0;
        foldTotal += 1;
      }
    }

    correct += foldCorrect;
    total += foldTotal;
    perFold.push(foldTotal === 0 ? Number.NaN : foldCorrect / foldTotal);
  }

  return { accuracy: total === 0 ? Number.NaN : correct / total, perFold };
}

export interface AccuracyResult {
  readonly k: number;
  readonly variant: "identity-held-out" | "temporal-holdout";
  /** Mean over repeated cross-validation with different seeded fold assignments. */
  readonly estimate: number;
  readonly interval: readonly [number, number];
  /** Fold-to-fold spread from the first repeat. Descriptive only; never a standard error. */
  readonly foldSpread: readonly number[];
}

export interface AccuracyOptions {
  readonly replicates: number;
  readonly repeats: number;
  readonly random: SeededRandom;
  readonly fit?: Fitter;
  readonly checkpoint?: Checkpoint;
}

/** Which k values may use the temporal holdout: each half holds 50 requests per identity. */
export const TEMPORAL_K: readonly number[] = [1, 10];

/**
 * Held-out accuracy at one k, its point estimate over repeated cross-validation, and its 95%
 * percentile interval from the two-way cluster bootstrap with the classifier **refit inside every
 * replicate**.
 */
export function classifierAccuracy(
  series: readonly Series[],
  blocks: readonly number[],
  k: number,
  variant: AccuracyResult["variant"],
  options: AccuracyOptions,
): AccuracyResult {
  if (variant === "temporal-holdout" && !TEMPORAL_K.includes(k)) {
    throw new Error(`the temporal holdout applies only to k = 1 and 10; k = ${k} is reported identity-held-out only`);
  }

  const sortedBlocks = [...blocks].sort((x, y) => x - y);
  const half = Math.floor(sortedBlocks.length / 2);
  const firstHalf = sortedBlocks.slice(0, half);
  const secondHalf = sortedBlocks.slice(half);
  const split = (sequence: readonly number[]) =>
    variant === "temporal-holdout"
      ? { trainBlocks: sequence.filter((block) => firstHalf.includes(block)), testBlocks: sequence.filter((block) => secondHalf.includes(block)) }
      : { trainBlocks: sequence, testBlocks: sequence };

  const repeats: number[] = [];
  let foldSpread: readonly number[] = [];

  const checkpoint = options.checkpoint ?? NO_CHECKPOINT;

  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    checkpoint();
    const result = heldOutAccuracy({
      series,
      k,
      ...split(sortedBlocks),
      folds: assignFolds(series, options.random),
      ...(options.fit === undefined ? {} : { fit: options.fit }),
    });

    repeats.push(result.accuracy);
    if (repeat === 0) foldSpread = result.perFold;
  }

  const byLabel = [0, 1].map((label) => series.filter((entry) => entry.label === label));
  const estimates: number[] = [];

  for (let r = 0; r < options.replicates; r += 1) {
    checkpoint();
    // Identities within each class and blocks (within each half, for the temporal variant) are
    // resampled; folds are reassigned on the resampled set and the classifier refit per fold.
    const resampled = byLabel.flatMap((group) => Array.from({ length: group.length }, () => group[options.random.below(group.length)] as Series));
    const drawBlocks = (pool: readonly number[]): number[] =>
      Array.from({ length: pool.length }, () => pool[options.random.below(pool.length)] as number).sort((x, y) => x - y);
    const sequence =
      variant === "temporal-holdout" ? [...drawBlocks(firstHalf), ...drawBlocks(secondHalf)] : drawBlocks(sortedBlocks);
    const train = variant === "temporal-holdout" ? sequence.slice(0, firstHalf.length) : sequence;
    const test = variant === "temporal-holdout" ? sequence.slice(firstHalf.length) : sequence;

    estimates.push(
      heldOutAccuracy({
        series: resampled,
        k,
        trainBlocks: train,
        testBlocks: test,
        folds: assignFolds(resampled, options.random),
        ...(options.fit === undefined ? {} : { fit: options.fit }),
      }).accuracy,
    );
  }

  return {
    k,
    variant,
    estimate: repeats.reduce((sum, value) => sum + value, 0) / repeats.length,
    interval: percentileInterval(estimates),
    foldSpread,
  };
}

// ---------------------------------------------------------------------------------------------
// Identity-level reporting and exploratory projections.
// ---------------------------------------------------------------------------------------------

/** Regularized upper incomplete gamma Q(a, x), for the chi-square survival function. */
function upperGamma(a: number, x: number): number {
  if (x <= 0) return 1;
  const lnGammaA = logGamma(a);

  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGammaA);
  }

  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGammaA) * h;
}

function logGamma(z: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = coefficients[0] as number;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += (coefficients[i] as number) / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export interface IdentityReport {
  readonly cls: string;
  readonly medians: Readonly<Record<string, number>>;
  /** Kruskal–Wallis across the class's identities. Descriptive; no threshold is applied. */
  readonly kruskalWallisH: number;
  readonly degreesOfFreedom: number;
  readonly pValue: number;
  /** Identities whose median lies more than 3 scaled MADs from the class median. Flagged, never dropped. */
  readonly flagged: readonly string[];
}

export function identityReport(cls: string, observations: readonly Observation[]): IdentityReport {
  const byIdentity = new Map<string, number[]>();
  for (const observation of observations) {
    byIdentity.set(observation.identity, [...(byIdentity.get(observation.identity) ?? []), observation.value]);
  }

  const ranked = [...observations].sort((x, y) => x.value - y.value);
  const ranks = new Map<Observation, number>();
  for (let i = 0; i < ranked.length; ) {
    let j = i;
    while (j + 1 < ranked.length && (ranked[j + 1] as Observation).value === (ranked[i] as Observation).value) j += 1;
    for (let t = i; t <= j; t += 1) ranks.set(ranked[t] as Observation, (i + j) / 2 + 1);
    i = j + 1;
  }

  const n = observations.length;
  let h = 0;
  const rankSums = new Map<string, { sum: number; count: number }>();
  for (const observation of observations) {
    const entry = rankSums.get(observation.identity) ?? { sum: 0, count: 0 };
    entry.sum += ranks.get(observation) as number;
    entry.count += 1;
    rankSums.set(observation.identity, entry);
  }
  for (const { sum, count } of rankSums.values()) h += (sum * sum) / count;
  h = (12 / (n * (n + 1))) * h - 3 * (n + 1);

  const medians = Object.fromEntries([...byIdentity].map(([identity, values]) => [identity, medianOf(values)]));
  const centre = medianOf(Object.values(medians));
  const mad = 1.4826 * medianOf(Object.values(medians).map((value) => Math.abs(value - centre)));
  const degreesOfFreedom = byIdentity.size - 1;

  return {
    cls,
    medians,
    kruskalWallisH: h,
    degreesOfFreedom,
    pValue: degreesOfFreedom > 0 ? upperGamma(degreesOfFreedom / 2, h / 2) : Number.NaN,
    flagged: Object.entries(medians)
      .filter(([, value]) => mad > 0 && Math.abs(value - centre) > 3 * mad)
      .map(([identity]) => identity),
  };
}

export interface Projection {
  readonly label: "EXPLORATORY";
  readonly identitiesPerClass: number;
  readonly requestsPerIdentity: number;
  readonly medianHalfWidth: number;
  readonly p10HalfWidth: number;
}

/**
 * EXPLORATORY precision projections (timing r4 §5.4): simulate from the fitted identity, block and
 * residual components (Gaussian, no effect) and report 1.96 × the spread of the estimator. They
 * rest on two local runs and are never a sample-size requirement or a threshold.
 *
 * Only location half-widths are projected. Projecting held-out classifier accuracy at each k
 * (also named in timing r4 §5.4) is a proposed deferral; see `PROPOSED_DEFERRALS`.
 */
export function projectPrecision(
  components: VarianceComponents,
  grid: readonly { readonly identitiesPerClass: number; readonly requestsPerIdentity: number }[],
  simulations: number,
  random: SeededRandom,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): readonly Projection[] {
  const normal = (): number => {
    const u = (random.nextUint32() + 1) / 4_294_967_297;
    const v = (random.nextUint32() + 1) / 4_294_967_297;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  return grid.map(({ identitiesPerClass, requestsPerIdentity }) => {
    const medianDifferences: number[] = [];
    const p10Differences: number[] = [];

    for (let s = 0; s < simulations; s += 1) {
      checkpoint();
      const blockEffects = Array.from({ length: requestsPerIdentity }, () => normal() * Math.sqrt(components.block));
      const draw = (): number[] => {
        const values: number[] = [];
        for (let i = 0; i < identitiesPerClass; i += 1) {
          const identityEffect = normal() * Math.sqrt(components.identity);
          for (let b = 0; b < requestsPerIdentity; b += 1) {
            values.push(identityEffect + (blockEffects[b] as number) + normal() * Math.sqrt(components.residual));
          }
        }
        return values;
      };
      const first = draw();
      const second = draw();
      medianDifferences.push(quantileOf(second, 0.5) - quantileOf(first, 0.5));
      p10Differences.push(quantileOf(second, 0.1) - quantileOf(first, 0.1));
    }

    return {
      label: "EXPLORATORY",
      identitiesPerClass,
      requestsPerIdentity,
      medianHalfWidth: 1.96 * Math.sqrt(variance(medianDifferences)),
      p10HalfWidth: 1.96 * Math.sqrt(variance(p10Differences)),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Putting a run together.
// ---------------------------------------------------------------------------------------------

/**
 * The exploratory rules this analysis applies where timing r4 left the choice open. None is
 * owner-ratified; each is listed in every report so a reader sees exactly what produced a label.
 */
export const EXPLORATORY_CONTROL_RULES: readonly string[] = [
  "Positive control (E1-PC; E2-CAL first- and final-chunk): consistent when the 95% two-way cluster-bootstrap interval of the median difference covers the expected difference (E1 elapsed d; E2 first-chunk TTFB and TTLB d; E2 final-chunk TTFB 0 and TTLB d). Checked on all requests; an interval that misses it marks the replicate Invalid (control).",
  "Null comparison (NC-A vs NC-B): fired when its median or p10 interval excludes 0, or when any held-out accuracy interval lies entirely above 0.50; a fired null marks the replicate Invalid (null fired).",
  "Difference detected (an exploratory lead only): the median or p10 interval excludes 0, or a held-out accuracy interval lies entirely above 0.50.",
  "Identity heterogeneity: Kruskal-Wallis H with its chi-square p-value, descriptive only; no threshold is applied.",
  "Identity flag: an identity median more than 3 scaled MADs (1.4826 x MAD) from its class median is flagged, never dropped.",
];

/** Work the analysis does not do, proposed for an owner ruling rather than silently omitted. */
export const PROPOSED_DEFERRALS: readonly string[] = [
  "Classifier-accuracy precision projections (timing r4 §5.4: projected held-out accuracy at each k) are not computed; proposed for deferral. Held-out accuracy at k = 1, 10 and 100, with its 95% two-way cluster-bootstrap interval (classifier refit in every replicate), is still reported for every non-control comparison.",
];

export type Metric = "elapsed" | "ttfb" | "ttlb";

export interface ComparisonPlan {
  readonly name: string;
  readonly role: "test" | "null" | "malformed" | "control";
  readonly first: (identity: PlanIdentity) => boolean;
  readonly second: (identity: PlanIdentity) => boolean;
  /** For controls: the expected difference per metric, in nanoseconds. */
  readonly expected?: Partial<Record<Metric, number>>;
}

/** Every comparison a boundary reports. Controls are defined per boundary (timing r4 §4). */
export function comparisonsFor(boundary: Boundary, delaysNs: readonly number[]): readonly ComparisonPlan[] {
  const plans: ComparisonPlan[] = COMPARISONS.map((comparison: Comparison) => ({
    name: comparison,
    role: "test",
    first: (identity) => identity.cls === "NE" && identity.comparison === comparison,
    second: (identity) => identity.cls === COMPARED_CLASS[comparison],
  }));

  plans.push({ name: "NC (NC-A vs NC-B)", role: "null", first: (i) => i.cls === "NCA", second: (i) => i.cls === "NCB" });
  plans.push({ name: "MF vs NC-B (unknown size and direction)", role: "malformed", first: (i) => i.cls === "NCB", second: (i) => i.cls === "MF" });

  delaysNs.forEach((delay, delayIndex) => {
    if (boundary === "e1") {
      plans.push({
        name: `E1-PC DL d=${delay}ns vs NC-A`,
        role: "control",
        first: (i) => i.cls === "NCA",
        second: (i) => i.cls === "DL" && i.delayIndex === delayIndex,
        expected: { elapsed: delay },
      });
    } else {
      plans.push({
        name: `E2-CAL first-chunk d=${delay}ns vs baseline`,
        role: "control",
        first: (i) => i.cls === "CAL" && i.placement === "none",
        second: (i) => i.cls === "CAL" && i.placement === "first" && i.delayIndex === delayIndex,
        expected: { ttfb: delay, ttlb: delay },
      });
      plans.push({
        name: `E2-CAL final-chunk d=${delay}ns vs baseline`,
        role: "control",
        first: (i) => i.cls === "CAL" && i.placement === "none",
        second: (i) => i.cls === "CAL" && i.placement === "final" && i.delayIndex === delayIndex,
        expected: { ttfb: 0, ttlb: delay },
      });
    }
  });

  return plans;
}

export interface MetricResult {
  readonly metric: Metric;
  readonly subset: "all" | "reused-socket";
  readonly median: LocationResult;
  readonly p10: LocationResult;
  readonly components: VarianceComponents;
  readonly drift: number;
  readonly accuracy: readonly AccuracyResult[];
  /** "difference detected" | "not detected (CI width …)". Never a verdict. */
  readonly description: string;
  /** For controls only: whether every interval covered the expected difference. */
  readonly consistentWithExpected?: boolean;
}

export interface ComparisonResult {
  readonly name: string;
  readonly role: ComparisonPlan["role"];
  readonly metrics: readonly MetricResult[];
  /** Present only on the comparison the ceiling interrupted: its finished metrics are kept. */
  readonly complete?: false;
}

export interface AnalysisOptions {
  readonly replicates: number;
  readonly repeats: number;
  readonly seed: string;
  readonly projectionSimulations: number;
  /** Absolute time (ms) of the cooperative analysis deadline (`H-D4`); checked inside every computation loop, never enforced externally. */
  readonly deadline?: number;
  /** Test seam for the clock the ceiling is checked against. */
  readonly now?: () => number;
}

export const DEFAULT_ANALYSIS: Omit<AnalysisOptions, "seed"> = { replicates: 2_000, repeats: 20, projectionSimulations: 200 };

function valueOf(record: MeasurementRecord, metric: Metric): number | undefined {
  const raw = metric === "elapsed" ? record.elapsedNs : metric === "ttfb" ? record.ttfbNs : record.ttlbNs;
  return raw === undefined ? undefined : Number(raw);
}

function covers(interval: readonly [number, number], value: number): boolean {
  return interval[0] <= value && value <= interval[1];
}

/** Analyse one comparison on one metric and request subset. */
export function analyzeMetric(
  plan: ComparisonPlan,
  identities: readonly PlanIdentity[],
  records: readonly MeasurementRecord[],
  metric: Metric,
  subset: MetricResult["subset"],
  options: AnalysisOptions,
): MetricResult {
  const random = new SeededRandom(options.seed, `${plan.name}/${metric}/${subset}`);
  const checkpoint = ceilingCheckpoint(options.deadline, options.now);
  const observationsFor = (select: (identity: PlanIdentity) => boolean): Observation[] =>
    records.flatMap((record) => {
      const identity = identities[record.identity] as PlanIdentity;
      const value = valueOf(record, metric);
      if (record.phase !== "measured" || !select(identity) || value === undefined || record.transportError !== undefined) return [];
      if (subset === "reused-socket" && record.reusedSocket !== true) return [];
      return [{ identity: identity.key, block: record.block, value, ...(record.reusedSocket === undefined ? {} : { reused: record.reusedSocket }) }];
    });
  const first = observationsFor(plan.first);
  const second = observationsFor(plan.second);
  const median = clusterBootstrapDifference(first, second, 0.5, options.replicates, random, checkpoint);
  const p10 = clusterBootstrapDifference(first, second, 0.1, options.replicates, random, checkpoint);
  const blocks = [...new Set([...first, ...second].map((observation) => observation.block))];
  const accuracy: AccuracyResult[] = [];

  if (subset === "all" && plan.role !== "control") {
    const series = (observations: readonly Observation[], label: 0 | 1): Series[] => {
      const byIdentity = new Map<string, Map<number, number>>();
      for (const observation of observations) {
        const map = byIdentity.get(observation.identity) ?? new Map<number, number>();
        map.set(observation.block, observation.value);
        byIdentity.set(observation.identity, map);
      }
      return [...byIdentity].sort(([a], [b]) => (a < b ? -1 : 1)).map(([identity, byBlock]) => ({ identity, label, byBlock }));
    };
    const all = [...series(first, 0), ...series(second, 1)];
    const accuracyOptions = { replicates: options.replicates, repeats: options.repeats, random, checkpoint };

    for (const k of PILOT_K) {
      accuracy.push(classifierAccuracy(all, blocks, k, "identity-held-out", accuracyOptions));
      if (TEMPORAL_K.includes(k)) accuracy.push(classifierAccuracy(all, blocks, k, "temporal-holdout", accuracyOptions));
    }
  }

  const detected =
    !covers(median.interval, 0) || !covers(p10.interval, 0) || accuracy.some((result) => result.interval[0] > 0.5);
  const width = median.interval[1] - median.interval[0];
  const expected = plan.expected?.[metric];

  return {
    metric,
    subset,
    median,
    p10,
    components: varianceComponents([...first, ...second]),
    drift: driftSlope([...first, ...second]),
    accuracy,
    description: detected ? `difference detected (median difference ${median.estimate} ns)` : `not detected (median CI width ${width} ns)`,
    ...(expected === undefined ? {} : { consistentWithExpected: covers(median.interval, expected) }),
  };
}

export interface GateSummary {
  /**
   * E2: replicate-wide post-mask exact agreement (§11.3 as amended). Present only when every gated
   * response's mask is `ok`; otherwise replicate-wide agreement is not established.
   */
  readonly body?: BodyGateResult;
  /**
   * E2: when some gated response failed the mask, the comparison of the successful responses only,
   * labelled as a subset comparison. It never establishes replicate-wide agreement.
   */
  readonly bodySubset?: BodyGateResult & { readonly scope: typeof POST_MASK_SUBSET_LABEL };
  /** E2 stage 1: the UUID-only comparison. **Diagnostic only**; it never affects withholding. */
  readonly bodyUuidOnly?: BodyGateResult;
  readonly headers?: HeaderGateResult;
  /** E2: the version guard (with its failed check and reason, r5 A5-2), mask outcomes and repeated values (§7.3, §11.2A). */
  readonly nextRequestId?: Omit<E2GateResult, "uuidOnly" | "postMask" | "headers"> & {
    readonly outcomes: Readonly<Record<string, number>>;
    readonly guardCheck: string;
    readonly guardReason: string;
    readonly lockfileByteMatch?: LockfileByteMatch;
  };
  readonly e1Values?: { readonly agreement: boolean; readonly distinct: number };
}

export interface IncompleteAnalysis {
  readonly reason: string;
  /** Where the ceiling was reached: a comparison, metric and subset, or a named stage. */
  readonly during: string;
  readonly completedComparisons: readonly string[];
  readonly notStarted: readonly string[];
}

export interface AnalysisReport {
  /** "incomplete" when the ceiling was reached; such a report is only ever written as partial output. */
  readonly status: "complete" | "incomplete";
  readonly incomplete?: IncompleteAnalysis;
  readonly boundary: Boundary;
  readonly replicate?: number;
  readonly seed: string;
  readonly role: "diagnostic" | "exploratory";
  /** Every reason the boundary replicate is Invalid. Empty when none applies. */
  readonly invalid: readonly string[];
  /** Every "Withheld — …" label that applies. */
  readonly withheld: readonly string[];
  readonly gates: GateSummary;
  readonly malformed?: ReturnType<typeof compareMalformed>;
  readonly comparisons: readonly ComparisonResult[];
  readonly identities: readonly IdentityReport[];
  readonly projections: readonly Projection[];
  readonly rules: readonly string[];
  readonly proposedDeferrals: readonly string[];
  readonly notes: readonly string[];
}

/** Transport, connection-churn and encoding validity at E2 (`H-D14`). */
export function e2Validity(records: readonly MeasurementRecord[]): string[] {
  const measured = records.filter((record) => record.phase === "measured");
  const reasons: string[] = [];
  const failures = measured.filter((record) => record.transportError !== undefined).length;

  if (measured.length > 0 && failures / measured.length > 0.005) {
    reasons.push(`Invalid (transport): ${failures} of ${measured.length} measured requests failed`);
  }

  for (const target of ["next", "calibration"] as const) {
    const forTarget = measured.filter((record) => record.target === target && record.transportError === undefined);
    const fresh = forTarget.filter((record) => record.reusedSocket === false).length;
    if (forTarget.length > 0 && fresh / forTarget.length > 0.01) {
      reasons.push(`Invalid (connection churn): ${fresh} of ${forTarget.length} ${target} requests used a new socket`);
    }
  }

  if (records.some((record) => record.contentEncoding !== undefined)) {
    reasons.push("Invalid (encoding): a response carried a Content-Encoding");
  }

  return reasons;
}

/** The §11.2A outcome of a record's stored body; absent or unverified bodies are `missing`. */
function requestIdMaskOf(record: MeasurementRecord, bodies: BodySource | undefined): RequestIdMaskResult {
  const body = record.maskedBodyHash === undefined ? undefined : bodies?.(record.maskedBodyHash);
  if (body === undefined || sha256Hex(body) !== record.maskedBodyHash) return { outcome: "missing" };
  return maskNextRequestId(body);
}

function observationsOf(records: readonly MeasurementRecord[], identities: readonly PlanIdentity[], bodies: BodySource | undefined): E2Observation[] {
  return records.flatMap((record) => {
    if (record.phase !== "measured" || record.target !== "next" || record.transportError !== undefined) return [];
    const identity = identities[record.identity] as PlanIdentity;
    return [
      {
        request: record.sequence,
        cls: identity.cls,
        identity: identity.key,
        status: record.status ?? -1,
        maskedBodyHash: record.maskedBodyHash ?? "",
        bodyReplacements: record.bodyReplacements ?? -1,
        rawHeaders: record.rawHeaders ?? [],
        clock: { writeStartMs: record.writeStartMs ?? Number.NaN, responseEndMs: record.responseEndMs ?? Number.NaN },
        requestIdMask: requestIdMaskOf(record, bodies),
      },
    ];
  });
}

/** The exploratory wording the amended gate requires for the request-ID mask (§11.2A). */
export const NEXT_R_MASK_NOTE =
  "The next dev request-ID mask (H-D20) is an exploratory local rule. It does not establish independence from listing state, stream-chunk equivalence or anything about production timing. All-unique values do not establish independence from listing state.";

/** The guard's documented scope (amendment §4.6). */
export const NEXT_VERSION_GUARD_NOTE =
  "The Next.js version guard is evidence of the pinned version, the package manifest and that manifest's link to the launched executable. It does not verify every installed file.";

/** The E2 body reporting rule (§11.4 as amended). */
export const E2_BODY_REPORTING_NOTE =
  "An E2 body mismatch withholds timing interpretation for this replicate and is described, not classified. Disjoint or all-unique signatures alone do not justify a state-based conclusion. Diagnostic explanations cannot lift the withholding.";

/** The E2 gates of one run: what `analyzeRun` and the V-A validation both report. */
export interface E2Evidence {
  readonly gates: Pick<GateSummary, "body" | "bodySubset" | "bodyUuidOnly" | "headers" | "nextRequestId">;
  readonly withheld: readonly string[];
  readonly malformed: ReturnType<typeof compareMalformed>;
}

/**
 * The shared E2 gate evaluator (amendment r5 A5-3): the §7.3 guard, the §11.2A mask and
 * repeated-value checks, the §11.3 comparison and the §11.6 header gate, on the run's stored
 * bodies. `analyzeRun` and `evaluateE2Validation` both call this one function. It refuses nothing
 * and computes no statistic; the callers decide what data they accept.
 */
export function evaluateE2Evidence(manifest: RunManifest, records: readonly MeasurementRecord[], bodies: BodySource | undefined): E2Evidence {
  const observations = observationsOf(records, manifest.identities, bodies);
  const guard = explainNextVersionGuard(manifest.nextEvidence, manifest.commit);
  const e2 = evaluateE2Gates({ guard: guard.outcome, observations });
  const outcomes: Record<string, number> = {};
  for (const observation of observations) outcomes[observation.requestIdMask.outcome] = (outcomes[observation.requestIdMask.outcome] ?? 0) + 1;

  return {
    gates: {
      ...(e2.postMask !== undefined && e2.postMaskScope === "replicate" ? { body: e2.postMask } : {}),
      ...(e2.postMask !== undefined && e2.postMaskScope === "subset" ? { bodySubset: { ...e2.postMask, scope: POST_MASK_SUBSET_LABEL } } : {}),
      bodyUuidOnly: e2.uuidOnly,
      headers: e2.headers,
      nextRequestId: {
        guard: e2.guard,
        guardCheck: guard.check,
        guardReason: guard.reason,
        ...(guard.lockfileByteMatch === undefined ? {} : { lockfileByteMatch: guard.lockfileByteMatch }),
        postMaskScope: e2.postMaskScope,
        reasons: e2.reasons,
        maskFailures: e2.maskFailures,
        maskReported: e2.maskReported,
        repeatedValues: e2.repeatedValues,
        repeatedReported: e2.repeatedReported,
        outcomes,
      },
    },
    withheld: e2.reasons,
    malformed: compareMalformed(observations.map(postMaskObservation), e2.postMask ?? e2.uuidOnly, e2.headers),
  };
}

/**
 * Analyse one full-pilot boundary replicate. Pure: inputs are passed in. At E2, `bodies` supplies
 * the stored UUID-masked bodies; without it, every body is `missing` and interpretation is withheld.
 */
export function analyzeRun(
  manifest: RunManifest,
  records: readonly MeasurementRecord[],
  options: AnalysisOptions,
  bodies?: BodySource,
): AnalysisReport {
  assertFullPilot(manifest);

  const invalid = [...manifest.invalid];
  const withheld: string[] = [];
  const gates: {
    body?: BodyGateResult;
    bodySubset?: GateSummary["bodySubset"];
    bodyUuidOnly?: BodyGateResult;
    headers?: HeaderGateResult;
    nextRequestId?: GateSummary["nextRequestId"];
    e1Values?: { agreement: boolean; distinct: number };
  } = {};
  let malformed: ReturnType<typeof compareMalformed> | undefined;
  const notes: string[] = [
    "Exploratory output only. No bound is applied and BI-4 remains pending.",
    manifest.boundary === "e1"
      ? "E1 is diagnostic: in-process timing says nothing about HTTP, TTFB, TTLB or production."
      : "E2 is exploratory: loopback HTTP through next dev. Calibration validates the client pipeline and analysis only; nothing in this pilot demonstrates resolution through the dev-server stack.",
    "MF versus never-existed has unknown size and direction; it validates nothing and is not a BI-4 finding.",
    ...(manifest.boundary === "e2" ? [NEXT_R_MASK_NOTE, NEXT_VERSION_GUARD_NOTE, E2_BODY_REPORTING_NOTE] : []),
  ];

  if (manifest.boundary === "e2") {
    invalid.push(...e2Validity(records));
    const e2 = evaluateE2Evidence(manifest, records, bodies);
    Object.assign(gates, e2.gates);
    malformed = e2.malformed;
    withheld.push(...e2.withheld);
  } else {
    const gated = records.filter(
      (record) => record.phase === "measured" && listingStateOf((manifest.identities[record.identity] as PlanIdentity).cls) !== undefined,
    );
    const distinct = new Set(gated.map((record) => `${record.valueHash}|${record.sharedErrorReference}`));
    const agreement = gated.length > 0 && distinct.size === 1 && gated.every((record) => record.sharedErrorReference === true);
    gates.e1Values = { agreement, distinct: distinct.size };
    if (!agreement) withheld.push("Withheld — returned value mismatch");
  }

  const metrics: Metric[] = manifest.boundary === "e1" ? ["elapsed"] : ["ttfb", "ttlb"];
  const subsets: MetricResult["subset"][] = manifest.boundary === "e1" ? ["all"] : ["all", "reused-socket"];
  const plans = comparisonsFor(manifest.boundary, manifest.delaysNs);
  const comparisons: ComparisonResult[] = [];
  const checkpoint = ceilingCheckpoint(options.deadline, options.now);
  let stage = "the validity and agreement gates";
  let incomplete: IncompleteAnalysis | undefined;
  let identityReports: IdentityReport[] = [];
  let projections: readonly Projection[] = [];

  try {
    checkpoint();

    for (const plan of plans) {
      const finished: MetricResult[] = [];
      try {
        for (const metric of metrics) {
          for (const subset of subsets) {
            stage = `${plan.name}, ${metric}, ${subset}`;
            checkpoint();
            finished.push(analyzeMetric(plan, manifest.identities, records, metric, subset, options));
          }
        }
      } catch (error) {
        if (error instanceof AnalysisCeilingReached && finished.length > 0) {
          comparisons.push({ name: plan.name, role: plan.role, metrics: finished, complete: false });
        }
        throw error;
      }
      comparisons.push({ name: plan.name, role: plan.role, metrics: finished });
    }

    stage = "the identity-level reports";
    identityReports = (["NE", "PE", "RJ", "UP"] as const).flatMap((cls) =>
      metrics.map((metric) => {
        checkpoint();
        return identityReport(
          `${cls} ${metric}`,
          records.flatMap((record) => {
            const identity = manifest.identities[record.identity] as PlanIdentity;
            const value = valueOf(record, metric);
            return record.phase === "measured" && identity.cls === cls && value !== undefined ? [{ identity: identity.key, block: record.block, value }] : [];
          }),
        );
      }),
    );

    stage = "the exploratory precision projections";
    const neComponents = comparisons[0]?.metrics[0]?.components;
    projections =
      neComponents === undefined
        ? []
        : projectPrecision(
            neComponents,
            [20, 40, 80].flatMap((identitiesPerClass) => [100, 200].map((requestsPerIdentity) => ({ identitiesPerClass, requestsPerIdentity }))),
            options.projectionSimulations,
            new SeededRandom(options.seed, "projections"),
            checkpoint,
          );
  } catch (error) {
    if (!(error instanceof AnalysisCeilingReached)) throw error;
    const done = comparisons.filter((comparison) => comparison.complete !== false).map((comparison) => comparison.name);
    incomplete = {
      reason: "Incomplete (timeout): the cooperative analysis deadline was reached",
      during: stage,
      completedComparisons: done,
      notStarted: plans.map((plan) => plan.name).filter((name) => !comparisons.some((comparison) => comparison.name === name)),
    };
  }

  for (const comparison of comparisons.filter((entry) => entry.complete !== false)) {
    for (const result of comparison.metrics.filter((entry) => entry.subset === "all")) {
      if (comparison.role === "control" && result.consistentWithExpected === false) {
        invalid.push(`Invalid (control): ${comparison.name} ${result.metric} interval did not cover the expected difference`);
      }
      if (comparison.role === "null" && result.description.startsWith("difference detected")) {
        invalid.push(`Invalid (null fired): ${comparison.name} ${result.metric}`);
      }
    }
  }

  return {
    status: incomplete === undefined ? "complete" : "incomplete",
    ...(incomplete === undefined ? {} : { incomplete }),
    boundary: manifest.boundary,
    ...(manifest.replicate === undefined ? {} : { replicate: manifest.replicate }),
    seed: manifest.seed,
    role: manifest.boundary === "e1" ? "diagnostic" : "exploratory",
    invalid,
    withheld,
    gates,
    ...(malformed === undefined ? {} : { malformed }),
    comparisons,
    identities: identityReports,
    projections,
    rules: EXPLORATORY_CONTROL_RULES,
    proposedDeferrals: PROPOSED_DEFERRALS,
    notes,
  };
}

/** The interpretation line for one comparison, after gates and validity. */
export function interpretationOf(report: AnalysisReport, result: MetricResult): string {
  if (report.status === "incomplete") return `Incomplete analysis: not interpreted (${report.incomplete?.reason ?? "the cooperative analysis deadline was reached"})`;
  if (report.invalid.length > 0) return `Invalid: ${report.invalid.join("; ")}`;
  if (report.withheld.length > 0) return report.withheld.join("; ");
  return report.role === "diagnostic" ? `${result.description} (diagnostic)` : `${result.description} (exploratory lead only)`;
}

/** The E2 body lines: guard, mask outcomes, repeats, post-mask result and the descriptive summary. */
function renderE2BodyLines(gates: GateSummary): string[] {
  const next = gates.nextRequestId;
  if (next === undefined) return [];

  const lines = [
    `- Next.js version guard: ${next.guard}${next.guard === "ok" ? "" : ` (${next.guardReason})`}`,
    `- next dev request-ID mask outcomes (exploratory local rule): ${Object.entries(next.outcomes)
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(", ") || "none"}`,
  ];

  for (const failure of next.maskFailures) lines.push(`  - request ${failure.request} (${failure.cls}): ${failure.outcome}`);
  for (const failure of next.maskReported) lines.push(`  - reported only, request ${failure.request} (${failure.cls}): ${failure.outcome}`);
  for (const repeat of next.repeatedValues) {
    lines.push(`- Repeated request-ID value ${repeat.value}: requests ${repeat.requests.join(", ")} (${repeat.classes.join(", ")}), ${repeat.identities} identities`);
  }
  for (const repeat of next.repeatedReported) lines.push(`- Repeat involving MF, reported only: ${repeat.value}, requests ${repeat.requests.join(", ")}`);

  if (next.postMaskScope === "replicate" && gates.body !== undefined) {
    lines.push(`- Post-mask body agreement (replicate-wide): ${gates.body.agreement ? "agreement" : gates.body.label}`);
  } else if (next.maskFailures.length > 0) {
    lines.push(`- Post-mask body agreement: ${POST_MASK_NOT_ESTABLISHED}`);
  } else {
    lines.push("- Post-mask body agreement: not established: no response in the agreement set was compared");
  }

  if (gates.bodySubset !== undefined) {
    lines.push(
      `- Post-mask ${gates.bodySubset.scope}: ${gates.bodySubset.variationSummary.requests} successful responses, ${gates.bodySubset.agreement ? "identical" : `${gates.bodySubset.label} among them`}`,
    );
  }

  if (gates.bodyUuidOnly !== undefined) {
    lines.push(
      `- UUID-only body comparison (diagnostic stage 1; never affects withholding): ${gates.bodyUuidOnly.agreement ? "identical" : `${gates.bodyUuidOnly.variationSummary.distinctSignatures} distinct signatures`}`,
    );
  }

  const summary = (gates.body ?? gates.bodySubset)?.variationSummary;
  if (summary !== undefined) {
    lines.push(
      `- Body variation summary (descriptive only${gates.bodySubset === undefined ? "" : "; successful masks only"}): ${summary.requests} responses, ${summary.distinctSignatures} distinct signatures. Unique, recurring or overlapping signatures are described, not classified, and do not change the withholding decision.`,
    );
    for (const [state, counts] of Object.entries(summary.perState)) {
      lines.push(
        `  - ${state}: ${counts.requests} responses, ${counts.identities} identities, ${counts.distinctSignatures} distinct, ${counts.recurringSignatures} recurring (${counts.requestsInRecurringSignatures} responses), ${counts.singletonSignatures} singletons`,
      );
    }
    for (const pair of summary.overlap) lines.push(`  - ${pair.first} and ${pair.second}: ${pair.sharedSignatures} shared signatures`);
  }

  return lines;
}

/** Render the report as Markdown. Fixed vocabulary only. */
export function renderReport(report: AnalysisReport): string {
  const lines: string[] = [
    `# ${report.status === "incomplete" ? "INCOMPLETE — partial " : ""}BI-4 timing pilot analysis — ${report.boundary.toUpperCase()}${report.replicate === undefined ? "" : ` replicate ${report.replicate}`}`,
    "",
    ...(report.incomplete === undefined
      ? []
      : [
          `**This analysis is incomplete and is not a completed report.** ${report.incomplete.reason} during ${report.incomplete.during}.`,
          "",
          `- Completed comparisons: ${report.incomplete.completedComparisons.length === 0 ? "none" : report.incomplete.completedComparisons.join("; ")}`,
          `- Not started: ${report.incomplete.notStarted.length === 0 ? "none" : report.incomplete.notStarted.join("; ")}`,
          "",
        ]),
    ...report.notes.map((note) => `- ${note}`),
    "",
    `Role: ${report.role}. Seed: \`${report.seed}\`.`,
    "",
    "## Validity and gates",
    "",
    report.invalid.length === 0 ? "- No Invalid condition recorded." : report.invalid.map((reason) => `- ${reason}`).join("\n"),
    report.withheld.length === 0 ? "- Nothing withheld." : report.withheld.map((label) => `- ${label}`).join("\n"),
  ];

  if (report.gates.headers?.association !== undefined) {
    lines.push(`- Header mismatch label: ${report.gates.headers.association}`);
  }

  lines.push(...renderE2BodyLines(report.gates));

  lines.push("", "## Comparisons", "");

  for (const comparison of report.comparisons) {
    lines.push(`### ${comparison.name} (${comparison.role})${comparison.complete === false ? " — interrupted; finished metrics only" : ""}`, "");
    for (const result of comparison.metrics) {
      lines.push(
        `- ${result.metric}, ${result.subset}: median difference ${result.median.estimate} ns [${result.median.interval.join(", ")}]; ` +
          `p10 difference ${result.p10.estimate} ns [${result.p10.interval.join(", ")}]; design effect ${result.median.designEffect.toFixed(2)}; ` +
          `ICC ${result.components.intraIdentityCorrelation.toFixed(3)}; drift ${result.drift.toFixed(3)} ns/block.`,
      );
      for (const accuracy of result.accuracy) {
        lines.push(`  - k=${accuracy.k} ${accuracy.variant}: accuracy ${accuracy.estimate.toFixed(3)} [${accuracy.interval.map((v) => v.toFixed(3)).join(", ")}]`);
      }
      if (result.consistentWithExpected !== undefined) {
        lines.push(`  - control interval ${result.consistentWithExpected ? "covers" : "does not cover"} the expected difference`);
      }
      lines.push(`  - ${interpretationOf(report, result)}`);
    }
    lines.push("");
  }

  lines.push("## Precision projections (EXPLORATORY)", "", "Not a sample-size requirement and not a threshold.", "");
  for (const projection of report.projections) {
    lines.push(
      `- I=${projection.identitiesPerClass}, R=${projection.requestsPerIdentity}: median ±${projection.medianHalfWidth.toFixed(0)} ns, p10 ±${projection.p10HalfWidth.toFixed(0)} ns`,
    );
  }

  lines.push("", "## Proposed deferrals", "", ...report.proposedDeferrals.map((entry) => `- ${entry}`));
  lines.push("", "## Exploratory control rules (not owner-ratified)", "", ...report.rules.map((rule) => `- ${rule}`));

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Reading a run and preserving evidence.
// ---------------------------------------------------------------------------------------------

/** Stored bodies, read on demand and returned only when their hash matches the file name's. */
export function verifiedBodySource(runDirectory: string): BodySource {
  return (hash) => {
    try {
      const body = readFileSync(join(runDirectory, "bodies", `${hash}.bin`));
      return sha256Hex(body) === hash ? body : undefined;
    } catch {
      return undefined;
    }
  };
}

export function readRun(runDirectory: string): { manifest: RunManifest; records: MeasurementRecord[] } {
  const manifest = JSON.parse(readFileSync(join(runDirectory, "manifest.json"), "utf8")) as RunManifest;
  assertFullPilot(manifest);
  const records = readFileSync(join(runDirectory, "requests.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as MeasurementRecord);
  return { manifest, records };
}

/**
 * Write the analysis and, when a gate withheld, the preserved raw evidence: each differing
 * request's raw body (rebuilt from the deduplicated masked body and its recorded offsets, and
 * verified against its raw hash) and raw header list, plus the diagnostic model's output.
 */
export function writeAnalysis(runDirectory: string, outDirectory: string, options: AnalysisOptions): AnalysisReport {
  if (existsSync(outDirectory) && readdirSync(outDirectory).length > 0) {
    throw new Error("the analysis output directory must be empty");
  }

  const { manifest, records } = readRun(runDirectory);
  const bodies = verifiedBodySource(runDirectory);
  let report = analyzeRun(manifest, records, options, bodies);
  // An incomplete analysis is never written where a completed report would be.
  const target = (): string => (report.status === "complete" ? outDirectory : join(outDirectory, "incomplete"));
  const checkpoint = ceilingCheckpoint(options.deadline, options.now);

  mkdirSync(outDirectory, { recursive: true });

  try {
    preserveEvidence();
  } catch (error) {
    if (!(error instanceof AnalysisCeilingReached)) throw error;
    const partialEvidence = join(outDirectory, "evidence");
    mkdirSync(join(outDirectory, "incomplete"), { recursive: true });
    if (existsSync(partialEvidence)) renameSync(partialEvidence, join(outDirectory, "incomplete", "evidence"));
    report = {
      ...report,
      status: "incomplete",
      incomplete: report.incomplete ?? {
        reason: "Incomplete (timeout): the cooperative analysis deadline was reached",
        during: "evidence preservation",
        completedComparisons: report.comparisons.map((comparison) => comparison.name),
        notStarted: [],
      },
    };
  }

  if (report.status === "complete") {
    writeFileSync(join(outDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDirectory, "report.md"), renderReport(report));
  } else {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "partial-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(target(), "partial-report.md"), renderReport(report));
  }

  return report;

  function preserveEvidence(): void {
  const { headers, bodyUuidOnly, nextRequestId } = report.gates;
  if (headers === undefined || bodyUuidOnly === undefined || nextRequestId === undefined) return;

  const evidence = join(target(), "evidence");
  const bySequence = new Map(records.map((record) => [record.sequence, record]));
  const verifiedBody = (record: MeasurementRecord | undefined): Buffer | undefined =>
    record?.maskedBodyHash === undefined ? undefined : bodies(record.maskedBodyHash);

  if (report.withheld.length > 0) {
    mkdirSync(evidence, { recursive: true });
    const rawBodyOf = (record: MeasurementRecord, masked: Buffer): Buffer => {
      const identity = manifest.identities[record.identity] as PlanIdentity;
      const raw = unmaskAt(masked, identity.key, record.bodyOffsets ?? []);
      if (sha256Hex(raw) !== record.rawBodyHash) {
        throw new Error(`the rebuilt raw body of request ${record.sequence} does not match its recorded raw hash`);
      }
      return raw;
    };
    // §11.4 as amended: every request whose post-mask hash differs, or whose mask outcome is not
    // `ok`, plus every header difference.
    const differing = [
      ...new Set([
        ...(report.gates.body?.differing ?? []),
        ...(report.gates.bodySubset?.differing ?? []),
        ...nextRequestId.maskFailures.map((failure) => failure.request),
        ...nextRequestId.repeatedValues.flatMap((repeat) => repeat.requests),
        ...headers.differing,
      ]),
    ];

    for (const sequence of differing) {
      checkpoint();
      const record = bySequence.get(sequence) as MeasurementRecord;
      const masked = verifiedBody(record);
      // An absent or unverified stored body cannot be rebuilt; its record is still preserved.
      if (masked !== undefined) writeFileSync(join(evidence, `${sequence}.body.bin`), rawBodyOf(record, masked));
      writeFileSync(join(evidence, `${sequence}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
  }

  // §11.5 as amended: diagnostic stage 1 runs on the UUID-masked bodies, before the request-ID
  // mask, whenever they differ — even when post-mask agreement holds. It never lifts withholding.
  if (!bodyUuidOnly.agreement) {
    mkdirSync(evidence, { recursive: true });
    const ofClass = (record: MeasurementRecord): ItemClass => (manifest.identities[record.identity] as PlanIdentity).cls;
    const nextRecords = records.filter((record) => record.target === "next" && record.maskedBodyHash !== undefined);
    const present = (list: readonly (Buffer | undefined)[]): Buffer[] => list.filter((body): body is Buffer => body !== undefined);
    const diagnosis = diagnoseVariation({
      learning: present(
        nextRecords
          .filter((record) => (record.phase === "warmup" && ofClass(record) === "NE") || (record.phase === "measured" && ofClass(record) === "NCA"))
          .map(verifiedBody),
      ),
      differing: bodyUuidOnly.differing.flatMap((sequence) => {
        const body = verifiedBody(bySequence.get(sequence));
        return body === undefined ? [] : [{ request: sequence, body }];
      }),
      ncb: present(nextRecords.filter((record) => record.phase === "measured" && ofClass(record) === "NCB").map(verifiedBody)),
    });
    writeFileSync(join(evidence, "diagnostic-variation.json"), `${JSON.stringify(diagnosis, null, 2)}\n`);
  }
  }
}

// ---------------------------------------------------------------------------------------------
// The V-A validation evaluation (amendment r5 A5-3): gates only, through the shared evaluator.
// ---------------------------------------------------------------------------------------------

/** The cooperative evaluation limit (amendment r5 A5-3): checked between body reads and steps; nothing kills the process. */
export const VALIDATION_EVALUATION_MINUTES = 5;

export const VALIDATION_LABEL = "Validation only — no timing statistic was computed." as const;

export const VALIDATION_STATEMENTS: readonly string[] = [
  "Validation only. No timing statistic was computed.",
  "Not a smoke run; no smoke verdict or S-C criterion changes.",
  "Exploratory E2 evidence about the harness. BI-4 remains pending.",
];

export const INCOMPLETE_VALIDATION_HEADLINE = "INCOMPLETE — gate result not established";

export type GateResult = "withheld" | "agreement" | "not established";

export interface ValidationOptions {
  /** Absolute time (ms) of the cooperative evaluation limit. */
  readonly deadline?: number;
  readonly now?: () => number;
  /** Invalid reasons found after the pass, such as residue. Listed with the manifest's. */
  readonly extraInvalid?: readonly string[];
  /** The checkout preflight's findings, reported as evidence. */
  readonly preflight?: unknown;
  /** Resolves links and junctions for the output overlap checks; defaults to `realpathSync.native`. */
  readonly realpath?: (path: string) => string;
  /**
   * The caller's full destination policy (repository, system temp, resolution, separation), rerun
   * at the start and immediately before any report is written. Any problem means nothing is written.
   */
  readonly destinationCheck?: () => readonly string[];
}

export interface ValidationReport {
  readonly status: "complete" | "incomplete";
  /** The first line of every rendering, and the line printed on exit. */
  readonly headline: string;
  readonly gateResult: GateResult;
  readonly label: typeof VALIDATION_LABEL;
  /** Invalid first, then the withheld labels, then agreement. */
  readonly interpretation: string;
  /** Independent Invalid conditions: the manifest's, any found after the pass, and E2 validity. */
  readonly invalid: readonly string[];
  readonly withheld: readonly string[];
  readonly incomplete?: { readonly reason: string; readonly finished: readonly string[]; readonly notStarted: readonly string[] };
  readonly gates?: E2Evidence["gates"];
  readonly malformed?: E2Evidence["malformed"];
  /** The recorded Next.js version evidence, unchanged. */
  readonly guardEvidence?: NextVersionEvidence;
  readonly preflight?: unknown;
  readonly operational: {
    readonly requests: number;
    readonly byPhase: Readonly<Record<string, number>>;
    readonly byClass: Readonly<Record<string, number>>;
    /** The V-A HTTP attempt budget: limit, attempts used, and attempts by phase and server (readiness included). */
    readonly httpAttempts?: { readonly limit: number; readonly used: number; readonly byPhase: Readonly<Record<string, number>> };
  };
  readonly statements: readonly string[];
}

/** Only a V-A validation pass is accepted: E2, `mode: "smoke"` and the validation marker. */
export function assertValidationRun(manifest: Pick<RunManifest, "mode" | "boundary" | "validation">): void {
  if (manifest.boundary !== "e2" || manifest.mode !== "smoke" || manifest.validation !== VALIDATION_MARKER) {
    throw new Error("the validation evaluation accepts only an E2 V-A validation pass (mode \"smoke\" with the validation marker)");
  }
}

const EVALUATION_STEPS = ["E2 validity", "body reads and gates", "report"] as const;

function headlineOf(gateResult: GateResult, withheld: readonly string[]): string {
  if (gateResult === "withheld") return `Gate result: WITHHELD — ${withheld.join("; ")}`;
  return gateResult === "agreement" ? "Gate result: agreement" : "Gate result: not established";
}

/**
 * Evaluate a V-A validation pass with the **same** `evaluateE2Evidence` that `analyzeRun` uses.
 * Gates only: no statistic, comparison, classifier, projection or interpretation of timing. The
 * evaluation limit is cooperative; when it is reached the report is `incomplete` and has no gate
 * result.
 */
export function evaluateE2Validation(
  manifest: RunManifest,
  records: readonly MeasurementRecord[],
  bodies: BodySource | undefined,
  options: ValidationOptions = {},
): ValidationReport {
  assertValidationRun(manifest);

  const checkpoint = ceilingCheckpoint(options.deadline, options.now);
  const invalid = [...manifest.invalid, ...(options.extraInvalid ?? [])];
  const finished: string[] = [];
  const count = (key: (record: MeasurementRecord) => string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const record of records) counts[key(record)] = (counts[key(record)] ?? 0) + 1;
    return counts;
  };
  const common = {
    label: VALIDATION_LABEL,
    ...(manifest.nextEvidence === undefined ? {} : { guardEvidence: manifest.nextEvidence }),
    ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
    operational: { requests: records.length, byPhase: count((record) => record.phase), byClass: count((record) => record.cls) },
    statements: VALIDATION_STATEMENTS,
  };

  try {
    checkpoint();
    invalid.push(...e2Validity(records));
    finished.push(EVALUATION_STEPS[0]);

    const checked: BodySource = (hash) => {
      checkpoint();
      return bodies?.(hash);
    };
    const e2 = evaluateE2Evidence(manifest, records, checked);
    finished.push(EVALUATION_STEPS[1]);
    checkpoint();

    const withheld = [...e2.withheld];
    const gateResult: GateResult =
      withheld.length > 0 ? "withheld" : e2.gates.body?.agreement === true && e2.gates.headers?.agreement === true ? "agreement" : "not established";

    return {
      status: "complete",
      headline: headlineOf(gateResult, withheld),
      gateResult,
      interpretation:
        invalid.length > 0
          ? `Invalid: ${invalid.join("; ")}`
          : withheld.length > 0
            ? withheld.join("; ")
            : gateResult === "agreement"
              ? "Gate agreement (validation only; no timing interpretation)"
              : "Gate result not established",
      invalid,
      withheld,
      gates: e2.gates,
      malformed: e2.malformed,
      ...common,
    };
  } catch (error) {
    if (!(error instanceof AnalysisCeilingReached)) throw error;
    return {
      status: "incomplete",
      headline: INCOMPLETE_VALIDATION_HEADLINE,
      gateResult: "not established",
      interpretation: invalid.length > 0 ? `Invalid: ${invalid.join("; ")}` : "Incomplete evaluation: gate result not established",
      invalid,
      withheld: [],
      incomplete: {
        reason: `Incomplete (timeout): the cooperative ${VALIDATION_EVALUATION_MINUTES}-minute evaluation limit was reached`,
        finished,
        notStarted: EVALUATION_STEPS.filter((step) => !finished.includes(step)),
      },
      ...common,
    };
  }
}

/** Render a validation report. The first line is always the headline. */
export function renderE2Validation(report: ValidationReport): string {
  const lines: string[] = [report.headline, "", `**${report.label}**`, "", `Interpretation: ${report.interpretation}`, ""];

  if (report.incomplete !== undefined) {
    lines.push(
      `**This evaluation is incomplete and is not a completed report.** ${report.incomplete.reason}.`,
      "",
      `- Finished: ${report.incomplete.finished.length === 0 ? "none" : report.incomplete.finished.join("; ")}`,
      `- Not started: ${report.incomplete.notStarted.join("; ")}`,
      "",
    );
  }

  lines.push("## 1. Independent Invalid conditions", "", ...(report.invalid.length === 0 ? ["- None recorded."] : report.invalid.map((reason) => `- ${reason}`)), "");

  const next = report.gates?.nextRequestId;
  lines.push("## 2. Next.js version guard", "");
  if (next === undefined) {
    lines.push("- Not evaluated.");
  } else {
    lines.push(`- Outcome: ${next.guard}`, `- First failed check: ${next.guardCheck}`, `- Reason: ${next.guardReason}`);
    if (next.lockfileByteMatch !== undefined) lines.push(`- Lockfile byte match: ${next.lockfileByteMatch}`);
    lines.push(next.guard === "ok" ? "- No version-guard withholding." : "- Withheld — Next.js version guard, pending review");
  }
  lines.push("");

  lines.push("## 3. Request-ID mask", "");
  if (next === undefined) {
    lines.push("- Not evaluated.");
  } else {
    lines.push(`- Outcomes: ${Object.entries(next.outcomes).map(([outcome, total]) => `${outcome} ${total}`).join(", ") || "none"}`);
    for (const failure of next.maskFailures) lines.push(`- Mask refusal, request ${failure.request} (${failure.cls}): ${failure.outcome}`);
    for (const failure of next.maskReported) lines.push(`- Reported only, request ${failure.request} (${failure.cls}): ${failure.outcome}`);
    for (const repeat of next.repeatedValues) lines.push(`- Repeated value ${repeat.value}: requests ${repeat.requests.join(", ")} (${repeat.classes.join(", ")}), ${repeat.identities} identities`);
    if (next.maskFailures.length === 0 && next.repeatedValues.length === 0) lines.push("- No mask refusal.");
  }
  lines.push("");

  lines.push("## 4. Residual body mismatch", "");
  if (report.gates === undefined) {
    lines.push("- Not evaluated.");
  } else {
    lines.push(...renderE2BodyLines(report.gates).filter((line) => !line.startsWith("- Next.js version guard") && !line.startsWith("- next dev request-ID")));
  }
  lines.push("");

  lines.push("## 5. Response headers", "");
  const headers = report.gates?.headers;
  lines.push(headers === undefined ? "- Not evaluated." : headers.agreement ? "- Agreement." : `- ${headers.label}${headers.association === undefined ? "" : ` (label: ${headers.association})`}`);
  lines.push("");

  lines.push(
    "## 6. Operational",
    "",
    `- Requests: ${report.operational.requests}`,
    `- By phase: ${Object.entries(report.operational.byPhase).map(([phase, total]) => `${phase} ${total}`).join(", ")}`,
    `- By class: ${Object.entries(report.operational.byClass).map(([cls, total]) => `${cls} ${total}`).join(", ")}`,
    ...(report.operational.httpAttempts === undefined
      ? []
      : [
          `- HTTP attempts (readiness included): ${report.operational.httpAttempts.used} of ${report.operational.httpAttempts.limit}; ${Object.entries(report.operational.httpAttempts.byPhase).map(([phase, total]) => `${phase} ${total}`).join(", ")}`,
        ]),
    "",
    ...report.statements.map((statement) => `- ${statement}`),
  );

  return `${lines.join("\n")}\n`;
}

/** Read a V-A validation pass. Refuses anything without the marker, including every smoke and full run. */
export function readValidationRun(runDirectory: string): { manifest: RunManifest; records: MeasurementRecord[] } {
  const manifest = JSON.parse(readFileSync(join(runDirectory, "manifest.json"), "utf8")) as RunManifest;
  assertValidationRun(manifest);
  const records = readFileSync(join(runDirectory, "requests.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as MeasurementRecord);
  return { manifest, records };
}

/** Whether `inner` is `outer` or lies inside it. Case-insensitive on Windows. */
function within(inner: string, outer: string, real: (path: string) => string): boolean {
  const fold = (path: string): string => {
    let resolved: string;
    try {
      resolved = resolve(real(path));
    } catch {
      resolved = resolve(path);
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = relative(fold(outer), fold(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolves symbolic links and Windows junctions to the final path. */
const nativeRealpath = (path: string): string => realpathSync.native(path);

/** Problems with a validation output directory, on resolved paths (junctions included); empty when it may be used. */
export function validationOutputProblems(runDirectory: string, outDirectory: string, real: (path: string) => string = nativeRealpath): string[] {
  const problems: string[] = [];
  if (within(outDirectory, runDirectory, real)) problems.push("the validation output directory must not be the run directory or inside it");
  if (within(runDirectory, outDirectory, real)) problems.push("the validation output directory must not contain the run directory");
  if (existsSync(outDirectory) && readdirSync(outDirectory).length > 0) problems.push("the validation output directory must be empty");
  return problems;
}

/**
 * Evaluate a V-A pass and write only `validation.json` and `validation.md` to a separate, empty
 * directory — or, when the evaluation limit is reached, only
 * `incomplete/partial-validation.json` and `.md`. Nothing is written to the run directory.
 */
export function writeE2Validation(runDirectory: string, outDirectory: string, options: ValidationOptions = {}): ValidationReport {
  const real = options.realpath ?? nativeRealpath;
  const check = (): void => {
    const problems = [...validationOutputProblems(runDirectory, outDirectory, real), ...(options.destinationCheck?.() ?? [])];
    if (problems.length > 0) throw new Error(problems.join("; "));
  };

  check();
  const { manifest, records } = readValidationRun(runDirectory);
  const report = evaluateE2Validation(manifest, records, verifiedBodySource(runDirectory), options);
  const attempts = readAttemptSummary(runDirectory);
  const written = attempts === undefined ? report : { ...report, operational: { ...report.operational, httpAttempts: attempts } };

  // Rechecked immediately before writing: the destination may have changed during evaluation.
  check();
  const target = report.status === "complete" ? outDirectory : join(outDirectory, "incomplete");
  const base = report.status === "complete" ? "validation" : "partial-validation";

  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${base}.json`), `${JSON.stringify(written, null, 2)}\n`);
  writeFileSync(join(target, `${base}.md`), renderE2Validation(written));

  return written;
}

/** The V-A HTTP attempt trace's summary, when the pass wrote one (`http-attempts.json`). */
function readAttemptSummary(runDirectory: string): ValidationReport["operational"]["httpAttempts"] {
  try {
    const parsed = JSON.parse(readFileSync(join(runDirectory, "http-attempts.json"), "utf8")) as { limit?: unknown; used?: unknown; byPhase?: unknown };
    if (typeof parsed.limit !== "number" || typeof parsed.used !== "number" || typeof parsed.byPhase !== "object" || parsed.byPhase === null) return undefined;
    return { limit: parsed.limit, used: parsed.used, byPhase: parsed.byPhase as Record<string, number> };
  } catch {
    return undefined;
  }
}
