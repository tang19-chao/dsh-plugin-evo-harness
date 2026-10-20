/**
 * Event-sourced trajectory collection for one probe run.
 *
 * The collector is the only place that turns raw executor output into the frozen
 * ProbeTrajectory record: it assigns step indexes/timestamps, accumulates tool
 * errors and failure signals, computes deterministic metrics (steps, toolCalls,
 * toolErrors, durationMs, tokens, deliverableChars) and derives the failure
 * signals the four-way taxonomy needs. Time is injectable so tests are
 * deterministic.
 */
import {
  HARNESS_COMPONENT_KEYS,
  type EightSurfacePatch,
  type FailureSignal,
  type FailureSignalKind,
  type HarnessComponentKey,
  type PatchOrigin,
  type ProbeExecutionResult,
  type ProbeTrajectory,
  type TokenUsage,
  type ToolErrorRecord,
  type TrajectoryDeliverable,
  type TrajectoryError,
  type TrajectoryMetrics,
  type TrajectoryRole,
  type TrajectoryStatus,
  type TrajectoryStep
} from '../types/contracts';

/** Step input accepted by the collector; index/at are assigned by the collector. */
export type TrajectoryStepInput = Omit<TrajectoryStep, 'index' | 'at'> & { readonly at?: number };

/** Collector wiring for one probe branch run. */
export interface TrajectoryCollectorInit {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly branchNamespace: string;
  readonly role: TrajectoryRole;
  readonly patch: EightSurfacePatch;
  readonly surfaceKeys?: readonly HarnessComponentKey[];
  readonly treeId?: string;
  readonly nodeId?: string;
  readonly referenceTrajectoryId?: string;
  readonly memoryRecallIds?: readonly string[];
  readonly now?: () => number;
}

/** Terminal input for finalize(). */
export interface FinalizeTrajectoryInput {
  readonly status?: TrajectoryStatus;
  readonly result?: ProbeExecutionResult;
  readonly error?: unknown;
  readonly endedAt?: number;
  readonly diagnostics?: readonly string[];
}

/** Convert any thrown value into the serializable TrajectoryError shape. */
export function toTrajectoryError(error: unknown): TrajectoryError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {})
    };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }
  let message: string;
  try {
    message = JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: 'Error', message };
}

/** Deterministic metrics derived from observed steps and usage. */
export function computeTrajectoryMetrics(input: {
  readonly steps: readonly TrajectoryStep[];
  readonly toolErrors: readonly ToolErrorRecord[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly usage?: TokenUsage;
  readonly deliverable?: TrajectoryDeliverable;
}): TrajectoryMetrics {
  const toolCalls = input.steps.filter((step) => step.kind === 'tool').length;
  return {
    steps: input.steps.length,
    toolCalls,
    toolErrors: input.toolErrors.length,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    ...(input.usage === undefined
      ? {}
      : {
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          totalTokens: input.usage.totalTokens
        }),
    ...(input.deliverable === undefined
      ? {}
      : { deliverableChars: input.deliverable.content.length })
  };
}

/** Renumber steps so indexes are contiguous and start at zero. */
export function reindexSteps(steps: readonly TrajectoryStep[]): readonly TrajectoryStep[] {
  return steps.map((step, index) => (step.index === index ? step : { ...step, index }));
}

/** Normalize a surface key list into HARNESS_COMPONENT_KEYS mount order. */
export function orderSurfaceKeys(
  keys: readonly HarnessComponentKey[]
): readonly HarnessComponentKey[] {
  const wanted = new Set<HarnessComponentKey>(keys);
  return HARNESS_COMPONENT_KEYS.filter((key) => wanted.has(key));
}

function classifyError(error: TrajectoryError): FailureSignalKind {
  if (error.name === 'CordisSeamTimeoutError') {
    return 'timeout';
  }
  if (error.name === 'SyntaxError') {
    return 'syntax_error';
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|Module not found/i.test(error.message)) {
    return 'import_error';
  }
  return 'unknown';
}

/**
 * Merge explicit executor signals with signals the collector can prove from the
 * run itself. Duplicates (same kind/step/tool/message) are collapsed so the
 * taxonomy never counts one failure twice.
 */
export function deriveFailureSignals(input: {
  readonly status: TrajectoryStatus;
  readonly error?: TrajectoryError;
  readonly toolErrors: readonly ToolErrorRecord[];
  readonly deliverable?: TrajectoryDeliverable;
  readonly explicit: readonly FailureSignal[];
}): readonly FailureSignal[] {
  const signals: FailureSignal[] = [];
  const seen = new Set<string>();
  const push = (signal: FailureSignal): void => {
    const key =
      signal.kind + '|' + String(signal.stepIndex ?? '') + '|' + (signal.toolName ?? '') + '|' + signal.message;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    signals.push(signal);
  };

  for (const signal of input.explicit) {
    push(signal);
  }
  if (input.status === 'timeout') {
    push({
      kind: 'timeout',
      message: 'Branch exceeded its probe timeout.',
      retryable: false,
      repairable: false
    });
  }
  for (const record of input.toolErrors) {
    push({
      kind: 'tool_error',
      message: record.message,
      ...(record.toolName.length > 0 ? { toolName: record.toolName } : {}),
      ...(record.code === undefined ? {} : { code: record.code }),
      ...(record.stepIndex === undefined ? {} : { stepIndex: record.stepIndex }),
      ...(record.retryable === undefined ? {} : { retryable: record.retryable })
    });
  }
  if (input.status === 'succeeded' && input.deliverable === undefined) {
    push({
      kind: 'no_deliverable',
      message: 'Candidate run succeeded without producing a deliverable.',
      repairable: true
    });
  }
  if (input.status === 'failed' && input.error !== undefined) {
    push({
      kind: classifyError(input.error),
      message: input.error.message,
      ...(input.error.code === undefined ? {} : { code: input.error.code })
    });
  }
  return signals;
}

/** Collects steps, tool errors and failure signals, then freezes a trajectory. */
export class TrajectoryCollector {
  readonly startedAt: number;
  private readonly init: TrajectoryCollectorInit;
  private readonly now: () => number;
  private readonly steps: TrajectoryStep[] = [];
  private readonly toolErrors: ToolErrorRecord[] = [];
  private readonly signals: FailureSignal[] = [];
  private readonly diagnostics: string[] = [];
  private error: TrajectoryError | undefined;
  private surfaceKeys: readonly HarnessComponentKey[];
  private trajectory: ProbeTrajectory | undefined;

  constructor(init: TrajectoryCollectorInit) {
    this.init = init;
    this.now = init.now ?? Date.now;
    this.startedAt = this.now();
    this.surfaceKeys = orderSurfaceKeys(init.surfaceKeys ?? []);
  }

  /** Number of steps captured so far. */
  get stepCount(): number {
    return this.steps.length;
  }

  /** Set the surfaces actually mounted; ignored after finalize(). */
  setSurfaceKeys(keys: readonly HarnessComponentKey[]): void {
    if (this.trajectory !== undefined) {
      return;
    }
    this.surfaceKeys = orderSurfaceKeys(keys);
  }

  /** Append one step, assigning its index and timestamp. */
  appendStep(input: TrajectoryStepInput): TrajectoryStep {
    const step: TrajectoryStep = {
      ...input,
      index: this.steps.length,
      at: input.at ?? this.now()
    };
    this.steps.push(step);
    return step;
  }

  /** Append several steps in order. */
  appendSteps(inputs: readonly TrajectoryStepInput[]): readonly TrajectoryStep[] {
    return inputs.map((input) => this.appendStep(input));
  }

  /** Record a structured tool error (feeds the failure taxonomy). */
  recordToolError(record: ToolErrorRecord): ToolErrorRecord {
    this.toolErrors.push(record);
    return record;
  }

  /** Record an explicit failure signal from the executor or the seam layer. */
  recordFailureSignal(signal: FailureSignal): FailureSignal {
    this.signals.push(signal);
    return signal;
  }

  /** Record a diagnostic string; exposed through trajectory metadata. */
  recordDiagnostic(message: string): void {
    this.diagnostics.push(message);
  }

  /** Record the run-level error. */
  recordError(error: unknown): TrajectoryError {
    const normalized = toTrajectoryError(error);
    this.error = normalized;
    return normalized;
  }

  /** Build the immutable ProbeTrajectory. Idempotent: repeated calls return it. */
  finalize(input: FinalizeTrajectoryInput = {}): ProbeTrajectory {
    if (this.trajectory !== undefined) {
      return this.trajectory;
    }
    const result = input.result;
    const endedAt = input.endedAt ?? this.now();
    const error =
      result !== undefined && result.error !== undefined
        ? result.error
        : this.error ?? (input.error === undefined ? undefined : toTrajectoryError(input.error));
    const status: TrajectoryStatus =
      input.status ?? (result === undefined ? undefined : result.status) ?? (error === undefined ? 'succeeded' : 'failed');
    const steps = result !== undefined && result.steps !== undefined ? reindexSteps(result.steps) : reindexSteps(this.steps);
    const toolErrors =
      result !== undefined && result.toolErrors !== undefined
        ? [...this.toolErrors, ...result.toolErrors]
        : [...this.toolErrors];
    const deliverable = result === undefined ? undefined : result.deliverable;
    const explicitSignals =
      result !== undefined && result.failureSignals !== undefined
        ? [...this.signals, ...result.failureSignals]
        : [...this.signals];
    const failureSignals = deriveFailureSignals({
      status,
      error,
      toolErrors,
      deliverable,
      explicit: explicitSignals
    });
    const diagnostics = [...this.diagnostics, ...(input.diagnostics ?? [])];
    const patchOrigin: PatchOrigin = this.init.patch.origin;

    const trajectory: ProbeTrajectory = {
      id: this.init.id,
      sessionId: this.init.sessionId,
      branchId: this.init.branchId,
      branchNamespace: this.init.branchNamespace,
      role: this.init.role,
      status,
      patchId: this.init.patch.id,
      patchOrigin,
      surfaceKeys: this.surfaceKeys,
      startedAt: this.startedAt,
      endedAt,
      metrics: computeTrajectoryMetrics({
        steps,
        toolErrors,
        startedAt: this.startedAt,
        endedAt,
        usage: result === undefined ? undefined : result.usage,
        deliverable
      }),
      steps,
      toolErrors,
      failureSignals,
      memoryRecallIds: [...(this.init.memoryRecallIds ?? [])],
      ...(this.init.treeId === undefined ? {} : { treeId: this.init.treeId }),
      ...(this.init.nodeId === undefined ? {} : { nodeId: this.init.nodeId }),
      ...(this.init.referenceTrajectoryId === undefined
        ? {}
        : { referenceTrajectoryId: this.init.referenceTrajectoryId }),
      ...(deliverable === undefined ? {} : { deliverable }),
      ...(error === undefined ? {} : { error }),
      ...(diagnostics.length === 0 ? {} : { metadata: { diagnostics } })
    };

    this.trajectory = trajectory;
    return trajectory;
  }
}
