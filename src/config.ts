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

/** Fully resolved plugin configuration. */
export interface EvoHarnessConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  triggerMode: TriggerMode;
  enabledSurfaces: HarnessComponentKey[];
  probe: ProbeConfig;
  memoryBridge: MemoryBridgeConfig;
  dreamRsi: DreamRsiConfig;
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
    promoteOnComposeSuccess: true
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
