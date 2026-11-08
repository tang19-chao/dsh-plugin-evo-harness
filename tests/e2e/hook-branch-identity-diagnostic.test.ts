/**
 * rev6 audit A5 (B7): the production diagnostic for a host that carries no
 * branchId in hook dispatches.
 *
 * The real DSH hook adapter is mounted from a structural host fixture, one
 * branchless `system-prompt/assemble` dispatch is observed, and a normal
 * shadow run completes. The plugin must then report the exact sentence, while
 * the shadow run leaves the host with zero permanent patch mounts. A second
 * case proves the guarded-active permanent mount still works (host-class mount
 * + explicit grant) - the diagnostic is measurement, not a permission change.
 */
import { describe, expect, it } from 'vitest';

import { BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE } from '../../src/cordis-seams/host-mount-diagnostics';
import { createEvoHarnessPlugin } from '../../src/index';
import { createHookFixture, emptyAssembly, type AssemblyShape } from '../unit/cordis-seams/hook-fixtures';
import {
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

function dispatchAssemble(
  fixture: ReturnType<typeof createHookFixture>,
  context: unknown = {}
): Promise<AssemblyShape> {
  const listener = fixture.listener('system-prompt/assemble');
  const next = (): Promise<AssemblyShape> => Promise.resolve(emptyAssembly());
  return Promise.resolve(listener(emptyAssembly(), context, next)) as Promise<AssemblyShape>;
}

function buildHookPlugin(options: {
  readonly execution?: { readonly mode: string; readonly applyWinningPatch: boolean };
  readonly applyWinningPatch?: boolean;
}) {
  const fixture = createHookFixture();
  const now = makeClock();
  const plugin = createEvoHarnessPlugin(
    {
      config: e2eConfig({
        dreamEveryNTasks: 100,
        ...(options.execution === undefined
          ? {}
          : { config: { execution: options.execution } })
      }),
      model: createScriptedModel(),
      clients: [mem0LikeServer().client],
      runBranch: createScriptedRunner(now),
      now,
      newId: makeIdFactory('a5-hook'),
      ...(options.applyWinningPatch === undefined
        ? {}
        : { applyWinningPatch: options.applyWinningPatch })
    },
    fixture.ctx
  );
  return { fixture, plugin };
}

describe('A5 branch-scoped hook mount diagnostic', () => {
  it('reports the exact sentence after a branchless dispatch, and shadow mounts nothing', async () => {
    const { fixture, plugin } = buildHookPlugin({});
    expect(plugin.hostAdapterSource).toBe('dsh-hooks');
    expect(plugin.diagnostics.join('\n')).not.toContain(BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE);

    await plugin.collaborators;
    // Exactly the measured rc3 shape: a dispatch with no branchId.
    await dispatchAssemble(fixture, { sessionId: 'sess-a5' });

    const result = await plugin.run({
      sessionId: 'sess-a5',
      task: plugin.makeTask({ prompt: 'Fix the failing build without breaking the release train.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');

    // Shadow: zero permanent mounts (the diagnostic does not imply a mount).
    expect(plugin.orchestrator.activePatchIds()).toEqual([]);
    const lines = plugin.diagnostics;
    expect(lines).toContain(BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE);
    // Reported once, not once per run.
    expect(lines.filter((line) => line === BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE)).toHaveLength(1);
    const summary = lines.find((line) => line.startsWith('branch-scoped hook mount observation:'));
    expect(summary).toContain('branchProofApplied=0');
    await plugin.dispose();
  });

  it('mounts on the explicit guarded-active opt-in and states there is NO verdict gate', async () => {
    const { fixture, plugin } = buildHookPlugin({
      execution: { mode: 'guarded-active', applyWinningPatch: true },
      applyWinningPatch: true
    });
    await plugin.collaborators;
    await dispatchAssemble(fixture, { sessionId: 'sess-a5-guarded' });
    const result = await plugin.run({
      sessionId: 'sess-a5-guarded',
      task: plugin.makeTask({ prompt: 'Fix the failing build without breaking the release train.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(result.composedPatchId).toBeDefined();
    expect(plugin.orchestrator.activePatchIds()).toEqual([result.composedPatchId]);
    // NO verification seam is injected by this fixture. The mount is legal
    // because mode + applyWinningPatch are explicit, and the diagnostic says so
    // instead of claiming an evidence gate that the code does not apply.
    expect(
      result.diagnostics.some((line) => line.includes('NO host-trusted verdict gate is applied'))
    ).toBe(true);
    // Even with a permanent mount, the branch-scoped diagnostic still states
    // that PROBE-style branch interception is unavailable: the mount is the
    // explicit host-class channel, not proof of branch identity.
    expect(plugin.diagnostics).toContain(BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE);
    await plugin.dispose();
  });
});