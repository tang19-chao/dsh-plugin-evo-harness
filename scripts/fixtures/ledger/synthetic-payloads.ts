/**
 * Deterministic Synthetic Usage Payloads for Ledger Scenarios.
 *
 * Implements synthetic fixtures for:
 * - All 6 phases: probe, reference, compose, reflect, judge, dream
 * - Edge cases: duplicate pricing, unknown usage, partially unknown, cancelled mid-stream
 */

import { createUsagePayload, metric } from '../../../src/ledger/pricing.js';
import { ProviderUsagePayload } from '../../../src/ledger/types.js';

/**
 * Phase 1: Probe usage payload (lightweight exploratory call).
 */
export const PROBE_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 800,
  output: 150,
  cacheRead: 200,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: false,
    semanticTag: 'probe-v1'
  },
  precision: 'measured'
});

/**
 * Phase 2: Reference usage payload (baseline trajectory generation).
 */
export const REFERENCE_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 1500,
  output: 300,
  cacheRead: 500,
  cacheWrite: 200,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: false,
    semanticTag: 'reference-v1'
  },
  precision: 'measured'
});

/**
 * Phase 3: Compose usage payload (prompt composition / synthesis).
 */
export const COMPOSE_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 2500,
  output: 400,
  cacheRead: 1800,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: false,
    semanticTag: 'compose-v1'
  },
  precision: 'measured'
});

/**
 * Phase 4: Reflect usage payload (critique and reasoning).
 */
export const REFLECT_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 1200,
  output: 600,
  cacheRead: 400,
  reasoning: 300,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: true,
    semanticTag: 'reflect-v1'
  },
  precision: 'measured'
});

/**
 * Phase 5: Judge usage payload (verification and evaluation judge).
 */
export const JUDGE_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 1800,
  output: 250,
  cacheRead: 1000,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: false,
    semanticTag: 'judge-v1'
  },
  precision: 'measured'
});

/**
 * Phase 6: Dream usage payload (offline replay / synthetic tree exploration).
 */
export const DREAM_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 3500,
  output: 800,
  cacheRead: 2200,
  cacheWrite: 500,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: false,
    semanticTag: 'dream-v1'
  },
  precision: 'measured'
});

/**
 * Completely unknown usage payload:
 * Missing countingSemantics and unknown precision.
 */
export const UNKNOWN_USAGE_PAYLOAD: ProviderUsagePayload = {
  inputTokens: metric(0, 'unknown'),
  outputTokens: metric(0, 'unknown'),
  cacheReadTokens: metric(0, 'unknown'),
  reasoningTokens: metric(0, 'unknown')
  // countingSemantics is intentionally omitted!
};

/**
 * Partially unknown payload:
 * Input is measured, but reasoning tokens and semantics are unknown.
 */
export const PARTIALLY_UNKNOWN_USAGE_PAYLOAD: ProviderUsagePayload = {
  inputTokens: metric(1200, 'measured'),
  outputTokens: metric(400, 'measured'),
  reasoningTokens: metric(250, 'unknown'),
  // countingSemantics omitted to test fallback
};

/**
 * Incurred usage payload from a cancelled call:
 * Partial prompt processed and cancelled early.
 */
export const CANCELLED_INCURRED_USAGE_PAYLOAD: ProviderUsagePayload = createUsagePayload({
  input: 900,
  output: 60,
  cacheRead: 300,
  semantics: {
    inputIncludesCacheRead: true,
    outputIncludesReasoning: false,
    semanticTag: 'cancelled-call'
  },
  precision: 'measured'
});
