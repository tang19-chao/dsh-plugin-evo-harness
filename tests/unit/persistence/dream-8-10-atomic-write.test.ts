/**
 * DREAM-8: sweepTempFiles must match only the basename shape writeFileAtomic
 * mints ('<target>.tmp-<pid>-<12 hex>'), not any file whose name contains
 * '.tmp-' somewhere — an operator- or host-placed file like
 * 'notes.tmp-backup.json' in the data directory must survive every store open.
 *
 * DREAM-10: writeFileAtomic fsyncs the parent directory after a successful
 * rename, best effort: the attempt happens on POSIX (where the rename's
 * durability needs it) and is skipped on Windows, which exposes no directory
 * fsync through Node; a failed attempt never fails the write itself.
 */
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TEMP_FILE_MARKER,
  sweepTempFiles,
  writeFileAtomic
} from '../../../src/persistence/data-dir';
import { cleanupDir, makeTempDir } from './fixtures';

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

/** Module-shaped leftover: same shape writeFileAtomic mints (pid + 12 hex). */
function shapedTempName(target: string, pid = 999_999): string {
  return target + TEMP_FILE_MARKER + String(pid) + '-0123456789ab';
}

describe('sweepTempFiles matches only the module temp shape (DREAM-8)', () => {
  it('removes module-shaped leftovers and leaves look-alike names alone', async () => {
    const dir = await tempDir('dream-8-sweep');
    const shaped = shapedTempName('stale.jsonl');
    await writeFileAtomic(path.join(dir, shaped), 'partial');
    await writeFileAtomic(path.join(dir, 'notes.tmp-backup.json'), 'keep me');
    await writeFileAtomic(path.join(dir, 'report.tmp-final.json'), 'keep me too');
    await writeFileAtomic(path.join(dir, 'other.jsonl' + TEMP_FILE_MARKER + '1-short'), 'not our shape');
    await writeFileAtomic(path.join(dir, 'keep.jsonl'), 'kept\n');

    const removed = await sweepTempFiles(dir);
    expect(removed).toEqual([shaped]);
    expect(await fs.readFile(path.join(dir, 'notes.tmp-backup.json'), 'utf8')).toBe('keep me');
    expect(await fs.readFile(path.join(dir, 'report.tmp-final.json'), 'utf8')).toBe('keep me too');
    expect(await fs.readFile(path.join(dir, 'other.jsonl' + TEMP_FILE_MARKER + '1-short'), 'utf8')).toBe(
      'not our shape'
    );
    expect(await fs.readFile(path.join(dir, 'keep.jsonl'), 'utf8')).toBe('kept\n');
  });

  it('removes a module-shaped leftover of a dead process too', async () => {
    const dir = await tempDir('dream-8-dead-pid');
    const shaped = shapedTempName('counters.json', 4_242_424);
    await writeFileAtomic(path.join(dir, shaped), 'partial');
    expect(await sweepTempFiles(dir)).toEqual([shaped]);
  });
});

type OpenSpy = { readonly opened: readonly { readonly file: PathLike; readonly flags: string | number }[]; restore(): void };

/** Observe every fs.promises.open call without changing its behavior. */
function patchOpen(): OpenSpy {
  const opened: { file: PathLike; flags: string | number }[] = [];
  const original = fs.open;
  const patched = async (file: PathLike, flags: string | number, mode?: number): Promise<FileHandle> => {
    opened.push({ file, flags });
    return original(file, flags, mode);
  };
  fs.open = patched as unknown as typeof fs.open;
  return {
    opened,
    restore: (): void => {
      fs.open = original;
    }
  };
}

describe('writeFileAtomic fsyncs the parent directory after the rename (DREAM-10)', () => {
  it('opens the parent directory for fsync on POSIX and skips it on Windows', async () => {
    const dir = await tempDir('dream-10-dir-fsync');
    const target = path.join(dir, 'state.json');
    const spy = patchOpen();
    try {
      await writeFileAtomic(target, '{"v":1}');
    } finally {
      spy.restore();
    }
    const dirSyncs = spy.opened.filter((entry) => entry.file === dir && entry.flags === 'r');
    if (process.platform === 'win32') {
      // No directory fsync API on Windows: the attempt is skipped entirely.
      expect(dirSyncs).toEqual([]);
    } else {
      expect(dirSyncs).toHaveLength(1);
    }
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":1}');
  });

  it('still commits the write when the directory fsync fails (best effort)', async () => {
    const dir = await tempDir('dream-10-dir-fsync-fail');
    const target = path.join(dir, 'state.json');
    const original = fs.open;
    if (process.platform !== 'win32') {
      const failing = async (file: PathLike, flags: string | number, mode?: number): Promise<FileHandle> => {
        if (file === dir) {
          throw Object.assign(new Error('EACCES: fsync denied'), { code: 'EACCES' });
        }
        return (original as (file: PathLike, flags: string | number, mode?: number) => Promise<FileHandle>)(
          file,
          flags,
          mode
        );
      };
      fs.open = failing as unknown as typeof fs.open;
    }
    try {
      await writeFileAtomic(target, '{"v":1}');
    } finally {
      fs.open = original;
    }
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":1}');
  });
});
