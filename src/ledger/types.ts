/**
 * Data contracts and types for C3 Usage Ledger and Budget Accounting.
 *
 * Implements ADR-0003 §7:
 * - §7.2: Independent provider usage payload and counting semantics declaration.
 * - §7.3: Explicit pricing semantics (three-state measurement, cacheRead/write anti-double counting,
 *         reasoning separate billing handling, non-zero conservative unknown cost,
 *         incurred spend != quality evidence).
 * - §7.4: Reserve / Settle lifecycle (concurrency by callId, idempotent settle, shared general budget,
 *         independent verification reserve pool, seat release != amount refund).
 * - §7.5: Offline deterministic fixtures across all 6 phases.
 */

/**
 * Three-state measurement precision for token metrics.
 * - 'measured': Directly reported by provider API telemetry.
 * - 'estimated': Inferred via tokenizer or character heuristic.
 * - 'unknown': Unreported or indeterminable.
 */
export type MeasurementPrecision = 'measured' | 'estimated' | 'unknown';

/**
 * Single token metric with value and precision level.
 */
export interface TokenMetric {
  tokens: number;
  precision: MeasurementPrecision;
}

/**
 * Provider-specific counting semantics declaration.
 * Every usage payload must explicitly declare these semantics.
 * If omitted or unknown, the entire usage calculation falls back to conservative unknown handling.
 */
export interface CountingSemantics {
  /**
   * Whether raw inputTokens already includes cacheReadTokens.
   * e.g. OpenAI prompt_tokens includes cached_tokens (true),
   * whereas Anthropic input_tokens excludes cache_read_input_tokens (false).
   */
  inputIncludesCacheRead: boolean;

  /**
   * Whether raw outputTokens already includes reasoningTokens.
   * e.g. DeepSeek completion_tokens includes reasoning_tokens (true).
   */
  outputIncludesReasoning: boolean;

  /** Optional semantic provider identifier or version tag */
  semanticTag?: string;
}

/**
 * Complete provider usage payload carrying individual token metrics and counting semantics.
 */
export interface ProviderUsagePayload {
  /** Uncached / prompt input tokens */
  inputTokens: TokenMetric;

  /** Standard output / completion tokens */
  outputTokens: TokenMetric;

  /** Cached prompt tokens read from cache */
  cacheReadTokens?: TokenMetric;

  /** Cache creation / write tokens */
  cacheWriteTokens?: TokenMetric;

  /** Reasoning / chain-of-thought tokens */
  reasoningTokens?: TokenMetric;

  /** Optional total token count reported by provider */
  totalTokens?: TokenMetric;

  /**
   * Explicit counting semantics.
   * If undefined, provenance must be marked 'unknown'.
   */
  countingSemantics?: CountingSemantics;
}

/**
 * Rate card for model pricing in micros (1 USD = 1,000,000 micros).
 * Using integer micro-units eliminates floating-point rounding issues.
 */
export interface ModelRateCard {
  modelId: string;

  /** Rate per million uncached input tokens in micros */
  inputRatePerMillion: number;

  /** Rate per million cache read tokens in micros (optional, defaults to inputRatePerMillion) */
  cacheReadRatePerMillion?: number;

  /** Rate per million cache write tokens in micros (optional, defaults to inputRatePerMillion) */
  cacheWriteRatePerMillion?: number;

  /** Rate per million output tokens in micros */
  outputRatePerMillion: number;

  /**
   * Rate per million reasoning tokens in micros.
   * Only applied if reasoningSeparatelyBilled is true.
   */
  reasoningRatePerMillion?: number;

  /**
   * Whether reasoning tokens are billed separately under reasoningRatePerMillion.
   * If false, reasoning tokens are included in or billed as standard output tokens.
   */
  reasoningSeparatelyBilled: boolean;

  /**
   * Conservative fallback cost in micros for unknown usage.
   * Must be strictly positive (> 0) to ensure zero silent 0-cost bypasses (ADR-0003 §7.3.5).
   */
  conservativeFallbackCostMicros: number;
}

/**
 * Itemized breakdown of cost calculation.
 */
export interface CostBreakdown {
  netInputTokens: number;
  inputCostMicros: number;

  cacheReadTokens: number;
  cacheReadCostMicros: number;

  cacheWriteTokens: number;
  cacheWriteCostMicros: number;

  netOutputTokens: number;
  outputCostMicros: number;

  reasoningTokens: number;
  reasoningCostMicros: number;

  /** Extra surcharge applied to enforce non-zero conservative upper bound */
  conservativeSurchargeMicros?: number;
}

/**
 * Complete cost calculation result.
 */
export interface CostCalculation {
  /** Total cost in micros */
  totalCostMicros: number;

  /** Itemized breakdown */
  breakdown: CostBreakdown;

  /** Overall provenance of calculation */
  provenance: MeasurementPrecision;

  /** Whether conservative fallback or unknown upper bound was applied */
  conservative: boolean;

  /** Explanatory note or audit diagnostic */
  auditNote?: string;
}

/**
 * Six distinct lifecycle phases of harness execution.
 * Full workflow coverage required per ADR-0003 §7.5.
 */
export type LedgerPhase =
  | 'probe'
  | 'reference'
  | 'compose'
  | 'reflect'
  | 'judge'
  | 'dream';

/**
 * Execution outcome of an LLM call or step.
 */
export type ExecutionOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'infrastructure_error';

/**
 * Immutable ledger event recording usage, incurred cost, and evidence status.
 */
export interface UsageLedgerEvent {
  eventId: string;
  callId: string;
  reservationId: string;
  sessionId?: string;
  phase: LedgerPhase;
  timestamp: number;
  outcome: ExecutionOutcome;
  incurredCostMicros: number;
  usage: ProviderUsagePayload;
  cost: CostCalculation;

  /**
   * Whether this event is audit-only.
   * Cancelled / failed / timeout / infra-error events MUST be auditOnly=true (ADR-0003 §7.3.6).
   */
  auditOnly: boolean;

  /**
   * Whether this event can serve as quality evidence.
   * Always false when auditOnly=true or outcome != 'succeeded'.
   */
  qualityEvidence: boolean;
}

/**
 * Budget pool classification.
 * General budget and Verification reserve are strictly independent pools (ADR-0003 §7.4).
 */
export type BudgetPoolType = 'general' | 'verification';

/**
 * Request to reserve budget and concurrency seats before invoking an LLM call.
 */
export interface ReserveRequest {
  callId: string;
  phase: LedgerPhase;
  pool: BudgetPoolType;
  estimatedCostMicros: number;

  /** Whether this call occupies an exploration concurrency seat */
  requiresSeat?: boolean;

  sessionId?: string;
}

/**
 * Rejection reason when a reservation cannot be granted.
 */
export type ReserveRejectionReason =
  | 'insufficient_budget'
  | 'insufficient_verification_reserve'
  | 'insufficient_seats'
  | 'duplicate_active_call'
  | 'call_already_settled';

/**
 * Result of a reservation request.
 */
export interface ReserveResult {
  granted: boolean;
  reservationId?: string;
  callId: string;
  pool: BudgetPoolType;
  reservedCostMicros: number;
  seatAcquired: boolean;
  rejectionReason?: ReserveRejectionReason;
}

/**
 * Internal record for an active reservation.
 */
export interface ReservationRecord {
  reservationId: string;
  callId: string;
  phase: LedgerPhase;
  pool: BudgetPoolType;
  reservedCostMicros: number;
  seatAcquired: boolean;
  sessionId?: string;
  createdAt: number;
  state: 'active' | 'settled' | 'released';
}

/**
 * Request to settle an execution.
 */
export interface SettleRequest {
  callId: string;
  reservationId: string;
  outcome: ExecutionOutcome;

  /** Usage payload if available */
  usage?: ProviderUsagePayload;

  /** Direct actual cost in micros (if precalculated via rate card) */
  actualCostMicros?: number;

  /**
   * Rate card used to calculate cost if usage is provided and actualCostMicros is omitted.
   */
  rateCard?: ModelRateCard;

  /**
   * Whether to release the concurrency seat upon settlement.
   * Defaults to true if a seat was acquired.
   */
  releaseSeat?: boolean;

  sessionId?: string;
}

/**
 * Result of a settlement operation.
 */
export interface SettleResult {
  settled: boolean;
  callId: string;
  reservationId: string;
  pool: BudgetPoolType;

  /** Actual cost incurred and settled (deducted from pool budget) */
  incurredCostMicros: number;

  /** Amount refunded back to the pool: Math.max(0, reserved - incurred) */
  amountRefundedMicros: number;

  /**
   * Whether the concurrency seat was released.
   * Notice: seatReleased does NOT mean amountRefunded > 0! (ADR-0003 §7.4).
   */
  seatReleased: boolean;

  /** True if this callId was already settled and this returned the cached idempotent result */
  isIdempotentReplay: boolean;

  /** Audit-only status */
  auditOnly: boolean;

  /** Quality evidence status */
  qualityEvidence: boolean;

  /** Recorded ledger event */
  ledgerEvent?: UsageLedgerEvent;
}

/**
 * Budget configuration for the ledger.
 */
export interface LedgerBudgetConfig {
  /** Total shared general exploration budget in micros */
  generalBudgetMicros: number;

  /** Dedicated verification reserve budget in micros */
  verificationReserveMicros: number;

  /** Maximum concurrent exploration seats */
  maxConcurrencySeats: number;

  /** Default rate card */
  defaultRateCard?: ModelRateCard;
}

/**
 * Snapshot of pool and seat status.
 */
export interface PoolStatus {
  totalMicros: number;
  reservedMicros: number;
  settledMicros: number;
  remainingMicros: number;
}

/**
 * Complete budget status snapshot.
 */
export interface LedgerBudgetStatus {
  generalPool: PoolStatus;
  verificationPool: PoolStatus;
  seats: {
    total: number;
    occupied: number;
    available: number;
  };
}
