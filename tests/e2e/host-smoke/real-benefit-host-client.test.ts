/**
 * rev6 t4: negative + positive controls for the REAL host client binding.
 *
 * The client under test is the PRODUCTION module
 * (`src/dsh-bridge/real-benefit-host-client.ts`); the llm stream / adapter
 * invoke seams are synthetic. No real model call, no network, no memory
 * write. What is proven:
 *
 *   H-1 the desensitized identity: masked account id, never the raw id; the
 *       verifier rejects provider/model/route/mask mismatches (fail-closed).
 *   H-2 the ctx.llm resolution: a stream-capable host service binds; absence
 *       resolves `undefined` (the runner must then fail closed).
 *   H-3 the token hard budget kill switch: a usage chunk above the per-call
 *       cap aborts the stream mid-flight; usage below survives; unreported
 *       usage is never counted (never a measured zero).
 *   H-4 usage honesty: reported fields pass through verbatim; absent fields
 *       stay absent; invalid numbers never contribute to the guard count.
 *   H-5 the adapter path: metadata rawUsage wins over the truncated
 *       TokenUsage; no `.complete()` call exists in this module (the
 *       metering-coverage gate stays at its audited counts).
 *   H-6 the fail-closed wiring into the controller: an unbound client blocks
 *       (`host-client-unbound`), a mismatched identity blocks
 *       (`host-client-identity-mismatch`), and neither makes any call.
 *   H-7 (t4-fix) the per-call cap rides EVERY call: a cap passed on the call
 *       itself kills the stream even with no construction-time option; the
 *       controller passes the binding cap on every real call (wiring by
 *       construction); aborted-finish + usage host signals propagate into
 *       the controller verdict (`token-cap-exceeded`, `aborted_local`);
 *       the adapter surface reports `capIgnored` honestly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canaryUsageTokenCount,
  createHostClientFromAdapter,
  createHostClientFromLlm,
  maskAccountId,
  readZcodeHostClient,
  verifyHostClientIdentity,
  ZCODE_CANARY_TARGET,
  type RealBenefitAdapterInvoke
} from '../../../src/dsh-bridge/real-benefit-host-client';
import {
  evaluateRealBenefitCanary,
  REAL_BENEFIT_ROUTE_ID,
  validateRealBenefitBinding,
  type RealBenefitBinding,
  type RawCanaryUsage
} from '../../../src/dsh-bridge/real-benefit-controller';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RATE_CARD = {
  modelId: 'test-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 3_000
} as const;

const ROUTE = {
  routeId: REAL_BENEFIT_ROUTE_ID,
  maxInputTokens: 2_000,
  maxOutputTokens: 1_000,
  maxReasoningTokens: 0,
  maxNetworkAttempts: 1,
  tokenizerVerified: true,
  providerEnforcesMaxTokens: true,
  allBillableDimensionsPriced: true
} as const;

function makeBinding(): RealBenefitBinding {
  return {
    account: { provider: 'zcode', model: 'GLM-5.3-Flash', accountId: 'acct-0001' },
    generalBudgetMicros: 1_000_000,
    verificationReserveMicros: 0,
    maxConcurrencySeats: 1,
    rateCard: { ...RATE_CARD },
    route: { ...ROUTE },
    readonlyTools: [],
    tokenBudget: { totalTokens: 800_000, perTaskTokens: 500_000, perArmTokens: 300_000, perCallTokens: 200_000 },
    authorization: { grantedBy: 'test-operator', reason: 'unit-test authorization' },
    taskId: 'canary-task-1',
    recordedAdvice: 'prefer the short answer'
  };
}

const IDENTITY = { branchId: 'test-branch-1', sessionId: 'test-session-1' };

/** A synthetic ctx.llm whose stream yields the scripted chunks. */
function llmOf(chunks: readonly unknown[]): { stream: (options: unknown) => AsyncIterable<unknown>; requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    // eslint-disable-next-line require-yield
    stream: (options: unknown): AsyncIterable<unknown> => {
      requests.push(options);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    }
  };
}

const CLIENT_ROUTE = {
  provider: 'zcode',
  model: 'GLM-5.3-Flash',
  routeId: REAL_BENEFIT_ROUTE_ID,
  accountIdMasked: maskAccountId('acct-0001')
};

// ---------------------------------------------------------------------------
// H-1 the desensitized identity
// ---------------------------------------------------------------------------

describe('H-1: the desensitized host-client identity', () => {
  it('masks the account id to its class, never carrying the raw identifier', () => {
    const raw = 'acct-0001-very-long-identifier-x';
    const masked = maskAccountId(raw);
    expect(masked.startsWith('acct')).toBe(true);
    expect(masked).toContain('…');
    expect(masked).toContain('(' + String(raw.length) + ' chars)');
    expect(masked).not.toBe(raw);
  });

  it('verifies a matching client identity with no problems', () => {
    const problems = verifyHostClientIdentity(
      {
        kind: 'ctx-llm',
        provider: 'zcode',
        model: 'GLM-5.3-Flash',
        routeId: REAL_BENEFIT_ROUTE_ID,
        accountIdMasked: maskAccountId('acct-0001')
      },
      { provider: 'zcode', model: 'GLM-5.3-Flash', accountId: 'acct-0001' },
      REAL_BENEFIT_ROUTE_ID
    );
    expect(problems).toEqual([]);
  });

  it('rejects provider/model/route mismatches and a RAW (unmasked) account id', () => {
    const base = {
      kind: 'ctx-llm' as const,
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      routeId: REAL_BENEFIT_ROUTE_ID,
      accountIdMasked: maskAccountId('acct-0001')
    };
    const account = { provider: 'zcode', model: 'GLM-5.3-Flash', accountId: 'acct-0001' };
    expect(verifyHostClientIdentity({ ...base, provider: 'other' }, account, REAL_BENEFIT_ROUTE_ID)).toContain(
      'host-client-provider-mismatch'
    );
    expect(verifyHostClientIdentity({ ...base, model: 'other-model' }, account, REAL_BENEFIT_ROUTE_ID)).toContain(
      'host-client-model-mismatch'
    );
    expect(verifyHostClientIdentity({ ...base, routeId: 'other-route' }, account, REAL_BENEFIT_ROUTE_ID)).toContain(
      'host-client-route-mismatch'
    );
    // The raw id masquerading as a mask is a desensitization failure.
    expect(
      verifyHostClientIdentity({ ...base, accountIdMasked: 'acct-0001' }, account, REAL_BENEFIT_ROUTE_ID)
    ).toContain('host-client-account-not-masked');
    expect(
      verifyHostClientIdentity({ ...base, accountIdMasked: maskAccountId('other-account') }, account, REAL_BENEFIT_ROUTE_ID)
    ).toContain('host-client-account-mask-mismatch');
  });

  it('names the canary target (ZCode GLM-5.3-Flash) for report provenance', () => {
    expect(ZCODE_CANARY_TARGET).toEqual({ host: 'zcode', model: 'GLM-5.3-Flash' });
  });
});

// ---------------------------------------------------------------------------
// H-2 the ctx.llm resolution
// ---------------------------------------------------------------------------

describe('H-2: the ctx.llm resolution is fail-closed', () => {
  it('resolves a client from a stream-capable ctx.llm', () => {
    const ctx = { llm: llmOf([]) };
    const client = readZcodeHostClient(ctx, {
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      routeId: REAL_BENEFIT_ROUTE_ID,
      accountId: 'acct-0001'
    });
    expect(client).toBeDefined();
    expect(client?.identity.kind).toBe('ctx-llm');
    expect(client?.identity.accountIdMasked).toBe(maskAccountId('acct-0001'));
  });

  it('resolves undefined when ctx has no llm or no stream() — the caller must fail closed', () => {
    const rawRoute = {
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      routeId: REAL_BENEFIT_ROUTE_ID,
      accountId: 'acct-0001'
    };
    expect(readZcodeHostClient({}, rawRoute)).toBeUndefined();
    expect(readZcodeHostClient({ llm: {} }, rawRoute)).toBeUndefined();
    expect(readZcodeHostClient(undefined, rawRoute)).toBeUndefined();
    // A live Cordis proxy that THROWS on undeclared reads also resolves
    // undefined (the guarded reader), never a crash.
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('cannot get property "llm" without inject');
        }
      }
    );
    expect(readZcodeHostClient(throwingProxy, rawRoute)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H-3 the token kill switch
// ---------------------------------------------------------------------------

describe('H-3: the per-call token kill switch', () => {
  it('aborts the stream when a usage chunk crosses the cap and still reports verbatim usage', async () => {
    let aborted = false;
    const llm = {
      stream: (options: { signal?: AbortSignal }): AsyncIterable<unknown> => {
        const signal = options.signal;
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 150, outputTokens: 60 } };
          // The kill switch must have fired by now.
          if (signal?.aborted) aborted = true;
          yield { type: 'text-delta', index: 0, text: 'partial' };
          yield { type: 'finish', reason: { kind: 'aborted' } };
        })();
      }
    };
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE, { perCallTokenCap: 100 });
    const outcome = await client.call({ prompt: 'p' });
    expect(aborted).toBe(true);
    expect(outcome.abortedByTokenCap).toBe(true);
    expect(outcome.measuredTokens).toBe(210);
    expect(outcome.usage).toEqual({ inputTokens: 150, outputTokens: 60 });
  });

  it('lets a stream under the cap complete untouched', async () => {
    const llm = llmOf([
      { type: 'usage', usage: { inputTokens: 50, outputTokens: 30 } },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } }
    ]);
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE, { perCallTokenCap: 200 });
    const outcome = await client.call({ prompt: 'p' });
    expect(outcome.abortedByTokenCap).toBe(false);
    expect(outcome.text).toBe('ok');
    expect(outcome.measuredTokens).toBe(80);
    expect(outcome.finishKind).toBe('stop');
  });

  it('never counts unreported usage (nothing measured — no invented zero)', async () => {
    expect(canaryUsageTokenCount(undefined)).toBeUndefined();
    expect(canaryUsageTokenCount({})).toBeUndefined();
    const llm = llmOf([
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } }
    ]);
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE, { perCallTokenCap: 1 });
    const outcome = await client.call({ prompt: 'p' });
    // No usage chunk at all: the cap cannot judge an invented zero, so the
    // stream completes and the measured count stays undefined.
    expect(outcome.abortedByTokenCap).toBe(false);
    expect(outcome.usage).toBeUndefined();
    expect(outcome.measuredTokens).toBeUndefined();
  });

  it('clamps maxTokens into the provider request from the route ceiling', async () => {
    const llm = llmOf([
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } }
    ]);
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE, { maxOutputTokens: 512 });
    await client.call({ prompt: 'p' });
    const request = llm.requests[0] as { maxTokens?: number; provider?: string; model?: string };
    expect(request.maxTokens).toBe(512);
    expect(request.provider).toBe('zcode');
    expect(request.model).toBe('GLM-5.3-Flash');
  });
});

// ---------------------------------------------------------------------------
// H-7 (t4-fix): the per-call cap rides EVERY call — the controller wires the
// kill switch, not the runner's construction choice; host signals propagate.
// ---------------------------------------------------------------------------

describe('H-7: the per-call cap is wired by the controller through each call', () => {
  it('a cap passed ON THE CALL kills the stream even when the client was built with no cap option', async () => {
    let aborted = false;
    const llm = {
      stream: (options: { signal?: AbortSignal }): AsyncIterable<unknown> => {
        const signal = options.signal;
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 150, outputTokens: 60 } };
          if (signal?.aborted) aborted = true;
          yield { type: 'text-delta', index: 0, text: 'partial' };
          yield { type: 'finish', reason: { kind: 'aborted' } };
        })();
      }
    };
    // NO construction-time option: the ONLY cap is the one on the call.
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE);
    const outcome = await client.call({ prompt: 'p', perCallTokenCap: 100 });
    expect(aborted).toBe(true);
    expect(outcome.abortedByTokenCap).toBe(true);
    expect(outcome.measuredTokens).toBe(210);
    expect(outcome.finishKind).toBe('aborted');
  });

  it('the controller passes the binding per-call cap on the real call (wiring by construction)', async () => {
    const llm = {
      stream: (options: { signal?: AbortSignal }): AsyncIterable<unknown> => {
        void options;
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: 'text-delta', index: 0, text: 'ok' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }
    };
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE);
    // Intercept the seam: wrap the client's call to observe what the
    // controller actually passes per call.
    const observed: (number | undefined)[] = [];
    const probe: typeof client = {
      identity: client.identity,
      call: async (input) => {
        observed.push(input.perCallTokenCap);
        return client.call(input);
      }
    };
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: IDENTITY,
      hostClient: probe
    });
    expect(result.calls).toHaveLength(2);
    expect(observed).toEqual([200_000, 200_000]); // the binding's per-call cap, on EVERY call
    expect(result.tokenBudget.perCallCapEnforcedByClient).toBe(true);
  });

  it('a streaming over-cap call settles aborted_local, reports abortedByTokenCap and stops the run (host signal → controller)', async () => {
    const llm = llmOf([
      { type: 'usage', usage: { inputTokens: 150, outputTokens: 60 } },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'aborted' } }
    ]);
    // The runner wiring caps at 100 via the construction option; the
    // controller additionally passes the BINDING cap (200k) on the call — the
    // per-call cap is the SMALLER effective one here (call-level cap wins when
    // it is tighter), so the stream dies mid-flight, the usage arrives
    // verbatim, and the controller collapses the run to token-cap-exceeded.
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE, { perCallTokenCap: 100 });
    const outcome = await client.call({ prompt: 'p', perCallTokenCap: 200_000 });
    expect(outcome.abortedByTokenCap).toBe(true); // the tighter cap fired
    expect(outcome.measuredTokens).toBe(210);
    expect(outcome.finishKind).toBe('aborted');
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(), // binding per-call cap 200k > 210 measured gross
      identity: IDENTITY,
      hostClient: client
    });
    expect(result.verdict).toBe('blocked');
    expect(result.abortTrigger).toBe('token-cap-exceeded');
    expect(result.calls).toHaveLength(1); // treatment never ran
    expect(result.calls[0]?.outcome).toBe('aborted_local');
    expect(result.calls[0]?.abortedByTokenCap).toBe(true);
    expect(result.calls[0]?.measuredTokens).toBe(210);
    expect(result.calls[0]?.usageRaw).toEqual({ inputTokens: 150, outputTokens: 60 });
  });

  it('the adapter surface reports capIgnored when handed a per-call cap (post-hoc enforcement stays honest)', async () => {
    const invoke: RealBenefitAdapterInvoke = async () => ({
      text: 'ok',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    });
    const client = createHostClientFromAdapter(invoke, CLIENT_ROUTE);
    const outcome = await client.call({ prompt: 'p', perCallTokenCap: 1 });
    expect(outcome.abortedByTokenCap).toBe(false); // no mid-stream hook on this surface
    expect(outcome.capIgnored).toBe(true); // the fact is reported, not hidden
    expect(outcome.measuredTokens).toBe(15);
  });

  it('t14: the adapter surface does NOT claim capIgnored when no cap was supplied (no invented admission)', async () => {
    const invoke: RealBenefitAdapterInvoke = async () => ({
      text: 'ok',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    });
    const client = createHostClientFromAdapter(invoke, CLIENT_ROUTE);
    const outcome = await client.call({ prompt: 'p' }); // NO perCallTokenCap on the call
    expect(outcome.abortedByTokenCap).toBe(false);
    expect(outcome.capIgnored).toBeUndefined(); // nothing was ignored — the field stays absent
    expect(outcome.measuredTokens).toBe(15);
  });

  it('a caller-aborted stream WITHOUT a cap is a thrown transport failure (no cap ⇒ no token abort), never a scored outcome', async () => {
    // The abort kill switch fires ONLY on a measured over-cap usage chunk. An
    // `aborted` finish with no cap wiring is a host/caller abort — the client
    // throws, the controller settles the reservation conservatively (failed,
    // no usage invented) and reports the transport failure honestly.
    const llm = llmOf([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'aborted' } }
    ]);
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE, { perCallTokenCap: 100 });
    await expect(client.call({ prompt: 'p' })).rejects.toMatchObject({ finishKind: 'aborted' });
  });
});

// ---------------------------------------------------------------------------
// H-4 usage honesty
// ---------------------------------------------------------------------------

describe('H-4: usage is carried verbatim and counted honestly', () => {
  it('keeps absent fields absent and sums only valid reported values', () => {
    const count = canaryUsageTokenCount({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5
    });
    expect(count).toBe(125);
    // Invalid numbers contribute nothing to the guard (but stay in the raw
    // record); a record with ONLY invalid numbers still reports "reported".
    expect(canaryUsageTokenCount({ inputTokens: -5, outputTokens: Number.NaN })).toBe(0);
  });

  it('maps an error finish to a thrown DshModelStreamError, an aborted finish without cap to a thrown abort', async () => {
    const errorLlm = llmOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no' } } }]);
    const errorClient = createHostClientFromLlm(errorLlm, CLIENT_ROUTE);
    await expect(errorClient.call({ prompt: 'p' })).rejects.toMatchObject({ finishKind: 'error' });

    const abortLlm = llmOf([{ type: 'finish', reason: { kind: 'aborted' } }]);
    const abortClient = createHostClientFromLlm(abortLlm, CLIENT_ROUTE);
    await expect(abortClient.call({ prompt: 'p' })).rejects.toMatchObject({ finishKind: 'aborted' });
  });
});

// ---------------------------------------------------------------------------
// H-5 the adapter path
// ---------------------------------------------------------------------------

describe('H-5: the adapter path carries metadata rawUsage verbatim', () => {
  it('prefers metadata.rawUsage (lossless) over the truncated TokenUsage', async () => {
    const invoke: RealBenefitAdapterInvoke = async () => ({
      text: 'ok',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      metadata: {
        rawUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 10 }
      }
    });
    const client = createHostClientFromAdapter(invoke, CLIENT_ROUTE);
    const outcome = await client.call({ prompt: 'p' });
    expect(outcome.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      reasoningTokens: 10
    });
    expect(outcome.measuredTokens).toBe(210);
  });

  it('falls back to the frozen TokenUsage when no rawUsage metadata exists', async () => {
    const invoke: RealBenefitAdapterInvoke = async () => ({
      text: 'ok',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    });
    const client = createHostClientFromAdapter(invoke, CLIENT_ROUTE);
    const outcome = await client.call({ prompt: 'p' });
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(outcome.measuredTokens).toBe(120);
  });

  it('the module itself performs no .complete() call (the metering gate stays closed)', () => {
    const source = readFileSync(
      path.resolve(HERE, '../../../src/dsh-bridge/real-benefit-host-client.ts'),
      'utf8'
    );
    // A `.complete(` property access inside CODE — the doc prose says
    // "ctx.llm.complete" without a leading dot, so this regex cannot match
    // its own comments either (they never contain the dot-prefixed form).
    expect(source).not.toMatch(/\.\s*complete\s*\(/);
    expect(source).not.toMatch(/\.\s*complete\.bind/);
    expect(source).not.toMatch(/from 'node:fs'/);
    expect(source).not.toMatch(/from 'node:http'|from 'node:https'|from 'node:net'/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/memoryRealWrites/);
  });
});

// ---------------------------------------------------------------------------
// H-6 the controller wiring: fail-closed gates
// ---------------------------------------------------------------------------

describe('H-6: the controller refuses to run without a verified real client', () => {
  it('blocks with host-client-unbound when no client is bound (and makes no call)', async () => {
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: IDENTITY
    });
    expect(result.verdict).toBe('blocked');
    expect(result.abortTrigger).toBe('host-client-unbound');
    expect(result.calls).toHaveLength(0);
    expect(result.tokenBudget.caps.totalTokens).toBe(800_000);
  });

  it('blocks with host-client-identity-mismatch when the client is not the authorized account', async () => {
    const llm = llmOf([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]);
    const wrong = createHostClientFromLlm(llm, { ...CLIENT_ROUTE, provider: 'not-zcode' });
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: IDENTITY,
      hostClient: wrong
    });
    expect(result.verdict).toBe('blocked');
    expect(String(result.abortTrigger)).toContain('host-client-identity-mismatch');
    expect(String(result.abortTrigger)).toContain('host-client-provider-mismatch');
    expect(result.calls).toHaveLength(0);
  });

  it('a verified client runs both arms and reports the token budget', async () => {
    const llm = llmOf([
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } }
    ]);
    const client = createHostClientFromLlm(llm, CLIENT_ROUTE);
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: IDENTITY,
      hostClient: client
    });
    expect(result.verdict).toBe('insufficient'); // untrusted verdicts ⇒ no benefit claim
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.measuredTokens === 150)).toBe(true);
    expect(result.tokenBudget.measuredTotalTokens).toBe(300);
    expect(result.tokenBudget.measuredBaselineTokens).toBe(150);
    expect(result.tokenBudget.measuredTreatmentTokens).toBe(150);
    expect(result.tokenBudget.allUsageMeasured).toBe(true);
  });

  it('the binding validator requires the token budget row (missing caps ⇒ not satisfied)', () => {
    const binding = makeBinding();
    const complete = validateRealBenefitBinding(binding);
    expect(complete.satisfied).toBe(true);
    const items = complete.items.map((item) => item.id);
    expect(items).toContain('token-budget');
    const broken = validateRealBenefitBinding({
      ...binding,
      tokenBudget: { totalTokens: 900_000_000, perTaskTokens: 800_000_000, perArmTokens: 700_000_000, perCallTokens: 600_000_000 }
    });
    expect(broken.missing.join(',')).toContain('token-caps.totalTokens-exceeds-authorized-ceiling');
    const nested = validateRealBenefitBinding({
      ...binding,
      tokenBudget: { totalTokens: 100, perTaskTokens: 100, perArmTokens: 200, perCallTokens: 300 }
    });
    const nestedReasons = nested.missing.join(',');
    expect(nestedReasons).toContain('token-caps.perTaskTokens-not-below-total');
    expect(nestedReasons).toContain('token-caps.perArmTokens-not-below-perTask');
    expect(nestedReasons).toContain('token-caps.perCallTokens-not-below-perArm');
  });

  it('the controller aborts the run when a settled call exceeds the per-call cap (adapter path)', async () => {
    // The adapter path cannot kill mid-stream, so the controller's post-hoc
    // per-call guard must abort the run and keep the raw usage verbatim.
    const invoke: RealBenefitAdapterInvoke = async () => ({
      text: 'long',
      finishReason: 'stop',
      usage: { inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000 }
    });
    const client = createHostClientFromAdapter(invoke, CLIENT_ROUTE);
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(), // per-call cap 200_000 < the 1_000_000 gross
      identity: IDENTITY,
      hostClient: client
    });
    expect(result.verdict).toBe('blocked');
    expect(result.abortTrigger).toBe('token-cap-exceeded');
    expect(result.calls[0]?.outcome).toBe('aborted_local');
    expect(result.calls[0]?.abortedByTokenCap).toBe(true);
    expect(result.calls[0]?.usageRaw?.inputTokens).toBe(500_000);
    expect(result.calls).toHaveLength(1); // the treatment arm never ran
  });

  it('keeps the raw canary usage type honest: RawCanaryUsage absent fields are not zeros', () => {
    const usage: RawCanaryUsage = { inputTokens: 5 };
    expect(usage.outputTokens).toBeUndefined();
    expect(Object.keys(usage)).toEqual(['inputTokens']);
  });
});
