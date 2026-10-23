/**
 * P3-E / G2-2 integration: /evo jit routing through the real plugin.
 *
 * Verifies that 'jit ...' dispatches to the command layer without starting a
 * run, that plain '/evo' keeps its run semantics, that status exposes cacheStats
 * and recent decisions from the mounted decorator, and that disabled JitRL
 * degrades gracefully.
 */
import { describe, expect, it } from 'vitest';
import { buildE2E } from '../../e2e/fixtures';

function enabledHarness() {
  return buildE2E({ config: { jitrl: { enabled: true, levels: ['meta'] } } });
}

async function runOneTask(plugin: ReturnType<typeof buildE2E>['plugin']): Promise<void> {
  const task = plugin.makeTask({
    id: 'task-jit-commands',
    prompt: 'Fix the failing build without breaking the release train.',
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
  const result = await plugin.run({ sessionId: 'sess-commands', task, trigger: 'always' });
  expect(result.outcome).toBe('composed');
}

describe('/evo jit routing', () => {
  it('keeps plain /evo run semantics unchanged', async () => {
    const { plugin } = enabledHarness();
    const result = await plugin.runFromCommand('Fix the failing build.');
    expect(result.outcome).toBe('composed');
    expect(result.jitCommand).toBeUndefined();
  });

  it('dispatches jit commands without starting a run', async () => {
    const { plugin } = enabledHarness();
    const before = plugin.orchestrator.lastTrace();
    const result = await plugin.runFromCommand('jit status');
    expect(result.outcome).toBe('skipped');
    expect(result.probesRun).toBe(0);
    expect(result.trigger).toBe('slash_command');
    expect(result.jitCommand?.command).toBe('status');
    expect(plugin.orchestrator.lastTrace()).toEqual(before);
  });

  it('reports usage for unknown or empty subcommands without throwing', async () => {
    const { plugin } = enabledHarness();
    for (const command of ['jit', 'jit nonsense']) {
      const result = await plugin.runFromCommand(command);
      const payload = result.jitCommand;
      expect(payload).toBeDefined();
      expect(payload?.ok).toBe(false);
      expect(payload?.command).toBe('usage');
      expect(payload?.text).toContain('/evo jit');
    }
  });
});

describe('/evo jit status and explain after a run', () => {
  it('exposes cacheStats and at most ten recent decisions', async () => {
    const { plugin } = enabledHarness();
    await runOneTask(plugin);
    expect(plugin.jitrl.enabled).toBe(true);
    expect(plugin.jitrl.cacheStats).toBeDefined();
    expect(Array.isArray(plugin.jitrl.recentDecisions)).toBe(true);
    expect(plugin.jitrl.recentDecisions?.length ?? 0).toBeLessThanOrEqual(10);
    expect(plugin.jitrl.recentDecisions?.length ?? 0).toBeGreaterThan(0);

    const result = await plugin.runFromCommand('jit status');
    const command = result.jitCommand;
    expect(command?.ok).toBe(true);
    expect(command?.text).toContain('enabled: true');
    expect(command?.text).toContain('cache:');
    expect(command?.text).toContain('recentDecisions:');
    const json = command?.json as Record<string, unknown>;
    expect(json['cacheStats']).not.toBeNull();
    expect(json['recentDecisions']).toBeInstanceOf(Array);
  });

  it('renders the explain table for a recorded decision', async () => {
    const { plugin } = enabledHarness();
    await runOneTask(plugin);
    const result = await plugin.runFromCommand('jit explain decision-1');
    const command = result.jitCommand;
    expect(command?.ok).toBe(true);
    expect(command?.text).toContain('candidate');
    expect(command?.text).toContain('Base z');
    expect(command?.text).toContain('Q̂');
    expect(command?.text).toContain('Ã');
    expect(command?.text).toContain("JitRL z'");
    const rows = (command?.json as Record<string, unknown>)['rows'] as readonly unknown[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it('accepts the latest alias', async () => {
    const { plugin } = enabledHarness();
    await runOneTask(plugin);
    const result = await plugin.runFromCommand('jit explain latest');
    expect(result.jitCommand?.ok).toBe(true);
    expect(
      ((result.jitCommand?.json as Record<string, unknown>)['rows'] as readonly unknown[]).length
    ).toBeGreaterThan(0);
  });
});

describe('/evo jit reset and on/off', () => {
  it('requires --confirm before clearing all experience and then clears it', async () => {
    const { plugin } = enabledHarness();
    await runOneTask(plugin);
    const refused = await plugin.runFromCommand('jit reset');
    expect(refused.jitCommand?.ok).toBe(false);
    expect(refused.jitCommand?.text).toContain('--confirm');

    const cleared = await plugin.runFromCommand('jit reset --confirm');
    expect(cleared.jitCommand?.ok).toBe(true);
    expect(cleared.jitCommand?.text).toContain('dropped');
    expect(plugin.jitrl.storeSize).toBe(0);
    const status = await plugin.runFromCommand('jit status');
    expect(status.jitCommand?.text).toContain('storeSize: 0');
  });

  it('toggles the volatile switch without rewriting the persisted config', async () => {
    const { plugin } = enabledHarness();
    const off = await plugin.runFromCommand('jit off');
    expect(off.jitCommand?.json).toMatchObject({ enabled: false, persisted: false });
    const disabled = await plugin.runFromCommand('jit status');
    expect(disabled.jitCommand?.text).toContain('enabled: false');
    const on = await plugin.runFromCommand('jit on');
    expect(on.jitCommand?.json).toMatchObject({ enabled: true, persisted: false });
    expect(plugin.config.jitrl.enabled).toBe(true);
  });
});

describe('runtime off really bypasses the decorator (P3-E2 gap 1)', () => {
  it('off returns no jit stage, on restores it without re-mounting', async () => {
    const { plugin } = enabledHarness();
    const off = await plugin.runFromCommand('jit off');
    expect(off.jitCommand?.json).toMatchObject({ enabled: false, persisted: false });

    const taskOff = plugin.makeTask({
      id: 'task-off-run',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await plugin.run({ sessionId: 'sess-off-run', task: taskOff, trigger: 'always' });
    expect(plugin.orchestrator.lastTrace()).not.toContain('jit_meta_adjust');

    const on = await plugin.runFromCommand('jit on');
    expect(on.jitCommand?.json).toMatchObject({ enabled: true, persisted: false });
    const taskOn = plugin.makeTask({
      id: 'task-on-run',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    await plugin.run({ sessionId: 'sess-on-run', task: taskOn, trigger: 'always' });
    expect(plugin.orchestrator.lastTrace()).toContain('jit_meta_adjust');
  });
});

describe('explain reports the real candidate source (P3-E2 gap 3)', () => {
  it('renders policy_prior for the L1 slot candidates', async () => {
    const { plugin } = enabledHarness();
    await runOneTask(plugin);
    const result = await plugin.runFromCommand('jit explain decision-1');
    const rows = (result.jitCommand?.json as Record<string, unknown>)['rows'] as readonly Record<
      string,
      unknown
    >[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row['source'] === 'policy_prior')).toBe(true);
    expect(result.jitCommand?.text).toContain('policy_prior');
  });
});

describe('disabled JitRL degrades gracefully', () => {
  it('status says disabled and explain returns an empty table', async () => {
    const { plugin } = buildE2E({ config: { jitrl: { enabled: false } } });
    expect(plugin.jitrl.enabled).toBe(false);
    const status = await plugin.runFromCommand('jit status');
    expect(status.jitCommand?.ok).toBe(true);
    expect(status.jitCommand?.text).toContain('enabled: false');
    expect(status.jitCommand?.text).toContain('JitRL is disabled');

    const explain = await plugin.runFromCommand('jit explain decision-1');
    expect(explain.jitCommand?.ok).toBe(true);
    expect(explain.jitCommand?.text).toContain('no decision table is available');
    expect(
      ((explain.jitCommand?.json as Record<string, unknown>)['rows'] as readonly unknown[]).length
    ).toBe(0);
  });
});
