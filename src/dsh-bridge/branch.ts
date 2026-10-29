/**
 * Same-process BranchExecutor: runs one probe inside the live plugin context.
 *
 * USER DECISION (recorded): probe branches execute IN PROCESS, with no
 * filesystem sandbox and no forked Cordis context. The eight-surface seam
 * manager already mounts and disposes every reversible surface per branch; the
 * executor's job is to drive the probe task through the model adapter, record an
 * event-sourced TrajectoryStep log, and return a ProbeExecutionResult the
 * composer, failure taxonomy, and surrogate scorer can consume deterministically.
 *
 * WHY THIS IS THE DEFAULT (not a placeholder): the plugin's contract
 * (src/types/contracts.ts, IsolatedBranchContext) hands the executor a signal, a
 * task, a patch and a namespace, and expects back status/steps/deliverable/
 * toolErrors/usage/failureSignals/error. Nothing in the contract requires a
 * sandbox, and the sandbox acquisition seam in src/index.ts is best-effort and
 * reports seam_unavailable when the host exposes none. A same-process executor
 * therefore satisfies the contract on every host, including the deterministic
 * in-memory host the test suite uses.
 *
 * FAILURE SEMANTICS
 *  - A model adapter that throws is recorded as an error step + failure signal +
 *    structured error, never as an unhandled rejection: the seam manager must
 *    always receive a trajectory.
 *  - Cancellation (context.signal) and the optional wall-clock budget are
 *    cooperative; both are re-read after the model call settles, so a raced
 *    abort or timeout is still reported instead of a false success.
 *  - A succeeded probe with no deliverable text still emits a 'no_deliverable'
 *    failure signal, because the failure taxonomy keys on that signal rather
 *    than on an empty string.
 */

import type {
  FailureSignal,
  HarnessComponentKey,
  IModelAdapter,
  IsolatedBranchContext,
  ModelMessage,
  ProbeExecutionResult,
  TokenUsage,
  ToolErrorRecord,
  TrajectoryError,
  TrajectoryStatus,
  TrajectoryStep
} from '../types/contracts';
import type { DshModelRoute } from './model';
// P3-B: every probe branch model call goes through the unified metered boundary.
import {
  createMeteredModelAdapter,
  type MeteredModelOptions
} from './metered-model-adapter';

/** Where the probe's prompt text comes from. */
export type BranchPromptSource = (context: IsolatedBranchContext) => readonly ModelMessage[];

/** Structural view of the memory bridge the executor may consult while probing. */
export interface BranchMemoryLike {
  recall?(query: unknown): Promise<unknown>;
}

/** Collaborators a same-process branch run may use. */
export interface BranchAdapters {
  /** Model adapter; absent means the probe cannot produce a deliverable. */
  readonly model?: IModelAdapter;
  /** Resolved route, recorded on the trajectory metadata for reproducibility. */
  readonly route?: DshModelRoute;
  /** MCP clients reachable from inside the probe (recorded, never auto-called). */
  readonly clients?: readonly { readonly serverId: string }[];
  /** Memory bridge used for branch-scoped recall, when available. */
  readonly memory?: BranchMemoryLike;
  /** Pure system-prompt builder; receives the branch context. */
  readonly systemPrompt?: (context: IsolatedBranchContext) => string;
  /** Turn a branch context into the probe's message list. */
  readonly buildMessages?: BranchPromptSource;
  /** Hard wall-clock budget for one probe; 0 or undefined disables the timer. */
  readonly probeTimeoutMs?: number;
  /** Receiver for non-fatal observations; never throws into the run. */
  readonly onDiagnostic?: (message: string) => void;
  /** P3-B metering wiring (ledger/registry); absent records calls without cost. */
  readonly metering?: MeteredModelOptions;
}

/** Executor plus the recorded identity of what it can do. */
export interface DshBranchExecutor {
  readonly runBranch: (context: IsolatedBranchContext) => Promise<ProbeExecutionResult>;
  readonly describe: () => readonly string[];
}

/** Human-readable message for an unknown thrown value. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Convert a thrown value into the frozen TrajectoryError shape. */
export function toTrajectoryError(error: unknown): TrajectoryError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' && code.length > 0 ? { code } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {})
    };
  }
  return { name: 'EvoHarnessBranchError', message: errorMessageOf(error) };
}

/** Default probe prompt: a branch-context header plus the task prompt. */
export function defaultBranchMessages(context: IsolatedBranchContext): readonly ModelMessage[] {
  const surfaces = context.mountedSurfaces.join(', ');
  const heading = [
    'You are a probe run inside an isolated evolution branch.',
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

/** Event-sourced recorder: steps are appended in the order they happen. */
class BranchRecorder {
  private readonly steps: TrajectoryStep[] = [];
  private readonly toolErrors: ToolErrorRecord[] = [];
  private readonly signals: FailureSignal[] = [];
  private deliverableText: string | undefined = undefined;
  private usage: TokenUsage | undefined = undefined;
  private status: TrajectoryStatus | undefined = undefined;
  private error: TrajectoryError | undefined = undefined;
  private stepCounter = 0;

  constructor(
    private readonly now: () => number,
    private readonly mountedSurfaces: readonly HarnessComponentKey[]
  ) {}

  /** Append one step and return its recorded index. */
  push(kind: TrajectoryStep['kind'], fields: Omit<TrajectoryStep, 'index' | 'at' | 'kind'> = {}): number {
    const index = this.stepCounter;
    this.stepCounter += 1;
    this.steps.push({
      index,
      at: this.now(),
      kind,
      ...fields,
      metadata: {
        ...(fields.metadata ?? {}),
        ...(this.mountedSurfaces.length === 0 ? {} : { mountedSurfaces: [...this.mountedSurfaces] })
      }
    });
    return index;
  }

  /** Record a failure signal (deduplicated by kind + message). */
  fail(kind: FailureSignal['kind'], message: string, extra: Partial<FailureSignal> = {}): void {
    if (this.signals.some((signal) => signal.kind === kind && signal.message === message)) {
      return;
    }
    this.signals.push({ kind, message, ...extra });
  }

  /** Record a structured tool error beside its failure signal. */
  recordToolError(error: ToolErrorRecord): void {
    this.toolErrors.push({ ...error, at: error.at ?? this.now() });
  }

  setDeliverable(text: string): void {
    this.deliverableText = text;
  }

  setUsage(usage: TokenUsage | undefined): void {
    if (usage !== undefined) {
      this.usage = usage;
    }
  }

  settle(status: TrajectoryStatus, error?: TrajectoryError): void {
    this.status = status;
    if (error !== undefined) {
      this.error = error;
    }
  }

  stepCount(): number {
    return this.stepCounter;
  }

  snapshot(): ProbeExecutionResult {
    const text = this.deliverableText ?? '';
    if (this.status !== 'failed' && text.trim().length === 0) {
      this.fail('no_deliverable', 'the probe produced no deliverable text', { repairable: true });
    }
    const status: TrajectoryStatus = this.status ?? (text.trim().length === 0 ? 'failed' : 'succeeded');
    return {
      status,
      steps: [...this.steps],
      deliverable: { content: text, format: 'markdown', producedFiles: [] },
      toolErrors: [...this.toolErrors],
      failureSignals: [...this.signals],
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.error === undefined ? {} : { error: this.error }),
      metadata: { stepCount: this.stepCounter, sameProcess: true }
    };
  }
}

/**
 * Build the same-process BranchExecutor.
 *
 * `now` is injectable so unit and end-to-end tests stay deterministic.
 */
export function createBranchExecutor(
  _ctx: unknown,
  adapters: BranchAdapters = {},
  now: () => number = () => Date.now()
): DshBranchExecutor {
  const capabilities: string[] = [];
  capabilities.push(
    adapters.model === undefined
      ? 'no model adapter: every probe will be recorded as a failed trajectory'
      : 'model adapter: ' + (adapters.route?.provider ?? 'unknown') + '/' + (adapters.route?.model ?? 'unknown')
  );
  capabilities.push('execution: same-process (no filesystem sandbox, no forked Cordis context)');
  if (adapters.clients !== undefined) {
    capabilities.push(
      'mcp clients: ' +
        (adapters.clients.length === 0 ? '(none)' : adapters.clients.map((client) => client.serverId).join(', '))
    );
  }
  if (adapters.memory === undefined) {
    capabilities.push('memory bridge unavailable: branch-scoped recall is skipped');
  }
  const meteredModel =
    adapters.model === undefined
      ? undefined
      : createMeteredModelAdapter(adapters.model, 'probe', adapters.metering);
  capabilities.push('metering: ' + (meteredModel?.metering ?? 'unmetered'));

  const runBranch = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const recorder = new BranchRecorder(now, context.mountedSurfaces);
    const report = adapters.onDiagnostic;

    if (context.signal.aborted) {
      recorder.push('system', { text: 'probe cancelled before dispatch' });
      recorder.fail('timeout', 'the probe branch was aborted before dispatch', { repairable: true });
      recorder.settle('aborted');
      return recorder.snapshot();
    }

    const builder = adapters.buildMessages ?? defaultBranchMessages;
    const baseMessages = builder(context);
    const systemPrompt = adapters.systemPrompt?.(context);
    const messages =
      systemPrompt === undefined ? baseMessages : [{ role: 'system' as const, content: systemPrompt }, ...baseMessages];

    recorder.push('message', {
      text: 'probe dispatched with ' + String(messages.length) + ' message(s)',
      metadata: {
        taskId: context.task.id,
        patchId: context.patch.id,
        ...(context.task.taskSignature === undefined ? {} : { taskSignature: context.task.taskSignature })
      }
    });

    const model = meteredModel;
    if (model === undefined) {
      const message =
        'no model adapter is available to this probe; inject options.model, or mount @deepseek-ai/dsh-llm '
        + 'together with a provider adapter';
      recorder.push('error', { text: message });
      recorder.fail('unknown', message, { repairable: false });
      recorder.settle('failed', { name: 'EvoHarnessBranchError', message });
      return recorder.snapshot();
    }

    const startedAt = now();
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let rejectDeadline: ((error: Error) => void) | undefined = undefined;
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    // The race's losing branch is a rejection that nobody awaits once the model
    // call wins; mark it handled so Node never reports it as unhandled.
    deadlinePromise.catch(() => undefined);
    // Two independent cancellation sources: a cooperative AbortSignal handed to
    // an adapter that honours it, and a hard Promise.race deadline that settles
    // the probe even when the adapter ignores the signal. Without the race a
    // non-cooperative adapter would hang the branch forever.
    const controller = new AbortController();
    const relayAbort = (): void => {
      cancelled = true;
      controller.abort(context.signal.reason);
      // Settle the race: an adapter ignoring the signal must still not hang.
      rejectDeadline?.(
        context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error('the probe branch was aborted by its caller')
      );
    };
    context.signal.addEventListener('abort', relayAbort, { once: true });
    const budget = adapters.probeTimeoutMs;
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new Error('probe timeout after ' + String(budget) + 'ms');
        controller.abort(error);
        rejectDeadline?.(error);
      }, budget);
    }

    try {
      recorder.push('model', {
        text: 'model request sent',
        metadata: {
          // P3-B: a probe branch is PROBE traffic. Labelling it 'compose' made
          // routing/usage statistics treat candidate execution as judging.
          purpose: 'probe',
          provider: adapters.route?.provider ?? null,
          model: adapters.route?.model ?? null
        }
      });
      const call = model.call({ purpose: 'probe', messages });
      // The losing promise must stay handled so a late rejection from an
      // abandoned model call can never become an unhandled rejection.
      call.catch(() => undefined);
      const response = await Promise.race([call, deadlinePromise]);
      const durationMs = Math.max(0, now() - startedAt);
      recorder.setDeliverable(response.text);
      recorder.setUsage(response.usage);
      recorder.push('result', {
        text: response.text,
        durationMs,
        ...(response.finishReason === undefined
          ? {}
          : { metadata: { finishReason: response.finishReason, ...(response.model === undefined ? {} : { model: response.model }) } })
      });

      if (timedOut) {
        recorder.fail('timeout', 'the probe exceeded its wall-clock budget', { repairable: true });
        recorder.settle('timeout');
        return recorder.snapshot();
      }
      if (cancelled) {
        recorder.fail('timeout', 'the probe branch was aborted while the model call was in flight', {
          repairable: true
        });
        recorder.settle('aborted');
        return recorder.snapshot();
      }
      if (response.finishReason === 'error') {
        const message = 'the model stream finished with an error reason';
        recorder.fail('model_refusal', message, { repairable: true });
        recorder.settle('failed', { name: 'EvoHarnessModelError', message });
        return recorder.snapshot();
      }
      if (response.text.trim().length === 0) {
        recorder.fail('model_refusal', 'the model returned no visible text', { repairable: true });
        recorder.settle('failed');
        return recorder.snapshot();
      }
      if (response.finishReason === 'length') {
        recorder.fail('budget_exhausted', 'the model stopped because it hit the token budget', {
          repairable: true
        });
      }
      recorder.settle('succeeded');
      return recorder.snapshot();
    } catch (error) {
      const durationMs = Math.max(0, now() - startedAt);
      const trajectoryError = toTrajectoryError(error);
      recorder.push('error', { text: trajectoryError.message, durationMs, error: trajectoryError });
      recorder.recordToolError({
        toolName: 'evo-harness-model',
        message: trajectoryError.message,
        ...(trajectoryError.code === undefined ? {} : { code: trajectoryError.code }),
        retryable: true,
        stepIndex: recorder.stepCount() - 1,
        ...(trajectoryError.stack === undefined ? {} : { stack: trajectoryError.stack })
      });
      if (timedOut) {
        recorder.fail('timeout', 'the probe exceeded its wall-clock budget: ' + trajectoryError.message, {
          repairable: true,
          ...(trajectoryError.code === undefined ? {} : { code: trajectoryError.code })
        });
        recorder.settle('timeout', trajectoryError);
      } else if (cancelled) {
        recorder.fail('timeout', 'the probe branch was cancelled: ' + trajectoryError.message, {
          repairable: true,
          ...(trajectoryError.code === undefined ? {} : { code: trajectoryError.code })
        });
        recorder.settle('aborted', trajectoryError);
      } else {
        recorder.fail('unknown', 'the model call failed: ' + trajectoryError.message, {
          repairable: true,
          ...(trajectoryError.code === undefined ? {} : { code: trajectoryError.code })
        });
        recorder.settle('failed', trajectoryError);
      }
      if (report !== undefined) {
        report('probe ' + context.branchId + ' failed: ' + trajectoryError.message);
      }
      return recorder.snapshot();
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      context.signal.removeEventListener('abort', relayAbort);
    }
  };

  return { runBranch, describe: () => [...capabilities] };
}
