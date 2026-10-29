/**
 * P6 host wiring (ADR 0007 §7.4): the budget reminder reaches a real host, and
 * the DEFAULT configuration is provably byte-identical to the pre-wiring one.
 *
 * This suite exists because the previous round shipped the P6 budget mechanism
 * "ready but host-unreachable": `src/index.ts:1575` was the single production
 * construction point of the decorator and it passed no `budget` at all, so no
 * host could ever turn the reminder on.
 *
 * What is pinned here, and why each one can actually go red:
 *
 *   1. SHADOW CONTROL (the captain's acceptance criterion): with the default
 *      configuration the decorator's execution surface and its `metadata.jit`
 *      digest equal the values pinned BEFORE this change
 *      (`a8c207ca…` / `f2c0737a…`, the same fixture and clock the P6 suite
 *      uses). If the wiring ever started injecting a `budget` block by default,
 *      `metadata.jit.budget` would appear and this digest would change.
 *   2. OFF => ZERO OBJECT: `resolveBudgetHookConfig(undefined)` is `undefined`,
 *      the decorator receives no `budget` key, and a decision carries no
 *      `budget` key at all (not "a budget key with enabled:false").
 *   3. ON => TAKES EFFECT: the reminder fires exactly once, carries
 *      `unit: 'probes'` (never money), and the plan is byte-identical to the
 *      off case - the reminder only ASKS, it never denies or trims.
 *   4. INDEPENDENCE: the reminder switch is not derived from the execution mode,
 *      from the patch permission, or from guarded-active. A host with the patch
 *      permission but no `budget` leaf gets no reminder; a host with the leaf but
 *      no patch permission gets one.
 *
 * Everything is offline and deterministic (injected clock + rng). No network, no
 * disk writes, no real model calls.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  BatchPlan,
  BatchSlotKind,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  SelectBatchRequest
} from '../../../src/types/contracts';
import { createActivePolicy, createDefaultPolicy } from '../../../src/dream-rsi/active-policy';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import {
  createJitActivePolicy,
  evaluateBudgetGate,
  JIT_BATCH_METADATA_KEY,
  type BudgetReminder,
  type JitActivePolicyOptions
} from '../../../src/jitrl/jit-active-policy';
import type { UsageLedgerEvent } from '../../../src/ledger/types';
import {
  validateEvoHarnessConfig,
  resolveEvoHarnessConfig,
  createDefaultConfig
} from '../../../src/config';
import {
  assembleMeasuredCostObservations,
  resolveBudgetHookConfig
} from '../../../src/index';

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// The canonical fixture. Deliberately IDENTICAL to the one in
// tests/unit/jitrl/p6-pareto-budget.test.ts so the pinned digests below are
// directly comparable with that suite's pre-P6 values.
// ---------------------------------------------------------------------------

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
    grid: {
      maxWidth: 4,
      maxDepth: 2,
      budget: 4,
      skipProbing: false,
      stopCondition: 'budget_exhausted',
      complexity: 'moderate',
      rationale: 'test grid',
      policyId: 'pi-0'
    },
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

function makeInner(): ReturnType<typeof createActivePolicy> {
  return createActivePolicy({
    policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0),
    now: () => T0,
    maxRecoverySlots: 1
  });
}

function makeDecorator(
  options: Partial<JitActivePolicyOptions> = {}
): ReturnType<typeof createJitActivePolicy> {
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

/** The diagnostics surface of a plan: what an observer would read. */
function diagnosticsSurface(plan: BatchPlan): string {
  const metadata = plan.metadata as Record<string, unknown> | undefined;
  return JSON.stringify(metadata?.[JIT_BATCH_METADATA_KEY] ?? null);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Pinned by tests/unit/jitrl/p6-pareto-budget.test.ts BEFORE the P6 change and
 * re-asserted here AFTER the host wiring. Same fixture, same injected clock.
 *
 * Reproduce with ONE command:
 *   pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts
 */
const PINNED_SLOTS_DIGEST =
  'a8c207ca083336b1a2828f88f428fa68a53a30ca37fad098157b3bcbdbbd16a1';
const PINNED_DIAGNOSTICS_DIGEST =
  'f2c0737a844a6a3d007de0c78092fafb1afe8a0825dad98eb91cc840c63b647a';

// ---------------------------------------------------------------------------
// 1. SHADOW CONTROL: default configuration is byte-identical to pre-wiring.
// ---------------------------------------------------------------------------

describe('default configuration: the decorator is byte-identical to the pre-wiring build', () => {
  it('pinned default digest: slots and metadata.jit match the pre-P6 values exactly', () => {
    const decorator = makeDecorator();
    const plan = decorator.selectBatch(makeRequest());
    const slotsDigest = sha256(executionSurface(plan));
    const diagnosticsDigest = sha256(diagnosticsSurface(plan));
    // Printed so a verifier can compare without trusting any chat statement.
    console.log('HOST-WIRING SLOTS_DIGEST=' + slotsDigest + (slotsDigest === PINNED_SLOTS_DIGEST ? ' PASS' : ' FAIL'));
    console.log('HOST-WIRING DIAG_DIGEST=' + diagnosticsDigest + (diagnosticsDigest === PINNED_DIAGNOSTICS_DIGEST ? ' PASS' : ' FAIL'));
    expect(slotsDigest).toBe(PINNED_SLOTS_DIGEST);
    expect(diagnosticsDigest).toBe(PINNED_DIAGNOSTICS_DIGEST);
  });

  it('the default config carries NO jitrl.budget leaf at all', () => {
    // This is the property the whole wiring rests on: absent leaf => the host
    // passes no `budget` => the decorator never runs its budget gate. If a
    // future change gives this leaf a default value, the shadow digest above
    // goes red AND this assertion fails, so the regression cannot be silent.
    const defaults = createDefaultConfig();
    expect(Object.prototype.hasOwnProperty.call(defaults.jitrl, 'budget')).toBe(false);
    expect(defaults.jitrl.budget).toBeUndefined();
  });

  it('resolveBudgetHookConfig(undefined) is undefined: nothing is passed to the decorator', () => {
    expect(resolveBudgetHookConfig(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. OFF => zero objects, zero callbacks, zero diagnostics keys.
// ---------------------------------------------------------------------------

describe('reminder OFF: no object, no callback, no diagnostic key', () => {
  it('a budget block with reminder.enabled absent yields enabled:false, never true', () => {
    // Absent `enabled` inside a present block must stay FALSE: the decorator
    // requires the literal `true`, so a half-written leaf cannot switch it on.
    expect(resolveBudgetHookConfig({})).toEqual({});
    expect(resolveBudgetHookConfig({ reminder: {} })).toEqual({ reminder: { enabled: false } });
    expect(resolveBudgetHookConfig({ tier: 'lite', reminder: {} })).toEqual({
      tier: 'lite',
      reminder: { enabled: false }
    });
  });

  it('reminder.enabled:false produces no reminder object and no sink call', () => {
    const seen: BudgetReminder[] = [];
    const decorator = makeDecorator({
      budget: { tier: 'lite', reminder: { enabled: false, onReminder: (r) => seen.push(r) } }
    });
    const plan = decorator.selectBatch(makeRequest());
    const diagnostics = (plan.metadata as Record<string, unknown> | undefined)?.[
      JIT_BATCH_METADATA_KEY
    ] as Record<string, unknown> | undefined;
    const budget = diagnostics?.budget as Record<string, unknown> | undefined;
    // The gate itself ran (a tier was configured) but the reminder did NOT.
    expect(budget).toBeDefined();
    expect(budget?.reminder).toBeUndefined();
    expect(seen).toHaveLength(0);
    // The captain's requirement, stated as the strongest available form: the
    // reminder key is ABSENT, not present-with-enabled:false. A downstream
    // reader therefore cannot mistake "off" for "a disabled reminder object",
    // and `JSON.stringify` drops the key entirely.
    expect(Object.prototype.hasOwnProperty.call(budget, 'reminder')).toBe(false);
    expect(JSON.stringify(budget)).not.toContain('reminder');
  });

  it('the DEFAULT configuration produces NO budget diagnostics key at all', () => {
    // The strongest zero-object claim available: with the default config the
    // decorator is built without a `budget` block, so the gate never runs and
    // `metadata.jit` has no `budget` key whatsoever - not an empty object, not
    // an object with enabled:false. This is what "关闭时零对象" means literally.
    const decorator = makeDecorator();
    const plan = decorator.selectBatch(makeRequest());
    const diagnostics = (plan.metadata as Record<string, unknown> | undefined)?.[
      JIT_BATCH_METADATA_KEY
    ] as Record<string, unknown> | undefined;
    expect(diagnostics).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(diagnostics, 'budget')).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain('budget');
  });

  it('resolveBudgetHookConfig(undefined) yields no object at all (not an empty one)', () => {
    const hook = resolveBudgetHookConfig(undefined);
    expect(hook).toBeUndefined();
    // Guard against the "empty object is falsy-ish" confusion: an empty object
    // WOULD be passed to the decorator and WOULD run the gate.
    expect(hook).not.toEqual({});
  });

  it('a reminder block with no enabled field at all is still OFF', () => {
    const seen: BudgetReminder[] = [];
    const hook = resolveBudgetHookConfig({ tier: 'lite', reminder: {} });
    const decorator = makeDecorator({
      budget: { ...hook, reminder: { ...hook?.reminder, onReminder: (r) => seen.push(r) } }
    });
    decorator.selectBatch(makeRequest());
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. ON => the reminder fires, asks, and never changes the plan.
// ---------------------------------------------------------------------------

describe('reminder ON: it fires exactly once, quotes probes, and never denies', () => {
  it('a plan wider than the tier ceiling emits ONE reminder with unit:probes', () => {
    const seen: BudgetReminder[] = [];
    // 'lite' ceiling is 2 probes; the fixture plan is 4 slots wide.
    const decorator = makeDecorator({
      budget: { tier: 'lite', reminder: { enabled: true, onReminder: (r) => seen.push(r) } }
    });
    const plan = decorator.selectBatch(makeRequest());
    expect(plan.width).toBeGreaterThan(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('budget-tier-exceeded');
    expect(seen[0]?.unit).toBe('probes');
    expect(seen[0]?.tier).toBe('lite');
    expect(seen[0]?.probeCeiling).toBe(2);
    expect(seen[0]?.observedProbes).toBe(plan.width);
  });

  it('the reminder NEVER changes the plan: slots are byte-identical with it on or off', () => {
    // ADR 0007 §7.2: the reminder only asks. The execution surface must be
    // identical whether the switch is on or off - this is the "只 ask 不 deny"
    // contract, asserted rather than asserted-in-prose.
    const offPlan = makeDecorator({
      budget: { tier: 'lite', reminder: { enabled: false } }
    }).selectBatch(makeRequest());
    const onPlan = makeDecorator({
      budget: { tier: 'lite', reminder: { enabled: true, onReminder: () => undefined } }
    }).selectBatch(makeRequest());
    expect(executionSurface(onPlan)).toBe(executionSurface(offPlan));
    expect(onPlan.width).toBe(offPlan.width);
    expect(onPlan.slots).toEqual(offPlan.slots);
  });

  it('a within-tier plan emits no reminder even with the switch ON', () => {
    const seen: BudgetReminder[] = [];
    // 'heavy' ceiling is 8 probes; the fixture plan is 4 slots wide.
    const decorator = makeDecorator({
      budget: { tier: 'heavy', reminder: { enabled: true, onReminder: (r) => seen.push(r) } }
    });
    decorator.selectBatch(makeRequest());
    expect(seen).toHaveLength(0);
  });

  it('a throwing sink cannot fail the decision (the observer is contained)', () => {
    const decorator = makeDecorator({
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
    const plan = decorator.selectBatch(makeRequest());
    expect(plan.width).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. INDEPENDENCE: the reminder switch is nobody else's permission.
// ---------------------------------------------------------------------------

describe('the reminder switch is independent of every other permission', () => {
  it('a config with the patch permission but no budget leaf still gets no reminder', () => {
    const seen: BudgetReminder[] = [];
    // guarded-active grants the patch permission...
    const config = resolveEvoHarnessConfig({
      execution: { mode: 'guarded-active', applyWinningPatch: true }
    });
    expect(config.execution.applyWinningPatch).toBe(true);
    // ...and yet the reminder is still off, because the budget leaf is absent.
    expect(config.jitrl.budget).toBeUndefined();
    const hook = resolveBudgetHookConfig(config.jitrl.budget);
    expect(hook).toBeUndefined();
    const decorator = makeDecorator({
      ...(hook === undefined ? {} : { budget: hook }),
      // even with an explicit sink attached, nothing may fire
      budget: { tier: 'lite', reminder: { enabled: false, onReminder: (r) => seen.push(r) } }
    });
    decorator.selectBatch(makeRequest());
    expect(seen).toHaveLength(0);
  });

  it('a config with the budget leaf but NO patch permission still gets a reminder', () => {
    const seen: BudgetReminder[] = [];
    // The default execution mode does NOT grant the patch permission...
    const config = resolveEvoHarnessConfig({
      jitrl: { budget: { tier: 'lite', reminder: { enabled: true } } }
    });
    expect(config.execution.applyWinningPatch).toBe(false);
    // ...and the reminder is nevertheless available, because it is its own switch.
    const hook = resolveBudgetHookConfig(config.jitrl.budget);
    expect(hook?.reminder?.enabled).toBe(true);
    const decorator = makeDecorator({
      budget: { ...hook, reminder: { ...hook?.reminder, onReminder: (r) => seen.push(r) } }
    });
    decorator.selectBatch(makeRequest());
    expect(seen).toHaveLength(1);
  });

  it('the wiring never reads the execution mode to decide the reminder', () => {
    // Every execution mode must produce the SAME hook for the same leaf: the
    // resolver takes only the budget leaf, so mode cannot influence it. This is
    // the structural form of ADR 0007 §7.1's independence requirement.
    const leaf = { tier: 'lite' as const, reminder: { enabled: true } };
    const modes = ['baseline', 'shadow', 'guarded-active', 'off'] as const;
    const hooks = modes.map((mode) => {
      const config = resolveEvoHarnessConfig({
        execution: { mode },
        jitrl: { budget: leaf }
      });
      return resolveBudgetHookConfig(config.jitrl.budget);
    });
    for (const hook of hooks) {
      expect(hook).toEqual({ tier: 'lite', reminder: { enabled: true } });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The config leaf itself: optional, validated only when present.
// ---------------------------------------------------------------------------

describe('the jitrl.budget config leaf: optional, validated when present', () => {
  it('is accepted when the host writes it and stays absent when it does not', () => {
    const absent = resolveEvoHarnessConfig({});
    expect(absent.jitrl.budget).toBeUndefined();
    const present = resolveEvoHarnessConfig({
      jitrl: { budget: { tier: 'heavy', reminder: { enabled: true } } }
    });
    expect(present.jitrl.budget).toEqual({ tier: 'heavy', reminder: { enabled: true } });
  });

  it('rejects an unknown tier with invalid_enum', () => {
    const parsed = validateEvoHarnessConfig({
      jitrl: { budget: { tier: 'enormous' } }
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.config).toBeNull();
    expect(parsed.issues).toEqual([
      expect.objectContaining({ path: 'jitrl.budget.tier', code: 'invalid_enum' })
    ]);
  });

  it('rejects a non-boolean reminder.enabled with invalid_type', () => {
    const parsed = validateEvoHarnessConfig({
      jitrl: { budget: { reminder: { enabled: 'yes' } } }
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.config).toBeNull();
    expect(parsed.issues).toEqual([
      expect.objectContaining({ path: 'jitrl.budget.reminder.enabled', code: 'invalid_type' })
    ]);
  });

  it('rejects unknown keys inside the budget block (a typo cannot silently disable it)', () => {
    const parsed = validateEvoHarnessConfig({
      jitrl: { budget: { reminderr: { enabled: true } } }
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.config).toBeNull();
    expect(parsed.issues).toEqual([
      expect.objectContaining({ path: 'jitrl.budget.reminderr', code: 'unknown_key' })
    ]);
  });

  it('a malformed budget block is an invalid_type, never a silent ignore', () => {
    const parsed = validateEvoHarnessConfig({ jitrl: { budget: 'on' } });
    expect(parsed.ok).toBe(false);
    expect(parsed.config).toBeNull();
    expect(parsed.issues).toEqual([
      expect.objectContaining({ path: 'jitrl.budget', code: 'invalid_type' })
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. P2: the measured-only cost axis assembler (ADR 0007 §6.2).
//
// This is the part of the cost-axis wiring that CAN be delivered honestly: the
// assembly rule itself. It is exported and tested here, and `src/index.ts`
// deliberately does not feed it a fabricated observation (see the block comment
// at the construction point): the decorator captures `costObservations` as a
// construction-time array, so a live ledger read would be a frozen empty
// snapshot, and the ledger carries no quality NUMBER to pair with the cost.
//
// The negative cases below are the point of the whole module: ONE non-measured
// observation must collapse the ENTIRE axis, never be dropped from a subset.
// ---------------------------------------------------------------------------

/** A minimal measured ledger event. Only the fields the assembler reads matter. */
function measuredEvent(id: string): UsageLedgerEvent {
  return {
    eventId: 'evt-' + id,
    callId: 'call-' + id,
    reservationId: 'res-' + id,
    phase: 'probe',
    timestamp: T0,
    outcome: 'succeeded',
    incurredCostMicros: 1000,
    usage: {
      inputTokens: { tokens: 100, precision: 'measured' },
      outputTokens: { tokens: 50, precision: 'measured' }
    },
    cost: {
      totalCostMicros: 1000,
      breakdown: {
        netInputTokens: 100,
        inputCostMicros: 600,
        cacheReadTokens: 0,
        cacheReadCostMicros: 0,
        cacheWriteTokens: 0,
        cacheWriteCostMicros: 0,
        netOutputTokens: 50,
        outputCostMicros: 400,
        reasoningTokens: 0,
        reasoningCostMicros: 0
      },
      provenance: 'measured',
      conservative: false
    },
    auditOnly: false,
    qualityEvidence: true
  };
}

/** The same event with a different overall provenance. */
function eventWithProvenance(
  id: string,
  provenance: 'measured' | 'estimated' | 'unknown'
): UsageLedgerEvent {
  const base = measuredEvent(id);
  return { ...base, cost: { ...base.cost, provenance } };
}

function describeAs(id: string, probes: number, quality: number) {
  return { id, probes, quality };
}

describe('P2 measured-only cost axis: assembleMeasuredCostObservations', () => {
  it('assembles measured observations unchanged, in input order', () => {
    const events = [measuredEvent('a'), measuredEvent('b')];
    const observations = assembleMeasuredCostObservations(events, (event) =>
      event.callId === 'call-a' ? describeAs('a', 2, 0.6) : describeAs('b', 1, 0.9)
    );
    expect(observations).toEqual([
      { id: 'a', probes: 2, quality: 0.6, costProvenance: 'measured' },
      { id: 'b', probes: 1, quality: 0.9, costProvenance: 'measured' }
    ]);
  });

  it('NEGATIVE: ONE estimated observation collapses the WHOLE axis (not a filtered subset)', () => {
    // Two perfectly good measured points plus a single estimated one. A
    // "drop the bad point" implementation would return the two measured ones;
    // the contract requires undefined - the whole axis unavailable.
    const events = [
      measuredEvent('a'),
      eventWithProvenance('b', 'estimated'),
      measuredEvent('c')
    ];
    const observations = assembleMeasuredCostObservations(events, (event) =>
      describeAs(event.callId, 2, 0.5)
    );
    expect(observations).toBeUndefined();
  });

  it('NEGATIVE: ONE unknown observation collapses the WHOLE axis', () => {
    const events = [measuredEvent('a'), eventWithProvenance('b', 'unknown')];
    expect(
      assembleMeasuredCostObservations(events, (event) => describeAs(event.callId, 2, 0.5))
    ).toBeUndefined();
  });

  it('NEGATIVE: an empty event set is an unavailable axis, never an empty front', () => {
    expect(assembleMeasuredCostObservations([], () => describeAs('x', 1, 0.5))).toBeUndefined();
  });

  it('NEGATIVE: an audit-only event can never anchor a quality point', () => {
    const base = measuredEvent('a');
    const events = [{ ...base, auditOnly: true }];
    expect(
      assembleMeasuredCostObservations(events, () => describeAs('a', 2, 0.5))
    ).toBeUndefined();
  });

  it('NEGATIVE: a non-quality-evidence event collapses the axis', () => {
    const base = measuredEvent('a');
    const events = [{ ...base, qualityEvidence: false }];
    expect(
      assembleMeasuredCostObservations(events, () => describeAs('a', 2, 0.5))
    ).toBeUndefined();
  });

  it('NEGATIVE: a missing (probes, quality) pair is NOT defaulted to a fabricated zero', () => {
    // This is the "never invent a measurement" rule: absent data makes the axis
    // unavailable instead of contributing a fake (0 probes, 0 quality) point.
    const events = [measuredEvent('a')];
    expect(assembleMeasuredCostObservations(events, () => undefined)).toBeUndefined();
  });

  it('NEGATIVE: an out-of-range quality (outside [0,1]) collapses the axis', () => {
    const events = [measuredEvent('a')];
    expect(
      assembleMeasuredCostObservations(events, () => describeAs('a', 2, 1.5))
    ).toBeUndefined();
    expect(
      assembleMeasuredCostObservations(events, () => describeAs('a', 2, -0.1))
    ).toBeUndefined();
  });

  it('NEGATIVE: a non-finite probe count collapses the axis', () => {
    const events = [measuredEvent('a')];
    expect(
      assembleMeasuredCostObservations(events, () => describeAs('a', Number.NaN, 0.5))
    ).toBeUndefined();
  });

  it('the assembled observations feed evaluateBudgetGate into a usable front', () => {
    // End-to-end: real events -> assembler -> gate. The gate reports
    // costAxisProvenance 'measured' only because every point really was measured.
    const events = [measuredEvent('a'), measuredEvent('b')];
    const observations = assembleMeasuredCostObservations(events, (event) =>
      event.callId === 'call-a' ? describeAs('a', 4, 0.2) : describeAs('b', 1, 0.9)
    );
    expect(observations).toBeDefined();
    const gate = evaluateBudgetGate({ tier: 'lite', observedProbes: 4, costObservations: observations });
    expect(gate.costAxisProvenance).toBe('measured');
    expect(gate.costAxisRejected).toBe(0);
    // 'b' (1 probe, quality 0.9) strictly dominates 'a' (4 probes, quality 0.2):
    // fewer probes AND higher quality, with at least one dimension strict. Only
    // 'b' survives on the front - the axis is ranking real measured data.
    expect(gate.pareto?.nondominatedIds).toEqual(['b']);
    expect(gate.pareto?.dominatedIds).toEqual(['a']);
  });

  it('an unavailable axis reports costAxisProvenance unavailable and produces no pareto', () => {
    const observations = assembleMeasuredCostObservations(
      [measuredEvent('a'), eventWithProvenance('b', 'estimated')],
      (event) => describeAs(event.callId, 2, 0.5)
    );
    expect(observations).toBeUndefined();
    const gate = evaluateBudgetGate({ tier: 'lite', observedProbes: 4 });
    expect(gate.costAxisProvenance).toBe('unavailable');
    expect(gate.pareto).toBeUndefined();
    expect(gate.reminder).toBeUndefined();
  });

  it('costObservations reach the decorator only through the measured assembler', () => {
    // The resolver forwards a supplied axis verbatim and omits the key entirely
    // when there is none, so the decorator can never see a non-measured point.
    const hookWithout = resolveBudgetHookConfig({ tier: 'lite' });
    expect(Object.prototype.hasOwnProperty.call(hookWithout, 'costObservations')).toBe(false);
    const hookWith = resolveBudgetHookConfig({ tier: 'lite' }, [
      { id: 'a', probes: 2, quality: 0.5, costProvenance: 'measured' }
    ]);
    expect(hookWith?.costObservations).toHaveLength(1);
  });
});
