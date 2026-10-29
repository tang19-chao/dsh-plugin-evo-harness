/**
 * P4-B: leases and ScopeRegistry integrity, driven by TIME-ORDERED sequences.
 *
 * The point of this file is not "the API exists" but "the failure modes cannot
 * happen": every test below reproduces a real interleaving (sibling probes,
 * concurrent session reuse, duplicate registration, a late dispose of a
 * replaced handle, TTL expiry, adapter dispose) instead of asserting a single
 * isolated fact. A test that cannot fail in the wrong order cannot catch an
 * ordering bug.
 *
 * No host, no network, no model call: the registry is a pure in-process object,
 * and the one adapter test drives the real hook adapter's in-process context.
 */
import { describe, expect, it } from 'vitest';
import {
  createScopeRegistry,
  type BranchLease,
  type SessionLeaseRefusal
} from '../../../src/jitrl/scope-registry';
import { createDshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import { createHookFixture } from '../cordis-seams/hook-fixtures';

const SESSION = 'sess-p4b';
let clock = 1_000_000;
const tick = (delta = 0): number => {
  clock += delta;
  return clock;
};

function freshRegistry(ttlMs = 60_000) {
  clock = 1_000_000;
  const notes: string[] = [];
  const registry = createScopeRegistry({
    now: (): number => tick(),
    ttlMs,
    onDiagnostic: (line: string) => notes.push(line)
  });
  return { registry, notes };
}

/** One live occupant: register the branch AND take its lease. */
function seatOccupant(
  registry: ReturnType<typeof createScopeRegistry>,
  sessionId: string,
  branchId: string,
  carrier?: object
): BranchLease {
  return registry.acquireLease({ sessionId, branchId, ...(carrier === undefined ? {} : { carrier }) });
}

describe('P4-B WeakMap leases: carrier-keyed, superseded, never retained', () => {
  it('keys a lease by the agent OBJECT (WeakMap) and supersedes the previous one', () => {
    const { registry } = freshRegistry();
    const agent = { id: 'agent-1' };
    const first = seatOccupant(registry, SESSION, 'br-carrier', agent);
    expect(first.kind).toBe('carrier');
    expect(registry.stats().live).toMatchObject({ carrierLeases: 1, keyLeases: 0, branchLeases: 1 });

    // Same carrier object -> the previous lease is superseded, never duplicated.
    const second = seatOccupant(registry, SESSION, 'br-carrier', agent);
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(first.isActive).toBe(false);
    expect(second.isActive).toBe(true);
    expect(registry.stats().live.carrierLeases).toBe(1);
    expect(registry.stats().leases.superseded).toBe(1);
    // The superseded handle can no longer terminate the new lease.
    expect(first.release()).toBe(false);
    expect(second.isActive).toBe(true);
    expect(registry.stats().leases.staleReleases).toBe(1);
  });

  it('keeps two DIFFERENT agent objects independent (identity, not equality)', () => {
    const { registry } = freshRegistry();
    const session = 'sess-two-agents';
    const agentA = { id: 'a' };
    const agentB = { id: 'b' };
    const leaseA = seatOccupant(registry, session, 'br-a', agentA);
    const leaseB = seatOccupant(registry, session, 'br-b', agentB);
    expect(leaseA.leaseId).not.toBe(leaseB.leaseId);
    expect(registry.stats().live.carrierLeases).toBe(2);
    expect(leaseA.release()).toBe(true);
    expect(leaseB.isActive).toBe(true);
    expect(registry.stats().live.carrierLeases).toBe(1);
  });

  it('holds no strong reference to the carrier (structural + real-GC proof)', async () => {
    const { registry } = freshRegistry();
    // The carrier is created inside a helper so NO strong reference survives in
    // the test scope; only the WeakRef and the registry's lease record do.
    const references: WeakRef<object>[] = [];
    const acquireInScope = (): BranchLease => {
      const carrier: { id: string; payload: string } = { id: 'gc-agent', payload: 'x'.repeat(64) };
      references.push(new WeakRef<object>(carrier));
      return registry.acquireLease({ sessionId: SESSION, branchId: 'br-gc', carrier });
    };
    const lease = acquireInScope();
    const reference = references[0];
    if (reference === undefined) {
      throw new Error('expected a WeakRef to the carrier');
    }

    // 1) Structural: neither the handle nor the summary can reach the object.
    expect(Object.getOwnPropertyNames(lease)).not.toContain('carrier');
    expect(Object.getOwnPropertyNames(lease)).not.toContain('carrierRef');
    expect(Object.values(lease).some((value) => typeof value === 'object' && value !== null && 'payload' in value)).toBe(
      false
    );
    for (const summary of registry.leases()) {
      expect(Object.getOwnPropertyNames(summary)).not.toContain('carrier');
      expect(Object.values(summary).some((value) => typeof value === 'object' && value !== null)).toBe(false);
    }
    expect(lease.isActive).toBe(true);

    // 2) Real GC (only when the runner exposes it, e.g. NODE_OPTIONS=--expose-gc):
    // dropping the caller's reference must let the object be collected, which is
    // exactly what a WeakMap key association allows. Without --expose-gc this
    // branch is not entered (no skipped test, no false green); the command that
    // DOES exercise it is recorded in docs/reports/p4-b-lease.md.
    type GcGlobal = { gc?: () => void };
    const gc = (globalThis as GcGlobal).gc;
    if (typeof gc === 'function') {
      for (let attempt = 0; attempt < 12 && reference.deref() !== undefined; attempt += 1) {
        // A WeakRef target survives the current job, so yield a macrotask first.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        gc();
      }
      expect(reference.deref()).toBeUndefined();
    }
    // The lease itself is still active until released or expired: the object
    // being collected removes the ASSOCIATION, never the bounded lease record.
    expect(lease.isActive).toBe(true);
    expect(registry.stats().live.carrierLeases).toBe(1);
  });
});

describe('P4-B invariant key-level immutability (time-ordered)', () => {
  it('A(domain) -> A2(invariant) -> dispose(A): A2 stays valid and invariant', () => {
    const { registry } = freshRegistry();
    const h1 = registry.register({ sessionId: SESSION, branchId: 'br-seq-1', role: 'domain' });
    const h2 = registry.register({ sessionId: SESSION, branchId: 'br-seq-1', role: 'invariant' });

    expect(registry.get('br-seq-1')?.isInvariant).toBe(true);
    expect(registry.get('br-seq-1')?.allowAdvice).toBe(false);
    expect(registry.stats().invariantUpgrades).toBe(1);

    // The LATE dispose of the replaced handle must not delete A'.
    h1.dispose();
    const afterLateDispose = registry.get('br-seq-1');
    expect(afterLateDispose).toBeDefined();
    expect(afterLateDispose?.isInvariant).toBe(true);
    expect(registry.stats().staleDisposeNoop).toBe(1);
    expect(registry.resolve({ sessionId: SESSION, branchId: 'br-seq-1' })).not.toBe('unknown');

    // The owner still releases the key when it really disposes.
    h2.dispose();
    expect(registry.get('br-seq-1')).toBeUndefined();
  });

  it('refuses a downgrade sequence: invariant -> domain/advice stays invariant, counted', () => {
    const { registry } = freshRegistry();
    const invariant = registry.register({
      sessionId: SESSION,
      branchId: 'br-seq-2',
      role: 'invariant',
      guidance: 'guidance_free',
      allowAdvice: false
    });
    const second = registry.register({
      sessionId: SESSION,
      branchId: 'br-seq-2',
      role: 'domain',
      guidance: 'memory',
      allowAdvice: true
    });

    const scope = registry.get('br-seq-2');
    expect(scope?.isInvariant).toBe(true);
    expect(scope?.role).toBe('invariant');
    expect(scope?.guidance).toBe('guidance_free');
    expect(scope?.allowAdvice).toBe(false);
    const stats = registry.stats();
    expect(stats.downgradePrevented).toBeGreaterThanOrEqual(1);
    expect(stats.stickyInvariantKept).toBe(1);
    expect(stats.invariantUpgrades).toBe(0);

    // Time order matters: the FIRST handle is stale after the re-registration,
    // so its dispose is a counted no-op; the CURRENT owner releases the key.
    invariant.dispose();
    expect(registry.get('br-seq-2')).toBeDefined();
    expect(registry.stats().staleDisposeNoop).toBe(1);
    second.dispose();
    expect(registry.get('br-seq-2')).toBeUndefined();
  });

  it('a dispose in the wrong order cannot resurrect or fabricate a registration', () => {
    const { registry } = freshRegistry();
    const first = registry.register({ sessionId: SESSION, branchId: 'br-seq-3', role: 'invariant' });
    registry.unregister('br-seq-3'); // operator removal, version bumps
    expect(registry.get('br-seq-3')).toBeUndefined();

    // The old handle is now stale: disposing it must not recreate anything.
    first.dispose();
    expect(registry.get('br-seq-3')).toBeUndefined();
    expect(registry.resolve({ sessionId: SESSION, branchId: 'br-seq-3' })).toBe('unknown');
    expect(registry.stats().staleDisposeNoop).toBe(1);
  });

  it('re-registering the SAME key refreshes the live record without duplicating it', () => {
    const { registry } = freshRegistry();
    const h1 = registry.register({ sessionId: SESSION, branchId: 'br-seq-4' });
    const h2 = registry.register({ sessionId: SESSION, branchId: 'br-seq-4' });
    expect(registry.size()).toBe(1);
    expect(registry.stats().registrationsReplaced).toBe(1);
    h1.dispose();
    expect(registry.size()).toBe(1);
    h2.dispose();
    expect(registry.size()).toBe(0);
  });
});

describe('P4-B sessionId lease: refused unless single occupancy is PROVEN', () => {
  it('refuses with zero occupants and with a scope but no lease (never assumed)', () => {
    const { registry } = freshRegistry();
    const empty = registry.acquireSessionLease({
      sessionId: 'sess-empty',
      grantedBy: 'operator:test',
      reason: 'probe occupant'
    });
    expect(empty).toMatchObject({ ok: false, code: 'single-occupancy-unproven' });
    expect((empty as SessionLeaseRefusal).details).toEqual({
      liveScopes: 0,
      liveBranchLeases: 0,
      liveSessionLeases: 0
    });

    // A registered scope alone does not prove occupancy: the lease is missing.
    registry.register({ sessionId: 'sess-scope-only', branchId: 'br-scope-only' });
    const scopeOnly = registry.acquireSessionLease({
      sessionId: 'sess-scope-only',
      grantedBy: 'operator:test',
      reason: 'probe occupant'
    });
    expect(scopeOnly).toMatchObject({ ok: false, code: 'single-occupancy-unproven' });
    expect((scopeOnly as SessionLeaseRefusal).details).toMatchObject({ liveScopes: 1, liveBranchLeases: 0 });
    expect(registry.stats().leases.sessionRefused['single-occupancy-unproven']).toBe(2);
    expect(registry.stats().leases.sessionGranted).toBe(0);
  });

  it('grants only for the proven single occupant and never authorizes a branch', () => {
    const { registry } = freshRegistry();
    const occupant = seatOccupant(registry, SESSION, 'br-sole');
    const result = registry.acquireSessionLease({
      sessionId: SESSION,
      grantedBy: 'operator:test',
      reason: 'sole occupant of the host session'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.lease.authorizesBranch).toBe(false);
    expect(result.lease.branchId).toBe('br-sole');
    expect(result.lease.isActive).toBe(true);
    expect(registry.sessionLeaseProof(SESSION).proven).toBe(false); // its own live lease is not "other"
    expect(registry.sessionLeaseProof(SESSION).liveSessionLeases).toBe(1);
    expect(registry.activeSessionLeases()).toHaveLength(1);

    // A second session lease for the same session is refused, not stacked.
    const second = registry.acquireSessionLease({
      sessionId: SESSION,
      grantedBy: 'operator:test',
      reason: 'duplicate'
    });
    expect(second).toMatchObject({ ok: false, code: 'session-lease-active' });

    // Releasing the occupant lease removes the proof -> the session lease dies.
    expect(occupant.release()).toBe(true);
    expect(result.lease.isActive).toBe(false);
    expect(registry.stats().leases.sessionInvalidated).toBe(1);
  });

  it('sibling probes in one session can never hold a session lease', () => {
    const { registry } = freshRegistry();
    const siblingA = seatOccupant(registry, SESSION, 'br-sibling-a');
    const siblingB = seatOccupant(registry, SESSION, 'br-sibling-b');
    const refusal = registry.acquireSessionLease({
      sessionId: SESSION,
      grantedBy: 'operator:test',
      reason: 'two siblings share the session'
    });
    expect(refusal).toMatchObject({ ok: false, code: 'single-occupancy-unproven' });
    expect((refusal as SessionLeaseRefusal).details).toEqual({
      liveScopes: 2,
      liveBranchLeases: 2,
      liveSessionLeases: 0
    });
    expect(siblingA.isActive && siblingB.isActive).toBe(true);
    expect(registry.stats().live.branchLeases).toBe(2);
  });

  it('invalidates an existing session lease the moment a second occupant appears', () => {
    const { registry } = freshRegistry();
    seatOccupant(registry, 'sess-concurrent', 'br-first');
    const granted = registry.acquireSessionLease({
      sessionId: 'sess-concurrent',
      grantedBy: 'operator:test',
      reason: 'first occupant only'
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) {
      throw new Error('unreachable');
    }
    expect(granted.lease.isActive).toBe(true);

    // A concurrent reuse of the same session refuses the proof immediately.
    seatOccupant(registry, 'sess-concurrent', 'br-second');
    expect(granted.lease.isActive).toBe(false);
    expect(registry.stats().leases.sessionInvalidated).toBe(1);
    expect(registry.sessionLeaseProof('sess-concurrent').proven).toBe(false);
    expect(registry.activeSessionLeases()).toEqual([]);
  });

  it('requires explicit provenance and refuses an empty session identity', () => {
    const { registry } = freshRegistry();
    expect(
      registry.acquireSessionLease({ sessionId: '', grantedBy: 'g', reason: 'r' })
    ).toMatchObject({ ok: false, code: 'identity-required' });
    expect(() =>
      registry.acquireSessionLease({ sessionId: SESSION, grantedBy: '  ', reason: 'r' })
    ).toThrow(/grantedBy/);
    expect(() =>
      registry.acquireSessionLease({ sessionId: SESSION, grantedBy: 'g', reason: '' })
    ).toThrow(/reason/);
    expect(registry.stats().leases.sessionRefused['identity-required']).toBe(1);
  });
});

describe('P4-B TTL, cleanup and counter closures', () => {
  it('expires a branch lease on sweep and counts it exactly once', () => {
    const { registry } = freshRegistry(60_000);
    const lease = registry.acquireLease({ sessionId: SESSION, branchId: 'br-ttl', ttlMs: 30 });
    expect(lease.isActive).toBe(true);
    tick(31);
    expect(registry.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(lease.isActive).toBe(false);
    expect(registry.stats().leases.expired).toBe(1);
    expect(lease.release()).toBe(false);
    expect(registry.stats().leases.staleReleases).toBe(1);
    // A second sweep is a no-op: the record is gone, never double-counted.
    expect(registry.sweepExpired()).toBe(0);
    expect(registry.stats().leases.expired).toBe(1);
  });

  it('expires a session lease on sweep', () => {
    const { registry } = freshRegistry(60_000);
    seatOccupant(registry, SESSION, 'br-ttl-session');
    const granted = registry.acquireSessionLease({
      sessionId: SESSION,
      grantedBy: 'operator:test',
      reason: 'ttl',
      ttlMs: 20
    });
    if (!granted.ok) {
      throw new Error('expected a session lease');
    }
    expect(granted.lease.isActive).toBe(true);
    tick(21);
    registry.sweepExpired();
    expect(granted.lease.isActive).toBe(false);
    expect(registry.stats().leases.sessionExpired).toBe(1);
  });

  it('invalidates a lease when its scope expires or is removed', () => {
    const { registry } = freshRegistry(40);
    const lease = registry.acquireLease({ sessionId: SESSION, branchId: 'br-scope-ttl' });
    tick(41);
    registry.sweepExpired();
    expect(lease.isActive).toBe(false);
    expect(registry.stats().leases.invalidated).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it('keeps lease accounting closed across a mixed sequence', () => {
    const { registry } = freshRegistry(60_000);
    const released = registry.acquireLease({ sessionId: 's1', branchId: 'b1' });
    const expired = registry.acquireLease({ sessionId: 's2', branchId: 'b2', ttlMs: 10 });
    registry.acquireLease({ sessionId: 's3', branchId: 'b3' });
    const superseded = registry.acquireLease({ sessionId: 's3', branchId: 'b3' });
    const invalidated = registry.acquireLease({ sessionId: 's4', branchId: 'b4' });
    registry.register({ sessionId: 's4', branchId: 'b4', role: 'invariant' });
    registry.unregister('b4');

    expect(released.release()).toBe(true);
    expect(superseded.release()).toBe(true);
    tick(11);
    registry.sweepExpired();
    expect(expired.isActive).toBe(false);
    expect(invalidated.isActive).toBe(false);

    const stats = registry.stats();
    expect(stats.leases.acquired).toBe(5);
    expect(stats.leases.released).toBe(2);
    expect(stats.leases.expired).toBe(1);
    expect(stats.leases.superseded).toBe(1);
    expect(stats.leases.invalidated).toBe(1);
    expect(stats.leases.acquired).toBe(
      stats.leases.released +
        stats.leases.expired +
        stats.leases.superseded +
        stats.leases.invalidated +
        stats.live.branchLeases
    );

    seatOccupant(registry, 's5', 'b5');
    const granted = registry.acquireSessionLease({ sessionId: 's5', grantedBy: 'g', reason: 'r' });
    if (!granted.ok) {
      throw new Error('expected a session lease');
    }
    registry.unregister('b5');
    expect(granted.lease.isActive).toBe(false);
    const after = registry.stats();
    expect(after.leases.sessionGranted).toBe(
      after.leases.sessionReleased +
        after.leases.sessionExpired +
        after.leases.sessionInvalidated +
        after.live.sessionLeases
    );
  });

  it('reports a frozen snapshot with closed live gauges', () => {
    const { registry } = freshRegistry();
    seatOccupant(registry, SESSION, 'br-freeze', { id: 'agent-freeze' });
    const stats = registry.stats();
    expect(Object.isFrozen(stats)).toBe(true);
    expect(Object.isFrozen(stats.leases)).toBe(true);
    expect(Object.isFrozen(stats.leases.sessionRefused)).toBe(true);
    expect(Object.isFrozen(stats.live)).toBe(true);
    expect(stats.live).toMatchObject({ branchLeases: 1, carrierLeases: 1, keyLeases: 0, sessionLeases: 0 });
  });
});

describe('P4-B adapter dispose leaves no residue', () => {
  it('releases the adapter-owned scopes and invalidates leases bound to them', async () => {
    clock = 1_000_000;
    const fixture = createHookFixture();
    const registry = createScopeRegistry({ now: (): number => tick() });
    const adapter = createDshHookHostAdapter(fixture.ctx, { scopeRegistry: registry });

    const branchMount = await adapter.registerPromptSegment({
      surfaceId: 'p4b-branch',
      branchId: 'br-adapter',
      sessionId: SESSION,
      namespace: 'harness2:probe_br-adapter',
      segment: 'p4b-branch',
      mode: 'append',
      content: 'branch text',
      mountScope: 'branch'
    });
    const hostMount = await adapter.registerPromptSegment({
      surfaceId: 'p4b-host',
      branchId: 'permanent-p4b',
      sessionId: SESSION,
      namespace: 'harness2:permanent-p4b',
      segment: 'p4b-host',
      mode: 'append',
      content: 'host text',
      mountScope: 'host',
      hostScopeGrant: 'permanent-patch:p4b'
    });

    expect(registry.get('br-adapter')).toBeDefined();
    expect(registry.activeHostScopes()).toHaveLength(1);

    // A caller's lease on the adapter's branch: adapter dispose removes the
    // scope, so the lease must be invalidated (never left live on dead state).
    const lease = registry.acquireLease({ sessionId: SESSION, branchId: 'br-adapter' });
    expect(lease.isActive).toBe(true);

    await hostMount.dispose();
    await branchMount.dispose();
    expect(registry.get('br-adapter')).toBeUndefined();
    expect(registry.activeHostScopes()).toEqual([]);
    expect(lease.isActive).toBe(false);
    expect(registry.stats().leases.invalidated).toBe(1);
    expect(registry.stats().staleDisposeNoop).toBe(0);

    await adapter.dispose();
    expect(registry.size()).toBe(0);
    expect(registry.stats().live).toMatchObject({ branchLeases: 0, sessionLeases: 0 });
  });

  it('disposing the adapter does not resurrect a replaced scope (late dispose)', async () => {
    clock = 1_000_000;
    const fixture = createHookFixture();
    const registry = createScopeRegistry({ now: (): number => tick() });
    const adapter = createDshHookHostAdapter(fixture.ctx, { scopeRegistry: registry });

    const first = await adapter.registerPromptSegment({
      surfaceId: 'p4b-first',
      branchId: 'br-late',
      sessionId: SESSION,
      namespace: 'harness2:probe_br-late',
      segment: 'p4b-first',
      mode: 'append',
      content: 'first',
      mountScope: 'branch'
    });
    const second = await adapter.registerPromptSegment({
      surfaceId: 'p4b-second',
      branchId: 'br-late',
      sessionId: SESSION,
      namespace: 'harness2:probe_br-late',
      segment: 'p4b-second',
      mode: 'append',
      content: 'second',
      mountScope: 'branch'
    });

    // Disposing the FIRST (replaced) mount must not drop the second's scope.
    await first.dispose();
    expect(registry.get('br-late')).toBeDefined();
    expect(registry.stats().staleDisposeNoop).toBe(1);

    await second.dispose();
    expect(registry.get('br-late')).toBeUndefined();
    await adapter.dispose();
  });
});
