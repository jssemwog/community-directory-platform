/**
 * Analysis for the `BI-4` timing pilot (issue #246; timing Scope Gate revision 4 §5; harness gate
 * revision 5 §1, §5.4), on synthetic data only.
 *
 * The classifier is refit in every bootstrap replicate; folds group by identity and keep copies
 * together; the temporal holdout exists only at k = 1 and 10, and k = 100 is identity-held-out
 * only; smoke data is refused; and nothing the report says is ever a verdict. The cooperative
 * 45-minute deadline stops the analysis inside a comparison, and an incomplete analysis is written only as
 * partial output. The writing test uses its own temporary directory. Held-out accuracy is kept, accuracy
 * projections are a proposed deferral, and the exploratory control rules are listed.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AnalysisCeilingReached,
  analyzeMetric,
  analyzeRun,
  assertFullPilot,
  assignFolds,
  ceilingCheckpoint,
  classifierAccuracy,
  clusterBootstrapDifference,
  comparisonsFor,
  e2Validity,
  EXPLORATORY_CONTROL_RULES,
  fitThreshold,
  FOLDS,
  heldOutAccuracy,
  interpretationOf,
  kSubsetMedians,
  NO_CHECKPOINT,
  predict,
  PROPOSED_DEFERRALS,
  renderReport,
  weightedQuantile,
  writeAnalysis,
  type ComparisonPlan,
  type Fitter,
  type MeasurementRecord,
  type Observation,
  type RunManifest,
  type Series,
} from "./analyze";
import { buildPlan, SeededRandom, type PlanIdentity } from "./schedule";

const BLOCKS = Array.from({ length: 100 }, (_, index) => index + 1);
const OPTIONS = { replicates: 12, repeats: 2, seed: "analysis-test", projectionSimulations: 4 };
/**
 * A test that runs a complete synthetic analysis is CPU-bound. It can exceed vitest's 5 s default
 * under full-suite load, so it gets an explicit allowance. The cap is on test time, not analysis time.
 */
const HEAVY_ANALYSIS_TIMEOUT_MS = 60_000;

/** Synthetic requests: per-identity offsets, per-block drift and residual noise, plus a shift. */
function synthetic(
  identities: number,
  shift: number,
  random: SeededRandom,
  prefix: string,
  blockEffects: readonly number[],
): Observation[] {
  const observations: Observation[] = [];

  for (let i = 0; i < identities; i += 1) {
    const identityOffset = random.below(200) - 100;
    for (const block of BLOCKS) {
      observations.push({
        identity: `${prefix}${i}`,
        block,
        value: 100_000 + shift + identityOffset + (blockEffects[block - 1] as number) + (random.below(400) - 200),
      });
    }
  }

  return observations;
}

function seriesOf(observations: readonly Observation[], label: 0 | 1): Series[] {
  const byIdentity = new Map<string, Map<number, number>>();
  for (const observation of observations) {
    const map = byIdentity.get(observation.identity) ?? new Map<number, number>();
    map.set(observation.block, observation.value);
    byIdentity.set(observation.identity, map);
  }
  return [...byIdentity].map(([identity, byBlock]) => ({ identity, label, byBlock }));
}

describe("location statistics", () => {
  it("takes the lower weighted quantile, and the plain quantile with unit weights", () => {
    expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5)).toBe(2);
    expect(weightedQuantile([1, 2, 3, 4], [0, 0, 5, 1], 0.5)).toBe(3);
    expect(weightedQuantile([1, 2, 3], [0, 0, 0], 0.5)).toBeNaN();
  });

  it("covers a known shift and excludes zero, and covers zero with no shift, under the two-way cluster bootstrap", () => {
    const random = new SeededRandom("location", "data");
    const blockEffects = BLOCKS.map(() => random.below(100) - 50);
    const base = synthetic(20, 0, random, "a", blockEffects);
    const shifted = synthetic(20, 1_000, random, "b", blockEffects);
    const same = synthetic(20, 0, random, "c", blockEffects);
    const detected = clusterBootstrapDifference(base, shifted, 0.5, 200, new SeededRandom("location", "boot"));
    const none = clusterBootstrapDifference(base, same, 0.5, 200, new SeededRandom("location", "boot2"));

    expect(detected.interval[0]).toBeGreaterThan(0);
    expect(detected.interval[0]).toBeLessThanOrEqual(1_000);
    expect(detected.interval[1]).toBeGreaterThanOrEqual(1_000);
    expect(none.interval[0]).toBeLessThanOrEqual(0);
    expect(none.interval[1]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(detected.designEffect)).toBe(true);
  });
});

describe("the classifier", () => {
  it("fits the single best threshold in either direction and predicts with it", () => {
    const high = fitThreshold([1, 2, 3, 10, 11, 12], [0, 0, 0, 1, 1, 1]);
    const low = fitThreshold([1, 2, 3, 10, 11, 12], [1, 1, 1, 0, 0, 0]);

    expect(high).toEqual({ threshold: 6.5, direction: "high" });
    expect(low).toEqual({ threshold: 6.5, direction: "low" });
    expect(predict(high, 11)).toBe(1);
    expect(predict(low, 2)).toBe(1);
  });

  it("builds disjoint k-subsets from consecutive blocks, skipping missing blocks and dropping a partial subset", () => {
    const byBlock = new Map(BLOCKS.filter((block) => block !== 3).map((block) => [block, block]));
    const series: Series = { identity: "x", label: 0, byBlock };

    expect(kSubsetMedians(series, BLOCKS, 1)).toHaveLength(99);
    expect(kSubsetMedians(series, BLOCKS, 10)).toHaveLength(9);
    expect(kSubsetMedians(series, BLOCKS, 100)).toHaveLength(0);
    expect(kSubsetMedians({ ...series, byBlock: new Map(BLOCKS.map((block) => [block, block])) }, BLOCKS, 100)).toEqual([50.5]);
  });
});

describe("fold grouping", () => {
  it("deals 4 identities of each class into each of the 5 folds, and keeps a resampled identity's copies together", () => {
    const random = new SeededRandom("folds", "data");
    const series = [
      ...seriesOf(synthetic(20, 0, random, "ne", BLOCKS.map(() => 0)), 0),
      ...seriesOf(synthetic(20, 0, random, "pe", BLOCKS.map(() => 0)), 1),
    ];
    const folds = assignFolds(series, new SeededRandom("folds", "assign"));

    for (let fold = 0; fold < FOLDS; fold += 1) {
      for (const label of [0, 1]) {
        expect(series.filter((entry) => entry.label === label && folds.get(entry.identity) === fold)).toHaveLength(4);
      }
    }

    const withCopies = [...series, series[0] as Series, series[0] as Series, series[25] as Series];
    const copyFolds = assignFolds(withCopies, new SeededRandom("folds", "copies"));
    const foldOfCopies = withCopies.filter((entry) => entry.identity === series[0]?.identity).map((entry) => copyFolds.get(entry.identity));

    expect(new Set(foldOfCopies).size).toBe(1);
  });

  it("never trains on a held-out identity", () => {
    const series: Series[] = Array.from({ length: 10 }, (_, i) => ({
      identity: `id${i}`,
      label: (i % 2) as 0 | 1,
      byBlock: new Map(BLOCKS.map((block) => [block, i * 1_000 + block])),
    }));
    const folds = assignFolds(series, new SeededRandom("leak", "assign"));
    const seen: { fold: number; values: readonly number[] }[] = [];
    let call = 0;
    const spy: Fitter = (values, labels) => {
      seen.push({ fold: call, values });
      call += 1;
      return fitThreshold(values, labels);
    };

    heldOutAccuracy({ series, k: 1, trainBlocks: BLOCKS, testBlocks: BLOCKS, folds, fit: spy });

    const foldsInUse = [...new Set(series.map((entry) => folds.get(entry.identity) as number))].sort();

    seen.forEach(({ values }, position) => {
      const fold = foldsInUse[position] as number;
      for (const entry of series.filter((candidate) => folds.get(candidate.identity) === fold)) {
        const own = Number(entry.identity.slice(2)) * 1_000;
        expect(values.some((value) => value > own && value <= own + 100)).toBe(false);
      }
    });
  });
});

describe("refit in every replicate, and where the temporal holdout applies", () => {
  const random = new SeededRandom("refit", "data");
  const series = [
    ...seriesOf(synthetic(20, 0, random, "ne", BLOCKS.map(() => 0)), 0),
    ...seriesOf(synthetic(20, 300, random, "pe", BLOCKS.map(() => 0)), 1),
  ];

  it("refits the classifier once per fold in every repeat and in every bootstrap replicate", () => {
    let calls = 0;
    const spy: Fitter = (values, labels) => {
      calls += 1;
      return fitThreshold(values, labels);
    };

    classifierAccuracy(series, BLOCKS, 10, "identity-held-out", { replicates: 7, repeats: 3, random: new SeededRandom("refit", "a"), fit: spy });

    expect(calls).toBe((7 + 3) * FOLDS);
  });

  it("computes the temporal holdout at k = 1 and 10 and refuses it at k = 100", () => {
    const options = { replicates: 3, repeats: 1, random: new SeededRandom("refit", "b") };

    expect(classifierAccuracy(series, BLOCKS, 1, "temporal-holdout", options).variant).toBe("temporal-holdout");
    expect(classifierAccuracy(series, BLOCKS, 10, "temporal-holdout", options).variant).toBe("temporal-holdout");
    expect(() => classifierAccuracy(series, BLOCKS, 100, "temporal-holdout", options)).toThrow(/only to k = 1 and 10/);
    expect(classifierAccuracy(series, BLOCKS, 100, "identity-held-out", options).k).toBe(100);
  });

  it("trains the temporal variant on blocks 1–50 and evaluates on blocks 51–100", () => {
    const trainedOn: number[][] = [];
    const spy: Fitter = (values, labels) => {
      trainedOn.push([...values]);
      return fitThreshold(values, labels);
    };
    const marked: Series[] = series.map((entry) => ({
      ...entry,
      byBlock: new Map(BLOCKS.map((block) => [block, block <= 50 ? block : 10_000 + block])),
    }));

    classifierAccuracy(marked, BLOCKS, 1, "temporal-holdout", { replicates: 0, repeats: 1, random: new SeededRandom("refit", "c"), fit: spy });

    expect(trainedOn.flat().every((value) => value <= 50)).toBe(true);
  });
});

/** A synthetic full E1 run: every measured request present, identical returned values. */
function syntheticE1(): { manifest: RunManifest; records: MeasurementRecord[] } {
  const plan = buildPlan({ boundary: "e1", mode: "full", seed: "synthetic-e1", delaysNs: [5_000, 20_000, 80_000], background: 0 });
  const random = new SeededRandom("synthetic-e1", "values");
  const records = plan.requests
    .filter((request) => request.phase === "measured")
    .map((request) => {
      const identity = plan.identities[request.identity] as PlanIdentity;
      const delay = identity.cls === "DL" ? (plan.delaysNs[identity.delayIndex as number] as number) : 0;
      return {
        sequence: request.sequence,
        phase: request.phase,
        block: request.block,
        identity: request.identity,
        cls: identity.cls,
        target: identity.target,
        elapsedNs: String(200_000 + delay + random.below(2_000)),
        valueHash: "same",
        sharedErrorReference: true,
      } satisfies MeasurementRecord;
    });

  return {
    manifest: {
      mode: "full",
      boundary: "e1",
      replicate: 1,
      seed: plan.seed,
      delaysNs: plan.delaysNs,
      backgroundCount: 0,
      commit: "0000000",
      identities: plan.identities,
      startedAt: "2026-11-07T00:00:00.000Z",
      invalid: [],
    },
    records,
  };
}

describe("smoke-data refusal", () => {
  it("refuses smoke-mode manifests, in the guard and in the analysis", () => {
    const { manifest, records } = syntheticE1();

    expect(() => assertFullPilot({ mode: "smoke" })).toThrow(/refuses smoke-mode data/);
    expect(() => analyzeRun({ ...manifest, mode: "smoke" }, records, OPTIONS)).toThrow(/refuses smoke-mode data/);
  });
});

describe("the report", () => {
  const { manifest, records } = syntheticE1();
  const report = analyzeRun(manifest, records, OPTIONS);
  const rendered = renderReport(report);
  const text = `${rendered}\n${JSON.stringify(report)}`;

  it("reports k = 100 identity-held-out only, and the temporal holdout only at k = 1 and 10", () => {
    const test = report.comparisons.find((comparison) => comparison.name === "C-PE");
    const accuracy = test?.metrics[0]?.accuracy ?? [];

    expect(accuracy.map((entry) => `${entry.k}/${entry.variant}`)).toEqual([
      "1/identity-held-out",
      "1/temporal-holdout",
      "10/identity-held-out",
      "10/temporal-holdout",
      "100/identity-held-out",
    ]);
  });

  it("never contains a verdict, a bound, equivalence or pass/fail wording", () => {
    expect(text).not.toMatch(/within[- ]?bound|equivalen|\bpass(es|ed)?\b|\bfail(s|ed)?\b|verdict|\baccept/i);
    expect(rendered).toContain("BI-4 remains pending");
    expect(rendered).toContain("E1 is diagnostic");
  });

  it("labels projections exploratory and withholds E1 interpretation when returned values differ", () => {
    expect(report.projections.every((projection) => projection.label === "EXPLORATORY")).toBe(true);

    const target = records.findIndex((record) => record.cls === "PE");
    const altered = records.map((record, index) => (index === target ? { ...record, valueHash: "different" } : record));
    expect(analyzeRun(manifest, altered, OPTIONS).withheld).toEqual(["Withheld — returned value mismatch"]);
  }, HEAVY_ANALYSIS_TIMEOUT_MS);
});

describe("E2 validity (H-D14)", () => {
  const base = { phase: "measured" as const, block: 1, identity: 0, cls: "NE" as const, ttfbNs: "1", ttlbNs: "2" };

  it("marks more than 0.5% transport failures, more than 1% new sockets per target, and any Content-Encoding Invalid", () => {
    const records: MeasurementRecord[] = Array.from({ length: 1_000 }, (_, i) => ({
      ...base,
      sequence: i,
      target: "next",
      reusedSocket: i >= 20,
      ...(i < 6 ? { transportError: "ECONNRESET" } : {}),
      ...(i === 999 ? { contentEncoding: "gzip" } : {}),
    }));
    const reasons = e2Validity(records);

    expect(reasons.some((reason) => reason.startsWith("Invalid (transport)"))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith("Invalid (connection churn)"))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith("Invalid (encoding)"))).toBe(true);
    expect(e2Validity(records.slice(20, 998))).toEqual([]);
  });
});

describe("the cooperative 45-minute analysis deadline, checked inside a comparison (H-D4)", () => {
  const { manifest, records } = syntheticE1();
  /** A clock that reads 0 for the first `calls` checks and then jumps past the deadline. */
  const clockAfter = (calls: number) => {
    let reads = 0;
    return { now: () => (reads += 1) > calls ? 2 : 0, reads: () => reads };
  };

  it("checks the ceiling inside the bootstrap loop, not only between comparisons", () => {
    const random = new SeededRandom("ceiling", "loop");
    const observations = synthetic(4, 0, random, "a", BLOCKS.map(() => 0));
    let checks = 0;
    const checkpoint = () => {
      checks += 1;
      if (checks > 3) throw new AnalysisCeilingReached();
    };

    expect(() => clusterBootstrapDifference(observations, observations, 0.5, 50, random, checkpoint)).toThrow(AnalysisCeilingReached);
    expect(checks).toBe(4);
    expect(ceilingCheckpoint(undefined)).toBe(NO_CHECKPOINT);
    expect(() => ceilingCheckpoint(1, () => 1)()).not.toThrow();
    expect(() => ceilingCheckpoint(1, () => 2)()).toThrow(AnalysisCeilingReached);
  });

  it("stops part-way through the first comparison and reports the analysis incomplete, with nothing interpreted", () => {
    const clock = clockAfter(5);
    const report = analyzeRun(manifest, records, { ...OPTIONS, deadline: 1, now: clock.now });

    expect(report.status).toBe("incomplete");
    expect(report.incomplete?.reason).toMatch(/^Incomplete \(timeout\)/);
    expect(report.incomplete?.during).toBe("C-PE, elapsed, all");
    expect(report.incomplete?.completedComparisons).toEqual([]);
    expect(report.incomplete?.notStarted).toContain("C-RJ");
    expect(report.projections).toEqual([]);

    const rendered = renderReport(report);
    expect(rendered.startsWith("# INCOMPLETE — partial BI-4 timing pilot analysis")).toBe(true);
    expect(rendered).toContain("This analysis is incomplete and is not a completed report.");
  });

  it("keeps finished comparisons and the interrupted comparison's finished metrics, marked as partial", () => {
    // Enough checks to finish the first comparison, then stop inside a later one.
    const full = clockAfter(Number.POSITIVE_INFINITY);
    analyzeMetric(comparisonsFor("e1", manifest.delaysNs)[0] as ComparisonPlan, manifest.identities, records, "elapsed", "all", { ...OPTIONS, deadline: 1, now: full.now });
    const perComparison = full.reads();
    const clock = clockAfter(perComparison + 10);
    const report = analyzeRun(manifest, records, { ...OPTIONS, deadline: 1, now: clock.now });

    expect(report.status).toBe("incomplete");
    expect(report.incomplete?.completedComparisons).toEqual(["C-PE"]);
    expect(report.comparisons.filter((comparison) => comparison.complete === false).every((comparison) => comparison.metrics.length > 0)).toBe(true);
    expect(report.comparisons[0]?.metrics[0]?.accuracy.length).toBe(5);
    for (const comparison of report.comparisons) {
      for (const result of comparison.metrics) expect(interpretationOf(report, result)).toMatch(/^Incomplete analysis/);
    }
  });

  it("writes an incomplete analysis only as partial output, never as report.json or report.md", () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-analyze-test-"));
    try {
      const run = join(base, "run");
      mkdirSync(run);
      writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(run, "requests.ndjson"), records.map((record) => JSON.stringify(record)).join("\n"));

      const timedOut = join(base, "timed-out");
      const partial = writeAnalysis(run, timedOut, { ...OPTIONS, deadline: 1, now: clockAfter(5).now });
      expect(partial.status).toBe("incomplete");
      expect(readdirSync(timedOut).sort()).toEqual(["incomplete"]);
      expect(readdirSync(join(timedOut, "incomplete")).sort()).toEqual(["partial-report.json", "partial-report.md"]);
      expect(JSON.parse(readFileSync(join(timedOut, "incomplete", "partial-report.json"), "utf8")).status).toBe("incomplete");

      const completed = join(base, "completed");
      expect(writeAnalysis(run, completed, OPTIONS).status).toBe("complete");
      expect(readdirSync(completed).sort()).toEqual(["report.json", "report.md"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, HEAVY_ANALYSIS_TIMEOUT_MS);
});

describe("held-out accuracy, the proposed deferral and the exploratory rules", () => {
  const { manifest, records } = syntheticE1();
  const report = analyzeRun(manifest, records, OPTIONS);
  const rendered = renderReport(report);

  it("keeps held-out accuracy with its interval at every pilot k, and records accuracy projections as a proposed deferral", () => {
    const accuracy = report.comparisons.find((comparison) => comparison.name === "C-PE")?.metrics[0]?.accuracy ?? [];
    expect(accuracy.map((entry) => entry.k)).toEqual([1, 1, 10, 10, 100]);
    for (const entry of accuracy) {
      expect(entry.interval[0]).toBeLessThanOrEqual(entry.interval[1]);
      expect(Number.isFinite(entry.estimate)).toBe(true);
    }
    expect(report.proposedDeferrals).toEqual(PROPOSED_DEFERRALS);
    expect(PROPOSED_DEFERRALS[0]).toMatch(/^Classifier-accuracy precision projections .* proposed for deferral/);
    expect(report.projections.every((projection) => "medianHalfWidth" in projection && !("accuracy" in projection))).toBe(true);
    expect(rendered).toContain("## Proposed deferrals");
  });

  it("lists every exploratory control rule in the report", () => {
    expect(report.rules).toEqual(EXPLORATORY_CONTROL_RULES);
    expect(EXPLORATORY_CONTROL_RULES.map((rule) => rule.split(":")[0])).toEqual([
      "Positive control (E1-PC; E2-CAL first- and final-chunk)",
      "Null comparison (NC-A vs NC-B)",
      "Difference detected (an exploratory lead only)",
      "Identity heterogeneity",
      "Identity flag",
    ]);
    expect(rendered).toContain("## Exploratory control rules (not owner-ratified)");
    for (const rule of EXPLORATORY_CONTROL_RULES) expect(rendered).toContain(rule);
  });
});
