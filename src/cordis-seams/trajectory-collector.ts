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
import {
  isMissingTrajectorySentinel,
  mergeEvidenceIntegrityMarks,
  quarantineTrajectory,
  readCarriedEvidenceIntegrityMark,
  scanPatchEvidenceIntegrity,
  scanTrajectoryEvidenceIntegrity,
  type EvidenceIntegrityPolicy
} from '../verification/evidence-integrity';

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
  /**
   * rev8 #118/#175: the HOST-owned evidence-integrity policy (answer-key
   * criteria, visible text, forbidden path segments). Never derived from
   * `result.metadata` — a branch cannot declare its own evidence clean (the
   * same trust boundary as C2a). Absent => the host-owned scan is skipped
   * entirely and finalize behaves byte-identically to the pre-rev8 shape
   * (sentinel rejection on the deliverable still applies: it is unconditional).
   *
   * rev8 W2-propagation: the ONLY thing read from a result's metadata is the
   * inner collector's mark at `metadata.trajectory.evidenceIntegrity`, and it is
   * accepted only as a DENIAL (`contaminated === true`, exact version, well-
   * formed findings). A "clean" claim is never read, so it cannot suppress this
   * collector's own scan; the mark can only withhold its own evidence. Absent
   * policy + absent mark => byte-identical output.
   */
  readonly evidenceIntegrity?: EvidenceIntegrityPolicy;
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
  /**
   * rev8 #67: the TWO artifact channels fail independently. A trajectory
   * render/read failure and a deliverable render/read failure are recorded
   * here — never merged into `this.error` (which is the RUN's terminal error)
   * and never allowed to overwrite each other.
   */
  private readonly trajectoryFaults: TrajectoryError[] = [];
  private readonly deliverableFaults: TrajectoryError[] = [];
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

  /**
   * rev8 #67: record a failure of the TRAJECTORY channel (the step/event
   * render). It is kept beside the run error, never in place of it, so a
   * successful deliverable read can neither overwrite it nor be overwritten
   * by it.
   */
  recordTrajectoryFault(error: unknown): TrajectoryError {
    const normalized = toTrajectoryError(error);
    this.trajectoryFaults.push(normalized);
    return normalized;
  }

  /**
   * rev8 #67: record a failure of the DELIVERABLE channel. Upstream #67's
   * exact shape: the trajectory stays intact, the produced artifact is
   * reported as unavailable, and neither write clobbers the other.
   */
  recordDeliverableFault(error: unknown): TrajectoryError {
    const normalized = toTrajectoryError(error);
    this.deliverableFaults.push(normalized);
    return normalized;
  }

  /**
   * Build the immutable ProbeTrajectory. Idempotent: repeated calls return it.
   *
   * rev8 additions (all additive; with no integrity policy and no faults the
   * output is byte-identical to the pre-rev8 shape):
   *   #67  every `result.*` channel is read independently — a getter that
   *        throws on one channel records a fault and yields `undefined`, it
   *        can never erase the channels that already read; a recorded terminal
   *        error demotes a `succeeded` status (a later success cannot swallow a
   *        recorded failure); channel faults become failure signals, never the
   *        run error.
   *   #72  a missing/unparseable-trajectory sentinel deliverable is rejected:
   *        it is dropped, a failure signal fires, the already-collected steps
   *        stay intact.
   *   #118/#175  with a host-supplied integrity policy the merged content and
   *        the patch paths are scanned; a contaminated trajectory is replaced
   *        by the neutral quarantine record.
   *   W2-propagation  a DENY-ONLY contamination mark carried by the result
   *        (`metadata.trajectory.evidenceIntegrity`, written by this repo's
   *        agent-loop bridge) is merged with the host's own re-scan, so the
   *        outer trajectory keeps the fact the inner collector already acted
   *        on. A "clean"/malformed/foreign claim reads as absent.
   */
  finalize(input: FinalizeTrajectoryInput = {}): ProbeTrajectory {
    if (this.trajectory !== undefined) {
      return this.trajectory;
    }
    const result = input.result;
    const endedAt = input.endedAt ?? this.now();

    // #67: read each executor-result channel behind its own guard.
    const getterFaults: TrajectoryError[] = [];
    const readChannel = <T>(read: () => T): T | undefined => {
      try {
        return read();
      } catch (caught) {
        getterFaults.push(toTrajectoryError(caught));
        return undefined;
      }
    };
    const resultStatus = readChannel(() => result?.status);
    const resultError = readChannel(() => result?.error);
    const resultSteps = readChannel(() => result?.steps);
    const resultToolErrors = readChannel(() => result?.toolErrors);
    const resultDeliverable = readChannel(() => result?.deliverable);
    const resultUsage = readChannel(() => result?.usage);
    const resultSignals = readChannel(() => result?.failureSignals);
    // rev8 W2-propagation: the inner collector's DENY-ONLY mark, read from the
    // one documented bridge channel. A "clean"/malformed/foreign claim reads as
    // absent; the host-owned scan below always runs regardless.
    const resultMetadata = readChannel(() => result?.metadata);

    const error =
      resultError !== undefined
        ? resultError
        : this.error ?? (input.error === undefined ? undefined : toTrajectoryError(input.error));
    const declaredStatus: TrajectoryStatus =
      input.status ??
      (result === undefined ? undefined : resultStatus) ??
      (error === undefined ? 'succeeded' : 'failed');
    // #67: a recorded terminal error cannot be swallowed by a later success.
    const status: TrajectoryStatus =
      declaredStatus === 'succeeded' && error !== undefined ? 'failed' : declaredStatus;
    // MEM-12: one merge policy for all three observed-event channels — the
    // union of collector-recorded and executor-returned entries, in that order,
    // with steps reindexed afterwards. Steps used to be REPLACED while tool
    // errors and signals were CONCATENATED, so metrics could describe two
    // different event sets and every collector-recorded step silently vanished
    // once an executor returned its own steps.
    const steps = reindexSteps([...this.steps, ...(resultSteps ?? [])]);
    const toolErrors =
      resultToolErrors !== undefined ? [...this.toolErrors, ...resultToolErrors] : [...this.toolErrors];
    // #72: a missing/unparseable-trajectory sentinel is not a produced
    // artifact. The sentinel text never enters the frozen record; the steps
    // (the trajectory channel) stay exactly as collected.
    const deliverableSentinel =
      resultDeliverable !== undefined &&
      typeof resultDeliverable.content === 'string' &&
      isMissingTrajectorySentinel(resultDeliverable.content);
    if (deliverableSentinel) {
      this.diagnostics.push('produced deliverable rejected: missing-trajectory sentinel');
    }
    const deliverable = deliverableSentinel ? undefined : resultDeliverable;
    const explicitSignals: FailureSignal[] = [
      ...this.signals,
      ...(resultSignals ?? [])
    ];
    // #67: independently recorded channel faults become failure signals —
    // visible to the taxonomy and the scorer, never merged into the run error.
    for (const fault of [...this.trajectoryFaults, ...this.deliverableFaults, ...getterFaults]) {
      explicitSignals.push({
        kind: 'unknown',
        message: fault.message,
        code: 'evidence-render-failed',
        repairable: true
      });
    }
    if (deliverableSentinel) {
      explicitSignals.push({
        kind: 'unknown',
        message: 'the produced artifact is a missing-trajectory sentinel and was rejected',
        code: 'missing-trajectory-sentinel',
        repairable: true
      });
    }
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
        usage: result === undefined ? undefined : resultUsage,
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

    // #118/#175: the host-owned integrity scan. The mark is computed HERE, on
    // the merged content, from the HOST's policy — never from anything a
    // branch attached to its result. A hit replaces the trajectory with the
    // neutral quarantine record before it is frozen. The rejected sentinel
    // deliverable is scanned in its raw form so the mark records WHY it was
    // withheld, not just that something was.
    //
    // rev8 W2-propagation: the OUTER collector must not lose a contamination
    // fact the INNER collector already acted on. With the default agent-loop
    // assembly the inner collector (armed with the same host policy) quarantines
    // the content first and leaves the only mark in `result.metadata.trajectory`
    // (src/dsh-bridge/agent-loop-executor.ts:517-538). The content that reaches
    // this collector is therefore already neutral, so the local re-scan cannot
    // rediscover the hit. The carried mark is read from that ONE documented
    // channel and is DENY-ONLY: a "clean"/malformed/foreign claim reads as
    // absent, and it is only ever MERGED with — never a substitute for — the
    // host's own patch/sentinel rejection, which still runs whenever a policy is
    // configured. A branch can withhold its own evidence with this channel; it
    // cannot make anything pass.
    const integrityPolicy = this.init.evidenceIntegrity;
    const carriedMark = readCarriedEvidenceIntegrityMark(resultMetadata);
    if (integrityPolicy !== undefined || carriedMark !== undefined) {
      const scanTarget =
        deliverableSentinel && resultDeliverable !== undefined
          ? { ...trajectory, deliverable: resultDeliverable }
          : trajectory;
      const ownMark =
        integrityPolicy === undefined
          ? undefined
          : scanTrajectoryEvidenceIntegrity(scanTarget, integrityPolicy) ??
            scanPatchEvidenceIntegrity(this.init.patch, integrityPolicy);
      const mark = mergeEvidenceIntegrityMarks(ownMark, carriedMark);
      if (mark !== undefined) {
        const quarantined = quarantineTrajectory(trajectory, mark);
        this.trajectory = quarantined;
        return quarantined;
      }
    }

    this.trajectory = trajectory;
    return trajectory;
  }
}
