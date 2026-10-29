/**
 * R-01 contract test — the L3 host-advisor status shape is owned by the
 * entrypoint, not by the adapter (ADR 0005 section 3.7; t13 O2).
 *
 * Two independent invariants live here, and they are the two sides of the same
 * defect:
 *   1. WHITELIST: an adapter that returns extra fields (a tool name, a payload
 *      echo, a future private counter) must not leak them into the public
 *      `counters` block of `mapHostAdvisorStatus`, nor into
 *      `plugin.jitrl.hostAdvisor`. The public status shape is exactly the five
 *      fixed fields plus the seven public counters.
 *   2. ZERO PRESERVATION: a measured `0` is a measurement, not "absent" and not
 *      falsy-to-be-dropped — all seven counters must survive as `0`. A
 *      non-numeric value is NOT a measurement and must stay absent rather than
 *      being coerced to `0` (F-15).
 *
 * Nothing here mocks the mapping rule: every assertion drives the real exported
 * `mapHostAdvisorStatus` / `hostAdvisorJitStatus` / `createEvoHarnessPlugin`
 * surface, so a regression in `src/host-triggers.ts` or `src/index.ts` cannot
 * pass by construction.
 */
import { describe, expect, it } from 'vitest';
import {
  HOST_ADVISOR_COUNTER_KEYS,
  mapHostAdvisorStatus
} from '../../../src/host-triggers';
import { createEvoHarnessPlugin, hostAdvisorJitStatus } from '../../../src/index';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import type { EvoHarnessConfig } from '../../../src/config';
import type { HostAdvisorObservabilityCounters } from '../../../src/types/contracts';

/**
 * The frozen defaults are declared with readonly members; the status mapping
 * only READS the config, so the read-only view is the honest input type.
 */
const READ_ONLY_CONFIG = DEFAULT_EVO_HARNESS_CONFIG as unknown as EvoHarnessConfig;

/** The seven public counters, pinned literally so a silent re-ordering is visible. */
const EXPECTED_COUNTER_KEYS = [
  'advisory',
  'ask',
  'noop',
  'skipped',
  'scopeUnknownSkipped',
  'considered',
  'excludedByDeclaration'
] as const;

/** The fixed (always present) status fields next to the counters. */
const FIXED_KEYS = ['enabled', 'mode', 'attached', 'runtimeEnabled', 'diagnostics'] as const;

const FIXED_INPUT = {
  enabled: true,
  mode: 'gate' as const,
  attached: true,
  runtimeEnabled: true,
  diagnostics: ['payload-free note']
};

/**
 * An adapter snapshot that is hostile on purpose: the seven real counters plus
 * three fields that must never reach the public status.
 */
const CANARY = 'CANARY-ADAPTER-EXTRA';
const LEAKY_STATS = {
  advisory: 1,
  ask: 2,
  noop: 3,
  skipped: 4,
  scopeUnknownSkipped: 5,
  considered: 6,
  excludedByDeclaration: 7,
  toolName: CANARY,
  payloadEcho: CANARY,
  privateCounter: 42
} as unknown as HostAdvisorObservabilityCounters;

function hasKey(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

describe('HOST_ADVISOR_COUNTER_KEYS: the public counter whitelist (R-01)', () => {
  it('is exactly the seven documented counters, in the documented order', () => {
    expect([...HOST_ADVISOR_COUNTER_KEYS]).toEqual([...EXPECTED_COUNTER_KEYS]);
    expect(new Set(HOST_ADVISOR_COUNTER_KEYS).size).toBe(7);
  });

  it('matches the public contract keys at run time (the compile-time witness lives in src)', () => {
    // The authoritative both-directions check is the
    // `_COUNTER_KEYS_EXHAUSTIVE` / `_COUNTER_KEYS_FOREIGN` / `_COUNTER_KEYS_COUNT`
    // witness in src/host-triggers.ts; this run-time pass makes the same fact
    // visible without reading the source.
    const snapshot: Required<HostAdvisorObservabilityCounters> = {
      advisory: 0,
      ask: 0,
      noop: 0,
      skipped: 0,
      scopeUnknownSkipped: 0,
      considered: 0,
      excludedByDeclaration: 0
    };
    expect(Object.keys(snapshot).sort()).toEqual([...HOST_ADVISOR_COUNTER_KEYS].sort());
  });
});

describe('whitelist: extra adapter fields never reach the public counters (R-01)', () => {
  it('drops every extra field from mapHostAdvisorStatus counters (canary injection)', () => {
    const mapping = mapHostAdvisorStatus(FIXED_INPUT, LEAKY_STATS);
    const counterKeys = Object.keys(mapping.counters).sort();
    expect(counterKeys).toEqual([...EXPECTED_COUNTER_KEYS].sort());
    for (const canaryKey of ['toolName', 'payloadEcho', 'privateCounter']) {
      expect(hasKey(mapping.counters, canaryKey)).toBe(false);
    }
    // The serialized status must not carry the canary text anywhere.
    expect(JSON.stringify(mapping)).not.toContain(CANARY);
  });

  it('drops the canary at the entrypoint status surface too (hostAdvisorJitStatus)', () => {
    const status = hostAdvisorJitStatus({
      config: READ_ONLY_CONFIG,
      attached: true,
      counters: LEAKY_STATS
    });
    expect(Object.keys(status).sort()).toEqual([...FIXED_KEYS, ...EXPECTED_COUNTER_KEYS].sort());
    expect(JSON.stringify(status)).not.toContain(CANARY);
    // …and the real counters still arrive.
    expect(status.considered).toBe(6);
    expect(status.excludedByDeclaration).toBe(7);
  });

  it('drops the canary through a mounted plugin fed by a structural adapter', async () => {
    // Exactly the shape the entrypoint probes for: a `hostAdvisorStats` method
    // on the injected host. A structural adapter can return anything, which is
    // why the entrypoint - not the adapter - must own the public shape.
    const plugin = createEvoHarnessPlugin({
      config: {
        jitrl: {
          hostAdvisor: {
            enabled: true,
            mode: 'gate',
            adviseThreshold: -0.5,
            gateThreshold: -0.8,
            minSupport: 1
          }
        }
      },
      host: {
        hostAdvisorStats: () => ({ ...LEAKY_STATS, toolName: CANARY })
      } as unknown as NonNullable<Parameters<typeof createEvoHarnessPlugin>[0]>['host']
    });
    const status = plugin.jitrl.hostAdvisor;
    expect(status).toBeDefined();
    expect(Object.keys(status as unknown as Record<string, unknown>).sort()).toEqual(
      [...FIXED_KEYS, ...EXPECTED_COUNTER_KEYS].sort()
    );
    expect(JSON.stringify(status)).not.toContain(CANARY);
    // A measured number (not the 0 that a falsy guard would produce) survives.
    expect(status?.advisory).toBe(1);
    await plugin.dispose();
  });
});

describe('collect-or-omit: an uncollected source never fabricates counters (R-01 + F-15)', () => {
  it('keeps every counter ABSENT when the adapter has no stats source', () => {
    const mapping = mapHostAdvisorStatus(FIXED_INPUT);
    expect(mapping.counters).toEqual({});
    expect(Object.keys(mapping.counters)).toEqual([]);
    // …and the fixed fields are untouched.
    expect(mapping.enabled).toBe(true);
    expect(mapping.mode).toBe('gate');
    expect(mapping.diagnostics).toEqual(['payload-free note']);
  });

  it('keeps the counters ABSENT in the serialized entrypoint status', () => {
    const status = hostAdvisorJitStatus({
      config: READ_ONLY_CONFIG,
      attached: false
    });
    expect(Object.keys(status).sort()).toEqual([...FIXED_KEYS].sort());
    const roundTripped = JSON.parse(JSON.stringify(status)) as Record<string, unknown>;
    for (const key of EXPECTED_COUNTER_KEYS) {
      expect(hasKey(roundTripped, key)).toBe(false);
    }
  });
});

describe('zero preservation: a measured 0 stays 0, a non-measurement stays absent (R-01)', () => {
  it('keeps all seven measured zeros as 0 (never dropped by a falsy check)', () => {
    const zeros: Required<HostAdvisorObservabilityCounters> = {
      advisory: 0,
      ask: 0,
      noop: 0,
      skipped: 0,
      scopeUnknownSkipped: 0,
      considered: 0,
      excludedByDeclaration: 0
    };
    const mapping = mapHostAdvisorStatus(FIXED_INPUT, zeros);
    expect(Object.keys(mapping.counters).sort()).toEqual([...EXPECTED_COUNTER_KEYS].sort());
    for (const key of EXPECTED_COUNTER_KEYS) {
      expect(mapping.counters[key]).toBe(0);
    }
    // The wire shape keeps the zeros (absent would mean "not collected").
    const status = hostAdvisorJitStatus({
      config: READ_ONLY_CONFIG,
      attached: true,
      counters: zeros
    });
    for (const key of EXPECTED_COUNTER_KEYS) {
      expect(status[key]).toBe(0);
    }
    const wire = JSON.parse(JSON.stringify(status)) as Record<string, unknown>;
    for (const key of EXPECTED_COUNTER_KEYS) {
      expect(wire[key]).toBe(0);
    }
  });

  it('omits a present-but-non-numeric counter instead of coercing it to 0', () => {
    const malformed = {
      advisory: '1',
      ask: Number.NaN,
      noop: Number.POSITIVE_INFINITY,
      skipped: null,
      scopeUnknownSkipped: 0,
      considered: undefined,
      excludedByDeclaration: 7
    } as unknown as HostAdvisorObservabilityCounters;
    const mapping = mapHostAdvisorStatus(FIXED_INPUT, malformed);
    // Only the two real measurements survive; the rest is absent, never 0.
    expect(Object.keys(mapping.counters).sort()).toEqual(['excludedByDeclaration', 'scopeUnknownSkipped']);
    expect(mapping.counters.scopeUnknownSkipped).toBe(0);
    for (const absent of ['advisory', 'ask', 'noop', 'skipped', 'considered']) {
      expect(hasKey(mapping.counters, absent)).toBe(false);
    }
  });
});