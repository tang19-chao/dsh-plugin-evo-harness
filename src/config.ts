/**
 * Frozen configuration schema, defaults, and deterministic validation for
 * dsh-plugin-evo-harness.
 *
 * This module owns configuration only. It never instantiates a memory bridge,
 * a Cordis seam manager, a model adapter, or any business module.
 *
 * Config source: the host passes the plugin section of cordis.yml as a plain
 * object (ARCHITECTURE.md section 6.2). Unknown keys are rejected so typos fail
 * fast instead of silently disabling safety features.
 *
 * Validation rules are intentionally explicit and dependency-free so unit tests
 * can rely on stable ConfigValidationIssue codes and paths.
 */

import {
  DREAM_RHO_PREFERENCES,
  HARNESS_COMPONENT_KEYS,
  MEMORY_DRIVER_KINDS,
  TRIGGER_MODES,
  type HarnessComponentKey,
  type JitLevel,
  type MemoryDriverKind,
  type SurrogateScoreWeights,
  type TriggerMode
} from './types/contracts';

/** Supported log levels. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Schema version of EvoHarnessConfig; bump only with a contract round. */
export const CONFIG_SCHEMA_VERSION = 1 as const;

/** Custom JSONPath/tool-name mapping for unknown MCP memory servers. */
export interface CustomToolMappingConfig {
  enabled: boolean;
  recallToolName: string;
  commitToolName: string;
  pruneToolName?: string;
}

/**
 * Universal MCP memory bridge configuration. mcpServerTarget is 'auto' or a
 * concrete MCP server id from the host plugin-mcp configuration.
 */
export interface MemoryBridgeConfig {
  mcpServerTarget: string;
  driverHint: MemoryDriverKind | 'auto';
  enableGovernancePolyfill: boolean;
  customMapping: CustomToolMappingConfig;
  requestTimeoutMs: number;
  recallLimit: number;
  namespacePrefix: string;
  requireEvidence: boolean;
  enableNegativeFirewall: boolean;
  promoteOnComposeSuccess: boolean;
}

/**
 * Dream-RSI online probing and offline replay configuration. Budgets are hard
 * upper bounds; plan_grid may only reduce them for a specific task.
 */
export interface DreamRsiConfig {
  maxOnlineRolloutBudget: number;
  enableAsymmetricGuidance: boolean;
  offlineDreamTriggerEveryNTasks: number;
  candidatePoliciesCount: number;
  rhoPreferences: number[];
  surrogateWeights: SurrogateScoreWeights;
  maxTreePoolSize: number;
  maxWidth: number;
  maxDepth: number;
  maxRecoverySlots: number;
  earlyStopThreshold: number;
  minMemoryConfidenceForSkip: number;
}

/** Probe execution limits. */
export interface ProbeConfig {
  maxConcurrentProbes: number;
  probeTimeoutMs: number;
}

/** Logging configuration. */
export interface LoggingConfig {
  level: LogLevel;
  includeTrajectorySummaries: boolean;
}

/**
 * P6.2 C1 execution-mode configuration (ADR 0002 R1/R2, t6 revision).
 *
 * The default assembly is baseline execution + shadow suggestion records with
 * ZERO side effects: no permanent patch mount, no policy publish, no real
 * memory write. guarded-active is an explicit opt-in that enables only the
 * patch layer's evidence-gated channel; publish/memory stay denied this round
 * regardless of configuration.
 */
export interface ExecutionConfig {
  /**
   * Declared execution mode: 'shadow' (default), 'baseline', 'guarded-active'
   * or 'off'. Declared explicitly on every record the run produces (ADR R8).
   */
  mode: 'shadow' | 'baseline' | 'guarded-active' | 'off';
  /**
   * PERMANENT winning-patch mount after probing. Baseline default was true
   * (src/index.ts); the ADR t6 revision removes that exemption - the default
   * assembly must NOT permanently mount anything. Only 'guarded-active' may
   * enable it, and the resolved profile still gates every individual
   * deviation through the replacement-evidence rules.
   */
  applyWinningPatch: boolean;
}

/** JitRL exploration schedule (plan section 6.4). */
export interface JitRlExplorationConfig {
  /** Probability of optimistic exploration for an action without support. */
  lambda: number;
  /** Optimism bonus added on top of the state value when exploring. */
  alpha: number;
}

/** Local JitRL experience store persistence settings. */
export interface JitRlStoreConfig {
  /** Storage driver; only the append-only JSONL store ships in Phase 1. */
  driver: 'jsonl';
  /** Also mirror appended experience records into the host memory bridge. */
  mirrorToMemoryBridge: boolean;
  /** Per-bucket record cap enforced by compaction. */
  maxPerBucket: number;
  /** Half-life in days used by compaction; 0 disables half-life decay. */
  halfLifeDays: number;
}

/** Per-source step-reward weights; must sum to 1. */
export interface JitRlRewardWeightsConfig {
  llm: number;
  surrogate: number;
  tool: number;
  turn: number;
  user: number;
}

/** Multi-source step reward fusion settings (plan section 6.5). */
export interface JitRlRewardConfig {
  /** Enable the LLM step judge (purpose 'evaluate_steps'). */
  llmEvaluator: boolean;
  weights: JitRlRewardWeightsConfig;
  /** [min, max] clip applied to fused rewards; clip[0] must be < clip[1]. */
  clip: readonly [number, number];
}

/** L3 host tool-call advisor settings (experimental, default off). */
export interface JitRlHostAdvisorConfig {
  enabled: boolean;
  /** 'advisory' annotates decisions; 'gate' requests user confirmation and never automatically denies (请求用户确认，永不自动 deny). */
  mode: 'advisory' | 'gate';
  /** Mean neighbour return below which the advisor suggests an alternative. */
  adviseThreshold: number;
  /** Mean neighbour return below which 'gate' mode requests user confirmation; never automatically denies (请求用户确认，永不自动 deny). */
  gateThreshold: number;
  /** Minimum neighbour support before the advisor acts. */
  minSupport: number;
}

/** Privacy controls applied before experience is persisted. */
export interface JitRlPrivacyConfig {
  /** Redact secrets from persisted states and summaries. */
  redactSecrets: boolean;
  /** Store raw task/observation text alongside abstract states. */
  storeRawText: boolean;
}

/**
 * Dream-RSI x JitRL dual-loop settings (plan section 7.3, Phase 4).
 *
 * candidateJitBetas / candidateJitLambdas are the hyperparameter perturbation
 * grids generateCandidatePolicies draws from; driftRho down-weights experience
 * written by a superseded policy after a hot swap.
 */
export interface JitRlDreamConfig {
  /** Down-weight factor for stale-policy experience, in [0, 1]. */
  driftRho: number;
  /** Perturb the JitRL hyperparameters when generating candidate policies. */
  hyperparamPerturbation: boolean;
  /** Candidate beta grid; non-empty, every entry finite and >= 0. */
  candidateJitBetas: number[];
  /** Candidate lambda grid; non-empty, every entry in [0, 1]. */
  candidateJitLambdas: number[];
}

/**
 * JitRL configuration (plan section 5.2). Deliberate deviations: the config
 * schema version stays at 1 because persisted records use numeric
 * schemaVersion 1, and the plan's .volatile() hot-reload markers have no
 * counterpart in this schema yet - changed values take effect on the next
 * plugin construction.
 */
export interface JitRlConfig {
  enabled: boolean;
  /** Active layers; 'host_tool' is experimental. */
  levels: JitLevel[];
  /** Candidate logit source: 'auto' | 'verbalized' | 'token'. */
  logitSource: 'auto' | 'verbalized' | 'token';
  /** Candidate selection rule: 'argmax' | 'sample'. */
  selection: 'argmax' | 'sample';
  /** KL temperature multiplying the normalized advantage. */
  beta: number;
  /** Nearest-neighbour count (paper robust range 8-14). */
  k: number;
  /** Minimum Jaccard similarity for a neighbour. */
  similarityThreshold: number;
  /** Return discount along step/tree paths. */
  gamma: number;
  exploration: JitRlExplorationConfig;
  /** K candidates requested from proposers (proposal level). */
  candidateCount: number;
  /** Augment the candidate set with memory-only actions. */
  augmentFromMemory: boolean;
  /**
   * Opt-in for the plan section 3.1 L1 action space: when true the meta-level
   * decorator emits one candidate per slotKind x focusSurface (up to 4 x 8 = 32)
   * and writes the chosen action's surfaces back onto BatchSlotPlan.focusSurfaces.
   * Default false keeps the pre-G2-1 single-candidate-per-kind behaviour.
   */
  surfaceActions: boolean;
  /** Minimum neighbour support before the prior dominates. */
  minSupportForStrongPrior: number;
  /** Value of unseen actions: 'baseline' (Q = V) or 'zero' (paper). */
  unseenFallback: 'zero' | 'baseline';
  store: JitRlStoreConfig;
  reward: JitRlRewardConfig;
  hostAdvisor: JitRlHostAdvisorConfig;
  /** Dream-RSI x JitRL dual loop (plan section 7.3). */
  dream: JitRlDreamConfig;
  privacy: JitRlPrivacyConfig;
}

/** Fully resolved plugin configuration. */
export interface EvoHarnessConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  triggerMode: TriggerMode;
  enabledSurfaces: HarnessComponentKey[];
  probe: ProbeConfig;
  memoryBridge: MemoryBridgeConfig;
  dreamRsi: DreamRsiConfig;
  jitrl: JitRlConfig;
  /** P6.2 C1 execution mode + permanent-patch switch (ADR 0002 R1/R2). */
  execution: ExecutionConfig;
  logging: LoggingConfig;
}

/**
 * Recursive partial used by resolveEvoHarnessConfig. Arrays are replaced whole,
 * never merged element-wise, so a caller cannot accidentally preserve a stale
 * rho preference or surface allowlist.
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Typed override object accepted by resolveEvoHarnessConfig. */
export type EvoHarnessConfigInput = DeepPartial<EvoHarnessConfig>;

/** Stable issue codes produced by validation. */
export const CONFIG_ISSUE_CODES = [
  'invalid_type',
  'invalid_value',
  'out_of_range',
  'unknown_key',
  'missing_required',
  'invalid_enum',
  'duplicate_value',
  'weights_not_normalized'
] as const;
export type ConfigIssueCode = (typeof CONFIG_ISSUE_CODES)[number];

/** One deterministic validation finding. */
export interface ConfigValidationIssue {
  readonly path: string;
  readonly code: ConfigIssueCode;
  readonly message: string;
  readonly received?: unknown;
}

/** Thrown by resolveEvoHarnessConfig and parseEvoHarnessConfig on failure. */
export class ConfigValidationError extends Error {
  readonly code = 'EVO_HARNESS_CONFIG_INVALID' as const;
  readonly issues: readonly ConfigValidationIssue[];

  constructor(issues: readonly ConfigValidationIssue[]) {
    super(formatConfigIssues(issues));
    this.name = 'ConfigValidationError';
    this.issues = [...issues];
  }
}

function formatConfigIssues(issues: readonly ConfigValidationIssue[]): string {
  const details = issues.map((issue) => issue.path + ': ' + issue.message).join('; ');
  return 'Invalid dsh-plugin-evo-harness configuration (' + issues.length + ' issue(s)): ' + details;
}

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

const DEFAULT_CONFIG_VALUES: EvoHarnessConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  enabled: true,
  triggerMode: 'auto_fallback',
  enabledSurfaces: [...HARNESS_COMPONENT_KEYS],
  probe: {
    maxConcurrentProbes: 4,
    probeTimeoutMs: 120_000
  },
  memoryBridge: {
    mcpServerTarget: 'auto',
    driverHint: 'auto',
    enableGovernancePolyfill: true,
    customMapping: {
      enabled: false,
      recallToolName: 'my_custom_search',
      commitToolName: 'my_custom_upsert'
    },
    requestTimeoutMs: 10_000,
    recallLimit: 6,
    namespacePrefix: 'harness2',
    requireEvidence: true,
    enableNegativeFirewall: true,
    // P6.2 C1 (ADR 0002 R2/t6): real memory writes stay denied in the default
    // assembly - the promotion path writes to the real global namespace, so it
    // now requires an explicit opt-in.
    promoteOnComposeSuccess: false
  },
  dreamRsi: {
    maxOnlineRolloutBudget: 8,
    enableAsymmetricGuidance: true,
    offlineDreamTriggerEveryNTasks: 10,
    candidatePoliciesCount: 6,
    rhoPreferences: [...DREAM_RHO_PREFERENCES],
    surrogateWeights: {
      selection: 0.4,
      adoption: 0.3,
      efficiency: 0.2,
      toolErrorPenalty: 0.1
    },
    maxTreePoolSize: 200,
    maxWidth: 4,
    maxDepth: 3,
    maxRecoverySlots: 1,
    earlyStopThreshold: 0.8,
    minMemoryConfidenceForSkip: 0.75
  },
  jitrl: {
    enabled: true,
    levels: ['meta', 'proposal'],
    logitSource: 'auto',
    selection: 'argmax',
    beta: 1.0,
    k: 10,
    similarityThreshold: 0.3,
    gamma: 0.5,
    exploration: { lambda: 0.05, alpha: 5 },
    candidateCount: 3,
    augmentFromMemory: true,
    surfaceActions: false,
    minSupportForStrongPrior: 3,
    unseenFallback: 'baseline',
    store: {
      driver: 'jsonl',
      mirrorToMemoryBridge: false,
      maxPerBucket: 200,
      halfLifeDays: 30
    },
    reward: {
      llmEvaluator: true,
      weights: { llm: 0.4, surrogate: 0.3, tool: 0.2, turn: 0.1, user: 0.0 },
      clip: [-3, 3]
    },
    hostAdvisor: {
      enabled: false,
      mode: 'advisory',
      adviseThreshold: -0.5,
      gateThreshold: -0.8,
      minSupport: 5
    },
    dream: {
      driftRho: 0.7,
      hyperparamPerturbation: true,
      candidateJitBetas: [0.5, 1, 2],
      candidateJitLambdas: [0.02, 0.05, 0.1]
    },
    privacy: { redactSecrets: true, storeRawText: false }
  },
  // P6.2 C1 default assembly (ADR 0002 R1/t6): shadow records, NO permanent
  // patch mount, no publish, no real memory write.
  execution: { mode: 'shadow', applyWinningPatch: false },
  logging: {
    level: 'info',
    includeTrajectorySummaries: false
  }
};

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return value;
}

/** Deeply frozen, shared read-only defaults. Never mutate. */
export const DEFAULT_EVO_HARNESS_CONFIG: DeepReadonly<EvoHarnessConfig> = deepFreeze(
  DEFAULT_CONFIG_VALUES
);

/** Fresh mutable copy of the default configuration. */
export function createDefaultConfig(): EvoHarnessConfig {
  const clone: unknown = structuredClone(DEFAULT_EVO_HARNESS_CONFIG);
  return clone as EvoHarnessConfig;
}

/** Non-throwing validation result. */
export interface ConfigValidationResult {
  readonly ok: boolean;
  readonly config: EvoHarnessConfig | null;
  readonly issues: readonly ConfigValidationIssue[];
}

interface ConfigBuildResult {
  config: EvoHarnessConfig | null;
  issues: ConfigValidationIssue[];
}

const ROOT_KEYS = new Set<string>([
  'schemaVersion',
  'enabled',
  'triggerMode',
  'enabledSurfaces',
  'probe',
  'memoryBridge',
  'dreamRsi',
  'jitrl',
  'execution',
  'logging'
]);
const PROBE_KEYS = new Set<string>(['maxConcurrentProbes', 'probeTimeoutMs']);
const MEMORY_KEYS = new Set<string>([
  'mcpServerTarget',
  'driverHint',
  'enableGovernancePolyfill',
  'customMapping',
  'requestTimeoutMs',
  'recallLimit',
  'namespacePrefix',
  'requireEvidence',
  'enableNegativeFirewall',
  'promoteOnComposeSuccess'
]);
const CUSTOM_MAPPING_KEYS = new Set<string>([
  'enabled',
  'recallToolName',
  'commitToolName',
  'pruneToolName'
]);
const DREAM_KEYS = new Set<string>([
  'maxOnlineRolloutBudget',
  'enableAsymmetricGuidance',
  'offlineDreamTriggerEveryNTasks',
  'candidatePoliciesCount',
  'rhoPreferences',
  'surrogateWeights',
  'maxTreePoolSize',
  'maxWidth',
  'maxDepth',
  'maxRecoverySlots',
  'earlyStopThreshold',
  'minMemoryConfidenceForSkip'
]);
const WEIGHT_KEYS = ['selection', 'adoption', 'efficiency', 'toolErrorPenalty'] as const;
const SURROGATE_WEIGHT_KEYS = new Set<string>([...WEIGHT_KEYS]);
const LOGGING_KEYS = new Set<string>(['level', 'includeTrajectorySummaries']);
const JITRL_KEYS = new Set<string>([
  'enabled',
  'levels',
  'logitSource',
  'selection',
  'beta',
  'k',
  'similarityThreshold',
  'gamma',
  'exploration',
  'candidateCount',
  'augmentFromMemory',
  'surfaceActions',
  'minSupportForStrongPrior',
  'unseenFallback',
  'store',
  'reward',
  'hostAdvisor',
  'dream',
  'privacy'
]);
const JITRL_EXPLORATION_KEYS = new Set<string>(['lambda', 'alpha']);
const JITRL_STORE_KEYS = new Set<string>([
  'driver',
  'mirrorToMemoryBridge',
  'maxPerBucket',
  'halfLifeDays'
]);
const JITRL_REWARD_KEYS = new Set<string>(['llmEvaluator', 'weights', 'clip']);
const JITRL_HOST_ADVISOR_KEYS = new Set<string>([
  'enabled',
  'mode',
  'adviseThreshold',
  'gateThreshold',
  'minSupport'
]);
const JITRL_PRIVACY_KEYS = new Set<string>(['redactSecrets', 'storeRawText']);
const EXECUTION_KEYS = new Set<string>(['mode', 'applyWinningPatch']);
const EXECUTION_MODES_ALLOWED: readonly string[] = ['baseline', 'shadow', 'guarded-active', 'off'];
const JITRL_DREAM_KEYS = new Set<string>([
  'driftRho',
  'hyperparamPerturbation',
  'candidateJitBetas',
  'candidateJitLambdas'
]);
const JITRL_LEVELS: readonly JitLevel[] = ['meta', 'proposal', 'host_tool'];
const JITRL_LOGIT_SOURCES: readonly string[] = ['auto', 'verbalized', 'token'];
const JITRL_SELECTIONS: readonly string[] = ['argmax', 'sample'];
const JITRL_UNSEEN_FALLBACKS: readonly string[] = ['zero', 'baseline'];
const JITRL_STORE_DRIVERS: readonly string[] = ['jsonl'];
const JITRL_HOST_ADVISOR_MODES: readonly string[] = ['advisory', 'gate'];
const JITRL_REWARD_WEIGHT_KEYS = ['llm', 'surrogate', 'tool', 'turn', 'user'] as const;
const JITRL_REWARD_WEIGHT_KEYS_SET = new Set<string>([...JITRL_REWARD_WEIGHT_KEYS]);
const JITRL_WEIGHT_SUM_EPSILON = 1e-9;
const DRIVER_HINTS: readonly string[] = ['auto', ...MEMORY_DRIVER_KINDS];
const FORBIDDEN_KEYS = new Set<string>(['__proto__', 'prototype', 'constructor']);
const NAMESPACE_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WEIGHT_SUM_EPSILON = 1e-6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushIssue(
  issues: ConfigValidationIssue[],
  path: string,
  code: ConfigIssueCode,
  message: string,
  received?: unknown
): void {
  if (received === undefined) {
    issues.push({ path, code, message });
  } else {
    issues.push({ path, code, message, received });
  }
}

function collectUnknownKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ConfigValidationIssue[]
): void {
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      pushIssue(
        issues,
        path === '' ? key : path + '.' + key,
        'unknown_key',
        'Unknown configuration key ' + key + '.',
        value[key]
      );
    }
  }
}

function validateBoolean(value: unknown, path: string, issues: ConfigValidationIssue[]): void {
  if (typeof value !== 'boolean') {
    pushIssue(issues, path, 'invalid_type', 'Expected a boolean.', value);
  }
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
): void {
  if (typeof value !== 'string') {
    pushIssue(issues, path, 'invalid_type', 'Expected a string.', value);
    return;
  }
  if (value.trim().length === 0) {
    pushIssue(issues, path, 'invalid_value', 'Expected a non-empty string.', value);
  }
}

function validateOptionalNonEmptyString(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
): void {
  if (value !== undefined) {
    validateNonEmptyString(value, path, issues);
  }
}

function validateInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ConfigValidationIssue[]
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushIssue(issues, path, 'invalid_type', 'Expected a finite integer.', value);
    return;
  }
  if (!Number.isInteger(value)) {
    pushIssue(issues, path, 'invalid_type', 'Expected an integer.', value);
    return;
  }
  if (value < min || value > max) {
    pushIssue(
      issues,
      path,
      'out_of_range',
      'Expected an integer in [' + min + ', ' + max + '].',
      value
    );
  }
}

function validateNumberInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ConfigValidationIssue[]
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushIssue(issues, path, 'invalid_type', 'Expected a finite number.', value);
    return;
  }
  if (value < min || value > max) {
    pushIssue(issues, path, 'out_of_range', 'Expected a number in [' + min + ', ' + max + '].', value);
  }
}

function validateEnum(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: ConfigValidationIssue[]
): void {
  if (typeof value !== 'string') {
    pushIssue(issues, path, 'invalid_type', 'Expected a string.', value);
    return;
  }
  if (!allowed.includes(value)) {
    pushIssue(
      issues,
      path,
      'invalid_enum',
      'Expected one of: ' + allowed.join(', ') + '.',
      value
    );
  }
}

/**
 * Validate a non-empty array of finite numbers, each inside [min, max] and
 * unique. Used by the perturbation grids of jitrl.dream: a duplicated or
 * non-finite entry would silently collapse the candidate space, so it is
 * rejected instead of quietly de-duplicated.
 */
function validateNumberArray(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ConfigValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, 'invalid_type', 'Expected an array of numbers.', value);
    return;
  }
  if (value.length === 0) {
    pushIssue(issues, path, 'invalid_value', 'Expected at least 1 item(s).', value);
    return;
  }
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const itemPath = path + '[' + index + ']';
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      pushIssue(issues, itemPath, 'invalid_type', 'Expected a finite number.', item);
      continue;
    }
    if (item < min || item > max) {
      pushIssue(
        issues,
        itemPath,
        'out_of_range',
        'Expected a number in [' + min + ', ' + max + '].',
        item
      );
      continue;
    }
    if (seen.has(item)) {
      pushIssue(issues, itemPath, 'duplicate_value', 'Duplicate value ' + item + '.', item);
      continue;
    }
    seen.add(item);
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  minItems: number,
  issues: ConfigValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, 'invalid_type', 'Expected an array of strings.', value);
    return;
  }
  if (value.length < minItems) {
    pushIssue(
      issues,
      path,
      'invalid_value',
      'Expected at least ' + minItems + ' item(s).',
      value
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== 'string' || item.trim().length === 0) {
      pushIssue(
        issues,
        path + '[' + index + ']',
        'invalid_type',
        'Expected a non-empty string.',
        item
      );
    }
  }
}

function validateSurfaces(value: unknown, issues: ConfigValidationIssue[]): void {
  validateStringArray(value, 'enabledSurfaces', 1, issues);
  if (!Array.isArray(value)) {
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== 'string') {
      continue;
    }
    if (!(HARNESS_COMPONENT_KEYS as readonly string[]).includes(item)) {
      pushIssue(
        issues,
        'enabledSurfaces[' + index + ']',
        'invalid_enum',
        'Expected one of: ' + HARNESS_COMPONENT_KEYS.join(', ') + '.',
        item
      );
    }
    if (seen.has(item)) {
      pushIssue(
        issues,
        'enabledSurfaces[' + index + ']',
        'duplicate_value',
        'Duplicate harness surface ' + item + '.',
        item
      );
    }
    seen.add(item);
  }
}

function validateRhoPreferences(value: unknown, issues: ConfigValidationIssue[]): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, 'dreamRsi.rhoPreferences', 'invalid_type', 'Expected an array of numbers.', value);
    return;
  }
  if (value.length === 0) {
    pushIssue(
      issues,
      'dreamRsi.rhoPreferences',
      'invalid_value',
      'Expected at least one rho preference.',
      value
    );
    return;
  }
  let previous = Number.NEGATIVE_INFINITY;
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const path = 'dreamRsi.rhoPreferences[' + index + ']';
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      pushIssue(issues, path, 'invalid_type', 'Expected a finite number.', item);
      continue;
    }
    if (item < 0 || item > 1) {
      pushIssue(issues, path, 'out_of_range', 'Expected a number in [0, 1].', item);
      continue;
    }
    if (seen.has(item)) {
      pushIssue(issues, path, 'duplicate_value', 'Duplicate rho preference.', item);
      continue;
    }
    if (item <= previous) {
      pushIssue(issues, path, 'invalid_value', 'Rho preferences must be strictly ascending.', item);
      continue;
    }
    previous = item;
    seen.add(item);
  }
}

function validateSurrogateWeights(value: unknown, issues: ConfigValidationIssue[]): void {
  if (!isPlainObject(value)) {
    pushIssue(
      issues,
      'dreamRsi.surrogateWeights',
      'invalid_type',
      'Expected an object with four numeric weights.',
      value
    );
    return;
  }
  collectUnknownKeys(value, SURROGATE_WEIGHT_KEYS, 'dreamRsi.surrogateWeights', issues);
  const numeric: number[] = [];
  let allNumeric = true;
  for (const key of WEIGHT_KEYS) {
    const entry: unknown = value[key];
    validateNumberInRange(entry, 'dreamRsi.surrogateWeights.' + key, 0, 1, issues);
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      numeric.push(entry);
    } else {
      allNumeric = false;
    }
  }
  if (allNumeric) {
    const sum = numeric.reduce((total, entry) => total + entry, 0);
    if (Math.abs(sum - 1) > WEIGHT_SUM_EPSILON) {
      pushIssue(
        issues,
        'dreamRsi.surrogateWeights',
        'weights_not_normalized',
        'Surrogate weights must sum to 1 (received ' + sum + ').',
        sum
      );
    }
  }
}

function asGroup(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    pushIssue(issues, path, 'invalid_type', 'Expected an object.', value);
    return null;
  }
  return value;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const next = patch[key];
    if (next === undefined) {
      continue;
    }
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(next) ? deepMerge(current, next) : next;
  }
  return merged;
}

function validateProbeGroup(root: Record<string, unknown>, issues: ConfigValidationIssue[]): void {
  const probe = asGroup(root.probe, 'probe', issues);
  if (probe === null) {
    return;
  }
  validateInteger(probe.maxConcurrentProbes, 'probe.maxConcurrentProbes', 1, 16, issues);
  validateInteger(probe.probeTimeoutMs, 'probe.probeTimeoutMs', 1_000, 600_000, issues);
}

function validateMemoryGroup(root: Record<string, unknown>, issues: ConfigValidationIssue[]): void {
  const memory = asGroup(root.memoryBridge, 'memoryBridge', issues);
  if (memory === null) {
    return;
  }
  validateNonEmptyString(memory.mcpServerTarget, 'memoryBridge.mcpServerTarget', issues);
  validateEnum(memory.driverHint, 'memoryBridge.driverHint', DRIVER_HINTS, issues);
  validateBoolean(
    memory.enableGovernancePolyfill,
    'memoryBridge.enableGovernancePolyfill',
    issues
  );
  const mapping = asGroup(memory.customMapping, 'memoryBridge.customMapping', issues);
  if (mapping !== null) {
    validateBoolean(mapping.enabled, 'memoryBridge.customMapping.enabled', issues);
    if (mapping.enabled === true) {
      validateNonEmptyString(
        mapping.recallToolName,
        'memoryBridge.customMapping.recallToolName',
        issues
      );
      validateNonEmptyString(
        mapping.commitToolName,
        'memoryBridge.customMapping.commitToolName',
        issues
      );
    } else {
      validateOptionalNonEmptyString(
        mapping.recallToolName,
        'memoryBridge.customMapping.recallToolName',
        issues
      );
      validateOptionalNonEmptyString(
        mapping.commitToolName,
        'memoryBridge.customMapping.commitToolName',
        issues
      );
    }
    validateOptionalNonEmptyString(
      mapping.pruneToolName,
      'memoryBridge.customMapping.pruneToolName',
      issues
    );
  }
  validateInteger(memory.requestTimeoutMs, 'memoryBridge.requestTimeoutMs', 100, 120_000, issues);
  validateInteger(memory.recallLimit, 'memoryBridge.recallLimit', 1, 50, issues);
  validateNonEmptyString(memory.namespacePrefix, 'memoryBridge.namespacePrefix', issues);
  if (typeof memory.namespacePrefix === 'string' && !NAMESPACE_PREFIX_PATTERN.test(memory.namespacePrefix)) {
    pushIssue(
      issues,
      'memoryBridge.namespacePrefix',
      'invalid_value',
      'Expected a namespace prefix matching [A-Za-z0-9][A-Za-z0-9_-]*.',
      memory.namespacePrefix
    );
  }
  validateBoolean(memory.requireEvidence, 'memoryBridge.requireEvidence', issues);
  validateBoolean(
    memory.enableNegativeFirewall,
    'memoryBridge.enableNegativeFirewall',
    issues
  );
  validateBoolean(
    memory.promoteOnComposeSuccess,
    'memoryBridge.promoteOnComposeSuccess',
    issues
  );
}

function validateDreamGroup(root: Record<string, unknown>, issues: ConfigValidationIssue[]): void {
  const dream = asGroup(root.dreamRsi, 'dreamRsi', issues);
  if (dream === null) {
    return;
  }
  validateInteger(
    dream.maxOnlineRolloutBudget,
    'dreamRsi.maxOnlineRolloutBudget',
    1,
    64,
    issues
  );
  validateBoolean(
    dream.enableAsymmetricGuidance,
    'dreamRsi.enableAsymmetricGuidance',
    issues
  );
  validateInteger(
    dream.offlineDreamTriggerEveryNTasks,
    'dreamRsi.offlineDreamTriggerEveryNTasks',
    1,
    10_000,
    issues
  );
  validateInteger(
    dream.candidatePoliciesCount,
    'dreamRsi.candidatePoliciesCount',
    2,
    64,
    issues
  );
  validateRhoPreferences(dream.rhoPreferences, issues);
  validateSurrogateWeights(dream.surrogateWeights, issues);
  validateInteger(dream.maxTreePoolSize, 'dreamRsi.maxTreePoolSize', 1, 10_000, issues);
  validateInteger(dream.maxWidth, 'dreamRsi.maxWidth', 1, 8, issues);
  validateInteger(dream.maxDepth, 'dreamRsi.maxDepth', 1, 8, issues);
  validateInteger(dream.maxRecoverySlots, 'dreamRsi.maxRecoverySlots', 0, 1, issues);
  validateNumberInRange(dream.earlyStopThreshold, 'dreamRsi.earlyStopThreshold', 0, 1, issues);
  validateNumberInRange(
    dream.minMemoryConfidenceForSkip,
    'dreamRsi.minMemoryConfidenceForSkip',
    0,
    1,
    issues
  );
}

function validateLoggingGroup(root: Record<string, unknown>, issues: ConfigValidationIssue[]): void {
  const logging = asGroup(root.logging, 'logging', issues);
  if (logging === null) {
    return;
  }
  validateEnum(logging.level, 'logging.level', LOG_LEVELS, issues);
  validateBoolean(
    logging.includeTrajectorySummaries,
    'logging.includeTrajectorySummaries',
    issues
  );
}

/** P6.2 C1: the execution group (mode + permanent-patch switch). */
function validateExecutionGroup(root: Record<string, unknown>, issues: ConfigValidationIssue[]): void {
  const execution = asGroup(root.execution, 'execution', issues);
  if (execution === null) {
    return;
  }
  validateEnum(execution.mode, 'execution.mode', EXECUTION_MODES_ALLOWED, issues);
  validateBoolean(execution.applyWinningPatch, 'execution.applyWinningPatch', issues);
  // Cross-field guard: a permanent mount may only be requested in
  // guarded-active. Any other combination is rejected outright rather than
  // silently downgraded (fail-closed, no implicit permission loss).
  if (execution.applyWinningPatch === true && execution.mode !== 'guarded-active') {
    pushIssue(
      issues,
      'execution.applyWinningPatch',
      'invalid_value',
      'applyWinningPatch requires execution.mode=guarded-active (ADR 0002 R2: the patch permission is denied in every other mode).',
      execution.applyWinningPatch
    );
  }
}

function validateJitRlLevels(value: unknown, issues: ConfigValidationIssue[]): void {
  validateStringArray(value, 'jitrl.levels', 1, issues);
  if (!Array.isArray(value)) {
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== 'string') {
      continue;
    }
    validateEnum(item, 'jitrl.levels[' + index + ']', JITRL_LEVELS, issues);
    if (seen.has(item)) {
      pushIssue(
        issues,
        'jitrl.levels[' + index + ']',
        'duplicate_value',
        'Duplicate JitRL level ' + item + '.',
        item
      );
    }
    seen.add(item);
  }
}

function validateJitRlRewardWeights(value: unknown, issues: ConfigValidationIssue[]): void {
  if (!isPlainObject(value)) {
    pushIssue(
      issues,
      'jitrl.reward.weights',
      'invalid_type',
      'Expected an object with five numeric weights.',
      value
    );
    return;
  }
  collectUnknownKeys(value, JITRL_REWARD_WEIGHT_KEYS_SET, 'jitrl.reward.weights', issues);
  const numeric: number[] = [];
  let allNumeric = true;
  for (const key of JITRL_REWARD_WEIGHT_KEYS) {
    const entry: unknown = value[key];
    validateNumberInRange(entry, 'jitrl.reward.weights.' + key, 0, 1, issues);
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      numeric.push(entry);
    } else {
      allNumeric = false;
    }
  }
  if (allNumeric) {
    const sum = numeric.reduce((total, entry) => total + entry, 0);
    if (Math.abs(sum - 1) > JITRL_WEIGHT_SUM_EPSILON) {
      pushIssue(
        issues,
        'jitrl.reward.weights',
        'weights_not_normalized',
        'JitRL reward weights must sum to 1 (received ' + sum + ').',
        sum
      );
    }
  }
}

function validateJitRlRewardClip(value: unknown, issues: ConfigValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 2) {
    pushIssue(
      issues,
      'jitrl.reward.clip',
      'invalid_type',
      'Expected a [min, max] pair of numbers.',
      value
    );
    return;
  }
  const min: unknown = value[0];
  const max: unknown = value[1];
  validateNumberInRange(min, 'jitrl.reward.clip[0]', -1000, 1000, issues);
  validateNumberInRange(max, 'jitrl.reward.clip[1]', -1000, 1000, issues);
  if (
    typeof min === 'number' &&
    Number.isFinite(min) &&
    typeof max === 'number' &&
    Number.isFinite(max) &&
    min >= max
  ) {
    pushIssue(
      issues,
      'jitrl.reward.clip',
      'invalid_value',
      'Expected clip[0] to be strictly smaller than clip[1].',
      value
    );
  }
}

function validateJitRlGroup(root: Record<string, unknown>, issues: ConfigValidationIssue[]): void {
  const jitrl = asGroup(root.jitrl, 'jitrl', issues);
  if (jitrl === null) {
    return;
  }
  validateBoolean(jitrl.enabled, 'jitrl.enabled', issues);
  validateJitRlLevels(jitrl.levels, issues);
  validateEnum(jitrl.logitSource, 'jitrl.logitSource', JITRL_LOGIT_SOURCES, issues);
  validateEnum(jitrl.selection, 'jitrl.selection', JITRL_SELECTIONS, issues);
  validateNumberInRange(jitrl.beta, 'jitrl.beta', 0, 100, issues);
  validateInteger(jitrl.k, 'jitrl.k', 1, 1000, issues);
  validateNumberInRange(jitrl.similarityThreshold, 'jitrl.similarityThreshold', 0, 1, issues);
  validateNumberInRange(jitrl.gamma, 'jitrl.gamma', 0, 1, issues);
  const exploration = asGroup(jitrl.exploration, 'jitrl.exploration', issues);
  if (exploration !== null) {
    validateNumberInRange(exploration.lambda, 'jitrl.exploration.lambda', 0, 1, issues);
    validateNumberInRange(exploration.alpha, 'jitrl.exploration.alpha', 0, 100, issues);
  }
  validateInteger(jitrl.candidateCount, 'jitrl.candidateCount', 1, 64, issues);
  validateBoolean(jitrl.augmentFromMemory, 'jitrl.augmentFromMemory', issues);
  validateBoolean(jitrl.surfaceActions, 'jitrl.surfaceActions', issues);
  validateInteger(
    jitrl.minSupportForStrongPrior,
    'jitrl.minSupportForStrongPrior',
    0,
    1000,
    issues
  );
  validateEnum(jitrl.unseenFallback, 'jitrl.unseenFallback', JITRL_UNSEEN_FALLBACKS, issues);
  const store = asGroup(jitrl.store, 'jitrl.store', issues);
  if (store !== null) {
    validateEnum(store.driver, 'jitrl.store.driver', JITRL_STORE_DRIVERS, issues);
    validateBoolean(store.mirrorToMemoryBridge, 'jitrl.store.mirrorToMemoryBridge', issues);
    validateInteger(store.maxPerBucket, 'jitrl.store.maxPerBucket', 1, 1_000_000, issues);
    validateInteger(store.halfLifeDays, 'jitrl.store.halfLifeDays', 0, 36_500, issues);
  }
  const reward = asGroup(jitrl.reward, 'jitrl.reward', issues);
  if (reward !== null) {
    validateBoolean(reward.llmEvaluator, 'jitrl.reward.llmEvaluator', issues);
    validateJitRlRewardWeights(reward.weights, issues);
    validateJitRlRewardClip(reward.clip, issues);
  }
  const hostAdvisor = asGroup(jitrl.hostAdvisor, 'jitrl.hostAdvisor', issues);
  if (hostAdvisor !== null) {
    validateBoolean(hostAdvisor.enabled, 'jitrl.hostAdvisor.enabled', issues);
    validateEnum(hostAdvisor.mode, 'jitrl.hostAdvisor.mode', JITRL_HOST_ADVISOR_MODES, issues);
    validateNumberInRange(
      hostAdvisor.adviseThreshold,
      'jitrl.hostAdvisor.adviseThreshold',
      -100,
      100,
      issues
    );
    validateNumberInRange(
      hostAdvisor.gateThreshold,
      'jitrl.hostAdvisor.gateThreshold',
      -100,
      100,
      issues
    );
    validateInteger(hostAdvisor.minSupport, 'jitrl.hostAdvisor.minSupport', 0, 1000, issues);
  }
  const dream = asGroup(jitrl.dream, 'jitrl.dream', issues);
  if (dream !== null) {
    validateNumberInRange(dream.driftRho, 'jitrl.dream.driftRho', 0, 1, issues);
    validateBoolean(
      dream.hyperparamPerturbation,
      'jitrl.dream.hyperparamPerturbation',
      issues
    );
    validateNumberArray(dream.candidateJitBetas, 'jitrl.dream.candidateJitBetas', 0, 100, issues);
    validateNumberArray(
      dream.candidateJitLambdas,
      'jitrl.dream.candidateJitLambdas',
      0,
      1,
      issues
    );
  }
  const privacy = asGroup(jitrl.privacy, 'jitrl.privacy', issues);
  if (privacy !== null) {
    validateBoolean(privacy.redactSecrets, 'jitrl.privacy.redactSecrets', issues);
    validateBoolean(privacy.storeRawText, 'jitrl.privacy.storeRawText', issues);
  }
}

function buildConfig(rawInput: unknown): ConfigBuildResult {
  const issues: ConfigValidationIssue[] = [];
  const raw = rawInput === undefined ? {} : rawInput;
  if (!isPlainObject(raw)) {
    pushIssue(issues, '', 'invalid_type', 'Expected a configuration object.', raw);
    return { config: null, issues };
  }

  collectUnknownKeys(raw, ROOT_KEYS, '', issues);
  collectUnknownKeys(raw.probe, PROBE_KEYS, 'probe', issues);
  collectUnknownKeys(raw.memoryBridge, MEMORY_KEYS, 'memoryBridge', issues);
  if (isPlainObject(raw.memoryBridge)) {
    collectUnknownKeys(
      raw.memoryBridge.customMapping,
      CUSTOM_MAPPING_KEYS,
      'memoryBridge.customMapping',
      issues
    );
  }
  collectUnknownKeys(raw.dreamRsi, DREAM_KEYS, 'dreamRsi', issues);
  if (isPlainObject(raw.dreamRsi)) {
    collectUnknownKeys(
      raw.dreamRsi.surrogateWeights,
      SURROGATE_WEIGHT_KEYS,
      'dreamRsi.surrogateWeights',
      issues
    );
  }
  collectUnknownKeys(raw.jitrl, JITRL_KEYS, 'jitrl', issues);
  if (isPlainObject(raw.jitrl)) {
    collectUnknownKeys(raw.jitrl.exploration, JITRL_EXPLORATION_KEYS, 'jitrl.exploration', issues);
    collectUnknownKeys(raw.jitrl.store, JITRL_STORE_KEYS, 'jitrl.store', issues);
    collectUnknownKeys(raw.jitrl.reward, JITRL_REWARD_KEYS, 'jitrl.reward', issues);
    if (isPlainObject(raw.jitrl.reward)) {
      collectUnknownKeys(
        raw.jitrl.reward.weights,
        JITRL_REWARD_WEIGHT_KEYS_SET,
        'jitrl.reward.weights',
        issues
      );
    }
    collectUnknownKeys(
      raw.jitrl.hostAdvisor,
      JITRL_HOST_ADVISOR_KEYS,
      'jitrl.hostAdvisor',
      issues
    );
    collectUnknownKeys(raw.jitrl.privacy, JITRL_PRIVACY_KEYS, 'jitrl.privacy', issues);
    collectUnknownKeys(raw.jitrl.dream, JITRL_DREAM_KEYS, 'jitrl.dream', issues);
  }
  collectUnknownKeys(raw.execution, EXECUTION_KEYS, 'execution', issues);
  collectUnknownKeys(raw.logging, LOGGING_KEYS, 'logging', issues);

  const merged = deepMerge(createDefaultConfig(), raw);
  if (!isPlainObject(merged)) {
    pushIssue(issues, '', 'invalid_type', 'Expected a configuration object.', merged);
    return { config: null, issues };
  }

  const schemaVersion: unknown = merged.schemaVersion;
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    pushIssue(
      issues,
      'schemaVersion',
      'invalid_value',
      'Only schemaVersion ' + CONFIG_SCHEMA_VERSION + ' is supported.',
      schemaVersion
    );
  }
  validateBoolean(merged.enabled, 'enabled', issues);
  validateEnum(merged.triggerMode, 'triggerMode', TRIGGER_MODES, issues);
  validateSurfaces(merged.enabledSurfaces, issues);
  validateProbeGroup(merged, issues);
  validateMemoryGroup(merged, issues);
  validateDreamGroup(merged, issues);
  validateJitRlGroup(merged, issues);
  validateExecutionGroup(merged, issues);
  validateLoggingGroup(merged, issues);

  return { config: merged as unknown as EvoHarnessConfig, issues };
}

/**
 * Resolve typed overrides on top of the frozen defaults and validate the
 * result. Throws ConfigValidationError with every issue found, so callers can
 * surface all problems at once.
 */
export function resolveEvoHarnessConfig(overrides: EvoHarnessConfigInput = {}): EvoHarnessConfig {
  const result = buildConfig(overrides);
  if (result.config === null || result.issues.length > 0) {
    throw new ConfigValidationError(result.issues);
  }
  return result.config;
}

/**
 * Parse an untrusted plain object (for example parsed cordis.yml) into a fully
 * resolved configuration. undefined means 'use defaults'; null is rejected.
 */
export function parseEvoHarnessConfig(raw?: unknown): EvoHarnessConfig {
  const result = buildConfig(raw);
  if (result.config === null || result.issues.length > 0) {
    throw new ConfigValidationError(result.issues);
  }
  return result.config;
}

/** Non-throwing form of parseEvoHarnessConfig. */
export function validateEvoHarnessConfig(raw?: unknown): ConfigValidationResult {
  const result = buildConfig(raw);
  if (result.issues.length > 0 || result.config === null) {
    return { ok: false, config: null, issues: result.issues };
  }
  return { ok: true, config: result.config, issues: [] };
}
