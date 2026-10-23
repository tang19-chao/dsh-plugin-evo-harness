/**
 * P5-a L3 host-advisor: advisory/gate degraded modes (plan section 3.3).
 *
 * Covers the acceptance list: default-off costs zero retrieval, the advisory
 * text stays within the 300-token budget, negative advantages live only inside
 * <anti_patterns_to_avoid>, gate mode can only ever answer ask/noop (runtime
 * enumeration plus compile-time no-deny assertions), insufficient support never
 * asks, an empty neighbourhood and a throwing store both degrade to noop
 * without throwing, and the injected text is built from statistics only.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVO_HARNESS_CONFIG,
  createDefaultConfig,
  type JitRlConfig
} from '../../../src/config';
import {
  HOST_ADVISOR_DECISION_KINDS,
  type AbstractState,
  type ExperienceQuery,
  type ExperienceRecord,
  type HostAdvisorDecision,
  type HostAdvisorDecisionKind,
  type HostAdvisorRequest,
  type ScoredExperience
} from '../../../src/types/contracts';
import {
  ADVISORY_TAG,
  ANTI_PATTERN_TAG,
  HOST_ADVISOR_EMITTABLE_KINDS,
  HOST_ADVISOR_NEVER_DENIES,
  MAX_ADVISORY_TOKENS,
  createHostAdvisor,
  estimateTokens,
  type HostAdvisor,
  type HostAdvisorEstimator,
  type HostAdvisorStore
} from '../../../src/jitrl/host-advisor';
import { retrieveNeighbors } from '../../../src/jitrl/retriever';

const T0 = 1_700_000_000_000;

const HOST_STATE: AbstractState = {
  level: 'host_tool',
  bucket: 'host|none|unknown|repo',
  tokens: ['tool:read', 'tool:edit', 'err:none', 'turn:unknown', 'wd:repo'],
  summary: 'tool:read tool:edit err:none turn:unknown wd:repo'
};

function makeState(overrides: Partial<AbstractState> = {}): AbstractState {
  return { ...HOST_STATE, ...overrides };
}

interface RecordInput {
  readonly id: string;
  readonly actionKey: string;
  readonly value: number;
  readonly state?: AbstractState;
  readonly policyId?: string;
  readonly createdAt?: number;
}

function makeRecord(input: RecordInput): ExperienceRecord {
  const state = input.state ?? HOST_STATE;
  return {
    id: input.id,
    level: 'host_tool',
    state,
    actionKey: input.actionKey,
    reward: input.value,
    return: input.value,
    rewardSources: {},
    guidance: 'memory',
    policyId: input.policyId ?? 'policy-current',
    sessionId: 'session',
    createdAt: input.createdAt ?? T0,
    redacted: true
  };
}

function makeRequest(overrides: Partial<HostAdvisorRequest> = {}): HostAdvisorRequest {
  return {
    level: 'host_tool',
    state: HOST_STATE,
    recentTools: [],
    errors: [],
    mode: 'advisory',
    adviseThreshold: -0.5,
    gateThreshold: -0.8,
    minSupport: 2,
    ...overrides
  };
}

function enabledConfig(
  overrides: Partial<JitRlConfig['hostAdvisor']> = {}
): JitRlConfig {
  const config = createDefaultConfig().jitrl;
  config.hostAdvisor = { ...config.hostAdvisor, enabled: true, ...overrides };
  return config;
}

function disabledConfig(): JitRlConfig {
  const config = createDefaultConfig().jitrl;
  config.hostAdvisor = { ...config.hostAdvisor, enabled: false };
  return config;
}

/** In-memory snapshot retriever over the shipped retriever kernel. */
function snapshotRetriever(records: readonly ExperienceRecord[], calls: { n: number }) {
  return (state: AbstractState, query: ExperienceQuery): readonly ScoredExperience[] => {
    calls.n += 1;
    return retrieveNeighbors(records, state, {
      k: query.k,
      similarityThreshold: query.similarityThreshold,
      level: 'host_tool'
    });
  };
}

function stubStore(
  neighbors: readonly ScoredExperience[],
  calls: ExperienceQuery[]
): HostAdvisorStore {
  return {
    query: async (query: ExperienceQuery) => {
      calls.push(query);
      return neighbors;
    }
  };
}

function scored(records: readonly ExperienceRecord[]): readonly ScoredExperience[] {
  return records.map((record) => ({ record, similarity: 1, weight: 1 }));
}

/** Balanced evidence: `read` is good, `edit` is bad, V = 0 for the bucket. */
const BALANCED_RECORDS: readonly ExperienceRecord[] = [
  makeRecord({ id: 'r1', actionKey: 'read', value: 2 }),
  makeRecord({ id: 'r2', actionKey: 'read', value: 2 }),
  makeRecord({ id: 'r3', actionKey: 'read', value: 2 }),
  makeRecord({ id: 'e1', actionKey: 'edit', value: -2 }),
  makeRecord({ id: 'e2', actionKey: 'edit', value: -2 }),
  makeRecord({ id: 'e3', actionKey: 'edit', value: -2 })
];

describe('estimateTokens', () => {
  it('is deterministic and conservative for ASCII and CJK', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    // Every non-ASCII code point counts as one token.
    expect(estimateTokens('宿主顾问')).toBe(4);
    expect(estimateTokens('ab宿主')).toBe(3);
    expect(estimateTokens('abcd 宿主')).toBe(4);
  });
});

describe('host advisor: default off', () => {
  it('returns noop for every request and performs zero retrieval', async () => {
    const storeCalls: ExperienceQuery[] = [];
    const retrieverCalls = { n: 0 };
    let estimatorCalls = 0;
    const estimatorSpy: HostAdvisorEstimator = (
      state,
      neighbors,
      candidates
    ) => {
      estimatorCalls += 1;
      return candidates.map((candidate) => ({
        actionKey: candidate.actionKey,
        q: 0,
        support: 1,
        explored: false,
        advantage: 0
      }));
    };
    const advisor = createHostAdvisor({
      config: disabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), storeCalls),
      retriever: snapshotRetriever(BALANCED_RECORDS, retrieverCalls),
      estimator: estimatorSpy
    });

    for (const mode of ['advisory', 'gate'] as const) {
      const decision = await advisor.evaluate(makeRequest({ mode }));
      expect(decision.kind).toBe('noop');
      if (decision.kind === 'noop') {
        expect(decision.reason).toBe('host_advisor_disabled');
      }
      expect(decision.diagnostics).toBeUndefined();
    }
    expect(storeCalls).toHaveLength(0);
    expect(retrieverCalls.n).toBe(0);
    expect(estimatorCalls).toBe(0);
  });
});

describe('host advisor: advisory mode', () => {
  it('renders a budgeted advice block with negative evidence only as anti-pattern', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    const decision = await advisor.evaluate(makeRequest({ mode: 'advisory' }));

    expect(decision.kind).toBe('advisory');
    if (decision.kind !== 'advisory') {
      return;
    }
    const text = decision.text;
    expect(text.startsWith('<' + ADVISORY_TAG)).toBe(true);
    expect(text).toContain('<' + ANTI_PATTERN_TAG + '>');
    expect(text.endsWith('</' + ADVISORY_TAG + '>')).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(MAX_ADVISORY_TOKENS);

    // The good action is the recommendation; the bad one only ever appears
    // inside the anti-pattern slot.
    const antiIndex = text.indexOf('<' + ANTI_PATTERN_TAG + '>');
    const editIndex = text.indexOf('edit');
    expect(text).toContain('recommend read');
    expect(editIndex).toBeGreaterThan(antiIndex);
    expect(/recommend[^\n]*edit/.test(text)).toBe(false);
    expect(decision.antiPatterns).toBeDefined();
    expect(decision.antiPatterns?.some((line) => line.includes('edit'))).toBe(true);
    expect(decision.antiPatterns?.every((line) => !line.includes('read'))).toBe(true);
    // Anti-patterns are rendered, not "recommended": no recommendation prefix.
    expect(decision.antiPatterns?.every((line) => !line.startsWith('recommend'))).toBe(true);

    // Only statistics are injected; raw records never leak.
    expect(text).not.toContain('reward');
    expect(text).not.toContain('sessionId');

    const diagnostics = decision.diagnostics;
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.mode).toBe('advisory');
    expect(diagnostics?.actionKey).toBe('edit');
    expect(diagnostics?.support).toBe(3);
    expect(diagnostics?.meanReturn).toBeCloseTo(-2, 10);
    expect(diagnostics?.stateValue).toBeCloseTo(0, 10);
    expect(diagnostics?.threshold).toBe(-0.5);
    expect(diagnostics?.advantage).toBeCloseTo(-2 / (2 + 1e-6), 9);
  });

  it('stays inside the token budget by truncating and recording a diagnostic', async () => {
    const records: ExperienceRecord[] = [];
    for (let index = 0; index < 40; index += 1) {
      const actionKey = 'tool_' + String(index).padStart(2, '0') + '_' + 'x'.repeat(40);
      const value = 3 - (index * 6) / 39;
      records.push(makeRecord({ id: 'rec-' + String(index), actionKey, value }));
    }
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(records), [])
    });
    const decision = await advisor.evaluate(
      makeRequest({ mode: 'advisory', adviseThreshold: -0.5 })
    );

    expect(decision.kind).toBe('advisory');
    if (decision.kind !== 'advisory') {
      return;
    }
    expect(estimateTokens(decision.text)).toBeLessThanOrEqual(MAX_ADVISORY_TOKENS);
    expect(decision.text).toContain('truncated="true"');
    // The block stays well formed after truncation.
    expect(decision.text).toContain('<' + ANTI_PATTERN_TAG + '>');
    expect(decision.text).toContain('</' + ANTI_PATTERN_TAG + '>');
    expect(decision.text.endsWith('</' + ADVISORY_TAG + '>')).toBe(true);
    expect(advisor.diagnostics().some((line) => line.startsWith('advisory_truncated'))).toBe(
      true
    );
    // Every anti-pattern reported in the structure is present in the text.
    const antiPatterns = decision.antiPatterns ?? [];
    expect(antiPatterns.length).toBeGreaterThan(0);
    expect(antiPatterns.length).toBeLessThan(40);
    for (const line of antiPatterns) {
      expect(decision.text).toContain(line);
    }
  });

  it('does nothing when every evidenced action clears the advise threshold', async () => {
    const records = [
      makeRecord({ id: 'a1', actionKey: 'read', value: 1 }),
      makeRecord({ id: 'a2', actionKey: 'edit', value: 1 })
    ];
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(records), [])
    });
    const decision = await advisor.evaluate(makeRequest({ mode: 'advisory' }));
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toContain('advise_threshold');
    }
  });
});

describe('host advisor: gate mode', () => {
  it('asks the user about the focused action when support and threshold are met', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    const decision = await advisor.evaluate(
      makeRequest({
        mode: 'gate',
        gateThreshold: -0.8,
        minSupport: 2,
        recentTools: [{ toolName: 'edit' }]
      })
    );

    expect(decision.kind).toBe('ask');
    if (decision.kind !== 'ask') {
      return;
    }
    expect(decision.suggestedActionKey).toBe('edit');
    expect(decision.reason).toContain('edit');
    expect(decision.reason).toContain('never denies');
    expect(decision.diagnostics?.mode).toBe('gate');
    expect(decision.diagnostics?.support).toBe(3);
    expect(decision.diagnostics?.threshold).toBe(-0.8);
  });

  it('does not ask when support is below minSupport', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    const decision = await advisor.evaluate(
      makeRequest({
        mode: 'gate',
        minSupport: 4,
        recentTools: [{ toolName: 'edit' }]
      })
    );
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toContain('gate_min_support');
    }
  });

  it('does not ask when the focused action clears the gate threshold', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    const decision = await advisor.evaluate(
      makeRequest({
        mode: 'gate',
        gateThreshold: -1.5,
        minSupport: 1,
        recentTools: [{ toolName: 'edit' }]
      })
    );
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toContain('gate_threshold');
    }
  });

  it('falls back to the worst evidenced action when the focused key has no evidence', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    for (const recentTools of [
      [],
      [{ toolName: 'ghost-tool' }],
      [{ toolName: 'ghost-tool', actionKey: 'ghost-action' }]
    ] as HostAdvisorRequest['recentTools'][]) {
      const decision = await advisor.evaluate(
        makeRequest({ mode: 'gate', recentTools })
      );
      expect(decision.kind).toBe('ask');
      if (decision.kind === 'ask') {
        expect(decision.suggestedActionKey).toBe('edit');
      }
    }
  });

  it('never returns a deny-like verdict for any constructed input', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    const modes: readonly ('advisory' | 'gate')[] = ['advisory', 'gate'];
    const thresholds = [-5, -2, -1.5, -0.8, -0.5, 0, 0.5, 5];
    const supports = [0, 1, 2, 3, 9, 99];
    const recentToolsVariants: readonly HostAdvisorRequest['recentTools'][] = [
      [],
      [{ toolName: 'read' }],
      [{ toolName: 'edit' }],
      [{ toolName: 'edit', actionKey: 'edit', isError: true }],
      [{ toolName: 'ghost' }]
    ];
    let checked = 0;
    for (const mode of modes) {
      for (const threshold of thresholds) {
        for (const minSupport of supports) {
          for (const recentTools of recentToolsVariants) {
            const decision = await advisor.evaluate(
              makeRequest({
                mode,
                adviseThreshold: threshold,
                gateThreshold: threshold,
                minSupport,
                recentTools
              })
            );
            checked += 1;
            expect(HOST_ADVISOR_DECISION_KINDS).toContain(decision.kind);
            expect(decision.kind).not.toBe('deny');
            expect(decisionKind(decision)).toBe(decision.kind);
          }
        }
      }
    }
    expect(checked).toBe(modes.length * thresholds.length * supports.length * recentToolsVariants.length);
  });
});

/** Exhaustive switch: adding a fourth decision kind stops this compiling. */
function decisionKind(decision: HostAdvisorDecision): HostAdvisorDecisionKind {
  switch (decision.kind) {
    case 'advisory':
    case 'ask':
    case 'noop':
      return decision.kind;
  }
}

describe('host advisor: no-deny guarantees', () => {
  it('keeps the decision-kind contract tri-state and never denying', () => {
    expect(HOST_ADVISOR_DECISION_KINDS).toEqual(['advisory', 'ask', 'noop']);
    expect(HOST_ADVISOR_EMITTABLE_KINDS).toEqual(['advisory', 'ask', 'noop']);
    expect(HOST_ADVISOR_NEVER_DENIES).toBe(true);
    expect(HOST_ADVISOR_DECISION_KINDS).not.toContain('deny');
    expect(HOST_ADVISOR_DECISION_KINDS).not.toContain('block');
    expect(HOST_ADVISOR_DECISION_KINDS).not.toContain('reject');
  });

  it('rejects deny at the type level', () => {
    // @ts-expect-error 'deny' is not a member of HostAdvisorDecisionKind.
    const denyKind: HostAdvisorDecisionKind = 'deny';
    // @ts-expect-error a deny decision is not part of the HostAdvisorDecision union.
    const denyDecision: HostAdvisorDecision = { kind: 'deny', reason: 'blocked' };
    // Both bindings are reachable only because the compiler rejects their
    // initialisers; the runtime check documents that a deny payload would be
    // outside the union the advisor may return.
    expect(String(denyKind)).toBe('deny');
    expect(HOST_ADVISOR_DECISION_KINDS.includes(denyDecision.kind as never)).toBe(false);
  });
});

describe('host advisor: failure safety and no-action paths', () => {
  it('does nothing when there are no neighbours', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore([], [])
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('no_neighbors');
    }
    expect(advisor.diagnostics().some((line) => line.startsWith('no_neighbors'))).toBe(true);
  });

  it('treats sub-threshold similarity as no evidence', async () => {
    const weak: readonly ScoredExperience[] = BALANCED_RECORDS.map((record) => ({
      record,
      similarity: 0.1,
      weight: 0.1
    }));
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(weak, [])
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('no_neighbors');
    }
  });

  it('does nothing and does not throw when the store rejects', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: {
        query: async () => {
          throw new Error('store offline');
        }
      }
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('retrieval_failed');
    }
    expect(advisor.diagnostics().some((line) => line.startsWith('retrieval_failed'))).toBe(true);
  });

  it('does nothing and does not throw when the retriever rejects', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      retriever: () => {
        throw new TypeError('retriever exploded');
      }
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('retrieval_failed');
    }
  });

  it('survives a malformed store result without throwing', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: {
        query: async () => [null] as unknown as readonly ScoredExperience[]
      }
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
  });

  it('degrades to noop when a seam returns a non-array', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: {
        query: async () => undefined as unknown as readonly ScoredExperience[]
      }
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('retrieval_failed');
    }
  });

  it('degrades to noop when the estimator throws', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), []),
      estimator: () => {
        throw new RangeError('estimator exploded');
      }
    });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('advisor_failed');
    }
    expect(advisor.diagnostics().some((line) => line.startsWith('advisor_failed'))).toBe(true);
  });

  it('does nothing for an unusable request', async () => {
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    const decision = await advisor.evaluate(
      {} as unknown as HostAdvisorRequest
    );
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('invalid_request');
    }
  });

  it('does nothing when neither store nor retriever is injected', async () => {
    const advisor = createHostAdvisor({ config: enabledConfig() });
    const decision = await advisor.evaluate(makeRequest());
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('no_experience_source');
    }
  });
});

describe('host advisor: state, query and drift seams', () => {
  it('uses the provided host_tool state and forwards k/similarity', async () => {
    const queries: ExperienceQuery[] = [];
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), queries)
    });
    await advisor.evaluate(makeRequest());
    expect(queries).toHaveLength(1);
    const query = queries[0] as ExperienceQuery;
    expect(query.level).toBe('host_tool');
    expect(query.state).toBe(HOST_STATE);
    expect(query.k).toBe(DEFAULT_EVO_HARNESS_CONFIG.jitrl.k);
    expect(query.similarityThreshold).toBe(
      DEFAULT_EVO_HARNESS_CONFIG.jitrl.similarityThreshold
    );
  });

  it('derives an L3 state from recent tools, errors and the working directory', async () => {
    const queries: ExperienceQuery[] = [];
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), queries)
    });
    await advisor.evaluate(
      makeRequest({
        state: undefined as unknown as AbstractState,
        recentTools: [
          { toolName: 'read' },
          { toolName: 'edit', isError: true, exitCode: 1 }
        ],
        errors: [{ toolName: 'edit', message: 'boom' }],
        workingDirectory: { path: 'C:\\tmp\\work', fileCount: 12, topExtensions: ['ts'] }
      })
    );
    expect(queries).toHaveLength(1);
    const state = (queries[0] as ExperienceQuery).state;
    expect(state.level).toBe('host_tool');
    expect(state.bucket).toBe('host|tool_error|unknown|tmp');
    expect(state.tokens).toContain('tool:read');
    expect(state.tokens).toContain('tool:edit');
    expect(state.tokens).toContain('err:tool_error');
    expect(state.tokens).toContain('wd:tmp');
  });

  it('rejects a non-host_tool state and derives one instead', async () => {
    const queries: ExperienceQuery[] = [];
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), queries)
    });
    await advisor.evaluate(
      makeRequest({
        state: makeState({ level: 'meta', bucket: 'meta|x|simple' }),
        recentTools: [{ toolName: 'read' }]
      })
    );
    const state = (queries[0] as ExperienceQuery).state;
    expect(state.level).toBe('host_tool');
    expect(state.bucket.startsWith('host|')).toBe(true);
  });

  it('causally truncates retrieval at the injected clock and forwards drift inputs', async () => {
    const queries: ExperienceQuery[] = [];
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      now: () => T0 + 1000,
      store: stubStore(scored(BALANCED_RECORDS), queries)
    });
    await advisor.evaluate(makeRequest({ policyId: 'policy-current', driftRho: 0.7 }));
    const query = queries[0] as ExperienceQuery;
    expect(query.before).toBe(T0 + 1000);
    expect(query.policyId).toBe('policy-current');
    expect(query.driftRho).toBe(0.7);
  });

  it('lets driftRho = 0 discard stale-policy-only evidence', async () => {
    const stale = BALANCED_RECORDS.map((record) =>
      makeRecord({
        id: record.id + '-stale',
        actionKey: record.actionKey,
        value: record.return,
        policyId: 'policy-old'
      })
    );
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(stale), [])
    });
    const decision = await advisor.evaluate(
      makeRequest({ policyId: 'policy-current', driftRho: 0 })
    );
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('no_neighbors');
    }
  });

  it('reuses an injected snapshot retriever instead of the store', async () => {
    const storeCalls: ExperienceQuery[] = [];
    const retrieverCalls = { n: 0 };
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored([]), storeCalls),
      retriever: snapshotRetriever(BALANCED_RECORDS, retrieverCalls)
    });
    const decision = await advisor.evaluate(
      makeRequest({ mode: 'gate', recentTools: [{ toolName: 'edit' }] })
    );
    expect(decision.kind).toBe('ask');
    expect(retrieverCalls.n).toBe(1);
    expect(storeCalls).toHaveLength(0);
  });
});

describe('host advisor: diagnostics surface', () => {
  it('exposes the advisor type and never mutates its diagnostic history', async () => {
    const advisor: HostAdvisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), [])
    });
    await advisor.evaluate(makeRequest());
    const first = advisor.diagnostics();
    const second = advisor.diagnostics();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
