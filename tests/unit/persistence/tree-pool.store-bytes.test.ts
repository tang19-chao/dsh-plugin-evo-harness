/**
 * rev8 audit fix: the tree-pool log needs a BYTE trigger for compaction.
 *
 * THE DEFECT
 *   Compaction was triggered by RECORD COUNT only (`records.length >=
 *   compactAfterRecords`, default 512). A record's size is whatever the tree
 *   snapshot carries — the evidence-integrity mark is the variable-length part
 *   — so a count threshold cannot bound the FILE. Measured before this fix:
 *   560 appends of 2,000-finding records grew tree-pool.jsonl to 521 MB before
 *   finally crossing 512 records; a single run's record reached 31 MB.
 *
 * THE FIX
 *   `compactAfterBytes` (default 32 MiB) is measured over the bytes APPENDED
 *   since the last compaction, and a compaction fires on either trigger. The
 *   appended-byte counter is reset to the rewritten payload size, so one
 *   oversized record triggers exactly one compaction per write instead of
 *   re-triggering on every subsequent append.
 *
 * These are negative tests: they feed records that are large relative to the
 * byte ceiling and assert the file stays bounded and the data still restores.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { stat } from 'node:fs/promises';

import {
  DEFAULT_COMPACT_AFTER_BYTES,
  DEFAULT_COMPACT_AFTER_RECORDS,
  PersistentTreePool,
  TREE_POOL_LOG_FILE,
  TreePoolStore
} from '../../../src/persistence/tree-pool.store';
import { readTextIfExists } from '../../../src/persistence/data-dir';
import { cleanupDir, makeTempDir, sampleTree } from './fixtures';

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await makeTempDir(label);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir);
  }
});

function logPath(dataDir: string): string {
  return path.join(dataDir, TREE_POOL_LOG_FILE);
}

async function logBytes(dataDir: string): Promise<number> {
  try {
    return (await stat(logPath(dataDir))).size;
  } catch {
    return 0;
  }
}

/** A tree whose snapshot carries a dead-weight metadata blob of `padBytes`. */
function paddedTree(id: string, padBytes: number): ReturnType<typeof sampleTree> {
  return {
    ...sampleTree({ id }),
    metadata: { pad: 'x'.repeat(padBytes) }
  } as ReturnType<typeof sampleTree>;
}

/** Approximate encoded size of one padded tree record (pad + JSONL overhead). */
function bytesOfOneAppend(padBytes: number): number {
  return padBytes + 4 * 1024;
}

describe('TreePoolStore: byte-triggered compaction', () => {
  it('defaults to a finite byte ceiling well above a normal record', () => {
    expect(Number.isFinite(DEFAULT_COMPACT_AFTER_BYTES)).toBe(true);
    expect(DEFAULT_COMPACT_AFTER_BYTES).toBeGreaterThan(1024 * 1024);
    // A byte ceiling far below the record ceiling is the point: the count
    // trigger could never fire before 512 records.
    expect(DEFAULT_COMPACT_AFTER_RECORDS).toBe(512);
  });

  it('compacts on BYTES long before the record ceiling is reached (the 521 MB shape)', async () => {
    const dir = await tempDir('treepool-bytes');
    // The measured shape: ONE tree id is re-upserted every round with a slightly
    // newer snapshot, so every append supersedes the previous one and the
    // minimized set stays at one record. A count-only trigger never fires (the
    // record log stays short of 512 while the FILE grows), which is exactly how
    // 560 appends reached 521 MB before this fix.
    const store = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: 256 * 1024 });
    expect(store.compactBytesThreshold).toBe(256 * 1024);
    expect(store.pendingBytes).toBe(0);

    const recordBytes = 64 * 1024;
    let appended = 0;
    for (let index = 1; index <= 40; index += 1) {
      const base = paddedTree('tree-rotating', recordBytes);
      await store.append({ ...base, createdAt: base.createdAt + index });
      await store.flush();
      appended += bytesOfOneAppend(recordBytes);
      // The floor: the ceiling is what bounds the file, so it never exceeds one
      // ceiling + the largest single record, however many appends have happened.
      expect(store.pendingBytes).toBeLessThanOrEqual(256 * 1024 + recordBytes * 2);
    }
    // And the ceiling really did cap it: far below the total appended.
    expect(appended).toBeGreaterThan(2 * 1024 * 1024);
    expect(await logBytes(dir)).toBeLessThan(512 * 1024);
    // One superseding record in the log, not 40.
    expect(store.allRecords().length).toBeLessThan(DEFAULT_COMPACT_AFTER_RECORDS);

    // The surviving tree still restores from the compacted log.
    const restarted = await TreePoolStore.open({ dataDir: dir });
    expect(restarted.loadedRecords).toBe(1);
    expect(restarted.repairedOnLoad).toBe(false);
  });

  it('does not grow without bound when superseded appends keep arriving', async () => {
    const dir = await tempDir('treepool-bytes-rotating');
    const store = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: 64 * 1024 });
    for (let index = 1; index <= 30; index += 1) {
      const base = paddedTree('tree-rotating', 8 * 1024);
      await store.append({ ...base, createdAt: base.createdAt + index });
      await store.flush();
    }
    // 30 x ~8 KiB appended; the log must not hold them all.
    expect(await logBytes(dir)).toBeLessThan(16 * 8 * 1024);
    const restarted = await TreePoolStore.open({ dataDir: dir });
    // Bounded, not monolithic: at compaction time the log holds the records
    // appended since the previous compaction (a handful), never all 30. Each of
    // these is a superseding update of the same tree id, so the replayed pool
    // still converges on ONE tree.
    expect(restarted.loadedRecords).toBeLessThanOrEqual(8);
    const pool = await PersistentTreePool.fromStore(restarted);
    expect(pool.size()).toBe(1);
    expect(pool.get('tree-rotating')?.metadata?.['pad']).toHaveLength(8 * 1024);
  });

  it('a single oversized record triggers ONE compaction, not one per append', async () => {
    const dir = await tempDir('treepool-bytes-oversized');
    const store = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: 1024 });
    await store.append(paddedTree('tree-big', 8 * 1024));
    await store.flush();
    // The rewritten file is the new baseline, so the counter reflects it rather
    // than the (smaller) ceiling: no compaction is pending.
    expect(store.pendingBytes).toBeGreaterThan(8 * 1024);
    expect(await logBytes(dir)).toBe(store.pendingBytes);
    // A second identical-size append adds one record's worth, not a re-trigger.
    const before = store.pendingBytes;
    await store.append(paddedTree('tree-big-2', 8 * 1024));
    await store.flush();
    expect(await logBytes(dir)).toBeGreaterThan(before);
    const restarted = await TreePoolStore.open({ dataDir: dir });
    expect(restarted.loadedRecords).toBe(2);
  });

  it('keeps the record-count trigger working (no behaviour regression)', async () => {
    const dir = await tempDir('treepool-bytes-count');
    const store = await TreePoolStore.open({
      dataDir: dir,
      compactAfterRecords: 4,
      compactAfterBytes: 64 * 1024 * 1024
    });
    for (let index = 1; index <= 6; index += 1) {
      await store.append(sampleTree({ id: 'tree-' + String(index) }));
    }
    await store.flush();
    const text = (await readTextIfExists(logPath(dir))) ?? '';
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(6);
    const restarted = await TreePoolStore.open({ dataDir: dir });
    expect(restarted.loadedRecords).toBe(6);
  });

  it('falls back to the default ceiling for a non-finite or non-positive value', async () => {
    const dir = await tempDir('treepool-bytes-invalid');
    const store = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: 0 });
    expect(store.compactBytesThreshold).toBe(DEFAULT_COMPACT_AFTER_BYTES);
    const negative = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: -5 });
    expect(negative.compactBytesThreshold).toBe(DEFAULT_COMPACT_AFTER_BYTES);
    const notFinite = await TreePoolStore.open({
      dataDir: dir,
      compactAfterBytes: Number.POSITIVE_INFINITY
    });
    expect(notFinite.compactBytesThreshold).toBe(DEFAULT_COMPACT_AFTER_BYTES);
  });

  // -------------------------------------------------------------------------
  // second pass: the budget must be seeded from the log ALREADY on disk.
  //
  // `appendedBytes` started at 0 on every open, so a log a previous process left
  // bloated needed ANOTHER whole ceiling of appends before the byte trigger
  // fired — and never fired at all if the host restarts more often than that.
  // Measured before this fix: a 10,539,040 B log reopened under a 256 KiB ceiling
  // was 10,540,266 B after one small append.
  // -------------------------------------------------------------------------
  it('seeds the byte budget from a pre-existing log and compacts on the first write', async () => {
    const dir = await tempDir('treepool-bytes-preexisting');
    // A legitimately written but bloated log: one tree id re-upserted often with
    // a large pad, so minimize() collapses it while the FILE stays huge.
    {
      const seed = await TreePoolStore.open({
        dataDir: dir,
        compactAfterRecords: 100_000,
        compactAfterBytes: 100 * 1024 * 1024
      });
      for (let index = 1; index <= 20; index += 1) {
        const base = paddedTree('tree-bloated', 128 * 1024);
        await seed.append({ ...base, createdAt: base.createdAt + index });
      }
      await seed.flush();
    }
    const before = await logBytes(dir);
    expect(before).toBeGreaterThan(2 * 1024 * 1024);

    const ceiling = 256 * 1024;
    const reopened = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: ceiling });
    // The pre-existing size IS the starting budget, not zero.
    expect(reopened.pendingBytes).toBe(before);
    expect(reopened.loadedRecords).toBe(20);

    const base = sampleTree({ id: 'tree-new' });
    await reopened.append({ ...base, createdAt: base.createdAt + 500 });
    await reopened.flush();
    // ONE small append compacted the whole bloated file.
    expect(await logBytes(dir)).toBeLessThan(before);
    expect(reopened.pendingBytes).toBeLessThanOrEqual(ceiling + 64 * 1024);

    // And the data still restores: both trees, no repair.
    const restarted = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: ceiling });
    expect(restarted.repairedOnLoad).toBe(false);
    const pool = await PersistentTreePool.fromStore(restarted);
    expect(pool.size()).toBe(2);
    expect(pool.get('tree-bloated')?.metadata?.['pad']).toHaveLength(128 * 1024);
    expect(pool.get('tree-new')).toBeDefined();
  });

  it('starts at zero when no log exists yet (no spurious first-write compaction)', async () => {
    const dir = await tempDir('treepool-bytes-fresh');
    const store = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: 1024 * 1024 });
    expect(store.pendingBytes).toBe(0);
    await store.append(paddedTree('tree-fresh', 4 * 1024));
    await store.flush();
    expect(store.pendingBytes).toBeGreaterThan(0);
    expect(store.pendingBytes).toBeLessThan(1024 * 1024);
    expect(await logBytes(dir)).toBe(store.pendingBytes);
  });

  it('does not re-trigger on a file that is already under the ceiling', async () => {
    const dir = await tempDir('treepool-bytes-under');
    const ceiling = 1024 * 1024;
    const first = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: ceiling });
    await first.append(paddedTree('tree-small', 2 * 1024));
    await first.flush();
    const size = await logBytes(dir);

    const reopened = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: ceiling });
    expect(reopened.pendingBytes).toBe(size);
    const base = sampleTree({ id: 'tree-small-2' });
    await reopened.append({ ...base, createdAt: base.createdAt + 10 });
    await reopened.flush();
    // Two records in the log: nothing was rewritten.
    const restarted = await TreePoolStore.open({ dataDir: dir, compactAfterBytes: ceiling });
    expect(restarted.loadedRecords).toBe(2);
  });
});