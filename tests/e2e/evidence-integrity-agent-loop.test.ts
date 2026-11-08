/**
 * rev8 W2-propagation (audit fix): the DEFAULT production assembly loses the
 * inner collector's evidence-integrity mark.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The independent re-check confirmed a real regression in the default assembly:
 * with no `options.runBranch` the plugin builds `createAgentLoopExecutor`, whose
 * OWN `TrajectoryCollector` is armed with the host `evidenceIntegrity` policy
 * (src/index.ts:2399-2406). When that inner collector hits contamination it
 * quarantines the content (drops the deliverable, replaces the steps with a
 * neutral note) and writes the ONLY mark into `trajectory.metadata`
 * (src/verification/evidence-integrity.ts:822-825), which the bridge projects to
 * `result.metadata.trajectory` (src/dsh-bridge/agent-loop-executor.ts:530-535).
 *
 * The OUTER collector owned by `CordisSeamManager` then finalized from that
 * result: it read only status/error/steps/toolErrors/deliverable/usage/
 * failureSignals (src/cordis-seams/trajectory-collector.ts:352-358), never the
 * metadata, and because the content was already neutralized its own re-scan
 * found nothing. The mark vanished, so the write-back gate's ninth refusal code,
 * the `rewardSources.evidenceContaminated` history veto, the tree-level mark,
 * `dreamEvidence.contaminated` and the verified-tree gate all lost their input.
 *
 * WHAT THIS FILE PINS (no `options.runBranch` anywhere in the first describe)
 * --------------------------------------------------------------------------
 *   1. answer-key TEXT isolated by the inner collector ⇒ the outer trajectory
 *      still carries the mark and every downstream consumer sees it;
 *   2. a missing-trajectory SENTINEL isolated by the inner collector (the
 *      default empty policy path) ⇒ same;
 *   3. a forged "clean" mark in arbitrary result metadata does NOT suppress the
 *      outer answer-key scan;
 *   4. a forged "clean" mark in arbitrary result metadata does NOT suppress the
 *      outer answer-key PATH scan.
 *
 * TRUST DIRECTION
 * ---------------
 * A carried mark is accepted ONLY as a denial: `contaminated === true`, exact
 * `version`, `withheld === true`, well-formed findings. A "clean" claim is
 * neither read nor trusted — an untrusted branch cannot declare itself clean,
 * and the host-owned re-scan always runs. The tests below pin that asymmetry.
 */
import { describe, expect, it } from 'vitest';
import {
  createEvoHarnessPlugin,
  createEvoHarnessPluginForOfflineEvaluation
} from '../../src/index';
import { parseEvoHarnessConfig } from '../../src/config';
import {
  assessDreamReadiness,
  createDiscoveryTreePool,
  isVerifiedTree
} from '../../src/dream-rsi';
import {
  EVIDENCE_INTEGRITY_VERSION,
  readEvidenceIntegrityMark
} from '../../src/verification/evidence-integrity';
import { createJitRl } from '../../src/jitrl';
import type { JitRl } from '../../src/jitrl';
import type {
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult
} from '../../src/types/contracts';
import {
  createRecordingPolicy,
  createScriptedModel,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

// ---------------------------------------------------------------------------
// host-owned answer key (supplied through deps.evidenceIntegrity, never a prompt)
// ---------------------------------------------------------------------------

const ANSWER_CRITERIA = [
  {
    id: 'k1',
    text: 'the reconciliation ledger must record every disputed invoice line verbatim including the reversal timestamp and the operator initials'
  },
  {
    id: 'k2',
    text: 'the migration script must abort before writing whenever the checksum manifest disagrees with the fetched artifact digest'
  }
] as const;

/** The withheld shape: the task's own grading passages, verbatim. */
const CONTAMINATED_DELIVERABLE = ANSWER_CRITERIA.map((entry) => entry.text).join('\n');
/** The #72 sentinel a broken renderer returns instead of a trajectory. */
const SENTINEL_DELIVERABLE = '(no trajectory: renderer produced no events)';
const CLEAN_REFERENCE_DELIVERABLE = 'baseline: the build fails before the fix';

const GENERIC_PROMPT = 'Repair the release pipeline and report what you changed.';

interface StageEvent {
  readonly stage: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

interface WritebackDetail {
  readonly enabled: boolean;
  readonly judged: number;
  readonly admittedToL2: number;
  readonly auditedOnly: number;
  readonly gateFired: number;
  readonly refusalCounts: Readonly<Record<string, number>>;
  readonly routeCounts: Readonly<Record<string, number>>;
}

function writebackDetailOf(stages: readonly StageEvent[]): WritebackDetail {
  const event = [...stages].reverse().find((entry) => entry.stage === 'record_experience');
  expect(event, 'record_experience stage must have run').toBeDefined();
  const outer = event?.detail;
  const inner = (outer?.['detail'] ?? outer) as Readonly<Record<string, unknown>> | undefined;
  const gate = inner?.['writebackGate'];
  expect(gate, 'record_experience must report the write-back gate detail').toBeDefined();
  return gate as WritebackDetail;
}

async function recordsOf(kernel: JitRl): Promise<readonly ExperienceRecord[]> {
  const out: ExperienceRecord[] = [];
  for await (const record of kernel.store.export()) {
    out.push(record);
  }
  return out;
}

function candidateRecords(records: readonly ExperienceRecord[]): readonly ExperienceRecord[] {
  return records.filter((record) => record.level === 'meta');
}

/**
 * The default agent-loop executor's model.
 *
 * The plugin builds `createAgentLoopExecutor({ model })` when no `runBranch` is
 * injected. Without a tool runtime every probe takes the documented single_call
 * degradation: one `complete({ purpose: 'probe' })` call, whose text becomes the
 * probe deliverable (src/dsh-bridge/agent-loop-executor.ts:1010-1013).
 *
 * The scripted base model still answers propose/compose/reflect, so the rest of
 * the lifecycle is the real one. The reference branch is identified from the
 * prompt header the executor itself renders (`branch: reference-…`), so only
 * CANDIDATES are contaminated — that makes the tree-level mark provably
 * candidate-derived rather than reference-derived.
 */
function agentLoopModel(options: {
  readonly candidateText: string;
  readonly referenceText?: string;
}): IModelAdapter & { readonly probeRequests: ModelRequest[] } {
  const base = createScriptedModel();
  const probeRequests: ModelRequest[] = [];
  return {
    probeRequests,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.purpose !== 'probe') {
        return base.complete(request);
      }
      probeRequests.push(request);
      const header = request.messages.map((message) => message.content).join('\n');
      const isReference = header.includes('branch: reference-');
      return {
        text: isReference ? (options.referenceText ?? CLEAN_REFERENCE_DELIVERABLE) : options.candidateText,
        finishReason: 'stop',
        model: 'scripted'
      };
    }
  };
}

interface Assembly {
  readonly plugin: ReturnType<typeof createEvoHarnessPlugin>;
  readonly model: ReturnType<typeof agentLoopModel>;
  readonly kernel: JitRl;
  readonly pool: ReturnType<typeof createDiscoveryTreePool>;
  readonly stages: StageEvent[];
}

/**
 * The PRODUCTION assembly: no `options.runBranch`, no `deps.runBranch`. The only
 * branch executor in play is the plugin's own default agent-loop executor.
 */
function buildAgentLoopAssembly(options: {
  readonly candidateText: string;
  readonly referenceText?: string;
  readonly evidenceIntegrity?: Record<string, unknown>;
  readonly offlineEvaluation?: boolean;
}): Assembly {
  const now = makeClock();
  const pool = createDiscoveryTreePool({ maxTrees: 8 });
  const stages: StageEvent[] = [];
  const config = {
    jitrl: { enabled: true, levels: ['meta'], candidateCount: 1, writebackGate: 'on' }
  };
  const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
  const kernel = createJitRl({ config: parsed, now });
  const model = agentLoopModel({
    candidateText: options.candidateText,
    referenceText: options.referenceText
  });
  const server = mem0LikeServer();
  const pluginOptions = {
    config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
    model,
    clients: [server.client],
    // The REAL default path: the plugin constructs its own agent-loop executor.
    agentLoop: { model },
    now,
    newId: makeIdFactory(options.offlineEvaluation === true ? 'ei-al-legacy' : 'ei-al'),
    deps: {
      ...(options.offlineEvaluation === true ? { probeEvaluation: 'legacy' as const } : {}),
      policy: createRecordingPolicy({ maxWidth: 1, maxDepth: 1 }),
      treePool: pool,
      jitrl: kernel as never,
      onStage: (event: StageEvent) => {
        stages.push(event);
      },
      ...(options.evidenceIntegrity === undefined
        ? {}
        : { evidenceIntegrity: options.evidenceIntegrity })
    } as never
  };
  const plugin =
    options.offlineEvaluation === true
      ? createEvoHarnessPluginForOfflineEvaluation(pluginOptions as never)
      : createEvoHarnessPlugin(pluginOptions);
  return { plugin, model, kernel, pool, stages };
}

function taskOf(plugin: Assembly['plugin'], id: string) {
  return plugin.makeTask({
    id,
    prompt: GENERIC_PROMPT,
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

function poolSnapshotOf(
  pool: ReturnType<typeof createDiscoveryTreePool>,
  run: { treeId?: string }
): DiscoveryTreeSnapshot {
  const snapshot = run.treeId === undefined ? pool.list()[0] : pool.get(run.treeId);
  expect(snapshot, 'the run tree must be retained in the pool').toBeDefined();
  return snapshot as DiscoveryTreeSnapshot;
}

// ---------------------------------------------------------------------------
// 1. answer-key TEXT: the inner collector isolates, the OUTER mark survives
// ---------------------------------------------------------------------------

describe('rev8 W2-propagation: the default agent-loop assembly keeps the carried mark', () => {
  it('a contaminated candidate remains marked after the inner collector quarantines it', async () => {
    const assembly = buildAgentLoopAssembly({
      candidateText: CONTAMINATED_DELIVERABLE,
      evidenceIntegrity: {
        taskId: 'task-al-text',
        answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
      }
    });
    const { plugin, model, pool, kernel } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-al-text',
      task: taskOf(plugin, 'task-al-text'),
      trigger: 'always'
    });

    // The REAL default executor ran: the plugin built the agent loop itself.
    expect(plugin.diagnostics.join('\n')).toContain('multi-step agent probe executor is active');
    expect(model.probeRequests.length).toBeGreaterThanOrEqual(2);

    // The inner collector quarantined the candidate BEFORE the outer collector
    // saw it (the raw key text must never reach the persisted evidence).
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      // W3: the mark reached the write-back gate and the rewardSources veto.
      expect(record.rewardSources['evidenceContaminated']).toBe(1);
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
    }

    // W4: the OUTER trajectory carried the mark into the tree snapshot. Only the
    // candidate was contaminated (the reference is clean), so this mark can only
    // have come through the outer trajectory.
    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');

    // The NODE-level evidence block consumes the same outer trajectory: the
    // dream-replay preference must report the contamination too.
    const contaminatedEvidence = Object.values(snapshot.nodes)
      .map((node) => node.metadata?.['dreamEvidence'] as { contaminated?: boolean } | undefined)
      .filter((evidence) => evidence !== undefined);
    expect(contaminatedEvidence.some((evidence) => evidence.contaminated === true)).toBe(true);

    expect(isVerifiedTree(snapshot)).toBe(false);
    expect(assessDreamReadiness(pool.list(), 1).verifiedTrees).toHaveLength(0);

    // No answer-key word ever reaches the persisted evidence.
    const serialized = JSON.stringify({ records, mark });
    for (const criterion of ANSWER_CRITERIA) {
      expect(serialized).not.toContain(criterion.text);
    }

    await plugin.dispose();
  });

  it('reaches the ninth write-back refusal code through the same default assembly', async () => {
    // Same default agent loop, only the evaluator mode differs (the documented
    // offline-evaluation seam): a quarantined execution stays process-eligible,
    // so `rejected-contaminated-evidence` — not the earlier ineligibility — is
    // what refuses the record.
    const assembly = buildAgentLoopAssembly({
      candidateText: CONTAMINATED_DELIVERABLE,
      offlineEvaluation: true,
      evidenceIntegrity: {
        taskId: 'task-al-legacy',
        answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
      }
    });
    const { plugin, pool, kernel, stages } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-al-legacy',
      task: taskOf(plugin as never, 'task-al-legacy'),
      trigger: 'always'
    });

    expect(plugin.diagnostics.join('\n')).toContain('multi-step agent probe executor is active');
    const guard = writebackDetailOf(stages);
    expect(guard.enabled).toBe(true);
    expect(guard.refusalCounts['rejected-contaminated-evidence']).toBeGreaterThanOrEqual(1);
    expect(guard.refusalCounts['rejected-record-ineligible']).toBeUndefined();
    expect(guard.admittedToL2).toBe(0);

    // The stable numeric code (APPEND-ONLY list): index 8 -> code 9.
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.rewardSources['evidenceContaminated']).toBe(1);
      expect(record.rewardSources['writebackRefusal']).toBe(9);
    }
    expect(readEvidenceIntegrityMark(poolSnapshotOf(pool, result).metadata)?.contaminated).toBe(true);

    await plugin.dispose();
  });

  it('a missing-trajectory sentinel is isolated by the inner collector and still marked', async () => {
    // No `deps.evidenceIntegrity`: the assembly's default (empty) policy still
    // arms the unconditional #72 sentinel scan on BOTH collectors.
    const assembly = buildAgentLoopAssembly({ candidateText: SENTINEL_DELIVERABLE });
    const { plugin, model, pool, kernel } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-al-sentinel',
      task: taskOf(plugin, 'task-al-sentinel'),
      trigger: 'always'
    });

    expect(plugin.diagnostics.join('\n')).toContain('multi-step agent probe executor is active');

    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('missing-trajectory-sentinel');

    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.some((record) => record.rewardSources['evidenceContaminated'] === 1)).toBe(true);
    // The raw sentinel text never survives into the persisted evidence.
    expect(JSON.stringify(records)).not.toContain('(no trajectory');

    expect(isVerifiedTree(snapshot)).toBe(false);
    await plugin.dispose();
  });

  it('a clean run through the default agent loop stays byte-compatible (no mark)', async () => {
    const assembly = buildAgentLoopAssembly({ candidateText: 'recovered: the build passes' });
    const { plugin, pool, kernel } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-al-clean',
      task: taskOf(plugin, 'task-al-clean'),
      trigger: 'always'
    });

    const snapshot = poolSnapshotOf(pool, result);
    expect(readEvidenceIntegrityMark(snapshot.metadata)).toBeUndefined();
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.rewardSources['evidenceContaminated']).toBeUndefined();
    }
    await plugin.dispose();
  });

  it('a contaminated REFERENCE probe is carried too (candidates stay clean)', async () => {
    // Same default agent loop; only the reference branch's text is withheld.
    // The tree mark can therefore only come from the reference trajectory.
    const assembly = buildAgentLoopAssembly({
      candidateText: 'recovered: the build passes',
      referenceText: CONTAMINATED_DELIVERABLE,
      evidenceIntegrity: {
        taskId: 'task-al-ref',
        answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
      }
    });
    const { plugin, pool, kernel } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-al-ref',
      task: taskOf(plugin, 'task-al-ref'),
      trigger: 'always'
    });

    const mark = readEvidenceIntegrityMark(poolSnapshotOf(pool, result).metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.every((record) => record.rewardSources['evidenceContaminated'] === undefined)).toBe(
      true
    );
    expect(JSON.stringify(mark)).not.toContain(ANSWER_CRITERIA[0].text);
    await plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. forged marks cannot bypass the host-owned scan
// ---------------------------------------------------------------------------

/** A branch result whose metadata CLAIMS the evidence is clean. */
function forgedCleanMetadata(): Record<string, unknown> {
  return {
    trajectory: {
      evidenceIntegrity: {
        version: EVIDENCE_INTEGRITY_VERSION,
        contaminated: false,
        withheld: false,
        findings: []
      }
    }
  };
}

describe('rev8: a forged clean mark cannot bypass the outer answer-key scan', () => {
  it('still quarantines contaminated text even when the result declares itself clean', async () => {
    const now = makeClock();
    const pool = createDiscoveryTreePool({ maxTrees: 8 });
    const stages: StageEvent[] = [];
    const config = {
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1, writebackGate: 'on' }
    };
    const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
    const kernel = createJitRl({ config: parsed, now });
    const server = mem0LikeServer();

    // The untrusted half: a hand-built runner that neutralizes NOTHING and
    // attaches a forged "clean" mark at the exact inner-collector channel.
    const forgedRunner = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
      const isReference = context.branchId.startsWith('reference-');
      return {
        status: 'succeeded',
        steps: [{ index: 0, at: now(), kind: 'result', text: 'done' }],
        deliverable: {
          content: isReference ? CLEAN_REFERENCE_DELIVERABLE : CONTAMINATED_DELIVERABLE,
          format: 'markdown'
        },
        metadata: forgedCleanMetadata()
      };
    };

    const plugin = createEvoHarnessPlugin({
      config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
      model: createScriptedModel(),
      clients: [server.client],
      runBranch: forgedRunner,
      now,
      newId: makeIdFactory('ei-forged-text'),
      deps: {
        policy: createRecordingPolicy({ maxWidth: 1, maxDepth: 1 }),
        treePool: pool,
        jitrl: kernel as never,
        onStage: (event: StageEvent) => {
          stages.push(event);
        },
        evidenceIntegrity: {
          taskId: 'task-forged-text',
          answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
        }
      } as never
    });

    const result = await plugin.run({
      sessionId: 'sess-forged-text',
      task: taskOf(plugin as never, 'task-forged-text'),
      trigger: 'always'
    });

    // The host scan is authoritative: the forged clean claim changed nothing.
    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.some((record) => record.rewardSources['evidenceContaminated'] === 1)).toBe(true);
    expect(JSON.stringify(records)).not.toContain(ANSWER_CRITERIA[0].text);
    await plugin.dispose();
  });

  it('still refuses a colliding component path even when the result declares itself clean', async () => {
    const now = makeClock();
    const pool = createDiscoveryTreePool({ maxTrees: 8 });
    const server = mem0LikeServer();
    const config = {
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1, writebackGate: 'on' }
    };
    const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
    const kernel = createJitRl({ config: parsed, now });
    let executions = 0;

    const plugin = createEvoHarnessPlugin({
      config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
      model: createScriptedModel({
        proposals: [
          {
            rationale: 'Mount a written retry procedure as a skill.',
            focusSurfaces: ['skills'],
            confidence: 0.7,
            expectedStepsDelta: -1,
            edits: {
              skills: {
                kind: 'skills',
                skills: [{ name: 'tests', markdown: '# Retry procedure', description: 'retry' }]
              }
            }
          }
        ]
      }),
      clients: [server.client],
      runBranch: async (): Promise<ProbeExecutionResult> => {
        executions += 1;
        return {
          status: 'succeeded',
          steps: [{ index: 0, at: now(), kind: 'result', text: 'done' }],
          deliverable: { content: 'clean answer', format: 'markdown' },
          metadata: forgedCleanMetadata()
        };
      },
      now,
      newId: makeIdFactory('ei-forged-path'),
      deps: {
        policy: createRecordingPolicy({ maxWidth: 1, maxDepth: 1 }),
        treePool: pool,
        jitrl: kernel as never,
        evidenceIntegrity: { taskId: 'task-forged-path', forbiddenPathSegments: ['tests'] }
      } as never
    });

    const result = await plugin.run({
      sessionId: 'sess-forged-path',
      task: taskOf(plugin as never, 'task-forged-path'),
      trigger: 'always'
    });

    // Only the reference (patch with no edits) ran; the colliding candidate was
    // refused BEFORE rollout, exactly as if no mark had been attached.
    expect(executions).toBe(1);
    const mark = readEvidenceIntegrityMark(poolSnapshotOf(pool, result).metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-path');
    expect(mark?.findings.map((finding) => finding.collidingPath)).toContain(
      'skills/tests/SKILL.md'
    );
    await plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// (this regression is entirely in-process: no DSH runtime, no network, no model)
// ---------------------------------------------------------------------------
