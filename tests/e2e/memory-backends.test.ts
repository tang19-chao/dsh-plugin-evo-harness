import { describe, expect, it } from 'vitest';
import { parseEvoHarnessConfig } from '../../src/config';
import { createMemoryBridge, parseLessonDocument } from '../../src/memory-bridge';
import { createEvoHarnessPlugin } from '../../src/index';
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
        deps: { memory }
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
