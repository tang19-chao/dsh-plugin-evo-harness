/**
 * P5 (docs/reports/p2-p6-remaining-work.md section 6): the offline synthetic-test
 * trust layer `synthesized-tests/v1`.
 *
 * WHAT THIS LAYER IS FOR
 * ----------------------
 * Offline benchmark, development/holdout evaluation and Dreamer candidate
 * evaluation can use tests that a synthetic generator produced. That is useful
 * and dangerous in the same breath: a generated test can be calibrated (it
 * really catches the seeded failure and does not fire on clean code) or it can
 * be a rubber stamp. This layer is the SEPARATE trust boundary for those tests.
 *
 * WHAT IT IS NOT
 * --------------
 *   - It is NOT a learning track. `LEARNING_TRACKS` stays exactly
 *     ['task-quality', 'process']; this layer never adds a track and never
 *     enters the r4 reward or the online trusted quality input.
 *   - It is NOT wired into any production path. The module is inert unless a
 *     caller constructs the layer and explicitly enables it (default OFF).
 *   - It is NOT a sandbox. Execution happens in the same process; the receipts
 *     only bind a verdict to the exact frozen test content, they do not make
 *     the execution environment isolated.
 *
 * THE TWO TRUSTS ARE STRUCTURALLY SEPARATE
 * ----------------------------------------
 *   content trust      did the TEST CONTENT earn trust? (frozen before candidate
 *                      generation, calibrated on labelled cases, provenance not
 *                      baseline-frozen, generator/candidate isolated, holdout
 *                      not leaked into generation)
 *   execution trust    did the host RUNNER execute that exact content and produce
 *                      a receipt? (layer id + recomputed test-set digest + the
 *                      scope's full case list + receipt digest + verdict/check
 *                      consistency)
 *
 * The legal state "execution trusted, content NOT trusted" is expressible by
 * construction (see `ExecutionTrustedContentUntrusted`): a host-verified run of
 * an UNCALIBRATED suite. Collapsing the two into one boolean is the defect this
 * module exists to prevent - "the tests ran correctly" says NOTHING about
 * whether the tests are right.
 *
 * DETERMINISM: every digest is a pure function of canonical JSON bytes; every
 * timestamp is injected; no clock, no randomness, no I/O.
 */

import { createHash } from 'node:crypto';

/** The trust-layer identity. Deliberately NOT a LearningTrack. */
export const SYNTHESIZED_TESTS_LAYER = 'synthesized-tests/v1' as const;
export type SynthesizedTestsLayer = typeof SYNTHESIZED_TESTS_LAYER;

/** Framing tag for the suite digest; bumping it changes every suite digest. */
export const SYNTHETIC_SUITE_FRAMING_VERSION = 'dsh-p5-synthetic-tests-v1' as const;

/** Framing tag for the receipt digest. */
export const SYNTHETIC_RECEIPT_FRAMING_VERSION = 'dsh-p5-synthetic-receipt-v1' as const;

/** Framing tag for the calibration report digest. */
export const SYNTHETIC_CALIBRATION_FRAMING_VERSION = 'dsh-p5-synthetic-calibration-v1' as const;

/** The host-recomputable digest shape: `sha256:<64 lowercase hex>`. */
export const SYNTHETIC_DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

/** Ground-truth labels a calibration case can carry. */
export const SYNTHETIC_TEST_LABELS = ['bug-present', 'bug-absent'] as const;
export type SyntheticTestLabel = (typeof SYNTHETIC_TEST_LABELS)[number];

/**
 * Where a case's expectation came from.
 *
 * `baseline-frozen` is the dangerous one and exists as an explicit, named
 * provenance precisely so it can be DETECTED instead of silently trusted: the
 * expectation was copied from what the baseline happened to do, so the test
 * enshrines the baseline's behaviour (including its mistakes) instead of an
 * independent specification.
 */
export const SYNTHETIC_TEST_SOURCES = ['spec-derived', 'mutation-derived', 'baseline-frozen'] as const;
export type SyntheticTestSource = (typeof SYNTHETIC_TEST_SOURCES)[number];

/** Content-trust states. Only `calibrated` may ever feed a quality decision. */
export const SYNTHETIC_CONTENT_TRUST_STATES = ['uncalibrated', 'calibrated', 'revoked'] as const;
export type SyntheticContentTrust = (typeof SYNTHETIC_CONTENT_TRUST_STATES)[number];

/** Execution-trust states. */
export const SYNTHETIC_EXECUTION_TRUST_STATES = ['unverified', 'host-verified'] as const;
export type SyntheticExecutionTrust = (typeof SYNTHETIC_EXECUTION_TRUST_STATES)[number];

/** v1 is audit-only BY CONSTRUCTION: there is no enforce mode. */
export const SYNTHETIC_AUDIT_ONLY = true as const;
/** The layer never feeds task-quality in v1 (kept as a literal for the gate). */
export const SYNTHETIC_TASK_QUALITY_ELIGIBLE = false as const;

/** Bounded reason vocabulary (rejections and audit reasons only). */
export const SYNTHETIC_TEST_REASON_CODES = [
  'layer-mismatch',
  'malformed-suite',
  'duplicate-case-id',
  'unknown-label',
  'unknown-source',
  'malformed-digest',
  'digest-mismatch',
  'not-frozen-before-candidates',
  'candidate-authored-case',
  'same-generator',
  'receipt-digest-mismatch',
  'receipt-test-set-mismatch',
  'receipt-case-set-mismatch',
  'receipt-verdict-contradiction',
  'calibration-missing',
  'calibration-set-mismatch',
  'calibration-incomplete',
  'insufficient-labeled-cases',
  'no-failure-labels',
  'no-clean-labels',
  'calibration-threshold-failed',
  'baseline-frozen-case',
  'all-cases-baseline-frozen',
  'holdout-leak',
  'content-uncalibrated',
  'content-revoked',
  'execution-unverified',
  'audit-only-v1',
  'grant-invalid',
  'mode-not-audit-only',
  'already-enabled',
  'disabled'
] as const;
export type SyntheticTestReasonCode = (typeof SYNTHETIC_TEST_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// canonical JSON + digests
// ---------------------------------------------------------------------------

/**
 * Stable JSON: object keys sorted, arrays keep their order, undefined -> null.
 * Two structurally equal values always produce the same bytes, so a digest over
 * them is reproducible by any host.
 */
export function canonicalJson(value: unknown): string {
  const encode = (entry: unknown): string => {
    if (entry === undefined || entry === null) return 'null';
    if (typeof entry === 'string') return JSON.stringify(entry);
    if (typeof entry === 'boolean') return entry ? 'true' : 'false';
    if (typeof entry === 'number') return Number.isFinite(entry) ? String(entry) : JSON.stringify(String(entry));
    if (Array.isArray(entry)) return '[' + entry.map(encode).join(',') + ']';
    if (typeof entry === 'object') {
      const source = entry as Record<string, unknown>;
      return (
        '{' +
        Object.keys(source)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + encode(source[key]))
          .join(',') +
        '}'
      );
    }
    return JSON.stringify(String(entry));
  };
  return encode(value);
}

/** `sha256:<64 hex>` over the framed canonical bytes. */
export function syntheticDigest(framing: string, value: unknown): string {
  const json = canonicalJson(value);
  const framed = framing + ':' + String(Buffer.byteLength(json, 'utf8')) + ':' + json;
  return 'sha256:' + createHash('sha256').update(framed, 'utf8').digest('hex');
}

/** True when the value is a well-formed `sha256:<64 hex>` digest. */
export function isSyntheticDigest(value: unknown): value is string {
  return typeof value === 'string' && SYNTHETIC_DIGEST_SHAPE.test(value);
}

// ---------------------------------------------------------------------------
// suite model
// ---------------------------------------------------------------------------

/**
 * The baseline observation a `baseline-frozen` case was derived from.
 *
 * The ci-04|2|2 shape (docs/reports/p61-eval-negative-result-explanation.md) is
 * the canonical example: the baseline chose `noop` with support 0 and its
 * coverage dropped from 1.000 (prior) to 0.667 (observed). A test frozen from
 * THAT behaviour would enshrine the harmful choice.
 */
export interface BaselineObservation {
  readonly taskId: string;
  readonly run: number;
  readonly round: number;
  readonly actionKey: string;
  readonly support: number;
  readonly advantage: number;
  readonly observedCoverage: number;
  readonly priorCoverage: number;
}

/** One synthetic test case. */
export interface SyntheticTestCase {
  readonly id: string;
  /** Ground truth for calibration: `bug-present` cases SHOULD fail. */
  readonly label: SyntheticTestLabel;
  readonly source: SyntheticTestSource;
  /** `sha256:<64hex>` of the artifact the expectation was derived from. */
  readonly sourceDigest: string;
  readonly expectation: {
    /** What the host runner is expected to say on a correct implementation. */
    readonly kind: 'fails' | 'passes';
    readonly detail: string;
  };
  /** Set iff a CANDIDATE authored this test (isolation violation, detectable). */
  readonly generatedFromCandidateId?: string;
  /** Required iff `source === 'baseline-frozen'`; forbidden otherwise. */
  readonly baselineObservation?: BaselineObservation;
}

/** The draft a caller freezes. */
export interface SyntheticTestSuiteDraft {
  readonly suiteId: string;
  readonly version: string;
  readonly generator: { readonly id: string; readonly version: string };
  /** Source artifacts the suite was derived from (test-set provenance). */
  readonly sourceArtifacts: readonly { readonly path: string; readonly digest: string }[];
  readonly cases: readonly SyntheticTestCase[];
  /**
   * Pre-registered development/holdout split over case ids. Holdout ids may
   * never appear in any candidate-generation artifact (firewall below).
   */
  readonly split?: {
    readonly development: readonly string[];
    readonly holdout: readonly string[];
  };
}

/** A suite sealed at a specific instant. */
export interface FrozenSyntheticTestSuite {
  readonly layer: SynthesizedTestsLayer;
  readonly suiteId: string;
  readonly version: string;
  readonly generator: { readonly id: string; readonly version: string };
  readonly sourceArtifacts: readonly { readonly path: string; readonly digest: string }[];
  readonly cases: readonly SyntheticTestCase[];
  readonly split?: {
    readonly development: readonly string[];
    readonly holdout: readonly string[];
  };
  /** Digest of the CONTENT only (no timestamp). */
  readonly contentDigest: string;
  /** The freeze seal: digest of (contentDigest + frozenAt + layer). */
  readonly testSetDigest: string;
  /** Injected freeze instant (ms). Part of the seal, so re-dating breaks it. */
  readonly frozenAt: number;
  /** Per-case content digests (auditable case identity). */
  readonly caseDigests: Readonly<Record<string, string>>;
  /** Cases whose expectation was copied from baseline behaviour. */
  readonly baselineFrozenCaseIds: readonly string[];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('synthesized-tests: ' + field + ' must be a non-empty string');
  }
  return value;
}

function validateCase(raw: SyntheticTestCase): SyntheticTestCase {
  const id = requireNonEmptyString(raw.id, 'case.id');
  if (!(SYNTHETIC_TEST_LABELS as readonly string[]).includes(raw.label)) {
    throw new TypeError('synthesized-tests: case ' + id + ' has unknown label ' + String(raw.label));
  }
  if (!(SYNTHETIC_TEST_SOURCES as readonly string[]).includes(raw.source)) {
    throw new TypeError('synthesized-tests: case ' + id + ' has unknown source ' + String(raw.source));
  }
  if (!isSyntheticDigest(raw.sourceDigest)) {
    throw new TypeError('synthesized-tests: case ' + id + ' sourceDigest must be sha256:<64 hex>');
  }
  if (raw.expectation === undefined || (raw.expectation.kind !== 'fails' && raw.expectation.kind !== 'passes')) {
    throw new TypeError('synthesized-tests: case ' + id + ' needs expectation.kind fails|passes');
  }
  requireNonEmptyString(raw.expectation.detail, 'case.expectation.detail');
  if (raw.source === 'baseline-frozen') {
    const observation = raw.baselineObservation;
    if (observation === undefined) {
      throw new TypeError('synthesized-tests: baseline-frozen case ' + id + ' needs a baselineObservation');
    }
    requireNonEmptyString(observation.taskId, 'case.baselineObservation.taskId');
    requireNonEmptyString(observation.actionKey, 'case.baselineObservation.actionKey');
  } else if (raw.baselineObservation !== undefined) {
    throw new TypeError(
      'synthesized-tests: case ' + id + ' carries a baselineObservation but its source is ' + raw.source
    );
  }
  return raw;
}

/** Content digest of one case (identity of the case's content). */
export function computeSyntheticCaseDigest(raw: SyntheticTestCase): string {
  return syntheticDigest(SYNTHETIC_SUITE_FRAMING_VERSION + '/case', validateCase(raw));
}

/** Canonical content of a suite (no timestamp, cases sorted by id). */
function suiteContentOf(draft: SyntheticTestSuiteDraft): Record<string, unknown> {
  const cases = [...draft.cases].map(validateCase).sort((left, right) => (left.id < right.id ? -1 : 1));
  return {
    layer: SYNTHESIZED_TESTS_LAYER,
    suiteId: draft.suiteId,
    version: draft.version,
    generator: { id: draft.generator.id, version: draft.generator.version },
    sourceArtifacts: [...draft.sourceArtifacts]
      .map((entry) => ({ path: entry.path, digest: entry.digest }))
      .sort((left, right) => (left.path < right.path ? -1 : 1)),
    cases,
    split:
      draft.split === undefined
        ? null
        : {
            development: [...draft.split.development].sort(),
            holdout: [...draft.split.holdout].sort()
          }
  };
}

/** Digest of the suite CONTENT only. */
export function computeSyntheticSuiteContentDigest(draft: SyntheticTestSuiteDraft): string {
  return syntheticDigest(SYNTHETIC_SUITE_FRAMING_VERSION + '/content', suiteContentOf(draft));
}

/** The freeze seal: content digest + freeze instant + layer. */
export function computeSyntheticTestSetDigest(contentDigest: string, frozenAt: number): string {
  if (!isSyntheticDigest(contentDigest)) {
    throw new TypeError('synthesized-tests: contentDigest must be sha256:<64 hex>');
  }
  if (!Number.isFinite(frozenAt)) {
    throw new TypeError('synthesized-tests: frozenAt must be finite');
  }
  return syntheticDigest(SYNTHETIC_SUITE_FRAMING_VERSION + '/seal', {
    layer: SYNTHESIZED_TESTS_LAYER,
    contentDigest,
    frozenAt
  });
}

/**
 * Freeze a suite BEFORE any candidate exists.
 *
 * Validation is fail-closed: duplicate ids, unknown labels/sources, malformed
 * digests, a missing baseline observation on a baseline-frozen case, or a
 * baseline observation on any other source all throw. The split must cover
 * exactly the case set, disjointly, with a non-empty development side.
 */
export function freezeSyntheticTestSuite(
  draft: SyntheticTestSuiteDraft,
  options: { readonly now: number }
): FrozenSyntheticTestSuite {
  requireNonEmptyString(draft.suiteId, 'suiteId');
  requireNonEmptyString(draft.version, 'version');
  requireNonEmptyString(draft.generator?.id, 'generator.id');
  requireNonEmptyString(draft.generator?.version, 'generator.version');
  if (!Number.isFinite(options?.now)) {
    throw new TypeError('synthesized-tests: freeze requires a finite now');
  }
  if (!Array.isArray(draft.cases) || draft.cases.length === 0) {
    throw new TypeError('synthesized-tests: a suite needs at least one case');
  }
  const ids = new Set<string>();
  const caseDigests: Record<string, string> = {};
  for (const raw of draft.cases) {
    const entry = validateCase(raw);
    if (ids.has(entry.id)) {
      throw new TypeError('synthesized-tests: duplicate case id ' + entry.id);
    }
    ids.add(entry.id);
    caseDigests[entry.id] = computeSyntheticCaseDigest(entry);
  }
  for (const artifact of draft.sourceArtifacts) {
    requireNonEmptyString(artifact.path, 'sourceArtifacts.path');
    if (!isSyntheticDigest(artifact.digest)) {
      throw new TypeError('synthesized-tests: sourceArtifacts[' + artifact.path + '] digest must be sha256:<64 hex>');
    }
  }
  if (draft.split !== undefined) {
    const development = new Set(draft.split.development);
    const holdout = new Set(draft.split.holdout);
    if (development.size === 0) {
      throw new TypeError('synthesized-tests: the development split must not be empty');
    }
    for (const id of development) {
      if (!ids.has(id)) throw new TypeError('synthesized-tests: split names unknown case ' + id);
      if (holdout.has(id)) throw new TypeError('synthesized-tests: case ' + id + ' is on both sides of the split');
    }
    for (const id of holdout) {
      if (!ids.has(id)) throw new TypeError('synthesized-tests: split names unknown case ' + id);
    }
    if (development.size + holdout.size !== ids.size) {
      throw new TypeError('synthesized-tests: the split must cover every case exactly once');
    }
  }
  const contentDigest = computeSyntheticSuiteContentDigest(draft);
  const frozenAt = Math.floor(options.now);
  const testSetDigest = computeSyntheticTestSetDigest(contentDigest, frozenAt);
  const baselineFrozenCaseIds = draft.cases
    .filter((entry) => entry.source === 'baseline-frozen')
    .map((entry) => entry.id)
    .sort();
  return {
    layer: SYNTHESIZED_TESTS_LAYER,
    suiteId: draft.suiteId,
    version: draft.version,
    generator: { id: draft.generator.id, version: draft.generator.version },
    sourceArtifacts: draft.sourceArtifacts.map((entry) => ({ path: entry.path, digest: entry.digest })),
    cases: draft.cases.map((entry) => ({ ...entry })),
    ...(draft.split === undefined
      ? {}
      : {
          split: {
            development: [...draft.split.development],
            holdout: [...draft.split.holdout]
          }
        }),
    contentDigest,
    testSetDigest,
    frozenAt,
    caseDigests,
    baselineFrozenCaseIds
  };
}

/**
 * Recompute the seal of a persisted frozen suite. Returns the recomputed digest
 * pair; a mismatch with the suite's declared digests is `digest-mismatch`.
 */
export function recomputeFrozenSuiteDigests(suite: FrozenSyntheticTestSuite): {
  readonly contentDigest: string;
  readonly testSetDigest: string;
} {
  const contentDigest = computeSyntheticSuiteContentDigest(suite);
  return { contentDigest, testSetDigest: computeSyntheticTestSetDigest(contentDigest, suite.frozenAt) };
}

/** Verify a frozen suite: layer, digest recomputation, case digests, split. */
export function verifyFrozenSyntheticSuite(suite: FrozenSyntheticTestSuite): {
  readonly ok: boolean;
  readonly violations: readonly { readonly kind: SyntheticTestReasonCode; readonly detail: string }[];
} {
  const violations: { kind: SyntheticTestReasonCode; detail: string }[] = [];
  if (suite?.layer !== SYNTHESIZED_TESTS_LAYER) {
    violations.push({ kind: 'layer-mismatch', detail: 'suite layer ' + String(suite?.layer) });
    return { ok: false, violations };
  }
  try {
    const recomputed = recomputeFrozenSuiteDigests(suite);
    if (recomputed.contentDigest !== suite.contentDigest) {
      violations.push({ kind: 'digest-mismatch', detail: 'contentDigest ' + suite.contentDigest });
    }
    if (recomputed.testSetDigest !== suite.testSetDigest) {
      violations.push({ kind: 'digest-mismatch', detail: 'testSetDigest ' + suite.testSetDigest });
    }
  } catch (error) {
    violations.push({ kind: 'malformed-suite', detail: String(error instanceof Error ? error.message : error) });
  }
  for (const entry of suite.cases ?? []) {
    const expected = suite.caseDigests?.[entry.id];
    if (expected === undefined || expected !== computeSyntheticCaseDigest(entry)) {
      violations.push({ kind: 'digest-mismatch', detail: 'case ' + entry.id });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// candidate identity, freeze order and generator/candidate isolation
// ---------------------------------------------------------------------------

/** The identity of a candidate under evaluation. */
export interface SyntheticCandidateIdentity {
  readonly id: string;
  /** The entity that generated the candidate (model / script id). */
  readonly generatorId: string;
  /** Candidate creation instant (ms), for the freeze-order check. */
  readonly createdAt: number;
}

/** One freeze-order / isolation violation. */
export interface SyntheticIsolationViolation {
  readonly kind: SyntheticTestReasonCode;
  readonly detail: string;
}

/**
 * "Test content frozen BEFORE any candidate was generated."
 *
 * Two independent facts are checked:
 *   1. every candidate under evaluation was created AFTER the freeze seal
 *      (a suite frozen after a candidate exists may have been fitted to it);
 *   2. no case declares generatedFromCandidateId at all - a test authored BY
 *      a candidate can never judge that candidate, regardless of timing.
 */
export function assertFrozenBeforeCandidateGeneration(
  suite: FrozenSyntheticTestSuite,
  candidates: readonly SyntheticCandidateIdentity[]
): { readonly ok: boolean; readonly violations: readonly SyntheticIsolationViolation[] } {
  const violations: SyntheticIsolationViolation[] = [];
  const candidateIds = new Set(candidates.map((entry) => entry.id));
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.createdAt) || candidate.createdAt < suite.frozenAt) {
      violations.push({
        kind: 'not-frozen-before-candidates',
        detail:
          candidate.id +
          ' createdAt ' +
          String(candidate.createdAt) +
          (Number.isFinite(candidate.createdAt)
            ? ' < frozenAt ' + String(suite.frozenAt)
            : ' is not finite; it cannot be ordered against the freeze seal')
      });
    }
  }
  for (const entry of suite.cases) {
    if (entry.generatedFromCandidateId !== undefined && candidateIds.has(entry.generatedFromCandidateId)) {
      violations.push({
        kind: 'candidate-authored-case',
        detail: entry.id + ' was generated from candidate ' + entry.generatedFromCandidateId
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Generator/candidate isolation: the suite generator must not BE the candidate's
 * generator, and no case may have been authored by the candidate.
 *
 * Rationale: if the same generator produces both the tests and the candidate,
 * the candidate can trivially satisfy tests written to its own behaviour; the
 * calibration numbers would then measure self-consistency, not correctness.
 */
export function checkGeneratorCandidateIsolation(
  suite: FrozenSyntheticTestSuite,
  candidate: SyntheticCandidateIdentity
): { readonly isolated: boolean; readonly reason?: SyntheticTestReasonCode; readonly detail?: string } {
  if (suite.generator.id === candidate.generatorId) {
    return {
      isolated: false,
      reason: 'same-generator',
      detail:
        'suite generator ' + suite.generator.id + ' === candidate generator ' + candidate.generatorId
    };
  }
  const authored = suite.cases.find((entry) => entry.generatedFromCandidateId === candidate.id);
  if (authored !== undefined) {
    return { isolated: false, reason: 'candidate-authored-case', detail: 'case ' + authored.id };
  }
  return { isolated: true };
}

// ---------------------------------------------------------------------------
// holdout firewall (same discipline as P2-C: permanent fixtures, fail-closed)
// ---------------------------------------------------------------------------

/**
 * No holdout case id may appear in any artifact that fed candidate generation.
 *
 * The check is deliberately textual over the provided artifact contents: the
 * artifacts are JSON/JSONL/text produced before evaluation, and an id appearing
 * there means the holdout was visible to whatever produced the candidates.
 */
export function checkSyntheticHoldoutFirewall(
  suite: FrozenSyntheticTestSuite,
  artifacts: readonly { readonly path: string; readonly content: string }[]
): {
  readonly ok: boolean;
  readonly violations: readonly SyntheticIsolationViolation[];
  readonly checkedArtifacts: readonly string[];
} {
  const violations: SyntheticIsolationViolation[] = [];
  const holdout = suite.split?.holdout ?? [];
  for (const artifact of artifacts) {
    for (const id of holdout) {
      if (artifact.content.includes(id)) {
        violations.push({ kind: 'holdout-leak', detail: artifact.path + ':' + id });
      }
    }
  }
  return { ok: violations.length === 0, violations, checkedArtifacts: artifacts.map((entry) => entry.path) };
}

// ---------------------------------------------------------------------------
// host execution receipt
// ---------------------------------------------------------------------------

/** The scope a receipt covers; the case list must match the frozen split exactly. */
export const SYNTHETIC_RECEIPT_SCOPES = ['development', 'holdout', 'full'] as const;
export type SyntheticReceiptScope = (typeof SYNTHETIC_RECEIPT_SCOPES)[number];

/** One executed case's outcome. */
export interface SyntheticCaseResult {
  readonly caseId: string;
  readonly status: 'passed' | 'failed';
  readonly checks: readonly { readonly id: string; readonly passed: boolean }[];
}

/**
 * A host-runner receipt: EXECUTION evidence only. It binds the run to the exact
 * frozen test-set digest and to the scope's complete case list; it says nothing
 * about whether the test CONTENT is calibrated.
 */
export interface SyntheticTestReceipt {
  readonly layer: SynthesizedTestsLayer;
  readonly testSetDigest: string;
  readonly scope: SyntheticReceiptScope;
  readonly caseIds: readonly string[];
  readonly runId: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly executedAt: number;
  readonly status: 'passed' | 'failed';
  readonly results: readonly SyntheticCaseResult[];
  readonly receiptDigest: string;
}

/** Canonical receipt content (receiptDigest is the seal and is excluded). */
function receiptContentOf(receipt: Omit<SyntheticTestReceipt, 'receiptDigest'>): Record<string, unknown> {
  return {
    layer: receipt.layer,
    testSetDigest: receipt.testSetDigest,
    scope: receipt.scope,
    caseIds: [...receipt.caseIds],
    runId: receipt.runId,
    verifierId: receipt.verifierId,
    verifierVersion: receipt.verifierVersion,
    executedAt: receipt.executedAt,
    status: receipt.status,
    results: [...receipt.results].sort((left, right) => (left.caseId < right.caseId ? -1 : 1))
  };
}

/** Compute the receipt seal. */
export function computeSyntheticReceiptDigest(
  receipt: Omit<SyntheticTestReceipt, 'receiptDigest'>
): string {
  return syntheticDigest(SYNTHETIC_RECEIPT_FRAMING_VERSION, receiptContentOf(receipt));
}

/** The frozen case ids a scope is allowed to execute. */
function scopeCaseIds(suite: FrozenSyntheticTestSuite, scope: SyntheticReceiptScope): readonly string[] {
  const all = suite.cases.map((entry) => entry.id).sort();
  if (scope === 'full') return all;
  if (suite.split === undefined) return all;
  return [...(scope === 'development' ? suite.split.development : suite.split.holdout)].sort();
}

/**
 * Verify a receipt against the frozen suite: layer, recomputed seal, exact
 * test-set digest, exactly the scope's case list (no cherry-picking, no extra
 * cases), one result per case, and verdict/check consistency.
 */
export function verifySyntheticTestReceipt(
  receipt: SyntheticTestReceipt,
  suite: FrozenSyntheticTestSuite
): { readonly ok: boolean; readonly violations: readonly SyntheticIsolationViolation[] } {
  const violations: SyntheticIsolationViolation[] = [];
  try {
    if (receipt?.layer !== SYNTHESIZED_TESTS_LAYER) {
      violations.push({ kind: 'layer-mismatch', detail: 'receipt layer ' + String(receipt?.layer) });
      return { ok: false, violations };
    }
    if (receipt.testSetDigest !== suite.testSetDigest) {
      violations.push({ kind: 'receipt-test-set-mismatch', detail: String(receipt.testSetDigest) });
    }
    if (receipt.receiptDigest !== computeSyntheticReceiptDigest(receipt)) {
      violations.push({ kind: 'receipt-digest-mismatch', detail: String(receipt.receiptDigest) });
    }
    const expected = scopeCaseIds(suite, receipt.scope);
    const declared = [...receipt.caseIds].sort();
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      violations.push({
        kind: 'receipt-case-set-mismatch',
        detail: 'scope ' + receipt.scope + ' expected ' + String(expected.length) + ' cases'
      });
    }
    const resultIds = receipt.results.map((entry) => entry.caseId).sort();
    if (JSON.stringify(resultIds) !== JSON.stringify(declared)) {
      violations.push({
        kind: 'receipt-case-set-mismatch',
        detail: 'results do not cover the declared cases'
      });
    }
    for (const result of receipt.results) {
      const checksPassed = result.checks.length > 0 && result.checks.every((check) => check.passed);
      if (result.status === 'passed' && !checksPassed) {
        violations.push({
          kind: 'receipt-verdict-contradiction',
          detail: result.caseId + ' passed with a failed check'
        });
      }
      if (result.status === 'failed' && checksPassed) {
        violations.push({
          kind: 'receipt-verdict-contradiction',
          detail: result.caseId + ' failed with all checks passing'
        });
      }
    }
    const anyFailed = receipt.results.some((entry) => entry.status === 'failed');
    if (receipt.status === 'passed' && anyFailed) {
      violations.push({
        kind: 'receipt-verdict-contradiction',
        detail: 'receipt says passed but a case failed'
      });
    }
    if (receipt.status === 'failed' && !anyFailed) {
      violations.push({
        kind: 'receipt-verdict-contradiction',
        detail: 'receipt says failed but no case failed'
      });
    }
  } catch (error) {
    violations.push({
      kind: 'malformed-suite',
      detail: String(error instanceof Error ? error.message : error)
    });
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// baseline-frozen diagnosis (the ci-04|2|2 property diagnostic)
// ---------------------------------------------------------------------------

/** Diagnosis of one case w.r.t. "is this test a frozen copy of baseline behaviour?" */
export interface BaselineFrozenDiagnosis {
  readonly caseId: string;
  readonly frozen: boolean;
  /** 'not-baseline-frozen' when the case's source is not baseline behaviour. */
  readonly reason: 'baseline-frozen-test' | 'not-baseline-frozen';
  /** The baseline action the expectation enshrines (frozen cases only). */
  readonly frozenActionKey: string | null;
  /** True when the frozen expectation would fail any deviation from the frozen action. */
  readonly wouldRejectDeviations: boolean | null;
  /** A frozen test cannot discriminate an improvement: it is a rubber stamp. */
  readonly discriminating: boolean | null;
  /**
   * True when the frozen behaviour itself was HARMFUL (observed coverage strictly
   * below the prior's coverage). Freezing THIS is the worst case: the test would
   * fail every candidate that repairs the baseline's mistake.
   */
  readonly freezesHarmfulBaseline: boolean;
  readonly evidence: BaselineObservation | null;
}

/**
 * Diagnose one case.
 *
 * The historical anchor is the first harmful deviation of the offline negative
 * result: at the decision point (task ci-04, run 2, round 2) the baseline chose
 * `noop` with support 0 and its coverage fell from 1.000 (prior) to 0.667
 * (docs/reports/p61-eval-negative-result-explanation.md, firstHarmfulDeviation).
 * A synthetic test copied from THAT observation would enshrine the noop and
 * would fail every candidate that repairs it - which is exactly the "wrongly
 * frozen baseline" failure mode this layer exists to detect.
 *
 * NOTE (reporting honesty): the case EXISTS. This layer must never claim the
 * ci-04|2|2 case "does not exist"; it exists in the historical evidence, and the
 * diagnostic's job is to keep such a frozen test OUT of the trusted set.
 */
export function diagnoseBaselineFrozenCase(raw: SyntheticTestCase): BaselineFrozenDiagnosis {
  if (raw.source !== 'baseline-frozen' || raw.baselineObservation === undefined) {
    return {
      caseId: raw.id,
      frozen: false,
      reason: 'not-baseline-frozen',
      frozenActionKey: null,
      wouldRejectDeviations: null,
      discriminating: null,
      freezesHarmfulBaseline: false,
      evidence: null
    };
  }
  const observation = raw.baselineObservation;
  const harmful = observation.observedCoverage < observation.priorCoverage - 1e-9;
  return {
    caseId: raw.id,
    frozen: true,
    reason: 'baseline-frozen-test',
    frozenActionKey: observation.actionKey,
    wouldRejectDeviations: true,
    discriminating: false,
    freezesHarmfulBaseline: harmful,
    evidence: observation
  };
}

/** Suite-level baseline-frozen diagnosis. */
export function diagnoseBaselineFrozenCases(suite: FrozenSyntheticTestSuite): {
  readonly frozen: readonly BaselineFrozenDiagnosis[];
  readonly harmfulCount: number;
  readonly excludedFromCalibrationCaseIds: readonly string[];
} {
  const frozen = suite.cases.map((entry) => diagnoseBaselineFrozenCase(entry)).filter((entry) => entry.frozen);
  return {
    frozen,
    harmfulCount: frozen.filter((entry) => entry.freezesHarmfulBaseline).length,
    excludedFromCalibrationCaseIds: frozen.map((entry) => entry.caseId).sort()
  };
}

// ---------------------------------------------------------------------------
// calibration (confusion matrix, denominators, labels, pre-set thresholds)
// ---------------------------------------------------------------------------

/**
 * Pre-registered calibration thresholds. They are constants of the LAYER
 * (registered before any data), not per-run tuning knobs.
 */
export const DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS = Object.freeze({
  /** Fewer labelled cases than this cannot support any recall claim. */
  minLabeledCases: 8,
  /** failure-recall = TP / (TP + FN), must reach this floor. */
  minFailureRecall: 0.8,
  /** false-positive-rate = FP / (FP + TN), must stay at or below this. */
  maxFalsePositiveRate: 0.1,
  /** misjudgment-rate = (FP + FN) / N over all labelled cases. */
  maxMisjudgmentRate: 0.2
});
export type SyntheticCalibrationThresholds = typeof DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS;

/** One host-observed outcome for a labelled case. */
export interface SyntheticCaseRunResult {
  readonly caseId: string;
  readonly outcome: 'passed' | 'failed';
}

/** One computed calibration metric, with its OWN denominator and label. */
export interface SyntheticCalibrationMetric {
  readonly id: string;
  /** The repo's own label (NOT a paper term): what this number is called here. */
  readonly label: string;
  /** The formula, spelled out. */
  readonly formula: string;
  readonly numerator: number;
  readonly denominator: number;
  /** What one unit of the denominator IS (the required explicit denominator). */
  readonly denominatorUnit: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly comparison: 'min' | 'max' | null;
  readonly status: 'pass' | 'fail' | 'not-computable';
}

export interface SyntheticCalibrationReport {
  readonly layer: SynthesizedTestsLayer;
  readonly testSetDigest: string;
  readonly reportDigest: string;
  readonly thresholds: SyntheticCalibrationThresholds;
  readonly population: {
    readonly labeledCases: number;
    readonly bugPresentCases: number;
    readonly bugAbsentCases: number;
    /** baseline-frozen cases are counted but never enter the denominators. */
    readonly excludedBaselineFrozenCaseIds: readonly string[];
    /** holdout cases are counted but never enter the calibration denominators. */
    readonly excludedHoldoutCaseIds: readonly string[];
  };
  readonly confusion: {
    /** bug-present labelled case, host verdict failed: the failure was caught. */
    readonly tp: number;
    /** bug-present labelled case, host verdict passed: the failure was MISSED. */
    readonly fn: number;
    /** bug-absent labelled case, host verdict failed: false alarm. */
    readonly fp: number;
    /** bug-absent labelled case, host verdict passed. */
    readonly tn: number;
  };
  readonly metrics: readonly SyntheticCalibrationMetric[];
  readonly verdict: 'calibrated' | 'uncalibrated' | 'failed';
  readonly reasons: readonly SyntheticTestReasonCode[];
  readonly definedAt: number;
}

export interface SyntheticCalibrationInput {
  readonly suite: FrozenSyntheticTestSuite;
  readonly results: readonly SyntheticCaseRunResult[];
  readonly thresholds?: Partial<SyntheticCalibrationThresholds>;
  readonly now: number;
}

/**
 * Calibrate a frozen suite.
 *
 * DENOMINATORS (this repo's own definitions, no paper imports):
 *   - failure-recall        denominator = labelled bug-present CASES (TP + FN);
 *   - false-positive-rate   denominator = labelled bug-absent CASES (FP + TN);
 *   - misjudgment-rate      denominator = ALL labelled cases in the calibration
 *                           run (TP + FN + FP + TN), misjudgment = any wrong
 *                           verdict in either direction.
 * baseline-frozen cases are EXCLUDED from every denominator and counted
 * separately: a test whose expectation was copied from baseline behaviour
 * cannot calibrate anything (it would pass the baseline by construction).
 * HOLDOUT cases are likewise excluded: calibrating on holdout would turn the
 * final check into a tuning set (the P2-C rule, applied to this layer).
 */
export function calibrateSyntheticTestSuite(input: SyntheticCalibrationInput): SyntheticCalibrationReport {
  const suite = input.suite;
  if (suite?.layer !== SYNTHESIZED_TESTS_LAYER) {
    throw new TypeError('synthesized-tests: calibrate requires a synthesized-tests/v1 suite');
  }
  if (!Number.isFinite(input.now)) {
    throw new TypeError('synthesized-tests: calibrate requires a finite now');
  }
  const thresholds: SyntheticCalibrationThresholds = {
    ...DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS,
    ...(input.thresholds ?? {})
  };
  const diagnoses = diagnoseBaselineFrozenCases(suite);
  const excluded = new Set(diagnoses.excludedFromCalibrationCaseIds);
  const holdout = new Set(suite.split?.holdout ?? []);

  const byId = new Map<string, SyntheticCaseRunResult>();
  for (const result of input.results) {
    if (byId.has(result.caseId)) {
      throw new TypeError('synthesized-tests: duplicate run result for case ' + result.caseId);
    }
    byId.set(result.caseId, result);
  }
  const unknownResults = input.results
    .filter((result) => !suite.cases.some((entry) => entry.id === result.caseId))
    .map((result) => result.caseId);
  if (unknownResults.length > 0) {
    throw new TypeError('synthesized-tests: run results reference unknown cases: ' + unknownResults.join(', '));
  }

  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  const missing: string[] = [];
  for (const entry of suite.cases) {
    if (excluded.has(entry.id) || holdout.has(entry.id)) continue;
    const result = byId.get(entry.id);
    if (result === undefined) {
      missing.push(entry.id);
      continue;
    }
    if (entry.label === 'bug-present') {
      if (result.outcome === 'failed') tp += 1;
      else fn += 1;
    } else {
      if (result.outcome === 'failed') fp += 1;
      else tn += 1;
    }
  }

  const bugPresent = tp + fn;
  const bugAbsent = fp + tn;
  const labeled = bugPresent + bugAbsent;

  const reasons: SyntheticTestReasonCode[] = [];
  let verdict: SyntheticCalibrationReport['verdict'] = 'calibrated';
  if (missing.length > 0) {
    verdict = 'uncalibrated';
    reasons.push('calibration-incomplete');
  }
  if (labeled < thresholds.minLabeledCases) {
    verdict = 'uncalibrated';
    reasons.push('insufficient-labeled-cases');
  }
  if (bugPresent === 0 && labeled > 0) {
    verdict = 'uncalibrated';
    reasons.push('no-failure-labels');
  }
  if (bugAbsent === 0 && labeled > 0) {
    verdict = 'uncalibrated';
    reasons.push('no-clean-labels');
  }

  const build = (
    id: string,
    label: string,
    formula: string,
    numerator: number,
    denominator: number,
    denominatorUnit: string,
    threshold: number | null,
    comparison: 'min' | 'max' | null
  ): SyntheticCalibrationMetric => {
    const computable = denominator > 0 && missing.length === 0;
    const value = computable ? Math.round((numerator / denominator) * 1e6) / 1e6 : null;
    let status: SyntheticCalibrationMetric['status'] = computable ? 'pass' : 'not-computable';
    if (value !== null && threshold !== null && comparison !== null) {
      if (comparison === 'min' && value < threshold) status = 'fail';
      if (comparison === 'max' && value > threshold) status = 'fail';
    }
    return { id, label, formula, numerator, denominator, denominatorUnit, value, threshold, comparison, status };
  };

  const metrics: SyntheticCalibrationMetric[] = [
    build(
      'failure-recall',
      'case-level-failure-recall (seeded-bug catch rate)',
      'TP / (TP + FN) over labelled bug-present cases',
      tp,
      bugPresent,
      'labelled bug-present cases',
      thresholds.minFailureRecall,
      'min'
    ),
    build(
      'false-positive-rate',
      'case-level-false-positive-rate (false alarm rate on clean cases)',
      'FP / (FP + TN) over labelled bug-absent cases',
      fp,
      bugAbsent,
      'labelled bug-absent cases',
      thresholds.maxFalsePositiveRate,
      'max'
    ),
    build(
      'misjudgment-rate',
      'case-level-misjudgment-rate (any wrong verdict, either direction)',
      '(FP + FN) / (TP + FN + FP + TN) over all labelled cases in the calibration run',
      fp + fn,
      labeled,
      'all labelled cases in the calibration run',
      thresholds.maxMisjudgmentRate,
      'max'
    ),
    build(
      'failure-miss-rate',
      'case-level-failure-miss-rate (informational counterpart of recall)',
      'FN / (TP + FN) over labelled bug-present cases',
      fn,
      bugPresent,
      'labelled bug-present cases',
      null,
      null
    )
  ];

  if (verdict === 'calibrated' && metrics.some((metric) => metric.status === 'fail')) {
    verdict = 'failed';
    reasons.push('calibration-threshold-failed');
  }

  const report: Omit<SyntheticCalibrationReport, 'reportDigest'> = {
    layer: SYNTHESIZED_TESTS_LAYER,
    testSetDigest: suite.testSetDigest,
    thresholds,
    population: {
      labeledCases: labeled,
      bugPresentCases: bugPresent,
      bugAbsentCases: bugAbsent,
      excludedBaselineFrozenCaseIds: diagnoses.excludedFromCalibrationCaseIds,
      excludedHoldoutCaseIds: [...holdout].sort()
    },
    confusion: { tp, fn, fp, tn },
    metrics,
    verdict,
    reasons,
    definedAt: Math.floor(input.now)
  };
  return { ...report, reportDigest: syntheticDigest(SYNTHETIC_CALIBRATION_FRAMING_VERSION, report) };
}

// ---------------------------------------------------------------------------
// assessment: the two trusts, side by side, never collapsed
// ---------------------------------------------------------------------------

export interface SyntheticContentAssessment {
  readonly trust: SyntheticContentTrust;
  readonly layer: SynthesizedTestsLayer;
  readonly testSetDigest: string;
  readonly calibrationReportDigest?: string;
  readonly reasons: readonly SyntheticTestReasonCode[];
}

export interface SyntheticExecutionAssessment {
  readonly trust: SyntheticExecutionTrust;
  readonly receiptDigest?: string;
  readonly runId?: string;
  readonly verifierId?: string;
  readonly verifierVersion?: string;
  readonly scope?: SyntheticReceiptScope;
  readonly caseCount: number;
  readonly reasons: readonly SyntheticTestReasonCode[];
}

export interface SyntheticTestAssessment {
  readonly layer: SynthesizedTestsLayer;
  /** v1 is audit-only by construction; this literal is part of the contract. */
  readonly auditOnly: typeof SYNTHETIC_AUDIT_ONLY;
  /** The layer never feeds task-quality in v1; this literal is part of the contract. */
  readonly taskQualityEligible: typeof SYNTHETIC_TASK_QUALITY_ELIGIBLE;
  readonly content: SyntheticContentAssessment;
  readonly execution: SyntheticExecutionAssessment;
  readonly provenance: {
    readonly freezeOrderOk: boolean;
    readonly generatorIsolated: boolean;
    readonly holdoutFirewallOk: boolean;
    readonly baselineFrozenCaseIds: readonly string[];
    readonly harmfulBaselineFrozenCount: number;
    readonly reasons: readonly SyntheticTestReasonCode[];
  };
}

/**
 * TYPE-LEVEL WITNESS of the required legal state: "the host ran the tests
 * correctly AND the test content is not trusted". If the two trusts were one
 * boolean, this type could not exist.
 */
export type ExecutionTrustedContentUntrusted = SyntheticTestAssessment & {
  readonly content: SyntheticContentAssessment & {
    readonly trust: 'uncalibrated' | 'revoked';
  };
  readonly execution: SyntheticExecutionAssessment & { readonly trust: 'host-verified' };
};

export function isExecutionTrustedContentUntrusted(
  assessment: SyntheticTestAssessment
): assessment is ExecutionTrustedContentUntrusted {
  return (
    assessment.execution.trust === 'host-verified' &&
    (assessment.content.trust === 'uncalibrated' || assessment.content.trust === 'revoked')
  );
}

export interface SyntheticCandidateIdentityLike {
  readonly id: string;
  readonly generatorId: string;
  readonly createdAt: number;
}

export interface SyntheticAssessmentInput {
  readonly suite: FrozenSyntheticTestSuite;
  readonly receipt?: SyntheticTestReceipt;
  readonly calibration?: SyntheticCalibrationReport;
  /** The candidate being evaluated, if the assessment is candidate-scoped. */
  readonly candidate?: SyntheticCandidateIdentityLike;
  /** Artifacts that fed candidate generation (holdout firewall inputs). */
  readonly generationArtifacts?: readonly { readonly path: string; readonly content: string }[];
}

/**
 * Assess one (suite, receipt, calibration) triple.
 *
 * Priority on the content axis: a provenance violation (freeze order, candidate
 * authored the test, same generator, holdout leak, malformed content) REVOKES
 * trust; without a calibration report the content is UNCALIBRATED; only a
 * matching, verdict-calibrated report on top of clean provenance is CALIBRATED.
 */
export function assessSyntheticTestResult(input: SyntheticAssessmentInput): SyntheticTestAssessment {
  const suite = input.suite;
  const contentReasons: SyntheticTestReasonCode[] = [];
  const provenanceReasons: SyntheticTestReasonCode[] = [];

  const suiteCheck = verifyFrozenSyntheticSuite(suite);
  let freezeOrderOk = true;
  let generatorIsolated = true;
  let holdoutFirewallOk = true;

  if (!suiteCheck.ok) {
    for (const violation of suiteCheck.violations) provenanceReasons.push(violation.kind);
    freezeOrderOk = false;
    generatorIsolated = false;
    holdoutFirewallOk = false;
  }
  if (input.candidate !== undefined) {
    const order = assertFrozenBeforeCandidateGeneration(suite, [input.candidate]);
    if (!order.ok) {
      freezeOrderOk = false;
      for (const violation of order.violations) provenanceReasons.push(violation.kind);
    }
    const isolation = checkGeneratorCandidateIsolation(suite, input.candidate);
    if (!isolation.isolated) {
      generatorIsolated = false;
      if (isolation.reason !== undefined) provenanceReasons.push(isolation.reason);
    }
  }
  if (input.generationArtifacts !== undefined) {
    const firewall = checkSyntheticHoldoutFirewall(suite, input.generationArtifacts);
    if (!firewall.ok) {
      holdoutFirewallOk = false;
      for (const violation of firewall.violations) provenanceReasons.push(violation.kind);
    }
  }
  const diagnoses = diagnoseBaselineFrozenCases(suite);

  const executionReasons: SyntheticTestReasonCode[] = [];
  let executionTrust: SyntheticExecutionTrust = 'unverified';
  let executionExtras: {
    receiptDigest?: string;
    runId?: string;
    verifierId?: string;
    verifierVersion?: string;
    scope?: SyntheticReceiptScope;
  } = {};
  if (input.receipt === undefined) {
    executionReasons.push('execution-unverified');
  } else {
    const receiptCheck = verifySyntheticTestReceipt(input.receipt, suite);
    if (receiptCheck.ok) {
      executionTrust = 'host-verified';
      executionExtras = {
        receiptDigest: input.receipt.receiptDigest,
        runId: input.receipt.runId,
        verifierId: input.receipt.verifierId,
        verifierVersion: input.receipt.verifierVersion,
        scope: input.receipt.scope
      };
    } else {
      for (const violation of receiptCheck.violations) executionReasons.push(violation.kind);
    }
  }

  let contentTrust: SyntheticContentTrust;
  let calibrationReportDigest: string | undefined;
  if (provenanceReasons.length > 0) {
    contentTrust = 'revoked';
  } else if (input.calibration === undefined) {
    contentTrust = 'uncalibrated';
    contentReasons.push('calibration-missing');
  } else if (input.calibration.testSetDigest !== suite.testSetDigest) {
    contentTrust = 'uncalibrated';
    contentReasons.push('calibration-set-mismatch');
  } else if (input.calibration.layer !== SYNTHESIZED_TESTS_LAYER) {
    contentTrust = 'uncalibrated';
    contentReasons.push('layer-mismatch');
  } else if (input.calibration.verdict === 'calibrated') {
    contentTrust = 'calibrated';
    calibrationReportDigest = input.calibration.reportDigest;
  } else {
    contentTrust = 'uncalibrated';
    for (const reason of input.calibration.reasons) contentReasons.push(reason);
  }

  const baselineFrozenDiagnoses = diagnoseBaselineFrozenCases(suite);
  return {
    layer: SYNTHESIZED_TESTS_LAYER,
    auditOnly: SYNTHETIC_AUDIT_ONLY,
    taskQualityEligible: SYNTHETIC_TASK_QUALITY_ELIGIBLE,
    content: {
      trust: contentTrust,
      layer: SYNTHESIZED_TESTS_LAYER,
      testSetDigest: suite.testSetDigest,
      ...(calibrationReportDigest === undefined ? {} : { calibrationReportDigest }),
      reasons: contentReasons
    },
    execution: {
      trust: executionTrust,
      caseCount: input.receipt?.caseIds.length ?? 0,
      ...executionExtras,
      reasons: executionReasons
    },
    provenance: {
      freezeOrderOk,
      generatorIsolated,
      holdoutFirewallOk,
      baselineFrozenCaseIds: baselineFrozenDiagnoses.excludedFromCalibrationCaseIds,
      harmfulBaselineFrozenCount: diagnoses.harmfulCount,
      reasons: provenanceReasons
    }
  };
}

// ---------------------------------------------------------------------------
// the task-quality gate: ALWAYS false in v1, with the reason spelled out
// ---------------------------------------------------------------------------

export interface SyntheticTaskQualityGate {
  /** Literally false: the gate has no allow path in v1. */
  readonly allowed: false;
  readonly reason: SyntheticTestReasonCode;
  readonly detail: string;
  /** The layer identity the denial belongs to (audit trail). */
  readonly layer: SynthesizedTestsLayer;
}

/**
 * The gate from this layer to the task-quality track.
 *
 * In v1 the answer is ALWAYS "not allowed". The reason is ordered so an
 * uncalibrated result can never be mistaken for an audit-only policy denial:
 *   1. content revoked     -> content-revoked
 *   2. content uncalibrated-> content-uncalibrated   (execution may be verified!)
 *   3. execution unverified-> execution-unverified
 *   4. everything fine     -> audit-only-v1 (policy, still no entry)
 */
export function gateSyntheticResultForTaskQuality(
  assessment: SyntheticTestAssessment
): SyntheticTaskQualityGate {
  if (assessment.content.trust === 'revoked') {
    return {
      allowed: false,
      reason: 'content-revoked',
      detail: 'synthetic test content trust was revoked (provenance violation)',
      layer: assessment.layer
    };
  }
  if (assessment.content.trust !== 'calibrated') {
    return {
      allowed: false,
      reason: 'content-uncalibrated',
      detail: 'synthetic test content is uncalibrated; execution evidence alone never earns content trust',
      layer: assessment.layer
    };
  }
  if (assessment.execution.trust !== 'host-verified') {
    return {
      allowed: false,
      reason: 'execution-unverified',
      detail: 'no verified host receipt for this execution of the calibrated suite',
      layer: assessment.layer
    };
  }
  return {
    allowed: false,
    reason: 'audit-only-v1',
    detail:
      'synthesized-tests/v1 is audit-only in v1; even calibrated content on a verified execution stays out of task-quality',
    layer: assessment.layer
  };
}

// ---------------------------------------------------------------------------
// the layer object: default OFF, explicit grant ON, rollback to default
// ---------------------------------------------------------------------------

/** The explicit permission grant required to turn the layer on. */
export interface SyntheticTestTrustGrant {
  readonly grantedBy: string;
  readonly reason: string;
  /** v1 supports audit-only ONLY; any other mode is rejected. */
  readonly mode: 'audit-only';
  readonly grantedAt: number;
}

export interface SyntheticTestTrustPolicy {
  readonly enabled: boolean;
  readonly mode: 'audit-only';
}

/**
 * The DEFAULT policy: OFF. Nothing in the production tree constructs this layer,
 * so default behaviour is byte-identical to the tree without this module.
 */
export const DEFAULT_SYNTHETIC_TEST_TRUST_POLICY: SyntheticTestTrustPolicy = Object.freeze({
  enabled: false,
  mode: 'audit-only'
});

export interface SyntheticTestTrustLayerDescription {
  readonly layer: SynthesizedTestsLayer;
  readonly enabled: boolean;
  readonly mode: 'audit-only';
  readonly auditOnly: typeof SYNTHETIC_AUDIT_ONLY;
  readonly taskQualityEligible: typeof SYNTHETIC_TASK_QUALITY_ELIGIBLE;
  /** Present iff enabled. */
  readonly grant?: SyntheticTestTrustGrant;
}

export interface SyntheticTestTrustLayer {
  describe(): SyntheticTestTrustLayerDescription;
  /** Explicit, audited opt-in. Rejects malformed grants and any non-audit mode. */
  enable(grant: SyntheticTestTrustGrant): SyntheticTestTrustLayerDescription;
  /** Rollback: returns the layer to the DEFAULT policy exactly. */
  disable(): SyntheticTestTrustLayerDescription;
  assess(
    input: SyntheticAssessmentInput
  ):
    | { readonly status: 'disabled'; readonly layer: SynthesizedTestsLayer; readonly taskQualityEligible: false }
    | {
        readonly status: 'audited';
        readonly layer: SynthesizedTestsLayer;
        readonly assessment: SyntheticTestAssessment;
        readonly taskQualityGate: SyntheticTaskQualityGate;
      };
}

function validateSyntheticTrustGrant(grant: SyntheticTestTrustGrant): void {
  if (grant === null || typeof grant !== 'object') {
    throw new TypeError('synthesized-tests: enable requires an explicit grant object');
  }
  if (typeof grant.grantedBy !== 'string' || grant.grantedBy.trim().length === 0) {
    throw new TypeError('synthesized-tests: grant.grantedBy must be a non-empty string');
  }
  if (typeof grant.reason !== 'string' || grant.reason.trim().length === 0) {
    throw new TypeError('synthesized-tests: grant.reason must be a non-empty string');
  }
  if (grant.mode !== 'audit-only') {
    throw new TypeError('synthesized-tests: v1 supports audit-only only (got ' + String(grant.mode) + ')');
  }
  if (!Number.isFinite(grant.grantedAt)) {
    throw new TypeError('synthesized-tests: grant.grantedAt must be finite');
  }
}

/**
 * Build the layer. The default is OFF; when OFF, assess() returns a disabled
 * marker WITHOUT touching its input (zero computation, zero side effects).
 */
export function createSyntheticTestTrustLayer(
  initialPolicy: SyntheticTestTrustPolicy = DEFAULT_SYNTHETIC_TEST_TRUST_POLICY
): SyntheticTestTrustLayer {
  let current: { enabled: boolean; mode: 'audit-only'; grant?: SyntheticTestTrustGrant } = {
    enabled: initialPolicy.enabled,
    mode: 'audit-only'
  };

  const describe = (): SyntheticTestTrustLayerDescription => ({
    layer: SYNTHESIZED_TESTS_LAYER,
    enabled: current.enabled,
    mode: 'audit-only',
    auditOnly: SYNTHETIC_AUDIT_ONLY,
    taskQualityEligible: SYNTHETIC_TASK_QUALITY_ELIGIBLE,
    ...(current.grant === undefined ? {} : { grant: current.grant })
  });

  return {
    describe,
    enable(grant: SyntheticTestTrustGrant) {
      validateSyntheticTrustGrant(grant);
      if (current.enabled) {
        throw new TypeError('synthesized-tests: the layer is already enabled');
      }
      current = { enabled: true, mode: 'audit-only', grant: { ...grant } };
      return describe();
    },
    disable() {
      current = { enabled: DEFAULT_SYNTHETIC_TEST_TRUST_POLICY.enabled, mode: 'audit-only' };
      return describe();
    },
    assess(input: SyntheticAssessmentInput) {
      if (!current.enabled) {
        return {
          status: 'disabled' as const,
          layer: SYNTHESIZED_TESTS_LAYER,
          taskQualityEligible: false as const
        };
      }
      const assessment = assessSyntheticTestResult(input);
      return {
        status: 'audited' as const,
        layer: SYNTHESIZED_TESTS_LAYER,
        assessment,
        taskQualityGate: gateSyntheticResultForTaskQuality(assessment)
      };
    }
  };
}
