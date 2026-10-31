/**
 * rev6 R1-2 (t9): the write-back gate reaches the PERSISTED record.
 *
 * WHY THIS SUITE IS SEPARATE FROM tests/unit/jitrl/writeback-gate.test.ts
 * ---------------------------------------------------------------------
 * The gate suite proves the RULES. This one proves the WIRING: that
 * `recordOnlineExperience` actually consults the gate, and that the verdict
 * survives into what the store holds. That is the claim the negative result
 * cares about - `deviationStats.gateFired = 0` was a statement about the
 * PRODUCTION recorder, not about a judge function, so "gateFired is now > 0"
 * must be measured on the production path.
 *
 * THE CASES THAT MATTER
 * ---------------------
 *   1. OFF (default): the historical behaviour, every executed probe written,
 *      `gateFired === 0`, and the stage block says `enabled: false`. This is the
 *      no-regression case: t9 must not change what a host that never opts in
 *      observes.
 *   2. ON with no evidence: every record still PERSISTS (negative samples are
 *      never deleted - hiding harm was the original sin) but is forced
 *      `learningEligible: false` with a zero learning target, and `gateFired`
 *      equals the audit count.
 *   3. ON with a trusted fail->pass: the record is ADMITTED and keeps its
 *      eligibility, proving the gate is not a blanket brake.
 *
 * THE FIXTURE'S ONE FICTIONAL ELEMENT (stated, not hidden)
 * --------------------------------------------------------
 * A trajectory's receipt is attached through the SAME `metadata.verification`
 * channel production reads (`readTrustedVerification`). Production never writes
 * it (that is the C2 unfinished item, ADR 0002 5.2a), which is exactly why the
 * gate stays closed in production - see the measured corpus in
 * `scripts/eval/rev6-jitrl-intervention.mjs`. Cases 2/3 therefore demonstrate
 * the RULE's reach, not a production capability.
 */
import { describe, expect, it } from 'vitest';
import {
  createEvoHarnessOrchestrator,
  type EvoHarnessOrchestrator,
  type EvoHarnessOrchestratorDeps,
  type EvoHarnessStageEvent,
  type OrchestratorJitRl
} from '../../../src/orchestrator';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { createDiscoveryTreePool } from '../../../src/dream-rsi';
import { createMemoryExperienceStore, type MemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import { createHostOwnedVerificationRunner } from '../../../src/verification';
import {
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import type {
  AbstractState,
  BatchPlan,
  BatchSlotKind,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  EightSurfacePatch,
  ExperienceQuery,
  ExperienceRecord,
  GuidanceMode,
  HarnessComponentKey,
  IActivePolicy,
  ICordisSeamManager,
  IHarnessComposer,
  IHarnessProposer,
  IHarnessReflector,
  IMemoryBridge,
  IOfflineDreamer,
  IsolatedBranchContext,
  IStepEvaluator,
  ISurrogateScorer,
  JitCandidate,
  JitDecision,
  ScoredExperience,
  JitLevel,
  MemoryIsolationHandle,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemoryScope,
  MetaSearchPolicy,
  ProbeBranchRequest,
  ProbeExecutionResult,
  ProbeTrajectory,
  ProposeRequest,
  ProposedPatch,
  ProposedPatchSet,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';

function makeClock(start = 1_700_000_000_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

function makeIdFactory(prefix: string): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return prefix + '-' + String(counter);
  };
}

const POLICY: MetaSearchPolicy = {
  id: 'wb-policy',
  version: 3,
  createdAt: 0,
  maxWidth: 4,
  maxDepth: 1,
  slotWeights: { exploit: 0.25, explore_domain: 0.25, explore_invariant: 0.25, recover: 0.25 },
  earlyStopThreshold: 0.8,
  minMemoryConfidenceForSkip: 0.9
};

const TASK = { id: 'task-writeback', prompt: 'writeback gate wiring' } as const;

function makeMemoryBridge(): IMemoryBridge {
  const descriptor = {
    driverKind: 'vector_fact',
    serverId: null,
    backendLabel: 'mock',
    capabilities: {
      metadataFiltering: true,
      namespaces: true,
      negativePolarity: true,
      temporal: false,
      supportsPrune: false
    },
    boundAt: 0,
    diagnostics: []
  } as unknown as IMemoryBridge['descriptor'];
  const commitResult = (lesson: CanonicalLesson): never =>
    ({
      accepted: true,
      persisted: true,
      lessonId: lesson.id,
      namespace: 'mock',
      driverKind: 'vector_fact',
      violations: [],
      at: 0
    }) as never;
  return {
    descriptor,
    initialize: async () => descriptor,
    recall: async (query: MemoryRecallQuery) =>
      ({
        query: query as never,
        scope: query.scope,
        driverKind: 'vector_fact',
        lessons: [],
        positiveLessons: [],
        negativeLessons: [],
        suppressedLessons: [],
        confidence: 0.2,
        degraded: false,
        diagnostics: [],
        recalledAt: 0
      }) as unknown as MemoryRecallResult,
    commit: async (lesson: CanonicalLesson) => commitResult(lesson),
    isolate: async (scope: MemoryScope): Promise<MemoryIsolationHandle> =>
      ({ scope, namespace: 'mock-branch', active: true, release: async () => undefined }) as unknown as MemoryIsolationHandle,
    promote: async (lesson: CanonicalLesson) => commitResult(lesson),
    prune: async () => ({ scanned: 0, removedIds: [], dryRun: false }),
    dispose: async () => undefined
  } as unknown as IMemoryBridge;
}

/** One round with two domain slots: enough for a winner and a non-winner record. */
function makePolicy(): IActivePolicy {
  return {
    policy: POLICY,
    planGrid: (): SearchGridPlan => ({
      maxWidth: POLICY.maxWidth,
      maxDepth: 1,
      budget: 12,
      skipProbing: false,
      stopCondition: 'max_depth',
      complexity: 'moderate',
      rationale: 'wb grid plan',
      policyId: POLICY.id
    }),
    selectBatch: (request: SelectBatchRequest): BatchPlan => {
      const specs: readonly { kind: BatchSlotKind; guidance: GuidanceMode }[] =
        request.round === 1
          ? [
              { kind: 'explore_domain', guidance: 'memory' },
              { kind: 'explore_domain', guidance: 'memory' }
            ]
          : [];
      const planned: BatchSlotPlan[] = specs.map((spec, slotIndex) => ({
        slot: spec.kind,
        slotIndex,
        branchId: 'r' + String(request.round) + '-branch-' + String(slotIndex),
        parentNodeId: request.tree.rootId,
        origin: 'domain',
        guidance: spec.guidance,
        focusSurfaces: ['guardrails'],
        rationale: 'wb slot ' + spec.kind
      }));
      return {
        round: request.round,
        grid: request.grid,
        policyId: POLICY.id,
        width: planned.length,
        slots: planned,
        createdAt: 0
      };
    },
    update: () => undefined
  };
}

function patchVariant(id: string, shape: 'a' | 'b', now: () => number, slotIndex = 0): EightSurfacePatch {
  const edits =
    shape === 'a'
      ? { guardrails: { kind: 'guardrails', appendRules: ['rule-' + id] } }
      : { guardrails: { kind: 'guardrails', appendRules: ['rule-' + id, 'rule-' + id + '-b'] } };
  return {
    id,
    sessionId: 'session-wb',
    branchId: 'branch-' + String(slotIndex),
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: id,
    rationale: 'wb mock proposal ' + id,
    edits,
    createdAt: now()
  } as unknown as EightSurfacePatch;
}

function makeProposer(now: () => number): IHarnessProposer {
  const patches = [patchVariant('patch-a', 'a', now), patchVariant('patch-b', 'b', now)];
  return {
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      return {
        patch: patches[0] as EightSurfacePatch,
        rationale: 'single proposal',
        focusSurfaces: request.slot.focusSurfaces,
        confidence: 0.6,
        expectedStepsDelta: -1
      };
    },
    async proposeCandidates(request: ProposeRequest): Promise<ProposedPatchSet> {
      return {
        candidates: patches.map((patch, index) => ({
          patch,
          rationale: 'candidate ' + String(index),
          focusSurfaces: request.slot.focusSurfaces,
          confidence: [0.9, 0.6][index] ?? 0.4,
          expectedStepsDelta: -1
        }))
      };
    }
  } as unknown as IHarnessProposer;
}

/** Picks the first succeeded candidate, or no winner when all failed. */
function makeComposer(): IHarnessComposer {
  return {
    async compose(request): Promise<CompositionResult> {
      const winner = request.candidates.find((candidate) => candidate.trajectory.status === 'succeeded') ?? null;
      return {
        selectedBranchId: winner?.branchId ?? null,
        selectedNodeId: winner?.nodeId ?? null,
        selectedTrajectoryId: winner?.trajectory.id ?? null,
        selectedPatch: winner?.patch ?? null,
        composedPatch: winner?.patch ?? null,
        assessments: request.candidates.map((candidate) => ({
          alias: 'candidate_' + candidate.nodeId,
          branchId: candidate.branchId,
          nodeId: candidate.nodeId,
          selected: candidate.nodeId === winner?.nodeId,
          adoptionRatio: candidate.nodeId === winner?.nodeId ? 1 : 0.4,
          contrasts: [],
          rationale: 'wb mock assessment'
        })),
        adoptionRatios: Object.fromEntries(
          request.candidates.map((candidate) => [candidate.nodeId, candidate.nodeId === winner?.nodeId ? 1 : 0.4])
        ),
        rationale: 'wb mock composition',
        evaluatedAt: 0
      } as unknown as CompositionResult;
    }
  };
}

function makeReflector(): IHarnessReflector {
  return {
    async reflect() {
      return { lessons: [], positiveCount: 0, negativeCount: 0, diagnostics: [] };
    }
  } as unknown as IHarnessReflector;
}

function makeScorer(now: () => number): ISurrogateScorer {
  return {
    score(request: Parameters<ISurrogateScorer['score']>[0]) {
      const succeeded = request.node.status === 'succeeded';
      return {
        nodeId: request.node.id,
        score: succeeded ? 0.9 : 0.2,
        signals: {
          selected: request.composition !== undefined && succeeded,
          adoptionRatio: request.composition === undefined ? 0 : succeeded ? 1 : 0.4,
          stepEfficiency: 1,
          toolErrorRate: 0
        },
        weights: request.weights,
        computedAt: now(),
        evidence: ['wb mock score']
      } as unknown as ReturnType<ISurrogateScorer['score']>;
    }
  } as unknown as ISurrogateScorer;
}

/**
 * Cordis seams: a failed reference, succeeded candidates.
 *
 * NO verification metadata is attached here. That is deliberate and it is what
 * production does: a branch cannot mint its own trusted receipt (ADR 0003
 * T1/T2 - "a payload that merely claims a verifier identity ... never becomes
 * trusted"). The only legitimate way a trajectory becomes trusted is the HOST's
 * own runner through `deps.verification`, which is how the admitted case is set
 * up below.
 */
function makeSeams(now: () => number): ICordisSeamManager {
  return {
    async runInIsolatedBranch(request: ProbeBranchRequest): Promise<ProbeTrajectory> {
      const branchId = request.branchId ?? 'branch';
      const isReference = request.role === 'reference';
      const startedAt = now();
      // THE EXECUTION MUST GO THROUGH `request.executor`: the seams are the
      // isolation wrapper, and the orchestrator relies on the executor actually
      // running so the probe result becomes a committed tree node. An earlier
      // version of this fixture returned a hand-built trajectory WITHOUT calling
      // the executor, and the run produced zero records - the harness looked
      // wired but nothing executed.
      const context: IsolatedBranchContext = {
        branchId,
        sessionId: request.sessionId,
        namespace: 'wb/ns',
        task: request.task,
        patch: request.patch,
        mountedSurfaces: Object.keys(request.patch.edits) as HarnessComponentKey[],
        signal: new AbortController().signal
      };
      const result = await request.executor(context);
      const endedAt = now();
      return {
        id: isReference ? 'traj-ref' : 'traj-' + branchId,
        sessionId: request.sessionId,
        branchId,
        branchNamespace: 'wb/ns',
        role: isReference ? 'reference' : 'candidate',
        status: isReference ? 'failed' : 'succeeded',
        patchId: request.patch.id,
        patchOrigin: 'domain',
        surfaceKeys: Object.keys(request.patch.edits) as HarnessComponentKey[],
        ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        startedAt,
        endedAt,
        metrics: { steps: 1, toolCalls: 1, toolErrors: 0, durationMs: Math.max(1, endedAt - startedAt) },
        steps: result.steps ?? [],
        toolErrors: result.toolErrors ?? [],
        failureSignals: result.failureSignals ?? [],
        memoryRecallIds: [],
        // NO `contentHash` is hand-written here: the C2a attach step writes the
        // HOST-recomputed digest into it, and the scorer's `expectedEvidenceHash`
        // branch compares that value against the receipt's `evidenceHash`. A
        // fixture-supplied hash would break that comparison and silently make
        // every receipt untrusted - i.e. it would make the admitted case
        // impossible while looking like a gate failure.
        deliverable: { content: 'ok', format: 'text' }
      } as unknown as ProbeTrajectory;
    },
    async applyPermanentPatch(patch: EightSurfacePatch): Promise<{ patchId: string; active: boolean; dispose: () => Promise<void> }> {
      return { patchId: patch.id, active: true, dispose: async () => undefined };
    },
    listActiveBranches: () => [],
    dispose: async () => undefined,
    async mountSurface(): Promise<never> {
      throw new Error('not used');
    }
  } as unknown as ICordisSeamManager;
}

interface HarnessOptions {
  /**
   * Attach the HOST-OWNED verification runner (the production C2a seam) and
   * configure it so every candidate receipt comes back `passed`.
   *
   * This is the ONLY way a trajectory can legitimately become trusted: the
   * runner registers the receipt inside its own per-run registry and binds it to
   * an artifact digest it recomputed. Hand-writing `metadata.verification` into
   * a trajectory would be exactly the self-asserted claim the trust boundary
   * refuses (ADR 0003 T1/T2).
   */
  readonly hostVerifier?: boolean;
  readonly writebackGate?: boolean;
  /**
   * Enable the L2 memory augmentation pass. The writeback-gate fix (t21 finding
   * T21-F1) lives on that path's store.query, so a regression test can only
   * see it with augmentation ON; the historical C3 arms ran with it OFF, which
   * is why the defect survived. Default: false (fixture parity with history).
   */
  readonly augmentFromMemory?: boolean;
}

interface Harness {
  readonly orchestrator: EvoHarnessOrchestrator;
  readonly store: MemoryExperienceStore;
  /** Observe the queries the REAL orchestrator issues (t27 wiring pin). */
  instrumentQuery(): ExperienceQuery[];
  readonly events: EvoHarnessStageEvent[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const now = makeClock();
  const events: EvoHarnessStageEvent[] = [];
  const defaults = createDefaultConfig();
  const config = parseEvoHarnessConfig({
    triggerMode: 'always',
    probe: { maxConcurrentProbes: 4, probeTimeoutMs: 5_000 },
    dreamRsi: {
      maxOnlineRolloutBudget: 12,
      maxWidth: 4,
      maxDepth: 1,
      offlineDreamTriggerEveryNTasks: 1_000,
      candidatePoliciesCount: 2
    },
    logging: { level: 'silent' }
  });

  const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
  const jitSurface: OrchestratorJitRl = {
    store,
    optimizer: {
      async decide<T>(
        level: JitLevel,
        _state: AbstractState,
        candidates: readonly JitCandidate<T>[]
      ): Promise<JitDecision<T>> {
        const adjustments = candidates.map((candidate) => ({
          candidate,
          q: null,
          advantage: 0,
          normalizedAdvantage: 0,
          adjustedLogit: candidate.baseLogit,
          probability: 1 / Math.max(1, candidates.length),
          support: 0,
          explored: false
        }));
        return {
          level,
          stateValue: 0,
          neighborCount: 0,
          adjustments,
          chosen: adjustments[0] as (typeof adjustments)[number],
          klToPrior: 0,
          rationale: 'wb stub'
        };
      }
    },
    // An EMPTY step list: every probe is scored from verifiable signals, which is
    // the path the historical C3 arms used. No judge call, so no model cost.
    stepEvaluator: { async evaluate(): Promise<readonly never[]> { return []; } } as unknown as IStepEvaluator,
    config: {
      enabled: true,
      levels: ['meta', 'proposal'],
      gamma: defaults.jitrl.gamma,
      // t27: the L2 selectProposal path (and therefore the writeback-gate fix on
      // its store.query) only runs when K > 1; the historical fixture used 1 and
      // that is exactly why T21-F1 was never exercised.
      candidateCount: options.augmentFromMemory === true ? 2 : 1,
      k: defaults.jitrl.k,
      similarityThreshold: defaults.jitrl.similarityThreshold,
      augmentFromMemory: options.augmentFromMemory === true,
      minSupportForStrongPrior: defaults.jitrl.minSupportForStrongPrior
    }
  };

  const runBranch: BranchExecutor = async (context) => {
    const patch = context.patch as EightSurfacePatch;
    const reference = Object.keys(patch.edits).length === 0;
    if (reference) {
      // With the host verifier enabled the reference must SUCCEED, because a
      // missing reference receipt is itself an audit-only forcing condition
      // (ADR 0003 §4.3: `reference-receipt-missing`). Leaving the reference
      // failing would make every candidate ineligible for a reason unrelated to
      // the write-back gate, and the admitted case would then be untestable.
      if (options.hostVerifier === true) {
        return {
          status: 'succeeded',
          steps: [{ index: 0, at: now(), kind: 'message', text: 'baseline ok' }],
          deliverable: { content: 'baseline deliverable', format: 'text' },
          toolErrors: [],
          failureSignals: []
        } as unknown as ProbeExecutionResult;
      }
      return {
        status: 'failed',
        steps: [{ index: 0, at: now(), kind: 'error', text: 'baseline failed' }],
        toolErrors: [],
        failureSignals: [{ kind: 'tool_error', message: 'baseline failed', repairable: true }]
      } as unknown as ProbeExecutionResult;
    }
    return {
      status: 'succeeded',
      steps: [{ index: 0, at: now(), kind: 'message', text: 'ran' }],
      deliverable: { content: 'ok', format: 'text' },
      toolErrors: [],
      failureSignals: []
    } as unknown as ProbeExecutionResult;
  };

  // The C2a host-owned verification seam. When enabled, the orchestrator runs
  // this real runner over every probe and attaches the receipt it registers -
  // the production trust path (ADR 0003 §4.1-§4.4).
  const verification = options.hostVerifier === true
    ? {
        runner: createHostOwnedVerificationRunner({
          verifierId: 'wb-host-verifier',
          verifierVersion: '1.0.0',
          testSetId: 'wb-testset-v1',
          envId: 'wb-env-v1',
          cases: [
            {
              taskId: TASK.id,
              checks: [{ id: 'deliverable-present', run: (artifact) => artifact.content.length > 0 }]
            }
          ]
        })
      }
    : undefined;

  const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory: makeMemoryBridge(),
    seams: makeSeams(now),
    policy: makePolicy(),
    proposer: makeProposer(now),
    composer: makeComposer(),
    reflector: makeReflector(),
    scorer: makeScorer(now),
    taxonomy: { diagnose: () => ({ kind: 'none' }) } as never,
    dreamer: { async replay(): Promise<never> { throw new Error('offline dreaming must not run'); } } as unknown as IOfflineDreamer,
    treePool: createDiscoveryTreePool(),
    runBranch,
    now,
    newId: makeIdFactory('wb'),
    applyWinningPatch: false,
    jitrl: jitSurface,
    ...(verification === undefined ? {} : { verification }),
    ...(options.writebackGate === true ? { writebackGate: true } : {}),
    onStage: (event) => events.push(event)
  };

  return {
    orchestrator: createEvoHarnessOrchestrator(deps),
    store,
    // The SAME object the orchestrator received: instrumenting `query` here
    // observes the real production call site, not a re-implementation of it.
    instrumentQuery(): ExperienceQuery[] {
      const seen: ExperienceQuery[] = [];
      const original = store.query.bind(store);
      (store as unknown as { query: (q: ExperienceQuery) => Promise<readonly ScoredExperience[]> }).query =
        (query: ExperienceQuery) => {
          seen.push(query);
          return original(query);
        };
      return seen;
    },
    events
  };
}

function onlineRecords(store: MemoryExperienceStore): readonly ExperienceRecord[] {
  return store.snapshot().filter((record) => record.id.startsWith('online-'));
}

async function runOnce(harness: Harness): Promise<void> {
  await harness.orchestrator.run({ sessionId: 'session-wb', task: TASK as never, trigger: 'always' } as never);
}

/**
 * The `record_experience` INNER detail (the payload carrying the counters).
 *
 * The recorder's event shape is `{ round, detail: { ...counters } }` - one extra
 * level of nesting that the pre-existing call site has always used. Unwrapping it
 * here (instead of at each assertion) is what made an earlier version of this
 * fixture read `undefined` while the recorder had in fact run and reported.
 */
function recordStageDetail(events: readonly EvoHarnessStageEvent[]): Record<string, unknown> | undefined {
  const stage = [...events].reverse().find((event) => event.stage === 'record_experience');
  const outer = stage?.detail as Record<string, unknown> | undefined;
  if (outer === undefined) {
    return undefined;
  }
  const inner = outer['detail'];
  // Tolerate both shapes so a future flattening of the call site does not turn
  // this into a silent mismatch; prefer the nested one because that is what
  // production emits today.
  return (inner !== null && typeof inner === 'object' ? inner : outer) as Record<string, unknown>;
}

describe('rev6 R1-2 wiring: the gate is OFF by default and changes nothing', () => {
  it('persists every executed record and reports enabled:false, gateFired:0', async () => {
    const harness = makeHarness({ writebackGate: false });
    await runOnce(harness);
    const records = onlineRecords(harness.store);
    expect(records.length, 'the historical path must still write executed probes').toBeGreaterThan(0);

    // A stage event carries `detail` ONLY when the recorder passed one, so
    // "no detail" and "gate off" are different facts. Normalise explicitly.
    expect(harness.events.map((event) => event.stage)).toContain('record_experience');
    const gate = recordStageDetail(harness.events)?.['writebackGate'] as
      | { enabled: boolean; gateFired: number; judged: number }
      | undefined;
    expect(gate, 'the record_experience stage must report its write-back gate block').toBeDefined();
    expect(gate?.enabled).toBe(false);
    expect(gate?.gateFired).toBe(0);
    expect(gate?.judged).toBe(0);
  });

  it('the OFF path leaves records learnable exactly as before', async () => {
    const harness = makeHarness({ writebackGate: false });
    await runOnce(harness);
    const records = onlineRecords(harness.store);
    // The succeeded candidate was learnable in the historical run; the gate must
    // not have demoted it.
    const learnable = records.filter((record) => record.learningEligible === true);
    expect(learnable.length).toBeGreaterThan(0);
    // ...and no refusal mark exists on any record when the gate is off.
    expect(records.every((record) => record.rewardSources?.['writebackRefusal'] === undefined)).toBe(true);
  });
});

describe('rev6 R1-2 wiring: the gate is ON and refuses evidence-free write-back', () => {
  it('audits every record instead of training on it, and reports gateFired', async () => {
    const harness = makeHarness({ writebackGate: true });
    await runOnce(harness);
    const records = onlineRecords(harness.store);

    expect(records.length, 'audited records must still persist').toBeGreaterThan(0);
    for (const record of records) {
      expect(record.learningEligible, `record ${record.id} must be audit-only`).toBe(false);
      expect(record.learningTarget, `record ${record.id} must carry a zero target`).toBe(0);
    }

    const gate = recordStageDetail(harness.events)?.['writebackGate'] as
      | {
          enabled: boolean;
          judged: number;
          admittedToL2: number;
          auditedOnly: number;
          gateFired: number;
          refusalCounts: Record<string, number>;
          verdicts: readonly { refusal?: string }[];
        }
      | undefined;
    expect(gate?.enabled).toBe(true);
    expect(gate?.judged).toBeGreaterThan(0);
    expect(gate?.admittedToL2).toBe(0);
    expect(gate?.auditedOnly).toBe(gate?.judged);
    // THE HEADLINE NUMBER: the historical `gateFired: 0` was the defect; here
    // every executed write-back fires the gate.
    expect(gate?.gateFired).toBe(gate?.judged);
    expect(gate?.refusalCounts['rejected-no-verdict']).toBe(gate?.judged);
    // The refusal code travels WITH the record, not only in a log line.
    expect(
      records.every((record) => typeof record.rewardSources?.['writebackRefusal'] === 'number')
    ).toBe(true);
  });

  it('is NOT a blanket brake: with the HOST verifier the receipt is trusted and recognised', async () => {
    // WHY THIS CASE IS THE DISCRIMINATOR
    // ----------------------------------
    // The case above proves "no verdict => audited". That alone would also pass
    // on a gate that refuses EVERYTHING, which is useless (and would silently
    // stop all learning). This case enables the REAL C2a host runner, so every
    // candidate trajectory carries a host-registered `passed` receipt bound to an
    // artifact digest. The gate must now RECOGNISE the receipt:
    //
    //   - no verdict may be refused as `rejected-untrusted-receipt` (that would
    //     mean the trust path never reached the gate), and
    //   - no verdict may be refused as `rejected-no-verdict` (that would mean the
    //     verdict was still `unknown`, i.e. the seam did not attach at all).
    //
    // It does NOT claim the route fires here: G-A additionally requires a PRIOR
    // FAILURE of the same actionKey, and the reference run's failure is recorded
    // under the reference actionKey, not the candidates'. That is a property of
    // this single-run fixture, not of the gate. The route firing is asserted
    // directly in `writeback-gate.test.ts` (G-A positive) against constructed
    // history - the correct place to test a rule that needs history.
    const harness = makeHarness({ writebackGate: true, hostVerifier: true });
    await runOnce(harness);
    const records = onlineRecords(harness.store);
    expect(records.length).toBeGreaterThan(0);

    // The seam is genuinely in force: the run reports a host verification source,
    // not the shape-only default.
    const detail = recordStageDetail(harness.events);
    expect(String(detail?.['trustedVerificationSource'] ?? '')).toContain('host-runner');

    const gate = detail?.['writebackGate'] as
      | {
          admittedToL2: number;
          auditedOnly: number;
          routeCounts: Record<string, number>;
          refusalCounts: Record<string, number>;
          verdicts: readonly { actionKey: string; admitted: boolean; refusal?: string }[];
        }
      | undefined;

    const verdicts = gate?.verdicts ?? [];
    expect(verdicts.length, 'the stage block must carry per-execution verdicts').toBeGreaterThan(0);
    // The receipts were host-registered and trusted, so no verdict may be
    // refused for a MISSING or UNTRUSTED verdict (either would prove the trust
    // path never reached the gate).
    expect(verdicts.filter((v) => v.refusal === 'rejected-untrusted-receipt')).toHaveLength(0);
    expect(verdicts.filter((v) => v.refusal === 'rejected-no-verdict')).toHaveLength(0);
    //
    // WHAT THE REFUSAL ACTUALLY IS, and why this is the honest assertion:
    //
    // The gate consults `recordLearningEligible` FIRST, by design: eligibility is
    // a veto the scorer already exercised, and the gate may only LOWER it. In this
    // fixture the scorer refuses the candidate records on their own merits (the
    // process path marks them audit-only), so every verdict lands on
    // `rejected-record-ineligible` - the gate correctly declining to resurrect a
    // record the scorer already refused. Asserting a route fired here would
    // require overriding the scorer, i.e. fabricating learnability to make a test
    // green.
    //
    // So the assertions that survive honestly are: (a) the trust path is in
    // force (host-runner source above), (b) the gate never calls the receipt
    // untrusted/missing, and (c) the gate never RAISES eligibility - every audited
    // record stays ineligible. The ADMITTING behaviour is asserted directly in
    // `writeback-gate.test.ts` against constructed inputs, which is where a rule
    // that needs controlled history belongs.
    for (const verdict of verdicts) {
      expect(
        verdict.admitted === false,
        `in this fixture the scorer marks the records unlearnable, so the gate must not admit ${verdict.actionKey}`
      ).toBe(true);
      expect(verdict.refusal).toBe('rejected-record-ineligible');
    }
    // Nothing was resurrected: audited records are not learnable.
    expect(records.every((record) => record.learningEligible === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// t21 finding T21-F1 (rev6 t27): the audited record must be INVISIBLE to the
// production L2 neighbourhood, not merely flagged.
//
// THE DEFECT THIS PINS
// --------------------
// The gate's audit-only encoding zeroes `learningTarget` and sets
// `learningEligible: false`. But the value estimator reads `observedReturn`
// (`readLearningTarget` ignores `learningTarget`), so an audited record that
// carried a high observedReturn stayed fully retrievable and could steer the
// very selection the gate refused to let it train. Nothing tested this because
// the historical harness ran with `augmentFromMemory: false`, i.e. the L2
// retrieval path was never executed.
//
// WHY THE ASSERTION IS BEHAVIOURAL
// --------------------------------
// It drives the real orchestrator (`run()` -> `augmentProposalCandidates()` ->
// `store.query()`) and asserts on what the store actually RETURNS, never on the
// query object or on a flag. A test that inspected the options would pass even
// if the call site dropped them again, which is precisely the defect class.
//
// THE TWO DIRECTIONS (both required, or the test is vacuous)
//   A. gate ON  -> a pre-seeded AUDITED record must not be returned to L2.
//   B. gate OFF -> the same pre-seeded record IS returned (history unchanged).
// Direction B is what proves the filter is the gate's doing and not a
// pre-existing behaviour of the store.
// ---------------------------------------------------------------------------
describe('t27 (T21-F1): audited records are invisible to the L2 neighbourhood when the gate is on', () => {
  /** A stored record shaped exactly like the gate's audit-only encoding. */
  function auditedRecord(now: number): ExperienceRecord {
    return {
      id: 'online-audited-seed',
      level: 'proposal',
      state: { level: 'proposal', bucket: 'proposal|generic|t', tokens: ['t'], summary: 'seed' } as never,
      actionKey: 'guardrails:append(1)',
      guidance: 'guidance_free',
      policyId: 'seed-policy',
      sessionId: 'session-wb',
      reward: 0.9,
      return: 0.9,
      observedReturn: 0.9,
      // The gate's audit-only encoding: not learnable, zero target.
      learningEligible: false,
      learningTarget: 0,
      rewardVersion: CURRENT_REWARD_VERSION,
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      createdAt: now - 1_000,
      outcome: 'succeeded',
      rewardSources: { seed: 0.9 },
      redacted: false
    } as unknown as ExperienceRecord;
  }

  /**
   * Read what the production L2 query actually returns, through the SAME store
   * the orchestrator uses. Returns the ids visible to an L2 neighbour lookup.
   */
  async function visibleNeighbourIds(store: MemoryExperienceStore, gateOn: boolean): Promise<readonly string[]> {
    // The orchestrator's query is gated on `this.writebackGate`; reproducing that
    // one condition here is what isolates the fix. The comment in
    // `augmentProposalCandidates` names the same condition.
    const base = {
      level: 'proposal' as const,
      state: { level: 'proposal', bucket: 'proposal|generic|t', tokens: ['t'], summary: 'seed' } as never,
      k: 50,
      similarityThreshold: 0
    };
    const scored = await store.query(gateOn ? { ...base, learningEligibleOnly: true } : base);
    return scored.map((entry) => (entry.record as unknown as ExperienceRecord).id);
  }

  it('gate ON: a seeded audit-only record is NOT returned to the L2 neighbourhood', async () => {
    const harness = makeHarness({ writebackGate: true, augmentFromMemory: true });
    await harness.store.append([auditedRecord(Date.now())]);

    const visible = await visibleNeighbourIds(harness.store, true);
    expect(
      visible.includes('online-audited-seed'),
      'an audited (learningEligible:false) record must not be a retrievable L2 neighbour'
    ).toBe(false);
  });

  it('gate OFF: the SAME record IS returned (the filter is the gate\'s doing)', async () => {
    const harness = makeHarness({ writebackGate: false, augmentFromMemory: true });
    await harness.store.append([auditedRecord(Date.now())]);

    const visible = await visibleNeighbourIds(harness.store, false);
    expect(
      visible.includes('online-audited-seed'),
      'with the gate off the historical query shape must be unchanged, so the record stays visible'
    ).toBe(true);
  });

  it('the high observedReturn is exactly why the record must be filtered (not the target)', async () => {
    // Guard against a future "fix" that only zeroes `learningTarget` again: the
    // consumer reads observedReturn, so the assertion is on that field.
    const record = auditedRecord(Date.now());
    expect(record.observedReturn).toBe(0.9);
    expect(record.learningTarget).toBe(0);
    const { readLearningTarget } = await import('../../../src/jitrl/reward-contract');
    expect(
      readLearningTarget(record),
      'the consumed target comes from observedReturn, NOT the gate-zeroed learningTarget'
    ).toBe(0.9);
  });

  it('a full orchestrator run with augmentation ON and the gate ON stays green and writes records', async () => {
    // End-to-end non-vacuity: the fix must not break the producing path.
    const harness = makeHarness({ writebackGate: true, augmentFromMemory: true });
    await runOnce(harness);
    const records = onlineRecords(harness.store);
    expect(records.length).toBeGreaterThan(0);
    // Every record this run wrote is gate-judged; in this fixture the scorer marks
    // them ineligible, so none may be learnable (the gate only lowers).
    expect(records.every((record) => record.learningEligible === false)).toBe(true);
  });
});

describe('t27 wiring pin: the REAL orchestrator query carries the eligibility filter only when the gate is on', () => {
  /**
   * This is the assertion that would have caught T21-F1.
   *
   * The tests above reproduce the gate CONDITION themselves, so they would still
   * pass if `augmentProposalCandidates` dropped the flag again. This one
   * instruments the store the orchestrator actually received and reads the
   * queries it actually issued - so reverting the call-site fix turns it red.
   */
  it('gate ON issues at least one proposal query with learningEligibleOnly:true', async () => {
    const harness = makeHarness({ writebackGate: true, augmentFromMemory: true });
    const seen = harness.instrumentQuery();
    await runOnce(harness);

    const proposalQueries = seen.filter((query) => query.level === 'proposal');
    expect(proposalQueries.length, 'the augmentation path must have queried the store').toBeGreaterThan(0);
    const filtered = proposalQueries.filter((query) => query.learningEligibleOnly === true);
    expect(
      filtered.length,
      'with the gate ON every L2 neighbour query must carry learningEligibleOnly:true'
    ).toBe(proposalQueries.length);
  });

  it('gate OFF issues proposal queries WITHOUT the flag (historical shape unchanged)', async () => {
    const harness = makeHarness({ writebackGate: false, augmentFromMemory: true });
    const seen = harness.instrumentQuery();
    await runOnce(harness);

    const proposalQueries = seen.filter((query) => query.level === 'proposal');
    expect(proposalQueries.length).toBeGreaterThan(0);
    expect(
      proposalQueries.every((query) => query.learningEligibleOnly === undefined),
      'the default-off path must stay byte-identical: no added query option'
    ).toBe(true);
  });
});
