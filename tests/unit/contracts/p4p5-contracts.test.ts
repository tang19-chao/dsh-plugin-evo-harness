/**
 * Phase 4/5 additive contract round (contract version stays 2).
 *
 * Pins the three new surfaces at compile time and proves the invariants the
 * implementation tasks depend on:
 * - JitReplayHook is a *synchronous pure function*: calling it yields a result
 *   directly (never a Promise), so Dream replay can stay synchronous.
 * - The hook input carries the causally truncated neighbour snapshot and the
 *   hook never widens that window.
 * - HostAdvisorDecision is a closed three-state union and 'deny' can never be
 *   produced (gate mode asks the user instead of blocking).
 * - JitStatsAggregate / IJitMirrorStore carry aggregates only, namespace per
 *   level.
 * - ExperienceQuery gained optional drift fields without breaking old shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_SCHEMA_VERSION,
  HOST_ADVISOR_DECISION_KINDS,
  type AbstractState,
  type BatchSlotKind,
  type DreamJitDiagnostics,
  type ExperienceQuery,
  type ExperienceRecord,
  type HostAdvisorAdvisoryDecision,
  type HostAdvisorAskDecision,
  type HostAdvisorDecision,
  type HostAdvisorDecisionKind,
  type HostAdvisorNoopDecision,
  type HostAdvisorRequest,
  type IJitMirrorStore,
  type JitMirrorResult,
  type JitReplayFrontierNode,
  type JitReplayHook,
  type JitReplayHookInput,
  type JitReplayHookResult,
  type JitStatsAggregate,
  type JitLevel,
  type MetaSearchPolicy,
  type ScoredExperience,
  type ToolErrorRecord
} from '../../../src/types/contracts';

const slotWeights: Readonly<Record<BatchSlotKind, number>> = {
  exploit: 0.4,
  explore_domain: 0.3,
  explore_invariant: 0.2,
  recover: 0.1
};

const hostState: AbstractState = {
  level: 'host_tool',
  bucket: 'tools|repo-maintenance',
  tokens: ['tools', 'repo', 'maintenance'],
  summary: 'host tool state'
};

const neighbour: ExperienceRecord = {
  id: 'exp-host-1',
  level: 'host_tool',
  state: hostState,
  actionKey: 'tool:read_file',
  reward: -1.2,
  return: -1.8,
  rewardSources: { tool: -1.2 },
  guidance: 'memory',
  policyId: 'policy-1',
  sessionId: 'session-1',
  createdAt: 1_700_000_000_000,
  redacted: true
};

const frontierNode: JitReplayFrontierNode = {
  nodeId: 'node-7',
  depth: 2,
  patchOrigin: 'domain',
  purpose: 'deepen',
  guidance: 'memory',
  slot: 'exploit',
  score: 0.6,
  createdAt: 1_700_000_500_000
};

const jitHyperparams: NonNullable<MetaSearchPolicy['jit']> = {
  beta: 1,
  lambda: 0.05,
  alpha: 5,
  k: 10,
  gamma: 0.5,
  similarityThreshold: 0.3
};

const hookInput: JitReplayHookInput = {
  treeId: 'tree-1',
  policyId: 'policy-1',
  rho: 0.5,
  slotWeights,
  frontier: frontierNode,
  experiences: [neighbour],
  jit: jitHyperparams,
  driftRho: 0.7
};

const hookResult: JitReplayHookResult = {
  slotWeights: { ...slotWeights, exploit: 0.5, explore_domain: 0.2 },
  diagnostics: {
    level: 'meta',
    stateValue: 0.25,
    neighborCount: 1,
    klToPrior: 0.03,
    adjustments: [
      {
        actionKey: 'exploit',
        slot: 'exploit',
        baseWeight: 0.4,
        adjustedWeight: 0.5,
        q: 0.3,
        advantage: 0.05,
        normalizedAdvantage: 0.2,
        support: 1,
        explored: false
      }
    ]
  }
};

/** A hook implementation must satisfy the synchronous signature. */
const syncHook: JitReplayHook = (input) => ({
  slotWeights: input.slotWeights,
  diagnostics: {
    level: 'meta',
    stateValue: 0,
    neighborCount: input.experiences.length,
    klToPrior: 0,
    adjustments: []
  }
});

const dreamDiagnostics: DreamJitDiagnostics = {
  treeId: 'tree-1',
  policyId: 'policy-1',
  hookCalls: 3,
  neighborsUsed: 5,
  meanKlToPrior: 0.02,
  meanStateValue: 0.3,
  driftRho: 0.7,
  causalCutoff: 1_700_000_000_000,
  degraded: false,
  evidence: ['hook calls=3 driftRho=0.70']
};

const toolErrors: readonly ToolErrorRecord[] = [
  { toolName: 'shell', message: 'exit 1', code: 'ENOENT', retryable: true, stepIndex: 4 }
];

const advisorRequest: HostAdvisorRequest = {
  level: 'host_tool',
  state: hostState,
  recentTools: [
    { toolName: 'read_file', actionKey: 'tool:read_file', isError: false },
    { toolName: 'shell', actionKey: 'tool:shell', isError: true, exitCode: 1 }
  ],
  errors: toolErrors,
  workingDirectory: { path: '/repo', fileCount: 42, topExtensions: ['.ts'], truncated: false },
  mode: 'advisory',
  adviseThreshold: -0.5,
  gateThreshold: -0.8,
  minSupport: 5,
  policyId: 'policy-1',
  driftRho: 0.7,
  now: 1_700_000_600_000
};

const advisory: HostAdvisorAdvisoryDecision = {
  kind: 'advisory',
  text: 'In similar states tool:shell returned -1.2 on average.',
  antiPatterns: ['Avoid retrying a failing shell call without new evidence.']
};

const ask: HostAdvisorAskDecision = {
  kind: 'ask',
  reason: 'Mean neighbour return -1.8 is below the gate threshold.'
};

const noop: HostAdvisorNoopDecision = { kind: 'noop', reason: 'support below minSupport' };

const decisions: readonly HostAdvisorDecision[] = [advisory, ask, noop];

const aggregate: JitStatsAggregate = {
  bucket: 'tools|repo-maintenance',
  actionKey: 'tool:read_file',
  level: 'host_tool',
  n: 12,
  meanReturn: -0.4,
  variance: 0.81
};

const mirrorResult: JitMirrorResult = {
  written: 1,
  skipped: 0,
  namespaces: ['harness2/jitrl/host_tool'],
  degraded: false,
  diagnostics: []
};

const mirrorStore: IJitMirrorStore = {
  mirror: async (rows) => ({ ...mirrorResult, written: rows.length }),
  namespaceFor: (level: JitLevel) => 'harness2/jitrl/' + level
};

// Pre-Phase-4 query shape: still valid without the new optional fields.
const legacyQuery: ExperienceQuery = {
  level: 'meta',
  state: { ...hostState, level: 'meta' },
  k: 10,
  similarityThreshold: 0.3,
  before: 1_700_000_000_000
};

// Phase 4 drift query: the additive policyId/driftRho dimension.
const driftQuery: ExperienceQuery = { ...legacyQuery, policyId: 'policy-2', driftRho: 0.7 };

const scoredWithDrift: ScoredExperience = {
  record: neighbour,
  similarity: 0.8,
  weight: 0.5,
  driftWeight: 0.7
};

/**
 * Compile-time assertions. Each @ts-expect-error line turns `tsc --noEmit`
 * red if the guarded rule is loosened. The body never runs.
 */
function contractCompileTimeAssertions(): void {
  // @ts-expect-error 'deny' is not a HostAdvisorDecisionKind: the advisor must never block.
  const denied: HostAdvisorDecisionKind = 'deny';
  void denied;
  // @ts-expect-error the decision union has no deny variant
  const deniedDecision: HostAdvisorDecision = { kind: 'deny', reason: 'no' };
  void deniedDecision;
  // @ts-expect-error advisory decisions must carry rendered text
  const emptyAdvisory: HostAdvisorDecision = { kind: 'advisory' };
  void emptyAdvisory;
  // @ts-expect-error the L3 request is pinned to level 'host_tool'
  const wrongLevel: HostAdvisorRequest = { ...advisorRequest, level: 'meta' };
  void wrongLevel;
  // @ts-expect-error experiences is a readonly snapshot
  hookInput.experiences.push(neighbour);
  // @ts-expect-error slot weights in a hook result are readonly
  hookResult.slotWeights.exploit = 0.9;
  // @ts-expect-error a hook returns the result synchronously, not a Promise
  const asyncHook: JitReplayHook = async (input) => syncHook(input);
  void asyncHook;
  // @ts-expect-error the hook must return the corrected weights and diagnostics
  const missingDiagnostics: JitReplayHook = (input) => ({ slotWeights: input.slotWeights });
  void missingDiagnostics;
  // @ts-expect-error aggregates carry numeric statistics, not raw records
  const badAggregate: JitStatsAggregate = { ...aggregate, n: '12' };
  void badAggregate;
  // @ts-expect-error namespaceFor takes a JitLevel
  const badNamespace: string = mirrorStore.namespaceFor('nope');
  void badNamespace;
  // @ts-expect-error driftRho is a number when present
  const badDrift: ExperienceQuery = { ...legacyQuery, driftRho: '0.7' };
  void badDrift;
}

void contractCompileTimeAssertions;
void decisions;
void dreamDiagnostics;
void advisorRequest;
void driftQuery;
void scoredWithDrift;
void mirrorResult;

describe('Phase 4/5 contracts stay additive on contract version 2', () => {
  it('keeps CONTRACT_SCHEMA_VERSION at 2', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(2);
  });

  it('keeps the pre-Phase-4 ExperienceQuery shape valid without drift fields', () => {
    expect(legacyQuery.policyId).toBeUndefined();
    expect(legacyQuery.driftRho).toBeUndefined();
    expect(legacyQuery.k).toBe(10);
  });

  it('carries the optional policyId/driftRho drift dimension', () => {
    expect(driftQuery.policyId).toBe('policy-2');
    expect(driftQuery.driftRho).toBe(0.7);
    expect(scoredWithDrift.driftWeight).toBe(0.7);
    // Omitted driftWeight means "no drift weighting applied", never zero.
    expect(scoredWithDrift.weight).toBe(0.5);
  });
});

describe('JitReplayHook is a synchronous pure function', () => {
  it('returns a result directly instead of a Promise', () => {
    const result = syncHook(hookInput);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
    expect(result.slotWeights).toBe(slotWeights);
    expect(result.diagnostics.neighborCount).toBe(1);
  });

  it('reports the corrected weights and the four diagnostics fields', () => {
    const result = syncHook(hookInput);
    expect(Object.keys(result.slotWeights).sort()).toEqual([
      'exploit',
      'explore_domain',
      'explore_invariant',
      'recover'
    ]);
    expect(result.diagnostics).toMatchObject({
      level: 'meta',
      stateValue: expect.any(Number),
      neighborCount: expect.any(Number),
      klToPrior: expect.any(Number),
      adjustments: expect.any(Array)
    });
  });

  it('leaves the causally truncated snapshot untouched', () => {
    const snapshot: readonly ExperienceRecord[] = [neighbour];
    const input: JitReplayHookInput = { ...hookInput, experiences: snapshot };
    syncHook(input);
    expect(input.experiences).toBe(snapshot);
    expect(input.experiences).toHaveLength(1);
    expect(input.experiences[0]?.id).toBe('exp-host-1');
  });

  it('does not touch a store or any I/O while running', async () => {
    const spy = vi.fn((input: JitReplayHookInput) => syncHook(input));
    spy(hookInput);
    expect(spy).toHaveBeenCalledTimes(1);
    // A synchronous hook needs no microtask flush to have finished.
    expect(spy.mock.results[0]?.type).toBe('return');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty neighbourhood (cold start) without special casing', () => {
    const result = syncHook({ ...hookInput, experiences: [] });
    expect(result.diagnostics.neighborCount).toBe(0);
    expect(result.diagnostics.adjustments).toEqual([]);
    expect(result.slotWeights).toBe(slotWeights);
  });
});

describe('HostAdvisorDecision is a closed three-state union without deny', () => {
  it('exposes exactly advisory / ask / noop', () => {
    expect(HOST_ADVISOR_DECISION_KINDS).toEqual(['advisory', 'ask', 'noop']);
  });

  it('never contains deny or any blocking verdict', () => {
    const kinds: readonly string[] = HOST_ADVISOR_DECISION_KINDS;
    expect(kinds).not.toContain('deny');
    expect(kinds).not.toContain('block');
    expect(kinds).not.toContain('reject');
  });

  it('discriminates the three decisions by kind', () => {
    expect(decisions.map((decision) => decision.kind)).toEqual([
      'advisory',
      'ask',
      'noop'
    ]);
    expect(decisions.filter((decision) => decision.kind === 'advisory')).toHaveLength(1);
  });

  it('keeps gate mode as an ask with a reason rather than a denial', () => {
    const gated = { ...advisorRequest, mode: 'gate' as const };
    expect(gated.mode).toBe('gate');
    expect(ask.kind).toBe('ask');
    expect(ask.reason.length).toBeGreaterThan(0);
    // The only gate outcome available is asking; there is no deny branch to hit.
    expect(HOST_ADVISOR_DECISION_KINDS).toContain(ask.kind);
  });

  it('renders advisory text plus anti-patterns kept separate', () => {
    expect(advisory.text.length).toBeGreaterThan(0);
    expect(advisory.antiPatterns).toEqual([
      'Avoid retrying a failing shell call without new evidence.'
    ]);
  });

  it('builds a host_tool request from tools, errors and a directory digest', () => {
    expect(advisorRequest.level).toBe('host_tool');
    expect(advisorRequest.state.level).toBe('host_tool');
    expect(advisorRequest.recentTools.map((tool) => tool.toolName)).toEqual([
      'read_file',
      'shell'
    ]);
    expect(advisorRequest.errors[0]?.code).toBe('ENOENT');
    expect(advisorRequest.workingDirectory?.fileCount).toBe(42);
  });
});

describe('JitRL statistics mirror contracts', () => {
  it('describes aggregates, never raw experience records', () => {
    expect(Object.keys(aggregate).sort()).toEqual([
      'actionKey',
      'bucket',
      'level',
      'meanReturn',
      'n',
      'variance'
    ]);
    expect(aggregate).not.toHaveProperty('reward');
    expect(aggregate).not.toHaveProperty('state');
    expect(typeof aggregate.n).toBe('number');
    expect(typeof aggregate.meanReturn).toBe('number');
    expect(typeof aggregate.variance).toBe('number');
  });

  it('namespaces every level separately', () => {
    const levels: readonly JitLevel[] = ['meta', 'proposal', 'host_tool'];
    const namespaces = levels.map((level) => mirrorStore.namespaceFor(level));
    expect(namespaces).toEqual([
      'harness2/jitrl/meta',
      'harness2/jitrl/proposal',
      'harness2/jitrl/host_tool'
    ]);
    expect(new Set(namespaces).size).toBe(levels.length);
  });

  it('mirrors a batch of aggregates through one async call', async () => {
    const second: JitStatsAggregate = { ...aggregate, actionKey: 'tool:shell', n: 3 };
    const result = await mirrorStore.mirror([aggregate, second]);
    expect(result.written).toBe(2);
    expect(result.degraded).toBe(false);
    expect(result.namespaces).toEqual(['harness2/jitrl/host_tool']);
  });

  it('supports a disabled mirror that performs zero writes', async () => {
    let calls = 0;
    const disabled: IJitMirrorStore = {
      mirror: async () => {
        calls += 1;
        return { written: 0, skipped: 0, namespaces: [], degraded: false, diagnostics: [] };
      },
      namespaceFor: (level) => 'harness2/jitrl/' + level
    };
    const result = await disabled.mirror([]);
    expect(result.written).toBe(0);
    expect(calls).toBe(1);
  });
});
