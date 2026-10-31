/**
 * rev6 R2-3: cacheRead observation must preserve provenance and gate the
 * optimisation honestly.
 *
 * THE TWO THINGS THIS FILE IS BUILT TO CATCH
 * ------------------------------------------
 * 1. A silent upgrade: estimated/unknown data being reported as measured. The
 *    `downgradeSample` API makes upgrades unrepresentable, and the tests below
 *    feed every precision through the gate to prove an estimated or unknown set
 *    can never come out `applicable`.
 * 2. A fabricated effect: a gate that opens on a tie, on partial pairs, or on a
 *    non-significant difference. Each of those is a separate case.
 *
 * The frozen PR-4A artifact is used as the real-world negative control: it is
 * the data this repository actually has (180 estimated calls per arm, cacheRead 0
 * estimated, 0 measured cost calls), so if the gate ever claims "applicable" from
 * data shaped like it, this file fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RAW_USAGE_FIELDS,
  cacheOptimizationGate,
  describeCacheObservations,
  downgradeSample,
  observeCacheUsage,
  observeEstimatedCacheUsage,
  pairByTask,
  summarizeCacheObservations,
  weakerPrecision,
  type CacheReadSample
} from '../../../src/dsh-bridge/cache-observation';
import type { CountingSemantics } from '../../../src/ledger/types';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PATH = path.join(repoRoot, 'tests/fixtures/pr4a/pr4a-five-arm-eval.json');

/** The DSH/DeepSeek counting semantics the host can declare. */
const DSH_SEMANTICS: CountingSemantics = {
  inputIncludesCacheRead: true,
  outputIncludesReasoning: true,
  semanticTag: 'dsh-deepseek-v1'
};

function measured(input: {
  callId: string;
  taskId: string;
  arm: 'baseline' | 'treatment';
  cacheRead: number;
}): CacheReadSample {
  return observeCacheUsage({
    callId: input.callId,
    taskId: input.taskId,
    arm: input.arm,
    purpose: 'probe',
    rawUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: input.cacheRead },
    semantics: DSH_SEMANTICS
  });
}

describe('precision comes from what the provider reported, never from a default', () => {
  it('marks every dimension unknown when the host reported no usage at all', () => {
    const sample = observeCacheUsage({
      callId: 'c1',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      rawUsage: undefined,
      semantics: DSH_SEMANTICS
    });
    expect(sample.cacheReadPrecision).toBe('unknown');
    expect(sample.cacheReadUnavailable).toBe(true);
    expect(sample.unreportedFields).toEqual([...RAW_USAGE_FIELDS]);
    expect(sample.dimensionPrecision).toEqual({
      input: 'unknown',
      output: 'unknown',
      cacheRead: 'unknown',
      cacheWrite: 'unknown',
      reasoning: 'unknown'
    });
  });

  it('treats an OMITTED cacheReadTokens as unknown/unavailable, never as a measured zero', () => {
    const sample = observeCacheUsage({
      callId: 'c2',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      rawUsage: { inputTokens: 900, outputTokens: 100 },
      semantics: DSH_SEMANTICS
    });
    expect(sample.cacheReadTokens).toBe(0);
    // The number is 0, but its PRECISION is unknown: "we never saw it" is not
    // "it was zero".
    expect(sample.cacheReadPrecision).toBe('unknown');
    expect(sample.cacheReadUnavailable).toBe(true);
    expect(sample.unreportedFields).toContain('cacheReadTokens');
    expect(sample.reportedFields).toEqual(['inputTokens', 'outputTokens']);
  });

  it('keeps a REPORTED zero as measured when semantics were declared', () => {
    const sample = observeCacheUsage({
      callId: 'c3',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      rawUsage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0 },
      semantics: DSH_SEMANTICS
    });
    expect(sample.cacheReadPrecision).toBe('measured');
    expect(sample.cacheReadUnavailable).toBe(false);
    expect(sample.cacheReadTokens).toBe(0);
  });

  it('refuses to call a reported number measured when no counting semantics were declared', () => {
    // P3-C: a number whose meaning is unknown is not a measurement. The host can
    // report cacheReadTokens and still leave `inputIncludesCacheRead` undeclared,
    // in which case we cannot tell whether it double-counts.
    const sample = observeCacheUsage({
      callId: 'c4',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      rawUsage: { inputTokens: 900, cacheReadTokens: 400 },
      semantics: undefined
    });
    expect(sample.cacheReadTokens).toBe(400);
    expect(sample.cacheReadPrecision).toBe('unknown');
    expect(sample.provenanceSource).toContain('declared no counting semantics');
  });

  it('records the raw field provenance chain for audit', () => {
    const sample = observeCacheUsage({
      callId: 'c5',
      taskId: 't1',
      arm: 'treatment',
      purpose: 'compose',
      rawUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 7 },
      semantics: DSH_SEMANTICS
    });
    expect(sample.reportedFields).toEqual([
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens'
    ]);
    expect(sample.unreportedFields).toEqual(['totalTokens']);
    expect(sample.dimensionPrecision.cacheRead).toBe('measured');
    expect(sample.provenanceSource).toContain('declared counting semantics');
  });

  it('marks heuristic figures estimated, never measured', () => {
    const sample = observeEstimatedCacheUsage({
      callId: 'e1',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      cacheReadTokens: 1234,
      inputTokens: 5000,
      outputTokens: 600,
      estimator: 'chars/4'
    });
    expect(sample.cacheReadPrecision).toBe('estimated');
    expect(sample.provenanceSource).toContain('never a measurement');
    expect(sample.cacheReadTokens).toBe(1234);
  });
});

describe('downgrade is the only direction: upgrade is not representable', () => {
  it('weakerPrecision always returns the lower rank', () => {
    expect(weakerPrecision('measured', 'estimated')).toBe('estimated');
    expect(weakerPrecision('estimated', 'unknown')).toBe('unknown');
    expect(weakerPrecision('measured', 'measured')).toBe('measured');
    expect(weakerPrecision('unknown', 'measured')).toBe('unknown');
  });

  it('downgradeSample CANNOT upgrade an estimated sample to measured', () => {
    const estimated = observeEstimatedCacheUsage({
      callId: 'e2',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      cacheReadTokens: 100,
      inputTokens: 1,
      outputTokens: 1,
      estimator: 'chars/4'
    });
    const attempted = downgradeSample(estimated, 'measured');
    // The call is accepted but is a NO-OP: 'measured' is not stronger than what
    // the sample already is, so nothing changes.
    expect(attempted.cacheReadPrecision).toBe('estimated');
    expect(attempted).toEqual(estimated);
  });

  it('downgradeSample CANNOT upgrade an unknown sample to measured either', () => {
    const unknown = observeCacheUsage({
      callId: 'u1',
      taskId: 't1',
      arm: 'baseline',
      purpose: 'probe',
      rawUsage: { inputTokens: 5 },
      semantics: DSH_SEMANTICS
    });
    expect(unknown.cacheReadPrecision).toBe('unknown');
    expect(downgradeSample(unknown, 'measured').cacheReadPrecision).toBe('unknown');
  });

  it('downgradeSample does downgrade a measured sample, and says so in provenance', () => {
    const sample = measured({ callId: 'm1', taskId: 't1', arm: 'baseline', cacheRead: 50 });
    expect(sample.cacheReadPrecision).toBe('measured');
    const downgraded = downgradeSample(sample, 'estimated');
    expect(downgraded.cacheReadPrecision).toBe('estimated');
    expect(downgraded.dimensionPrecision.cacheRead).toBe('estimated');
    expect(downgraded.provenanceSource).toContain('downgraded to estimated');
    // The token VALUE is untouched: precision is about trust, not magnitude.
    expect(downgraded.cacheReadTokens).toBe(sample.cacheReadTokens);
  });
});

describe('accounting keeps measured / estimated / unknown in separate buckets', () => {
  it('summarises each precision without collapsing them', () => {
    const samples = [
      measured({ callId: 'a', taskId: 't1', arm: 'baseline', cacheRead: 100 }),
      observeEstimatedCacheUsage({
        callId: 'b',
        taskId: 't1',
        arm: 'baseline',
        purpose: 'probe',
        cacheReadTokens: 70,
        inputTokens: 1,
        outputTokens: 1,
        estimator: 'chars/4'
      }),
      observeCacheUsage({
        callId: 'c',
        taskId: 't1',
        arm: 'baseline',
        purpose: 'probe',
        rawUsage: { inputTokens: 1 },
        semantics: DSH_SEMANTICS
      })
    ];
    const accounting = summarizeCacheObservations(samples);
    expect(accounting.totalSamples).toBe(3);
    expect(accounting.measuredCalls).toBe(1);
    expect(accounting.estimatedCalls).toBe(1);
    expect(accounting.unknownCalls).toBe(1);
    expect(accounting.measuredCacheReadTokens).toBe(100);
    expect(accounting.estimatedCacheReadTokens).toBe(70);
    expect(accounting.cacheReadUnknownCalls).toBe(1);
  });
});

describe('pairs take the weaker precision and report lost pairs', () => {
  it('pairs by task and marks a mixed-precision pair estimated', () => {
    const samples = [
      measured({ callId: 'b1', taskId: 't1', arm: 'baseline', cacheRead: 1000 }),
      observeEstimatedCacheUsage({
        callId: 't1c',
        taskId: 't1',
        arm: 'treatment',
        purpose: 'probe',
        cacheReadTokens: 400,
        inputTokens: 1,
        outputTokens: 1,
        estimator: 'chars/4'
      })
    ];
    const pairs = pairByTask(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.precision).toBe('estimated');
    expect(pairs[0]?.baselineCacheRead).toBe(1000);
    expect(pairs[0]?.treatmentCacheRead).toBe(400);
  });

  it('does not invent a pair when only one arm reported', () => {
    const pairs = pairByTask([measured({ callId: 'b2', taskId: 't9', arm: 'baseline', cacheRead: 10 })]);
    expect(pairs).toEqual([]);
  });

  it('marks a pair incomplete when cacheRead was unavailable on one side', () => {
    const samples = [
      measured({ callId: 'b3', taskId: 't2', arm: 'baseline', cacheRead: 500 }),
      observeCacheUsage({
        callId: 't3',
        taskId: 't2',
        arm: 'treatment',
        purpose: 'probe',
        rawUsage: { inputTokens: 800, outputTokens: 50 },
        semantics: DSH_SEMANTICS
      })
    ];
    const pairs = pairByTask(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.complete).toBe(false);
    expect(pairs[0]?.precision).toBe('unknown');
  });
});

describe('the optimisation gate: only measured + paired + significant opens it', () => {
  it('reports gated-not-applicable when there are no pairs', () => {
    const gate = cacheOptimizationGate([]);
    expect(gate.status).toBe('gated-not-applicable');
    expect(gate.reason).toContain('no paired');
  });

  it('NEGATIVE CONTROL: estimated data can never open the gate, even with a huge drop', () => {
    const pairs = Array.from({ length: 8 }, (_unused, index) => ({
      taskId: 'task-' + String(index),
      baselineCacheRead: 10000,
      treatmentCacheRead: 0,
      precision: 'estimated' as const,
      baselineCallIds: ['b' + String(index)],
      treatmentCallIds: ['t' + String(index)],
      complete: true
    }));
    const gate = cacheOptimizationGate(pairs);
    expect(gate.status).toBe('gated-not-applicable');
    expect(gate.reason).toContain('estimated');
    expect(gate.reason).toContain('never relabelled');
  });

  it('NEGATIVE CONTROL: unknown data can never open the gate', () => {
    const pairs = [
      {
        taskId: 't1',
        baselineCacheRead: 100,
        treatmentCacheRead: 0,
        precision: 'unknown' as const,
        baselineCallIds: ['b'],
        treatmentCallIds: ['t'],
        complete: true
      }
    ];
    expect(cacheOptimizationGate(pairs).status).toBe('gated-not-applicable');
  });

  it('reports measured-no-significant-reduction when no task shows a reduction', () => {
    const pairs = [
      {
        taskId: 't1',
        baselineCacheRead: 100,
        treatmentCacheRead: 100,
        precision: 'measured' as const,
        baselineCallIds: ['b'],
        treatmentCallIds: ['t'],
        complete: true
      },
      {
        taskId: 't2',
        baselineCacheRead: 50,
        treatmentCacheRead: 60,
        precision: 'measured' as const,
        baselineCallIds: ['b2'],
        treatmentCallIds: ['t2'],
        complete: true
      }
    ];
    const gate = cacheOptimizationGate(pairs);
    expect(gate.status).toBe('measured-no-significant-reduction');
    if (gate.status === 'measured-no-significant-reduction') {
      expect(gate.reason).toContain('not one task');
    }
  });

  it('reports measured-no-significant-reduction when the sign test fails', () => {
    // 2 reductions vs 4 increases: clearly not significant.
    const pairs = [
      ...[0, 1].map((index) => ({
        taskId: 'r' + String(index),
        baselineCacheRead: 100,
        treatmentCacheRead: 10,
        precision: 'measured' as const,
        baselineCallIds: ['b' + String(index)],
        treatmentCallIds: ['t' + String(index)],
        complete: true
      })),
      ...[0, 1, 2, 3].map((index) => ({
        taskId: 'i' + String(index),
        baselineCacheRead: 10,
        treatmentCacheRead: 100,
        precision: 'measured' as const,
        baselineCallIds: ['bi' + String(index)],
        treatmentCallIds: ['ti' + String(index)],
        complete: true
      }))
    ];
    const gate = cacheOptimizationGate(pairs);
    expect(gate.status).toBe('measured-no-significant-reduction');
    if (gate.status === 'measured-no-significant-reduction') {
      expect(gate.reason).toContain('sign test is not significant');
    }
  });

  it('OPENS ONLY when measured reduction is significant, and recommends an A/B (not the optimisation)', () => {
    // 8/8 tasks reduced: p = 2/256 = 0.0078 <= 0.05.
    const pairs = Array.from({ length: 8 }, (_unused, index) => ({
      taskId: 'task-' + String(index),
      baselineCacheRead: 1000,
      treatmentCacheRead: 200,
      precision: 'measured' as const,
      baselineCallIds: ['b' + String(index)],
      treatmentCallIds: ['t' + String(index)],
      complete: true
    }));
    const gate = cacheOptimizationGate(pairs);
    expect(gate.status).toBe('applicable');
    if (gate.status === 'applicable') {
      expect(gate.meanReduction).toBe(800);
      expect(gate.discordantPairs).toBe(8);
      expect(gate.signTestP).toBeLessThan(0.05);
      // The recommendation must be an A/B, never "enable it now".
      expect(gate.recommendation).toContain('A/B is now justified');
      expect(gate.recommendation).toContain('separate authorised act');
      expect(gate.recommendation).toContain('NOT performed by this module');
    }
  });

  it('ignores incomplete pairs entirely rather than analysing a favourable subset', () => {
    const pairs = [
      {
        taskId: 'good',
        baselineCacheRead: 1000,
        treatmentCacheRead: 0,
        precision: 'measured' as const,
        baselineCallIds: ['b'],
        treatmentCallIds: ['t'],
        complete: true
      },
      {
        taskId: 'lost',
        baselineCacheRead: 0,
        treatmentCacheRead: 0,
        precision: 'unknown' as const,
        baselineCallIds: ['b2'],
        treatmentCallIds: ['t2'],
        complete: false
      }
    ];
    const gate = cacheOptimizationGate(pairs);
    // One complete pair with a reduction is significant at p=1.0? No: 1 discordant
    // pair gives p = 2 * (1/2) = 1.0 > 0.05, so it stays closed - and crucially it
    // never mixes the incomplete pair's zeros into the mean.
    expect(gate.status).toBe('measured-no-significant-reduction');
    if (gate.status === 'measured-no-significant-reduction') {
      expect(gate.meanReduction).toBe(1000);
    }
  });
});

describe('the frozen PR-4A artifact is the real-world negative control', () => {
  it('is entirely estimated with zero measured cacheRead, so the gate stays closed', () => {
    const artifact = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      tokenFields: { estimator: string; perArm: { armId: string; cacheReadTokens: { tokens: number; precision: string }; modelCalls: number }[] };
      cost: { arms: { armId: string; measured: { count: number }; estimated: { count: number }; liveCalls: number }[] };
    };

    // The estimator is declared as a heuristic, so no arm can be measured.
    expect(artifact.tokenFields.estimator).toContain('ESTIMATED');
    for (const arm of artifact.tokenFields.perArm) {
      expect(arm.cacheReadTokens.precision).toBe('estimated');
      expect(arm.cacheReadTokens.tokens).toBe(0);
    }
    // ...and no live (paid) call was ever made, so no measured cost exists.
    for (const arm of artifact.cost.arms) {
      expect(arm.measured.count).toBe(0);
      expect(arm.liveCalls).toBe(0);
      expect(arm.estimated.count).toBeGreaterThan(0);
    }

    // Reconstruct the observation the artifact describes and confirm the gate
    // refuses to open on it. Each arm's calls are tagged with that arm, and the
    // task id cycles so both arms meet on the same tasks - otherwise no pair
    // would exist at all and the gate would close for the wrong reason.
    const samples: CacheReadSample[] = [];
    for (const arm of artifact.tokenFields.perArm) {
      // Alternating arms across the artifact's own arm list: even index =
      // baseline, odd index = treatment, mirroring a cache-off/cache-on pair.
      const armLabel: 'baseline' | 'treatment' = artifact.tokenFields.perArm.indexOf(arm) % 2 === 0 ? 'baseline' : 'treatment';
      for (let call = 0; call < arm.modelCalls; call += 1) {
        samples.push(
          observeEstimatedCacheUsage({
            callId: arm.armId + '#' + String(call),
            taskId: 'task-' + String(call % 12),
            arm: armLabel,
            purpose: 'probe',
            cacheReadTokens: arm.cacheReadTokens.tokens,
            inputTokens: 1000,
            outputTokens: 100,
            estimator: artifact.tokenFields.estimator
          })
        );
      }
    }
    const pairs = pairByTask(samples);
    // Pairs must exist, so the gate closes on PRECISION, not on missing data.
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((pair) => pair.precision === 'estimated')).toBe(true);
    const gate = cacheOptimizationGate(pairs);
    expect(gate.status).toBe('gated-not-applicable');
    // Every pair is estimated, so the reason must name that.
    expect(gate.reason).toContain('estimated');
  });
});

describe('describeCacheObservations is lossless and draws no conclusion', () => {
  it('emits accounting, pairs and the gate without an enable flag', () => {
    const samples = [measured({ callId: 'b', taskId: 't1', arm: 'baseline', cacheRead: 10 })];
    const pairs = pairByTask(samples);
    const gate = cacheOptimizationGate(pairs);
    const described = describeCacheObservations({ samples, pairs, gate });
    expect(Object.keys(described).sort()).toEqual(['accounting', 'gate', 'pairs']);
    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain('"enabled"');
    expect(serialised).not.toContain('"enable"');
  });
});
