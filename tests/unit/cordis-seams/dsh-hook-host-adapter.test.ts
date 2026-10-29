/**
 * Real DSH hook adapter tests.
 *
 * Fixtures are minimal structural stand-ins for a DeepSeek Harness context: an
 * `on(event, listener)` registrar that records listeners plus one DSH service,
 * so the adapter is exercised through the same waterfall shapes the host uses
 * (`system-prompt/assemble`, `tools/pre-execute`, `tools/post-execute`,
 * `agent/pre-step`). Everything is in-process and deterministic.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DSH_HOOK_EVENT_NAMES,
  DSH_HOOK_HOST_SOURCE,
  createDshHookHostAdapter,
  detectDshHookHost,
  hookScopeMatches,
  readHookScope,
  type DshHookEventName
} from '../../../src/cordis-seams';
import {
  createEvoHarnessPlugin,
  resolveHostAdapter
} from '../../../src/index';
import type { AssemblyShape, HookFixture } from './hook-fixtures';
import { createHookFixture, emptyAssembly } from './hook-fixtures';
import { createScopeRegistry } from '../../../src/jitrl/scope-registry';
import type { HostAdvisor } from '../../../src/jitrl/host-advisor';

function dispatchAssemble(
  fixture: HookFixture,
  assembly: AssemblyShape = emptyAssembly(),
  context: unknown = {}
): Promise<AssemblyShape> {
  const listener = fixture.listener('system-prompt/assemble');
  const next = (): Promise<AssemblyShape> => Promise.resolve(assembly);
  return Promise.resolve(listener(assembly, context, next)) as Promise<AssemblyShape>;
}

function dispatchPreExecute(
  fixture: HookFixture,
  exec: unknown
): Promise<Record<string, unknown>> {
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
    diagnostics: () => []
  };
}

const baseSpec = {
  surfaceId: 'harness2:probe_br-1#system_prompt',
  branchId: 'br-1',
  sessionId: 'sess-1',
  namespace: 'harness2:probe_br-1'
};

describe('DSH hook detection', () => {
  it('detects a hook host only when on() and a DSH service are present', () => {
    const fixture = createHookFixture();
    expect(detectDshHookHost(fixture.ctx).detected).toBe(true);

    expect(detectDshHookHost({ on: () => undefined }).detected).toBe(false);
    expect(detectDshHookHost({}).detected).toBe(false);
    // A structural-only mock keeps the context adapter path.
    expect(detectDshHookHost({ prompt: { registerSegment: () => undefined }, on: () => undefined }).detected).toBe(false);
  });

  it('lists the four hook events it owns', () => {
    expect([...DSH_HOOK_EVENT_NAMES]).toEqual([
      'system-prompt/assemble',
      'tools/pre-execute',
      'tools/post-execute',
      'agent/pre-step'
    ]);
    expect(DSH_HOOK_HOST_SOURCE).toBe('dsh-hooks');
  });
});

describe('prompt segments through system-prompt/assemble', () => {
  it('makes a mounted segment visible and removes it after dispose', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);

    const disposer = await adapter.registerPromptSegment({
      ...baseSpec,
      segment: 'evo-harness-system_prompt',
      mode: 'append',
      content: 'Prefer evidence over speculation.',
      priority: 5,
      // P4-C: identity-free visibility is an explicitly granted host scope.
      mountScope: 'host',
      hostScopeGrant: 'test-integrator:host-scope'
    });

    const mounted = await dispatchAssemble(fixture);
    expect(mounted.sections.map((section) => section.name)).toContain('evo-harness-system_prompt');
    expect(mounted.sections.map((section) => section.text)).toContain('Prefer evidence over speculation.');

    await disposer.dispose();
    const after = await dispatchAssemble(fixture);
    expect(after.sections).toEqual([]);
    // the listener stays installed as a transparent pass-through until the
    // adapter itself is disposed, so no host effect outlives the adapter
    expect(adapter.installedHookEvents()).toContain('system-prompt/assemble');
    await adapter.dispose();
    expect(adapter.installedHookEvents()).toEqual([]);
    expect(fixture.listenerNames()).toEqual([]);
  });

  it('installs the hook listeners once for the adapter lifetime and uninstalls on dispose', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const on = fixture.ctx.on as unknown as ReturnType<typeof vi.fn>;

    // probing a context installs nothing
    expect(adapter.installedHookEvents()).toEqual([]);
    expect(on).not.toHaveBeenCalled();

    const first = await adapter.registerPromptSegment({
      ...specFor('br-a'),
      segment: 'segment-a',
      mode: 'append',
      content: 'A'
    });
    expect(adapter.installedHookEvents().sort()).toEqual([...DSH_HOOK_EVENT_NAMES].sort());
    const callsAfterFirst = on.mock.calls.length;
    expect(callsAfterFirst).toBe(DSH_HOOK_EVENT_NAMES.length);

    const second = await adapter.registerPromptSegment({
      ...specFor('br-b'),
      segment: 'segment-b',
      mode: 'append',
      content: 'B'
    });
    // further mounts reuse the installed listeners instead of re-registering
    expect(on.mock.calls.length).toBe(callsAfterFirst);

    await first.dispose();
    expect(adapter.activeMounts()).toHaveLength(1);
    await second.dispose();
    expect(adapter.activeMounts()).toEqual([]);

    await adapter.dispose();
    expect(fixture.listenerNames()).toEqual([]);
    // dispose is idempotent and never unregisters twice
    await adapter.dispose();
    expect(fixture.listenerNames()).toEqual([]);
  });

  it('replaces an existing same-named section when mode is replace', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    await adapter.registerPromptSegment({
      ...baseSpec,
      segment: 'identity',
      mode: 'replace',
      content: 'You are an evolved harness.',
      mountScope: 'host',
      hostScopeGrant: 'test-integrator:host-scope'
    });

    const result = await dispatchAssemble(fixture, {
      sections: [{ name: 'identity', text: 'You are a helpful assistant.' }]
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.text).toBe('You are an evolved harness.');
  });

  it('never clobbers a foreign same-named section in append mode', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    await adapter.registerPromptSegment({
      ...baseSpec,
      segment: 'tool:bash',
      mode: 'append',
      content: 'evo guidance',
      mountScope: 'host',
      hostScopeGrant: 'test-integrator:host-scope'
    });

    const result = await dispatchAssemble(fixture, {
      sections: [{ name: 'tool:bash', text: 'the host guidance' }]
    });

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toEqual({ name: 'tool:bash', text: 'the host guidance' });
    expect(result.sections[1]?.text).toBe('evo guidance');
    expect(result.sections[1]?.name).not.toBe('tool:bash');

    // a second assembly is idempotent: no duplicate section is appended
    const again = await dispatchAssemble(fixture, { sections: result.sections });
    expect(again.sections).toHaveLength(2);
    await adapter.dispose();
  });

  it('delegates with next() and preserves every other contribution', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    await adapter.registerPromptSegment({
      ...baseSpec,
      segment: 'evo',
      mode: 'append',
      content: 'evo text',
      mountScope: 'host',
      hostScopeGrant: 'test-integrator:host-scope'
    });

    const result = await dispatchAssemble(fixture, {
      sections: [{ name: 'tool:bash', text: 'prefer bash' }],
      contexts: [{ name: 'cwd', text: '/repo' }],
      tools: [{ name: 'shell' }],
      variables: { provider: 'test' }
    });

    expect(result.sections.map((section) => section.name)).toEqual(['tool:bash', 'evo']);
    expect(result.contexts).toEqual([{ name: 'cwd', text: '/repo' }]);
    expect(result.tools).toEqual([{ name: 'shell' }]);
    expect(result.variables).toEqual({ provider: 'test' });
    expect(adapter.stats().assemble.applied).toBe(1);
  });
});

describe('branch and session scoping', () => {
  it('applies a mount only to the branch/session that owns it', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    await adapter.registerPromptSegment({ ...baseSpec, segment: 'br-1', mode: 'append', content: 'only br-1' });

    const matching = await dispatchAssemble(fixture, emptyAssembly(), {
      agent: { id: 'sess-1', branchId: 'br-1' }
    });
    expect(matching.sections.map((section) => section.name)).toEqual(['br-1']);

    const otherBranch = await dispatchAssemble(fixture, emptyAssembly(), {
      agent: { id: 'sess-1', branchId: 'br-2' }
    });
    expect(otherBranch.sections).toEqual([]);

    const otherSession = await dispatchAssemble(fixture, emptyAssembly(), {
      agent: { id: 'sess-2', branchId: 'br-2' }
    });
    expect(otherSession.sections).toEqual([]);
    expect(adapter.stats().assemble.applied).toBe(1);

    await adapter.dispose();
  });

  it('refuses an undeclared mount on an identity-free dispatch (P4-C tightened default)', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    // P4-C: a mount without mountScope is BRANCH-class, so an identity-free
    // host assembly can no longer see it (the pre-ADR fail-open is gone).
    await adapter.registerPromptSegment({ ...baseSpec, segment: 'global', mode: 'append', content: 'g' });

    const result = await dispatchAssemble(fixture, emptyAssembly(), {});
    expect(result.sections).toEqual([]);
    expect(adapter.stats().scope.assemble.anonymousSuppressed).toBe(1);

    // The old behaviour survives only as a counted, explicit opt-in.
    await adapter.registerPromptSegment({
      ...baseSpec,
      segment: 'legacy-global',
      mode: 'append',
      content: 'legacy',
      mountScope: 'legacy-host-local'
    });
    const legacy = await dispatchAssemble(fixture, emptyAssembly(), {});
    expect(legacy.sections.map((section) => section.name)).toEqual(['legacy-global']);
    expect(adapter.stats().scope.legacyHostLocalMounts).toBe(1);
    expect(adapter.advisories().join(' ')).toContain('explicitly opted into legacy host-local matching');
    await adapter.dispose();
  });

  it('reads identity from nested carriers and matches on namespace', () => {
    const identity = readHookScope({ agent: { id: 'sess-9', session: { id: 'sess-9' }, branchId: 'br-9' } });
    expect(identity.branchIds.has('br-9')).toBe(true);
    expect(identity.sessionIds.has('sess-9')).toBe(true);
    expect(
      hookScopeMatches(identity, { branchId: 'br-9', sessionId: 'other', namespace: 'x' })
    ).toBe(true);
    expect(
      hookScopeMatches({ branchIds: new Set(['nb']), sessionIds: new Set(), namespaces: new Set() }, {
        branchId: 'br-9',
        sessionId: 'sess-9',
        namespace: 'x'
      })
    ).toBe(false);
  });
});

describe('tool policy through tools/pre-execute and tools/post-execute', () => {
  it('denies a tool covered by a guardrails precondition and allows the rest', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    const disposer = await adapter.registerGuardrails({
      ...baseSpec,
      appendRules: ['always cite evidence'],
      forbiddenActions: ['tool:shell'],
      toolPreconditions: [{ toolName: 'write_file', rule: 'deny destructive writes' }]
    });

    const deniedWrite = await dispatchPreExecute(fixture, { name: 'write_file', branchId: 'br-1' });
    expect(deniedWrite).toMatchObject({ kind: 'deny' });
    expect(String(deniedWrite['reason'])).toContain('destructive writes');

    const deniedShell = await dispatchPreExecute(fixture, { name: 'shell', branchId: 'br-1' });
    expect(deniedShell).toMatchObject({ kind: 'deny' });

    const allowed = await dispatchPreExecute(fixture, { name: 'read_file', branchId: 'br-1' });
    expect(allowed).toEqual({ kind: 'allow' });

    // a non-`deny:` natural-language rule is advisory, never silently enforced
    expect(adapter.advisories().join(' ')).toContain('always cite evidence');
    expect(adapter.advisories().join(' ')).not.toContain('deny destructive writes');

    await disposer.dispose();
    const afterDispose = await dispatchPreExecute(fixture, { name: 'write_file', branchId: 'br-1' });
    expect(afterDispose).toEqual({ kind: 'allow' });
    await adapter.dispose();
  });

  it('never overrides a deny or cancel returned by a later listener', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    await adapter.registerGuardrails({
      ...baseSpec,
      appendRules: [],
      forbiddenActions: [],
      toolPreconditions: [{ toolName: 'shell', rule: 'deny anything' }]
    });

    const listener = fixture.listener('tools/pre-execute');
    const result = (await Promise.resolve(
      listener({ name: 'shell', branchId: 'br-1' }, () => Promise.resolve({ kind: 'deny', reason: 'native policy' }))
    )) as Record<string, unknown>;
    expect(result).toEqual({ kind: 'deny', reason: 'native policy' });
    await adapter.dispose();
  });

  it('scopes host-supplied deny rules and counts post-execute/pre-step observations', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      denyTools: [{ toolName: '*', reason: 'frozen rollout' }]
    });

    // host-supplied deny rules apply as soon as the plugin wires interception
    adapter.install();
    const denied = await dispatchPreExecute(fixture, { name: 'anything' });
    expect(denied).toEqual({ kind: 'deny', reason: 'frozen rollout' });

    // observation hooks only count inside a mounted branch scope
    const mount = await adapter.registerGuardrails({
      ...baseSpec,
      appendRules: [],
      forbiddenActions: [],
      toolPreconditions: []
    });

    const postListener = fixture.listener('tools/post-execute');
    await Promise.resolve(
      postListener({ name: 'shell', branchId: 'br-1' }, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
    );
    const stepListener = fixture.listener('agent/pre-step');
    await Promise.resolve(
      stepListener({ agent: { id: 'sess-1' }, messages: [] }, () =>
        Promise.resolve({ kind: 'enter', messages: [], startsRequestSeries: true })
      )
    );
    // P4-C: a session-only dispatch proves no branch, so a branch mount is
    // neither applied nor suppressed silently - it is counted as delegated.
    const sessionOnlyStep = await Promise.resolve(
      stepListener({ agent: { id: 'sess-1' }, messages: [] }, () =>
        Promise.resolve({ kind: 'enter', messages: [] })
      )
    );
    expect(sessionOnlyStep).toEqual({ kind: 'enter', messages: [] });

    const stats = adapter.stats();
    expect(stats.deniedToolCalls).toBe(1);
    expect(stats.postExecute.applied).toBe(1);
    expect(stats.preStep.applied).toBe(0);
    expect(stats.preStep.delegated).toBe(2);
    expect(stats.scope.preExecute.sessionOnlySuppressed).toBe(0);

    // an out-of-scope dispatch is delegated, never counted as applied
    await Promise.resolve(
      postListener({ name: 'shell', branchId: 'br-other' }, {}, () => Promise.resolve({ kind: 'accept' }))
    );
    expect(adapter.stats().postExecute.applied).toBe(1);
    expect(adapter.stats().postExecute.delegated).toBe(1);

    await mount.dispose();
    await adapter.dispose();
  });
});

describe('adapter integration with the plugin entrypoint', () => {
  it('prefers the real hook adapter and reports hostAdapterSource="dsh-hooks"', async () => {
    const fixture = createHookFixture();
    const diagnostics: string[] = [];
    const resolved = resolveHostAdapter(fixture.ctx, {}, diagnostics);
    expect(resolved.hostAdapterSource).toBe('dsh-hooks');
    expect(diagnostics.join(' ')).not.toContain('real DSH hook middleware is unavailable');

    const plugin = createEvoHarnessPlugin(
      { config: { logging: { level: 'silent' }, triggerMode: 'always' } },
      fixture.ctx
    );
    expect(plugin.hostAdapterSource).toBe('dsh-hooks');

    // apply() wires interception at load: the four hook listeners are live and
    // the auto_fallback events share the same host context
    expect(fixture.listenerNames()).toEqual(
      expect.arrayContaining([...DSH_HOOK_EVENT_NAMES])
    );

    await plugin.dispose();
    expect(fixture.listenerNames()).toEqual([]);
  });

  it('keeps an injected adapter ahead of the hook surface', () => {
    const fixture = createHookFixture();
    const injected = { registerPromptSegment: vi.fn() };
    const resolved = resolveHostAdapter(fixture.ctx, { host: injected }, []);
    expect(resolved.hostAdapterSource).toBe('injected');
    expect(resolved.hostAdapter).toBe(injected);
  });

  it('falls back to structural seams, then in-memory, with a diagnostic', () => {
    const structural = { prompt: { registerSegment: () => undefined }, on: () => undefined };
    const structuralDiagnostics: string[] = [];
    expect(resolveHostAdapter(structural, {}, structuralDiagnostics).hostAdapterSource).toBe('context');
    expect(structuralDiagnostics.join(' ')).toContain('real DSH hook middleware is unavailable');

    const bareDiagnostics: string[] = [];
    expect(resolveHostAdapter({}, {}, bareDiagnostics).hostAdapterSource).toBe('in-memory');
  });
});

function specFor(branchId: string): typeof baseSpec {
  return {
    surfaceId: 'harness2:probe_' + branchId + '#system_prompt',
    branchId,
    sessionId: 'sess-1',
    namespace: 'harness2:probe_' + branchId
  };
}

describe('advisor and scope boundary enforcement (Plan §4 R3 / §5.2)', () => {
  it('fails closed on advice injection when advisor has no scope, but never denies host execution', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'advisor want to ask' });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'gate',
      scopeRegistry: registry
      // no hostAdvisorScope, unregistered branch
    });
    adapter.install();

    // Host tool execution should pass through unhindered (returns { kind: 'allow' })
    const result = await dispatchPreExecute(fixture, {
      name: 'read_file',
      branchId: 'br-unknown',
      sessionId: 'sess-1'
    });
    expect(result).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(adapter.hostAdvisorStats().skipped).toBe(1);
    expect(adapter.stats().deniedToolCalls).toBe(0);

    // Host pre-step should also pass through without advice
    const stepResult = await dispatchPreStep(fixture, {
      agent: { id: 'sess-1', branchId: 'br-unknown' }
    });
    expect(stepResult).toEqual({ kind: 'enter', messages: [] });
    expect(stepResult['additionalContexts']).toBeUndefined();

    await adapter.dispose();
  });

  it('explicitly forbids advice for invariant branches in both advisory and gate modes', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'ask',
      reason: 'invariant branch must never trigger this'
    });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'gate',
      hostAdvisorScope: { branchId: 'inv-branch-1' },
      scopeRegistry: registry
    });
    adapter.install();

    registry.register({
      branchId: 'inv-branch-1',
      sessionId: 'sess-inv',
      role: 'invariant'
    });

    // 1) Gate mode with invariant branchId naming convention or registered invariant
    const gateResult = await dispatchPreExecute(fixture, {
      name: 'shell',
      branchId: 'inv-branch-1',
      sessionId: 'sess-inv'
    });
    expect(gateResult).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();

    // 2) Advisory mode with invariant branch
    const advisoryAdapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(
        vi.fn().mockResolvedValue({ kind: 'advisory', text: 'Forbidden advice' })
      ),
      hostAdvisorMode: 'advisory',
      scopeRegistry: registry
    });
    advisoryAdapter.install();

    const stepResult = await dispatchPreStep(fixture, {
      branchId: 'inv-branch-1',
      agent: { id: 'sess-inv' }
    });
    expect(stepResult).toEqual({ kind: 'enter', messages: [] });
    expect(stepResult['additionalContexts']).toBeUndefined();

    // 3) Payload with explicit isInvariant: true or role: 'invariant'
    const flaggedResult = await dispatchPreExecute(fixture, {
      name: 'python',
      branchId: 'br-other',
      sessionId: 'sess-other',
      isInvariant: true
    });
    expect(flaggedResult).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();

    await adapter.dispose();
    await advisoryAdapter.dispose();
  });

  it('fails closed on advice for anonymous dispatches without auto-denying host execution', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'gate should not run' });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'gate',
      hostAdvisorScope: { branchId: 'domain-br' }
    });
    adapter.install();

    // Anonymous dispatch: no branchId, no sessionId
    const result = await dispatchPreExecute(fixture, { name: 'bash' });
    expect(result).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(adapter.hostAdvisorStats().skipped).toBe(1);

    await adapter.dispose();
  });

  it('D1 strict default: anonymous {name:bash} default dispatch gets no advice and no ask while execution stays allow', async () => {
    // Advisory adapter with production-default wiring (no hostAdvisorScope).
    const advFixture = createHookFixture();
    const advEvaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'ANON_ADVICE_MARKER_MUST_NOT_APPEAR'
    });
    const advAdapter = createDshHookHostAdapter(advFixture.ctx, {
      hostAdvisor: createMockHostAdvisor(advEvaluate),
      hostAdvisorMode: 'advisory'
    });
    advAdapter.install();

    // Anonymous agent/pre-step: the advisor is never evaluated and no
    // additionalContexts (advisor marker) may appear.
    const step = await dispatchPreStep(advFixture, {});
    expect(advEvaluate).not.toHaveBeenCalled();
    expect(step['additionalContexts']).toBeUndefined();
    expect(advAdapter.hostAdvisorStats().scopeUnknownSkipped).toBe(1);

    // Gate adapter: an anonymous tool call triggers no extra ask either.
    const gateFixture = createHookFixture();
    const gateEvaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'gate must not run' });
    const gateAdapter = createDshHookHostAdapter(gateFixture.ctx, {
      hostAdvisor: createMockHostAdvisor(gateEvaluate),
      hostAdvisorMode: 'gate'
    });
    gateAdapter.install();

    const exec = await dispatchPreExecute(gateFixture, { name: 'bash' });
    expect(exec).toEqual({ kind: 'allow' });
    expect(gateEvaluate).not.toHaveBeenCalled();
    expect(gateAdapter.hostAdvisorStats().scopeUnknownSkipped).toBe(1);
    expect(gateAdapter.hostAdvisorStats().skipped).toBe(1);
    expect(gateAdapter.stats().deniedToolCalls).toBe(0);

    await advAdapter.dispose();
    await gateAdapter.dispose();
  });

  it('D1 row 5: a bare sessionId dispatch degrades to pass-through with no advice until trusted host-session registration exists', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'SESSION_ONLY_ADVICE_MUST_NOT_APPEAR'
    });
    const registry = createScopeRegistry(); // empty: nothing registered, no host-session registration path yet
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: createMockHostAdvisor(evaluate),
      hostAdvisorMode: 'advisory',
      scopeRegistry: registry
    });
    adapter.install();

    const step = await dispatchPreStep(fixture, { sessionId: 'sess-only' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(step['additionalContexts']).toBeUndefined();
    expect(adapter.hostAdvisorStats().scopeUnknownSkipped).toBe(1);
    expect(adapter.hostAdvisorStats().skipped).toBe(1);

    await adapter.dispose();
  });

  it('delivers advice and gate ask to authorized domain branches', async () => {
    const gateFixture = createHookFixture();
    const gateEvaluate = vi.fn().mockResolvedValue({
      kind: 'ask',
      reason: 'Destructive tool requires confirmation',
      suggestedActionKey: 'tool:read_delta'
    });
    const gateAdvisor = createMockHostAdvisor(gateEvaluate);
    const registry = createScopeRegistry();
    registry.register({
      branchId: 'domain-main',
      sessionId: 'sess-domain',
      role: 'domain'
    });

    const gateAdapter = createDshHookHostAdapter(gateFixture.ctx, {
      hostAdvisor: gateAdvisor,
      hostAdvisorMode: 'gate',
      scopeRegistry: registry
    });
    gateAdapter.install();

    const gateResult = await dispatchPreExecute(gateFixture, {
      name: 'rm_rf',
      branchId: 'domain-main',
      sessionId: 'sess-domain'
    });
    expect(gateResult).toEqual({
      kind: 'ask',
      reason: 'Destructive tool requires confirmation',
      suggestedActionKey: 'tool:read_delta'
    });
    expect(gateEvaluate).toHaveBeenCalledTimes(1);
    const firstCall = gateEvaluate.mock.calls[0];
    expect(firstCall).toBeDefined();
    const passedReq = firstCall![0];
    expect(passedReq.branchId).toBe('domain-main');
    expect(passedReq.sessionId).toBe('sess-domain');
    expect(passedReq.isInvariant).toBe(false);

    await gateAdapter.dispose();

    // Advisory mode delivers rendered advice to additionalContexts
    const advFixture = createHookFixture();
    const advisoryEvaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'Consider using tool:check_preconditions first'
    });
    const advAdapter = createDshHookHostAdapter(advFixture.ctx, {
      hostAdvisor: createMockHostAdvisor(advisoryEvaluate),
      hostAdvisorMode: 'advisory',
      scopeRegistry: registry
    });
    advAdapter.install();

    const advResult = await dispatchPreStep(advFixture, {
      branchId: 'domain-main',
      agent: { id: 'sess-domain' }
    });
    expect(advResult['additionalContexts']).toEqual(['Consider using tool:check_preconditions first']);

    await advAdapter.dispose();
  });

  it('ensures host deny rules take precedence over advisor and advisor cannot override deny', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'ask',
      reason: 'Advisor asks user for permission'
    });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();
    registry.register({
      branchId: 'domain-main',
      sessionId: 'sess-domain',
      role: 'domain'
    });

    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'gate',
      scopeRegistry: registry,
      denyTools: [{ toolName: 'forbidden_tool', reason: 'Strict security deny policy' }]
    });
    adapter.install();

    // When host deny rule matches, it immediately denies without advisor evaluation
    const result = await dispatchPreExecute(fixture, {
      name: 'forbidden_tool',
      branchId: 'domain-main',
      sessionId: 'sess-domain'
    });
    expect(result).toEqual({ kind: 'deny', reason: 'Strict security deny policy' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(adapter.stats().deniedToolCalls).toBe(1);

    // Next listener in the waterfall returns deny: adapter must not override it
    const listener = fixture.listener('tools/pre-execute');
    const downstreamDeny = (await Promise.resolve(
      listener({ name: 'other_tool', branchId: 'domain-main', sessionId: 'sess-domain' }, () =>
        Promise.resolve({ kind: 'deny', reason: 'downstream host policy' })
      )
    )) as Record<string, unknown>;
    expect(downstreamDeny).toEqual({ kind: 'deny', reason: 'downstream host policy' });
    expect(evaluate).not.toHaveBeenCalled();

    await adapter.dispose();
  });

  it('rejects untrusted payload self-proclaiming domain role without prior registration', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({ kind: 'ask', reason: 'should not run' });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();

    // Notice: branch "rogue-br" is NEVER registered in registry!
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'gate',
      scopeRegistry: registry
      // unscoped advisor: relies on ScopeRegistry
    });
    adapter.install();

    // Rogue payload self-claims domain role and allowAdvice: true
    const roguePayload = {
      name: 'write_file',
      branchId: 'rogue-br',
      sessionId: 'sess-rogue',
      role: 'domain',
      allowAdvice: true
    };
    expect(registry.resolve(roguePayload)).toBe('unknown');

    const result = await dispatchPreExecute(fixture, roguePayload);
    // Passes through host without advice or deny
    expect(result).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(adapter.hostAdvisorStats().skipped).toBe(1);

    await adapter.dispose();
  });
  it('fails closed on advice injection for unproven branch without registry injection (F1/F2/F7/F10)', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'EXTERNAL_MEMORY_ADVICE_SHOULD_NOT_REACH_INVARIANT'
    });
    const mockAdvisor = createMockHostAdvisor(evaluate);

    const records: unknown[] = [];
    const mockSink = {
      observeToolCall: vi.fn(async (obs) => { records.push(obs); }),
      observeTurnEnd: vi.fn(async () => {})
    };

    // Notice: NO scopeRegistry passed, NO hostAdvisorScope passed (production default)
    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'advisory',
      hostToolExperience: mockSink
    });
    adapter.install();

    // 1) agent/pre-step on neutral-named unproven branch sess-a1::tree-1::r1-s1 (no 'inv', slot s1)
    const stepResult = await dispatchPreStep(fixture, {
      branchId: 'sess-a1::tree-1::r1-s1',
      sessionId: 'sess-a1'
    });
    // Must NOT evaluate advisor, must NOT inject additionalContexts
    expect(evaluate).not.toHaveBeenCalled();
    expect(stepResult['additionalContexts']).toBeUndefined();
    expect(adapter.hostAdvisorStats().skipped).toBe(1);

    // 2) tools/pre-execute on unproven branch
    const preResult = await dispatchPreExecute(fixture, {
      name: 'probe_tool',
      branchId: 'sess-a1::tree-1::r1-s1',
      sessionId: 'sess-a1'
    });
    // Host pass-through: allows without auto-deny, advisor not evaluated
    expect(preResult).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();

    // 3) Anonymous dispatch: fail-closed (D1 strict default / F9)
    const anonResult = await dispatchPreStep(fixture, {});
    expect(evaluate).not.toHaveBeenCalled();
    expect(anonResult['additionalContexts']).toBeUndefined();

    // 4) Clean dispose
    await adapter.dispose();
  });

  it('D1: anonymous tool observations reach no learning track while the adapter stays transparent', async () => {
    const fixture = createHookFixture();
    const records: unknown[] = [];
    const mockSink = {
      observeToolCall: vi.fn(async (obs: unknown) => {
        records.push(obs);
      }),
      observeTurnEnd: vi.fn(async () => {})
    };

    // Production default wiring: no scopeRegistry option, no hostAdvisorScope.
    const adapter = createDshHookHostAdapter(fixture.ctx, { hostToolExperience: mockSink });
    adapter.install();

    // Anonymous tool execution: host decision stays untouched (allow) and the
    // observation is still forwarded (transparency), but the D1 collector
    // contract keeps it out of every learnable track.
    const result = await dispatchPreExecute(fixture, { name: 'bash' });
    expect(result).toEqual({ kind: 'allow' });

    const postListener = fixture.listener('tools/post-execute');
    await Promise.resolve(
      postListener({ name: 'bash' }, { isError: false, exitCode: 0 }, () =>
        Promise.resolve({ kind: 'accept' })
      )
    );
    expect(mockSink.observeToolCall).toHaveBeenCalledTimes(1);
    const observation = records[0] as Record<string, unknown>;
    expect(observation['toolName']).toBe('bash');
    // No identity fields may be invented for an anonymous dispatch.
    expect(observation['sessionId']).toBeUndefined();
    expect(observation['branchId']).toBeUndefined();

    await adapter.dispose();
  });

  it('provenance plumbing enforces invariant isolation for neutral-named slot (F3-PLUMB / Acceptance 1 & 2)', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'ADVICE_MUST_BE_BLOCKED_BY_PROVENANCE'
    });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();

    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'advisory',
      scopeRegistry: registry
    });
    adapter.install();

    // Neutral branch name: sess-a1::tree-1::r1-s1 (no 'inv' in session, slot s1)
    const neutralBranch = 'sess-a1::tree-1::r1-s1';
    const neutralSession = 'sess-a1';

    // Mount surface with invariant provenance (origin: explore_invariant, guidance: guidance_free)
    const unmount = await adapter.registerPromptSegment({
      surfaceId: 'surface-inv',
      branchId: neutralBranch,
      sessionId: neutralSession,
      namespace: 'ns-inv',
      segment: 'evo-harness-prompt',
      mode: 'append',
      content: 'invariant prompt segment',
      origin: 'explore_invariant',
      guidance: 'guidance_free',
      role: 'invariant',
      allowAdvice: false
    } as any);

    // Provenance registration verified in scopeRegistry
    const registered = registry.get(neutralBranch);
    expect(registered).toBeDefined();
    expect(registered?.isInvariant).toBe(true);
    expect(registered?.allowAdvice).toBe(false);
    expect(registered?.guidance).toBe('guidance_free');

    // Pre-step on invariant slot: advice strictly prohibited!
    const stepResult = await dispatchPreStep(fixture, {
      branchId: neutralBranch,
      sessionId: neutralSession
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(stepResult['additionalContexts']).toBeUndefined();

    // Pre-execute on invariant slot: pass-through without advisor evaluation
    const preResult = await dispatchPreExecute(fixture, {
      name: 'probe_tool',
      branchId: neutralBranch,
      sessionId: neutralSession
    });
    expect(preResult).toEqual({ kind: 'allow' });
    expect(evaluate).not.toHaveBeenCalled();

    await unmount.dispose();
    await adapter.dispose();
  });

  it('counterfactual on identical branchId: provenance directly drives advisor advice outcome (F3/F10)', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'DOMAIN_ADVICE_PAYLOAD'
    });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();

    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'advisory',
      scopeRegistry: registry
    });
    adapter.install();

    // Exact same branchId: sess-a1::tree-1::r1-s1
    const testBranch = 'sess-a1::tree-1::r1-s1';
    const testSession = 'sess-a1';

    // Phase A: Mount with domain provenance -> Advisor MUST evaluate and inject advice
    const domainUnmount = await adapter.registerPromptSegment({
      surfaceId: 'surface-dom',
      branchId: testBranch,
      sessionId: testSession,
      namespace: 'ns-dom',
      segment: 'evo-harness-prompt',
      mode: 'append',
      content: 'domain prompt',
      origin: 'explore_domain',
      guidance: 'memory',
      role: 'domain',
      allowAdvice: true
    } as any);

    const stepA = await dispatchPreStep(fixture, {
      branchId: testBranch,
      sessionId: testSession
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(stepA['additionalContexts']).toEqual(['DOMAIN_ADVICE_PAYLOAD']);
    expect(adapter.hostAdvisorStats().advisory).toBe(1);
    await domainUnmount.dispose();

    // Phase B: Mount the EXACT SAME branchId with invariant provenance -> Advisor MUST NOT evaluate
    evaluate.mockClear();
    const invUnmount = await adapter.registerPromptSegment({
      surfaceId: 'surface-inv',
      branchId: testBranch,
      sessionId: testSession,
      namespace: 'ns-inv',
      segment: 'evo-harness-prompt',
      mode: 'append',
      content: 'invariant prompt',
      origin: 'explore_invariant',
      guidance: 'guidance_free',
      role: 'invariant',
      allowAdvice: false
    } as any);

    const stepB = await dispatchPreStep(fixture, {
      branchId: testBranch,
      sessionId: testSession
    });
    // Advisor must NOT be called for invariant branch!
    expect(evaluate).not.toHaveBeenCalled();
    expect(stepB['additionalContexts']).toBeUndefined();

    await invUnmount.dispose();
    await adapter.dispose();
  });

  it('proves slot -s2 domain branch is NOT falsely isolated and receives advice (Acceptance 1 / F3-RESIDUAL)', async () => {
    const fixture = createHookFixture();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'advisory',
      text: 'S2_DOMAIN_BRANCH_ADVICE'
    });
    const mockAdvisor = createMockHostAdvisor(evaluate);
    const registry = createScopeRegistry();

    const adapter = createDshHookHostAdapter(fixture.ctx, {
      hostAdvisor: mockAdvisor,
      hostAdvisorMode: 'advisory',
      scopeRegistry: registry
    });
    adapter.install();

    // Slot -s2 domain branch: sess-a1::tree-1::r0-s2
    const s2Branch = 'sess-a1::tree-1::r0-s2';
    const s2Session = 'sess-a1';

    const unmount = await adapter.registerPromptSegment({
      surfaceId: 'surface-s2',
      branchId: s2Branch,
      sessionId: s2Session,
      namespace: 'ns-s2',
      segment: 'evo-harness-prompt',
      mode: 'append',
      content: 's2 domain prompt',
      origin: 'explore_domain',
      guidance: 'memory',
      role: 'domain',
      allowAdvice: true
    } as any);

    const reg = registry.get(s2Branch);
    expect(reg?.isInvariant).toBe(false);
    expect(reg?.allowAdvice).toBe(true);

    const step = await dispatchPreStep(fixture, {
      branchId: s2Branch,
      sessionId: s2Session
    });
    // Slot -s2 domain branch receives advice and is NOT falsely isolated!
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(step['additionalContexts']).toEqual(['S2_DOMAIN_BRANCH_ADVICE']);

    await unmount.dispose();
    await adapter.dispose();
  });
});


/** Kept for the typed event-name contract used by the fixture assertions. */
export type { DshHookEventName };
