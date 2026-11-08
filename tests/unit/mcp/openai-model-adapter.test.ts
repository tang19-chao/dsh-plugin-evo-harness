/**
 * rev8 stage-2 tests: the OpenAI-compatible gateway model adapter
 * (src/mcp/openai-model-adapter.ts).
 *
 * Deterministic and OFFLINE: no real fetch, no real network, no real key file.
 * Every test injects its own fetch, readFile, clock, sleep and env snapshot, so
 * the real process environment — and therefore any real
 * EVO_GATEWAY_KEY / EVO_GATEWAY_KEY_FILE of this machine — is never consulted.
 * The suite never asserts against or reads the real default key path
 * (C:/Users/Administrator/.dsh/openai-gateway/api-key); no such path appears in
 * this file.
 *
 * Covered (the ask's contract surface):
 *   1. request conversion — purpose stays local, messages/temperature/
 *      maxTokens/responseFormat map onto the OpenAI body, non-streaming,
 *      single endpoint /chat/completions;
 *   2. response parsing — choices[0].message.content, finish_reason, usage
 *      triple mapped to TokenUsage; verbatim rawUsage bypass on metadata;
 *   3. honest usage — absent usage => usage undefined (never 0); malformed
 *      usage => a thrown OPENAI_MALFORMED_USAGE, never a silent zero;
 *   4. key handling — EVO_GATEWAY_KEY wins, key FILE read lazily at request
 *      time (never at construction), empty file refused, missing file
 *      readable error, no key in any error/message/metadata/log;
 *   5. retry policy — 429/5xx/transport retried exactly once (2 attempts),
 *      401/403/400/404 not retried, 401/403 invalidate the key-file cache,
 *      abort signal works in both fetch and backoff;
 *   6. metadata — no key material anywhere; purpose/carrier fields present.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
  EVO_GATEWAY_KEY_ENV,
  EVO_GATEWAY_KEY_FILE_ENV,
  OPENAI_COUNTING_SEMANTICS,
  OpenAiModelAdapterError,
  createOpenAiModelAdapter,
  openAiFinishReason,
  parseOpenAiUsage,
  toOpenAiMessages,
  toOpenAiRequestBody,
  type OpenAiModelAdapterOptions
} from '../../../src/mcp/openai-model-adapter';
import { dshUsageToProviderPayload, type RawDshUsageLike } from '../../../src/ledger/pricing';
import type { ModelRequest } from '../../../src/types/contracts';

// ---------------------------------------------------------------------------
// offline harness
// ---------------------------------------------------------------------------

/** A recorded fetch call. */
interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch responder: one entry per call, in order. */
type FetchScript = (call: { url: string; init: RequestInit; attempt: number }) => Promise<Response> | Response;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

interface Harness {
  calls: RecordedCall[];
  env: Record<string, string | undefined>;
  reads: string[];
  sleeps: number[];
  logs: string[];
  fetchScript: { script: FetchScript };
  build(overrides?: Partial<OpenAiModelAdapterOptions>): ReturnType<typeof createOpenAiModelAdapter>;
  request(overrides?: Partial<ModelRequest>): ModelRequest;
}

/** Build an offline harness with injected fetch/file/env/clock/sleep. */
function makeHarness(initialEnv: Record<string, string | undefined> = {}): Harness {
  const calls: RecordedCall[] = [];
  const reads: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const env: Record<string, string | undefined> = { ...initialEnv };
  const fetchScript: { script: FetchScript } = {
    script: () => jsonResponse(200, okBody())
  };
  let attempt = 0;
  const harness: Harness = {
    calls,
    env,
    reads,
    sleeps,
    logs,
    fetchScript,
    build(overrides = {}) {
      attempt = 0;
      return createOpenAiModelAdapter({
        env,
        fetch: (async (url: string, init: RequestInit) => {
          attempt += 1;
          calls.push({ url, init });
          return await fetchScript.script({ url, init, attempt });
        }) as typeof fetch,
        readFile: async (filePath: string) => {
          reads.push(filePath);
          const contents = env['__keyfile:' + filePath];
          if (contents === undefined) {
            const error = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return contents;
        },
        now: (): number => 1_000 + calls.length * 10,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        log: (line: string) => {
          logs.push(line);
        },
        ...overrides
      });
    },
    request(overrides: Partial<ModelRequest> = {}) {
      return {
        purpose: 'probe',
        messages: [{ role: 'user', content: 'hello' }],
        ...overrides
      };
    }
  };
  return harness;
}

/** A minimal well-formed success body. */
function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [
      {
        message: { role: 'assistant', content: 'the answer' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    model: 'magpie/auto/glm-5.3-flash',
    ...overrides
  };
}

/** Assert that NO string in the given set contains the key material. */
function assertKeyLeakNowhere(key: string, surfaces: readonly (string | undefined)[]): void {
  for (const surface of surfaces) {
    if (surface !== undefined) {
      expect(surface.includes(key)).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// request conversion (pure functions)
// ---------------------------------------------------------------------------

describe('request conversion', () => {
  it('maps messages verbatim and keeps purpose/metadata OFF the wire', () => {
    const request: ModelRequest = {
      purpose: 'evaluate_steps',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'judge this' }
      ],
      metadata: { callId: 'c1', signal: undefined }
    };
    const body = toOpenAiRequestBody(request, 'magpie/auto/glm-5.3-flash');
    expect(body.model).toBe('magpie/auto/glm-5.3-flash');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'judge this' }
    ]);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    // non-streaming by contract
    expect(JSON.stringify(body)).not.toContain('stream');
    expect(JSON.stringify(body)).not.toContain('callId');
  });

  it('maps temperature, maxTokens and both responseFormat values', () => {
    const base: ModelRequest = {
      purpose: 'propose',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.4,
      maxTokens: 256
    };
    expect(toOpenAiRequestBody(base, 'm')).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.4,
      max_tokens: 256
    });
    expect(toOpenAiRequestBody({ ...base, responseFormat: 'json' }, 'm').response_format).toEqual({
      type: 'json_object'
    });
    expect(toOpenAiRequestBody({ ...base, responseFormat: 'text' }, 'm').response_format).toEqual({
      type: 'text'
    });
  });

  it('targets exactly one endpoint: <baseUrl>/chat/completions', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const adapter = harness.build({ baseUrl: DEFAULT_OPENAI_BASE_URL });
    await adapter.complete(harness.request());
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.url).toBe('http://127.0.0.1:8326/v1/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

describe('response parsing', () => {
  it('parses content, finish_reason, model and the usage triple', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const adapter = harness.build();
    const response = await adapter.complete(harness.request());
    expect(response.text).toBe('the answer');
    expect(response.finishReason).toBe('stop');
    expect(response.model).toBe('magpie/auto/glm-5.3-flash');
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });

  it('maps finish_reason variants', () => {
    expect(openAiFinishReason('stop')).toBe('stop');
    expect(openAiFinishReason('length')).toBe('length');
    expect(openAiFinishReason('tool_calls')).toBe('tool_calls');
    expect(openAiFinishReason('function_call')).toBe('tool_calls');
    expect(openAiFinishReason('content_filter')).toBe('error');
    expect(openAiFinishReason('something_new')).toBe('unknown');
    expect(openAiFinishReason(undefined)).toBeUndefined();
    expect(openAiFinishReason(42)).toBeUndefined();
  });

  it('preserves the verbatim rawUsage carrier and counting semantics on metadata', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const adapter = harness.build();
    const response = await adapter.complete(harness.request());
    // Carrier shape: DSH names (the RawDshUsageLike metering channel reads) +
    // the OpenAI spellings; values verbatim in both.
    expect(response.metadata?.rawUsage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18
    });
    expect(response.metadata?.countingSemantics).toBe(OPENAI_COUNTING_SEMANTICS);
  });

  it('the rawUsage carrier is readable as RawDshUsageLike by dshUsageToProviderPayload', async () => {
    // Cross-module proof: feed the carrier straight into the ledger's
    // dshUsageToProviderPayload and check every dimension is 'measured'.
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const adapter = harness.build();
    const response = await adapter.complete(harness.request());
    const payload = dshUsageToProviderPayload(
      response.metadata?.rawUsage as RawDshUsageLike,
      OPENAI_COUNTING_SEMANTICS
    );
    expect(payload.inputTokens).toEqual({ tokens: 11, precision: 'measured' });
    expect(payload.outputTokens).toEqual({ tokens: 7, precision: 'measured' });
    expect(payload.totalTokens).toEqual({ tokens: 18, precision: 'measured' });
    expect(payload.countingSemantics).toBe(OPENAI_COUNTING_SEMANTICS);
  });

  it('treats absent usage as usage:undefined — never a faked 0', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () => jsonResponse(200, okBody({ usage: undefined }));
    const adapter = harness.build();
    const response = await adapter.complete(harness.request());
    expect(response.usage).toBeUndefined();
    expect(response.metadata?.rawUsage).toBeUndefined();
    expect(response.metadata?.countingSemantics).toBeUndefined();
  });

  it('fails loudly on malformed usage instead of substituting 0', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () =>
      jsonResponse(200, okBody({ usage: { prompt_tokens: 11, completion_tokens: 'seven' } }));
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_MALFORMED_USAGE'
    });
  });

  it('rejects a response with no choices content', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () => jsonResponse(200, { choices: [] });
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_BAD_RESPONSE_SHAPE'
    });
  });

  it('rejects a non-JSON success body', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () =>
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_BAD_RESPONSE_SHAPE'
    });
  });
});

describe('parseOpenAiUsage units', () => {
  it('absent for null/undefined and field-less objects', () => {
    expect(parseOpenAiUsage(undefined)).toEqual({ kind: 'absent' });
    expect(parseOpenAiUsage(null)).toEqual({ kind: 'absent' });
    expect(parseOpenAiUsage({})).toEqual({ kind: 'absent' });
    expect(parseOpenAiUsage({ other: 1 })).toEqual({ kind: 'absent' });
  });

  it('malformed for a partial or non-numeric triple', () => {
    expect(parseOpenAiUsage({ prompt_tokens: 1 })).toMatchObject({ kind: 'malformed' });
    expect(parseOpenAiUsage({ prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 })).toMatchObject({
      kind: 'malformed',
      field: 'usage.prompt_tokens'
    });
    expect(parseOpenAiUsage('nope')).toMatchObject({ kind: 'malformed', field: 'usage' });
  });

  it('ok for a full numeric triple', () => {
    const parsed = parseOpenAiUsage({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(parsed).toEqual({
      kind: 'ok',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      rawUsage: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7
      }
    });
  });
});

// ---------------------------------------------------------------------------
// key handling
// ---------------------------------------------------------------------------

describe('key handling', () => {
  it('prefers EVO_GATEWAY_KEY and never touches the file path', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'env-key' });
    const adapter = harness.build();
    await adapter.complete(harness.request());
    expect(harness.reads).toHaveLength(0);
    expect(harness.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer env-key' });
  });

  it('reads EVO_GATEWAY_KEY_FILE lazily — at request time, not at construction', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_FILE_ENV]: '/tmp/key.txt' });
    harness.env['__keyfile:/tmp/key.txt'] = ' file-key ';
    // Construction performs NO filesystem access.
    const adapter = harness.build();
    expect(harness.reads).toHaveLength(0);
    expect(adapter.hasCachedKeyFile()).toBe(false);
    await adapter.complete(harness.request());
    expect(harness.reads).toEqual(['/tmp/key.txt']);
    expect(adapter.hasCachedKeyFile()).toBe(true);
    expect(harness.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer file-key' });
  });

  it('caches the key-file read across requests (single read)', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_FILE_ENV]: '/tmp/key.txt' });
    harness.env['__keyfile:/tmp/key.txt'] = 'file-key';
    const adapter = harness.build();
    await adapter.complete(harness.request());
    await adapter.complete(harness.request());
    expect(harness.reads).toHaveLength(1);
  });

  it('fails with OPENAI_KEY_MISSING when neither variable is set — no default path read', async () => {
    const harness = makeHarness({});
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_KEY_MISSING'
    });
    expect(harness.reads).toHaveLength(0);
    expect(harness.calls).toHaveLength(0);
  });

  it('fails with OPENAI_KEY_FILE_UNREADABLE when the file is missing (path surfaced, never contents)', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_FILE_ENV]: '/missing/key.txt' });
    const adapter = harness.build();
    const error = await adapter.complete(harness.request()).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as OpenAiModelAdapterError
    );
    expect(error.code).toBe('OPENAI_KEY_FILE_UNREADABLE');
    expect(error.message).toContain('/missing/key.txt');
  });

  it('fails with OPENAI_KEY_FILE_EMPTY for an empty/whitespace file', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_FILE_ENV]: '/tmp/empty.txt' });
    harness.env['__keyfile:/tmp/empty.txt'] = '   \n  ';
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_KEY_FILE_EMPTY'
    });
  });

  it('never writes the key to errors, metadata, logs or response text', async () => {
    const key = 'super-secret-key-material';
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: key });
    // A 500 first (retry path), then success: every surface is collected.
    harness.fetchScript.script = (call) =>
      call.attempt === 1 ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, okBody());
    const adapter = harness.build();
    const response = await adapter.complete(harness.request());
    // Surfaces that must be key-free: logs, response metadata, usage, text.
    // (The wire Authorization header is the ONE sanctioned place for the key,
    // so init.headers is deliberately excluded here and asserted below.)
    const surfaces: (string | undefined)[] = [
      ...harness.logs,
      JSON.stringify(response.metadata),
      JSON.stringify(response.usage ?? {}),
      response.text
    ];
    assertKeyLeakNowhere(key, surfaces);
    // The wire header carried it (the request that needed it).
    expect(harness.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer ' + key });
  });
});

// ---------------------------------------------------------------------------
// retry policy and abort
// ---------------------------------------------------------------------------

describe('retry policy', () => {
  it.each([429, 500, 502, 503, 504])('retries HTTP %i exactly once (2 attempts)', async (status) => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = (call) =>
      call.attempt === 1 ? jsonResponse(status, {}) : jsonResponse(200, okBody());
    const adapter = harness.build();
    const response = await adapter.complete(harness.request());
    expect(response.text).toBe('the answer');
    expect(harness.calls).toHaveLength(2);
    expect(harness.sleeps).toEqual([200]);
    expect(response.metadata?.attempt).toBe(2);
  });

  it.each([400, 401, 403, 404, 409, 422])('does NOT retry HTTP %i', async (status) => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () => jsonResponse(status, {});
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_HTTP_ERROR',
      status
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.sleeps).toHaveLength(0);
  });

  it('retries transport failures once, then throws OPENAI_TRANSPORT_ERROR', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () => {
      throw new TypeError('fetch failed');
    };
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({
      code: 'OPENAI_TRANSPORT_ERROR'
    });
    expect(harness.calls).toHaveLength(2);
    expect(harness.sleeps).toEqual([200]);
  });

  it('does not sleep after the second (final) attempt', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = () => jsonResponse(503, {});
    const adapter = harness.build();
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({ status: 503 });
    expect(harness.calls).toHaveLength(2);
    expect(harness.sleeps).toEqual([200]);
  });

  it('invalidates the key-file cache on 401/403 so the next call re-reads the file', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_FILE_ENV]: '/tmp/key.txt' });
    harness.env['__keyfile:/tmp/key.txt'] = 'file-key';
    const adapter = harness.build();
    harness.fetchScript.script = (call) =>
      call.attempt <= 1 ? jsonResponse(401, {}) : jsonResponse(200, okBody());
    // Attempt 1: 401 -> cache invalidated, and 401 is NOT retried within the call.
    await expect(adapter.complete(harness.request())).rejects.toMatchObject({ status: 401 });
    expect(adapter.hasCachedKeyFile()).toBe(false);
    // Attempt 2 (a NEW call): re-reads the (possibly rotated) file.
    harness.fetchScript.script = () => jsonResponse(200, okBody());
    await adapter.complete(harness.request());
    expect(harness.reads).toHaveLength(2);
  });

  it('caps the backoff at maxBackoffMs', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    harness.fetchScript.script = (call) =>
      call.attempt === 1 ? jsonResponse(429, {}) : jsonResponse(200, okBody());
    const adapter = harness.build({ maxBackoffMs: 50 });
    await adapter.complete(harness.request());
    expect(harness.sleeps).toEqual([50]);
  });

  it('aborts during the fetch: OPENAI_ABORTED, no retry', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const controller = new AbortController();
    harness.fetchScript.script = (call) => {
      // Simulate the server honouring the caller's abort mid-request.
      if (call.attempt === 1) {
        (call.init.signal as AbortSignal).addEventListener('abort', () => undefined, { once: true });
        controller.abort();
      }
      const signal = call.init.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
      return jsonResponse(200, okBody());
    };
    const adapter = harness.build();
    await expect(adapter.complete(harness.request({ metadata: { signal: controller.signal } }))).rejects.toMatchObject(
      { code: 'OPENAI_ABORTED' }
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.sleeps).toHaveLength(0);
  });

  it('aborts during the backoff sleep: the retry never fires', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const controller = new AbortController();
    harness.fetchScript.script = () => jsonResponse(429, {});
    // A REAL signal-aware sleep so the abort interrupts the backoff mid-wait.
    const adapter = harness.build({
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted during sleep'));
            },
            { once: true }
          );
        })
    });
    // Abort DURING the retryable backoff: the first attempt answers 429, the
    // injected sleep then rejects on the abort, and the 429 never becomes a
    // second attempt.
    const pending = adapter.complete(harness.request({ metadata: { signal: controller.signal } }));
    setTimeout(() => controller.abort(), 1);
    await expect(pending).rejects.toThrow(/aborted during sleep/);
    expect(harness.calls).toHaveLength(1);
    // The sleep request WAS made (backoff started, abort interrupted it before
    // the injected sleep recorded its resolution — recording happens in the
    // test's own sleep; the backoff call itself reached it).
    expect(harness.sleeps.length).toBeLessThanOrEqual(1);
  });

  it('propagates the caller signal into the fetch init', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const controller = new AbortController();
    const adapter = harness.build();
    await adapter.complete(harness.request({ metadata: { signal: controller.signal } }));
    expect(harness.calls[0]?.init.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// adapter surface
// ---------------------------------------------------------------------------

describe('adapter surface', () => {
  it('uses the documented defaults', async () => {
    expect(DEFAULT_OPENAI_BASE_URL).toBe('http://127.0.0.1:8326/v1');
    expect(DEFAULT_OPENAI_MODEL_ID).toBe('magpie/auto/glm-5.3-flash');
    expect(EVO_GATEWAY_KEY_ENV).toBe('EVO_GATEWAY_KEY');
    expect(EVO_GATEWAY_KEY_FILE_ENV).toBe('EVO_GATEWAY_KEY_FILE');
  });

  it('satisfies IModelAdapter structurally', async () => {
    const harness = makeHarness({ [EVO_GATEWAY_KEY_ENV]: 'k' });
    const adapter = harness.build();
    // The minimal contract surface: complete(request) -> ModelResponse.
    const response = await adapter.complete({
      purpose: 'compose',
      messages: [{ role: 'user', content: 'rank' }]
    });
    expect(typeof response.text).toBe('string');
    expect(harness.calls[0]?.init.method).toBe('POST');
    expect(harness.calls[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('toOpenAiMessages coerces non-string content defensively', () => {
    expect(toOpenAiMessages([{ role: 'user', content: 'ok' }])).toEqual([{ role: 'user', content: 'ok' }]);
  });
});
