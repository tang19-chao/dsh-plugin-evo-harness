/**
 * rev5 P1-2: per-surface status (surfaceStatusSnapshot + handle.surfaces) and
 * the hook adapter's per-surface mount records that feed it.
 *
 * Contract under test:
 *   - one entry per HARNESS_COMPONENT_KEYS, always, in key order;
 *   - `enabled` is config truth, `mountable` is adapter truth, and the two are
 *     never conflated;
 *   - observed mount facts follow collect-or-omit: no attempt => NO
 *     `lastMountResult` key, and `seamUnavailable` only on adapters that keep
 *     records (a fabricated 0 would hide "never measured");
 *   - `cacheRead` is always 'unknown' because there is no measurement point;
 *   - a refused mount is counted with its stable code (`seam_unavailable`),
 *     and the original error object reaches the caller unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createDshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import { SURFACE_HOST_METHOD } from '../../../src/cordis-seams/eight-surfaces';
import { createInMemoryCordisHost } from '../../../src/cordis-seams';
import { HARNESS_COMPONENT_KEYS, type HarnessComponentKey } from '../../../src/types/contracts';
import { createEvoHarnessPlugin, surfaceStatusSnapshot } from '../../../src/index';
import {
  renderSurfaceStatusSnapshot,
  validateSurfaceStatusSnapshot,
  type SurfaceStatusEntry
} from './surface-matrix';
import { createHookFixture } from '../../unit/cordis-seams/hook-fixtures';

function memoryScopeSpec(surfaceId: string) {
  return {
    surfaceId,
    branchId: 'branch-snapshot',
    sessionId: 'session-snapshot',
    namespace: 'harness2',
    scopedViewId: 'view-1',
    workingNotes: [],
    recallTags: []
  };
}

function toolGuidanceSpec(surfaceId: string) {
  return {
    surfaceId,
    branchId: 'branch-snapshot',
    sessionId: 'session-snapshot',
    namespace: 'harness2',
    descriptions: { hostsmoke_probe: 'probe tool (snapshot)' }
  };
}

describe('surfaceStatusSnapshot', () => {
  it('reports all eight faces with no observed mount facts before an adapter exists', () => {
    const snapshot = surfaceStatusSnapshot({ enabledSurfaces: ['skills', 'memory'] }, undefined);
    expect(snapshot.map((entry) => entry.surface)).toEqual([...HARNESS_COMPONENT_KEYS]);
    const skills = snapshot.find((entry) => entry.surface === 'skills');
    const plugins = snapshot.find((entry) => entry.surface === 'plugins');
    expect(skills?.enabled).toBe(true);
    expect(plugins?.enabled).toBe(false);
    expect(snapshot.every((entry) => entry.mountable === false)).toBe(true);
    expect(snapshot.every((entry) => 'lastMountResult' in entry)).toBe(false);
    expect(snapshot.every((entry) => 'seamUnavailable' in entry)).toBe(false);
    expect(snapshot.every((entry) => entry.cacheRead === 'unknown')).toBe(true);
  });

  it('reports the in-memory reference adapter as fully mountable but unobserved', () => {
    const snapshot = surfaceStatusSnapshot({ enabledSurfaces: [...HARNESS_COMPONENT_KEYS] }, createInMemoryCordisHost());
    expect(snapshot.every((entry) => entry.mountable === true)).toBe(true);
    // The in-memory adapter keeps no per-surface records: omit, never fake 0.
    expect(snapshot.every((entry) => 'lastMountResult' in entry)).toBe(false);
    expect(snapshot.every((entry) => 'seamUnavailable' in entry)).toBe(false);
  });

  it('keeps config truth and adapter truth separate for the hook adapter', () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx, {});
    // enabled asks for all eight; the bare hook adapter only exposes three.
    const snapshot = surfaceStatusSnapshot({ enabledSurfaces: [...HARNESS_COMPONENT_KEYS] }, adapter);
    const native = snapshot.filter((entry) => entry.mountable);
    expect(native.map((entry) => entry.surface).sort()).toEqual(['guardrails', 'plugins', 'system_prompt']);
    // Every non-mountable face is still reported, not dropped.
    expect(snapshot.filter((entry) => !entry.mountable)).toHaveLength(5);
    expect(snapshot.every((entry) => 'lastMountResult' in entry)).toBe(false);
  });
});

describe('hook adapter per-surface mount records', () => {
  it('records successful forwarded mounts and omits unattempted faces', async () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx, { fallback: createInMemoryCordisHost() });
    await adapter.registerMemoryScope!(memoryScopeSpec('snapshot/memory-1'));
    await adapter.patchToolGuidance!(toolGuidanceSpec('snapshot/guidance-1'));

    const stats = adapter.stats();
    expect(stats.surfaceMounts.map((entry) => entry.surface)).toEqual([...HARNESS_COMPONENT_KEYS]);
    const memory = stats.surfaceMounts.find((entry) => entry.surface === 'memory');
    expect(memory?.attempts).toBe(1);
    expect(memory?.ok).toBe(1);
    expect(memory?.failed).toBe(0);
    expect(memory?.seamUnavailable).toBe(0);
    expect(memory?.lastResult).toEqual({ ok: true });

    const snapshot = surfaceStatusSnapshot({ enabledSurfaces: [...HARNESS_COMPONENT_KEYS] }, adapter);
    const memoryStatus = snapshot.find((entry) => entry.surface === 'memory');
    const guidanceStatus = snapshot.find((entry) => entry.surface === 'tool_guidance');
    const skillsStatus = snapshot.find((entry) => entry.surface === 'skills');
    expect(memoryStatus?.lastMountResult).toEqual({ ok: true });
    expect(memoryStatus?.seamUnavailable).toBe(0);
    expect(guidanceStatus?.lastMountResult).toEqual({ ok: true });
    // Unattempted faces stay unobserved even on a record-keeping adapter.
    expect(skillsStatus && 'lastMountResult' in skillsStatus).toBe(false);
  });

  it('counts a seam_unavailable refusal and keeps it visible next to mountable', async () => {
    // A hook adapter whose host refuses ONE hook event: the method exists
    // (mountable) but the attempt is refused with the structured code. This is
    // exactly the enabled+mountable-but-broken state lastMountResult exists to
    // expose.
    const refusingCtx = {
      on: (event: string): (() => void) => {
        if (event === 'system-prompt/assemble') {
          throw new Error('the host refused this hook event');
        }
        return () => {};
      }
    };
    const adapter = createDshHookHostAdapter(refusingCtx, {});
    await expect(adapter.registerPromptSegment!({
      surfaceId: 'snapshot/prompt-1',
      branchId: 'branch-snapshot',
      sessionId: 'session-snapshot',
      namespace: 'harness2',
      segment: 'snapshot',
      mode: 'append',
      content: 'snapshot content'
    })).rejects.toMatchObject({ code: 'seam_unavailable' });

    const snapshot = surfaceStatusSnapshot({ enabledSurfaces: [...HARNESS_COMPONENT_KEYS] }, adapter);
    const prompt = snapshot.find((entry) => entry.surface === 'system_prompt');
    expect(prompt?.mountable).toBe(true);
    expect(prompt?.lastMountResult).toEqual({ ok: false, code: 'seam_unavailable' });
    expect(prompt?.seamUnavailable).toBe(1);
    // A refusal on one surface must not invent records for the others.
    expect(snapshot.filter((entry) => 'lastMountResult' in entry)).toHaveLength(1);
  });

  it('rethrows the original error and records a non-seam failure as surface_mount_failed', async () => {
    const fixture = createHookFixture();
    const original = new Error('host memory view exploded');
    const failingFallback = createInMemoryCordisHost();
    const poisoned = failingFallback as unknown as Record<string, unknown>;
    poisoned['registerMemoryScope'] = async () => {
      throw original;
    };
    const adapter = createDshHookHostAdapter(fixture.ctx, { fallback: failingFallback });
    await expect(adapter.registerMemoryScope!(memoryScopeSpec('snapshot/memory-2'))).rejects.toBe(original);

    const snapshot = surfaceStatusSnapshot({ enabledSurfaces: [...HARNESS_COMPONENT_KEYS] }, adapter);
    const memory = snapshot.find((entry) => entry.surface === 'memory');
    expect(memory?.lastMountResult).toEqual({ ok: false, code: 'surface_mount_failed' });
    expect(memory?.seamUnavailable).toBe(0);
  });

  it('maps every surface to its host method in the stats records', () => {
    const fixture = createHookFixture();
    const adapter = createDshHookHostAdapter(fixture.ctx, { fallback: createInMemoryCordisHost() });
    for (const entry of adapter.stats().surfaceMounts) {
      expect(entry.hostMethod).toBe(String(SURFACE_HOST_METHOD[entry.surface as HarnessComponentKey]));
      expect(entry.attempts).toBe(0);
    }
  });
});

describe('plugin handle surfaces', () => {
  it('exposes eight mountable faces over the in-memory host', () => {
    const plugin = createEvoHarnessPlugin({ config: { logging: { level: 'silent' } } });
    const surfaces = plugin.surfaces;
    expect(surfaces).toHaveLength(8);
    expect(surfaces.map((entry) => entry.surface)).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(surfaces.every((entry) => entry.mountable)).toBe(true);
    expect(surfaces.every((entry) => entry.enabled)).toBe(true);
    expect(surfaces.every((entry) => entry.cacheRead === 'unknown')).toBe(true);
    expect(surfaces.every((entry) => !('lastMountResult' in entry))).toBe(true);
  });
});

describe('status rendering and validation (report layer)', () => {
  const healthy: SurfaceStatusEntry[] = HARNESS_COMPONENT_KEYS.map((surface) => ({
    surface,
    enabled: true,
    mountable: true,
    cacheRead: 'unknown'
  }));

  it('renders one row per surface with an unmeasured cell, never a fabricated 0', () => {
    const rendered = renderSurfaceStatusSnapshot(healthy);
    expect(rendered).toContain('## 插件只读状态聚合（P1-2 / A-t10-2）');
    expect(rendered).toContain('未观测');
    expect(rendered).toContain('`unknown`');
    expect(rendered).toContain('mountable=8');
    expect(rendered).toContain('有挂载记录=0 / 8');
  });

  it('renders an observed refusal with its code', () => {
    const rendered = renderSurfaceStatusSnapshot(
      healthy.map((entry) =>
        entry.surface === 'skills'
          ? { ...entry, mountable: false, lastMountResult: { ok: false, code: 'seam_unavailable' }, seamUnavailable: 2 }
          : entry
      )
    );
    expect(rendered).toContain('failed:seam_unavailable');
  });

  it('rejects a snapshot that fabricates a cacheRead value', () => {
    const problems = validateSurfaceStatusSnapshot(
      healthy.map((entry) => (entry.surface === 'memory' ? { ...entry, cacheRead: '0.42' as 'unknown' } : entry))
    );
    expect(problems.join('; ')).toContain('no read cache is measured in this process');
  });

  it('rejects a contradiction: a successful mount on a non-mountable face', () => {
    const problems = validateSurfaceStatusSnapshot(
      healthy.map((entry) =>
        entry.surface === 'skills'
          ? { ...entry, mountable: false, lastMountResult: { ok: true } as { ok: boolean } }
          : entry
      )
    );
    expect(problems.join('; ')).toContain('reports a successful mount while not mountable');
  });

  it('rejects a seam_unavailable count without a mount result', () => {
    const problems = validateSurfaceStatusSnapshot(
      healthy.map((entry) => (entry.surface === 'memory' ? { ...entry, seamUnavailable: 3 } : entry))
    );
    expect(problems.join('; ')).toContain('counts seam_unavailable without a last mount result');
  });

  it('rejects a dropped face', () => {
    expect(validateSurfaceStatusSnapshot(healthy.slice(0, 7)).join('; ')).toContain('must cover 8 surfaces');
  });
});
