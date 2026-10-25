/**
 * P2 L1 cold-start backfill (plan sections 3.1, 6.5 and 8 Phase 2).
 *
 * Mandatory acceptance (e): a fixture tree converts into the expected record
 * count with the correct discounted returns, and a second pass is idempotent.
 * Mandatory acceptance (g): a malformed tree and a failing store degrade into
 * diagnostics without throwing.
 */
import { describe, expect, it } from 'vitest';
import type {
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceRecord
} from '../../../src/types/contracts';
import {
  BACKFILL_PROVENANCE_VERSION,
  BACKFILL_RECORD_PREFIX,
  BACKFILL_REWARD_VERSION,
  backfillFromTreePool,
  backfillRecordId,
  mapScoreToReward,
  migrateExperienceRecords,
  partitionExperienceRecords,
  type ExperienceAppendSink
} from '../../../src/jitrl/backfill';
import { EXPERIENCE_SCHEMA_VERSION } from '../../../src/jitrl/experience-store';
import { createDiscoveryTreePool } from '../../../src/dream-rsi';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';

const T0 = 1_700_000_000_000;

function node(overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>): DiscoveryNode {
  return {
    treeId: 'tree-a',
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

/**
 * Fixture tree (root + three children + one grandchild):
 *
 *        root (score null: the reference anchor is unscored)
 *        /    |     \
 *   exploit domain invariant
 *                    |
 *                 deepen
 */
function fixtureTree(): DiscoveryTreeSnapshot {
  const nodes: Record<string, DiscoveryNode> = {
    root: node({
      id: 'root',
      depth: 0,
      guidance: 'guidance_free',
      status: 'succeeded'
    }),
    exploit: node({
      id: 'exploit',
      parentId: 'root',
      depth: 1,
      slot: 'exploit',
      score: 1,
      metadata: { surfaceKeys: ['guardrails'] }
    }),
    domain: node({
      id: 'domain',
      parentId: 'root',
      depth: 1,
      slot: 'explore_domain',
      score: 0.5,
      metadata: { surfaceKeys: ['tool_guidance', 'guardrails'] }
    }),
    invariant: node({
      id: 'invariant',
      parentId: 'root',
      depth: 1,
      slot: 'explore_invariant',
      patchOrigin: 'invariant',
      guidance: 'guidance_free',
      score: 0.2
    }),
    deepen: node({
      id: 'deepen',
      parentId: 'invariant',
      depth: 2,
      slot: 'exploit',
      purpose: 'deepen',
      score: 0.8
    })
  };
  nodes.root = { ...(nodes.root as DiscoveryNode), childIds: ['exploit', 'domain', 'invariant'] };
  nodes.invariant = { ...(nodes.invariant as DiscoveryNode), patchOrigin: 'invariant', childIds: ['deepen'] };
  return {
    id: 'tree-a',
    sessionId: 'session-a',
    taskId: 'task-a',
    rootId: 'root',
    nodes,
    policyId: 'pi-0',
    stats: {
      nodeCount: 5,
      maxDepth: 2,
      maxWidth: 3,
      scoredNodes: 4,
      completedNodes: 5
    },
    completed: true,
    createdAt: T0,
    updatedAt: T0 + 100,
    metadata: { taskSignature: 'fix-build', complexity: 'moderate', memoryConfidence: 0.8 }
  };
}

function byNodeId(records: readonly ExperienceRecord[], nodeId: string): ExperienceRecord {
  const found = records.find((record) => record.nodeId === nodeId);
  expect(found, 'no record for node ' + nodeId).toBeDefined();
  return found as ExperienceRecord;
}

/** Collect appends without any store behaviour, for pure assertions. */
function recordingSink(): ExperienceAppendSink & { readonly batches: (readonly ExperienceRecord[])[]; readonly records: () => readonly ExperienceRecord[] } {
  const batches: (readonly ExperienceRecord[])[] = [];
  return {
    batches,
    records() {
      return batches.flat();
    },
    async append(records) {
      batches.push([...records]);
    }
  };
}

describe('mapScoreToReward', () => {
  it('maps the surrogate range linearly onto the clip', () => {
    const clip = [-3, 3] as const;
    expect(mapScoreToReward(0, clip)).toBe(-3);
    expect(mapScoreToReward(0.5, clip)).toBe(0);
    expect(mapScoreToReward(1, clip)).toBe(3);
  });

  it('clamps out-of-range and non-finite scores instead of extrapolating', () => {
    const clip = [-3, 3] as const;
    expect(mapScoreToReward(-5, clip)).toBe(-3);
    expect(mapScoreToReward(5, clip)).toBe(3);
    expect(mapScoreToReward(Number.NaN, clip)).toBe(-3);
  });
});

describe('backfillFromTreePool', () => {
  it('converts every scored node of the fixture tree into one L1 record', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: sink, gamma: 0.5 });

    // 4 scored nodes; the unscored root anchor is skipped, not fabricated.
    expect(result.recordCount).toBe(4);
    expect(result.appended).toBe(4);
    expect(result.treeCount).toBe(1);
    expect(result.unscored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(sink.records()).toHaveLength(4);

    for (const record of result.records) {
      expect(record.level).toBe('meta');
      expect(record.id.startsWith(BACKFILL_RECORD_PREFIX + ':tree-a:')).toBe(true);
      expect(record.policyId).toBe('pi-0');
      expect(record.sessionId).toBe('session-a');
      expect(record.treeId).toBe('tree-a');
      expect(record.redacted).toBe(true);
      expect(record.state.level).toBe('meta');
      expect(record.state.bucket.startsWith('meta|fix-build|moderate')).toBe(true);
    }
  });

  it('computes G(v) = r(v) + gamma * max_child G(child) along the tree', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: sink, gamma: 0.5 });
    const records = result.records;

    // r = -3 + 6 * score, G(deepen) = r(deepen) because it is a leaf.
    const deepen = byNodeId(records, 'deepen');
    expect(deepen.reward).toBeCloseTo(-3 + 6 * 0.8, 10);
    expect(deepen.return).toBeCloseTo(deepen.reward, 10);

    // G(invariant) = r(invariant) + 0.5 * G(deepen): the subtree maximum.
    const invariant = byNodeId(records, 'invariant');
    expect(invariant.return).toBeCloseTo(invariant.reward + 0.5 * deepen.return, 10);

    // Leaves take only their own reward.
    const exploit = byNodeId(records, 'exploit');
    expect(exploit.return).toBeCloseTo(exploit.reward, 10);
    const domain = byNodeId(records, 'domain');
    expect(domain.return).toBeCloseTo(domain.reward, 10);
  });

  it('honours the discount: gamma = 0 removes the subtree contribution', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: sink, gamma: 0 });
    const invariant = byNodeId(result.records, 'invariant');
    expect(invariant.return).toBeCloseTo(invariant.reward, 10);
  });

  it('derives action keys from the node slot and focus surfaces', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: sink });
    expect(byNodeId(result.records, 'invariant').actionKey).toBe('slot:explore_invariant');
    expect(byNodeId(result.records, 'exploit').actionKey).toBe('slot:exploit/surf:guardrails');
    expect(byNodeId(result.records, 'domain').actionKey).toBe(
      'slot:explore_domain/surf:guardrails+tool_guidance'
    );
  });

  it('carries the invariant isolation through to the stored guidance', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: sink });
    expect(byNodeId(result.records, 'invariant').guidance).toBe('guidance_free');
    expect(byNodeId(result.records, 'deepen').guidance).toBe('memory');
  });

  it('is idempotent: a second pass over the same pool cannot duplicate records', async () => {
    const store = createMemoryExperienceStore({ now: () => T0 });
    const first = await backfillFromTreePool({ pool: [fixtureTree()], store });
    expect(await store.size()).toBe(4);

    const second = await backfillFromTreePool({ pool: [fixtureTree()], store });
    expect(second.recordCount).toBe(first.recordCount);
    expect(second.records.map((record) => record.id)).toEqual(
      first.records.map((record) => record.id)
    );
    // Deterministic ids mean the store still holds exactly one record per node.
    expect(await store.size()).toBe(4);
    const snapshot = store.snapshot();
    const ids = new Set(snapshot.map((record) => record.id));
    expect(ids.size).toBe(snapshot.length);
  });

  it('accepts a real DiscoveryTreePool handle as well as a snapshot array', async () => {
    const pool = createDiscoveryTreePool({ maxTrees: 10 });
    pool.add(fixtureTree());
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool, store: sink });
    expect(result.treeCount).toBe(1);
    expect(result.recordCount).toBe(4);
  });

  it('applies the configured reward clip and surrogate weight', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({
      pool: [fixtureTree()],
      store: sink,
      clip: [-1, 1],
      weights: { surrogate: 1 }
    });
    const exploit = byNodeId(result.records, 'exploit');
    expect(exploit.reward).toBeCloseTo(1, 10);
    const domain = byNodeId(result.records, 'domain');
    expect(domain.reward).toBeCloseTo(0, 10);
  });

  it('skips unscored nodes instead of inventing a reward for them', async () => {
    const tree = fixtureTree();
    const withoutScore: DiscoveryTreeSnapshot = {
      ...tree,
      nodes: {
        ...tree.nodes,
        domain: { ...(tree.nodes.domain as DiscoveryNode), score: undefined }
      }
    };
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [withoutScore], store: sink });
    expect(result.recordCount).toBe(3);
    expect(result.unscored).toBe(2);
    expect(result.records.some((record) => record.nodeId === 'domain')).toBe(false);
  });

  it('records diagnostics for a malformed tree and keeps the healthy ones', async () => {
    const broken = {
      id: 'tree-broken',
      sessionId: 'session-a',
      taskId: 'task-bad',
      rootId: 'does-not-exist',
      nodes: {},
      stats: { nodeCount: 0, maxDepth: 0, maxWidth: 0, scoredNodes: 0, completedNodes: 0 },
      completed: false,
      createdAt: T0,
      updatedAt: T0
    } as unknown as DiscoveryTreeSnapshot;
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [broken, fixtureTree()], store: sink });
    expect(result.recordCount).toBe(4);
    expect(result.diagnostics.join(' ')).toContain('no resolvable root node');
  });

  it('reports a dangling child reference without throwing', async () => {
    const tree = fixtureTree();
    const withDangling: DiscoveryTreeSnapshot = {
      ...tree,
      nodes: {
        ...tree.nodes,
        exploit: { ...(tree.nodes.exploit as DiscoveryNode), childIds: ['ghost'] }
      }
    };
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [withDangling], store: sink });
    expect(result.recordCount).toBe(4);
    expect(result.diagnostics.join(' ')).toContain('missing child ghost');
  });

  it('degrades to a diagnostic when the store rejects the batch', async () => {
    const failing: ExperienceAppendSink = {
      async append() {
        throw new Error('disk is on fire');
      }
    };
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: failing });
    expect(result.recordCount).toBe(4);
    expect(result.appended).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('rejected the cold-start batch');
  });

  it('is a no-op on an empty pool', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [], store: sink });
    expect(result.recordCount).toBe(0);
    expect(result.treeCount).toBe(0);
    expect(sink.batches).toHaveLength(0);
  });

  it('produces deterministic, collision-free ids', () => {
    expect(backfillRecordId('tree-a', 'node-1')).toBe('jit-l1:tree-a:node-1');
    expect(backfillRecordId('tree-b', 'node-1')).not.toBe(backfillRecordId('tree-a', 'node-1'));
  });
});

describe('G2-5: the walk is linear, not quadratic', () => {
  /**
   * A pathological diamond: one shared unscored hub is referenced by many
   * parents. The old walk memoised only SCORED nodes, so the hub's whole subtree
   * was re-expanded once per parent - O(parents x subtree) instead of O(nodes).
   *
   * The reward function below counts how often it is EVALUATED per node, which is
   * exactly the observable a quadratic walk inflates: with per-node memoisation
   * every node is evaluated at most once.
   */
  function diamondTree(branches: number, subtreeDepth: number): DiscoveryTreeSnapshot {
    const nodes: Record<string, DiscoveryNode> = {};
    let tick = T0;
    const next = (): number => {
      tick += 1;
      return tick;
    };
    nodes.root = node({ id: 'root', depth: 0, childIds: [], createdAt: next(), updatedAt: next() });

    const parentIds: string[] = [];
    for (let index = 0; index < branches; index += 1) {
      const id = 'branch-' + String(index);
      nodes[id] = node({
        id,
        parentId: 'root',
        depth: 1,
        slot: 'exploit',
        score: 0.5,
        childIds: [],
        createdAt: next(),
        updatedAt: next()
      });
      parentIds.push(id);
    }
    nodes.root = { ...(nodes.root as DiscoveryNode), childIds: parentIds };

    // One shared, UNSCORED hub that every branch points at.
    nodes.hub = node({
      id: 'hub',
      parentId: 'branch-0',
      depth: 2,
      slot: 'explore_domain',
      childIds: [],
      createdAt: next(),
      updatedAt: next()
    });
    for (const id of parentIds) {
      nodes[id] = { ...(nodes[id] as DiscoveryNode), childIds: ['hub'] };
    }

    // A linear scored chain below the hub.
    let current = 'hub';
    for (let depth = 0; depth < subtreeDepth; depth += 1) {
      const id = 'deep-' + String(depth);
      nodes[id] = node({
        id,
        parentId: current,
        depth: 3 + depth,
        slot: 'explore_domain',
        score: 0.4,
        childIds: [],
        createdAt: next(),
        updatedAt: next()
      });
      nodes[current] = { ...(nodes[current] as DiscoveryNode), childIds: [id] };
      current = id;
    }

    return {
      id: 'tree-diamond',
      sessionId: 'session-g25',
      taskId: 'task-g25',
      rootId: 'root',
      nodes,
      policyId: 'pi-0',
      stats: {
        nodeCount: Object.keys(nodes).length,
        maxDepth: 2 + subtreeDepth,
        maxWidth: branches,
        scoredNodes: branches, // branch nodes only (hub and chain stay unscored? see below)
        completedNodes: Object.keys(nodes).length
      },
      completed: true,
      createdAt: T0,
      updatedAt: T0
    };
  }

  /**
   * Wrap a nodes map in a Proxy that counts reads of one specific child id. The
   * walk resolves every child through `nodes[childId]`, so the counter measures
   * how often that node was expanded: a per-node memo visits each child once,
   * while the old scored-only memo re-read the shared subtree once per parent.
   */
  function countingTree(
    tree: DiscoveryTreeSnapshot,
    watched: string
  ): { readonly tree: DiscoveryTreeSnapshot; reads(): number } {
    let count = 0;
    const proxy = new Proxy(tree.nodes as Record<string, DiscoveryNode>, {
      get(target, property, receiver) {
        if (property === watched) {
          count += 1;
        }
        return Reflect.get(target, property, receiver);
      }
    });
    return { tree: { ...tree, nodes: proxy }, reads: () => count };
  }

  it('expands a shared subtree once, not once per parent', async () => {
    const branches = 24;
    const subtreeDepth = 12;
    // The first node BELOW the shared hub. Every branch reaches it through the
    // hub, so a walk that does not memoise the (unscored) hub re-resolves it
    // once per branch.
    const watched = 'deep-0';
    const counted = countingTree(diamondTree(branches, subtreeDepth), watched);
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [counted.tree], store: sink, gamma: 0.5 });

    const scoredNodes = Object.values(result.records).length;
    expect(result.skipped).toBe(0);
    expect(result.recordCount).toBe(scoredNodes);

    // THE COMPLEXITY ASSERTION. A quadratic walk resolves this node once per
    // branch, i.e. >= branches reads; the memoised walk resolves it a small
    // constant number of times (the walk itself plus the internal parent and
    // Object.values passes). Bounding well below the branch count therefore
    // separates linear from quadratic without pinning an incidental constant.
    expect(counted.reads()).toBeLessThan(branches / 2);
  });

  it('keeps the whole walk linear in the node count on a wide diamond', async () => {
    // 40 branches x 20-deep shared subtree: quadratic would be 800 expansions of
    // the shared chain, linear is 20. The bound below is far from both extremes
    // but strictly impossible for the old implementation.
    const branches = 40;
    const subtreeDepth = 20;
    const watched = 'deep-0';
    const counted = countingTree(diamondTree(branches, subtreeDepth), watched);
    const result = await backfillFromTreePool({
      pool: [counted.tree],
      store: recordingSink(),
      gamma: 0.5
    });
    expect(result.recordCount).toBeGreaterThan(0);
    expect(counted.reads()).toBeLessThan(branches / 2);
  });

  it('returns byte-identical results before and after the memoisation change', async () => {
    // The fix must not move a single number: recompute the fixture tree twice
    // and compare every field, including the discounted returns.
    const sinkA = recordingSink();
    const sinkB = recordingSink();
    const first = await backfillFromTreePool({ pool: [fixtureTree()], store: sinkA, gamma: 0.5 });
    const second = await backfillFromTreePool({ pool: [fixtureTree()], store: sinkB, gamma: 0.5 });
    expect(second.records).toEqual(first.records);
  });

  it('keeps a shared unscored hub out of the record set', async () => {
    const tree = diamondTree(4, 3);
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [tree], store: sink });
    // Neither the root anchor nor the shared hub carries a score, so both are
    // counted as unscored and neither is ever stored.
    expect(result.unscored).toBe(2);
    expect(result.records.some((entry) => entry.nodeId === 'hub')).toBe(false);
    expect(result.records.some((entry) => entry.nodeId === 'root')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P6 PR4 / plan section 6.5: versioned rebuild + reversible legacy migration
// ---------------------------------------------------------------------------

describe('P6 PR4: rebuild provenance and legacy isolation', () => {
  it('stamps rebuilt cold-start records with the current schema and the rebuild versions', async () => {
    const sink = recordingSink();
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store: sink });
    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      expect(record.experienceSchemaVersion).toBe(EXPERIENCE_SCHEMA_VERSION);
      expect(record.rewardVersion).toBe(BACKFILL_REWARD_VERSION);
      expect(record.provenanceVersion).toBe(BACKFILL_PROVENANCE_VERSION);
      // P6.2 PR-A / F2: a surrogate-only rebuild is SURROGATE PRIOR /
      // audit-only - the surrogate tree rebuild is not the online r3 target,
      // so the record never enters the learning neighbourhood.
      expect(record.learningEligible).toBe(false);
      // The tree can prove the node/parent pair, so it is recorded; the round
      // and trajectory are recorded only when the node carries them.
      expect(record.nodeId).toBeTypeOf('string');
      expect(record.parentNodeId).toBeTypeOf('string');
      expect(record.observedReturn).toBe(record.return);
      expect(record.attributionBaseline).toBeTypeOf('number');
      expect(record.learningTarget).toBeTypeOf('number');
      expect(record.outcome).toBeTypeOf('string');
    }
  });

  it('keeps surrogate-only rebuilds AUDIT-visible but OUT of the learning query', async () => {
    // P6.2 PR-A / F2: the surrogate rebuild survives excludeLegacy (schema is
    // current) and stays readable for audit, but the learningEligibleOnly
    // query must not accept it - the online r3 neighbourhood is reserved for
    // exact-contract records (online writer or certified rescore).
    const store = createMemoryExperienceStore({ now: () => T0 });
    const result = await backfillFromTreePool({ pool: [fixtureTree()], store });
    expect(result.records.length).toBeGreaterThan(0);
    const first = result.records[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const audit = await store.query({
      level: 'meta',
      state: first.state,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true
    });
    expect(audit.length).toBeGreaterThan(0);
    const learning = await store.query({
      level: 'meta',
      state: first.state,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true,
      learningEligibleOnly: true
    });
    expect(learning).toHaveLength(0);
  });

  it('counts new vs legacy samples and marks legacy copies without touching the source', async () => {
    const rebuilt = (
      await backfillFromTreePool({ pool: [fixtureTree()], store: recordingSink() })
    ).records;
    // A pre-PR4 line: no schema version, no association.
    const legacy: ExperienceRecord = {
      ...(rebuilt[0] as ExperienceRecord),
      id: 'legacy-online-1',
      experienceSchemaVersion: undefined,
      rewardVersion: undefined,
      provenanceVersion: undefined,
      trajectoryId: undefined,
      round: undefined,
      slotIndex: undefined
    };
    const source = [legacy, ...rebuilt];
    const before = JSON.stringify(source);

    const result = await migrateExperienceRecords({ records: source });
    // P6.2 PR-A: surrogate backfill lines are quarantined by the migration
    // (rewardVersion not certified against the current contract), so `current`
    // is 0 and every rebuilt line plus the legacy line are marked copies.
    expect(result.current).toBe(0);
    expect(result.legacy).toBe(source.length);
    expect(result.excludedFromLearning).toBe(source.length);
    expect(result.marked).toHaveLength(source.length);
    expect(result.marked[0]?.id).toBe('legacy-online-1');
    expect(result.marked[0]?.rewardVersion).toBe('legacy');
    expect(result.marked[0]?.learningEligible).toBe(false);
    // No in-place rewrite of the original snapshot.
    expect(JSON.stringify(source)).toBe(before);

    const partition = partitionExperienceRecords(source);
    // P6.2 PR-A: surrogate-only rebuilds are audit-only, so learning is empty.
    expect(partition.learning).toHaveLength(0);
    expect(partition.auditOnly).toHaveLength(source.length);
  });

  it('writes the marked copies only to the injected audit sink (rollback = drop it)', async () => {
    const legacy: ExperienceRecord = {
      id: 'legacy-only',
      level: 'meta',
      state: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
      actionKey: 'slot:exploit',
      reward: 2,
      return: 2,
      rewardSources: { surrogate: 2 },
      guidance: 'memory',
      policyId: 'p',
      sessionId: 's',
      createdAt: T0,
      redacted: true
    };
    const appended: ExperienceRecord[] = [];
    const applied = await migrateExperienceRecords({
      records: [legacy],
      apply: true,
      auditSink: { append: async (batch) => void appended.push(...batch) }
    });
    expect(applied.marked).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.id).toBe('legacy-only');
    // The source object itself was never mutated.
    expect(legacy.rewardVersion).toBeUndefined();
    expect(legacy.learningEligible).toBeUndefined();
  });

  it('reports a dry run without an audit sink instead of writing', async () => {
    const applied = await migrateExperienceRecords({
      records: [
        {
          id: 'legacy-x',
          level: 'meta',
          state: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
          actionKey: 'slot:exploit',
          reward: 1,
          return: 1,
          rewardSources: {},
          guidance: 'memory',
          policyId: 'p',
          sessionId: 's',
          createdAt: T0,
          redacted: true
        }
      ],
      apply: true
    });
    expect(applied.marked).toHaveLength(1);
    expect(applied.diagnostics.some((line) => line.includes('without an audit sink'))).toBe(true);
  });
});
