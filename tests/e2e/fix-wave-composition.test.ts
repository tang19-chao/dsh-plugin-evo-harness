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
  BatchSlotPlan,
  BranchExecutor,
  CompositionResult,
  ComposeRequest,
  DiscoveryNode,
  IActivePolicy,
  IHarnessComposer,
  IModelAdapter,
  IsolatedBranchContext,
  MetaSearchPolicy,
  ModelRequest,
  ModelResponse,
  PlanGridRequest,
  ProbeExecutionResult,
  ProbeTrajectory,
  SearchGridPlan,
  SelectBatchRequest,
  TrajectoryStep
} from '../../src/types/contracts';
import { parseEvoHarnessConfig } from '../../src/config';
import { createActivePolicyFromDefaults, createSurrogateScorer } from '../../src/dream-rsi';
import { createAnonymousComposer, createDualTrackProposer } from '../../src/harness2';
import { createEvoHarnessPlugin } from '../../src/index';
import { createMemoryBridge } from '../../src/memory-bridge';
import {
  buildE2E,
  createRecordingPolicy,
  createRecordingProposer,
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

/**
 * Local policy for the three-round chain regression: exactly one exploit slot per round,
 * deepening the best node so every round's patch is incremental on the previous one.
 */
function createExploitChainPolicy(base: IActivePolicy, now: () => number): IActivePolicy {
  return {
    get policy(): MetaSearchPolicy {
      return base.policy;
    },
    planGrid(request: PlanGridRequest): SearchGridPlan {
      return { ...base.planGrid(request), stopCondition: 'max_depth', maxWidth: 1 };
    },
    selectBatch(request: SelectBatchRequest): BatchPlan {
      // Deepen the deepest node in the snapshot (the previous round's candidate), which
      // makes the round-over-round chain independent of the scorer's best-node bookkeeping.
      let parent = request.tree.nodes[request.tree.rootId];
      for (const node of Object.values(request.tree.nodes)) {
        if (node.id === request.tree.rootId) {
          continue;
        }
        if (parent === undefined || node.depth > parent.depth || (node.depth === parent.depth && node.id > parent.id)) {
          parent = node;
        }
      }
      const slot: BatchSlotPlan = {
        slot: 'exploit',
        slotIndex: 0,
        branchId: 'chain-' + String(request.round),
        parentNodeId: parent?.id ?? request.tree.rootId,
        origin: 'reference',
        guidance: 'memory',
        focusSurfaces: ['system_prompt', 'guardrails', 'skills'],
        rationale: 'one exploit slot per round for the three-round chain regression',
        seedPatchIds: parent === undefined ? [] : [parent.patchId]
      };
      return {
        round: request.round,
        grid: request.grid,
        policyId: request.grid.policyId,
        width: 1,
        slots: [slot],
        createdAt: now()
      };
    },
    update(policy: MetaSearchPolicy): void {
      base.update(policy);
    }
  };
}

/** Local model: a different surface each round, plus a scripted compose verdict. */
function createChainModel(): IModelAdapter {
  let proposals = 0;
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.purpose === 'propose') {
        proposals += 1;
        const payload =
          proposals === 1
            ? {
                rationale: 'round 1: declare the failing tool before retrying',
                focusSurfaces: ['system_prompt'],
                confidence: 0.6,
                edits: {
                  system_prompt: {
                    kind: 'system_prompt',
                    mode: 'append',
                    content: 'round 1: declare the failing tool before retrying'
                  }
                }
              }
            : proposals === 2
              ? {
                  rationale: 'round 2: add an output contract',
                  focusSurfaces: ['guardrails'],
                  confidence: 0.6,
                  edits: { guardrails: { kind: 'guardrails', formatContract: 'round 2 contract' } }
                }
              : {
                  rationale: 'round 3: mount a recovery SOP',
                  focusSurfaces: ['skills'],
                  confidence: 0.6,
                  edits: {
                    skills: {
                      kind: 'skills',
                      skills: [{ name: 'round-3-sop', markdown: '# round 3 SOP', activate: true }]
                    }
                  }
                };
        return { text: JSON.stringify(payload), finishReason: 'stop', model: 'chain-scripted' };
      }
      if (request.purpose === 'compose') {
        const text = request.messages.map((message) => message.content).join(String.fromCharCode(10));
        const aliases = [...new Set(text.match(/candidate_[A-Z]/g) ?? [])];
        return {
          text: JSON.stringify({
            ranking: aliases,
            assessments: aliases.map((alias, index) => ({
              alias,
              rationale: 'ranked ' + String(index + 1) + ' by the chain judge'
            }))
          }),
          finishReason: 'stop',
          model: 'chain-scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'chain-scripted' };
      }
      return { text: JSON.stringify({ policies: [] }), finishReason: 'stop', model: 'chain-scripted' };
    }
  };
}

/** Local runner: the reference fails, then three candidate rounds get steadily better. */
function createChainRunner(now: () => number): BranchExecutor & { readonly calls: string[] } {
  const calls: string[] = [];
  let candidates = 0;
  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const isReference =
      context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
    calls.push(isReference ? 'reference' : 'candidate');
    if (isReference) {
      return {
        status: 'failed',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'plan the migration' },
          {
            index: 1,
            at: now(),
            kind: 'tool',
            toolName: 'shell',
            error: { name: 'ToolError', message: 'exit 1' }
          },
          { index: 2, at: now(), kind: 'error', text: 'the build failed' }
        ],
        toolErrors: [{ toolName: 'shell', message: 'exit 1', code: 'E1', stepIndex: 1, retryable: true }],
        failureSignals: [{ kind: 'tool_error', message: 'exit 1', toolName: 'shell', repairable: true }]
      };
    }
    candidates += 1;
    const round = candidates;
    const stepCount = round === 1 ? 30 : round === 2 ? 12 : 3;
    const errorCount = round === 1 ? 8 : round === 2 ? 3 : 0;
    const padding = round === 1 ? 20 : round === 2 ? 400 : 2000;
    const plan: TrajectoryStep[] = Array.from({ length: stepCount }, (_, index) => ({
      index,
      at: now(),
      kind: index === stepCount - 1 ? 'result' : 'tool',
      toolName: 'shell',
      text: 'round ' + String(round) + ' step ' + String(index)
    }));
    return {
      status: 'succeeded',
      steps: plan,
      toolErrors: Array.from({ length: errorCount }, (_, index) => ({
        toolName: 'shell',
        message: 'round ' + String(round) + ' error ' + String(index),
        retryable: true
      })),
      deliverable: {
        content: 'round ' + String(round) + ' deliverable ' + 'x'.repeat(padding),
        format: 'markdown'
      },
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: round === 1 ? 5000 : round === 2 ? 2000 : 200 }
    };
  };
  return Object.assign(run, { calls });
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

  it('hands the parent candidate patch to round-2 proposals and nothing to the reference root', async () => {
    const options = { maxWidth: 2, maxDepth: 2, rolloutBudget: 6, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const now = makeClock();
    const model = createScriptedModel();
    const proposer = createRecordingProposer(
      createDualTrackProposer({ model, now, newId: makeIdFactory('parent-proposer') })
    );
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'succeed'],
      extra: { deps: { policy, proposer } }
    });

    const result = await plugin.run({
      sessionId: 'sess-parent-patch',
      task: plugin.makeTask({ id: 'task-parent-patch', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    const rootId = policy.selectBatchRequests[0]?.tree.rootId;
    expect(rootId).toBeDefined();

    // round 1 proposals hang off the reference root: no parent patch is handed over
    const roundOne = proposer.requests.filter((request) => request.parentNode?.id === rootId);
    expect(roundOne.length).toBeGreaterThanOrEqual(1);
    for (const request of roundOne) {
      expect(request.parentPatch).toBeUndefined();
    }

    const secondBatchRequest = policy.selectBatchRequests[1];
    expect(secondBatchRequest).toBeDefined();
    const roundTwo = proposer.requests.filter(
      (request) => request.parentNode !== undefined && request.parentNode.id !== rootId
    );
    expect(roundTwo.length).toBeGreaterThanOrEqual(1);
    const exploitOrRecover = roundTwo.filter(
      (request) => request.slot.slot === 'exploit' || request.slot.slot === 'recover'
    );
    expect(exploitOrRecover.length).toBeGreaterThanOrEqual(1);

    // every proposal whose parent is a probed candidate carries that parent's patch
    for (const request of proposer.requests) {
      const parentId = request.parentNode?.id;
      if (parentId === undefined || parentId === rootId) {
        expect(request.parentPatch).toBeUndefined();
        continue;
      }
      expect(request.parentPatch).toBeDefined();
      const parentNode = secondBatchRequest?.tree.nodes[parentId];
      expect(parentNode).toBeDefined();
      expect(request.parentPatch?.id).toBe(parentNode?.patchId);
      expect(request.parentPatch?.edits.guardrails).toBeDefined();
    }
  });

  it('keeps the round-1 surface edit when a three-round exploit chain composes', async () => {
    const now = makeClock();
    const config = parseEvoHarnessConfig(
      e2eConfig({ maxWidth: 1, maxDepth: 3, rolloutBudget: 6, dreamEveryNTasks: 100 })
    );
    const model = createChainModel();
    const runner = createChainRunner(now);
    const policy = createExploitChainPolicy(
      createActivePolicyFromDefaults({ maxWidth: 1, maxDepth: 3 }, { now, maxRecoverySlots: 0 }),
      now
    );
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model,
        clients: [mem0LikeServer().client],
        runBranch: runner,
        now,
        newId: makeIdFactory('chain'),
        deps: { policy }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-chain',
      task: plugin.makeTask({
        id: 'task-chain',
        prompt: 'Evolve the scaffold across three exploit rounds.'
      }),
      trigger: 'always'
    });

    // The reference anchor plus three incremental exploit rounds actually ran.
    expect(result.outcome).toBe('composed');
    expect(runner.calls.filter((call) => call === 'candidate')).toHaveLength(3);

    const composition = plugin.orchestrator.lastComposition();
    const composed = composition?.composedPatch;
    expect(composed).not.toBeNull();
    // The deepest round wins on evidence even though the judge ranks the round-1 alias first.
    expect(composition?.selectedNodeId).toBeDefined();

    // Every round contributes: without the full lineage walk the round-1 system_prompt edit
    // would be silently dropped here (the reported t30 defect).
    expect(Object.keys(composed?.edits ?? {}).sort()).toEqual(['guardrails', 'skills', 'system_prompt']);
    expect(composed?.edits.system_prompt?.content).toBe('round 1: declare the failing tool before retrying');
    expect(composed?.edits.guardrails?.formatContract).toBe('round 2 contract');
    expect(composed?.edits.skills?.skills[0]?.name).toBe('round-3-sop');
    expect(composed?.parentPatchIds).toHaveLength(3);
    expect(new Set(composed?.parentPatchIds ?? []).size).toBe(3);
    expect(composed?.metadata?.lineageDepth).toBe(2);
    expect(composed?.metadata?.baseResolution).toBe('lineage');
    expect(composed?.rationale).toContain('over lineage depth 2');
  });
});
