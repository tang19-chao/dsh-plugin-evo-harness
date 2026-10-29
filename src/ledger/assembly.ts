/**
 * C3 ledger assembly entry (P3-A).
 *
 * WHY THIS MODULE EXISTS
 *   The reservation manager is an internal accounting primitive. Before this
 *   module the only consumer (`src/dsh-bridge/agent-loop-executor.ts`) reached
 *   into `./reservation-manager.js` directly, so neither a host nor a test had a
 *   single validated assembly path: every caller had to know the class's exact
 *   constructor arguments. This module is that path. It resolves the optional
 *   `EvoLedgerConfig` of ADR-0004 section 9.2 into the manager's required budget
 *   arguments, refuses impossible configurations loudly, and exposes ONE factory
 *   used by the executor and by tests.
 *
 * SCOPE (P3-A2: observe semantics + independent hard-limit opt-in)
 *   The assembly now resolves an explicit metering mode:
 *     - DEFAULT 'observe': the manager records what it WOULD have denied and
 *       never changes the probe's outcome (no budget/seat/admission rejection);
 *     - 'enforce' ONLY through `enforceHardBounds: true`, an independent switch
 *       that does not read any execution/permission profile (guarded-active etc.).
 *   The mode is resolved here, validated here, and handed to the manager as a
 *   constructor argument; the manager defaults to 'enforce' for direct
 *   construction so every pre-P3-A2 accounting test keeps its contract.
 *
 * DEGRADATION
 *   `assembleAgentLoopLedger(undefined)` and `{ enabled: false }` both return
 *   `undefined` — the executor then stays completely unmetered. Nothing in this
 *   module fabricates a manager so that "no ledger" can never be reported as
 *   "metered".
 */

import { LedgerReservationManager } from './reservation-manager.js';
import type { RouteCostBound, WatermarkConfig } from './limits.js';
import type { EvoLedgerConfig, LedgerMeteringMode, LedgerPhase, ModelRateCard } from './types.js';

/** Frozen assembly defaults; every field is mirrored in the ADR-0004 section 9.2 comments. */
export const LEDGER_ASSEMBLY_DEFAULTS = Object.freeze({
  /** Total shared general exploration budget in micros (10,000,000u = $10). */
  generalBudgetMicros: 10_000_000,
  /** Dedicated verification reserve in micros (2,000,000u = $2). */
  verificationReserveMicros: 2_000_000,
  /** Maximum concurrent exploration seats. */
  maxConcurrencySeats: 4,
  /** Per-call reservation estimate in micros; the ledger ring-fences this before a call. */
  estimatedCostMicros: 10_000
});

/** Phase every agent-loop probe call is booked under unless the host declares one. */
export const DEFAULT_LEDGER_PHASE: LedgerPhase = 'probe';

/** Every phase the ledger accepts (mirrors `LedgerPhase`). */
const LEDGER_PHASES: readonly LedgerPhase[] = [
  'probe',
  'reference',
  'compose',
  'reflect',
  'judge',
  'dream'
];

/**
 * Assembly input: the ADR-0004 section 9.2 `EvoLedgerConfig` plus the wiring
 * values the manager's constructor does not own (per-call estimate, phase,
 * route identity/bounds, watermark thresholds).
 *
 * Every field stays optional so `{ enabled: true }` alone is a legal assembly.
 */
export interface LedgerAssemblyOptions extends EvoLedgerConfig {
  /** Per-call reservation estimate in micros; defaults to 10,000u. */
  readonly estimatedCostMicros?: number;
  /** Ledger phase booked for this executor's calls; defaults to 'probe'. */
  readonly phase?: LedgerPhase;
  /** Route id handed to `reserve()` so a later admission policy can look up its bound. */
  readonly routeId?: string;
  /** Route cost bounds registered up front, keyed by `routeId` inside each entry. */
  readonly routeBounds?: readonly RouteCostBound[];
  /** Watermark thresholds (warning/critical); defaults to the ledger's 80%/95%. */
  readonly watermarks?: WatermarkConfig;
  /** Stop-loss ceiling for an explicit unbounded-risk override, in micros. */
  readonly unboundedRiskStopLossMicros?: number;
}

/** Options after defaults are applied and every value is validated. */
export interface ResolvedLedgerAssemblyOptions {
  readonly enabled: true;
  /**
   * P3-A2: default 'observe' (never denies); 'enforce' ONLY through the explicit
   * `enforceHardBounds: true` opt-in. No other switch can turn it on.
   */
  readonly meteringMode: LedgerMeteringMode;
  readonly generalBudgetMicros: number;
  readonly verificationReserveMicros: number;
  readonly maxConcurrencySeats: number;
  readonly estimatedCostMicros: number;
  readonly phase: LedgerPhase;
  readonly allowUnboundedRiskOverride: boolean;
  readonly routeBounds?: readonly RouteCostBound[];
  readonly watermarks?: WatermarkConfig;
  readonly routeId?: string;
  readonly storageDir?: string;
  readonly defaultRateCard?: ModelRateCard;
  readonly unboundedRiskStopLossMicros?: number;
}

/** One validated manager plus the options it was assembled from. */
export interface LedgerAssembly {
  readonly manager: LedgerReservationManager;
  readonly options: ResolvedLedgerAssemblyOptions;
}

/** Stable assembly failure codes, so assertions never grep prose. */
export type LedgerAssemblyErrorCode = 'LEDGER_ASSEMBLY_INVALID';

/** Thrown when a ledger configuration cannot be assembled safely. */
export class LedgerAssemblyError extends Error {
  readonly code: LedgerAssemblyErrorCode;

  constructor(code: LedgerAssemblyErrorCode, message: string) {
    super('[' + code + '] ' + message);
    this.name = 'LedgerAssemblyError';
    this.code = code;
  }
}

function invalid(message: string): LedgerAssemblyError {
  return new LedgerAssemblyError('LEDGER_ASSEMBLY_INVALID', message);
}

/** Read an optional value as a non-negative integer, or throw. */
function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw invalid(path + ' must be a non-negative integer, received ' + String(value));
  }
  return value;
}

/** Read an optional value as a finite number in [min, max], or throw. */
function optionalRatio(value: unknown, path: string, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(path + ' must be a finite number in [' + String(min) + ', ' + String(max) + '], received ' + String(value));
  }
  return value;
}

/** Read an optional non-empty string, or throw. */
function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(path + ' must be a non-empty string, received ' + String(value));
  }
  return value;
}

/** Read an optional boolean, or throw. */
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalid(path + ' must be a boolean, received ' + String(value));
  }
  return value;
}

/** Validate the one structure the pricing layer cannot tolerate being wrong. */
function validateRateCard(value: unknown): ModelRateCard {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('defaultRateCard must be an object');
  }
  const card = value as Partial<ModelRateCard>;
  if (typeof card.modelId !== 'string' || card.modelId.trim().length === 0) {
    throw invalid('defaultRateCard.modelId must be a non-empty string');
  }
  for (const key of ['inputRatePerMillion', 'outputRatePerMillion'] as const) {
    const rate = card[key];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw invalid('defaultRateCard.' + key + ' must be a finite non-negative number');
    }
  }
  if (typeof card.reasoningSeparatelyBilled !== 'boolean') {
    throw invalid('defaultRateCard.reasoningSeparatelyBilled must be a boolean');
  }
  const floor = card.conservativeFallbackCostMicros;
  if (typeof floor !== 'number' || !Number.isFinite(floor) || !Number.isInteger(floor) || floor <= 0) {
    throw invalid('defaultRateCard.conservativeFallbackCostMicros must be a positive integer');
  }
  return { ...(card as ModelRateCard) };
}

/** Validate one declared route bound without claiming it is provable. */
function validateRouteBound(value: unknown, index: number): RouteCostBound {
  const path = 'routeBounds[' + String(index) + ']';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(path + ' must be an object');
  }
  const bound = value as Partial<RouteCostBound>;
  if (typeof bound.routeId !== 'string' || bound.routeId.trim().length === 0) {
    throw invalid(path + '.routeId must be a non-empty string');
  }
  for (const key of ['maxOutputTokens', 'maxInputTokens', 'maxReasoningTokens', 'maxNetworkAttempts'] as const) {
    optionalNonNegativeInteger(bound[key], path + '.' + key);
  }
  for (const key of [
    'tokenizerVerified',
    'providerEnforcesMaxTokens',
    'allBillableDimensionsPriced'
  ] as const) {
    optionalBoolean(bound[key], path + '.' + key);
  }
  optionalNonNegativeInteger(bound.fixedSurchargeMicros, path + '.fixedSurchargeMicros');
  return { ...(bound as RouteCostBound) };
}

/** Validate watermark thresholds; warning must not exceed critical. */
function validateWatermarks(value: unknown): WatermarkConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('watermarks must be an object');
  }
  const watermarks = value as Partial<WatermarkConfig>;
  const warning = optionalRatio(watermarks.warningRatio, 'watermarks.warningRatio', 0, 1);
  const critical = optionalRatio(watermarks.criticalRatio, 'watermarks.criticalRatio', 0, 1);
  if (warning === undefined || critical === undefined) {
    throw invalid('watermarks requires both warningRatio and criticalRatio');
  }
  if (warning > critical) {
    throw invalid(
      'watermarks.warningRatio (' + String(warning) + ') must not exceed criticalRatio (' + String(critical) + ')'
    );
  }
  return { warningRatio: warning, criticalRatio: critical };
}

/**
 * Resolve defaults and validate every field.
 *
 * Throws `LedgerAssemblyError` instead of coercing: a silently clamped budget
 * or a silently dropped switch is exactly the class of bug the P1 config
 * contract (ADR 0005) exists to prevent.
 */
export function resolveLedgerAssemblyOptions(
  config: LedgerAssemblyOptions = {}
): ResolvedLedgerAssemblyOptions {
  const enabled = optionalBoolean(config.enabled, 'enabled');
  const enforceHardBounds = optionalBoolean(config.enforceHardBounds, 'enforceHardBounds');
  // P3-A2: hard limits are wired, and ONLY this explicit opt-in enables them.
  // Default observe neither denies nor reads any other permission switch.
  const meteringMode: LedgerMeteringMode = enforceHardBounds === true ? 'enforce' : 'observe';

  if (config.phase !== undefined && !LEDGER_PHASES.includes(config.phase)) {
    throw invalid('phase must be one of: ' + LEDGER_PHASES.join(', ') + ', received ' + String(config.phase));
  }

  const routeBounds = config.routeBounds === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(config.routeBounds)) {
          throw invalid('routeBounds must be an array');
        }
        return config.routeBounds.map((bound, index) => validateRouteBound(bound, index));
      })();

  const allowUnboundedRiskOverride =
    optionalBoolean(config.allowUnboundedRiskOverride, 'allowUnboundedRiskOverride') ?? false;
  const unboundedRiskStopLossMicros = optionalNonNegativeInteger(
    config.unboundedRiskStopLossMicros,
    'unboundedRiskStopLossMicros'
  );
  if (allowUnboundedRiskOverride && (unboundedRiskStopLossMicros === undefined || unboundedRiskStopLossMicros <= 0)) {
    throw invalid(
      'allowUnboundedRiskOverride=true requires a positive unboundedRiskStopLossMicros; ' +
        'an override without a per-call ceiling is unbounded exposure (ADR-0004 section 7.3)'
    );
  }

  return {
    enabled: true,
    meteringMode,
    generalBudgetMicros:
      optionalNonNegativeInteger(config.generalBudgetMicros, 'generalBudgetMicros')
      ?? LEDGER_ASSEMBLY_DEFAULTS.generalBudgetMicros,
    verificationReserveMicros:
      optionalNonNegativeInteger(config.verificationReserveMicros, 'verificationReserveMicros')
      ?? LEDGER_ASSEMBLY_DEFAULTS.verificationReserveMicros,
    maxConcurrencySeats:
      optionalNonNegativeInteger(config.maxConcurrencySeats, 'maxConcurrencySeats')
      ?? LEDGER_ASSEMBLY_DEFAULTS.maxConcurrencySeats,
    estimatedCostMicros:
      optionalNonNegativeInteger(config.estimatedCostMicros, 'estimatedCostMicros')
      ?? LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros,
    phase: config.phase ?? DEFAULT_LEDGER_PHASE,
    allowUnboundedRiskOverride,
    ...(routeBounds === undefined ? {} : { routeBounds }),
    ...(config.watermarks === undefined ? {} : { watermarks: validateWatermarks(config.watermarks) }),
    ...(config.routeId === undefined ? {} : { routeId: optionalNonEmptyString(config.routeId, 'routeId') }),
    ...(config.storageDir === undefined
      ? {}
      : { storageDir: optionalNonEmptyString(config.storageDir, 'storageDir') }),
    ...(config.defaultRateCard === undefined
      ? {}
      : { defaultRateCard: validateRateCard(config.defaultRateCard) }),
    ...(unboundedRiskStopLossMicros === undefined ? {} : { unboundedRiskStopLossMicros })
  };
}

/** Build the manager from already-resolved options (single construction point). */
function buildManager(options: ResolvedLedgerAssemblyOptions): LedgerReservationManager {
  return new LedgerReservationManager({
    meteringMode: options.meteringMode,
    generalBudgetMicros: options.generalBudgetMicros,
    verificationReserveMicros: options.verificationReserveMicros,
    maxConcurrencySeats: options.maxConcurrencySeats,
    ...(options.defaultRateCard === undefined ? {} : { defaultRateCard: options.defaultRateCard }),
    ...(options.storageDir === undefined ? {} : { storageDir: options.storageDir }),
    ...(options.routeBounds === undefined ? {} : { routeBounds: options.routeBounds }),
    ...(options.watermarks === undefined ? {} : { watermarks: options.watermarks })
  });
}

/**
 * THE assembly factory: create a manager from the host-facing ledger config.
 *
 * This is the only supported way to construct a `LedgerReservationManager`
 * from configuration. Tests and hosts that need a manager call this instead of
 * `new LedgerReservationManager(...)`, so the budget/validation rules cannot
 * drift between the executor and its callers.
 */
export function createLedgerReservationManager(
  config: LedgerAssemblyOptions = {}
): LedgerReservationManager {
  return buildManager(resolveLedgerAssemblyOptions(config));
}

/**
 * Assemble the executor's optional ledger, honouring the ADR-0004 section 9.2
 * degradation rule.
 *
 * Returns `undefined` when the ledger was not explicitly enabled, so the
 * caller stays on the completely unmetered path. An enabled configuration is
 * validated eagerly: a bad budget throws here (at construction), not halfway
 * through a probe.
 */
export function assembleAgentLoopLedger(
  config?: LedgerAssemblyOptions
): LedgerAssembly | undefined {
  if (config === undefined || config.enabled !== true) {
    return undefined;
  }
  const options = resolveLedgerAssemblyOptions(config);
  return { manager: buildManager(options), options };
}

/** One-line diagnostic summary; safe to log (contains no prompts or budgets of calls). */
export function describeLedgerAssembly(assembly: LedgerAssembly): string {
  const options = assembly.options;
  const enforcement =
    options.meteringMode === 'enforce'
      ? 'mode=enforce (hard limits actively deny)'
      : 'mode=observe (hard bounds: not enforced in this build; opt in via enforceHardBounds)';
  return (
    'ledger assembly: ' + enforcement +
    ', budgets general=' + String(options.generalBudgetMicros) +
    'u verification=' + String(options.verificationReserveMicros) +
    'u seats=' + String(options.maxConcurrencySeats) +
    ', per-call estimate=' + String(options.estimatedCostMicros) + 'u' +
    ', phase=' + options.phase
  );
}
