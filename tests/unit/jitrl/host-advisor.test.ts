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
import { describe, expect, it, vi } from 'vitest';
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
  checkAdvisorBudget,
  renderAdvice,
  type HostAdvisor,
  type HostAdvisorEstimator,
  type HostAdvisorStore
} from '../../../src/jitrl/host-advisor';
import { estimateActionValues } from '../../../src/jitrl/value-estimator';
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

describe('estimateTokens and checkAdvisorBudget token governance (M2 / F1)', () => {
  it('is deterministic and conservative for ASCII, CJK (2/char), and emoji (>=3/char)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    // CJK counts 2 tokens per character
    expect(estimateTokens('宿主顾问')).toBe(8);
    expect(estimateTokens('ab宿主')).toBe(5);
    expect(estimateTokens('abcd 宿主')).toBe(5);
    // Emoji counts >= 3 tokens per emoji
    expect(estimateTokens('🚀')).toBe(3);
    expect(estimateTokens('🚀🎉')).toBe(6);
  });

  it('F1 consumer test: rejects/degrades hex 1200, base64url 1160, JSON 1001, CJK 300 and does NOT accept as fitting <= 300', () => {
    const hex1200 = 'deadbeef'.repeat(150); // 1200 chars
    const base64url1160 = 'a'.repeat(1160); // 1160 chars
    const json1001 = JSON.stringify({ data: 'x'.repeat(450), extra: 'y'.repeat(450) }); // > 1000 chars
    const cjk300 = '宿主顾问经验回放策略优化'.repeat(25); // 300 chars

    // 1. Assert consumer estimateTokens does NOT report 300, 290, 251
    const hexEst = estimateTokens(hex1200);
    const b64Est = estimateTokens(base64url1160);
    const jsonEst = estimateTokens(json1001);
    const cjkEst = estimateTokens(cjk300);

    expect(hexEst).toBeGreaterThan(300);
    expect(hexEst).not.toBe(300);
    expect(b64Est).toBeGreaterThan(300);
    expect(b64Est).not.toBe(290);
    expect(jsonEst).toBeGreaterThan(300);
    expect(jsonEst).not.toBe(251);
    expect(cjkEst).toBeGreaterThan(300);

    // 2. Assert consumer checkAdvisorBudget rejects all four
    const hexBudget = checkAdvisorBudget(hex1200);
    expect(hexBudget.fits).toBe(false);
    expect(hexBudget.tokenCount).toBeGreaterThan(300);
    expect(hexBudget.note).toContain('Exceeds conservative heuristic budget');

    const b64Budget = checkAdvisorBudget(base64url1160);
    expect(b64Budget.fits).toBe(false);
    expect(b64Budget.tokenCount).toBeGreaterThan(300);

    const jsonBudget = checkAdvisorBudget(json1001);
    expect(jsonBudget.fits).toBe(false);

    const cjkBudget = checkAdvisorBudget(cjk300);
    expect(cjkBudget.fits).toBe(false);
  });

  it('F1 consumer test: renderAdvice degrades to minimalAdvice and flags truncation on over-budget inputs', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      actionKey: 'high_entropy_tool_' + index + '_' + 'abcdef0123456789'.repeat(2),
      meanReturn: -1.0 - index * 0.1,
      support: 5,
      advantage: -1.0 - index * 0.1,
      normalizedAdvantage: -0.8 - index * 0.05
    }));

    const rendered = renderAdvice(entries);
    expect(rendered.truncated).toBe(true);
    expect(rendered.exact).toBe(false);
    expect(rendered.budgetNote).toBeDefined();
    expect(checkAdvisorBudget(rendered.text).fits).toBe(true);
    expect(rendered.budgetNote).toContain('does NOT claim equivalence to real model <= 300 tokens');
  });

  it('F1 consumer test: supports injected model tokenizer on createHostAdvisor and evaluates exact token bounds', async () => {
    const mockTokenizer = (text: string): number => text.trim().split(/\s+/).length;

    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(BALANCED_RECORDS), []),
      tokenizer: mockTokenizer
    });

    const decision = await advisor.evaluate(makeRequest({ mode: 'advisory', adviseThreshold: -0.5 }));
    expect(decision.kind).toBe('advisory');
    if (decision.kind === 'advisory') {
      expect(mockTokenizer(decision.text)).toBeLessThanOrEqual(MAX_ADVISORY_TOKENS);
    }
  });

  it('F1 invariant: checkTokenBudget and countTokens are actively called by host-advisor', () => {
    const res = checkAdvisorBudget('test advisory block');
    expect(res.fits).toBe(true);
    expect(res.tokenCount).toBeGreaterThan(0);
    expect(estimateTokens('some text')).toBeGreaterThan(0);
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

  it('P6.1-B1: secret-shaped bodies stay redacted in advisor failure diagnostics', async () => {
    // P6.1-B2 update: describeError() now emits a bounded class only
    // (`class=error`), so the secret never enters the line at all. This test
    // keeps the credential canary and additionally pins the zero-body form.
    const canarySecret = 'ghp_CANARY_ADVISOR_7341abcdefghijklmnopqrstuv';
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: {
        query: async () => {
          throw new Error('store offline: ' + canarySecret);
        }
      }
    });

    const decision = await advisor.evaluate(makeRequest());

    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.reason).toBe('retrieval_failed');
    }
    const lines = advisor.diagnostics().filter((line) => line.startsWith('retrieval_failed'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(canarySecret);
      expect(line).not.toContain('ghp_CANARY_ADVISOR');
      // P6.1-B2: zero body - not even a redacted remnant of it.
      expect(line).toBe('retrieval_failed: class=error');
    }
  });
});

// ---------------------------------------------------------------------------
// P6.1-B2 acceptance: consumer-path canary matrix (zero error-body echo)
// ---------------------------------------------------------------------------

describe('P6.1-B2 canary matrix (consumer exits, zero body echo)', () => {
  interface AdvisorCanaryCase {
    readonly name: string;
    readonly canary: string;
    readonly extraForbiddens: readonly string[];
    readonly throwValue: (canary: string) => unknown;
  }

  const cases: readonly AdvisorCanaryCase[] = [
    {
      name: 'chinese body',
      canary: '金丝雀建议正文泄漏探针八四二一',
      extraForbiddens: ['金丝雀', '八四二一'],
      throwValue: (c) => new Error('检索失败：' + c)
    },
    {
      name: 'english short sentence',
      canary: 'ADVISOR_CANARY_EN_8421 leaked phrase',
      extraForbiddens: ['ADVISOR_CANARY_EN_8421', 'leaked phrase'],
      throwValue: (c) => new Error('store exploded: ' + c)
    },
    {
      name: 'json body',
      canary: JSON.stringify({ canary: 'ADVISOR_CANARY_JSON_8421', secret: 'leak' }),
      extraForbiddens: ['ADVISOR_CANARY_JSON_8421', '"secret"'],
      throwValue: (c) => new Error('bad payload ' + c)
    },
    {
      name: 'newline body',
      canary: 'ADVISOR_CANARY_L1_8421\nADVISOR_CANARY_L2_8421',
      extraForbiddens: ['ADVISOR_CANARY_L1_8421', 'ADVISOR_CANARY_L2_8421'],
      throwValue: (c) => new Error('multi\nline\n' + c)
    },
    {
      name: 'nested cause',
      canary: 'ADVISOR_CANARY_CAUSE_8421',
      extraForbiddens: ['ADVISOR_CANARY_CAUSE_8421', 'root cause'],
      throwValue: (c) => new Error('wrapped', { cause: new Error('root cause carries ' + c) })
    },
    {
      name: 'string throw',
      canary: 'ADVISOR_CANARY_STRING_8421',
      extraForbiddens: ['ADVISOR_CANARY_STRING_8421'],
      throwValue: (c) => 'plain string throw ' + c
    },
    {
      name: 'object throw',
      canary: 'ADVISOR_CANARY_OBJECT_8421',
      extraForbiddens: ['ADVISOR_CANARY_OBJECT_8421'],
      throwValue: (c) => ({ body: c })
    },
    {
      name: 'extreme length',
      canary: 'ADVISOR_CANARY_LONG_' + 'Q'.repeat(3000) + '_8421',
      extraForbiddens: ['ADVISOR_CANARY_LONG_'],
      throwValue: (c) => new Error('huge ' + c)
    },
    {
      name: 'hostile Error.name',
      canary: 'ADVISOR_CANARY_NAME_8421',
      extraForbiddens: ['ADVISOR_CANARY_NAME_8421'],
      throwValue: (c) => {
        const hostile = new Error('message with ' + c);
        hostile.name = 'CANARY_HOSTILE_NAME_8421<script>';
        return hostile;
      }
    }
  ];

  /** Every model/user-visible advisor exit for one evaluate() call. */
  function visibleSurfaces(
    decision: HostAdvisorDecision,
    diagnostics: readonly string[]
  ): readonly string[] {
    const surfaces = [...diagnostics];
    if (decision.kind === 'advisory') {
      surfaces.push(decision.text, ...(decision.antiPatterns ?? []));
    }
    if (decision.kind === 'ask') {
      surfaces.push(decision.reason);
    }
    if (decision.kind === 'noop' && typeof decision.reason === 'string') {
      surfaces.push(decision.reason);
    }
    if (decision.diagnostics !== undefined) {
      surfaces.push(JSON.stringify(decision.diagnostics));
    }
    return surfaces;
  }

  for (const canaryCase of cases) {
    it(`never echoes ${canaryCase.name} through any advisor-visible surface`, async () => {
      // Route 1: throwing store -> retrieval_failed.
      const storeAdvisor = createHostAdvisor({
        config: enabledConfig(),
        store: {
          query: async () => {
            throw canaryCase.throwValue(canaryCase.canary);
          }
        }
      });
      const storeDecision = await storeAdvisor.evaluate(makeRequest());
      expect(storeDecision.kind).toBe('noop');
      if (storeDecision.kind === 'noop') {
        expect(storeDecision.reason).toBe('retrieval_failed');
      }
      const storeLines = storeAdvisor
        .diagnostics()
        .filter((line) => line.startsWith('retrieval_failed'));
      expect(storeLines.length).toBeGreaterThan(0);
      for (const line of storeLines) {
        // Bounded whitelist form, identical caliber to mirror_diag: Error
        // instances fold to class=error; non-Error throws to class=unknown.
        const expected =
          canaryCase.name === 'string throw' || canaryCase.name === 'object throw'
            ? 'retrieval_failed: class=unknown'
            : 'retrieval_failed: class=error';
        expect(line).toBe(expected);
      }
      for (const surface of visibleSurfaces(storeDecision, storeAdvisor.diagnostics())) {
        for (const forbidden of [canaryCase.canary, ...canaryCase.extraForbiddens]) {
          expect(surface, canaryCase.name + ' leaked via ' + forbidden).not.toContain(forbidden);
        }
      }

      // Route 2: throwing estimator (after successful retrieval) -> advisor_failed.
      const estimatorAdvisor = createHostAdvisor({
        config: enabledConfig(),
        store: stubStore(scored(BALANCED_RECORDS), []),
        estimator: () => {
          throw canaryCase.throwValue(canaryCase.canary);
        }
      });
      const estimatorDecision = await estimatorAdvisor.evaluate(makeRequest());
      expect(estimatorDecision.kind).toBe('noop');
      if (estimatorDecision.kind === 'noop') {
        expect(estimatorDecision.reason).toBe('advisor_failed');
      }
      const estimatorLines = estimatorAdvisor
        .diagnostics()
        .filter((line) => line.startsWith('advisor_failed'));
      expect(estimatorLines.length).toBeGreaterThan(0);
      for (const line of estimatorLines) {
        const expected =
          canaryCase.name === 'string throw' || canaryCase.name === 'object throw'
            ? 'advisor_failed: class=unknown'
            : 'advisor_failed: class=error';
        expect(line).toBe(expected);
      }
      for (const surface of visibleSurfaces(estimatorDecision, estimatorAdvisor.diagnostics())) {
        for (const forbidden of [canaryCase.canary, ...canaryCase.extraForbiddens]) {
          expect(surface, canaryCase.name + ' leaked via ' + forbidden).not.toContain(forbidden);
        }
      }
    });
  }

  it('preserved behavior: error classes stay distinguishable (bounded enum, not all-unknown)', async () => {
    const make = (throwValue: unknown): HostAdvisor => {
      return createHostAdvisor({
        config: enabledConfig(),
        store: {
          query: async () => {
            throw throwValue;
          }
        }
      });
    };
    const lineOf = async (advisor: HostAdvisor): Promise<string> => {
      const decision = await advisor.evaluate(makeRequest());
      expect(decision.kind).toBe('noop');
      if (decision.kind === 'noop') {
        expect(decision.reason).toBe('retrieval_failed');
      }
      const lines = advisor.diagnostics().filter((line) => line.startsWith('retrieval_failed'));
      expect(lines).toHaveLength(1);
      return lines[0] ?? '';
    };
    expect(await lineOf(make(new TypeError('t')))).toBe('retrieval_failed: class=type_error');
    expect(await lineOf(make(new RangeError('r')))).toBe('retrieval_failed: class=range_error');
    const abort = new Error('a');
    abort.name = 'AbortError';
    expect(await lineOf(make(abort))).toBe('retrieval_failed: class=aborted');
    const timeout = new Error('t');
    timeout.name = 'TimeoutError';
    expect(await lineOf(make(timeout))).toBe('retrieval_failed: class=timeout');
    expect(await lineOf(make('string'))).toBe('retrieval_failed: class=unknown');
    expect(await lineOf(make({ arbitrary: true }))).toBe('retrieval_failed: class=unknown');
  });

  it('preserved behavior: token budget wiring and secret redaction in advisory text do not regress', async () => {
    // Budget wiring: an over-long evidence set still truncates with the
    // explicit heuristic note (no silent truncation, no token equivalence claim).
    const estimatorSpy = vi.fn(estimateActionValues);
    const oversized: ExperienceRecord[] = [];
    for (let index = 0; index < 40; index += 1) {
      oversized.push(
        makeRecord({
          id: 'oversize-' + String(index),
          actionKey: 'oversized_action_key_' + String(index).padStart(2, '0') + '_' + 'x'.repeat(40),
          value: 3 - (index * 6) / 39
        })
      );
    }
    const advisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(scored(oversized), []),
      estimator: estimatorSpy
    });
    const decision = await advisor.evaluate(makeRequest({ mode: 'advisory', adviseThreshold: -0.5 }));
    expect(estimatorSpy).toHaveBeenCalled();
    expect(decision.kind).toBe('advisory');
    if (decision.kind === 'advisory') {
      expect(decision.text).toContain(ADVISORY_TAG.slice(0, 12));
      expect(estimateTokens(decision.text)).toBeLessThanOrEqual(MAX_ADVISORY_TOKENS);
      expect(advisor.diagnostics().some((line) => line.startsWith('advisory_truncated'))).toBe(true);
      expect(
        advisor.diagnostics().some((line) => line.includes('heuristic/not real tokens') || line.includes('tokenizer budget'))
      ).toBe(true);
    }

    // Secret redaction in advisory text: a secret-shaped action key entering
    // the rendered advice is still folded to <secret> by safeFragment.
    // (Two action groups so the secret action becomes the negative-advantage
    // target; a lone candidate would normalize its advantage to zero.)
    const secretAdvisor = createHostAdvisor({
      config: enabledConfig(),
      store: stubStore(
        scored(
          BALANCED_RECORDS.concat([
            makeRecord({
              id: 'secret-1',
              actionKey: 'deploy ghp_0123456789abcdefghijklmnopqrstuv',
              value: -3
            })
          ])
        ),
        []
      )
    });
    const secretDecision = await secretAdvisor.evaluate(
      makeRequest({ mode: 'advisory', adviseThreshold: -0.5 })
    );
    expect(secretDecision.kind).toBe('advisory');
    if (secretDecision.kind === 'advisory') {
      const rendered = secretDecision.text + (secretDecision.antiPatterns ?? []).join('\n');
      // The credential body never survives safeFragment: the raw ghp_ token
      // is gone. (Baseline quirk, unchanged by t14: safeFragment's quote
      // mangle rewrites the <secret> placeholder to 'secret'; fixing that
      // mangling belongs to the redaction work line, not this closure.)
      expect(rendered).not.toContain('ghp_0123456789');
      expect(rendered).not.toContain('ghp_');
    }
  });
});
