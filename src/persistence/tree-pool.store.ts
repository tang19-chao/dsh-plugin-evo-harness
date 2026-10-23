/**
 * Durable DiscoveryTreePool persistence (P0-4).
 *
 * The offline dreamer replays historical trees, so the pool must survive a host
 * restart. This module stores it as an append-only JSONL event log
 * ('tree-pool.jsonl') whose records are:
 *
 *   { kind: 'tree',   tree: DiscoveryTreeSnapshot, at }
 *   { kind: 'remove', treeIds: string[],           at }
 *   { kind: 'clear',                               at }
 *
 * Mutations update the in-memory pool immediately and are appended to the log
 * through a serialized write queue, so the synchronous IDiscoveryTreePool
 * contract is preserved and `flush()` still gives a caller a durability point.
 * The log is compacted atomically (temp file + rename) once it grows past a
 * threshold, which keeps a long-lived host from writing an unbounded file.
 *
 * On startup every record is replayed in order into a fresh pool. A damaged or
 * partially written log is recovered by keeping the healthy prefix, quarantining
 * the original bytes as '<name>.corrupt' and recording a diagnostic (see
 * ./data-dir.ts for the exact recovery policy).
 *
 * Ownership: src/persistence/** (persistence engineer). Reuses the frozen
 * IDiscoveryTreePool / DiscoveryTreeSnapshot contracts from src/types/contracts
 * and the createDiscoveryTreePool factory from src/dream-rsi.
 */

import path from 'node:path';

import {
  BATCH_SLOT_KINDS,
  PATCH_ORIGINS,
  PATCH_PURPOSES,
  type DiscoveryNode,
  type DiscoveryTreeSnapshot,
  type DiscoveryTreeStats,
  type GuidanceMode,
  type IDiscoveryTreePool
} from '../types/contracts';
import {
  appendFileDurable,
  encodeJsonlRecord,
  ensureDir,
  readJsonlRecovering,
  recordDiagnostics,
  sweepTempFiles,
  writeFileAtomic
} from './data-dir';
import { createDiscoveryTreePool } from '../dream-rsi/discovery-tree';

/** JSONL file name inside the profile data directory. */
export const TREE_POOL_LOG_FILE = 'tree-pool.jsonl';

/** Default number of raw log records kept before an atomic compaction. */
export const DEFAULT_COMPACT_AFTER_RECORDS = 512;

const DISCOVERY_NODE_STATUSES = [
  'proposed',
  'scheduled',
  'probing',
  'succeeded',
  'failed',
  'pruned'
] as const;

const GUIDANCE_MODES: readonly GuidanceMode[] = ['memory', 'guidance_free'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Structural validation of one persisted discovery node. */
export function isDiscoveryNode(value: unknown): value is DiscoveryNode {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.treeId) &&
    (value.parentId === null || isNonEmptyString(value.parentId)) &&
    isFiniteNumber(value.depth) &&
    value.depth >= 0 &&
    isNonEmptyString(value.branchId) &&
    isNonEmptyString(value.patchId) &&
    isMember(value.patchOrigin, PATCH_ORIGINS) &&
    isMember(value.purpose, PATCH_PURPOSES) &&
    isMember(value.guidance, GUIDANCE_MODES) &&
    isMember(value.status, DISCOVERY_NODE_STATUSES) &&
    isStringArray(value.childIds) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    (value.slot === undefined || isMember(value.slot, BATCH_SLOT_KINDS)) &&
    (value.round === undefined || isFiniteNumber(value.round)) &&
    (value.trajectoryId === undefined || isNonEmptyString(value.trajectoryId)) &&
    (value.score === undefined || isFiniteNumber(value.score)) &&
    (value.adoptionRatio === undefined || isFiniteNumber(value.adoptionRatio)) &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function isDiscoveryTreeStats(value: unknown): value is DiscoveryTreeStats {
  return (
    isRecord(value) &&
    isFiniteNumber(value.nodeCount) &&
    isFiniteNumber(value.maxDepth) &&
    isFiniteNumber(value.maxWidth) &&
    isFiniteNumber(value.scoredNodes) &&
    isFiniteNumber(value.completedNodes)
  );
}

/**
 * Structural validation of one persisted tree snapshot. The root node must be
 * present, otherwise restoring the tree would be impossible.
 */
export function isDiscoveryTreeSnapshot(value: unknown): value is DiscoveryTreeSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.taskId) ||
    !isNonEmptyString(value.rootId) ||
    !isRecord(value.nodes) ||
    !isDiscoveryTreeStats(value.stats) ||
    typeof value.completed !== 'boolean' ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    (value.policyId !== undefined && !isNonEmptyString(value.policyId)) ||
    (value.metadata !== undefined && !isRecord(value.metadata))
  ) {
    return false;
  }
  const nodes = value.nodes;
  const root = nodes[value.rootId];
  if (root === undefined || !isDiscoveryNode(root)) {
    return false;
  }
  for (const node of Object.values(nodes)) {
    if (!isDiscoveryNode(node)) {
      return false;
    }
  }
  return true;
}

/** One record of the tree-pool JSONL event log. */
export type TreePoolRecord =
  | { readonly kind: 'tree'; readonly tree: DiscoveryTreeSnapshot; readonly at: number }
  | { readonly kind: 'remove'; readonly treeIds: readonly string[]; readonly at: number }
  | { readonly kind: 'clear'; readonly at: number };

/** Structural validation of one persisted log record. */
export function isTreePoolRecord(value: unknown): value is TreePoolRecord {
  if (!isRecord(value) || !isFiniteNumber(value.at)) {
    return false;
  }
  if (value.kind === 'tree') {
    return isDiscoveryTreeSnapshot(value.tree);
  }
  if (value.kind === 'remove') {
    return isStringArray(value.treeIds) && value.treeIds.length > 0;
  }
  return value.kind === 'clear';
}

/**
 * Fold an event log into the minimal record list that replays to the same pool
 * state: last write wins per tree id, removals and clears are applied in order.
 */
export function minimizeTreePoolRecords(
  records: readonly TreePoolRecord[]
): readonly TreePoolRecord[] {
  const trees = new Map<string, DiscoveryTreeSnapshot>();
  for (const record of records) {
    if (record.kind === 'tree') {
      // delete+set makes re-adding an existing tree move it to the end, matching
      // the least-recently-added eviction order of the in-memory pool.
      trees.delete(record.tree.id);
      trees.set(record.tree.id, record.tree);
    } else if (record.kind === 'remove') {
      for (const treeId of record.treeIds) {
        trees.delete(treeId);
      }
    } else {
      trees.clear();
    }
  }
  const minimized: TreePoolRecord[] = [];
  for (const tree of trees.values()) {
    minimized.push({ kind: 'tree', tree, at: tree.updatedAt });
  }
  return minimized;
}

/** Construction options for a TreePoolStore. */
export interface TreePoolStoreOptions {
  /** Profile data directory (see resolveProfileDataDir). */
  readonly dataDir: string;
  /** Override the JSONL file name; defaults to TREE_POOL_LOG_FILE. */
  readonly fileName?: string;
  readonly now?: () => number;
  /** Compact after this many raw records; defaults to 512. */
  readonly compactAfterRecords?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cheap structural equality for two tree snapshots. */
function sameTreeSnapshot(left: DiscoveryTreeSnapshot, right: DiscoveryTreeSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Durable store for the historical discovery-tree pool. Instances are created
 * through open(), which performs startup recovery.
 */
export class TreePoolStore {
  readonly dataDir: string;
  readonly logPath: string;
  private readonly now: () => number;
  private readonly compactAfterRecords: number;
  private readonly diagnosticsSink: string[] = [];
  private readonly quarantinePaths: string[] = [];
  private records: TreePoolRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private repaired = false;
  private loadRecordCount = 0;

  private constructor(options: TreePoolStoreOptions) {
    this.dataDir = options.dataDir;
    this.logPath = path.join(options.dataDir, options.fileName ?? TREE_POOL_LOG_FILE);
    this.now = options.now ?? ((): number => Date.now());
    const threshold =
      options.compactAfterRecords === undefined || !Number.isFinite(options.compactAfterRecords)
        ? DEFAULT_COMPACT_AFTER_RECORDS
        : Math.max(2, Math.floor(options.compactAfterRecords));
    this.compactAfterRecords = threshold;
  }

  /** Open the store, recover a damaged log and report what happened. */
  static async open(options: TreePoolStoreOptions): Promise<TreePoolStore> {
    const store = new TreePoolStore(options);
    await ensureDir(store.dataDir);
    for (const removed of await sweepTempFiles(store.dataDir)) {
      store.pushDiagnostic('persistence: removed stale temp file ' + removed);
    }
    const recovery = await readJsonlRecovering(store.logPath, (value) =>
      isTreePoolRecord(value) ? value : undefined
    );
    store.records = [...recovery.records];
    store.loadRecordCount = recovery.records.length;
    store.repaired = recovery.repaired;
    if (recovery.quarantinedPath !== undefined) {
      store.quarantinePaths.push(recovery.quarantinedPath);
    }
    for (const diagnostic of recovery.diagnostics) {
      store.pushDiagnostic(diagnostic);
    }
    await recordDiagnostics(store.dataDir, recovery.diagnostics, store.now);
    return store;
  }

  /** Diagnostics produced by startup recovery and background writes. */
  get diagnostics(): readonly string[] {
    return this.diagnosticsSink;
  }

  /** Paths of files quarantined as '.corrupt' during load or writes. */
  get quarantinedPaths(): readonly string[] {
    return this.quarantinePaths;
  }

  /** True when startup recovery had to repair or quarantine the log. */
  get repairedOnLoad(): boolean {
    return this.repaired;
  }

  /** Number of records replayed at open() time. */
  get loadedRecords(): number {
    return this.loadRecordCount;
  }

  /** Current in-memory record list (raw events, not minimized). */
  allRecords(): readonly TreePoolRecord[] {
    return this.records;
  }

  /** Record an operational diagnostic in memory and in the on-disk log. */
  noteDiagnostic(message: string): void {
    this.pushDiagnostic(message);
    void this.enqueue(() => recordDiagnostics(this.dataDir, [message], this.now));
  }

  /** Append one tree upsert and return when it is durable. */
  append(tree: DiscoveryTreeSnapshot): Promise<void> {
    const record: TreePoolRecord = { kind: 'tree', tree, at: this.now() };
    this.records.push(record);
    return this.enqueueAppend(record);
  }

  /** Append a removal record for the given tree ids. */
  remove(treeIds: readonly string[]): Promise<void> {
    if (treeIds.length === 0) {
      return this.flush();
    }
    const record: TreePoolRecord = { kind: 'remove', treeIds: [...treeIds], at: this.now() };
    this.records.push(record);
    return this.enqueueAppend(record);
  }

  /** Append a clear record that resets the pool on replay. */
  clear(): Promise<void> {
    const record: TreePoolRecord = { kind: 'clear', at: this.now() };
    this.records.push(record);
    return this.enqueueAppend(record);
  }

  /** Atomically rewrite the log as its minimized record set. */
  compact(): Promise<void> {
    return this.enqueue(() => this.writeMinimized());
  }

  /** Wait until every queued write has settled. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Replay the recovered log into a fresh pool. Trees are added in record order;
   * remove/clear records are applied in order; the resulting pool is then clipped
   * to maxTrees (returning the evicted ids, which are already reflected in the
   * persisted log if the caller persists through PersistentTreePool).
   */
  async replayInto(
    pool: IDiscoveryTreePool,
    maxTrees?: number
  ): Promise<{ readonly added: number; readonly removed: readonly string[] }> {
    // The IDiscoveryTreePool contract exposes no remove(id), so the final state
    // is computed by folding the log (last write per id wins, remove/clear
    // applied in order) and then adding those trees in replay order.
    const minimized = minimizeTreePoolRecords(this.records);
    for (const record of minimized) {
      if (record.kind === 'tree') {
        pool.add(record.tree);
      }
    }
    if (maxTrees !== undefined && maxTrees > 0) {
      return { added: minimized.length, removed: pool.pruneTo(maxTrees) };
    }
    return { added: minimized.length, removed: [] };
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task).catch((error) => {
      this.pushDiagnostic('persistence: tree-pool write failed: ' + errorMessage(error));
    });
    this.queue = next;
    return next;
  }

  /**
   * Queue one record append. A record that a compaction already absorbed (its
   * effect is in the rewritten file) must not be appended again, otherwise the
   * log would grow with superseded events.
   */
  private enqueueAppend(record: TreePoolRecord): Promise<void> {
    return this.enqueue(async () => {
      if (this.records.includes(record)) {
        await appendFileDurable(this.logPath, encodeJsonlRecord(record));
      }
      if (this.records.length >= this.compactAfterRecords) {
        await this.writeMinimized();
      }
    });
  }

  private async writeMinimized(): Promise<void> {
    const snapshot = [...this.records];
    if (snapshot.length === 0) {
      return;
    }
    const minimized = minimizeTreePoolRecords(snapshot);
    await writeFileAtomic(this.logPath, minimized.map(encodeJsonlRecord).join(''));
    // Only the records this compaction absorbed are replaced; anything appended
    // while the atomic write was in flight stays queued after the minimized set.
    const absorbed = new Set<TreePoolRecord>(snapshot);
    const remaining = this.records.filter((record) => !absorbed.has(record));
    this.records = [...minimized, ...remaining];
  }

  private pushDiagnostic(message: string): void {
    this.diagnosticsSink.push(message);
  }
}

/** Options for opening a persistent pool. */
export interface PersistentTreePoolOptions extends TreePoolStoreOptions {
  /** Bound on retained trees; configuration maxTreePoolSize by default. */
  readonly maxTrees?: number;
}

/**
 * IDiscoveryTreePool implementation that writes every mutation through to a
 * TreePoolStore. Mutations stay synchronous (the contract is synchronous) and
 * are queued for durability; flush() is the explicit durability barrier.
 */
export class PersistentTreePool implements IDiscoveryTreePool {
  private readonly store: TreePoolStore;
  private readonly base: IDiscoveryTreePool;
  private readonly maxTrees: number | undefined;

  private constructor(
    store: TreePoolStore,
    base: IDiscoveryTreePool,
    maxTrees: number | undefined
  ) {
    this.store = store;
    this.base = base;
    this.maxTrees = maxTrees;
  }

  /**
   * Open the store, replay the recovered log into a fresh pool and wrap it.
   * The returned pool already contains every tree that survived the restart.
   */
  static async restore(options: PersistentTreePoolOptions): Promise<PersistentTreePool> {
    const store = await TreePoolStore.open(options);
    return PersistentTreePool.fromStore(store, options.maxTrees);
  }

  /**
   * Wrap an already-open store: the recovered log is replayed into a fresh pool,
   * so the returned pool holds every tree that survived the restart.
   */
  static async fromStore(store: TreePoolStore, maxTrees?: number): Promise<PersistentTreePool> {
    const base = createDiscoveryTreePool({});
    await store.replayInto(base, maxTrees);
    return new PersistentTreePool(store, base, maxTrees);
  }

  /** Diagnostics collected from recovery and background writes. */
  get diagnostics(): readonly string[] {
    return this.store.diagnostics;
  }

  get quarantinedPaths(): readonly string[] {
    return this.store.quarantinedPaths;
  }

  get storeRef(): TreePoolStore {
    return this.store;
  }

  add(tree: DiscoveryTreeSnapshot): void {
    const existing = this.base.get(tree.id);
    if (existing !== undefined && !sameTreeSnapshot(existing, tree)) {
      // The IDiscoveryTreePool contract is upsert-by-id, so the new snapshot wins.
      // A restarted host whose id factory restarts at 1 would otherwise silently
      // destroy a persisted tree; report it instead of hiding the overwrite.
      this.store.noteDiagnostic(
        'persistence: tree id collision for ' +
          tree.id +
          '; a persisted tree with the same id was overwritten by a different snapshot'
      );
    }
    this.base.add(tree);
    void this.store.append(tree);
    if (this.maxTrees !== undefined && this.maxTrees > 0 && this.base.size() > this.maxTrees) {
      const removed = this.base.pruneTo(this.maxTrees);
      if (removed.length > 0) {
        void this.store.remove(removed);
      }
    }
  }

  get(treeId: string): DiscoveryTreeSnapshot | undefined {
    return this.base.get(treeId);
  }

  list(): readonly DiscoveryTreeSnapshot[] {
    return this.base.list();
  }

  size(): number {
    return this.base.size();
  }

  pruneTo(maxTrees: number): readonly string[] {
    const removed = this.base.pruneTo(maxTrees);
    if (removed.length > 0) {
      void this.store.remove(removed);
    }
    return removed;
  }

  clear(): void {
    this.base.clear();
    void this.store.clear();
  }

  /** Durability barrier: resolves once every queued mutation is on disk. */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  /** Force an atomic log compaction. */
  async compact(): Promise<void> {
    await this.store.compact();
  }
}

/** Restore report returned by restoreTreePool(). */
export interface TreePoolRestoreResult {
  readonly pool: PersistentTreePool;
  readonly store: TreePoolStore;
  readonly added: number;
  readonly removed: readonly string[];
  readonly diagnostics: readonly string[];
  readonly quarantinedPaths: readonly string[];
}

/**
 * Minimal injection seam for src/index.ts / src/orchestrator.ts: restore a pool
 * from the profile data directory and hand it to the orchestrator as its
 * `treePool` dependency. A PersistentTreePool is used so later mutations keep
 * being persisted without touching the orchestrator.
 */
export async function restoreTreePool(
  options: PersistentTreePoolOptions
): Promise<TreePoolRestoreResult> {
  const store = await TreePoolStore.open(options);
  const persistent = await PersistentTreePool.fromStore(store, options.maxTrees);
  const minimized = minimizeTreePoolRecords(store.allRecords());
  const kept = new Set(persistent.list().map((tree) => tree.id));
  const removed: string[] = [];
  for (const record of minimized) {
    if (record.kind === 'tree' && !kept.has(record.tree.id)) {
      removed.push(record.tree.id);
    }
  }
  return {
    pool: persistent,
    store,
    added: minimized.length,
    removed,
    diagnostics: store.diagnostics,
    quarantinedPaths: store.quarantinedPaths
  };
}

/** Persist an already-loaded pool into the store (first-run bootstrap). */
export async function persistExistingTreePool(
  store: TreePoolStore,
  pool: IDiscoveryTreePool
): Promise<void> {
  for (const tree of pool.list()) {
    await store.append(tree);
  }
  await store.flush();
}