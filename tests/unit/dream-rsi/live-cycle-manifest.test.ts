/**
 * rev8 plan §6.1 item 3: tests for the live-cycle-manifest port.
 *
 * WHAT THIS SUITE MUST PROVE
 * --------------------------
 *   W-1  Atomic durable write: the manifest lands in the GIVEN data directory
 *        (created on demand), and only there; no temp debris survives the
 *        write (writeFileAtomic's own contract, asserted from the caller's
 *        side). No `work/` path is involved anywhere - the temp roots live
 *        under os.tmpdir() because
 *        tests/unit/meta/no-work-dependency.test.ts allowlists repo-root
 *        work/ writes to exactly four other files.
 *   W-2  Unknown facts stay unknown: omitted/null inputs persist as explicit
 *        `null` (never a plausible 0), and a skipProbing cycle's empty batch
 *        list round-trips as `[]` - the known-empty case stays distinguishable
 *        from unknown.
 *   W-3  Fail-closed validation: a structurally invalid input throws
 *        PersistenceError('invalid_manifest') BEFORE any byte is written, so a
 *        caller bug can never clobber the previous cycle's manifest.
 *   W-4  The previous manifest is REPLACED atomically (one file per data
 *        directory, newest cycle wins), matching the "current file" design;
 *        the tolerant reader recovers from damage by quarantining instead of
 *        throwing, and a missing file is `existed: false`.
 *   W-5  Additive contract survival: a SearchGridPlan carrying an EXTRA
 *        (future) field round-trips verbatim - the reader must not strip
 *        fields it does not know.
 *   E-1  `effectiveSequentialRoundsOf` reproduces the upstream arithmetic
 *        (`env/trace_env.py:259-269`): ceil(size/workers) per non-empty batch,
 *        empty batches skipped, workers floored at 1.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PersistenceError, sweepTempFiles } from '../../../src/persistence/data-dir';
import {
  LIVE_CYCLE_MANIFEST_FILE,
  LIVE_CYCLE_MANIFEST_SCHEMA_VERSION,
  effectiveSequentialRoundsOf,
  liveCycleManifestPath,
  parseLiveCycleManifest,
  readLiveCycleManifest,
  writeLiveCycleManifest
} from '../../../src/dream-rsi/live-cycle-manifest';
import type { SearchGridPlan } from '../../../src/types/contracts';

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  // os.tmpdir(), NOT the repo's work/ scratch root: the repo-root work/ write
  // allowlist is pinned by the no-work-dependency gate and must not grow.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-cycle-manifest-' + label + '-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function gridPlan(overrides: Partial<SearchGridPlan> = {}): SearchGridPlan {
  return {
    maxWidth: 3,
    maxDepth: 2,
    budget: 6,
    skipProbing: false,
    stopCondition: 'budget_exhausted',
    complexity: 'moderate',
    rationale: 'test grid',
    policyId: 'pi-1',
    ...overrides
  };
}

const baseInput = {
  runId: 'run-1',
  status: 'completed' as const,
  recordedAt: 1_700_000_000_000,
  startedAt: 1_699_999_990_000,
  endedAt: 1_700_000_000_000,
  stopReason: 'first_success',
  outcome: 'composed',
  taskId: 'task-1',
  sessionId: 'session-1',
  gridPlan: gridPlan(),
  probes: 5,
  rounds: 2,
  batchSizes: [2, 2],
  effectiveSequentialRounds: 3
};

describe('W-1: the write lands atomically in the given data directory only', () => {
  it('creates the directory, writes the file, and leaves no temp debris', async () => {
    const dir = await tempDir('write');
    const nested = path.join(dir, 'profiles', 'default');
    const { path: written, manifest } = await writeLiveCycleManifest(nested, baseInput);
    expect(written).toBe(liveCycleManifestPath(nested));
    expect(manifest.runId).toBe('run-1');
    const text = await fs.readFile(written, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBe(LIVE_CYCLE_MANIFEST_SCHEMA_VERSION);
    expect(parsed['runId']).toBe('run-1');
    // writeFileAtomic contract from the caller's side: exactly one file in the
    // directory (the manifest), no leftover '<name>.tmp-<pid>-<hex>' sibling.
    expect(await sweepTempFiles(nested)).toEqual([]);
    const entries = await fs.readdir(nested);
    expect(entries).toEqual([LIVE_CYCLE_MANIFEST_FILE]);
  });

  it('only ever writes inside the given directory (the path is dataDir + fixed file name)', async () => {
    const dir = await tempDir('isolation');
    const other = path.join(dir, 'unrelated');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'keep.txt'), 'untouched', 'utf8');
    await writeLiveCycleManifest(path.join(dir, 'data'), baseInput);
    // The sibling directory is untouched by the write.
    expect(await fs.readFile(path.join(other, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(await fs.readdir(path.join(dir, 'data'))).toEqual([LIVE_CYCLE_MANIFEST_FILE]);
  });
});

describe('W-2: unknown facts stay unknown, known-empty stays empty', () => {
  it('persists omitted optional facts as explicit nulls', async () => {
    const dir = await tempDir('unknowns');
    const { manifest } = await writeLiveCycleManifest(dir, {
      runId: 'run-sparse',
      status: 'failed',
      recordedAt: 1_700_000_000_000
    });
    expect(manifest.gridPlan).toBeNull();
    expect(manifest.probes).toBeNull();
    expect(manifest.rounds).toBeNull();
    expect(manifest.batchSizes).toBeNull();
    expect(manifest.effectiveSequentialRounds).toBeNull();
    expect(manifest.startedAt).toBeNull();
    expect(manifest.endedAt).toBeNull();
    expect(manifest.stopReason).toBeNull();
    expect(manifest.outcome).toBeNull();
    expect(manifest).not.toHaveProperty('taskId');
    expect(manifest).not.toHaveProperty('sessionId');
    // The on-disk document carries the same explicit nulls.
    const onDisk = JSON.parse(await fs.readFile(liveCycleManifestPath(dir), 'utf8')) as Record<string, unknown>;
    expect(onDisk['gridPlan']).toBeNull();
    expect(onDisk['probes']).toBeNull();
    expect(onDisk['batchSizes']).toBeNull();
    // status is persisted as written - 'failed' is a fact, not an error path.
    expect(onDisk['status']).toBe('failed');
  });

  it('keeps a skipProbing cycle as status completed with batchSizes [] (not null)', async () => {
    const dir = await tempDir('skip');
    const { manifest } = await writeLiveCycleManifest(dir, {
      runId: 'run-skip',
      status: 'completed',
      stopReason: 'plan_grid_skip',
      outcome: 'no_probe',
      gridPlan: gridPlan({ maxWidth: 0, maxDepth: 0, budget: 0, skipProbing: true, rationale: 'skip probing' }),
      probes: 0,
      rounds: 0,
      batchSizes: [],
      effectiveSequentialRounds: 0
    });
    expect(manifest.batchSizes).toEqual([]);
    expect(manifest.probes).toBe(0);
    expect(manifest.effectiveSequentialRounds).toBe(0);
  });

  it('distinguishes batchSizes null from [] on the way back through the reader', async () => {
    const dir = await tempDir('null-vs-empty');
    await writeLiveCycleManifest(dir, { runId: 'r-unknown', status: 'unknown' });
    const unknownRead = await readLiveCycleManifest(dir);
    expect(unknownRead.value?.batchSizes).toBeNull();
    await writeLiveCycleManifest(dir, { runId: 'r-empty', status: 'completed', batchSizes: [] });
    const emptyRead = await readLiveCycleManifest(dir);
    expect(emptyRead.value?.batchSizes).toEqual([]);
  });
});

describe('W-3: invalid input is rejected BEFORE any byte is written', () => {
  it.each([
    ['empty runId', { runId: '', status: 'completed' }],
    ['missing runId', { status: 'completed' }],
    ['invalid status', { runId: 'r', status: 'partial' }],
    ['negative probes', { runId: 'r', status: 'completed', probes: -1 }],
    ['non-integer rounds', { runId: 'r', status: 'completed', rounds: 1.5 }],
    ['bad batchSizes entry', { runId: 'r', status: 'completed', batchSizes: [1, -2] }],
    ['non-array batchSizes', { runId: 'r', status: 'completed', batchSizes: 'two' }],
    ['bad gridPlan shape', { runId: 'r', status: 'completed', gridPlan: { maxWidth: 'three' } }],
    ['bad stopCondition in gridPlan', {
      runId: 'r',
      status: 'completed',
      gridPlan: gridPlan({ stopCondition: 'whenever' as never })
    }],
    ['bad startedAt', { runId: 'r', status: 'completed', startedAt: 'yesterday' }],
    ['empty taskId', { runId: 'r', status: 'completed', taskId: '' }]
  ])('%s throws invalid_manifest and leaves the previous manifest intact', async (_name, bad) => {
    const dir = await tempDir('reject');
    // Seed a good manifest from the previous cycle first.
    await writeLiveCycleManifest(dir, baseInput);
    const before = await fs.readFile(liveCycleManifestPath(dir), 'utf8');
    await expect(
      writeLiveCycleManifest(dir, bad as Record<string, unknown> as typeof baseInput)
    ).rejects.toMatchObject({
      name: 'PersistenceError',
      code: 'invalid_manifest'
    });
    expect(await fs.readFile(liveCycleManifestPath(dir), 'utf8')).toBe(before);
    expect(await sweepTempFiles(dir)).toEqual([]);
  });
});

describe('W-4: one current file per data directory, replaced atomically; tolerant reads', () => {
  it('replaces the previous cycle manifest and reports the newest runId', async () => {
    const dir = await tempDir('replace');
    await writeLiveCycleManifest(dir, baseInput);
    const second = await writeLiveCycleManifest(dir, {
      ...baseInput,
      runId: 'run-2',
      probes: 9,
      batchSizes: [3, 3, 3],
      effectiveSequentialRounds: 3
    });
    expect(second.manifest.runId).toBe('run-2');
    const read = await readLiveCycleManifest(dir);
    expect(read.value?.runId).toBe('run-2');
    expect(read.value?.probes).toBe(9);
    expect(read.value?.batchSizes).toEqual([3, 3, 3]);
    // Still exactly one file - the old cycle was replaced, not appended.
    expect(await fs.readdir(dir)).toEqual([LIVE_CYCLE_MANIFEST_FILE]);
  });

  it('a missing file reads as existed:false, never an error', async () => {
    const dir = await tempDir('missing');
    const read = await readLiveCycleManifest(dir);
    expect(read.existed).toBe(false);
    expect(read.value).toBeUndefined();
    expect(read.diagnostics).toEqual([]);
  });

  it('a damaged file is quarantined and reported, not thrown', async () => {
    const dir = await tempDir('damaged');
    await writeLiveCycleManifest(dir, baseInput);
    const manifestPath = liveCycleManifestPath(dir);
    await fs.writeFile(manifestPath, '{"schemaVersion":1,"runId":"trunca', 'utf8');
    const read = await readLiveCycleManifest(dir);
    expect(read.value).toBeUndefined();
    expect(read.existed).toBe(true);
    expect(read.quarantinedPath).toBeDefined();
    expect(read.diagnostics.length).toBeGreaterThan(0);
    expect(read.diagnostics[0]).toContain('quarantined');
    // The original bytes survive for postmortem.
    expect(await fs.readFile(read.quarantinedPath as string, 'utf8')).toContain('trunca');
  });

  it('a structurally wrong (parseable) document fails schema validation, quarantined too', async () => {
    const dir = await tempDir('schema-bad');
    await writeLiveCycleManifest(dir, baseInput);
    await fs.writeFile(
      liveCycleManifestPath(dir),
      JSON.stringify({ schemaVersion: 999, runId: 'x' }),
      'utf8'
    );
    const read = await readLiveCycleManifest(dir);
    expect(read.value).toBeUndefined();
    expect(read.quarantinedPath).toBeDefined();
    expect(read.diagnostics[0]).toContain('schema validation');
  });

  it('parseLiveCycleManifest accepts exactly the written document', async () => {
    const dir = await tempDir('parse-canonical');
    const { manifest, path: written } = await writeLiveCycleManifest(dir, baseInput);
    // The canonical written record (schemaVersion included) parses back equal.
    const onDisk = JSON.parse(await fs.readFile(written, 'utf8')) as unknown;
    expect(parseLiveCycleManifest(onDisk)).toEqual(manifest);
    expect(parseLiveCycleManifest(manifest)).toEqual(manifest);
    // A writer INPUT without schemaVersion is not a document: the parser
    // validates the on-disk shape, not the writer's input shape.
    expect(parseLiveCycleManifest(baseInput)).toBeUndefined();
    expect(parseLiveCycleManifest(null)).toBeUndefined();
    expect(parseLiveCycleManifest('nope')).toBeUndefined();
    expect(parseLiveCycleManifest([])).toBeUndefined();
  });
});

describe('W-5: additive contract fields survive a write/read round trip', () => {
  it('an unknown future SearchGridPlan field is preserved verbatim', async () => {
    const dir = await tempDir('additive');
    const future = {
      ...gridPlan(),
      // A field a FUTURE contract revision might add; the manifest reader must
      // carry it through instead of stripping it (additive compatibility).
      clampReasons: ['budget_clamped']
    } as unknown as SearchGridPlan;
    await writeLiveCycleManifest(dir, { ...baseInput, gridPlan: future });
    const read = await readLiveCycleManifest(dir);
    expect((read.value?.gridPlan as unknown as Record<string, unknown>)['clampReasons']).toEqual([
      'budget_clamped'
    ]);
    // Known fields still validate.
    expect(read.value?.gridPlan?.policyId).toBe('pi-1');
  });
});

describe('E-1: effectiveSequentialRoundsOf matches the upstream arithmetic', () => {
  it('costs ceil(size/workers) per batch', () => {
    // trace_env.py:267: effective_sequential_rounds += ceil(size / workers)
    expect(effectiveSequentialRoundsOf([4], 2)).toBe(2);
    expect(effectiveSequentialRoundsOf([3], 2)).toBe(2);
    expect(effectiveSequentialRoundsOf([3, 4, 1], 2)).toBe(2 + 2 + 1);
    expect(effectiveSequentialRoundsOf([5], 16)).toBe(1);
  });

  it('skips empty batches and floors the worker count at 1', () => {
    expect(effectiveSequentialRoundsOf([], 4)).toBe(0);
    expect(effectiveSequentialRoundsOf([0, 2], 4)).toBe(1);
    expect(effectiveSequentialRoundsOf([2], 0)).toBe(2);
    expect(effectiveSequentialRoundsOf([2], -3)).toBe(2);
    expect(effectiveSequentialRoundsOf([2], Number.NaN)).toBe(2);
  });

  it('the writer never invents the number: unknown in, null out', async () => {
    const dir = await tempDir('no-invent');
    const { manifest } = await writeLiveCycleManifest(dir, {
      runId: 'r',
      status: 'completed',
      probes: 6,
      rounds: 3,
      batchSizes: [2, 2, 2]
      // effectiveSequentialRounds deliberately NOT supplied: without a worker
      // count the writer must not guess one.
    });
    expect(manifest.effectiveSequentialRounds).toBeNull();
  });
});
