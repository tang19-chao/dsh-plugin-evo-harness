/**
 * GridPlan resolver tests (rev8 plan §6.1 P1).
 *
 * Port target: upstream google-research/dream-rsi grid_planning.py:88-162
 * (resolve_grid_plan). Each describe block covers one guard layer:
 * fallback (planner error / none / invalid), hard clamp, trace support, and
 * the identity pass-through that must leave a normal supported plan
 * byte-identical. All inputs are in-memory; no host, no network, no sandbox.
 */

import { describe, expect, it } from 'vitest';

import {
  fallbackGridPlan,
  resolveGridPlan,
  validateGridPlanShape
} from '../../../src/dream-rsi/grid-plan-resolution';
import { createActivePolicyFromDefaults } from '../../../src/dream-rsi/active-policy';
import type { PlanGridRequest, ProbeTask, SearchGridPlan } from '../../../src/types/contracts';
import { makePolicy } from './fixtures';

function task(complexity: ProbeTask['complexity'] = 'complex'): ProbeTask {
  return { id: 'task-1', prompt: 'optimize the harness', complexity, taskSignature: 'sig' };
}

function request(overrides: Partial<PlanGridRequest> = {}): PlanGridRequest {
  return {
    task: overrides.task ?? task(),
    memoryConfidence: overrides.memoryConfidence ?? 0,
    budgetRemaining: overrides.budgetRemaining ?? 20,
    currentDepth: overrides.currentDepth ?? 0,
    exploredNodes: overrides.exploredNodes ?? 0,
    policy: overrides.policy ?? makePolicy(),
    ...(overrides.previousFailures === undefined
      ? {}
      : { previousFailures: overrides.previousFailures })
  };
}

/** A well-formed plan the way planGrid produces it. */
function validPlan(overrides: Partial<SearchGridPlan> = {}): SearchGridPlan {
  return {
    maxWidth: overrides.maxWidth ?? 4,
    maxDepth: overrides.maxDepth ?? 3,
    budget: overrides.budget ?? 12,
    skipProbing: overrides.skipProbing ?? false,
    stopCondition: overrides.stopCondition ?? 'budget_exhausted',
    complexity: overrides.complexity ?? 'complex',
    rationale: overrides.rationale ?? 'complexity=complex factor=1.00 -> width=4',
    policyId: overrides.policyId ?? 'pi-0'
  };
}

describe('fallback layer (planner error / none / invalid)', () => {
  it('falls back on planner_returned_none', () => {
    const result = resolveGridPlan(request(), null);
    expect(result.audit.outcome).toBe('fallback');
    expect(result.audit.fallbackReason).toBe('planner_returned_none');
    expect(result.audit.clampReasons).toEqual([]);
    expect(result.audit.outOfSupport).toBe(false);
    expect(result.plan.maxWidth).toBe(request().policy.maxWidth);
    expect(result.plan.maxDepth).toBe(request().policy.maxDepth);
    expect(result.plan.rationale).toBe('fallback grid: planner did not produce a usable plan');
  });

  it('falls back on undefined planner output (same as none)', () => {
    const result = resolveGridPlan(request(), undefined);
    expect(result.audit.outcome).toBe('fallback');
    expect(result.audit.fallbackReason).toBe('planner_returned_none');
  });

  it('falls back with invalid_plan on a non-integer width (upstream _coerce_plan)', () => {
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 2.5 }));
    expect(result.audit.outcome).toBe('fallback');
    expect(result.audit.fallbackReason).toContain('invalid_plan:');
    expect(result.audit.fallbackReason).toContain('maxWidth must be an integer >= 0');
    expect(result.plan.stopCondition).toBe('budget_exhausted');
  });

  it('falls back with invalid_plan on a negative depth', () => {
    const result = resolveGridPlan(request(), validPlan({ maxDepth: -1 }));
    expect(result.audit.fallbackReason).toContain('invalid_plan:');
    expect(result.audit.fallbackReason).toContain('maxDepth must be an integer >= 0');
  });

  it('falls back with invalid_plan on a non-numeric width (upstream bool check)', () => {
    // true is not an integer even though typeof true === 'boolean'; the
    // upstream check explicitly rejects booleans-as-ints.
    const bogus = validPlan({ maxWidth: 2 }) as unknown as Record<string, unknown>;
    bogus.maxWidth = true;
    const result = resolveGridPlan(request(), bogus);
    expect(result.audit.fallbackReason).toContain('invalid_plan:');
    expect(result.audit.fallbackReason).toContain('maxWidth must be an integer >= 0');
  });

  it('falls back with invalid_plan on a non-string rationale (upstream reason check)', () => {
    const bogus = validPlan() as unknown as Record<string, unknown>;
    bogus.rationale = 42;
    const result = resolveGridPlan(request(), bogus);
    expect(result.audit.fallbackReason).toContain('invalid_plan:');
    expect(result.audit.fallbackReason).toContain('rationale must be a string');
  });

  it('falls back with invalid_plan on a foreign stopCondition', () => {
    const bogus = validPlan() as unknown as Record<string, unknown>;
    bogus.stopCondition = 'vibes';
    const result = resolveGridPlan(request(), bogus);
    expect(result.audit.fallbackReason).toContain('invalid_plan:');
    expect(result.audit.fallbackReason).toContain('stopCondition');
  });

  it('falls back on a non-object plan without throwing', () => {
    expect(() => resolveGridPlan(request(), 'not a plan')).not.toThrow();
    const result = resolveGridPlan(request(), 'not a plan');
    expect(result.audit.outcome).toBe('fallback');
    expect(result.audit.fallbackReason).toContain('invalid_plan:');
  });

  it('reports planner_error when shape validation itself throws', () => {
    // A getter that throws inside validateGridPlanShape exercises the
    // try/catch: the resolver must convert it to a fallback, not propagate.
    const hostile = {
      get maxWidth(): number {
        throw new RangeError('hostile getter');
      }
    };
    const result = resolveGridPlan(request(), hostile);
    expect(result.audit.outcome).toBe('fallback');
    expect(result.audit.fallbackReason).toBe('planner_error:RangeError');
  });

  it('fallback plan is derivable standalone via fallbackGridPlan', () => {
    const plan = fallbackGridPlan(4, 3, 'pi-0');
    expect(plan.maxWidth).toBe(4);
    expect(plan.maxDepth).toBe(3);
    expect(plan.skipProbing).toBe(false);
    expect(plan.policyId).toBe('pi-0');
    expect(plan.rationale.length).toBeGreaterThan(0);
  });
});

describe('hard clamp layer', () => {
  it('clamps a width above the policy cap and records branch_count_clamped', () => {
    // policy cap 4 (makePolicy default); request 7.
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 7, budget: 21 }));
    expect(result.audit.outcome).toBe('clamped');
    expect(result.audit.fallbackReason).toBeNull();
    expect(result.plan.maxWidth).toBe(4);
    expect(result.plan.maxDepth).toBe(3);
    expect(result.audit.clampReasons).toContain('branch_count_clamped');
    expect(result.audit.clampReasons).not.toContain('refine_count_clamped');
    expect(result.audit.outOfSupport).toBe(false);
  });

  it('clamps budget to the clamped shape capacity', () => {
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 7, budget: 21 }));
    expect(result.plan.budget).toBeLessThanOrEqual(result.plan.maxWidth * result.plan.maxDepth);
  });

  it('clamps depth above the policy cap and records refine_count_clamped', () => {
    const result = resolveGridPlan(request(), validPlan({ maxDepth: 6 }));
    expect(result.plan.maxDepth).toBe(3);
    expect(result.audit.clampReasons).toContain('refine_count_clamped');
  });

  it('never widens: a plan below the cap passes untouched', () => {
    const plan = validPlan({ maxWidth: 2, maxDepth: 1, budget: 2 });
    const result = resolveGridPlan(request(), plan);
    expect(result.audit.outcome).toBe('identity');
    expect(result.plan).toBe(plan);
  });

  it('annotates the rationale when clamping', () => {
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 7 }));
    expect(result.plan.rationale).toContain('[clamped: branch_count_clamped]');
    expect(result.plan.rationale.startsWith('complexity=complex')).toBe(true);
  });

  it('keeps the requested reason and policyId through a clamp', () => {
    const plan = validPlan({ maxWidth: 7, policyId: 'pi-7', rationale: 'custom reason' });
    const result = resolveGridPlan(request(), plan);
    expect(result.plan.policyId).toBe('pi-7');
    expect(result.plan.rationale).toContain('custom reason');
  });
});

describe('trace support layer (out_of_support audit)', () => {
  it('flags and clamps a width larger than trace support', () => {
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 6 }), { maxWidth: 4 });
    expect(result.audit.outOfSupport).toBe(true);
    expect(result.audit.clampReasons).toContain('requested_branch_count_exceeds_trace_support');
    expect(result.audit.clampReasons).toContain('branch_count_clamped');
    expect(result.plan.maxWidth).toBe(4);
    expect(result.plan.maxDepth).toBe(3);
  });

  it('flags and clamps a depth larger than trace support', () => {
    const result = resolveGridPlan(request(), validPlan({ maxDepth: 5 }), { maxDepth: 3 });
    expect(result.audit.outOfSupport).toBe(true);
    expect(result.audit.clampReasons).toContain('requested_refine_count_exceeds_trace_support');
    expect(result.plan.maxDepth).toBe(3);
  });

  it('support NARROWS a policy cap that is wider than the trace (upstream min())', () => {
    // Policy allows 4; the frozen trace only supports 2 -> effective limit 2.
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 4 }), { maxWidth: 2 });
    expect(result.plan.maxWidth).toBe(2);
    expect(result.audit.outOfSupport).toBe(true);
  });

  it('support never WIDENS a narrower policy cap', () => {
    // Policy allows 2; trace supports 6 -> still 2, and no out_of_support.
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 2 }), { maxWidth: 6 });
    expect(result.plan.maxWidth).toBe(2);
    expect(result.audit.outOfSupport).toBe(false);
    expect(result.audit.clampReasons).toEqual([]);
  });

  it('marks out_of_support without clamping when the flag alone applies', () => {
    // Within policy caps but above trace support: the flag must fire even
    // though the (policy) clamp does not distinguish itself - both clamp and
    // flag land here because support narrows the limit.
    const result = resolveGridPlan(request(), validPlan({ maxWidth: 3 }), { maxWidth: 2 });
    expect(result.audit.outOfSupport).toBe(true);
    expect(result.plan.maxWidth).toBe(2);
  });

  it('rejects a non-finite support value as invalid_support fallback', () => {
    const result = resolveGridPlan(request(), validPlan(), { maxWidth: Number.NaN });
    expect(result.audit.outcome).toBe('fallback');
    expect(result.audit.fallbackReason).toContain('invalid_support:');
  });

  it('a supported plan inside trace capacity stays identity', () => {
    const plan = validPlan();
    const result = resolveGridPlan(request(), plan, { maxWidth: 8, maxDepth: 8 });
    expect(result.audit.outcome).toBe('identity');
    expect(result.audit.outOfSupport).toBe(false);
    expect(result.plan).toBe(plan);
  });
});

describe('identity pass-through (normal supported requests)', () => {
  it('returns the SAME plan object for a fully supported request', () => {
    const plan = validPlan();
    const result = resolveGridPlan(request(), plan);
    expect(result.plan).toBe(plan);
    expect(result.audit).toEqual({
      outcome: 'identity',
      fallbackReason: null,
      clampReasons: [],
      outOfSupport: false
    });
  });

  it('does not turn a normal plan into a fallback (no false-positive guards)', () => {
    const plan = validPlan({ skipProbing: true, stopCondition: 'first_success' });
    const result = resolveGridPlan(request(), plan);
    expect(result.audit.outcome).toBe('identity');
    expect(result.plan.skipProbing).toBe(true);
    expect(result.plan.rationale).toBe(plan.rationale);
  });
});

describe('integration: active-policy planGrid routes through the resolver', () => {
  it('records an identity audit for a normal supported plan', () => {
    const policy = createActivePolicyFromDefaults();
    const grid = policy.planGrid(request());
    expect(grid.maxWidth).toBeGreaterThan(0);
    expect(policy.lastGridResolution).toEqual({
      outcome: 'identity',
      fallbackReason: null,
      clampReasons: [],
      outOfSupport: false
    });
  });

  it('keep the existing sizing behaviour: complexity scaling unchanged', () => {
    // The resolver is additive: the documented width ladder [1,2,3,4] for
    // [trivial, simple, moderate, complex] (active-policy.test.ts:149-155)
    // must be untouched by the integration.
    const policy = createActivePolicyFromDefaults();
    const widths = (['trivial', 'simple', 'moderate', 'complex'] as const).map(
      (complexity) => policy.planGrid(request({ task: task(complexity) })).maxWidth
    );
    expect(widths).toEqual([1, 2, 3, 4]);
  });

  it('keeps skipProbing semantics and records identity for them', () => {
    const policy = createActivePolicyFromDefaults();
    const grid = policy.planGrid(request({ task: task('simple'), memoryConfidence: 0.9 }));
    expect(grid.skipProbing).toBe(true);
    expect(grid.maxWidth).toBe(0);
    expect(policy.lastGridResolution?.outcome).toBe('identity');
  });

  it('replaces (not accumulates) the audit across calls', () => {
    const policy = createActivePolicyFromDefaults();
    policy.planGrid(request());
    policy.planGrid(request({ task: task('simple'), memoryConfidence: 0.9 }));
    expect(policy.lastGridResolution?.outcome).toBe('identity');
  });

  it('starts with a null audit before the first planGrid', () => {
    const policy = createActivePolicyFromDefaults();
    expect(policy.lastGridResolution).toBeNull();
  });
});

describe('validateGridPlanShape (structural validation standalone)', () => {
  it('accepts a well-formed plan with no issues', () => {
    expect(validateGridPlanShape(validPlan())).toEqual([]);
  });

  it('rejects arrays and nulls', () => {
    expect(validateGridPlanShape(null).length).toBeGreaterThan(0);
    expect(validateGridPlanShape([validPlan()]).length).toBeGreaterThan(0);
  });

  it('collects multiple issues instead of failing on the first', () => {
    const issues = validateGridPlanShape({
      maxWidth: 1.5,
      maxDepth: 'three',
      budget: -1,
      skipProbing: 'yes',
      stopCondition: 'nope',
      complexity: 3,
      rationale: null,
      policyId: ''
    });
    expect(issues.length).toBe(8);
  });
});
