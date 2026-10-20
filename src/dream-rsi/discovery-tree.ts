/**
 * Dream-RSI discovery tree T and its causal prefix (prefix-only) replay view.
 *
 * Ownership: src/dream-rsi/** (Wave 1, Dream-RSI layer).
 *
 * Two invariants drive this module:
 * 1. Online search appends nodes to a persistent tree; every append records the
 *    parent link, so the ancestor chain of a node is exactly its causal prefix
 *    (ARCHITECTURE.md 5.1).
 * 2. Offline replay is zero-execution and must never observe the future. A
 *    replay view is anchored on one node and exposes only that node's causal
 *    prefix; siblings, descendants and later branches are rejected.
 *
 * The tree is immutable-by-copy at the API boundary: callers receive plain
 * DiscoveryNode records, never the internal mutable node.
 */

import type {
  BatchSlotKind,
  ContractMetadata,
  DiscoveryNode,
  DiscoveryNodeStatus,
  DiscoveryTreeSnapshot,
  DiscoveryTreeStats,
  FailureDiagnosis,
  GuidanceMode,
  IDiscoveryTree,
  IDiscoveryTreePool,
  PatchOrigin,
  PatchPurpose
} from '../types/contracts';

let autoIdCounter = 0;

/** Deterministic per-process id for auto-generated ids. */
function nextAutoId(prefix: string): string {
  autoIdCounter += 1;
  return prefix + '-' + autoIdCounter;
}

/** Thrown when a node id is not part of the addressed tree. */
export class UnknownDiscoveryNodeError extends Error {
  readonly code = 'UNKNOWN_DISCOVERY_NODE';
  readonly treeId: string;
  readonly nodeId: string;

  constructor(treeId: string, nodeId: string) {
    super("Unknown node '" + nodeId + "' in discovery tree '" + treeId + "'");
    this.name = 'UnknownDiscoveryNodeError';
    this.treeId = treeId;
    this.nodeId = nodeId;
  }
}

/**
 * Thrown when a prefix-scoped view is asked about a node that is not part of
 * the anchor's causal prefix. This is the hard rejection that keeps replay from
 * seeing the future (or a parallel branch).
 */
export class FutureNodeVisibilityError extends Error {
  readonly code = 'FUTURE_NODE_NOT_VISIBLE';
  readonly treeId: string;
  readonly anchorNodeId: string;
  readonly nodeId: string;

  constructor(treeId: string, anchorNodeId: string, nodeId: string) {
    super(
      "Node '" +
        nodeId +
        "' is outside the causal prefix of anchor '" +
        anchorNodeId +
        "' in discovery tree '" +
        treeId +
        "'"
    );
    this.name = 'FutureNodeVisibilityError';
    this.treeId = treeId;
    this.anchorNodeId = anchorNodeId;
    this.nodeId = nodeId;
  }
}

/** Input for appending one node to a tree. */
export interface CreateDiscoveryNodeInput {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly branchId?: string;
  readonly patchId: string;
  readonly patchOrigin: PatchOrigin;
  readonly purpose: PatchPurpose;
  readonly guidance: GuidanceMode;
  readonly status?: DiscoveryNodeStatus;
  readonly slot?: BatchSlotKind;
  readonly round?: number;
  readonly trajectoryId?: string;
  readonly score?: number;
  readonly adoptionRatio?: number;
  readonly failure?: FailureDiagnosis;
  readonly createdAt?: number;
  readonly metadata?: ContractMetadata;
}

/** Sparse in-place update; undefined fields are left untouched. */
export interface DiscoveryNodePatch {
  readonly status?: DiscoveryNodeStatus;
  readonly trajectoryId?: string;
  readonly score?: number;
  readonly adoptionRatio?: number;
  readonly failure?: FailureDiagnosis;
  readonly metadata?: ContractMetadata;
  readonly updatedAt?: number;
}

/** Probe completion record applied to a node. */
export interface ProbeNodeRecord {
  readonly trajectoryId: string;
  readonly status?: DiscoveryNodeStatus;
  readonly score?: number;
  readonly adoptionRatio?: number;
  readonly failure?: FailureDiagnosis;
  readonly metadata?: ContractMetadata;
}

/** Construction options for a mutable discovery tree. */
export interface DiscoveryTreeOptions {
  readonly id?: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly rootPatchId: string;
  readonly rootBranchId?: string;
  readonly rootPatchOrigin?: PatchOrigin;
  readonly rootPurpose?: PatchPurpose;
  readonly rootGuidance?: GuidanceMode;
  readonly policyId?: string;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly createdAt?: number;
}

/** Mutable discovery tree handle. */
export interface DiscoveryTree extends IDiscoveryTree {
  readonly sessionId: string;
  readonly taskId: string;
  addNode(input: CreateDiscoveryNodeInput): DiscoveryNode;
  updateNode(nodeId: string, patch: DiscoveryNodePatch): DiscoveryNode;
  setStatus(nodeId: string, status: DiscoveryNodeStatus): DiscoveryNode;
  recordProbe(nodeId: string, record: ProbeNodeRecord): DiscoveryNode;
  setPolicyId(policyId: string | undefined): void;
  setCompleted(completed: boolean): void;
  isCompleted(): boolean;
  getStats(): DiscoveryTreeStats;
}

interface MutableNode {
  id: string;
  treeId: string;
  parentId: string | null;
  depth: number;
  branchId: string;
  patchId: string;
  patchOrigin: PatchOrigin;
  purpose: PatchPurpose;
  guidance: GuidanceMode;
  status: DiscoveryNodeStatus;
  slot?: BatchSlotKind;
  round?: number;
  trajectoryId?: string;
  score?: number;
  adoptionRatio?: number;
  failure?: FailureDiagnosis;
  childIds: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: ContractMetadata;
}

interface TreeSeed {
  readonly nodes: Readonly<Record<string, DiscoveryNode>>;
  readonly rootId: string;
  readonly completed: boolean;
  readonly policyId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function toDiscoveryNode(node: MutableNode): DiscoveryNode {
  const copy: MutableNode = {
    id: node.id,
    treeId: node.treeId,
    parentId: node.parentId,
    depth: node.depth,
    branchId: node.branchId,
    patchId: node.patchId,
    patchOrigin: node.patchOrigin,
    purpose: node.purpose,
    guidance: node.guidance,
    status: node.status,
    childIds: [...node.childIds],
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
  if (node.slot !== undefined) {
    copy.slot = node.slot;
  }
  if (node.round !== undefined) {
    copy.round = node.round;
  }
  if (node.trajectoryId !== undefined) {
    copy.trajectoryId = node.trajectoryId;
  }
  if (node.score !== undefined) {
    copy.score = node.score;
  }
  if (node.adoptionRatio !== undefined) {
    copy.adoptionRatio = node.adoptionRatio;
  }
  if (node.failure !== undefined) {
    copy.failure = node.failure;
  }
  if (node.metadata !== undefined) {
    copy.metadata = node.metadata;
  }
  return copy;
}

/** Nodes whose status counts as a finished probe. */
export function isTerminalNodeStatus(status: DiscoveryNodeStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'pruned';
}

class DiscoveryTreeImpl implements DiscoveryTree {
  readonly id: string;
  readonly rootId: string;
  readonly sessionId: string;
  readonly taskId: string;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly nodes = new Map<string, MutableNode>();
  private readonly createdAtValue: number;
  private policyIdValue: string | undefined;
  private completedValue = false;
  private updatedAtValue: number;

  constructor(options: DiscoveryTreeOptions, seed?: TreeSeed) {
    const clock = options.clock ?? ((): number => Date.now());
    this.clock = clock;
    this.idFactory = options.idFactory ?? ((): string => nextAutoId('node'));
    this.id = options.id ?? nextAutoId('tree');
    this.sessionId = options.sessionId;
    this.taskId = options.taskId;
    this.createdAtValue = seed === undefined ? options.createdAt ?? clock() : seed.createdAt;
    this.updatedAtValue = seed === undefined ? this.createdAtValue : seed.updatedAt;
    if (seed === undefined) {
      this.policyIdValue = options.policyId;
      const rootId = this.idFactory();
      const root: MutableNode = {
        id: rootId,
        treeId: this.id,
        parentId: null,
        depth: 0,
        branchId: options.rootBranchId ?? this.id + ':root',
        patchId: options.rootPatchId,
        patchOrigin: options.rootPatchOrigin ?? 'reference',
        purpose: options.rootPurpose ?? 'initial',
        guidance: options.rootGuidance ?? 'memory',
        status: 'proposed',
        childIds: [],
        createdAt: this.createdAtValue,
        updatedAt: this.createdAtValue
      };
      this.nodes.set(rootId, root);
      this.rootId = rootId;
      return;
    }
    this.policyIdValue = seed.policyId;
    this.completedValue = seed.completed;
    this.rootId = seed.rootId;
    for (const node of Object.values(seed.nodes)) {
      this.nodes.set(node.id, {
        id: node.id,
        treeId: this.id,
        parentId: node.parentId,
        depth: node.depth,
        branchId: node.branchId,
        patchId: node.patchId,
        patchOrigin: node.patchOrigin,
        purpose: node.purpose,
        guidance: node.guidance,
        status: node.status,
        slot: node.slot,
        round: node.round,
        trajectoryId: node.trajectoryId,
        score: node.score,
        adoptionRatio: node.adoptionRatio,
        failure: node.failure,
        childIds: [...node.childIds],
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        metadata: node.metadata
      });
    }
    if (!this.nodes.has(this.rootId)) {
      throw new UnknownDiscoveryNodeError(this.id, this.rootId);
    }
  }

  addNode(input: CreateDiscoveryNodeInput): DiscoveryNode {
    const parentId = input.parentId === undefined ? null : input.parentId;
    let depth = 0;
    let parent: MutableNode | undefined;
    if (parentId !== null) {
      parent = this.requireNode(parentId);
      depth = parent.depth + 1;
    }
    const id = input.id ?? this.idFactory();
    if (this.nodes.has(id)) {
      throw new Error("Duplicate discovery node id '" + id + "' in tree '" + this.id + "'");
    }
    const at = input.createdAt ?? this.clock();
    const node: MutableNode = {
      id,
      treeId: this.id,
      parentId,
      depth,
      branchId: input.branchId ?? this.id + ':' + id,
      patchId: input.patchId,
      patchOrigin: input.patchOrigin,
      purpose: input.purpose,
      guidance: input.guidance,
      status: input.status ?? 'proposed',
      slot: input.slot,
      round: input.round,
      trajectoryId: input.trajectoryId,
      score: input.score,
      adoptionRatio: input.adoptionRatio,
      failure: input.failure,
      childIds: [],
      createdAt: at,
      updatedAt: at,
      metadata: input.metadata
    };
    this.nodes.set(id, node);
    if (parent !== undefined) {
      parent.childIds.push(id);
      parent.updatedAt = at;
    }
    this.updatedAtValue = at;
    return toDiscoveryNode(node);
  }

  updateNode(nodeId: string, patch: DiscoveryNodePatch): DiscoveryNode {
    const node = this.requireNode(nodeId);
    if (patch.status !== undefined) {
      node.status = patch.status;
    }
    if (patch.trajectoryId !== undefined) {
      node.trajectoryId = patch.trajectoryId;
    }
    if (patch.score !== undefined) {
      node.score = patch.score;
    }
    if (patch.adoptionRatio !== undefined) {
      node.adoptionRatio = patch.adoptionRatio;
    }
    if (patch.failure !== undefined) {
      node.failure = patch.failure;
    }
    if (patch.metadata !== undefined) {
      node.metadata = patch.metadata;
    }
    const at = patch.updatedAt ?? this.clock();
    node.updatedAt = at;
    this.updatedAtValue = at;
    return toDiscoveryNode(node);
  }

  setStatus(nodeId: string, status: DiscoveryNodeStatus): DiscoveryNode {
    return this.updateNode(nodeId, { status });
  }

  recordProbe(nodeId: string, record: ProbeNodeRecord): DiscoveryNode {
    const status =
      record.status ?? (record.failure !== undefined ? 'failed' : 'succeeded');
    return this.updateNode(nodeId, {
      status,
      trajectoryId: record.trajectoryId,
      score: record.score,
      adoptionRatio: record.adoptionRatio,
      failure: record.failure,
      metadata: record.metadata
    });
  }

  setPolicyId(policyId: string | undefined): void {
    this.policyIdValue = policyId;
  }

  setCompleted(completed: boolean): void {
    this.completedValue = completed;
    this.updatedAtValue = this.clock();
  }

  isCompleted(): boolean {
    return this.completedValue;
  }

  getNode(nodeId: string): DiscoveryNode | undefined {
    const node = this.nodes.get(nodeId);
    return node === undefined ? undefined : toDiscoveryNode(node);
  }

  allNodes(): readonly DiscoveryNode[] {
    const out: DiscoveryNode[] = [];
    for (const node of this.nodes.values()) {
      out.push(toDiscoveryNode(node));
    }
    return out;
  }

  childrenOf(nodeId: string): readonly DiscoveryNode[] {
    const node = this.requireNode(nodeId);
    const out: DiscoveryNode[] = [];
    for (const childId of node.childIds) {
      const child = this.nodes.get(childId);
      if (child !== undefined) {
        out.push(toDiscoveryNode(child));
      }
    }
    return out;
  }

  /** Ancestors in root-to-parent order (self excluded). */
  ancestorsOf(nodeId: string): readonly DiscoveryNode[] {
    let current = this.requireNode(nodeId);
    const chain: DiscoveryNode[] = [];
    while (current.parentId !== null) {
      const parent = this.nodes.get(current.parentId);
      if (parent === undefined) {
        break;
      }
      chain.push(toDiscoveryNode(parent));
      current = parent;
    }
    chain.reverse();
    return chain;
  }

  /** Ancestors plus the node itself, root-to-node order. */
  causalPrefix(nodeId: string): readonly DiscoveryNode[] {
    const node = this.requireNode(nodeId);
    const prefix = this.ancestorsOf(nodeId);
    return [...prefix, toDiscoveryNode(node)];
  }

  getStats(): DiscoveryTreeStats {
    let maxDepth = 0;
    let scoredNodes = 0;
    let completedNodes = 0;
    const depthCounts = new Map<number, number>();
    for (const node of this.nodes.values()) {
      if (node.depth > maxDepth) {
        maxDepth = node.depth;
      }
      depthCounts.set(node.depth, (depthCounts.get(node.depth) ?? 0) + 1);
      if (node.score !== undefined) {
        scoredNodes += 1;
      }
      if (node.status === 'succeeded' || node.status === 'failed') {
        completedNodes += 1;
      }
    }
    let maxWidth = 0;
    for (const count of depthCounts.values()) {
      if (count > maxWidth) {
        maxWidth = count;
      }
    }
    return {
      nodeCount: this.nodes.size,
      maxDepth,
      maxWidth,
      scoredNodes,
      completedNodes
    };
  }

  snapshot(): DiscoveryTreeSnapshot {
    const nodes: Record<string, DiscoveryNode> = {};
    for (const node of this.nodes.values()) {
      nodes[node.id] = toDiscoveryNode(node);
    }
    const base = {
      id: this.id,
      sessionId: this.sessionId,
      taskId: this.taskId,
      rootId: this.rootId,
      nodes,
      stats: this.getStats(),
      completed: this.completedValue,
      createdAt: this.createdAtValue,
      updatedAt: this.updatedAtValue
    };
    return this.policyIdValue === undefined
      ? base
      : { ...base, policyId: this.policyIdValue };
  }

  private requireNode(nodeId: string): MutableNode {
    const node = this.nodes.get(nodeId);
    if (node === undefined) {
      throw new UnknownDiscoveryNodeError(this.id, nodeId);
    }
    return node;
  }
}

/** Create an empty tree with a single root node. */
export function createDiscoveryTree(options: DiscoveryTreeOptions): DiscoveryTree {
  return new DiscoveryTreeImpl(options);
}

/** Rebuild a mutable tree from an immutable snapshot (used by replay). */
export function treeFromSnapshot(
  snapshot: DiscoveryTreeSnapshot,
  options: { readonly id?: string; readonly clock?: () => number } = {}
): DiscoveryTree {
  const clock = options.clock ?? ((): number => Date.now());
  const seed: TreeSeed = {
    nodes: snapshot.nodes,
    rootId: snapshot.rootId,
    completed: snapshot.completed,
    policyId: snapshot.policyId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt
  };
  return new DiscoveryTreeImpl(
    {
      id: options.id ?? snapshot.id,
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      rootPatchId: snapshot.rootId,
      clock
    },
    seed
  );
}

// ---------------------------------------------------------------------------
// Prefix-only replay view
// ---------------------------------------------------------------------------

export interface ReplayPrefixViewOptions {
  /**
   * When true, getNode on a hidden node throws FutureNodeVisibilityError
   * instead of returning undefined. Defaults to false.
   */
  readonly strict?: boolean;
}

/** Read-only view over one node's causal prefix. */
export interface ReplayPrefixView extends IDiscoveryTree {
  readonly anchorNodeId: string;
  readonly hiddenNodeIds: readonly string[];
  isVisible(nodeId: string): boolean;
  visibleNodeIds(): readonly string[];
  assertVisible(nodeId: string): DiscoveryNode;
}

class ReplayPrefixViewImpl implements ReplayPrefixView {
  readonly id: string;
  readonly rootId: string;
  readonly anchorNodeId: string;
  private readonly tree: IDiscoveryTree;
  private readonly anchor: DiscoveryNode;
  private readonly visible: readonly DiscoveryNode[];
  private readonly visibleIds: Set<string>;
  private readonly strict: boolean;
  private readonly sessionId: string;
  private readonly taskId: string;

  constructor(tree: IDiscoveryTree, anchorNodeId: string, strict: boolean) {
    const anchor = tree.getNode(anchorNodeId);
    if (anchor === undefined) {
      throw new UnknownDiscoveryNodeError(tree.id, anchorNodeId);
    }
    this.tree = tree;
    this.anchor = anchor;
    this.anchorNodeId = anchorNodeId;
    this.strict = strict;
    this.id = tree.id + '::prefix::' + anchorNodeId;
    this.rootId = tree.rootId;
    this.visible = tree.causalPrefix(anchorNodeId);
    const ids = new Set<string>();
    for (const node of this.visible) {
      ids.add(node.id);
    }
    this.visibleIds = ids;
    const full = tree.snapshot();
    this.sessionId = full.sessionId;
    this.taskId = full.taskId;
  }

  isVisible(nodeId: string): boolean {
    return this.visibleIds.has(nodeId);
  }

  visibleNodeIds(): readonly string[] {
    return this.visible.map((node) => node.id);
  }

  get hiddenNodeIds(): readonly string[] {
    const out: string[] = [];
    for (const node of this.tree.allNodes()) {
      if (!this.visibleIds.has(node.id)) {
        out.push(node.id);
      }
    }
    return out;
  }

  getNode(nodeId: string): DiscoveryNode | undefined {
    if (!this.visibleIds.has(nodeId)) {
      if (this.strict) {
        throw new FutureNodeVisibilityError(this.tree.id, this.anchorNodeId, nodeId);
      }
      return undefined;
    }
    return this.tree.getNode(nodeId);
  }

  assertVisible(nodeId: string): DiscoveryNode {
    const node = this.visibleIds.has(nodeId) ? this.tree.getNode(nodeId) : undefined;
    if (node === undefined) {
      throw new FutureNodeVisibilityError(this.tree.id, this.anchorNodeId, nodeId);
    }
    return node;
  }

  allNodes(): readonly DiscoveryNode[] {
    return this.visible;
  }

  childrenOf(nodeId: string): readonly DiscoveryNode[] {
    this.requireVisible(nodeId);
    return this.tree.childrenOf(nodeId).filter((node) => this.visibleIds.has(node.id));
  }

  ancestorsOf(nodeId: string): readonly DiscoveryNode[] {
    this.requireVisible(nodeId);
    return this.tree.ancestorsOf(nodeId);
  }

  causalPrefix(nodeId: string): readonly DiscoveryNode[] {
    this.requireVisible(nodeId);
    return this.tree.causalPrefix(nodeId);
  }

  snapshot(): DiscoveryTreeSnapshot {
    const nodes: Record<string, DiscoveryNode> = {};
    let maxDepth = 0;
    let scoredNodes = 0;
    let completedNodes = 0;
    const depthCounts = new Map<number, number>();
    for (const node of this.visible) {
      nodes[node.id] = node;
      if (node.depth > maxDepth) {
        maxDepth = node.depth;
      }
      depthCounts.set(node.depth, (depthCounts.get(node.depth) ?? 0) + 1);
      if (node.score !== undefined) {
        scoredNodes += 1;
      }
      if (node.status === 'succeeded' || node.status === 'failed') {
        completedNodes += 1;
      }
    }
    let maxWidth = 0;
    for (const count of depthCounts.values()) {
      if (count > maxWidth) {
        maxWidth = count;
      }
    }
    return {
      id: this.id,
      sessionId: this.sessionId,
      taskId: this.taskId,
      rootId: this.rootId,
      nodes,
      stats: {
        nodeCount: this.visible.length,
        maxDepth,
        maxWidth,
        scoredNodes,
        completedNodes
      },
      completed: isTerminalNodeStatus(this.anchor.status),
      createdAt: this.anchor.createdAt,
      updatedAt: this.anchor.updatedAt,
      metadata: { anchorNodeId: this.anchorNodeId, prefixOnly: true }
    };
  }

  private requireVisible(nodeId: string): DiscoveryNode {
    const node = this.visibleIds.has(nodeId) ? this.tree.getNode(nodeId) : undefined;
    if (node === undefined) {
      throw new FutureNodeVisibilityError(this.tree.id, this.anchorNodeId, nodeId);
    }
    return node;
  }
}

/**
 * Wrap a tree in a view anchored at one node. The view exposes only the
 * anchor's causal prefix (root..anchor); every other node is rejected, which is
 * what makes offline replay causally safe.
 */
export function createReplayPrefixView(
  tree: IDiscoveryTree,
  nodeId: string,
  options: ReplayPrefixViewOptions = {}
): ReplayPrefixView {
  return new ReplayPrefixViewImpl(tree, nodeId, options.strict ?? false);
}

// ---------------------------------------------------------------------------
// Historical tree pool
// ---------------------------------------------------------------------------

export interface DiscoveryTreePoolOptions {
  readonly maxTrees?: number;
}

class DiscoveryTreePoolImpl implements IDiscoveryTreePool {
  private readonly order: string[] = [];
  private readonly trees = new Map<string, DiscoveryTreeSnapshot>();
  private readonly maxTrees: number | undefined;

  constructor(maxTrees: number | undefined) {
    this.maxTrees = maxTrees !== undefined && maxTrees > 0 ? maxTrees : undefined;
  }

  add(tree: DiscoveryTreeSnapshot): void {
    if (this.trees.has(tree.id)) {
      const index = this.order.indexOf(tree.id);
      if (index >= 0) {
        this.order.splice(index, 1);
      }
      this.order.push(tree.id);
    } else {
      this.order.push(tree.id);
    }
    this.trees.set(tree.id, tree);
    if (this.maxTrees !== undefined && this.order.length > this.maxTrees) {
      this.pruneTo(this.maxTrees);
    }
  }

  get(treeId: string): DiscoveryTreeSnapshot | undefined {
    return this.trees.get(treeId);
  }

  list(): readonly DiscoveryTreeSnapshot[] {
    const out: DiscoveryTreeSnapshot[] = [];
    for (const id of this.order) {
      const tree = this.trees.get(id);
      if (tree !== undefined) {
        out.push(tree);
      }
    }
    return out;
  }

  size(): number {
    return this.order.length;
  }

  /** Evict least-recently-added trees; returns removed ids oldest first. */
  pruneTo(maxTrees: number): readonly string[] {
    if (!Number.isFinite(maxTrees) || maxTrees < 1) {
      return [];
    }
    const removed: string[] = [];
    while (this.order.length > maxTrees) {
      const id = this.order.shift();
      if (id === undefined) {
        break;
      }
      this.trees.delete(id);
      removed.push(id);
    }
    return removed;
  }

  clear(): void {
    this.order.length = 0;
    this.trees.clear();
  }
}

/** Create a bounded pool of historical discovery trees for replay. */
export function createDiscoveryTreePool(
  options: DiscoveryTreePoolOptions = {}
): IDiscoveryTreePool {
  return new DiscoveryTreePoolImpl(options.maxTrees);
}

/** Convenience: highest-scoring node of a tree, tie-broken by creation order. */
export function bestNodeOf(tree: IDiscoveryTree): DiscoveryNode | undefined {
  let best: DiscoveryNode | undefined;
  for (const node of tree.allNodes()) {
    if (node.score === undefined) {
      continue;
    }
    if (best === undefined || (best.score ?? 0) < node.score) {
      best = node;
    }
  }
  return best;
}

/** Convenience: root node of a tree. */
export function rootNodeOf(tree: IDiscoveryTree): DiscoveryNode | undefined {
  return tree.getNode(tree.rootId);
}
