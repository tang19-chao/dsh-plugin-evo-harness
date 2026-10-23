/**
 * JitRL logit sources (plan sections 3.1, 3.2 and 6.4; P1-4).
 *
 * Three producers feed prior logits z(s, a) into the JitRL adjustment core:
 * - verbalized: the proposer's 0..1 confidence converted with the plan's
 *   smoothed log formula z = ln((conf + delta) / (100 + delta * k)) after
 *   scaling conf to 0..100;
 * - token: the mean chosen-token logprob from ModelResponse.tokenLogprobs
 *   when the provider supports them. Support is probed once against the
 *   injected model adapter, the verdict is cached, and an unsupported or
 *   failing probe degrades to verbalized with a recorded diagnostic;
 * - policy_prior: log of the active-policy slot share, memory-confidence
 *   modulated and divided by the exploration temperature (section 3.1).
 *
 * Everything is pure arithmetic over injected values. The only I/O is the
 * one-shot capability probe; probe failures degrade deterministically and
 * never throw. No module-level state beyond the cached probe verdict.
 */

import {
  BATCH_SLOT_KINDS,
  type BatchSlotKind,
  type IModelAdapter,
  type JitCandidate,
  type ModelRequest,
  type ModelResponse
} from '../types/contracts';

/** Logit source kinds, mirroring the config jitrl.logitSource enum. */
export const LOGIT_SOURCES = ['verbalized', 'token', 'policy_prior'] as const;
export type LogitSourceKind = (typeof LOGIT_SOURCES)[number];

/** Confidence clamp keeping the log formula finite at 0 and 1. */
export const CONFIDENCE_CLAMP = 1e-6;

/** Logit floor for a zero-share action (plan section 6.4 neutral floor). */
export const ZERO_SHARE_LOGIT = Math.log(1e-9);

/**
 * Slot prior used when every raw weight is non-positive. Mirrors the frozen
 * DEFAULT_SLOT_WEIGHTS of src/dream-rsi/active-policy.ts (P0) so the two
 * normalizations stay semantically identical without a cross-module import.
 */
export const DEFAULT_SLOT_PRIOR: Readonly<Record<BatchSlotKind, number>> = {
  exploit: 0.4,
  explore_domain: 0.3,
  explore_invariant: 0.2,
  recover: 0.1
};

/** Clamp a value into [0, 1]; non-finite input maps to 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Convert a proposer confidence in [0, 1] into a prior logit using the
 * plan section 3.2 formula z = ln((conf + delta) / (100 + delta * k)) with
 * conf scaled to 0..100. Inputs 0, 1 and NaN are clamped into
 * [1e-6, 1 - 1e-6] first, so the result is always finite and strictly
 * monotonic in the confidence. The maximum logit is 0 at certainty.
 */
export function verbalizedLogit(confidence01: number, delta = 0.01, k = 1): number {
  const safeDelta = Number.isFinite(delta) && delta > 0 ? delta : 0.01;
  const safeK = Number.isFinite(k) && k > 0 ? k : 1;
  // NaN cannot be clamped and maps to 0; +/-Infinity clamps to the bounds.
  const base = Number.isNaN(confidence01) ? 0 : confidence01;
  const clamped = Math.min(1 - CONFIDENCE_CLAMP, Math.max(CONFIDENCE_CLAMP, base));
  const conf100 = clamped * 100;
  return Math.log((conf100 + safeDelta) / (100 + safeDelta * safeK));
}

/**
 * Normalize raw slot weights exactly like active-policy's
 * normalizeSlotWeights: non-finite and non-positive entries become 0, and
 * an all-zero vector falls back to the frozen default prior.
 */
function normalizeSlotWeights(
  weights: Readonly<Record<BatchSlotKind, number>> | undefined
): Readonly<Record<BatchSlotKind, number>> {
  const out: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  let sum = 0;
  for (const kind of BATCH_SLOT_KINDS) {
    const raw: number | undefined = weights === undefined ? undefined : weights[kind];
    const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    out[kind] = value;
    sum += value;
  }
  if (sum <= 0) {
    for (const kind of BATCH_SLOT_KINDS) {
      out[kind] = DEFAULT_SLOT_PRIOR[kind];
    }
  }
  return out;
}

/**
 * Prior logit for one meta slot kind (plan section 3.1): the normalized
 * slot share, modulated by memory confidence exactly like
 * ActivePolicy.utilityOf (explore_domain boosted by confidence,
 * explore_invariant boosted by its absence), divided by the exploration
 * temperature, then logged. A zero share yields ZERO_SHARE_LOGIT.
 * Undefined memoryConfidence means 'no memory signal': the plain share is
 * used without modulation. Undefined or non-positive temperature means 1.
 */
export function policyPriorLogit(
  slotWeights: Readonly<Record<BatchSlotKind, number>> | undefined,
  slotKind: BatchSlotKind,
  explorationTemperature?: number,
  memoryConfidence?: number
): number {
  const normalized = normalizeSlotWeights(slotWeights);
  let sum = 0;
  for (const kind of BATCH_SLOT_KINDS) {
    sum += normalized[kind];
  }
  const share = sum > 0 ? normalized[slotKind] / sum : 0;
  let modulated = share;
  if (memoryConfidence !== undefined && Number.isFinite(memoryConfidence)) {
    const confidence = clamp01(memoryConfidence);
    if (slotKind === 'explore_domain') {
      modulated = share * (0.5 + 0.5 * confidence);
    } else if (slotKind === 'explore_invariant') {
      modulated = share * (0.5 + 0.5 * (1 - confidence));
    }
  }
  const temperature =
    explorationTemperature !== undefined &&
    Number.isFinite(explorationTemperature) &&
    explorationTemperature > 0
      ? explorationTemperature
      : 1;
  const effective = modulated / temperature;
  return effective > 0 ? Math.log(effective) : ZERO_SHARE_LOGIT;
}

/** Per-decision context for a logit source; every field is optional. */
export interface LogitContext {
  /** Proposer confidence in [0, 1] (verbalized mode). */
  readonly confidence?: number;
  /** Chosen-token logprobs from the model response (token mode). */
  readonly tokenLogprobs?: ModelResponse['tokenLogprobs'];
  readonly slotWeights?: Readonly<Record<BatchSlotKind, number>>;
  readonly slotKind?: BatchSlotKind;
  readonly explorationTemperature?: number;
  readonly memoryConfidence?: number;
}

/**
 * Capability verdict cache for ModelResponse.tokenLogprobs support. The
 * token source probes at most once and writes the verdict back into this
 * object so repeated constructions share the conclusion.
 */
export interface LogprobCapabilities {
  tokenLogprobs: 'supported' | 'unsupported' | 'unknown';
}

//** One resolved logit source with a diagnostics getter. */
export interface LogitSource {
  readonly kind: LogitSourceKind;
  logitFor(context: LogitContext): number;
  diagnostics(): readonly string[];
}

const PROBE_REQUEST: ModelRequest = {
  purpose: 'probe',
  messages: [{ role: 'user', content: 'capability probe: report token logprobs' }],
  maxTokens: 1,
  logprobs: { topK: 1 }
};

function meanTokenLogprob(entries: NonNullable<ModelResponse['tokenLogprobs']>): number | undefined {
  let total = 0;
  let count = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.logprob)) {
      total += entry.logprob;
      count += 1;
    }
  }
  return count > 0 ? total / count : undefined;
}

/**
 * Token-mode source. Probes ModelResponse.tokenLogprobs support exactly
 * once (unless the caller already cached a verdict), records the outcome in
 * diagnostics, and degrades to the verbalized path when unsupported. Never
 * throws: probe errors count as 'unsupported'.
 */
export async function createTokenLogprobSource(
  options: { readonly model: IModelAdapter; readonly capabilities: LogprobCapabilities }
): Promise<LogitSource> {
  const diagnostics: string[] = [];
  let verdict = options.capabilities.tokenLogprobs;
  if (verdict === 'unknown') {
    try {
      const response = await options.model.complete(PROBE_REQUEST);
      verdict =
        Array.isArray(response.tokenLogprobs) && response.tokenLogprobs.length > 0
          ? 'supported'
          : 'unsupported';
    } catch {
      verdict = 'unsupported';
    }
    options.capabilities.tokenLogprobs = verdict;
    diagnostics.push(
      verdict === 'supported'
        ? 'token_logprobs: supported (probed once)'
        : 'token_logprobs: unsupported; degraded to verbalized'
    );
  }
  const supported = verdict === 'supported';
  return {
    kind: supported ? 'token' : 'verbalized',
    logitFor(context) {
      if (!supported) {
        return context.confidence !== undefined && Number.isFinite(context.confidence)
          ? verbalizedLogit(context.confidence)
          : 0;
      }
      const entries = context.tokenLogprobs;
      if (entries === undefined || entries.length === 0) {
        return context.confidence !== undefined && Number.isFinite(context.confidence)
          ? verbalizedLogit(context.confidence)
          : 0;
      }
      const mean = meanTokenLogprob(entries);
      return mean === undefined ? 0 : mean;
    },
    diagnostics() {
      return [...diagnostics];
    }
  };
}

function createVerbalizedSource(): LogitSource {
  return {
    kind: 'verbalized',
    logitFor(context) {
      return context.confidence !== undefined && Number.isFinite(context.confidence)
        ? verbalizedLogit(context.confidence)
        : 0;
    },
    diagnostics() {
      return [];
    }
  };
}

/** Options for the auto-resolving source facade. */
export interface AutoLogitSourceOptions {
  readonly logitSource: 'auto' | 'verbalized' | 'token';
  readonly model?: IModelAdapter;
  readonly capabilities?: LogprobCapabilities;
}

/**
 * Facade resolving config jitrl.logitSource into the concrete source.
 * 'auto' prefers token logprobs when supported and present, then a
 * verbalized confidence, then the policy prior, then the neutral 0.
 * resolved() reports the source kind used by the most recent decision.
 */
export interface AutoLogitSource {
  readonly requested: 'auto' | 'verbalized' | 'token';
  resolved(): LogitSourceKind | 'neutral';
  logitFor(candidate: JitCandidate<unknown>, context: LogitContext): number;
  diagnostics(): readonly string[];
}

export async function createAutoLogitSource(
  options: AutoLogitSourceOptions
): Promise<AutoLogitSource> {
  const diagnostics: string[] = [];
  let inner: LogitSource;
  if (options.logitSource === 'token') {
    if (options.model === undefined) {
      diagnostics.push('token source requested without model adapter; degraded to verbalized');
      inner = createVerbalizedSource();
    } else {
      inner = await createTokenLogprobSource({
        model: options.model,
        capabilities: options.capabilities ?? { tokenLogprobs: 'unknown' }
      });
    }
  } else if (options.logitSource === 'auto') {
    if (options.model === undefined) {
      diagnostics.push('auto source resolved to verbalized (no model adapter)');
      inner = createVerbalizedSource();
    } else {
      inner = await createTokenLogprobSource({
        model: options.model,
        capabilities: options.capabilities ?? { tokenLogprobs: 'unknown' }
      });
    }
  } else {
    inner = createVerbalizedSource();
  }

  let lastResolved: LogitSourceKind | 'neutral' = inner.kind;
  return {
    requested: options.logitSource,
    resolved() {
      return lastResolved;
    },
    logitFor(candidate, context) {
      if (options.logitSource === 'auto') {
        if (inner.kind === 'token' && context.tokenLogprobs !== undefined) {
          lastResolved = 'token';
          return inner.logitFor(context);
        }
        if (context.confidence !== undefined && Number.isFinite(context.confidence)) {
          lastResolved = 'verbalized';
          return verbalizedLogit(context.confidence);
        }
        if (context.slotWeights !== undefined && context.slotKind !== undefined) {
          lastResolved = 'policy_prior';
          return policyPriorLogit(
            context.slotWeights,
            context.slotKind,
            context.explorationTemperature,
            context.memoryConfidence
          );
        }
        lastResolved = 'neutral';
        return 0;
      }
      lastResolved = inner.kind;
      return inner.logitFor(context);
    },
    diagnostics() {
      return [...diagnostics, ...inner.diagnostics()];
    }
  };
}