/**
 * CORE-5 / INT-8, CORE-8 and INT-9 regressions in the orchestrator.
 *
 * Every assertion below is written so the PRE-FIX implementation fails it:
 *  - CORE-5 / INT-8: the experience dedup keys were added BEFORE the store
 *    append, so one transient append failure permanently suppressed the retry
 *    (and the register-on-success discipline the quality registrations already
 *    followed was inverted). Now the keys enter the ledger only after the append
 *    resolves.
 *  - CORE-8: the `stopReason = stop ? 'stopped' : 'rounds_completed'` fallback
 *    was dead ('stopped' was unreachable) and 'rounds_completed' mislabelled the
 *    two real stop-free exits. They now report `policy_no_slots` /
 *    `no_candidates`.
 *  - INT-9: `unregisteredQualityRecords` was write-only (two references, no
 *    reader) and its comment claimed a consumption that never existed. The
 *    field is gone; the rollback is owned by `pendingQualityRegistrations`.
 *
 * The harness drives the REAL `recordOnlineExperience` (private-method access,
 * the same pattern tests/unit/verification/recorder-marks.test.ts uses) over a
 * real in-memory experience store with a fake kernel whose `append` can be made
 * to fail on the first call only.
 */
import { describe, expect, it } from 'vitest';
import { EvoHarnessOrchestratorImpl, type EvoHarnessOrchestratorDeps } from '../../../src/orchestrator';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { createDiscoveryTreePool } from '../../../src/dream-rsi';
import type {
  ExperienceRecord,
  ProbeTrajectory
} from '../../../src/types/contracts';

const T0 = 1_700_000_000_000;
const RUN = 'run-core-p2';

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-core-1',
    sessionId: 'sess-core',
    branchId: 'branch-core',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch-core',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    deliverable: { content: '{"ok":true}', format: 'json' },
    ...overrides
  } as ProbeTrajectory;
}

interface RecorderHarness {
  readonly store: ReturnType<typeof createMemoryExperienceStore>;
  readonly attempts: { readonly appended: number }[];
  readonly record: () => Promise<number>;
  readonly failNextAppend: () => void;
  readonly diagnostics: string[];
  readonly deps: EvoHarnessOrchestratorDeps;
}

function recorderHarness(seed: readonly ExperienceRecord[] = []): RecorderHarness {
  const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
  for (const record of seed) {
    // Seed the store synchronously (the real append is async, but the memory
    // drive keeps a synchronous snapshot; the recorder only needs the shape).
    void record;
  }
  const attempts: { appended: number }[] = [];
  const diagnostics: string[] = [];
  let failOnce = false;
  const kernel = {
    config: { enabled: true, levels: ['meta', 'proposal'], gamma: 0.9, candidateCount: 3 },
    store: {
      append: async (records: readonly ExperienceRecord[]) => {
        if (failOnce) {
          failOnce = false;
          attempts.push({ appended: 0 });
          throw new Error('disk full (transient store failure)');
        }
        attempts.push({ appended: records.length });
        await store.append(records);
      },
      query: (query: never) => store.query(query),
      size: () => store.size()
    },
    stepEvaluator: { evaluate: async () => [] }
  };
  const deps = {
    config: parseEvoHarnessConfig({
      probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 },
      logging: { level: 'silent' }
    }),
    memory: {},
    seams: {},
    policy: {},
    proposer: {},
    composer: {},
    reflector: {},
    scorer: {},
    taxonomy: {},
    dreamer: {},
    treePool: {},
    runBranch: async () => ({}),
    jitrl: kernel,
    executionProfile: resolveExecutionProfile({ mode: 'shadow' })
  } as unknown as EvoHarnessOrchestratorDeps;
  const orch = new EvoHarnessOrchestratorImpl(deps);
  const internals = orch as unknown as {
    recordOnlineExperience: (input: never) => Promise<number>;
  };
  const reference = trajectory({ id: 'traj-core-ref', role: 'reference', status: 'failed' });
  const candidate = trajectory({ id: 'traj-core-cand' });
  return {
    store,
    attempts,
    diagnostics,
    deps,
    failNextAppend: () => {
      failOnce = true;
    },
    record: async () =>
      internals.recordOnlineExperience({
        // The SAME execution both times: the dedup ledger is per (level,
        // actionKey, node, trajectory, round), so a retry of this exact batch
        // must be admitted again after a failed append.
        kernel,
        task: { id: 'task-core', prompt: 'record the execution' },
        sessionId: 'sess-core',
        executed: [
          {
            round: 1,
            slotIndex: 0,
            slot: { slot: 'exploit', slotIndex: 0, branchId: candidate.branchId, guidance: 'memory' },
            l1State: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
            nodeId: 'n1',
            parentNodeId: 'root',
            branchId: candidate.branchId,
            actionKey: 'slot:exploit',
            guidance: 'memory',
            trajectory: candidate
          }
        ],
        reference,
        selectedNodeId: 'n1',
        policyId: 'pi',
        runId: RUN,
        treeId: 'tree-core',
        round: 1,
        stage: () => undefined,
        diagnostics
      } as never)
  };
}

function onlineRecords(store: ReturnType<typeof createMemoryExperienceStore>): readonly ExperienceRecord[] {
  return store.snapshot().filter((record) => record.id.startsWith('online-'));
}

// ---------------------------------------------------------------------------
// CORE-5 / INT-8: register the dedup key only AFTER the append succeeds
// ---------------------------------------------------------------------------

describe('CORE-5 / INT-8: the dedup ledger is register-on-success', () => {
  it('a failed append stays retryable and the retry actually reaches the store', async () => {
    const h = recorderHarness();
    h.failNextAppend();

    const first = await h.record();
    // Pre-fix the keys were already in the ledger, so this call returned 0 and
    // the append never ran again for the instance's whole lifetime.
    expect(first).toBe(0);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]?.appended).toBe(0);
    expect(h.diagnostics.join(' ')).toContain('record_experience failed');
    expect(onlineRecords(h.store)).toHaveLength(0);

    const second = await h.record();
    expect(second).toBeGreaterThan(0);
    expect(h.attempts).toHaveLength(2);
    // The retry really shipped: the record is in the store now.
    expect(h.attempts[1]?.appended).toBeGreaterThan(0);
    expect(onlineRecords(h.store).length).toBeGreaterThan(0);
  });

  it('a SUCCESSFUL append still suppresses a re-entered batch (the original purpose is intact)', async () => {
    const h = recorderHarness();
    const first = await h.record();
    expect(first).toBeGreaterThan(0);
    expect(onlineRecords(h.store).length).toBeGreaterThan(0);

    const second = await h.record();
    expect(second).toBe(0);
    expect(h.attempts).toHaveLength(1);
    expect(h.diagnostics.join(' ')).toContain('already appended');
  });
});

// ---------------------------------------------------------------------------
// INT-9: the write-only rollback array is gone
// ---------------------------------------------------------------------------

describe('INT-9: no write-only rollback array remains', () => {
  it('the orchestrator instance exposes no `unregisteredQualityRecords` field', () => {
    const h = recorderHarness();
    const orch = new EvoHarnessOrchestratorImpl(h.deps);
    // Pre-fix this field existed and grew once per rolled-back task-quality
    // record for the process lifetime; nothing ever read, bounded or cleared it.
    expect(
      Object.prototype.hasOwnProperty.call(orch as unknown as Record<string, unknown>, 'unregisteredQualityRecords')
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CORE-8: the two stop-free exits report their own reason
// ---------------------------------------------------------------------------

describe('CORE-8: stopReason names the real exit instead of "rounds_completed"', () => {
  it('a policy that schedules no slots reports policy_no_slots (never rounds_completed/stopped)', async () => {
    const { createEvoHarnessOrchestrator } = await import('../../../src/orchestrator');
    const config = createDefaultConfig();
    const deps = {
      config,
      memory: {
        initialize: async () => ({}),
        recall: async () => ({
          query: {
            scope: { kind: 'session', sessionId: 'sess-core8' },
            text: 'anything'
          },
          scope: { kind: 'session', sessionId: 'sess-core8' },
          driverKind: 'vector_fact',
          lessons: [],
          positiveLessons: [],
          negativeLessons: [],
          suppressedLessons: [],
          confidence: 0.1,
          degraded: false,
          diagnostics: [],
          recalledAt: 0
        }),
        commit: async () => ({ accepted: true, persisted: true }),
        isolate: async (scope: unknown) => ({ scope, namespace: 'n', active: true, release: async () => undefined }),
        promote: async () => ({ accepted: true, persisted: true }),
        prune: async () => ({ scanned: 0, removedIds: [], dryRun: false }),
        dispose: async () => undefined,
        descriptor: () => ({})
      },
      seams: {
        runInIsolatedBranch: async () => trajectory({ role: 'reference', status: 'failed' }),
        applyPermanentPatch: async () => ({ patchId: 'p', active: true, dispose: async () => undefined }),
        listActiveBranches: () => [],
        dispose: async () => undefined
      },
      policy: {
        // Zero slots: the one documented "the policy produced nothing" exit.
        policy: { id: 'pi', version: 1, createdAt: 0, maxWidth: 1, maxDepth: 1, slotWeights: {}, earlyStopThreshold: 1, minMemoryConfidenceForSkip: 1 },
        planGrid: () => ({
          maxWidth: 1,
          maxDepth: 1,
          budget: 1,
          skipProbing: false,
          stopCondition: 'max_depth',
          complexity: 'moderate',
          rationale: 'empty plan',
          policyId: 'pi'
        }),
        selectBatch: (request: { readonly round: number; readonly grid: unknown }) => ({
          round: request.round,
          grid: request.grid,
          policyId: 'pi',
          width: 0,
          slots: [],
          createdAt: 0
        }),
        update: () => undefined
      },
      proposer: { propose: async () => { throw new Error('must not be called'); }, proposeCandidates: async () => { throw new Error('must not be called'); } },
      composer: { compose: async () => { throw new Error('must not be called'); } },
      reflector: { reflect: async () => ({ lessons: [], positiveCount: 0, negativeCount: 0, diagnostics: [] }) },
      scorer: { score: () => ({ nodeId: 'n', score: 0, signals: {}, weights: {}, computedAt: 0, evidence: [] }) },
      taxonomy: { diagnose: () => ({ category: 'none', confidence: 1, repairable: false, recommendedAction: 'deepen', evidence: [], signals: [] }) },
      dreamer: { replay: async () => { throw new Error('no dreaming'); } },
      treePool: createDiscoveryTreePool(),
      runBranch: async () => ({ status: 'failed', steps: [], toolErrors: [], failureSignals: [] }),
      now: () => T0,
      newId: (() => {
        let counter = 0;
        return () => {
          counter += 1;
          return 'c8-' + String(counter);
        };
      })(),
      applyWinningPatch: false
    } as unknown as EvoHarnessOrchestratorDeps;

    const orchestrator = createEvoHarnessOrchestrator(deps);
    const result = await orchestrator.run({
      sessionId: 'sess-core8',
      task: { id: 'task-core8', prompt: 'plan with no slots' },
      trigger: 'always'
    });

    expect(result.metadata?.stopReason).toBe('policy_no_slots');
    // Pre-fix both exits collapsed into these two names; 'stopped' was dead.
    expect(result.metadata?.stopReason).not.toBe('rounds_completed');
    expect(result.metadata?.stopReason).not.toBe('stopped');
    expect(result.metadata?.stopReason).not.toBe('not_started');
  });
});

// ---------------------------------------------------------------------------
// INT-6: the reward-contract identity is single-sourced and the metadata key
// the orchestrator reads is witnessed against the producer's export
// ---------------------------------------------------------------------------

describe('INT-6: the reward-contract identity is single-sourced', () => {
  it('the shared contract exports still carry the frozen values', async () => {
    const {
      REWARD_CONTRACT,
      REWARD_CONTRACT_VERSION,
      REWARD_CONTRACT_AGGREGATION,
      REWARD_CONTRACT_VERIFIER_FIRST
    } = await import('../../../src/jitrl/reward-contract');
    expect(REWARD_CONTRACT.version).toBe(REWARD_CONTRACT_VERSION);
    expect(REWARD_CONTRACT.aggregation).toBe(REWARD_CONTRACT_AGGREGATION);
    expect(REWARD_CONTRACT_VERIFIER_FIRST).toBe('verifier-first-completion-v1');
  });

  it('no seam hand-copies the reward-contract identity any more (INT-6)', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    // Both literals used to be typed by hand at the two seams; they must now be
    // imported, so the strings may appear only inside the reward-contract module.
    const sources = [
      path.resolve(process.cwd(), 'src/dsh-bridge/real-benefit-controller.ts'),
      path.resolve(process.cwd(), 'src/orchestrator.ts')
    ];
    for (const file of sources) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toContain("'r4/verifier-first-v1'");
      expect(text, file).not.toContain("'trajectory-signals-v1'");
      expect(text, file).not.toContain("'verifier-first-completion-v1'");
    }
  });

  it('the orchestrator reads metadata[JIT_BATCH_METADATA_KEY] (a renamed key loses jit_meta_adjust)', async () => {
    const { createEvoHarnessOrchestrator } = await import('../../../src/orchestrator');
    const { JIT_BATCH_METADATA_KEY } = await import('../../../src/jitrl/jit-active-policy');
    // The producer names the metadata key with the export; the orchestrator reads
    // the same literal WITHOUT importing src/jitrl/** (a documented decoupling).
    // If either side renames the string, this behavioural witness goes red
    // because the `jit_meta_adjust` stage stops appearing at all.
    const stages: string[] = [];
    const policy = {
      policy: { id: 'pi', version: 1, createdAt: 0, maxWidth: 1, maxDepth: 1, slotWeights: {}, earlyStopThreshold: 1, minMemoryConfidenceForSkip: 1 },
      planGrid: () => ({
        maxWidth: 1,
        maxDepth: 1,
        budget: 1,
        skipProbing: false,
        stopCondition: 'max_depth',
        complexity: 'moderate',
        rationale: 'one empty round',
        policyId: 'pi'
      }),
      selectBatch: (request: { readonly round: number; readonly grid: unknown }) => ({
        round: request.round,
        grid: request.grid,
        policyId: 'pi',
        width: 0,
        slots: [],
        // Exactly the shape the decorator attaches.
        metadata: { [JIT_BATCH_METADATA_KEY]: { stateValue: 0, neighborCount: 3, klToPrior: 0.1 } },
        createdAt: 0
      }),
      update: () => undefined
    };
    const deps = {
      config: createDefaultConfig(),
      memory: {
        initialize: async () => ({}),
        recall: async () => ({
          lessons: [],
          positiveLessons: [],
          negativeLessons: [],
          suppressedLessons: [],
          confidence: 0.1,
          degraded: false,
          diagnostics: [],
          recalledAt: 0
        }),
        commit: async () => ({ accepted: true, persisted: true }),
        isolate: async (scope: unknown) => ({ scope, namespace: 'n', active: true, release: async () => undefined }),
        promote: async () => ({ accepted: true, persisted: true }),
        prune: async () => ({ scanned: 0, removedIds: [], dryRun: false }),
        dispose: async () => undefined,
        descriptor: () => ({})
      },
      seams: {
        runInIsolatedBranch: async () => trajectory({ role: 'reference', status: 'failed' }),
        applyPermanentPatch: async () => ({ patchId: 'p', active: true, dispose: async () => undefined }),
        listActiveBranches: () => [],
        dispose: async () => undefined
      },
      policy,
      proposer: { propose: async () => { throw new Error('must not be called'); }, proposeCandidates: async () => { throw new Error('must not be called'); } },
      composer: { compose: async () => { throw new Error('must not be called'); } },
      reflector: { reflect: async () => ({ lessons: [], positiveCount: 0, negativeCount: 0, diagnostics: [] }) },
      scorer: { score: () => ({ nodeId: 'n', score: 0, signals: {}, weights: {}, computedAt: 0, evidence: [] }) },
      taxonomy: { diagnose: () => ({ category: 'none', confidence: 1, repairable: false, recommendedAction: 'deepen', evidence: [], signals: [] }) },
      dreamer: { replay: async () => { throw new Error('no dreaming'); } },
      treePool: createDiscoveryTreePool(),
      runBranch: async () => ({ status: 'failed', steps: [], toolErrors: [], failureSignals: [] }),
      now: () => T0,
      newId: (() => {
        let counter = 0;
        return () => {
          counter += 1;
          return 'i6-' + String(counter);
        };
      })(),
      applyWinningPatch: false,
      onStage: (event: { readonly stage: string }) => stages.push(event.stage)
    } as unknown as EvoHarnessOrchestratorDeps;

    const orchestrator = createEvoHarnessOrchestrator(deps);
    await orchestrator.run({
      sessionId: 'sess-int-6',
      task: { id: 'task-int-6', prompt: 'read the jit diagnostics' },
      trigger: 'always'
    });

    expect(JIT_BATCH_METADATA_KEY).toBe('jit');
    expect(stages).toContain('jit_meta_adjust');
  });
});

