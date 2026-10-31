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
  TEXT_PROBE_REASONS,
  evaluateTextProbe,
  isNotEvaluable
} from '../../../src/jitrl/text-probe-evaluation';
import { createEvoHarnessPlugin } from '../../../src/index';

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
