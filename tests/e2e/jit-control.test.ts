/**
 * P6 PR2 / plan R1: `/evo jit off` must cover the WHOLE JitRL learning chain.
 *
 * Appendix A of the plan records the pre-fix witness on this exact fixture
 * (`buildE2E` + a multi-candidate proposer, candidateCount 3):
 *
 *   off command: ok=true, enabled=false
 *   L3 runtimeEnabled=false
 *   jit_meta_adjust=false        <- L1 was already covered
 *   K candidate calls=2          <- STILL CALLED
 *   jit_proposal_select=true     <- STILL PUBLISHED
 *   evaluate_steps=true          <- STILL RUN
 *   record_experience=true       <- STILL RECORDED
 *   experience store delta=4     <- STILL GREW
 *
 * The root cause was that `selectProposal()` and `recordOnlineExperience()`
 * read the static `kernel.config.enabled` instead of the volatile switch. Every
 * assertion below fails against that code (see the task's red-evidence note).
 *
 * The four regression paths required by the task are covered:
 *   1. off  -> no Jit stage, no K candidates, no experience, no mirror
 *   2. on   -> everything comes back
 *   3. off->on in one process (and generation advancing)
 *   4. off while a proposal/evaluation is in flight -> no decision published
 *   5. dispose -> permanent off, `/evo jit on` cannot revive it
 */
import { describe, expect, it } from 'vitest';

import { buildE2E, e2eConfig } from './fixtures';
import { parseEvoHarnessConfig } from '../../src/config';
import { createJitRl } from '../../src/jitrl';
import type {
  EightSurfacePatch,
  IHarnessProposer,
  ProposeRequest,
  ProposedPatch,
  ProposedPatchSet
} from '../../src/types/contracts';

/** Counters the tests assert on: the K-candidate path vs the single-call path. */
interface ProposerCounters {
  propose: number;
  candidates: number;
}

/**
 * Proposer that can answer with three structurally distinct candidates.
 *
 * normalizePatchSignature encodes edit STRUCTURE, so the shapes must differ (one
 * appended rule / two appended rules / a different surface) for the selector to
 * see three distinct action keys.
 */
function makeMultiCandidateProposer(
  counters: ProposerCounters,
  options: { readonly beforeCandidates?: () => Promise<void> } = {}
): IHarnessProposer {
  const shapes = [
    { guardrails: { kind: 'guardrails', appendRules: ['p6-rule-a'] } },
    { guardrails: { kind: 'guardrails', appendRules: ['p6-rule-b', 'p6-rule-c'] } },
    { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'p6 system prompt' } }
  ] as unknown as readonly EightSurfacePatch['edits'][];

  const build = (request: ProposeRequest, index: number): ProposedPatch => ({
    patch: {
      id: 'p6-patch-' + String(index + 1),
      sessionId: request.sessionId,
      branchId: request.slot.branchId,
      origin: request.slot.origin,
      purpose: 'explore',
      guidance: request.slot.guidance,
      label: 'p6-candidate-' + String(index + 1),
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
      // Used by the mid-flight test: flip the switch INSIDE the model call.
      await options.beforeCandidates?.();
      return {
        candidates: [build(request, 0), build(request, 1), build(request, 2)]
      };
    }
  };
}

/** Minimal MCP write backend for the mirror; counts every backend call. */
function fakeMirrorClient() {
  const calls = { listTools: 0, callTool: 0, tools: [] as string[] };
  const client = {
    serverId: 'p6-fake-memory',
    async listTools() {
      calls.listTools += 1;
      return [
        {
          name: 'write_note',
          inputSchema: { properties: { text: {}, path: {}, tags: {}, metadata: {} } }
        }
      ];
    },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.callTool += 1;
      calls.tools.push(name);
      void args;
      return { ok: true };
    }
  };
  return { client, calls };
}

const JIT_CONFIG = {
  jitrl: {
    enabled: true,
    levels: ['meta', 'proposal'],
    candidateCount: 3,
    store: { mirrorToMemoryBridge: true }
  }
};

function makeTask(plugin: ReturnType<typeof buildE2E>['plugin'], id: string) {
  return plugin.makeTask({
    id,
    prompt: 'Fix the failing build without breaking the release train.',
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

const JIT_STAGES_UNDER_TEST = [
  'jit_meta_adjust',
  'jit_proposal_select',
  'evaluate_steps',
  'record_experience'
] as const;

describe('P6 PR2: /evo jit off covers the whole JitRL learning chain', () => {
  it('stops L1/L2 decisions, scoring, recording and mirroring while evolution still completes', async () => {
    const counters: ProposerCounters = { propose: 0, candidates: 0 };
    const fake = fakeMirrorClient();
    const harness = buildE2E({
      config: JIT_CONFIG,
      extra: {
        deps: { proposer: makeMultiCandidateProposer(counters) },
        mirrorClient: fake.client
      }
    });
    const { plugin } = harness;

    // --- ON baseline: seed the store so the off assertions are not vacuous.
    const first = await plugin.run({
      sessionId: 'sess-p6-on',
      task: makeTask(plugin, 'task-p6-on'),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    const onTrace = plugin.orchestrator.lastTrace();
    for (const stage of JIT_STAGES_UNDER_TEST) {
      expect(onTrace).toContain(stage);
    }
    expect(counters.candidates).toBeGreaterThan(0);
    const seededStoreSize = plugin.jitrl.storeSize;
    expect(seededStoreSize).toBeGreaterThan(0);
    const seededMirrorCalls = plugin.jitrl.mirror?.calls ?? 0;
    expect(seededMirrorCalls).toBeGreaterThan(0);
    expect(plugin.jitrl.runtime?.configured).toBe(true);
    expect(plugin.jitrl.runtime?.runtimeEnabled).toBe(true);

    // --- OFF.
    const off = await plugin.runFromCommand('jit off');
    expect(off.jitCommand?.json).toMatchObject({ enabled: false, persisted: false });
    // configured stays true; only the volatile state moved (plan appendix A).
    expect(plugin.jitrl.runtime?.configured).toBe(true);
    expect(plugin.jitrl.runtime?.runtimeEnabled).toBe(false);
    expect(plugin.jitrl.enabled).toBe(true);
    const offGeneration = plugin.jitrl.runtime?.generation ?? 0;
    expect(offGeneration).toBeGreaterThan(1);

    const candidatesBeforeOffRun = counters.candidates;
    const callToolBeforeOffRun = fake.calls.callTool;
    const result = await plugin.run({
      sessionId: 'sess-p6-off',
      task: makeTask(plugin, 'task-p6-off'),
      trigger: 'always'
    });

    // (a) Ordinary evolution still completes with a real result: switching Jit
    // off must never take Harness² or the base Dream-RSI path down with it.
    expect(result.outcome).toBe('composed');
    expect(result.failure).toBeUndefined();
    expect(result.probesRun).toBeGreaterThan(0);
    expect(result.diagnostics.some((line) => line.includes('lifecycle failed'))).toBe(false);

    // (b) No Jit stage at all - not L1, not L2 selection, not scoring/recording.
    const trace = plugin.orchestrator.lastTrace();
    for (const stage of JIT_STAGES_UNDER_TEST) {
      expect(trace).not.toContain(stage);
    }
    expect(result.metadata?.lifecycle).toEqual([...trace]);

    // (c) The K-candidate path is gone; the single-call path still works.
    expect(counters.candidates).toBe(candidatesBeforeOffRun);
    expect(counters.propose).toBeGreaterThan(0);

    // (d) The experience store did not grow by a single record.
    expect(plugin.jitrl.storeSize).toBe(seededStoreSize);

    // (e) The mirror made no backend call after off.
    expect(plugin.jitrl.mirror?.calls ?? 0).toBe(seededMirrorCalls);
    expect(fake.calls.callTool).toBe(callToolBeforeOffRun);
    expect(plugin.jitrl.runtime?.generation).toBe(offGeneration);

    // --- ON again: every surface must come back without re-mounting.
    const on = await plugin.runFromCommand('jit on');
    expect(on.jitCommand?.json).toMatchObject({ enabled: true, persisted: false });
    expect(plugin.jitrl.runtime?.configured).toBe(true);
    expect(plugin.jitrl.runtime?.runtimeEnabled).toBe(true);
    expect(plugin.jitrl.runtime?.generation).toBeGreaterThan(offGeneration);

    const candidatesBeforeOnRun = counters.candidates;
    const storeBeforeOnRun = plugin.jitrl.storeSize;
    const mirrorBeforeOnRun = plugin.jitrl.mirror?.calls ?? 0;
    const second = await plugin.run({
      sessionId: 'sess-p6-on-again',
      task: makeTask(plugin, 'task-p6-on-again'),
      trigger: 'always'
    });
    expect(second.outcome).toBe('composed');
    const restoredTrace = plugin.orchestrator.lastTrace();
    for (const stage of JIT_STAGES_UNDER_TEST) {
      expect(restoredTrace).toContain(stage);
    }
    expect(counters.candidates).toBeGreaterThan(candidatesBeforeOnRun);
    expect(plugin.jitrl.storeSize).toBeGreaterThan(storeBeforeOnRun);
    expect(plugin.jitrl.mirror?.calls ?? 0).toBeGreaterThan(mirrorBeforeOnRun);

    await plugin.dispose();
  });

  it('reports status from the volatile switch, not from configured availability', async () => {
    const counters: ProposerCounters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: { deps: { proposer: makeMultiCandidateProposer(counters) } }
    });
    const { plugin } = harness;

    await plugin.runFromCommand('jit off');
    const status = await plugin.runFromCommand('jit status');
    expect(status.jitCommand?.text).toContain('enabled: false');
    // The plugin handle still says "configured", which is exactly why PR2 added
    // the separate volatile view.
    expect(plugin.jitrl.enabled).toBe(true);
    expect(plugin.jitrl.runtime).toMatchObject({ configured: true, runtimeEnabled: false });
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(false);

    await plugin.dispose();
  });
});

describe('P6 PR2: switching off while a Jit call is in flight', () => {
  it('discards the K candidates returned by a proposal that finished after off', async () => {
    const counters: ProposerCounters = { propose: 0, candidates: 0 };
    let pluginRef: ReturnType<typeof buildE2E>['plugin'] | undefined;
    let switched = false;

    const proposer = makeMultiCandidateProposer(counters, {
      // Reproduces "执行中关闭": the model call is already sent, the switch moves
      // while it is in flight. The call is not withdrawn, but its result must
      // not be published as a Jit decision nor recorded as experience.
      beforeCandidates: async () => {
        if (switched) {
          return;
        }
        switched = true;
        await pluginRef?.runFromCommand('jit off');
      }
    });

    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: { deps: { proposer } }
    });
    pluginRef = harness.plugin;
    const { plugin } = harness;

    const result = await plugin.run({
      sessionId: 'sess-p6-midflight',
      task: makeTask(plugin, 'task-p6-midflight'),
      trigger: 'always'
    });

    // The model call happened exactly once (it cannot be unsent) ...
    expect(counters.candidates).toBe(1);
    // ... but nothing downstream of it was published.
    const trace = plugin.orchestrator.lastTrace();
    expect(trace).not.toContain('jit_proposal_select');
    expect(trace).not.toContain('evaluate_steps');
    expect(trace).not.toContain('record_experience');
    expect(plugin.jitrl.storeSize).toBe(0);
    // The run itself still completes normally.
    expect(result.outcome).toBe('composed');
    expect(plugin.jitrl.runtime?.runtimeEnabled).toBe(false);
    expect(
      result.diagnostics.some(
        (line) =>
          line.includes('JitRL was switched while the multi-candidate proposer was in flight')
      )
    ).toBe(true);

    await plugin.dispose();
  });

  it('discards step rewards evaluated after off instead of appending them', async () => {
    const counters: ProposerCounters = { propose: 0, candidates: 0 };
    let pluginRef: ReturnType<typeof buildE2E>['plugin'] | undefined;
    let switched = false;

    // The plugin builds its own kernel, so the evaluator is reached by handing
    // the orchestrator a kernel whose stepEvaluator is wrapped: the switch is
    // flipped while a real evaluation is in flight (the "执行中关闭" path).
    const config = parseEvoHarnessConfig(e2eConfig({ config: JIT_CONFIG }));
    const kernel = createJitRl({ config, now: () => 1_700_000_000_000 });
    let evaluated = 0;
    const wrappedKernel = {
      ...kernel,
      async count(level?: 'meta' | 'proposal' | 'host_tool') {
        return kernel.count(level);
      },
      stepEvaluator: {
        async evaluate() {
          evaluated += 1;
          if (!switched) {
            switched = true;
            await pluginRef?.runFromCommand('jit off');
          }
          return [
            { stepIndex: 0, reward: 1, sources: { surrogate: 1, tool: 0 } },
            { stepIndex: 1, reward: 2, sources: { surrogate: 2, tool: 0 } }
          ];
        }
      }
    };

    const harness = buildE2E({
      config: JIT_CONFIG,
      extra: {
        deps: {
          proposer: makeMultiCandidateProposer(counters),
          jitrl: wrappedKernel
        } as never
      }
    });
    pluginRef = harness.plugin;
    const { plugin } = harness;

    await plugin.run({
      sessionId: 'sess-p6-mideval',
      task: makeTask(plugin, 'task-p6-mideval'),
      trigger: 'always'
    });

    // The evaluation really ran (it is the external effect that cannot be undone)...
    expect(evaluated).toBe(1);
    // ... but the switch moved while it was in flight, so its rewards were dropped.
    const trace = plugin.orchestrator.lastTrace();
    expect(trace).not.toContain('record_experience');
    expect(kernel.count()).toBe(0);
    expect(plugin.jitrl.runtime?.runtimeEnabled).toBe(false);

    await plugin.dispose();
  });
});

describe('P6 PR2: dispose is a permanent off', () => {
  it('turns every surface off and refuses a later /evo jit on', async () => {
    const counters: ProposerCounters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: { deps: { proposer: makeMultiCandidateProposer(counters) } }
    });
    const { plugin } = harness;

    await plugin.run({
      sessionId: 'sess-p6-dispose',
      task: makeTask(plugin, 'task-p6-dispose'),
      trigger: 'always'
    });
    const generationBeforeDispose = plugin.jitrl.runtime?.generation ?? 0;
    expect(generationBeforeDispose).toBeGreaterThan(0);

    await plugin.dispose();

    expect(plugin.jitrl.runtime).toMatchObject({
      configured: true,
      runtimeEnabled: false
    });
    expect(plugin.jitrl.runtime?.generation).toBeGreaterThan(generationBeforeDispose);
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(false);

    // A disposed control cannot be switched back on: teardown wins over a late
    // command, otherwise a stale `/evo jit on` would revive a dead plugin.
    const revived = await plugin.runFromCommand('jit on');
    expect(revived.jitCommand?.json).toMatchObject({ enabled: false });
    expect(plugin.jitrl.runtime?.runtimeEnabled).toBe(false);
  });
});
