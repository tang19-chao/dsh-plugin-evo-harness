/**
 * rev6 t4: the REAL host client binding for the real-benefit canary.
 *
 * WHY THIS MODULE EXISTS (t4 acceptance row 1)
 * --------------------------------------------
 * The canary controller (`real-benefit-controller.ts`) is deliberately pure:
 * the model call arrives through a caller-supplied seam. What the seam dials
 * was, until this module, undefined — the runner refused to fabricate a client
 * (`no real model client is bound in this environment`). This module is the
 * sanctioned way to bind that seam to the REAL ZCode host model surface:
 *
 *   - `readZcodeHostClient(ctx, …)` resolves the host `ctx.llm` service
 *     through the verified guarded reader (`readDshLlm`) and returns
 *     `undefined` when the host exposes no stream-capable LLM — the caller
 *     must then fail closed (never simulate, never guess);
 *   - `createHostClientFromLlm` dials `ctx.llm.stream()` — the ONLY public
 *     model-call entry the runtime exports (`ctx.llm.complete` has never
 *     existed; see ./model.ts header);
 *   - `createHostClientFromAdapter` dials a caller-supplied adapter invoke
 *     (an `IModelAdapter` binding owned by the operator's runner script — this
 *     module itself issues no adapter complete() call, so the production
 *     metering-coverage gate surface is unchanged);
 *   - every client carries a DESENSITIZED identity (provider/model/routeId and
 *     a masked account id); `verifyHostClientIdentity` proves the client the
 *     runner is about to dial is the account the binding authorized — before
 *     any call.
 *
 * TOKEN HARD BUDGET (t4 acceptance row 2, t4-fix wiring)
 * -------------------------------------------------------
 * The LLM path is a STREAMING path, so the per-call token cap is enforced
 * DURING the stream: when a `usage` chunk reports a gross token count above
 * the per-call cap, the client aborts its own AbortSignal immediately — the
 * provider stops generating, and the usage observed so far is still returned
 * verbatim (`abortedByTokenCap: true`) so the controller can settle honestly
 * and block the run. The cap arrives ON THE CALL (`call({perCallTokenCap})`)
 * from the controller's binding — wiring the kill switch is the controller's
 * job, not the runner's construction choice (t4-fix). The adapter path has no
 * mid-stream hook: it accepts the cap on the seam for uniformity, reports
 * `capIgnored: true` and leaves enforcement to the controller's post-hoc
 * cross-call guard; this asymmetry is a fact of the two surfaces, documented,
 * not hidden.
 *
 * HONESTY RULES ENFORCED BY CONSTRUCTION
 * --------------------------------------
 *   1. Usage is carried VERBATIM: a field the host reported is passed through
 *      unchanged; a field it did not report stays absent (never zero). The
 *      guard counts only measured values — it never invents tokens.
 *   2. The counting rule (`canaryUsageTokenCount`) sums every REPORTED field.
 *      When counting semantics declare inclusion (inputIncludesCacheRead /
 *      outputIncludesReasoning) the sum double-counts — for a KILL SWITCH that
 *      over-count is the safe direction (it aborts earlier). Accounting and
 *      reports keep the raw usage; only the abort decision uses the gross sum.
 *   3. No secrets: the client identity holds the masked account id only. The
 *      raw account id never enters a client object, a log, or a report.
 *   4. No memory write, no guarded-active, no publish, no fs/network of its
 *      own: the only I/O is the model stream the host/adapter seam supplies.
 */

import type {
  IModelAdapter,
  ModelPurpose,
  ModelRequest,
  ModelResponse
} from '../types/contracts';
import {
  DshModelStreamError,
  describeDshFailure,
  readDshLlm,
  safeGet,
  type DshFinishReason,
  type DshGenerateOptions,
  type DshLlmLike,
  type DshUsage
} from './model';

/** The authorized canary target for this rev6 round (descriptive only; the live strings still come from the binding). */
export const ZCODE_CANARY_TARGET = Object.freeze({ host: 'zcode', model: 'GLM-5.3-Flash' } as const);

// ---------------------------------------------------------------------------
// Desensitized identity
// ---------------------------------------------------------------------------

/** The masked account form the reports may carry (first 4 chars + length class). */
export function maskAccountId(accountId: string): string {
  return accountId.slice(0, 4) + '…(' + String(accountId.length) + ' chars)';
}

/**
 * The desensitized client identity. Carries NO secret: the raw account id is
 * never stored on a client object.
 */
export interface RealBenefitHostClientIdentity {
  /** How the client is bound: the host `ctx.llm` service or a caller adapter. */
  readonly kind: 'ctx-llm' | 'model-adapter';
  readonly provider: string;
  readonly model: string;
  readonly routeId: string;
  /** Masked account id (`maskAccountId` form) — never the raw identifier. */
  readonly accountIdMasked: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Verify that the client about to dial is the account the binding authorized.
 * Returns the named problems (empty = verified). The mask check proves the
 * desensitization itself: a client carrying the RAW account id fails closed.
 */
export function verifyHostClientIdentity(
  identity: RealBenefitHostClientIdentity,
  account: { readonly provider: string; readonly model: string; readonly accountId: string },
  routeId: string
): string[] {
  const problems: string[] = [];
  if (identity.provider !== account.provider) problems.push('host-client-provider-mismatch');
  if (identity.model !== account.model) problems.push('host-client-model-mismatch');
  if (identity.routeId !== routeId) problems.push('host-client-route-mismatch');
  if (!isNonEmptyString(identity.accountIdMasked)) {
    problems.push('host-client-account-mask-empty');
  } else if (identity.accountIdMasked === account.accountId) {
    problems.push('host-client-account-not-masked');
  } else if (maskAccountId(account.accountId) !== identity.accountIdMasked) {
    problems.push('host-client-account-mask-mismatch');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Token accounting (the ONE counting rule for the canary kill switch)
// ---------------------------------------------------------------------------

/** Structural view of a raw usage record (compatible with the controller's RawCanaryUsage). */
export interface CanaryUsageLike {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Gross measured token count over every REPORTED field, or `undefined` when
 * the host reported nothing (nothing measured — the guard never invents).
 *
 * Conservative by construction: reported fields are summed, so declared
 * inclusion semantics (cacheRead inside input, reasoning inside output)
 * double-count. For an abort switch over-counting aborts EARLIER — the safe
 * direction. Raw usage is recorded verbatim elsewhere; only this abort
 * decision uses the gross sum. A present-but-invalid number (non-finite or
 * negative) contributes 0 and stays verbatim in the raw record.
 */
export function canaryUsageTokenCount(usage: CanaryUsageLike | undefined): number | undefined {
  if (usage === undefined) {
    return undefined;
  }
  let total = 0;
  let reportedAny = false;
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens
  ]) {
    if (value === undefined) continue;
    reportedAny = true;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      total += value;
    }
  }
  return reportedAny ? total : undefined;
}

// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------

/** One completed host call, exactly the shape the controller's seam consumes. */
export interface HostClientCallOutcome {
  readonly text: string;
  /** Raw usage verbatim as the host reported it (absent field = not reported). */
  readonly usage: CanaryUsageLike | undefined;
  /** Gross measured tokens (`canaryUsageTokenCount`), when usage was reported. */
  readonly measuredTokens: number | undefined;
  /** True when the client killed the stream because the per-call cap was hit. */
  readonly abortedByTokenCap: boolean;
  /**
   * t4-fix: set only on the adapter surface when the caller supplied a
   * per-call cap the adapter path cannot enforce mid-stream (post-hoc guard
   * in the controller covers it). Absent on the streaming surface.
   */
  readonly capIgnored?: true;
  /** The terminal finish kind, when the stream settled. */
  readonly finishKind?: 'stop' | 'max-tokens' | 'tool-calls' | 'aborted' | 'error';
}

/** The bound host client. One instance dials one account/route, nothing else. */
export interface RealBenefitHostClient {
  readonly identity: RealBenefitHostClientIdentity;
  call(input: {
    readonly prompt: string;
    readonly signal?: AbortSignal;
    /**
     * t4-fix: the per-call gross token cap for THIS call. The CONTROLLER
     * passes the binding's cap on every call, so the mid-stream kill switch
     * is wired by construction — not by how the runner happened to build the
     * client. Only the streaming surface honors it; the adapter surface has
     * no mid-stream hook (its cap stays post-hoc in the controller).
     */
    readonly perCallTokenCap?: number;
  }): Promise<HostClientCallOutcome>;
}

export interface ZcodeHostClientOptions {
  /** Per-call gross token cap; a `usage` chunk above it kills the stream. */
  readonly perCallTokenCap?: number;
  /** Provider-side output ceiling (`max_tokens` in the request body). */
  readonly maxOutputTokens?: number;
  /** Receiver for non-fatal protocol observations. */
  readonly onDiagnostic?: (message: string) => void;
}

/** Copy a DSH usage record verbatim into the canary's raw usage shape. */
function rawUsageOf(usage: DshUsage | undefined): CanaryUsageLike | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const pick = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inputTokens = pick(usage.inputTokens);
  const outputTokens = pick(usage.outputTokens);
  const cacheReadTokens = pick(usage.cacheReadTokens);
  const cacheWriteTokens = pick(usage.cacheWriteTokens);
  const reasoningTokens = pick(usage.reasoningTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

/**
 * Drain one DSH chunk stream with the canary's mid-stream kill switch.
 *
 * A dedicated drain (instead of `drainDshStream`) because the cap check must
 * run on EVERY `usage` chunk while the stream is still live — the shared
 * drainer has no per-chunk hook. Accumulation follows the same rules: text
 * deltas concatenate, reasoning stays out of the deliverable, the LAST usage
 * chunk wins, and a stream that never settles is reported, never guessed.
 */
async function drainCanaryStream(
  stream: AsyncIterable<unknown>,
  hooks: {
    readonly perCallTokenCap: number | undefined;
    readonly onOverCap: () => void;
    readonly onDiagnostic?: (message: string) => void;
  }
): Promise<{ text: string; usage: DshUsage | undefined; finish: DshFinishReason | undefined; capAborted: boolean }> {
  const textParts: string[] = [];
  let lastUsage: DshUsage | undefined = undefined;
  let finish: DshFinishReason | undefined = undefined;
  let sawFinish = false;
  let capAborted = false;

  for await (const chunk of stream) {
    const type = safeGet(chunk, 'type');
    switch (type) {
      case 'text-delta': {
        const text = safeGet(chunk, 'text');
        if (typeof text === 'string' && text.length > 0) textParts.push(text);
        break;
      }
      case 'usage': {
        const usage = safeGet(chunk, 'usage');
        if (usage !== null && typeof usage === 'object') {
          lastUsage = usage as DshUsage;
          if (hooks.perCallTokenCap !== undefined && !capAborted) {
            const measured = canaryUsageTokenCount(rawUsageOf(lastUsage));
            if (measured !== undefined && measured > hooks.perCallTokenCap) {
              capAborted = true;
              hooks.onOverCap();
            }
          }
        }
        break;
      }
      case 'finish': {
        sawFinish = true;
        const reason = safeGet(chunk, 'reason');
        if (typeof reason === 'string') {
          finish = { kind: reason as DshFinishReason['kind'] } as DshFinishReason;
        } else if (reason !== null && typeof reason === 'object') {
          finish = reason as DshFinishReason;
        }
        break;
      }
      default: {
        if (
          typeof type === 'string' &&
          type.length > 0 &&
          type !== 'block-start' &&
          type !== 'block-end' &&
          type !== 'reasoning-delta' &&
          type !== 'tool-call-delta' &&
          hooks.onDiagnostic !== undefined
        ) {
          hooks.onDiagnostic('unrecognized DSH stream chunk "' + type + '" was ignored');
        }
        break;
      }
    }
  }

  if (!sawFinish && hooks.onDiagnostic !== undefined) {
    hooks.onDiagnostic('the DSH chunk stream ended without a terminal finish chunk');
  }
  return { text: textParts.join(''), usage: lastUsage, finish, capAborted };
}

/** Build the desensitized identity object for a bound client. */
function identityOf(
  kind: RealBenefitHostClientIdentity['kind'],
  route: { readonly provider: string; readonly model: string; readonly routeId: string; readonly accountIdMasked: string }
): RealBenefitHostClientIdentity {
  return {
    kind,
    provider: route.provider,
    model: route.model,
    routeId: route.routeId,
    accountIdMasked: route.accountIdMasked
  };
}

/**
 * Bind the canary's model seam to the REAL host `ctx.llm` service.
 *
 * The returned client dials `llm.stream()` (the only verified entry point) on
 * the route the binding authorized, with `max_tokens` clamped to the route's
 * provider-enforced output ceiling and the per-call token cap enforced
 * mid-stream through the client's own AbortSignal.
 */
export function createHostClientFromLlm(
  llm: DshLlmLike,
  route: {
    readonly provider: string;
    readonly model: string;
    readonly routeId: string;
    readonly accountIdMasked: string;
  },
  options: ZcodeHostClientOptions = {}
): RealBenefitHostClient {
  return {
    identity: identityOf('ctx-llm', route),
    async call(input) {
      const abort = new AbortController();
      const signal =
        input.signal === undefined ? abort.signal : AbortSignal.any([input.signal, abort.signal]);
      let capAborted = false;
      // t4-fix: the per-call cap rides EACH CALL from the controller; a cap
      // given at construction stays enforced as well. The TIGHTER of the two
      // wins (Math.min): a kill switch is never LOOSENED by a later cap —
      // it can only be tightened.
      const candidateCaps = [options.perCallTokenCap, input.perCallTokenCap].filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
      );
      const perCallCap = candidateCaps.length > 0 ? Math.min(...candidateCaps) : undefined;
      const requestOptions: DshGenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
        ...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
        signal
      };
      const drained = await drainCanaryStream(llm.stream(requestOptions), {
        perCallTokenCap: perCallCap,
        onOverCap: () => {
          capAborted = true;
          abort.abort();
        },
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
      });
      const usage = rawUsageOf(drained.usage);
      const kind = drained.finish?.kind;
      if (kind === 'error') {
        throw new DshModelStreamError(describeDshFailure(drained.finish as DshFinishReason), 'error');
      }
      if (kind === 'aborted' && !capAborted) {
        throw new DshModelStreamError('the host stream was aborted by the caller', 'aborted');
      }
      return {
        text: drained.text,
        usage,
        measuredTokens: canaryUsageTokenCount(usage),
        abortedByTokenCap: capAborted,
        ...(kind === undefined ? {} : { finishKind: kind })
      };
    }
  };
}

/**
 * The adapter invoke seam. The CALLER owns the adapter's complete() call (the
 * operator's runner script binds the real adapter); this module stays
 * call-free so the production metering-coverage allowlist is unchanged.
 */
export type RealBenefitAdapterInvoke = (request: ModelRequest) => Promise<ModelResponse>;

/**
 * Bind the canary's model seam to a caller-supplied adapter invoke.
 *
 * There is no mid-stream hook on this surface, so the per-call cap here is
 * POST-HOC: the outcome (with verbatim usage) is always returned and the
 * controller's cross-call guard aborts the run when the cap was exceeded.
 */
export function createHostClientFromAdapter(
  invoke: RealBenefitAdapterInvoke,
  route: {
    readonly provider: string;
    readonly model: string;
    readonly routeId: string;
    readonly accountIdMasked: string;
  },
  options: { readonly purpose?: ModelPurpose; readonly maxOutputTokens?: number } = {}
): RealBenefitHostClient {
  let sequence = 0;
  return {
    identity: identityOf('model-adapter', route),
    async call(input) {
      sequence += 1;
      const request: ModelRequest = {
        purpose: options.purpose ?? 'probe',
        messages: [{ role: 'user', content: input.prompt }],
        ...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
        metadata: {
          callId: 'r3a-host-' + String(sequence),
          ...(input.signal === undefined ? {} : { signal: input.signal })
        }
      };
      const response = await invoke(request);
      // Lossless first: the adapter metadata may carry the RAW DSH usage
      // (cacheRead/cacheWrite/reasoning); fall back to the frozen TokenUsage.
      // (t4-fix: the adapter surface has no mid-stream hook, so
      // `input.perCallTokenCap` cannot act mid-flight — it is accepted for
      // seam-shape uniformity and left to the controller's post-hoc guard;
      // an explicit `capIgnored` marker keeps that fact honest.)
      const rawFromMetadata = safeGet(response.metadata, 'rawUsage');
      const usage =
        rawFromMetadata !== undefined && rawFromMetadata !== null && typeof rawFromMetadata === 'object'
          ? rawUsageOf(rawFromMetadata as DshUsage)
          : (() => {
              const tokenUsage = response.usage;
              if (tokenUsage === undefined) return undefined;
              const pick = (value: number | undefined): number | undefined =>
                typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
              const inputTokens = pick(tokenUsage.inputTokens);
              const outputTokens = pick(tokenUsage.outputTokens);
              if (inputTokens === undefined && outputTokens === undefined) return undefined;
              return {
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens })
              };
            })();
      const finishReason = response.finishReason;
      return {
        text: response.text,
        usage,
        measuredTokens: canaryUsageTokenCount(usage),
        abortedByTokenCap: false,
        ...(input.perCallTokenCap !== undefined ? { capIgnored: true as const } : {}),
        ...(finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls'
          ? { finishKind: finishReason === 'length' ? ('max-tokens' as const) : (finishReason === 'tool_calls' ? ('tool-calls' as const) : ('stop' as const)) }
          : {})
      };
    }
  };
}

/**
 * Resolve the canary host client from a live host context, or `undefined`
 * when the host exposes no stream-capable LLM service — the caller must then
 * fail closed (no client, no call, no simulation).
 */
export function readZcodeHostClient(
  ctx: unknown,
  route: { readonly provider: string; readonly model: string; readonly routeId: string; readonly accountId: string },
  options: ZcodeHostClientOptions = {}
): RealBenefitHostClient | undefined {
  const llm = readDshLlm(ctx);
  if (llm === undefined) {
    return undefined;
  }
  return createHostClientFromLlm(
    llm,
    {
      provider: route.provider,
      model: route.model,
      routeId: route.routeId,
      accountIdMasked: maskAccountId(route.accountId)
    },
    options
  );
}

/** Structural adapter view accepted by the runner's adapter binding. */
export type AdapterLike = IModelAdapter;
