import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createUsagePayload,
  metric
} from '../../../src/ledger/pricing.js';
import {
  ModelRateCard,
  ProviderUsagePayload
} from '../../../src/ledger/types.js';

describe('C3 Pricing Adapter and Anti-Double Counting (ADR-0003 §7.3)', () => {
  const standardRateCard: ModelRateCard = {
    modelId: 'test-model',
    inputRatePerMillion: 1_000_000, // $1.00 / M tokens (1 micro / token)
    cacheReadRatePerMillion: 200_000, // $0.20 / M tokens (0.2 micro / token)
    cacheWriteRatePerMillion: 1_250_000, // $1.25 / M tokens (1.25 micro / token)
    outputRatePerMillion: 4_000_000, // $4.00 / M tokens (4 micro / token)
    reasoningRatePerMillion: 4_000_000,
    reasoningSeparatelyBilled: false,
    conservativeFallbackCostMicros: 15_000 // $0.015 floor
  };

  describe('Anti-double counting: cacheRead & input (ADR-0003 §7.3.3)', () => {
    it('deducts cacheRead from input when inputIncludesCacheRead === true', () => {
      // 1000 total prompt tokens, 800 of which are cached read
      const usage: ProviderUsagePayload = createUsagePayload({
        input: 1000,
        output: 100,
        cacheRead: 800,
        semantics: {
          inputIncludesCacheRead: true,
          outputIncludesReasoning: false
        }
      });

      const calc = calculateUsageCost(usage, standardRateCard);

      // Net uncached input tokens should be 1000 - 800 = 200
      expect(calc.breakdown.netInputTokens).toBe(200);
      expect(calc.breakdown.cacheReadTokens).toBe(800);

      // Input cost: 200 * 1 micro = 200 micros
      expect(calc.breakdown.inputCostMicros).toBe(200);
      // Cache read cost: 800 * 0.2 micro = 160 micros
      expect(calc.breakdown.cacheReadCostMicros).toBe(160);
      // Output cost: 100 * 4 micro = 400 micros
      expect(calc.breakdown.outputCostMicros).toBe(400);

      // Total = 200 + 160 + 400 = 760 micros
      expect(calc.totalCostMicros).toBe(760);
    });

    it('does not deduct cacheRead when inputIncludesCacheRead === false', () => {
      // Anthropic style: 200 uncached input, 800 cached read reported separately
      const usage: ProviderUsagePayload = createUsagePayload({
        input: 200,
        output: 100,
        cacheRead: 800,
        semantics: {
          inputIncludesCacheRead: false,
          outputIncludesReasoning: false
        }
      });

      const calc = calculateUsageCost(usage, standardRateCard);

      expect(calc.breakdown.netInputTokens).toBe(200);
      expect(calc.breakdown.cacheReadTokens).toBe(800);
      expect(calc.breakdown.inputCostMicros).toBe(200);
      expect(calc.breakdown.cacheReadCostMicros).toBe(160);
      expect(calc.totalCostMicros).toBe(760);
    });

    it('prices cacheWrite tokens independently', () => {
      const usage: ProviderUsagePayload = createUsagePayload({
        input: 500,
        output: 50,
        cacheWrite: 400,
        semantics: {
          inputIncludesCacheRead: false,
          outputIncludesReasoning: false
        }
      });

      const calc = calculateUsageCost(usage, standardRateCard);
      expect(calc.breakdown.cacheWriteTokens).toBe(400);
      // 400 * 1.25 micro = 500 micros
      expect(calc.breakdown.cacheWriteCostMicros).toBe(500);
    });
  });

  describe('Anti-double counting: reasoning & output (ADR-0003 §7.3.4)', () => {
    it('does not add reasoning tokens again when outputIncludesReasoning === true and not separately billed', () => {
      // 500 total completion tokens, including 300 reasoning tokens
      const usage: ProviderUsagePayload = createUsagePayload({
        input: 100,
        output: 500,
        reasoning: 300,
        semantics: {
          inputIncludesCacheRead: false,
          outputIncludesReasoning: true
        }
      });

      const calc = calculateUsageCost(usage, standardRateCard);

      // netOutputTokens remains 500; reasoningCost is 0 to avoid double counting
      expect(calc.breakdown.netOutputTokens).toBe(500);
      expect(calc.breakdown.reasoningCostMicros).toBe(0);
      // Output cost: 500 * 4 = 2000 micros
      expect(calc.breakdown.outputCostMicros).toBe(2000);
    });

    it('splits output and reasoning when reasoningSeparatelyBilled === true and outputIncludesReasoning === true', () => {
      const separateReasoningRateCard: ModelRateCard = {
        ...standardRateCard,
        reasoningRatePerMillion: 8_000_000, // 8 micro / reasoning token
        reasoningSeparatelyBilled: true
      };

      const usage: ProviderUsagePayload = createUsagePayload({
        input: 100,
        output: 500,
        reasoning: 300,
        semantics: {
          inputIncludesCacheRead: false,
          outputIncludesReasoning: true
        }
      });

      const calc = calculateUsageCost(usage, separateReasoningRateCard);

      // net standard output = 500 - 300 = 200 tokens
      expect(calc.breakdown.netOutputTokens).toBe(200);
      expect(calc.breakdown.outputCostMicros).toBe(800); // 200 * 4

      // reasoning = 300 tokens * 8 = 2400 micros
      expect(calc.breakdown.reasoningTokens).toBe(300);
      expect(calc.breakdown.reasoningCostMicros).toBe(2400);

      // Total = 100 (input) + 800 (output) + 2400 (reasoning) = 3300 micros
      expect(calc.totalCostMicros).toBe(3300);
    });

    it('adds reasoning tokens to output when outputIncludesReasoning === false and not separately billed', () => {
      const usage: ProviderUsagePayload = createUsagePayload({
        input: 100,
        output: 200,
        reasoning: 300,
        semantics: {
          inputIncludesCacheRead: false,
          outputIncludesReasoning: false
        }
      });

      const calc = calculateUsageCost(usage, standardRateCard);

      // net output = 200 + 300 = 500 tokens
      expect(calc.breakdown.netOutputTokens).toBe(500);
      expect(calc.breakdown.outputCostMicros).toBe(2000);
      expect(calc.breakdown.reasoningCostMicros).toBe(0);
    });
  });

  describe('Three-state precision & conservative non-zero unknown cost (ADR-0003 §7.3.2 & §7.3.5)', () => {
    it('sets provenance to "measured" when all metrics are measured and semantics declared', () => {
      const usage = createUsagePayload({
        input: 500,
        output: 200,
        semantics: { inputIncludesCacheRead: true, outputIncludesReasoning: false },
        precision: 'measured'
      });

      const calc = calculateUsageCost(usage, standardRateCard);
      expect(calc.provenance).toBe('measured');
      expect(calc.conservative).toBe(false);
    });

    it('sets provenance to "estimated" when at least one metric is estimated', () => {
      const usage: ProviderUsagePayload = {
        inputTokens: metric(500, 'measured'),
        outputTokens: metric(200, 'estimated'),
        countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: false }
      };

      const calc = calculateUsageCost(usage, standardRateCard);
      expect(calc.provenance).toBe('estimated');
      expect(calc.conservative).toBe(false);
    });

    it('forces provenance to "unknown" and conservative=true when countingSemantics is missing', () => {
      const usage: ProviderUsagePayload = {
        inputTokens: metric(500, 'measured'),
        outputTokens: metric(200, 'measured')
        // countingSemantics missing!
      };

      const calc = calculateUsageCost(usage, standardRateCard);
      expect(calc.provenance).toBe('unknown');
      expect(calc.conservative).toBe(true);
      expect(calc.auditNote).toContain('countingSemantics undeclared');
    });

    it('enforces non-zero conservative upper bound for unknown 0-token usage (ADR-0003 §7.3.5)', () => {
      // 0 tokens with unknown precision
      const usage: ProviderUsagePayload = {
        inputTokens: metric(0, 'unknown'),
        outputTokens: metric(0, 'unknown'),
        countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: false }
      };

      const calc = calculateUsageCost(usage, standardRateCard);

      // MUST NOT be 0!
      expect(calc.provenance).toBe('unknown');
      expect(calc.conservative).toBe(true);
      expect(calc.totalCostMicros).toBe(standardRateCard.conservativeFallbackCostMicros);
      expect(calc.totalCostMicros).toBeGreaterThan(0);
      expect(calc.breakdown.conservativeSurchargeMicros).toBe(standardRateCard.conservativeFallbackCostMicros);
    });
  });
});
