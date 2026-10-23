/**
 * P4 integration wiring: the Dream-RSI x JitRL dual loop through the REAL plugin
 * entrypoint (plan section 7.3, §8 Phase 4).
 *
 * The contract this file defends is "unit-green is not production-reachable": the
 * replay hook, the configured jit perturbation grid and the drift factor must all
 * be visible from `createEvoHarnessPlugin()` + `plugin.run()`, not just from
 * instantiating the dreamer or the hook directly. Every assertion below reads the
 * plugin handle's status / the orchestrator's dream report.
 */
import { describe, expect, it } from 'vitest';

import { buildE2E } from '../../e2e/fixtures';
import type { EvoHarnessPlugin } from '../../../src/index';

const FULL_GRID = {
  driftRho: 0.7,
  hyperparamPerturbation: true,
  candidateJitBetas: [0.5, 1, 2],
  candidateJitLambdas: [0.02, 0.05, 0.1]
};

function runOneDream(plugin: EvoHarnessPlugin, id: string) {
  return plugin.run({
    sessionId: 'sess-' + id,
    task: plugin.makeTask({ id, prompt: 'Fix the failing build without breaking the release train.' }),
    trigger: 'always'
  });
}

describe('P4 dual loop through the plugin entrypoint', () => {
  it('injects the replay hook and reports the perturbed candidate jit values', async () => {
    const harness = buildE2E({
      dreamEveryNTasks: 1,
      config: { jitrl: { dream: FULL_GRID } }
    });
    const plugin = harness.plugin;
    const result = await runOneDream(plugin, 'task-p4-grid');

    expect(result.metadata?.dreamTriggered).toBe(true);
    expect(plugin.orchestrator.dreamReports()).toHaveLength(1);

    const status = plugin.jitrl;
    expect(status.dream?.hookAttached).toBe(true);
    expect(status.dream?.hyperparamPerturbation).toBe(true);
    expect(status.dream?.driftRho).toBe(0.7);

    const last = status.dream?.lastReplay;
    expect(last).toBeDefined();
    // Replay really called the hook on the frontier; a wired-but-unused hook
    // would leave hookCalls at 0.
    expect(last?.hookCalls).toBeGreaterThan(0);
    expect(last?.candidates.map((candidate) => candidate.policyId)).toContain('pi-0');

    const generated = last?.candidates.filter((candidate) =>
      candidate.policyId.startsWith('pi-0::dream-')
    );
    expect((generated ?? []).length).toBeGreaterThan(0);

    // The jit grid travels with each candidate: the betas replay simulated are
    // exactly the configured perturbation grid (not the kernel defaults).
    const betas = [...new Set((last?.candidates ?? []).map((candidate) => candidate.beta))].sort(
      (left, right) => left - right
    );
    expect(betas.length).toBeGreaterThan(1);
    for (const beta of betas) {
      expect([0.5, 1, 2]).toContain(beta);
    }
    for (const candidate of last?.candidates ?? []) {
      expect([0.02, 0.05, 0.1]).toContain(candidate.lambda);
      expect(candidate.driftRho).toBe(0.7);
    }

    // The hook activity is reported through the existing offline_dream stage.
    expect((result.diagnostics ?? []).some((line) => line.startsWith('offline dream jit:'))).toBe(
      true
    );
    // ... and the status surface stays plain JSON for a host to serialise.
    expect(() => JSON.parse(JSON.stringify(status))).not.toThrow();
    await plugin.dispose();
  });

  it('honours a custom drift factor and switching perturbation off', async () => {
    const harness = buildE2E({
      dreamEveryNTasks: 1,
      config: {
        jitrl: {
          dream: {
            driftRho: 0.25,
            hyperparamPerturbation: false,
            candidateJitBetas: [0.5, 1, 2],
            candidateJitLambdas: [0.02, 0.05, 0.1]
          }
        }
      }
    });
    const plugin = harness.plugin;
    const result = await runOneDream(plugin, 'task-p4-drift');

    expect(result.metadata?.dreamTriggered).toBe(true);
    const status = plugin.jitrl;
    expect(status.dream?.driftRho).toBe(0.25);
    expect(status.dream?.hyperparamPerturbation).toBe(false);

    const candidates = status.dream?.lastReplay?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    // Perturbation off: every candidate inherits the baseline jit, which replay
    // resolves to the kernel defaults (beta 1, lambda 0.05).
    for (const candidate of candidates) {
      expect(candidate.beta).toBe(1);
      expect(candidate.lambda).toBe(0.05);
      expect(candidate.driftRho).toBe(0.25);
    }
    await plugin.dispose();
  });

  it('leaves dreaming on the plain dreamer when JitRL is switched off', async () => {
    const harness = buildE2E({
      dreamEveryNTasks: 1,
      config: { jitrl: { enabled: false } }
    });
    const plugin = harness.plugin;
    const result = await runOneDream(plugin, 'task-p4-off');

    expect(result.metadata?.dreamTriggered).toBe(true);
    expect(plugin.jitrl.enabled).toBe(false);
    expect(plugin.jitrl.dream?.hookAttached).toBe(false);
    expect(plugin.jitrl.dream?.lastReplay).toBeUndefined();
    await plugin.dispose();
  });
});
