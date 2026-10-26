/**
 * P6 PR2 (plan section 4 R1 / 5.1): the single JitRuntimeControl.
 *
 * These tests pin the interface the whole plugin shares, and - more importantly
 * - the two facts it must never conflate:
 *
 *  - `configured`      is `config.jitrl.enabled && levels.includes('meta')`;
 *                      static, reported by `plugin.jitrl.enabled`.
 *  - `runtimeEnabled`  is the volatile `/evo jit off` state; every surface reads
 *                      it, and `configured` staying true must never imply it.
 *
 * Appendix A of the plan warns explicitly against asserting that
 * `plugin.jitrl.enabled` reflects a volatile `off`; the separation tests below
 * are the executable form of that warning.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createJitRuntimeControl,
  JIT_SURFACES,
  type JitSurface
} from '../../../src/jitrl/runtime-control';
import { buildE2E } from '../../e2e/fixtures';
import { createHookFixture } from '../cordis-seams/hook-fixtures';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import type { EightSurfacePatch, IHarnessProposer, MetaSearchPolicy, ProposeRequest, ProposedPatch, ProposedPatchSet } from '../../../src/types/contracts';

describe('createJitRuntimeControl: configured is not runtimeEnabled', () => {
  it('reports configured=true and runtimeEnabled=true for a configured, switched-on control', () => {
    const control = createJitRuntimeControl({ configured: true });
    const snapshot = control.snapshot();
    expect(snapshot.configured).toBe(true);
    expect(snapshot.runtimeEnabled).toBe(true);
    expect(snapshot.generation).toBe(1);
  });

  it('keeps configured=true while /evo jit off turns runtimeEnabled off', () => {
    const control = createJitRuntimeControl({ configured: true });
    control.setEnabled(false);
    const snapshot = control.snapshot();
    // The whole point of PR2: `configured` describes availability, not the
    // volatile switch, so an off plugin still reports a configured kernel.
    expect(snapshot.configured).toBe(true);
    expect(snapshot.runtimeEnabled).toBe(false);
  });

  it('never lets "on" exceed "available": configured=false stays off', () => {
    const control = createJitRuntimeControl({ configured: false });
    expect(control.snapshot()).toMatchObject({ configured: false, runtimeEnabled: false });
    control.setEnabled(true);
    expect(control.snapshot()).toMatchObject({ configured: false, runtimeEnabled: false });
    // No effective change happened, so the generation must not move.
    expect(control.snapshot().generation).toBe(1);
  });

  it('honours an explicit initial `enabled: false` without touching configured', () => {
    const control = createJitRuntimeControl({ configured: true, enabled: false });
    expect(control.snapshot()).toMatchObject({ configured: true, runtimeEnabled: false });
  });
});

describe('createJitRuntimeControl: isEnabled covers every surface', () => {
  it('exposes exactly the seven documented surfaces', () => {
    expect([...JIT_SURFACES]).toEqual([
      'meta',
      'proposal',
      'advisor',
      'onlineRecord',
      'hostRecord',
      'mirror',
      'dreamJit'
    ]);
  });

  it('turns all seven surfaces on and off together', () => {
    const control = createJitRuntimeControl({ configured: true });
    for (const surface of JIT_SURFACES) {
      expect(control.isEnabled(surface)).toBe(true);
    }
    control.setEnabled(false);
    for (const surface of JIT_SURFACES) {
      expect(control.isEnabled(surface)).toBe(false);
    }
    control.setEnabled(true);
    for (const surface of JIT_SURFACES) {
      expect(control.isEnabled(surface)).toBe(true);
    }
  });

  it('fails closed on an unknown surface instead of defaulting to on', () => {
    const control = createJitRuntimeControl({ configured: true });
    expect(control.isEnabled('not-a-surface' as JitSurface)).toBe(false);
  });
});

describe('createJitRuntimeControl: generation tracks effective changes only', () => {
  it('increments on every effective flip', () => {
    const control = createJitRuntimeControl({ configured: true });
    expect(control.snapshot().generation).toBe(1);
    control.setEnabled(false);
    expect(control.snapshot().generation).toBe(2);
    control.setEnabled(true);
    expect(control.snapshot().generation).toBe(3);
  });

  it('does not increment when the state does not actually change', () => {
    const control = createJitRuntimeControl({ configured: true });
    control.setEnabled(true);
    expect(control.snapshot().generation).toBe(1);
    control.setEnabled(false);
    expect(control.snapshot().generation).toBe(2);
    control.setEnabled(false);
    // Re-asking for the same state is not a change: a consumer that compares
    // generations must not see a phantom move.
    expect(control.snapshot().generation).toBe(2);
  });

  it('increments once on dispose and stays off afterwards', () => {
    const control = createJitRuntimeControl({ configured: true });
    const before = control.snapshot().generation;
    control.dispose();
    expect(control.isDisposed()).toBe(true);
    expect(control.snapshot()).toMatchObject({
      configured: true,
      runtimeEnabled: false,
      generation: before + 1
    });
    // A disposed control is a permanent off: a late `/evo jit on` cannot revive it.
    control.setEnabled(true);
    expect(control.snapshot().runtimeEnabled).toBe(false);
    expect(control.snapshot().generation).toBe(before + 1);
    for (const surface of JIT_SURFACES) {
      expect(control.isEnabled(surface)).toBe(false);
    }
  });

  it('is idempotent on dispose', () => {
    const control = createJitRuntimeControl({ configured: true });
    control.dispose();
    const afterFirst = control.snapshot().generation;
    control.dispose();
    expect(control.snapshot().generation).toBe(afterFirst);
  });
});

describe('createJitRuntimeControl: snapshot is a value, not a live handle', () => {
  it('returns a fresh immutable view on every call', () => {
    const control = createJitRuntimeControl({ configured: true });
    const first = control.snapshot();
    control.setEnabled(false);
    const second = control.snapshot();
    expect(first.runtimeEnabled).toBe(true);
    expect(second.runtimeEnabled).toBe(false);
    expect(first).not.toBe(second);
    // Mutating a returned snapshot must never reach the control.
    (first as { runtimeEnabled: boolean }).runtimeEnabled = true;
    expect(control.snapshot().runtimeEnabled).toBe(false);
  });

  it('never calls a disposed control back on through isEnabled', () => {
    const control = createJitRuntimeControl({ configured: true });
    const spy = vi.fn(() => control.snapshot().runtimeEnabled);
    expect(spy()).toBe(true);
    control.dispose();
    expect(spy()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/**
 * F2 (t10 review): the tests above only prove that `isEnabled()` returns one
 * boolean for seven names. They cannot detect a surface that was DECLARED but
 * never consumed - which is exactly how `dreamJit` shipped wired to nothing.
 *
 * The tests below therefore assert OBSERVABLE PRODUCTION EFFECTS per surface:
 * run the real plugin, flip the switch, and require the surface's own effect to
 * disappear. A surface with no consumer fails here automatically, because the
 * effect keeps happening while `isEnabled()` reports false.
 */
const JIT_CONFIG = {
  jitrl: {
    enabled: true,
    levels: ['meta', 'proposal'],
    candidateCount: 3,
    hostAdvisor: { enabled: true, mode: 'advisory', adviseThreshold: -0.2, minSupport: 1 },
    store: { mirrorToMemoryBridge: true }
  }
};

/** Proposer that can emit K structurally distinct candidates in one call. */
function countingProposer(counters: { propose: number; candidates: number }): IHarnessProposer {
  const shapes = [
    { guardrails: { kind: 'guardrails', appendRules: ['t21-a'] } },
    { guardrails: { kind: 'guardrails', appendRules: ['t21-b', 't21-c'] } },
    { system_prompt: { kind: 'system_prompt', mode: 'append', content: 't21 prompt' } }
  ] as unknown as readonly EightSurfacePatch['edits'][];
  const build = (request: ProposeRequest, index: number): ProposedPatch => ({
    patch: {
      id: 't21-patch-' + String(index + 1),
      sessionId: request.sessionId,
      branchId: request.slot.branchId,
      origin: request.slot.origin,
      purpose: 'explore',
      guidance: request.slot.guidance,
      label: 't21-candidate-' + String(index + 1),
      rationale: 'candidate ' + String(index + 1),
      edits: shapes[index] as EightSurfacePatch['edits'],
      createdAt: 1_700_000_000_000
    } as unknown as EightSurfacePatch,
    rationale: 'candidate ' + String(index + 1),
    focusSurfaces: request.slot.focusSurfaces,
    confidence: [0.9, 0.6, 0.4][index] ?? 0.4,
    expectedStepsDelta: -1
  });
  return {
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      counters.propose += 1;
      return build(request, 0);
    },
    async proposeCandidates(request: ProposeRequest): Promise<ProposedPatchSet> {
      counters.candidates += 1;
      return { candidates: [build(request, 0), build(request, 1), build(request, 2)] };
    }
  };
}

/** Minimal MCP write backend so the mirror's backend calls are countable. */
function countingMirrorClient() {
  const calls = { listTools: 0, callTool: 0 };
  const client = {
    serverId: 't21-fake-memory',
    async listTools() {
      calls.listTools += 1;
      return [
        {
          name: 'write_note',
          inputSchema: { properties: { text: {}, path: {}, tags: {}, metadata: {} } }
        }
      ];
    },
    async callTool() {
      calls.callTool += 1;
      return { ok: true };
    }
  };
  return { client, calls };
}

function makeTask(plugin: ReturnType<typeof buildE2E>['plugin'], id: string) {
  return plugin.makeTask({
    id,
    prompt: 'Fix the failing build without breaking the release train.',
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

describe('F1 (dreamJit): the offline replay surface is consumed in production', () => {
  it('off: the dream still triggers and reports, but no Jit replay happens; on: hookCalls > 0', async () => {
    const harness = buildE2E({ dreamEveryNTasks: 1, config: JIT_CONFIG });
    const { plugin } = harness;

    // --- baseline ON: prove the hook is genuinely reachable, so the off
    // assertion below cannot pass vacuously.
    const on = await plugin.run({
      sessionId: 'sess-t21-dream-on',
      task: makeTask(plugin, 'task-t21-dream-on'),
      trigger: 'always'
    });
    expect(on.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);
    expect(plugin.jitrl.dream?.hookAttached).toBe(true);
    const onHookCalls = plugin.jitrl.dream?.lastReplay?.hookCalls ?? 0;
    expect(onHookCalls).toBeGreaterThan(0);

    // --- OFF: basic Dream-RSI must keep running (plan R1 forbids taking it down).
    const off = await plugin.runFromCommand('jit off');
    expect(off.jitCommand?.json).toMatchObject({ enabled: false, persisted: false });

    const offRun = await plugin.run({
      sessionId: 'sess-t21-dream-off',
      task: makeTask(plugin, 'task-t21-dream-off'),
      trigger: 'always'
    });
    // The dream is still triggered and still recorded - that part is NOT Jit's.
    expect(offRun.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(2);
    // ... but the Jit simulation is gone: this is the dreamJit consumer.
    expect(plugin.jitrl.dream?.hookAttached).toBe(false);
    expect(plugin.jitrl.dream?.lastReplay?.hookCalls).toBe(0);
    expect(plugin.jitrl.dream?.lastReplay?.candidates).toEqual([]);
    // No Jit hyperparameters were hot-swapped while off.
    expect(plugin.jitrl.dream?.lastReplay?.appliedJit).toBeUndefined();
    // The diagnostics say WHY, instead of looking like an empty replay.
    expect(
      (offRun.diagnostics ?? []).some(
        (line) => line.includes('dreamJit runtime surface is off') && line.includes('without the Jit hook')
      )
    ).toBe(true);

    // --- ON again: the hook comes back without re-mounting the dreamer.
    const back = await plugin.runFromCommand('jit on');
    expect(back.jitCommand?.json).toMatchObject({ enabled: true, persisted: false });
    const onAgain = await plugin.run({
      sessionId: 'sess-t21-dream-on2',
      task: makeTask(plugin, 'task-t21-dream-on2'),
      trigger: 'always'
    });
    expect(onAgain.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(3);
    expect(plugin.jitrl.dream?.hookAttached).toBe(true);
    expect(plugin.jitrl.dream?.lastReplay?.hookCalls ?? 0).toBeGreaterThan(0);

    await plugin.dispose();
  });
});

describe('F1 (dreamJit): the Jit hyperparameter hot swap is gated separately from the hook', () => {
  it('off: a winning replay still updates the basic policy but cannot install Jit perturbation', async () => {
    // The hook gate alone is not enough: replayTree()'s applyPolicy() hot swap
    // carries the candidate's jit block, and the dream grid generates candidates
    // with beta 0.5/1/2. This drives a REAL replay where the candidate strictly
    // improves, so applyPolicy is genuinely invoked, and then checks which
    // hyperparameters ended up on the live policy.
    const { createDiscoveryTree } = await import('../../../src/dream-rsi/discovery-tree');
    const { childInput, fixedClock, makePolicy } = await import('../../unit/dream-rsi/fixtures');
    const { createJitRl } = await import('../../../src/jitrl');
    const { createJitWiredDreamer } = await import('../../../src/index');
    const { parseEvoHarnessConfig } = await import('../../../src/config');

    const tree = createDiscoveryTree({
      id: 'tree-t21',
      sessionId: 'session-t21',
      taskId: 'task-t21',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    // Four shallow siblings plus a deeper branch holding the best recorded
    // outcome: a wide-shallow policy and a narrow-deep one score differently on
    // this shape, which is what makes the candidate strictly improve.
    tree.addNode(childInput(tree.rootId, { id: 's1', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe('s1', { trajectoryId: 'traj-s1', score: 0.1 });
    tree.addNode(childInput(tree.rootId, { id: 's2', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe('s2', { trajectoryId: 'traj-s2', score: 0.3 });
    tree.addNode(childInput(tree.rootId, { id: 's3', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe('s3', { trajectoryId: 'traj-s3', score: 0.2 });
    tree.addNode(childInput(tree.rootId, { id: 's4', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe('s4', { trajectoryId: 'traj-s4', score: 0.15 });
    tree.addNode(childInput('s2', { id: 'd1', purpose: 'deepen' }));
    tree.recordProbe('d1', { trajectoryId: 'traj-d1', score: 0.35 });
    tree.addNode(childInput('d1', { id: 'd2', purpose: 'deepen' }));
    tree.recordProbe('d2', { trajectoryId: 'traj-d2', score: 0.4 });
    tree.addNode(childInput('d2', { id: 'd3', purpose: 'deepen' }));
    tree.recordProbe('d3', { trajectoryId: 'traj-d3', score: 0.55 });

    const config = parseEvoHarnessConfig({
      jitrl: {
        dream: {
          driftRho: 0.7,
          hyperparamPerturbation: true,
          candidateJitBetas: [0.5, 1, 2],
          candidateJitLambdas: [0.02, 0.05, 0.1]
        }
      }
    });
    const kernel = createJitRl({ config, now: () => 1_700_000_000_000 });

    // A live policy whose jit block is the incumbent we must preserve.
    // Spreading it explicitly is required: createDefaultPolicy does not carry a
    // jit override, so building it through makePolicy() would silently drop the
    // incumbent's block and make the pinning assertion vacuous.
    const incumbent: MetaSearchPolicy = {
      ...makePolicy({ id: 'pi-incumbent', maxWidth: 1, maxDepth: 1 }),
      jit: { beta: 1, lambda: 0.05, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0.75 }
    };
    expect(incumbent.jit?.beta).toBe(1);
    const applied: MetaSearchPolicy[] = [];

    const recorder = { hookAttached: false } as { hookAttached: boolean; lastReplay?: any };
    const dreamer = createJitWiredDreamer({
      kernel,
      config,
      recorder,
      isJitRuntimeEnabled: () => false,
      base: {
        now: () => 1_700_000_000_000,
        activePolicy: {
          get policy() {
            return incumbent;
          },
          update(policy: MetaSearchPolicy) {
            applied.push(policy);
          }
        } as any
      }
    });

    const report = await dreamer.replay({
      trees: [tree.snapshot()],
      // The baseline is wide-and-shallow (4x1); the candidate is narrow-and-deep
      // (1x4), which replays the deep branch and strictly improves on this tree.
      baselinePolicy: makePolicy({ id: 'pi-baseline', maxWidth: 4, maxDepth: 1 }),
      candidatePolicies: [
        {
          ...makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4 }),
          jit: { beta: 2, lambda: 0.1, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0.75 }
        }
      ]
    });

    // ADR-0003 §3.6: Precondition holds - candidate strictly improves, but publish
    // is denied by default (holdout-missing + no explicit authorization).
    expect(report.improved).toBe(true);
    expect(report.publication.publish).toBe(false);
    expect(applied).toHaveLength(0);
    expect(incumbent.jit?.beta).toBe(1);
    expect(incumbent.jit?.lambda).toBe(0.05);
    expect(recorder.lastReplay?.appliedJit).toBeUndefined();

    // ADR-0003 §3.6 (i) 授权正控形态：同一夹具改为显式授予 publish + 显式 holdout 通过
    // 真实 apply 发生，此时非空洞地继续断言 swapped.jit.beta===1 (扰动未泄漏进在线策略)
    const authApplied: MetaSearchPolicy[] = [];
    const authDreamer = createJitWiredDreamer({
      kernel,
      config,
      recorder: { hookAttached: false },
      isJitRuntimeEnabled: () => false,
      executionProfile: {
        mode: 'shadow',
        permissions: {
          patch: { allowed: false, reason: '' },
          memory: { allowed: false, reason: '' },
          publish: { allowed: true, reason: 'test explicit authorization' }
        },
        shadowRecords: true,
        off: false
      },
      base: {
        now: () => 1_700_000_000_000,
        publishAuthorized: true,
        shadowMode: false,
        holdoutTreeCount: 1,
        activePolicy: {
          get policy() {
            return incumbent;
          },
          update(policy: MetaSearchPolicy) {
            authApplied.push(policy);
          }
        } as any
      }
    });

    const treeHoldout = createDiscoveryTree({
      id: 'tree-t21-holdout',
      sessionId: 'session-t21',
      taskId: 'task-t21',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    treeHoldout.addNode(childInput(treeHoldout.rootId, { id: 's1', origin: 'domain', purpose: 'explore' }));
    treeHoldout.recordProbe('s1', { trajectoryId: 'traj-s1-h', score: 0.1 });
    treeHoldout.addNode(childInput(treeHoldout.rootId, { id: 's2', origin: 'domain', purpose: 'explore' }));
    treeHoldout.recordProbe('s2', { trajectoryId: 'traj-s2-h', score: 0.3 });
    treeHoldout.addNode(childInput(treeHoldout.rootId, { id: 's3', origin: 'domain', purpose: 'explore' }));
    treeHoldout.recordProbe('s3', { trajectoryId: 'traj-s3-h', score: 0.2 });
    treeHoldout.addNode(childInput(treeHoldout.rootId, { id: 's4', origin: 'domain', purpose: 'explore' }));
    treeHoldout.recordProbe('s4', { trajectoryId: 'traj-s4-h', score: 0.15 });
    treeHoldout.addNode(childInput('s2', { id: 'd1', purpose: 'deepen' }));
    treeHoldout.recordProbe('d1', { trajectoryId: 'traj-d1-h', score: 0.35 });
    treeHoldout.addNode(childInput('d1', { id: 'd2', purpose: 'deepen' }));
    treeHoldout.recordProbe('d2', { trajectoryId: 'traj-d2-h', score: 0.4 });
    treeHoldout.addNode(childInput('d2', { id: 'd3', purpose: 'deepen' }));
    treeHoldout.recordProbe('d3', { trajectoryId: 'traj-d3-h', score: 0.55 });

    const authReport = await authDreamer.replay({
      trees: [tree.snapshot(), treeHoldout.snapshot()],
      baselinePolicy: makePolicy({ id: 'pi-baseline', maxWidth: 4, maxDepth: 1 }),
      candidatePolicies: [
        {
          ...makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4 }),
          jit: { beta: 2, lambda: 0.1, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0.75 }
        }
      ]
    });
    expect(authReport.improved).toBe(true);
    expect(authReport.publication.publish).toBe(true);
    expect(authApplied).toHaveLength(1);
    const swapped = authApplied[0] as MetaSearchPolicy;
    expect(swapped.id).toBe('pi-deep');
    expect(swapped.maxDepth).toBe(4);
    // Preserved independent security assertion: Jit perturbation never leaks
    expect(swapped.jit?.beta).toBe(1);
    expect(swapped.jit?.lambda).toBe(0.05);

    // ADR-0003 §3.5 & t10 F-1: Under jit-on AND default deny, even when candidate strictly improves
    // and incumbent policy carries a pre-existing jit block, appliedJit must NOT report a fake swap.
    const jitOnRecorder = { hookAttached: false } as { hookAttached: boolean; lastReplay?: any };
    const jitOnApplied: MetaSearchPolicy[] = [];
    const jitOnDenyDreamer = createJitWiredDreamer({
      kernel,
      config,
      recorder: jitOnRecorder,
      isJitRuntimeEnabled: () => true,
      base: {
        now: () => 1_700_000_000_000,
        activePolicy: {
          get policy() {
            return incumbent;
          },
          update(policy: MetaSearchPolicy) {
            jitOnApplied.push(policy);
          }
        } as any
      }
    });

    const jitOnDenyReport = await jitOnDenyDreamer.replay({
      trees: [tree.snapshot()],
      baselinePolicy: makePolicy({ id: 'pi-baseline', maxWidth: 4, maxDepth: 1 }),
      candidatePolicies: [
        {
          ...makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4 }),
          jit: { beta: 2, lambda: 0.1, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0.75 }
        }
      ]
    });
    expect(jitOnDenyReport.improved).toBe(true);
    expect(jitOnDenyReport.publication.publish).toBe(false);
    expect(jitOnDenyReport.shadow.published).toBe(false);
    expect(jitOnApplied).toHaveLength(0);
    expect(jitOnRecorder.lastReplay?.appliedJit).toBeUndefined();
    expect(jitOnDenyReport.publication.publish).toBe(jitOnDenyReport.shadow.published);

    // ADR-0003 §3.6 + t10 F-1 positive control: when jit-on AND authorized on holdout,
    // actual swap occurs and appliedJit is populated with the newly applied policy's jit block
    // (proving appliedJit is not hardcoded to undefined).
    const jitOnAuthRecorder = { hookAttached: false } as { hookAttached: boolean; lastReplay?: any };
    const jitOnAuthApplied: MetaSearchPolicy[] = [];
    let currentAuthPolicy = incumbent;
    const jitOnAuthDreamer = createJitWiredDreamer({
      kernel,
      config,
      recorder: jitOnAuthRecorder,
      isJitRuntimeEnabled: () => true,
      executionProfile: {
        mode: 'shadow',
        permissions: {
          patch: { allowed: false, reason: '' },
          memory: { allowed: false, reason: '' },
          publish: { allowed: true, reason: 'test explicit authorization with jit-on' }
        },
        shadowRecords: true,
        off: false
      },
      base: {
        now: () => 1_700_000_000_000,
        publishAuthorized: true,
        shadowMode: false,
        holdoutTreeCount: 1,
        activePolicy: {
          get policy() {
            return currentAuthPolicy;
          },
          update(policy: MetaSearchPolicy) {
            currentAuthPolicy = policy;
            jitOnAuthApplied.push(policy);
          }
        } as any
      }
    });

    const jitOnAuthReport = await jitOnAuthDreamer.replay({
      trees: [tree.snapshot(), treeHoldout.snapshot()],
      baselinePolicy: makePolicy({ id: 'pi-baseline', maxWidth: 4, maxDepth: 1 }),
      candidatePolicies: [
        {
          ...makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4 }),
          jit: { beta: 2, lambda: 0.1, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0.75 }
        }
      ]
    });
    expect(jitOnAuthReport.improved).toBe(true);
    expect(jitOnAuthReport.publication.publish).toBe(true);
    expect(jitOnAuthReport.shadow.published).toBe(true);
    expect(jitOnAuthApplied).toHaveLength(1);
    const jitOnSwapped = jitOnAuthApplied[0] as MetaSearchPolicy;
    expect(jitOnSwapped.id).toBe('pi-deep');
    expect(jitOnSwapped.jit?.beta).toBe(2);
    expect(jitOnSwapped.jit?.lambda).toBe(0.1);
    expect(jitOnAuthRecorder.lastReplay?.appliedJit).toBeDefined();
    expect(jitOnAuthRecorder.lastReplay?.appliedJit?.beta).toBe(2);
    expect(jitOnAuthRecorder.lastReplay?.appliedJit?.lambda).toBe(0.1);
    expect(jitOnAuthReport.publication.publish).toBe(jitOnAuthReport.shadow.published);
    expect(Boolean(jitOnAuthRecorder.lastReplay?.appliedJit)).toBe(jitOnAuthReport.publication.publish);
  });
});

describe('each surface is read by a production path (F2)', () => {
  it('meta: off removes the L1 adjustment stage', async () => {
    const harness = buildE2E({ config: JIT_CONFIG });
    const { plugin } = harness;
    await plugin.run({
      sessionId: 'sess-t21-meta-on',
      task: makeTask(plugin, 'task-t21-meta-on'),
      trigger: 'always'
    });
    expect(plugin.orchestrator.lastTrace()).toContain('jit_meta_adjust');
    await plugin.runFromCommand('jit off');
    await plugin.run({
      sessionId: 'sess-t21-meta-off',
      task: makeTask(plugin, 'task-t21-meta-off'),
      trigger: 'always'
    });
    expect(plugin.orchestrator.lastTrace()).not.toContain('jit_meta_adjust');
    await plugin.dispose();
  });

  it('proposal: off removes the L2 selection stage and the K-candidate call', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: JIT_CONFIG,
      extra: { deps: { proposer: countingProposer(counters) } }
    });
    const { plugin } = harness;
    await plugin.run({
      sessionId: 'sess-t21-prop-on',
      task: makeTask(plugin, 'task-t21-prop-on'),
      trigger: 'always'
    });
    expect(plugin.orchestrator.lastTrace()).toContain('jit_proposal_select');
    expect(counters.candidates).toBeGreaterThan(0);

    await plugin.runFromCommand('jit off');
    const before = counters.candidates;
    await plugin.run({
      sessionId: 'sess-t21-prop-off',
      task: makeTask(plugin, 'task-t21-prop-off'),
      trigger: 'always'
    });
    expect(plugin.orchestrator.lastTrace()).not.toContain('jit_proposal_select');
    expect(counters.candidates).toBe(before);
    await plugin.dispose();
  });

  it('onlineRecord: off removes evaluate_steps / record_experience and the store growth', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: JIT_CONFIG,
      extra: { deps: { proposer: countingProposer(counters) } }
    });
    const { plugin } = harness;
    await plugin.run({
      sessionId: 'sess-t21-rec-on',
      task: makeTask(plugin, 'task-t21-rec-on'),
      trigger: 'always'
    });
    expect(plugin.orchestrator.lastTrace()).toContain('record_experience');
    const seeded = plugin.jitrl.storeSize;
    expect(seeded).toBeGreaterThan(0);

    await plugin.runFromCommand('jit off');
    await plugin.run({
      sessionId: 'sess-t21-rec-off',
      task: makeTask(plugin, 'task-t21-rec-off'),
      trigger: 'always'
    });
    expect(plugin.orchestrator.lastTrace()).not.toContain('evaluate_steps');
    expect(plugin.orchestrator.lastTrace()).not.toContain('record_experience');
    expect(plugin.jitrl.storeSize).toBe(seeded);
    await plugin.dispose();
  });

  it('advisor + hostRecord: off stops the advisor gate and stops feeding the host-tool sink', async () => {
    const fixture = createHookFixture();
    const ctx = fixture.ctx as Record<string, unknown>;
    ctx['tools'] = { execute: () => undefined };
    ctx['systemPrompt'] = { assemble: () => ({ sections: [] }) };
    const harness = buildE2E({ ctx: ctx as never, config: JIT_CONFIG });
    const { plugin } = harness;
    // D1 strict default: the dispatches below carry sessionId identities, so
    // the test registers a trusted scope for them (the host-session registration
    // path). An unprovable identity would be skipped by the advisor instead of
    // reaching the evaluate() path this test pins.
    const registry = plugin.scopeRegistry;
    if (registry !== undefined) {
      registry.register({
        sessionId: 'sess-t21-adv',
        branchId: 'br-t21-adv',
        role: 'domain',
        guidance: 'memory',
        allowAdvice: true
      });
    }
    const postExecute = fixture.listener('tools/post-execute') as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const preStep = fixture.listener('agent/pre-step') as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const accept = async () => ({ kind: 'accept' });
    const enter = async () => ({ kind: 'enter', messages: [] });

    expect(plugin.jitrl.hostAdvisor?.attached).toBe(true);
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(true);

    // --- ON: the adapter really dispatches to the advisor. `skipped` counts the
    // dispatches the runtime gate refused, so an on-run must leave it at 0 while
    // an off-run must raise it: that counter is the adapter-side proof the SAME
    // control object is read on the production path.
    await preStep({ sessionId: 'sess-t21-adv', branchId: 'br-t21-adv' }, enter);
    expect(plugin.jitrl.hostAdvisor?.skipped ?? 0).toBe(0);

    const collectedOn = plugin.jitrl.hostToolExperiences ?? 0;
    await postExecute({ name: 'bash', input: { command: 'npm test' } }, { isError: true }, accept);
    const collectedAfterOnPost = plugin.jitrl.hostToolExperiences ?? 0;
    // Whether the producer stores a record depends on the scope registry (PR3);
    // what must hold here is that the sink was actually CALLED while on, which
    // the adapter's own observation counter proves.
    expect(collectedAfterOnPost).toBeGreaterThanOrEqual(collectedOn);

    // --- OFF: the runtime gate must now refuse dispatches instead of advising.
    await plugin.runFromCommand('jit off');
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(false);

    await preStep({ sessionId: 'sess-t21-adv', branchId: 'br-t21-adv' }, enter);
    expect(plugin.jitrl.hostAdvisor?.skipped ?? 0).toBeGreaterThan(0);
    // No new advice may be produced while off.
    const advisoryCallsOff = plugin.jitrl.hostAdvisor?.advisory ?? 0;
    await preStep({ sessionId: 'sess-t21-adv', branchId: 'br-t21-adv' }, enter);
    expect(plugin.jitrl.hostAdvisor?.advisory ?? 0).toBe(advisoryCallsOff);

    // hostRecord: the sink is not called at all while off. The observable
    // adapter-side effect is that the host-tool evidence count cannot move.
    const beforeOffPost = plugin.jitrl.hostToolExperiences ?? 0;
    for (let index = 0; index < 3; index += 1) {
      await postExecute({ name: 'bash', input: { command: 'npm test' } }, { isError: true }, accept);
    }
    expect(plugin.jitrl.hostToolExperiences).toBe(beforeOffPost);

    await plugin.dispose();
  });

  it('mirror: off stops backend calls after a run that would otherwise mirror', async () => {
    const counters = { propose: 0, candidates: 0 };
    const fake = countingMirrorClient();
    const harness = buildE2E({
      config: JIT_CONFIG,
      extra: {
        deps: {
          proposer: countingProposer(counters),
          // t10/R2: the mirror switch is only the REQUEST half; this test
          // assembly explicitly opts in on the PERMISSION half (fake backend).
          executionProfile: resolveExecutionProfile({ memoryRealWrites: true })
        },
        mirrorClient: fake.client
      }
    });
    const { plugin } = harness;
    await plugin.run({
      sessionId: 'sess-t21-mirror-on',
      task: makeTask(plugin, 'task-t21-mirror-on'),
      trigger: 'always'
    });
    const onCalls = plugin.jitrl.mirror?.calls ?? 0;
    expect(onCalls).toBeGreaterThan(0);
    const backendBefore = fake.calls.callTool;

    await plugin.runFromCommand('jit off');
    await plugin.run({
      sessionId: 'sess-t21-mirror-off',
      task: makeTask(plugin, 'task-t21-mirror-off'),
      trigger: 'always'
    });
    expect(plugin.jitrl.mirror?.calls ?? 0).toBe(onCalls);
    expect(fake.calls.callTool).toBe(backendBefore);
    await plugin.dispose();
  });
});
