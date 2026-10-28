/**
 * modelRoute.reasoningEffort validation (ADR 0005 section 3.6, t5).
 *
 * Single source: the existing `MODEL_ROUTE_EFFORTS` enum in src/dsh-bridge.
 * A PRESENT-but-invalid effort is a named rejection (`model-route-effort-invalid`,
 * `ModelRouteEffortError`), never a silent fallback to the default (a silent
 * fallback is a silent config drop). An ABSENT / null / empty effort keeps the
 * documented per-field default behavior. `provider` / `model` semantics are
 * untouched (out of scope per the ADR).
 *
 * The host path is `splitModelRoute` (already wired into the entrypoint's
 * `readPluginSection`, so no src/index.ts change is needed); the programmatic
 * injection path re-consumes the SAME check via `assertModelRouteEffort`.
 */
import { describe, expect, it } from 'vitest';
import {
  ModelRouteEffortError,
  assertModelRouteEffort,
  splitModelRoute
} from '../../../src/host-triggers';
import { MODEL_ROUTE_EFFORTS } from '../../../src/dsh-bridge/model-config';
import { apply } from '../../../src/index';

function effortErrorOf(action: () => unknown): ModelRouteEffortError | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof ModelRouteEffortError ? error : undefined;
  }
  return undefined;
}

describe('single source: the existing MODEL_ROUTE_EFFORTS enum', () => {
  it('stays the verified vocabulary high | max | low', () => {
    expect([...MODEL_ROUTE_EFFORTS]).toEqual(['high', 'max', 'low']);
  });
});

describe('assertModelRouteEffort (shared runtime check)', () => {
  it('accepts every legal effort: high, max, low', () => {
    for (const effort of MODEL_ROUTE_EFFORTS) {
      expect(() => assertModelRouteEffort(effort)).not.toThrow();
    }
  });

  it('rejects the out-of-enum value ultra with the named code', () => {
    const thrown = effortErrorOf(() => assertModelRouteEffort('ultra'));
    expect(thrown).toBeInstanceOf(ModelRouteEffortError);
    expect(thrown?.code).toBe('model-route-effort-invalid');
    expect(thrown?.name).toBe('ModelRouteEffortError');
    expect(thrown?.value).toBe('ultra');
    expect(thrown?.allowed).toEqual(['high', 'max', 'low']);
    // the message names the value and the enum, and stays one short line
    expect(thrown?.message).toContain('ultra');
    expect(thrown?.message).toContain('high, max, low');
  });

  it('rejects every other out-of-enum string, including case variants', () => {
    for (const bad of ['MAX', 'High', 'medium', '', 'max ', 'max\u00a0', 'LOW']) {
      // '' falls through to the documented default (absent-like); the rest reject
      if (bad === '') {
        expect(() => assertModelRouteEffort(bad)).not.toThrow();
        continue;
      }
      const thrown = effortErrorOf(() => assertModelRouteEffort(bad));
      expect(thrown?.code, 'expected rejection for ' + JSON.stringify(bad)).toBe(
        'model-route-effort-invalid'
      );
    }
  });

  it('treats absent-like values (undefined/null/empty) as the documented default, not an error', () => {
    expect(() => assertModelRouteEffort(undefined)).not.toThrow();
    expect(() => assertModelRouteEffort(null)).not.toThrow();
    expect(() => assertModelRouteEffort('')).not.toThrow();
  });

  it('rejects a present-but-non-string value instead of silently defaulting it', () => {
    for (const bad of [7, true, { effort: 'max' }, ['max']]) {
      const thrown = effortErrorOf(() => assertModelRouteEffort(bad));
      expect(thrown?.code).toBe('model-route-effort-invalid');
      // the raw value is never JSON-rendered into the message (no {"effort":...},
      // no ["max"]); objects report a bounded placeholder instead
      expect(thrown?.message).not.toContain('{"effort"');
      expect(thrown?.message).not.toContain('["max"]');
      expect(typeof thrown?.value).toBe('string');
    }
  });
});

describe('host config path: splitModelRoute enforces the effort enum', () => {
  it('keeps legal efforts verbatim (high / max / low round-trip)', () => {
    for (const effort of MODEL_ROUTE_EFFORTS) {
      const split = splitModelRoute({
        triggerMode: 'always',
        modelRoute: { provider: 'p', model: 'm', reasoningEffort: effort }
      });
      expect(split.modelRoute).toEqual({ provider: 'p', model: 'm', reasoningEffort: effort });
      expect(split.config).toEqual({ triggerMode: 'always' });
    }
  });

  it('throws model-route-effort-invalid for an out-of-enum effort instead of silently defaulting', () => {
    const thrown = effortErrorOf(() =>
      splitModelRoute({
        triggerMode: 'always',
        modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'ultra' }
      })
    );
    expect(thrown).toBeInstanceOf(ModelRouteEffortError);
    expect(thrown?.code).toBe('model-route-effort-invalid');
    expect(thrown?.value).toBe('ultra');
    expect(thrown?.allowed).toEqual([...MODEL_ROUTE_EFFORTS]);
  });

  it('keeps the documented behavior when the effort key is absent (default stays a default)', () => {
    const split = splitModelRoute({ modelRoute: { provider: 'p', model: 'm' } });
    expect(split.modelRoute).toEqual({ provider: 'p', model: 'm' });
    // no modelRoute at all: unchanged
    expect(splitModelRoute({ triggerMode: 'always' }).config).toEqual({ triggerMode: 'always' });
    expect(splitModelRoute({ triggerMode: 'always' }).modelRoute).toBeUndefined();
  });

  it('still validates through schemastery volatile references (unwrapped first)', () => {
    const split = splitModelRoute({
      modelRoute: { provider: 'p', model: 'm', reasoningEffort: { get: () => 'max' } }
    });
    expect(split.modelRoute).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' });

    const thrown = effortErrorOf(() =>
      splitModelRoute({
        modelRoute: { provider: 'p', model: 'm', reasoningEffort: { get: () => 'ultra' } }
      })
    );
    expect(thrown?.code).toBe('model-route-effort-invalid');
  });
});

describe('entrypoint path (no src/index.ts change): apply() surfaces the named rejection', () => {
  it('apply({}, {modelRoute:{...reasoningEffort:"ultra"}}) throws ModelRouteEffortError', () => {
    // C-11's "accepted and forwarded" era ends here (ADR 0005 section 3.6)
    const thrown = effortErrorOf(() =>
      apply({}, { modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'ultra' } })
    );
    expect(thrown).toBeInstanceOf(ModelRouteEffortError);
    expect(thrown?.code).toBe('model-route-effort-invalid');
  });

  it('apply() with ctx.config carrying an out-of-enum effort also rejects', () => {
    const thrown = effortErrorOf(() =>
      apply(
        { config: { modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'ultra' } } },
        undefined
      )
    );
    expect(thrown?.code).toBe('model-route-effort-invalid');
  });

  it('apply() keeps mounting with a legal effort (regression: high / max / low unchanged)', () => {
    for (const effort of MODEL_ROUTE_EFFORTS) {
      const plugin = apply({}, { modelRoute: { provider: 'p', model: 'm', reasoningEffort: effort } });
      expect(plugin.modelRoute).toEqual({ provider: 'p', model: 'm', reasoningEffort: effort });
    }
  });

  it('apply() keeps the absent-effort default route (regression: no silent drop introduced)', () => {
    const plugin = apply({}, { modelRoute: { provider: 'p', model: 'm' } });
    expect(plugin.modelRoute.provider).toBe('p');
    expect(plugin.modelRoute.model).toBe('m');
    expect(plugin.modelRoute.reasoningEffort).toBe('max'); // MODEL_ROUTE_DEFAULTS
  });

  it('provider/model semantics are untouched (out-of-scope per the ADR)', () => {
    // empty provider/model still fall back to the verified defaults
    const plugin = apply({}, { modelRoute: { provider: '', model: '' } });
    expect(plugin.modelRoute.provider).toBe('qodercn');
    expect(plugin.modelRoute.model).toBe('dfmodel');
  });
});
