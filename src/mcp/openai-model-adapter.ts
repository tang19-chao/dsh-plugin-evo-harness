/**
 * OpenAI-compatible gateway model adapter (rev8 plan §5.4, stage 2).
 *
 * WHAT THIS IS
 *   The IModelAdapter the MCP server process injects as `options.model`: a
 *   non-streaming POST to ONE endpoint on the local dsh-providers-hub
 *   OpenAI-compatible gateway, `{baseUrl}/chat/completions`. With the default
 *   baseUrl the full URL is `http://127.0.0.1:8326/v1/chat/completions` (plan
 *   §5.4; the gateway's parseModelRoute splits the model field on the FIRST '/',
 *   so the full `magpie/auto/glm-5.3-flash` id travels in the body's `model`
 *   field, never in the URL path).
 *
 *   Streaming is deliberately NOT used: the request never sets `stream`, and a
 *   response whose body is not a JSON object is an error, not a parse-over.
 *
 * KEY HANDLING (the ask's security constraints)
 *   - The key comes from `EVO_GATEWAY_KEY` or, failing that, the file named by
 *     `EVO_GATEWAY_KEY_FILE`. It lives only in this module's memory.
 *   - The FILE is read LAZILY — at request time, and at most once per adapter
 *     unless a request fails 401/403 (below) — never at construction time, so
 *     constructing an adapter never touches the filesystem.
 *   - The key is sent ONLY as the `Authorization: Bearer <key>` header of the
 *     chat-completions request. It is never written to an error message, a
 *     thrown error's fields, a parsed response, the console, a log line, a
 *     response `metadata` record, or any file.
 *   - The adapter NEVER reads any default key path on its own: without
 *     EVO_GATEWAY_KEY and EVO_GATEWAY_KEY_FILE it constructs fine and fails at
 *     request time with a named error. The plan's documented default path
 *     (`C:/Users/Administrator/.dsh/openai-gateway/api-key`) appears NOWHERE in
 *     this module — the operator writes it into the config env block (plan
 *     §5.5).
 *
 * USAGE ACCOUNTING (the "never fake 0" rule)
 *   The gateway's OpenAI response carries `usage: {prompt_tokens,
 *   completion_tokens, total_tokens}`. The mapping is lossless and honest:
 *   - A finite, non-negative usage triple becomes the frozen `TokenUsage`
 *     (inputTokens/outputTokens/totalTokens) AND is preserved verbatim on
 *     `metadata.rawUsage` — the same lossless bypass channel
 *     `createMeteredModelAdapter` reads (`response.metadata?.rawUsage` in
 *     src/dsh-bridge/metered-model-adapter.ts:623) — together with
 *     `countingSemantics` stating the OpenAI convention
 *     (prompt_tokens includes cached tokens) only because it is a DOCUMENTED
 *     OpenAI field convention, not a guessed DSH shape.
 *   - A response without `usage`, or with any field missing/non-finite, maps to
 *     `usage: undefined` (and rawUsage undefined): the ledger then records
 *     provenance 'unknown' with its conservative floor
 *     (src/ledger/pricing.ts:293-303 returns precision 'unknown' rather than
 *     inventing tokens). The adapter NEVER substitutes 0 for an unreported
 *     number.
 *   - A malformed value that is present but not a usable number makes the call
 *     FAIL loudly rather than silently downgrading to unknown — a gateway that
 *     promises usage but returns garbage is an infrastructure problem.
 *
 * RETRY / ABORT (the ask's policy)
 *   - Retried ONCE (at most 2 attempts total), and only for: HTTP 429, any
 *     5xx, and network-level transport failures (fetch rejects without a
 *     response). 401/403/400/404 and every other 4xx are NOT retried.
 *   - A 401/403 response (wrong key) invalidates the lazily cached key-file
 *     read so the next request re-reads the file (an operator may have rotated
 *     it).
 *   - The backoff between attempts honours the caller's AbortSignal: an aborted
 *     signal interrupts the sleep and the in-flight fetch aborts via the same
 *     signal.
 *   - All injectable for offline tests: fetch, readFile, clock/now, sleep, and
 *     the env snapshot. None of the injectables are read from process state at
 *     module load; the defaults wire to Node 20's global fetch and node:fs.
 */

import { readFile as fsReadFile } from 'node:fs/promises';

import type {
  IModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  TokenUsage
} from '../types/contracts';
import type { CountingSemantics } from '../ledger/types';

// ---------------------------------------------------------------------------
// defaults and public option types
// ---------------------------------------------------------------------------

/** Default local gateway base URL (plan §5.4 / §5.5). */
export const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:8326/v1';

/** Default model id: provider segment + model segment, split by the gateway. */
export const DEFAULT_OPENAI_MODEL_ID = 'magpie/auto/glm-5.3-flash';

/** Environment variable carrying the gateway key directly. */
export const EVO_GATEWAY_KEY_ENV = 'EVO_GATEWAY_KEY';

/** Environment variable carrying the PATH of a file that holds the key. */
export const EVO_GATEWAY_KEY_FILE_ENV = 'EVO_GATEWAY_KEY_FILE';

/** OpenAI prompt_tokens includes cached tokens (ledger/types.ts doc line). */
export const OPENAI_COUNTING_SEMANTICS: CountingSemantics = Object.freeze({
  inputIncludesCacheRead: true,
  // The OpenAI chat-completions response documents no reasoning_tokens field on
  // usage; whether completion_tokens hides reasoning is UNVERIFIED for this
  // gateway (plan §5.4 marks the runtime response fields "仍未实测"), so the
  // flag stays false — the honest default the CountingSemantics doc gives for
  // "not documented".
  outputIncludesReasoning: false,
  semanticTag: 'openai-chat-completions-v1'
});

/** Injectable dependencies; every field optional with a production default. */
export interface OpenAiModelAdapterOptions {
  /** Base URL ending at the version segment, e.g. http://127.0.0.1:8326/v1. */
  readonly baseUrl?: string;
  /** Full model id sent in the body's `model` field. */
  readonly model?: string;
  /** Environment snapshot; defaults to process.env (tests pass a fake). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Fetch implementation; defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Key-file reader; defaults to node:fs readFile utf8. */
  readonly readFile?: (filePath: string) => Promise<string>;
  /** Injectable clock (durations, retries). */
  readonly now?: () => number;
  /** Injectable retry sleep; defaults to a signal-aware setTimeout. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Cap on retry backoff (the fixed exponential schedule is clamped to this). */
  readonly maxBackoffMs?: number;
  /** Logger for non-secret diagnostics (request/response outlines). NEVER keyed. */
  readonly log?: (line: string) => void;
}

/** Failure of the adapter; carries a stable machine-readable code. */
export class OpenAiModelAdapterError extends Error {
  readonly code: OpenAiAdapterErrorCode;
  /** HTTP status when the failure came from a response, else undefined. */
  readonly status?: number;
  /** True when the failure is one the adapter's retry policy would retry. */
  readonly retryable: boolean;

  constructor(
    code: OpenAiAdapterErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenAiModelAdapterError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** Stable failure codes; assertions never grep prose. */
export type OpenAiAdapterErrorCode =
  | 'OPENAI_KEY_MISSING'
  | 'OPENAI_KEY_FILE_UNREADABLE'
  | 'OPENAI_KEY_FILE_EMPTY'
  | 'OPENAI_HTTP_ERROR'
  | 'OPENAI_TRANSPORT_ERROR'
  | 'OPENAI_ABORTED'
  | 'OPENAI_BAD_RESPONSE_SHAPE'
  | 'OPENAI_MALFORMED_USAGE';

// ---------------------------------------------------------------------------
// request/response JSON shapes (documented OpenAI chat-completions fields)
// ---------------------------------------------------------------------------

interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: { readonly type: 'text' | 'json_object' };
}

interface ChatCompletionUsageShape {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly total_tokens?: unknown;
}

interface ChatCompletionResponseShape {
  readonly choices?: unknown;
  readonly usage?: unknown;
  readonly model?: unknown;
  readonly error?: unknown;
}

/** Read a property without letting a proxy or a getter throw. */
function safeGet(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A finite, non-negative number, else undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read a string field; a proxy or a non-string yields undefined. */
function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Abort check through a function: no control-flow narrowing can shadow it. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// ---------------------------------------------------------------------------
// finish-reason mapping
// ---------------------------------------------------------------------------

/** Map the OpenAI finish_reason string onto the frozen contract union. */
export function openAiFinishReason(
  raw: unknown
): ModelResponse['finishReason'] {
  if (typeof raw !== 'string') {
    return undefined;
  }
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'error';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// request conversion
// ---------------------------------------------------------------------------

/** Map the host-neutral messages onto OpenAI chat messages (verbatim roles). */
export function toOpenAiMessages(
  messages: readonly ModelMessage[]
): { role: string; content: string }[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : String(message.content)
  }));
}

/** Build the JSON body for one chat-completions request. */
export function toOpenAiRequestBody(request: ModelRequest, model: string): ChatCompletionRequest {
  // `stream` is deliberately absent: this adapter is non-streaming by contract.
  const body: {
    model: string;
    messages: { role: string; content: string }[];
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'text' | 'json_object' };
  } = {
    model,
    messages: toOpenAiMessages(request.messages)
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }
  if (request.responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  } else if (request.responseFormat === 'text') {
    body.response_format = { type: 'text' };
  }
  // request.purpose and request.metadata stay LOCAL: the gateway routes on the
  // model id only, and purpose/metadata must never leak request-scoped fields
  // (call ids, session ids, abort signals) to the wire.
  return body;
}

// ---------------------------------------------------------------------------
// usage parsing — the honest-mapping core
// ---------------------------------------------------------------------------

/** Result of parsing the response's usage object. */
export type ParsedOpenAiUsage =
  | { readonly kind: 'absent' }
  /** Present and fully numeric; verbatim values preserved. */
  | {
      readonly kind: 'ok';
      readonly usage: TokenUsage;
      /**
       * The lossless bypass carrier. DSH field names (inputTokens/…) so the
       * metering channel (metered-model-adapter -> dshUsageToProviderPayload)
       * reads every dimension; the OpenAI spellings travel alongside.
       */
      readonly rawUsage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
      };
    }
  /** Present but any documented field is not a finite non-negative number. */
  | { readonly kind: 'malformed'; readonly field: string; readonly value: unknown };

/**
 * Parse the usage object without ever inventing a 0.
 *
 * - no object / all three fields absent -> 'absent' (usage stays undefined);
 * - any field PRESENT but non-numeric -> 'malformed' (call fails loudly);
 * - otherwise the verbatim triple.
 *
 * An object that carries NONE of the three documented fields is treated as
 * absent (a gateway adding unrelated keys must not break the call); one that
 * carries a SUBSET has a broken usage contract and is malformed.
 */
export function parseOpenAiUsage(raw: unknown): ParsedOpenAiUsage {
  if (raw === undefined || raw === null) {
    return { kind: 'absent' };
  }
  if (typeof raw !== 'object') {
    return { kind: 'malformed', field: 'usage', value: raw };
  }
  const prompt = safeGet(raw, 'prompt_tokens');
  const completion = safeGet(raw, 'completion_tokens');
  const total = safeGet(raw, 'total_tokens');
  const present = [prompt, completion, total].filter((v) => v !== undefined);
  if (present.length === 0) {
    return { kind: 'absent' };
  }
  const promptNumber = finiteNumber(prompt);
  const completionNumber = finiteNumber(completion);
  const totalNumber = finiteNumber(total);
  if (promptNumber === undefined) {
    return { kind: 'malformed', field: 'usage.prompt_tokens', value: prompt };
  }
  if (completionNumber === undefined) {
    return { kind: 'malformed', field: 'usage.completion_tokens', value: completion };
  }
  if (totalNumber === undefined) {
    return { kind: 'malformed', field: 'usage.total_tokens', value: total };
  }
  return {
    kind: 'ok',
    usage: {
      inputTokens: promptNumber,
      outputTokens: completionNumber,
      totalTokens: totalNumber
    },
    rawUsage: {
      // DSH-carrier field names (RawDshUsageLike in src/ledger/pricing.ts), so
      // the lossless bypass channel `createMeteredModelAdapter` reads
      // (src/dsh-bridge/metered-model-adapter.ts:623, via
      // dshUsageToProviderPayload) sees every dimension as 'measured'. The
      // VALUES are the verbatim OpenAI numbers; only the key spelling is the
      // carrier's. The OpenAI spelling is preserved in full below.
      inputTokens: promptNumber,
      outputTokens: completionNumber,
      totalTokens: totalNumber,
      prompt_tokens: promptNumber,
      completion_tokens: completionNumber,
      total_tokens: totalNumber
    }
  };
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

/** Extract the first choice's message content from the parsed response. */
function firstChoiceText(parsed: ChatCompletionResponseShape): {
  text?: string;
  finishReason?: string;
} {
  const choices = safeGet(parsed, 'choices');
  if (!Array.isArray(choices) || choices.length === 0) {
    return {};
  }
  const first = choices[0];
  const message = safeGet(first, 'message');
  const text = safeString(safeGet(message, 'content'));
  const finish = safeString(safeGet(first, 'finish_reason'));
  return {
    ...(text === undefined ? {} : { text }),
    ...(finish === undefined ? {} : { finishReason: finish })
  };
}

/**
 * Create the OpenAI-compatible gateway adapter (non-streaming).
 */
export function createOpenAiModelAdapter(
  options: OpenAiModelAdapterOptions = {}
): IModelAdapter & {
  /** Test/ops seam: whether a lazily read key file is currently cached. */
  readonly hasCachedKeyFile: () => boolean;
  /** Invalidate any cached key-file read (next request re-reads the file). */
  readonly invalidateKeyCache: () => void;
} {
  const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const model = options.model ?? DEFAULT_OPENAI_MODEL_ID;
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const doReadFile = options.readFile ?? ((filePath: string): Promise<string> => fsReadFile(filePath, 'utf8'));
  const now = options.now ?? ((): number => Date.now());
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  const log = options.log;

  if (typeof doFetch !== 'function') {
    throw new Error('createOpenAiModelAdapter: an injectable fetch is required (Node 20 global fetch by default)');
  }

  // The resolved key lives only in this closure. `keyFromFile` is the LAZY
  // cache of the key-file read: populated on first request that needs it,
  // invalidated by 401/403 and by invalidateKeyCache().
  let apiKey: string | undefined = undefined;
  let keySource: 'env' | 'file' | undefined = undefined;
  let keyFromFile: string | undefined = undefined;
  let keyFileRead = false;

  /** Default signal-aware sleep: aborts immediately when the signal fires. */
  const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (isAborted(signal)) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  const sleep = options.sleep ?? defaultSleep;

  const abortError = (signal: AbortSignal | undefined): Error =>
    new OpenAiModelAdapterError('OPENAI_ABORTED', 'request aborted before completion', {
      cause: signal?.reason
    });

  /**
   * Resolve the bearer key WITHOUT leaking it. Returns the key, or a
   * pre-built error. Resolution order: EVO_GATEWAY_KEY, then a lazy read of
   * EVO_GATEWAY_KEY_FILE (cached after the first successful read). No default
   * path exists in this module.
   */
  const resolveKey = async (): Promise<{ key: string } | { error: OpenAiModelAdapterError }> => {
    const direct = env[EVO_GATEWAY_KEY_ENV];
    if (typeof direct === 'string' && direct.length > 0) {
      return { key: direct };
    }
    const keyFilePath = env[EVO_GATEWAY_KEY_FILE_ENV];
    if (typeof keyFilePath !== 'string' || keyFilePath.length === 0) {
      return {
        error: new OpenAiModelAdapterError(
          'OPENAI_KEY_MISSING',
          'no gateway key configured: set ' +
            EVO_GATEWAY_KEY_ENV +
            ' or ' +
            EVO_GATEWAY_KEY_FILE_ENV +
            " (a path); the adapter never reads a default key path"
        )
      };
    }
    if (keyFileRead) {
      // A previously successful read (possibly empty — checked below).
      if (keyFromFile !== undefined && keyFromFile.length > 0) {
        return { key: keyFromFile };
      }
      return {
        error: new OpenAiModelAdapterError(
          'OPENAI_KEY_FILE_EMPTY',
          'the key file exists but is empty: ' + keyFilePath
        )
      };
    }
    let contents: string;
    try {
      contents = await doReadFile(keyFilePath);
    } catch (error) {
      // The PATH is safe to surface; the CONTENTS never are.
      throw new OpenAiModelAdapterError(
        'OPENAI_KEY_FILE_UNREADABLE',
        'the key file named by ' + EVO_GATEWAY_KEY_FILE_ENV + ' could not be read: ' + keyFilePath,
        { cause: error instanceof Error ? error : undefined }
      );
    }
    keyFileRead = true;
    keyFromFile = contents.trim();
    if (keyFromFile.length === 0) {
      return {
        error: new OpenAiModelAdapterError(
          'OPENAI_KEY_FILE_EMPTY',
          'the key file exists but is empty: ' + keyFilePath
        )
      };
    }
    return { key: keyFromFile };
  };

  const logLine = (line: string): void => {
    if (log !== undefined) {
      try {
        log(line);
      } catch {
        // A broken logger must not break the call path.
      }
    }
  };

  const adapter = {
    hasCachedKeyFile: (): boolean => keyFileRead,
    invalidateKeyCache: (): void => {
      keyFileRead = false;
      keyFromFile = undefined;
    },
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const startedAt = now();
      const signal =
        request.metadata?.signal instanceof AbortSignal ? request.metadata.signal : undefined;
      if (isAborted(signal)) {
        throw abortError(signal);
      }
      const body = toOpenAiRequestBody(request, model);
      const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

      let lastError: OpenAiModelAdapterError | undefined = undefined;
      // At most 2 attempts (1 retry), per the ask's policy.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const keyResolution = await resolveKey();
        if ('error' in keyResolution) {
          throw keyResolution.error;
        }

        let response: Response;
        try {
          response = await doFetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + keyResolution.key
            },
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal })
          });
        } catch (error) {
          if (isAborted(signal)) {
            throw abortError(signal);
          }
          lastError = new OpenAiModelAdapterError(
            'OPENAI_TRANSPORT_ERROR',
            'the chat-completions request failed at the transport layer: ' +
              transportMessage(error),
            { retryable: true, cause: error instanceof Error ? error : undefined }
          );
          if (attempt < 2) {
            await backoff(attempt, signal);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          const status = response.status;
          // Drain the error body WITHOUT logging it raw: it may echo request
          // fields; only the status and content-type survive.
          await response.text().catch(() => undefined);
          const retryable = status === 429 || status >= 500;
          lastError = new OpenAiModelAdapterError(
            'OPENAI_HTTP_ERROR',
            'the chat-completions endpoint answered HTTP ' + String(status),
            { status, retryable }
          );
          if (status === 401 || status === 403) {
            // A rejected key invalidates the cached key-file read so a rotated
            // file is picked up on the next request.
            adapter.invalidateKeyCache();
          }
          if (retryable && attempt < 2) {
            await backoff(attempt, signal);
            continue;
          }
          throw lastError;
        }

        let parsed: ChatCompletionResponseShape;
        try {
          parsed = (await response.json()) as ChatCompletionResponseShape;
        } catch (error) {
          throw new OpenAiModelAdapterError(
            'OPENAI_BAD_RESPONSE_SHAPE',
            'the chat-completions endpoint returned a non-JSON body (HTTP ' +
              String(response.status) +
              ')',
            { cause: error instanceof Error ? error : undefined }
          );
        }

        const choice = firstChoiceText(parsed);
        if (choice.text === undefined) {
          throw new OpenAiModelAdapterError(
            'OPENAI_BAD_RESPONSE_SHAPE',
            'the chat-completions response carried no choices[0].message.content'
          );
        }
        const usage = parseOpenAiUsage(safeGet(parsed, 'usage'));
        if (usage.kind === 'malformed') {
          // A gateway that promises usage but returns garbage is an
          // infrastructure failure, NOT a silent zero.
          throw new OpenAiModelAdapterError(
            'OPENAI_MALFORMED_USAGE',
            'the chat-completions response usage field is malformed at "' +
              usage.field +
              '" (non-numeric); refusing to substitute 0'
          );
        }
        const finishReason = openAiFinishReason(choice.finishReason);
        const responseModel = safeString(safeGet(parsed, 'model'));
        const durationMs = Math.max(0, now() - startedAt);
        logLine(
          'openai-model-adapter: ' +
            request.purpose +
            ' attempt ' +
            String(attempt) +
            ' ok in ' +
            String(durationMs) +
            'ms' +
            (usage.kind === 'ok'
              ? ' usage(prompt=' +
                String(usage.rawUsage.prompt_tokens) +
                ',completion=' +
                String(usage.rawUsage.completion_tokens) +
                ')'
              : ' usage(absent)') +
            (lastError !== undefined ? ' after 1 retry' : '')
        );
        return {
          text: choice.text,
          ...(finishReason === undefined ? {} : { finishReason }),
          ...(usage.kind === 'ok' ? { usage: usage.usage } : {}),
          ...(responseModel === undefined ? {} : { model: responseModel }),
          metadata: {
            baseUrl,
            attempt,
            durationMs,
            ...(usage.kind === 'ok'
              ? {
                  rawUsage: usage.rawUsage,
                  countingSemantics: OPENAI_COUNTING_SEMANTICS
                }
              : {}),
            // The purpose travels for the metering trace; the wire request
            // never carried it.
            purpose: request.purpose
          }
          // NO key material appears here or anywhere downstream: the key is
          // used exactly once, in the Authorization header above.
        };
      }
      // Unreachable: both loop exits throw. Kept for exhaustiveness.
      throw lastError ?? new OpenAiModelAdapterError('OPENAI_TRANSPORT_ERROR', 'unreachable retry state');
    }
  } as IModelAdapter & {
    readonly hasCachedKeyFile: () => boolean;
    readonly invalidateKeyCache: () => void;
  };

  /** One retry backoff; honours the abort signal via the injected sleep. */
  async function backoff(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    const base = 200 * Math.pow(2, attempt - 1);
    const delay = Math.min(base, maxBackoffMs);
    logLine('openai-model-adapter: retryable failure, backing off ' + String(delay) + 'ms');
    await sleep(delay, signal);
  }

  return adapter;
}

/** Transport error message WITHOUT any body or header echo (key safety). */
function transportMessage(error: unknown): string {
  if (error instanceof Error) {
    // node's fetch wraps causes: keep names and codes only.
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? error.name + ' (' + code + ')' : error.name;
  }
  return String(error);
}
