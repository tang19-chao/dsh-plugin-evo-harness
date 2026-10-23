/**
 * In-memory IExperienceStore (plan section 5.1, P1-2).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel, P1-2).
 *
 * The store keeps the canonical records in the inverted index from
 * ../experience-store.ts and answers queries entirely in memory. It is the
 * default driver for tests and for hosts that do not want persistence; the
 * JSONL driver in ./jsonl.store.ts wraps the very same algorithm around a file.
 *
 * The clock and the half-life are injected so retrieval is deterministic; the
 * index itself is a pure function of the appended records.
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
  normalizeExperienceRecords,
  toExperienceRecord,
  type ExperienceEviction,
  type ExperienceStoreDiagnostic,
  type ScoredStoredExperience
} from '../experience-store';

/** Construction options for the in-memory store. */
export interface MemoryExperienceStoreOptions {
  /** Milliseconds since epoch provider; defaults to Date.now. */
  readonly now?: () => number;
  /** Half-life of the retrieval weight in ms; default 30 days, 0 disables decay. */
  readonly halfLifeMs?: number;
  /** Cap per (level, bucket) in the live index; defaults to 200. */
  readonly bucketCap?: number;
  /** Diagnostic sink for store-level notices (compaction). Payload free. */
  readonly onDiagnostic?: (diagnostic: ExperienceStoreDiagnostic) => void;
  /** Called for every record evicted because its bucket exceeded the cap. */
  readonly onEvict?: (eviction: ExperienceEviction) => void;
}

/** The store contract plus its in-memory diagnostics surface. */
export interface MemoryExperienceStore {
  append(records: readonly ExperienceRecord[]): Promise<void>;
  query(query: ExperienceQuery): Promise<readonly ScoredExperience[]>;
  size(level?: JitLevel): Promise<number>;
  compact(options: { readonly maxPerBucket: number; readonly halfLifeMs?: number }): Promise<number>;
  export(): AsyncIterable<ExperienceRecord>;
  /** Snapshot of the live records, newest first. */
  snapshot(): readonly ExperienceRecord[];
  /** Diagnostics observed by this store (payload free). */
  diagnostics(): readonly ExperienceStoreDiagnostic[];
  /**
   * Drop every record, or only records whose state bucket matches. Resolves to
   * the number of records removed. Used by /evo jit reset (P3-E2).
   */
  purge(options?: { readonly bucket?: string }): Promise<number>;
}

function toScored(entry: ScoredStoredExperience): ScoredExperience {
  return {
    record: toExperienceRecord(entry.record),
    similarity: entry.similarity,
    weight: entry.weight
  };
}

/** Create an in-memory experience store. */
export function createMemoryExperienceStore(
  options: MemoryExperienceStoreOptions = {}
): MemoryExperienceStore {
  const now = options.now ?? ((): number => Date.now());
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_EXPERIENCE_HALF_LIFE_MS;
  const diagnostics: ExperienceStoreDiagnostic[] = [];
  const index = new ExperienceIndex({
    bucketCap: options.bucketCap ?? DEFAULT_EXPERIENCE_BUCKET_CAP,
    ...(options.onEvict === undefined ? {} : { onEvict: options.onEvict })
  });

  const emit = (diagnostic: ExperienceStoreDiagnostic): void => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  const store: MemoryExperienceStore = {
    async append(records: readonly ExperienceRecord[]): Promise<void> {
      const normalized = normalizeExperienceRecords(records);
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
      const removed = index.pruneDecayed({
        maxPerBucket: options2.maxPerBucket,
        ...(options2.halfLifeMs === undefined ? {} : { halfLifeMs: options2.halfLifeMs }),
        now: now()
      });
      if (removed.length > 0) {
        emit({
          level: 'info',
          code: 'experience_store_compacted',
          message: 'compaction removed ' + String(removed.length) + ' record(s)'
        });
      }
      return removed.length;
    },

    async purge(purgeOptions: { readonly bucket?: string } = {}): Promise<number> {
      const snapshot = index.snapshotDescending();
      const removed =
        purgeOptions.bucket === undefined
          ? snapshot
          : snapshot.filter((record) => record.bucket === purgeOptions.bucket);
      if (removed.length === 0) {
        return 0;
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

    export(): AsyncIterable<ExperienceRecord> {
      // A fresh snapshot and cursor per call, so concurrent iterations of the
      // same store never share position.
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
  return store;
}
