/**
 * rev6 R3: the real-benefit canary controller — the fail-closed gate between
 * "an evaluation is authorized" and "a real model call is made".
 *
 * WHY THIS MODULE EXISTS (contract §5.8 / §7, D-4)
 * ------------------------------------------------
 * The user authorized a real-benefit evaluation, but authorization is not a
 * binding: `src/**` has no account primitive (grep `accountId|tenantId|orgId|
 * billingAccount` = 0 hits) and `HOSTSMOKE_AUTHORIZED=1` is only an envelope
 * — `in-host.mjs` already judges its own 9.4-2 `failed` when that flag cannot
 * be bound to an account/budget ("refusing to fabricate evidence"). This module
 * turns the four binding conditions (§7 B-1..B-4) into executable checkable
 * rules so that:
 *
 *   - when the binding is INCOMPLETE the verdict is `blocked` with the exact
 *     missing items — a legal terminal state, never papered over with
 *     mock/estimated data (N-10);
 *   - when the binding is COMPLETE exactly one minimal canary may run:
 *     baseline and treatment on the SAME single task, hard-budget admitted,
 *     read-only tool allowlist enforced, every abort condition wired;
 *   - nothing here can write memory, enter guarded-active, publish, or grow
 *     the budget or the task set. The controller has no such code paths, and
 *     the negative controls in the e2e suite pin that.
 *
 * LEDGER DISCIPLINE (P3-A / P3-4 structural rules, rev5-frozen)
 * -------------------------------------------------------------
 * This module never constructs the ledger manager class directly and never
 * deep-imports its module: it goes through the ledger barrel and the single
 * sanctioned assembly factory, exactly like the other production bridges. The
 * canary holds the TWO-PHASE SETTLEMENT (`beginCall` -> `settleCall`), never
 * the mutable accounting primitive, so the accounting semantics cannot drift
 * from the rest of the plugin. The hard admission rule is applied explicitly
 * through `decideAdmission` under `AdmissionPolicy{mode:'hard',
 * allowUnboundedRiskOverride:false}` before every reserve; the ring-fenced
 * amount is the route's PROVABLE CEILING, never an estimate.
 *
 * HONESTY RULES ENFORCED BY CONSTRUCTION (not by comments)
 * --------------------------------------------------------
 *   1. Only `basis:'provable-hard-bound'` lets a call through. An override is
 *      structurally impossible: no input reaches the policy.
 *   2. The RewardContract arm is scored by the production
 *      `scoreUnderRewardContract` — the same yardstick as every other rev6
 *      number. The controller never invents a verdict: it attaches ONLY an
 *      operator-supplied verification receipt that passes the production
 *      `isTrustedVerification` shape check, and trust is decided by the
 *      production provenance rule (registered producer + bound evidence hash).
 *      Without an operator-supplied trusted-producer set the production path
 *      is structurally untrusted (C2-pre), so the benefit verdict can only be
 *      `insufficient` — runnability is not benefit (A-R3-4).
 *   3. An ABORT never reports a benefit. Abort is a control fact, not a
 *      measurement; the verdict collapses to `blocked` with the trigger named.
 *   4. cacheRead/cost precision is never upgraded: usage is observed through
 *      the t12 `observeCacheUsage` rules and settled through the production
 *      conversion — unreported fields stay unreported, undeclared semantics
 *      stay `unknown`, and the conservative floor at settle time charges for
 *      what cannot be proven cheap. B-2 additionally requires the conservative
 *      fallback to fit INSIDE the route's provable ceiling, so the floor can
 *      never push a settled charge past the ring-fenced bound.
 *
 * The module is PURE HOST LOGIC: no fs, no network, no clock of its own. The
 * model call, tool execution and verification receipt arrive through
 * caller-supplied seams, so the same rules are testable in-process and
 * executable in a real host run.
 *
 * T4 ADDITIONS: THE REAL HOST CLIENT + THE TOKEN HARD BUDGET
 * ----------------------------------------------------------
 * The canary's transport is now a REAL host client (`RealBenefitHostClient`,
 * bound from the ZCode `ctx.llm` service or a caller adapter by
 * ./real-benefit-host-client.ts). Two fail-closed gates run BEFORE any arm:
 * a run with no bound client is refused (`host-client-unbound`), and a client
 * whose DESENSITIZED identity does not match the authorized account/model/
 * route is refused (`host-client-identity-mismatch`) — the raw account id
 * never enters a client object, so a leak cannot hide inside the transport.
 *
 * The token hard budget is a second, independent kill switch beside the
 * micros budget: a TOTAL cap (≤ 800,000,000 tokens, user-authorized ceiling)
 * plus STRICTLY SMALLER per-task / per-arm / per-call caps, all validated at
 * binding time and enforced at run time on MEASURED usage only. The per-call
 * cap rides EVERY client call (`call({perCallTokenCap})`, t4-fix), so the
 * streaming kill switch is wired by construction — the controller passes the
 * binding's cap, the client aborts its own stream the moment a usage chunk
 * crosses it, and the controller additionally re-checks every settled call
 * post-hoc (adapter surfaces cannot hook the stream). The cross-call gates
 * make the 800M ceiling ABSOLUTE (t4-fix): before each arm's reservation the
 * accumulated measured gross plus a FULL arm cap is judged against the
 * ceiling (`absoluteTotalCapWouldExceed`), and every settled gross is judged
 * against the task/total caps AND the ceiling itself after settlement — an
 * exceed aborts the run immediately and refuses the next reservation. Usage
 * is carried verbatim: a reported field is never re-counted into an invented
 * number, and an unreported field contributes nothing (it is never recorded
 * as a measured zero).
 */
import type {
  ProbeTrajectory,
  TrajectoryStatus,
  ContractMetadata
} from '../types/contracts';
import {
  assembleAgentLoopLedger,
  computeCallCostUpperBound,
  decideAdmission,
  currencyMicros,
  rateCardDigest,
  type AdmissionDecision,
  type AdmissionPolicy,
  type LedgerAssembly,
  type ModelRateCard,
  type ProviderUsagePayload,
  type RouteCostBound,
  type TwoPhaseSettlement,
  type TwoPhaseSettleOutcome
} from '../ledger/index.js';
import { createToolFaceRegistry, type ToolFaceCounters } from '../cordis-seams/tool-face';
import {
  createProbeAuthorizationLedger,
  type ProbeAuthorizationCounters
} from '../jitrl/runtime-control';
import {
  isTrustedVerification,
  type TrustedVerification
} from '../jitrl/step-evaluator';
import { scoreUnderRewardContract } from '../jitrl/reward-contract';
import { observeCacheUsage, type CacheReadSample } from './cache-observation';
import {
  canaryUsageTokenCount,
  maskAccountId,
  verifyHostClientIdentity,
  type HostClientCallOutcome,
  type RealBenefitHostClient,
  type RealBenefitHostClientIdentity
} from './real-benefit-host-client';

// ---------------------------------------------------------------------------
// B-1..B-4: the binding inputs (all external — env / credential file, never
// fabricated fields; D-4)
// ---------------------------------------------------------------------------

/** One real account identity. All three fields must come from the operator. */
export interface RealBenefitAccount {
  readonly provider: string;
  readonly model: string;
  /** A real account / organization / billing identifier. Never invented here. */
  readonly accountId: string;
  /** Optional human label for the report; carries no control semantics. */
  readonly label?: string;
}

/** The read-only tool allowlist. `"*"` is rejected at validation time. */
export type ReadonlyToolAllowlist = readonly string[];

// ---------------------------------------------------------------------------
// T4: the token hard budget (independent of, and additional to, the micros
// hard budget). The user-authorized TOTAL ceiling is 800,000,000 tokens; the
// per-task / per-arm / per-call caps must each be STRICTLY SMALLER so a single
// call can never consume the whole authorization.
// ---------------------------------------------------------------------------

/** The user-authorized total token ceiling for the whole canary (800M). */
export const CANARY_TOTAL_TOKEN_CEILING = 800_000_000;

/** The strictly-smaller nested caps. Each must be < the level above it. */
export interface RealBenefitTokenCaps {
  /**
   * TOTAL gross measured tokens across the whole canary run (both arms).
   * Validated `<= CANARY_TOTAL_TOKEN_CEILING` and `< perTask…` is impossible
   * (one task) — instead it must be strictly smaller than the ceiling.
   */
  readonly totalTokens: number;
  /** Gross measured tokens for the ONE canary task (≤ totalTokens). */
  readonly perTaskTokens: number;
  /** Gross measured tokens for ONE arm (≤ perTaskTokens). */
  readonly perArmTokens: number;
  /** Gross measured tokens for ONE model call (≤ perArmTokens). */
  readonly perCallTokens: number;
}

/** The token budget the binding must carry. All four caps are mandatory. */
export type RealBenefitTokenBudget = RealBenefitTokenCaps;

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Validate the nested token caps; returns the named problems (empty = valid).
 *
 * The nested ladder (total ≤ 800M ceiling + strictly smaller per-level caps)
 * is the BINDING-time shape. The ABSOLUTE-total guarantee — no sequence of
 * calls the run's structure permits can push the accumulated measured gross
 * past the user-authorized 800M — is enforced at EXECUTION level
 * (`absoluteTotalCapWouldExceed` refuses the next arm's reservation when the
 * accumulated gross plus a full arm could reach the ceiling; the driver's
 * between-arms and post-run gates judge every settled gross). Binding keeps
 * the ladder; execution makes the ceiling absolute.
 */
export function validateTokenBudget(caps: RealBenefitTokenBudget | undefined): string[] {
  const problems: string[] = [];
  if (caps === undefined) {
    return ['token-caps-missing'];
  }
  let valid = true;
  for (const field of ['totalTokens', 'perTaskTokens', 'perArmTokens', 'perCallTokens'] as const) {
    const value = caps[field];
    if (!isPositiveNumber(value) || !Number.isInteger(value)) {
      problems.push('token-caps.' + field + '-not-positive-integer');
      valid = false;
    }
  }
  if (!valid) {
    return problems;
  }
  // The total must stay inside the user-authorized ceiling.
  if (caps.totalTokens > CANARY_TOTAL_TOKEN_CEILING) {
    problems.push('token-caps.totalTokens-exceeds-authorized-ceiling');
  }
  // Each level must be STRICTLY smaller than the level above, so no single
  // call/arm/task can consume the whole authorization.
  if (caps.perTaskTokens >= caps.totalTokens) problems.push('token-caps.perTaskTokens-not-below-total');
  if (caps.perArmTokens >= caps.perTaskTokens) problems.push('token-caps.perArmTokens-not-below-perTask');
  if (caps.perCallTokens >= caps.perArmTokens) problems.push('token-caps.perCallTokens-not-below-perArm');
  return problems;
}

/**
 * t4-fix: the ABSOLUTE-total pre-check for the next arm's reservation. Given
 * the accumulated measured gross and the binding's caps, returns true when
 * admitting one more FULL ARM (its per-arm cap) could push the run past the
 * user-authorized 800M ceiling. The driver refuses the reservation in that
 * case — the ceiling is absolute at EXECUTION level, not merely observed
 * after the fact. (Pure so the execution-level rule is directly testable.)
 */
export function absoluteTotalCapWouldExceed(
  measuredGrossTokensSoFar: number,
  caps: RealBenefitTokenCaps
): boolean {
  // Conservative by construction: the remaining structure can add at most one
  // full arm cap per remaining arm, so a single remaining arm is judged at
  // its FULL cap (never under-counted before a refusal).
  return measuredGrossTokensSoFar + caps.perArmTokens > CANARY_TOTAL_TOKEN_CEILING;
}

/** Everything the four binding conditions need. */
export interface RealBenefitBinding {
  /** B-1. */
  readonly account: RealBenefitAccount;
  /** B-2 hard budget (micros). Must be > 0 and independent of the reserve. */
  readonly generalBudgetMicros: number;
  /** B-2 verification reserve (micros, >= 0). Kept separate from the general pool. */
  readonly verificationReserveMicros: number;
  /** B-2 concurrency seats (> 0). */
  readonly maxConcurrencySeats: number;
  /** B-2 rate card. The digest is part of the machine-readable credential. */
  readonly rateCard: ModelRateCard;
  /** B-2 the single route this canary may use, with its declared cost bound. */
  readonly route: RouteCostBound;
  /** B-3 read-only tool allowlist (may be empty; `"*"` is rejected). */
  readonly readonlyTools: ReadonlyToolAllowlist;
  /**
   * T4: the token hard budget (total ≤ 800M ceiling + strictly smaller
   * per-task/per-arm/per-call caps). Missing caps fail the binding.
   */
  readonly tokenBudget: RealBenefitTokenBudget;
  /** B-1/B-4 provenance of the explicit authorization (operator/issue/scope doc). */
  readonly authorization: {
    readonly grantedBy: string;
    readonly reason: string;
  };
  /** The ONE task the canary runs. The task set cannot grow (B-4). */
  readonly taskId: string;
  /** The recorded advice the treatment arm receives (baseline gets none). */
  readonly recordedAdvice: string;
}

/** The four binding conditions, each with its own status. */
export type RealBenefitBindingItemId = 'account' | 'hard-budget' | 'tool-allowlist' | 'token-budget' | 'controller-abort';

export interface RealBenefitBindingItemStatus {
  readonly id: RealBenefitBindingItemId;
  readonly satisfied: boolean;
  /** Machine-readable reason; empty when satisfied. */
  readonly reason: string;
}

export interface RealBenefitBindingEvaluation {
  readonly satisfied: boolean;
  readonly items: readonly RealBenefitBindingItemStatus[];
  /** The machine-readable missing list, one reason per defect. */
  readonly missing: readonly string[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Validate one rate card for canary use: every billable dimension priced, a
 * strictly positive conservative fallback (ADR-0003 §7.3.5 — no silent 0-cost
 * bypass), and integral rates.
 */
export function validateRateCardForCanary(rateCard: ModelRateCard): string[] {
  const problems: string[] = [];
  if (!isNonEmptyString(rateCard.modelId)) problems.push('rateCard.modelId-empty');
  for (const field of ['inputRatePerMillion', 'outputRatePerMillion'] as const) {
    const value = rateCard[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push('rateCard.' + field + '-unpriced');
    }
  }
  if (rateCard.reasoningSeparatelyBilled && !isNonNegativeInteger(rateCard.reasoningRatePerMillion ?? -1)) {
    problems.push('rateCard.reasoningRatePerMillion-unpriced');
  }
  if (!isPositiveInteger(rateCard.conservativeFallbackCostMicros)) {
    problems.push('rateCard.conservativeFallbackCostMicros-not-positive');
  }
  return problems;
}

/**
 * Evaluate the four binding conditions (contract §7). Pure: it builds nothing
 * and starts nothing — a binding that fails here can never reach the canary.
 *
 * B-2 additionally PROVES, through the production admission rule under the
 * exact policy the canary runs, that the route's bill is bounded, and that the
 * conservative fallback fits inside that provable ceiling (a floor above the
 * ring-fenced bound would let an unknown-usage settlement punch through the
 * hard budget). "Money in the pool" is not "a bounded bill".
 */
export function validateRealBenefitBinding(binding: RealBenefitBinding): RealBenefitBindingEvaluation {
  const items: RealBenefitBindingItemStatus[] = [];

  // ---- B-1 account (+ authorization provenance; ADR 0006 D-P4-5) ----------
  const accountProblems: string[] = [];
  if (!isNonEmptyString(binding.account?.provider)) accountProblems.push('account.provider-empty');
  if (!isNonEmptyString(binding.account?.model)) accountProblems.push('account.model-empty');
  if (!isNonEmptyString(binding.account?.accountId)) accountProblems.push('account.accountId-empty');
  if (!isNonEmptyString(binding.authorization?.grantedBy)) accountProblems.push('authorization.grantedBy-empty');
  if (!isNonEmptyString(binding.authorization?.reason)) accountProblems.push('authorization.reason-empty');
  items.push({
    id: 'account',
    satisfied: accountProblems.length === 0,
    reason: accountProblems.join(',')
  });

  // ---- B-2 hard budget ----------------------------------------------------
  const budgetProblems: string[] = [];
  if (!isPositiveInteger(binding.generalBudgetMicros)) budgetProblems.push('generalBudgetMicros-not-positive');
  if (!isNonNegativeInteger(binding.verificationReserveMicros)) budgetProblems.push('verificationReserveMicros-negative');
  if (!isPositiveInteger(binding.maxConcurrencySeats)) budgetProblems.push('maxConcurrencySeats-not-positive');
  budgetProblems.push(...validateRateCardForCanary(binding.rateCard));
  if (binding.route === undefined) {
    budgetProblems.push('route-missing');
  } else {
    const policy: AdmissionPolicy = { mode: 'hard', allowUnboundedRiskOverride: false };
    const decision: AdmissionDecision = decideAdmission({
      policy,
      route: binding.route,
      rateCard: binding.rateCard,
      estimatedCostMicros: 0
    });
    if (!decision.admitted || decision.basis !== 'provable-hard-bound') {
      budgetProblems.push('admission-not-provable-hard-bound');
    } else {
      // The unknown-usage conservative floor must fit inside the ring-fenced
      // ceiling, or a settlement without usage could exceed the hard budget.
      const bound = computeCallCostUpperBound(binding.route, binding.rateCard);
      if (bound.bounded && binding.rateCard.conservativeFallbackCostMicros > bound.upperBoundMicros) {
        budgetProblems.push('rateCard.conservativeFallbackCostMicros-exceeds-route-bound');
      }
    }
  }
  items.push({
    id: 'hard-budget',
    satisfied: budgetProblems.length === 0,
    reason: budgetProblems.join(',')
  });

  // ---- B-3 read-only tool allowlist ---------------------------------------
  // The allowlist must be EXPLICIT (an array, possibly empty). Absent is not
  // empty: "no list supplied" cannot silently mean "everything allowed".
  const allowlistProblems: string[] = [];
  if (!Array.isArray(binding.readonlyTools)) {
    allowlistProblems.push('tool-allowlist-missing');
  } else if (binding.readonlyTools.includes('*')) {
    // A wildcard is the opposite of an allowlist; §7 forbids it.
    allowlistProblems.push('tool-allowlist-wildcard-forbidden');
  }
  items.push({
    id: 'tool-allowlist',
    satisfied: allowlistProblems.length === 0,
    reason: allowlistProblems.join(',')
  });

  // ---- token hard budget (t4) ----------------------------------------------
  // The user-authorized total ceiling plus strictly smaller nested caps. A run
  // without caps cannot bound its own token spend, so it is refused here.
  const tokenProblems = validateTokenBudget(binding.tokenBudget);
  items.push({
    id: 'token-budget',
    satisfied: tokenProblems.length === 0,
    reason: tokenProblems.join(',')
  });

  // ---- B-4 abort switch ---------------------------------------------------
  // The abort switch is not an external input: it is this controller's own
  // fail-closed structure (see the abort triggers in the arm runner). It is
  // reported so the credential shows all four rows, and it cannot be false.
  items.push({ id: 'controller-abort', satisfied: true, reason: '' });

  const missing = items.filter((item) => !item.satisfied).map((item) => item.reason);
  return { satisfied: missing.length === 0, items, missing };
}

// ---------------------------------------------------------------------------
// Environment collection: the ONE place env names are defined, so the host
// runner and the credential script read the same keys with the same rules.
// ---------------------------------------------------------------------------

/** Env keys → binding fields. Exported so every reader agrees on the names. */
export const REAL_BENEFIT_ENV_KEYS = Object.freeze({
  provider: 'R3A_ACCOUNT_PROVIDER',
  model: 'R3A_ACCOUNT_MODEL',
  accountId: 'R3A_ACCOUNT_ID',
  accountLabel: 'R3A_ACCOUNT_LABEL',
  generalBudgetMicros: 'R3A_GENERAL_BUDGET_MICROS',
  verificationReserveMicros: 'R3A_VERIFICATION_RESERVE_MICROS',
  maxConcurrencySeats: 'R3A_MAX_CONCURRENCY_SEATS',
  rateModelId: 'R3A_RATE_MODEL_ID',
  rateInput: 'R3A_RATE_INPUT_PER_MILLION',
  rateCacheRead: 'R3A_RATE_CACHE_READ_PER_MILLION',
  rateCacheWrite: 'R3A_RATE_CACHE_WRITE_PER_MILLION',
  rateOutput: 'R3A_RATE_OUTPUT_PER_MILLION',
  rateReasoning: 'R3A_RATE_REASONING_PER_MILLION',
  rateReasoningSeparate: 'R3A_RATE_REASONING_SEPARATELY_BILLED',
  rateFallback: 'R3A_RATE_FALLBACK_MICROS',
  routeMaxInput: 'R3A_ROUTE_MAX_INPUT_TOKENS',
  routeMaxOutput: 'R3A_ROUTE_MAX_OUTPUT_TOKENS',
  routeMaxReasoning: 'R3A_ROUTE_MAX_REASONING_TOKENS',
  routeMaxAttempts: 'R3A_ROUTE_MAX_ATTEMPTS',
  routeTokenizerVerified: 'R3A_ROUTE_TOKENIZER_VERIFIED',
  routeProviderEnforces: 'R3A_ROUTE_PROVIDER_ENFORCES_MAX_TOKENS',
  routeAllDimsPriced: 'R3A_ROUTE_ALL_BILLABLE_DIMENSIONS_PRICED',
  readonlyTools: 'R3A_READONLY_TOOLS',
  tokenTotal: 'R3A_TOKEN_TOTAL_CAP',
  tokenPerTask: 'R3A_TOKEN_PER_TASK_CAP',
  tokenPerArm: 'R3A_TOKEN_PER_ARM_CAP',
  tokenPerCall: 'R3A_TOKEN_PER_CALL_CAP',
  grantedBy: 'R3A_AUTHORIZED_BY',
  authorizationReason: 'R3A_AUTHORIZATION_REASON',
  taskId: 'R3A_TASK_ID',
  recordedAdvice: 'R3A_RECORDED_ADVICE'
} as const);

/** Env names for the canary's declared route (documented in the preregistration). */
export const REAL_BENEFIT_ROUTE_ID = 'r3a-single-canary';

const parseOptionalInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
};

const parseOptionalFlag = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return undefined;
};

const hasText = (value: string | undefined): boolean => value !== undefined && value.trim().length > 0;

/** What `collectRealBenefitBindingFromEnv` can assemble before validation. */
export interface CollectedRealBenefitBinding {
  readonly binding: RealBenefitBinding | undefined;
  /** Env keys that were actually provided (for the not-run report). */
  readonly provided: readonly string[];
  /** Values present but unparseable (never silently dropped). */
  readonly constructionProblems: readonly string[];
}

/**
 * Read a candidate binding from an environment-style record. This NEVER
 * invents values: an absent/invalid key stays absent and is reported — either
 * as a construction problem (unparseable) or by `validateRealBenefitBinding`
 * (missing → blocked). Only a fully-provided set produces a binding object,
 * and only `validateRealBenefitBinding` decides it is runnable.
 */
export function collectRealBenefitBindingFromEnv(env: Record<string, string | undefined>): CollectedRealBenefitBinding {
  const keys = REAL_BENEFIT_ENV_KEYS;
  const provided: string[] = [];
  const problems: string[] = [];

  // ---- account ------------------------------------------------------------
  if (hasText(env[keys.provider])) provided.push(keys.provider);
  if (hasText(env[keys.model])) provided.push(keys.model);
  if (hasText(env[keys.accountId])) provided.push(keys.accountId);
  if (hasText(env[keys.accountLabel])) provided.push(keys.accountLabel);
  const account: RealBenefitAccount | undefined =
    hasText(env[keys.provider]) && hasText(env[keys.model]) && hasText(env[keys.accountId])
      ? {
          provider: String(env[keys.provider]).trim(),
          model: String(env[keys.model]).trim(),
          accountId: String(env[keys.accountId]).trim(),
          ...(hasText(env[keys.accountLabel]) ? { label: String(env[keys.accountLabel]).trim() } : {})
        }
      : undefined;

  // ---- budgets ------------------------------------------------------------
  const generalBudgetMicros = parseOptionalInteger(env[keys.generalBudgetMicros]);
  const verificationReserveMicros = parseOptionalInteger(env[keys.verificationReserveMicros]);
  const maxConcurrencySeats = parseOptionalInteger(env[keys.maxConcurrencySeats]);
  for (const [key, value] of [
    [keys.generalBudgetMicros, generalBudgetMicros],
    [keys.verificationReserveMicros, verificationReserveMicros],
    [keys.maxConcurrencySeats, maxConcurrencySeats]
  ] as const) {
    if (env[key] !== undefined) {
      provided.push(key);
      if (value === undefined || Number.isNaN(value)) problems.push('non-integer-value:' + key);
    }
  }

  // ---- rate card ----------------------------------------------------------
  const rateModelId = env[keys.rateModelId]?.trim();
  const rateInput = parseOptionalInteger(env[keys.rateInput]);
  const rateCacheRead = parseOptionalInteger(env[keys.rateCacheRead]);
  const rateCacheWrite = parseOptionalInteger(env[keys.rateCacheWrite]);
  const rateOutput = parseOptionalInteger(env[keys.rateOutput]);
  const rateReasoning = parseOptionalInteger(env[keys.rateReasoning]);
  const reasoningSeparatelyBilled = parseOptionalFlag(env[keys.rateReasoningSeparate]) ?? false;
  const rateFallback = parseOptionalInteger(env[keys.rateFallback]);
  if (hasText(env[keys.rateModelId])) provided.push(keys.rateModelId);
  for (const [key, value] of [
    [keys.rateInput, rateInput],
    [keys.rateCacheRead, rateCacheRead],
    [keys.rateCacheWrite, rateCacheWrite],
    [keys.rateOutput, rateOutput],
    [keys.rateReasoning, rateReasoning],
    [keys.rateFallback, rateFallback]
  ] as const) {
    if (env[key] !== undefined) {
      provided.push(key);
      if (value === undefined || Number.isNaN(value)) problems.push('non-integer-value:' + key);
    }
  }
  const rateCard: ModelRateCard | undefined =
    rateModelId !== undefined &&
    rateInput !== undefined && rateInput >= 0 &&
    rateOutput !== undefined && rateOutput >= 0 &&
    rateFallback !== undefined && rateFallback > 0
      ? {
          modelId: rateModelId,
          inputRatePerMillion: rateInput,
          outputRatePerMillion: rateOutput,
          ...(rateCacheRead !== undefined ? { cacheReadRatePerMillion: rateCacheRead } : {}),
          ...(rateCacheWrite !== undefined ? { cacheWriteRatePerMillion: rateCacheWrite } : {}),
          ...(rateReasoning !== undefined ? { reasoningRatePerMillion: rateReasoning } : {}),
          reasoningSeparatelyBilled,
          conservativeFallbackCostMicros: rateFallback
        }
      : undefined;

  // ---- route bound --------------------------------------------------------
  const routeMaxInput = parseOptionalInteger(env[keys.routeMaxInput]);
  const routeMaxOutput = parseOptionalInteger(env[keys.routeMaxOutput]);
  const routeMaxReasoning = parseOptionalInteger(env[keys.routeMaxReasoning]);
  const routeMaxAttempts = parseOptionalInteger(env[keys.routeMaxAttempts]);
  const tokenizerVerified = parseOptionalFlag(env[keys.routeTokenizerVerified]);
  const providerEnforces = parseOptionalFlag(env[keys.routeProviderEnforces]);
  const allDimsPriced = parseOptionalFlag(env[keys.routeAllDimsPriced]);
  for (const [key, value] of [
    [keys.routeMaxInput, routeMaxInput],
    [keys.routeMaxOutput, routeMaxOutput],
    [keys.routeMaxReasoning, routeMaxReasoning],
    [keys.routeMaxAttempts, routeMaxAttempts]
  ] as const) {
    if (env[key] !== undefined) {
      provided.push(key);
      if (value === undefined || Number.isNaN(value)) problems.push('non-integer-value:' + key);
    }
  }
  for (const [key, value] of [
    [keys.routeTokenizerVerified, tokenizerVerified],
    [keys.routeProviderEnforces, providerEnforces],
    [keys.routeAllDimsPriced, allDimsPriced]
  ] as const) {
    if (env[key] !== undefined) {
      provided.push(key);
      if (value === undefined) problems.push('unparseable-flag:' + key);
    }
  }
  const route: RouteCostBound | undefined =
    routeMaxInput !== undefined && routeMaxInput > 0 &&
    routeMaxOutput !== undefined && routeMaxOutput > 0 &&
    routeMaxReasoning !== undefined && routeMaxReasoning >= 0 &&
    routeMaxAttempts !== undefined && routeMaxAttempts > 0 &&
    tokenizerVerified !== undefined && providerEnforces !== undefined && allDimsPriced !== undefined
      ? {
          routeId: REAL_BENEFIT_ROUTE_ID,
          maxInputTokens: routeMaxInput,
          maxOutputTokens: routeMaxOutput,
          maxReasoningTokens: routeMaxReasoning,
          maxNetworkAttempts: routeMaxAttempts,
          tokenizerVerified,
          providerEnforcesMaxTokens: providerEnforces,
          allBillableDimensionsPriced: allDimsPriced
        }
      : undefined;

  // ---- allowlist / token budget / authorization / task --------------------
  const rawTools = env[keys.readonlyTools];
  const readonlyTools: readonly string[] | undefined =
    rawTools === undefined
      ? undefined
      : rawTools.trim().length === 0
        ? []
        : rawTools.split(',').map((tool) => tool.trim());
  if (rawTools !== undefined) provided.push(keys.readonlyTools);

  const tokenTotal = parseOptionalInteger(env[keys.tokenTotal]);
  const tokenPerTask = parseOptionalInteger(env[keys.tokenPerTask]);
  const tokenPerArm = parseOptionalInteger(env[keys.tokenPerArm]);
  const tokenPerCall = parseOptionalInteger(env[keys.tokenPerCall]);
  for (const [key, value] of [
    [keys.tokenTotal, tokenTotal],
    [keys.tokenPerTask, tokenPerTask],
    [keys.tokenPerArm, tokenPerArm],
    [keys.tokenPerCall, tokenPerCall]
  ] as const) {
    if (env[key] !== undefined) {
      provided.push(key);
      if (value === undefined || Number.isNaN(value)) problems.push('non-integer-value:' + key);
    }
  }
  const tokenBudget: RealBenefitTokenBudget | undefined =
    tokenTotal !== undefined && tokenPerTask !== undefined && tokenPerArm !== undefined && tokenPerCall !== undefined
      ? { totalTokens: tokenTotal, perTaskTokens: tokenPerTask, perArmTokens: tokenPerArm, perCallTokens: tokenPerCall }
      : undefined;

  const grantedBy = env[keys.grantedBy]?.trim();
  const authorizationReason = env[keys.authorizationReason]?.trim();
  if (hasText(env[keys.grantedBy])) provided.push(keys.grantedBy);
  if (hasText(env[keys.authorizationReason])) provided.push(keys.authorizationReason);

  const taskId = env[keys.taskId]?.trim();
  const recordedAdvice = env[keys.recordedAdvice] ?? '';
  if (hasText(env[keys.taskId])) provided.push(keys.taskId);
  if (env[keys.recordedAdvice] !== undefined) provided.push(keys.recordedAdvice);

  if (
    account === undefined ||
    rateCard === undefined ||
    route === undefined ||
    readonlyTools === undefined ||
    tokenBudget === undefined
  ) {
    return { binding: undefined, provided, constructionProblems: problems };
  }
  return {
    binding: {
      account,
      generalBudgetMicros: generalBudgetMicros ?? 0,
      verificationReserveMicros: verificationReserveMicros ?? 0,
      maxConcurrencySeats: maxConcurrencySeats ?? 0,
      rateCard,
      route,
      readonlyTools,
      tokenBudget,
      authorization: { grantedBy: grantedBy ?? '', reason: authorizationReason ?? '' },
      taskId: taskId ?? '',
      recordedAdvice
    },
    provided,
    constructionProblems: problems
  };
}

// ---------------------------------------------------------------------------
// t2 unification: ONE production definition of the reported default token
// ladder and of the required R3A_* keys, so the credential script
// (scripts/host-smoke/budget-binding.mjs) and the canary runner
// (scripts/host-smoke/real-benefit.mjs) read the same semantics and cannot
// drift apart. Both scripts import these instead of keeping private copies.
// ---------------------------------------------------------------------------

/**
 * The REPORTED default token-cap ladder (total = ceiling, task = total/2,
 * arm = total/4, call = total/8), derived from the user-authorized total
 * ceiling. REPORT/PROVENANCE ONLY: it never fills a missing env key. The
 * binding requires every cap as an explicit operator input
 * (`validateTokenBudget` refuses a missing ladder), so an absent cap can
 * never mean "unbounded" and no default can silently choose the size of a
 * run's hard budget. The production controller re-validates whatever the
 * operator supplies.
 */
export function canaryTokenCapDefaults(ceiling: number = CANARY_TOTAL_TOKEN_CEILING): RealBenefitTokenCaps {
  return {
    totalTokens: ceiling,
    perTaskTokens: ceiling / 2,
    perArmTokens: ceiling / 4,
    perCallTokens: ceiling / 8
  };
}

/**
 * The R3A_* keys a SATISFIABLE binding needs, in contract order: B-1 account
 * + authorization provenance, B-2 budget/seats/rate card/route, B-3
 * allowlist, t4 token ladder. This is exactly the §7 floor: a binding
 * assembled from ONLY these keys validates satisfied, and omitting any ONE
 * of them fails either construction or validation.
 */
export const REAL_BENEFIT_REQUIRED_ENV_KEYS: readonly string[] = Object.freeze([
  REAL_BENEFIT_ENV_KEYS.provider,
  REAL_BENEFIT_ENV_KEYS.model,
  REAL_BENEFIT_ENV_KEYS.accountId,
  REAL_BENEFIT_ENV_KEYS.generalBudgetMicros,
  REAL_BENEFIT_ENV_KEYS.maxConcurrencySeats,
  REAL_BENEFIT_ENV_KEYS.rateModelId,
  REAL_BENEFIT_ENV_KEYS.rateInput,
  REAL_BENEFIT_ENV_KEYS.rateOutput,
  REAL_BENEFIT_ENV_KEYS.rateFallback,
  REAL_BENEFIT_ENV_KEYS.routeMaxInput,
  REAL_BENEFIT_ENV_KEYS.routeMaxOutput,
  REAL_BENEFIT_ENV_KEYS.routeMaxReasoning,
  REAL_BENEFIT_ENV_KEYS.routeMaxAttempts,
  REAL_BENEFIT_ENV_KEYS.routeTokenizerVerified,
  REAL_BENEFIT_ENV_KEYS.routeProviderEnforces,
  REAL_BENEFIT_ENV_KEYS.routeAllDimsPriced,
  REAL_BENEFIT_ENV_KEYS.readonlyTools,
  REAL_BENEFIT_ENV_KEYS.tokenTotal,
  REAL_BENEFIT_ENV_KEYS.tokenPerTask,
  REAL_BENEFIT_ENV_KEYS.tokenPerArm,
  REAL_BENEFIT_ENV_KEYS.tokenPerCall,
  REAL_BENEFIT_ENV_KEYS.grantedBy,
  REAL_BENEFIT_ENV_KEYS.authorizationReason
]);

/**
 * The `missing-required-key:<key>` rows for an UNCONSTRUCTABLE collection:
 * one named row per required R3A_* key the environment did not provide.
 * Shared by the credential script and the canary runner so both name the
 * SAME set — the runner must never silently default a required key into the
 * environment (a missing token cap cannot mean "unbounded").
 */
export function missingRequiredBindingKeys(collected: CollectedRealBenefitBinding): readonly string[] {
  if (collected.binding !== undefined) return [];
  const provided = new Set<string>(collected.provided);
  return REAL_BENEFIT_REQUIRED_ENV_KEYS.filter((key) => !provided.has(key)).map(
    (key) => 'missing-required-key:' + key
  );
}

// ---------------------------------------------------------------------------
// The canary verdict shapes
// ---------------------------------------------------------------------------

/**
 * Terminal verdict for the benefit question. `passed`/`failed` are
 * benefit-level (treatment vs baseline under the RewardContract, both arms
 * trusted); `insufficient` means the calls ran but the evidence cannot decide;
 * `not-run`/`blocked` mean no call was made and WHY.
 */
export type RealBenefitVerdict = 'passed' | 'failed' | 'insufficient' | 'not-run' | 'blocked';

/** Raw usage exactly as the host reported it (absent field = not reported). */
export type RawCanaryUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
};

export interface CanaryCallRecord {
  readonly arm: 'baseline' | 'treatment';
  readonly callId: string;
  readonly admitted: boolean;
  readonly admissionBasis: string | undefined;
  readonly reserveMicros: number;
  readonly rejectedBecause: string | undefined;
  readonly outcome: TrajectoryStatus | 'aborted_local' | 'not-called';
  /** `interim` = money held pending reconciliation; `final` = booked. */
  readonly settlementPhase: 'interim' | 'final' | 'none';
  /** Raw usage, verbatim. Absent fields are unreported, not zero. */
  readonly usageRaw: RawCanaryUsage;
  /** The precision-preserving cacheRead observation for this call (t12 rules). */
  readonly cacheReadSample: CacheReadSample;
  /**
   * T4: the GROSS MEASURED token count over the reported fields
   * (`canaryUsageTokenCount`), or undefined when the host reported none.
   * The token caps are judged on this — never on an invented number.
   */
  readonly measuredTokens: number | undefined;
  /**
   * T4 (report-surface t14): TRUE when THIS call was terminated by the token
   * cap, from EITHER enforcement point — the client's mid-stream kill switch
   * (the streaming surface aborts its own signal) OR the controller's post-hoc
   * per-call guard (an adapter surface cannot hook the stream, so the settled
   * measured gross is judged after settlement). The flag says the call WAS
   * cap-terminated; it never implies WHICH surface did it — for that, read
   * `tokenCapAbortOrigin` alongside this flag.
   */
  readonly abortedByTokenCap: boolean;
  /**
   * T4 (t14): WHERE the per-call cap was enforced for THIS call, when it was
   * cap-terminated at all. `'client-mid-stream'` = the bound client killed its
   * own stream (streaming surface, kill switch wired by construction);
   * `'controller-post-hoc'` = the client could not hook the stream (adapter
   * surface reports `capIgnored`) and the controller judged the settled gross.
   * `undefined` = the call was never terminated by the token cap (the
   * transport carries no cap semantics — legacy seam).
   */
  readonly tokenCapAbortOrigin: 'client-mid-stream' | 'controller-post-hoc' | undefined;
  /**
   * T4 (t14): true when the client reported it could NOT enforce the per-call
   * cap mid-stream (the adapter surface's `capIgnored` marker) — enforcement
   * fell entirely to the controller's post-hoc guard. `false` = the client
   * either enforced mid-stream (streaming surface) or the call never reached a
   * client transport. The flag is OBSERVABILITY ONLY: it never loosens a cap
   * and never implies the client enforced anything.
   */
  readonly capIgnoredByClient: boolean;
  readonly incurredCostMicros: number | undefined;
  readonly amountRefundedMicros: number | undefined;
  readonly reward: number | undefined;
  readonly rewardSources: Readonly<Record<string, number>> | undefined;
  readonly verificationStatus: 'passed' | 'failed' | 'unknown' | 'absent';
  /** Whether the scored verification carried TRUSTED provenance. */
  readonly verificationTrusted: boolean;
  readonly tools: {
    readonly requested: readonly string[];
    readonly allowed: readonly string[];
    readonly denied: readonly string[];
    readonly executed: readonly string[];
  };
}

/** Live metering evidence from the assembled ledger (enforcement provenance). */
export interface CanaryMeteringEvidence {
  readonly mode: 'observe' | 'enforce';
  readonly reserveAttempts: number;
  readonly reserveGranted: number;
  readonly settleCount: number;
}

export interface RealBenefitCanaryResult {
  /** The verdict — only ever one of the five honest states. */
  readonly verdict: RealBenefitVerdict;
  /** Binding status at evaluation time (machine-readable, §7 four rows). */
  readonly binding: RealBenefitBindingEvaluation;
  /** When the binding is incomplete: the exact missing reasons. */
  readonly missingItems: readonly string[];
  /** When no call was made / the run aborted: the named trigger. */
  readonly abortTrigger: string | undefined;
  /** Per-arm call records with raw usage and cost provenance. */
  readonly calls: readonly CanaryCallRecord[];
  /** RewardContract numbers: baseline and treatment observedReturn. */
  readonly reward: {
    readonly contractVersion: string;
    readonly aggregation: string;
    readonly baseline: number | undefined;
    readonly treatment: number | undefined;
    readonly delta: number | undefined;
    /** `trusted` only when BOTH arms' verdicts carry trusted provenance. */
    readonly verificationBasis: 'trusted' | 'untrusted' | 'absent';
  };
  /** Ledger/budget state after the run, derived from per-call settlements. */
  readonly budget: {
    readonly generalRemainingMicros: number | undefined;
    /** Booked spend (final settlements only). */
    readonly settledMicros: number | undefined;
    /** Ring-fenced spend held by interim settlements (unconfirmed remote). */
    readonly heldMicros: number | undefined;
    readonly rateCardDigest: string;
  };
  /**
   * T4: the token hard budget state after the run. `measured*` counters are
   * summed over MEASURED usage only (an unreported usage contributes nothing
   * — never a zero); a run where the host reported no usage keeps the caps
   * but shows `allUsageMeasured:false`, so a cap pass is never claimed on
   * unmeasured spend.
   */
  readonly tokenBudget: {
    readonly caps: RealBenefitTokenCaps;
    readonly measuredTotalTokens: number;
    readonly measuredBaselineTokens: number;
    readonly measuredTreatmentTokens: number;
    readonly allUsageMeasured: boolean;
    /**
     * T4 (t4-fix semantics): true only when the run's per-call cap rode every
     * call to the client (`call({perCallTokenCap})` — wiring by construction)
     * AND the run used a VERIFIED client. The report never claims a
     * client-level kill switch it did not wire.
     */
    readonly perCallCapEnforcedByClient: boolean;
    /**
     * t4-fix: executions of the controller's own post-hoc per-call guard
     * (adapter surfaces cannot hook the stream; the guard judges every
     * settled call's measured gross against the per-call cap).
     */
    readonly postHocPerCallChecks: number;
    /**
     * t4-fix: executions of the ABSOLUTE-total pre-check (the accumulated
     * measured gross plus a full arm judged against the user-authorized 800M
     * ceiling before a reservation).
     */
    readonly absoluteTotalPrechecks: number;
  };
  /** Ledger metering evidence (mode must be 'enforce' for a hard-bound run). */
  readonly metering: CanaryMeteringEvidence | undefined;
  /** Tool-face counters (allowlist evidence: checks/allowed/denied/noPolicy). */
  readonly toolFace: {
    readonly checks: number;
    readonly allowed: number;
    readonly denied: number;
    readonly noPolicy: number;
  };
  /** Authorization ledger counters (grant evidence). */
  readonly authorization: Pick<ProbeAuthorizationCounters, 'grants' | 'checks' | 'allowed' | 'denied'> | undefined;
  /** The canary's identity (branch), when attributed. */
  readonly identity: { readonly branchId: string; readonly sessionId: string | undefined } | undefined;
  /** Honest boundaries, always present. */
  readonly boundaries: readonly string[];
}

/** A verification receipt the OPERATOR supplies (never controller-invented). */
export type OperatorVerificationReceipt = TrustedVerification;

export interface RealBenefitCanaryInput {
  /** A COMPLETE binding (validate first; an incomplete binding never reaches here). */
  readonly binding: RealBenefitBinding;
  /** The canary's probe-branch identity. A missing branchId aborts. */
  readonly identity: { readonly branchId: string; readonly sessionId?: string };
  /**
   * T4: the REAL host client bound by the runner (./real-benefit-host-client.ts
   * or an operator-supplied equivalent). REQUIRED at the run gate: a run with
   * no bound client aborts with `host-client-unbound` before any ledger
   * exists — fail-closed, never simulated. Its DESENSITIZED identity is
   * verified against the binding (account/model/route) before any call, and
   * the token caps ride the client (per-call kill switch) plus this
   * controller (per-arm/per-task/total accounting). Optional in the type so
   * legacy callers compile; the run gate refuses its absence.
   */
  readonly hostClient?: RealBenefitHostClient;
  /**
   * @deprecated t4: the ad-hoc `callModel` seam is replaced by `hostClient`.
   * When `hostClient` is absent this seam may still be supplied by legacy
   * callers/tests, but it can no longer pass the binding gate (the binding
   * requires a verified host client), so production paths must migrate.
   */
  readonly callModel?: (input: {
    readonly arm: 'baseline' | 'treatment';
    readonly callId: string;
    readonly prompt: string;
    readonly branchId: string;
  }) => Promise<{
    readonly text: string;
    readonly usage: RawCanaryUsage | undefined;
    readonly verification?: OperatorVerificationReceipt;
  }>;
  /**
   * The tool execution seam. Only called for allowlisted tools; when omitted,
   * any tool request aborts the canary (fail-closed) instead of guessing.
   */
  readonly executeTool?: (input: {
    readonly toolName: string;
    readonly toolArguments: string;
    readonly branchId: string;
  }) => Promise<{ readonly ok: boolean; readonly result?: unknown; readonly error?: string }>;
  /**
   * The provider/host counting semantics for the usage payload. Omitted means
   * the usage stays `unknown`-provenance — never relabelled measured.
   */
  readonly countingSemantics?: {
    readonly inputIncludesCacheRead: boolean;
    readonly outputIncludesReasoning: boolean;
    readonly semanticTag?: string;
  };
  /**
   * The OPERATOR's trusted-producer set for verification receipts. Omitted (or
   * empty) keeps the production structural-empty registry: every verdict is
   * untrusted and the benefit verdict can only be `insufficient`. This is the
   * same injectable seam `scoreTrajectorySignals` documents for research
   * callers; the controller adds no registrar of its own.
   */
  readonly trustedProducers?: ReadonlySet<string>;
  /** Injectable clock for the authorization ledger TTLs (tests only). */
  readonly now?: () => number;
}

const CANARY_PROMPT_BASE = [
  'You are executing one minimal canary task for a measured benefit evaluation.',
  'Reply with the shortest correct answer and no preamble.'
];

/** Tool-call JSON shape the canary accepts from a model response. */
interface CanaryToolRequest {
  readonly tool: string;
  readonly arguments?: string;
}

function parseToolRequest(text: string): CanaryToolRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const tool = record['tool'];
    if (typeof tool !== 'string' || tool.trim().length === 0) return undefined;
    return {
      tool,
      ...(typeof record['arguments'] === 'string' ? { arguments: record['arguments'] } : {})
    };
  } catch {
    return undefined;
  }
}

/**
 * The named abort triggers (B-4). Each maps to an immediate, non-retried stop.
 * The t4 token triggers: `token-cap-exceeded` (a settled call's measured gross
 * exceeded a nested cap or the total), `host-client-unbound` (no real client —
 * fail-closed, never simulated), `host-client-identity-mismatch` (the bound
 * client is not the authorized account/model/route).
 */
export type CanaryAbortTrigger =
  | 'identity-missing'
  | 'noPolicy'
  | 'unauthorized-tool'
  | 'budget-exhausted'
  | 'authorization-denied'
  | 'tool-executor-unavailable'
  | 'token-cap-exceeded'
  | 'host-client-unbound'
  | 'host-client-identity-mismatch';

export const ABORT_CAUSE: Readonly<Record<CanaryAbortTrigger, string>> = Object.freeze({
  'identity-missing': 'the canary identity has no branchId; an unattributable call is never made',
  'noPolicy': 'a tool request hit the tool face with no installed branch policy',
  'unauthorized-tool': 'a tool request was not on the read-only allowlist',
  'budget-exhausted': 'the hard budget refused the admission or the reservation; the canary never retries or grows',
  'authorization-denied': 'the probe authorization ledger denied the paid-model-call grant',
  'tool-executor-unavailable': 'the model requested a tool but no executor was supplied; refusing to guess',
  'token-cap-exceeded': 'measured gross tokens crossed the per-call/per-arm/per-task or total token cap; the run never buys more tokens',
  'host-client-unbound': 'no real host client is bound; the canary refuses to fabricate a response (fail-closed)',
  'host-client-identity-mismatch': 'the bound host client is not the authorized account/model/route (desensitized verification failed)'
});

// ---------------------------------------------------------------------------
// Trajectory + payload builders (pure)
// ---------------------------------------------------------------------------

function buildTrajectory(input: {
  readonly callId: string;
  readonly branchId: string;
  readonly sessionId: string | undefined;
  readonly status: TrajectoryStatus;
  readonly text: string;
  readonly toolCalls: number;
  readonly toolErrors: readonly { readonly toolName: string; readonly message: string }[];
  readonly startedAt: number;
  readonly verification: TrustedVerification | undefined;
}): ProbeTrajectory {
  const metadata: ContractMetadata =
    input.verification === undefined ? {} : { verification: input.verification };
  return {
    id: input.callId,
    sessionId: input.sessionId ?? 'r3a-canary-session',
    branchId: input.branchId,
    branchNamespace: 'r3a-canary',
    role: 'candidate',
    status: input.status,
    patchId: 'r3a-canary-patch',
    patchOrigin: 'reference',
    surfaceKeys: ['scripts', 'system_prompt'],
    startedAt: input.startedAt,
    endedAt: input.startedAt + 1,
    metrics: {
      steps: 1 + (input.toolCalls > 0 ? 1 : 0),
      toolCalls: input.toolCalls,
      toolErrors: input.toolErrors.length,
      durationMs: 1
    },
    steps: [
      {
        index: 0,
        at: input.startedAt,
        kind: 'model',
        text: input.text
      }
    ],
    toolErrors: input.toolErrors.map((error) => ({ ...error })),
    deliverable:
      input.status === 'succeeded' && input.text.length > 0
        ? { content: input.text, format: 'text' }
        : undefined,
    failureSignals: input.status === 'succeeded' ? [] : [{ kind: 'unknown', message: 'canary arm did not complete' }],
    memoryRecallIds: [],
    metadata
  };
}

function usageRawOf(usage: RawCanaryUsage | undefined): RawCanaryUsage {
  return {
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {})
  };
}

/**
 * Build the ProviderUsagePayload with measured-where-reported precision and
 * the caller-declared counting semantics. No semantics → the payload carries
 * none, so the production settle path treats the provenance as unknown and
 * applies the conservative floor — the controller never upgrades it.
 */
function usagePayloadOf(
  usage: RawCanaryUsage | undefined,
  semantics: RealBenefitCanaryInput['countingSemantics']
): ProviderUsagePayload {
  const reported = (value: number | undefined): { tokens: number; precision: 'measured' | 'unknown' } => ({
    tokens: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0,
    precision: value !== undefined ? 'measured' : 'unknown'
  });
  return {
    inputTokens: reported(usage?.inputTokens),
    outputTokens: reported(usage?.outputTokens),
    ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: reported(usage.cacheReadTokens) } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: reported(usage.cacheWriteTokens) } : {}),
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: reported(usage.reasoningTokens) } : {}),
    ...(semantics === undefined ? {} : { countingSemantics: semantics }),
    unreportedMetrics: (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const).filter(
      (name) => usage?.[name] === undefined
    )
  };
}

/** The not-admitted record: no call, no usage, no reward — only the reason. */
function notAdmittedRecord(
  arm: 'baseline' | 'treatment',
  callId: string,
  taskId: string,
  rejectedBecause: string,
  trigger: CanaryAbortTrigger
): ArmRunOutcome {
  return {
    abort: trigger,
    trajectory: undefined,
    record: {
      arm,
      callId,
      admitted: false,
      admissionBasis: undefined,
      reserveMicros: 0,
      rejectedBecause,
      outcome: 'not-called',
      settlementPhase: 'none',
      usageRaw: {},
      measuredTokens: undefined,
      abortedByTokenCap: false,
      tokenCapAbortOrigin: undefined,
      capIgnoredByClient: false,
      cacheReadSample: observeCacheUsage({
        callId,
        taskId,
        arm,
        purpose: 'real-benefit-canary',
        rawUsage: undefined,
        semantics: undefined
      }),
      incurredCostMicros: undefined,
      amountRefundedMicros: undefined,
      reward: undefined,
      rewardSources: undefined,
      verificationStatus: 'absent',
      verificationTrusted: false,
      tools: { requested: [], allowed: [], denied: [], executed: [] }
    }
  };
}

/**
 * Mid-arm abort record: the reservation was granted, so the settlement already
 * happened (interim for an unconfirmed remote — money stays ring-fenced).
 */
function settledAbortedRecord(
  arm: 'baseline' | 'treatment',
  callId: string,
  taskId: string,
  admissionBasis: string,
  reserveMicros: number,
  settle: { readonly incurredCostMicros: number; readonly amountRefundedMicros: number },
  usage: RawCanaryUsage | undefined,
  semantics: RealBenefitCanaryInput['countingSemantics'],
  tools: CanaryCallRecord['tools'],
  abort: CanaryAbortTrigger
): ArmRunOutcome {
  return {
    abort,
    trajectory: undefined,
    record: {
      arm,
      callId,
      admitted: true,
      admissionBasis,
      reserveMicros,
      rejectedBecause: undefined,
      outcome: 'aborted_local',
      settlementPhase: 'interim',
      usageRaw: usageRawOf(usage),
      measuredTokens: canaryUsageTokenCount(usage),
      abortedByTokenCap: abort === 'token-cap-exceeded',
      // t14: the origin is refined by the caller when it knows which surface
      // enforced the cap (the default here is the transport-agnostic shape);
      // a non-token abort keeps both observability fields neutral.
      tokenCapAbortOrigin: abort === 'token-cap-exceeded' ? 'controller-post-hoc' : undefined,
      capIgnoredByClient: false,
      cacheReadSample: observeCacheUsage({
        callId,
        taskId,
        arm,
        purpose: 'real-benefit-canary',
        rawUsage: usage,
        semantics
      }),
      incurredCostMicros: settle.incurredCostMicros,
      amountRefundedMicros: settle.amountRefundedMicros,
      reward: undefined,
      rewardSources: undefined,
      verificationStatus: 'absent',
      verificationTrusted: false,
      tools
    }
  };
}

interface ArmRunOutcome {
  readonly record: CanaryCallRecord;
  readonly trajectory: ProbeTrajectory | undefined;
  readonly abort: CanaryAbortTrigger | undefined;
}

/**
 * Run ONE arm of the canary through the sanctioned two-phase lifecycle. Every
 * refusal path returns a record with `admitted:false` (or an interim settle)
 * and the NAMED trigger; nothing retries and nothing grows.
 */
async function runArm(
  input: RealBenefitCanaryInput,
  settlement: TwoPhaseSettlement,
  toolFace: ReturnType<typeof createToolFaceRegistry>,
  authorization: ReturnType<typeof createProbeAuthorizationLedger>,
  arm: 'baseline' | 'treatment',
  sequence: number
): Promise<ArmRunOutcome> {
  const { binding, identity, hostClient } = input;
  const taskId = binding.taskId;
  const callId = 'r3a-' + arm + '-' + String(sequence);
  const semantics = input.countingSemantics;

  // ---- identity (B-4) -----------------------------------------------------
  if (!isNonEmptyString(identity.branchId)) {
    return notAdmittedRecord(arm, callId, taskId, 'identity-missing', 'identity-missing');
  }

  // ---- authorization ledger (the explicit grant, ADR 0006 D-P4-5) ---------
  authorization.grant({
    kind: 'paid-model-call',
    grantedBy: binding.authorization.grantedBy,
    reason: binding.authorization.reason,
    branchId: identity.branchId
  });
  const authorizationDecision = authorization.authorize({ kind: 'paid-model-call', branchId: identity.branchId });
  if (!authorizationDecision.allowed) {
    return notAdmittedRecord(arm, callId, taskId, 'authorization-denied:' + authorizationDecision.code, 'authorization-denied');
  }

  // ---- admission through the production rule (B-2) ------------------------
  const policy: AdmissionPolicy = { mode: 'hard', allowUnboundedRiskOverride: false };
  const admission = decideAdmission({
    policy,
    route: binding.route,
    rateCard: binding.rateCard,
    estimatedCostMicros: 0
  });
  if (!admission.admitted) {
    return notAdmittedRecord(arm, callId, taskId, admission.reason, 'budget-exhausted');
  }
  if (admission.basis !== 'provable-hard-bound') {
    // Structurally unreachable (the policy has no override); the guard keeps
    // the invariant explicit and testable.
    return notAdmittedRecord(arm, callId, taskId, 'admission-basis-not-provable', 'budget-exhausted');
  }

  // ---- reserve: the PHYSICAL CEILING is ring-fenced, not an estimate ------
  const reserve = settlement.beginCall({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: admission.reserveMicros,
    requiresSeat: true,
    routeId: binding.route.routeId,
    rateCard: binding.rateCard,
    sessionId: identity.sessionId,
    pricingIdentity: {
      protocolVersion: 'dsh-bridge-v1',
      modelId: binding.rateCard.modelId,
      rateCardVersion: 'r3a-binding-v1',
      rateCardDigest: rateCardDigest(binding.rateCard)
    },
    consumer: 'real-benefit-controller'
  });
  if (!reserve.granted) {
    return notAdmittedRecord(arm, callId, taskId, String(reserve.rejectionReason ?? 'reserve-denied'), 'budget-exhausted');
  }

  // ---- the real model call ------------------------------------------------
  const prompt =
    arm === 'treatment'
      ? [...CANARY_PROMPT_BASE, 'Recorded advice you should apply:', binding.recordedAdvice].join('\n')
      : CANARY_PROMPT_BASE.join('\n');
  interface DialOutcome {
    readonly text: string;
    readonly usage: RawCanaryUsage | undefined;
    readonly measuredTokens: number | undefined;
    readonly abortedByTokenCap: boolean;
    /** t14: the client could not enforce the cap mid-stream (adapter surface). */
    readonly capIgnored: boolean;
    readonly verification?: OperatorVerificationReceipt;
  }
  let response: DialOutcome;
  if (hostClient !== undefined) {
    // T4: dial through the verified real host client. The client is the ONLY
    // transport; there is no mock/simulated fallback on any path. The binding's
    // per-call cap rides EVERY call (t4-fix): the streaming surface enforces it
    // mid-stream (kill switch wired by construction), the adapter surface
    // reports `capIgnored` and this controller's post-hoc guard below covers it.
    // t14: `capIgnored` rides the outcome into the call record so the report
    // shows WHERE per-call enforcement happened (client mid-stream vs
    // controller post-hoc) without implying the adapter enforced anything.
    const outcome: HostClientCallOutcome | { transportFailed: true; settle: TwoPhaseSettleOutcome } =
      await hostClient
        .call({ prompt, perCallTokenCap: binding.tokenBudget.perCallTokens })
        .catch((error: unknown) => {
          // Transport failure with no usage: settle at the reserved ceiling
          // (conservative). A failed transport is a confirmed outcome (nothing
          // more will be generated for this callId), so the settlement is final.
          const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'failed' });
          return { transportFailed: true as const, settle };
        });
    if ('transportFailed' in outcome) {
      return {
        abort: undefined,
        trajectory: undefined,
        record: {
          arm,
          callId,
          admitted: true,
          admissionBasis: admission.basis,
          reserveMicros: reserve.reservedCostMicros,
          rejectedBecause: undefined,
          outcome: 'failed',
          settlementPhase: outcome.settle.settlement,
          usageRaw: {},
          measuredTokens: undefined,
          abortedByTokenCap: false,
          tokenCapAbortOrigin: undefined,
          capIgnoredByClient: false, // the transport failed before any cap semantics existed
          cacheReadSample: observeCacheUsage({ callId, taskId, arm, purpose: 'real-benefit-canary', rawUsage: undefined, semantics: undefined }),
          incurredCostMicros: outcome.settle.result.incurredCostMicros,
          amountRefundedMicros: outcome.settle.result.amountRefundedMicros,
          reward: undefined,
          rewardSources: undefined,
          verificationStatus: 'absent',
          verificationTrusted: false,
          tools: { requested: [], allowed: [], denied: [], executed: [] }
        }
      };
    }
    // Operator verification receipts ride ONLY the legacy seam; the host
    // client transport carries none (trust stays structural unless the
    // operator supplies receipts through the documented seam).
    response = {
      text: outcome.text,
      usage: outcome.usage,
      measuredTokens: outcome.measuredTokens,
      abortedByTokenCap: outcome.abortedByTokenCap,
      capIgnored: outcome.capIgnored === true
    };
  } else if (input.callModel !== undefined) {
    // Legacy seam (deprecated): kept for test harnesses; production paths go
    // through the verified host client above.
    let legacy:
      | { readonly text: string; readonly usage: RawCanaryUsage | undefined; readonly verification?: OperatorVerificationReceipt }
      | undefined;
    try {
      legacy = await input.callModel({ arm, callId, prompt, branchId: identity.branchId });
    } catch {
      legacy = undefined;
    }
    if (legacy === undefined) {
      // Transport failure with no usage: settle at the reserved ceiling
      // (conservative). A failed transport is a confirmed outcome (nothing
      // more will be generated for this callId), so the settlement is final.
      const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'failed' });
      return {
        abort: undefined,
        trajectory: undefined,
        record: {
          arm,
          callId,
          admitted: true,
          admissionBasis: admission.basis,
          reserveMicros: reserve.reservedCostMicros,
          rejectedBecause: undefined,
          outcome: 'failed',
          settlementPhase: settle.settlement,
          usageRaw: {},
          measuredTokens: undefined,
          abortedByTokenCap: false,
          tokenCapAbortOrigin: undefined,
          capIgnoredByClient: false,
          cacheReadSample: observeCacheUsage({ callId, taskId, arm, purpose: 'real-benefit-canary', rawUsage: undefined, semantics: undefined }),
          incurredCostMicros: settle.result.incurredCostMicros,
          amountRefundedMicros: settle.result.amountRefundedMicros,
          reward: undefined,
          rewardSources: undefined,
          verificationStatus: 'absent',
          verificationTrusted: false,
          tools: { requested: [], allowed: [], denied: [], executed: [] }
        }
      };
    }
    response = {
      text: legacy.text,
      usage: legacy.usage,
      measuredTokens: canaryUsageTokenCount(legacy.usage),
      abortedByTokenCap: false,
      capIgnored: false, // the legacy seam carries no client cap semantics at all
      ...(legacy.verification === undefined ? {} : { verification: legacy.verification })
    };
  } else {
    // No host client and no legacy seam: fail closed BEFORE any more of the
    // reservation is spent. The reservation settles failed (confirmed: the
    // run is not going to dial anything); the verdict can only be blocked.
    const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'failed' });
    return {
      abort: 'host-client-unbound',
      trajectory: undefined,
      record: {
        arm,
        callId,
        admitted: true,
        admissionBasis: admission.basis,
        reserveMicros: reserve.reservedCostMicros,
        rejectedBecause: undefined,
        outcome: 'failed',
        settlementPhase: settle.settlement,
        usageRaw: {},
        measuredTokens: undefined,
        abortedByTokenCap: false,
        tokenCapAbortOrigin: undefined,
        capIgnoredByClient: false,
        cacheReadSample: observeCacheUsage({ callId, taskId, arm, purpose: 'real-benefit-canary', rawUsage: undefined, semantics: undefined }),
        incurredCostMicros: settle.result.incurredCostMicros,
        amountRefundedMicros: settle.result.amountRefundedMicros,
        reward: undefined,
        rewardSources: undefined,
        verificationStatus: 'absent',
        verificationTrusted: false,
        tools: { requested: [], allowed: [], denied: [], executed: [] }
      }
    };
  }
  const measuredThisCall = response.measuredTokens ?? canaryUsageTokenCount(response.usage);
  // t14: WHERE per-call enforcement happened for THIS call, derived from the
  // transport's own markers — never guessed: a transport failure, the legacy
  // seam, or an un-aborted call yields undefined/false.
  const capIgnoredByClient = response.capIgnored;
  const tokenCapAbortOrigin: CanaryCallRecord['tokenCapAbortOrigin'] = response.abortedByTokenCap
    ? 'client-mid-stream'
    : undefined;

  // ---- token hard budget: per-call + per-arm enforcement (t4) -------------
  // The per-call cap is judged on the MEASURED gross of THIS call. An exceed
  // settles the reservation (confirmed local abort) and aborts the whole run:
  // no retry, no second chance to buy tokens. The client's own mid-stream
  // kill switch is the first line; this post-hoc check also covers the
  // adapter-path clients that cannot hook the stream. (t14: a post-hoc
  // exceed flips the record's abort origin to 'controller-post-hoc'.)
  const perCallCap = binding.tokenBudget.perCallTokens;
  if (measuredThisCall !== undefined && measuredThisCall > perCallCap) {
    const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'aborted_local' });
    const outcomeRecord = settledAbortedRecord(
      arm, callId, taskId, admission.basis, reserve.reservedCostMicros,
      { incurredCostMicros: settle.result.incurredCostMicros, amountRefundedMicros: settle.result.amountRefundedMicros },
      response.usage, semantics,
      { requested: [], allowed: [], denied: [], executed: [] },
      'token-cap-exceeded'
    );
    return {
      ...outcomeRecord,
      record: { ...outcomeRecord.record, tokenCapAbortOrigin: 'controller-post-hoc', capIgnoredByClient }
    };
  }
  if (response.abortedByTokenCap) {
    // The client killed the stream at the per-call cap: the outcome is an
    // aborted measurement, never a scored deliverable.
    const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'aborted_local' });
    const outcomeRecord = settledAbortedRecord(
      arm, callId, taskId, admission.basis, reserve.reservedCostMicros,
      { incurredCostMicros: settle.result.incurredCostMicros, amountRefundedMicros: settle.result.amountRefundedMicros },
      response.usage, semantics,
      { requested: [], allowed: [], denied: [], executed: [] },
      'token-cap-exceeded'
    );
    return {
      ...outcomeRecord,
      record: { ...outcomeRecord.record, tokenCapAbortOrigin: 'client-mid-stream', capIgnoredByClient }
    };
  }
  const armGrossSoFar = arm === 'baseline'
    ? measuredThisCall ?? 0
    : undefined; // filled by the caller-level accounting below
  void armGrossSoFar;

  // ---- tool handling under the read-only allowlist (B-3) ------------------
  const toolsRequested: string[] = [];
  const toolsAllowed: string[] = [];
  const toolsDenied: string[] = [];
  const toolsExecuted: string[] = [];
  const toolRequest = parseToolRequest(response.text);
  if (toolRequest !== undefined) {
    toolsRequested.push(toolRequest.tool);
    const decision = toolFace.decide({ toolName: toolRequest.tool, branchId: identity.branchId });
    if (decision.code === 'no-policy') {
      // An unconfirmed remote termination settles interim: the money stays
      // ring-fenced instead of being booked as spent.
      const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'aborted_local' });
      return settledAbortedRecord(
        arm, callId, taskId, admission.basis, reserve.reservedCostMicros,
        { incurredCostMicros: settle.result.incurredCostMicros, amountRefundedMicros: settle.result.amountRefundedMicros },
        response.usage, semantics,
        { requested: toolsRequested, allowed: toolsAllowed, denied: toolsDenied, executed: toolsExecuted },
        'noPolicy'
      );
    }
    if (!decision.allowed) {
      toolsDenied.push(toolRequest.tool);
      const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'aborted_local' });
      return settledAbortedRecord(
        arm, callId, taskId, admission.basis, reserve.reservedCostMicros,
        { incurredCostMicros: settle.result.incurredCostMicros, amountRefundedMicros: settle.result.amountRefundedMicros },
        response.usage, semantics,
        { requested: toolsRequested, allowed: toolsAllowed, denied: toolsDenied, executed: toolsExecuted },
        'unauthorized-tool'
      );
    }
    if (input.executeTool === undefined) {
      const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'aborted_local' });
      return settledAbortedRecord(
        arm, callId, taskId, admission.basis, reserve.reservedCostMicros,
        { incurredCostMicros: settle.result.incurredCostMicros, amountRefundedMicros: settle.result.amountRefundedMicros },
        response.usage, semantics,
        { requested: toolsRequested, allowed: toolsAllowed, denied: toolsDenied, executed: toolsExecuted },
        'tool-executor-unavailable'
      );
    }
    toolsAllowed.push(toolRequest.tool);
    const execution = await input.executeTool({
      toolName: toolRequest.tool,
      toolArguments: toolRequest.arguments ?? '{}',
      branchId: identity.branchId
    });
    if (!execution.ok) {
      // A tool error is a real measured outcome: record it as a tool error so
      // the RewardContract's tool source sees it (never silently swallowed).
      const settle = settlement.settleCall({
        callId,
        reservationId: String(reserve.reservationId),
        outcome: 'failed',
        usage: usagePayloadOf(response.usage, semantics)
      });
      const trajectory = buildTrajectory({
        callId,
        branchId: identity.branchId,
        sessionId: identity.sessionId,
        status: 'failed',
        text: response.text,
        toolCalls: 1,
        toolErrors: [{ toolName: toolRequest.tool, message: execution.error ?? 'tool failed' }],
        startedAt: Date.now(),
        verification: undefined
      });
      return {
        abort: undefined,
        trajectory,
        record: {
          arm,
          callId,
          admitted: true,
          admissionBasis: admission.basis,
          reserveMicros: reserve.reservedCostMicros,
          rejectedBecause: undefined,
          outcome: 'failed',
          settlementPhase: settle.settlement,
          usageRaw: usageRawOf(response.usage),
          measuredTokens: measuredThisCall,
          abortedByTokenCap: response.abortedByTokenCap,
          tokenCapAbortOrigin,
          capIgnoredByClient,
          cacheReadSample: observeCacheUsage({ callId, taskId, arm, purpose: 'real-benefit-canary', rawUsage: response.usage, semantics }),
          incurredCostMicros: settle.result.incurredCostMicros,
          amountRefundedMicros: settle.result.amountRefundedMicros,
          reward: undefined,
          rewardSources: undefined,
          verificationStatus: 'absent',
          verificationTrusted: false,
          tools: { requested: toolsRequested, allowed: toolsAllowed, denied: toolsDenied, executed: toolsExecuted }
        }
      };
    }
    toolsExecuted.push(toolRequest.tool);
  }

  // ---- settle with the RAW usage (precision never upgraded) ---------------
  const usagePayload = usagePayloadOf(response.usage, semantics);
  const outcome: TrajectoryStatus = 'succeeded';
  const settle = settlement.settleCall({
    callId,
    reservationId: String(reserve.reservationId),
    outcome,
    usage: usagePayload,
    releaseSeat: true
  });

  // Attach ONLY an operator receipt that passes the production shape check;
  // everything else scores through the structural fallback (C2-pre).
  const receipt: TrustedVerification | undefined =
    response.verification !== undefined && isTrustedVerification(response.verification)
      ? response.verification
      : undefined;
  const trajectory = buildTrajectory({
    callId,
    branchId: identity.branchId,
    sessionId: identity.sessionId,
    status: outcome,
    text: response.text,
    toolCalls: toolsExecuted.length,
    toolErrors: [],
    startedAt: Date.now(),
    verification: receipt
  });
  const scored = scoreUnderRewardContract(trajectory, {
    ...(input.trustedProducers === undefined ? {} : { trustedProducers: input.trustedProducers })
  });

  return {
    abort: undefined,
    trajectory,
    record: {
      arm,
      callId,
      admitted: true,
      admissionBasis: admission.basis,
      reserveMicros: reserve.reservedCostMicros,
      rejectedBecause: undefined,
      outcome,
      settlementPhase: settle.settlement,
      usageRaw: usageRawOf(response.usage),
      measuredTokens: measuredThisCall,
      abortedByTokenCap: response.abortedByTokenCap,
      tokenCapAbortOrigin,
      capIgnoredByClient,
      cacheReadSample: observeCacheUsage({
        callId,
        taskId,
        arm,
        purpose: 'real-benefit-canary',
        rawUsage: response.usage,
        semantics
      }),
      incurredCostMicros: settle.result.incurredCostMicros,
      amountRefundedMicros: settle.result.amountRefundedMicros,
      reward: scored.reward,
      rewardSources: scored.sources,
      verificationStatus: scored.verification.status,
      verificationTrusted: scored.verification.trustedSource,
      tools: { requested: toolsRequested, allowed: toolsAllowed, denied: toolsDenied, executed: toolsExecuted }
    }
  };
}

// ---------------------------------------------------------------------------
// The canary driver
// ---------------------------------------------------------------------------

function assembleResult(input: {
  readonly bindingEvaluation: RealBenefitBindingEvaluation;
  readonly calls: readonly CanaryCallRecord[];
  readonly abortTrigger: string | undefined;
  readonly verdict: RealBenefitVerdict;
  readonly assembly: LedgerAssembly | undefined;
  readonly generalBudgetMicros: number;
  readonly toolFaceCounters: ToolFaceCounters | undefined;
  readonly authorizationCounters: ProbeAuthorizationCounters | undefined;
  readonly identity: { readonly branchId: string; readonly sessionId?: string } | undefined;
  readonly binding: RealBenefitBinding;
  readonly verificationBasis: 'trusted' | 'untrusted' | 'absent';
  /** True when a real host client was bound AND passed the identity check. */
  readonly hostClientVerified: boolean;
  /** t4-fix: post-hoc per-call cap guard executions (controller-side). */
  readonly postHocPerCallChecks: number;
  /** t4-fix: absolute-total pre-check executions before arm reservations. */
  readonly absoluteTotalPrechecks: number;
}): RealBenefitCanaryResult {
  const baseline = input.calls.find((call) => call.arm === 'baseline');
  const treatment = input.calls.find((call) => call.arm === 'treatment');
  const bothScored = baseline?.reward !== undefined && treatment?.reward !== undefined;
  // Budget facts derived from the per-call settlements: booked spend is the
  // sum over FINAL settlements; interim settlements keep the FULL reservation
  // ring-fenced. Remaining never hides a hold.
  let settledMicros = 0;
  let heldMicros = 0;
  for (const call of input.calls) {
    if (call.settlementPhase === 'final') {
      settledMicros += call.incurredCostMicros ?? 0;
    } else if (call.settlementPhase === 'interim') {
      heldMicros += call.reserveMicros;
    }
  }
  const remaining = Math.max(0, input.generalBudgetMicros - settledMicros - heldMicros);
  const metering = input.assembly === undefined ? undefined : input.assembly.meteringStatus();
  // T4: token accounting over MEASURED usage only. A call whose host reported
  // no usage contributes nothing to the counters and marks allUsageMeasured
  // false — the caps stay honest instead of pretending unmeasured spend away.
  let measuredTotalTokens = 0;
  let measuredBaselineTokens = 0;
  let measuredTreatmentTokens = 0;
  let allUsageMeasured = true;
  for (const call of input.calls) {
    if (call.outcome === 'not-called') continue;
    if (call.measuredTokens === undefined) {
      allUsageMeasured = false;
      continue;
    }
    measuredTotalTokens += call.measuredTokens;
    if (call.arm === 'baseline') measuredBaselineTokens += call.measuredTokens;
    else measuredTreatmentTokens += call.measuredTokens;
  }
  const tokenBudgetReport = {
    caps: { ...input.binding.tokenBudget },
    measuredTotalTokens,
    measuredBaselineTokens,
    measuredTreatmentTokens,
    allUsageMeasured,
    perCallCapEnforcedByClient: input.hostClientVerified,
    postHocPerCallChecks: input.postHocPerCallChecks,
    absoluteTotalPrechecks: input.absoluteTotalPrechecks
  };
  return {
    verdict: input.verdict,
    binding: input.bindingEvaluation,
    missingItems: input.bindingEvaluation.missing,
    abortTrigger: input.abortTrigger,
    calls: [...input.calls],
    reward: {
      contractVersion: 'r4/verifier-first-v1',
      aggregation: 'trajectory-signals-v1',
      baseline: baseline?.reward,
      treatment: treatment?.reward,
      delta: bothScored ? (treatment?.reward ?? 0) - (baseline?.reward ?? 0) : undefined,
      verificationBasis: input.verificationBasis
    },
    budget: {
      generalRemainingMicros: input.assembly === undefined ? undefined : currencyMicros(remaining),
      settledMicros: input.assembly === undefined ? undefined : currencyMicros(settledMicros),
      heldMicros: input.assembly === undefined ? undefined : currencyMicros(heldMicros),
      rateCardDigest: rateCardDigest(input.binding.rateCard)
    },
    tokenBudget: tokenBudgetReport,
    metering:
      metering === undefined
        ? undefined
        : {
            mode: metering.mode,
            reserveAttempts: metering.reserveAttempts,
            reserveGranted: metering.reserveGranted,
            settleCount: metering.settleCount
          },
    toolFace: {
      checks: input.toolFaceCounters?.checks ?? 0,
      allowed: input.toolFaceCounters?.allowed ?? 0,
      denied: (input.toolFaceCounters?.deniedNotAllowlisted ?? 0) + (input.toolFaceCounters?.deniedExplicit ?? 0),
      noPolicy: input.toolFaceCounters?.noPolicy ?? 0
    },
    authorization:
      input.authorizationCounters === undefined
        ? undefined
        : {
            grants: input.authorizationCounters.grants,
            checks: input.authorizationCounters.checks,
            allowed: input.authorizationCounters.allowed,
            denied: input.authorizationCounters.denied
          },
    identity:
      input.identity === undefined
        ? undefined
        : {
            branchId: input.identity.branchId,
            sessionId: input.identity.sessionId
          },
    boundaries: Object.freeze([
      'no real memory write, no guarded-active, no publish (the controller has no such code path)',
      'the task set is exactly one canary task; it cannot grow inside this run',
      'the hard budget is enforced through the production admission rule; an unprovable route is refused',
      'an aborted run never reports a benefit; aborts are control facts, not measurements',
      'estimated/unknown cost or cacheRead provenance is never relabelled measured',
      'the token hard budget counts MEASURED usage only; an unreported usage is never recorded as zero',
      'a run without a verified real host client is refused before any call (fail-closed, never simulated)',
      'the user-authorized token ceiling is ABSOLUTE (t4-fix): the per-call cap rides every client call, the accumulated measured gross plus a full arm is pre-checked against the ceiling before each reservation, and every settled gross is re-judged post-run'
    ])
  };
}

/**
 * Run the single-task minimal canary. NEVER retries, NEVER grows the task set,
 * NEVER widens the budget: the ledger is assembled once from the binding in
 * ENFORCE mode, and the admission policy has no override input.
 */
export async function evaluateRealBenefitCanary(input: RealBenefitCanaryInput): Promise<RealBenefitCanaryResult> {
  const bindingEvaluation = validateRealBenefitBinding(input.binding);

  // The identity gate runs BEFORE anything else: an unattributable run is not
  // even a blocked evaluation, it is a refusal.
  const identity = input.identity;
  if (!isNonEmptyString(identity?.branchId)) {
    return assembleResult({
      bindingEvaluation,
      calls: [],
      abortTrigger: 'identity-missing',
      verdict: 'blocked',
      assembly: undefined,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: undefined,
      authorizationCounters: undefined,
      identity: undefined,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified: false,
      postHocPerCallChecks: 0,
      absoluteTotalPrechecks: 0
    });
  }

  // ---- T4 host-client gate (fail-closed BEFORE any ledger exists) ---------
  // A run with no real client must not simulate, guess or fabricate: it is
  // refused. A client whose DESENSITIZED identity does not match the binding
  // (provider/model/route + the mask rule) is refused for the same reason.
  let hostClientVerified = false;
  if (input.hostClient === undefined) {
    return assembleResult({
      bindingEvaluation,
      calls: [],
      abortTrigger: 'host-client-unbound',
      verdict: 'blocked',
      assembly: undefined,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: undefined,
      authorizationCounters: undefined,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified: false,
      postHocPerCallChecks: 0,
      absoluteTotalPrechecks: 0
    });
  }
  const identityProblems = verifyHostClientIdentity(
    input.hostClient.identity,
    input.binding.account,
    input.binding.route.routeId
  );
  if (identityProblems.length > 0) {
    return assembleResult({
      bindingEvaluation,
      calls: [],
      abortTrigger: 'host-client-identity-mismatch:' + identityProblems.join(','),
      verdict: 'blocked',
      assembly: undefined,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: undefined,
      authorizationCounters: undefined,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified: false,
      postHocPerCallChecks: 0,
      absoluteTotalPrechecks: 0
    });
  }
  hostClientVerified = true;

  if (!bindingEvaluation.satisfied) {
    // Missing binding: the legal terminal state. No call, no partial data.
    return assembleResult({
      bindingEvaluation,
      calls: [],
      abortTrigger: 'binding-incomplete:' + bindingEvaluation.missing.join(','),
      verdict: 'blocked',
      assembly: undefined,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: undefined,
      authorizationCounters: undefined,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified,
      postHocPerCallChecks: 0,
      absoluteTotalPrechecks: 0
    });
  }

  // ---- build the enforced runtime through the sanctioned assembly ---------
  // `enforceHardBounds: true` is the only switch that produces an enforcing
  // ledger; the assembly validates every field eagerly (a bad budget throws
  // here, before any call). The admission policy is applied per call below.
  const assembly = assembleAgentLoopLedger({
    enabled: true,
    enforceHardBounds: true,
    generalBudgetMicros: input.binding.generalBudgetMicros,
    verificationReserveMicros: input.binding.verificationReserveMicros,
    maxConcurrencySeats: input.binding.maxConcurrencySeats,
    defaultRateCard: input.binding.rateCard,
    routeBounds: [input.binding.route],
    phase: 'probe'
  });
  // enabled:true is passed, so the assembly is defined; the guard keeps the
  // compiler honest without a silent cast.
  if (assembly === undefined) {
    return assembleResult({
      bindingEvaluation,
      calls: [],
      abortTrigger: 'ledger-assembly-unavailable',
      verdict: 'blocked',
      assembly: undefined,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: undefined,
      authorizationCounters: undefined,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified,
      postHocPerCallChecks: 0,
      absoluteTotalPrechecks: 0
    });
  }
  const settlement = assembly.settlement;
  const toolFace = createToolFaceRegistry();
  // B-3: the allowlist is installed for THIS branch only; `"*"` was already
  // rejected by validation, and anything not listed is denied fail-closed.
  toolFace.install({
    branchId: identity.branchId,
    allowTools: [...input.binding.readonlyTools],
    label: 'r3a-readonly-canary'
  });
  const authorization = createProbeAuthorizationLedger(
    input.now === undefined ? {} : { now: input.now }
  );

  // ---- the two arms, baseline first, on the SAME task --------------------
  // Token accounting is threaded through the arms: each arm starts from the
  // previous arms' measured gross, and a settled call that pushes the
  // per-arm/task/total counter past its cap aborts the run (the record is
  // still kept — the exceed is a control fact, not a hidden failure).
  // t4-fix: `absoluteTotalPrechecks` counts the ceiling pre-checks that run
  // before each arm's reservation; `postHocPerCallChecks` counts the
  // controller-side post-hoc per-call guard executions inside the arms.
  let measuredGrossTokens = 0;
  let anyUsageUnmeasured = false;
  // t4-fix: the baseline's pre-check is structural (an accumulated gross of 0
  // plus a full arm is inside the ceiling for every VALIDATED ladder, so no
  // separate execution happens for it); the treatment's pre-check executes
  // explicitly below and is counted.
  let absoluteTotalPrechecks = 0;
  const baseline = await runArm(input, settlement, toolFace, authorization, 'baseline', 1);
  {
    const record = baseline.record;
    if (record.outcome !== 'not-called') {
      if (record.measuredTokens === undefined) anyUsageUnmeasured = true;
      else measuredGrossTokens += record.measuredTokens;
    }
  }
  if (baseline.abort !== undefined) {
    const counters = toolFace.stats();
    const authorizationCounters = authorization.stats();
    toolFace.dispose();
    authorization.dispose();
    return assembleResult({
      bindingEvaluation,
      calls: [baseline.record],
      abortTrigger: baseline.abort,
      verdict: 'blocked',
      assembly,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: counters,
      authorizationCounters,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified,
      postHocPerCallChecks: baseline.record.outcome === 'not-called' ? 0 : 1,
      absoluteTotalPrechecks
    });
  }
  // Between-arms token gate: the baseline's measured gross already counts
  // against the per-arm and per-task caps. Exceeding either refuses the
  // treatment arm before its reservation (no second call buys tokens).
  // t4-fix: the ABSOLUTE-total pre-check also runs HERE — if admitting the
  // next full arm could push the run past the user-authorized ceiling, the
  // reservation is refused before it happens (execution-level enforcement of
  // the absolute bound, via `absoluteTotalCapWouldExceed`).
  const armCap = input.binding.tokenBudget.perArmTokens;
  const taskCap = input.binding.tokenBudget.perTaskTokens;
  const baselineGross = baseline.record.measuredTokens ?? 0;
  absoluteTotalPrechecks += 1; // the treatment arm's reservation pre-check
  if (
    baselineGross > armCap ||
    baselineGross > taskCap ||
    baselineGross > input.binding.tokenBudget.totalTokens ||
    absoluteTotalCapWouldExceed(measuredGrossTokens, input.binding.tokenBudget)
  ) {
    const counters = toolFace.stats();
    const authorizationCounters = authorization.stats();
    toolFace.dispose();
    authorization.dispose();
    return assembleResult({
      bindingEvaluation,
      calls: [baseline.record],
      abortTrigger: 'token-cap-exceeded',
      verdict: 'blocked',
      assembly,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters: counters,
      authorizationCounters,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified,
      postHocPerCallChecks: baseline.record.outcome === 'not-called' ? 0 : 1,
      absoluteTotalPrechecks
    });
  }
  const treatment = await runArm(input, settlement, toolFace, authorization, 'treatment', 2);
  {
    const record = treatment.record;
    if (record.outcome !== 'not-called') {
      if (record.measuredTokens === undefined) anyUsageUnmeasured = true;
      else measuredGrossTokens += record.measuredTokens;
    }
  }
  const toolFaceCounters = toolFace.stats();
  const authorizationCounters = authorization.stats();
  toolFace.dispose();
  authorization.dispose();
  if (treatment.abort !== undefined) {
    return assembleResult({
      bindingEvaluation,
      calls: [baseline.record, treatment.record],
      abortTrigger: treatment.abort,
      verdict: 'blocked',
      assembly,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters,
      authorizationCounters,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified,
      postHocPerCallChecks:
        (baseline.record.outcome === 'not-called' ? 0 : 1) +
        (treatment.record.outcome === 'not-called' ? 0 : 1),
      absoluteTotalPrechecks
    });
  }
  // Post-run total gate: the task/total caps are judged on the accumulated
  // measured gross. (The per-arm caps were checked between arms.) The t4-fix
  // absolute ceiling is judged a second time on the SETTLED gross: with a
  // complete binding the pre-checks make reaching this branch structurally
  // impossible, and the guard keeps that invariant explicit and testable.
  if (
    measuredGrossTokens > input.binding.tokenBudget.perTaskTokens ||
    measuredGrossTokens > input.binding.tokenBudget.totalTokens ||
    measuredGrossTokens > CANARY_TOTAL_TOKEN_CEILING
  ) {
    return assembleResult({
      bindingEvaluation,
      calls: [baseline.record, treatment.record],
      abortTrigger: 'token-cap-exceeded',
      verdict: 'blocked',
      assembly,
      generalBudgetMicros: input.binding.generalBudgetMicros,
      toolFaceCounters,
      authorizationCounters,
      identity,
      binding: input.binding,
      verificationBasis: 'absent',
      hostClientVerified,
      postHocPerCallChecks:
        (baseline.record.outcome === 'not-called' ? 0 : 1) +
        (treatment.record.outcome === 'not-called' ? 0 : 1),
      absoluteTotalPrechecks
    });
  }
  void anyUsageUnmeasured;

  // ---- verdict: RewardContract numbers decide, engineering green does not -
  const baselineReward = baseline.record.reward;
  const treatmentReward = treatment.record.reward;
  const verificationBasis: 'trusted' | 'untrusted' | 'absent' =
    baseline.record.verificationStatus === 'absent' || treatment.record.verificationStatus === 'absent'
      ? 'absent'
      : baseline.record.verificationTrusted && treatment.record.verificationTrusted
        ? 'trusted'
        : 'untrusted';

  let verdict: RealBenefitVerdict;
  if (verificationBasis !== 'trusted' || baselineReward === undefined || treatmentReward === undefined) {
    // Without a trusted verdict on BOTH arms the task benefit cannot be
    // claimed; that is `insufficient`, never `passed` (A-R3-4).
    verdict = 'insufficient';
  } else {
    verdict = treatmentReward > baselineReward ? 'passed' : 'failed';
  }

  return assembleResult({
    bindingEvaluation,
    calls: [baseline.record, treatment.record],
    abortTrigger: undefined,
    verdict,
    assembly,
    generalBudgetMicros: input.binding.generalBudgetMicros,
    toolFaceCounters,
    authorizationCounters,
    identity,
    binding: input.binding,
    verificationBasis,
    hostClientVerified,
    postHocPerCallChecks:
      (baseline.record.outcome === 'not-called' ? 0 : 1) +
      (treatment.record.outcome === 'not-called' ? 0 : 1),
    absoluteTotalPrechecks
  });
}



/** The binding rows, phrased for the machine-readable credential. */
export function describeBindingItem(itemId: RealBenefitBindingItemId): string {
  switch (itemId) {
    case 'account':
      return 'B-1 account: a real provider/model/account identity plus explicit authorization provenance (grantedBy/reason)';
    case 'hard-budget':
      return 'B-2 hard budget: funded pools + priced rate card + a route whose bill is PROVABLY bounded (decideAdmission basis=provable-hard-bound) and whose ceiling covers the conservative fallback';
    case 'tool-allowlist':
      return 'B-3 read-only tool allowlist: an explicit list (empty allowed, "*" forbidden) installed per branch';
    case 'token-budget':
      return 'T4 token hard budget: total <= ' + String(CANARY_TOTAL_TOKEN_CEILING) + ' tokens (ABSOLUTE at execution level: per-call cap rides every client call, accumulated-gross-plus-full-arm pre-checked before each reservation, settled gross re-judged post-run) with STRICTLY smaller per-task/per-arm/per-call caps, all on measured usage';
    case 'controller-abort':
      return 'B-4 abort switch: identity-missing / noPolicy / unauthorized-tool / budget-exhausted / authorization-denied / tool-executor-unavailable / token-cap-exceeded / host-client-unbound / host-client-identity-mismatch abort the canary immediately';
  }
}
