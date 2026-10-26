import { describe, expect, it } from 'vitest';
import { parseEvoHarnessConfig } from '../../src/config';
import { createMemoryBridge, parseLessonDocument } from '../../src/memory-bridge';
import { createEvoHarnessPlugin } from '../../src/index';
import { resolveExecutionProfile } from '../../src/runtime/execution-profile';
import type { CanonicalLesson } from '../../src/types/contracts';
import {
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  lingshuLikeServer,
  makeClock,
  makeIdFactory,
  mem0LikeServer,
  officialKgLikeServer
} from './fixtures';
import type { MockMemoryServer } from './fixtures';

interface BackendCase {
  readonly label: string;
  readonly factory: (serverId?: string) => MockMemoryServer;
  readonly driverKind: string;
  readonly commitTools: readonly string[];
  readonly recallTools: readonly string[];
}

const BACKENDS: readonly BackendCase[] = [
  {
    label: 'Mem0-like vector/fact fingerprint',
    factory: mem0LikeServer,
    driverKind: 'vector_fact',
    commitTools: ['add_memories'],
    recallTools: ['search_memory']
  },
  {
    label: 'official knowledge-graph fingerprint',
    factory: officialKgLikeServer,
    driverKind: 'graph_entity',
    commitTools: ['create_entities'],
    recallTools: ['search_nodes', 'read_graph']
  },
  {
    label: 'Lingshu (dsh-memory) white-box fingerprint',
    factory: lingshuLikeServer,
    driverKind: 'lingshu_mdcg',
    commitTools: ['cg'],
    recallTools: ['cg', 'stg']
  }
];

function makeLesson(overrides: Partial<CanonicalLesson> = {}): CanonicalLesson {
  return {
    id: 'lesson_e2e_negative',
    title: 'Avoid retrying the build before the failing tool is identified',
    whenToApply: ['observedSignal=tool_error'],
    subFunctions: ['guardrails'],
    executionPatch: { summary: 'Identify the failing tool before any retry.' },
    verificationEvidence: {
      referenceFailure: 'reference failed with exit 1 after 3 steps',
      candidateSuccess: 'candidate succeeded after 3 steps with zero tool errors',
      metricsDelta: { stepsDiff: 0, toolErrorsDiff: -1 }
    },
    whenNotToApply: ['do not apply when the build already passes'],
    polarity: 'negative',
    visibility: 'session',
    sessionId: 'sess-e2e-backends',
    confidence: 0.6,
    ...overrides
  };
}

describe.each(BACKENDS)('$label', (backend) => {
  it('auto-binds the fingerprint and commits governed lessons through its own tools', async () => {
    const server = backend.factory();
    const config = parseEvoHarnessConfig(e2eConfig());
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('backend'),
        // t10/R2: this suite IS the governed-commit machinery test against
        // an in-memory mock backend - explicit permission opt-in.
        deps: { memory, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-e2e-backends',
      task: plugin.makeTask({ id: 'task-e2e-backends', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(memory.descriptor.driverKind).toBe(backend.driverKind);
    expect(result.metadata?.memoryDriverKind).toBe(backend.driverKind);
    expect(server.toolNames().length).toBeGreaterThan(0);

    // governed commit went through this family's own commit tool
    const commitCalls = backend.commitTools.flatMap((tool) => server.callsTo(tool));
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(1);
    expect(server.records.length).toBeGreaterThanOrEqual(1);

    // the stored envelope is a complete six-element CanonicalLesson
    const record = server.records[0];
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }
    expect(record.polarity).toBe('positive');
    const parsed = parseLessonDocument(record.text);
    expect(parsed).toBeDefined();
    if (parsed === undefined) {
      return;
    }
    const lesson = parsed.lesson;
    expect(lesson.title.length).toBeGreaterThan(0);
    expect(lesson.whenToApply.length).toBeGreaterThan(0);
    expect(lesson.whenNotToApply.length).toBeGreaterThan(0);
    expect(lesson.subFunctions.length).toBeGreaterThan(0);
    expect(lesson.executionPatch.summary.length).toBeGreaterThan(0);
    expect(lesson.verificationEvidence.candidateSuccess.length).toBeGreaterThan(0);

    // the probe's branch-scoped memory handles were all released
    expect(memory.activeNamespaces()).toEqual([]);

    // and the backend's recall tool was exercised during the run
    const recallCalls = backend.recallTools.flatMap((tool) => server.callsTo(tool));
    expect(recallCalls.length).toBeGreaterThan(0);
  });

  it('t12/R2-residual: the DEFAULT assembly never calls the memory bridge (zero backend writes)', async () => {
    // t11 blocker: the t10 revision issued a real governed-commit request with a
    // renamed "ephemeral" scope and let the host bridge refuse it, so a bridge
    // that accepted any scope persisted a denied write. This runs the REAL
    // plugin assembly (default profile, no permission opt-in) against a mock
    // backend that would happily accept the write and asserts the backend saw
    // NOTHING: zero commit-tool calls, zero records, zero committed lessons.
    const server = backend.factory();
    const config = parseEvoHarnessConfig(e2eConfig());
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config: {
          ...config,
          memoryBridge: { ...config.memoryBridge, promoteOnComposeSuccess: true }
        },
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('backend-denied'),
        deps: { memory }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-e2e-denied',
      task: plugin.makeTask({ id: 'task-e2e-denied', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBe(0);
    expect(server.records.length).toBe(0);
    // The commit tools are also recall tools for the white-box (cg) family, so
    // count WRITE-shaped calls only: a non-write op can never have persisted.
    const writeCalls = backend.commitTools
      .flatMap((tool) => server.callsTo(tool))
      .filter((call) => call.args['op'] === undefined || call.args['op'] === 'write');
    expect(writeCalls, 'the denied assembly must not issue a memory write').toEqual([]);
    const diagnostics = result.diagnostics.join(' ');
    expect(diagnostics).toContain('memory permission');
    expect(diagnostics).toContain('NOT committed');
    expect(diagnostics).not.toContain('ephemeral');
    // Recall still works (the denial is a write-side gate, not a memory blackout).
    expect(backend.recallTools.flatMap((tool) => server.callsTo(tool)).length).toBeGreaterThan(0);
  });

  it('round-trips a committed lesson back through recall with the negative firewall intact', async () => {
    const server = backend.factory();
    const config = parseEvoHarnessConfig(e2eConfig());
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    await memory.initialize();

    const scope = { kind: 'session', sessionId: 'sess-roundtrip' } as const;
    const positive = makeLesson({
      id: 'lesson_positive',
      title: 'Mount the build SOP before retrying the tool',
      polarity: 'positive',
      sessionId: 'sess-roundtrip',
      whenToApply: ['taskSignature=build-failure'],
      whenNotToApply: ['do not apply when the build already passes']
    });
    const negative = makeLesson({
      id: 'lesson_negative',
      polarity: 'negative',
      sessionId: 'sess-roundtrip'
    });

    const positiveCommit = await memory.commit(positive, { scope, enforceGovernance: true });
    const negativeCommit = await memory.commit(negative, { scope, enforceGovernance: true });
    expect(positiveCommit.accepted).toBe(true);
    expect(negativeCommit.accepted).toBe(true);

    const recalled = await memory.recall({
      scope,
      text: 'Fix the failing build with the SOP',
      taskSignature: 'build-failure',
      includeNegative: true,
      limit: 5
    });

    expect(recalled.driverKind).toBe(backend.driverKind);
    expect(recalled.lessons.length).toBeGreaterThanOrEqual(2);
    // positive lessons are recommendations, negative lessons are never among them
    expect(recalled.positiveLessons.every((lesson) => lesson.polarity === 'positive')).toBe(true);
    expect(recalled.positiveLessons.some((lesson) => lesson.id === 'lesson_positive')).toBe(true);
    expect(recalled.negativeLessons.some((lesson) => lesson.id === 'lesson_negative')).toBe(true);
    expect(recalled.positiveLessons.some((lesson) => lesson.id === 'lesson_negative')).toBe(false);
  });
});

describe('governance gate', () => {
  it('blocks a lesson that violates the six-element envelope before any backend write', async () => {
    const server = mem0LikeServer();
    const config = parseEvoHarnessConfig(e2eConfig());
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now: makeClock() });
    await memory.initialize();
    const before = server.calls.length;

    const invalid = makeLesson({ id: 'lesson_invalid', whenNotToApply: [] });
    const outcome = await memory.commit(invalid, {
      scope: { kind: 'session', sessionId: 'sess-gov' },
      enforceGovernance: true
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.violations.some((violation) => violation.code === 'missing_when_not_to_apply')).toBe(true);
    expect(server.calls.length).toBe(before);
    expect(server.records.some((record) => record.id === 'lesson_invalid')).toBe(false);
  });
});

describe('post-compose lesson evidence and cross-session promotion', () => {
  it('attaches candidate patch componentDiffs to negative lessons', async () => {
    const server = mem0LikeServer();
    const config = parseEvoHarnessConfig(e2eConfig({ maxWidth: 2, maxDepth: 1, rolloutBudget: 4 }));
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        // candidate 0 fails with a repairable tool error, candidate 1 recovers
        runBranch: createScriptedRunner(now, { candidateOutcomes: ['fail', 'succeed'] }),
        now,
        newId: makeIdFactory('evidence'),
        deps: { memory, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-evidence',
      task: plugin.makeTask({ id: 'task-evidence', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    const recalled = await memory.recall({
      scope: { kind: 'session', sessionId: 'sess-evidence' },
      text: 'Fix the failing build.',
      includeNegative: true,
      limit: 10
    });
    expect(recalled.negativeLessons.length).toBeGreaterThanOrEqual(1);
    const withDiffs = recalled.negativeLessons.find((lesson) => {
      const diffs = lesson.executionPatch.componentDiffs;
      return diffs !== undefined && Object.keys(diffs).length > 0;
    });
    // pre-fix reflect() received no metadata.candidatePatches, so componentDiffs
    // was always undefined for negative lessons
    expect(withDiffs).toBeDefined();
    expect(Object.keys(withDiffs?.executionPatch.componentDiffs ?? {})).toContain('guardrails');
  });

  it('promotes committed positive lessons to global scope for later sessions (explicit opt-in)', async () => {
    const server = mem0LikeServer();
    // P6.2 C1 (ADR 0002 R2): the default assembly keeps REAL memory writes
    // denied, so the promotion machinery is exercised with an explicit opt-in.
    const config = parseEvoHarnessConfig(
      e2eConfig({ config: { memoryBridge: { promoteOnComposeSuccess: true } } })
    );
    expect(config.memoryBridge.promoteOnComposeSuccess).toBe(true);
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('promote'),
        // t10/R2: promoteOnComposeSuccess is only the REQUEST half; the
        // deterministic test assembly (in-memory mock backend) explicitly
        // opts in on the PERMISSION half. The default assembly still denies.
        deps: { memory, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-a',
      task: plugin.makeTask({ id: 'task-promote', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.join(' ')).toContain('promoted lesson');

    // a later session reads the promoted lesson through its visible global scope
    const laterSession = await memory.recall({
      scope: { kind: 'session', sessionId: 'sess-b' },
      text: 'Fix the failing build.',
      includeNegative: true,
      limit: 10
    });
    const globalLesson = laterSession.positiveLessons.find(
      (lesson) => lesson.visibility === 'global'
    );
    expect(globalLesson).toBeDefined();
  });

  it('respects promoteOnComposeSuccess=false', async () => {
    const server = mem0LikeServer();
    const config = parseEvoHarnessConfig(
      e2eConfig({ config: { memoryBridge: { promoteOnComposeSuccess: false } } })
    );
    expect(config.memoryBridge.promoteOnComposeSuccess).toBe(false);
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('nopromo'),
        // t10/R2: the negative promoteOnComposeSuccess=false case - the explicit
        // opt-in only arms the REQUEST half; the flag still denies, and the
        // permission half stays granted in this fake-backend assembly so the
        // test isolates the config flag's effect.
        deps: { memory, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-nopromo',
      task: plugin.makeTask({ id: 'task-nopromo', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.join(' ')).not.toContain('promoted lesson');

    const laterSession = await memory.recall({
      scope: { kind: 'session', sessionId: 'sess-other' },
      text: 'Fix the failing build.',
      includeNegative: true,
      limit: 10
    });
    expect(laterSession.positiveLessons).toEqual([]);
  });

  it('records a promotion failure without aborting the run (explicit opt-in)', async () => {
    const server = mem0LikeServer();
    // P6.2 C1: promotion is a real memory write - explicit opt-in required.
    const config = parseEvoHarnessConfig(
      e2eConfig({ config: { memoryBridge: { promoteOnComposeSuccess: true } } })
    );
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const failingMemory: typeof memory = {
      ...memory,
      promote: async () => {
        throw new Error('promotion backend down');
      }
    };
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('promofail'),
        // t10/R2: the explicit permission opt-in keeps the promotion-failure
        // path reachable in this fake-backend assembly.
        deps: { memory: failingMemory, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-promofail',
      task: plugin.makeTask({ id: 'task-promofail', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.join(' ')).toContain('promotion failed');
  });
});


