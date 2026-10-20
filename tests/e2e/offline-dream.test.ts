import { describe, expect, it } from 'vitest';
import { buildE2E } from './fixtures';

describe('offline dream trigger', () => {
  it('runs the zero-execution replay once the cadence is reached', async () => {
    const { plugin, runner } = buildE2E({ dreamEveryNTasks: 1 });
    const task = plugin.makeTask({ id: 'task-dream-1', prompt: 'Fix the failing build.' });

    const result = await plugin.run({ sessionId: 'sess-dream', task, trigger: 'always' });

    expect(result.outcome).toBe('composed');
    expect(result.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);

    const report = plugin.orchestrator.dreamReports()[0];
    expect(report).toBeDefined();
    expect(report?.replayedTreeIds.length).toBeGreaterThanOrEqual(1);
    expect(report?.rhoPreferences).toEqual([0, 0.5, 1]);
    expect(report?.baseline.policyId).toBe('pi-0');
    expect(plugin.orchestrator.runCount).toBe(1);

    // the dream replays history without executing a single extra probe
    const probesBeforeDream = runner.calls.length;
    expect(probesBeforeDream).toBeGreaterThanOrEqual(2);

    const trace = plugin.orchestrator.lastTrace();
    expect(trace).toContain('offline_dream');
    expect(trace.indexOf('offline_dream')).toBeGreaterThan(trace.indexOf('commit'));
    expect(trace.indexOf('offline_dream')).toBeGreaterThan(trace.indexOf('apply_patch'));
    expect(trace.indexOf('finalize')).toBeGreaterThan(trace.indexOf('offline_dream'));
    expect(result.diagnostics.join(' ')).toContain('offline dream');
  });

  it('respects the configured cadence across runs', async () => {
    const { plugin } = buildE2E({ dreamEveryNTasks: 2 });
    const task = plugin.makeTask({ id: 'task-dream-2', prompt: 'Fix the failing build.' });

    const first = await plugin.run({ sessionId: 'sess-cadence', task, trigger: 'always' });
    expect(first.metadata?.dreamTriggered).toBe(false);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(0);
    expect(plugin.orchestrator.lastTrace()).not.toContain('offline_dream');

    const second = await plugin.run({ sessionId: 'sess-cadence', task, trigger: 'always' });
    expect(second.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);
    expect(plugin.orchestrator.runCount).toBe(2);
    expect(plugin.orchestrator.treePool.size()).toBe(2);
  });

  it('accumulates one tree per run in the replay pool', async () => {
    const { plugin } = buildE2E({ dreamEveryNTasks: 100 });
    const task = plugin.makeTask({ id: 'task-dream-3', prompt: 'Fix the failing build.' });

    await plugin.run({ sessionId: 'sess-pool', task, trigger: 'always' });
    await plugin.run({ sessionId: 'sess-pool', task, trigger: 'always' });

    const trees = plugin.orchestrator.treePool.list();
    expect(trees).toHaveLength(2);
    expect(trees.every((tree) => tree.completed)).toBe(true);
    expect(trees.every((tree) => Object.keys(tree.nodes).length >= 2)).toBe(true);
  });
});
