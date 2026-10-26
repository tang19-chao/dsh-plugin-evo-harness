/**
 * Deterministic Sample Model Rate Cards for Ledger Fixtures.
 *
 * All rates are represented in integer micro-units (1 USD = 1,000,000 micros).
 */

import { ModelRateCard } from '../../../src/ledger/types.js';

/**
 * OpenAI-style model rate card:
 * - inputIncludesCacheRead: true (prompt_tokens includes cached_tokens)
 * - outputIncludesReasoning: true (completion_tokens includes reasoning_tokens)
 * - reasoningSeparatelyBilled: false (reasoning tokens are billed as standard output)
 */
export const OPENAI_STYLE_RATE_CARD: ModelRateCard = {
  modelId: 'fixture-gpt4-mini',
  inputRatePerMillion: 150_000, // $0.15 / M tokens
  cacheReadRatePerMillion: 75_000, // $0.075 / M tokens
  cacheWriteRatePerMillion: 150_000, // $0.15 / M tokens
  outputRatePerMillion: 600_000, // $0.60 / M tokens
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 10_000 // $0.01 floor
};

/**
 * Anthropic-style model rate card:
 * - inputIncludesCacheRead: false (input_tokens excludes cache_read_input_tokens)
 * - outputIncludesReasoning: false
 * - reasoningSeparatelyBilled: false
 */
export const ANTHROPIC_STYLE_RATE_CARD: ModelRateCard = {
  modelId: 'fixture-claude-sonnet',
  inputRatePerMillion: 3_000_000, // $3.00 / M tokens
  cacheReadRatePerMillion: 300_000, // $0.30 / M tokens
  cacheWriteRatePerMillion: 3_750_000, // $3.75 / M tokens
  outputRatePerMillion: 15_000_000, // $15.00 / M tokens
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 50_000 // $0.05 floor
};

/**
 * DeepSeek-style model rate card with separate reasoning billing:
 * - inputIncludesCacheRead: true
 * - outputIncludesReasoning: true
 * - reasoningSeparatelyBilled: true (reasoning tokens have dedicated rate)
 */
export const DEEPSEEK_STYLE_RATE_CARD: ModelRateCard = {
  modelId: 'fixture-deepseek-r1',
  inputRatePerMillion: 550_000, // $0.55 / M tokens
  cacheReadRatePerMillion: 140_000, // $0.14 / M tokens
  cacheWriteRatePerMillion: 550_000, // $0.55 / M tokens
  outputRatePerMillion: 2_190_000, // $2.19 / M tokens
  reasoningRatePerMillion: 2_190_000, // $2.19 / M tokens
  reasoningSeparatelyBilled: true,
  conservativeFallbackCostMicros: 20_000 // $0.02 floor
};

/**
 * Fallback rate card for testing unknown provider semantics.
 */
export const CONSERVATIVE_FALLBACK_RATE_CARD: ModelRateCard = {
  modelId: 'fixture-unknown-model',
  inputRatePerMillion: 1_000_000, // $1.00 / M tokens
  cacheReadRatePerMillion: 500_000,
  cacheWriteRatePerMillion: 1_000_000,
  outputRatePerMillion: 3_000_000, // $3.00 / M tokens
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 25_000 // $0.025 conservative floor
};
