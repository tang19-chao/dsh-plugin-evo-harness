/**
 * P1-2: JSONL experience store persistence.
 *
 * Covers durable append, tolerant reload (torn trailing line, corrupt line
 * isolation, unreadable file), compaction through temp file + atomic rename,
 * export order, size accounting, the in-memory index cap surviving a reload,
 * and that diagnostics never carry record payloads.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExperienceStoreFs } from '../../../src/jitrl/stores/jsonl.store';
import type { ExperienceRecord, JitLevel } from '../../../src/types/contracts';
import { createJsonlExperienceStore } from '../../../src/jitrl/stores/jsonl.store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HALF_LIFE = 1000;
const NOW = 1_000_000_000_000;
const SECRET = 'SUPER_SECRET_TOKEN_zzz';

let counter = 0;

function record(overrides: {
  readonly id?: string;
  readonly level?: JitLevel;
  readonly bucket?: string;
  readonly tokens?: readonly string[];
  readonly createdAt?: number;
} = {}): ExperienceRecord {
  counter += 1;
  const level = overrides.level ?? 'meta';
  const id = overrides.id ?? 'json-' + String(counter);
  return {
    id,
    level,
    state: {
      level,
      bucket: overrides.bucket ?? 'task|simple',
      tokens: overrides.tokens ?? ['alpha', 'beta'],
      summary: 'summary ' + id
    },
    actionKey: 'action:' + id,
    reward: 1,
    return: 2,
    rewardSources: { llm: 1 },
    guidance: 'memory',
    policyId: 'policy-1',
    sessionId: 'session-1',
    createdAt: overrides.createdAt ?? NOW,
    redacted: true
  };
}

/** In-memory ExperienceStoreFs that records the order of its operations. */
class FakeFs implements ExperienceStoreFs {
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  readError: Error | undefined;

  async appendDurable(filePath: string, contents: string): Promise<void> {
    this.ops.push('append');
    this.files.set(filePath, (this.files.get(filePath) ?? '') + contents);
  }

  async readText(filePath: string): Promise<string | undefined> {
    this.ops.push('read');
    if (this.readError !== undefined) {
      throw this.readError;
    }
    return this.files.get(filePath);
  }

  async replaceAtomic(filePath: string, contents: string): Promise<void> {
    this.ops.push('replace');
    this.files.set(filePath, contents);
  }
}

async function makeStore(file: FakeFs, options: {
  readonly bucketCap?: number;
  readonly halfLifeMs?: number;
} = {}) {
  return createJsonlExperienceStore({
    filePath: 'evoharness/experience.jsonl',
    fs: file,
    now: () => NOW,
    halfLifeMs: options.halfLifeMs ?? HALF_LIFE,
    ...(options.bucketCap === undefined ? {} : { bucketCap: options.bucketCap })
  });
}

async function loadRecords(store: { load(): Promise<number> }) {
  return store.load();
}

// ---------------------------------------------------------------------------
// Fake-fs behaviour
// ---------------------------------------------------------------------------

describe('jsonl experience store (injected fs)', () => {
  it('appends one JSON object per line and reloads them', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([record({ id: 'a' }), record({ id: 'b', bucket: 'task|hard' })]);
    const text = file.files.get('evoharness/experience.jsonl') ?? '';
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
    expect(file.ops.filter((op) => op === 'append')).toEqual(['append']);

    // A second store over the same bytes sees the same records.
    const reopened = await makeStore(file);
    expect(await reopened.size()).toBe(2);
    expect(await reopened.size('meta')).toBe(2);
    expect(await reopened.size('proposal')).toBe(0);
    expect((await reopened.query({
      level: 'meta',
      state: { level: 'meta', bucket: 'task|simple', tokens: ['alpha', 'beta'], summary: 'q' },
      k: 5,
      similarityThreshold: 0
    }))[0]?.record.id).toBe('a');
  });

  it('never writes to the index when the append itself fails', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    file.appendDurable = async (): Promise<void> => {
      throw new Error('disk full');
    };
    await expect(store.append([record({ id: 'lost' })])).rejects.toThrowError('disk full');
    expect(await store.size()).toBe(0);
  });

  it('loads nothing from a missing log and never throws', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    expect(await store.size()).toBe(0);
    expect(await loadRecords(store)).toBe(0);
    expect(store.diagnostics()).toEqual([]);
  });

  it('tolerates a torn trailing line and keeps the healthy prefix', async () => {
    const file = new FakeFs();
    file.files.set(
      'evoharness/experience.jsonl',
      JSON.stringify(record({ id: 'healthy' })) + '\n' + '{"id":"torn","level":"meta"'
    );
    const store = await makeStore(file);
    expect(await store.size()).toBe(1);
    expect(store.snapshot()[0]?.id).toBe('healthy');
    const diagnostic = store.diagnostics().find((entry) => entry.code === 'experience_store_truncated_tail');
    expect(diagnostic?.level).toBe('warn');
  });

  it('isolates a corrupt line without losing its healthy neighbours', async () => {
    const file = new FakeFs();
    file.files.set(
      'evoharness/experience.jsonl',
      JSON.stringify(record({ id: 'first' })) + '\n' +
        '{not json at all\n' +
        JSON.stringify({ id: 'structurally-wrong', level: 'meta' }) + '\n' +
        JSON.stringify(record({ id: 'last' })) + '\n'
    );
    const store = await makeStore(file);
    expect(await store.size()).toBe(2);
    expect(store.snapshot().map((entry) => entry.id).sort()).toEqual(['first', 'last']);
    const malformed = store.diagnostics().filter((entry) => entry.code === 'experience_store_malformed_line');
    expect(malformed.length).toBeGreaterThanOrEqual(2);
    expect(malformed.every((entry) => entry.level === 'warn')).toBe(true);
  });

  it('keeps diagnostics free of record payloads on every failure path', async () => {
    const file = new FakeFs();
    file.files.set(
      'evoharness/experience.jsonl',
      // A torn tail whose bytes carry the secret...
      JSON.stringify(record({ id: 'ok' })) + '\n' +
        '{"id":"' + SECRET + '","truncated' + '\n' +
        // ...and a mid-file corrupt line whose bytes carry it too.
        '{"id":"' + SECRET + '","level":' + '\n' +
        JSON.stringify(record({ id: 'after' })) + '\n'
    );
    const store = await makeStore(file);
    expect(await store.size()).toBe(2);
    expect(store.diagnostics().length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(store.diagnostics());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('"id"');
  });

  it('reports an unreadable log without throwing and keeps the index empty', async () => {
    const file = new FakeFs();
    file.readError = new Error('EACCES');
    const store = await makeStore(file);
    expect(await store.size()).toBe(0);
    const diagnostic = store.diagnostics().find((entry) => entry.code === 'experience_store_unreadable');
    expect(diagnostic?.message).toContain('EACCES');
  });

  it('compacts through the atomic replacement path and rewrites survivors', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([
      record({ id: 'keep-new', createdAt: NOW }),
      record({ id: 'keep-mid', createdAt: NOW - HALF_LIFE }),
      record({ id: 'drop', createdAt: NOW - 100 * HALF_LIFE })
    ]);
    file.ops.length = 0;
    const removed = await store.compact({ maxPerBucket: 2, halfLifeMs: HALF_LIFE });
    expect(removed).toBe(1);
    expect(file.ops).toContain('replace');
    expect(file.ops).not.toContain('append');
    expect(await store.size()).toBe(2);
    const text = file.files.get('evoharness/experience.jsonl') ?? '';
    expect(text).not.toContain('"drop"');
    // Reopening sees exactly the compacted survivors.
    const reopened = await makeStore(file);
    expect(reopened.snapshot().map((entry) => entry.id).sort()).toEqual(['keep-mid', 'keep-new']);
  });

  it('does not rewrite the log when compaction removes nothing', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([record({ id: 'only', createdAt: NOW })]);
    file.ops.length = 0;
    expect(await store.compact({ maxPerBucket: 5, halfLifeMs: HALF_LIFE })).toBe(0);
    expect(file.ops).toEqual([]);
  });

  it('exposes flush(), which rewrites the log from the live index', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([record({ id: 'one' }), record({ id: 'two' })]);
    file.ops.length = 0;
    await store.flush();
    expect(file.ops).toEqual(['replace']);
    expect((file.files.get('evoharness/experience.jsonl') ?? '').trimEnd().split('\n')).toHaveLength(2);
  });

  it('is parallel safe: concurrent sequential appends all land', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await Promise.all([
      store.append([record({ id: 'p1' })]),
      store.append([record({ id: 'p2' })]),
      store.append([record({ id: 'p3' })])
    ]);
    expect(await store.size()).toBe(3);
    expect(store.snapshot().map((entry) => entry.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect((file.files.get('evoharness/experience.jsonl') ?? '').trimEnd().split('\n')).toHaveLength(3);
  });

  it('respects the bucket cap across a reload', async () => {
    const file = new FakeFs();
    const evicted: string[] = [];
    const store = await makeStore(file, { bucketCap: 2 });
    await store.append([
      record({ id: 'oldest', createdAt: 1 }),
      record({ id: 'middle', createdAt: 2 }),
      record({ id: 'newest', createdAt: 3 })
    ]);
    expect(await store.size()).toBe(2);
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['newest', 'middle']);
    const reopened = await makeStore(file, { bucketCap: 2 });
    expect(reopened.snapshot().map((entry) => entry.id)).toEqual(['newest', 'middle']);
    expect(evicted).toEqual([]);
  });

  it('exports live records newest first, then re-exports them from a reload', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([
      record({ id: 'z', createdAt: 10 }),
      record({ id: 'y', createdAt: 30 }),
      record({ id: 'x', createdAt: 20 })
    ]);
    const ids: string[] = [];
    for await (const entry of store.export()) {
      ids.push(entry.id);
    }
    expect(ids).toEqual(['y', 'x', 'z']);

    const reopened = await makeStore(file);
    const reloaded: string[] = [];
    for await (const entry of reopened.export()) {
      reloaded.push(entry.id);
    }
    expect(reloaded).toEqual(['y', 'x', 'z']);
  });

  it('rejects a non-positive bucket cap and an empty file path', async () => {
    const file = new FakeFs();
    await expect(makeStore(file, { bucketCap: 0 })).rejects.toThrowError(RangeError);
    await expect(createJsonlExperienceStore({ filePath: '  ', fs: file })).rejects.toThrowError(TypeError);
  });

  it('last write wins for a duplicated id line', async () => {
    const file = new FakeFs();
    file.files.set(
      'evoharness/experience.jsonl',
      JSON.stringify(record({ id: 'dup', tokens: ['first'] })) + '\n' +
        JSON.stringify(record({ id: 'dup', tokens: ['second'] })) + '\n'
    );
    const store = await makeStore(file);
    expect(await store.size()).toBe(1);
    expect(store.snapshot()[0]?.state.tokens).toEqual(['second']);
  });
});

describe('jsonl store purge (P3-E2 gap 2)', () => {
  const logPath = 'evoharness/experience.jsonl';

  it('purges one bucket atomically and reloads without it', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([
      record({ id: 'keep-1', bucket: 'keep' }),
      record({ id: 'drop-1', bucket: 'drop' })
    ]);
    const opsBefore = file.ops.length;
    expect(await store.purge({ bucket: 'drop' })).toBe(1);
    expect(file.ops.slice(opsBefore)).toContain('replace');
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['keep-1']);
    const text = file.files.get(logPath) ?? '';
    expect(text).toContain('keep-1');
    expect(text).not.toContain('drop-1');
    const reopened = await makeStore(file);
    expect(reopened.snapshot().map((entry) => entry.id)).toEqual(['keep-1']);
  });

  it('treats an unknown bucket as a strict no-op with no rewrite', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([record({ id: 'keep-1', bucket: 'keep' })]);
    const opsBefore = file.ops.length;
    expect(await store.purge({ bucket: 'missing' })).toBe(0);
    expect(file.ops.slice(opsBefore)).not.toContain('replace');
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['keep-1']);
  });

  it('global purge empties the log and the index', async () => {
    const file = new FakeFs();
    const store = await makeStore(file);
    await store.append([record({ id: 'a' }), record({ id: 'b', bucket: 'other' })]);
    expect(await store.purge()).toBe(2);
    expect(file.files.get(logPath)).toBe('');
    expect(store.snapshot()).toEqual([]);
    expect(await makeStore(file).then((reopened) => reopened.size())).toBe(0);
  });

  it('rewrites away a torn trailing line during a global purge', async () => {
    const file = new FakeFs();
    file.files.set(
      logPath,
      JSON.stringify(record({ id: 'complete' })) + '\n' + '{"id":"partial","level":"meta"'
    );
    const store = await makeStore(file);
    expect(await store.size()).toBe(1);
    expect(await store.purge()).toBe(1);
    expect(file.files.get(logPath)).toBe('');
    expect(store.snapshot()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real filesystem: durable append + atomic rename leave no debris
// ---------------------------------------------------------------------------

describe('jsonl experience store (node fs)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  async function tempLog(): Promise<{ readonly dir: string; readonly filePath: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jitrl-store-'));
    dirs.push(dir);
    return { dir, filePath: path.join(dir, 'nested', 'experience.jsonl') };
  }

  it('durably appends, reloads, compacts atomically and leaves no temp files', async () => {
    const { filePath } = await tempLog();
    const store = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    await store.append([
      record({ id: 'r-new', createdAt: NOW }),
      record({ id: 'r-old', createdAt: NOW - HALF_LIFE }),
      record({ id: 'r-ancient', createdAt: NOW - 100 * HALF_LIFE })
    ]);
    const onDisk = await fs.readFile(filePath, 'utf8');
    expect(onDisk.trimEnd().split('\n')).toHaveLength(3);

    expect(await store.compact({ maxPerBucket: 2, halfLifeMs: HALF_LIFE })).toBe(1);
    // Only the log file is left behind: the temp sibling was renamed away.
    const entries = await fs.readdir(path.dirname(filePath));
    expect(entries).toEqual(['experience.jsonl']);

    const reopened = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    expect(reopened.snapshot().map((entry) => entry.id).sort()).toEqual(['r-new', 'r-old']);
  });

  it('purges one bucket on real disk and leaves the other bucket after reopen', async () => {
    const { filePath } = await tempLog();
    const store = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    await store.append([
      record({ id: 'keep-1', bucket: 'keep' }),
      record({ id: 'drop-1', bucket: 'drop' }),
      record({ id: 'drop-2', bucket: 'drop' })
    ]);
    expect(await store.purge({ bucket: 'drop' })).toBe(2);
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['keep-1']);
    const disk = await fs.readFile(filePath, 'utf8');
    expect(disk).toContain('keep-1');
    expect(disk).not.toContain('drop-1');

    const reopened = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    expect(reopened.snapshot().map((entry) => entry.id)).toEqual(['keep-1']);
  });

  it('global purge empties the real log', async () => {
    const { filePath } = await tempLog();
    const store = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    await store.append([record({ id: 'a' }), record({ id: 'b', bucket: 'other' })]);
    expect(await store.purge()).toBe(2);
    expect(await fs.readFile(filePath, 'utf8')).toBe('');
    expect(store.snapshot()).toEqual([]);
    const reopened = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    expect(reopened.snapshot()).toEqual([]);
  });

  it('recovers from a real torn tail written without a terminating newline', async () => {
    const { dir, filePath } = await tempLog();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(record({ id: 'complete' })) + '\n' + '{"id":"partial","level":"meta"',
      'utf8'
    );
    const store = await createJsonlExperienceStore({ filePath, now: () => NOW, halfLifeMs: HALF_LIFE });
    expect(await store.size()).toBe(1);
    expect(store.diagnostics().some((entry) => entry.code === 'experience_store_truncated_tail')).toBe(true);
    // The healthy line is preserved on disk.
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).toContain('complete');
    expect(dir.length).toBeGreaterThan(0);
  });
});
