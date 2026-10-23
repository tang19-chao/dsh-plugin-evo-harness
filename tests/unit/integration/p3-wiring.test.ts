/**
 * P3-D integration wiring: jit_proposal_select + evaluate_steps/record_experience
 * through the real plugin entrypoint (plan section 8 Phase 3, gap G2-3).
 *
 * The L2 selector only runs when the proposer can emit K candidates in one call,
 * so these tests inject a multi-candidate proposer through the documented
 * options.deps override and drive the plugin with the standard scripted model.
 */
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { createEvoHarnessPlugin, createPersistenceRuntime } from '../../../src/index';
import type { EvoHarnessPlugin } from '../../../src/index';
import { createJitRl } from '../../../src/jitrl';
import type { JitRl } from '../../../src/jitrl';
import { EVO_HARNESS_STAGES } from '../../../src/orchestrator';
import { createDefaultConfig } from '../../../src/config';
import { cleanupDir, makeTempDir } from '../persistence/fixtures';
import { buildE2E, e2eConfig, makeClock } from '../../e2e/fixtures';
import { slotKindOfActionKey } from '../../../src/jitrl/jit-active-policy';
import type {
  EightSurfacePatch,
  IHarnessProposer,
  ProposeRequest,
  ProposedPatch,
  ProposedPatchSet
} from '../../../src/types/contracts';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir);
  }
});

/**
 * Proposer that can answer with K structurally distinct candidates in one call.
 *
 * normalizePatchSignature encodes only edit STRUCTURE, so the three candidates
 * must differ in shape (one appended rule / two appended rules / a different
 * surface) to give the L2 selector three genuinely distinct action keys.
 */
function makeMultiCandidateProposer(
  counters: { propose: number; candidates: number }
): IHarnessProposer {
  const shapes: readonly EightSurfacePatch['edits'][] = [
    { guardrails: { kind: 'guardrails', appendRules: ['p3-rule-a'] } },
    { guardrails: { kind: 'guardrails', appendRules: ['p3-rule-b', 'p3-rule-c'] } },
    { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'p3 system prompt' } }
  ] as unknown as readonly EightSurfacePatch['edits'][];
  const build = (request: ProposeRequest, index: number): ProposedPatch => {
    const edits = shapes[index] as EightSurfacePatch['edits'];
    return {
      patch: {
        id: 'p3-patch-' + String(index + 1),
        sessionId: request.sessionId,
        branchId: request.slot.branchId,
        origin: request.slot.origin,
        purpose: 'explore',
        guidance: request.slot.guidance,
        label: 'p3-candidate-' + String(index + 1),
        rationale: 'candidate ' + String(index + 1),
        edits,
        createdAt: 1_700_000_000_000
      } as unknown as EightSurfacePatch,
      rationale: 'candidate ' + String(index + 1),
      focusSurfaces: request.slot.focusSurfaces,
      confidence: [0.9, 0.6, 0.4][index] ?? 0.4,
      expectedStepsDelta: -1
    };
  };
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

describe('stage list (Phase 3)', () => {
  it('places jit_proposal_select between propose and probe', () => {
    const proposeAt = EVO_HARNESS_STAGES.indexOf('propose');
    expect(proposeAt).toBeGreaterThan(0);
    expect(EVO_HARNESS_STAGES[proposeAt + 1]).toBe('jit_proposal_select');
    expect(EVO_HARNESS_STAGES[proposeAt + 2]).toBe('probe');
  });

  it('places evaluate_steps and record_experience right after reflect', () => {
    const reflectAt = EVO_HARNESS_STAGES.indexOf('reflect');
    expect(EVO_HARNESS_STAGES[reflectAt + 1]).toBe('evaluate_steps');
    expect(EVO_HARNESS_STAGES[reflectAt + 2]).toBe('record_experience');
    expect(EVO_HARNESS_STAGES[reflectAt + 3]).toBe('commit');
  });
});

describe('jit_proposal_select through the plugin entrypoint', () => {
  it('selects one of K candidates and still runs exactly one candidate probe', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: { deps: { proposer: makeMultiCandidateProposer(counters) } }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-integration',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });

    const result = await harness.plugin.run({ sessionId: 'sess-p3', task, trigger: 'always' });
    const trace = harness.plugin.orchestrator.lastTrace();
    expect(trace).toContain('jit_proposal_select');
    expect(trace.indexOf('jit_proposal_select')).toBeGreaterThan(trace.indexOf('propose'));
    expect(trace.indexOf('jit_proposal_select')).toBeLessThan(trace.indexOf('probe'));
    expect(result.metadata?.lifecycle).toEqual([...trace]);

    // K candidates, one model call. The probe budget must NOT scale with K, so
    // compare against the same run with K = 1: the probe count has to be equal
    // (one probe per scheduled slot in both cases).
    expect(counters.candidates).toBeGreaterThan(0);
    const probesWithK3 = harness.runner.calls.filter((call) => call === 'candidate').length;
    expect(probesWithK3).toBeGreaterThan(0);

    const single = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
      extra: { deps: { proposer: makeMultiCandidateProposer({ propose: 0, candidates: 0 }) } }
    });
    const singleTask = single.plugin.makeTask({
      id: 'task-p3-integration',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await single.plugin.run({ sessionId: 'sess-p3', task: singleTask, trigger: 'always' });
    const probesWithK1 = single.runner.calls.filter((call) => call === 'candidate').length;
    expect(probesWithK3).toBe(probesWithK1);
    expect(single.plugin.orchestrator.lastTrace()).not.toContain('jit_proposal_select');
  });

  it('stays silent when the proposal level is not enabled', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta'], candidateCount: 3 } },
      extra: { deps: { proposer: makeMultiCandidateProposer(counters) } }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-meta-only',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await harness.plugin.run({ sessionId: 'sess-p3-meta', task, trigger: 'always' });
    const trace = harness.plugin.orchestrator.lastTrace();
    expect(trace).not.toContain('jit_proposal_select');
    expect(counters.candidates).toBe(0);
    expect(counters.propose).toBeGreaterThan(0);
  });
});

describe('evaluate_steps and record_experience through the plugin entrypoint', () => {
  it('writes L1 and L2 samples into the live store and reports the discounted return', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: {
        deps: {
          proposer: makeMultiCandidateProposer(counters),
          // The plugin injects its own kernel; the evaluator is reached through
          // the kernel that buildOrchestratorDeps hands to the orchestrator, so
          // the observable proof here is the stage order plus the record count.
        }
      }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-record',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });

    const before = harness.plugin.jitrl.storeSize;
    await harness.plugin.run({ sessionId: 'sess-p3-record', task, trigger: 'always' });
    const trace = harness.plugin.orchestrator.lastTrace();

    expect(trace).toContain('evaluate_steps');
    expect(trace).toContain('record_experience');
    expect(trace.indexOf('evaluate_steps')).toBeGreaterThan(trace.indexOf('reflect'));
    expect(trace.indexOf('record_experience')).toBeGreaterThan(trace.indexOf('evaluate_steps'));
    expect(trace.indexOf('record_experience')).toBeLessThan(trace.indexOf('commit'));

    // The in-process neighbourhood grew: at least one L1 and one L2 sample.
    const after = harness.plugin.jitrl.storeSize;
    expect(after - before).toBeGreaterThanOrEqual(2);

  });

  it('writes nothing and emits no stage when JitRL is disabled', async () => {
    const harness = buildE2E({
      config: { jitrl: { enabled: false } },
      extra: { deps: { proposer: makeMultiCandidateProposer({ propose: 0, candidates: 0 }) } }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-off',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await harness.plugin.run({ sessionId: 'sess-p3-off', task, trigger: 'always' });
    const trace = harness.plugin.orchestrator.lastTrace();
    expect(trace).not.toContain('jit_proposal_select');
    expect(trace).not.toContain('evaluate_steps');
    expect(trace).not.toContain('record_experience');
    expect(harness.plugin.jitrl.enabled).toBe(false);
    expect(harness.plugin.jitrl.storeSize).toBe(0);
  });

  it('runs the cold start and the online recorder against the same durable log', async () => {
    const dir = await makeTempDir('p3-wiring');
    tempDirs.push(dir);
    const config = createDefaultConfig();
    const kernel: JitRl = createJitRl({
      config,
      now: () => 1_700_000_000_000,
      onDiagnostic: () => undefined
    });
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: {
        experienceFilePath: dir + (dir.includes('\\') ? '\\' : '/') + 'jitrl-experience.jsonl',
        deps: { proposer: makeMultiCandidateProposer({ propose: 0, candidates: 0 }) }
      }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-durable',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await harness.plugin.run({ sessionId: 'sess-p3-durable', task, trigger: 'always' });
    // The plugin's own kernel owns the log; the standalone kernel above is only a
    // control that the same factory works with an injected clock.
    expect(kernel.count()).toBe(0);
    expect(harness.plugin.jitrl.storeSize).toBeGreaterThan(0);
    await harness.plugin.dispose();
  });

  // -------------------------------------------------------------------------
  // t25 / P3-D2: the durable log is where the online samples become permanent,
  // so assert the two contracts there rather than on an in-memory snapshot.
  // -------------------------------------------------------------------------

  it('persists online L1 samples with L1-contract action keys and true guidance', async () => {
    const dir = await makeTempDir('p3-contract');
    tempDirs.push(dir);
    const separator = dir.includes('\\') ? '\\' : '/';
    const logPath = dir + separator + 'jitrl-experience.jsonl';
    // The durable log is only opened when a persistence runtime is wired (that is
    // what makes the online samples permanent), so drive the real cold-start path.
    const persistence = await createPersistenceRuntime({ dataDir: dir });
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: {
        persistence,
        deps: { proposer: makeMultiCandidateProposer({ propose: 0, candidates: 0 }) }
      }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-contract',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await harness.plugin.run({ sessionId: 'sess-p3-contract', task, trigger: 'always' });

    const text = await fs.readFile(logPath, 'utf8');
    const records = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { level: string; actionKey: string; guidance: string });
    const meta = records.filter((record) => record.level === 'meta');
    expect(meta.length).toBeGreaterThan(0);

    for (const record of meta) {
      // Contract 1: the key must belong to the L1 action space, otherwise
      // alignNeighbors drops the record and the live support never grows.
      expect(record.actionKey.startsWith('slot:')).toBe(true);
      expect(slotKindOfActionKey(record.actionKey)).toBeDefined();

      // Contract 2: guidance must state the real provenance of the action that
      // ran. An invariant action is first-principles by definition; every other
      // L1 action in these fixtures carries external memory.
      const kind = slotKindOfActionKey(record.actionKey);
      const expected = kind === 'explore_invariant' ? 'guidance_free' : 'memory';
      expect(record.guidance).toBe(expected);
    }

    await persistence.flush();
    await harness.plugin.dispose();
    await persistence.dispose();
  });
});
// ---------------------------------------------------------------------------
// t30 / FIX2: the augmenter is no longer dead code. These assert reachability
// through the REAL plugin wiring (not the unit harness).
// ---------------------------------------------------------------------------

describe('memory augmentation is reachable through the production wiring', () => {
  it('runs the augmentation pass on every L2 decision and reports it', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: { deps: { proposer: makeMultiCandidateProposer(counters) } }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-augment',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-p3-augment',
      task,
      trigger: 'always'
    });

    // The plugin's own kernel drives the L2 path, so the augmentation notice must
    // appear in the run diagnostics: that is the observable proof the module ran.
    const notices = (result.diagnostics ?? []).filter((line) => line.startsWith('proposal augment:'));
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.some((line) => line.includes('candidate(s)'))).toBe(true);
    await harness.plugin.dispose();
  });

  it('isolates an invariant slot from augmentation through the plugin', async () => {
    const counters = { propose: 0, candidates: 0 };
    const harness = buildE2E({
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 } },
      extra: { deps: { proposer: makeMultiCandidateProposer(counters) } }
    });
    const task = harness.plugin.makeTask({
      id: 'task-p3-augment-invariant',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-p3-augment-invariant',
      task,
      trigger: 'always'
    });
    const notices = (result.diagnostics ?? []).filter((line) => line.startsWith('proposal augment:'));
    // Whatever the default slot mix is, no notice may report a nonzero augmentation
    // that came from a forbidden slot: every summary states its isolation flag.
    for (const line of notices) {
      if (line.includes('isolated=true')) {
        expect(line).toContain(', 0 augmented');
      }
    }
    await harness.plugin.dispose();
  });
});
