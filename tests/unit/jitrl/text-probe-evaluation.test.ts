/**
 * rev5 P2-2: a text-only probe is `not-evaluable`, and the type makes a "pass"
 * impossible to construct.
 *
 * These tests are about the honesty rule, not about formatting:
 *   - total: every input, including `undefined`/garbage, yields a result;
 *   - monotone: no input yields a score or pass flag, and reward stays the literal 0 (never positive);
 *   - informative: the result says WHAT it saw, so the verdict is checkable;
 *   - reachable: the plugin handle exposes the same verdict.
 */
import { describe, expect, it } from 'vitest';
import {
  TEXT_PROBE_REASON_CODES,
  TEXT_PROBE_REASONS,
  classifyProbeEvaluability,
  evaluateTextProbe,
  isNotEvaluable,
  textProbeReasonCode
} from '../../../src/jitrl/text-probe-evaluation';
import { createEvoHarnessPlugin } from '../../../src/index';
import type { ProbeTrajectory } from '../../../src/types/contracts';

describe('evaluateTextProbe', () => {
  it('returns not-evaluable for a prose-only probe and names why', () => {
    const verdict = evaluateTextProbe({
      prompt: 'explain why the build cache is cold',
      textDeliverables: ['a short explanation']
    });
    expect(verdict.status).toBe('not-evaluable');
    expect(verdict.evaluable).toBe(false);
    expect(verdict.reason).toBe('text-only-deliverables');
    expect(verdict.reward).toBe(0);
    expect(verdict.detail).toContain('text');
    expect(verdict.observed).toEqual({ executableDeliverables: 0, textDeliverables: 1, hasPrompt: true });
  });

  it('returns not-evaluable when no deliverable is declared at all', () => {
    const verdict = evaluateTextProbe({ prompt: 'do something useful' });
    expect(verdict.reason).toBe('no-executable-deliverable');
    expect(verdict.observed.executableDeliverables).toBe(0);
  });

  it('is total: undefined, null and non-objects still produce a verdict', () => {
    for (const input of [undefined, null, 42, 'a string', [] as unknown]) {
      const verdict = evaluateTextProbe(input as never);
      expect(verdict.status).toBe('not-evaluable');
      expect(verdict.evaluable).toBe(false);
      expect(verdict.reward).toBe(0);
      expect(TEXT_PROBE_REASONS).toContain(verdict.reason);
    }
    // `[]` is an object, so it is treated as an empty probe.
    expect(evaluateTextProbe([] as never).reason).toBe('invalid-probe');
  });

  it('never reports a positive reward even when executable deliverables exist', () => {
    const verdict = evaluateTextProbe({
      prompt: 'run the build',
      executableDeliverables: ['pnpm build'],
      textDeliverables: ['a summary']
    });
    // This module is the TEXT-probe evaluator: it still refuses to score.
    expect(verdict.status).toBe('not-evaluable');
    expect(verdict.reward).toBe(0);
    expect(verdict.observed.executableDeliverables).toBe(1);
  });

  it('ignores blank deliverables instead of counting them', () => {
    const verdict = evaluateTextProbe({ prompt: 'x', textDeliverables: ['   ', ''] });
    expect(verdict.observed.textDeliverables).toBe(0);
    expect(verdict.reason).toBe('no-executable-deliverable');
  });

  it('every result satisfies the structural guard', () => {
    for (const input of [undefined, { prompt: 'p' }, { prompt: 'p', textDeliverables: ['t'] }]) {
      expect(isNotEvaluable(evaluateTextProbe(input))).toBe(true);
    }
    expect(isNotEvaluable({ status: 'passed' })).toBe(false);
    expect(isNotEvaluable(null)).toBe(false);
  });
});

describe('plugin handle: evaluateTextProbe', () => {
  it('exposes the same not-evaluable verdict and no pass path', () => {
    const plugin = createEvoHarnessPlugin({ config: { logging: { level: 'silent' } } });
    const verdict = plugin.evaluateTextProbe({ prompt: 'summarise the diff', textDeliverables: ['a summary'] });
    expect(verdict.status).toBe('not-evaluable');
    expect(verdict.reason).toBe('text-only-deliverables');
    expect('passed' in verdict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rev6 audit A4-3: the MAIN-CHAIN classifier
// ---------------------------------------------------------------------------

function trajectoryOf(
  deliverable: { content: string; producedFiles?: readonly string[] } | undefined
): ProbeTrajectory {
  return {
    id: 'traj-a4-3',
    sessionId: 's',
    branchId: 'b',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'p',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 1,
    metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 1 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    ...(deliverable === undefined ? {} : { deliverable })
  };
}

describe('classifyProbeEvaluability (main chain, A4-3)', () => {
  it('trusted passed/failed verdicts are evaluable regardless of deliverable shape', () => {
    for (const status of ['passed', 'failed'] as const) {
      const verdict = classifyProbeEvaluability({
        trajectory: trajectoryOf({ content: 'prose only' }),
        verification: { status, trustedSource: true, implicit: false }
      });
      expect(verdict.status).toBe('evaluated');
      expect(verdict.evaluable).toBe(true);
      expect(verdict.trusted).toBe(true);
      expect(verdict.reason).toBeUndefined();
    }
  });

  it('the structural implicit failure is evaluable (a deterministic refutation needs no runner)', () => {
    const verdict = classifyProbeEvaluability({
      trajectory: trajectoryOf(undefined),
      verification: { status: 'failed', trustedSource: false, implicit: true }
    });
    expect(verdict.evaluable).toBe(true);
    expect(String(verdict.detail)).toContain('structural');
  });

  it('a produced artifact without a trusted verdict is NOT evaluable', () => {
    const verdict = classifyProbeEvaluability({
      trajectory: trajectoryOf({ content: 'code', producedFiles: ['src/fix.ts'] }),
      verification: { status: 'unknown', trustedSource: false, implicit: true }
    });
    expect(verdict.evaluable).toBe(false);
    expect(verdict.reason).toBe('no-trusted-verifier');
    expect(verdict.observed.executableDeliverables).toBe(1);
    // A shape-only receipt is not trust: it must not make the probe evaluable.
    const shapeOnly = classifyProbeEvaluability({
      trajectory: trajectoryOf({ content: 'code', producedFiles: ['src/fix.ts'] }),
      verification: { status: 'passed', trustedSource: false, implicit: false }
    });
    expect(shapeOnly.evaluable).toBe(false);
    expect(shapeOnly.reason).toBe('no-trusted-verifier');
  });

  it('text-only and empty probes are not evaluable, with distinct reasons', () => {
    const text = classifyProbeEvaluability({
      trajectory: trajectoryOf({ content: 'an explanation' }),
      verification: { status: 'unknown', trustedSource: false, implicit: true }
    });
    expect(text.reason).toBe('text-only-deliverables');
    const empty = classifyProbeEvaluability({
      trajectory: trajectoryOf(undefined),
      verification: { status: 'unknown', trustedSource: false, implicit: true }
    });
    expect(empty.reason).toBe('no-executable-deliverable');
    expect(empty.observed.hasDeliverable).toBe(false);
  });

  it('never reports a failure or a score: only the two-state classification', () => {
    const verdict = classifyProbeEvaluability({
      trajectory: trajectoryOf({ content: 'x' }),
      verification: { status: 'unknown', trustedSource: false, implicit: true }
    });
    expect(['evaluated', 'not-evaluable']).toContain(verdict.status);
    expect('reward' in verdict).toBe(false);
  });

  it('pins the append-only numeric reason codes used by persisted records', () => {
    expect(TEXT_PROBE_REASON_CODES['text-only-deliverables']).toBe(1);
    expect(TEXT_PROBE_REASON_CODES['no-executable-deliverable']).toBe(2);
    expect(TEXT_PROBE_REASON_CODES['no-trusted-verifier']).toBe(3);
    expect(textProbeReasonCode('no-trusted-verifier')).toBe(3);
    expect(textProbeReasonCode(undefined)).toBe(0);
  });
});
