/**
 * Error-edge tests for src/dsh-bridge/model.ts.
 *
 * The module header states two host facts the existing pr3a suite does not pin
 * (cross-audit TEST-1 residual): a stream that THROWS before any finish chunk is
 * "NOT a protocol settlement and must not be reported as one", and a stream
 * "ALWAYS ends in exactly one 'finish' chunk" — so the extra-chunk shapes below
 * pin the deterministic behaviour of the defensive path.
 *
 * No real host is involved: every case feeds a plain async iterable to
 * drainDshStream, or a fake ctx.llm whose stream() returns one.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DSH_ROUTE,
  DshModelStreamError,
  createLlmModelAdapter,
  drainDshStream,
  type RawUsageCarrier
} from '../../../src/dsh-bridge/model';

/** A chunk source that throws after yielding `before` chunks. */
async function* throwingStream(
  before: readonly unknown[],
  failure: Error
): AsyncIterable<unknown> {
  for (const chunk of before) {
    yield chunk;
  }
  throw failure;
}

describe('drainDshStream — a stream that throws before any finish is not a settlement', () => {
  it('propagates the throw and never reports a finish reason', async () => {
    const diagnostics: string[] = [];
    const failure = new Error('consumer exploded after two deltas');
    const stream = throwingStream(
      [
        { type: 'text-delta', index: 0, text: 'partial ' },
        { type: 'text-delta', index: 0, text: 'answer' }
      ],
      failure
    );

    await expect(drainDshStream(stream, { onDiagnostic: (message) => diagnostics.push(message) })).rejects.toThrow(
      'consumer exploded after two deltas'
    );
    // The "ended without a terminal finish chunk" notice belongs to a stream
    // that ENDED; a throw does not produce that observation.
    expect(diagnostics).toEqual([]);
  });

  it('does not mislabel a thrown stream as a completed model response', async () => {
    const received: RawUsageCarrier[] = [];
    const ctx = {
      llm: {
        stream: () =>
          throwingStream([{ type: 'text-delta', index: 0, text: 'half a sentence' }], new Error('listener failed'))
      }
    };
    const adapter = createLlmModelAdapter(ctx, DEFAULT_DSH_ROUTE, {
      onRawUsage: (carrier) => received.push(carrier)
    });

    await expect(
      adapter.complete({ purpose: 'probe', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('listener failed');

    // The bypass carrier recorded the failure honestly: no raw usage, an ERROR
    // finish and NOT a stop/tool-calls settlement.
    expect(received).toHaveLength(1);
    expect(received[0]?.rawUsage).toBeUndefined();
    expect(received[0]?.finishReason).toMatchObject({ kind: 'error' });
  });
});

describe('drainDshStream — duplicate / trailing finish chunks', () => {
  it('the LAST finish chunk wins for the finish verdict when a stream settles twice', async () => {
    // The host contract is exactly one finish; this pins the extra-chunk
    // behaviour so a future refactor cannot silently read the FIRST one.
    const outcome = await drainDshStream(
      (async function* () {
        yield { type: 'text-delta', index: 0, text: 'done' };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })()
    );

    expect(outcome.text).toBe('done');
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.rawFinishReason).toEqual({ kind: 'stop' });
    expect(outcome.failureMessage).toBeUndefined();
  });

  it('a failure finish is STICKY: an earlier error keeps failing the call even after a later stop', async () => {
    // Pinned fact (not an endorsement): the finish verdict is last-wins, but the
    // failure fields are recorded by the first error/aborted finish and never
    // cleared by a later one. Because the host contract promises exactly one
    // terminal chunk this only describES a protocol-violating stream, and the
    // sticky failure is the safer reading: the call DID fail at some point.
    const outcome = await drainDshStream(
      (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })()
    );

    expect(outcome.finishReason).toBe('stop');
    expect(outcome.failureKind).toBe('error');
    expect(outcome.failureMessage).toContain('RATE_LIMIT');
    expect(outcome.failureCode).toBe('RATE_LIMIT');
  });

  it('the adapter throws DshModelStreamError for a sticky failure finish', async () => {
    const adapter = createLlmModelAdapter({
      llm: {
        stream: () =>
          (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })()
      }
    });
    await expect(
      adapter.complete({ purpose: 'probe', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/DSH_MODEL_STREAM_FAILED|DSH model stream finished with AUTH/);
  });

  it('a trailing error finish turns an otherwise clean stream into a stream error', async () => {
    const adapter = createLlmModelAdapter({
      llm: {
        stream: () =>
          (async function* () {
            yield { type: 'text-delta', index: 0, text: 'visible text' };
            yield { type: 'finish', reason: { kind: 'stop' } };
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'CANCELLED' } } };
          })()
      }
    });

    const error = await adapter
      .complete({ purpose: 'probe', messages: [{ role: 'user', content: 'hi' }] })
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      );
    expect(error).toBeInstanceOf(DshModelStreamError);
    expect((error as DshModelStreamError).finishKind).toBe('aborted');
    expect((error as DshModelStreamError).failureCode).toBe('CANCELLED');
  });
});

describe('drainDshStream — a stream that ends without a finish', () => {
  it('reports the missing settlement and keeps the accumulated text', async () => {
    const diagnostics: string[] = [];
    const outcome = await drainDshStream(
      (async function* () {
        yield { type: 'text-delta', index: 0, text: 'truncated' };
      })(),
      { onDiagnostic: (message) => diagnostics.push(message) }
    );

    expect(diagnostics.join(' ')).toContain('ended without a terminal finish chunk');
    expect(outcome.text).toBe('truncated');
    // No finish chunk => no finish reason, and crucially no failure claim: the
    // adapter never invents a settlement the host did not send.
    expect(outcome.finishReason).toBeUndefined();
    expect(outcome.rawFinishReason).toBeUndefined();
    expect(outcome.failureMessage).toBeUndefined();
  });
});

describe('finish mapping and failure description', () => {
  it('maps every documented finish kind onto the frozen ModelResponse shape', async () => {
    const cases: ReadonlyArray<readonly [string, string | undefined]> = [
      ['stop', 'stop'],
      ['max-tokens', 'length'],
      ['tool-calls', 'tool_calls'],
      ['aborted', 'error'],
      ['error', 'error']
    ];
    for (const [kind, expected] of cases) {
      const outcome = await drainDshStream(
        (async function* () {
          yield { type: 'finish', reason: { kind } };
        })()
      );
      expect(outcome.finishReason, kind).toBe(expected);
    }
  });

  it('keeps an unknown bare-string finish reason as a defensive unknown verdict', async () => {
    const outcome = await drainDshStream(
      (async function* () {
        yield { type: 'finish', reason: 'something-new' };
      })()
    );
    expect(outcome.finishReason).toBe('unknown');
    expect(outcome.rawFinishReason).toEqual({ kind: 'something-new' });
  });
});
