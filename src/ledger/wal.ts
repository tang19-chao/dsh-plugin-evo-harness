/**
 * Write-Ahead Log (WAL) and Snapshot Manager for C3 Ledger.
 *
 * Implements ADR-0004 §6:
 * - Append-only ledger.events.jsonl with monotonically increasing sequence numbers.
 * - Periodic state snapshot in ledger.snapshot.json.
 * - Guard against writing to collaborative directories (.agent-teams).
 * - Offline deterministic operation with optional in-memory fallback.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LedgerWalEvent,
  LedgerWalEventType,
  PoolStatus,
  ReservationRecord
} from './types.js';

export interface LedgerSnapshotData {
  readonly snapshotVersion: 1;
  readonly lastSequenceNumber: number;
  readonly timestamp: number;
  readonly generalPool: PoolStatus;
  readonly verificationPool: PoolStatus;
  readonly occupiedSeats: number;
  readonly maxSeats: number;
  /**
   * Work-in-progress reservations at snapshot time. Without these, a snapshot
   * taken while calls are in flight loses the reservation records while the
   * pool totals still include their reserved money: the funds become
   * unreachable and a recovered call cannot be settled or reconciled.
   */
  readonly activeReservations?: readonly ReservationRecord[];
  /**
   * Call ids that own a concurrency seat, so seat retention (including
   * pending-remote and caller-deferred holds) survives a restart with the
   * correct identity, not just a count.
   */
  readonly seatOwners?: readonly string[];
}

export class LedgerWalWriter {
  private readonly storageDir?: string;
  private readonly eventsFilePath?: string;
  private readonly snapshotFilePath?: string;
  private sequenceNumber = 0;
  private inMemoryEvents: LedgerWalEvent[] = [];

  constructor(options: { storageDir?: string; initialSequenceNumber?: number } = {}) {
    this.sequenceNumber = options.initialSequenceNumber ?? 0;

    if (options.storageDir) {
      const normalized = path.resolve(options.storageDir);
      // Security & compliance guard: NEVER write to team collaboration internals
      if (normalized.includes('.agent-teams')) {
        throw new Error(
          `Security violation: WAL storageDir cannot be inside .agent-teams ("${normalized}")`
        );
      }
      this.storageDir = normalized;
      if (!fs.existsSync(normalized)) {
        fs.mkdirSync(normalized, { recursive: true });
      }
      this.eventsFilePath = path.join(normalized, 'ledger.events.jsonl');
      this.snapshotFilePath = path.join(normalized, 'ledger.snapshot.json');
    }
  }

  get currentSequence(): number {
    return this.sequenceNumber;
  }

  /**
   * Move the append counter to at least `sequence`.
   *
   * Recovery replays an existing WAL/snapshot into a FRESH writer whose counter
   * starts at 0. Without this floor, the next append reuses sequence 1..N, and a
   * later replay filters those events out as "older than the snapshot" — silently
   * dropping real reservations. Sequence numbers are the WAL's ordering
   * authority, so they must never go backwards.
   */
  ensureSequenceAtLeast(sequence: number): void {
    if (Number.isFinite(sequence) && sequence > this.sequenceNumber) {
      this.sequenceNumber = Math.floor(sequence);
    }
  }

  get eventsPath(): string | undefined {
    return this.eventsFilePath;
  }

  get snapshotPath(): string | undefined {
    return this.snapshotFilePath;
  }

  append(type: LedgerWalEventType, payload: unknown, timestamp?: number): LedgerWalEvent {
    this.sequenceNumber += 1;
    const now = timestamp ?? Date.now();
    const event: LedgerWalEvent = {
      eventId: `wal_${now}_${this.sequenceNumber}`,
      sequenceNumber: this.sequenceNumber,
      timestamp: now,
      type,
      payload
    };

    this.inMemoryEvents.push(event);

    if (this.eventsFilePath) {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.eventsFilePath, line, 'utf8');
      // ADR-0004 §6.1 requires the WAL to reach stable storage before the
      // caller treats the event as committed. `appendFileSync` only hands the
      // bytes to the OS; without fsync a power loss can lose the tail (including
      // a settlement) while the in-memory ledger already moved the budget.
      // Open the log for append (write-capable) before fsync: Windows rejects
// fsync on a read-only descriptor with EPERM, which made every reservation
// fail on Windows while Linux silently accepted it.
      const fd = fs.openSync(this.eventsFilePath, 'a');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }

    return event;
  }

  writeSnapshot(data: Omit<LedgerSnapshotData, 'snapshotVersion' | 'lastSequenceNumber' | 'timestamp'>): LedgerSnapshotData {
    const snapshot: LedgerSnapshotData = {
      snapshotVersion: 1,
      lastSequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      ...data
    };

    if (this.snapshotFilePath) {
      // Write-then-rename so a crash mid-snapshot leaves the previous complete
      // snapshot in place rather than a truncated JSON file.
      const temporary = this.snapshotFilePath + '.' + String(process.pid) + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
      const fd = fs.openSync(temporary, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.snapshotFilePath);
    }

    return snapshot;
  }

  loadSnapshot(): LedgerSnapshotData | undefined {
    if (!this.snapshotFilePath || !fs.existsSync(this.snapshotFilePath)) {
      return undefined;
    }
    try {
      const content = fs.readFileSync(this.snapshotFilePath, 'utf8');
      return JSON.parse(content) as LedgerSnapshotData;
    } catch {
      return undefined;
    }
  }

  readAllEvents(): LedgerWalEvent[] {
    if (!this.eventsFilePath || !fs.existsSync(this.eventsFilePath)) {
      return [...this.inMemoryEvents];
    }
    const content = fs.readFileSync(this.eventsFilePath, 'utf8');
    const lines = content.split('\n');
    const events: LedgerWalEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index]!.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as LedgerWalEvent;
        if (typeof ev.sequenceNumber !== 'number' || typeof ev.type !== 'string') {
          throw new Error('event is missing sequenceNumber/type');
        }
        events.push(ev);
      } catch (error) {
        // A crash may truncate exactly the final line. Any earlier corruption is
        // NOT a harmless tail: silently skipping it would lose committed budget
        // events and break the conservation identity. Fail closed.
        const isLastNonEmpty = lines.slice(index + 1).every((line) => line.trim().length === 0);
        if (!isLastNonEmpty) {
          throw new Error(
            `WAL corruption at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    return events;
  }

  clearInMemory(): void {
    this.inMemoryEvents = [];
  }
}
