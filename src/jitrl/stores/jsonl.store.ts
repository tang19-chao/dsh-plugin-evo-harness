/**
 * Crash-safe JSONL IExperienceStore (plan sections 5.1, 6.3, P1-2).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel, P1-2).
 *
 * Layout: one JSON object per line, terminated by '\n'. Appends open the file
 * with the 'a' flag, write the batch and fsync; a torn tail (a line written
 * without its terminating newline, or malformed JSON) is skipped on load and
 * reported as a payload-free diagnostic. Reading never throws because of
 * damaged persistence: the healthy prefix survives and the store starts from
 * it. compaction rewrites the log through a sibling temp file and an atomic
 * rename, so a crash can never expose a half-written snapshot.
 *
 * The index in ../experience-store.ts is the in-memory truth; the file is the
 * durable projection of it. File IO is injected through ExperienceStoreFs, so
 * tests can substitute an in-memory filesystem and production uses node:fs.
 */

import type {
  ExperienceQuery,
  ExperienceRecord,
  JitLevel,
  ScoredExperience
} from '../../types/contracts';
import {
  DEFAULT_EXPERIENCE_BUCKET_CAP,
  DEFAULT_EXPERIENCE_HALF_LIFE_MS,
  ExperienceIndex,
  executeExperienceQuery,
  malformedLineDiagnostic,
  normalizeExperienceRecords,
  planCompaction,
  toExperienceRecord,
  type ExperienceEviction,
  type ExperienceStoreDiagnostic,
  type ScoredStoredExperience,
  type StoredExperience
} from '../experience-store';

// ---------------------------------------------------------------------------
// Injected file IO
// ---------------------------------------------------------------------------

/**
 * The narrow filesystem surface this store needs. Keeping it structural means
 * the store never depends on node:fs and tests can inject a fake.
 */
export interface ExperienceStoreFs {
  /** Append contents and flush them durably (open 'a', write, fsync). */
  appendDurable(filePath: string, contents: string): Promise<void>;
  /** Read the whole file as UTF-8; undefined when the file does not exist. */
  readText(filePath: string): Promise<string | undefined>;
  /** Atomically replace the file (temp sibling + rename). */
  replaceAtomic(filePath: string, contents: string): Promise<void>;
}

/**
 * Best-effort sync: a filesystem whose handles do not expose fdatasync (or
 * whose platform refuses one) still keeps the append, it just cannot promise
 * the write reached the platter.
 */
async function syncBestEffort(handle: { sync?: () => Promise<void> }): Promise<void> {
  try {
    await handle.sync?.();
  } catch {
    // Durability is best effort here; the append itself already succeeded.
  }
}

/** Monotonic suffix that keeps two concurrent temp names distinct. */
let tempCounter = 0;

/** Build the production ExperienceStoreFs on top of node:fs. */
export async function createNodeExperienceFs(): Promise<ExperienceStoreFs> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const ensureParent = async (filePath: string): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  };
  return {
    async appendDurable(filePath: string, contents: string): Promise<void> {
      await ensureParent(filePath);
      const handle = await fs.open(filePath, 'a', 0o600);
      try {
        await handle.writeFile(contents);
        await syncBestEffort(handle);
      } finally {
        await handle.close();
      }
    },
    async readText(filePath: string): Promise<string | undefined> {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    async replaceAtomic(filePath: string, contents: string): Promise<void> {
      await ensureParent(filePath);
      const temp = path.join(
        path.dirname(filePath),
        '.jitrl-experience-' + String(process.pid) + '-' + String(Date.now()) + '-' + String(tempCounter++) + '.tmp'
      );
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(contents);
          await syncBestEffort(handle);
        } finally {
          await handle.close();
        }
        await fs.rename(temp, filePath);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Construction options for the JSONL store. */
export interface JsonlExperienceStoreOptions {
  /** Target log file; its parent directory is created on demand. */
  readonly filePath: string;
  /** Milliseconds since epoch provider; defaults to Date.now. */
  readonly now?: () => number;
  /** Half-life of the retrieval weight in ms; default 30 days, 0 disables decay. */
  readonly halfLifeMs?: number;
  /** Cap per (level, bucket) in the live index; defaults to 200. */
  readonly bucketCap?: number;
  /** Injected filesystem; defaults to node:fs (createNodeExperienceFs). */
  readonly fs?: ExperienceStoreFs;
  /** Diagnostic sink; diagnostics never contain record payloads. */
  readonly onDiagnostic?: (diagnostic: ExperienceStoreDiagnostic) => void;
  /** Called for every record evicted because its bucket exceeded the cap. */
  readonly onEvict?: (eviction: ExperienceEviction) => void;
}

/** The store contract plus the persistence surface. */
export interface JsonlExperienceStore {
  append(records: readonly ExperienceRecord[]): Promise<void>;
  query(query: ExperienceQuery): Promise<readonly ScoredExperience[]>;
  size(level?: JitLevel): Promise<number>;
  compact(options: { readonly maxPerBucket: number; readonly halfLifeMs?: number }): Promise<number>;
  export(): AsyncIterable<ExperienceRecord>;
  /** Re-read the log, tolerating a torn tail. Resolves to the loaded count. */
  load(): Promise<number>;
  /** Rewrite the log from the live index; drops records evicted or compacted. */
  flush(): Promise<void>;
  /**
   * Drop every record, or only records whose state bucket matches, rewriting the
   * log atomically (temp sibling + rename). Resolves to the removed count; a
   * bucket that matches nothing is a no-op. Used by /evo jit reset (P3-E2).
   */
  purge(options?: { readonly bucket?: string }): Promise<number>;
  /** Snapshot of the live records, newest first. */
  snapshot(): readonly ExperienceRecord[];
  /** Diagnostics observed so far (payload free). */
  diagnostics(): readonly ExperienceStoreDiagnostic[];
  /** Absolute path of the backing log. */
  readonly filePath: string;
}

function toScored(entry: ScoredStoredExperience): ScoredExperience {
  return {
    record: toExperienceRecord(entry.record),
    similarity: entry.similarity,
    weight: entry.weight
  };
}

function encodeRecord(record: StoredExperience): string {
  return JSON.stringify(toExperienceRecord(record)) + '\n';
}

/**
 * Parse a log body without ever throwing. A body that does not end with a
 * newline has a torn tail; that whole trailing line is skipped with a
 * diagnostic. Every other line that fails to parse is skipped individually.
 */
function parseLog(
  text: string,
  emit: (diagnostic: ExperienceStoreDiagnostic) => void
): readonly StoredExperience[] {
  if (text.length === 0) {
    return [];
  }
  const torn = !text.endsWith('\n');
  const body = torn ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  const lines = body.split('\n');
  const out: StoredExperience[] = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  for (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // The engine's SyntaxError message quotes a fragment of the input, which
      // may hold record payloads; only the error class is reported.
      const reason = error instanceof SyntaxError ? 'invalid JSON syntax' : 'unreadable JSON line';
      emit(malformedLineDiagnostic(lineNumber, reason));
      continue;
    }
    try {
      const stored = normalizeExperienceRecords([parsed as ExperienceRecord])[0];
      if (stored === undefined) {
        continue;
      }
      if (seen.has(stored.id)) {
        // Last writer wins, exactly like re-running the appends in order.
        out.splice(
          out.findIndex((record) => record.id === stored.id),
          1
        );
      }
      seen.add(stored.id);
      out.push(stored);
    } catch (error) {
      // Record validation errors name a field only; the payload stays out of
      // the diagnostic stream on every path.
      const reason = error instanceof Error ? error.name : 'invalid experience record';
      emit(malformedLineDiagnostic(lineNumber, reason));
    }
  }
  if (torn) {
    const lastLine = text.slice(text.lastIndexOf('\n') + 1);
    emit({
      level: 'warn',
      code: 'experience_store_truncated_tail',
      message:
        'ignored a torn trailing line of ' + String(lastLine.length) + ' byte(s) without a terminating newline'
    });
  }
  return out;
}

/** Create a JSONL-backed experience store and load its log. */
export async function createJsonlExperienceStore(
  options: JsonlExperienceStoreOptions
): Promise<JsonlExperienceStore> {
  if (options.filePath.trim().length === 0) {
    throw new TypeError('createJsonlExperienceStore: filePath must be a non-empty string');
  }
  const now = options.now ?? ((): number => Date.now());
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_EXPERIENCE_HALF_LIFE_MS;
  const filePath = options.filePath;
  const fileFs = options.fs ?? (await createNodeExperienceFs());
  const diagnostics: ExperienceStoreDiagnostic[] = [];
  const index = new ExperienceIndex({
    bucketCap: options.bucketCap ?? DEFAULT_EXPERIENCE_BUCKET_CAP,
    ...(options.onEvict === undefined ? {} : { onEvict: options.onEvict })
  });

  const emit = (diagnostic: ExperienceStoreDiagnostic): void => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  const store: JsonlExperienceStore = {
    filePath,

    async load(): Promise<number> {
      let text: string | undefined;
      try {
        text = await fileFs.readText(filePath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        emit({
          level: 'warn',
          code: 'experience_store_unreadable',
          message: 'could not read the experience log: ' + reason
        });
        return index.size();
      }
      if (text === undefined) {
        return index.size();
      }
      const records = parseLog(text, emit);
      for (const record of records) {
        index.insert(record);
      }
      return records.length;
    },

    async append(records: readonly ExperienceRecord[]): Promise<void> {
      const normalized = normalizeExperienceRecords(records);
      if (normalized.length === 0) {
        return;
      }
      // Durable first: the index only changes once the bytes are on disk, so a
      // failed append can never diverge from the log.
      await fileFs.appendDurable(filePath, normalized.map(encodeRecord).join(''));
      for (const record of normalized) {
        index.insert(record);
      }
    },

    async query(query: ExperienceQuery): Promise<readonly ScoredExperience[]> {
      const scored = executeExperienceQuery(index, query, { now: now(), halfLifeMs });
      return scored.map(toScored);
    },

    async size(level?: JitLevel): Promise<number> {
      return index.size(level);
    },

    async compact(options2: { readonly maxPerBucket: number; readonly halfLifeMs?: number }): Promise<number> {
      const removed = planCompaction(index.snapshotDescending(), {
        maxPerBucket: options2.maxPerBucket,
        ...(options2.halfLifeMs === undefined ? {} : { halfLifeMs: options2.halfLifeMs }),
        now: now()
      });
      if (removed.length === 0) {
        return 0;
      }
      const removedIds = new Set(removed.map((record) => record.id));
      const survivors = index.snapshotDescending().filter((record) => !removedIds.has(record.id));
      await fileFs.replaceAtomic(filePath, survivors.map(encodeRecord).join(''));
      for (const record of removed) {
        index.remove(record.id);
      }
      emit({
        level: 'info',
        code: 'experience_store_compacted',
        message: 'compaction removed ' + String(removed.length) + ' record(s)'
      });
      return removed.length;
    },

    async purge(purgeOptions: { readonly bucket?: string } = {}): Promise<number> {
      const snapshot = index.snapshotDescending();
      const removed =
        purgeOptions.bucket === undefined
          ? snapshot
          : snapshot.filter((record) => record.bucket === purgeOptions.bucket);
      // An unknown bucket is a strict no-op: no rewrite, no diagnostic.
      if (purgeOptions.bucket !== undefined && removed.length === 0) {
        return 0;
      }
      const removedIds = new Set(removed.map((record) => record.id));
      const survivors = snapshot.filter((record) => !removedIds.has(record.id));
      // Global purge also rewrites an empty log, clearing torn/stale bytes.
      if (removed.length > 0 || purgeOptions.bucket === undefined) {
        await fileFs.replaceAtomic(filePath, survivors.map(encodeRecord).join(''));
      }
      for (const record of removed) {
        index.remove(record.id);
      }
      emit({
        level: 'info',
        code: 'experience_store_purged',
        message:
          'purge removed ' +
          String(removed.length) +
          ' record(s)' +
          (purgeOptions.bucket === undefined ? ' from every bucket' : ' from one bucket')
      });
      return removed.length;
    },

    async flush(): Promise<void> {
      const survivors = index.snapshotDescending();
      await fileFs.replaceAtomic(filePath, survivors.map(encodeRecord).join(''));
    },

    export(): AsyncIterable<ExperienceRecord> {
      const snapshot = index.snapshotDescending();
      let position = 0;
      const iterator: AsyncIterator<ExperienceRecord> = {
        next(): Promise<IteratorResult<ExperienceRecord>> {
          const record = snapshot[position];
          if (record === undefined) {
            return Promise.resolve({ done: true, value: undefined as unknown as ExperienceRecord });
          }
          position += 1;
          return Promise.resolve({ done: false, value: toExperienceRecord(record) });
        }
      };
      return {
        [Symbol.asyncIterator](): AsyncIterator<ExperienceRecord> {
          return iterator;
        }
      };
    },

    snapshot(): readonly ExperienceRecord[] {
      return index.snapshotDescending().map(toExperienceRecord);
    },

    diagnostics(): readonly ExperienceStoreDiagnostic[] {
      return [...diagnostics];
    }
  };

  await store.load();
  return store;
}
