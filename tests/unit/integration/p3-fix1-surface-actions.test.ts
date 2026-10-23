/**
 * P3-FIX1 (BLOCKING): jitrl.surfaceActions must be reachable end to end.
 *
 * The verifier found the flag existed only inside jit-active-policy.ts: it was
 * absent from JitRlConfig, absent from validation, not forwarded by the kernel
 * facade and not passed by the plugin, so `candidates()` always took the
 * single-per-kind branch and focusSurfaces was never written back. These tests
 * exercise the PLUGIN path (buildJitRlWiring), which is exactly what the unit
 * decorator tests could not cover.
 */
import { describe, expect, it } from 'vitest';
import type {
  BatchPlan,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  HarnessComponentKey,
  SelectBatchRequest
} from '../../../src/types/contracts';
import {
  buildJitRlWiring,
  createEvoHarnessPlugin
} from '../../../src/index';
import {
  createActivePolicy,
  createDefaultPolicy
} from '../../../src/dream-rsi/active-policy';
import { parseEvoHarnessConfig, validateEvoHarnessConfig } from '../../../src/config';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';
import { readJitDiagnostics } from '../../../src/jitrl/jit-active-policy';
import { e2eConfig } from '../../e2e/fixtures';

const T0 = 1_700_000_000_000;

const TASK = {
  id: 'task-p3fix1',
  prompt: 'Fix the failing build without breaking the release train.',
  taskSignature: 'fix-build',
  complexity: 'moderate' as const,
  contextTags: ['ci']
};

const ALL_SURFACES: readonly HarnessComponentKey[] = [
  'system_prompt',
  'guardrails',
  'memory',
  'tool_guidance',
  'skills',
  'scripts',
  'subagents',
  'plugins'
];

function node(
  overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>
): DiscoveryNode {
  return {
    treeId: 'tree-p3fix1',
    parentId: null,
    depth: 0,
    branchId: 'branch-' + overrides.id,
    patchId: 'patch-' + overrides.id,
    patchOrigin: 'reference',
    purpose: 'initial',
    guidance: 'memory',
    status: 'succeeded',
    childIds: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

/** Root hinting all eight surfaces, so the action space can reach 4 x 8. */
function eightSurfaceTree(): DiscoveryTreeSnapshot {
  const nodes: Record<string, DiscoveryNode> = {
    root: node({
      id: 'root',
      guidance: 'guidance_free',
      metadata: { surfaceKeys: [...ALL_SURFACES] }
    }),
    best: node({
      id: 'best',
      parentId: 'root',
      depth: 1,
      slot: 'exploit',
      purpose: 'deepen',
      score: 0.9,
      metadata: { surfaceKeys: [...ALL_SURFACES] }
    })
  };
  nodes.root = { ...(nodes.root as DiscoveryNode), childIds: ['best'] };
  return {
    id: 'tree-p3fix1',
    sessionId: 'session-p3fix1',
    taskId: TASK.id,
    rootId: 'root',
    nodes,
    policyId: 'pi-0',
    stats: {
      nodeCount: 2,
      maxDepth: 1,
      maxWidth: 2,
      scoredNodes: 1,
      completedNodes: 2
    },
    completed: false,
    createdAt: T0,
    updatedAt: T0
  };
}

function request(): SelectBatchRequest {
  return {
    task: TASK,
    sessionId: 'session-p3fix1',
    tree: eightSurfaceTree(),
    grid: {
      maxWidth: 8,
      maxDepth: 2,
      budget: 8,
      skipProbing: false,
      stopCondition: 'budget_exhausted',
      complexity: 'moderate',
      rationale: 'p3-fix1 grid',
      policyId: 'pi-0'
    },
    memoryConfidence: 0.8,
    round: 1,
    previousBestNodeId: 'best'
  };
}

/** L2 experience rewarding exactly one surface of the exploit track. */
function surfaceHistory(
  surface: HarnessComponentKey,
  value: number,
  idPrefix: string
): readonly ExperienceRecord[] {
  const state = abstractMetaState({
    task: TASK,
    round: 1,
    parentDepth: 1,
    parentSlot: 'exploit',
    memoryConfidence: 0.8,
    referenceStatus: 'missing'
  });
  return [0, 1, 2, 3].map((index) => ({
    id: idPrefix + '-' + String(index),
    // The L1 decorator retrieves at level 'meta'; a 'proposal' record would be
    // filtered out by the cross-level guard before it could express a preference.
    level: 'meta' as const,
    state,
    actionKey: normalizeMetaAction('exploit', [surface]),
    reward: value,
    return: value,
    rewardSources: { surrogate: value },
    guidance: 'memory' as const,
    policyId: 'pi-0',
    sessionId: 'session-p3fix1',
    treeId: 'tree-p3fix1',
    nodeId: 'node-' + String(index),
    createdAt: T0 - 100,
    redacted: true
  }));
}

/**
 * Deterministic exploration setting for every assertion in this file.
 *
 * `buildJitRlWiring` exposes no rng seam, so the production default falls back
 * to Math.random and `estimateActionValues` performs one Bernoulli draw per
 * unsupported action (`explored = draw < lambda`, value-estimator.ts:229). At the
 * configured default lambda 0.05 that made ~5% of the actions explore per
 * decision, which turned "cold start" into "sometimes KL > 0" and flaked the
 * byte-identical assertion roughly one run in ten.
 *
 * Pinning lambda to 0 (never explore) or 1 (always explore) makes the draw
 * irrelevant: Math.random() is always in [0, 1), so `draw < 0` is always false
 * and `draw < 1` is always true. Both settings are therefore deterministic
 * without an injected rng, and neither weakens an assertion - they only state
 * which path the test is about.
 */
export const NEVER_EXPLORE = 0;
export const ALWAYS_EXPLORE = 1;

/** Build the plugin wiring for a given surfaceActions setting and lambda. */
function wiringFor(
  surfaceActions: boolean,
  lambda: number = NEVER_EXPLORE
): {
  readonly policy: ReturnType<typeof buildJitRlWiring>['policy'];
  readonly diagnostics: string[];
} {
  const config = parseEvoHarnessConfig(
    e2eConfig({
      config: {
        jitrl: { enabled: true, levels: ['meta'], surfaceActions, exploration: { lambda, alpha: 5 } }
      }
    })
  );
  const now = (): number => T0;
  const base = createActivePolicy({
    policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, now),
    now,
    maxRecoverySlots: 1
  });
  const diagnostics: string[] = [];
  const { policy } = buildJitRlWiring({
    config,
    policy: base,
    options: {},
    persistence: undefined,
    diagnostics,
    now
  });
  return { policy, diagnostics };
}

describe('P3-FIX1: jitrl.surfaceActions is reachable from configuration', () => {
  it('the verifier repro is now accepted', () => {
    // Before the fix: { ok: false, issues: [{ path: 'jitrl.surfaceActions',
    // code: 'unknown_key' }] }.
    const result = validateEvoHarnessConfig({ jitrl: { surfaceActions: true } });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.config?.jitrl.surfaceActions).toBe(true);
  });

  it('rejects a non-boolean so the strict group stays strict', () => {
    const result = validateEvoHarnessConfig({ jitrl: { surfaceActions: 'yes' } });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'jitrl.surfaceActions', code: 'invalid_type' })
    );
  });

  it('defaults to false in the resolved plugin config', () => {
    expect(parseEvoHarnessConfig(e2eConfig()).jitrl.surfaceActions).toBe(false);
  });
});

describe('P3-FIX1: the plugin path forwards the flag (acceptance)', () => {
  it('surfaceActions=false yields a plan byte-identical to the undecorated policy', () => {
    const plain = createActivePolicy({
      policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0),
      now: () => T0,
      maxRecoverySlots: 1
    });
    const expected = plain.selectBatch(request());
    // lambda = 0 => never explore => every unsupported action keeps advantage 0,
    // so the correction is a no-op. (A cold store alone does NOT imply KL 0:
    // optimistic exploration is by design, which is what flaked this test.)
    const { policy } = wiringFor(false, NEVER_EXPLORE);
    const actual: BatchPlan = policy.selectBatch(request());

    // Still exact equality - the deterministic path must not need a tolerance.
    expect(actual.slots).toEqual(expected.slots);
    expect(actual.width).toBe(expected.width);
    expect(actual.policyId).toBe(expected.policyId);
    expect(readJitDiagnostics(actual)?.klToPrior).toBe(0);
  });

  it('with exploration enabled the same cold store is no longer a no-op', () => {
    // Keeps the behaviour that caused the flake under test instead of hiding it:
    // lambda = 1 => every unsupported action explores => some advantage is
    // non-zero => KL > 0 => the decorator re-apportions rather than returning the
    // baseline byte-for-byte. This is the deliberate counterpart to the
    // byte-identical case above.
    const plain = createActivePolicy({
      policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0),
      now: () => T0,
      maxRecoverySlots: 1
    });
    const expected = plain.selectBatch(request());
    const { policy } = wiringFor(false, ALWAYS_EXPLORE);
    const actual = policy.selectBatch(request());
    const diagnostics = readJitDiagnostics(actual);

    expect(diagnostics?.klToPrior).toBeGreaterThan(0);
    // At least one action had no support, so it must have been explored.
    expect(diagnostics?.adjustments.some((entry) => entry.explored)).toBe(true);
    // The plan is still a legal plan; only the correction stopped being a no-op.
    expect(actual.slots.length).toBeGreaterThan(0);
    expect(actual.policyId).toBe(expected.policyId);
  });

  it('surfaceActions=true changes the plan: 32 candidates instead of 4', () => {
    const runs = wiringFor(true, NEVER_EXPLORE);
    const plan = runs.policy.selectBatch(request());
    const diagnostics = readJitDiagnostics(plan);

    // THE BLOCKING ASSERTION: before the fix this was always 4 because the flag
    // never reached the decorator. The plugin path must now produce the full
    // slotKind x focusSurface space (4 kinds x 8 surfaces).
    expect(diagnostics?.adjustments).toHaveLength(32);
    for (const entry of diagnostics?.adjustments ?? []) {
      expect(entry.focusSurfaces).toHaveLength(1);
      expect(entry.actionKey).toContain('/surf:');
    }
  });

  it('surfaceActions=true writes focus surfaces back onto the plan', () => {
    // Seed the decorator's live experience snapshot through the kernel store so
    // the correction has support and the write-back path runs (KL > 0).
    const history = [
      ...surfaceHistory('tool_guidance', 2.6, 'win'),
      ...surfaceHistory('skills', -2.4, 'lose')
    ];
    const seeded = buildJitRlWiring({
      config: parseEvoHarnessConfig(
        e2eConfig({
          config: {
            jitrl: {
              enabled: true,
              levels: ['meta'],
              surfaceActions: true,
              // Deterministic: no optimistic-exploration draws, so the only
              // advantage comes from the seeded surface preference.
              exploration: { lambda: NEVER_EXPLORE, alpha: 5 }
            }
          }
        })
      ),
      policy: createActivePolicy({
        policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0),
        now: () => T0,
        maxRecoverySlots: 1
      }),
      options: {},
      persistence: undefined,
      diagnostics: [],
      now: () => T0
    });
    const kernelStore = seeded.wiring.kernel?.store;
    expect(kernelStore).toBeDefined();
    return kernelStore?.append(history).then(() => {
      const plan = seeded.policy.selectBatch(request());
      const diagnostics = readJitDiagnostics(plan);
      expect(diagnostics?.klToPrior).toBeGreaterThan(0);
      const exploitSlots = plan.slots.filter((slot) => slot.slot === 'exploit');
      expect(exploitSlots.length).toBeGreaterThan(0);
      // The winning surface leads the focus list, and the set stays legal.
      for (const slot of exploitSlots) {
        expect(slot.focusSurfaces[0]).toBe('tool_guidance');
        for (const surface of slot.focusSurfaces) {
          expect(ALL_SURFACES).toContain(surface);
        }
      }
    });
  });

  it('a real plugin mount honours the flag (createEvoHarnessPlugin)', () => {
    // The end-to-end shape a host actually uses.
    const surfaceActionsOn = createEvoHarnessPlugin(
      {
        config: e2eConfig({
          config: { jitrl: { enabled: true, levels: ['meta'], surfaceActions: true } }
        })
      },
      {}
    );
    expect(surfaceActionsOn.config.jitrl.surfaceActions).toBe(true);
    expect(surfaceActionsOn.jitrl.enabled).toBe(true);

    const surfaceActionsOff = createEvoHarnessPlugin(
      {
        config: e2eConfig({
          config: { jitrl: { enabled: true, levels: ['meta'], surfaceActions: false } }
        })
      },
      {}
    );
    expect(surfaceActionsOff.config.jitrl.surfaceActions).toBe(false);
  });
});
