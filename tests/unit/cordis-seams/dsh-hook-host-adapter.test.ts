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
      priority: 5
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
      content: 'You are an evolved harness.'
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
      content: 'evo guidance'
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
    await adapter.registerPromptSegment({ ...baseSpec, segment: 'evo', mode: 'append', content: 'evo text' });

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

  it('treats an identity-free host-local assembly as in scope, documented fail-open', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx);
    await adapter.registerPromptSegment({ ...baseSpec, segment: 'global', mode: 'append', content: 'g' });

    const result = await dispatchAssemble(fixture, emptyAssembly(), {});
    expect(result.sections.map((section) => section.name)).toEqual(['global']);
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

    const stats = adapter.stats();
    expect(stats.deniedToolCalls).toBe(1);
    expect(stats.postExecute.applied).toBe(1);
    expect(stats.preStep.applied).toBe(1);

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

/** Kept for the typed event-name contract used by the fixture assertions. */
export type { DshHookEventName };
