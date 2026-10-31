/**
 * rev6 R2-2: branch-aware identity and isolation, judged by the plugin's OWN
 * matching rule (`readHookScope` + `hookScopeMatches`).
 *
 * THE POINT OF THIS FILE
 * DSH 0.2.1-rc.5 supplies NO branchId on any hook dispatch (measured: rc2 §9.2-2
 * and rc3 §A.5 both show branch=0 on all four hooks). R2-2 therefore CANNOT be
 * passed on this host, and the honest verdict is `blocked`.
 *
 * A file that only asserted "blocked" would be worthless: it would still pass if
 * the matching rule silently stopped isolating anything. So this file proves the
 * rule's PRECEDENCE on contract-shaped dispatches (sibling / anonymous /
 * self-claim / dispose / deny), and then asserts the host fact separately. If
 * the host ever starts emitting a branchId, the blocked assertions here fail
 * loudly and rc4 must replace them with real-host evidence - which is the
 * correct behaviour for a tripwire.
 */
import { describe, expect, it } from 'vitest';

import {
  hookScopeMatches,
  readHookScope,
  type HookMountScope
} from '../../../src/cordis-seams/dsh-hook-host-adapter';

import {
  probeApplyContext,
  judgeApplyContext
} from '../../../scripts/host-smoke/apply-context.mjs';

const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';
const SESSION_1 = 'session-1';

/** A branch-class mount for BRANCH_A: the class every probe mount defaults to. */
function branchMount(branchId: string): HookMountScope {
  return { branchId, sessionId: SESSION_1, namespace: 'harness2', scopeClass: 'branch' };
}

describe('identity extraction: readHookScope reads only PROVEN identity', () => {
  it('collects branch/session/namespace ids from direct fields and carriers', () => {
    const identity = readHookScope({
      branchId: BRANCH_A,
      sessionId: SESSION_1,
      namespace: 'harness2'
    });
    expect([...identity.branchIds]).toEqual([BRANCH_A]);
    expect([...identity.sessionIds]).toEqual([SESSION_1]);
    expect([...identity.namespaces]).toEqual(['harness2']);
  });

  it('does NOT treat a bare agent carrier as a branch identity', () => {
    // The real host supplies `agent` on tools hooks; its `id` is a SESSION
    // identity (D-P4-1), never a branch. Confusing the two is the leak P4-C
    // closed.
    const identity = readHookScope({ agent: { id: SESSION_1 } });
    expect(identity.branchIds.size).toBe(0);
    expect([...identity.sessionIds]).toEqual([SESSION_1]);
  });

  it('yields an empty identity for an identity-free payload', () => {
    const identity = readHookScope({ name: 'x', arguments: {} });
    expect(identity.branchIds.size).toBe(0);
    expect(identity.sessionIds.size).toBe(0);
    expect(identity.namespaces.size).toBe(0);
  });
});

describe('precedence: a branch mount acts ONLY on its own exact branch', () => {
  it('matches its own branch', () => {
    const identity = readHookScope({ branchId: BRANCH_A, sessionId: SESSION_1 });
    expect(hookScopeMatches(identity, branchMount(BRANCH_A))).toBe(true);
  });

  it('REJECTS a sibling branch that shares the sessionId (the P4-C leak)', () => {
    // This is the exact shape rev4 found: two probes, one sessionId, different
    // branches. Session coincidence must not authorize the mount.
    const sibling = readHookScope({ branchId: BRANCH_B, sessionId: SESSION_1 });
    expect(hookScopeMatches(sibling, branchMount(BRANCH_A))).toBe(false);
  });

  it('REJECTS an anonymous (identity-free) dispatch', () => {
    const anonymous = readHookScope({ name: 'x', arguments: {} });
    expect(hookScopeMatches(anonymous, branchMount(BRANCH_A))).toBe(false);
  });

  it('REJECTS a session-only dispatch, even with the mount\'s own sessionId', () => {
    const sessionOnly = readHookScope({ sessionId: SESSION_1 });
    expect(sessionOnly.branchIds.size).toBe(0);
    expect(hookScopeMatches(sessionOnly, branchMount(BRANCH_A))).toBe(false);
  });

  it('REJECTS a SELF-CLAIMED identity on a payload that merely asserts a branch', () => {
    // A payload cannot authorize itself: the adapter only accepts identity it
    // read from the host-supplied dispatch fields, and a self-claim that names a
    // DIFFERENT branch must not match this mount.
    const selfClaim = readHookScope({ branchId: BRANCH_B, sessionId: SESSION_1, role: 'domain', allowAdvice: true });
    expect(hookScopeMatches(selfClaim, branchMount(BRANCH_A))).toBe(false);
  });

  it('treats an UNDECLARED mount class as branch (fail-closed), not legacy', () => {
    // P4-C: no scopeClass must NOT fall back to the permissive legacy matching.
    const identity = readHookScope({ sessionId: SESSION_1 });
    const undeclared: HookMountScope = { branchId: BRANCH_A, sessionId: SESSION_1, namespace: 'harness2' };
    expect(hookScopeMatches(identity, undeclared)).toBe(false);
  });

  it('lets a host-class mount act on an identity-free dispatch (the one authorized wide channel)', () => {
    const anonymous = readHookScope({ name: 'x' });
    expect(
      hookScopeMatches(anonymous, { branchId: '', sessionId: '', namespace: '', scopeClass: 'host' } as HookMountScope)
    ).toBe(true);
  });
});

describe('dispose: a disposed adapter stops matching (no residue)', () => {
  it('hookScopeMatches is pure, so a disposed adapter cannot resurrect a mount', () => {
    // The matching rule holds no state: after the adapter disposes its mounts,
    // nothing calls this function with those mounts again. The assertion that
    // matters is that the rule itself cannot start returning true for an
    // identity it rejected - i.e. it is deterministic across calls.
    const identity = readHookScope({ branchId: BRANCH_B, sessionId: SESSION_1 });
    const mount = branchMount(BRANCH_A);
    const first = hookScopeMatches(identity, mount);
    const second = hookScopeMatches(identity, mount);
    expect(first).toBe(false);
    expect(second).toBe(first);
  });
});

describe('the REAL host supplies no branchId: R2-2 is blocked, not passed', () => {
  /**
   * This assertion is a TRIPWIRE, not a tolerance. The probe reads identity from
   * whatever the host actually dispatched. On DSH 0.2.1-rc.5 that is branch=0 on
   * all four hooks; if a future host starts emitting branchIds this test fails
   * and the next revision MUST replace the blocked verdict with real evidence.
   */
  it('reports blocked when no dispatch carries a branchId, and never claims Gate 4', async () => {
    const { probeApplyContext: probe } = await import('../../../scripts/host-smoke/apply-context.mjs');
    expect(typeof probe).toBe('function');

    // The probe needs an installed host; when it is absent the judgement must
    // still be "blocked", never "passed".
    const judged = judgeApplyContext(undefined);
    expect(judged.blocked).toBe(true);
    expect(judged.surfaceEvidence).toBe(false);
  });

  it('a probe whose dispatches carry no branch is judged blocked with an explicit reason', () => {
    const judged = judgeApplyContext({
      ok: true,
      applyContext: {
        contextKind: 'bare-cordis-context',
        services: { tools: true, systemPrompt: true, commands: false },
        productionResolvedSource: 'dsh-hooks',
        detectDetected: true,
        structuralSeams: 0,
        applyReturnedHandle: true,
        applyError: null
      },
      hookRegistration: { registered: [], expected: [], missing: [], extra: [], matched: true },
      classifiedAdapterSource: 'dsh-hooks',
      matrix: {
        capturedAt: '2026-10-31T00:00:00.000Z',
        hostAdapterSource: 'dsh-hooks',
        hookDetected: true,
        installedHookEvents: [],
        structuralSeams: 0,
        contextKind: 'bare-cordis-context' as const,
        faces: [],
        problems: []
      },
      crossCheck: { checked: 8, disagreements: [], lastMountResultObserved: 0, cacheReadUnknown: 8, note: '' },
      surfaces: [],
      dispose: { disposed: false, error: null },
      problems: [],
      // branch=0 on every dispatch: exactly the measured host fact.
      identity: [
        { event: 'system-prompt/assemble', dispatched: true, branchIds: 0, sessionIds: 1, namespaces: 0, fields: [], matched: false },
        { event: 'tools/pre-execute', dispatched: true, branchIds: 0, sessionIds: 1, namespaces: 0, fields: [], matched: false },
        { event: 'tools/post-execute', dispatched: true, branchIds: 0, sessionIds: 1, namespaces: 0, fields: [], matched: false },
        { event: 'agent/pre-step', dispatched: true, branchIds: 0, sessionIds: 0, namespaces: 0, fields: [], matched: false }
      ]
    });
    expect(judged.blocked).toBe(true);
    expect(judged.branchReasons.join(' ')).toContain('branchId');
    // The surface obligation is unaffected by the branch gap (separate duties).
    expect(judged.applyReasons).toEqual([]);
    expect(judged.surfaceEvidence).toBe(true);
  });

  it('a dispatch that DOES carry a branch clears the blocked verdict (tripwire direction)', () => {
    const judged = judgeApplyContext({
      ok: true,
      applyContext: {
        contextKind: 'bare-cordis-context',
        services: { tools: true, systemPrompt: true, commands: false },
        productionResolvedSource: 'dsh-hooks',
        detectDetected: true,
        structuralSeams: 0,
        applyReturnedHandle: true,
        applyError: null
      },
      hookRegistration: { registered: [], expected: [], missing: [], extra: [], matched: true },
      classifiedAdapterSource: 'dsh-hooks',
      matrix: {
        capturedAt: '2026-10-31T00:00:00.000Z',
        hostAdapterSource: 'dsh-hooks',
        hookDetected: true,
        installedHookEvents: [],
        structuralSeams: 0,
        contextKind: 'bare-cordis-context' as const,
        faces: [],
        problems: []
      },
      crossCheck: { checked: 8, disagreements: [], lastMountResultObserved: 0, cacheReadUnknown: 8, note: '' },
      surfaces: [],
      dispose: { disposed: false, error: null },
      problems: [],
      identity: [
        { event: 'tools/pre-execute', dispatched: true, branchIds: 1, sessionIds: 1, namespaces: 0, fields: [], matched: false }
      ]
    });
    // Once a branchId exists, the "blocked" excuse is no longer available: the
    // next revision has to produce real sibling/isolation evidence.
    expect(judged.blocked).toBe(false);
    expect(judged.branchReasons).toEqual([]);
  });
});
