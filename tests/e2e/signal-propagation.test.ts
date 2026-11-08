/**
 * A6 / H3-H4 signal propagation (rev6 audit).
 *
 * H3 — the patch must reach the probe PROMPT: every candidate probe carries the
 *      edits the proposer emitted; the edit-free reference probe carries none.
 * H4 — the prompt must change BEHAVIOUR: when the fake probe answers differently
 *      depending on the patch marker, the candidate and reference deliverables
 *      must differ. Before A1 both probes saw only a rationale line, so a
 *      marker-driven fake could not distinguish them.
 *
 * The harness is the PRODUCTION resolution path (`createEvoHarnessPlugin` with a
 * fake `ctx.llm` and no options.model / options.runBranch), so this test fails
 * if the same-process executor stops using its patch-aware default builder.
 * Every fake decodes DSH content blocks through `decodeContent` (A2).
 */
import { describe, expect, it } from 'vitest';

import { PATCH_PROMPT_PREFIX } from '../../src/dsh-bridge/patch-prompt';
import { ModelCallRegistry, resolveDshCollaborators } from '../../src/dsh-bridge';
import { createEvoHarnessPlugin } from '../../src/index';
import { createHostOwnedVerificationRunner } from '../../src/verification';
import { createLedgerReservationManager, twoPhaseSettlementFor } from '../../src/ledger';
import { parseEvoHarnessConfig } from '../../src/config';
import { createMemoryExperienceStore, type MemoryExperienceStore } from '../../src/jitrl/stores/memory.store';
import type {
  AbstractState,
  ComposeRequest,
  CompositionResult,
  ExperienceRecord,
  IHarnessComposer,
  IModelAdapter,
  IStepEvaluator,
  IsolatedBranchContext,
  JitCandidate,
  JitDecision,
  JitLevel,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult,
  ProbeTrajectory
} from '../../src/types/contracts';
import type { OrchestratorJitRl } from '../../src/orchestrator';
import {
  buildE2E,
  createFakeContext,
  createPatchAwareHostLlm,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

const MARK_SYS = 'SIGNAL_MARK_SYS_9173';
const MARK_GUARD = 'SIGNAL_MARK_GUARD_6421';

const REFERENCE_DELIVERABLE = 'reference deliverable: FAIL';
const CANDIDATE_DELIVERABLE = 'candidate deliverable: PASS ' + MARK_SYS;

/** Proposer payload that renders BOTH a system_prompt and a guardrails marker. */
function markedProposal(): Record<string, unknown> {
  return {
    rationale: 'State the failing tool and the output contract before the retry.',
    focusSurfaces: ['system_prompt', 'guardrails'],
    confidence: 0.8,
    expectedStepsDelta: -1,
    edits: {
      system_prompt: {
        kind: 'system_prompt',
        mode: 'append',
        content: 'declare the failing tool (' + MARK_SYS + ')'
      },
      guardrails: {
        kind: 'guardrails',
        formatContract: MARK_GUARD,
        appendRules: ['declare the failing tool before retrying']
      }
    }
  };
}

interface RecordingComposer extends IHarnessComposer {
  readonly requests: ComposeRequest[];
}

/**
 * Deterministic composer that records the exact trajectories it was handed.
 * Injecting it through the documented `deps` seam does not touch the model /
 * branch resolution path under test.
 */
function createRecordingComposer(): RecordingComposer {
  const requests: ComposeRequest[] = [];
  return {
    requests,
    async compose(request: ComposeRequest): Promise<CompositionResult> {
      requests.push(request);
      const first = request.candidates[0];
      const selectedNodeId = first?.nodeId ?? null;
      return {
        selectedBranchId: first?.branchId ?? null,
        selectedNodeId,
        selectedTrajectoryId: first?.trajectory.id ?? null,
        selectedPatch: first?.patch ?? null,
        composedPatch: null,
        assessments: request.candidates.map((candidate) => ({
          alias: candidate.nodeId,
          branchId: candidate.branchId,
          nodeId: candidate.nodeId,
          selected: candidate.nodeId === selectedNodeId,
          adoptionRatio: candidate.nodeId === selectedNodeId ? 1 : 0,
          contrasts: [],
          rationale: 'recorded by the signal-propagation composer'
        })),
        adoptionRatios: selectedNodeId === null ? {} : { [selectedNodeId]: 1 },
        rationale: 'recording composer',
        evaluatedAt: 1
      };
    }
  };
}

describe('A6 H3/H4: patch -> prompt -> candidate behaviour', () => {
  it('candidate probes carry the patch and deliver differently from the reference', async () => {
    const host = createPatchAwareHostLlm({
      proposals: [markedProposal()],
      probeReply: (prompt) =>
        prompt.includes(PATCH_PROMPT_PREFIX) && prompt.includes(MARK_SYS)
          ? CANDIDATE_DELIVERABLE
          : REFERENCE_DELIVERABLE
    });
    const composer = createRecordingComposer();
    const { ctx } = createFakeContext();
    const plugin = createEvoHarnessPlugin(
      { config: e2eConfig(), now: makeClock(), deps: { composer } },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;

    const result = await plugin.run({
      sessionId: 'sess-signal-propagation',
      task: plugin.makeTask({ prompt: 'Fix the failing build without breaking the release train.' }),
      trigger: 'always'
    });

    // ---- H3: every candidate prompt has the patch, the reference does not ----
    expect(result.outcome).not.toBe('no_probe');
    expect(result.probesRun).toBeGreaterThan(1);
    expect(host.probePrompts).toHaveLength(result.probesRun);
    expect(host.probeDispatches).toHaveLength(result.probesRun);

    // Branch identity is the discriminator, not "contains a marker": a partial
    // injection (one candidate loses the patch) leaves both sets non-empty and
    // would otherwise pass a content-only split.
    const referenceDispatches = host.probeDispatches.filter(
      (dispatch) => dispatch.branch?.startsWith('reference-') === true
    );
    const candidateDispatches = host.probeDispatches.filter(
      (dispatch) => dispatch.branch?.startsWith('reference-') !== true
    );
    expect(referenceDispatches).toHaveLength(1);
    expect(candidateDispatches).toHaveLength(result.probesRun - 1);
    const patched = candidateDispatches.filter((dispatch) =>
      dispatch.prompt.includes(PATCH_PROMPT_PREFIX)
    );
    expect(patched).toHaveLength(candidateDispatches.length);
    expect(patched.every((dispatch) => dispatch.prompt.includes(MARK_SYS))).toBe(true);
    expect(patched.every((dispatch) => dispatch.prompt.includes(MARK_GUARD))).toBe(true);

    // The reference patch is edit-free, so it renders no patch block at all.
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(MARK_SYS))).toBe(true);
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(MARK_GUARD))).toBe(true);
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(PATCH_PROMPT_PREFIX))).toBe(true);

    // Message order inside a candidate prompt: header -> patch block -> task.
    for (const dispatch of patched) {
      const prompt = dispatch.prompt;
      const header = prompt.indexOf('You are a probe run inside an isolated evolution branch.');
      const patch = prompt.indexOf(PATCH_PROMPT_PREFIX);
      const task = prompt.indexOf('Fix the failing build without breaking the release train.');
      expect(header).toBeGreaterThanOrEqual(0);
      expect(patch).toBeGreaterThan(header);
      expect(task).toBeGreaterThan(patch);
    }

    // ---- H4: the marker actually changed what the candidate delivered ----
    expect(composer.requests).toHaveLength(1);
    const request = composer.requests[0];
    expect(request).toBeDefined();
    const referenceContent = request?.reference?.deliverable?.content;
    expect(referenceContent).toBe(REFERENCE_DELIVERABLE);
    expect(request?.candidates.length).toBeGreaterThan(0);
    for (const candidate of request?.candidates ?? []) {
      expect(candidate.trajectory.deliverable?.content).toBe(CANDIDATE_DELIVERABLE);
      expect(candidate.trajectory.deliverable?.content).not.toBe(referenceContent);
    }
  });
});

// ---------------------------------------------------------------------------
// A3 + real proposer: a known-but-disabled-only response is a skip, not a crash
// ---------------------------------------------------------------------------

describe('A3: a scripts-only response from the REAL proposer reaches proposals_not_evaluable', () => {
  it('keeps the reference, runs no candidate and reports the A3 skip reason', async () => {
    // The injected-fake-proposer test in p3-proposal-select bypasses parseEdits,
    // so it cannot distinguish "the real proposer dropped the edit" from "the
    // orchestrator saw a scripts patch". This test uses the production
    // createDualTrackProposer through ctx.llm: parseEdits drops `scripts`
    // because the orchestrator's allowed set is the five text-evaluable
    // surfaces, and the typed notEvaluable error must become the A3 stop reason.
    const scriptsOnly = {
      rationale: 'Write a helper script.',
      focusSurfaces: ['scripts'],
      confidence: 0.5,
      expectedStepsDelta: -1,
      edits: {
        scripts: {
          kind: 'scripts',
          scripts: [{ path: 'helper.py', language: 'python', code: 'print(1)' }]
        }
      }
    };
    const host = createPatchAwareHostLlm({ proposals: [scriptsOnly] });
    const { ctx } = createFakeContext();
    const plugin = createEvoHarnessPlugin(
      { config: e2eConfig({ maxWidth: 1, maxDepth: 1, rolloutBudget: 1 }), now: makeClock() },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;

    const result = await plugin.run({
      sessionId: 'sess-a3-scripts-only',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('no_probe');
    expect(result.probesRun).toBe(1);
    expect(result.metadata?.stopReason).toBe('proposals_not_evaluable');
    expect(result.diagnostics.some((line) => line.startsWith('proposal-not-evaluable:'))).toBe(true);
    expect(result.diagnostics.some((line) => line.includes('scripts'))).toBe(true);
    expect(result.diagnostics.some((line) => line.includes('no node was added'))).toBe(true);
    expect(host.probePrompts).toHaveLength(1);
  });

  it('rejects an empty guardrails/memory payload before any candidate probe', async () => {
    // P-1 regression: the real proposer accepted `guardrails:{appendRules:[]}`
    // and `memory:{scopedViewId}`; A1 rendered no patch body, so the candidate
    // prompt was rationale-only and still cost a rollout. These payloads are now
    // rejected at validation, and the run stops after the reference probe.
    const emptyPayloads = {
      rationale: 'Mount an empty contract.',
      focusSurfaces: ['guardrails', 'memory'],
      confidence: 0.5,
      expectedStepsDelta: -1,
      edits: {
        guardrails: { kind: 'guardrails', appendRules: [] },
        memory: { kind: 'memory', scopedViewId: 'view-only' }
      }
    };
    const host = createPatchAwareHostLlm({ proposals: [emptyPayloads] });
    const { ctx } = createFakeContext();
    const plugin = createEvoHarnessPlugin(
      { config: e2eConfig({ maxWidth: 1, maxDepth: 1, rolloutBudget: 1 }), now: makeClock() },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;

    const result = await plugin.run({
      sessionId: 'sess-a3-empty-payload',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('no_probe');
    expect(result.probesRun).toBe(1);
    expect(host.probePrompts).toHaveLength(1);
    expect(result.diagnostics.some((line) => line.includes('proposal failed'))).toBe(true);
  });
});

const PASS_ARTIFACT = 'candidate PASS artifact';
const FAIL_ARTIFACT = 'candidate FAIL artifact';
const REFERENCE_ARTIFACT = 'reference FAIL artifact';

/** Reference fails; the first candidate PASSES the host check, the second FAILS. */
function createArtifactSignalRunner(now: () => number): {
  (context: IsolatedBranchContext): Promise<ProbeExecutionResult>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let candidateIndex = 0;
  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const isReference =
      context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
    if (isReference) {
      calls.push('reference');
      return {
        status: 'failed',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'reference attempt' },
          { index: 1, at: now(), kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'npm test' }, error: { name: 'ToolError', message: 'exit 1' } },
          { index: 2, at: now(), kind: 'error', text: 'the reference build failed' }
        ],
        toolErrors: [{ toolName: 'shell', message: 'exit 1', stepIndex: 1 }],
        failureSignals: [{ kind: 'tool_error', message: 'exit 1', toolName: 'shell', repairable: true }],
        deliverable: { content: REFERENCE_ARTIFACT, format: 'text' }
      };
    }
    const index = candidateIndex;
    candidateIndex += 1;
    calls.push(index === 0 ? 'candidate-pass' : 'candidate-fail');
    if (index === 0) {
      return {
        status: 'succeeded',
        steps: [
          { index: 0, at: now(), kind: 'message', text: 'apply the compliant scaffold' },
          { index: 1, at: now(), kind: 'result', text: 'checks pass' }
        ],
        toolErrors: [],
        deliverable: { content: PASS_ARTIFACT, format: 'text' }
      };
    }
    return {
      status: 'succeeded',
      steps: [
        { index: 0, at: now(), kind: 'message', text: 'apply the non-compliant scaffold' },
        { index: 1, at: now(), kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'npm test' }, error: { name: 'ToolError', message: 'exit 2' } },
        { index: 2, at: now(), kind: 'result', text: 'looks fine but fails the check' }
      ],
      toolErrors: [{ toolName: 'shell', message: 'exit 2', stepIndex: 1 }],
      deliverable: { content: FAIL_ARTIFACT, format: 'text' }
    };
  };
  return Object.assign(run, { calls });
}

function hostRunnerFor(taskId: string) {
  return createHostOwnedVerificationRunner({
    verifierId: 'signal-propagation-host',
    verifierVersion: 'v1',
    testSetId: 'signal-tests-v1',
    envId: 'signal-env-v1',
    cases: [
      {
        taskId,
        checks: [
          {
            id: 'artifact-contains-PASS',
            run: (artifact) => artifact.content.includes('PASS')
          }
        ]
      }
    ]
  });
}

/** A deterministic optimizer stub; the signal under test is reward, not L2. */
function signalOptimizer(): OrchestratorJitRl['optimizer'] {
  return {
    async decide<T>(
      level: JitLevel,
      _state: AbstractState,
      candidates: readonly JitCandidate<T>[]
    ): Promise<JitDecision<T>> {
      const probability = 1 / Math.max(1, candidates.length);
      const adjustments = candidates.map((candidate) => ({
        candidate,
        q: null,
        advantage: 0,
        normalizedAdvantage: 0,
        adjustedLogit: candidate.baseLogit,
        probability,
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
        rationale: 'signal-propagation stub'
      };
    }
  };
}

/** A kernel surface with a real memory store and a no-op step evaluator. */
function createSignalJit(store: MemoryExperienceStore, config: ReturnType<typeof parseEvoHarnessConfig>): OrchestratorJitRl {
  const evaluator: IStepEvaluator = {
    async evaluate(): Promise<readonly never[]> {
      return [];
    }
  };
  return {
    store,
    optimizer: signalOptimizer(),
    stepEvaluator: evaluator,
    config: {
      enabled: true,
      levels: ['meta', 'proposal'],
      gamma: config.jitrl.gamma,
      candidateCount: 1,
      k: config.jitrl.k,
      similarityThreshold: config.jitrl.similarityThreshold,
      augmentFromMemory: false,
      minSupportForStrongPrior: config.jitrl.minSupportForStrongPrior
    }
  };
}

function onlineMeta(store: MemoryExperienceStore): readonly ExperienceRecord[] {
  return store.snapshot().filter((record) => record.level === 'meta' && record.id.startsWith('online-'));
}

describe('A6 H6: trusted verdicts produce distinguishable rewards; no verifier means not-evaluable', () => {
  it('trusted PASS vs FAIL differ; both are evaluable and learnable', async () => {
    const now = makeClock();
    const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
    const config = parseEvoHarnessConfig(
      e2eConfig({
        dreamEveryNTasks: 100,
        config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
      })
    );
    const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const verificationRunner = hostRunnerFor('task-signal-h6');
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: createArtifactSignalRunner(now),
        deps: {
          jitrl: createSignalJit(store, config),
          verification: { runner: verificationRunner },
          onStage: (event) => stages.push({ stage: event.stage, detail: event.detail })
        }
      }
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-h6-trusted',
      task: harness.plugin.makeTask({ id: 'task-signal-h6', prompt: 'Fix the build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    const records = onlineMeta(store);
    expect(records.length).toBeGreaterThanOrEqual(2);
    const passed = records.find((record) => record.rewardSources.verificationVerdict === 1);
    const failed = records.find((record) => record.rewardSources.verificationVerdict === 2);
    expect(passed, 'no trusted-pass record').toBeDefined();
    expect(failed, 'no trusted-fail record').toBeDefined();
    expect(passed?.rewardSources.completion).toBe(1);
    // C2a: a trusted FAILED verdict on a run that claimed success is a
    // falsified success claim -> audit-only (no task-quality sample), while the
    // PASS is learnable. That asymmetry is the verifier-first rule, not the
    // reason the rewards differ.
    expect(passed?.learningEligible).toBe(true);
    expect(failed?.learningEligible).toBe(false);
    expect(passed?.rewardSources.verificationTrusted).toBe(1);
    expect(failed?.rewardSources.verificationTrusted).toBe(1);
    expect(passed?.rewardSources.notEvaluable).toBeUndefined();
    expect(failed?.rewardSources.notEvaluable).toBeUndefined();
    expect(passed?.reward ?? 0).toBeGreaterThan(failed?.reward ?? 0);
    const recordStage = stages.find((entry) => entry.stage === 'record_experience');
    const detail = recordStage?.detail as { detail?: Readonly<Record<string, unknown>> } | undefined;
    expect(detail?.detail?.['notEvaluable']).toBe(0);
    await harness.plugin.dispose();
  });

  it('without a verifier every text probe is not-evaluable: no learning, no fabricated failure', async () => {
    const now = makeClock();
    const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
    const config = parseEvoHarnessConfig(
      e2eConfig({
        dreamEveryNTasks: 100,
        config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
      })
    );
    const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: createArtifactSignalRunner(now),
        deps: {
          jitrl: createSignalJit(store, config),
          onStage: (event) => stages.push({ stage: event.stage, detail: event.detail })
        }
      }
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-h6-noverifier',
      task: harness.plugin.makeTask({ id: 'task-signal-h6', prompt: 'Fix the build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    const records = onlineMeta(store);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
      expect(record.reward).toBe(0);
      expect(record.observedReturn).toBe(0);
      expect(record.rewardSources.notEvaluable).toBe(1);
      expect(record.rewardSources.notEvaluableReason).toBeTypeOf('number');
    }
    // `outcome` is not rewritten to failed: not-evaluable is not a failure.
    expect(records.every((record) => record.outcome !== 'failed')).toBe(true);
    const recordStage = stages.find((entry) => entry.stage === 'record_experience');
    const detail = recordStage?.detail as { detail?: Readonly<Record<string, unknown>> } | undefined;
    expect(detail?.detail?.['notEvaluable']).toBe(records.length);
    // C2-pre task-quality count stays 0: these records are not-evaluable, not
    // shape-only verdicts.
    expect(detail?.detail?.['notTaskQualityEligible']).toBe(0);
    await harness.plugin.dispose();
  });
});

describe('A6 H8: the trusted PASS outranks the composer-selected FAIL in Dream evidence', () => {
  it('strategy B ranks the verified PASS above the selected FAIL, while node.score keeps the frozen surrogate', async () => {
    const now = makeClock();
    const requests: ComposeRequest[] = [];
    const composer: IHarnessComposer = {
      async compose(request: ComposeRequest): Promise<CompositionResult> {
        requests.push(request);
        const fail = request.candidates.find((candidate) =>
          (candidate.trajectory.deliverable?.content ?? '').includes('FAIL')
        );
        const winner = fail ?? request.candidates[0];
        return {
          selectedBranchId: winner?.branchId ?? null,
          selectedNodeId: winner?.nodeId ?? null,
          selectedTrajectoryId: winner?.trajectory.id ?? null,
          selectedPatch: winner?.patch ?? null,
          composedPatch: winner?.patch ?? null,
          assessments: request.candidates.map((candidate) => ({
            alias: candidate.nodeId,
            branchId: candidate.branchId,
            nodeId: candidate.nodeId,
            selected: candidate.nodeId === winner?.nodeId,
            adoptionRatio: candidate.nodeId === winner?.nodeId ? 1 : 0,
            contrasts: [],
            rationale: 'deliberately picks the FAIL candidate'
          })),
          adoptionRatios: Object.fromEntries(
            request.candidates.map((candidate) => [
              candidate.nodeId,
              candidate.nodeId === winner?.nodeId ? 1 : 0
            ])
          ),
          rationale: 'conflict fixture: composer picks the verifier-failed candidate',
          evaluatedAt: 1
        };
      }
    };
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: false } },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: createArtifactSignalRunner(now),
        deps: {
          composer,
          verification: { runner: hostRunnerFor('task-signal-h8') }
        }
      }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-h8',
      task: harness.plugin.makeTask({ id: 'task-signal-h8', prompt: 'Fix the build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(result.treeId).toBeDefined();
    const tree = harness.plugin.orchestrator.treePool.get(result.treeId ?? '');
    expect(tree).toBeDefined();
    const request = requests[0];
    expect(request).toBeDefined();
    const passNodeId = request?.candidates.find((candidate) =>
      (candidate.trajectory.deliverable?.content ?? '').includes('PASS')
    )?.nodeId;
    const failNodeId = request?.candidates.find((candidate) =>
      (candidate.trajectory.deliverable?.content ?? '').includes('FAIL')
    )?.nodeId;
    expect(passNodeId).toBeDefined();
    expect(failNodeId).toBeDefined();
    const passNode = passNodeId === undefined ? undefined : tree?.nodes[passNodeId];
    const failNode = failNodeId === undefined ? undefined : tree?.nodes[failNodeId];
    expect(passNode).toBeDefined();
    expect(failNode).toBeDefined();
    const passEvidence = passNode?.metadata?.['dreamEvidence'] as
      | {
          verdict?: string;
          trusted?: boolean;
          dreamScore?: number;
          strategy?: string;
          verifierId?: string;
          evidenceHash?: string;
        }
      | undefined;
    const failEvidence = failNode?.metadata?.['dreamEvidence'] as
      | {
          verdict?: string;
          trusted?: boolean;
          dreamScore?: number;
          strategy?: string;
          verifierId?: string;
          evidenceHash?: string;
        }
      | undefined;
    expect(passEvidence?.verdict).toBe('passed');
    expect(passEvidence?.trusted).toBe(true);
    expect(failEvidence?.verdict).toBe('failed');
    expect(failEvidence?.trusted).toBe(true);
    // A4-2 read-time re-check: the producer identity and evidence hash the
    // trusted reader used are PERSISTED (a bare boolean is not enough for the
    // tree gate after a restart).
    expect(passEvidence?.strategy).toBe('verified-only-selection');
    expect(passEvidence?.verifierId).toBe('signal-propagation-host');
    expect(passEvidence?.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(failEvidence?.strategy).toBe('verified-only-selection');
    expect(failEvidence?.verifierId).toBe('signal-propagation-host');
    expect(passEvidence?.dreamScore ?? 0).toBeGreaterThan(failEvidence?.dreamScore ?? 0);
    // The frozen online score still reflects the composer's pick (that is the
    // self-reference A4-2 refuses to replay), proving the two values differ.
    expect(failNode?.score ?? 0).toBeGreaterThan(passNode?.score ?? 0);
    await harness.plugin.dispose();
  });
});

describe('A6 H9: default configuration without a verifier audits, never learns', () => {
  it('admittedToL2=0, auditedOnly=N, and the physical audit records persist', async () => {
    const now = makeClock();
    const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
    const config = parseEvoHarnessConfig(
      e2eConfig({
        dreamEveryNTasks: 100,
        config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
      })
    );
    const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
      extra: {
        deps: {
          jitrl: createSignalJit(store, config),
          onStage: (event) => stages.push({ stage: event.stage, detail: event.detail })
        }
      }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-h9',
      task: harness.plugin.makeTask({ id: 'task-signal-h9', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    const recordStage = stages.find((entry) => entry.stage === 'record_experience');
    const detail = recordStage?.detail as { detail?: Readonly<Record<string, unknown>> } | undefined;
    const gate = detail?.detail?.['writebackGate'] as
      | {
          enabled: boolean;
          judged: number;
          admittedToL2: number;
          auditedOnly: number;
          gateFired: number;
        }
      | undefined;
    expect(gate?.enabled).toBe(true);
    expect(gate?.judged).toBeGreaterThan(0);
    expect(gate?.admittedToL2).toBe(0);
    expect(gate?.auditedOnly).toBe(gate?.judged);
    expect(gate?.gateFired).toBe(gate?.judged);

    // Physical auditing: the records are NOT deleted (invariant: audit logs
    // persist) and the plugin reports a real append count, never `appended 0`.
    const records = store.snapshot().filter((record) => record.id.startsWith('online-'));
    expect(records.length).toBeGreaterThan(0);
    expect(detail?.detail?.['records']).toBe(records.length);
    for (const record of records) {
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
      expect(typeof record.rewardSources.writebackRefusal).toBe('number');
    }
    const appendLine = result.diagnostics.find((line) => line.includes('jitrl: appended'));
    expect(appendLine).toBeDefined();
    expect(appendLine).not.toContain('appended 0');
    // The plugin states the auto resolution and why.
    expect(harness.plugin.diagnostics.join('\n')).toContain(
      'jitrl write-back gate: jitrl.writebackGate=auto -> on'
    );
    await harness.plugin.dispose();
  });

  it('explicit on is distinguishable from auto: a trusted verifier does not turn it off', async () => {
    const now = makeClock();
    const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: {
        jitrl: {
          enabled: true,
          levels: ['meta', 'proposal'],
          candidateCount: 1,
          writebackGate: 'on'
        }
      },
      extra: {
        runBranch: createArtifactSignalRunner(now),
        deps: {
          verification: { runner: hostRunnerFor('task-signal-a41-on') },
          onStage: (event) => stages.push({ stage: event.stage, detail: event.detail })
        }
      }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-a41-on',
      task: harness.plugin.makeTask({ id: 'task-signal-a41-on', prompt: 'Fix the build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(harness.plugin.diagnostics.join('\n')).toContain(
      'jitrl write-back gate: jitrl.writebackGate=on -> on'
    );
    const recordStage = stages.find((entry) => entry.stage === 'record_experience');
    const detail = recordStage?.detail as { detail?: Readonly<Record<string, unknown>> } | undefined;
    const gate = detail?.detail?.['writebackGate'] as { enabled: boolean; judged: number } | undefined;
    expect(gate?.enabled).toBe(true);
    expect(gate?.judged).toBeGreaterThan(0);
    await harness.plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// A6 H12: probe -> ledger metering (B8)
// ---------------------------------------------------------------------------

describe('A6 H12: every probe model call reserves and finally settles', () => {
  const RATE_CARD = {
    modelId: 'signal-propagation/metered-probe',
    inputRatePerMillion: 1_000_000,
    outputRatePerMillion: 2_000_000,
    reasoningSeparatelyBilled: false,
    conservativeFallbackCostMicros: 500
  } as const;

  it('reserve/settle count equals the run probesRun, one reservation per probe call', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      defaultRateCard: RATE_CARD
    });
    const settlement = twoPhaseSettlementFor(manager, {
      consumer: 'signal-propagation:probe'
    });
    const registry = new ModelCallRegistry();
    const host = createPatchAwareHostLlm({
      probeReply: () => 'metered probe deliverable'
    });
    const { ctx } = createFakeContext();

    // The production DSH resolver with the A6 H12 seam: the probe executor is
    // the same-process one, and the host's settlement is attached to it.
    const collaborators = await resolveDshCollaborators(
      { ...ctx, llm: host },
      {
        config: e2eConfig(),
        branch: { metering: { ledgerSettlement: settlement, registry } }
      }
    );

    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ config: { jitrl: { enabled: false } } }),
        now: makeClock(),
        // The metered executor resolved above is the one every probe runs
        // through; the plugin's proposer/composer still use the fake ctx.llm.
        deps: { runBranch: collaborators.runBranch }
      },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;

    const result = await plugin.run({
      sessionId: 'sess-h12',
      task: plugin.makeTask({ prompt: 'Fix the failing build with a metered probe.' }),
      trigger: 'always'
    });

    expect(result.outcome).not.toBe('no_probe');
    expect(result.probesRun).toBeGreaterThan(1);
    expect(host.probePrompts).toHaveLength(result.probesRun);

    const probeRecords = registry.snapshot().filter((record) => record.stage === 'probe');
    // Every probe dispatch goes through the one metered boundary. No extra
    // model call is hidden in this phase (the models are all fake and
    // deterministic), so the counts must match exactly.
    expect(probeRecords).toHaveLength(result.probesRun);
    for (const record of probeRecords) {
      expect(record.reservationId).toBeDefined();
      expect(record.settlement).toBe('final');
      expect(record.reservedMicros).toBeGreaterThan(0);
      expect(record.provenance).not.toBe('none');
    }
    // One reservation + one final settlement per probe call, and one identity
    // per reservation: the probe stage cannot bypass the budget.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(result.probesRun);
    expect(manager.getMeteringStatus().settleCount).toBe(result.probesRun);
    const identities = settlement.identities();
    expect(identities).toHaveLength(result.probesRun);
    expect(identities.every((identity) => identity.state === 'settled')).toBe(true);

    await plugin.dispose();
  });
});
