import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PROFILE_NAME,
  TEMP_FILE_MARKER,
  ensureDir,
  parseJsonlText,
  quarantineFile,
  readJsonRecovering,
  readJsonlRecovering,
  readTextIfExists,
  resolveProfileDataDir,
  sanitizeProfileName,
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

interface TextRecord {
  readonly id: string;
}

function parseTextRecord(value: unknown): TextRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0 ? { id: record.id } : undefined;
}

describe('profile data directory resolution', () => {
  it('honours an explicit dataDir over every other option', () => {
    const resolved = resolveProfileDataDir({
      dataDir: path.join('some', 'explicit'),
      profile: 'ignored',
      rootDir: 'ignored-root'
    });
    expect(resolved).toBe(path.resolve(path.join('some', 'explicit')));
  });

  it('builds <root>/profiles/<profile> from environment variables', () => {
    const root = path.join('var', 'data', 'dsh');
    const resolved = resolveProfileDataDir({
      env: { EVO_HARNESS_DATA_DIR: root, DSH_PROFILE: 'team alpha' }
    });
    expect(resolved).toBe(path.join(path.resolve(root), 'profiles', 'team_alpha'));
  });

  it('falls back to DSH_DATA_DIR and then the home default', () => {
    const fromDsh = resolveProfileDataDir({
      env: { DSH_DATA_DIR: path.join('dsh', 'root') },
      homeDir: path.join('home', 'someone')
    });
    expect(fromDsh).toBe(path.join(path.resolve(path.join('dsh', 'root')), 'profiles', 'default'));

    const fromHome = resolveProfileDataDir({ env: {}, homeDir: path.join('home', 'someone') });
    expect(fromHome).toBe(
      path.join(
        path.resolve(path.join('home', 'someone')),
        '.dsh',
        'evo-harness',
        'profiles',
        DEFAULT_PROFILE_NAME
      )
    );
  });

  it('sanitizes profile names so traversal cannot escape the data root', () => {
    expect(sanitizeProfileName('../evil')).toBe('_evil');
    expect(sanitizeProfileName('a/b\\c')).toBe('a_b_c');
    expect(sanitizeProfileName('')).toBe(DEFAULT_PROFILE_NAME);
    expect(sanitizeProfileName('....')).toBe(DEFAULT_PROFILE_NAME);
    expect(sanitizeProfileName(undefined)).toBe(DEFAULT_PROFILE_NAME);
    const resolved = resolveProfileDataDir({
      env: { EVO_HARNESS_DATA_DIR: path.join('root'), DSH_PROFILE: '../../etc' }
    });
    expect(resolved.startsWith(path.resolve('root') + path.sep)).toBe(true);
    expect(resolved.includes('..')).toBe(false);
  });
});

describe('atomic file IO', () => {
  it('writes, overwrites and leaves no temp files behind', async () => {
    const dir = await tempDir('atomic');
    const target = path.join(dir, 'state.json');
    await writeFileAtomic(target, '{"v":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":1}');
    await writeFileAtomic(target, '{"v":2}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":2}');
    const entries = await fs.readdir(dir);
    expect(entries.some((entry) => entry.includes(TEMP_FILE_MARKER))).toBe(false);
  });

  it('writes binary payloads and creates missing parent directories', async () => {
    const dir = await tempDir('atomic-nested');
    const target = path.join(dir, 'nested', 'state.bin');
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]));
    expect(Array.from(await fs.readFile(target))).toEqual([1, 2, 3]);
  });

  it('reads missing files as undefined and reports present files', async () => {
    const dir = await tempDir('read');
    expect(await readTextIfExists(path.join(dir, 'missing.txt'))).toBeUndefined();
    const present = path.join(dir, 'present.txt');
    await writeFileAtomic(present, 'hello');
    expect(await readTextIfExists(present)).toBe('hello');
  });

  it('quarantines damaged files without losing their bytes', async () => {
    const dir = await tempDir('quarantine');
    const target = path.join(dir, 'state.json');
    await writeFileAtomic(target, 'damaged');
    const first = await quarantineFile(target);
    expect(first).toBe(target + '.corrupt');
    expect(await readTextIfExists(target)).toBeUndefined();
    expect(await readTextIfExists(target + '.corrupt')).toBe('damaged');

    await writeFileAtomic(target, 'damaged-again');
    const second = await quarantineFile(target);
    expect(second).toBe(target + '.corrupt.1');
    expect(await readTextIfExists(target + '.corrupt.1')).toBe('damaged-again');
    expect(await quarantineFile(path.join(dir, 'absent'))).toBeUndefined();
  });

  it('sweeps interrupted atomic-write temp files only', async () => {
    const dir = await tempDir('sweep');
    await writeFileAtomic(path.join(dir, 'keep.jsonl'), 'kept\n');
    await writeFileAtomic(path.join(dir, 'stale.jsonl' + TEMP_FILE_MARKER + '999-dead'), 'partial');
    const removed = await sweepTempFiles(dir);
    expect(removed).toEqual(['stale.jsonl' + TEMP_FILE_MARKER + '999-dead']);
    expect(await readTextIfExists(path.join(dir, 'keep.jsonl'))).toBe('kept\n');
    expect(await sweepTempFiles(path.join(dir, 'missing'))).toEqual([]);
  });

  it('creates nested directories with ensureDir', async () => {
    const dir = await tempDir('ensure');
    const nested = path.join(dir, 'a', 'b', 'c');
    await ensureDir(nested);
    const stats = await fs.stat(nested);
    expect(stats.isDirectory()).toBe(true);
  });
});

describe('JSONL parsing', () => {
  it('parses records, flags a missing terminator and tolerates CRLF/blank lines', () => {
    const parsed = parseJsonlText('{"id":"a"}\r\n\r\n{"id":"b"}');
    expect(parsed.lines.map((line) => line.value)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(parsed.missingTerminator).toBe(true);

    const terminated = parseJsonlText('{"id":"a"}\n');
    expect(terminated.lines).toHaveLength(1);
    expect(terminated.missingTerminator).toBe(false);
    expect(parseJsonlText('').lines).toEqual([]);
  });

  it('records the parse error of a malformed line', () => {
    const parsed = parseJsonlText('{"id":"a"}\nnot-json\n');
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]?.error).toBeNull();
    expect(parsed.lines[1]?.error).not.toBeNull();
  });
});

describe('tolerant JSONL recovery', () => {
  it('reads a healthy log without touching it', async () => {
    const dir = await tempDir('jsonl-healthy');
    const log = path.join(dir, 'log.jsonl');
    await writeFileAtomic(log, '{"id":"a"}\n{"id":"b"}\n');
    const recovery = await readJsonlRecovering(log, parseTextRecord);
    expect(recovery.records).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(recovery.repaired).toBe(false);
    expect(recovery.quarantinedPath).toBeUndefined();
    expect(recovery.diagnostics).toEqual([]);
  });

  it('drops a partially written trailing record and quarantines the original', async () => {
    const dir = await tempDir('jsonl-torn');
    const log = path.join(dir, 'log.jsonl');
    await writeFileAtomic(log, '{"id":"a"}\n{"id":"b"');
    const recovery = await readJsonlRecovering(log, parseTextRecord);
    expect(recovery.records).toEqual([{ id: 'a' }]);
    expect(recovery.droppedTornTail).toBe(true);
    expect(recovery.corrupt).toBe(false);
    expect(recovery.repaired).toBe(true);
    expect(recovery.quarantinedPath).toBe(log + '.corrupt');
    expect(await readTextIfExists(log)).toBe('{"id":"a"}\n');
    expect(recovery.diagnostics).toHaveLength(1);

    // A second load is clean: the healthy prefix was rewritten, no new quarantine.
    const second = await readJsonlRecovering(log, parseTextRecord);
    expect(second.records).toEqual([{ id: 'a' }]);
    expect(second.diagnostics).toEqual([]);
    expect(second.quarantinedPath).toBeUndefined();
  });

  it('keeps the healthy prefix and quarantines an interior corrupt line', async () => {
    const dir = await tempDir('jsonl-interior');
    const log = path.join(dir, 'log.jsonl');
    await writeFileAtomic(log, '{"id":"a"}\nnot-json\n{"id":"c"}\n');
    const recovery = await readJsonlRecovering(log, parseTextRecord);
    expect(recovery.records).toEqual([{ id: 'a' }]);
    expect(recovery.corrupt).toBe(true);
    expect(recovery.droppedTornTail).toBe(false);
    expect(await readTextIfExists(log)).toBe('{"id":"a"}\n');
    expect(await readTextIfExists(log + '.corrupt')).toBe('{"id":"a"}\nnot-json\n{"id":"c"}\n');
  });

  it('treats a complete-but-invalid trailing record as corruption', async () => {
    const dir = await tempDir('jsonl-schema');
    const log = path.join(dir, 'log.jsonl');
    await writeFileAtomic(log, '{"id":"a"}\n{"nope":true}\n');
    const recovery = await readJsonlRecovering(log, parseTextRecord);
    expect(recovery.records).toEqual([{ id: 'a' }]);
    expect(recovery.corrupt).toBe(true);
    expect(recovery.quarantinedPath).toBe(log + '.corrupt');
  });

  it('repairs a missing final newline without dropping the record', async () => {
    const dir = await tempDir('jsonl-nonewline');
    const log = path.join(dir, 'log.jsonl');
    await writeFileAtomic(log, '{"id":"a"}');
    const recovery = await readJsonlRecovering(log, parseTextRecord);
    expect(recovery.records).toEqual([{ id: 'a' }]);
    expect(recovery.repaired).toBe(true);
    expect(recovery.droppedTornTail).toBe(false);
    expect(recovery.quarantinedPath).toBeUndefined();
    expect(await readTextIfExists(log)).toBe('{"id":"a"}\n');
  });

  it('reports a missing log as not existing', async () => {
    const dir = await tempDir('jsonl-missing');
    const recovery = await readJsonlRecovering(path.join(dir, 'log.jsonl'), parseTextRecord);
    expect(recovery.existed).toBe(false);
    expect(recovery.records).toEqual([]);
  });
});

describe('tolerant JSON snapshot recovery', () => {
  it('returns a valid snapshot and reports missing files', async () => {
    const dir = await tempDir('json-valid');
    const file = path.join(dir, 'snapshot.json');
    await writeFileAtomic(file, JSON.stringify({ id: 'a' }));
    const recovery = await readJsonRecovering(file, parseTextRecord);
    expect(recovery.value).toEqual({ id: 'a' });
    expect(recovery.existed).toBe(true);
    expect(recovery.diagnostics).toEqual([]);

    const missing = await readJsonRecovering(path.join(dir, 'absent.json'), parseTextRecord);
    expect(missing.existed).toBe(false);
    expect(missing.value).toBeUndefined();
  });

  it('quarantines unparseable, empty and schema-invalid snapshots', async () => {
    const dir = await tempDir('json-corrupt');
    const truncated = path.join(dir, 'truncated.json');
    await writeFileAtomic(truncated, '{"id":');
    const first = await readJsonRecovering(truncated, parseTextRecord);
    expect(first.value).toBeUndefined();
    expect(first.quarantinedPath).toBe(truncated + '.corrupt');
    expect(first.diagnostics).toHaveLength(1);

    const empty = path.join(dir, 'empty.json');
    await writeFileAtomic(empty, '');
    const second = await readJsonRecovering(empty, parseTextRecord);
    expect(second.value).toBeUndefined();
    expect(second.quarantinedPath).toBe(empty + '.corrupt');

    const wrongShape = path.join(dir, 'shape.json');
    await writeFileAtomic(wrongShape, JSON.stringify({ other: 1 }));
    const third = await readJsonRecovering(wrongShape, parseTextRecord);
    expect(third.value).toBeUndefined();
    expect(third.quarantinedPath).toBe(wrongShape + '.corrupt');
  });
});