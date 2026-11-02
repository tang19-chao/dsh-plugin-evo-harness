/**
 * LEDGER-11 (audit rounds 1+2): every admission decision lives in ONE manager's
 * memory, while the WAL/snapshot/call index are shared files in `storageDir`.
 * Nothing serialized writers, so two processes could each grant the full budget
 * (the round-2 repro reserved 9,000,000u twice against a 10,000,000u pool) and
 * concurrently clobber `ledger.snapshot.json`.
 *
 * WHAT THIS PINS (the fix contract):
 *
 *   - opening a storageDir records a writer lock beside the WAL;
 *   - a lock held by a DIFFERENT LIVE pid on this host is REFUSED
 *     (`STORAGE_DIR_ALREADY_OPEN`) before any state is built — the double-open
 *     itself, not merely its symptom;
 *   - a lock naming ANY other host is refused too (remote liveness cannot be
 *     checked, so it fails closed);
 *   - a lock left by a DEAD pid is taken over (crash recovery keeps working),
 *     and this process's own lock is re-taken (the in-process restart flow);
 *   - a storageDir-less manager is unaffected (no lock, nothing shared);
 *   - the module header documents the single-writer assumption the lock can
 *     only approximate (a tripwire, never a correctness gate).
 *
 * Cross-HOST takeover (the foreign-hostname branch) cannot be exercised here:
 * the refusal IS the intended behaviour, and the test would need a real second
 * host. The dead-pid takeover covers the same code path's fall-through.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as currentHostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLedgerReservationManager,
  LedgerError,
  type LedgerReservationManager,
  type ModelRateCard
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'ledger-11/lock-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const LOCK_FILE = 'ledger.writer.lock';

/** A pid that is provably not running (ESRCH on every supported platform). */
const DEAD_PID = 4_000_000;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-11-lock-'));
  tempDirs.push(dir);
  return dir;
}

function makeManager(storageDir?: string): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    defaultRateCard: RATE_CARD,
    ...(storageDir === undefined ? {} : { storageDir })
  });
}

function lockContents(dir: string): { pid: number; hostname: string; takenAt: number } {
  return JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as {
    pid: number;
    hostname: string;
    takenAt: number;
  };
}

function writeLock(dir: string, contents: { pid: number; hostname: string }): void {
  writeFileSync(
    join(dir, LOCK_FILE),
    JSON.stringify({ pid: contents.pid, hostname: contents.hostname, takenAt: Date.now() }, null, 2) + '\n',
    'utf8'
  );
}

function codeOf(thrown: unknown): string | undefined {
  return thrown instanceof LedgerError ? thrown.code : undefined;
}

describe('LEDGER-11: a storageDir has one writer', () => {
  it('records this process as the writer when the storageDir is opened', () => {
    const dir = tempDir();
    const manager = makeManager(dir);
    expect(manager.getBudgetStatus().generalPool.totalMicros).toBe(10_000_000);
    const lock = lockContents(dir);
    expect(lock.pid).toBe(process.pid);
    expect(lock.hostname).toBe(currentHostname());
    // The lock lives BESIDE the WAL, not inside it.
    expect(manager.getWalWriter().eventsPath).toBe(join(dir, 'ledger.events.jsonl'));
  });

  it('refuses a second LIVE writer on the same host (the audited double-open)', () => {
    const dir = tempDir();
    makeManager(dir);
    // Another process that is genuinely alive: the test runner's parent is
    // alive and is not this process.
    const liveForeignPid = process.ppid;
    expect(liveForeignPid).not.toBe(process.pid);
    writeLock(dir, { pid: liveForeignPid, hostname: currentHostname() });

    let thrown: unknown;
    try {
      makeManager(dir);
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('STORAGE_DIR_ALREADY_OPEN');
    expect((thrown as Error).message).toContain(String(liveForeignPid));
    expect((thrown as Error).message).toContain('SINGLE writer');
  });

  it('refuses a lock naming another host, because remote liveness cannot be checked', () => {
    const dir = tempDir();
    makeManager(dir);
    writeLock(dir, { pid: process.pid, hostname: 'some-other-host.example' });
    let thrown: unknown;
    try {
      makeManager(dir);
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('STORAGE_DIR_ALREADY_OPEN');
    expect((thrown as Error).message).toContain('some-other-host.example');
    // The message names the escape hatch instead of leaving an operator stuck.
    expect((thrown as Error).message).toContain(LOCK_FILE);
  });

  it('takes over a lock left by a dead process (crash recovery still opens)', () => {
    const dir = tempDir();
    writeLock(dir, { pid: DEAD_PID, hostname: currentHostname() });
    const manager = makeManager(dir);
    expect(manager.getWalWriter().currentSequence).toBe(0);
    const lock = lockContents(dir);
    expect(lock.pid).toBe(process.pid);
  });

  it('re-takes this process’s own lock (the in-process restart flow)', () => {
    const dir = tempDir();
    const before = makeManager(dir);
    // A restart in the SAME process: the old lock still names us.
    const after = makeManager(dir);
    expect(lockContents(dir).pid).toBe(process.pid);
    after.recoverFromWal();
    expect(after.verifyConservationLaw().balanced).toBe(true);
    expect(before.getBudgetStatus().generalPool.totalMicros).toBe(10_000_000);
  });

  it('leaves a storageDir-less manager unaffected (nothing is shared)', () => {
    const manager = makeManager();
    expect(manager.getWalWriter().eventsPath).toBeUndefined();
    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
  });

  it('applies the WAL’s .agent-teams guard BEFORE writing the lock file', () => {
    // The lock is a file like any other: it must never be created inside team
    // collaboration internals. The guard runs first, so nothing is written.
    const forbidden = join(tmpdir(), '.agent-teams', 'ledger-lock-' + String(process.pid));
    let thrown: unknown;
    try {
      makeManager(forbidden);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error | undefined)?.message ?? '').toContain('Security violation');
    expect(existsSync(join(forbidden, LOCK_FILE))).toBe(false);
  });

  it('the module documents the single-writer assumption the lock only approximates', () => {
    const source = readFileSync('src/ledger/reservation-manager.ts', 'utf8');
    expect(source).toContain('SINGLE-WRITER ASSUMPTION');
    // The lock is a tripwire, not a correctness gate — the prose says so.
    expect(source).toContain('tripwire, not a correctness gate');
  });
});
