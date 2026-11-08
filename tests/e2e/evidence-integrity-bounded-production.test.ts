/**
 * rev8 audit fix: the UNBOUNDED-FINDINGS production blocker, end to end.
 *
 * THE MEASURED SHAPE (before the fix, on this tree)
 *   A branch could return N steps that each carry the task's answer-key text,
 *   or attach an N-entry `findings` list on `result.metadata.trajectory.
 *   evidenceIntegrity`. Every one of those N became a persisted finding, was
 *   re-persisted verbatim by `quarantineTrajectory`, aggregated per trajectory
 *   by `treeEvidenceIntegrityMark`, and written into ONE tree-pool JSONL record.
 *   Measured: 60,000 findings in a tree mark, tree-pool.jsonl at 31 MB for one
 *   run, and 521 MB of log at 560 records (the 512-record compaction threshold
 *   is a COUNT, so it never bounded the bytes).
 *
 * WHAT THESE TESTS PROVE, through the REAL assembly
 *   `createEvoHarnessPlugin` + real orchestrator + real `CordisSeamManager` /
 *   `TrajectoryCollector` + real `createPersistenceRuntime` (real JSONL file on
 *   disk). Only the documented host seams are injected (branch runner, model,
 *   memory client, policy, tree pool, persistence).
 *
 *   1. the host-owned scan path (`result.steps`) and the carried path
 *      (`result.metadata.trajectory`) are BOTH bounded now;
 *   2. the persisted tree-pool record stays small, and the elided count is
 *      reported rather than the detail being fabricated;
 *   3. the DENY direction is unchanged at production scale: the run is still
 *      contaminated, still withheld, still not a verified tree;
 *   4. the log file itself stays bounded across repeated contaminated runs
 *      (byte-triggered compaction), and every tree restores after a restart.
 *
 * No key text is ever printed; the assertions that touch findings check kinds,
 * counts and paths only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { createEvoHarnessPlugin } from '../../src/index';
import { parseEvoHarnessConfig } from '../../src/config';
import { createDiscoveryTreePool, isVerifiedTree } from '../../src/dream-rsi';
import { createPersistenceRuntime, type PersistenceRuntime } from '../../src/persistence';
import {
  EVIDENCE_INTEGRITY_MAX_FINDINGS,
  readEvidenceIntegrityMark
} from '../../src/verification/evidence-integrity';
import { createJitRl } from '../../src/jitrl';
import type {
  DiscoveryTreeSnapshot,
  IsolatedBranchContext,
  ProbeExecutionResult
} from '../../src/types/contracts';
import { cleanupDir, makeTempDir } from '../unit/persistence/fixtures';
import {
  createRecordingPolicy,
  createScriptedModel,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

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
const FULL_KEY = ANSWER_CRITERIA.map((entry) => entry.text).join('\n');
const GENERIC_PROMPT = 'Repair the release pipeline and report what you changed.';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir);
  }
});

async function tempDataDir(label: string): Promise<string> {
  const dir = await makeTempDir(label);
  tempDirs.push(dir);
  return dir;
}

/** Number of surfaces the "huge branch" returns / claims. */
const SURFACES = 4_000;

function isReferencePatch(context: IsolatedBranchContext): boolean {
  return context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
}

/**
 * A branch that floods BOTH channels: N steps carrying the key text, plus an
 * N-entry carried findings list on the documented bridge metadata key. This is
 * the exact shape the audit measured.
 */
function floodingRunner(now: () => number) {
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
        failureSignals: [{ kind: 'tool_error', message: 'baseline exit 1', repairable: true }]
      };
    }
    return {
      status: 'succeeded',
      steps: Array.from({ length: SURFACES }, (_, index) => ({
        index,
        at: now(),
        kind: 'tool' as const,
        text: FULL_KEY + ' #' + String(index)
      })),
      deliverable: { content: FULL_KEY, format: 'markdown' },
      metadata: {
        mode: 'single_call',
        trajectory: {
          evidenceIntegrity: {
            version: 'rev8-evidence-integrity-v1',
            contaminated: true,
            withheld: true,
            findings: Array.from({ length: SURFACES }, (_, index) => ({
              kind: 'answer-key-text',
              location: 'steps[' + String(index) + ']',
              criterionId: 'k1'
            }))
          }
        }
      }
    };
  };
  return Object.assign(run, { calls });
}

interface FloodAssembly {
  readonly plugin: ReturnType<typeof createEvoHarnessPlugin>;
  readonly runtime: PersistenceRuntime;
  readonly dataDir: string;
  readonly logPath: string;
  readonly runner: ReturnType<typeof floodingRunner>;
}

async function buildFloodAssembly(dataDir: string, label = 'flood'): Promise<FloodAssembly> {
  const now = makeClock();
  const runtime = await createPersistenceRuntime({ dataDir, maxTrees: 8 });
  const config = { jitrl: { enabled: false } };
  const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
  const kernel = createJitRl({ config: parsed, now });
  const runner = floodingRunner(now);
  const server = mem0LikeServer();
  const model = createScriptedModel();
  const plugin = createEvoHarnessPlugin({
    config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
    model,
    clients: [server.client],
    runBranch: runner,
    now,
    // A distinct id prefix per mount: two mounts sharing a prefix would mint the
    // same tree ids and hit the documented same-id rejection, which is a
    // different concern than this test's log growth.
    newId: makeIdFactory(label),
    deps: {
      policy: createRecordingPolicy({ maxWidth: 1, maxDepth: 1 }),
      treePool: runtime.treePool as never,
      jitrl: kernel as never,
      evidenceIntegrity: {
        taskId: 'task-flood',
        answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
      }
    } as never
  });
  return {
    plugin,
    runtime,
    dataDir,
    logPath: path.join(dataDir, 'tree-pool.jsonl'),
    runner
  };
}

function taskOf(plugin: FloodAssembly['plugin'], id: string) {
  return plugin.makeTask({
    id,
    prompt: GENERIC_PROMPT,
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

async function logBytes(logPath: string): Promise<number> {
  try {
    return (await stat(logPath)).size;
  } catch {
    return 0;
  }
}

function snapshotOf(runtime: PersistenceRuntime, treeId: string | undefined): DiscoveryTreeSnapshot {
  const snapshot = treeId === undefined ? runtime.treePool.list()[0] : runtime.treePool.get(treeId);
  expect(snapshot, 'the run tree must be in the persistent pool').toBeDefined();
  return snapshot as DiscoveryTreeSnapshot;
}

describe('rev8 audit: a flooding branch cannot grow the persisted evidence mark', () => {
  it('bounds the persisted tree mark and the tree-pool record for a 4,000-surface branch', async () => {
    const dataDir = await tempDataDir('flood-once');
    const { plugin, runtime, logPath, runner } = await buildFloodAssembly(dataDir);

    const result = await plugin.run({
      sessionId: 'sess-flood',
      task: taskOf(plugin, 'task-flood'),
      trigger: 'always'
    });
    await runtime.flush();

    // The flood was real: the branch really did return thousands of surfaces.
    expect(runner.calls).toContain('candidate');

    const snapshot = snapshotOf(runtime, result.treeId);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);

    // The DENY direction is intact at this scale.
    expect(mark?.contaminated).toBe(true);
    expect(mark?.withheld).toBe(true);
    expect(isVerifiedTree(snapshot)).toBe(false);

    // THE FIX: the persisted mark is bounded, and it says how much it elided.
    expect(mark?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect((mark?.findings.length ?? 0) + (mark?.droppedFindings ?? 0)).toBeGreaterThanOrEqual(
      SURFACES
    );
    // No matched words ride along in the findings.
    expect(JSON.stringify(mark)).not.toContain('reconciliation');

    // THE OBSERVABLE EFFECT ON DISK: one run's record is small (pre-fix this
    // record was tens of MB for the same input; the mark alone was megabytes).
    const bytes = await logBytes(logPath);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);

    await plugin.dispose();
    await runtime.dispose();
  });

  it('keeps the log file bounded across repeated flooding runs and restores every tree', async () => {
    const dataDir = await tempDataDir('flood-many');
    const runs: string[] = [];
    // Five sequential mounts on the SAME data dir: the append history would be
    // unbounded if compaction were still record-count only.
    for (let round = 1; round <= 5; round += 1) {
      const { plugin, runtime } = await buildFloodAssembly(dataDir, 'flood-r' + String(round));
      const result = await plugin.run({
        sessionId: 'sess-flood-' + String(round),
        task: taskOf(plugin, 'task-flood-' + String(round)),
        trigger: 'always'
      });
      await runtime.flush();
      if (result.treeId !== undefined) {
        runs.push(result.treeId);
      }
      await plugin.dispose();
      await runtime.dispose();
    }
    expect(runs.length).toBe(5);

    const bytes = await logBytes(path.join(dataDir, 'tree-pool.jsonl'));
    // Five flooding runs, each with thousands of findings upstream: the log must
    // not be the product of the flood (pre-fix, one run's record was ~31 MB).
    expect(bytes).toBeLessThan(8 * 1024 * 1024);

    // Every tree still restores, and every restored mark is bounded.
    const restarted = await createPersistenceRuntime({ dataDir, maxTrees: 8 });
    expect(restarted.treePool.size()).toBe(5);
    for (const tree of restarted.treePool.list()) {
      const mark = readEvidenceIntegrityMark(tree.metadata);
      expect(mark?.contaminated).toBe(true);
      expect(mark?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
      expect(isVerifiedTree(tree)).toBe(false);
    }
    expect(restarted.diagnostics).toEqual([]);
    await restarted.dispose();
  });

  it('a clean run stays byte-identical: no mark, no droppedFindings, no new keys', async () => {
    const dataDir = await tempDataDir('flood-clean');
    const now = makeClock();
    const runtime = await createPersistenceRuntime({ dataDir, maxTrees: 8 });
    const config = { jitrl: { enabled: false } };
    const parsed = parseEvoHarnessConfig(e2eConfig({ config, maxWidth: 1, maxDepth: 1 }));
    const kernel = createJitRl({ config: parsed, now });
    const runner = Object.assign(
      async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> =>
        isReferencePatch(context)
          ? {
              status: 'failed',
              steps: [{ index: 0, at: now(), kind: 'error', text: 'baseline failed' }],
              toolErrors: [],
              failureSignals: []
            }
          : {
              status: 'succeeded',
              steps: [{ index: 0, at: now(), kind: 'result', text: 'the build passes' }],
              deliverable: { content: 'recovered: the build passes', format: 'markdown' }
            },
      { calls: [] as string[] }
    );
    const plugin = createEvoHarnessPlugin({
      config: e2eConfig({ config, maxWidth: 1, maxDepth: 1 }),
      model: createScriptedModel(),
      clients: [mem0LikeServer().client],
      runBranch: runner,
      now,
      newId: makeIdFactory('clean'),
      deps: {
        policy: createRecordingPolicy({ maxWidth: 1, maxDepth: 1 }),
        treePool: runtime.treePool as never,
        jitrl: kernel as never,
        evidenceIntegrity: {
          taskId: 'task-clean',
          answerKey: { criteria: ANSWER_CRITERIA, visibleText: [GENERIC_PROMPT] }
        }
      } as never
    });
    const result = await plugin.run({
      sessionId: 'sess-clean',
      task: taskOf({ makeTask: plugin.makeTask } as never, 'task-clean'),
      trigger: 'always'
    });
    await runtime.flush();

    const snapshot = snapshotOf(runtime, result.treeId);
    const mark = readEvidenceIntegrityMark(snapshot.metadata);
    expect(mark).toBeUndefined();
    // The pre-rev8 snapshot shape is preserved exactly: metadata stays absent.
    expect(snapshot.metadata).toBeUndefined();
    expect(isVerifiedTree(snapshot)).toBe(false); // no host verifier in this fixture

    await plugin.dispose();
    await runtime.dispose();
  });
});