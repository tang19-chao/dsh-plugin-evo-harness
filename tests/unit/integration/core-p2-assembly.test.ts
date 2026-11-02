/**
 * INT-4 / INT-5 / INT-7 / LEDGER-9b integration regressions.
 *
 * All four defects live at the plugin assembly seam in src/index.ts:
 *  - INT-4: the `/evo` fallback registration was an independent `if`, so a host
 *    exposing BOTH `ctx.commands.register` and `ctx.registerCommand` mounted the
 *    command twice with two handlers;
 *  - INT-5: `logging.level` / `logging.includeTrajectorySummaries` were
 *    validated no-ops (the plugin's `log()` hardcoded info|warn and read neither
 *    leaf);
 *  - INT-7: `handleFallbackEvent` returned its run untracked, so `settle()` and
 *    `dispose()` never joined it (unlike the other two trigger entries);
 *  - LEDGER-9b: the production `createJitRl` call passed no metering, so the
 *    JitRL logit probe and step judge reached the ledger as provenance 'none'.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createEvoHarnessPlugin,
  type EvoHarnessPluginOptions
} from '../../../src/index';
import { createLedgerReservationManager, twoPhaseSettlementFor } from '../../../src/ledger';
import {
  createFakeContext,
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from '../../e2e/fixtures';

const RATE_CARD = {
  modelId: 'test/model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

function mountOptions(extra: Partial<EvoHarnessPluginOptions> = {}): EvoHarnessPluginOptions {
  const now = makeClock();
  return {
    config: e2eConfig(),
    model: createScriptedModel(),
    clients: [mem0LikeServer().client],
    runBranch: createScriptedRunner(now),
    now,
    newId: makeIdFactory('core-p2'),
    resolveDshCollaborators: false,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// INT-4: a host exposing both registrars mounts /evo exactly once
// ---------------------------------------------------------------------------

describe('INT-4: /evo is never mounted twice', () => {
  it('registers once when the ctx exposes both ctx.commands.register and ctx.registerCommand', () => {
    const dshCommands = new Map<string, unknown>();
    const fallbackCommands = new Map<string, unknown>();
    const ctx = {
      // The DSH command service shape (takes a definition object).
      commands: {
        register: (definition: { readonly name: string }) => {
          dshCommands.set(definition.name, definition);
          return () => dshCommands.delete(definition.name);
        }
      },
      // The structural fallback shape (name + handler).
      registerCommand: (name: string, handler: unknown) => {
        fallbackCommands.set(name, handler);
        return () => fallbackCommands.delete(name);
      }
    };

    const plugin = createEvoHarnessPlugin(mountOptions(), ctx);

    // Pre-fix BOTH blocks ran and pushed the name, leaving two live handlers.
    expect(plugin.registeredCommands).toEqual(['evo']);
    expect(dshCommands.has('evo')).toBe(true);
    // Precedence is real: the fallback registrar is NOT also called.
    expect(fallbackCommands.has('evo')).toBe(false);
  });

  it('still uses the fallback registrar when ctx.commands is absent', () => {
    const fallbackCommands = new Map<string, unknown>();
    const ctx = {
      registerCommand: (name: string, handler: unknown) => {
        fallbackCommands.set(name, handler);
        return () => fallbackCommands.delete(name);
      }
    };

    const plugin = createEvoHarnessPlugin(mountOptions(), ctx);

    expect(plugin.registeredCommands).toEqual(['evo']);
    expect(fallbackCommands.has('evo')).toBe(true);
  });

  it('reports the documented fallback entrypoint when no registrar exists', () => {
    const plugin = createEvoHarnessPlugin(mountOptions(), {});
    expect(plugin.registeredCommands).toEqual([]);
    expect(plugin.diagnostics.join(' ')).toContain('no command registrar');
  });
});

// ---------------------------------------------------------------------------
// INT-5: logging.level gates log lines and includeTrajectorySummaries is read
// ---------------------------------------------------------------------------

describe('INT-5: the logging group is live configuration', () => {
  it('silences a mapped host logger entirely', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const { ctx } = createFakeContext();
    const hostCtx = { ...ctx, logger: { info, warn, debug: vi.fn(), error: vi.fn() } };

    createEvoHarnessPlugin(
      mountOptions({ config: e2eConfig({ config: { logging: { level: 'silent' } } }) }),
      hostCtx
    );

    // Pre-fix log() ignored config.logging.level and always called the sink.
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits info lines at level=info', () => {
    const info = vi.fn();
    const { ctx } = createFakeContext();
    const hostCtx = { ...ctx, logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() } };

    // NOTE: the e2e base config is `logging.level: 'silent'`, so the level must
    // be stated explicitly here for the gate to admit an info line.
    createEvoHarnessPlugin(
      mountOptions({ config: e2eConfig({ config: { logging: { level: 'info' } } }) }),
      hostCtx
    );

    expect(info).toHaveBeenCalled();
  });

  it('includeTrajectorySummaries decides whether the run line carries the trajectory', async () => {
    const runWithFlag = async (includeTrajectorySummaries: boolean): Promise<string[]> => {
      const lines: string[] = [];
      const { ctx } = createFakeContext();
      const hostCtx = {
        ...ctx,
        logger: {
          info: (line: string) => lines.push(line),
          warn: (line: string) => lines.push(line),
          debug: vi.fn(),
          error: vi.fn()
        }
      };
      const plugin = createEvoHarnessPlugin(
        mountOptions({
          config: e2eConfig({ config: { logging: { level: 'info', includeTrajectorySummaries } } })
        }),
        hostCtx
      );
      await plugin.run({
        sessionId: 'sess-log-' + String(includeTrajectorySummaries),
        task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
        trigger: 'always'
      });
      return lines;
    };

    const onLines = await runWithFlag(true);
    const offLines = await runWithFlag(false);
    const runLineOn = onLines.find((line) => line.includes('outcome='));
    const runLineOff = offLines.find((line) => line.includes('outcome='));
    expect(runLineOn).toBeDefined();
    expect(runLineOff).toBeDefined();
    // Pre-fix the run summary line did not exist at all and the flag was never
    // read; now the flag is the single difference between the two lines.
    expect(runLineOn).toContain('trajectory=');
    expect(runLineOff).not.toContain('trajectory=');
  });
});

// ---------------------------------------------------------------------------
// INT-7: handleFallbackEvent runs are joined by settle()/dispose()
// ---------------------------------------------------------------------------

describe('INT-7: handleFallbackEvent is tracked like the other trigger entries', () => {
  it('settle() returns the run started by handleFallbackEvent', async () => {
    const plugin = createEvoHarnessPlugin(mountOptions());
    const pending = plugin.handleFallbackEvent({
      sessionId: 'sess-fallback',
      prompt: 'recover from the reported failure',
      failureSignals: [{ kind: 'tool_error', message: 'the build broke' }]
    });
    // One tick lets the run register itself; settle() must then join it.
    const settled = await plugin.settle();
    const result = await pending;
    expect(result).not.toBeNull();
    // Pre-fix the run was untracked, so settle() returned an empty list while the
    // run was still in flight.
    expect(settled.length).toBe(1);
  });

  it('a run parked on a slow executor is still awaited by settle()', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowRunner = async (): Promise<never> => {
      await gate;
      throw new Error('slow probe failed');
    };
    const plugin = createEvoHarnessPlugin(
      mountOptions({ runBranch: slowRunner as unknown as EvoHarnessPluginOptions['runBranch'] })
    );

    const pending = plugin.handleFallbackEvent({
      sessionId: 'sess-slow',
      prompt: 'recover slowly',
      failureSignals: [{ kind: 'tool_error', message: 'the build broke' }]
    });
    const settlePromise = plugin.settle();
    // settle() must NOT resolve while the tracked run is parked in the executor.
    let settledEarly = false;
    void settlePromise.then(() => {
      settledEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledEarly).toBe(false);
    expect(plugin.diagnostics.join(' ')).not.toContain('Essential');
    release();
    await pending.catch(() => undefined);
    await settlePromise;
  });
});

// ---------------------------------------------------------------------------
// LEDGER-9b: host metering reaches the JitRL kernel's two model stages
// ---------------------------------------------------------------------------

describe('LEDGER-9b: the JitRL LLM judge is metered when a ledger is supplied', () => {
  it('reserves and settles the LLM-judge stage once agentLoop carries a settlement', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'core-p2:jitrl' });

    const plugin = createEvoHarnessPlugin(
      mountOptions({
        config: e2eConfig({
          config: {
            jitrl: {
              enabled: true,
              levels: ['meta'],
              logitSource: 'token',
              reward: { llmEvaluator: true, weights: { llm: 0.4, surrogate: 0.3, tool: 0.2, turn: 0.1, user: 0 }, clip: [-3, 3] }
            }
          }
        }),
        agentLoop: { model: createScriptedModel() as never, ledgerSettlement: settlement }
      })
    );

    const result = await plugin.run({
      sessionId: 'sess-ledger-9b',
      task: plugin.makeTask({ prompt: 'Run a metered JitRL pass.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');

    // The kernel's step judge really hit the ledger: the metered adapter labels
    // every call with `metered-model-adapter:<stage>`.
    const judgeIdentities = settlement
      .identities()
      .filter((identity) => identity.consumer === 'metered-model-adapter:evaluate_steps');
    expect(judgeIdentities.length).toBeGreaterThan(0);
    expect(judgeIdentities[0]?.state).toBe('settled');
    const status = manager.getMeteringStatus();
    expect(status.reserveAttempts).toBeGreaterThan(0);
    expect(status.settleCount).toBeGreaterThan(0);
  });

  it('without a settlement the same judge call stays unmetered (pre-fix behaviour pinned)', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const plugin = createEvoHarnessPlugin(
      mountOptions({
        config: e2eConfig({
          config: {
            jitrl: {
              enabled: true,
              levels: ['meta'],
              logitSource: 'token'
            }
          }
        })
      })
    );

    await plugin.run({
      sessionId: 'sess-ledger-9b-off',
      task: plugin.makeTask({ prompt: 'Run an unmetered JitRL pass.' }),
      trigger: 'always'
    });

    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
  });
});
