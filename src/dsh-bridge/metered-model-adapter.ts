/**
 * P3-B: the unified MeteredModelAdapter and the runtime call-count gate.
 *
 * WHY THIS MODULE EXISTS
 *   Before P3-B every production stage (proposer, composer, reflector, dreamer,
 *   step-evaluator, logit sources, the same-process probe branch) called
 *   `model.complete(...)` directly. A call could therefore be unmetered, and a
 *   probe branch could be mislabelled as 'compose' with nothing to catch it.
 *   This module is the ONE boundary every stage routes through:
 *
 *     const model = createMeteredModelAdapter(options.model, 'propose', options.metering);
 *     const response = await model.call(request);   // call() — never .complete()
 *
 *   The adapter:
 *     1. ENFORCES the stage's real ModelPurpose. A request labelled with a
 *        different purpose throws `METERED_MODEL_PURPOSE_MISMATCH` instead of
 *        silently mis-billing the call (this is what fixes probe-as-compose).
 *     2. Records one `ModelCallRecord` per attempt (success, model failure,
 *        budget denial) in a `ModelCallRegistry`. The registry is the RUNTIME
 *        COUNT GATE: a call that bypasses this adapter is missing from the
 *        registry while the underlying model still sees it, which the tests
 *        assert against.
 *     3. Optionally reserves/settles through the P3-A ledger assembly, so the
 *        recorded cost keeps measured/estimated/unknown provenance separate. With
 *        no ledger it records `provenance: 'none'` and status `'unmetered'` —
 *        it never pretends the call was costed.
 *
 * SCOPE
 *   Cost/limit SEMANTICS stay owned by the ledger: this adapter does not invent
 *   limits. A ledger reservation denial is surfaced as `METERED_MODEL_BUDGET_DENIED`
 *   so the caller's existing failure path decides; the default (no ledger) path
 *   is byte-for-byte the previous behaviour apart from the call record.
 *
 * P3-C TWO-PHASE WIRING (the P3-C §7.1 gap this adapter closes)
 *   With a ledger, every call now goes through `TwoPhaseSettlement`:
 *     - `beginCall` persists callId -> reservationId BEFORE the provider call;
 *     - `settleCall` settles INTERIM whenever the outcome does not prove the
 *       remote terminated (a local abort/cancel), holding the money, and settles
 *       FINAL only for a confirmed outcome;
 *     - `reconcileLateUsage` merges late usage into the ORIGINAL callId and never
 *       opens a new reservation. An unknown origin is refused with
 *       `LATE_USAGE_UNKNOWN_CALL`; the only sanctioned cross-callId booking is
 *       `bookNewAttempt`, which requires the explicit `new-attempt` marker.
 *   None of this denies anything or changes the probe/caller outcome: with a
 *   ledger in observe mode (the assembly default) nothing is refused, and without
 *   a ledger there is nothing to settle. The failure of a settlement is recorded
 *   on the call record (`settle_failed`) instead of being swallowed.
 */

import type {
  IModelAdapter,
  ModelPurpose,
  ModelRequest,
  ModelResponse,
  TokenUsage
} from '../types/contracts';
import {
  assembleAgentLoopLedger,
  dshUsageToProviderPayload,
  TwoPhaseLedgerError,
  type CountingSemantics,
  type ExecutionOutcome,
  type LateUsageEvent,
  type LateUsageSettlement,
  type LedgerAssemblyOptions,
  type LedgerCallIdentity,
  type LedgerPhase,
  type ProviderUsagePayload,
  type RawDshUsageLike,
  type TwoPhaseSettlement
} from '../ledger/index.js';

/** The production stage a call belongs to. One stage maps to exactly one purpose. */
export type MeteringStage =
  | 'propose'
  | 'compose'
  | 'reflect'
  | 'dream'
  | 'evaluate_steps'
  | 'logit_probe'
  | 'probe';

/** Cost provenance exactly as the ledger reports it; 'none' means NO ledger. */
export type MeteredCostProvenance = 'measured' | 'estimated' | 'unknown' | 'none';

/** Stage -> real ModelPurpose. A mismatch at call time is a hard error. */
export const STAGE_PURPOSE: Readonly<Record<MeteringStage, ModelPurpose>> = Object.freeze({
  propose: 'propose',
  compose: 'compose',
  reflect: 'reflect',
  dream: 'dream_policy',
  evaluate_steps: 'evaluate_steps',
  // The logit source's capability probe is probe traffic, NOT compose judging.
  logit_probe: 'probe',
  probe: 'probe'
});

/** Stage -> ledger lifecycle phase (ADR-0003 §7.5 / ADR-0004). */
export const STAGE_LEDGER_PHASE: Readonly<Record<MeteringStage, LedgerPhase>> = Object.freeze({
  propose: 'compose',
  compose: 'compose',
  reflect: 'reflect',
  dream: 'dream',
  evaluate_steps: 'judge',
  logit_probe: 'probe',
  probe: 'probe'
});

/** One recorded attempt. Exactly one record per call to `call()`, on every path. */
export interface ModelCallRecord {
  readonly callId: string;
  /**
   * P3-C: the ledger reservation this call was wired to, when a ledger is
   * present. It is the key a host must quote when late usage arrives — never a
   * freshly generated callId.
   */
  readonly reservationId?: string;
  /**
   * P3-C: which settlement phase ran. 'interim' means the money is HELD pending
   * reconciliation (remote termination unconfirmed), so `incurredCostMicros` is
   * deliberately absent and the held amount is in `heldCostMicros`.
   */
  readonly settlement?: 'final' | 'interim' | 'none';
  readonly stage: MeteringStage;
  readonly purpose: ModelPurpose;
  readonly ledgerPhase: LedgerPhase;
  readonly outcome: ExecutionOutcome;
  readonly durationMs: number;
  readonly modelId?: string;
  readonly usage?: TokenUsage;
  /** The amount ring-fenced before the call (0 when no ledger / denied). */
  readonly reservedMicros: number;
  /** The settled cost, when a FINAL settlement booked money. */
  readonly incurredCostMicros?: number;
  /** P3-C: cost computed at an INTERIM settlement but not booked yet (held in the pool). */
  readonly heldCostMicros?: number;
  /** Separates measured from estimated from unknown; never upgraded. */
  readonly provenance: MeteredCostProvenance;
  readonly error?: string;
}

/** Aggregate view for the runtime count gate and status surfaces. */
export interface MeteredModelStats {
  readonly attempted: number;
  readonly reserved: number;
  readonly settled: number;
  readonly denied: number;
  readonly modelFailures: number;
  readonly settleFailures: number;
  /** P3-C: late-usage events merged into their original callId by this stage. */
  readonly lateUsageSettlements: number;
  readonly costMicros: number;
  readonly measuredCalls: number;
  readonly estimatedCalls: number;
  readonly unknownCalls: number;
}

/** Explicit failure codes; assertions never grep prose. */
export type MeteredModelErrorCode =
  | 'METERED_MODEL_PURPOSE_MISMATCH'
  | 'METERED_MODEL_BUDGET_DENIED'
  | 'METERED_MODEL_AMBIGUOUS_LEDGER';

export class MeteredModelError extends Error {
  readonly code: MeteredModelErrorCode;

  constructor(code: MeteredModelErrorCode, message: string) {
    super('[' + code + '] ' + message);
    this.name = 'MeteredModelError';
    this.code = code;
  }
}

/**
 * Collects call records across stages. A host that wants a run-wide trace
 * passes ONE registry to every stage; tests use it as the runtime count gate.
 * Records are bounded (oldest dropped) so a long-lived process cannot leak.
 */
export class ModelCallRegistry {
  private static readonly MAX_RECORDS = 5_000;
  private readonly records: ModelCallRecord[] = [];
  private droppedCount = 0;

  record(entry: ModelCallRecord): void {
    this.records.push(entry);
    if (this.records.length > ModelCallRegistry.MAX_RECORDS) {
      this.records.splice(0, this.records.length - ModelCallRegistry.MAX_RECORDS);
      this.droppedCount += 1;
    }
  }

  /** Records evicted by the bounded ring (observability of loss, not silence). */
  get dropped(): number {
    return this.droppedCount;
  }

  snapshot(): readonly ModelCallRecord[] {
    return [...this.records];
  }

  get size(): number {
    return this.records.length;
  }

  countsByStage(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const entry of this.records) {
      counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
    }
    return counts;
  }

  countsByPurpose(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const entry of this.records) {
      counts[entry.purpose] = (counts[entry.purpose] ?? 0) + 1;
    }
    return counts;
  }

  totalCostMicros(): number {
    return this.records.reduce((sum, entry) => sum + (entry.incurredCostMicros ?? 0), 0);
  }

  clear(): void {
    this.records.length = 0;
  }
}

/**
 * Process-wide default registry.
 *
 * Production stages are constructed by the plugin entrypoint, which does not
 * accept per-stage metering options yet. Without a default, their call records
 * would be private and invisible — "collected but not traceable". Every adapter
 * therefore reports to this bounded registry unless a host injects its own, so a
 * run-wide call log always exists (and tests can assert against it).
 */
const GLOBAL_MODEL_CALL_REGISTRY = new ModelCallRegistry();

/** The default registry every un-wired stage reports to. */
export function globalModelCallRegistry(): ModelCallRegistry {
  return GLOBAL_MODEL_CALL_REGISTRY;
}

/** Wiring options shared by every stage. All optional: the default records into the global registry. */
export interface MeteredModelOptions {
  /** Ledger assembly config (P3-A); absent keeps cost unknown, never "measured". */
  readonly ledger?: LedgerAssemblyOptions;
  /**
   * A pre-built two-phase settlement to share across stages; mutually exclusive
   * with `ledger`.
   *
   * P3-4 (rev5 t12, structural debt B): replaces the old `ledgerManager`
   * injection. The adapter must never hold the mutable manager; callers migrate
   * with `twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:<stage>' })`.
   */
  readonly ledgerSettlement?: TwoPhaseSettlement;
  /** Shared call registry (the runtime count gate). Defaults to a private one. */
  readonly registry?: ModelCallRegistry;
  /** Injected clock for deterministic records. */
  readonly now?: () => number;
  /** Injected call-id factory for deterministic records. */
  readonly idFactory?: () => string;
}

/** What a stage holds: the sanctioned call surface plus its observable records. */
export interface MeteredModelAdapter extends IModelAdapter {
  readonly stage: MeteringStage;
  readonly purpose: ModelPurpose;
  readonly ledgerPhase: LedgerPhase;
  /** Metering state; 'unmetered' means no ledger, and cost provenance is 'none'. */
  readonly metering: 'unmetered' | 'observed';
  /** The sanctioned call surface. Stages call THIS, not `complete`. */
  call(request: ModelRequest): Promise<ModelResponse>;
  records(): readonly ModelCallRecord[];
  stats(): MeteredModelStats;
  /**
   * P3-C: the durable callId -> reservationId identities this stage created. A
   * host quotes one of these callIds when late usage for it arrives.
   */
  callIdentities(): readonly LedgerCallIdentity[];
  /**
   * P3-C: merge late usage into the ORIGINAL call (ledger `reconcileLateUsage`).
   * Never opens a new ledger call: an unknown origin is refused with
   * `LATE_USAGE_UNKNOWN_CALL`, so the cross-callId double-booking path is closed.
   */
  reconcileLateUsage(event: LateUsageEvent): LateUsageSettlement;
  /** All late-usage merges this stage performed, in arrival order. */
  lateUsageSettlements(): readonly LateUsageSettlement[];
  /**
   * P3-C: the ONLY sanctioned way to book usage whose origin is unreachable.
   * Requires the explicit `new-attempt` marker plus a reason, and records both.
   */
  bookNewAttempt(event: LateUsageEvent): LateUsageSettlement;
}

let callSequence = 0;

/** Read one metadata field without letting a proxy throw. */
function metadataString(metadata: ModelRequest['metadata'], key: string): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  try {
    const value: unknown = (metadata as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the ledger usage payload, but NEVER invent counting semantics.
 *
 * `dshUsageToProviderPayload` defaults to the DSH semantics; that default is a
 * guess. P3-C owns the "semantics only from provider metadata" rule, so here the
 * semantics are stripped unless the response explicitly carried them: the ledger
 * then records provenance 'unknown' with its conservative floor instead of
 * silently claiming 'measured'.
 */
function ledgerUsagePayload(
  rawUsage: RawDshUsageLike | undefined,
  semantics: CountingSemantics | undefined
): ProviderUsagePayload | undefined {
  if (rawUsage === undefined) {
    return undefined;
  }
  const payload = dshUsageToProviderPayload(rawUsage, semantics);
  if (semantics !== undefined) {
    return payload;
  }
  const { countingSemantics: _omitted, ...rest } = payload;
  return rest;
}

function outcomeOf(response: ModelResponse): ExecutionOutcome {
  return response.finishReason === 'error' ? 'failed' : 'succeeded';
}

function outcomeOfError(error: unknown): ExecutionOutcome {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  return name.includes('abort') || name.includes('cancel') ? 'cancelled' : 'failed';
}

/**
 * Create the metered adapter for one stage.
 *
 * `stage` is required and binding: it fixes the expected purpose, so a caller
 * cannot relabel probe traffic as compose (or vice versa) without failing loudly.
 */
export function createMeteredModelAdapter(
  inner: IModelAdapter,
  stage: MeteringStage,
  options: MeteredModelOptions = {}
): MeteredModelAdapter {
  if (options.ledger !== undefined && options.ledgerSettlement !== undefined) {
    throw new MeteredModelError(
      'METERED_MODEL_AMBIGUOUS_LEDGER',
      'pass either ledger configuration or a pre-built settlement, not both'
    );
  }
  const assembly = assembleAgentLoopLedger(options.ledger);
  const metering: 'unmetered' | 'observed' =
    options.ledgerSettlement !== undefined || assembly !== undefined ? 'observed' : 'unmetered';
  const purpose = STAGE_PURPOSE[stage];
  const ledgerPhase = STAGE_LEDGER_PHASE[stage];
  const now = options.now ?? ((): number => Date.now());
  const registry = options.registry ?? GLOBAL_MODEL_CALL_REGISTRY;
  const localRecords: ModelCallRecord[] = [];
  const estimatedCostMicros = assembly?.options.estimatedCostMicros ?? 10_000;
  const routeId = assembly?.options.routeId;
  const rateCard = assembly?.options.defaultRateCard;
  const stageRecords = (): readonly ModelCallRecord[] => [...localRecords];

  // P3-C: the ONE sanctioned call lifecycle for this stage. It owns the durable
  // callId -> reservationId mapping and decides interim vs final from the outcome,
  // so this adapter cannot settle an unconfirmed remote termination as final.
  // P3-4 (structural debt B): the coordinator arrives PRE-BUILT from the assembly
  // (or from the caller); no manager is held here.
  const settlement: TwoPhaseSettlement | undefined =
    options.ledgerSettlement ?? assembly?.settlement;

  /**
   * Authoritative BOOKED figure per callId. An interim settlement books nothing,
   * and a late-usage merge REPLACES the figure, so summing the per-call records
   * would double count. This map is what `stats().costMicros` reports.
   */
  const bookedByCall = new Map<string, number>();
  const lateUsageRecords: LateUsageSettlement[] = [];

  const stats = (): MeteredModelStats => {
    const records = stageRecords();
    let reserved = 0;
    let settled = 0;
    let denied = 0;
    let modelFailures = 0;
    let settleFailures = 0;
    let costMicros = 0;
    let measuredCalls = 0;
    let estimatedCalls = 0;
    let unknownCalls = 0;
    for (const booked of bookedByCall.values()) {
      costMicros += booked;
    }
    for (const record of records) {
      if (record.reservedMicros > 0) {
        reserved += 1;
      }
      if (record.incurredCostMicros !== undefined) {
        settled += 1;
      }
      if (record.error === 'budget_denied') {
        denied += 1;
      }
      if (record.error !== undefined && record.error !== 'budget_denied' && record.error !== 'settle_failed') {
        modelFailures += 1;
      }
      if (record.error === 'settle_failed') {
        settleFailures += 1;
      }
      if (record.provenance === 'measured') {
        measuredCalls += 1;
      } else if (record.provenance === 'estimated') {
        estimatedCalls += 1;
      } else if (record.provenance === 'unknown') {
        unknownCalls += 1;
      }
    }
    return {
      attempted: records.length,
      reserved,
      settled,
      denied,
      modelFailures,
      settleFailures,
      lateUsageSettlements: lateUsageRecords.length,
      costMicros,
      measuredCalls,
      estimatedCalls,
      unknownCalls
    };
  };

  const record = (entry: ModelCallRecord): void => {
    localRecords.push(entry);
    registry.record(entry);
  };

  const adapter: MeteredModelAdapter = {
    stage,
    purpose,
    ledgerPhase,
    metering,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      // `complete` exists only to satisfy IModelAdapter's structural contract for
      // hosts that receive this object; it routes through the same `call` path.
      return adapter.call(request);
    },
    async call(request: ModelRequest): Promise<ModelResponse> {
      callSequence += 1;
      const callId = options.idFactory?.() ?? 'mcall_' + stage + '_' + String(callSequence);
      const startedAt = now();

      if (request.purpose !== purpose) {
        const error = new MeteredModelError(
          'METERED_MODEL_PURPOSE_MISMATCH',
          'stage "' + stage + '" must issue purpose "' + purpose + '", received "' + request.purpose + '"'
        );
        record({
          callId,
          stage,
          purpose: request.purpose,
          ledgerPhase,
          outcome: 'failed',
          durationMs: Math.max(0, now() - startedAt),
          reservedMicros: 0,
          provenance: 'none',
          settlement: 'none',
          error: 'purpose_mismatch'
        });
        throw error;
      }

      let reservationId: string | undefined;
      if (settlement !== undefined) {
        // beginCall records the durable callId -> reservationId mapping BEFORE the
        // provider is called, so late usage can always be joined back (contract 1).
        // P3-4: the consumer label travels with the call (the assembly-built
        // settlement no longer hard-codes the first bridge's name).
        const decision = settlement.beginCall({
          consumer: 'metered-model-adapter:' + stage,
          callId,
          phase: ledgerPhase,
          pool: 'general',
          estimatedCostMicros,
          requiresSeat: false,
          ...(metadataString(request.metadata, 'sessionId') === undefined
            ? {}
            : { sessionId: metadataString(request.metadata, 'sessionId') }),
          ...(metadataString(request.metadata, 'operationId') === undefined
            ? {}
            : { operationId: metadataString(request.metadata, 'operationId') }),
          ...(routeId === undefined ? {} : { routeId }),
          ...(rateCard === undefined ? {} : { rateCard })
        });
        if (!decision.granted) {
          const error = new MeteredModelError(
            'METERED_MODEL_BUDGET_DENIED',
            'ledger refused the reservation for stage "' + stage + '": ' + (decision.rejectionReason ?? 'insufficient_budget')
          );
          record({
            callId,
            stage,
            purpose: request.purpose,
            ledgerPhase,
            outcome: 'failed',
            durationMs: Math.max(0, now() - startedAt),
            reservedMicros: 0,
            provenance: 'none',
            settlement: 'none',
            error: 'budget_denied'
          });
          throw error;
        }
        reservationId = decision.reservationId;
      }

      let response: ModelResponse;
      try {
        response = await inner.complete(request);
      } catch (error) {
        const durationMs = Math.max(0, now() - startedAt);
        let provenance: MeteredCostProvenance = 'none';
        let incurred: number | undefined;
        let heldCostMicros: number | undefined;
        let settlementPhase: 'final' | 'interim' | 'none' = 'none';
        let settleFailure = false;
        const outcome = outcomeOfError(error);
        if (settlement !== undefined && reservationId !== undefined) {
          try {
            // A local abort/cancel does NOT prove the provider stopped generating:
            // settleCall selects INTERIM for it, which holds the money and the seat
            // until late usage (or an external bill) arrives on the SAME callId.
            const settled = settlement.settleCall({
              callId,
              reservationId,
              outcome,
              ...(rateCard === undefined ? {} : { rateCard }),
              releaseSeat: true
            });
            settlementPhase = settled.settlement;
            provenance = settled.result.ledgerEvent?.cost.provenance ?? 'unknown';
            if (settled.settlement === 'interim') {
              heldCostMicros = settled.result.incurredCostMicros;
            } else {
              incurred = settled.result.incurredCostMicros;
              bookedByCall.set(callId, incurred);
            }
          } catch {
            settleFailure = true;
            provenance = 'unknown';
          }
        }
        record({
          callId,
          ...(reservationId === undefined ? {} : { reservationId }),
          stage,
          purpose: request.purpose,
          ledgerPhase,
          outcome,
          durationMs,
          ...(incurred === undefined ? {} : { incurredCostMicros: incurred }),
          ...(heldCostMicros === undefined ? {} : { heldCostMicros }),
          settlement: settlementPhase,
          reservedMicros: estimatedCostMicros,
          provenance,
          error: settleFailure ? 'settle_failed' : error instanceof Error ? error.name : 'model_error'
        });
        throw error;
      }

      const durationMs = Math.max(0, now() - startedAt);
      let provenance: MeteredCostProvenance = 'none';
      let incurred: number | undefined;
      let heldCostMicros: number | undefined;
      let settlementPhase: 'final' | 'interim' | 'none' = 'none';
      const outcome = outcomeOf(response);
      if (settlement !== undefined && reservationId !== undefined) {
        const rawUsage = response.metadata?.rawUsage as RawDshUsageLike | undefined;
        const semantics = response.metadata?.countingSemantics as CountingSemantics | undefined;
        const usage = ledgerUsagePayload(rawUsage, semantics);
        try {
          const settled = settlement.settleCall({
            callId,
            reservationId,
            outcome,
            ...(usage === undefined ? {} : { usage }),
            ...(rateCard === undefined ? {} : { rateCard }),
            releaseSeat: true
          });
          settlementPhase = settled.settlement;
          provenance = settled.result.ledgerEvent?.cost.provenance ?? 'unknown';
          if (settled.settlement === 'interim') {
            heldCostMicros = settled.result.incurredCostMicros;
          } else {
            incurred = settled.result.incurredCostMicros;
            bookedByCall.set(callId, incurred);
          }
        } catch {
          provenance = 'unknown';
        }
      }

      record({
        callId,
        ...(reservationId === undefined ? {} : { reservationId }),
        stage,
        purpose: request.purpose,
        ledgerPhase,
        outcome,
        durationMs,
        ...(response.model === undefined ? {} : { modelId: response.model }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(incurred === undefined ? {} : { incurredCostMicros: incurred }),
        ...(heldCostMicros === undefined ? {} : { heldCostMicros }),
        settlement: settlementPhase,
        reservedMicros: estimatedCostMicros,
        provenance
      });
      return response;
    },
    records: stageRecords,
    stats,
    callIdentities: (): readonly LedgerCallIdentity[] => settlement?.identities() ?? [],
    lateUsageSettlements: (): readonly LateUsageSettlement[] => [...lateUsageRecords],
    reconcileLateUsage: (event: LateUsageEvent): LateUsageSettlement => {
      if (settlement === undefined) {
        // Never a silent no-op: an unmetered stage cannot reconcile anything, and
        // "we did nothing" must not look like "the ledger agreed".
        throw new TwoPhaseLedgerError(
          'LATE_USAGE_UNMETERED',
          'stage "' + stage + '" has no ledger, so late usage for originCallId "' + event.originCallId +
            '" has no reservation to reconcile against'
        );
      }
      const merged = settlement.reconcileLateUsage(event);
      lateUsageRecords.push(merged);
      bookedByCall.set(merged.callId, merged.incurredCostMicros);
      return merged;
    },
    bookNewAttempt: (event: LateUsageEvent): LateUsageSettlement => {
      if (settlement === undefined) {
        throw new TwoPhaseLedgerError(
          'LATE_USAGE_UNMETERED',
          'stage "' + stage + '" has no ledger, so there is no budget to book a new attempt against'
        );
      }
      const booked = settlement.bookNewAttempt(event);
      lateUsageRecords.push(booked);
      bookedByCall.set(booked.callId, booked.incurredCostMicros);
      return booked;
    }
  };

  return adapter;
}

/**
 * Read a stage's records from a shared registry (or its own when private).
 * Exists so status surfaces do not need to know the registry's internals.
 */
export function recordsForStage(
  registry: ModelCallRegistry,
  stage: MeteringStage
): readonly ModelCallRecord[] {
  return registry.snapshot().filter((entry) => entry.stage === stage);
}
