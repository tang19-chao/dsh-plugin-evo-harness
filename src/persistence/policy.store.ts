/**
 * Durable current/historical MetaSearchPolicy and shouldDream counter storage
 * (P0-4).
 *
 * Layout inside the profile data directory:
 *   policy.current.json   - atomic structured snapshot of the active policy
 *   policy.history.jsonl  - append-only audit log of accepted policy revisions
 *   counters.json         - atomic snapshot of the offline-dream cadence counter
 *
 * `shouldDream` in src/orchestrator.ts fires when the number of completed tasks
 * reaches a multiple of dreamRsi.offlineDreamTriggerEveryNTasks. Because that
 * count now survives a restart, the cadence also survives it: a host that
 * completed 3 tasks before exiting resumes at 3 and still dreams on the next
 * boundary instead of restarting the count from zero.
 *
 * Every write uses the atomic temp-file + rename path from ./data-dir.ts, and a
 * damaged or partially written file is quarantined as '<name>.corrupt' with a
 * diagnostic instead of blocking startup. The stores reuse the frozen
 * MetaSearchPolicy contract and its validatePolicy() checker from src/dream-rsi.
 *
 * Ownership: src/persistence/** (persistence engineer).
 */

import path from 'node:path';

import {
  BATCH_SLOT_KINDS,
  type BatchPlan,
  type MetaSearchPolicy,
  type PlanGridRequest,
  type SearchGridPlan,
  type SelectBatchRequest
} from '../types/contracts';
import {
  PolicyValidationError,
  createDefaultPolicy,
  validatePolicy,
  type ActivePolicy
} from '../dream-rsi/active-policy';
import {
  PERSISTENCE_SCHEMA_VERSION,
  appendFileDurable,
  encodeJsonlRecord,
  ensureDir,
  readJsonRecovering,
  readJsonlRecovering,
  recordDiagnostics,
  sweepTempFiles,
  writeFileAtomic
} from './data-dir';

/** Structured snapshot file for the active policy. */
export const POLICY_CURRENT_FILE = 'policy.current.json';

/** Append-only JSONL audit log of accepted policy revisions. */
export const POLICY_HISTORY_FILE = 'policy.history.jsonl';

/** Structured snapshot file for the shouldDream counter. */
export const COUNTERS_FILE = 'counters.json';

/** Default number of policy revisions retained in the history log. */
export const DEFAULT_MAX_HISTORY = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

/** Structural + semantic validation of a persisted MetaSearchPolicy. */
export function isMetaSearchPolicy(value: unknown): value is MetaSearchPolicy {
  if (!isRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.id)) {
    return false;
  }
  if (!isFiniteNumber(value.version) || value.version < 1) {
    return false;
  }
  if (!isFiniteNumber(value.createdAt)) {
    return false;
  }
  if (!isFiniteNumber(value.maxWidth) || value.maxWidth < 0) {
    return false;
  }
  if (!isFiniteNumber(value.maxDepth) || value.maxDepth < 0) {
    return false;
  }
  if (!isRecord(value.slotWeights)) {
    return false;
  }
  for (const kind of BATCH_SLOT_KINDS) {
    if (!isFiniteNumber(value.slotWeights[kind])) {
      return false;
    }
  }
  if (!isFiniteNumber(value.earlyStopThreshold) || !isFiniteNumber(value.minMemoryConfidenceForSkip)) {
    return false;
  }
  if (value.parentPolicyId !== undefined && !isNonEmptyString(value.parentPolicyId)) {
    return false;
  }
  if (value.explorationTemperature !== undefined && !isFiniteNumber(value.explorationTemperature)) {
    return false;
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    return false;
  }
  return validatePolicy(value as unknown as MetaSearchPolicy).length === 0;
}

/** Persisted offline-dream cadence counters. */
export interface PersistedCounters {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  /** Completed orchestrator runs; the shouldDream cadence uses this count. */
  readonly completedTasks: number;
  /** Offline dreams actually performed. */
  readonly dreams: number;
  readonly updatedAt: number;
}

/** One persisted policy revision record. */
export interface PolicyRevisionRecord {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly at: number;
  readonly policy: MetaSearchPolicy;
}

interface CurrentPolicyEnvelope {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly savedAt: number;
  readonly policy: MetaSearchPolicy;
}

function parseCurrentEnvelope(value: unknown): MetaSearchPolicy | undefined {
  if (!isRecord(value) || value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    return undefined;
  }
  if (!isFiniteNumber(value.savedAt)) {
    return undefined;
  }
  return isMetaSearchPolicy(value.policy) ? value.policy : undefined;
}

function parseRevisionRecord(value: unknown): PolicyRevisionRecord | undefined {
  if (!isRecord(value) || value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    return undefined;
  }
  if (!isFiniteNumber(value.at) || !isMetaSearchPolicy(value.policy)) {
    return undefined;
  }
  return { schemaVersion: PERSISTENCE_SCHEMA_VERSION, at: value.at, policy: value.policy };
}

function defaultCounters(now: number): PersistedCounters {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    completedTasks: 0,
    dreams: 0,
    updatedAt: now
  };
}

function parseCounters(value: unknown): PersistedCounters | undefined {
  if (!isRecord(value) || value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    return undefined;
  }
  if (
    !isNonNegativeInteger(value.completedTasks) ||
    !isNonNegativeInteger(value.dreams) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    completedTasks: value.completedTasks,
    dreams: value.dreams,
    updatedAt: value.updatedAt
  };
}

function normalizeDelta(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.floor(value));
}

/** Construction options for a PolicyStore. */
export interface PolicyStoreOptions {
  /** Profile data directory (see resolveProfileDataDir). */
  readonly dataDir: string;
  readonly now?: () => number;
  /** Retained history revisions; defaults to 50. */
  readonly maxHistory?: number;
}

/**
 * Durable current/history policy store plus the shouldDream task counter.
 * Created through open(), which performs startup recovery.
 */
export class PolicyStore {
  readonly dataDir: string;
  readonly currentPath: string;
  readonly historyPath: string;
  readonly countersPath: string;
  private readonly now: () => number;
  private readonly maxHistory: number;
  private readonly diagnosticsSink: string[] = [];
  private readonly quarantinePaths: string[] = [];
  private currentValue: MetaSearchPolicy | undefined;
  private historyValue: MetaSearchPolicy[] = [];
  private countersValue: PersistedCounters;
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: PolicyStoreOptions) {
    this.dataDir = options.dataDir;
    this.currentPath = path.join(options.dataDir, POLICY_CURRENT_FILE);
    this.historyPath = path.join(options.dataDir, POLICY_HISTORY_FILE);
    this.countersPath = path.join(options.dataDir, COUNTERS_FILE);
    this.now = options.now ?? ((): number => Date.now());
    const maxHistory =
      options.maxHistory === undefined || !Number.isFinite(options.maxHistory)
        ? DEFAULT_MAX_HISTORY
        : Math.max(1, Math.floor(options.maxHistory));
    this.maxHistory = maxHistory;
    this.countersValue = defaultCounters(this.now());
  }

  /** Open the store and recover current policy, history and counters. */
  static async open(options: PolicyStoreOptions): Promise<PolicyStore> {
    const store = new PolicyStore(options);
    await ensureDir(store.dataDir);
    for (const removed of await sweepTempFiles(store.dataDir)) {
      store.pushDiagnostic('persistence: removed stale temp file ' + removed);
    }

    const current = await readJsonRecovering(store.currentPath, parseCurrentEnvelope);
    store.currentValue = current.value;
    store.collectRecovery(current.quarantinedPath, current.diagnostics);

    const history = await readJsonlRecovering(store.historyPath, (value) =>
      parseRevisionRecord(value)
    );
    store.historyValue = history.records.map((record) => record.policy).slice(-store.maxHistory);
    store.collectRecovery(history.quarantinedPath, history.diagnostics);

    const counters = await readJsonRecovering(store.countersPath, parseCounters);
    store.countersValue = counters.value ?? defaultCounters(store.now());
    store.collectRecovery(counters.quarantinedPath, counters.diagnostics);

    await recordDiagnostics(
      store.dataDir,
      [...current.diagnostics, ...history.diagnostics, ...counters.diagnostics],
      store.now
    );

    return store;
  }

  /** Diagnostics produced by startup recovery and background writes. */
  get diagnostics(): readonly string[] {
    return this.diagnosticsSink;
  }

  /** Paths of files quarantined as '.corrupt'. */
  get quarantinedPaths(): readonly string[] {
    return this.quarantinePaths;
  }

  /** Active policy, or undefined when none was ever persisted. */
  get current(): MetaSearchPolicy | undefined {
    return this.currentValue;
  }

  /** Accepted revisions, oldest first. */
  get history(): readonly MetaSearchPolicy[] {
    return this.historyValue;
  }

  /** Current counter snapshot. */
  get counters(): PersistedCounters {
    return this.countersValue;
  }

  /**
   * Persist the active policy atomically. Invalid policies are rejected before
   * any byte is written, so a caller bug can never corrupt the snapshot.
   */
  async saveCurrent(policy: MetaSearchPolicy): Promise<void> {
    assertValidPolicy(policy);
    this.currentValue = policy;
    const envelope: CurrentPolicyEnvelope = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      savedAt: this.now(),
      policy
    };
    await this.enqueue(() => writeFileAtomic(this.currentPath, JSON.stringify(envelope)));
  }

  /** Append a policy revision to the audit log, trimming the retained window. */
  async recordRevision(policy: MetaSearchPolicy): Promise<void> {
    assertValidPolicy(policy);
    const record: PolicyRevisionRecord = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      at: this.now(),
      policy
    };
    this.historyValue.push(policy);
    await this.enqueue(async () => {
      await appendFileDurable(this.historyPath, encodeJsonlRecord(record));
      if (this.historyValue.length > this.maxHistory) {
        const retained = this.historyValue.slice(-this.maxHistory);
        await writeFileAtomic(
          this.historyPath,
          retained
            .map((entry) =>
              encodeJsonlRecord({
                schemaVersion: PERSISTENCE_SCHEMA_VERSION,
                at: this.now(),
                policy: entry
              } satisfies PolicyRevisionRecord)
            )
            .join('')
        );
        this.historyValue = retained;
      }
    });
  }

  /** Convenience: snapshot the active policy and audit the revision. */
  async savePolicy(policy: MetaSearchPolicy): Promise<void> {
    await this.saveCurrent(policy);
    await this.recordRevision(policy);
  }

  /**
   * Resolve the policy a restarted host should resume with: the persisted
   * current policy, else the newest persisted revision, else the caller's
   * fallback (a fresh pi^0 when even that is absent).
   */
  async restore(fallback?: MetaSearchPolicy): Promise<MetaSearchPolicy> {
    if (this.currentValue !== undefined) {
      return this.currentValue;
    }
    const last = this.historyValue[this.historyValue.length - 1];
    if (last !== undefined) {
      this.pushDiagnostic(
        'persistence: no current policy snapshot was found; resumed the newest persisted revision ' +
          last.id +
          '@' +
          String(last.version)
      );
      return last;
    }
    return fallback ?? createDefaultPolicy({}, this.now);
  }

  /** Increment the completed-task counter and persist it before resolving. */
  async recordCompletedTask(by?: number): Promise<number> {
    const delta = normalizeDelta(by);
    await this.enqueue(async () => {
      this.countersValue = {
        ...this.countersValue,
        completedTasks: this.countersValue.completedTasks + delta,
        updatedAt: this.now()
      };
      await writeFileAtomic(this.countersPath, JSON.stringify(this.countersValue));
    });
    return this.countersValue.completedTasks;
  }

  /** Record that an offline dream ran; feeds the dream audit counter. */
  async recordDream(by?: number): Promise<number> {
    const delta = normalizeDelta(by);
    await this.enqueue(async () => {
      this.countersValue = {
        ...this.countersValue,
        dreams: this.countersValue.dreams + delta,
        updatedAt: this.now()
      };
      await writeFileAtomic(this.countersPath, JSON.stringify(this.countersValue));
    });
    return this.countersValue.dreams;
  }

  /**
   * Mirrors the orchestrator cadence: a host that has completed a positive
   * multiple of everyNTasks should dream now. The persisted count makes this
   * decision continuous across restarts.
   */
  shouldDream(everyNTasks: number): boolean {
    if (!Number.isFinite(everyNTasks) || everyNTasks <= 0) {
      return false;
    }
    return this.countersValue.completedTasks > 0 && this.countersValue.completedTasks % everyNTasks === 0;
  }

  /** Reset both counters to zero and persist the reset. */
  async resetCounters(): Promise<void> {
    await this.enqueue(async () => {
      this.countersValue = defaultCounters(this.now());
      await writeFileAtomic(this.countersPath, JSON.stringify(this.countersValue));
    });
  }

  /** Wait until every queued write has settled. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task).catch((error) => {
      this.pushDiagnostic(
        'persistence: policy store write failed: ' + (error instanceof Error ? error.message : String(error))
      );
    });
    this.queue = next;
    return next;
  }

  private collectRecovery(quarantinedPath: string | undefined, diagnostics: readonly string[]): void {
    if (quarantinedPath !== undefined) {
      this.quarantinePaths.push(quarantinedPath);
    }
    for (const diagnostic of diagnostics) {
      this.pushDiagnostic(diagnostic);
    }
  }

  private pushDiagnostic(message: string): void {
    this.diagnosticsSink.push(message);
  }
}

function assertValidPolicy(policy: MetaSearchPolicy): void {
  const issues = validatePolicy(policy);
  if (issues.length > 0) {
    throw new PolicyValidationError(issues);
  }
}

/** Options for wrapping an ActivePolicy with persistence. */
export interface PersistentActivePolicyOptions {
  /** Also append accepted revisions to the history log; defaults to true. */
  readonly recordRevision?: boolean;
}

/**
 * ActivePolicy decorator: every accepted update() through the policy is written
 * to the store, so a restart resumes from the evolved policy pi_t rather than
 * resetting to pi^0. planGrid/selectBatch stay pure delegation.
 */
export class PersistentActivePolicy implements ActivePolicy {
  private readonly store: PolicyStore;
  private readonly base: ActivePolicy;
  private readonly recordRevisions: boolean;

  constructor(store: PolicyStore, base: ActivePolicy, options: PersistentActivePolicyOptions = {}) {
    this.store = store;
    this.base = base;
    this.recordRevisions = options.recordRevision !== false;
  }

  get policy(): MetaSearchPolicy {
    return this.base.policy;
  }

  get appliedPolicyIds(): readonly string[] {
    return this.base.appliedPolicyIds;
  }

  planGrid(request: PlanGridRequest): SearchGridPlan {
    return this.base.planGrid(request);
  }

  selectBatch(request: SelectBatchRequest): BatchPlan {
    return this.base.selectBatch(request);
  }

  update(policy: MetaSearchPolicy): void {
    this.base.update(policy);
    // The IActivePolicy contract is synchronous; persistence is queued and
    // awaited by flush(). Write failures become diagnostics rather than escapes.
    void (this.recordRevisions ? this.store.savePolicy(policy) : this.store.saveCurrent(policy));
  }

  /** Durability barrier for the writes queued by update(). */
  async flush(): Promise<void> {
    await this.store.flush();
  }
}

/** Wrap an ActivePolicy so its updates survive a restart. */
export function createPersistentActivePolicy(
  store: PolicyStore,
  base: ActivePolicy,
  options: PersistentActivePolicyOptions = {}
): PersistentActivePolicy {
  return new PersistentActivePolicy(store, base, options);
}