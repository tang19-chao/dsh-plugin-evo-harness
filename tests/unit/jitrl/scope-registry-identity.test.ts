/**
 * ADR 0006 D-P4-1/D-P4-2/D-P4-3: ScopeRegistry identity and trust contract.
 *
 * These tests pin the identity model the mount isolation is built on:
 *
 *   - a sessionId NEVER stands in for a branch identity. A session-only
 *     payload resolves to 'unknown' (and is counted) even when a trusted host
 *     scope for that exact session exists;
 *   - the identity reading vocabulary is exhaustive (five statuses) and every
 *     resolve outcome is counted with a closure invariant
 *     (`total === proven + unknown`, `unknown === 5 rejection buckets`);
 *   - a host scope is a session/namespace statement with an explicit grant,
 *     its `authorizesBranch` is the literal false, and it expires and disposes
 *     like any other record.
 *
 * No host, no network, no model call: the registry is a pure in-process object.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyScopeIdentity,
  createScopeRegistry,
  formatScopeKey
} from '../../../src/jitrl/scope-registry';

let clock = 1_000_000;
const tick = (delta = 0): number => {
  clock += delta;
  return clock;
};

function freshRegistry(ttlMs = 60_000) {
  clock = 1_000_000;
  return createScopeRegistry({ now: (): number => tick(), ttlMs });
}

describe('ADR 0006 D-P4-2: classifyScopeIdentity is the exhaustive identity reading', () => {
  it('reads the five mutually exclusive statuses', () => {
    expect(classifyScopeIdentity({ branchId: 'br-1', sessionId: 'sess-1' })).toEqual({
      status: 'branch-and-session',
      branchId: 'br-1',
      sessionId: 'sess-1',
      branchCount: 1,
      sessionCount: 1,
      hasBranchProof: true
    });
    expect(classifyScopeIdentity({ branchId: 'br-1' })).toEqual({
      status: 'branch-only',
      branchId: 'br-1',
      branchCount: 1,
      sessionCount: 0,
      hasBranchProof: true
    });
    expect(classifyScopeIdentity({ sessionId: 'sess-1' })).toEqual({
      status: 'session-only',
      sessionId: 'sess-1',
      branchCount: 0,
      sessionCount: 1,
      hasBranchProof: false
    });
    expect(classifyScopeIdentity({})).toEqual({
      status: 'unattributed',
      branchCount: 0,
      sessionCount: 0,
      hasBranchProof: false
    });
    const ambiguous = classifyScopeIdentity({ branchId: 'br-1' }, { branchId: 'br-2' });
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.hasBranchProof).toBe(false);
    expect(ambiguous.branchCount).toBe(2);
  });

  it('reads a session-only carrier nested under an agent key (the host dispatch shape)', () => {
    const reading = classifyScopeIdentity({ agent: { id: 'sess-9' }, messages: [] });
    expect(reading.status).toBe('session-only');
    expect(reading.hasBranchProof).toBe(false);
  });
});

describe('ADR 0006 D-P4-1: a sessionId never stands in for a branch identity', () => {
  it('refuses a session-only payload even with a trusted host scope for that session', () => {
    const registry = freshRegistry();
    registry.register({ sessionId: 'sess-1', branchId: 'br-1' });
    registry.registerHostScope({ sessionId: 'sess-1', grantedBy: 'integrator:host-session' });

    expect(registry.resolve({ sessionId: 'sess-1' })).toBe('unknown');
    expect(registry.resolve({ sessionId: 'sess-1', branchId: 'br-1' })).not.toBe('unknown');
    // The branch authority is the compound key, not the session alias.
    expect(registry.get(formatScopeKey('sess-1', 'br-1'))?.branchId).toBe('br-1');
    const stats = registry.stats();
    expect(stats.resolves.sessionOnlyRejected).toBe(1);
  });

  it('requires the registered compound key: a foreign session never borrows our branchId', () => {
    const registry = freshRegistry();
    registry.register({ sessionId: 'sess-1', branchId: 'br-1' });
    // Scope resolution (the advice/learning channel) needs the registered
    // compound, so a payload naming our branchId with a foreign session is
    // unproven. Mount matching is stricter still: it requires the branchId and
    // never matches on the session at all (tests/unit/seams).
    expect(registry.resolve({ sessionId: 'sess-other', branchId: 'br-1' })).toBe('unknown');
    expect(registry.resolve({ sessionId: 'sess-1', branchId: 'br-1' })).not.toBe('unknown');
    expect(registry.stats().resolves.unregisteredRejected).toBe(1);
  });
});

describe('ADR 0006: resolve counters close over every outcome', () => {
  it('counts proven, branch-only, and each rejection bucket, with closure', () => {
    const registry = freshRegistry();
    registry.register({ sessionId: 'sess-1', branchId: 'br-1' });
    registry.register({ sessionId: 'sess-2', branchId: 'br-1' }); // br-1 is no longer unique

    expect(registry.resolve({ sessionId: 'sess-1', branchId: 'br-1' })).not.toBe('unknown'); // proven
    expect(registry.resolve({ branchId: 'br-1' })).toBe('unknown'); // ambiguous (two compounds)
    expect(registry.resolve({ sessionId: 'sess-1', branchId: 'br-404' })).toBe('unknown'); // unregistered
    expect(registry.resolve({ sessionId: 'sess-404' })).toBe('unknown'); // session-only
    expect(registry.resolve({})).toBe('unknown'); // unattributed
    expect(registry.resolve(...[])).toBe('unknown'); // no payloads

    const stats = registry.stats();
    expect(stats.resolves.proven).toBe(1);
    expect(stats.resolves.ambiguousRejected).toBe(1);
    expect(stats.resolves.unregisteredRejected).toBe(1);
    expect(stats.resolves.sessionOnlyRejected).toBe(1);
    expect(stats.resolves.unattributedRejected).toBe(2);
    expect(stats.resolves.total).toBe(stats.resolves.proven + stats.resolves.unknown);
    expect(stats.resolves.unknown).toBe(
      stats.resolves.ambiguousRejected +
        stats.resolves.unregisteredRejected +
        stats.resolves.sessionOnlyRejected +
        stats.resolves.unattributedRejected +
        stats.resolves.expiredRejected
    );
  });

  it('counts branch-only resolution through a globally unique branchId separately', () => {
    const registry = freshRegistry();
    registry.register({ sessionId: 'sess-1', branchId: 'br-unique' });
    expect(registry.resolve({ branchId: 'br-unique' })).not.toBe('unknown');
    const stats = registry.stats();
    expect(stats.resolves.branchOnlyMatches).toBe(1);
    expect(stats.resolves.proven).toBe(1);
  });

  it('counts an expired resolution and prunes it', () => {
    const registry = freshRegistry(50);
    registry.register({ sessionId: 'sess-1', branchId: 'br-1' });
    expect(registry.resolve({ sessionId: 'sess-1', branchId: 'br-1' })).not.toBe('unknown');
    tick(60);
    expect(registry.resolve({ sessionId: 'sess-1', branchId: 'br-1' })).toBe('unknown');
    const stats = registry.stats();
    expect(stats.resolves.expiredRejected).toBe(1);
    expect(stats.expiredPruned).toBe(1);
    expect(registry.size()).toBe(0);
  });
});

describe('ADR 0006 D-P4-3: trusted host scope', () => {
  it('requires a non-empty sessionId and an explicit grant, and counts rejections', () => {
    const registry = freshRegistry();
    expect(() => registry.registerHostScope({ sessionId: '', grantedBy: 'g' })).toThrow(/sessionId/);
    expect(() => registry.registerHostScope({ sessionId: 'sess-1', grantedBy: '' })).toThrow(/grantedBy/);
    expect(() =>
      registry.registerHostScope({ sessionId: 'sess-1', grantedBy: '  ' } as never)
    ).toThrow(/grantedBy/);
    expect(registry.stats().hostScopeRejections).toBe(3);
    expect(registry.activeHostScopes()).toEqual([]);
  });

  it('resolves a host dispatch to the recorded scope and never to a branch', () => {
    const registry = freshRegistry();
    const handle = registry.registerHostScope({
      sessionId: 'sess-host',
      namespace: 'harness2',
      grantedBy: 'permanent-patch:p7'
    });
    expect(handle.scope.authorizesBranch).toBe(false);
    expect(handle.scope.grantedBy).toBe('permanent-patch:p7');

    expect(registry.resolveHostScope({ agent: { id: 'sess-host' } })).toBe(handle.scope);
    // A branch-attributed dispatch is not the host, whatever session it names.
    expect(registry.resolveHostScope({ sessionId: 'sess-host', branchId: 'br-1' })).toBe('unknown');
    expect(registry.resolveHostScope({ sessionId: 'sess-other' })).toBe('unknown');
    expect(registry.resolveHostScope({})).toBe('unknown');
    const stats = registry.stats();
    expect(stats.hostScopeResolves).toEqual({ total: 4, proven: 1, rejected: 3 });

    handle.dispose();
    expect(registry.resolveHostScope({ agent: { id: 'sess-host' } })).toBe('unknown');
    expect(registry.activeHostScopes()).toEqual([]);
  });

  it('expires a host scope after its TTL', () => {
    const registry = freshRegistry(50);
    registry.registerHostScope({ sessionId: 'sess-host', grantedBy: 'g', ttlMs: 40 });
    expect(registry.resolveHostScope({ sessionId: 'sess-host' })).not.toBe('unknown');
    tick(45);
    expect(registry.resolveHostScope({ sessionId: 'sess-host' })).toBe('unknown');
    expect(registry.stats().expiredPruned).toBe(1);
  });

  it('keeps counters across clear() and freezes the stats snapshot', () => {
    const registry = freshRegistry();
    registry.register({ sessionId: 'sess-1', branchId: 'br-1' });
    registry.registerHostScope({ sessionId: 'sess-1', grantedBy: 'g' });
    const before = registry.stats();
    expect(before.registrations).toBe(1);
    expect(before.hostScopeRegistrations).toBe(1);

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.activeHostScopes()).toEqual([]);
    const after = registry.stats();
    expect(after.registrations).toBe(1);
    expect(after.hostScopeRegistrations).toBe(1);

    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.resolves)).toBe(true);
    expect(Object.isFrozen(after.hostScopeResolves)).toBe(true);
  });

  it('does not count resolves on a disposed registry and refuses further registrations', () => {
    const registry = freshRegistry();
    registry.dispose();
    expect(registry.resolveHostScope({ sessionId: 'x' })).toBe('unknown');
    expect(registry.resolve({ sessionId: 'x' })).toBe('unknown');
    expect(registry.stats().resolves.total).toBe(0);
    expect(registry.stats().hostScopeResolves.total).toBe(0);
    expect(() => registry.registerHostScope({ sessionId: 'x', grantedBy: 'g' })).toThrow(/disposed/);
  });
});
