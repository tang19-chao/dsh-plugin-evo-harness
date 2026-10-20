import { describe, expect, it, vi } from 'vitest';
import { HARNESS_COMPONENT_KEYS } from '../../../src/types/contracts';
import type { HarnessComponentKey } from '../../../src/types/contracts';
import {
  CordisSeamError,
  DisposableRegistry,
  cloneAndFreezePatch,
  createInMemoryCordisHost,
  mountEightSurfaces,
  mountSurface,
  rollbackMounts,
  surfaceIdFor
} from '../../../src/cordis-seams';
import type { CordisHostAdapter, SurfaceMountContext } from '../../../src/cordis-seams';
import { makePatch, makeSparsePatch } from './fixtures';

const context: SurfaceMountContext = {
  sessionId: 'sess-1',
  branchId: 'br-1',
  namespace: 'harness2:probe_br-1',
  patchId: 'patch-1'
};

describe('mountEightSurfaces', () => {
  it('mounts every edited surface in HARNESS_COMPONENT_KEYS order through its host seam', async () => {
    const host = createInMemoryCordisHost();
    const spies: Record<string, ReturnType<typeof vi.fn>> = {
      registerPromptSegment: vi.fn(host.registerPromptSegment!.bind(host)),
      registerGuardrails: vi.fn(host.registerGuardrails!.bind(host)),
      registerMemoryScope: vi.fn(host.registerMemoryScope!.bind(host)),
      patchToolGuidance: vi.fn(host.patchToolGuidance!.bind(host)),
      mountSkills: vi.fn(host.mountSkills!.bind(host)),
      mountScripts: vi.fn(host.mountScripts!.bind(host)),
      registerSubagents: vi.fn(host.registerSubagents!.bind(host)),
      mountMiddleware: vi.fn(host.mountMiddleware!.bind(host))
    };
    const spyHost = spies as unknown as CordisHostAdapter;

    const mounted = await mountEightSurfaces(spyHost, makePatch(), context);

    expect(mounted.keys).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(mounted.skipped).toEqual([]);
    expect(mounted.handles).toHaveLength(8);
    expect(Object.keys(spies).every((name) => spies[name]?.mock.calls.length === 1)).toBe(true);
    expect(host.activeEffects(context.namespace)).toHaveLength(8);

    const surfaces = host.activeEffects(context.namespace).map((effect) => effect.surface);
    expect(surfaces).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(host.activeCount('prompt_segment')).toBe(1);
    expect(host.activeCount('guardrails')).toBe(1);
    expect(host.activeCount('memory_scope')).toBe(1);
    expect(host.activeCount('tool_guidance')).toBe(1);
    expect(host.activeCount('skills')).toBe(1);
    expect(host.activeCount('scripts')).toBe(1);
    expect(host.activeCount('subagents')).toBe(1);
    expect(host.activeCount('middleware')).toBe(1);

    const firstCall = spies.registerPromptSegment?.mock.calls[0]?.[0] as { surfaceId: string };
    expect(firstCall.surfaceId).toBe(surfaceIdFor(context, 'system_prompt'));
  });

  it('skips surfaces without an edit and reports them', async () => {
    const host = createInMemoryCordisHost();

    const mounted = await mountEightSurfaces(host, makeSparsePatch(), context);

    expect(mounted.keys).toEqual(['system_prompt', 'skills', 'plugins']);
    expect(mounted.skipped).toEqual([
      'guardrails',
      'memory',
      'tool_guidance',
      'scripts',
      'subagents'
    ]);
    expect(host.activeEffects()).toHaveLength(3);
  });

  it('honours the enabledSurfaces filter without changing mount order', async () => {
    const host = createInMemoryCordisHost();

    const mounted = await mountEightSurfaces(host, makePatch(), context, {
      enabledSurfaces: ['plugins', 'system_prompt'] satisfies HarnessComponentKey[]
    });

    expect(mounted.keys).toEqual(['system_prompt', 'plugins']);
    expect(mounted.skipped).toContain('guardrails');
  });

  it('registers mounts in a registry so one disposeAll() unwinds them all', async () => {
    const host = createInMemoryCordisHost();
    const registry = new DisposableRegistry();

    await mountEightSurfaces(host, makePatch(), context, { registry });
    expect(registry.size).toBe(8);

    const failures = await registry.disposeAll();
    expect(failures).toEqual([]);
    expect(host.activeEffects()).toEqual([]);
  });
});

describe('mountSurface guards', () => {
  it('rejects a missing edit', async () => {
    const host = createInMemoryCordisHost();
    await expect(mountSurface(host, 'skills', undefined, context)).rejects.toMatchObject({
      code: 'invalid_surface_edit',
      surface: 'skills'
    });
  });

  it('rejects a kind/key mismatch', async () => {
    const host = createInMemoryCordisHost();
    const wrong = { kind: 'skills', skills: [] } as const;
    await expect(
      mountSurface(host, 'scripts', wrong as never, context)
    ).rejects.toMatchObject({ code: 'surface_kind_mismatch', surface: 'scripts' });
  });

  it('fails loudly when the host adapter lacks the required seam', async () => {
    const host: CordisHostAdapter = {};

    await expect(mountSurface(host, 'plugins', { kind: 'plugins', middleware: [] }, context)).rejects.toMatchObject(
      { code: 'seam_unavailable', surface: 'plugins' }
    );
  });

  it('defaults the memory view id to the branch namespace', async () => {
    const host = createInMemoryCordisHost();

    await mountEightSurfaces(host, makeSparsePatch(), context);
    const memoryEffect = host
      .effectsFor(context.namespace)
      .find((effect) => effect.surface === 'system_prompt');
    expect(memoryEffect?.active).toBe(true);

    const fullMounted = await mountEightSurfaces(host, makePatch(), {
      ...context,
      namespace: 'harness2:probe_br-memory'
    });
    expect(fullMounted.keys).toContain('memory');
    const spec = host
      .effectsFor('harness2:probe_br-memory')
      .find((effect) => effect.operation === 'memory_scope')?.spec as { scopedViewId: string };
    expect(spec.scopedViewId).toBe('harness2:probe_br-memory');
  });

  it('copies spec arrays so one mount can never alias the patch edits', async () => {
    const host = createInMemoryCordisHost();
    const patch = makePatch();

    await mountEightSurfaces(host, patch, context);

    const skillsSpec = host
      .effectsFor(context.namespace)
      .find((effect) => effect.operation === 'skills')?.spec as { skills: readonly unknown[] };
    expect(skillsSpec.skills).not.toBe(patch.edits.skills?.skills);
    expect(skillsSpec.skills[0]).toBe(patch.edits.skills?.skills[0]);

    const frozen = cloneAndFreezePatch(patch, 'br-frozen');
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.edits)).toBe(true);
    expect(Object.isFrozen(frozen.edits.skills?.skills)).toBe(true);
  });
});

describe('rollback', () => {
  it('rolls back everything already mounted when a later surface fails', async () => {
    const host = createInMemoryCordisHost();
    host.failNext('skills', 1, new Error('skill mount exploded'));

    let caught: unknown;
    try {
      await mountEightSurfaces(host, makePatch(), context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CordisSeamError);
    expect((caught as CordisSeamError).code).toBe('surface_mount_failed');
    expect((caught as CordisSeamError).surface).toBe('skills');
    expect(host.activeEffects()).toEqual([]);
    expect(host.callCount('skills')).toBe(1);
    expect(host.callCount('scripts')).toBe(0);
  });

  it('disposes handles in reverse order and reports failures', async () => {
    const order: string[] = [];
    const handles = [
      { surface: 'system_prompt', surfaceId: 'a', label: 'a', active: true, dispose: async () => { order.push('a'); } },
      { surface: 'guardrails', surfaceId: 'b', label: 'b', active: true, dispose: async () => { order.push('b'); } },
      {
        surface: 'memory',
        surfaceId: 'c',
        label: 'c',
        active: true,
        dispose: async () => {
          throw new Error('rollback failed');
        }
      }
    ] as unknown as Parameters<typeof rollbackMounts>[0];

    const failures = await rollbackMounts(handles);

    expect(order).toEqual(['b', 'a']);
    expect(failures.map((failure) => failure.label)).toEqual(['c']);
  });
});
