/**
 * P4-C fake-host contract smoke — a runnable repository test, not a one-off script.
 *
 * It covers exactly the five items the plan lists for the real smoke, plus the
 * branch tool face:
 *
 *   1. sibling probes            (same session, different branches)
 *   2. concurrent / reused session
 *   3. expired leases            (branch lease, scope and tool-face policy)
 *   4. cleanup                   (success, throw and timeout)
 *   5. mount non-leakage         (host dispatches, and host tools)
 *   +  the tool-face ALLOWLIST   (unlisted tool DENIED with structured counts)
 *
 * It drives the REAL CordisSeamManager + DshHookHostAdapter + ScopeRegistry +
 * ToolFaceRegistry through the same four harness waterfalls the host uses, but
 * against an in-process fixture: NO real DSH host, no external tool call, no
 * memory write, no model call. The real-host smoke stays **not-run** until
 * authorized; docs/reports/p4-c-toolface.md carries the per-scenario
 * authorization request text and the fake-host alternative verification.
 *
 * Boundary statement: the tool face and the context fork are IN-PROCESS
 * boundaries. They are not a sandbox — same process, same filesystem, same
 * credentials. Nothing in this file claims otherwise.
 */
import { describe, expect, it } from 'vitest';
import { createDshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import type { DshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import { createCordisSeamManager } from '../../../src/cordis-seams/seam-manager';
import { createToolFaceRegistry } from '../../../src/cordis-seams/tool-face';
import type { ToolFaceRegistry } from '../../../src/cordis-seams/tool-face';
import { createScopeRegistry } from '../../../src/jitrl/scope-registry';
import type { ScopeRegistry } from '../../../src/jitrl/scope-registry';
import type { EightSurfacePatch, ProbeExecutionResult } from '../../../src/types/contracts';
import { createHookFixture, emptyAssembly } from '../../unit/cordis-seams/hook-fixtures';
import type { AssemblyShape, HookFixture } from '../../unit/cordis-seams/hook-fixtures';

const SHARED_SESSION = 'sess-p4c-contract';
/** The ONLY tool a probe branch may call in this smoke. */
const ALLOWED_TOOL = 'read_file';
const UNLISTED_TOOL = 'write_file';

interface Clock {
  now(): number;
  tick(delta?: number): void;
}

interface Wiring {
  readonly fixture: HookFixture;
  readonly adapter: DshHookHostAdapter;
  readonly registry: ScopeRegistry;
  readonly toolFace: ToolFaceRegistry;
  readonly manager: ReturnType<typeof createCordisSeamManager>;
  readonly clock: Clock;
  dispose(): Promise<void>;
}

function createWiring(): Wiring {
  let current = 1_700_000_000_000;
  const now = (): number => current;
  const tick = (delta = 0): void => {
    current += delta;
  };
  const clock: Clock = { now, tick };
  const fixture = createHookFixture();
  const registry = createScopeRegistry({ now });
  const toolFace = createToolFaceRegistry({ now });
  const adapter = createDshHookHostAdapter(fixture.ctx, { scopeRegistry: registry, toolFace });
  const manager = createCordisSeamManager({
    host: adapter,
    namespacePrefix: 'harness2',
    toolFace,
    toolAllowlist: [ALLOWED_TOOL],
    now
  });
  return {
    fixture,
    adapter,
    registry,
    toolFace,
    manager,
    clock,
    async dispose(): Promise<void> {
      await manager.dispose();
      await adapter.dispose();
      toolFace.dispose();
      registry.dispose();
    }
  };
}

function patch(id: string, edits: EightSurfacePatch['edits']): EightSurfacePatch {
  return {
    id,
    sessionId: SHARED_SESSION,
    branchId: 'patch-owner-branch',
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: id,
    rationale: 'authored by tests/e2e/host-smoke/contract-smoke.test.ts (P4-C)',
    edits,
    createdAt: 1_700_000_000_000
  };
}

function promptPatch(id: string, content: string): EightSurfacePatch {
  return patch(id, { system_prompt: { kind: 'system_prompt', mode: 'append', segment: id, content } });
}

function guardrailsPatch(id: string): EightSurfacePatch {
  return patch(id, {
    guardrails: {
      kind: 'guardrails',
      appendRules: [],
      forbiddenActions: ['tool:shell'],
      toolPreconditions: [{ toolName: 'destroy_all', rule: 'deny destructive intent' }]
    }
  });
}

function assemble(fixture: HookFixture, context: unknown): Promise<AssemblyShape> {
  const listener = fixture.listener('system-prompt/assemble');
  const next = (): Promise<AssemblyShape> => Promise.resolve(emptyAssembly());
  return Promise.resolve(listener(emptyAssembly(), context, next)) as Promise<AssemblyShape>;
}

function preExecute(fixture: HookFixture, exec: unknown): Promise<Record<string, unknown>> {
  const listener = fixture.listener('tools/pre-execute');
  const next = (): Promise<Record<string, unknown>> => Promise.resolve({ kind: 'allow' });
  return Promise.resolve(listener(exec, next)) as Promise<Record<string, unknown>>;
}

describe('P4-C fake-host contract smoke: five plan scenarios', () => {
  it('1. sibling probes: separate tool faces and mounts, host untouched', async () => {
    const wiring = createWiring();
    const { fixture, adapter, registry, toolFace, manager } = wiring;

    let releaseA: () => void = () => undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAReady: () => void = () => undefined;
    const aReady = new Promise<void>((resolve) => {
      signalAReady = resolve;
    });

    const probeA = manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-contract-a',
      task: { id: 'task-a', prompt: 'sibling A' },
      patch: promptPatch('contract-a', 'PROMPT_A'),
      executor: async (): Promise<ProbeExecutionResult> => {
        signalAReady();
        await holdA;
        return { status: 'succeeded' };
      }
    });
    await aReady;

    const observed: Record<string, unknown> = {};
    let signalBDispatched: () => void = () => undefined;
    const bDispatched = new Promise<void>((resolve) => {
      signalBDispatched = resolve;
    });
    const probeB = manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-contract-b',
      task: { id: 'task-b', prompt: 'sibling B' },
      patch: promptPatch('contract-b', 'PROMPT_B'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        // Host dispatches while TWO sibling probes share the session.
        observed['hostAnonymous'] = await assemble(fixture, {});
        observed['hostSession'] = await assemble(fixture, { agent: { id: SHARED_SESSION } });
        observed['siblingBranch'] = await assemble(fixture, {
          branchId: 'br-contract-a',
          sessionId: SHARED_SESSION
        });
        observed['ownBranch'] = await assemble(fixture, { branchId: context.branchId, sessionId: SHARED_SESSION });

        observed['ownAllowed'] = await preExecute(fixture, {
          name: ALLOWED_TOOL,
          branchId: context.branchId,
          sessionId: SHARED_SESSION
        });
        observed['ownUnlisted'] = await preExecute(fixture, {
          name: UNLISTED_TOOL,
          branchId: context.branchId,
          sessionId: SHARED_SESSION
        });
        // The sibling's tool face is separate: the same allowlist applies, but
        // the decision is resolved through branch A's own policy id.
        observed['siblingUnlisted'] = await preExecute(fixture, {
          name: UNLISTED_TOOL,
          branchId: 'br-contract-a',
          sessionId: SHARED_SESSION
        });
        observed['hostUnlisted'] = await preExecute(fixture, {
          name: UNLISTED_TOOL,
          agent: { id: SHARED_SESSION }
        });
        // Both sibling branches are still live at this point.
        observed['liveScopes'] = registry.size();
        observed['livePolicies'] = toolFace.policies().length;
        observed['policyIdsDiffer'] =
          toolFace.policyFor('br-contract-a')?.policyId !== toolFace.policyFor('br-contract-b')?.policyId;
        signalBDispatched();
        return { status: 'succeeded' };
      }
    });
    await bDispatched;
    releaseA();
    await Promise.all([probeA, probeB]);

    // Mount non-leakage (scenario 5, while both siblings are live).
    expect((observed['hostAnonymous'] as AssemblyShape).sections).toEqual([]);
    expect((observed['hostSession'] as AssemblyShape).sections).toEqual([]);
    expect((observed['siblingBranch'] as AssemblyShape).sections.map((s) => s.text)).toEqual(['PROMPT_A']);
    expect((observed['ownBranch'] as AssemblyShape).sections.map((s) => s.text)).toEqual(['PROMPT_B']);

    // Tool face: allowlisted tool allowed, unlisted DENIED, host never denied.
    expect(observed['ownAllowed']).toEqual({ kind: 'allow' });
    expect(observed['ownUnlisted']).toMatchObject({ kind: 'deny' });
    expect(String((observed['ownUnlisted'] as Record<string, unknown>)['reason'])).toContain(UNLISTED_TOOL);
    expect(observed['siblingUnlisted']).toMatchObject({ kind: 'deny' });
    expect(observed['hostUnlisted']).toEqual({ kind: 'allow' });

    const face = toolFace.stats();
    expect(face.deniedNotAllowlisted).toBe(2);
    expect(face.allowed).toBe(1);
    expect(face.outOfScope).toBeGreaterThanOrEqual(1);
    expect(adapter.stats().toolFace.denials).toBe(2);
    // Two branch-class scopes and two DISTINCT policies were live during the
    // rendezvous; cleanup removed all of them afterwards.
    expect(observed['liveScopes']).toBe(2);
    expect(observed['livePolicies']).toBe(2);
    expect(observed['policyIdsDiffer']).toBe(true);
    expect(registry.size()).toBe(0);
    expect(toolFace.policies()).toEqual([]);
    await wiring.dispose();
  });

  it('2. concurrent/reused session: per-branch policies, replacement counted, no residue', async () => {
    const wiring = createWiring();
    const { toolFace, manager, registry } = wiring;

    const policyIds: string[] = [];
    let signalReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.runInIsolatedBranch({
      sessionId: 'sess-reuse',
      branchId: 'br-reuse',
      task: { id: 'task-reuse-1', prompt: 'first' },
      patch: promptPatch('reuse-1', 'REUSE_1'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        policyIds.push(toolFace.policyFor(context.branchId)?.policyId ?? 'missing');
        signalReady();
        await held;
        return { status: 'succeeded' };
      }
    });
    await ready;

    // Concurrent second branch on the same session: its own policy.
    const concurrent = manager.runInIsolatedBranch({
      sessionId: 'sess-reuse',
      branchId: 'br-reuse-sibling',
      task: { id: 'task-reuse-2', prompt: 'concurrent' },
      patch: promptPatch('reuse-2', 'REUSE_2'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        policyIds.push(toolFace.policyFor(context.branchId)?.policyId ?? 'missing');
        return { status: 'succeeded' };
      }
    });
    await concurrent;
    expect(new Set(policyIds).size).toBe(2);
    release();
    await first;

    // Reuse: the same branchId again gets a fresh policy (replace, not inherit).
    let reusedPolicyId = '';
    await manager.runInIsolatedBranch({
      sessionId: 'sess-reuse',
      branchId: 'br-reuse',
      task: { id: 'task-reuse-3', prompt: 'reused' },
      patch: promptPatch('reuse-3', 'REUSE_3'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        reusedPolicyId = toolFace.policyFor(context.branchId)?.policyId ?? 'missing';
        // A live branch may refine its own face; that is a REPLACEMENT (counted),
        // and it stays scoped to this branch only.
        toolFace.install({ branchId: context.branchId, allowTools: ['shell'] });
        return { status: 'succeeded' };
      }
    });
    // Reuse after cleanup installs a FRESH policy (no inheritance)...
    expect(reusedPolicyId).not.toBe(policyIds[0]);
    // ... and the live refinement is the only replacement.
    expect(toolFace.stats().replacements).toBe(1);
    expect(toolFace.policies()).toEqual([]);
    expect(registry.size()).toBe(0);
    await wiring.dispose();
  });

  it('3. expired leases: the branch lease, scope and tool-face policy all expire and count', async () => {
    const wiring = createWiring();
    const { registry, toolFace, clock } = wiring;

    const lease = registry.acquireLease({ sessionId: 'sess-ttl', branchId: 'br-ttl', ttlMs: 30 });
    const policy = toolFace.install({ branchId: 'br-ttl', allowTools: [ALLOWED_TOOL], ttlMs: 20 });
    expect(lease.isActive).toBe(true);
    expect(toolFace.policyFor('br-ttl')?.policyId).toBe(policy.policyId);

    clock.tick(31);
    expect(lease.isActive).toBe(false); // lazy expiry at the observation point
    expect(toolFace.policyFor('br-ttl')).toBeUndefined();
    expect(toolFace.stats().expiredPolicies).toBe(1);
    expect(registry.stats().leases.expired).toBe(1);
    // Lease TTL bounds the LEASE only: the scope keeps its own lifetime, so a
    // registration outlives its lease (documented design, P4-B report section 6).
    expect(registry.size()).toBe(1);
    // Pruning past the scope's own TTL (registry default: 30 min) removes it;
    // the expired lease cannot resurrect it.
    expect(registry.prune(clock.now() + 3_600_000)).toBeGreaterThanOrEqual(1);
    expect(registry.size()).toBe(0);
    expect(registry.leases()).toEqual([]);
    await wiring.dispose();
  });

  it('4. cleanup: success, throw and timeout all leave nothing behind', async () => {
    const wiring = createWiring();
    const { manager, adapter, registry, toolFace } = wiring;

    const assertClean = (): void => {
      expect(manager.listActiveBranches()).toEqual([]);
      expect(adapter.activeMounts()).toEqual([]);
      expect(toolFace.policies()).toEqual([]);
      expect(registry.size()).toBe(0);
      expect(registry.activeHostScopes()).toEqual([]);
      expect(registry.leases()).toEqual([]);
    };

    await manager.runInIsolatedBranch({
      sessionId: 'sess-clean-ok',
      branchId: 'br-clean-ok',
      task: { id: 'task-ok', prompt: 'ok' },
      patch: promptPatch('clean-ok', 'OK'),
      executor: async (): Promise<ProbeExecutionResult> => ({ status: 'succeeded' })
    });
    assertClean();

    const thrown = await manager.runInIsolatedBranch({
      sessionId: 'sess-clean-throw',
      branchId: 'br-clean-throw',
      task: { id: 'task-throw', prompt: 'throw' },
      patch: promptPatch('clean-throw', 'THROW'),
      executor: async (): Promise<ProbeExecutionResult> => {
        throw new Error('synthetic executor failure');
      }
    });
    expect(thrown.status).toBe('failed');
    assertClean();

    const timedOut = await manager.runInIsolatedBranch({
      sessionId: 'sess-clean-timeout',
      branchId: 'br-clean-timeout',
      task: { id: 'task-timeout', prompt: 'timeout' },
      patch: promptPatch('clean-timeout', 'TIMEOUT'),
      timeoutMs: 25,
      executor: async (): Promise<ProbeExecutionResult> => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { status: 'succeeded' };
      }
    });
    expect(timedOut.status).toBe('timeout');
    assertClean();
    await wiring.dispose();
  });

  it('5. mount non-leakage: host dispatches never see a probe mount or a probe deny', async () => {
    const wiring = createWiring();
    const { fixture, adapter, toolFace, manager } = wiring;

    let observed: Record<string, unknown> = {};
    await manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-nonleak',
      task: { id: 'task-nonleak', prompt: 'non-leakage' },
      patch: guardrailsPatch('nonleak'),
      executor: async (): Promise<ProbeExecutionResult> => {
        observed = {
          hostAnonymousAssemble: await assemble(fixture, {}),
          hostSessionAssemble: await assemble(fixture, { agent: { id: SHARED_SESSION } }),
          hostAnonymousTool: await preExecute(fixture, { name: UNLISTED_TOOL }),
          hostSessionTool: await preExecute(fixture, { name: 'shell', agent: { id: SHARED_SESSION } })
        };
        return { status: 'succeeded' };
      }
    });

    expect((observed['hostAnonymousAssemble'] as AssemblyShape).sections).toEqual([]);
    expect((observed['hostSessionAssemble'] as AssemblyShape).sections).toEqual([]);
    expect(observed['hostAnonymousTool']).toEqual({ kind: 'allow' });
    // The probe's "forbidden action: tool:shell" must NOT deny the host call.
    expect(observed['hostSessionTool']).toEqual({ kind: 'allow' });
    const stats = adapter.stats();
    expect(stats.deniedToolCalls).toBe(0);
    expect(stats.scope.assemble.anonymousSuppressed).toBeGreaterThanOrEqual(1);
    expect(stats.scope.assemble.sessionOnlySuppressed).toBeGreaterThanOrEqual(1);
    // Two host dispatches were suppressed by the branch-class guardrails mount,
    // but only the 'shell' one matched its deny rule (the other names write_file).
    expect(stats.scope.deniedRulesSuppressed).toBe(1);
    expect(toolFace.stats().outOfScope).toBe(2);
    await wiring.dispose();
  });
});

describe('P4-C branch tool face: the allowlist is provable in both directions', () => {
  it('denies an unlisted tool with a structured decision and counter (negative case)', () => {
    const toolFace = createToolFaceRegistry();
    toolFace.install({ branchId: 'br-x', allowTools: [ALLOWED_TOOL] });

    const allowed = toolFace.decide({ toolName: ALLOWED_TOOL, branchId: 'br-x' });
    expect(allowed).toMatchObject({ allowed: true, code: 'allowlisted', branchId: 'br-x' });

    const denied = toolFace.decide({ toolName: UNLISTED_TOOL, branchId: 'br-x' });
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe('not-allowlisted');
    expect(denied.reason).toContain(UNLISTED_TOOL);
    expect(denied.branchId).toBe('br-x');

    const explicit = createToolFaceRegistry();
    explicit.install({
      branchId: 'br-y',
      allowTools: [ALLOWED_TOOL],
      denyTools: [{ toolName: ALLOWED_TOOL, reason: 'this branch may not read files' }]
    });
    expect(explicit.decide({ toolName: ALLOWED_TOOL, branchId: 'br-y' })).toMatchObject({
      allowed: false,
      code: 'explicitly-denied',
      reason: 'this branch may not read files'
    });
    expect(explicit.stats().deniedExplicit).toBe(1);

    const stats = toolFace.stats();
    expect(stats.deniedNotAllowlisted).toBe(1);
    expect(stats.allowed).toBe(1);
    expect(stats.checks).toBe(stats.allowed + stats.deniedNotAllowlisted + stats.deniedExplicit + stats.outOfScope + stats.noPolicy + stats.registryDisposed);
  });

  it('refuses a wildcard allowlist and an empty branch id', () => {
    const toolFace = createToolFaceRegistry();
    expect(() => toolFace.install({ branchId: 'br-x', allowTools: ['*'] })).toThrow(/must not contain/);
    expect(() => toolFace.install({ branchId: '', allowTools: [ALLOWED_TOOL] })).toThrow(/branchId/);
    expect(() => toolFace.install({ branchId: 'br-x', allowTools: ['  '] })).toThrow(/non-empty tool names/);
    expect(toolFace.policies()).toEqual([]);
  });

  it('a branch without a policy is reported as noPolicy, never as a silent pass', () => {
    const toolFace = createToolFaceRegistry();
    const decision = toolFace.decide({ toolName: UNLISTED_TOOL, branchId: 'br-without-policy' });
    expect(decision).toMatchObject({ allowed: true, code: 'no-policy' });
    expect(toolFace.stats().noPolicy).toBe(1);
    // The absence is visible, so "not enforced" can never be read as "enforced".
    expect(toolFace.policies()).toEqual([]);
  });

  it('the adapter re-checks the allowlist on every call after a policy is removed', async () => {
    const wiring = createWiring();
    const { fixture, toolFace } = wiring;
    let observed: Record<string, unknown> = {};
    await wiring.manager.runInIsolatedBranch({
      sessionId: 'sess-remove',
      branchId: 'br-remove',
      task: { id: 'task-remove', prompt: 'remove' },
      patch: promptPatch('remove', 'REMOVE'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        observed['before'] = await preExecute(fixture, {
          name: UNLISTED_TOOL,
          branchId: context.branchId,
          sessionId: 'sess-remove'
        });
        toolFace.remove(context.branchId);
        observed['after'] = await preExecute(fixture, {
          name: UNLISTED_TOOL,
          branchId: context.branchId,
          sessionId: 'sess-remove'
        });
        return { status: 'succeeded' };
      }
    });
    expect(observed['before']).toMatchObject({ kind: 'deny' });
    expect(observed['after']).toEqual({ kind: 'allow' });
    expect(toolFace.stats().noPolicy).toBe(1);
    await wiring.dispose();
  });
});
