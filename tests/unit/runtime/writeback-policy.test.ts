/**
 * rev6 audit A4-1 (B5): the write-back gate resolution contract.
 *
 * The load-bearing distinctions:
 *   - `auto` is HOST-DEPENDENT: without a trusted verifier it turns the audit
 *     gate ON; with one it keeps the historical path OFF.
 *   - `on` and `off` are EXPLICIT operator choices and do not track verifier
 *     presence (that is what lets the off/on ablation arms stay comparable).
 *   - an injected but DISABLED seam, and a runner with an EMPTY producer set,
 *     are both "no trusted verifier" (the conservative-degraded shape).
 */
import { describe, expect, it } from 'vitest';
import {
  hasTrustedVerifierSeam,
  resolveWritebackGate,
  type TrustedVerifierSeamLike
} from '../../../src/runtime/writeback-policy';
import { createHostOwnedVerificationRunner } from '../../../src/verification';

function seamWith(producers: readonly string[], enabled?: boolean): TrustedVerifierSeamLike {
  return {
    ...(enabled === undefined ? {} : { enabled }),
    runner: {
      trustedProducers: new Set<string>(producers)
    }
  };
}

describe('hasTrustedVerifierSeam: source trust is not seam presence', () => {
  it('is false for an absent / disabled seam', () => {
    expect(hasTrustedVerifierSeam(undefined)).toBe(false);
    expect(hasTrustedVerifierSeam(null)).toBe(false);
    expect(hasTrustedVerifierSeam(seamWith(['host-runner'], false))).toBe(false);
    // Absent `enabled` defaults to enabled (the seam contract).
    expect(hasTrustedVerifierSeam(seamWith(['host-runner']))).toBe(true);
  });

  it('requires a NON-EMPTY trusted producer set (conservative-degraded is not trusted)', () => {
    expect(hasTrustedVerifierSeam(seamWith([]))).toBe(false);
    expect(hasTrustedVerifierSeam(seamWith(['host-runner']))).toBe(true);
    const real = createHostOwnedVerificationRunner({
      verifierId: 'a4-1-host',
      verifierVersion: 'v1',
      testSetId: 'set',
      envId: 'env',
      cases: [{ taskId: 'task', checks: [{ id: 'c', run: () => true }] }]
    });
    expect(hasTrustedVerifierSeam({ runner: real })).toBe(true);
  });
});

describe('resolveWritebackGate: auto vs explicit modes', () => {
  it('auto derives ON without a trusted verifier and OFF with one', () => {
    const off = resolveWritebackGate('auto', false);
    expect(off.enabled).toBe(true);
    expect(off.source).toBe('auto');
    expect(off.reason).toContain('AUDIT only');

    const on = resolveWritebackGate('auto', true);
    expect(on.enabled).toBe(false);
    expect(on.source).toBe('auto');
    expect(on.reason).toContain('historical path');
  });

  it('explicit on ignores verifier presence (it can only lower eligibility)', () => {
    for (const trusted of [false, true]) {
      const resolved = resolveWritebackGate('on', trusted);
      expect(resolved.enabled).toBe(true);
      expect(resolved.source).toBe('explicit');
      expect(resolved.reason).toContain('can only lower eligibility');
    }
  });

  it('explicit off ignores verifier presence (the historical/ablation arm)', () => {
    for (const trusted of [false, true]) {
      const resolved = resolveWritebackGate('off', trusted);
      expect(resolved.enabled).toBe(false);
      expect(resolved.source).toBe('explicit');
    }
  });

  it('auto is the only mode whose result changes with the host', () => {
    const auto = [resolveWritebackGate('auto', false).enabled, resolveWritebackGate('auto', true).enabled];
    expect(auto[0]).not.toBe(auto[1]);
    const on = [resolveWritebackGate('on', false).enabled, resolveWritebackGate('on', true).enabled];
    const off = [resolveWritebackGate('off', false).enabled, resolveWritebackGate('off', true).enabled];
    expect(new Set(on).size).toBe(1);
    expect(new Set(off).size).toBe(1);
  });
});