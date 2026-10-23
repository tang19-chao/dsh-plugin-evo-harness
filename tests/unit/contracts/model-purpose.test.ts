/**
 * P0-5: the 'probe' ModelPurpose keeps model calls made inside an isolated
 * probe branch distinguishable from 'compose' judging, in both routing (the
 * scripted adapter answers differently) and request statistics (the recorded
 * request log separates the purposes), without changing any existing
 * non-probe purpose behavior.
 */
import { describe, expect, it } from 'vitest';
import type { ModelPurpose } from '../../../src/types/contracts';
import { createScriptedModel } from '../../e2e/fixtures';

/** Compile-time proof that 'probe' is part of the ModelPurpose contract. */
const ALL_PURPOSES: readonly ModelPurpose[] = [
  'propose',
  'compose',
  'reflect',
  'dream_policy',
  'probe'
];

describe('ModelPurpose probe routing (P0-5)', () => {
  it("accepts 'probe' as a first-class purpose", () => {
    expect(ALL_PURPOSES).toContain('probe');
  });

  it('routes a probe request differently from a compose request with identical input', async () => {
    const model = createScriptedModel();
    const probe = await model.complete({
      purpose: 'probe',
      messages: [{ role: 'user', content: 'candidate_A' }]
    });
    const compose = await model.complete({
      purpose: 'compose',
      messages: [{ role: 'user', content: 'candidate_A' }]
    });
    expect(probe.text).toBe('probe-loop-reply');
    expect(compose.text).not.toBe(probe.text);
    expect(JSON.parse(compose.text)).toEqual({
      ranking: ['candidate_A'],
      assessments: [{ alias: 'candidate_A', rationale: 'ranked 1 by the scripted judge' }]
    });
  });

  it('keeps per-purpose request statistics separable', async () => {
    const model = createScriptedModel();
    await model.complete({ purpose: 'probe', messages: [{ role: 'user', content: 'a' }] });
    await model.complete({
      purpose: 'compose',
      messages: [{ role: 'user', content: 'candidate_B' }]
    });
    await model.complete({ purpose: 'probe', messages: [{ role: 'user', content: 'b' }] });
    expect(model.requests.map((request) => request.purpose)).toEqual([
      'probe',
      'compose',
      'probe'
    ]);
    expect(model.requests.filter((request) => request.purpose === 'probe')).toHaveLength(2);
    expect(model.requests.filter((request) => request.purpose === 'compose')).toHaveLength(1);
  });

  it('does not regress the existing non-probe purposes', async () => {
    const model = createScriptedModel();
    const propose = await model.complete({
      purpose: 'propose',
      messages: [{ role: 'user', content: 'propose' }]
    });
    expect(JSON.parse(propose.text)).toHaveProperty('rationale');
    const reflect = await model.complete({
      purpose: 'reflect',
      messages: [{ role: 'user', content: 'reflect' }]
    });
    expect(JSON.parse(reflect.text)).toEqual({ lessons: [] });
    const dreamPolicy = await model.complete({
      purpose: 'dream_policy',
      messages: [{ role: 'user', content: 'dream' }]
    });
    expect(JSON.parse(dreamPolicy.text)).toEqual({ policies: [] });
  });
});
