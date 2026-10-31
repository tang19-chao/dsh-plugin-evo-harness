/**
 * P3-3 (rev5 t12): cacheRead ablation is GATED / NOT-APPLICABLE.
 *
 * THE RULE
 * --------
 * A cacheRead (prefix-cache) ablation may be reported only when a MEASURED
 * cacheRead stream shows a significant reduction. This repository has no such
 * stream: the harness has no tokenizer, every token figure is `chars/4` and
 * labelled `estimated`, `cacheReadTokens` is 0 in every arm, and the measured
 * cost capability is 0/180 in every arm. Therefore P3-3 is NOT an A/B to be
 * run and NOT a number to be invented: it is GATED, and the gate is written
 * here so a future measured stream can open it.
 *
 * WHY A TEST (AND NOT A PARAGRAPH)
 * --------------------------------
 * "We decided not to measure it" is indistinguishable from "we forgot to".
 * The predicate below is THREE-WAY and is exercised in all three directions:
 *   (a) the frozen artifact                      -> gated-not-applicable
 *   (b) a synthetic MEASURED significant drop    -> applicable (the gate opens)
 *   (c) a synthetic measured NON-significant drop -> measured-no-significant-reduction
 * If a future change silently pretends (b) from data like (a), case (a) fails;
 * if it pretends "no effect" from (c), case (c) fails. The gate is therefore
 * load-bearing rather than a restatement of the freeze.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PATH = path.join(repoRoot, 'tests/fixtures/pr4a/pr4a-five-arm-eval.json');

interface TokenField {
  readonly tokens: number;
  readonly precision: string;
}

interface ArmTokens {
  readonly armId: string;
  readonly cacheReadTokens: TokenField;
  readonly cacheWriteTokens: TokenField;
  readonly totalTokens: TokenField;
  readonly modelCalls: number;
  readonly decisionPoints: number;
}

interface Artifact {
  readonly tokenFields: {
    readonly fields: readonly string[];
    readonly estimator: string;
    readonly perArm: readonly ArmTokens[];
  };
  readonly cost: {
    readonly arms: readonly {
      readonly armId: string;
      readonly measured: { readonly count: number; readonly share: number };
      readonly estimated: { readonly count: number; readonly share: number };
      readonly liveCalls: number;
      readonly incurredRealUsd: number;
    }[];
  };
  readonly comparisons: unknown;
}

const artifact = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Artifact;

// ---------------------------------------------------------------------------
// the three-way gate
// ---------------------------------------------------------------------------

interface CacheReadMeasurement {
  /** How the token counts were obtained. */
  readonly precision: 'measured' | 'estimated';
  /** Baseline (cache off) cacheRead tokens per task, per task values. */
  readonly baselineCacheRead: readonly number[];
  /** Treatment (cache on) cacheRead tokens per task, per task values. */
  readonly treatmentCacheRead: readonly number[];
}

type GateResult =
  | { readonly status: 'gated-not-applicable'; readonly reason: string }
  | { readonly status: 'measured-no-significant-reduction'; readonly reason: string; readonly meanReduction: number }
  | {
      readonly status: 'applicable';
      readonly reason: string;
      readonly meanReduction: number;
      readonly discordantPairs: number;
    };

/**
 * The gate itself. A cacheRead ablation is applicable ONLY if all of:
 *   1. precision === 'measured' (an estimate cannot open it);
 *   2. there are paired observations and at least one task where the treatment
 *      reads LESS cache than the baseline (a real reduction, not a tie);
 *   3. the exact sign test over the reduced/increased pairs is significant at
 *      alpha = 0.05 (two-sided, over discordant pairs).
 * Otherwise it reports why it is closed — never a fabricated effect.
 */
function cacheReadAblationGate(measurement: CacheReadMeasurement | undefined): GateResult {
  if (measurement === undefined) {
    return { status: 'gated-not-applicable', reason: 'no cacheRead observation exists in the frozen data' };
  }
  if (measurement.precision !== 'measured') {
    return {
      status: 'gated-not-applicable',
      reason: 'cacheRead tokens are ' + measurement.precision + ' (estimated), so no reduction can be claimed'
    };
  }
  const pairs = measurement.baselineCacheRead.length;
  if (pairs === 0 || measurement.treatmentCacheRead.length !== pairs) {
    return { status: 'gated-not-applicable', reason: 'no paired cacheRead observations' };
  }
  let lower = 0;
  let higher = 0;
  let reduction = 0;
  for (let i = 0; i < pairs; i += 1) {
    const baseline = measurement.baselineCacheRead[i];
    const treatment = measurement.treatmentCacheRead[i];
    if (baseline === undefined || treatment === undefined) {
      throw new Error('unreachable');
    }
    reduction += baseline - treatment;
    if (treatment < baseline) {
      lower += 1;
    } else if (treatment > baseline) {
      higher += 1;
    }
  }
  const meanReduction = reduction / pairs;
  const discordant = lower + higher;
  if (lower === 0) {
    return {
      status: 'measured-no-significant-reduction',
      reason: 'measured, but not one task shows a cacheRead reduction',
      meanReduction
    };
  }
  // exact two-sided sign test over the discordant pairs
  const k = Math.min(lower, higher);
  let tail = 0;
  let c = 1;
  for (let i = 0; i <= k; i += 1) {
    tail += c;
    c = (c * (discordant - i)) / (i + 1);
  }
  const p = Math.min(1, (2 * tail) / Math.pow(2, discordant));
  if (p > 0.05) {
    return {
      status: 'measured-no-significant-reduction',
      reason: 'measured, but the sign test is not significant (p=' + p.toFixed(6) + ')',
      meanReduction
    };
  }
  return {
    status: 'applicable',
    reason: 'measured cacheRead reduction, sign test p=' + p.toFixed(6),
    meanReduction,
    discordantPairs: discordant
  };
}

// ---------------------------------------------------------------------------
// (a) the frozen data closes the gate
// ---------------------------------------------------------------------------

describe('P3-3: the frozen artifact contains NO measured cacheRead stream', () => {
  it('every arm ships cacheReadTokens = 0 with precision "estimated"', () => {
    expect(artifact.tokenFields.perArm).toHaveLength(5);
    for (const arm of artifact.tokenFields.perArm) {
      expect(arm.cacheReadTokens.tokens).toBe(0);
      expect(arm.cacheReadTokens.precision).toBe('estimated');
      expect(arm.cacheWriteTokens.precision).toBe('estimated');
      expect(arm.totalTokens.precision).toBe('estimated');
    }
    expect(artifact.tokenFields.estimator).toContain('ESTIMATED, never measured');
  });

  it('the measured cost capability is 0/180 in every arm (nothing measured to ablate)', () => {
    expect(artifact.cost.arms).toHaveLength(5);
    for (const arm of artifact.cost.arms) {
      expect(arm.measured.count).toBe(0);
      expect(arm.measured.share).toBe(0);
      expect(arm.estimated.count).toBe(180);
      expect(arm.estimated.share).toBe(1);
      expect(arm.liveCalls).toBe(0);
      expect(arm.incurredRealUsd).toBe(0);
    }
  });

  it('the gate returns gated-not-applicable for the frozen data (no A/B is fabricated)', () => {
    const gate = cacheReadAblationGate(undefined);
    expect(gate.status).toBe('gated-not-applicable');
    // and there is no cacheRead comparison to mis-read as an A/B
    const comparisons = JSON.stringify(artifact.comparisons);
    expect(comparisons).not.toContain('cacheRead');
    expect(comparisons.toLowerCase()).not.toContain('cacheab');
  });
});

// ---------------------------------------------------------------------------
// (b)/(c) the gate opens ONLY on measured, significant data
// ---------------------------------------------------------------------------

describe('P3-3: the gate is discriminating (it can open, and it can refuse)', () => {
  it('opens on a synthetic MEASURED significant reduction', () => {
    const gate = cacheReadAblationGate({
      precision: 'measured',
      baselineCacheRead: [900, 850, 1000, 950, 880, 920],
      treatmentCacheRead: [100, 90, 120, 95, 110, 80]
    });
    expect(gate.status).toBe('applicable');
    if (gate.status === 'applicable') {
      expect(gate.meanReduction).toBeGreaterThan(700);
      expect(gate.discordantPairs).toBe(6);
    }
  });

  it('refuses a MEASURED but non-significant reduction', () => {
    const gate = cacheReadAblationGate({
      precision: 'measured',
      baselineCacheRead: [100, 100, 100, 100, 100, 100],
      treatmentCacheRead: [90, 110, 100, 100, 100, 100]
    });
    expect(gate.status).toBe('measured-no-significant-reduction');
  });

  it('refuses ESTIMATED data even when it looks like a large drop', () => {
    const gate = cacheReadAblationGate({
      precision: 'estimated',
      baselineCacheRead: [900, 850, 1000],
      treatmentCacheRead: [100, 90, 120]
    });
    expect(gate.status).toBe('gated-not-applicable');
    expect(gate.status === 'gated-not-applicable' ? gate.reason : '').toContain('estimated');
  });
});

// ---------------------------------------------------------------------------
// the documentation's own hedge is the citable premise
// ---------------------------------------------------------------------------

describe('P3-3: the documented premise is hedged, not an effect claim', () => {
  it('the frozen report labels cacheReadTokens estimated and "never measured"', () => {
    const report = readFileSync(path.join(repoRoot, 'docs/reports/pr4a-five-arm-eval-report.md'), 'utf8');
    const lines = report.split(/\r?\n/);
    // the token-precision row cited by the recheck report
    expect(lines[400]).toContain('cacheReadTokens');
    expect(lines[400]).toContain('estimated');
    expect(lines[400]).toContain('never measured');
    // §9.3 preamble: no field may be read as measured
    expect(report).toContain('No total may be read as "measured"');
  });

  it('the Pareto/budget report marks the cacheRead evaluation as NOT evaluated', () => {
    const report = readFileSync(path.join(repoRoot, 'docs/reports/p6-pareto-budget.md'), 'utf8');
    const lines = report.split(/\r?\n/);
    expect(lines[179]).toContain('cacheRead');
    expect(lines[179]).toContain('不评估');
    expect(lines[326]).toContain('`cacheRead`');
    expect(lines[326]).toContain('未评估');
  });
});
