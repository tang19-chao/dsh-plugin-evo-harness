/**
 * rev6 audit A4-2 (B4/H10): the minimum-evidence gate for offline dreaming.
 *
 * WHY A TREE-LEVEL GATE
 * ---------------------
 * A4-2 fixes the surrogate's self-reference (the Composer's own selection and
 * adoption terms no longer count without verifiable evidence). But a fixed
 * scoring rule is not enough: if Dream is replayed over trees whose nodes were
 * never verified, it still optimizes the frozen efficiency/penalty arithmetic,
 * and it MIXES those nodes with genuinely verified ones on the same replay
 * scale. The honest precondition is therefore a count of trees that carry
 * TRUSTED evidence, and a floor that matches the preregistered power
 * (m = 12 for the four-arm ablation; the dreamer must not claim a policy
 * improvement from fewer independent verified trees than the design needs).
 *
 * DEFINITION (deliberately strict)
 * --------------------------------
 * A tree is VERIFIED when it has at least one SCORED node and EVERY scored node
 * carries `metadata.dreamEvidence` with:
 *   - `trusted === true`,
 *   - a concrete verdict (`passed` or `failed`; `unknown` is not evidence),
 *   - the exact {@link DREAM_EVIDENCE_STRATEGY},
 *   - a non-empty `verifierId` and `evidenceHash`, and
 *   - (when the caller supplies a producer set) a `verifierId` that is a member
 *     of that set.
 * A tree with one unverified scored sibling is excluded entirely: mixing the
 * two on one replay scale is exactly what this gate prevents. Nodes without a
 * score (unprobed roots, pruned branches) do not make a tree unverified.
 *
 * TRUST BOUNDARY (honest, not cryptographic)
 * ------------------------------------------
 * The persisted `dreamEvidence` block records the producer identity and the
 * evidence hash so a reader can RE-CHECK it against the production producer
 * set. It is still local data: this module does not sign the tree and cannot
 * detect an attacker who rewrites BOTH the `trusted` boolean and a copied
 * verifier/hash pair on disk. `tree-pool.jsonl` is therefore treated as
 * local-trusted input; the read-time check raises the forgery cost and rejects
 * pre-A4-2 hand-written `trusted:true` blocks, but it is not a signature. The
 * earlier "a host-registered producer signed the verdict" wording overstated
 * what was persisted and has been removed.
 *
 * The production minimum is {@link MIN_VERIFIED_TREES_FOR_DREAM}. Hand-built
 * orchestrators default to 0 (gate disabled) so the existing Dream mechanics
 * stay testable without fabricating host evidence; production wiring passes 12.
 */
import type { DiscoveryNode, DiscoveryTreeSnapshot } from '../types/contracts';
import { readEvidenceIntegrityMark } from '../verification/evidence-integrity';

/** The evidence shape the orchestrator records on every scored node. */
export interface DreamEvidence {
  readonly verdict: 'passed' | 'failed' | 'unknown';
  /** True only for host-trusted provenance (producer set + evidence hash). */
  readonly trusted: boolean;
  /** The frozen-absolute-weight (strategy B) score used by replay. */
  readonly dreamScore: number;
  readonly strategy: string;
  /** Producer identity carried from the trusted verification, when one existed. */
  readonly verifierId?: string;
  /** Evidence hash carried from the trusted verification, when one existed. */
  readonly evidenceHash?: string;
  /**
   * rev8 #118: the trajectory's evidence-integrity scan withheld the source
   * execution (answer-key text / sentinel / colliding path). True excludes the
   * node from verified evidence regardless of verdict or score. Absent
   * (pre-rev8 blocks) reads as false — the existing floor is not weakened.
   */
  readonly contaminated?: boolean;
}

/** The strategy stamped on production evidence. */
export const DREAM_EVIDENCE_STRATEGY = 'verified-only-selection' as const;

/** Read-time trust inputs. */
export interface VerifiedTreeOptions {
  /**
   * The host producer set production passes. When present (even EMPTY), a
   * persisted `verifierId` must be a member; when absent, the reader still
   * requires the identity/hash fields but cannot re-check membership (research
   * callers). Never widening: an empty set verifies nothing.
   */
  readonly trustedProducers?: ReadonlySet<string>;
}

/**
 * Normalize a Dream floor. Only an explicit `0` disables the gate; a positive
 * finite value is floored to at least 1. Invalid values (negative, NaN,
 * Infinity) are refused instead of silently disabling the gate - a fail-open
 * normalization is exactly what allowed 12.5/Infinity to pass as `0`.
 */
export function normalizeVerifiedTreeMinimum(minimum: number | undefined, fallback = 0): number {
  if (minimum === undefined) {
    return fallback;
  }
  if (minimum === 0) {
    return 0;
  }
  if (!Number.isFinite(minimum) || minimum < 0) {
    throw new RangeError(
      'verified-tree minimum must be 0 (disabled) or a positive finite number; got ' + String(minimum)
    );
  }
  return Math.max(1, Math.floor(minimum));
}

/**
 * Minimum number of verified trees before production Dream runs.
 *
 * 12 is the preregistered ablation m (`rev6-ablation-preregistration.md`), i.e.
 * the smallest sample at which the design's power claim (π* = 0.8693) is
 * defined. It is a FLOOR, never a hint: a pool below it is skipped with a
 * diagnostic, not shrunk to whatever happened to be available.
 */
export const MIN_VERIFIED_TREES_FOR_DREAM = 12;

/** Read the evidence block from one node, structurally and fail-closed. */
export function dreamEvidenceOf(node: DiscoveryNode): DreamEvidence | undefined {
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const raw = metadata === undefined ? undefined : metadata['dreamEvidence'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const verdict = record['verdict'];
  const trusted = record['trusted'];
  const dreamScore = record['dreamScore'];
  const strategy = record['strategy'];
  const verifierId = record['verifierId'];
  const evidenceHash = record['evidenceHash'];
  if (verdict !== 'passed' && verdict !== 'failed' && verdict !== 'unknown') {
    return undefined;
  }
  if (typeof trusted !== 'boolean') {
    return undefined;
  }
  if (typeof dreamScore !== 'number' || !Number.isFinite(dreamScore)) {
    return undefined;
  }
  // Pinned, never caller-chosen: an attacker cannot invent a strategy string and
  // have the tree treated as the verified-only-selection evidence.
  if (strategy !== DREAM_EVIDENCE_STRATEGY) {
    return undefined;
  }
  if (verifierId !== undefined && (typeof verifierId !== 'string' || verifierId.length === 0)) {
    return undefined;
  }
  if (
    evidenceHash !== undefined &&
    (typeof evidenceHash !== 'string' || evidenceHash.length === 0)
  ) {
    return undefined;
  }
  // rev8 #118: an integrity flag must be a boolean or absent; a truthy string
  // is not a fact.
  const contaminated = record['contaminated'];
  if (contaminated !== undefined && typeof contaminated !== 'boolean') {
    return undefined;
  }
  return {
    verdict,
    trusted,
    dreamScore: Math.min(1, Math.max(0, dreamScore)),
    strategy,
    ...(verifierId === undefined ? {} : { verifierId }),
    ...(evidenceHash === undefined ? {} : { evidenceHash }),
    ...(contaminated === true ? { contaminated: true } : {})
  };
}

/** True when the node carries a TRUSTED, concrete, re-checkable verdict. */
function nodeIsVerified(node: DiscoveryNode, options: VerifiedTreeOptions): boolean {
  if (typeof node.score !== 'number' || !Number.isFinite(node.score)) {
    return false;
  }
  const evidence = dreamEvidenceOf(node);
  if (
    evidence === undefined ||
    evidence.trusted !== true ||
    (evidence.verdict !== 'passed' && evidence.verdict !== 'failed')
  ) {
    return false;
  }
  // rev8 #118: the source execution was withheld as contaminated (answer-key
  // text / sentinel / colliding path). Its score is not evidence, however it
  // was computed.
  if (evidence.contaminated === true) {
    return false;
  }
  // A pre-A4-2 (or hand-forged) boolean-only block is NOT enough: the producer
  // identity and the evidence hash must be present so a reader can re-check the
  // claim against the host producer set.
  if (
    evidence.verifierId === undefined ||
    evidence.verifierId.length === 0 ||
    evidence.evidenceHash === undefined ||
    evidence.evidenceHash.length === 0
  ) {
    return false;
  }
  if (options.trustedProducers !== undefined && !options.trustedProducers.has(evidence.verifierId)) {
    return false;
  }
  return true;
}

/**
 * True when every scored node in the snapshot is trusted-and-verdict-bearing
 * and at least one scored node exists.
 *
 * rev8 #118 addition: a tree snapshot whose own metadata carries a
 * contaminated evidence-integrity mark is excluded entirely, even if its node
 * blocks look verified — the tree-level fact outranks node-level claims.
 */
export function isVerifiedTree(
  tree: DiscoveryTreeSnapshot,
  options: VerifiedTreeOptions = {}
): boolean {
  if (readEvidenceIntegrityMark(tree.metadata)?.contaminated === true) {
    return false;
  }
  const nodes = Object.values(tree.nodes);
  const scored = nodes.filter(
    (node) => typeof node.score === 'number' && Number.isFinite(node.score)
  );
  if (scored.length === 0) {
    return false;
  }
  return scored.every((node) => nodeIsVerified(node, options));
}

/** Count the verified trees in a pool (pure). */
export function countVerifiedTrees(
  trees: readonly DiscoveryTreeSnapshot[],
  options: VerifiedTreeOptions = {}
): number {
  let count = 0;
  for (const tree of trees) {
    if (isVerifiedTree(tree, options)) {
      count += 1;
    }
  }
  return count;
}

/** The gate's verdict plus the exact trees it would hand to replay. */
export interface DreamReadinessAssessment {
  /** True when Dream may run (minimum 0 means the gate is disabled). */
  readonly ready: boolean;
  /** The effective floor (normalized integer >= 0). */
  readonly minimum: number;
  readonly totalTrees: number;
  readonly verifiedTreeCount: number;
  /** Only the verified trees, in pool order. Never the unverified remainder. */
  readonly verifiedTrees: readonly DiscoveryTreeSnapshot[];
  /** Human-readable reason, for the run diagnostic. */
  readonly reason: string;
}

/**
 * Assess whether the retained pool can support a Dream replay.
 *
 * `minimum === 0` disables the gate (the full pool is replayed by the caller)
 * but still REPORTS the verified count, so a test that disables the gate cannot
 * pretend it measured verification. Disabling the GATE does not disable
 * `replayNodeScore`'s dreamEvidence preference; this floor only decides which
 * trees enter replay. Any minimum > 0 requires at least that many fully
 * verified trees.
 */
export function assessDreamReadiness(
  trees: readonly DiscoveryTreeSnapshot[],
  minimum: number = MIN_VERIFIED_TREES_FOR_DREAM,
  options: VerifiedTreeOptions = {}
): DreamReadinessAssessment {
  const normalizedMinimum = normalizeVerifiedTreeMinimum(minimum);
  const verifiedTrees = trees.filter((tree) => isVerifiedTree(tree, options));
  const verifiedTreeCount = verifiedTrees.length;
  const totalTrees = trees.length;
  if (totalTrees === 0) {
    return {
      ready: false,
      minimum: normalizedMinimum,
      totalTrees,
      verifiedTreeCount,
      verifiedTrees,
      reason: 'offline dream skipped: no retained trees'
    };
  }
  if (normalizedMinimum === 0) {
    return {
      ready: true,
      minimum: 0,
      totalTrees,
      verifiedTreeCount,
      verifiedTrees,
      reason:
        'offline dream readiness: verified-tree gate disabled by the assembly (minimum 0); ' +
        String(verifiedTreeCount) +
        ' of ' +
        String(totalTrees) +
        ' tree(s) carry re-checkable evidence (the pool is local-trusted input; no signature)'
    };
  }
  if (verifiedTreeCount < normalizedMinimum) {
    return {
      ready: false,
      minimum: normalizedMinimum,
      totalTrees,
      verifiedTreeCount,
      verifiedTrees,
      reason:
        'offline dream skipped: ' +
        String(verifiedTreeCount) +
        ' verified tree(s) < minimum ' +
        String(normalizedMinimum) +
        '; unverified trees are not replayed (mixed scales are not evidence)'
    };
  }
  return {
    ready: true,
    minimum: normalizedMinimum,
    totalTrees,
    verifiedTreeCount,
    verifiedTrees,
    reason:
      'offline dream readiness: ' +
      String(verifiedTreeCount) +
      ' verified tree(s) >= minimum ' +
      String(normalizedMinimum)
  };
}