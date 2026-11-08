/**
 * Dream-RSI GridPlan resolver: fallback / hard-clamp / out-of-support audit.
 *
 * Ownership: src/dream-rsi/** (rev8 plan §6.1 P1, Dream-RSI layer).
 *
 * Ported from upstream google-research/dream-rsi
 * dream_rsi/policy/grid_planning.py:88-162 (resolve_grid_plan), adapted to the
 * local TypeScript contracts. The upstream layer guards one trust boundary this
 * codebase also has: whatever proposes a grid (an LLM-designed planner
 * upstream, the deterministic planGrid sizing here) is NOT trusted to stay
 * within the policy's hard caps, to return a well-typed shape, or to return
 * anything at all. Runtime always enforces:
 *
 * 1. fallback  - a planner that throws, returns nothing, or returns a
 *                structurally invalid plan falls back to the configured
 *                fallback shape; the reason is recorded, never swallowed;
 * 2. hard clamp- an effective plan never exceeds the hard caps; every
 *                narrowing is recorded as a clamp reason;
 * 3. out_of_support - a request LARGER than what the frozen trace supports is
 *                clamped AND flagged, so an unobservable expansion can never
 *                be presented (upstream: "...cannot earn a reward").
 *
 * The resolver is a pure function: no host, no network, no sandbox, no clock.
 * It is additive over SearchGridPlan: the local sigmoid/scale/budget/
 * previousFailures/holdout mechanics in active-policy.planGrid are unchanged;
 * this layer only audits and repairs their output shape.
 */

import type { PlanGridRequest, SearchGridPlan } from '../types/contracts';

/**
 * Fallback shape used whenever a planner fails or returns an invalid plan.
 * Mirrors upstream `_fallback` (grid_planning.py:80-85): the context's own
 * conservative defaults with an explicit "fallback grid" rationale.
 */
export function fallbackGridPlan(
  fallbackWidth: number,
  fallbackDepth: number,
  policyId: string
): SearchGridPlan {
  return {
    maxWidth: Math.max(0, Math.floor(fallbackWidth)),
    maxDepth: Math.max(0, Math.floor(fallbackDepth)),
    budget: 0,
    skipProbing: false,
    stopCondition: 'budget_exhausted',
    complexity: 'unknown',
    rationale: 'fallback grid: planner did not produce a usable plan',
    policyId
  };
}

/**
 * Why a resolver run produced its outcome. Mirrors upstream ResolvedGridPlan
 * fields (grid_planning.py:28-47): fallback_reason / clamp_reasons /
 * out_of_support, plus the outcome class itself.
 */
export type GridResolutionOutcome = 'fallback' | 'clamped' | 'identity';

/**
 * Additive audit record over the effective SearchGridPlan. Nothing on
 * SearchGridPlan itself changes; consumers that ignore this record see exactly
 * the pre-rev8 shape.
 */
export interface GridResolutionAudit {
  /** fallback = planner failed/invalid; clamped = narrowed; identity = untouched. */
  readonly outcome: GridResolutionOutcome;
  /**
   * Upstream fallback_reason (grid_planning.py:109,116,126):
   * 'planner_error:<ErrorName>' | 'planner_returned_none' | 'invalid_plan:<detail>'.
   * Set only when outcome === 'fallback'.
   */
  readonly fallbackReason: string | null;
  /**
   * Upstream clamp_reasons (grid_planning.py:147-149) plus the support
   * reasons (:136,141): a subset of
   * 'branch_count_clamped' | 'refine_count_clamped' |
   * 'requested_branch_count_exceeds_trace_support' |
   * 'requested_refine_count_exceeds_trace_support'.
   */
  readonly clampReasons: readonly string[];
  /**
   * True when the REQUEST exceeded trace support (unobservable expansion).
   * Upstream marks this without changing the source: the plan still comes from
   * the policy, clamped to what the trace can actually show.
   */
  readonly outOfSupport: boolean;
}

/** The full resolver result: the effective plan plus its audit trail. */
export interface ResolvedGridPlanResult {
  readonly plan: SearchGridPlan;
  readonly audit: GridResolutionAudit;
}

/** True for a real integer (booleans are not integers - upstream _is_int). */
function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && !Number.isNaN(value);
}

/**
 * Structural validation of a planner-produced grid shape. Returns the issue
 * list; empty means valid. Mirrors upstream _coerce_plan (grid_planning.py:54-77):
 * integers for width (>=1) and depth (>=0), a string rationale. The local
 * SearchGridPlan additionally carries budget/stopCondition/complexity/policyId;
 * a malformed value in any of them makes the plan invalid as a whole - the
 * resolver falls back instead of repairing field-by-field, exactly like the
 * upstream "invalid_plan" path.
 */
export function validateGridPlanShape(plan: unknown): readonly string[] {
  const issues: string[] = [];
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    return ['plan must be a SearchGridPlan-like object'];
  }
  const candidate = plan as Record<string, unknown>;
  if (!isInt(candidate.maxWidth) || (candidate.maxWidth as number) < 0) {
    issues.push('maxWidth must be an integer >= 0');
  }
  if (!isInt(candidate.maxDepth) || (candidate.maxDepth as number) < 0) {
    issues.push('maxDepth must be an integer >= 0');
  }
  if (!isInt(candidate.budget) || (candidate.budget as number) < 0) {
    issues.push('budget must be an integer >= 0');
  }
  if (typeof candidate.skipProbing !== 'boolean') {
    issues.push('skipProbing must be a boolean');
  }
  if (
    candidate.stopCondition !== 'first_success' &&
    candidate.stopCondition !== 'budget_exhausted' &&
    candidate.stopCondition !== 'diminishing_returns' &&
    candidate.stopCondition !== 'max_depth'
  ) {
    issues.push('stopCondition must be one of first_success|budget_exhausted|diminishing_returns|max_depth');
  }
  if (
    candidate.complexity !== 'trivial' &&
    candidate.complexity !== 'simple' &&
    candidate.complexity !== 'moderate' &&
    candidate.complexity !== 'complex' &&
    candidate.complexity !== 'unknown'
  ) {
    issues.push('complexity must be one of trivial|simple|moderate|complex|unknown');
  }
  if (typeof candidate.rationale !== 'string') {
    issues.push('rationale must be a string');
  }
  if (typeof candidate.policyId !== 'string' || candidate.policyId.length === 0) {
    issues.push('policyId must be a non-empty string');
  }
  return issues;
}

interface GridSupport {
  readonly maxWidth?: number;
  readonly maxDepth?: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Resolve one grid request: run the planner inside the resolver, enforce the
 * fallback/hard-clamp/support layers, and return the effective plan plus the
 * audit trail.
 *
 * The hard caps come from the request's policy (maxWidth/maxDepth) and the
 * HARD_POLICY_LIMITS ceiling, matching the local contract "Hard policy caps
 * are upper bounds: a plan may only shrink them" (active-policy.ts:7-8). The
 * support caps (trace capacity upstream, grid_plan_support here) never widen a
 * limit - they only narrow it (upstream grid_planning.py:133-142).
 *
 * `plan` may be provided by a caller that already planned (active-policy's
 * internal sizing); when omitted the request falls straight back - a request
 * with no usable planner output is the upstream planner_error path.
 */
export function resolveGridPlan(
  request: PlanGridRequest,
  plan: unknown,
  support?: GridSupport
): ResolvedGridPlanResult {
  const policy = request.policy;
  const fallback = fallbackGridPlan(policy.maxWidth, policy.maxDepth, policy.id);

  // Layer 1: fallback. A planner that throws or returns nothing/invalid shape
  // never produces the effective plan (upstream grid_planning.py:104-127).
  let issues: readonly string[];
  try {
    issues = validateGridPlanShape(plan);
  } catch (error) {
    return {
      plan: fallback,
      audit: {
        outcome: 'fallback',
        fallbackReason: 'planner_error:' + (error instanceof Error ? error.name : String(error)),
        clampReasons: [],
        outOfSupport: false
      }
    };
  }
  if (plan === null || plan === undefined) {
    return {
      plan: fallback,
      audit: {
        outcome: 'fallback',
        fallbackReason: 'planner_returned_none',
        clampReasons: [],
        outOfSupport: false
      }
    };
  }
  if (issues.length > 0) {
    return {
      plan: fallback,
      audit: {
        outcome: 'fallback',
        fallbackReason: 'invalid_plan:' + issues.join('; '),
        clampReasons: [],
        outOfSupport: false
      }
    };
  }
  const requested = plan as SearchGridPlan;

  // Layer 2: hard caps. The policy caps and the resolver's own ceiling bound
  // the effective shape; the caps may only narrow, never widen.
  let widthLimit = Math.max(0, Math.floor(policy.maxWidth));
  let depthLimit = Math.max(0, Math.floor(policy.maxDepth));
  const clampReasons: string[] = [];
  let outOfSupport = false;

  // Layer 3: trace support. A request larger than what the frozen trace
  // supports is flagged out_of_support AND its limit narrowed (upstream
  // grid_planning.py:133-142). Support never widens a cap.
  if (support?.maxWidth !== undefined) {
    if (!finiteNonNegative(support.maxWidth)) {
      return {
        plan: fallback,
        audit: {
          outcome: 'fallback',
          fallbackReason: 'invalid_support:maxWidth must be a finite number >= 0',
          clampReasons: [],
          outOfSupport: false
        }
      };
    }
    if (requested.maxWidth > support.maxWidth) {
      outOfSupport = true;
      clampReasons.push('requested_branch_count_exceeds_trace_support');
    }
    widthLimit = Math.min(widthLimit, Math.floor(support.maxWidth));
  }
  if (support?.maxDepth !== undefined) {
    if (!finiteNonNegative(support.maxDepth)) {
      return {
        plan: fallback,
        audit: {
          outcome: 'fallback',
          fallbackReason: 'invalid_support:maxDepth must be a finite number >= 0',
          clampReasons: [],
          outOfSupport: false
        }
      };
    }
    if (requested.maxDepth > support.maxDepth) {
      outOfSupport = true;
      clampReasons.push('requested_refine_count_exceeds_trace_support');
    }
    depthLimit = Math.min(depthLimit, Math.floor(support.maxDepth));
  }

  const effectiveWidth = Math.min(requested.maxWidth, widthLimit);
  const effectiveDepth = Math.min(requested.maxDepth, depthLimit);
  if (effectiveWidth !== requested.maxWidth) {
    clampReasons.push('branch_count_clamped');
  }
  if (effectiveDepth !== requested.maxDepth) {
    clampReasons.push('refine_count_clamped');
  }

  // Identity: nothing clamped, nothing flagged - the plan is returned as-is,
  // byte-identical to what the planner produced (upstream source='policy'
  // with empty reasons, grid_planning.py:156-162).
  if (clampReasons.length === 0) {
    return {
      plan: requested,
      audit: { outcome: 'identity', fallbackReason: null, clampReasons: [], outOfSupport: false }
    };
  }

  // Clamped: the budget cannot claim more probes than the clamped shape
  // allows, and the audit records why each dimension narrowed.
  const budgetCap = Math.max(0, effectiveWidth * effectiveDepth);
  const clamped: SearchGridPlan = {
    ...requested,
    maxWidth: effectiveWidth,
    maxDepth: effectiveDepth,
    budget: Math.min(requested.budget, budgetCap),
    rationale:
      requested.rationale +
      ' [clamped: ' +
      clampReasons.join(', ') +
      (outOfSupport ? ' (out of trace support)' : '') +
      ']'
  };
  return {
    plan: clamped,
    audit: { outcome: 'clamped', fallbackReason: null, clampReasons, outOfSupport }
  };
}
