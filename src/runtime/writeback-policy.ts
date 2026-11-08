/**
 * rev6 audit A4-1 (B5): resolve `jitrl.writebackGate` into the ONE boolean the
 * orchestrator's online recorder consumes.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The historical negative result (`C3-online − C3-frozen` = −0.250) came from a
 * write-back path that trained on every executed probe, including probes whose
 * deliverable was never verified. The evidence gate in
 * `src/jitrl/writeback-gate.ts` already refuses those records, but before A4-1
 * it was opt-in (`deps.writebackGate === true`), so the SHADOW production
 * default kept learning online. A4-1 makes the honest behaviour the default:
 *
 *   - `auto` (configuration default): a host that injects a trusted verifier
 *     keeps the historical path (the gate is OFF, because there IS something
 *     that can prove a task result); a host without one gets the gate ON, so
 *     experience is written for AUDIT only and L2 never learns from an
 *     unverified signal.
 *   - `on`: the gate runs regardless of verifier presence. It can only LOWER
 *     eligibility (see `applyWritebackVerdict`), never grant it.
 *   - `off`: disables the G-A/G-B evidence gate only. It is NOT the full
 *     pre-A4-1 path: the independent A4-3 not-evaluable veto still applies, so
 *     an unverified text probe remains audit-only even with the gate off. A
 *     true historical replay also needs the deps-only
 *     `probeEvaluation:'legacy'` seam (offline eval harness only).
 *
 * WHAT COUNTS AS A TRUSTED VERIFIER
 * ---------------------------------
 * Presence of the C2a seam is not enough: the seam must be enabled and its
 * runner must publish a NON-EMPTY `trustedProducers` set. An empty set is the
 * documented `conservative-degraded` shape (a runner exists but cannot
 * authenticate any receipt), and treating it as "verified" would re-open the
 * exact hole this policy closes. The check is therefore structural and
 * fail-closed: absent/malformed members mean NO trusted verifier.
 *
 * This module is pure and has no I/O, so the plugin entrypoint, the diagnostics
 * line and the tests all compute the same resolution.
 */

import type { JitRlConfig } from '../config';

/** The three configuration values. */
export type WritebackGateMode = JitRlConfig['writebackGate'];

/** The structural slice of the C2a seam this policy reads. */
export interface TrustedVerifierSeamLike {
  readonly enabled?: boolean;
  readonly runner: {
    readonly trustedProducers: ReadonlySet<string>;
  };
}

/**
 * True when the injected seam can authenticate at least one producer.
 *
 * `enabled === false` behaves exactly like an absent seam (ADR 0003 §4.5.1).
 * A runner whose producer set is empty is `conservative-degraded`: it is
 * authenticated internally but the consumer-side trust condition can never
 * hold, so it is NOT a trusted verifier for this policy.
 */
export function hasTrustedVerifierSeam(
  seam: TrustedVerifierSeamLike | undefined | null
): boolean {
  if (seam === undefined || seam === null || seam.enabled === false) {
    return false;
  }
  const producers = seam.runner?.trustedProducers;
  return producers !== undefined && producers !== null && producers.size > 0;
}

/** The resolved gate plus the honest explanation of WHY it is on/off. */
export interface ResolvedWritebackGate {
  readonly mode: WritebackGateMode;
  readonly enabled: boolean;
  /**
   * `auto` when the value was derived from verifier presence; `explicit` when
   * the configuration named `on`/`off` (or a future caller forced the mode).
   */
  readonly source: 'auto' | 'explicit';
  /** Stable, human-readable reason for diagnostics and tests. */
  readonly reason: string;
}

/**
 * Resolve the mode against verifier presence.
 *
 * `auto` is the only mode that depends on the host: it is ON exactly when no
 * trusted verifier can authenticate a receipt. `on` stays on even with a
 * trusted verifier (an operator may want the stricter evidence routes), and
 * `off` stays off even without one (the G-A/G-B gate is disabled; the
 * independent A4-3 not-evaluable veto is NOT disabled by this mode).
 */
export function resolveWritebackGate(
  mode: WritebackGateMode,
  hasTrustedVerifier: boolean
): ResolvedWritebackGate {
  switch (mode) {
    case 'on':
      return {
        mode,
        enabled: true,
        source: 'explicit',
        reason:
          'jitrl.writebackGate=on: the evidence gate runs regardless of verifier presence (it can only lower eligibility)'
      };
    case 'off':
      return {
        mode,
        enabled: false,
        source: 'explicit',
        reason:
          'jitrl.writebackGate=off: the G-A/G-B evidence gate is disabled (the independent A4-3 not-evaluable veto still applies; explicit operator choice)'
      };
    case 'auto':
    default:
      return {
        mode: 'auto',
        enabled: !hasTrustedVerifier,
        source: 'auto',
        reason: hasTrustedVerifier
          ? 'jitrl.writebackGate=auto with a trusted verifier: the historical path runs because verdicts can be authenticated'
          : 'jitrl.writebackGate=auto without a trusted verifier: executed probes are written for AUDIT only (learningEligible=false, learningTarget=0) so L2 never learns from an unverified signal'
      };
  }
}