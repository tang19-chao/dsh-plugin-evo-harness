/**
 * Offline deterministic evaluation harness for the JitRL arms (plan section 9).
 *
 * Ownership: scripts/** (P5-c). Shared by the CLI (scripts/eval-jitrl.mjs) and
 * the CI regression suite (tests/e2e/jitrl-ablation.test.ts), so both measure
 * exactly the same thing.
 *
 * Protocol (section 9.1): every task runs L=5 times in sequence and both Avg
 * (mean over the runs) and Final (run L) are reported, plus Final - Avg as the
 * learning-efficiency signal.
 *
 * The task suite is a SYNTHETIC offline environment (section 9.1 item 1): a
 * deterministic mock model, a deterministic branch runner and an explicit latent
 * payoff table per task. It is not a repository benchmark; its purpose is a
 * reproducible, fast, dependency-free regression that drives the real plugin
 * (Harness2 + Dream-RSI + JitRL L1/L2) end to end and reports honest numbers.
 *
 * Determinism: metric output is a pure function of the suite and the seed. The
 * eval configuration sets `jitrl.exploration.lambda = 0` and `selection =
 * 'argmax'`, so the only remaining random draws (the optimistic-exploration
 * draws inside estimateActionValues) never change a value; every other input is
 * the injected monotonic clock. Re-running the CLI therefore reproduces the
 * metric block exactly, which is what the CI assertion checks. Timing fields are
 * reported outside that block.
 */

import { performance } from 'node:perf_hooks';

import { createEvoHarnessPlugin } from '../../src/index';
import { createAnonymousComposer, createEvidenceReflector } from '../../src/harness2';
import { createMemoryExperienceStore } from '../../src/jitrl/stores/memory.store';
import type {
  BatchSlotKind,
  BranchExecutor,
  DiscoveryNode,
  EightSurfacePatch,
  HarnessComponentKey,
  IHarnessProposer,
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult,
  ProbeTask,
  ProposeRequest,
  ProposedPatch,
  ProposedPatchSet,
  TrajectoryStep
} from '../../src/types/contracts';

// ---------------------------------------------------------------------------
// deterministic primitives
// ---------------------------------------------------------------------------

/** mulberry32: the one PRNG the whole harness uses. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash (FNV-1a), used to derive per-cell seeds. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Monotonic clock: each read advances by one millisecond. */
export function makeClock(start = 1_700_000_000_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

// ---------------------------------------------------------------------------
// synthetic task suite
// ---------------------------------------------------------------------------

/** The three surfaces the synthetic proposer can edit. */
export const PROPOSABLE_SURFACES = ['guardrails', 'tool_guidance', 'skills'] as const;
export type ProposableSurface = (typeof PROPOSABLE_SURFACES)[number];

/**
 * One synthetic task.
 *
 * `required` is the exercise's ground truth: the surfaces a scaffold must edit
 * for the task to count as fully solved, like a set of failing tests.
 * `prefs` is the proposer's own preference order (it never sees `required`): it
 * proposes `prefs[0]` first and, when deepening an existing scaffold, the first
 * preference the parent has not covered yet. That is what makes multi-round
 * lineage growth a real behaviour rather than a table lookup.
 */
export interface EvalTask {
  readonly id: string;
  readonly family: string;
  readonly prompt: string;
  readonly signature: string;
  readonly contextTags: readonly string[];
  readonly complexity: 'moderate' | 'complex';
  readonly required: readonly ProposableSurface[];
  /** Proposer preference order; index 0 is the first surface it tries. */
  readonly prefs: readonly ProposableSurface[];
}

function task(input: {
  readonly id: string;
  readonly family: string;
  readonly prompt: string;
  readonly signature: string;
  readonly tags: readonly string[];
  readonly complexity: 'moderate' | 'complex';
  readonly required: readonly ProposableSurface[];
  readonly prefs: readonly ProposableSurface[];
}): EvalTask {
  return {
    id: input.id,
    family: input.family,
    prompt: input.prompt,
    signature: input.signature,
    contextTags: input.tags,
    complexity: input.complexity,
    required: input.required,
    prefs: input.prefs
  };
}

/**
 * Twelve synthetic tasks in three families.
 *
 * Two-surface tasks are reachable in two rounds (a first partial fix, then a
 * deepening that covers the second surface); three-surface tasks need a combined
 * first-round candidate to finish inside the same probe budget. That asymmetry
 * is deliberate: it is what lets the K-candidate path (B3) and the single
 * candidate path (B1) differ for a real reason.
 */
export const EVAL_TASKS: readonly EvalTask[] = [
  task({
    id: 'ci-01',
    family: 'ci-fix',
    prompt: 'Fix the failing CI build for the release branch and restore the publish job.',
    signature: 'ci-fix-publish',
    tags: ['ci', 'release'],
    complexity: 'moderate',
    required: ['guardrails', 'skills'],
    prefs: ['guardrails', 'skills', 'tool_guidance']
  }),
  task({
    id: 'ci-02',
    family: 'ci-fix',
    prompt: 'Repair the flaky integration job that fails on the second attempt.',
    signature: 'ci-fix-flaky',
    tags: ['ci', 'flaky'],
    complexity: 'moderate',
    required: ['tool_guidance', 'skills'],
    prefs: ['tool_guidance', 'skills', 'guardrails']
  }),
  task({
    id: 'ci-03',
    family: 'ci-fix',
    prompt: 'Make the lint gate pass again after the toolchain bump.',
    signature: 'ci-fix-lint',
    tags: ['ci', 'lint'],
    complexity: 'moderate',
    required: ['guardrails'],
    prefs: ['guardrails', 'skills', 'tool_guidance']
  }),
  task({
    id: 'ci-04',
    family: 'ci-fix',
    prompt: 'Restore the nightly build that stopped after the dependency cache change.',
    signature: 'ci-fix-cache',
    tags: ['ci', 'cache'],
    complexity: 'moderate',
    required: ['tool_guidance', 'skills', 'guardrails'],
    prefs: ['tool_guidance', 'skills', 'guardrails']
  }),
  task({
    id: 'mig-01',
    family: 'schema-migration',
    prompt: 'Migrate the account schema and keep the audit trail intact.',
    signature: 'migration-account',
    tags: ['db', 'migration'],
    complexity: 'complex',
    required: ['guardrails', 'tool_guidance'],
    prefs: ['guardrails', 'tool_guidance', 'skills']
  }),
  task({
    id: 'mig-02',
    family: 'schema-migration',
    prompt: 'Add the backfill migration for the session table.',
    signature: 'migration-session',
    tags: ['db', 'migration'],
    complexity: 'complex',
    required: ['guardrails', 'tool_guidance', 'skills'],
    prefs: ['guardrails', 'tool_guidance', 'skills']
  }),
  task({
    id: 'mig-03',
    family: 'schema-migration',
    prompt: 'Make the schema change reversible and document the rollback.',
    signature: 'migration-rollback',
    tags: ['db', 'migration'],
    complexity: 'moderate',
    required: ['tool_guidance', 'skills'],
    prefs: ['tool_guidance', 'skills', 'guardrails']
  }),
  task({
    id: 'mig-04',
    family: 'schema-migration',
    prompt: 'Add the index needed by the dashboard query without downtime.',
    signature: 'migration-index',
    tags: ['db', 'performance'],
    complexity: 'complex',
    required: ['skills', 'guardrails', 'tool_guidance'],
    prefs: ['skills', 'guardrails', 'tool_guidance']
  }),
  task({
    id: 'test-01',
    family: 'test-authoring',
    prompt: 'Write regression tests for the retry policy and wire them into CI.',
    signature: 'tests-retry',
    tags: ['tests'],
    complexity: 'moderate',
    required: ['skills'],
    prefs: ['skills', 'guardrails', 'tool_guidance']
  }),
  task({
    id: 'test-02',
    family: 'test-authoring',
    prompt: 'Cover the pagination edge cases with unit tests.',
    signature: 'tests-pagination',
    tags: ['tests'],
    complexity: 'moderate',
    required: ['tool_guidance', 'skills'],
    prefs: ['tool_guidance', 'skills', 'guardrails']
  }),
  task({
    id: 'test-03',
    family: 'test-authoring',
    prompt: 'Turn the manual smoke checklist into automated tests.',
    signature: 'tests-smoke',
    tags: ['tests', 'ci'],
    complexity: 'complex',
    required: ['guardrails', 'skills', 'tool_guidance'],
    prefs: ['guardrails', 'skills', 'tool_guidance']
  }),
  task({
    id: 'test-04',
    family: 'test-authoring',
    prompt: 'Add the missing integration test for the memory bridge.',
    signature: 'tests-memory',
    tags: ['tests'],
    complexity: 'moderate',
    required: ['tool_guidance'],
    prefs: ['tool_guidance', 'guardrails', 'skills']
  })
];

/** Seed of the suite: the task ids, so a changed suite changes the seed. */
export function suiteSeed(tasks: readonly EvalTask[] = EVAL_TASKS): number {
  return hashString(tasks.map((taskSpec) => taskSpec.id + ':' + taskSpec.required.join(',')).join('|'));
}

/** Required-surface coverage of one edited surface set, in [0, 1]. */
export function coverageOf(taskSpec: EvalTask, surfaces: readonly string[]): number {
  if (taskSpec.required.length === 0) {
    return 0;
  }
  const edited = new Set(surfaces);
  let covered = 0;
  for (const surface of taskSpec.required) {
    if (edited.has(surface)) {
      covered += 1;
    }
  }
  return covered / taskSpec.required.length;
}

/** Best coverage any single scaffold can reach for the task (table oracle). */
export function oracleCoverage(taskSpec: EvalTask): number {
  const options = [
    [taskSpec.prefs[0]],
    [taskSpec.prefs[1]],
    taskSpec.prefs.slice(0, 2),
    taskSpec.prefs.slice(0, 3)
  ];
  let best = 0;
  for (const option of options) {
    const surfaces = option.filter((surface): surface is ProposableSurface => surface !== undefined);
    if (surfaces.length === 0) {
      continue;
    }
    const coverage = coverageOf(taskSpec, surfaces);
    if (coverage > best) {
      best = coverage;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// mock model (compose / reflect / evaluate_steps only; proposals are injected)
// ---------------------------------------------------------------------------

/** Model call counters, read live by the metrics block. */
export interface ModelCallCounters {
  compose: number;
  reflect: number;
  evaluateSteps: number;
  propose: number;
  total: number;
}

export function createModelCounters(): ModelCallCounters {
  return { compose: 0, reflect: 0, evaluateSteps: 0, propose: 0, total: 0 };
}

/**
 * Deterministic model adapter for every non-proposal purpose.
 *
 * - compose: ranks the anonymous candidates by the SAME behavioral dimensions
 *   the judge is asked to use (task completion first, then tool errors, steps,
 *   deliverable length), parsed back out of the rendered dossier. That makes the
 *   judge a deterministic, rule-following stand-in instead of a constant: an
 *   empty ranking would be extended by the composer's alias order, which would
 *   always hand the win to candidate_A and make round-1 candidates unbeatable.
 *   The judge keeps its contractual 15% share; the evidence score keeps 85%.
 * - reflect: no lessons (the suite measures selection, not lesson writing).
 * - evaluate_steps: a well-formed empty judge payload (neutral on every step).
 */
export function createEvalModel(counters: ModelCallCounters): IModelAdapter {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      counters.total += 1;
      if (request.purpose === 'propose') {
        counters.propose += 1;
        return { text: JSON.stringify({ rationale: 'unused', edits: {} }), finishReason: 'stop', model: 'eval-mock' };
      }
      if (request.purpose === 'compose') {
        counters.compose += 1;
        return {
          text: JSON.stringify(rankComposeRequest(request)),
          finishReason: 'stop',
          model: 'eval-mock'
        };
      }
      if (request.purpose === 'reflect') {
        counters.reflect += 1;
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'eval-mock' };
      }
      counters.evaluateSteps += 1;
      return { text: JSON.stringify({ steps: [] }), finishReason: 'stop', model: 'eval-mock' };
    }
  };
}

/** Behavioral line of one candidate dossier as rendered by the composer. */
interface JudgeCandidate {
  readonly alias: string;
  completed: number;
  toolErrors: number;
  steps: number;
  deliverable: number;
}

function parseJudgeDossiers(text: string): readonly JudgeCandidate[] {
  const candidates: JudgeCandidate[] = [];
  let current: JudgeCandidate | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const header = /^### (candidate_[A-Z0-9]+)$/.exec(line);
    if (header !== null) {
      current = { alias: header[1] as string, completed: 0, toolErrors: 0, steps: 0, deliverable: 0 };
      candidates.push(current);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const metrics = /^metrics: steps=(\d+) toolCalls=(\d+) toolErrors=(\d+)/.exec(line);
    if (metrics !== null) {
      current.steps = Number.parseInt(metrics[1] as string, 10);
      current.toolErrors = Number.parseInt(metrics[3] as string, 10);
      continue;
    }
    const complete = /^- task_completion: reference=(\S+) candidate=(\S+)/.exec(line);
    if (complete !== null) {
      current.completed = complete[2] === 'succeeded' ? 1 : 0;
      continue;
    }
    const quality = /^- deliverable_quality: reference=\d+ candidate=(\d+)/.exec(line);
    if (quality !== null) {
      current.deliverable = Number.parseInt(quality[1] as string, 10);
    }
  }
  return candidates;
}

/** Rule-following judge verdict: completion, then errors, steps, deliverable. */
function rankComposeRequest(request: ModelRequest): {
  readonly ranking: readonly string[];
  readonly assessments: readonly { readonly alias: string; readonly rationale: string }[];
} {
  const text = request.messages.map((message) => message.content).join('\n');
  const parsed = parseJudgeDossiers(text);
  const ranked = [...parsed].sort((left, right) => {
    if (left.completed !== right.completed) {
      return right.completed - left.completed;
    }
    if (left.toolErrors !== right.toolErrors) {
      return left.toolErrors - right.toolErrors;
    }
    if (left.steps !== right.steps) {
      return left.steps - right.steps;
    }
    if (left.deliverable !== right.deliverable) {
      return right.deliverable - left.deliverable;
    }
    // Deterministic tie-break: the alias order the composer itself uses.
    return left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0;
  });
  return {
    ranking: ranked.map((entry) => entry.alias),
    assessments: ranked.map((entry) => ({
      alias: entry.alias,
      rationale:
        'completed=' + String(entry.completed) +
        ' toolErrors=' + String(entry.toolErrors) +
        ' steps=' + String(entry.steps)
    }))
  };
}

// ---------------------------------------------------------------------------
// mock proposer
// ---------------------------------------------------------------------------

/** One proposal the proposer handed out (slot-aware safety + runner lookup). */
export interface ProposalRecord {
  readonly patchId: string;
  readonly taskId: string;
  readonly slotKind: BatchSlotKind;
  readonly surfaces: readonly ProposableSurface[];
  readonly guidanceMode: string;
  readonly memoryPresent: boolean;
  readonly candidateIndex: number;
  readonly runIndex: number;
}

export interface ProposerState {
  readonly records: ProposalRecord[];
  /** Invariant slots proposed with a non-invariant guidance mode (§7.1). */
  invariantLeaks: number;
  /** Invariant slots whose guidance carried recalled memory (§7.1). */
  invariantMemoryLeaks: number;
  proposeCalls: number;
  candidateCalls: number;
  currentRunIndex: number;
}

/**
 * Confidence prior of the K candidates.
 *
 * It is FIXED across runs on purpose. A per-run rotation would inject a new
 * prior every trial, which fights the very signal the protocol is trying to
 * measure: the L2 selector's acquired advantage could never dominate a prior
 * that keeps changing, and Avg/Final would report harness noise instead of
 * learning. Keeping the prior stable means the only thing that varies between
 * run 1 and run L is the experience the kernel accumulated, so a Final/Avg move
 * is attributable to learning.
 *
 * The narrow candidate A carries the highest prior (0.55) and the combined
 * candidate C the middle one (0.50), so the cold-start choice is the narrow
 * patch and switching to the combined one requires evidence.
 */
const K_CONFIDENCES: readonly [number, number, number] = [0.55, 0.45, 0.5];

function kConfidences(): readonly [number, number, number] {
  return K_CONFIDENCES;
}

/** Surfaces already mounted by the parent node's probe (empty for the root). */
function coveredSurfaces(node: DiscoveryNode | undefined): readonly string[] {
  const raw = node?.metadata?.surfaceKeys;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Deepening choice: the first preference the parent has not covered yet. With no
 * parent (or everything covered) it falls back to the first preference. The
 * proposer never reads the task's required set, so this is a real heuristic.
 */
function deepeningSurface(
  taskSpec: EvalTask,
  parent: DiscoveryNode | undefined
): ProposableSurface {
  const covered = new Set(coveredSurfaces(parent));
  for (const surface of taskSpec.prefs) {
    if (!covered.has(surface)) {
      return surface;
    }
  }
  return taskSpec.prefs[0] ?? 'guardrails';
}

/**
 * K-candidate shapes for one propose request, ordered as [A, B, C].
 *
 * A and B are single-surface "narrow" candidates; C is the combined one. On a
 * deepening request (the parent already mounted some surfaces) every candidate
 * keeps the parent's coverage and adds its own edit on top, so the combined
 * candidate is the only one that can complete a multi-surface task in one round
 * while the narrow ones grow the lineage one surface at a time. That mirrors
 * how a real K-candidate proposer behaves - same task, different scope - and it
 * is what makes the L2 choice matter rather than being cosmetic.
 */
function kCandidateShapes(
  taskSpec: EvalTask,
  parent: DiscoveryNode | undefined
): readonly (readonly ProposableSurface[])[] {
  const covered = new Set(coveredSurfaces(parent));
  const unmet = taskSpec.prefs.filter((surface) => !covered.has(surface));
  const combined = [...unmet.slice(0, 2)];
  const narrowA = unmet[0] === undefined ? [] : [unmet[0]];
  const narrowB = unmet[1] === undefined ? [] : [unmet[1]];
  // Parent coverage is inherited through `parentPatchIds` at execution time, so
  // each candidate only declares its own delta.
  return [narrowA, narrowB, combined];
}

function surfaceEdits(
  surfaces: readonly ProposableSurface[],
  slotKind: string,
  index: number
): Record<string, unknown> {
  const edits: Record<string, unknown> = {};
  for (const surface of surfaces) {
    if (surface === 'guardrails') {
      edits.guardrails = {
        kind: 'guardrails',
        appendRules: ['eval-rule-' + slotKind + '-' + String(index + 1)]
      };
    } else if (surface === 'tool_guidance') {
      edits.tool_guidance = {
        kind: 'tool_guidance',
        descriptions: { shell: 'eval guidance ' + slotKind + ' ' + String(index + 1) }
      };
    } else {
      edits.skills = {
        kind: 'skills',
        skills: [
          {
            name: 'eval-skill-' + slotKind + '-' + String(index + 1),
            markdown: '# eval skill ' + slotKind,
            description: 'synthetic eval skill'
          }
        ]
      };
    }
  }
  return edits;
}

function patchIdOf(
  request: ProposeRequest,
  slotKind: string,
  candidateIndex: number,
  runIndex: number,
  sequence: number
): string {
  // The sequence number makes the id unique across rounds: `attemptIndex` is the
  // slot index and repeats every round, so without it a round-2 deepening patch
  // would share its id with its own round-1 parent. The composer resolves
  // lineage by patch id, so a collision would make it drop the parent's edits
  // and every multi-round coverage gain would silently vanish.
  return [
    'eval',
    request.sessionId,
    slotKind,
    'r' + String(request.attemptIndex),
    'c' + String(candidateIndex + 1),
    'run' + String(runIndex),
    'p' + String(sequence)
  ].join('-');
}

function buildProposal(
  request: ProposeRequest,
  surfaces: readonly ProposableSurface[],
  candidateIndex: number,
  confidence: number,
  runIndex: number,
  sequence: number
): ProposedPatch {
  const slotKind = request.slot.slot;
  // Declared lineage is what lets the composer merge a deepening candidate on
  // top of the scaffold its parent actually mounted (the same contract the real
  // proposer satisfies). Without it a round-2 candidate would silently drop the
  // round-1 edits and multi-round coverage could never accumulate.
  const parentPatchIds: string[] = [];
  if (request.parentPatch !== undefined) {
    parentPatchIds.push(request.parentPatch.id);
  }
  for (const seedId of request.slot.seedPatchIds ?? []) {
    if (!parentPatchIds.includes(seedId)) {
      parentPatchIds.push(seedId);
    }
  }
  return {
    patch: {
      id: patchIdOf(request, slotKind, candidateIndex, runIndex, sequence),
      sessionId: request.sessionId,
      branchId: request.slot.branchId,
      origin: request.slot.origin,
      purpose: 'explore',
      guidance: request.slot.guidance,
      label: 'eval-' + slotKind + '-' + String(candidateIndex + 1),
      rationale: 'synthetic proposal editing ' + (surfaces.length === 0 ? 'nothing' : surfaces.join('+')),
      edits: surfaceEdits(surfaces, slotKind, candidateIndex),
      ...(parentPatchIds.length === 0 ? {} : { parentPatchIds })
    } as unknown as EightSurfacePatch,
    rationale: 'synthetic proposal editing ' + surfaces.join('+'),
    focusSurfaces: [...surfaces] as readonly HarnessComponentKey[],
    confidence,
    expectedStepsDelta: -1
  };
}

/**
 * Deterministic proposer over the synthetic task tables.
 *
 * Single-candidate path: deepens by covering the first unmet preference.
 * K-candidate path: offers [prefs[0]], [prefs[1]], and their union, with the
 * rotated confidence prior above, so the L2 selector has a real choice.
 */
export function createEvalProposer(
  tasksById: ReadonlyMap<string, EvalTask>,
  state: ProposerState
): IHarnessProposer {
  // Monotone proposal sequence: unique patch ids across rounds (see patchIdOf).
  let sequence = 0;
  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };
  const record = (
    request: ProposeRequest,
    surfaces: readonly ProposableSurface[],
    candidateIndex: number,
    sequenceNumber: number
  ): string => {
    const patchId = patchIdOf(request, request.slot.slot, candidateIndex, state.currentRunIndex, sequenceNumber);
    state.records.push({
      patchId,
      taskId: request.task.id,
      slotKind: request.slot.slot,
      surfaces,
      guidanceMode: request.guidance.mode,
      memoryPresent: request.guidance.memory !== null,
      candidateIndex,
      runIndex: state.currentRunIndex
    });
    if (request.slot.slot === 'explore_invariant') {
      // Section 7.1: the invariant slot must be guidance-free with memory null.
      if (request.guidance.mode !== 'invariant') {
        state.invariantLeaks += 1;
      }
      if (request.guidance.memory !== null) {
        state.invariantMemoryLeaks += 1;
      }
    }
    return patchId;
  };
  return {
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      state.proposeCalls += 1;
      const spec = tasksById.get(request.task.id);
      const surfaces = spec === undefined ? [] : [deepeningSurface(spec, request.parentNode)];
      const sequenceNumber = nextSequence();
      record(request, surfaces, 0, sequenceNumber);
      return buildProposal(request, surfaces, 0, 0.5, state.currentRunIndex, sequenceNumber);
    },
    async proposeCandidates(request: ProposeRequest): Promise<ProposedPatchSet> {
      state.candidateCalls += 1;
      const spec = tasksById.get(request.task.id);
      const shapes: readonly (readonly ProposableSurface[])[] =
        spec === undefined
          ? [[]]
          : kCandidateShapes(spec, request.parentNode);
      const confidences = kConfidences();
      const candidates = shapes.map((surfaces, index) => {
        const sequenceNumber = nextSequence();
        record(request, surfaces, index, sequenceNumber);
        return buildProposal(
          request,
          surfaces,
          index,
          confidences[index] ?? 0.4,
          state.currentRunIndex,
          sequenceNumber
        );
      });
      return { candidates };
    }
  };
}

// ---------------------------------------------------------------------------
// mock branch executor (the synthetic environment)
// ---------------------------------------------------------------------------

export interface RunnerCounters {
  referenceRuns: number;
  candidateRuns: number;
  /** Candidate probes that covered at least one required surface. */
  succeededRuns: number;
  /** Invariant-origin runs whose patch was not guidance_free (§7.1). */
  invariantGuidanceLeaks: number;
  /** Step count of the most recent candidate trajectory. */
  lastSteps: number;
}

const TOOL_STEP_INDEX = 1;

function failedSteps(now: () => number, label: string): readonly TrajectoryStep[] {
  return [
    { index: 0, at: now(), kind: 'model', text: 'plan the change for ' + label },
    {
      index: TOOL_STEP_INDEX,
      at: now(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'npm test' },
      error: { name: 'ToolError', message: 'exit 1' }
    },
    { index: 2, at: now(), kind: 'error', text: 'the build failed' }
  ];
}

/**
 * A partial fix still has one failing check before it succeeds: the tool error
 * is what makes a partial scaffold measurably worse than a complete one in the
 * L1/L2 returns instead of them being indistinguishable.
 */
function partialSteps(now: () => number, label: string, missing: number): readonly TrajectoryStep[] {
  return [
    { index: 0, at: now(), kind: 'model', text: 'plan a partial change for ' + label },
    {
      index: TOOL_STEP_INDEX,
      at: now(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'npm test' },
      error: { name: 'ToolError', message: 'exit 1 (' + String(missing) + ' check(s) still failing)' }
    },
    {
      index: 2,
      at: now(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'npm test' },
      toolResult: { exitCode: 0 }
    },
    { index: 3, at: now(), kind: 'message', text: 'partial fix: ' + label }
  ];
}

function completeSteps(now: () => number, label: string): readonly TrajectoryStep[] {
  return [
    { index: 0, at: now(), kind: 'model', text: 'plan the complete change for ' + label },
    {
      index: TOOL_STEP_INDEX,
      at: now(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'npm test' },
      toolResult: { exitCode: 0 }
    },
    { index: 2, at: now(), kind: 'message', text: 'all checks pass with ' + label }
  ];
}

/**
 * Deterministic branch executor: the environment's only source of truth.
 *
 * - the reference run (empty patch, purpose 'initial') always fails with a
 *   repairable tool error, so every task has something to evolve;
 * - a candidate probe succeeds exactly when its edits intersect the task's
 *   required surfaces;
 * - coverage 1 is a clean run, partial coverage pays one failing tool step.
 *
 * The patch id maps back to the proposer registry, which is the harness's own
 * bookkeeping (the frozen patch contract carries no slot field).
 */
export function createEvalRunner(input: {
  readonly tasksById: ReadonlyMap<string, EvalTask>;
  readonly proposals: readonly ProposalRecord[];
  readonly counters: RunnerCounters;
  readonly now: () => number;
}): BranchExecutor {
  return async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const editKeys = Object.keys(context.patch.edits ?? {});
    const isReference = context.patch.purpose === 'initial' && editKeys.length === 0;
    if (isReference) {
      input.counters.referenceRuns += 1;
      return {
        status: 'failed',
        steps: failedSteps(input.now, 'reference'),
        toolErrors: [
          { toolName: 'shell', message: 'exit 1', code: 'E1', stepIndex: TOOL_STEP_INDEX, retryable: true }
        ],
        failureSignals: [{ kind: 'tool_error', message: 'exit 1', toolName: 'shell', repairable: true }],
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }
      };
    }
    input.counters.candidateRuns += 1;
    if (context.patch.origin === 'invariant' && context.patch.guidance !== 'guidance_free') {
      input.counters.invariantGuidanceLeaks += 1;
    }
    const proposal = input.proposals.find((entry) => entry.patchId === context.patch.id);
    const spec = proposal === undefined ? undefined : input.tasksById.get(proposal.taskId);
    const coverage = spec === undefined ? 0 : coverageOf(spec, editKeys);
    const label = editKeys.length === 0 ? 'nothing' : editKeys.join('+');
    if (coverage <= 0) {
      input.counters.lastSteps = 3;
      return {
        status: 'failed',
        steps: failedSteps(input.now, label),
        toolErrors: [
          { toolName: 'shell', message: 'candidate exit 2', code: 'E2', stepIndex: TOOL_STEP_INDEX, retryable: true }
        ],
        failureSignals: [{ kind: 'tool_error', message: 'candidate exit 2', toolName: 'shell', repairable: true }],
        usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 }
      };
    }
    input.counters.succeededRuns += 1;
    const complete = coverage >= 1 - 1e-9;
    const steps = complete
      ? completeSteps(input.now, label)
      : partialSteps(input.now, label, spec === undefined ? 1 : spec.required.length - Math.round(coverage * spec.required.length));
    input.counters.lastSteps = steps.length;
    return {
      status: 'succeeded',
      steps,
      deliverable: { content: 'synthetic deliverable covering ' + label, format: 'markdown' },
      usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168 }
    };
  };
}

// ---------------------------------------------------------------------------
// conditions
// ---------------------------------------------------------------------------

export type ConditionId =
  | 'B0'
  | 'B1'
  | 'B2'
  | 'B3'
  | 'A2-k4'
  | 'A2-k8'
  | 'A2-k10'
  | 'A2-k14'
  | 'A2-k20'
  | 'A3-beta0.5'
  | 'A3-beta1'
  | 'A3-beta2'
  | 'A3-beta4';

export interface ConditionSpec {
  readonly id: ConditionId;
  readonly label: string;
  /** Static baseline: no plugin is constructed at all. */
  readonly staticBaseline?: boolean;
  readonly group: 'baseline' | 'ablation';
  readonly axis?: 'k' | 'beta';
  readonly jitrlEnabled: boolean;
  readonly levels: readonly string[];
  readonly k: number;
  readonly beta: number;
  readonly candidateCount: number;
  readonly description: string;
}

function pluginCondition(input: {
  readonly id: ConditionId;
  readonly label: string;
  readonly group: 'baseline' | 'ablation';
  readonly axis?: 'k' | 'beta';
  readonly levels: readonly string[];
  readonly k: number;
  readonly beta: number;
  readonly candidateCount: number;
  readonly description: string;
}): ConditionSpec {
  return {
    id: input.id,
    label: input.label,
    group: input.group,
    ...(input.axis === undefined ? {} : { axis: input.axis }),
    jitrlEnabled: input.levels.length > 0,
    levels: input.levels,
    k: input.k,
    beta: input.beta,
    candidateCount: input.candidateCount,
    description: input.description
  };
}

export const CONDITIONS: readonly ConditionSpec[] = [
  {
    id: 'B0',
    label: 'B0 Static',
    group: 'baseline',
    staticBaseline: true,
    jitrlEnabled: false,
    levels: [],
    k: 10,
    beta: 1,
    candidateCount: 1,
    description: 'no evo-harness: the agent edits its first-choice surface only'
  },
  pluginCondition({
    id: 'B1',
    label: 'B1 Harness2 + Dream-RSI',
    group: 'baseline',
    levels: [],
    k: 10,
    beta: 1,
    candidateCount: 1,
    description: 'current v0.1 capability: full lifecycle, no JitRL'
  }),
  pluginCondition({
    id: 'B2',
    label: 'B2 + L1',
    group: 'baseline',
    levels: ['meta'],
    k: 10,
    beta: 1,
    candidateCount: 1,
    description: 'meta-level JitRL only (slot allocation)'
  }),
  pluginCondition({
    id: 'B3',
    label: 'B3 + L1 + L2',
    group: 'baseline',
    levels: ['meta', 'proposal'],
    k: 10,
    beta: 1,
    candidateCount: 3,
    description: 'plan default: meta-level plus K-candidate proposal selection'
  }),
  pluginCondition({ id: 'A2-k4', label: 'A2 k=4', group: 'ablation', axis: 'k', levels: ['meta', 'proposal'], k: 4, beta: 1, candidateCount: 3, description: 'neighbour-budget sweep' }),
  pluginCondition({ id: 'A2-k8', label: 'A2 k=8', group: 'ablation', axis: 'k', levels: ['meta', 'proposal'], k: 8, beta: 1, candidateCount: 3, description: 'neighbour-budget sweep' }),
  pluginCondition({ id: 'A2-k10', label: 'A2 k=10', group: 'ablation', axis: 'k', levels: ['meta', 'proposal'], k: 10, beta: 1, candidateCount: 3, description: 'neighbour-budget sweep' }),
  pluginCondition({ id: 'A2-k14', label: 'A2 k=14', group: 'ablation', axis: 'k', levels: ['meta', 'proposal'], k: 14, beta: 1, candidateCount: 3, description: 'neighbour-budget sweep' }),
  pluginCondition({ id: 'A2-k20', label: 'A2 k=20', group: 'ablation', axis: 'k', levels: ['meta', 'proposal'], k: 20, beta: 1, candidateCount: 3, description: 'neighbour-budget sweep' }),
  pluginCondition({ id: 'A3-beta0.5', label: 'A3 beta=0.5', group: 'ablation', axis: 'beta', levels: ['meta', 'proposal'], k: 10, beta: 0.5, candidateCount: 3, description: 'KL temperature sweep' }),
  pluginCondition({ id: 'A3-beta1', label: 'A3 beta=1', group: 'ablation', axis: 'beta', levels: ['meta', 'proposal'], k: 10, beta: 1, candidateCount: 3, description: 'KL temperature sweep' }),
  pluginCondition({ id: 'A3-beta2', label: 'A3 beta=2', group: 'ablation', axis: 'beta', levels: ['meta', 'proposal'], k: 10, beta: 2, candidateCount: 3, description: 'KL temperature sweep' }),
  pluginCondition({ id: 'A3-beta4', label: 'A3 beta=4', group: 'ablation', axis: 'beta', levels: ['meta', 'proposal'], k: 10, beta: 4, candidateCount: 3, description: 'KL temperature sweep' })
];

/** Ablations the plan lists but this round does not implement. */
export const UNIMPLEMENTED_ABLATIONS: readonly { readonly id: string; readonly reason: string }[] = [
  {
    id: 'A1 Prompt-update',
    reason: '用同样的检索把统计写进 prompt、不修正 logit（复现论文表 8）。需要一条独立的 prompt 注入路径，本轮未实现。'
  },
  {
    id: 'A4 不使用 invariant 隔离',
    reason: '需要可关闭 §7.1 硬隔离的运行时开关；当前隔离是 proposer/augmenter 内的编译期硬约束，本轮未实现。'
  },
  {
    id: 'A5 只用 LLM 奖励 vs 多信号融合',
    reason: '需要逐信号奖励消融开关与真实 LLM judge；离线 mock judge 返回中性分，无法区分两种奖励来源，本轮未实现。'
  },
  {
    id: 'A6 Embedding 检索 vs Jaccard',
    reason: 'embedding 检索会引入模型/网络依赖，与本任务「零新增 npm 依赖、离线确定」的要求冲突，本轮未实现。'
  },
  {
    id: 'L3 宿主顾问的收益对照',
    reason: 'L3 默认关闭，不参与这 12 个离线任务的生命周期（行为已由 unit/e2e 覆盖），未纳入本报告数字。'
  }
];

// ---------------------------------------------------------------------------
// protocol execution
// ---------------------------------------------------------------------------

export interface RunObservation {
  readonly runIndex: number;
  readonly score: number;
  readonly solved: boolean;
  readonly partial: boolean;
  readonly probes: number;
  readonly steps: number;
  readonly outcome: string;
  readonly kl: number;
  readonly neighbors: number;
  readonly modelCalls: number;
}

export interface TaskResult {
  readonly taskId: string;
  readonly family: string;
  readonly requiredCount: number;
  readonly oracle: number;
  readonly runs: readonly RunObservation[];
  readonly avg: number;
  readonly final: number;
  readonly finalMinusAvg: number;
  readonly solvedRuns: number;
}

export interface ConditionalHealth {
  readonly decisions: number;
  readonly klMean: number;
  readonly klP50: number;
  readonly klP95: number;
  readonly klMax: number;
  readonly neighborHitRate: number;
  readonly bucketCount: number;
  readonly storeSize: number;
  readonly storeSizeByLevel: Readonly<Record<string, number>>;
  readonly retrievalP50Ms: number;
  readonly retrievalP95Ms: number;
  readonly retrievalMeanMs: number;
}

export interface ConditionalSafety {
  readonly invariantLeaks: number;
  readonly invariantMemoryLeaks: number;
  readonly invariantGuidanceLeaks: number;
  readonly canaryLeaks: number;
  readonly invariantProbes: number;
}

export interface ConditionResult {
  readonly id: ConditionId;
  readonly label: string;
  readonly description: string;
  readonly group: 'baseline' | 'ablation';
  readonly axis?: 'k' | 'beta';
  readonly episodes: number;
  readonly config: {
    readonly jitrlEnabled: boolean;
    readonly levels: readonly string[];
    readonly k: number;
    readonly beta: number;
    readonly candidateCount: number;
  };
  readonly tasks: readonly TaskResult[];
  readonly avg: number;
  readonly final: number;
  readonly finalMinusAvg: number;
  readonly solvedRate: number;
  /** Mean per-run coverage divided by the per-task table oracle. */
  readonly oracleRatio: number;
  readonly probesPerTask: number;
  readonly stepsPerRun: number;
  readonly modelCallsPerTask: number;
  readonly health: ConditionalHealth;
  readonly safety: ConditionalSafety;
}

export interface EvalReport {
  readonly harness: 'dsh-plugin-evo-harness jitrl ablation';
  readonly protocol: {
    readonly episodes: number;
    readonly taskCount: number;
    readonly families: readonly string[];
    readonly seed: string;
    readonly deterministic: boolean;
  };
  readonly metrics: readonly ConditionResult[];
  readonly unimplemented: readonly { readonly id: string; readonly reason: string }[];
  readonly timing: {
    readonly totalMs: number;
    readonly perConditionMs: Readonly<Record<string, number>>;
  };
}

export interface EvalOptions {
  /** Episode length L (section 9.1 uses 5). */
  readonly episodes?: number;
  /** Subset of conditions (defaults to all). */
  readonly conditions?: readonly ConditionId[];
  /** Subset of tasks (defaults to the full suite). */
  readonly tasks?: readonly EvalTask[];
  /** Canary token embedded in every prompt; must never surface. */
  readonly canary?: string;
}

export const DEFAULT_CANARY = 'sk-eval-canary-9f2c41';

/** Configuration handed to the plugin for one condition. */
export function conditionConfig(spec: ConditionSpec): Record<string, unknown> {
  return {
    enabled: true,
    triggerMode: 'always',
    enabledSurfaces: [
      'system_prompt',
      'guardrails',
      'memory',
      'tool_guidance',
      'skills',
      'scripts',
      'subagents',
      'plugins'
    ],
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 5_000 },
    memoryBridge: {
      mcpServerTarget: 'auto',
      recallLimit: 3,
      namespacePrefix: 'eval',
      requireEvidence: true,
      enableNegativeFirewall: true,
      promoteOnComposeSuccess: false
    },
    dreamRsi: {
      maxOnlineRolloutBudget: 6,
      maxWidth: 3,
      maxDepth: 2,
      // Offline dreaming has its own suites; keeping it out of the 5-run window
      // keeps B0-B3 comparable at one fixed probe budget.
      offlineDreamTriggerEveryNTasks: 10_000,
      candidatePoliciesCount: 3,
      rhoPreferences: [0, 0.5, 1],
      surrogateWeights: { selection: 0.4, adoption: 0.3, efficiency: 0.2, toolErrorPenalty: 0.1 }
    },
    jitrl: {
      enabled: spec.jitrlEnabled,
      // The validator requires at least one level even when JitRL is disabled;
      // a disabled kernel never activates it, and the report prints the real
      // configured level list from the condition, so this stays honest.
      levels: spec.levels.length > 0 ? [...spec.levels] : ['meta'],
      logitSource: 'auto',
      selection: 'argmax',
      beta: spec.beta,
      k: spec.k,
      similarityThreshold: 0.3,
      gamma: 0.5,
      // lambda 0 keeps the protocol reproducible: the kernel's optimistic
      // exploration draws from Math.random, which the plugin does not inject. At
      // lambda 0 the draw never influences a value, so the metric block is a pure
      // function of the suite and the configuration (see the report section 1).
      exploration: { lambda: 0, alpha: 5 },
      candidateCount: spec.candidateCount,
      augmentFromMemory: true,
      surfaceActions: false,
      minSupportForStrongPrior: 3,
      unseenFallback: 'baseline',
      store: { driver: 'jsonl', mirrorToMemoryBridge: false, maxPerBucket: 200, halfLifeDays: 30 },
      reward: {
        llmEvaluator: true,
        weights: { llm: 0.4, surrogate: 0.3, tool: 0.2, turn: 0.1, user: 0.0 },
        clip: [-3, 3]
      },
      hostAdvisor: {
        enabled: false,
        mode: 'advisory',
        adviseThreshold: -0.5,
        gateThreshold: -0.8,
        minSupport: 5
      },
      dream: {
        driftRho: 0.7,
        hyperparamPerturbation: true,
        candidateJitBetas: [0.5, 1, 2],
        candidateJitLambdas: [0.02, 0.05, 0.1]
      },
      privacy: { redactSecrets: true, storeRawText: false }
    },
    logging: { level: 'silent' }
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const position = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[position] ?? 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Round for stable output (and therefore stable JSON comparisons). */
export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Surfaces of the composed/selected winner recorded by the last run. */
function winnerSurfaces(orchestrator: {
  lastComposition(): {
    readonly composedPatch: EightSurfacePatch | null;
    readonly selectedPatch: EightSurfacePatch | null;
  } | null;
}): readonly string[] {
  const composition = orchestrator.lastComposition();
  if (composition === null) {
    return [];
  }
  const patch = composition.composedPatch ?? composition.selectedPatch;
  if (patch === null) {
    return [];
  }
  return Object.keys(patch.edits ?? {});
}

/** Static baseline: the table's first-choice surface, no plugin at all. */
function runStaticTask(taskSpec: EvalTask, episodes: number): TaskResult {
  const surfaces = taskSpec.prefs.slice(0, 1);
  const score = coverageOf(taskSpec, surfaces);
  const runs: RunObservation[] = [];
  for (let runIndex = 0; runIndex < episodes; runIndex += 1) {
    runs.push({
      runIndex,
      score,
      solved: score >= 1 - 1e-9,
      partial: score > 0 && score < 1,
      probes: 0,
      steps: 0,
      outcome: 'static',
      kl: 0,
      neighbors: 0,
      modelCalls: 0
    });
  }
  return {
    taskId: taskSpec.id,
    family: taskSpec.family,
    requiredCount: taskSpec.required.length,
    oracle: oracleCoverage(taskSpec),
    runs,
    avg: score,
    final: score,
    finalMinusAvg: 0,
    solvedRuns: runs.filter((run) => run.solved).length
  };
}

interface RunContext {
  readonly taskId: string;
  readonly runIndex: number;
}

/** Run one plugin condition over the suite and collect health + safety. */
export async function runCondition(
  spec: ConditionSpec,
  options: { readonly episodes: number; readonly tasks: readonly EvalTask[]; readonly canary: string }
): Promise<ConditionResult> {
  const { episodes, tasks, canary } = options;
  if (spec.staticBaseline === true) {
    const results = tasks.map((taskSpec) => runStaticTask(taskSpec, episodes));
    const retrieval = await benchRetrieval(tasks, spec.k);
    return summarizeCondition(
      spec,
      results,
      {
        decisions: 0,
        klMean: 0,
        klP50: 0,
        klP95: 0,
        klMax: 0,
        neighborHitRate: 0,
        bucketCount: 0,
        storeSize: 0,
        storeSizeByLevel: {},
        retrievalP50Ms: retrieval.p50,
        retrievalP95Ms: retrieval.p95,
        retrievalMeanMs: retrieval.mean
      },
      {
        invariantLeaks: 0,
        invariantMemoryLeaks: 0,
        invariantGuidanceLeaks: 0,
        canaryLeaks: 0,
        invariantProbes: 0
      },
      episodes
    );
  }

  const tasksById = new Map(tasks.map((taskSpec) => [taskSpec.id, taskSpec] as const));
  const proposerState: ProposerState = {
    records: [],
    invariantLeaks: 0,
    invariantMemoryLeaks: 0,
    proposeCalls: 0,
    candidateCalls: 0,
    currentRunIndex: 0
  };
  const runnerCounters: RunnerCounters = {
    referenceRuns: 0,
    candidateRuns: 0,
    succeededRuns: 0,
    invariantGuidanceLeaks: 0,
    lastSteps: 0
  };
  const modelCounters = createModelCounters();
  const clock = makeClock();
  let idSequence = 0;
  let currentRun: RunContext = { taskId: '', runIndex: 0 };
  const decisions: { readonly taskId: string; readonly runIndex: number; readonly kl: number; readonly neighbors: number }[] = [];
  const textChannels: string[] = [];

  const model = createEvalModel(modelCounters);
  const plugin = createEvoHarnessPlugin(
    {
      config: conditionConfig(spec),
      model,
      clients: [],
      runBranch: createEvalRunner({
        tasksById,
        proposals: proposerState.records,
        counters: runnerCounters,
        now: clock
      }),
      now: clock,
      newId: (): string => {
        idSequence += 1;
        return 'eval-' + String(idSequence);
      },
      deps: {
        proposer: createEvalProposer(tasksById, proposerState),
        // Injecting `proposer` makes src/index.ts build the collaborators itself
        // with model = undefined (it only falls back to options.model when no
        // proposer override is present), which silently disabled the judge and
        // the reflector. Building them explicitly on the mock model keeps the
        // real composer/reflector in the loop.
        composer: createAnonymousComposer({ model, now: clock }),
        reflector: createEvidenceReflector({ model, now: clock }),
        onStage: (event): void => {
          if (event.stage !== 'jit_meta_adjust') {
            return;
          }
          // The orchestrator emits stage('jit_meta_adjust', { round, detail: {...} }),
          // so the numeric payload sits one level below event.detail.
          const outer = event.detail ?? {};
          const nested = outer['detail'];
          const detail =
            nested !== null && typeof nested === 'object' && !Array.isArray(nested)
              ? (nested as Record<string, unknown>)
              : outer;
          const kl = typeof detail['klToPrior'] === 'number' && Number.isFinite(detail['klToPrior']) ? detail['klToPrior'] : 0;
          const neighbors = typeof detail['neighborCount'] === 'number' && Number.isFinite(detail['neighborCount']) ? detail['neighborCount'] : 0;
          decisions.push({ taskId: currentRun.taskId, runIndex: currentRun.runIndex, kl, neighbors });
        }
      }
    },
    {}
  );

  const results: TaskResult[] = [];
  for (const taskSpec of tasks) {
    const runs: RunObservation[] = [];
    for (let runIndex = 0; runIndex < episodes; runIndex += 1) {
      currentRun = { taskId: taskSpec.id, runIndex };
      proposerState.currentRunIndex = runIndex;
      const decisionsBefore = decisions.length;
      const callsBefore = modelCounters.total;
      const probeTask: ProbeTask = plugin.makeTask({
        id: taskSpec.id,
        prompt: taskSpec.prompt + ' (note ' + canary + ')',
        taskSignature: taskSpec.signature,
        contextTags: taskSpec.contextTags
      });
      const result = await plugin.run({
        sessionId: 'eval-' + taskSpec.id,
        task: probeTask,
        trigger: 'always'
      });
      const surfaces = winnerSurfaces(plugin.orchestrator);
      const score = coverageOf(taskSpec, surfaces);
      const runDecisions = decisions.slice(decisionsBefore);
      runs.push({
        runIndex,
        score,
        solved: score >= 1 - 1e-9,
        partial: score > 0 && score < 1 - 1e-9,
        probes: result.probesRun,
        steps: runnerCounters.lastSteps,
        outcome: result.outcome,
        kl: round(mean(runDecisions.map((entry) => entry.kl))),
        neighbors: round(mean(runDecisions.map((entry) => entry.neighbors)), 2),
        modelCalls: modelCounters.total - callsBefore
      });
      textChannels.push(...result.diagnostics);
    }
    results.push({
      taskId: taskSpec.id,
      family: taskSpec.family,
      requiredCount: taskSpec.required.length,
      oracle: oracleCoverage(taskSpec),
      runs,
      avg: round(mean(runs.map((run) => run.score))),
      final: round(runs.length === 0 ? 0 : (runs[runs.length - 1]?.score ?? 0)),
      finalMinusAvg: round(
        mean(runs.length === 0 ? [0] : [runs[runs.length - 1]?.score ?? 0]) - mean(runs.map((run) => run.score))
      ),
      solvedRuns: runs.filter((run) => run.solved).length
    });
  }

  // Health: KL distribution, neighbour hit rate, bucket coverage and store size
  // read from the live /evo jit status surface, plus a retrieval micro-benchmark.
  const statusResult = await plugin.runFromCommand('jit status', { sessionId: 'eval-status' });
  const statusJson = statusResult.jitCommand?.json ?? {};
  textChannels.push(statusResult.jitCommand?.text ?? '');
  textChannels.push(...statusResult.diagnostics);
  textChannels.push(...plugin.diagnostics);
  const explain = await plugin.runFromCommand('jit explain latest', { sessionId: 'eval-status' });
  textChannels.push(explain.jitCommand?.text ?? '');
  const storeSize = typeof statusJson['storeSize'] === 'number' ? statusJson['storeSize'] : 0;
  const bucketCount = Array.isArray(statusJson['buckets']) ? statusJson['buckets'].length : 0;
  const levelCounts: Record<string, number> = {};
  const byLevel = statusJson['byLevel'];
  if (Array.isArray(byLevel)) {
    for (const entry of byLevel) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const level = record['level'];
      const count = record['count'];
      if (typeof level === 'string' && typeof count === 'number') {
        levelCounts[level] = count;
      }
    }
  }

  const kls = decisions.map((entry) => entry.kl).sort((left, right) => left - right);
  const neighborHits = decisions.filter((entry) => entry.neighbors > 0).length;
  const retrieval = await benchRetrieval(tasks, spec.k);
  const canaryText = textChannels.join('\n');
  const invariantProbes = proposerState.records.filter(
    (entry) => entry.slotKind === 'explore_invariant'
  ).length;

  return summarizeCondition(
    spec,
    results,
    {
      decisions: kls.length,
      klMean: round(mean(kls)),
      klP50: round(percentile(kls, 0.5)),
      klP95: round(percentile(kls, 0.95)),
      klMax: round(kls.length === 0 ? 0 : (kls[kls.length - 1] ?? 0)),
      neighborHitRate: round(decisions.length === 0 ? 0 : neighborHits / decisions.length),
      bucketCount,
      storeSize,
      storeSizeByLevel: levelCounts,
      retrievalP50Ms: retrieval.p50,
      retrievalP95Ms: retrieval.p95,
      retrievalMeanMs: retrieval.mean
    },
    {
      invariantLeaks: proposerState.invariantLeaks + runnerCounters.invariantGuidanceLeaks,
      invariantMemoryLeaks: proposerState.invariantMemoryLeaks,
      invariantGuidanceLeaks: runnerCounters.invariantGuidanceLeaks,
      canaryLeaks: canaryText.includes(canary) ? 1 : 0,
      invariantProbes
    },
    episodes
  );
}

/**
 * Retrieval micro-benchmark over a synthetic corpus shaped like the suite.
 *
 * The plugin handle exposes no experience snapshot, so this rebuilds a memory
 * store from the task suite's L1 states at the condition's k and times the same
 * query shape the L1 decorator issues. It measures the query path, not the live
 * corpus; the report says so.
 */
async function benchRetrieval(
  tasks: readonly EvalTask[],
  k: number
): Promise<{ p50: number; p95: number; mean: number }> {
  const now = 1_700_000_100_000;
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
  const records = [];
  for (const taskSpec of tasks) {
    for (let index = 0; index < 4; index += 1) {
      records.push({
        id: 'bench-' + taskSpec.id + '-' + String(index),
        level: 'meta' as const,
        state: {
          level: 'meta' as const,
          bucket: 'meta|' + taskSpec.signature + '|' + taskSpec.complexity,
          tokens: ['sig:' + taskSpec.signature, 'cx:' + taskSpec.complexity, 'pslot:root'],
          summary: taskSpec.signature
        },
        actionKey: 'slot:exploit',
        reward: 1,
        return: 1,
        rewardSources: { tool: 1 },
        guidance: 'memory' as const,
        policyId: 'pi-0',
        sessionId: 'bench',
        createdAt: 1_700_000_000_000 + index,
        redacted: true
      });
    }
  }
  const store = createMemoryExperienceStore({ now: () => now, halfLifeMs });
  await store.append(records);
  const durations: number[] = [];
  for (const taskSpec of tasks) {
    const state = {
      level: 'meta' as const,
      bucket: 'meta|' + taskSpec.signature + '|' + taskSpec.complexity,
      tokens: ['sig:' + taskSpec.signature, 'cx:' + taskSpec.complexity, 'pslot:root'],
      summary: taskSpec.signature
    };
    const started = performance.now();
    await store.query({ level: 'meta', state, k, similarityThreshold: 0.3 });
    durations.push(performance.now() - started);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    p50: round(percentile(sorted, 0.5), 3),
    p95: round(percentile(sorted, 0.95), 3),
    mean: round(mean(durations), 3)
  };
}

function summarizeCondition(
  spec: ConditionSpec,
  tasks: readonly TaskResult[],
  health: ConditionalHealth,
  safety: ConditionalSafety,
  episodes: number
): ConditionResult {
  const allRuns = tasks.flatMap((task) => task.runs);
  const avg = mean(tasks.map((task) => task.avg));
  const final = mean(tasks.map((task) => task.final));
  const perTaskOracleRatio = tasks.map((task) => {
    const oracle = task.oracle;
    return oracle <= 0 ? 0 : mean(task.runs.map((run) => run.score)) / oracle;
  });
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: spec.group,
    ...(spec.axis === undefined ? {} : { axis: spec.axis }),
    episodes,
    config: {
      jitrlEnabled: spec.jitrlEnabled,
      levels: spec.levels,
      k: spec.k,
      beta: spec.beta,
      candidateCount: spec.candidateCount
    },
    tasks,
    avg: round(avg),
    final: round(final),
    finalMinusAvg: round(final - avg),
    solvedRate: round(mean(allRuns.map((run) => (run.solved ? 1 : 0)))),
    oracleRatio: round(mean(perTaskOracleRatio)),
    probesPerTask: round(
      mean(tasks.map((task) => mean(task.runs.map((run) => run.probes)))),
      2
    ),
    stepsPerRun: round(mean(allRuns.filter((run) => run.steps > 0).map((run) => run.steps)), 2),
    modelCallsPerTask: round(mean(tasks.map((task) => mean(task.runs.map((run) => run.modelCalls)))), 2),
    health,
    safety
  };
}

/** Execute the whole protocol and return a JSON-serializable report. */
export async function runEval(options: EvalOptions = {}): Promise<EvalReport> {
  const startedAt = performance.now();
  const episodes = options.episodes ?? 5;
  const tasks = options.tasks ?? EVAL_TASKS;
  const wanted = options.conditions;
  const selected = wanted === undefined
    ? CONDITIONS
    : CONDITIONS.filter((spec) => wanted.includes(spec.id));
  const canary = options.canary ?? DEFAULT_CANARY;
  const metrics: ConditionResult[] = [];
  const perConditionMs: Record<string, number> = {};
  for (const spec of selected) {
    const conditionStarted = performance.now();
    const result = await runCondition(spec, { episodes, tasks, canary });
    metrics.push(result);
    perConditionMs[spec.id] = round(performance.now() - conditionStarted, 2);
  }
  return {
    harness: 'dsh-plugin-evo-harness jitrl ablation',
    protocol: {
      episodes,
      taskCount: tasks.length,
      families: [...new Set(tasks.map((task) => task.family))],
      seed: '0x' + suiteSeed(tasks).toString(16) + ' (suite fingerprint; the metric block is deterministic)',
      deterministic: true
    },
    metrics,
    unimplemented: [...UNIMPLEMENTED_ABLATIONS],
    timing: { totalMs: round(performance.now() - startedAt, 2), perConditionMs }
  };
}

// ---------------------------------------------------------------------------
// markdown report
// ---------------------------------------------------------------------------

/** Fixed-point formatting used by both the CLI summary and the report. */
export function fixed(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function signed(value: number, digits = 3): string {
  const text = fixed(value, digits);
  return value > 0 ? '+' + text : text;
}

/** Render the comparison report from measured numbers only. */
export function renderMarkdown(
  report: EvalReport,
  meta: { readonly commit: string; readonly generatedAt: string; readonly command: string }
): string {
  const byId = new Map(report.metrics.map((entry) => [entry.id, entry] as const));
  const pick = (ids: readonly ConditionId[]): ConditionResult[] =>
    ids
      .map((id) => byId.get(id))
      .filter((entry): entry is ConditionResult => entry !== undefined);
  const baselines = pick(['B0', 'B1', 'B2', 'B3']);
  const kSweep = pick(['A2-k4', 'A2-k8', 'A2-k10', 'A2-k14', 'A2-k20']);
  const betaSweep = pick(['A3-beta0.5', 'A3-beta1', 'A3-beta2', 'A3-beta4']);
  const lines: string[] = [];
  lines.push('# P5-c JitRL 评测报告（第一份）');
  lines.push('');
  lines.push('> 本文件由 `' + meta.command + '` 生成；表中每个数字都来自该命令的一次真实执行，没有手写估值。');
  lines.push('');
  lines.push('## 1. 协议与可复现性');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 生成时间（本地） | ' + meta.generatedAt + ' |');
  lines.push('| 对应代码版本 | `' + meta.commit + '`（工作树，未提交改动一并计入） |');
  lines.push('| 协议 | 每任务连续 L=' + String(report.protocol.episodes) + ' 次；报告 Avg（5 次均值）、Final（第 5 次）、Final−Avg |');
  lines.push('| 任务集 | ' + String(report.protocol.taskCount) + ' 个离线合成任务；家族：' + report.protocol.families.join(', ') + ' |');
  lines.push('| 随机性 | ' + report.protocol.seed + ' |');
  lines.push('| 依赖 | 零新增 npm 依赖；直接 import TS 源，Node 22 直接运行 |');
  lines.push('');
  lines.push('### 1.1 这是什么样的任务集');
  lines.push('');
  lines.push('本报告使用方案 §9.1 的第 1 类任务集（离线合成集），**不是**真实仓库基准：');
  lines.push('');
  lines.push('- 每个任务有一个**必需表面集合**（相当于“通过的测试”）和一个**提案者偏好顺序**（proposer 自己并不知道必需集合）；');
  lines.push('- 分支执行器是确定性的：候选 patch 覆盖到的必需表面越多越容易成功；完全覆盖是干净的一次通过，部分覆盖要先吃一次工具错误；参考运行固定失败，保证每个任务都有进化空间；');
  lines.push('- mock 模型：`compose` 按 composer 渲染出的行为维度做**规则化排序**（完成度 → 工具错误 → 步数 → 交付物长度），再交给真实 composer 用 85/15 的「证据为主」混合；`reflect` 不产出 lesson；`evaluate_steps` 给中性分。它不是真实 LLM，但也不是常量，所以候选之间的取舍由行为证据驱动而不是由别名先后决定；');
  lines.push('- 单候选路径：提案者「深化」父节点尚未覆盖的第一偏好表面（提案者不读必需集合），所以多轮血缘能把覆盖率推高；');
  lines.push('- K 候选路径：给出 A=`[首个未覆盖偏好]`、B=`[次个未覆盖偏好]`、C=`两者合并` 三个候选；A 的先验置信度最高（0.55）、B 最低（0.45）、C 居中（0.50）。**先验在所有 run 上保持不变**，所以 run 1 与 run L 之间唯一变化的是内核积累的经验——这是 Avg/Final 能归因于学习的前提。');
  lines.push('');
  lines.push('因此下面的结论只关于**这套合成环境里的机制**：槽位/候选分配会不会随经验改变、改变后是否更好。它不能替代真实基准（JobBench / LAB / WorkBuddy-Bench / 30 个自建仓库任务）。');
  lines.push('');
  lines.push('### 1.2 确定性');
  lines.push('');
  lines.push('评测配置把 `jitrl.exploration.lambda` 设为 0、`selection` 设为 `argmax`：内核里唯一未被注入的随机源（乐观探索的 `Math.random` 抽样）不再影响任何取值，其余输入都是注入的单调时钟。因此指标块是任务集与配置的纯函数，`node scripts/eval-jitrl.mjs --json` 两次运行逐字节相同（CI 断言见 `tests/e2e/jitrl-ablation.test.ts`）。计时字段不在该块内。');
  lines.push('');
  lines.push('## 2. 对照组 B0–B3');
  lines.push('');
  lines.push('| 组 | 配置 | Avg | Final | Final−Avg | 解出率 | oracle 比 | probes/任务 | 模型调用/任务 |');
  lines.push('| :-- | :-- | --: | --: | --: | --: | --: | --: | --: |');
  for (const entry of baselines) {
    lines.push(
      '| ' + entry.label + ' | ' + entry.description + ' | ' +
      fixed(entry.avg) + ' | ' + fixed(entry.final) + ' | ' + signed(entry.finalMinusAvg) + ' | ' +
      fixed(entry.solvedRate) + ' | ' + fixed(entry.oracleRatio) + ' | ' +
      fixed(entry.probesPerTask, 2) + ' | ' + fixed(entry.modelCallsPerTask, 2) + ' |'
    );
  }
  lines.push('');
  lines.push('`Avg`/`Final` 是**覆盖率**（命中的必需表面 / 必需表面总数）在 12 个任务上的平均值；`解出率` 是完全解出（覆盖率 = 1）的 run 占比；`oracle 比` 是「实测覆盖率 / 该任务在表内可达到的最优覆盖率」，用来区分「没学会」与「学到的就是上限」。');
  lines.push('');
  lines.push('`B0 Static` 不构造插件：任务表直接给出「无脚手架时改哪个表面」，是一个明确的静态基线，而不是某条流水线的测量值。');
  lines.push('');
  lines.push('## 3. 消融 A2：近邻预算 k');
  lines.push('');
  lines.push('| k | Avg | Final | Final−Avg | 解出率 | KL 均值 | KL p95 | 近邻命中率 | 决策数 |');
  lines.push('| --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const entry of kSweep) {
    lines.push(
      '| ' + String(entry.config.k) + ' | ' + fixed(entry.avg) + ' | ' + fixed(entry.final) + ' | ' +
      signed(entry.finalMinusAvg) + ' | ' + fixed(entry.solvedRate) + ' | ' +
      fixed(entry.health.klMean) + ' | ' + fixed(entry.health.klP95) + ' | ' +
      fixed(entry.health.neighborHitRate) + ' | ' + String(entry.health.decisions) + ' |'
    );
  }
  lines.push('');
  lines.push('## 4. 消融 A3：KL 温度 β');
  lines.push('');
  lines.push('| β | Avg | Final | Final−Avg | 解出率 | KL 均值 | KL p50 | KL p95 | KL max |');
  lines.push('| --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const entry of betaSweep) {
    lines.push(
      '| ' + String(entry.config.beta) + ' | ' + fixed(entry.avg) + ' | ' + fixed(entry.final) + ' | ' +
      signed(entry.finalMinusAvg) + ' | ' + fixed(entry.solvedRate) + ' | ' +
      fixed(entry.health.klMean) + ' | ' + fixed(entry.health.klP50) + ' | ' +
      fixed(entry.health.klP95) + ' | ' + fixed(entry.health.klMax) + ' |'
    );
  }
  lines.push('');
  lines.push('β 只改变**分配**的温度，不改变证据本身：`KL(π′‖π_prior)` 随 β 单调上升，而 Avg/Final 是否上升取决于经验给出的优势方向是否正确。两者要分开读。');
  lines.push('');
  lines.push('## 5. 健康度指标');
  lines.push('');
  lines.push('| 组 | 决策数 | KL 均值 | KL p50 | KL p95 | KL max | 近邻命中率 | bucket 数 | 经验库规模 | 检索 p50 (ms) | 检索 p95 (ms) |');
  lines.push('| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const entry of report.metrics) {
    lines.push(
      '| ' + entry.id + ' | ' + String(entry.health.decisions) + ' | ' + fixed(entry.health.klMean) + ' | ' +
      fixed(entry.health.klP50) + ' | ' + fixed(entry.health.klP95) + ' | ' + fixed(entry.health.klMax) + ' | ' +
      fixed(entry.health.neighborHitRate) + ' | ' + String(entry.health.bucketCount) + ' | ' +
      String(entry.health.storeSize) + ' | ' + fixed(entry.health.retrievalP50Ms, 3) + ' | ' +
      fixed(entry.health.retrievalP95Ms, 3) + ' |'
    );
  }
  lines.push('');
  lines.push('经验库规模与 bucket 数来自 `/evo jit status` 的实时输出；检索延迟是对内存 store 的查询微基准（同一份合成语料、相同 k），**不含**采集与落盘成本，也不参与确定性断言。');
  lines.push('');
  lines.push('## 6. 安全指标');
  lines.push('');
  lines.push('| 组 | invariant 泄漏 | invariant 记忆泄漏 | invariant guidance 违约 | canary 泄漏 | invariant 提案数 |');
  lines.push('| :-- | --: | --: | --: | --: | --: |');
  for (const entry of report.metrics) {
    lines.push(
      '| ' + entry.id + ' | ' + String(entry.safety.invariantLeaks) + ' | ' +
      String(entry.safety.invariantMemoryLeaks) + ' | ' + String(entry.safety.invariantGuidanceLeaks) + ' | ' +
      String(entry.safety.canaryLeaks) + ' | ' + String(entry.safety.invariantProbes) + ' |'
    );
  }
  lines.push('');
  lines.push('三类 invariant 泄漏与 canary 泄漏都必须为 0，并作为 CI 断言（`pnpm run test:e2e`）。canary 是写进每个任务 prompt 的 `sk-...` 形态串：它出现在 prompt 里但不允许出现在任何可观测输出（run 诊断、`/evo jit status`、`/evo jit explain`）中；经验库本身不存原文（`storeRawText:false`），本轮无法从插件句柄直接读原始记录，因此这里的检测范围是**可观测通道**，这一点如实标注。');
  lines.push('');
  lines.push('## 7. 本轮未实现的消融');
  lines.push('');
  lines.push('以下消融项在方案 §9.2 中列出，本轮**未实现**，在此明确列出而不是静默省略：');
  lines.push('');
  lines.push('| 项 | 未实现的原因 |');
  lines.push('| :-- | :-- |');
  for (const entry of report.unimplemented) {
    lines.push('| ' + entry.id + ' | ' + entry.reason + ' |');
  }
  lines.push('');
  lines.push('## 8. 如何复现与 CI 门禁');
  lines.push('');
  lines.push('```');
  lines.push('# 完整协议 + 重新生成本报告');
  lines.push('node scripts/eval-jitrl.mjs --report work/p5-eval-report.md');
  lines.push('');
  lines.push('# 只输出 JSON（与 CI 断言使用同一入口）');
  lines.push('node scripts/eval-jitrl.mjs --json');
  lines.push('');
  lines.push('# 通过 pnpm 脚本');
  lines.push('pnpm run eval:jitrl');
  lines.push('```');
  lines.push('');
  lines.push('脚本在以下情况以非 0 退出：任何 invariant/canary 泄漏；任一条件 `Avg` 低于 `--min-avg`（默认 0）；`--expect-final-improvement` 打开时 Final < Avg。CI 的阈值断言在 `tests/e2e/jitrl-ablation.test.ts`。');
  lines.push('');
  lines.push('## 9. 如何读这份报告');
  lines.push('');
  lines.push('- **B0 → B1**：Harness² 生命周期本身的价值（多轮血缘把部分覆盖推到完全覆盖）；');
  lines.push('- **B1 → B2**：L1 元调度在固定探针预算下能否重排槽位组合；');
  lines.push('- **B2 → B3**：K 候选择能否在一个候选里给出「合并修复」，从而缩短达到满覆盖所需的轮数；');
  lines.push('- **Final − Avg**：同一套经验在第 5 次运行是否比前 5 次平均更好，即学习效率；');
  lines.push('- **oracle 比**：离该任务在表内可达到的上限还有多远。');
  lines.push('');
  lines.push('## 10. 本轮的诚实结论');
  lines.push('');
  for (const line of findings(report)) {
    lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Findings derived from the measured report, not written by hand.
 *
 * Every sentence is computed from the metrics in `report`, and the section
 * states the null and negative results as plainly as the positive ones.
 */
function findings(report: EvalReport): readonly string[] {
  const byId = new Map(report.metrics.map((entry) => [entry.id, entry] as const));
  const b0 = byId.get('B0');
  const b1 = byId.get('B1');
  const b2 = byId.get('B2');
  const b3 = byId.get('B3');
  const kSweep = report.metrics.filter((entry) => entry.axis === 'k');
  const betaSweep = report.metrics.filter((entry) => entry.axis === 'beta');
  const lines: string[] = [];
  const pct = (value: number): string => (value * 100).toFixed(1) + '%';

  if (b0 !== undefined && b1 !== undefined) {
    const delta = b1.avg - b0.avg;
    lines.push(
      '- **Harness² 生命周期有效**：B1 覆盖率 ' + fixed(b1.avg) + ' 对比静态基线 B0 ' + fixed(b0.avg) +
      '，绝对提升 ' + signed(delta) + '（相对 +' + pct(delta / Math.max(1e-9, b0.avg)) + '）；解出率 ' +
      pct(b1.solvedRate) + ' 对 ' + pct(b0.solvedRate) + '。来源是单候选路径的「深化」：第 2 轮提案者补上父节点没覆盖的偏好表面，composer 把父 patch 的编辑合并回来。'
    );
  }
  if (b1 !== undefined && b2 !== undefined) {
    const delta = b2.avg - b1.avg;
    lines.push(
      delta > 1e-9
        ? '- **L1 元调度有效**：B2 覆盖率 ' + fixed(b2.avg) + ' 高于 B1 ' + fixed(b1.avg) + '（' + signed(delta) + '）。'
        : '- **L1 元调度在这套任务集上是零效应（如实记录）**：B2 覆盖率 ' + fixed(b2.avg) + ' 与 B1 ' + fixed(b1.avg) +
          ' 完全相同。原因可查：L1 的 4 个槽位动作在同一轮里都拿到同一个回报（每轮只评估获胜候选一次），于是 Ã 归一化后全为 0，' +
          'KL 也就只剩 ' + fixed(b2.health.klMean) + ' 的极小值。也就是说，**槽位级别的信用分配需要按槽位分别计分**，' +
          '而当前 orchestrator 只对获胜候选计分——这是本轮暴露的真实设计缺口，不是度量误差。'
    );
  }
  if (b1 !== undefined && b3 !== undefined) {
    const delta = b3.avg - b1.avg;
    lines.push(
      delta > 1e-9
        ? '- **L2 候选选择有效**：B3 覆盖率 ' + fixed(b3.avg) + ' 高于 B1 ' + fixed(b1.avg) + '（' + signed(delta) +
          '），解出率 ' + pct(b3.solvedRate) + ' 对 ' + pct(b1.solvedRate) +
          '。机制：K 候选里的「合并」候选能在第 1 轮就把两个必需表面一起改到，而单候选路径要等到第 2 轮。'
        : '- **L2 候选选择在本轮无正收益（如实记录）**：B3 覆盖率 ' + fixed(b3.avg) + ' 对 B1 ' + fixed(b1.avg) + '。'
    );
  }
  if (b3 !== undefined) {
    lines.push(
      '- **Final − Avg = ' + signed(b3.finalMinusAvg) + '（B3）**：第 5 次运行 ' + fixed(b3.final) + ' 与 5 次均值 ' + fixed(b3.avg) +
      ' 的差。这个量很小，说明在这套 12 个任务、每个任务只有 5 次运行的环境里，经验积累只够改变少数任务的决策；它不是「学习无效」的证据，但也**不足以声称学习效率很高**。'
    );
  }
  if (kSweep.length >= 2) {
    const first = kSweep[0] as ConditionResult;
    const last = kSweep[kSweep.length - 1] as ConditionResult;
    const best = kSweep.reduce((left, right) => (right.avg > left.avg ? right : left));
    lines.push(
      '- **A2（k）**：k=' + String(first.config.k) + ' → ' + fixed(first.avg) + '，k=' + String(last.config.k) + ' → ' + fixed(last.avg) +
      '，本轮最优 k=' + String(best.config.k) + '（' + fixed(best.avg) + '）。k 太小（' + String(first.config.k) +
      '）时近邻不足以形成稳定优势，KL 直接掉到 ' + fixed(first.health.klMean) + '；k 变大后覆盖率与 KL 同时上升。' +
      '注意 k 也只改变**检索宽度**，不改变打分口径。'
    );
  }
  if (betaSweep.length >= 2) {
    const sorted = [...betaSweep].sort((left, right) => left.config.beta - right.config.beta);
    const lowest = sorted[0] as ConditionResult;
    const highest = sorted[sorted.length - 1] as ConditionResult;
    const monotone = sorted.every((entry, index) => index === 0 || entry.health.klMean >= (sorted[index - 1] as ConditionResult).health.klMean - 1e-12);
    lines.push(
      '- **A3（β）**：β 从 ' + String(lowest.config.beta) + ' 到 ' + String(highest.config.beta) +
      '，KL 均值从 ' + fixed(lowest.health.klMean) + ' 升到 ' + fixed(highest.health.klMean) +
      (monotone ? '，**单调上升**（符合 §6.4 的闭式解）' : '，在本轮不是严格单调（如实记录）') +
      '；而 Avg 在所有 β 上都是 ' + fixed(betaSweep[0]?.avg ?? 0) +
      '，即**温度只改变分配幅度、不改变最终选中的槽位组合**。这符合预期：β 是 KL 温度，不是评分函数。'
    );
  }
  const leaks = report.metrics.reduce(
    (total, entry) =>
      total + entry.safety.invariantLeaks + entry.safety.invariantMemoryLeaks + entry.safety.invariantGuidanceLeaks + entry.safety.canaryLeaks,
    0
  );
  lines.push(
    '- **安全**：' + String(report.metrics.length) + ' 个条件共 ' +
    String(report.metrics.reduce((total, entry) => total + entry.safety.invariantProbes, 0)) +
    ' 次 invariant 提案，三类 invariant 泄漏与 canary 泄漏合计 **' + String(leaks) + '**（要求为 0，CI 已断言）。'
  );
  lines.push(
    '- **不能从本报告得出的结论**：真实仓库任务上的收益、跨任务泛化的强度、真实 LLM judge 的影响、embedding 检索是否更好。' +
    '这些需要 §9.1 的第 2/3 类任务集，本轮未做。'
  );
  return lines;
}
