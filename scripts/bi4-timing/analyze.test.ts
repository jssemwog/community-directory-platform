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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Every child-process entry point is counted, so importing `./cli` can be shown to start nothing
 * (T-W0). The real functions still run; nothing in this file calls them.
 */
const childProcessCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      childProcessCalls.count += 1;
      return fn(...args);
    };
  return {
    ...real,
    spawn: counted(real.spawn as (...args: unknown[]) => unknown),
    spawnSync: counted(real.spawnSync as (...args: unknown[]) => unknown),
    execFile: counted(real.execFile as (...args: unknown[]) => unknown),
    execFileSync: counted(real.execFileSync as (...args: unknown[]) => unknown),
    exec: counted(real.exec as (...args: unknown[]) => unknown),
    execSync: counted(real.execSync as (...args: unknown[]) => unknown),
    fork: counted(real.fork as (...args: unknown[]) => unknown),
  };
});

import {
  AnalysisCeilingReached,
  evaluateE2Evidence,
  evaluateE2Validation,
  INCOMPLETE_VALIDATION_HEADLINE,
  readRun,
  readValidationRun,
  renderE2Validation,
  VALIDATION_LABEL,
  VALIDATION_MARKER,
  writeE2Validation,
  type ValidationReport,
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
  NEXT_R_MASK_NOTE,
  NEXT_VERSION_GUARD_NOTE,
  type AnalysisReport,
  type BodySource,
  type ComparisonPlan,
  type Fitter,
  type MeasurementRecord,
  type Observation,
  type RunManifest,
  type Series,
} from "./analyze";
import {
  BODY_WITHHELD,
  DIAGNOSTIC_LABEL,
  HEADER_WITHHELD,
  maskOwnIdentity,
  NEXT_R_PREFIX,
  NEXT_R_SUFFIX,
  NEXT_VERSION_WITHHELD,
  POST_MASK_NOT_ESTABLISHED,
  POST_MASK_SUBSET_LABEL,
  REQUEST_ID_MASK_WITHHELD,
  sha256Hex,
} from "./body-compare";
import type { NextVersionEvidence } from "./next-evidence";
import { windowsListenerLookup, type ListeningEntry } from "./isolation";
import type { Exchange } from "./run-http";
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

// ---------------------------------------------------------------------------------------------
// E2 wiring for the approved amendment revision 4 (§7.3, §11.2A, §11.3, §11.4, §11.4A), on a
// synthetic full-mode E2 run. Timings are constant within a block, so controls and the null
// behave exactly and the only conditions are the ones each test sets.
// ---------------------------------------------------------------------------------------------

const E2_COMMIT = "d3fed966f32c7f44be7de5e31eae297f4051f348";
const E2_NOW = Date.UTC(2026, 10, 9, 12, 0, 0, 400);
const E2_HEADERS = ["Vary", "RSC, Accept-Encoding", "Date", new Date(Math.floor(E2_NOW / 1_000) * 1_000).toUTCString(), "Content-Type", "text/html; charset=utf-8", "Connection", "keep-alive"];
const E2_WORKTREE = String.raw`C:\t\cdp-bi4-http-a\worktree`;
const E2_ENTRY = String.raw`${E2_WORKTREE}\node_modules\next\dist\bin\next`;
const E2_COMMAND = String.raw`C:\node\node.exe ${E2_ENTRY} dev --hostname 127.0.0.1 --port 5000`;
const E2_READ = { packageJsonRealPath: String.raw`${E2_WORKTREE}\node_modules\next\package.json`, entryRealPath: E2_ENTRY, name: "next", version: "16.3.3", packageJsonSha256: "p".repeat(64) };
const E2_EVIDENCE: NextVersionEvidence = {
  runCommit: E2_COMMIT,
  worktreePath: E2_WORKTREE,
  worktreeHead: E2_COMMIT,
  // Amendment r5 A5-1 fields: Git's filtered blob ID equals the commit's, and the raw copy matches exactly.
  lockfile: {
    gitBlobId: "b".repeat(40),
    commitBlobSha256: "l".repeat(64),
    worktreeCopySha256: "l".repeat(64),
    worktreeCopyCrlfToLfSha256: "c".repeat(64),
    worktreeFilteredBlobId: "b".repeat(40),
    gitSettings: { autocrlf: [], eol: [], safecrlf: [], attributes: [], lsFilesEol: "" },
    entries: [{ key: "node_modules/next", version: "16.3.3" }],
  },
  launch: { nodeExecutable: String.raw`C:\node\node.exe`, entryPath: E2_ENTRY, port: 5000, pid: 7, creationTime: "1", commandLine: E2_COMMAND },
  installedBeforeStart: E2_READ,
  installedAfterMeasured: { ...E2_READ, liveIdentity: { pid: 7, creationTime: "1", commandLine: E2_COMMAND } },
};
/** Stops every statistic at its first check, so a gate-only test stays cheap. Gates run first. */
const GATES_ONLY = { ...OPTIONS, deadline: 1, now: () => 2 };

interface SyntheticE2Options {
  /** The body's visible text per request; the same text everywhere means post-mask agreement. */
  readonly text?: (sequence: number) => string;
  readonly evidence?: NextVersionEvidence;
  readonly invalid?: readonly string[];
  readonly headers?: (identity: PlanIdentity) => readonly string[];
  /** The first-chunk calibration delay is omitted, so its control fails. */
  readonly brokenControl?: boolean;
  /** NC-B is shifted, so the null comparison fires. */
  readonly nullShift?: boolean;
  /** This many measured `next` requests fail in transport. */
  readonly transportFailures?: number;
  /** Keep only measured blocks up to this one, so a test that writes every body to disk stays small. */
  readonly lastBlock?: number;
  /** `validation`: a V-A capture — the E2 smoke schedule, `mode: "smoke"`, the marker, no pass label. */
  readonly shape?: "full" | "validation";
}

/** A synthetic full E2 run (or a V-A capture), with the stored UUID-masked bodies its records name. */
function syntheticE2(options: SyntheticE2Options = {}): { manifest: RunManifest; records: MeasurementRecord[]; stored: Map<string, Buffer> } {
  const validation = options.shape === "validation";
  const plan = buildPlan({ boundary: "e2", mode: validation ? "smoke" : "full", seed: "synthetic-e2", delaysNs: [5_000, 20_000, 80_000], background: 0 });
  const stored = new Map<string, Buffer>();
  let failures = 0;
  const records = plan.requests
    .filter((request) => request.phase === "measured" && request.block <= (options.lastBlock ?? Number.POSITIVE_INFINITY))
    .map((request): MeasurementRecord => {
      const identity = plan.identities[request.identity] as PlanIdentity;
      const base = 1_000_000 + ((request.block * 37) % 101) * 10;
      const delay = identity.delayIndex === undefined ? 0 : (plan.delaysNs[identity.delayIndex] as number);
      const common = { sequence: request.sequence, phase: request.phase, block: request.block, identity: request.identity, cls: identity.cls, target: identity.target };

      if (identity.target === "calibration") {
        const ttfbShift = identity.placement === "first" && options.brokenControl !== true ? delay : 0;
        const ttlbShift = identity.placement === "first" ? (options.brokenControl === true ? 0 : delay) : identity.placement === "final" ? delay : 0;
        return { ...common, ttfbNs: String(base + ttfbShift), ttlbNs: String(base + 500_000 + ttlbShift), status: 200, reusedSocket: true };
      }

      if ((options.transportFailures ?? 0) > failures) {
        failures += 1;
        return { ...common, transportError: "ECONNRESET" };
      }

      const value = String(request.sequence).padStart(21, "A");
      const text = options.text?.(request.sequence) ?? "Not available";
      const raw = Buffer.from(
        `<html><a href="/directory/${identity.key}">x</a>${NEXT_R_PREFIX}${value}${NEXT_R_SUFFIX}fetch('?_rsc=k')}</script><h1>${text}</h1></html>`,
        "latin1",
      );
      const masked = maskOwnIdentity(raw, identity.key);
      const maskedBodyHash = sha256Hex(masked.masked);
      stored.set(maskedBodyHash, masked.masked);
      const shift = options.nullShift === true && identity.cls === "NCB" ? 50_000 : 0;

      return {
        ...common,
        ttfbNs: String(base + shift),
        ttlbNs: String(base + 500_000 + shift),
        status: 200,
        reusedSocket: true,
        rawBodyHash: sha256Hex(raw),
        maskedBodyHash,
        bodyReplacements: masked.count,
        bodyOffsets: masked.offsets,
        rawHeaders: options.headers?.(identity) ?? E2_HEADERS,
        writeStartMs: E2_NOW - 5,
        responseEndMs: E2_NOW + 5,
      };
    });

  return {
    manifest: {
      mode: validation ? "smoke" : "full",
      boundary: "e2",
      ...(validation ? { validation: VALIDATION_MARKER } : { replicate: 1 }),
      seed: plan.seed,
      delaysNs: plan.delaysNs,
      backgroundCount: 0,
      commit: E2_COMMIT,
      identities: plan.identities,
      startedAt: "2026-11-09T00:00:00.000Z",
      invalid: [...(options.invalid ?? [])],
      ...(options.evidence === undefined ? {} : { nextEvidence: options.evidence }),
    },
    records,
    stored,
  };
}

const sourceOf = (stored: ReadonlyMap<string, Buffer>): BodySource => (hash) => stored.get(hash);
const textOf = (report: AnalysisReport): string => `${renderReport(report)}\n${JSON.stringify(report)}`;
const firstMetric = (report: AnalysisReport) => report.comparisons[0]?.metrics[0];

describe("E2 gates with the next dev request-ID mask (approved amendment revision 4)", () => {
  it("T-A1 a run with no Next.js version evidence (the historical smoke's shape) is withheld by the guard", () => {
    const { manifest, records, stored } = syntheticE2();
    const report = analyzeRun(manifest, records, GATES_ONLY, sourceOf(stored));

    expect(report.gates.nextRequestId?.guard).toBe("missing");
    expect(report.withheld).toEqual([NEXT_VERSION_WITHHELD]);
    expect(report.gates.body?.agreement).toBe(true);
  });

  it("T-A2 an absent or mismatched stored body is a missing mask outcome and withholds", () => {
    const { manifest, records, stored } = syntheticE2({ evidence: E2_EVIDENCE });
    const next = records.filter((record) => record.target === "next" && record.cls === "PE");
    const absent = next[0]?.maskedBodyHash as string;
    const altered = next[1]?.maskedBodyHash as string;
    const source: BodySource = (hash) => (hash === absent ? undefined : hash === altered ? Buffer.from("tampered") : stored.get(hash));
    const report = analyzeRun(manifest, records, GATES_ONLY, source);

    expect(report.withheld).toEqual([REQUEST_ID_MASK_WITHHELD]);
    expect(report.gates.nextRequestId?.maskFailures.map((failure) => failure.outcome)).toEqual(["missing", "missing"]);
    expect(analyzeRun(manifest, records, GATES_ONLY).withheld).toEqual([REQUEST_ID_MASK_WITHHELD]);
  });

  it("T-A5 smoke-mode E2 data is still refused, so the historical smoke stays withheld", () => {
    const { manifest, records, stored } = syntheticE2({ evidence: E2_EVIDENCE });

    expect(() => analyzeRun({ ...manifest, mode: "smoke" }, records, OPTIONS, sourceOf(stored))).toThrow(/refuses smoke-mode data/);
  });

  it("T-A3 the existing header label line is unchanged on a header mismatch", () => {
    const { manifest, records, stored } = syntheticE2({
      evidence: E2_EVIDENCE,
      headers: (identity) => (identity.cls === "RJ" ? [...E2_HEADERS, "Cache-Control", "private"] : E2_HEADERS),
    });
    const report = analyzeRun(manifest, records, GATES_ONLY, sourceOf(stored));

    expect(report.withheld).toEqual([HEADER_WITHHELD]);
    expect(renderReport(report)).toContain("- Header mismatch label: State-associated");
  });

  describe("T-A3 and T-A6: a disjoint, all-unique post-mask body mismatch, with nothing else", () => {
    const { manifest, records, stored } = syntheticE2({ evidence: E2_EVIDENCE, text: (sequence) => `Not available ${sequence}` });
    let report: AnalysisReport;

    it("T-A6 withholds without being Invalid, with statistics still computed and stored", () => {
      report = analyzeRun(manifest, records, OPTIONS, sourceOf(stored));

      expect(report.status).toBe("complete");
      expect(report.invalid).toEqual([]);
      expect(report.withheld).toEqual([BODY_WITHHELD]);
      expect(report.comparisons.length).toBeGreaterThan(0);
      expect(interpretationOf(report, firstMetric(report) as NonNullable<ReturnType<typeof firstMetric>>)).toBe(BODY_WITHHELD);
    }, HEAVY_ANALYSIS_TIMEOUT_MS);

    it("T-A3 reports descriptively, with the exploratory wording and no state-based finding", () => {
      const text = textOf(report);

      expect(text).toContain(NEXT_R_MASK_NOTE);
      expect(text).toContain(NEXT_VERSION_GUARD_NOTE);
      expect(text).toContain("Body variation summary (descriptive only)");
      expect(text).not.toMatch(/possible non-timing|BI-4 failure|state-associated/i);
      expect(report.gates.body?.variationSummary.overlap.every((pair) => pair.sharedSignatures === 0)).toBe(true);
    });
  });

  it("T-A7 independent Invalid conditions keep priority, and every reason is reported", () => {
    const { manifest, records, stored } = syntheticE2({
      evidence: E2_EVIDENCE,
      text: (sequence) => `Not available ${sequence}`,
      invalid: ["Invalid (file safety): restricted-file metadata changed for CLAUDE.md"],
      brokenControl: true,
      nullShift: true,
      transportFailures: 200,
    });
    const report = analyzeRun(manifest, records, OPTIONS, sourceOf(stored));
    const startsWith = (prefix: string): boolean => report.invalid.some((reason) => reason.startsWith(prefix));

    expect(report.status).toBe("complete");
    expect(startsWith("Invalid (file safety)")).toBe(true);
    expect(startsWith("Invalid (transport)")).toBe(true);
    expect(startsWith("Invalid (control)")).toBe(true);
    expect(startsWith("Invalid (null fired)")).toBe(true);
    expect(report.withheld).toEqual([BODY_WITHHELD]);
    expect(interpretationOf(report, firstMetric(report) as NonNullable<ReturnType<typeof firstMetric>>)).toMatch(/^Invalid: /);
    expect(renderReport(report)).toContain(BODY_WITHHELD);
  }, HEAVY_ANALYSIS_TIMEOUT_MS);

  it("T-A8 one failed mask with agreeing successful responses: replicate-wide agreement not established, a labelled subset comparison, and Invalid still first", () => {
    const { manifest, records, stored } = syntheticE2({
      evidence: E2_EVIDENCE,
      invalid: ["Invalid (file safety): restricted-file metadata changed for CLAUDE.md"],
    });
    const absent = records.find((record) => record.target === "next" && record.cls === "RJ")?.maskedBodyHash as string;
    const report = analyzeRun(manifest, records, OPTIONS, (hash) => (hash === absent ? undefined : stored.get(hash)));
    const rendered = renderReport(report);

    expect(report.status).toBe("complete");
    expect(report.withheld).toEqual([REQUEST_ID_MASK_WITHHELD]);
    expect(report.invalid).toEqual(["Invalid (file safety): restricted-file metadata changed for CLAUDE.md"]);
    expect(report.gates.body).toBeUndefined();
    expect(report.gates.nextRequestId?.postMaskScope).toBe("subset");
    expect(report.gates.bodySubset?.scope).toBe(POST_MASK_SUBSET_LABEL);
    expect(report.gates.bodySubset?.agreement).toBe(true);
    expect(rendered).toContain(`- Post-mask body agreement: ${POST_MASK_NOT_ESTABLISHED}`);
    expect(rendered).toContain(`- Post-mask ${POST_MASK_SUBSET_LABEL}:`);
    expect(rendered).not.toContain("(replicate-wide): agreement");
    expect(interpretationOf(report, firstMetric(report) as NonNullable<ReturnType<typeof firstMetric>>)).toMatch(/^Invalid: /);
  }, HEAVY_ANALYSIS_TIMEOUT_MS);

  it("T-A4 writes the stage 1 diagnostic from UUID-masked bodies even when post-mask agreement holds", () => {
    // Ten measured blocks: every stored body is written to disk, which dominates this test's time.
    const { manifest, records, stored } = syntheticE2({ evidence: E2_EVIDENCE, lastBlock: 10 });
    const base = mkdtempSync(join(tmpdir(), "bi4-analyze-e2-test-"));
    try {
      const run = join(base, "run");
      mkdirSync(join(run, "bodies"), { recursive: true });
      writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(run, "requests.ndjson"), records.map((record) => JSON.stringify(record)).join("\n"));
      for (const [hash, body] of stored) writeFileSync(join(run, "bodies", `${hash}.bin`), body);

      const out = join(base, "out");
      const report = writeAnalysis(run, out, OPTIONS);
      const diagnosis = JSON.parse(readFileSync(join(out, "evidence", "diagnostic-variation.json"), "utf8")) as { label: string; perRequest: { edits: unknown[] | undefined }[] };

      expect(report.status).toBe("complete");
      expect(report.withheld).toEqual([]);
      expect(report.gates.body?.agreement).toBe(true);
      expect(report.gates.bodyUuidOnly?.agreement).toBe(false);
      expect(readdirSync(out).sort()).toEqual(["evidence", "report.json", "report.md"]);
      expect(readdirSync(join(out, "evidence"))).toEqual(["diagnostic-variation.json"]);
      expect(diagnosis.label).toBe(DIAGNOSTIC_LABEL);
      expect(diagnosis.perRequest.length).toBeGreaterThan(0);
      // Every differing body shows the value as an edit, except one equal to the diagnostic's own reference.
      expect(diagnosis.perRequest.filter((entry) => (entry.edits?.length ?? 0) === 0).length).toBeLessThanOrEqual(1);
      expect(diagnosis.perRequest.filter((entry) => (entry.edits?.length ?? 0) > 0).length).toBeGreaterThan(0);
      expect(existsSync(join(run, "bodies"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, HEAVY_ANALYSIS_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Amendment revision 5 A5-3: the V-A validation evaluation, through the shared E2 gate evaluator,
// on synthetic captures only. Nothing here starts a process, a database or a server.
// ---------------------------------------------------------------------------------------------

const FILE_SAFETY = "Invalid (file safety): restricted-file metadata changed for CLAUDE.md";
const vaCapture = (options: SyntheticE2Options = {}) => syntheticE2({ evidence: E2_EVIDENCE, shape: "validation", ...options });
const e2Keys = (gates: object) => {
  const { body, bodySubset, bodyUuidOnly, headers, nextRequestId } = gates as Record<string, unknown>;
  return { body, bodySubset, bodyUuidOnly, headers, nextRequestId };
};
const fileHashes = (directory: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex");
    }
  };
  walk(directory, "");
  return out;
};
function writeRun(base: string, capture: ReturnType<typeof syntheticE2>): string {
  const run = join(base, "run");
  mkdirSync(join(run, "bodies"), { recursive: true });
  writeFileSync(join(run, "manifest.json"), JSON.stringify(capture.manifest));
  writeFileSync(join(run, "requests.ndjson"), capture.records.map((record) => JSON.stringify(record)).join("\n"));
  for (const [hash, body] of capture.stored) writeFileSync(join(run, "bodies", `${hash}.bin`), body);
  return run;
}

describe("the V-A validation evaluation (amendment r5 A5-3)", () => {
  it("T-VA1 the extraction leaves analyzeRun's E2 gates, withheld labels and Invalid reasons as the shared evaluator gives them", () => {
    const { manifest, records, stored } = syntheticE2({ evidence: E2_EVIDENCE, text: (sequence) => `Not available ${sequence}`, invalid: [FILE_SAFETY] });
    const report = analyzeRun(manifest, records, GATES_ONLY, sourceOf(stored));
    const shared = evaluateE2Evidence(manifest, records, sourceOf(stored));

    expect(e2Keys(report.gates)).toEqual(e2Keys(shared.gates));
    expect(report.withheld).toEqual(shared.withheld);
    expect(report.withheld).toEqual([BODY_WITHHELD]);
    expect(report.invalid).toEqual([FILE_SAFETY]);
    expect(report.malformed).toEqual(shared.malformed);

    const e1 = syntheticE1();
    expect(Object.keys(analyzeRun(e1.manifest, e1.records, GATES_ONLY).gates)).toEqual(["e1Values"]);
  });

  it("T-VA2 analyze still refuses smoke data, including a marked V-A pass", () => {
    const { manifest, records, stored } = vaCapture();
    const base = mkdtempSync(join(tmpdir(), "bi4-va2-"));
    try {
      const run = writeRun(base, { manifest, records, stored });

      expect(() => analyzeRun(manifest, records, OPTIONS, sourceOf(stored))).toThrow(/refuses smoke-mode data/);
      expect(() => readRun(run)).toThrow(/refuses smoke-mode data/);
      expect(() => writeAnalysis(run, join(base, "out"), OPTIONS)).toThrow(/refuses smoke-mode data/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("T-VA3 the validation evaluation refuses unmarked, full-mode and E1 manifests", () => {
    const { manifest, records, stored } = vaCapture();
    const { validation: _marker, ...unmarked } = manifest;

    expect(() => evaluateE2Validation(unmarked as RunManifest, records, sourceOf(stored))).toThrow(/accepts only an E2 V-A validation pass/);
    expect(() => evaluateE2Validation({ ...manifest, mode: "full" }, records, sourceOf(stored))).toThrow(/accepts only/);
    expect(() => evaluateE2Validation({ ...manifest, boundary: "e1" }, records, sourceOf(stored))).toThrow(/accepts only/);
  });

  it("T-VA4 the validation and the full analyzer give identical gates on the same capture", () => {
    const capture = vaCapture({ text: (sequence) => (sequence % 7 === 0 ? `Not available ${sequence}` : "Not available") });
    const validation = evaluateE2Validation(capture.manifest, capture.records, sourceOf(capture.stored));
    const shared = evaluateE2Evidence(capture.manifest, capture.records, sourceOf(capture.stored));
    const { validation: _marker, ...asFull } = capture.manifest;
    const full = analyzeRun({ ...asFull, mode: "full", replicate: 1 }, capture.records, GATES_ONLY, sourceOf(capture.stored));
    const gated = capture.records.filter((record) => record.target === "next" && record.maskedBodyHash !== undefined);

    expect(new Set(gated.map((record) => record.cls))).toEqual(new Set(["NE", "NCA", "NCB", "PE", "RJ", "UP", "MF"]));
    expect(validation.gates).toEqual(shared.gates);
    expect(e2Keys(full.gates)).toEqual(e2Keys(validation.gates as object));
    expect(validation.withheld).toEqual(full.withheld);
  });

  it("T-VA5 the validation report holds no timing statistic and says so", () => {
    const report = evaluateE2Validation(vaCapture().manifest, vaCapture().records, sourceOf(vaCapture().stored));
    const json = JSON.stringify(report);
    const rendered = renderE2Validation(report);

    expect(json).not.toMatch(/"comparisons"|"metrics"|"accuracy"|"projections"|"median"|"p10"|"identities":\[\{"name"/);
    expect(report.label).toBe(VALIDATION_LABEL);
    expect(rendered).toContain("Validation only — no timing statistic was computed.");
    expect(rendered).toContain("Not a smoke run; no smoke verdict or S-C criterion changes.");
  });

  describe("T-VA6 the four categories stay distinct, with Invalid first", () => {
    const sections = (rendered: string) => ["## 1. Independent Invalid", "## 2. Next.js version guard", "## 3. Request-ID mask", "## 4. Residual body mismatch"].map((heading) => rendered.indexOf(heading));

    it("guard refusal only", () => {
      const capture = syntheticE2({ shape: "validation" });
      const report = evaluateE2Validation(capture.manifest, capture.records, sourceOf(capture.stored));

      expect(report.withheld).toEqual([NEXT_VERSION_WITHHELD]);
      expect(report.invalid).toEqual([]);
      expect(report.gates?.nextRequestId).toMatchObject({ guard: "missing", guardCheck: "evidence-absent" });
      expect(renderE2Validation(report)).toContain("- Withheld — Next.js version guard, pending review");
    });

    it("mask refusal only", () => {
      const capture = vaCapture();
      const absent = capture.records.find((record) => record.cls === "PE" && record.maskedBodyHash !== undefined)?.maskedBodyHash;
      const report = evaluateE2Validation(capture.manifest, capture.records, (hash) => (hash === absent ? undefined : capture.stored.get(hash)));

      expect(report.withheld).toEqual([REQUEST_ID_MASK_WITHHELD]);
      expect(renderE2Validation(report)).toContain("- Mask refusal, request");
    });

    it("residual post-mask mismatch only", () => {
      const capture = vaCapture({ text: (sequence) => `Not available ${sequence}` });
      const report = evaluateE2Validation(capture.manifest, capture.records, sourceOf(capture.stored));

      expect(report.withheld).toEqual([BODY_WITHHELD]);
      expect(report.gates?.nextRequestId?.guard).toBe("ok");
    });

    it("Invalid only", () => {
      const capture = vaCapture({ invalid: [FILE_SAFETY] });
      const report = evaluateE2Validation(capture.manifest, capture.records, sourceOf(capture.stored));

      expect(report.withheld).toEqual([]);
      expect(report.headline).toBe("Gate result: agreement");
      expect(report.interpretation).toBe(`Invalid: ${FILE_SAFETY}`);
    });

    it("all four together, each in its own section, Invalid first", () => {
      const capture = syntheticE2({ shape: "validation", invalid: [FILE_SAFETY], text: (sequence) => `Not available ${sequence}` });
      const absent = capture.records.find((record) => record.cls === "RJ" && record.maskedBodyHash !== undefined)?.maskedBodyHash;
      const report = evaluateE2Validation(capture.manifest, capture.records, (hash) => (hash === absent ? undefined : capture.stored.get(hash)), { extraInvalid: ["Invalid (residue): a leftover root"] });
      const rendered = renderE2Validation(report);
      const at = sections(rendered);

      expect(report.withheld).toEqual([NEXT_VERSION_WITHHELD, REQUEST_ID_MASK_WITHHELD, BODY_WITHHELD]);
      expect(report.invalid).toEqual([FILE_SAFETY, "Invalid (residue): a leftover root"]);
      expect(report.interpretation.startsWith("Invalid: ")).toBe(true);
      expect(at.every((position, index) => position > 0 && (index === 0 || position > (at[index - 1] as number)))).toBe(true);
      expect(rendered.split("\n")[0]).toBe(report.headline);
    });
  });

  it("T-VA7 a directory shaped like the second smoke's S-A is refused, and nothing is written", () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-va7-"));
    try {
      const capture = vaCapture();
      const { validation: _marker, ...smokeShaped } = capture.manifest;
      const run = writeRun(base, { ...capture, manifest: { ...smokeShaped, pass: "S-A" } as RunManifest });
      const before = fileHashes(base);

      expect(() => readValidationRun(run)).toThrow(/accepts only an E2 V-A validation pass/);
      expect(() => writeE2Validation(run, join(base, "validation"))).toThrow(/accepts only/);
      expect(fileHashes(base)).toEqual(before);
      expect(existsSync(join(base, "validation"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("T-VA8 output separation holds, only the two report files are written, and the run directory is unchanged", () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-va8-"));
    try {
      const run = writeRun(base, vaCapture());
      const before = fileHashes(run);
      const occupied = join(base, "occupied");
      mkdirSync(occupied);
      writeFileSync(join(occupied, "x"), "x");

      expect(() => writeE2Validation(run, run)).toThrow(/must not be the run directory or inside it/);
      expect(() => writeE2Validation(run, join(run, "validation"))).toThrow(/must not be the run directory or inside it/);
      expect(() => writeE2Validation(run, base)).toThrow(/must not contain the run directory/);
      expect(() => writeE2Validation(run, occupied)).toThrow(/must be empty/);

      const out = join(base, "validation");
      writeE2Validation(run, out);

      expect(readdirSync(out).sort()).toEqual(["validation.json", "validation.md"]);
      expect(fileHashes(run)).toEqual(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("T-VA11 the report writer resolves aliases and rechecks its destination immediately before writing", () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-va11-"));
    try {
      const run = writeRun(base, vaCapture());
      const alias = join(base, "alias-into-run");
      const realpath = (path: string): string => (path === alias ? join(run, "inner") : path);

      expect(() => writeE2Validation(run, alias, { realpath })).toThrow(/must not be the run directory or inside it/);
      expect(existsSync(join(run, "inner"))).toBe(false);

      // The destination becomes non-empty while the evaluation runs: the recheck refuses the write.
      const out = join(base, "validation");
      mkdirSync(out);
      const now = (): number => {
        if (!existsSync(join(out, "intruder"))) writeFileSync(join(out, "intruder"), "x");
        return 0;
      };
      expect(() => writeE2Validation(run, out, { now, deadline: 1 })).toThrow(/must be empty/);
      expect(readdirSync(out)).toEqual(["intruder"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("T-VA12 the report carries the HTTP attempt summary the pass recorded", () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-va12-"));
    try {
      const run = writeRun(base, vaCapture());
      writeFileSync(join(run, "http-attempts.json"), JSON.stringify({ limit: 80, used: 76, byPhase: { "readiness:next": 2, "readiness:calibration": 1, "plan:next": 52, "plan:calibration": 21 }, attempts: [] }));
      const out = join(base, "validation");
      const report = writeE2Validation(run, out);

      expect(report.operational.httpAttempts).toEqual({ limit: 80, used: 76, byPhase: { "readiness:next": 2, "readiness:calibration": 1, "plan:next": 52, "plan:calibration": 21 } });
      expect(readFileSync(join(out, "validation.md"), "utf8")).toContain("- HTTP attempts (readiness included): 76 of 80");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("T-VA9 a withheld gate on an otherwise clean pass is the report's first line", () => {
    const capture = vaCapture({ text: (sequence) => `Not available ${sequence}` });
    const report = evaluateE2Validation(capture.manifest, capture.records, sourceOf(capture.stored));

    expect(report.status).toBe("complete");
    expect(report.invalid).toEqual([]);
    expect(report.gateResult).toBe("withheld");
    expect(report.headline).toBe(`Gate result: WITHHELD — ${BODY_WITHHELD}`);
    expect(renderE2Validation(report).split("\n")[0]).toBe(report.headline);
    expect(JSON.parse(JSON.stringify(report)).gateResult).toBe("withheld");
  });

  it("T-VA10 an incomplete evaluation writes only the partial report", () => {
    const base = mkdtempSync(join(tmpdir(), "bi4-va10-"));
    try {
      const run = writeRun(base, vaCapture());
      let reads = 0;
      // The first two checks pass (start, first body read); every later one is past the limit.
      const now = (): number => ((reads += 1) > 2 ? 10 : 0);
      const out = join(base, "validation");
      const report = writeE2Validation(run, out, { deadline: 5, now });

      expect(report.status).toBe("incomplete");
      expect(report.headline).toBe(INCOMPLETE_VALIDATION_HEADLINE);
      expect(report.gateResult).toBe("not established");
      expect(report.incomplete?.finished).toEqual(["E2 validity"]);
      expect(report.incomplete?.notStarted).toEqual(["body reads and gates", "report"]);
      expect(readdirSync(out)).toEqual(["incomplete"]);
      expect(readdirSync(join(out, "incomplete")).sort()).toEqual(["partial-validation.json", "partial-validation.md"]);
      expect(readFileSync(join(out, "incomplete", "partial-validation.md"), "utf8").split("\n")[0]).toBe(INCOMPLETE_VALIDATION_HEADLINE);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The validate-e2 CLI wiring, synthetically (plan r3 §4.4). `./cli` is imported, never run.
// ---------------------------------------------------------------------------------------------

describe("validate-e2 wiring (synthetic)", async () => {
  const before = childProcessCalls.count;
  const cli = await import("./cli");
  const importCalls = childProcessCalls.count - before;
  const FLAGS = {
    "--out": join(tmpdir(), "bi4-w-absent", "run"),
    "--validation-out": join(tmpdir(), "bi4-w-absent", "validation"),
    "--seed": "s",
    "--delays-ns": "5000,20000,80000",
    "--background": "0",
    "--commit": E2_COMMIT,
  };
  const argv = (flags: Record<string, string>): string[] => ["validate-e2", ...Object.entries(flags).flat()];
  const reportOf = (options: SyntheticE2Options = {}): ValidationReport => {
    const capture = vaCapture(options);
    return evaluateE2Validation(capture.manifest, capture.records, sourceOf(capture.stored));
  };

  function seams(overrides: Partial<import("./cli").ValidateE2Seams> = {}) {
    const calls: string[] = [];
    const lines: string[] = [];
    const passOptions: unknown[] = [];
    let evaluateOptions: unknown;
    const value: import("./cli").ValidateE2Seams = {
      now: () => 1_000,
      outputProblems: () => [],
      destinationProblems: () => [],
      say: (line) => lines.push(line),
      preflight: async () => (calls.push("preflight"), { stops: [], findings: {} }),
      runPass: async (options) => (calls.push("pass"), passOptions.push(options), { exitCode: 0, invalid: [] }),
      residue: async () => (calls.push("residue"), []),
      evaluate: (_run, _out, options) => (calls.push("evaluate"), (evaluateOptions = options), reportOf()),
      writePreflightStop: () => calls.push("preflight-stop"),
      ...overrides,
    };
    return { value, calls, lines, passOptions, evaluateOptions: () => evaluateOptions };
  }

  it("T-W0 importing ./cli starts no child process", () => {
    expect(importCalls).toBe(0);
    expect(typeof cli.runValidateE2).toBe("function");
  });

  it("T-W1 validate-e2 needs every flag and refuses the internal and replicate flags", () => {
    expect(cli.parseArguments(argv(FLAGS))).toEqual({ command: "validate-e2", flags: FLAGS });
    for (const flag of Object.keys(FLAGS)) {
      const { [flag]: _dropped, ...rest } = FLAGS as Record<string, string>;
      expect(() => cli.parseArguments(argv(rest))).toThrow(/missing required/);
    }
    for (const flag of ["--smoke-pass", "--request-cap", "--deadline", "--replicate", "--boundary"]) {
      expect(() => cli.parseArguments([...argv(FLAGS), flag, "1"])).toThrow(/unknown flag/);
    }
    expect(() => cli.parseArguments([...argv(FLAGS), "--seed", "t"])).toThrow(/given twice/);
    expect(() => cli.parseArguments(["validate-e2", "--out"])).toThrow(/needs a value/);
  });

  it("T-W2 the pass options: E2 smoke schedule, no pass label, the marker, 80 requests, 20 minutes", () => {
    const options = cli.validationOptions(FLAGS, 1_000);

    expect(options).toMatchObject({ boundary: "e2", mode: "smoke", validation: VALIDATION_MARKER, requestCap: 80, deadline: 1_000 + 20 * 60_000, commit: E2_COMMIT, delaysNs: [5_000, 20_000, 80_000], background: 0 });
    expect(options).not.toHaveProperty("pass");
    expect(options).not.toHaveProperty("replicate");
  });

  it("T-W3 the manifest carries the marker for V-A, and stays field-for-field as before for smoke and full", () => {
    const plan = buildPlan({ boundary: "e2", mode: "smoke", seed: "s", delaysNs: [5_000, 20_000, 80_000], background: 0 });
    const started = new Date("2026-11-09T00:00:00.000Z");
    const invalid: string[] = [];
    const va = cli.initialManifest(cli.validationOptions(FLAGS, 0), plan, started, { a: 1 }, invalid);
    const base = { boundary: "e2" as const, out: "o", seed: "s", delaysNs: plan.delaysNs, background: 0, commit: E2_COMMIT, requestCap: 1, deadline: 1 };
    const smoke = cli.initialManifest({ ...base, mode: "smoke", pass: "S-A" }, plan, started, { a: 1 }, invalid);
    const full = cli.initialManifest({ ...base, mode: "full", replicate: 2 }, plan, started, { a: 1 }, invalid);
    const expected = (extra: object) => ({ seed: "s", delaysNs: plan.delaysNs, backgroundCount: 0, commit: E2_COMMIT, identities: plan.identities, startedAt: started.toISOString(), environment: { a: 1 }, invalid, ...extra });

    expect(va).toEqual({ mode: "smoke", boundary: "e2", ...expected({ validation: VALIDATION_MARKER }) });
    expect(va).not.toHaveProperty("pass");
    expect(Object.keys(smoke)).toEqual(["mode", "boundary", "pass", "seed", "delaysNs", "backgroundCount", "commit", "identities", "startedAt", "environment", "invalid"]);
    expect(smoke).toEqual({ mode: "smoke", boundary: "e2", pass: "S-A", ...expected({}) });
    expect(Object.keys(full)).toEqual(["mode", "boundary", "replicate", "seed", "delaysNs", "backgroundCount", "commit", "identities", "startedAt", "environment", "invalid"]);
    expect(va.invalid).toBe(invalid);
  });

  it("T-W4 order and stops: preflight, one pass, residue, evaluation; no smoke driver or forced pass", async () => {
    const normal = seams();
    expect(await cli.runValidateE2(FLAGS, normal.value)).toBe(0);
    expect(normal.calls).toEqual(["preflight", "pass", "residue", "evaluate"]);
    expect(normal.passOptions).toEqual([cli.validationOptions(FLAGS, 1_000)]);
    expect(Object.keys(normal.value).sort()).toEqual(["destinationProblems", "evaluate", "now", "outputProblems", "preflight", "residue", "runPass", "say", "writePreflightStop"]);

    const stopped = seams({ preflight: async () => ({ stops: ["checkout lockfile lockfile-bytes"], findings: {} }) });
    expect(await cli.runValidateE2(FLAGS, stopped.value)).toBe(2);
    expect(stopped.calls).toEqual(["preflight-stop"]);
    expect(stopped.lines).toEqual(["refused: checkout lockfile lockfile-bytes"]);

    const refused = seams({ runPass: async () => ({ exitCode: 2, invalid: ["the main tree is not clean"] }) });
    expect(await cli.runValidateE2(FLAGS, refused.value)).toBe(2);
    expect(refused.calls).toEqual(["preflight"]);

    const invalid = seams({ runPass: async () => ({ exitCode: 1, invalid: ["Invalid (validation stop): worktree lockfile lockfile-bytes"] }) });
    expect(await cli.runValidateE2(FLAGS, invalid.value)).toBe(1);
    expect(invalid.calls).toEqual(["preflight", "residue", "evaluate"]);
  });

  /** Synthetic directories: two empty capture and report directories, a repository and a temp directory, and junction aliases. */
  const ROOT = process.platform === "win32" ? "C:\\v" : "/v";
  const at = (...parts: string[]): string => join(ROOT, ...parts);
  const ALIASES: Readonly<Record<string, string>> = {
    [at("alias-into-run")]: at("cap", "run", "inner"),
    [at("alias-of-run")]: at("cap", "run"),
    [at("alias-over-run")]: at("cap"),
  };
  const safety: import("./cli").OutputSafetySeams = {
    repositoryRoot: at("repo"),
    tempDirectory: at("temp"),
    directoryEntries: (path) => (path.startsWith(ROOT) ? [] : undefined),
    realpath: (path) => ALIASES[path] ?? path,
  };
  const goodDirs = { "--out": at("cap", "run"), "--validation-out": at("reports", "va") };

  it("T-W5 overlapping output directories are refused before anything runs", async () => {
    for (const validationOut of [goodDirs["--out"], at("cap", "run", "validation"), at("cap")]) {
      const s = seams({ outputProblems: (out, validation) => cli.validationOutputDirectoryProblems(out, validation, safety) });
      expect(await cli.runValidateE2({ ...FLAGS, ...goodDirs, "--validation-out": validationOut }, s.value)).toBe(2);
      expect(s.calls).toEqual([]);
    }
  });

  it("T-W10 the output-directory rules apply to both directories, on resolved paths, before anything is created or written", async () => {
    const problems = (out: string, validationOut: string) => cli.validationOutputDirectoryProblems(out, validationOut, safety);

    expect(problems(goodDirs["--out"], goodDirs["--validation-out"])).toEqual([]);
    // A relative path.
    expect(problems("relative\\run", goodDirs["--validation-out"])).toEqual(["--out: the output directory must be an absolute path"]);
    expect(problems(goodDirs["--out"], "va")).toEqual(["--validation-out: the output directory must be an absolute path"]);
    // A repository or temp destination.
    expect(problems(goodDirs["--out"], at("repo", "reports"))).toContain("--validation-out: the output directory must be outside the repository");
    expect(problems(goodDirs["--out"], at("temp", "reports"))).toContain("--validation-out: the output directory must be outside the system temp directory, where every harness root is created");
    expect(problems(at("temp", "run"), goodDirs["--validation-out"])).toContain("--out: the output directory must be outside the system temp directory, where every harness root is created");
    // A non-existent destination.
    expect(problems(goodDirs["--out"], process.platform === "win32" ? "D:\\absent" : "/absent")).toContain("--validation-out: the output directory must already exist");
    // Junction aliases that overlap the capture directory.
    expect(problems(goodDirs["--out"], at("alias-into-run"))).toEqual(["--validation-out must not be --out or lie inside it, including through a junction or link"]);
    expect(problems(goodDirs["--out"], at("alias-of-run"))).toEqual(["--validation-out must not be --out or lie inside it, including through a junction or link"]);
    expect(problems(goodDirs["--out"], at("alias-over-run"))).toEqual(["--validation-out must not contain --out, including through a junction or link"]);

    for (const bad of ["va", at("repo", "reports"), at("temp", "reports"), at("alias-into-run")]) {
      const s = seams({ outputProblems: problems });
      expect(await cli.runValidateE2({ ...FLAGS, ...goodDirs, "--validation-out": bad }, s.value)).toBe(2);
      expect(s.calls).toEqual([]);
    }
  });

  it("T-W11 a report destination that fails its recheck receives no preflight-stop files", async () => {
    const s = seams({
      preflight: async () => ({ stops: ["checkout lockfile lockfile-bytes"], findings: {} }),
      destinationProblems: () => ["--validation-out: the output directory must be empty"],
    });

    expect(await cli.runValidateE2(FLAGS, s.value)).toBe(2);
    expect(s.calls).not.toContain("preflight-stop");
    expect(s.lines).toEqual(["refused: checkout lockfile lockfile-bytes", "refused: --validation-out: the output directory must be empty"]);
  });

  it("T-W19 the destination policy requires both paths to resolve, and an unresolvable destination gets no preflight-stop files", async () => {
    const unresolvable: import("./cli").OutputSafetySeams = {
      ...safety,
      realpath: (path) => {
        if (path === goodDirs["--validation-out"]) throw new Error("ENOENT: no such file or directory");
        return path;
      },
    };

    expect(cli.reportDestinationProblems(goodDirs["--out"], goodDirs["--validation-out"], unresolvable)).toEqual([
      "--validation-out: the path could not be resolved (ENOENT: no such file or directory)",
    ]);
    expect(cli.reportDestinationProblems(goodDirs["--out"], goodDirs["--validation-out"], safety)).toEqual([]);

    const s = seams({
      preflight: async () => ({ stops: ["checkout lockfile lockfile-git-blob"], findings: {} }),
      destinationProblems: (out, validationOut) => cli.reportDestinationProblems(out, validationOut, unresolvable),
    });
    expect(await cli.runValidateE2({ ...FLAGS, ...goodDirs }, s.value)).toBe(2);
    expect(s.calls).not.toContain("preflight-stop");
  });

  it.each(["repository", "system temp"] as const)(
    "T-W20 a destination redirected into the %s during evaluation gets no report, complete or incomplete",
    (into) => {
      const base = mkdtempSync(join(tmpdir(), "bi4-w20-"));
      try {
        const run = writeRun(base, vaCapture());
        const repo = join(base, "fake-repo");
        const temp = join(base, "fake-temp");
        let redirected = false;
        const policy: import("./cli").OutputSafetySeams = {
          repositoryRoot: repo,
          tempDirectory: temp,
          directoryEntries: (path) => (existsSync(path) ? readdirSync(path) : undefined),
          // Resolves outside both trees until the evaluation starts, then into the repository or temp.
          realpath: (path) => (redirected && path === out ? join(into === "repository" ? repo : temp, "reports") : path),
        };
        const out = join(base, "validation");
        mkdirSync(out);
        const destinationCheck = () => cli.reportDestinationProblems(run, out, policy);

        expect(destinationCheck()).toEqual([]);
        const message = into === "repository" ? /must be outside the repository/ : /must be outside the system temp directory/;

        // Completed evaluation.
        expect(() => writeE2Validation(run, out, { destinationCheck, now: () => ((redirected = true), 0), deadline: 1 })).toThrow(message);
        expect(readdirSync(out)).toEqual([]);

        // Incomplete evaluation: the limit passes and the destination is redirected at the same time.
        redirected = false;
        expect(() => writeE2Validation(run, out, { destinationCheck, now: () => ((redirected = true), 10), deadline: 5 })).toThrow(message);
        expect(readdirSync(out)).toEqual([]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("T-W12 the report destination is rechecked after the pass, and a failure writes no report", async () => {
    let checks = 0;
    const s = seams({ destinationProblems: () => (checks += 1, ["--validation-out must not be --out or lie inside it, including through a junction or link"]) });

    expect(await cli.runValidateE2(FLAGS, s.value)).toBe(1);
    expect(checks).toBe(1);
    expect(s.calls).toEqual(["preflight", "pass", "residue"]);
  });

  it("T-W6 exit codes: a withheld gate on a clean pass exits 0 and prints the headline; residue, Invalid or incomplete exit 1", async () => {
    const withheld = reportOf({ text: (sequence) => `Not available ${sequence}` });
    const clean = seams({ evaluate: () => withheld });
    expect(await cli.runValidateE2(FLAGS, clean.value)).toBe(0);
    expect(clean.lines[0]).toBe(`Gate result: WITHHELD — ${BODY_WITHHELD}`);

    const residue = seams({ residue: async () => ["the worktree record remains"] });
    expect(await cli.runValidateE2(FLAGS, residue.value)).toBe(1);
    expect(residue.evaluateOptions()).toMatchObject({ extraInvalid: ["Invalid (residue): the worktree record remains"], deadline: 1_000 + 5 * 60_000 });

    const incomplete = seams({ evaluate: () => ({ ...reportOf(), status: "incomplete", headline: INCOMPLETE_VALIDATION_HEADLINE }) });
    expect(await cli.runValidateE2(FLAGS, incomplete.value)).toBe(1);
    expect(incomplete.lines[0]).toBe(INCOMPLETE_VALIDATION_HEADLINE);
  });

  it("T-W7 the help text lists validate-e2 as validation only, not a smoke run", () => {
    expect(cli.USAGE).toContain("validate-e2 --out <abs dir> --validation-out <abs dir>");
    expect(cli.USAGE).toContain("validate-e2 is validation only, not a smoke run");
  });

  it("T-W8 V-A verifies stored states before teardown; smoke and full keep teardown first; teardown always runs", async () => {
    const run = async (validation: boolean, verify: () => Promise<readonly string[]>) => {
      const order: string[] = [];
      const invalid: string[] = [];
      let error: unknown;
      await cli
        .finishBoundary({
          validation,
          run: async () => void order.push("run"),
          verifyStoredStates: async () => (order.push("verify"), verify()),
          teardown: async () => void order.push("teardown"),
          recordInvalid: (reason) => invalid.push(reason),
        })
        .catch((caught: unknown) => (error = caught));
      return { order, invalid, error };
    };

    expect((await run(true, async () => [])).order).toEqual(["run", "verify", "teardown"]);
    expect((await run(false, async () => [])).order).toEqual(["run", "teardown", "verify"]);

    const mismatch = await run(true, async () => ["PE row changed"]);
    expect(mismatch.invalid).toEqual(["Invalid (stored state): PE row changed"]);
    expect(mismatch.order).toEqual(["run", "verify", "teardown"]);

    const thrown = await run(true, async () => {
      throw new Error("database gone");
    });
    expect(thrown.order).toEqual(["run", "verify", "teardown"]);
    expect((thrown.error as Error).message).toBe("database gone");
  });

  /** The recorded server process, and fake process inspections around it. */
  const SERVER = { pid: 100, creationTime: "133000000000000000" };
  const identityOf = (pid: number, parentPid: number, creationTime = SERVER.creationTime) => ({ pid, parentPid, creationTime, executable: "C:\\node\\node.exe", commandLine: `C:\\node\\node.exe server ${pid}` });
  /** A strict-lookup answer: a PID listening on 127.0.0.1, unbound, explicit entries, or a failed lookup. */
  type LookupAnswer = number | undefined | readonly ListeningEntry[] | Error;
  function fakeProcesses(spec: {
    /** Successive answers of the strict listener lookup; the last repeats. */
    readonly listeners: readonly LookupAnswer[];
    readonly tree?: Readonly<Record<number, readonly number[]>>;
    readonly rootCreationTime?: string | null;
    readonly childrenFail?: boolean;
    readonly onListener?: () => void;
  }) {
    let call = 0;
    const counts = { listener: 0, children: 0, inspect: 0 };
    const ops: import("./cli").ListenerInspections = {
      lookup: async (_port: number) => {
        counts.listener += 1;
        spec.onListener?.();
        const answer = spec.listeners[Math.min(call, spec.listeners.length - 1)];
        call += 1;
        if (answer instanceof Error) throw answer;
        if (answer === undefined) return [];
        return typeof answer === "number" ? [{ localAddress: "127.0.0.1", owningProcess: answer }] : answer;
      },
      processes: {
        children: async (pid: number) => {
          counts.children += 1;
          if (spec.childrenFail === true) throw new Error("CIM query returned a malformed envelope");
          return (spec.tree?.[pid] ?? []).map((child) => identityOf(child, pid));
        },
        inspect: async (pid: number) => {
          counts.inspect += 1;
          if (pid !== SERVER.pid || spec.rootCreationTime === null) return undefined;
          return identityOf(pid, 1, spec.rootCreationTime ?? SERVER.creationTime);
        },
      },
    };
    return { ops, counts };
  }
  const okExchange = (status: number): Exchange => ({ status, rawHeaders: [], body: Buffer.alloc(0), ttfbNs: 1n, ttlbNs: 2n, reusedSocket: false, writeStartMs: 0, responseEndMs: 0 });
  /** One server's V-A readiness with fakes; returns what was sent and how the budget stands. */
  async function readiness(options: {
    readonly processes: ReturnType<typeof fakeProcesses>;
    readonly send?: (attempt: number) => Promise<Exchange>;
    readonly boundMs?: number;
    readonly now?: () => number;
    readonly budget?: import("./cli").AttemptBudget;
    readonly sleep?: (ms: number) => Promise<void>;
  }) {
    const budget = options.budget ?? cli.createAttemptBudget(80);
    let sends = 0;
    const result = cli
      .waitReadyWithinBudget({
        budget,
        target: "next",
        port: 4000,
        path: "/directory/cmp",
        ready: (response) => response.status === 200,
        boundMs: options.boundMs ?? 1e9,
        signal: new AbortController().signal,
        send: async () => {
          sends += 1;
          return (options.send ?? (async () => okExchange(200)))(sends);
        },
        sleep: options.sleep ?? (async () => {}),
        now: options.now ?? (() => 0),
        listener: { server: SERVER, inspections: options.processes.ops },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const error = await result;
    return { error, sends: () => sends, budget };
  }

  it("T-W15 a delayed listener: no HTTP is sent until the recorded server's descendant binds, then one probe is charged", async () => {
    let sendsWhenBound = -1;
    let sends = 0;
    const processes = fakeProcesses({ listeners: [undefined, undefined, undefined, 102], tree: { 100: [101], 101: [102] }, onListener: () => (sendsWhenBound = sends) });
    const budget = cli.createAttemptBudget(80);

    await cli.waitReadyWithinBudget({
      budget,
      target: "next",
      port: 4000,
      path: "/directory/cmp",
      ready: (response) => response.status === 200,
      boundMs: 1e9,
      signal: new AbortController().signal,
      send: async () => (sends += 1, okExchange(200)),
      sleep: async () => {},
      now: () => 0,
      listener: { server: SERVER, inspections: processes.ops },
    });

    expect(processes.counts.listener).toBe(4);
    expect(sendsWhenBound).toBe(0);
    expect(sends).toBe(1);
    expect(budget.summary()).toMatchObject({ used: 1, byPhase: { "readiness:next": 1 } });
    // The recorded process itself listening is accepted too.
    expect((await readiness({ processes: fakeProcesses({ listeners: [SERVER.pid] }) })).error).toBeUndefined();
  });

  it.each([
    ["a foreign owner", { listeners: [999], tree: { 100: [101] } }, /next listener on port 4000 is owned by process 999, which is not the recorded server or one of its descendants/],
    ["a failed listener lookup", { listeners: [new Error("PowerShell wrote to stderr")] }, /next listener lookup failed: PowerShell wrote to stderr/],
    ["a failed ownership inspection", { listeners: [101], childrenFail: true }, /next listener ownership inspection failed: CIM query returned a malformed envelope/],
    ["a recorded server that is gone", { listeners: [101], rootCreationTime: null }, /could not be verified: the recorded server process 100 is gone or was replaced/],
    ["a recorded server whose PID was reused", { listeners: [101], rootCreationTime: "1", tree: { 100: [101] } }, /could not be verified/],
    ["a wrong address (all interfaces)", { listeners: [[{ localAddress: "0.0.0.0", owningProcess: 100 }]] }, /next listener on port 4000 is bound to 0\.0\.0\.0, not 127\.0\.0\.1/],
    ["a wrong address (IPv6 loopback)", { listeners: [[{ localAddress: "::1", owningProcess: 100 }]] }, /is bound to ::1, not 127\.0\.0\.1/],
    [
      "multiple listening entries",
      { listeners: [[{ localAddress: "127.0.0.1", owningProcess: 100 }, { localAddress: "::", owningProcess: 100 }]] },
      /next listener on port 4000 is ambiguous: 2 listening entries \(127\.0\.0\.1 pid 100, :: pid 100\)/,
    ],
  ] as const)("T-W16 %s stops the pass before any HTTP, as a validation stop", async (_name, spec, message) => {
    const { error, sends, budget } = await readiness({ processes: fakeProcesses(spec) });

    expect(error).toBeInstanceOf(cli.ValidationStop);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message.startsWith("Invalid (validation stop): next listener ")).toBe(true);
    expect(sends()).toBe(0);
    expect(budget.summary().used).toBe(0);
  });

  it("T-W17 a readiness timeout: no listener within the bound sends nothing; a listener that never answers 200 spends attempts until the same bound", async () => {
    let clock = 0;
    const tick = (): number => (clock += 1_000);
    const unbound = await readiness({ processes: fakeProcesses({ listeners: [undefined] }), boundMs: 5_000, now: tick });

    expect((unbound.error as Error).message).toBe("port 4000 had no listener within the readiness bound");
    expect(unbound.error).not.toBeInstanceOf(cli.ValidationStop);
    expect(unbound.sends()).toBe(0);
    expect(unbound.budget.summary().used).toBe(0);

    // Time passes while waiting between probes, as it does for real; reading the clock does not move it.
    clock = 0;
    const neverReady = await readiness({
      processes: fakeProcesses({ listeners: [SERVER.pid] }),
      boundMs: 5_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      send: async () => okExchange(503),
    });

    expect((neverReady.error as Error).message).toBe("port 4000 was not ready within 5000ms");
    expect(neverReady.sends()).toBeGreaterThan(0);
    expect(neverReady.budget.summary().used).toBe(neverReady.sends());
  });

  it("T-W18 failed probes after the listener binds still consume the shared budget, and a spent budget sends nothing more", async () => {
    const failing = async (attempt: number): Promise<Exchange> => {
      if (attempt <= 2) throw new Error("socket hang up");
      return okExchange(attempt <= 4 ? 500 : 200);
    };
    const recovered = await readiness({ processes: fakeProcesses({ listeners: [101], tree: { 100: [101] } }), send: failing });

    expect(recovered.error).toBeUndefined();
    expect(recovered.sends()).toBe(5);
    expect(recovered.budget.summary().attempts.map((attempt) => attempt.outcome)).toEqual(["socket hang up", "socket hang up", "status 500", "status 500", "status 200"]);

    const nearlySpent = cli.createAttemptBudget(80);
    for (let i = 0; i < 78; i += 1) nearlySpent.trace("readiness", "calibration", "/health", "connect ECONNREFUSED");
    const spent = await readiness({ processes: fakeProcesses({ listeners: [SERVER.pid] }), send: async () => okExchange(500), budget: nearlySpent });

    expect((spent.error as Error).message).toBe("Invalid (validation cap): the 80-attempt HTTP budget was exhausted during next readiness");
    expect(spent.sends()).toBe(2);
    expect(nearlySpent.remaining()).toBe(0);
  });

  it("T-W21 a port taken over after a failed probe is refused before the next probe is sent", async () => {
    const processes = fakeProcesses({ listeners: [101, 999], tree: { 100: [101] } });
    const { error, sends, budget } = await readiness({ processes, send: async () => { throw new Error("socket hang up"); } });

    expect(error).toBeInstanceOf(cli.ValidationStop);
    expect((error as Error).message).toBe("Invalid (validation stop): next listener on port 4000 is owned by process 999, which is not the recorded server or one of its descendants");
    expect(sends()).toBe(1);
    expect(processes.counts.listener).toBe(2);
    expect(budget.summary().attempts.map((attempt) => attempt.outcome)).toEqual(["socket hang up"]);

    // A takeover onto another address, or by a second listener, after a failed probe is refused the same way.
    for (const takeover of [[{ localAddress: "0.0.0.0", owningProcess: 101 }], [{ localAddress: "127.0.0.1", owningProcess: 101 }, { localAddress: "127.0.0.1", owningProcess: 999 }]] as const) {
      const again = await readiness({ processes: fakeProcesses({ listeners: [101, takeover], tree: { 100: [101] } }), send: async () => okExchange(503) });
      expect(again.error).toBeInstanceOf(cli.ValidationStop);
      expect(again.sends()).toBe(1);
    }
  });

  it("T-W22 a takeover after readiness and before scheduled traffic stops the pass, and no scheduled request is sent", async () => {
    const run = async (handoffAnswer: LookupAnswer) => {
      const budget = cli.createAttemptBudget(80);
      // Readiness sees the owned listener; the handoff check sees the answer under test.
      const processes = fakeProcesses({ listeners: [SERVER.pid, handoffAnswer] });
      let measured = false;
      const check = { target: "calibration" as const, port: 4001, server: SERVER, inspections: processes.ops };
      const outcome = cli.readinessThenMeasure({
        budget,
        readiness: [
          () =>
            cli.waitReadyWithinBudget({ budget, target: "calibration", port: 4001, path: "/health", ready: () => true, boundMs: 1e9, signal: new AbortController().signal, send: async () => okExchange(200), sleep: async () => {}, now: () => 0, listener: { server: SERVER, inspections: processes.ops } }),
        ],
        afterReadiness: async () => {},
        handoff: [() => cli.verifyOwnedListenerNow(check)],
        measure: async () => ((measured = true), { completed: 0 }),
      });
      const error = await outcome.then(() => undefined, (caught: unknown) => caught);
      return { error, measured, budget };
    };

    const foreign = await run([{ localAddress: "127.0.0.1", owningProcess: 999 }]);
    expect((foreign.error as Error).message).toBe("Invalid (validation stop): calibration listener on port 4001 is owned by process 999, which is not the recorded server or one of its descendants");
    expect(foreign.measured).toBe(false);
    expect(foreign.budget.summary().used).toBe(1);

    const gone = await run(undefined);
    expect((gone.error as Error).message).toBe("Invalid (validation stop): calibration listener on port 4001 is no longer bound before scheduled traffic");
    expect(gone.measured).toBe(false);

    const failed = await run(new Error("CIM query returned a malformed envelope"));
    expect((failed.error as Error).message).toBe("Invalid (validation stop): calibration listener lookup failed: CIM query returned a malformed envelope");
    expect(failed.measured).toBe(false);

    const owned = await run(SERVER.pid);
    expect(owned.error).toBeUndefined();
    expect(owned.measured).toBe(true);
  });

  it("T-W23 a failed lookup can never be mistaken for an unbound port", async () => {
    // A real strict lookup, through a fake runner: PowerShell fails, or returns no envelope.
    const failing = [
      { code: 1, stdout: "", stderr: "Get-CimInstance : Invalid namespace" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: '{"ok":false,"port":4000,"entries":[]}', stderr: "" },
    ];
    for (const result of failing) {
      let sleeps = 0;
      const lookup = windowsListenerLookup(async () => result);
      const inspections = { ...fakeProcesses({ listeners: [SERVER.pid] }).ops, lookup };
      let sends = 0;
      const error = await cli
        .waitReadyWithinBudget({
          budget: cli.createAttemptBudget(80),
          target: "next",
          port: 4000,
          path: "/directory/cmp",
          ready: () => true,
          boundMs: 1e9,
          signal: new AbortController().signal,
          send: async () => ((sends += 1), okExchange(200)),
          sleep: async () => void (sleeps += 1),
          now: () => 0,
          listener: { server: SERVER, inspections },
        })
        .then(() => undefined, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(cli.ValidationStop);
      expect((error as Error).message).toMatch(/^Invalid \(validation stop\): next listener lookup failed: process inspection failed: /);
      // No waiting as if unbound, and nothing sent.
      expect(sleeps).toBe(0);
      expect(sends).toBe(0);
    }

    // A genuinely empty, successful lookup is unbound: it waits, and sends nothing.
    let polls = 0;
    const empty = windowsListenerLookup(async () => ((polls += 1), { code: 0, stdout: '{"ok":true,"port":4000,"entries":[]}', stderr: "" }));
    let clock = 0;
    const unbound = await cli
      .waitForOwnedListener({ target: "next", port: 4000, server: SERVER, inspections: { ...fakeProcesses({ listeners: [undefined] }).ops, lookup: empty }, deadline: 3, signal: new AbortController().signal, sleep: async () => {}, now: () => clock++ })
      .then(() => undefined, (caught: unknown) => caught);
    expect((unbound as Error).message).toBe("port 4000 had no listener within the readiness bound");
    expect(unbound).not.toBeInstanceOf(cli.ValidationStop);
    expect(polls).toBe(3);
  });

  it("T-W24 an ownership check that outlasts the deadline, or during which the pass is aborted, sends nothing and charges nothing", async () => {
    const attempt = async (during: { clock: { value: number }; abort: AbortController }, onCheck: () => void) => {
      const budget = cli.createAttemptBudget(80);
      const owned = fakeProcesses({ listeners: [SERVER.pid] });
      // The ownership check succeeds, but while it is pending the clock moves or the pass is aborted.
      const inspections: import("./cli").ListenerInspections = {
        ...owned.ops,
        processes: {
          ...owned.ops.processes,
          inspect: async (pid) => {
            const identity = await owned.ops.processes.inspect(pid);
            onCheck();
            return identity;
          },
        },
      };
      let sends = 0;
      const error = await cli
        .waitReadyWithinBudget({
          budget,
          target: "next",
          port: 4000,
          path: "/directory/cmp",
          ready: () => true,
          boundMs: 5_000,
          signal: during.abort.signal,
          send: async () => ((sends += 1), okExchange(200)),
          sleep: async () => {},
          now: () => during.clock.value,
          listener: { server: SERVER, inspections },
        })
        .then(() => undefined, (caught: unknown) => caught);
      return { error, sends, budget, owned };
    };

    const late = { clock: { value: 0 }, abort: new AbortController() };
    const pastDeadline = await attempt(late, () => (late.clock.value = 5_000));
    expect((pastDeadline.error as Error).message).toBe("port 4000 was not ready within 5000ms");
    expect(pastDeadline.owned.counts.inspect).toBe(1);
    expect(pastDeadline.sends).toBe(0);
    expect(pastDeadline.budget.summary().used).toBe(0);

    const aborted = { clock: { value: 0 }, abort: new AbortController() };
    const whilePending = await attempt(aborted, () => aborted.abort.abort(new Error("simulated SIGINT")));
    expect((whilePending.error as Error).message).toBe("aborted while waiting for readiness");
    expect(whilePending.owned.counts.inspect).toBe(1);
    expect(whilePending.sends).toBe(0);
    expect(whilePending.budget.summary().used).toBe(0);
  });

  it("T-W13 repeated readiness failures spend the shared 80-attempt budget, and no further request is sent", async () => {
    const budget = cli.createAttemptBudget(80);
    const sent: string[] = [];
    const exchange = (status: number, body = ""): Exchange => ({ status, rawHeaders: [], body: Buffer.from(body), ttfbNs: 1n, ttlbNs: 2n, reusedSocket: false, writeStartMs: 0, responseEndMs: 0 });
    const signal = new AbortController().signal;
    // Each server's listener is already bound by its recorded process, so only HTTP spends the budget.
    const common = { budget, signal, boundMs: 1e9, sleep: async () => {}, now: () => 0, listener: { server: SERVER, inspections: fakeProcesses({ listeners: [SERVER.pid] }).ops } };
    let nextAttempts = 0;
    let measured: number | undefined;

    const outcome = cli.readinessThenMeasure({
      budget,
      readiness: [
        // next dev answers on its 5th attempt; the first four fail in transport or with a 500.
        () =>
          cli.waitReadyWithinBudget({
            ...common,
            target: "next",
            port: 1,
            path: "/directory/cmp",
            ready: (response) => response.status === 200,
            send: async (_port, path) => {
              sent.push(path);
              nextAttempts += 1;
              if (nextAttempts <= 2) throw new Error("connect ECONNREFUSED");
              return exchange(nextAttempts < 5 ? 500 : 200);
            },
          }),
        // The calibration server never becomes ready.
        () =>
          cli.waitReadyWithinBudget({
            ...common,
            target: "calibration",
            port: 2,
            path: "/health",
            ready: (response) => response.status === 200,
            send: async (_port, path) => {
              sent.push(path);
              throw new Error("connect ECONNREFUSED");
            },
          }),
      ],
      afterReadiness: async () => {},
      handoff: [],
      measure: async (cap) => {
        measured = cap;
        return { completed: 0 };
      },
    });

    await expect(outcome).rejects.toThrow("Invalid (validation cap): the 80-attempt HTTP budget was exhausted during calibration readiness");
    await expect(outcome).rejects.toBeInstanceOf(cli.ValidationStop);
    expect(sent).toHaveLength(80);
    expect(sent.filter((path) => path === "/directory/cmp")).toHaveLength(5);
    expect(measured).toBeUndefined();
    expect(budget.remaining()).toBe(0);
    expect(budget.summary()).toMatchObject({ limit: 80, used: 80, byPhase: { "readiness:next": 5, "readiness:calibration": 75 } });
    expect(budget.summary().attempts.slice(0, 3).map((attempt) => attempt.outcome)).toEqual(["connect ECONNREFUSED", "connect ECONNREFUSED", "status 500"]);
  });

  it("T-W13 the plan receives only the budget readiness left", async () => {
    const budget = cli.createAttemptBudget(80);
    budget.trace("readiness", "next", "/directory/cmp", "connect ECONNREFUSED");
    budget.trace("readiness", "next", "/directory/cmp", "status 200");
    budget.trace("readiness", "calibration", "/health", "status 200");
    let cap: number | undefined;

    await cli.readinessThenMeasure({ budget, readiness: [], afterReadiness: async () => {}, handoff: [], measure: async (given) => ((cap = given), { completed: 0 }) });
    expect(cap).toBe(77);
    expect(cli.VALIDATION_REQUEST_CAP).toBe(80);
  });

  it("T-W14 an Invalid reason found only by the evaluator exits nonzero, and the report and console keep both the gate result and the Invalid line", async () => {
    const capture = vaCapture();
    const records = capture.records.map((record, index) => (index === 0 ? { ...record, contentEncoding: "gzip" } : record));
    const report = evaluateE2Validation(capture.manifest, records, sourceOf(capture.stored));
    const s = seams({ evaluate: () => report });

    expect(report.invalid).toEqual(["Invalid (encoding): a response carried a Content-Encoding"]);
    expect(report.gateResult).toBe("agreement");
    expect(renderE2Validation(report).split("\n")[0]).toBe("Gate result: agreement");
    expect(renderE2Validation(report)).toContain("Interpretation: Invalid: Invalid (encoding): a response carried a Content-Encoding");
    expect(await cli.runValidateE2(FLAGS, s.value)).toBe(1);
    expect(s.lines).toEqual(["Gate result: agreement", "Interpretation: Invalid: Invalid (encoding): a response carried a Content-Encoding"]);

    const withheld = seams({ evaluate: () => reportOf({ text: (sequence) => `Not available ${sequence}` }) });
    expect(await cli.runValidateE2(FLAGS, withheld.value)).toBe(0);
  });

  it("T-W9 the worktree lockfile stops V-A only", () => {
    const passing = E2_EVIDENCE.lockfile;
    const failing = { ...passing, worktreeCopySha256: "x".repeat(64) } as NonNullable<NextVersionEvidence["lockfile"]>;
    const absent = { ...passing, worktreeFilteredBlobId: undefined } as unknown as NonNullable<NextVersionEvidence["lockfile"]>;
    const va = cli.validationOptions(FLAGS, 0);

    expect(cli.lockfileStopFor(va, failing)).toBe("Invalid (validation stop): worktree lockfile lockfile-bytes");
    expect(cli.lockfileStopFor(va, absent)).toBe("Invalid (validation stop): worktree lockfile field-absent:lockfile.worktreeFilteredBlobId");
    expect(cli.lockfileStopFor(va, undefined)).toBe("Invalid (validation stop): worktree lockfile field-absent:lockfile");
    expect(cli.lockfileStopFor(va, passing)).toBeUndefined();
    expect(cli.lockfileStopFor({}, failing)).toBeUndefined();
    expect(new cli.ValidationStop("x")).toBeInstanceOf(Error);
  });
});
