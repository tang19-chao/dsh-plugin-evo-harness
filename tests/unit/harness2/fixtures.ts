/**
 * Shared deterministic fixtures for the Harness² unit tests.
 *
 * Nothing here touches a host, MCP server, sandbox or network: every adapter is
 * a scripted in-memory fake, so the whole suite is deterministic.
 */

import type {
  BatchSlotPlan,
  CanonicalLesson,
  CandidateAssessment,
  CompositionResult,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  EightSurfacePatch,
  IModelAdapter,
  MemoryRecallResult,
  ModelRequest,
  ModelResponse,
  ProbeCandidate,
  ProbeTask,
  ProbeTrajectory,
  ProposeRequest,
  ReflectionRequest
} from '../../../src/types/contracts';

/** Monotonic fake clock; each call advances by one second. */
export function fixedClock(start: number = 1_700_000_000_000): () => number {
  let current = start;
  return () => {
    current += 1000;
    return current;
  };
}

/** Scripted model adapter that records every request. */
export interface ScriptedModel extends IModelAdapter {
  readonly requests: ModelRequest[];
}

export function scriptedModel(script: readonly (string | Error | ModelResponse)[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      const entry = script[Math.min(index, Math.max(0, script.length - 1))];
      index += 1;
      if (entry === undefined) {
        return { text: '', finishReason: 'stop' };
      }
      if (entry instanceof Error) {
        throw entry;
      }
      if (typeof entry === 'string') {
        return { text: entry, finishReason: 'stop', model: 'fake-model' };
      }
      return entry;
    }
  };
}

/** Joined prompt text of one recorded model request. */
export function promptText(model: ScriptedModel, index: number = 0): string {
  const request = requestAt(model, index);
  return request.messages.map((message) => message.content).join('\n');
}

/** One recorded model request, with a loud failure instead of undefined. */
export function requestAt(model: ScriptedModel, index: number = 0): ModelRequest {
  const request = model.requests[index];
  if (request === undefined) {
    throw new Error('expected a model request at index ' + index + ' but only ' + model.requests.length + ' were recorded');
  }
  return request;
}

export function makeLesson(overrides: Partial<CanonicalLesson> = {}): CanonicalLesson {
  return {
    id: 'lesson_recall_1',
    title: 'Inject a SQL schema SOP before querying',
    whenToApply: ['taskSignature=db-migration'],
    subFunctions: ['skills'],
    executionPatch: { summary: 'Mount a schema-first SKILL.md before the first query.' },
    verificationEvidence: {
      referenceFailure: 'reference failed with a syntax error after 9 steps',
      candidateSuccess: 'candidate succeeded after 6 steps',
      metricsDelta: { stepsDiff: -3, toolErrorsDiff: -1 }
    },
    whenNotToApply: ['do not apply when the task has no database'],
    polarity: 'positive',
    visibility: 'session',
    sessionId: 'sess_1',
    confidence: 0.7,
    ...overrides
  };
}

export function makeRecall(overrides: Partial<MemoryRecallResult> = {}): MemoryRecallResult {
  const positiveLessons = overrides.positiveLessons ?? [makeLesson()];
  const negativeLessons =
    overrides.negativeLessons ??
    [
      makeLesson({
        id: 'lesson_recall_2',
        title: 'Never batch parallel tool calls before the schema is known',
        polarity: 'negative',
        subFunctions: ['tool_guidance'],
        confidence: 0.55
      })
    ];
  return {
    query: { scope: { kind: 'session', sessionId: 'sess_1' }, text: 'db migration' },
    scope: { kind: 'session', sessionId: 'sess_1' },
    driverKind: 'vector_fact',
    lessons: [...positiveLessons, ...negativeLessons],
    positiveLessons,
    negativeLessons,
    suppressedLessons: [],
    confidence: 0.82,
    degraded: false,
    diagnostics: [],
    recalledAt: 1200,
    ...overrides
  };
}

export function makeTask(overrides: Partial<ProbeTask> = {}): ProbeTask {
  return {
    id: 'task_1',
    prompt: 'Migrate the database schema and report the result as JSON.',
    taskSignature: 'db-migration',
    complexity: 'moderate',
    contextTags: ['sql', 'migration'],
    ...overrides
  };
}

export function makeSlot(overrides: Partial<BatchSlotPlan> = {}): BatchSlotPlan {
  return {
    slot: 'explore_domain',
    slotIndex: 1,
    branchId: 'branch_1',
    parentNodeId: 'node_root',
    origin: 'domain',
    guidance: 'memory',
    focusSurfaces: ['guardrails'],
    rationale: 'explore a domain-guided guardrail tightening',
    ...overrides
  };
}

export function makePatch(overrides: Partial<EightSurfacePatch> = {}): EightSurfacePatch {
  return {
    id: 'patch_1',
    sessionId: 'sess_1',
    branchId: 'branch_1',
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: 'explore_domain:guardrails',
    rationale: 'Add a strict JSON output contract to the guardrails surface.',
    edits: { guardrails: { kind: 'guardrails', formatContract: 'Return minified JSON only.' } },
    sourceLessonIds: [],
    createdAt: 1500,
    ...overrides
  };
}

export function makeProposeRequest(overrides: Partial<ProposeRequest> = {}): ProposeRequest {
  return {
    task: makeTask(),
    sessionId: 'sess_1',
    slot: makeSlot(),
    guidance: { mode: 'domain', memory: makeRecall() },
    attemptIndex: 1,
    totalBudget: 4,
    ...overrides
  };
}

/** A valid proposer response, overridable per test. */
export function proposalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    rationale: 'Tighten the output contract so the tool loop stops retrying.',
    focusSurfaces: ['guardrails'],
    confidence: 0.7,
    expectedStepsDelta: -1,
    edits: { guardrails: { kind: 'guardrails', formatContract: 'Return minified JSON only.' } },
    ...overrides
  });
}

export function makeTrajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj_1',
    sessionId: 'sess_1',
    branchId: 'branch_1',
    branchNamespace: 'probe_sess_1_branch_1',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch_1',
    patchOrigin: 'domain',
    surfaceKeys: ['guardrails'],
    startedAt: 1000,
    endedAt: 2000,
    metrics: { steps: 5, toolCalls: 3, toolErrors: 0, durationMs: 1000 },
    steps: [
      { index: 0, at: 1000, kind: 'model', text: 'plan the migration' },
      { index: 1, at: 1100, kind: 'tool', toolName: 'read_file', text: 'schema.sql' }
    ],
    toolErrors: [],
    deliverable: { content: 'migration plan', format: 'markdown' },
    failureSignals: [],
    memoryRecallIds: [],
    ...overrides
  };
}

export function makeCandidate(options: {
  readonly nodeId: string;
  readonly branchId: string;
  readonly patch?: EightSurfacePatch;
  readonly trajectory?: ProbeTrajectory;
}): ProbeCandidate {
  const patch = options.patch ?? makePatch({ id: 'patch_' + options.nodeId, branchId: options.branchId });
  const trajectory =
    options.trajectory ??
    makeTrajectory({
      id: 'traj_' + options.nodeId,
      nodeId: options.nodeId,
      branchId: options.branchId,
      branchNamespace: 'probe_sess_1_' + options.branchId,
      patchId: patch.id
    });
  return { nodeId: options.nodeId, branchId: options.branchId, patch, trajectory };
}

export function makeNode(overrides: Partial<DiscoveryNode> = {}): DiscoveryNode {
  return {
    id: 'node_a',
    treeId: 'tree_1',
    parentId: 'node_root',
    depth: 1,
    branchId: 'branch_a',
    patchId: 'patch_node_a',
    patchOrigin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    status: 'succeeded',
    slot: 'explore_domain',
    round: 1,
    childIds: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides
  };
}

export function makeTree(
  nodes: readonly DiscoveryNode[],
  overrides: Partial<DiscoveryTreeSnapshot> = {}
): DiscoveryTreeSnapshot {
  const record: Record<string, DiscoveryNode> = {};
  for (const node of nodes) {
    record[node.id] = node;
  }
  return {
    id: 'tree_1',
    sessionId: 'sess_1',
    taskId: 'task_1',
    rootId: nodes[0]?.id ?? 'node_root',
    nodes: record,
    stats: {
      nodeCount: nodes.length,
      maxDepth: 2,
      maxWidth: nodes.length,
      scoredNodes: nodes.length,
      completedNodes: nodes.filter((node) => node.status === 'succeeded' || node.status === 'failed').length
    },
    completed: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides
  };
}

export function makeAssessment(overrides: Partial<CandidateAssessment> = {}): CandidateAssessment {
  return {
    alias: 'candidate_A',
    branchId: 'branch_b',
    nodeId: 'node_b',
    selected: true,
    adoptionRatio: 0.8,
    contrasts: [],
    rationale: 'succeeded with fewer steps',
    ...overrides
  };
}

export function makeComposition(overrides: Partial<CompositionResult> = {}): CompositionResult {
  return {
    selectedBranchId: null,
    selectedNodeId: null,
    selectedTrajectoryId: null,
    selectedPatch: null,
    composedPatch: null,
    assessments: [],
    adoptionRatios: {},
    rationale: 'no candidates were supplied; nothing to compose',
    evaluatedAt: 2000,
    ...overrides
  };
}

export function makeReflectionRequest(overrides: Partial<ReflectionRequest> = {}): ReflectionRequest {
  return {
    task: makeTask(),
    sessionId: 'sess_1',
    tree: makeTree([]),
    composition: makeComposition(),
    trajectories: [],
    scope: { kind: 'session', sessionId: 'sess_1' },
    ...overrides
  };
}
