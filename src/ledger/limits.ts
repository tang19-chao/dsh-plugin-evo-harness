/**
 * PR-3B: budget limits with a declared, testable domain of applicability.
 *
 * WHAT THIS MODULE IS (AND IS NOT)
 * --------------------------------
 * ADR-0004 §7.1 exists because three things LOOK like a spending cap and are not:
 *
 *   | Conventional control              | Looks like       | Actually is                |
 *   |-----------------------------------|------------------|----------------------------|
 *   | `reserve(estimated)`              | an upper bound   | an admission check only    |
 *   | `conservativeFallbackCostMicros`  | an upper bound   | a LOWER bound (floor)      |
 *   | `Promise.race` timeout            | an upper bound   | local abandonment only     |
 *
 * A reservation bounds what we AGREE to spend, not what the provider WILL bill.
 * The only control that bounds the bill is a physical cap on generation plus a
 * bounded input, both priced — that is what §7.2 calls a *provable hard upper
 * bound*, and this module computes it or refuses.
 *
 * SO THE MODULE'S HONEST DOMAIN IS NARROW:
 *   - it is a bound calculator and an admission rule;
 *   - it claims nothing about routes it cannot bound (they are REJECTED, not
 *     estimated);
 *   - its number is an upper bound only under the three preconditions §7.2
 *     lists, each of which is an explicit, checkable flag — not an inference.
 *
 * Everything here is pure: no I/O, no clock, no randomness.
 */

import { createHash } from 'node:crypto';
import type { ModelRateCard } from './types.js';

// ---------------------------------------------------------------------------
// §8.2 — dimension barrier: exploration seats and money never share arithmetic
// ---------------------------------------------------------------------------

declare const seatBrand: unique symbol;
declare const microsBrand: unique symbol;

/**
 * Exploration concurrency slots. DIMENSIONLESS integer(s): they count slots,
 * not value. `number & brand` means the compiler refuses to add it to money.
 */
export type ExplorationSeatUnits = number & { readonly [seatBrand]: 'seat-units' };

/** Money in micro-dollars (1 USD = 1_000_000). See {@link ExplorationSeatUnits}. */
export type CurrencyMicros = number & { readonly [microsBrand]: 'currency-micros' };

/** Thrown when a seat count and a sum of money are combined. */
export class DimensionMismatchError extends Error {
  readonly code = 'DIMENSION_MISMATCH' as const;

  constructor(message: string) {
    super(`[DimensionMismatchError:DIMENSION_MISMATCH] ${message}`);
    this.name = 'DimensionMismatchError';
  }
}

/** Validate and brand a seat count. Rejects non-integers and negatives. */
export function seatUnits(value: number): ExplorationSeatUnits {
  if (!Number.isInteger(value) || value < 0) {
    throw new DimensionMismatchError(
      `an exploration seat count must be a non-negative integer, received ${String(value)}`
    );
  }
  return value as ExplorationSeatUnits;
}

/** Validate and brand a micro-dollar amount. Rejects non-integers and negatives. */
export function currencyMicros(value: number): CurrencyMicros {
  if (!Number.isInteger(value) || value < 0) {
    throw new DimensionMismatchError(
      `a currency amount must be a non-negative integer of micros, received ${String(value)}`
    );
  }
  return value as CurrencyMicros;
}

/** Add two micro-dollar amounts. The only sanctioned way to total money. */
export function addCurrency(left: CurrencyMicros, right: CurrencyMicros): CurrencyMicros {
  return currencyMicros(left + right);
}

/** Add two seat counts. The only sanctioned way to total seats. */
export function addSeats(left: ExplorationSeatUnits, right: ExplorationSeatUnits): ExplorationSeatUnits {
  return seatUnits(left + right);
}

/**
 * The budget report, structurally incapable of merging the two dimensions.
 *
 * ADR-0004 §8.2 forbids a report line like "10 explorations + $5 budget". The
 * way to make that unrepresentable is to put seats and money in separate,
 * non-additive sub-objects — there is deliberately no `total` field.
 */
export interface DimensionSeparatedBudgetReport {
  readonly seats: {
    readonly total: ExplorationSeatUnits;
    readonly occupied: ExplorationSeatUnits;
    readonly available: ExplorationSeatUnits;
  };
  readonly currency: {
    readonly generalTotalMicros: CurrencyMicros;
    readonly generalSettledMicros: CurrencyMicros;
    readonly generalRemainingMicros: CurrencyMicros;
    readonly verificationTotalMicros: CurrencyMicros;
    readonly verificationSettledMicros: CurrencyMicros;
    readonly verificationRemainingMicros: CurrencyMicros;
  };
}

/**
 * Runtime companion to the brand types.
 *
 * Brand types are erased at runtime, so a report assembled through an `any` cast
 * would silently combine the two units. This check rejects any report that
 * tries: a merged key (one that would carry both a seat count and money) is a
 * hard error, which is what makes §8.2 testable rather than aspirational.
 */
const MERGED_DIMENSION_KEYS = ['total', 'budget', 'budgetMicros', 'seatMicros', 'totalBudget'];

export function assertDimensionSeparated(report: DimensionSeparatedBudgetReport): void {
  for (const key of MERGED_DIMENSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(report as unknown as Record<string, unknown>, key)) {
      throw new DimensionMismatchError(
        `report field "${key}" would merge exploration seats with currency; §8.2 requires separate columns`
      );
    }
  }
  for (const [key, value] of Object.entries(report.seats)) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new DimensionMismatchError(`seats.${key} must be a non-negative integer, received ${String(value)}`);
    }
  }
  for (const [key, value] of Object.entries(report.currency)) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new DimensionMismatchError(`currency.${key} must be a non-negative integer of micros, received ${String(value)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// §7.2 — the provable hard upper bound
// ---------------------------------------------------------------------------

/**
 * Why a route is NOT provably bounded. Enumerated (never a free string) so a
 * rejection reason can be asserted and audited without prose matching.
 */
export type UnboundRouteReason =
  /** No `max_tokens` / `max_output_tokens` would reach the provider request. */
  | 'missing-max-output-tokens'
  /** The provider is not known to treat that parameter as a physical stop. */
  | 'provider-does-not-enforce-max-tokens'
  /** The input bound rests on a character heuristic rather than a verified tokenizer. */
  | 'input-tokenizer-unverified'
  /** Tool loops / retries / hidden context could push input past the declared bound. */
  | 'input-bound-not-declared'
  /** Reasoning is billable here and no reasoning ceiling was declared. */
  | 'reasoning-not-bounded'
  /** Retries multiply the per-call cost and no attempt ceiling was declared. */
  | 'retries-not-bounded'
  /** A billable dimension (cache, tools, fixed fee) has no verified rate. */
  | 'billable-dimension-unpriced';

/**
 * A route's declared cost ceilings. Every field is an *assertion by the caller*;
 * the flags say whether the assertion rests on something checkable.
 */
export interface RouteCostBound {
  readonly routeId: string;
  /** `max_tokens` actually injected into the provider request body. */
  readonly maxOutputTokens?: number;
  /** Worst-case input tokens for ONE attempt, all loops and hidden context included. */
  readonly maxInputTokens?: number;
  /** Worst-case reasoning tokens for ONE attempt (0 when the route cannot reason). */
  readonly maxReasoningTokens?: number;
  /** Worst-case provider attempts, retries included. */
  readonly maxNetworkAttempts?: number;
  readonly tokenizerVerified?: boolean;
  readonly providerEnforcesMaxTokens?: boolean;
  readonly allBillableDimensionsPriced?: boolean;
  /** Fixed per-call or per-attempt fees in micros, when the provider charges them. */
  readonly fixedSurchargeMicros?: number;
}

/** Itemised upper bound, one line per billable dimension. */
export interface CostUpperBoundBreakdown {
  readonly inputBoundTokens: number;
  readonly inputRatePerMillion: number;
  readonly inputCostMicros: number;

  readonly reasoningBoundTokens: number;
  readonly reasoningRatePerMillion: number;
  readonly reasoningCostMicros: number;

  readonly outputBoundTokens: number;
  readonly outputRatePerMillion: number;
  readonly outputCostMicros: number;

  readonly fixedSurchargeMicros: number;
  readonly perAttemptSubtotalMicros: number;
  readonly maxNetworkAttempts: number;
  /** True upper bound: every attempt could spend the full per-attempt ceiling. */
  readonly totalUpperBoundMicros: number;
}

/** Result of asking "can this route's bill be bounded, and by how much?". */
export type BoundVerdict =
  | {
      readonly bounded: true;
      readonly upperBoundMicros: CurrencyMicros;
      readonly breakdown: CostUpperBoundBreakdown;
      readonly rateCardDigest: string;
    }
  | {
      readonly bounded: false;
      readonly reasons: readonly UnboundRouteReason[];
      readonly detail: string;
      readonly rateCardDigest: string;
    };

/** SHA-256 (first 16 hex) of the rate card content: the §8.1 digest. */
export function rateCardDigest(rateCard: ModelRateCard): string {
  const canonical = JSON.stringify([
    rateCard.modelId,
    rateCard.inputRatePerMillion,
    rateCard.cacheReadRatePerMillion ?? null,
    rateCard.cacheWriteRatePerMillion ?? null,
    rateCard.outputRatePerMillion,
    rateCard.reasoningRatePerMillion ?? null,
    rateCard.reasoningSeparatelyBilled,
    rateCard.conservativeFallbackCostMicros
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** Ceil a product to whole micros so a fractional rate never under-states a bound. */
function ceilMicros(tokens: number, ratePerMillion: number): number {
  return Math.ceil((tokens * ratePerMillion) / 1_000_000);
}

/**
 * Compute the provable hard upper bound for one call, or list why it cannot be
 * computed.
 *
 * The arithmetic is deliberately CONSERVATIVE, because an under-estimate is the
 * failure mode that costs money:
 *
 *   - input is priced at the LARGEST of the input / cache-read / cache-write
 *     rates. Providers that charge cache writes above fresh input exist, and
 *     assuming "all input at the input rate" would under-bound them;
 *   - reasoning is priced at the larger of the reasoning and output rates,
 *     whichever applies under `reasoningSeparatelyBilled`;
 *   - every term is ceiling-rounded, never floor-rounded;
 *   - the per-attempt subtotal is multiplied by the attempt ceiling, because a
 *     retry can re-consume the full input and generate a full output again.
 *
 * Per ADR-0004 §7.2 different-rate token classes are summed as separate
 * dimensions; they are never merged into one token count before pricing.
 */
export function computeCallCostUpperBound(bound: RouteCostBound, rateCard: ModelRateCard): BoundVerdict {
  const reasons: UnboundRouteReason[] = [];
  const digest = rateCardDigest(rateCard);

  const maxOutput = bound.maxOutputTokens;
  if (maxOutput === undefined || !Number.isInteger(maxOutput) || maxOutput <= 0) {
    reasons.push('missing-max-output-tokens');
  }
  if (bound.providerEnforcesMaxTokens !== true) {
    reasons.push('provider-does-not-enforce-max-tokens');
  }

  const maxInput = bound.maxInputTokens;
  if (maxInput === undefined || !Number.isInteger(maxInput) || maxInput <= 0) {
    reasons.push('input-bound-not-declared');
  }
  if (bound.tokenizerVerified !== true) {
    reasons.push('input-tokenizer-unverified');
  }

  // Reasoning must be declared whenever it can be generated or billed. A route
  // that truly cannot reason declares 0; leaving it undefined is "unbounded".
  const maxReasoning = bound.maxReasoningTokens;
  if (maxReasoning === undefined || !Number.isInteger(maxReasoning) || maxReasoning < 0) {
    reasons.push('reasoning-not-bounded');
  }

  const attempts = bound.maxNetworkAttempts;
  if (attempts === undefined || !Number.isInteger(attempts) || attempts <= 0) {
    reasons.push('retries-not-bounded');
  }

  if (bound.allBillableDimensionsPriced !== true) {
    reasons.push('billable-dimension-unpriced');
  }

  // A rate card with a non-positive or non-integer rate cannot bound anything:
  // a free dimension silently makes the "bound" smaller than reality.
  const rateFields: Array<[string, number]> = [
    ['inputRatePerMillion', rateCard.inputRatePerMillion],
    ['outputRatePerMillion', rateCard.outputRatePerMillion]
  ];
  if (rateCard.reasoningSeparatelyBilled) {
    rateFields.push(['reasoningRatePerMillion', rateCard.reasoningRatePerMillion ?? 0]);
  }
  for (const [name, value] of rateFields) {
    if (!Number.isFinite(value) || value < 0) {
      reasons.push('billable-dimension-unpriced');
      break;
    }
  }

  if (reasons.length > 0) {
    return {
      bounded: false,
      // De-duplicated so a caller sees each defect once.
      reasons: [...new Set(reasons)],
      detail:
        `route "${bound.routeId}" has no provable hard upper bound: ` +
        [...new Set(reasons)].join(', ') +
        ' (ADR-0004 §7.2 requires all three preconditions)',
      rateCardDigest: digest
    };
  }

  // Past the guard above, every precondition held, so all four bounds are
  // concrete numbers. This re-check is unreachable defensive code whose only job
  // is to tell the compiler what the guard already proved — no `!` assertions,
  // because a silent cast here would hide a future edit that drops a reason.
  if (
    maxOutput === undefined ||
    maxInput === undefined ||
    maxReasoning === undefined ||
    attempts === undefined
  ) {
    throw new Error(
      'unreachable: computeCallCostUpperBound reached the arithmetic with an unvalidated bound'
    );
  }

  const inputRate = Math.max(
    rateCard.inputRatePerMillion,
    rateCard.cacheReadRatePerMillion ?? rateCard.inputRatePerMillion,
    rateCard.cacheWriteRatePerMillion ?? rateCard.inputRatePerMillion
  );
  const reasoningRate = rateCard.reasoningSeparatelyBilled
    ? Math.max(rateCard.reasoningRatePerMillion ?? 0, 0)
    : rateCard.outputRatePerMillion;

  const inputCostMicros = ceilMicros(maxInput, inputRate);
  const reasoningCostMicros = ceilMicros(maxReasoning, reasoningRate);
  // When reasoning is folded into output it is already capped by maxOutput;
  // when billed separately it is an independent dimension. Either way the two
  // are priced at their own rate and summed as distinct terms.
  const outputCostMicros = ceilMicros(maxOutput, rateCard.outputRatePerMillion);
  const fixedSurchargeMicros = Math.max(0, Math.ceil(bound.fixedSurchargeMicros ?? 0));

  const perAttemptSubtotalMicros =
    inputCostMicros + reasoningCostMicros + outputCostMicros + fixedSurchargeMicros;
  const totalUpperBoundMicros = perAttemptSubtotalMicros * attempts;

  return {
    bounded: true,
    upperBoundMicros: currencyMicros(totalUpperBoundMicros),
    breakdown: {
      inputBoundTokens: maxInput,
      inputRatePerMillion: inputRate,
      inputCostMicros,
      reasoningBoundTokens: maxReasoning,
      reasoningRatePerMillion: reasoningRate,
      reasoningCostMicros,
      outputBoundTokens: maxOutput,
      outputRatePerMillion: rateCard.outputRatePerMillion,
      outputCostMicros,
      fixedSurchargeMicros,
      perAttemptSubtotalMicros,
      maxNetworkAttempts: attempts,
      totalUpperBoundMicros
    },
    rateCardDigest: digest
  };
}

// ---------------------------------------------------------------------------
// §7.3 — admission modes and the admission decision
// ---------------------------------------------------------------------------

/**
 * `hard`: only provably bounded routes may spend; everything else is refused or
 * must carry an explicit, ceiling-limited risk override.
 * `observation`: record what happens, gate nothing (the pre-PR-3B behaviour).
 */
export type AdmissionMode = 'hard' | 'observation';

/** Everything the admission rule needs. Deliberately explicit — no defaults. */
export interface AdmissionPolicy {
  readonly mode: AdmissionMode;
  readonly allowUnboundedRiskOverride: boolean;
  /** Per-call stop-loss ceiling that MUST be ring-fenced when overriding. */
  readonly unboundedRiskStopLossMicros?: number;
}

/** Why an admission was refused. Enumerated so assertions never grep prose. */
export type AdmissionRejection =
  | 'unbounded_route_rejected'
  | 'risk_override_without_stop_loss'
  | 'stop_loss_exceeds_pool';

/**
 * Result of the admission rule, before any pool arithmetic happens.
 *
 * `reserveMicros` is what the caller must ring-fence: for a bounded route it is
 * the physical ceiling, NOT an estimate. That is the whole point of §7.3 —
 * reserving the estimate and hoping is what lets a runaway generation bill 50x.
 */
export type AdmissionDecision =
  | {
      readonly admitted: true;
      readonly basis: 'provable-hard-bound';
      readonly reserveMicros: CurrencyMicros;
      readonly upperBound: CostUpperBoundBreakdown;
      readonly unboundedRisk: false;
    }
  | {
      readonly admitted: true;
      readonly basis: 'explicit-risk-override';
      readonly reserveMicros: CurrencyMicros;
      readonly unboundedRisk: true;
      readonly stopLossMicros: CurrencyMicros;
      readonly reasons: readonly UnboundRouteReason[];
      readonly rateCardDigest: string;
    }
  | {
      readonly admitted: false;
      readonly reason: AdmissionRejection;
      readonly reasons: readonly UnboundRouteReason[];
      readonly detail: string;
    };

/**
 * Decide whether a call may proceed, and what to ring-fence.
 *
 * In `observation` mode this always admits at the caller's estimate and marks
 * the decision as an observation — it never fabricates a bound it cannot prove.
 */
export function decideAdmission(params: {
  readonly policy: AdmissionPolicy;
  readonly route: RouteCostBound | undefined;
  readonly rateCard: ModelRateCard;
  readonly estimatedCostMicros: number;
}): AdmissionDecision {
  const { policy, route, rateCard, estimatedCostMicros } = params;

  if (policy.mode === 'observation') {
    // No claim of a bound is made: reserve the estimate, exactly as before.
    return {
      admitted: true,
      basis: 'explicit-risk-override',
      reserveMicros: currencyMicros(Math.max(0, Math.ceil(estimatedCostMicros))),
      unboundedRisk: true,
      stopLossMicros: currencyMicros(Math.max(0, Math.ceil(estimatedCostMicros))),
      reasons: route === undefined ? ['input-bound-not-declared'] : [],
      rateCardDigest: rateCardDigest(rateCard)
    };
  }

  // ---- hard mode -----------------------------------------------------------
  if (route === undefined) {
    return {
      admitted: false,
      reason: 'unbounded_route_rejected',
      reasons: ['missing-max-output-tokens', 'input-bound-not-declared'],
      detail:
        'hard mode requires a declared route cost bound; a call with no bound cannot ' +
        'be admitted because its bill is unbounded (ADR-0004 §7.3)'
    };
  }

  const verdict = computeCallCostUpperBound(route, rateCard);
  if (verdict.bounded) {
    return {
      admitted: true,
      basis: 'provable-hard-bound',
      reserveMicros: verdict.upperBoundMicros,
      upperBound: verdict.breakdown,
      unboundedRisk: false
    };
  }

  // ---- not provably bounded: explicit override or refusal -------------------
  const stopLoss = policy.unboundedRiskStopLossMicros;
  if (policy.allowUnboundedRiskOverride !== true) {
    return {
      admitted: false,
      reason: 'unbounded_route_rejected',
      reasons: verdict.reasons,
      detail: verdict.detail
    };
  }
  if (stopLoss === undefined || !Number.isInteger(stopLoss) || stopLoss <= 0) {
    // An override without a ceiling is not a control at all — it is the same
    // unbounded exposure wearing a permission flag.
    return {
      admitted: false,
      reason: 'risk_override_without_stop_loss',
      reasons: verdict.reasons,
      detail:
        'allowUnboundedRiskOverride is set but no positive unboundedRiskStopLossMicros is configured; ' +
        'an override without a per-call stop-loss is unbounded exposure (ADR-0004 §7.3)'
    };
  }
  return {
    admitted: true,
    basis: 'explicit-risk-override',
    reserveMicros: currencyMicros(stopLoss),
    unboundedRisk: true,
    stopLossMicros: currencyMicros(stopLoss),
    reasons: verdict.reasons,
    rateCardDigest: verdict.rateCardDigest
  };
}

// ---------------------------------------------------------------------------
// §7.4 — tiered watermarks, dynamic throttling and hard freeze
// ---------------------------------------------------------------------------

/** Consumption tier of one pool. */
export type WatermarkTier = 'normal' | 'warning' | 'critical' | 'frozen';

export interface WatermarkConfig {
  /** Fraction of the pool at which a warning is raised (default 0.8). */
  readonly warningRatio: number;
  /** Fraction at which general concurrency is throttled (default 0.95). */
  readonly criticalRatio: number;
}

export const DEFAULT_WATERMARKS: WatermarkConfig = Object.freeze({
  warningRatio: 0.8,
  criticalRatio: 0.95
});

/**
 * Compute the tier for one pool.
 *
 * Consumption is `reserved + settled`, i.e. everything already committed. A pool
 * that has overdrawn is `frozen` regardless of the ratio: ratio arithmetic on a
 * negative remainder would report "under budget" at exactly the worst moment.
 */
export function computeWatermarkTier(params: {
  readonly totalMicros: number;
  readonly committedMicros: number;
  readonly overdraftMicros?: number;
  readonly watermarks?: WatermarkConfig;
}): WatermarkTier {
  const watermarks = params.watermarks ?? DEFAULT_WATERMARKS;
  if ((params.overdraftMicros ?? 0) > 0) {
    return 'frozen';
  }
  if (params.totalMicros <= 0) {
    // A zero budget cannot fund anything: frozen, not "100% free".
    return 'frozen';
  }
  if (params.committedMicros >= params.totalMicros) {
    return 'frozen';
  }
  const ratio = params.committedMicros / params.totalMicros;
  if (ratio >= watermarks.criticalRatio) {
    return 'critical';
  }
  if (ratio >= watermarks.warningRatio) {
    return 'warning';
  }
  return 'normal';
}

/** Concurrency multiplier applied at the critical tier (ADR-0004 §7.4-2: halved). */
export function criticalTierSeatCap(maxSeats: number): number {
  return Math.max(1, Math.floor(maxSeats / 2));
}

/** Alert kinds emitted by the limit machinery. Enumerated, not prose. */
export type LimitAlertKind =
  | 'watermark-warning'
  | 'watermark-critical'
  | 'pool-frozen'
  | 'overdraft-observed'
  | 'unbounded-route-rejected'
  | 'unbounded-route-granted'
  | 'critical-tier-throttled'
  // P3-A2 observe mode: limits that WOULD have denied are surfaced here instead
  // of changing the call's outcome. These are observations, not failures.
  | 'observe-seat-exceeded'
  | 'observe-budget-exceeded'
  | 'seat-retained-pending-remote'
  | 'call-unresolved-after-window';

export interface LimitAlert {
  readonly kind: LimitAlertKind;
  readonly pool?: 'general' | 'verification';
  readonly detail: string;
  readonly observedAt: number;
  readonly callId?: string;
}

/**
 * The phased-limit view of one pool, exposed for reporting.
 *
 * `admitted` is what actual callers care about; `tier` explains WHY.
 */
export interface PoolLimitStatus {
  readonly tier: WatermarkTier;
  readonly committedMicros: number;
  readonly totalMicros: number;
  readonly overdraftMicros: number;
  /** New general-pool work is refused at this tier. */
  readonly admissionOpen: boolean;
}

/** Derive the phased-limit status of a pool. Pure; used by the manager and tests. */
export function poolLimitStatus(params: {
  readonly totalMicros: number;
  readonly reservedMicros: number;
  readonly settledMicros: number;
  readonly overdraftMicros: number;
  readonly watermarks?: WatermarkConfig;
}): PoolLimitStatus {
  const committed = params.reservedMicros + params.settledMicros;
  const tier = computeWatermarkTier({
    totalMicros: params.totalMicros,
    committedMicros: committed,
    overdraftMicros: params.overdraftMicros,
    ...(params.watermarks === undefined ? {} : { watermarks: params.watermarks })
  });
  return {
    tier,
    committedMicros: committed,
    totalMicros: params.totalMicros,
    overdraftMicros: params.overdraftMicros,
    admissionOpen: tier !== 'frozen'
  };
}
