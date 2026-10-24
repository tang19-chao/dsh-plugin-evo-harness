/**
 * Host-smoke harness contract tests (P6.1-F).
 *
 * Why these exist: the harness produces the report that gates Gate 4 claims, so
 * the harness's own honesty rules must be enforced by CI, not by reviewer
 * attention. Three things are asserted here:
 *
 *   1. The HostCapabilityManifest cannot be built incompletely — a missing group
 *      or a missing hook event fails validation, and a `passed` Gate 4 with a
 *      non-empty blockedBy is rejected.
 *   1b. Manifest identity is built from HOST-REAL evidence only: a
 *      contract-shaped dispatch (one the harness decorates with a branchId) can
 *      never become the "representative" capture, because that would report a
 *      host capability the host does not have.
 *   2. The sanitized-sample format cannot carry a payload-echo field, and the
 *      five-state report keeps `failed`/`not-run` rows with their reasons.
 *   3. The naming scheme cannot address a business namespace, and the
 *      degradation matrix (event shape off-contract -> D1 passthrough) really
 *      runs: the adapter returns the host decision, consults no advisor, and
 *      learns nothing.
 *
 * Nothing here needs an installed DSH host: the degradation matrix drives the
 * adapter through a structural waterfall, and the manifest/report cases are pure
 * data. The real-host run is `scripts/host-smoke/run.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { createHostToolExperienceCollector } from '../../../src/jitrl/host-tool-experience';
import { createScopeRegistry } from '../../../src/jitrl/scope-registry';
import { createDshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import { parseEvoHarnessConfig } from '../../../src/config';
import {
  MANIFEST_DURABLE_EVENTS,
  MANIFEST_HOOK_EVENTS,
  summarizeManifest,
  validateManifest
} from './manifest';
import type { HostCapabilityManifest } from './manifest';
import { assembleAndValidate, carrierOnlyIdentityEvents } from './assemble';
import type { HostProbeReport } from './probe';
import {
  FORBIDDEN_SAMPLE_KEYS,
  SMOKE_PREFIX,
  boundDetail,
  makeSample,
  normalizeTag,
  smokeNaming,
  validateNaming,
  validateSample
} from './samples';
import { REPORT_LAYERS, renderReport, summarizeLayer, validateRows } from './report-template';
import type { ScenarioRow } from './report-template';
import { runDegradationMatrix } from './degradation';

/** A complete, valid manifest used as the mutation baseline. */
function validManifest(): HostCapabilityManifest {
  return {
    schemaVersion: 1,
    capturedAt: '2026-10-25T00:00:00.000Z',
    host: {
      product: 'DeepSeek Harness',
      version: '0.2.1-rc.2',
      installDir: 'C:/installed/dsh',
      executable: 'C:/installed/dsh/DeepSeek Harness.exe',
      asarPath: 'C:/installed/dsh/resources/app.asar',
      cordisVersion: '4.0.5',
      runtime: {
        node: '24.21.0',
        electron: '44.7.0',
        v8: '15.2.0',
        platform: 'win32',
        arch: 'x64'
      }
    },
    plugin: {
      name: 'dsh-plugin-evo-harness',
      version: '0.1.0',
      commit: '7bce33ee9d102a6a05a35f080f606a8fd388e114',
      worktreeDirty: false,
      bundleEntry: 'tests/e2e/host-smoke/bundle-entry.ts'
    },
    hooks: MANIFEST_HOOK_EVENTS.map((event) => ({
      event,
      support: 'installed',
      disposer: 'function',
      dispatched: true,
      payloadFields: ['agent', 'name']
    })),
    durableEvents: MANIFEST_DURABLE_EVENTS.map((event) => ({
      event,
      listenerInstalled: true,
      dispatchKind: 'session-append',
      terminatingDisposal: 'function'
    })),
    identity: {
      perHook: MANIFEST_HOOK_EVENTS.map((event) => ({
        event,
        branchId: 'none',
        sessionId: 'payload',
        namespace: 'none',
        fields: ['agent', 'id'],
        plainSessionIdOnly: true
      })),
      anyPlainSessionIdOnly: true
    },
    permissions: {
      order: ['host-deny', 'host-cancel', 'jit-ask', 'jit-deny'],
      hostDecisionAuthoritative: true,
      jitCanDeny: false,
      jitCanAsk: true,
      mountDenyAfterHost: true,
      evidence: ['live probe']
    },
    surfaces: {
      waterfall: true,
      off: false,
      fork: false,
      promptSections: true,
      toolDecisionPipeline: true,
      agentCarrierOnToolDispatch: true
    },
    gate4: { status: 'not-passed', blockedBy: ['real model call not authorized'] }
  };
}

describe('HostCapabilityManifest: completeness is enforced, not assumed', () => {
  it('accepts a complete manifest', () => {
    expect(validateManifest(validManifest())).toEqual([]);
  });

  it('rejects a manifest missing the host version facts', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const host = { ...(manifest['host'] as Record<string, unknown>) };
    delete host['version'];
    manifest['host'] = host;
    expect(validateManifest(manifest).join('; ')).toContain('host.version');
  });

  it('rejects a manifest missing the runtime (Node) version facts', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const host = { ...(manifest['host'] as Record<string, unknown>) };
    const runtime = { ...(host['runtime'] as Record<string, unknown>) };
    delete runtime['node'];
    host['runtime'] = runtime;
    manifest['host'] = host;
    expect(validateManifest(manifest).join('; ')).toContain('host.runtime.node');
  });

  it('rejects a manifest missing the plugin commit (the report must pin a revision)', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const plugin = { ...(manifest['plugin'] as Record<string, unknown>) };
    delete plugin['commit'];
    manifest['plugin'] = plugin;
    expect(validateManifest(manifest).join('; ')).toContain('plugin.commit');
  });

  it('rejects a manifest that omits one hook event', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    manifest['hooks'] = (manifest['hooks'] as readonly unknown[]).slice(0, -1);
    const problems = validateManifest(manifest).join('; ');
    expect(problems).toContain('hooks is missing event agent/pre-step');
  });

  it('rejects a manifest that omits identity availability for one hook', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const identity = { ...(manifest['identity'] as Record<string, unknown>) };
    identity['perHook'] = (identity['perHook'] as readonly unknown[]).slice(0, -1);
    manifest['identity'] = identity;
    expect(validateManifest(manifest).join('; ')).toContain('identity.perHook is missing event');
  });

  it('rejects an identity carrier vocabulary violation', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const identity = { ...(manifest['identity'] as Record<string, unknown>) };
    const perHook = [...(identity['perHook'] as readonly Record<string, unknown>[])];
    perHook[0] = { ...perHook[0], branchId: 'assumed' };
    identity['perHook'] = perHook;
    manifest['identity'] = identity;
    expect(validateManifest(manifest).join('; ')).toContain('branchId must be one of');
  });

  it('rejects a permission precedence that lets Jit ask outrank the host', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const permissions = { ...(manifest['permissions'] as Record<string, unknown>) };
    permissions['order'] = ['jit-ask', 'host-deny', 'host-cancel', 'jit-deny'];
    manifest['permissions'] = permissions;
    expect(validateManifest(manifest).join('; ')).toContain('puts jit-ask above a host deny/cancel');
  });

  it('rejects jitCanDeny=true: Jit may ask, never deny', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    const permissions = { ...(manifest['permissions'] as Record<string, unknown>) };
    permissions['jitCanDeny'] = true;
    manifest['permissions'] = permissions;
    expect(validateManifest(manifest).join('; ')).toContain('jitCanDeny must be false');
  });

  it('rejects gate4=passed while blockedBy is non-empty', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    manifest['gate4'] = { status: 'passed', blockedBy: ['still open'] };
    expect(validateManifest(manifest).join('; ')).toContain('gate4.status=passed contradicts');
  });

  it('rejects a durable event described as a hook dispatch', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    manifest['durableEvents'] = [
      { event: 'turn/end', listenerInstalled: true, dispatchKind: 'waterfall', terminatingDisposal: 'function' }
    ];
    expect(validateManifest(manifest).join('; ')).toContain('dispatchKind must be session-append');
  });

  it('summarizes a manifest without leaking payloads', () => {
    const lines = summarizeManifest(validManifest());
    expect(lines.join('\n')).toContain('permission precedence: host-deny > host-cancel > jit-ask > jit-deny');
    expect(lines.join('\n')).toContain('gate4: not-passed');
    expect(lines.join('\n')).toContain('durable turn/end: listenerInstalled=true dispatch=session-append');
  });
});

describe('manifest assembly: identity comes from host-real evidence only', () => {
  const hostFacts = validManifest().host;
  const pluginFacts = validManifest().plugin;

  /** A probe report whose host-real captures carry sessionId only. */
  function hostRealProbe(overrides: Partial<HostProbeReport> = {}): HostProbeReport {
    return {
      hooks: MANIFEST_HOOK_EVENTS.map((event) => ({
        event,
        dispatched: true,
        payloadFields: ['agent', 'name'],
        carrierIdPresent: event === 'agent/pre-step',
        branchIds: 0,
        // agent/pre-step carries no payload identity at all on this host.
        sessionIds: event === 'agent/pre-step' ? 0 : 1,
        namespaces: 0,
        identityFields: event === 'agent/pre-step' ? [] : ['agent', 'id', 'session']
      })),
      // The harness ALSO dispatched contract-shaped payloads (with a branchId).
      // These must never reach the manifest.
      contractShapedHooks: MANIFEST_HOOK_EVENTS.map((event) => ({
        event,
        dispatched: true,
        payloadFields: ['agent', 'branchId', 'name', 'sessionId'],
        carrierIdPresent: false,
        branchIds: 1,
        sessionIds: 1,
        namespaces: 0,
        identityFields: ['agent', 'branchId', 'id', 'sessionId']
      })),
      installedHookEvents: [...MANIFEST_HOOK_EVENTS],
      durableEvent: { listenerInstalled: true, disposerKind: 'function', throwsWithoutSink: false },
      disposer: { kind: 'function', unregistersOnCall: true, callReturned: 'undefined' },
      detection: { detected: true, signals: ['ctx.on', 'ctx.tools'] },
      surfaces: {
        waterfall: true,
        off: false,
        fork: false,
        promptSections: true,
        toolDecisionPipeline: true
      },
      identityEvidence: [],
      scenarios: [],
      advisoryPath: {
        dispatched: true,
        advisorCalls: 0,
        adviceInjected: false,
        decisionKind: 'enter',
        scopeUnknownSkipped: 1,
        payloadFields: ['messages', 'signal', 'step', 'turn']
      },
      advisoryPathContractShaped: { advisorCalls: 1, adviceInjected: true, decisionKind: 'enter' },
      gatePath: {
        anonymousAskCount: 0,
        anonymousScopeUnknownSkipped: 1,
        anonymousToolExecuted: true,
        anonymousDecision: 'no-ask'
      },
      permissions: {
        hostDenyPreserved: true,
        hostCancelPreserved: true,
        anonymousPassThrough: true,
        advisorNeverDenied: true
      },
      runtimeControl: {
        offStopsAdvice: true,
        offStopsCollection: true,
        onRestoresAdvice: true,
        generationMoved: true,
        sevenSurfacesOff: true
      },
      lifecycle: {
        abortSettled: true,
        abortElapsedMs: 100,
        denyListenerDisposed: true,
        listenersAfterDispose: 0,
        observationsDeltaAfterDispose: 0,
        mountsAfterDispose: 0
      },
      notes: [],
      ...overrides
    };
  }

  const baseAssembly = {
    capturedAt: '2026-10-25T00:00:00.000Z',
    host: hostFacts,
    plugin: pluginFacts,
    gate: { anonymousAskCount: 0, anonymousScopeUnknownSkipped: 1, anonymousToolExecuted: true },
    gate4BlockedBy: ['real model call not authorized'],
    permissionEvidence: ['probe ran']
  };

  it('reports branchId=none when the host supplies none, even though a contract-shaped dispatch carried one', () => {
    const { manifest, problems } = assembleAndValidate({ ...baseAssembly, probe: hostRealProbe() });
    expect(problems).toEqual([]);
    // The decisive assertion: no manifest entry may claim a payload branchId.
    for (const entry of manifest.identity.perHook) {
      expect(entry.branchId, entry.event + ' claims a host branchId').toBe('none');
    }
    expect(manifest.identity.anyPlainSessionIdOnly).toBe(true);
  });

  it('records agent/pre-step identity as carrier-this, not as a payload session', () => {
    const { manifest } = assembleAndValidate({ ...baseAssembly, probe: hostRealProbe() });
    const preStep = manifest.identity.perHook.find((entry) => entry.event === 'agent/pre-step');
    expect(preStep?.sessionId).toBe('carrier-this');
    expect(preStep?.plainSessionIdOnly).toBe(false);
    expect(carrierOnlyIdentityEvents(manifest)).toEqual(['agent/pre-step']);
  });

  it('excludes contract-shaped hooks from the hook capability records', () => {
    const { manifest } = assembleAndValidate({ ...baseAssembly, probe: hostRealProbe() });
    for (const hook of manifest.hooks) {
      expect(hook.payloadFields).not.toContain('branchId');
    }
  });

  it('ignores contract-shaped captures entirely when only they exist', () => {
    const probe = hostRealProbe({
      hooks: MANIFEST_HOOK_EVENTS.map((event) => ({
        event,
        dispatched: false,
        payloadFields: [],
        carrierIdPresent: false,
        branchIds: 0,
        sessionIds: 0,
        namespaces: 0,
        identityFields: []
      }))
    });
    const { manifest } = assembleAndValidate({ ...baseAssembly, probe });
    expect(manifest.identity.anyPlainSessionIdOnly).toBe(false);
    for (const entry of manifest.identity.perHook) {
      expect(entry.fields).toEqual([]);
      expect(entry.branchId).toBe('none');
      expect(entry.sessionId).toBe('none');
    }
  });

  it('stays deny-by-default when no probe ran at all', () => {
    const { manifest, problems } = assembleAndValidate({ ...baseAssembly, probe: null, gate: null });
    expect(problems).toEqual([]);
    for (const hook of manifest.hooks) {
      expect(hook.support).toBe('not-probed');
      expect(hook.dispatched).toBe(false);
    }
    expect(manifest.surfaces.waterfall).toBe(false);
    expect(manifest.surfaces.promptSections).toBe(false);
    expect(manifest.durableEvents[0]?.listenerInstalled).toBe(false);
    expect(manifest.gate4.status).toBe('not-passed');
  });

  it('never reports Gate 4 passed, and always records at least one blocker', () => {
    const { manifest } = assembleAndValidate({ ...baseAssembly, probe: hostRealProbe(), gate4BlockedBy: [] });
    expect(manifest.gate4.status).toBe('not-passed');
    expect(manifest.gate4.blockedBy.length).toBeGreaterThan(0);
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('keeps the permission chain in host-first order', () => {
    const { manifest } = assembleAndValidate({ ...baseAssembly, probe: hostRealProbe() });
    expect(manifest.permissions.order).toEqual(['host-deny', 'host-cancel', 'jit-ask', 'jit-deny']);
    expect(manifest.permissions.jitCanDeny).toBe(false);
    expect(manifest.permissions.jitCanAsk).toBe(true);
    expect(manifest.permissions.evidence).toEqual(['probe ran']);
  });
});

describe('sanitized event samples: the format cannot echo a payload', () => {
  const naming = smokeNaming('20261025T000000Z');
  const baseSample = {
    id: 'tools/pre-execute#1',
    surface: 'tools/pre-execute' as const,
    scenario: '9.2-5',
    sessionTag: naming.sessionTags[0] ?? '',
    branchTag: (naming.branchTags[naming.sessionTags[0] ?? ''] ?? [''])[0] ?? '',
    namespaceTag: naming.namespaces.primary,
    identityFields: ['agent', 'id'],
    toolName: 'hostsmoke_echo',
    counters: { scopeUnknownSkipped: 1, advisory: 0 },
    decision: 'allow',
    outcome: 'passed' as const,
    detail: 'anonymous dispatch passed through; no advice, no record'
  };

  it('accepts a well-formed sample', () => {
    expect(validateSample(makeSample(baseSample))).toEqual([]);
  });

  it('rejects every payload-echo key the format forbids', () => {
    for (const key of FORBIDDEN_SAMPLE_KEYS) {
      const problem = validateSample({ ...makeSample(baseSample), [key]: 'leaked-body' });
      expect(problem.join('; ')).toContain('sample carries forbidden payload field "' + key + '"');
    }
  });

  it('bounds the free-text field so a sample cannot smuggle a long body', () => {
    const long = 'x'.repeat(5_000);
    const bounded = boundDetail(long);
    expect(bounded.length).toBeLessThanOrEqual(240);
    expect(bounded.endsWith('…')).toBe(true);
    const sample = makeSample({ ...baseSample, detail: long });
    expect(validateSample(sample)).toEqual([]);
  });

  it('normalizes a hostile tag into an identifier shape', () => {
    // `/`, spaces and `..` collapse: the tag must stay identifier-shaped so a
    // hostile name cannot become a path segment or a namespace.
    expect(normalizeTag('evil/../tenant secret')).toBe('evil-..-tenant-secret');
    expect(normalizeTag('a b')).toBe('a-b');
    expect(normalizeTag('///')).toBe('untagged');
    expect(normalizeTag('')).toBe('untagged');
    const sample = makeSample({ ...baseSample, sessionTag: 'has space and/slash', branchTag: 'b', namespaceTag: 'n' });
    expect(validateSample(sample)).toEqual([]);
  });

  it('rejects an unknown surface and an unknown outcome', () => {
    const sample = { ...makeSample(baseSample), surface: 'made-up', outcome: 'green' };
    const problems = validateSample(sample).join('; ');
    expect(problems).toContain('sample.surface must be one of');
    expect(problems).toContain('sample.outcome must be passed/failed/not-run');
  });

  it('rejects non-finite counters', () => {
    const sample = { ...makeSample(baseSample), counters: { advisory: Number.NaN } };
    expect(validateSample(sample).join('; ')).toContain('must be a finite number');
  });
});

describe('smoke naming: test identifiers only, business namespace never addressed', () => {
  it('derives two sessions with two sibling branches each', () => {
    const naming = smokeNaming('run42');
    expect(naming.sessionTags).toHaveLength(2);
    for (const session of naming.sessionTags) {
      const branches = naming.branchTags[session] ?? [];
      expect(branches).toHaveLength(2);
      expect(branches[0]).not.toBe(branches[1]);
      for (const branch of branches) {
        expect(branch.startsWith(session + '-')).toBe(true);
      }
    }
    expect(validateNaming(naming)).toEqual([]);
  });

  it('every generated identifier carries the test prefix', () => {
    const naming = smokeNaming('run42');
    for (const session of naming.sessionTags) {
      expect(session.startsWith(SMOKE_PREFIX + '-')).toBe(true);
    }
    expect(naming.namespaces.primary.startsWith(SMOKE_PREFIX + '/')).toBe(true);
    expect(naming.namespaces.secondary.startsWith(SMOKE_PREFIX + '/')).toBe(true);
  });

  it('rejects a naming scheme that points a test namespace at a business one', () => {
    const naming = smokeNaming('run42');
    const hostile = {
      ...naming,
      namespaces: { ...naming.namespaces, primary: 'harness2/jitrl' }
    };
    expect(validateNaming(hostile).join('; ')).toContain('does not carry the hostsmoke test prefix');
  });

  it('rejects a single-branch session (sibling isolation needs two)', () => {
    const naming = smokeNaming('run42');
    const session = naming.sessionTags[0] ?? '';
    const hostile = {
      ...naming,
      branchTags: { ...naming.branchTags, [session]: [session + '-bA'] }
    };
    expect(validateNaming(hostile).join('; ')).toContain('at least two sibling branch tags');
  });

  it('rejects primary and secondary being the same namespace', () => {
    const naming = smokeNaming('run42');
    const hostile = { ...naming, namespaces: { ...naming.namespaces, secondary: naming.namespaces.primary } };
    expect(validateNaming(hostile).join('; ')).toContain('must differ');
  });
});

describe('report template: five states, no green wash', () => {
  const baseRow = (overrides: Partial<ScenarioRow> = {}): ScenarioRow => ({
    id: '9.2-1',
    layer: 'security-contract',
    expected: 'a trusted domain branch is learnable',
    observed: 'records=1',
    state: 'passed',
    note: '',
    authorization: 'not-required',
    evidence: ['in-host probe'],
    ...overrides
  });

  it('renders every layer section, including one with no rows', () => {
    const markdown = renderReport(
      {
        schemaVersion: 1,
        commit: '7bce33ee9d102a6a05a35f080f606a8fd388e114',
        worktreeDirty: true,
        pluginVersion: '0.1.0',
        host: ['DeepSeek Harness 0.2.1-rc.2'],
        commands: ['pnpm run typecheck'],
        capturedAt: '2026-10-25T00:00:00.000Z'
      },
      [baseRow()]
    );
    const own = ['工程可运行', '安全契约', '学习语义', '真实宿主兼容', '任务收益'].filter(
      (title) => !markdown.includes(title)
    );
    expect(own).toEqual([]);
    expect(markdown).toContain('本层没有条目：这是缺口，不是通过。');
  });

  it('keeps failed and not-run rows with their reasons', () => {
    const markdown = renderReport(
      {
        schemaVersion: 1,
        commit: 'x',
        worktreeDirty: false,
        pluginVersion: '0.1.0',
        host: [],
        commands: [],
        capturedAt: '2026-10-25T00:00:00.000Z'
      },
      [
        baseRow({ id: 'a', state: 'failed', note: 'host deny overridden', evidence: [] }),
        baseRow({ id: 'b', state: 'not-run', note: 'no authorization', authorization: 'absent', evidence: [] })
      ]
    );
    expect(markdown).toContain('**failed**：host deny overridden');
    expect(markdown).toContain('**not-run**：no authorization');
  });

  it('never reports a layer complete when it has failures or skips', () => {
    const rows = [
      baseRow({ id: 'a' }),
      baseRow({ id: 'b', state: 'failed', note: 'broke', layer: 'security-contract' }),
      baseRow({ id: 'c', state: 'not-run', note: 'skipped', layer: 'security-contract' })
    ];
    const summary = summarizeLayer('security-contract', rows);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.notRun).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summarizeLayer('learning-semantics', rows).complete).toBe(false);
  });

  it('rejects a row set that hides a failure or skips its reason', () => {
    expect(validateRows([]).join('; ')).toContain('no scenario rows');
    expect(validateRows([baseRow({ state: 'failed', note: '' })]).join('; ')).toContain('carries no reason');
    expect(validateRows([baseRow({ state: 'not-run', note: ' ' })]).join('; ')).toContain('carries no reason');
    expect(validateRows([baseRow({ evidence: [] })]).join('; ')).toContain('claims passed with no evidence');
    expect(validateRows([baseRow(), baseRow()]).join('; ')).toContain('duplicate row id');
  });

  it('rejects a task-benefit pass claimed without authorization', () => {
    const problems = validateRows([baseRow({ layer: 'task-benefit', authorization: 'absent' })]);
    expect(problems.join('; ')).toContain('without authorization');
  });

  it('names all five report layers', () => {
    expect(REPORT_LAYERS).toHaveLength(5);
    expect([...REPORT_LAYERS]).toEqual([
      'engineering-runnable',
      'security-contract',
      'learning-semantics',
      'real-host-compatibility',
      'task-benefit'
    ]);
  });
});

describe('event-shape degradation: off-contract payload -> D1 passthrough, never a crash', () => {
  const modules = { createDshHookHostAdapter, createScopeRegistry, createHostToolExperienceCollector, parseEvoHarnessConfig };
  const config = parseEvoHarnessConfig({
    triggerMode: 'always',
    jitrl: {
      enabled: true,
      reward: { weights: { tool: 0.5, turn: 0.5, llm: 0, surrogate: 0, user: 0 }, clip: [-3, 3] }
    },
    memoryBridge: { namespacePrefix: 'harness2' },
    logging: { level: 'silent' }
  });

  it('passes every degradation case: host decision preserved, no advice, no learning', async () => {
    const results = await runDegradationMatrix({ modules, config });
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const result of results) {
      expect(result.passed, result.id + ': observed=' + result.observedDecision + ' host=' + result.hostDecision).toBe(true);
      expect(result.advisorCalls).toBe(0);
      expect(result.recordsAppended).toBe(0);
    }
  });

  it('proves an untrusted payload self-claiming identity/role gets no advice and no record', async () => {
    const results = await runDegradationMatrix({ modules, config });
    const claimed = results.find((entry) => entry.id === 'shape-5-self-claimed-identity');
    expect(claimed).toBeDefined();
    expect(claimed?.passed).toBe(true);
    expect(claimed?.advisorCalls).toBe(0);
    expect(claimed?.recordsAppended).toBe(0);
  });

  it('proves a prompt assembly without `sections` is skipped with a bounded note, not thrown', async () => {
    const results = await runDegradationMatrix({ modules, config });
    const assembly = results.find((entry) => entry.id === 'shape-4-assembly-without-sections');
    expect(assembly?.passed).toBe(true);
    expect(assembly?.diagnosticsReported).toBe(true);
  });

  it('proves dispose removes every hook listener (no undispatched-hook residue)', async () => {
    const results = await runDegradationMatrix({ modules, config });
    const disposal = results.find((entry) => entry.id === 'shape-6-undispatched-hook');
    expect(disposal?.passed).toBe(true);
    expect(disposal?.observedDecision).toBe('listener-removed');
  });
});
