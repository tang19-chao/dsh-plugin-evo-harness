/**
 * P3-A: the agentLoop -> ledger ASSEMBLY path (no deep import, no direct new).
 *
 * WHAT IS PINNED HERE
 *   1. A host configures the ledger through the EXISTING `agentLoop` option
 *      (one of the 26 keys of ADR 0005 section 3.1) — no 27th option and no new
 *      `src/config.ts` root key are introduced.
 *   2. `agentLoop.ledger.enabled === true` really assembles a manager through
 *      `src/ledger/assembly.ts`: with a zero budget the assembled manager
 *      refuses the call (the pre-P3-A2 fail-closed path, unchanged by this
 *      task), which proves the manager is consulted rather than fabricated.
 *   3. A caller that passes no ledger stays unmetered, and `describe()` says so
 *      explicitly (never "metered with nothing").
 *   4. The executor source contains NO deep ledger import and NO direct
 *      construction; every file under `tests/unit/dsh-bridge/` is also free of
 *      direct manager construction. These are ASSERTIONS, not observations.
 *
 * SCOPE NOTE (captain split): observe-must-not-deny semantics and the explicit
 * hard-limit opt-in are the follow-up P3-A2 task. This file only proves the
 * assembly boundary; the zero-budget expectations below are the current
 * fail-closed behaviour and will be narrowed by P3-A2.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createAgentLoopExecutor,
  type AgentLoopAdapters,
  type AgentLoopDecision,
  type AgentPlanRequest,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolRuntime
} from '../../../src/dsh-bridge';
import {
  createLedgerReservationManager,
  type LedgerAssemblyOptions
} from '../../../src/ledger';
import {
  DEFAULT_EVO_HARNESS_CONFIG,
  validateEvoHarnessConfig
} from '../../../src/config';
import { apply, OPTION_KEYS } from '../../../src/index';
import type {
  FailureSignal,
  IsolatedBranchContext,
  ModelResponse,
  ProbeExecutionResult
} from '../../../src/types/contracts';
import { makeClock, makePatch, makeTask } from '../cordis-seams/fixtures';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Same 1u/2u rate card as the ledger assembly suite. */
const RATE_CARD = {
  modelId: 'test/model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

// ---------------------------------------------------------------------------
// Structural fakes (no host, no network, no LLM)
// ---------------------------------------------------------------------------

function scriptedPlanner(decisions: readonly AgentLoopDecision[]): {
  planNext: (request: AgentPlanRequest) => Promise<AgentLoopDecision>;
  readonly requests: AgentPlanRequest[];
} {
  const requests: AgentPlanRequest[] = [];
  let cursor = 0;
  return {
    requests,
    async planNext(request: AgentPlanRequest): Promise<AgentLoopDecision> {
      requests.push(request);
      const decision = decisions[cursor];
      cursor += 1;
      if (decision === undefined) {
        throw new Error('the scripted planner ran out of decisions');
      }
      return decision;
    }
  };
}

function recordingTools(): AgentToolRuntime & { readonly calls: AgentToolCallRequest[] } {
  const calls: AgentToolCallRequest[] = [];
  return {
    calls,
    listTools: () => ['shell'],
    async execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      calls.push(request);
      return { result: 'tool-output-preserved', text: 'tool-output-preserved' };
    }
  };
}

function makeContext(overrides: Partial<IsolatedBranchContext> = {}): IsolatedBranchContext {
  return {
    branchId: 'br-p3a',
    sessionId: 'sess-p3a',
    namespace: 'harness2:probe_br-p3a',
    task: makeTask(),
    patch: makePatch(),
    mountedSurfaces: ['system_prompt'],
    signal: new AbortController().signal,
    ...overrides
  };
}

function signalKinds(result: ProbeExecutionResult): readonly string[] {
  return (result.failureSignals ?? []).map((signal: FailureSignal) => signal.kind);
}

const TWO_ITERATIONS: readonly AgentLoopDecision[] = [
  { kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'ls' } },
  { kind: 'final', text: 'done' }
];

// ---------------------------------------------------------------------------
// 1. the real assembly path
// ---------------------------------------------------------------------------

describe('agentLoop.ledger: the validated assembly path', () => {
  it('creates a manager from config and still runs a full probe on a normal budget', async () => {
    const planner = scriptedPlanner(TWO_ITERATIONS);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      {
        model: planner,
        tools,
        ledger: {
          enabled: true,
          generalBudgetMicros: 1_000_000,
          estimatedCostMicros: 10_000,
          defaultRateCard: RATE_CARD
        }
      },
      makeClock(1_000, 10)
    );

    // The metering state is OBSERVABLE without inspecting private fields.
    const capabilities = executor.describe().join('\n');
    expect(capabilities).toContain('ledger assembly');
    expect(capabilities).toContain('general=1000000u');
    expect(capabilities).toContain('per-call estimate=10000u');
    expect(capabilities).toContain('hard bounds: not enforced in this build');

    const result = await executor.runBranch(makeContext());
    expect(result.status).toBe('succeeded');
    expect(tools.calls).toHaveLength(1);
  });

  it('observe mode: zero budget is OBSERVED but never enforced (the probe really runs)', async () => {
    const planner = scriptedPlanner(TWO_ITERATIONS);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      { model: planner, tools, ledger: { enabled: true, generalBudgetMicros: 0 } },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    // The assembled manager — not a placeholder — DID decide something: the
    // would-be denial is reported on the dedicated observations channel.
    expect(result.observations?.some((entry) => entry.kind === 'budget_exhausted')).toBe(true);
    expect(result.observations?.[0]?.details?.rejection).toBe('insufficient_budget');
    // …but the default observe mode must not change the outcome or pollute the
    // failure channel that scoring/taxonomy read.
    expect(result.status).toBe('succeeded');
    expect(signalKinds(result)).not.toContain('budget_exhausted');
    // The probe really ran (not "nothing happened").
    expect(planner.requests.length).toBeGreaterThan(0);
    expect(tools.calls.length).toBeGreaterThan(0);
  });

  it('enforce mode: the same fixture denies before any model/tool work', async () => {
    const planner = scriptedPlanner(TWO_ITERATIONS);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      {
        model: planner,
        tools,
        ledger: { enabled: true, enforceHardBounds: true, generalBudgetMicros: 0 }
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('failed');
    expect(result.error?.name).toBe('EvoHarnessLedgerError');
    expect(signalKinds(result)).toContain('budget_exhausted');
    expect(planner.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it('fails at construction time for an invalid enabled configuration', () => {
    expect(() =>
      createAgentLoopExecutor({ ledger: { enabled: true, generalBudgetMicros: -1 } })
    ).toThrow(/non-negative integer/);
  });

  it('refuses both wiring styles at once instead of silently preferring one', () => {
    const manager = createLedgerReservationManager({ enabled: true });
    expect(() =>
      createAgentLoopExecutor({
        ledger: { enabled: true },
        ledgerManager: manager
      })
    ).toThrow(/not both/);
  });
});

// ---------------------------------------------------------------------------
// 1b. the REAL plugin entrypoint: agentLoop.ledger reaches the executor via apply()
// ---------------------------------------------------------------------------

describe('plugin entrypoint (apply): the ledger travels through the agentLoop option', () => {
  it('rejects an invalid ledger config at mount time', () => {
    // If the option did not reach the executor, construction would succeed and
    // this test would silently pass for the wrong reason.
    expect(() =>
      apply({}, { agentLoop: { ledger: { enabled: true, generalBudgetMicros: -1 } } })
    ).toThrow(/non-negative integer/);
  });

  it('mounts with a valid ledger configuration and exposes the plugin surface', () => {
    const plugin = apply({}, {
      agentLoop: {
        ledger: { enabled: true, generalBudgetMicros: 1_000_000, estimatedCostMicros: 10_000 }
      }
    });
    expect(typeof plugin.dispose).toBe('function');
    expect(typeof plugin.settle).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. degradation: no ledger == unmetered, and it says so
// ---------------------------------------------------------------------------

describe('no ledger: unmetered, never "metered with nothing"', () => {
  it('keeps the pre-P3-A default working and reports ledger OFF', async () => {
    const planner = scriptedPlanner(TWO_ITERATIONS);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    expect(executor.describe().join('\n')).toContain('ledger: OFF (unmetered');

    const result = await executor.runBranch(makeContext());
    expect(result.status).toBe('succeeded');
    expect(planner.requests).toHaveLength(2);
  });

  it('treats { enabled: false } as unmetered, never as an error', async () => {
    const planner = scriptedPlanner(TWO_ITERATIONS);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      { model: planner, tools, ledger: { enabled: false, generalBudgetMicros: 0 } },
      makeClock()
    );

    expect(executor.describe().join('\n')).toContain('ledger: OFF (unmetered');
    const result = await executor.runBranch(makeContext());
    expect(result.status).toBe('succeeded');
  });

  it('keeps the legacy pre-built manager injection optional and working', async () => {
    // Backward compatibility (captain instruction): ledgerManager stays an
    // OPTIONAL injection point; callers that use it are unaffected by P3-A.
    const manager = createLedgerReservationManager({ enabled: true, generalBudgetMicros: 1_000_000 });
    const planner = scriptedPlanner(TWO_ITERATIONS);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools, ledgerManager: manager }, makeClock());

    expect(executor.describe().join('\n')).toContain('pre-built manager injected');
    const result = await executor.runBranch(makeContext());
    expect(result.status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// 3. P1 / ADR 0005 configuration-key consistency (26 keys)
// ---------------------------------------------------------------------------

describe('agentLoop.ledger stays inside the 26-key public option surface', () => {
  /**
   * MANUAL SYNC PIN, not a second source of truth:
   *   - OPTION_KEYS is IMPORTED from src/index.ts — P1's authoritative list,
   *     itself compile-time exhaustive over EvoHarnessPluginOptions and pinned
   *     to 26 by the `_OPTION_KEYS_COUNT` witness. This test never re-declares
   *     the option-key array, so it cannot "agree with itself".
   *   - The root-key set is DERIVED from DEFAULT_EVO_HARNESS_CONFIG (the
   *     authoritative frozen schema). The literal below only records what ADR
   *     0005 section 3.1 documented at P1 time; adding a root key requires
   *     updating the ADR and this literal together, and its failure is the
   *     signal that the `check:docs` leaf surface changed.
   */
  const DOCUMENTED_ROOT_KEYS: readonly string[] = [
    'schemaVersion',
    'enabled',
    'triggerMode',
    'enabledSurfaces',
    'probe',
    'memoryBridge',
    'dreamRsi',
    'jitrl',
    'execution',
    'logging'
  ];

  it('registers exactly 26 public option keys, including agentLoop', () => {
    expect(OPTION_KEYS.length).toBe(26);
    expect(new Set(OPTION_KEYS).size).toBe(26);
    expect(OPTION_KEYS).toContain('agentLoop');
  });

  it('introduces no 27th option key for the ledger', () => {
    // The ledger config is nested under the EXISTING agentLoop option, exactly
    // as ADR 0005 section 3.1 requires (OPTION_KEYS is exhaustive and stable).
    expect(OPTION_KEYS).not.toContain('ledger');
    expect(OPTION_KEYS).not.toContain('ledgerManager');
  });

  it('introduces no new src/config.ts root key (check:docs leaf count unchanged)', () => {
    const rootKeys = Object.keys(DEFAULT_EVO_HARNESS_CONFIG).sort();
    expect(rootKeys).toEqual([...DOCUMENTED_ROOT_KEYS].sort());
    expect(rootKeys).not.toContain('ledger');
    expect(rootKeys).not.toContain('agentLoop');
    // OPTION_KEYS ∩ ROOT_KEYS = empty (ADR 0005 section 3.1 invariant).
    expect(OPTION_KEYS.filter((key) => rootKeys.includes(key))).toEqual([]);
  });

  it('keeps agentLoop an OPTION, never a frozen config section', () => {
    const probe = validateEvoHarnessConfig({ agentLoop: { enabled: true, ledger: {} } });
    expect(
      probe.issues.some((issue) => issue.code === 'unknown_key' && issue.path === 'agentLoop')
    ).toBe(true);
  });

  it('types the ledger entry as the assembly config (compile-time witness)', () => {
    // Positive witness: the option's value is exactly the assembly config.
    const known: NonNullable<AgentLoopAdapters['ledger']> = {
      enabled: true,
      generalBudgetMicros: 1_000,
      enforceHardBounds: false
    };
    expect(known.generalBudgetMicros).toBe(1_000);

    // Negative witnesses (never executed): a typo at the option level and a
    // wrong value type both fail `tsc --noEmit` via the @ts-expect-error gate.
    const negative = (): void => {
      // @ts-expect-error 'ledgerBudgetMicros' is not a declared agentLoop field
      const misspelled: AgentLoopAdapters = { ledgerBudgetMicros: 1 };
      // @ts-expect-error generalBudgetMicros is a number, not a string
      const wrongType: AgentLoopAdapters = { ledger: { enabled: true, generalBudgetMicros: '10' } };
      void misspelled;
      void wrongType;
    };
    void negative;

    // The assembly config type is the ledger module's exported contract.
    const assemblyConfig: LedgerAssemblyOptions = { enabled: true };
    expect(assemblyConfig.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. static gates: no deep import, no direct construction
// ---------------------------------------------------------------------------

describe('static gates: the bypass paths stay closed', () => {
  /**
   * Both patterns are ASSEMBLED from two literals so this test file does not
   * match its own scan (the source contains `'new', 'LedgerReservationManager'`
   * separately, never the forbidden phrase itself).
   */
  const DIRECT_CONSTRUCTION = new RegExp(['new', 'LedgerReservationManager'].join('\\s+'));
  /** The manager module is the deep-import bypass; type-only imports are checked separately. */
  // No closing quote: the import specifier normally ends in `.js`.
  const DEEP_MANAGER_IMPORT = new RegExp(["from", "'../ledger/reservation-manager"].join('\\s+'));

  /** Scan every .ts file in `dir` and return the offenders (relative file names). */
  function offendingFiles(dir: string, pattern: RegExp): string[] {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => pattern.test(readFileSync(path.join(dir, file), 'utf8')));
  }

  it('src/dsh-bridge has no direct construction and no deep manager import', () => {
    const dir = path.join(repoRoot, 'src', 'dsh-bridge');
    expect(offendingFiles(dir, DIRECT_CONSTRUCTION)).toEqual([]);
    expect(offendingFiles(dir, DEEP_MANAGER_IMPORT)).toEqual([]);
  });

  it('tests/unit/dsh-bridge has no direct construction', () => {
    expect(offendingFiles(path.join(repoRoot, 'tests', 'unit', 'dsh-bridge'), DIRECT_CONSTRUCTION)).toEqual([]);
  });

  it('the executor goes through the barrel and the single assembly function', () => {
    const source = readFileSync(path.join(repoRoot, 'src', 'dsh-bridge', 'agent-loop-executor.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+'\.\.\/ledger\/(reservation-manager|types|pricing)/);
    expect(source).toMatch(/from\s+'\.\.\/ledger\/index\.js'/);
    expect(source).toMatch(/assembleAgentLoopLedger/);
  });

  it('NEGATIVE CONTROL: the scanner really reports a violating file', () => {
    // Proves the gates above are not vacuous. A file that constructs the manager
    // directly — or deep-imports its module — IS reported. Temp dir only; the
    // repository is never written by this test.
    const dir = mkdtempSync(path.join(tmpdir(), 'p3a-static-gate-'));
    try {
      writeFileSync(
        path.join(dir, 'violating.ts'),
        ['const m = new', 'LedgerReservationManager({} as never);', ''].join(' ')
      );
      expect(offendingFiles(dir, DIRECT_CONSTRUCTION)).toEqual(['violating.ts']);

      writeFileSync(
        path.join(dir, 'deep-import.ts'),
        ['import { LedgerReservationManager } from', "'../ledger/reservation-manager.js';", ''].join(' ')
      );
      expect(offendingFiles(dir, DEEP_MANAGER_IMPORT)).toEqual(['deep-import.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the new ledger assembly suite also goes through the factory (rule for NEW tests)', () => {
    // RULE (P3-A): new tests must NEVER construct the manager class directly;
    // they use `createLedgerReservationManager` / `assembleAgentLoopLedger`.
    // Existing tests/unit/ledger/*.ts white-box suites are a frozen pre-P3-A baseline.
    // Re-run this gate with:
    //   pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts
    const source = readFileSync(path.join(repoRoot, 'tests', 'unit', 'ledger', 'assembly.test.ts'), 'utf8');
    expect(source).not.toMatch(DIRECT_CONSTRUCTION);
    expect(source).toMatch(/createLedgerReservationManager/);
  });
});
