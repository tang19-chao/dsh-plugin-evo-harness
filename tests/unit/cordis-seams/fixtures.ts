/**
 * Shared fixtures for the Cordis seam unit tests.
 *
 * All fixtures are plain data and structural mocks: no DSH host, no network, no
 * sandbox. Tests inject a clock and a branch-id factory so every assertion is
 * deterministic.
 */
import type {
  EightSurfacePatch,
  ProbeBranchRequest,
  ProbeExecutionResult,
  ProbeTask,
  TrajectoryStep
} from '../../../src/types/contracts';

/** Deterministic task. */
export function makeTask(overrides: Partial<ProbeTask> = {}): ProbeTask {
  return {
    id: 'task-1',
    prompt: 'Make the failing build pass without breaking the release train.',
    taskSignature: 'sig-1',
    complexity: 'moderate',
    contextTags: ['ci'],
    ...overrides
  };
}

/** A patch touching all eight Harness2 surfaces. */
export function makePatch(overrides: Partial<EightSurfacePatch> = {}): EightSurfacePatch {
  return {
    id: 'patch-1',
    sessionId: 'sess-1',
    branchId: 'source-branch',
    origin: 'reference',
    purpose: 'initial',
    guidance: 'memory',
    label: 'all-eight',
    rationale: 'exercise every surface seam',
    createdAt: 1,
    edits: {
      system_prompt: {
        kind: 'system_prompt',
        mode: 'append',
        content: 'Prefer evidence over speculation.',
        priority: 5
      },
      guardrails: {
        kind: 'guardrails',
        appendRules: ['always cite evidence'],
        forbiddenActions: ['rm -rf'],
        formatContract: 'json',
        toolPreconditions: [{ toolName: 'shell', rule: 'no destructive flags' }]
      },
      memory: {
        kind: 'memory',
        workingNotes: ['draft note'],
        recallTags: ['build']
      },
      tool_guidance: {
        kind: 'tool_guidance',
        descriptions: { shell: 'run a shell command' },
        priorityOrder: ['shell'],
        examples: [{ toolName: 'shell', example: 'ls -la' }]
      },
      skills: {
        kind: 'skills',
        skills: [{ name: 'sop', markdown: '# SOP', description: 'domain sop' }]
      },
      scripts: {
        kind: 'scripts',
        scripts: [{ path: 'scripts/fix.py', language: 'python', code: 'print(1)' }]
      },
      subagents: {
        kind: 'subagents',
        agents: [{ name: 'explorer', description: 'explore the repo' }]
      },
      plugins: {
        kind: 'plugins',
        middleware: [
          {
            name: 'guard',
            hook: 'before_tool',
            language: 'typescript',
            code: 'export default () => undefined;'
          }
        ]
      }
    },
    ...overrides
  };
}

/** A patch touching only three surfaces, in non-mount order. */
export function makeSparsePatch(): EightSurfacePatch {
  const full = makePatch();
  return {
    ...full,
    id: 'patch-sparse',
    label: 'sparse',
    edits: {
      skills: full.edits.skills,
      system_prompt: full.edits.system_prompt,
      plugins: full.edits.plugins
    }
  };
}

/** Deterministic executor result with two tool steps and one tool error. */
export function makeExecutionResult(
  overrides: Partial<ProbeExecutionResult> = {}
): ProbeExecutionResult {
  return {
    status: 'succeeded',
    steps: makeSteps(),
    deliverable: { content: 'done', format: 'text' },
    toolErrors: [{ toolName: 'shell', message: 'exit 1', code: 'E1', stepIndex: 1 }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...overrides
  };
}

/** Indexed steps as an executor would return them. */
export function makeSteps(): readonly TrajectoryStep[] {
  return [
    { index: 0, at: 1_000, kind: 'model', text: 'plan' },
    { index: 1, at: 1_010, kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'ls' }, durationMs: 10 },
    { index: 2, at: 1_020, kind: 'message', text: 'done' }
  ];
}

/** Branch request with an overridable executor. */
export function makeRequest(
  patch: EightSurfacePatch,
  executor: ProbeBranchRequest['executor'],
  overrides: Partial<ProbeBranchRequest> = {}
): ProbeBranchRequest {
  return {
    sessionId: 'sess-1',
    task: makeTask(),
    patch,
    executor,
    ...overrides
  };
}

/** Deterministic branch-id factory: br-1, br-2, ... */
export function makeIdFactory(prefix = 'br'): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return prefix + '-' + String(counter);
  };
}

/** Deterministic clock that advances by a fixed step on every read. */
export function makeClock(start = 1_000, step = 5): () => number {
  let current = start - step;
  return (): number => {
    current += step;
    return current;
  };
}
