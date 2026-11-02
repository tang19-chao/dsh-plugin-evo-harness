/**
 * DREAM-7: the history trim must rewrite the retained records verbatim, keeping
 * the original acceptance timestamps, instead of re-stamping every surviving
 * audit record with the compaction time (which turned the append-only log's
 * timeline into fiction after a few trims).
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { POLICY_HISTORY_FILE, PolicyStore } from '../../../src/persistence/policy.store';
import { readTextIfExists } from '../../../src/persistence/data-dir';
import { cleanupDir, makeTempDir, samplePolicy } from './fixtures';

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

interface RevisionLine {
  readonly schemaVersion: number;
  readonly at: number;
  readonly policy: { readonly id: string };
}

function parseHistory(text: string): readonly RevisionLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RevisionLine);
}

async function readHistory(dir: string): Promise<readonly RevisionLine[]> {
  const text = await readTextIfExists(path.join(dir, POLICY_HISTORY_FILE));
  expect(text).toBeDefined();
  return parseHistory(text ?? '');
}

describe('policy history trim keeps original audit timestamps (DREAM-7)', () => {
  it('rewrites retained records verbatim when the window overflows', async () => {
    const dir = await tempDir('dream-7-trim');
    let tick = 1_700_000_000_000;
    const store = await PolicyStore.open({
      dataDir: dir,
      maxHistory: 2,
      now: (): number => {
        tick += 1;
        return tick;
      }
    });
    await store.savePolicy(samplePolicy('pi-1', 1));
    await store.savePolicy(samplePolicy('pi-2', 2));
    await store.flush();
    // The originals on disk before the trim: pi-1 and pi-2 with their own
    // acceptance stamps.
    const originals = await readHistory(dir);
    expect(originals.map((line) => line.policy.id)).toEqual(['pi-1', 'pi-2']);
    const pi2OriginalAt = originals[1]?.at;

    await store.savePolicy(samplePolicy('pi-3', 3)); // overflows the window, triggers the trim
    await store.flush();
    expect(store.history.map((policy) => policy.id)).toEqual(['pi-2', 'pi-3']);

    const trimmed = await readHistory(dir);
    expect(trimmed.map((line) => line.policy.id)).toEqual(['pi-2', 'pi-3']);
    // pi-2's audit stamp survived the rewrite verbatim; a re-stamp would have
    // replaced it with the compaction time.
    expect(trimmed[0]?.at).toBe(pi2OriginalAt);
    expect(trimmed[0]?.at ?? 0).toBeLessThan(trimmed[1]?.at ?? 0);
  });

  it('keeps the original timestamps when trimming records loaded from disk', async () => {
    const dir = await tempDir('dream-7-restart-trim');
    let tick = 1_700_000_000_000;
    const now = (): number => {
      tick += 1;
      return tick;
    };
    const first = await PolicyStore.open({ dataDir: dir, maxHistory: 2, now });
    await first.savePolicy(samplePolicy('pi-1', 1));
    await first.savePolicy(samplePolicy('pi-2', 2));
    await first.flush();
    const originals = await readHistory(dir);
    const pi2OriginalAt = originals[1]?.at;

    const restarted = await PolicyStore.open({ dataDir: dir, maxHistory: 2, now });
    await restarted.savePolicy(samplePolicy('pi-3', 3)); // trims the loaded window
    await restarted.flush();

    const trimmed = await readHistory(dir);
    expect(trimmed.map((line) => line.policy.id)).toEqual(['pi-2', 'pi-3']);
    // The loaded record's original stamp (not the reopen-time clock) survives.
    expect(trimmed[0]?.at).toBe(pi2OriginalAt);
  });
});
