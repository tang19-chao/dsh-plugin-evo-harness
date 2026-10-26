/**
 * Usage Ledger Event creation and verification.
 *
 * Implements ADR-0003 §4.3 and §7.3.6:
 * - Cancelled / failed / timeout / infra-error events are strictly audit-only.
 * - Incurred spend is recorded truthfully, but never serves as positive quality evidence.
 */

import {
  CostCalculation,
  ExecutionOutcome,
  LedgerPhase,
  ProviderUsagePayload,
  UsageLedgerEvent
} from './types.js';

let eventCounter = 0;

/**
 * Generate a deterministic or sequence-based event identifier.
 */
export function generateEventId(callId: string, phase: LedgerPhase): string {
  eventCounter += 1;
  return `evt_${phase}_${callId}_${Date.now()}_${eventCounter}`;
}

/**
 * Invariant checker: determine whether an outcome mandates audit-only treatment.
 */
export function isMandatoryAuditOnlyOutcome(outcome: ExecutionOutcome): boolean {
  return (
    outcome === 'cancelled' ||
    outcome === 'timed_out' ||
    outcome === 'infrastructure_error' ||
    outcome === 'failed'
  );
}

/**
 * Create a validated UsageLedgerEvent.
 */
export function createUsageLedgerEvent(params: {
  callId: string;
  reservationId: string;
  phase: LedgerPhase;
  outcome: ExecutionOutcome;
  incurredCostMicros: number;
  usage: ProviderUsagePayload;
  cost: CostCalculation;
  sessionId?: string;
  timestamp?: number;
  overrideAuditOnly?: boolean;
}): UsageLedgerEvent {
  const mandatoryAuditOnly = isMandatoryAuditOnlyOutcome(params.outcome);
  const auditOnly = mandatoryAuditOnly || (params.overrideAuditOnly ?? false);

  // Quality evidence is strictly disallowed for non-succeeded or audit-only events
  const qualityEvidence =
    !auditOnly &&
    params.outcome === 'succeeded' &&
    params.cost.provenance !== 'unknown' &&
    !params.cost.conservative;

  return Object.freeze({
    eventId: generateEventId(params.callId, params.phase),
    callId: params.callId,
    reservationId: params.reservationId,
    sessionId: params.sessionId,
    phase: params.phase,
    timestamp: params.timestamp ?? Date.now(),
    outcome: params.outcome,
    incurredCostMicros: params.incurredCostMicros,
    usage: params.usage,
    cost: params.cost,
    auditOnly,
    qualityEvidence
  });
}
