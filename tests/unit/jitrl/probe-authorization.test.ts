/**
 * ADR 0006 D-P4-5: the explicit authorization ledger.
 *
 * Contract under test: **a process is not a sandbox.** No action class is
 * authorized by default - not by JitRL being configured or switched on, not by
 * a shared sessionId, not by running in the same process. Every decision is
 * deny-by-default with a structured code, every grant is named and reasoned,
 * and the counters close (`checks === allowed + denied`).
 *
 * The ledger is deliberately not wired into any production call site in P4-A
 * (the plugin entrypoint is outside that task's write scope); these tests are
 * the contract the wiring must satisfy in P4-C.
 */
import { describe, expect, it } from 'vitest';
import {
  PROBE_AUTHORIZATION_KINDS,
  createJitRuntimeControl,
  createProbeAuthorizationLedger
} from '../../../src/jitrl/runtime-control';
import type { ProbeAuthorizationGrantSpec } from '../../../src/jitrl/runtime-control';

let clock = 1_000_000;
const tick = (delta = 0): number => {
  clock += delta;
  return clock;
};

function freshLedger() {
  clock = 1_000_000;
  const notes: string[] = [];
  const ledger = createProbeAuthorizationLedger({
    now: (): number => tick(),
    onDiagnostic: (message: string) => notes.push(message)
  });
  return { ledger, notes };
}

const grant = (overrides: Partial<ProbeAuthorizationGrantSpec> = {}): ProbeAuthorizationGrantSpec => ({
  kind: 'memory-write',
  grantedBy: 'operator-approval:ADR-0006-smoke',
  reason: 'approved in the P4-C smoke authorization request',
  ...overrides
});

describe('ADR 0006 D-P4-5: deny-by-default for every action class', () => {
  it('denies every known kind without any grant', () => {
    const { ledger } = freshLedger();
    for (const kind of PROBE_AUTHORIZATION_KINDS) {
      const decision = ledger.authorize({ kind, branchId: 'br-1', sessionId: 'sess-1' });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('no-grant');
    }
    const stats = ledger.stats();
    expect(stats.checks).toBe(PROBE_AUTHORIZATION_KINDS.length);
    expect(stats.allowed).toBe(0);
    expect(stats.denied).toBe(PROBE_AUTHORIZATION_KINDS.length);
  });

  it('denies an unknown kind instead of guessing', () => {
    const { ledger } = freshLedger();
    const decision = ledger.authorize({ kind: 'made-up' as never, branchId: 'br-1' });
    expect(decision).toMatchObject({ allowed: false, code: 'no-grant', kind: 'made-up' });
  });

  it('fails closed on a missing identity', () => {
    const { ledger } = freshLedger();
    expect(ledger.authorize({ kind: 'memory-write' })).toMatchObject({
      allowed: false,
      code: 'identity-required'
    });
    expect(ledger.stats().deniedByCode['identity-required']).toBe(1);
  });

  it('never inherits authorization from the runtime control switch', () => {
    const { ledger } = freshLedger();
    const control = createJitRuntimeControl({ configured: true });
    control.setEnabled(true);
    expect(control.snapshot()).toMatchObject({ configured: true, runtimeEnabled: true });
    // runtimeEnabled === true authorizes NOTHING: permission layering (ADR 0001 D4).
    expect(ledger.authorize({ kind: 'paid-model-call', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'no-grant'
    });
    control.dispose();
    expect(ledger.authorize({ kind: 'paid-model-call', branchId: 'br-1' }).allowed).toBe(false);
  });

  it('stays deny-only after the ledger is disposed', () => {
    const { ledger } = freshLedger();
    ledger.grant(grant());
    ledger.dispose();
    expect(ledger.isDisposed).toBe(true);
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'ledger-disposed'
    });
    expect(() => ledger.grant(grant())).toThrow(/disposed/);
  });
});

describe('ADR 0006 D-P4-5: grants are explicit, scoped and auditable', () => {
  it('rejects grants without provenance or with an unknown kind, and counts them', () => {
    const { ledger } = freshLedger();
    expect(() => ledger.grant(grant({ grantedBy: '  ' }))).toThrow(/grantedBy/);
    expect(() => ledger.grant(grant({ reason: '' }))).toThrow(/reason/);
    expect(() => ledger.grant({ kind: 'no-such-kind' as never, grantedBy: 'g', reason: 'r' })).toThrow(
      /PROBE_AUTHORIZATION_KIND/
    );
    expect(ledger.grants()).toEqual([]);
    expect(ledger.stats().grantsRejected).toBe(3);
  });

  it('authorizes exactly the granted kind, branch and session', () => {
    const { ledger } = freshLedger();
    const branchGrant = ledger.grant(grant({ kind: 'multi-step-probe', branchId: 'br-7', sessionId: 'sess-7' }));

    expect(ledger.authorize({ kind: 'multi-step-probe', branchId: 'br-7', sessionId: 'sess-7' })).toMatchObject({
      allowed: true,
      code: 'authorized',
      grantId: branchGrant.grantId
    });
    // A different branch is not covered, whatever session it names.
    expect(ledger.authorize({ kind: 'multi-step-probe', branchId: 'br-8', sessionId: 'sess-7' })).toMatchObject({
      allowed: false,
      code: 'no-grant'
    });
    // A different kind is not covered.
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-7', sessionId: 'sess-7' })).toMatchObject({
      allowed: false,
      code: 'no-grant'
    });
    // A different session narrows out when the grant names a session.
    expect(ledger.authorize({ kind: 'multi-step-probe', branchId: 'br-7', sessionId: 'sess-9' })).toMatchObject({
      allowed: false,
      code: 'no-grant'
    });
    const stats = ledger.stats();
    expect(stats.allowed).toBe(1);
    expect(stats.grants).toBe(1);
  });

  it('refuses to let a session-only grant authorize a branch action (ADR 0006 D-P4-1)', () => {
    const { ledger } = freshLedger();
    ledger.grant(grant({ branchId: undefined, sessionId: 'sess-host' }));
    const decision = ledger.authorize({ kind: 'memory-write', branchId: 'br-1', sessionId: 'sess-host' });
    expect(decision).toMatchObject({
      allowed: false,
      code: 'session-cannot-authorize-branch'
    });
    expect(ledger.stats().sessionCannotAuthorizeBranch).toBe(1);
    // A session-scoped grant still covers a session-level (host-side) request.
    expect(ledger.authorize({ kind: 'memory-write', sessionId: 'sess-host' })).toMatchObject({
      allowed: true,
      code: 'authorized'
    });
  });

  it('reports a lapsed grant as grant-expired, distinct from no-grant', () => {
    const { ledger } = freshLedger();
    ledger.grant(grant({ ttlMs: 100, branchId: 'br-1' }));
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-1' })).toMatchObject({
      allowed: true,
      code: 'authorized'
    });
    tick(150);
    const lapsed = ledger.authorize({ kind: 'memory-write', branchId: 'br-1' });
    expect(lapsed).toMatchObject({ allowed: false, code: 'grant-expired' });
    expect(lapsed.grantId).toBeDefined();
    const stats = ledger.stats();
    expect(stats.expiredGrants).toBe(1);
    expect(ledger.grants()).toEqual([]);
    // After expiry the state is the plain no-grant state again.
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-1' }).code).toBe('no-grant');
  });

  it('consumes single-use grants and supports revocation', () => {
    const { ledger } = freshLedger();
    const single = ledger.grant(grant({ branchId: 'br-1', singleUse: true }));
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-1' }).allowed).toBe(true);
    expect(ledger.grants()[0]?.usedAt).toBeGreaterThan(0);
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-1' }).code).toBe('no-grant');
    expect(single.singleUse).toBe(true);

    const revocable = ledger.grant(grant({ branchId: 'br-2' }));
    expect(ledger.revoke(revocable.grantId)).toBe(true);
    expect(ledger.revoke(revocable.grantId)).toBe(false);
    expect(ledger.authorize({ kind: 'memory-write', branchId: 'br-2' }).code).toBe('no-grant');
    expect(ledger.stats().revocations).toBe(1);
  });

  it('keeps every diagnostic payload-free (no identity or provenance text)', () => {
    const { ledger, notes } = freshLedger();
    ledger.grant(grant({ branchId: 'br-secret-branch', sessionId: 'sess-secret' }));
    ledger.authorize({ kind: 'memory-write', branchId: 'br-other', sessionId: 'sess-other' });
    ledger.authorize({ kind: 'memory-write', branchId: 'br-secret-branch', sessionId: 'sess-secret' });
    const joined = notes.join(' ');
    expect(joined).not.toContain('br-secret-branch');
    expect(joined).not.toContain('sess-secret');
    expect(joined).not.toContain('operator-approval');
    expect(notes.every((line) => /^(probe_authorization_|probe_)/.test(line))).toBe(true);
  });

  it('closes its counters: checks === allowed + denied, denied === sum of codes', () => {
    const { ledger } = freshLedger();
    ledger.grant(grant({ branchId: 'br-1' }));
    ledger.authorize({ kind: 'memory-write', branchId: 'br-1' });
    ledger.authorize({ kind: 'memory-write', branchId: 'br-2' });
    ledger.authorize({ kind: 'memory-write' });
    ledger.authorize({ kind: 'memory-write', branchId: 'br-3', sessionId: 'sess-x' });
    const stats = ledger.stats();
    expect(stats.checks).toBe(stats.allowed + stats.denied);
    const codeSum = Object.values(stats.deniedByCode).reduce((left, right) => left + right, 0);
    expect(codeSum).toBe(stats.denied);
  });
});
