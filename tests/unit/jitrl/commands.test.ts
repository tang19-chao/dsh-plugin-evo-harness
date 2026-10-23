/**
 * P3-E / G2-2: pure /evo jit command layer.
 *
 * Each describe block pins one subcommand against a deterministic fake
 * controller; a final block pins redaction and the no-throw usage behaviour.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  executeJitCommand,
  JIT_COMMAND_USAGE,
  parseJitArgs,
  splitJitArgs,
  type JitCommandController,
  type JitRecentDecision
} from '../../../src/jitrl/commands';

const ROW = {
  candidate: 'guardrails:precondition(shell)',
  source: 'llm' as const,
  baseLogit: 0.9,
  q: -1.2,
  advantage: -1,
  normalizedAdvantage: -0.8,
  adjustedLogit: 0.1,
  note: 'same-signature tasks were denied by this guardrail'
};

function makeDecision(index: number): JitRecentDecision {
  return {
    decisionId: 'decision-' + String(index),
    level: 'meta',
    stateValue: 0.6,
    neighborCount: 5,
    klToPrior: 0.273,
    adjustments: [ROW],
    rationale: 'nearest neighbours 5'
  };
}

const DECISIONS: readonly JitRecentDecision[] = [
  makeDecision(1),
  makeDecision(2),
  makeDecision(3)
];

function makeController(
  overrides: Partial<JitCommandController> = {}
): JitCommandController {
  let enabled = true;
  const decisions = DECISIONS;
  const base: JitCommandController = {
    isEnabled: () => enabled,
    setEnabled: (next) => {
      enabled = next;
      return enabled;
    },
    levels: () => ['meta'],
    storeSize: (level) => (level === 'meta' ? 3 : 0),
    bucketCoverage: () => [{ level: 'meta', bucket: 'sig|moderate', count: 3 }],
    cacheStats: () => ({
      size: 1,
      maxEntries: 64,
      hits: 2,
      misses: 1,
      evictions: 0
    }),
    recentDecisions: (limit) => decisions.slice(0, limit),
    findDecision: (runId) => decisions.find((decision) => decision.decisionId === runId),
    reset: async (bucket) => ({ dropped: bucket === undefined ? 3 : 1, supported: true })
  };
  return { ...base, ...overrides };
}

describe('argument parsing', () => {
  it('splits raw /evo text into tokens', () => {
    expect(splitJitArgs('  status ')).toEqual(['status']);
    expect(splitJitArgs('explain run-1')).toEqual(['explain', 'run-1']);
    expect(splitJitArgs('   ')).toEqual([]);
  });

  it('parses commands, run ids, buckets and confirmation flags', () => {
    expect(parseJitArgs(['status'])).toEqual({ command: 'status', confirm: false });
    expect(parseJitArgs(['explain', 'decision-2'])).toEqual({
      command: 'explain',
      runId: 'decision-2',
      confirm: false
    });
    expect(parseJitArgs(['reset', 'bucket-a'])).toEqual({
      command: 'reset',
      bucket: 'bucket-a',
      confirm: false
    });
    expect(parseJitArgs(['reset', '--confirm'])).toEqual({
      command: 'reset',
      confirm: true
    });
    expect(parseJitArgs(['reset', 'bucket-a', '-y'])).toEqual({
      command: 'reset',
      bucket: 'bucket-a',
      confirm: true
    });
  });
});

describe('/evo jit status', () => {
  it('reports sizes, bucket coverage, cache stats and recent decisions', async () => {
    const result = await executeJitCommand(['status'], makeController());
    expect(result.ok).toBe(true);
    expect(result.command).toBe('status');
    expect(result.text).toContain('enabled: true');
    expect(result.text).toContain('storeSize: 3');
    expect(result.text).toContain('level meta: 3');
    expect(result.text).toContain('meta|sig|moderate: 3');
    expect(result.text).toContain('cache: size=1 maxEntries=64 hits=2 misses=1 evictions=0');
    expect(result.text).toContain('recentDecisions: 3');
    expect(result.text).toContain('decision-1: V=0.600 neighbors=5 kl=0.273');
    const json = result.json as Record<string, unknown>;
    expect(json['storeSize']).toBe(3);
    expect(json['cacheStats']).toEqual({
      size: 1,
      maxEntries: 64,
      hits: 2,
      misses: 1,
      evictions: 0
    });
    expect((json['recentDecisions'] as readonly unknown[]).length).toBe(3);
  });

  it('caps the decision list at ten entries', async () => {
    const many = Array.from({ length: 12 }, (_, index) => makeDecision(index + 1));
    const result = await executeJitCommand(
      ['status'],
      makeController({
        recentDecisions: (limit) => many.slice(0, Math.min(limit, 10))
      })
    );
    expect(result.text).toContain('recentDecisions: 10');
    expect(
      (result.json as Record<string, unknown>)['recentDecisions'] as readonly unknown[]
    ).toHaveLength(10);
  });

  it('says disabled when the in-process switch is off', async () => {
    const result = await executeJitCommand(
      ['status'],
      makeController({ isEnabled: () => false })
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('enabled: false');
    expect(result.text).toContain('JitRL is disabled');
    expect((result.json as Record<string, unknown>)['enabled']).toBe(false);
  });
});

describe('/evo jit explain', () => {
  it('renders the five section 13.1 columns plus note', async () => {
    const result = await executeJitCommand(
      ['explain', 'decision-1'],
      makeController()
    );
    expect(result.ok).toBe(true);
    expect(result.command).toBe('explain');
    for (const column of ['candidate', 'source', 'Base z', 'Q̂', 'Ã', "JitRL z'", 'note']) {
      expect(result.text).toContain(column);
    }
    expect(result.text).toContain('guardrails:precondition(shell)');
    expect(result.text).toContain('llm');
    expect(result.text).toContain('0.900');
    expect(result.text).toContain('-1.200');
    expect(result.text).toContain('-0.800');
    expect(result.text).toContain('0.100');
    const json = result.json as Record<string, unknown>;
    expect(json['runId']).toBe('decision-1');
    const rows = json['rows'] as readonly Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidate: 'guardrails:precondition(shell)',
      source: 'llm',
      baseLogit: 0.9,
      q: -1.2,
      normalizedAdvantage: -0.8,
      adjustedLogit: 0.1
    });
  });

  it('returns an empty table gracefully when JitRL is disabled', async () => {
    const result = await executeJitCommand(
      ['explain', 'decision-1'],
      makeController({ isEnabled: () => false })
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('no decision table is available');
    expect(result.text).toContain('| candidate | source | Base z | Q̂ | Ã | JitRL z\' | note |');
    expect((result.json as Record<string, unknown>)['rows']).toEqual([]);
  });

  it('returns an empty table without throwing for an unknown run id', async () => {
    const result = await executeJitCommand(
      ['explain', 'missing-run'],
      makeController()
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('no decision recorded');
    expect((result.json as Record<string, unknown>)['rows']).toEqual([]);
  });

  it('requires a run id', async () => {
    const result = await executeJitCommand(['explain'], makeController());
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(JIT_COMMAND_USAGE);
    expect(result.text).toContain('explain requires a run id');
  });
});

describe('/evo jit reset', () => {
  it('requires --confirm before clearing all experience', async () => {
    const reset = vi.fn(async () => ({ dropped: 3, supported: true }));
    const result = await executeJitCommand(['reset'], makeController({ reset }));
    expect(result.ok).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(result.text).toContain('--confirm');
    expect((result.json as Record<string, unknown>)['requiresConfirmation']).toBe(true);
    expect((result.json as Record<string, unknown>)['dropped']).toBe(0);
  });

  it('clears all experience with an explicit confirmation', async () => {
    const reset = vi.fn(async () => ({ dropped: 3, supported: true }));
    const result = await executeJitCommand(
      ['reset', '--confirm'],
      makeController({ reset })
    );
    expect(reset).toHaveBeenCalledWith(undefined);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('dropped 3 record(s)');
    expect((result.json as Record<string, unknown>)['dropped']).toBe(3);
  });

  it('clears one bucket without a confirmation', async () => {
    const reset = vi.fn(async (bucket?: string) => ({
      dropped: bucket === 'bucket-a' ? 2 : 0,
      supported: true
    }));
    const result = await executeJitCommand(
      ['reset', 'bucket-a'],
      makeController({ reset })
    );
    expect(reset).toHaveBeenCalledWith('bucket-a');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('reset bucket bucket-a: dropped 2 record(s)');
  });

  it('reports an unsupported store driver instead of pretending', async () => {
    const result = await executeJitCommand(
      ['reset', '--confirm'],
      makeController({
        reset: async () => ({
          dropped: 0,
          supported: false,
          note: 'append-only store driver'
        })
      })
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('is unavailable');
    expect(result.text).toContain('append-only store driver');
  });
});

describe('/evo jit on|off', () => {
  it('toggles the volatile in-process switch and reports the new state', async () => {
    const controller = makeController();
    const off = await executeJitCommand(['off'], controller);
    expect(off.ok).toBe(true);
    expect(off.text).toContain('jitrl: off');
    expect((off.json as Record<string, unknown>)['enabled']).toBe(false);
    expect(controller.isEnabled()).toBe(false);
    const on = await executeJitCommand(['on'], controller);
    expect(on.text).toContain('jitrl: on');
    expect(controller.isEnabled()).toBe(true);
    expect((on.json as Record<string, unknown>)['persisted']).toBe(false);
  });
});

describe('usage and privacy', () => {
  it('returns a usage result for unknown or empty commands without throwing', async () => {
    for (const tokens of [[], ['nonsense'], ['status', 'extra']]) {
      const result = await executeJitCommand(tokens, makeController());
      if (tokens[0] === 'status') {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        expect(result.command).toBe('usage');
        expect(result.text).toBe(JIT_COMMAND_USAGE);
      }
    }
  });

  it('never echoes secrets or absolute paths', async () => {
    const secretRow = {
      ...ROW,
      note: 'saw sk-live-abcdef123456 under C:\\Users\\bob\\app.ts'
    };
    const decision: JitRecentDecision = {
      ...makeDecision(1),
      rationale: 'token ghp_abcdefghijklmnopqrstuvwxyz at /home/bob/secret',
      adjustments: [secretRow]
    };
    const controller = makeController({
      findDecision: () => decision,
      bucketCoverage: () => [
        { level: 'meta', bucket: 'sig C:\\Users\\bob|sk-live-abcdef', count: 1 }
      ]
    });
    const explain = await executeJitCommand(['explain', 'decision-1'], controller);
    const status = await executeJitCommand(['status'], controller);
    for (const result of [explain, status]) {
      expect(result.text).not.toContain('sk-live-abcdef');
      expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(result.text).not.toContain('C:\\Users\\bob');
      expect(result.text).not.toContain('/home/bob/secret');
      expect(JSON.stringify(result.json)).not.toContain('sk-live-abcdef');
      expect(JSON.stringify(result.json)).not.toContain('C:\\Users\\bob');
    }
  });
});

describe('command-layer scrub vs structured keys (P3-FIX3)', () => {
  const EIGHT_SURFACE_KEY =
    'slot:exploit/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance';
  const keys = [
    EIGHT_SURFACE_KEY,
    'slot:explore_domain/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance',
    'slot:explore_invariant/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance',
    'slot:recover/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance'
  ];

  it('renders four DISTINCT explain rows with the full action key intact', async () => {
    const decision: JitRecentDecision = {
      ...makeDecision(9),
      decisionId: 'decision-9',
      adjustments: keys.map((candidate, index) => ({
        ...ROW,
        candidate,
        source: 'policy_prior' as const,
        baseLogit: index * 0.1
      }))
    };
    const result = await executeJitCommand(['explain', 'decision-9'], makeController({
      findDecision: (runId) => (runId === 'decision-9' ? decision : undefined)
    }));
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain('<secret>');
    for (const key of keys) {
      expect(result.text).toContain(key);
    }
    const json = result.json as Record<string, unknown>;
    const rows = json['rows'] as readonly { candidate: string }[];
    expect(rows.map((row) => row.candidate)).toEqual(keys);
  });

  it('still folds credentials and renders absolute paths as <path>', async () => {
    const decision: JitRecentDecision = {
      ...makeDecision(10),
      decisionId: 'decision-10',
      adjustments: [
        { ...ROW, candidate: 'password hunter2', note: 'see C:/Users/Admin/Documents/Codex/jit-active-policy.ts' }
      ]
    };
    const result = await executeJitCommand(['explain', 'decision-10'], makeController({
      findDecision: (runId) => (runId === 'decision-10' ? decision : undefined)
    }));
    expect(result.text).not.toContain('password hunter2');
    expect(result.text).toContain('<secret>');
    expect(result.text).toContain('<path>');
    expect(result.text).not.toContain('C:/Users');
    expect(result.text).not.toContain('<secret>.ts');
  });
});
