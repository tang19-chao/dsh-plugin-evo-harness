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
  ActionKeyVocabulary,
  BatchSlotKind,
  DecisionMode,
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
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  PRODUCTION_LEARNING_TRACK,
  isOnLearningTrack
} from './experience-store';
import {
  createEffectivePolicyConfigProvider,
  freshPolicySupport,
  baseEffectivePolicyConfig,
  learningFacingFilterOptions,
  projectNeighborsBySlotKind,
  runDecisionKernel,
  selectTrackAtomically,
  type EffectivePolicyConfig,
  type EffectivePolicyConfigProvider,
  type DualTrackConsumptionOptions
} from './decision-kernel';
import { isAuthenticatedQualityRecord } from '../verification';
import { policyPriorLogit } from './logit-sources';
import { abstractMetaState } from './state-abstraction';
import {
  createJitActivePolicy,
  type JitActivePolicy,
  type JitActivePolicyOptions
} from './jit-active-policy';
import { createMemoryExperienceStore, type MemoryExperienceStore } from './stores/memory.store';
import type { ExperienceStoreFs, JsonlExperienceStore } from './stores/jsonl.store';
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
  /** C2b (ADR 0004 §8): Dual-track consumption options */
  readonly dualTrack?: DualTrackConsumptionOptions;
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
  createReplayHook(options?: {
    readonly driftRho?: number;
    /** t10/R3b: caller-declared replay declarations (see JitReplayHookInput). */
    readonly replayDeclarations?: {
      readonly decisionMode?: DecisionMode;
      readonly actionKeyVocabulary?: ActionKeyVocabulary;
    };
  }): JitReplayHook;
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
      // P6.2 PR-A / F1: stamp the CURRENT reward/provenance/schema versions on
      // any record that reaches the kernel store without them. The online
      // recorder (orchestrator) already stamps; this closes the remaining
      // producers (e.g. the L3 host-tool collector) so the unified
      // learning-eligibility predicate - which is EXACT-contract and
      // fail-closed on a missing rewardVersion - never excludes a fresh
      // record for lacking a stamp it should have carried. Records that
      // already declare a version (any version, including surrogate/legacy)
      // are passed through UNTOUCHED: re-stamping would relabel history.
      const stamped = records.map((record) =>
        record.rewardVersion === undefined &&
        record.provenanceVersion === undefined &&
        record.experienceSchemaVersion === undefined
          ? {
              ...record,
              experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
              rewardVersion: CURRENT_REWARD_VERSION,
              provenanceVersion: CURRENT_PROVENANCE_VERSION
            }
          : record
      );
      await drive.append(stamped);
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

  const optimizer = createStoreOptimizer({
    store,
    config: jitrl,
    halfLifeMs,
    now,
    rng,
    ...(options.dualTrack === undefined ? {} : { dualTrack: options.dualTrack })
  });

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
    createReplayHook(replayOptions: {
      readonly driftRho?: number;
      /**
       * t10/R3b + t12/R3b2: the caller-declared replay declarations. They WIN
       * over the factory default (a caller reconstructing an older generation
       * passes that generation's declarations); absent keeps the default below.
       */
      readonly replayDeclarations?: {
        readonly decisionMode?: DecisionMode;
        readonly actionKeyVocabulary?: ActionKeyVocabulary;
      };
      readonly dualTrack?: DualTrackConsumptionOptions;
    } = {}): JitReplayHook {
      // t12/R3b2 (t11 high finding): the defaults are resolved ONCE, in front of
      // the caller's value - `caller ?? default`, field by field. The t10
      // revision spread the caller value and then re-declared
      // `replayDeclarations` further down in the same object literal, so the
      // later key silently overwrote the caller's declaration (the comment
      // claimed the opposite) and every production replay ran shadow/signature
      // - excluding guarded-active/baseline stamped records entirely.
      //
      // Field-by-field: a caller that declares only one field still gets the
      // documented default for the other, so a partial declaration can never
      // accidentally un-partition the replay (the wrapper always partitioned,
      // before and after this fix).
      const replayDeclarations = {
        // t10/R3b (ADR 0002 R8/R9): the factory-level default = the CURRENT
        // producer stamps (what new records carry). The plugin wiring passes
        // the DECLARED/effective execution mode, so the production
        // replay/restart path consumes the declarations actually in force.
        decisionMode: replayOptions.replayDeclarations?.decisionMode ?? ('shadow' as DecisionMode),
        actionKeyVocabulary:
          replayOptions.replayDeclarations?.actionKeyVocabulary ?? ('signature' as ActionKeyVocabulary)
      };
      return createJitReplayHook({
        config: jitrl,
        ...(replayOptions.driftRho === undefined ? {} : { driftRho: replayOptions.driftRho }),
        ...(replayOptions.dualTrack === undefined ? (options.dualTrack === undefined ? {} : { dualTrack: options.dualTrack }) : { dualTrack: replayOptions.dualTrack }),
        replayDeclarations
      });
    },
    createHostAdvisor(advisorOptions = {}): HostAdvisor {
      // C2b F1 (ADR 0004 §2.4): the L3 advisor keeps PROCESS-track consumption in
      // this increment (quality advice fusion is a later, separately gated step),
      // but the track selection is EXPLICIT and diagnosed - never a silent
      // hardcoded filter. A host that enables quality consumption sees exactly
      // what L3 consumed.
      if (options.dualTrack?.enableQualityTrackConsumption === true) {
        emit({
          level: 'info',
          code: 'jitrl_l3_track',
          message:
            'L3 advisor consumes learningTrack=process only (quality consumption for L3 is not enabled; dualTrack governs L1/L2/replay)'
        });
      }
      return createHostAdvisor({
        config: jitrl,
        // P6.2 PR-A / F1: the L3 advisor is a learning consumer - its advice
        // and gate decisions shape host behaviour - so the kernel hands it a
        // store seam that adds the SAME strict learning filter L1/L2/replay
        // use (learningFacingFilterOptions: no legacy lines, no cancelled
        // records, and - through the single eligibility predicate - no record
        // on an incompatible reward contract: old r2, unversioned, future, or
        // surrogate-only backfill). Applying it here (the kernel's one L3
        // wiring point) keeps the advisor module pure and every L3 caller on
        // one evidence set.
        store: {
          query: (query: ExperienceQuery) =>
            store.query({
              ...query,
              ...learningFacingFilterOptions(),
              // P6.2 t7/V3 + C2b F1: the L3 advisor estimates the production
              // (process) track in this increment - an ATOMIC track choice at the
              // query level: process only, diagnosed above. A task-quality record
              // must never shape its advice until the L3 fusion step is
              // specifically enabled and reviewed.
              learningTrack: PRODUCTION_LEARNING_TRACK
            })
        },
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
 * the L2 proposal selector so there is exactly one acquisition path.
 *
 * P6 t28: this is the L2 *learning-facing* decision point - it picks one of K
 * proposals to execute, so the evidence it reads trains the policy. It therefore
 * queries with the strict learning filter (no legacy, no cancelled /
 * infrastructure records), the same one L1 and replay use. Filtering here rather
 * than in the caller is deliberate: it is the single place the L2 neighbourhood
 * is built, so a future second caller cannot forget it.
 */
export function createStoreOptimizer(options: {
  readonly store: Pick<IExperienceStore, 'query'>;
  readonly config: JitRlConfig;
  readonly halfLifeMs: number;
  readonly now: () => number;
  readonly rng: () => number;
  readonly dualTrack?: DualTrackConsumptionOptions;
}): JitRl['optimizer'] {
  return {
    async decide<T>(
      level: JitLevel,
      state: AbstractState,
      candidates: readonly JitCandidate<T>[],
      decideOptions: { readonly guidanceFilter?: GuidanceMode; readonly rng?: () => number } = {}
    ): Promise<JitDecision<T>> {
      if (options.dualTrack?.enableQualityTrackConsumption === true) {
        const processK = options.dualTrack.processK ?? options.config.k;
        const qualityK = options.dualTrack.qualityK ?? Math.min(8, options.config.k);

        const processNeighbors = await options.store.query({
          level,
          state,
          k: processK,
          similarityThreshold: options.config.similarityThreshold,
          ...(decideOptions.guidanceFilter === undefined
            ? {}
            : { guidanceFilter: decideOptions.guidanceFilter }),
          ...learningFacingFilterOptions(),
          learningTrack: 'process'
        });

        const rawQualityNeighbors = await options.store.query({
          level,
          state,
          k: qualityK,
          similarityThreshold: options.config.similarityThreshold,
          ...(decideOptions.guidanceFilter === undefined
            ? {}
            : { guidanceFilter: decideOptions.guidanceFilter }),
          ...learningFacingFilterOptions(),
          learningTrack: 'task-quality'
        });
        // Only host-authenticated quality records enter the quality
        // neighbourhood. A stale/foreign quality-labelled record must not poison
        // an otherwise valid quality set; if NOTHING survives authentication and
        // quality-labelled records existed, fail closed to the process track.
        const qualityNeighbors = rawQualityNeighbors.filter(
          (neighbor) =>
            isAuthenticatedQualityRecord(neighbor.record) && neighbor.record.learningEligible !== false
        );
        // F2 (C2b review): P0 fires only when quality-labelled records are VISIBLE
        // to this decision's query and NONE of them authenticates. One stale or
        // foreign record beside valid ones must not close the track; it is simply
        // excluded from the neighbourhood above.
        const hasUntrustedQuality =
          rawQualityNeighbors.length > 0 && qualityNeighbors.length === 0;

        const processDecision = decide(level, state, candidates, {
          neighbors: processNeighbors,
          k: processK,
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

        const qualityDecision =
          qualityNeighbors.length > 0
            ? decide(level, state, candidates, {
                neighbors: qualityNeighbors,
                k: qualityK,
                similarityThreshold: options.config.similarityThreshold,
                beta: options.config.beta,
                selection: options.config.selection,
                lambda: options.config.exploration.lambda,
                alpha: options.config.exploration.alpha,
                unseenFallback: options.config.unseenFallback,
                now: options.now(),
                halfLifeMs: options.halfLifeMs,
                rng: decideOptions.rng ?? options.rng
              })
            : undefined;

        const selectionResult = selectTrackAtomically(candidates, processDecision, qualityDecision, {
          minQualityEffectiveSamples: options.dualTrack.minQualityEffectiveSamples,
          qualityUntrusted: hasUntrustedQuality
        });

        const chosenDecision = selectionResult.winningDecision;
        return {
          ...chosenDecision,
          rationale:
            chosenDecision.rationale +
            '; track=' +
            selectionResult.winningTrack +
            ' (' +
            selectionResult.verdict.selectionReason +
            ')' +
            // C2b review F2: keep the arbitration audit trail in the rationale so
            // a kept prior / process fallback is distinguishable from a silent
            // process-only path.
            (hasUntrustedQuality ? '; qualityUntrusted=true' : ''),
          // C2b F1/F5: the atomic track verdict rides the decision (narrow
          // structural extension of JitDecision; consumers that never read it
          // keep the baseline shape).
          trackSelection: selectionResult.verdict
        } as JitDecision<T> & { readonly trackSelection?: typeof selectionResult.verdict };
      }

      const neighbors = await options.store.query({
        level,
        state,
        k: options.config.k,
        similarityThreshold: options.config.similarityThreshold,
        ...(decideOptions.guidanceFilter === undefined
          ? {}
          : { guidanceFilter: decideOptions.guidanceFilter }),
        ...learningFacingFilterOptions(),
        learningTrack: PRODUCTION_LEARNING_TRACK
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

/**
 * The config slice the replay hook actually reads.
 *
 * Narrower than `JitRlConfig` on purpose: a frozen config object (`levels` is a
 * readonly array on DEFAULT_EVO_HARNESS_CONFIG.jitrl) is not assignable to the
 * mutable config type, and the hook must be usable from a parity test that holds
 * the frozen defaults. Listing the fields also documents what replay consumes.
 */
export interface JitReplayHookKernelConfig {
  readonly k: number;
  readonly similarityThreshold: number;
  readonly dream: { readonly driftRho: number };
}

/** Options for {@link createJitReplayHook}. */
export interface JitReplayHookFactoryOptions {
  /** Kernel configuration; supplies k, similarityThreshold and driftRho. */
  readonly config: JitReplayHookKernelConfig;
  /** Per-hook drift override; defaults to config.jitrl.dream.driftRho. */
  readonly driftRho?: number;
  /**
   * P6 PR5 (plan section 7.1): the abstract state of the replayed decision.
   *
   * A `JitReplayHookInput` carries only the frontier view, whose task identity
   * is unknown to replay, so deriving a state from it would silently bucket the
   * decision differently from the online path and destroy the very parity this
   * round is about. The caller therefore supplies the state it wants replayed;
   * absent keeps the frontier-derived fallback so an old caller still works.
   *
   * The state is the *only* thing the caller injects for parity: snapshot
   * truncation stays replay's job and the algorithm below is the shared kernel.
   */
  readonly stateOf?: (input: JitReplayHookInput) => AbstractState;
  /**
   * Deterministic seed for the exploration draw (plan section 7.1). Replay is a
   * pure function, so it must not reach for Math.random; absent means an
   * exploration-free draw (rng always 1, i.e. no unsupported action is explored),
   * which is the deterministic-policy comparison mode.
   */
  readonly seed?: number;
  /** Injected clock for the half-life decay; absent disables the decay. */
  readonly now?: () => number;
  /**
   * P6 PR5 (plan section 7.1): prior logit z(s, a) of one slot candidate.
   *
   * The online decorator derives it from the policy's slot shares *plus* the
   * request's memory confidence and exploration temperature; replay has neither
   * of those inputs (a `JitReplayHookInput` only carries the frontier view), so
   * by default replay uses the memory-free, unit-temperature prior. A parity
   * caller that knows the online context injects the same function here, which
   * is what makes the two candidate sets identical and the adjusted logits
   * comparable term by term.
   */
  readonly priorLogitOf?: (slotKind: BatchSlotKind, slotWeights: Readonly<Record<BatchSlotKind, number>>) => number;
  /**
   * t10/R3b (ADR 0002 R8/R9): the replay declarations attached to every hook
   * input (see JitReplayHookInput.replayDeclarations). The production kernel
   * wiring (`createReplayHook`) defaults this to the CURRENT declared
   * mode/vocabulary (what new records are stamped with), so the production
   * replay/restart path actually consumes the declarations instead of leaving
   * the store-level capability unwired. Absent keeps the hook unpartitioned
   * (the pre-t10 behaviour for parity callers that reconstruct mixed eras).
   */
  readonly replayDeclarations?: {
    readonly decisionMode?: DecisionMode;
    readonly actionKeyVocabulary?: ActionKeyVocabulary;
  };
  readonly dualTrack?: DualTrackConsumptionOptions;
}

/**
 * Fallback state for a replay hook without an injected `stateOf`.
 *
 * Everything the frontier view actually exposes goes in; the task identity is
 * unknowable here, which is exactly why parity callers inject their own state.
 */
function replayStateFromFrontier(input: JitReplayHookInput): AbstractState {
  return abstractMetaState({
    task: { id: input.treeId, prompt: '' },
    round: input.frontier.depth,
    parentDepth: input.frontier.depth,
    ...(input.frontier.slot === undefined ? {} : { parentSlot: input.frontier.slot }),
    memoryConfidence: 0,
    referenceStatus: 'missing'
  });
}

/** Slot candidates of one replay correction: one per slot kind (plan section 7.1). */
function replayCandidates(
  slotWeights: Readonly<Record<BatchSlotKind, number>>,
  priorLogitOf?: (kind: BatchSlotKind, weights: Readonly<Record<BatchSlotKind, number>>) => number
): readonly JitCandidate<{ readonly slotKind: BatchSlotKind }>[] {
  return BATCH_SLOT_KINDS.map((kind) => ({
    actionKey: 'slot:' + kind,
    // Policy prior exactly as the online decorator derives it when replay has no
    // extra context: same shares, no memory modulation, unit temperature. A
    // parity caller injects `priorLogitOf` to reproduce the online context.
    baseLogit:
      priorLogitOf === undefined
        ? policyPriorLogit(slotWeights, kind)
        : priorLogitOf(kind, slotWeights),
    source: 'policy_prior' as const,
    payload: { slotKind: kind }
  }));
}

/**
 * Build the synchronous Dream replay simulator (plan section 7.3-2 / P6 PR5).
 *
 * This is a *shell*: the entire algorithm - filtering, bucket/Jaccard/decay
 * top-k retrieval, Q/V/advantage, the closed-form logit correction and the slot
 * allocation - is `runDecisionKernel()`, the same pure function the online L1
 * decorator calls (plan section 7.1). Before P6 this hook re-implemented the
 * correction (weighted means over the whole level, its own exp(beta * A)
 * re-apportioning, no nearest-neighbour retrieval and no top-k truncation), so
 * offline replay evaluated a different policy than the one that ran online.
 *
 * Replay's only two jobs are (a) hand the kernel the snapshot the caller
 * truncated to the replayed tree's own past and (b) project the kernel result
 * back onto the JitReplayHookResult shape. The recovery share is held at its
 * prior, which is what makes a replay correction comparable to L1's, where the
 * recovery cap is structural.
 *
 * Cold start (empty snapshot) is a normal path: the prior weights come back
 * unchanged. The hook never throws and never mutates its input, so a caller can
 * treat any failure as "prior weights".
 */
export function createJitReplayHook(options: JitReplayHookFactoryOptions): JitReplayHook {
  const config = options.config;
  const configuredDrift = clampUnit(
    finiteNumber(options.driftRho) ? options.driftRho : config.dream.driftRho
  );
  const fallbackState = (input: JitReplayHookInput): AbstractState =>
    options.stateOf === undefined
      ? replayStateFromFrontier(input)
      : options.stateOf(input);

  return (input: JitReplayHookInput): JitReplayHookResult => {
    const priorShares = normalizedSlotShares(input.slotWeights);
    try {
      const driftRho = clampUnit(
        finiteNumber(input.driftRho) ? input.driftRho : configuredDrift
      );
      const state = fallbackState(input);
      const candidates =
        options.priorLogitOf === undefined
          ? replayCandidates(priorShares)
          : replayCandidates(priorShares, options.priorLogitOf);
      const jit = input.jit;
      // t10/R3b (ADR 0002 R8/R9): the replay DECLARATIONS. The factory-level
      // option is the production default (what new records are stamped with);
      // a caller-supplied input declaration wins (a caller reconstructing an
      // older generation passes that generation's declarations). Undeclared
      // (neither level sets anything) keeps the hook unpartitioned.
      const declaredMode =
        input.replayDeclarations?.decisionMode ?? options.replayDeclarations?.decisionMode;
      const declaredVocabulary =
        input.replayDeclarations?.actionKeyVocabulary ??
        options.replayDeclarations?.actionKeyVocabulary;
      const declaredFilter = (entry: ExperienceRecord): boolean =>
        (declaredMode === undefined || entry.decisionMode === declaredMode) &&
        (declaredVocabulary === undefined ||
          entry.actionKeyVocabulary === declaredVocabulary);
      const enableDualTrack = options.dualTrack?.enableQualityTrackConsumption === true;
      const replaySnapshot = (
        Array.isArray(input.experiences) ? input.experiences : []
      ).filter(
        (entry) =>
          (enableDualTrack || isOnLearningTrack(entry, PRODUCTION_LEARNING_TRACK)) &&
          declaredFilter(entry)
      );
      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: replaySnapshot,
        dualTrack: options.dualTrack,
        config: {
          beta: finiteNumber(jit.beta) && jit.beta >= 0 ? jit.beta : 0,
          k: Math.max(1, Math.trunc(finiteNumber(jit.k) ? jit.k : config.k)),
          similarityThreshold: clampUnit(
            finiteNumber(jit.similarityThreshold)
              ? jit.similarityThreshold
              : config.similarityThreshold
          ),
          selection: 'argmax',
          // Exploration is disabled in replay by default: comparing candidate
          // policies must not depend on an exploration draw (plan section 7.2
          // keeps lambda/alpha out of the search grid for the same reason).
          lambda: 0,
          alpha: 0,
          unseenFallback: 'baseline',
          halfLifeMs: 0,
          ...(input.policyId.length === 0
            ? {}
            : { policyId: input.policyId, driftRho })
        },
        guidance: input.frontier.guidance === 'guidance_free' ? 'guidance_free' : undefined,
        // Learning-facing decision (plan sections 6.5 and 7.5): replay's
        // neighbourhood must be the same evidence set the online decision may
        // learn from, so legacy and learning-ineligible records are excluded on
        // both sides. Without this, replay would "replay" a policy that consumed
        // evidence the live path never sees.
        ...learningFacingFilterOptions(),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        // No exploration draw: the deterministic-policy comparison mode.
        rng: () => 1,
        ...(options.now === undefined ? { } : { now: options.now() }),
        projectNeighbors: projectNeighborsBySlotKind
      });

      const corrected = replayedShares(kernel, priorShares);
      // P6 PR5 parity: every slot kind the kernel decided on is reported, so a
      // reviewer can compare replay's adjustments with the online diagnostics
      // entry by entry instead of guessing which ones were omitted.
      const adjustments: JitReplayAdjustment[] = BATCH_SLOT_KINDS.map((kind) => {
        const entry = kernel.decision.adjustments.find(
          (adjustment) => adjustment.candidate.actionKey === 'slot:' + kind
        );
        const supported = entry !== undefined && entry.q !== null;
        return {
          actionKey: kind,
          slot: kind,
          baseWeight: priorShares[kind],
          adjustedWeight: corrected[kind],
          q: supported ? (entry?.q ?? null) : null,
          advantage: entry?.advantage ?? 0,
          normalizedAdvantage: entry?.normalizedAdvantage ?? 0,
          support: entry?.support ?? 0,
          // P6.2 C0 (ADR 0002 R5): replay reports the same effective-sample
          // evidence the online decision saw, so the ledger compares like with
          // like (support co-reported for the raw count).
          nEff: entry?.nEff ?? 0,
          explored: entry?.explored ?? false
        };
      });

      const notes: string[] = [];
      if (driftRho < 1 && kernel.neighbors.length > 0) {
        const drifted = kernel.neighbors.filter((entry) => entry.driftWeight !== undefined);
        if (drifted.length > 0) {
          notes.push(
            'drift rho=' +
              String(driftRho) +
              ' down-weighted ' +
              String(drifted.length) +
              ' of ' +
              String(kernel.neighbors.length) +
              ' (level,bucket) neighbours'
          );
        }
      }
      // C2b F7 (ADR 0004 §2.4): the M3 fresh count is a PROCESS-track count.
      // Dual-track widens the REPLAY neighbourhood, never the freshness
      // denominator: a task-quality record in the snapshot is excluded here so
      // sparse trusted evidence cannot end the drift penalty early.
      const processOnlySnapshot = enableDualTrack
        ? replaySnapshot.filter((entry) => entry.learningTrack !== 'task-quality')
        : replaySnapshot;
      const support = freshPolicySupport(
        // P6.2 t7/V3: the M3 fresh count is a PROCESS-track count (same
        // pre-filter as the replay kernel above; the shared filter helper in
        // decision-kernel stays untouched, R6). t10/R3b: the declared
        // mode/vocabulary partition applies identically.
        processOnlySnapshot,
        {
          level: 'meta',
          bucket: state.bucket,
          policyId: input.policyId,
          k: Math.max(1, Math.trunc(finiteNumber(jit.k) ? jit.k : config.k)),
          // M3 is a learning-facing count (plan sections 6.5 and 7.4): the
          // freshness denominator decides when the drift penalty stops, so it
          // must only ever be satisfied by evidence the new policy may learn
          // from. Legacy and learning-ineligible records are counted as neither
          // fresh nor usable.
          ...learningFacingFilterOptions(),
          ...(input.frontier.guidance === 'guidance_free'
            ? { guidance: 'guidance_free' as const }
            : {})
        }
      );
      notes.push(
        'fresh support (meta,' +
          state.bucket +
          ')=' +
          String(support.fresh) +
          '/' +
          String(support.k) +
          ' (usable ' +
          String(support.usable) +
          ')' +
          (support.saturated ? '; drift penalty inactive' : '')
      );
      if (kernel.filters.kept !== kernel.filters.records) {
        notes.push(
          'filtered ' +
            String(kernel.filters.records - kernel.filters.kept) +
            ' of ' +
            String(kernel.filters.records) +
            ' causal records before retrieval'
        );
      }

      return {
        slotWeights: corrected,
        diagnostics: {
          level: 'meta',
          stateValue: kernel.stateValue,
          neighborCount: kernel.neighborCount,
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
 * Project a kernel slot allocation back onto the replay weight vector.
 *
 * The kernel allocates over all four kinds; replay holds the recovery share
 * fixed at its prior (the recovery cap is structural in L1) and renormalizes the
 * three search shares against it. When the kernel could not allocate (cold start
 * or a non-slot action space) the prior shares come back unchanged.
 */
function replayedShares(
  kernel: ReturnType<typeof runDecisionKernel<{ readonly slotKind: BatchSlotKind }>>,
  priorShares: Readonly<Record<BatchSlotKind, number>>
): Record<BatchSlotKind, number> {
  const allocated = kernel.slotWeights;
  const out: Record<BatchSlotKind, number> = {
    exploit: priorShares.exploit,
    explore_domain: priorShares.explore_domain,
    explore_invariant: priorShares.explore_invariant,
    recover: priorShares.recover
  };
  if (allocated === null) {
    return out;
  }
  const searchTotal =
    allocated.exploit + allocated.explore_domain + allocated.explore_invariant;
  const searchBudget = Math.max(
    0,
    1 - priorShares.recover
  );
  if (!(searchTotal > 0) || !(searchBudget > 0)) {
    return out;
  }
  for (const kind of REPLAY_SEARCH_SLOTS) {
    out[kind] = (allocated[kind] / searchTotal) * searchBudget;
  }
  return out;
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
export * from './decision-kernel';
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
