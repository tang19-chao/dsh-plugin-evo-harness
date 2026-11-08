/**
 * t27 rebuild-audit regression test: durable task-counter wiring.
 *
 * The orchestrator was rebuilt by hand; the persistence branch is exactly the
 * region that broke. These tests pin the contract that survived the rebuild:
 * one recordCompletedTask per successful run, the durable counter is the
 * authoritative shouldDream source, recordDream runs once per actual dream, and
 * a failed run records nothing.
 *
 * The second describe (rev8 live-cycle wiring) pins the CROSS-ROUND manifest
 * contract end to end: one run's realized shape is recorded, the NEXT run's
 * plan_grid reads it back - through the real orchestrator, the real plugin
 * entrypoint and a real data directory, not through a module-level read/write
 * round trip.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildE2E } from '../../e2e/fixtures';
import type { OrchestratorTaskCounter } from '../../../src/orchestrator';
import { createActivePolicyFromDefaults } from '../../../src/dream-rsi';
import {
  effectiveSequentialRoundsOf,
  liveCycleManifestPath,
  readLiveCycleManifest,
  writeLiveCycleManifest
} from '../../../src/dream-rsi/live-cycle-manifest';
import { createPersistenceRuntime } from '../../../src/persistence';
import type {
  IActivePolicy,
  MetaSearchPolicy,
  PlanGridRequest,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';

interface CounterHarness {
  readonly counter: OrchestratorTaskCounter;
  readonly calls: { shouldDream: number; recordCompleted: number; recordDream: number };
  setDue(value: boolean): void;
}

function makeCounter(): CounterHarness {
  let completed = 0;
  let dreams = 0;
  let due = false;
  const calls = { shouldDream: 0, recordCompleted: 0, recordDream: 0 };
  return {
    calls,
    setDue: (value: boolean) => {
      due = value;
    },
    counter: {
      shouldDream: () => {
        calls.shouldDream += 1;
        return due;
      },
      recordCompletedTask: async () => {
        calls.recordCompleted += 1;
        completed += 1;
        return completed;
      },
      recordDream: async () => {
        calls.recordDream += 1;
        dreams += 1;
        return dreams;
      }
    }
  };
}

function task(plugin: ReturnType<typeof buildE2E>['plugin']) {
  return plugin.makeTask({
    id: 'task-counter',
    prompt: 'Fix the failing build without breaking the release train.',
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

describe('orchestrator durable task counter (t27 audit)', () => {
  it('records exactly one completed task per successful run and skips the dream when not due', async () => {
    const counter = makeCounter();
    const harness = buildE2E({
      extra: { deps: { taskCounter: counter.counter, dreamMinVerifiedTrees: 0 } }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-counter-1',
      task: task(harness.plugin),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(counter.calls.recordCompleted).toBe(1);
    expect(counter.calls.shouldDream).toBe(1);
    expect(counter.calls.recordDream).toBe(0);
    expect(result.metadata?.dreamTriggered).toBe(false);
  });

  it('records one dream when due without re-counting the same task', async () => {
    const counter = makeCounter();
    counter.setDue(true);
    const harness = buildE2E({
      extra: { deps: { taskCounter: counter.counter, dreamMinVerifiedTrees: 0 } }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-counter-2',
      task: task(harness.plugin),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(counter.calls.recordCompleted).toBe(1);
    expect(counter.calls.recordDream).toBe(1);
    expect(result.metadata?.dreamTriggered).toBe(true);
    // The task itself is counted once; the dream counter is a separate counter.
    expect(counter.calls.recordCompleted).not.toBe(2);
  });

  it('records nothing when the lifecycle fails before finalize', async () => {
    const counter = makeCounter();
    const harness = buildE2E({
      extra: {
        deps: {
          taskCounter: counter.counter,
          reflector: {
            reflect: async () => {
              throw new Error('reflect exploded');
            }
          }
        }
      }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-counter-3',
      task: task(harness.plugin),
      trigger: 'always'
    });
    expect(result.outcome).toBe('failed');
    expect(result.diagnostics.join(' ')).toContain('lifecycle failed');
    expect(counter.calls.recordCompleted).toBe(0);
    expect(counter.calls.shouldDream).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rev8 plan §6.1 item 3 (live-cycle manifest): the CROSS-ROUND contract.
//
// What these tests must prove (per the task brief):
//  - run 1's REALIZED per-round candidate counts (batchSizes) and the derived
//    effectiveSequentialRounds are persisted; the reference probe counts in
//    `probes` but belongs to no batch;
//  - run 2's plan_grid reads that record back as previousLiveCycle - through
//    the real orchestrator and a real data directory, not a module-level
//    read/write round trip;
//  - the previous PLANNED grid is never substituted for a realized one;
//  - a failed lifecycle is marked failed; a write failure is diagnostic only;
//  - skip/dry-run cycles do not clobber the last realized record;
//  - an unwired seam keeps the lifecycle byte-identical (no history field,
//    no diagnostics).
// Temp roots live under os.tmpdir() (NOT the repo work/ allowlist), matching
// tests/unit/dream-rsi/live-cycle-manifest.test.ts.
// ---------------------------------------------------------------------------

/** PlanGrid-recording wrapper over a real ActivePolicy (e2e config defaults). */
function makeLiveCycleRecordingPolicy(
  shape: { maxWidth?: number; maxDepth?: number } = {}
): IActivePolicy & {
  readonly planGridRequests: PlanGridRequest[];
  readonly planGridResults: SearchGridPlan[];
} {
  const base = createActivePolicyFromDefaults({
    maxWidth: shape.maxWidth ?? 2,
    maxDepth: shape.maxDepth ?? 1,
    earlyStopThreshold: 0.8,
    minMemoryConfidenceForSkip: 0.75
  });
  const planGridRequests: PlanGridRequest[] = [];
  const planGridResults: SearchGridPlan[] = [];
  return {
    planGridRequests,
    planGridResults,
    get policy(): MetaSearchPolicy {
      return base.policy;
    },
    planGrid(request: PlanGridRequest): SearchGridPlan {
      planGridRequests.push(request);
      const plan = base.planGrid(request);
      planGridResults.push(plan);
      return plan;
    },
    selectBatch(request: SelectBatchRequest) {
      return base.selectBatch(request);
    },
    update(policy: MetaSearchPolicy): void {
      base.update(policy);
    }
  };
}

function liveCycleTask(harness: ReturnType<typeof buildE2E>): ReturnType<
  ReturnType<typeof buildE2E>['plugin']['makeTask']
> {
  return harness.plugin.makeTask({
    id: 'task-live-cycle',
    prompt: 'Fix the failing build without breaking the release train.',
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

describe('live-cycle manifest cross-round wiring (rev8 plan §6.1 item 3)', () => {
  const tempDirs: string[] = [];

  async function tempDir(label: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cycle-rebuild-' + label + '-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('records run 1 realized shape and run 2 plan_grid reads it as history', async () => {
    const dir = await tempDir('cross-round');
    const policy = makeLiveCycleRecordingPolicy();
    const harness = buildE2E({
      extra: { deps: { policy, liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 } }
    });

    const first = await harness.plugin.run({
      sessionId: 'sess-live-cycle-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    expect(policy.planGridRequests.length).toBeGreaterThanOrEqual(1);
    // Run 1 planned BEFORE any cycle existed: no history on the request.
    expect(policy.planGridRequests[0]?.previousLiveCycle).toBeUndefined();

    // The manifest records run 1's REALIZED shape.
    const read = await readLiveCycleManifest(dir);
    expect(read.existed).toBe(true);
    const manifest = read.value;
    expect(manifest).toBeDefined();
    expect(manifest?.runId).toBe(first.runId);
    expect(manifest?.status).toBe('completed');
    expect(manifest?.taskId).toBe('task-live-cycle');
    expect(manifest?.sessionId).toBe('sess-live-cycle-1');
    expect(manifest?.probes).toBe(first.probesRun);
    const firstRounds = (first.metadata as { rounds?: number }).rounds;
    expect(manifest?.rounds).toBe(firstRounds);
    // The recorded gridPlan is the plan THIS cycle ran under (== lastPlan),
    // kept separately from the realized numbers - never dressed up as actuals.
    expect(manifest?.gridPlan).toEqual(harness.plugin.orchestrator.lastPlan());
    // batchSizes are the realized per-round candidate counts: one entry per
    // executed round, and their sum is exactly the candidate probes (probesRun
    // minus the ONE reference probe the schema counts separately in `probes`).
    expect(manifest?.batchSizes).not.toBeNull();
    expect(manifest?.batchSizes?.length).toBe(firstRounds);
    expect((manifest?.batchSizes ?? []).reduce((total, size) => total + size, 0)).toBe(
      first.probesRun - 1
    );
    // e2e config runs probe.maxConcurrentProbes=2; the realized sequential
    // cost is derived with effectiveSequentialRoundsOf, not invented.
    expect(manifest?.effectiveSequentialRounds).toBe(
      effectiveSequentialRoundsOf(manifest?.batchSizes ?? [], 2)
    );

    // Run 2 (same assembly, real disk between the runs): plan_grid receives
    // run 1's realized shape as previousLiveCycle.
    const second = await harness.plugin.run({
      sessionId: 'sess-live-cycle-2',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(second.outcome).toBe('composed');
    expect(policy.planGridRequests.length).toBe(2);
    const history = policy.planGridRequests[1]?.previousLiveCycle;
    expect(history).toBeDefined();
    expect(history?.runId).toBe(first.runId);
    expect(history?.status).toBe('completed');
    expect(history?.probes).toBe(first.probesRun);
    expect(history?.rounds).toBe(firstRounds);
    expect(history?.batchSizes).toEqual(manifest?.batchSizes);
    expect(history?.effectiveSequentialRounds).toBe(manifest?.effectiveSequentialRounds);
    // The history carries realized values only: no planned-grid fields exist.
    expect(history).not.toHaveProperty('gridPlan');
    expect(history).not.toHaveProperty('maxWidth');
    expect(history).not.toHaveProperty('budget');
    // The previous cycle's actuals are observable in diagnostics.
    expect(second.diagnostics.join(' ')).toContain('live-cycle: previous run ' + first.runId);
    expect(second.diagnostics.join(' ')).toContain('batchSizes=[');

    // Run 2 replaced the manifest atomically (one current file per directory)
    // with ITS OWN realized shape.
    const afterSecond = await readLiveCycleManifest(dir);
    expect(afterSecond.value?.runId).toBe(second.runId);
    expect(afterSecond.value?.status).toBe('completed');
    expect(afterSecond.value?.probes).toBe(second.probesRun);
    expect(
      (afterSecond.value?.batchSizes ?? []).reduce((total, size) => total + size, 0)
    ).toBe(second.probesRun - 1);
  });

  it('bounds run 2 plan sizing by the previous realized shape (cross-round behavior difference)', async () => {
    const dir = await tempDir('sizing');
    // A WIDE policy: without history the plan is depth 3 with a budget well
    // above the seeded realized 2 (budgetRemaining = rolloutBudget 8).
    const policy = makeLiveCycleRecordingPolicy({ maxWidth: 4, maxDepth: 3 });
    const harness = buildE2E({
      maxWidth: 4,
      maxDepth: 3,
      rolloutBudget: 8,
      extra: { deps: { policy, liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 } }
    });
    const first = await harness.plugin.run({
      sessionId: 'sess-live-cycle-sizing-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    const plan1 = harness.plugin.orchestrator.lastPlan() as SearchGridPlan;
    expect(plan1.maxDepth).toBe(3);
    expect(plan1.budget).toBeGreaterThan(2);

    // Overwrite the record with a KNOWN realized shape (reference + one batch
    // of 2 in one sequential round). The orchestrator's read path is the real
    // one; the seeded content only pins the numbers the sizing must respect.
    const onDisk = await readLiveCycleManifest(dir);
    expect(onDisk.value).toBeDefined();
    await writeLiveCycleManifest(dir, {
      runId: 'seeded-realized',
      status: 'completed',
      recordedAt: (onDisk.value?.endedAt ?? 0) + 1,
      startedAt: (onDisk.value?.startedAt ?? 0) + 1,
      endedAt: (onDisk.value?.endedAt ?? 0) + 1,
      stopReason: 'first_success',
      outcome: 'composed',
      taskId: 'task-live-cycle',
      sessionId: 'sess-live-cycle-sizing-1',
      gridPlan: null,
      probes: 3,
      rounds: 1,
      batchSizes: [2],
      effectiveSequentialRounds: 1
    });

    const second = await harness.plugin.run({
      sessionId: 'sess-live-cycle-sizing-2',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(second.outcome).toBe('composed');
    // plan_grid received exactly the seeded realized record.
    const history = policy.planGridRequests.at(-1)?.previousLiveCycle;
    expect(history?.runId).toBe('seeded-realized');
    expect(history?.batchSizes).toEqual([2]);
    expect(history?.effectiveSequentialRounds).toBe(1);
    // ...and the plan is NARROWED to it: width by the realized batch,
    // depth by the realized sequential rounds, budget by realized probes.
    const plan2 = harness.plugin.orchestrator.lastPlan() as SearchGridPlan;
    expect(plan2.maxWidth).toBe(2);
    expect(plan2.maxDepth).toBe(1);
    expect(plan2.budget).toBe(2);
    // cross-round behavior difference: the same task now plans a strictly
    // smaller search than the history-less first plan.
    expect(plan2.budget).toBeLessThan(plan1.budget);
    expect(plan2.maxDepth).toBeLessThan(plan1.maxDepth);
  });

  it('marks a failed cycle failed with its realized prefix, never a fabricated success', async () => {
    const dir = await tempDir('failed');
    const harness = buildE2E({
      extra: {
        deps: {
          liveCycleDataDir: dir,
          dreamMinVerifiedTrees: 0,
          reflector: {
            reflect: async () => {
              throw new Error('reflect exploded');
            }
          }
        }
      }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-live-cycle-failed',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(result.outcome).toBe('failed');
    expect(result.diagnostics.join(' ')).toContain('lifecycle failed');

    const read = await readLiveCycleManifest(dir);
    const manifest = read.value;
    expect(read.diagnostics).toEqual([]);
    expect(manifest?.status).toBe('failed');
    expect(manifest?.runId).toBe(result.runId);
    expect(manifest?.outcome).toBe('failed');
    // The realized probe count is untouched by the crash.
    expect(manifest?.probes).toBe(result.probesRun);
    // Rounds that fully committed keep their realized size (facts, not zeros);
    // their sum stays below probesRun because the reference anchor and the
    // crashed tail are probe accounting, never batch entries.
    expect(manifest?.batchSizes).not.toBeNull();
    expect((manifest?.batchSizes ?? []).reduce((total, size) => total + size, 0)).toBeLessThan(
      result.probesRun
    );
    // Planning had completed before the crash: the recorded gridPlan is the
    // actual plan (present, not a fabricated null), and the stop reason mirrors
    // the loop's real terminal fact (not the pre-loop 'not_started' sentinel).
    expect(manifest?.gridPlan).not.toBeNull();
    expect(manifest?.stopReason).toBe((result.metadata as { stopReason?: string }).stopReason);
  });

  it('refuses a stale write so an older cycle never overwrites a newer record', async () => {
    const dir = await tempDir('ordering');
    const harness = buildE2E({
      extra: { deps: { liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 } }
    });
    const first = await harness.plugin.run({
      sessionId: 'sess-live-cycle-order-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    const onDisk = await readLiveCycleManifest(dir);
    expect(onDisk.value).toBeDefined();
    // A cycle that completed LATER (same clock axis, larger endedAt) is already
    // recorded. The next run of a DIFFERENT assembly whose clock sits strictly
    // below that record must refuse its write instead of regressing the file -
    // this is the "old cycle never overwrites a newer record" guard, exercised
    // through the real write path.
    await writeLiveCycleManifest(dir, {
      ...(onDisk.value as NonNullable<typeof onDisk.value>),
      runId: 'newer-cycle',
      recordedAt: (onDisk.value?.recordedAt ?? 0) + 10_000,
      startedAt: (onDisk.value?.startedAt ?? 0) + 10_000,
      endedAt: (onDisk.value?.endedAt ?? 0) + 10_000
    });
    const stale = buildE2E({
      extra: {
        deps: { liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 },
        // Pin the orchestrator clock BELOW the newer record so this run's
        // completion is strictly earlier than what is already recorded.
        now: (): number => 1
      }
    });
    const result = await stale.plugin.run({
      sessionId: 'sess-live-cycle-order-2',
      task: liveCycleTask(stale),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(result.diagnostics.join(' ')).toContain('refused a stale manifest write');
    const survived = await readLiveCycleManifest(dir);
    expect(survived.value?.runId).toBe('newer-cycle');
  });

  it('degrades to no-history when the manifest is corrupt and the run is not blocked', async () => {
    const dir = await tempDir('corrupt');
    const policy = makeLiveCycleRecordingPolicy();
    const harness = buildE2E({
      extra: { deps: { policy, liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 } }
    });
    await harness.plugin.run({
      sessionId: 'sess-live-cycle-corrupt-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    // Corrupt the record between cycles.
    await fs.writeFile(liveCycleManifestPath(dir), '{"schemaVersion":1,"runId":"trunca', 'utf8');

    const second = await harness.plugin.run({
      sessionId: 'sess-live-cycle-corrupt-2',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    // The damaged read degraded to diagnostics; the run itself is unaffected.
    expect(second.outcome).toBe('composed');
    expect(policy.planGridRequests.at(-1)?.previousLiveCycle).toBeUndefined();
    expect(second.diagnostics.join(' ')).toContain('live-cycle:');
    // The corrupted file was quarantined and the fresh cycle re-recorded.
    const after = await readLiveCycleManifest(dir);
    expect(after.value?.runId).toBe(second.runId);
  });

  it('does not let a skip cycle clobber the last realized record', async () => {
    const dir = await tempDir('skip');
    const policy = makeLiveCycleRecordingPolicy();
    const harness = buildE2E({
      extra: { deps: { policy, liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 } }
    });
    await harness.plugin.run({
      sessionId: 'sess-live-cycle-skip-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    const before = await fs.readFile(liveCycleManifestPath(dir), 'utf8');

    // A dry run completes plan_grid but runs no cycle: nothing to record, and
    // the last REAL cycle's record must survive byte for byte.
    const dry = await harness.plugin.run({
      sessionId: 'sess-live-cycle-skip-2',
      task: liveCycleTask(harness),
      trigger: 'always',
      dryRun: true
    });
    expect(dry.outcome).toBe('no_probe');
    // plan_grid still saw the previous cycle's history (context), but nothing
    // was overwritten on disk.
    expect(policy.planGridRequests.at(-1)?.previousLiveCycle).not.toBeUndefined();
    expect(await fs.readFile(liveCycleManifestPath(dir), 'utf8')).toBe(before);
  });

  it('keeps the lifecycle byte-identical when no liveCycleDataDir is wired', async () => {
    const policy = makeLiveCycleRecordingPolicy();
    const harness = buildE2E({ extra: { deps: { policy, dreamMinVerifiedTrees: 0 } } });
    const result = await harness.plugin.run({
      sessionId: 'sess-live-cycle-unwired',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(policy.planGridRequests[0]?.previousLiveCycle).toBeUndefined();
    expect(result.diagnostics.join(' ')).not.toContain('live-cycle:');
  });

  it('wires the manifest seam from persistence.dataDir through the plugin entrypoint', async () => {
    const root = await tempDir('persistence-wiring');
    const persistence = await createPersistenceRuntime({ dataDir: root, maxTrees: 100 });
    const harness = buildE2E({ extra: { persistence, deps: { dreamMinVerifiedTrees: 0 } } });
    try {
      const result = await harness.plugin.run({
        sessionId: 'sess-live-cycle-persistence',
        task: liveCycleTask(harness),
        trigger: 'always'
      });
      expect(result.outcome).toBe('composed');
      // The injected seam is the runtime's resolved directory; the manifest
      // written by the run is readable from exactly there - no second-process
      // data involved.
      const read = await readLiveCycleManifest(persistence.dataDir);
      expect(read.existed).toBe(true);
      expect(read.value?.runId).toBe(result.runId);
      expect(read.value?.status).toBe('completed');
    } finally {
      await harness.plugin.dispose().catch(() => undefined);
      await persistence.dispose().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// rev8 P2 (cross-task ownership): the manifest is ONE file per data directory
// shared by every task of a deployment (the MCP entrypoint derives a distinct
// taskId per prompt), so a record that belongs to ANOTHER task - or a legacy
// record without any task identity - must never enter this task's planner.
// The worst case is the zero-search record (probes<=1, zero rounds): without
// the ownership gate it would turn every unrelated task into no_probe.
// All tests here drive the REAL orchestrator read path (plan_grid through the
// plugin entrypoint) against a real seeded data directory.
// ---------------------------------------------------------------------------
describe('live-cycle manifest cross-task ownership (rev8 P2)', () => {
  const tempDirs: string[] = [];

  async function tempDir(label: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cycle-ownership-' + label + '-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /** Wide-policy harness whose plan_grid requests/results are recorded. */
  async function ownershipHarness(dir: string) {
    const policy = makeLiveCycleRecordingPolicy({ maxWidth: 4, maxDepth: 3 });
    const harness = buildE2E({
      maxWidth: 4,
      maxDepth: 3,
      rolloutBudget: 8,
      extra: { deps: { policy, liveCycleDataDir: dir, dreamMinVerifiedTrees: 0 } }
    });
    return { policy, harness };
  }

  it('never skips or narrows on a DIFFERENT task zero-search record', async () => {
    const dir = await tempDir('foreign-empty');
    const { policy, harness } = await ownershipHarness(dir);
    // The record that must NOT leak across tasks: a COMPLETED zero-search
    // cycle owned by another task (rounds=0, at most the reference probe).
    // Without ownership this is exactly the shape that sets skipProbing.
    await writeLiveCycleManifest(dir, {
      runId: 'foreign-zero-search',
      status: 'completed',
      recordedAt: 1,
      startedAt: 1,
      endedAt: 1,
      stopReason: 'first_success',
      outcome: 'composed',
      taskId: 'task-live-cycle-OTHER',
      sessionId: 'sess-foreign',
      gridPlan: null,
      probes: 1,
      rounds: 0,
      batchSizes: [],
      effectiveSequentialRounds: 0
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-ownership-foreign-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });

    // The run is NOT skipped: a foreign "no search needed" is not evidence
    // about THIS task.
    expect(result.outcome).toBe('composed');
    expect(result.diagnostics.join(' ')).not.toContain('plan_grid decided to skip probing');
    // The foreign record was filtered at the read and named in diagnostics
    // (without echoing the foreign task id).
    expect(policy.planGridRequests[0]?.task.id).toBe('task-live-cycle');
    expect(policy.planGridRequests[0]?.previousLiveCycle).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain(
      'live-cycle: the previous manifest was recorded for a different task'
    );
    // The plan keeps the full policy shape (not the narrowed 2/1/2 a
    // narrowing-shaped foreign record would produce either).
    const plan = harness.plugin.orchestrator.lastPlan() as SearchGridPlan;
    // The un-narrowed no-history plan under this policy (recall confidence
    // 0.5 discounts width to 3, matching the existing sizing test's baseline);
    // a leaked history would clamp width to <=2 / depth to 1.
    expect(plan.maxWidth).toBeGreaterThan(2);
    expect(plan.maxDepth).toBe(3);
    expect(plan.budget).toBeGreaterThan(2);
    // Stale protection is untouched by the gate: the foreign record still
    // seeded the ledger (recordedAt=1 < this run's clock), the run's own
    // write was accepted, and the directory now holds THIS task's record.
    expect(result.diagnostics.join(' ')).not.toContain('refused a stale manifest write');
    const after = await readLiveCycleManifest(dir);
    expect(after.value?.runId).toBe(result.runId);
    expect(after.value?.taskId).toBe('task-live-cycle');
  });

  it('never narrows on a DIFFERENT task narrowing-shaped record either', async () => {
    const dir = await tempDir('foreign-narrow');
    const { policy, harness } = await ownershipHarness(dir);
    // Another task's realized 2-candidate/1-round cycle: would clamp this
    // plan to 2/1/2 if ownership were ignored.
    await writeLiveCycleManifest(dir, {
      runId: 'foreign-narrowing',
      status: 'completed',
      recordedAt: 1,
      startedAt: 1,
      endedAt: 1,
      stopReason: 'first_success',
      outcome: 'composed',
      taskId: 'task-live-cycle-OTHER',
      sessionId: 'sess-foreign',
      gridPlan: null,
      probes: 3,
      rounds: 1,
      batchSizes: [2],
      effectiveSequentialRounds: 1
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-ownership-foreign-2',
      task: liveCycleTask(harness),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(policy.planGridRequests[0]?.previousLiveCycle).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain(
      'live-cycle: the previous manifest was recorded for a different task'
    );
    const plan = harness.plugin.orchestrator.lastPlan() as SearchGridPlan;
    // The un-narrowed no-history plan under this policy (recall confidence
    // 0.5 discounts width to 3, matching the existing sizing test's baseline);
    // a leaked history would clamp width to <=2 / depth to 1.
    expect(plan.maxWidth).toBeGreaterThan(2);
    expect(plan.maxDepth).toBe(3);
    expect(plan.budget).toBeGreaterThan(2);
  });

  it('still skips on the SAME task zero-search record (ownership gate is not over-broad)', async () => {
    const dir = await tempDir('same-empty');
    const { policy, harness } = await ownershipHarness(dir);
    await writeLiveCycleManifest(dir, {
      runId: 'same-zero-search',
      status: 'completed',
      recordedAt: 1,
      startedAt: 1,
      endedAt: 1,
      stopReason: 'first_success',
      outcome: 'composed',
      taskId: 'task-live-cycle',
      sessionId: 'sess-same-task',
      gridPlan: null,
      probes: 1,
      rounds: 0,
      batchSizes: [],
      effectiveSequentialRounds: 0
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-ownership-same-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });

    // Same task + completed zero-search realized shape -> the skip stands.
    expect(result.outcome).toBe('no_probe');
    expect(result.diagnostics.join(' ')).toContain('plan_grid decided to skip probing');
    // The same-task record DID enter the planner, carrying its (additively
    // projected) taskId.
    const history = policy.planGridRequests[0]?.previousLiveCycle;
    expect(history).toBeDefined();
    expect(history?.runId).toBe('same-zero-search');
    expect(history?.taskId).toBe('task-live-cycle');
    // A skip cycle records nothing: the seeded record survives untouched.
    const after = await readLiveCycleManifest(dir);
    expect(after.value?.runId).toBe('same-zero-search');
  });

  it('treats a legacy record without task identity as no history - never skip, never narrow', async () => {
    const dir = await tempDir('legacy');
    const { policy, harness } = await ownershipHarness(dir);
    // Worst-case legacy record: zero-search completed cycle WITHOUT taskId.
    // The write path always records taskId, so identity is only ever missing
    // on records this code did not write; they participate in nothing.
    await writeLiveCycleManifest(dir, {
      runId: 'legacy-no-identity',
      status: 'completed',
      recordedAt: 1,
      startedAt: 1,
      endedAt: 1,
      stopReason: 'first_success',
      outcome: 'composed',
      sessionId: 'sess-legacy',
      gridPlan: null,
      probes: 1,
      rounds: 0,
      batchSizes: [],
      effectiveSequentialRounds: 0
    });

    const first = await harness.plugin.run({
      sessionId: 'sess-ownership-legacy-1',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    expect(first.diagnostics.join(' ')).not.toContain('plan_grid decided to skip probing');
    expect(policy.planGridRequests[0]?.previousLiveCycle).toBeUndefined();
    expect(first.diagnostics.join(' ')).toContain(
      'live-cycle: the previous manifest carries no task identity'
    );
    const plan1 = harness.plugin.orchestrator.lastPlan() as SearchGridPlan;
    // Un-narrowed baseline (see the foreign tests above): a leaked legacy
    // history would clamp width to <=2 / depth to 1.
    expect(plan1.maxWidth).toBeGreaterThan(2);
    expect(plan1.maxDepth).toBe(3);
    // The run re-recorded the directory with ITS OWN identified record.
    const afterFirst = await readLiveCycleManifest(dir);
    expect(afterFirst.value?.runId).toBe(first.runId);
    expect(afterFirst.value?.taskId).toBe('task-live-cycle');

    // Same for a legacy NARROWING shape: identity-less means no sizing.
    await writeLiveCycleManifest(dir, {
      runId: 'legacy-narrowing',
      status: 'completed',
      recordedAt: 1,
      startedAt: 1,
      endedAt: 1,
      stopReason: 'first_success',
      outcome: 'composed',
      sessionId: 'sess-legacy',
      gridPlan: null,
      probes: 3,
      rounds: 1,
      batchSizes: [2],
      effectiveSequentialRounds: 1
    });
    const second = await harness.plugin.run({
      sessionId: 'sess-ownership-legacy-2',
      task: liveCycleTask(harness),
      trigger: 'always'
    });
    expect(second.outcome).toBe('composed');
    expect(policy.planGridRequests[1]?.previousLiveCycle).toBeUndefined();
    expect(second.diagnostics.join(' ')).toContain(
      'live-cycle: the previous manifest carries no task identity'
    );
    const plan2 = harness.plugin.orchestrator.lastPlan() as SearchGridPlan;
    expect(plan2.maxWidth).toBeGreaterThan(2);
    expect(plan2.maxDepth).toBe(3);
    expect(plan2.budget).toBeGreaterThan(2);
  });
});
