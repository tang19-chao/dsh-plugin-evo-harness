import { describe, expect, it } from 'vitest';
import { parseEvoHarnessConfig } from '../../src/config';
import { createDiscoveryTreePool, createOfflineDreamer } from '../../src/dream-rsi';
import { createEvoHarnessPlugin } from '../../src/index';
import {
  buildE2E,
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

describe('offline dream trigger', () => {
  it('runs the zero-execution replay once the cadence is reached', async () => {
    const { plugin, runner } = buildE2E({
      dreamEveryNTasks: 1,
      extra: { deps: { dreamMinVerifiedTrees: 0 } }
    });
    const task = plugin.makeTask({ id: 'task-dream-1', prompt: 'Fix the failing build.' });

    const result = await plugin.run({ sessionId: 'sess-dream', task, trigger: 'always' });

    expect(result.outcome).toBe('composed');
    expect(result.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);

    const report = plugin.orchestrator.dreamReports()[0];
    expect(report).toBeDefined();
    expect(report?.replayedTreeIds.length).toBeGreaterThanOrEqual(1);
    expect(report?.rhoPreferences).toEqual([0, 0.5, 1]);
    expect(report?.baseline.policyId).toBe('pi-0');
    expect(plugin.orchestrator.runCount).toBe(1);

    // the dream replays history without executing a single extra probe
    const probesBeforeDream = runner.calls.length;
    expect(probesBeforeDream).toBeGreaterThanOrEqual(2);

    const trace = plugin.orchestrator.lastTrace();
    expect(trace).toContain('offline_dream');
    expect(trace.indexOf('offline_dream')).toBeGreaterThan(trace.indexOf('commit'));
    expect(trace.indexOf('offline_dream')).toBeGreaterThan(trace.indexOf('apply_patch'));
    expect(trace.indexOf('finalize')).toBeGreaterThan(trace.indexOf('offline_dream'));
    expect(result.diagnostics.join(' ')).toContain('offline dream');
  });

  it('respects the configured cadence across runs', async () => {
    const { plugin } = buildE2E({
      dreamEveryNTasks: 2,
      extra: { deps: { dreamMinVerifiedTrees: 0 } }
    });
    const task = plugin.makeTask({ id: 'task-dream-2', prompt: 'Fix the failing build.' });

    const first = await plugin.run({ sessionId: 'sess-cadence', task, trigger: 'always' });
    expect(first.metadata?.dreamTriggered).toBe(false);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(0);
    expect(plugin.orchestrator.lastTrace()).not.toContain('offline_dream');

    const second = await plugin.run({ sessionId: 'sess-cadence', task, trigger: 'always' });
    expect(second.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);
    expect(plugin.orchestrator.runCount).toBe(2);
    expect(plugin.orchestrator.treePool.size()).toBe(2);
  });

  it('accumulates one tree per run in the replay pool', async () => {
    const { plugin } = buildE2E({ dreamEveryNTasks: 100 });
    const task = plugin.makeTask({ id: 'task-dream-3', prompt: 'Fix the failing build.' });

    await plugin.run({ sessionId: 'sess-pool', task, trigger: 'always' });
    await plugin.run({ sessionId: 'sess-pool', task, trigger: 'always' });

    const trees = plugin.orchestrator.treePool.list();
    expect(trees).toHaveLength(2);
    expect(trees.every((tree) => tree.completed)).toBe(true);
    expect(trees.every((tree) => Object.keys(tree.nodes).length >= 2)).toBe(true);
  });

  it('skips dream under the production floor when no verified tree exists (A4-2 default 12)', async () => {
    // The production wiring passes dreamMinVerifiedTrees = 12. With no trusted
    // verifier every tree is unverified, so the cadence fires but the replay
    // must be SKIPPED with a diagnostic - never run on unverified scores.
    const { plugin } = buildE2E({ dreamEveryNTasks: 1 });
    const task = plugin.makeTask({ id: 'task-dream-gate', prompt: 'Fix the failing build.' });
    const result = await plugin.run({ sessionId: 'sess-dream-gate', task, trigger: 'always' });

    expect(result.metadata?.dreamTriggered).toBe(false);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(0);
    expect(result.diagnostics.join(' ')).toContain('offline dream skipped');
    expect(result.diagnostics.join(' ')).toContain('verified tree(s) < minimum 12');
    // The task itself still completed normally.
    expect(result.outcome).toBe('composed');
  });

  it('hands ONLY verified trees to the dreamer when the floor is positive', async () => {
    const verifiedId = 'tree-verified-fixture';
    const verifiedNode = {
      id: 'node-verified',
      treeId: verifiedId,
      parentId: null,
      depth: 1,
      branchId: 'b-verified',
      patchId: 'p-verified',
      patchOrigin: 'domain',
      purpose: 'explore',
      guidance: 'memory',
      status: 'succeeded',
      score: 0.9,
      childIds: [],
      createdAt: 1,
      updatedAt: 2,
      metadata: {
        dreamEvidence: {
          verdict: 'passed',
          trusted: true,
          dreamScore: 0.9,
          strategy: 'verified-only-selection',
          verifierId: 'offline-dream-test-host',
          evidenceHash: 'sha256:' + 'a'.repeat(64)
        }
      }
    } as const;
    const verifiedTree = {
      id: verifiedId,
      sessionId: 's',
      taskId: 't-verified',
      rootId: 'node-verified',
      nodes: { 'node-verified': verifiedNode },
      stats: { nodeCount: 1, maxDepth: 1, maxWidth: 1, scoredNodes: 1, completedNodes: 1 },
      completed: true,
      createdAt: 1,
      updatedAt: 2
    } as unknown as import('../../src/types/contracts').DiscoveryTreeSnapshot;

    const replayed: string[][] = [];
    const dreamer = {
      async replay(request: { readonly trees: readonly { readonly id: string }[] }) {
        replayed.push(request.trees.map((tree) => tree.id));
        const empty = {
          policyId: 'pi-0',
          hypervolume: 0,
          meanQuality: 0,
          meanCost: 0,
          perRho: {},
          treesEvaluated: 0
        };
        return {
          ranAt: 0,
          baseline: empty,
          candidateEvaluations: [],
          best: empty,
          improved: false,
          selectedPolicyId: 'pi-0',
          replayedTreeIds: request.trees.map((tree) => tree.id),
          rhoPreferences: [0],
          publication: { publish: false, reason: 'fixture' },
          shadow: {
            suggestedPolicyId: 'pi-0',
            incumbentPolicyId: 'pi-0',
            published: false,
            comparisons: [],
            selectionTreeIds: request.trees.map((tree) => tree.id),
            holdoutTreeIds: [],
            split: { status: 'none', hasSufficientEvidence: false, diagnostics: [] },
            boundary: 'fixture'
          },
          ignoredDimensions: []
        } as never;
      }
    };
    const treePool = createDiscoveryTreePool();
    treePool.add(verifiedTree);
    const { plugin } = buildE2E({
      dreamEveryNTasks: 1,
      extra: {
        deps: {
          treePool,
          dreamer,
          // One verified snapshot is present, so the floor is satisfiable; the
          // run's own unverified tree must NOT be handed to replay.
          dreamMinVerifiedTrees: 1
        }
      }
    });
    const result = await plugin.run({
      sessionId: 'sess-dream-verified-only',
      task: plugin.makeTask({ id: 'task-dream-v', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.metadata?.dreamTriggered).toBe(true);
    expect(replayed).toEqual([[verifiedId]]);
  });

  it('drives dreaming through the dreamer policy generator instead of shadowing it', async () => {
    const server = mem0LikeServer();
    const config = parseEvoHarnessConfig(
      e2eConfig({ dreamEveryNTasks: 1, config: { dreamRsi: { candidatePoliciesCount: 2 } } })
    );
    expect(config.dreamRsi.candidatePoliciesCount).toBe(2);
    const now = makeClock();
    const treePool = createDiscoveryTreePool({ maxTrees: 4 });
    const generatorCalls: number[] = [];
    const dreamer = createOfflineDreamer({
      now,
      treePool,
      policyCount: config.dreamRsi.candidatePoliciesCount,
      generatePolicies: (baseline, count) => {
        generatorCalls.push(count);
        return Array.from({ length: count }, (_unused, index) => ({
          ...baseline,
          id: 'gen-' + String(index + 1),
          version: baseline.version + 1,
          parentPolicyId: baseline.id,
          createdAt: baseline.createdAt + index
        }));
      }
    });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('gen-dream'),
        deps: { dreamer, treePool, dreamMinVerifiedTrees: 0 }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-gen',
      task: plugin.makeTask({ id: 'task-gen', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.metadata?.dreamTriggered).toBe(true);
    // the orchestrator must not inject its own deterministic candidate list
    expect(generatorCalls).toEqual([2]);
    const report = plugin.orchestrator.dreamReports()[0];
    expect(report?.candidateEvaluations.map((evaluation) => evaluation.policyId).sort()).toEqual([
      'gen-1',
      'gen-2'
    ]);
  });
});
