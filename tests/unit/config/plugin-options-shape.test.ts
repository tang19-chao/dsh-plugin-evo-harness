/**
 * P1 / ADR 0005 section 3: the atomic plugin-options entrypoint.
 *
 * Every case below drives the REAL public surface - `normalizePluginOptions` is
 * the exported shape decision and `apply` is the Cordis entrypoint a host calls -
 * never a local reimplementation of the rule. Counterexamples are numbered
 * C-1..C-12 to match ADR 0005 section 3.3, whose right-hand column is the
 * contract this file enforces; the pre-repair behaviour measured in the ADR
 * (section 8.4) is quoted where a case exists because that behaviour was wrong.
 *
 * Two boundaries are deliberately recorded instead of over-claimed:
 *  - `MODEL_ROUTE_EFFORTS` enum ENFORCEMENT is not this window: t4 narrows the
 *    public TYPE (`EvoHarnessModelRouteEffort` + the `_ROUTE_EFFORT_ENUM_EXACT`
 *    witness in src/index.ts); a value that arrives from JavaScript or from the
 *    host `modelRoute` group is rejected at RUNTIME by the host-group validation
 *    and the state-wiring follow-up (ADR 0005 section 3.6).
 *  - C-10's rejection text comes from the frozen validator in src/config.ts,
 *    which the entrypoint repair must not modify; the ADR requires the rejection
 *    to be LOUD, not that this window rewrites its wording.
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  DEFAULT_EVO_HARNESS_CONFIG,
  validateEvoHarnessConfig
} from '../../../src/config';
import { MODEL_ROUTE_EFFORTS } from '../../../src/dsh-bridge';
import {
  OPTION_KEYS,
  PluginOptionsShapeError,
  apply,
  normalizePluginOptions,
  type EvoHarnessPluginOptions
} from '../../../src/index';

/**
 * The options surface exactly as ADR 0005 section 3.1 enumerates it.
 *
 * Kept as a literal so an unauthorised ADDITION to `OPTION_KEYS` is caught
 * here, while a new key on the public interface is caught by the compile-time
 * witness in src/index.ts. `assertPublicOptionKey` below is the third side: it
 * refuses a literal that is not a declared public option at all.
 */
const ADR_OPTION_KEYS: readonly string[] = [
  'dualTrack',
  'config',
  'model',
  'host',
  'clients',
  'listClients',
  'runBranch',
  'deps',
  'persistence',
  'experienceFilePath',
  'backfillFromTreePool',
  'agentLoop',
  'now',
  'newId',
  'commitScope',
  'registerAutoFallback',
  'autoFallbackEvents',
  'applyWinningPatch',
  'resolveDshCollaborators',
  'route',
  'enableIdleDream',
  'dream',
  'mirrorClient',
  'hostAdvisor',
  'scopeRegistry',
  'hostAdvisorScope'
];

/** The frozen config root keys of src/config.ts, as documented in ADR 0005 section 3.1. */
const DOCUMENTED_ROOT_KEYS: readonly string[] = [
  'schemaVersion',
  'enabled',
  'triggerMode',
  'enabledSurfaces',
  'probe',
  'memoryBridge',
  'dreamRsi',
  'jitrl',
  'execution',
  'logging'
];

/**
 * Compile-time bound: `key` must be a declared public option.
 *
 * `keyof EvoHarnessPluginOptions` has no index signature, so the bound is the
 * exact declared surface. The negative witness below proves this parameter is
 * not a bare `string` (which would accept anything and prove nothing).
 */
function assertPublicOptionKey<K extends keyof EvoHarnessPluginOptions>(key: K): K {
  return key;
}

/**
 * Compile-time negative witness; deliberately never executed.
 *
 * `@ts-expect-error` turns each line into a `tsc --noEmit` gate: if a key
 * outside the public option surface were accepted here, tsc would report the
 * unused `@ts-expect-error` directive.
 */
function optionSurfaceNegativeWitness(): void {
  // @ts-expect-error 'persistence2' is a misspelling, not a public option key
  assertPublicOptionKey('persistence2');
  // @ts-expect-error 'modelRoute' is the host-only config group, NOT a plugin option
  assertPublicOptionKey('modelRoute');
  // @ts-expect-error 'enabled' is a frozen config ROOT key, NOT a plugin option
  assertPublicOptionKey('enabled');
}
void optionSurfaceNegativeWitness;

/** A minimal host context whose only interesting member is the plugin config. */
function ctxWithConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { config };
}

/** The ADR C-1 context: the host declares execution off and JitRL disabled. */
const CTX_CONFIG: Record<string, unknown> = {
  schemaVersion: 1,
  jitrl: { enabled: false },
  execution: { mode: 'off' }
};

/** Run `run` and return the PluginOptionsShapeError it threw (or undefined). */
function catchShapeError(run: () => unknown): PluginOptionsShapeError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof PluginOptionsShapeError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

describe('OPTION_KEYS: the public options surface (ADR 0005 section 3.1/3.5)', () => {
  it('registers exactly the 26 ADR-enumerated keys, with no duplicate', () => {
    expect(new Set(OPTION_KEYS).size).toBe(26);
    expect(OPTION_KEYS.length).toBe(26);
    expect([...OPTION_KEYS].sort()).toEqual([...ADR_OPTION_KEYS].sort());
  });

  it('is alphabetically ordered and carries the config key', () => {
    const sorted = [...OPTION_KEYS].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect([...OPTION_KEYS]).toEqual(sorted);
    expect(OPTION_KEYS).toContain('config');
  });

  it('is compile-time exhaustive over EvoHarnessPluginOptions', () => {
    // Every registered key must be a declared public option (tsc bound), and the
    // list must cover the whole surface. The authoritative both-directions check
    // is the `_OPTION_KEYS_EXHAUSTIVE` witness in src/index.ts; this runtime
    // pass makes the same fact visible without reading the source.
    const declared = OPTION_KEYS.map((key) => assertPublicOptionKey(key));
    expect(declared.length).toBe(26);
    expect(new Set(declared)).toEqual(new Set(OPTION_KEYS));
  });
});

describe('OPTION_KEYS is disjoint from ROOT_KEYS and from modelRoute (ADR 0005 section 3.1)', () => {
  it('derives the 10 documented root keys from the public frozen defaults', () => {
    const rootDefaults = DEFAULT_EVO_HARNESS_CONFIG as unknown as Record<string, unknown>;
    expect(Object.keys(rootDefaults).sort()).toEqual([...DOCUMENTED_ROOT_KEYS].sort());
    // Every derived root key is ACCEPTED as a config section...
    const rejectedRoots = Object.keys(rootDefaults).filter((key) => {
      const result = validateEvoHarnessConfig({ [key]: rootDefaults[key] });
      return result.issues.some((issue) => issue.code === 'unknown_key' && issue.path === key);
    });
    expect(rejectedRoots).toEqual([]);
  });

  it('has an empty intersection with ROOT_KEYS and never contains modelRoute', () => {
    const rootDefaults = DEFAULT_EVO_HARNESS_CONFIG as unknown as Record<string, unknown>;
    const rootKeys = Object.keys(rootDefaults);
    expect(OPTION_KEYS.filter((key) => rootKeys.includes(key))).toEqual([]);
    expect(OPTION_KEYS).not.toContain('modelRoute');
  });

  it('keeps modelRoute on the host group: neither an option key nor a config root key', () => {
    // `modelRoute` is split out of the raw section BEFORE the frozen validation
    // (src/host-triggers.ts::splitModelRoute), so it is an unknown key to the
    // frozen validator and must never appear in OPTION_KEYS either.
    expect(OPTION_KEYS).not.toContain('modelRoute');
    const probe = validateEvoHarnessConfig({ modelRoute: {} });
    expect(probe.issues.some((issue) => issue.code === 'unknown_key' && issue.path === 'modelRoute')).toBe(true);
    // Shape-wise it stays a CONFIG section (C-11), never an options object.
    expect(Object.prototype.hasOwnProperty.call(normalizePluginOptions({ modelRoute: {} }, undefined), 'config')).toBe(true);
  });

  it('proves the same invariant behaviourally: every option key is an unknown CONFIG key', () => {
    // Independent of the derivation above: no option key may be accepted where a
    // frozen root key is accepted. If one were, a bare config section could carry
    // an option key and the shape decision would be ambiguous.
    const acceptedAsConfig = OPTION_KEYS.filter((key) => {
      const result = validateEvoHarnessConfig({ [key]: {} });
      return !result.issues.some((issue) => issue.code === 'unknown_key' && issue.path === key);
    });
    expect(acceptedAsConfig).toEqual([]);
    // `config` is the explicit "configuration lives here" OPTION key and must not
    // be a config SECTION key (ADR 0005 section 3.1).
    const configProbe = validateEvoHarnessConfig({ config: {} });
    expect(
      configProbe.issues.some((issue) => issue.code === 'unknown_key' && issue.path === 'config')
    ).toBe(true);
  });
});

describe('shape decision: the C-1..C-12 counterexamples (ADR 0005 section 3.2/3.3)', () => {
  it('C-1: apply(ctx, {}) does NOT swallow ctx.config', () => {
    // Before the repair this resolved mode='shadow' / jitrl.enabled=true because
    // the empty object was turned into a fabricated `{config:{}}`.
    expect(normalizePluginOptions({}, CTX_CONFIG)).toEqual({});
    const plugin = apply(ctxWithConfig(CTX_CONFIG), {});
    expect(plugin.config.execution.mode).toBe('off');
    expect(plugin.config.jitrl.enabled).toBe(false);
  });

  it('C-2: apply(ctx) without a second argument still uses ctx.config (regression)', () => {
    const plugin = apply(ctxWithConfig(CTX_CONFIG));
    expect(plugin.config.execution.mode).toBe('off');
    expect(plugin.config.jitrl.enabled).toBe(false);
  });

  it('C-3: apply(ctx, {config:{}}) is the LEGAL explicit clear to the defaults', () => {
    expect(normalizePluginOptions({ config: {} }, CTX_CONFIG)).toEqual({ config: {} });
    const plugin = apply(ctxWithConfig(CTX_CONFIG), { config: {} });
    // Explicit `config` replaces ctx.config with the frozen defaults: this is
    // what makes C-3 distinguishable from C-1.
    expect(plugin.config.execution.mode).toBe('shadow');
    expect(DEFAULT_EVO_HARNESS_CONFIG.execution.mode).toBe('shadow');
    expect(plugin.config.jitrl.enabled).toBe(true);
    expect(DEFAULT_EVO_HARNESS_CONFIG.jitrl.enabled).toBe(true);
  });

  it('C-3b: a single-key {config:X} is legal and is honoured verbatim', () => {
    const second = { config: { triggerMode: 'always', jitrl: { enabled: false } } };
    expect(normalizePluginOptions(second, CTX_CONFIG)).toBe(second);
    const plugin = apply(ctxWithConfig(CTX_CONFIG), second);
    expect(plugin.config.triggerMode).toBe('always');
    expect(plugin.config.jitrl.enabled).toBe(false);
  });

  const MIXED_WITH_CONFIG: readonly {
    readonly label: string;
    readonly second: Record<string, unknown>;
    readonly offender: string;
  }[] = [
    { label: 'C-4', second: { config: { schemaVersion: 1 }, enabled: false }, offender: 'enabled' },
    { label: 'C-5', second: { config: { schemaVersion: 1 }, execution: { mode: 'off' } }, offender: 'execution' },
    { label: 'C-6', second: { config: { schemaVersion: 1 }, jitrl: { enabled: false } }, offender: 'jitrl' }
  ];

  for (const entry of MIXED_WITH_CONFIG) {
    it(`${entry.label}: {config:...} plus ${entry.offender} throws plugin-options-mixed-shape`, () => {
      const thrown = catchShapeError(() => normalizePluginOptions(entry.second, undefined));
      expect(thrown?.name).toBe('PluginOptionsShapeError');
      expect(thrown?.code).toBe('plugin-options-mixed-shape');
      expect(thrown?.message).toContain('plugin-options-mixed-shape');
      expect(thrown?.offendingKeys).toEqual([entry.offender]);
      expect(thrown?.message).toContain(entry.offender);
      // …and the real entrypoint refuses to mount instead of reinterpreting.
      expect(() => apply({}, entry.second)).toThrow(PluginOptionsShapeError);
    });
  }

  it('C-7: {model, triggerMode} throws instead of silently dropping triggerMode', () => {
    // Before the repair this returned the options object and triggerMode never
    // reached the config: a silently dropped switch.
    const thrown = catchShapeError(() =>
      normalizePluginOptions({ model: {}, triggerMode: 'always' }, undefined)
    );
    expect(thrown?.code).toBe('plugin-options-mixed-shape');
    expect(thrown?.offendingKeys).toEqual(['triggerMode']);
    expect(thrown?.message).toContain('triggerMode');
  });

  it('C-8: {deps, enabled:false} never mounts with the security switch dropped', () => {
    // Before the repair the plugin MOUNTED with config.enabled===true.
    const thrown = catchShapeError(() => apply(ctxWithConfig(CTX_CONFIG), { deps: {}, enabled: false }));
    expect(thrown?.code).toBe('plugin-options-mixed-shape');
    expect(thrown?.offendingKeys).toEqual(['enabled']);
  });

  it('C-8b: a bare {enabled:false} section is honoured, never dropped', () => {
    const plugin = apply(ctxWithConfig(CTX_CONFIG), { enabled: false });
    expect(plugin.config.enabled).toBe(false);
  });

  it('C-8c: {modelRoute, enabled:false} keeps both (modelRoute is not an option key)', () => {
    const plugin = apply({}, {
      enabled: false,
      modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'max' }
    });
    expect(plugin.config.enabled).toBe(false);
    expect(plugin.modelRoute).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' });
  });

  it('C-9: every single OPTION KEY is recognised as an option, not as a config section', () => {
    const misclassified = OPTION_KEYS.filter((key) => {
      const normalized = normalizePluginOptions({ [key]: {} }, undefined);
      return !Object.prototype.hasOwnProperty.call(normalized, key);
    });
    expect(misclassified).toEqual([]);
  });

  it('C-9b: the ADR-listed options are no longer wrapped into {config:...}', () => {
    // Before the repair all of these became `{config:{<key>:…}}` and then died on
    // an unknown_key diagnostic naming the WRONG key.
    const listed = [
      'persistence',
      'dualTrack',
      'scopeRegistry',
      'route',
      'agentLoop',
      'dream',
      'enableIdleDream',
      'resolveDshCollaborators',
      'backfillFromTreePool',
      'experienceFilePath'
    ] as const;
    for (const key of listed) {
      const normalized = normalizePluginOptions({ [key]: {} }, undefined);
      expect(Object.prototype.hasOwnProperty.call(normalized, key)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(normalized, 'config')).toBe(false);
    }
  });

  it('C-10: a misspelled option ({presistence}) is REJECTED loudly, never ignored', () => {
    expect(normalizePluginOptions({ presistence: {} }, undefined)).toEqual({
      config: { presistence: {} }
    });
    let thrown: unknown;
    try {
      apply({}, { presistence: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const issues = (thrown as ConfigValidationError).issues;
    expect(
      issues.some((issue) => issue.code === 'unknown_key' && issue.path === 'presistence')
    ).toBe(true);
  });

  it('C-11: a bare modelRoute section stays a CONFIG section (enum is typed here, enforced later)', () => {
    // Shape decision owned by this window: the section is NOT reinterpreted as an
    // options object, and the out-of-enum value is not silently rewritten.
    const raw = { modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'ultra' } };
    expect(normalizePluginOptions(raw, undefined)).toEqual({ config: raw });

    // Legal end-to-end path: an in-enum effort reaches the mounted route verbatim.
    const plugin = apply({}, { modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'max' } });
    expect(plugin.modelRoute).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' });

    // The enum is the dsh-bridge single source; `options.route.reasoningEffort`
    // is narrowed to it in src/index.ts. The runtime rejection of an out-of-enum
    // value arriving from JavaScript or from the host group belongs to the
    // host-group validation and the state-wiring follow-up (ADR 0005 section 3.6).
    expect([...MODEL_ROUTE_EFFORTS]).toEqual(['high', 'max', 'low']);
  });

  it('C-12: a non-object second argument throws plugin-options-invalid-shape (null included)', () => {
    const rejected: readonly unknown[] = [null, 'a yaml string', 7, true, ['array'], () => undefined];
    const wronglyAccepted = rejected.filter(
      (value) => catchShapeError(() => normalizePluginOptions(value, CTX_CONFIG)) === undefined
    );
    expect(wronglyAccepted).toEqual([]);
    for (const value of rejected) {
      const thrown = catchShapeError(() => normalizePluginOptions(value, CTX_CONFIG));
      expect(thrown?.name).toBe('PluginOptionsShapeError');
      expect(thrown?.code).toBe('plugin-options-invalid-shape');
      expect(thrown?.message).toContain('plugin-options-invalid-shape');
    }
    // Before the repair `apply(ctx, null)` returned `{}` and lost ctx.config.
    const thrown = catchShapeError(() => apply(ctxWithConfig(CTX_CONFIG), null));
    expect(thrown?.code).toBe('plugin-options-invalid-shape');
    expect(thrown?.offendingKeys).toEqual([]);
  });

  it('reports the rejected shape without echoing the value', () => {
    const thrown = catchShapeError(() => normalizePluginOptions('secret-payload-text', CTX_CONFIG));
    expect(thrown?.message).toContain('received string');
    expect(thrown?.message).not.toContain('secret-payload-text');
  });
});

describe('entry regression: behaviour that must NOT change', () => {
  it('the documented e2e options shape ({config, model, clients, runBranch, now, newId}) still works', () => {
    const second = {
      config: { triggerMode: 'always' },
      model: undefined,
      clients: [],
      runBranch: async (): Promise<never> => {
        throw new Error('not used in this test');
      },
      now: (): number => 1,
      newId: (): string => 'id-1'
    };
    expect(normalizePluginOptions(second, CTX_CONFIG)).toBe(second);
    const plugin = apply(ctxWithConfig(CTX_CONFIG), second);
    expect(plugin.config.triggerMode).toBe('always');
  });

  it('a pure config section (no option key at all) still routes to the config shape', () => {
    const section = {
      schemaVersion: 1,
      triggerMode: 'always',
      jitrl: { enabled: false },
      execution: { mode: 'shadow' }
    };
    expect(normalizePluginOptions(section, CTX_CONFIG)).toEqual({ config: section });
    const plugin = apply(ctxWithConfig(CTX_CONFIG), section);
    expect(plugin.config.triggerMode).toBe('always');
    expect(plugin.config.jitrl.enabled).toBe(false);
  });

  it('keeps the mounted status and teardown surfaces reachable', () => {
    const plugin = apply(ctxWithConfig(CTX_CONFIG), {});
    expect(typeof plugin.dispose).toBe('function');
    expect(typeof plugin.settle).toBe('function');
    expect(plugin.jitrl.enabled).toBe(false);
    expect(typeof plugin.jitrl.storeSize).toBe('number');
    expect(plugin.config.execution.mode).toBe('off');
  });
});