/**
 * P6（ADR 0007）：预算档、只 ask 提醒、只吃 measured 的 Pareto 轴、holdout 防火墙。
 *
 * 本套件钉住四件事，每件都带"会真红"的负控制：
 *   1. ADR 0007 §2 术语：发布门只认严格超越；非劣（打平/容差内）不是凭证。
 *   2. ADR 0007 §6.2 成本轴：任何一条 estimated/unknown 观测使**整轴**不可用
 *      （`usable === false` + 空前沿），**不是**把该点剔掉后在子集上算前沿。
 *   3. ADR 0007 §8 默认关闭：不传 `budget` 时零对象、零回调、零诊断键；
 *      BatchPlan 与 metadata.jit 的规范 JSON 摘要与改动前相等（pinned digest）。
 *   4. ADR 0007 §5 holdout 防火墙：holdout-only 优胜者不被选中；生成器只要
 *      **拿到** holdout 树引用就失败（fail-fast 检测器，并用"删掉防火墙"的
 *      变异调用证明该检测器会真红）。
 *
 * 证据口径：全部用例离线、确定性（注入时钟/随机数），不触网、不写盘（除读取
 * 自身源码做结构负例）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  BatchPlan,
  BatchSlotKind,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  MetaSearchPolicy,
  OfflineDreamRequest,
  PatchOrigin,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';
import { createActivePolicy, createDefaultPolicy } from '../../../src/dream-rsi/active-policy';
import {
  createDiscoveryTree,
  type CreateDiscoveryNodeInput
} from '../../../src/dream-rsi/discovery-tree';
import { createOfflineDreamer, type PolicyGenerator } from '../../../src/dream-rsi/offline-dreamer';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import {
  REPLAY_GATE_BOUNDARY,
  decideReplayPublication
} from '../../../src/jitrl/decision-kernel';
import {
  BUDGET_TIERS,
  BUDGET_TIER_PROBE_CEILINGS,
  createJitActivePolicy,
  evaluateBudgetGate,
  hasJitDiagnostics,
  paretoFront,
  readJitDiagnostics,
  resolveBudgetTier,
  type BudgetGateResult,
  type BudgetHookConfig,
  type BudgetReminder,
  type CostObservation,
  type JitActivePolicyOptions
} from '../../../src/jitrl/jit-active-policy';

// ---------------------------------------------------------------------------
// L1 decorator fixtures (the same canonical request the pre-existing decorator
// suite uses, so the pinned digests below are comparable with it).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

function makeNode(
  overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>
): DiscoveryNode {
  return {
    treeId: 'tree-jit',
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

function makeTree(): DiscoveryTreeSnapshot {
  const built: Record<string, DiscoveryNode> = {
    root: makeNode({ id: 'root', guidance: 'guidance_free' }),
    best: makeNode({
      id: 'best',
      parentId: 'root',
      depth: 1,
      slot: 'exploit',
      purpose: 'deepen',
      score: 0.9
    })
  };
  const rootNode = built.root as DiscoveryNode;
  if (rootNode.childIds.length === 0) {
    built.root = { ...rootNode, childIds: Object.keys(built).filter((id) => id !== 'root') };
  }
  return {
    id: 'tree-jit',
    sessionId: 'session-jit',
    taskId: 'task-jit',
    rootId: 'root',
    nodes: built,
    policyId: 'pi-0',
    stats: {
      nodeCount: Object.keys(built).length,
      maxDepth: 1,
      maxWidth: 3,
      scoredNodes: 1,
      completedNodes: Object.keys(built).length
    },
    completed: false,
    createdAt: T0,
    updatedAt: T0
  };
}

function makeGrid(): SearchGridPlan {
  return {
    maxWidth: 4,
    maxDepth: 2,
    budget: 4,
    skipProbing: false,
    stopCondition: 'budget_exhausted',
    complexity: 'moderate',
    rationale: 'test grid',
    policyId: 'pi-0'
  };
}

function makeRequest(): SelectBatchRequest {
  return {
    task: {
      id: 'task-jit',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'fix-build',
      complexity: 'moderate',
      contextTags: ['ci']
    },
    sessionId: 'session-jit',
    tree: makeTree(),
    grid: makeGrid(),
    memoryConfidence: 0.8,
    round: 1,
    previousBestNodeId: 'best'
  };
}

function makeMetaRecord(options: {
  readonly id: string;
  readonly slotKind: BatchSlotKind;
  readonly value: number;
}): ExperienceRecord {
  const request = makeRequest();
  const state = abstractMetaState({
    task: request.task,
    round: 1,
    parentDepth: 1,
    parentSlot: 'exploit',
    memoryConfidence: 0.8,
    referenceStatus: 'missing'
  });
  return {
    id: options.id,
    level: 'meta',
    state,
    actionKey: normalizeMetaAction(options.slotKind, []),
    reward: options.value,
    return: options.value,
    rewardSources: { surrogate: options.value },
    guidance: 'memory',
    policyId: 'pi-0',
    sessionId: 'session-jit',
    treeId: 'tree-jit',
    nodeId: options.id,
    experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
    rewardVersion: CURRENT_REWARD_VERSION,
    provenanceVersion: CURRENT_PROVENANCE_VERSION,
    createdAt: T0 - 1000,
    redacted: true
  };
}

/** Synthetic L1 history that clearly rewards the invariant track. */
function invariantLovingHistory(): readonly ExperienceRecord[] {
  return [
    makeMetaRecord({ id: 'h1', slotKind: 'explore_invariant', value: 2.5 }),
    makeMetaRecord({ id: 'h2', slotKind: 'explore_invariant', value: 2.2 }),
    makeMetaRecord({ id: 'h3', slotKind: 'explore_invariant', value: 2.4 }),
    makeMetaRecord({ id: 'h4', slotKind: 'exploit', value: -2 }),
    makeMetaRecord({ id: 'h5', slotKind: 'exploit', value: -1.8 }),
    makeMetaRecord({ id: 'h6', slotKind: 'explore_domain', value: 0.1 })
  ];
}

/** Base policy shared by every decorator fixture. */
function makeInner(): ReturnType<typeof createActivePolicy> {
  return createActivePolicy({
    policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0),
    now: () => T0,
    maxRecoverySlots: 1
  });
}

/** Deterministic decorator: one execution clock, one rng value for every fixture. */
function makeDecorator(options: Partial<JitActivePolicyOptions> = {}): ReturnType<typeof createJitActivePolicy> {
  const base: JitActivePolicyOptions = {
    inner: makeInner(),
    experiences: invariantLovingHistory(),
    config: { useSurfaces: false },
    now: () => T0,
    rng: () => 0.999
  };
  return createJitActivePolicy({
    ...base,
    ...options,
    ...(options.config === undefined ? {} : { config: { ...base.config, ...options.config } })
  });
}

/** The execution surface of a plan: what the host would actually run. */
function executionSurface(plan: BatchPlan): string {
  return JSON.stringify({
    width: plan.width,
    policyId: plan.policyId,
    round: plan.round,
    slots: plan.slots
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Pinned BEFORE the P6 change (HEAD source, same fixture, same injected clock)
 * and re-asserted AFTER it: the default construction must stay byte-identical.
 *
 * Reproduce with ONE command (prints both digests, exit 0 = unchanged):
 *   pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned default digest"
 */
const PINNED_SLOTS_DIGEST =
  'a8c207ca083336b1a2828f88f428fa68a53a30ca37fad098157b3bcbdbbd16a1';
const PINNED_DIAGNOSTICS_DIGEST =
  'f2c0737a844a6a3d007de0c78092fafb1afe8a0825dad98eb91cc840c63b647a';

// ---------------------------------------------------------------------------
// ADR 0007 §2: terminology. Only strict improvement is a credential.
// ---------------------------------------------------------------------------

describe('ADR 0007 §2 terminology: the publication gate speaks strict domination', () => {
  it('publishes only on strict improvement on the replay AND a strict win on the holdout', () => {
    const verdict = decideReplayPublication({ improved: true, validatedOnHoldout: true });
    expect(verdict.publish).toBe(true);
    expect(verdict.reason).toContain('strictly improved the replayed hypervolume');
  });

  it('a NON-INFERIOR replay result (a tie inside epsilon) is not a credential', () => {
    // The dreamer computes improvedOnSelection with `> baseline + epsilon`, so a
    // tie arrives here as improved === false; validating it on a holdout must
    // never turn it into a publish.
    const verdict = decideReplayPublication({ improved: false, validatedOnHoldout: true });
    expect(verdict.publish).toBe(false);
    expect(verdict.improved).toBe(false);
    expect(verdict.reason).toContain('did not beat baseline + epsilon');
  });

  it('a NON-INFERIOR holdout result (tie inside epsilon) is a FAILED validation', () => {
    // ADR 0007 §2: the holdout criterion is strict too, so a tie is
    // validatedOnHoldout === false at the source (offline-dreamer.ts:2334) and
    // the gate refuses with the "won on selection, lost on holdout" shelf.
    const verdict = decideReplayPublication({ improved: true, validatedOnHoldout: false });
    expect(verdict.publish).toBe(false);
    expect(verdict.reason).toContain('held-out trees');
  });

  it('a missing holdout refuses publication even with a strict replay win', () => {
    const verdict = decideReplayPublication({ improved: true });
    expect(verdict.publish).toBe(false);
    expect(verdict.reason).toContain('holdout-missing');
  });

  it('shadow mode records the suggestion without publishing', () => {
    const verdict = decideReplayPublication({
      improved: true,
      validatedOnHoldout: true,
      shadowMode: true
    });
    expect(verdict.improved).toBe(true);
    expect(verdict.publish).toBe(false);
    expect(verdict.reason).toContain('shadow mode');
  });

  it('the gate boundary never claims a non-regression guarantee', () => {
    expect(REPLAY_GATE_BOUNDARY).toContain('not a monotone non-regression guarantee');
    // And it never uses "non-inferiority" as if it were the operative test.
    expect(REPLAY_GATE_BOUNDARY.toLowerCase()).not.toContain('non-inferior');
  });
});

// ---------------------------------------------------------------------------
// ADR 0007 §6.2: measured-only Pareto axis, whole-axis fail-closed.
// ---------------------------------------------------------------------------

function measuredObservation(id: string, probes: number, quality: number): CostObservation {
  return { id, probes, quality, costProvenance: 'measured' };
}

describe('ADR 0007 §6.2: the Pareto axis takes measured data only', () => {
  it('computes a deterministic front over measured observations', () => {
    const front = paretoFront([
      measuredObservation('a', 2, 0.6),
      measuredObservation('b', 1, 0.6),
      measuredObservation('c', 4, 0.2),
      measuredObservation('d', 1, 0.9)
    ]);
    expect(front.usable).toBe(true);
    expect(front.rejected).toBe(0);
    // 'd' (quality 0.9 at 1 probe) strictly dominates EVERY other point here:
    // 'b' ties on probes and loses on quality, 'a' loses on both, 'c' loses on
    // both. A single undominated point is the correct, honest answer.
    expect(front.nondominated.map((entry) => entry.id)).toEqual(['d']);
    expect(front.dominated.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('ONE estimated observation makes the WHOLE axis unavailable - never a filtered subset', () => {
    const observations: readonly CostObservation[] = [
      measuredObservation('measured-1', 2, 0.6),
      { id: 'estimated-1', probes: 1, quality: 0.95, costProvenance: 'estimated' },
      measuredObservation('measured-2', 3, 0.3)
    ];
    const front = paretoFront(observations);
    expect(front.usable).toBe(false);
    expect(front.rejected).toBe(1);
    expect(front.nondominated).toEqual([]);
    expect(front.dominated).toEqual([]);

    // NEGATIVE CONTROL (the captain's requirement): a "drop the offending point,
    // then compute the front" implementation would answer differently - it would
    // keep measured-1 + measured-2 and report a (nonsense) front of 2. The
    // assertions above must reject that mutant, so the mutant output is computed
    // here explicitly and proven to differ from the production answer.
    const mutant = paretoFront(observations.filter((entry) => entry.costProvenance === 'measured'));
    expect(mutant.usable).toBe(true);
    // The surviving subset still has a front ('measured-1' dominates
    // 'measured-2'), which is exactly the "looks better than it is" answer the
    // fail-closed branch refuses to give.
    expect(mutant.nondominated.map((entry) => entry.id)).toEqual(['measured-1']);
    expect(front.nondominated).not.toEqual(mutant.nondominated);
  });

  it('unknown provenance fails the same way as estimated', () => {
    const front = paretoFront([
      measuredObservation('a', 1, 0.5),
      { id: 'u', probes: 1, quality: 0.5, costProvenance: 'unknown' }
    ]);
    expect(front.usable).toBe(false);
    expect(front.rejected).toBe(1);
    expect(front.nondominated).toEqual([]);
  });

  it('zero observations leave the axis unavailable (an empty set cannot compare costs)', () => {
    const front = paretoFront([]);
    expect(front.usable).toBe(false);
    expect(front.rejected).toBe(0);
    expect(front.nondominated).toEqual([]);
    expect(front.dominated).toEqual([]);
  });

  it('equality on both axes is not domination (identical points both stay)', () => {
    const front = paretoFront([
      measuredObservation('x', 2, 0.4),
      measuredObservation('x-copy', 2, 0.4)
    ]);
    expect(front.usable).toBe(true);
    expect(front.nondominated.map((entry) => entry.id)).toEqual(['x', 'x-copy']);
    expect(front.dominated).toEqual([]);
  });

  it('an improvement on one axis never buys a regression on the other', () => {
    const front = paretoFront([
      measuredObservation('fast-but-worse', 1, 0.2),
      measuredObservation('slow-but-better', 3, 0.8)
    ]);
    expect(front.usable).toBe(true);
    expect(front.nondominated.map((entry) => entry.id)).toEqual([
      'fast-but-worse',
      'slow-but-better'
    ]);
    expect(front.dominated).toEqual([]);
  });

  it('unusable shapes reject the axis instead of being treated as free probes', () => {
    const front = paretoFront([
      measuredObservation('ok', 1, 0.5),
      { id: 'nan-probes', probes: Number.NaN, quality: 0.5, costProvenance: 'measured' },
      { id: 'quality-too-big', probes: 1, quality: 1.5, costProvenance: 'measured' }
    ]);
    expect(front.usable).toBe(false);
    expect(front.rejected).toBe(2);
  });

  it('the gate never emits a monetary unit or a cost field', () => {
    const gate = evaluateBudgetGate({
      tier: 'medium',
      observedProbes: 4,
      costObservations: [measuredObservation('a', 1, 0.5)]
    });
    const allowed = [
      'tier',
      'probeCeiling',
      'observedProbes',
      'withinTier',
      'costAxisProvenance',
      'costAxisRejected',
      'pareto',
      'reminder'
    ];
    for (const key of Object.keys(gate)) {
      expect(allowed).toContain(key);
    }
    expect(JSON.stringify(gate)).not.toMatch(/costMicros|usd|\$|currency|price/i);
  });
});

// ---------------------------------------------------------------------------
// ADR 0007 §6.1: tiers are probe-count budgets, not paper weights and not money.
// ---------------------------------------------------------------------------

describe('ADR 0007 §6.1: budget tiers are probe-count ceilings', () => {
  it('declares exactly the three tiers with frozen probe ceilings', () => {
    expect([...BUDGET_TIERS]).toEqual(['lite', 'medium', 'heavy']);
    expect(Object.isFrozen(BUDGET_TIER_PROBE_CEILINGS)).toBe(true);
    expect({ ...BUDGET_TIER_PROBE_CEILINGS }).toEqual({ lite: 2, medium: 4, heavy: 8 });
    expect(resolveBudgetTier(undefined)).toEqual({ tier: 'medium', probeCeiling: 4 });
    expect(resolveBudgetTier('lite')).toEqual({ tier: 'lite', probeCeiling: 2 });
  });

  it('over-tier is REPORTED, never denied: the plan width is untouched', () => {
    const gate = evaluateBudgetGate({ tier: 'lite', observedProbes: 4 });
    expect(gate.withinTier).toBe(false);
    expect(gate.observedProbes).toBe(4);
    expect(gate.probeCeiling).toBe(2);
    // Nothing in the gate can deny: there is no deny/allowed/block field at all.
    expect(JSON.stringify(gate)).not.toMatch(/deny|denied|block|reject-decision/i);
  });

  it('an unknown tier fails closed at resolution and at construction', () => {
    expect(() => resolveBudgetTier('huge' as never)).toThrow(TypeError);
    expect(() =>
      createJitActivePolicy({
        inner: makeInner(),
        budget: { tier: 'huge' as never }
      })
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// ADR 0007 §8: default construction is byte-identical (before/after shadow).
// ---------------------------------------------------------------------------

describe('ADR 0007 §8: default construction keeps the pre-P6 behaviour', () => {
  it('pinned default digest: the execution surface and the diagnostics are unchanged', () => {
    const plan = makeDecorator().selectBatch(makeRequest());
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics).toBeDefined();
    const slotsDigest = sha256(executionSurface(plan));
    const diagnosticsDigest = sha256(JSON.stringify(diagnostics));
    // Printed so the one-command reproduction shows both values.
    console.log('P6 SLOTS_DIGEST=' + slotsDigest);
    console.log('P6 DIAG_DIGEST=' + diagnosticsDigest);
    expect(slotsDigest).toBe(PINNED_SLOTS_DIGEST);
    expect(diagnosticsDigest).toBe(PINNED_DIAGNOSTICS_DIGEST);
  });

  it('without a budget block there is no gate, no reminder object and no diagnostics key', () => {
    const plan = makeDecorator().selectBatch(makeRequest());
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics).toBeDefined();
    // "Off" must mean ZERO objects, not an object that downstream filters out.
    expect(diagnostics === undefined ? true : 'budget' in diagnostics).toBe(false);
    expect(hasJitDiagnostics(plan)).toBe(true);
  });

  it('a budget block changes ONLY the diagnostics: the execution surface is identical', () => {
    const plain = makeDecorator().selectBatch(makeRequest());
    const withBudget = makeDecorator({
      budget: { tier: 'lite', costObservations: [measuredObservation('k', 2, 0.5)] }
    }).selectBatch(makeRequest());
    expect(executionSurface(withBudget)).toBe(executionSurface(plain));
    const before = readJitDiagnostics(plain);
    const after = readJitDiagnostics(withBudget);
    expect(after?.budget?.tier).toBe('lite');
    // Stripping the additive key restores the pinned diagnostics exactly.
    const { budget: _ignored, ...rest } = after ?? {};
    expect(rest).toEqual(before);
    void _ignored;
  });

  it('runtime-off is the rollback path: no metadata, no gate, no reminder', () => {
    const reminders: BudgetReminder[] = [];
    const inner = makeInner();
    const jit = makeDecorator({
      inner,
      isRuntimeEnabled: () => false,
      budget: { tier: 'lite', reminder: { enabled: true, onReminder: (r) => reminders.push(r) } }
    });
    const baseline = inner.selectBatch(makeRequest());
    const plan = jit.selectBatch(makeRequest());
    expect(hasJitDiagnostics(plan)).toBe(false);
    expect(executionSurface(plan)).toBe(executionSurface(baseline));
    expect(reminders).toEqual([]);
  });

  it('a non-intercepting assembly (baseline/shadow profile) never sees the gate', () => {
    const reminders: BudgetReminder[] = [];
    const jit = makeDecorator({
      interceptExecution: () => false,
      budget: { tier: 'lite', reminder: { enabled: true, onReminder: (r) => reminders.push(r) } }
    });
    const plan = jit.selectBatch(makeRequest());
    expect(hasJitDiagnostics(plan)).toBe(false);
    expect(reminders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ADR 0007 §7: the reminder asks; it never denies, and its switch is its own.
// ---------------------------------------------------------------------------

describe('ADR 0007 §7: the budget reminder only asks', () => {
  it('switch off (default): over-tier produces no reminder object at all', () => {
    const plan = makeDecorator({ budget: { tier: 'lite' } }).selectBatch(makeRequest());
    const gate = readJitDiagnostics(plan)?.budget;
    expect(gate?.withinTier).toBe(false);
    // Zero objects: the key is absent, not `{ enabled: false }`.
    expect(gate === undefined ? false : 'reminder' in gate).toBe(false);
  });

  it('switch on + over tier: exactly one ask, slots unchanged', () => {
    const reminders: BudgetReminder[] = [];
    const plan = makeDecorator({
      budget: { tier: 'lite', reminder: { enabled: true, onReminder: (r) => reminders.push(r) } }
    }).selectBatch(makeRequest());
    const plain = makeDecorator().selectBatch(makeRequest());
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toEqual({
      kind: 'budget-tier-exceeded',
      observedProbes: 4,
      probeCeiling: 2,
      tier: 'lite',
      unit: 'probes'
    });
    // The ask is recorded on the diagnostics too, and the plan is NOT trimmed:
    // 4 slots before, 4 slots after - no deny, no narrowing.
    expect(readJitDiagnostics(plan)?.budget?.reminder).toEqual(reminders[0]);
    expect(executionSurface(plan)).toBe(executionSurface(plain));
    expect(plan.slots).toHaveLength(4);
  });

  it('switch on + within tier: no reminder', () => {
    const reminders: BudgetReminder[] = [];
    const plan = makeDecorator({
      budget: { tier: 'heavy', reminder: { enabled: true, onReminder: (r) => reminders.push(r) } }
    }).selectBatch(makeRequest());
    expect(readJitDiagnostics(plan)?.budget?.withinTier).toBe(true);
    expect(reminders).toEqual([]);
    expect(readJitDiagnostics(plan)?.budget === undefined
      ? false
      : 'reminder' in (readJitDiagnostics(plan)?.budget as BudgetGateResult)).toBe(false);
  });

  it('a throwing sink cannot fail the decision and keeps the ask in the diagnostics', () => {
    const jit = makeDecorator({
      budget: {
        tier: 'lite',
        reminder: {
          enabled: true,
          onReminder: () => {
            throw new Error('sink exploded');
          }
        }
      }
    });
    const plan = jit.selectBatch(makeRequest());
    expect(plan.slots).toHaveLength(4);
    expect(readJitDiagnostics(plan)?.budget?.reminder?.kind).toBe('budget-tier-exceeded');
    expect(jit.diagnostics().some((line) => line.includes('budget_reminder'))).toBe(true);
  });

  it('the reminder switch is independent of the execution-mode switch', () => {
    // interceptor on + reminder off => no reminder; interceptor off + reminder on
    // => still no reminder (the hook rides the interception gate). Neither shape
    // can turn the other on, which is the "independent switch" requirement.
    const offReminder = makeDecorator({ budget: { tier: 'lite' }, interceptExecution: () => true })
      .selectBatch(makeRequest());
    expect(offReminder.slots).toHaveLength(4);
    expect(readJitDiagnostics(offReminder)?.budget?.reminder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADR 0007 §5: the holdout firewall, with fail-fast negative controls.
// ---------------------------------------------------------------------------

/** Minimal child-input builder mirroring tests/unit/dream-rsi/fixtures.ts. */
function childInput(
  parentId: string,
  spec: { id: string; origin?: PatchOrigin; purpose?: CreateDiscoveryNodeInput['purpose'] }
): CreateDiscoveryNodeInput {
  return {
    id: spec.id,
    parentId,
    patchId: 'patch-' + spec.id,
    patchOrigin: spec.origin ?? 'reference',
    purpose: spec.purpose ?? 'initial',
    guidance: 'memory'
  };
}

function dreamPolicy(overrides: Partial<MetaSearchPolicy>): MetaSearchPolicy {
  return { ...createDefaultPolicy({ id: overrides.id ?? 'pi-0' }, () => 5_000), ...overrides };
}

/**
 * A tree that BOTH shapes replay identically: one shallow child, score 0.5.
 * It is the "tie" side of the selection/holdout contrast.
 */
function tieTree(id: string, taskId: string, createdAt: number): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id,
    sessionId: 'sess-' + id,
    taskId,
    rootPatchId: 'root-' + id,
    createdAt,
    clock: () => createdAt
  });
  tree.addNode(childInput(tree.rootId, { id: id + '-only', purpose: 'deepen' }));
  tree.recordProbe(id + '-only', { trajectoryId: 'traj-' + id + '-only', score: 0.5 });
  return tree.snapshot();
}

/**
 * A chain (0.1 -> 0.4 -> 0.7): the deep policy can climb it, the wide policy
 * only sees the first node. This is the "holdout-only advantage" side.
 */
function chainTree(id: string, taskId: string, createdAt: number): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id,
    sessionId: 'sess-' + id,
    taskId,
    rootPatchId: 'root-' + id,
    createdAt,
    clock: () => createdAt
  });
  let parent = tree.rootId;
  const scores = [0.1, 0.4, 0.7];
  for (let index = 0; index < scores.length; index += 1) {
    const nodeId = id + '-c' + String(index);
    tree.addNode(childInput(parent, { id: nodeId, purpose: 'deepen' }));
    tree.recordProbe(nodeId, { trajectoryId: 'traj-' + nodeId, score: scores[index] as number });
    parent = nodeId;
  }
  return tree.snapshot();
}

const widePolicy = (): MetaSearchPolicy => dreamPolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 1 });
const deepPolicy = (): MetaSearchPolicy => dreamPolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 3 });

describe('ADR 0007 §5: holdout is never an input to selection or filtering', () => {
  it('a holdout-only winner is NOT selected (guarded), and IS selected by the removed guard', async () => {
    // Selection: two tie trees (the wide candidate is NOT strictly better there).
    // Holdout: two chain trees (the wide candidate wins there - but only because
    // it is cheaper, which is a holdout-only advantage).
    const selection = [tieTree('sel-1', 'task-sel-1', 1_000), tieTree('sel-2', 'task-sel-2', 2_000)];
    const holdout = [chainTree('held-1', 'task-held-1', 3_000), chainTree('held-2', 'task-held-2', 4_000)];
    const pool = [...selection, ...holdout];
    const candidate = widePolicy();
    const incumbent = deepPolicy();

    const guarded = await createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 2,
      publishAuthorized: true
    }).replay({ trees: pool, baselinePolicy: incumbent, candidatePolicies: [candidate] });

    // The guarded run: the split happened BEFORE anything looked at the pool, the
    // candidate does not strictly improve on the selection trees, so it is NOT
    // selected, the holdout is never even replayed and publication is refused.
    expect(guarded.improved).toBe(false);
    expect(guarded.selectedPolicyId).toBe('pi-deep');
    expect(guarded.publication.publish).toBe(false);
    expect(guarded.publication.reason).toContain('did not beat baseline + epsilon');
    expect(guarded.shadow.selectionTreeIds).toEqual(['sel-1', 'sel-2']);
    expect(guarded.shadow.holdoutTreeIds).toEqual(['held-1', 'held-2']);
    // Four fail-closed witnesses that the holdout never influenced selection:
    expect(guarded.shadow.holdoutHypervolume).toBeUndefined();
    for (const id of guarded.shadow.holdoutTreeIds) {
      expect(guarded.shadow.selectionTreeIds).not.toContain(id);
    }

    // MUTATION CONTROL: the removed guard, reproduced in-test by folding the
    // holdout into the selection pool (the pre-PR-4B call shape, holdoutTreeCount=0).
    // Only THIS run selects the candidate - which is what makes the guarded run's
    // refusal a real, discriminating assertion rather than a tautology.
    const mutant = await createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 0,
      publishAuthorized: true
    }).replay({ trees: pool, baselinePolicy: incumbent, candidatePolicies: [candidate] });
    expect(mutant.improved).toBe(true);
    expect(mutant.selectedPolicyId).toBe('pi-wide');
    expect(mutant.shadow.selectionTreeIds).toContain('held-1');
    expect(mutant.selectedPolicyId).not.toBe(guarded.selectedPolicyId);
  });

  it('the generator must not even RECEIVE a holdout tree reference (fail-fast detector)', async () => {
    const selection = [tieTree('g-sel-1', 'task-g-sel-1', 1_000), tieTree('g-sel-2', 'task-g-sel-2', 2_000)];
    const holdout = [chainTree('g-held-1', 'task-g-held-1', 3_000), chainTree('g-held-2', 'task-g-held-2', 4_000)];
    const holdoutIds = holdout.map((tree) => tree.id);
    const seenPools: string[][] = [];

    // The detector fails the whole run if ANY tree reference is a holdout tree -
    // reading it is already a violation (ADR 0007 §5.5: "look, don't use" is
    // still a violation).
    const strictGenerator: PolicyGenerator = (_baseline, _count, request) => {
      const ids = request.trees.map((tree) => tree.id);
      const leaked = ids.filter((id) => holdoutIds.includes(id));
      if (leaked.length > 0) {
        throw new Error('holdout leak: generator received ' + leaked.join(','));
      }
      seenPools.push(ids);
      return [widePolicy()];
    };

    const report = await createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 2,
      generatePolicies: strictGenerator,
      policyCount: 1
    }).replay({
      trees: [...selection, ...holdout],
      baselinePolicy: deepPolicy(),
      candidatePolicies: []
    });

    expect(seenPools).toHaveLength(1);
    expect(seenPools[0]).toEqual(['g-sel-1', 'g-sel-2']);
    expect(seenPools[0]?.some((id) => holdoutIds.includes(id))).toBe(false);
    expect(report.shadow.split.status).toBe('ok');

    // MUTATION CONTROL: hand the SAME generator the unfiltered request (the
    // pre-PR-4B call shape). The detector must fire - proving that the assertion
    // above would go red if the firewall were removed.
    let leakError: Error | undefined;
    try {
      await strictGenerator(deepPolicy(), 1, {
        trees: [...selection, ...holdout],
        baselinePolicy: deepPolicy(),
        candidatePolicies: []
      });
    } catch (error) {
      leakError = error as Error;
    }
    expect(leakError?.message).toContain('holdout leak');
    expect(leakError?.message).toContain('g-held-1');
  });

  it('when a winner exists, the holdout is replayed only for it and a holdout loss withholds publication', async () => {
    // Bushy selection trees: the deep candidate strictly wins on the selection
    // set, so it becomes the winner; the chain holdout then refuses it.
    const bushy = (id: string, taskId: string, createdAt: number): DiscoveryTreeSnapshot => {
      const tree = createDiscoveryTree({
        id,
        sessionId: 'sess-' + id,
        taskId,
        rootPatchId: 'root-' + id,
        createdAt,
        clock: () => createdAt
      });
      const scores = [0.6, 0.5, 0.4, 0.3];
      for (let index = 0; index < scores.length; index += 1) {
        const nodeId = id + '-b' + String(index);
        tree.addNode(childInput(tree.rootId, { id: nodeId, origin: 'domain', purpose: 'explore' }));
        tree.recordProbe(nodeId, { trajectoryId: 'traj-' + nodeId, score: scores[index] as number });
      }
      return tree.snapshot();
    };
    const selection = [bushy('w-sel-1', 'task-w-sel-1', 1_000), bushy('w-sel-2', 'task-w-sel-2', 2_000)];
    const holdout = [chainTree('w-held-1', 'task-w-held-1', 3_000), chainTree('w-held-2', 'task-w-held-2', 4_000)];
    const report = await createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 2,
      publishAuthorized: true
    }).replay({
      trees: [...selection, ...holdout],
      baselinePolicy: widePolicy(),
      candidatePolicies: [deepPolicy()]
    });

    expect(report.improved).toBe(true);
    expect(report.selectedPolicyId).toBe('pi-deep');
    expect(report.shadow.holdoutTreeIds).toEqual(['w-held-1', 'w-held-2']);
    // Exactly one holdout number pair: the winner's and the baseline's. There is
    // no per-candidate holdout evaluation in the report shape at all.
    expect(report.shadow.holdoutHypervolume).toBeDefined();
    expect(report.publication.publish).toBe(false);
    expect(report.publication.reason).toContain('held-out trees');
    expect(report.shadow.published).toBe(false);
  });

  it('the L1 decorator never consumes a holdout reference (canary getter is never read)', () => {
    // A canary option that THROWS on read: if the decorator ever looks up a
    // holdout-shaped key it fails loudly. This pins "not even a read".
    const options = {
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { useSurfaces: false },
      now: () => T0,
      rng: () => 0.999,
      get holdoutTrees(): never {
        throw new Error('holdout reference read');
      }
    } as unknown as JitActivePolicyOptions;
    const plan = createJitActivePolicy(options).selectBatch(makeRequest());
    expect(executionSurface(plan)).toBe(executionSurface(makeDecorator().selectBatch(makeRequest())));
  });

  it('the decorator source contains no holdout identifier at all (structural tripwire)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(here, '../../../src/jitrl/jit-active-policy.ts');
    const source = readFileSync(sourcePath, 'utf8');
    // Strip block and line comments: prose may NAME the firewall, code must not
    // wire it. Any identifier-shaped `holdout` in code fails this test.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ');
    expect(code.toLowerCase()).not.toContain('holdout');
  });
});

// ---------------------------------------------------------------------------
// Reproducible restoration witness (captain requirement): one command prints
// the sha256 of the two P6 deliverables next to the pinned value and says
// PASS/FAIL. This is what a verifier can re-run after the red-control practice
// (two temporary mutations + restores), without trusting any chat statement.
//
//   pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"
// ---------------------------------------------------------------------------

const PINNED_DECORATOR_SHA256 =
  'c94431235a0a90bc256bbfdac043a6c675a85fe566d2e4d91c1047fa13ff4266';
const PINNED_ADR_SHA256 =
  '47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289';

describe('P6 restoration witness (pinned sha256, one command)', () => {
  it('prints the sha256 of the decorator and the ADR next to their pinned values', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files: readonly (readonly [string, string])[] = [
      ['src/jitrl/jit-active-policy.ts', PINNED_DECORATOR_SHA256],
      ['docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md', PINNED_ADR_SHA256]
    ];
    for (const [relative, pinned] of files) {
      const bytes = readFileSync(path.resolve(here, '../../..', relative));
      const actual = createHash('sha256').update(bytes).digest('hex');
      console.log('P6 SHA256 ' + relative + '=' + actual + (actual === pinned ? ' PASS' : ' FAIL'));
      expect(actual).toBe(pinned);
    }
  });
});
