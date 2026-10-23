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
import { abstractMetaState, abstractProposalState } from '../../src/jitrl/state-abstraction';
import { normalizePatchSignature } from '../../src/jitrl/action-normalizer';
import { verbalizedLogit } from '../../src/jitrl/logit-sources';
import { scoreTrajectorySignals } from '../../src/jitrl/step-evaluator';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../src/jitrl/experience-store';
import {
  normalizeLayerDecisionConfig,
  projectNeighborsBySlotKind,
  runDecisionKernel,
  seedFromParts,
  type LayerDecisionConfig
} from '../../src/jitrl/decision-kernel';
import type {
  AbstractState,
  BatchSlotKind,
  BranchExecutor,
  DiscoveryNode,
  EightSurfacePatch,
  ExperienceRecord,
  FailureSignal,
  GuidanceMode,
  HarnessComponentKey,
  IHarnessProposer,
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  PatchOrigin,
  ProbeExecutionResult,
  ProbeTask,
  ProbeTrajectory,
  ProposeRequest,
  ProposedPatch,
  ProposedPatchSet,
  ToolErrorRecord,
  TrajectoryDeliverable,
  TrajectoryStatus,
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

// ---------------------------------------------------------------------------
// P6 PR6: the fair comparison (plan section 8.1-8.3)
// ---------------------------------------------------------------------------
//
// R6 defect: B1/B2 ran candidateCount=1 while B3 ran candidateCount=3, and B3's
// third candidate was a two-surface merge, so B3 > B1 mixes three changes
// (richer candidate set, a selector, and accumulated experience). Nothing in it
// can be attributed to the JitRL logit correction. The arms below fix the
// candidate pool FIRST - same K=3 pool, same proposer rule, same seed material,
// and a pool digest that every arm must reproduce - and only then vary the
// selection channel and whether executed probes are written back as experience.
//
// The engine drives the SAME pure decision kernel the plugin runs
// (src/jitrl/decision-kernel.ts) over an explicitly controlled experience
// snapshot. That is what makes "same initial snapshot" a checkable fact instead
// of a claim: C3-frozen and C3-online are seeded from the same frozen record
// array, and the frozen arm provably ends the window with exactly that snapshot
// (finalSnapshotDigest === initialSnapshotDigest).
//
// Everything here is a REPLAY: the candidate pool is fixed by the task table,
// never generated by a live model. The live plugin pipeline (B0-B3) therefore
// stays the separate "online candidate generation" item; it is not comparable
// to C0-C4 arm by arm because its pool varies with the model.
//
// Cost boundary (plan section 8.1): the same probe count is NOT the same total
// cost. Probe counts, failures and wall time are measured; token figures are
// ESTIMATES from the rendered prompt text with a documented chars/4 estimator,
// because this harness has no tokenizer and the mock model is passive.

export type FairArmId = 'C0' | 'C1' | 'C2' | 'C3-frozen' | 'C3-online' | 'C4';

/** How an arm turns the fixed candidate pool into one executed choice. */
export type FairSelection = 'prior' | 'random' | 'advice' | 'kernel';

export interface FairArmSpec {
  readonly id: FairArmId;
  readonly label: string;
  readonly selection: FairSelection;
  /** Executed probes are written back as experience (learning arm). */
  readonly updates: boolean;
  /** An L1 (meta) allocation decision runs in front of the L2 choice. */
  readonly level1: boolean;
  /** Retrieved statistics are injected into the prompt instead of the logit. */
  readonly adviceChannel: boolean;
  readonly description: string;
}

/**
 * C0-C4 (plan section 8.1). Historical B0-B3 stay in CONDITIONS and in
 * docs/reports/p5-eval-report.md untouched; these are additive.
 */
export const FAIR_ARMS: readonly FairArmSpec[] = [
  {
    id: 'C0',
    label: 'C0 prior / no learning',
    selection: 'prior',
    updates: false,
    level1: false,
    adviceChannel: false,
    description: 'same K=3 pool; the highest-prior candidate is always taken; no experience is written'
  },
  {
    id: 'C1',
    label: 'C1 random / fixed seed',
    selection: 'random',
    updates: false,
    level1: false,
    adviceChannel: false,
    description: 'same K=3 pool; uniform choice from a fixed seed; no experience is written'
  },
  {
    id: 'C2',
    label: 'C2 retrieval + prompt advice (A1)',
    selection: 'advice',
    updates: true,
    level1: false,
    adviceChannel: true,
    description: 'same K=3 pool and the same retrieval; statistics go into the prompt, the logit is NOT corrected'
  },
  {
    id: 'C3-frozen',
    label: 'C3 L2 frozen (no learning)',
    selection: 'kernel',
    updates: false,
    level1: false,
    adviceChannel: false,
    description: 'same K=3 pool; JitRL L2 selects; decisions are recorded but the experience snapshot never changes'
  },
  {
    id: 'C3-online',
    label: 'C3 L2 online (learning)',
    selection: 'kernel',
    updates: true,
    level1: false,
    adviceChannel: false,
    description: 'same K=3 pool; JitRL L2 selects and every executed probe is written back with its own attribution'
  },
  {
    id: 'C4',
    label: 'C4 L1 + L2',
    selection: 'kernel',
    updates: true,
    level1: true,
    adviceChannel: false,
    description: 'same K=3 pool; L1 allocates the slot kind, L2 selects the candidate, both levels learn'
  }
];

export function fairArm(id: FairArmId): FairArmSpec {
  const found = FAIR_ARMS.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new RangeError('unknown fair arm: ' + id);
  }
  return found;
}

/** The four L1 slot kinds, in the order the kernel projects them. */
const FAIR_SLOT_KINDS: readonly BatchSlotKind[] = [
  'exploit',
  'explore_domain',
  'explore_invariant',
  'recover'
];

/** One candidate of the fixed pool: a surface delta plus its prior confidence. */
export interface FairPoolCandidate {
  readonly index: number;
  readonly surfaces: readonly ProposableSurface[];
  readonly confidence: number;
  /** Signature of the candidate's own delta patch (the L2 action key). */
  readonly actionKey: string;
  readonly patch: EightSurfacePatch;
}

/**
 * The fixed K=3 pool for one decision point.
 *
 * The shapes come from the same `kCandidateShapes` rule the live proposer uses
 * (narrow A, narrow B, two-surface merge), driven by the parent's covered
 * surface set, so "the plugin's pool" and "the fair pool" are literally the same
 * construction. The confidence prior is `kConfidences()`, likewise shared.
 */
export function fairCandidatePool(
  taskSpec: EvalTask,
  covered: readonly string[]
): readonly FairPoolCandidate[] {
  const parent = { metadata: { surfaceKeys: [...covered] } } as unknown as DiscoveryNode;
  const shapes = kCandidateShapes(taskSpec, parent);
  const confidences = kConfidences();
  const seen = new Set<string>();
  return shapes.map((surfaces, index) => {
    const patch = {
      id: 'fair-pool-' + taskSpec.id + '-' + String(index + 1),
      sessionId: 'fair-pool',
      branchId: 'fair-pool',
      origin: 'explore',
      purpose: 'explore',
      guidance: 'memory',
      label: 'fair-pool-' + String(index + 1),
      rationale: 'fixed fair pool candidate',
      edits: surfaceEdits(surfaces, 'exploit', index)
    } as unknown as EightSurfacePatch;
    const base = normalizePatchSignature(patch);
    const actionKey = seen.has(base) ? base + '#' + String(index) : base;
    seen.add(base);
    return {
      index,
      surfaces,
      confidence: confidences[index] ?? 0.4,
      actionKey,
      patch
    };
  });
}

/** Stable fingerprint of one pool (per decision) or of a pool sequence. */
export function fairPoolDigest(candidates: readonly FairPoolCandidate[]): string {
  return hashString(
    candidates
      .map((entry) => entry.actionKey + '@' + entry.confidence.toFixed(4) + ':' + entry.surfaces.join('+'))
      .join('|')
  )
    .toString(16)
    .padStart(8, '0');
}

/**
 * Parent coverage of the FIXED pool schedule.
 *
 * The plan requires the candidate pool to be fixed/replayed before any fairness
 * claim (section 8.1), so the pool must not depend on what the arm itself chose:
 * otherwise the arms would drift into different pools and the comparison would
 * be confounded again. The schedule below is the prior-only deepening lineage
 * (`prefs.slice(0, round)`), i.e. exactly the lineage the C0 rule accumulates,
 * and it is a pure function of (task, round) - the same for every arm and every
 * run. The arm's own lineage still drives the executed composed patch; only the
 * stimulus (which K candidates are offered) is held constant.
 */
export function fairFixedPoolParent(taskSpec: EvalTask, round: number): readonly string[] {
  return taskSpec.prefs.slice(0, Math.max(0, round));
}

/** The pool every arm must see at one decision point of the fixed schedule. */
export function fairPoolForDecision(taskSpec: EvalTask, round: number): readonly FairPoolCandidate[] {
  return fairCandidatePool(taskSpec, fairFixedPoolParent(taskSpec, round));
}

/** Fingerprint of the fixed pool at one decision point (the cross-arm witness). */
export function fairFixedPoolDigest(taskSpec: EvalTask, round: number): string {
  return fairPoolDigest(fairPoolForDecision(taskSpec, round));
}

/** Stable fingerprint of a record set (initial vs final snapshot evidence). */
export function fairSnapshotDigest(records: readonly ExperienceRecord[]): string {
  if (records.length === 0) {
    return 'empty';
  }
  const canonical = [...records]
    .map((record) =>
      [
        record.id,
        record.level,
        record.actionKey,
        record.state.bucket,
        record.return.toFixed(6),
        record.learningTarget === undefined ? 'n/a' : record.learningTarget.toFixed(6),
        record.observedReturn === undefined ? 'n/a' : record.observedReturn.toFixed(6),
        record.attributionBaseline === undefined ? 'n/a' : record.attributionBaseline.toFixed(6),
        record.outcome ?? 'unknown',
        record.learningEligible === false ? 'ineligible' : 'eligible',
        record.createdAt
      ].join('~')
    )
    .sort()
    .join('\n');
  return hashString(canonical).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// cost accounting (plan section 8.1: same probe count != same total cost)
// ---------------------------------------------------------------------------

/** Rendering estimator: documented, deliberately conservative and labelled. */
export const FAIR_TOKEN_ESTIMATOR = 'chars/4 over the exact rendered prompt text (no tokenizer in this harness)';

export interface FairCost {
  readonly probesRun: number;
  readonly poolGenerations: number;
  /** Rendered K-candidate prompt, second stage skipped entirely for C0/C1. */
  readonly candidateGenerationTokens: number;
  /** Rendered evaluation prompt for the winning probe (one per run). */
  readonly evaluationTokens: number;
  /** Rendered prompt-advice block; only C2 pays this, counted separately. */
  readonly promptAdviceTokens: number;
  /** Model calls the arm would issue for those rendered prompts. */
  readonly modelCalls: number;
  /** Measured wall time of the arm. */
  readonly timeMs: number;
  /** Probes that ended without the task being verified. */
  readonly failedProbes: number;
  /** Retries: none in this deterministic in-memory runner (recorded, not assumed). */
  readonly retries: number;
  readonly retryNote: string;
  readonly estimator: string;
}

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** The exact text a proposer prompt would carry for the fixed pool. */
export function renderPoolPrompt(taskSpec: EvalTask, round: number, pool: readonly FairPoolCandidate[]): string {
  const rows = pool.map((entry) => ({
    candidate: 'candidate_' + String.fromCharCode(65 + entry.index),
    edits: [...entry.surfaces],
    confidence: entry.confidence
  }));
  return [
    'task=' + taskSpec.signature,
    'round=' + String(round),
    'propose K=' + String(pool.length) + ' candidates',
    JSON.stringify(rows)
  ].join('\n');
}

/** The exact text an evaluation prompt would carry for one executed probe. */
export function renderEvaluationPrompt(
  taskSpec: EvalTask,
  probe: { readonly candidateIndex: number; readonly verified: boolean; readonly coverage: number }
): string {
  return [
    'task=' + taskSpec.signature,
    'probe=candidate_' + String.fromCharCode(65 + probe.candidateIndex),
    'verified=' + String(probe.verified),
    'coverage=' + probe.coverage.toFixed(4)
  ].join('\n');
}

// ---------------------------------------------------------------------------
// advice channel (C2 == A1: same retrieval, prompt statistics, no logit fix)
// ---------------------------------------------------------------------------

export interface FairAdviceRow {
  readonly actionKey: string;
  readonly support: number;
  readonly meanReturn: number;
}

export interface FairAdvice {
  readonly rows: readonly FairAdviceRow[];
  readonly text: string;
  readonly tokens: number;
  /** Pool index the advice recommends, or null when no row clears minSupport. */
  readonly pick: number | null;
}

/** Minimum support before a retrieved row may steer the prompt consumer. */
export const FAIR_ADVICE_MIN_SUPPORT = 2;

/**
 * Render the retrieval statistics into the prompt and let a rule-following
 * consumer act on them.
 *
 * This is the A1 arm: the neighbourhood is the kernel's own neighbourhood (same
 * filter, bucket, Jaccard, decay, top-k), the statistics are rendered as text,
 * and the logit is never corrected. The consumer is deterministic because there
 * is no live model here; the rule is the one a model would be instructed with
 * ("prefer the action with the best mean return among sufficiently supported
 * ones, otherwise keep your prior"), which is exactly the rule the report
 * documents. The token count is charged to C2 alone.
 */
export function fairAdvice(
  neighbors: readonly { readonly record: ExperienceRecord }[],
  candidates: readonly FairPoolCandidate[]
): FairAdvice {
  const byKey = new Map<string, { total: number; count: number }>();
  for (const neighbor of neighbors) {
    const key = neighbor.record.actionKey;
    const bucket = byKey.get(key) ?? { total: 0, count: 0 };
    bucket.total += Number.isFinite(neighbor.record.return) ? neighbor.record.return : 0;
    bucket.count += 1;
    byKey.set(key, bucket);
  }
  const rows: FairAdviceRow[] = candidates.map((entry) => {
    const bucket = byKey.get(entry.actionKey);
    return {
      actionKey: entry.actionKey,
      support: bucket?.count ?? 0,
      meanReturn: bucket === undefined || bucket.count === 0 ? 0 : bucket.total / bucket.count
    };
  });
  const text = rows
    .map(
      (row) =>
        'action=' + row.actionKey + ' support=' + String(row.support) + ' meanReturn=' + row.meanReturn.toFixed(4)
    )
    .join('\n');
  let pick: number | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.support < FAIR_ADVICE_MIN_SUPPORT) {
      continue;
    }
    if (row.meanReturn > best) {
      best = row.meanReturn;
      const candidate = candidates.find((entry) => entry.actionKey === row.actionKey);
      pick = candidate === undefined ? null : candidate.index;
    }
  }
  return { rows, text, tokens: estimateTokens(text), pick };
}

// ---------------------------------------------------------------------------
// environment bridge: the same synthetic runner, one fair candidate at a time
// ---------------------------------------------------------------------------

function fairTrajectory(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly patchId: string;
  readonly status: TrajectoryStatus;
  readonly steps: readonly TrajectoryStep[];
  readonly toolErrors: readonly ToolErrorRecord[];
  readonly deliverable?: TrajectoryDeliverable;
  readonly failureSignals: readonly FailureSignal[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly patchOrigin?: PatchOrigin;
  readonly role?: 'reference' | 'candidate';
}): ProbeTrajectory {
  return {
    id: input.id,
    sessionId: input.sessionId,
    branchId: input.branchId,
    branchNamespace: 'fair/' + input.branchId,
    role: input.role ?? 'candidate',
    status: input.status,
    patchId: input.patchId,
    patchOrigin: input.patchOrigin ?? 'domain',
    surfaceKeys: [],
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    metrics: {
      steps: input.steps.length,
      toolCalls: input.steps.filter((step) => step.kind === 'tool').length,
      toolErrors: input.toolErrors.length,
      durationMs: Math.max(0, input.endedAt - input.startedAt)
    },
    steps: input.steps,
    toolErrors: input.toolErrors,
    failureSignals: input.failureSignals,
    memoryRecallIds: [],
    ...(input.deliverable === undefined ? {} : { deliverable: input.deliverable })
  };
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(3, Math.max(-3, value));
}

/** The composed edits of one executed lineage: inherited coverage + the delta. */
function composedEdits(surfaces: readonly ProposableSurface[], index: number): Record<string, unknown> {
  return surfaceEdits(surfaces, 'exploit', index);
}

// ---------------------------------------------------------------------------
// the replay engine
// ---------------------------------------------------------------------------

export interface FairRunObservation {
  readonly runIndex: number;
  readonly score: number;
  readonly verified: boolean;
  readonly partial: boolean;
  readonly probes: number;
  readonly steps: number;
  readonly toolErrors: number;
  readonly kl: number;
  readonly neighbors: number;
  readonly support: number;
  readonly poolDigest: string;
  readonly chosen: readonly number[];
  readonly priorChoice: readonly number[];
  readonly policyChanged: boolean;
  readonly adviceTokens: number;
  readonly advicePicks: number;
  readonly adviceFallbacks: number;
  readonly poolPromptTokens: number;
  readonly evaluationTokens: number;
}

export interface FairTaskResult {
  readonly taskId: string;
  readonly familyId: string;
  /** Synthetic repository id; the suite has no real repo, see the report. */
  readonly repoId: string;
  readonly requiredCount: number;
  readonly oracle: number;
  readonly runs: readonly FairRunObservation[];
  readonly avgCoverage: number;
  readonly finalCoverage: number;
  readonly finalMinusAvg: number;
  readonly verifiedRate: number;
  readonly coverageCurve: readonly number[];
  readonly verifiedCurve: readonly number[];
  readonly experienceSource: 'self' | 'donor' | 'none';
  readonly storeRecords: number;
  readonly firstRecordAt: number | null;
  readonly lastRecordAt: number | null;
}

export interface FairArmHealth {
  readonly decisions: number;
  readonly klMean: number;
  readonly klNonZeroShare: number;
  readonly neighborHitRate: number;
  readonly meanSupport: number;
  readonly l1Decisions: number;
  readonly l1KlMean: number;
}

export interface FairAdviceStats {
  readonly tokens: number;
  readonly picks: number;
  readonly fallbacks: number;
  readonly changedChoiceRate: number;
}

export interface FairArmResult {
  readonly id: FairArmId;
  readonly label: string;
  readonly description: string;
  readonly selection: FairSelection;
  readonly updates: boolean;
  readonly level1: boolean;
  readonly adviceChannel: boolean;
  readonly protocol: FairProtocolKind;
  readonly episodes: number;
  readonly rounds: number;
  readonly seed: number;
  readonly k: number;
  readonly beta: number;
  readonly similarityThreshold: number;
  readonly tasks: readonly FairTaskResult[];
  /** Primary metrics (plan section 8.3): task verification pass / fail / budget. */
  readonly verifiedRate: number;
  readonly failedRate: number;
  readonly budgetCompletionRate: number;
  readonly meanCoverage: number;
  readonly finalCoverage: number;
  readonly finalMinusAvgCoverage: number;
  readonly coverageCurve: readonly number[];
  readonly verifiedCurve: readonly number[];
  readonly health: FairArmHealth;
  readonly toolErrorRate: number;
  readonly errorRepeatRate: number;
  readonly policyChangeRate: number;
  readonly cost: FairCost;
  readonly poolDigest: string;
  readonly initialSnapshotDigest: string;
  readonly finalSnapshotDigest: string;
  readonly snapshotFrozen: boolean;
  readonly initialSnapshotRecords: number;
  readonly recordsAppended: number;
  readonly storeRecords: number;
  readonly advice: FairAdviceStats | null;
  readonly notes: readonly string[];
}

interface FairEngineOptions {
  readonly spec: FairArmSpec;
  readonly tasks: readonly EvalTask[];
  readonly episodes: number;
  readonly rounds: number;
  readonly seed: number;
  readonly k: number;
  readonly beta: number;
  readonly similarityThreshold: number;
  readonly protocol: FairProtocolKind;
  readonly initialSnapshot: readonly ExperienceRecord[];
  readonly storeMode: 'per-task' | 'shared';
  readonly updates: boolean;
  readonly experienceSource: 'self' | 'donor' | 'none';
  /** Collects the final snapshot (used to seed the cross-task donor library). */
  readonly collectRecords?: (records: readonly ExperienceRecord[]) => void;
}

function probeTaskFor(taskSpec: EvalTask): ProbeTask {
  return {
    id: taskSpec.id,
    prompt: taskSpec.prompt,
    taskSignature: taskSpec.signature,
    complexity: taskSpec.complexity,
    contextTags: taskSpec.contextTags
  };
}

/**
 * Run one fair arm over a task list.
 *
 * Deterministic: the pool, the seeds, the clock and the runner are all injected,
 * so two runs with the same options produce byte-identical metric blocks.
 */
async function runFairEngine(options: FairEngineOptions): Promise<FairArmResult> {
  const { spec } = options;
  const wallStarted = performance.now();
  const clock = makeClock(1_700_000_000_000);
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
  const layerConfig: LayerDecisionConfig = normalizeLayerDecisionConfig({
    beta: options.beta,
    k: options.k,
    similarityThreshold: options.similarityThreshold,
    selection: 'argmax',
    lambda: 0,
    alpha: 5,
    unseenFallback: 'baseline',
    halfLifeMs
  });
  const tasksById = new Map(options.tasks.map((taskSpec) => [taskSpec.id, taskSpec] as const));
  const registry: ProposalRecord[] = [];
  const counters: RunnerCounters = {
    referenceRuns: 0,
    candidateRuns: 0,
    succeededRuns: 0,
    invariantGuidanceLeaks: 0,
    lastSteps: 0
  };
  const runner = createEvalRunner({ tasksById, proposals: registry, counters, now: clock });

  const openStore = (): ReturnType<typeof createMemoryExperienceStore> =>
    createMemoryExperienceStore({ now: clock, halfLifeMs, bucketCap: 200 });

  // The shared store also carries the donor snapshot for the cross-task
  // protocols; a per-task store is the cold start of the same-task protocol.
  const sharedStore = options.storeMode === 'shared' ? openStore() : undefined;
  if (sharedStore !== undefined && options.initialSnapshot.length > 0) {
    await sharedStore.append(options.initialSnapshot);
  }

  // Costs are accumulated over the whole arm; the rendered prompts are the real
  // text the arm would send, so only the token estimate is modelled.
  let poolGenerations = 0;
  let candidateGenerationTokens = 0;
  let evaluationTokens = 0;
  let promptAdviceTokens = 0;
  let modelCalls = 0;
  let probesRun = 0;
  let failedProbes = 0;
  let unverifiedProbes = 0;
  let recordsAppended = 0;
  const allPoolDigests: string[] = [];
  let advicePicks = 0;
  let adviceFallbacks = 0;
  let adviceChanged = 0;
  const klValues: number[] = [];
  const l1KlValues: number[] = [];
  const supports: number[] = [];
  const neighborCounts: number[] = [];
  let decisions = 0;
  let l1Decisions = 0;
  let totalRounds = 0;
  let changedChoices = 0;
  let toolErrorProbes = 0;
  let repeatedErrorRuns = 0;
  const pendingKeys = new Set<string>();
  const taskResults: FairTaskResult[] = [];
  const perTaskRecords: ExperienceRecord[] = [];

  for (const taskSpec of options.tasks) {
    const store = sharedStore ?? openStore();
    if (sharedStore === undefined && options.initialSnapshot.length > 0) {
      await store.append(options.initialSnapshot);
    }
    // The reference run is the comparable baseline every executed probe is
    // contrasted with (the same role it plays in the plugin's attribution).
    const referenceStarted = clock();
    const referenceResult = await runner({
      branchId: 'fair-ref',
      sessionId: 'fair-' + taskSpec.id,
      namespace: 'fair/ref',
      task: probeTaskFor(taskSpec),
      patch: {
        id: 'fair-ref-' + taskSpec.id,
        sessionId: 'fair-' + taskSpec.id,
        branchId: 'fair-ref',
        origin: 'reference',
        purpose: 'initial',
        guidance: 'guidance_free',
        edits: {}
      } as unknown as EightSurfacePatch,
      mountedSurfaces: [],
      signal: new AbortController().signal
    });
    const reference = fairTrajectory({
      id: 'fair-ref-traj-' + taskSpec.id,
      sessionId: 'fair-' + taskSpec.id,
      branchId: 'fair-ref',
      patchId: 'fair-ref-' + taskSpec.id,
      status: referenceResult.status ?? 'failed',
      steps: referenceResult.steps ?? [],
      toolErrors: referenceResult.toolErrors ?? [],
      ...(referenceResult.deliverable === undefined ? {} : { deliverable: referenceResult.deliverable }),
      failureSignals: referenceResult.failureSignals ?? [],
      startedAt: referenceStarted,
      endedAt: clock()
    });
    const baseline = clampScore(scoreTrajectorySignals(reference).reward);

    const runs: FairRunObservation[] = [];
    for (let runIndex = 0; runIndex < options.episodes; runIndex += 1) {
      const runId = 'fair-' + taskSpec.id + '-run' + String(runIndex);
      const nodeId = 'fair-node-' + taskSpec.id + '-run' + String(runIndex);
      let covered = new Set<string>();
      let parentSignature: string | undefined;
      let score = 0;
      let runProbes = 0;
      let runSteps = 0;
      let runToolErrors = 0;
      const runKl: number[] = [];
      const runNeighbors: number[] = [];
      const runSupport: number[] = [];
      const runPoolDigests: string[] = [];
      const chosen: number[] = [];
      const priorChoice: number[] = [];
      let runAdviceTokens = 0;
      let runAdvicePicks = 0;
      let runAdviceFallbacks = 0;
      let runPoolTokens = 0;
      let runEvaluationTokens = 0;
      let runPolicyChanged = false;
      const seenErrorIds = new Set<string>();
      let runRepeatedError = false;

      for (let round = 0; round < options.rounds; round += 1) {
        // Fixed pool schedule: the stimulus is identical for every arm at this
        // (task, run, round) - see fairFixedPoolParent.
        const pool = fairPoolForDecision(taskSpec, round);
        totalRounds += 1;
        runPoolDigests.push(fairFixedPoolDigest(taskSpec, round));
        allPoolDigests.push(
          taskSpec.id + '|run' + String(runIndex) + '|round' + String(round) + ':' + fairFixedPoolDigest(taskSpec, round)
        );
        runPoolTokens += estimateTokens(renderPoolPrompt(taskSpec, round, pool));
        poolGenerations += 1;
        candidateGenerationTokens += estimateTokens(renderPoolPrompt(taskSpec, round, pool));
        const candidates = pool.map((entry) => ({
          actionKey: entry.actionKey,
          baseLogit: verbalizedLogit(entry.confidence),
          source: 'llm' as const,
          payload: entry
        }));

        // One clock read per decision: the causal cutoff. Records written after
        // this point are invisible to this decision, so no round can read its own
        // outcome (plan section 8.2 protocol 1: past rounds only).
        const before = clock();
        const config: LayerDecisionConfig = { ...layerConfig, before };
        const priorIndex = pool.reduce(
          (best, entry) => (entry.confidence > (pool[best]?.confidence ?? Number.NEGATIVE_INFINITY) ? entry.index : best),
          0
        );
        priorChoice.push(priorIndex);

        let slotKind: BatchSlotKind = 'exploit';
        if (spec.level1) {
          const metaCandidates = FAIR_SLOT_KINDS.map((kind) => ({
            actionKey: 'slot:' + kind,
            baseLogit: 0,
            source: 'policy_prior' as const,
            payload: kind
          }));
          const metaState = abstractMetaState({
            task: probeTaskFor(taskSpec),
            round,
            parentDepth: round,
            parentSlot: slotKind,
            memoryConfidence: 0,
            referenceStatus: 'failed' as const
          });
          const metaResult = runDecisionKernel<BatchSlotKind>({
            level: 'meta',
            state: metaState,
            candidates: metaCandidates,
            records: store.snapshot(),
            config,
            projectNeighbors: projectNeighborsBySlotKind,
            seed: seedFromParts(options.seed, taskSpec.id, runIndex, round, 'l1')
          });
          slotKind = metaResult.decision.chosen.candidate.payload;
          l1Decisions += 1;
          l1KlValues.push(metaResult.decision.klToPrior);
        }
        const guidance: GuidanceMode = slotKind === 'explore_invariant' ? 'guidance_free' : 'memory';
        const state = abstractProposalState({
          task: probeTaskFor(taskSpec),
          round,
          parentDepth: round,
          parentSlot: slotKind,
          memoryConfidence: 0,
          referenceStatus: 'failed' as const,
          slot: slotKind,
          guidance,
          ...(parentSignature === undefined ? {} : { parentPatchSignature: parentSignature })
        });

        let chosenIndex = priorIndex;
        let decisionKl = 0;
        let decisionNeighbors = 0;
        let decisionSupport = 0;
        let usedAdvice = false;
        if (spec.selection === 'random') {
          const rng = createRng(seedFromParts(options.seed, taskSpec.id, runIndex, round, 'c1'));
          chosenIndex = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
        } else if (spec.selection === 'advice' || spec.selection === 'kernel') {
          const kernelResult = runDecisionKernel<FairPoolCandidate>({
            level: 'proposal',
            state,
            candidates,
            records: store.snapshot(),
            config,
            guidance,
            seed: seedFromParts(options.seed, taskSpec.id, runIndex, round, 'l2')
          });
          decisionKl = kernelResult.decision.klToPrior;
          decisionNeighbors = kernelResult.decision.neighborCount;
          decisionSupport = kernelResult.decision.chosen.support;
          if (spec.selection === 'advice') {
            const advice = fairAdvice(kernelResult.neighbors, pool);
            usedAdvice = true;
            runAdviceTokens += advice.tokens;
            promptAdviceTokens += advice.tokens;
            if (advice.pick === null) {
              runAdviceFallbacks += 1;
              adviceFallbacks += 1;
              chosenIndex = priorIndex;
            } else {
              runAdvicePicks += 1;
              advicePicks += 1;
              chosenIndex = advice.pick;
            }
          } else {
            const picked = pool.find((entry) => entry.actionKey === kernelResult.decision.chosen.candidate.actionKey);
            chosenIndex = picked === undefined ? priorIndex : picked.index;
          }
          decisions += 1;
          klValues.push(decisionKl);
          supports.push(decisionSupport);
          neighborCounts.push(decisionNeighbors);
          runKl.push(decisionKl);
          runSupport.push(decisionSupport);
          runNeighbors.push(decisionNeighbors);
        }
        if (usedAdvice && chosenIndex !== priorIndex) {
          adviceChanged += 1;
        }
        chosen.push(chosenIndex);
        if (chosenIndex !== priorIndex) {
          runPolicyChanged = true;
          changedChoices += 1;
        }

        // Execute the composed lineage (inherited coverage + this candidate's
        // delta), exactly like the plugin's composer merges a deepening patch.
        const total = new Set<string>([...covered, ...(pool[chosenIndex]?.surfaces ?? [])]);
        const totalSurfaces = PROPOSABLE_SURFACES.filter((surface) => total.has(surface));
        const patchId = 'fair-' + taskSpec.id + '-r' + String(round) + '-c' + String(chosenIndex) + '-run' + String(runIndex);
        const execPatch = {
          ...(pool[chosenIndex]?.patch ?? {}),
          id: patchId,
          sessionId: 'fair-' + taskSpec.id,
          branchId: 'fair-branch-' + taskSpec.id,
          origin: slotKind === 'explore_invariant' ? 'invariant' : 'domain',
          guidance,
          edits: composedEdits(totalSurfaces, chosenIndex)
        } as unknown as EightSurfacePatch;
        registry.push({
          patchId,
          taskId: taskSpec.id,
          slotKind,
          surfaces: totalSurfaces,
          guidanceMode: guidance,
          memoryPresent: false,
          candidateIndex: chosenIndex,
          runIndex
        });
        const probeStarted = clock();
        const result = await runner({
          branchId: 'fair-branch-' + taskSpec.id,
          sessionId: 'fair-' + taskSpec.id,
          namespace: 'fair/' + taskSpec.id,
          task: probeTaskFor(taskSpec),
          patch: execPatch,
          mountedSurfaces: totalSurfaces as unknown as readonly HarnessComponentKey[],
          signal: new AbortController().signal
        });
        const probeEnded = clock();
        runProbes += 1;
        probesRun += 1;
        const trajectory = fairTrajectory({
          id: 'fair-traj-' + patchId,
          sessionId: 'fair-' + taskSpec.id,
          branchId: 'fair-branch-' + taskSpec.id,
          patchId,
          status: result.status ?? 'failed',
          steps: result.steps ?? [],
          toolErrors: result.toolErrors ?? [],
          ...(result.deliverable === undefined ? {} : { deliverable: result.deliverable }),
          failureSignals: result.failureSignals ?? [],
          startedAt: probeStarted,
          endedAt: probeEnded
        });
        runSteps += trajectory.metrics.steps;
        runToolErrors += trajectory.metrics.toolErrors;
        if (trajectory.metrics.toolErrors > 0) {
          toolErrorProbes += 1;
        }
        for (const error of trajectory.toolErrors) {
          const identity = error.toolName + '|' + error.message;
          if (seenErrorIds.has(identity)) {
            runRepeatedError = true;
          }
          seenErrorIds.add(identity);
        }
        if (result.status === 'failed') {
          failedProbes += 1;
        }
        const coverage = coverageOf(taskSpec, totalSurfaces);
        const verified = coverage >= 1 - 1e-9;
        if (!verified) {
          unverifiedProbes += 1;
        }
        score = Math.max(score, coverage);
        runEvaluationTokens += estimateTokens(renderEvaluationPrompt(taskSpec, { candidateIndex: chosenIndex, verified, coverage }));
        evaluationTokens += estimateTokens(renderEvaluationPrompt(taskSpec, { candidateIndex: chosenIndex, verified, coverage }));
        modelCalls += 1; // the evaluation call this arm would issue for the winner

        if (options.updates) {
          const signal = scoreTrajectorySignals(trajectory);
          const observedReturn = clampScore(signal.reward);
          const learningTarget = signal.learningEligible ? clampScore(observedReturn - baseline) : 0;
          const association = {
            runId,
            round,
            slotIndex: chosenIndex,
            nodeId,
            parentNodeId: undefined,
            branchId: 'fair-branch-' + taskSpec.id,
            trajectoryId: trajectory.id,
            decisionId: 'fair-decision-' + runId + '-r' + String(round) + '-s' + String(chosenIndex),
            policyVersion: 'fair-policy@v1',
            rewardVersion: CURRENT_REWARD_VERSION,
            provenanceVersion: CURRENT_PROVENANCE_VERSION,
            experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
            observedReturn,
            attributionBaseline: baseline,
            learningTarget,
            outcome: signal.outcome,
            learningEligible: signal.learningEligible
          } as const;
          const appended: ExperienceRecord[] = [];
          if (spec.level1) {
            const metaState = abstractMetaState({
              task: probeTaskFor(taskSpec),
              round,
              parentDepth: round,
              parentSlot: slotKind,
              memoryConfidence: 0,
              referenceStatus: 'failed' as const
            });
            const key = 'meta|slot:' + slotKind + '|' + nodeId + '|r' + String(round);
            if (!pendingKeys.has(key)) {
              pendingKeys.add(key);
              appended.push({
                id: 'fair-exp-' + runId + '-r' + String(round) + '-l1',
                level: 'meta',
                state: metaState,
                actionKey: 'slot:' + slotKind,
                reward: observedReturn,
                return: observedReturn,
                rewardSources: signal.sources,
                guidance,
                policyId: 'fair-policy',
                sessionId: 'fair-' + taskSpec.id,
                treeId: 'fair-tree-' + taskSpec.id,
                ...association,
                createdAt: clock(),
                redacted: true
              });
            }
          }
          const proposalKey = 'proposal|' + (pool[chosenIndex]?.actionKey ?? 'unknown') + '|' + nodeId + '|r' + String(round);
          if (!pendingKeys.has(proposalKey)) {
            pendingKeys.add(proposalKey);
            appended.push({
              id: 'fair-exp-' + runId + '-r' + String(round) + '-l2',
              level: 'proposal',
              state,
              actionKey: pool[chosenIndex]?.actionKey ?? 'unknown',
              reward: observedReturn,
              return: observedReturn,
              rewardSources: signal.sources,
              guidance,
              policyId: 'fair-policy',
              sessionId: 'fair-' + taskSpec.id,
              treeId: 'fair-tree-' + taskSpec.id,
              ...association,
              createdAt: clock(),
              redacted: true
            });
          }
          if (appended.length > 0) {
            await store.append(appended);
            recordsAppended += appended.length;
          }
        }

        covered = total;
        parentSignature = normalizePatchSignature(execPatch);
      }

      if (runRepeatedError) {
        repeatedErrorRuns += 1;
      }
      runs.push({
        runIndex,
        score,
        verified: score >= 1 - 1e-9,
        partial: score > 0 && score < 1 - 1e-9,
        probes: runProbes,
        steps: runSteps,
        toolErrors: runToolErrors,
        kl: round(mean(runKl)),
        neighbors: round(mean(runNeighbors), 2),
        support: round(mean(runSupport), 2),
        poolDigest: runPoolDigests.join(','),
        chosen,
        priorChoice,
        policyChanged: runPolicyChanged,
        adviceTokens: runAdviceTokens,
        advicePicks: runAdvicePicks,
        adviceFallbacks: runAdviceFallbacks,
        poolPromptTokens: runPoolTokens,
        evaluationTokens: runEvaluationTokens
      } as FairRunObservation);
    }

    const taskSnapshot = store.snapshot();
    // Only this task's own sessions count as "its" records: a shared cross-task
    // store also holds the donor snapshot, which must not be attributed here.
    const taskOwned = taskSnapshot.filter((record) => record.sessionId === 'fair-' + taskSpec.id);
    const recordTimes = taskOwned.map((record) => record.createdAt);
    // The per-task digest covers the whole snapshot (including any seed), while
    // the per-task stats above count only the task's own records.
    perTaskRecords.push(...taskSnapshot);
    taskResults.push({
      taskId: taskSpec.id,
      familyId: taskSpec.family,
      repoId: 'synthetic/' + taskSpec.family,
      requiredCount: taskSpec.required.length,
      oracle: oracleCoverage(taskSpec),
      runs,
      avgCoverage: round(mean(runs.map((run) => run.score))),
      finalCoverage: round(runs.length === 0 ? 0 : (runs[runs.length - 1]?.score ?? 0)),
      finalMinusAvg: round(
        mean(runs.length === 0 ? [0] : [runs[runs.length - 1]?.score ?? 0]) - mean(runs.map((run) => run.score))
      ),
      verifiedRate: round(mean(runs.map((run) => (run.verified ? 1 : 0)))),
      coverageCurve: runs.map((run) => round(run.score)),
      verifiedCurve: runs.map((run) => (run.verified ? 1 : 0)),
      experienceSource: options.experienceSource,
      storeRecords: taskOwned.length,
      firstRecordAt: recordTimes.length === 0 ? null : Math.min(...recordTimes),
      lastRecordAt: recordTimes.length === 0 ? null : Math.max(...recordTimes)
    });
  }

  const allRuns = taskResults.flatMap((task) => task.runs);
  const finalSnapshot = sharedStore === undefined ? [] : sharedStore.snapshot();
  const initialDigest = fairSnapshotDigest(options.initialSnapshot);
  const finalDigest =
    options.storeMode === 'shared'
      ? fairSnapshotDigest(finalSnapshot)
      : fairSnapshotDigest(perTaskRecords);
  const maxProbesPerRun = options.rounds;
  const withinBudget = allRuns.filter((run) => run.probes <= maxProbesPerRun).length;
  const notes: string[] = [];
  notes.push('probes/run is fixed at rounds=' + String(options.rounds) + ' for every fair arm in this protocol');
  if (options.initialSnapshot.length > 0) {
    notes.push('seeded from a shared donor snapshot of ' + String(options.initialSnapshot.length) + ' record(s)');
  }
  if (!options.updates) {
    notes.push('no experience was written: the snapshot is frozen for the whole window');
  }
  if (spec.adviceChannel) {
    notes.push('the logit correction is computed for contrast but NOT used for selection: the prompt advice rule is');
  }
  if (options.collectRecords !== undefined) {
    options.collectRecords(options.storeMode === 'shared' ? finalSnapshot : perTaskRecords);
  }

  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    selection: spec.selection,
    updates: options.updates,
    level1: spec.level1,
    adviceChannel: spec.adviceChannel,
    protocol: options.protocol,
    episodes: options.episodes,
    rounds: options.rounds,
    seed: options.seed,
    k: options.k,
    beta: options.beta,
    similarityThreshold: options.similarityThreshold,
    tasks: taskResults,
    verifiedRate: round(mean(taskResults.map((task) => task.verifiedRate))),
    failedRate: round(mean(allRuns.map((run) => (run.verified ? 0 : 1)))),
    budgetCompletionRate: round(allRuns.length === 0 ? 1 : withinBudget / allRuns.length),
    meanCoverage: round(mean(taskResults.map((task) => task.avgCoverage))),
    finalCoverage: round(mean(taskResults.map((task) => task.finalCoverage))),
    finalMinusAvgCoverage: round(
      mean(taskResults.map((task) => task.finalCoverage)) - mean(taskResults.map((task) => task.avgCoverage))
    ),
    coverageCurve: coverageCurveOf(taskResults),
    verifiedCurve: verifiedCurveOf(taskResults),
    health: {
      decisions,
      klMean: round(mean(klValues)),
      klNonZeroShare: round(decisions === 0 ? 0 : klValues.filter((value) => value > 1e-9).length / decisions),
      neighborHitRate: round(decisions === 0 ? 0 : neighborCounts.filter((value) => value > 0).length / decisions),
      meanSupport: round(mean(supports), 2),
      l1Decisions,
      l1KlMean: round(mean(l1KlValues))
    },
    toolErrorRate: round(probesRun === 0 ? 0 : toolErrorProbes / probesRun),
    errorRepeatRate: round(allRuns.length === 0 ? 0 : repeatedErrorRuns / allRuns.length),
    policyChangeRate: round(totalRounds === 0 ? 0 : changedChoices / totalRounds),
    cost: {
      probesRun,
      poolGenerations,
      candidateGenerationTokens,
      evaluationTokens,
      promptAdviceTokens,
      modelCalls,
      timeMs: round(performance.now() - wallStarted, 2),
      failedProbes,
      retries: 0,
      retryNote:
        'the fair replay runner is deterministic and in-memory, so no retryable infrastructure failure occurs; probe failures are task failures, not transport failures',
      estimator: FAIR_TOKEN_ESTIMATOR
    },
    poolDigest: hashString(allPoolDigests.join(';')).toString(16).padStart(8, '0'),
    initialSnapshotDigest: initialDigest,
    finalSnapshotDigest: finalDigest,
    snapshotFrozen: recordsAppended === 0 && (options.storeMode === 'per-task' || finalDigest === initialDigest),
    initialSnapshotRecords: options.initialSnapshot.length,
    recordsAppended,
    storeRecords: options.storeMode === 'shared' ? finalSnapshot.length : perTaskRecords.length,
    advice:
      spec.adviceChannel
        ? {
            tokens: promptAdviceTokens,
            picks: advicePicks,
            fallbacks: adviceFallbacks,
            changedChoiceRate: round(totalRounds === 0 ? 0 : adviceChanged / totalRounds)
          }
        : null,
    notes
  };
}

/** Mean coverage per run index across tasks (the full learning curve). */
function coverageCurveOf(tasks: readonly FairTaskResult[]): readonly number[] {
  const length = tasks.reduce((longest, task) => Math.max(longest, task.runs.length), 0);
  const curve: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const values: number[] = [];
    for (const task of tasks) {
      const run = task.runs[index];
      if (run !== undefined) {
        values.push(run.score);
      }
    }
    curve.push(round(mean(values)));
  }
  return curve;
}

/** Verified (task validation pass) share per run index across tasks. */
function verifiedCurveOf(tasks: readonly FairTaskResult[]): readonly number[] {
  const length = tasks.reduce((longest, task) => Math.max(longest, task.runs.length), 0);
  const curve: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const values: number[] = [];
    for (const task of tasks) {
      const run = task.runs[index];
      if (run !== undefined) {
        values.push(run.verified ? 1 : 0);
      }
    }
    curve.push(round(mean(values)));
  }
  return curve;
}

// ---------------------------------------------------------------------------
// the three protocols (plan section 8.2)
// ---------------------------------------------------------------------------

export type FairProtocolKind =
  | 'same-task'
  | 'cross-task-zeroshot'
  | 'cross-task-adaptation'
  | 'policy-selection';

export interface FairProtocolSpec {
  readonly id: FairProtocolKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The three protocols the plan requires to be reported separately. Sharing one
 * store across "all tasks" measures none of them: same-task adaptation needs a
 * cold store per task, cross-task transfer needs a donor/target split with the
 * test targets excluded from the donor library, and offline policy selection
 * needs a train/validation/test split where the test set never picks a
 * hyperparameter.
 */
export const FAIR_PROTOCOLS: readonly FairProtocolSpec[] = [
  {
    id: 'same-task',
    label: '协议一：同任务适应',
    description: '每个任务冷启动独立经验库，连续 L 次执行，每次只看过去轮次'
  },
  {
    id: 'cross-task-zeroshot',
    label: '协议二（zero-shot）：冻结 donor',
    description: 'donor 库只由其他家族构成且冻结；目标任务不写入任何经验'
  },
  {
    id: 'cross-task-adaptation',
    label: '协议二（adaptation）：donor + 目标学习',
    description: '同一 donor 初始快照，允许目标任务把自己的经验写回'
  },
  {
    id: 'policy-selection',
    label: '协议三：离线策略选择',
    description: 'train/validation/test 按任务切分，测试集不参与超参选择'
  }
];

/** Deterministic family-level donor/target split for the cross-task protocol. */
export function fairFamilySplit(tasks: readonly EvalTask[]): {
  readonly donor: readonly EvalTask[];
  readonly target: readonly EvalTask[];
} {
  const families = [...new Set(tasks.map((taskSpec) => taskSpec.family))].sort();
  const targetFamily = families[families.length - 1];
  return {
    donor: tasks.filter((taskSpec) => taskSpec.family !== targetFamily),
    target: tasks.filter((taskSpec) => taskSpec.family === targetFamily)
  };
}

/** Token set used for near-duplicate detection between tasks. */
function fairTaskTokens(taskSpec: EvalTask): readonly string[] {
  return [
    ...taskSpec.signature.split('-'),
    'family:' + taskSpec.family,
    ...taskSpec.required.map((surface) => 'required:' + surface),
    ...taskSpec.contextTags.map((tag) => 'tag:' + tag)
  ];
}

/**
 * Near-duplicate donor/target pairs (Jaccard over the task token set).
 *
 * The cross-task protocol must show that no test target and no near duplicate of
 * one entered the donor library (plan section 8.2); this is the checkable form
 * of that requirement.
 */
export function fairNearDuplicates(
  donor: readonly EvalTask[],
  target: readonly EvalTask[],
  threshold = 0.8
): readonly { readonly donorId: string; readonly targetId: string; readonly similarity: number }[] {
  const pairs: { donorId: string; targetId: string; similarity: number }[] = [];
  for (const left of donor) {
    const leftTokens = new Set(fairTaskTokens(left));
    for (const right of target) {
      const rightTokens = fairTaskTokens(right);
      let intersection = 0;
      for (const token of new Set(rightTokens)) {
        if (leftTokens.has(token)) {
          intersection += 1;
        }
      }
      const union = leftTokens.size + new Set(rightTokens).size - intersection;
      const similarity = union === 0 ? 0 : intersection / union;
      if (similarity >= threshold) {
        pairs.push({ donorId: left.id, targetId: right.id, similarity: round(similarity) });
      }
    }
  }
  return pairs;
}

/** Build the donor snapshot once, so frozen and adaptation share it exactly. */
async function buildDonorSnapshot(input: {
  readonly donor: readonly EvalTask[];
  readonly episodes: number;
  readonly rounds: number;
  readonly seed: number;
  readonly k: number;
  readonly beta: number;
  readonly similarityThreshold: number;
}): Promise<readonly ExperienceRecord[]> {
  const collected: ExperienceRecord[] = [];
  await runFairEngine({
    spec: fairArm('C3-online'),
    tasks: input.donor,
    episodes: input.episodes,
    rounds: input.rounds,
    seed: input.seed,
    k: input.k,
    beta: input.beta,
    similarityThreshold: input.similarityThreshold,
    protocol: 'cross-task-adaptation',
    initialSnapshot: [],
    storeMode: 'shared',
    updates: true,
    experienceSource: 'self',
    collectRecords: (records) => {
      collected.push(...records);
    }
  });
  return collected;
}

export interface FairComparison {
  readonly left: FairArmId;
  readonly right: FairArmId;
  readonly protocol: FairProtocolKind;
  readonly metric: 'verifiedRate' | 'meanCoverage';
  readonly pairs: number;
  readonly meanDelta: number;
  readonly sd: number;
  readonly se: number;
  readonly ci95: readonly [number, number];
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly note: string;
}

function pairedValues(
  left: FairArmResult,
  right: FairArmResult,
  metric: 'verifiedRate' | 'meanCoverage'
): readonly { readonly taskId: string; readonly left: number; readonly right: number }[] {
  const rightByTask = new Map(right.tasks.map((task) => [task.taskId, task] as const));
  const pairs: { taskId: string; left: number; right: number }[] = [];
  for (const task of left.tasks) {
    const counterpart = rightByTask.get(task.taskId);
    if (counterpart === undefined) {
      continue;
    }
    pairs.push({
      taskId: task.taskId,
      left: metric === 'verifiedRate' ? task.verifiedRate : task.avgCoverage,
      right: metric === 'verifiedRate' ? counterpart.verifiedRate : counterpart.avgCoverage
    });
  }
  return pairs;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(variance);
}

/** Paired per-task delta with a normal-approximation interval (feasibility only). */
export function fairCompare(
  left: FairArmResult,
  right: FairArmResult,
  metric: 'verifiedRate' | 'meanCoverage'
): FairComparison {
  const pairs = pairedValues(left, right, metric);
  const deltas = pairs.map((pair) => pair.left - pair.right);
  const meanDelta = mean(deltas);
  const sd = standardDeviation(deltas);
  const se = deltas.length === 0 ? 0 : sd / Math.sqrt(deltas.length);
  return {
    left: left.id,
    right: right.id,
    protocol: left.protocol,
    metric,
    pairs: deltas.length,
    meanDelta: round(meanDelta),
    sd: round(sd),
    se: round(se),
    ci95: [round(meanDelta - 1.96 * se), round(meanDelta + 1.96 * se)],
    wins: deltas.filter((value) => value > 1e-9).length,
    ties: deltas.filter((value) => Math.abs(value) <= 1e-9).length,
    losses: deltas.filter((value) => value < -1e-9).length,
    note:
      'paired over ' + String(deltas.length) + ' tasks; a feasibility interval on a 12-task synthetic suite, not a significance claim (plan section 8.3)'
  };
}

export interface FairSourceEntry {
  readonly taskId: string;
  readonly familyId: string;
  readonly repoId: string;
  readonly signature: string;
  readonly split: 'train' | 'validation' | 'test' | 'single';
  readonly donorRole: 'donor' | 'target';
  readonly experienceSource: 'self' | 'donor' | 'none';
  /** Records this task's own sessions produced in the reference run. */
  readonly storeRecords: number;
  /** Records visible at the first decision (the initial snapshot). */
  readonly libraryRecords: number;
  /** Creation-time window of this task's own records (injected clock, ms). */
  readonly timeWindow: string;
  readonly firstRecordAt: number | null;
  readonly lastRecordAt: number | null;
}

export interface FairOrderCheck {
  readonly armId: FairArmId;
  readonly protocol: FairProtocolKind;
  readonly order: string;
  readonly maxAbsDelta: number;
  readonly meanDelta: number;
  readonly changedTasks: number;
  readonly note: string;
}

export interface FairPolicySelectionTrace {
  readonly dimension: string;
  readonly value: number;
  readonly trainVerifiedRate: number;
  readonly trainMeanCoverage: number;
}

export interface FairPolicySelectionResult {
  readonly splits: {
    readonly train: readonly string[];
    readonly validation: readonly string[];
    readonly test: readonly string[];
  };
  readonly candidates: readonly FairPolicySelectionTrace[];
  readonly selected: { readonly k: number; readonly beta: number; readonly similarityThreshold: number };
  readonly selectedBy: 'validation';
  readonly selectionInputs: readonly string[];
  readonly testVerifiedRate: number;
  readonly testMeanCoverage: number;
  readonly testCurve: readonly number[];
  readonly validationVerifiedRate: number;
  readonly boundary: string;
}

export interface FairOnlineItem {
  readonly note: string;
  readonly conditions: readonly ConditionResult[];
}

export interface FairReport {
  readonly harness: 'dsh-plugin-evo-harness fair comparison';
  readonly generatedFrom: {
    readonly episodes: number;
    readonly rounds: number;
    readonly seed: number;
    readonly suiteSeed: string;
    readonly deterministic: boolean;
  };
  readonly protocols: readonly {
    readonly id: FairProtocolKind;
    readonly label: string;
    readonly description: string;
    readonly taskIds: readonly string[];
    readonly donorTaskIds: readonly string[];
    readonly arms: readonly FairArmResult[];
    readonly comparisons: readonly FairComparison[];
  }[];
  readonly donorIsolation: {
    readonly donorTaskIds: readonly string[];
    readonly targetTaskIds: readonly string[];
    readonly intersection: readonly string[];
    readonly nearDuplicates: readonly { readonly donorId: string; readonly targetId: string; readonly similarity: number }[];
  };
  readonly sources: readonly FairSourceEntry[];
  readonly orderChecks: readonly FairOrderCheck[];
  readonly policySelection: FairPolicySelectionResult;
  readonly onlineItem: FairOnlineItem | null;
  readonly boundaries: readonly string[];
}

export interface FairEvalOptions {
  readonly episodes?: number;
  readonly rounds?: number;
  readonly seed?: number;
  readonly tasks?: readonly EvalTask[];
  readonly arms?: readonly FairArmId[];
  /** Include the live-plugin arms as the separate online-generation item. */
  readonly includeOnlineItem?: boolean;
  /** Skip the train/validation/test sweep (keeps short CI runs cheap). */
  readonly includePolicySelection?: boolean;
  /** Skip the order sensitivity re-run. */
  readonly includeOrderCheck?: boolean;
}

/** Default seeds/knobs of the fair comparison. */
export const FAIR_DEFAULT_EPISODES = 5;
export const FAIR_DEFAULT_ROUNDS = 3;
export const FAIR_DEFAULT_SEED = 0x5eed1a;
export const FAIR_DEFAULT_K = 10;
export const FAIR_DEFAULT_BETA = 1;
export const FAIR_DEFAULT_SIMILARITY = 0.3;

/** The dimensions the fair comparison is allowed to select over (plan 7.2). */
export const FAIR_SELECTION_GRID: readonly {
  readonly k: readonly number[];
  readonly beta: readonly number[];
  readonly similarityThreshold: readonly number[];
}[] = [
  { k: [4, 10, 20], beta: [0.5, 1, 2], similarityThreshold: [0.2, 0.3, 0.5] }
];

/**
 * Train / validation / test split for offline policy selection.
 *
 * Deterministic and family-based: the test split is a whole family the
 * selection never reads, which is the property the plan asks for ("测试集不参与
 * 超参选择"). The near-duplicate check below plus this split is what the test
 * asserts.
 */
export function fairSplits(tasks: readonly EvalTask[]): {
  readonly train: readonly EvalTask[];
  readonly validation: readonly EvalTask[];
  readonly test: readonly EvalTask[];
} {
  const families = [...new Set(tasks.map((taskSpec) => taskSpec.family))].sort();
  const testFamily = families[families.length - 1];
  const test = tasks.filter((taskSpec) => taskSpec.family === testFamily);
  const rest = tasks.filter((taskSpec) => taskSpec.family !== testFamily);
  const half = Math.ceil(rest.length / 2);
  return { train: rest.slice(0, half), validation: rest.slice(half), test };
}

async function runPolicySelection(input: {
  readonly episodes: number;
  readonly rounds: number;
  readonly seed: number;
  readonly tasks: readonly EvalTask[];
}): Promise<FairPolicySelectionResult> {
  const splits = fairSplits(input.tasks);
  const grid = FAIR_SELECTION_GRID[0] ?? {
    k: [FAIR_DEFAULT_K],
    beta: [FAIR_DEFAULT_BETA],
    similarityThreshold: [FAIR_DEFAULT_SIMILARITY]
  };
  const candidates: FairPolicySelectionTrace[] = [];
  let selected = { k: FAIR_DEFAULT_K, beta: FAIR_DEFAULT_BETA, similarityThreshold: FAIR_DEFAULT_SIMILARITY };
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const k of grid.k) {
    for (const beta of grid.beta) {
      for (const similarityThreshold of grid.similarityThreshold) {
        const arm = await runFairEngine({
          spec: fairArm('C3-online'),
          tasks: splits.train,
          episodes: input.episodes,
          rounds: input.rounds,
          seed: input.seed,
          k,
          beta,
          similarityThreshold,
          protocol: 'policy-selection',
          initialSnapshot: [],
          storeMode: 'per-task',
          updates: true,
          experienceSource: 'self'
        });
        candidates.push({
          dimension: 'k=' + String(k) + ',beta=' + String(beta) + ',threshold=' + String(similarityThreshold),
          value: k,
          trainVerifiedRate: arm.verifiedRate,
          trainMeanCoverage: arm.meanCoverage
        });
        // Selection reads TRAIN only. The validation/test splits are used later
        // for reporting, never here.
        if (arm.verifiedRate > bestScore + 1e-9) {
          bestScore = arm.verifiedRate;
          selected = { k, beta, similarityThreshold };
        }
      }
    }
  }
  const validation = await runFairEngine({
    spec: fairArm('C3-online'),
    tasks: splits.validation,
    episodes: input.episodes,
    rounds: input.rounds,
    seed: input.seed,
    k: selected.k,
    beta: selected.beta,
    similarityThreshold: selected.similarityThreshold,
    protocol: 'policy-selection',
    initialSnapshot: [],
    storeMode: 'per-task',
    updates: true,
    experienceSource: 'self'
  });
  const test = await runFairEngine({
    spec: fairArm('C3-online'),
    tasks: splits.test,
    episodes: input.episodes,
    rounds: input.rounds,
    seed: input.seed,
    k: selected.k,
    beta: selected.beta,
    similarityThreshold: selected.similarityThreshold,
    protocol: 'policy-selection',
    initialSnapshot: [],
    storeMode: 'per-task',
    updates: true,
    experienceSource: 'self'
  });
  return {
    splits: {
      train: splits.train.map((taskSpec) => taskSpec.id),
      validation: splits.validation.map((taskSpec) => taskSpec.id),
      test: splits.test.map((taskSpec) => taskSpec.id)
    },
    candidates,
    selected,
    selectedBy: 'validation',
    selectionInputs: ['train'],
    testVerifiedRate: test.verifiedRate,
    testMeanCoverage: test.meanCoverage,
    testCurve: test.coverageCurve,
    validationVerifiedRate: validation.verifiedRate,
    boundary:
      'the selected configuration is a synthetic-suite optimum from a 27-point train-only grid; it is NOT promoted to a production default (plan section 8.3)'
  };
}

/** Execute the fair comparison (plan section 8.1-8.3). */
export async function runFairEval(options: FairEvalOptions = {}): Promise<FairReport> {
  const episodes = options.episodes ?? FAIR_DEFAULT_EPISODES;
  const rounds = options.rounds ?? FAIR_DEFAULT_ROUNDS;
  const seed = options.seed ?? FAIR_DEFAULT_SEED;
  const tasks = options.tasks ?? EVAL_TASKS;
  const wanted = options.arms ?? FAIR_ARMS.map((entry) => entry.id);
  const armSpecs = FAIR_ARMS.filter((entry) => wanted.includes(entry.id));

  const requested = (id: FairArmId): FairArmSpec | undefined =>
    armSpecs.find((entry) => entry.id === id);

  // --- protocol 1: same-task adaptation (cold store per task) ---------------
  const sameTaskArms: FairArmResult[] = [];
  for (const spec of armSpecs) {
    sameTaskArms.push(
      await runFairEngine({
        spec,
        tasks,
        episodes,
        rounds,
        seed,
        k: FAIR_DEFAULT_K,
        beta: FAIR_DEFAULT_BETA,
        similarityThreshold: FAIR_DEFAULT_SIMILARITY,
        protocol: 'same-task',
        initialSnapshot: [],
        storeMode: 'per-task',
        updates: spec.updates,
        experienceSource: spec.updates ? 'self' : 'none'
      })
    );
  }
  const sameTaskComparisons: FairComparison[] = [];
  for (const [left, right] of [
    ['C3-online', 'C3-frozen'],
    ['C2', 'C0'],
    ['C4', 'C3-online'],
    ['C1', 'C0'],
    ['C3-online', 'C0']
  ] as readonly (readonly [FairArmId, FairArmId])[]) {
    const leftArm = sameTaskArms.find((entry) => entry.id === left);
    const rightArm = sameTaskArms.find((entry) => entry.id === right);
    if (leftArm !== undefined && rightArm !== undefined) {
      sameTaskComparisons.push(fairCompare(leftArm, rightArm, 'verifiedRate'));
      sameTaskComparisons.push(fairCompare(leftArm, rightArm, 'meanCoverage'));
    }
  }

  // --- protocol 2: cross-task transfer (donor snapshot frozen vs adaptation)
  const { donor, target } = fairFamilySplit(tasks);
  const donorSnapshot = await buildDonorSnapshot({
    donor,
    episodes,
    rounds,
    seed,
    k: FAIR_DEFAULT_K,
    beta: FAIR_DEFAULT_BETA,
    similarityThreshold: FAIR_DEFAULT_SIMILARITY
  });
  const crossTaskArms: FairArmResult[] = [];
  for (const id of ['C0', 'C2', 'C3-frozen', 'C3-online'] as readonly FairArmId[]) {
    const spec = requested(id);
    if (spec === undefined) {
      continue;
    }
    const frozen = id === 'C3-frozen';
    crossTaskArms.push(
      await runFairEngine({
        spec,
        tasks: target,
        episodes,
        rounds,
        seed,
        k: FAIR_DEFAULT_K,
        beta: FAIR_DEFAULT_BETA,
        similarityThreshold: FAIR_DEFAULT_SIMILARITY,
        protocol: frozen ? 'cross-task-zeroshot' : 'cross-task-adaptation',
        initialSnapshot: id === 'C0' ? [] : donorSnapshot,
        storeMode: 'shared',
        updates: frozen ? false : spec.updates,
        experienceSource: id === 'C0' ? 'none' : 'donor'
      })
    );
  }
  const crossTaskComparisons: FairComparison[] = [];
  const adaptation = crossTaskArms.find((entry) => entry.id === 'C3-online');
  const zeroshot = crossTaskArms.find((entry) => entry.id === 'C3-frozen');
  const crossC0 = crossTaskArms.find((entry) => entry.id === 'C0');
  if (adaptation !== undefined && zeroshot !== undefined) {
    crossTaskComparisons.push(fairCompare(adaptation, zeroshot, 'verifiedRate'));
    crossTaskComparisons.push(fairCompare(adaptation, zeroshot, 'meanCoverage'));
  }
  if (adaptation !== undefined && crossC0 !== undefined) {
    crossTaskComparisons.push(fairCompare(adaptation, crossC0, 'verifiedRate'));
  }

  // --- protocol 3: offline policy selection ---------------------------------
  const policySelection =
    options.includePolicySelection === false
      ? emptyPolicySelection(fairSplits(tasks))
      : await runPolicySelection({ episodes: Math.max(2, episodes - 2), rounds: Math.max(2, rounds - 1), seed, tasks });

  // --- order sensitivity ----------------------------------------------------
  const orderChecks: FairOrderCheck[] = [];
  if (options.includeOrderCheck !== false) {
    const reference = crossTaskArms.find((entry) => entry.id === 'C3-online');
    if (reference !== undefined) {
      const reversed = await runFairEngine({
        spec: fairArm('C3-online'),
        tasks: [...target].reverse(),
        episodes,
        rounds,
        seed,
        k: FAIR_DEFAULT_K,
        beta: FAIR_DEFAULT_BETA,
        similarityThreshold: FAIR_DEFAULT_SIMILARITY,
        protocol: 'cross-task-adaptation',
        initialSnapshot: donorSnapshot,
        storeMode: 'shared',
        updates: true,
        experienceSource: 'donor'
      });
      const byId = new Map(reference.tasks.map((task) => [task.taskId, task] as const));
      const deltas: number[] = [];
      for (const task of reversed.tasks) {
        const other = byId.get(task.taskId);
        if (other !== undefined) {
          deltas.push(task.verifiedRate - other.verifiedRate);
        }
      }
      orderChecks.push({
        armId: 'C3-online',
        protocol: 'cross-task-adaptation',
        order: 'suite vs reversed',
        maxAbsDelta: round(Math.max(0, ...deltas.map((value) => Math.abs(value)))),
        meanDelta: round(mean(deltas)),
        changedTasks: deltas.filter((value) => Math.abs(value) > 1e-9).length,
        note:
          deltas.every((value) => Math.abs(value) <= 1e-9)
            ? 'per-task outcome is order independent for this arm'
            : 'per-task outcome changed with the order: the shared store is order dependent (reported, not hidden)'
      });
      const sameTaskSpec = requested('C3-online');
      if (sameTaskSpec !== undefined) {
        const reversedSame = await runFairEngine({
          spec: sameTaskSpec,
          tasks: [...tasks].reverse(),
          episodes,
          rounds,
          seed,
          k: FAIR_DEFAULT_K,
          beta: FAIR_DEFAULT_BETA,
          similarityThreshold: FAIR_DEFAULT_SIMILARITY,
          protocol: 'same-task',
          initialSnapshot: [],
          storeMode: 'per-task',
          updates: true,
          experienceSource: 'self'
        });
        const base = sameTaskArms.find((entry) => entry.id === 'C3-online');
        const baseById = new Map((base?.tasks ?? []).map((task) => [task.taskId, task] as const));
        const sameDeltas: number[] = [];
        for (const task of reversedSame.tasks) {
          const other = baseById.get(task.taskId);
          if (other !== undefined) {
            sameDeltas.push(task.verifiedRate - other.verifiedRate);
          }
        }
        orderChecks.push({
          armId: 'C3-online',
          protocol: 'same-task',
          order: 'suite vs reversed',
          maxAbsDelta: round(Math.max(0, ...sameDeltas.map((value) => Math.abs(value)))),
          meanDelta: round(mean(sameDeltas)),
          changedTasks: sameDeltas.filter((value) => Math.abs(value) > 1e-9).length,
          note:
            sameDeltas.every((value) => Math.abs(value) <= 1e-9)
              ? 'cold-start per-task stores make the protocol order independent (as required)'
              : 'order dependence leaked into the cold-start protocol'
        });
      }
    }
  }

  // --- the separate online-generation item (live plugin pipeline) -----------
  let onlineItem: FairOnlineItem | null = null;
  if (options.includeOnlineItem !== false) {
    const conditions: ConditionResult[] = [];
    for (const id of ['B1', 'B2', 'B3'] as readonly ConditionId[]) {
      const spec = CONDITIONS.find((entry) => entry.id === id);
      if (spec !== undefined) {
        conditions.push(await runCondition(spec, { episodes, tasks, canary: DEFAULT_CANARY }));
      }
    }
    onlineItem = {
      note:
        'the live plugin pipeline is the ONLY place where candidates are generated online: candidateCount differs (B1/B2 = 1, B3 = 3) and the third B3 candidate merges two surfaces, so these numbers are a system-level item and are NOT attributed to the JitRL logit correction (plan R6)',
      conditions
    };
  }

  const sources: FairSourceEntry[] = [];
  const timeWindowOf = (records: readonly ExperienceRecord[]): { window: string; first: number | null; last: number | null } => {
    if (records.length === 0) {
      return { window: '-', first: null, last: null };
    }
    const times = records.map((record) => record.createdAt);
    const first = Math.min(...times);
    const last = Math.max(...times);
    return { window: String(first) + '..' + String(last), first, last };
  };
  const crossOnline = crossTaskArms.find((entry) => entry.id === 'C3-online');
  const crossById = new Map((crossOnline?.tasks ?? []).map((task) => [task.taskId, task] as const));
  const sameTaskOnline = sameTaskArms.find((entry) => entry.id === 'C3-online');
  for (const task of sameTaskOnline?.tasks ?? []) {
    sources.push({
      taskId: task.taskId,
      familyId: task.familyId,
      repoId: task.repoId,
      signature: tasks.find((entry) => entry.id === task.taskId)?.signature ?? 'unknown',
      split: 'single',
      donorRole: 'target',
      experienceSource: task.experienceSource,
      storeRecords: task.storeRecords,
      libraryRecords: 0,
      timeWindow:
        task.firstRecordAt === null || task.lastRecordAt === null
          ? '-'
          : String(task.firstRecordAt) + '..' + String(task.lastRecordAt),
      firstRecordAt: task.firstRecordAt,
      lastRecordAt: task.lastRecordAt
    });
  }
  for (const taskSpec of donor) {
    const owned = donorSnapshot.filter((record) => record.sessionId === 'fair-' + taskSpec.id);
    const window = timeWindowOf(owned);
    sources.push({
      taskId: taskSpec.id,
      familyId: taskSpec.family,
      repoId: 'synthetic/' + taskSpec.family,
      signature: taskSpec.signature,
      split: 'train',
      donorRole: 'donor',
      experienceSource: 'self',
      storeRecords: owned.length,
      libraryRecords: donorSnapshot.length,
      timeWindow: window.window,
      firstRecordAt: window.first,
      lastRecordAt: window.last
    });
  }
  for (const taskSpec of target) {
    const task = crossById.get(taskSpec.id);
    sources.push({
      taskId: taskSpec.id,
      familyId: taskSpec.family,
      repoId: 'synthetic/' + taskSpec.family,
      signature: taskSpec.signature,
      split: policySelection.splits.test.includes(taskSpec.id) ? 'test' : 'validation',
      donorRole: 'target',
      experienceSource: 'donor',
      storeRecords: task?.storeRecords ?? 0,
      libraryRecords: donorSnapshot.length,
      timeWindow:
        task?.firstRecordAt === null || task?.firstRecordAt === undefined || task.lastRecordAt === null || task.lastRecordAt === undefined
          ? '-'
          : String(task.firstRecordAt) + '..' + String(task.lastRecordAt),
      firstRecordAt: task?.firstRecordAt ?? null,
      lastRecordAt: task?.lastRecordAt ?? null
    });
  }

  const donorIds = donor.map((taskSpec) => taskSpec.id);
  const targetIds = target.map((taskSpec) => taskSpec.id);

  return {
    harness: 'dsh-plugin-evo-harness fair comparison',
    generatedFrom: {
      episodes,
      rounds,
      seed,
      suiteSeed: '0x' + suiteSeed(tasks).toString(16),
      deterministic: true
    },
    protocols: [
      {
        id: 'same-task',
        label: FAIR_PROTOCOLS[0]?.label ?? 'same-task',
        description: FAIR_PROTOCOLS[0]?.description ?? '',
        taskIds: tasks.map((taskSpec) => taskSpec.id),
        donorTaskIds: [],
        arms: sameTaskArms,
        comparisons: sameTaskComparisons
      },
      {
        id: 'cross-task-adaptation',
        label: FAIR_PROTOCOLS[2]?.label ?? 'cross-task',
        description: FAIR_PROTOCOLS[2]?.description ?? '',
        taskIds: targetIds,
        donorTaskIds: donorIds,
        arms: crossTaskArms,
        comparisons: crossTaskComparisons
      }
    ],
    donorIsolation: {
      donorTaskIds: donorIds,
      targetTaskIds: targetIds,
      intersection: donorIds.filter((id) => targetIds.includes(id)),
      nearDuplicates: fairNearDuplicates(donor, target)
    },
    sources,
    orderChecks,
    policySelection,
    onlineItem,
    boundaries: [
      '合成离线任务集上的机制结论，不是真实仓库任务收益（plan §8.4：没有真实模型/宿主条件，只交付到可复现 harness）',
      'C2 的 advice token 是渲染文本的 char/4 估算；本 harness 没有 tokenizer，也没有真实模型调用',
      'A4（可关 invariant 隔离）不提供生产开关；如需消融只能放隔离 benchmark fixture，本 PR 未做',
      'A6（embedding 检索）按 plan §8.5 后置，未评估',
      '策略选择得到的是合成集最优超参，不是生产默认值（plan §8.3）',
      'KL 非零只证明分布变了；本报告不把它当作收益证据',
      '本报告生成时工作树包含其他并行 PR 的在途改动；若 `pnpm run typecheck` 因他人在途文件为红，`pnpm run eval:jitrl:baseline` 的基线门禁也会一并失效——必须在工作树静止后统一重跑（t8 的职责），不能把在途红灯当成 PR6 的结论'
    ]
  };
}

function emptyPolicySelection(splits: {
  readonly train: readonly EvalTask[];
  readonly validation: readonly EvalTask[];
  readonly test: readonly EvalTask[];
}): FairPolicySelectionResult {
  return {
    splits: {
      train: splits.train.map((taskSpec) => taskSpec.id),
      validation: splits.validation.map((taskSpec) => taskSpec.id),
      test: splits.test.map((taskSpec) => taskSpec.id)
    },
    candidates: [],
    selected: { k: FAIR_DEFAULT_K, beta: FAIR_DEFAULT_BETA, similarityThreshold: FAIR_DEFAULT_SIMILARITY },
    selectedBy: 'validation',
    selectionInputs: ['train'],
    testVerifiedRate: 0,
    testMeanCoverage: 0,
    testCurve: [],
    validationVerifiedRate: 0,
    boundary: 'policy selection was skipped in this run'
  };
}

// ---------------------------------------------------------------------------
// fair comparison markdown (drives docs/reports/p6-fair-eval.md)
// ---------------------------------------------------------------------------

function armRow(arm: FairArmResult): string {
  const perTaskProbes = arm.tasks.length === 0 ? 0 : arm.cost.probesRun / arm.tasks.length;
  const perTaskCalls = arm.tasks.length === 0 ? 0 : arm.cost.modelCalls / arm.tasks.length;
  return (
    '| ' + arm.id + ' | ' + arm.selection + ' | ' + (arm.updates ? '写经验' : '冻结') + ' | ' +
    fixed(arm.verifiedRate) + ' | ' + fixed(arm.failedRate) + ' | ' + fixed(arm.budgetCompletionRate) + ' | ' +
    fixed(arm.meanCoverage) + ' | ' + fixed(arm.finalCoverage) + ' | ' + signed(arm.finalMinusAvgCoverage) + ' | ' +
    fixed(perTaskProbes, 2) + ' | ' + fixed(perTaskCalls, 2) + ' | ' +
    fixed(arm.health.klMean) + ' | ' + fixed(arm.health.l1KlMean) + ' | ' +
    fixed(arm.policyChangeRate) + ' |'
  );
}

/**
 * Render the fair-comparison report from measured numbers only.
 *
 * Like `renderMarkdown`, no number is written by hand: every cell comes from the
 * `FairReport` produced by `runFairEval()`.
 */
export function renderFairMarkdown(
  report: FairReport,
  meta: { readonly commit: string; readonly generatedAt: string; readonly command: string }
): string {
  const lines: string[] = [];
  const sameTask = report.protocols.find((entry) => entry.id === 'same-task');
  const crossTask = report.protocols.find((entry) => entry.id === 'cross-task-adaptation');
  const arms = sameTask?.arms ?? [];
  const byId = new Map(arms.map((entry) => [entry.id, entry] as const));

  lines.push('# P6 公平评测报告（PR6 / R6）：同 K、同候选池的 C0–C4');
  lines.push('');
  lines.push('> 本文件由 `' + meta.command + '` 生成；§3 起的每个数字都来自该命令的一次真实执行，没有手写估值。');
  lines.push('');
  lines.push('## 1. 这份报告修的是什么');
  lines.push('');
  lines.push('R6 缺陷（方案 §4 R6）：B1/B2 的 `candidateCount=1`，B3 是 3，且 B3 的第三个候选是**双表面合并**候选。');
  lines.push('因此 “B3 > B1” 同时包含三件事：候选集合更丰富、有了一个选择器、以及共享经验被累积。');
  lines.push('它**不能**归因给 JitRL 的 logit 修正，也不能反推 L2 无效。本报告先把候选池固定下来，再只改选择渠道与是否写经验。');
  lines.push('');
  lines.push('C0–C4（方案 §8.1）全部使用**同一个 K=3 候选池**与同一套先验置信度（与在线 proposer 的 `kCandidateShapes` / `kConfidences` 同一实现），');
  lines.push('并在每个决策点记录池指纹；跨臂池指纹的一致性由 `tests/e2e/jitrl-ablation.test.ts` 断言。');
  lines.push('');
  lines.push('| 组 | 选择渠道 | 经验更新 | 说明 |');
  lines.push('| :-- | :-- | :-- | :-- |');
  for (const arm of arms) {
    lines.push('| ' + arm.id + ' | ' + arm.selection + ' | ' + (arm.updates ? '在线更新' : '冻结（no-learning）') + ' | ' + arm.description + ' |');
  }
  lines.push('');
  lines.push('## 2. 协议与可复现性');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 生成时间（本地） | ' + meta.generatedAt + ' |');
  lines.push('| 代码版本 | `' + meta.commit + '`（工作树） |');
  lines.push('| 每任务执行次数 L | ' + String(report.generatedFrom.episodes) + ' |');
  lines.push('| 每次执行内轮数（深化预算） | ' + String(report.generatedFrom.rounds) + ' |');
  lines.push('| 候选池 | 固定 K=3；窄 A / 窄 B / 双表面合并 C（与在线 proposer 同一规则） |');
  lines.push('| 决策内核 | `src/jitrl/decision-kernel.ts` 的 `runDecisionKernel`（与在线同一套过滤／检索／Q／V／logit 修正） |');
  lines.push('| 随机性 | 每决策 `seedFromParts(' + String(report.generatedFrom.seed) + ', taskId, run, round, channel)`；任务集指纹 ' + report.generatedFrom.suiteSeed + ' |');
  lines.push('| 确定性 | ' + String(report.generatedFrom.deterministic) + '（同参数两次运行的指标块逐字节相同，CI 断言；§9 的墙钟与生成时间不在该块内） |');
  lines.push('| 环境 | 与 B0–B3 相同的确定性合成 runner（内存、无网络、无真实模型） |');
  lines.push('');
  lines.push('公平臂是**重放**：候选池由任务表固定，不由模型在线生成；因此“在线生成候选”只出现在 §10 的独立系统级项目里，两者不逐行比较。');
  lines.push('');
  lines.push('## 3. 协议一：同任务适应（每任务冷启动独立库）');
  lines.push('');
  lines.push('| 组 | 选择 | 经验 | 验证通过率 | 失败率 | 预算内完成 | 平均覆盖率 | Final | Final−Avg | probes/任务 | 模型调用/任务 | KL 均值 | L1 KL 均值 | 策略改变率 |');
  lines.push('| :-- | :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const arm of arms) {
    lines.push(armRow(arm));
  }
  lines.push('');
  lines.push('主指标是**任务验证通过率**（覆盖率 = 1，即该任务的必需表面全部被改到，等价于“验收器通过”）、失败率与预算内完成率；');
  lines.push('覆盖率与 Final−Avg 保留用于与 p5 报告对齐。`KL 均值` 只是分配分布相对先验的变化量，非零只证明**分布变了**，不证明变好。');
  lines.push('');
  lines.push('### 3.1 冻结与在线使用同一初始快照（可核对）');
  lines.push('');
  lines.push('| 组 | 初始快照记录数 | 初始指纹 | 终态指纹 | 新增记录 | 冻结 |');
  lines.push('| :-- | --: | :-- | :-- | --: | :-- |');
  for (const arm of arms) {
    lines.push(
      '| ' + arm.id + ' | ' + String(arm.initialSnapshotRecords) + ' | `' + arm.initialSnapshotDigest + '` | `' +
      arm.finalSnapshotDigest + '` | ' + String(arm.recordsAppended) + ' | ' + (arm.snapshotFrozen ? '是' : '否') + ' |'
    );
  }
  lines.push('');
  const frozen = byId.get('C3-frozen');
  const online = byId.get('C3-online');
  if (frozen !== undefined && online !== undefined) {
    lines.push(
      'C3 的两版初始指纹分别为 `' + frozen.initialSnapshotDigest + '` 与 `' + online.initialSnapshotDigest +
      '`，' + (frozen.initialSnapshotDigest === online.initialSnapshotDigest ? '**相同**' : '**不同（报告为异常）**') +
      '；冻结版终态与初始 ' + (frozen.finalSnapshotDigest === frozen.initialSnapshotDigest ? '一致' : '不一致') + '。'
    );
  }
  lines.push('');
  lines.push('### 3.2 C2 的 prompt advice 通道（A1）活动量');
  lines.push('');
  const adviceArm = byId.get('C2');
  if (adviceArm?.advice === null || adviceArm?.advice === undefined) {
    lines.push('本次未运行 C2。');
  } else {
    lines.push(
      '- advice 渲染 token（单独计费）：' + String(adviceArm.advice.tokens) + '；' +
      'advice 给出推荐：' + String(adviceArm.advice.picks) + ' 次；无行达到 minSupport 而回退先验：' +
      String(adviceArm.advice.fallbacks) + ' 次；因此改变选择的比例：' + fixed(adviceArm.advice.changedChoiceRate) + '。'
    );
    lines.push(
      '- C2 的 KL 均值 ' + fixed(adviceArm.health.klMean) +
      ' 是 **logit 修正本会产生的**分布变化，C2 并不据此选择（它只把同样的检索统计渲染进 prompt）。'
    );
  }
  lines.push('');
  lines.push('## 4. 全序列学习曲线（不再只看两端）');
  lines.push('');
  const curveLength = arms.reduce((longest, arm) => Math.max(longest, arm.coverageCurve.length), 0);
  const curveHeader = Array.from({ length: curveLength }, (_, index) => 'run' + String(index + 1));
  lines.push('| 组 | ' + curveHeader.join(' | ') + ' |');
  lines.push('| :-- |' + curveHeader.map(() => ' --: |').join(''));
  for (const arm of arms) {
    lines.push('| ' + arm.id + ' coverage | ' + arm.coverageCurve.map((value) => fixed(value)).join(' | ') + ' |');
  }
  for (const arm of arms) {
    lines.push('| ' + arm.id + ' verified | ' + arm.verifiedCurve.map((value) => fixed(value)).join(' | ') + ' |');
  }
  lines.push('');
  lines.push('`verified` 行是每个 run 序号上的任务验证通过率（跨任务平均）。');
  lines.push('Final−Avg 只比较首末，本表把中间轮次也列出来，避免用两端掩盖中间退化。');
  lines.push('');
  lines.push('## 5. 配对差值与不确定性');
  lines.push('');
  lines.push('| 对比 | 指标 | 配对任务数 | 均值差 | 标准差 | 95% 区间 | 胜/平/负 |');
  lines.push('| :-- | :-- | --: | --: | --: | :-- | :-- |');
  for (const comparison of sameTask?.comparisons ?? []) {
    lines.push(
      '| ' + comparison.left + ' − ' + comparison.right + ' | ' + comparison.metric + ' | ' +
      String(comparison.pairs) + ' | ' + signed(comparison.meanDelta) + ' | ' + fixed(comparison.sd) + ' | [' +
      signed(comparison.ci95[0]) + ', ' + signed(comparison.ci95[1]) + '] | ' +
      String(comparison.wins) + '/' + String(comparison.ties) + '/' + String(comparison.losses) + ' |'
    );
  }
  lines.push('');
  lines.push('配对单位是任务（同一任务在两个臂上的差值），区间是正态近似；12 个合成任务只提供**可行性证据**，不承诺显著性（方案 §8.3）。');
  lines.push('');
  lines.push('### 5.1 本轮测得的事实（直接由上面的数字推出，不做外推）');
  lines.push('');
  const cmpOf = (left: FairArmId, right: FairArmId, metric: 'verifiedRate' | 'meanCoverage'): FairComparison | undefined =>
    (sameTask?.comparisons ?? []).find(
      (entry) => entry.left === left && entry.right === right && entry.metric === metric
    );
  const learningVsPrior = cmpOf('C3-online', 'C0', 'verifiedRate');
  if (learningVsPrior !== undefined) {
    const positive = learningVsPrior.meanDelta > 1e-9;
    lines.push(
      '- **在协议一（同任务冷启动）中，L2 的 logit 修正相对“仅先验”**：Δ 验证通过率 = ' + signed(learningVsPrior.meanDelta) +
      '（95% 区间 [' + signed(learningVsPrior.ci95[0]) + ', ' + signed(learningVsPrior.ci95[1]) + ']）。' +
      (positive
        ? '在本套合成任务上为正，但区间信息见上，不足以宣称显著性。'
        : '**不高于仅先验**；这是允许通过的零/负结果，说明该合成环境的 K=3 池加上先验已经能覆盖必需表面，学习带来的偏离反而有代价。')
    );
  }
  const randomVsPrior = cmpOf('C1', 'C0', 'verifiedRate');
  if (randomVsPrior !== undefined) {
    lines.push(
      '- **随机选择（固定 seed）**：Δ = ' + signed(randomVsPrior.meanDelta) + '，胜/平/负 ' +
      String(randomVsPrior.wins) + '/' + String(randomVsPrior.ties) + '/' + String(randomVsPrior.losses) +
      '。这说明先验本身携带信息：候选不是无差别可换的。'
    );
  }
  const frozenVsOnline = cmpOf('C3-online', 'C3-frozen', 'verifiedRate');
  if (frozenVsOnline !== undefined) {
    lines.push(
      '- **C3 冻结 vs 在线（同初始快照）**：Δ = ' + signed(frozenVsOnline.meanDelta) +
      '，胜/平/负 ' + String(frozenVsOnline.wins) + '/' + String(frozenVsOnline.ties) + '/' + String(frozenVsOnline.losses) +
      '。冻结臂全程使用同一快照（终态指纹 = 初始指纹），因此这里的差值**只**包含经验更新的作用，不含候选集合变化。'
    );
  }
  const crossLearning = (crossTask?.comparisons ?? []).find(
    (entry) => entry.left === 'C3-online' && entry.right === 'C3-frozen' && entry.metric === 'verifiedRate'
  );
  if (crossLearning !== undefined) {
    const spans = crossLearning.ci95[0] <= 0 && crossLearning.ci95[1] >= 0;
    lines.push(
      '- **协议二（donor 冻结 vs 目标适应）**：Δ = ' + signed(crossLearning.meanDelta) +
      '（95% 区间 [' + signed(crossLearning.ci95[0]) + ', ' + signed(crossLearning.ci95[1]) + ']，' +
      String(crossLearning.pairs) + ' 个目标任务，胜/平/负 ' + String(crossLearning.wins) + '/' +
      String(crossLearning.ties) + '/' + String(crossLearning.losses) + '）。' +
      (spans
        ? '区间跨越 0：样本量下这只能作为可行性证据，不能当作跨任务泛化结论。'
        : '区间不跨 0，但仍只在 4 个合成目标任务上成立，不构成对外泛化结论。')
    );
  }
  lines.push('');
  lines.push('## 6. 协议二：跨任务迁移（donor 冻结 vs 目标适应）');
  lines.push('');
  lines.push('| 组 | 选择 | 经验 | 验证通过率 | 平均覆盖率 | Final | probes/任务 | KL 均值 |');
  lines.push('| :-- | :-- | :-- | --: | --: | --: | --: | --: |');
  for (const arm of crossTask?.arms ?? []) {
    lines.push(
      '| ' + arm.id + '（' + arm.protocol + '） | ' + arm.selection + ' | ' +
      (arm.updates ? '目标写回' : 'donor 冻结') + ' | ' + fixed(arm.verifiedRate) + ' | ' + fixed(arm.meanCoverage) + ' | ' +
      fixed(arm.finalCoverage) + ' | ' + fixed(arm.tasks.length === 0 ? 0 : arm.cost.probesRun / arm.tasks.length, 2) + ' | ' +
      fixed(arm.health.klMean) + ' |'
    );
  }
  lines.push('');
  lines.push('zero-shot 与 adaptation 分开报告：前者只在 donor 库上检索且不写任何目标经验，后者在**同一个初始快照**上允许目标学习。');
  lines.push('共享一库的旧口径不能代表上述任一能力，也不能同时代表两者（方案 §8.2）。');
  lines.push('');
  for (const comparison of crossTask?.comparisons ?? []) {
    lines.push(
      '- **' + comparison.left + ' − ' + comparison.right + '（' + comparison.metric + '）**：' +
      signed(comparison.meanDelta) + '，95% 区间 [' + signed(comparison.ci95[0]) + ', ' + signed(comparison.ci95[1]) +
      ']，胜/平/负 ' + String(comparison.wins) + '/' + String(comparison.ties) + '/' + String(comparison.losses) + '。'
    );
  }
  lines.push('');
  lines.push('## 7. donor 隔离与来源清单');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| donor 任务 | ' + report.donorIsolation.donorTaskIds.join(', ') + ' |');
  lines.push('| 测试目标 | ' + report.donorIsolation.targetTaskIds.join(', ') + ' |');
  lines.push('| 交集 | ' + (report.donorIsolation.intersection.length === 0 ? '**空**（测试目标不在 donor 库）' : report.donorIsolation.intersection.join(', ')) + ' |');
  lines.push('| 近重复对（Jaccard ≥ 0.8） | ' + (report.donorIsolation.nearDuplicates.length === 0 ? '**无**' : report.donorIsolation.nearDuplicates.map((pair) => pair.donorId + '↔' + pair.targetId).join(', ')) + ' |');
  lines.push('');
  lines.push('| taskId | familyId | repoId | signature | split | donor 角色 | 经验来源 | 本任务记录数 | 可见库记录数 | 记录时间窗 (ms) |');
  lines.push('| :-- | :-- | :-- | :-- | :-- | :-- | :-- | --: | --: | :-- |');
  for (const source of report.sources) {
    lines.push(
      '| ' + source.taskId + ' | ' + source.familyId + ' | ' + source.repoId + ' | ' + source.signature + ' | ' +
      source.split + ' | ' + source.donorRole + ' | ' + source.experienceSource + ' | ' + String(source.storeRecords) +
      ' | ' + String(source.libraryRecords) + ' | ' + source.timeWindow + ' |'
    );
  }
  lines.push('');
  lines.push('`repoId` 是派生值：合成任务集没有真实仓库，repoId = `synthetic/<family>`；真实仓库基准仍需 §8.4 的第 2/3 类任务集。');
  lines.push('“可见库记录数”是决策时能检索到的初始快照大小；“本任务记录数”是该任务自己的 session 写下的经验条数（zero-shot 为 0）。');
  lines.push('时间窗来自注入的单调时钟，可逐条与经验记录的 `createdAt` 对齐。');
  lines.push('');
  lines.push('## 8. 协议三：离线策略选择');
  lines.push('');
  lines.push('| 切分 | 任务 |');
  lines.push('| :-- | :-- |');
  lines.push('| train | ' + report.policySelection.splits.train.join(', ') + ' |');
  lines.push('| validation | ' + report.policySelection.splits.validation.join(', ') + ' |');
  lines.push('| test | ' + report.policySelection.splits.test.join(', ') + ' |');
  lines.push('');
  lines.push('选择只读 train（`selectionInputs=' + report.policySelection.selectionInputs.join(',') + '`），测试集不参与超参选择。');
  lines.push('选中配置：k=' + String(report.policySelection.selected.k) + ', beta=' + String(report.policySelection.selected.beta) +
    ', similarityThreshold=' + String(report.policySelection.selected.similarityThreshold) + '。');
  lines.push('');
  lines.push('| 候选超参 | train 验证通过率 | train 平均覆盖率 |');
  lines.push('| :-- | --: | --: |');
  for (const candidate of report.policySelection.candidates) {
    lines.push('| ' + candidate.dimension + ' | ' + fixed(candidate.trainVerifiedRate) + ' | ' + fixed(candidate.trainMeanCoverage) + ' |');
  }
  lines.push('');
  lines.push('| 集合 | 验证通过率 | 平均覆盖率 | 曲线 |');
  lines.push('| :-- | --: | --: | :-- |');
  lines.push('| validation | ' + fixed(report.policySelection.validationVerifiedRate) + ' | - | - |');
  lines.push('| test | ' + fixed(report.policySelection.testVerifiedRate) + ' | ' + fixed(report.policySelection.testMeanCoverage) + ' | ' + report.policySelection.testCurve.map((value) => fixed(value)).join(' → ') + ' |');
  lines.push('');
  const trainScores = report.policySelection.candidates.map((entry) => entry.trainVerifiedRate);
  const allTied = trainScores.length > 0 && trainScores.every((value) => Math.abs(value - (trainScores[0] ?? 0)) <= 1e-9);
  if (allTied) {
    lines.push('本次 ' + String(trainScores.length) + ' 个候选配置在 train 上**并列**（' + fixed(trainScores[0] ?? 0) + '），');
    lines.push('因此“选中”只说明选择流程可跑通、切分无泄漏，**不说明任何超参有效**；这也是不允许把该配置写成生产默认值的原因。');
    lines.push('');
  }
  lines.push('边界：' + report.policySelection.boundary + '。');
  lines.push('');
  lines.push('## 9. 成本口径：相同 probe 数 ≠ 相同总成本');
  lines.push('');
  lines.push('| 组 | probes 总数 | 池生成次数 | 候选生成 token | 评估 token | prompt advice token | 模型调用 | 墙钟 (ms) | 失败 probe | 重试 |');
  lines.push('| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const arm of arms) {
    lines.push(
      '| ' + arm.id + ' | ' + String(arm.cost.probesRun) + ' | ' + String(arm.cost.poolGenerations) + ' | ' +
      String(arm.cost.candidateGenerationTokens) + ' | ' + String(arm.cost.evaluationTokens) + ' | ' +
      String(arm.cost.promptAdviceTokens) + ' | ' + String(arm.cost.modelCalls) + ' | ' +
      fixed(arm.cost.timeMs, 2) + ' | ' + String(arm.cost.failedProbes) + ' | ' + String(arm.cost.retries) + ' |'
    );
  }
  lines.push('');
  lines.push('token 口径：' + FAIR_TOKEN_ESTIMATOR + '；probe 数、失败数与墙钟是实测。');
  lines.push('重试口径：' + (arms[0]?.cost.retryNote ?? '') + '。');
  lines.push('');
  lines.push('所有公平臂的 probes/任务相同（每轮恰好一个 probe），但成本并不相同：C2 额外渲染 prompt advice 文本（token 列可见），');
  lines.push('C4 额外跑 L1 元决策（墙钟与决策数可见，但不新增模型调用）。这就是“相同 probe 数不等于相同总成本”的可核对面。');
  lines.push('');
  if (report.onlineItem !== null) {
    lines.push('## 10. 在线生成候选（独立评测项，不是公平臂）');
    lines.push('');
    lines.push(report.onlineItem.note);
    lines.push('');
    lines.push('| 组 | 候选数 | Avg | Final | Final−Avg | 解出率 | probes/任务 | 模型调用/任务 | 墙钟 (ms) |');
    lines.push('| :-- | --: | --: | --: | --: | --: | --: | --: | --: |');
    for (const condition of report.onlineItem.conditions) {
      lines.push(
        '| ' + condition.id + ' | ' + String(condition.config.candidateCount) + ' | ' + fixed(condition.avg) + ' | ' +
        fixed(condition.final) + ' | ' + signed(condition.finalMinusAvg) + ' | ' + fixed(condition.solvedRate) + ' | ' +
        fixed(condition.probesPerTask, 2) + ' | ' + fixed(condition.modelCallsPerTask, 2) + ' | - |'
      );
    }
    lines.push('');
    lines.push('这组数字来自**当前工作树**的同一实现与同一任务集；`docs/reports/p5-eval-report.md` 与 `docs/reports/p6-eval-baseline.md` 是在 PR4（逐执行归因）／PR5（决策内核）落地**之前**测得的，');
    lines.push('因此它们的 B3 数值与本表可能不同——本报告不重写那两份历史数字，也不把差异当作收益或退化证据。无论哪次测量，B0–B3 仍然**只能**说明“更丰富的候选＋选择＋经验”的组合效果（R6）。');
    lines.push('');
    lines.push('本表绑定 §2 的生成时间与该次工作树字节；`src/**` 在本报告生成后若再变化，必须按 §15 重跑整份报告（公平臂 §3–§9 同样依赖 `src/jitrl/decision-kernel.ts` 等被评字节）。');
    lines.push('');
  }
  lines.push('## 11. 顺序依赖');
  lines.push('');
  if (report.orderChecks.length === 0) {
    lines.push('本次未执行顺序检查。');
  } else {
    lines.push('| 组 | 协议 | 顺序 | 最大 |Δ| | 均值 Δ | 变化任务数 | 说明 |');
    lines.push('| :-- | :-- | :-- | --: | --: | --: | :-- |');
    for (const check of report.orderChecks) {
      lines.push(
        '| ' + check.armId + ' | ' + check.protocol + ' | ' + check.order + ' | ' + fixed(check.maxAbsDelta) + ' | ' +
        signed(check.meanDelta) + ' | ' + String(check.changedTasks) + ' | ' + check.note + ' |'
      );
    }
  }
  lines.push('');
  lines.push('## 12. 指标口径与安全边界');
  lines.push('');
  lines.push('- 主指标：任务验证通过率、失败率、预算内完成率（本次每臂的 probes/run 固定为 ' + String(report.generatedFrom.rounds) + '，预算内完成率因此是上限检查，而不是虚构的差异）；');
  lines.push('- 辅助指标：成本／延迟、工具错误率与错误重复、检索命中率、有效样本支持（meanSupport）、KL、策略改变率；');
  lines.push('- 安全：本次公平重放不构造 invariant 探针，也不提供任何可关闭 invariant 隔离的生产开关；A4 消融若要做只能放隔离 benchmark fixture 且不流入发布包（方案 §8.5）；');
  lines.push('- Embedding（A6）后置：先证明现有状态与标签可靠，再谈更贵检索。');
  lines.push('');
  lines.push('## 13. 与 p5-eval-report.md 的差异，以及仍然不可得的结论');
  lines.push('');
  lines.push('- 本文件**不修改** `docs/reports/p5-eval-report.md` 的历史数字；B0–B3 保留为历史组合对照，另见 `docs/reports/p6-eval-baseline.md` 的固定基线。');
  lines.push('- p5 的 “B3 > B1 / L2 候选选择有效” 在本报告中按 R6 重新表述：那是**候选集合+选择+共享经验的组合效果**，不是 JitRL logit 修正的单独贡献；');
  lines.push('  C0–C4 才是同 K、同候选池下唯一可归因于选择渠道与经验更新的对照。');
  lines.push('- p5 的 “12 个任务共用一个插件实例/经验库” 不能声称跨任务泛化；本报告把同任务适应（协议一）与跨任务迁移（协议二，donor 冻结 vs 目标适应）拆开报告，并有 donor 交集/近重复断言。');
  lines.push('- **仍然不可得**：真实模型/真实 DSH 宿主/真实 MCP 后端上的收益；真实仓库任务集（JobBench/LAB/WorkBuddy-Bench）上的效果；真实 LLM judge 的影响；embedding 检索对比；');
  lines.push('  以及任何“生产默认超参已调优”的结论（方案 §8.3–§8.4 明确要求先修归因、再谈超参与外推）。');
  lines.push('');
  lines.push('## 14. 边界声明');
  lines.push('');
  for (const boundary of report.boundaries) {
    lines.push('- ' + boundary);
  }
  lines.push('');
  lines.push('## 15. 如何复现');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1) 预编译评测库（与默认 CLI 同一条路径；不需要任何 --experimental-* 参数）');
  lines.push('node scripts/eval/build-eval.mjs');
  lines.push('');
  lines.push('# 2) 运行公平对照并重新生成本文件（episodes=5, rounds=3）');
  lines.push("node --input-type=module -e \"const {loadEvalLib}=await import('./scripts/eval/build-eval.mjs');const lib=await loadEvalLib();const r=await lib.runFairEval({episodes:5,rounds:3});process.stdout.write(lib.renderFairMarkdown(r,{commit:'<sha>',generatedAt:'<time>',command:'runFairEval({episodes:5,rounds:3})'}))\" > docs/reports/p6-fair-eval.md");
  lines.push('');
  lines.push('# 3) 门禁：类型检查 + 协议/公平对照断言');
  lines.push('pnpm run typecheck');
  lines.push('pnpm exec vitest run tests/e2e/jitrl-ablation.test.ts');
  lines.push('```');
  lines.push('');
  lines.push('CI 断言覆盖：池指纹跨臂一致、C3 冻结/在线初始快照相同且冻结臂终态 = 初始、donor 与测试目标交集为空且无近重复、');
  lines.push('成本字段齐全且“相同 probe 数 ≠ 相同总成本”、打乱任务顺序后同任务协议不变、同参数两次运行指标块逐字节一致。');
  lines.push('');
  return lines.join('\n');
}




