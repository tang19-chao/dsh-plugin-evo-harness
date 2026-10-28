/**
 * Status observability contract (ADR 0005 section 3.7, t5).
 *
 * Locks the machine-readable observability source the real hook adapter hands
 * to the entrypoint status mapping (t7):
 *
 *   - every counter comes from a real event point (considered at the
 *     advice-eligibility entry, excludedByDeclaration at declared-rule
 *     rejections, scopeUnknownSkipped at D1-fail-closed rejections);
 *   - "NOT COLLECTED ≠ ZERO": the public type keeps every counter optional so
 *     an uncollected source stays absent (and JSON-serializes as absent),
 *     while the real adapter always reports full measured numbers — a 0 on
 *     this adapter is a measured zero;
 *   - counters are payload-free (ADR 0001 section 2.3): only numbers and the
 *     adapter's own diagnostics strings, never tool arguments or bodies.
 *
 * No DSH runtime, network or LLM is involved.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DSH_HOOK_EVENT_NAMES,
  createDshHookHostAdapter,
  type DshHookHostAdapter
} from '../../../src/cordis-seams';
import type { HostAdvisorObservabilityCounters } from '../../../src/types/contracts';
import type { HostAdvisor } from '../../../src/jitrl/host-advisor';
import { createScopeRegistry } from '../../../src/jitrl/scope-registry';
import {
  createHookFixture,
  type AssemblyShape,
  type HookFixture,
  emptyAssembly
} from '../cordis-seams/hook-fixtures';

function dispatchPreExecute(fixture: HookFixture, exec: unknown): Promise<Record<string, unknown>> {
  const listener = fixture.listener('tools/pre-execute');
  const next = (): Promise<Record<string, unknown>> => Promise.resolve({ kind: 'allow' });
  return Promise.resolve(listener(exec, next)) as Promise<Record<string, unknown>>;
}

function dispatchPreStep(
  fixture: HookFixture,
  payload: unknown,
  stepDecision: Record<string, unknown> = { kind: 'enter', messages: [] }
): Promise<Record<string, unknown>> {
  const listener = fixture.listener('agent/pre-step');
  const next = (): Promise<Record<string, unknown>> => Promise.resolve(stepDecision);
  return Promise.resolve(listener(payload, next)) as Promise<Record<string, unknown>>;
}

function createMockHostAdvisor(evaluate: (req: unknown) => Promise<unknown>): HostAdvisor {
  return {
    evaluate: evaluate as unknown as HostAdvisor['evaluate'],
    diagnostics: (): readonly string[] => ['payload-free diagnostic note']
  };
}

/**
 * A stats source that genuinely does not collect: satisfies the structural
 * probe the entrypoint uses (typeof hostAdvisorStats === 'function') while
 * returning a shape without measured counters.
 */
function createUncollectedStatsAdapter(): {
  hostAdvisorStats(): HostAdvisorObservabilityCounters;
} {
  return {
    hostAdvisorStats: (): HostAdvisorObservabilityCounters => ({})
  };
}

describe('observability counters: zero, increment, declared exclusion (real event points)', () => {
  it('reports a full measured snapshot at zero before any dispatch (0 = measured, not uncollected)', () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const stats = adapter.hostAdvisorStats();
    expect(stats).toEqual({
      advisory: 0,
      ask: 0,
      noop: 0,
      skipped: 0,
      scopeUnknownSkipped: 0,
      considered: 0,
      excludedByDeclaration: 0
    });
    // every key present and numeric: NOT-collected is impossible on this adapter
    for (const value of Object.values(stats)) {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('counts considered on every eligibility decision and scopeUnknownSkipped on D1 rejections', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'gate must not run' });
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'gate'
    });
    adapter.install();

    // anonymous dispatch: enters the decision (considered), fails closed (scopeUnknown)
    await dispatchPreExecute(fixture, { name: 'bash' });
    let stats = adapter.hostAdvisorStats();
    expect(stats.considered).toBe(1);
    expect(stats.scopeUnknownSkipped).toBe(1);
    expect(stats.excludedByDeclaration).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();

    // a second anonymous dispatch increments both again (gate mode observes
    // tools/pre-execute; the pre-step advisory path is covered below with its
    // own advisory-mode adapter)
    await dispatchPreExecute(fixture, { name: 'bash' });
    stats = adapter.hostAdvisorStats();
    expect(stats.considered).toBe(2);
    expect(stats.scopeUnknownSkipped).toBe(2);

    await adapter.dispose();
  });

  it('counts excludedByDeclaration for declared invariant scope, separately from scopeUnknownSkipped', async () => {
    const evaluate = vi.fn().mockResolvedValue({ kind: 'advisory', text: 'must not appear' });
    // the advisor scope itself is a declaration: outside it = excluded by declaration
    const scopedFixture = createHookFixture();
    const scopedAdapter = createDshHookHostAdapter(scopedFixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'advisory',
      hostAdvisorScope: { branchId: 'declared-br' }
    });
    scopedAdapter.install();

    await dispatchPreStep(scopedFixture, { branchId: 'other-br', sessionId: 'sess-1' });
    const stats = scopedAdapter.hostAdvisorStats();
    expect(stats.considered).toBe(1);
    expect(stats.excludedByDeclaration).toBe(1);
    // a declared exclusion is NOT an unprovable identity: D1 counter stays 0
    expect(stats.scopeUnknownSkipped).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();

    await scopedAdapter.dispose();
  });

  it('counts excludedByDeclaration for a trusted invariant registration, not scopeUnknownSkipped', async () => {
    const fixture = createHookFixture();
    const registry = createFreshScopeRegistry();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'never' });
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'gate',
      scopeRegistry: registry
    });
    adapter.install();

    await dispatchPreExecute(fixture, {
      name: 'shell',
      branchId: 'inv-branch-1',
      sessionId: 'sess-inv'
    });
    const stats = adapter.hostAdvisorStats();
    expect(stats.considered).toBe(1);
    expect(stats.excludedByDeclaration).toBe(1);
    expect(stats.scopeUnknownSkipped).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();

    await adapter.dispose();
  });

  it('does not count considered when the advisor is off (skip happens before eligibility)', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'never' });
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'gate',
      hostAdvisorRuntimeEnabled: (): boolean => false
    });
    adapter.install();

    await dispatchPreExecute(fixture, { name: 'bash', branchId: 'br-1', sessionId: 'sess-1' });
    const stats = adapter.hostAdvisorStats();
    // runtime gate fires BEFORE the eligibility decision: skipped, not considered
    expect(stats.skipped).toBe(1);
    expect(stats.considered).toBe(0);
    expect(stats.scopeUnknownSkipped).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();

    await adapter.dispose();
  });

  it('keeps the counters independent of the outcome counters (advisory/ask/noop unchanged)', async () => {
    const fixture = createHookFixture();
    const registry = createFreshScopeRegistry();
    registry.register({ branchId: 'br-ok', sessionId: 'sess-ok', role: 'domain' });
    const evaluate = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'below support' });
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'gate',
      scopeRegistry: registry
    });
    adapter.install();

    await dispatchPreExecute(fixture, { name: 'bash', branchId: 'br-ok', sessionId: 'sess-ok' });
    const stats = adapter.hostAdvisorStats();
    expect(stats.considered).toBe(1);
    expect(stats.excludedByDeclaration).toBe(0);
    expect(stats.scopeUnknownSkipped).toBe(0);
    expect(stats.noop).toBe(1);
    expect(stats.skipped).toBe(0);

    await adapter.dispose();
  });
});

describe('serialized shape: JSON round-trip keeps counters and drops nothing into zeros', () => {
  it('JSON round-trip of the real adapter snapshot preserves every counter', () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const snapshot = adapter.hostAdvisorStats();
    const restored = JSON.parse(JSON.stringify(snapshot)) as HostAdvisorObservabilityCounters;
    expect(restored).toEqual(snapshot);
    expect(Object.keys(restored).sort()).toEqual(
      ['advisory', 'ask', 'considered', 'excludedByDeclaration', 'noop', 'scopeUnknownSkipped', 'skipped'].sort()
    );
  });

  it('JSON round-trip of an uncollected source drops the counter keys entirely (never 0)', () => {
    const source = createUncollectedStatsAdapter();
    const restored = JSON.parse(JSON.stringify(source.hostAdvisorStats())) as Record<string, unknown>;
    // absence survives serialization; a fabricated 0 would not
    expect(restored).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(restored, 'advisory')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(restored, 'scopeUnknownSkipped')).toBe(false);
  });
});

describe('not-collected vs zero: the mapping source stays optional, the adapter stays total', () => {
  it('isolates the two shapes at the type level (compile-time proof)', () => {
    // The public contract keeps every counter optional so an entrypoint can
    // express "not collected" by omitting keys (F-15 fix).
    const uncollected: HostAdvisorObservabilityCounters = {};
    expect(uncollected.advisory).toBeUndefined();
    expect(uncollected.scopeUnknownSkipped).toBeUndefined();

    // The real adapter snapshot type demands every counter; an empty object
    // must not satisfy it. The assertion only compiles when the types differ.
    type SnapshotRequired = Required<HostAdvisorObservabilityCounters>;
    const typeProof: [HostAdvisorObservabilityCounters] extends [SnapshotRequired] ? never : true = true;
    expect(typeProof).toBe(true);
  });

  it('real adapter snapshot is assignable to the optional contract shape (t7 spread target)', () => {
    const fixture = createHookFixture();
    const adapter: DshHookHostAdapter = createDshHookHostAdapter(fixture.ctx);
    const snapshot: Required<HostAdvisorObservabilityCounters> = adapter.hostAdvisorStats();
    const asContract: HostAdvisorObservabilityCounters = snapshot;
    expect(asContract).toEqual(snapshot);
  });
});

describe('payload-free guarantee (ADR 0001 section 2.3)', () => {
  it('counters carry no tool arguments, payload bodies or advice text', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'SECRET_REASON_MARKER' });
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'gate'
    });
    adapter.install();

    const payloadMarker = 'SECRET_PAYLOAD_BODY_MUST_NOT_APPEAR';
    await dispatchPreExecute(fixture, { name: 'bash', note: payloadMarker });
    const snapshot = JSON.parse(JSON.stringify(adapter.hostAdvisorStats())) as unknown;
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(payloadMarker);
    expect(serialized).not.toContain('SECRET_REASON_MARKER');
    expect(serialized).not.toContain('bash');
    // only counter keys, nothing else
    expect(Object.keys(snapshot as Record<string, unknown>).sort()).toEqual(
      ['advisory', 'ask', 'considered', 'excludedByDeclaration', 'noop', 'scopeUnknownSkipped', 'skipped'].sort()
    );

    await adapter.dispose();
  });
});

describe('adapter surface invariants the status mapping relies on', () => {
  it('keeps the four owned hook events and a full counter snapshot after activity', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    adapter.install();
    expect(adapter.installedHookEvents().sort()).toEqual([...DSH_HOOK_EVENT_NAMES].sort());

    await dispatchAssemble(fixture);
    expect(adapter.stats().assemble.delegated).toBe(1);
    // advisor counters untouched by a plain assembly with no advisor attached
    expect(adapter.hostAdvisorStats().considered).toBe(0);
    await adapter.dispose();
  });
});

async function dispatchAssemble(fixture: HookFixture): Promise<AssemblyShape> {
  const listener = fixture.listener('system-prompt/assemble');
  const next = (): Promise<AssemblyShape> => Promise.resolve(emptyAssembly());
  return (await Promise.resolve(listener(emptyAssembly(), {}, next))) as AssemblyShape;
}

/** Fresh registry per test. */
function createFreshScopeRegistry(): ReturnType<typeof createScopeRegistry> {
  return createScopeRegistry();
}
