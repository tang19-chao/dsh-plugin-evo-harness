/**
 * JitRL kernel barrel and its composition root (plan sections 4.2 and 8).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel + Phase 2 L1).
 *
 * Every kernel module is a pure function set or a factory with injected
 * collaborators; createJitRl() is the single place that wires them together from
 * config.jitrl. Nothing here reaches for the network, the host or the sandbox.
 *
 * Two design choices keep the composition root usable from a synchronous plugin
 * constructor:
 *
 * - The store is a stable facade over a swappable drive. Construction installs
 *   the in-memory drive, so the plugin can wrap its ActivePolicy immediately;
 *   hydrate() later opens the durable JSONL log, replays it and swaps the drive
 *   without rebuilding anything that captured the facade.
 * - Only the logit source needs I/O (one capability probe), so it is created
 *   lazily through getLogitSource(). The L1 meta decision point uses
 *   policyPriorLogit() directly and never waits on a model probe.
 *
 * Fail-soft: a durable-store or backfill failure degrades to the in-memory drive
 * and records a diagnostic instead of aborting the plugin.
 */

import type { EvoHarnessConfig, JitRlConfig } from '../config';
import { BATCH_SLOT_KINDS } from '../types/contracts';
import type {
  AbstractState,
  BatchSlotKind,
  ExperienceQuery,
  ExperienceRecord,
  GuidanceMode,
  IExperienceStore,
  IModelAdapter,
  IStepEvaluator,
  JitCandidate,
  JitDecision,
  JitLevel,
  JitReplayAdjustment,
  JitReplayHook,
  JitReplayHookDiagnostics,
  JitReplayHookInput,
  JitReplayHookResult,
  JitStatsAggregate,
  MetaSearchPolicy,
  ScoredExperience
} from '../types/contracts';
import { decide } from './logit-adjuster';
import { createAutoLogitSource, type AutoLogitSource, type LogprobCapabilities } from './logit-sources';
import { createStepEvaluator, type JitStepEvaluator } from './step-evaluator';
import { backfillFromTreePool, type BackfillResult, type BackfillTreeSource } from './backfill';
import {
  createJitActivePolicy,
  type JitActivePolicy,
  type JitActivePolicyOptions
} from './jit-active-policy';
import { createMemoryExperienceStore, type MemoryExperienceStore } from './stores/memory.store';
import type { ExperienceStoreFs, JsonlExperienceStore } from './stores/jsonl.store';
import { driftFactorFor } from './retriever';
import { normalizeAdvantages } from './value-estimator';
import { slotKindOfActionKey } from './jit-active-policy';
import { createHostAdvisor, type HostAdvisor } from './host-advisor';
import {
  createJitBridgeMirrorStore,
  type BridgeMirrorStore,
  type JitMirrorMcpClient
} from './stores/bridge.store';

/** Half-life in ms derived from config; 0 days disables the decay. */
export function halfLifeMsFromConfig(jitrl: JitRlConfig): number {
  const days = jitrl.store.halfLifeDays;
  if (!Number.isFinite(days) || days <= 0) {
    return 0;
  }
  return days * 24 * 60 * 60 * 1000;
}

/** Diagnostic sink shape shared by the kernel factories. */
export interface JitRlDiagnostic {
  readonly level: 'info' | 'warn';
  readonly code: string;
  readonly message: string;
}

/** A drive is either the memory store or the JSONL store; both expose snapshot(). */
type StoreDrive = (IExperienceStore | JsonlExperienceStore | MemoryExperienceStore) & {
  snapshot?(): readonly ExperienceRecord[];
  load?(): Promise<number>;
  flush?(): Promise<void>;
  purge?(options?: { readonly bucket?: string }): Promise<number>;
};

/** Options for the JitRL composition root. */
export interface JitRlFactoryOptions {
  /** Fully resolved plugin configuration (config.jitrl is read). */
  readonly config: EvoHarnessConfig;
  /** Override config.jitrl (defaults to config.jitrl). */
  readonly jitrl?: JitRlConfig;
  /** Injected clock shared by every kernel component. */
  readonly now?: () => number;
  /** Injected randomness for optimistic exploration and sampling. */
  readonly rng?: () => number;
  /** Optional model adapter for the token logprob probe and the step judge. */
  readonly model?: IModelAdapter;
  /** Surrogate value provider adapted from ISurrogateScorer by the caller. */
  readonly surrogate?: (
    trajectory: Parameters<IStepEvaluator['evaluate']>[0],
    reference?: Parameters<IStepEvaluator['evaluate']>[0]
  ) => number | undefined;
  /** Diagnostic sink; every notice is also kept in diagnostics(). */
  readonly onDiagnostic?: (diagnostic: JitRlDiagnostic) => void;
}

/** Extra storage wired in after construction (persistence is resolved async). */
export interface JitRlHydrateOptions {
  /** Absolute path of the JSONL experience log; absent keeps memory only. */
  readonly filePath?: string;
  /** Historical trees converted into L1 experiences (cold start). */
  readonly pool?: BackfillTreeSource;
  /** Injected filesystem for the JSONL drive (tests supply a fake). */
  readonly fs?: ExperienceStoreFs;
  /** Skip the durable drive and only backfill into memory. */
  readonly skipDurableStore?: boolean;
}

/** The wired JitRL kernel handed to the plugin. */
export interface JitRl {
  readonly config: JitRlConfig;
  /** Stable experience facade; its drive may be swapped by hydrate(). */
  readonly store: IExperienceStore;
  readonly optimizer: {
    decide<T>(
      level: JitLevel,
      state: AbstractState,
      candidates: readonly JitCandidate<T>[],
      options?: { readonly guidanceFilter?: GuidanceMode; readonly rng?: () => number }
    ): Promise<JitDecision<T>>;
  };
  readonly stepEvaluator: JitStepEvaluator;
  /** Lazily-created logit source (the token probe needs the model adapter). */
  getLogitSource(): Promise<AutoLogitSource>;
  /** Convert the supplied/known historical trees into L1 experiences. */
  backfill(options?: {
    readonly pool?: BackfillTreeSource;
    readonly gamma?: number;
  }): Promise<BackfillResult>;
  /** Open the durable drive and run the cold-start backfill once. */
  hydrate(options?: JitRlHydrateOptions): Promise<BackfillResult | undefined>;
  /** Wrap an active policy; experiences are read live from the facade. */
  createJitActivePolicy(options: JitActivePolicyOptions): JitActivePolicy;
  /**
   * P4: synchronous Dream-replay simulator over a causal experience snapshot
   * (plan section 7.3-2). The plugin hands it to createOfflineDreamer().
   */
  createReplayHook(options?: { readonly driftRho?: number }): JitReplayHook;
  /** P5-a: L3 host advisor over this kernel's experience store. */
  createHostAdvisor(options?: { readonly rng?: () => number }): HostAdvisor;
  /** P5-b: aggregate-statistics mirror over the configured MCP client. */
  createMirrorStore(options?: { readonly client?: JitMirrorMcpClient }): BridgeMirrorStore;
  /** Synchronous record count (the facade keeps a snapshot). */
  count(level?: JitLevel): number;
  size(level?: JitLevel): Promise<number>;
  /** Persist any buffered durable writes. */
  flush(): Promise<void>;
  diagnostics(): readonly JitRlDiagnostic[];
  /** Records written by backfill in this process. */
  readonly backfilled: number;
  /** True when a durable component degraded to its in-memory fallback. */
  readonly degraded: boolean;
}

/** Resolve config.jitrl into the effective JitRlConfig. */
export function resolveJitRlConfig(config: EvoHarnessConfig, override?: JitRlConfig): JitRlConfig {
  return override ?? config.jitrl;
}

/** True when L1 (meta) scheduling is switched on. */
export function jitMetaEnabled(jitrl: JitRlConfig): boolean {
  return jitrl.enabled && jitrl.levels.includes('meta');
}

/**
 * Compose the kernel from configuration. Synchronous by design: the durable
 * drive and the cold-start backfill are wired later by hydrate().
 */
export function createJitRl(options: JitRlFactoryOptions): JitRl {
  const jitrl = resolveJitRlConfig(options.config, options.jitrl);
  const now = options.now ?? ((): number => Date.now());
  const rng = options.rng ?? ((): number => Math.random());
  const halfLifeMs = halfLifeMsFromConfig(jitrl);
  const diagnostics: JitRlDiagnostic[] = [];
  let degraded = false;
  let backfilled = 0;
  let hydrated = false;
  let knownPool: BackfillTreeSource | undefined;
  let durable: JsonlExperienceStore | undefined;

  const emit = (diagnostic: JitRlDiagnostic): void => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  const openMemory = (): MemoryExperienceStore =>
    createMemoryExperienceStore({
      now,
      halfLifeMs,
      bucketCap: jitrl.store.maxPerBucket,
      onDiagnostic: (diagnostic) => {
        emit({
          level: diagnostic.level === 'warn' ? 'warn' : 'info',
          code: diagnostic.code,
          message: diagnostic.message
        });
      }
    });

  let drive: StoreDrive = openMemory();

  /** Stable facade: every holder keeps working across a drive swap. */
  const store: IExperienceStore & {
    snapshot(): readonly ExperienceRecord[];
    count(level?: JitLevel): number;
    purge(options?: { readonly bucket?: string }): Promise<number>;
  } = {
    async append(records: readonly ExperienceRecord[]): Promise<void> {
      await drive.append(records);
    },
    async query(query: ExperienceQuery): Promise<readonly ScoredExperience[]> {
      return drive.query(query);
    },
    async size(level?: JitLevel): Promise<number> {
      return drive.size(level);
    },
    async compact(compactOptions: {
      readonly maxPerBucket: number;
      readonly halfLifeMs?: number;
    }): Promise<number> {
      return drive.compact(compactOptions);
    },
    async purge(purgeOptions: { readonly bucket?: string } = {}): Promise<number> {
      const purge = drive.purge;
      return typeof purge === 'function' ? purge.call(drive, purgeOptions) : 0;
    },
    export(): AsyncIterable<ExperienceRecord> {
      return drive.export();
    },
    snapshot(): readonly ExperienceRecord[] {
      const snapshot = drive.snapshot;
      return typeof snapshot === 'function' ? snapshot.call(drive) : [];
    },
    count(level?: JitLevel): number {
      const records = store.snapshot();
      return level === undefined ? records.length : records.filter((r) => r.level === level).length;
    }
  };

  const optimizer = createStoreOptimizer({ store, config: jitrl, halfLifeMs, now, rng });

  let logitSource: Promise<AutoLogitSource> | undefined;
  const getLogitSource = (): Promise<AutoLogitSource> => {
    if (logitSource === undefined) {
      const capabilities: LogprobCapabilities = { tokenLogprobs: 'unknown' };
      logitSource = createAutoLogitSource({
        logitSource: jitrl.logitSource,
        ...(options.model === undefined ? {} : { model: options.model }),
        capabilities
      });
    }
    return logitSource;
  };

  const stepEvaluator = createStepEvaluator({
    reward: jitrl.reward,
    privacy: jitrl.privacy,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.surrogate === undefined ? {} : { surrogate: options.surrogate }),
    clock: now,
    rng
  });

  const runBackfill = async (pool: BackfillTreeSource): Promise<BackfillResult> => {
    const result = await backfillFromTreePool({
      pool,
      store,
      now,
      gamma: jitrl.gamma,
      weights: jitrl.reward.weights,
      clip: jitrl.reward.clip
    });
    backfilled += result.appended;
    for (const message of result.diagnostics) {
      emit({ level: 'warn', code: 'jitrl_backfill', message });
    }
    return result;
  };

  const kernel: JitRl = {
    config: jitrl,
    store,
    optimizer,
    stepEvaluator,
    getLogitSource,
    async backfill(backfillOptions = {}): Promise<BackfillResult> {
      const pool = backfillOptions.pool ?? knownPool;
      if (pool === undefined) {
        return {
          records: [],
          recordCount: 0,
          appended: 0,
          skipped: 0,
          unscored: 0,
          treeCount: 0,
          diagnostics: ['jitrl: no tree pool was supplied to backfill']
        };
      }
      knownPool = pool;
      return runBackfill(pool);
    },
    async hydrate(hydrateOptions = {}): Promise<BackfillResult | undefined> {
      if (hydrated) {
        return undefined;
      }
      hydrated = true;
      if (hydrateOptions.pool !== undefined) {
        knownPool = hydrateOptions.pool;
      }
      if (hydrateOptions.filePath !== undefined && hydrateOptions.skipDurableStore !== true) {
        try {
          const { createJsonlExperienceStore } = await import('./stores/jsonl.store');
          durable = await createJsonlExperienceStore({
            filePath: hydrateOptions.filePath,
            now,
            halfLifeMs,
            bucketCap: jitrl.store.maxPerBucket,
            ...(hydrateOptions.fs === undefined ? {} : { fs: hydrateOptions.fs }),
            onDiagnostic: (diagnostic) => {
              emit({
                level: diagnostic.level === 'warn' ? 'warn' : 'info',
                code: diagnostic.code,
                message: diagnostic.message
              });
            }
          });
          const loaded = await durable.load();
          if (loaded > 0) {
            emit({
              level: 'info',
              code: 'jitrl_store_loaded',
              message: 'restored ' + String(loaded) + ' experience record(s) from the log'
            });
          }
          // Swap only after a successful load so a broken log keeps memory.
          drive = durable;
        } catch (error) {
          degraded = true;
          durable = undefined;
          emit({
            level: 'warn',
            code: 'jitrl_store_degraded',
            message:
              'the JSONL experience store could not be opened (' +
              (error instanceof Error ? error.message : String(error)) +
              '); using the in-memory drive for this process'
          });
        }
      }
      if (knownPool === undefined) {
        return undefined;
      }
      return runBackfill(knownPool);
    },
    createJitActivePolicy(policyOptions): JitActivePolicy {
      const callerDiagnostic = policyOptions.onDiagnostic;
      return createJitActivePolicy({
        ...policyOptions,
        // Live snapshot: a backfill that lands after the wrapper exists is
        // immediately visible, so the decorator never needs rebuilding.
        experiences: policyOptions.experiences ?? (() => store.snapshot()),
        config: {
          beta: jitrl.beta,
          k: jitrl.k,
          similarityThreshold: jitrl.similarityThreshold,
          selection: jitrl.selection,
          lambda: jitrl.exploration.lambda,
          alpha: jitrl.exploration.alpha,
          unseenFallback: jitrl.unseenFallback,
          halfLifeMs,
          // Plan section 3.1 action space (G2-1): forwarded so a host that sets
          // jitrl.surfaceActions actually reaches the decorator.
          surfaceActions: jitrl.surfaceActions,
          ...(policyOptions.config ?? {})
        },
        onDiagnostic: (message: string) => {
          emit({ level: 'warn', code: 'jitrl_meta', message });
          callerDiagnostic?.(message);
        }
      });
    },
    count(level?: JitLevel): number {
      return store.count(level);
    },
    createReplayHook(replayOptions = {}): JitReplayHook {
      return createJitReplayHook({
        config: jitrl,
        ...(replayOptions.driftRho === undefined ? {} : { driftRho: replayOptions.driftRho })
      });
    },
    createHostAdvisor(advisorOptions = {}): HostAdvisor {
      return createHostAdvisor({
        config: jitrl,
        store: { query: (query: ExperienceQuery) => store.query(query) },
        now,
        ...(advisorOptions.rng === undefined ? {} : { rng: advisorOptions.rng })
      });
    },
    createMirrorStore(mirrorOptions = {}): BridgeMirrorStore {
      return createJitBridgeMirrorStore({
        mirrorToMemoryBridge: jitrl.store.mirrorToMemoryBridge,
        namespacePrefix: options.config.memoryBridge.namespacePrefix,
        now,
        ...(mirrorOptions.client === undefined ? {} : { client: mirrorOptions.client })
      });
    },
    async size(level?: JitLevel): Promise<number> {
      return store.size(level);
    },
    async flush(): Promise<void> {
      const flush = durable?.flush;
      if (typeof flush === 'function') {
        await flush.call(durable);
      }
    },
    diagnostics(): readonly JitRlDiagnostic[] {
      return [...diagnostics, ...driveDiagnostics()];
    },
    get backfilled(): number {
      return backfilled;
    },
    get degraded(): boolean {
      return degraded;
    }
  };

  if (jitrl.enabled) {
    emit({
      level: 'info',
      code: 'jitrl_ready',
      message:
        'jitrl kernel ready (levels: ' +
        jitrl.levels.join(', ') +
        ', beta ' +
        String(jitrl.beta) +
        ', k ' +
        String(jitrl.k) +
        ')'
    });
  }

  return kernel;

  function driveDiagnostics(): readonly JitRlDiagnostic[] {
    const source = drive as { diagnostics?: () => readonly { readonly level?: string; readonly code: string; readonly message: string }[] };
    if (typeof source.diagnostics !== 'function') {
      return [];
    }
    return source.diagnostics().map((entry) => ({
      level: entry.level === 'warn' ? ('warn' as const) : ('info' as const),
      code: entry.code,
      message: entry.message
    }));
  }
}

/**
 * Closed-form optimizer over an injected store. Shared by the L1 decorator and
 * any future L2 selector so there is exactly one acquisition path.
 */
export function createStoreOptimizer(options: {
  readonly store: Pick<IExperienceStore, 'query'>;
  readonly config: JitRlConfig;
  readonly halfLifeMs: number;
  readonly now: () => number;
  readonly rng: () => number;
}): JitRl['optimizer'] {
  return {
    async decide<T>(
      level: JitLevel,
      state: AbstractState,
      candidates: readonly JitCandidate<T>[],
      decideOptions: { readonly guidanceFilter?: GuidanceMode; readonly rng?: () => number } = {}
    ): Promise<JitDecision<T>> {
      const neighbors = await options.store.query({
        level,
        state,
        k: options.config.k,
        similarityThreshold: options.config.similarityThreshold,
        ...(decideOptions.guidanceFilter === undefined
          ? {}
          : { guidanceFilter: decideOptions.guidanceFilter })
      });
      return decide(level, state, candidates, {
        neighbors,
        k: options.config.k,
        similarityThreshold: options.config.similarityThreshold,
        beta: options.config.beta,
        selection: options.config.selection,
        lambda: options.config.exploration.lambda,
        alpha: options.config.exploration.alpha,
        unseenFallback: options.config.unseenFallback,
        now: options.now(),
        halfLifeMs: options.halfLifeMs,
        rng: decideOptions.rng ?? options.rng
      });
    }
  };
}

/** True when the policy is the JitRL L1 decorator. */
export function isJitActivePolicy(policy: unknown): policy is JitActivePolicy {
  return (
    policy !== null &&
    typeof policy === 'object' &&
    Array.isArray((policy as { decisions?: unknown }).decisions) &&
    typeof (policy as { diagnostics?: unknown }).diagnostics === 'function' &&
    'inner' in (policy as Record<string, unknown>)
  );
}

/** Slot weights of a policy, for diagnostics; never mutates the policy. */
export function policySlotWeights(
  policy: MetaSearchPolicy
): Readonly<Record<string, number>> {
  return { ...policy.slotWeights };
}

// ---------------------------------------------------------------------------
// Phase 4: Dream replay hook + Phase 5: aggregate statistics (P4/P5 wiring)
// ---------------------------------------------------------------------------

/** Slots a replay correction may re-apportion; the recovery slot is held fixed. */
const REPLAY_SEARCH_SLOTS: readonly BatchSlotKind[] = [
  'exploit',
  'explore_domain',
  'explore_invariant'
];

/** Diagnostic cap for the free-text notes a hook call may emit. */
const REPLAY_NOTE_LIMIT = 4;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Weighted mean of finite values; 0 when nothing has positive weight. */
function weightedMeanOf(pairs: readonly { readonly value: number; readonly weight: number }[]): number {
  let weighted = 0;
  let total = 0;
  for (const pair of pairs) {
    if (!finiteNumber(pair.value) || !finiteNumber(pair.weight) || pair.weight <= 0) {
      continue;
    }
    weighted += pair.value * pair.weight;
    total += pair.weight;
  }
  return total > 0 ? weighted / total : 0;
}

/** Slot probabilities of a policy, normalized across all four slot kinds. */
function normalizedSlotShares(
  slotWeights: Readonly<Record<BatchSlotKind, number>>
): Record<BatchSlotKind, number> {
  const shares: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  let total = 0;
  for (const kind of BATCH_SLOT_KINDS) {
    const value = slotWeights[kind];
    if (finiteNumber(value) && value > 0) {
      shares[kind] = value;
      total += value;
    }
  }
  if (total <= 0) {
    for (const kind of BATCH_SLOT_KINDS) {
      shares[kind] = 1 / BATCH_SLOT_KINDS.length;
    }
    return shares;
  }
  for (const kind of BATCH_SLOT_KINDS) {
    shares[kind] = shares[kind] / total;
  }
  return shares;
}

/** KL(left || right) over the discriminating slots; 0 when both are equal. */
function klDivergenceOf(
  left: Readonly<Record<BatchSlotKind, number>>,
  right: Readonly<Record<BatchSlotKind, number>>
): number {
  let kl = 0;
  for (const kind of BATCH_SLOT_KINDS) {
    const p = left[kind];
    const q = right[kind];
    if (!(p > 0) || !(q > 0)) {
      continue;
    }
    kl += p * Math.log(p / q);
  }
  return Number.isFinite(kl) && kl > 0 ? kl : 0;
}

/** Options for {@link createJitReplayHook}. */
export interface JitReplayHookFactoryOptions {
  /** Kernel configuration; supplies k, similarityThreshold and driftRho. */
  readonly config: JitRlConfig;
  /** Per-hook drift override; defaults to config.jitrl.dream.driftRho. */
  readonly driftRho?: number;
}

/**
 * Build the synchronous Dream replay simulator (plan section 7.3-2).
 *
 * Replay hands the hook a snapshot already truncated to the replay tree's own
 * past, so this implementation is a pure function over `input.experiences`:
 *
 *  1. keep the level-'meta' records (the L1 portfolio level) and, for a
 *     `guidance_free` frontier node, only `guidance_free` evidence, mirroring the
 *     invariant isolation L1 enforces at decision time;
 *  2. down-weight records written by a superseded policy through
 *     retriever.driftFactorFor() (plan section 7.3-4), exactly once per record -
 *     the store never applies drift on its own;
 *  3. estimate Q(slot) as the weighted mean return of that slot's records and
 *     V(s) over the whole snapshot, then re-apportion the three search shares
 *     with the closed form pi'(slot) ~ pi(slot) * exp(beta * A-tilde(slot)). The
 *     recovery share is held fixed. beta comes from the policy under replay,
 *     which is what makes the perturbed candidate hyperparameters meaningful;
 *  4. report the same diagnostics shape L1 reports, so replay evidence and the
 *     live decorator can be compared field by field.
 *
 * Cold start (empty snapshot) is a normal path: the prior weights are returned
 * unchanged with `adjustments: []`. The hook never throws and never mutates its
 * input, so callers can treat any failure as "prior weights".
 */
export function createJitReplayHook(options: JitReplayHookFactoryOptions): JitReplayHook {
  const config = options.config;
  const configuredDrift = clampUnit(
    finiteNumber(options.driftRho) ? options.driftRho : config.dream.driftRho
  );
  const neighbourBudget = Math.max(1, Math.trunc(finiteNumber(config.k) ? config.k : 10));

  return (input: JitReplayHookInput): JitReplayHookResult => {
    const priorShares = normalizedSlotShares(input.slotWeights);
    try {
      const snapshot = Array.isArray(input.experiences) ? input.experiences : [];
      const levelRecords: ExperienceRecord[] = [];
      for (const record of snapshot) {
        if (record === null || typeof record !== 'object') {
          continue;
        }
        if (record.level !== 'meta' || !finiteNumber(record.return)) {
          continue;
        }
        if (input.frontier.guidance === 'guidance_free' && record.guidance !== 'guidance_free') {
          continue;
        }
        levelRecords.push(record);
      }
      if (levelRecords.length === 0) {
        return {
          slotWeights: input.slotWeights,
          diagnostics: {
            level: 'meta',
            stateValue: 0,
            neighborCount: 0,
            klToPrior: 0,
            adjustments: [],
            notes: ['no causal neighbours inside the replay window']
          }
        };
      }

      const driftRho = clampUnit(
        finiteNumber(input.driftRho) ? input.driftRho : configuredDrift
      );
      const currentPolicyCount = levelRecords.filter(
        (record) => record.policyId === input.policyId
      ).length;
      const driftContext = {
        policyId: input.policyId,
        driftRho,
        currentBucketCount: currentPolicyCount,
        k: neighbourBudget
      };
      const weighted: { readonly record: ExperienceRecord; readonly weight: number }[] = [];
      for (const record of levelRecords) {
        const weight =
          input.policyId.length > 0 && driftRho < 1
            ? driftFactorFor(record.policyId, driftContext)
            : 1;
        if (!finiteNumber(weight) || weight <= 0) {
          continue;
        }
        weighted.push({ record, weight });
      }
      if (weighted.length === 0) {
        return {
          slotWeights: input.slotWeights,
          diagnostics: {
            level: 'meta',
            stateValue: 0,
            neighborCount: 0,
            klToPrior: 0,
            adjustments: [],
            notes: ['every causal neighbour was dropped by the drift down-weight']
          }
        };
      }

      const stateValue = weightedMeanOf(
        weighted.map((entry) => ({ value: entry.record.return, weight: entry.weight }))
      );

      const slotStats = new Map<
        BatchSlotKind,
        { readonly returns: number[]; readonly weights: number[] }
      >();
      for (const kind of BATCH_SLOT_KINDS) {
        slotStats.set(kind, { returns: [], weights: [] });
      }
      for (const entry of weighted) {
        const kind = slotKindOfActionKey(entry.record.actionKey);
        if (kind === undefined) {
          continue;
        }
        const bucket = slotStats.get(kind);
        if (bucket === undefined) {
          continue;
        }
        bucket.returns.push(entry.record.return);
        bucket.weights.push(entry.weight);
      }

      const slotQ = new Map<BatchSlotKind, number>();
      const slotSupport = new Map<BatchSlotKind, number>();
      for (const kind of REPLAY_SEARCH_SLOTS) {
        const bucket = slotStats.get(kind);
        const support = bucket === undefined ? 0 : bucket.weights.length;
        slotSupport.set(kind, support);
        slotQ.set(
          kind,
          support === 0 || bucket === undefined
            ? Number.NaN
            : weightedMeanOf(
                bucket.returns.map((value, index) => ({
                  value,
                  weight: bucket.weights[index] ?? 0
                }))
              )
        );
      }

      const rawAdvantages = REPLAY_SEARCH_SLOTS.map((kind) => {
        const q = slotQ.get(kind);
        return q === undefined || !finiteNumber(q) ? 0 : q - stateValue;
      });
      const normalizedAdvantages = normalizeAdvantages(rawAdvantages);

      const beta = finiteNumber(input.jit.beta) && input.jit.beta >= 0 ? input.jit.beta : 0;
      const rawShares: Record<BatchSlotKind, number> = {
        exploit: 0,
        explore_domain: 0,
        explore_invariant: 0,
        recover: priorShares.recover
      };
      for (let index = 0; index < REPLAY_SEARCH_SLOTS.length; index += 1) {
        const kind = REPLAY_SEARCH_SLOTS[index] as BatchSlotKind;
        const advantage = normalizedAdvantages[index] ?? 0;
        rawShares[kind] = priorShares[kind] * Math.exp(beta * advantage);
      }
      let total = 0;
      for (const kind of BATCH_SLOT_KINDS) {
        const value = rawShares[kind];
        if (finiteNumber(value) && value > 0) {
          total += value;
        }
      }
      const corrected: Record<BatchSlotKind, number> = {
        exploit: 0,
        explore_domain: 0,
        explore_invariant: 0,
        recover: 0
      };
      if (total > 0) {
        for (const kind of BATCH_SLOT_KINDS) {
          corrected[kind] = rawShares[kind] / total;
        }
      } else {
        for (const kind of BATCH_SLOT_KINDS) {
          corrected[kind] = priorShares[kind];
        }
      }

      const adjustments: JitReplayAdjustment[] = REPLAY_SEARCH_SLOTS.map(
        (kind, index) => {
          const q = slotQ.get(kind);
          const supported = q !== undefined && finiteNumber(q);
          return {
            actionKey: kind,
            slot: kind,
            baseWeight: priorShares[kind],
            adjustedWeight: corrected[kind],
            q: supported ? (q as number) : null,
            advantage: rawAdvantages[index] ?? 0,
            normalizedAdvantage: normalizedAdvantages[index] ?? 0,
            support: slotSupport.get(kind) ?? 0,
            explored: false
          };
        }
      );

      const notes: string[] = [];
      if (driftRho < 1 && currentPolicyCount < neighbourBudget) {
        notes.push(
          'drift rho=' +
            String(driftRho) +
            ' down-weighted superseded-policy evidence (' +
            String(weighted.length - currentPolicyCount) +
            ' of ' +
            String(weighted.length) +
            ' neighbours)'
        );
      }
      if (neighbourBudget > 0 && levelRecords.length > neighbourBudget) {
        notes.push(
          'replay simulated ' +
            String(levelRecords.length) +
            ' causal neighbours beyond the k=' +
            String(neighbourBudget) +
            ' budget'
        );
      }

      return {
        slotWeights: corrected,
        diagnostics: {
          level: 'meta',
          stateValue,
          neighborCount: levelRecords.length,
          klToPrior: klDivergenceOf(corrected, priorShares),
          adjustments,
          ...(notes.length === 0 ? {} : { notes: notes.slice(0, REPLAY_NOTE_LIMIT) })
        }
      };
    } catch (error) {
      return {
        slotWeights: input.slotWeights,
        diagnostics: {
          level: 'meta',
          stateValue: 0,
          neighborCount: 0,
          klToPrior: 0,
          adjustments: [],
          degraded: true,
          notes: [
            'replay hook degraded to the prior weights: ' +
              (error instanceof Error ? error.name + ': ' + error.message : String(error))
          ]
        }
      };
    }
  };
}

/**
 * Aggregate a raw experience snapshot into the mirror's outbound rows (plan
 * section 7.2): one row per (level, bucket, actionKey) with sample count, mean
 * return and population variance. Raw records never leave this function.
 *
 * Deterministic ordering (level, bucket, actionKey) keeps the mirror payload -
 * and the note path derived from it - stable across runs.
 */
export function aggregateExperienceStats(
  records: readonly ExperienceRecord[]
): readonly JitStatsAggregate[] {
  interface Accumulator {
    readonly level: JitLevel;
    readonly bucket: string;
    readonly actionKey: string;
    n: number;
    sum: number;
    squareSum: number;
  }
  const groups = new Map<string, Accumulator>();
  for (const record of records) {
    if (record === null || typeof record !== 'object' || !finiteNumber(record.return)) {
      continue;
    }
    const state = record.state;
    if (state === null || typeof state !== 'object' || typeof state.bucket !== 'string') {
      continue;
    }
    const key = record.level + '\u0000' + state.bucket + '\u0000' + record.actionKey;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        level: record.level,
        bucket: state.bucket,
        actionKey: record.actionKey,
        n: 1,
        sum: record.return,
        squareSum: record.return * record.return
      });
      continue;
    }
    existing.n += 1;
    existing.sum += record.return;
    existing.squareSum += record.return * record.return;
  }
  const rows = [...groups.values()]
    .map((group) => {
      const meanReturn = group.sum / group.n;
      const rawVariance = group.squareSum / group.n - meanReturn * meanReturn;
      return {
        bucket: group.bucket,
        actionKey: group.actionKey,
        level: group.level,
        n: group.n,
        meanReturn,
        variance: rawVariance > 0 ? rawVariance : 0
      };
    })
    .sort((left, right) => {
      if (left.level !== right.level) {
        return left.level < right.level ? -1 : 1;
      }
      if (left.bucket !== right.bucket) {
        return left.bucket < right.bucket ? -1 : 1;
      }
      return left.actionKey < right.actionKey ? -1 : left.actionKey > right.actionKey ? 1 : 0;
    });
  return rows;
}

// ---------------------------------------------------------------------------
// Public kernel surface
// ---------------------------------------------------------------------------

export * from './state-abstraction';
export * from './action-normalizer';
export * from './experience-store';
export * from './retriever';
export * from './value-estimator';
export * from './logit-adjuster';
export * from './logit-sources';
export * from './step-evaluator';
export * from './backfill';
export * from './jit-active-policy';
export * from './host-advisor';
export * from './stores/memory.store';
export * from './stores/bridge.store';
export type {
  DreamJitDiagnostics,
  JitReplayAdjustment,
  JitReplayFrontierNode,
  JitReplayHook,
  JitReplayHookDiagnostics,
  JitReplayHookInput,
  JitReplayHookResult,
  JitStatsAggregate
} from '../types/contracts';
