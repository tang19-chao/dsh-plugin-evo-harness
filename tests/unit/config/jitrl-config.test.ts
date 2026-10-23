/**
 * P1-6: strict `jitrl` configuration group. Covers the plan section 5.2
 * defaults, deep-merge overrides, unknown-key rejection at every nesting
 * level, closed enums, deterministic range checks, reward-weight
 * normalization, and the section 5.2 YAML shape parsed through
 * parseEvoHarnessConfig (with schemaVersion deliberately kept at 1).
 */
import { describe, expect, it } from 'vitest';
import { HARNESS_COMPONENT_KEYS } from '../../../src/types/contracts';
import {
  DEFAULT_EVO_HARNESS_CONFIG,
  createDefaultConfig,
  parseEvoHarnessConfig,
  resolveEvoHarnessConfig,
  validateEvoHarnessConfig
} from '../../../src/config';

const DEFAULT_JITRL = {
  enabled: true,
  levels: ['meta', 'proposal'],
  logitSource: 'auto',
  selection: 'argmax',
  beta: 1.0,
  k: 10,
  similarityThreshold: 0.3,
  gamma: 0.5,
  exploration: { lambda: 0.05, alpha: 5 },
  candidateCount: 3,
  augmentFromMemory: true,
  surfaceActions: false,
  minSupportForStrongPrior: 3,
  unseenFallback: 'baseline',
  store: {
    driver: 'jsonl',
    mirrorToMemoryBridge: false,
    maxPerBucket: 200,
    halfLifeDays: 30
  },
  reward: {
    llmEvaluator: true,
    weights: { llm: 0.4, surrogate: 0.3, tool: 0.2, turn: 0.1, user: 0.0 },
    clip: [-3, 3]
  },
  hostAdvisor: {
    enabled: false,
    mode: 'advisory',
    adviseThreshold: -0.5,
    gateThreshold: -0.8,
    minSupport: 5
  },
  dream: {
    driftRho: 0.7,
    hyperparamPerturbation: true,
    candidateJitBetas: [0.5, 1, 2],
    candidateJitLambdas: [0.02, 0.05, 0.1]
  },
  privacy: { redactSecrets: true, storeRawText: false }
} as const;

describe('jitrl config group (P1-6)', () => {
  it('resolves the plan section 5.2 defaults', () => {
    expect(createDefaultConfig().jitrl).toEqual(DEFAULT_JITRL);
  });

  it('deep-freezes the shared jitrl defaults', () => {
    const jitrl = DEFAULT_EVO_HARNESS_CONFIG.jitrl;
    expect(Object.isFrozen(jitrl)).toBe(true);
    expect(Object.isFrozen(jitrl.store)).toBe(true);
    expect(Object.isFrozen(jitrl.reward)).toBe(true);
    expect(Object.isFrozen(jitrl.reward.weights)).toBe(true);
    expect(Object.isFrozen(jitrl.exploration)).toBe(true);
  });

  it('keeps CONFIG_SCHEMA_VERSION at 1 (deliberate deviation from the doc YAML)', () => {
    expect(parseEvoHarnessConfig({}).schemaVersion).toBe(1);
  });

  it('deep-merges jitrl overrides over the defaults', () => {
    const config = resolveEvoHarnessConfig({
      jitrl: { beta: 2.5, exploration: { lambda: 0.2 } }
    });
    expect(config.jitrl.beta).toBe(2.5);
    expect(config.jitrl.exploration.lambda).toBe(0.2);
    expect(config.jitrl.exploration.alpha).toBe(5);
    expect(config.jitrl.k).toBe(10);
  });

  it('replaces level arrays and reward clip tuples whole', () => {
    const config = resolveEvoHarnessConfig({
      jitrl: {
        levels: ['meta', 'proposal', 'host_tool'],
        reward: { clip: [-1, 1] }
      }
    });
    expect(config.jitrl.levels).toEqual(['meta', 'proposal', 'host_tool']);
    expect(config.jitrl.reward.clip).toEqual([-1, 1]);
  });

  it('rejects unknown keys at every jitrl nesting level', () => {
    const top = validateEvoHarnessConfig({ jitrl: { nope: 1 } });
    expect(top.ok).toBe(false);
    expect(top.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.nope', code: 'unknown_key' })
    );
    const nested = validateEvoHarnessConfig({
      jitrl: {
        store: { nope: true },
        reward: { weights: { bonus: 0.5 } }
      }
    });
    expect(nested.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.store.nope', code: 'unknown_key' })
    );
    expect(nested.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.reward.weights.bonus', code: 'unknown_key' })
    );
  });

  it('rejects invalid values for every new enum', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['jitrl.levels[0]', { jitrl: { levels: ['bogus'] } }],
      ['jitrl.logitSource', { jitrl: { logitSource: 'psychic' } }],
      ['jitrl.selection', { jitrl: { selection: 'roulette' } }],
      ['jitrl.unseenFallback', { jitrl: { unseenFallback: 'random' } }],
      ['jitrl.store.driver', { jitrl: { store: { driver: 'sqlite' } } }],
      ['jitrl.hostAdvisor.mode', { jitrl: { hostAdvisor: { mode: 'yolo' } } }]
    ];
    for (const [path, raw] of cases) {
      const result = validateEvoHarnessConfig(raw);
      expect(result.ok, path).toBe(false);
      expect(result.issues, path).toContainEqual(
        expect.objectContaining({ path, code: 'invalid_enum' })
      );
    }
  });

  it('enforces deterministic ranges for beta, k, thresholds and store bounds', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['jitrl.beta', { jitrl: { beta: -0.1 } }],
      ['jitrl.beta', { jitrl: { beta: 100.1 } }],
      ['jitrl.k', { jitrl: { k: 0 } }],
      ['jitrl.k', { jitrl: { k: 1001 } }],
      ['jitrl.similarityThreshold', { jitrl: { similarityThreshold: 1.5 } }],
      ['jitrl.gamma', { jitrl: { gamma: -0.1 } }],
      ['jitrl.exploration.lambda', { jitrl: { exploration: { lambda: 1.5 } } }],
      ['jitrl.exploration.alpha', { jitrl: { exploration: { alpha: -1 } } }],
      ['jitrl.candidateCount', { jitrl: { candidateCount: 0 } }],
      ['jitrl.store.maxPerBucket', { jitrl: { store: { maxPerBucket: 0 } } }],
      ['jitrl.store.halfLifeDays', { jitrl: { store: { halfLifeDays: -1 } } }],
      ['jitrl.hostAdvisor.minSupport', { jitrl: { hostAdvisor: { minSupport: -1 } } }],
      ['jitrl.reward.clip[0]', { jitrl: { reward: { clip: [-1001, 3] } } }]
    ];
    for (const [path, raw] of cases) {
      const result = validateEvoHarnessConfig(raw);
      expect(result.issues, path).toContainEqual(
        expect.objectContaining({ path, code: 'out_of_range' })
      );
    }
  });

  it('rejects a reversed clip window', () => {
    const result = validateEvoHarnessConfig({
      jitrl: { reward: { clip: [3, -3] } }
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.reward.clip', code: 'invalid_value' })
    );
  });

  it('rejects duplicate jitrl levels', () => {
    const result = validateEvoHarnessConfig({
      jitrl: { levels: ['meta', 'meta'] }
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.levels[1]', code: 'duplicate_value' })
    );
  });

  it('rejects wrong types with deterministic paths', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['jitrl', { jitrl: 'yes' }],
      ['jitrl.beta', { jitrl: { beta: 'fast' } }],
      ['jitrl.k', { jitrl: { k: 1.5 } }],
      ['jitrl.levels', { jitrl: { levels: 'meta' } }],
      ['jitrl.surfaceActions', { jitrl: { surfaceActions: 'yes' } }],
      ['jitrl.reward.clip', { jitrl: { reward: { clip: [-3] } } }],
      ['jitrl.reward.weights', { jitrl: { reward: { weights: 'all' } } }]
    ];
    for (const [path, raw] of cases) {
      const result = validateEvoHarnessConfig(raw);
      expect(result.issues, path).toContainEqual(
        expect.objectContaining({ path, code: 'invalid_type' })
      );
    }
  });

  it('rejects reward weights that do not sum to 1', () => {
    const result = validateEvoHarnessConfig({
      jitrl: {
        reward: {
          weights: { llm: 0.5, surrogate: 0.3, tool: 0.1, turn: 0.05, user: 0.0 }
        }
      }
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.reward.weights', code: 'weights_not_normalized' })
    );
  });

  it('accepts alternative reward weights that sum to 1', () => {
    const result = validateEvoHarnessConfig({
      jitrl: {
        reward: {
          weights: { llm: 0.5, surrogate: 0.5, tool: 0.0, turn: 0.0, user: 0.0 }
        }
      }
    });
    expect(result.ok).toBe(true);
  });

  it('parses the plan section 5.2 YAML shape via parseEvoHarnessConfig', () => {
    const raw = {
      schemaVersion: 1,
      enabled: true,
      triggerMode: 'auto_fallback',
      enabledSurfaces: [...HARNESS_COMPONENT_KEYS],
      jitrl: {
        enabled: true,
        levels: ['meta', 'proposal'],
        logitSource: 'auto',
        selection: 'argmax',
        beta: 1.0,
        k: 10,
        similarityThreshold: 0.35,
        gamma: 0.5,
        exploration: { lambda: 0.05, alpha: 5 },
        candidateCount: 3,
        augmentFromMemory: true,
        minSupportForStrongPrior: 3,
        unseenFallback: 'baseline',
        store: {
          driver: 'jsonl',
          mirrorToMemoryBridge: false,
          maxPerBucket: 200,
          halfLifeDays: 30
        },
        reward: {
          llmEvaluator: true,
          weights: { llm: 0.4, surrogate: 0.3, tool: 0.2, turn: 0.1, user: 0.0 },
          clip: [-3, 3]
        },
        hostAdvisor: {
          enabled: false,
          mode: 'advisory',
          adviseThreshold: -0.5,
          gateThreshold: -0.8,
          minSupport: 5
        },
        dream: {
          driftRho: 0.7,
          hyperparamPerturbation: true,
          candidateJitBetas: [0.5, 1, 2],
          candidateJitLambdas: [0.02, 0.05, 0.1]
        },
        privacy: { redactSecrets: true, storeRawText: false }
      }
    };
    const config = parseEvoHarnessConfig(raw);
    expect(config.schemaVersion).toBe(1);
    expect(config.jitrl.similarityThreshold).toBe(0.35);
    expect(config.jitrl).toEqual({ ...DEFAULT_JITRL, similarityThreshold: 0.35 });
  });
});
describe('jitrl.surfaceActions (P3-FIX1: G2-1 must be reachable from config)', () => {
  it('defaults to false so the pre-G2-1 behaviour is preserved', () => {
    expect(createDefaultConfig().jitrl.surfaceActions).toBe(false);
    expect(DEFAULT_EVO_HARNESS_CONFIG.jitrl.surfaceActions).toBe(false);
  });

  it('is no longer rejected as an unknown key (the verifier repro)', () => {
    // Before P3-FIX1 this returned { ok: false, issues: [{ path:
    // 'jitrl.surfaceActions', code: 'unknown_key' }] }, which made the flag
    // permanently false at runtime.
    const result = validateEvoHarnessConfig({ jitrl: { surfaceActions: true } });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.config?.jitrl.surfaceActions).toBe(true);
  });

  it('accepts both booleans and resolves them into the effective config', () => {
    expect(resolveEvoHarnessConfig({ jitrl: { surfaceActions: true } }).jitrl.surfaceActions).toBe(
      true
    );
    expect(resolveEvoHarnessConfig({ jitrl: { surfaceActions: false } }).jitrl.surfaceActions).toBe(
      false
    );
  });

  it('rejects a non-boolean with invalid_type at the documented path', () => {
    for (const bad of ['yes', 1, null, {}] as const) {
      const result = validateEvoHarnessConfig({ jitrl: { surfaceActions: bad } });
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: 'jitrl.surfaceActions', code: 'invalid_type' })
      );
    }
  });

  it('survives a round trip through parseEvoHarnessConfig', () => {
    const parsed = parseEvoHarnessConfig({ jitrl: { surfaceActions: true } });
    expect(parsed.jitrl.surfaceActions).toBe(true);
  });
});

/**
 * Phase 4 (T1): `jitrl.dream` carries the Dream-RSI x JitRL dual-loop keys from
 * plan section 7.3. Every key must be reachable from config (a missing key set
 * entry would make the flag permanently unreachable through unknown_key), and
 * every value must be range/enum/array checked instead of silently accepted.
 */
describe('jitrl.dream (Phase 4 dual-loop settings)', () => {
  it('defaults to driftRho 0.7 plus the perturbation grids of plan section 7.3', () => {
    const dream = createDefaultConfig().jitrl.dream;
    expect(dream).toEqual({
      driftRho: 0.7,
      hyperparamPerturbation: true,
      candidateJitBetas: [0.5, 1, 2],
      candidateJitLambdas: [0.02, 0.05, 0.1]
    });
    expect(DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.driftRho).toBe(0.7);
    expect(DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.hyperparamPerturbation).toBe(true);
  });

  it('deep-freezes the dream defaults', () => {
    const dream = DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream;
    expect(Object.isFrozen(dream)).toBe(true);
    expect(Object.isFrozen(dream.candidateJitBetas)).toBe(true);
    expect(Object.isFrozen(dream.candidateJitLambdas)).toBe(true);
  });

  it('is not rejected as an unknown key (each new key is registered)', () => {
    const result = validateEvoHarnessConfig({
      jitrl: {
        dream: {
          driftRho: 0.5,
          hyperparamPerturbation: false,
          candidateJitBetas: [1, 4],
          candidateJitLambdas: [0.1]
        }
      }
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.config?.jitrl.dream).toEqual({
      driftRho: 0.5,
      hyperparamPerturbation: false,
      candidateJitBetas: [1, 4],
      candidateJitLambdas: [0.1]
    });
  });

  it('rejects unknown keys inside jitrl.dream with unknown_key', () => {
    const result = validateEvoHarnessConfig({ jitrl: { dream: { nope: 1 } } });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.nope', code: 'unknown_key' })
    );
  });

  it('rejects an out-of-range driftRho with out_of_range', () => {
    for (const bad of [-0.1, 1.1] as const) {
      const result = validateEvoHarnessConfig({ jitrl: { dream: { driftRho: bad } } });
      expect(result.issues, String(bad)).toContainEqual(
        expect.objectContaining({ path: 'jitrl.dream.driftRho', code: 'out_of_range' })
      );
    }
  });

  it('accepts the driftRho boundaries', () => {
    for (const value of [0, 1] as const) {
      const result = validateEvoHarnessConfig({ jitrl: { dream: { driftRho: value } } });
      expect(result.ok, String(value)).toBe(true);
      expect(result.config?.jitrl.dream.driftRho).toBe(value);
    }
  });

  it('rejects a non-boolean hyperparamPerturbation with invalid_type', () => {
    for (const bad of ['yes', 1, null, {}] as const) {
      const result = validateEvoHarnessConfig({
        jitrl: { dream: { hyperparamPerturbation: bad } }
      });
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: 'jitrl.dream.hyperparamPerturbation',
          code: 'invalid_type'
        })
      );
    }
  });

  it('rejects empty perturbation grids', () => {
    const betas = validateEvoHarnessConfig({ jitrl: { dream: { candidateJitBetas: [] } } });
    expect(betas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitBetas', code: 'invalid_value' })
    );
    const lambdas = validateEvoHarnessConfig({ jitrl: { dream: { candidateJitLambdas: [] } } });
    expect(lambdas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitLambdas', code: 'invalid_value' })
    );
  });

  it('rejects non-numeric and non-finite grid entries with indexed paths', () => {
    const betas = validateEvoHarnessConfig({
      jitrl: { dream: { candidateJitBetas: [1, 'fast', Number.NaN] } }
    });
    expect(betas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitBetas[1]', code: 'invalid_type' })
    );
    expect(betas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitBetas[2]', code: 'invalid_type' })
    );
    const lambdas = validateEvoHarnessConfig({
      jitrl: { dream: { candidateJitLambdas: 'all' } }
    });
    expect(lambdas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitLambdas', code: 'invalid_type' })
    );
  });

  it('rejects grid entries outside their ranges with out_of_range', () => {
    const betas = validateEvoHarnessConfig({
      jitrl: { dream: { candidateJitBetas: [-1, 100.5] } }
    });
    expect(betas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitBetas[0]', code: 'out_of_range' })
    );
    expect(betas.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream.candidateJitBetas[1]', code: 'out_of_range' })
    );
    const lambdas = validateEvoHarnessConfig({
      jitrl: { dream: { candidateJitLambdas: [0.5, 1.5] } }
    });
    expect(lambdas.issues).toContainEqual(
      expect.objectContaining({
        path: 'jitrl.dream.candidateJitLambdas[1]',
        code: 'out_of_range'
      })
    );
  });

  it('rejects duplicate grid entries instead of silently collapsing them', () => {
    const result = validateEvoHarnessConfig({
      jitrl: { dream: { candidateJitBetas: [1, 1] } }
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: 'jitrl.dream.candidateJitBetas[1]',
        code: 'duplicate_value'
      })
    );
  });

  it('rejects a non-object dream group with invalid_type', () => {
    const result = validateEvoHarnessConfig({ jitrl: { dream: 'on' } });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.dream', code: 'invalid_type' })
    );
  });

  it('replaces perturbation grids whole rather than merging element-wise', () => {
    const config = resolveEvoHarnessConfig({
      jitrl: { dream: { candidateJitBetas: [4] } }
    });
    expect(config.jitrl.dream.candidateJitBetas).toEqual([4]);
    // Sibling keys keep their defaults through the deep merge.
    expect(config.jitrl.dream.candidateJitLambdas).toEqual([0.02, 0.05, 0.1]);
    expect(config.jitrl.dream.driftRho).toBe(0.7);
  });

  it('parses the plan section 7.3 dream keys through parseEvoHarnessConfig', () => {
    const parsed = parseEvoHarnessConfig({
      jitrl: {
        dream: {
          driftRho: 0.6,
          hyperparamPerturbation: false,
          candidateJitBetas: [0.5, 1, 2],
          candidateJitLambdas: [0.02, 0.05, 0.1]
        }
      }
    });
    expect(parsed.jitrl.dream.driftRho).toBe(0.6);
    expect(parsed.jitrl.dream.hyperparamPerturbation).toBe(false);
  });
});
