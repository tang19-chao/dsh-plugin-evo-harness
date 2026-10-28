/**
 * Entry-level L3 status observability (t7, ADR 0005 section 3.7).
 *
 * The adapter-side counters themselves are locked by t5's contract test
 * (tests/unit/seams/status-observability-contract.test.ts). THIS file proves the
 * mapping a host actually reads: `plugin.jitrl.hostAdvisor` on the real
 * `createEvoHarnessPlugin` path, driven through the real DSH hook fixture
 * listeners. Nothing here hand-builds a status object, so a regression in
 * src/index.ts cannot pass.
 *
 * Acceptance mapping:
 *   - collect-or-omit: an adapter with no `hostAdvisorStats()` yields ABSENT
 *     counter keys (and JSON drops them); the real hook adapter yields measured
 *     numbers, where `0` is a real zero (F-15);
 *   - zero / increment / runtime gate / not-collected / not-run and JSON
 *     round-trip are all driven through the mounted plugin;
 *   - the status carries counters and the advisor's own diagnostics strings and
 *     nothing else - no tool arguments, payload bodies or advice text;
 *   - ADR 0005 section 3.6: the PROGRAMMATIC `route.reasoningEffort` is checked
 *     at runtime by the same single-source function as the host group.
 *
 * No DSH runtime, network or LLM is involved.
 */
import { describe, expect, it } from 'vitest';

import {
  createEvoHarnessPlugin,
  apply,
  type EvoHarnessPlugin,
  type EvoHarnessPluginOptions
} from '../../../src/index';
import { ModelRouteEffortError } from '../../../src/host-triggers';
import { MODEL_ROUTE_DEFAULTS, MODEL_ROUTE_EFFORTS } from '../../../src/dsh-bridge';
import { buildE2E } from '../../e2e/fixtures';
import { createHookFixture, type HookFixture } from '../cordis-seams/hook-fixtures';

/** The observable counter keys, in a stable order for shape assertions. */
const COUNTER_KEYS = [
  'advisory',
  'ask',
  'considered',
  'excludedByDeclaration',
  'noop',
  'scopeUnknownSkipped',
  'skipped'
] as const;

/** The fixed (always present) status fields next to those counters. */
const FIXED_KEYS = ['attached', 'diagnostics', 'enabled', 'mode', 'runtimeEnabled'] as const;

/** Advisor switch states used by the mounts below. */
const HIDDEN_ADVISOR = {
  enabled: false,
  mode: 'advisory',
  adviseThreshold: -0.5,
  gateThreshold: -0.8,
  minSupport: 5
} as const;

const GATE_ADVISOR = {
  enabled: true,
  mode: 'gate',
  adviseThreshold: -0.5,
  gateThreshold: -0.8,
  minSupport: 1
} as const;

type Listener = (...args: unknown[]) => Promise<unknown>;

const allow = async (): Promise<{ kind: string }> => ({ kind: 'allow' });

function hasKey(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Mount on a real DSH hook context: `createEvoHarnessPlugin` builds its own
 * `dsh-hooks` adapter there, which DOES collect every counter.
 */
function mountOnHookContext(config: Record<string, unknown>): {
  readonly fixture: HookFixture;
  readonly plugin: EvoHarnessPlugin;
} {
  const fixture = createHookFixture();
  const harness = buildE2E({ ctx: fixture.ctx as never, config });
  return { fixture, plugin: harness.plugin };
}

function preExecute(fixture: HookFixture): Listener {
  return fixture.listener('tools/pre-execute') as unknown as Listener;
}

describe('collect-or-omit: "not collected" is ABSENT, never a fabricated 0', () => {
  it('omits every counter when the mounted adapter exposes no hostAdvisorStats()', async () => {
    // A bare context mounts the in-memory adapter, which cannot measure L3
    // activity: reporting 0 there was exactly the F-15 defect.
    const plugin = createEvoHarnessPlugin(
      { config: { jitrl: { hostAdvisor: HIDDEN_ADVISOR } } },
      {}
    );
    const status = plugin.jitrl.hostAdvisor;
    expect(status).toBeDefined();

    // The fixed fields keep their documented values.
    expect(status?.enabled).toBe(false);
    expect(status?.mode).toBe('advisory');
    expect(status?.attached).toBe(false);
    expect(typeof status?.runtimeEnabled).toBe('boolean');
    expect(status?.diagnostics).toEqual([]);

    // Counters: the KEY is absent (not `0`), so a consumer can tell the two apart.
    const presentCounters = COUNTER_KEYS.filter((key) => hasKey(status, key));
    expect(presentCounters).toEqual([]);
    for (const key of COUNTER_KEYS) {
      expect(status?.[key]).toBeUndefined();
    }

    // Absence survives serialization; a fabricated 0 would not.
    const roundTripped = JSON.parse(JSON.stringify(status)) as Record<string, unknown>;
    expect(COUNTER_KEYS.filter((key) => hasKey(roundTripped, key))).toEqual([]);
    expect(Object.keys(roundTripped).sort()).toEqual([...FIXED_KEYS].sort());

    await plugin.dispose();
  });

  it('omits counters when the stats surface exists but measures nothing (empty snapshot)', async () => {
    // The probe can find `hostAdvisorStats` and still get no measurement at all;
    // that must stay ABSENT too, exactly like a missing surface.
    const plugin = createEvoHarnessPlugin({
      config: { jitrl: { hostAdvisor: GATE_ADVISOR } },
      host: {
        hostAdvisorStats: () => ({})
      } as unknown as EvoHarnessPluginOptions['host']
    });
    const status = plugin.jitrl.hostAdvisor;
    expect(status).toBeDefined();
    expect(COUNTER_KEYS.filter((key) => hasKey(status, key))).toEqual([]);
    // An injected adapter is never the hook adapter, so it is not "attached".
    expect(status?.attached).toBe(false);
    const emptyRoundTrip = JSON.parse(JSON.stringify(status)) as Record<string, unknown>;
    expect(COUNTER_KEYS.filter((key) => hasKey(emptyRoundTrip, key))).toEqual([]);

    await plugin.dispose();
  });
});

describe('measured zero: the real hook adapter reports numbers, not absence', () => {
  it('reports 0 for every counter before any dispatch (a measured zero)', async () => {
    const { plugin } = mountOnHookContext({ jitrl: { hostAdvisor: GATE_ADVISOR } });
    const status = plugin.jitrl.hostAdvisor;
    expect(status?.enabled).toBe(true);
    expect(status?.mode).toBe('gate');
    expect(status?.attached).toBe(true);
    expect(status?.runtimeEnabled).toBe(true);

    for (const key of COUNTER_KEYS) {
      expect(typeof status?.[key]).toBe('number');
      expect(status?.[key]).toBe(0);
    }
    // Exactly the fixed fields plus the seven counters: nothing else leaks in.
    expect(Object.keys(status as unknown as Record<string, unknown>).sort()).toEqual(
      [...FIXED_KEYS, ...COUNTER_KEYS].sort()
    );

    // JSON keeps a measured 0 (it must not degrade to absent).
    const roundTripped = JSON.parse(JSON.stringify(plugin.jitrl)) as {
      readonly hostAdvisor?: Record<string, unknown>;
    };
    for (const key of COUNTER_KEYS) {
      expect(roundTripped.hostAdvisor?.[key]).toBe(0);
    }

    await plugin.dispose();
  });
});

describe('increment: the status getter re-reads the live adapter on every access', () => {
  it('counts an unprovable-identity dispatch as considered + scopeUnknownSkipped', async () => {
    const { fixture, plugin } = mountOnHookContext({ jitrl: { hostAdvisor: GATE_ADVISOR } });
    const dispatch = preExecute(fixture);

    // Anonymous dispatch: it enters the eligibility decision (considered) and
    // fails closed on the D1 strict default (scopeUnknownSkipped).
    await dispatch({ name: 'bash' }, allow);
    const first = plugin.jitrl.hostAdvisor;
    expect(first?.considered).toBe(1);
    expect(first?.scopeUnknownSkipped).toBe(1);
    expect(first?.excludedByDeclaration).toBe(0);
    expect(first?.advisory).toBe(0);
    expect(first?.ask).toBe(0);
    expect(first?.noop).toBe(0);
    // The adapter ALSO books this dispatch on its own `skipped` counter
    // (src/cordis-seams/dsh-hook-host-adapter.ts:1099) because it skipped the
    // advice channel. The two counters are independent event points, so this
    // file asserts the measured behaviour; the wording of the `skipped` contract
    // line in src/types/contracts.ts ("never reached the eligibility decision")
    // does not cover the out-of-scope path and is reported as an observation.
    expect(first?.skipped).toBe(1);

    // The getter is live: a second dispatch moves the same counters again.
    await dispatch({ name: 'edit' }, allow);
    const second = plugin.jitrl.hostAdvisor;
    expect(second?.considered).toBe(2);
    expect(second?.scopeUnknownSkipped).toBe(2);

    await plugin.dispose();
  });

  it('records exactly one decision outcome for an eligible dispatch, without a skip', async () => {
    const { fixture, plugin } = mountOnHookContext({ jitrl: { hostAdvisor: GATE_ADVISOR } });
    // A trusted host-session scope (ADR 0001 section 2.5) is what makes a
    // dispatch eligible: the same registration the P5 wiring tests use.
    plugin.scopeRegistry?.register({
      sessionId: 'sess-status',
      branchId: 'br-status',
      role: 'domain',
      guidance: 'memory',
      allowAdvice: true
    });
    const dispatch = preExecute(fixture);
    const before = plugin.jitrl.hostAdvisor;

    await dispatch({ name: 'bash', sessionId: 'sess-status', branchId: 'br-status' }, allow);
    const after = plugin.jitrl.hostAdvisor;
    expect(after?.considered).toBe((before?.considered ?? 0) + 1);
    expect(after?.scopeUnknownSkipped).toBe(0);
    expect(after?.excludedByDeclaration).toBe(0);
    expect(after?.skipped).toBe(0);
    // Exactly one outcome counter moved. WHICH one is the advisor's policy and is
    // already covered by the P5 wiring tests, so this asserts the total instead
    // of pinning a policy value.
    const outcomes = (status: typeof after): number =>
      (status?.advisory ?? 0) + (status?.ask ?? 0) + (status?.noop ?? 0);
    expect(outcomes(after)).toBe(outcomes(before) + 1);

    await plugin.dispose();
  });

  it('counts a runtime-gated dispatch as skipped only, never as a new eligibility decision', async () => {
    const { fixture, plugin } = mountOnHookContext({ jitrl: { hostAdvisor: GATE_ADVISOR } });
    const dispatch = preExecute(fixture);

    await dispatch({ name: 'bash' }, allow);
    expect(plugin.jitrl.hostAdvisor?.considered).toBe(1);
    expect(plugin.jitrl.hostAdvisor?.scopeUnknownSkipped).toBe(1);
    expect(plugin.jitrl.hostAdvisor?.skipped).toBe(1);

    // `/evo jit off` closes the L3 runtime gate the adapter reads.
    await plugin.runFromCommand('jit off');
    await dispatch({ name: 'bash' }, allow);
    const status = plugin.jitrl.hostAdvisor;
    expect(status?.runtimeEnabled).toBe(false);
    // The gate fires BEFORE the eligibility decision: skipped +1, and neither
    // `considered` nor the D1 counter moves.
    expect(status?.skipped).toBe(2);
    expect(status?.considered).toBe(1);
    expect(status?.scopeUnknownSkipped).toBe(1);

    await plugin.dispose();
  });
});

describe('payload safety of the exposed status', () => {
  it('never serializes tool arguments, payload bodies or advice text', async () => {
    const { fixture, plugin } = mountOnHookContext({ jitrl: { hostAdvisor: GATE_ADVISOR } });
    const payloadMarker = 'SECRET_TOOL_PAYLOAD_MUST_NOT_APPEAR';

    await preExecute(fixture)(
      { name: 'bash', input: { command: payloadMarker }, note: payloadMarker },
      allow
    );

    const serializedStatus = JSON.stringify(plugin.jitrl.hostAdvisor);
    expect(serializedStatus).not.toContain(payloadMarker);
    expect(serializedStatus).not.toContain('bash');
    // Only counters and the fixed fields, and the counters really moved.
    expect(Object.keys(plugin.jitrl.hostAdvisor as unknown as Record<string, unknown>).sort()).toEqual(
      [...FIXED_KEYS, ...COUNTER_KEYS].sort()
    );
    expect(plugin.jitrl.hostAdvisor?.considered).toBeGreaterThanOrEqual(1);

    await plugin.dispose();
  });
});

describe('programmatic route reasoningEffort (ADR 0005 section 3.6)', () => {
  /** A JavaScript caller: no type discipline, exactly the untrusted runtime case. */
  const asJsOptions = (route: Record<string, unknown>): EvoHarnessPluginOptions =>
    ({ route }) as unknown as EvoHarnessPluginOptions;

  it('refuses a PRESENT-but-out-of-enum effort by name instead of falling back', () => {
    for (const rejected of ['ultra', 'HIGH', 'max ', 42, true, {}]) {
      let thrown: unknown;
      try {
        createEvoHarnessPlugin(asJsOptions({ reasoningEffort: rejected }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ModelRouteEffortError);
      expect((thrown as ModelRouteEffortError).code).toBe('model-route-effort-invalid');
      expect((thrown as ModelRouteEffortError).allowed).toEqual([...MODEL_ROUTE_EFFORTS]);
    }
  });

  it('accepts every declared effort and lets it override the configured route', async () => {
    for (const effort of MODEL_ROUTE_EFFORTS) {
      const plugin = createEvoHarnessPlugin(
        asJsOptions({ provider: 'p-injected', model: 'm-injected', reasoningEffort: effort })
      );
      expect(plugin.modelRoute).toEqual({
        provider: 'p-injected',
        model: 'm-injected',
        reasoningEffort: effort
      });
      await plugin.dispose();
    }
  });

  it('treats absent-like (undefined / null / empty) as "use the route default", never an empty effort', async () => {
    for (const absent of [undefined, null, '']) {
      const plugin = createEvoHarnessPlugin(asJsOptions({ reasoningEffort: absent }));
      expect(plugin.modelRoute.reasoningEffort).toBe(MODEL_ROUTE_DEFAULTS.reasoningEffort);
      await plugin.dispose();
    }
  });

  it('uses the same named error through the host modelRoute group at the entrypoint', () => {
    // The host path is validated inside splitModelRoute (t5); this proves the
    // entrypoint surface a host actually calls fails with the same error/code.
    expect(() =>
      apply({}, { modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'ultra' } })
    ).toThrow(ModelRouteEffortError);
  });

  it('is already narrowed at the type level by t4 (nothing outstanding for this task)', () => {
    type Declared = Exclude<
      NonNullable<EvoHarnessPluginOptions['route']>['reasoningEffort'],
      undefined
    >;
    type IdenticalUnion<Left, Right> = [Left] extends [Right]
      ? ([Right] extends [Left] ? true : never)
      : never;
    // The declared type IS the dsh-bridge enum...
    const isEnum: IdenticalUnion<Declared, (typeof MODEL_ROUTE_EFFORTS)[number]> = true;
    expect(isEnum).toBe(true);
    // ...and it is NOT the previously declared `string` (compile-time proof).
    const notString: [string] extends [Declared] ? never : true = true;
    expect(notString).toBe(true);
  });
});