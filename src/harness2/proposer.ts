/**
 * Harness² dual-track proposer: Domain (memory-guided) vs Invariant
 * (guidance-free first-principles exploration).
 *
 * ARCHITECTURE.md §3 (eight reversible surfaces) and §5.1 (asymmetric memory
 * injection). The proposer is a pure prompt builder plus a strict JSON parser:
 * the model adapter is injected (IModelAdapter) so unit tests are deterministic
 * and every proposal is a plain EightSurfacePatch record.
 *
 * Asymmetry guarantees enforced here (not merely requested in the prompt):
 * 1. A guidance-free slot NEVER renders recalled lesson content into the model
 *    request, even when the caller passes domain guidance by mistake.
 * 2. A guidance-free patch NEVER carries sourceLessonIds or memoryRecallIds.
 * 3. recallTags on a memory-surface edit are stripped for guidance-free
 *    branches, because they would pull external memory into the probe run.
 */

import {
  HARNESS_COMPONENT_KEYS,
  type ContractMetadata,
  type DynamicSkillSpec,
  type EightSurfaceEdits,
  type EightSurfacePatch,
  type GuardrailsSurfaceEdit,
  type HarnessComponentKey,
  type IHarnessProposer,
  type IModelAdapter,
  type MemoryRecallResult,
  type MemorySurfaceEdit,
  type MiddlewareSpec,
  type ModelMessage,
  type ModelRequest,
  type PatchPurpose,
  type PluginsSurfaceEdit,
  type ProbeTrajectory,
  type ProposeRequest,
  type ProposedPatch,
  type ProposedPatchSet,
  type ScriptArtifactSpec,
  type ScriptsSurfaceEdit,
  type SkillsSurfaceEdit,
  type SubagentSpec,
  type SubagentsSurfaceEdit,
  type SupportedSurfacePayload,
  type ModelResponse,
  type SystemPromptSurfaceEdit,
  type ToolGuidanceSurfaceEdit,
  type ToolPrecondition
} from '../types/contracts';
// P3-B: every model call leaves this module through the unified metered boundary.
import { createMeteredModelAdapter, type MeteredModelOptions } from '../dsh-bridge/metered-model-adapter';
// rev8 #110/#13: transport-class classification recognizes the DSH stream error
// surface; the class import keeps the instanceof fast path, with a structural
// fallback below so a cross-bundle twin of the same shape still classifies.
import { DshModelStreamError } from '../dsh-bridge/model';
import {
  type Clock,
  type IdFactory,
  clamp01,
  createDeterministicIdFactory,
  extractJsonValue,
  finiteNumber,
  isRecord,
  isSurfaceKey,
  nonEmptyString,
  oneLine,
  readStringList,
  systemClock,
  surfaceKeysInOrder,
  truncate
} from './shared';

/** Injectable dependencies of the Harness² proposer. */
export interface HarnessProposerOptions {
  /** Host-neutral LLM boundary. Required: proposals are model-authored. */
  readonly model: IModelAdapter;
  /** P3-B metering wiring (ledger/registry); absent records calls without cost. */
  readonly metering?: MeteredModelOptions;
  /** Injected clock; defaults to Date.now(). */
  readonly now?: Clock;
  /** Injected id factory; defaults to a deterministic counter. */
  readonly newId?: IdFactory;
  /** Cap on lessons rendered per prompt section. Defaults to 8. */
  readonly maxLessonsPerSection?: number;
  /** Sampling temperature; defaults to 0.2 (low for reproducibility). */
  readonly temperature?: number;
  /** Response token cap; defaults to 2048. */
  readonly maxTokens?: number;
  /**
   * rev8 #110/#13: number of transport-error RETRIES after the first attempt.
   * Defaults to 1 (the plan's "one bounded backoff retry"); 0 disables retrying.
   */
  readonly transportRetries?: number;
  /**
   * rev8 #110/#13: base backoff before the first retry, in milliseconds.
   * Defaults to 1000 (the plan's 1-2s window); retry N waits baseMs * N.
   */
  readonly transportRetryBackoffMs?: number;
  /**
   * rev8 #110/#13: injectable sleep used between retries. Defaults to a real
   * timer; tests pass an immediate fake. Returning a promise lets tests and
   * hosts plug abort-aware waits without this module owning timers.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Failure modes of one proposal attempt. */
export type Harness2ProposalFailure = 'proposal_unparseable' | 'proposal_no_valid_edits';

/** Deterministic typed failure raised by the proposer. */
export class Harness2ProposalError extends Error {
  readonly code: Harness2ProposalFailure;
  readonly detail: string;
  /**
   * A3 (rev6 B9): true when the model produced only edits on KNOWN surfaces that
   * are disabled for this run. This is not a proposer failure - it is a
   * proposal that cannot be evaluated, and the orchestrator must route it to
   * `proposals_not_evaluable` instead of `no_candidates`.
   */
  readonly notEvaluable: boolean;
  /** The known-but-disabled surfaces behind {@link notEvaluable}. */
  readonly droppedSurfaces: readonly HarnessComponentKey[];

  constructor(
    code: Harness2ProposalFailure,
    message: string,
    detail: string,
    extra: {
      readonly notEvaluable?: boolean;
      readonly droppedSurfaces?: readonly HarnessComponentKey[];
    } = {}
  ) {
    super(message);
    this.name = 'Harness2ProposalError';
    this.code = code;
    this.detail = detail;
    this.notEvaluable = extra.notEvaluable === true;
    this.droppedSurfaces = extra.droppedSurfaces ?? [];
  }
}

/**
 * rev8 plan §3.1 #110/#13: a transport-level model failure (gateway 429/5xx,
 * network reset, aborted stream) currently escapes the metered adapter and the
 * orchestrator drops the whole slot after recording one diagnostic line. Upstream
 * fixed this with one bounded retry for transport-class errors only. Ported here
 * as a proposer-internal wrapper so every stage that builds proposals shares it:
 *
 * - ONLY provably transport-class errors retry: an HTTP status that says so
 *   (429, 5xx), the DSH stream error surface, and Node network/system errors.
 *   Validation, budget, purpose-mismatch and permission failures never retry -
 *   repeating them would just double-spend the failure.
 * - At most `transportRetries` retries with a linear backoff (baseMs * attempt).
 * - A caller-supplied abort signal wins over the retry: an aborted wait or an
 *   abort observed before/at a retry rethrows the ORIGINAL error (or the abort
 *   reason), so an in-flight `/evo jit off` still takes effect. `ProposeRequest`
 *   has no first-class `signal` field (contracts.ts), so the signal is read
 *   structurally from `request.metadata.signal` when the host supplies one;
 *   hosts that never pass it are unaffected (backward compatible).
 * - The wrapper never inspects or re-renders request payloads, so nothing about
 *   the call (or any secret the host attached) is copied anywhere.
 */

/** Minimum delay between retries; keeps a misconfigured baseMs bounded below. */
const TRANSPORT_RETRY_MIN_BACKOFF_MS = 100;

/** Linear-backoff ceiling so a huge baseMs cannot stall a run indefinitely. */
const TRANSPORT_RETRY_MAX_BACKOFF_MS = 30_000;

/** Minimal structural AbortSignal probe (realm-safe; no DOM lib dependency). */
function isAbortSignalLike(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { aborted?: unknown }).aborted === 'boolean' &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
  );
}

/**
 * Read the per-call abort signal from `request.metadata.signal`. Structural on
 * purpose: adding a first-class field to ProposeRequest is a contracts.ts
 * change outside this module's scope, and ContractMetadata is already the
 * run's general-purpose channel.
 */
export function requestAbortSignal(request: ProposeRequest): AbortSignal | undefined {
  const candidate = (request.metadata as { signal?: unknown } | undefined)?.signal;
  return isAbortSignalLike(candidate) ? candidate : undefined;
}

/**
 * A transport-class error with a PROVABLE HTTP status attached, e.g. the gateway
 * error objects a host adapter builds from a failed fetch. Structural probing:
 * any error carrying a numeric `status` in the retryable ranges qualifies,
 * regardless of its class name, so the adapter needs no new exported marker.
 */
function provableHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const candidate = (error as { status?: unknown; statusCode?: unknown; httpStatus?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode ??
    (error as { httpStatus?: unknown }).httpStatus;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

/** Network/system errors whose `code` Node itself assigns (read-only probe). */
function nodeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Node/undici codes that PROVE a network/transport break. An allowlist, not a
 * prefix rule: EACCES (permission) and ERR_* (internal assertions) also start
 * with "E" and must NOT retry.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN'
]);

/** DSH failure codes that PROVE a rate-limit (gateway 429 surfaces as this). */
const RATE_LIMIT_STREAM_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT']);

/** Whether one DshModelStreamError surface is PROVABLY transport-class. */
function dshStreamErrorIsTransport(
  finishKind: 'error' | 'aborted' | undefined,
  failureCode: string | undefined
): boolean {
  // A mid-stream abort is a broken connection (the ask's 流中止). A caller who
  // aborted on purpose wins anyway: the retry loop checks the signal first.
  if (finishKind === 'aborted') {
    return true;
  }
  // A provider-RESPONDED error finish is only transport when the DSH code says
  // so. AUTH (permission) and unknown codes are not provable and do not retry.
  return failureCode !== undefined && RATE_LIMIT_STREAM_CODES.has(failureCode);
}

/**
 * True when this error is PROVABLY transport-class. The ask's bar: retry only
 * what evidence classifies - an HTTP 429/5xx status, a DSH stream abort or
 * rate-limit code, or a Node/undici network error code. Everything else (a
 * parse failure, a budget denial, an AUTH/permission error, an unknown Error)
 * is someone else's failure mode and reaches the caller untouched.
 */
export function isTransportClassModelError(error: unknown): boolean {
  if (error instanceof DshModelStreamError) {
    return dshStreamErrorIsTransport(error.finishKind, error.failureCode);
  }
  // Structural twin of DshModelStreamError (cross-bundle adapters).
  if (error instanceof Error && error.name === 'DshModelStreamError') {
    const shape = error as { finishKind?: unknown; failureCode?: unknown };
    return dshStreamErrorIsTransport(
      shape.finishKind === 'error' || shape.finishKind === 'aborted' ? shape.finishKind : undefined,
      typeof shape.failureCode === 'string' ? shape.failureCode : undefined
    );
  }
  // The error itself, then ONE level of `cause` (undici wraps the real network
  // error inside `TypeError: fetch failed`). Bounded depth: no cycle walks.
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    const code = nodeErrorCode(candidate);
    if (
      code !== undefined &&
      (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_') || code.startsWith('und_err_'))
    ) {
      return true;
    }
  }
  // Provable HTTP transport status on any error shape.
  const status = provableHttpStatus(error);
  if (status !== undefined && (status === 429 || (status >= 500 && status <= 599))) {
    return true;
  }
  return false;
}

/** One call attempt through the retry wrapper, for diagnostics. */
export interface TransportRetryAttempt {
  /** 1-based attempt number that failed with this error. */
  readonly attempt: number;
  readonly errorName: string;
  /** DSH failureCode or numeric HTTP status when the error exposed one. */
  readonly failureCode?: string;
}

export interface TransportRetryOutcome<T> {
  readonly value: T;
  /** Failures that were retried past; empty when the first attempt succeeded. */
  readonly retriedErrors: readonly TransportRetryAttempt[];
}

/** Default abort-aware sleep: a plain timer that resolves early on abort. */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('proposer retry backoff aborted before it started'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('proposer retry backoff aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Call `fn` once, retrying only transport-class errors with a bounded linear
 * backoff. `signal` short-circuits both the backoff and the decision to retry.
 */
async function callWithTransportRetry<T>(
  fn: () => Promise<T>,
  options: {
    readonly retries: number;
    readonly backoffMs: number;
    readonly signal?: AbortSignal;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  }
): Promise<TransportRetryOutcome<T>> {
  const retriedErrors: TransportRetryAttempt[] = [];
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    if (attempt > 1) {
      const backoff = Math.min(
        TRANSPORT_RETRY_MAX_BACKOFF_MS,
        Math.max(TRANSPORT_RETRY_MIN_BACKOFF_MS, options.backoffMs * (attempt - 1))
      );
      try {
        await options.sleep(backoff, options.signal);
      } catch {
        // Abort during the backoff: the caller withdrew the slot. Rethrow the
        // ORIGINAL model error (still the truthful cause), not the timer error.
        throw lastError;
      }
      if (options.signal?.aborted) {
        throw lastError;
      }
    }
    try {
      const value = await fn();
      return { value, retriedErrors };
    } catch (error) {
      lastError = error;
      const isLast = attempt >= options.retries + 1;
      if (options.signal?.aborted || isLast || !isTransportClassModelError(error)) {
        throw error;
      }
      const status = provableHttpStatus(error);
      retriedErrors.push({
        attempt,
        errorName: error instanceof Error ? error.name : 'unknown',
        ...(typeof (error as { failureCode?: unknown }).failureCode === 'string'
          ? { failureCode: (error as { failureCode: string }).failureCode }
          : status !== undefined
            ? { failureCode: 'HTTP_' + String(status) }
            : {})
      });
    }
  }
  // Unreachable: the loop returns or throws on every path.
  throw lastError;
}

/** Resolved guidance decision for one proposal. */
export interface ProposalGuidanceDecision {
  readonly memoryAllowed: boolean;
  readonly sanitized: boolean;
  readonly reason: string;
}

/**
 * Decide whether external memory may reach this proposal. Invariant slots and
 * guidance-free slots always lose memory access; a domain guidance object that
 * arrives on such a slot is reported as sanitized instead of being trusted.
 */
export function decideProposalGuidance(request: ProposeRequest): ProposalGuidanceDecision {
  const invariantSlot = request.slot.slot === 'explore_invariant';
  const slotGuidanceFree = request.slot.guidance === 'guidance_free';
  const memoryRequested = request.guidance.mode === 'domain';
  const memoryAllowed = memoryRequested && !invariantSlot && !slotGuidanceFree;
  if (memoryRequested && !memoryAllowed) {
    return {
      memoryAllowed: false,
      sanitized: true,
      reason:
        'domain memory was stripped: slot ' +
        request.slot.slot +
        ' is a guidance-free (invariant) exploration branch and must not receive external memory'
    };
  }
  if (!memoryRequested) {
    return {
      memoryAllowed: false,
      sanitized: false,
      reason: 'invariant guidance object carries memory: null by construction'
    };
  }
  return { memoryAllowed: true, sanitized: false, reason: 'domain guidance with recalled lessons' };
}

/**
 * The payload contract, keyed by the canonical surface name. `renderProposalPrompts`
 * renders ONLY the entries the caller actually allows (`enabledSurfaces`), so a
 * text-probe run never teaches the model the scripts/subagents/plugins payload
 * shapes it would then have to silently drop (rev6 A3/B9).
 */
const SURFACE_PAYLOAD_CONTRACT: Readonly<Record<HarnessComponentKey, string>> = {
  system_prompt:
    '- system_prompt: { "kind": "system_prompt", "mode": "append"|"replace", "content": string, "segment"?: string, "priority"?: number }',
  guardrails:
    '- guardrails: { "kind": "guardrails", "appendRules"?: string[], "forbiddenActions"?: string[], "formatContract"?: string, "toolPreconditions"?: [{"toolName": string, "rule": string}] } (at least one NON-EMPTY field)',
  memory:
    '- memory: { "kind": "memory", "scopedViewId"?: string, "workingNotes"?: string[], "recallTags"?: string[] } (at least one of workingNotes/recallTags with content; scopedViewId alone is not text-evaluable)',
  tool_guidance:
    '- tool_guidance: { "kind": "tool_guidance", "descriptions": {"<tool>": string}, "priorityOrder"?: string[], "examples"?: [{"toolName": string, "example": string}] }',
  skills:
    '- skills: { "kind": "skills", "skills": [{"name": string, "markdown": string, "description"?: string, "activate"?: boolean}] }',
  scripts:
    '- scripts: { "kind": "scripts", "scripts": [{"path": string, "language": "python"|"bash"|"typescript"|"javascript", "code": string, "executable"?: boolean}] }',
  subagents:
    '- subagents: { "kind": "subagents", "agents": [{"name": string, "description": string, "systemPrompt"?: string, "tools"?: string[], "model"?: string}] }',
  plugins:
    '- plugins: { "kind": "plugins", "middleware": [{"name": string, "hook": "before_tool"|"after_tool"|"around_tool", "language": "typescript"|"javascript", "code": string, "description"?: string}] }'
};

function referenceRunLines(reference: ProbeTrajectory): string[] {
  const lines: string[] = [];
  lines.push('status: ' + reference.status);
  lines.push(
    'metrics: steps=' +
      reference.metrics.steps +
      ' toolCalls=' +
      reference.metrics.toolCalls +
      ' toolErrors=' +
      reference.metrics.toolErrors +
      ' durationMs=' +
      reference.metrics.durationMs
  );
  if (reference.surfaceKeys.length > 0) {
    lines.push('patchedSurfaces: ' + reference.surfaceKeys.join(', '));
  }
  if (reference.error !== undefined) {
    lines.push('error: ' + reference.error.name + ': ' + truncate(oneLine(reference.error.message), 240));
  }
  for (const signal of reference.failureSignals.slice(0, 6)) {
    lines.push('failureSignal: ' + signal.kind + ' -> ' + truncate(oneLine(signal.message), 200));
  }
  for (const toolError of reference.toolErrors.slice(0, 5)) {
    lines.push('toolError: ' + toolError.toolName + ': ' + truncate(oneLine(toolError.message), 160));
  }
  if (reference.deliverable !== undefined) {
    lines.push('deliverableChars: ' + reference.deliverable.content.length);
  }
  return lines;
}

function memorySectionLines(recall: MemoryRecallResult, maxLessons: number): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('## Recalled memory (domain guidance)');
  lines.push(
    'driver: ' +
      recall.driverKind +
      ' | confidence: ' +
      recall.confidence +
      ' | degraded: ' +
      String(recall.degraded)
  );
  const positives = recall.positiveLessons.slice(0, maxLessons);
  if (positives.length === 0) {
    lines.push('positive_lessons: none recalled for this task.');
  } else {
    lines.push('### positive_lessons (recommendations to adapt, never to copy literally)');
    for (const lesson of positives) {
      lines.push('- [' + lesson.id + '] ' + lesson.title);
      lines.push('  whenToApply: ' + lesson.whenToApply.join(' | '));
      lines.push('  whenNotToApply: ' + lesson.whenNotToApply.join(' | '));
      lines.push('  components: ' + lesson.subFunctions.join(', '));
      lines.push('  execution: ' + truncate(oneLine(lesson.executionPatch.summary), 240));
    }
  }
  const negatives = recall.negativeLessons.slice(0, maxLessons);
  if (negatives.length === 0) {
    lines.push('anti_patterns_to_avoid: none recalled for this task.');
  } else {
    lines.push('### <anti_patterns_to_avoid> (observed failures; warnings only, NEVER recommendations)');
    for (const lesson of negatives) {
      lines.push('- [' + lesson.id + '] ' + lesson.title);
      lines.push('  failedWhen: ' + lesson.whenToApply.join(' | '));
      lines.push('  evidence: ' + truncate(oneLine(lesson.verificationEvidence.referenceFailure), 200));
    }
  }
  if (recall.suppressedLessons.length > 0) {
    lines.push(
      'withheld_by_firewall: ' +
        recall.suppressedLessons
          .slice(0, 5)
          .map((suppressed) => suppressed.title + ' (' + suppressed.reason + ')')
          .join('; ')
    );
  }
  return lines;
}

/**
 * Render the exact model messages for one proposal. Exported so tests and
 * reviewers can assert the asymmetric memory policy without a live model.
 */
export function renderProposalPrompts(
  request: ProposeRequest,
  options?: { readonly maxLessonsPerSection?: number; readonly candidateCount?: number }
): readonly ModelMessage[] {
  const decision = decideProposalGuidance(request);
  const maxLessons = options?.maxLessonsPerSection ?? 8;
  const recall: MemoryRecallResult | undefined =
    decision.memoryAllowed && request.guidance.mode === 'domain' ? request.guidance.memory : undefined;

  const system: string[] = [];
  // A3/B9: the prompt is part of the restriction, not only the parser. When the
  // caller supplies `enabledSurfaces` (the orchestrator passes the effective
  // text-probe set), the legend AND the payload contracts are filtered to that
  // set. Otherwise the model is shown scripts/subagents/plugins, emits edits the
  // parser must silently drop, and the run ends in a misleading proposer error.
  const promptSurfaces = allowedSurfacesFor(request);
  system.push('You are the Harness² proposer for a DeepSeek Harness (Cordis) agent.');
  system.push(
    'You edit the allowed harness surfaces that wrap a frozen model. Model weights never change; only the scaffold around them changes.'
  );
  system.push('Surfaces (stable order): ' + promptSurfaces.join(', ') + '.');
  const shapeLine =
    '{ "rationale": string, "focusSurfaces": string[], "confidence": number in [0,1], "expectedStepsDelta": number, "edits": { <surface>: <payload> } }';
  const candidateCount = options?.candidateCount ?? 1;
  if (candidateCount > 1) {
    system.push(
      'Return a JSON ARRAY of exactly ' + String(candidateCount) + ' candidate objects, no prose. Every array element matches this shape:'
    );
    system.push(shapeLine);
    system.push('Diversify: every candidate must propose a materially different edit plan; never repeat an object.');
  } else {
    system.push('Return exactly ONE JSON object, no prose, matching this shape:');
    system.push(shapeLine);
  }
  system.push('Payload shapes (the "kind" field is mandatory):');
  for (const surface of promptSurfaces) {
    system.push(SURFACE_PAYLOAD_CONTRACT[surface]);
  }
  system.push(
    'Rules: only edit surfaces listed as allowed; keep each edit minimal and directly testable; never invent tool names or files that the task did not mention.'
  );
  if (decision.memoryAllowed) {
    system.push(
      'Memory policy: DOMAIN branch. Recalled positive lessons are recommendations to adapt; negative lessons are anti-patterns that must never be applied as recommendations.'
    );
  } else {
    system.push(
      'Memory policy: GUIDANCE-FREE branch (first-principles / invariant exploration). External memory is disabled: no recalled lesson is available, none may be assumed, and no lesson id may appear anywhere in your output.'
    );
  }

  const user: string[] = [];
  user.push('## Task');
  user.push('prompt: ' + truncate(oneLine(request.task.prompt), 1200));
  if (request.task.taskSignature !== undefined) {
    user.push('taskSignature: ' + request.task.taskSignature);
  }
  if (request.task.complexity !== undefined) {
    user.push('complexity: ' + request.task.complexity);
  }
  const contextTags = request.task.contextTags ?? [];
  if (contextTags.length > 0) {
    user.push('contextTags: ' + contextTags.join(', '));
  }
  user.push('');
  user.push('## Slot');
  user.push('slot: ' + request.slot.slot + ' (index ' + request.slot.slotIndex + ')');
  user.push(
    'origin: ' +
      request.slot.origin +
      ' | guidance: ' +
      request.slot.guidance +
      ' | attempt ' +
      request.attemptIndex +
      ' of ' +
      request.totalBudget
  );
  user.push(
    'focusSurfaces: ' +
      (request.slot.focusSurfaces.length > 0 ? request.slot.focusSurfaces.join(', ') : '(proposer choice)')
  );
  user.push('slotRationale: ' + truncate(oneLine(request.slot.rationale), 400));
  if (request.slot.expectedUtility !== undefined) {
    user.push('expectedUtility: ' + request.slot.expectedUtility);
  }
  if (request.enabledSurfaces !== undefined) {
    user.push('allowedSurfaces: ' + request.enabledSurfaces.join(', '));
  }
  if (request.slot.repairOfNodeId !== undefined) {
    user.push('repairOfNodeId: ' + request.slot.repairOfNodeId + ' (repair, do not redesign from scratch)');
  }
  if (decision.memoryAllowed && request.slot.memoryHintIds !== undefined && request.slot.memoryHintIds.length > 0) {
    user.push('memoryHintIds: ' + request.slot.memoryHintIds.join(', '));
  }

  if (request.parentPatch !== undefined) {
    user.push('');
    user.push('## Parent patch');
    user.push('label: ' + request.parentPatch.label);
    user.push('origin: ' + request.parentPatch.origin + ' | purpose: ' + request.parentPatch.purpose);
    user.push('rationale: ' + truncate(oneLine(request.parentPatch.rationale), 400));
    user.push('editedSurfaces: ' + Object.keys(request.parentPatch.edits).join(', '));
  }
  if (request.parentNode !== undefined) {
    user.push('');
    user.push('## Parent node');
    user.push(
      'id: ' +
        request.parentNode.id +
        ' | status: ' +
        request.parentNode.status +
        ' | depth: ' +
        request.parentNode.depth
    );
    if (request.parentNode.score !== undefined) {
      user.push('score: ' + request.parentNode.score);
    }
    if (request.parentNode.failure !== undefined) {
      user.push(
        'failure: ' +
          request.parentNode.failure.category +
          ' -> ' +
          request.parentNode.failure.recommendedAction +
          (request.parentNode.failure.repairHint !== undefined
            ? ' | repairHint: ' + truncate(oneLine(request.parentNode.failure.repairHint), 200)
            : '')
      );
    }
  }
  const reference = request.referenceTrajectory;
  if (reference !== undefined) {
    user.push('');
    user.push('## Reference run (contrast baseline)');
    for (const line of referenceRunLines(reference)) {
      user.push(line);
    }
  } else {
    user.push('');
    user.push('## Reference run');
    user.push('none available; propose from the task statement alone.');
  }

  if (decision.memoryAllowed && recall !== undefined) {
    for (const line of memorySectionLines(recall, maxLessons)) {
      user.push(line);
    }
  } else {
    user.push('');
    user.push('## Memory policy');
    user.push(
      'External memory is DISABLED for this branch (guidance-free invariant exploration). No recalled lessons are available and none may be assumed; derive improvements only from the task statement and the reference-run evidence.'
    );
  }

  user.push('');
  user.push('## Output');
  user.push('Return the single JSON proposal object now.');

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') }
  ];
}

/** Map a Dream-RSI batch slot onto the patch purpose recorded on the patch. */
export function purposeForSlot(slot: ProposeRequest['slot']['slot']): PatchPurpose {
  switch (slot) {
    case 'exploit':
      return 'deepen';
    case 'recover':
      return 'repair';
    case 'explore_domain':
    case 'explore_invariant':
      return 'explore';
    default:
      return 'explore';
  }
}

type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(reason: string): ValidationResult<T> {
  return { ok: false, reason };
}

function validateSystemPrompt(payload: Record<string, unknown>): ValidationResult<SystemPromptSurfaceEdit> {
  const mode = payload.mode === 'append' || payload.mode === 'replace' ? payload.mode : undefined;
  if (mode === undefined) {
    return invalid('mode must be "append" or "replace"');
  }
  const content = nonEmptyString(payload.content);
  if (content === undefined) {
    return invalid('content must be a non-empty string');
  }
  return valid({
    kind: 'system_prompt',
    mode,
    content,
    segment: nonEmptyString(payload.segment),
    priority: finiteNumber(payload.priority)
  });
}

function validateGuardrails(payload: Record<string, unknown>): ValidationResult<GuardrailsSurfaceEdit> {
  const appendRules = readStringList(payload.appendRules, 64);
  if (payload.appendRules !== undefined && appendRules === undefined) {
    return invalid('appendRules must be an array of non-empty strings');
  }
  const forbiddenActions = readStringList(payload.forbiddenActions, 64);
  if (payload.forbiddenActions !== undefined && forbiddenActions === undefined) {
    return invalid('forbiddenActions must be an array of non-empty strings');
  }
  let formatContract: string | undefined;
  if (payload.formatContract !== undefined) {
    formatContract = nonEmptyString(payload.formatContract);
    if (formatContract === undefined) {
      return invalid('formatContract must be a non-empty string');
    }
  }
  let toolPreconditions: ToolPrecondition[] | undefined;
  if (payload.toolPreconditions !== undefined) {
    if (!Array.isArray(payload.toolPreconditions)) {
      return invalid('toolPreconditions must be an array');
    }
    const rules: ToolPrecondition[] = [];
    for (const item of payload.toolPreconditions) {
      if (!isRecord(item)) {
        return invalid('each toolPrecondition must be an object');
      }
      const toolName = nonEmptyString(item.toolName);
      const rule = nonEmptyString(item.rule);
      if (toolName === undefined || rule === undefined) {
        return invalid('each toolPrecondition needs a non-empty toolName and rule');
      }
      rules.push({ toolName, rule });
    }
    toolPreconditions = rules;
  }
  // A1/A3 content-level requirement: a key whose arrays are all present-but-
  // empty renders NOTHING into the probe. Accepting it would spend a candidate
  // rollout on a rationale-only prompt (the exact B1 failure), so the payload
  // must carry at least one non-empty field.
  const hasAppendRules = appendRules !== undefined && appendRules.length > 0;
  const hasForbiddenActions = forbiddenActions !== undefined && forbiddenActions.length > 0;
  const hasToolPreconditions = toolPreconditions !== undefined && toolPreconditions.length > 0;
  if (!hasAppendRules && !hasForbiddenActions && formatContract === undefined && !hasToolPreconditions) {
    return invalid('at least one non-empty guardrails field is required');
  }
  return valid({ kind: 'guardrails', appendRules, forbiddenActions, formatContract, toolPreconditions });
}

function validateMemorySurface(payload: Record<string, unknown>): ValidationResult<MemorySurfaceEdit> {
  const scopedViewId = nonEmptyString(payload.scopedViewId);
  if (payload.scopedViewId !== undefined && scopedViewId === undefined) {
    return invalid('scopedViewId must be a non-empty string');
  }
  const workingNotes = readStringList(payload.workingNotes, 32);
  if (payload.workingNotes !== undefined && workingNotes === undefined) {
    return invalid('workingNotes must be an array of non-empty strings');
  }
  const recallTags = readStringList(payload.recallTags, 32);
  if (payload.recallTags !== undefined && recallTags === undefined) {
    return invalid('recallTags must be an array of non-empty strings');
  }
  // A1 renders workingNotes + recallTags only; `scopedViewId` alone has no probe
  // content (the backend is never exercised by a text probe). Requiring
  // renderable content keeps A3's evaluability decision and the proposer's
  // accepted payloads aligned.
  const hasWorkingNotes = workingNotes !== undefined && workingNotes.length > 0;
  const hasRecallTags = recallTags !== undefined && recallTags.length > 0;
  if (!hasWorkingNotes && !hasRecallTags) {
    return invalid('at least one of workingNotes/recallTags with content is required (scopedViewId alone is not text-evaluable)');
  }
  return valid({ kind: 'memory', scopedViewId, workingNotes, recallTags });
}

function validateToolGuidance(payload: Record<string, unknown>): ValidationResult<ToolGuidanceSurfaceEdit> {
  if (!isRecord(payload.descriptions)) {
    return invalid('descriptions must be an object of tool name -> description');
  }
  const descriptions: Record<string, string> = {};
  for (const key of Object.keys(payload.descriptions)) {
    const text = nonEmptyString(payload.descriptions[key]);
    if (text === undefined) {
      return invalid('descriptions values must be non-empty strings');
    }
    descriptions[key] = text;
  }
  if (Object.keys(descriptions).length === 0) {
    return invalid('descriptions must contain at least one tool');
  }
  const priorityOrder = readStringList(payload.priorityOrder, 32);
  if (payload.priorityOrder !== undefined && priorityOrder === undefined) {
    return invalid('priorityOrder must be an array of non-empty strings');
  }
  let examples: Array<{ toolName: string; example: string }> | undefined;
  if (payload.examples !== undefined) {
    if (!Array.isArray(payload.examples)) {
      return invalid('examples must be an array');
    }
    const parsed: Array<{ toolName: string; example: string }> = [];
    for (const item of payload.examples) {
      if (!isRecord(item)) {
        return invalid('each example must be an object');
      }
      const toolName = nonEmptyString(item.toolName);
      const example = nonEmptyString(item.example);
      if (toolName === undefined || example === undefined) {
        return invalid('each example needs a non-empty toolName and example');
      }
      parsed.push({ toolName, example });
    }
    examples = parsed;
  }
  return valid({ kind: 'tool_guidance', descriptions, priorityOrder, examples });
}

function validateSkills(payload: Record<string, unknown>): ValidationResult<SkillsSurfaceEdit> {
  if (!Array.isArray(payload.skills) || payload.skills.length === 0) {
    return invalid('skills must be a non-empty array');
  }
  const skills: DynamicSkillSpec[] = [];
  for (const item of payload.skills) {
    if (!isRecord(item)) {
      return invalid('each skill must be an object');
    }
    const name = nonEmptyString(item.name);
    const markdown = typeof item.markdown === 'string' && item.markdown.trim().length > 0 ? item.markdown : undefined;
    if (name === undefined || markdown === undefined) {
      return invalid('each skill needs a non-empty name and markdown');
    }
    skills.push({ name, markdown, description: nonEmptyString(item.description), activate: item.activate === true });
  }
  return valid({ kind: 'skills', skills });
}

function validateScripts(payload: Record<string, unknown>): ValidationResult<ScriptsSurfaceEdit> {
  if (!Array.isArray(payload.scripts) || payload.scripts.length === 0) {
    return invalid('scripts must be a non-empty array');
  }
  const languages = ['python', 'bash', 'typescript', 'javascript'] as const;
  const scripts: ScriptArtifactSpec[] = [];
  for (const item of payload.scripts) {
    if (!isRecord(item)) {
      return invalid('each script must be an object');
    }
    const path = nonEmptyString(item.path);
    const code = typeof item.code === 'string' && item.code.trim().length > 0 ? item.code : undefined;
    const language = languages.find((candidate) => candidate === item.language);
    if (path === undefined || code === undefined || language === undefined) {
      return invalid('each script needs a non-empty path, a supported language and non-empty code');
    }
    scripts.push({ path, language, code, executable: item.executable === true });
  }
  return valid({ kind: 'scripts', scripts });
}

function validateSubagents(payload: Record<string, unknown>): ValidationResult<SubagentsSurfaceEdit> {
  if (!Array.isArray(payload.agents) || payload.agents.length === 0) {
    return invalid('agents must be a non-empty array');
  }
  const agents: SubagentSpec[] = [];
  for (const item of payload.agents) {
    if (!isRecord(item)) {
      return invalid('each subagent must be an object');
    }
    const name = nonEmptyString(item.name);
    const description = nonEmptyString(item.description);
    if (name === undefined || description === undefined) {
      return invalid('each subagent needs a non-empty name and description');
    }
    let systemPrompt: string | undefined;
    if (item.systemPrompt !== undefined) {
      systemPrompt = nonEmptyString(item.systemPrompt);
      if (systemPrompt === undefined) {
        return invalid('subagent.systemPrompt must be a non-empty string when present');
      }
    }
    const tools = readStringList(item.tools, 32);
    if (item.tools !== undefined && tools === undefined) {
      return invalid('subagent.tools must be an array of non-empty strings');
    }
    agents.push({ name, description, systemPrompt, tools, model: nonEmptyString(item.model) });
  }
  return valid({ kind: 'subagents', agents });
}

function validatePlugins(payload: Record<string, unknown>): ValidationResult<PluginsSurfaceEdit> {
  if (!Array.isArray(payload.middleware) || payload.middleware.length === 0) {
    return invalid('middleware must be a non-empty array');
  }
  const hooks = ['before_tool', 'after_tool', 'around_tool'] as const;
  const languages = ['typescript', 'javascript'] as const;
  const middleware: MiddlewareSpec[] = [];
  for (const item of payload.middleware) {
    if (!isRecord(item)) {
      return invalid('each middleware must be an object');
    }
    const name = nonEmptyString(item.name);
    const hook = hooks.find((candidate) => candidate === item.hook);
    const language = languages.find((candidate) => candidate === item.language);
    const code = typeof item.code === 'string' && item.code.trim().length > 0 ? item.code : undefined;
    if (name === undefined || hook === undefined || language === undefined || code === undefined) {
      return invalid('each middleware needs name, a supported hook/language and non-empty code');
    }
    middleware.push({ name, hook, language, code, description: nonEmptyString(item.description) });
  }
  return valid({ kind: 'plugins', middleware });
}

function validateSurfacePayload(
  key: HarnessComponentKey,
  payload: Record<string, unknown>
): ValidationResult<SupportedSurfacePayload> {
  switch (key) {
    case 'system_prompt':
      return validateSystemPrompt(payload);
    case 'guardrails':
      return validateGuardrails(payload);
    case 'memory':
      return validateMemorySurface(payload);
    case 'tool_guidance':
      return validateToolGuidance(payload);
    case 'skills':
      return validateSkills(payload);
    case 'scripts':
      return validateScripts(payload);
    case 'subagents':
      return validateSubagents(payload);
    case 'plugins':
      return validatePlugins(payload);
    default:
      return invalid('unsupported harness surface');
  }
}

interface ParsedEdits {
  readonly edits: Partial<Record<HarnessComponentKey, SupportedSurfacePayload>>;
  readonly dropped: string[];
  /** Known surfaces rejected ONLY because `allowed` excluded them. */
  readonly disallowed: HarnessComponentKey[];
  /** Unknown keys, malformed payloads or validation failures. */
  readonly otherDrops: number;
}

function parseEdits(
  raw: unknown,
  allowed: readonly HarnessComponentKey[],
  dropped: string[]
): ParsedEdits {
  const edits: Partial<Record<HarnessComponentKey, SupportedSurfacePayload>> = {};
  const disallowed: HarnessComponentKey[] = [];
  let otherDrops = 0;
  if (!isRecord(raw)) {
    dropped.push('edits: missing or not a JSON object');
    return { edits, dropped, disallowed, otherDrops: 1 };
  }
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(raw)) {
    if (isSurfaceKey(key) === false) {
      dropped.push(key + ': unknown harness surface');
      otherDrops += 1;
      continue;
    }
    if (!allowedSet.has(key)) {
      dropped.push(key + ': surface is not enabled for this run');
      disallowed.push(key);
      continue;
    }
    const payload = raw[key];
    if (!isRecord(payload)) {
      dropped.push(key + ': payload is not a JSON object');
      otherDrops += 1;
      continue;
    }
    const result = validateSurfacePayload(key, payload);
    if (!result.ok) {
      dropped.push(key + ': ' + result.reason);
      otherDrops += 1;
      continue;
    }
    edits[key] = result.value;
  }
  return { edits, dropped, disallowed, otherDrops };
}

/** Remove external-memory channels from edits destined for an invariant branch. */
function stripExternalMemoryChannels(
  edits: Partial<Record<HarnessComponentKey, SupportedSurfacePayload>>,
  dropped: string[]
): void {
  const memoryEdit = edits.memory;
  if (memoryEdit === undefined || memoryEdit.kind !== 'memory') {
    return;
  }
  const hasRecallTags = memoryEdit.recallTags !== undefined && memoryEdit.recallTags.length > 0;
  if (hasRecallTags) {
    dropped.push('memory.recallTags stripped: guidance-free branches must not recall external memory');
  }
  const keepsOtherFields =
    memoryEdit.workingNotes !== undefined && memoryEdit.workingNotes.length > 0;
  if (!keepsOtherFields) {
    delete edits.memory;
    if (hasRecallTags) {
      dropped.push('memory: edit dropped because only recallTags remained on a guidance-free branch');
    }
    return;
  }
  edits.memory = { ...memoryEdit, recallTags: undefined };
}

function allowedSurfacesFor(request: ProposeRequest): readonly HarnessComponentKey[] {
  const requested = request.enabledSurfaces;
  if (requested === undefined || requested.length === 0) {
    return HARNESS_COMPONENT_KEYS;
  }
  return surfaceKeysInOrder(requested);
}

function resolveFocusSurfaces(raw: unknown, edited: readonly HarnessComponentKey[]): HarnessComponentKey[] {
  const modelPicks = surfaceKeysInOrder(readStringList(raw, 8) ?? []);
  const intersect = modelPicks.filter((key) => edited.includes(key));
  if (intersect.length > 0) {
    return intersect;
  }
  return [...edited];
}

function lessonIds(recall: MemoryRecallResult | undefined): string[] {
  if (recall === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const lesson of [...recall.positiveLessons, ...recall.negativeLessons]) {
    if (!ids.includes(lesson.id)) {
      ids.push(lesson.id);
    }
  }
  return ids;
}

/**
 * Build the dual-track Harness² proposer. The returned object implements the
 * frozen IHarnessProposer contract; all I/O is the injected model adapter.
 */
export function createDualTrackProposer(options: HarnessProposerOptions): IHarnessProposer {
  const now = options.now ?? systemClock;
  const newId = options.newId ?? createDeterministicIdFactory('propose');
  const maxLessons = options.maxLessonsPerSection ?? 8;
  const model = createMeteredModelAdapter(options.model, 'propose', options.metering);
  // rev8 #110/#13: bounded transport retry. Defaults keep the plan's shape
  // (one retry, ~1s backoff); 0 retries or a <=0 backoff disables the wait.
  const transportRetries = options.transportRetries ?? 1;
  const transportBackoffMs = options.transportRetryBackoffMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => defaultSleep(ms, signal));

  const callModelWithRetry = async (
    modelRequest: ModelRequest,
    diagnostics: string[],
    signal?: AbortSignal
  ): Promise<ModelResponse> => {
    const outcome = await callWithTransportRetry(() => model.call(modelRequest), {
      retries: Math.max(0, transportRetries),
      backoffMs: Math.max(0, transportBackoffMs),
      ...(signal === undefined ? {} : { signal }),
      sleep
    });
    for (const attempt of outcome.retriedErrors) {
      diagnostics.push(
        'proposal transport retry: attempt ' +
          String(attempt.attempt) +
          ' failed with ' +
          attempt.errorName +
          (attempt.failureCode === undefined ? '' : ' (' + attempt.failureCode + ')') +
          '; retried after backoff'
      );
    }
    return outcome.value;
  };

  const proposer: IHarnessProposer = {
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      const decision = decideProposalGuidance(request);
      const diagnostics: string[] = [];
      if (decision.sanitized) {
        diagnostics.push(decision.reason);
      }
      const recall: MemoryRecallResult | undefined =
        decision.memoryAllowed && request.guidance.mode === 'domain' ? request.guidance.memory : undefined;

      const modelRequest: ModelRequest = {
        purpose: 'propose',
        messages: renderProposalPrompts(request, { maxLessonsPerSection: maxLessons }),
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens ?? 2048,
        responseFormat: 'json',
        metadata: {
          sessionId: request.sessionId,
          slot: request.slot.slot,
          guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
          attemptIndex: request.attemptIndex
        }
      };
      const response = await callModelWithRetry(
        modelRequest,
        diagnostics,
        requestAbortSignal(request)
      );
      const parsed = extractJsonValue(response.text);
      const record = isRecord(parsed) ? parsed : undefined;
      if (record === undefined) {
        throw new Harness2ProposalError(
          'proposal_unparseable',
          'Harness² proposer received a model response that is not a JSON object.',
          truncate(oneLine(response.text), 400)
        );
      }

      const allowed = allowedSurfacesFor(request);
      const dropped: string[] = [];
      const parsedEdits = parseEdits(record.edits, allowed, dropped);
      const edits = parsedEdits.edits;
      if (!decision.memoryAllowed) {
        stripExternalMemoryChannels(edits, dropped);
      }
      const editedSurfaces = surfaceKeysInOrder(Object.keys(edits));
      if (editedSurfaces.length === 0) {
        // A3 (rev6 B9): if every recognized edit was merely DISABLED (not
        // malformed), this is an unevaluable proposal, not a proposer crash.
        // Only the disallowed-only shape maps here; a mixed response with an
        // invalid payload on an allowed surface stays a proposal failure.
        const notEvaluable =
          parsedEdits.disallowed.length > 0 && parsedEdits.otherDrops === 0;
        throw new Harness2ProposalError(
          'proposal_no_valid_edits',
          'Harness² proposer produced no valid surface edit for this slot.',
          dropped.length > 0 ? dropped.join(' | ') : 'model returned an empty edits object',
          {
            notEvaluable,
            droppedSurfaces: notEvaluable ? parsedEdits.disallowed : []
          }
        );
      }

      const focusSurfaces = resolveFocusSurfaces(record.focusSurfaces, editedSurfaces);
      const rationale =
        nonEmptyString(record.rationale) ??
        'Model proposal for slot ' + request.slot.slot + ' touching ' + editedSurfaces.join(', ') + '.';
      const confidence = clamp01(finiteNumber(record.confidence) ?? 0.5);
      const expectedStepsDelta = finiteNumber(record.expectedStepsDelta);
      const sourceLessonIds = decision.memoryAllowed ? lessonIds(recall) : [];

      const parentPatchIds: string[] = [];
      if (request.parentPatch !== undefined) {
        parentPatchIds.push(request.parentPatch.id);
      }
      for (const seedId of request.slot.seedPatchIds ?? []) {
        if (!parentPatchIds.includes(seedId)) {
          parentPatchIds.push(seedId);
        }
      }

      const metadata: ContractMetadata = {
        slot: request.slot.slot,
        slotIndex: request.slot.slotIndex,
        origin: request.slot.origin,
        attemptIndex: request.attemptIndex,
        requestedGuidanceMode: request.guidance.mode,
        effectiveGuidanceMode: decision.memoryAllowed ? 'memory' : 'guidance_free',
        guidanceSanitized: decision.sanitized,
        droppedEdits: dropped,
        memoryConfidence: recall?.confidence,
        memoryRecallIds: sourceLessonIds,
        diagnostics,
        model: response.model
      };

      const patch: EightSurfacePatch = {
        id: newId('patch'),
        sessionId: request.sessionId,
        branchId: request.slot.branchId,
        origin: request.slot.origin,
        purpose: purposeForSlot(request.slot.slot),
        guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
        label: request.slot.slot + ':' + editedSurfaces.join('+'),
        rationale,
        edits: edits as EightSurfaceEdits,
        parentPatchIds: parentPatchIds.length > 0 ? parentPatchIds : undefined,
        sourceLessonIds,
        createdAt: now(),
        metadata
      };

      return { patch, rationale, focusSurfaces, confidence, expectedStepsDelta };
    }
  };

  // P3-B (plan section 8): optional multi-candidate path. K>1 asks the model
  // ONCE for a JSON array of candidate objects, validates every element with
  // the same EightSurfacePatch checks as the single path, drops invalid
  // entries (never failing the whole call) and falls back to the proven
  // single-candidate path when nothing usable remains. K<=1 defers to
  // propose() byte-for-byte.
  proposer.proposeCandidates = async (request: ProposeRequest): Promise<ProposedPatchSet> => {
    const requested = request.candidateCount;
    if (!Number.isInteger(requested) || (requested ?? 1) <= 1) {
      const single = await proposer.propose(request);
      return { candidates: [single] };
    }
    const k = requested as number;
    const decision = decideProposalGuidance(request);
    const diagnostics: string[] = [];
    if (decision.sanitized) {
      diagnostics.push(decision.reason);
    }
    const recall: MemoryRecallResult | undefined =
      decision.memoryAllowed && request.guidance.mode === 'domain' ? request.guidance.memory : undefined;
    const modelRequest: ModelRequest = {
      purpose: 'propose',
      messages: renderProposalPrompts(request, { maxLessonsPerSection: maxLessons, candidateCount: k }),
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 2048,
      responseFormat: 'json',
      metadata: {
        sessionId: request.sessionId,
        slot: request.slot.slot,
        guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
        attemptIndex: request.attemptIndex,
        candidateCount: k
      }
    };
    const response = await callModelWithRetry(modelRequest, diagnostics, requestAbortSignal(request));
    const parsed = extractJsonValue(response.text);
    const rawCandidates: unknown[] = Array.isArray(parsed)
      ? parsed.slice(0, k)
      : isRecord(parsed)
        ? [parsed]
        : [];
    const allowed = allowedSurfacesFor(request);
    const candidates: ProposedPatch[] = [];
    for (let index = 0; index < rawCandidates.length; index += 1) {
      const entry: unknown = rawCandidates[index];
      const label = 'candidate ' + String(index + 1);
      if (!isRecord(entry)) {
        diagnostics.push(label + ': dropped, not a JSON object');
        continue;
      }
      const dropped: string[] = [];
      const parsed = parseEdits(entry.edits, allowed, dropped);
      const edits = parsed.edits;
      if (!decision.memoryAllowed) {
        stripExternalMemoryChannels(edits, dropped);
      }
      const editedSurfaces = surfaceKeysInOrder(Object.keys(edits));
      if (editedSurfaces.length === 0) {
        diagnostics.push(
          label + ': dropped, no valid surface edit' + (dropped.length > 0 ? ' (' + dropped.join(' | ') + ')' : '')
        );
        continue;
      }
      const rationale =
        nonEmptyString(entry.rationale) ??
        'Model proposal for slot ' + request.slot.slot + ' touching ' + editedSurfaces.join(', ') + '.';
      const focusSurfaces = resolveFocusSurfaces(entry.focusSurfaces, editedSurfaces);
      const confidence = clamp01(finiteNumber(entry.confidence) ?? 0.5);
      const expectedStepsDelta = finiteNumber(entry.expectedStepsDelta);
      const sourceLessonIds = decision.memoryAllowed ? lessonIds(recall) : [];
      const parentPatchIds: string[] = [];
      if (request.parentPatch !== undefined) {
        parentPatchIds.push(request.parentPatch.id);
      }
      for (const seedId of request.slot.seedPatchIds ?? []) {
        if (!parentPatchIds.includes(seedId)) {
          parentPatchIds.push(seedId);
        }
      }
      const metadata: ContractMetadata = {
        slot: request.slot.slot,
        slotIndex: request.slot.slotIndex,
        origin: request.slot.origin,
        attemptIndex: request.attemptIndex,
        requestedGuidanceMode: request.guidance.mode,
        effectiveGuidanceMode: decision.memoryAllowed ? 'memory' : 'guidance_free',
        guidanceSanitized: decision.sanitized,
        candidateIndex: index + 1,
        candidateCountRequested: k,
        droppedEdits: dropped,
        memoryConfidence: recall?.confidence,
        memoryRecallIds: sourceLessonIds,
        diagnostics,
        model: response.model
      };
      candidates.push({
        patch: {
          id: newId('patch'),
          sessionId: request.sessionId,
          branchId: request.slot.branchId,
          origin: request.slot.origin,
          purpose: purposeForSlot(request.slot.slot),
          guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
          label: request.slot.slot + ':' + editedSurfaces.join('+'),
          rationale,
          edits: edits as EightSurfaceEdits,
          parentPatchIds: parentPatchIds.length > 0 ? parentPatchIds : undefined,
          sourceLessonIds,
          createdAt: now(),
          metadata
        },
        rationale,
        focusSurfaces,
        confidence,
        expectedStepsDelta
      });
    }
    if (candidates.length === 0) {
      const fallback = await proposer.propose(request);
      const fallbackMeta: ContractMetadata = {
        ...(fallback.patch.metadata ?? {}),
        diagnostics: [
          ...((fallback.patch.metadata?.diagnostics as readonly string[]) ?? []),
          'multi-candidate response unusable (' + String(k) + ' requested, 0 valid); fell back to the single-candidate path'
        ]
      };
      return {
        candidates: [{ ...fallback, patch: { ...fallback.patch, metadata: fallbackMeta } }]
      };
    }
    diagnostics.unshift(
      'multi-candidate proposal: requested ' + String(k) + ', accepted ' + String(candidates.length)
    );
    return {
      candidates: candidates.map((candidate) => ({
        ...candidate,
        patch: {
          ...candidate.patch,
          metadata: { ...(candidate.patch.metadata ?? {}), diagnostics: [...diagnostics] }
        }
      }))
    };
  };

  return proposer;
}
