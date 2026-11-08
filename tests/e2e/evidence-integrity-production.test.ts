/**
 * rev8 evidence-integrity trio (#67 / #72 / #118 / #175) — PRODUCTION WIRING.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The two-round audit found the trio fully implemented and fully tested at
 * MODULE level, and completely unarmed at ASSEMBLY level: `CordisSeamManager`
 * and the agent-loop `TrajectoryCollector` were constructed without the
 * host-owned `evidenceIntegrity` policy, so the sentinel scan, the answer-key
 * scan and the pre-branch path scan were dead in production; the write-back
 * gate's ninth refusal code had no producer; and the verified-tree gate's
 * tree-level mark had no producer either.
 *
 * These tests therefore do NOT exercise the modules directly (the existing
 * unit suites already do). Every case below goes through the REAL
 * `createEvoHarnessPlugin` / `createEvoHarnessPluginForOfflineEvaluation`
 * assembly, the REAL `buildOrchestratorDeps`, the REAL `CordisSeamManager`
 * and the REAL `TrajectoryCollector`. The only injected collaborators are the
 * documented host seams (branch runner, model, memory client, policy, tree
 * pool, JitRL kernel for store inspection).
 *
 * TRUST DIRECTION PROVEN HERE
 * ---------------------------
 * The answer-key criteria in these tests are supplied by the HOST (this test
 * file stands in for the host) through `deps.evidenceIntegrity`, never through
 * a branch's `result.metadata`. No case fabricates an answer-key source from
 * branch data, and no case encodes the key text in a task prompt (which the
 * index would legitimately subtract as `visibleText`).
 *
 * MODE BOUNDARY (recorded, not hidden)
 * ------------------------------------
 * Under the production trusted evaluation the quarantine removes the
 * deliverable, so the record is `not-evaluable` and the gate's FIRST refusal
 * (`rejected-record-ineligible`) fires before the contamination refusal. The
 * contamination refusal itself (`rejected-contaminated-evidence`, code 9) is
 * reachable exactly when a contaminated record is otherwise learning-eligible;
 * the offline-evaluation assembly (`probeEvaluation: 'legacy'`, the
 * documented research seam) exercises that branch for real — same assembly,
 * same orchestrator, same collector, same gate, only the evaluator mode
 * differs. Both shapes are asserted below rather than papered over.
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
import { readEvidenceIntegrityMark } from '../../src/verification/evidence-integrity';
import { createJitRl } from '../../src/jitrl';
import type { JitRl } from '../../src/jitrl';
import type {
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  IsolatedBranchContext,
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
// host-owned answer key (used by #118 cases only; never present in a prompt)
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

const GENERIC_PROMPT =
  'Repair the release pipeline and report what you changed.';

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

/** The `record_experience` stage's write-back accounting (last such stage). */
function writebackDetailOf(stages: readonly StageEvent[]): WritebackDetail {
  const event = [...stages].reverse().find((entry) => entry.stage === 'record_experience');
  expect(event, 'record_experience stage must have run').toBeDefined();
  // The orchestrator's stage() wraps the payload once (`{ round, detail }`), so
  // the gate summary lives one level down from the event's own detail.
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

// ---------------------------------------------------------------------------
// branch runners
// ---------------------------------------------------------------------------

type Runner = ((context: IsolatedBranchContext) => Promise<ProbeExecutionResult>) & {
  readonly calls: string[];
};

function isReferencePatch(context: IsolatedBranchContext): boolean {
  return context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
}

/** Reference fails (optionally with a deliverable); candidates succeed. */
function createDeliverableRunner(
  now: () => number,
  deliverable: string,
  referenceDeliverable?: string
): Runner {
  const calls: string[] = [];
  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const reference = isReferencePatch(context);
    calls.push(reference ? 'reference' : 'candidate');
    if (reference) {
      return {
        status: 'failed',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'baseline attempt' },
          { index: 1, at: now(), kind: 'error', text: 'the baseline failed' }
        ],
        toolErrors: [{ toolName: 'shell', message: 'baseline exit 1', stepIndex: 1 }],
        failureSignals: [{ kind: 'tool_error', message: 'baseline exit 1', repairable: true }],
        ...(referenceDeliverable === undefined
          ? {}
          : { deliverable: { content: referenceDeliverable, format: 'markdown' } })
      };
    }
    return {
      status: 'succeeded',
      steps: [
        { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
        { index: 1, at: now(), kind: 'tool', toolName: 'shell', toolResult: { exitCode: 0 } },
        { index: 2, at: now(), kind: 'result', text: 'the build passes' }
      ],
      deliverable: { content: deliverable, format: 'markdown' }
    };
  };
  return Object.assign(run, { calls });
}

// ---------------------------------------------------------------------------
// proposer payloads
// ---------------------------------------------------------------------------

/** A skills patch whose component path is `skills/<name>/SKILL.md`. */
function skillsProposalPayload(name: string): Record<string, unknown> {
  return {
    rationale: 'Mount a written retry procedure as a skill so the loop follows it.',
    focusSurfaces: ['skills'],
    confidence: 0.7,
    expectedStepsDelta: -1,
    edits: {
      skills: {
        kind: 'skills',
        skills: [{ name, markdown: '# Retry procedure', description: 'retry procedure' }]
      }
    }
  };
}

// ---------------------------------------------------------------------------
// assembly helpers (real plugin, real orchestrator, documented seams only)
// ---------------------------------------------------------------------------

interface AssemblyOptions {
  readonly deliverable?: string;
  readonly evidenceIntegrity?: Record<string, unknown>;
  readonly proposals?: readonly Record<string, unknown>[];
  readonly writebackGate?: 'auto' | 'on' | 'off';
  readonly projectLevels?: readonly string[];
  /** Contaminates the REFERENCE probe's deliverable instead of the candidates'. */
  readonly referenceDeliverable?: string;
}

interface Assembly {
  readonly plugin: ReturnType<typeof createEvoHarnessPlugin>;
  readonly runner: Runner;
  readonly kernel: JitRl;
  readonly pool: ReturnType<typeof createDiscoveryTreePool>;
  readonly stages: StageEvent[];
  readonly diagnostics: readonly string[];
}

function buildAssembly(options: AssemblyOptions = {}): Assembly {
  const now = makeClock();
  const pool = createDiscoveryTreePool({ maxTrees: 8 });
  const stages: StageEvent[] = [];
  const config = {
    jitrl: {
      enabled: true,
      levels: options.projectLevels ?? ['meta'],
      candidateCount: 1,
      writebackGate: options.writebackGate ?? 'on'
    }
  };
  const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
  const kernel = createJitRl({ config: parsed, now });
  const runner = createDeliverableRunner(
    now,
    options.deliverable ?? 'recovered: the build passes',
    options.referenceDeliverable
  );
  const server = mem0LikeServer();
  const model = createScriptedModel(
    options.proposals === undefined ? {} : { proposals: options.proposals }
  );
  const plugin = createEvoHarnessPlugin({
    config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
    model,
    clients: [server.client],
    runBranch: runner,
    now,
    newId: makeIdFactory('ei'),
    deps: {
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
  });
  return { plugin, runner, kernel, pool, stages, diagnostics: [] };
}

function taskOf(plugin: Assembly['plugin'], id: string) {
  return plugin.makeTask({
    id,
    prompt: GENERIC_PROMPT,
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

function poolSnapshotOf(pool: ReturnType<typeof createDiscoveryTreePool>, run: { treeId?: string }): DiscoveryTreeSnapshot {
  const snapshot = run.treeId === undefined ? pool.list()[0] : pool.get(run.treeId);
  expect(snapshot, 'the run tree must be retained in the pool').toBeDefined();
  return snapshot as DiscoveryTreeSnapshot;
}

// ---------------------------------------------------------------------------
// #175: answer-key PATH collision — refused before any branch resource
// ---------------------------------------------------------------------------

describe('rev8 #175 (W1): production assembly refuses an answer-key path collision before rollout', () => {
  it('never executes the colliding patch and records the finding on the retained tree', async () => {
    const assembly = buildAssembly({
      proposals: [skillsProposalPayload('tests')],
      evidenceIntegrity: { taskId: 'task-ei-path', forbiddenPathSegments: ['tests'] }
    });
    const { plugin, runner, pool } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-ei-path',
      task: taskOf(plugin, 'task-ei-path'),
      trigger: 'always'
    });

    // The pre-rollout refusal: the reference probe ran, the colliding candidate
    // never reached the executor (the scan sits BEFORE branch acquisition).
    expect(runner.calls).toEqual(['reference']);

    // The production assembly really armed the host-owned policy (assembly-level
    // diagnostics are reported once at mount, not per run).
    expect(plugin.diagnostics.join('\n')).toContain('evidence-integrity: seam scans armed');
    expect(plugin.diagnostics.join('\n')).toContain('forbiddenPathSegments=1 segment(s)');

    // W4: the refusal mark reaches the retained tree snapshot, including the
    // exact colliding component path (counts/paths only, never key text).
    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-path');
    expect(mark?.findings.map((finding) => finding.collidingPath)).toContain(
      'skills/tests/SKILL.md'
    );

    // The real consumer refuses it: no verified tree, so the dream floor can
    // never be satisfied by a path-colliding run.
    expect(isVerifiedTree(snapshot)).toBe(false);
    expect(assessDreamReadiness(pool.list(), 1).verifiedTrees).toHaveLength(0);

    await plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// #118: answer-key TEXT contamination — withheld and refused at write-back
// ---------------------------------------------------------------------------

describe('rev8 #118 (W2/W3/W4): production assembly withholds answer-key text and refuses the write-back', () => {
  it('quarantines the contaminated trajectory, persists the mark, and refuses the record', async () => {
    const assembly = buildAssembly({
      deliverable: CONTAMINATED_DELIVERABLE,
      evidenceIntegrity: {
        taskId: 'task-ei-text',
        answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
      }
    });
    const { plugin, pool, kernel, stages } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-ei-text',
      task: taskOf(plugin, 'task-ei-text'),
      trigger: 'always'
    });

    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      // The HOST-armed scan withheld this execution: the mark is persisted as a
      // scalar, the record is audit-only and cannot train.
      expect(record.rewardSources['evidenceContaminated']).toBe(1);
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
    }

    const guard = writebackDetailOf(stages);
    expect(guard.enabled).toBe(true);
    expect(guard.admittedToL2).toBe(0);
    expect(guard.gateFired).toBeGreaterThanOrEqual(1);
    // Production trusted evaluation: quarantine removes the deliverable, so the
    // not-evaluable veto is the FIRST refusal (documented mode boundary). The
    // contamination refusal itself is asserted in the legacy-mode case below.
    expect(guard.refusalCounts['rejected-record-ineligible']).toBeGreaterThanOrEqual(1);

    // W4: the tree-level mark is the answer-key TEXT finding (not a path one).
    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    // FINDINGS carry counts/ids only — the matched words never leak into them.
    const serialized = JSON.stringify(mark);
    for (const criterion of ANSWER_CRITERIA) {
      expect(serialized).not.toContain(criterion.text);
    }

    expect(isVerifiedTree(snapshot)).toBe(false);
    expect(assessDreamReadiness(pool.list(), 1).verifiedTrees).toHaveLength(0);

    await plugin.dispose();
  });

  it('reaches the ninth refusal code (`rejected-contaminated-evidence`) for a learning-eligible contaminated record', async () => {
    // Same assembly shape; the ONLY difference is the evaluator mode. The
    // offline-evaluation entry is the documented research seam for exactly this
    // ("a synthetic measurement fixture and no host verifier exists by
    // construction"), so a quarantined execution stays process-eligible and the
    // gate's contamination branch — not the earlier ineligibility branch — is
    // what refuses it.
    const now = makeClock();
    const pool = createDiscoveryTreePool({ maxTrees: 8 });
    const stages: StageEvent[] = [];
    const config = {
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1, writebackGate: 'on' }
    };
    const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
    const kernel = createJitRl({ config: parsed, now });
    const runner = createDeliverableRunner(now, CONTAMINATED_DELIVERABLE);
    const model = createScriptedModel();
    const server = mem0LikeServer();
    const plugin = createEvoHarnessPluginForOfflineEvaluation({
      config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
      model,
      clients: [server.client],
      runBranch: runner,
      now,
      newId: makeIdFactory('ei-legacy'),
      deps: {
        probeEvaluation: 'legacy',
        policy: createRecordingPolicy({ maxWidth: 1, maxDepth: 1 }),
        treePool: pool,
        jitrl: kernel as never,
        onStage: (event: StageEvent) => {
          stages.push(event);
        },
        evidenceIntegrity: {
          taskId: 'task-ei-legacy',
          answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
        }
      } as never
    });

    const result = await plugin.run({
      sessionId: 'sess-ei-legacy',
      task: taskOf(plugin as unknown as Assembly['plugin'], 'task-ei-legacy'),
      trigger: 'always'
    });

    const guard = writebackDetailOf(stages);
    expect(guard.enabled).toBe(true);
    // The ninth refusal code is REACHABLE and it is what fired: every judged
    // execution was admitted to audit only, none was admitted to L2.
    expect(guard.refusalCounts['rejected-contaminated-evidence']).toBeGreaterThanOrEqual(1);
    expect(guard.admittedToL2).toBe(0);
    expect(guard.refusalCounts['rejected-record-ineligible']).toBeUndefined();
    expect(Object.keys(guard.routeCounts)).toHaveLength(0);

    // The stable numeric code (APPEND-ONLY list): index 8 -> code 9.
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.rewardSources['evidenceContaminated']).toBe(1);
      expect(record.rewardSources['writebackRefusal']).toBe(9);
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
    }
    // Same tree-level consequence as the production case.
    expect(readEvidenceIntegrityMark(poolSnapshotOf(pool, result).metadata)?.contaminated).toBe(true);

    await plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// #118 via the REFERENCE probe: contamination must stay visible even when the
// contaminated trajectory is NOT one of the executed candidates.
// ---------------------------------------------------------------------------

describe('rev8 #118 (W4): reference-probe contamination is visible on the tree', () => {
  it('aggregates the reference mark even though the candidates are clean', async () => {
    const assembly = buildAssembly({
      // Candidates are clean; ONLY the reference (the task baseline) carries
      // the withheld text.
      deliverable: 'recovered: the build passes',
      referenceDeliverable: CONTAMINATED_DELIVERABLE,
      evidenceIntegrity: {
        taskId: 'task-ei-ref',
        answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
      }
    });
    const { plugin, pool, kernel } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-ei-ref',
      task: taskOf(plugin, 'task-ei-ref'),
      trigger: 'always'
    });

    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    // The contaminated trajectory is the REFERENCE, and the reference is not an
    // executed candidate — so this mark can only have come from including the
    // reference in the aggregation.
    const records = candidateRecords(await recordsOf(kernel));
    expect(records.every((record) => record.rewardSources['evidenceContaminated'] === undefined)).toBe(
      true
    );
    expect(isVerifiedTree(snapshot)).toBe(false);
    expect(assessDreamReadiness(pool.list(), 1).verifiedTrees).toHaveLength(0);

    await plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// #72: the sentinel rejection is armed by DEFAULT (no host policy supplied)
// ---------------------------------------------------------------------------

describe('rev8 #72 (W1 default arm): a missing-trajectory sentinel is rejected with no host policy', () => {
  it('quarantines a sentinel deliverable and marks the retained tree', async () => {
    // No `deps.evidenceIntegrity`: the assembly's default (empty) policy still
    // arms the unconditional sentinel scan.
    const assembly = buildAssembly({ deliverable: '(no trajectory: renderer produced no events)' });
    const { plugin, pool, kernel } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-ei-sentinel',
      task: taskOf(plugin, 'task-ei-sentinel'),
      trigger: 'always'
    });

    const snapshot = poolSnapshotOf(pool, result);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('missing-trajectory-sentinel');

    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.some((record) => record.rewardSources['evidenceContaminated'] === 1)).toBe(true);

    // The raw sentinel text never survives into the persisted evidence.
    expect(JSON.stringify(records)).not.toContain('(no trajectory');

    await plugin.dispose();
  });
});

// ---------------------------------------------------------------------------
// no-contamination compatibility
// ---------------------------------------------------------------------------

describe('rev8 compatibility: a clean run is byte-identical (no mark, no refusal, no contamination)', () => {
  it('leaves the tree metadata absent and writes no contamination mark', async () => {
    const assembly = buildAssembly();
    const { plugin, pool, kernel, stages } = assembly;

    const result = await plugin.run({
      sessionId: 'sess-ei-clean',
      task: taskOf(plugin, 'task-ei-clean'),
      trigger: 'always'
    });

    const snapshot = poolSnapshotOf(pool, result);
    expect(snapshot.metadata).toBeUndefined();
    expect(readEvidenceIntegrityMark(snapshot.metadata)).toBeUndefined();

    const records = candidateRecords(await recordsOf(kernel));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.rewardSources['evidenceContaminated']).toBeUndefined();
    }

    const guard = writebackDetailOf(stages);
    expect(guard.refusalCounts['rejected-contaminated-evidence']).toBeUndefined();
    expect(guard.routeCounts['kept-verified-convergence']).toBeUndefined();

    // The default policy reports the boundary honestly instead of pretending a
    // key was scanned: no answerKey was supplied, so no TEXT scan ran.
    expect(plugin.diagnostics.join('\n')).toContain(
      'answerKey=absent - the answer-key TEXT scan stays inactive'
    );

    await plugin.dispose();
  });
});