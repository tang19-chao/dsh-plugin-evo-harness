/**
 * JitRL experience store: shared record model, validation, inverted index and
 * the two-stage retrieval / compaction algorithms (plan sections 5.1, 6.3, P1-2).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel, P1-2).
 *
 * The store is append-only and every level of JitRL reads from it. This module
 * owns the parts that are independent of where the bytes live: record
 * validation, the token inverted index (exact level + bucket lookup), the
 * Jaccard top-k retrieval with half-life decay, and the compaction planner.
 * The concrete stores in ./stores/ only move bytes.
 *
 * Retrieval is two-stage (section 6.3):
 *   1. exact filter - records of the same level and bucket are preferred; when
 *      fewer than max(1, k/2) records match, the pool relaxes to the whole
 *      level (the paper's cross-task memory);
 *   2. Jaccard ranking - J(s, s_i) = |T(s) & T(s_i)| / |T(s) U T(s_i)|, records
 *      below similarityThreshold are dropped, the pool is sorted and truncated
 *      to k.
 *
 * The retrieval weight is w_i = J * 2 ^ (-(now - t_i) / halfLifeMs) with the
 * age clamped at 0, so a record whose timestamp is in the future is never
 * amplified. Ordering is fully deterministic: similarity desc, weight desc,
 * createdAt desc, id asc; weights are compared with a fixed epsilon so
 * floating-point noise can never reorder otherwise identical entries.
 *
 * Persistence lives in src/jitrl/stores/*; diagnostics never contain record
 * payloads.
 */

import type {
  AbstractState,
  ExperienceOutcome,
  ExperienceQuery,
  ExperienceRecord,
  JitLevel,
  GuidanceMode
} from '../types/contracts';
import { EXPERIENCE_OUTCOMES } from '../types/contracts';
import { isRewardVersionCompatible } from './reward-contract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Current persisted-record schema version (P6 PR4, plan section 6.5).
 *
 * This is NOT the contracts version: CONTRACT_SCHEMA_VERSION stays 2 because
 * every added ExperienceRecord field is optional. A stored line is versioned
 * separately so an old JSONL file keeps loading while the new learning
 * neighbourhood can tell mis-attributed history apart:
 *
 *   1 (or absent)  legacy: written before per-execution credit attribution.
 *                  Kept for audit, excluded from the new neighbourhood by
 *                  `ExperienceQuery.excludeLegacy`.
 *   2              current: carries decisionId/runId/round/slotIndex/
 *                  trajectoryId/rewardVersion/provenanceVersion and its own
 *                  observedReturn/attributionBaseline/learningTarget.
 *
 * Migration strategy (plan section 6.5): the original log is never rewritten in
 * place. `migrateExperienceRecords()` in ./backfill.ts counts new vs legacy
 * samples and produces MARKED COPIES for a separate audit sink; dropping that
 * sink rolls the migration back. Readers opt in through `excludeLegacy`, and
 * `partitionByVersion()` gives the mirror the same rule so an old remote
 * aggregate cannot reintroduce the bias.
 */
export const EXPERIENCE_SCHEMA_VERSION = 2 as const;

/** Schema version of a record written before per-execution attribution. */
export const LEGACY_EXPERIENCE_SCHEMA_VERSION = 1 as const;

/**
 * Reward-model version stamped on every record written by this round.
 *
 * P6.1-D2 / R3 F1-a: this constant POINTS AT the RewardContract version so the
 * persisted marker and the contract that defines its meaning cannot drift
 * apart (previously it stayed on 'r2/verifiable-v1' while the orchestrator
 * already wrote 'r3/unified-signals-v1'). The contract module
 * (./reward-contract.ts) owns the version and its compatibility rule.
 */
export const CURRENT_REWARD_VERSION = 'r3/unified-signals-v1' as const;

/**
 * The reward version this store upgraded FROM; kept explicit so upgrade paths
 * and tests can name the r2 lineage instead of hard-coding the string.
 */
export const PREVIOUS_REWARD_VERSION = 'r2/verifiable-v1' as const;

/** Provenance-model version stamped on every record written by this round. */
export const CURRENT_PROVENANCE_VERSION = 'p2/per-execution-v1' as const;

/** Marker written into the version fields of a migrated legacy record. */
export const LEGACY_VERSION_TAG = 'legacy' as const;

/** Half-life of the retrieval weight in ms when the caller omits one (30 days). */
export const DEFAULT_EXPERIENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-(level, bucket) retention cap for the live index (config store.maxPerBucket). */
export const DEFAULT_EXPERIENCE_BUCKET_CAP = 200;

/** Absolute tolerance that decides whether two retrieval weights are equal. */
export const EXPERIENCE_WEIGHT_EPSILON = 1e-9;

/** Below this weight a record is treated as fully decayed, i.e. expired. */
export const EXPERIENCE_EXPIRED_WEIGHT = 1e-9;

/** Separator that makes the index keys unambiguous (never valid in a token). */
const KEY_SEPARATOR = '\u0000';

const LEVELS: readonly JitLevel[] = ['meta', 'proposal', 'host_tool'];

const GUIDANCE_MODES: readonly GuidanceMode[] = ['memory', 'guidance_free'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes for rejected records. A malformed record is
 * rejected with one of these, so a producer bug is diagnosable without ever
 * echoing the payload (which may contain secrets).
 */
export type ExperienceRecordErrorCode =
  | 'not_object'
  | 'missing_field'
  | 'invalid_field'
  | 'duplicate_id';

/** Thrown when an ExperienceRecord cannot be stored. Never carries the payload. */
export class ExperienceRecordError extends Error {
  readonly code: ExperienceRecordErrorCode;
  readonly field: string | undefined;

  constructor(code: ExperienceRecordErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ExperienceRecordError';
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Canonical form, validation and small numeric helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Own properties only: a prototype-inherited field is not a record field. */
function readField(source: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key)
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Canonical in-memory form of one record. Distinct from the contract
 * ExperienceRecord only because the token set is materialised as arrays, which
 * is what the index and the stores need.
 */
export interface StoredExperience {
  readonly id: string;
  readonly level: JitLevel;
  readonly bucket: string;
  readonly tokens: readonly string[];
  readonly summary: string;
  readonly actionKey: string;
  readonly reward: number;
  readonly return: number;
  readonly rewardSources: Readonly<Record<string, number>>;
  readonly guidance: GuidanceMode;
  readonly policyId: string;
  readonly sessionId: string;
  readonly treeId: string | undefined;
  readonly nodeId: string | undefined;
  readonly branchId: string | undefined;
  readonly scopeKey: string | undefined;
  // P6 PR4 association chain (undefined on legacy records).
  readonly decisionId: string | undefined;
  readonly runId: string | undefined;
  readonly round: number | undefined;
  readonly slotIndex: number | undefined;
  readonly parentNodeId: string | undefined;
  readonly trajectoryId: string | undefined;
  readonly policyVersion: string | undefined;
  readonly rewardVersion: string | undefined;
  readonly provenanceVersion: string | undefined;
  readonly experienceSchemaVersion: number | undefined;
  readonly observedReturn: number | undefined;
  readonly attributionBaseline: number | undefined;
  readonly learningTarget: number | undefined;
  readonly outcome: ExperienceOutcome | undefined;
  readonly learningEligible: boolean | undefined;
  readonly createdAt: number;
  readonly redacted: boolean;
}

/**
 * True when a stored record predates per-execution credit attribution, i.e. it
 * carries no schema version or one below `minimum` (plan section 6.5). Such a
 * record may still be read for audit, but it must not train the new policy.
 */
export function isLegacyStoredExperience(
  record: StoredExperience,
  minimum: number = EXPERIENCE_SCHEMA_VERSION
): boolean {
  const version = record.experienceSchemaVersion;
  return version === undefined || !Number.isFinite(version) || version < minimum;
}

/**
 * True when a record may train the policy (explicit false, or legacy).
 *
 * P6.1-D2 / R3 F1-c: a record is also learning-INELIGIBLE when its
 * rewardVersion is not compatible with the current RewardContract generation.
 * Before this check the filter ignored rewardVersion entirely, so after the
 * r2 -> r3 upgrade an old r2 record (schema already v2, never tagged legacy)
 * would still be averaged into the same neighbourhood as fresh r3 records -
 * exactly the cross-yardstick estimation P6.1-D exists to eliminate. The check
 * fails closed: a missing or unknown rewardVersion proves nothing, so it does
 * not train either.
 */
export function isLearningEligible(record: StoredExperience): boolean {
  if (record.learningEligible === false || isLegacyStoredExperience(record)) {
    return false;
  }
  return isRewardVersionCompatible(record.rewardVersion, CURRENT_REWARD_VERSION);
}

function normalizeRecord(value: unknown): StoredExperience {
  if (!isPlainObject(value)) {
    throw new ExperienceRecordError('not_object', 'experience record must be a plain object');
  }
  const id = readField(value, 'id');
  if (typeof id !== 'string' || id.length === 0) {
    throw new ExperienceRecordError('invalid_field', 'experience record id must be a non-empty string', 'id');
  }
  const level = readField(value, 'level');
  if (level !== 'meta' && level !== 'proposal' && level !== 'host_tool') {
    throw new ExperienceRecordError('invalid_field', 'experience record level is not a JitLevel', 'level');
  }
  const stateValue = readField(value, 'state');
  if (!isPlainObject(stateValue)) {
    throw new ExperienceRecordError('missing_field', 'experience record state is required', 'state');
  }
  const bucket = readField(stateValue, 'bucket');
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new ExperienceRecordError('invalid_field', 'abstract state bucket must be a non-empty string', 'state.bucket');
  }
  const tokensValue = readField(stateValue, 'tokens');
  if (!Array.isArray(tokensValue)) {
    throw new ExperienceRecordError('missing_field', 'abstract state tokens must be an array', 'state.tokens');
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of tokensValue) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ExperienceRecordError('invalid_field', 'abstract state tokens must be non-empty strings', 'state.tokens');
    }
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  const summary = readField(stateValue, 'summary');
  if (summary !== undefined && typeof summary !== 'string') {
    throw new ExperienceRecordError('invalid_field', 'abstract state summary must be a string', 'state.summary');
  }
  const actionKey = readField(value, 'actionKey');
  if (typeof actionKey !== 'string' || actionKey.length === 0) {
    throw new ExperienceRecordError('invalid_field', 'experience record actionKey must be a non-empty string', 'actionKey');
  }
  const reward = readField(value, 'reward');
  if (typeof reward !== 'number' || !Number.isFinite(reward)) {
    throw new ExperienceRecordError('invalid_field', 'experience record reward must be finite', 'reward');
  }
  const recordReturn = readField(value, 'return');
  if (typeof recordReturn !== 'number' || !Number.isFinite(recordReturn)) {
    throw new ExperienceRecordError('invalid_field', 'experience record return must be finite', 'return');
  }
  const rewardSourcesValue = readField(value, 'rewardSources');
  if (rewardSourcesValue !== undefined && !isPlainObject(rewardSourcesValue)) {
    throw new ExperienceRecordError('invalid_field', 'experience record rewardSources must be an object', 'rewardSources');
  }
  const rewardSources: Record<string, number> = {};
  if (isPlainObject(rewardSourcesValue)) {
    for (const [key, sourceValue] of Object.entries(rewardSourcesValue)) {
      if (typeof sourceValue !== 'number' || !Number.isFinite(sourceValue)) {
        throw new ExperienceRecordError(
          'invalid_field',
          'experience record rewardSources values must be finite numbers',
          'rewardSources.' + key
        );
      }
      rewardSources[key] = sourceValue;
    }
  }
  const guidance = readField(value, 'guidance');
  if (guidance !== 'memory' && guidance !== 'guidance_free') {
    throw new ExperienceRecordError('invalid_field', 'experience record guidance is not a GuidanceMode', 'guidance');
  }
  const policyId = readField(value, 'policyId');
  if (typeof policyId !== 'string' || policyId.length === 0) {
    throw new ExperienceRecordError('invalid_field', 'experience record policyId must be a non-empty string', 'policyId');
  }
  const sessionId = readField(value, 'sessionId');
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new ExperienceRecordError('invalid_field', 'experience record sessionId must be a non-empty string', 'sessionId');
  }
  const treeIdValue = readField(value, 'treeId');
  if (treeIdValue !== undefined && typeof treeIdValue !== 'string') {
    throw new ExperienceRecordError('invalid_field', 'experience record treeId must be a string', 'treeId');
  }
  const nodeIdValue = readField(value, 'nodeId');
  if (nodeIdValue !== undefined && typeof nodeIdValue !== 'string') {
    throw new ExperienceRecordError('invalid_field', 'experience record nodeId must be a string', 'nodeId');
  }
  const createdAt = readField(value, 'createdAt');
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw new ExperienceRecordError('invalid_field', 'experience record createdAt must be finite', 'createdAt');
  }
  const redacted = readField(value, 'redacted');
  if (typeof redacted !== 'boolean') {
    throw new ExperienceRecordError('missing_field', 'experience record redacted must be a boolean', 'redacted');
  }
  // P6 PR4 association chain: every field is optional, so a pre-PR4 record
  // normalizes exactly as before and simply stays legacy. A present field with
  // the wrong type is still a producer bug and is rejected (never guessed).
  const branchId = optionalString(value, 'branchId');
  const scopeKey = optionalString(value, 'scopeKey');
  const decisionId = optionalString(value, 'decisionId');
  const runId = optionalString(value, 'runId');
  const parentNodeId = optionalString(value, 'parentNodeId');
  const trajectoryId = optionalString(value, 'trajectoryId');
  const policyVersion = optionalString(value, 'policyVersion');
  const rewardVersion = optionalString(value, 'rewardVersion');
  const provenanceVersion = optionalString(value, 'provenanceVersion');
  const round = optionalInteger(value, 'round');
  const slotIndex = optionalInteger(value, 'slotIndex');
  const experienceSchemaVersion = optionalInteger(value, 'experienceSchemaVersion');
  const observedReturn = optionalNumber(value, 'observedReturn');
  const attributionBaseline = optionalNumber(value, 'attributionBaseline');
  const learningTarget = optionalNumber(value, 'learningTarget');
  const outcome = optionalOutcome(value, 'outcome');
  const learningEligibleRaw = readField(value, 'learningEligible');
  if (learningEligibleRaw !== undefined && typeof learningEligibleRaw !== 'boolean') {
    throw new ExperienceRecordError(
      'invalid_field',
      'experience record learningEligible must be a boolean',
      'learningEligible'
    );
  }
  return {
    id,
    level,
    bucket,
    tokens,
    summary: summary ?? '',
    actionKey,
    reward,
    return: recordReturn,
    rewardSources,
    guidance,
    policyId,
    sessionId,
    treeId: treeIdValue as string | undefined,
    nodeId: nodeIdValue as string | undefined,
    branchId,
    scopeKey,
    decisionId,
    runId,
    round,
    slotIndex,
    parentNodeId,
    trajectoryId,
    policyVersion,
    rewardVersion,
    provenanceVersion,
    experienceSchemaVersion,
    observedReturn,
    attributionBaseline,
    learningTarget,
    outcome,
    learningEligible: learningEligibleRaw as boolean | undefined,
    createdAt,
    redacted
  };
}

/** Read an optional non-empty string field, rejecting a wrong type. */
function optionalString(source: object, field: string): string | undefined {
  const value = readField(source, field);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ExperienceRecordError(
      'invalid_field',
      'experience record ' + field + ' must be a string',
      field
    );
  }
  return value;
}

/** Read an optional finite number field, rejecting a wrong type. */
function optionalNumber(source: object, field: string): number | undefined {
  const value = readField(source, field);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExperienceRecordError(
      'invalid_field',
      'experience record ' + field + ' must be finite',
      field
    );
  }
  return value;
}

/** Read an optional integer field, rejecting a wrong type. */
function optionalInteger(source: object, field: string): number | undefined {
  const value = readField(source, field);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ExperienceRecordError(
      'invalid_field',
      'experience record ' + field + ' must be an integer',
      field
    );
  }
  return value;
}

/** Read the optional execution outcome, rejecting an unknown spelling. */
function optionalOutcome(source: object, field: string): ExperienceOutcome | undefined {
  const value = readField(source, field);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !(EXPERIENCE_OUTCOMES as readonly string[]).includes(value)) {
    throw new ExperienceRecordError(
      'invalid_field',
      'experience record outcome is not an ExperienceOutcome',
      field
    );
  }
  return value as ExperienceOutcome;
}

/** Validate a batch, dropping duplicate ids inside the batch. Never echoes payloads. */
export function normalizeExperienceRecords(
  records: readonly ExperienceRecord[]
): readonly StoredExperience[] {
  if (!Array.isArray(records)) {
    throw new TypeError('append: records must be an array of ExperienceRecord');
  }
  const out: StoredExperience[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const stored = normalizeRecord(record);
    if (seen.has(stored.id)) {
      throw new ExperienceRecordError(
        'duplicate_id',
        'append: duplicate experience record id in batch: ' + stored.id,
        'id'
      );
    }
    seen.add(stored.id);
    out.push(stored);
  }
  return out;
}

/** True when the value can be stored by normalizeExperienceRecords. */
export function isValidExperienceRecord(value: unknown): boolean {
  try {
    normalizeRecord(value);
    return true;
  } catch {
    return false;
  }
}

/** Convert a canonical record back to the frozen contract shape. */
export function toExperienceRecord(stored: StoredExperience): ExperienceRecord {
  return {
    id: stored.id,
    level: stored.level,
    state: {
      level: stored.level,
      bucket: stored.bucket,
      tokens: [...stored.tokens],
      summary: stored.summary
    },
    actionKey: stored.actionKey,
    reward: stored.reward,
    return: stored.return,
    rewardSources: { ...stored.rewardSources },
    guidance: stored.guidance,
    policyId: stored.policyId,
    sessionId: stored.sessionId,
    ...(stored.treeId === undefined ? {} : { treeId: stored.treeId }),
    ...(stored.nodeId === undefined ? {} : { nodeId: stored.nodeId }),
    ...(stored.branchId === undefined ? {} : { branchId: stored.branchId }),
    ...(stored.scopeKey === undefined ? {} : { scopeKey: stored.scopeKey }),
    ...(stored.decisionId === undefined ? {} : { decisionId: stored.decisionId }),
    ...(stored.runId === undefined ? {} : { runId: stored.runId }),
    ...(stored.round === undefined ? {} : { round: stored.round }),
    ...(stored.slotIndex === undefined ? {} : { slotIndex: stored.slotIndex }),
    ...(stored.parentNodeId === undefined ? {} : { parentNodeId: stored.parentNodeId }),
    ...(stored.trajectoryId === undefined ? {} : { trajectoryId: stored.trajectoryId }),
    ...(stored.policyVersion === undefined ? {} : { policyVersion: stored.policyVersion }),
    ...(stored.rewardVersion === undefined ? {} : { rewardVersion: stored.rewardVersion }),
    ...(stored.provenanceVersion === undefined
      ? {}
      : { provenanceVersion: stored.provenanceVersion }),
    ...(stored.experienceSchemaVersion === undefined
      ? {}
      : { experienceSchemaVersion: stored.experienceSchemaVersion }),
    ...(stored.observedReturn === undefined ? {} : { observedReturn: stored.observedReturn }),
    ...(stored.attributionBaseline === undefined
      ? {}
      : { attributionBaseline: stored.attributionBaseline }),
    ...(stored.learningTarget === undefined ? {} : { learningTarget: stored.learningTarget }),
    ...(stored.outcome === undefined ? {} : { outcome: stored.outcome }),
    ...(stored.learningEligible === undefined
      ? {}
      : { learningEligible: stored.learningEligible }),
    createdAt: stored.createdAt,
    redacted: stored.redacted
  };
}

/**
 * Jaccard similarity over token sets: |A intersect B| / |A union B|. Duplicate
 * tokens are ignored. An empty side has no defined union, so it yields 0.
 */
export function experienceJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Retrieval weight w = similarity * 2 ^ (-(now - createdAt) / halfLifeMs). The
 * age is clamped at 0, and a non-positive half-life disables the decay.
 */
export function experienceWeight(
  similarity: number,
  createdAt: number,
  now: number,
  halfLifeMs: number = DEFAULT_EXPERIENCE_HALF_LIFE_MS
): number {
  if (!Number.isFinite(createdAt) || !Number.isFinite(now) || !Number.isFinite(halfLifeMs)) {
    return 0;
  }
  if (halfLifeMs <= 0) {
    return similarity;
  }
  const age = now - createdAt;
  const clamped = age > 0 ? age : 0;
  return similarity * Math.pow(2, -clamped / halfLifeMs);
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= EXPERIENCE_WEIGHT_EPSILON;
}

/** Deterministic ranking: similarity desc, weight desc, createdAt desc, id asc. */
export function compareStoredExperiences(
  left: { readonly record: StoredExperience; readonly similarity: number; readonly weight: number },
  right: { readonly record: StoredExperience; readonly similarity: number; readonly weight: number }
): number {
  if (!sameNumber(left.similarity, right.similarity)) {
    return right.similarity - left.similarity;
  }
  if (!sameNumber(left.weight, right.weight)) {
    return right.weight - left.weight;
  }
  if (left.record.createdAt !== right.record.createdAt) {
    return right.record.createdAt - left.record.createdAt;
  }
  if (left.record.id < right.record.id) {
    return -1;
  }
  if (left.record.id > right.record.id) {
    return 1;
  }
  return 0;
}

function levelOf(value: unknown): JitLevel | undefined {
  return LEVELS.find((level) => level === value);
}

function guidanceOf(value: unknown): GuidanceMode | undefined {
  return GUIDANCE_MODES.find((mode) => mode === value);
}

/** Validate an ExperienceQuery; throws RangeError/TypeError on a contract violation. */
export function validateExperienceQuery(query: ExperienceQuery, halfLifeMs: number): void {
  if (!isPlainObject(query as unknown)) {
    throw new TypeError('query: an ExperienceQuery object is required');
  }
  if (levelOf(query.level) === undefined) {
    throw new RangeError('query: level must be one of ' + LEVELS.join(', '));
  }
  if (!isPlainObject(query.state as unknown)) {
    throw new TypeError('query: state must be an AbstractState');
  }
  if (levelOf(query.state.level) === undefined) {
    throw new RangeError('query: state.level must be one of ' + LEVELS.join(', '));
  }
  if (typeof query.state.bucket !== 'string') {
    throw new TypeError('query: state.bucket must be a string');
  }
  if (!Array.isArray(query.state.tokens)) {
    throw new TypeError('query: state.tokens must be an array');
  }
  if (!Number.isInteger(query.k) || query.k < 1) {
    throw new RangeError('query: k must be a positive integer');
  }
  if (!Number.isFinite(query.similarityThreshold) || query.similarityThreshold < 0 || query.similarityThreshold > 1) {
    throw new RangeError('query: similarityThreshold must be a finite number in [0, 1]');
  }
  if (query.before !== undefined && !Number.isFinite(query.before)) {
    throw new RangeError('query: before must be finite when provided');
  }
  if (query.guidanceFilter !== undefined && guidanceOf(query.guidanceFilter) === undefined) {
    throw new RangeError('query: guidanceFilter must be a GuidanceMode');
  }
  if (query.excludeLegacy !== undefined && typeof query.excludeLegacy !== 'boolean') {
    throw new TypeError('query: excludeLegacy must be a boolean');
  }
  if (
    query.minimumExperienceSchemaVersion !== undefined &&
    (!Number.isInteger(query.minimumExperienceSchemaVersion) ||
      query.minimumExperienceSchemaVersion < 1)
  ) {
    throw new RangeError('query: minimumExperienceSchemaVersion must be a positive integer');
  }
  if (
    query.learningEligibleOnly !== undefined &&
    typeof query.learningEligibleOnly !== 'boolean'
  ) {
    throw new TypeError('query: learningEligibleOnly must be a boolean');
  }
  if (!Number.isFinite(halfLifeMs) || halfLifeMs < 0) {
    throw new RangeError('query: halfLifeMs must be a finite number >= 0');
  }
}

function tokenKey(level: JitLevel, token: string): string {
  return level + KEY_SEPARATOR + token;
}

function bucketKey(level: JitLevel, bucket: string): string {
  return level + KEY_SEPARATOR + bucket;
}

function compareByTimeThenId(left: StoredExperience, right: StoredExperience): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Inverted index
// ---------------------------------------------------------------------------

/** A record evicted from the in-memory index because its bucket was full. */
export interface ExperienceEviction {
  readonly id: string;
  readonly level: JitLevel;
  readonly bucket: string;
  readonly reason: 'bucket_cap';
  readonly createdAt: number;
}

/**
 * In-memory inverted index over experience records.
 *
 * - byId keeps the canonical record for dedupe and validation;
 * - byBucket maps (level, bucket) to a compact postings list, which is the
 *   exact pre-filter stage of section 6.3;
 * - byToken maps (level, token) to postings, so a query only touches records
 *   that share at least one token with the query state instead of scanning the
 *   whole level;
 * - byLevel bounds the relaxed scan.
 *
 * Postings are compacted after enough removals, so the index stays linear in
 * the number of live records. Eviction (bucket cap) is deterministic: the
 * oldest record by createdAt wins, ties by ascending id; the freshly appended
 * record is never the one chosen for immediate eviction.
 */
export class ExperienceIndex {
  private readonly store: Map<string, StoredExperience> = new Map();
  private readonly buckets: Map<string, StoredExperience[]> = new Map();
  private readonly tokens: Map<string, Set<string>> = new Map();
  private readonly levels: Map<JitLevel, Set<string>> = new Map();
  private readonly staleCounts: Map<string, number> = new Map();
  private readonly bucketCap: number;
  private readonly onEvict: ((eviction: ExperienceEviction) => void) | undefined;

  constructor(options: { readonly bucketCap?: number; readonly onEvict?: (eviction: ExperienceEviction) => void } = {}) {
    const cap = options.bucketCap ?? DEFAULT_EXPERIENCE_BUCKET_CAP;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new RangeError('ExperienceIndex: bucketCap must be a positive integer');
    }
    this.bucketCap = cap;
    this.onEvict = options.onEvict;
  }

  /** Live record count, optionally restricted to one level. */
  size(level?: JitLevel): number {
    if (level === undefined) {
      return this.store.size;
    }
    return this.levels.get(level)?.size ?? 0;
  }

  /** Number of live records at one level (cheap; no scan). */
  levelSize(level: JitLevel): number {
    return this.levels.get(level)?.size ?? 0;
  }

  /** True when the id is already indexed (used by the tolerant reload path). */
  has(id: string): boolean {
    return this.store.has(id);
  }

  /** Canonical record for an id, or undefined. */
  get(id: string): StoredExperience | undefined {
    return this.store.get(id);
  }

  /** Insert or replace one canonical record, maintaining every index. */
  insert(record: StoredExperience): void {
    if (this.store.has(record.id)) {
      this.remove(record.id);
    }
    this.store.set(record.id, record);
    const bKey = bucketKey(record.level, record.bucket);
    let bucket = this.buckets.get(bKey);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(bKey, bucket);
    }
    bucket.push(record);
    for (const token of record.tokens) {
      const tKey = tokenKey(record.level, token);
      let exact = this.tokens.get(tKey);
      if (exact === undefined) {
        exact = new Set();
        this.tokens.set(tKey, exact);
      }
      exact.add(record.id);
    }
    let levelIds = this.levels.get(record.level);
    if (levelIds === undefined) {
      levelIds = new Set();
      this.levels.set(record.level, levelIds);
    }
    levelIds.add(record.id);
    this.staleCounts.set(bKey, (this.staleCounts.get(bKey) ?? 0) + 1);
    this.evictOverCap(record);
  }

  /** Remove one record by id, maintaining every index. */
  remove(id: string): boolean {
    const record = this.store.get(id);
    if (record === undefined) {
      return false;
    }
    this.store.delete(id);
    const bKey = bucketKey(record.level, record.bucket);
    const bucket = this.buckets.get(bKey);
    if (bucket !== undefined) {
      const position = bucket.indexOf(record);
      if (position >= 0) {
        bucket.splice(position, 1);
      }
      if (bucket.length === 0) {
        this.buckets.delete(bKey);
        this.staleCounts.delete(bKey);
      } else {
        this.staleCounts.set(bKey, (this.staleCounts.get(bKey) ?? 0) + 1);
      }
    }
    for (const token of record.tokens) {
      const tKey = tokenKey(record.level, token);
      const exact = this.tokens.get(tKey);
      if (exact === undefined) {
        continue;
      }
      exact.delete(id);
      if (exact.size === 0) {
        this.tokens.delete(tKey);
        this.staleCounts.delete(tKey);
      } else {
        this.staleCounts.set(tKey, (this.staleCounts.get(tKey) ?? 0) + 1);
      }
    }
    const levelIds = this.levels.get(record.level);
    if (levelIds !== undefined) {
      levelIds.delete(id);
      if (levelIds.size === 0) {
        this.levels.delete(record.level);
      }
    }
    return true;
  }

  /** Exact pre-filter: live records of (level, bucket) after postings compaction. */
  exactBucketRecords(level: JitLevel, bucket: string): readonly StoredExperience[] {
    const key = bucketKey(level, bucket);
    const entries = this.buckets.get(key);
    if (entries === undefined) {
      return [];
    }
    if ((this.staleCounts.get(key) ?? 0) === 0) {
      return entries;
    }
    return entries.filter((record) => this.store.get(record.id) === record);
  }

  /**
   * Bounded candidate set for the relaxed stage: the union of the postings of
   * the query tokens at this level, newest first and truncated to `budget`.
   * A query whose tokens match nothing yields an empty array.
   */
  tokenCandidates(level: JitLevel, tokens: readonly string[], budget: number): readonly StoredExperience[] {
    const ids = new Set<string>();
    for (const token of tokens) {
      const postings = this.tokens.get(tokenKey(level, token));
      if (postings === undefined) {
        continue;
      }
      for (const id of postings) {
        const record = this.store.get(id);
        if (record !== undefined) {
          ids.add(id);
        }
      }
    }
    if (ids.size === 0) {
      return [];
    }
    const records: StoredExperience[] = [];
    for (const id of ids) {
      const record = this.store.get(id);
      if (record !== undefined) {
        records.push(record);
      }
    }
    if (records.length > budget) {
      records.sort(compareByTimeThenId);
      return records.slice(0, budget);
    }
    return records;
  }

  /** Live records of one level, newest first (ties by ascending id). */
  levelRecordsDescending(level: JitLevel): readonly StoredExperience[] {
    const ids = this.levels.get(level);
    if (ids === undefined || ids.size === 0) {
      return [];
    }
    const records: StoredExperience[] = [];
    for (const id of ids) {
      const record = this.store.get(id);
      if (record !== undefined) {
        records.push(record);
      }
    }
    records.sort(compareByTimeThenId);
    return records;
  }

  /** Snapshot of every live record, newest first (the export order). */
  snapshotDescending(): readonly StoredExperience[] {
    const records = [...this.store.values()];
    records.sort(compareByTimeThenId);
    return records;
  }

  /**
   * Keep only the highest-decay `maxPerBucket` records per (level, bucket) and
   * drop fully decayed records. Returns the removed records deterministically.
   */
  pruneDecayed(options: { readonly maxPerBucket: number; readonly halfLifeMs?: number; readonly now?: number }): readonly StoredExperience[] {
    const removed = planCompaction(this.store.values(), options);
    for (const record of removed) {
      this.remove(record.id);
    }
    return removed;
  }

  private evictOverCap(fresh: StoredExperience): void {
    const key = bucketKey(fresh.level, fresh.bucket);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.length <= this.bucketCap) {
      return;
    }
    const victims = bucket.filter((record) => record.id !== fresh.id);
    victims.sort(compareByTimeThenId);
    const overflow = bucket.length - this.bucketCap;
    for (let position = 0; position < overflow && position < victims.length; position += 1) {
      const victim = victims[victims.length - 1 - position];
      if (victim === undefined) {
        continue;
      }
      this.remove(victim.id);
      this.onEvict?.({
        id: victim.id,
        level: victim.level,
        bucket: victim.bucket,
        reason: 'bucket_cap',
        createdAt: victim.createdAt
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

function matchesBaseFilters(
  record: StoredExperience,
  level: JitLevel,
  guidanceFilter: GuidanceMode | undefined,
  before: number | undefined,
  excludeLegacy: boolean,
  minimumSchemaVersion: number,
  learningEligibleOnly: boolean
): boolean {
  if (record.level !== level) {
    return false;
  }
  if (guidanceFilter !== undefined && record.guidance !== guidanceFilter) {
    return false;
  }
  if (!Number.isFinite(record.createdAt)) {
    return false;
  }
  if (before !== undefined && record.createdAt > before) {
    return false;
  }
  // Plan section 6.5: mis-attributed history stays readable for audit but never
  // enters the new-version learning neighbourhood.
  if (excludeLegacy && isLegacyStoredExperience(record, minimumSchemaVersion)) {
    return false;
  }
  if (learningEligibleOnly && !isLearningEligible(record)) {
    return false;
  }
  return true;
}

export interface ScoredStoredExperience {
  readonly record: StoredExperience;
  readonly similarity: number;
  readonly weight: number;
}

function deriveCandidateBudget(k: number, levelSize: number): number {
  const budget = Math.max(k * 16, 512);
  return Math.min(budget, Math.max(levelSize, 1));
}

/**
 * Two-stage retrieval over the inverted index (section 6.3). Returns at most k
 * neighbours ordered deterministically, each with similarity and half-life
 * weight.
 *
 * Stage 1 prefers the exact (level, bucket) postings; when they hold fewer than
 * max(1, k/2) records the pool relaxes to the whole level, reached through the
 * postings of the query tokens and, if that cannot be trusted to cover the
 * level, through a full level scan. Stage 2 computes the Jaccard similarity,
 * drops zero / below-threshold / fully decayed neighbours, sorts and takes k.
 */
export function executeExperienceQuery(
  index: ExperienceIndex,
  query: ExperienceQuery,
  options: {
    readonly now?: number;
    readonly halfLifeMs?: number;
    readonly candidateBudget?: number;
  } = {}
): readonly ScoredStoredExperience[] {
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_EXPERIENCE_HALF_LIFE_MS;
  validateExperienceQuery(query, halfLifeMs);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError('query: now must be a finite non-negative number');
  }
  const level = query.level;
  const guidanceFilter = query.guidanceFilter;
  const before = query.before;
  const excludeLegacy = query.excludeLegacy === true;
  const minimumSchemaVersion =
    query.minimumExperienceSchemaVersion !== undefined &&
    Number.isInteger(query.minimumExperienceSchemaVersion)
      ? query.minimumExperienceSchemaVersion
      : EXPERIENCE_SCHEMA_VERSION;
  const learningEligibleOnly = query.learningEligibleOnly === true;

  // Stage 1a: exact (level, bucket) pre-filter.
  const bucketRecords = index.exactBucketRecords(level, query.state.bucket);
  let pool: readonly (StoredExperience | undefined)[] = bucketRecords;
  if (bucketRecords.length < Math.max(1, query.k / 2)) {
    const levelSize = index.levelSize(level);
    const budget = options.candidateBudget ?? deriveCandidateBudget(query.k, levelSize);
    // When the whole level fits in one bounded probe the token postings are a
    // complete candidate set: a record that shares no query token has Jaccard 0
    // and could never be a neighbour, so dropping it is exact. A level too
    // large for that falls back to a newest-first full scan.
    pool = levelSize <= budget ? index.tokenCandidates(level, query.state.tokens, budget) : index.levelRecordsDescending(level);
  }

  // Stage 2: Jaccard ranking.
  const scored: { record: StoredExperience; similarity: number; weight: number; order: number }[] = [];
  for (let order = 0; order < pool.length; order += 1) {
    const record = pool[order];
    if (record === undefined) {
      continue;
    }
    if (
      !matchesBaseFilters(
        record,
        level,
        guidanceFilter,
        before,
        excludeLegacy,
        minimumSchemaVersion,
        learningEligibleOnly
      )
    ) {
      continue;
    }
    const similarity = experienceJaccard(query.state.tokens, record.tokens);
    if (similarity <= 0 || similarity < query.similarityThreshold) {
      continue;
    }
    const weight = experienceWeight(similarity, record.createdAt, now, halfLifeMs);
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    scored.push({ record, similarity, weight, order });
  }
  scored.sort((left, right) => {
    const ordered = compareStoredExperiences(left, right);
    if (ordered !== 0) {
      return ordered;
    }
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.record.id < right.record.id ? -1 : 1;
  });
  return scored.slice(0, query.k).map((entry) => ({
    record: entry.record,
    similarity: entry.similarity,
    weight: entry.weight
  }));
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** Deterministic compaction score: pure time decay, so it is query independent. */
export function experienceDecay(createdAt: number, now: number, halfLifeMs: number): number {
  if (!Number.isFinite(createdAt) || !Number.isFinite(now) || !Number.isFinite(halfLifeMs) || halfLifeMs < 0) {
    return 0;
  }
  if (halfLifeMs <= 0) {
    return 1;
  }
  const age = now - createdAt;
  const clamped = age > 0 ? age : 0;
  return Math.pow(2, -clamped / halfLifeMs);
}

/**
 * Plan a compaction over a record snapshot: per (level, bucket) the highest
 * decay scores survive up to maxPerBucket, everything else is removed. Ordering
 * is decay desc, createdAt desc, id asc, so the same input always yields the
 * same survivors.
 */
export function planCompaction(
  records: Iterable<StoredExperience>,
  options: { readonly maxPerBucket: number; readonly halfLifeMs?: number; readonly now?: number }
): readonly StoredExperience[] {
  const { maxPerBucket } = options;
  if (!Number.isInteger(maxPerBucket) || maxPerBucket < 1) {
    throw new RangeError('compact: maxPerBucket must be a positive integer');
  }
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_EXPERIENCE_HALF_LIFE_MS;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs < 0) {
    throw new RangeError('compact: halfLifeMs must be a finite number >= 0');
  }
  const now = options.now ?? Date.now();
  const groups = new Map<string, { record: StoredExperience; decay: number }[]>();
  for (const record of records) {
    const key = bucketKey(record.level, record.bucket);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push({ record, decay: experienceDecay(record.createdAt, now, halfLifeMs) });
  }
  const removed: StoredExperience[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => {
      if (!sameNumber(left.decay, right.decay)) {
        return right.decay - left.decay;
      }
      return compareByTimeThenId(left.record, right.record);
    });
    for (let position = 0; position < group.length; position += 1) {
      const entry = group[position];
      if (entry === undefined) {
        continue;
      }
      if (position >= maxPerBucket || entry.decay < EXPERIENCE_EXPIRED_WEIGHT) {
        removed.push(entry.record);
      }
    }
  }
  removed.sort(compareByTimeThenId);
  return removed;
}

// ---------------------------------------------------------------------------
// Diagnostics and shared store helpers
// ---------------------------------------------------------------------------

/** One tolerant-load diagnostic; deliberately payload free. */
export interface ExperienceStoreDiagnostic {
  readonly level: 'info' | 'warn';
  readonly code: string;
  readonly message: string;
}

/** Build the diagnostic for a dropped tail / damaged line in a JSONL log. */
export function malformedLineDiagnostic(lineNumber: number, reason: string): ExperienceStoreDiagnostic {
  return {
    level: 'warn',
    code: 'experience_store_malformed_line',
    message: 'ignored malformed JSONL line ' + lineNumber + ': ' + reason
  };
}

/**
 * Split a raw experience snapshot into the records the NEW learning
 * neighbourhood may use and the ones that are audit-only (plan section 6.5).
 *
 * This is the single rule every consumer (online retrieval, replay, mirror
 * aggregation) must apply, so a legacy record cannot be re-imported from a
 * remote aggregate after the local log was migrated. Pure and dependency free.
 */
export function partitionByVersion(
  records: readonly ExperienceRecord[],
  minimumSchemaVersion: number = EXPERIENCE_SCHEMA_VERSION
): {
  readonly learning: readonly ExperienceRecord[];
  readonly legacy: readonly ExperienceRecord[];
  readonly ineligible: readonly ExperienceRecord[];
} {
  const learning: ExperienceRecord[] = [];
  const legacy: ExperienceRecord[] = [];
  const ineligible: ExperienceRecord[] = [];
  for (const record of records) {
    const version = record.experienceSchemaVersion;
    const isLegacy =
      version === undefined || !Number.isFinite(version) || version < minimumSchemaVersion;
    if (isLegacy) {
      legacy.push(record);
      continue;
    }
    if (record.learningEligible === false) {
      ineligible.push(record);
      continue;
    }
    learning.push(record);
  }
  return { learning, legacy, ineligible };
}

/**
 * Per-record legacy classification for a raw snapshot (plan section 6.5), so a
 * caller can annotate rather than drop. `legacy` means the record predates
 * per-execution attribution; `ineligible` means it carries an outcome that may
 * not train (cancelled / aborted / infrastructure).
 */
export function classifyExperienceVersion(
  record: ExperienceRecord,
  minimumSchemaVersion: number = EXPERIENCE_SCHEMA_VERSION
): 'current' | 'legacy' | 'ineligible' {
  const version = record.experienceSchemaVersion;
  if (version === undefined || !Number.isFinite(version) || version < minimumSchemaVersion) {
    return 'legacy';
  }
  return record.learningEligible === false ? 'ineligible' : 'current';
}

/**
 * Version isolation for the aggregate-statistics mirror (plan section 6.5
 * item 5: "mirror 中旧版本聚合也要隔离").
 *
 * The mirror publishes one row per (level, bucket, actionKey). If those rows
 * were built from a snapshot that still holds legacy (mis-attributed) records,
 * a backend would hand the old bias back after the local log was migrated. This
 * helper produces exactly the input the aggregator may see, plus the audit
 * counts that explain what was withheld:
 *
 *   - `current`: records at the current schema version and learning eligible;
 *   - `legacy`: records that predate per-execution attribution;
 *   - `ineligible`: current records whose outcome may not train.
 *
 * The caller aggregates `current` only and reports `legacyExcluded` /
 * `legacy: true` on the resulting rows, so a reader of the mirror can tell an
 * isolated snapshot from a clean one without parsing payloads.
 */
export function mirrorVisibleRecords(
  records: readonly ExperienceRecord[],
  minimumSchemaVersion: number = EXPERIENCE_SCHEMA_VERSION
): {
  readonly current: readonly ExperienceRecord[];
  readonly legacyExcluded: number;
  readonly ineligibleExcluded: number;
  /** True when anything was withheld, i.e. the aggregate is a partial view. */
  readonly isolated: boolean;
  /** True when any visible record was written by a different reward version. */
  readonly mixedRewardVersions: boolean;
  /** The newest reward version among the visible records (undefined when none). */
  readonly rewardVersion: string | undefined;
} {
  const { learning, legacy, ineligible } = partitionByVersion(records, minimumSchemaVersion);
  const versions = new Set<string>();
  for (const record of learning) {
    if (typeof record.rewardVersion === 'string' && record.rewardVersion.length > 0) {
      versions.add(record.rewardVersion);
    }
  }
  const rewardVersion = versions.size > 0 ? [...versions].sort()[versions.size - 1] : undefined;
  return {
    current: learning,
    legacyExcluded: legacy.length,
    ineligibleExcluded: ineligible.length,
    isolated: legacy.length > 0 || ineligible.length > 0,
    mixedRewardVersions: versions.size > 1,
    rewardVersion
  };
}

export { GUIDANCE_MODES, LEVELS };
