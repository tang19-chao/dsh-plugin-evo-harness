/**
 * Shared fixtures for Dream-RSI unit tests (no host, no network, no sandbox).
 */

import type {
  CompositionResult,
  DiscoveryNode,
  EightSurfacePatch,
  FailureCategory,
  FailureDiagnosis,
  FailureSignal,
  GuidanceMode,
  MetaSearchPolicy,
  PatchOrigin,
  ProbeTrajectory,
  TrajectoryDeliverable,
  TrajectoryMetrics,
  TrajectoryStatus,
  ToolErrorRecord
} from '../../../src/types/contracts';
import { createDefaultPolicy } from '../../../src/dream-rsi/active-policy';
import type { CreateDiscoveryNodeInput } from '../../../src/dream-rsi/discovery-tree';

/** Deterministic clock for tests. */
export function fixedClock(start = 1_000): () => number {
  let current = start;
  return () => {
    current += 1;
    return current;
  };
}

export function makePatch(overrides: Partial<EightSurfacePatch> = {}): EightSurfacePatch {
  return {
    id: overrides.id ?? 'patch-1',
    sessionId: overrides.sessionId ?? 'session-1',
    branchId: overrides.branchId ?? 'branch-1',
    origin: overrides.origin ?? 'reference',
    purpose: overrides.purpose ?? 'initial',
    guidance: overrides.guidance ?? 'memory',
    label: overrides.label ?? 'label',
    rationale: overrides.rationale ?? 'rationale',
    edits: overrides.edits ?? {},
    createdAt: overrides.createdAt ?? 10,
    ...(overrides.parentPatchIds === undefined ? {} : { parentPatchIds: overrides.parentPatchIds }),
    ...(overrides.sourceLessonIds === undefined ? {} : { sourceLessonIds: overrides.sourceLessonIds }),
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
  };
}

export function makeMetrics(overrides: Partial<TrajectoryMetrics> = {}): TrajectoryMetrics {
  return {
    steps: overrides.steps ?? 5,
    toolCalls: overrides.toolCalls ?? 4,
    toolErrors: overrides.toolErrors ?? 0,
    durationMs: overrides.durationMs ?? 500
  };
}

export function makeSignal(overrides: Partial<FailureSignal> = {}): FailureSignal {
  return {
    kind: overrides.kind ?? 'tool_error',
    message: overrides.message ?? 'boom',
    ...(overrides.toolName === undefined ? {} : { toolName: overrides.toolName }),
    ...(overrides.retryable === undefined ? {} : { retryable: overrides.retryable }),
    ...(overrides.repairable === undefined ? {} : { repairable: overrides.repairable }),
    ...(overrides.code === undefined ? {} : { code: overrides.code })
  };
}

export function makeToolError(overrides: Partial<ToolErrorRecord> = {}): ToolErrorRecord {
  return {
    toolName: overrides.toolName ?? 'run_script',
    message: overrides.message ?? 'unexpected token }',
    ...(overrides.code === undefined ? {} : { code: overrides.code }),
    ...(overrides.retryable === undefined ? {} : { retryable: overrides.retryable })
  };
}

export function makeDeliverable(content = 'done'): TrajectoryDeliverable {
  return { content, format: 'text' };
}

export interface TrajectoryOptions {
  readonly id?: string;
  readonly status?: TrajectoryStatus;
  readonly metrics?: Partial<TrajectoryMetrics>;
  readonly toolErrors?: readonly ToolErrorRecord[];
  readonly failureSignals?: readonly FailureSignal[];
  /** null means "probe produced no deliverable". */
  readonly deliverable?: TrajectoryDeliverable | null;
  readonly branchId?: string;
  readonly nodeId?: string;
  readonly patchId?: string;
  readonly patchOrigin?: PatchOrigin;
}

export function makeTrajectory(options: TrajectoryOptions = {}): ProbeTrajectory {
  const trajectory: ProbeTrajectory = {
    id: options.id ?? 'traj-1',
    sessionId: 'session-1',
    branchId: options.branchId ?? 'branch-1',
    branchNamespace: 'ns',
    role: 'candidate',
    status: options.status ?? 'succeeded',
    patchId: options.patchId ?? 'patch-1',
    patchOrigin: options.patchOrigin ?? 'reference',
    surfaceKeys: ['system_prompt'],
    startedAt: 100,
    endedAt: 600,
    metrics: makeMetrics(options.metrics),
    steps: [],
    toolErrors: options.toolErrors ?? [],
    failureSignals: options.failureSignals ?? [],
    memoryRecallIds: [],
    ...(options.deliverable === undefined
      ? { deliverable: makeDeliverable() }
      : options.deliverable === null
        ? {}
        : { deliverable: options.deliverable }),
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId })
  };
  return trajectory;
}

export function makeDiagnosis(
  category: FailureCategory = 'repairable_implementation',
  overrides: Partial<FailureDiagnosis> = {}
): FailureDiagnosis {
  return {
    category,
    confidence: overrides.confidence ?? 0.8,
    repairable: overrides.repairable ?? category === 'repairable_implementation',
    recommendedAction: overrides.recommendedAction ?? 'repair',
    evidence: overrides.evidence ?? ['test evidence'],
    signals: overrides.signals ?? [],
    ...(overrides.repairHint === undefined ? {} : { repairHint: overrides.repairHint })
  };
}

export function makePolicy(overrides: Partial<MetaSearchPolicy> = {}): MetaSearchPolicy {
  const base = createDefaultPolicy({ id: overrides.id ?? 'pi-0' }, () => 5_000);
  const merged: MetaSearchPolicy = { ...base, ...overrides };
  return merged;
}

export function makeComposition(
  overrides: Partial<CompositionResult> = {}
): CompositionResult {
  return {
    selectedBranchId: overrides.selectedBranchId ?? null,
    selectedNodeId: overrides.selectedNodeId ?? null,
    selectedTrajectoryId: overrides.selectedTrajectoryId ?? null,
    selectedPatch: overrides.selectedPatch ?? null,
    composedPatch: overrides.composedPatch ?? null,
    assessments: overrides.assessments ?? [],
    adoptionRatios: overrides.adoptionRatios ?? {},
    rationale: overrides.rationale ?? 'test composition',
    evaluatedAt: overrides.evaluatedAt ?? 2_000
  };
}

export interface NodeSpec {
  readonly id: string;
  readonly patchId?: string;
  readonly origin?: PatchOrigin;
  readonly guidance?: GuidanceMode;
  readonly purpose?: CreateDiscoveryNodeInput['purpose'];
}

export function nodeInput(spec: NodeSpec): CreateDiscoveryNodeInput {
  return {
    id: spec.id,
    patchId: spec.patchId ?? 'patch-' + spec.id,
    patchOrigin: spec.origin ?? 'reference',
    purpose: spec.purpose ?? 'initial',
    guidance: spec.guidance ?? 'memory'
  };
}

export function childInput(parentId: string, spec: NodeSpec): CreateDiscoveryNodeInput {
  return { ...nodeInput(spec), parentId };
}

/** Nodes keyed by id for quick lookup in assertions. */
export function indexNodes(nodes: readonly DiscoveryNode[]): Map<string, DiscoveryNode> {
  const map = new Map<string, DiscoveryNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}
