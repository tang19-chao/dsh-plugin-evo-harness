/**
 * rev6 R2-1: the apply-context probe must produce evidence from a context that
 * really has the host services, and must REFUSE to manufacture the facts it
 * cannot observe.
 *
 * These tests run the probe against a STRUCTURAL stand-in host (a plain Cordis
 * `Context` from the repository's own dependency plus a minimal SystemPrompt /
 * ToolRuntime double). That is deliberate: the assertions below are about the
 * probe's OWN judgement rules - which must be identical in the real run - so
 * they can be executed by `pnpm run test:e2e` without an installed DSH host.
 *
 * What this file does NOT do: it does not claim the real host was exercised.
 * The real-host facts live in `docs/reports/host-smoke-rc3.md`, which only the
 * installed host can produce.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeApplyContext, judgeApplyContext } from '../../../scripts/host-smoke/apply-context.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// --- a structural stand-in for the installed host ---------------------------
// `@deepseek-ai/cordis` is an INSTALLED-HOST package, not a repository
// dependency (that is the whole reason in-host.mjs runs under the DSH
// executable). The probe only needs the smallest Cordis subset - `plugin()`,
// `on()` and `waterfall()` - so the double below implements exactly that. The
// real run substitutes the installed Context; the probe's judgement rules are
// the same code either way.
type Listener = (value: unknown, next: () => Promise<unknown>) => Promise<unknown>;

class ContextDouble {
  readonly listeners = new Map<string, Listener[]>();

  /** Cordis activates a plugin class/factory with the context. */
  plugin(plugin: unknown): unknown {
    if (typeof plugin === 'function') {
      return new (plugin as new (ctx: unknown) => unknown)(this);
    }
    if (plugin !== null && typeof plugin === 'object' && typeof (plugin as { apply?: unknown }).apply === 'function') {
      (plugin as { apply: (ctx: unknown) => void }).apply(this);
    }
    return plugin;
  }

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(event, current.filter((entry) => entry !== listener));
    };
  }

  /** Waterfall semantics: the LAST argument is `next`, called by the listener. */
  async waterfall(_self: unknown, event: string, payload: unknown, next: (value: unknown) => Promise<unknown>): Promise<unknown> {
    const chain = [...(this.listeners.get(event) ?? [])].reverse();
    let index = 0;
    const step = async (value: unknown): Promise<unknown> => {
      if (index >= chain.length) {
        return typeof next === 'function' ? next(value) : value;
      }
      const listener = chain[index];
      index += 1;
      if (listener === undefined) {
        return next(value);
      }
      return listener(value, () => step(value));
    };
    return step(payload);
  }
}

interface HostDoubleOptions {
  publishTools?: boolean;
  publishSystemPrompt?: boolean;
}

/** The minimal service bag the two fake plugins write onto the context. */
interface ServiceBag {
  systemPrompt?: unknown;
  tools?: unknown;
}

function makeHostDouble(options: HostDoubleOptions = {}) {
  const publishTools = options.publishTools !== false;
  class SystemPromptDouble {
    constructor(ctx: ServiceBag) {
      if (options.publishSystemPrompt !== false) {
        ctx.systemPrompt = {
          section: () => undefined,
          assemble: async (assembly: unknown) => assembly
        };
      }
    }
  }
  class ToolRuntimeDouble {
    constructor(ctx: ServiceBag) {
      if (publishTools) {
        ctx.tools = { execute: async () => undefined, schemas: () => [], register: () => ({ dispose: () => undefined }) };
      }
    }
  }
  return {
    createContext: () => new ContextDouble(),
    SystemPrompt: SystemPromptDouble,
    ToolRuntime: ToolRuntimeDouble
  };
}

/** A plugin double that REGISTERS the four hooks and exposes a surfaces list. */
interface SurfaceMatrixInputDouble {
  capturedAt: string;
  hostAdapterSource: string;
  hookDetected: boolean;
  installedHookEvents?: readonly string[];
  structuralSeams: number;
  contextKind?: 'bare-cordis-context' | 'not-run';
  enabledSurfaces?: readonly string[];
}

interface PluginDoubleOptions {
  hookEvents?: readonly string[];
  surfaces?: SurfaceDouble[];
}

interface SurfaceDouble {
  surface: string;
  enabled: boolean;
  mountable: boolean;
  cacheRead: string;
}

function makePluginDouble(options: PluginDoubleOptions = {}) {
  const registered: string[] = [];
  const hookEvents = options.hookEvents ?? ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step'];
  const surfaces = options.surfaces ?? [
    { surface: 'system_prompt', enabled: true, mountable: true, cacheRead: 'unknown' },
    { surface: 'guardrails', enabled: true, mountable: true, cacheRead: 'unknown' },
    { surface: 'memory', enabled: true, mountable: false, cacheRead: 'unknown' },
    { surface: 'tool_guidance', enabled: true, mountable: false, cacheRead: 'unknown' },
    { surface: 'skills', enabled: true, mountable: false, cacheRead: 'unknown' },
    { surface: 'scripts', enabled: true, mountable: false, cacheRead: 'unknown' },
    { surface: 'subagents', enabled: true, mountable: false, cacheRead: 'unknown' },
    { surface: 'plugins', enabled: true, mountable: true, cacheRead: 'unknown' }
  ];
  return {
    registered,
    apply(ctx: { on: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => void }) {
      for (const event of hookEvents) {
        ctx.on(event, async (...args) => {
          const next = args[args.length - 1];
          return typeof next === 'function' ? next() : { kind: 'allow' };
        });
        registered.push(event);
      }
      return { surfaces, config: { enabledSurfaces: surfaces.map((s) => s.surface) }, dispose: async () => undefined };
    },
    resolveHostAdapter: () => ({ hostAdapterSource: 'dsh-hooks' }),
    createCordisHostFromContext: () => ({}),
    hostAdapterSeamCount: () => 0,
    detectDshHookHost: () => ({ detected: true }),
    createDshHookHostAdapter: () => ({ registerPromptSegment: async () => ({}) }),
    readHookScope: () => ({ branchIds: new Set(), sessionIds: new Set(), namespaces: new Set() }),
    hookScopeMatches: () => false,
    classifySurfaceMatrix: (input: SurfaceMatrixInputDouble) => {
      // The double must AGREE with the handle it also returns: a face the handle
      // marks mountable=false cannot be classified `native`, or every test would
      // exercise the cross-check's failure path by accident.
      const mountableBySurface = new Map((options.surfaces ?? surfaces).map((entry) => [entry.surface, entry.mountable]));
      return {
        capturedAt: input.capturedAt,
        hostAdapterSource: input.hostAdapterSource,
        hookDetected: input.hookDetected,
        installedHookEvents: input.installedHookEvents ?? [],
        structuralSeams: input.structuralSeams,
        contextKind: input.contextKind ?? 'bare-cordis-context',
        faces: (input.enabledSurfaces ?? []).map((surface: string) => {
          const mountable = mountableBySurface.get(surface) === true;
          return {
            surface,
            configured: true,
            availability: mountable ? 'native' : 'not-run',
            mechanism: mountable ? 'dsh-hook' : 'not-observed',
            hostMethod: 'x',
            seamPresent: mountable,
            evidence: 'double',
            ...(mountable ? {} : { limitation: 'double: face not mountable on this handle' })
          };
        }),
        problems: []
      };
    },
    validateSurfaceMatrix: () => []
  };
}

describe('apply-context probe: the apply evidence comes from a service-equipped context', () => {
  it('returns a handle, registers every expected hook, and reports the applied surfaces', async () => {
        const host = makeHostDouble();
    const plugin = makePluginDouble();

    const probe = await probeApplyContext({
      host,
      plugin,
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });

    expect(probe.applyContext.services.tools).toBe(true);
    expect(probe.applyContext.services.systemPrompt).toBe(true);
    expect(probe.applyContext.applyReturnedHandle).toBe(true);
    expect(probe.hookRegistration.matched).toBe(true);
    expect(probe.hookRegistration.missing).toEqual([]);
    // The four dispatch hooks are a subset of what apply() registered; lifecycle
    // hooks are reported as `extra`, never as a failure.
    for (const event of ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']) {
      expect(probe.hookRegistration.registered).toContain(event);
    }
    expect(probe.surfaces).toHaveLength(8);
  });

  it('records every real dispatch, and does not upgrade an unobserved mount', async () => {
        const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin: makePluginDouble(),
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });

    // All four plan entries are reported, dispatched flag included.
    expect(probe.identity).toHaveLength(4);
    expect(probe.identity.every((entry) => entry.dispatched === true)).toBe(true);

    // Collect-or-omit: the double never mounts a surface, so NO face may claim
    // a lastMountResult. A fabricated `{ ok: true }` here would be the exact
    // defect the status contract forbids.
    expect(probe.crossCheck.lastMountResultObserved).toBe(0);
    expect(probe.surfaces.every((entry) => entry.hasLastMountResult === false)).toBe(true);
    // ...and cacheRead stays unknown, never a measured zero.
    expect(probe.surfaces.every((entry) => entry.cacheRead === 'unknown')).toBe(true);
  });

  it('cross-checks the classification against the handle projection face by face', async () => {
        const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin: makePluginDouble(),
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });
    expect(probe.crossCheck.checked).toBe(8);
    expect(probe.crossCheck.disagreements).toEqual([]);
  });

  it('refuses to proceed when the context never activates the host services', async () => {
        const probe = await probeApplyContext({
      host: makeHostDouble({ publishTools: false }),
      plugin: makePluginDouble(),
      config: {},
      expectedHookEvents: ['system-prompt/assemble']
    });
    expect(probe.applyContext.services.tools).toBe(false);
    expect(probe.ok).toBe(false);
    expect(probe.problems.join(' ')).toContain('did not activate');
    // It must NOT have gone on to claim a handle or a matrix.
    expect(probe.applyContext.applyReturnedHandle).toBe(false);
    expect(probe.matrix).toBeNull();
  });

  it('survives an apply() that throws, and says so instead of reporting a handle', async () => {
        const plugin = makePluginDouble();
    plugin.apply = () => {
      throw new Error('boom from apply');
    };
    const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin,
      config: {},
      expectedHookEvents: ['system-prompt/assemble']
    });
    expect(probe.applyContext.applyReturnedHandle).toBe(false);
    expect(probe.applyContext.applyError).toContain('boom from apply');
    expect(probe.ok).toBe(false);
  });
});

describe('judgeApplyContext: surface evidence and branch evidence are separate obligations', () => {
  it('passes the apply/surface obligation with a real apply context and 8/8 agreement', async () => {
        const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin: makePluginDouble(),
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });
    const judged = judgeApplyContext(probe);
    expect(judged.applyContextEvidence).toBe(true);
    expect(judged.surfaceEvidence).toBe(true);
    expect(judged.applyReasons).toEqual([]);
  });

  it('reports a branch-less host as BLOCKED without failing the surface obligation', async () => {
        const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin: makePluginDouble(),
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });
    const judged = judgeApplyContext(probe);
    // The double supplies no branchId -> blocked is TRUE...
    expect(judged.blocked).toBe(true);
    expect(judged.branchReasons.join(' ')).toContain('branchId');
    // ...but that must not leak into the surface reasons (R2-1 vs R2-2).
    expect(judged.applyReasons).toEqual([]);
  });

  it('fails the surface obligation when production resolution and the classified adapter disagree', async () => {
    const plugin = makePluginDouble();
    // Simulate rc2's defect: production resolves one source, the adapter the
    // classifier was given is another. The judge must reject it rather than
    // excuse it in prose.
    plugin.resolveHostAdapter = () => ({ hostAdapterSource: 'in-memory' });
    const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin,
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });
    // The probe must have labelled the matrix with the adapter it BUILT, not
    // with production's answer - otherwise this check could never fail.
    expect(probe.matrix?.hostAdapterSource).toBe('dsh-hooks');
    expect(probe.applyContext.productionResolvedSource).toBe('in-memory');
    const judged = judgeApplyContext(probe);
    expect(judged.surfaceEvidence).toBe(false);
    expect(judged.applyReasons.join(' ')).toContain('disagrees');
  });

  it('fails the surface obligation when the handle contradicts the classification', async () => {
    const plugin = makePluginDouble({
      // The handle says EVERY face is mountable...
      surfaces: [
        { surface: 'system_prompt', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'guardrails', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'memory', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'tool_guidance', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'skills', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'scripts', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'subagents', enabled: true, mountable: true, cacheRead: 'unknown' },
        { surface: 'plugins', enabled: true, mountable: true, cacheRead: 'unknown' }
      ]
    });
    // ...while the classifier says `guardrails` is unavailable. Agreement is the
    // double's normal behaviour, so the contradiction is forced here explicitly:
    // this is the ONLY way the cross-check's mismatch branch gets exercised.
    plugin.classifySurfaceMatrix = (input) => ({
      capturedAt: input.capturedAt,
      hostAdapterSource: input.hostAdapterSource,
      hookDetected: input.hookDetected,
      installedHookEvents: input.installedHookEvents ?? [],
      structuralSeams: input.structuralSeams,
      contextKind: input.contextKind ?? 'bare-cordis-context',
      faces: (input.enabledSurfaces ?? []).map((surface: string) => ({
        surface,
        configured: true,
        availability: surface === 'guardrails' ? 'unavailable' : 'native',
        mechanism: surface === 'guardrails' ? 'none' : 'dsh-hook',
        hostMethod: 'x',
        seamPresent: surface !== 'guardrails',
        evidence: 'double',
        ...(surface === 'guardrails' ? { limitation: 'forced contradiction for the cross-check' } : {})
      })),
      problems: []
    });
    const probe = await probeApplyContext({
      host: makeHostDouble(),
      plugin,
      config: {},
      expectedHookEvents: ['system-prompt/assemble', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']
    });
    const judged = judgeApplyContext(probe);
    expect(probe.crossCheck.disagreements.join(' ')).toContain('guardrails');
    expect(judged.surfaceEvidence).toBe(false);
  });

  it('returns a blocking verdict when the probe never ran', () => {
    const judged = judgeApplyContext(undefined);
    expect(judged.applyContextEvidence).toBe(false);
    expect(judged.surfaceEvidence).toBe(false);
    expect(judged.blocked).toBe(true);
    expect(judged.applyReasons).toContain('probe did not run');
  });
});

describe('apply-context module: it stays inside its write scope', () => {
  it('exists under scripts/host-smoke and performs no writes of its own', async () => {
    const fs = await import('node:fs');
    const modulePath = path.join(repoRoot, 'scripts', 'host-smoke', 'apply-context.mjs');
    expect(fs.existsSync(modulePath)).toBe(true);
    const source = fs.readFileSync(modulePath, 'utf8');
    // A probe must not write: no report, no artifact, no repo mutation.
    expect(source).not.toMatch(/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/);
  });
});
