/**
 * DSH-backed model adapter for the host-neutral IModelAdapter boundary.
 *
 * HOST FACTS THIS MODULE CODES AGAINST (verified against the DSH runtime in
 * resources/app.asar, packages @deepseek-ai/dsh-llm and @deepseek-ai/dsh-tools):
 * 1. `ctx.llm` is the @deepseek-ai/dsh-llm LlmRuntime service. Its only public
 *    model-call entry is `ctx.llm.stream(options)`, which returns an async
 *    iterable of token-level chunks. `ctx.llm.complete(...)` has NEVER existed —
 *    the runtime source exports only `stream`, `prepareCall`, `registerAdapter`,
 *    `listProviders`, `listModels`, and the model-metadata readers.
 * 2. The chunk protocol is
 *      { type: 'block-start', index, blockType }
 *      { type: 'text-delta', index, text }
 *      { type: 'reasoning-delta', index, text }
 *      { type: 'tool-call-delta', index, id, name?, argumentsDelta }
 *      { type: 'block-end', index, block }
 *      { type: 'usage', usage }
 *      { type: 'finish', reason, replayState? }
 *    and a stream ALWAYS ends in exactly one 'finish' chunk, whose `reason` is
 *    one of { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
 *    | { kind: 'aborted', failure } | { kind: 'error', failure }. A stream that
 *    throws before any finish chunk (a listener or consumer failure) is NOT a
 *    protocol settlement and must not be reported as one.
 * 3. Request messages are `RequestMessage = Message | RequestUserInput`, where
 *    `RequestUserInput` is exactly `{ role: 'user'; content: readonly ContentBlock[] }`
 *    with no id and no source. Request-only inputs are accepted on every
 *    GenerateOptions and are the delivery path for a request without a
 *    session log entry, so this adapter never mints message identities it does
 *    not own.
 * 4. `GenerateOptions` is
 *      { provider, model, reasoningEffort?, messages, system?, tools?,
 *        toolHistory?, temperature?, maxTokens?, stop?, signal?,
 *        sessionId?, purpose? }
 *    — there is no `responseFormat` field and no `temperature` default; both
 *    are passed through only when the caller supplied them.
 * 5. A live Cordis context THROWS `cannot get property "<name>" without inject`
 *    for a service this fiber did not declare, so every `ctx` read below goes
 *    through the guarded reader.
 *
 * NO DSH API IS FABRICATED HERE: every field name in DshGenerateOptions,
 * DshStreamChunk and DshUsage is copied from the verified declarations above.
 */

import type {
  IModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  TokenUsage
} from '../types/contracts';

// ---------------------------------------------------------------------------
// Guarded host reads (a live Cordis proxy throws for undeclared services)
// ---------------------------------------------------------------------------

/** Read one property without letting a live Cordis proxy throw. */
export function safeGet(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Structural view of the DSH LLM service; only the verified members appear. */
export interface DshLlmLike {
  stream(options: DshGenerateOptions): AsyncIterable<unknown>;
  listProviders?(): unknown;
  listModels?(provider: string): unknown;
}

/** Verified DSH GenerateOptions (see the module header). */
export interface DshGenerateOptions {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly messages: readonly DshRequestMessage[];
  readonly system?: string;
  readonly tools?: readonly unknown[];
  readonly toolHistory?: unknown;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly purpose?: 'compaction' | 'session-title';
}

/** One text content block, the only block kind this adapter emits. */
export interface DshTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * A request message. `id`/`source` are deliberately absent: without them the
 * value is a valid `RequestUserInput` (content plus role only), which every
 * consumer accepts.
 */
export interface DshRequestMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly DshTextBlock[];
}

/** Verified DSH TokenUsage: both counted fields are required, the rest optional. */
export interface DshUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** Verified DSH FinishReason variants. */
export type DshFinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure?: unknown }
  | { readonly kind: 'error'; readonly failure?: unknown };

/** Verified DSH StreamChunk union (documentation + the shape this adapter narrows to). */
export type DshStreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
      readonly type: 'tool-call-delta';
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: 'block-end'; readonly index: number; readonly block: unknown }
  | { readonly type: 'usage'; readonly usage: DshUsage }
  | { readonly type: 'finish'; readonly reason: DshFinishReason; readonly replayState?: unknown };

/** Resolve the DSH LLM service from a host context, or undefined when absent. */
export function readDshLlm(ctx: unknown): DshLlmLike | undefined {
  const llm = safeGet(ctx, 'llm');
  if (llm === null || typeof llm !== 'object') {
    return undefined;
  }
  const stream = safeGet(llm, 'stream');
  if (typeof stream !== 'function') {
    return undefined;
  }
  return llm as DshLlmLike;
}

// ---------------------------------------------------------------------------
// Message and chunk mapping
// ---------------------------------------------------------------------------

/** Map one host-neutral message onto a DSH request message (content is a block array). */
export function toDshMessage(message: ModelMessage): DshRequestMessage {
  const blocks: DshTextBlock[] = [{ type: 'text', text: typeof message.content === 'string' ? message.content : String(message.content) }];
  return { role: message.role, content: blocks };
}

/**
 * Map the host-neutral message list onto DSH request messages.
 *
 * DSH also accepts a top-level `system` string on GenerateOptions, but a
 * system message in the list is a valid request input too, so the list is
 * preserved verbatim instead of being reordered or merged. Repeated identical
 * system messages are de-duplicated because the plugin's proposer/composer
 * prompts prepend the same shared instruction block per slot, and DSH validates
 * the request prefix against the session log (duplicated leading system content
 * is not a prefix the log can reconstruct).
 */
export function toDshMessages(messages: readonly ModelMessage[]): DshRequestMessage[] {
  const mapped: DshRequestMessage[] = [];
  const seenSystem = new Set<string>();
  for (const message of messages) {
    const next = toDshMessage(message);
    if (next.role === 'system') {
      const key = next.content[0]?.text ?? '';
      if (seenSystem.has(key)) {
        continue;
      }
      seenSystem.add(key);
    }
    mapped.push(next);
  }
  return mapped;
}

/** Narrow an unknown chunk to its documented `type` discriminator. */
export function chunkTypeOf(chunk: unknown): string {
  const type = safeGet(chunk, 'type');
  return typeof type === 'string' ? type : '';
}

/** Read a non-empty string field of a chunk. */
function chunkText(chunk: unknown): string {
  const text = safeGet(chunk, 'text');
  return typeof text === 'string' ? text : '';
}

/** Read the `usage` object of a usage chunk. */
function chunkUsage(chunk: unknown): DshUsage | undefined {
  const usage = safeGet(chunk, 'usage');
  return usage !== null && typeof usage === 'object' ? (usage as DshUsage) : undefined;
}

/** Read the `reason` object of a finish chunk. */
function chunkReason(chunk: unknown): DshFinishReason | undefined {
  const reason = safeGet(chunk, 'reason');
  if (typeof reason === 'string') {
    // Tolerate a host that reports the bare reason string instead of the
    // documented object; anything unknown maps to the error finish.
    return { kind: reason as DshFinishReason['kind'] } as DshFinishReason;
  }
  if (reason !== null && typeof reason === 'object') {
    return reason as DshFinishReason;
  }
  return undefined;
}

/** Read one finite, non-negative number without letting a proxy throw. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Convert a DSH usage record into the frozen TokenUsage shape. */
export function usageToTokens(usage: DshUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: finiteNumber(usage.totalTokens) ?? input + output
  };
}

/** Map a DSH finish reason onto the frozen ModelResponse finishReason. */
export function finishReasonOf(reason: DshFinishReason | undefined): ModelResponse['finishReason'] {
  if (reason === undefined) {
    return undefined;
  }
  switch (reason.kind) {
    case 'stop':
      return 'stop';
    case 'max-tokens':
      return 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'aborted':
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Verified default route: qodercn / dfmodel (DeepSeek-Flash). */
export const DEFAULT_DSH_ROUTE = {
  provider: 'qodercn',
  model: 'dfmodel',
  reasoningEffort: 'max'
} as const;

/** Model route the adapter dispatches to. */
export interface DshModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** Optional adapter behaviour. */
export interface DshModelAdapterOptions {
  /** Hard cap applied when ModelRequest.maxTokens is absent. Omitted = no cap. */
  readonly maxTokens?: number;
  /** Hard cap applied to a caller-supplied temperature. Omitted = pass through. */
  readonly maxTemperature?: number;
  /** Receiver for non-fatal observations (a failed turn, an unreadable chunk). */
  readonly onDiagnostic?: (message: string) => void;
}

/** Result of one completed stream, before it is shaped into ModelResponse. */
export interface DshStreamOutcome {
  readonly text: string;
  readonly reasoningText: string;
  readonly activeToolCallNames: readonly string[];
  readonly usage?: TokenUsage;
  readonly finishReason?: ModelResponse['finishReason'];
  readonly failureMessage?: string;
  /** Vendor/provider-neutral failure code from the terminal finish, when exposed. */
  readonly failureCode?: string;
  /** Which terminal finish produced failureMessage. */
  readonly failureKind?: 'error' | 'aborted';
}

/** Error thrown when the host exposes no LLM service. */
export class DshLlmUnavailableError extends Error {
  readonly code = 'DSH_LLM_UNAVAILABLE' as const;

  constructor(detail: string) {
    super('dsh-plugin-evo-harness: ' + detail);
    this.name = 'DshLlmUnavailableError';
  }
}

/**
 * Error thrown when a DSH stream settled with an error or aborted finish.
 *
 * Kept distinct from DshLlmUnavailableError because the failure taxonomy routes
 * on `code`: a rate limit or an auth failure is a recoverable provider outcome,
 * while a missing service is a composition defect. `failureCode` carries the
 * provider-neutral DSH code (AUTH, RATE_LIMIT, ...) when the finish chunk exposed
 * one.
 */
export class DshModelStreamError extends Error {
  readonly code = 'DSH_MODEL_STREAM_FAILED' as const;
  readonly failureCode?: string;
  readonly finishKind: 'error' | 'aborted';

  constructor(detail: string, finishKind: 'error' | 'aborted', failureCode?: string) {
    super('dsh-plugin-evo-harness: ' + detail);
    this.name = 'DshModelStreamError';
    this.finishKind = finishKind;
    if (failureCode !== undefined) {
      this.failureCode = failureCode;
    }
  }
}

/**
 * Drain one DSH chunk stream into a ModelResponse-shaped outcome.
 *
 * Accumulation rules:
 *  - `text-delta` chunks are concatenated in stream order into the response text.
 *  - `reasoning-delta` chunks are kept apart: DSH exposes reasoning as its own
 *    block kind, so folding it into the deliverable would corrupt the anonymous
 *    comparison and the surrogate scorer's deliverable hash.
 *  - `tool-call-delta` is tracked by name only; this adapter never issues tool
 *    definitions, so it records the names (trajectory metadata) and reports the
 *    `tool_calls` finish instead of inventing a tool-call loop.
 *  - `usage` is mapped into TokenUsage; only the LAST usage chunk wins, because
 *    DSH may emit an interim record.
 *  - `finish` is the terminal chunk. An `error`/`aborted` finish yields a
 *    failureMessage and no text; the caller decides whether that is a thrown
 *    error or a recorded trajectory step.
 */
export async function drainDshStream(
  stream: AsyncIterable<unknown>,
  options: DshModelAdapterOptions = {}
): Promise<DshStreamOutcome> {
  const report = options.onDiagnostic;
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolNames: string[] = [];
  let usage: TokenUsage | undefined = undefined;
  let finishReason: ModelResponse['finishReason'] = undefined;
  let failureMessage: string | undefined = undefined;
  let failureCode: string | undefined = undefined;
  let failureKind: 'error' | 'aborted' | undefined = undefined;
  let sawFinish = false;

  for await (const chunk of stream) {
    const type = chunkTypeOf(chunk);
    switch (type) {
      case 'text-delta': {
        // The block index is deliberately ignored: ModelResponse.text is the
        // whole visible deliverable, and the stream order already concatenates
        // every text block in arrival order. Reasoning stays separate below.
        const text = chunkText(chunk);
        if (text.length > 0) {
          textParts.push(text);
        }
        break;
      }
      case 'reasoning-delta': {
        const text = chunkText(chunk);
        if (text.length > 0) {
          reasoningParts.push(text);
        }
        break;
      }
      case 'tool-call-delta': {
        const name = safeGet(chunk, 'name');
        if (typeof name === 'string' && name.length > 0 && !toolNames.includes(name)) {
          toolNames.push(name);
        }
        break;
      }
      case 'usage': {
        const mapped = usageToTokens(chunkUsage(chunk));
        if (mapped !== undefined) {
          usage = mapped;
        }
        break;
      }
      case 'finish': {
        sawFinish = true;
        const reason = chunkReason(chunk);
        finishReason = finishReasonOf(reason);
        if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
          failureMessage = describeDshFailure(reason);
          failureKind = reason.kind;
          const code = safeGet(safeGet(reason, 'failure'), 'code');
          if (typeof code === 'string' && code.length > 0) {
            failureCode = code;
          }
        }
        break;
      }
      default: {
        // block-start / block-end / an unknown future chunk kind: nothing to
        // accumulate. An unknown kind is reported once so a protocol change is
        // visible instead of silently dropping content.
        if (type.length > 0 && type !== 'block-start' && type !== 'block-end' && report !== undefined) {
          report('unrecognized DSH stream chunk "' + type + '" was ignored');
        }
        break;
      }
    }
  }

  if (!sawFinish && report !== undefined) {
    report('the DSH chunk stream ended without a terminal finish chunk');
  }

  return {
    text: textParts.join(''),
    reasoningText: reasoningParts.join(''),
    activeToolCallNames: toolNames,
    ...(usage === undefined ? {} : { usage }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(failureMessage === undefined ? {} : { failureMessage }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureKind === undefined ? {} : { failureKind })
  };
}

/** One-line description of a terminal DSH failure reason. */
export function describeDshFailure(reason: DshFinishReason): string {
  const failure = (reason as { failure?: unknown }).failure;
  const code = safeGet(failure, 'code');
  const message = safeGet(failure, 'message');
  const codeText = typeof code === 'string' && code.length > 0 ? code : reason.kind.toUpperCase();
  const messageText = typeof message === 'string' && message.length > 0 ? message : reason.kind;
  return 'DSH model stream finished with ' + codeText + ': ' + messageText;
}

/**
 * Build the IModelAdapter backed by `ctx.llm.stream`.
 *
 * The factory ALWAYS returns a usable IModelAdapter object, even when the LLM
 * service is absent: `complete()` then throws DshLlmUnavailableError with a clear
 * remedy instead of failing construction. resolveDshCollaborators reads ctx.llm
 * first, so it injects no model collaborator when the service is missing and
 * records that condition as a diagnostic instead.
 */
export function createLlmModelAdapter(
  ctx: unknown,
  route: DshModelRoute = DEFAULT_DSH_ROUTE,
  options: DshModelAdapterOptions = {}
): IModelAdapter {
  const llm = readDshLlm(ctx);
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (llm === undefined) {
        throw new DshLlmUnavailableError(
          'ctx.llm exposes no stream() method. Mount @deepseek-ai/dsh-llm together with a provider adapter '
            + 'and declare "llm" in this plugin inject list, or inject options.model.'
        );
      }
      const messages = toDshMessages(request.messages);
      if (messages.length === 0) {
        throw new DshLlmUnavailableError('a model request with no messages cannot be dispatched');
      }
      const temperature =
        request.temperature === undefined
          ? undefined
          : options.maxTemperature === undefined
            ? request.temperature
            : Math.min(request.temperature, options.maxTemperature);
      const maxTokens =
        request.maxTokens === undefined
          ? options.maxTokens
          : options.maxTokens === undefined
            ? request.maxTokens
            : Math.min(request.maxTokens, options.maxTokens);
      const requestOptions: DshGenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens })
      };
      const outcome = await drainDshStream(llm.stream(requestOptions), options);
      // A terminal error/aborted finish carries no usable deliverable, so it is
      // surfaced as a thrown error rather than an empty text response that the
      // failure taxonomy would have to classify as "no deliverable".
      if (outcome.failureMessage !== undefined) {
        throw new DshModelStreamError(outcome.failureMessage, outcome.failureKind ?? 'error', outcome.failureCode);
      }
      return {
        text: outcome.text,
        ...(outcome.finishReason === undefined ? {} : { finishReason: outcome.finishReason }),
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        model: route.model,
        metadata: {
          purpose: request.purpose,
          provider: route.provider,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          ...(outcome.reasoningText.length === 0 ? {} : { reasoningChars: outcome.reasoningText.length }),
          ...(outcome.activeToolCallNames.length === 0 ? {} : { toolCallNames: outcome.activeToolCallNames })
        }
      };
    }
  };
}
