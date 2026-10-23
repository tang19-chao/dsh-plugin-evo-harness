/**
 * JitRL L1 cold-start backfill (plan sections 3.1, 6.5 and 8 Phase 2).
 *
 * Ownership: src/jitrl/** (Phase 2, P2 L1).
 *
 * On startup the persisted DiscoveryTreePool already holds every scored node of
 * every historical search tree. That is exactly the L1 experience the meta-level
 * optimizer needs, so this module converts the pool into ExperienceRecords
 * without running a single probe:
 *
 *   state      abstractMetaState() over the tree's task signature/complexity and
 *              the node's round, parent depth, parent slot and parent failure
 *   actionKey  normalizeMetaAction(node.slot ?? 'exploit', node.metadata.surfaceKeys)
 *   reward     the fused per-step reward of section 6.5. Only the surrogate
 *              source exists offline, so r(v) is node.score in [0, 1] mapped
 *              linearly onto the configured clip and weighted by the configured
 *              surrogate weight
 *   return     G(v) = r(v) + gamma * max_{c in children(v)} G(c), evaluated by one
 *              memoised post-order walk per tree
 *
 * Idempotency: the record id is a pure function of (tree id, node id), so a
 * second backfill produces the same ids and the store keeps a single copy of
 * each. Nothing here writes to disk: persistence belongs to the injected store.
 *
 * Robustness: a malformed tree (missing root, non-object nodes map, dangling
 * child reference, a cycle) is reported as a diagnostic and skipped. Backfill
 * never throws on pool content and never fabricates a score for an unscored
 * node - unscored nodes are counted and skipped.
 */

import {
  HARNESS_COMPONENT_KEYS,
  TASK_COMPLEXITIES,
  type ContractMetadata,
  type DiscoveryNode,
  type DiscoveryTreeSnapshot,
  type ExperienceRecord,
  type HarnessComponentKey,
  type IDiscoveryTreePool,
  type ProbeTask,
  type TaskComplexity
} from '../types/contracts';
import { normalizeMetaAction } from './action-normalizer';
import { abstractMetaState, type JitReferenceStatus } from './state-abstraction';

/** Prefix of every backfilled record id; keeps backfill ids recognisable. */
export const BACKFILL_RECORD_PREFIX = 'jit-l1';

/** Default discount applied along a tree path (config `jitrl.gamma`). */
export const DEFAULT_BACKFILL_GAMMA = 0.5;

/** Default reward clip (config `jitrl.reward.clip`). */
export const DEFAULT_BACKFILL_CLIP: readonly [number, number] = [-3, 3];

/** Anything that lists snapshots; IDiscoveryTreePool satisfies it directly. */
export type BackfillTreeSource =
  | Pick<IDiscoveryTreePool, 'list'>
  | readonly DiscoveryTreeSnapshot[];

/** The only store capability backfill needs. */
export interface ExperienceAppendSink {
  append(records: readonly ExperienceRecord[]): Promise<void>;
}

/** Options accepted by backfillFromTreePool. */
export interface BackfillOptions {
  /** Historical trees to convert; a pool handle or a plain snapshot array. */
  readonly pool: BackfillTreeSource;
  /** Experience sink (memory or JSONL store). */
  readonly store: ExperienceAppendSink;
  /** Injected clock used only for records that carry no usable timestamp. */
  readonly now?: () => number;
  /** Return discount along the tree path; defaults to 0.5, clamped to [0, 1]. */
  readonly gamma?: number;
  /**
   * Per-source reward weights (plan section 6.5). Only `surrogate` applies to
   * offline trees; a missing, non-finite or non-positive weight means 1 so the
   * full [-3, 3] range survives a partial weights object. A structural record is
   * accepted so config.reward.weights (a plain interface) fits directly.
   */
  readonly weights?: Readonly<Record<string, number>> | { readonly surrogate?: number };
  /** Reward clip, [min, max] with min < max; defaults to [-3, 3]. */
  readonly clip?: readonly [number, number];
}

/** Outcome of one backfill pass; every field is JSON-safe. */
export interface BackfillResult {
  /** Converted records, in deterministic (tree order, then root-first node) order. */
  readonly records: readonly ExperienceRecord[];
  /** Number of records attempted for append (records.length). */
  readonly recordCount: number;
  /** Number of records the store accepted (0 when the append failed). */
  readonly appended: number;
  /** Scored-node count that could not be converted (malformed node). */
  readonly skipped: number;
  /** Unscored nodes deliberately not converted. */
  readonly unscored: number;
  /** Trees inspected. */
  readonly treeCount: number;
  /** Human-readable, payload-free notices. */
  readonly diagnostics: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKnownComplexity(value: unknown): value is TaskComplexity {
  return (
    typeof value === 'string' &&
    (TASK_COMPLEXITIES as readonly string[]).includes(value)
  );
}

function isHarnessSurface(value: unknown): value is HarnessComponentKey {
  return (
    typeof value === 'string' &&
    (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value)
  );
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function metadataOf(source: ContractMetadata | undefined, key: string): unknown {
  return source === undefined ? undefined : source[key];
}

/** Focus surfaces are structural hints; unknown or duplicate keys are dropped. */
function surfaceKeysOf(node: DiscoveryNode): readonly HarnessComponentKey[] {
  const raw = metadataOf(node.metadata, 'surfaceKeys');
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: HarnessComponentKey[] = [];
  for (const entry of raw) {
    if (isHarnessSurface(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/** Reference status for a tree is the root node's outcome. */
function referenceStatusOf(root: DiscoveryNode | undefined): JitReferenceStatus {
  if (root === undefined) {
    return 'missing';
  }
  if (root.status === 'succeeded') {
    return 'succeeded';
  }
  if (root.status === 'failed') {
    return 'failed';
  }
  return 'missing';
}

/** Resolve the clip into an ordered, finite pair. */
function resolveClip(clip: readonly [number, number] | undefined): readonly [number, number] {
  if (
    clip === undefined ||
    !Number.isFinite(clip[0]) ||
    !Number.isFinite(clip[1]) ||
    clip[0] >= clip[1]
  ) {
    return DEFAULT_BACKFILL_CLIP;
  }
  return [clip[0], clip[1]];
}

/** Effective surrogate weight: the only reward source available offline. */
function surrogateWeightOf(weights: BackfillOptions['weights']): number {
  const raw = weights === undefined ? undefined : weights.surrogate;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function clampReward(value: number, clip: readonly [number, number]): number {
  const lower = clip[0];
  const upper = clip[1];
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(upper, Math.max(lower, value));
}

/** Linear map of a surrogate score in [0, 1] onto [clip[0], clip[1]]. */
export function mapScoreToReward(score: number, clip: readonly [number, number]): number {
  const bounded = clamp01(score);
  const span = clip[1] - clip[0];
  return clip[0] + span * bounded;
}

/** Deterministic, collision-free record id for one tree node. */
export function backfillRecordId(treeId: string, nodeId: string): string {
  return BACKFILL_RECORD_PREFIX + ':' + treeId + ':' + nodeId;
}

function treeListOf(pool: BackfillTreeSource): readonly DiscoveryTreeSnapshot[] {
  if (Array.isArray(pool)) {
    return pool as readonly DiscoveryTreeSnapshot[];
  }
  const list = (pool as Pick<IDiscoveryTreePool, 'list'>).list;
  if (typeof list !== 'function') {
    return [];
  }
  const trees = list.call(pool);
  return Array.isArray(trees) ? trees : [];
}

interface TreeWalk {
  /** nodeId -> G(v) for every scored node. */
  readonly returns: ReadonlyMap<string, number>;
  readonly root: DiscoveryNode | undefined;
  readonly diagnostics: readonly string[];
}

/**
 * One memoised post-order walk computing G(v) = r(v) + gamma * max_child G(child).
 * A child reference that is missing is ignored; a cycle is broken by treating
 * the revisited node as a leaf so the walk always terminates.
 */
function walkTree(
  tree: DiscoveryTreeSnapshot,
  rewardOf: (node: DiscoveryNode) => number | null,
  gamma: number
): TreeWalk {
  const diagnostics: string[] = [];
  const nodes: Readonly<Record<string, DiscoveryNode>> = isRecord(tree.nodes)
    ? tree.nodes
    : {};
  const root = typeof tree.rootId === 'string' ? nodes[tree.rootId] : undefined;
  if (root === undefined) {
    diagnostics.push(
      'backfill: tree ' + tree.id + ' has no resolvable root node; skipped'
    );
    return { returns: new Map<string, number>(), root: undefined, diagnostics };
  }

  const returns = new Map<string, number>();
  // G2-5: memoise EVERY visited node, scored or not. The walk used to cache only
  // scored nodes, so an unscored node shared by several parents was re-expanded
  // once per path - quadratic on a pathological diamond tree. A separate cache
  // keeps the public contract intact: `returns` still holds only convertible
  // (scored) nodes, exactly as before.
  const visited = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (node: DiscoveryNode): number => {
    const cached = returns.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    const memo = visited.get(node.id);
    if (memo !== undefined) {
      return memo;
    }
    if (visiting.has(node.id)) {
      diagnostics.push(
        'backfill: tree ' + tree.id + ' has a cycle through node ' + node.id + '; treated as a leaf'
      );
      return 0;
    }
    visiting.add(node.id);
    const own = rewardOf(node);
    let bestChild = 0;
    let hasChild = false;
    for (const childId of node.childIds ?? []) {
      const child = typeof childId === 'string' ? nodes[childId] : undefined;
      if (child === undefined) {
        diagnostics.push(
          'backfill: tree ' + tree.id + ' node ' + node.id + ' references missing child ' + String(childId)
        );
        continue;
      }
      const childReturn = visit(child);
      if (!hasChild || childReturn > bestChild) {
        bestChild = childReturn;
        hasChild = true;
      }
    }
    visiting.delete(node.id);
    // An unscored node has no reward of its own but may still carry a subtree
    // return; own === null means "not convertible" and the node keeps G = the
    // discounted subtree maximum only when it has children.
    const base = own === null ? 0 : own;
    const value = hasChild ? base + gamma * bestChild : base;
    // Cache unconditionally (G2-5), then expose the value only when convertible.
    visited.set(node.id, value);
    if (own !== null) {
      returns.set(node.id, value);
    }
    return value;
  };

  visit(root);
  return { returns, root, diagnostics };
}

/**
 * Convert every scored node of every persisted tree into an L1 experience and
 * append it to the store. Idempotent: re-running over the same pool appends the
 * same ids, which the store deduplicates.
 */
export async function backfillFromTreePool(
  options: BackfillOptions
): Promise<BackfillResult> {
  const now = options.now ?? ((): number => Date.now());
  const gamma = Number.isFinite(options.gamma)
    ? Math.min(1, Math.max(0, options.gamma as number))
    : DEFAULT_BACKFILL_GAMMA;
  const clip = resolveClip(options.clip);
  const surrogateWeight = surrogateWeightOf(options.weights);
  const trees = treeListOf(options.pool);
  const diagnostics: string[] = [];
  const records: ExperienceRecord[] = [];
  let skipped = 0;
  let unscored = 0;

  const rewardOf = (node: DiscoveryNode): number | null => {
    const score = node.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return null;
    }
    return clampReward(mapScoreToReward(score, clip) * surrogateWeight, clip);
  };

  for (const tree of trees) {
    if (!isRecord(tree) || typeof tree.id !== 'string' || tree.id.length === 0) {
      diagnostics.push('backfill: ignored a tree without a usable id');
      skipped += 1;
      continue;
    }
    const walk = walkTree(tree, rewardOf, gamma);
    for (const message of walk.diagnostics) {
      diagnostics.push(message);
    }
    if (walk.root === undefined) {
      skipped += 1;
      continue;
    }
    const nodes: Readonly<Record<string, DiscoveryNode>> = isRecord(tree.nodes)
      ? tree.nodes
      : {};
    const referenceStatus = referenceStatusOf(walk.root);
    const taskSignature =
      stringOrUndefined(metadataOf(tree.metadata, 'taskSignature')) ??
      'task:' + tree.taskId;
    const complexityRaw = metadataOf(tree.metadata, 'complexity');
    const memoryConfidence = finiteOr(metadataOf(tree.metadata, 'memoryConfidence'), 0);
    const fallbackCreatedAt = finiteOr(tree.updatedAt, finiteOr(tree.createdAt, now()));

    for (const node of Object.values(nodes)) {
      if (!isRecord(node) || typeof node.id !== 'string') {
        skipped += 1;
        continue;
      }
      const reward = rewardOf(node);
      if (reward === null) {
        unscored += 1;
        continue;
      }
      const treeReturn = walk.returns.get(node.id);
      if (treeReturn === undefined) {
        skipped += 1;
        continue;
      }
      const parent =
        typeof node.parentId === 'string' ? nodes[node.parentId] : undefined;
      const task: ProbeTask = {
        id: tree.taskId,
        prompt: '',
        taskSignature,
        ...(isKnownComplexity(complexityRaw) ? { complexity: complexityRaw } : {})
      };
      const state = abstractMetaState({
        task,
        round: finiteOr(node.round, 0),
        parentDepth: parent === undefined ? 0 : finiteOr(parent.depth, 0),
        ...(parent?.slot === undefined ? {} : { parentSlot: parent.slot }),
        ...(parent?.failure === undefined ? {} : { parentFailure: parent.failure }),
        memoryConfidence,
        referenceStatus
      });
      const slot = node.slot ?? 'exploit';
      let actionKey: string;
      try {
        actionKey = normalizeMetaAction(slot, surfaceKeysOf(node));
      } catch {
        diagnostics.push(
          'backfill: tree ' + tree.id + ' node ' + node.id + ' has an invalid slot; used slot:exploit'
        );
        actionKey = normalizeMetaAction('exploit', []);
      }
      records.push({
        id: backfillRecordId(tree.id, node.id),
        level: 'meta',
        state,
        actionKey,
        reward,
        return: treeReturn,
        rewardSources: { surrogate: reward },
        guidance: node.guidance === 'guidance_free' ? 'guidance_free' : 'memory',
        policyId: stringOrUndefined(tree.policyId) ?? 'unknown',
        sessionId: stringOrUndefined(tree.sessionId) ?? 'unknown',
        treeId: tree.id,
        nodeId: node.id,
        createdAt: finiteOr(node.updatedAt, finiteOr(node.createdAt, fallbackCreatedAt)),
        redacted: true
      });
    }
  }

  let appended = 0;
  if (records.length > 0) {
    try {
      await options.store.append(records);
      appended = records.length;
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      diagnostics.push(
        'backfill: the experience store rejected the cold-start batch (' + reason + ')'
      );
    }
  }

  return {
    records,
    recordCount: records.length,
    appended,
    skipped,
    unscored,
    treeCount: trees.length,
    diagnostics
  };
}
