/**
 * rev6 audit A4-2 (B4/H10): the verified-tree readiness floor.
 *
 * Contract:
 *   - a tree is VERIFIED only when EVERY scored node carries trusted,
 *     concrete evidence (`trusted === true`, verdict passed/failed);
 *   - an unverified scored sibling disqualifies the whole tree (no mixed
 *     scales on one replay);
 *   - the production floor is 12 verified trees; a smaller pool is not ready;
 *   - minimum 0 disables the gate (hand-built/test seam) but still reports the
 *     real verified count, so a disabled gate never impersonates verification.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_VERIFIED_TREES_FOR_DREAM,
  assessDreamReadiness,
  countVerifiedTrees,
  dreamEvidenceOf,
  isVerifiedTree
} from '../../../src/dream-rsi/verified-tree-gate';
import type {
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  DiscoveryTreeStats
} from '../../../src/types/contracts';

type EvidenceVerdict = 'passed' | 'failed' | 'unknown';

function node(
  id: string,
  options: {
    readonly score?: number;
    readonly trusted?: boolean;
    readonly verdict?: EvidenceVerdict;
    readonly withEvidence?: boolean;
    readonly strategy?: string;
    readonly verifierId?: string | null;
    readonly evidenceHash?: string | null;
  } = {}
): DiscoveryNode {
  const score = options.score === undefined ? 0.5 : options.score;
  const withEvidence = options.withEvidence !== false;
  const verifierId =
    options.verifierId === null
      ? undefined
      : options.verifierId ?? 'verified-tree-test-host';
  const evidenceHash =
    options.evidenceHash === null
      ? undefined
      : options.evidenceHash ?? 'sha256:' + 'a'.repeat(64);
  return {
    id,
    treeId: 'tree',
    parentId: null,
    depth: 1,
    branchId: 'b-' + id,
    patchId: 'p-' + id,
    patchOrigin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    status: 'succeeded',
    ...(score === Number.NEGATIVE_INFINITY ? {} : { score }),
    childIds: [],
    createdAt: 1,
    updatedAt: 2,
    ...(withEvidence
      ? {
          metadata: {
            dreamEvidence: {
              verdict: options.verdict ?? 'passed',
              trusted: options.trusted ?? true,
              dreamScore: 0.25,
              strategy: options.strategy ?? 'verified-only-selection',
              ...(verifierId === undefined ? {} : { verifierId }),
              ...(evidenceHash === undefined ? {} : { evidenceHash })
            }
          }
        }
      : {})
  } as DiscoveryNode;
}

function treeOf(id: string, nodes: readonly DiscoveryNode[]): DiscoveryTreeSnapshot {
  const map: Record<string, DiscoveryNode> = {};
  for (const entry of nodes) {
    map[entry.id] = { ...entry, treeId: id };
  }
  const stats: DiscoveryTreeStats = {
    nodeCount: nodes.length,
    maxDepth: 1,
    maxWidth: nodes.length,
    scoredNodes: nodes.filter((entry) => typeof entry.score === 'number').length,
    completedNodes: nodes.length
  };
  return {
    id,
    sessionId: 's',
    taskId: 't-' + id,
    rootId: nodes[0]?.id ?? 'root',
    nodes: map,
    stats,
    completed: true,
    createdAt: 1,
    updatedAt: 2
  };
}

describe('dreamEvidenceOf', () => {
  it('reads the recorded block and clamps the score', () => {
    const evidence = dreamEvidenceOf({
      ...node('n'),
      metadata: {
        dreamEvidence: {
          verdict: 'passed',
          trusted: true,
          dreamScore: 5,
          strategy: 'verified-only-selection',
          verifierId: 'host-a',
          evidenceHash: 'sha256:' + 'b'.repeat(64)
        }
      }
    });
    expect(evidence).toEqual({
      verdict: 'passed',
      trusted: true,
      dreamScore: 1,
      strategy: 'verified-only-selection',
      verifierId: 'host-a',
      evidenceHash: 'sha256:' + 'b'.repeat(64)
    });
  });

  it('is fail-closed on malformed blocks', () => {
    expect(dreamEvidenceOf(node('n', { withEvidence: false }))).toBeUndefined();
    expect(
      dreamEvidenceOf({
        ...node('n'),
        metadata: { dreamEvidence: { verdict: 'passed', trusted: 'yes', dreamScore: 1 } }
      })
    ).toBeUndefined();
    expect(
      dreamEvidenceOf({
        ...node('n'),
        metadata: { dreamEvidence: { verdict: 'passed', trusted: true, dreamScore: Number.NaN } }
      })
    ).toBeUndefined();
  });
});

describe('verified-tree gate', () => {
  it('requires every scored node to be trusted and verdict-bearing', () => {
    expect(isVerifiedTree(treeOf('t1', [node('a'), node('b', { verdict: 'failed' })]))).toBe(true);
    // One unverified scored sibling disqualifies the tree.
    expect(isVerifiedTree(treeOf('t2', [node('a'), node('b', { trusted: false })]))).toBe(false);
    // An `unknown` verdict is not evidence even if trusted.
    expect(isVerifiedTree(treeOf('t3', [node('a'), node('b', { verdict: 'unknown' })]))).toBe(false);
    // A legacy scored node without the evidence block disqualifies it too.
    expect(
      isVerifiedTree(treeOf('t4', [node('a'), node('b', { withEvidence: false })]))
    ).toBe(false);
  });

  it('requires a pinned strategy, producer identity and evidence hash (read-time re-check)', () => {
    // A boolean-only / pre-A4-2 block is not enough.
    expect(
      isVerifiedTree(treeOf('t7', [node('a', { verifierId: null })]))
    ).toBe(false);
    expect(
      isVerifiedTree(treeOf('t8', [node('a', { evidenceHash: null })]))
    ).toBe(false);
    // An attacker-chosen strategy string is not the production strategy.
    expect(
      isVerifiedTree(treeOf('t9', [node('a', { strategy: 'attacker-choice' })]))
    ).toBe(false);
    // With a producer set, membership is mandatory. An EMPTY set verifies
    // nothing (the conservative-degraded case).
    expect(
      isVerifiedTree(treeOf('t10', [node('a')]), { trustedProducers: new Set(['host-other']) })
    ).toBe(false);
    expect(
      isVerifiedTree(treeOf('t11', [node('a')]), { trustedProducers: new Set<string>() })
    ).toBe(false);
    expect(
      isVerifiedTree(treeOf('t12', [node('a')]), {
        trustedProducers: new Set(['verified-tree-test-host'])
      })
    ).toBe(true);
  });

  it('ignores unscored nodes (unprobed roots / pruned branches)', () => {
    const unscored = node('root', { score: Number.NEGATIVE_INFINITY, withEvidence: false });
    expect(isVerifiedTree(treeOf('t5', [unscored, node('a')]))).toBe(true);
    // A tree with no scored nodes at all is not verified.
    expect(isVerifiedTree(treeOf('t6', [unscored]))).toBe(false);
  });

  it('counts only fully verified trees', () => {
    const trees = [
      treeOf('a', [node('n1')]),
      treeOf('b', [node('n2', { trusted: false })]),
      treeOf('c', [node('n3', { verdict: 'failed' })])
    ];
    expect(countVerifiedTrees(trees)).toBe(2);
  });

  it('the production floor is 12 and a smaller verified pool is not ready', () => {
    expect(MIN_VERIFIED_TREES_FOR_DREAM).toBe(12);
    const eleven = Array.from({ length: 11 }, (_unused, index) =>
      treeOf('v' + String(index), [node('n' + String(index))])
    );
    const assessment = assessDreamReadiness(eleven);
    expect(assessment.minimum).toBe(12);
    expect(assessment.ready).toBe(false);
    expect(assessment.verifiedTreeCount).toBe(11);
    expect(assessment.reason).toContain('< minimum 12');
    expect(assessment.verifiedTrees).toHaveLength(11);

    const twelve = [...eleven, treeOf('v11', [node('n11')])];
    const ready = assessDreamReadiness(twelve);
    expect(ready.ready).toBe(true);
    expect(ready.verifiedTreeCount).toBe(12);
  });

  it('never hands unverified trees to replay and reports the pool honestly', () => {
    const trees = [
      ...Array.from({ length: 12 }, (_unused, index) =>
        treeOf('v' + String(index), [node('n' + String(index))])
      ),
      treeOf('u1', [node('u', { trusted: false })]),
      treeOf('u2', [node('u2', { withEvidence: false })])
    ];
    const assessment = assessDreamReadiness(trees);
    expect(assessment.ready).toBe(true);
    expect(assessment.totalTrees).toBe(14);
    expect(assessment.verifiedTreeCount).toBe(12);
    expect(assessment.verifiedTrees.map((tree) => tree.id)).not.toContain('u1');
    expect(assessment.verifiedTrees.map((tree) => tree.id)).not.toContain('u2');
  });

  it('minimum 0 disables the gate but still reports verification truth', () => {
    const trees = [treeOf('u', [node('n', { trusted: false })])];
    const assessment = assessDreamReadiness(trees, 0);
    expect(assessment.ready).toBe(true);
    expect(assessment.minimum).toBe(0);
    expect(assessment.verifiedTreeCount).toBe(0);
    expect(assessment.reason).toContain('gate disabled');
    // A negative / non-integer minimum is NOT silently disabled. A positive
    // non-integer floors to at least 1; invalid values are refused instead of
    // becoming a fail-open 0.
    expect(assessDreamReadiness(trees, 12.5).minimum).toBe(12);
    expect(assessDreamReadiness(trees, 0.5).minimum).toBe(1);
    expect(() => assessDreamReadiness(trees, -3)).toThrow(RangeError);
    expect(() => assessDreamReadiness(trees, Number.NaN)).toThrow(RangeError);
    expect(() => assessDreamReadiness(trees, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('an empty pool is never ready (nothing to replay)', () => {
    const assessment = assessDreamReadiness([], 0);
    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toContain('no retained trees');
  });
});

// ---------------------------------------------------------------------------
// rev8 #118: contaminated evidence never enters replay
// ---------------------------------------------------------------------------

describe('rev8 #118: contaminated evidence is not verified evidence', () => {
  it('a node whose source execution was withheld is not verified, whatever its score', () => {
    const contaminatedNode = {
      ...node('contaminated'),
      metadata: {
        dreamEvidence: {
          verdict: 'passed',
          trusted: true,
          dreamScore: 1,
          strategy: 'verified-only-selection',
          verifierId: 'verified-tree-test-host',
          evidenceHash: 'sha256:' + 'c'.repeat(64),
          contaminated: true
        }
      }
    };
    expect(isVerifiedTree(treeOf('tc', [contaminatedNode]))).toBe(false);
    // The flag rides through the reader as a fact.
    expect(dreamEvidenceOf(contaminatedNode)?.contaminated).toBe(true);
  });

  it('a tree-level contaminated mark excludes the tree even when node blocks look verified', () => {
    const tree = treeOf('t-marked', [node('a'), node('b')]);
    const marked = {
      ...tree,
      metadata: {
        evidenceIntegrity: {
          version: 'rev8-evidence-integrity-v1',
          contaminated: true,
          withheld: true,
          findings: [{ kind: 'answer-key-text', location: 'deliverable' }]
        }
      }
    } as DiscoveryTreeSnapshot;
    expect(isVerifiedTree(marked)).toBe(false);
    // An unrelated metadata bag does not exclude anything.
    const unmarked = { ...tree, metadata: { note: 'clean' } } as DiscoveryTreeSnapshot;
    expect(isVerifiedTree(unmarked)).toBe(true);
  });

  it('a forged truthy contamination string is not a fact (fail-closed reader)', () => {
    const forged = {
      ...node('forged'),
      metadata: {
        dreamEvidence: {
          verdict: 'passed',
          trusted: true,
          dreamScore: 1,
          strategy: 'verified-only-selection',
          verifierId: 'verified-tree-test-host',
          evidenceHash: 'sha256:' + 'd'.repeat(64),
          contaminated: 'yes'
        }
      }
    };
    // The malformed block reads as ABSENT evidence, not as contaminated or clean.
    expect(dreamEvidenceOf(forged)).toBeUndefined();
    expect(isVerifiedTree(treeOf('tf', [forged]))).toBe(false);
  });

  it('the count gate reports contaminated trees in the unverified remainder', () => {
    const trees = [
      ...Array.from({ length: 12 }, (_unused, index) => treeOf('v' + String(index), [node('n' + String(index))])),
      treeOf('contaminated', [{ ...node('n-c', { trusted: false }) }])
    ];
    trees[12] = {
      ...trees[12]!,
      metadata: {
        evidenceIntegrity: {
          version: 'rev8-evidence-integrity-v1',
          contaminated: true,
          withheld: true,
          findings: []
        }
      }
    };
    const assessment = assessDreamReadiness(trees);
    expect(assessment.ready).toBe(true);
    expect(assessment.verifiedTreeCount).toBe(12);
    expect(assessment.verifiedTrees.map((tree) => tree.id)).not.toContain('contaminated');
  });
});