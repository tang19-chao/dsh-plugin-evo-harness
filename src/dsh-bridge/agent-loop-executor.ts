/**
 * Multi-step agent probe executor (P0-2).
 *
 * WHAT THIS IS
 *   A `BranchExecutor` that runs a real model -> tool -> result loop inside the
 *   already-forked isolated branch the seam manager hands it. The branch arrives
 *   as an `IsolatedBranchContext` (branchId / sessionId / namespace / mounted
 *   surfaces / abort signal / patch); this module never forks a context itself,
 *   never mounts or disposes a surface, and never touches the orchestrator's
 *   scheduling. Branch lifecycle stays owned by
 *   `src/cordis-seams/seam-manager.ts`.
 *
 * CONTRACT ALIGNMENT (no new cross-module contracts are introduced)
 *   - implements `BranchExecutor`:
 *     `(context: IsolatedBranchContext) => Promise<ProbeExecutionResult>`.
 *   - every recorded step is a frozen `TrajectoryStep`, every tool failure a
 *     `ToolErrorRecord`, every failure a `FailureSignal` (src/types/contracts.ts).
 *   - the step log is assembled by the existing `TrajectoryCollector`, so the
 *     collector keeps owning step indexing, per-step timestamps, failure-signal
 *     de-duplication and `no_deliverable` derivation. Tool-error signals are not
 *     pushed twice: `deriveFailureSignals` already turns each `ToolErrorRecord`
 *     into a `tool_error` signal during finalize.
 *
 * BOUNDING (never hangs, never runs away)
 *   - `maxStepsPerProbe` caps loop iterations; one iteration is exactly one model
 *     decision. Reaching the cap without a final answer settles 'failed' with a
 *     'budget_exhausted' failure signal.
 *   - the caller's `AbortSignal` and an optional wall-clock budget both settle the
 *     probe. Cancellation and timeout are distinguished: cancellation settles
 *     status 'aborted' (and deliberately does NOT claim the 'timeout' signal
 *     kind), a real wall-clock overrun settles 'timeout'.
 *   - both are enforced *cooperatively and non-cooperatively*: the signal is
 *     relayed to the model/tool, and a `Promise.race` deadline settles the branch
 *     even when a model or a tool ignores the signal entirely. The losing promise
 *     is kept handled so a late rejection can never surface as an unhandled
 *     rejection.
 *
 * SESSION/EVENT COLLECTION
 *   every recorded step is additionally published to `onStep` as an
 *   `AgentStepEvent` on channel 'session/event', carrying the same stepIndex the
 *   collector assigned. A host event log can therefore reconstruct the exact
 *   trajectory this executor returns. A throwing sink is downgraded to a
 *   diagnostic and never breaks the probe.
 *
 * DEGRADATION (single_call)
 *   a host that injects a plain `IModelAdapter` (no `planNext`) or no tool runtime
 *   gets the single-call behaviour this executor always keeps available: one
 *   model call, one result step, identical status / deliverable / failure-signal
 *   semantics. The effective mode is recorded in the result metadata so a
 *   degraded probe is never mistaken for a multi-step one.
 *
 * MODEL PURPOSE
 *   every model call this executor makes is issued with `purpose: 'probe'`, so
 *   probe-branch traffic stays distinguishable from 'compose' judging in routing
 *   and usage statistics (see the `ModelPurpose` contract note).
 *
 * CONFIGURATION
 *   `maxStepsPerProbe` / `probeTimeoutMs` are injected, with an optional
 *   per-probe override on `IsolatedBranchContext.metadata`. This module does not
 *   read plugin config: `src/config.ts` is owned elsewhere and its `probe` group
 *   is deliberately not widened here.
 */

import { TrajectoryCollector, toTrajectoryError } from '../cordis-seams/trajectory-collector';
import type {
  BranchExecutor,
  EightSurfacePatch,
  FailureSignal,
  IModelAdapter,
  IsolatedBranchContext,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult,
  ProbeTrajectory,
  TokenUsage,
  ToolErrorRecord,
  ToolGuidanceExample,
  TrajectoryError,
  TrajectoryStatus,
  TrajectoryStep
} from '../types/contracts';

/** Default loop budget when the caller injects none. */
export const DEFAULT_MAX_STEPS_PER_PROBE = 4;

/** Which execution shape ran: the multi-step loop or the single-call fallback. */
export type AgentExecutionMode = 'agent_loop' | 'single_call';

// ---------------------------------------------------------------------------
// Guidance projection (surface 4 of the eight-surface patch)
// ---------------------------------------------------------------------------

/**
 * The branch patch's `tool_guidance` edit, projected into the shape a tool
 * runtime can observe. `source` says whether a patch actually supplied it, so a
 * test (or a reviewer) can tell a patched description from a built-in default.
 */
export interface AgentToolGuidanceView {
  readonly descriptions: Readonly<Record<string, string>>;
  readonly priorityOrder: readonly string[];
  readonly examples: readonly ToolGuidanceExample[];
  readonly source: 'branch_patch' | 'none';
}

/** Read the branch patch's tool_guidance surface without touching anything else. */
export function extractToolGuidance(patch: EightSurfacePatch): AgentToolGuidanceView {
  const edit = patch.edits.tool_guidance;
  if (edit === undefined) {
    return { descriptions: {}, priorityOrder: [], examples: [], source: 'none' };
  }
  return {
    descriptions: { ...edit.descriptions },
    priorityOrder: edit.priorityOrder === undefined ? [] : [...edit.priorityOrder],
    examples: edit.examples === undefined ? [] : [...edit.examples],
    source: 'branch_patch'
  };
}

// ---------------------------------------------------------------------------
// Model and tool boundaries (structural, so host-neutral fakes are trivial)
// ---------------------------------------------------------------------------

/** One transcript entry handed back to the planner on the next iteration. */
export interface AgentTranscriptEntry {
  readonly iteration: number;
  readonly kind: 'model' | 'tool' | 'result';
  readonly text?: string;
  readonly toolName?: string;
  readonly toolArguments?: unknown;
  readonly toolResult?: unknown;
  readonly isError?: boolean;
}

/** What the loop asks the model for on each iteration. */
export interface AgentPlanRequest {
  /** Always 'probe': probe-branch traffic must stay distinguishable from compose. */
  readonly purpose: 'probe';
  /** Collector-assigned index of the model step this decision belongs to. */
  readonly stepIndex: number;
  readonly iteration: number;
  readonly messages: readonly ModelMessage[];
  readonly transcript: readonly AgentTranscriptEntry[];
  readonly toolCatalog: readonly string[];
  readonly toolGuidance: AgentToolGuidanceView;
  readonly maxStepsPerProbe: number;
  /** Aborted on caller cancellation, wall-clock overrun, or relayed fault. */
  readonly signal: AbortSignal;
}

/** A decision to call one tool and continue the loop. */
export interface AgentToolDecision {
  readonly kind: 'tool';
  readonly toolName: string;
  readonly toolArguments?: unknown;
  /** Optional short narration recorded on the transcript for the next iteration. */
  readonly text?: string;
  readonly usage?: TokenUsage;
}

/** A decision to stop the loop with the probe's deliverable. */
export interface AgentFinalDecision {
  readonly kind: 'final';
  readonly text: string;
  readonly finishReason?: ModelResponse['finishReason'];
  readonly usage?: TokenUsage;
}

/** What the model decided to do next. */
export type AgentLoopDecision = AgentToolDecision | AgentFinalDecision;

/**
 * Model boundary for the loop.
 *
 * Both members are optional so a host can supply whichever it really has:
 *   - `planNext` + a tool runtime  -> the multi-step `agent_loop`;
 *   - `complete` only              -> the `single_call` degradation path;
 *   - both                         -> the loop, which needs no plain completion.
 *
 * A plain `IModelAdapter` (only `complete`) is therefore structurally assignable,
 * which is exactly what keeps existing hosts working unchanged.
 */
export interface AgentLoopModel {
  complete?(request: ModelRequest): Promise<ModelResponse>;
  planNext?(request: AgentPlanRequest): Promise<AgentLoopDecision>;
}

/** One tool invocation the loop is about to make. */
export interface AgentToolCallRequest {
  readonly toolName: string;
  readonly toolArguments: unknown;
  /** Collector-assigned index of the 'tool' step for this call. */
  readonly stepIndex: number;
  readonly iteration: number;
  readonly signal: AbortSignal;
  /** The branch patch's projected guidance, visible to the tool. */
  readonly guidance: AgentToolGuidanceView;
}

/** What one tool invocation observed and produced. */
export interface AgentToolCallOutcome {
  readonly result?: unknown;
  readonly text?: string;
  readonly isError?: boolean;
  readonly error?: unknown;
  /**
   * The guidance the tool actually observed. Reporting it back is the observable
   * proof that the branch's tool_guidance patch reached the tool call.
   */
  readonly guidanceApplied?: AgentToolGuidanceView;
}

/** Tool boundary: enumerate, then execute under the branch's signal. */
export interface AgentToolRuntime {
  listTools(): readonly string[];
  execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome>;
}

// ---------------------------------------------------------------------------
// session/event step records
// ---------------------------------------------------------------------------

/** Shape of one published step event. */
export type AgentStepEventKind = 'model' | 'tool' | 'result' | 'error';

/**
 * One step of the probe, published on channel 'session/event'. `stepIndex` is the
 * index the `TrajectoryCollector` assigned, so events and the returned trajectory
 * describe the same ordered log.
 */
export interface AgentStepEvent {
  readonly channel: 'session/event';
  readonly kind: AgentStepEventKind;
  readonly stepIndex: number;
  readonly iteration: number;
  readonly at: number;
  readonly sessionId: string;
  readonly branchId: string;
  readonly namespace: string;
  readonly mode: AgentExecutionMode;
  readonly toolName?: string;
  readonly toolArguments?: unknown;
  readonly toolResult?: unknown;
  readonly text?: string;
  readonly error?: TrajectoryError;
  readonly durationMs?: number;
  readonly guidance?: AgentToolGuidanceView;
}

// ---------------------------------------------------------------------------
// Executor wiring
// ---------------------------------------------------------------------------

/** Everything a multi-step agent probe needs, all injectable and all optional. */
export interface AgentLoopAdapters {
  /** Model boundary; a plain `IModelAdapter` selects the single_call fallback. */
  readonly model?: AgentLoopModel;
  /** Tool runtime; absent means the agent loop cannot run and single_call is used. */
  readonly tools?: AgentToolRuntime;
  /** Loop budget; defaults to DEFAULT_MAX_STEPS_PER_PROBE. */
  readonly maxStepsPerProbe?: number;
  /** Wall-clock budget for the whole probe; 0 or undefined disables the timer. */
  readonly probeTimeoutMs?: number;
  /** Turn a branch context into the probe's message list. */
  readonly buildMessages?: (context: IsolatedBranchContext) => readonly ModelMessage[];
  /** Extra system prompt prepended to the built messages. */
  readonly systemPrompt?: (context: IsolatedBranchContext) => string;
  /** session/event sink; receives one event per recorded step, in order. */
  readonly onStep?: (event: AgentStepEvent) => void;
  /** Non-fatal observations; never throws into the probe. */
  readonly onDiagnostic?: (message: string) => void;
  /** Trajectory id factory; injectable so tests are deterministic. */
  readonly createTrajectoryId?: () => string;
}

/** Executor plus the recorded identity of what it can do. */
export interface AgentLoopExecutor {
  readonly runBranch: BranchExecutor;
  readonly describe: () => readonly string[];
}

/** Default probe prompt: a branch-context header plus the task prompt. */
export function defaultAgentProbeMessages(
  context: IsolatedBranchContext
): readonly ModelMessage[] {
  const surfaces = context.mountedSurfaces.join(', ');
  const heading = [
    'You are a probe agent running inside an isolated evolution branch.',
    'session: ' + context.sessionId,
    'branch: ' + context.branchId,
    'namespace: ' + context.namespace,
    'mounted surfaces: ' + (surfaces.length === 0 ? '(none)' : surfaces),
    'patch: ' + context.patch.id + ' (' + context.patch.origin + '/' + context.patch.purpose + ')',
    'rationale: ' + context.patch.rationale
  ].join('\n');
  return [
    { role: 'system', content: heading },
    { role: 'user', content: context.task.prompt }
  ];
}

/** Human-readable message for an unknown thrown value. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return toTrajectoryError(error).message;
}

/** A tagged error name, so a trajectory error keeps its provenance. */
function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Normalize a thrown value into a TrajectoryError.
 *
 * A value that is already shaped like one is preserved verbatim: routing it
 * through `toTrajectoryError` again would flatten its `name` to 'Error' and lose
 * the provenance the failure taxonomy keys on.
 */
function normalizeTrajectoryError(error: unknown): TrajectoryError {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { name?: unknown }).name === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return error as TrajectoryError;
  }
  return toTrajectoryError(error);
}

/** Narrow a value to a positive integer. */
function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Sum two optional usage records; either may be absent. */
function addUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (next === undefined) {
    return current;
  }
  if (current === undefined) {
    return next;
  }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens
  };
}

/** Validate a model decision instead of trusting an injected planner. */
function assertDecision(decision: unknown): AgentLoopDecision {
  if (typeof decision !== 'object' || decision === null) {
    throw new Error('the agent planner must resolve to a decision object');
  }
  const kind = (decision as { kind?: unknown }).kind;
  if (kind === 'final') {
    const text = (decision as { text?: unknown }).text;
    if (typeof text !== 'string') {
      throw new Error('a "final" agent decision requires string text');
    }
    return decision as AgentFinalDecision;
  }
  if (kind === 'tool') {
    const toolName = (decision as { toolName?: unknown }).toolName;
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new Error('a "tool" agent decision requires a non-empty toolName');
    }
    return decision as AgentToolDecision;
  }
  throw new Error('an agent decision kind must be "tool" or "final"');
}

/** Project a finalized trajectory into the executor's frozen result shape. */
function toProbeExecutionResult(
  trajectory: ProbeTrajectory,
  metadata: Readonly<Record<string, unknown>>
): ProbeExecutionResult {
  return {
    status: trajectory.status,
    steps: trajectory.steps,
    toolErrors: trajectory.toolErrors,
    failureSignals: trajectory.failureSignals,
    ...(trajectory.deliverable === undefined ? {} : { deliverable: trajectory.deliverable }),
    ...(trajectory.error === undefined ? {} : { error: trajectory.error }),
    metadata: {
      ...metadata,
      ...(trajectory.metadata === undefined ? {} : { trajectory: trajectory.metadata })
    }
  };
}

/**
 * Build the multi-step agent probe executor.
 *
 * `now` is injectable so unit and end-to-end tests stay deterministic.
 */
export function createAgentLoopExecutor(
  adapters: AgentLoopAdapters = {},
  now: () => number = () => Date.now()
): AgentLoopExecutor {
  const configuredMaxSteps = adapters.maxStepsPerProbe;
  if (configuredMaxSteps !== undefined && readPositiveInteger(configuredMaxSteps) === undefined) {
    throw new Error('maxStepsPerProbe must be a positive integer, received ' + String(configuredMaxSteps));
  }
  const defaultMaxSteps = configuredMaxSteps ?? DEFAULT_MAX_STEPS_PER_PROBE;
  const configuredBudget = adapters.probeTimeoutMs;
  if (configuredBudget !== undefined && !(typeof configuredBudget === 'number' && Number.isFinite(configuredBudget) && configuredBudget >= 0)) {
    throw new Error('probeTimeoutMs must be a finite non-negative number, received ' + String(configuredBudget));
  }
  const defaultBudget = configuredBudget ?? 0;
  const createTrajectoryId = adapters.createTrajectoryId ?? ((): string => 'agent-traj-' + String(now()));

  /** Per-probe max steps: context metadata wins, then the adapter default. */
  const resolveMaxSteps = (context: IsolatedBranchContext): number =>
    readPositiveInteger(context.metadata?.maxStepsPerProbe) ?? defaultMaxSteps;

  /** Per-probe wall-clock budget: context metadata wins, then the adapter default. */
  const resolveBudget = (context: IsolatedBranchContext): number =>
    readPositiveInteger(context.metadata?.probeTimeoutMs) ?? defaultBudget;

  const runBranch: BranchExecutor = async (
    context: IsolatedBranchContext
  ): Promise<ProbeExecutionResult> => {
    const model = adapters.model;
    const tools = adapters.tools;
    const maxSteps = resolveMaxSteps(context);
    const budget = resolveBudget(context);
    const guidance = extractToolGuidance(context.patch);
    const canLoop = model !== undefined && typeof model.planNext === 'function' && tools !== undefined;
    const mode: AgentExecutionMode = canLoop ? 'agent_loop' : 'single_call';
    const report = adapters.onDiagnostic;

    const collector = new TrajectoryCollector({
      id: createTrajectoryId(),
      sessionId: context.sessionId,
      branchId: context.branchId,
      branchNamespace: context.namespace,
      role: 'candidate',
      patch: context.patch,
      surfaceKeys: context.mountedSurfaces,
      now
    });

    const diagnostic = (message: string): void => {
      collector.recordDiagnostic(message);
      report?.(message);
    };

    // ---- session/event collection -----------------------------------------
    const emit = (
      fields: Omit<
        AgentStepEvent,
        'channel' | 'sessionId' | 'branchId' | 'namespace' | 'mode'
      >
    ): void => {
      const sink = adapters.onStep;
      if (sink === undefined) {
        return;
      }
      try {
        sink({
          channel: 'session/event',
          sessionId: context.sessionId,
          branchId: context.branchId,
          namespace: context.namespace,
          mode,
          ...fields
        });
      } catch (error) {
        collector.recordDiagnostic('session/event step sink threw: ' + errorMessageOf(error));
      }
    };

    // ---- run state --------------------------------------------------------
    const usage: { current: TokenUsage | undefined } = { current: undefined };
    let deliverableText: string | undefined;

    const settle = (status: TrajectoryStatus, error?: unknown): ProbeExecutionResult => {
      if (error !== undefined) {
        // The collector stores what `toTrajectoryError` derives, which prefers an
        // Error's own `name`; a plain {name,message} bag would flatten to 'Error'.
        const normalized = normalizeTrajectoryError(error);
        const carried = namedError(normalized.name, normalized.message);
        collector.recordError(carried);
      }
      const trajectory = collector.finalize({
        status,
        result: {
          ...(deliverableText === undefined
            ? {}
            : { deliverable: { content: deliverableText, format: 'markdown' as const, producedFiles: [] } }),
          ...(usage.current === undefined ? {} : { usage: usage.current })
        }
      });
      return toProbeExecutionResult(trajectory, {
        mode,
        maxStepsPerProbe: maxSteps,
        probeTimeoutMs: budget,
        branchId: context.branchId,
        namespace: context.namespace
      });
    };

    // ---- tool catalog -----------------------------------------------------
    let catalog: readonly string[] = [];
    if (tools !== undefined) {
      try {
        catalog = [...tools.listTools()];
        diagnostic('agent tool catalog: ' + (catalog.length === 0 ? '(empty)' : catalog.join(', ')));
      } catch (error) {
        diagnostic('the tool catalog could not be listed: ' + errorMessageOf(error));
      }
    }
    if (mode === 'single_call') {
      diagnostic(
        tools === undefined
          ? 'no tool runtime was injected, so the probe degrades to a single model call'
          : model === undefined
            ? 'no model was injected, so the probe cannot run'
            : 'the injected model exposes no planNext(), so the probe degrades to a single model call'
      );
    }

    // ---- pre-dispatch guards ---------------------------------------------
    if (context.signal.aborted) {
      diagnostic('the probe branch was already aborted before dispatch');
      collector.appendStep({ kind: 'system', text: 'probe cancelled before dispatch' });
      collector.recordFailureSignal({
        kind: 'unknown',
        message: 'the probe branch was aborted before dispatch',
        repairable: false
      });
      return settle('aborted');
    }
    if (model === undefined) {
      const message =
        'no model adapter is available to this probe; inject AgentLoopAdapters.model (or an IModelAdapter) '
        + 'so the probe can produce a deliverable';
      collector.appendStep({ kind: 'error', text: message });
      collector.recordFailureSignal({ kind: 'unknown', message, repairable: false });
      return settle('failed', { name: 'EvoHarnessAgentLoopError', message });
    }
    // A planner without a tool runtime cannot loop, and without complete() it cannot
    // fall back either: refuse before spending a step instead of crashing mid-run.
    if (mode === 'single_call' && typeof model.complete !== 'function') {
      const message =
        'the injected model exposes no complete(), so the single_call fallback cannot run; inject a model with '
        + 'complete(), or supply a tool runtime so the multi-step loop is available';
      collector.appendStep({ kind: 'error', text: message });
      collector.recordFailureSignal({ kind: 'unknown', message, repairable: false });
      return settle('failed', { name: 'EvoHarnessAgentLoopError', message });
    }

    const messages: readonly ModelMessage[] = (() => {
      const built = (adapters.buildMessages ?? defaultAgentProbeMessages)(context);
      const systemPrompt = adapters.systemPrompt?.(context);
      return systemPrompt === undefined
        ? built
        : [{ role: 'system' as const, content: systemPrompt }, ...built];
    })();

    // ---- cooperative + hard cancellation ---------------------------------
    let timedOut = false;
    let cancelled = false;
    let rejectDeadline: ((error: unknown) => void) | undefined;
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    // The race's losing branch is a rejection nobody awaits once the call wins;
    // mark it handled so Node never reports it as an unhandled rejection.
    deadlinePromise.catch(() => undefined);

    const controller = new AbortController();
    const relayAbort = (): void => {
      cancelled = true;
      controller.abort(context.signal.reason);
      // Settle the race: a model or tool that ignores the signal must not hang.
      rejectDeadline?.(
        context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error('the probe branch was aborted by its caller')
      );
    };
    context.signal.addEventListener('abort', relayAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    if (budget > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new Error('probe timeout after ' + String(budget) + 'ms');
        controller.abort(error);
        rejectDeadline?.(error);
      }, budget);
    }

    /** Race one injected call against the deadline, keeping the loser handled. */
    const guarded = <T>(call: Promise<T>): Promise<T> => {
      call.catch(() => undefined);
      return Promise.race([call, deadlinePromise]);
    };

    /** Record why an interrupted probe stopped, distinguishing abort from overrun. */
    const settleInterrupted = (): ProbeExecutionResult | undefined => {
      if (timedOut) {
        collector.recordFailureSignal({
          kind: 'timeout',
          message: 'the probe exceeded its wall-clock budget',
          repairable: true
        });
        collector.appendStep({ kind: 'system', text: 'probe deadline elapsed' });
        return settle('timeout');
      }
      if (cancelled) {
        collector.recordFailureSignal({
          kind: 'unknown',
          message: 'the probe branch was aborted by its caller',
          repairable: true
        });
        collector.appendStep({ kind: 'system', text: 'probe aborted by caller' });
        return settle('aborted');
      }
      return undefined;
    };

    // Bind the completion entry once: a narrowed optional method cannot be called
    // from inside the closure below.
    const completeFn = typeof model.complete === 'function' ? model.complete.bind(model) : undefined;

    try {
      // -------------------------------------------------------------------
      // single_call: one model call, one result step
      // -------------------------------------------------------------------
      const runSingleCall = async (): Promise<ProbeExecutionResult> => {
        if (completeFn === undefined) {
          throw namedError('EvoHarnessAgentLoopError', 'the single_call fallback requires a complete() model');
        }
        const modelStep = collector.appendStep({
          kind: 'model',
          text: 'single-call model request sent',
          metadata: { purpose: 'probe', mode, iteration: 0 }
        });
        emit({ kind: 'model', stepIndex: modelStep.index, iteration: 0, at: modelStep.at, text: modelStep.text });

        const startedAt = now();
        const response = await guarded(completeFn({ purpose: 'probe', messages }));
        const durationMs = Math.max(0, now() - startedAt);
        usage.current = addUsage(usage.current, response.usage);

        const interrupted = settleInterrupted();
        if (interrupted !== undefined) {
          return interrupted;
        }

        deliverableText = response.text;
        const resultStep = collector.appendStep({
          kind: 'result',
          text: response.text,
          durationMs,
          metadata: {
            mode,
            purpose: 'probe',
            iteration: 0,
            ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
            ...(response.model === undefined ? {} : { model: response.model })
          }
        });
        emit({
          kind: 'result',
          stepIndex: resultStep.index,
          iteration: 0,
          at: resultStep.at,
          text: response.text,
          durationMs
        });

        if (response.finishReason === 'error') {
          const message = 'the model call finished with an error reason';
          collector.recordFailureSignal({ kind: 'model_refusal', message, repairable: true });
          return settle('failed', { name: 'EvoHarnessAgentModelError', message });
        }
        if (response.text.trim().length === 0) {
          const message = 'the model returned no visible text';
          collector.recordFailureSignal({ kind: 'model_refusal', message, repairable: true });
          return settle('failed', { name: 'EvoHarnessAgentModelError', message });
        }
        if (response.finishReason === 'length') {
          collector.recordFailureSignal({
            kind: 'budget_exhausted',
            message: 'the model stopped because it hit the token budget',
            repairable: true
          });
        }
        return settle('succeeded');
      };

      // -------------------------------------------------------------------
      // agent_loop: model -> tool -> result, bounded by maxStepsPerProbe
      // -------------------------------------------------------------------
      const runAgentLoop = async (planNext: NonNullable<AgentLoopModel['planNext']>, runtime: AgentToolRuntime): Promise<ProbeExecutionResult> => {
        const transcript: AgentTranscriptEntry[] = [];

        for (let iteration = 0; iteration < maxSteps; iteration += 1) {
          const interruptedBefore = settleInterrupted();
          if (interruptedBefore !== undefined) {
            return interruptedBefore;
          }

          // ---- 1. model decision -----------------------------------------
          const modelStep = collector.appendStep({
            kind: 'model',
            text: 'agent-loop model decision requested',
            metadata: {
              purpose: 'probe',
              mode,
              iteration,
              maxStepsPerProbe: maxSteps
            }
          });
          emit({
            kind: 'model',
            stepIndex: modelStep.index,
            iteration,
            at: modelStep.at,
            text: modelStep.text
          });

          const modelStartedAt = now();
          const rawDecision = await guarded(
            planNext({
              purpose: 'probe',
              stepIndex: modelStep.index,
              iteration,
              messages,
              transcript,
              toolCatalog: catalog,
              toolGuidance: guidance,
              maxStepsPerProbe: maxSteps,
              signal: controller.signal
            })
          );
          const modelDurationMs = Math.max(0, now() - modelStartedAt);

          const interruptedAfterModel = settleInterrupted();
          if (interruptedAfterModel !== undefined) {
            return interruptedAfterModel;
          }

          const decision = assertDecision(rawDecision);
          usage.current = addUsage(usage.current, decision.usage);

          if (decision.kind === 'final') {
            deliverableText = decision.text;
            const resultStep = collector.appendStep({
              kind: 'result',
              text: decision.text,
              durationMs: modelDurationMs,
              metadata: {
                mode,
                purpose: 'probe',
                iteration,
                decision: 'final',
                ...(decision.finishReason === undefined ? {} : { finishReason: decision.finishReason })
              }
            });
            emit({
              kind: 'result',
              stepIndex: resultStep.index,
              iteration,
              at: resultStep.at,
              text: decision.text,
              durationMs: modelDurationMs
            });

            if (decision.finishReason === 'error') {
              const message = 'the agent planner finished with an error reason';
              collector.recordFailureSignal({ kind: 'model_refusal', message, repairable: true });
              return settle('failed', { name: 'EvoHarnessAgentModelError', message });
            }
            if (decision.text.trim().length === 0) {
              const message = 'the agent planner produced an empty final answer';
              collector.recordFailureSignal({ kind: 'model_refusal', message, repairable: true });
              return settle('failed', { name: 'EvoHarnessAgentModelError', message });
            }
            if (decision.finishReason === 'length') {
              collector.recordFailureSignal({
                kind: 'budget_exhausted',
                message: 'the agent planner stopped because it hit the token budget',
                repairable: true
              });
            }
            return settle('succeeded');
          }

          transcript.push({
            iteration,
            kind: 'model',
            ...(decision.text === undefined ? {} : { text: decision.text }),
            toolName: decision.toolName
          });

          // ---- 2. tool call ----------------------------------------------
          const toolStep = collector.appendStep({
            kind: 'tool',
            toolName: decision.toolName,
            toolArguments: decision.toolArguments ?? null,
            metadata: { mode, iteration, stepIndex: modelStep.index }
          });
          emit({
            kind: 'tool',
            stepIndex: toolStep.index,
            iteration,
            at: toolStep.at,
            toolName: decision.toolName,
            toolArguments: decision.toolArguments ?? null
          });

          const toolStartedAt = now();
          let outcome: AgentToolCallOutcome;
          try {
            outcome = await guarded(
              runtime.execute({
                toolName: decision.toolName,
                toolArguments: decision.toolArguments ?? null,
                stepIndex: toolStep.index,
                iteration,
                signal: controller.signal,
                guidance
              })
            );
          } catch (error) {
            const interruptedTool = settleInterrupted();
            if (interruptedTool !== undefined) {
              return interruptedTool;
            }
            const trajectoryError = toTrajectoryError(error);
            const toolDurationMs = Math.max(0, now() - toolStartedAt);
            const errorStep = collector.appendStep({
              kind: 'error',
              text: trajectoryError.message,
              durationMs: toolDurationMs,
              error: trajectoryError,
              metadata: { mode, iteration, toolName: decision.toolName }
            });
            emit({
              kind: 'error',
              stepIndex: errorStep.index,
              iteration,
              at: errorStep.at,
              toolName: decision.toolName,
              text: trajectoryError.message,
              error: trajectoryError,
              durationMs: toolDurationMs
            });
            // The ToolErrorRecord becomes a 'tool_error' failure signal during
            // finalize; pushing one here as well would double-count it.
            collector.recordToolError({
              toolName: decision.toolName,
              message: trajectoryError.message,
              ...(trajectoryError.code === undefined ? {} : { code: trajectoryError.code }),
              retryable: true,
              stepIndex: toolStep.index,
              ...(trajectoryError.stack === undefined ? {} : { stack: trajectoryError.stack })
            });
            transcript.push({
              iteration,
              kind: 'result',
              toolName: decision.toolName,
              isError: true,
              text: trajectoryError.message
            });
            continue;
          }

          const interruptedAfterTool = settleInterrupted();
          if (interruptedAfterTool !== undefined) {
            return interruptedAfterTool;
          }

          const toolDurationMs = Math.max(0, now() - toolStartedAt);
          const isError = outcome.isError === true || outcome.error !== undefined;
          const observedGuidance = outcome.guidanceApplied ?? guidance;
          const toolResult = outcome.result ?? outcome.text ?? null;

          // ---- 3. tool result --------------------------------------------
          const resultStep = collector.appendStep({
            kind: 'result',
            toolName: decision.toolName,
            toolResult,
            ...(outcome.text === undefined ? {} : { text: outcome.text }),
            durationMs: toolDurationMs,
            metadata: {
              mode,
              iteration,
              isError,
              guidanceApplied: observedGuidance,
              guidanceSource: observedGuidance.source
            }
          });
          emit({
            kind: 'result',
            stepIndex: resultStep.index,
            iteration,
            at: resultStep.at,
            toolName: decision.toolName,
            toolResult,
            ...(outcome.text === undefined ? {} : { text: outcome.text }),
            durationMs: toolDurationMs,
            guidance: observedGuidance
          });

          if (isError) {
            const message =
              outcome.error === undefined
                ? 'tool "' + decision.toolName + '" reported an error'
                : errorMessageOf(outcome.error);
            collector.recordToolError({
              toolName: decision.toolName,
              message,
              ...(outcome.error === undefined ? {} : { code: 'tool_error' }),
              retryable: true,
              stepIndex: toolStep.index
            });
          }

          transcript.push({
            iteration,
            kind: 'result',
            toolName: decision.toolName,
            toolResult,
            isError
          });
        }

        // ---- loop budget exhausted ----------------------------------------
        const message =
          'the agent loop reached maxStepsPerProbe (' + String(maxSteps) + ') without a final answer';
        collector.recordFailureSignal({ kind: 'budget_exhausted', message, repairable: true });
        collector.appendStep({
          kind: 'system',
          text: message,
          metadata: { mode, maxStepsPerProbe: maxSteps }
        });
        return settle('failed', { name: 'EvoHarnessAgentLoopError', message });
      };

      if (mode === 'agent_loop' && tools !== undefined && typeof model.planNext === 'function') {
        return await runAgentLoop(model.planNext.bind(model), tools);
      }
      return await runSingleCall();
    } catch (error) {
      // A planner or tool that threw outside its own catch block still yields a
      // trajectory: the seam manager must never receive a rejection.
      const interrupted = settleInterrupted();
      if (interrupted !== undefined) {
        return interrupted;
      }
      const trajectoryError = normalizeTrajectoryError(error);
      collector.appendStep({
        kind: 'error',
        text: trajectoryError.message,
        error: trajectoryError,
        metadata: { mode }
      });
      collector.recordFailureSignal({
        kind: 'unknown',
        message: 'the agent probe failed: ' + trajectoryError.message,
        ...(trajectoryError.code === undefined ? {} : { code: trajectoryError.code }),
        repairable: true
      });
      return settle('failed', trajectoryError);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      context.signal.removeEventListener('abort', relayAbort);
    }
  };

  const capabilities: string[] = [
    'execution: agent loop (model -> tool -> result) inside the branch the seam manager already forked',
    'max steps per probe: ' + String(defaultMaxSteps),
    'bounding: caller AbortSignal + ' + (defaultBudget > 0 ? String(defaultBudget) + 'ms wall-clock budget' : 'no wall-clock budget'),
    'session/event step collection: ' + (adapters.onStep === undefined ? 'no sink attached' : 'sink attached'),
    adapters.tools === undefined
      ? 'no tool runtime: every probe degrades to a single model call'
      : 'tool runtime: ' + String(adapters.tools.listTools().length) + ' tool(s)'
  ];
  capabilities.push(
    adapters.model === undefined
      ? 'no model adapter: every probe is recorded as a failed trajectory'
      : typeof adapters.model.planNext === 'function'
        ? 'model exposes planNext(): the multi-step loop is available'
        : 'model exposes no planNext(): every probe degrades to a single model call'
  );

  return { runBranch, describe: () => [...capabilities] };
}

/**
 * Narrowing helper for hosts that hold a plain `IModelAdapter`: it is structurally
 * accepted by `AgentLoopModel` and therefore selects the single_call fallback.
 */
export function asAgentLoopModel(model: IModelAdapter): AgentLoopModel {
  return model;
}

/** Re-exported so a caller can type a failure signal without a second import. */
export type { FailureSignal, ToolErrorRecord, TrajectoryStep };