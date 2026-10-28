/**
 * C2b (ADR 0004 §2.3): Host-authenticated quality record provenance and content digest binding.
 *
 * Requirements:
 * 1. Memory registry lifecycle isolation: the registry is bound to the host run
 *    that registered the record (`runId` + `recordId` key), volatile, cleared on
 *    process restart. A same-id record from another run can never authenticate.
 * 2. No retroactive relabeling: text labels or unauthenticated persisted records cannot elevate to task-quality.
 * 3. Unified provenance authentication and recovery rejection:
 *    - Records are bound to cryptographic content digests over state, action, the
 *      COMPLETE reward/attribution/decision payload, verification marks and the
 *      full host binding.
 *    - Tampering with any covered field invalidates the content digest.
 *    - Authentication REQUIRES a complete host binding (task/test-set/env/run/
 *      trajectory/role + verifier identity + a `sha256:<64 lower hex>` artifact
 *      digest); an incomplete binding is rejected, never silently accepted.
 *    - Unauthenticated recovered records are audit-only and NEVER silently downgraded to process.
 *    - All query/snapshot/replay/M3 consumers share this single authentication boundary.
 */

import { createHash } from 'node:crypto';

/**
 * Version tag for the quality record canonical digest framing.
 *
 * v3 (C2b review F3/F11): canonical length-prefixed JSON covering observedReturn,
 * return, reward, learningTarget, attributionBaseline, createdAt, guidance,
 * outcome, decisionId, the schema/reward/provenance versions, every identity
 * field (task/session/tree/scope/trajectory/run/policy) and the COMPLETE host
 * binding. Bumping the tag deliberately invalidates every earlier digest.
 */
export const QUALITY_RECORD_DIGEST_VERSION = 'dsh-c2b-quality-record-v3' as const;

/** Provenance context supplied by the recorder at creation time. */
export interface QualityProvenanceContext {
  readonly artifactDigest?: string;
  readonly verifierId?: string;
  readonly verifierVersion?: string;
  readonly verificationId?: string;
  readonly testSetId?: string;
  readonly envId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly trajectoryId?: string;
  readonly taskId?: string;
  readonly role?: string;
}

/**
 * The host binding members a quality record must carry to be registrable as
 * trusted (ADR 0003 T3/T4 + ADR 0004 §2.2/§2.3). The artifact digest is part of
 * the binding, not an optional annotation: without it a verdict is not bound to
 * the bytes the host actually judged.
 */
export const QUALITY_BINDING_FIELDS = [
  'artifactDigest',
  'verifierId',
  'verifierVersion',
  'verificationId',
  'testSetId',
  'envId',
  'runId',
  'sessionId',
  'trajectoryId',
  'taskId',
  'role'
] as const;

export type QualityBindingField = (typeof QUALITY_BINDING_FIELDS)[number];

/** The host-recomputed artifact digest shape: `sha256:<64 lowercase hex>`. */
export const ARTIFACT_DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

/**
 * True only when the context is a COMPLETE host binding.
 *
 * Fail-closed: an absent context, an empty member, or a non-sha256 artifact
 * digest is an incomplete binding, and an incomplete binding can never be
 * registered or authenticated (C2b review F11).
 */
export function isCompleteQualityBinding(
  context: QualityProvenanceContext | undefined
): context is QualityProvenanceContext & Required<Pick<QualityProvenanceContext, QualityBindingField>> {
  if (context === undefined || typeof context !== 'object') {
    return false;
  }
  for (const field of QUALITY_BINDING_FIELDS) {
    const value = context[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return false;
    }
  }
  return ARTIFACT_DIGEST_SHAPE.test(context.artifactDigest ?? '');
}

/** Missing/invalid binding members, in the frozen declaration order (diagnostics). */
export function missingQualityBindingFields(
  context: QualityProvenanceContext | undefined
): readonly QualityBindingField[] {
  if (context === undefined || typeof context !== 'object') {
    return [...QUALITY_BINDING_FIELDS];
  }
  const missing: QualityBindingField[] = [];
  for (const field of QUALITY_BINDING_FIELDS) {
    const value = context[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push(field);
    }
  }
  if (!missing.includes('artifactDigest') && !ARTIFACT_DIGEST_SHAPE.test(context.artifactDigest ?? '')) {
    missing.push('artifactDigest');
  }
  return missing;
}

/** Internal stored registration entry (keyed by run id + record id). */
export interface AuthenticatedQualityEntry {
  readonly recordId: string;
  readonly runId: string;
  readonly digest: string;
  readonly registeredAt: number;
  readonly context: QualityProvenanceContext;
  /**
   * Run ids whose same-recordId registrations this registration superseded
   * (F4 audit trail: the eviction is observable, never silent).
   */
  readonly supersededRuns?: readonly string[];
}

/** General shape for experience records across in-memory and stored representations. */
export interface ExperienceRecordLike {
  readonly id?: string;
  readonly level?: string;
  readonly state?: { readonly bucket?: string; readonly tokens?: readonly string[]; readonly summary?: string };
  readonly bucket?: string;
  readonly tokens?: readonly string[];
  readonly actionKey?: string;
  readonly reward?: number;
  readonly return?: number;
  readonly observedReturn?: number;
  readonly learningTarget?: number;
  readonly attributionBaseline?: number;
  readonly guidance?: string;
  readonly outcome?: string;
  readonly decisionId?: string;
  readonly decisionMode?: string;
  readonly learningTrack?: string;
  readonly learningEligible?: boolean;
  readonly rewardSources?: Readonly<Record<string, unknown>>;
  readonly trajectoryId?: string;
  readonly runId?: string;
  readonly policyId?: string;
  readonly policyVersion?: string;
  readonly sessionId?: string;
  readonly treeId?: string;
  readonly nodeId?: string;
  readonly branchId?: string;
  readonly scopeKey?: string;
  readonly scope?: string;
  readonly taskId?: string;
  readonly createdAt?: number;
  readonly experienceSchemaVersion?: number;
  readonly rewardVersion?: string;
  readonly provenanceVersion?: string;
  readonly actionKeyVocabulary?: string;
}

/** A canonical JSON value: objects become sorted [key, value] pair lists. */
type CanonicalValue = string | number | boolean | null | readonly CanonicalValue[];

/**
 * Canonicalise an arbitrary value for hashing.
 *
 * - object keys are sorted (deterministic across insertion orders);
 * - arrays keep their order (a set whose order is meaningless is sorted by the
 *   caller before it reaches here, exactly like `state.tokens`);
 * - non-finite numbers become their stable string form so JSON can encode them.
 */
function canonicalize(value: unknown): CanonicalValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const pairs: Array<readonly [string, CanonicalValue]> = [];
    for (const key of Object.keys(source).sort()) {
      pairs.push([key, canonicalize(source[key])]);
    }
    return pairs;
  }
  return String(value);
}

/** A numeric field: finite numbers stay numbers, everything else is null/string. */
function canonicalNumber(value: unknown): CanonicalValue {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  return value === undefined || value === null ? null : String(value);
}

/** Stable text field: undefined/absent is the same empty slot (null). */
function canonicalText(value: unknown): CanonicalValue {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : String(value);
}

/** Booleans keep their type; everything else falls back to the canonical form. */
function canonicalBooleanOrNull(value: unknown): CanonicalValue {
  if (typeof value === 'boolean') {
    return value;
  }
  return value === undefined || value === null ? null : canonicalize(value);
}

/** Registry key: the run boundary is part of the identity (C2b review F4). */
function registryKey(runId: string, recordId: string): string {
  return runId + '\u0000' + recordId;
}

/**
 * Members the record itself declares that must agree with the host binding.
 *
 * `runId` is always required (it is the registry partition); the other identity
 * members are optional on the record contract, so they are compared only when
 * the record actually carries them - a mismatch is always a rejection.
 */
function compareRecordBinding(
  record: ExperienceRecordLike,
  context: QualityProvenanceContext
): readonly QualityBindingField[] {
  const mismatched: QualityBindingField[] = [];
  const pairs: Array<readonly [QualityBindingField, unknown]> = [
    ['runId', record.runId],
    ['sessionId', record.sessionId],
    ['trajectoryId', record.trajectoryId],
    ['taskId', record.taskId]
  ];
  for (const [field, value] of pairs) {
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value !== context[field]) {
      mismatched.push(field);
    }
  }
  return mismatched;
}

/** Throwing precondition shared by register(): the record belongs to the bound run. */
function assertRecordBelongsToBinding(
  record: ExperienceRecordLike,
  context: QualityProvenanceContext
): void {
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    throw new TypeError('register: a quality record must carry the runId it was produced in');
  }
  if (record.runId !== context.runId) {
    throw new TypeError('register: the record runId does not match the host binding runId');
  }
  const mismatched = compareRecordBinding(record, context);
  if (mismatched.length > 0) {
    throw new TypeError(
      'register: the record contradicts the host binding for ' + mismatched.join(', ')
    );
  }
}

/** In-memory, per-run registry of authentic quality records. */
class QualityProvenanceRegistryImpl {
  /** runId + recordId -> entry. The run boundary is part of the key (F4). */
  private readonly entriesByRunRecord = new Map<string, AuthenticatedQualityEntry>();
  /** digest -> runId + recordId, kept clean on overwrite (F4). */
  private readonly digestIndex = new Map<string, string>();

  /**
   * Register an authenticated quality record created by the host recorder.
   *
   * Fail-closed: an incomplete binding throws instead of registering a record
   * that could later be mistaken for trusted (F11). Re-registering the same
   * (runId, recordId) replaces the entry AND removes the superseded digest from
   * the audit index, so a stale digest can never stay listable (F4).
   */
  register(record: ExperienceRecordLike, context?: QualityProvenanceContext): string {
    if (!record || typeof record.id !== 'string' || record.id.length === 0) {
      throw new TypeError('register: valid record with non-empty id is required');
    }
    if (!isCompleteQualityBinding(context)) {
      throw new TypeError(
        'register: a complete host verification binding is required (missing: ' +
          missingQualityBindingFields(context).join(', ') +
          ')'
      );
    }
    assertRecordBelongsToBinding(record, context);
    const digest = computeQualityRecordDigest(record, context);
    const key = registryKey(context.runId, record.id);
    // A record id has ONE authoritative registration: a new run registering the
    // same deterministic id evicts the previous run's entry (F4), so an old-run
    // record can never be mistaken for the current run's trusted evidence.
    const evictedRuns: string[] = [];
    for (const [existingKey, existing] of this.entriesByRunRecord) {
      if (existing.recordId === record.id && existingKey !== key) {
        if (this.digestIndex.get(existing.digest) === existingKey) {
          this.digestIndex.delete(existing.digest);
        }
        this.entriesByRunRecord.delete(existingKey);
        evictedRuns.push(existing.runId);
      }
    }
    const previous = this.entriesByRunRecord.get(key);
    if (previous !== undefined && this.digestIndex.get(previous.digest) === key) {
      this.digestIndex.delete(previous.digest);
    }
    this.entriesByRunRecord.set(key, {
      recordId: record.id,
      runId: context.runId,
      digest,
      registeredAt: Date.now(),
      context: { ...context },
      ...(evictedRuns.length > 0 ? { supersededRuns: evictedRuns } : {})
    } satisfies AuthenticatedQualityEntry);
    this.digestIndex.set(digest, key);
    return digest;
  }

  /**
   * Verify if a record is authentic:
   * 1. Must declare learningTrack === 'task-quality' and carry a runId
   * 2. Must exist in the registry under (record.runId, record.id)
   * 3. The registered binding must be complete and must not contradict the record
   * 4. Current content digest must match the registered digest (tamper-evident)
   * 5. Must satisfy trusted verification marks
   */
  isAuthenticated(record: ExperienceRecordLike): boolean {
    if (!record || record.learningTrack !== 'task-quality') {
      return false;
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      return false;
    }
    if (typeof record.runId !== 'string' || record.runId.length === 0) {
      // A restored/stale record without the run identity can never be the one
      // this run registered.
      return false;
    }
    const entry = this.entriesByRunRecord.get(registryKey(record.runId, record.id));
    if (!entry) {
      // Not registered in this active run (e.g. restored from storage or foreign)
      return false;
    }
    if (!isCompleteQualityBinding(entry.context)) {
      return false;
    }
    if (compareRecordBinding(record, entry.context).length > 0) {
      return false;
    }
    // Recompute digest over current record content and compare
    const currentDigest = computeQualityRecordDigest(record, entry.context);
    if (currentDigest !== entry.digest) {
      // Content has been tampered with
      return false;
    }
    // Check verification marks: trustedSource must be 1, outcomeEligible must be 1, learningEligible !== false
    const sources = record.rewardSources;
    if (!sources || sources.verificationTrusted !== 1 || sources.outcomeEligible !== 1) {
      return false;
    }
    if (record.learningEligible === false) {
      return false;
    }
    return true;
  }

  /**
   * Get a registered entry: by (runId, recordId) when the run is supplied, else
   * the first entry carrying that record id (audit convenience).
   */
  getEntry(recordId: string, runId?: string): AuthenticatedQualityEntry | undefined {
    if (typeof runId === 'string' && runId.length > 0) {
      return this.entriesByRunRecord.get(registryKey(runId, recordId));
    }
    for (const entry of this.entriesByRunRecord.values()) {
      if (entry.recordId === recordId) {
        return entry;
      }
    }
    return undefined;
  }

  /** Number of registered authentic records. */
  size(): number {
    return this.entriesByRunRecord.size;
  }

  /** Return all live registered digests (for audit / diagnostics). */
  registeredDigests(): readonly string[] {
    return Array.from(this.digestIndex.keys());
  }

  /** Registered run ids, for audit / diagnostics. */
  registeredRuns(): readonly string[] {
    return Array.from(
      new Set(Array.from(this.entriesByRunRecord.values(), (entry) => entry.runId))
    );
  }

  /**
   * Remove one registration (register-on-success rollback, C2b review F4).
   * Returns true when an entry was removed; scoped to the exact (runId,
   * recordId) key so other runs' registrations are untouched.
   */
  unregister(recordId: string, runId: string): boolean {
    const key = registryKey(runId, recordId);
    const previous = this.entriesByRunRecord.get(key);
    if (previous === undefined) {
      return false;
    }
    this.entriesByRunRecord.delete(key);
    if (this.digestIndex.get(previous.digest) === key) {
      this.digestIndex.delete(previous.digest);
    }
    return true;
  }

  /** Reset the registry (simulates process restart or test isolation). */
  clear(): void {
    this.entriesByRunRecord.clear();
    this.digestIndex.clear();
  }
}

/** Global in-memory registry singleton for the current controlled run. */
export const qualityProvenanceRegistry = new QualityProvenanceRegistryImpl();

/**
 * Compute the canonical SHA-256 content digest for an experience record.
 *
 * Covers (C2b review F3): level, state bucket + tokens, actionKey, reward,
 * return, observedReturn, learningTarget, attributionBaseline, createdAt,
 * guidance, outcome, decisionId, decisionMode, action-key vocabulary,
 * schema/reward/provenance versions, the task/session/tree/scope/trajectory/
 * run/policy identities, the WHOLE rewardSources breakdown (recursively
 * canonicalised) and the complete host binding.
 *
 * Framing: `v3:<utf8 byte length>:<canonical JSON of sorted [name, value] pairs>`.
 * The length prefix makes the encoding unambiguous; the sorted pair array makes
 * it independent of object insertion order.
 *
 * Note: keeps privacy by NOT including raw state summary text.
 */
export function computeQualityRecordDigest(
  record: ExperienceRecordLike,
  context?: QualityProvenanceContext
): string {
  const state = record.state;
  const rawTokens = state?.tokens ?? record.tokens;
  const tokens = Array.isArray(rawTokens) ? rawTokens.map((token) => String(token)).sort() : [];

  const fields: Array<readonly [string, CanonicalValue]> = [
    ['actionKey', canonicalText(record.actionKey)],
    ['actionKeyVocabulary', canonicalText(record.actionKeyVocabulary)],
    ['attributionBaseline', canonicalNumber(record.attributionBaseline)],
    ['createdAt', canonicalNumber(record.createdAt)],
    ['decisionId', canonicalText(record.decisionId)],
    ['decisionMode', canonicalText(record.decisionMode)],
    ['experienceSchemaVersion', canonicalNumber(record.experienceSchemaVersion)],
    ['guidance', canonicalText(record.guidance)],
    ['id', canonicalText(record.id)],
    ['learningEligible', canonicalBooleanOrNull(record.learningEligible)],
    ['learningTarget', canonicalNumber(record.learningTarget)],
    ['learningTrack', canonicalText(record.learningTrack)],
    ['level', canonicalText(record.level)],
    ['observedReturn', canonicalNumber(record.observedReturn)],
    ['outcome', canonicalText(record.outcome)],
    ['policyId', canonicalText(record.policyId)],
    ['policyVersion', canonicalText(record.policyVersion)],
    ['provenanceVersion', canonicalText(record.provenanceVersion)],
    ['return', canonicalNumber(record.return)],
    ['reward', canonicalNumber(record.reward)],
    ['rewardSources', canonicalize(record.rewardSources)],
    ['rewardVersion', canonicalText(record.rewardVersion)],
    ['runId', canonicalText(record.runId ?? context?.runId)],
    ['scope', canonicalText(record.scopeKey ?? record.scope)],
    ['sessionId', canonicalText(record.sessionId ?? context?.sessionId)],
    ['stateBucket', canonicalText(state?.bucket ?? record.bucket)],
    ['stateTokens', tokens],
    ['taskId', canonicalText(record.taskId ?? context?.taskId)],
    ['trajectoryId', canonicalText(record.trajectoryId ?? context?.trajectoryId)],
    ['treeId', canonicalText(record.treeId)]
  ];

  // Full host binding (F11): every member is part of the digest; an absent
  // member is encoded explicitly as null instead of silently shrinking the frame.
  for (const field of QUALITY_BINDING_FIELDS) {
    fields.push(['binding.' + field, canonicalText(context?.[field])]);
  }

  const sorted = [...fields].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const json = JSON.stringify(sorted);
  const framed =
    QUALITY_RECORD_DIGEST_VERSION + ':' + String(Buffer.byteLength(json, 'utf8')) + ':' + json;
  return 'sha256:' + createHash('sha256').update(framed, 'utf8').digest('hex');
}

/** Convenience export: register an authenticated record in the active run. */
export function registerAuthenticatedQualityRecord(
  record: ExperienceRecordLike,
  context?: QualityProvenanceContext
): string {
  return qualityProvenanceRegistry.register(record, context);
}

/** Convenience export: verify if a record is an authenticated quality record. */
export function isAuthenticatedQualityRecord(record: ExperienceRecordLike): boolean {
  return qualityProvenanceRegistry.isAuthenticated(record);
}

/** Convenience export: remove one registration (register-on-success rollback, F4). */
export function unregisterAuthenticatedQualityRecord(recordId: string, runId: string): boolean {
  return qualityProvenanceRegistry.unregister(recordId, runId);
}

/** Convenience export: clear the active registry (for tests / restart). */
export function clearQualityRecordRegistry(): void {
  qualityProvenanceRegistry.clear();
}