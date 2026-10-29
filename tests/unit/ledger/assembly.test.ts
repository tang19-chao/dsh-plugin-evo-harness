/**
 * P3-A: the ledger ASSEMBLY contract (src/ledger/assembly.ts).
 *
 * These tests exercise the ONE supported construction path. They deliberately do
 * not re-test the manager's accounting rules (those live in the existing
 * reservation-manager suites); they pin the assembly boundary that the executor
 * and any host share:
 *   - ADR-0004 section 9.2 defaults are applied exactly once, in one place;
 *   - impossible budgets / rate cards / watermarks / route bounds are refused
 *     loudly instead of being clamped or silently ignored;
 *   - `enforceHardBounds: true` is refused in THIS build instead of becoming a
 *     silent no-op (hard-bound admission is the follow-up split, not this task);
 *   - "not enabled" degrades to `undefined` (unmetered), never to a fabricated
 *     "metered" manager.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleAgentLoopLedger,
  createLedgerReservationManager,
  createUsagePayload,
  DEFAULT_LEDGER_PHASE,
  describeLedgerAssembly,
  LEDGER_ASSEMBLY_DEFAULTS,
  LedgerAssemblyError,
  resolveLedgerAssemblyOptions,
  type LedgerAssemblyOptions,
  type SettleResult
} from '../../../src/ledger';

/** A minimal rate card: 1u per input token, 2u per output token. */
const RATE_CARD = {
  modelId: 'test/model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

/** Assert a settlement produced a ledger event, then return it (no non-null masking). */
function requireLedgerEvent(result: SettleResult) {
  if (result.ledgerEvent === undefined) {
    throw new Error('expected the settlement to produce a ledger event');
  }
  return result.ledgerEvent;
}

/** Run `run` and return the LedgerAssemblyError it threw (or undefined). */
function catchAssemblyError(run: () => unknown): LedgerAssemblyError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerAssemblyError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

describe('resolveLedgerAssemblyOptions: defaults and validation', () => {
  it('applies the ADR-0004 section 9.2 defaults to an enabled config', () => {
    const options = resolveLedgerAssemblyOptions({ enabled: true });
    expect(options.enabled).toBe(true);
    expect(options.meteringMode).toBe('observe');
    expect(options.generalBudgetMicros).toBe(LEDGER_ASSEMBLY_DEFAULTS.generalBudgetMicros);
    expect(options.verificationReserveMicros).toBe(LEDGER_ASSEMBLY_DEFAULTS.verificationReserveMicros);
    expect(options.maxConcurrencySeats).toBe(LEDGER_ASSEMBLY_DEFAULTS.maxConcurrencySeats);
    expect(options.estimatedCostMicros).toBe(LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros);
    expect(options.phase).toBe(DEFAULT_LEDGER_PHASE);
    expect(options.allowUnboundedRiskOverride).toBe(false);
    expect(options.defaultRateCard).toBeUndefined();
  });

  it('keeps explicit values instead of overwriting them with defaults', () => {
    const options = resolveLedgerAssemblyOptions({
      enabled: true,
      generalBudgetMicros: 42,
      verificationReserveMicros: 7,
      maxConcurrencySeats: 2,
      estimatedCostMicros: 99,
      phase: 'compose',
      defaultRateCard: RATE_CARD
    });
    expect(options.generalBudgetMicros).toBe(42);
    expect(options.verificationReserveMicros).toBe(7);
    expect(options.maxConcurrencySeats).toBe(2);
    expect(options.estimatedCostMicros).toBe(99);
    expect(options.phase).toBe('compose');
    expect(options.defaultRateCard).toEqual(RATE_CARD);
  });

  /**
   * Every entry is DELIBERATELY invalid input. The string budget exists because
   * a JavaScript host can bypass the TypeScript type; the assembly must still
   * fail closed instead of coercing it. `as unknown as` is used ONLY to
   * construct that illegal input — never on a value returned by the code under
   * test.
   */
  const INVALID_BUDGET_CONFIGS: readonly {
    readonly label: string;
    readonly config: LedgerAssemblyOptions;
  }[] = [
    { label: 'a negative budget', config: { generalBudgetMicros: -1 } },
    { label: 'a fractional budget', config: { generalBudgetMicros: 1.5 } },
    {
      label: 'a non-numeric budget',
      config: { generalBudgetMicros: '1000' } as unknown as LedgerAssemblyOptions
    },
    { label: 'a NaN budget', config: { generalBudgetMicros: Number.NaN } },
    { label: 'a negative seat count', config: { maxConcurrencySeats: -2 } },
    { label: 'a fractional estimate', config: { estimatedCostMicros: 0.5 } },
    { label: 'an empty storage dir', config: { storageDir: '   ' } }
  ];
  for (const { label, config } of INVALID_BUDGET_CONFIGS) {
    it('refuses ' + label + ' loudly instead of clamping it', () => {
      const thrown = catchAssemblyError(() => resolveLedgerAssemblyOptions({ enabled: true, ...config }));
      expect(thrown?.code).toBe('LEDGER_ASSEMBLY_INVALID');
    });
  }

  it('refuses a malformed rate card (the pricing layer cannot tolerate it)', () => {
    for (const card of [
      { ...RATE_CARD, modelId: '' },
      { ...RATE_CARD, inputRatePerMillion: -1 },
      { ...RATE_CARD, conservativeFallbackCostMicros: 0 },
      { ...RATE_CARD, reasoningSeparatelyBilled: 'no' }
    ]) {
      const thrown = catchAssemblyError(() =>
        resolveLedgerAssemblyOptions({ enabled: true, defaultRateCard: card as never })
      );
      expect(thrown?.code).toBe('LEDGER_ASSEMBLY_INVALID');
    }
  });

  it('refuses watermarks whose warning ratio exceeds the critical ratio', () => {
    const thrown = catchAssemblyError(() =>
      resolveLedgerAssemblyOptions({
        enabled: true,
        watermarks: { warningRatio: 0.95, criticalRatio: 0.8 }
      })
    );
    expect(thrown?.code).toBe('LEDGER_ASSEMBLY_INVALID');
  });

  it('refuses a route bound without a route id', () => {
    const thrown = catchAssemblyError(() =>
      resolveLedgerAssemblyOptions({
        enabled: true,
        routeBounds: [{ maxOutputTokens: 100 } as never]
      })
    );
    expect(thrown?.code).toBe('LEDGER_ASSEMBLY_INVALID');
  });

  it('refuses an unbounded-risk override that carries no stop-loss ceiling', () => {
    const thrown = catchAssemblyError(() =>
      resolveLedgerAssemblyOptions({ enabled: true, allowUnboundedRiskOverride: true })
    );
    expect(thrown?.code).toBe('LEDGER_ASSEMBLY_INVALID');
  });

  it('turns hard limits on ONLY through the explicit enforceHardBounds opt-in', () => {
    // P3-A2: the switch is wired. Default/absent/false => observe; only an
    // explicit true enables enforcement, and nothing else is consulted.
    expect(resolveLedgerAssemblyOptions({ enabled: true }).meteringMode).toBe('observe');
    expect(resolveLedgerAssemblyOptions({ enabled: true, enforceHardBounds: false }).meteringMode).toBe('observe');
    expect(resolveLedgerAssemblyOptions({ enabled: true, enforceHardBounds: true }).meteringMode).toBe('enforce');

    // Observe: zero budget is observed, not enforced.
    const observeManager = createLedgerReservationManager({ enabled: true, generalBudgetMicros: 0 });
    const observed = observeManager.reserve({
      callId: 'observe-zero-budget',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    expect(observed.granted).toBe(true);
    expect(observed.observedRejection).toBe('insufficient_budget');

    // Enforce: the same configuration denies.
    const enforceManager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 0
    });
    const denied = enforceManager.reserve({
      callId: 'enforce-zero-budget',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    expect(denied.granted).toBe(false);
    expect(denied.rejectionReason).toBe('insufficient_budget');
  });
});

describe('createLedgerReservationManager: one factory, real accounting', () => {
  it('defaults to OBSERVE: the factory reserves nothing and never denies', () => {
    const manager = createLedgerReservationManager();
    expect(manager.getMeteringMode()).toBe('observe');
    const reserved = manager.reserve({
      callId: 'call-defaults',
      phase: DEFAULT_LEDGER_PHASE,
      pool: 'general',
      estimatedCostMicros: LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros,
      requiresSeat: true
    });
    expect(reserved.granted).toBe(true);
    expect(reserved.observed).toBe(true);
    // Observation ring-fences no money and takes no seat.
    expect(reserved.reservedCostMicros).toBe(0);
    expect(reserved.seatAcquired).toBe(false);

    const settled = manager.settle({
      callId: 'call-defaults',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded'
    });
    expect(settled.settled).toBe(true);
    // Nothing was reserved, no usage/rate card: booked cost is 0, and the status
    // says the manager is metered (not absent) with 0 measured calls.
    expect(settled.incurredCostMicros).toBe(0);
    const status = manager.getMeteringStatus();
    expect(status.metered).toBe(true);
    expect(status.reserveAttempts).toBe(1);
    // No provider usage/semantics: the call is UNKNOWN, never measured.
    expect(status.measuredCalls).toBe(0);
    expect(status.unknownCalls).toBe(1);
  });

  it('ENFORCE (explicit opt-in) keeps the pre-P3-A2 accounting contract', () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true
    });
    expect(manager.getMeteringMode()).toBe('enforce');
    const reserved = manager.reserve({
      callId: 'call-enforced',
      phase: DEFAULT_LEDGER_PHASE,
      pool: 'general',
      estimatedCostMicros: LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros,
      requiresSeat: true
    });
    expect(reserved.granted).toBe(true);
    expect(reserved.reservedCostMicros).toBe(LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros);
    const settled = manager.settle({
      callId: 'call-enforced',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded'
    });
    expect(settled.incurredCostMicros).toBe(LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(
      LEDGER_ASSEMBLY_DEFAULTS.estimatedCostMicros
    );
  });

  it('prices a settled call with the assembled rate card (measured provenance)', () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const reserved = manager.reserve({
      callId: 'call-priced',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false
    });
    expect(reserved.granted).toBe(true);

    const semantics = { inputIncludesCacheRead: true, outputIncludesReasoning: true };
    const settled = manager.settle({
      callId: 'call-priced',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 1_000, output: 500, semantics })
    });
    // 1000 input * 1u/token + 500 output * 2u/token = 2000u.
    expect(settled.incurredCostMicros).toBe(2_000);
    const event = requireLedgerEvent(settled);
    expect(event.cost.provenance).toBe('measured');
  });

  it('keeps undeclared counting semantics at provenance "unknown" (never measured)', () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const reserved = manager.reserve({
      callId: 'call-unknown-semantics',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false
    });
    const settled = manager.settle({
      callId: 'call-unknown-semantics',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      // No countingSemantics: ADR-0004 section 7.3 forces provenance unknown
      // and a non-zero conservative floor; it must never be reported measured.
      usage: createUsagePayload({ input: 1_000, output: 500 })
    });
    const event = requireLedgerEvent(settled);
    expect(event.cost.provenance).toBe('unknown');
    expect(event.cost.conservative).toBe(true);
    expect(settled.incurredCostMicros).toBeGreaterThan(0);
  });

  it('honours storageDir through the WAL writer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3a-ledger-assembly-'));
    try {
      const manager = createLedgerReservationManager({ enabled: true, storageDir: dir });
      const reserved = manager.reserve({
        callId: 'call-wal',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 10,
        requiresSeat: false
      });
      expect(reserved.granted).toBe(true);
      expect(manager.getWalWriter().currentSequence).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assembleAgentLoopLedger: opt-in and honest degradation', () => {
  it('is undefined when no ledger is configured', () => {
    expect(assembleAgentLoopLedger()).toBeUndefined();
  });

  it('is undefined when enabled is false or omitted', () => {
    expect(assembleAgentLoopLedger({ enabled: false })).toBeUndefined();
    expect(assembleAgentLoopLedger({ generalBudgetMicros: 1_000 })).toBeUndefined();
  });

  it('assembles a manager only for enabled:true and describes what it resolved', () => {
    const assembly = assembleAgentLoopLedger({
      enabled: true,
      generalBudgetMicros: 123_000,
      verificationReserveMicros: 45_000,
      maxConcurrencySeats: 3,
      estimatedCostMicros: 777
    });
    expect(assembly).toBeDefined();
    expect(assembly?.options.generalBudgetMicros).toBe(123_000);
    expect(assembly?.options.verificationReserveMicros).toBe(45_000);
    expect(assembly?.options.maxConcurrencySeats).toBe(3);
    expect(assembly?.options.estimatedCostMicros).toBe(777);

    if (assembly === undefined) {
      throw new Error('expected an enabled ledger to assemble');
    }
    const summary = describeLedgerAssembly(assembly);
    expect(summary).toContain('general=123000u');
    expect(summary).toContain('verification=45000u');
    expect(summary).toContain('seats=3');
    expect(summary).toContain('per-call estimate=777u');
    expect(summary).toContain('hard bounds: not enforced in this build');
  });

  it('fails at assembly time for an invalid enabled configuration', () => {
    expect(() => assembleAgentLoopLedger({ enabled: true, maxConcurrencySeats: -1 })).toThrow(
      LedgerAssemblyError
    );
  });
});
