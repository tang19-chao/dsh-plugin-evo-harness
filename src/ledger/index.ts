/**
 * C3 Usage Ledger and Budget Accounting module.
 *
 * Implements ADR-0003 §7 and ADR-0004:
 * - Types and data contracts
 * - Anti-double counting pricing adapter
 * - Lifecycle reservation and settlement manager
 * - Ledger event construction and audit guarantees
 * - Write-ahead log, crash recovery and conservation law (§6)
 * - Provable hard upper bounds, admission modes, watermarks and dimension
 *   separation (§7, §8) — PR-3B
 */

export * from './types.js';
export * from './pricing.js';
// P3-A: the ONE validated assembly path for a manager (see src/ledger/assembly.ts).
export * from './assembly.js';
export * from './ledger-event.js';
export * from './reservation-manager.js';
// P3-C: measured/estimated/unknown separated; closure rules for cost reports.
export * from './usage-report.js';
export * from './wal.js';
export * from './limits.js';
export * from './reconciliation.js';
// P3-C wiring: the durable callId -> reservationId index and the two-phase
// settlement lifecycle the production consumers (dsh-bridge) are wired to.
export * from './two-phase.js';
