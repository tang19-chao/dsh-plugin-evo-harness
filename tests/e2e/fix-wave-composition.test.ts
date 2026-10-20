/**
 * Consolidation tests for the t12-t16 fix wave.
 *
 * These exercise the *interactions* between the five fixes rather than each fix
 * in isolation: composer adoption keys feeding post-composition scoring, tree
 * evidence feeding recovery slots, promotion polarity through the governed
 * commit, and host disposal across a dreaming run. Self-contained: the recording
 * composer and the clearing policy wrapper live here, not in fixtures.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  BatchPlan,
  CompositionResult,
  ComposeRequest,
  DiscoveryNode,
  IActivePolicy,
  IHarnessComposer,
  MetaSearchPolicy,
  PlanGridRequest,
  ProbeTrajectory,
  SearchGridPlan,
  SelectBatchRequest
} from '../../src/types/contracts';
import { parseEvoHarnessConfig } from '../../src/config';
import { createSurrogateScorer } from '../../src/dream-rsi';
import { createAnonymousComposer } from '../../src/harness2';
import { createEvoHarnessPlugin } from '../../src/index';
import { createMemoryBridge } from '../../src/memory-bridge';
import {
  buildE2E,
  createRecordingPolicy,
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

interface RecordingComposer extends IHarnessComposer {
  readonly requests: ComposeRequest[];
}

/** Wrap the real anonymous composer, recording every composition request. */
function createRecordingComposer(base: IHarnessComposer): RecordingComposer {
  const requests: ComposeRequest[] = [];
  return {
    requests,
    async compose(request: ComposeRequest): Promise<CompositionResult> {
      requests.push(request);
      return base.compose(request);
    }
  };
}

/** Real policy wrapped so previousFailure always reaches it as cleared. */
function createClearingPolicy(base: IActivePolicy): IActivePolicy {
  return {
    get policy(): MetaSearchPolicy {
      return base.policy;
    },
    planGrid(request: PlanGridRequest): SearchGridPlan {
      return base.planGrid(request);
    },
    selectBatch(request: SelectBatchRequest): BatchPlan {
      return base.selectBatch({ ...request, previousFailure: undefined });
    },
    update(policy: MetaSearchPolicy): void {
      base.update(policy);
    }
  };
}

describe('fix-wave composition', () => {
  it('drives the persisted post-compose score through the composer adoption keys', async () => {
    const server = mem0LikeServer();
    const now = makeClock();
    const model = createScriptedModel();
    const config = parseEvoHarnessConfig(e2eConfig());
    const composer = createRecordingComposer(
      createAnonymousComposer({ model, now, newId: makeIdFactory('composer') })
    );
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model,
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('score-compose'),
        deps: { composer }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-compose',
      task: plugin.makeTask({ id: 'task-compose', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    const composition = plugin.orchestrator.lastComposition();
    expect(composition).not.toBeNull();
    const assessment = composition?.assessments.find((entry) => entry.selected);
    expect(assessment).toBeDefined();
    expect(assessment?.adoptionRatio ?? 0).toBeGreaterThan(0.5);

    const request = composer.requests[composer.requests.length - 1];
    const candidate = request?.candidates.find((entry) => entry.nodeId === assessment?.nodeId);
    expect(candidate).toBeDefined();

    const tree = plugin.orchestrator.treePool.list()[0];
    const node = tree?.nodes[assessment?.nodeId ?? ''];
    expect(node).toBeDefined();

    // t13 x t12(A): the composed ratio is addressable under all three identities
    const ratios = composition?.adoptionRatios ?? {};
    const expected = assessment?.adoptionRatio ?? -1;
    expect(ratios[assessment?.alias ?? '']).toBeCloseTo(expected, 6);
    expect(ratios[assessment?.branchId ?? '']).toBeCloseTo(expected, 6);
    expect(ratios[assessment?.nodeId ?? '']).toBeCloseTo(expected, 6);

    // t12(A): the persisted score is exactly what the scorer derives from the
    // composition, which is only possible when the adoption keys resolve
    const scorer = createSurrogateScorer({
      defaultWeights: plugin.config.dreamRsi.surrogateWeights,
      now: makeClock()
    });
    const rescored = scorer.score({
      node: node as DiscoveryNode,
      trajectory: candidate?.trajectory as ProbeTrajectory,
      ...(request?.reference === undefined ? {} : { referenceTrajectory: request.reference }),
      composition: composition as CompositionResult,
      weights: plugin.config.dreamRsi.surrogateWeights
    });

    expect(rescored.signals.selected).toBe(true);
    expect(rescored.signals.adoptionRatio).toBeCloseTo(expected, 6);
    expect(rescored.score).toBeCloseTo(node?.score ?? -1, 6);
    expect(node?.adoptionRatio).toBeCloseTo(expected, 6);
    // well above the pre-fix 0.2 ceiling of the deadlocked selection signal
    expect(node?.score ?? 0).toBeGreaterThan(0.5);
  });

  it('produces recovery slots from tree evidence even when previousFailure is cleared', async () => {
    const options = { maxWidth: 2, maxDepth: 2, rolloutBudget: 6, dreamEveryNTasks: 100 } as const;
    const recording = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'succeed'],
      extra: { deps: { policy: createClearingPolicy(recording) } }
    });

    const result = await plugin.run({
      sessionId: 'sess-tree-evidence',
      task: plugin.makeTask({ id: 'task-tree-evidence', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(recording.selectBatchRequests.length).toBeGreaterThanOrEqual(2);
    const second = recording.selectBatchRequests[1];
    // t15: the failure reaching the scheduler is deliberately cleared
    expect(second?.previousFailure).toBeUndefined();

    const repairableFailures = Object.values(second?.tree.nodes ?? {}).filter(
      (entry) => entry.status === 'failed' && entry.failure?.repairable === true
    );
    expect(repairableFailures.length).toBeGreaterThanOrEqual(1);

    const recoverSlot = recording.batchPlans[1]?.slots.find((slot) => slot.slot === 'recover');
    expect(recoverSlot).toBeDefined();
    expect(repairableFailures.map((entry) => entry.id)).toContain(recoverSlot?.repairOfNodeId);
    expect(recoverSlot?.seedPatchIds?.length ?? 0).toBeGreaterThan(0);
  });

  it('promotes only positive lessons to global scope through the governed commit', async () => {
    const server = mem0LikeServer();
    const config = parseEvoHarnessConfig(e2eConfig({ maxWidth: 2, maxDepth: 1, rolloutBudget: 4 }));
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now, { candidateOutcomes: ['fail', 'succeed'] }),
        now,
        newId: makeIdFactory('polarity'),
        deps: { memory }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-polarity',
      task: plugin.makeTask({ id: 'task-polarity', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.join(' ')).toContain('promoted lesson');

    const sessionRecall = await memory.recall({
      scope: { kind: 'session', sessionId: 'sess-polarity' },
      text: 'Fix the failing build.',
      includeNegative: true,
      limit: 10
    });
    // the negative lesson was committed but must stay out of global scope
    expect(sessionRecall.negativeLessons.length).toBeGreaterThanOrEqual(1);

    const globalRecall = await memory.recall({
      scope: { kind: 'global' },
      text: 'Fix the failing build.',
      includeNegative: true,
      limit: 10
    });
    expect(globalRecall.positiveLessons.length).toBeGreaterThanOrEqual(1);
    expect(globalRecall.negativeLessons).toEqual([]);
  });

  it('keeps host disposal exact across a dreaming run', async () => {
    const forkDisposals: string[] = [];
    const workspaceDisposals: string[] = [];
    let forkCalls = 0;
    let workspaceCalls = 0;
    const ctx = {
      fork: vi.fn((request: { branchId: string }) => {
        forkCalls += 1;
        return {
          contextId: 'ctx-' + request.branchId,
          dispose: vi.fn(async () => {
            forkDisposals.push(request.branchId);
          })
        };
      }),
      sandbox: {
        acquireWorkspace: vi.fn((request: { branchId: string }) => {
          workspaceCalls += 1;
          return {
            id: 'ws-' + request.branchId,
            path: '/tmp/' + request.branchId,
            dispose: vi.fn(async () => {
              workspaceDisposals.push(request.branchId);
            })
          };
        }),
        mountScript: vi.fn(() => undefined)
      },
      prompt: { registerSegment: vi.fn(() => undefined) },
      permissions: { register: vi.fn(() => undefined) },
      registerCommand: vi.fn(),
      on: vi.fn()
    };
    const now = makeClock();
    const server = mem0LikeServer();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ dreamEveryNTasks: 1 }),
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('disposal-dream')
      },
      ctx
    );

    const result = await plugin.run({
      sessionId: 'sess-disposal-dream',
      task: plugin.makeTask({ id: 'task-disposal-dream', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(plugin.hostAdapterSource).toBe('context');
    expect(result.outcome).toBe('composed');
    // t12(F): the offline dream ran inside the same run
    expect(result.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);

    // t16: every forked context and workspace was disposed exactly once
    expect(forkCalls).toBeGreaterThanOrEqual(2);
    expect(workspaceCalls).toBe(forkCalls);
    expect(forkDisposals).toHaveLength(forkCalls);
    expect(workspaceDisposals).toHaveLength(workspaceCalls);
    expect(new Set(forkDisposals).size).toBe(forkDisposals.length);
    expect(new Set(workspaceDisposals).size).toBe(workspaceDisposals.length);

    await plugin.dispose();
    expect(plugin.orchestrator.isDisposed()).toBe(true);
  });
});
