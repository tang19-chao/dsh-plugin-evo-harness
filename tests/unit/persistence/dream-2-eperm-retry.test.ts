/**
 * DREAM-2: Windows rename sharing violations (EPERM/EACCES) are retried with a
 * short backoff so a transient open handle on the target cannot diverge memory
 * from disk, and the write failures the store queues swallow into diagnostics
 * stay reachable through the live persistence.diagnostics outlet.
 */
import { promises as fs, type PathLike } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPersistenceRuntime } from '../../../src/persistence';
import {
  TEMP_FILE_MARKER,
  WRITE_FILE_ATOMIC_RENAME_RETRIES,
  readTextIfExists,
  writeFileAtomic
} from '../../../src/persistence/data-dir';
import { PolicyStore } from '../../../src/persistence/policy.store';
import { TreePoolStore } from '../../../src/persistence/tree-pool.store';
import { cleanupDir, makeTempDir, samplePolicy, sampleTree } from './fixtures';

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

/** An error shaped like the one Node reports for a Windows rename violation. */
function eperm(): Error {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

interface RenamePatch {
  /** How many times rename was called while the patch was installed. */
  calls(): number;
  restore(): void;
}

/**
 * Replace fs.promises.rename (the very object src/persistence/data-dir.ts
 * holds) with a wrapper that fails the first `failures` calls with EPERM and
 * then delegates to the real rename. 'always' never delegates.
 */
function patchRename(failures: number | 'always'): RenamePatch {
  const original = fs.rename;
  let calls = 0;
  const patched = async (from: PathLike, to: PathLike): Promise<void> => {
    calls += 1;
    if (failures === 'always' || calls <= failures) {
      throw eperm();
    }
    return original(from, to);
  };
  fs.rename = patched;
  return {
    calls: (): number => calls,
    restore: (): void => {
      fs.rename = original;
    }
  };
}

describe('writeFileAtomic rename retry (DREAM-2)', () => {
  it('retries a transient EPERM rename and commits the write', async () => {
    const dir = await tempDir('eperm-retry');
    const target = path.join(dir, 'state.json');
    await writeFileAtomic(target, '{"v":1}');
    const patch = patchRename(2);
    try {
      await writeFileAtomic(target, '{"v":2}');
    } finally {
      patch.restore();
    }
    expect(patch.calls()).toBe(3);
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":2}');
    const entries = await fs.readdir(dir);
    expect(entries.some((entry) => entry.includes(TEMP_FILE_MARKER))).toBe(false);
  });

  it('gives up after the bounded retries and rethrows the sharing violation', async () => {
    const dir = await tempDir('eperm-exhausted');
    const target = path.join(dir, 'state.json');
    const patch = patchRename('always');
    try {
      await expect(writeFileAtomic(target, '{"v":1}')).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      patch.restore();
    }
    expect(patch.calls()).toBe(WRITE_FILE_ATOMIC_RENAME_RETRIES + 1);
    expect(await readTextIfExists(target)).toBeUndefined();
    // No temp debris is left behind on the exhausted path either.
    const entries = await fs.readdir(dir);
    expect(entries.some((entry) => entry.includes(TEMP_FILE_MARKER))).toBe(false);
  });

  it('recovers from a real open read handle on the target (round-2 repro)', async () => {
    const dir = await tempDir('eperm-handle');
    const target = path.join(dir, 'state.json');
    await writeFileAtomic(target, '{"v":1}');
    const handle = await fs.open(target, 'r');
    try {
      if (process.platform === 'win32') {
        // While the plain read handle is open, every rename fails with EPERM
        // (MoveFileExW cannot replace a handle-held target); the bounded retry
        // gives up and the caller sees the failure instead of a silent dive.
        await expect(writeFileAtomic(target, '{"v":2}')).rejects.toMatchObject({ code: 'EPERM' });
        expect(await fs.readFile(target, 'utf8')).toBe('{"v":1}');
      }
    } finally {
      await handle.close();
    }
    // Once the handle closes the same write succeeds — the violation is transient.
    await writeFileAtomic(target, '{"v":2}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":2}');
  });
});

describe('store write-queue diagnostics reach the live outlet (DREAM-2)', () => {
  it('policy store write failures surface in diagnostics while memory keeps the value', async () => {
    const dir = await tempDir('eperm-policy');
    const patch = patchRename('always');
    try {
      const store = await PolicyStore.open({ dataDir: dir, now: (): number => 1_700_000_000_000 });
      expect(store.diagnostics).toEqual([]);
      const policy = samplePolicy('pi-1', 1);
      // The queue reports success; the diagnostic is the only trace of the
      // in-memory/disk divergence.
      await store.saveCurrent(policy);
      await store.flush();
      expect(store.current).toEqual(policy);
      const report = store.diagnostics.join('\n');
      expect(report).toContain('persistence: policy store write failed');
      expect(report).toContain('EPERM');
    } finally {
      patch.restore();
    }
  });

  it('counts the divergence through the runtime handle without a restart', async () => {
    const dir = await tempDir('eperm-runtime');
    const patch = patchRename('always');
    try {
      const runtime = await createPersistenceRuntime({ dataDir: dir, now: (): number => 1_700_000_000_000 });
      // Nothing has failed yet: the live getter is empty at creation time...
      expect(runtime.diagnostics).toEqual([]);
      await runtime.policyStore.recordCompletedTask();
      await runtime.policyStore.flush();
      // ...and a failure noted after creation is still reachable through it.
      expect(runtime.diagnostics.join('\n')).toContain('persistence: policy store write failed');
      expect(runtime.policyStore.counters.completedTasks).toBe(1);
    } finally {
      patch.restore();
    }
  });

  it('tree-pool write failures surface in diagnostics too', async () => {
    const dir = await tempDir('eperm-tree-pool');
    const patch = patchRename('always');
    try {
      const store = await TreePoolStore.open({ dataDir: dir, now: (): number => 1_700_000_000_000 });
      expect(store.diagnostics).toEqual([]);
      // The append itself goes through appendFileDurable (no rename) and lands;
      // only the compaction rewrite through writeFileAtomic fails.
      await store.append(sampleTree({ id: 'tree-1' }));
      await store.compact();
      await store.flush();
      expect(store.allRecords()).toHaveLength(1);
      const report = store.diagnostics.join('\n');
      expect(report).toContain('persistence: tree-pool write failed');
      expect(report).toContain('EPERM');
    } finally {
      patch.restore();
    }
  });
});
