/**
 * Persistence layer barrel and the minimal injection seam for src/index.ts and
 * src/orchestrator.ts (P0-4).
 *
 * Ownership: src/persistence/** (persistence engineer). The module reuses the
 * frozen contracts in src/types/contracts and the MetaSearchPolicy checker in
 * src/dream-rsi; it touches no host, network or sandbox API.
 *
 * Wiring the runtime into the plugin (three lines, no contract change):
 *
 *   const persistence = await createPersistenceRuntime({
 *     profile: process.env.DSH_PROFILE,
 *     maxTrees: config.dreamRsi.maxTreePoolSize
 *   });
 *   const restoredPolicy = await persistence.policyStore.restore();
 *   const deps = {
 *     treePool: persistence.treePool,
 *     policy: persistence.wrapPolicy(createActivePolicy({ policy: restoredPolicy, now }))
 *   };
 *
 * The orchestrator already accepts both through EvoHarnessOrchestratorDeps, so no
 * mutable contract is widened. Counters are wired by replacing the private
 * `this.count` gate with `persistence.policyStore.shouldDream(everyNTasks)` and
 * calling `recordCompletedTask()` when a run finalizes. flush() is the durability
 * barrier; dispose() also flushes.
 */

import {
  DEFAULT_PROFILE_NAME,
  DSH_DATA_ROOT_ENV,
  DSH_PROFILE_ENV,
  EVO_HARNESS_DATA_ROOT_ENV,
  EVO_HARNESS_DATA_SUBDIR,
  PERSISTENCE_SCHEMA_VERSION,
  ensureDir,
  resolveProfileDataDir
} from './data-dir';
import type { ProfileDataDirOptions } from './data-dir';
import { PersistentTreePool, TreePoolStore } from './tree-pool.store';
import { PolicyStore, PersistentActivePolicy } from './policy.store';
import type { PersistentActivePolicyOptions } from './policy.store';
import type { ActivePolicy } from '../dream-rsi/active-policy';
import type { MetaSearchPolicy } from '../types/contracts';

export * from './data-dir';
export * from './tree-pool.store';
export * from './policy.store';

/** Options accepted by createPersistenceRuntime. */
export interface PersistenceRuntimeOptions {
  /** DSH profile whose data directory is used; DSH_PROFILE is the fallback. */
  readonly profile?: string;
  /** Explicit final data directory (wins over profile/rootDir). */
  readonly dataDir?: string;
  /** Persistence root that contains 'profiles/<name>'. */
  readonly rootDir?: string;
  /** Environment snapshot for the fallback lookups; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Retained historical trees; configuration dreamRsi.maxTreePoolSize. */
  readonly maxTrees?: number;
  /** Retained policy revisions; defaults to 50. */
  readonly maxHistory?: number;
  /** Compact the tree log after this many raw records. */
  readonly compactAfterRecords?: number;
  readonly now?: () => number;
}

/**
 * Fully recovered persistence runtime. `treePool` and `wrapPolicy(...)` are the
 * injection points the orchestrator consumes; the stores remain accessible for
 * counter bookkeeping and diagnostics.
 */
export interface PersistenceRuntime {
  readonly dataDir: string;
  readonly treePoolStore: TreePoolStore;
  readonly treePool: PersistentTreePool;
  readonly policyStore: PolicyStore;
  /** Recovery/write diagnostics from both stores, in creation order. */
  readonly diagnostics: readonly string[];
  /** Wrap an ActivePolicy so update() persists; injection point for deps.policy. */
  wrapPolicy(base: ActivePolicy, options?: PersistentActivePolicyOptions): PersistentActivePolicy;
  /** Durability barrier for queued tree/policy/counter writes. */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Resolve the profile data directory, recover the persisted TreePool and policy
 * state, and return the injectable runtime. Startup never throws because of a
 * damaged persistence file: it is quarantined and reported in diagnostics.
 */
export async function createPersistenceRuntime(
  options: PersistenceRuntimeOptions = {}
): Promise<PersistenceRuntime> {
  const dataDir = resolveProfileDataDir(options);
  const now = options.now ?? ((): number => Date.now());
  await ensureDir(dataDir);

  const treeOptions = {
    dataDir,
    now,
    ...(options.compactAfterRecords === undefined
      ? {}
      : { compactAfterRecords: options.compactAfterRecords })
  };
  const treePoolStore = await TreePoolStore.open(treeOptions);
  const treePool = await PersistentTreePool.fromStore(treePoolStore, options.maxTrees);

  const policyStore = await PolicyStore.open({
    dataDir,
    now,
    ...(options.maxHistory === undefined ? {} : { maxHistory: options.maxHistory })
  });

  const diagnostics: readonly string[] = [...treePool.diagnostics, ...policyStore.diagnostics];
  return {
    dataDir,
    treePoolStore,
    treePool,
    policyStore,
    diagnostics,
    wrapPolicy: (base: ActivePolicy, policyOptions: PersistentActivePolicyOptions = {}) =>
      new PersistentActivePolicy(policyStore, base, policyOptions),
    async flush(): Promise<void> {
      await treePool.flush();
      await policyStore.flush();
    },
    async dispose(): Promise<void> {
      await treePool.flush();
      await policyStore.flush();
    }
  };
}

/** Re-exported constants so hosts can document the data layout. */
export const PERSISTENCE_DEFAULTS = {
  schemaVersion: PERSISTENCE_SCHEMA_VERSION,
  defaultProfile: DEFAULT_PROFILE_NAME,
  subdir: EVO_HARNESS_DATA_SUBDIR,
  dataRootEnv: EVO_HARNESS_DATA_ROOT_ENV,
  dshDataRootEnv: DSH_DATA_ROOT_ENV,
  profileEnv: DSH_PROFILE_ENV
} as const;

/** Re-exported option type for callers that resolve the directory themselves. */
export type PersistenceDataDirOptions = ProfileDataDirOptions;

/** Convenience: resolve the directory without opening any store. */
export function resolvePersistenceDataDir(options: PersistenceRuntimeOptions = {}): string {
  return resolveProfileDataDir(options);
}

/** Convenience type used by callers that restore a policy explicitly. */
export type PersistedPolicy = MetaSearchPolicy;