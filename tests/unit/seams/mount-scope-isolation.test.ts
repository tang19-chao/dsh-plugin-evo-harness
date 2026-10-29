/**
 * ADR 0006 D-P4-4 / D-P4-6 acceptance: probe mounts never reach a host dispatch.
 *
 * The tests drive the REAL production mount path (CordisSeamManager ->
 * mountEightSurfaces -> DshHookHostAdapter) through the same four harness
 * waterfalls a DSH host dispatches, and prove:
 *
 *   - two sibling probes sharing ONE sessionId do not leak each other's (or
 *     their own) prompt mount into the host's system-prompt/assemble;
 *   - an identity-free host dispatch (the real agent/pre-step shape) is
 *     fail-closed for every branch-class mount, and the suppression is COUNTED
 *     per dispatch x mount in `stats().scope`;
 *   - a probe guardrails mount can never deny a host tool call (out-of-scope
 *     deny suppressed + counted), while it still denies inside its own branch;
 *   - a host-class (permanent patch) mount requires an explicit grant, is the
 *     only class that reaches an identity-free dispatch, and its grant is
 *     recorded as a trusted host scope that never authorizes a branch;
 *   - the production mount path always declares a class: it can never produce
 *     the legacy host-local class, so the fail-open compatibility path is
 *     unreachable from production code.
 *
 * Everything is in-process and deterministic: no real DSH host, no network, no
 * model call. The adapter matches the same waterfall shapes the host uses.
 */
import { describe, expect, it } from 'vitest';
import { createCordisSeamManager } from '../../../src/cordis-seams/seam-manager';
import { createDshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import type { DshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import { createScopeRegistry } from '../../../src/jitrl/scope-registry';
import type { EightSurfacePatch, ProbeExecutionResult } from '../../../src/types/contracts';
import { createHookFixture, emptyAssembly } from '../cordis-seams/hook-fixtures';
import type { AssemblyShape, HookFixture } from '../cordis-seams/hook-fixtures';

/** One session shared by the host loop and every sibling probe branch. */
const SHARED_SESSION = 'sess-shared-p4a';
const NOW = 1_700_000_000_000;

function basePatch(
  id: string,
  edits: EightSurfacePatch['edits'],
  overrides: Partial<EightSurfacePatch> = {}
): EightSurfacePatch {
  return {
    id,
    sessionId: SHARED_SESSION,
    branchId: 'patch-owner-branch',
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: id,
    rationale: 'authored by tests/unit/seams/mount-scope-isolation.test.ts (P4-A)',
    edits,
    createdAt: NOW,
    ...overrides
  };
}

function promptPatch(id: string, content: string): EightSurfacePatch {
  return basePatch(id, {
    system_prompt: { kind: 'system_prompt', mode: 'append', segment: id, content }
  });
}

function guardrailsPatch(id: string): EightSurfacePatch {
  return basePatch(id, {
    guardrails: {
      kind: 'guardrails',
      appendRules: [],
      forbiddenActions: ['tool:shell'],
      toolPreconditions: [{ toolName: 'write_file', rule: 'deny destructive writes' }]
    }
  });
}

/** Dispatch system-prompt/assemble exactly the way the host waterfall does. */
function assemble(fixture: HookFixture, context: unknown): Promise<AssemblyShape> {
  const listener = fixture.listener('system-prompt/assemble');
  const next = (): Promise<AssemblyShape> => Promise.resolve(emptyAssembly());
  return Promise.resolve(listener(emptyAssembly(), context, next)) as Promise<AssemblyShape>;
}

/** Dispatch tools/pre-execute with an allow-all host decision. */
function preExecute(fixture: HookFixture, exec: unknown): Promise<Record<string, unknown>> {
  const listener = fixture.listener('tools/pre-execute');
  const next = (): Promise<Record<string, unknown>> => Promise.resolve({ kind: 'allow' });
  return Promise.resolve(listener(exec, next)) as Promise<Record<string, unknown>>;
}

function texts(assembly: AssemblyShape): string[] {
  return assembly.sections.map((section) => section.text);
}

function names(assembly: AssemblyShape): string[] {
  return assembly.sections.map((section) => section.name);
}

describe('ADR 0006: sibling probes sharing one session never reach the host assemble', () => {
  it('keeps both sibling mounts out of host session and identity-free assemblies', async () => {
    const fixture = createHookFixture();
    const adapter: DshHookHostAdapter = createDshHookHostAdapter(fixture.ctx);
    const manager = createCordisSeamManager({ host: adapter, namespacePrefix: 'harness2' });

    let releaseA: () => void = () => undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAReady: () => void = () => undefined;
    const aReady = new Promise<void>((resolve) => {
      signalAReady = resolve;
    });

    const executorA = async (): Promise<ProbeExecutionResult> => {
      signalAReady();
      await holdA;
      return { status: 'succeeded' };
    };
    const probeA = manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-sibling-a',
      task: { id: 'task-a', prompt: 'probe A' },
      patch: promptPatch('prompt-install-a', 'PROBE_A_MARKER'),
      executor: executorA
    });
    await aReady;
    expect(manager.listActiveBranches().map((branch) => branch.branchId)).toContain('br-sibling-a');

    const observed: Record<string, unknown> = {};
    // Rendezvous: B dispatches while A is still mounted, and only then is A released.
    let signalBDispatched: () => void = () => undefined;
    const bDispatched = new Promise<void>((resolve) => {
      signalBDispatched = resolve;
    });
    const probeB = manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-sibling-b',
      task: { id: 'task-b', prompt: 'probe B' },
      patch: promptPatch('prompt-install-b', 'PROBE_B_MARKER'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        // (1) The host loop dispatches with the session it SHARES with both probes.
        observed['hostSession'] = await assemble(fixture, { agent: { id: SHARED_SESSION } });
        // (2) The real agent/pre-step shape: no identity at all.
        observed['hostAnonymous'] = await assemble(fixture, {});
        // (3) This probe's own dispatch proves its branchId -> its mount applies.
        observed['ownBranch'] = await assemble(fixture, {
          branchId: context.branchId,
          sessionId: SHARED_SESSION
        });
        // (4) The SIBLING branch dispatch sees only its own mount.
        observed['siblingBranch'] = await assemble(fixture, {
          branchId: 'br-sibling-a',
          sessionId: SHARED_SESSION
        });
        signalBDispatched();
        return { status: 'succeeded' };
      }
    });
    await bDispatched;
    releaseA();
    await Promise.all([probeA, probeB]);

    expect((observed['hostSession'] as AssemblyShape).sections).toEqual([]);
    expect((observed['hostAnonymous'] as AssemblyShape).sections).toEqual([]);
    expect(texts(observed['ownBranch'] as AssemblyShape)).toEqual(['PROBE_B_MARKER']);
    expect(texts(observed['siblingBranch'] as AssemblyShape)).toEqual(['PROBE_A_MARKER']);

    const stats = adapter.stats();
    // Both mounts were suppressed on both host dispatches: 2 mounts x 2 host
    // dispatches. The shared-session path and the anonymous path are counted
    // separately so a regression cannot hide in one of them.
    expect(stats.scope.assemble.sessionOnlySuppressed).toBe(2);
    expect(stats.scope.assemble.anonymousSuppressed).toBe(2);
    // Each branch dispatch proved exactly one branchId -> one pair applied.
    expect(stats.scope.assemble.branchProofApplied).toBe(2);
    // Applied = the two in-branch dispatches; delegated = the two host ones.
    expect(stats.assemble.applied).toBe(2);
    expect(stats.assemble.delegated).toBe(2);

    // Payload-free: no diagnostic may carry a session or branch identifier.
    const advisories = adapter.advisories().join(' ');
    expect(advisories).not.toContain(SHARED_SESSION);
    expect(advisories).not.toContain('br-sibling-a');
    expect(advisories).not.toContain('br-sibling-b');

    await manager.dispose();
    await adapter.dispose();
  });

  it('never lets a probe guardrails mount deny a host tool call (suppressed deny is counted)', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const manager = createCordisSeamManager({ host: adapter, namespacePrefix: 'harness2' });

    const observed: Record<string, unknown> = {};
    await manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-guardrails',
      task: { id: 'task-g', prompt: 'guardrails probe' },
      patch: guardrailsPatch('guardrails-probe'),
      executor: async (context): Promise<ProbeExecutionResult> => {
        observed['hostSession'] = await preExecute(fixture, {
          name: 'shell',
          agent: { id: SHARED_SESSION }
        });
        observed['hostAnonymous'] = await preExecute(fixture, { name: 'shell' });
        observed['ownDeny'] = await preExecute(fixture, {
          name: 'shell',
          branchId: context.branchId,
          sessionId: SHARED_SESSION
        });
        observed['ownAllow'] = await preExecute(fixture, {
          name: 'read_file',
          branchId: context.branchId,
          sessionId: SHARED_SESSION
        });
        return { status: 'succeeded' };
      }
    });

    // The host's own calls are never denied by a probe's guardrails.
    expect(observed['hostSession']).toEqual({ kind: 'allow' });
    expect(observed['hostAnonymous']).toEqual({ kind: 'allow' });
    // Inside its own branch the same rules still deny the covered tool.
    expect(observed['ownDeny']).toMatchObject({ kind: 'deny' });
    expect(String((observed['ownDeny'] as Record<string, unknown>)['reason'])).toContain('forbidden action: tool:shell');
    expect(observed['ownAllow']).toEqual({ kind: 'allow' });

    const stats = adapter.stats();
    expect(stats.deniedToolCalls).toBe(1);
    // One matching rule suppressed on each host dispatch.
    expect(stats.scope.deniedRulesSuppressed).toBe(2);
    expect(stats.scope.preExecute.sessionOnlySuppressed).toBe(1);
    expect(stats.scope.preExecute.anonymousSuppressed).toBe(1);

    await manager.dispose();
    await adapter.dispose();
  });
});

describe('ADR 0006: mount scope classes are explicit and authorized', () => {
  it('requires a grant for a host mount and a branchId for a branch mount', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const spec = {
      surfaceId: 'surface-p4a',
      branchId: 'br-x',
      sessionId: SHARED_SESSION,
      namespace: 'harness2:probe_br-x',
      segment: 'p4a-segment',
      mode: 'append' as const,
      content: 'HOST_TEXT'
    };

    await expect(
      adapter.registerPromptSegment({ ...spec, mountScope: 'host' })
    ).rejects.toMatchObject({ code: 'mount_scope_not_authorized' });
    await expect(
      adapter.registerPromptSegment({ ...spec, branchId: '', mountScope: 'branch' })
    ).rejects.toMatchObject({ code: 'mount_scope_not_authorized' });

    const hostMount = await adapter.registerPromptSegment({
      ...spec,
      branchId: 'permanent-demo',
      mountScope: 'host',
      hostScopeGrant: 'permanent-patch:demo'
    });
    const probeMount = await adapter.registerPromptSegment({
      ...spec,
      mountScope: 'branch',
      content: 'PROBE_TEXT'
    });

    // The host mount is the only class that reaches an identity-free dispatch.
    expect(texts(await assemble(fixture, {}))).toEqual(['HOST_TEXT']);
    // A host-session dispatch is served by the host mount only.
    expect(texts(await assemble(fixture, { agent: { id: SHARED_SESSION } }))).toEqual(['HOST_TEXT']);
    // A foreign session is outside the host mount and proves no branch.
    expect((await assemble(fixture, { agent: { id: 'sess-other' } })).sections).toEqual([]);
    // The branch dispatch proves its branchId: ambient host mount + own mount.
    expect(names(await assemble(fixture, { branchId: 'br-x', sessionId: SHARED_SESSION })).sort()).toEqual([
      'p4a-segment',
      'p4a-segment:surface-p4a'
    ]);
    // ... and the host session dispatch still shows the host mount alone.
    expect(texts(await assemble(fixture, { agent: { id: SHARED_SESSION } }))).toEqual(['HOST_TEXT']);

    await hostMount.dispose();
    await probeMount.dispose();
    await adapter.dispose();
  });

  it('declares a class on every mount the production path creates (never legacy)', async () => {
    const fixture = createHookFixture();
    const registry = createScopeRegistry();
    const adapter = createDshHookHostAdapter(fixture.ctx, { scopeRegistry: registry });
    const manager = createCordisSeamManager({ host: adapter, namespacePrefix: 'harness2' });

    let probeMounts: ReturnType<DshHookHostAdapter['activeMounts']> = [];
    await manager.runInIsolatedBranch({
      sessionId: SHARED_SESSION,
      branchId: 'br-production',
      task: { id: 'task-p', prompt: 'production path' },
      patch: promptPatch('prompt-install-production', 'PRODUCTION_PROBE'),
      executor: async (): Promise<ProbeExecutionResult> => {
        probeMounts = adapter.activeMounts();
        return { status: 'succeeded' };
      }
    });
    expect(probeMounts.map((mount) => mount.scopeClass)).toEqual(['branch']);
    expect(adapter.stats().scope.legacyHostLocalMounts).toBe(0);

    const disposer = await manager.applyPermanentPatch(promptPatch('permanent-p4a', 'PERMANENT_PATCH'));
    const permanentMounts = adapter.activeMounts();
    expect(permanentMounts.map((mount) => mount.scopeClass)).toEqual(['host']);
    expect(adapter.stats().scope.legacyHostLocalMounts).toBe(0);

    // The grant is recorded as a trusted host scope; it never authorizes a branch.
    const hostScopes = registry.activeHostScopes();
    expect(hostScopes).toHaveLength(1);
    expect(hostScopes[0]?.grantedBy).toBe('permanent-patch:permanent-p4a');
    expect(hostScopes[0]?.authorizesBranch).toBe(false);
    expect(registry.resolveHostScope({ sessionId: SHARED_SESSION })).not.toBe('unknown');
    expect(registry.resolveHostScope({ sessionId: SHARED_SESSION, branchId: 'br-production' })).toBe('unknown');

    // The permanent patch is ambient host baseline: an identity-free host
    // dispatch sees it, which is exactly why it needs the explicit grant.
    expect(texts(await assemble(fixture, {}))).toEqual(['PERMANENT_PATCH']);

    await disposer.dispose();
    expect(adapter.activeMounts()).toEqual([]);
    expect(registry.activeHostScopes()).toEqual([]);
    await manager.dispose();
    await adapter.dispose();
  });

  it('defaults an undeclared mount to branch class and counts the explicit legacy opt-in', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const mount = await adapter.registerPromptSegment({
      surfaceId: 'surface-default',
      branchId: 'br-default',
      sessionId: SHARED_SESSION,
      namespace: 'harness2:probe_br-default',
      segment: 'default-segment',
      mode: 'append',
      content: 'DEFAULT_TEXT'
    });

    // P4-C tightened default: no class means branch class, i.e. fail-closed.
    expect(adapter.activeMounts()[0]?.scopeClass).toBe('branch');
    expect(adapter.stats().scope.legacyHostLocalMounts).toBe(0);
    expect((await assemble(fixture, {})).sections).toEqual([]);
    expect((await assemble(fixture, { agent: { id: SHARED_SESSION } })).sections).toEqual([]);
    expect(texts(await assemble(fixture, { branchId: 'br-default', sessionId: SHARED_SESSION }))).toEqual([
      'DEFAULT_TEXT'
    ]);

    // The pre-ADR matching survives ONLY as a counted, explicit opt-in.
    const legacy = await adapter.registerPromptSegment({
      surfaceId: 'surface-explicit-legacy',
      branchId: 'br-explicit-legacy',
      sessionId: SHARED_SESSION,
      namespace: 'harness2:probe_br-explicit-legacy',
      segment: 'explicit-legacy',
      mode: 'append',
      content: 'EXPLICIT_LEGACY',
      mountScope: 'legacy-host-local'
    });
    expect(adapter.stats().scope.legacyHostLocalMounts).toBe(1);
    expect(texts(await assemble(fixture, {}))).toEqual(['EXPLICIT_LEGACY']);
    expect(adapter.advisories().join(' ')).toContain('explicitly opted into legacy host-local matching');

    await mount.dispose();
    await legacy.dispose();
    await adapter.dispose();
  });
});
